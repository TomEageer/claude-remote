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
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'css', 'scss', 'vue', 'kt', 'swift', 'log', 'ipynb', 'lock'],
};
const KIND_OF = {};
for (const [k, list] of Object.entries(EXT_GROUPS)) for (const e of list) KIND_OF[e] = k;
const KIND_ICON = { image: 'image', video: 'film', audio: 'film', pdf: 'file', word: 'file', sheet: 'table', slides: 'slides', archive: 'archive', doc: 'file', code: 'code' };
// 交付给用户的文件类型（代码、日志、依赖锁等算"程序文件"）
const DELIVERABLE = new Set(['image', 'video', 'audio', 'pdf', 'word', 'sheet', 'slides', 'archive', 'doc']);
const BUILTIN_VIEW = { image: 'image', video: 'video', audio: 'audio' };
// 没装代码插件时，这些纯文本用内置的简单查看
const PLAIN_TEXT = new Set(['txt', 'log', 'md', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'py', 'js', 'ts', 'sh', 'sql', 'html', 'css']);
// 同一扩展名有多个插件时的优先顺序
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
    (DELIVERABLE.has(kindOf(f.rel)) && !inTools ? main : other).push(f);
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
    const t = el('button', 'orow more-row', `另有 ${other.length} 个程序或中间文件（脚本、缓存等），点击查看`);
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
// 对话区至少留这么宽；预览放不下时先把窗口往外加宽，屏幕也不够时才缩小预览
const MIN_CHAT = 560;
let previewGrown = false;
const sideWidth = () => ['#sidebar', '#filepane'].reduce((n, sel) => {
  const x = document.querySelector(sel);
  return n + (x && !x.classList.contains('hidden') ? x.getBoundingClientRect().width : 0);
}, 0);
const wantedPreviewWidth = () => Math.max(420, (data.ui && data.ui.previewWidth) || Math.round(window.innerWidth * 0.46));

async function fitPreview(p) {
  const want = wantedPreviewWidth();
  const need = sideWidth() + MIN_CHAT + want - window.innerWidth;
  if (need > 0 && !previewGrown) {
    const r = await api.winExpand(need);
    if (r && r.added > 0) {
      previewGrown = true;
      // 等窗口真的变宽
      await new Promise((res) => { const t = setTimeout(res, 600); window.addEventListener('resize', () => { clearTimeout(t); setTimeout(res, 50); }, { once: true }); });
    }
  }
  capPreview(p, want);
}

function capPreview(p, want) {
  if (!p || p.classList.contains('hidden')) return;
  const room = window.innerWidth - sideWidth() - MIN_CHAT;
  p.style.setProperty('--pv-w', Math.max(340, Math.min(want || wantedPreviewWidth(), room)) + 'px');
}
window.addEventListener('resize', () => capPreview(document.querySelector('#preview')));

