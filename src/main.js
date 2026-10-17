const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, screen, powerMonitor, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Remote } = require('./ssh');
const { LocalHost } = require('./localhost');
const { spawn } = require('child_process');
const setup = require('./setup');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const pluginProtocol = require('./plugin-protocol');
const { PluginManager } = require('./plugins');
const history = require('./history');
const { haptic, stopHaptic } = require('./haptic');
const { sendWebhook } = require('./notify');
const vpn = require('./vpn');
const { WriteQueue, cleanTmp } = require('./write-queue');
const quick = require('./quick');

pluginProtocol.registerSchemePrivileges();
let plugins;

// 当前连接：远程服务器走 SSH（ssh.js），「本机」直接起本地进程（localhost.js）；两者接口一致，按设置里的 mode 切换
// 每台服务器一条连接（连接参数相同就共用）。界面上的操作用「当前服务器」的连接（remote）；
// 每轮回复绑定它所在服务器的连接，切换服务器时那边照常跑完，用完且不是当前服务器才断开
const pool = new Map();
const stateListeners = [];
let remoteImpl = null; // 当前服务器的连接；必须在 getConn 之前声明（它的事件回调会读这个变量）
function connKey(s) {
  if (!s) return '';
  const v = s.vpn && s.vpn.on ? `${s.vpn.user}@${s.vpn.server}/${s.vpn.group || ''}` : '';
  return s.mode === 'local' ? 'local' : `${s.user}@${s.host}:${s.port}|${s.keyPath}|${s.proxy || ''}|${s.bindDirect ? 1 : 0}|${v}`;
}
function getConn(s) {
  const k = connKey(s);
  let c = pool.get(k);
  if (!c) {
    c = s && s.mode === 'local' ? new LocalHost() : new Remote();
    c.on('state', (st) => { if (c === remoteImpl) stateListeners.forEach((fn) => fn(st)); });
    c.configure(s);
    pool.set(k, c);
  } else {
    // 连接参数没变：只更新工作文件夹、附加说明等，不断开
    c.settings = s;
  }
  return c;
}
function releaseIdle() {
  for (const [k, c] of pool) {
    if (c === remoteImpl || [...runs.values()].some((r) => r.conn === c)) continue;
    c.disconnect();
    pool.delete(k);
  }
}
remoteImpl = getConn(null);
const remote = new Proxy({}, {
  get(_, k) {
    if (k === 'configure') {
      return (s) => {
        remoteImpl = getConn(s);
        if (remoteImpl.state !== 'connected' && remoteImpl.state !== 'connecting') remoteImpl.configure(s);
        stateListeners.forEach((fn) => fn({ state: remoteImpl.state, message: '' }));
        releaseIdle();
      };
    }
    if (k === 'on') return (ev, fn) => { if (ev === 'state') stateListeners.push(fn); };
    const v = remoteImpl[k];
    return typeof v === 'function' ? v.bind(remoteImpl) : v;
  },
  set(_, k, v) { remoteImpl[k] = v; return true; },
});
// 自测入口只在开发环境生效，打包后的正式版不读这些环境变量
const DEV = !app.isPackaged;
const SELFTEST = DEV ? process.env.CR_SELFTEST : null;
// 离屏自测：不在 Dock 上放图标（批量跑测试时满屏跳）
if (SELFTEST && process.platform === 'darwin' && app.dock) app.dock.hide();
if (DEV && process.env.CR_USERDATA) app.setPath('userData', process.env.CR_USERDATA);
const runs = new Map(); // sessionId -> { stream, pid, stopped }
let win;
// 只允许开一个：后台运行时再点图标，把已有的窗口叫出来，不开第二个（两个同时写同一份对话数据会互相覆盖）
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showMain());
function showMain() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
// 点关闭：默认收到后台接着跑（回复、后台任务都不停）；⌘Q / 托盘里的「退出」才真的退出
let quitting = false;
let closeToBg = true;
app.on('before-quit', () => { quitting = true; });
let tray = null;
function ensureTray() {
  if (process.platform === 'darwin' || tray) return;
  const { Tray, nativeImage } = require('electron');
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude 远程助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Claude 远程助手', click: () => showMain() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());
}
ipcMain.on('app:close-to-bg', (_e, on) => {
  closeToBg = on !== false;
  if (closeToBg) ensureTray();
  else if (tray) { tray.destroy(); tray = null; }
});
// Windows 的系统通知要认软件的标识（和安装时建的快捷方式一致），不然点通知没反应
if (process.platform === 'win32') app.setAppUserModelId('io.claude-remote.app');

const DEFAULT_PROMPT = [
  '你正在通过一个图形界面的聊天客户端为用户服务，用户很可能不懂编程，也看不到命令行。',
  '请用通俗的中文回答，少用术语。',
  '需要交付给用户的文件（文档、表格、PPT、图片等）请保存在当前工作目录里，客户端会在每轮回复末尾自动列出本轮新生成的文件并提供下载按钮，所以不用教用户怎么用命令行取文件。',
  '临时脚本请放在 tools/ 子目录，不要和交付文件混在一起。',
].join('\n');

const DEFAULT_SETTINGS = {
  mode: '', // 'local' = 本机（不经过 SSH）
  autoUpdate: true, // 有新版本时后台自动下载
  haptics: true, // macOS：拖动 / 滚动时间轴时触控板震一下
  host: '',
  port: 22,
  user: '',
  keyPath: setup.APP_KEY,
  workdir: '~/workspace',
  proxy: '',
  bindDirect: false,
  pluginRepo: 'TomEageer/claude-remote-plugins', // 官方仓库（固定）；自定义仓库是 customRepo，勾选 customRepoOn 后作为额外来源
  model: '',
  appendPrompt: DEFAULT_PROMPT,
};

// ---------- 本地存储 ----------
// data.json 放设置和对话列表；每个对话的消息存在 sessions/<对话 id>.json（老版本消息直接写在 data.json 里，照样能读，存一次就拆开）
const dataFile = () => path.join(app.getPath('userData'), 'data.json');
const sessDir = () => path.join(app.getPath('userData'), 'sessions');
const SESS_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function loadData() {
  // 上次被强行关掉时没写完的临时文件
  cleanTmp(app.getPath('userData'));
  cleanTmp(sessDir());
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (_) {}
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data.groups = data.groups || [];
  data.sessions = data.sessions || [];
  for (const s of data.sessions) {
    if (Array.isArray(s.messages)) continue;
    try {
      s.messages = SESS_ID_RE.test(s.id) ? JSON.parse(fs.readFileSync(path.join(sessDir(), s.id + '.json'), 'utf8')) : [];
    } catch (_) {
      s.messages = [];
    }
  }
  return data;
}

// 平时存盘在后台写，不卡主线程；关窗口时同步写完再走（见 write-queue.js）
const writeQueue = new WriteQueue();

