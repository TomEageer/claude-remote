const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, screen } = require('electron');
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

pluginProtocol.registerSchemePrivileges();
let plugins;

// 当前连接：远程服务器走 SSH（ssh.js），「本机」直接起本地进程（localhost.js）；两者接口一致，按设置里的 mode 切换
const sshRemote = new Remote();
const localHost = new LocalHost();
let remoteImpl = sshRemote;
const remote = new Proxy({}, {
  get(_, k) {
    if (k === 'configure') {
      return (s) => {
        const next = s && s.mode === 'local' ? localHost : sshRemote;
        if (next !== remoteImpl) remoteImpl.disconnect();
        remoteImpl = next;
        remoteImpl.configure(s);
      };
    }
    if (k === 'on') return (ev, fn) => { sshRemote.on(ev, fn); localHost.on(ev, fn); };
    const v = remoteImpl[k];
    return typeof v === 'function' ? v.bind(remoteImpl) : v;
  },
  set(_, k, v) { remoteImpl[k] = v; return true; },
});
// 自测入口只在开发环境生效，打包后的正式版不读这些环境变量
const DEV = !app.isPackaged;
const SELFTEST = DEV ? process.env.CR_SELFTEST : null;
if (DEV && process.env.CR_USERDATA) app.setPath('userData', process.env.CR_USERDATA);
const runs = new Map(); // sessionId -> { stream, pid, stopped }
let win;

const DEFAULT_PROMPT = [
  '你正在通过一个图形界面的聊天客户端为用户服务，用户很可能不懂编程，也看不到命令行。',
  '请用通俗的中文回答，少用术语。',
  '需要交付给用户的文件（文档、表格、PPT、图片等）请保存在当前工作目录里，客户端会在每轮回复末尾自动列出本轮新生成的文件并提供下载按钮，所以不用教用户怎么用命令行取文件。',
  '临时脚本请放在 tools/ 子目录，不要和交付文件混在一起。',
].join('\n');

const DEFAULT_SETTINGS = {
  mode: '', // 'local' = 本机（不经过 SSH）
  host: '',
  port: 22,
  user: '',
  keyPath: setup.APP_KEY,
  workdir: '~/workspace',
  proxy: '',
  bindDirect: false,
  pluginRepo: 'TomEageer/claude-remote-plugins',
  model: '',
  appendPrompt: DEFAULT_PROMPT,
};

// ---------- 本地存储 ----------
const dataFile = () => path.join(app.getPath('userData'), 'data.json');

function loadData() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (_) {}
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data.groups = data.groups || [];
  data.sessions = data.sessions || [];
  return data;
}

