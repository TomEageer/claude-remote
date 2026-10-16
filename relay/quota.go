package main

// 访问令牌（每人一个）+ 流量管控。
//
// 规则：
//   - 聊天、回复这类小消息（单条 32 KB 以下）永远不限，也不扣额度
//   - 传文件、预览文件这类大块数据：先用「每天全速额度」（默认每台电脑每天 20 MB），满速
//   - 额度用完后限速（默认 128 KB/s），但有「小额放行」（默认 2 MB）：放行额度满着时一张照片、一个小文件照样秒传，
//     用掉后按限速慢慢回满
//   - 每个令牌可以「跟随全局默认」「单独设置」或「不限」；看板上还能给某台电脑临时加今天的额度
//   - 额度按电脑算（一般一人一台），每天 0 点（默认北京时间）重置；超出只会变慢，不会断开
//   - 全员每月总量上限（默认 50 GB，两段合计，「不限」的令牌不算）：超了以后所有人的传文件、预览文件都降到很慢（默认 32 KB/s），
//     聊天照常，下个月 1 号恢复。不管人多人少，每月花在别人身上的流量都有个顶
//
// 令牌表 tokens.json、全局默认 settings.json、用量 usage.json 都在数据目录。看板（/admin）和命令行都能改，改完立即生效。
//
//	crrelay token list                  列出令牌、规则和本月用量
//	crrelay token add 名字 [不限]        新建令牌（跟随全局默认，或者不限）并打印出来
//	crrelay token show 名字              打印这个令牌
//	crrelay token rename 旧名字 新名字    改名
//	crrelay token remove 名字            删掉（用它的电脑会被断开）

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // 服务器没装时区数据也能按北京时间算「每天」
)

// 单条大于这个的才算「传文件 / 预览文件」：聊天和回复的消息都比这小得多；手机上传、预览文件每块 192～256 KB
const bulkFrame = 32 << 10

type tokenEntry struct {
	Name     string `json:"name"`
	Token    string `json:"token"`
	Mode     string `json:"mode,omitempty"`  // "" 跟随全局默认；"custom" 用下面自己的数；"unlimited" 不限
	Daily    int64  `json:"daily,omitempty"` // 每天全速额度（字节）
	Rate     int64  `json:"rate,omitempty"`  // 额度用完后的限速（字节/秒）
	Burst    int64  `json:"burst,omitempty"` // 小额放行（字节）
	Disabled bool   `json:"disabled,omitempty"`
	Created  int64  `json:"created,omitempty"`
}

type settings struct {
	Daily    int64  `json:"daily"`    // 每人每天全速额度
	Rate     int64  `json:"rate"`     // 用完后的限速
	Burst    int64  `json:"burst"`    // 小额放行
	MonthCap int64  `json:"monthCap"` // 全员每月总量上限（两段合计，0 = 不设）
	CapRate  int64  `json:"capRate"`  // 超过总量上限后的限速
	TZ       string `json:"tz"`
}

func defaultSettings() settings {
	return settings{Daily: 20 << 20, Rate: 128 << 10, Burst: 2 << 20, MonthCap: 50 << 30, CapRate: 32 << 10, TZ: "Asia/Shanghai"}
}

type policy struct {
	Unlimited          bool
	Daily, Rate, Burst int64
}

type usageFile struct {
	Month string                      `json:"month"`
	Bytes map[string]int64            `json:"bytes"`           // 令牌名 → 本月转发字节
	Days  map[string]map[string]int64 `json:"days,omitempty"`  // 日期 → 令牌名 → 字节（留 60 天）
	Hosts map[string]*hostStat        `json:"hosts,omitempty"` // 电脑 → 本月用量
	Fast  map[string]map[string]int64 `json:"fast,omitempty"`  // 日期 → 电脑 → 今天已用的全速额度
	Bonus map[string]map[string]int64 `json:"bonus,omitempty"` // 日期 → 电脑 → 今天临时加的额度
	Web   map[string]int64            `json:"web,omitempty"`   // 日期 → 手机网页本身（页面文件）的流量
}