function saveData(payload, sync) {
  const put = (file, content) => {
    if (!sync) return writeQueue.schedule(file, content);
    // 同步存一个文件失败（比如被占用）不影响其余文件
    try { writeQueue.writeSync(file, content); } catch (err) { console.error('存盘失败', file, err.message); }
  };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  if (!payload || !payload.meta) return put(dataFile(), JSON.stringify(payload));
  // 先写消息再写列表：中途被杀掉，列表里的对话也都找得到消息
  const dir = sessDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, msgs] of Object.entries(payload.msgs || {})) {
    // 界面那边已经转好 UTF-8 字节（省一次跨进程复制大数组，也省主进程写盘前的编码）；老格式传的是文本或数组，照样能存
    if (SESS_ID_RE.test(id)) put(path.join(dir, id + '.json'), msgs instanceof Uint8Array || typeof msgs === 'string' ? msgs : JSON.stringify(msgs || []));
  }
  put(dataFile(), JSON.stringify(payload.meta));
  // 删掉的对话，消息文件也删掉
  if (Array.isArray(payload.ids)) {
    const keep = new Set(payload.ids);
    for (const f of fs.readdirSync(dir)) {
      const m = /^(.+)\.json$/.exec(f);
      if (m && SESS_ID_RE.test(m[1]) && !keep.has(m[1])) put(path.join(dir, f), null);
    }
  }
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 500,
    backgroundColor: '#faf9f5',
    title: 'Claude 远程助手',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    show: !SELFTEST,
    webPreferences: {
      offscreen: !!SELFTEST,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 窗口在后台时不降低定时器频率：手机远程控制的心跳和推送要照常跑（降频后连接会每两分钟断一次）
      backgroundThrottling: false,
    },
  });
  if (process.platform !== 'darwin') win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // 预览框（插件、网页）里点链接不能跳到外部网站
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !/^(crpage|crplugin|about|blob|data):/.test(e.url)) e.preventDefault();
  });
  // 窗口最小化 / 隐藏时告诉页面：停掉动画、流式回复先不重画，省 CPU（连接和推送照常跑）
  const vis = () => send('win:visible', win.isVisible() && !win.isMinimized());
  for (const ev of ['minimize', 'restore', 'hide', 'show']) win.on(ev, vis);
  win.on('close', (e) => {
    if (quitting || !closeToBg) return;
    e.preventDefault();
    win.hide();
    // Windows 第一次收到后台时说一声去哪找它
    const tip = path.join(app.getPath('userData'), 'bg-tip-shown');
    if (process.platform !== 'darwin' && !fs.existsSync(tip) && Notification.isSupported()) {
      try { fs.writeFileSync(tip, '1'); } catch (_) {}
      new Notification({ title: 'Claude 远程助手还在后台运行', body: '回复和后台任务会继续。点屏幕右下角托盘里的图标打开，右键可以退出。' }).show();
    }
  });
  // 主窗口关了，快速输入的小窗口也一起关掉：不然它（平时只是藏起来）会让软件以为还有窗口开着、不退出，主窗口再也打不开
  win.on('closed', () => quick.closeWindow());
  if (SELFTEST) win.webContents.once('did-finish-load', () => require(SELFTEST)(win, app));
  if (process.env.CR_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

remote.on('state', (s) => send('ssh:state', s));

// ---------- 远程 Claude ----------
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

async function workdirAbs(c = remote) {
  return c.resolve(c.settings.workdir || '~/workspace');
}

// 对话的工作目录：可能是 /home/x、C:\Users\x 或 /C:/Users/x，统一成 SFTP 写法
function validCwd(cwd, c = remote) {
  if (!cwd) return null;
  const p = c.toSftp(String(cwd));
  return /^\/[^\0\n]*$/.test(p) ? p : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_RE = /^[A-Za-z0-9:_.-]{1,80}$/;

// sessionId 是本地会话 id（事件按它分发）；claudeId 是服务器上 Claude Code 的会话 id。
// fork = { from, at }：从会话 from 的消息 at 处分出新会话（回退 / 分支）。
// caps = { mcpOff: [名称], skillsOff: [名称] }：这个会话里关掉的 MCP 和 Skill。
// server：这个对话所在服务器的连接参数（可能不是当前服务器）
// plan：计划模式（只调研、出方案，你批准后才动手）
// 权限模式（界面上的叫法 → Claude Code 的参数）：默认 = 改文件、跑命令前问你；自动 = Claude 自己判断，拿不准才问；危险 = 全部放行
const PERM_MODES = { manual: 'default', auto: 'auto', bypass: 'bypassPermissions' };
const permArg = (perm) => PERM_MODES[perm] || 'auto';
async function runClaude({ sessionId, claudeId, isNew, fork, prompt, model, effort, caps, cwd, server, plan, perm }) {
  if (runs.has(sessionId)) throw new Error('这个对话正在回复中');
  const conn = server ? getConn({ ...remote.settings, ...server }) : remoteImpl;
  // 从服务器导入的会话要在它原来的目录里继续（Claude Code 按目录保存会话）
  const wd = validCwd(cwd, conn) || (await workdirAbs(conn));
  const cid = claudeId || sessionId;
  if (!UUID_RE.test(cid)) throw new Error('会话编号不合法');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', plan ? 'plan' : permArg(perm),
  ];
  if (fork && UUID_RE.test(fork.from) && UUID_RE.test(fork.at)) args.push('--resume', fork.from, '--resume-session-at', fork.at, '--fork-session');
  else args.push(isNew ? '--session-id' : '--resume', cid);
  // default = 用 Claude Code 自己的默认模型，不传 --model
  if (model && model !== 'default' && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
  if (/^[a-z]{2,10}$/.test(effort || '')) args.push('--effort', effort);
  const mcpOff = (caps && caps.mcpOff) || [];
  const skillsOff = ((caps && caps.skillsOff) || []).filter((x) => SKILL_RE.test(x));
  if (mcpOff.length) {
    const g = await globalCaps(conn).catch(() => null);
    const servers = {};
    for (const m of (g && g.mcp) || []) if (!mcpOff.includes(m.name)) servers[m.name] = m.config;
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers }));
  }
  if (skillsOff.length) args.push('--disallowedTools', skillsOff.map((x) => `Skill(${x})`).join(' '));
  const extra = conn.settings.appendPrompt;
  if (extra && extra.trim()) args.push('--append-system-prompt', extra.trim());
  // 交互模式：消息走 JSON 输入，权限请求走标准输入输出，Claude 才能用「向你提问」工具（AskUserQuestion）
  // 弹出可点击的选项。Windows 主机的命令要整段从标准输入喂给 Git Bash，没法边跑边写，仍用普通模式
  await conn.ensure();
  const interactive = !conn.isWindows();
  if (interactive) args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  const cmd = [
    `mkdir -p ${shQuote(conn.toShell(wd))} && cd ${shQuote(conn.toShell(wd))}`,
    // ~/.claude-env 放后面：里面可能指定了已有的 Claude Code（如 Homebrew 装的），要优先于 ~/.local/bin
    `export PATH="$HOME/.local/bin:$PATH"`,
    `[ -f ~/.claude-env ] && . ~/.claude-env`,
    // Windows（Git Bash）上要拿真正的 Windows 进程号，停止时用 taskkill 结束整个进程树
    `echo "__PID__$( [ -r /proc/$$/winpid ] && cat /proc/$$/winpid || echo $$ ) $(date +%s)"`,
    `exec claude ${args.map(shQuote).join(' ')}`,
  ].join('; ');

  const input = interactive ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n' : prompt;
  const stream = await conn.execStream(cmd, input, interactive);
  const run = { perm: PERM_MODES[perm] ? perm : 'auto', conn, stream, pid: null, startedAt: null, startedLocal: 0, names: new Set(), stopped: false, claudeSid: null, tasks: new Map(), asks: new Map(), interactive, inputClosed: !interactive };
  run.write = (obj) => { if (!run.inputClosed) stream.write(JSON.stringify(obj) + '\n'); };
  // 一轮结束（且没有在跑的后台任务、没有等待回答的提问）时关闭输入，Claude 处理完就退出
  run.maybeCloseInput = () => {
    if (run.inputClosed || run.asks.size) return;
    if ([...run.tasks.values()].some((t) => t.running)) return;
    run.inputClosed = true;
    stream.end();
  };
  runs.set(sessionId, run);
  const emit = (ev) => send('claude:event', { sessionId, ev });

  let buf = '';
  let stderr = '';
  let gotResult = false;

  const handleLine = (line) => {
    if (!line.trim()) return;
    if (run.pid === null && line.startsWith('__PID__')) {
      const [pid, ts] = line.slice(7).split(' ');
      run.pid = Number(pid) || 0;
      run.startedAt = Number(ts) || null;
      run.startedLocal = Date.now();
      return;
    }
    let d;
    try {
      d = JSON.parse(line);
    } catch (_) {
      return;
    }
    // 子助手（Agent 工具）内部的步骤：挂到派出它的那个工具调用下面
    if (d.parent_tool_use_id) {
      const parent = d.parent_tool_use_id;
      if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
        for (const c of d.message.content) {
          if (c.type === 'tool_use') emit({ type: 'sub', parent, ev: { type: 'tool', id: c.id, name: c.name, input: c.input } });
          else if (c.type === 'text' && c.text && c.text.trim()) emit({ type: 'sub', parent, ev: { type: 'text', text: c.text } });
        }
      } else if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
        for (const c of d.message.content) {
          if (c.type === 'tool_result') emit({ type: 'sub', parent, ev: { type: 'tool_result', id: c.tool_use_id, isError: !!c.is_error, preview: previewOf(c.content) } });
        }
      }
      return;
    }
    // 后台任务：后台运行的命令（local_bash）和派出的助手（local_agent）
    if (d.type === 'system' && /^task_/.test(d.subtype || '')) {
      if (d.task_id) {
        const t = run.tasks.get(d.task_id) || { type: d.task_type || null, outputFile: null, running: true };
        if (d.task_type) t.type = d.task_type;
        if (d.output_file) t.outputFile = d.output_file;
        const st = d.status || (d.patch && d.patch.status);
        // 结束过的任务（比如子助手）可能又被叫起来接着干：开始 / 进展 / 状态回到运行中，都算重新在跑
        if (st) t.running = /^(running|pending|started)$/i.test(st);
        else if (d.subtype === 'task_started' || d.subtype === 'task_progress') t.running = true;
        run.tasks.set(d.task_id, t);
      }
      const u = d.usage || null;
      emit({
        type: 'task',
        subtype: d.subtype,
        taskId: d.task_id,
        taskType: d.task_type || null,
        toolId: d.tool_use_id || null,
        description: d.description || null,
        status: d.status || (d.patch && d.patch.status) || null,
        summary: typeof d.summary === 'string' ? d.summary.slice(0, 4000) : null,
        usage: u ? { tokens: u.total_tokens || 0, tools: u.tool_uses || 0, ms: u.duration_ms || 0 } : null,
      });
      return;
    }
    // 权限通道的请求：「向你提问」交给界面让用户选，其余工具直接放行（本来就是全自动放行模式）
    if (d.type === 'control_request' && d.request_id) {
      const r = d.request || {};
      if (r.subtype === 'can_use_tool' && r.tool_name === 'AskUserQuestion') {
        run.asks.set(d.request_id, r.input || {});
        emit({ type: 'ask', requestId: d.request_id, toolId: r.tool_use_id || null, questions: (r.input && r.input.questions) || [] });
      } else if (r.subtype === 'can_use_tool' && r.tool_name === 'ExitPlanMode') {
        // 计划模式下方案写好了：等你批准才开始动手
        run.asks.set(d.request_id, r.input || {});
        emit({ type: 'plan', requestId: d.request_id, toolId: r.tool_use_id || null, plan: (r.input && r.input.plan) || '' });
      } else if (r.subtype === 'can_use_tool' && run.perm === 'bypass') {
        run.write({ type: 'control_response', response: { subtype: 'success', request_id: d.request_id, response: { behavior: 'allow', updatedInput: r.input || {} } } });
      } else if (r.subtype === 'can_use_tool') {
        // 默认 / 自动模式下 Claude 要做的事需要你点头：交给界面（电脑、手机都能点允许 / 拒绝）
        run.asks.set(d.request_id, r.input || {});
        emit({ type: 'perm', requestId: d.request_id, toolId: r.tool_use_id || null, name: r.tool_name || '', input: r.input || {}, reason: typeof r.decision_reason === 'string' ? r.decision_reason.slice(0, 500) : '' });
      } else {
        run.write({ type: 'control_response', response: { subtype: 'error', request_id: d.request_id, error: '客户端不支持这个请求' } });
      }
      return;
    }
    if (d.type === 'system' && d.subtype === 'init') {
      run.claudeSid = d.session_id || null;
      emit({
        type: 'init',
        model: d.model,
        claudeId: d.session_id,
        mcp: (d.mcp_servers || []).map((m) => ({ name: m.name, status: m.status })),
        skills: d.skills || [],
        plugins: (d.plugins || []).map((p) => p.name || p),
        slashCommands: (d.slash_commands || []).slice(0, 500),
        tools: (d.tools || []).length,
        permissionMode: d.permissionMode || null,
      });
    } else if (d.type === 'rate_limit_event' && d.rate_limit_info) {
      emit({ type: 'ratelimit', info: d.rate_limit_info });
    } else if (d.type === 'system' && d.subtype === 'status') {
      emit({ type: 'status', status: d.status || null });
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      emit({ type: 'compacted' });
    } else if (d.type === 'stream_event') {
      const e = d.event || {};
      // 子助手的流式事件不管：画面上的状态只跟主线走
      if (d.parent_tool_use_id) return;
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        emit({ type: 'text', text: e.delta.text });
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'thinking_delta') {
        // 思考的文字（Claude 不一定给，很多时候只有加密内容，这时就没有这个事件）
        if (e.delta.thinking) emit({ type: 'thinkdelta', text: e.delta.thinking });
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta') {
        // Claude 正在写一个操作（比如要写入的大文件）：整段写完才会出现工具卡片，这之前只报进度，最多每 300 毫秒一次
        const dr = run.draft;
        if (dr) {
          dr.len += (e.delta.partial_json || '').length;
          if (dr.json.length < 4000) dr.json += e.delta.partial_json || '';
          dr.tail = (dr.tail + (e.delta.partial_json || '')).slice(-600);
          const now = Date.now();
          if (now - dr.sent > 300) {
            dr.sent = now;
            if (!dr.hint) { const m = /"(?:file_path|notebook_path|description|command|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.){1,160})/.exec(dr.json.slice(0, 4000)); if (m) dr.hint = m[1].replace(/\\(.)/g, '$1'); }
            emit({ type: 'tooldraft', name: dr.name, chars: dr.len, hint: dr.hint || '', tail: dr.tail });
          }
        }
      } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
        run.draft = { name: e.content_block.name, json: '', tail: '', len: 0, sent: Date.now(), hint: '' };
        emit({ type: 'tooldraft', name: e.content_block.name, chars: 0, hint: '' });
      } else if (e.type === 'content_block_stop') {
        run.draft = null;
      } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'thinking') {
        emit({ type: 'thinking' });
      } else if (e.type === 'message_start') {
        emit({ type: 'msgstart' });
      }
    } else if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
      if (d.uuid) emit({ type: 'anchor', uuid: d.uuid });
      for (const c of d.message.content) {
        if (c.type === 'tool_use') {
          noteNames(run.names, c.input);
          // SendMessage 把之前派出去的子助手叫起来接着干（收件人就是它的任务编号）：算它重新在跑，这一轮的输入先别关
          if (c.name === 'SendMessage' && c.input && typeof c.input.to === 'string' && run.tasks.has(c.input.to)) run.tasks.get(c.input.to).running = true;
          emit({ type: 'tool', id: c.id, name: c.name, input: c.input });
        }
      }
    } else if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
      for (const c of d.message.content) {
        if (c.type === 'tool_result') {
          noteNames(run.names, c.content);
          // 子代理交回结果时带着它实际用的模型（resolvedModel）
          const tr = d.tool_use_result && typeof d.tool_use_result === 'object' ? d.tool_use_result : {};
          emit({ type: 'tool_result', id: c.tool_use_id, isError: !!c.is_error, preview: previewOf(c.content), model: tr.resolvedModel || null });
        }
      }
    } else if (d.type === 'result') {
      gotResult = true;
      run.maybeCloseInput();
      // 用量统计：各模型的 token 和 Claude Code 按 API 价格算的金额（是这个进程的累计值，续接的对话可能还带着以前的，
      // 界面那边减掉上一次的数再记）；turn 是这一轮主模型自己的用量，用来判断有没有带着以前的
      if (d.modelUsage && Object.keys(d.modelUsage).length) {
        run.results = (run.results || 0) + 1;
        const mu = {};
        for (const [id, x] of Object.entries(d.modelUsage)) {
          // 同一个模型可能有几个名字（带日期 / 带 [1m]），合在一起
          const k = x.canonicalModel || id.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
          const m = mu[k] || (mu[k] = { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
          m.in += x.inputTokens || 0; m.out += x.outputTokens || 0; m.cr += x.cacheReadInputTokens || 0; m.cw += x.cacheCreationInputTokens || 0; m.cost += x.costUSD || 0;
        }
        const tu = d.usage || {};
        emit({ type: 'tokens', modelUsage: mu, turn: (tu.input_tokens || 0) + (tu.cache_read_input_tokens || 0) + (tu.cache_creation_input_tokens || 0) + (tu.output_tokens || 0), turnUsage: { in: tu.input_tokens || 0, out: tu.output_tokens || 0, cr: tu.cache_read_input_tokens || 0, cw: tu.cache_creation_input_tokens || 0 }, first: run.results === 1 });
      }
      // 用户主动停止时 Claude 会以错误结束，不当成出错展示
      if (run.stopped) return;
      // 上下文用量：最后一次请求的输入（含缓存）+ 输出；上限取模型的 contextWindow
      const u = d.usage || {};
      const it = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u;
      const context = (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0) + (it.output_tokens || 0);
      const mu = Object.values(d.modelUsage || {});
      const window = mu.reduce((m, x) => Math.max(m, x.contextWindow || 0), 0);
      if (context) emit({ type: 'usage', context, window, cost: d.total_cost_usd || 0 });
      const isError = !!d.is_error || (d.subtype && d.subtype !== 'success');
      const raw = typeof d.result === 'string' ? d.result : '';
      emit({
        type: 'result',
        isError,
        text: isError ? explainResultError(raw, conn) : raw,
        subtype: d.subtype,
        durationMs: d.duration_ms,
      });
    }
  };

  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  stream.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  stream.on('close', async (code) => {
    if (buf) handleLine(buf);
    if (run.startedAt) {
      // 修改时间晚于「现在」的（相机、别的机器拷来的文件时钟不对）不算本轮的；startedAt 是服务器时钟，按本机经过的时间推算服务器的现在
      const until = run.startedAt * 1000 + (Date.now() - run.startedLocal) + 10000;
      const files = (await changedFiles(wd, run.startedAt, conn).catch(() => [])).filter((f) => f.mtime <= until);
      // 同一目录里可能同时有别的对话在产出文件：这一轮的工具调用和返回里没提到过名字的，归到「来源不确定」，不当成本轮的成果
      for (const f of files) {
        const b = path.posix.basename(f.rel);
        // 名字里带空格的，提取时只取到最后一个空格之后那段
        if (!run.names.has(b) && !run.names.has(b.split(/\s/).pop())) f.unsure = true;
      }
      if (files.length) emit({ type: 'files', files });
    }
    runs.delete(sessionId);
    releaseIdle();
    if (run.stopped) emit({ type: 'stopped' });
    else if (!gotResult) {
      emit({
        type: 'error',
        message: explainFailure(stderr, code),
        sessionExists: /already in use/i.test(stderr),
        sessionMissing: /No conversation found/i.test(stderr),
      });
    }
    emit({ type: 'end' });
  });
}

