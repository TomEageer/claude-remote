package main

// 多个访问令牌 + 每个令牌的限速。
//
// 令牌表存在数据目录的 tokens.json：每个令牌有名字、令牌本身、限速（每台电脑每秒字节数，0 = 不限）。
// 第一次启动时把原来的 token 文件里的令牌放进去，名字叫「默认」，不限速，原来的用法不受影响。
// 限速按电脑算：用同一个令牌的几台电脑各自有这么多，互不抢；电脑和它的手机之间来回的内容都算（发图片、传文件、预览文件），
// 超出时只是慢一点，不断开。聊天文字很小，感觉不到。
// 每个令牌这个月转发了多少记在 usage.json（每 30 秒存一次，月初清零），只用来查看。
//
// 管理（改完不用重启，服务会自己读到）：
//
//	crrelay token list                  列出令牌、限速和本月用量
//	crrelay token add 名字 [限速]        新建令牌并打印出来，限速如 128K（每秒），不写就是不限
//	crrelay token rate 名字 限速         改限速（0 = 不限）
//	crrelay token show 名字              打印这个令牌
//	crrelay token rename 旧名字 新名字    改名（本月用量记在旧名字下，改名后从 0 算）
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
)

type tokenEntry struct {
	Name  string `json:"name"`
	Token string `json:"token"`
	Rate  int64  `json:"rate"` // 每台电脑每秒字节数，0 = 不限
}

type usageFile struct {
	Month string           `json:"month"`
	Bytes map[string]int64 `json:"bytes"`
}

type quotas struct {
	mu      sync.Mutex
	dir     string
	tokens  []tokenEntry
	modTime time.Time
	usage   usageFile
	dirty   bool
	buckets map[string]*bucket // 电脑 hostId → 限速桶
}

// 令牌桶：攒满最多 1 秒的量，超出的部分让发送方等着（读下一条前先睡），对方 TCP 自然就慢下来了
type bucket struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

