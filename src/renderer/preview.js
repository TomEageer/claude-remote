/* global api, el, esc, icon, toast, fmtSize, downloadFile, data, save, showMenu, timeline */
'use strict';

// ---------- 文件类型 ----------
const EXT_GROUPS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
  pdf: ['pdf'],
  word: ['docx', 'doc', 'odt', 'rtf'],
  sheet: ['xlsx', 'xls', 'xlsm', 'ods', 'csv'],
  slides: ['pptx', 'ppt', 'odp', 'key'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  doc: ['md', 'txt', 'html', 'htm', 'epub'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'css', 'scss', 'vue', 'kt', 'kts', 'swift', 'log', 'ipynb', 'lock', 'groovy', 'gradle', 'properties', 'scala', 'lua', 'dart', 'pl', 'r', 'proto', 'tsv', 'cfg', 'env', 'jsp', 'ftl', 'vm'],
};
const KIND_OF = {};
for (const [k, list] of Object.entries(EXT_GROUPS)) for (const e of list) KIND_OF[e] = k;
const KIND_ICON = { image: 'image', video: 'film', audio: 'film', pdf: 'file', word: 'file', sheet: 'table', slides: 'slides', archive: 'archive', doc: 'file', code: 'code' };
// 交付给用户的文件类型（代码、日志、依赖锁等算"程序文件"）
const DELIVERABLE = new Set(['image', 'video', 'audio', 'pdf', 'word', 'sheet', 'slides', 'archive', 'doc']);
const BUILTIN_VIEW = { image: 'image', video: 'video', audio: 'audio' };
// 没装代码插件时，这些纯文本用内置的简单查看
const PLAIN_TEXT = new Set(['txt', 'log', 'md', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'py', 'js', 'ts', 'sh', 'sql', 'html', 'css', 'groovy', 'gradle', 'properties', 'kts', 'scala', 'lua', 'dart', 'pl', 'r', 'proto', 'tsv', 'cfg', 'env', 'jsp', 'ftl', 'vm', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'kt', 'swift', 'vue', 'tsx', 'jsx', 'mjs', 'cjs', 'scss', 'bash', 'zsh', 'ps1', 'bat']);
// 同一扩展名有多个插件时的优先顺序
const SNIFF_LIMIT = 5 * 1024 * 1024; // 不认识的文件超过 5MB 就不试着当文本打开了
const PLUGIN_PRIORITY = ['excel-viewer', 'word-viewer', 'ppt-viewer', 'pdf-viewer', 'code-viewer'];

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
};
const kindOf = (name) => KIND_OF[extOf(name)] || 'other';
const iconFor = (name) => KIND_ICON[kindOf(name)] || 'file';
const baseName = (p) => String(p).split('/').pop();

let installedPlugins = [];
async function refreshInstalledPlugins() {
  const r = await api.pluginsList();
  installedPlugins = r.ok ? r.items : [];
  return installedPlugins;
}

function pluginFor(ext) {
  const cands = installedPlugins.filter((p) => p.extensions.includes(ext));
  cands.sort((a, b) => {
    const ia = PLUGIN_PRIORITY.indexOf(a.id);
    const ib = PLUGIN_PRIORITY.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return cands[0] || null;
}

// ---------- 路径解析 ----------
async function resolveRemote(p) {
  if (p.startsWith('/') || p.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  const c = await api.connect();
  if (!c.ok) throw new Error(c.message);
  return `${c.workdir}/${p.replace(/^\.\//, '')}`;
}

async function openFile(p) {
  try {
    openPreview(await resolveRemote(p));
  } catch (e) {
    toast(e.message, 4000);
  }
}

async function downloadPath(p) {
  try {
    return downloadFile(await resolveRemote(p));
  } catch (e) {
    toast(e.message, 4000);
  }
}

// ---------- 回复里的文件路径变成链接 ----------
const KNOWN_EXT = Object.keys(KIND_OF).join('|');
const CODE_PATH_RE = new RegExp(`^(?:~?/)?[^\\s<>|"'*?]*\\.(?:${KNOWN_EXT})$`, 'i');
const TEXT_PATH_RE = new RegExp(`(?:(?:~|/home|/root|/tmp|/srv|/opt|/data|/var|/Users)/|[A-Za-z]:[\\\\/])[^\\s<>|"'*?，。；：、）)]*\\.(?:${KNOWN_EXT})(?![A-Za-z0-9])`, 'gi');

// 文件链接：点文字下载，点右边的眼睛预览
function makeLink(path, text) {
  const w = el('span', 'flink-wrap');
  const a = el('a', 'flink', `${icon(iconFor(path))}<span>${esc(text)}</span>`);
  a.href = '#';
  a.dataset.path = path;
  a.title = '点击下载';
  const eye = el('button', 'flink-eye', icon('eye'));
  eye.dataset.path = path;
  eye.title = '预览';
  w.append(a, eye);
  return w;
}

function linkifyPaths(root) {
  // 行内代码：整段内容像路径就变成链接
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return;
    const t = code.textContent.trim();
    if (t.length > 300 || !CODE_PATH_RE.test(t) || /^https?:/i.test(t)) return;
    code.replaceWith(makeLink(t, t));
  });
  // 普通文字里的绝对路径
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    TEXT_PATH_RE.lastIndex = 0;
    if (!TEXT_PATH_RE.test(text)) continue;
    TEXT_PATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = TEXT_PATH_RE.exec(text))) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(makeLink(m[0], m[0]));
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
  linkifyBareNames(root);
}

