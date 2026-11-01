/* global api, data, save, el, esc, icon, toast, findSession, currentId, live, pickServer, renderAll, renderTitle, renderSidebar, side, modelOf, with1m, tmuxUi, Terminal, FitAddon, $ */
'use strict';

// 对话页的「终端」视图：整块换成真正的终端，黑底白字，和在服务器上敲命令看到的一样。
//   tmux 模式：接进这个对话的 tmux 窗口（和聊天是同一个 Claude，两边同步）；
//   普通模式：在服务器上直接开一个交互式 Claude，接着这个对话；切回聊天时它退出，终端里聊的内容同步回聊天记录
const termView = {
  wants: new Set(), // 想看终端的对话（切到别的对话再回来还是终端）
  cur: null, // 正挂着的终端 { sid, mode, id, term, fit, off, n0, closed }

  mode(s) { return typeof tmuxUi !== 'undefined' && tmuxUi.on(s) ? 'tmux' : 'claude'; },

  // 标题栏的「聊天 / 终端」切换
  renderSwitch() {
    const box = $('#view-switch');
    const s = findSession(currentId);
    if (!s) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const on = this.wants.has(s.id);
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'term') === on));
  },
  async set(sid, on) {
    const s = findSession(sid);
    if (!s) return;
    if (on && this.mode(s) === 'claude' && live[sid]) return toast('这一轮还在回复，等它结束再切到终端', 4000);
    if (on) this.wants.add(sid); else this.wants.delete(sid);
    await this.sync();
  },

  // 按当前对话挂上 / 撤下终端
  async sync() {
    this.renderSwitch();
    const sid = currentId;
    const want = sid && this.wants.has(sid);
    const cur = this.cur;
    if (cur && (cur.sid !== sid || !want)) await this.unmount();
    $('#main').classList.toggle('term-mode', !!want);
    if (want && !this.cur) await this.mount(sid);
  },

  loadXterm() {
    if (this._xt) return this._xt;
    const add = (tag, attrs) => new Promise((ok, bad) => { const n = document.createElement(tag); Object.assign(n, attrs); n.onload = ok; n.onerror = () => bad(new Error('终端组件加载失败')); document.head.appendChild(n); });
    this._xt = Promise.all([add('link', { rel: 'stylesheet', href: 'vendor/xterm.css' }), add('script', { src: 'vendor/xterm.js' })]).then(() => add('script', { src: 'vendor/xterm-fit.js' }));
    this._xt.catch(() => { this._xt = null; });
    return this._xt;
  },

  async mount(sid) {
    const s = findSession(sid);
    if (!s) return;
    const mode = this.mode(s);
    const box = $('#term-view');
    box.innerHTML = `<div class="tv-head">${icon('terminal')}<span class="tv-what"></span><span class="tv-st">连接中…</span><span class="tv-sp"></span><span class="tv-hint"></span></div><div class="tv-body"></div>`;
    box.querySelector('.tv-what').textContent = mode === 'tmux' ? `tmux ${s.tmux.session}:${s.tmux.window}` : 'claude（接着这个对话）';
    box.querySelector('.tv-hint').textContent = mode === 'tmux' ? '这就是 tmux 窗口本身，和聊天是同一个 Claude；切回聊天不影响它运行' : '这是服务器上的交互式 Claude；切回「聊天」时它会退出，这里聊的内容会同步到聊天记录';
    const st = box.querySelector('.tv-st');
    const cur = { sid, mode, id: null, term: null, fit: null, off: null, n0: 0, closed: false };
    this.cur = cur;
    try { await this.loadXterm(); } catch (e) { st.textContent = e.message; st.classList.add('off'); return; }
    if (this.cur !== cur) return;
    const term = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 3000, theme: { background: '#141416', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: '#4a4a55' } });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(box.querySelector('.tv-body'));
    cur.term = term;
    cur.fit = fit;
    try { fit.fit(); } catch (_) {}
    cur.onResize = () => { try { fit.fit(); } catch (_) {} };
    window.addEventListener('resize', cur.onResize);
    cur.ro = new ResizeObserver(cur.onResize);
    cur.ro.observe(box);
    const pending = [];
    cur.off = this.onTerm((p) => {
      if (cur.id === null) { pending.push(p); return; }
      if (p.id !== cur.id) return;
      if (p.data) term.write(p.data);
      if (p.exit) this.ended(cur);
    });
    // 普通模式：先记下服务器上已有多少条消息，切回聊天时把多出来的补进聊天记录
    if (mode === 'claude' && s.started) {
      const h = await api.historyLoad(s.claudeId, this.srvOf(s)).catch(() => null);
      cur.n0 = h && h.ok ? h.messages.length : 0;
    }
    if (this.cur !== cur) return;
    const r = await api.tmuxTermOpen({
      mode,
      sessionId: sid,
      server: this.srvOf(s),
      tmux: s.tmux ? { session: s.tmux.session, window: s.tmux.window, socket: s.tmux.socket || '' } : null,
      cwd: s.cwd || null,
      claudeId: s.claudeId || s.id,
      model: s.model ? with1m(s.model) : modelOf(s),
      perm: typeof side !== 'undefined' ? side.permOf(s) : 'auto',
      rows: term.rows,
      cols: term.cols,
    });
    if (this.cur !== cur) { if (r.ok) api.tmuxTermClose(r.id); return; }
    if (!r.ok) { st.textContent = '打不开'; st.classList.add('off'); term.write('\x1b[31m' + r.message + '\x1b[0m\r\n'); return; }
    cur.id = r.id;
    if (mode === 'claude' && !s.started) { s.started = true; save(); }
    st.textContent = '已连接';
    for (const p of pending.splice(0)) if (p.id === cur.id && p.data) term.write(p.data);
    term.onData((d) => api.tmuxTermInput(cur.id, d));
    term.onResize(({ rows, cols }) => api.tmuxTermResize(cur.id, rows, cols));
    term.focus();
  },

  // 终端那头结束了（Claude 退出、连接断了）
  ended(cur) {
    if (cur.closed) return;
    cur.closed = true;
    const st = document.querySelector('#term-view .tv-st');
    if (st && this.cur === cur) { st.textContent = '已结束'; st.classList.add('off'); }
    if (cur.term) cur.term.write(cur.mode === 'tmux' ? '\r\n\x1b[90m[和 tmux 窗口的连接断开了：切回聊天再切回来就能重新接上]\x1b[0m\r\n' : '\r\n\x1b[90m[Claude 已退出：切回「聊天」会同步这里的内容]\x1b[0m\r\n');
  },

  async unmount() {
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    if (cur.id !== null) api.tmuxTermClose(cur.id);
    if (cur.off) cur.off();
    if (cur.onResize) window.removeEventListener('resize', cur.onResize);
    if (cur.ro) cur.ro.disconnect();
    if (cur.term) cur.term.dispose();
    $('#term-view').innerHTML = '';
    if (cur.mode === 'claude' && cur.id !== null) await this.pullBack(cur.sid, cur.n0);
  },

  srvOf(s) {
    const srv = s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
    return srv && srv.id !== data.currentServer ? pickServer(srv) : null;
  },
  // 普通模式：终端里聊的内容同步回聊天记录（服务器上的记录比打开终端前多出来的部分）
  async pullBack(sid, n0) {
    const s = findSession(sid);
    if (!s || !s.claudeId) return;
    await new Promise((r) => setTimeout(r, 600)); // 等 Claude 退出时把最后几行写完
    const h = await api.historyLoad(s.claudeId, this.srvOf(s)).catch(() => null);
    if (!h || !h.ok) return;
    const add = h.messages.slice(n0).map((m) => ({ ...m, ts: Date.now(), fromTerminal: m.role === 'user' ? true : undefined }));
    if (!add.length) return;
    s.messages.push(...add);
    s.updatedAt = Date.now();
    save(sid);
    if (sid === currentId) renderAll(); else renderSidebar();
    toast(`已把终端里的 ${add.filter((m) => m.role === 'user').length} 轮对话同步到聊天记录`);
  },

  // 终端数据：主进程只发一路，这里按终端分发
  onTerm(cb) {
    if (!this._subs) { this._subs = new Set(); api.onTmuxTerm((p) => { for (const f of this._subs) f(p); }); }
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  },
};

document.querySelectorAll('#view-switch button').forEach((b) => { b.onclick = () => termView.set(currentId, b.dataset.v === 'term'); });
// 终端里要用 Esc、Cmd+F 这些键：不让软件别处的快捷键接到
document.querySelector('#term-view').addEventListener('keydown', (e) => e.stopPropagation());