// 本轮开始后工作目录里新建/修改过的文件（排除上传目录、隐藏目录和依赖缓存）
// 本轮开始后工作目录里新建/修改过的文件。Linux（GNU find）和 macOS（BSD find）写法不同；
// 两边都支持 -mmin，先按分钟粗筛，再按精确时间过滤
// 收集工具调用参数和返回内容里出现过的文件名（只取带扩展名的最后一段），用来认领本轮产出的文件
const NAME_RE = /[^\s"'`<>|;:,()[\]{}=*?\\/]+\.[A-Za-z0-9]{1,10}/g;
const NAMES_MAX = 20000;
const NAME_SCAN_MAX = 256 * 1024; // 大段内容（写入的数据文件、读回来的大输出）只看开头，免得卡主进程
function noteNames(set, v, depth = 0) {
  if (set.size >= NAMES_MAX || depth > 8 || v == null) return;
  if (typeof v === 'string') { for (const m of (v.length > NAME_SCAN_MAX ? v.slice(0, NAME_SCAN_MAX) : v).matchAll(NAME_RE)) { set.add(m[0]); if (set.size >= NAMES_MAX) return; } return; }
  if (Array.isArray(v)) { for (const x of v) noteNames(set, x, depth + 1); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) noteNames(set, x, depth + 1);
}

async function changedFiles(wd, since, conn = remote) {
  const mins = Math.max(1, Math.ceil((Date.now() / 1000 - since) / 60) + 1);
  // 整个目录直接跳过（不进去遍历）：隐藏目录、上传目录、依赖缓存，以及工作目录是家目录时的 Library（macOS）/ AppData（Windows）——系统和别的软件随时在往里写
  const prune = `\\( -path '*/.*' -o -path ./uploads -o -path ./Library -o -path ./AppData -o -name node_modules -o -name __pycache__ -o -name venv -o -name site-packages \\) -prune -o`;
  const gnu = `find . -maxdepth 6 ${prune} -type f -mmin -${mins} -printf '%T@\\t%s\\t%P\\n'`;
  const bsd = `find . -maxdepth 6 ${prune} -type f -mmin -${mins} -exec stat -f '%m%t%z%t%N' {} +`;
  const cmd = `cd ${shQuote(conn.toShell(wd))} && if find --version >/dev/null 2>&1; then ${gnu}; else ${bsd}; fi 2>/dev/null | sort -rn | head -n 400`;
  const r = await conn.exec(cmd);
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [mtime, size, rel0] = line.split('\t');
    const rel = String(rel0 || '').replace(/^\.\//, '');
    return { rel, path: path.posix.join(wd, rel), size: Number(size), mtime: Number(mtime) * 1000 };
  }).filter((f) => f.rel && f.mtime >= (since - 1) * 1000).sort((a, b) => b.mtime - a.mtime);
}

function previewOf(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '（这是一张图片，点右上角「预览」查看）' : `[${c.type}]`)).join('\n');
  return text.length > 1500 ? text.slice(0, 1500) + '\n…' : text;
}

// Claude 一轮以错误结束时给出的原文（英文）→ 用户能看懂的说明
const MAC_KEYCHAIN_TIP = '这台 Mac 上的 Claude 读不到你的登录信息：Claude Code 把登录信息存在 macOS 的钥匙串里，而通过 SSH 远程进来的会话没有权限读取钥匙串，所以即使你在这台 Mac 的终端里已经登录，这里也算没登录。点「登录 Claude」在这里单独授权一次就好：会生成一个长期令牌，只保存在这台 Mac 的 ~/.claude-env 里，不影响你在终端里用的 Claude。';
function explainResultError(text, conn = remote) {
  if (/Not logged in|Please run \/login/i.test(text)) {
    if (conn.isLocal) return '这台电脑上的 Claude 还没有登录。点「登录 Claude」，在打开的终端里按提示登录一次就好。';
    return conn.host && conn.host.os === 'darwin' ? MAC_KEYCHAIN_TIP : '这台服务器上的 Claude 还没有登录。点「登录 Claude」授权一次就好。';
  }
  if (/OAuth token (has )?expired|authentication_error|Invalid API key|invalid x-api-key|401/i.test(text)) {
    return 'Claude 登录已失效，点「登录 Claude」重新授权。\n\n' + text.slice(0, 300);
  }
  return text;
}

function explainFailure(stderr, code) {
  const s = stderr.trim();
  if (/command not found|claude: not found/i.test(s)) return '服务器上没有安装 Claude，请联系管理员';
  if (/permission-mode/i.test(s) && /invalid|choices/i.test(s)) return '服务器上的 Claude 版本太旧，不支持这个权限模式（「自动」需要较新的版本）。在服务器上运行 claude update 升级，或者在输入框下面换成「默认」模式。';
  if (/No conversation found|not found.*session/i.test(s)) return '服务器上找不到这个对话的记录，请新建一个对话';
  if (/already in use/i.test(s)) return '对话编号冲突，请重试一次';
  if (/login|auth|401|OAuth|API key/i.test(s)) return 'Claude 登录已失效，请联系管理员重新授权\n\n' + s.slice(-400);
  return `Claude 异常退出（代码 ${code}）${s ? '\n\n' + s.slice(-600) : ''}`;
}

async function stopClaude(sessionId) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.stopped = true;
  if (run.pid) {
    if (run.conn.isWindows()) await run.conn.execRaw(`taskkill /T /F /PID ${Number(run.pid)}`).catch(() => {});
    else await run.conn.exec(`kill -INT ${run.pid} 2>/dev/null; sleep 2; kill -TERM ${run.pid} 2>/dev/null; true`).catch(() => {});
  } else {
    run.stream.close();
  }
}

// 用户回答了 Claude 的提问。answers：{ 问题原文: 选中的选项（多选用逗号隔开，或自己填的内容） }；
// skip：不回答，告诉 Claude 用户跳过了
function answerAsk({ sessionId, requestId, answers, skip }) {
  const run = runs.get(sessionId);
  if (!run || !run.asks.has(requestId)) throw new Error('这个问题已经失效（这一轮回复已经结束）');
  const input = run.asks.get(requestId);
  run.asks.delete(requestId);
  const response = skip
    ? { behavior: 'deny', message: '用户跳过了这个问题，没有选择。请按你的判断继续，或者用文字说明需要用户决定的事。' }
    : { behavior: 'allow', updatedInput: { ...input, answers: answers || {} } };
  run.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  return {};
}

// 计划批准 / 打回：批准后这一轮接着动手，并切回全自动放行；打回时把你的意见带给 Claude，它会接着改计划
function answerPlan({ sessionId, requestId, approve, feedback }) {
  const run = runs.get(sessionId);
  if (!run || !run.asks.has(requestId)) throw new Error('这个计划已经失效（这一轮回复已经结束）');
  const input = run.asks.get(requestId);
  run.asks.delete(requestId);
  const fb = String(feedback || '').trim();
  const response = approve
    ? { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: permArg(run.perm), destination: 'session' }] }
    : { behavior: 'deny', message: fb ? `用户还不想按这个计划执行，修改意见：${fb}\n请按意见修改计划后再给用户确认。` : '用户还不想按这个计划执行，想先调整。请停下来等用户说明要怎么改，不要开始执行。' };
  run.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  return {};
}

// 允许 / 拒绝 Claude 要做的一步操作（默认、自动模式下才会问）
function answerPerm({ sessionId, requestId, allow }) {
  const run = runs.get(sessionId);
  if (!run || !run.asks.has(requestId)) throw new Error('这个请求已经失效（这一轮回复已经结束）');
  const input = run.asks.get(requestId);
  run.asks.delete(requestId);
  const response = allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户拒绝了这一步操作。不要重试同样的操作；如果这一步是必须的，停下来向用户说明原因。' };
  run.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  return {};
}

