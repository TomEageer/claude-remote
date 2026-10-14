package main

// AnyConnect / OpenConnect 协议的登录（Cisco ASA、ocserv、AnyLink 都兼容这一套）：
//   1. POST /  type="init"         → 服务器返回 auth-request（可选的用户组、要填的字段）
//   2. POST /  type="auth-reply"   → 带上用户组、账号、密码；返回 complete（session-token）
//      或者又一个 auth-request（密码错了带 <error>，或者要动态口令等第二步）
//   3. 拿 session-token 作为 webvpn cookie 去建隧道（tunnel.go）

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"runtime"
	"strings"
	"time"
)

const userAgent = "Open AnyConnect VPN Agent v9.21"

func deviceID() string {
	switch runtime.GOOS {
	case "darwin":
		return "mac-intel"
	case "windows":
		return "win"
	}
	return "linux-64"
}

// ---------- 服务器证书 ----------
// 系统信任的证书直接通过；不受信任的（自签名）要用户确认指纹（pin），和 openconnect 的 pin-sha256 一样：SPKI 的 SHA-256
func certPin(c *x509.Certificate) string {
	h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
	return "pin-sha256:" + base64.StdEncoding.EncodeToString(h[:])
}

type certError struct {
	Pin     string
	Subject string
	Reason  string
}

func (e *certError) Error() string { return "服务器证书不受信任：" + e.Reason }

func tlsConfig(host, pin string, seen *certError) *tls.Config {
	return &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true, // 下面自己校验：系统信任 或 指纹和用户确认过的一致
		MinVersion:         tls.VersionTLS12,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("服务器没有给证书")
			}
			leaf := cs.PeerCertificates[0]
			p := certPin(leaf)
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Intermediates: inter})
			if err == nil || (pin != "" && pin == p) {
				if seen != nil {
					seen.Pin, seen.Subject = p, leaf.Subject.String()
				}
				return nil
			}
			ce := &certError{Pin: p, Subject: leaf.Subject.String(), Reason: err.Error()}
			if pin != "" {
				ce.Reason = "指纹和之前确认的不一样（证书换了，或者连到的不是原来的服务器）"
			}
			return ce
		},
	}
}

// ---------- 登录 ----------
type authSession struct {
	server string // host:port
	host   string
	pin    string
	client *http.Client
	opaque string
	action string
}

type option struct {
	Selected string `xml:"selected,attr"`
	Value    string `xml:"value,attr"`
	Text     string `xml:",chardata"`
}

type authResp struct {
	XMLName xml.Name `xml:"config-auth"`
	Type    string   `xml:"type,attr"`
	Opaque  struct {
		IsFor string `xml:"is-for,attr"`
		Inner string `xml:",innerxml"`
	} `xml:"opaque"`
	Auth struct {
		ID      string `xml:"id,attr"`
		Message string `xml:"message"`
		Error   struct {
			Param1 string `xml:"param1,attr"`
			Text   string `xml:",chardata"`
		} `xml:"error"`
		Form struct {
			Action string `xml:"action,attr"`
			Inputs []struct {
				Type  string `xml:"type,attr"`
				Name  string `xml:"name,attr"`
				Label string `xml:"label,attr"`
				Value string `xml:"value,attr"`
			} `xml:"input"`
			Selects []struct {
				Name    string   `xml:"name,attr"`
				Label   string   `xml:"label,attr"`
				Options []option `xml:"option"`
			} `xml:"select"`
		} `xml:"form"`
	} `xml:"auth"`
	SessionToken string `xml:"session-token"`
}

func (r *authResp) groups() (list []string, def string) {
	for _, s := range r.Auth.Form.Selects {
		if s.Name != "group_list" {
			continue
		}
		for _, o := range s.Options {
			v := strings.TrimSpace(o.Value)
			if v == "" {
				v = strings.TrimSpace(o.Text)
			}
			if v == "" {
				continue
			}
			list = append(list, v)
			if o.Selected == "true" && def == "" {
				def = v
			}
		}
	}
	return
}

