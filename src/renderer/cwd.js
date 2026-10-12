/* global api, el, esc, icon, toast, data, save, findSession, currentId, startNewChat, renderTitle, showMenu, modal, FileBrowser, shortPath, curServer, openPreview */
'use strict';

// 每个对话有自己的工作文件夹（Claude Code 在那个目录里运行，会话也按目录保存，所以发出第一条消息后不能再换）
const remoteInfo = { workdir: null, home: null };
let newChatCwd = null;

async function refreshRemoteInfo() {
  const server = data.currentServer;
  const c = await api.connect();
  // 等待期间切换了服务器：这次结果属于旧服务器，丢掉
  if (server !== data.currentServer) return { ok: false, message: '已切换服务器' };
  if (c.ok) {
    remoteInfo.workdir = c.workdir;
    remoteInfo.home = c.home;
    renderCwd();
  }
  return c;
}

const serverKey = () => (curServer() ? curServer().id : '_');

function defaultCwd() {
  const last = data.ui.lastCwd && data.ui.lastCwd[serverKey()];
  return last || remoteInfo.workdir || null;
}

// 当前对话（或还没发出的新对话）所在的文件夹
function chatCwd() {
  const s = findSession(currentId);
  if (s) return s.cwd || remoteInfo.workdir;
  return newChatCwd || defaultCwd();
}

function rememberCwd(p) {
  data.ui.lastCwd = data.ui.lastCwd || {};
  data.ui.lastCwd[serverKey()] = p;
  data.ui.recentDirs = data.ui.recentDirs || {};
  const list = (data.ui.recentDirs[serverKey()] || []).filter((x) => x !== p);
  list.unshift(p);
  data.ui.recentDirs[serverKey()] = list.slice(0, 8);
  save();
}

function startNewChatIn(p) {
  startNewChat(null);
  newChatCwd = p;
  rememberCwd(p);
  renderCwd();
  if (filePane.open) filePane.follow();
}

function renderCwd() {
  const chip = document.querySelector('#cwd-chip');
  if (!chip) return;
  const p = chatCwd();
  const s = findSession(currentId);
  const locked = !!(s && s.messages.length);
  let label = p ? shortPath(p, remoteInfo.home) : '工作文件夹';
  if (label.length > 32) label = '…' + label.slice(-31); // 太长从开头截，保留最后几级目录
  chip.innerHTML = `${icon('folder')}<span>${esc(label)}</span>${locked ? '' : icon('chevDown')}`;
  chip.title = p ? `${p}\n${locked ? '这个对话在这个文件夹里运行' : '点击选择这个对话在哪个文件夹里运行'}` : '';
  chip.classList.toggle('locked', locked);
  document.querySelector('#btn-filepane').classList.toggle('on', filePane.open);
}

document.querySelector('#cwd-chip').onclick = (e) => {
  const s = findSession(currentId);
  if (!s || !s.messages.length) return pickFolder(chatCwd()).then((p) => {
    if (!p) return;
    newChatCwd = p;
    rememberCwd(p);
    renderCwd();
    if (filePane.open) filePane.follow();
  });
  const r = e.currentTarget.getBoundingClientRect();
  showMenu([
    { label: '对话开始后不能再换文件夹' },
    { text: '在文件面板中打开', icon: 'folder', onClick: () => filePane.show() },
    { text: '在这个文件夹开新对话', icon: 'plus', onClick: () => startNewChatIn(chatCwd()) },
    { text: '换个文件夹开新对话…', icon: 'chat', onClick: async () => { const p = await pickFolder(chatCwd()); if (p) startNewChatIn(p); } },
  ], { clientX: r.left, clientY: r.bottom + 4 });
};

