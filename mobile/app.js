/* global nacl, marked, DOMPurify, crE2E */
'use strict';

// Claude 远程助手 · 手机端
// 和电脑之间的消息全部加密（tweetnacl secretbox，密钥只在配对时从电脑那里拿到，中转服务器看不到）。
// 配对：扫电脑上的二维码（https://中转地址/#p=配对码，# 后面不会发给服务器），或者手动粘贴配对码。

// ---------- 小工具 ----------
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = {
  enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const fromB64url = (s) => b64.dec(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const enc = new TextEncoder();
const dec = new TextDecoder();

const ICONS = {
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M10 13h5M13 10.5l2.5 2.5-2.5 2.5"/>',
  dots: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/>',
  film: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 9.5l4.5 2.5-4.5 2.5z"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M4 15h16M10 5v14"/>',
  menu: '<path d="M4 8h16M4 16h11"/>',
  compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 16l5-5 4 4 3-3 4 4"/><circle cx="15.5" cy="9.5" r="1.5"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plan: '<path d="M10 6h10M10 12h10M10 18h10M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2L7.5 11M4 18l1.2 1.2L7.5 17"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  pin: '<path d="M12 16v5M8 3h8l-1 6 3 4H6l3-4z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  pencil: '<path d="M15.5 4.5l4 4L9 19H5v-4z"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  scan: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4M7 12h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 14h5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
  agent: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  gear: '<path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.2.9a1.7 1.7 0 0 0 2.5 1l.8-.5a1.7 1.7 0 0 1 2.4 2.4l-.5.8a1.7 1.7 0 0 0 1 2.5l.9.2a1.7 1.7 0 0 1 0 3.4l-.9.2a1.7 1.7 0 0 0-1 2.5l.5.8a1.7 1.7 0 0 1-2.4 2.4l-.8-.5a1.7 1.7 0 0 0-2.5 1l-.2.9a1.7 1.7 0 0 1-3.4 0l-.2-.9a1.7 1.7 0 0 0-2.5-1l-.8.5a1.7 1.7 0 0 1-2.4-2.4l.5-.8a1.7 1.7 0 0 0-1-2.5l-.9-.2a1.7 1.7 0 0 1 0-3.4l.9-.2a1.7 1.7 0 0 0 1-2.5l-.5-.8a1.7 1.7 0 0 1 2.4-2.4l.8.5a1.7 1.7 0 0 0 2.5-1z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;

// Claude 的星芒：12 条长短交替的射线，从圆心向外均匀分布
function spark(size = 28, live = false) {
  const lens = [10, 8.2, 9.4, 7.8, 10, 8.4, 9.2, 8, 9.8, 8.2, 9.4, 8.6];
  const rays = lens.map((l, i) => `<path d="M0 -2.4V${-l}" transform="rotate(${i * 30})"/>`).join('');
  return `<svg class="spark${live ? ' live' : ''}" width="${size}" height="${size}" viewBox="-11 -11 22 22" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">${rays}</svg>`;
}

function toast(text, ms = 2400) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', 'toast', esc(text));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch (_) {
    const ta = el('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) {}
    ta.remove();
  }
  toast('已复制');
}

const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

// ---------- 配对 ----------
// pair 第 2 版：{ v: 2, host, device, name, relay, hostPk, sk }（一次性二维码配的，见 e2e.js）
//      第 1 版：{ host, device, key, name }（旧版本配的，照常能用，提示到电脑上升级）
let pair = null;
try { pair = JSON.parse(localStorage.getItem('crPair') || 'null'); } catch (_) {}
let pairing = null; // 正在配对：{ pair, box, code, state: 'wait' | 'sent' }
const isApp = !!window.ClaudeRemoteApp; // 安卓 App 里：页面打包在 App 里，扫到的链接不跳转，直接配对
const v2 = () => !!(pair && pair.v === 2);
// 中转地址：二维码里带了就用它（安全模式：页面在 GitHub，中转在别处），否则就是页面所在的服务器
const relayBase = () => ((pair || (pairing && pairing.pair) || {}).relay || location.origin).replace(/\/+$/, '');

// 接受三种内容：完整链接（https://…/#p=…）、配对码、或者别的页面地址的链接（跳过去）
function applyPairText(text) {
  text = String(text || '').trim();
  if (!text) return false;
  let code = text;
  const m = /[#&]p=([A-Za-z0-9_-]+)/.exec(text);
  if (m) {
    code = m[1];
    try {
      const u = new URL(text);
      // 电脑上选的页面来源和现在这个页面不一样（比如安全模式要用 GitHub 上的页面）：跳过去，配对信息存在那边。
      // 主屏幕图标（独立窗口）里跳别的地址会变成一个嵌在里面的小浏览器，配对会存在那个小浏览器里、关掉就没了：
      // 改成在 Safari 里打开，并告诉用户配好后重新添加到主屏幕
      if (pageDiffers(text) && !isApp) { if (standalone()) { migrateSheet(text); return false; } location.href = text; return true; }
    } catch (_) {}
  }
  try {
    const p = JSON.parse(dec.decode(fromB64url(code)));
    if (!p || !p.h || !p.d || !p.k) throw new Error('bad');
    if (p.v === 2) {
      if (!p.t) throw new Error('bad');
      const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? '安卓手机' : '手机';
      pairing = { ...crE2E.phone.pairRequest(p, label), state: 'wait' };
      if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch (_) {} }
      return true;
    }
    pair = { host: p.h, device: p.d, key: p.k, name: p.n || '我的电脑' };
    localStorage.setItem('crPair', JSON.stringify(pair));
    toast('已配对「' + pair.name + '」');
    return true;
  } catch (_) {
    toast('配对码不对，请在电脑上重新复制');
    return false;
  }
}

// 这个页面是不是「添加到主屏幕」后以独立窗口打开的
const standalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
// 给的地址和当前页面不是同一个来源（域名或目录不同）
function pageDiffers(url) {
  try { const u = new URL(url, location.href); return u.origin + u.pathname.replace(/[^/]*$/, '') !== location.origin + location.pathname.replace(/[^/]*$/, ''); } catch (_) { return false; }
}
let migrateHidden = false;
// 电脑换了页面地址，而这个是钉在主屏幕上的旧页面：引导换到新页面重新配对、重新加到主屏幕
function migrateSheet(url) {
  let host = '';
  try { host = new URL(url, location.href).host; } catch (_) {}
  sheet((s) => {
    s.innerHTML = `<h3>电脑换了页面地址</h3>
      <p class="sub">这个图标打开的还是旧页面（${esc(location.host)}），新的配对要在新页面（${esc(host)}）里完成，照下面三步换过去：</p>
      <ol class="steps">
        <li>点下面的按钮，在 Safari 里打开新页面，扫电脑上的二维码配对</li>
        <li>配好后在 Safari 里点分享按钮 ${ic('share', 'inl')} →「添加到主屏幕」</li>
        <li>删掉这个旧图标</li>
      </ol>`;
    const b = el('button', 'btn primary', '在 Safari 里打开新页面');
    b.onclick = () => { closeSheet(); window.open(url, '_blank'); };
    s.appendChild(b);
    const c = el('button', 'btn', '先不换');
    c.onclick = () => { migrateHidden = true; closeSheet(); renderBanner(); };
    s.appendChild(c);
  });
}

// 配好对、又是在浏览器里（不是主屏幕图标、不是 App）：教用户把它加到主屏幕。按浏览器分别说清楚按钮在哪
let installEvt = null; // 安卓 Chrome 的「安装应用」提示，浏览器主动给的
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
const UA = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const iosSafari = isIOS && /Safari/.test(UA) && !/CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|QQ\/|Weibo|DingTalk|Lark|Feishu/.test(UA);
function installHint(force) {
  if (isApp || standalone()) return;
  if (!force && (localStorage.getItem('crA2hs') === 'done' || sessionStorage.getItem('crA2hsShown'))) return;
  sessionStorage.setItem('crA2hsShown', '1');
  sheet((s) => {
    let steps;
    if (iosSafari) steps = `<li>点 Safari 的分享按钮 ${ic('share', 'inl')}（iPhone 在底部中间，iPad 在右上角）</li><li>往下找到「<b>添加到主屏幕</b>」</li><li>点右上角「添加」，以后从桌面图标打开</li>`;
    else if (isIOS) steps = `<li>这个页面现在不是在 Safari 里打开的，先复制地址到 <b>Safari</b> 打开</li><li>点 Safari 的分享按钮 ${ic('share', 'inl')} →「添加到主屏幕」</li>`;
    else if (installEvt) steps = `<li>点下面的「安装到桌面」，浏览器会问你要不要安装</li>`;
    else steps = `<li>点浏览器右上角菜单</li><li>选「<b>添加到主屏幕</b>」或「安装应用」</li>`;
    s.innerHTML = `<h3>放到主屏幕，像 App 一样打开</h3><p class="sub">不用装 App，加到主屏幕后全屏打开、也不会丢配对。</p><ol class="steps">${steps}</ol>`;
    if (!iosSafari && isIOS) { const c = el('button', 'btn primary', '复制页面地址'); c.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(location.origin + location.pathname).then(() => toast('已复制，去 Safari 粘贴打开')); }; s.appendChild(c); }
    if (installEvt) { const b = el('button', 'btn primary', '安装到桌面'); b.onclick = async () => { const e = installEvt; installEvt = null; closeSheet(); try { e.prompt(); await e.userChoice; } catch (_) {} }; s.appendChild(b); }
    const ok = el('button', 'btn' + (iosSafari ? ' primary' : ''), '知道了');
    ok.onclick = () => closeSheet();
    s.appendChild(ok);
    const no = el('button', 'btn', '不再提示');
    no.onclick = () => { localStorage.setItem('crA2hs', 'done'); closeSheet(); };
    s.appendChild(no);
  });
}

// ---------- 加密通道 ----------
let ws = null;
let hostOnline = false;
let connState = 'connecting';
let reqSeq = 0;
let retry = 0;
let retryTimer = null;
const waiting = new Map(); // 请求编号 → { resolve, op, args, retried }
let lastRx = 0;
let readyWaiters = [];
const READ_OPS = new Set(['info', 'list', 'open']);
const key = () => b64.dec(pair.key);
let chan = null;   // 第 2 版：这次连接的加密通道（握手后才有）
let hsTries = 0;   // 握手连续没有回应的次数
let hs = null;     // 正在握手

function seal(obj) {
  const nonce = nacl.randomBytes(24);
  const box = nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, key());
  const out = new Uint8Array(24 + box.length);
  out.set(nonce);
  out.set(box, 24);
  return b64.enc(out);
}
function unseal(s) {
  try {
    const raw = b64.dec(s);
    const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), key());
    return plain ? JSON.parse(dec.decode(plain)) : null;
  } catch (_) { return null; }
}

