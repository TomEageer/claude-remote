/* global api, marked, DOMPurify, icon, hydrateIcons */
'use strict';

// ---------- 状态 ----------
let data = { settings: {}, groups: [], sessions: [], ui: {} };
let currentId = null;     // 当前打开的对话
let newChatGroup = null;  // 新对话要放进的分组
let newChatCaps = null;   // 新对话发出第一条消息前在「能力」面板里做的选择
let searchText = '';
const live = {};          // sessionId -> { thinking }
let pending = [];         // 输入框里待发送的附件

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const findSession = (id) => data.sessions.find((s) => s.id === id);
const findGroup = (id) => data.groups.find((g) => g.id === id);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveData(data), 400);
}

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(text) {
  const div = el('div', 'md');
  div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  // 复制按钮放在代码块外层：代码块横向滚动时按钮固定在右上角
  div.querySelectorAll('pre').forEach((pre) => {
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const b = el('button', 'copy-code', '复制');
    b.onclick = () => {
      navigator.clipboard.writeText(pre.textContent.trimEnd());
      b.textContent = '已复制';
      setTimeout(() => (b.textContent = '复制'), 1200);
    };
    wrap.appendChild(b);
  });
  // 表格外包一层横向滚动，列宽可以拖动
  div.querySelectorAll('table').forEach((t) => {
    const wrap = el('div', 'table-wrap');
    t.replaceWith(wrap);
    wrap.appendChild(t);
    makeTableResizable(t);
  });
  if (typeof linkifyPaths === 'function') linkifyPaths(div);
  return div;
}

// ---------- 侧栏 ----------
function sortedSessions(groupId) {
  return data.sessions
    .filter((s) => typeof sessionOnCurrentServer !== 'function' || sessionOnCurrentServer(s))
    .filter((s) => (s.groupId || null) === groupId)
    .filter((s) => !searchText || (s.title || '').toLowerCase().includes(searchText))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderSidebar() {
  const tree = $('#tree');
  tree.innerHTML = '';
  const sections = data.groups.map((g) => ({ id: g.id, name: g.name, open: !g.collapsed, isGroup: true }));
  sections.push({ id: null, name: data.groups.length ? '未分组' : '对话', open: !data.ui.ungroupedCollapsed, isGroup: false });

  for (const sec of sections) {
    const list = sortedSessions(sec.id);
    if (searchText && !list.length) continue;
    const open = searchText ? true : sec.open;
    const g = el('div', 'group' + (open ? ' open' : ''));
    const head = el('div', 'group-head');
    head.innerHTML = `<span class="chev">${icon('chevron')}</span><span class="gname">${esc(sec.name)}</span><span class="count">${list.length || ''}</span>`;
    const acts = el('span', 'gact');
    const addBtn = el('button', 'mini-btn', icon('plus'));
    addBtn.title = '在这里新建对话';
    addBtn.onclick = (e) => { e.stopPropagation(); startNewChat(sec.id); };
    acts.appendChild(addBtn);
    if (sec.isGroup) {
      const moreBtn = el('button', 'mini-btn', icon('more'));
      moreBtn.title = '分组操作';
      moreBtn.onclick = (e) => { e.stopPropagation(); groupMenu(sec.id, e); };
      acts.appendChild(moreBtn);
      head.oncontextmenu = (e) => { e.preventDefault(); groupMenu(sec.id, e); };
    }
    head.appendChild(acts);
    head.onclick = () => {
      if (sec.isGroup) findGroup(sec.id).collapsed = !findGroup(sec.id).collapsed;
      else data.ui.ungroupedCollapsed = !data.ui.ungroupedCollapsed;
      save();
      renderSidebar();
    };
    // 拖动对话到分组上
    head.ondragover = (e) => { e.preventDefault(); head.classList.add('drop-target'); };
    head.ondragleave = () => head.classList.remove('drop-target');
    head.ondrop = (e) => {
      e.preventDefault();
      head.classList.remove('drop-target');
      const sid = e.dataTransfer.getData('text/session');
      if (sid) moveSession(sid, sec.id);
    };
    g.appendChild(head);

    const body = el('div', 'group-body');
    if (!list.length) body.appendChild(el('div', 'group-empty', sec.isGroup ? '把对话拖到这里' : '还没有对话'));
    for (const s of list) body.appendChild(renderItem(s));
    g.appendChild(body);
    tree.appendChild(g);
  }
}

function renderItem(s) {
  const it = el('div', 'item' + (s.id === currentId ? ' active' : ''));
  it.dataset.sid = s.id;
  it.draggable = true;
  it.title = s.title;
  if (live[s.id]) it.appendChild(el('span', 'running-dot'));
  const nm = el('span', 'iname', esc(s.title || '新对话'));
  nm.ondblclick = (e) => { e.stopPropagation(); inlineRename(s.id, nm); };
  it.appendChild(nm);
  const more = el('button', 'mini-btn more', icon('more'));
  more.onclick = (e) => { e.stopPropagation(); sessionMenu(s.id, e); };
  it.appendChild(more);
  it.onclick = () => openSession(s.id);
  it.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(s.id, e); };
  it.ondragstart = (e) => {
    e.dataTransfer.setData('text/session', s.id);
    it.classList.add('dragging');
  };
  it.ondragend = () => it.classList.remove('dragging');
  return it;
}

function moveSession(sid, groupId) {
  const s = findSession(sid);
  if (!s) return;
  s.groupId = groupId;
  if (groupId) findGroup(groupId).collapsed = false;
  save();
  renderSidebar();
  renderTitle();
}

// ---------- 右键菜单 ----------
function showMenu(items, e) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(el('div', 'sep')); continue; }
    if (it.label && !it.onClick) { m.appendChild(el('div', 'label', esc(it.label))); continue; }
    const b = el('button', (it.danger ? 'danger ' : '') + (it.current ? 'current' : ''), (it.icon ? icon(it.icon) : '') + `<span>${esc(it.text)}</span>` + (it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''));
    b.onclick = () => { hideMenu(); it.onClick(); };
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - r.width - 8);
  const y = e.above != null ? Math.max(8, e.above - r.height - 6) : Math.min(e.clientY, window.innerHeight - r.height - 8);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}
function hideMenu() { $('#menu').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) hideMenu(); });
window.addEventListener('blur', hideMenu);

function sessionMenu(sid, e) {
  const s = findSession(sid);
  const items = [
    { text: '重命名', icon: 'pencil', onClick: () => {
      const n = [...document.querySelectorAll('#tree .item')].find((x) => x.dataset.sid === sid);
      if (n) inlineRename(sid, n.querySelector('.iname')); else renameSession(sid);
    } },
    '-',
    { label: '移动到分组' },
  ];
  for (const g of data.groups) {
    items.push({ text: g.name, icon: 'folder', current: s.groupId === g.id, onClick: () => moveSession(sid, g.id) });
  }
  if (s.groupId) items.push({ text: '移出分组', icon: 'back', onClick: () => moveSession(sid, null) });
  items.push({ text: '新建分组并移入', icon: 'folderPlus', onClick: async () => {
    const g = await createGroup();
    if (g) moveSession(sid, g.id);
  } });
  if (s.started && s.claudeId && !live[sid]) items.push('-', { text: '从服务器重新载入', icon: 'refresh', onClick: () => reloadFromServer(sid) });
  items.push('-', { text: '删除对话', icon: 'close', danger: true, onClick: () => deleteSession(sid) });
  showMenu(items, e);
}

function groupMenu(gid, e) {
  showMenu([
    { text: '在此分组新建对话', icon: 'plus', onClick: () => startNewChat(gid) },
    { text: '重命名分组', icon: 'pencil', onClick: () => renameGroup(gid) },
    '-',
    { text: '删除分组', icon: 'close', danger: true, onClick: () => deleteGroup(gid) },
  ], e);
}

function inlineRename(sid, nameEl) {
  const s = findSession(sid);
  if (!s || !nameEl) return;
  const item = nameEl.closest('.item');
  item.draggable = false;
  const input = el('input', 'iname-edit');
  input.value = s.title || '';
  input.maxLength = 60;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== s.title) {
      s.title = v;
      s.titleLocked = true;
      save();
      renderTitle();
    }
    renderSidebar();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
}