function saveData(data) {
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
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

async function workdirAbs() {
  return remote.resolve(remote.settings.workdir || '~/workspace');
}

// 对话的工作目录：可能是 /home/x、C:\Users\x 或 /C:/Users/x，统一成 SFTP 写法
function validCwd(cwd) {
  if (!cwd) return null;
  const p = remote.toSftp(String(cwd));
  return /^\/[^\0\n]*$/.test(p) ? p : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_RE = /^[A-Za-z0-9:_.-]{1,80}$/;

// sessionId 是本地会话 id（事件按它分发）；claudeId 是服务器上 Claude Code 的会话 id。
// fork = { from, at }：从会话 from 的消息 at 处分出新会话（回退 / 分支）。
// caps = { mcpOff: [名称], skillsOff: [名称] }：这个会话里关掉的 MCP 和 Skill。
async function runClaude({ sessionId, claudeId, isNew, fork, prompt, model, caps, cwd }) {
  if (runs.has(sessionId)) throw new Error('这个对话正在回复中');
  // 从服务器导入的会话要在它原来的目录里继续（Claude Code 按目录保存会话）
  const wd = validCwd(cwd) || (await workdirAbs());
  const cid = claudeId || sessionId;
  if (!UUID_RE.test(cid)) throw new Error('会话编号不合法');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
  ];
  if (fork && UUID_RE.test(fork.from) && UUID_RE.test(fork.at)) args.push('--resume', fork.from, '--resume-session-at', fork.at, '--fork-session');
  else args.push(isNew ? '--session-id' : '--resume', cid);
  if (model && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
  const mcpOff = (caps && caps.mcpOff) || [];
  const skillsOff = ((caps && caps.skillsOff) || []).filter((x) => SKILL_RE.test(x));
  if (mcpOff.length) {
    const g = await globalCaps().catch(() => null);
    const servers = {};
    for (const m of (g && g.mcp) || []) if (!mcpOff.includes(m.name)) servers[m.name] = m.config;
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers }));
  }
  if (skillsOff.length) args.push('--disallowedTools', skillsOff.map((x) => `Skill(${x})`).join(' '));
  const extra = remote.settings.appendPrompt;
  if (extra && extra.trim()) args.push('--append-system-prompt', extra.trim());
  // 交互模式：消息走 JSON 输入，权限请求走标准输入输出，Claude 才能用「向你提问」工具（AskUserQuestion）
  // 弹出可点击的选项。Windows 主机的命令要整段从标准输入喂给 Git Bash，没法边跑边写，仍用普通模式
  await remote.ensure();
  const interactive = !remote.isWindows();
  if (interactive) args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  const cmd = [
    `mkdir -p ${shQuote(remote.toShell(wd))} && cd ${shQuote(remote.toShell(wd))}`,
    // ~/.claude-env 放后面：里面可能指定了已有的 Claude Code（如 Homebrew 装的），要优先于 ~/.local/bin
    `export PATH="$HOME/.local/bin:$PATH"`,
    `[ -f ~/.claude-env ] && . ~/.claude-env`,
    // Windows（Git Bash）上要拿真正的 Windows 进程号，停止时用 taskkill 结束整个进程树
    `echo "__PID__$( [ -r /proc/$$/winpid ] && cat /proc/$$/winpid || echo $$ ) $(date +%s)"`,
    `exec claude ${args.map(shQuote).join(' ')}`,
  ].join('; ');

  const input = interactive ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n' : prompt;
  const stream = await remote.execStream(cmd, input, interactive);
  const run = { stream, pid: null, startedAt: null, stopped: false, claudeSid: null, tasks: new Map(), asks: new Map(), interactive, inputClosed: !interactive };
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
        if (st && !/^(running|pending|started)$/i.test(st)) t.running = false;
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
      } else if (r.subtype === 'can_use_tool') {
        run.write({ type: 'control_response', response: { subtype: 'success', request_id: d.request_id, response: { behavior: 'allow', updatedInput: r.input || {} } } });
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
        tools: (d.tools || []).length,
      });
    } else if (d.type === 'rate_limit_event' && d.rate_limit_info) {
      emit({ type: 'ratelimit', info: d.rate_limit_info });
    } else if (d.type === 'system' && d.subtype === 'status') {
      emit({ type: 'status', status: d.status || null });
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      emit({ type: 'compacted' });
    } else if (d.type === 'stream_event') {
      const e = d.event || {};
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        emit({ type: 'text', text: e.delta.text });
      } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'thinking') {
        emit({ type: 'thinking' });
      } else if (e.type === 'message_start') {
        emit({ type: 'msgstart' });
      }
    } else if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
      if (d.uuid) emit({ type: 'anchor', uuid: d.uuid });
      for (const c of d.message.content) {
        if (c.type === 'tool_use') emit({ type: 'tool', id: c.id, name: c.name, input: c.input });
      }
    } else if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
      for (const c of d.message.content) {
        if (c.type === 'tool_result') {
          emit({ type: 'tool_result', id: c.tool_use_id, isError: !!c.is_error, preview: previewOf(c.content) });
        }
      }
    } else if (d.type === 'result') {
      gotResult = true;
      run.maybeCloseInput();
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
        text: isError ? explainResultError(raw) : raw,
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
      const files = await changedFiles(wd, run.startedAt).catch(() => []);
      if (files.length) emit({ type: 'files', files });
    }
    runs.delete(sessionId);
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
async function changedFiles(wd, since) {
  const mins = Math.max(1, Math.ceil((Date.now() / 1000 - since) / 60) + 1);
  const prune = `-not -path '*/.*' -not -path './uploads/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/venv/*' -not -path '*/site-packages/*'`;
  const gnu = `find . -maxdepth 6 -type f -mmin -${mins} ${prune} -printf '%T@\\t%s\\t%P\\n'`;
  const bsd = `find . -maxdepth 6 -type f -mmin -${mins} ${prune} -exec stat -f '%m%t%z%t%N' {} +`;
  const cmd = `cd ${shQuote(remote.toShell(wd))} && if find --version >/dev/null 2>&1; then ${gnu}; else ${bsd}; fi 2>/dev/null | sort -rn | head -n 400`;
  const r = await remote.exec(cmd);
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [mtime, size, rel0] = line.split('\t');
    const rel = String(rel0 || '').replace(/^\.\//, '');
    return { rel, path: path.posix.join(wd, rel), size: Number(size), mtime: Number(mtime) * 1000 };
  }).filter((f) => f.rel && f.mtime >= (since - 1) * 1000).sort((a, b) => b.mtime - a.mtime);
}

