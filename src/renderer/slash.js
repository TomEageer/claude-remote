/* global api, modal, curServer, serverLabel, usageKey, windowLabel, msgText, el, esc, toast, data, save, modelsKey, remoteInfo, chatCwd, shortPath, pickFolder, startNewChatIn, openFile, openUsagePanel, refreshUsage, openStatus, exportChat, copyLastReply, updateClaude, findSession, currentId, startNewChat, openSession, branchFrom, rewindTo, inlineRename, renameSession, openCapsPanel, showView, openSettings, fmtTime, modelList, modelInfo, effortLevels, effortFor, loadModels, customModel, EFFORT_LABEL, EFFORT_DESC, modelLabel, currentModel, currentEffort, renderModel, setModel, setEffort, caps, sendMessage, autoGrow, live */
'use strict';

// 输入框里的斜杠命令：打 / 弹出菜单，方向键选择，回车执行。
// kind: app = 软件自己处理；claude = 原样发给 Claude Code（它在无界面模式下也认这些命令）；skill = 调用 Skill
const SLASH_APP = [
  { cmd: 'resume', label: '切换到其他对话', sub: 'sessions' },
  { cmd: 'model', label: '切换模型', sub: 'models' },
  { cmd: 'server', label: '切换服务器', sub: 'servers' },
  { cmd: 'login', label: '登录 Claude（令牌过期或换账号时用）', run: () => openLogin() },
  { cmd: 'clear', alias: ['new'], label: '开始一个新对话', run: () => startNewChat(null) },
  { cmd: 'restart', alias: ['reload'], label: '重新加载 Claude Code（装了新插件、钩子、规则后用）', run: () => restartClaude() },
  { cmd: 'rename', label: '重命名当前对话（也可以直接输入 /rename 新名字）', run: () => {
    const n = [...document.querySelectorAll('#tree .item')].find((x) => x.dataset.sid === currentId);
    if (n) inlineRename(currentId, n.querySelector('.iname')); else if (currentId) renameSession(currentId); else toast('还没有对话可以重命名');
  } },
  { cmd: 'rewind', label: '回退到之前的某条消息', sub: 'rewind' },
  { cmd: 'branch', label: '从最新的回复分出一个新对话', run: () => {
    const s = findSession(currentId);
    const i = s ? s.messages.map((m, k) => (m.role === 'assistant' && m.anchor ? k : -1)).filter((k) => k >= 0).pop() : undefined;
    if (i == null) return toast('这个对话还没有可以分支的回复');
    branchFrom(currentId, i);
  } },
  { cmd: 'tasks', alias: ['bashes', 'bg'], label: '后台任务（后台运行的命令、派出的助手）', run: () => openTasksPanel() },
  { cmd: 'mcp', alias: ['skills', 'caps'], label: '这个对话可用的 MCP 和 Skill', run: () => openCapsPanel() },
  // 下面这些在 Claude Code 里是终端界面专用的（无界面模式下不能用），软件自己实现
  { cmd: 'status', alias: ['version'], label: '状态：Claude Code 版本、账号、登录方式、模型、MCP 连接', run: () => openStatus() },
  { cmd: 'usage', alias: ['cost'], label: '订阅额度（5 小时 / 本周）和用量都花在哪了', run: () => { openUsagePanel(); refreshUsage(document.querySelector('#usp-refresh')); } },
  { cmd: 'stats', label: '用量统计：各模型的 token 和折合的 API 金额', run: () => openSettings('stats') },
  { cmd: 'effort', label: '调思考强度', sub: 'models' },
  { cmd: 'export', label: '把这个对话导出成 Markdown 文件', run: () => exportChat() },
  { cmd: 'copy', label: '复制 Claude 最后一条回复', run: () => copyLastReply() },
  { cmd: 'memory', label: '查看 CLAUDE.md（全局和这个项目的规则 / 记忆）', sub: 'memory' },
  { cmd: 'permissions', alias: ['allowed-tools', 'hooks'], label: '查看权限规则和钩子（settings.json）', sub: 'cfgfiles' },
  { cmd: 'cd', label: '换个文件夹开新对话', run: async () => { const p = await pickFolder(chatCwd()); if (p) startNewChatIn(p); } },
  { cmd: 'update', label: '把服务器上的 Claude Code 升级到最新版', run: () => updateClaude() },
  { cmd: 'btw', label: '旁问：带着对话上下文插问一句，不进入对话、不打断 Claude（后面不写问题就是开 / 关旁问模式）', arg: true },
  { cmd: 'plan', label: '计划模式：先调研、写方案，你批准后才动手（后面可以直接写任务）', arg: true },
  { cmd: 'fork', label: '从最新的回复分出一个新对话，在后台做后面写的事', arg: true },
  { cmd: 'subtask', label: '派一个带着完整上下文的子任务去后台做，结果送回这里', arg: true },
  { cmd: 'help', label: '所有命令', run: () => { slash.setInput('/'); slash.show('root', ''); } },
  { cmd: 'history', alias: ['import'], label: '服务器上的会话（导入终端里聊过的）', run: () => showView('history') },
  { cmd: 'files', label: '服务器文件', run: () => showView('files') },
  { cmd: 'plugin', alias: ['plugins'], label: 'Claude 插件：安装、更新、启用 / 停用、卸载', run: () => openClaudePlugins() },
  { cmd: 'settings', alias: ['config'], label: '设置', run: () => openSettings() },
];
// 发给 Claude Code 的命令：列表来自服务器上的 Claude Code（无界面模式下能用的，含 Skill 和自定义命令），这里只是常用的中文说明；
// 还没读到列表时先用这几个
const SLASH_CLAUDE = [
  { cmd: 'compact', label: '压缩上下文：把之前的对话总结成摘要，腾出空间' },
  { cmd: 'context', label: '查看上下文占用明细' },
  { cmd: 'init', label: '分析当前目录，生成 CLAUDE.md 项目说明' },
];
// Claude Code 内部用的、改了名的，不放进菜单
const HIDDEN_CMDS = new Set(['workflow-launch-exec', 'extra-usage', 'design-consent', 'design-revoke', 'heapdump']);
const CLAUDE_ZH = {
  compact: '压缩上下文：把之前的对话总结成摘要，腾出空间',
  context: '查看上下文占用明细',
  init: '分析当前目录，生成 CLAUDE.md 项目说明',
  review: '审查代码改动',
  'security-review': '对当前分支的改动做安全审查',
  ultrareview: '多代理深度审查当前分支',
  'add-dir': '把另一个文件夹也加进这个对话可访问的范围',
  recap: '用一句话总结这个对话到目前为止做了什么',
  insights: '分析你的 Claude Code 会话，生成使用报告',
  'team-onboarding': '根据你的使用情况，给新同事写一份上手指南',
  'skill-doctor': '看哪些 Skill 没用到、白占上下文',
  'reload-plugins': '让刚装 / 改的插件在这个对话里生效',
  'reload-skills': '重新读取磁盘上新增或改过的 Skill',
  goal: '给 Claude 设一个目标，停下前先检查是否达成',
  advisor: '让 Claude 在关键时刻请教更强的模型',
  autocompact: '设置上下文多满时自动压缩',
  'output-style': '切换回答风格',
  fast: '切换快速模式',
  import: '从其他 AI 编程工具导入配置',
  'list-agents': '列出能发消息的子代理和其他会话',
  agents: '让 Claude 创建 / 管理子代理',
  doctor: '检查 Claude Code 安装和配置是否正常',
  'usage-credits': '设置额度用完后的额外用量',
  'update-config': '修改 Claude Code 的配置',
};