async function renameSession(sid) {
  const s = findSession(sid);
  const name = await promptModal('重命名对话', '对话名称', s.title);
  if (name == null) return;
  s.title = name.trim() || s.title;
  s.titleLocked = true;
  save();
  renderSidebar();
  renderTitle();
}

async function deleteSession(sid) {
  const s = findSession(sid);
  if (live[sid]) return toast('这个对话还在回复，请先停止');
  const ok = await confirmModal('删除对话', `确定删除「${s.title}」吗？删除后无法恢复。`, '删除');
  if (!ok) return;
  data.sessions = data.sessions.filter((x) => x.id !== sid);
  if (currentId === sid) currentId = null;
  save();
  renderAll();
}

async function createGroup() {
  const name = await promptModal('新建分组', '分组名称', '');
  if (!name || !name.trim()) return null;
  const g = { id: uid(), name: name.trim(), collapsed: false, createdAt: Date.now() };
  data.groups.push(g);
  save();
  renderSidebar();
  return g;
}

async function renameGroup(gid) {
  const g = findGroup(gid);
  const name = await promptModal('重命名分组', '分组名称', g.name);
  if (name == null || !name.trim()) return;
  g.name = name.trim();
  save();
  renderSidebar();
  renderTitle();
}

async function deleteGroup(gid) {
  const g = findGroup(gid);
  const n = data.sessions.filter((s) => s.groupId === gid).length;
  const ok = await confirmModal('删除分组', n ? `删除分组「${g.name}」？里面的 ${n} 个对话会移到「未分组」，不会被删除。` : `删除分组「${g.name}」？`, '删除');
  if (!ok) return;
  data.sessions.forEach((s) => { if (s.groupId === gid) s.groupId = null; });
  data.groups = data.groups.filter((x) => x.id !== gid);
  if (newChatGroup === gid) newChatGroup = null;
  save();
  renderAll();
}

// ---------- 对话区 ----------
function renderTitle() {
  if (typeof renderCwd === 'function') renderCwd();
  const t = $('#title');
  const s = findSession(currentId);
  if (s) {
    const g = s.groupId && findGroup(s.groupId);
    t.innerHTML = esc(s.title) + (g ? ` <span class="tg">· ${esc(g.name)}</span>` : '');
    t.title = '点击重命名';
  } else if (newChatGroup && findGroup(newChatGroup)) {
    t.innerHTML = `新对话 <span class="tg">· ${esc(findGroup(newChatGroup).name)}</span>`;
    t.title = '';
  } else {
    t.innerHTML = '';
  }
}

function greeting() {
  const h = new Date().getHours();
  const p = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${p}，有什么可以帮你？`;
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const s = findSession(currentId);
  $('#empty').classList.toggle('hidden', !!(s && s.messages.length));
  $('#greeting').textContent = greeting();
  if (!s) return;
  s.messages.forEach((m, i) => box.appendChild(renderMessage(s, m, i)));
  scrollToBottom(true);
}

function renderMessage(s, m, index) {
  if (m.role === 'user') {
    const w = el('div', 'msg user');
    w.dataset.index = index;
    if (m.files && m.files.length) {
      const f = el('div', 'msg-files');
      for (const file of m.files) {
        f.appendChild(el('span', 'chip', `${icon('file')}<span class="cname">${esc(file.name)}</span>`));
      }
      w.appendChild(f);
    }
    if (m.text) w.appendChild(el('div', 'bubble', esc(m.text)));
    if (!live[s.id]) w.appendChild(msgActions(s, m, index));
    return w;
  }
  const w = el('div', 'msg assistant');
  w.dataset.index = index;
  for (const b of m.blocks) {
    if (b.type === 'text') w.appendChild(renderMarkdown(b.text));
    else if (b.type === 'tool') w.appendChild(renderTool(b, (m.tasks || []).find((t) => t.toolId === b.id)));
  }
  const isLast = index === s.messages.length - 1;
  const running = (m.tasks || []).filter((t) => t.status === 'running');
  if (isLast && live[s.id] && live[s.id].replied && !live[s.id].thinking) {
    // 主回复已经结束，Claude 还在等后台任务，任务结束后会接着在这条回复里汇报
    const tip = running.length ? `回复完成，后台还有 ${running.length} 个任务在运行，结束后 Claude 会接着汇报` : '后台任务已结束，Claude 正在整理结果…';
    const row = el('div', 'thinking bg-wait', `<span class="dots"><i></i><i></i><i></i></span><span>${tip}</span>`);
    if (running.length) {
      const b = el('button', 'link-btn', '查看后台任务');
      b.onclick = () => openTasksPanel();
      row.appendChild(b);
    }
    w.appendChild(row);
  } else if (isLast && live[s.id]) {
    const last = m.blocks[m.blocks.length - 1];
    const asking = last && last.name === 'AskUserQuestion' && last.ask && last.ask.state === 'pending';
    if (!asking && (!last || last.type !== 'text' || live[s.id].thinking)) {
      const st = live[s.id].status === 'compacting' ? '正在压缩上下文…' : last && last.type === 'tool' && last.status === 'running' ? '正在操作…' : '思考中…';
      w.appendChild(el('div', 'thinking', `<span class="dots"><i></i><i></i><i></i></span><span>${st}</span>`));
    }
  }
  if (m.outputs && m.outputs.length) w.appendChild(renderOutputs(m.outputs));
  if (m.stopped) w.appendChild(el('div', 'note', '已停止'));
  if (m.error) {
    const box = el('div', 'err-box', `${icon('alert')}<span>${esc(m.error)}</span>`);
    if (/登录已失效|重新授权/.test(m.error)) {
      const b = el('button', 'btn primary err-act', '登录 Claude');
      b.onclick = () => openLogin();
      box.appendChild(b);
    }
    w.appendChild(box);
  }
  if (!(isLast && live[s.id])) w.appendChild(msgActions(s, m, index));
  return w;
}

function renderQueue() {
  const box = $('#messages');
  box.querySelectorAll('.msg.queued').forEach((n) => n.remove());
  const s = findSession(currentId);
  if (!s || !s.queue || !s.queue.length) return;
  for (const q of s.queue) {
    const w = el('div', 'msg user queued');
    if (q.files && q.files.length) {
      const f = el('div', 'msg-files');
      q.files.forEach((file) => f.appendChild(el('span', 'chip', `${icon('file')}<span class="cname">${esc(file.name)}</span>`)));
      w.appendChild(f);
    }
    if (q.text) w.appendChild(el('div', 'bubble', esc(q.text)));
    const bar = el('div', 'msg-acts queued-acts', `<span class="q-tag">${icon('history')}排队中</span>`);
    const back = el('button', 'act', `${icon('back')}<span>撤回</span>`);
    back.title = '撤回这条还没发出的消息，内容放回输入框';
    back.onclick = () => {
      s.queue = s.queue.filter((x) => x !== q);
      const input = $('#input');
      if (!input.value.trim()) {
        input.value = q.text || '';
        pending = (q.files || []).map((f) => ({ uploadId: uid(), ...f }));
        renderAttachments();
        autoGrow();
      }
      save();
      renderQueue();
      toast('已撤回，Claude 手上的这一轮不受影响');
    };
    bar.appendChild(back);
    w.appendChild(bar);
    box.appendChild(w);
  }
}

function msgText(m) {
  if (m.role === 'user') return m.text || '';
  return m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

function msgActions(s, m, index) {
  const bar = el('div', 'msg-acts');
  const add = (ico, label, fn, disabled, tip) => {
    const b = el('button', 'act', `${icon(ico)}<span>${esc(label)}</span>`);
    b.title = tip || label;
    if (disabled) b.disabled = true;
    else b.onclick = fn;
    bar.appendChild(b);
  };
  add('copy', '复制', () => { navigator.clipboard.writeText(msgText(m)); toast('已复制'); });
  if (m.role === 'user') {
    const prev = s.messages[index - 1];
    const ok = index === 0 || (prev && prev.anchor);
    add('pencil', '编辑', () => startEdit(s.id, index), !ok, ok ? '修改这条消息并重新发送，原对话会另存一份' : '这是旧版本产生的消息，不支持编辑');
    add('back', '回退到这里', () => rewindTo(s.id, index), !ok, ok ? '撤回这条消息及之后的对话，可以改了再发；原对话会另存一份' : '这是旧版本产生的消息，不支持回退');
  } else if (m.anchor) {
    add('branch', '从这里分支', () => branchFrom(s.id, index), false, '从这条回复分出一个新对话，原对话不受影响');
  }
  return bar;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// opts.text：编辑后直接重新发送的内容；不传则把原文放回输入框
async function rewindTo(sid, index, opts = {}) {
  const s = findSession(sid);
  if (!s || live[sid]) return;
  const target = s.messages[index];
  if (opts.text == null) {
    const ok = await confirmModal('回退到这里', '这条消息和它之后的对话会被撤回，消息内容会放回输入框，可以修改后重新发送。原来的完整对话会另存为一个新对话，不会丢失。', '回退');
    if (!ok) return;
  }
  const suffix = opts.text == null ? '（回退前）' : '（编辑前）';
  const backup = { ...clone(s), id: uid(), title: `${s.title}${suffix}`, claudeId: s.claudeId || s.id, pendingFork: s.pendingFork || null, updatedAt: Date.now() - 1 };
  data.sessions.push(backup);
  const prev = s.messages[index - 1];
  s.messages = s.messages.slice(0, index);
  s.usage = null;
  if (prev && prev.anchor) {
    s.pendingFork = { from: prev.anchorSid || s.claudeId || s.id, at: prev.anchor };
  } else {
    s.pendingFork = null;
    s.claudeId = uid();
    s.started = false;
  }
  s.updatedAt = Date.now();
  // 原消息的附件还在服务器上，直接放回输入框
  pending = (target.files || []).filter((f) => f.remotePath).map((f) => ({ uploadId: uid(), name: f.name, remotePath: f.remotePath, size: f.size, status: 'done' }));
  renderAttachments();
  $('#input').value = opts.text != null ? opts.text : target.text || '';
  autoGrow();
  save();
  renderAll();
  if (opts.text != null) {
    toast(`已按修改后的内容重新发送，原对话另存为「${backup.title}」`, 4000);
    return sendMessage();
  }
  $('#input').focus();
  toast(`已回退，原对话另存为「${backup.title}」`, 4000);
}

function startEdit(sid, index) {
  const s = findSession(sid);
  const m = s && s.messages[index];
  const node = document.querySelector(`#messages .msg.user[data-index="${index}"]`);
  if (!m || !node || live[sid]) return;
  const bubble = node.querySelector('.bubble') || node.appendChild(el('div', 'bubble'));
  const acts = node.querySelector('.msg-acts');
  if (acts) acts.remove();
  const box = el('div', 'edit-box');
  const ta = el('textarea', 'edit-input');
  ta.value = m.text || '';
  const bar = el('div', 'edit-bar', '<span class="help">保存后会从这条消息重新生成回复，原对话另存一份</span>');
  const cancel = el('button', 'btn', '取消');
  const ok = el('button', 'btn primary', '保存并重新发送');
  bar.append(cancel, ok);
  box.append(ta, bar);
  bubble.replaceWith(box);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; };
  ta.oninput = grow;
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  cancel.onclick = () => renderMessages();
  ok.onclick = () => {
    const text = ta.value.trim();
    if (!text) return toast('内容不能为空');
    rewindTo(sid, index, { text });
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); renderMessages(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ok.click(); }
  };
}