// ---------- 旁问（/btw） ----------
// 带着当前对话的上下文问一个旁支问题：从这个会话分叉一份（--fork-session）且不保存（--no-session-persistence），
// 不能用任何工具，所以不会动文件，也不会出现在原对话里；和正在进行的回复互不影响
const btws = new Map(); // btwId → 通道
async function askBtw({ btwId, claudeId, started, question, model, cwd, server }) {
  if (!/^[\w-]{4,64}$/.test(btwId || '')) throw new Error('编号不合法');
  const conn = server ? getConn({ ...remote.settings, ...server }) : remoteImpl;
  const wd = validCwd(cwd, conn) || (await workdirAbs(conn));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--tools', '',
    '--append-system-prompt', '这是用户在对话进行中插问的一个旁支问题。只根据已有的对话内容和你的知识简短回答，不要调用任何工具，也不要继续之前的任务。'];
  if (started && UUID_RE.test(claudeId || '')) args.push('--resume', claudeId, '--fork-session');
  if (model && model !== 'default' && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
  const cmd = `cd ${shQuote(conn.toShell(wd))}; export PATH="$HOME/.local/bin:$PATH"; [ -f ~/.claude-env ] && . ~/.claude-env; exec claude ${args.map(shQuote).join(' ')}`;
  const ch = await conn.execStream(cmd, String(question || ''));
  btws.set(btwId, ch);
  let buf = '';
  let got = false;
  const out = (ev) => send('btw:event', { btwId, ...ev });
  ch.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let d;
      try { d = JSON.parse(line); } catch (_) { continue; }
      const e = d.type === 'stream_event' && d.event;
      if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { got = true; out({ type: 'text', text: e.delta.text }); }
      else if (d.type === 'assistant' && !got && d.message && Array.isArray(d.message.content)) {
        // 没收到逐字的流（有时会这样）：从完整的消息里把文字拿出来
        const t = d.message.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n\n');
        if (t) { got = true; out({ type: 'text', text: t }); }
      } else if (d.type === 'result') {
        let text = got ? '' : String(d.result || '');
        // 结束了却一个字都没有：说清楚原因，不留空白
        if (!got && !text.trim()) text = `Claude 没有给出文字回答${d.subtype && d.subtype !== 'success' ? `（${d.subtype}）` : ''}。可能是它想调用工具（旁问里不能用工具），换个问法再试，或者直接在对话里问`;
        out({ type: 'done', isError: !!d.is_error, text, cost: d.total_cost_usd || 0 });
      }
    }
  });
  let errText = '';
  if (ch.stderr) ch.stderr.on('data', (x) => { errText += x.toString('utf8'); });
  ch.on('close', () => { btws.delete(btwId); out({ type: 'closed', err: errText.trim().slice(-300) }); });
  return {};
}

// ---------- 后台任务 ----------
// Claude Code 把后台任务的输出写在 <临时目录>/claude-<uid>/<目录>/<会话>/tasks/<任务>.output
const TASK_RE = /^[A-Za-z0-9_-]{4,64}$/;
async function taskFile(claudeSid, taskId, known, conn = remote) {
  if (!TASK_RE.test(taskId || '')) throw new Error('任务编号不合法');
  if (known && /^\/[^\0\n]*\/tasks\/[A-Za-z0-9_-]+\.output$/.test(known)) return known;
  if (!UUID_RE.test(claudeSid || '')) throw new Error('找不到这个任务的输出');
  const tail = `${claudeSid}/tasks/${taskId}.output`;
  const r = await conn.exec(`for f in "\${TMPDIR:-/tmp}"/claude*/*/${tail} /tmp/claude*/*/${tail} "\${TEMP:-/nonexistent}"/claude*/*/${tail}; do [ -f "$f" ] && { echo "$f"; break; }; done`);
  const f = r.out.trim().split('\n')[0];
  if (!f) throw new Error('找不到这个任务的输出（可能已被系统清理）');
  return f;
}

async function taskOutput({ sessionId, taskId, claudeId }) {
  const run = runs.get(sessionId);
  const conn = (run && run.conn) || remote;
  const t = run && run.tasks.get(taskId);
  const f = await taskFile((run && run.claudeSid) || claudeId, taskId, t && t.outputFile, conn);
  const r = await conn.exec(`f=${shQuote(f)}; wc -c < "$f"; echo ---; tail -c 16000 -- "$f"`);
  const i = r.out.indexOf('---\n');
  return { size: Number(r.out.slice(0, i).trim()) || 0, text: i >= 0 ? r.out.slice(i + 4) : '' };
}

// 单独停止一个后台命令：结束打开着它输出文件的进程（就是那条命令和它的子进程），Claude 本身不受影响
async function stopTask({ sessionId, taskId, claudeId }) {
  const run = runs.get(sessionId);
  const conn = (run && run.conn) || remote;
  if (!run) throw new Error('这一轮已经结束，任务也随之结束了');
  const t = run.tasks.get(taskId);
  if (t && t.type === 'local_agent') throw new Error('派出的助手不能单独停止，可以停止整轮回复');
  if (conn.isWindows()) throw new Error('Windows 电脑上暂不支持单独停止后台命令，可以停止整轮回复');
  const f = await taskFile(run.claudeSid || claudeId, taskId, t && t.outputFile, conn);
  const script = [
    `f=${shQuote(f)}; me=$$; keep=${Number(run.pid) || 0}`,
    `if [ -d /proc/self/fd ]; then pids=$(for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null | grep -qF -- "$f" && echo "\${p#/proc/}"; done); else pids=$(lsof -t -- "$f" 2>/dev/null); fi`,
    `pids=$(echo "$pids" | grep -vx -e "$me" -e "$keep" -e '' | tr '\\n' ' ')`,
    `[ -z "$pids" ] && { echo NONE; exit 0; }`,
    `kids=$(for p in $pids; do pgrep -P "$p" 2>/dev/null; done | tr '\\n' ' ')`,
    `kill -TERM $pids $kids 2>/dev/null; sleep 1; kill -KILL $pids $kids 2>/dev/null`,
    `printf '\\n[这个后台命令已被用户在 Claude 远程助手里手动停止]\\n' >> "$f"; echo "KILLED $pids"`,
  ].join('\n');
  const r = await conn.exec(script);
  if (/NONE/.test(r.out)) return { already: true };
  return { killed: true };
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => {
  const data = loadData();
  remote.configure(data.settings);
  return data;
});
ipcMain.handle('data:save', (_e, data) => { saveData(data); });
// 远程控制开着时：不让系统自动睡眠、不让 macOS 把软件挂起（屏幕照样会关）——睡着了手机就连不上这台电脑
let awakeId = null;
ipcMain.on('power:keep-awake', (_e, on) => {
  if (on && awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && awakeId != null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
});
// 睡醒 / 解锁：告诉界面马上重连手机（睡眠时连接已经断了，不等心跳超时）
app.whenReady().then(() => {
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => send('power:wake'));
});

ipcMain.on('data:save-sync', (e, data) => {
  try { saveData(data, true); } catch (err) { console.error('关窗口时存盘失败', err.message); }
  e.returnValue = true;
});

ipcMain.handle('settings:apply', (_e, settings) => {
  remote.configure({ ...DEFAULT_SETTINGS, ...settings });
  remote.home = null;
  return true;
});

