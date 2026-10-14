package main

// 隧道：CONNECT /CSCOSSLC/tunnel（带 webvpn cookie），服务器在响应头里下发分配的内网地址、DNS、MTU，
// 之后这条 TLS 连接上收发 CSTP 帧：8 字节头 "STF\x01" + 长度(2) + 类型(1) + 0，后面是 IP 包。
// 收到的 IP 包交给用户态协议栈（gVisor netstack），协议栈发出的包再打包发回去——不建虚拟网卡、不改系统路由。

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const (
	pktData      = 0x00
	pktDPDReq    = 0x03
	pktDPDResp   = 0x04
	pktDisconn   = 0x05
	pktKeepalive = 0x07
	pktTerminate = 0x09
)

type tunnel struct {
	conn      *tls.Conn
	rd        *bufio.Reader
	wmu       sync.Mutex
	ip        netip.Addr
	dns       []netip.Addr
	mtu       int
	keepalive time.Duration
	dpd       time.Duration
	lastRecv  time.Time
	rmu       sync.Mutex

	st   *stack.Stack
	ep   *channel.Endpoint
	ctx  context.Context
	stop context.CancelFunc
	done chan struct{}
	err  error
}

func hostname() string {
	h, _ := os.Hostname()
	if h == "" {
		h = "claude-remote"
	}
	return h
}

func openTunnel(server, host, pin, token string) (*tunnel, error) {
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	raw, err := d.Dial("tcp", server)
	if err != nil {
		return nil, fmt.Errorf("连不上 VPN 服务器：%v", err)
	}
	conn := tls.Client(raw, tlsConfig(host, pin, nil))
	if err := conn.Handshake(); err != nil {
		raw.Close()
		var ce *certError
		if errors.As(err, &ce) {
			return nil, ce
		}
		return nil, fmt.Errorf("和 VPN 服务器握手失败：%v", err)
	}
	req := strings.Join([]string{
		"CONNECT /CSCOSSLC/tunnel HTTP/1.1",
		"Host: " + host,
		"User-Agent: " + userAgent,
		"Cookie: webvpn=" + token,
		"X-CSTP-Version: 1",
		"X-CSTP-Hostname: " + hostname(),
		"X-CSTP-Base-MTU: 1406",
		"X-CSTP-MTU: 1406",
		"X-CSTP-Address-Type: IPv4",
		"X-CSTP-Full-IPv6-Capability: false",
		"", "",
	}, "\r\n")
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	// 有的服务器要十几秒才回参数
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	rd := bufio.NewReaderSize(conn, 64*1024)
	res, err := http.ReadResponse(rd, &http.Request{Method: "CONNECT"})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("建立隧道时服务器没有正常应答：%v", err)
	}
	if res.StatusCode == 401 {
		conn.Close()
		return nil, errAuthExpired
	}
	if res.StatusCode != 200 {
		conn.Close()
		return nil, fmt.Errorf("建立隧道失败：HTTP %d", res.StatusCode)
	}
	_ = conn.SetReadDeadline(time.Time{})
	t := &tunnel{conn: conn, rd: rd, mtu: 1399, keepalive: 20 * time.Second, dpd: 30 * time.Second, done: make(chan struct{})}
	h := res.Header
	ip, err := netip.ParseAddr(strings.TrimSpace(h.Get("X-CSTP-Address")))
	if err != nil || !ip.Is4() {
		conn.Close()
		return nil, errors.New("服务器没有分配内网地址（X-CSTP-Address）")
	}
	t.ip = ip
	for _, v := range h.Values("X-CSTP-DNS") {
		if a, err := netip.ParseAddr(strings.TrimSpace(v)); err == nil && a.Is4() {
			t.dns = append(t.dns, a)
		}
	}
	if n, err := strconv.Atoi(h.Get("X-CSTP-MTU")); err == nil && n >= 576 && n <= 9000 {
		t.mtu = n
	}
	if n, err := strconv.Atoi(h.Get("X-CSTP-Keepalive")); err == nil && n > 0 {
		t.keepalive = time.Duration(n) * time.Second
	}
	if n, err := strconv.Atoi(h.Get("X-CSTP-DPD")); err == nil && n > 0 {
		t.dpd = time.Duration(n) * time.Second
	}
	if err := t.startStack(); err != nil {
		conn.Close()
		return nil, err
	}
	t.lastRecv = time.Now()
	go t.readLoop()
	go t.writeLoop()
	go t.timers()
	return t, nil
}

var errAuthExpired = errors.New("登录已失效")