function branchFrom(sid, index) {
  const s = findSession(sid);
  const m = s && s.messages[index];
  if (!m || !m.anchor) return;
  const b = {
    id: uid(),
    title: `分支：${s.title}`.slice(0, 40),
    groupId: s.groupId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: true,
    claudeId: null,
    pendingFork: { from: m.anchorSid || s.claudeId || s.id, at: m.anchor },
    caps: s.caps ? clone(s.caps) : null,
    messages: clone(s.messages.slice(0, index + 1)),
  };
  b.claudeId = b.id;
  data.sessions.push(b);
  save();
  openSession(b.id);
  toast('已从这里分出新对话，原对话不受影响');
}

const TOOL_LABELS = {
  Bash: ['terminal', '运行命令', (i) => i.description || i.command],
  Read: ['file', '读取文件', (i) => i.file_path],
  Write: ['file', '创建文件', (i) => i.file_path],
  Edit: ['pencil', '修改文件', (i) => i.file_path],
  MultiEdit: ['pencil', '修改文件', (i) => i.file_path],
  NotebookEdit: ['pencil', '修改笔记本', (i) => i.notebook_path],
  Glob: ['search', '查找文件', (i) => i.pattern],
  Grep: ['search', '搜索内容', (i) => i.pattern],
  LS: ['folder', '查看目录', (i) => i.path],
  WebSearch: ['globe', '搜索网页', (i) => i.query],
  WebFetch: ['globe', '打开网页', (i) => i.url],
  TodoWrite: ['list', '更新计划', () => ''],
  Task: ['spark', '派出助手', (i) => i.description],
  Agent: ['spark', '派出助手', (i) => i.description],
  AskUserQuestion: ['list', '向你提问', (i) => (i.questions && i.questions[0] && i.questions[0].question) || ''],
};

// task：这次调用对应的后台任务（后台运行的命令、派出的助手），没有则为空
function renderTool(b, task) {
  if (b.name === 'AskUserQuestion' && typeof renderAsk === 'function') return renderAsk(b);
  const [ico, label, sum] = TOOL_LABELS[b.name] || ['spark', b.name, (i) => JSON.stringify(i)];
  let summary = '';
  try { summary = sum(b.input || {}) || ''; } catch (_) {}
  // 有后台任务时以任务的状态为准（工具本身启动后马上就返回了）
  const status = task ? (task.status === 'running' ? 'running' : task.status === 'done' ? 'ok' : 'err') : b.status;
  const isAgent = b.name === 'Agent' || b.name === 'Task';
  const w = el('div', 'tool' + (status === 'ok' ? ' ok' : status === 'err' ? ' err' : '') + (isAgent ? ' agent' : ''));
  const head = el('div', 'tool-head');
  const state = status === 'running' ? '<span class="spin"></span>' : status === 'err' ? icon('alert') : icon('check');
  const steps = (b.sub || []).filter((x) => x.type === 'tool');
  let extra = '';
  if (isAgent && status === 'running' && (task && task.progress)) extra = ' · ' + taskProgressText(task.progress);
  else if (isAgent && steps.length) extra = ` · ${steps.length} 步`;
  const tag = task ? `<span class="ttag">${task.status === 'running' ? '后台运行中' : TASK_STATUS[task.status] || '后台'}</span>` : '';
  head.innerHTML = `${icon(ico)}<span class="tlabel">${esc(label)}</span>${tag}<span class="tsum">${esc(String(summary).split('\n')[0] + extra)}</span>`;
  head.appendChild(el('span', 'tstate', state));
  w.appendChild(head);
  if (isAgent) {
    // 子助手：逐步列出它做了什么，最后是它交回的结果
    const body = el('div', 'tool-sub');
    if (b.input && b.input.prompt) {
      const p = el('div', 'sub-prompt');
      p.textContent = b.input.prompt.length > 600 ? b.input.prompt.slice(0, 600) + '…' : b.input.prompt;
      body.appendChild(p);
    }
    for (const x of b.sub || []) {
      if (x.type === 'tool') body.appendChild(renderTool(x));
      else if (x.type === 'text') { const t = el('div', 'sub-text'); t.textContent = x.text; body.appendChild(t); }
    }
    if (task && task.summary && !(b.sub || []).some((x) => x.type === 'text' && x.text.trim() === task.summary.trim())) {
      const t = el('div', 'sub-text'); t.textContent = task.summary; body.appendChild(t);
    }
    if (!body.childNodes.length) body.appendChild(el('div', 'sub-none', status === 'running' ? '助手已出发，步骤会显示在这里…' : '没有记录到助手的步骤'));
    w.appendChild(body);
  } else {
    const body = el('div', 'tool-body');
    let detail = '';
    if (b.name === 'Bash' && b.input) detail = '$ ' + b.input.command + '\n\n';
    if (task) detail += task.status === 'running' ? '在后台运行，可以在「后台任务」里查看实时输出或停止\n\n' : '';
    detail += b.preview || (b.status === 'running' ? '执行中…' : '');
    body.textContent = detail;
    w.appendChild(body);
  }
  head.onclick = (e) => { e.stopPropagation(); w.classList.toggle('open'); };
  return w;
}