function connect() {
  clearTimeout(retryTimer);
  // 正在配对时必须用新的设备身份连：已经配过的手机再扫一个新码，用旧身份发配对请求，电脑会当成旧手机的消息，二维码直接作废、也不弹核对数字
  const who = (pairing && pairing.pair) || pair;
  if (!who) return;
  const url = relayBase().replace(/^http/i, 'ws') + '/ws';
  connState = 'connecting';
  chan = null;
  hs = null;
  renderBanner();
  let sock;
  try { sock = new WebSocket(url); } catch (_) { connState = 'off'; renderBanner(); return; }
  ws = sock;
  sock.onopen = () => { retry = 0; sock.send(JSON.stringify({ t: 'client', hostId: who.host, deviceId: who.device })); };
  sock.onmessage = (e) => {
    lastRx = Date.now();
    let f;
    try { f = JSON.parse(e.data); } catch (_) { return; }
    if (f.t === 'pong') return;
    if (pairing) return onPairFrame(f);
    if (f.t === 'ok') { connState = 'on'; replaced = false; relayVersion = f.version || ''; checkShell(relayVersion); setHost(!!f.hostOnline); }
    else if (f.t === 'host-online') setHost(true);
    else if (f.t === 'host-offline') setHost(false);
    else if (f.t === 'revoked') { sock.onclose = null; unpair('这台手机已被电脑撤销，要再用请在电脑上重新添加'); }
    else if (f.t === 'msg') {
      const box = String(f.box || '');
      let m = null;
      if (v2()) {
        if (box.startsWith('I2.') && hs) {
          const c = hs.finish(box);
          if (c) { chan = c; hs = null; hsTries = 0; secured(); }
          return;
        }
        // 电脑重启过、不认识这次的通道：重新握手，没回应的请求等握手好了重发
        if (box === 'R2') { chan = null; failInflight(); handshake(); return; }
        if (box.startsWith('S2.') && chan) m = chan.open(box);
      } else m = unseal(box);
      if (!m) return;
      if (m.re != null && waiting.has(m.re)) { waiting.get(m.re).resolve(m); waiting.delete(m.re); }
      else if (m.push) onPush(m);
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    hostOnline = false;
    chan = null;
    hs = null;
    connState = 'off';
    // 被另一台设备挤掉了：两台设备用了同一个配对（同一个二维码 / 链接），中转只留一个在线。
    // 直说原因，并且放慢重连，别两边来回互踢
    replaced = e && e.reason === 'replaced';
    renderBanner();
    failInflight();
    retryTimer = setTimeout(connect, replaced ? 20000 : Math.min(8000, 500 * 2 ** retry++));
  };
}

// 中转程序升级了：页面缓存里还是旧版本，主动把新文件取下来换掉，再重新加载一次（只在刚打开时做，不打断正在输入）
const SHELL_FILES = ['theme.js', './', 'style.css', 'app.js', 'e2e.js', 'vendor/nacl-fast.min.js', 'vendor/marked.js', 'vendor/purify.js', 'manifest.json'];
async function checkShell(v) {
  let seen = '';
  try { seen = localStorage.getItem('crShell') || ''; } catch (_) {}
  if (!v || v === seen) return;
  // 页面不在中转上（安全模式 / 安卓 App）：中转升级和页面版本无关
  if (relayBase() !== location.origin) return;
  try { localStorage.setItem('crShell', v); } catch (_) {}
  if (!seen || !('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  if ($('#input') && $('#input').value.trim()) return;
  try {
    const c = await caches.open('cr-shell-v4');
    await Promise.all(SHELL_FILES.map(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) await c.put(new URL(u, location.href).href, r);
    }));
    location.reload();
  } catch (_) {}
}

function setHost(on) {
  hostOnline = on;
  renderBanner();
  if (!on) { chan = null; hs = null; return; }
  if (v2()) handshake();
  else secured();
}
// 第 2 版每次连上都先握手：生成只用这一次的临时密钥，用长期密钥加密发给电脑
function handshake() {
  if (!ws || ws.readyState !== 1 || !hostOnline) return;
  hs = crE2E.phone.hello(pair);
  try { ws.send(JSON.stringify({ t: 'msg', box: hs.box })); } catch (_) {}
  const mine = hs;
  // 电脑一直没回：多半是电脑上的软件太旧、不认识新的加密方式。过一会儿再试，第二次还不回就提示更新
  setTimeout(() => {
    if (hs !== mine || chan || !ws || ws.readyState !== 1 || !hostOnline) return;
    hsTries++;
    renderBanner();
    if (hsTries >= 2) hostTooOld(`「${pair.name}」没有回应新的加密连接，电脑上的 Claude 远程助手可能还是旧版本（需要 ${NEED_HOST} 或更新）。`);
    handshake();
  }, 8000);
}
function secured() {
  renderBanner();
  {
    const w = readyWaiters;
    readyWaiters = [];
    w.forEach((f) => f());
    refreshInfo();
    loadList();
    if (view === 'chat' && current && current.sid) openChat(current.sid, true);
  }
}

// 连接断了：读数据的请求（列表、打开对话）连上后自动重发一次；发消息、上传之类的直接告诉你没成功，不偷偷重发
function failInflight() {
  for (const [id, w] of [...waiting]) {
    waiting.delete(id);
    if (READ_OPS.has(w.op) && !w.retried) call(w.op, w.args, w.timeout, true).then(w.resolve);
    else w.resolve({ ok: false, message: '连接断了，没发出去，请再试一次' });
  }
}
const ready = () => ws && ws.readyState === 1 && hostOnline && (!v2() || !!chan);
// 还没连上（刚从后台回来、正在重连）：最多等 10 秒，连上了再发
function whenReady(ms = 10000) {
  if (ready()) return Promise.resolve(true);
  if (!ws || ws.readyState > 1) connect();
  return new Promise((res) => {
    const f = () => { clearTimeout(t); res(true); };
    const t = setTimeout(() => { readyWaiters = readyWaiters.filter((x) => x !== f); res(false); }, ms);
    readyWaiters.push(f);
  });
}
async function call(op, args = {}, timeout = 20000, retried = false) {
  if (!ready() && !(await whenReady())) return { ok: false, message: hostOnline ? '连不上中转服务器' : '电脑不在线' };
  return new Promise((resolve) => {
    const id = ++reqSeq;
    waiting.set(id, { resolve, op, args, timeout, retried });
    try { ws.send(JSON.stringify({ t: 'msg', box: v2() ? chan.seal({ id, op, ...args }) : seal({ id, op, ...args }) })); } catch (_) {}
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ ok: false, message: '电脑没有回应，稍后再试' }); } }, timeout);
  });
}

// 心跳：每 12 秒问一声中转，25 秒没收到任何东西就当连接已经断了（iPhone 切后台、换网络后常见），马上重连
setInterval(() => {
  if (!(pair || pairing) || !ws || ws.readyState !== 1 || document.hidden) return;
  if (Date.now() - lastRx > 25000) { const w = ws; w.onclose && w.onclose(); try { w.close(); } catch (_) {} return; }
  try { ws.send('{"t":"ping"}'); } catch (_) {}
}, 12000);

function unpair(msg) {
  localStorage.removeItem('crPair');
  ['crInfo', 'crList'].forEach((k) => localStorage.removeItem(k));
  info = null; sessions = []; groups = [];
  pair = null;
  if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); }
  if (msg) toast(msg, 3500);
  boot();
}

// ---------- 状态 ----------
// 上次的设置和对话列表先拿来用：打开就有内容，连上电脑后再刷新
const cached = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
let info = cached('crInfo');      // 电脑端的设置：服务器、模型、命令、额度
let sessions = (cached('crList') || {}).sessions || [];
let groups = (cached('crList') || {}).groups || [];
let view = 'home';        // home（新对话）| chat
let current = null;       // { sid, title, messages, offset, running, plan, pinned }
const newCtx = { serverId: null, cwd: null, plan: false };
try { newCtx.serverId = (JSON.parse(localStorage.getItem('crPrefs') || '{}').server) || null; } catch (_) {}
let atts = [];            // 输入框里的附件
let search = '';
const openSteps = new Set();
let relayVersion = '';
const prefs = (() => { try { return JSON.parse(localStorage.getItem('crPrefs') || '{}'); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('crPrefs', JSON.stringify(prefs)); } catch (_) {} };
// 外观和字号：跟随系统 / 浅色 / 深色；小 / 标准 / 大
function applyPrefs() {
  const r = document.documentElement;
  if (window.setThemeColor) window.setThemeColor(prefs.theme || '');
  r.style.setProperty('--msg-fs', { s: '15px', m: '16px', l: '17.5px', xl: '19px' }[prefs.size || 'm']);
}
applyPrefs();
const openPreview = new Set();
const askPicks = {};

// 这个页面需要的电脑端最低版本：页面（GitHub / 中转 / App）可能比电脑上的软件新
const NEED_HOST = '1.9.0';
const verOlder = (a, b) => {
  const x = String(a || '0').split('-')[0].split('.').map(Number);
  const y = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};
let hostOldShown = false;
// 电脑上的软件太旧：弹一次，告诉怎么更新（每次打开页面最多一次）
function hostTooOld(why) {
  if (hostOldShown) return;
  hostOldShown = true;
  sheet((s) => {
    s.innerHTML = `<h3>请更新电脑上的软件</h3><p class="sub">${esc(why)}</p><p class="sub">在电脑上打开 Claude 远程助手，点左下角的「设置」→「检查更新」，更新到最新版并重启。更新后这里会自动连上。</p>`;
    const acts = el('div', 'acts');
    const ok = el('button', 'btn primary', '知道了');
    ok.onclick = closeSheet;
    acts.appendChild(ok);
    s.appendChild(acts);
  });
}

async function refreshInfo() {
  const r = await call('info');
  if (r.ok === false) return;
  info = r;
  if (verOlder(r.hostVersion, NEED_HOST)) hostTooOld(`「${pair.name}」上的 Claude 远程助手${r.hostVersion ? '是 ' + r.hostVersion + '，' : '版本'}比较旧，手机上的部分功能用不了。`);
  try { localStorage.setItem('crInfo', JSON.stringify(r)); } catch (_) {}
  if (pair && r.name && r.name !== pair.name) { pair.name = r.name; localStorage.setItem('crPair', JSON.stringify(pair)); }
  renderComposerBar();
  renderDrawerFoot();
  if (view === 'home') renderHome();
}

async function loadList() {
  const r = await call('list');
  if (r.ok === false) return;
  sessions = r.sessions || [];
  groups = r.groups || [];
  try { localStorage.setItem('crList', JSON.stringify({ sessions, groups })); } catch (_) {}
  renderDrawerList();
}

// ---------- 页面骨架 ----------
function boot() {
  const app = $('#app');
  app.innerHTML = '';
  if (pairing) return renderPairing(app);
  if (!pair) return renderPair(app);
  app.innerHTML = `
    <header class="top">
      <button class="ib" id="b-menu" aria-label="对话列表">${ic('menu')}</button>
      <div class="ttl"><button id="b-title"><span></span>${ic('chevD')}</button></div>
      <button class="ib" id="b-new" aria-label="新对话">${ic('compose')}</button>
    </header>
    <div class="banner hidden" id="banner"></div>
    <button class="pend hidden" id="pend"></button>
    <main class="scroll" id="scroll"><div class="thread" id="thread"></div></main>
    <footer class="composer" id="composer">
      <div class="slash hidden" id="slash"></div>
      <button class="tobottom hidden" id="b-bottom" aria-label="回到底部">${ic('down')}</button>
      <div class="cbox">
        <div class="atts hidden" id="atts"></div>
        <textarea id="input" rows="1" placeholder="给 Claude 发消息" enterkeyhint="send"></textarea>
        <div class="crow">
          <button class="cb" id="b-plus" aria-label="添加">${ic('plus')}</button>
          <button class="tag hidden" id="b-plantag">${ic('plan')}计划模式</button>
          <span class="grow"></span>
          <button class="model" id="b-model"><span>模型</span>${ic('chevD')}</button>
          <button class="send" id="b-send" aria-label="发送" disabled>${ic('up')}</button>
        </div>
      </div>
    </footer>
    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer">
      <div class="dh">${spark(24)}<b>Claude 远程助手</b><button class="ib" id="d-grp" aria-label="新建分组">${ic('folderPlus')}</button><button class="ib" id="d-set" aria-label="设置">${ic('gear')}</button></div>
      <button class="dsrv" id="d-srv">${ic('server')}<span></span>${ic('chevD')}</button>
      <label class="dsearch">${ic('search')}<input id="d-search" placeholder="搜索对话" /></label>
      <button class="dnew" id="d-new">${ic('compose')}新对话</button>
      <div class="dlist" id="d-list"></div>
      <div class="dfoot" id="d-foot"></div>
    </aside>`;
  wire();
  goHome();
  connect();
}

function wire() {
  $('#b-menu').onclick = () => drawer(true);
  $('#scrim').onclick = () => drawer(false);
  $('#b-new').onclick = goHome;
  $('#d-new').onclick = () => { drawer(false); goHome(); };
  $('#b-title').onclick = () => { if (view === 'chat' && current && current.sid) chatSheet(); };
  $('#d-search').oninput = (e) => { search = e.target.value.trim().toLowerCase(); renderDrawerList(); };
  $('#b-plus').onclick = plusSheet;
  $('#b-model').onclick = modelSheet;
  $('#b-plantag').onclick = () => setPlan(false);
  $('#b-send').onclick = onSend;
  $('#b-bottom').onclick = () => scrollBottom(true, true);
  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(); renderSendBtn(); renderSlash(); });
  input.addEventListener('keydown', (e) => {
    // 电脑键盘（iPad 外接键盘等）：回车发送，Shift+回车换行；手机软键盘的回车照常换行
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); onSend(); }
  });
  const sc = $('#scroll');
  sc.addEventListener('scroll', () => {
    // 用户自己往上翻了就不再自动滚到底；翻回底部附近恢复
    stick = distBottom() < 80;
    $('#b-bottom').classList.toggle('hidden', distBottom() < 260);
  }, { passive: true });
  $('#d-set').onclick = () => settingsPage();
  $('#d-grp').onclick = () => groupNameSheet(null);
  // 输入法开着时：在消息区往下拖、或者点一下消息区，就收起输入法
  let ky = null;
  sc.addEventListener('touchstart', (e) => { ky = document.activeElement === input ? e.touches[0].clientY : null; }, { passive: true });
  sc.addEventListener('touchmove', (e) => { if (ky != null && e.touches[0].clientY - ky > 14) { input.blur(); ky = null; } }, { passive: true });
  sc.addEventListener('click', (e) => { if (document.activeElement === input && !e.target.closest('button, a, input, textarea, .opt')) input.blur(); });
  $('#d-srv').onclick = serverFilterSheet;
  // 输入法弹出：整个界面贴着可视区域（iOS 会把页面往上推，这里抵消回来），输入框始终在键盘正上方
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const app = $('#app');
      if (!app) return;
      app.style.height = vv.height + 'px';
      app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
      if (stick) scrollBottom(true);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    input.addEventListener('focus', () => setTimeout(fit, 60));
    input.addEventListener('blur', () => setTimeout(fit, 60));
  }
}

// ---------- 手势：从左往右滑打开对话列表，往左滑收起（跟手）；底部弹层往下拖关闭 ----------
let drawerOpen = false;
(function gestures() {
  let g = null;
  const W = () => $('#drawer').offsetWidth || 320;
  const noSwipe = (t) => t.closest && t.closest('pre, table, .atts, textarea, input, .slash, .sheet-wrap, .scan, .page, .eff, .viewer');
  document.addEventListener('touchstart', (e) => {
    if (!pair || e.touches.length !== 1 || !$('#drawer') || noSwipe(e.target)) { g = null; return; }
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), open: drawerOpen, dir: null, p: drawerOpen ? 1 : 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.dir) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.2 && ((!g.open && dx > 0) || (g.open && dx < 0))) {
        g.dir = 'h';
        $('#drawer').style.transition = 'none';
        $('#scrim').style.transition = 'none';
        $('#scrim').classList.add('on');
      } else { g = null; return; }
    }
    e.preventDefault();
    g.p = Math.max(0, Math.min(1, (g.open ? 1 : 0) + dx / W()));
    g.v = dx / Math.max(1, Date.now() - g.t0);
    $('#drawer').style.transform = `translateX(${(g.p - 1) * 102}%)`;
    $('#scrim').style.opacity = g.p;
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (!g || g.dir !== 'h') { g = null; return; }
    const d = $('#drawer');
    const sc = $('#scrim');
    d.style.transition = '';
    sc.style.transition = '';
    d.style.transform = '';
    sc.style.opacity = '';
    const open = g.open ? !(g.p < 0.6 || g.v < -0.35) : g.p > 0.4 || g.v > 0.35;
    g = null;
    drawer(open);
  });
})();