const slash = {
  open: false,
  items: [],
  sel: 0,
  mode: 'root', // root | sessions | models | rewind

  box() {
    let b = document.querySelector('#slash');
    if (!b) {
      b = el('div', 'slash hidden');
      b.id = 'slash';
      document.querySelector('#composer').appendChild(b);
      b.addEventListener('mousedown', (e) => e.preventDefault());
    }
    return b;
  },

  allCommands() {
    const appNames = new Set(SLASH_APP.flatMap((c) => [c.cmd, ...(c.alias || [])]));
    const app = SLASH_APP.map((c) => ({ ...c, kind: 'app' }));
    // 服务器上的 Claude Code 报告的命令（和模型列表同一次读取）；Skill / 自定义命令的说明后面带 (user) (project) (插件名)
    const list = (data.ui.commands || {})[typeof modelsKey === 'function' ? modelsKey() : ''];
    if (list) {
      // Claude Code 自己的命令选了直接发；其余都是 Skill / 插件 / 自定义命令，先放进输入框让你补充要做什么
      const fromClaude = list.filter((c) => !appNames.has(c.name) && !HIDDEN_CMDS.has(c.name)).map((c) => ({
        cmd: c.name,
        label: CLAUDE_ZH[c.name] || c.description.replace(/\s*\((user|project|local)\)\s*$/, ''),
        hint: c.hint,
        kind: CLAUDE_ZH[c.name] ? 'claude' : 'skill',
      }));
      return [...app, ...fromClaude.filter((c) => c.kind === 'claude'), ...fromClaude.filter((c) => c.kind === 'skill')];
    }
    if (!this.loadingCmds && typeof loadModels === 'function') {
      this.loadingCmds = true;
      loadModels(true).then(() => { this.loadingCmds = false; if (this.open && this.mode === 'root') this.update(); });
    }
    const known = new Set([...appNames, ...SLASH_CLAUDE.map((c) => c.cmd)]);
    const desc = Object.fromEntries(((caps.global && caps.global.skills) || []).map((s) => [s.name, s.description]));
    const skills = [...new Set([...(data.ui.lastSkills || []), ...Object.keys(desc)])]
      .filter((n) => !known.has(n))
      .map((n) => ({ cmd: n, label: desc[n] || 'Skill', kind: 'skill' }));
    return [...app, ...SLASH_CLAUDE.map((c) => ({ ...c, kind: 'claude' })), ...skills];
  },

  // 根据输入框内容决定显示什么
  update() {
    const v = document.querySelector('#input').value;
    const m = /^\/(\S*)(\s(.*))?$/s.exec(v);
    if (!m) return this.close();
    const name = m[1].toLowerCase();
    const rest = m[3] != null ? m[3].toLowerCase() : null;
    const sub = SLASH_APP.find((c) => c.sub && (c.cmd === name || (c.alias || []).includes(name)));
    if (rest != null) {
      if (!sub) return this.close(); // 发给 Claude 的命令后面在打参数
      return this.show(sub.sub, rest);
    }
    this.show('root', name);
  },

  show(mode, q) {
    this.mode = mode;
    let items = [];
    if (mode === 'root') {
      items = this.allCommands()
        .filter((c) => !q || c.cmd.startsWith(q) || (c.alias || []).some((a) => a.startsWith(q)) || c.label.toLowerCase().includes(q))
        .sort((a, b) => Number(b.cmd.startsWith(q)) - Number(a.cmd.startsWith(q)));
    } else if (mode === 'sessions') {
      items = data.sessions.filter((s) => sessionOnCurrentServer(s))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((s) => !q || (s.title || '').toLowerCase().includes(q))
        .slice(0, 30)
        .map((s) => ({ kind: 'session', id: s.id, cmd: s.title || '新对话', label: fmtTime(s.updatedAt) + (s.id === currentId ? ' · 当前' : '') }));
      items.push({ kind: 'more', cmd: '服务器上的会话…', label: '导入在终端里聊过的会话' });
    } else if (mode === 'servers') {
      items = (data.servers || [])
        .filter((s) => !q || serverLabel(s).toLowerCase().includes(q) || (s.host || '').includes(q))
        .map((s) => ({ kind: 'server', id: s.id, cmd: serverLabel(s), label: (accountText(s) || '') + (s.id === data.currentServer ? ' · 当前' : '') }));
      items.push({ kind: 'addserver', cmd: '添加服务器…', label: '用配置向导连接一台新服务器' });
    } else if (mode === 'models') {
      // 和模型菜单一样，来自服务器上的 Claude Code（/model 的同一份列表）
      const cur = modelInfo(currentModel());
      const levels = effortLevels(currentModel());
      const all = [
        ...(modelList() || []).map((x) => ({ kind: 'model', id: x.value, cmd: x.name, label: x.description.split(' · ')[0] + (x === cur ? ' · 当前' : '') })),
        { kind: 'custommodel', id: '', cmd: '自定义模型 ID…', label: '列表里没有的老模型' },
        ...(levels.length ? ['', ...levels] : []).map((l) => ({ kind: 'effort', id: l, cmd: '思考强度：' + (l ? EFFORT_LABEL[l] || l : '默认'), label: (EFFORT_DESC[l] || '') + (effortFor(currentModel()) === l ? ' · 当前' : '') })),
      ];
      if (!modelList()) loadModels(true).then(() => { if (this.open && this.mode === 'models') this.update(); });
      items = all.filter((x) => !q || `${x.id} ${x.cmd} ${x.label}`.toLowerCase().includes(q));
    } else if (mode === 'memory' || mode === 'cfgfiles') {
      // 全局的和这个对话所在项目的；点了在右边预览
      const home = (typeof remoteInfo !== 'undefined' && remoteInfo.home) || '~';
      const s = findSession(currentId);
      const cwd = (s && s.cwd) || (typeof chatCwd === 'function' && chatCwd()) || '';
      const files = mode === 'memory'
        ? [[home + '/.claude/CLAUDE.md', '全局规则（所有项目都生效）'], cwd && [cwd + '/CLAUDE.md', '这个项目的规则'], cwd && [cwd + '/CLAUDE.local.md', '这个项目的个人规则（不提交）'], cwd && [cwd + '/.claude/CLAUDE.md', '这个项目的规则（.claude 目录里）']]
        : [[home + '/.claude/settings.json', '全局设置：权限规则、钩子等'], cwd && [cwd + '/.claude/settings.json', '这个项目的设置'], cwd && [cwd + '/.claude/settings.local.json', '这个项目的个人设置（不提交）']];
      items = files.filter(Boolean).filter(([p, l]) => !q || `${p} ${l}`.toLowerCase().includes(q))
        .map(([p, l]) => ({ kind: 'file', id: p, cmd: typeof shortPath === 'function' ? shortPath(p, home) : p, label: l }));
      items.push({ kind: 'note', cmd: '想改内容？', label: '直接告诉 Claude 要加什么规则 / 权限，它会帮你改这些文件' });
    } else if (mode === 'rewind') {
      const s = findSession(currentId);
      items = s ? s.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m, i }) => m.role === 'user' && (i === 0 || (s.messages[i - 1] && s.messages[i - 1].anchor)))
        .reverse()
        .filter(({ m }) => !q || (m.text || '').toLowerCase().includes(q))
        .map(({ m, i }) => ({ kind: 'rewind', index: i, cmd: (m.text || '（文件）').replace(/\s+/g, ' ').slice(0, 40), label: `第 ${s.messages.slice(0, i + 1).filter((x) => x.role === 'user').length} 条` })) : [];
    }
    this.items = items;
    this.sel = 0;
    this.open = true;
    this.render();
  },

  render() {
    const b = this.box();
    const head = { root: '命令', sessions: '切换到对话', models: '切换模型', servers: '切换服务器', rewind: '回退到这条消息之前', memory: 'CLAUDE.md（点了在右边打开）', cfgfiles: '设置文件（点了在右边打开）' }[this.mode];
    const tag = { app: '软件', claude: '发给 Claude', skill: 'Skill' };
    b.classList.remove('hidden');
    const none = this.mode === 'root'
      ? '没有这个命令。Claude Code 里只能在终端界面用的命令（主题、语音、IDE 集成等）这里用不了；直接回车会把它当成普通消息发给 Claude'
      : '没有匹配的项';
    b.innerHTML = `<div class="slash-head">${head}<span>↑↓ 选择 · 回车确定 · Esc 关闭</span></div>` + (this.items.length ? '' : `<div class="slash-none">${none}</div>`);
    this.items.forEach((it, i) => {
      const r = el('div', 'slash-item' + (i === this.sel ? ' on' : ''));
      const name = this.mode === 'root' ? '/' + it.cmd : it.cmd;
      r.innerHTML = `<span class="slash-cmd">${esc(name)}</span><span class="slash-label">${esc(it.label || '')}</span>${this.mode === 'root' ? `<span class="slash-tag ${it.kind}">${tag[it.kind] || ''}</span>` : ''}`;
      r.onmouseenter = () => { this.sel = i; this.highlight(); };
      r.onclick = () => { this.sel = i; this.choose(); };
      b.appendChild(r);
    });
  },

  highlight() {
    [...this.box().querySelectorAll('.slash-item')].forEach((r, i) => r.classList.toggle('on', i === this.sel));
    const on = this.box().querySelector('.slash-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  },

  close() {
    this.open = false;
    this.box().classList.add('hidden');
  },

  setInput(v) {
    const input = document.querySelector('#input');
    input.value = v;
    autoGrow();
    input.focus();
    input.setSelectionRange(v.length, v.length);
  },

  choose() {
    const it = this.items[this.sel];
    if (!it) return;
    if (this.mode === 'root') {
      if (it.kind === 'app') {
        if (it.sub) return this.setInput(`/${it.cmd} `), this.show(it.sub, '');
        // 后面要写内容的（/btw 问题、/plan 任务…）：放进输入框，由发送时处理
        if (it.arg) { this.setInput(`/${it.cmd} `); return this.close(); }
        this.setInput('');
        this.close();
        return it.run();
      }
      // 发给 Claude：不带参数的直接发送，要参数的（比如 /add-dir <路径>）和 Skill 留给用户补充
      if (it.kind === 'claude' && !it.hint) {
        this.setInput(`/${it.cmd}`);
        this.close();
        return sendMessage();
      }
      this.setInput(`/${it.cmd} `);
      return this.close();
    }
    this.setInput('');
    this.close();
    if (it.kind === 'session') return openSession(it.id);
    if (it.kind === 'server') return switchServer(it.id);
    if (it.kind === 'addserver') return openWizard(true, { add: true });
    if (it.kind === 'more') return showView('history');
    if (it.kind === 'model') return setModel(it.id);
    if (it.kind === 'custommodel') return customModel();
    if (it.kind === 'effort') return setEffort(it.id);
    if (it.kind === 'file') return openFile(it.id);
    if (it.kind === 'note') return;
    if (it.kind === 'rewind') {
      if (live[currentId]) return toast('正在回复中，等它结束再回退');
      return rewindTo(currentId, it.index);
    }
  },

  key(e) {
    if (!this.open) return;
    if (e.key === 'ArrowDown') this.sel = (this.sel + 1) % Math.max(1, this.items.length);
    else if (e.key === 'ArrowUp') this.sel = (this.sel - 1 + this.items.length) % Math.max(1, this.items.length);
    else if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
      // 已经打完一个发给 Claude 的完整命令时，回车直接发送
      const v = document.querySelector('#input').value.trim();
      const exact = this.mode === 'root' && this.items[this.sel] && `/${this.items[this.sel].cmd}` === v;
      if (exact && (this.items[this.sel].kind !== 'app' || this.items[this.sel].arg) && e.key === 'Enter') { this.close(); return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      return this.choose();
    } else if (e.key === 'Escape') this.close();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.highlight();
  },
};

const slashInput = document.querySelector('#input');
slashInput.addEventListener('keydown', (e) => slash.key(e), true);
slashInput.addEventListener('input', () => slash.update());
slashInput.addEventListener('blur', () => setTimeout(() => slash.close(), 150));

// 每条消息都会在服务器上启动一个新的 Claude Code 进程，所以新装的插件 / 钩子 / 规则下一条消息就生效；
// 这里额外做的：停掉这个对话正在跑的进程、重连 SSH（重新读取登录环境）、清掉 MCP 和 Skill 的缓存
async function restartClaude() {
  if (currentId && live[currentId]) await api.stop(currentId);
  if (typeof caps !== 'undefined') { caps.global = null; caps.status = null; }
  await api.applySettings(data.settings);
  const r = await refreshRemoteInfo();
  if (!r.ok) return toast('重新连接失败：' + r.message, 5000);
  toast('已重新加载 Claude Code：新装的插件、钩子和全局规则从下一条消息开始生效', 5000);
}

// ---------- 终端专用命令的软件版 ----------
// /status：Claude Code 版本、账号、登录方式、当前模型、工作目录、MCP 连接、额度
async function openStatus() {
  const body = el('div', 'stx');
  body.innerHTML = '<div class="thinking"><span class="spin"></span><span>正在读取服务器上的 Claude Code 状态…</span></div>';
  const p = modal({ title: '状态', body, buttons: [{ text: '关闭', value: null }] });
  const [st, mcp] = await Promise.all([api.claudeStatus(), api.capsMcpStatus()]);
  const srv = curServer();
  const s = findSession(currentId);
  const key = typeof modelsKey === 'function' ? modelsKey() : '';
  const acc = ((data.ui.claudeAccount || {})[key]) || null;
  const a = (st.ok && st.auth) || {};
  // 顺便更新状态栏里的账号（可能在终端里换过号）
  if (st.ok && srv && st.auth && 'loggedIn' in st.auth) {
    srv.account = { email: a.email || '', plan: a.subscriptionType || '', method: a.authMethod || '', loggedIn: !!a.loggedIn, os: st.host, at: Date.now() };
    save();
    if (typeof renderUsage === 'function') renderUsage();
  }
  const method = { 'claude.ai': 'Claude 账号登录', oauth_token: '长期令牌（setup-token）', api_key: 'API Key', apiKey: 'API Key' }[a.authMethod] || a.authMethod || '';
  const u = data.ui.usage && data.ui.usage[usageKey()];
  const quota = u ? Object.entries(u.windows).map(([k, w]) => `${windowLabel(k, w)} ${Math.round((w.utilization || 0) * 100)}%`).join(' · ') : '';
  const mcps = mcp.ok ? Object.entries(mcp.status) : [];
  const bad = mcps.filter(([, v]) => !v.ok);
  const rows = [
    ['Claude Code', st.ok ? st.version || '读不到版本' : '读取失败：' + st.message],
    ['服务器', srv ? `${serverLabel(srv)}${st.host ? ' · ' + st.host : ''}` : ''],
    ['登录方式', a.loggedIn === false ? '未登录' : method],
    ['账号', a.email ? `${a.email}${a.subscriptionType ? ' · ' + a.subscriptionType : ''}` : acc && acc.email ? `${acc.email}${acc.subscriptionType ? ' · ' + acc.subscriptionType : ''}` : a.authMethod === 'oauth_token' ? '长期令牌不带账号信息（换账号用 /login）' : ''],
    ['组织', a.orgName || (acc && acc.organization) || ''],
    ['模型', `${modelLabel(currentModel())}${effortFor(currentModel()) ? ' · 思考强度 ' + (EFFORT_LABEL[effortFor(currentModel())] || effortFor(currentModel())) : ''}`],
    ['工作目录', (s && s.cwd) || (typeof chatCwd === 'function' && chatCwd()) || ''],
    ['MCP', mcp.ok ? (mcps.length ? `${mcps.length - bad.length} 个已连接${bad.length ? `，${bad.length} 个连不上：${bad.map(([n]) => n).join('、')}` : ''}` : '没有配置') : '读取失败'],
    ['额度', quota || '还没有数据（/usage 刷新）'],
  ].filter(([, v]) => v);
  body.innerHTML = rows.map(([k, v]) => `<div class="stx-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  return p;
}

// /export：存成 Markdown
async function exportChat() {
  const s = findSession(currentId);
  if (!s || !s.messages.length) return toast('这个对话还没有内容');
  const lines = [`# ${s.title || '对话'}`, '', `导出于 ${new Date().toLocaleString('zh-CN')}${s.cwd ? ` · 工作目录 ${s.cwd}` : ''}`, ''];
  for (const m of s.messages) {
    if (m.role === 'user') {
      lines.push('## 你', '', m.text || '');
      if ((m.files || []).length) lines.push('', '附件：' + m.files.map((f) => f.name).join('、'));
    } else {
      lines.push('## Claude', '');
      for (const b of m.blocks || []) {
        if (b.type === 'text') lines.push(b.text, '');
        else if (b.type === 'tool') lines.push(`> 使用工具：${b.name}${b.input && (b.input.command || b.input.file_path || b.input.description) ? ' · ' + String(b.input.command || b.input.file_path || b.input.description).split('\n')[0].slice(0, 120) : ''}`, '');
      }
      if (m.error) lines.push(`> 出错：${m.error}`, '');
    }
    lines.push('');
  }
  const r = await api.saveText(s.title || '对话', lines.join('\n'));
  if (!r.ok) toast('导出失败：' + r.message, 5000);
  else if (!r.canceled) toast('已导出到 ' + r.path, 4000);
}

// /copy：复制最后一条回复
async function copyLastReply() {
  const s = findSession(currentId);
  const m = s && [...s.messages].reverse().find((x) => x.role === 'assistant' && msgText(x));
  if (!m) return toast('还没有可以复制的回复');
  await navigator.clipboard.writeText(msgText(m));
  toast('已复制 Claude 最后一条回复');
}

// /update：升级服务器上的 Claude Code
async function updateClaude() {
  toast('正在升级服务器上的 Claude Code…', 60000);
  const r = await api.claudeUpdate();
  const out = r.ok ? r.out : r.message;
  toast(r.ok && r.code === 0 ? (/up to date|already/i.test(out) ? '已经是最新版' : '升级完成，下一条消息起用新版本') : '升级失败：' + String(out).slice(-200), 6000);
  if (typeof loadModels === 'function') loadModels(true);
}
