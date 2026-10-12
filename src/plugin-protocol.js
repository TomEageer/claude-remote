// 预览插件的加载协议：crplugin://<插件id>/<文件路径> 映射到 <插件目录>/<插件id>/<文件路径>
// 每个插件是独立源（与主界面跨源），并且通过 CSP 禁止访问网络：插件只能读自己目录里的文件。
const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const SCHEME = 'crplugin';

const CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// 必须在 app ready 之前调用
function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

// 网页预览：crpage://<缓存键>/<文件名> 映射到预览缓存里下载好的 HTML。
// 页面在 sandbox="allow-scripts" 的 iframe 里运行（独立的空源，碰不到主界面和本机文件），
// 允许内联脚本和 https 上的脚本、样式、图片（生成的网页常从 CDN 引图表库），禁止表单提交和嵌套框架
const PAGE_SCHEME = 'crpage';
const PAGE_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'self' 'unsafe-inline' https: data:",
  "img-src 'self' https: http: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src https:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

function handlePageProtocol(cacheDir) {
  protocol.handle(PAGE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const key = url.hostname;
      if (!/^[0-9a-f]{16}$/.test(key)) return new Response('bad key', { status: 400 });
      const root = path.join(cacheDir(), key);
      const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      if (!/\.html?$/i.test(file) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(await fs.promises.readFile(file), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' },
      });
    } catch (e) {
      return new Response(String(e && e.message), { status: 500 });
    }
  });
}

// ready 之后调用；pluginsDirs 按顺序查找（如：用户安装目录、内置目录）
function handleProtocol(pluginsDirs) {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return new Response('bad plugin id', { status: 400 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      for (const dir of pluginsDirs) {
        const root = path.join(dir, id);
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        const body = await fs.promises.readFile(file);
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Security-Policy': CSP,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return new Response(String(e && e.message), { status: 500 });
    }
  });
}

module.exports = { SCHEME, CSP, registerSchemePrivileges, handleProtocol, handlePageProtocol };
