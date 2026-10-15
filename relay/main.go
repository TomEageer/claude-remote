// crrelay：Claude 远程助手的中转枢纽。
//
// 手机和电脑都连到这里，它只在配对好的设备之间转发消息；内容在两端加密（手机扫码时拿到密钥），这里看不到。
// 同时提供手机端的网页版应用（打包在程序里），手机浏览器打开这个地址就能用。
//
// 运行方式：
//
//	crrelay --domain relay.example.com          自动申请 HTTPS 证书（需要 443 端口，域名解析到这台服务器）
//	crrelay --listen 127.0.0.1:8787             只开 HTTP，交给已有的 Nginx / Caddy 做 HTTPS 转发
//	crrelay --listen :8787                      直接用 IP 访问（只适合测试，手机不能添加到主屏幕）
//	crrelay --cert x.pem --key x.key --listen :443   用自己的证书
//
// 电脑端连接时要带访问令牌（第一次启动自动生成，存在 --data 目录，启动时打印）。手机端不需要令牌：没有密钥什么也做不了。
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/acme/autocert"
)

var version = "dev"

//go:embed all:web
var webFS embed.FS

const protocol = 1

type conn struct {
	ws     *websocket.Conn
	mu     sync.Mutex
	hostID string
	device string
}

func (c *conn) send(ctx context.Context, v any) error {
	b, _ := json.Marshal(v)
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, b)
}

type hub struct {
	mu      sync.Mutex
	hosts   map[string]*conn            // hostId → 电脑
	clients map[string]map[string]*conn // hostId → deviceId → 手机
	token   string
}

func (h *hub) clientsOf(hostID string) []*conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*conn
	for _, c := range h.clients[hostID] {
		out = append(out, c)
	}
	return out
}

