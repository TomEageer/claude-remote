package main

// 管理看板：https://中转地址/admin
//
// 只统计远程控制这条链路的流量（手机↔服务器、服务器↔电脑两段合计），外加手机网页本身的流量。
// 能看：本月 / 今天 / 每天的流量、每个人（令牌）和每台电脑用了多少、今天的全速额度还剩多少、此刻多快、谁在被限速。
// 能改：全局默认规则、全员每月上限、新建 / 编辑 / 停用 / 删除令牌、给某台电脑临时加今天的额度。
// 用单独的管理密钥打开（和发给别人的访问令牌无关）：在服务器上运行 crrelay admin 拿到带密钥的链接。看不到任何对话内容。

import (
	"context"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed admin.html
var adminHTML []byte

func adminKeyPath(dir string) string { return filepath.Join(dir, "admin") }

func adminKey(dir string, reset bool) string {
	if !reset {
		if b, err := os.ReadFile(adminKeyPath(dir)); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
			return strings.TrimSpace(string(b))
		}
	}
	k := newToken()
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(adminKeyPath(dir), []byte(k+"\n"), 0o600)
	return k
}

// crrelay admin [reset]
func adminCLI(dir string, args []string) int {
	reset := len(args) > 0 && args[0] == "reset"
	k := adminKey(dir, reset)
	if reset {
		fmt.Println("管理密钥已换新，旧链接失效。")
	}
	fmt.Println("在浏览器打开（把前面换成你的中转地址）：")
	fmt.Printf("  https://你的中转地址/admin#k=%s\n", k)
	fmt.Println("密钥只在 # 后面，不会出现在服务器访问日志里；打开一次后浏览器会记住，地址栏里的密钥会自动去掉。")
	return 0
}

// 每 2 秒采样一次：中转总速度、每台电脑的速度
type sampler struct {
	mu        sync.Mutex
	hostPrev  map[string]int64
	hostRate  map[string]float64
	relayPrev int64
	relayRate float64
	last      time.Time
}

func (h *hub) sample(s *sampler) {
	now := time.Now()
	h.q.mu.Lock()
	hosts := map[string]int64{}
	var relay int64
	for id, x := range h.q.usage.Hosts {
		hosts[id] = x.Bytes
	}
	for _, v := range h.q.usage.Bytes {
		relay += v
	}
	h.q.mu.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	dt := now.Sub(s.last).Seconds()
	if !s.last.IsZero() && dt > 0 {
		for id, b := range hosts {
			if p, ok := s.hostPrev[id]; ok && b >= p {
				s.hostRate[id] = float64(b-p) / dt
			}
		}
		if relay >= s.relayPrev {
			s.relayRate = float64(relay-s.relayPrev) / dt
		}
	}
	s.hostPrev, s.relayPrev, s.last = hosts, relay, now
}

func (h *hub) adminRoutes(mux *http.ServeMux, dir string) {
	adminKey(dir, false)
	s := &sampler{hostPrev: map[string]int64{}, hostRate: map[string]float64{}}
	go func() {
		for {
			h.sample(s)
			time.Sleep(2 * time.Second)
		}
	}()
	// 管理密钥以文件为准（crrelay admin reset 之后不用重启）
	authed := func(w http.ResponseWriter, r *http.Request) bool {
		key := ""
		if b, err := os.ReadFile(adminKeyPath(dir)); err == nil {
			key = strings.TrimSpace(string(b))
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if key == "" || subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
			time.Sleep(800 * time.Millisecond) // 猜密钥的慢一点
			http.Error(w, "管理密钥不对", http.StatusUnauthorized)
			return false
		}
		return true
	}
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Type", "text/html; charset=utf-8")
		hd.Set("Cache-Control", "no-store")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:")
		_, _ = w.Write(adminHTML)
	})
	mux.HandleFunc("/admin/api", func(w http.ResponseWriter, r *http.Request) {
		if !authed(w, r) {
			return
		}
		reply(w, h.stats(s))
	})
	// 改东西：POST JSON {op, ...}
	mux.HandleFunc("/admin/api/do", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "只接受 POST", http.StatusMethodNotAllowed)
			return
		}
		if !authed(w, r) {
			return
		}
		var req adminReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			reply(w, map[string]any{"ok": false, "message": "请求格式不对"})
			return
		}
		out, err := h.q.adminDo(req)
		if err != nil {
			reply(w, map[string]any{"ok": false, "message": err.Error()})
			return
		}
		if req.Op == "update" || req.Op == "remove" {
			h.kickStale("")
		}
		if req.Op == "regen" {
			h.kickStale(req.Name) // 换了新令牌：用旧令牌连着的电脑断开，要用新的重连
		}
		out["ok"] = true
		reply(w, out)
	})
}