// ---------- 选择文件夹 ----------
function pickFolder(start) {
  const body = el('div', 'dp');
  let cur = null;
  let home = remoteInfo.home;
  let seq = 0;
  const recent = ((data.ui.recentDirs || {})[serverKey()] || []).filter((x) => x !== start).slice(0, 5);
  body.innerHTML = `
    ${recent.length ? `<div class="dp-sec">最近用过</div><div class="dp-recent">${recent.map((p) => `<button class="dp-chip" data-p="${esc(p)}">${icon('folder')}<span>${esc(shortPath(p, home))}</span></button>`).join('')}</div>` : ''}
    <div class="dp-bar"><button class="icon-btn" data-a="up" title="上一级">${icon('up')}</button><div class="dp-path"></div><button class="icon-btn" data-a="mkdir" title="新建文件夹">${icon('folderPlus')}</button></div>
    <div class="dp-list"></div>`;
  const list = body.querySelector('.dp-list');
  const load = async (dir) => {
    const s2 = ++seq;
    if (dir) { cur = dir; body.querySelector('.dp-path').textContent = shortPath(dir, home); }
    list.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>加载中…</span></div>';
    const r = await api.listDir(dir);
    if (s2 !== seq) return;
    if (!r.ok) { list.innerHTML = `<div class="fm-empty err">${esc(r.message)}</div>`; return; }
    cur = r.dir;
    home = r.home || home;
    body.querySelector('.dp-path').textContent = shortPath(cur, home);
    const dirs = r.items.filter((x) => x.isDir);
    list.innerHTML = dirs.length ? '' : '<div class="fm-empty">这里没有子文件夹，可以直接选这个文件夹，或者新建一个</div>';
    for (const d of dirs) {
      const row = el('div', 'fm-row dir', `<span class="c-name">${icon('folder')}<span class="nm">${esc(d.name)}</span></span>`);
      row.onclick = () => load(d.path);
      list.appendChild(row);
    }
  };
  body.querySelector('[data-a="up"]').onclick = () => cur && cur !== '/' && load(cur.replace(/\/[^/]+$/, '') || '/');
  body.querySelector('[data-a="mkdir"]').onclick = async () => {
    const box = el('div', 'dp-new', '<input placeholder="新文件夹名称" /><button class="btn primary">创建</button>');
    list.prepend(box);
    const input = box.querySelector('input');
    input.focus();
    const go = async () => {
      const n = input.value.trim();
      if (!n) return;
      const r = await api.mkdir(cur, n);
      if (!r.ok) return toast(r.message, 4000);
      load(`${cur.replace(/\/$/, '')}/${n}`);
    };
    box.querySelector('button').onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); go(); } };
  };
  body.querySelectorAll('.dp-chip').forEach((b) => (b.onclick = () => load(b.dataset.p)));
  load(start || null);
  return modal({
    title: '这个对话在哪个文件夹里工作？',
    body,
    wide: true,
    buttons: [
      { left: el('span', 'help', 'Claude 会在这个文件夹里读写文件、运行命令') },
      { text: '取消', value: null },
      { text: '选这个文件夹', cls: 'primary', onClick: () => cur || undefined },
    ],
  });
}

// ---------- 对话旁的文件面板 ----------
const filePane = {
  open: false,
  el: document.querySelector('#filepane'),
  browser: null,

  show() {
    this.open = true;
    this.el.classList.remove('hidden');
    if (!this.browser) {
      this.el.innerHTML = `<div class="fp-head"><span class="fp-title">${icon('folder')}<span>文件</span></span><button class="icon-btn" title="关闭">${icon('close')}</button></div><div class="fp-body"></div>`;
      this.el.querySelector('.fp-head button').onclick = () => this.hide();
      this.browser = new FileBrowser(this.el.querySelector('.fp-body'), { compact: true, start: () => chatCwd() });
    }
    this.follow();
    renderCwd();
  },

  hide() {
    this.open = false;
    this.el.classList.add('hidden');
    renderCwd();
  },

  toggle() { this.open ? this.hide() : this.show(); },

  // 切换对话时跟着换到那个对话的文件夹
  follow() {
    if (!this.open || !this.browser) return;
    const p = chatCwd();
    if (p && p !== this.browser.cur) {
      this.browser.back = [];
      this.browser.fwd = [];
      this.browser.open(p);
    } else if (!this.browser.cur) this.browser.open(p);
  },
};

document.querySelector('#btn-filepane').onclick = () => filePane.toggle();

// 右上角区域的宽度随文件夹路径变化，标题按它让位，避免窄窗口时重叠
(() => {
  const tr = document.querySelector('#topbar .top-right');
  const bar = document.querySelector('#topbar');
  if (!tr || !bar || typeof ResizeObserver === 'undefined') return;
  const fit = () => {
    const w = tr.offsetWidth;
    bar.style.setProperty('--tr-w', w + 'px');
    // 居中放不下（标题可用宽度不到 140px）就改成靠左
    bar.classList.toggle('tb-narrow', bar.clientWidth - 2 * (w + 16) - 40 < 140);
  };
  const ro = new ResizeObserver(fit);
  ro.observe(tr);
  ro.observe(bar);
})();