type frame struct {
	T        string `json:"t"`
	HostID   string `json:"hostId,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Token    string `json:"token,omitempty"`
	To       string `json:"to,omitempty"`
	From     string `json:"from,omitempty"`
	Box      string `json:"box,omitempty"`
}

func validID(s string) bool {
	if len(s) < 8 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // 手机网页和本服务同源；电脑端不是浏览器
	if err != nil {
		return
	}
	ws.SetReadLimit(2 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{ws: ws}
	defer ws.CloseNow()

	// 第一条消息说明身份
	rctx, rcancel := context.WithTimeout(ctx, 20*time.Second)
	_, data, err := ws.Read(rctx)
	rcancel()
	if err != nil {
		return
	}
	var hello frame
	if json.Unmarshal(data, &hello) != nil || !validID(hello.HostID) {
		ws.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}
	go keepalive(ctx, ws)

	switch hello.T {
	case "host":
		if h.token == "" || hello.Token != h.token {
			_ = c.send(ctx, map[string]any{"t": "error", "code": "token", "message": "访问令牌不对"})
			ws.Close(websocket.StatusPolicyViolation, "bad token")
			return
		}
		c.hostID = hello.HostID
		h.mu.Lock()
		old := h.hosts[c.hostID]
		h.hosts[c.hostID] = c
		online := []string{}
		for id := range h.clients[c.hostID] {
			online = append(online, id)
		}
		h.mu.Unlock()
		if old != nil {
			old.ws.Close(websocket.StatusNormalClosure, "replaced")
		}
		_ = c.send(ctx, map[string]any{"t": "ok", "version": version, "protocol": protocol, "online": online})
		for _, cl := range h.clientsOf(c.hostID) {
			_ = cl.send(ctx, map[string]any{"t": "host-online"})
		}
		h.hostLoop(ctx, c)
		h.mu.Lock()
		if h.hosts[c.hostID] == c {
			delete(h.hosts, c.hostID)
		}
		h.mu.Unlock()
		for _, cl := range h.clientsOf(c.hostID) {
			_ = cl.send(context.Background(), map[string]any{"t": "host-offline"})
		}
	case "client":
		if !validID(hello.DeviceID) {
			ws.Close(websocket.StatusPolicyViolation, "bad device")
			return
		}
		c.hostID, c.device = hello.HostID, hello.DeviceID
		h.mu.Lock()
		if h.clients[c.hostID] == nil {
			h.clients[c.hostID] = map[string]*conn{}
		}
		if old := h.clients[c.hostID][c.device]; old != nil {
			old.ws.Close(websocket.StatusNormalClosure, "replaced")
		}
		h.clients[c.hostID][c.device] = c
		host := h.hosts[c.hostID]
		h.mu.Unlock()
		_ = c.send(ctx, map[string]any{"t": "ok", "version": version, "protocol": protocol, "hostOnline": host != nil})
		if host != nil {
			_ = host.send(ctx, map[string]any{"t": "peer", "deviceId": c.device, "on": true})
		}
		h.clientLoop(ctx, c)
		h.mu.Lock()
		if h.clients[c.hostID][c.device] == c {
			delete(h.clients[c.hostID], c.device)
		}
		host = h.hosts[c.hostID]
		h.mu.Unlock()
		if host != nil {
			_ = host.send(context.Background(), map[string]any{"t": "peer", "deviceId": c.device, "on": false})
		}
	default:
		ws.Close(websocket.StatusPolicyViolation, "bad hello")
	}
}

// 电脑发来的：{t:"msg", to: deviceId, box} 转给那台手机；{t:"revoked", to} 踢掉那台手机
func (h *hub) hostLoop(ctx context.Context, c *conn) {
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		h.mu.Lock()
		cl := h.clients[c.hostID][f.To]
		h.mu.Unlock()
		if cl == nil {
			continue
		}
		switch {
		case f.T == "msg" && f.Box != "":
			_ = cl.send(ctx, map[string]any{"t": "msg", "box": f.Box})
		case f.T == "revoked":
			// 电脑撤销了这台手机（或者根本不认识它）：通知手机，然后断开
			_ = cl.send(ctx, map[string]any{"t": "revoked"})
			cl.ws.Close(websocket.StatusPolicyViolation, "revoked")
		}
	}
}

// 手机发来的：{t:"msg", box}，转给它所属的电脑
func (h *hub) clientLoop(ctx context.Context, c *conn) {
	last := time.Now()
	n := 0
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		// 简单限流：每秒最多 20 条
		if time.Since(last) > time.Second {
			last, n = time.Now(), 0
		}
		if n++; n > 20 {
			continue
		}
		var f frame
		if json.Unmarshal(data, &f) != nil || f.T != "msg" || f.Box == "" {
			continue
		}
		h.mu.Lock()
		host := h.hosts[c.hostID]
		h.mu.Unlock()
		if host == nil {
			_ = c.send(ctx, map[string]any{"t": "host-offline"})
			continue
		}
		_ = host.send(ctx, map[string]any{"t": "msg", "from": c.device, "box": f.Box})
	}
}

func keepalive(ctx context.Context, ws *websocket.Conn) {
	t := time.NewTicker(25 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := ws.Ping(pctx)
			cancel()
			if err != nil {
				ws.CloseNow()
				return
			}
		}
	}
}

func loadToken(dir string, given string) string {
	if given != "" {
		return given
	}
	f := filepath.Join(dir, "token")
	if b, err := os.ReadFile(f); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		return strings.TrimSpace(string(b))
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	t := hex.EncodeToString(b)
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(f, []byte(t+"\n"), 0o600)
	return t
}

func main() {
	listen := flag.String("listen", "", "监听地址，例如 :8787 或 127.0.0.1:8787（用 --domain 时默认 :443）")
	domain := flag.String("domain", "", "域名：自动申请 HTTPS 证书（需要 443 端口，并且域名已解析到本机）")
	cert := flag.String("cert", "", "自己的证书文件（PEM）")
	key := flag.String("key", "", "自己的证书私钥（PEM）")
	data := flag.String("data", defaultDataDir(), "数据目录（访问令牌、自动申请的证书）")
	tokenFlag := flag.String("token", os.Getenv("CRRELAY_TOKEN"), "电脑端的访问令牌（不填就自动生成并保存）")
	showVer := flag.Bool("version", false, "显示版本")
	flag.Parse()
	if *showVer {
		fmt.Println(version)
		return
	}

	h := &hub{hosts: map[string]*conn{}, clients: map[string]map[string]*conn{}, token: loadToken(*data, *tokenFlag)}
	web, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "ok %s\n", version)
	})
	files := http.FileServer(http.FS(web))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		files.ServeHTTP(w, r)
	}))

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second}
	fmt.Printf("Claude 远程助手 中转枢纽 %s\n", version)
	fmt.Printf("电脑端访问令牌：%s\n", h.token)

	var err error
	switch {
	case *domain != "":
		m := &autocert.Manager{Prompt: autocert.AcceptTOS, HostPolicy: autocert.HostWhitelist(*domain), Cache: autocert.DirCache(filepath.Join(*data, "certs"))}
		addr := *listen
		if addr == "" {
			addr = ":443"
		}
		srv.Addr = addr
		srv.TLSConfig = m.TLSConfig()
		// 80 端口：证书验证用 + 跳转到 https（端口被占用就算了）
		go func() { _ = http.ListenAndServe(":80", m.HTTPHandler(nil)) }()
		fmt.Printf("手机打开：https://%s/   电脑端填：https://%s\n", *domain, *domain)
		err = srv.ListenAndServeTLS("", "")
	case *cert != "" && *key != "":
		addr := *listen
		if addr == "" {
			addr = ":443"
		}
		srv.Addr = addr
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		fmt.Printf("用自己的证书，监听 %s\n", addr)
		err = srv.ListenAndServeTLS(*cert, *key)
	default:
		addr := *listen
		if addr == "" {
			addr = ":8787"
		}
		srv.Addr = addr
		fmt.Printf("HTTP 监听 %s（没有 HTTPS：适合放在 Nginx / Caddy 后面，或者局域网测试）\n", addr)
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func defaultDataDir() string {
	if d := os.Getenv("CRRELAY_DATA"); d != "" {
		return d
	}
	if os.Geteuid() == 0 {
		return "/var/lib/crrelay"
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".crrelay")
}