let renderQueued = false;
function scheduleLiveRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const s = findSession(currentId);
    if (!s) return;
    const box = $('#messages');
    const idx = s.messages.length - 1;
    if (idx < 0) return;
    const nearBottom = isNearBottom();
    const node = renderMessage(s, s.messages[idx], idx);
    const old = box.querySelector(`.msg.assistant[data-index="${idx}"]`);
    // 保留已展开的工具详情
    if (old) {
      const opened = [...old.querySelectorAll('.tool')].map((t) => t.classList.contains('open'));
      node.querySelectorAll('.tool').forEach((t, i) => opened[i] && t.classList.add('open'));
      old.replaceWith(node);
    } else box.appendChild(node);
    if (nearBottom) scrollToBottom();
  });
}

function isNearBottom() {
  const sc = $('#scroller');
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}
function scrollToBottom() {
  const sc = $('#scroller');
  sc.scrollTop = sc.scrollHeight;
}

function openSession(id) {
  if (typeof showView === 'function') showView('chat');
  setTimeout(() => typeof filePane !== 'undefined' && filePane.follow(), 0);
  currentId = id;
  newChatGroup = null;
  renderAll();
  $('#input').focus();
}

function startNewChat(groupId) {
  if (typeof showView === 'function') showView('chat');
  if (typeof newChatCwd !== 'undefined') newChatCwd = null;
  setTimeout(() => typeof filePane !== 'undefined' && filePane.follow(), 0);
  currentId = null;
  newChatGroup = groupId || null;
  renderAll();
  $('#input').focus();
}

