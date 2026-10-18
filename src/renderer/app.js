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

// 存盘：设置和对话列表存在 data.json，每个对话的消息单独存一个文件，只写有变化的那几个
// （几十 MB 的历史不再每次整份复制、整份写盘；回复过程中每 0.4 秒只写正在回复的那个对话）。
// 有变化 = save(sid) 点名的 / 正在回复的 / 收到过事件的对话，或者消息条数、最后一条、整个数组换了的对话。
// 原地改了某条消息里的内容（回答提问、批准计划、停止任务…）要用 save(那个对话的 id)；只改设置、标题、分组之类的用 save()，
// 不会再把正在看的大对话整份重写一遍
let saveTimer = null;
let saveWaitFrom = 0; // 这一批改动从什么时候开始等着存：一直有新改动也最多拖 2 秒
const dirtySids = new Set();
const savedShape = new Map(); // 对话 id -> 上次存盘时的 { arr, len, last }
const markDirty = (sid) => { if (sid) dirtySids.add(sid); };
function save(sid) {
  markDirty(sid);
  for (const id of Object.keys(live)) markDirty(id);
  if (!saveTimer) saveWaitFrom = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, Math.max(0, Math.min(400, saveWaitFrom + 2000 - Date.now())));
}
function savePayload() {
  const msgs = {};
  const sessions = data.sessions.map((x) => {
    const m = x.messages || [];
    const last = m[m.length - 1];
    const shape = savedShape.get(x.id);
    if (dirtySids.has(x.id) || !shape || shape.arr !== m || shape.len !== m.length || shape.last !== last) {
      // 在这边转成 JSON 再编码成 UTF-8 字节交给主进程：比跨进程复制整个消息数组快好几倍，主进程也不用再编码，写出的内容不变
      msgs[x.id] = new TextEncoder().encode(JSON.stringify(m));
      savedShape.set(x.id, { arr: m, len: m.length, last });
    }
    const { messages, ...rest } = x;
    return rest;
  });
  dirtySids.clear();
  return { meta: { ...data, sessions }, msgs, ids: data.sessions.map((x) => x.id) };
}
function flushSave() {
  saveTimer = null;
  api.saveData(savePayload());
}
// 关窗口时还有没存的（排着的存盘，或者回复到一半、还没存过的内容）：同步存完再走
window.addEventListener('beforeunload', () => {
  if (!saveTimer && !dirtySids.size) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  api.saveDataSync(savePayload());
});

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
// 两处对中文不友好的默认规则：
// 1. GFM 允许单个 ~ 表示删除线，「7/1~8/13」「6~9 月」两个 ~ 之间的内容会被划掉吞掉 —— 只认 ~~ 双波浪线；
// 2. CommonMark 规定 ** 前是标点、后是文字时不算加粗结束，「**结论。**后面的话」会原样显示星号 —— 只要成对就加粗
marked.use({
  tokenizer: {
    del(src) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/.exec(src);
      if (m) return { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      return undefined; // 单个 ~ 当普通字符
    },
  },
  extensions: [{
    name: 'cjkStrong',
    level: 'inline',
    start(src) { const i = src.indexOf('**'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\*\*(?![\s*])([^*\n]*?[^\s*])\*\*(?!\*)/.exec(src);
      if (m) return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      return undefined;
    },
  }],
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// 解析好的 HTML 按原文缓存：流式回复每次重画整条消息，前面没变的段落不用再解析、消毒一遍（长回复里占了重画的大头）。
// 解析结果只由原文决定，缓存命中和重新解析完全一样；按总字数限量（约几 MB），超了先丢最久没用的
const mdCache = new Map();
let mdCacheSize = 0;
let mdLastKey = '';
const MD_CACHE_MAX = 2e6;
function mdHtml(text) {
  let html = mdCache.get(text);
  if (html !== undefined) {
    mdCache.delete(text);
    mdCache.set(text, html);
    return html;
  }
  html = DOMPurify.sanitize(marked.parse(text));
  const n = text.length + html.length;
  if (n > MD_CACHE_MAX / 4) return html;
  // 正在流式输出的那段每次都比上次长一点：上一版没用了，不留着占地方
  if (mdLastKey && text.startsWith(mdLastKey) && mdCache.has(mdLastKey)) {
    mdCacheSize -= mdLastKey.length + mdCache.get(mdLastKey).length;
    mdCache.delete(mdLastKey);
  }
  mdLastKey = text;
  mdCache.set(text, html);
  mdCacheSize += n;
  for (const [k, v] of mdCache) {
    if (mdCacheSize <= MD_CACHE_MAX) break;
    mdCache.delete(k);
    mdCacheSize -= k.length + v.length;
  }
  return html;
}

function renderMarkdown(text) {
  const div = el('div', 'md');
  div.innerHTML = mdHtml(text || '');
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
// groupId：分组；'__pinned' 是置顶区（置顶的对话只出现在这里，不在原分组里重复）；
// '__history' 是「历史版本」：编辑前、回退前另存的那份，和从这里分出来还没用过的分支。都还记着原来的分组，
// 在里面接着发消息、或者移到别的分组，就回到正常列表
const HISTORY = '__history';
function sortedSessions(groupId) {
  const pinnedArea = groupId === '__pinned';
  const histArea = groupId === HISTORY;
  return data.sessions
    .filter((s) => typeof sessionOnCurrentServer !== 'function' || sessionOnCurrentServer(s))
    .filter((s) => (histArea ? !!s.history : s.history ? false : pinnedArea ? !!s.pinned : !s.pinned && (s.groupId || null) === groupId))
    .filter((s) => !searchText || (s.title || '').toLowerCase().includes(searchText))
    // 没拖动排过的（新对话、刚发过消息的）在最上面，按最近活动时间排；拖动排过的按你放的位置
    .sort((a, b) => {
      const ha = a.order != null;
      const hb = b.order != null;
      if (ha !== hb) return ha ? 1 : -1;
      return ha ? a.order - b.order : b.updatedAt - a.updatedAt;
    });
}

// 刚发了消息：回到所在列表的最上面（去掉手动排的位置，按时间排）
function bumpSession(s) {
  if (!s) return;
  delete s.order;
  s.updatedAt = Date.now();
}

function togglePin(sid) {
  const s = findSession(sid);
  if (!s) return;
  s.pinned = !s.pinned;
  delete s.history;
  delete s.order;
  save();
  renderSidebar();
  toast(s.pinned ? '已置顶' : '已取消置顶');
}

// 把对话 sid 拖到 targetSid 的前面（after=false）或后面，必要时顺带移进目标所在的分组 / 置顶区
function reorderSession(sid, targetSid, after) {
  const s = findSession(sid);
  const t = findSession(targetSid);
  if (!s || !t || s === t) return;
  const gid = t.pinned ? '__pinned' : t.groupId || null;
  const list = sortedSessions(gid).filter((x) => x !== s);
  list.splice(list.indexOf(t) + (after ? 1 : 0), 0, s);
  if (t.pinned) s.pinned = true;
  else { s.pinned = false; s.groupId = gid; }
  list.forEach((x, i) => { x.order = i; });
  save();
  renderSidebar();
}

// 分组开合动画（和 Tacivan 的侧栏一样）：高度每帧走剩下距离的 26%，先快后慢，约 0.2 秒；
// 下面的分组跟着被推开 / 拉回，内容不跟着滑动，像拉开一个抽屉
function animateHeight(box, from, to, done) {
  cancelAnimationFrame(box._anim);
  let h = from;
  box.style.overflow = 'hidden';
  box.style.height = h + 'px';
  const step = () => {
    const diff = to - h;
    if (Math.abs(diff) < 0.6) {
      box.style.height = '';
      box.style.overflow = '';
      if (done) done();
      return;
    }
    h += diff * 0.26;
    box.style.height = h + 'px';
    box._anim = requestAnimationFrame(step);
  };
  box._anim = requestAnimationFrame(step);
}

function toggleSection(sec, g) {
  const body = g.querySelector('.group-body');
  const opening = !g.classList.contains('open');
  if (sec.id === '__pinned') data.ui.pinnedCollapsed = !opening;
  else if (sec.id === HISTORY) data.ui.historyOpen = opening;
  else if (sec.isGroup) findGroup(sec.id).collapsed = !opening;
  else data.ui.ungroupedCollapsed = !opening;
  save();
  g.classList.toggle('open', opening);
  if (searchText) return renderSidebar();
  if (opening) {
    body.style.display = 'block';
    const full = body.scrollHeight;
    animateHeight(body, 0, full, () => { body.style.display = ''; renderSidebar(); });
  } else {
    body.style.display = 'block';
    animateHeight(body, body.scrollHeight, 0, () => { body.style.display = ''; renderSidebar(); });
  }
}

// 分组里还没看的对话：取最要紧的那种（出错 > 等你处理 > 完成）
function unreadOf(list) {
  const u = list.filter((x) => x.unread && !live[x.id]);
  if (!u.length) return null;
  const kind = u.some((x) => x.unread === 'error') ? 'error' : u.some((x) => x.unread === 'ask') ? 'ask' : 'done';
  return { n: u.length, kind };
}

function renderSidebar() {
  const tree = $('#tree');
  const keepScroll = tree.scrollTop;
  tree.innerHTML = '';
  const sections = [];
  if (sortedSessions('__pinned').length) sections.push({ id: '__pinned', name: '置顶', open: !data.ui.pinnedCollapsed, isGroup: false, pinned: true });
  sections.push(...data.groups.map((g) => ({ id: g.id, name: g.name, open: !g.collapsed, isGroup: true })));
  sections.push({ id: null, name: data.groups.length ? '未分组' : '对话', open: !data.ui.ungroupedCollapsed, isGroup: false });
  // 历史版本放最后，默认收起；正在看的那个在里面时自动展开
  const hist = sortedSessions(HISTORY);
  if (hist.length) sections.push({ id: HISTORY, name: '历史版本', open: !!data.ui.historyOpen || hist.some((x) => x.id === currentId), isGroup: false, history: true });

  for (const sec of sections) {
    const list = sortedSessions(sec.id);
    if (searchText && !list.length) continue;
    const open = searchText ? true : sec.open;
    const g = el('div', 'group' + (open ? ' open' : '') + (sec.pinned ? ' pinned' : ''));
    const head = el('div', 'group-head');
    // 有没看过的回复：右边数字换成彩色角标（像聊天软件的未读数），颜色按最要紧的那种
    const un = unreadOf(list);
    const pends = typeof pendingOf === 'function' ? list.filter((x) => pendingOf(x)) : [];
    const badge = pends.length
      ? `<span class="gbadge ask${pends.some((x) => pendingFresh(x)) ? ' blink' : ''}" title="${pends.length} 个对话在等你做选择">${pends.length}</span>`
      : un
        ? `<span class="gbadge ${un.kind}" title="${un.n} 个对话有新消息还没看">${un.n}</span>`
        : `<span class="count">${list.length || ''}</span>`;
    // 分组标题：文件夹图标（置顶是图钉、未分组是对话图标）+ 加粗名字，组里的对话缩进挂在左边一条竖线上
    const gico = sec.pinned ? 'pin' : sec.history ? 'history' : sec.isGroup ? 'folder' : 'chat';
    // 组里有对话正在跑：名字后面一个转圈 + 个数，折叠着也看得到
    const runs = list.filter((x) => live[x.id]).length;
    const grun = runs ? `<span class="grun" title="${runs} 个对话正在运行"><i></i>${runs > 1 ? runs : ''}</span>` : '';
    head.innerHTML = `<span class="chev">${icon('chevron')}</span><span class="gico${sec.isGroup ? ' grp' : ''}">${icon(gico)}</span><span class="gname">${esc(sec.name)}</span>${grun}${badge}`;
    const acts = el('span', 'gact');
    if (sec.history) head.title = '编辑前、回退前另存的对话，和还没用过的分支。在里面接着发消息就会回到原来的分组';
    if (!sec.pinned && !sec.history) {
      const addBtn = el('button', 'mini-btn', icon('plus'));
      addBtn.title = '在这里新建对话';
      addBtn.onclick = (e) => { e.stopPropagation(); startNewChat(sec.id); };
      acts.appendChild(addBtn);
    }
    if (sec.isGroup) {
      const moreBtn = el('button', 'mini-btn', icon('more'));
      moreBtn.title = '分组操作';
      moreBtn.onclick = (e) => { e.stopPropagation(); groupMenu(sec.id, e); };
      acts.appendChild(moreBtn);
      head.oncontextmenu = (e) => { e.preventDefault(); groupMenu(sec.id, e); };
    }
    if (acts.childNodes.length) head.appendChild(acts);
    head.onclick = () => toggleSection(sec, g);
    // 拖动对话到分组上（拖到「置顶」就是置顶）
    head.ondragover = (e) => { e.preventDefault(); head.classList.add('drop-target'); };
    head.ondragleave = () => head.classList.remove('drop-target');
    // 分组本身可以拖动排序（置顶区、未分组位置固定）
    if (sec.isGroup) {
      head.draggable = true;
      head.ondragstart = (e) => { e.dataTransfer.setData('text/group', sec.id); e.dataTransfer.effectAllowed = 'move'; g.classList.add('dragging'); };
      head.ondragend = () => g.classList.remove('dragging');
    }
    head.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/group')) return;
      head.classList.remove('drop-target');
      if (!sec.isGroup) return;
      const r = head.getBoundingClientRect();
      head.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      head.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    });
    head.addEventListener('dragleave', () => head.classList.remove('drop-before', 'drop-after'));
    head.ondrop = (e) => {
      e.preventDefault();
      head.classList.remove('drop-target');
      const gid = e.dataTransfer.getData('text/group');
      if (gid) {
        const after = head.classList.contains('drop-after');
        head.classList.remove('drop-before', 'drop-after');
        if (!sec.isGroup || gid === sec.id) return;
        const moving = data.groups.find((x) => x.id === gid);
        if (!moving) return;
        data.groups = data.groups.filter((x) => x !== moving);
        data.groups.splice(data.groups.findIndex((x) => x.id === sec.id) + (after ? 1 : 0), 0, moving);
        save();
        return renderSidebar();
      }
      const sid = e.dataTransfer.getData('text/session');
      if (!sid) return;
      if (sec.pinned) { const x = findSession(sid); if (x && !x.pinned) togglePin(sid); return; }
      if (sec.history) return toHistory(sid);
      const x = findSession(sid);
      if (x && x.pinned) { x.pinned = false; delete x.order; }
      moveSession(sid, sec.id);
    };
    g.appendChild(head);

    const body = el('div', 'group-body');
    if (!list.length) body.appendChild(el('div', 'group-empty', sec.isGroup ? '把对话拖到这里' : '还没有对话'));
    for (const s of list) body.appendChild(renderItem(s));
    g.appendChild(body);
    tree.appendChild(g);
  }
  tree.scrollTop = keepScroll;
  if (typeof renderPendingChip === 'function') renderPendingChip();
}

// 侧栏里「刚完成还没看」的点：绿色完成、红色出错、橙色在等你处理
const UNREAD_TEXT = { done: '刚完成，还没看', error: '出错了，还没看', ask: '在等你处理' };

function renderItem(s) {
  const it = el('div', 'item' + (s.id === currentId ? ' active' : ''));
  it.dataset.sid = s.id;
  it.draggable = true;
  it.title = s.title;
  const pend = typeof pendingOf === 'function' && pendingOf(s);
  if (pend) {
    // 在等你选择 / 批准：没看过就一直闪，看过后留标记，回答完消失
    it.classList.add('pending');
    if (pendingFresh(s)) it.classList.add('blink');
    it.appendChild(el('span', 'unread-dot ask'));
  } else if (live[s.id]) it.appendChild(el('span', 'running-dot'));
  else if (s.unread) {
    // 刚完成 / 出错 / 等你处理，还没点开看过
    const dot = el('span', 'unread-dot ' + s.unread);
    dot.title = UNREAD_TEXT[s.unread] || '';
    it.appendChild(dot);
    it.classList.add('unread');
  }
  const nm = el('span', 'iname', esc(s.title || '新对话'));
  nm.ondblclick = (e) => { e.stopPropagation(); inlineRename(s.id, nm); };
  it.appendChild(nm);
  if (pend) it.appendChild(el('span', 'pend-tag', pend.kind === 'plan' ? '待批准' : pend.kind === 'perm' ? '待允许' : '待选择'));
  const more = el('button', 'mini-btn more', icon('more'));
  more.onclick = (e) => { e.stopPropagation(); sessionMenu(s.id, e); };
  it.appendChild(more);
  it.onclick = () => openSession(s.id);
  it.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(s.id, e); };
  it.ondragstart = (e) => {
    e.dataTransfer.setData('text/session', s.id);
    e.dataTransfer.effectAllowed = 'move';
    it.classList.add('dragging');
  };
  it.ondragend = () => it.classList.remove('dragging');
  // 拖到另一个对话上：上半部分放到它前面，下半部分放到它后面（搜索时只显示一部分，不排序）
  const where = (e) => { const r = it.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  it.ondragover = (e) => {
    if (searchText || ![...e.dataTransfer.types].includes('text/session')) return;
    e.preventDefault();
    e.stopPropagation();
    const after = where(e);
    it.classList.toggle('drop-after', after);
    it.classList.toggle('drop-before', !after);
  };
  it.ondragleave = () => it.classList.remove('drop-before', 'drop-after');
  it.ondrop = (e) => {
    const sid = e.dataTransfer.getData('text/session');
    it.classList.remove('drop-before', 'drop-after');
    if (!sid || searchText) return;
    e.preventDefault();
    e.stopPropagation();
    reorderSession(sid, s.id, where(e));
  };
  return it;
}

function moveSession(sid, groupId) {
  const s = findSession(sid);
  if (!s) return;
  delete s.history;
  s.groupId = groupId;
  s.pinned = false; // 移到某个分组 = 不再置顶
  delete s.order; // 拖到分组标题上：放到那个分组的最上面
  if (groupId) findGroup(groupId).collapsed = false;
  save();
  renderSidebar();
  renderTitle();
}

// 放进 / 拿出「历史版本」（groupId 不动，拿出来就回到原来的分组）
function toHistory(sid, kind) {
  const s = findSession(sid);
  if (!s) return;
  s.history = { kind: kind || 'manual', at: Date.now() };
  s.pinned = false;
  delete s.order;
  save();
  renderSidebar();
}
function fromHistory(sid) {
  const s = findSession(sid);
  if (!s || !s.history) return;
  delete s.history;
  delete s.order;
  save();
  renderSidebar();
  const g = s.groupId && findGroup(s.groupId);
  toast(`已放回「${g ? g.name : data.groups.length ? '未分组' : '对话'}」`);
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
  // 放不下时在菜单里滚动：向上弹的不盖住按钮，其余不超出窗口
  m.style.maxHeight = Math.max(160, (e.above != null ? e.above - 14 : window.innerHeight - 16)) + 'px';
  m.classList.remove('hidden');
  m.scrollTop = 0;
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
    { text: s.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => togglePin(sid) },
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
  if (s.groupId && !s.history) items.push({ text: '移出分组', icon: 'back', onClick: () => moveSession(sid, null) });
  items.push({ text: '新建分组并移入', icon: 'folderPlus', onClick: async () => {
    const g = await createGroup();
    if (g) moveSession(sid, g.id);
  } });
  items.push('-', s.history ? { text: '放回原来的分组', icon: 'back', onClick: () => fromHistory(sid) } : { text: '放进历史版本', icon: 'history', onClick: () => toHistory(sid) });
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
      syncTitle(s);
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

// 名称同步到服务器上的 Claude Code 会话（终端里 claude --resume 看到的也是这个名字）；还没开始的对话不用
function syncTitle(s, auto) {
  if (!s || !s.started || !s.claudeId) return;
  const srv = s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
  api.claudeRename({ claudeId: s.claudeId, title: s.title, auto: !!auto, server: srv ? pickServer(srv) : null }).then((r) => {
    if (!r.ok && !auto) toast('名称已改，但没能同步到服务器：' + r.message, 4000);
  });
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
  syncTitle(s);
}

async function deleteSession(sid) {
  const s = findSession(sid);
  if (live[sid]) return toast('这个对话还在回复，请先停止');
  const ok = await confirmModal('删除对话', `确定删除「${s.title}」吗？删除后无法恢复。`, '删除');
  if (!ok) return;
  data.sessions = data.sessions.filter((x) => x.id !== sid);
  clearDraft(sid);
  if (currentId === sid) { currentId = null; draftKey = null; useDraftFor(null); }
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

// 很长的对话只画一段：打开时画最后 MSG_PAGE 条，滚到顶自动补更早的、滚到底补后面的；
// 时间轴跳到很早的地方时只画那附近一段。几千条的会话也不会一次塞进几千个节点卡死
const MSG_PAGE = 40;
const msgWin = { start: 0, end: 0 };

function renderMessages() {
  const s = findSession(currentId);
  const n = s ? s.messages.length : 0;
  renderMsgRange(Math.max(0, n - MSG_PAGE), n);
  scrollToBottom(true);
  unseenNew = false;
  if (typeof updateToBottom === 'function') updateToBottom();
}

function renderMsgRange(a, b) {
  const box = $('#messages');
  box.innerHTML = '';
  const s = findSession(currentId);
  $('#empty').classList.toggle('hidden', !!(s && s.messages.length));
  $('#greeting').textContent = greeting();
  msgWin.start = a;
  msgWin.end = b;
  if (!s) return;
  const top = el('div', 'msg-edge top');
  top.id = 'msg-top';
  top.onclick = () => extendMsgs(-1);
  box.appendChild(top);
  const frag = document.createDocumentFragment();
  for (let i = a; i < b; i++) frag.appendChild(renderMessage(s, s.messages[i], i));
  box.appendChild(frag);
  const bottom = el('div', 'msg-edge bottom');
  bottom.id = 'msg-bottom';
  bottom.onclick = () => { renderMessages(); if (typeof timeline !== 'undefined') timeline.sync(true); };
  box.appendChild(bottom);
  renderMsgEdges(s);
}

function renderMsgEdges(s) {
  const top = $('#msg-top');
  const bottom = $('#msg-bottom');
  if (!top || !s) return;
  top.classList.toggle('hidden', msgWin.start <= 0);
  top.textContent = `更早的 ${msgWin.start} 条消息 · 往上滚自动加载`;
  const after = s.messages.length - msgWin.end;
  bottom.classList.toggle('hidden', after <= 0);
  bottom.textContent = `后面还有 ${after} 条消息 · 点这里回到最新`;
}

// 往上（dir<0）或往下补一页；往上补时保持眼前看到的内容不动
function extendMsgs(dir) {
  const s = findSession(currentId);
  if (!s) return;
  const box = $('#messages');
  const frag = document.createDocumentFragment();
  if (dir < 0) {
    if (msgWin.start <= 0) return;
    const a = Math.max(0, msgWin.start - MSG_PAGE);
    for (let i = a; i < msgWin.start; i++) frag.appendChild(renderMessage(s, s.messages[i], i));
    const sc = $('#scroller');
    const h0 = sc.scrollHeight;
    const t0 = sc.scrollTop;
    $('#msg-top').after(frag);
    sc.scrollTop = t0 + (sc.scrollHeight - h0);
    msgWin.start = a;
  } else {
    const n = s.messages.length;
    if (msgWin.end >= n) return;
    const b = Math.min(n, msgWin.end + MSG_PAGE);
    for (let i = msgWin.end; i < b; i++) frag.appendChild(renderMessage(s, s.messages[i], i));
    box.insertBefore(frag, $('#msg-bottom'));
    msgWin.end = b;
  }
  renderMsgEdges(s);
}

// 确保第 i 条消息画出来了（时间轴、后台任务跳转用）：就在附近就补上，离得远就只画它附近一段
function ensureMsgRendered(i) {
  const s = findSession(currentId);
  if (!s || i < 0 || i >= s.messages.length) return null;
  if (i < msgWin.start || i >= msgWin.end) {
    if (i >= msgWin.start - MSG_PAGE && i < msgWin.start) extendMsgs(-1);
    else if (i < msgWin.end + MSG_PAGE && i >= msgWin.end) extendMsgs(1);
    else renderMsgRange(Math.max(0, i - 10), Math.min(s.messages.length, i + 30));
  }
  return $('#messages').querySelector(`:scope > .msg[data-index="${i}"]`);
}

// 「回到底部」按钮（照着 Claude 的做法）：往上翻、离底部超过半屏才出现在输入框正上方，回到底部附近就消失；
// Claude 正在回复而你在上面看时带个小点，提示下面有新内容；点一下平滑滚到底（时间轴跳到很早的地方时直接回到最新）
const toBottomBtn = el('button', 'to-bottom hidden', `${icon('down')}<i class="tb-dot"></i>`);
toBottomBtn.title = '回到最新';
$('#composer-wrap').appendChild(toBottomBtn);
let unseenNew = false;
function updateToBottom(newContent) {
  const sc = $('#scroller');
  const s = findSession(currentId);
  const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  const behind = !!(s && msgWin.end < s.messages.length);
  const away = !!s && (behind || gap > Math.max(240, sc.clientHeight * 0.5));
  if (gap < 120 && !behind) unseenNew = false;
  else if (newContent && (away || gap > 120)) unseenNew = true;
  toBottomBtn.classList.toggle('hidden', !away);
  toBottomBtn.classList.toggle('new', away && unseenNew);
  toBottomBtn.title = unseenNew ? '有新内容，回到最新' : '回到最新';
}
toBottomBtn.onclick = () => {
  const s = findSession(currentId);
  unseenNew = false;
  if (s && msgWin.end < s.messages.length) {
    renderMessages();
    if (typeof timeline !== 'undefined') timeline.sync(true);
  } else {
    const sc = $('#scroller');
    followBottom = true;
    sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }
  $('#input').focus();
};

let msgScrollQueued = false;
$('#scroller').addEventListener('scroll', () => {
  if (msgScrollQueued) return;
  msgScrollQueued = true;
  requestAnimationFrame(() => {
    msgScrollQueued = false;
    const sc = $('#scroller');
    const s = findSession(currentId);
    if (!s) return;
    if (sc.scrollTop < 400 && msgWin.start > 0) extendMsgs(-1);
    else if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 400 && msgWin.end < s.messages.length) extendMsgs(1);
    updateToBottom();
  });
}, { passive: true });

// ---------- 回复中的状态行：呼吸的圆点 + 在干什么 + 用了多久，有内容时可以展开看 ----------
// 圆点：思考时一大一小地呼吸；在操作时平滑张开成转动的圆环。整行在流式重画时沿用同一个节点，动画不会被打断
const ORB_HTML = '<span class="orb"><span class="orb-dot"><i></i></span><span class="orb-ring"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/></svg></span></span>';
const LIVE_ST_KEY = {};
const unjson = (t) => String(t || '').replace(/\\n/g, '\n').replace(/\\t/g, '  ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
function liveStatusInfo(s, last, idle) {
  const lv = live[s.id] || {};
  const lab = (name, input) => {
    const [, label, sum] = TOOL_LABELS[name] || mcpLabel(name) || ['', name, () => ''];
    let sub = '';
    try { sub = input ? String(sum(input) || '') : ''; } catch (_) {}
    return { label, sub };
  };
  if (last && last.type === 'tool' && last.status === 'running') {
    const { label, sub } = lab(last.name, last.input);
    const cmd = last.name === 'Bash' && last.input ? last.input.command : '';
    return { kind: 'act', key: 'tool:' + last.id, since: last.startedAt, label: `正在操作：${label}`, sub,
      body: cmd || sub, note: '命令运行过程中的输出 Claude 不往外传，结束后会显示在上面的卡片里' };
  }
  if (lv.draft) {
    const { label } = lab(lv.draft.name);
    const n = lv.draft.chars;
    return { kind: 'act', key: 'draft:' + lv.draft.name, label: `正在准备操作：${label}`, sub: lv.draft.hint,
      extra: n ? `已写 ${n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : n} 字` : '', body: unjson(lv.draft.tail), note: '写完后会出现在上面的卡片里' };
  }
  if (lv.thinking || !idle) {
    return { kind: 'breath', key: 'think', label: '思考中', body: lv.thinkText || '',
      note: lv.thinkText ? '' : '这一段思考 Claude 没有给出文字（只给了加密内容），它仍在思考' };
  }
  // 这一轮还没结束、又没有新内容：多半在等后台的子助手或命令，说清楚在等谁
  const tasks = s.messages.flatMap((m) => m.tasks || []).filter((t) => t.status === 'running');
  if (tasks.length) {
    const t = tasks[0];
    const what = (t.desc || (t.kind === 'agent' ? '子助手' : '后台命令')).replace(/\s+/g, ' ');
    const prog = typeof taskProgressText === 'function' && t.progress ? taskProgressText(t.progress) : '';
    return { kind: 'act', key: 'wait:' + tasks.map((x) => x.id).join(), since: t.revived || t.start, label: tasks.length > 1 ? `在等后台的 ${tasks.length} 个任务` : `在等${t.kind === 'agent' ? '子助手' : '后台命令'}`, sub: what,
      body: tasks.map((x) => `${x.kind === 'agent' ? '子助手' : '命令'}：${(x.desc || '').slice(0, 120)}${x.progress && typeof taskProgressText === 'function' ? '\n  ' + taskProgressText(x.progress) : ''}`).join('\n'), note: prog ? '' : '点输入框下面的「后台任务」可以看实时输出、或者停掉它' };
  }
  return { kind: 'breath', key: 'idle', label: 'Claude 还在继续', body: '', note: '这一轮还没结束（还没收到 Claude 的结束信号），也没有在跑的后台任务；它可能在想下一步。等太久可以点右下角的停止' };
}
function liveStatus(s, last, idle, keep) {
  const lv = live[s.id] || {};
  const info = liveStatusInfo(s, last, idle);
  if (lv.lsKey !== info.key) { lv.lsKey = info.key; lv.lsAt = Date.now(); }
  const old = keep && keep.get(LIVE_ST_KEY);
  const node = old || el('div', 'live-st', `${ORB_HTML}<div class="ls-main"><button class="ls-h"><span class="ls-l"></span><span class="ls-s"></span><span class="ls-x"></span><span class="ls-t"></span><span class="ls-c">${icon('chevron')}</span></button><div class="ls-b"><pre></pre><div class="ls-n"></div></div></div>`);
  if (!old) {
    node._crBlock = LIVE_ST_KEY;
    node.querySelector('.ls-h').onclick = () => {
      if (!node.classList.contains('has-body')) return;
      const lv2 = live[s.id];
      if (lv2) lv2.lsOpen = !lv2.lsOpen;
      node.classList.toggle('open', !!(lv2 && lv2.lsOpen));
    };
  }
  node.dataset.kind = info.kind;
  node._since = info.since || lv.lsAt;
  node.querySelector('.ls-l').textContent = info.label;
  node.querySelector('.ls-s').textContent = info.sub ? info.sub.replace(/\s+/g, ' ').slice(0, 80) : '';
  node.querySelector('.ls-x').textContent = info.extra || '';
  const hasBody = !!(info.body || info.note);
  node.classList.toggle('has-body', hasBody);
  node.classList.toggle('open', hasBody && !!lv.lsOpen);
  const pre = node.querySelector('pre');
  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  const body = info.body.length > 6000 ? '…' + info.body.slice(-6000) : info.body;
  if (pre.textContent !== body) { pre.textContent = body; if (atEnd) pre.scrollTop = pre.scrollHeight; }
  pre.hidden = !body;
  node.querySelector('.ls-n').textContent = info.note || '';
  updateLiveStatusTime(node);
  if (!old) return node;
  const ph = document.createComment('');
  ph._keep = old;
  return ph;
}
function updateLiveStatusTime(node) {
  const t = node._since ? Date.now() - node._since : 0;
  node.querySelector('.ls-t').textContent = t >= 1000 && typeof fmtDur === 'function' ? fmtDur(t) : '';
}
setInterval(() => { if (!winHidden) document.querySelectorAll('#messages .live-st').forEach(updateLiveStatusTime); }, 1000);

// keep：流式重画时传进来的「段落 → 画面上已有的节点」，文字没变的段落直接沿用旧节点（见 liveRender）
function renderMessage(s, m, index, keep) {
  if (m.role === 'user') {
    const w = el('div', 'msg user');
    w.dataset.index = index;
    if (m.files && m.files.length) {
      const f = el('div', 'msg-files');
      for (const file of m.files) {
        // 图片带缩略图；点一下在右边预览（文件在服务器上）
        const c = el('span', 'chip' + (file.thumb ? ' has-thumb big' : '') + (file.remotePath ? ' link' : ''), `${file.thumb ? `<img class="chip-thumb" src="${file.thumb}" alt="" />` : icon('file')}<span class="cname">${esc(file.name)}</span>`);
        if (file.remotePath && typeof openFile === 'function') { c.title = '点击预览：' + file.remotePath; c.onclick = () => openFile(file.remotePath); }
        f.appendChild(c);
      }
      w.appendChild(f);
    }
    if (m.text) w.appendChild(el('div', 'bubble', esc(m.text)));
    if (m.merged) w.appendChild(el('div', 'merged-tag', '回复进行中发送：Claude 会在下一步读到，并到当前的工作里一起处理'));
    w.appendChild(msgActions(s, m, index, !live[s.id]));
    return w;
  }
  const w = el('div', 'msg assistant');
  w.dataset.index = index;
  for (const b of m.blocks) {
    if (b.type === 'text') {
      const old = keep && keep.get(b);
      if (old && old._crText === b.text) {
        const ph = document.createComment('');
        ph._keep = old;
        w.appendChild(ph);
        continue;
      }
      const node = renderMarkdown(b.text);
      node._crBlock = b;
      node._crText = b.text;
      w.appendChild(node);
    }
    else if (b.type === 'tool') {
      w.appendChild(renderTool(b, (m.tasks || []).find((t) => t.toolId === b.id)));
      if (b.perm && typeof renderPerm === 'function') w.appendChild(renderPerm(b));
    }
  }
  const isLast = index === s.messages.length - 1;
  // 后台任务可能是之前的回复启动的：整个对话一起算
  const running = s.messages.flatMap((x) => x.tasks || []).filter((t) => t.status === 'running');
  if (isLast && live[s.id] && live[s.id].replied && !live[s.id].thinking) {
    // 主回复已经结束，Claude 还在等后台任务，任务结束后会接着在这条回复里汇报
    const tip = running.length ? `回复完成，后台还有 ${running.length} 个任务在运行，结束后 Claude 会接着汇报` : '后台任务已结束，Claude 正在整理结果…';
    const row = el('div', 'thinking bg-wait', `${ORB_HTML}<span>${tip}</span>`);
    if (running.length) {
      const b = el('button', 'link-btn', '查看后台任务');
      b.onclick = () => openTasksPanel();
      row.appendChild(b);
    }
    w.appendChild(row);
  } else if (isLast && live[s.id]) {
    const last = m.blocks[m.blocks.length - 1];
    const asking = (last && last.name === 'AskUserQuestion' && last.ask && last.ask.state === 'pending') || m.blocks.some((b) => b.perm && b.perm.state === 'pending');
    // 最后一段是文字、又好几秒没有新内容：Claude 其实还在这一轮里（在想下一步、在等别的助手），给个提示，免得看着像结束了
    const idle = last && last.type === 'text' && live[s.id].lastAt && Date.now() - live[s.id].lastAt > 3000;
    if (live[s.id].status === 'compacting') w.appendChild(compactProgress(live[s.id]));
    else if (!asking && (!last || last.type !== 'text' || live[s.id].thinking || live[s.id].draft || idle || running.length)) w.appendChild(liveStatus(s, last, idle || running.length > 0, keep));
  }
  if (m.outputs && m.outputs.length) w.appendChild(renderOutputs(m.outputs));
  if (m.stopped) w.appendChild(el('div', 'note', '已停止'));
  if (m.error) {
    const box = el('div', 'err-box', `${icon('alert')}<span>${esc(m.error)}</span>`);
    if (/登录已失效|重新授权|「登录 Claude」/.test(m.error)) {
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
    box.insertBefore(w, $('#msg-bottom'));
  }
}

function msgText(m) {
  if (m.role === 'user') return m.text || '';
  return m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

// 消息时间：今天只显示时分，昨天、今年、更早依次带上日期
function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 消息下面一行：时间（回复还带用时）一直显示；按钮鼠标移上去才出现。buttons=false 时只有时间
function msgActions(s, m, index, buttons = true) {
  const bar = el('div', 'msg-acts');
  const meta = [];
  if (m.ts) meta.push(`<span title="${esc(new Date(m.ts).toLocaleString('zh-CN'))}">${esc(fmtMsgTime(m.ts))}</span>`);
  if (m.role === 'assistant' && m.ts && m.doneAt && typeof fmtDur === 'function') meta.push(`<span>${m.stopped ? '已停止，' : ''}用时 ${esc(fmtDur(m.doneAt - m.ts))}</span>`);
  if (meta.length) bar.appendChild(el('span', 'msg-meta', meta.join('<i>·</i>')));
  if (!buttons) return bar;
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
    // 按钮挨着「复制」，容易点错：先确认（输入 /fork 是自己打的命令，不用确认）
    add('branch', '从这里分支', async () => {
      const ok = await modal({
        title: '从这里分支？',
        body: `<p style="margin:4px 0 8px">会新开一个对话，带着到这条回复为止的内容，从这里接着聊。原对话不受影响。</p>`,
        buttons: [{ text: '取消', value: false }, { text: '分出新对话', cls: 'primary', value: true }],
      });
      if (ok) branchFrom(s.id, index);
    }, false, '从这条回复分出一个新对话，原对话不受影响（会先确认）');
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
  // 原来的完整对话另存一份，放进「历史版本」，不在分组里越积越多
  const backup = { ...clone(s), id: uid(), title: `${s.title}${suffix}`, claudeId: s.claudeId || s.id, pendingFork: s.pendingFork || null, updatedAt: Date.now() - 1, pinned: false, history: { kind: opts.text == null ? 'rewind' : 'edit', at: Date.now() } };
  delete backup.order;
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
    toast(`已按修改后的内容重新发送，原对话另存在侧栏最下面的「历史版本」里`, 4000);
    return sendMessage();
  }
  $('#input').focus();
  toast('已回退，原对话另存在侧栏最下面的「历史版本」里', 4000);
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
    serverId: s.serverId || data.currentServer || null,
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
    // 先放在「历史版本」里：在分支里发了消息才算要接着用，自动回到原来的分组；没用过的就一直待在历史版本里
    history: { kind: 'branch', at: Date.now() },
  };
  b.claudeId = b.id;
  data.sessions.push(b);
  save();
  openSession(b.id);
  toast('已从这里分出新对话，原对话不受影响。在分支里发了消息，它就会回到原来的分组', 5000);
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
  ExitPlanMode: ['list', '计划', () => ''],
};

// task：这次调用对应的后台任务（后台运行的命令、派出的助手），没有则为空
// 工具结果里的授权 / 登录链接（飞书授权、OAuth、设备码登录等）：Claude 往往紧接着就在等你授权，
// 链接藏在折叠的卡片里就像卡住了，所以单独拿出来放在卡片下面
// 只认真的要你去浏览器点一下的链接，别把命令输出里路过的网址都当成授权（曾把本地调试服务的 /login 接口当成要授权）：
// 1) 链接本身带 OAuth / 设备码的明显特征才算；只带 login、auth、verify 这类弱特征时，输出里还得有「请打开 / 浏览器 / 授权 / open this url」之类的话
// 2) 本机 / 内网 / 自己项目的域名不算：Claude 跑在服务器上，你的浏览器打不开它的 localhost；自己调试服务的登录接口更不是在等你
const AUTH_STRONG_RE = /oauth|\/authorize\b|response_type=|client_id=|\/authen\b|device[_-]?code|user[_-]?code|verification[_-]?uri|\/login\/device/i;
const AUTH_WEAK_RE = /authen|authoriz|\/auth\b|\/login\b|signin|sign-in|verification|verify/i;
const AUTH_HINT_RE = /open (this |the |that )?(url|link|page)|visit|navigate to|go to|in (your |a |the )?browser|打开|浏览器|授权|扫码|登录以|complete (the )?(sign.?in|authoriz|login)|verification code|user code|device code|enter (the |this )?code/i;
// 3) 而且只认这几家会真的让你去浏览器授权的服务：飞书、Claude，以及 GitHub / Google / 微软的登录页。别的域名一律不弹
const AUTH_HOST_RE = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com|claude\.ai|claude\.com|anthropic\.com|github\.com|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)$/i;
function authLinks(text) {
  const str = String(text || '');
  const urls = str.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  const hinted = AUTH_HINT_RE.test(str);
  return [...new Set(urls.map((u) => u.replace(/[),.;]+$/, '')))].filter((u) => {
    let host = '';
    try { host = new URL(u).hostname; } catch (_) { return false; }
    if (!AUTH_HOST_RE.test(host)) return false;
    return AUTH_STRONG_RE.test(u) || (hinted && AUTH_WEAK_RE.test(u));
  }).slice(0, 2);
}

function renderAuthCard(url) {
  let host = url;
  try { host = new URL(url).host; } catch (_) {}
  const box = el('div', 'auth-card', `${icon('globe')}<div class="ac-main"><b>需要你在浏览器里完成授权</b><span>${esc(host)} · 授权后 Claude 会自动继续</span></div>`);
  const open = el('button', 'btn primary', '在浏览器中打开');
  open.onclick = () => api.openExternal(url);
  const copy = el('button', 'btn', '复制链接');
  copy.onclick = () => { navigator.clipboard.writeText(url); toast('链接已复制'); };
  box.append(open, copy);
  return box;
}

// MCP 工具名 mcp__服务器__工具 → 「MCP · 服务器」+ 工具名
function mcpLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? ['plug', `MCP · ${m[1]}`, () => m[2].replace(/_/g, ' ')] : null;
}

function renderTool(b, task) {
  if (b.name === 'AskUserQuestion' && typeof renderAsk === 'function') return renderAsk(b);
  if (b.name === 'ExitPlanMode' && typeof renderPlan === 'function') return renderPlan(b);
  if (b.status !== 'running' && b.preview && !b.sub) {
    const links = authLinks(b.preview);
    if (links.length) {
      const wrap = el('div', 'tool-wrap');
      const inner = renderToolCard(b, task);
      wrap.appendChild(inner);
      links.forEach((u) => wrap.appendChild(renderAuthCard(u)));
      return wrap;
    }
  }
  return renderToolCard(b, task);
}

function agentModel(b) {
  if (b.model) return prettyModel(b.model);
  const m = b.input && b.input.model;
  if (m) return /^claude-/.test(m) ? prettyModel(m) : m.charAt(0).toUpperCase() + m.slice(1);
  return '同主对话模型';
}

function renderToolCard(b, task) {
  const [ico, label, sum] = TOOL_LABELS[b.name] || mcpLabel(b.name) || ['spark', b.name, (i) => JSON.stringify(i)];
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
  // 子代理用的模型：交回结果后是实际型号，之前是派出时指定的（没指定就和主对话一样）
  const mtag = isAgent ? `<span class="ttag model" title="${esc(b.model ? '实际使用：' + b.model : b.input && b.input.model ? '派出时指定：' + b.input.model : '没有指定，和主对话用同一个模型')}">${esc(agentModel(b))}</span>` : '';
  head.innerHTML = `${icon(ico)}<span class="tlabel">${esc(label)}</span>${mtag}${tag}<span class="tsum">${esc(String(summary).split('\n')[0] + extra)}</span>`;
  // 读、写、改文件的卡片：右上角「预览」直接在右边打开那个文件
  const fp = b.input && b.input.file_path;
  if (fp && /^(Read|Write|Edit|MultiEdit)$/.test(b.name) && typeof openFile === 'function') {
    const pv = el('button', 'tprev', `${icon('eye')}<span>预览</span>`);
    pv.title = '在右边预览这个文件';
    pv.onclick = (e) => { e.stopPropagation(); openFile(fp); };
    head.appendChild(pv);
  }
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

// 压缩上下文：Claude 不报进度，只能按上下文大小估个时间（越大越久），显示已用时间 + 预估进度条
function compactEta(lv) {
  const ctx = lv.compactCtx || 0;
  return Math.min(180, Math.max(30, 20 + ctx / 4000));
}
function compactProgress(lv) {
  const box = el('div', 'compact-prog');
  box.innerHTML = '<div class="cp-h"><span class="spin"></span><b>正在压缩上下文</b><span class="cp-t"></span></div><div class="cp-bar"><i></i></div><div class="cp-n">Claude 正在把之前的对话总结成摘要，完成后会自动接着干活。进度条是按上下文大小估的，Claude 不汇报真实进度。</div>';
  updateCompactProgress(box, lv);
  return box;
}
function updateCompactProgress(box, lv) {
  const t = (Date.now() - (lv.compactAt || Date.now())) / 1000;
  const eta = compactEta(lv);
  // 前面匀速，接近预估时间后越走越慢，永远不到头（真完成了这块会直接消失）
  const p = t < eta * 0.8 ? t / eta : 0.8 + 0.17 * (1 - Math.exp(-(t - eta * 0.8) / eta));
  const sec = (x) => (x < 60 ? `${Math.round(x)} 秒` : `${Math.floor(x / 60)} 分 ${Math.round(x % 60)} 秒`);
  box.querySelector('.cp-bar i').style.width = (p * 100).toFixed(1) + '%';
  box.querySelector('.cp-t').textContent = t > eta ? `已用 ${sec(t)} · 比预估久一些，还在进行` : `已用 ${sec(t)} · 预计约 ${sec(eta)}`;
}

// 正在回复的对话好几秒没新内容：重画一次，显示「Claude 还在继续…」
setInterval(() => {
  const lv = live[currentId];
  if (lv && lv.status === 'compacting') document.querySelectorAll('.compact-prog').forEach((b) => updateCompactProgress(b, lv));
  if (lv && !lv.replied && lv.lastAt && !lv.idleShown && Date.now() - lv.lastAt > 3000) { lv.idleShown = true; scheduleLiveRender(); }
}, 1000);

let renderQueued = false;
// 流式回复：最多每 80 毫秒重画一次（每个字都重画，长回复时很吃 CPU）；窗口最小化时先不画，回来再补
let lastLiveRender = 0;
let winHidden = false;
let hiddenDirty = false;
api.onVisible((v) => {
  winHidden = !v;
  document.body.classList.toggle('win-hidden', winHidden);
  if (!winHidden && hiddenDirty) { hiddenDirty = false; scheduleLiveRender(); }
});
function scheduleLiveRender() {
  if (winHidden) { hiddenDirty = true; return; }
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => requestAnimationFrame(liveRender), Math.max(0, lastLiveRender + 80 - Date.now()));
}
function liveRender() {
  renderQueued = false;
  lastLiveRender = Date.now();
  const s = findSession(currentId);
  if (!s) return;
  const box = $('#messages');
  const idx = s.messages.length - 1;
  if (idx < 0) return;
  // 正在看前面的某一段（时间轴跳过去的）：最新那条不在画面里，只更新「后面还有几条」
  if (idx > msgWin.end) return renderMsgEdges(s);
  if (idx === msgWin.end) msgWin.end++;
  const nearBottom = followBottom;
  const old = box.querySelector(`.msg.assistant[data-index="${idx}"]`);
  // 已经写完的段落（文字没变）沿用画面上的旧节点、原地不动：不用重新排版，正在选中的文字、拖过的表格列宽也不会被冲掉
  const keep = new Map();
  if (old) for (const c of old.children) if (c._crBlock) keep.set(c._crBlock, c);
  const node = renderMessage(s, s.messages[idx], idx, keep);
  if (old) {
    // 保留已展开的工具详情
    const opened = [...old.querySelectorAll('.tool')].map((t) => t.classList.contains('open'));
    node.querySelectorAll('.tool').forEach((t, i) => opened[i] && t.classList.add('open'));
    // 把旧消息改成新内容：沿用的节点留在原处，其余的删掉 / 插进来，顺序和新画的一致
    const want = [...node.childNodes].map((c) => c._keep || c);
    const wantSet = new Set(want);
    for (const c of [...old.childNodes]) if (!wantSet.has(c)) c.remove();
    want.forEach((c, i) => { if (old.childNodes[i] !== c) old.insertBefore(c, old.childNodes[i] || null); });
    old.className = node.className;
  } else box.insertBefore(node, box.querySelector(':scope > .msg.queued') || $('#msg-bottom'));
  if (nearBottom) scrollToBottom();
  updateToBottom(!nearBottom);
}

function isNearBottom() {
  const sc = $('#scroller');
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}
// 跟不跟着最新内容往下滚：你一往上翻（滚轮、拖滚动条、键盘）就不跟了，不和你抢；你自己滚回到底（或点「回到底部」）才接着跟
let followBottom = true;
let autoScrolling = false;
let lastScrollTop = 0;
function scrollToBottom() {
  const sc = $('#scroller');
  autoScrolling = true;
  sc.scrollTop = sc.scrollHeight;
  lastScrollTop = sc.scrollTop;
  followBottom = true;
  requestAnimationFrame(() => { autoScrolling = false; });
}
(() => {
  const sc = $('#scroller');
  sc.addEventListener('wheel', (e) => { if (e.deltaY < 0) followBottom = false; }, { passive: true });
  sc.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) followBottom = false; });
  sc.addEventListener('scroll', () => {
    const st = sc.scrollTop;
    if (!autoScrolling) {
      if (st < lastScrollTop - 2) followBottom = false; // 拖滚动条往上
      if (sc.scrollHeight - st - sc.clientHeight < 24) followBottom = true; // 自己回到了底
    }
    lastScrollTop = st;
  }, { passive: true });
})();

