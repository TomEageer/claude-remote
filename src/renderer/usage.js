/* global api, el, esc, icon, toast, data, save, findSession, currentId, live, curServer, sendMessage, autoGrow, fmtTokens, startNewChatIn, chatCwd */
'use strict';

// ---------- 订阅额度（5 小时 / 本周 / …），每轮对话的 rate_limit_event 自动更新 ----------
const WINDOW_LABEL = {
  five_hour: '5 小时',
  seven_day: '本周',
  seven_day_opus: '本周 · Opus',
  seven_day_sonnet: '本周 · Sonnet',
  seven_day_fable: '本周 · Fable',
  seven_day_overage_included: '本周（含超额）',
};
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

function fmtReset(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm} 重置`;
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${days[d.getDay()]} ${hm} 重置`;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}

function renderUsage() {
  const box = document.querySelector('#usage-box');
  if (!box) return;
  const u = data.ui.usage && data.ui.usage[usageKey()];
  if (!u || !Object.keys(u.windows || {}).length) {
    box.innerHTML = `<div class="us-empty"><span>额度：发一条消息后显示</span><button class="mini-btn" title="现在获取（会发一个极小的请求）">${icon('refresh')}</button></div>`;
    box.querySelector('button').onclick = refreshUsage;
    return;
  }
  const order = Object.keys(u.windows).sort((a, b) => (a === 'five_hour' ? -1 : b === 'five_hour' ? 1 : a.localeCompare(b)));
  box.innerHTML = '';
  for (const k of order) {
    const w = u.windows[k];
    const pct = Math.round((w.utilization || 0) * 100);
    const row = el('div', 'us-row' + (pct >= 90 ? ' full' : pct >= 70 ? ' warn' : ''));
    row.innerHTML = `<span class="us-label">${esc(WINDOW_LABEL[k] || k)}</span><span class="us-bar"><i style="width:${Math.min(100, pct)}%"></i></span><span class="us-pct">${pct}%</span>`;
    row.title = `${WINDOW_LABEL[k] || k}：已用 ${pct}%\n${fmtReset(w.resetsAt)}${w.seenWith ? `\n使用 ${w.seenWith} 时报告` : ''}\n更新于 ${ago(w.at || u.at)}`;
    box.appendChild(row);
  }
  const foot = el('div', 'us-foot', `<span>更新于 ${ago(u.at)}</span>`);
  const b = el('button', 'mini-btn', icon('refresh'));
  b.title = '刷新额度（会发一个极小的 Haiku 请求，不保存记录）';
  b.onclick = refreshUsage;
  foot.appendChild(b);
  box.appendChild(foot);
}

async function refreshUsage() {
  const box = document.querySelector('#usage-box');
  box.classList.add('loading');
  const r = await api.usageRefresh();
  box.classList.remove('loading');
  if (!r.ok) return toast('刷新额度失败：' + r.message, 5000);
  recordRateLimit(r.info, 'haiku');
}
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
