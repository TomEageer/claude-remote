/* global api, el, esc, icon, toast, fmtSize, confirmModal, refreshInstalledPlugins, data */
'use strict';

// 语义化版本比较：a > b 返回 1
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

api.onPluginProgress(({ id, done, total }) => {
  if (!pluginsView.busy[id]) return;
  pluginsView.busy[id] = total ? `正在下载 ${done}/${total}` : '正在准备…';
  pluginsView.render();
});

const pluginsView = {
  tab: 'installed',
  installed: [],
  store: null,
  storeError: '',
  busy: {},

  async open() {
    const v = document.querySelector('#view-plugins');
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="pl-wrap">
          <div class="pl-head">
            <div><h2>拓展功能</h2><p class="wsub">装上对应的拓展后，就能在软件里直接打开 PDF、Word、Excel、PPT 和代码文件。拓展只在本机运行，不会联网上传你的文件。（这是本软件自己的功能；Claude Code 的插件在「MCP · Skill · 插件」里管理，也可以输入 /plugin）</p></div>
            <button class="icon-btn" id="pl-refresh" title="刷新">${icon('refresh')}</button>
          </div>
          <div class="seg pl-tabs"><button data-t="installed">已安装</button><button data-t="store">拓展商店</button></div>
          <div id="pl-list"></div>
          <div class="pl-foot">图片、视频、音频和纯文本是内置支持的，不需要安装拓展。</div>
        </div>`;
      v.querySelectorAll('.pl-tabs button').forEach((b) => (b.onclick = () => { this.tab = b.dataset.t; this.render(); }));
      v.querySelector('#pl-refresh').onclick = () => this.reload();
      v.dataset.built = '1';
    }
    await this.reload();
  },

  async reload() {
    this.installed = await refreshInstalledPlugins();
    this.render();
    const r = await api.pluginsStore();
    this.store = r.ok ? r.items : null;
    // 自定义仓库读不到但官方的读到了：照常显示，提示一下
    this.storeError = r.ok ? (r.errors && r.errors.length ? '有一个来源读取失败：' + r.errors.join('；') : '') : r.message;
    this.render();
  },

  storeItem(id) {
    return (this.store || []).find((x) => x.id === id);
  },

  card(p, mode) {
    const local = this.installed.find((x) => x.id === p.id);
    const remote = this.storeItem(p.id);
    const c = el('div', 'pl-card');
    const exts = (p.extensions || []).slice(0, 14).map((e) => `<span class="pl-ext">${esc(e)}</span>`).join('') + ((p.extensions || []).length > 14 ? '<span class="pl-ext">…</span>' : '');
    let ver = `v${esc(p.version)}`;
    if (mode === 'store' && local) ver += local.version === p.version ? ' · 已安装' : ` · 本机 v${esc(local.version)}`;
    const img = [local && local.icon, p.icon].find((x) => typeof x === 'string' && /^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(x));
    c.innerHTML = `
      <div class="pl-ico${img ? ' has-img' : ''}">${img ? `<img src="${img}" alt="" />` : icon('puzzle')}</div>
      <div class="pl-main">
        <div class="pl-name">${esc(p.name)} <span class="pl-ver">${ver}</span>${mode === 'store' && p.source && !p.official ? `<span class="pl-src" title="来自自定义仓库">${esc(p.source)}</span>` : ''}</div>
        <div class="pl-desc">${esc(p.description || '')}</div>
        <div class="pl-exts">${exts}</div>
      </div>
      <div class="pl-act"></div>`;
    const act = c.querySelector('.pl-act');
    if (this.busy[p.id]) {
      act.innerHTML = `<span class="spin"></span><span class="pl-busy">${esc(this.busy[p.id])}</span>`;
      return c;
    }
    const canUpdate = local && remote && cmpVersion(remote.version, local.version) > 0;
    if (canUpdate) act.appendChild(this.btn(`更新到 v${remote.version}`, 'primary', () => this.install(remote, '正在更新')));
    if (mode === 'store' && !local) act.appendChild(this.btn(`安装 · ${fmtSize(p.size)}`, 'primary', () => this.install(p, '正在安装')));
    if (mode === 'installed') act.appendChild(this.btn('卸载', '', () => this.uninstall(p)));
    return c;
  },

  btn(text, cls, fn) {
    const b = el('button', 'btn ' + cls, esc(text));
    b.onclick = fn;
    return b;
  },

  render() {
    const box = document.querySelector('#pl-list');
    if (!box) return;
    document.querySelectorAll('.pl-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === this.tab));
    box.innerHTML = '';
    if (this.tab === 'installed') {
      if (!this.installed.length) {
        box.innerHTML = '<div class="fm-empty">还没有安装拓展，去「拓展商店」看看</div>';
        return;
      }
      this.installed.forEach((p) => box.appendChild(this.card(p, 'installed')));
      return;
    }
    if (this.store === null && !this.storeError) {
      box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取拓展商店…</span></div>';
      return;
    }
    if (this.storeError && !this.store) {
      box.innerHTML = `<div class="fm-empty err">读取拓展商店失败：${esc(this.storeError)}<br>可以检查网络，或在设置里检查自定义拓展仓库</div>`;
      return;
    }
    if (this.storeError) box.appendChild(el('div', 'pl-warn', esc(this.storeError)));
    if (!this.store.length) {
      box.innerHTML = '<div class="fm-empty">拓展商店里暂时没有拓展</div>';
      return;
    }
    this.store.forEach((p) => box.appendChild(this.card(p, 'store')));
  },

  async install(item, label) {
    this.busy[item.id] = label + '…';
    this.render();
    const r = await api.pluginsInstall(item);
    delete this.busy[item.id];
    if (!r.ok) toast(r.message, 6000);
    else if (r.reused) toast(`${item.name} 已更新到 v${item.version}：只下载了 ${r.downloaded} 个变化的文件（${fmtSize(r.bytes)}），复用 ${r.reused} 个`, 5000);
    else toast(`${item.name} v${item.version} 已安装（${fmtSize(r.bytes)}）`);
    this.installed = await refreshInstalledPlugins();
    this.render();
  },

  async uninstall(p) {
    const ok = await confirmModal('卸载拓展', `卸载「${p.name}」后，相关文件就不能在软件里预览了，之后可以随时从拓展商店重新安装。`, '卸载');
    if (!ok) return;
    const r = await api.pluginsUninstall(p.id);
    if (!r.ok) return toast(r.message, 4000);
    toast(`已卸载 ${p.name}`);
    this.installed = await refreshInstalledPlugins();
    this.render();
  },
};
