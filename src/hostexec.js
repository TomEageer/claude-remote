// 远端主机适配：Linux / macOS 直接交给登录 shell；Windows（OpenSSH 默认 cmd 或 PowerShell）改由 Git Bash 执行。
// Windows 上命令和要喂给它的数据一起作为脚本从标准输入传给 `bash -s`，数据用随机分隔符的 heredoc，
// 这样不需要处理 cmd / PowerShell 的引号转义。
const crypto = require('crypto');

function rawExec(conn, command, input, opts = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, opts, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errOut += d));
      stream.on('close', (code) => resolve({ code, out, err: errOut }));
      stream.end(input || '');
    });
  });
}

// 识别主机：{ os: 'linux' | 'darwin' | 'windows', bash, shell: 'posix' | 'cmd' | 'powershell' }
async function detectHost(conn) {
  const u = await rawExec(conn, 'uname -s').catch(() => ({ code: 1, out: '' }));
  const name = u.out.trim();
  if (u.code === 0 && /^(Linux|Darwin)$/.test(name)) return { os: name.toLowerCase(), shell: 'posix', bash: null };
  if (u.code === 0 && /^(MINGW|MSYS|CYGWIN)/i.test(name)) return { os: 'windows', shell: 'posix', bash: null };
  const ver = await rawExec(conn, 'cmd /c ver').catch(() => ({ out: '' }));
  if (!/Windows/i.test(ver.out)) return { os: name ? name.toLowerCase() : 'unknown', shell: 'posix', bash: null };
  // 默认 shell 是 cmd 还是 PowerShell（cmd 会把 %OS% 展开成 Windows_NT）
  const e = await rawExec(conn, 'echo %OS%').catch(() => ({ out: '' }));
  const shell = /Windows_NT/.test(e.out) ? 'cmd' : 'powershell';
  // 找 Git Bash（不能用 System32 里那个 WSL 的 bash.exe）
  const w = await rawExec(conn, 'where.exe bash').catch(() => ({ out: '' }));
  let bash = w.out.split(/\r?\n/).map((x) => x.trim()).find((x) => /\\Git\\.*bash\.exe$/i.test(x)) || null;
  if (!bash) {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      const t = await rawExec(conn, `cmd /c if exist "${p}" echo yes`).catch(() => ({ out: '' }));
      if (/yes/.test(t.out)) { bash = p; break; }
    }
  }
  if (bash && /\\Git\\usr\\bin\\bash\.exe$/i.test(bash)) bash = bash.replace(/\\usr\\bin\\bash\.exe$/i, '\\bin\\bash.exe');
  return { os: 'windows', shell, bash };
}

// 把一条 sh 命令（和要喂给它的标准输入）包装成能在这台主机上执行的形式
function wrap(host, cmd, stdin) {
  if (!host || host.os !== 'windows' || host.shell === 'posix') return { command: cmd, input: stdin };
  if (!host.bash) throw new Error('这台 Windows 电脑没有装 Git for Windows（Claude Code 在 Windows 上也需要它），请先安装：https://git-scm.com/download/win');
  const tag = `__CR_${crypto.randomBytes(6).toString('hex')}__`;
  const data = stdin == null ? null : String(stdin).replace(/\r\n/g, '\n');
  const script = data != null && data !== ''
    ? `{ ${cmd}\n} <<'${tag}'\n${data}${data.endsWith('\n') ? '' : '\n'}${tag}\n`
    : `{ ${cmd}\n} </dev/null\n`;
  const command = host.shell === 'powershell' ? `& '${host.bash}' -s` : `"${host.bash}" -s`;
  return { command, input: script };
}

// PowerShell 脚本用 -EncodedCommand 传，cmd 和 PowerShell 下都能直接执行
function psCommand(script) {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

// 路径：SFTP 用 /C:/Users/x，Git Bash 和 Windows 程序用 C:/Users/x
function toSftp(host, p) {
  if (!p || !host || host.os !== 'windows') return p;
  let s = String(p);
  if (/^[A-Za-z]:[\\/]/.test(s)) return '/' + s.replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s); // Git Bash 的 /c/Users/x
  if (m && !/^\/[A-Za-z]:/.test(s)) return `/${m[1].toUpperCase()}:${m[2] || '/'}`;
  return s;
}
function toShell(host, p) {
  if (!p || !host || host.os !== 'windows') return p;
  const s = toSftp(host, p);
  return /^\/[A-Za-z]:\//.test(s) ? s.slice(1) : s;
}

module.exports = { rawExec, detectHost, wrap, psCommand, toSftp, toShell };