ipcMain.handle('ssh:connect', async () => {
  try {
    await remote.ensure();
    const wd = await workdirAbs();
    await remote.mkdirp(wd);
    return { ok: true, workdir: wd, home: await remote.homeDir(), os: remote.host ? remote.host.os : '' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('claude:run', async (_e, args) => {
  try {
    await runClaude(args);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
ipcMain.handle('claude:stop', (_e, sessionId) => stopClaude(sessionId));
// 这一轮的主回复已经结束、后台任务还在跑：新消息直接写进正在运行的 Claude，马上开始新的一轮（后台任务不受影响）
// （wrap 在后面才定义，这里不能用）
ipcMain.handle('claude:input', (_e, { sessionId, prompt }) => {
  const run = runs.get(sessionId);
  if (!run || !run.interactive || run.inputClosed || run.stopped) return { ok: false, message: '这一轮已经结束' };
  run.write({ type: 'user', message: { role: 'user', content: String(prompt) } });
  return { ok: true };
});

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

// server：传到指定的那台服务器（手机远程发图时，对话可能不在电脑当前选中的服务器上）
ipcMain.handle('files:upload', async (_e, { uploadId, localPath, server }) => {
  try {
    const conn = server ? getConn({ ...remote.settings, ...server }) : remoteImpl;
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.posix.join(await workdirAbs(conn), 'uploads', day);
    const st = fs.statSync(localPath);
    if (st.isDirectory()) throw new Error('暂不支持上传文件夹，请先压缩成 zip 再拖进来');
    const size = st.size;
    const remotePath = await conn.upload(localPath, dir, (done, total) =>
      send('files:progress', { uploadId, done, total })
    );
    // 告诉 Claude 的路径用这台主机自己的写法（Windows 上是 C:/...）
    return { ok: true, remotePath, promptPath: conn.toShell(remotePath), size };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('files:list', async (_e, dir) => {
  try {
    const target = path.posix.normalize(await remote.resolve(dir || (await workdirAbs())));
    return { ok: true, dir: target, root: await workdirAbs(), home: await remote.homeDir(), items: await remote.list(target) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// 文件的创建时间（「添加时间」排序用）：SFTP 拿不到，在服务器上用 stat 读（Linux 是 %W，macOS 是 %B）；文件系统不记录的返回 0
// （这里在 wrap 定义之前，自己 try/catch）
ipcMain.handle('files:birth', async (_e, dir) => { try {
  const target = path.posix.normalize(await remote.resolve(dir));
  const r = await remote.exec(`cd ${shQuote(remote.toShell(target))} 2>/dev/null || exit 0; for f in * .[!.]*; do [ -e "$f" ] || continue; t=$(stat -c %W -- "$f" 2>/dev/null || stat -f %B -- "$f" 2>/dev/null); printf '%s\t%s\n' "\${t:-0}" "$f"; done`);
  const birth = {};
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('\t');
    if (i > 0) { const t = Number(line.slice(0, i)); if (t > 0) birth[line.slice(i + 1)] = t * 1000; }
  }
  return { ok: true, birth };
} catch (e) { return { ok: false, message: e.message }; } });
ipcMain.handle('files:download', async (_e, remotePath) => {
  remotePath = await remote.resolve(remotePath);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remotePath)),
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    await remote.download(remotePath, r.filePath);
    shell.showItemInFolder(r.filePath);
    return { ok: true, localPath: r.filePath };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// ---------- 配置向导 ----------
const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, ...((await fn(...args)) || {}) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
};
ipcMain.handle('claude:answer', wrap(answerAsk));
ipcMain.handle('claude:planAnswer', wrap(answerPlan));
ipcMain.handle('claude:permAnswer', wrap(answerPerm));
ipcMain.handle('claude:btw', wrap(askBtw));
ipcMain.handle('claude:btwStop', (_e, id) => { const ch = btws.get(id); if (ch) try { ch.close(); } catch (_) {} return true; });
ipcMain.handle('tasks:output', wrap(taskOutput));
ipcMain.handle('tasks:stop', wrap(stopTask));
ipcMain.handle('setup:run', wrap(async (input) => {
  const r = await setup.runSetup(input, (step, state, detail) => send('setup:log', { step, state, detail: detail || '' }));
  remote.configure({ ...remote.settings, ...r.settings });
  return r;
}));
// ---------- 本机模式 ----------
const LOCAL_SETTINGS = { mode: 'local', host: '', port: 22, user: '', keyPath: '', workdir: '~/workspace', proxy: '', bindDirect: false };
const localCli = new LocalHost(); // 专门给探测和配置用，不影响当前连接

async function localAuthStatus() {
  const r = await localCli.exec(`${setup.PATH_PREFIX}; [ -f ~/.claude-env ] && . ~/.claude-env; claude auth status 2>/dev/null`);
  try { const j = JSON.parse(r.out.slice(r.out.indexOf('{'))); return { loggedIn: !!j.loggedIn, email: j.email || '', plan: j.subscriptionType || '' }; } catch (_) { return { loggedIn: false }; }
}

// 这台电脑上有没有 Claude Code、登录了没有（配置向导第一页用来提示「直接用本机」）
ipcMain.handle('local:probe', wrap(async () => {
  const found = setup.parseFound((await localCli.exec(setup.FIND_CLAUDE)).out);
  if (!found) return { installed: false };
  return { installed: true, version: found.version, path: found.path, ...(await localAuthStatus()) };
}));

ipcMain.handle('setup:local', wrap(async ({ workdir }) => {
  const log = (step, state, detail) => send('setup:log', { step, state, detail: detail || '' });
  const step = async (name, fn) => {
    log(name, 'run');
    try { const d = await fn(); log(name, 'ok', typeof d === 'string' ? d : ''); return d; } catch (e) { log(name, 'fail', e.message); throw e; }
  };
  await step('检查 Claude Code', async () => {
    let f = setup.parseFound((await localCli.exec(setup.FIND_CLAUDE)).out);
    if (!f) {
      log('安装 Claude Code（约 1~2 分钟）', 'run');
      if (process.platform === 'win32') await localCli.execRaw('powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"');
      else await localCli.exec('curl -fsSL https://claude.ai/install.sh | bash');
      f = setup.parseFound((await localCli.exec(setup.FIND_CLAUDE)).out);
      log('安装 Claude Code（约 1~2 分钟）', f ? 'ok' : 'fail', f ? f.version : '');
      if (!f) throw new Error('Claude Code 安装失败，请检查网络能否访问 claude.ai');
    }
    // 版本最新的那个不在默认位置时，记进 ~/.claude-env，之后的命令优先用它
    const dir = path.posix.dirname(f.path);
    if (process.platform !== 'win32') await localCli.exec(setup.usePathCmd(dir === `${f.home}/.local/bin` ? null : dir));
    return `${f.version}（${f.path}）`;
  });
  const wd = workdir || '~/workspace';
  await step('准备工作文件夹', async () => { const p = await localCli.resolve(wd); await localCli.mkdirp(p); return p; });
  const st = await step('检查 Claude 登录状态', async () => {
    const a = await localAuthStatus();
    return a.loggedIn ? `已登录${a.email ? '（' + a.email + '）' : ''}` : '还没登录';
  });
  const settings = { ...LOCAL_SETTINGS, workdir: wd };
  remote.configure({ ...remote.settings, ...settings });
  return { settings, needsAuth: !/^已登录/.test(st), local: true };
}));

// 本机还没登录：打开终端运行 claude，让用户按正常方式登录一次（登录信息存进系统，本机模式直接能用）
ipcMain.handle('local:openLogin', wrap(async () => {
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script "claude"']);
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', 'claude'], { detached: true, windowsHide: false });
  } else {
    throw new Error('请打开终端，输入 claude 回车，按提示登录一次');
  }
  return {};
}));
ipcMain.handle('local:authCheck', wrap(async () => localAuthStatus()));

ipcMain.handle('setup:authStart', wrap(async () => {
  if (remote.settings && remote.settings.mode === 'local') throw new Error('本机请用「打开终端登录」');
  return { url: await setup.startAuth(remote.settings) };
}));
ipcMain.handle('setup:authCode', wrap((code) => setup.submitCode(remote.settings, code)));
ipcMain.handle('setup:apiKey', wrap((key) => setup.saveApiKey(remote.settings, key)));
ipcMain.handle('setup:cancel', () => setup.cancelAuth());
ipcMain.handle('open:external', (_e, url) => {
  if (/^https:\/\//.test(url) && !SELFTEST) shell.openExternal(url);
});

// ---------- 上下文明细 / 订阅额度 ----------
// /context：读取会话但不写入（--no-session-persistence），不会在对话里多一条记录
ipcMain.handle('claude:context', wrap(async ({ claudeId, cwd }) => {
  if (!UUID_RE.test(claudeId || '')) throw new Error('这个对话还没有开始');
  const wd = validCwd(cwd) || (await workdirAbs());
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} -p --no-session-persistence --output-format json --resume ${shQuote(claudeId)}`, '/context');
  let j;
  try { j = setup.parseClaudeJson(r.out); } catch (_) { throw new Error((r.err || r.out || '读取失败').slice(-300)); }
  if (j.is_error) throw new Error(String(j.result || '读取失败').slice(0, 300));
  return { text: j.result || '' };
}));
// 起标题：Claude Code 无界面模式不会自动起标题，用 Haiku 根据第一轮内容起一个（不保存记录）
ipcMain.handle('claude:title', wrap(async ({ user, reply }) => {
  const wd = await workdirAbs();
  const prompt = `给下面这段对话起一个简短的中文标题（不超过 14 个字，不要标点和引号），只输出标题本身。\n\n用户：${String(user || '').slice(0, 600)}\n\n助手：${String(reply || '').slice(0, 600)}`;
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} -p --no-session-persistence --model haiku --output-format json`, prompt);
  let j;
  try { j = setup.parseClaudeJson(r.out); } catch (_) { throw new Error('起标题失败'); }
  const title = String(j.result || '').split('\n')[0].replace(/^["'“”《]+|["'“”》。.]+$/g, '').trim().slice(0, 30);
  if (j.is_error || !title) throw new Error('起标题失败');
  return { title };
}));
// 当前服务器上 Claude 用的是哪个账号（用 Claude 账号登录时有邮箱和套餐；长期令牌只知道是令牌）
ipcMain.handle('claude:account', wrap(async () => {
  const r = await remote.exec(`${CLAUDE} auth status 2>/dev/null`);
  let j = {};
  try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch (_) { /* 老版本没有 auth status */ }
  return { known: !!r.out.includes('{'), loggedIn: !!j.loggedIn, method: j.authMethod || '', email: j.email || '', plan: j.subscriptionType || '', org: j.orgName || '', os: remote.host ? remote.host.os : '' };
}));
// 额度：先读 Claude Code 自己的 /usage（无界面模式也能用，不调用模型、不花额度），
// 它的用量接口被限流或没给出额度时，才退回到用 Haiku 和 Fable 各发一个极小的请求、从 rate_limit_event 里读
ipcMain.handle('usage:refresh', wrap(async () => {
  const wd = await workdirAbs();
  const u = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} -p --no-session-persistence --output-format json /usage`);
  let text = '';
  try { text = String(setup.parseClaudeJson(u.out).result || ''); } catch (_) { /* 老版本 */ }
  const parsed = parseUsageText(text);
  if (Object.keys(parsed.windows).length) return { source: 'usage', ...parsed };
  return { source: 'probe', results: await probeUsage(wd), note: /rate limited/i.test(text) ? 'Claude Code 的用量接口暂时被限流' : '' };
}));

// 解析 /usage 的文字：
//   Current session: 6% used · resets Oct 14 at 6:59pm (Asia/Shanghai)
//   Current week (all models): 86% used · resets Oct 16 at 5:59am (Asia/Shanghai)
//   Current week (Fable): 92% used · …
// 窗口名和每条消息里 rate_limit_event 的一致（five_hour / seven_day / …），界面上合在一起显示
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function zonedEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    return guess - (wall - guess);
  } catch (_) {
    return new Date(y, mo, d, h, mi).getTime();
  }
}
function parseReset(str) {
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(str || '');
  if (!m) return null;
  const now = new Date();
  let h = Number(m[3]) % 12 + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const mi = Number(m[4] || 0);
  const tz = m[6] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let mo = m[1] ? MONTHS[m[1].toLowerCase()] : now.getMonth();
  let d = m[2] ? Number(m[2]) : now.getDate();
  if (mo == null) return null;
  let t = zonedEpoch(now.getFullYear(), mo, d, h, mi, tz);
  if (!m[1] && t < Date.now()) t += 86400000; // 只写了时间：已经过了就是明天
  if (t < Date.now() - 2 * 86400000) t = zonedEpoch(now.getFullYear() + 1, mo, d, h, mi, tz); // 跨年
  return Math.round(t / 1000);
}
function parseUsageText(text) {
  const windows = {};
  const detail = [];
  let inDetail = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const m = /^Current (session|week)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets?\s*(.+))?$/i.exec(line);
    if (m) {
      const scope = (m[2] || '').toLowerCase();
      const key = m[1].toLowerCase() === 'session' ? 'five_hour'
        : !scope || scope === 'all models' ? 'seven_day'
        : scope === 'fable' ? 'seven_day_overage_included'
        : 'seven_day_' + scope.replace(/[^a-z0-9]+/g, '_');
      windows[key] = { utilization: Number(m[3]) / 100, resetsAt: parseReset(m[4]), seenWith: scope === 'fable' ? 'fable' : null };
      continue;
    }
    if (/^What's contributing/i.test(line)) { inDetail = true; continue; }
    if (inDetail && line && !/^Approximate, based on/i.test(line)) detail.push(line);
  }
  return { windows, detail };
}

async function probeUsage(wd) {
  const one = (m) => `echo "##MODEL ${m}"; ${CLAUDE} -p --no-session-persistence --model ${m} --output-format stream-json --verbose <<'__CR_Q__'\n只回复 1\n__CR_Q__`;
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && { ${one('haiku')}\n${one('fable')}\n}`);
  const results = [];
  let model = null;
  for (const line of r.out.split('\n')) {
    const m = /^##MODEL (\w+)/.exec(line);
    if (m) { model = m[1]; continue; }
    if (!line.startsWith('{')) continue;
    try { const d = JSON.parse(line); if (d.type === 'rate_limit_event') results.push({ model, info: d.rate_limit_info }); } catch (_) {}
  }
  if (!results.length) throw new Error('没有拿到额度信息');
  return results;
}

// ---------- 服务器上的历史会话 ----------
ipcMain.handle('history:list', wrap(async (folder) => ({ items: await history.listSessions(remote, typeof folder === 'string' ? folder : '') })));
// 列表名字跟服务器同步：读这些会话在服务器上最新的手动改名（custom-title）和 Claude Code 自动标题（ai-title），只读含这两种记录的行
ipcMain.handle('history:titles', wrap(async (ids) => {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => UUID_RE.test(x)).slice(0, 300);
  if (!list.length) return { titles: {} };
  const script = `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"; for id in ${list.join(' ')}; do for f in "$d"/*/"$id".jsonl; do [ -f "$f" ] || continue; grep -h -E '"type":"(custom-title|ai-title)"' "$f" 2>/dev/null | tail -n 30 | sed "s/^/$id\t/"; break; done; done`;
  const r = await remote.exec(script);
  const titles = {};
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const id = line.slice(0, i);
    let j;
    try { j = JSON.parse(line.slice(i + 1)); } catch (_) { continue; }
    const t = (titles[id] = titles[id] || {});
    if (j.type === 'custom-title' && j.customTitle) t.custom = j.customTitle;
    if (j.type === 'ai-title' && j.aiTitle) t.ai = j.aiTitle;
  }
  return { titles };
}));
ipcMain.handle('history:load', wrap(async (sid) => history.loadSession(remote, sid)));
ipcMain.handle('history:folders', wrap(async () => ({ items: await history.listFolders(remote) })));

// ---------- 全局能力：MCP 服务器、Skill、Claude Code 插件 ----------
const PY_FRONTMATTER = String.raw`
def fm(t):
    # 读 Markdown 开头的 --- 元数据：支持 description: >- / | 这种多行写法，以及缩进的续行
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n?', t, re.S)
    if not m: return {}, t
    meta = {}; key = None; buf = []
    def done():
        if key is not None:
            v = ' '.join(x.strip() for x in buf if x.strip())
            meta[key] = v.strip().strip('"').strip("'")
    for line in m.group(1).splitlines():
        if line and not line[0].isspace() and ':' in line:
            done()
            k, v = line.split(':', 1); key = k.strip(); v = v.strip()
            buf = [] if re.match(r'^[|>][-+0-9]*$', v) else [v]
        elif key is not None:
            buf.append(line)
    done()
    return meta, t[m.end():]
`;
const CAPS_SCRIPT = String.raw`
import json, os, glob, re, sys
${PY_FRONTMATTER}
home = os.path.expanduser('~'); wd = sys.argv[1]
out = {'mcp': [], 'skills': [], 'plugins': []}
try: cj = json.load(open(os.path.join(home, '.claude.json')))
except Exception: cj = {}
for n, c in (cj.get('mcpServers') or {}).items(): out['mcp'].append({'name': n, 'scope': 'user', 'config': c})
for n, c in (((cj.get('projects') or {}).get(wd) or {}).get('mcpServers') or {}).items(): out['mcp'].append({'name': n, 'scope': 'local', 'config': c})
try:
    for n, c in (json.load(open(os.path.join(wd, '.mcp.json'))).get('mcpServers') or {}).items(): out['mcp'].append({'name': n, 'scope': 'project', 'config': c})
except Exception: pass
for p in sorted(glob.glob(os.path.join(home, '.claude', 'skills', '*', 'SKILL.md'))):
    meta, _ = fm(open(p, encoding='utf-8', errors='replace').read(20000))
    d = os.path.basename(os.path.dirname(p))
    out['skills'].append({'name': meta.get('name') or d, 'dir': d, 'description': meta.get('description', '')[:300]})
try:
    ip = json.load(open(os.path.join(home, '.claude', 'plugins', 'installed_plugins.json')))
    out['plugins'] = sorted((ip.get('plugins') or {}).keys())
except Exception: pass
print(json.dumps(out, ensure_ascii=False))
`;

// 点开一个 Skill / 插件看详情：Skill 给完整的 SKILL.md 和带的文件；插件给它带来的命令、Skill、子助手、钩子、MCP（只读）
const CAPS_DETAIL_SCRIPT = String.raw`
import json, os, glob, re, sys
${PY_FRONTMATTER}
home = os.path.expanduser('~'); kind = sys.argv[1]; name = sys.argv[2]
SKIP = {'.git', 'node_modules', '.in_use', '__pycache__', '.venv', 'venv'}
def files(root, limit=200):
    out = []
    for dp, dns, fns in os.walk(root):
        dns[:] = sorted(d for d in dns if d not in SKIP and not d.startswith('.') or d == '.claude-plugin')
        for f in sorted(fns):
            if f.startswith('.') and f != '.mcp.json': continue
            p = os.path.join(dp, f)
            try: out.append({'rel': os.path.relpath(p, root), 'size': os.path.getsize(p)})
            except Exception: pass
            if len(out) >= limit: return out
    return out
def read(p, n=200000):
    try: return open(p, encoding='utf-8', errors='replace').read(n)
    except Exception: return ''
def items(pattern, root, strip):
    out = []
    for p in sorted(glob.glob(os.path.join(root, pattern), recursive=True)):
        meta, _ = fm(read(p, 20000))
        out.append({'name': meta.get('name') or strip(os.path.relpath(p, root)), 'description': meta.get('description', '')[:400]})
    return out
res = {'kind': kind, 'name': name}
if kind == 'skill':
    d = os.path.join(home, '.claude', 'skills', name)
    meta, body = fm(read(os.path.join(d, 'SKILL.md')))
    res.update({'description': meta.get('description', ''), 'body': body, 'path': d, 'files': files(d)})
else:
    ip = json.load(open(os.path.join(home, '.claude', 'plugins', 'installed_plugins.json')))
    ent = (ip.get('plugins') or {}).get(name) or []
    ent = ent[0] if isinstance(ent, list) and ent else ent
    root = (ent or {}).get('installPath') or ''
    man = {}
    try: man = json.load(open(os.path.join(root, '.claude-plugin', 'plugin.json')))
    except Exception: pass
    # 有的插件把说明、语言服务等写在插件市场的总清单里（strict: false），补上插件自己没写的
    market = name.split('@', 1)[1] if '@' in name else ''
    try:
        mj = json.load(open(os.path.join(home, '.claude', 'plugins', 'marketplaces', market, '.claude-plugin', 'marketplace.json')))
        for e in mj.get('plugins') or []:
            if e.get('name') == name.split('@')[0]:
                for k, v in e.items():
                    if k not in man or not man[k]: man[k] = v
    except Exception: pass
    hooks = []
    try:
        hj = json.load(open(os.path.join(root, 'hooks', 'hooks.json')))
        hooks = sorted((hj.get('hooks') or {}).keys()) + ['代码模块 ' + os.path.basename(x) for x in (hj.get('modules') or [])]
    except Exception: pass
    if isinstance(man.get('hooks'), dict): hooks = sorted(set(hooks) | set(man['hooks'].keys()))
    mcp = []
    try: mcp = sorted((json.load(open(os.path.join(root, '.mcp.json'))).get('mcpServers') or {}).keys())
    except Exception: pass
    if isinstance(man.get('mcpServers'), dict): mcp = sorted(set(mcp) | set(man['mcpServers'].keys()))
    lsp = sorted(man['lspServers'].keys()) if isinstance(man.get('lspServers'), dict) else []
    author = man.get('author')
    res.update({
        'path': root, 'version': (ent or {}).get('version') or man.get('version') or '',
        'description': man.get('description') or '',
        'author': author.get('name') if isinstance(author, dict) else (author or ''),
        'homepage': man.get('homepage') or man.get('repository') or '',
        'commands': items('commands/**/*.md', root, lambda r: '/' + r[len('commands/'):-3].replace('/', ':')),
        'skills': items('skills/*/SKILL.md', root, lambda r: r.split('/')[1]),
        'agents': items('agents/*.md', root, lambda r: os.path.basename(r)[:-3]),
        'hooks': hooks, 'mcp': mcp, 'lsp': lsp,
        'options': [{'key': k, 'title': (v or {}).get('title') or k, 'description': (v or {}).get('description') or '', 'default': (v or {}).get('default')} for k, v in (man.get('userConfig') or {}).items() if isinstance(v, dict)][:40],
        'readme': read(os.path.join(root, 'README.md'), 30000),
        'files': files(root),
    })
print(json.dumps(res, ensure_ascii=False))
`;
ipcMain.handle('caps:detail', wrap(async ({ kind, name }) => {
  if (!['skill', 'plugin'].includes(kind) || !/^[\w.@:+-]{1,128}$/.test(String(name || ''))) throw new Error('参数不对');
  const r = await remote.exec(`${PY} - ${shQuote(kind)} ${shQuote(name)}`, CAPS_DETAIL_SCRIPT);
  if (r.code !== 0) throw new Error((r.err || '读取失败').slice(-300));
  return JSON.parse(r.out);
}));

async function globalCaps(c = remote) {
  const wd = await workdirAbs(c);
  const r = await c.exec(`${PY} - ${shQuote(c.toShell(wd))}`, CAPS_SCRIPT);
  if (r.code !== 0) throw new Error(/python3: command not found|not found|xcode-select|developer tools/i.test(r.err) ? '服务器上没有 python3，无法读取 MCP 和 Skill 列表（Mac 上可以运行 xcode-select --install 安装）' : (r.err || '读取失败').slice(-300));
  return JSON.parse(r.out);
}

const { PY } = require('./history');
const CLAUDE = `export PATH="$HOME/.local/bin:$PATH"; [ -f ~/.claude-env ] && . ~/.claude-env; claude`;
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

ipcMain.handle('caps:global', wrap(async () => globalCaps()));

// 每个模型的其他版本：用服务器上 Claude Code 自己的登录凭证问 Anthropic 的模型列表接口（只读，不调用模型）。
// 凭证只在服务器上用，不传回软件；返回每个版本的名字、所属系列、支持的思考强度、是否即将停用
const MODEL_LIST_SCRIPT = [
  '[ -f ~/.claude-env ] && . ~/.claude-env',
  'PY=$(command -v python3 || command -v python)',
  'if [ -n "$ANTHROPIC_API_KEY" ]; then AUTH="x-api-key: $ANTHROPIC_API_KEY"; BETA="anthropic-version: 2023-06-01"; else',
  '  T="$CLAUDE_CODE_OAUTH_TOKEN"',
  '  [ -z "$T" ] && [ -f ~/.claude/.credentials.json ] && T=$("$PY" -c \'import json,os;print(json.load(open(os.path.expanduser("~/.claude/.credentials.json")))["claudeAiOauth"]["accessToken"])\' 2>/dev/null)',
  '  [ -z "$T" ] && command -v security >/dev/null && T=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | "$PY" -c \'import sys,json;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])\' 2>/dev/null)',
  '  [ -z "$T" ] && { echo "NO_CREDENTIAL"; exit 0; }',
  '  AUTH="Authorization: Bearer $T"; BETA="anthropic-beta: oauth-2025-04-20"',
  'fi',
  'curl -s -m 20 "https://api.anthropic.com/v1/models?limit=100" -H "$AUTH" -H "anthropic-version: 2023-06-01" -H "$BETA"',
].join('\n');
ipcMain.handle('claude:modelVersions', wrap(async () => {
  const r = await remote.exec(MODEL_LIST_SCRIPT);
  if (/NO_CREDENTIAL/.test(r.out)) throw new Error('读不到这台服务器上 Claude 的登录凭证');
  let j;
  try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch (_) { throw new Error('模型列表接口没有返回有效数据'); }
  if (!Array.isArray(j.data)) throw new Error((j.error && j.error.message) || '模型列表接口返回了错误');
  const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  return {
    versions: j.data.map((m) => {
      const eff = (m.capabilities && m.capabilities.effort) || {};
      return {
        id: m.id,
        name: String(m.display_name || m.id).replace(/^Claude\s+/, ''),
        family: (/^claude-([a-z]+)-/.exec(m.id) || [])[1] || '',
        efforts: eff.supported ? LEVELS.filter((l) => eff[l] && eff[l].supported) : [],
        deprecated: !!(m.deprecated_at || m.retires_at),
        created: m.created_at || '',
      };
    }),
  };
}));

// 可选的模型和思考强度：向服务器上的 Claude Code 要（和 /model 里显示的是同一份），不在软件里写死。
// 走 Claude Code 给程序用的控制协议发一个 initialize，不调用模型、不耗额度
ipcMain.handle('claude:models', wrap(async () => {
  const req = JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n';
  const r = await remote.exec(`cd ~ && ${CLAUDE} -p --no-session-persistence --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio 2>/dev/null`, req);
  for (const line of r.out.split('\n')) {
    if (!line.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    const res = d.type === 'control_response' && d.response && d.response.response;
    if (res && Array.isArray(res.models)) {
      return {
        models: res.models.map((x) => ({ value: x.value, resolved: x.resolvedModel || '', name: x.displayName || x.value, description: x.description || '', efforts: x.supportsEffort ? x.supportedEffortLevels || [] : [] })),
        // 同一次初始化里顺便拿到：无界面模式下能用的斜杠命令（内置的 + Skill + 自定义命令），以及账号
        commands: (res.commands || []).filter((c) => c && c.name && !c.name.startsWith('__')).map((c) => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '' })),
        account: res.account || null,
      };
    }
  }
  throw new Error('这台服务器上的 Claude Code 没有返回模型列表（版本可能太旧）');
}));

// /status：版本、登录方式、账号（终端里的 /status 在无界面模式下不能用，这里自己拼）
ipcMain.handle('claude:status', wrap(async () => {
  const r = await remote.exec(`${CLAUDE} --version 2>/dev/null; echo "##AUTH"; ${CLAUDE} auth status 2>/dev/null`);
  const [ver, auth] = r.out.split('##AUTH');
  let a = {};
  try { a = JSON.parse(auth.slice(auth.indexOf('{'))); } catch (_) { /* 老版本 */ }
  return { version: (ver || '').trim().split('\n').pop(), auth: a, host: remote.host ? remote.host.os : '' };
}));
// 改名同步到服务器：和终端里 /rename 一样，往这个会话的记录文件末尾追加一行 custom-title（自动起的标题用 ai-title，手动改的优先）
ipcMain.handle('claude:rename', wrap(async ({ claudeId, title, auto, server }) => {
  if (!UUID_RE.test(claudeId || '')) throw new Error('会话编号不合法');
  const t = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!t) throw new Error('名称是空的');
  const line = JSON.stringify(auto ? { type: 'ai-title', aiTitle: t, sessionId: claudeId } : { type: 'custom-title', customTitle: t, sessionId: claudeId }) + '\n';
  const conn = server ? getConn({ ...remote.settings, ...server }) : remoteImpl;
  const r = await conn.exec(`f=$(ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${claudeId}.jsonl 2>/dev/null | head -1); [ -n "$f" ] || exit 3; cat >> "$f"`, line);
  if (r.code === 3) throw new Error('服务器上还没有这个会话的记录');
  if (r.code !== 0) throw new Error((r.err || '写入失败').slice(-200));
  return {};
}));
// /update：让服务器上的 Claude Code 升级到最新版
ipcMain.handle('claude:update', wrap(async () => {
  const r = await remote.exec(`${CLAUDE} update 2>&1`);
  return { out: r.out.trim().slice(-1500), code: r.code };
}));
// 附件缩略图（输入框上方、消息里的图片附件用）：小尺寸 JPEG data URL，存进对话里也不占地方
ipcMain.handle('app:thumb', async (_e, file) => {
  try {
    if (!/\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i.test(String(file || '')) || !fs.existsSync(file)) return '';
    const { nativeImage } = require('electron');
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty() && nativeImage.createThumbnailFromPath) img = await nativeImage.createThumbnailFromPath(file, { width: 160, height: 160 });
    if (img.isEmpty()) return '';
    const { width, height } = img.getSize();
    const k = Math.min(1, 160 / Math.max(width, height));
    return img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }).toJPEG(75).toString('base64').replace(/^/, 'data:image/jpeg;base64,');
  } catch (_) { return ''; }
});
// 粘贴 / 拖进来的内容没有本地路径（截图、网页或聊天软件里的图片）：先存成临时文件，再按普通文件上传
const pasteDir = () => path.join(app.getPath('temp'), 'claude-remote-paste');
ipcMain.handle('app:saveTemp', wrap(async ({ name, data }) => {
  const buf = Buffer.from(data || []);
  if (!buf.length) throw new Error('内容是空的');
  if (buf.length > 300 * 1024 * 1024) throw new Error('超过 300MB，请先存到本地再拖进来');
  const safe = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
  const dir = path.join(pasteDir(), Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, buf);
  return { path: file };
}));
app.on('will-quit', () => { try { fs.rmSync(pasteDir(), { recursive: true, force: true }); } catch (_) {} });

// /export：把对话存成 Markdown 文件（内容由界面拼好）
ipcMain.handle('app:saveText', wrap(async ({ name, text }) => {
  const r = await dialog.showSaveDialog(win, { title: '导出对话', defaultPath: path.join(app.getPath('downloads'), String(name || '对话').replace(/[\\/:*?"<>|]/g, '_') + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, String(text || ''), 'utf8');
  shell.showItemInFolder(r.filePath);
  return { path: r.filePath };
}));

// ---------- Claude Code 插件（/plugin）：用 Claude Code 自带的 claude plugin 命令管理 ----------
const PLUGIN_ID_RE = /^[\w.@:\/+-]{1,200}$/;
ipcMain.handle('cplugins:list', wrap(async ({ available } = {}) => {
  const r = await remote.exec(`${CLAUDE} plugin list --json${available ? ' --available' : ''} 2>&1`);
  const i = r.out.search(/[[{]/);
  let j = null;
  try { j = JSON.parse(r.out.slice(i)); } catch (_) { /* 老版本没有 --json */ }
  if (!j) throw new Error('读取插件列表失败（服务器上的 Claude Code 可能太旧，可以先更新）：' + r.out.slice(-200));
  const installed = Array.isArray(j) ? j : j.installed || [];
  return { installed, available: Array.isArray(j) ? null : j.available || [] };
}));
ipcMain.handle('cplugins:action', wrap(async ({ action, id, scope, projectPath }) => {
  if (!['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) throw new Error('不支持的操作');
  if (!PLUGIN_ID_RE.test(id || '')) throw new Error('插件名称不合法');
  const sc = ['user', 'project', 'local'].includes(scope) && action !== 'install' && action !== 'update' ? ` --scope ${scope}` : '';
  // 项目级插件要在那个项目目录里操作
  const cd = projectPath && scope !== 'user' ? `cd ${shQuote(remote.toShell(remote.toSftp(projectPath)))} && ` : '';
  const r = await remote.exec(`${cd}${CLAUDE} plugin ${action}${sc} ${shQuote(id)} 2>&1`);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '操作失败');
  return { out: r.out.trim().slice(-400) };
}));
ipcMain.handle('caps:mcpStatus', wrap(async () => {
  const wd = await workdirAbs();
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} mcp list 2>&1`);
  const status = {};
  for (const line of r.out.split('\n')) {
    // 形如 "name: 命令或地址 - ✔ Connected" / "- ✘ Failed to connect — 原因"（不同版本勾叉字符不同）
    const m = /^([A-Za-z0-9_-]+):\s.*\s-\s([✓✔✗✘!⚠])\s*(.*)$/u.exec(line.trim());
    if (m) status[m[1]] = { ok: /[✓✔]/.test(m[2]), text: m[3].split(/\s+[—-]\s+/)[0] };
  }
  return { status };
}));
ipcMain.handle('caps:mcpAdd', wrap(async (spec) => {
  if (!MCP_NAME_RE.test(spec.name || '')) throw new Error('名称只能用字母、数字、下划线和短横线');
  const parts = ['mcp', 'add', '-s', 'user'];
  if (spec.transport === 'http' || spec.transport === 'sse') {
    if (!/^https?:\/\//.test(spec.url || '')) throw new Error('请填写 http(s) 地址');
    parts.push('--transport', spec.transport);
    for (const [k, v] of Object.entries(spec.headers || {})) parts.push('--header', `${k}: ${v}`);
    parts.push(spec.name, spec.url);
  } else {
    if (!spec.command) throw new Error('请填写启动命令');
    for (const [k, v] of Object.entries(spec.env || {})) parts.push('-e', `${k}=${v}`);
    parts.push(spec.name, '--', spec.command, ...(spec.args || []));
  }
  const r = await remote.exec(`${CLAUDE} ${parts.map(shQuote).join(' ')} 2>&1`);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '添加失败');
}));
ipcMain.handle('caps:mcpRemove', wrap(async (name, scope) => {
  if (!MCP_NAME_RE.test(name || '')) throw new Error('名称不合法');
  const wd = await workdirAbs();
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} mcp remove -s ${shQuote(scope === 'local' || scope === 'project' ? scope : 'user')} ${shQuote(name)} 2>&1`);
  if (r.code !== 0) throw new Error(r.out.trim().slice(-400) || '删除失败');
}));
ipcMain.handle('caps:skillAdd', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 Skill 文件夹（里面有 SKILL.md）或单个 SKILL.md', properties: ['openDirectory', 'openFile'], filters: [{ name: 'Skill', extensions: ['md'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const src = r.filePaths[0];
  const home = await remote.homeDir();
  const base = path.posix.join(home, '.claude', 'skills');
  const st = fs.statSync(src);
  let name;
  if (st.isDirectory()) {
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('这个文件夹里没有 SKILL.md');
    name = path.basename(src);
  } else {
    const t = fs.readFileSync(src, 'utf8');
    const m = /^---\s*\n[\s\S]*?^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(t);
    name = m ? m[1].trim() : path.basename(src, path.extname(src));
  }
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw new Error('Skill 名称只能用字母、数字、下划线、点和短横线：' + name);
  const dest = path.posix.join(base, name);
  const upload = async (local, remoteDir) => {
    await remote.mkdirp(remoteDir);
    for (const ent of fs.readdirSync(local, { withFileTypes: true })) {
      if (ent.name === '.DS_Store') continue;
      const lp = path.join(local, ent.name);
      if (ent.isDirectory()) await upload(lp, path.posix.join(remoteDir, ent.name));
      else if (ent.isFile()) {
        const sftp = await remote.sftp();
        await new Promise((ok, no) => sftp.fastPut(lp, path.posix.join(remoteDir, ent.name), (e) => (e ? no(e) : ok())));
      }
    }
  };
  if (st.isDirectory()) await upload(src, dest);
  else {
    await remote.mkdirp(dest);
    const sftp = await remote.sftp();
    await new Promise((ok, no) => sftp.fastPut(src, path.posix.join(dest, 'SKILL.md'), (e) => (e ? no(e) : ok())));
  }
  return { name };
}));
ipcMain.handle('caps:skillRemove', wrap(async (dir) => {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(dir || '') || dir.startsWith('.')) throw new Error('名称不合法');
  const home = await remote.homeDir();
  await remote.remove(path.posix.join(home, '.claude', 'skills', dir));
}));

// ---------- 文件管理 ----------
// 改动文件只允许在用户目录（或工作文件夹）以内；用户目录和工作文件夹本身不能删
async function insideRoot(p) {
  const home = await remote.homeDir();
  const wd = await workdirAbs();
  const n = path.posix.normalize(remote.toSftp(String(p || '')));
  const inside = (r) => n === r || n.startsWith(r.replace(/\/$/, '') + '/');
  if (!n.startsWith('/') || !(inside(home) || inside(wd))) throw new Error('只能操作你的用户目录里的文件');
  return { root: n === home || n === wd ? n : null, n };
}
const uniqueLocal = (p) => {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; ; i++) if (!fs.existsSync(`${base}(${i})${ext}`)) return `${base}(${i})${ext}`;
};
const validName = (name) => {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || /[\/\\\0]/.test(n)) throw new Error('名称不能为空，也不能包含斜杠');
  return n;
};

ipcMain.handle('files:mkdir', wrap(async (dir, name) => {
  const { n } = await insideRoot(dir);
  await remote.mkdir(path.posix.join(n, validName(name)));
}));
ipcMain.handle('files:rename', wrap(async (p, name) => {
  const { n } = await insideRoot(p);
  await remote.rename(n, path.posix.join(path.posix.dirname(n), validName(name)));
}));
ipcMain.handle('files:delete', wrap(async (p) => {
  const { root, n } = await insideRoot(p);
  if (n === root) throw new Error('不能删除用户目录或工作文件夹本身');
  await remote.remove(n);
}));
ipcMain.handle('files:uploadTo', wrap(async ({ uploadId, localPath, dir }) => {
  const { n } = await insideRoot(dir);
  const st = fs.statSync(localPath);
  if (st.isDirectory()) throw new Error('暂不支持上传文件夹，请先压缩成 zip');
  const remotePath = await remote.upload(localPath, n, (done, total) => send('files:progress', { uploadId, done, total }));
  return { remotePath, size: st.size };
}));
ipcMain.handle('files:downloadDir', wrap(async (remoteDir) => {
  const { n } = await insideRoot(remoteDir);
  const r = await dialog.showOpenDialog(win, { title: '选择保存到哪个文件夹', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const target = uniqueLocal(path.join(r.filePaths[0], path.posix.basename(n)));
  const stat = await remote.downloadDir(n, target, (done, total, i, count) => send('files:dlprogress', { remoteDir: n, done, total, i, count }));
  shell.showItemInFolder(target);
  return { localPath: target, ...stat };
}));

// ---------- 预览 ----------
const cacheDir = () => path.join(app.getPath('userData'), 'preview-cache');
const PREVIEW_LIMIT = 300 * 1024 * 1024;

ipcMain.handle('preview:fetch', wrap(async (remotePath) => {
  remotePath = await remote.resolve(remotePath);
  const st = await remote.stat(remotePath);
  if (st.isDirectory()) throw new Error('这是一个文件夹');
  if (st.size > PREVIEW_LIMIT) throw new Error('文件超过 300MB，请下载后查看');
  const key = crypto.createHash('sha1').update(`${remote.settings.host || remote.settings.mode}|${remotePath}|${st.mtime}|${st.size}`).digest('hex').slice(0, 16);
  const dir = path.join(cacheDir(), key);
  const local = path.join(dir, path.posix.basename(remotePath));
  const cached = fs.existsSync(local) && fs.statSync(local).size === st.size;
  if (cached) {
    // 记下最近一次使用，清理时按这个时间淘汰
    try { fs.utimesSync(dir, new Date(), new Date()); } catch (_) {}
  } else {
    fs.mkdirSync(dir, { recursive: true });
    // 先下到临时文件，下完再改名，中途失败不会留下半截缓存；进度最多每 150ms 报一次
    const part = local + '.part';
    let last = 0;
    send('preview:progress', { remotePath, done: 0, total: st.size });
    await remote.download(remotePath, part, (done, total) => {
      const now = Date.now();
      if (now - last < 150 && done < total) return;
      last = now;
      send('preview:progress', { remotePath, done, total });
    });
    fs.renameSync(part, local);
  }
  const page = /\.html?$/i.test(local) ? `crpage://${key}/${encodeURIComponent(path.basename(local))}` : null;
  return { localPath: local, url: pathToFileURL(local).href, page, size: st.size, cached };
}));
ipcMain.handle('preview:read', wrap(async (localPath) => {
  const p = path.resolve(localPath);
  if (!p.startsWith(cacheDir() + path.sep)) throw new Error('非法路径');
  const buf = await fs.promises.readFile(p);
  return { data: buf };
}));
// 预览缓存：只在预览打开期间保留（切标签不用重新下载），关掉那个预览就删；启动和退出软件时整个清空
function cleanPreviewCache() {
  try { fs.rmSync(cacheDir(), { recursive: true, force: true }); } catch (_) {}
}
ipcMain.handle('preview:drop', (_e, localPath) => {
  const p = path.resolve(String(localPath || ''));
  if (!p.startsWith(cacheDir() + path.sep)) return false;
  try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch (_) {}
  return true;
});

// ---------- 插件 ----------
ipcMain.handle('plugins:list', wrap(async () => ({ items: plugins.list() })));
// 拓展功能的来源：始终有开发者的官方仓库；设置里勾了「自定义仓库」时，那个仓库是额外的来源（不是替换）
const OFFICIAL_REPO = DEFAULT_SETTINGS.pluginRepo;
function pluginRepos() {
  const st = remote.settings || {};
  const custom = String(st.customRepo || '').trim().replace(/\/+$/, '');
  const list = [OFFICIAL_REPO];
  if (st.customRepoOn && /^[\w.-]+\/[\w.-]+$/.test(custom) && custom.toLowerCase() !== OFFICIAL_REPO.toLowerCase()) list.push(custom);
  return list;
}
const verNum = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0);
const verGt = (a, b) => { const x = verNum(a); const y = verNum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
// 拓展功能页里改了自定义仓库：只更新这一项，不重新配置连接（不会断开服务器）
ipcMain.handle('plugins:setSource', (_e, { on, repo } = {}) => {
  if (remote.settings) { remote.settings.customRepoOn = !!on; remote.settings.customRepo = String(repo || '').trim(); }
  return true;
});
ipcMain.handle('plugins:store', wrap(async () => {
  const repos = pluginRepos();
  const got = await Promise.all(repos.map((r) => plugins.fetchStore(r).then((items) => ({ r, items }), (e) => ({ r, error: e.message }))));
  const byId = new Map();
  for (const g of got) {
    for (const it of g.items || []) {
      const prev = byId.get(it.id);
      // 两个仓库里有同一个拓展：用版本新的，一样新就用官方的
      if (!prev || verGt(it.version, prev.version)) byId.set(it.id, { ...it, source: g.r, official: g.r === OFFICIAL_REPO });
    }
  }
  const errors = got.filter((g) => g.error).map((g) => `${g.r === OFFICIAL_REPO ? '官方仓库' : g.r}：${g.error}`);
  if (!byId.size && errors.length) throw new Error(errors.join('；'));
  return { items: [...byId.values()], errors };
}));
ipcMain.handle('plugins:install', wrap(async (item) => {
  const source = item && pluginRepos().includes(item.source) ? item.source : OFFICIAL_REPO;
  return plugins.install(source, item, (p) => send('plugins:progress', { id: item.id, ...p }));
}));
ipcMain.handle('plugins:uninstall', wrap(async (id) => plugins.uninstall(id)));

// ---------- 软件更新 ----------
const REPO = String(require('../package.json').repository || '').replace(/^github:/, '');
// 版本号比较：x.y.z 先比；同一个 x.y.z 时，带「-test.…」的测试版比正式版旧（正式版一发布，测试版就会提示更新）
const parseVer = (v) => {
  const m = String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : { n: [0, 0, 0], pre: '' };
};
const cmpVer = (a, b) => {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] > pb.n[i] ? 1 : -1;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, 'en', { numeric: true }) > 0 ? 1 : -1;
};
// 版本号读自己这份代码里的 package.json（快速更新后代码不在安装目录里，app.getVersion() 还是安装包的版本）
const OWN_VERSION = require('../package.json').version;
const currentVersion = () => (DEV && process.env.CR_FAKE_VERSION) || OWN_VERSION;
// 更新逻辑见 updater.js：能快速更新时只下载几 MB 的程序代码，两个平台都在软件里自动下载、重启安装
// autoDownload：设置里的「自动下载更新」（默认开）；关掉后只提示有新版本，点了才下载
// Webhook 通知（飞书 / 通用 JSON），由界面在回复完成、出错、需要处理时调用
ipcMain.handle('notify:send', wrap(async ({ cfg, event }) => ({ sent: await sendWebhook(cfg || {}, event || {}) })));
// 未读的「刚完成」对话数：显示在 macOS 程序坞图标上
ipcMain.on('app:badge', (_e, n) => { try { app.setBadgeCount(Math.max(0, Number(n) || 0)); } catch (_) {} });
// 需要你做选择而软件不在前台：Mac 程序坞图标跳一下，Windows 任务栏按钮闪烁（回到软件就停）
quick.init({ send: (ch, p) => send(ch, p), getWin: () => { if (!win || win.isDestroyed()) createWindow(); return win; }, posFile: path.join(app.getPath('userData'), 'quick-pos.json') });

// 系统通知（Windows 右下角、macOS 右上角）：点一下回到软件并打开那个对话
const shownNotifs = new Set(); // 留着引用，不然通知还没点就被回收，点了没反应
ipcMain.on('notify:system', (_e, { title, body, sid }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Claude 远程助手').slice(0, 120), body: String(body || '').slice(0, 300) });
  shownNotifs.add(n);
  const drop = () => shownNotifs.delete(n);
  n.on('click', () => {
    drop();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (sid) send('notify:open', sid);
  });
  n.on('close', drop);
  setTimeout(drop, 10 * 60 * 1000);
  n.show();
});

ipcMain.on('app:attention', () => {
  try {
    if (!win || win.isDestroyed() || win.isFocused()) return;
    if (process.platform === 'darwin') app.dock.bounce('informational');
    else { win.flashFrame(true); win.once('focus', () => win.flashFrame(false)); }
  } catch (_) {}
});
// 美元兑人民币实时汇率（用量统计里折算人民币用）：两个免费公开接口，前一个不通换后一个
ipcMain.handle('fx:usdcny', wrap(async () => {
  const tries = [
    async () => { const j = await (await net.fetch('https://open.er-api.com/v6/latest/USD')).json(); return { rate: j.rates && j.rates.CNY, date: j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10) : '' }; },
    async () => { const j = await (await net.fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY')).json(); return { rate: j.rates && j.rates.CNY, date: j.date || '' }; },
  ];
  for (const t of tries) {
    try { const r = await t(); if (r.rate > 1 && r.rate < 20) return r; } catch (_) { /* 换下一个 */ }
  }
  throw new Error('取不到汇率');
}));
// ---------- 公司 VPN ----------
vpn.setNotifier((e) => send('vpn:state', e));
app.whenReady().then(() => setTimeout(() => vpn.syncBin(REPO), 5000));
ipcMain.handle('vpn:available', () => vpn.available());
ipcMain.handle('vpn:encrypt', (_e, pw) => vpn.encrypt(pw));
ipcMain.handle('vpn:probe', wrap(async (a) => vpn.probe(a || {})));
// 测试：拨号，成功就保持连着（马上要用）
ipcMain.handle('vpn:test', wrap(async (v) => { const socks = await vpn.ensure(v); const st = vpn.list().find((x) => x.key === vpn.keyOf(v)); return { socks, ip: st ? st.ip : '' }; }));
ipcMain.handle('vpn:answer', wrap(async ({ key, text }) => { vpn.answer(key, text); return {}; }));
ipcMain.handle('vpn:disconnect', (_e, key) => { if (key) vpn.stop(key); else vpn.stopAll(); return true; });
ipcMain.handle('vpn:list', () => vpn.list());
// 触控板震感（只有 macOS；渲染进程按设置决定要不要发）
ipcMain.on('haptic', (_e, kind) => haptic(kind));
const appUpdater = require('./updater').createUpdater({ repo: REPO, send: (ch, p) => send(ch, p), currentVersion, cmpVer, autoDownload: () => !(remote.settings && remote.settings.autoUpdate === false) });
const checkForUpdates = (manual) => (/^[\w.-]+\/[\w.-]+$/.test(REPO) ? appUpdater.check(manual) : null);
ipcMain.handle('update:check', () => checkForUpdates(true));
// 重启安装更新的有些路径不走正常退出流程：先等后台存盘写完
ipcMain.handle('update:install', async () => { await writeQueue.flushAll(); quitting = true; return appUpdater.install(); });
ipcMain.handle('app:version', () => currentVersion());
ipcMain.handle('app:localUser', () => os.userInfo().username);

// 打开预览时窗口向外加宽（不挤压对话），关闭预览时恢复原来的大小和位置
let preExpandBounds = null;
ipcMain.handle('win:expand', (_e, px) => {
  if (!win || win.isMaximized() || win.isFullScreen()) return { added: 0 };
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width + Math.ceil(Number(px) || 0), wa.width);
  const added = width - b.width;
  if (added <= 0) return { added: 0 };
  if (!preExpandBounds) preExpandBounds = b;
  // 右边放不下就整体往左挪
  const x = b.x + width > wa.x + wa.width ? Math.max(wa.x, wa.x + wa.width - width) : b.x;
  win.setBounds({ x, y: b.y, width, height: b.height }, true);
  return { added };
});
ipcMain.handle('win:restore', () => {
  if (preExpandBounds && win && !win.isMaximized() && !win.isFullScreen()) win.setBounds(preExpandBounds, true);
  preExpandBounds = null;
});

ipcMain.handle('files:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  // macOS 需要应用菜单，否则 ⌘C/⌘V 等快捷键不可用
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: '关于 Claude 远程助手' },
          { label: '检查更新…', click: () => checkForUpdates(true) },
          { type: 'separator' },
          { label: '设置…', accelerator: 'Cmd+,', click: () => send('menu:settings') },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  }
  plugins = new PluginManager(path.join(app.getPath('userData'), 'plugins'));
  pluginProtocol.handleProtocol([plugins.dir]);
  pluginProtocol.handlePageProtocol(cacheDir);
  cleanPreviewCache();
  createWindow();
  if (!SELFTEST && (app.isPackaged || process.env.CR_FAKE_VERSION)) {
    setTimeout(() => checkForUpdates(false), 8000);
    setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  }
});
// macOS 点程序坞图标：主窗口不在了就重新开一个，在就拿到前面来
app.on('activate', () => showMain());
app.on('window-all-closed', () => {
  for (const id of runs.keys()) stopClaude(id);
  setTimeout(() => app.quit(), 300);
});
// 退出时清掉预览缓存（启动时也会清一次，防止上次异常退出留下）
app.on('will-quit', () => { quick.dispose(); cleanPreviewCache(); stopHaptic(); vpn.stopAll(); });
// 退出时后台还有没写完的存盘：先拦住，写完再退
app.on('will-quit', (e) => {
  if (!writeQueue.busy) return;
  e.preventDefault();
  writeQueue.flushAll().finally(() => app.quit());
});
