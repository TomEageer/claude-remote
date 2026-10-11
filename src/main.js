const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Remote } = require('./ssh');
const setup = require('./setup');

const remote = new Remote();
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
  host: '',
  port: 22,
  user: '',
  keyPath: setup.APP_KEY,
  workdir: '~/workspace',
  proxy: '',
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

async function runClaude({ sessionId, isNew, prompt, model }) {
  if (runs.has(sessionId)) throw new Error('这个对话正在回复中');
  const wd = await workdirAbs();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    isNew ? '--session-id' : '--resume', sessionId,
  ];
  if (model && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
  const extra = remote.settings.appendPrompt;
  if (extra && extra.trim()) args.push('--append-system-prompt', extra.trim());
  const cmd = [
    `mkdir -p ${shQuote(wd)} && cd ${shQuote(wd)}`,
    `[ -f ~/.claude-env ] && . ~/.claude-env`,
    `export PATH="$HOME/.local/bin:$PATH"`,
    `echo "__PID__$$ $(date +%s)"`,
    `exec claude ${args.map(shQuote).join(' ')}`,
  ].join('; ');

  const stream = await remote.execStream(cmd);
  const run = { stream, pid: null, startedAt: null, stopped: false };
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
    // 子代理内部的过程不展示
    if (d.parent_tool_use_id) return;
    if (d.type === 'system' && d.subtype === 'init') {
      emit({ type: 'init', model: d.model });
    } else if (d.type === 'stream_event') {
      const e = d.event || {};
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        emit({ type: 'text', text: e.delta.text });
      } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'thinking') {
        emit({ type: 'thinking' });
      }
    } else if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
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
      // 用户主动停止时 Claude 会以错误结束，不当成出错展示
      if (run.stopped) return;
      emit({
        type: 'result',
        isError: !!d.is_error || (d.subtype && d.subtype !== 'success'),
        text: typeof d.result === 'string' ? d.result : '',
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
  stream.stdin.end(prompt);
}

// 本轮开始后工作目录里新建/修改过的文件（排除上传目录、隐藏目录和依赖缓存）
async function changedFiles(wd, since) {
  const cmd = `cd ${shQuote(wd)} && find . -type f -newermt @${Math.max(0, since - 1)} ` +
    `-not -path '*/.*' -not -path './uploads/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' ` +
    `-not -path '*/venv/*' -printf '%s\\t%T@\\t%P\\n' 2>/dev/null | head -n 60`;
  const r = await remote.exec(cmd);
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [size, mtime, rel] = line.split('\t');
    return { rel, path: path.posix.join(wd, rel), size: Number(size), mtime: Number(mtime) * 1000 };
  }).sort((a, b) => b.mtime - a.mtime);
}

function previewOf(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return text.length > 1500 ? text.slice(0, 1500) + '\n…' : text;
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
    await remote.exec(`kill -INT ${run.pid} 2>/dev/null; sleep 2; kill -TERM ${run.pid} 2>/dev/null; true`).catch(() => {});
  } else {
    run.stream.close();
  }
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
    return { ok: true, workdir: wd };
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
    return { ok: true, remotePath, size };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('files:list', async (_e, dir) => {
  try {
    const target = dir || (await workdirAbs());
    return { ok: true, dir: target, root: await workdirAbs(), items: await remote.list(target) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('files:download', async (_e, remotePath) => {
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
ipcMain.handle('setup:run', wrap(async (input) => {
  const r = await setup.runSetup(input, (step, state, detail) => send('setup:log', { step, state, detail: detail || '' }));
  remote.configure({ ...remote.settings, ...r.settings });
  return r;
}));
ipcMain.handle('setup:authStart', wrap(async () => ({ url: await setup.startAuth(remote.settings) })));
ipcMain.handle('setup:authCode', wrap((code) => setup.submitCode(remote.settings, code)));
ipcMain.handle('setup:apiKey', wrap((key) => setup.saveApiKey(remote.settings, key)));
ipcMain.handle('setup:cancel', () => setup.cancelAuth());
ipcMain.handle('open:external', (_e, url) => {
  if (/^https:\/\//.test(url) && !SELFTEST) shell.openExternal(url);
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
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  }
  createWindow();
});
app.on('window-all-closed', () => {
  for (const id of runs.keys()) stopClaude(id);
  setTimeout(() => app.quit(), 300);
});