// ---------- 每个对话自己的输入草稿 ----------
// 输入框里还没发的文字和附件跟着对话走：切走时存下，切回来恢复（新对话用 '__new'）。
// 附件对象原样保存（还在上传的也会接着传完）；文字和传好的附件写进 data.ui.drafts，重启后也在
let draftKey = null;
const draftObjs = {};
function useDraftFor(nextId) {
  const next = nextId || '__new';
  const cur = draftKey || '__new';
  if (next === cur && draftKey !== null) return;
  data.ui.drafts = data.ui.drafts || {};
  const text = $('#input').value;
  if (draftKey !== null) {
    draftObjs[cur] = pending;
    const done = pending.filter((p) => p.status === 'done');
    if (text.trim() || done.length) data.ui.drafts[cur] = { text, files: done.map((p) => ({ name: p.name, remotePath: p.remotePath, promptPath: p.promptPath, size: p.size, thumb: p.thumb })) };
    else delete data.ui.drafts[cur];
  }
  const d = data.ui.drafts[next];
  pending = draftObjs[next] || (d && d.files ? d.files.map((f) => ({ ...f, uploadId: uid(), status: 'done' })) : []);
  $('#input').value = d ? d.text || '' : '';
  draftKey = next;
  if (typeof autoGrow === 'function') autoGrow();
  renderAttachments();
  save();
}
// 发出去之后这个对话就没有草稿了
function clearDraft(id) {
  const k = id || '__new';
  if (data.ui.drafts) delete data.ui.drafts[k];
  delete draftObjs[k];
}

