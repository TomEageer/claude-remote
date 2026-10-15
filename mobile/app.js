/* global nacl, marked, DOMPurify */
'use strict';

// Claude 远程助手 · 手机端
// 和电脑之间的消息全部加密（tweetnacl secretbox，密钥只在扫码时从电脑那里拿到，中转服务器看不到）。
// 配对信息：电脑上生成的二维码打开的是 https://中转地址/#p=…，# 后面的内容不会发给服务器。

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = { enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }, dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
const b64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const enc = new TextEncoder();
const dec = new TextDecoder();

function toast(text, ms = 2600) {
  const t = el('div', 'toast', esc(text));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- 配对 ----------
let pair = null;
try { pair = JSON.parse(localStorage.getItem('crPair') || 'null'); } catch (_) {}
(function readPairFromUrl() {
  const m = /[#&]p=([^&]+)/.exec(location.hash);
  if (!m) return;
  try {
    const p = JSON.parse(decodeURIComponent(escape(b64url(m[1]))));
    if (p && p.h && p.d && p.k) {
      pair = { host: p.h, device: p.d, key: p.k, name: p.n || '我的电脑' };
      localStorage.setItem('crPair', JSON.stringify(pair));
      toast('已配对「' + pair.name + '」');
    }
  } catch (_) { toast('二维码内容不对，请在电脑上重新生成'); }
  history.replaceState(null, '', location.pathname);
})();

// ---------- 加密通道 ----------
let ws = null;
let hostOnline = false;
let reqSeq = 0;
const waiting = new Map();
const key = () => b64.dec(pair.key);

function seal(obj) {
  const nonce = nacl.randomBytes(24);
  const box = nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, key());
  const out = new Uint8Array(24 + box.length);
  out.set(nonce); out.set(box, 24);
  return b64.enc(out);
}
function open(s) {
  const raw = b64.dec(s);
  const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), key());
  return plain ? JSON.parse(dec.decode(plain)) : null;
}

function setStatus(text, on) {
  const s = $('#status');
  s.textContent = text;
  s.className = on === true ? 'on' : on === false ? 'off' : '';
}

let retry = 0;
function connect() {
  if (!pair) return;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  setStatus('正在连接…');
  ws = new WebSocket(url);
  ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ t: 'client', hostId: pair.host, deviceId: pair.device })); };
  ws.onmessage = (e) => {
    let f;
    try { f = JSON.parse(e.data); } catch (_) { return; }
    if (f.t === 'ok') { hostOnline = !!f.hostOnline; onHostState(); }
    else if (f.t === 'host-online') { hostOnline = true; onHostState(); }
    else if (f.t === 'host-offline') { hostOnline = false; onHostState(); }
    else if (f.t === 'revoked') { ws.onclose = null; unpair('这台手机已被电脑撤销，要再用请在电脑上重新添加'); }
    else if (f.t === 'msg') {
      const m = open(f.box);
      if (!m) return;
      if (m.re != null && waiting.has(m.re)) { waiting.get(m.re)(m); waiting.delete(m.re); }
      else if (m.push) onPush(m);
    }
  };
  ws.onclose = () => {
    hostOnline = false;
    setStatus('连接断开，正在重连…', false);
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
}

function onHostState() {
  if (hostOnline) {
    setStatus((pair.name || '电脑') + ' 在线', true);
    call('hello').then((r) => { if (r && r.name && r.name !== pair.name) { pair.name = r.name; localStorage.setItem('crPair', JSON.stringify(pair)); setStatus(pair.name + ' 在线', true); } });
    route();
  } else setStatus((pair.name || '电脑') + ' 不在线：电脑上的软件要开着', false);
}

function call(op, args = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1 || !hostOnline) return resolve({ ok: false, message: '电脑不在线' });
    const id = ++reqSeq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ t: 'msg', box: seal({ id, op, ...args }) }));
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ ok: false, message: '电脑没有回应' }); } }, 20000);
  });
}

function unpair(msg) {
  localStorage.removeItem('crPair');
  pair = null;
  if (ws) { ws.onclose = null; ws.close(); }
  toast(msg || '已取消配对');
  render();
}

// ---------- 页面 ----------
let view = 'list';
let current = null; // { sid, title, messages, total, running }
const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

function render() {
  const v = $('#view');
  $('#back').classList.toggle('hidden', view !== 'chat');
  $('#newchat').classList.toggle('hidden', !pair || view === 'chat');
  $('#composer').classList.toggle('hidden', !pair || view !== 'chat');
  if (!pair) {
    $('#title b').textContent = 'Claude 远程助手';
    setStatus('');
    v.innerHTML = `<div class="empty"><h2>还没有配对电脑</h2>
      <ol><li>电脑上打开 Claude 远程助手</li><li>设置 →「远程控制」→「添加手机」</li><li>用手机相机扫出现的二维码</li></ol>
      <p>扫码后会自动打开这个页面并完成配对。之后可以用浏览器的「添加到主屏幕」，像 App 一样打开。</p></div>`;
    return;
  }
  if (view === 'list') renderList();
  else renderChat();
}