function dragToClose(handle, panel, close, axis = 'y') {
  let g = null;
  handle.addEventListener('touchstart', (e) => {
    if (axis === 'y' && panel.scrollTop > 0) return;
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), d: 0, on: false };
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    const d = axis === 'y' ? dy : dx;
    const other = axis === 'y' ? dx : dy;
    if (!g.on) {
      if (d > 8 && Math.abs(d) > Math.abs(other) * 1.2) { g.on = true; panel.style.transition = 'none'; }
      else if (Math.abs(other) > 8 || d < -8) { g = null; return; }
      else return;
    }
    e.preventDefault();
    g.d = Math.max(0, d);
    panel.style.transform = axis === 'y' ? `translateY(${g.d}px)` : `translateX(${g.d}px)`;
  }, { passive: false });
  handle.addEventListener('touchend', () => {
    if (!g || !g.on) { g = null; return; }
    const v = g.d / Math.max(1, Date.now() - g.t0);
    const size = axis === 'y' ? panel.offsetHeight : panel.offsetWidth;
    panel.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1)';
    if (g.d > size * 0.3 || v > 0.5) {
      panel.style.transform = axis === 'y' ? 'translateY(100%)' : 'translateX(100%)';
      setTimeout(close, 200);
    } else panel.style.transform = '';
    g = null;
  });
}

function drawer(on) {
  drawerOpen = on;
  if (on) document.activeElement && document.activeElement.blur && document.activeElement.blur();
  $('#drawer').classList.toggle('on', on);
  $('#scrim').classList.toggle('on', on);
  if (on) { renderDrawerList(); renderDrawerFoot(); if (hostOnline) { loadList(); refreshInfo(); } }
}

let legacyHidden = false; // 旧配对的提示：点一下收起，下次打开再提示
let replaced = false;     // 上次断开是因为另一台设备用同一个配对连上来了
function renderBanner() {
  const b = $('#banner');
  if (!b) return;
  let text = '';
  let bad = false;
  if (connState === 'connecting') text = '正在连接…';
  else if (connState === 'off' && replaced) { text = '另一台设备正在用这台的配对连接，两台会互相挤掉：在电脑上为这台设备单独「添加手机」再扫一次码。20 秒后重试'; bad = true; }
  else if (connState === 'off') { text = '连接断开，正在重连…'; bad = true; }
  else if (!hostOnline) { text = `「${pair.name}」不在线：电脑上的 Claude 远程助手要开着`; bad = true; }
  else if (v2() && !chan) text = hsTries >= 2 ? '电脑没有回应加密连接：请把电脑上的 Claude 远程助手更新到最新版' : '正在建立加密连接…';
  else if (!v2() && !legacyHidden) text = '这台手机用的是旧的配对方式，建议在电脑「设置 → 远程控制」里点「升级配对」';
  else if (!isApp && !migrateHidden && info && info.page && pageDiffers(info.page)) text = '电脑已改用新的页面地址，这个是旧页面：点这里看怎么换';
  b.textContent = text;
  b.className = 'banner' + (bad ? ' bad' : '') + (text ? '' : ' hidden');
  b.onclick = hostOnline && !v2() ? () => { legacyHidden = true; renderBanner(); } : text.startsWith('电脑已改用新的页面地址') ? () => migrateSheet(info.page) : null;
  renderDrawerFoot();
}

function setTitle(text, tappable) {
  const t = $('#b-title');
  t.querySelector('span').textContent = text;
  t.querySelector('svg').style.display = tappable ? '' : 'none';
}

// ---------- 首页（新对话） ----------
function goHome() {
  view = 'home';
  current = null;
  setTimeout(renderPendingHint, 0);
  openSteps.clear();
  newCtx.plan = false;
  renderHome();
  renderComposerBar();
  renderSendBtn();
}

function serverOf(id) { return info && info.servers.find((s) => s.id === id); }
function renderHome() {
  if (view !== 'home') return;
  setTitle('新对话', false);
  const h = new Date().getHours();
  const hi = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const srv = serverOf(newCtx.serverId || (info && info.currentServer));
  const box = el('div', 'home', `${spark(46)}<h1>${hi}</h1><p>有什么可以帮你？Claude 会在「${esc(pair.name)}」上工作</p>`);
  if (info) {
    const ctx = el('div', 'ctx');
    if (info.servers.length) {
      const sp = el('button', 'pill', `${ic('server')}<span>${esc(srv ? srv.name : '服务器')}</span>${ic('chevD')}`);
      sp.onclick = serverSheet;
      ctx.appendChild(sp);
    }
    const fp = el('button', 'pill', `${ic('folder')}<span>${esc(newCtx.cwd || (srv ? srv.workdir + '（默认）' : '默认文件夹'))}</span>${ic('chevD')}`);
    fp.onclick = folderSheet;
    ctx.appendChild(fp);
    box.appendChild(ctx);
  }
  const th = $('#thread');
  nodeCache.clear();
  th.innerHTML = '';
  th.appendChild(box);
  $('#b-bottom').classList.add('hidden');
}

function serverSheet() {
  const cur = newCtx.serverId || info.currentServer;
  sheet((s) => {
    s.innerHTML = '<h3>在哪台服务器上运行</h3>';
    for (const x of info.servers) {
      const li = el('button', 'li', `${ic('server')}<div class="tx">${esc(x.name)}<small>${esc(x.workdir)}</small></div>${x.id === cur ? ic('check', 'ck') : ''}`);
      li.onclick = () => { newCtx.serverId = x.id; newCtx.cwd = null; closeSheet(); renderHome(); };
      s.appendChild(li);
    }
  });
}

function folderSheet() {
  const srv = serverOf(newCtx.serverId || info.currentServer);
  sheet((s) => {
    s.innerHTML = '<h3>工作文件夹</h3><p class="sub">Claude 在这个文件夹里读写文件</p>';
    const add = (path, label) => {
      const on = (newCtx.cwd || null) === path;
      const li = el('button', 'li', `${ic('folder')}<div class="tx">${esc(label || path)}${label ? `<small>${esc(srv ? srv.workdir : '')}</small>` : ''}</div>${on ? ic('check', 'ck') : ''}`);
      li.onclick = () => { newCtx.cwd = path; closeSheet(); renderHome(); };
      s.appendChild(li);
    };
    add(null, '默认文件夹');
    for (const d of (srv && srv.dirs) || []) add(d);
    s.appendChild(el('div', 'label', '其他路径'));
    const row = el('div', 'acts');
    const inp = el('input', 'tf');
    inp.placeholder = '/home/me/project 或 ~/project';
    inp.style.flex = '1';
    const go = el('button', 'btn primary', '使用');
    go.style.flex = 'none';
    go.onclick = () => { const v = inp.value.trim(); if (!v) return; newCtx.cwd = v; closeSheet(); renderHome(); };
    row.append(inp, go);
    s.appendChild(row);
  });
}

// ---------- 对话 ----------
async function openChat(sid, keep) {
  drawer(false);
  if (!keep) stick = true;
  setTimeout(renderPendingHint, 0);
  if (!keep || !current || current.sid !== sid) {
    view = 'chat';
    openSteps.clear();
    const s = sessions.find((x) => x.id === sid);
    current = { sid, title: (s && s.title) || '对话', messages: [], offset: 0, running: !!(s && s.running), loading: true };
    renderChat();
    renderComposerBar();
  }
  const r = await call('open', { sid });
  if (!current || current.sid !== sid) return;
  if (r.ok === false) { current.loading = false; renderChat(); toast(r.message || '打开失败'); return; }
  Object.assign(current, { title: r.title, messages: r.messages, offset: r.offset, running: r.running, plan: r.plan, pinned: r.pinned, queue: r.queue || [], loading: false, model: r.model, modelLabel: r.modelLabel, effort: r.effort, efforts: r.efforts });
  renderChat();
  renderComposerBar();
  scrollBottom(true);
}