function renderAll() {
  renderSidebar();
  renderTitle();
  renderMessages();
  renderComposerState();
  if (typeof renderTasksUi === 'function') renderTasksUi();
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function renderMeter() {
  const box = $('#ctx-meter');
  if (!box) return;
  const s = findSession(currentId);
  const u = s && s.usage;
  if (!u || !u.window) {
    box.classList.add('no-data');
    box.title = '发出消息后显示这个对话占用的上下文';
    box.querySelector('.ctx-text').textContent = '上下文 —';
    box.style.setProperty('--p', 0);
    return;
  }
  const pct = Math.min(100, (u.context / u.window) * 100);
  box.classList.remove('no-data');
  box.classList.toggle('warn', pct >= 70);
  box.classList.toggle('full', pct >= 90);
  box.style.setProperty('--p', pct.toFixed(1));
  box.querySelector('.ctx-text').textContent = `${fmtTokens(u.context)} / ${fmtTokens(u.window)}`;
  box.title = `上下文已用 ${u.context.toLocaleString()} / ${u.window.toLocaleString()} tokens（${pct.toFixed(1)}%）${pct >= 70 ? '\n快满了：可以从某条回复分支出去，或者新开一个对话' : ''}`;
}

function renderComposerState() {
  renderMeter();
  if (typeof renderCapsButton === 'function') renderCapsButton();
  const running = !!(currentId && live[currentId]);
  $('#btn-stop').classList.toggle('hidden', !running);
  $('#btn-send').title = running ? '排队：这一轮回复完自动发出' : pending.some((p) => p.status === 'uploading') ? '文件上传完后自动发送' : '发送';
  $('#btn-send').classList.toggle('queue', running);
  renderQueue();
}

// ---------- 模型 ----------
const MODELS = [
  { id: 'opus', fallback: 'Opus 5.5', desc: '能力最强' },
  { id: 'fable', fallback: 'Fable 5.1', desc: '' },
  { id: 'sonnet', fallback: 'Sonnet 5.5', desc: '均衡，默认' },
  { id: 'haiku', fallback: 'Haiku 5.5', desc: '最快' },
];
const currentModel = () => data.settings.model || 'sonnet';

// claude-opus-5-5[1m] -> Opus 5.5；claude-haiku-4-5-20251001 -> Haiku 4.5
function prettyModel(id) {
  const parts = String(id).replace(/\[.*\]$/, '').replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  if (!parts.length) return id;
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.length > 1 ? `${name} ${parts.slice(1).join('.')}` : name;
}

function modelLabel(alias) {
  const known = data.ui.modelIds && data.ui.modelIds[alias];
  if (known) return prettyModel(known);
  const m = MODELS.find((x) => x.id === alias);
  return m ? m.fallback : alias;
}

function renderModel() {
  $('#model-name').textContent = modelLabel(currentModel());
}

$('#btn-model').onclick = () => {
  const r = $('#btn-model').getBoundingClientRect();
  showMenu(MODELS.map((m) => ({
    text: modelLabel(m.id),
    desc: m.desc,
    current: m.id === currentModel(),
    onClick: () => {
      data.settings.model = m.id;
      save();
      renderModel();
      toast(`之后的回复改用 ${modelLabel(m.id)}`);
    },
  })), { clientX: r.left, above: r.top });
};

// ---------- 附件 ----------
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  for (const p of pending) {
    const c = el('span', 'chip' + (p.status === 'error' ? ' error' : ''));
    c.title = p.status === 'error' ? p.message : (p.remotePath || p.localPath);
    let inner = `${icon('file')}<span class="cname">${esc(p.name)}</span>`;
    if (p.status === 'uploading') inner += `<span class="bar"><i style="width:${Math.round((p.progress || 0) * 100)}%"></i></span>`;
    else if (p.status === 'done') inner += `<span class="fmeta">${fmtSize(p.size)}</span>`;
    else inner += '<span>上传失败</span>';
    c.innerHTML = inner;
    const x = el('button', 'x', icon('close'));
    x.title = '移除';
    x.onclick = () => { pending = pending.filter((q) => q !== p); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  }
  renderComposerState();
}

async function addFiles(paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const items = paths.map((localPath) => ({
    uploadId: uid(),
    localPath,
    name: localPath.split(/[\\/]/).pop(),
    status: 'uploading',
    progress: 0,
  }));
  pending.push(...items);
  renderAttachments();
  await Promise.all(items.map((p) => (p.promise = (async () => {
    const r = await api.upload(p.uploadId, p.localPath);
    if (r.ok) Object.assign(p, { status: 'done', remotePath: r.remotePath, promptPath: r.promptPath, size: r.size });
    else Object.assign(p, { status: 'error', message: r.message });
    renderAttachments();
    if (!r.ok) toast(`${p.name} 上传失败：${r.message}`, 4000);
  })())));
}

api.onProgress(({ uploadId, done, total }) => {
  const p = pending.find((q) => q.uploadId === uploadId);
  if (!p) return;
  p.progress = total ? done / total : 0;
  const chips = $('#attachments').children;
  const i = pending.indexOf(p);
  const bar = chips[i] && chips[i].querySelector('.bar i');
  if (bar) bar.style.width = Math.round(p.progress * 100) + '%';
});

// ---------- 发送 ----------
// payload：排队消息出队时直接传入 { text, files, sid }；不传则读输入框
async function sendMessage(payload) {
  const input = $('#input');
  const uploading = payload ? [] : pending.filter((p) => p.status === 'uploading');
  if (uploading.length) {
    if (sendMessage.waiting) return;
    sendMessage.waiting = true;
    toast('文件上传完后会自动发送');
    await Promise.all(uploading.map((p) => p.promise));
    sendMessage.waiting = false;
    return sendMessage();
  }
  const text = payload ? payload.text : input.value.trim();
  const files = payload ? payload.files : pending.filter((p) => p.status === 'done');
  if (!text && !files.length) return;

  let s = findSession(payload ? payload.sid : currentId);
  // 正在回复：先排队，这一轮结束后自动发出（排队期间可以撤回）
  if (s && live[s.id] && !payload) {
    s.queue = s.queue || [];
    s.queue.push({ id: uid(), text, files: files.map((f) => ({ name: f.name, remotePath: f.remotePath, promptPath: f.promptPath, size: f.size, status: 'done' })) });
    input.value = '';
    autoGrow();
    pending = [];
    renderAttachments();
    save();
    renderQueue();
    toast('已排队，这一轮回复完会自动发出，发出前可以撤回');
    return;
  }
  if (!s) {
    s = {
      id: uid(),
      title: (text || files[0].name).replace(/\s+/g, ' ').slice(0, 30),
      groupId: newChatGroup,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      started: false,
      claudeId: null,
      serverId: data.currentServer || null,
      cwd: (typeof chatCwd === 'function' && chatCwd()) || null,
      caps: newChatCaps ? JSON.parse(JSON.stringify(newChatCaps)) : null,
      messages: [],
    };
    s.claudeId = s.id;
    newChatCaps = null;
    if (s.cwd) rememberCwd(s.cwd);
    newChatCwd = null;
    data.sessions.push(s);
    currentId = s.id;
    newChatGroup = null;
  }

  let prompt = text || '请查看我上传的文件。';
  if (files.length) {
    prompt += `\n\n[我上传了 ${files.length} 个文件到服务器，路径如下，请直接读取]\n` + files.map((f) => `- ${f.promptPath || f.remotePath}`).join('\n');
  }

  s.messages.push({ role: 'user', text, files: files.map((f) => ({ name: f.name, remotePath: f.remotePath, promptPath: f.promptPath, size: f.size })), ts: Date.now() });
  s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
  s.updatedAt = Date.now();
  live[s.id] = { thinking: true };
  if (!payload) {
    input.value = '';
    autoGrow();
    pending = [];
    renderAttachments();
  }
  renderAll();
  save();

  const fail = (message) => {
    const msg = s.messages[s.messages.length - 1];
    msg.error = message;
    delete live[s.id];
    save();
    if (s.id === currentId) renderAll(); else renderSidebar();
  };
  const c = await api.connect();
  if (!c.ok) return fail('连接服务器失败：' + c.message);
  live[s.id].model = currentModel();
  const r = await api.run({
    sessionId: s.id,
    claudeId: s.claudeId || s.id,
    isNew: !s.started && !s.pendingFork,
    fork: s.pendingFork || null,
    prompt,
    model: currentModel(),
    caps: s.caps || null,
    cwd: s.cwd || null,
  });
  if (!r.ok) fail(r.message);
}

api.onEvent(({ sessionId, ev }) => {
  const s = findSession(sessionId);
  if (!s) return;
  const msg = s.messages[s.messages.length - 1];
  if (!msg || msg.role !== 'assistant') return;
  const lv = live[sessionId] || {};
  switch (ev.type) {
    case 'init':
      s.started = true;
      if (ev.claudeId) s.claudeId = ev.claudeId;
      s.pendingFork = null;
      s.lastInit = { mcp: ev.mcp || [], skills: ev.skills || [], plugins: ev.plugins || [], tools: ev.tools || 0, model: ev.model, at: Date.now() };
      data.ui.lastSkills = ev.skills || [];
      data.ui.lastPlugins = ev.plugins || [];
      if (ev.model && lv.model) {
        data.ui.modelIds = data.ui.modelIds || {};
        data.ui.modelIds[lv.model] = ev.model;
        renderModel();
      }
      break;
    case 'thinking':
      lv.thinking = true;
      break;
    case 'msgstart':
      lv.newText = true;
      break;
    case 'text': {
      lv.thinking = false;
      const last = msg.blocks[msg.blocks.length - 1];
      // 后台任务结束后 Claude 接着说的话另起一段
      // 新的一条助手消息（比如后台任务结束后 Claude 接着说的话）另起一段
      if (lv.replied || lv.newText) { lv.replied = false; lv.newText = false; msg.blocks.push({ type: 'text', text: ev.text }); }
      else if (last && last.type === 'text') last.text += ev.text;
      else msg.blocks.push({ type: 'text', text: ev.text });
      break;
    }
    case 'tool':
      lv.thinking = false;
      lv.replied = false;
      msg.blocks.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' });
      break;
    case 'tool_result': {
      const b = msg.blocks.find((x) => x.type === 'tool' && x.id === ev.id);
      if (b) { b.status = ev.isError ? 'err' : 'ok'; b.preview = ev.preview; }
      lv.thinking = true;
      break;
    }
    case 'result':
      lv.replied = true;
      lv.thinking = false;
      if (ev.isError) msg.error = ev.text || '回复出错了';
      else if (!msg.blocks.some((b) => b.type === 'text') && ev.text) msg.blocks.push({ type: 'text', text: ev.text });
      break;
    case 'stopped':
      msg.stopped = true;
      break;
    case 'sub': {
      const b = findToolBlock(msg.blocks, ev.parent);
      if (!b) break;
      b.sub = b.sub || [];
      const e = ev.ev;
      if (e.type === 'tool') b.sub.push({ type: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' });
      else if (e.type === 'text') b.sub.push({ type: 'text', text: e.text.slice(0, 4000) });
      else if (e.type === 'tool_result') {
        const x = b.sub.find((y) => y.type === 'tool' && y.id === e.id);
        if (x) { x.status = e.isError ? 'err' : 'ok'; x.preview = e.preview; }
      }
      if (b.sub.length > 300) b.sub.splice(0, b.sub.length - 300);
      break;
    }
    case 'task':
      onTaskEvent(s, msg, ev);
      break;
    case 'ask': {
      // Claude 在等用户选择：挂到对应的「向你提问」工具卡片上
      let b = ev.toolId && findToolBlock(msg.blocks, ev.toolId);
      if (!b) {
        b = { type: 'tool', id: ev.toolId || ev.requestId, name: 'AskUserQuestion', input: { questions: ev.questions }, status: 'running' };
        msg.blocks.push(b);
      }
      b.ask = { requestId: ev.requestId, sid: s.id, questions: ev.questions, state: 'pending', answers: null };
      lv.thinking = false;
      if (sessionId !== currentId) toast(`「${s.title}」里 Claude 在等你做选择`, 5000);
      break;
    }
    case 'files':
      msg.outputs = ev.files;
      break;
    case 'status':
      lv.status = ev.status;
      break;
    case 'ratelimit':
      if (typeof recordRateLimit === 'function') recordRateLimit(ev.info, lv.model);
      break;
    case 'compacted':
      msg.blocks.push({ type: 'text', text: '已压缩上下文：之前的对话已经总结成一份摘要，后面接着聊不受影响，占用的上下文会明显下降。' });
      s.usage = null;
      if (sessionId === currentId) renderMeter();
      break;
    case 'anchor':
      // 记下定位点属于哪个服务器会话：回退/分支时从那个会话出发，不依赖分支后消息编号是否保留
      msg.anchor = ev.uuid;
      msg.anchorSid = s.claudeId || s.id;
      break;
    case 'usage':
      s.usage = { context: ev.context, window: ev.window };
      msg.cost = ev.cost;
      if (sessionId === currentId) renderMeter();
      break;
    case 'error':
      msg.error = ev.message;
      if (ev.sessionExists) s.started = true;
      if (ev.sessionMissing) s.started = false;
      break;
    case 'end':
      const settle = (list) => list.forEach((b) => {
        if (b.type !== 'tool') return;
        if (b.status === 'running') b.status = msg.stopped ? 'err' : 'ok';
        if (b.sub) settle(b.sub);
      });
      settle(msg.blocks);
      msg.blocks.forEach((b) => { if (b.ask && b.ask.state === 'pending') b.ask.state = 'expired'; });
      // 这一轮结束时还没报告结束的后台任务：随这一轮一起结束了
      (msg.tasks || []).forEach((t) => { if (t.status === 'running') { t.status = msg.stopped ? 'stopped' : 'ended'; t.end = Date.now(); } });
      delete live[sessionId];
      s.updatedAt = Date.now();
      save();
      renderSidebar();
      if (sessionId === currentId) renderComposerState();
      // 第一轮结束后让 Haiku 起个标题（用户自己改过名的不动；从服务器导入的沿用 Claude 起的标题）
      if (!s.titleSet && !s.titleLocked && !s.imported && !msg.error && s.messages.length >= 2 && !(s.messages[0].text || '').startsWith('/')) {
        s.titleSet = true;
        const reply = msgText(msg);
        if (reply) api.makeTitle({ user: s.messages[0].text || '', reply }).then((r) => {
          if (!r.ok || s.titleLocked) return;
          s.title = r.title;
          save();
          renderSidebar();
          if (s.id === currentId) renderTitle();
        });
      }
      // 有排队的消息：接着发下一条
      if (s.queue && s.queue.length) {
        const next = s.queue.shift();
        save();
        setTimeout(() => sendMessage({ text: next.text, files: next.files, sid: s.id }), 300);
      }
      break;
  }
  if (sessionId === currentId) {
    scheduleLiveRender();
    if (ev.type === 'task' || ev.type === 'end' || ev.type === 'result') renderTasksUi();
  }
});

// 在工具调用（含子助手内部的调用）里找编号为 id 的那一个
function findToolBlock(list, id) {
  for (const b of list || []) {
    if (b.type !== 'tool') continue;
    if (b.id === id) return b;
    const x = findToolBlock(b.sub, id);
    if (x) return x;
  }
  return null;
}

// ---------- 输入框 ----------
function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 240) + 'px';
}

$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
$('#btn-send').onclick = sendMessage;
$('#btn-stop').onclick = () => currentId && api.stop(currentId);
$('#btn-attach').onclick = async () => addFiles(await api.pickFiles());

// 粘贴截图：先存成临时文件不方便，这里只处理复制的文件
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])];
  const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) {
    e.preventDefault();
    addFiles(paths);
  }
});

