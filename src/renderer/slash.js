/* global el, esc, toast, data, save, findSession, currentId, startNewChat, openSession, branchFrom, rewindTo, inlineRename, renameSession, openCapsPanel, showView, openSettings, fmtTime, modelList, modelInfo, effortLevels, effortFor, loadModels, customModel, EFFORT_LABEL, EFFORT_DESC, modelLabel, currentModel, currentEffort, renderModel, setModel, setEffort, caps, sendMessage, autoGrow, live */
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
  { cmd: 'rename', label: '重命名当前对话', run: () => {
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
  { cmd: 'tasks', alias: ['bashes', 'agents', 'bg'], label: '后台任务（后台运行的命令、派出的助手）', run: () => openTasksPanel() },
  { cmd: 'mcp', alias: ['skills', 'caps'], label: '这个对话可用的 MCP 和 Skill', run: () => openCapsPanel() },
  { cmd: 'history', alias: ['import'], label: '服务器上的会话（导入终端里聊过的）', run: () => showView('history') },
  { cmd: 'files', label: '服务器文件', run: () => showView('files') },
  { cmd: 'plugin', alias: ['plugins'], label: 'Claude 插件：安装、更新、启用 / 停用、卸载', run: () => openClaudePlugins() },
  { cmd: 'settings', alias: ['config'], label: '设置', run: () => openSettings() },
];
const SLASH_CLAUDE = [
  { cmd: 'compact', label: '压缩上下文：把之前的对话总结成摘要，腾出空间' },
  { cmd: 'context', label: '查看上下文占用明细' },
  { cmd: 'cost', label: '查看这个对话的花费和用量' },
  { cmd: 'init', label: '分析当前目录，生成 CLAUDE.md 项目说明' },
];

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
    const known = new Set([...SLASH_APP, ...SLASH_CLAUDE].map((c) => c.cmd));
    const desc = Object.fromEntries(((caps.global && caps.global.skills) || []).map((s) => [s.name, s.description]));
    const skills = [...new Set([...(data.ui.lastSkills || []), ...Object.keys(desc)])]
      .filter((n) => !known.has(n))
      .map((n) => ({ cmd: n, label: desc[n] || 'Skill', kind: 'skill' }));
    return [
      ...SLASH_APP.map((c) => ({ ...c, kind: 'app' })),
      ...SLASH_CLAUDE.map((c) => ({ ...c, kind: 'claude' })),
      ...skills,
    ];
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
    const head = { root: '命令', sessions: '切换到对话', models: '切换模型', servers: '切换服务器', rewind: '回退到这条消息之前' }[this.mode];
    const tag = { app: '软件', claude: '发给 Claude', skill: 'Skill' };
    b.classList.remove('hidden');
    b.innerHTML = `<div class="slash-head">${head}<span>↑↓ 选择 · 回车确定 · Esc 关闭</span></div>` + (this.items.length ? '' : '<div class="slash-none">没有匹配的项</div>');
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
        this.setInput('');
        this.close();
        return it.run();
      }
      // 发给 Claude：不带参数的直接发送，Skill 留给用户补充说明
      if (it.kind === 'claude') {
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
      if (exact && this.items[this.sel].kind !== 'app' && e.key === 'Enter') { this.close(); return; }
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