type adminReq struct {
	Op       string `json:"op"`
	Name     string `json:"name"`
	NewName  string `json:"newName"`
	Mode     string `json:"mode"`
	Daily    int64  `json:"daily"`
	Rate     int64  `json:"rate"`
	Burst    int64  `json:"burst"`
	Disabled bool   `json:"disabled"`
	Host     string `json:"host"`
	Note     string `json:"note"`
	Bytes    int64  `json:"bytes"`
	MonthCap int64  `json:"monthCap"`
	CapRate  int64  `json:"capRate"`
}

func clampPolicy(daily, rate, burst int64) (int64, int64, int64, error) {
	if daily < 0 || rate < 0 || burst < 0 {
		return 0, 0, 0, fmt.Errorf("数字不能是负的")
	}
	if rate > 0 && rate < 8<<10 {
		return 0, 0, 0, fmt.Errorf("限速太低（至少 8 KB/s），手机会以为断线")
	}
	return daily, rate, burst, nil
}

func (q *quotas) adminDo(req adminReq) (map[string]any, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.reloadLocked()
	req.Name = strings.TrimSpace(req.Name)
	switch req.Op {
	case "settings":
		d, r, b, err := clampPolicy(req.Daily, req.Rate, req.Burst)
		if err != nil {
			return nil, err
		}
		if req.MonthCap < 0 || req.CapRate < 0 || (req.CapRate > 0 && req.CapRate < 8<<10) {
			return nil, fmt.Errorf("全员上限的数字不对（限速至少 8 KB/s）")
		}
		q.set.Daily, q.set.Rate, q.set.Burst, q.set.MonthCap, q.set.CapRate = d, r, b, req.MonthCap, req.CapRate
		return map[string]any{}, writeJSON(settingsPath(q.dir), q.set)
	case "add":
		if !validName(req.Name) {
			return nil, fmt.Errorf("名字不能为空，最多 30 个字")
		}
		if q.findLocked(req.Name) >= 0 {
			return nil, fmt.Errorf("已经有叫「%s」的令牌了", req.Name)
		}
		e := tokenEntry{Name: req.Name, Token: newToken(), Created: time.Now().UnixMilli()}
		if err := setMode(&e, req); err != nil {
			return nil, err
		}
		q.tokens = append(q.tokens, e)
		return map[string]any{"token": e.Token}, q.saveTokensLocked()
	case "update":
		i := q.findLocked(req.Name)
		if i < 0 {
			return nil, fmt.Errorf("没有叫「%s」的令牌", req.Name)
		}
		e := q.tokens[i]
		if nn := strings.TrimSpace(req.NewName); nn != "" && nn != e.Name {
			if !validName(nn) {
				return nil, fmt.Errorf("名字不能为空，最多 30 个字")
			}
			if q.findLocked(nn) >= 0 {
				return nil, fmt.Errorf("已经有叫「%s」的令牌了", nn)
			}
			// 改名：本月用量、电脑归属跟着走
			q.usage.Bytes[nn] += q.usage.Bytes[e.Name]
			delete(q.usage.Bytes, e.Name)
			for _, m := range q.usage.Days {
				if v, ok := m[e.Name]; ok {
					m[nn] += v
					delete(m, e.Name)
				}
			}
			for _, hs := range q.usage.Hosts {
				if hs.Tok == e.Name {
					hs.Tok = nn
				}
			}
			q.dirty = true
			e.Name = nn
		}
		if err := setMode(&e, req); err != nil {
			return nil, err
		}
		e.Disabled = req.Disabled
		q.tokens[i] = e
		return map[string]any{}, q.saveTokensLocked()
	case "reveal":
		i := q.findLocked(req.Name)
		if i < 0 {
			return nil, fmt.Errorf("没有叫「%s」的令牌", req.Name)
		}
		return map[string]any{"token": q.tokens[i].Token}, nil
	case "regen":
		i := q.findLocked(req.Name)
		if i < 0 {
			return nil, fmt.Errorf("没有叫「%s」的令牌", req.Name)
		}
		q.tokens[i].Token = newToken()
		return map[string]any{"token": q.tokens[i].Token}, q.saveTokensLocked()
	case "remove":
		i := q.findLocked(req.Name)
		if i < 0 {
			return nil, fmt.Errorf("没有叫「%s」的令牌", req.Name)
		}
		q.tokens = append(q.tokens[:i], q.tokens[i+1:]...)
		return map[string]any{}, q.saveTokensLocked()
	case "bonus":
		if q.usage.Hosts[req.Host] == nil {
			return nil, fmt.Errorf("没有这台电脑")
		}
		if req.Bytes == 0 || req.Bytes > 100<<30 || req.Bytes < -(100<<30) {
			return nil, fmt.Errorf("加的量不对")
		}
		d := q.today()
		addDay(q.usage.Bonus, d, req.Host, req.Bytes)
		if q.usage.Bonus[d][req.Host] < 0 {
			q.usage.Bonus[d][req.Host] = 0
		}
		q.dirty = true
		return map[string]any{}, nil
	case "hostNote":
		// 给电脑起个备注：只在管理页显示，留空就恢复显示对方自己填的名字
		hs, ok := q.usage.Hosts[req.Host]
		if !ok {
			return nil, fmt.Errorf("这台电脑已经不在列表里了")
		}
		note := strings.TrimSpace(req.Note)
		if len([]rune(note)) > 30 {
			return nil, fmt.Errorf("备注最多 30 个字")
		}
		hs.Note = note
		q.dirty = true
		return map[string]any{}, nil
	case "forget":
		// 从列表里去掉一台很久没来的电脑（它再连上来会重新出现）
		delete(q.usage.Hosts, req.Host)
		q.dirty = true
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("不认识的操作")
}

func setMode(e *tokenEntry, req adminReq) error {
	switch req.Mode {
	case "", "default":
		e.Mode, e.Daily, e.Rate, e.Burst = "", 0, 0, 0
	case "unlimited":
		e.Mode, e.Daily, e.Rate, e.Burst = "unlimited", 0, 0, 0
	case "custom":
		d, r, b, err := clampPolicy(req.Daily, req.Rate, req.Burst)
		if err != nil {
			return err
		}
		if r == 0 {
			return fmt.Errorf("单独设置时要填限速；不想限就选「不限」")
		}
		e.Mode, e.Daily, e.Rate, e.Burst = "custom", d, r, b
	default:
		return fmt.Errorf("规则不对")
	}
	return nil
}

// 令牌被删 / 停用 / 改名以后：用它连着的电脑马上断开；name 不为空时，用这个令牌的电脑都断开（换了新令牌）
func (h *hub) kickStale(name string) {
	h.mu.Lock()
	var stale []*conn
	for _, c := range h.hosts {
		stale = append(stale, c)
	}
	h.mu.Unlock()
	h.q.mu.Lock()
	valid := map[string]bool{}
	for _, t := range h.q.tokens {
		if !t.Disabled {
			valid[t.Name] = true
		}
	}
	h.q.mu.Unlock()
	for _, c := range stale {
		if !valid[c.tok] || (name != "" && c.tok == name) {
			_ = c.send(context.Background(), map[string]any{"t": "error", "code": "token", "message": "访问令牌已经被停用或删除"})
			c.ws.Close(websocket.StatusPolicyViolation, "token revoked")
		}
	}
}

type dayRow struct {
	Date   string           `json:"date"`
	Tokens map[string]int64 `json:"tokens"` // 令牌名 → 那天转发的字节（只算一遍，看板上乘 2 显示两段合计）
	Web    int64            `json:"web"`    // 手机网页本身
}

type tokenRow struct {
	tokenEntry
	Token  string `json:"token,omitempty"` // 不随列表下发，要看点「显示令牌」
	Masked string `json:"masked"`
	Month  int64  `json:"month"`
	Today  int64  `json:"today"`
	Online int    `json:"online"`
	Hosts  int    `json:"hosts"`
}

type hostRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Note      string  `json:"note"`
	Tok       string  `json:"tok"`
	Online    bool    `json:"online"`
	Phones    int     `json:"phones"`
	Month     int64   `json:"month"`
	Speed     float64 `json:"speed"`
	Limited   bool    `json:"limited"`
	Seen      int64   `json:"seen"`
	FastUsed  int64   `json:"fastUsed"`  // 今天已用的全速额度
	FastAllow int64   `json:"fastAllow"` // 今天的全速额度（含临时加的），-1 = 不限
	Bonus     int64   `json:"bonus"`
}

