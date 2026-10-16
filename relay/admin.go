package main

// 管理看板：https://中转地址/admin
//
// 只统计远程控制这条链路的流量（手机↔服务器、服务器↔电脑两段合计）：本月、每天、每个令牌、每台电脑用了多少，此刻多快，
// 是不是正在被限速。用单独的管理密钥打开（和发给别人的访问令牌无关）：在服务器上运行 crrelay admin 拿到带密钥的链接。
// 看板只读，看不到任何对话内容（中转本来就看不到）。

import (
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
	key := adminKey(dir, false)
	s := &sampler{hostPrev: map[string]int64{}, hostRate: map[string]float64{}}
	go func() {
		for {
			h.sample(s)
			time.Sleep(2 * time.Second)
		}
	}()
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
		// 管理密钥最新的以文件为准（crrelay admin reset 之后不用重启）
		if b, err := os.ReadFile(adminKeyPath(dir)); err == nil {
			key = strings.TrimSpace(string(b))
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if key == "" || subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
			time.Sleep(800 * time.Millisecond) // 猜密钥的慢一点
			http.Error(w, "管理密钥不对", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(h.stats(s))
	})
}

type dayRow struct {
	Date   string           `json:"date"`
	Tokens map[string]int64 `json:"tokens"` // 令牌名 → 那天转发的字节（只算一遍，看板上乘 2 显示两段合计）
}

type tokenRow struct {
	Name   string `json:"name"`
	Rate   int64  `json:"rate"`
	Month  int64  `json:"month"`
	Online int    `json:"online"`
	Hosts  int    `json:"hosts"`
}

type hostRow struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Tok     string  `json:"tok"`
	Online  bool    `json:"online"`
	Phones  int     `json:"phones"`
	Month   int64   `json:"month"`
	Speed   float64 `json:"speed"`
	Limited bool    `json:"limited"`
	Seen    int64   `json:"seen"`
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
	month := q.usage.Month
	var relayMonth int64
	for _, v := range q.usage.Bytes {
		relayMonth += v
	}
	// 最近 30 天
	days := []dayRow{}
	for i := 29; i >= 0; i-- {
		d := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		m := map[string]int64{}
		for k, v := range q.usage.Days[d] {
			m[k] = v
		}
		days = append(days, dayRow{Date: d, Tokens: m})
	}
	toks := []tokenRow{}
	idx := map[string]int{}
	for _, t := range q.tokens {
		idx[t.Name] = len(toks)
		toks = append(toks, tokenRow{Name: t.Name, Rate: t.Rate, Month: q.usage.Bytes[t.Name]})
	}
	hosts := []hostRow{}
	for id, x := range q.usage.Hosts {
		hosts = append(hosts, hostRow{ID: id, Name: x.Name, Tok: x.Tok, Online: online[id], Phones: phones[id], Month: x.Bytes, Seen: x.Seen})
		if i, ok := idx[x.Tok]; ok {
			toks[i].Hosts++
			if online[id] {
				toks[i].Online++
			}
		}
	}
	q.mu.Unlock()

	s.mu.Lock()
	for i := range hosts {
		hosts[i].Speed = s.hostRate[hosts[i].ID]
	}
	relay := map[string]any{"month": relayMonth, "rate": s.relayRate}
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
	return map[string]any{"version": version, "now": time.Now().UnixMilli(), "month": month, "relay": relay, "days": days, "tokens": toks, "hosts": hosts}
}
