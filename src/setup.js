// 首次配置向导：用密码（或已有密钥）登录一次 → 装好本机密钥 → 准备账号/目录/Claude Code → 登录 Claude
const { Client, utils } = require('ssh2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { friendlyError } = require('./ssh');
const { connectViaProxy } = require('./proxy');
const { physicalIPv4 } = require('./netpick');

const APP_KEY = process.env.CR_KEY || path.join(os.homedir(), '.ssh', 'claude_remote_ed25519');
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$PATH"';

async function connect({ host, port, username, password, privateKey, proxy, bindDirect }) {
  const sock = proxy ? await connectViaProxy(proxy, host, port) : undefined;
  const direct = !sock && bindDirect ? physicalIPv4() : null;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => {
      const msg = String(err && err.message);
      if (password && /authentication methods failed/i.test(msg)) return reject(new Error('用户名或密码不对，或者这台服务器关闭了密码登录（可改用密钥文件）'));
      reject(new Error(friendlyError(err)));
    });
    // 很多服务器的密码登录走 keyboard-interactive
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password || '')));
    conn.connect({
      host,
      port: Number(port) || 22,
      username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      tryKeyboard: !!password,
      sock,
      localAddress: direct ? direct.address : undefined,
      readyTimeout: 20000,
    });
    if (sock) sock.resume();
  });
}

function exec(conn, cmd, stdin) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errOut += d));
      stream.on('close', (code) => resolve({ code, out: out.trim(), err: errOut.trim() }));
      stream.end(stdin || '');
    });
  });
}