async function route() {
  if (view === 'chat' && current) await openChat(current.sid, true);
  else await loadList();
}

let sessions = [];
async function loadList() {
  const r = await call('list');
  if (r.ok === false) return;
  sessions = r.sessions || [];
  if (view === 'list') renderList();
}

function renderList() {
  $('#title b').textContent = pair.name || 'Claude 远程助手';
  const v = $('#view');
  if (!hostOnline && !sessions.length) { v.innerHTML = '<div class="empty"><span class="spin"></span><p>等电脑上线…</p></div>'; return; }
  const box = el('div', 'list');
  const groups = {};
  for (const s of sessions) (groups[s.server || '对话'] = groups[s.server || '对话'] || []).push(s);
  for (const [name, list] of Object.entries(groups)) {
    box.appendChild(el('div', 'sec', esc(name)));
    for (const s of list) {
      const row = el('div', 'row', `<div class="t"><b>${esc(s.title || '新对话')}</b><span>${s.running ? '回复中…' : esc(fmtTime(s.updatedAt))}</span></div>${s.running ? '<span class="spin"></span>' : s.unread ? `<span class="dot ${esc(s.unread)}"></span>` : ''}`);
      row.onclick = () => openChat(s.id);
      box.appendChild(row);
    }
  }
  if (!sessions.length) box.appendChild(el('div', 'empty', '还没有对话，点右上角 + 开始'));
  v.innerHTML = '';
  v.appendChild(box);
}

async function openChat(sid, keepScroll) {
  view = 'chat';
  if (!keepScroll || !current || current.sid !== sid) {
    current = { sid, title: (sessions.find((s) => s.id === sid) || {}).title || '对话', messages: [], loading: true };
    render();
  }
  if (!sid) { current.loading = false; render(); return; }
  const r = await call('open', { sid });
  if (r.ok === false) { toast(r.message || '打开失败'); return; }
  current = { sid, title: r.title, messages: r.messages, offset: r.offset, running: r.running, loading: false };
  render();
  scrollBottom(true);
}

function scrollBottom(force) {
  const v = $('#view');
  if (force || v.scrollHeight - v.scrollTop - v.clientHeight < 120) v.scrollTop = v.scrollHeight;
}

function md(text) {
  const d = el('div', 'md');
  d.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  d.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return d;
}

function renderMsg(m, i) {
  if (m.role === 'user') {
    const w = el('div', 'msg user');
    if (m.files && m.files.length) w.appendChild(el('div', 'files', '附件：' + m.files.map(esc).join('、')));
    if (m.text) w.appendChild(el('div', 'bubble', esc(m.text)));
    w.appendChild(el('div', 'meta', esc(fmtTime(m.ts))));
    return w;
  }
  const w = el('div', 'msg assistant');
  for (const b of m.blocks || []) {
    if (b.type === 'text') w.appendChild(md(b.text));
    else if (b.type === 'tool') w.appendChild(el('div', 'tool ' + (b.status || ''), `<b>${esc(b.label)}</b><span>${esc(b.summary || '')}</span><i>${b.status === 'running' ? '<span class="spin"></span>' : b.status === 'err' ? '×' : '✓'}</i>`));
    else if (b.type === 'ask') w.appendChild(askCard(b, i));
    else if (b.type === 'plan') w.appendChild(planCard(b));
  }
  if (m.error) w.appendChild(el('div', 'err', esc(m.error)));
  const last = current && i === current.offset + current.messages.length - 1;
  if (last && current.running && !(m.blocks || []).some((b) => b.type === 'text')) w.appendChild(el('div', 'thinking', '<span class="spin"></span>思考中…'));
  if (m.doneAt) w.appendChild(el('div', 'meta', esc(fmtTime(m.doneAt))));
  return w;
}

