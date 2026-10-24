/* global api, el, esc, icon, toast, fmtTime, data, save, uid, renderSidebar, openSession, showView, showMenu, pickFolder, shortPath, remoteInfo */
'use strict';

// 服务器上的历史会话：列出 Claude Code 在服务器上保存的会话，导入后可以接着聊
const historyView = {
  items: null,
  error: '',
  filter: '',
  busy: {},
  folder: '', // 只看这个文件夹（含子文件夹）里的会话；空 = 全部
  folders: [], // 上次读全部时统计出来的文件夹，给菜单用
  server: null,
  demo: null, // 功能介绍时用的演示数据：{ items, folders, load(id) }

  async open() {
    const v = document.querySelector('#view-history');
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="pl-wrap">
          <div class="pl-head">
            <div><h2>服务器上的会话</h2><p class="wsub">这里是服务器上 Claude Code 保存的所有会话，包括在终端里用过的。导入后能看到完整内容，也能接着聊。</p></div>
            <button class="icon-btn" id="hi-refresh" title="刷新">${icon('refresh')}</button>
          </div>
          <div class="hi-bar">
            <div class="search"><span class="ico">${icon('search')}</span><input id="hi-search" placeholder="搜索标题、内容或目录" /></div>
            <div class="hi-folder"><button class="btn" id="hi-folder">${icon('folder')}<span>全部文件夹</span>${icon('chevron')}</button><button class="icon-btn hidden" id="hi-folder-x" title="看全部文件夹">${icon('close')}</button></div>
            <button class="btn primary" id="hi-all">${icon('download')}<span>全部导入</span></button>
          </div>
          <div id="hi-list"></div>
        </div>`;
      v.querySelector('#hi-refresh').onclick = () => this.reload();
      v.querySelector('#hi-search').oninput = (e) => { this.filter = e.target.value.trim().toLowerCase(); this.render(); };
      v.querySelector('#hi-all').onclick = () => this.importAll();
      v.querySelector('#hi-folder').onclick = (e) => this.folderMenu(e);
      v.querySelector('#hi-folder-x').onclick = () => this.setFolder('');
      v.dataset.built = '1';
    }
    // 换了服务器：上一台的文件夹不适用
    if (this.server !== data.currentServer) { this.server = data.currentServer; this.folder = ''; this.folders = []; }
    this.reload();
  },

  async reload() {
    this.items = null;
    this.error = '';
    this.render();
    if (this.demo) {
      // 功能介绍：不连服务器，用演示数据
      await new Promise((r) => setTimeout(r, 400));
      const f = this.folder;
      this.items = this.demo.items.filter((x) => !f || x.cwd === f || x.cwd.startsWith(f + '/'));
      if (!f) this.folders = this.demo.folders;
      return this.render();
    }
    const c = await api.connect();
    if (!c.ok) { this.error = '连接服务器失败：' + c.message; return this.render(); }
    const folder = this.folder;
    const r = await api.historyList(folder);
    if (folder !== this.folder) return; // 读的过程中又换了文件夹
    if (r.ok) {
      this.items = r.items;
      if (!folder) {
        this.adoptOrphans();
        // 每个文件夹有几个会话，按数量排，给「按文件夹看」菜单用
        const n = {};
        r.items.forEach((x) => { if (x.cwd) n[x.cwd] = (n[x.cwd] || 0) + 1; });
        this.folders = Object.entries(n).filter(([p]) => !/^\/(tmp|private|var\/folders)\//.test(p) && !/\/\.claude\//.test(p)).sort((a, b) => b[1] - a[1]);
      }
    } else this.error = r.message;
    this.render();
  },

  short(p) {
    return typeof shortPath === 'function' ? shortPath(p, typeof remoteInfo !== 'undefined' ? remoteInfo.home : '') : p;
  },

  setFolder(p) {
    this.folder = p || '';
    const b = document.querySelector('#hi-folder');
    b.querySelector('span').textContent = this.folder ? this.short(this.folder) : '全部文件夹';
    b.title = this.folder ? `只看 ${this.folder} 和它下面子文件夹里的会话` : '';
    b.classList.toggle('on', !!this.folder);
    document.querySelector('#hi-folder-x').classList.toggle('hidden', !this.folder);
    this.reload();
  },

  folderMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [
      { label: '按文件夹看（含子文件夹）' },
      { text: '全部文件夹', icon: 'chat', current: !this.folder, onClick: () => this.setFolder('') },
    ];
    if (this.folders.length) items.push('-');
    this.folders.slice(0, 15).forEach(([p, n]) => items.push({ text: this.short(p), desc: `${n} 个`, icon: 'folder', current: this.folder === p, onClick: () => this.setFolder(p) }));
    items.push('-', {
      text: '选择服务器上的文件夹…',
      icon: 'folder',
      onClick: async () => {
        const p = await pickFolder(this.folder || (typeof remoteInfo !== 'undefined' && remoteInfo.home) || '~');
        if (p) this.setFolder(p);
      },
    });
    showMenu(items, { clientX: r.left, clientY: r.bottom + 4 });
  },

  // 只看当前服务器上的对话（不同服务器的会话编号互不相干）
  imported(id) {
    return data.sessions.find((s) => s.claudeId === id && (!data.currentServer || s.serverId === data.currentServer));
  },

  // 以前的版本导入时没记服务器，侧栏按服务器过滤后就看不见了：编号能在这台服务器的列表里对上的，归回这台服务器
  adoptOrphans() {
    if (!data.currentServer) return;
    const ids = new Set((this.items || []).map((x) => x.id));
    let n = 0;
    for (const s of data.sessions) {
      if (!s.serverId && s.claudeId && ids.has(s.claudeId)) { s.serverId = data.currentServer; n++; }
    }
    if (n) {
      save();
      renderSidebar();
      toast(`找回了 ${n} 个之前导入但没显示出来的对话`, 4000);
    }
  },

  visible() {
    const f = this.filter;
    return (this.items || []).filter((x) => !f || `${x.title} ${x.first} ${x.cwd}`.toLowerCase().includes(f));
  },

  render() {
    const box = document.querySelector('#hi-list');
    if (!box) return;
    if (this.error) { box.innerHTML = `<div class="fm-empty err">${esc(this.error)}</div>`; return; }
    if (!this.items) { box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取服务器上的会话…</span></div>'; return; }
    const list = this.visible();
    const left = list.filter((x) => !this.imported(x.id)).length;
    const all = document.querySelector('#hi-all');
    all.disabled = !left;
    all.querySelector('span').textContent = left ? `全部导入（${left}）` : '都已导入';
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = `<div class="fm-empty">${this.items.length ? '没有匹配的会话' : this.folder ? `「${esc(this.short(this.folder))}」和它的子文件夹里没有 Claude Code 会话` : '服务器上还没有 Claude Code 会话'}</div>`; return; }
    for (const x of list) {
      const done = this.imported(x.id);
      const c = el('div', 'pl-card hi-card');
      const title = (x.title || x.first || '（没有内容）').replace(/\s+/g, ' ');
      c.innerHTML = `
        <div class="pl-ico">${icon('chat')}</div>
        <div class="pl-main">
          <div class="pl-name hi-title">${esc(title.slice(0, 80))}</div>
          ${x.title && x.first ? `<div class="pl-desc hi-first">${esc(x.first.replace(/\s+/g, ' ').slice(0, 120))}</div>` : ''}
          <div class="hi-meta"><span class="mono">${esc(x.cwd || x.project)}</span><span>${fmtTime(x.mtime)}</span><span>${x.prompts} 问 · ${x.replies} 答</span></div>
        </div>
        <div class="pl-act"></div>`;
      const act = c.querySelector('.pl-act');
      if (this.busy[x.id]) act.innerHTML = '<span class="spin"></span>';
      else if (done) {
        const b = el('button', 'btn', '打开');
        b.onclick = () => openSession(done.id);
        act.appendChild(b);
      } else {
        const b = el('button', 'btn primary', '导入');
        b.onclick = async () => { const s = await this.importOne(x); if (s) openSession(s.id); };
        act.appendChild(b);
      }
      box.appendChild(c);
    }
  },

  groupId() {
    let g = data.groups.find((x) => x.name === '服务器上的会话' && (!x.serverId || x.serverId === data.currentServer));
    if (!g) {
      g = { id: uid(), name: '服务器上的会话', collapsed: false, createdAt: Date.now(), serverId: data.currentServer || null };
      data.groups.push(g);
    }
    return g.id;
  },

  async importOne(x, quiet) {
    if (this.imported(x.id)) return this.imported(x.id);
    this.busy[x.id] = true;
    this.render();
    const r = this.demo ? (await new Promise((res) => setTimeout(res, 500)), this.demo.load(x.id)) : await api.historyLoad(x.id);
    delete this.busy[x.id];
    if (!r.ok) { toast(`导入失败：${r.message}`, 5000); this.render(); return null; }
    const s = {
      id: uid(),
      title: (r.title || x.title || x.first || '服务器会话').replace(/\s+/g, ' ').slice(0, 40),
      groupId: this.demo ? null : this.groupId(),
      createdAt: x.mtime,
      updatedAt: r.mtime || x.mtime,
      started: true,
      claudeId: r.id,
      cwd: r.cwd || x.cwd || null,
      serverId: data.currentServer || null,
      imported: true,
      messages: r.messages,
    };
    if (this.demo) s.demo = true; // 功能介绍的演示会话，介绍结束自动删
    data.sessions.push(s);
    save();
    renderSidebar();
    this.render();
    if (!quiet) toast(`已导入「${s.title}」`);
    return s;
  },

  async importAll() {
    const todo = this.visible().filter((x) => !this.imported(x.id));
    let n = 0;
    for (const x of todo) if (await this.importOne(x, true)) n++;
    toast(`已导入 ${n} 个会话，放在「服务器上的会话」分组里`, 4000);
  },
};

// 连上一台服务器时：还有没记服务器的老对话，就悄悄读一次这台的会话列表，把对得上的归回来
async function adoptOrphansQuietly() {
  if (!data.currentServer || !data.sessions.some((s) => !s.serverId && s.claudeId)) return;
  const server = data.currentServer;
  const r = await api.historyList();
  if (!r.ok || server !== data.currentServer) return;
  historyView.items = r.items;
  historyView.adoptOrphans();
}

// 已有会话：从服务器重新载入（比如在终端里接着聊过）
async function reloadFromServer(sid) {
  const s = data.sessions.find((x) => x.id === sid);
  if (!s || !s.claudeId) return;
  const r = await api.historyLoad(s.claudeId);
  if (!r.ok) return toast(`载入失败：${r.message}`, 5000);
  s.messages = r.messages;
  s.cwd = s.cwd || r.cwd || null;
  s.updatedAt = Math.max(s.updatedAt || 0, r.mtime || 0);
  save();
  if (typeof openSession === 'function') openSession(s.id);
  toast(`已载入服务器上的最新内容（${r.messages.length} 条消息）`);
}

document.querySelector('#btn-history').onclick = () => showView('history');

// 列表里的名字跟服务器同步：在终端里 /rename 过的用那个名字（覆盖本地）；没手动改过名的跟 Claude Code 的自动标题走。
// 连上服务器、回到软件时各做一次（一分钟内最多一次）
let titlesSyncedAt = 0;
async function syncTitlesFromServer(force) {
  if (!force && Date.now() - titlesSyncedAt < 60000) return;
  titlesSyncedAt = Date.now();
  const server = data.currentServer;
  const list = data.sessions.filter((s) => s.started && s.claudeId && (!server || s.serverId === server)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300);
  if (!list.length) return;
  const r = await api.historyTitles(list.map((s) => s.claudeId));
  if (!r.ok || server !== data.currentServer) return;
  let n = 0;
  for (const s of list) {
    const t = r.titles[s.claudeId];
    if (!t) continue;
    if (t.custom && t.custom !== s.title) { s.title = t.custom.slice(0, 60); s.titleLocked = true; n++; }
    else if (!t.custom && t.ai && !s.titleLocked && t.ai !== s.title) { s.title = t.ai.slice(0, 60); n++; }
  }
  if (n) {
    save();
    renderSidebar();
    if (typeof renderTitle === 'function') renderTitle();
  }
}
window.addEventListener('focus', () => syncTitlesFromServer(false));