function openSession(id) {
  if (typeof showView === 'function') showView('chat');
  useDraftFor(id);
  setTimeout(() => typeof filePane !== 'undefined' && filePane.follow(), 0);
  currentId = id;
  newChatGroup = null;
  if (typeof clearUnread === 'function') clearUnread(id);
  if (typeof seePending === 'function') seePending(findSession(id));
  renderAll();
  if (typeof side !== 'undefined') { side.renderButtons(); side.renderPanel(); }
  $('#input').focus();
}

function startNewChat(groupId) {
  if (typeof showView === 'function') showView('chat');
  useDraftFor(null);
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
  renderSendStop();
  renderQueue();
}

// 回复中：输入框里实时显示这一轮已经用了多久
function renderRunTimer() {
  const t = $('#run-timer');
  if (!t) return;
  const s = currentId && live[currentId] ? findSession(currentId) : null;
  const m = s && s.messages[s.messages.length - 1];
  const on = !!(m && m.role === 'assistant' && m.ts && typeof fmtDur === 'function');
  t.classList.toggle('hidden', !on);
  if (on) t.textContent = '已用 ' + fmtDur(Date.now() - m.ts);
}
setInterval(renderRunTimer, 1000);

// 发送和停止共用一个位置：回复中且输入框是空的显示「停止」，输入了内容就变回「发送」（排队）
function renderSendStop() {
  const running = !!(currentId && live[currentId]);
  $('#composer').classList.toggle('running', running);
  renderRunTimer();
  const hasInput = !!($('#input').value.trim() || pending.length);
  $('#btn-stop').classList.toggle('hidden', !running || hasInput);
  $('#btn-send').classList.toggle('hidden', running && !hasInput);
  $('#btn-send').title = running ? '排队：这一轮回复完自动发出' : pending.some((p) => p.status === 'uploading') ? '文件上传完后自动发送' : '发送';
  $('#btn-send').classList.toggle('queue', running);
}

