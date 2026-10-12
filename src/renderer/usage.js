/* global api, el, esc, icon, toast, data, save, findSession, currentId, live, curServer, sendMessage, autoGrow, fmtTokens, startNewChatIn, chatCwd */
'use strict';

// ---------- 订阅额度（5 小时 / 本周 / …），每轮对话的 rate_limit_event 自动更新 ----------
const WINDOW_LABEL = {
  five_hour: '5 小时',
  seven_day: '本周',
  seven_day_opus: '本周 · Opus',
  seven_day_sonnet: '本周 · Sonnet',
  seven_day_fable: '本周 · Fable',
};
// Fable 请求才会报告的周窗口（官方字段名 seven_day_overage_included，没有文档说明）
function windowLabel(k, w) {
  if (WINDOW_LABEL[k]) return WINDOW_LABEL[k];
  if (k === 'seven_day_overage_included') return w && w.seenWith === 'fable' ? 'Fable 本周' : '本周（含超额）';
  return k;
}
const usageKey = () => (curServer() ? curServer().id : '_');

function recordRateLimit(info, model) {
  if (!info || !info.unifiedWindows) return;
  data.ui.usage = data.ui.usage || {};
  const prev = data.ui.usage[usageKey()] || { windows: {} };
  const windows = { ...prev.windows };
  for (const [k, v] of Object.entries(info.unifiedWindows)) {
    windows[k] = { utilization: v.utilization, resetsAt: v.resetsAt, seenWith: model || (windows[k] && windows[k].seenWith) || null, at: Date.now() };
  }
  data.ui.usage[usageKey()] = { windows, at: Date.now(), status: info.status };
  save();
  renderUsage();
}

