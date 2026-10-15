// 本机模式：Claude Code 就在这台电脑上，不经过 SSH，直接起本地进程、直接读写文件。
// 接口和 ssh.js 的 Remote 一致（exec / execStream / list / upload / download …），上层代码不用区分。
// 好处：本地进程在你的登录会话里运行，macOS 上能读钥匙串，终端里已经登录的 Claude 直接可用；也不用打开「远程登录」。
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const hostexec = require('./hostexec');

const isWin = process.platform === 'win32';

// 从 Finder / 开始菜单启动的程序拿不到终端里的 PATH（Homebrew 等），先问登录 shell 要一份
let loginPathCache = null;
function loginPath() {
  if (loginPathCache) return loginPathCache;
  let p = process.env.PATH || '';
  if (!isWin) {
    try {
      const sh = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(sh, ['-lc', 'printf "__P__%s" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const i = out.lastIndexOf('__P__');
      if (i >= 0 && out.slice(i + 5).trim()) p = out.slice(i + 5).trim();
    } catch (_) { /* 用当前 PATH */ }
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')]) if (!p.split(':').includes(d)) p += ':' + d;
  }
  loginPathCache = p;
  return p;
}

function findGitBash() {
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class LocalHost extends EventEmitter {
  constructor() {
    super();
    this.settings = null;
    this.state = 'disconnected';
    this.isLocal = true;
    this.host = { os: isWin ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux', shell: 'posix', bash: null };
    this.home = null;
  }

  setState(state, message) {
    this.state = state;
    this.emit('state', { state, message: message || '' });
  }

  configure(settings) {
    this.settings = settings;
    this.setState('disconnected');
  }

  disconnect() {
    this.setState('disconnected');
  }

  async ensure() {
    if (isWin && !this.host.bash) {
      this.host.bash = findGitBash();
      if (!this.host.bash) {
        this.setState('error', '没有找到 Git for Windows');
        throw new Error('这台电脑没有装 Git for Windows（Claude Code 在 Windows 上也需要它），请先安装：https://git-scm.com/download/win');
      }
    }
    if (this.state !== 'connected') this.setState('connected');
    return true;
  }

  // 起一个 bash 执行 sh 命令；stdin 是要喂给它的数据
  spawnSh(cmd) {
    const bash = isWin ? this.host.bash : '/bin/bash';
    return spawn(bash, ['-c', cmd], { cwd: os.homedir(), env: { ...process.env, PATH: loginPath() }, windowsHide: true });
  }

  async exec(command, stdin) {
    await this.ensure();
    return new Promise((resolve) => {
      const child = this.spawnSh(command);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ code: 127, out, err: err + e.message }));
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.on('error', () => {});
      child.stdin.end(stdin || '');
    });
  }

  // Windows 上 taskkill 之类直接交给系统执行
  async execRaw(command) {
    if (!isWin) return this.exec(command);
    return new Promise((resolve) => {
      const child = spawn('cmd.exe', ['/c', command], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out, err: '' }));
      child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
    });
  }

  // 返回一个和 ssh2 通道用法一样的对象：on('data') / stderr / on('close', code) / write / end / close
  async execStream(command, stdin, keepOpen) {
    await this.ensure();
    const child = this.spawnSh(command);
    const ch = new EventEmitter();
    ch.stderr = child.stderr;
    child.stdout.on('data', (d) => ch.emit('data', d));
    child.on('close', (code) => ch.emit('close', code));
    child.on('error', (e) => { child.stderr.emit('data', Buffer.from(e.message)); });
    child.stdin.on('error', () => {});
    ch.write = (d) => child.stdin.write(d);
    ch.end = (d) => child.stdin.end(d);
    ch.close = () => child.kill('SIGTERM');
    if (keepOpen) child.stdin.write(stdin || '');
    else child.stdin.end(stdin || '');
    return ch;
  }

  isWindows() { return isWin; }
  toSftp(p) { return hostexec.toSftp(this.host, p); }
  toShell(p) { return hostexec.toShell(this.host, p); }
  // 界面统一用 / 开头的写法（Windows 上是 /C:/Users/x），访问文件时换回系统路径
  native(p) { return isWin ? String(p).replace(/^\/([A-Za-z]:)/, '$1') : p; }

  async homeDir() {
    if (!this.home) this.home = this.toSftp(os.homedir());
    return this.home;
  }

  async resolve(p) {
    if (p === '~') return this.homeDir();
    if (p.startsWith('~/')) return path.posix.join(await this.homeDir(), p.slice(2));
    return this.toSftp(p);
  }

  async mkdirp(dir) {
    await fs.promises.mkdir(this.native(dir), { recursive: true });
  }

  async copyWithProgress(from, to, onProgress) {
    const total = (await fs.promises.stat(from)).size;
    let done = 0;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(from);
      const ws = fs.createWriteStream(to);
      rs.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  }

  async upload(localPath, remoteDir, onProgress) {
    await this.mkdirp(remoteDir);
    const name = await this.uniqueName(remoteDir, path.basename(localPath));
    const dest = path.posix.join(remoteDir, name);
    await this.copyWithProgress(localPath, this.native(dest), onProgress);
    return dest;
  }

  async uniqueName(dir, name) {
    const exists = (n) => fs.existsSync(this.native(path.posix.join(dir, n)));
    if (!exists(name)) return name;
    const ext = path.posix.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      const n = `${base}(${i})${ext}`;
      if (!exists(n)) return n;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  async list(dir) {
    const names = await fs.promises.readdir(this.native(dir));
    const items = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        const st = await fs.promises.stat(this.native(path.posix.join(dir, name)));
        items.push({ name, path: path.posix.join(dir, name), isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, atime: st.atimeMs, btime: st.birthtimeMs || 0 });
      } catch (_) { /* 断开的链接等 */ }
    }
    return items.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : b.mtime - a.mtime));
  }

  // 和 sftp 的 stat 一样：mtime 用秒
  async stat(p) {
    const st = await fs.promises.stat(this.native(p));
    return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  }

  async rename(from, to) {
    await fs.promises.rename(this.native(from), this.native(to));
  }

  async mkdir(p) {
    await fs.promises.mkdir(this.native(p));
  }

  // 本机删除放进废纸篓 / 回收站，可以找回
  async remove(p) {
    const { shell } = require('electron');
    await shell.trashItem(path.resolve(this.native(p)));
  }

  async walk(dir, rel = '', out = []) {
    const names = await fs.promises.readdir(this.native(path.posix.join(dir, rel)));
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await fs.promises.stat(this.native(path.posix.join(dir, r))).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        out.push({ rel: r, isDir: true, size: 0 });
        await this.walk(dir, r, out);
      } else if (st.isFile()) out.push({ rel: r, isDir: false, size: st.size });
    }
    return out;
  }

  async downloadDir(remoteDir, localDir, onProgress) {
    const entries = await this.walk(remoteDir);
    const files = entries.filter((e) => !e.isDir);
    const total = files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    fs.mkdirSync(localDir, { recursive: true });
    for (const e of entries.filter((x) => x.isDir)) fs.mkdirSync(path.join(localDir, ...e.rel.split('/')), { recursive: true });
    for (const f of files) {
      await this.download(path.posix.join(remoteDir, f.rel), path.join(localDir, ...f.rel.split('/')));
      done += f.size;
      if (onProgress) onProgress(done, total, files.indexOf(f) + 1, files.length);
    }
    return { files: files.length, bytes: total };
  }

  async download(remotePath, localPath, onProgress) {
    await this.copyWithProgress(this.native(remotePath), localPath, onProgress);
  }
}

module.exports = { LocalHost, loginPath, findGitBash };
