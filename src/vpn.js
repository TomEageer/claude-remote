// 公司 VPN（AnyConnect / OpenConnect 协议）：交给 crvpn 小助手（vpn/ 目录，Go 写的，随安装包带在 resources/bin 里）。
// 它在自己进程里跑网络协议栈，只在本机开一个 SOCKS5 端口；SSH 走这个端口进内网。不建虚拟网卡、不改系统路由、不要管理员权限。
//
// 每台服务器的设置里 vpn = { on, server, group, user, pin, pass }，pass 用系统钥匙串 / Windows 凭据加密（safeStorage）。
// 连服务器时 ensure() 按需拨号，同一个 VPN 账号共用一个助手进程；软件退出时关闭标准输入，助手会断开并退出。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

const sessions = new Map(); // key → { proc, ready, state, text, ip, socks, cfg }
let notify = () => {};

function setNotifier(fn) { notify = fn; }

const OWN_VERSION = require('../package.json').version;
const binKey = () => `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;
// 快速更新带来的新 VPN 组件：放在用户数据目录，按代码版本命名（见 src/updater.js）
const updatedBin = () => path.join(app.getPath('userData'), 'app-update', 'bin', `crvpn-${OWN_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);
function bundledBin() {
  const exe = process.platform === 'win32' ? 'crvpn.exe' : 'crvpn';
  return path.join(process.resourcesPath, 'bin', exe);
}

function binPath() {
  const exe = process.platform === 'win32' ? 'crvpn.exe' : 'crvpn';
  if (app.isPackaged) return fs.existsSync(updatedBin()) ? updatedBin() : bundledBin();
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  return path.join(__dirname, '..', 'vpn', 'dist', `${os}-${process.arch}`, exe);
}

