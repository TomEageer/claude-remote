// crvpn：Claude 远程助手用的 VPN 小助手。
// 用 AnyConnect / OpenConnect 协议登录公司 VPN，在程序内部跑一套网络协议栈（不建虚拟网卡、不改系统路由、不需要管理员权限），
// 在本机开一个 SOCKS5 端口，软件连服务器的 SSH 走这个端口进内网。别的软件和整台电脑的网络都不受影响。
//
// 用法（和软件之间用一行一个 JSON 通信）：
//   crvpn probe   --server host:port [--pin pin-sha256:…]     查可选的用户组和证书，然后退出
//   crvpn connect --server host:port --group G --user U [--pin …] [--listen 127.0.0.1:0]
//       标准输入第一行 {"password":"…"}；需要动态口令时会输出 {"event":"need",…}，再写一行 {"answer":"…"}
//       连上后输出 {"event":"connected","socks":"127.0.0.1:端口",…}；标准输入关闭（软件退出）就断开并退出
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var outMu sync.Mutex

func emit(ev map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	b, _ := json.Marshal(ev)
	os.Stdout.Write(append(b, '\n'))
}

func fatal(code string, err error) {
	ev := map[string]any{"event": "error", "code": code, "message": err.Error()}
	var ce *certError
	if errors.As(err, &ce) {
		ev["code"], ev["pin"], ev["subject"] = "cert", ce.Pin, ce.Subject
	}
	emit(ev)
	os.Exit(1)
}

var stdin = bufio.NewScanner(os.Stdin)

func readLine() (map[string]string, bool) {
	if !stdin.Scan() {
		return nil, false
	}
	m := map[string]string{}
	_ = json.Unmarshal(stdin.Bytes(), &m)
	return m, true
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "用法：crvpn probe|connect --server host:port …")
		os.Exit(2)
	}
	stdin.Buffer(make([]byte, 64*1024), 64*1024)
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	server := fs.String("server", "", "VPN 服务器 host:port")
	group := fs.String("group", "", "用户组")
	user := fs.String("user", "", "账号")
	pin := fs.String("pin", "", "用户确认过的服务器证书指纹")
	listen := fs.String("listen", "127.0.0.1:0", "本机 SOCKS5 监听地址")
	_ = fs.Parse(os.Args[2:])
	if *server == "" {
		fatal("args", errors.New("没有填 VPN 服务器地址"))
	}
	switch cmd {
	case "probe":
		probe(*server, *pin)
	case "connect":
		connect(*server, *group, *user, *pin, *listen)
	default:
		fatal("args", fmt.Errorf("不认识的命令 %s", cmd))
	}
}

func probe(server, pin string) {
	seen := &certError{}
	a, err := newAuthSession(server, pin, seen)
	if err != nil {
		fatal("args", err)
	}
	r, err := a.initReq("")
	if err != nil {
		fatal("network", err)
	}
	groups, def := r.groups()
	emit(map[string]any{"event": "probe", "groups": groups, "default": def, "pin": seen.Pin, "subject": seen.Subject})
}

var fieldRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// 登录，返回 session-token；需要额外输入（动态口令等）时问软件要
func login(server, group, user, password, pin string) (string, error) {
	a, err := newAuthSession(server, pin, nil)
	if err != nil {
		return "", err
	}
	r, err := a.initReq(group)
	if err != nil {
		return "", err
	}
	if group == "" {
		_, group = r.groups()
	}
	fields := map[string]string{"username": user, "password": password}
	for round := 0; round < 4; round++ {
		r, err = a.reply(group, fields)
		if err != nil {
			return "", err
		}
		if r.SessionToken != "" || r.Type == "complete" {
			if r.SessionToken == "" {
				return "", errors.New("登录成功但服务器没有给会话令牌")
			}
			return r.SessionToken, nil
		}
		if e := r.errorText(); e != "" {
			return "", &authError{e}
		}
		// 又一个表单：把还没填的字段问软件要（通常是动态口令）
		next := map[string]string{}
		asked := false
		for _, in := range r.Auth.Form.Inputs {
			if !fieldRe.MatchString(in.Name) || in.Type == "hidden" && in.Value != "" {
				if in.Type == "hidden" && fieldRe.MatchString(in.Name) {
					next[in.Name] = in.Value
				}
				continue
			}
			if in.Name == "username" {
				next[in.Name] = user
				continue
			}
			if in.Name == "password" && round == 0 && len(r.Auth.Form.Inputs) > 1 {
				next[in.Name] = password
				continue
			}
			label := strings.TrimSpace(in.Label)
			if label == "" {
				label = strings.TrimSpace(r.Auth.Message)
			}
			emit(map[string]any{"event": "need", "field": in.Name, "label": label, "secret": in.Type == "password", "message": strings.TrimSpace(r.Auth.Message)})
			m, ok := readLine()
			if !ok {
				return "", errors.New("已取消")
			}
			next[in.Name] = m["answer"]
			asked = true
		}
		if !asked && len(next) == 0 {
			return "", errors.New("服务器要求的登录方式这里还不支持（可能是网页单点登录）")
		}
		fields = next
	}
	return "", errors.New("登录步骤太多，停止了")
}