// 整个窗口都可以拖入文件
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#drop').classList.remove('hidden');
  $('#composer').classList.add('dragover');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    $('#drop').classList.add('hidden');
    $('#composer').classList.remove('dragover');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.add('hidden');
  $('#composer').classList.remove('dragover');
  const dropped = [...e.dataTransfer.files].map((f) => api.pathForFile(f));
  if (document.body.dataset.view === 'files') return fm.upload(dropped);
  if (e.target.closest && e.target.closest('#filepane') && filePane.open) return filePane.browser.upload(dropped);
  addFiles(dropped);
  $('#input').focus();
});

// ---------- 弹窗 ----------
function modal({ title, body, buttons, wide }) {
  return new Promise((resolve) => {
    const ov = el('div', 'overlay');
    const m = el('div', 'modal' + (wide ? ' wide' : '') + (wide === 'xl' ? ' xl' : ''));
    const head = el('div', 'modal-head', `<h2>${esc(title)}</h2>`);
    const x = el('button', 'icon-btn', icon('close'));
    head.appendChild(x);
    const bd = el('div', 'modal-body');
    if (typeof body === 'string') bd.innerHTML = body; else if (body) bd.appendChild(body);
    const foot = el('div', 'modal-foot');
    const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    x.onclick = () => close(null);
    for (const b of buttons || []) {
      if (b.left) { foot.appendChild(b.left); continue; }
      const btn = el('button', 'btn ' + (b.cls || ''), esc(b.text));
      btn.onclick = async () => {
        const v = b.onClick ? await b.onClick() : b.value;
        if (v !== undefined) close(v);
      };
      foot.appendChild(btn);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT') {
        const primary = foot.querySelector('.btn.primary, .btn.danger');
        if (primary) primary.click();
      }
    };
    document.addEventListener('keydown', onKey);
    ov.onmousedown = (e) => { if (e.target === ov) close(null); };
    m.append(head, bd, foot);
    ov.appendChild(m);
    $('#modal-root').appendChild(ov);
    const first = m.querySelector('input');
    if (first) { first.focus(); first.select(); }
  });
}

function promptModal(title, label, value) {
  const body = el('div', 'field', `<label>${esc(label)}</label><input value="${esc(value || '')}" maxlength="60" />`);
  return modal({
    title,
    body,
    buttons: [
      { text: '取消', value: null },
      { text: '确定', cls: 'primary', onClick: () => body.querySelector('input').value },
    ],
  });
}

function confirmModal(title, text, okText) {
  return modal({
    title,
    body: `<p style="margin:4px 0 8px">${esc(text)}</p>`,
    buttons: [
      { text: '取消', value: false },
      { text: okText || '确定', cls: 'danger', value: true },
    ],
  }).then((v) => !!v);
}

// ---------- 设置 ----------
async function openSettings(tab = 'general') {
  if (document.querySelector('.overlay .st-wrap')) return;
  const s = data.settings;
  const body = el('div');
  body.innerHTML = `
    <div class="st-about"><div><b>Claude 远程助手</b><span id="st-ver"></span></div><button class="btn primary" id="st-update">检查更新</button></div>
    <div class="st-sec">连接</div>
    <div class="field"><label>服务器名称（界面上只显示这个）</label><input id="st-name" value="${esc((curServer() && curServer().name) || '')}" placeholder="例如 公司服务器" /></div>
    <div class="field"><label>服务器地址</label><div class="row"><input id="st-host" class="secret" value="${esc(s.host)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
    <div class="field"><label>端口</label><input id="st-port" value="${esc(s.port)}" /></div>
    <div class="field"><label>用户名</label><div class="row"><input id="st-user" class="secret" value="${esc(s.user)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
    <div class="field"><label>Claude 账号备注（可选）</label><input id="st-acct" value="${esc((curServer() && curServer().accountLabel) || '')}" placeholder="用长期令牌登录时看不到账号，可以在这里备注是哪个号" /></div>
    <div class="field"><label>密钥文件</label>
      <div class="row"><input id="st-key" class="secret" value="${esc(s.keyPath)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button><button class="btn" id="st-key-pick">选择…</button></div>
      <div class="help">这台电脑上的 SSH 私钥（对应的公钥需要管理员加到服务器上）</div>
    </div>
    <div class="field"><label>插件仓库</label><input id="st-store" placeholder="GitHub 用户名/仓库名" value="${esc(s.pluginRepo || '')}" />
      <div class="help">预览插件从这个 GitHub 仓库下载（国内会自动走 jsDelivr 镜像），可以换成你自己 fork 的仓库</div>
    </div>
    <div class="field"><label>代理（可选）</label><input id="st-proxy" placeholder="socks5://127.0.0.1:1080 或 http://127.0.0.1:8080" value="${esc(s.proxy || '')}" />
      <div class="help">服务器只允许特定网络访问时（如公司 VPN、跳板代理）才需要填，一般留空</div>
    </div>
    <label class="check"><input type="checkbox" id="st-direct" ${s.bindDirect ? 'checked' : ''} /> 绕过本机代理直连（电脑开着 Clash、Flowgate、Shadowrocket 等全局代理，而服务器要求用本地网络访问时打开）</label>
    <div class="field"><label>服务器上的工作文件夹</label><input id="st-wd" value="${esc(s.workdir)}" />
      <div class="help">上传的文件会放在这里面的 uploads 文件夹</div>
    </div>
    <div class="field"><label>给 Claude 的额外说明</label><textarea id="st-prompt" rows="4">${esc(s.appendPrompt || '')}</textarea>
      <div class="help">每次对话都会附带这段话，比如让它用什么语气、文件放哪里</div>
    </div>
    <div class="field st-actions"><button class="btn" id="st-login">重新登录 Claude</button><button class="btn" id="st-wizard">重新运行配置向导</button></div>`;
  body.querySelector('#st-key-pick').onclick = async () => {
    const p = await api.pickKey();
    if (p) body.querySelector('#st-key').value = p;
  };
  const read = () => ({
    host: body.querySelector('#st-host').value.trim(),
    port: Number(body.querySelector('#st-port').value) || 22,
    user: body.querySelector('#st-user').value.trim(),
    keyPath: body.querySelector('#st-key').value.trim(),
    workdir: body.querySelector('#st-wd').value.trim() || '~/workspace',
    proxy: body.querySelector('#st-proxy').value.trim(),
    _name: body.querySelector('#st-name').value.trim(),
    _acct: body.querySelector('#st-acct').value.trim(),
    bindDirect: body.querySelector('#st-direct').checked,
    pluginRepo: body.querySelector('#st-store').value.trim(),
    appendPrompt: body.querySelector('#st-prompt').value,
  });
  api.appVersion().then((v) => { body.querySelector('#st-ver').textContent = '当前版本 ' + v; });
  body.querySelector('#st-update').onclick = () => { toast('正在检查更新…'); api.checkUpdate(); };
  body.querySelectorAll('.reveal').forEach((b) => (b.onclick = () => b.previousElementSibling.classList.toggle('secret')));
  body.querySelector('#st-login').onclick = () => {
    document.querySelector('.overlay').remove();
    openLogin();
  };
  body.querySelector('#st-wizard').onclick = () => {
    document.querySelector('.overlay').remove();
    openWizard(true);
  };
  const result = el('span', 'left test-result');
  const testBtn = el('button', 'btn', '测试连接');
  const left = el('span', 'left');
  left.style.display = 'flex';
  left.style.alignItems = 'center';
  left.style.gap = '10px';
  left.append(testBtn, result);
  testBtn.onclick = async () => {
    result.className = 'test-result';
    result.textContent = '连接中…';
    await api.applySettings(read());
    const r = await api.connect();
    result.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
    result.textContent = r.ok ? '连接成功' : r.message;
  };
  // 分页：MCP 与 Skill、预览插件两页直接借用原来的页面，关闭时还回去
  const wrap = el('div', 'st-wrap');
  const tabs = el('div', 'seg st-tabs', '<button data-t="general">通用</button><button data-t="caps">MCP 与 Skill</button><button data-t="plugins">预览插件</button>');
  const paneG = el('div', 'st-pane');
  const paneC = el('div', 'st-pane');
  const paneP = el('div', 'st-pane');
  paneG.appendChild(body);
  const capsEl = $('#view-caps');
  const plEl = $('#view-plugins');
  const homeOf = capsEl.parentNode;
  paneC.appendChild(capsEl);
  paneP.appendChild(plEl);
  capsEl.classList.add('embedded');
  plEl.classList.add('embedded');
  wrap.append(tabs, paneG, paneC, paneP);
  const showTab = (t) => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    paneG.hidden = t !== 'general';
    paneC.hidden = t !== 'caps';
    paneP.hidden = t !== 'plugins';
    const m = wrap.closest('.modal');
    if (m) m.classList.toggle('no-foot', t !== 'general');
    if (t === 'caps') capsView.open();
    if (t === 'plugins') pluginsView.open();
  };
  tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
  setTimeout(() => showTab(tab), 0);
  const v = await modal({
    title: '设置',
    body: wrap,
    wide: 'xl',
    buttons: [
      { left },
      { text: '取消', value: null },
      { text: '保存', cls: 'primary', onClick: () => read() },
    ],
  });
  capsEl.classList.remove('embedded');
  plEl.classList.remove('embedded');
  homeOf.appendChild(capsEl);
  homeOf.appendChild(plEl);
  if (v) {
    const meta = { name: v._name, accountLabel: v._acct };
    delete v._name;
    delete v._acct;
    data.settings = { ...data.settings, ...v };
    if (curServer()) Object.assign(curServer(), meta);
    syncServerFromSettings();
    if (typeof renderUsage === 'function') renderUsage();
    save();
    toast('设置已保存');
  }
  await api.applySettings(data.settings);
  api.connect();
}