function previewOf(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return text.length > 1500 ? text.slice(0, 1500) + '\n…' : text;
}

// Claude 一轮以错误结束时给出的原文（英文）→ 用户能看懂的说明
const MAC_KEYCHAIN_TIP = '这台 Mac 上的 Claude 读不到你的登录信息：Claude Code 把登录信息存在 macOS 的钥匙串里，而通过 SSH 远程进来的会话没有权限读取钥匙串，所以即使你在这台 Mac 的终端里已经登录，这里也算没登录。点「登录 Claude」在这里单独授权一次就好：会生成一个长期令牌，只保存在这台 Mac 的 ~/.claude-env 里，不影响你在终端里用的 Claude。';
function explainResultError(text) {
  if (/Not logged in|Please run \/login/i.test(text)) {
    if (remote.isLocal) return '这台电脑上的 Claude 还没有登录。点「登录 Claude」，在打开的终端里按提示登录一次就好。';
    return remote.host && remote.host.os === 'darwin' ? MAC_KEYCHAIN_TIP : '这台服务器上的 Claude 还没有登录。点「登录 Claude」授权一次就好。';
  }
  if (/OAuth token (has )?expired|authentication_error|Invalid API key|invalid x-api-key|401/i.test(text)) {
    return 'Claude 登录已失效，点「登录 Claude」重新授权。\n\n' + text.slice(0, 300);
  }
  return text;
}

