// 软件更新：点「更新」后在软件里自动下载，不用跳下载页。
//
// 快速更新（大多数版本）：每次发版只有软件自己的代码（app.asar，压缩后一两 MB）在变，
// Electron 本体不变。发版时附带 app.asar.gz 和 app-update.json（版本、Electron 版本、校验值），
// Electron 版本相同就只下载这一两 MB（按平台各一个包：app-darwin.asar.gz / app-win32-v2.asar.gz），校验后放进
// 用户数据目录的 app-update/，重启后由 boot.js 加载。不改安装目录里的任何文件：macOS 上 .app 的签名不变，
// 系统给过的文件夹权限不会因为更新而失效；也不需要安装目录的写权限。
// 完整更新（Electron 版本变了）：Windows 交给 electron-updater（按 blockmap 只下载变化的部分）；
// macOS 下载对应架构的 DMG，取出新程序，退出后替换整个 .app 再打开。
// 安装位置没有写权限（比如别的管理员装的）时，退回到提示去下载页。
const { app, net } = require('electron');
const fs = require('fs');
let ofs; // 写 .asar 文件要用 original-fs，Electron 自带的 fs 会把它当成文件夹
try { ofs = require('original-fs'); } catch (_) { ofs = fs; }
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

function createUpdater({ repo, send, currentVersion, cmpVer, autoDownload = () => true }) {
  let pending = null; // 已下载好、等重启安装的更新：{ kind: 'asar' | 'mac-app' | 'win-full', … }
  let busy = false;
  let winUpdater = null;

  const updateDir = () => path.join(app.getPath('userData'), 'app-update');
  const appBundle = () => path.resolve(process.resourcesPath, '..', '..'); // macOS: …/Claude 远程助手.app
  const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (_) { return false; } };

  async function latestRelease() {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
    const j = await res.json();
    return { version: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url, assets: j.assets || [] };
  }

  // 下载到内存（快速更新的包只有几 MB），带进度
  async function download(url, onProgress) {
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let done = 0;
    let last = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(Buffer.from(value));
      done += value.length;
      if (onProgress && Date.now() - last > 200) { last = Date.now(); onProgress(done, total); }
    }
    return Buffer.concat(chunks);
  }

  // 下载大文件到磁盘（完整更新的 DMG）
  async function downloadTo(url, file, onProgress) {
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const out = fs.createWriteStream(file);
    let done = 0;
    let last = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      done += value.length;
      if (onProgress && Date.now() - last > 300) { last = Date.now(); onProgress(done, total); }
    }
    await new Promise((r) => out.end(r));
  }

  // 只有用户手动检查 / 点下载时才报进度；后台自动下载不打扰，下载好了才提示
  let showProgress = false;
  const progress = (version, label) => (done, total) => {
    if (showProgress) send('update:status', { state: 'downloading', version, percent: total ? Math.round((done / total) * 100) : null, size: total || null, label });
  };

  async function fastUpdate(rel) {
    const meta = rel.assets.find((a) => a.name === 'app-update.json');
    // Windows 的包叫 app-win32-v2.asar.gz（旧版本认的旧名字不再发布，让它们走完整更新，见 scripts/make-update.js）
    const packName = process.platform === 'win32' ? 'app-win32-v2.asar.gz' : `app-${process.platform}.asar.gz`;
    const pack = rel.assets.find((a) => a.name === packName);
    if (!meta || !pack) return false;
    const info = JSON.parse((await download(meta.browser_download_url)).toString('utf8'));
    const mine = info[process.platform];
    if (!mine || info.version !== rel.version || info.electron !== process.versions.electron) return false;
    const gz = await download(pack.browser_download_url, progress(rel.version, '快速更新'));
    const asar = zlib.gunzipSync(gz);
    const sha = crypto.createHash('sha512').update(asar).digest('base64');
    if (sha !== mine.sha512 || asar.length !== mine.size) throw new Error('下载的更新文件校验不通过，请稍后再试');
    // 每个版本一个文件名：Windows 上正在用的旧包删不掉，下次启动时再清
    const dir = updateDir();
    ofs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `app-${rel.version}.asar`);
    ofs.writeFileSync(file + '.part', asar);
    ofs.renameSync(file + '.part', file);
    pending = { kind: 'asar', version: rel.version, file };
    send('update:status', { state: 'ready', version: rel.version, size: gz.length });
    return true;
  }

  async function macFullUpdate(rel) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const dmg = rel.assets.find((a) => a.name === `ClaudeRemote-${arch}.dmg`);
    const target = appBundle();
    if (!dmg || !writable(path.dirname(target))) return false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-update-'));
    const file = path.join(dir, 'update.dmg');
    await downloadTo(dmg.browser_download_url, file, progress(rel.version, '完整更新'));
    const mnt = path.join(dir, 'mnt');
    fs.mkdirSync(mnt);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mnt, file]);
    try {
      const appName = fs.readdirSync(mnt).find((n) => n.endsWith('.app'));
      if (!appName) throw new Error('安装包里没有找到程序');
      execFileSync('ditto', [path.join(mnt, appName), path.join(dir, appName)]);
      pending = { kind: 'mac-app', version: rel.version, newApp: path.join(dir, appName), target };
    } finally {
      try { execFileSync('hdiutil', ['detach', '-quiet', mnt]); } catch (_) {}
    }
    send('update:status', { state: 'ready', version: rel.version });
    return true;
  }

  function winFullUpdate(manual) {
    if (!winUpdater) {
      winUpdater = require('electron-updater').autoUpdater;
      winUpdater.autoDownload = true; // 走到这里说明要下载（自动下载开着，或者用户点了下载）
      winUpdater.on('download-progress', (p) => { if (showProgress) send('update:status', { state: 'downloading', percent: Math.round(p.percent), label: '完整更新' }); });
      winUpdater.on('update-downloaded', (i) => { pending = { kind: 'win-full', version: i.version }; send('update:status', { state: 'ready', version: i.version }); });
      winUpdater.on('error', (e) => manual && send('update:status', { state: 'error', message: String(e && e.message).slice(0, 200) }));
    }
    return winUpdater.checkForUpdates();
  }

  async function check(manual) {
    if (busy) return;
    if (pending) return send('update:status', { state: 'ready', version: pending.version });
    busy = true;
    showProgress = !!manual;
    try {
      const rel = await latestRelease();
      if (!rel.version || cmpVer(rel.version, currentVersion()) <= 0) {
        if (manual) send('update:status', { state: 'latest' });
        return;
      }
      if (!app.isPackaged) return send('update:status', { state: 'available', version: rel.version, url: rel.url });
      // 关了自动下载：后台检查到新版本只提示，用户点「下载」（manual）才开始下载
      if (!manual && !autoDownload()) return send('update:status', { state: 'available', version: rel.version, url: rel.url, canDownload: true });
      if (await fastUpdate(rel).catch((e) => { if (manual) send('update:status', { state: 'error', message: e.message }); return false; })) return;
      if (process.platform === 'win32') return void (await winFullUpdate(manual));
      if (process.platform === 'darwin' && (await macFullUpdate(rel))) return;
      send('update:status', { state: 'available', version: rel.version, url: rel.url });
    } catch (e) {
      if (manual) send('update:status', { state: 'error', message: e.message });
    } finally {
      busy = false;
    }
  }

  // 重启并安装
  function install() {
    if (!pending) return;
    const p = pending;
    // 静默安装（装在原来的位置），装完自动打开
    if (p.kind === 'win-full') return winUpdater.quitAndInstall(true, true);
    if (p.kind === 'asar') {
      // 记下新包，重启后 boot.js 就从这里加载
      ofs.writeFileSync(path.join(updateDir(), 'current.json'), JSON.stringify({ version: p.version, electron: process.versions.electron, file: path.basename(p.file) }));
      app.relaunch();
      return app.exit(0);
    }
    // macOS 换整个 .app：等本进程退出后由脚本替换，再打开
    const pid = process.pid;
    if (p.kind === 'mac-app') {
      const sh = path.join(os.tmpdir(), `cr-update-${pid}.sh`);
      const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      fs.writeFileSync(sh, [
        '#!/bin/sh',
        `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done`,
        `rm -rf ${q(p.target)} && mv ${q(p.newApp)} ${q(p.target)}`,
        `xattr -cr ${q(p.target)} 2>/dev/null`,
        `open ${q(p.target)}`,
        `rm -f ${q(sh)}`,
      ].join('\n'));
      fs.chmodSync(sh, 0o755);
      spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore' }).unref();
    }
    app.exit(0);
  }

  return { check, install };
}

module.exports = { createUpdater };