// 单独写出来的文件名（「文件在 /home/x/目录：」下一行才是「报告.xlsx」）：
// 拼上同一段回复里前面最近提到的目录，没有就用这个对话的工作文件夹
const BARE_NAME_RE = /(^|[\s：:，,（(「『\[])([^\s\/\\:*?"<>|，。；：、（）()「」『』【】\[\]]{1,120}\.(?:xlsx|xlsm|xls|csv|docx|doc|pptx|ppt|pdf|md|txt|json|png|jpe?g|gif|svg|html?|zip|tar\.gz|py|sh|sql|log|yaml|yml))(?=$|[\s，。；、）)」』\]:：,.])/gi;
function looksLikeDir(p) {
  return /\/$/.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p.split('/').pop());
}
// 文字里出现的目录（「文件在 /home/x/目录：」），按出现顺序记住最近的一个
const DIR_IN_TEXT_RE = /(?:^|[\s(（「:：])((?:~|\/)[^\s：:，,。；、）)」]*)/g;
function linkifyBareNames(root) {
  let lastDir = null;
  const noteDirs = (text) => {
    DIR_IN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = DIR_IN_TEXT_RE.exec(text))) {
      const p = m[1].replace(/[.。]+$/, '');
      if (p.length > 1 && looksLikeDir(p)) lastDir = p;
    }
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const fallback = typeof chatCwd === 'function' ? chatCwd() : null;
  for (const node of nodes) {
    const text = node.nodeValue;
    // 已经是链接的路径：是目录就记下来，本身不用再处理
    const link = node.parentElement.closest('a.flink');
    if (link) { if (looksLikeDir(link.dataset.path)) lastDir = link.dataset.path; continue; }
    BARE_NAME_RE.lastIndex = 0;
    const hasName = BARE_NAME_RE.test(text);
    if (!hasName) { noteDirs(text); continue; }
    noteDirs(text);
    const dir = lastDir || fallback;
    if (!dir) continue;
    BARE_NAME_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = BARE_NAME_RE.exec(text))) {
      const start = m.index + m[1].length;
      frag.appendChild(document.createTextNode(text.slice(last, start)));
      frag.appendChild(makeLink(dir.replace(/\/+$/, '') + '/' + m[2], m[2]));
      last = start + m[2].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    // 行内代码里只写了文件名：整个 code 换成链接
    const code = node.parentElement.closest('code');
    if (code && code.textContent.trim() === text.trim()) code.replaceWith(frag); else node.replaceWith(frag);
  }
}

document.addEventListener('click', (e) => {
  const eye = e.target.closest('.flink-eye');
  if (eye) {
    e.preventDefault();
    return openFile(eye.dataset.path);
  }
  const a = e.target.closest('a.flink');
  if (!a) return;
  e.preventDefault();
  downloadPath(a.dataset.path);
});
document.addEventListener('contextmenu', (e) => {
  const a = e.target.closest('a.flink');
  if (!a) return;
  e.preventDefault();
  showMenu([
    { text: '预览', icon: 'eye', onClick: () => openFile(a.dataset.path) },
    { text: '下载', icon: 'download', onClick: () => downloadPath(a.dataset.path) },
  ], e);
});

// ---------- 本轮产物 ----------
function splitOutputs(files) {
  const main = [];
  const other = [];
  for (const f of files) {
    const inTools = /(^|\/)(tools|scripts|src|lib|build|dist|cache|tmp|temp)\//i.test(f.rel);
    (DELIVERABLE.has(kindOf(f.rel)) && !inTools && !f.unsure ? main : other).push(f);
  }
  return { main, other };
}

function outputRow(f) {
  const name = baseName(f.rel);
  const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.length - name.length - 1) : '';
  const row = el('div', 'orow');
  row.title = f.path;
  const link = makeLink(f.path, name);
  link.classList.add('oname');
  link.querySelector('a').title = f.path;
  row.appendChild(link);
  if (dir) row.appendChild(el('span', 'odir', esc(dir)));
  row.appendChild(el('span', 'fmeta', fmtSize(f.size)));
  return row;
}