type hostStat struct {
	Name  string `json:"name,omitempty"`
	Tok   string `json:"tok"`
	Bytes int64  `json:"bytes"`
	Seen  int64  `json:"seen"` // 最后在线（毫秒）
}

type quotas struct {
	mu      sync.Mutex
	dir     string
	tokens  []tokenEntry
	modTime time.Time
	set     settings
	loc     *time.Location
	usage   usageFile
	dirty   bool
	buckets map[string]*bucket // 电脑 → 限速桶
}

// 令牌桶：容量 = 小额放行，按限速回满；不够时让发送方等着（读下一条前先睡），对方 TCP 自然就慢下来了
type bucket struct {
	mu      sync.Mutex
	tokens  float64
	last    time.Time
	limited time.Time // 最近一次因为限速要等到什么时候（看板显示「限速中」）
}

func (b *bucket) wait(ctx context.Context, n int64, rate, burst float64) {
	if burst < rate {
		burst = rate
	}
	b.mu.Lock()
	now := time.Now()
	if b.last.IsZero() {
		b.tokens = burst
	} else {
		b.tokens += now.Sub(b.last).Seconds() * rate
	}
	if b.tokens > burst {
		b.tokens = burst
	}
	b.last = now
	b.tokens -= float64(n)
	var d time.Duration
	if b.tokens < 0 {
		d = time.Duration(-b.tokens / rate * float64(time.Second))
	}
	// 一次最多等 10 秒：等太久连接的保活检测会以为断线了
	if d > 10*time.Second {
		d = 10 * time.Second
	}
	if d > 0 {
		b.limited = now.Add(d)
	}
	b.mu.Unlock()
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (q *quotas) now() time.Time { return time.Now().In(q.loc) }
func (q *quotas) today() string  { return q.now().Format("2006-01-02") }
func (q *quotas) month() string  { return q.now().Format("2006-01") }

func tokensPath(dir string) string   { return filepath.Join(dir, "tokens.json") }
func usagePath(dir string) string    { return filepath.Join(dir, "usage.json") }
func settingsPath(dir string) string { return filepath.Join(dir, "settings.json") }

func readTokens(dir string) ([]tokenEntry, time.Time, error) {
	p := tokensPath(dir)
	st, err := os.Stat(p)
	if err != nil {
		return nil, time.Time{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, time.Time{}, err
	}
	var list []tokenEntry
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, time.Time{}, fmt.Errorf("tokens.json 格式不对：%v", err)
	}
	return list, st.ModTime(), nil
}

func writeJSON(p string, v any) error {
	b, _ := json.MarshalIndent(v, "", "  ")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func loadSettings(dir string) (settings, bool) {
	s := defaultSettings()
	b, err := os.ReadFile(settingsPath(dir))
	if err != nil {
		return s, false
	}
	_ = json.Unmarshal(b, &s)
	if s.TZ == "" {
		s.TZ = "Asia/Shanghai"
	}
	return s, true
}

func locOf(tz string) *time.Location {
	if l, err := time.LoadLocation(tz); err == nil {
		return l
	}
	return time.FixedZone("UTC+8", 8*3600)
}

// 启动时：没有令牌表就用原来的 token 文件（或 --token）建一个；第一次有全局设置时把旧令牌换成新规则
func newQuotas(dir, legacy string) *quotas {
	q := &quotas{dir: dir, buckets: map[string]*bucket{}}
	_ = os.MkdirAll(dir, 0o700)
	list, mt, err := readTokens(dir)
	if err != nil {
		list = []tokenEntry{{Name: "默认", Token: legacy, Mode: "unlimited"}}
		_ = writeJSON(tokensPath(dir), list)
		_, mt, _ = readTokens(dir)
	}
	set, ok := loadSettings(dir)
	if !ok {
		// 老版本只有「限速」：设了限速的跟随新的全局默认，没设的（原来就不限）保持不限
		for i := range list {
			if list[i].Mode == "" && list[i].Rate == 0 {
				list[i].Mode = "unlimited"
			}
			if list[i].Mode == "" {
				list[i].Rate = 0
			}
		}
		_ = writeJSON(tokensPath(dir), list)
		_, mt, _ = readTokens(dir)
		_ = writeJSON(settingsPath(dir), set)
	}
	q.tokens, q.modTime, q.set, q.loc = list, mt, set, locOf(set.TZ)
	if b, err := os.ReadFile(usagePath(dir)); err == nil {
		_ = json.Unmarshal(b, &q.usage)
	}
	q.ensureMaps()
	q.rollLocked()
	go q.loop()
	return q
}

func (q *quotas) ensureMaps() {
	if q.usage.Bytes == nil {
		q.usage.Bytes = map[string]int64{}
	}
	if q.usage.Days == nil {
		q.usage.Days = map[string]map[string]int64{}
	}
	if q.usage.Hosts == nil {
		q.usage.Hosts = map[string]*hostStat{}
	}
	if q.usage.Fast == nil {
		q.usage.Fast = map[string]map[string]int64{}
	}
	if q.usage.Bonus == nil {
		q.usage.Bonus = map[string]map[string]int64{}
	}
	if q.usage.Web == nil {
		q.usage.Web = map[string]int64{}
	}
}

// 手机网页本身的流量（看板单独显示）
func (q *quotas) addWeb(n int) {
	if n <= 0 {
		return
	}
	q.mu.Lock()
	q.usage.Web[q.today()] += int64(n)
	q.dirty = true
	q.mu.Unlock()
}

// 「不限」以外的令牌本月一共用了多少（两段合计），和全员上限比
func (q *quotas) poolLocked() int64 {
	var sum int64
	for _, t := range q.tokens {
		if t.Mode != "unlimited" {
			sum += q.usage.Bytes[t.Name] * 2
		}
	}
	return sum
}

func (q *quotas) overCapLocked() bool {
	return q.set.MonthCap > 0 && q.poolLocked() >= q.set.MonthCap
}

// 换月：本月数字清零，按天的历史留着
func (q *quotas) rollLocked() {
	if q.usage.Month == q.month() {
		return
	}
	q.usage.Month = q.month()
	q.usage.Bytes = map[string]int64{}
	for _, h := range q.usage.Hosts {
		h.Bytes = 0
	}
	q.dirty = true
}

// 令牌表 / 全局设置被命令行改过就重新读
func (q *quotas) reloadLocked() {
	if st, err := os.Stat(tokensPath(q.dir)); err == nil && !st.ModTime().Equal(q.modTime) {
		if list, mt, err := readTokens(q.dir); err == nil {
			q.tokens, q.modTime = list, mt
		}
	}
}

func (q *quotas) saveTokensLocked() error {
	if err := writeJSON(tokensPath(q.dir), q.tokens); err != nil {
		return err
	}
	if st, err := os.Stat(tokensPath(q.dir)); err == nil {
		q.modTime = st.ModTime()
	}
	return nil
}

func (q *quotas) loop() {
	t := time.NewTicker(30 * time.Second)
	for range t.C {
		q.flush()
	}
}

func (q *quotas) flush() {
	q.mu.Lock()
	q.reloadLocked()
	q.rollLocked()
	var b []byte
	if q.dirty {
		// 按天的记录留 60 天，额度记录留 3 天
		cut := q.now().AddDate(0, 0, -60).Format("2006-01-02")
		cut3 := q.now().AddDate(0, 0, -3).Format("2006-01-02")
		for d := range q.usage.Days {
			if d < cut {
				delete(q.usage.Days, d)
			}
		}
		for d := range q.usage.Web {
			if d < cut {
				delete(q.usage.Web, d)
			}
		}
		for _, m := range []map[string]map[string]int64{q.usage.Fast, q.usage.Bonus} {
			for d := range m {
				if d < cut3 {
					delete(m, d)
				}
			}
		}
		b, _ = json.MarshalIndent(q.usage, "", "  ")
		q.dirty = false
	}
	q.mu.Unlock()
	if b != nil {
		tmp := usagePath(q.dir) + ".tmp"
		if os.WriteFile(tmp, append(b, '\n'), 0o600) == nil {
			_ = os.Rename(tmp, usagePath(q.dir))
		}
	}
}

func (q *quotas) findLocked(name string) int {
	for i, t := range q.tokens {
		if t.Name == name {
			return i
		}
	}
	return -1
}

func (q *quotas) policyLocked(t tokenEntry) policy {
	switch t.Mode {
	case "unlimited":
		return policy{Unlimited: true}
	case "custom":
		return policy{Daily: t.Daily, Rate: t.Rate, Burst: t.Burst}
	}
	return policy{Daily: q.set.Daily, Rate: q.set.Rate, Burst: q.set.Burst}
}

// 电脑连上来时核对令牌，返回令牌名字；不对或已停用返回 ""
func (q *quotas) match(token string) string {
	if token == "" {
		return ""
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.reloadLocked()
	for _, t := range q.tokens {
		if t.Token != "" && !t.Disabled && subtle.ConstantTimeCompare([]byte(t.Token), []byte(token)) == 1 {
			return t.Name
		}
	}
	return ""
}

// 电脑连上来：记下名字和令牌
func (q *quotas) hostSeen(hostID, tok, name string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.rollLocked()
	h := q.usage.Hosts[hostID]
	if h == nil {
		h = &hostStat{}
		q.usage.Hosts[hostID] = h
	}
	h.Tok = tok
	if name != "" {
		h.Name = name
	}
	h.Seen = time.Now().UnixMilli()
	q.dirty = true
}

func addDay(m map[string]map[string]int64, d, k string, n int64) {
	if m[d] == nil {
		m[d] = map[string]int64{}
	}
	m[d][k] += n
}

// 记流量并按规则管控：超出时在这里等一会儿（不断开）；令牌被删了或停用了返回 false
func (q *quotas) throttle(ctx context.Context, name, hostID string, size int) bool {
	n := int64(size)
	q.mu.Lock()
	q.rollLocked()
	d := q.today()
	q.usage.Bytes[name] += n
	addDay(q.usage.Days, d, name, n)
	if h := q.usage.Hosts[hostID]; h != nil {
		h.Bytes += n
		h.Seen = time.Now().UnixMilli()
	}
	q.dirty = true
	i := q.findLocked(name)
	if i < 0 || q.tokens[i].Disabled {
		q.mu.Unlock()
		return false
	}
	p := q.policyLocked(q.tokens[i])
	if p.Unlimited || n < bulkFrame {
		q.mu.Unlock()
		return true
	}
	// 全员总量超了：没有全速额度，统一按很慢的速度
	if q.overCapLocked() && q.set.CapRate > 0 {
		p = policy{Rate: q.set.CapRate, Burst: q.set.CapRate * 2}
	}
	if p.Rate <= 0 {
		q.mu.Unlock()
		return true
	}
	// 先用今天的全速额度，不够的部分走限速
	allow := p.Daily
	if p.Daily > 0 || q.usage.Bonus[d][hostID] > 0 {
		allow += q.usage.Bonus[d][hostID]
	}
	used := q.usage.Fast[d][hostID]
	fast := allow - used
	if fast > n {
		fast = n
	}
	if fast < 0 {
		fast = 0
	}
	if fast > 0 {
		addDay(q.usage.Fast, d, hostID, fast)
	}
	slow := n - fast
	var b *bucket
	if slow > 0 {
		if b = q.buckets[hostID]; b == nil {
			b = &bucket{}
			q.buckets[hostID] = b
		}
	}
	q.mu.Unlock()
	if b != nil {
		b.wait(ctx, slow, float64(p.Rate), float64(p.Burst))
	}
	return true
}

// 这台电脑最近 3 秒内有没有被限速拖慢
func (q *quotas) limitedNow(hostID string) bool {
	q.mu.Lock()
	b := q.buckets[hostID]
	q.mu.Unlock()
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Since(b.limited) < 3*time.Second
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return strconv.FormatFloat(float64(n)/(1<<30), 'f', 1, 64) + " GB"
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KB"
	}
	return fmt.Sprintf("%d B", n)
}

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mask(t string) string {
	if len(t) <= 8 {
		return "****"
	}
	return t[:4] + "…" + t[len(t)-4:]
}

func validName(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && len([]rune(s)) <= 30 && !strings.ContainsAny(s, "\n\r\t")
}

// crrelay token …（命令行版，常用的在看板上做更方便）
func tokenCLI(dir string, args []string) int {
	die := func(f string, a ...any) int { fmt.Fprintf(os.Stderr, f+"\n", a...); return 1 }
	list, _, err := readTokens(dir)
	if err != nil && !os.IsNotExist(err) {
		return die("%v", err)
	}
	find := func(name string) int {
		for i, t := range list {
			if t.Name == name {
				return i
			}
		}
		return -1
	}
	save := func() int {
		_ = os.MkdirAll(dir, 0o700)
		if err := writeJSON(tokensPath(dir), list); err != nil {
			return die("保存失败：%v", err)
		}
		return 0
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "", "list":
		set, _ := loadSettings(dir)
		var u usageFile
		if b, err := os.ReadFile(usagePath(dir)); err == nil {
			_ = json.Unmarshal(b, &u)
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		fmt.Printf("全局默认：每天全速 %s，之后限速 %s/s，小额放行 %s。本月流量（%s，两段合计）：\n", fmtBytes(set.Daily), fmtBytes(set.Rate), fmtBytes(set.Burst), u.Month)
		for _, t := range list {
			rule := "跟随默认"
			switch t.Mode {
			case "unlimited":
				rule = "不限"
			case "custom":
				rule = fmt.Sprintf("每天 %s，之后 %s/s，放行 %s", fmtBytes(t.Daily), fmtBytes(t.Rate), fmtBytes(t.Burst))
			}
			if t.Disabled {
				rule += "（已停用）"
			}
			fmt.Printf("  %s   令牌 %s   本月 %s   %s\n", t.Name, mask(t.Token), fmtBytes(u.Bytes[t.Name]*2), rule)
		}
		fmt.Println("改规则、加额度、发新令牌：在浏览器打开管理看板（crrelay admin 看地址）")
		return 0
	case "add":
		if len(args) < 2 || !validName(args[1]) {
			return die("用法：crrelay token add 名字 [不限]")
		}
		if find(args[1]) >= 0 {
			return die("已经有叫「%s」的令牌了", args[1])
		}
		e := tokenEntry{Name: args[1], Token: newToken(), Created: time.Now().UnixMilli()}
		if len(args) > 2 && (args[2] == "不限" || args[2] == "unlimited") {
			e.Mode = "unlimited"
		}
		list = append(list, e)
		if r := save(); r != 0 {
			return r
		}
		fmt.Println(e.Token)
		return 0
	case "rename":
		if len(args) < 3 || !validName(args[2]) {
			return die("用法：crrelay token rename 旧名字 新名字")
		}
		i := find(args[1])
		if i < 0 {
			return die("没有叫「%s」的令牌", args[1])
		}
		if find(args[2]) >= 0 {
			return die("已经有叫「%s」的令牌了", args[2])
		}
		list[i].Name = args[2]
		return save()
	case "show":
		if len(args) < 2 {
			return die("用法：crrelay token show 名字")
		}
		i := find(args[1])
		if i < 0 {
			return die("没有叫「%s」的令牌", args[1])
		}
		fmt.Println(list[i].Token)
		return 0
	case "remove", "rm", "delete":
		if len(args) < 2 {
			return die("用法：crrelay token remove 名字")
		}
		i := find(args[1])
		if i < 0 {
			return die("没有叫「%s」的令牌", args[1])
		}
		list = append(list[:i], list[i+1:]...)
		return save()
	}
	return die("不认识的命令：%s（可用 list / add / rename / show / remove）", cmd)
}
