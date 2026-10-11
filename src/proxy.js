// 经代理建立到 SSH 服务器的 TCP 连接，支持 socks5:// 与 http://（CONNECT）
// 返回的 socket 处于暂停状态，调用方交给 ssh2 的 connect({ sock }) 之后要 sock.resume()
const net = require('net');

function parseProxy(url) {
  const m = /^(socks5h?|socks|http):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/]+|\[[^\]]+\]):(\d+)\/?$/i.exec(String(url).trim());
  if (!m) throw new Error('代理地址格式不对，例：socks5://127.0.0.1:1080 或 http://127.0.0.1:8080');
  return {
    type: m[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http',
    user: m[2] ? decodeURIComponent(m[2]) : '',
    pass: m[3] ? decodeURIComponent(m[3]) : '',
    host: m[4].replace(/^\[|\]$/g, ''),
    port: Number(m[5]),
  };
}

// 按需读取固定字节数的小读取器
function reader(sock) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  const pump = () => {
    if (waiting && buf.length >= waiting.n) {
      const out = buf.subarray(0, waiting.n);
      buf = buf.subarray(waiting.n);
      const w = waiting;
      waiting = null;
      w.resolve(out);
    }
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  sock.on('data', onData);
  return {
    read: (n) => new Promise((resolve) => { waiting = { n, resolve }; pump(); }),
    until: (marker) => new Promise((resolve) => {
      const check = () => {
        const i = buf.indexOf(marker);
        if (i < 0) return;
        sock.off('data', check);
        const out = buf.subarray(0, i + marker.length);
        buf = buf.subarray(i + marker.length);
        resolve(out);
      };
      sock.on('data', check);
      check();
    }),
    // 握手结束：暂停并把多读到的数据（可能已含 SSH 版本行）退回流里，交给 ssh2 后再 resume
    detach: () => {
      sock.pause();
      sock.off('data', onData);
      if (buf.length) sock.unshift(buf);
    },
  };
}

async function socks5(sock, p, host, port) {
  const r = reader(sock);
  sock.write(Buffer.from(p.user ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await r.read(2);
  if (ver !== 5) throw new Error('代理不是 SOCKS5');
  if (method === 2) {
    const u = Buffer.from(p.user);
    const pw = Buffer.from(p.pass);
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const [, status] = await r.read(2);
    if (status !== 0) throw new Error('代理用户名或密码不对');
  } else if (method !== 0) {
    throw new Error('代理要求的认证方式不支持');
  }
  let addr;
  if (net.isIPv4(host)) addr = Buffer.from([1, ...host.split('.').map(Number)]);
  else {
    const h = Buffer.from(host);
    addr = Buffer.concat([Buffer.from([3, h.length]), h]);
  }
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  const head = await r.read(4);
  if (head[1] !== 0) {
    const reasons = { 1: '代理内部错误', 2: '代理规则不允许', 3: '网络不可达', 4: '服务器不可达', 5: '服务器拒绝连接', 6: '连接超时' };
    throw new Error('代理连接服务器失败：' + (reasons[head[1]] || `错误码 ${head[1]}`));
  }
  const atyp = head[3];
  const len = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0];
  await r.read(len + 2);
  r.detach();
}

async function httpConnect(sock, p, host, port) {
  const r = reader(sock);
  const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
  if (p.user) req += `Proxy-Authorization: Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}\r\n`;
  sock.write(req + '\r\n');
  const resp = (await r.until('\r\n\r\n')).toString('latin1');
  const status = Number((/^HTTP\/\d\.\d (\d{3})/.exec(resp) || [])[1]);
  if (status !== 200) throw new Error(`代理拒绝连接（HTTP ${status || '无响应'}）`);
  r.detach();
}

function connectViaProxy(proxyUrl, host, port, timeoutMs = 20000) {
  const p = parseProxy(proxyUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(p.port, p.host);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('连接代理超时')); }, timeoutMs);
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
    sock.once('error', (e) => fail(new Error(/ECONNREFUSED/.test(e.message) ? `连不上代理 ${p.host}:${p.port}，代理软件没开？` : e.message)));
    sock.once('connect', async () => {
      try {
        if (p.type === 'socks5') await socks5(sock, p, host, Number(port) || 22);
        else await httpConnect(sock, p, host, Number(port) || 22);
        clearTimeout(timer);
        sock.removeAllListeners('error');
        resolve(sock);
      } catch (e) {
        fail(e);
      }
    });
  });
}

module.exports = { connectViaProxy, parseProxy };
