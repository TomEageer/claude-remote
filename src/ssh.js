// SSH 连接管理：一条长连接复用给 Claude 进程、上传和文件浏览
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { connectViaProxy } = require('./proxy');
const { physicalIPv4, isLocalHost } = require('./netpick');
const hostexec = require('./hostexec');

class Remote extends EventEmitter {
  constructor() {
    super();
    this.conn = null;
    this.sftpHandle = null;
    this.home = null;
    this.connecting = null;
    this.settings = null;
    this.state = 'disconnected';
  }

  setState(state, message) {
    this.state = state;
    this.emit('state', { state, message: message || '' });
  }

  configure(settings) {
    this.settings = settings;
    this.disconnect();
  }

  disconnect() {
    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.on('error', () => {});
      this.conn.end();
    }
    this.conn = null;
    this.sftpHandle = null;
    this.connecting = null;
    this.madeDirs = null;
    this.setState('disconnected');
  }

  // 已连接直接返回，否则建立连接（并发调用共用同一次连接）
  ensure() {
    if (this.conn && this.state === 'connected') return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    const s = this.settings;
    this.connecting = new Promise((resolve, reject) => {
      let privateKey;
      try {
        privateKey = fs.readFileSync(s.keyPath);
      } catch (e) {
        this.connecting = null;
        this.setState('error', `找不到密钥文件：${s.keyPath}`);
        return reject(new Error(`找不到密钥文件：${s.keyPath}`));
      }
      const conn = new Client();
      this.setState('connecting');
      const start = (sock) => {
        const direct = !sock && s.bindDirect && !isLocalHost(s.host) ? physicalIPv4() : null;
        conn.connect({
          host: s.host,
          port: Number(s.port) || 22,
          username: s.user,
          privateKey,
          sock,
          localAddress: direct ? direct.address : undefined,
          keepaliveInterval: 15000,
          keepaliveCountMax: 4,
          readyTimeout: 20000,
        });
        if (sock) sock.resume();
      };
      conn.on('ready', async () => {
        // 先认出对面是 Linux / macOS / Windows，后面的命令按它的方式执行
        this.host = await hostexec.detectHost(conn).catch(() => ({ os: 'unknown', shell: 'posix', bash: null }));
        this.conn = conn;
        this.connecting = null;
        this.setState('connected');
        resolve(conn);
      });
      conn.on('error', (err) => {
        this.connecting = null;
        this.conn = null;
        this.sftpHandle = null;
        this.setState('error', friendlyError(err));
        reject(new Error(friendlyError(err)));
      });
      conn.on('close', () => {
        if (this.conn === conn) {
          this.conn = null;
          this.sftpHandle = null;
          this.setState('disconnected', '连接已断开');
        }
      });
      if (!s.proxy) return start();
      connectViaProxy(s.proxy, s.host, s.port).then(start, (err) => {
        this.connecting = null;
        this.setState('error', err.message);
        reject(err);
      });
    });
    return this.connecting;
  }

  // sh 命令；Windows 上自动交给 Git Bash
  async exec(command, stdin) {
    const conn = await this.ensure();
    const w = hostexec.wrap(this.host, command, stdin);
    return hostexec.rawExec(conn, w.command, w.input);
  }

  // 直接交给对面的默认 shell（Windows 上的 taskkill 之类）
  async execRaw(command) {
    const conn = await this.ensure();
    return hostexec.rawExec(conn, command);
  }

  // 流式执行；stdin 在这里写入并结束（Windows 上和命令一起作为脚本传）
  async execStream(command, stdin) {
    const conn = await this.ensure();
    const w = hostexec.wrap(this.host, command, stdin);
    return new Promise((resolve, reject) => {
      conn.exec(w.command, (err, stream) => {
        if (err) return reject(err);
        stream.end(w.input || '');
        resolve(stream);
      });
    });
  }

  isWindows() { return !!(this.host && this.host.os === 'windows'); }
  toSftp(p) { return hostexec.toSftp(this.host, p); }
  toShell(p) { return hostexec.toShell(this.host, p); }

  async sftp() {
    if (this.sftpHandle) return this.sftpHandle;
    const conn = await this.ensure();
    this.sftpHandle = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    this.sftpHandle.on('close', () => (this.sftpHandle = null));
    return this.sftpHandle;
  }

  async homeDir() {
    if (this.home) return this.home;
    const sftp = await this.sftp();
    this.home = await new Promise((resolve, reject) =>
      sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p)))
    );
    return this.home;
  }

  // ~/xxx 转成绝对路径（sftp 不认 ~）
  async resolve(p) {
    if (p === '~') return this.homeDir();
    if (p.startsWith('~/')) return path.posix.join(await this.homeDir(), p.slice(2));
    return this.toSftp(p);
  }

  async mkdirp(dir) {
    this.madeDirs = this.madeDirs || new Set();
    if (this.madeDirs.has(dir)) return;
    const sftp = await this.sftp();
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      await new Promise((resolve) => sftp.mkdir(cur, () => resolve()));
    }
    this.madeDirs.add(dir);
  }

  async upload(localPath, remoteDir, onProgress) {
    const sftp = await this.sftp();
    await this.mkdirp(remoteDir);
    const name = await this.uniqueName(remoteDir, path.basename(localPath));
    const remotePath = path.posix.join(remoteDir, name);
    await new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {
        step: (done, _chunk, total) => onProgress && onProgress(done, total),
      }, (err) => (err ? reject(err) : resolve()));
    });
    return remotePath;
  }

  async uniqueName(dir, name) {
    const sftp = await this.sftp();
    const exists = (n) => new Promise((resolve) => sftp.stat(path.posix.join(dir, n), (err) => resolve(!err)));
    if (!(await exists(name))) return name;
    const ext = path.posix.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      const n = `${base}(${i})${ext}`;
      if (!(await exists(n))) return n;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  async list(dir) {
    const sftp = await this.sftp();
    const items = await new Promise((resolve, reject) =>
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    );
    return items
      .filter((i) => !i.filename.startsWith('.'))
      .map((i) => ({
        name: i.filename,
        path: path.posix.join(dir, i.filename),
        isDir: i.attrs.isDirectory(),
        size: i.attrs.size,
        mtime: i.attrs.mtime * 1000,
      }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : b.mtime - a.mtime));
  }

  async stat(p) {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st))));
  }

  async rename(from, to) {
    const sftp = await this.sftp();
    await new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
  }

  async mkdir(p) {
    const sftp = await this.sftp();
    await new Promise((resolve, reject) => sftp.mkdir(p, (err) => (err ? reject(err) : resolve())));
  }

  async remove(p) {
    const q = "'" + String(this.toShell(p)).replace(/'/g, "'\\''") + "'";
    const r = await this.exec(`rm -rf -- ${q}`);
    if (r.code !== 0) throw new Error(r.err || '删除失败');
  }

  // 递归列出目录下所有文件（含隐藏文件），返回相对路径
  async walk(dir, rel = '', out = []) {
    const sftp = await this.sftp();
    const items = await new Promise((resolve, reject) =>
      sftp.readdir(path.posix.join(dir, rel), (err, list) => (err ? reject(err) : resolve(list)))
    );
    for (const i of items) {
      const r = rel ? `${rel}/${i.filename}` : i.filename;
      if (i.attrs.isDirectory()) {
        out.push({ rel: r, isDir: true, size: 0 });
        await this.walk(dir, r, out);
      } else if (i.attrs.isFile()) {
        out.push({ rel: r, isDir: false, size: i.attrs.size });
      }
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

  async download(remotePath, localPath) {
    const sftp = await this.sftp();
    await new Promise((resolve, reject) =>
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()))
    );
  }
}

function friendlyError(err) {
  const msg = String(err && err.message || err);
  if (/authentication methods failed|All configured authentication/i.test(msg)) return '服务器拒绝了这台电脑的密钥，请联系管理员把公钥加到服务器上';
  if (/ETIMEDOUT|Timed out/i.test(msg)) return '连接服务器超时，请检查网络';
  if (/ECONNREFUSED/i.test(msg)) return '服务器拒绝连接：端口不对，或者对方没开 SSH。连自己的 Mac 时，要先在「系统设置 → 通用 → 共享」里打开「远程登录」';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '找不到服务器地址，请检查网络或地址';
  if (/ECONNRESET/i.test(msg)) return '连接被重置，请稍后重试';
  if (/lost before handshake/i.test(msg)) return '服务器在握手前断开了连接。如果电脑开着 Clash、Flowgate 等全局代理，试试在设置里打开「绕过本机代理直连」；如果服务器只允许公司网络访问，需要填代理';
  if (/passphrase/i.test(msg)) return '密钥有密码保护，本软件暂不支持带密码的密钥';
  return msg;
}

module.exports = { Remote, friendlyError };