function fmtReset(sec, short) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (d.toDateString() === now.toDateString()) return `今天 ${hm} 重置`;
  if (short) return `${days[d.getDay()]} ${hm} 重置`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${days[d.getDay()]} ${hm} 重置`;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}

const pctOf = (w) => Math.round(((w && w.utilization) || 0) * 100);
const levelCls = (p) => (p >= 90 ? ' full' : p >= 70 ? ' warn' : '');

// 状态栏里的紧凑显示：账号 · 5 小时 · 本周（带重置时间）
function renderUsage() {
  const box = document.querySelector('#usage-box');
  if (!box) return;
  const u = data.ui.usage && data.ui.usage[usageKey()];
  const acct = typeof accountText === 'function' ? accountText(curServer()) : '';
  const parts = [];
  if (acct) parts.push(`<span class="us-acct">${icon('user')}<span>${esc(acct)}</span></span>`);
  const w = (u && u.windows) || {};
  const chip = (k, label) => {
    if (!w[k]) return '';
    const p = pctOf(w[k]);
    return `<span class="us-chip${levelCls(p)}"><span class="us-label">${label}</span><span class="us-bar"><i style="width:${Math.min(100, p)}%"></i></span><span class="us-pct">${p}%</span></span>`;
  };
  if (w.five_hour) parts.push(chip('five_hour', '5 小时'));
  if (w.seven_day) parts.push(chip('seven_day', '本周') + `<span class="us-reset">${esc(fmtReset(w.seven_day.resetsAt, true))}</span>`);
  if (!u) parts.push('<span class="us-none">额度：发一条消息后显示</span>');
  box.innerHTML = parts.join('<span class="sb-sep"></span>');
  box.title = '点击查看所有额度和重置时间';
}

async function refreshUsage(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span><span>正在获取…</span>'; }
  const r = await api.usageRefresh();
  if (!r.ok) {
    toast('刷新额度失败：' + r.message, 5000);
  } else {
    for (const x of r.results) recordRateLimit(x.info, x.model);
  }
  const pop = document.querySelector('.us-pop');
  if (pop) { pop.remove(); openUsagePanel(); }
}

// 点击状态栏的额度：所有窗口、重置时间、刷新
function openUsagePanel() {
  const old = document.querySelector('.us-pop');
  if (old) return old.remove();
  const u = data.ui.usage && data.ui.usage[usageKey()];
  const pop = el('div', 'us-pop');
  const acct = typeof accountText === 'function' ? accountText(curServer()) : '';
  let html = `<div class="cx-head">额度 <span>${esc(serverLabel(curServer()))}</span></div>`;
  if (acct) html += `<div class="usp-acct">${icon('user')}<span>${esc(acct)}</span>${curServer() && curServer().account && curServer().account.loggedIn === false ? '<button class="btn primary" id="usp-login">登录 Claude</button>' : ''}</div>`;
  const keys = u ? Object.keys(u.windows).sort((a, b) => (a === 'five_hour' ? -1 : b === 'five_hour' ? 1 : a.localeCompare(b))) : [];
  if (!keys.length) html += '<div class="cx-none">还没有额度数据：发一条消息，或者点下面的「刷新」</div>';
  for (const k of keys) {
    const w = u.windows[k];
    const p = pctOf(w);
    html += `<div class="usp-row${levelCls(p)}"><span class="usp-name">${esc(windowLabel(k, w))}</span><span class="us-bar"><i style="width:${Math.min(100, p)}%"></i></span><span class="usp-pct">${p}%</span><span class="usp-reset">${esc(fmtReset(w.resetsAt))}</span></div>`;
  }
  html += `<div class="cx-foot"><button class="btn" id="usp-refresh">${icon('refresh')}<span>刷新</span></button><span class="cx-tip">${u ? '更新于 ' + ago(u.at) + '，每条消息后自动更新' : ''}</span></div>
    <div class="cx-tip">刷新会用 Haiku 和 Fable 各发一个极小的请求（不保存记录），Fable 的周额度只有发过 Fable 请求才会显示</div>`;
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const a = document.querySelector('#usage-box').getBoundingClientRect();
  pop.style.right = Math.max(8, window.innerWidth - a.right) + 'px';
  pop.style.bottom = window.innerHeight - a.top + 8 + 'px';
  pop.querySelector('#usp-refresh').onclick = (e) => refreshUsage(e.currentTarget);
  const lg = pop.querySelector('#usp-login');
  if (lg) lg.onclick = () => { pop.remove(); openLogin(); };
  setTimeout(() => document.addEventListener('mousedown', function close(e) {
    if (!pop.contains(e.target) && !e.target.closest('#usage-box')) { pop.remove(); document.removeEventListener('mousedown', close); }
  }), 0);
}
document.querySelector('#usage-box').addEventListener('click', openUsagePanel);
setInterval(renderUsage, 60000);

// ---------- 上下文明细（点击输入框旁的上下文用量） ----------
function parseContext(md) {
  const rows = [];
  let inCat = false;
  for (const line of md.split('\n')) {
    if (/^###\s+Estimated usage by category/i.test(line)) { inCat = true; continue; }
    if (inCat && /^###/.test(line)) break;
    const m = inCat && /^\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*([km]?)\s*\|\s*([\d.]+)%\s*\|/i.exec(line);
    if (m) {
      const mult = { k: 1e3, m: 1e6 }[m[3].toLowerCase()] || 1;
      rows.push({ name: m[1], tokens: Math.round(parseFloat(m[2]) * mult), pct: parseFloat(m[4]) });
    }
  }
  const t = /\*\*Tokens:\*\*\s*([\d.]+)([km]?)\s*\/\s*([\d.]+)([km]?)/i.exec(md);
  const num = (n, u) => Math.round(parseFloat(n) * ({ k: 1e3, m: 1e6 }[(u || '').toLowerCase()] || 1));
  return { rows, used: t ? num(t[1], t[2]) : null, total: t ? num(t[3], t[4]) : null };
}

const CAT_LABEL = {
  'System prompt': '系统提示',
  'System tools': '内置工具',
  'System tools (deferred)': '按需加载的工具',
  'MCP tools': 'MCP 工具',
  'Custom agents': '自定义助手',
  'Memory files': '记忆文件（CLAUDE.md 等）',
  Skills: 'Skill',
  Messages: '对话内容',
  'Free space': '剩余空间',
  'Autocompact buffer': '自动压缩预留',
};

async function openContextPanel() {
  const old = document.querySelector('.ctx-pop');
  if (old) return old.remove();
  const s = findSession(currentId);
  const pop = el('div', 'ctx-pop');
  document.body.appendChild(pop);
  const anchor = document.querySelector('#ctx-meter').getBoundingClientRect();
  pop.style.right = Math.max(8, window.innerWidth - anchor.right - 8) + 'px';
  pop.style.bottom = window.innerHeight - anchor.top + 8 + 'px';
  setTimeout(() => document.addEventListener('mousedown', function close(e) {
    if (!pop.contains(e.target) && !e.target.closest('#ctx-meter')) { pop.remove(); document.removeEventListener('mousedown', close); }
  }), 0);
  if (!s || !s.started) {
    pop.innerHTML = '<div class="cx-head">上下文</div><div class="cx-none">发出第一条消息后，可以在这里看到上下文占用情况</div>';
    return;
  }
  const u = s.usage;
  const pct = u && u.window ? (u.context / u.window) * 100 : null;
  pop.innerHTML = `
    <div class="cx-head">上下文 <span>${u ? `${fmtTokens(u.context)} / ${fmtTokens(u.window)}（${pct.toFixed(1)}%）` : ''}</span></div>
    <div class="cx-body"><div class="fm-empty"><span class="spin"></span><span>正在读取占用明细…</span></div></div>
    <div class="cx-foot"><button class="btn primary" id="cx-compact">压缩上下文</button><button class="btn" id="cx-new">在这个文件夹开新对话</button></div>
    <div class="cx-tip">压缩会把之前的对话总结成一份摘要，腾出空间，后面接着聊不受影响</div>`;
  pop.querySelector('#cx-compact').onclick = () => {
    if (live[s.id]) return toast('正在回复中，等这一轮结束再压缩');
    pop.remove();
    const input = document.querySelector('#input');
    input.value = '/compact';
    autoGrow();
    sendMessage();
  };
  pop.querySelector('#cx-new').onclick = () => { pop.remove(); startNewChatIn(chatCwd()); };
  const r = await api.contextDetail({ claudeId: s.claudeId || s.id, cwd: s.cwd || null });
  if (!pop.isConnected) return;
  const body = pop.querySelector('.cx-body');
  if (!r.ok) { body.innerHTML = `<div class="err-box">${esc(r.message)}</div>`; return; }
  const c = parseContext(r.text);
  if (!c.rows.length) { body.innerHTML = `<pre class="cx-raw">${esc(r.text.slice(0, 2000))}</pre>`; return; }
  if (c.used && c.total) pop.querySelector('.cx-head span').textContent = `${fmtTokens(c.used)} / ${fmtTokens(c.total)}（${((c.used / c.total) * 100).toFixed(1)}%）`;
  body.innerHTML = '';
  const max = Math.max(...c.rows.filter((x) => x.name !== 'Free space').map((x) => x.pct), 1);
  for (const row of c.rows) {
    const free = row.name === 'Free space';
    const line = el('div', 'cx-row' + (free ? ' free' : ''));
    line.innerHTML = `<span class="cx-name">${esc(CAT_LABEL[row.name] || row.name)}</span><span class="cx-bar"><i style="width:${free ? 100 : Math.max(2, (row.pct / max) * 100)}%"></i></span><span class="cx-num">${fmtTokens(row.tokens)}</span><span class="cx-pct">${row.pct}%</span>`;
    body.appendChild(line);
  }
}

document.querySelector('#ctx-meter').addEventListener('click', openContextPanel);