function renderOutputs(files) {
  const { main, other } = splitOutputs(files);
  const box = el('div', 'outputs');
  box.appendChild(el('div', 'outputs-head', `${icon('folder')}<span>${main.length ? '本轮生成的文件' : '本轮没有生成文档类文件'}</span><span class="count">${main.length || ''}</span>`));
  const MAX = 12;
  main.slice(0, MAX).forEach((f) => box.appendChild(outputRow(f)));
  if (main.length > MAX) {
    const more = el('button', 'orow more-row', `还有 ${main.length - MAX} 个文件，点击展开`);
    more.onclick = () => { main.slice(MAX).forEach((f) => box.insertBefore(outputRow(f), more)); more.remove(); };
    box.appendChild(more);
  }
  if (other.length) {
    const t = el('button', 'orow more-row', `另有 ${other.length} 个程序、中间文件或来源不确定的文件，点击查看`);
    t.onclick = () => {
      other.slice(0, 200).forEach((f) => box.insertBefore(outputRow(f), t));
      t.remove();
    };
    box.appendChild(t);
  }
  return box;
}

// ---------- 预览窗口 ----------
let previewSession = 0;
const theme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// 拖动左边缘调整预览栏宽度（记住上次的宽度）

// 关掉当前预览（右侧面板里的那个标签）
function closePreview() {
  dock.closeActivePreview();
}

// 关掉一个预览页面：移除页面、断开它的拓展、删掉它的缓存文件
function disposePreviewPane(pane) {
  if (!pane) return;
  pane.querySelectorAll('iframe').forEach((f) => { for (const [k, c] of pluginCtxs) if (c.frame === f) pluginCtxs.delete(k); });
  if (pane.dataset.local) api.previewDrop(pane.dataset.local);
  pane.remove();
  const pv = document.querySelector('#preview');
  if (!pv.querySelector('.pv-pane')) pv.classList.remove('max');
}

// 每个预览页面里的拓展（iframe）各一份上下文，按消息来自哪个 iframe 区分
const pluginCtxs = new Map(); // frame → { frame, pane, localPath, name, ext, sent }
async function onPluginMessage(e) {
  let ctx = null;
  for (const c of pluginCtxs.values()) if (c.frame.contentWindow === e.source) { ctx = c; break; }
  if (!ctx) return;
  const msg = e.data || {};
  if (msg.type === 'cr:ready' && !ctx.sent) {
    ctx.sent = true;
    const r = await api.previewRead(ctx.localPath);
    if (!r.ok) return paneError(ctx.pane, r.message);
    const u8 = r.data;
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    ctx.frame.contentWindow.postMessage(
      { type: 'cr:file', name: ctx.name, ext: ctx.ext, size: u8.byteLength, mime: '', theme: theme(), data: buf },
      '*',
      [buf]
    );
  } else if (msg.type === 'cr:rendered') {
    const l = ctx.pane.querySelector('.pv-loading');
    if (l) l.remove();
  } else if (msg.type === 'cr:error') {
    paneError(ctx.pane, msg.message || '这个拓展无法显示这个文件');
  }
}
window.addEventListener('message', onPluginMessage);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const c of pluginCtxs.values()) if (c.frame.contentWindow) c.frame.contentWindow.postMessage({ type: 'cr:theme', theme: theme() }, '*');
});