function explainFailure(stderr, code) {
  const s = stderr.trim();
  if (/command not found|claude: not found/i.test(s)) return '服务器上没有安装 Claude，请联系管理员';
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
    if (remote.isWindows()) await remote.execRaw(`taskkill /T /F /PID ${Number(run.pid)}`).catch(() => {});
    else await remote.exec(`kill -INT ${run.pid} 2>/dev/null; sleep 2; kill -TERM ${run.pid} 2>/dev/null; true`).catch(() => {});
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

// ---------- 后台任务 ----------
// Claude Code 把后台任务的输出写在 <临时目录>/claude-<uid>/<目录>/<会话>/tasks/<任务>.output
const TASK_RE = /^[A-Za-z0-9_-]{4,64}$/;
async function taskFile(claudeSid, taskId, known) {
  if (!TASK_RE.test(taskId || '')) throw new Error('任务编号不合法');
  if (known && /^\/[^\0\n]*\/tasks\/[A-Za-z0-9_-]+\.output$/.test(known)) return known;
  if (!UUID_RE.test(claudeSid || '')) throw new Error('找不到这个任务的输出');
  const tail = `${claudeSid}/tasks/${taskId}.output`;
  const r = await remote.exec(`for f in "\${TMPDIR:-/tmp}"/claude*/*/${tail} /tmp/claude*/*/${tail} "\${TEMP:-/nonexistent}"/claude*/*/${tail}; do [ -f "$f" ] && { echo "$f"; break; }; done`);
  const f = r.out.trim().split('\n')[0];
  if (!f) throw new Error('找不到这个任务的输出（可能已被系统清理）');
  return f;
}

async function taskOutput({ sessionId, taskId, claudeId }) {
  const run = runs.get(sessionId);
  const t = run && run.tasks.get(taskId);
  const f = await taskFile((run && run.claudeSid) || claudeId, taskId, t && t.outputFile);
  const r = await remote.exec(`f=${shQuote(f)}; wc -c < "$f"; echo ---; tail -c 16000 -- "$f"`);
  const i = r.out.indexOf('---\n');
  return { size: Number(r.out.slice(0, i).trim()) || 0, text: i >= 0 ? r.out.slice(i + 4) : '' };
}

// 单独停止一个后台命令：结束打开着它输出文件的进程（就是那条命令和它的子进程），Claude 本身不受影响
async function stopTask({ sessionId, taskId, claudeId }) {
  const run = runs.get(sessionId);
  if (!run) throw new Error('这一轮已经结束，任务也随之结束了');
  const t = run.tasks.get(taskId);
  if (t && t.type === 'local_agent') throw new Error('派出的助手不能单独停止，可以停止整轮回复');
  if (remote.isWindows()) throw new Error('Windows 电脑上暂不支持单独停止后台命令，可以停止整轮回复');
  const f = await taskFile(run.claudeSid || claudeId, taskId, t && t.outputFile);
  const script = [
    `f=${shQuote(f)}; me=$$; keep=${Number(run.pid) || 0}`,
    `if [ -d /proc/self/fd ]; then pids=$(for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null | grep -qF -- "$f" && echo "\${p#/proc/}"; done); else pids=$(lsof -t -- "$f" 2>/dev/null); fi`,
    `pids=$(echo "$pids" | grep -vx -e "$me" -e "$keep" -e '' | tr '\\n' ' ')`,
    `[ -z "$pids" ] && { echo NONE; exit 0; }`,
    `kids=$(for p in $pids; do pgrep -P "$p" 2>/dev/null; done | tr '\\n' ' ')`,
    `kill -TERM $pids $kids 2>/dev/null; sleep 1; kill -KILL $pids $kids 2>/dev/null`,
    `printf '\\n[这个后台命令已被用户在 Claude 远程助手里手动停止]\\n' >> "$f"; echo "KILLED $pids"`,
  ].join('\n');
  const r = await remote.exec(script);
  if (/NONE/.test(r.out)) return { already: true };
  return { killed: true };
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => {
  const data = loadData();
  remote.configure(data.settings);
  return data;
});
ipcMain.handle('data:save', (_e, data) => saveData(data));

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

ipcMain.handle('files:upload', async (_e, { uploadId, localPath }) => {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.posix.join(await workdirAbs(), 'uploads', day);
    const st = fs.statSync(localPath);
    if (st.isDirectory()) throw new Error('暂不支持上传文件夹，请先压缩成 zip 再拖进来');
    const size = st.size;
    const remotePath = await remote.upload(localPath, dir, (done, total) =>
      send('files:progress', { uploadId, done, total })
    );
    // 告诉 Claude 的路径用这台主机自己的写法（Windows 上是 C:/...）
    return { ok: true, remotePath, promptPath: remote.toShell(remotePath), size };
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
  try { j = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) { throw new Error((r.err || r.out || '读取失败').slice(-300)); }
  if (j.is_error) throw new Error(String(j.result || '读取失败').slice(0, 300));
  return { text: j.result || '' };
}));
// 起标题：Claude Code 无界面模式不会自动起标题，用 Haiku 根据第一轮内容起一个（不保存记录）
ipcMain.handle('claude:title', wrap(async ({ user, reply }) => {
  const wd = await workdirAbs();
  const prompt = `给下面这段对话起一个简短的中文标题（不超过 14 个字，不要标点和引号），只输出标题本身。\n\n用户：${String(user || '').slice(0, 600)}\n\n助手：${String(reply || '').slice(0, 600)}`;
  const r = await remote.exec(`cd ${shQuote(remote.toShell(wd))} && ${CLAUDE} -p --no-session-persistence --model haiku --output-format json`, prompt);
  let j;
  try { j = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) { throw new Error('起标题失败'); }
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
// 额度：用 Haiku 和 Fable 各发一个极小的请求（不保存记录），从返回的 rate_limit_event 里读额度。
// Fable 相关的周额度窗口只在 Fable 请求里才会报告，所以两个都要发
ipcMain.handle('usage:refresh', wrap(async () => {
  const wd = await workdirAbs();
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
  return { results };
}));

// ---------- 服务器上的历史会话 ----------
ipcMain.handle('history:list', wrap(async () => ({ items: await history.listSessions(remote) })));
ipcMain.handle('history:load', wrap(async (sid) => history.loadSession(remote, sid)));
ipcMain.handle('history:folders', wrap(async () => ({ items: await history.listFolders(remote) })));

// ---------- 全局能力：MCP 服务器、Skill、Claude Code 插件 ----------
const CAPS_SCRIPT = String.raw`
import json, os, glob, re, sys
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
    t = open(p, encoding='utf-8', errors='replace').read(6000); meta = {}
    m = re.match(r'^---\s*\n(.*?)\n---', t, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ':' in line and not line.startswith(' '):
                k, v = line.split(':', 1); meta[k.strip()] = v.strip().strip('"').strip("'")
    d = os.path.basename(os.path.dirname(p))
    out['skills'].append({'name': meta.get('name') or d, 'dir': d, 'description': meta.get('description', '')[:300]})
try:
    ip = json.load(open(os.path.join(home, '.claude', 'plugins', 'installed_plugins.json')))
    out['plugins'] = sorted((ip.get('plugins') or {}).keys())
except Exception: pass
print(json.dumps(out, ensure_ascii=False))
`;

async function globalCaps() {
  const wd = await workdirAbs();
  const r = await remote.exec(`${PY} - ${shQuote(remote.toShell(wd))}`, CAPS_SCRIPT);
  if (r.code !== 0) throw new Error(/python3: command not found|not found|xcode-select|developer tools/i.test(r.err) ? '服务器上没有 python3，无法读取 MCP 和 Skill 列表（Mac 上可以运行 xcode-select --install 安装）' : (r.err || '读取失败').slice(-300));
  return JSON.parse(r.out);
}

const { PY } = require('./history');
const CLAUDE = `export PATH="$HOME/.local/bin:$PATH"; [ -f ~/.claude-env ] && . ~/.claude-env; claude`;
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

ipcMain.handle('caps:global', wrap(async () => globalCaps()));
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
    setTimeout(cleanPreviewCache, 1000);
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
// 预览缓存：小于 50MB 的文件保留 30 天（再次打开直接用本地的，服务器上文件改过会自动重新下载），
// 大文件只留 1 天；总量超过 1GB 时先删最久没用的
const CACHE_KEEP_SIZE = 50 * 1024 * 1024;
const CACHE_TOTAL = 1024 * 1024 * 1024;
function cleanPreviewCache() {
  try {
    const now = Date.now();
    const entries = [];
    for (const d of fs.readdirSync(cacheDir())) {
      const p = path.join(cacheDir(), d);
      const st = fs.statSync(p);
      let size = 0;
      if (st.isDirectory()) for (const f of fs.readdirSync(p)) size += fs.statSync(path.join(p, f)).size;
      const age = now - st.mtimeMs;
      if (age > 30 * 86400e3 || (size >= CACHE_KEEP_SIZE && age > 86400e3) || /\.part$/.test(fs.readdirSync(p).join('\n')) && age > 3600e3) {
        fs.rmSync(p, { recursive: true, force: true });
      } else entries.push({ p, size, used: st.mtimeMs });
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (total <= CACHE_TOTAL) break;
      fs.rmSync(e.p, { recursive: true, force: true });
      total -= e.size;
    }
  } catch (_) {}
}

// ---------- 插件 ----------
ipcMain.handle('plugins:list', wrap(async () => ({ items: plugins.list() })));
const pluginRepo = () => (remote.settings && remote.settings.pluginRepo) || DEFAULT_SETTINGS.pluginRepo;
ipcMain.handle('plugins:store', wrap(async (repo) => ({ items: await plugins.fetchStore(repo || pluginRepo()) })));
ipcMain.handle('plugins:install', wrap(async (item) => plugins.install(pluginRepo(), item, (p) => send('plugins:progress', { id: item.id, ...p }))));
ipcMain.handle('plugins:uninstall', wrap(async (id) => plugins.uninstall(id)));

// ---------- 软件更新 ----------
// Windows：electron-updater 从 GitHub Release 下载（按 blockmap 增量），下载完提示重启安装
// macOS：安装包未签名，系统不允许自动替换，只检查 GitHub 最新版本并提示去下载
const REPO = String(require('../package.json').repository || '').replace(/^github:/, '');
const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
};
const currentVersion = () => (DEV && process.env.CR_FAKE_VERSION) || app.getVersion();
let updater = null;

async function checkGithubRelease() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) return null;
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/, '');
  if (latest && cmpVer(latest, currentVersion()) > 0) return { version: latest, url: j.html_url };
  return null;
}

async function checkForUpdates(manual) {
  try {
    if (process.platform === 'win32' && app.isPackaged) {
      if (!updater) {
        updater = require('electron-updater').autoUpdater;
        updater.autoDownload = true;
        updater.on('update-available', (i) => send('update:status', { state: 'downloading', version: i.version }));
        updater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
        updater.on('update-downloaded', (i) => send('update:status', { state: 'ready', version: i.version }));
        updater.on('error', (e) => manual && send('update:status', { state: 'error', message: String(e && e.message).slice(0, 200) }));
      }
      const r = await updater.checkForUpdates();
      if (manual && (!r || !r.updateInfo || cmpVer(r.updateInfo.version, app.getVersion()) <= 0)) send('update:status', { state: 'latest' });
      return;
    }
    const r = await checkGithubRelease();
    if (r) send('update:status', { state: 'available', version: r.version, url: r.url });
    else if (manual) send('update:status', { state: 'latest' });
  } catch (e) {
    if (manual) send('update:status', { state: 'error', message: e.message });
  }
}
ipcMain.handle('update:check', () => checkForUpdates(true));
ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall(); });
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
app.on('window-all-closed', () => {
  for (const id of runs.keys()) stopClaude(id);
  setTimeout(() => app.quit(), 300);
});