function addResizer(p) {
  const w = data.ui && data.ui.previewWidth;
  if (w) p.style.setProperty('--pv-w', w + 'px');
  const r = el('div', 'pv-resizer');
  p.appendChild(r);
  r.onmousedown = (e) => {
    e.preventDefault();
    const app = document.querySelector('#app').getBoundingClientRect();
    r.classList.add('drag');
    document.body.classList.add('pv-dragging');
    const move = (ev) => {
      const width = Math.max(340, Math.min(app.right - ev.clientX, app.width - sideWidth() - MIN_CHAT));
      p.style.setProperty('--pv-w', width + 'px');
    };
    const up = () => {
      r.classList.remove('drag');
      document.body.classList.remove('pv-dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      data.ui.previewWidth = Math.round(p.getBoundingClientRect().width);
      save();
      if (typeof timeline !== 'undefined') timeline.schedule();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function closePreview() {
  previewSession++;
  const p = document.querySelector('#preview');
  p.classList.add('hidden');
  p.classList.remove('max');
  p.innerHTML = '';
  window.removeEventListener('message', onPluginMessage);
  if (previewGrown) { previewGrown = false; api.winRestore(); }
}

let pluginCtx = null;
async function onPluginMessage(e) {
  if (!pluginCtx || e.source !== pluginCtx.frame.contentWindow) return;
  const msg = e.data || {};
  if (msg.type === 'cr:ready' && !pluginCtx.sent) {
    pluginCtx.sent = true;
    const r = await api.previewRead(pluginCtx.localPath);
    if (!r.ok) return previewError(r.message);
    const u8 = r.data;
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    pluginCtx.frame.contentWindow.postMessage(
      { type: 'cr:file', name: pluginCtx.name, ext: pluginCtx.ext, size: u8.byteLength, mime: '', theme: theme(), data: buf },
      '*',
      [buf]
    );
  } else if (msg.type === 'cr:rendered') {
    const l = document.querySelector('#preview .pv-loading');
    if (l) l.remove();
  } else if (msg.type === 'cr:error') {
    previewError(msg.message || '插件无法显示这个文件');
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (pluginCtx && pluginCtx.frame.contentWindow) pluginCtx.frame.contentWindow.postMessage({ type: 'cr:theme', theme: theme() }, '*');
});

function previewError(text, extra) {
  const body = document.querySelector('#preview .pv-body');
  if (!body) return;
  body.innerHTML = '';
  const box = el('div', 'pv-msg', `${icon('alert', 'big')}<div class="pv-msg-t">${esc(text)}</div>`);
  if (extra) box.appendChild(extra);
  body.appendChild(box);
}

// 预览文件的下载进度：已下载 / 总大小、百分比、速度（取最近 2 秒的平均）、预计剩余时间
let previewDl = null;
api.onPreviewProgress(({ remotePath, done, total }) => {
  const d = previewDl;
  if (!d || d.remotePath !== remotePath || d.sid !== previewSession) return;
  const l = document.querySelector('#preview .pv-loading');
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

// opts.source：网页文件显示源码而不是渲染后的页面
async function openPreview(remotePath, opts = {}) {
  const sid = ++previewSession;
  const name = baseName(remotePath);
  const ext = extOf(name);
  const isPage = (ext === 'html' || ext === 'htm') && !opts.source;
  const kind = kindOf(name);
  const p = document.querySelector('#preview');
  p.classList.remove('hidden');
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
  p.querySelector('#pv-close').onclick = closePreview;
  p.querySelector('#pv-max').onclick = () => p.classList.toggle('max');
  addResizer(p);
  fitPreview(p);
  p.querySelector('#pv-dl').onclick = () => downloadPath(remotePath);
  const modeBtn = p.querySelector('#pv-mode');
  if (modeBtn) modeBtn.onclick = () => openPreview(remotePath, { source: !opts.source });

  await refreshInstalledPlugins();
  const plugin = BUILTIN_VIEW[kind] || isPage ? null : pluginFor(ext);
  const builtin = isPage ? 'page' : BUILTIN_VIEW[kind];
  const plainFallback = !plugin && PLAIN_TEXT.has(ext);

  if (!builtin && !plugin && !plainFallback) {
    // 看看商店里有没有能打开它的插件
    const store = await api.pluginsStore();
    if (sid !== previewSession) return;
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
      return previewError(`预览 .${ext} 文件需要安装「${cand.name}」插件（${fmtSize(cand.size)}）`, wrap);
    }
    return previewError(ext ? `暂不支持预览 .${ext} 文件，可以点右上角"下载"后用电脑上的软件打开` : '暂不支持预览这个文件，可以下载后查看');
  }

  previewDl = { sid, remotePath, start: Date.now(), samples: [] };
  const r = await api.previewFetch(remotePath);
  previewDl = null;
  if (sid !== previewSession) return;
  if (!r.ok) return previewError(r.message);
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
    if (builtin === 'image') { node = el('img', 'pv-media'); node.src = r.url; }
    else if (builtin === 'video') { node = el('video', 'pv-media'); node.src = r.url; node.controls = true; node.autoplay = true; }
    else { node = el('audio', 'pv-audio'); node.src = r.url; node.controls = true; node.autoplay = true; }
    node.onerror = () => previewError('这个文件无法播放或显示，可以下载后查看');
    body.appendChild(node);
    return;
  }

  if (plugin) {
    const frame = el('iframe', 'pv-frame');
    pluginCtx = { frame, localPath: r.localPath, name, ext, sent: false };
    window.removeEventListener('message', onPluginMessage);
    window.addEventListener('message', onPluginMessage);
    frame.src = `crplugin://${plugin.id}/${plugin.entry || 'index.html'}`;
    body.appendChild(frame);
    return;
  }

  // 内置纯文本查看（最多 1MB）
  const t = await api.previewRead(r.localPath);
  if (sid !== previewSession) return;
  if (!t.ok) return previewError(t.message);
  let text = new TextDecoder('utf-8').decode(t.data.subarray(0, 1024 * 1024));
  if (t.data.byteLength > 1024 * 1024) text += '\n\n…（文件较大，只显示前 1MB）';
  body.innerHTML = '';
  const pre = el('pre', 'pv-text');
  pre.textContent = text;
  body.appendChild(pre);
  const tip = el('div', 'pv-tip', '安装「代码与文本预览」插件可以获得语法高亮和 Markdown 排版');
  body.appendChild(tip);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('#preview').classList.contains('hidden') && !document.querySelector('.overlay')) closePreview();
});

refreshInstalledPlugins();