// ---------- 模型 ----------
// 模型和思考强度都向服务器上的 Claude Code 要（和 /model 一样的列表），按服务器缓存；
// 列表里没有的老模型可以自己填模型 ID
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const EFFORT_DESC = { low: '最快、最省额度', xhigh: '写代码、多步骤任务', max: '最慢、最费额度' };
const currentModel = () => data.settings.model || 'default';
const currentEffort = () => data.settings.effort || '';
const modelsKey = () => (typeof curServer === 'function' && curServer() ? curServer().id : '_');
const modelList = () => ((data.ui.models || {})[modelsKey()] || {}).list || null;
const modelBase = (v) => String(v || '').replace(/\[.*\]$/, '');
// 当前选的模型在列表里对应哪一项（opus 和 opus[1m] 算同一个）
function modelInfo(value) {
  const list = modelList();
  if (!list) return null;
  return list.find((x) => x.value === value) || list.find((x) => modelBase(x.value) === modelBase(value)) || null;
}
// 这个模型能选哪几档强度：列表里写了就按列表；还没读到列表时，除 Haiku 外按常见的五档
function effortLevels(value) {
  const info = modelInfo(value);
  if (info) return info.efforts;
  const v = typeof modelVersion === 'function' ? modelVersion(value) : null;
  if (v) return v.efforts;
  return /haiku/i.test(value) ? [] : ['low', 'medium', 'high', 'xhigh', 'max'];
}
const effortSupported = (value) => effortLevels(value).length > 0;
// 实际要传的强度：当前模型不支持这一档就不传（用默认）
const effortFor = (value) => (effortLevels(value).includes(currentEffort()) ? currentEffort() : '');

