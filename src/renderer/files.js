/* global api, el, esc, icon, toast, fmtSize, fmtTime, showMenu, promptModal, confirmModal, downloadFile, openPreview, iconFor, uid */
'use strict';

// ---------- 视图切换：聊天 / 服务器文件 / 预览插件 ----------
function showView(name) {
  document.body.dataset.view = name;
  document.querySelector('#btn-files').classList.toggle('on', name === 'files');
  document.querySelector('#btn-plugins').classList.toggle('on', name === 'plugins');
  if (name === 'files') fm.open();
  if (name === 'plugins') pluginsView.open();
}

// ---------- 文件管理器 ----------
const fm = {
  root: null,
  cur: null,
  items: [],
  back: [],
  fwd: [],
  selected: null,
  uploads: [],
  busy: null,
  built: false,

  build() {
    const v = document.querySelector('#view-files');
    v.innerHTML = `
      <div class="fm-bar">
        <button class="icon-btn" id="fm-back" title="后退">${icon('back')}</button>
        <button class="icon-btn" id="fm-fwd" title="前进">${icon('forward')}</button>
        <button class="icon-btn" id="fm-up" title="上一级">${icon('up')}</button>
        <div class="fm-crumbs" id="fm-crumbs"></div>
        <button class="icon-btn" id="fm-refresh" title="刷新">${icon('refresh')}</button>
        <button class="btn" id="fm-mkdir">${icon('folderPlus')}<span>新建文件夹</span></button>
        <button class="btn" id="fm-upload">${icon('upload')}<span>上传文件</span></button>
      </div>
      <div class="fm-status" id="fm-status"></div>
      <div class="fm-head"><span class="c-name">名称</span><span class="c-size">大小</span><span class="c-time">修改时间</span><span class="c-act"></span></div>
      <div class="fm-list" id="fm-list"></div>
      <div class="fm-foot">双击打开 · 右键更多操作 · 把电脑上的文件拖进来即可上传到当前文件夹</div>`;
    v.querySelector('#fm-back').onclick = () => this.goBack();
    v.querySelector('#fm-fwd').onclick = () => this.goFwd();
    v.querySelector('#fm-up').onclick = () => this.goUp();
    v.querySelector('#fm-refresh').onclick = () => this.load(this.cur, false);
    v.querySelector('#fm-mkdir').onclick = () => this.mkdir();
    v.querySelector('#fm-upload').onclick = async () => this.upload(await api.pickFiles());
    v.querySelector('#fm-list').addEventListener('mousedown', (e) => {
      if (!e.target.closest('.fm-row')) this.select(null);
    });
    v.querySelector('#fm-list').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fm-row')) return;
      e.preventDefault();
      showMenu([
        { text: '新建文件夹', icon: 'folderPlus', onClick: () => this.mkdir() },
        { text: '上传文件', icon: 'upload', onClick: async () => this.upload(await api.pickFiles()) },
        { text: '刷新', icon: 'refresh', onClick: () => this.load(this.cur, false) },
      ], e);
    });
    this.built = true;
  },

  async open() {
    if (!this.built) this.build();
    if (!this.cur) await this.load(null, false);
  },

  async load(dir, pushHistory = true) {
    const list = document.querySelector('#fm-list');
    list.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>加载中…</span></div>';
    const c = await api.connect();
    if (!c.ok) {
      list.innerHTML = `<div class="fm-empty err">连接服务器失败：${esc(c.message)}</div>`;
      return;
    }
    const r = await api.listDir(dir);
    if (!r.ok) {
      list.innerHTML = `<div class="fm-empty err">读取失败：${esc(r.message)}</div>`;
      return;
    }
    if (pushHistory && this.cur && this.cur !== r.dir) {
      this.back.push(this.cur);
      this.fwd = [];
    }
    this.root = r.root;
    this.cur = r.dir;
    this.items = r.items;
    this.selected = null;
    this.render();
  },

  goBack() { if (this.back.length) { this.fwd.push(this.cur); this.load(this.back.pop(), false); } },
  goFwd() { if (this.fwd.length) { this.back.push(this.cur); this.load(this.fwd.pop(), false); } },
  goUp() { if (this.cur && this.cur !== this.root) this.load(this.cur.replace(/\/[^/]+$/, '') || '/'); },

  renderCrumbs() {
    const box = document.querySelector('#fm-crumbs');
    box.innerHTML = '';
    const rel = this.cur === this.root ? '' : this.cur.slice(this.root.length + 1);
    const parts = rel ? rel.split('/') : [];
    const add = (label, path, last) => {
      const b = el('button', 'crumb' + (last ? ' last' : ''), esc(label));
      b.title = path;
      if (!last) b.onclick = () => this.load(path);
      box.appendChild(b);
    };
    add('工作文件夹', this.root, !parts.length);
    let acc = this.root;
    parts.forEach((p, i) => {
      box.appendChild(el('span', 'crumb-sep', icon('chevron')));
      acc += '/' + p;
      add(p, acc, i === parts.length - 1);
    });
  },

  render() {
    document.querySelector('#fm-back').disabled = !this.back.length;
    document.querySelector('#fm-fwd').disabled = !this.fwd.length;
    document.querySelector('#fm-up').disabled = this.cur === this.root;
    this.renderCrumbs();
    const list = document.querySelector('#fm-list');
    list.innerHTML = '';
    for (const u of this.uploads.filter((x) => x.dir === this.cur)) list.appendChild(this.uploadRow(u));
    if (!this.items.length && !this.uploads.some((x) => x.dir === this.cur)) {
      list.innerHTML = '<div class="fm-empty">这个文件夹是空的，可以把文件拖进来上传</div>';
      return;
    }
    for (const it of this.items) list.appendChild(this.row(it));
  },

  row(it) {
    const r = el('div', 'fm-row' + (it.isDir ? ' dir' : '') + (this.selected === it.path ? ' sel' : ''));
    r.dataset.path = it.path;
    r.innerHTML = `<span class="c-name">${icon(it.isDir ? 'folder' : iconFor(it.name))}<span class="nm">${esc(it.name)}</span></span>
      <span class="c-size">${it.isDir ? '' : fmtSize(it.size)}</span><span class="c-time">${fmtTime(it.mtime)}</span>`;
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
      showMenu([
        it.isDir
          ? { text: '打开', icon: 'folder', onClick: () => this.load(it.path) }
          : { text: '预览', icon: 'eye', onClick: () => openPreview(it.path) },
        { text: it.isDir ? '下载整个文件夹' : '下载', icon: 'download', onClick: () => this.download(it) },
        '-',
        { text: '重命名', icon: 'pencil', onClick: () => this.rename(it) },
        { text: '删除', icon: 'trash', danger: true, onClick: () => this.remove(it) },
      ], e);
    };
    return r;
  },

  select(p) {
    this.selected = p;
    document.querySelectorAll('#fm-list .fm-row').forEach((r) => r.classList.toggle('sel', r.dataset.path === p));
  },

  status(text) {
    const s = document.querySelector('#fm-status');
    if (!s) return;
    s.innerHTML = text ? `<span class="spin"></span><span>${esc(text)}</span>` : '';
    s.classList.toggle('on', !!text);
  },

  async download(it) {
    if (!it.isDir) return downloadFile(it.path);
    this.status(`正在下载文件夹「${it.name}」…`);
    this.busy = it.path;
    const r = await api.downloadDir(it.path);
    this.busy = null;
    this.status('');
    if (r.ok && !r.canceled) toast(`已下载 ${r.files} 个文件到 ${r.localPath}`, 4000);
    else if (!r.ok) toast('下载失败：' + r.message, 5000);
  },

  async mkdir() {
    const name = await promptModal('新建文件夹', '文件夹名称', '');
    if (!name || !name.trim()) return;
    const r = await api.mkdir(this.cur, name.trim());
    if (!r.ok) return toast(r.message, 4000);
    this.load(this.cur, false);
  },

  async rename(it) {
    const name = await promptModal('重命名', '新名称', it.name);
    if (!name || !name.trim() || name.trim() === it.name) return;
    const r = await api.rename(it.path, name.trim());
    if (!r.ok) return toast(r.message, 4000);
    this.load(this.cur, false);
  },

  async remove(it) {
    const ok = await confirmModal('删除', `确定删除${it.isDir ? '文件夹' : '文件'}「${it.name}」吗？${it.isDir ? '里面的所有内容都会被删除，' : ''}删除后无法恢复。`, '删除');
    if (!ok) return;
    const r = await api.remove(it.path);
    if (!r.ok) return toast(r.message, 4000);
    toast('已删除');
    this.load(this.cur, false);
  },

  uploadRow(u) {
    const r = el('div', 'fm-row uploading');
    r.innerHTML = `<span class="c-name">${icon('upload')}<span class="nm">${esc(u.name)}</span></span>
      <span class="c-size">${u.error ? '失败' : Math.round((u.progress || 0) * 100) + '%'}</span><span class="c-time">${u.error ? esc(u.error) : '上传中'}</span><span class="c-act"></span>`;
    r.dataset.upload = u.id;
    return r;
  },

  async upload(paths) {
    paths = (paths || []).filter(Boolean);
    if (!paths.length) return;
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
  },
};

api.onProgress(({ uploadId, done, total }) => {
  const j = fm.uploads.find((x) => x.id === uploadId);
  if (!j) return;
  j.progress = total ? done / total : 0;
  const row = document.querySelector(`#fm-list [data-upload="${uploadId}"] .c-size`);
  if (row) row.textContent = Math.round(j.progress * 100) + '%';
});
api.onDlProgress(({ done, total, i, count }) => {
  if (fm.busy) fm.status(`正在下载文件夹… ${i}/${count} 个文件 · ${fmtSize(done)} / ${fmtSize(total)}`);
});

document.querySelector('#btn-files').onclick = () => showView('files');
document.querySelector('#btn-plugins').onclick = () => showView('plugins');
document.body.dataset.view = 'chat';