func (b *bucket) wait(ctx context.Context, n int, rate float64) {
	b.mu.Lock()
	now := time.Now()
	if !b.last.IsZero() {
		b.tokens += now.Sub(b.last).Seconds() * rate
	} else {
		b.tokens = rate
	}
	if b.tokens > rate {
		b.tokens = rate
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

func monthNow() string { return time.Now().Format("2006-01") }

func tokensPath(dir string) string { return filepath.Join(dir, "tokens.json") }
func usagePath(dir string) string  { return filepath.Join(dir, "usage.json") }

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

// 启动时：没有令牌表就用原来的 token 文件（或 --token）建一个
func newQuotas(dir, legacy string) *quotas {
	q := &quotas{dir: dir, buckets: map[string]*bucket{}}
	list, mt, err := readTokens(dir)
	if err != nil {
		list = []tokenEntry{{Name: "默认", Token: legacy}}
		_ = os.MkdirAll(dir, 0o700)
		_ = writeJSON(tokensPath(dir), list)
		_, mt, _ = readTokens(dir)
	}
	q.tokens, q.modTime = list, mt
	if b, err := os.ReadFile(usagePath(dir)); err == nil {
		_ = json.Unmarshal(b, &q.usage)
	}
	if q.usage.Bytes == nil || q.usage.Month != monthNow() {
		q.usage = usageFile{Month: monthNow(), Bytes: map[string]int64{}}
	}
	go q.loop()
	return q
}

// 令牌表改过就重新读（命令行改完不用重启服务）
func (q *quotas) reloadLocked() {
	st, err := os.Stat(tokensPath(q.dir))
	if err != nil || st.ModTime().Equal(q.modTime) {
		return
	}
	if list, mt, err := readTokens(q.dir); err == nil {
		q.tokens, q.modTime = list, mt
	}
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
	if q.usage.Month != monthNow() {
		q.usage = usageFile{Month: monthNow(), Bytes: map[string]int64{}}
		q.dirty = true
	}
	var u usageFile
	if q.dirty {
		u = usageFile{Month: q.usage.Month, Bytes: map[string]int64{}}
		for k, v := range q.usage.Bytes {
			u.Bytes[k] = v
		}
		q.dirty = false
	}
	q.mu.Unlock()
	if u.Bytes != nil {
		_ = writeJSON(usagePath(q.dir), u)
	}
}

// 电脑连上来时核对令牌，返回令牌名字；不对返回 ""
func (q *quotas) match(token string) string {
	if token == "" {
		return ""
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.reloadLocked()
	for _, t := range q.tokens {
		if t.Token != "" && subtle.ConstantTimeCompare([]byte(t.Token), []byte(token)) == 1 {
			return t.Name
		}
	}
	return ""
}

// 记流量并按令牌限速：超出时在这里等一会儿（不断开）；令牌被删了返回 false
func (q *quotas) throttle(ctx context.Context, name, hostID string, n int) bool {
	q.mu.Lock()
	if q.usage.Month != monthNow() {
		q.usage = usageFile{Month: monthNow(), Bytes: map[string]int64{}}
	}
	q.usage.Bytes[name] += int64(n)
	q.dirty = true
	var rate int64 = -1
	for _, t := range q.tokens {
		if t.Name == name {
			rate = t.Rate
			break
		}
	}
	var b *bucket
	if rate > 0 {
		if b = q.buckets[hostID]; b == nil {
			b = &bucket{}
			q.buckets[hostID] = b
		}
	}
	q.mu.Unlock()
	if rate < 0 {
		return false
	}
	if b != nil {
		b.wait(ctx, n, float64(rate))
	}
	return true
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

// 128K / 1M / 1.5m / 0 / 不限
func parseBytes(s string) (int64, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if s == "" || s == "0" || s == "不限" || s == "UNLIMITED" {
		return 0, nil
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, "B"), "I")
	mul := float64(1)
	switch {
	case strings.HasSuffix(s, "T"):
		mul, s = 1<<40, strings.TrimSuffix(s, "T")
	case strings.HasSuffix(s, "G"):
		mul, s = 1<<30, strings.TrimSuffix(s, "G")
	case strings.HasSuffix(s, "M"):
		mul, s = 1<<20, strings.TrimSuffix(s, "M")
	case strings.HasSuffix(s, "K"):
		mul, s = 1<<10, strings.TrimSuffix(s, "K")
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("写法不对：%q（例如 128K、1M，0 表示不限）", s)
	}
	return int64(f * mul), nil
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

// crrelay token …
func tokenCLI(dir string, args []string) int {
	die := func(f string, a ...any) int { fmt.Fprintf(os.Stderr, f+"\n", a...); return 1 }
	list, _, err := readTokens(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			return die("%v", err)
		}
		// 服务还没新版启动过：用原来的 token 文件先建一个
		legacy := ""
		if b, e := os.ReadFile(filepath.Join(dir, "token")); e == nil {
			legacy = strings.TrimSpace(string(b))
		}
		if legacy != "" {
			list = []tokenEntry{{Name: "默认", Token: legacy}}
		}
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
		var u usageFile
		if b, err := os.ReadFile(usagePath(dir)); err == nil {
			_ = json.Unmarshal(b, &u)
		}
		if u.Month != monthNow() {
			u = usageFile{Month: monthNow()}
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		fmt.Printf("本月（%s）用量，每 30 秒更新一次；限速按每台电脑算：\n", u.Month)
		for _, t := range list {
			rate := "不限速"
			if t.Rate > 0 {
				rate = "限速 " + fmtBytes(t.Rate) + "/s"
			}
			fmt.Printf("  %s   令牌 %s   本月 %s   %s\n", t.Name, mask(t.Token), fmtBytes(u.Bytes[t.Name]), rate)
		}
		return 0
	case "add":
		if len(args) < 2 {
			return die("用法：crrelay token add 名字 [限速，如 128K（每秒），不写就是不限]")
		}
		name := args[1]
		if find(name) >= 0 {
			return die("已经有叫「%s」的令牌了", name)
		}
		var rate int64
		if len(args) > 2 {
			if rate, err = parseBytes(args[2]); err != nil {
				return die("%v", err)
			}
		}
		t := newToken()
		list = append(list, tokenEntry{Name: name, Token: t, Rate: rate})
		if r := save(); r != 0 {
			return r
		}
		fmt.Println(t)
		return 0
	case "rate":
		if len(args) < 3 {
			return die("用法：crrelay token rate 名字 限速（如 128K，0 = 不限）")
		}
		i := find(args[1])
		if i < 0 {
			return die("没有叫「%s」的令牌", args[1])
		}
		if list[i].Rate, err = parseBytes(args[2]); err != nil {
			return die("%v", err)
		}
		return save()
	case "rename":
		if len(args) < 3 {
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
	return die("不认识的命令：%s（可用 list / add / rate / rename / show / remove）", cmd)
}