function paneError(pane, text, extra) {
  const body = pane && pane.querySelector('.pv-body');
  if (!body) return;
  body.innerHTML = '';
  const box = el('div', 'pv-msg', `${icon('alert', 'big')}<div class="pv-msg-t">${esc(text)}</div>`);
  if (extra) box.appendChild(extra);
  body.appendChild(box);
}

// 预览文件的下载进度：已下载 / 总大小、百分比、速度（取最近 2 秒的平均）、预计剩余时间
const previewDl = new Map(); // 路径 → { pane, samples }
api.onPreviewProgress(({ remotePath, done, total }) => {
  const d = previewDl.get(remotePath);
  if (!d || !d.pane.isConnected) return;
  const l = d.pane.querySelector('.pv-loading');
  if (!l) return;
  const now = Date.now();
  d.samples.push([now, done]);
  while (d.samples.length > 2 && now - d.samples[0][0] > 2000) d.samples.shift();
  const [t0, b0] = d.samples[0];
  const speed = now - t0 > 200 ? ((done - b0) * 1000) / (now - t0) : 0;
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const left = speed > 0 && total > done ? fmtEta((total - done) / speed) : '';
  if (!l.classList.contains('dl')) {
    l.classList.add('dl');
    l.innerHTML = `<div class="pv-dl">
      <div class="pv-dl-t"><span>正在从服务器下载</span><span class="pv-dl-pct"></span></div>
      <div class="pv-dl-bar"><i></i></div>
      <div class="pv-dl-meta"><span class="pv-dl-size"></span><span class="pv-dl-speed"></span></div>
    </div>`;
  }
  l.querySelector('.pv-dl-pct').textContent = pct.toFixed(pct < 10 ? 1 : 0) + '%';
  l.querySelector('.pv-dl-bar i').style.width = pct + '%';
  l.querySelector('.pv-dl-size').textContent = `${fmtSize(done)} / ${fmtSize(total)}`;
  l.querySelector('.pv-dl-speed').textContent = speed ? `${fmtSize(speed)}/s${left ? ' · 还需 ' + left : ''}` : '';
});