type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }

func connect(server, group, user, pin, listen string) {
	first, ok := readLine()
	if !ok {
		fatal("args", errors.New("没有收到密码"))
	}
	password := first["password"]
	host, _, err := net.SplitHostPort(server)
	if err != nil {
		host = server
		server = net.JoinHostPort(server, "443")
	}

	emit(map[string]any{"event": "status", "text": "正在登录 VPN…"})
	token, err := login(server, group, user, password, pin)
	if err != nil {
		var ae *authError
		if errors.As(err, &ae) {
			fatal("auth", err)
		}
		fatal("network", err)
	}

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		fatal("listen", fmt.Errorf("本机端口打不开：%v", err))
	}
	var cur struct {
		sync.RWMutex
		t *tunnel
	}
	getT := func() *tunnel { cur.RLock(); defer cur.RUnlock(); return cur.t }

	emit(map[string]any{"event": "status", "text": "正在建立隧道…"})
	// 建隧道也会遇到连接被中途断开：重试几次（会话令牌失效、证书问题除外）
	var t *tunnel
	for attempt := 1; ; attempt++ {
		t, err = openTunnel(server, host, pin, token)
		if err == nil {
			break
		}
		var ce *certError
		if errors.Is(err, errAuthExpired) || errors.As(err, &ce) || attempt >= 3 {
			fatal("network", err)
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	cur.t = t
	dns := []string{}
	for _, d := range t.dns {
		dns = append(dns, d.String())
	}
	emit(map[string]any{"event": "connected", "socks": ln.Addr().String(), "ip": t.ip.String(), "dns": dns, "mtu": t.mtu})

	go serveSocks(ln, getT)

	// 软件退出（标准输入关闭）就断开
	quit := make(chan struct{})
	go func() {
		for {
			if _, ok := readLine(); !ok {
				close(quit)
				return
			}
		}
	}()

	// 断了自动重连：先用原来的会话令牌，失效了用密码重新登录
	for {
		select {
		case <-quit:
			if t := getT(); t != nil {
				t.close()
			}
			emit(map[string]any{"event": "closed", "reason": "quit"})
			return
		case <-t.done:
		}
		emit(map[string]any{"event": "reconnecting", "reason": t.err.Error()})
		var nt *tunnel
		for attempt := 1; ; attempt++ {
			select {
			case <-quit:
				emit(map[string]any{"event": "closed", "reason": "quit"})
				return
			case <-time.After(time.Duration(min(attempt, 6)) * 2 * time.Second):
			}
			nt, err = openTunnel(server, host, pin, token)
			if errors.Is(err, errAuthExpired) {
				token, err = login(server, group, user, password, pin)
				if err == nil {
					nt, err = openTunnel(server, host, pin, token)
				}
			}
			if err == nil {
				break
			}
			var ae *authError
			var ce *certError
			if errors.As(err, &ae) || errors.As(err, &ce) || attempt >= 30 {
				fatal("network", fmt.Errorf("重连失败：%v", err))
			}
			emit(map[string]any{"event": "reconnecting", "reason": err.Error(), "attempt": attempt})
		}
		cur.Lock()
		cur.t, t = nt, nt
		cur.Unlock()
		emit(map[string]any{"event": "connected", "socks": ln.Addr().String(), "ip": nt.ip.String(), "dns": dns, "mtu": nt.mtu, "reconnected": true})
	}
}

// ---------- SOCKS5（只接本机、无认证、只支持 CONNECT） ----------
func serveSocks(ln net.Listener, getT func() *tunnel) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handleSocks(c, getT)
	}
}

func handleSocks(c net.Conn, getT func() *tunnel) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	buf := make([]byte, 262)
	if _, err := io.ReadFull(c, buf[:2]); err != nil || buf[0] != 5 {
		return
	}
	if _, err := io.ReadFull(c, buf[:int(buf[1])]); err != nil {
		return
	}
	c.Write([]byte{5, 0})
	if _, err := io.ReadFull(c, buf[:4]); err != nil || buf[1] != 1 {
		c.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	var host string
	switch buf[3] {
	case 1:
		io.ReadFull(c, buf[:4])
		host = netip.AddrFrom4([4]byte(buf[:4])).String()
	case 3:
		io.ReadFull(c, buf[:1])
		n := int(buf[0])
		io.ReadFull(c, buf[:n])
		host = string(buf[:n])
	default:
		c.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	io.ReadFull(c, buf[:2])
	port := binary.BigEndian.Uint16(buf[:2])
	t := getT()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var up net.Conn
	ip, err := t.resolve(ctx, host)
	if err == nil {
		up, err = t.dialTCP(ctx, ip, port)
	}
	if err != nil {
		emit(map[string]any{"event": "log", "text": "经 VPN 连接 " + net.JoinHostPort(host, strconv.Itoa(int(port))) + " 失败：" + err.Error()})
		c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer up.Close()
	c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	_ = c.SetDeadline(time.Time{})
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, c); done <- struct{}{} }()
	go func() { io.Copy(c, up); done <- struct{}{} }()
	<-done
}
