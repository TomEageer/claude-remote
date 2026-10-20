/* global api, el, esc, icon, toast, fmtSize, fmtTime, showMenu, promptModal, confirmModal, downloadFile, openPreview, iconFor, uid, pluginsView, capsView, historyView, timeline, data, save */
'use strict';

// ---------- 视图切换：聊天 / 服务器文件 / 预览插件 / MCP 与 Skill / 服务器会话 ----------
function showView(name) {
  // MCP 与 Skill、预览插件已经并入「设置」
  if (name === 'caps' || name === 'plugins') return openSettings(name);
  document.body.dataset.view = name;
  document.querySelector('#btn-files').classList.toggle('on', name === 'files');
  document.querySelector('#btn-history').classList.toggle('on', name === 'history');
  if (name === 'history') historyView.open();
  if (name === 'files') fm.open();
  if (name === 'chat' && typeof timeline !== 'undefined') timeline.schedule();
}

// 路径显示：用户目录显示成 ~
function shortPath(p, home) {
  if (!p) return '';
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

// ---------- 文件浏览组件：整页「服务器文件」和对话旁的文件面板共用 ----------
// 列表的列：[排序键, 标题, 样式]
const SORT_COLS = [['name', '名称', 'c-name'], ['size', '大小', 'c-size'], ['mtime', '修改时间', 'c-time'], ['btime', '添加时间', 'c-time'], ['open', '上次打开', 'c-time']];

class FileBrowser {
  // opts.compact：窄面板（隐藏时间列）；opts.start()：首次打开时的目录
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.cur = null;
    this.home = null;
    this.items = [];
    this.back = [];
    this.fwd = [];
    this.selected = null;
    this.uploads = [];
    this.busy = null;
    this.seq = 0;
    this.built = false;
  }

  q(sel) { return this.root.querySelector(sel); }

  build() {
    this.root.innerHTML = `
      <div class="fm-bar">
        <button class="icon-btn" data-a="back" title="后退">${icon('back')}</button>
        <button class="icon-btn" data-a="fwd" title="前进">${icon('forward')}</button>
        <button class="icon-btn" data-a="up" title="上一级">${icon('up')}</button>
        <div class="fm-crumbs" title="点空白处可以直接输入路径"></div>
        <button class="icon-btn" data-a="sort" title="排序方式">${icon('list')}</button>
        <button class="icon-btn" data-a="refresh" title="刷新">${icon('refresh')}</button>
        <button class="${this.opts.compact ? 'icon-btn' : 'btn'}" data-a="mkdir" title="新建文件夹">${icon('folderPlus')}${this.opts.compact ? '' : '<span>新建文件夹</span>'}</button>
        <button class="${this.opts.compact ? 'icon-btn' : 'btn'}" data-a="upload" title="上传文件或文件夹到这里">${icon('upload')}${this.opts.compact ? '' : '<span>上传</span>'}</button>
      </div>
      <div class="fm-status"></div>
      ${this.opts.compact ? '' : `<div class="fm-head">${SORT_COLS.map(([k, t, c]) => `<button class="${c} sortable" data-sort="${k}">${t}<i></i></button>`).join('')}<span class="c-act"></span></div>`}
      <div class="fm-list"></div>
      <div class="fm-foot">${this.opts.compact ? '双击打开 · 右键更多 · 拖文件进来上传' : '双击打开 · 右键更多操作 · 把电脑上的文件拖进来即可上传到当前文件夹'}</div>`;
    this.root.classList.toggle('compact', !!this.opts.compact);
    const act = { back: () => this.goBack(), fwd: () => this.goFwd(), up: () => this.goUp(), refresh: () => this.load(this.cur, false), mkdir: () => this.mkdir(), upload: (e) => showMenu([
      { text: '上传文件', icon: 'file', onClick: async () => this.upload(await api.pickFiles()) },
      { text: '上传文件夹', icon: 'folder', onClick: async () => this.upload(await api.pickFiles('dir')) },
    ], { clientX: e.currentTarget.getBoundingClientRect().left, clientY: e.currentTarget.getBoundingClientRect().bottom + 4 }), sort: (e) => this.sortMenu(e) };
    this.root.querySelectorAll('.fm-head [data-sort]').forEach((b) => (b.onclick = () => this.setSort(b.dataset.sort)));
    // 点路径栏的空白处（或最后一级）：变成输入框，直接输入 / 粘贴路径，回车跳过去
    this.q('.fm-crumbs').addEventListener('click', (e) => { if (!e.target.closest('.crumb:not(.last)')) this.editPath(); });
    this.root.querySelectorAll('.fm-bar [data-a]').forEach((b) => (b.onclick = (e) => act[b.dataset.a](e)));
    const list = this.q('.fm-list');
    list.addEventListener('mousedown', (e) => { if (!e.target.closest('.fm-row')) this.select(null); });
    list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fm-row')) return;
      e.preventDefault();
      showMenu([
        { text: '新建文件夹', icon: 'folderPlus', onClick: () => this.mkdir() },
        { text: '上传文件', icon: 'upload', onClick: async () => this.upload(await api.pickFiles()) },
        { text: '上传文件夹', icon: 'folder', onClick: async () => this.upload(await api.pickFiles('dir')) },
        { text: '刷新', icon: 'refresh', onClick: () => this.load(this.cur, false) },
      ], e);
    });
    this.built = true;
  }

  async open(dir) {
    if (!this.built) this.build();
    const target = dir || (!this.cur && this.opts.start ? this.opts.start() : null);
    if (target && target !== this.cur) await this.load(target, !!this.cur);
    else if (!this.cur) await this.load(null, false);
  }

  // 进入文件夹：先立刻把路径栏切过去并显示加载中，再去服务器读列表
  async load(dir, pushHistory = true) {
    const seq = ++this.seq;
    const prev = this.cur;
    if (dir) {
      this.cur = dir;
      this.renderCrumbs();
      this.updateNav();
    }
    const list = this.q('.fm-list');
    list.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>加载中…</span></div>';
    const c = await api.connect();
    if (seq !== this.seq) return;
    if (!c.ok) {
      list.innerHTML = `<div class="fm-empty err">连接服务器失败：${esc(c.message)}</div>`;
      return;
    }
    const r = await api.listDir(dir);
    if (seq !== this.seq) return; // 期间又点了别的文件夹，以最新的为准
    if (!r.ok) {
      this.cur = prev;
      this.renderCrumbs();
      this.updateNav();
      list.innerHTML = `<div class="fm-empty err">打不开这个文件夹：${esc(r.message)}</div>`;
      return;
    }
    if (pushHistory && prev && prev !== r.dir) {
      this.back.push(prev);
      this.fwd = [];
    }
    this.home = r.home || this.home;
    this.cur = r.dir;
    this.items = r.items;
    this.selected = null;
    this.render();
    // 添加时间（创建时间）SFTP 拿不到：列表先出来，再去服务器读一次补上（本机模式直接有）
    if (!this.opts.compact || this.sortKey() === 'btime') this.fillBirth(r.dir, seq);
  }

  async fillBirth(dir, seq) {
    if (this.items.some((x) => x.btime)) return;
    const r = await api.fileBirth(dir);
    if (!r.ok || seq !== this.seq || this.cur !== dir) return;
    for (const it of this.items) it.btime = r.birth[it.name] || 0;
    this.render();
  }

  // ---------- 排序 ----------
  sortState() { return (data.ui && data.ui.fmSort) || { key: 'mtime', desc: true }; }
  sortKey() { return this.sortState().key; }
  setSort(key) {
    const cur = this.sortState();
    data.ui.fmSort = cur.key === key ? { key, desc: !cur.desc } : { key, desc: key !== 'name' };
    save();
    if (key === 'btime') this.fillBirth(this.cur, this.seq);
    this.render();
  }
  sortMenu(e) {
    const cur = this.sortState();
    showMenu([{ label: '排序方式' }, ...SORT_COLS.map(([k, t]) => ({ text: t + (cur.key === k ? (cur.desc ? '（从新到旧 / 大到小）' : '（从旧到新 / 小到大）') : ''), current: cur.key === k, onClick: () => this.setSort(k) }))], e);
  }
  lastOpen(it) { return Math.max(it.atime || 0, ((data.ui && data.ui.opened) || {})[it.path] || 0); }
  sorted() {
    const { key, desc } = this.sortState();
    const val = (it) => (key === 'name' ? it.name.toLowerCase() : key === 'size' ? it.size || 0 : key === 'open' ? this.lastOpen(it) : it[key] || 0);
    return [...this.items].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 文件夹始终在前
      const x = val(a);
      const y = val(b);
      const c = key === 'name' ? x.localeCompare(y, 'zh-Hans-CN', { numeric: true }) : x - y;
      return desc ? -c : c;
    });
  }

  // ---------- 路径栏输入 ----------
  editPath() {
    const box = this.q('.fm-crumbs');
    if (box.querySelector('input')) return;
    const input = el('input', 'fm-path-input');
    input.value = this.cur || '';
    input.spellcheck = false;
    box.innerHTML = '';
    box.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (go) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (go && v && v !== this.cur) this.load(v);
      else this.renderCrumbs();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    input.onblur = () => finish(false);
  }

  goBack() { if (this.back.length) { this.fwd.push(this.cur); this.load(this.back.pop(), false); } }
  goFwd() { if (this.fwd.length) { this.back.push(this.cur); this.load(this.fwd.pop(), false); } }
  goUp() { if (this.cur && this.cur !== '/') this.load(this.cur.replace(/\/[^/]+$/, '') || '/'); }

  updateNav() {
    this.q('[data-a="back"]').disabled = !this.back.length;
    this.q('[data-a="fwd"]').disabled = !this.fwd.length;
    this.q('[data-a="up"]').disabled = !this.cur || this.cur === '/';
  }

  renderCrumbs() {
    const box = this.q('.fm-crumbs');
    box.innerHTML = '';
    if (!this.cur) return;
    const home = this.home;
    const underHome = home && (this.cur === home || this.cur.startsWith(home + '/'));
    const base = underHome ? home : '';
    const rel = this.cur.slice(base.length).replace(/^\//, '');
    const parts = rel ? rel.split('/') : [];
    const add = (label, p, last) => {
      const b = el('button', 'crumb' + (last ? ' last' : ''), esc(label));
      b.title = p;
      if (!last) b.onclick = () => this.load(p);
      box.appendChild(b);
    };
    add(underHome ? '~' : '/', base || '/', !parts.length);
    let acc = base;
    parts.forEach((p, i) => {
      box.appendChild(el('span', 'crumb-sep', icon('chevron')));
      acc += '/' + p;
      add(p, acc, i === parts.length - 1);
    });
    box.scrollLeft = box.scrollWidth;
  }

  render() {
    this.updateNav();
    this.renderCrumbs();
    const list = this.q('.fm-list');
    list.innerHTML = '';
    for (const u of this.uploads.filter((x) => x.dir === this.cur)) list.appendChild(this.uploadRow(u));
    if (!this.items.length && !this.uploads.some((x) => x.dir === this.cur)) {
      list.innerHTML = '<div class="fm-empty">这个文件夹是空的，可以把文件拖进来上传</div>';
      return;
    }
    for (const it of this.sorted()) list.appendChild(this.row(it));
    const { key, desc } = this.sortState();
    this.root.querySelectorAll('.fm-head [data-sort]').forEach((b) => { b.classList.toggle('on', b.dataset.sort === key); b.querySelector('i').textContent = b.dataset.sort === key ? (desc ? '↓' : '↑') : ''; });
  }

  row(it) {
    const r = el('div', 'fm-row' + (it.isDir ? ' dir' : '') + (this.selected === it.path ? ' sel' : ''));
    r.dataset.path = it.path;
    r.innerHTML = `<span class="c-name">${icon(it.isDir ? 'folder' : iconFor(it.name))}<span class="nm">${esc(it.name)}</span></span>
      <span class="c-size">${it.isDir ? '' : fmtSize(it.size)}</span>${this.opts.compact ? '' : `<span class="c-time">${fmtTime(it.mtime)}</span><span class="c-time c-btime">${it.btime ? fmtTime(it.btime) : '—'}</span><span class="c-time">${this.lastOpen(it) ? fmtTime(this.lastOpen(it)) : '—'}</span>`}`;
    const act = el('span', 'c-act');
    if (!it.isDir) {
      const pv = el('button', 'mini-btn', icon('eye'));
      pv.title = '预览';
      pv.onclick = (e) => { e.stopPropagation(); openPreview(it.path); };
      act.appendChild(pv);
    }
    const dl = el('button', 'mini-btn', icon('download'));
    dl.title = it.isDir ? '下载整个文件夹' : '下载';
    dl.onclick = (e) => { e.stopPropagation(); this.download(it); };
    act.appendChild(dl);
    r.appendChild(act);
    r.onclick = () => this.select(it.path);
    r.ondblclick = () => (it.isDir ? this.load(it.path) : openPreview(it.path));
    r.oncontextmenu = (e) => {
      e.preventDefault();
      this.select(it.path);
      const items = [
        it.isDir ? { text: '打开', icon: 'folder', onClick: () => this.load(it.path) } : { text: '预览', icon: 'eye', onClick: () => openPreview(it.path) },
        { text: it.isDir ? '下载整个文件夹' : '下载', icon: 'download', onClick: () => this.download(it) },
      ];
      if (it.isDir && typeof startNewChatIn === 'function') items.push({ text: '在这个文件夹开新对话', icon: 'chat', onClick: () => startNewChatIn(it.path) });
      items.push('-', { text: '重命名', icon: 'pencil', onClick: () => this.rename(it) }, { text: '删除', icon: 'trash', danger: true, onClick: () => this.remove(it) });
      showMenu(items, e);
    };
    return r;
  }

  select(p) {
    this.selected = p;
    this.root.querySelectorAll('.fm-list .fm-row').forEach((r) => r.classList.toggle('sel', r.dataset.path === p));
  }

  status(text) {
    const s = this.q('.fm-status');
    if (!s) return;
    s.innerHTML = text ? `<span class="spin"></span><span>${esc(text)}</span>` : '';
    s.classList.toggle('on', !!text);
  }

  async download(it) {
    if (!it.isDir) return downloadFile(it.path);
    this.status(`正在下载文件夹「${it.name}」…`);
    this.busy = it.path;
    const r = await api.downloadDir(it.path);
    this.busy = null;
    this.status('');
    if (r.ok && !r.canceled) toast(`已下载 ${r.files} 个文件到 ${r.localPath}`, 4000);
    else if (!r.ok) toast('下载失败：' + r.message, 5000);
  }

  async mkdir() {
    const name = await promptModal('新建文件夹', '文件夹名称', '');
    if (!name || !name.trim()) return;
    const r = await api.mkdir(this.cur, name.trim());
    if (!r.ok) return toast(r.message, 4000);
    this.load(this.cur, false);
  }

  async rename(it) {
    const name = await promptModal('重命名', '新名称', it.name);
    if (!name || !name.trim() || name.trim() === it.name) return;
    const r = await api.rename(it.path, name.trim());
    if (!r.ok) return toast(r.message, 4000);
    this.load(this.cur, false);
  }

  async remove(it) {
    const ok = await confirmModal('删除', `确定删除${it.isDir ? '文件夹' : '文件'}「${it.name}」吗？${it.isDir ? '里面的所有内容都会被删除，' : ''}删除后无法恢复。`, '删除');
    if (!ok) return;
    const r = await api.remove(it.path);
    if (!r.ok) return toast(r.message, 4000);
    toast('已删除');
    this.load(this.cur, false);
  }

  uploadRow(u) {
    const r = el('div', 'fm-row uploading');
    r.innerHTML = `<span class="c-name">${icon('upload')}<span class="nm">${esc(u.name)}</span></span>
      <span class="c-size">${u.error ? '失败' : Math.round((u.progress || 0) * 100) + '%'}</span>${this.opts.compact ? '' : `<span class="c-time">${u.error ? esc(u.error) : '上传中'}</span>`}<span class="c-act"></span>`;
    r.dataset.upload = u.id;
    return r;
  }

  async upload(paths) {
    paths = (paths || []).filter(Boolean);
    if (!paths.length || !this.cur) return;
    const dir = this.cur;
    const jobs = paths.map((p) => ({ id: uid(), name: p.split(/[\\/]/).pop(), localPath: p, dir, progress: 0 }));
    this.uploads.push(...jobs);
    this.render();
    await Promise.all(jobs.map(async (j) => {
      const r = await api.uploadTo(j.id, j.localPath, dir);
      if (!r.ok) { j.error = r.message; toast(`${j.name} 上传失败：${r.message}`, 5000); }
      else this.uploads = this.uploads.filter((x) => x !== j);
    }));
    if (this.cur === dir) this.load(dir, false);
    setTimeout(() => { this.uploads = this.uploads.filter((x) => !x.error); }, 8000);
  }

  progress(uploadId, frac) {
    const j = this.uploads.find((x) => x.id === uploadId);
    if (!j) return;
    j.progress = frac;
    const cell = this.root.querySelector(`.fm-list [data-upload="${uploadId}"] .c-size`);
    if (cell) cell.textContent = Math.round(frac * 100) + '%';
  }
}

// 整页「服务器文件」：从当前对话的文件夹开始
const fm = new FileBrowser(document.querySelector('#view-files'), {
  start: () => (typeof chatCwd === 'function' ? chatCwd() : null),
});

api.onProgress(({ uploadId, done, total }) => {
  const frac = total ? done / total : 0;
  fm.progress(uploadId, frac);
  if (typeof filePane !== 'undefined' && filePane.browser) filePane.browser.progress(uploadId, frac);
});
api.onDlProgress(({ done, total, i, count }) => {
  const b = fm.busy ? fm : typeof filePane !== 'undefined' && filePane.browser && filePane.browser.busy ? filePane.browser : null;
  if (b) b.status(`正在下载文件夹… ${i}/${count} 个文件 · ${fmtSize(done)} / ${fmtSize(total)}`);
});

document.querySelector('#btn-files').onclick = () => showView('files');
document.body.dataset.view = 'chat';