// 本机密钥：已有就复用，没有就生成一把专用的
function ensureLocalKey() {
  if (fs.existsSync(APP_KEY)) {
    let pub = '';
    try { pub = fs.readFileSync(APP_KEY + '.pub', 'utf8').trim(); } catch (_) {}
    if (!pub) {
      const parsed = utils.parseKey(fs.readFileSync(APP_KEY));
      if (parsed instanceof Error) throw new Error('本机密钥文件损坏：' + APP_KEY);
      pub = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`;
    }
    return { path: APP_KEY, pub, created: false };
  }
  const comment = `claude-remote@${os.hostname()}`.replace(/[^\w.@-]/g, '_');
  const kp = utils.generateKeyPairSync('ed25519', { comment });
  fs.mkdirSync(path.dirname(APP_KEY), { recursive: true, mode: 0o700 });
  fs.writeFileSync(APP_KEY, kp.private, { mode: 0o600 });
  fs.writeFileSync(APP_KEY + '.pub', kp.public.trim() + '\n', { mode: 0o644 });
  return { path: APP_KEY, pub: kp.public.trim(), created: true };
}

const AUTHORIZE_SELF = 'K=$(cat); mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF "$K" ~/.ssh/authorized_keys || echo "$K" >> ~/.ssh/authorized_keys)';

function authorizeForUser(user) {
  // 以 root 身份给指定用户建账号并授权公钥（公钥从 stdin 读，避免拼接引号）
  return [
    'set -e',
    'K=$(cat)',
    `U=${user}`,
    'id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"',
    'H=$(getent passwd "$U" | cut -d: -f6)',
    'install -d -m 700 -o "$U" -g "$(id -gn "$U")" "$H/.ssh"',
    'touch "$H/.ssh/authorized_keys"',
    'grep -qF "$K" "$H/.ssh/authorized_keys" || echo "$K" >> "$H/.ssh/authorized_keys"',
    'chown "$U":"$(id -gn "$U")" "$H/.ssh/authorized_keys"',
    'chmod 600 "$H/.ssh/authorized_keys"',
  ].join('\n');
}

async function testClaude(conn) {
  // macOS 没有 timeout 命令，有才用
  const r = await exec(conn, `${PATH_PREFIX}; [ -f ~/.claude-env ] && . ~/.claude-env; cd ~ && if command -v timeout >/dev/null 2>&1; then timeout 150 claude -p --no-session-persistence --output-format json; else claude -p --no-session-persistence --output-format json; fi`, '只回复 OK');
  try {
    const d = JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop());
    return !d.is_error;
  } catch (_) {
    return false;
  }
}

/**
 * input: { host, port, user, password?, keyFile?, createUser, newUser, workdir }
 * log(step, state, detail): state = 'run' | 'ok' | 'warn' | 'fail'
 */
async function runSetup(input, log) {
  const step = async (name, fn) => {
    log(name, 'run');
    try {
      const r = await fn();
      log(name, 'ok', typeof r === 'string' ? r : '');
      return r;
    } catch (e) {
      log(name, 'fail', e.message);
      throw e;
    }
  };

  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.newUser || 'claude')) throw new Error('专用账号名只能用小写字母、数字、下划线');
  const first = { host: input.host, port: input.port, username: input.user, proxy: input.proxy, bindDirect: input.bindDirect };
  if (input.keyFile) first.privateKey = fs.readFileSync(input.keyFile);
  else first.password = input.password;

  // 连不上时（常见于开着全局代理 / TUN），自动改为从物理网卡直连再试一次
  const conn = await step('登录服务器', async () => {
    try {
      return await connect(first);
    } catch (e) {
      if (first.proxy || first.bindDirect || !physicalIPv4() || !/握手前|超时|lost before handshake|timed out/i.test(e.message)) throw e;
      const c = await connect({ ...first, bindDirect: true }).catch(() => { throw e; });
      input.bindDirect = true;
      log('已自动绕过本机代理，从网卡直连', 'ok');
      return c;
    }
  });
  let target = input.user;
  let isRoot = false;
  let isMac = false;
  try {
    await step('检查服务器环境', async () => {
      // Linux 用 free，macOS 用 sysctl 看内存
      const r = await exec(conn, 'uname -s; id -u; command -v curl >/dev/null && echo curl-ok; if [ "$(uname -s)" = Darwin ]; then echo $(( $(sysctl -n hw.memsize) / 1048576 )); else free -m | awk \'/Mem:/{print $2}\'; fi');
      const [osName, uid, curl, mem] = r.out.split('\n');
      if (osName !== 'Linux' && osName !== 'Darwin') throw new Error(`目前只支持 Linux 和 macOS（检测到 ${osName}）`);
      isMac = osName === 'Darwin';
      isRoot = uid === '0';
      if (curl !== 'curl-ok') throw new Error('服务器上没有 curl，请先安装 curl');
      return `${isMac ? 'macOS' : 'Linux'} · ${mem || '?'}MB 内存${isRoot ? ' · root 账号' : ''}`;
    });
    const key = ensureLocalKey();
    // macOS 上不自动建账号（建用户要走系统设置），直接用登录的账号
    if (isRoot && input.createUser && !isMac) {
      target = input.newUser || 'claude';
      await step(`创建专用账号 ${target} 并授权本机密钥`, async () => {
        const r = await exec(conn, authorizeForUser(target), key.pub);
        if (r.code !== 0) throw new Error(r.err || '创建账号失败');
      });
    } else {
      await step('授权本机密钥', async () => {
        const r = await exec(conn, AUTHORIZE_SELF, key.pub);
        if (r.code !== 0) throw new Error(r.err || '写入 authorized_keys 失败');
      });
    }
  } finally {
    conn.end();
  }

  const key = ensureLocalKey();
  const conn2 = await step('用本机密钥重新登录', () => connect({ host: input.host, port: input.port, username: target, privateKey: fs.readFileSync(key.path), proxy: input.proxy, bindDirect: input.bindDirect }));
  try {
    const wd = input.workdir || '~/workspace';
    await step('准备工作文件夹', async () => {
      const r = await exec(conn2, `mkdir -p ${wd.replace(/^~/, '"$HOME"')} && cd ${wd.replace(/^~/, '"$HOME"')} && pwd`);
      if (r.code !== 0) throw new Error(r.err);
      return r.out;
    });
    await step('检查 Claude Code', async () => {
      // 优先用账号自己的原生安装（会自动更新，能用到最新模型）；系统里的旧版只作兜底
      let r = await exec(conn2, '~/.local/bin/claude --version 2>/dev/null');
      if (r.code === 0 && r.out) return r.out;
      log('安装 Claude Code（约 1~2 分钟）', 'run');
      await exec(conn2, 'curl -fsSL https://claude.ai/install.sh | bash');
      r = await exec(conn2, `${PATH_PREFIX}; claude --version 2>/dev/null`);
      if (r.code !== 0 || !r.out) {
        log('安装 Claude Code（约 1~2 分钟）', 'fail');
        throw new Error('Claude Code 安装失败，请检查服务器能否访问 claude.ai');
      }
      log('安装 Claude Code（约 1~2 分钟）', 'ok', r.out);
      return r.out;
    });
    if (target === 'root' || (isRoot && (!input.createUser || isMac))) {
      // root 下跳过权限确认需要声明沙箱环境
      await exec(conn2, 'touch ~/.claude-env && chmod 600 ~/.claude-env && (grep -q IS_SANDBOX ~/.claude-env || echo "export IS_SANDBOX=1" >> ~/.claude-env)');
    }
    const authed = await step('检查 Claude 登录状态', async () => ((await testClaude(conn2)) ? '已登录' : '还没登录'));
    return {
      settings: { host: input.host, port: Number(input.port) || 22, user: target, keyPath: key.path, workdir: wd, proxy: input.proxy || '', bindDirect: !!input.bindDirect },
      needsAuth: authed !== '已登录',
    };
  } finally {
    conn2.end();
  }
}

// ---------- Claude 登录（setup-token） ----------
let auth = null; // { conn, stream, buf }

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][A-Z0-9]/g, '');

// 终端可能把长串折行，取从开头到空行之间的内容并去掉空白
function grabWrapped(text, startRe) {
  const m = text.match(startRe);
  if (!m) return null;
  const rest = text.slice(m.index);
  const end = rest.search(/\n\s*\n|Paste code|Store this|Use this token/);
  return (end > 0 ? rest.slice(0, end) : rest).replace(/\s+/g, '');
}

async function startAuth(settings) {
  cancelAuth();
  const conn = await connect({ host: settings.host, port: settings.port, username: settings.user, privateKey: fs.readFileSync(settings.keyPath), proxy: settings.proxy, bindDirect: settings.bindDirect });
  return new Promise((resolve, reject) => {
    conn.exec(`${PATH_PREFIX}; claude setup-token`, { pty: { cols: 400, rows: 60, term: 'xterm-256color' } }, (err, stream) => {
      if (err) { conn.end(); return reject(err); }
      auth = { conn, stream, buf: '' };
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('获取登录链接超时')); } }, 60000);
      stream.on('data', (d) => {
        auth.buf += d.toString('utf8');
        if (done) return;
        const url = grabWrapped(stripAnsi(auth.buf), /https:\/\/claude\.(?:com|ai)\/\S*oauth\S*/);
        if (url && /state=/.test(url)) {
          done = true;
          clearTimeout(timer);
          resolve(url);
        }
      });
      stream.on('close', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('登录程序意外退出：' + stripAnsi(auth.buf).slice(-300))); } });
    });
  });
}

async function writeEnv(settings, name, value) {
  const conn = await connect({ host: settings.host, port: settings.port, username: settings.user, privateKey: fs.readFileSync(settings.keyPath), proxy: settings.proxy, bindDirect: settings.bindDirect });
  try {
    const cmd = `umask 077; V=$(cat); touch ~/.claude-env; grep -v "^export ${name}=" ~/.claude-env > ~/.claude-env.new; echo "export ${name}=$V" >> ~/.claude-env.new; mv ~/.claude-env.new ~/.claude-env`;
    const r = await exec(conn, cmd, value);
    if (r.code !== 0) throw new Error(r.err || '保存凭证失败');
    if (!(await testClaude(conn))) throw new Error('凭证已保存，但测试调用 Claude 失败，请确认账号有可用的订阅或额度');
  } finally {
    conn.end();
  }
}

async function submitCode(settings, code) {
  if (!auth) throw new Error('请先点击"打开浏览器登录"');
  const { stream } = auth;
  auth.buf = '';
  stream.write(code.trim() + '\r');
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待登录结果超时，请重新获取链接再试')), 60000);
    const check = () => {
      const text = stripAnsi(auth.buf);
      const t = grabWrapped(text, /sk-ant-oat\S*/);
      if (t && /Store this|Use this token|CLAUDE_CODE_OAUTH_TOKEN/.test(text)) {
        clearTimeout(timer);
        return resolve(t);
      }
      if (/error|invalid|failed/i.test(text) && !/sk-ant-/.test(text)) {
        clearTimeout(timer);
        reject(new Error('授权码无效或已过期，请重新获取链接再试'));
      }
    };
    stream.on('data', check);
    stream.on('close', check);
  });
  cancelAuth();
  await writeEnv(settings, 'CLAUDE_CODE_OAUTH_TOKEN', token);
}

async function saveApiKey(settings, key) {
  if (!/^sk-ant-[\w-]+$/.test(key.trim())) throw new Error('API Key 格式不对，应以 sk-ant- 开头');
  await writeEnv(settings, 'ANTHROPIC_API_KEY', key.trim());
}

function cancelAuth() {
  if (auth) {
    try { auth.stream.close(); auth.conn.end(); } catch (_) {}
    auth = null;
  }
}

module.exports = { runSetup, startAuth, submitCode, saveApiKey, cancelAuth, APP_KEY, connect };