function fmtEta(sec) {
  sec = Math.ceil(sec);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

// 打开文件预览：在右侧面板里开一个标签（已经开着就切过去）
function openPreview(remotePath, opts = {}) {
  // 记下在软件里打开的时间（文件列表的「上次打开」用）
  data.ui.opened = data.ui.opened || {};
  data.ui.opened[remotePath] = Date.now();
  const keys = Object.keys(data.ui.opened);
  if (keys.length > 2000) keys.sort((a, b) => data.ui.opened[a] - data.ui.opened[b]).slice(0, keys.length - 2000).forEach((k) => delete data.ui.opened[k]);
  save();
  dock.openPreview(remotePath, opts);
}

// 在预览面板里画出这个文件。opts.source：网页文件显示源码而不是渲染后的页面
async function renderPreview(remotePath, opts = {}, pane) {
  const sid = String(++previewSession);
  const name = baseName(remotePath);
  const ext = extOf(name);
  const isPage = (ext === 'html' || ext === 'htm') && !opts.source;
  const kind = kindOf(name);
  const p = pane;
  p.dataset.gen = sid; // 重新画（比如切换网页 / 源码）时，旧的那次加载作废
  const stale = () => !p.isConnected || p.dataset.gen !== sid;
  p.innerHTML = `
    <div class="pv-head">
      <span class="pv-ico">${icon(iconFor(name))}</span>
      <div class="pv-title"><div class="pv-name">${esc(name)}</div><div class="pv-path">${esc(typeof shortPath === 'function' && typeof remoteInfo !== 'undefined' ? shortPath(remotePath, remoteInfo.home) : remotePath)}</div></div>
      ${ext === 'html' || ext === 'htm' ? `<button class="btn" id="pv-mode">${icon(opts.source ? 'globe' : 'code')}<span>${opts.source ? '网页' : '源码'}</span></button>` : ''}
      <button class="btn" id="pv-dl">${icon('download')}<span>下载</span></button>
      <button class="icon-btn" id="pv-max" title="放大 / 还原">${icon('expand')}</button>
      <button class="icon-btn" id="pv-close" title="关闭（Esc）">${icon('close')}</button>
    </div>
    <div class="pv-body"><div class="pv-loading"><span class="spin"></span><span>正在从服务器取文件…</span></div></div>`;
  p.querySelector('#pv-close').onclick = () => dock.close('pv:' + remotePath);
  p.querySelector('#pv-max').onclick = () => document.querySelector('#preview').classList.toggle('max');
  p.querySelector('#pv-dl').onclick = () => downloadPath(remotePath);
  const modeBtn = p.querySelector('#pv-mode');
  if (modeBtn) modeBtn.onclick = () => openPreview(remotePath, { source: !opts.source });

  await refreshInstalledPlugins();
  const plugin = BUILTIN_VIEW[kind] || isPage ? null : pluginFor(ext);
  const builtin = isPage ? 'page' : BUILTIN_VIEW[kind];
  const plainFallback = !plugin && PLAIN_TEXT.has(ext);
  let sniffText = false; // 不认识的扩展名：下载后看内容，是文本就直接显示
  const unsupported = () => paneError(p, ext ? `暂不支持预览 .${ext} 文件，可以点右上角"下载"后用电脑上的软件打开` : '暂不支持预览这个文件，可以下载后查看');

  if (!builtin && !plugin && !plainFallback) {
    // 看看商店里有没有能打开它的插件
    const store = await api.pluginsStore();
    if (stale()) return;
    const cand = store.ok ? store.items.find((x) => (x.extensions || []).includes(ext)) : null;
    if (cand) {
      const wrap = el('div', 'pv-actions');
      const b = el('button', 'btn primary', `安装「${esc(cand.name)}」并预览`);
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = '正在安装…';
        const r = await api.pluginsInstall(cand);
        if (!r.ok) { b.disabled = false; b.textContent = '重试安装'; return toast(r.message, 5000); }
        toast(`已安装 ${cand.name}`);
        openPreview(remotePath);
      };
      wrap.appendChild(b);
      return paneError(p, `预览 .${ext} 文件需要安装拓展「${cand.name}」（${fmtSize(cand.size)}）`, wrap);
    }
    sniffText = true;
  }

  previewDl.set(remotePath, { pane: p, start: Date.now(), samples: [] });
  const r = await api.previewFetch(remotePath, sniffText ? { maxSize: SNIFF_LIMIT } : undefined);
  previewDl.delete(remotePath);
  if (stale()) return;
  if (!r.ok) return sniffText ? unsupported() : paneError(p, r.message);
  if (!r.direct) p.dataset.local = r.localPath; // 关掉这个页面时删掉它的缓存；直接读的原文件不设，永远不会被删
  const body = p.querySelector('.pv-body');
  const loading = body.querySelector('.pv-loading');
  if (loading) loading.innerHTML = '<span class="spin"></span><span>下载完成，正在打开…</span>';

  if (builtin === 'page') {
    // 网页：在沙盒里渲染（脚本能跑，但碰不到这个软件和电脑上的文件）
    body.innerHTML = '';
    const frame = el('iframe', 'pv-frame pv-page');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = r.page;
    body.appendChild(frame);
    body.appendChild(el('div', 'pv-tip', '网页在隔离环境里显示：和它放在一起的本地图片、样式文件不会加载，点右上角「源码」可以看原始代码'));
    return;
  }

  if (builtin) {
    body.innerHTML = '';
    let node;
    if (builtin === 'image') { body.appendChild(imageZoom(r.url, () => paneError(p, '这个文件无法显示，可以下载后查看'))); return; }
    else if (builtin === 'video') { node = el('video', 'pv-media'); node.src = r.url; node.controls = true; node.autoplay = true; }
    else { node = el('audio', 'pv-audio'); node.src = r.url; node.controls = true; node.autoplay = true; }
    node.onerror = () => paneError(p, '这个文件无法播放或显示，可以下载后查看');
    body.appendChild(node);
    return;
  }

  if (plugin) {
    const frame = el('iframe', 'pv-frame');
    pluginCtxs.set(frame, { frame, pane: p, localPath: r.localPath, name, ext, sent: false });
    frame.src = `crplugin://${plugin.id}/${plugin.entry || 'index.html'}`;
    body.appendChild(frame);
    return;
  }

  // 内置纯文本查看（最多 1MB）
  const t = await api.previewRead(r.localPath);
  if (stale()) return;
  if (!t.ok) return sniffText ? unsupported() : paneError(p, t.message);
  let text;
  if (sniffText) {
    // 前 8KB 里有空字节，或者不是合法的 UTF-8，就当二进制文件
    const head = t.data.subarray(0, 8192);
    if (head.includes(0)) return unsupported();
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(t.data.subarray(0, 1024 * 1024), { stream: true }); } catch (_) { return unsupported(); }
  } else text = new TextDecoder('utf-8').decode(t.data.subarray(0, 1024 * 1024));
  if (t.data.byteLength > 1024 * 1024) text += '\n\n…（文件较大，只显示前 1MB）';
  body.innerHTML = '';
  const pre = el('pre', 'pv-text');
  pre.textContent = text;
  body.appendChild(pre);
  const tip = el('div', 'pv-tip', '在「设置 → 拓展功能」里安装「代码与文本预览」，可以获得语法高亮和 Markdown 排版');
  body.appendChild(tip);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('#preview').classList.contains('hidden') && !document.querySelector('.overlay')) closePreview();
});