async function loadModels(force, quiet) {
  const key = modelsKey();
  const cached = (data.ui.models || {})[key];
  if (!force && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached.list;
  const r = await api.claudeModels();
  if (!r.ok) { if (force && !quiet) toast('读取模型列表失败：' + r.message, 5000); return null; }
  data.ui.models = data.ui.models || {};
  data.ui.models[key] = { list: r.models, at: Date.now() };
  // 斜杠命令和账号也是这一次拿到的
  data.ui.commands = data.ui.commands || {};
  if (r.commands) data.ui.commands[key] = r.commands;
  data.ui.claudeAccount = data.ui.claudeAccount || {};
  if (r.account) data.ui.claudeAccount[key] = r.account;
  save();
  renderModel();
  return r.models;
}

// claude-opus-5-5[1m] -> Opus 5.5；claude-haiku-4-5-20251001 -> Haiku 4.5
function prettyModel(id) {
  const parts = String(id).replace(/\[.*\]$/, '').replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  if (!parts.length) return id;
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.length > 1 ? `${name} ${parts.slice(1).join('.')}` : name;
}

// 输入框旁显示的名字：用实际对应的型号（Opus 5.5、Sonnet 5…）
function modelLabel(value) {
  const info = modelInfo(value);
  if (info && info.resolved) return prettyModel(info.resolved);
  const v = typeof modelVersion === 'function' ? modelVersion(value) : null;
  if (v) return v.name;
  const known = data.ui.modelIds && data.ui.modelIds[value];
  if (known) return prettyModel(known);
  if (value === 'default') return '默认模型';
  return /^claude-/.test(value) ? prettyModel(value) : value.charAt(0).toUpperCase() + value.slice(1);
}

function renderModel() {
  const e = effortFor(currentModel());
  $('#model-name').textContent = modelLabel(currentModel()) + (e ? ' · ' + (EFFORT_LABEL[e] || e) : '');
}

function setModel(id) {
  data.settings.model = id;
  save();
  renderModel();
  const lost = currentEffort() && !effortFor(id);
  toast(`之后的回复改用 ${modelLabel(id)}${lost ? '（这个模型不支持当前的思考强度，按默认处理）' : ''}`);
}

function setEffort(id, quiet) {
  data.settings.effort = id;
  save();
  renderModel();
  if (!quiet) toast(id ? `思考强度改为「${EFFORT_LABEL[id] || id}」，从下一条消息开始生效` : '思考强度恢复默认');
}

async function customModel() {
  const cur = currentModel();
  const id = await promptModal('自定义模型', '填 Claude Code 能识别的模型名，比如 claude-opus-4-6、claude-sonnet-4-6（/model 列表里没有的老模型可以这样用）', modelInfo(cur) ? '' : cur);
  if (id == null) return;
  const v = id.trim();
  if (!/^[a-z0-9.\-\[\]]+$/i.test(v)) return toast('模型名只能包含字母、数字、点、短横线');
  setModel(v);
}

// 模型选择弹窗见 modelpicker.js

// ---------- 附件 ----------
function renderAttachments() {
  if (typeof renderSendStop === 'function') renderSendStop();
  const box = $('#attachments');
  box.innerHTML = '';
  for (const p of pending) {
    const c = el('span', 'chip' + (p.status === 'error' ? ' error' : '') + (p.thumb ? ' has-thumb' : '') + (p.status === 'done' ? ' link' : ''));
    c.title = p.status === 'error' ? p.message : p.status === 'done' ? '点击预览：' + p.remotePath : p.localPath;
    // 图片显示缩略图；上传中显示百分比；传完可以点开预览
    let inner = p.thumb ? `<img class="chip-thumb" src="${p.thumb}" alt="" />` : icon('file');
    inner += `<span class="cname">${esc(p.name)}</span>`;
    if (p.status === 'uploading') inner += `<span class="bar"><i style="width:${Math.round((p.progress || 0) * 100)}%"></i></span><span class="fmeta">上传中 ${Math.round((p.progress || 0) * 100)}%</span>`;
    else if (p.status === 'done') inner += `<span class="fmeta">${fmtSize(p.size)}</span>`;
    else inner += '<span>上传失败</span>';
    c.innerHTML = inner;
    if (p.status === 'done' && typeof openFile === 'function') c.onclick = (e) => { if (!e.target.closest('.x')) openFile(p.remotePath); };
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
  // 图片附件做缩略图
  items.forEach((p) => api.thumb(p.localPath).then((t) => { if (t) { p.thumb = t; renderAttachments(); } }));
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
function buildPrompt(text, files) {
  let prompt = text || '请查看我上传的文件。';
  if (files.length) {
    prompt += `\n\n[我上传了 ${files.length} 个文件到服务器，路径如下，请直接读取]\n` + files.map((f) => `- ${f.promptPath || f.remotePath}`).join('\n');
  }
  return prompt;
}

// 写进正在运行的 Claude；做不到（比如 Windows 主机、这一轮已经在收尾）就返回 false，按排队处理
// 回复进行中发的消息：写进正在运行的 Claude（它会在下一个步骤读到、合并处理），界面上插在当前位置，
// 之后 Claude 的输出接在它下面
async function mergeIntoRun(s, text, files, fromInput = true) {
  const r = await api.sendInput({ sessionId: s.id, prompt: buildPrompt(text, files) });
  if (!r.ok) return false;
  bumpSession(s);
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'assistant' && !(last.blocks || []).length && !last.error) s.messages.pop();
  else if (last && last.role === 'assistant') last.doneAt = last.doneAt || Date.now();
  s.messages.push({ role: 'user', text, merged: true, files: files.map((f) => ({ name: f.name, remotePath: f.remotePath, promptPath: f.promptPath, size: f.size, thumb: f.thumb || undefined })), ts: Date.now() });
  s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
  s.updatedAt = Date.now();
  live[s.id] = { ...live[s.id], thinking: true, newText: false };
  if (fromInput) {
    $('#input').value = '';
    autoGrow();
    pending = [];
    renderAttachments();
  }
  save(s.id);
  if (s.id === currentId) renderAll(); else renderSidebar();
  return true;
}

async function injectMessage(s, text, files, fromInput) {
  const r = await api.sendInput({ sessionId: s.id, prompt: buildPrompt(text, files) });
  if (!r.ok) return false;
  bumpSession(s);
  s.messages.push({ role: 'user', text, files: files.map((f) => ({ name: f.name, remotePath: f.remotePath, promptPath: f.promptPath, size: f.size, thumb: f.thumb || undefined })), ts: Date.now() });
  s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
  s.updatedAt = Date.now();
  live[s.id] = { ...live[s.id], thinking: true, replied: false, newText: false };
  if (fromInput) {
    $('#input').value = '';
    autoGrow();
    pending = [];
    renderAttachments();
  }
  save(s.id);
  if (s.id === currentId) renderAll(); else renderSidebar();
  return true;
}

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
  let text = payload ? payload.text : input.value.trim();
  const files = payload ? payload.files : pending.filter((p) => p.status === 'done');
  if (!text && !files.length) return;
  // 旁问模式、/btw /plan /fork /subtask
  if (!payload && typeof side !== 'undefined') {
    const r = side.intercept(text, files);
    if (r === true) return;
    if (typeof r === 'string') text = r;
  }

  let s = findSession(payload ? payload.sid : currentId);
  // 在「历史版本」里的对话接着发消息：说明还要用，回到原来的分组
  if (s && s.history) { delete s.history; delete s.order; renderSidebar(); }
  // 主回复已经结束、只是在等后台任务：直接发给正在运行的 Claude，马上开始新的一轮
  if (s && live[s.id] && live[s.id].replied && (await injectMessage(s, text, files, !payload))) return;
  // 正在回复：和 Claude Code 原生一样，直接交给正在工作的 Claude，它在下一步读到后合并进当前的工作；
  // 写不进去（这一轮刚好结束、Windows 服务器的旧模式）才退回本地排队
  if (s && live[s.id] && !payload && (await mergeIntoRun(s, text, files))) return;
  // 先排队，这一轮结束后自动发出（排队期间可以撤回）
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
    if (typeof side !== 'undefined' && side.newChatPlan) { s.planMode = true; side.newChatPlan = false; }
    if (typeof side !== 'undefined') { s.permMode = side.newChatPerm || side.defaultPerm(); side.newChatPerm = null; }
    if (s.cwd) rememberCwd(s.cwd);
    newChatCwd = null;
    data.sessions.push(s);
    currentId = s.id;
    clearDraft(null);
    draftKey = s.id;
    newChatGroup = null;
  }

  const prompt = buildPrompt(text, files);

  s.messages.push({ role: 'user', text, files: files.map((f) => ({ name: f.name, remotePath: f.remotePath, promptPath: f.promptPath, size: f.size })), ts: Date.now() });
  s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
  s.updatedAt = Date.now();
  live[s.id] = { thinking: true };
  if (!payload) {
    input.value = '';
    autoGrow();
    pending = [];
    renderAttachments();
    clearDraft(s.id);
  }
  renderAll();
  save();

  const fail = (message) => {
    const msg = s.messages[s.messages.length - 1];
    msg.error = message;
    delete live[s.id];
    save(s.id); // 可能不是正在看的对话：显式标这个对话，否则错误信息存不下来
    if (s.id === currentId) renderAll(); else renderSidebar();
  };
  // 对话在哪台服务器就在哪台跑（排队的消息可能在切到别的服务器之后才发出）
  const srv = s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
  if (!srv || srv.id === data.currentServer) {
    const c = await api.connect();
    if (!c.ok) return fail('连接服务器失败：' + c.message);
  }
  live[s.id].model = currentModel();
  live[s.id].effort = effortFor(currentModel());
  const r = await api.run({
    server: srv ? pickServer(srv) : null,
    sessionId: s.id,
    claudeId: s.claudeId || s.id,
    isNew: !s.started && !s.pendingFork,
    fork: s.pendingFork || null,
    prompt,
    model: currentModel(),
    effort: effortFor(currentModel()),
    caps: s.caps || null,
    cwd: s.cwd || null,
    plan: !!s.planMode,
    perm: typeof side !== 'undefined' ? side.permOf(s) : 'auto',
  });
  if (!r.ok) fail(r.message);
}