func (t *tunnel) startStack() error {
	t.st = stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
	})
	t.ep = channel.New(1024, uint32(t.mtu), "")
	if e := t.st.CreateNIC(1, t.ep); e != nil {
		return fmt.Errorf("创建虚拟网络失败：%v", e)
	}
	pa := tcpip.ProtocolAddress{Protocol: ipv4.ProtocolNumber, AddressWithPrefix: tcpip.AddrFrom4(t.ip.As4()).WithPrefix()}
	if e := t.st.AddProtocolAddress(1, pa, stack.AddressProperties{}); e != nil {
		return fmt.Errorf("设置内网地址失败：%v", e)
	}
	t.st.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: 1}})
	// SSH 走大流量（传文件）：开 SACK、调大窗口
	sack := tcpip.TCPSACKEnabled(true)
	t.st.SetTransportProtocolOption(tcp.ProtocolNumber, &sack)
	t.ctx, t.stop = context.WithCancel(context.Background())
	return nil
}

func (t *tunnel) send(typ byte, payload []byte) error {
	hdr := []byte{'S', 'T', 'F', 1, 0, 0, typ, 0}
	binary.BigEndian.PutUint16(hdr[4:6], uint16(len(payload)))
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_ = t.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := t.conn.Write(append(hdr, payload...)); err != nil {
		return err
	}
	return nil
}

func (t *tunnel) fail(err error) {
	t.rmu.Lock()
	defer t.rmu.Unlock()
	select {
	case <-t.done:
		return
	default:
	}
	t.err = err
	close(t.done)
	t.stop()
	t.conn.Close()
}

// 服务器 → 协议栈
func (t *tunnel) readLoop() {
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(t.rd, hdr); err != nil {
			t.fail(fmt.Errorf("和 VPN 服务器的连接断了：%v", err))
			return
		}
		if hdr[0] != 'S' || hdr[1] != 'T' || hdr[2] != 'F' {
			t.fail(errors.New("收到的数据格式不对"))
			return
		}
		n := int(binary.BigEndian.Uint16(hdr[4:6]))
		data := make([]byte, n)
		if _, err := io.ReadFull(t.rd, data); err != nil {
			t.fail(fmt.Errorf("和 VPN 服务器的连接断了：%v", err))
			return
		}
		t.rmu.Lock()
		t.lastRecv = time.Now()
		t.rmu.Unlock()
		switch hdr[6] {
		case pktData:
			if n > 0 && data[0]>>4 == 4 {
				pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(data)})
				t.ep.InjectInbound(ipv4.ProtocolNumber, pkt)
				pkt.DecRef()
			}
		case pktDPDReq:
			_ = t.send(pktDPDResp, nil)
		case pktDisconn, pktTerminate:
			t.fail(errors.New("VPN 服务器断开了连接"))
			return
		}
	}
}

// 协议栈 → 服务器
func (t *tunnel) writeLoop() {
	for {
		pkt := t.ep.ReadContext(t.ctx)
		if pkt == nil {
			return
		}
		v := pkt.ToView()
		b := append([]byte(nil), v.AsSlice()...)
		v.Release()
		pkt.DecRef()
		if err := t.send(pktData, b); err != nil {
			t.fail(fmt.Errorf("发送数据失败：%v", err))
			return
		}
	}
}

// 定时保活；太久没收到服务器的任何东西就发 DPD，再没回应就算断了
func (t *tunnel) timers() {
	ka := time.NewTicker(t.keepalive)
	chk := time.NewTicker(5 * time.Second)
	defer ka.Stop()
	defer chk.Stop()
	for {
		select {
		case <-t.done:
			return
		case <-ka.C:
			_ = t.send(pktKeepalive, nil)
		case <-chk.C:
			t.rmu.Lock()
			idle := time.Since(t.lastRecv)
			t.rmu.Unlock()
			if idle > 3*t.dpd+10*time.Second {
				t.fail(errors.New("VPN 服务器长时间没有回应"))
				return
			}
			if idle > t.dpd {
				_ = t.send(pktDPDReq, nil)
			}
		}
	}
}

func (t *tunnel) close() {
	_ = t.send(pktDisconn, append([]byte{0xb0}, []byte("client disconnect")...))
	t.fail(errors.New("已断开"))
}

// ---------- 经隧道连接 ----------
func (t *tunnel) dialTCP(ctx context.Context, ip netip.Addr, port uint16) (net.Conn, error) {
	if !ip.Is4() {
		return nil, errors.New("隧道只支持 IPv4")
	}
	return gonet.DialContextTCP(ctx, t.st, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFrom4(ip.As4()), Port: port}, ipv4.ProtocolNumber)
}

// 域名先用 VPN 下发的 DNS 解析（内网域名），解析不了再用本机的
func (t *tunnel) resolve(ctx context.Context, host string) (netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip, nil
	}
	for _, d := range t.dns {
		dns := d
		r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return gonet.DialUDP(t.st, nil, &tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFrom4(dns.As4()), Port: 53}, ipv4.ProtocolNumber)
		}}
		c, cancel := context.WithTimeout(ctx, 4*time.Second)
		ips, err := r.LookupNetIP(c, "ip4", host)
		cancel()
		if err == nil && len(ips) > 0 {
			return ips[0].Unmap(), nil
		}
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil || len(ips) == 0 {
		return netip.Addr{}, fmt.Errorf("解析不了 %s", host)
	}
	return ips[0].Unmap(), nil
}