refreshInstalledPlugins();


// ---------- 图片：滚轮 / 触控板缩放（以指针为中心）、按住拖动、双击在「适应窗口」和 100% 之间切换、工具条 ----------
function imageZoom(url, onError) {
  const box = el('div', 'pv-zoom');
  const img = el('img', 'pv-zoom-img');
  img.draggable = false;
  img.src = url;
  img.onerror = onError;
  const bar = el('div', 'pv-zoom-bar', `<button data-z="out" title="缩小（-）">${icon('minus')}</button><button data-z="fit" class="pv-zoom-pct" title="适应窗口（0）">100%</button><button data-z="in" title="放大（+）">${icon('plus')}</button><button data-z="one" title="按原始大小（1）">1:1</button>`);
  box.append(img, bar);
  const st = { s: 1, x: 0, y: 0, fit: true };
  const pct = bar.querySelector('.pv-zoom-pct');
  const apply = () => { img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.s})`; pct.textContent = Math.round(st.s * 100) + '%'; box.classList.toggle('zoomed', !st.fit); };
  const fit = () => {
    const W = box.clientWidth, H = box.clientHeight, w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    st.s = Math.min(1, W / w, H / h); // 小图不放大
    st.x = (W - w * st.s) / 2; st.y = (H - h * st.s) / 2; st.fit = true;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const ns = Math.max(0.1, Math.min(10, st.s * factor));
    const k = ns / st.s;
    st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.s = ns; st.fit = false;
    apply();
  };
  const center = () => [box.clientWidth / 2, box.clientHeight / 2];
  const one = () => { const [cx, cy] = center(); zoomAt(1 / st.s, cx, cy); };
  img.onload = fit;
  new ResizeObserver(() => { if (st.fit) fit(); }).observe(box);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    // 触控板双指捏合会带 ctrlKey；普通滚动也当缩放（看图时滚动没别的用）
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    zoomAt(f, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  box.addEventListener('mousedown', (e) => { if (e.button !== 0 || e.target.closest('.pv-zoom-bar')) return; drag = { x: e.clientX - st.x, y: e.clientY - st.y }; box.classList.add('dragging'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; st.x = e.clientX - drag.x; st.y = e.clientY - drag.y; st.fit = false; apply(); });
  window.addEventListener('mouseup', () => { if (drag) { drag = null; box.classList.remove('dragging'); } });
  box.addEventListener('dblclick', (e) => { if (e.target.closest('.pv-zoom-bar')) return; if (st.fit && st.s < 1) { const r = box.getBoundingClientRect(); zoomAt(1 / st.s, e.clientX - r.left, e.clientY - r.top); } else fit(); });
  bar.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const [cx, cy] = center();
    if (b.dataset.z === 'in') zoomAt(1.25, cx, cy); else if (b.dataset.z === 'out') zoomAt(0.8, cx, cy); else if (b.dataset.z === 'one') one(); else fit();
  };
  box.tabIndex = 0;
  box.addEventListener('keydown', (e) => {
    const [cx, cy] = center();
    if (e.key === '+' || e.key === '=') zoomAt(1.25, cx, cy); else if (e.key === '-') zoomAt(0.8, cx, cy); else if (e.key === '0') fit(); else if (e.key === '1') one(); else return;
    e.preventDefault();
  });
  return box;
}