api.onEvent(({ sessionId, ev }) => {
  const s = findSession(sessionId);
  if (!s) return;
  // 思考的文字、正在写的操作：只给画面上的状态用，不存盘
  if (ev.type === 'thinkdelta' || ev.type === 'tooldraft') {
    const lv = live[sessionId];
    if (!lv) return;
    lv.lastAt = Date.now();
    lv.idleShown = false;
    if (ev.type === 'thinkdelta') { lv.thinking = true; lv.thinkText = ((lv.thinkText || '') + ev.text).slice(-20000); }
    else lv.draft = { name: ev.name, chars: ev.chars || 0, hint: ev.hint || '', tail: ev.tail || '' };
    if (sessionId === currentId) scheduleLiveRender();
    return;
  }
  markDirty(sessionId);
  // 回复过程中也隔一会儿存一次（后台写，不卡）：中途崩溃或断电，已经显示的内容不会整段丢
  if (!saveTimer) { saveWaitFrom = Date.now(); saveTimer = setTimeout(flushSave, 2000); }
  if (live[sessionId]) { live[sessionId].lastAt = Date.now(); live[sessionId].idleShown = false; }
  const msg = s.messages[s.messages.length - 1];
  if (!msg || msg.role !== 'assistant') return;
  const lv = live[sessionId] || {};
  switch (ev.type) {
    case 'init':
      s.started = true;
      if (ev.claudeId) s.claudeId = ev.claudeId;
      // 分支 / 回退出来的：记下来源，用量统计要减掉从来源带过来的累计（见 stats.js）
      if (s.pendingFork) lv.forkFrom = s.pendingFork.from;
      s.pendingFork = null;
      s.lastInit = { mcp: ev.mcp || [], skills: ev.skills || [], plugins: ev.plugins || [], tools: ev.tools || 0, model: ev.model, at: Date.now() };
      // 选了「自动」但 Claude 实际按「默认」跑（比如 Haiku 不支持自动模式）：说一声，免得以为卡住了
      if (ev.permissionMode === 'default' && !s.planMode && typeof side !== 'undefined' && side.permOf(s) === 'auto') toast('当前模型不支持「自动」模式，这一轮按「默认」运行：改文件、运行命令前会先问你', 6000);
      data.ui.lastSkills = ev.skills || [];
      data.ui.lastPlugins = ev.plugins || [];
      // 斜杠命令列表是缓存的：这次启动的 Claude 有缓存里没有的命令（刚装了插件、加了 Skill），后台重新读一次
      if (ev.slashCommands && ev.slashCommands.length) {
        const known = new Set((((data.ui.commands || {})[modelsKey()]) || []).map((c) => c.name));
        if (ev.slashCommands.some((n) => !known.has(n))) loadModels(true, true);
      }
      if (ev.model && lv.model) {
        data.ui.modelIds = data.ui.modelIds || {};
        data.ui.modelIds[lv.model] = ev.model;
        renderModel();
      }
      break;
    case 'thinking':
      lv.thinking = true;
      lv.thinkText = '';
      break;
    case 'msgstart':
      lv.newText = true;
      break;
    case 'text': {
      lv.thinking = false;
      lv.draft = null;
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
      lv.draft = null;
      lv.thinkText = '';
      msg.blocks.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running', startedAt: Date.now() });
      // SendMessage 唤醒之前派出去的子助手：它又在后台跑了
      if (ev.name === 'SendMessage' && ev.input && typeof ev.input.to === 'string') {
        for (const m of s.messages) { const t = (m.tasks || []).find((x) => x.id === ev.input.to); if (t && t.status !== 'running' && !t.userStopped) { t.status = 'running'; t.end = null; t.revived = Date.now(); } }
        if (sessionId === currentId && typeof renderTasksUi === 'function') renderTasksUi();
      }
      break;
    case 'tool_result': {
      const b = msg.blocks.find((x) => x.type === 'tool' && x.id === ev.id);
      if (b) { b.status = ev.isError ? 'err' : 'ok'; b.preview = ev.preview; if (ev.model) b.model = ev.model; }
      lv.thinking = true;
      // 结果里有授权链接：Claude 多半在等你去浏览器授权
      if (b && !msg.authNotified && authLinks(ev.preview).length && typeof needsAttention === 'function') {
        msg.authNotified = true;
        needsAttention(s, msg, 'auth');
      }
      break;
    }
    case 'result':
      lv.replied = true;
      lv.thinking = false;
      if (s.queue && s.queue.length && s.messages.some((m) => (m.tasks || []).some((t) => t.status === 'running'))) {
        const next = s.queue.shift();
        save();
        setTimeout(() => sendMessage({ text: next.text, files: next.files, sid: s.id }), 300);
      }
      if (ev.isError) msg.error = ev.text || '回复出错了';
      else if (!msg.blocks.some((b) => b.type === 'text') && ev.text) msg.blocks.push({ type: 'text', text: ev.text });
      break;
    case 'stopped':
      msg.stopped = true;
      break;
    case 'sub': {
      const b = findToolBlockIn(s, ev.parent);
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
      if (typeof needsAttention === 'function') needsAttention(s, msg, 'ask', (ev.questions || []).map((q) => q.question).filter(Boolean).join('\n'));
      break;
    }
    case 'perm': {
      // 默认 / 自动模式：这一步要你允许才做，挂到对应的工具卡片下面
      let b = ev.toolId && findToolBlock(msg.blocks, ev.toolId);
      if (!b) {
        b = { type: 'tool', id: ev.toolId || ev.requestId, name: ev.name, input: ev.input, status: 'running', startedAt: Date.now() };
        msg.blocks.push(b);
      }
      b.perm = { requestId: ev.requestId, sid: s.id, reason: ev.reason || '', state: 'pending' };
      lv.thinking = false;
      lv.draft = null;
      if (sessionId !== currentId) toast(`「${s.title}」有一步操作等你允许`, 5000);
      if (typeof needsAttention === 'function') {
        const [, label, sum] = TOOL_LABELS[ev.name] || mcpLabel(ev.name) || ['', ev.name, () => ''];
        let sub = '';
        try { sub = String(sum(ev.input || {}) || ''); } catch (_) {}
        needsAttention(s, msg, 'perm', `${label}${sub ? '：' + sub : ''}`.slice(0, 200));
      }
      break;
    }
    case 'plan': {
      // 计划模式：方案写好了，挂到 ExitPlanMode 工具卡片上等你批准
      let b = ev.toolId && findToolBlock(msg.blocks, ev.toolId);
      if (!b) {
        b = { type: 'tool', id: ev.toolId || ev.requestId, name: 'ExitPlanMode', input: { plan: ev.plan }, status: 'running' };
        msg.blocks.push(b);
      }
      b.plan = { requestId: ev.requestId, sid: s.id, text: ev.plan, state: 'pending' };
      lv.thinking = false;
      if (sessionId !== currentId) toast(`「${s.title}」的计划写好了，等你批准`, 5000);
      if (typeof needsAttention === 'function') needsAttention(s, msg, 'plan', String(ev.plan || '').slice(0, 200));
      break;
    }
    case 'files':
      msg.outputs = ev.files;
      break;
    case 'status':
      if (ev.status === 'compacting' && lv.status !== 'compacting') {
        lv.compactAt = Date.now();
        lv.compactCtx = s.usage ? s.usage.context : 0;
      }
      lv.status = ev.status;
      break;
    case 'ratelimit':
      if (typeof recordRateLimit === 'function') recordRateLimit(ev.info, lv.model, s.serverId);
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
    case 'tokens':
      if (typeof recordTokens === 'function') { recordTokens(s, ev, lv); save(); }
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
      msg.doneAt = Date.now();
      const settle = (list) => list.forEach((b) => {
        if (b.type !== 'tool') return;
        if (b.status === 'running') b.status = msg.stopped ? 'err' : 'ok';
        if (b.sub) settle(b.sub);
      });
      settle(msg.blocks);
      msg.blocks.forEach((b) => { if (b.ask && b.ask.state === 'pending') b.ask.state = 'expired'; if (b.plan && b.plan.state === 'pending') b.plan.state = 'expired'; if (b.perm && b.perm.state === 'pending') b.perm.state = 'expired'; });
      if (typeof side !== 'undefined') side.runEnded(s, msg);
      // 完成标记和 webhook 通知（自己点了停止的不算）
      if (!msg.stopped && typeof runFinished === 'function') runFinished(s, msg);
      // 这一轮结束时还没报告结束的后台任务：随这一轮一起结束了
      s.messages.forEach((x) => (x.tasks || []).forEach((t) => { if (t.status === 'running') { t.status = msg.stopped ? 'stopped' : 'ended'; t.end = Date.now(); } }));
      delete live[sessionId];
      s.updatedAt = Date.now();
      // 因为没登录而失败：顺便刷新状态栏里的账号（显示「未登录 Claude」）
      if (msg.error && /「登录 Claude」/.test(msg.error) && typeof refreshAccount === 'function') refreshAccount();
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
          syncTitle(s, true);
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

// 在整个对话里找（后台助手可能是之前那条回复派出的），新的在前
function findToolBlockIn(s, id) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role !== 'assistant') continue;
    const b = findToolBlock(m.blocks, id);
    if (b) return b;
  }
  return null;
}

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
// ---------- 选中对话里的一段文字 → 浮出「引用回复」：把选中的内容按引用格式放进输入框 ----------
const quotePop = el('button', 'quote-pop hidden', `${icon('quote')}<span>引用回复</span>`);
document.body.appendChild(quotePop);
quotePop.addEventListener('mousedown', (e) => e.preventDefault()); // 别把选区点没了
function hideQuotePop() { quotePop.classList.add('hidden'); }
function selectedInMessages() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const r = sel.getRangeAt(0);
  const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  if (!node || !node.closest('#messages') || node.closest('input, textarea, .tool, .live-st')) return null;
  return { text, rect: r.getBoundingClientRect() };
}
document.addEventListener('mouseup', () => setTimeout(() => {
  const s = selectedInMessages();
  if (!s) return hideQuotePop();
  quotePop._text = s.text; // 出现时就记下，点的那一刻选区可能已经没了
  quotePop.classList.remove('hidden');
  const w = quotePop.offsetWidth;
  quotePop.style.left = Math.round(Math.min(window.innerWidth - w - 8, Math.max(8, s.rect.left + s.rect.width / 2 - w / 2))) + 'px';
  quotePop.style.top = Math.round(s.rect.top > 48 ? s.rect.top - 40 : s.rect.bottom + 8) + 'px';
}, 0));
document.addEventListener('selectionchange', () => { if (!selectedInMessages()) hideQuotePop(); });
document.addEventListener('scroll', hideQuotePop, true);
quotePop.onclick = () => {
  const text = quotePop._text;
  hideQuotePop();
  if (!text) return;
  const q = text.split('\n').map((l) => '> ' + l).join('\n');
  const input = $('#input');
  input.value = (input.value.trim() ? input.value.replace(/\s+$/, '') + '\n\n' : '') + q + '\n\n';
  window.getSelection().removeAllRanges();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoGrow();
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 240) + 'px';
  // 只在真的超过最大高度时才出滚动条（提示语换行、高度还没跟上时右边会冒出一截滚动条）
  t.style.overflowY = t.scrollHeight > 240 ? 'auto' : 'hidden';
}

// 底栏放不下就一级级收起文字（见 style.css 的 .composer.c1～c4）；宽度变了、里面的文字变了都重新量
function fitComposerBar() {
  const c = $('#composer');
  const b = c.querySelector('.composer-bar');
  // 量的时候先关掉「自己缩」的保险，否则模型名、上下文被压扁了也量不出溢出，文字就不会按顺序收起
  c.classList.remove('c1', 'c2', 'c3', 'c4');
  c.classList.add('measuring');
  for (const k of ['c1', 'c2', 'c3', 'c4']) {
    if (b.scrollWidth <= b.clientWidth) break;
    c.classList.add(k);
  }
  c.classList.remove('measuring');
}
new ResizeObserver(() => { fitComposerBar(); autoGrow(); }).observe($('#composer'));
new MutationObserver(fitComposerBar).observe($('#composer').querySelector('.composer-bar'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });

$('#input').addEventListener('input', () => { autoGrow(); renderSendStop(); });
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
$('#btn-send').onclick = sendMessage;
$('#btn-stop').onclick = () => currentId && api.stop(currentId);
$('#btn-attach').onclick = async () => addFiles(await api.pickFiles());

// 粘贴 / 拖进来的东西变成本地路径：
//   有路径的（从访达复制、拖进来的文件）直接用；
//   没有路径的（截图、网页 / 微信 / 飞书里的图片）先存成临时文件；
//   只给了文件链接（file://）的也换成路径
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
async function filesToPaths(fileList, uriList) {
  const out = [];
  let n = 0;
  for (const f of [...(fileList || [])]) {
    const p = api.pathForFile(f);
    if (p) { out.push(p); continue; }
    if (!f.size) continue;
    n++;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const name = f.name && f.name !== 'image.png' ? f.name : `粘贴的${/^image\//.test(f.type) ? '图片' : '文件'}-${stamp}${n > 1 ? '-' + n : ''}.${EXT[f.type] || (f.name && f.name.split('.').pop()) || 'bin'}`;
    const r = await api.saveTemp(name, new Uint8Array(await f.arrayBuffer()));
    if (r.ok) out.push(r.path); else toast(`${name}：${r.message}`, 4000);
  }
  if (!out.length && uriList) {
    for (const u of String(uriList).split(/\r?\n/)) {
      if (!/^file:\/\//i.test(u.trim())) continue;
      try { out.push(decodeURIComponent(new URL(u.trim()).pathname).replace(/^\/([A-Za-z]:)/, '$1')); } catch (_) {}
    }
  }
  return out;
}

$('#input').addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])];
  if (!files.length) return; // 纯文字照常粘贴
  e.preventDefault();
  const paths = await filesToPaths(files);
  if (paths.length) addFiles(paths);
  else toast('剪贴板里的内容读不出来，可以先存成文件再拖进来');
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
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.add('hidden');
  $('#composer').classList.remove('dragover');
  const dropped = await filesToPaths(e.dataTransfer.files, e.dataTransfer.getData('text/uri-list'));
  if (!dropped.length) return toast('拖进来的东西读不到文件内容（有的软件只给预览），可以先存到电脑上再拖进来', 5000);
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
    // 别的地方要关掉这个弹窗时用 closeModal()：走正常的关闭流程（直接删掉元素的话，
    // 设置页借走的「MCP」「拓展功能」页面就还不回去了，键盘监听也会留着）
    ov._close = close;
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