// 启动时对一下：这个版本发布的 VPN 组件和本机正在用的是不是同一个，不是就从这个版本的发布页下载（校验 sha512）。
// 这样新组件不依赖「上一个版本的更新程序认不认识它」，升级后重启就能用上
let syncing = null;
function syncBin(repo) {
  if (!app.isPackaged || syncing) return syncing;
  syncing = (async () => {
    const crypto = require('crypto');
    const zlib = require('zlib');
    const { net } = require('electron');
    const sha = (f) => { try { return crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64'); } catch (_) { return ''; } };
    const base = `https://github.com/${repo}/releases/download/v${OWN_VERSION}/`;
    const res = await net.fetch(base + 'app-update.json', { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return;
    const info = await res.json();
    const want = info && info.bin && info.bin[binKey()];
    if (!want || sha(updatedBin()) === want.sha512 || sha(bundledBin()) === want.sha512) return;
    const r2 = await net.fetch(base + `crvpn-${binKey()}.gz`, { signal: AbortSignal.timeout(120000) });
    if (!r2.ok) return;
    const raw = zlib.gunzipSync(Buffer.from(await r2.arrayBuffer()));
    if (crypto.createHash('sha512').update(raw).digest('base64') !== want.sha512) return;
    fs.mkdirSync(path.dirname(updatedBin()), { recursive: true });
    fs.writeFileSync(updatedBin() + '.part', raw, { mode: 0o755 });
    fs.renameSync(updatedBin() + '.part', updatedBin());
  })().catch(() => {}).finally(() => { setTimeout(() => { syncing = null; }, 0); });
  return syncing;
}

function available() {
  return fs.existsSync(binPath());
}

// ---------- 密码：只存加密后的 ----------
function encrypt(pw) {
  const s = String(pw || '');
  if (!s) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}
function decrypt(v) {
  const s = String(v || '');
  if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  return '';
}

const keyOf = (v) => `${v.user}@${v.server}|${v.group || ''}`;
const usable = (v) => !!(v && v.on && v.server && v.user && v.pass);

function check() {
  if (!available()) throw new Error('这个安装包里没有 VPN 组件（快速更新不会带上它），请从下载页安装一次完整安装包');
}

// 只查用户组和证书（不登录）
function probe({ server, pin }) {
  check();
  return new Promise((resolve, reject) => {
    const p = spawn(binPath(), ['probe', '--server', String(server || '').trim(), '--pin', pin || ''], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (e) => reject(new Error('VPN 组件启动失败：' + e.message)));
    p.on('close', () => {
      const line = out.trim().split('\n').pop();
      let j = null;
      try { j = JSON.parse(line); } catch (_) {}
      if (!j) return reject(new Error('VPN 组件没有返回结果'));
      resolve(j);
    });
    p.stdin.end();
    setTimeout(() => p.kill(), 40000);
  });
}

function setState(key, patch) {
  const s = sessions.get(key);
  if (!s) return;
  Object.assign(s, patch);
  notify({ key, server: s.cfg.server, state: s.state, text: s.text || '', ip: s.ip || '' });
}

// 按需拨号，返回本机 SOCKS5 地址
function ensure(v) {
  check();
  if (!usable(v)) throw new Error('VPN 设置不完整（地址、账号、密码都要填）');
  const key = keyOf(v);
  const old = sessions.get(key);
  if (old && old.cfg.pin === (v.pin || '') && old.cfg.pass === v.pass && old.state !== 'error') return old.ready;
  if (old) stop(key);
  const password = decrypt(v.pass);
  const args = ['connect', '--server', String(v.server).trim(), '--group', v.group || '', '--user', v.user, '--pin', v.pin || ''];
  const proc = spawn(binPath(), args, { windowsHide: true });
  const s = { proc, state: 'connecting', text: '正在连接 VPN…', cfg: { server: v.server, pin: v.pin || '', pass: v.pass }, ip: '', socks: '' };
  sessions.set(key, s);
  s.ready = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, x) => { if (!settled) { settled = true; fn(x); } };
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let e;
        try { e = JSON.parse(line); } catch (_) { continue; }
        if (e.event === 'status') setState(key, { text: e.text });
        else if (e.event === 'need') { setState(key, { state: 'need', text: e.label || '需要额外验证' }); notify({ key, need: { field: e.field, label: e.label, secret: !!e.secret, message: e.message || '' } }); }
        else if (e.event === 'connected') { setState(key, { state: 'connected', text: e.reconnected ? 'VPN 已重新连上' : 'VPN 已连接', ip: e.ip, socks: e.socks }); done(resolve, 'socks5://' + e.socks); }
        else if (e.event === 'reconnecting') setState(key, { state: 'reconnecting', text: 'VPN 断了，正在重连：' + (e.reason || '') });
        else if (e.event === 'error') {
          const err = new Error(e.code === 'cert' ? `VPN 服务器证书不受信任（${e.message}），请在设置里核对指纹后点「信任」` : e.code === 'auth' ? `VPN 登录失败：${e.message}` : e.message);
          err.code = e.code;
          err.pin = e.pin;
          setState(key, { state: 'error', text: err.message });
          done(reject, err);
        }
      }
    });
    proc.on('error', (e) => { setState(key, { state: 'error', text: e.message }); done(reject, new Error('VPN 组件启动失败：' + e.message)); });
    proc.on('close', () => {
      if (sessions.get(key) === s) {
        if (s.state !== 'error') setState(key, { state: 'off', text: 'VPN 已断开' });
        sessions.delete(key);
      }
      done(reject, new Error(s.text && s.state === 'error' ? s.text : 'VPN 连接中断了'));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify({ password }) + '\n');
    setTimeout(() => done(reject, new Error('连接 VPN 超时（90 秒）')), 90000);
  });
  s.ready.catch(() => {});
  return s.ready;
}

// SSH 连接用的代理地址：开了 VPN 就先拨号；否则用手填的代理
async function proxyFor(settings) {
  if (settings && settings.vpn && settings.vpn.on) {
    if (syncing) await Promise.race([syncing, new Promise((r) => setTimeout(r, 20000))]);
    return ensure(settings.vpn);
  }
  return (settings && settings.proxy) || '';
}

function answer(key, text) {
  const s = sessions.get(key);
  if (!s) throw new Error('VPN 连接已经结束');
  s.proc.stdin.write(JSON.stringify({ answer: String(text || '') }) + '\n');
  setState(key, { state: 'connecting', text: '正在验证…' });
}

function stop(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try { s.proc.stdin.end(); } catch (_) {}
  setTimeout(() => { try { s.proc.kill(); } catch (_) {} }, 3000);
  notify({ key, server: s.cfg.server, state: 'off', text: 'VPN 已断开' });
}

function stopAll() {
  for (const k of [...sessions.keys()]) stop(k);
}

function list() {
  return [...sessions.entries()].map(([key, s]) => ({ key, server: s.cfg.server, state: s.state, text: s.text, ip: s.ip }));
}

module.exports = { syncBin, binKey, bundledBin, binPath, setNotifier, available, encrypt, probe, ensure, proxyFor, answer, stop, stopAll, list, keyOf };
