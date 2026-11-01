/* global api, data, save, el, esc, icon, toast, modal, findSession, currentId, live, curServer, pickServer, renderAll, renderTitle, renderSidebar, side, modelOf, with1m, scheduleLiveRender, renderMeter, forceEndRun, showMenu, onRunEvent, finishLiveFallback, termView, $ */
'use strict';

// tmux 模式（实验功能）：界面这一侧。打开后这个对话的 Claude 跑在服务器的 tmux 窗口里（交互式 Claude，别人 attach 进去能看能接手），
// 软件把消息粘贴进那个窗口、读 Claude 的会话记录来显示，状态和确认请求走 Claude 的钩子，见主进程 tmuxmode.js。
const tmuxUi = {
  prompts: {}, // 对话 id -> Claude 正在等你的请求：{ kind: 'permission' | 'question', id, tool, input, canSession } 或启动时画面上的菜单 { kind: 'screen', question, options, cur }
  picks: {}, // 对话 id -> 选择题里已经选的答案
  status: {}, // 对话 id -> 'connecting' | 'on' | 'off' | 'gone'：和服务器上那个 tmux 窗口的连接状态（gone = 窗口或里面的 Claude 不在了）
  retry: {}, // 对话 id -> 重连失败次数
  // 去掉空白差异和控制字符再比较：会话记录里 TAB 会变成空格、ESC 会变成 ^[
  norm: (t) => String(t || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\^\[/g, ' ').replace(/\s+/g, ' ').trim(),

  enabled: () => !!(data.settings && data.settings.tmuxFeature),
  on(s) { return !!(s && s.tmux && s.tmux.on && this.enabled()); },

  defaults(s) {
    const win = String((s && s.title) || '').replace(/[\s:.'"`$\\;|&<>()*?!#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'c-' + String(s.id).slice(0, 6);
    return { session: data.settings.tmuxSession || 'claude-remote', window: win, socket: data.settings.tmuxSocket || '' };
  },
  attachCmd(t) { return `tmux${t.socket ? ' -S ' + t.socket : ''} attach -t ${t.session}`; },

  // 「…」菜单里的两项
  menuItems(sid) {
    if (!this.enabled()) return [];
    const s = findSession(sid);
    if (!s) return [];
    const on = this.on(s);
    return [
      '-',
      { text: on ? '关闭 tmux 模式' : '打开 tmux 模式', icon: 'terminal', onClick: () => this.toggle(sid) },
      { text: 'tmux 窗口设置…', icon: 'gear', onClick: () => this.settings(sid) },
    ];
  },

  // 窗口设置：会话名、窗口名、tmux 服务器位置（别人账号下的 tmux 要写它的位置，比如 /tmp/tmux-1000/default）
  async settings(sid, opening) {
    const s = findSession(sid);
    if (!s) return false;
    const t = { ...this.defaults(s), ...(s.tmux || {}) };
    const body = el('div', 'tm-form');
    body.innerHTML = `<p class="help" style="margin:0 0 10px">这个对话的 Claude 会在服务器的 tmux「会话:窗口」里运行；窗口不存在会自动建。软件会在窗口里启动 Claude 并让它把「要确认」「回复完了」这些情况通知软件；窗口里已经开着的、不是软件启动的 Claude 接不上，要先退出。</p>
      <div class="field"><label>tmux 会话名</label><input id="tm-s" value="${esc(t.session)}" spellcheck="false" /></div>
      <div class="field"><label>窗口名</label><input id="tm-w" value="${esc(t.window)}" spellcheck="false" /></div>
      <div class="field"><label>tmux 服务器位置（可不填：用这个账号自己的 tmux）</label><input id="tm-k" value="${esc(t.socket || '')}" placeholder="例如 /tmp/tmux-1000/default" spellcheck="false" /></div>`;
    const v = await modal({ title: opening ? '打开 tmux 模式' : 'tmux 窗口设置', body, buttons: [{ text: '取消', value: false }, { text: opening ? '打开' : '保存', cls: 'primary', onClick: () => {
      const session = body.querySelector('#tm-s').value.trim();
      const window = body.querySelector('#tm-w').value.trim();
      const socket = body.querySelector('#tm-k').value.trim();
      const bad = /[\s:.'"`$\\;|&<>()*?!#]/;
      if (!session || !window || bad.test(session) || bad.test(window)) { toast('会话名和窗口名不能为空，也不能有空格、冒号、点和特殊符号'); return undefined; }
      if (socket && !/^\/[A-Za-z0-9._/-]+$/.test(socket)) { toast('tmux 服务器位置要写完整路径'); return undefined; }
      const dup = data.sessions.find((x) => x.id !== sid && x.tmux && x.tmux.on && x.tmux.session === session && x.tmux.window === window && (x.tmux.socket || '') === socket && (x.serverId || '') === (s.serverId || ''));
      if (dup) { toast(`这个窗口已经被对话「${dup.title}」用着了，换一个窗口名`); return undefined; }
      return { session, window, socket };
    } }] });
    if (!v) return false;
    const changed = !s.tmux || s.tmux.session !== v.session || s.tmux.window !== v.window || (s.tmux.socket || '') !== v.socket;
    s.tmux = { ...(s.tmux || {}), ...v };
    if (changed) { delete s.tmux.line; delete s.tmux.hline; } // 换了窗口：从新窗口的当前位置开始读
    data.settings.tmuxSession = v.session;
    if (v.socket) data.settings.tmuxSocket = v.socket;
    save();
    if (changed && this.on(s)) { api.tmuxDetach(s.id); this.attach(s, !!s.started); }
    renderTitle();
    return true;
  },

  async toggle(sid) {
    const s = findSession(sid);
    if (!s) return;
    if (live[sid]) return toast('这个对话还在回复，等它结束再切换');
    if (this.on(s)) {
      s.tmux.on = false;
      save();
      delete this.status[sid];
      delete this.prompts[sid];
      const r = await api.tmuxDetach(sid, { exit: true });
      this.renderAsk();
      renderTitle();
      if (r && r.exit === 'sent') return toast('已关闭 tmux 模式，窗口里的 Claude 也退出了。这个对话之后用普通模式继续', 5000);
      if (r && (r.exit === 'busy' || r.exit === 'error')) return toast('已关闭 tmux 模式，但窗口里的 Claude 还没退出（它在等操作）。先在终端里输入 /exit，再用普通模式继续，不然两边会抢同一个会话', 8000);
      return toast('已关闭 tmux 模式', 3000);
    }
    if (!(await this.settings(sid, true))) return;
    s.tmux.on = true;
    save();
    this.status[sid] = 'connecting';
    renderTitle();
    const many = data.sessions.filter((x) => x.id !== sid && this.on(x) && (x.serverId || '') === (s.serverId || '')).length;
    if (many >= 5) toast('这台服务器上已经有 ' + (many + 1) + ' 个对话开着 tmux 模式。每个都会占用一条连接，超过 7～8 个可能让这台服务器的其他连接失败', 8000);
    // 已经聊过的对话：现在就在窗口里把 Claude 启动起来（接着之前的内容）；新对话等发第一条消息时再启动
    if (s.started) {
      toast('正在服务器的 tmux 窗口里启动 Claude…');
      const r = await this.attach(s, true);
      if (r && r.ok) toast(`已进入 tmux 模式。终端里看：${this.attachCmd(s.tmux)}`, 6000);
    } else toast(`已打开 tmux 模式，发第一条消息时会在 tmux 窗口里启动 Claude。终端里看：${this.attachCmd(s.tmux)}`, 6000);
  },

  // 接上窗口：start 时保证窗口里有 Claude 在跑；然后从上次读到的地方接着读会话记录
  async attach(s, start, quiet, restart) {
    // 已经连着（发消息前确认一下窗口里的 Claude 还在）：不把状态改成「连接中」，免得每发一条都闪一下
    if (this.status[s.id] !== 'on') this.setStatus(s.id, 'connecting');
    const srv = s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
    const r = await api.tmuxAttach({
      sessionId: s.id,
      server: srv && srv.id !== data.currentServer ? pickServer(srv) : null,
      tmux: { session: s.tmux.session, window: s.tmux.window, socket: s.tmux.socket || '' },
      cwd: s.cwd || null,
      claudeId: s.claudeId || s.id,
      isNew: !s.started,
      model: s.model ? with1m(s.model) : modelOf(s),
      perm: typeof side !== 'undefined' ? side.permOf(s) : 'auto',
      from: Number.isFinite(s.tmux.line) ? s.tmux.line : undefined,
      hfrom: Number.isFinite(s.tmux.hline) ? s.tmux.hline : undefined,
      start,
      restart: !!restart,
      busy: !!live[s.id],
    });
    if (!r.ok && r.code === 'foreign') {
      this.setStatus(s.id, 'foreign');
      if (!start || quiet) return r;
      // 窗口里的 Claude 是旧版本或别人手动开的：问一声再重启它（接着它自己的会话，内容不丢）
      const yes = await modal({ title: '要重启窗口里的 Claude 吗？', body: el('p', 'help', `tmux 窗口 ${esc(s.tmux.session)}:${esc(s.tmux.window)} 里的 Claude 在用另一个会话（可能是有人手动开的），不是这个对话的，软件收不到它的回复和确认请求。<br><br>重启后会接着它那个会话继续，内容不会丢。如果有人正在终端里用它，请先和对方确认。`), buttons: [{ text: '取消', value: false }, { text: '重启它', cls: 'primary', value: true }] });
      if (!yes) return { ok: false, message: '窗口里的 Claude 不是这个软件启动的，没有重启它，这条没有发出去' };
      toast('正在重启 tmux 窗口里的 Claude…');
      return this.attach(s, true, false, true);
    }
    if (!r.ok) { this.setStatus(s.id, 'off'); if (!quiet) toast('tmux 模式：' + r.message, 6000); return r; }
    this.setStatus(s.id, start || r.pid ? 'on' : r.old ? 'old' : 'gone');
    if (r.adopted && r.claudeId) {
      s.claudeId = r.claudeId;
      delete s.tmux.line;
      delete s.tmux.hline;
      if (!restart) toast('窗口里的 Claude 在用另一个会话，已跟着它走：之前的内容在终端里，之后的会同步到这里', 6000);
    }
    if (start) s.started = true;
    save();
    return r;
  },

  // 发消息：粘贴进窗口。返回 false 表示失败（错误已经显示在消息上）
  async send(s, prompt, fail) {
    const r = await this.attach(s, true);
    if (!r.ok) { fail(r.message); return false; }
    const rec = { t: this.norm(prompt), at: Date.now() };
    s._tmuxSent = (s._tmuxSent || []).filter((x) => Date.now() - x.at < 600000).concat(rec).slice(-8);
    const w = await api.tmuxSend({ sessionId: s.id, text: prompt });
    if (!w.ok) { s._tmuxSent = s._tmuxSent.filter((x) => x !== rec); fail(w.message); return false; }
    return true;
  },

  stop(sid) {
    // 中途按 Esc，Claude 记录里只写一段没说完的话、照常结束这一轮，没有「被中断」的标记：这边记下是你停的
    const run = live[sid];
    if (!run) return;
    // 每一轮只发一次 Esc：连按两次 Claude 会弹出「回退」菜单
    if (!run.escSent) {
      run.escSent = true;
      run.stopRequested = true;
      api.tmuxKey({ sessionId: sid, esc: true }).then((r) => { if (r && !r.ok && live[sid] === run) { toast(r.message, 4000); forceEndRun(sid, { error: '没能停下：' + r.message }); } });
    }
    // 兜底只收尾「点停止时的那一轮」：停止后马上发的新一轮不受影响
    setTimeout(() => { if (live[sid] === run && typeof forceEndRun === 'function') forceEndRun(sid, { stopped: true }); }, 15000);
  },

  // 记录里读到的事件：返回 true 表示已经处理完，不用再走普通流程
  onEvent(sid, ev) {
    const s = findSession(sid);
    // 对话已经删了、或者已经不是 tmux 模式：不再收这边的事件，并让主进程停掉对它的监视
    if (!s || !s.tmux || !this.on(s)) { api.tmuxDetach(sid); return true; }
    if (Number.isFinite(ev.tline) && ev.tline >= 0) s.tmux.line = ev.tline;
    if (Number.isFinite(ev.hline) && ev.hline >= 0) s.tmux.hline = ev.hline;
    if (ev.type === 'tpos') { save(sid); return true; } // 读取起点：存下来，断线重连从这里接着读
    if (ev.type === 'tprompt') {
      if (ev.prompt) this.prompts[sid] = ev.prompt; else { delete this.prompts[sid]; delete this.picks[sid]; }
      if (sid === currentId) this.renderAsk();
      return true;
    }
    if (ev.type === 'tdetached') {
      this.setStatus(sid, 'off');
      // 读记录的连接断了：过一会儿从断开的地方接着读（Claude 在 tmux 里一直在跑）；连不上就越等越久，最多 1 分钟一次
      const n = (this.retry[sid] = (this.retry[sid] || 0) + 1);
      setTimeout(async () => {
        const cur = findSession(sid);
        if (!cur || !this.on(cur)) return;
        const r = await this.attach(cur, false, true);
        if (r && r.ok) delete this.retry[sid];
      }, Math.min(60000, 3000 * n * n));
      return true;
    }
    if (ev.type === 'tgone') {
      this.setStatus(sid, 'gone');
      delete this.prompts[sid];
      if (sid === currentId) this.renderAsk();
      if (live[sid]) forceEndRun(sid, { error: ev.reason + '，这一轮没有完成。再发一条消息会重新启动它，接着之前的内容。' });
      return true;
    }
    if (ev.type === 'tblocked') {
      toast('tmux 窗口里弹出了一个需要操作的界面（比如 /help 或回退菜单）。点「终端画面」看看，在终端里按 Esc 关掉后再继续', 8000);
      if (live[sid] && Date.now() - (live[sid].since || 0) > 3000) { onRunEvent({ sessionId: sid, ev: { type: 'end' } }); if (live[sid]) finishLiveFallback(sid); }
      return true;
    }
    if (ev.type === 'tback') { this.setStatus(sid, 'on'); return true; }
    if (ev.type === 'tsession') {
      s.claudeId = ev.claudeId;
      delete s.tmux.line;
      s._tmuxSent = [];
      save(sid);
      toast('窗口里的 Claude 开始了新的会话（比如执行了 /clear），之后的内容会接着同步到这里', 6000);
      return true;
    }
    if (ev.type === 'tusage') {
      const m = String(s.model ? with1m(s.model) : modelOf(s));
      s.usage = { context: ev.context, window: (s.usage && s.usage.window) || (/1m/i.test(m) ? 1000000 : 200000) };
      if (sid === currentId && typeof renderMeter === 'function') renderMeter();
      return true;
    }
    if (ev.type === 'tuser') {
      const t = ev.text.trim();
      const n = this.norm(t);
      const i = (s._tmuxSent || []).findIndex((x) => x.t === n || n.startsWith(x.t.slice(0, 200)) || x.t.startsWith(n.slice(0, 200)));
      if (i >= 0) { s._tmuxSent.splice(i, 1); return true; } // 自己从软件发的
      // 有人在终端里直接打的：在软件里也补上这条，开始新的一轮
      s.messages.push({ role: 'user', text: t, files: [], ts: Date.now(), fromTerminal: true });
      s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
      s.updatedAt = Date.now();
      live[sid] = { thinking: true, since: Date.now() };
      save(sid);
      if (sid === currentId) renderAll(); else renderSidebar();
      return true;
    }
    // 软件关着的时候 Claude 还在干活：接着读到的内容也要有地方放
    if (!live[sid] && ['text', 'tool', 'tool_result', 'thinking'].includes(ev.type)) {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.role !== 'assistant') s.messages.push({ role: 'assistant', blocks: [], ts: Date.now() });
      live[sid] = { thinking: true, since: Date.now() };
    }
    if (ev.type === 'text' && ev.whole) {
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === 'assistant' && (last.blocks || []).some((b) => b.type === 'text' && b.text === ev.text)) return true; // 断点重读时已经显示过的
    }
    if (ev.type === 'end') {
      delete this.prompts[sid];
      delete this.picks[sid];
      if (sid === currentId) this.renderAsk();
      if (live[sid] && live[sid].stopRequested) { const m = [...s.messages].reverse().find((x) => x.role === 'assistant'); if (m) m.stopped = true; }
    }
    return false;
  },

  setStatus(sid, st) {
    this.status[sid] = st;
    if (sid === currentId) this.render();
  },
  statusText(s) {
    const st = this.status[s.id] || 'connecting';
    return { on: '已连接', connecting: '连接中…', off: '连接断开，正在重连', gone: '窗口里的 Claude 不在了（发消息会自动重新启动）', foreign: '窗口里的 Claude 是别的会话（发消息时会问你要不要重启它）', old: '窗口里的 Claude 是旧版本启动的，发下一条消息时会自动换成新的' }[st];
  },

  // 输入框一带的所有 tmux 标志：工具栏按钮、输入框上方的状态条、输入框的描边颜色
  render() {
    const s = findSession(currentId);
    const btn = $('#btn-tmux');
    const composer = $('#composer');
    let bar = document.querySelector('#tmux-bar');
    // 没打开实验功能：什么都不显示
    if (!this.enabled() || !s) { btn.classList.add('hidden'); composer.classList.remove('tmux-on'); if (bar) bar.remove(); return; }
    const on = this.on(s);
    btn.classList.remove('hidden');
    btn.classList.toggle('on', on);
    btn.dataset.st = on ? (['gone', 'foreign', 'old'].includes(this.status[s.id]) ? 'off' : this.status[s.id] || 'connecting') : '';
    btn.title = on ? `tmux 模式已打开（${this.statusText(s)}）：${s.tmux.session}:${s.tmux.window}\n点一下看详情、复制进入命令或关闭` : 'tmux 模式：让这个对话的 Claude 在服务器的 tmux 窗口里运行。点一下打开';
    btn.onclick = (e) => { e.stopPropagation(); if (on) this.menu(s, btn); else this.toggle(s.id); };
    composer.classList.toggle('tmux-on', on);
    if (!on) { if (bar) bar.remove(); return; }
    if (!bar) { bar = el('div', 'tmux-bar'); bar.id = 'tmux-bar'; composer.insertBefore(bar, composer.firstChild); }
    const st = this.status[s.id] || 'connecting';
    bar.innerHTML = `<span class="tb-ico">${icon('terminal')}</span><b>tmux 模式</b><span class="tb-where" title="服务器上的 tmux 会话:窗口">${esc(s.tmux.session)}:${esc(s.tmux.window)}</span><span class="tb-st ${['gone', 'foreign', 'old'].includes(st) ? 'off' : st}" title="${esc(this.statusText(s))}"><i></i><span>${esc(this.statusText(s))}</span></span><span class="tb-sp"></span><button class="tb-btn" data-a="screen">${icon('terminal')}打开终端</button><button class="tb-btn" data-a="copy">${icon('copy')}复制进入命令</button><button class="tb-btn" data-a="more">${icon('more')}</button>`;
    bar.querySelector('[data-a="screen"]').onclick = () => termView.set(s.id, true);
    bar.querySelector('[data-a="copy"]').onclick = () => { navigator.clipboard.writeText(this.attachCmd(s.tmux)); toast('已复制：' + this.attachCmd(s.tmux)); };
    bar.querySelector('[data-a="more"]').onclick = (e) => { e.stopPropagation(); this.menu(s, e.currentTarget); };
  },
  // 点工具栏按钮 / 状态条右边的「…」弹出的菜单
  menu(s, anchor) {
    const r = anchor.getBoundingClientRect();
    const items = [
      { text: '打开终端', icon: 'terminal', onClick: () => termView.set(s.id, true) },
      { text: '复制进入命令', icon: 'copy', onClick: () => { navigator.clipboard.writeText(this.attachCmd(s.tmux)); toast('已复制：' + this.attachCmd(s.tmux)); } },
      { text: 'tmux 窗口设置…', icon: 'gear', onClick: () => this.settings(s.id) },
      '-',
      { text: '关闭 tmux 模式', icon: 'close', onClick: () => this.toggle(s.id) },
    ];
    showMenu(items, { clientX: r.left, above: r.top, anchor });
  },

  // Claude 终端界面里常见的英文问题和选项：翻成中文显示（鼠标放上去看原文）
  zh(t) {
    const R = [
      [/^Do you want to create (.+)\?$/, '要创建文件 $1 吗？'],
      [/^Do you want to make this edit to (.+)\?$/, '要这样修改 $1 吗？'],
      [/^Do you want to (?:proceed|run this command)\?$/, '要继续执行吗？'],
      [/^Yes, I trust this folder$/, '信任这个文件夹'],
      [/^No, exit$/, '不信任，退出'],
      [/^Yes, and don't ask again.*$/, '是，以后同类操作不再问'],
      [/^Yes, and switch to accept edits.*$/, '是，并且这个会话里改文件都自动允许'],
      [/^Yes, allow all edits.*$/, '是，这个会话里改文件都自动允许'],
      [/^Yes$/, '是'],
      [/^No$/, '否'],
      [/^No, and tell Claude what to do differently.*$/, '否，告诉 Claude 换个做法'],
      [/Quick safety check: Is this a project you created or one you trust\?.*/, '要信任这个文件夹吗？Claude 将可以读写和运行这里的文件'],
    ];
    for (const [re, to] of R) if (re.test(t)) return t.replace(re, to);
    return t;
  },

  // Claude 在等你：要权限（运行命令、改文件……）、问选择题；启动时窗口里的菜单（信任这个文件夹）。输入框上方一块提示
  toolTitle(tool) {
    const T = { Bash: '运行命令', Write: '创建或覆盖文件', Edit: '修改文件', MultiEdit: '修改文件', NotebookEdit: '修改笔记本', WebFetch: '访问网页', WebSearch: '搜索网页', Task: '启动子助手', Agent: '启动子助手', Read: '读取文件', Glob: '查找文件', Grep: '搜索内容' };
    return T[tool] || `使用工具「${tool}」`;
  },
  toolDetail(tool, i) {
    i = i || {};
    const cut = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…' : t; };
    if (tool === 'Bash') return cut(i.command, 1500) + (i.description ? '\n# ' + cut(i.description, 200) : '');
    if (tool === 'Write') return cut(i.file_path, 300) + '\n' + cut(i.content, 800);
    if (tool === 'Edit' || tool === 'MultiEdit') return cut(i.file_path, 300) + (i.old_string != null ? '\n- ' + cut(i.old_string, 400).replace(/\n/g, '\n- ') + '\n+ ' + cut(i.new_string, 400).replace(/\n/g, '\n+ ') : '');
    if (tool === 'WebFetch') return cut(i.url, 500);
    if (tool === 'WebSearch') return cut(i.query, 300);
    return cut(JSON.stringify(i, null, 1), 1200);
  },
  async answer(sid, body, btns) {
    btns.forEach((x) => (x.disabled = true));
    const r = await api.tmuxAnswer({ sessionId: sid, ...body });
    if (!r.ok) { toast(r.message, 5000); btns.forEach((x) => (x.disabled = false)); }
  },
  renderAsk() {
    const wrap = $('#composer-wrap');
    let bar = document.querySelector('#tmux-ask');
    const p = this.prompts[currentId];
    if (!p || !this.on(findSession(currentId))) { if (bar) bar.remove(); return; }
    if (!bar) { bar = el('div', 'tmux-ask'); bar.id = 'tmux-ask'; wrap.insertBefore(bar, wrap.firstChild); }
    const sid = currentId;
    const scr = '<button class="mp-link ta-scr">在终端里处理</button>';
    if (p.kind === 'permission') {
      bar.innerHTML = `<div class="ta-q">${icon('terminal')}<span>Claude 想要${esc(this.toolTitle(p.tool))}</span>${scr}</div><pre class="ta-detail">${esc(this.toolDetail(p.tool, p.input))}</pre><div class="ta-opts"></div>`;
      const opts = bar.querySelector('.ta-opts');
      const mk = (text, cls, body) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), esc(text)); b.onclick = () => this.answer(sid, { id: p.id, ...body }, [...opts.querySelectorAll('button')]); opts.appendChild(b); };
      mk('允许', 'primary', { kind: 'allow' });
      if (p.canSession) mk('允许，这个会话里同类操作不再问', '', { kind: 'allowSession' });
      mk('拒绝', '', { kind: 'deny' });
    } else if (p.kind === 'question') {
      const qs = (p.input && p.input.questions) || [];
      const pick = (this.picks[sid] = this.picks[sid] || {}); // 问题文字 -> 已选的选项文字数组 / 自己写的答案
      const single = qs.length === 1 && !qs[0].multiSelect;
      bar.innerHTML = `<div class="ta-q">${icon('terminal')}<span>Claude 在问你</span>${scr}</div><div class="ta-qs"></div><div class="ta-opts ta-submit"></div>`;
      const box = bar.querySelector('.ta-qs');
      const sub = bar.querySelector('.ta-submit');
      const answers = () => { const a = {}; for (const q of qs) { const v = pick[q.question]; if (v && v.text) a[q.question] = v.text; else if (v && v.sel && v.sel.length) a[q.question] = v.sel.join(', '); } return a; };
      const done = () => qs.every((q) => answers()[q.question]);
      const submit = () => this.answer(sid, { id: p.id, kind: 'answers', answers: answers() }, [...bar.querySelectorAll('button')]);
      const okBtn = el('button', 'btn primary', '提交');
      const upd = () => { okBtn.disabled = !done(); };
      okBtn.onclick = submit;
      qs.forEach((q) => {
        const v = (pick[q.question] = pick[q.question] || { sel: [], text: '' });
        const row = el('div', 'ta-qrow', `<div class="ta-qt">${q.header ? `<span class="ta-hd">${esc(q.header)}</span>` : ''}<b>${esc(q.question)}</b>${q.multiSelect ? '<span class="ta-hint">可多选</span>' : ''}</div>`);
        const opts = el('div', 'ta-opts');
        (q.options || []).forEach((o) => {
          const b = el('button', 'btn' + (v.sel.includes(o.label) ? ' primary' : ''), esc(o.label));
          if (o.description) b.title = o.description;
          b.onclick = () => {
            if (single) { v.sel = [o.label]; v.text = ''; submit(); return; }
            if (q.multiSelect) v.sel = v.sel.includes(o.label) ? v.sel.filter((x) => x !== o.label) : v.sel.concat(o.label);
            else v.sel = [o.label];
            v.text = '';
            opts.querySelectorAll('.btn').forEach((x, k) => x.classList.toggle('primary', v.sel.includes((q.options[k] || {}).label)));
            inp.value = '';
            upd();
          };
          opts.appendChild(b);
        });
        const inp = el('input', 'ta-other');
        inp.placeholder = '其他，自己写…';
        inp.value = v.text || '';
        inp.oninput = () => { v.text = inp.value.trim(); if (v.text) { v.sel = []; opts.querySelectorAll('.btn').forEach((x) => x.classList.remove('primary')); } upd(); };
        inp.onkeydown = (e) => { if (e.key === 'Enter' && single && v.text) { e.preventDefault(); submit(); } };
        row.appendChild(opts);
        row.appendChild(inp);
        box.appendChild(row);
      });
      if (!single) sub.appendChild(okBtn);
      else sub.remove();
      upd();
    } else {
      // 启动时窗口里的菜单（信任这个文件夹……）：点选项就替你在窗口里按键
      bar.innerHTML = `<div class="ta-q">${icon('terminal')}<span title="${esc(p.question || '')}">${esc(this.zh(p.question || '') || 'tmux 窗口里的 Claude 在等你选择')}</span>${scr}</div><div class="ta-opts"></div>`;
      const opts = bar.querySelector('.ta-opts');
      p.options.forEach((o, k) => {
        const label = this.zh(o.label);
        const b = el('button', 'btn' + (k === p.cur ? ' primary' : ''), esc(label.length > 60 ? label.slice(0, 58) + '…' : label));
        b.title = o.desc ? o.label + '\n' + o.desc : o.label;
        b.onclick = async () => {
          opts.querySelectorAll('button').forEach((x) => (x.disabled = true));
          const r = await api.tmuxKey({ sessionId: sid, choose: Number.isInteger(o.idx) ? o.idx : k, cur: p.cur });
          if (!r.ok) toast(r.message, 4000);
        };
        opts.appendChild(b);
      });
    }
    bar.querySelector('.ta-scr').onclick = () => termView.set(sid, true);
  },


  // 打开一个对话：已经连着（或正在连）就什么都不做，只有断了、还没连过才去接
  ensureWatching(s) {
    if (!this.on(s) || !s.started) return;
    if (['on', 'connecting', 'old', 'foreign'].includes(this.status[s.id])) return;
    this.attach(s, false, true);
  },

  // 启动时：在 tmux 模式下的对话接着读（只读，不在窗口里启动东西）
  resumeAll() {
    if (!this.enabled()) return;
    for (const s of data.sessions || []) {
      if (!this.on(s) || !s.started) continue;
      if (s.serverId && data.currentServer && s.serverId !== data.currentServer) continue;
      this.attach(s, false, true);
    }
  },
};
