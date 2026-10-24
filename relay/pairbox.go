package main

// 手表配对用的「寄存柜」：手表没有摄像头扫不了二维码，只能输入 6 位数字码。
// 电脑把配对包（电脑编号、公钥、一次性门票）用 6 位码派生出的密钥加密后，按同样由 6 位码派生出的查找号寄存在这里；
// 手表输入 6 位码后算出同一个查找号来取。这里只存密文，5 分钟过期，取一次就删，看不懂内容。
//
//	POST /pair/put   头 Authorization: Bearer <电脑的访问令牌>   体 {"id":"<64 位十六进制>","blob":"<base64，≤ 4 KB>"}
//	GET  /pair/get?id=<64 位十六进制>                         → {"blob":"…"}，没有或过期 → 404

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	pairTTL       = 5 * time.Minute
	pairMaxBlob   = 4096
	pairMaxTotal  = 1000 // 同时寄存的上限（防止被人当免费存储）
	pairMinTTL    = 10 * time.Second // 寄存时可以要求更短的有效期（网页登录码 30 秒），最短 10 秒
	pairGetPerMin = 30   // 每个来源 IP 每分钟最多取几次（6 位码只有一百万种，别让人在线猜）
)

type pairItem struct {
	blob string
	exp  time.Time
	tok  string
}

type pairBox struct {
	mu    sync.Mutex
	items map[string]pairItem
	gets  map[string][]time.Time // IP → 最近一分钟的取件时间
}

func newPairBox() *pairBox {
	b := &pairBox{items: map[string]pairItem{}, gets: map[string][]time.Time{}}
	go func() {
		for range time.Tick(time.Minute) {
			b.mu.Lock()
			now := time.Now()
			for k, v := range b.items {
				if now.After(v.exp) {
					delete(b.items, k)
				}
			}
			for ip, ts := range b.gets {
				if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > time.Minute {
					delete(b.gets, ip)
				}
			}
			b.mu.Unlock()
		}
	}()
	return b
}

func validPairID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

func clientIP(r *http.Request) string {
	if x := r.Header.Get("X-Forwarded-For"); x != "" {
		return strings.TrimSpace(strings.Split(x, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func replyJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *hub) pairRoutes(mux *http.ServeMux) {
	box := newPairBox()
	mux.HandleFunc("/pair/put", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			replyJSON(w, 405, map[string]any{"error": "method"})
			return
		}
		tok := h.q.match(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if tok == "" {
			replyJSON(w, 401, map[string]any{"error": "token"})
			return
		}
		var body struct {
			ID   string `json:"id"`
			Blob string `json:"blob"`
			TTL  int    `json:"ttl"` // 秒；不填或超出范围就按默认（5 分钟）
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body) != nil || !validPairID(body.ID) || body.Blob == "" || len(body.Blob) > pairMaxBlob {
			replyJSON(w, 400, map[string]any{"error": "bad"})
			return
		}
		box.mu.Lock()
		defer box.mu.Unlock()
		now := time.Now()
		if it, ok := box.items[body.ID]; ok && now.Before(it.exp) {
			replyJSON(w, 409, map[string]any{"error": "exists"}) // 撞号了（极少见）：电脑换一个码再来
			return
		}
		if len(box.items) >= pairMaxTotal {
			replyJSON(w, 429, map[string]any{"error": "full"})
			return
		}
		ttl := pairTTL
		if t := time.Duration(body.TTL) * time.Second; t >= pairMinTTL && t < pairTTL {
			ttl = t
		}
		box.items[body.ID] = pairItem{blob: body.Blob, exp: now.Add(ttl), tok: tok}
		replyJSON(w, 200, map[string]any{"ok": true, "ttl": int(ttl.Seconds())})
	})
	mux.HandleFunc("/pair/get", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		if !validPairID(id) {
			replyJSON(w, 400, map[string]any{"error": "bad"})
			return
		}
		ip := clientIP(r)
		box.mu.Lock()
		defer box.mu.Unlock()
		now := time.Now()
		ts := box.gets[ip]
		for len(ts) > 0 && now.Sub(ts[0]) > time.Minute {
			ts = ts[1:]
		}
		if len(ts) >= pairGetPerMin {
			box.gets[ip] = ts
			replyJSON(w, 429, map[string]any{"error": "slow down"})
			return
		}
		box.gets[ip] = append(ts, now)
		it, ok := box.items[id]
		if !ok || now.After(it.exp) {
			delete(box.items, id)
			replyJSON(w, 404, map[string]any{"error": "none"})
			return
		}
		delete(box.items, id) // 只能取一次
		replyJSON(w, 200, map[string]any{"blob": it.blob})
	})
}