// 关掉弹窗（el 是弹窗里的某个元素；不传就关最上面那个）
function closeModal(el) {
  const ov = (el && el.closest && el.closest('.overlay')) || [...document.querySelectorAll('#modal-root .overlay')].pop();
  if (!ov) return;
  if (ov._close) ov._close(null); else ov.remove();
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

// 自定义拓展仓库：以前的版本只有一个「拓展功能仓库」输入框（填了别的仓库就是替换官方的），换成「官方 + 额外的自定义仓库」
const OFFICIAL_PLUGIN_REPO = 'TomEageer/claude-remote-plugins';
function customRepoOf(s) {
  if (s.customRepo != null || s.customRepoOn != null) return { on: !!s.customRepoOn, repo: s.customRepo || '' };
  const old = String(s.pluginRepo || '').trim();
  return old && old.toLowerCase() !== OFFICIAL_PLUGIN_REPO.toLowerCase() ? { on: true, repo: old } : { on: false, repo: '' };
}

// ---------- 设置 ----------
const PERM_DEFAULTS = [['auto', '自动', '自动：Claude 自己判断，拿不准才问你'], ['manual', '默认', '默认：改文件、运行命令前都先问你'], ['bypass', '危险', '危险：全部放行，什么都不问']];
const SETTINGS_NAV = [
  ['设置', [['general', '常规', 'gear', ''], ['notify', '通知', 'bell', '通知 系统通知 飞书 Webhook 回复完成 出错 完成提醒'], ['remote', '远程控制', 'phone', '远程 手机 iPhone 安卓 中转 二维码 配对 睡眠']]],
  ['此电脑', [['network', '网络', 'globe', '']]],
  ['自定义', [['caps', 'MCP · Skill · 插件', 'puzzle', 'MCP Skill 插件 服务器 扩展 能力'], ['plugins', '拓展功能', 'plug', '拓展 PDF Word Excel PPT 预览 仓库']]],
  ['用量', [['stats', '用量统计', 'chart', '用量 统计 token 金额 模型 额度']]],
];
const HAPTIC_LEVELS = { 1: 'light', 2: 'medium', 3: 'strong' };
async function openSettings(tab) {
  // 按钮直接绑定时传进来的是点击事件，不是标签名：一律从「常规」开始
  if (typeof tab !== 'string' || !['general', 'network', 'caps', 'plugins', 'notify', 'remote', 'stats'].includes(tab)) tab = 'general';
  if (document.querySelector('.overlay .st-wrap')) return;
  const s = data.settings;
  const body = el('div');
  body.innerHTML = `
    <div class="st-about"><div><b>Claude 远程助手</b><span id="st-ver"></span></div><button class="btn primary" id="st-update">检查更新</button></div>
    <div class="st-row"><div class="st-rt"><b>自动下载更新</b><span>有新版本时在后台下载好，再提示重启；关掉后只提示，点了才下载</span></div><label class="st-sw"><input type="checkbox" id="st-autoupdate" ${s.autoUpdate === false ? '' : 'checked'} /></label></div>
    <div class="st-row"><div class="st-rt"><b>关闭窗口后在后台继续运行</b><span>点窗口的关闭按钮只是收起来，回复和后台任务照常进行；${api.platform === 'darwin' ? '点程序坞图标打开，⌘Q 退出' : '点屏幕右下角托盘里的图标打开，右键托盘图标退出'}。关掉后，点关闭就直接退出软件</span></div><label class="st-sw"><input type="checkbox" id="st-closebg" ${s.closeToBg === false ? '' : 'checked'} /></label></div>
    ${api.platform === 'darwin' ? `<div class="st-row"><div class="st-rt"><b>触控板震感</b><span>滚动或拖动左边的时间轴时，每经过一条消息触控板震一下</span></div><div class="st-ctl">
      <div class="hp-slider" title="拖的时候会按这一档震一下（手指放在触控板上）；系统设置 → 触控板 →「点按」选「重」会整体更明显">
        <input type="range" id="st-haptic" min="0" max="3" step="1" value="${s.haptics === false ? 0 : { light: 1, medium: 2, strong: 3 }[s.hapticLevel || 'strong'] || 3}" />
        <div class="hp-marks"><span>关闭</span><span>轻</span><span>适中</span><span>强</span></div>
      </div></div></div>` : ''}
    <div class="st-row"><div class="st-rt"><b>新对话默认权限模式</b><span id="st-perm-desc"></span></div>
      <select id="st-perm">${PERM_DEFAULTS.map(([k, t]) => `<option value="${k}"${(['auto', 'manual', 'bypass'].includes(s.defaultPermMode) ? s.defaultPermMode : 'auto') === k ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
    <div id="st-quick"></div>
    <div class="st-sec">连接</div>
    <div class="field"><label>服务器名称（界面上只显示这个）</label><input id="st-name" value="${esc((curServer() && curServer().name) || '')}" placeholder="例如 公司服务器" /></div>
    ${s.mode === 'local' ? '<div class="help st-local">本机：Claude 直接在这台电脑上运行，不经过 SSH，用的是这台电脑上的 Claude 登录</div>' : ''}
    <div class="ssh-only"${s.mode === 'local' ? ' hidden' : ''}>
    <div class="field"><label>服务器地址</label><div class="row"><input id="st-host" class="secret" value="${esc(s.host)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
    <div class="field"><label>端口</label><input id="st-port" value="${esc(s.port)}" /></div>
    <div class="field"><label>用户名</label><div class="row"><input id="st-user" class="secret" value="${esc(s.user)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
    </div>
    <div class="field"><label>Claude 账号备注（可选）</label><input id="st-acct" value="${esc((curServer() && curServer().accountLabel) || '')}" placeholder="用长期令牌登录时看不到账号，可以在这里备注是哪个号" /></div>
    <div class="field ssh-only"${s.mode === 'local' ? ' hidden' : ''}><label>密钥文件</label>
      <div class="row"><input id="st-key" class="secret" value="${esc(s.keyPath)}" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button><button class="btn" id="st-key-pick">选择…</button></div>
      <div class="help">这台电脑上的 SSH 私钥（对应的公钥需要管理员加到服务器上）</div>
    </div>
    <div class="field"><label>服务器上的工作文件夹</label><input id="st-wd" value="${esc(s.workdir)}" />
      <div class="help">上传的文件会放在这里面的 uploads 文件夹</div>
    </div>
    <div class="field"><label>给 Claude 的额外说明</label><textarea id="st-prompt" rows="4">${esc(s.appendPrompt || '')}</textarea>
      <div class="help">每次对话都会附带这段话，比如让它用什么语气、文件放哪里</div>
    </div>
    <div class="field st-actions"><button class="btn" id="st-login">重新登录 Claude</button><button class="btn" id="st-wizard">重新运行配置向导</button></div>`;
  if (typeof quickUI !== 'undefined') quickUI.mount(body.querySelector('#st-quick'));
  body.querySelector('#st-key-pick').onclick = async () => {
    const p = await api.pickKey();
    if (p) body.querySelector('#st-key').value = p;
  };
  // 网络：公司 VPN、代理、绕过本机代理（每台服务器各自的连接方式，和通用一起保存）
  const net = el('div', 'st-net');
  net.innerHTML = `
    <p class="help st-net-local"${s.mode === 'local' ? '' : ' hidden'}>「${esc(serverLabel(curServer()))}」是本机模式，Claude 直接在这台电脑上运行，不需要网络设置。</p>
    <div class="ssh-only"${s.mode === 'local' ? ' hidden' : ''}>
      <div class="st-sec">公司 VPN</div>
      <div id="st-vpn"></div>
      <div class="st-noVpn"${s.vpn && s.vpn.on ? ' hidden' : ''}>
        <div class="st-sec">代理</div>
        <div class="field"><label>代理地址（可选）</label><input id="st-proxy" placeholder="socks5://127.0.0.1:1080 或 http://127.0.0.1:8080" value="${esc(s.proxy || '')}" />
          <div class="help">服务器只允许特定网络访问时（如跳板代理）才需要填，一般留空</div>
        </div>
        <label class="check"><input type="checkbox" id="st-direct" ${s.bindDirect ? 'checked' : ''} /> 绕过本机代理直连（电脑开着 Clash、Flowgate、Shadowrocket 等全局代理，而服务器要求用本地网络访问时打开）</label>
      </div>
    </div>`;
  const read = async () => ({
    vpn: await vpnUi.read(),
    host: body.querySelector('#st-host').value.trim(),
    port: Number(body.querySelector('#st-port').value) || 22,
    user: body.querySelector('#st-user').value.trim(),
    keyPath: body.querySelector('#st-key').value.trim(),
    workdir: body.querySelector('#st-wd').value.trim() || '~/workspace',
    proxy: net.querySelector('#st-proxy').value.trim(),
    _name: body.querySelector('#st-name').value.trim(),
    _acct: body.querySelector('#st-acct').value.trim(),
    bindDirect: net.querySelector('#st-direct').checked,
    autoUpdate: body.querySelector('#st-autoupdate').checked,
    haptics: body.querySelector('#st-haptic') ? body.querySelector('#st-haptic').value !== '0' : s.haptics !== false,
    hapticLevel: body.querySelector('#st-haptic') && body.querySelector('#st-haptic').value !== '0' ? HAPTIC_LEVELS[body.querySelector('#st-haptic').value] : s.hapticLevel || 'strong',
    appendPrompt: body.querySelector('#st-prompt').value,
  });
  api.appVersion().then((v) => { body.querySelector('#st-ver').textContent = '当前版本 ' + v; });
  body.querySelector('#st-update').onclick = () => { toast('正在检查更新…'); api.checkUpdate(); };
  body.querySelectorAll('.reveal').forEach((b) => (b.onclick = () => b.previousElementSibling.classList.toggle('secret')));
  const hl = body.querySelector('#st-haptic');
  if (hl) {
    // 拖到哪一档马上按这一档震一下试试（手指要放在触控板上）；进度条颜色跟着走
    const paint = () => { hl.style.setProperty('--p', (hl.value / 3) * 100 + '%'); body.querySelectorAll('.hp-marks span').forEach((x, i) => x.classList.toggle('on', String(i) === hl.value)); };
    paint();
    hl.oninput = () => { paint(); if (hl.value !== '0') api.haptic(HAPTIC_LEVELS[hl.value]); };
  }
  const perm = body.querySelector('#st-perm');
  const permDesc = () => { body.querySelector('#st-perm-desc').textContent = PERM_DEFAULTS.find((x) => x[0] === perm.value)[2]; };
  permDesc();
  perm.onchange = () => { data.settings.defaultPermMode = perm.value; permDesc(); save(); };
  const cbg = body.querySelector('#st-closebg');
  cbg.onchange = () => { data.settings.closeToBg = cbg.checked; api.closeToBg(cbg.checked); save(); };
  // 公司 VPN：开了就不用手填代理
  const vpnUi = vpnFields(s.vpn);
  net.querySelector('#st-vpn').appendChild(vpnUi.el);
  vpnUi.el.addEventListener('vpnchange', (e) => { net.querySelector('.st-noVpn').hidden = e.detail.on; });
  body.querySelector('#st-login').onclick = () => {
    closeModal(body);
    openLogin();
  };
  body.querySelector('#st-wizard').onclick = () => {
    closeModal(body);
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
  const tabs = el('nav', 'st-nav st-tabs', `<div class="st-search">${icon('search')}<input id="st-q" placeholder="搜索" spellcheck="false" /></div>`
    + SETTINGS_NAV.map(([g, items]) => `<div class="st-group"><div class="st-glabel">${g}</div>${items.map(([t, name, ico]) => `<button data-t="${t}">${icon(ico)}<span>${esc(name)}</span></button>`).join('')}</div>`).join('')
    + '<div class="st-nohit" hidden>没有找到</div>');
  const main = el('div', 'st-main');
  const scroll = el('div', 'st-scroll');
  main.appendChild(scroll);
  const titled = (name, cls) => {
    const p = el('div', 'st-pane');
    p.appendChild(el('h2', 'st-h', esc(name)));
    const inner = el('div', cls || '');
    p.appendChild(inner);
    return [p, inner];
  };
  const [paneG] = titled('常规');
  const paneC = el('div', 'st-pane');
  const paneP = el('div', 'st-pane');
  const [paneSo, paneS] = titled('用量统计', 'sx-pane');
  const [paneNo, paneN] = titled('通知', 'nt-pane');
  const [paneW] = titled('网络');
  const [paneRo, paneR] = titled('远程控制', 'nt-pane');
  paneG.appendChild(body);
  // 功能介绍：第一次打开时自动放过一遍，这里可以再看
  const tourRow = el('div', 'st-tour', `<div><b>功能介绍</b><span class="help">两三分钟带你看一遍：服务器上的会话、公司 VPN、拓展功能、飞书通知、手机远程控制</span></div>`);
  const tourBtn = el('button', 'btn', '再看一遍');
  tourBtn.onclick = () => { closeModal(tourBtn); setTimeout(() => tour.start(true), 300); };
  tourRow.appendChild(tourBtn);
  paneG.appendChild(tourRow);
  paneW.appendChild(net);
  const capsEl = $('#view-caps');
  const plEl = $('#view-plugins');
  const homeOf = capsEl.parentNode;
  paneC.appendChild(capsEl);
  paneP.appendChild(plEl);
  capsEl.classList.add('embedded');
  plEl.classList.add('embedded');
  const panes = { general: paneG, network: paneW, caps: paneC, plugins: paneP, notify: paneNo, remote: paneRo, stats: paneSo };
  scroll.append(paneG, paneW, paneC, paneP, paneNo, paneRo, paneSo);
  wrap.append(tabs, main);
  let cur = '';
  const showTab = (t) => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    for (const k in panes) panes[k].hidden = k !== t;
    if (t !== cur) scroll.scrollTop = 0;
    cur = t;
    // 「保存」按钮管常规和网络两页
    const m = wrap.closest('.modal');
    if (m) m.classList.toggle('no-foot', t !== 'general' && t !== 'network');
    if (t === 'caps') capsView.open();
    if (t === 'plugins') pluginsView.open();
    if (t === 'stats') statsView.open(paneS);
    if (t === 'notify') notifyView.open(paneN);
    if (t === 'remote') remoteView.open(paneR);
  };
  tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
  // 搜索：按各页文字过滤左侧导航，并滚到当前页第一处匹配
  const q = tabs.querySelector('#st-q');
  const hints = Object.fromEntries(SETTINGS_NAV.flatMap(([, items]) => items.map(([t, name, , kw]) => [t, name + ' ' + kw])));
  const firstHit = (root, k) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.toLowerCase().includes(k) && n.parentElement.getClientRects().length) return n.parentElement;
    return null;
  };
  const runSearch = () => {
    const k = q.value.trim().toLowerCase();
    const hit = [];
    tabs.querySelectorAll('button[data-t]').forEach((b) => {
      const t = b.dataset.t;
      const ok = !k || (hints[t] + ' ' + panes[t].textContent).toLowerCase().includes(k);
      b.hidden = !ok;
      if (ok) hit.push(t);
    });
    tabs.querySelectorAll('.st-group').forEach((g) => { g.hidden = !g.querySelector('button[data-t]:not([hidden])'); });
    tabs.querySelector('.st-nohit').hidden = hit.length > 0;
    if (!k || !hit.length) return;
    if (!hit.includes(cur)) showTab(hit[0]);
    const n = firstHit(panes[cur], k);
    if (n) scroll.scrollTop += n.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 60;
  };
  q.addEventListener('input', (e) => { if (!e.isComposing) runSearch(); });
  q.addEventListener('compositionend', runSearch);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation(); });
  setTimeout(() => showTab(tab), 0);
  const pending = modal({
    title: '设置',
    body: wrap,
    wide: 'xl',
    buttons: [
      { left },
      { text: '取消', value: null },
      { text: '保存', cls: 'primary', onClick: () => read() },
    ],
  });
  const md = wrap.closest('.modal');
  md.classList.add('st-modal');
  main.appendChild(md.querySelector('.modal-foot'));
  const v = await pending;
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
  let wizardMac = false; // 正在配置的是 Mac 主机（登录那一步要解释钥匙串的问题）
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
      <div id="w-local"></div>
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
        <div id="w-vpn"></div>
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
    probeLocal(card.querySelector('#w-local'));
    // 服务器要连公司 VPN 才能访问：在高级选项里配
    const wVpn = vpnFields(st.vpn);
    card.querySelector('#w-vpn').appendChild(wVpn.el);
    if (st.vpn && st.vpn.on) card.querySelector('.wadv').open = true;
    card.querySelector('#w-go').onclick = async () => {
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
        vpn: await wVpn.read(),
      };
      if (!input.vpn.on) input.vpn = null;
      else if (!input.vpn.server || !input.vpn.user || !input.vpn.pass) return toast('公司 VPN 的地址、账号、密码都要填');
      wizardName = v('#w-name');
      if (!input.host || !input.user) return toast('请填写服务器地址和用户名');
      if (mode === 'password' && !input.password) return toast('请填写密码');
      if (mode === 'key' && !input.keyFile) return toast('请选择密钥文件');
      stepProgress(input);
    };
    card.querySelector('#w-host').focus();
  };

  // 第一页顶部：这台电脑本身装了 Claude Code 的话，提示直接用它（不经过 SSH，终端里的登录直接能用）
  const probeLocal = async (box) => {
    if ((data.servers || []).some((x) => x.mode === 'local')) return;
    const r = await api.localProbe();
    if (!box.isConnected || !r.ok) return;
    const desc = !r.installed ? '会自动安装 Claude Code'
      : r.loggedIn ? `已装好 Claude Code ${esc(r.version.split(' ')[0])}，已登录${r.email ? ' ' + esc(r.email) : ''}，不用再配置`
      : `已装好 Claude Code ${esc(r.version.split(' ')[0])}，还没登录`;
    box.innerHTML = `<button class="wlocal">${icon('computer')}<span class="wl-main"><b>直接使用这台电脑</b><span>${desc}</span></span>${icon('chevRight')}</button>
      <div class="wor"><span>或者连接远程服务器</span></div>`;
    box.querySelector('.wlocal').onclick = () => stepLocal();
  };

  const stepLocal = async () => {
    wizardName = '本机';
    card.innerHTML = '<h2>正在配置这台电脑</h2><p class="wsub">不经过 SSH，Claude 直接在这台电脑上运行</p><div class="wsteps"></div>';
    const list = card.querySelector('.wsteps');
    const rows = {};
    setupLogHandler = ({ step, state, detail }) => {
      let r = rows[step];
      if (!r) { r = rows[step] = el('div', 'wstep'); list.appendChild(r); }
      const ico = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? icon('check') : icon('alert');
      r.className = 'wstep ' + state;
      r.innerHTML = `<span class="wsi">${ico}</span><span class="wsn">${esc(step)}</span><span class="wsd">${esc(detail)}</span>`;
    };
    const r = await api.setupLocal({ workdir: '~/workspace' });
    setupLogHandler = null;
    if (!r.ok) return stepServer(r.message);
    applyServerResult(r.settings, !!opts.add, '本机');
    if (r.needsAuth) stepLocalAuth();
    else stepDone();
  };

  // 本机还没登录：用 Claude Code 自己的方式登录一次（打开终端运行 claude），或者填 API Key
  const stepLocalAuth = (err) => {
    card.innerHTML = `
      <div class="wmark"></div>
      <h2>登录 Claude</h2>
      <p class="wsub">这台电脑上的 Claude Code 还没登录。点「打开终端登录」会打开终端并运行 claude，按提示在浏览器里登录一次，然后回到这里点「我已登录」。</p>
      <div class="wfoot left"><button class="btn primary" id="w-term">打开终端登录</button><button class="btn" id="w-check">我已登录</button></div>
      <details class="wadv"><summary>用 API Key</summary>
        <div class="field"><label>Anthropic API Key</label><input id="w-apikey" placeholder="sk-ant-..." /></div>
        <button class="btn" id="w-api-go">保存</button>
      </details>
      <div id="w-auth-msg">${err ? `<div class="err-box">${icon('alert')}<span>${esc(err)}</span></div>` : ''}</div>
      <div class="wfoot"><button class="btn" id="w-skip">稍后再说</button></div>`;
    const msg = (html) => (card.querySelector('#w-auth-msg').innerHTML = html);
    card.querySelector('#w-term').onclick = async () => {
      const r = await api.localOpenLogin();
      if (!r.ok) msg(`<div class="err-box">${icon('alert')}<span>${esc(r.message)}</span></div>`);
    };
    card.querySelector('#w-check').onclick = async () => {
      msg('<div class="thinking"><span class="spin"></span><span>正在检查…</span></div>');
      const r = await api.localAuthCheck();
      if (r.ok && r.loggedIn) return stepDone();
      stepLocalAuth('还没检测到登录。请在终端里按提示完成登录（看到登录成功后再回来点）');
    };
    card.querySelector('#w-api-go').onclick = async () => {
      msg('<div class="thinking"><span class="spin"></span><span>正在保存并测试…</span></div>');
      const r = await api.setupApiKey(card.querySelector('#w-apikey').value);
      if (!r.ok) return stepLocalAuth(r.message);
      stepDone();
    };
    card.querySelector('#w-skip').onclick = () => (opts.startAt ? close() : stepFolders());
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
    if (r.needsAuth) { wizardMac = !!r.isMac; stepAuth(); }
    else stepDone();
  };

  const stepAuth = () => {
    card.innerHTML = `
      <div class="wmark"></div>
      <h2>登录 Claude</h2>
      <p class="wsub">${opts.startAt === 'auth' ? `重新给「${esc(serverLabel(curServer()))}」上的 Claude 授权，可以换成别的 Claude 账号；令牌有效期一年。` : 'Claude 运行在你的服务器上，需要用你的 Claude 账号授权一次（有效期一年）。'}</p>
      ${wizardMac || (opts.startAt === 'auth' && (remoteInfo.os === 'darwin' || (curServer() && curServer().account && curServer().account.os === 'darwin'))) ? '<div class="help w-mac-tip">这是一台 Mac：即使你在这台 Mac 的终端里已经登录了 Claude，远程（SSH）进来也读不到，因为 macOS 不允许远程会话读取钥匙串。这里授权后生成的长期令牌只保存在这台 Mac 的 ~/.claude-env 里，不影响你在终端里用的 Claude。</div>' : ''}
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
      // 首次配置时先跳过登录：照样让用户选工作文件夹
      if (!opts.startAt) return stepFolders();
      close();
      await api.applySettings(data.settings);
      api.connect();
    };
  };

  // 这台机器上以前用 Claude Code 的文件夹：可以选一个作为默认工作文件夹，或者用新建的；也可以顺便导入以前的对话
  let foldersAsked = false;
  let openHistoryAfter = false;
  const stepFolders = async () => {
    foldersAsked = true;
    card.innerHTML = '<h2>查找已有的项目文件夹</h2><div class="thinking"><span class="spin"></span><span>正在查看这台机器上用过 Claude 的文件夹…</span></div>';
    await api.applySettings(data.settings);
    await refreshRemoteInfo();
    const r = await api.historyFolders();
    const items = (r.ok && r.items) || [];
    if (!items.length) return stepDone();
    const s = curServer();
    const home = remoteInfo.home || '';
    const fresh = s.workdir || '~/workspace';
    // 新建的文件夹本身也用过的话，不在下面重复列出
    const freshAbs = home ? fresh.replace(/^~(?=\/|$)/, home) : fresh;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].cwd === freshAbs) items.splice(i, 1);
    if (!items.length) return stepDone();
    const ago = (t) => { const d = Math.round((Date.now() - t) / 86400000); return d < 1 ? '今天' : d < 30 ? `${d} 天前` : `${Math.round(d / 30)} 个月前`; };
    card.innerHTML = `
      <h2>选择工作文件夹</h2>
      <p class="wsub">这台机器上已经有用过 Claude Code 的文件夹。新对话默认在哪个文件夹里工作？以后每个对话也可以单独换文件夹。</p>
      <div class="wfolders">
        <label class="wfold"><input type="radio" name="wf" value="" checked><span class="wf-main"><span class="wf-path">${esc(fresh)}</span><span class="wf-sub">新建的工作文件夹</span></span></label>
        ${items.map((x, i) => `<label class="wfold"><input type="radio" name="wf" value="${i}"><span class="wf-main"><span class="wf-path">${esc(home && x.cwd.startsWith(home) ? '~' + x.cwd.slice(home.length) : x.cwd)}</span><span class="wf-sub">${x.sessions} 个对话 · 最近 ${ago(x.mtime)}</span></span></label>`).join('')}
      </div>
      <label class="wcheck"><input type="checkbox" id="w-import" checked> 完成后打开「服务器上的会话」，把以前的对话导入进来接着聊</label>
      <div class="wfoot"><button class="btn primary" id="w-folder-go">继续</button></div>`;
    card.querySelector('#w-folder-go').onclick = () => {
      const v = card.querySelector('input[name=wf]:checked').value;
      if (v !== '') {
        const dir = items[Number(v)].cwd;
        s.workdir = dir;
        data.settings.workdir = dir;
        data.ui.lastCwd = data.ui.lastCwd || {};
        data.ui.lastCwd[s.id] = dir;
        save();
      }
      openHistoryAfter = card.querySelector('#w-import').checked;
      stepDone();
    };
  };

  const stepDone = () => {
    if (!opts.startAt && !foldersAsked) return stepFolders();
    card.innerHTML = `
      <div class="wdone">${icon('check')}</div>
      <h2>${opts.startAt === 'auth' ? '登录成功' : '配置完成'}</h2>
      <p class="wsub">以后打开软件会自动连接「${esc(serverLabel(curServer()))}」</p>
      <div class="wfoot center"><button class="btn primary" id="w-start">开始使用</button></div>`;
    card.querySelector('#w-start').onclick = async () => {
      close();
      await api.applySettings(data.settings);
      if (typeof refreshRemoteInfo === 'function') await refreshRemoteInfo(); else api.connect();
      if (typeof refreshAccount === 'function') refreshAccount();
      if (openHistoryAfter) showView('history');
      else $('#input').focus();
    };
  };

  if (opts.startAt === 'auth') (curServer() && curServer().mode === 'local' ? stepLocalAuth() : stepAuth());
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
  if (u.state === 'available' && u.canDownload) {
    // 关了自动下载：点了才在后台下载
    bar.innerHTML = `${icon('download')}<span>发现新版本 ${esc(u.version)}</span><a href="#">下载</a>`;
    bar.querySelector('a').onclick = (e) => { e.preventDefault(); bar.innerHTML = '<span>正在下载更新…</span>'; api.checkUpdate(); };
  } else if (u.state === 'available') {
    bar.innerHTML = `${icon('download')}<span>发现新版本 ${esc(u.version)}</span><a href="#">去下载</a>`;
    bar.querySelector('a').onclick = (e) => { e.preventDefault(); api.openExternal(u.url); };
  } else if (u.state === 'downloading') {
    // 一行字就够了，不转圈
    bar.innerHTML = `<span>正在下载更新${u.percent != null ? ' ' + u.percent + '%' : '…'}</span>`;
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
  // 本地打的测试版：版本号里带 -test，旁边标「测试版」，免得和正式版搞混
  if (/-test/.test(v)) { b.textContent = 'v' + v.replace(/-test.*/, ''); b.appendChild(el('span', 'ver-test', '测试版')); b.title = '本地测试版 ' + v + '：正式版发布后会提示更新'; }
  b.onclick = (e) => { e.stopPropagation(); toast('正在检查更新…'); api.checkUpdate(); };
});
$('#title').onclick = () => currentId && renameSession(currentId);
$('#search').addEventListener('input', (e) => { searchText = e.target.value.trim().toLowerCase(); renderSidebar(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); startNewChat(null); }
});
// Esc 停止当前回复（和 Claude Code 一样）。捕获阶段先判断：有弹窗、菜单、预览、编辑框开着时，Esc 留给它们关闭自己
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing || !currentId || !live[currentId]) return;
  if (typeof slash !== 'undefined' && slash.open) return;
  // 时间轴被点中时，Esc 只是退出时间轴；旁问模式下 Esc 是退出旁问
  if (document.activeElement && document.activeElement.id === 'timeline') return;
  if (typeof side !== 'undefined' && side.btwOn) return;
  if (document.querySelector('.overlay, .wizard, .tk-pop, .ctx-pop, .us-pop, #menu:not(.hidden), .edit-box')) return;
  const pv = document.querySelector('#preview');
  if (pv && !pv.classList.contains('hidden')) return;
  e.preventDefault();
  api.stop(currentId);
  toast('已停止');
}, true);