const askPicks = {};
function askCard(b) {
  const done = b.state !== 'pending';
  const c = el('div', 'card' + (done ? ' done' : ''));
  c.appendChild(el('h4', '', done ? 'Claude 的提问' + ({ answered: '（已回答）', skipped: '（已跳过）', expired: '（已失效）' }[b.state] || '') : 'Claude 想请你做个选择'));
  const picks = (askPicks[b.requestId] = askPicks[b.requestId] || {});
  (b.questions || []).forEach((q) => {
    c.appendChild(el('div', 'q', esc(q.question)));
    const opts = el('div', 'opts');
    (q.options || []).forEach((o) => {
      const on = (picks[q.question] || []).includes(o.label) || (b.answers && String(b.answers[q.question] || '').split(', ').includes(o.label));
      const btn = el('button', 'opt' + (on ? ' on' : ''), `${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}`);
      if (!done) btn.onclick = () => {
        const cur = picks[q.question] || [];
        picks[q.question] = q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
        renderChat();
      };
      opts.appendChild(btn);
    });
    c.appendChild(opts);
  });
  if (!done) {
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
    if (!(picks[q.question] || []).length) return toast('还有问题没选');
    answers[q.question] = picks[q.question].join(', ');
  }
  const r = await call('ask', { sid: current.sid, requestId: b.requestId, answers, skip });
  if (r.ok === false) toast(r.message || '提交失败');
}

function planCard(b) {
  const done = b.state !== 'pending';
  const c = el('div', 'card' + (done ? ' done' : ''));
  c.appendChild(el('h4', '', done ? 'Claude 的计划' + ({ approved: '（已批准）', rejected: '（已打回）', expired: '（已失效）' }[b.state] || '') : 'Claude 写好了计划，等你批准'));
  c.appendChild(md(b.text));
  if (!done) {
    const acts = el('div', 'acts');
    const no = el('button', 'btn', '打回修改');
    const go = el('button', 'btn primary', '按计划开始做');
    no.onclick = async () => { const r = await call('plan', { sid: current.sid, requestId: b.requestId, approve: false }); if (r.ok === false) toast(r.message); };
    go.onclick = async () => { const r = await call('plan', { sid: current.sid, requestId: b.requestId, approve: true }); if (r.ok === false) toast(r.message); };
    acts.append(no, go);
    c.appendChild(acts);
  }
  return c;
}

function renderChat() {
  $('#title b').textContent = current.title || '新对话';
  const v = $('#view');
  const keep = v.scrollTop;
  const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 120;
  v.innerHTML = '';
  const box = el('div', 'chat');
  if (current.loading) box.appendChild(el('div', 'empty', '<span class="spin"></span>'));
  if (current.offset > 0) {
    const more = el('button', 'more', `显示更早的 ${current.offset} 条`);
    more.onclick = async () => {
      const r = await call('open', { sid: current.sid, before: current.offset });
      if (r.ok === false) return;
      current.messages = [...r.messages, ...current.messages];
      current.offset = r.offset;
      renderChat();
    };
    box.appendChild(more);
  }
  if (!current.sid) box.appendChild(el('div', 'empty', '在下面输入第一句话，开始新对话（在电脑当前的服务器和默认文件夹里）'));
  current.messages.forEach((m, k) => box.appendChild(renderMsg(m, current.offset + k)));
  v.appendChild(box);
  v.scrollTop = atBottom ? v.scrollHeight : keep;
  const send = $('#send');
  send.classList.toggle('stop', !!current.running && !$('#input').value.trim());
  send.innerHTML = send.classList.contains('stop') ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
}

// 电脑推送：某个对话的某条消息变了、列表变了
function onPush(m) {
  if (m.push === 'list') { sessions = m.sessions || sessions; if (view === 'list') renderList(); return; }
  if (m.push === 'tail' && current && m.sid === current.sid) {
    // 最后几条消息的快照：从 i 开始覆盖；中间有缺口（手机落后太多）就整个重新打开
    const k = m.i - current.offset;
    if (k > current.messages.length || k < 0) { openChat(current.sid, true); return; }
    current.messages.splice(k, current.messages.length - k, ...m.ms);
    current.running = m.running;
    if (m.title) current.title = m.title;
    renderChat();
    scrollBottom();
  }
}

// ---------- 输入 ----------
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
  if (view === 'chat') renderSendBtn();
});
function renderSendBtn() {
  const send = $('#send');
  const stop = !!(current && current.running) && !input.value.trim();
  send.classList.toggle('stop', stop);
  send.innerHTML = stop ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
}
$('#send').onclick = async () => {
  const text = input.value.trim();
  if (!text) {
    if (current && current.running) { const r = await call('stop', { sid: current.sid }); if (r.ok === false) toast(r.message); }
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  const r = await call('send', { sid: current.sid || null, text });
  if (r.ok === false) { toast(r.message || '发送失败'); input.value = text; return; }
  if (!current.sid && r.sid) { current.sid = r.sid; openChat(r.sid, true); }
};
$('#back').onclick = () => { view = 'list'; current = null; render(); loadList(); };
$('#newchat').onclick = () => { view = 'chat'; current = { sid: null, title: '新对话', messages: [], offset: 0 }; render(); input.focus(); };

// 从后台回来时刷新
document.addEventListener('visibilitychange', () => { if (!document.hidden && hostOnline) route(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
connect();