async function downloadFile(remotePath) {
  const r = await api.download(remotePath);
  if (r.ok) toast('已下载到 ' + r.localPath, 3500);
  else if (!r.canceled) toast('下载失败：' + r.message, 4000);
}

// ---------- 配置向导 ----------
// opts.add：添加一台新服务器；opts.startAt === 'auth'：直接进入「登录 Claude」
function openWizard(cancelable, opts = {}) {
  const root = el('div', 'wizard');
  const card = el('div', 'wcard');
  root.appendChild(card);
  document.body.appendChild(root);
  const st = opts.add ? { port: 22, user: 'root', workdir: '~/workspace' } : data.settings;
  let wizardName = '';
  const close = () => { api.setupCancel(); root.remove(); };
  let mode = 'password';

  const stepServer = (err) => {
    card.innerHTML = `
      <div class="wmark"></div>
      <h2>${opts.add ? '添加一台服务器' : '连接你的服务器'}</h2>
      <p class="wsub">只需要配置一次。密码只用来完成首次配置，不会被保存。</p>
      <div class="frow2">
        <div class="field grow"><label>服务器地址</label><input id="w-host" placeholder="例如 203.0.113.10" value="${esc(st.host || '')}" /></div>
        <div class="field port"><label>端口</label><input id="w-port" value="${esc(st.port || 22)}" /></div>
      </div>
      <div class="field"><label>用户名</label><input id="w-user" placeholder="例如 root" value="${esc(st.user || 'root')}" /></div>
      <div class="field"><label>给这台服务器起个名字（界面上只显示这个名字，不显示地址，截图更安全）</label><input id="w-name" placeholder="例如 公司服务器、我的 Mac" value="${esc(opts.add ? '' : (curServer() && curServer().name) || '')}" /></div>
      <div class="seg"><button data-m="password">用密码登录</button><button data-m="key">用密钥文件登录</button></div>
      <div class="field" id="w-pass-f"><label>密码</label><input id="w-pass" type="password" /></div>
      <div class="field hidden" id="w-key-f"><label>密钥文件</label><div class="row"><input id="w-key" placeholder="云服务器下载的 .pem / id_rsa 等" /><button class="btn" id="w-key-pick">选择…</button></div></div>
      <details class="wadv"><summary>高级选项</summary>
        <label class="check"><input type="checkbox" id="w-create" checked /> 用 root 登录时，为 Claude 新建一个普通账号（推荐，Claude 碰不到服务器上的其他服务）</label>
        <div class="frow2">
          <div class="field grow"><label>专用账号名</label><input id="w-newuser" value="claude" /></div>
          <div class="field grow"><label>工作文件夹</label><input id="w-wd" value="${esc(st.workdir || '~/workspace')}" /></div>
        </div>
        <div class="field"><label>代理（可选）</label><input id="w-proxy" placeholder="例如 socks5://127.0.0.1:1080（不需要就留空）" value="${esc(st.proxy || '')}" />
          <div class="help">服务器只允许公司网络等特定出口访问时才需要填</div>
        </div>
        <label class="check"><input type="checkbox" id="w-direct" ${st.bindDirect ? 'checked' : ''} /> 绕过本机代理直连（电脑开着 Clash、Flowgate 等全局代理，连不上服务器时打开）</label>
      </details>
      ${err ? `<div class="err-box">${icon('alert')}<span>${esc(err)}</span></div>` : ''}
      <div class="wfoot">${cancelable ? '<button class="btn" id="w-cancel">取消</button>' : ''}<button class="btn primary" id="w-go">开始配置</button></div>`;
    const setMode = (m) => {
      mode = m;
      card.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      card.querySelector('#w-pass-f').classList.toggle('hidden', m !== 'password');
      card.querySelector('#w-key-f').classList.toggle('hidden', m !== 'key');
    };
    card.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    setMode(mode);
    card.querySelector('#w-key-pick').onclick = async () => {
      const p = await api.pickKey();
      if (p) card.querySelector('#w-key').value = p;
    };
    if (cancelable) card.querySelector('#w-cancel').onclick = close;
    card.querySelector('#w-go').onclick = () => {
      const v = (id) => card.querySelector(id).value.trim();
      const input = {
        host: v('#w-host'),
        port: Number(v('#w-port')) || 22,
        user: v('#w-user'),
        password: mode === 'password' ? card.querySelector('#w-pass').value : '',
        keyFile: mode === 'key' ? v('#w-key') : '',
        createUser: card.querySelector('#w-create').checked,
        newUser: v('#w-newuser') || 'claude',
        workdir: v('#w-wd') || '~/workspace',
        proxy: v('#w-proxy'),
        bindDirect: card.querySelector('#w-direct').checked,
      };
      wizardName = v('#w-name');
      if (!input.host || !input.user) return toast('请填写服务器地址和用户名');
      if (mode === 'password' && !input.password) return toast('请填写密码');
      if (mode === 'key' && !input.keyFile) return toast('请选择密钥文件');
      stepProgress(input);
    };
    card.querySelector('#w-host').focus();
  };

  const stepProgress = async (input) => {
    card.innerHTML = `<h2>正在配置</h2><p class="wsub">${esc(wizardName || '新服务器')}</p><div class="wsteps"></div>`;
    const list = card.querySelector('.wsteps');
    const rows = {};
    setupLogHandler = ({ step, state, detail }) => {
      let r = rows[step];
      if (!r) { r = rows[step] = el('div', 'wstep'); list.appendChild(r); }
      const ico = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? icon('check') : icon('alert');
      r.className = 'wstep ' + state;
      r.innerHTML = `<span class="wsi">${ico}</span><span class="wsn">${esc(step)}</span><span class="wsd">${esc(detail)}</span>`;
    };
    const r = await api.setupRun(input);
    setupLogHandler = null;
    if (!r.ok) return stepServer(r.message);
    applyServerResult(r.settings, !!opts.add, wizardName);
    if (r.needsAuth) stepAuth();
    else stepDone();
  };

  const stepAuth = () => {
    card.innerHTML = `
      <div class="wmark"></div>
      <h2>登录 Claude</h2>
      <p class="wsub">${opts.startAt === 'auth' ? `重新给「${esc(serverLabel(curServer()))}」上的 Claude 授权，可以换成别的 Claude 账号；令牌有效期一年。` : 'Claude 运行在你的服务器上，需要用你的 Claude 账号授权一次（有效期一年）。'}</p>
      <div class="seg"><button data-t="oauth" class="on">Claude 订阅账号</button><button data-t="api">API Key</button></div>
      <div id="w-oauth">
        <div class="wnum"><b>1</b><div><button class="btn primary" id="w-open">打开浏览器登录</button><div class="help" id="w-url-help"></div></div></div>
        <div class="wnum"><b>2</b><div class="grow"><div class="field"><label>登录后网页上会显示一串授权码，粘贴到这里</label><input id="w-code" /></div><button class="btn primary" id="w-code-go">完成登录</button></div></div>
      </div>
      <div id="w-api" class="hidden">
        <div class="field"><label>Anthropic API Key</label><input id="w-apikey" placeholder="sk-ant-..." /></div>
        <button class="btn primary" id="w-api-go">保存</button>
      </div>
      <div id="w-auth-msg"></div>
      <div class="wfoot"><button class="btn" id="w-skip">${opts.startAt === 'auth' ? '取消' : '稍后再说'}</button></div>`;
    card.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => {
      card.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      card.querySelector('#w-oauth').classList.toggle('hidden', b.dataset.t !== 'oauth');
      card.querySelector('#w-api').classList.toggle('hidden', b.dataset.t !== 'api');
    }));
    const msg = (html) => (card.querySelector('#w-auth-msg').innerHTML = html);
    const fail = (text) => msg(`<div class="err-box">${icon('alert')}<span>${esc(text)}</span></div>`);
    const busy = (text) => msg(`<div class="thinking"><span class="spin"></span><span>${esc(text)}</span></div>`);
    card.querySelector('#w-open').onclick = async () => {
      busy('正在获取登录链接…');
      const r = await api.setupAuthStart();
      if (!r.ok) return fail(r.message);
      msg('');
      api.openExternal(r.url);
      const help = card.querySelector('#w-url-help');
      help.innerHTML = '浏览器没打开？<a href="#" id="w-copy-url">复制登录链接</a>，粘贴到浏览器里打开';
      help.querySelector('#w-copy-url').onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(r.url); toast('链接已复制'); };
      card.querySelector('#w-code').focus();
    };
    card.querySelector('#w-code-go').onclick = async () => {
      const code = card.querySelector('#w-code').value.trim();
      if (!code) return toast('请先粘贴授权码');
      busy('正在完成登录并测试…');
      const r = await api.setupAuthCode(code);
      if (!r.ok) return fail(r.message);
      stepDone();
    };
    card.querySelector('#w-api-go').onclick = async () => {
      busy('正在保存并测试…');
      const r = await api.setupApiKey(card.querySelector('#w-apikey').value);
      if (!r.ok) return fail(r.message);
      stepDone();
    };
    card.querySelector('#w-skip').onclick = async () => {
      close();
      await api.applySettings(data.settings);
      api.connect();
    };
  };

  const stepDone = () => {
    card.innerHTML = `
      <div class="wdone">${icon('check')}</div>
      <h2>${opts.startAt === 'auth' ? '登录成功' : '配置完成'}</h2>
      <p class="wsub">以后打开软件会自动连接「${esc(serverLabel(curServer()))}」</p>
      <div class="wfoot center"><button class="btn primary" id="w-start">开始使用</button></div>`;
    card.querySelector('#w-start').onclick = async () => {
      close();
      await api.applySettings(data.settings);
      api.connect();
      $('#input').focus();
    };
  };

  if (opts.startAt === 'auth') stepAuth();
  else stepServer();
}
let setupLogHandler = null;
api.onSetupLog((p) => setupLogHandler && setupLogHandler(p));