func (r *authResp) errorText() string {
	e := strings.TrimSpace(r.Auth.Error.Param1)
	if e == "" {
		e = strings.TrimSpace(strings.ReplaceAll(r.Auth.Error.Text, "%s", ""))
	}
	return e
}

func newAuthSession(server, pin string, seen *certError) (*authSession, error) {
	host, _, err := net.SplitHostPort(server)
	if err != nil {
		host = server
		server = net.JoinHostPort(server, "443")
	}
	jar, _ := cookiejar.New(nil)
	tr := &http.Transport{
		TLSClientConfig: tlsConfig(host, pin, seen),
		Proxy:           nil, // 不走系统代理：VPN 服务器要直连
		// 每个请求单独连接：中间有代理软件时，复用的连接可能已经被悄悄断开，POST 不会自动重试，直接报 EOF
		DisableKeepAlives:   true,
		DialContext:         (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second,
	}
	return &authSession{server: server, host: host, pin: pin, client: &http.Client{Transport: tr, Jar: jar, Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (a *authSession) post(path, body string) (*authResp, error) {
	if path == "" || path == "/auth" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	// 网络抖动（连接被中途断开、超时）重试几次，每次都是新连接；证书问题不重试
	var res *http.Response
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest("POST", "https://"+a.server+path, strings.NewReader(body))
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("X-Transcend-Version", "1")
		req.Header.Set("X-Aggregate-Auth", "1")
		req.Header.Set("X-AnyConnect-Platform", deviceID())
		req.Header.Set("X-Support-HTTP-Auth", "true")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, err = a.client.Do(req)
		if err == nil {
			break
		}
		var ce *certError
		if errors.As(err, &ce) {
			return nil, ce
		}
		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("连不上 VPN 服务器（试了 3 次）：%v", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == 403 {
		return nil, errors.New("服务器拒绝了这个客户端（HTTP 403），可能不是 AnyConnect / OpenConnect 协议的 VPN")
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("服务器返回 HTTP %d", res.StatusCode)
	}
	var r authResp
	if err := xml.Unmarshal(bytes.TrimSpace(data), &r); err != nil {
		return nil, errors.New("服务器返回的不是 AnyConnect 登录页（地址或端口可能不对）")
	}
	if r.Opaque.Inner != "" {
		a.opaque = fmt.Sprintf(`<opaque is-for=%q>%s</opaque>`, r.Opaque.IsFor, r.Opaque.Inner)
	}
	a.action = r.Auth.Form.Action
	return &r, nil
}

func xmlEsc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func (a *authSession) initReq(group string) (*authResp, error) {
	gs := ""
	if group != "" {
		gs = "<group-select>" + xmlEsc(group) + "</group-select>"
	}
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<config-auth client="vpn" type="init" aggregate-auth-version="2">
<version who="vpn">v9.21</version>
<device-id>%s</device-id>
%s
<group-access>https://%s</group-access>
</config-auth>`, deviceID(), gs, xmlEsc(a.server))
	return a.post("/", body)
}

// fields：表单字段名 → 值（username / password / 动态口令等）
func (a *authSession) reply(group string, fields map[string]string) (*authResp, error) {
	var auth strings.Builder
	for k, v := range fields {
		fmt.Fprintf(&auth, "<%s>%s</%s>", k, xmlEsc(v), k)
	}
	gs := ""
	if group != "" {
		gs = "<group-select>" + xmlEsc(group) + "</group-select>"
	}
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<config-auth client="vpn" type="auth-reply" aggregate-auth-version="2">
<version who="vpn">v9.21</version>
<device-id>%s</device-id>
<session-token/>
<session-id/>
%s
<auth>%s</auth>
%s
</config-auth>`, deviceID(), a.opaque, auth.String(), gs)
	return a.post(a.action, body)
}