const mdCache = new Map();
function mdHtml(text) {
  let h = mdCache.get(text);
  if (h == null) {
    h = DOMPurify.sanitize(marked.parse(text || ''));
    mdCache.set(text, h);
    if (mdCache.size > 400) mdCache.delete(mdCache.keys().next().value);
  }
  return h;
}
// 回复里的文件路径（行内代码整段是路径，或者正文里的绝对路径）变成可以点开预览的链接，规则和电脑上一样
let pathRes = null;
function pathRegexes() {
  const ext = (info && info.exts) || 'md|txt|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|gif|webp|svg|html?|json|mp4|mov|mp3|wav|zip';
  if (!pathRes || pathRes.ext !== ext) pathRes = {
    ext,
    code: new RegExp(`^(?:~?/)?[^\\s<>|"'*?]*\\.(?:${ext})$`, 'i'),
    text: new RegExp(`(?:(?:~|/home|/root|/tmp|/srv|/opt|/data|/var|/Users)/)[^\\s<>|"'*?，。；：、）)]*\\.(?:${ext})(?![A-Za-z0-9])`, 'gi'),
  };
  return pathRes;
}
function linkifyPaths(root) {
  const re = pathRegexes();
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return;
    const t = code.textContent.trim();
    if (t.length > 300 || /^https?:/i.test(t) || !re.code.test(t)) return;
    code.replaceWith(fileLink(t, t));
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement.closest('pre, code, a, .flink')) continue;
    re.text.lastIndex = 0;
    if (re.text.test(n.nodeValue)) hits.push(n);
  }
  for (const n of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.nodeValue.replace(re.text, (m, at) => {
      frag.appendChild(document.createTextNode(n.nodeValue.slice(last, at)));
      frag.appendChild(fileLink(m, m));
      last = at + m.length;
    });
    frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
    n.replaceWith(frag);
  }
}
const extOf = (p) => (String(p).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const kindOf = (p) => {
  const e = extOf(p);
  if (/^(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/.test(e)) return 'image';
  if (/^(mp4|mov|m4v|webm)$/.test(e)) return 'video';
  if (/^(mp3|wav|m4a|aac|ogg|flac)$/.test(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (/^html?$/.test(e)) return 'html';
  if (/^(md|markdown)$/.test(e)) return 'md';
  if (e === 'csv') return 'csv';
  if (/^(txt|log|json|ya?ml|xml|ini|toml|conf|sh|py|js|ts|tsx|jsx|java|go|rs|c|cpp|h|css|sql|kt|swift|rb|php|vue)$/.test(e)) return 'text';
  if (/^(xlsx?|numbers)$/.test(e)) return 'sheet';
  return 'file';
};
const KIND_ICO = { image: 'image', video: 'film', audio: 'film', sheet: 'table', csv: 'table' };
function fileLink(path, text) {
  const a = el('button', 'flink', `${ic(KIND_ICO[kindOf(path)] || 'file')}<span>${esc(text)}</span>`);
  a.onclick = (e) => { e.stopPropagation(); openViewer(path); };
  return a;
}

function md(text) {
  const d = el('div', 'md', mdHtml(text));
  linkifyPaths(d);
  d.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  d.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', 'cp', '复制');
    b.onclick = () => copyText(pre.innerText.replace(/复制$/, ''));
    pre.appendChild(b);
  });
  return d;
}

// 流式回复：新到的文字按帧逐步显示出来（像打字一样连续），不是一段一段地跳
const stream = { key: '', shown: 0, el: null, text: '', raf: 0, last: 0 };
function streamEl(key, text) {
  const d = el('div', 'md');
  if (stream.key !== key) { stream.key = key; stream.shown = Math.max(0, text.length - 40); }
  stream.el = d;
  stream.text = text;
  stream.shown = Math.min(stream.shown, text.length);
  d.innerHTML = DOMPurify.sanitize(marked.parse(text.slice(0, stream.shown)));
  return d;
}
function pumpStream() {
  if (stream.raf || !stream.el) return;
  const step = (t) => {
    stream.raf = 0;
    if (!stream.el || !stream.el.isConnected) return;
    const gap = stream.text.length - stream.shown;
    if (gap <= 0) return;
    if (t - stream.last >= 33) {
      stream.last = t;
      // 落后得越多走得越快，保证跟得上又不突兀
      stream.shown += Math.max(2, Math.ceil(gap / 12));
      stream.shown = Math.min(stream.shown, stream.text.length);
      stream.el.innerHTML = DOMPurify.sanitize(marked.parse(stream.text.slice(0, stream.shown)));
      if (stick) scrollBottom(true);
    }
    stream.raf = requestAnimationFrame(step);
  };
  stream.raf = requestAnimationFrame(step);
}

function distBottom() { const v = $('#scroll'); return v ? v.scrollHeight - v.scrollTop - v.clientHeight : 0; }
function scrollBottom(force, smooth) {
  const v = $('#scroll');
  if (!v) return;
  if (force || distBottom() < 140) v.scrollTo({ top: v.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

const TOOL_ICON = { Bash: 'terminal', Read: 'file', Write: 'file', Edit: 'pencil', MultiEdit: 'pencil', NotebookEdit: 'pencil', Glob: 'search', Grep: 'search', LS: 'folder', WebSearch: 'globe', WebFetch: 'globe', Task: 'agent', Agent: 'agent', TodoWrite: 'plan' };
const toolIcon = (name) => (/^mcp__/.test(name || '') ? 'plug' : TOOL_ICON[name] || 'agent');

// 文件改动的差异（和电脑端 diff.js 同一套算法）：按行做最长公共子序列，太长就整段删 + 整段加
function diffLines(a, b) {
  const x = String(a || '').split('\n');
  const y = String(b || '').split('\n');
  if (x.length === 1 && x[0] === '') x.length = 0;
  if (y.length === 1 && y[0] === '') y.length = 0;
  if (x.length > 300 || y.length > 300) return x.map((s) => ['-', s]).concat(y.map((s) => ['+', s]));
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  while (i < n) out.push(['-', x[i++]]);
  while (j < m) out.push(['+', y[j++]]);
  return out;
}
function renderChange(c) {
  const box = el('div', 'tdiff');
  const groups = c.whole != null ? [{ ops: diffLines('', c.whole), whole: true }] : (c.edits || []).map((e) => ({ ops: diffLines(e.o, e.n), all: e.all }));
  groups.forEach((g, gi) => {
    if (gi) box.appendChild(el('div', 'dl sep', '<span class="dg"></span><span class="dt">⋯</span>'));
    if (g.all) box.appendChild(el('div', 'dl note', '<span class="dg"></span><span class="dt">替换文件里所有相同的地方</span>'));
    const ops = g.whole && g.ops.length > 120 ? g.ops.slice(0, 120) : g.ops;
    for (const [t, s] of ops) box.appendChild(el('div', 'dl ' + (t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'), `<span class="dg">${t === ' ' ? '' : t}</span><span class="dt">${esc(s) || ' '}</span>`));
    if (ops.length < g.ops.length) box.appendChild(el('div', 'dl note', `<span class="dg"></span><span class="dt">…还有 ${g.ops.length - ops.length} 行</span>`));
  });
  return box;
}
// 一个工具在跑还是已经结束：后台任务以任务的状态为准（命令放到后台后，工具本身马上就返回了）
const stepStatus = (b) => (b.task ? (b.task.status === 'running' ? 'running' : b.task.status === 'done' || b.task.status === 'completed' ? 'ok' : b.task.status === 'stopped' ? 'err' : b.status) : b.status);
function stepLine(b) {
  if ((b.name === 'Agent' || b.name === 'Task') && stepStatus(b) === 'running' && b.sub && b.sub.length) {
    const cur = b.sub[b.sub.length - 1];
    return `${b.label}：${b.summary || ''} · 正在${cur.label}${cur.summary ? ' ' + cur.summary : ''}`;
  }
  return `${b.label}${b.summary ? '：' + b.summary : ''}`;
}
// 点开一步看到的内容：命令和输出 / 子助手的每一步和结论 / 文件或网址和结果
function stepDetail(b) {
  const box = el('div', 'sd');
  if (b.cmd) box.appendChild(el('pre', 'sh-cmd', '<span>$</span> ' + esc(b.cmd)));
  if (b.prompt) box.appendChild(el('div', 'sd-p', esc(b.prompt)));
  if (b.model) box.appendChild(el('div', 'sd-m', '模型：' + esc(b.model)));
  if (b.sub && b.sub.length) {
    const ul = el('div', 'sd-sub');
    if (b.subCount > b.sub.length) ul.appendChild(el('div', 'sd-more', `前面还有 ${b.subCount - b.sub.length} 步`));
    for (const x of b.sub) ul.appendChild(el('div', 'row', `<i class="st ${esc(x.status || 'ok')}"></i><b>${esc(x.label)}</b><span>${esc(x.summary || '')}</span>`));
    box.appendChild(ul);
  }
  if (b.subText) { const t = el('div', 'sd-txt'); t.appendChild(md(b.subText)); box.appendChild(t); }
  if (b.detail && !b.cmd) box.appendChild(el('div', 'sd-p mono', esc(b.detail)));
  if (b.file) { const pv = el('button', 'btn sd-prev', `${ic('eye')}预览这个文件`); pv.onclick = () => openViewer(b.file); box.appendChild(pv); }
  if (b.change) box.appendChild(renderChange(b.change));
  if (b.task) {
    const tk = b.task;
    const label = tk.status === 'running' ? (tk.kind === 'agent' ? '在后台运行中' : '命令在后台运行中') : '后台任务已结束';
    box.appendChild(el('div', 'sd-task', `<i class="st ${tk.status === 'running' ? 'running' : 'ok'}"></i>${label}${tk.progress ? ' · ' + esc(tk.progress) : ''}`));
    if (tk.summary) box.appendChild(el('pre', 'sd-out', esc(tk.summary)));
  }
  if (b.preview && !(b.subText && b.preview.trim() === b.subText.trim())) box.appendChild(el('pre', 'sd-out', esc(b.preview)));
  if (!box.children.length) box.appendChild(el('div', 'sd-p', '没有更多内容'));
  return box;
}

function renderSteps(list, key) {
  const box = el('div', 'steps' + (openSteps.has(key) ? ' open' : ''));
  // 标题优先显示正在干活的那一步（一直挂着的后台命令排在后面）
  const running = list.find((b) => stepStatus(b) === 'running' && !b.task) || list.find((b) => stepStatus(b) === 'running');
  const last = running || list[list.length - 1];
  const labels = [...new Set(list.map((b) => b.label))];
  const text = running ? stepLine(running) : list.length > 1 ? labels.slice(0, 3).join('、') + (labels.length > 3 ? ' 等' : '') + ` · ${list.length} 步` : stepLine(list[0]);
  const head = el('button', 'sh', `<span class="ico">${ic(toolIcon(last.name))}</span><span class="sl">${esc(text)}</span>${running ? '<i class="st running"></i>' : ''}${ic('chevR', 'chev')}`);
  head.onclick = () => { if (openSteps.has(key)) openSteps.delete(key); else openSteps.add(key); box.classList.toggle('open'); };
  box.appendChild(head);
  const body = el('div', 'sb');
  list.forEach((b, i) => {
    const pk = key + ':' + i;
    const st = stepStatus(b);
    const row = el('button', 'step' + (openPreview.has(pk) ? ' open' : ''), `<div class="row"><i class="st ${esc(st || 'ok')}"></i><b>${esc(b.label)}</b><span>${esc(b.summary || '')}</span>${b.task && b.task.status === 'running' ? '<em class="bg">后台</em>' : ''}${b.sub && b.subCount ? `<em class="bg">${b.subCount} 步</em>` : ''}${ic('chevR', 'chev')}</div>`);
    row.onclick = () => { if (openPreview.has(pk)) openPreview.delete(pk); else openPreview.add(pk); uiVer++; renderChat(); };
    body.appendChild(row);
    if (openPreview.has(pk)) body.appendChild(stepDetail(b));
  });
  box.appendChild(body);
  return box;
}

function renderUser(m) {
  const w = el('div', 'm-user');
  if (m.files && m.files.length) {
    const fs = el('div', 'm-files');
    for (const f of m.files) {
      const name = typeof f === 'string' ? f : f.name;
      const thumb = typeof f === 'object' && f.thumb;
      const chip = el(f.path ? 'button' : 'span', 'fchip' + (f.path ? ' tap' : ''), `${thumb ? `<img src="${esc(thumb)}" alt="" />` : `<span class="fi">${ic('file')}</span>`}<span>${esc(name)}</span>`);
      if (f.path) chip.onclick = (e) => { e.stopPropagation(); openViewer(f.path, name); }; // 发出去的附件：点一下预览
      fs.appendChild(chip);
    }
    w.appendChild(fs);
  }
  if (m.text) w.appendChild(el('div', 'bubble', esc(m.text)));
  if (m.merged) w.appendChild(el('div', 'mtag', '回复途中发的，Claude 在下一步读到'));
  return w;
}

// 这一轮生成的文件：点一下在手机上预览
const fmtSize = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
function renderOutputs(list, other) {
  const box = el('div', 'outs');
  box.appendChild(el('div', 'outs-h', `${ic('folder')}<span>本轮生成的文件</span><em>${list.length}</em>`));
  for (const f of list) {
    const name = f.rel.split('/').pop();
    const dir = f.rel.includes('/') ? f.rel.slice(0, -name.length - 1) : '';
    const row = el('button', 'orow', `<span class="oi">${ic(KIND_ICO[kindOf(name)] || 'file')}</span><span class="on"><b>${esc(name)}</b>${dir ? `<small>${esc(dir)}</small>` : ''}</span><span class="os">${fmtSize(f.size)}</span>${ic('chevR', 'chev')}`);
    row.onclick = () => openViewer(f.path, name);
    box.appendChild(row);
  }
  if (other) box.appendChild(el('div', 'outs-o', `另有 ${other} 个脚本、缓存等程序文件，在电脑上查看`));
  return box;
}

function renderAi(m, idx, isLast) {
  const w = el('div', 'm-ai');
  let run = [];
  const flush = (bi) => { if (run.length) { w.appendChild(renderSteps(run, `${idx}:${bi}`)); run = []; } };
  const lastText = isLast && current.running ? (m.blocks || []).map((b, bi) => (b.type === 'text' ? bi : -1)).filter((x) => x >= 0).pop() : -1;
  (m.blocks || []).forEach((b, bi) => {
    if (b.type === 'tool') { run.push(b); return; }
    flush(bi);
    if (b.type === 'text' && bi === lastText) w.appendChild(streamEl(`${current.sid}:${idx}:${bi}`, b.text));
    else if (b.type === 'text') w.appendChild(md(b.text));
    else if (b.type === 'ask') w.appendChild(askCard(b));
    else if (b.type === 'plan') w.appendChild(planCard(b));
    else if (b.type === 'perm') w.appendChild(permCard(b));
  });
  flush('end');
  if (m.outputs && m.outputs.length) w.appendChild(renderOutputs(m.outputs, m.otherOutputs));
  if (m.error) w.appendChild(el('div', 'm-err', esc(m.error)));
  const busy = isLast && current.running;
  if (busy) {
    const hasText = (m.blocks || []).some((b) => b.type === 'text');
    const waitingYou = (m.blocks || []).some((b) => (b.type === 'ask' || b.type === 'plan' || b.type === 'perm') && b.state === 'pending');
    if (!waitingYou) w.appendChild(el('div', 'thinking', `${spark(22, true)}${hasText ? '' : '<span>思考中…</span>'}`));
  } else {
    const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (text) {
      const acts = el('div', 'm-acts');
      const cp = el('button', '', ic('copy'));
      cp.setAttribute('aria-label', '复制');
      cp.onclick = () => copyText(text);
      acts.appendChild(cp);
      w.appendChild(acts);
    }
  }
  return w;
}

// 只重画有变化的消息（按内容签名比对），其余的 DOM 原样保留：流式回复时不再整页闪动
let uiVer = 0;
let stick = true;
const nodeCache = new Map(); // 消息序号 → { sig, node }
function renderChat() {
  if (view !== 'chat' || !current) return;
  setTitle(current.title || '对话', true);
  const th = $('#thread');
  const keepTop = $('#scroll').scrollTop;
  if (current.loading && !current.messages.length) { nodeCache.clear(); th.innerHTML = ''; th.appendChild(el('div', 'empty', spark(30, true))); return; }
  const n = current.messages.length;
  const want = [];
  if (current.offset > 0) {
    let more = th.querySelector(':scope > .more');
    if (!more) {
      more = el('button', 'more');
      more.onclick = async () => {
        const sc = $('#scroll');
        const before = sc.scrollHeight;
        const r = await call('open', { sid: current.sid, before: current.offset });
        if (r.ok === false) return toast(r.message);
        current.messages = [...r.messages, ...current.messages];
        current.offset = r.offset;
        renderChat();
        sc.scrollTop = sc.scrollHeight - before;
      };
    }
    more.textContent = `加载更早的 ${current.offset} 条消息`;
    want.push(more);
  }
  const live = new Set();
  current.messages.forEach((m, k) => {
    const idx = current.offset + k;
    const isLast = k === n - 1;
    const sig = JSON.stringify(m) + '|' + (isLast && current.running ? 1 : 0) + '|' + uiVer;
    const key = current.sid + ':' + idx;
    live.add(key);
    let c = nodeCache.get(key);
    if (!c || c.sig !== sig) {
      c = { sig, node: m.role === 'user' ? renderUser(m) : renderAi(m, idx, isLast) };
      nodeCache.set(key, c);
    }
    want.push(c.node);
  });
  // 排队中的消息：Claude 这一轮结束后电脑会自动发出，在那之前可以撤回
  for (const q of current.queue || []) {
    const key = 'q:' + q.id + ':' + q.text;
    let c = nodeCache.get(key);
    if (!c) {
      const w = el('div', 'm-user queued');
      if (q.files && q.files.length) w.appendChild(el('div', 'm-files', q.files.map((f) => `<span class="fchip"><span class="fi">${ic('file')}</span><span>${esc(f)}</span></span>`).join('')));
      if (q.text) w.appendChild(el('div', 'bubble', esc(q.text)));
      const bar = el('div', 'qbar', `<span>${ic('refresh')}排队中，这一轮回复完自动发出</span>`);
      const back = el('button', '', '撤回');
      back.onclick = async () => {
        const r = await call('unqueue', { sid: current.sid, qid: q.id });
        if (r.ok === false) return toast(r.message);
        const input = $('#input');
        if (!input.value.trim()) { input.value = q.text || ''; autoGrow(); renderSendBtn(); }
        current.queue = (current.queue || []).filter((x) => x.id !== q.id);
        renderChat();
        toast('已撤回，内容放回输入框');
      };
      bar.appendChild(back);
      w.appendChild(bar);
      c = { node: w };
      nodeCache.set(key, c);
    }
    live.add(key);
    want.push(c.node);
  }
  for (const k of nodeCache.keys()) if (!live.has(k)) nodeCache.delete(k);
  // 按顺序摆好：已经在正确位置的节点不动
  want.forEach((node, i) => { if (th.children[i] !== node) th.insertBefore(node, th.children[i] || null); });
  while (th.children.length > want.length) th.lastChild.remove();
  if (stick) scrollBottom(true);
  else $('#scroll').scrollTop = keepTop;
  renderSendBtn();
  pumpStream();
}

// ---------- 提问 / 计划 ----------
function askCard(b) {
  const pending = b.state === 'pending';
  const c = el('div', 'card' + (pending ? ' live' : ''));
  const tag = { answered: '已回答', skipped: '已跳过', expired: '已失效' }[b.state] || '';
  c.appendChild(el('div', 'ch', `${ic('list')}<span>${pending ? 'Claude 想请你做个选择' : 'Claude 的提问'}</span>${tag ? `<em>${tag}</em>` : ''}`));
  const picks = (askPicks[b.requestId] = askPicks[b.requestId] || {});
  (b.questions || []).forEach((q) => {
    c.appendChild(el('div', 'q', esc(q.question)));
    const opts = el('div', 'opts');
    const chosen = pending ? picks[q.question] || [] : String((b.answers || {})[q.question] || '').split(', ');
    (q.options || []).forEach((o) => {
      const btn = el('button', 'opt' + (chosen.includes(o.label) ? ' on' : ''), `${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}`);
      if (pending) btn.onclick = () => {
        const cur = picks[q.question] || [];
        picks[q.question] = q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
        uiVer++;
        renderChat();
      };
      opts.appendChild(btn);
    });
    if (pending) {
      const other = el('input', 'opt');
      other.placeholder = '都不合适？自己写';
      other.value = (picks['__other__' + q.question] || '');
      other.oninput = () => { picks['__other__' + q.question] = other.value; };
      opts.appendChild(other);
    }
    c.appendChild(opts);
  });
  if (pending) {
    const acts = el('div', 'acts');
    const skip = el('button', 'btn', '跳过');
    const go = el('button', 'btn primary', '提交');
    skip.onclick = () => answerAsk(b, true);
    go.onclick = () => answerAsk(b, false);
    acts.append(skip, go);
    c.appendChild(acts);
  }
  return c;
}
async function answerAsk(b, skip) {
  const picks = askPicks[b.requestId] || {};
  const answers = {};
  if (!skip) for (const q of b.questions || []) {
    const parts = [...(picks[q.question] || [])];
    const other = String(picks['__other__' + q.question] || '').trim();
    if (other) parts.push(other);
    if (!parts.length) return toast('还有问题没选');
    answers[q.question] = parts.join(', ');
  }
  const r = await call('ask', { sid: current.sid, requestId: b.requestId, answers, skip });
  if (r.ok === false) toast(r.message || '提交失败');
}

function planCard(b) {
  const pending = b.state === 'pending';
  const c = el('div', 'card' + (pending ? ' live' : ''));
  const tag = { approved: '已批准', rejected: '已打回', expired: '已失效' }[b.state] || '';
  c.appendChild(el('div', 'ch', `${ic('plan')}<span>${pending ? 'Claude 写好了计划，等你批准' : 'Claude 的计划'}</span>${tag ? `<em>${tag}</em>` : ''}`));
  const body = el('div', 'plan-body');
  body.appendChild(md(b.text || ''));
  c.appendChild(body);
  if (pending) {
    const acts = el('div', 'acts');
    const no = el('button', 'btn', '打回修改');
    const go = el('button', 'btn primary', '按计划开始');
    const answer = async (approve) => { const r = await call('plan', { sid: current.sid, requestId: b.requestId, approve }); if (r.ok === false) toast(r.message); };
    no.onclick = () => answer(false);
    go.onclick = () => answer(true);
    acts.append(no, go);
    c.appendChild(acts);
  }
  return c;
}

// 默认 / 自动模式下等你允许的一步操作
function permCard(b) {
  const pending = b.state === 'pending';
  const c = el('div', 'card' + (pending ? ' live' : ''));
  const tag = { allowed: '已允许', denied: '已拒绝', expired: '已失效' }[b.state] || '';
  c.appendChild(el('div', 'ch', `${ic('terminal')}<span>${pending ? `Claude 想要「${esc(b.label || b.name)}」，等你允许` : `Claude 请求「${esc(b.label || b.name)}」`}</span>${tag ? `<em>${tag}</em>` : ''}`));
  if (b.detail) c.appendChild(el('pre', 'perm-detail', esc(b.detail)));
  if (b.reason) c.appendChild(el('div', 'perm-reason', esc(b.reason)));
  if (pending) {
    const acts = el('div', 'acts');
    const no = el('button', 'btn', '拒绝');
    const ok = el('button', 'btn primary', '允许');
    const answer = async (allow) => { ok.disabled = no.disabled = true; const r = await call('perm', { sid: current.sid, requestId: b.requestId, allow }); if (r.ok === false) { toast(r.message); ok.disabled = no.disabled = false; } };
    no.onclick = () => answer(false);
    ok.onclick = () => answer(true);
    acts.append(no, ok);
    c.appendChild(acts);
  }
  return c;
}

// ---------- 电脑推过来的变化 ----------
function applyPatch(msg, p) {
  if (msg.role !== 'assistant' || !Array.isArray(msg.blocks)) return false;
  if (p.f) { for (const k of Object.keys(msg)) if (k !== 'blocks') delete msg[k]; Object.assign(msg, p.f); }
  msg.blocks.length = Math.min(msg.blocks.length, p.bn);
  for (const c of p.ch) {
    if (c.b) msg.blocks[c.bi] = c.b;
    else {
      const b = msg.blocks[c.bi];
      if (!b || b.type !== 'text' || b.text.length + c.add.length !== c.len) return false;
      msg.blocks[c.bi] = { ...b, text: b.text + c.add };
    }
  }
  if (msg.blocks.length !== p.bn || msg.blocks.some((x) => !x)) return false;
  return true;
}

function onPush(m) {
  if (m.push === 'list') {
    sessions = m.sessions || sessions;
    if (m.groups) groups = m.groups;
    renderDrawerList();
    return;
  }
  if (m.push === 'msgs' && view === 'chat' && current && m.sid === current.sid) {
    let gap = false;
    for (const it of m.items) {
      const k = it.i - current.offset;
      if (k < 0) continue;
      if (it.p) {
        // 差异：在手机上已有的那条消息上补；对不上（比如中间断过线）就整个重新打开
        const cur = current.messages[k];
        if (!cur || !applyPatch(cur, it.p)) gap = true;
      } else if (k < current.messages.length) current.messages[k] = it.m;
      else if (k === current.messages.length) current.messages.push(it.m);
      else gap = true;
    }
    if (m.n - current.offset < current.messages.length) current.messages.length = Math.max(0, m.n - current.offset);
    if (gap || m.n - current.offset > current.messages.length) { openChat(current.sid, true); return; }
    current.running = m.running;
    if (m.title) current.title = m.title;
    current.plan = m.plan;
    if (m.queue) current.queue = m.queue;
    renderChat();
    renderComposerBar();
    return;
  }
  if (m.push === 'tail' && view === 'chat' && current && m.sid === current.sid) {
    const k = m.i - current.offset;
    if (k > current.messages.length || k < 0) { openChat(current.sid, true); return; }
    current.messages.splice(k, current.messages.length - k, ...m.ms);
    current.running = m.running;
    if (m.title) current.title = m.title;
    current.plan = m.plan;
    renderChat();
    renderComposerBar();
  }
}

// ---------- 输入框 ----------
function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(170, t.scrollHeight) + 'px';
}
const planOn = () => (view === 'chat' ? !!(current && current.plan) : newCtx.plan);
// 模型按对话各记各的：在对话里看的是这个对话的，新对话页看的是默认
const modelCtx = () => (view === 'chat' && current && current.model ? current : info);
function renderComposerBar() {
  if (!$('#b-model')) return;
  $('#b-plantag').classList.toggle('hidden', !planOn());
  const mc = modelCtx();
  const e = mc && mc.effort ? ' · ' + (((info || {}).effortNames || {})[mc.effort] || mc.effort) : '';
  $('#b-model span').textContent = mc ? mc.modelLabel + e : '模型';
  renderSendBtn();
}
function renderSendBtn() {
  const b = $('#b-send');
  if (!b) return;
  const text = $('#input').value.trim();
  const ready = atts.filter((a) => a.status === 'done').length;
  const busy = atts.some((a) => a.status === 'uploading');
  const stop = view === 'chat' && current && current.running && !text && !atts.length;
  b.classList.toggle('stop', !!stop);
  b.innerHTML = stop ? ic('stop') : ic('up');
  b.disabled = !stop && (busy || (!text && !ready));
}

async function onSend() {
  const input = $('#input');
  const text = input.value.trim();
  if (view === 'chat' && current && current.running && !text && !atts.length) {
    const r = await call('stop', { sid: current.sid });
    if (r.ok === false) toast(r.message);
    return;
  }
  if (atts.some((a) => a.status === 'uploading')) return toast('文件还在上传');
  const files = atts.filter((a) => a.status === 'done').map((a) => a.remote);
  if (!text && !files.length) return;
  const sentAtts = atts;
  input.value = '';
  atts = [];
  autoGrow();
  renderAtts();
  renderSlash();
  const args = { sid: view === 'chat' && current ? current.sid : null, text, files };
  if (!args.sid) Object.assign(args, { serverId: newCtx.serverId, cwd: newCtx.cwd, plan: newCtx.plan });
  const r = await call('send', args);
  if (r.ok === false) {
    toast(r.message || '发送失败');
    input.value = text;
    atts = sentAtts;
    autoGrow();
    renderAtts();
    return;
  }
  sentAtts.forEach((a) => a.url && URL.revokeObjectURL(a.url));
  if (r.queued) toast('已排队，这一轮回复完会自动发出');
  stick = true;
  if (!args.sid && r.sid) { newCtx.cwd = null; newCtx.plan = false; await openChat(r.sid); }
  else scrollBottom(true);
}

// 斜杠命令：输入 / 时列出 Claude Code 的命令和 Skill
function renderSlash() {
  const box = $('#slash');
  const v = $('#input').value;
  const m = /^\/(\S*)$/.exec(v);
  const cmds = (info && info.commands) || [];
  if (!m || !cmds.length) { box.classList.add('hidden'); return; }
  const q = m[1].toLowerCase();
  const list = cmds.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)).slice(0, 40);
  if (!list.length) { box.classList.add('hidden'); return; }
  box.innerHTML = '';
  for (const c of list) {
    const b = el('button', '', `<b>/${esc(c.name)}</b>${c.desc ? `<small>${esc(c.desc)}</small>` : ''}`);
    b.onclick = () => { const i = $('#input'); i.value = '/' + c.name + ' '; i.focus(); renderSlash(); renderSendBtn(); };
    box.appendChild(b);
  }
  box.classList.remove('hidden');
}

// ---------- 附件：分块加密传给电脑，由电脑上传到服务器 ----------
const CHUNK = 192 * 1024;
let attSeq = 0;
function renderAtts() {
  const box = $('#atts');
  box.innerHTML = '';
  box.classList.toggle('hidden', !atts.length);
  for (const a of atts) {
    const t = el('div', 'att', a.url ? `<img src="${a.url}" alt="" />` : `<span>${ic('file')}</span><span class="nm">${esc(a.name)}</span>`);
    if (a.status === 'uploading') t.appendChild(el('div', 'pg', Math.round(a.progress * 100) + '%'));
    if (a.status === 'error') t.appendChild(el('div', 'pg err', '失败'));
    const x = el('button', 'x', ic('x'));
    x.onclick = () => { a.cancel = true; atts = atts.filter((y) => y !== a); if (a.url) URL.revokeObjectURL(a.url); renderAtts(); };
    t.appendChild(x);
    box.appendChild(t);
  }
  renderSendBtn();
}

// 大照片先缩到长边 2560、JPEG 0.86，经中转传得快很多
async function shrink(file) {
  if (!/^image\/(jpeg|png|heic|heif|webp)$/i.test(file.type) || file.size < 1.5 * 1048576) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (_) { return file; }
}

async function addFiles(list) {
  for (const raw of list) {
    const a = { id: ++attSeq, name: raw.name || '文件', status: 'uploading', progress: 0, url: /^image\//.test(raw.type) ? URL.createObjectURL(raw) : '' };
    atts.push(a);
    renderAtts();
    upload(a, raw);
  }
}
async function upload(a, raw) {
  const f = await shrink(raw);
  a.name = f.name || a.name;
  const begin = await call('upload-begin', { name: a.name, size: f.size, sid: view === 'chat' && current ? current.sid : null, serverId: newCtx.serverId || null });
  if (begin.ok === false) { a.status = 'error'; renderAtts(); return toast(begin.message); }
  const buf = new Uint8Array(await f.arrayBuffer());
  for (let off = 0; off < buf.length; off += CHUNK) {
    if (a.cancel) return;
    const r = await call('upload-chunk', { uploadId: begin.uploadId, data: b64.enc(buf.subarray(off, off + CHUNK)) }, 60000);
    if (r.ok === false) { a.status = 'error'; renderAtts(); return toast(r.message); }
    a.progress = Math.min(0.95, (off + CHUNK) / buf.length);
    renderAtts();
  }
  const end = await call('upload-end', { uploadId: begin.uploadId }, 180000);
  if (a.cancel) return;
  if (end.ok === false) { a.status = 'error'; renderAtts(); return toast(end.message); }
  a.status = 'done';
  a.remote = { name: end.name, remotePath: end.remotePath, promptPath: end.promptPath, size: end.size };
  renderAtts();
}

function pickFiles(accept, capture) {
  const inp = el('input');
  inp.type = 'file';
  inp.multiple = !capture;
  if (accept) inp.accept = accept;
  if (capture) inp.setAttribute('capture', 'environment');
  inp.onchange = () => { if (inp.files.length) addFiles([...inp.files]); };
  inp.click();
}

// ---------- 底部弹层 ----------
function sheet(fill) {
  closeSheet();
  const wrap = el('div', 'sheet-wrap');
  const s = el('div', 'sheet');
  wrap.appendChild(s);
  wrap.onclick = (e) => { if (e.target === wrap) closeSheet(); };
  document.body.appendChild(wrap);
  const body = el('div');
  s.append(el('div', 'grab'), body);
  fill(body);
  dragToClose(s, s, closeSheet);
  return body;
}
function closeSheet() { document.querySelectorAll('.sheet-wrap').forEach((x) => x.remove()); }

function switchRow(label, on, onChange, iconName) {
  const li = el('button', 'li', `${ic(iconName)}<div class="tx">${label}</div><span class="sw${on ? ' on' : ''}"></span>`);
  li.onclick = () => { const sw = li.querySelector('.sw'); sw.classList.toggle('on'); onChange(sw.classList.contains('on')); };
  return li;
}

async function setPlan(on) {
  if (view === 'chat' && current && current.sid) {
    const r = await call('planmode', { sid: current.sid, on });
    if (r.ok === false) return toast(r.message);
    current.plan = on;
  } else newCtx.plan = on;
  renderComposerBar();
  toast(on ? '计划模式：Claude 先写方案，你批准后才动手' : '已退出计划模式');
}

function plusSheet() {
  sheet((s) => {
    const items = [['camera', '拍照', () => pickFiles('image/*', true)], ['image', '照片', () => pickFiles('image/*')], ['file', '文件', () => pickFiles('')]];
    for (const [i, t, f] of items) {
      const li = el('button', 'li', `${ic(i)}<div class="tx">${t}</div>`);
      li.onclick = () => { closeSheet(); f(); };
      s.appendChild(li);
    }
    s.appendChild(el('div', 'sep'));
    s.appendChild(switchRow('计划模式<small>先出方案，批准后再动手</small>', planOn(), (on) => setPlan(on), 'plan'));
  });
}

async function modelSheet() {
  if (!info) { await refreshInfo(); if (!info) return toast('电脑不在线'); }
  sheet((s) => fillModel(s));
}
// 模型列表 + 思考强度滑动条（拖动吸附到档位，松手生效），弹层和设置页共用
function fillModel(s, onDone) {
  const mc = modelCtx();
  const inChat = mc !== info;
  const sid = inChat ? current.sid : undefined;
  // 改了之后：对话里改的只记在这个对话上，新对话页改的是默认
  const applied = (r) => { if (inChat && current && current.sid === sid) Object.assign(current, { model: r.model, modelLabel: r.modelLabel, effort: r.effort, efforts: r.efforts }); else info = r; };
  s.innerHTML = `<h3>模型</h3><p class="sub">${inChat ? '只改这个对话，之后的回复都用这个' : '新对话的默认模型，每个对话可以各自再改'}</p>`;
  const list = info.models.length ? info.models : [{ value: mc.model, label: mc.modelLabel, desc: '', efforts: mc.efforts }];
  for (const m of list) {
    const li = el('button', 'li', `<div class="tx">${esc(m.label)}${m.desc ? `<small>${esc(m.desc)}</small>` : ''}</div>${m.value === mc.model ? ic('check', 'ck') : ''}`);
    li.onclick = async () => { const r = await call('model', { model: m.value, sid }); if (r.ok === false) return toast(r.message); applied(r); renderComposerBar(); fillModel(s, onDone); if (onDone) onDone(); };
    s.appendChild(li);
  }
  if (!mc.efforts || !mc.efforts.length) return;
  const levels = ['', ...mc.efforts];
  const name = (e) => (e ? (info.effortNames || {})[e] || e : '默认');
  let idx = Math.max(0, levels.indexOf(mc.effort || ''));
  const box = el('div', 'eff');
  box.innerHTML = `<div class="eff-h"><span>思考强度</span><b></b></div><div class="eff-track"><div class="eff-fill"></div>${levels.map((_, i) => `<i style="left:${(i / (levels.length - 1)) * 100}%"></i>`).join('')}<div class="eff-knob"></div></div><div class="eff-labels">${levels.map((e, i) => `<span style="left:${(i / (levels.length - 1)) * 100}%">${esc(name(e))}</span>`).join('')}</div><p class="eff-tip">越往右想得越久、越费额度</p>`;
  s.appendChild(box);
  const track = box.querySelector('.eff-track');
  const paint = () => {
    const pct = (idx / (levels.length - 1)) * 100;
    box.querySelector('.eff-fill').style.width = pct + '%';
    box.querySelector('.eff-knob').style.left = pct + '%';
    box.querySelector('.eff-h b').textContent = name(levels[idx]);
    box.querySelectorAll('.eff-labels span').forEach((x, i) => x.classList.toggle('on', i === idx));
  };
  paint();
  const at = (x) => {
    const r = track.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (levels.length - 1));
  };
  let dragging = false;
  const move = (x) => { const n = at(x); if (n !== idx) { idx = n; paint(); if (navigator.vibrate) navigator.vibrate(5); } };
  const commit = async () => {
    if ((mc.effort || '') === levels[idx]) return;
    const r = await call('model', { effort: levels[idx], sid });
    if (r.ok === false) return toast(r.message);
    applied(r);
    renderComposerBar();
    if (onDone) onDone();
  };
  box.addEventListener('touchstart', (e) => { dragging = true; move(e.touches[0].clientX); }, { passive: true });
  box.addEventListener('touchmove', (e) => { if (dragging) { e.preventDefault(); move(e.touches[0].clientX); } }, { passive: false });
  box.addEventListener('touchend', () => { if (dragging) { dragging = false; commit(); } });
  box.addEventListener('mousedown', (e) => { dragging = true; move(e.clientX); const up = () => { dragging = false; window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', up); commit(); }; const mm = (ev) => move(ev.clientX); window.addEventListener('mousemove', mm); window.addEventListener('mouseup', up); });
}

function sessionActions(s, { onRenamed } = {}) {
  sheet((b) => {
    b.innerHTML = `<h3>${esc(s.title || '对话')}</h3>`;
    const rename = el('button', 'li', `${ic('pencil')}<div class="tx">重命名</div>`);
    rename.onclick = () => renameSheet(s, onRenamed);
    const pin = el('button', 'li', `${ic('pin')}<div class="tx">${s.pinned ? '取消置顶' : '置顶'}</div>`);
    pin.onclick = async () => { closeSheet(); const r = await call('pin', { sid: s.id }); if (r.ok === false) return toast(r.message); s.pinned = r.pinned; toast(r.pinned ? '已置顶' : '已取消置顶'); loadList(); };
    const move = el('button', 'li', `${ic('move')}<div class="tx">移到分组<small>${esc(((groups.find((g) => g.id === s.groupId) || {}).name) || '未分组')}</small></div>`);
    move.onclick = () => moveSheet(s);
    b.append(rename, pin, move);
    if (view === 'chat' && current && current.sid === s.id) b.appendChild(switchRow('计划模式<small>先出方案，批准后再动手</small>', !!current.plan, (on) => setPlan(on), 'plan'));
    b.appendChild(el('div', 'sep'));
    const del = el('button', 'li danger', `${ic('trash')}<div class="tx">删除对话</div>`);
    del.onclick = () => sheet((c) => {
      c.innerHTML = `<h3>删除「${esc(s.title)}」？</h3><p class="sub">只删除电脑上的这条记录，服务器上的会话文件还在，删除后不能恢复。</p>`;
      const acts = el('div', 'acts');
      const no = el('button', 'btn', '取消');
      const yes = el('button', 'btn primary', '删除');
      no.onclick = closeSheet;
      yes.onclick = async () => {
        const r = await call('delete', { sid: s.id });
        if (r.ok === false) return toast(r.message);
        closeSheet();
        toast('已删除');
        if (current && current.sid === s.id) goHome();
        loadList();
      };
      acts.append(no, yes);
      c.appendChild(acts);
    });
    b.appendChild(del);
  });
}
// ---------- 分组：新建 / 改名 / 删除 / 把对话移进去（直接改电脑上的分组） ----------
function groupNameSheet(g, then) {
  sheet((b) => {
    b.innerHTML = `<h3>${g ? '重命名分组' : '新建分组'}</h3>`;
    const inp = el('input', 'tf');
    inp.value = g ? g.name : '';
    inp.placeholder = '分组名称，比如：工作、个人项目';
    b.appendChild(inp);
    const acts = el('div', 'acts');
    const ok = el('button', 'btn primary', g ? '保存' : '新建');
    ok.onclick = async () => {
      const name = inp.value.trim();
      if (!name) return toast('分组名不能为空');
      const r = await call(g ? 'group-rename' : 'group-create', g ? { gid: g.id, name } : { name });
      if (r.ok === false) return toast(r.message);
      if (r.groups) groups = r.groups;
      closeSheet();
      renderDrawerList();
      toast(g ? '已改名' : `已新建「${name}」`);
      if (then) then(r.gid);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) ok.click(); });
    acts.appendChild(ok);
    b.appendChild(acts);
    setTimeout(() => { inp.focus(); inp.select(); }, 250);
  });
}
function groupSheet(g) {
  sheet((b) => {
    const n = sessions.filter((s) => s.groupId === g.id).length;
    b.innerHTML = `<h3>${esc(g.name)}</h3><p class="sub">${n ? n + ' 个对话' : '空分组'}</p>`;
    const ren = el('button', 'li', `${ic('pencil')}<div class="tx">重命名</div>`);
    ren.onclick = () => groupNameSheet(g);
    const del = el('button', 'li danger', `${ic('trash')}<div class="tx">删除分组<small>里面的对话移到「未分组」，不会被删除</small></div>`);
    del.onclick = async () => {
      const r = await call('group-delete', { gid: g.id });
      if (r.ok === false) return toast(r.message);
      if (r.groups) groups = r.groups;
      closeSheet();
      toast(`已删除分组「${g.name}」`);
      loadList();
    };
    b.append(ren, el('div', 'sep'), del);
  });
}
function moveSheet(s) {
  const doMove = async (gid) => {
    const r = await call('move', { sid: s.id, gid });
    if (r.ok === false) return toast(r.message);
    s.groupId = gid;
    s.pinned = false;
    closeSheet();
    const g = groups.find((x) => x.id === gid);
    toast(g ? `已移到「${g.name}」` : '已移到「未分组」');
    loadList();
  };
  sheet((b) => {
    b.innerHTML = `<h3>移到分组</h3><p class="sub">${esc(s.title || '对话')}</p>`;
    const add = (gid, name) => {
      const li = el('button', 'li', `${ic('folder')}<div class="tx">${esc(name)}</div>${(s.groupId || null) === gid && !s.pinned ? ic('check', 'ck') : ''}`);
      li.onclick = () => doMove(gid);
      b.appendChild(li);
    };
    for (const g of groups) add(g.id, g.name);
    add(null, '未分组');
    b.appendChild(el('div', 'sep'));
    const nw = el('button', 'li', `${ic('folderPlus')}<div class="tx">新建分组并移进去</div>`);
    nw.onclick = () => groupNameSheet(null, (gid) => { if (gid) doMove(gid); });
    b.appendChild(nw);
  });
}

function renameSheet(s, done) {
  sheet((b) => {
    b.innerHTML = '<h3>重命名</h3>';
    const inp = el('input', 'tf');
    inp.value = s.title || '';
    b.appendChild(inp);
    const acts = el('div', 'acts');
    const ok = el('button', 'btn primary', '保存');
    ok.onclick = async () => {
      const title = inp.value.trim();
      if (!title) return toast('名字不能为空');
      const r = await call('rename', { sid: s.id, title });
      if (r.ok === false) return toast(r.message);
      s.title = title;
      if (current && current.sid === s.id) { current.title = title; setTitle(title, true); }
      closeSheet();
      loadList();
      if (done) done();
    };
    acts.appendChild(ok);
    b.appendChild(acts);
    setTimeout(() => { inp.focus(); inp.select(); }, 250);
  });
}
function chatSheet() {
  const s = sessions.find((x) => x.id === current.sid) || { id: current.sid, title: current.title, pinned: current.pinned };
  sessionActions(s);
}

// ---------- 抽屉：对话列表 ----------
// 对话列表按服务器筛选（只影响手机上看哪台，不改电脑上的当前服务器）；新对话也默认放到这台
const viewServer = () => prefs.server || '';
function serverFilterSheet() {
  if (!info) return toast('电脑不在线');
  sheet((s) => {
    s.innerHTML = '<h3>服务器</h3><p class="sub">看哪台服务器上的对话，新对话也默认在这台运行</p>';
    const add = (id, name, sub) => {
      const li = el('button', 'li', `${ic('server')}<div class="tx">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>${viewServer() === id ? ic('check', 'ck') : ''}`);
      li.onclick = () => { prefs.server = id; savePrefs(); newCtx.serverId = id || null; newCtx.cwd = null; closeSheet(); renderDrawerList(); renderHome(); if (document.querySelector('.page')) settingsPage(true); };
      s.appendChild(li);
    };
    add('', '全部服务器', '');
    for (const x of info.servers) add(x.id, x.name, x.workdir + (x.id === info.currentServer ? ' · 电脑当前在用' : ''));
  });
}
function renderServerChip() {
  const b = $('#d-srv');
  if (!b) return;
  const srv = viewServer() && serverOf(viewServer());
  b.querySelector('span').textContent = srv ? srv.name : '全部服务器';
  b.classList.toggle('hidden', !info || info.servers.length < 2);
}
function renderDrawerList() {
  const box = $('#d-list');
  if (!box) return;
  box.innerHTML = '';
  renderServerChip();
  const vs = viewServer() && serverOf(viewServer()) ? viewServer() : '';
  const vsName = vs ? serverOf(vs).name : '';
  // 旧版电脑端的列表里没有服务器编号：按服务器名字对
  const list = sessions.filter((s) => (!search || (s.title || '').toLowerCase().includes(search)) && (!vs || (s.serverId ? s.serverId === vs : s.server === vsName)));
  const multi = !vs && info && info.servers.length > 1;
  const item = (s) => {
    const sub = s.pending ? (s.pending === 'plan' ? '计划写好了，等你批准' : '在等你做选择') : s.running ? '回复中…' : fmtTime(s.updatedAt) + (multi ? ' · ' + s.server : '');
    const it = el('button', 'ditem' + (current && current.sid === s.id ? ' on' : '') + (s.pending ? ' waiting' : ''), `<div class="t"><b>${esc(s.title || '新对话')}</b><span>${esc(sub)}</span></div>${s.pending ? `<em class="ptag">${s.pending === 'plan' ? '待批准' : '待选择'}</em>` : s.running ? '<i class="run"></i>' : s.unread ? `<i class="dot ${esc(s.unread)}"></i>` : ''}`);
    it.onclick = () => openChat(s.id);
    let timer = null;
    it.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = 'fired'; sessionActions(s); }, 520); }, { passive: true });
    it.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
    it.addEventListener('touchend', (e) => { if (timer === 'fired') e.preventDefault(); clearTimeout(timer); });
    it.addEventListener('contextmenu', (e) => { e.preventDefault(); sessionActions(s); });
    return it;
  };
  // 分组标题：点一下收起 / 展开（只记在这台手机上），右边「⋯」改名或删除；空的分组也显示，方便往里移
  const collapsed = new Set(prefs.collapsed || []);
  const section = (title, arr, key, g) => {
    if (!arr.length && !g) return;
    const closed = !search && collapsed.has(key);
    const gi = key === '__pinned' ? 'pin' : g ? 'folder' : 'list';
    const head = el('div', 'dsec' + (g ? ' grp' : ''), `<button class="dsh">${ic('chevD', 'dchev' + (closed ? ' closed' : ''))}<span class="dgi">${ic(gi)}</span><span class="dgn">${esc(title)}</span><em>${arr.length || ''}</em></button>`);
    head.querySelector('.dsh').onclick = () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      prefs.collapsed = [...collapsed];
      savePrefs();
      renderDrawerList();
    };
    if (g) {
      const more = el('button', 'dmore', ic('dots'));
      more.onclick = () => groupSheet(g);
      head.appendChild(more);
    }
    box.appendChild(head);
    if (!closed) {
      // 组里的对话放进一个缩进的框里，左边一条竖线，一眼看出归哪个组
      const body = el('div', 'dbody');
      arr.forEach((s) => body.appendChild(item(s)));
      if (g && !arr.length && !search) body.appendChild(el('div', 'dempty', '还没有对话：长按一个对话，选「移到分组」'));
      if (body.children.length) box.appendChild(body);
    }
  };
  section('置顶', list.filter((s) => s.pinned), '__pinned');
  const rest = list.filter((s) => !s.pinned);
  for (const g of groups) if (!g.fixed) section(g.name, rest.filter((s) => s.groupId === g.id), g.id, search ? null : g);
  const known = new Set(groups.map((g) => g.id));
  section(groups.some((g) => !g.fixed) ? '未分组' : '最近', rest.filter((s) => !s.groupId || !known.has(s.groupId)), '__none');
  // 「历史版本」（编辑前、回退前另存的，和没用过的分支）放最后
  for (const g of groups) if (g.fixed) section(g.name, rest.filter((s) => s.groupId === g.id), g.id, null);
  if (!list.length) box.appendChild(el('div', 'empty', search ? '没有找到' : hostOnline ? '还没有对话' : '等电脑上线…'));
  renderPendingHint();
}

// 别的对话在等你做选择：菜单按钮上闪一个点，顶部给一条可以点的提醒
function renderPendingHint() {
  const others = sessions.filter((s) => s.pending && !(view === 'chat' && current && current.sid === s.id));
  const menu = $('#b-menu');
  if (menu) menu.classList.toggle('alert', others.length > 0);
  const h = $('#pend');
  if (!h) return;
  h.classList.toggle('hidden', !others.length);
  if (!others.length) return;
  h.innerHTML = `<i></i><span>${others.length > 1 ? `${others.length} 个对话在等你处理` : `「${esc(others[0].title || '新对话')}」${others[0].pending === 'plan' ? '的计划等你批准' : '在等你选择'}`}</span>${ic('chevR')}`;
  h.onclick = () => openChat(others[0].id);
}

const WIN_LABEL = { five_hour: '5 小时', seven_day: '本周', seven_day_opus: 'Opus 本周', seven_day_sonnet: 'Sonnet 本周', seven_day_overage_included: 'Fable 本周' };
function resetText(sec) {
  if (!sec) return '';
  const left = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  const d = Math.floor(left / 1440);
  const h = Math.floor((left % 1440) / 60);
  return '还剩 ' + (d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${left % 60} 分钟` : `${left % 60} 分钟`) + ' 重置';
}
function renderDrawerFoot() {
  const f = $('#d-foot');
  if (!f || !pair) return;
  f.innerHTML = '';
  // 底部只占一行：电脑状态 + 两个小圆环（5 小时 / 本周额度）；点开设置页看完整额度和重置时间
  const w = info && info.usage && info.usage.windows;
  const ring = (k, label) => {
    if (!w || !w[k]) return '';
    const p = Math.min(100, Math.round((w[k].utilization || 0) * 100));
    const cls = p >= 90 ? 'full' : p >= 70 ? 'warn' : '';
    return `<span class="qr ${cls}" title="${label}"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><circle class="v" cx="10" cy="10" r="8" style="stroke-dasharray:${(p / 100) * 50.27} 50.27"/></svg>${p}%</span>`;
  };
  const pc = el('button', 'pc', `<i class="st${hostOnline ? ' on' : ''}"></i><b>${esc(pair.name)}</b>${ring('five_hour', '5 小时额度')}${ring('seven_day', '本周额度')}${ic('gear', 'pg')}`);
  pc.onclick = () => settingsPage();
  f.appendChild(pc);
}

// ---------- 设置页（从右边滑进来，往右滑或点返回关闭） ----------
function settingsPage(refresh) {
  let page = document.querySelector('.page');
  if (!page) {
    if (refresh) return;
    drawer(false);
    page = el('div', 'page');
    document.body.appendChild(page);
    requestAnimationFrame(() => page.classList.add('on'));
    if (hostOnline) refreshInfo().then(() => settingsPage(true));
  }
  const close = () => { page.classList.remove('on'); setTimeout(() => page.remove(), 260); };
  page.innerHTML = `<header class="top"><button class="ib" id="p-back" aria-label="返回">${ic('back')}</button><div class="ttl"><button><span>设置</span></button></div><span class="ib"></span></header>`;
  const body = el('div', 'pbody');
  page.appendChild(body);
  page.querySelector('#p-back').onclick = close;
  dragToClose(page, page, () => page.remove(), 'x');
  const sec = (title) => { body.appendChild(el('div', 'psec', esc(title))); const g = el('div', 'pgroup'); body.appendChild(g); return g; };
  const row = (g, icon, title, value, onClick) => {
    const r = el(onClick ? 'button' : 'div', 'prow', `${ic(icon)}<span class="pt">${esc(title)}</span><span class="pv">${value}</span>${onClick ? ic('chevR', 'pc') : ''}`);
    if (onClick) r.onclick = onClick;
    g.appendChild(r);
    return r;
  };
  const segRow = (g, icon, title, opts, cur, onPick) => {
    const r = el('div', 'prow col', `<div class="prt">${ic(icon)}<span class="pt">${esc(title)}</span></div>`);
    const seg = el('div', 'pseg');
    for (const [v, t] of opts) {
      const b = el('button', v === cur ? 'on' : '', esc(t));
      b.onclick = () => { onPick(v); settingsPage(true); };
      seg.appendChild(b);
    }
    r.appendChild(seg);
    g.appendChild(r);
  };

  const pc = sec('电脑');
  row(pc, 'computer', pair.name, `<i class="dotst${hostOnline ? ' on' : ''}"></i>${hostOnline ? '在线' : connState === 'on' ? '不在线' : '连接中'}`, null);
  row(pc, 'refresh', '重新连接', '', () => { if (ws) ws.close(); connect(); toast('正在重新连接'); });
  // 加密方式和页面来源：让人知道现在信任的是谁
  row(pc, 'key', '加密', v2() ? '一次性配对 · 每次连接换密钥' : '<span class="warnt">旧的配对方式，建议在电脑上「升级配对」</span>', null);
  row(pc, 'globe', '页面来源', isApp ? '打包在 App 里' : relayBase() !== location.origin ? '安全模式：' + esc(location.host) : '快速模式：中转服务器', null);

  const cl = sec('Claude');
  if (info) {
    const vs = viewServer() && serverOf(viewServer());
    if (info.servers.length) row(cl, 'server', '服务器', esc(vs ? vs.name : '全部服务器'), serverFilterSheet);
    const e = info.effort ? ' · ' + ((info.effortNames || {})[info.effort] || info.effort) : '';
    row(cl, 'agent', '模型和思考强度', esc(info.modelLabel + e), () => sheet((s) => fillModel(s, () => settingsPage(true))));
    const w = info.usage && info.usage.windows;
    if (w) {
      const keys = ['five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet'].filter((k) => w[k]);
      if (keys.length) {
        const q = sec('额度');
        const box = el('div', 'prow col quota');
        for (const k of keys) {
          const p = Math.round((w[k].utilization || 0) * 100);
          box.insertAdjacentHTML('beforeend', `<span>${WIN_LABEL[k] || k}</span><span class="bar"><i class="${p >= 90 ? 'full' : p >= 70 ? 'warn' : ''}" style="width:${Math.min(100, p)}%"></i></span><span>${p}%</span><small>${esc(resetText(w[k].resetsAt))}</small>`);
        }
        q.appendChild(box);
      }
    }
  } else row(cl, 'info', '电脑不在线时看不到这些设置', '', null);

  const look = sec('显示');
  segRow(look, 'sun', '外观', [['', '跟随系统'], ['light', '浅色'], ['dark', '深色']], prefs.theme || '', (v) => { prefs.theme = v; savePrefs(); applyPrefs(); });
  segRow(look, 'text', '文字大小', [['s', '小'], ['m', '标准'], ['l', '大'], ['xl', '特大']], prefs.size || 'm', (v) => { prefs.size = v; savePrefs(); applyPrefs(); });

  const dev = sec('这台手机');
  row(dev, 'scan', '换一台电脑（重新扫码）', '', () => { close(); startScan(); });
  row(dev, 'key', '粘贴配对链接', '', () => { close(); codeSheet(); });
  const out = row(dev, 'out', '取消配对', '', () => sheet((c) => {
    c.innerHTML = '<h3>取消配对？</h3><p class="sub">这台手机会忘掉电脑的密钥，要再用需要在电脑上重新添加手机。</p>';
    const acts = el('div', 'acts');
    const no = el('button', 'btn', '取消');
    const yes = el('button', 'btn primary', '取消配对');
    no.onclick = closeSheet;
    yes.onclick = () => { closeSheet(); page.remove(); unpair('已取消配对'); };
    acts.append(no, yes);
    c.appendChild(acts);
  }));
  out.classList.add('danger');

  body.appendChild(el('p', 'pfoot', `Claude 远程助手 · 手机端${relayVersion ? ' ' + esc(relayVersion) : ''}<br>内容在手机和电脑之间端到端加密，中转服务器只转发、解不开`));
}

function deviceSheet() {
  sheet((s) => {
    s.innerHTML = `<h3>${esc(pair.name)}</h3><p class="sub">${hostOnline ? '在线：可以在手机上操作电脑上的对话' : '不在线：电脑上的 Claude 远程助手要开着，并且在「设置 → 远程控制」里连上了中转'}</p>`;
    const re = el('button', 'li', `${ic('refresh')}<div class="tx">刷新</div>`);
    re.onclick = () => { closeSheet(); if (ws) ws.close(); connect(); };
    const scanAgain = el('button', 'li', `${ic('scan')}<div class="tx">换一台电脑（重新扫码）</div>`);
    scanAgain.onclick = () => { closeSheet(); startScan(); };
    const out = el('button', 'li danger', `${ic('out')}<div class="tx">取消配对</div>`);
    out.onclick = () => { closeSheet(); unpair('已取消配对'); };
    s.append(re, scanAgain, el('div', 'sep'), out);
  });
}

// ---------- 配对中（第 2 版）：把配对请求发给电脑，等你在电脑上核对数字 ----------
function renderPairing(app) {
  const p = pairing;
  const box = el('div', 'pair pairing', `${spark(54)}<h1>在电脑上核对数字</h1><p class="pst">正在连接「${esc(p.pair.name)}」…</p><div class="pin">${esc(p.code)}</div><p>电脑上会弹出同样的 4 位数字，一样就在电脑上点「一样，配对」。</p>`);
  const cancel = el('button', 'btn', '取消');
  cancel.onclick = () => endPairing('');
  box.appendChild(cancel);
  app.appendChild(box);
  if (!ws || ws.readyState > 1) connect();
}
function pairStatus(text) { const e = $('.pairing .pst'); if (e) e.textContent = text; }
function endPairing(msg) {
  pairing = null;
  if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch (_) {} }
  if (msg) toast(msg, 4500);
  boot();
}
function sendPairRequest() {
  if (!pairing || pairing.state !== 'wait' || !ws || ws.readyState !== 1) return;
  pairing.state = 'sent';
  try { ws.send(JSON.stringify({ t: 'msg', box: pairing.box })); } catch (_) {}
  pairStatus(`已经发给「${pairing.pair.name}」，请看电脑屏幕`);
}
function onPairFrame(f) {
  if (f.t === 'ok') { relayVersion = f.version || ''; if (f.hostOnline) sendPairRequest(); else pairStatus(`「${pairing.pair.name}」不在线：电脑上的 Claude 远程助手要开着，并且连上了中转`); }
  else if (f.t === 'host-online') sendPairRequest();
  else if (f.t === 'host-offline' && pairing.state === 'wait') pairStatus(`「${pairing.pair.name}」不在线：电脑上的 Claude 远程助手要开着，并且连上了中转`);
  else if (f.t === 'revoked') endPairing('电脑上已经没有这台手机了：在电脑上重新点「添加手机」');
  else if (f.t === 'msg') {
    const box = String(f.box || '');
    if (box === 'X2') return endPairing('二维码已经失效（5 分钟内有效，只能用一次）：在电脑上重新生成一个');
    const r = crE2E.phone.pairResult(pairing.pair, box);
    if (!r) return;
    if (!r.ok) return endPairing('电脑上没有通过配对：要配对的话在电脑上重新生成二维码');
    pair = { ...pairing.pair, name: r.name || pairing.pair.name };
    localStorage.setItem('crPair', JSON.stringify(pair));
    ['crInfo', 'crList'].forEach((k) => localStorage.removeItem(k));
    info = null; sessions = []; groups = [];
    const name = pair.name;
    pairing = null;
    if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch (_) {} }
    toast('已配对「' + name + '」', 3000);
    boot();
    setTimeout(() => installHint(true), 900); // 刚配好：教一下怎么加到主屏幕
  }
}

// ---------- 配对页 ----------
function renderPair(app) {
  const box = el('div', 'pair', `${spark(54)}<h1>连接你的电脑</h1><p>在电脑上打开 Claude 远程助手，进入「设置 → 远程控制」，点「添加手机」。</p>`);
  const scanBtn = el('button', 'btn primary', `${ic('scan')}扫描二维码`);
  scanBtn.onclick = startScan;
  const codeBtn = el('button', 'btn', `${ic('key')}粘贴配对链接`);
  codeBtn.onclick = codeSheet;
  box.append(scanBtn, codeBtn);
  box.appendChild(el('ol', '', '<li>扫码：对准电脑上弹出的二维码（5 分钟内有效，只能用一次）</li><li>扫不了：在电脑上点「复制链接」，发到手机上粘贴进来</li><li>配好后用浏览器的「添加到主屏幕」，以后像 App 一样打开</li>'));
  app.appendChild(box);
}

function codeSheet() {
  sheet((s) => {
    s.innerHTML = '<h3>粘贴配对链接</h3><p class="sub">在电脑上点「复制链接」，把那一整条粘贴到这里</p>';
    const ta = el('textarea', 'tf');
    ta.placeholder = '粘贴配对链接';
    ta.autocapitalize = 'off';
    ta.spellcheck = false;
    s.appendChild(ta);
    const acts = el('div', 'acts');
    const ok = el('button', 'btn primary', '连接');
    ok.onclick = () => { if (applyPairText(ta.value)) { closeSheet(); boot(); } };
    acts.appendChild(ok);
    s.appendChild(acts);
  });
}

// 页面里直接调起后置摄像头扫码（jsQR 解码），不依赖系统相机能不能识别网址
let scanStream = null;
async function startScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(location.protocol === 'https:' ? '这个浏览器不支持调用摄像头，请用配对码' : '页面不是 HTTPS，浏览器不允许调用摄像头，请用配对码', 4000);
    return codeSheet();
  }
  if (!window.jsQR) {
    // 识别二维码的库比较大，只在要扫码时才下载
    toast('正在准备扫码…', 1500);
    const ok = await new Promise((res) => { const sc = document.createElement('script'); sc.src = 'vendor/jsQR.js'; sc.onload = () => res(true); sc.onerror = () => res(false); document.head.appendChild(sc); });
    if (!ok || !window.jsQR) { toast('扫码组件下载失败，请用配对码'); return codeSheet(); }
  }
  const ov = el('div', 'scan', `<video playsinline muted autoplay></video><div class="frame"></div><div class="tip">对准电脑上的二维码</div><button class="close" aria-label="关闭">${ic('x')}</button><button class="alt">输入配对码</button>`);
  document.body.appendChild(ov);
  const stop = () => { if (scanStream) scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; ov.remove(); };
  ov.querySelector('.close').onclick = stop;
  ov.querySelector('.alt').onclick = () => { stop(); codeSheet(); };
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    stop();
    toast(e && e.name === 'NotAllowedError' ? '没有摄像头权限：在浏览器设置里允许这个网站使用相机，或者用配对码' : '打不开摄像头，请用配对码', 4500);
    return codeSheet();
  }
  const video = ov.querySelector('video');
  video.srcObject = scanStream;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = 0;
  const tick = (t) => {
    if (!scanStream) return;
    if (t - last > 120 && video.readyState >= 2 && video.videoWidth) {
      last = t;
      const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        if (/[#&]p=|^[A-Za-z0-9_-]{60,}$/.test(code.data)) {
          stop();
          if (applyPairText(code.data)) boot();
          return;
        }
        ov.querySelector('.tip').textContent = '这不是配对二维码，请扫电脑上「添加手机」弹出的码';
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 从后台回来时刷新
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pair) return;
  // 回到前台：连接多半已经被系统掐了，不等心跳超时，直接检查
  if (ws && ws.readyState === 1 && Date.now() - lastRx > 8000) { try { ws.send('{"t":"ping"}'); } catch (_) {} setTimeout(() => { if (Date.now() - lastRx > 3000 && ws) { const w = ws; w.onclose && w.onclose(); try { w.close(); } catch (_) {} } }, 2500); return; }
  if (!ws || ws.readyState > 1) connect();
  else if (hostOnline) { refreshInfo(); loadList(); if (view === 'chat' && current && current.sid) openChat(current.sid, true); }
});

// ---------- 文件预览：从电脑分块取过来（加密），按类型在手机上直接看；看不了的交给系统（分享 / 存到文件） ----------
const fileCache = new Map(); // 路径 → File（最近几个，来回切不用重新取）
async function fetchFile(path, onProgress) {
  if (fileCache.has(path)) return fileCache.get(path);
  const parts = [];
  let off = 0;
  let size = 0;
  let real = path;
  do {
    const r = await call('file', { path, sid: current && current.sid, offset: off }, 120000);
    if (r.ok === false) throw new Error(r.message || '取文件失败');
    const chunk = b64.dec(r.data || '');
    parts.push(chunk);
    size = r.size;
    real = r.path || path;
    off += chunk.length;
    onProgress && onProgress(size ? off / size : 1);
    if (!chunk.length) break;
  } while (off < size);
  const name = real.split('/').pop();
  const file = new File(parts, name, { type: MIME[extOf(name)] || 'application/octet-stream' });
  fileCache.set(path, file);
  if (fileCache.size > 6) fileCache.delete(fileCache.keys().next().value);
  return file;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };

function csvTable(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const t = el('table');
  rows.forEach((r, i) => { const tr = el('tr'); r.forEach((c) => tr.appendChild(el(i ? 'td' : 'th', '', esc(c)))); t.appendChild(tr); });
  return t;
}

async function openViewer(path, title) {
  const name = title || String(path).split('/').pop();
  const v = el('div', 'viewer');
  v.innerHTML = `<header class="top"><button class="ib" id="v-close" aria-label="关闭">${ic('x')}</button><div class="ttl"><button><span>${esc(name)}</span></button></div><button class="ib" id="v-share" aria-label="分享或保存" disabled>${ic('share')}</button></header><div class="vbody"><div class="vload">${spark(34, true)}<span>正在从服务器取文件…</span></div></div>`;
  document.body.appendChild(v);
  requestAnimationFrame(() => v.classList.add('on'));
  let url = '';
  const close = () => { v.classList.remove('on'); setTimeout(() => { v.remove(); if (url) URL.revokeObjectURL(url); }, 250); };
  v.querySelector('#v-close').onclick = close;
  dragToClose(v.querySelector('.top'), v, () => { v.remove(); if (url) URL.revokeObjectURL(url); });
  const body = v.querySelector('.vbody');
  let file;
  try {
    file = await fetchFile(path, (p) => { const s = v.querySelector('.vload span'); if (s) s.textContent = `正在从服务器取文件 ${Math.round(p * 100)}%`; });
  } catch (e) {
    body.innerHTML = `<div class="vmsg">${ic('info')}<b>打不开这个文件</b><span>${esc(e.message)}</span></div>`;
    return;
  }
  url = URL.createObjectURL(file);
  const share = v.querySelector('#v-share');
  share.disabled = false;
  // 分享：iPhone 上可以用「快速查看」打开 Office 文件、存到「文件」、发给别的应用
  share.onclick = async () => {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: file.name }); } catch (_) {} }
    else { const a = el('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); }
  };
  const kind = kindOf(file.name);
  body.innerHTML = '';
  if (kind === 'image') body.appendChild(pinchZoom(url, file.name));
  else if (kind === 'video') { const vd = el('video'); vd.src = url; vd.controls = true; vd.playsInline = true; body.appendChild(vd); }
  else if (kind === 'audio') { const au = el('audio'); au.src = url; au.controls = true; body.appendChild(el('div', 'vmsg', ic('film') + `<b>${esc(file.name)}</b>`)); body.appendChild(au); }
  else if (kind === 'html') {
    // 生成的网页：放进中转提供的沙盒页里运行（不能直接用 blob，会被手机页的安全策略拦掉脚本）
    const html = await file.text();
    const fr = el('iframe');
    fr.setAttribute('sandbox', 'allow-scripts allow-popups');
    const onMsg = (e) => { if (e.source === fr.contentWindow && e.data && e.data.frameReady) { window.removeEventListener('message', onMsg); fr.contentWindow.postMessage({ html }, '*'); } };
    window.addEventListener('message', onMsg);
    fr.src = 'frame.html';
    body.appendChild(fr);
  } else if (kind === 'pdf') {
    const fr = el('iframe');
    fr.src = url;
    body.appendChild(fr);
    if (kind === 'pdf') body.appendChild(el('div', 'vtip', '只显示了第一页？点右上角的分享按钮，用「快速查看」或「文件」打开'));
  } else if (kind === 'md' || kind === 'text' || kind === 'csv') {
    const text = file.size > 3 * 1048576 ? '文件太大，只显示前 3 MB…\n\n' + (await file.slice(0, 3 * 1048576).text()) : await file.text();
    const box = el('div', 'vtext');
    if (kind === 'md') box.appendChild(md(text));
    else if (kind === 'csv') { box.classList.add('md'); box.appendChild(csvTable(text)); }
    else box.appendChild(el('pre', '', esc(text)));
    body.appendChild(box);
  } else {
    body.innerHTML = `<div class="vmsg">${ic(KIND_ICO[kind] || 'file')}<b>${esc(file.name)}</b><span>${fmtSize(file.size)} · 这种文件网页里看不了</span></div>`;
    const b = el('button', 'btn primary', `${ic('share')}用其他应用打开`);
    b.onclick = share.onclick;
    const box = el('div', 'vact');
    box.appendChild(b);
    box.appendChild(el('span', '', 'iPhone 上选「快速查看」或「存储到文件」'));
    body.appendChild(box);
  }
}

// 图片查看：双指捏合缩放（以两指中点为中心）、放大后单指拖动、双击在适应屏幕和 2.5 倍之间切换
function pinchZoom(url, alt) {
  const box = el('div', 'vimg');
  const img = el('img');
  img.src = url; img.alt = alt || ''; img.draggable = false;
  box.appendChild(img);
  const st = { s: 1, x: 0, y: 0, fit: true };
  const apply = () => { img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.s})`; };
  const fit = () => {
    const W = box.clientWidth, H = box.clientHeight, w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    st.s = Math.min(W / w, H / h); st.x = (W - w * st.s) / 2; st.y = (H - h * st.s) / 2; st.fit = true; apply();
  };
  const clamp = () => {
    // 放大后不让图完全跑出屏幕
    const W = box.clientWidth, H = box.clientHeight, w = img.naturalWidth * st.s, h = img.naturalHeight * st.s;
    st.x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, st.x));
    st.y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, st.y));
  };
  const zoomAt = (factor, cx, cy) => {
    const base = Math.min(box.clientWidth / (img.naturalWidth || 1), box.clientHeight / (img.naturalHeight || 1));
    const ns = Math.max(base, Math.min(base * 8, st.s * factor));
    const k = ns / st.s;
    st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.s = ns; st.fit = ns <= base + 1e-6;
    clamp(); apply();
  };
  img.onload = fit;
  new ResizeObserver(() => { if (st.fit) fit(); }).observe(box);
  let touch = null; // { d, cx, cy } 两指 / { x, y } 单指
  let lastTap = 0;
  const pt = (t) => { const r = box.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [ax, ay] = pt(e.touches[0]), [bx, by] = pt(e.touches[1]);
      touch = { d: Math.hypot(ax - bx, ay - by), cx: (ax + bx) / 2, cy: (ay + by) / 2 };
    } else if (e.touches.length === 1) {
      const [x, y] = pt(e.touches[0]);
      const now = Date.now();
      if (now - lastTap < 300) { if (st.fit) zoomAt(2.5, x, y); else fit(); lastTap = 0; }
      else lastTap = now;
      touch = { x: x - st.x, y: y - st.y };
    }
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!touch) return;
    if (e.touches.length === 2 && touch.d != null) {
      e.preventDefault();
      const [ax, ay] = pt(e.touches[0]), [bx, by] = pt(e.touches[1]);
      const d = Math.hypot(ax - bx, ay - by), cx = (ax + bx) / 2, cy = (ay + by) / 2;
      zoomAt(d / touch.d, cx, cy);
      st.x += cx - touch.cx; st.y += cy - touch.cy; clamp(); apply();
      touch = { d, cx, cy };
    } else if (e.touches.length === 1 && touch.x != null && !st.fit) {
      e.preventDefault(); // 放大状态下单指拖图，不滚动页面
      const [x, y] = pt(e.touches[0]);
      st.x = x - touch.x; st.y = y - touch.y; clamp(); apply();
    }
  }, { passive: false });
  box.addEventListener('touchend', (e) => { if (!e.touches.length) touch = null; else if (e.touches.length === 1) { const [x, y] = pt(e.touches[0]); touch = { x: x - st.x, y: y - st.y }; } }, { passive: true });
  return box;
}

// 禁止双指缩放和双击放大（iOS 不认 user-scalable=no，要在脚本里拦）
document.addEventListener('gesturestart', (e) => e.preventDefault()); // 图片查看器自己处理捏合，不用系统的页面缩放
// 双击放大由 CSS 的 touch-action: manipulation 关掉（不拦 touchend，免得连续点两个按钮时第二下没反应）

// 扫码打开的链接带着配对信息（# 后面不会发给任何服务器）：读出来后马上从地址栏去掉
if (/[#&]p=/.test(location.hash)) { applyPairText(location.href); history.replaceState(null, '', location.pathname); }
if (pair && !pairing) setTimeout(() => installHint(false), 2500);
if (!isApp && 'serviceWorker' in navigator && (location.protocol === 'https:' || /^(127\.0\.0\.1|localhost)$/.test(location.hostname))) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