// ---------- 软件更新 ----------
api.onUpdate((u) => {
  const bar = $('#update-bar');
  if (u.state === 'latest') return toast('已经是最新版本');
  if (u.state === 'error') return toast('检查更新失败：' + u.message, 5000);
  bar.classList.remove('hidden');
  if (u.state === 'available') {
    bar.innerHTML = `${icon('download')}<span>发现新版本 ${esc(u.version)}</span><a href="#">去下载</a>`;
    bar.querySelector('a').onclick = (e) => { e.preventDefault(); api.openExternal(u.url); };
  } else if (u.state === 'downloading') {
    bar.innerHTML = `<span class="spin"></span><span>正在下载新版本${u.version ? ' ' + esc(u.version) : ''}${u.percent != null ? ` · ${u.percent}%` : ''}</span>`;
  } else if (u.state === 'ready') {
    bar.innerHTML = `${icon('check')}<span>新版本 ${esc(u.version)} 已下载</span><a href="#">重启更新</a>`;
    bar.querySelector('a').onclick = (e) => { e.preventDefault(); api.installUpdate(); };
  }
});

// ---------- 连接状态 ----------
const STATE_TEXT = { connected: '已连接服务器', connecting: '正在连接…', disconnected: '未连接', error: '连接失败' };
api.onState(({ state, message }) => {
  const c = $('#conn');
  c.className = 'conn ' + state;
  c.querySelector('.conn-text').textContent = STATE_TEXT[state] || state;
  c.title = message || (state === 'connected' ? `已连接：${typeof serverLabel === 'function' ? serverLabel(curServer()) : ''}` : '点击重新连接');
});
$('#conn').onclick = async () => {
  const r = await api.connect();
  if (!r.ok) toast(r.message, 4000);
};

// ---------- 启动 ----------
$('#btn-new').onclick = () => startNewChat(null);
$('#btn-new-group').onclick = createGroup;
$('#btn-settings-side').onclick = openSettings;
api.onMenuSettings(() => { if (!document.querySelector('.overlay')) openSettings(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); if (!document.querySelector('.overlay')) openSettings(); }
});
api.appVersion().then((v) => {
  const b = $('#ver-link');
  b.textContent = 'v' + v;
  b.onclick = () => { toast('正在检查更新…'); api.checkUpdate(); };
});
$('#title').onclick = () => currentId && renameSession(currentId);
$('#search').addEventListener('input', (e) => { searchText = e.target.value.trim().toLowerCase(); renderSidebar(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); startNewChat(null); }
});

// 等所有脚本（preview.js / files.js / plugins-ui.js）都执行完再启动
document.addEventListener('DOMContentLoaded', async function init() {
  if (api.platform === 'darwin') document.body.classList.add('mac');
  hydrateIcons();
  data = await api.loadData();
  data.ui = data.ui || {};
  // 上次异常退出时还在"回复中"的工具，标记为结束
  for (const s of data.sessions) {
    for (const m of s.messages) {
      if (m.role === 'assistant') m.blocks.forEach((b) => { if (b.type === 'tool' && b.status === 'running') b.status = 'err'; });
    }
  }
  const recent = [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  currentId = recent ? recent.id : null;
  renderAll();
  renderModel();
  migrateServers();
  renderServerSwitcher();
  renderSidebar();
  if (typeof renderUsage === 'function') renderUsage();
  if (!curServer()) return openWizard(false);
  $('#input').focus();
  const r = await refreshRemoteInfo();
  if (!r.ok) toast(r.message, 5000);
  else refreshAccount();
});