// 等所有脚本（preview.js / files.js / plugins-ui.js）都执行完再启动
document.addEventListener('DOMContentLoaded', async function init() {
  if (api.platform === 'darwin') document.body.classList.add('mac');
  hydrateIcons();
  data = await api.loadData();
  data.ui = data.ui || {};
  // 上次异常退出时还在"回复中"的工具，标记为结束
  for (const s of data.sessions) {
    for (const m of s.messages) {
      if (m.role === 'assistant') m.blocks.forEach((b) => { if (b.type === 'tool' && b.status === 'running') b.status = 'err'; if (b.perm && b.perm.state === 'pending') b.perm.state = 'expired'; });
    }
  }
  const recent = [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  currentId = recent ? recent.id : null;
  useDraftFor(currentId);
  renderAll();
  if (typeof updateBadge === 'function') updateBadge();
  renderModel();
  migrateServers();
  repairOrphanSessions();
  // 以前编辑、回退另存的对话（标题结尾带「（编辑前）」「（回退前）」）：一次性挪进「历史版本」
  if (!data.ui.historyMigrated) {
    data.ui.historyMigrated = 1;
    for (const x of data.sessions) if (!x.history && !live[x.id] && /（(编辑|回退)前）$/.test(x.title || '')) { x.history = { kind: 'old', at: Date.now() }; x.pinned = false; }
    save();
  }
  await migrateLocalServers();
  renderServerSwitcher();
  renderSidebar();
  if (typeof renderUsage === 'function') renderUsage();
  if (typeof remoteCtl !== 'undefined') remoteCtl.start();
  if (typeof quickUI !== 'undefined') quickUI.start();
  api.closeToBg(data.settings.closeToBg !== false);
  if (!curServer()) return openWizard(false);
  $('#input').focus();
  const r = await refreshRemoteInfo();
  if (!r.ok) toast(r.message, 5000);
  else { refreshAccount(); adoptOrphansQuietly(); }
});
