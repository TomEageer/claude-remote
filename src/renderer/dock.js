/* global api, el, esc, icon, data, save, showMenu, filePane, renderPreview, disposePreviewPane, iconFor, renderCwd, timeline */
'use strict';

// ---------- 右侧面板：文件 + 预览 ----------
// 像浏览器一样：顶部是标签栏，一次显示一个，切换、关闭。每个预览标签有自己的页面，
// 切走再切回来不会重新加载；关掉标签时页面和它的缓存一起删掉。
// 全部关掉后整个面板收起，打开时为了不挤对话而加宽的窗口也恢复原样。
const MIN_CHAT = 560; // 对话区至少留这么宽
const dock = {
  el: document.querySelector('#dock'),
  tabsEl: document.querySelector('#dock-tabs'),
  tabs: [], // { key: 'files' } | { key: 'pv:<路径>', path, opts, pane }
  active: null,
  grown: false, // 为了放下面板加宽过窗口

  find(key) { return this.tabs.find((t) => t.key === key); },
  hasPreview() { return this.tabs.some((t) => t.key !== 'files'); },

  // 打开（或切到）文件面板
  showFiles() {
    if (!this.find('files')) this.tabs.push({ key: 'files' });
    this.activate('files');
  },

  // 打开（或切到）某个文件的预览；同一个文件只占一个标签
  openPreview(path, opts = {}) {
    const key = 'pv:' + path;
    let t = this.find(key);
    const changed = t && JSON.stringify(t.opts || {}) !== JSON.stringify(opts);
    if (!t) {
      t = { key, path, opts, pane: el('div', 'pv-pane') };
      document.querySelector('#preview').appendChild(t.pane);
      this.tabs.push(t);
      renderPreview(path, opts, t.pane);
    } else if (changed) {
      // 同一个文件换了显示方式（网页 / 源码）：在原来的页面里重画
      t.opts = opts;
      renderPreview(path, opts, t.pane);
    }
    this.activate(key);
  },

  activate(key) {
    const t = this.find(key);
    if (!t) return;
    this.active = key;
    const pv = document.querySelector('#preview');
    document.querySelector('#filepane').classList.toggle('hidden', key !== 'files');
    pv.classList.toggle('hidden', key === 'files');
    // 只是显示 / 隐藏各自的页面，不重新加载
    this.tabs.forEach((x) => { if (x.pane) x.pane.classList.toggle('hidden', x !== t); });
    this.show();
    this.render();
  },

  close(key) {
    const i = this.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    if (key === 'files') {
      filePane.open = false;
      renderCwd();
    } else disposePreviewPane(t.pane);
    if (this.active === key) {
      const next = this.tabs[i] || this.tabs[i - 1];
      this.active = null;
      if (next) return this.activate(next.key);
    }
    if (!this.tabs.length) return this.hide();
    this.render();
  },

  closeMany(keys) {
    keys.forEach((k) => this.close(k));
  },

  closeActivePreview() {
    if (this.active && this.active !== 'files') this.close(this.active);
  },

  // 面板开着就显示标签栏（哪怕只有一个），和浏览器一样
  render() {
    const any = this.tabs.length > 0;
    this.el.classList.toggle('tabbed', any);
    this.tabsEl.classList.toggle('hidden', !any);
    this.tabsEl.innerHTML = '';
    if (!any) return;
    this.tabs.forEach((t, i) => {
      const name = t.key === 'files' ? '文件' : t.path.split('/').pop();
      const tab = el('div', 'dock-tab' + (t.key === this.active ? ' on' : ''), `${icon(t.key === 'files' ? 'folder' : iconFor(name))}<span class="dt-name">${esc(name)}</span>`);
      tab.title = t.key === 'files' ? '文件' : t.path;
      const x = el('button', 'dt-x', icon('close'));
      x.title = '关闭';
      x.onclick = (e) => { e.stopPropagation(); this.close(t.key); };
      tab.appendChild(x);
      tab.onclick = () => this.activate(t.key);
      tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); this.close(t.key); } };
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        const keys = this.tabs.map((x2) => x2.key);
        showMenu([
          { text: '关闭', icon: 'close', onClick: () => this.close(t.key) },
          { text: '关闭其他标签', onClick: () => this.closeMany(keys.filter((k) => k !== t.key)) },
          { text: '关闭左侧标签', onClick: () => this.closeMany(keys.slice(0, i)) },
          { text: '关闭右侧标签', onClick: () => this.closeMany(keys.slice(i + 1)) },
          '-',
          { text: '全部关闭', icon: 'close', danger: true, onClick: () => this.closeMany(keys) },
        ], e);
      };
      this.tabsEl.appendChild(tab);
      if (t.key === this.active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    });
  },

  // ---------- 宽度 ----------
  // 有预览时用预览宽度（默认窗口的 46%），只有文件时用文件面板宽度（默认 380）
  wanted() {
    return this.hasPreview()
      ? Math.max(420, (data.ui && data.ui.previewWidth) || Math.round(window.innerWidth * 0.46))
      : Math.max(320, (data.ui && data.ui.filesWidth) || 380);
  },
  sideWidth() {
    const s = document.querySelector('#sidebar');
    return s ? s.getBoundingClientRect().width : 0;
  },
  cap(want) {
    if (this.el.classList.contains('hidden')) return;
    const room = window.innerWidth - this.sideWidth() - MIN_CHAT;
    this.el.style.setProperty('--dock-w', Math.max(320, Math.min(want || this.wanted(), room)) + 'px');
  },

  async show() {
    const wasHidden = this.el.classList.contains('hidden');
    this.el.classList.remove('hidden');
    const want = this.wanted();
    // 放不下就先把窗口往外加宽（只加宽一次，关掉面板时恢复）
    const need = this.sideWidth() + MIN_CHAT + want - window.innerWidth;
    if (need > 0 && !this.grown) {
      const r = await api.winExpand(need);
      if (r && r.added > 0) {
        this.grown = true;
        await new Promise((res) => { const t = setTimeout(res, 600); window.addEventListener('resize', () => { clearTimeout(t); setTimeout(res, 50); }, { once: true }); });
      }
    }
    this.cap(want);
    if (wasHidden && typeof timeline !== 'undefined') timeline.schedule();
  },

  hide() {
    this.el.classList.add('hidden');
    this.active = null;
    this.tabs.forEach((t) => { if (t.pane) disposePreviewPane(t.pane); });
    this.tabs = [];
    this.render();
    document.querySelector('#filepane').classList.add('hidden');
    if (this.grown) { this.grown = false; api.winRestore(); }
    if (typeof timeline !== 'undefined') timeline.schedule();
  },

  initResizer() {
    const r = this.el.querySelector('.dock-resizer');
    r.onmousedown = (e) => {
      e.preventDefault();
      const app = document.querySelector('#app').getBoundingClientRect();
      r.classList.add('drag');
      document.body.classList.add('pv-dragging');
      const move = (ev) => {
        const width = Math.max(320, Math.min(app.right - ev.clientX, window.innerWidth - this.sideWidth() - MIN_CHAT));
        this.el.style.setProperty('--dock-w', width + 'px');
      };
      const up = () => {
        r.classList.remove('drag');
        document.body.classList.remove('pv-dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const w = Math.round(this.el.getBoundingClientRect().width);
        if (this.hasPreview()) data.ui.previewWidth = w; else data.ui.filesWidth = w;
        save();
        if (typeof timeline !== 'undefined') timeline.schedule();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
  },
};
dock.initResizer();
window.addEventListener('resize', () => dock.cap());