func (h *hub) stats(s *sampler) map[string]any {
	h.mu.Lock()
	online := map[string]bool{}
	phones := map[string]int{}
	for id := range h.hosts {
		online[id] = true
	}
	for id, cs := range h.clients {
		phones[id] = len(cs)
	}
	h.mu.Unlock()

	q := h.q
	q.mu.Lock()
	q.reloadLocked()
	q.rollLocked()
	month := q.usage.Month
	today := q.today()
	var relayMonth, webMonth int64
	for _, v := range q.usage.Bytes {
		relayMonth += v
	}
	for d, v := range q.usage.Web {
		if strings.HasPrefix(d, month) {
			webMonth += v
		}
	}
	days := []dayRow{}
	for i := 29; i >= 0; i-- {
		d := q.now().AddDate(0, 0, -i).Format("2006-01-02")
		m := map[string]int64{}
		for k, v := range q.usage.Days[d] {
			m[k] = v
		}
		days = append(days, dayRow{Date: d, Tokens: m, Web: q.usage.Web[d]})
	}
	toks := []tokenRow{}
	idx := map[string]int{}
	pol := map[string]policy{}
	for _, t := range q.tokens {
		idx[t.Name] = len(toks)
		pol[t.Name] = q.policyLocked(t)
		row := tokenRow{tokenEntry: t, Masked: mask(t.Token), Month: q.usage.Bytes[t.Name], Today: q.usage.Days[today][t.Name]}
		row.tokenEntry.Token = ""
		toks = append(toks, row)
	}
	overCap := q.overCapLocked()
	hosts := []hostRow{}
	for id, x := range q.usage.Hosts {
		r := hostRow{ID: id, Name: x.Name, Note: x.Note, Tok: x.Tok, Online: online[id], Phones: phones[id], Month: x.Bytes, Seen: x.Seen,
			FastUsed: q.usage.Fast[today][id], Bonus: q.usage.Bonus[today][id]}
		if p, ok := pol[x.Tok]; ok && !p.Unlimited {
			r.FastAllow = p.Daily + r.Bonus
			if overCap {
				r.FastAllow = 0
			}
		} else {
			r.FastAllow = -1
		}
		hosts = append(hosts, r)
		if i, ok := idx[x.Tok]; ok {
			toks[i].Hosts++
			if online[id] {
				toks[i].Online++
			}
		}
	}
	set := q.set
	pool := q.poolLocked()
	q.mu.Unlock()

	s.mu.Lock()
	for i := range hosts {
		hosts[i].Speed = s.hostRate[hosts[i].ID]
	}
	relayRate := s.relayRate
	s.mu.Unlock()
	for i := range hosts {
		hosts[i].Limited = hosts[i].Online && q.limitedNow(hosts[i].ID)
	}
	sort.Slice(hosts, func(i, j int) bool {
		if hosts[i].Online != hosts[j].Online {
			return hosts[i].Online
		}
		return hosts[i].Month > hosts[j].Month
	})
	return map[string]any{
		"version": version, "now": time.Now().UnixMilli(), "month": month, "today": today,
		"relay":    map[string]any{"month": relayMonth, "rate": relayRate, "web": webMonth},
		"settings": set, "pool": pool, "overCap": overCap,
		"days": days, "tokens": toks, "hosts": hosts,
	}
}
