/* global api, data, save, el, esc, icon, toast, modal, findSession, currentId, live, curServer, pickServer, renderAll, renderTitle, renderSidebar, side, modelOf, with1m, scheduleLiveRender, renderMeter, forceEndRun, $ */
'use strict';

// tmux 模式（实验功能）：界面这一侧。打开后这个对话的 Claude 跑在服务器的 tmux 窗口里（交互式 Claude，别人 attach 进去能看能接手），
// 软件把消息粘贴进那个窗口、读 Claude 的会话记录来显示，见主进程 tmuxmode.js。
const tmuxUi = {
  prompts: {}, // 对话 id -> 窗口里正在等你选的菜单 { question, options, cur }

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
    body.innerHTML = `<p class="help" style="margin:0 0 10px">这个对话的 Claude 会在服务器的 tmux「会话:窗口」里运行；窗口不存在会自动建，窗口里已经有 Claude 在跑就直接接上它。</p>
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
      return { session, window, socket };
    } }] });
    if (!v) return false;
    const changed = !s.tmux || s.tmux.session !== v.session || s.tmux.window !== v.window || (s.tmux.socket || '') !== v.socket;
    s.tmux = { ...(s.tmux || {}), ...v };
    if (changed) delete s.tmux.line; // 换了窗口：从新窗口的当前位置开始读
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
      api.tmuxDetach(sid);
      delete this.prompts[sid];
      this.renderAsk();
      renderTitle();
      return toast('已关闭 tmux 模式。tmux 窗口里的 Claude 没有关，需要的话在终端里输入 /exit 退出', 5000);
    }
    if (!(await this.settings(sid, true))) return;
    s.tmux.on = true;
    save();
    renderTitle();
    // 已经聊过的对话：现在就在窗口里把 Claude 启动起来（接着之前的内容）；新对话等发第一条消息时再启动
    if (s.started) {
      toast('正在服务器的 tmux 窗口里启动 Claude…');
      const r = await this.attach(s, true);
      if (r && r.ok) toast(`已进入 tmux 模式。终端里看：${this.attachCmd(s.tmux)}`, 6000);
    } else toast(`已打开 tmux 模式，发第一条消息时会在 tmux 窗口里启动 Claude。终端里看：${this.attachCmd(s.tmux)}`, 6000);
  },

  // 接上窗口：start 时保证窗口里有 Claude 在跑；然后从上次读到的地方接着读会话记录
  async attach(s, start) {
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
      start,
    });
    if (!r.ok) { toast('tmux 模式：' + r.message, 6000); return r; }
    if (r.claudeId && r.claudeId !== s.claudeId) {
      s.claudeId = r.claudeId;
      toast('窗口里本来就有 Claude 在跑，已接上它：之前的内容在终端里，之后的会同步到这里', 6000);
    }
    if (start) s.started = true;
    save();
    return r;
  },

  // 发消息：粘贴进窗口。返回 false 表示失败（错误已经显示在消息上）
  async send(s, prompt, fail) {
    const r = await this.attach(s, true);
    if (!r.ok) { fail(r.message); return false; }
    s._tmuxSent = (s._tmuxSent || []).concat(prompt.trim()).slice(-5);
    const w = await api.tmuxSend({ sessionId: s.id, text: prompt });
    if (!w.ok) { fail(w.message); return false; }
    return true;
  },

  stop(sid) {
    // 中途按 Esc，Claude 记录里只写一段没说完的话、照常结束这一轮，没有「被中断」的标记：这边记下是你停的
    if (live[sid]) live[sid].stopRequested = true;
    api.tmuxKey({ sessionId: sid, esc: true });
    setTimeout(() => { if (live[sid] && typeof forceEndRun === 'function') forceEndRun(sid, { stopped: true }); }, 15000);
  },

  // 记录里读到的事件：返回 true 表示已经处理完，不用再走普通流程
  onEvent(sid, ev) {
    const s = findSession(sid);
    if (!s || !s.tmux) return true;
    if (Number.isFinite(ev.tline)) s.tmux.line = ev.tline;
    if (ev.type === 'tprompt') {
      if (ev.prompt) this.prompts[sid] = ev.prompt; else delete this.prompts[sid];
      if (sid === currentId) this.renderAsk();
      return true;
    }
    if (ev.type === 'tdetached') {
      // 读记录的连接断了：过一会儿从断开的地方接着读（Claude 在 tmux 里一直在跑）
      if (this.on(s)) setTimeout(() => { if (this.on(s)) this.attach(s, false); }, 3000);
      return true;
    }
    if (ev.type === 'tusage') {
      s.usage = { context: ev.context, window: (s.usage && s.usage.window) || 0 };
      if (sid === currentId && typeof renderMeter === 'function') renderMeter();
      return true;
    }
    if (ev.type === 'tuser') {
      const t = ev.text.trim();
      const i = (s._tmuxSent || []).findIndex((x) => x === t || t.startsWith(x.slice(0, 200)));
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
    if (ev.type === 'end') {
      delete this.prompts[sid];
      if (sid === currentId) this.renderAsk();
      if (live[sid] && live[sid].stopRequested) { const m = [...s.messages].reverse().find((x) => x.role === 'assistant'); if (m) m.stopped = true; }
    }
    return false;
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

  // 窗口里在等你选（是否允许、信任这个文件夹……）：输入框上方一条提示，点选项就替你在窗口里按键
  renderAsk() {
    const wrap = $('#composer-wrap');
    let bar = document.querySelector('#tmux-ask');
    const p = this.prompts[currentId];
    if (!p || !this.on(findSession(currentId))) { if (bar) bar.remove(); return; }
    if (!bar) { bar = el('div', 'tmux-ask'); bar.id = 'tmux-ask'; wrap.insertBefore(bar, wrap.firstChild); }
    bar.innerHTML = `<div class="ta-q">${icon('terminal')}<span title="${esc(p.question || '')}">${esc(this.zh(p.question || '') || 'tmux 窗口里的 Claude 在等你选择')}</span><button class="mp-link ta-scr">看终端画面</button></div><div class="ta-opts"></div>`;
    const opts = bar.querySelector('.ta-opts');
    p.options.forEach((o, k) => {
      const label = this.zh(o.label);
      const b = el('button', 'btn' + (k === p.cur ? ' primary' : ''), esc(label.length > 60 ? label.slice(0, 58) + '…' : label));
      b.title = o.label;
      b.onclick = async () => {
        opts.querySelectorAll('button').forEach((x) => (x.disabled = true));
        const r = await api.tmuxKey({ sessionId: currentId, choose: k, cur: p.cur });
        if (!r.ok) toast(r.message, 4000);
      };
      opts.appendChild(b);
    });
    bar.querySelector('.ta-scr').onclick = () => this.showScreen(currentId);
  },

  async showScreen(sid) {
    const pre = el('pre', 'tm-screen');
    const load = async () => { pre.textContent = (await api.tmuxSnapshot(sid)) || '（读不到窗口画面）'; };
    await load();
    const s = findSession(sid);
    modal({ title: 'tmux 窗口画面', body: pre, wide: 'xl', buttons: [{ text: '复制进入命令', onClick: () => { navigator.clipboard.writeText(this.attachCmd(s.tmux)); toast('已复制：' + this.attachCmd(s.tmux)); return undefined; } }, { text: '刷新', onClick: async () => { await load(); return undefined; } }, { text: '关闭', cls: 'primary', value: true }] });
  },

  // 标题旁的标签：在 tmux 模式下；点一下复制进入命令
  chip(s) {
    if (!this.on(s)) return null;
    const c = el('button', 'sid-chip tmux-chip', `${icon('terminal')}<span>tmux · ${esc(s.tmux.session)}:${esc(s.tmux.window)}</span>`);
    c.title = `这个对话在 tmux 模式：Claude 跑在服务器的 tmux 窗口里。\n点击复制进入命令：${this.attachCmd(s.tmux)}`;
    c.onclick = () => { navigator.clipboard.writeText(this.attachCmd(s.tmux)); toast('已复制：' + this.attachCmd(s.tmux)); };
    return c;
  },

  // 启动时：在 tmux 模式下的对话接着读（只读，不在窗口里启动东西）
  resumeAll() {
    if (!this.enabled()) return;
    for (const s of data.sessions || []) {
      if (!this.on(s) || !s.started) continue;
      if (s.serverId && data.currentServer && s.serverId !== data.currentServer) continue;
      this.attach(s, false);
    }
  },
};
