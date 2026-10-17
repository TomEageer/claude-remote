/* global api, el, esc, icon, toast, data, save, uid, findSession, currentId, live, currentModel, pickServer, renderMarkdown, msgText, scheduleLiveRender, autoGrow, sendMessage, needsAttention, renderSidebar, renderTitle, syncTitle, SLASH_APP, slash */
'use strict';

// ---------- 旁问、计划模式、后台分支（/btw /plan /fork /subtask） ----------
//
// 旁问：带着当前对话的上下文问一个旁支问题，回答显示在输入框上方的「旁路」面板里，
//   不进入对话、不打断正在进行的回复、不能动文件。可以用 /btw 问题，也可以打开「旁问」开关连续问。
// 计划模式：Claude 只调研、写方案，写好后弹出卡片，你点「按计划开始做」才动手。
// /fork 任务：从最新的回复分出一个新对话，在后台做这件事（侧栏里完成后会亮点）。
// /subtask 任务：同上，做完后结果送回到这个对话的「旁路」面板，可以一键发给 Claude。

const side = {
  btwOn: false,
  newChatPlan: false, // 还没开始的新对话要不要用计划模式

  composer() { return document.querySelector('#composer'); },

  // ---------- 开关 ----------
  setBtw(on) {
    this.btwOn = !!on;
    this.composer().classList.toggle('btw-mode', this.btwOn);
    const input = document.querySelector('#input');
    input.placeholder = this.btwOn
      ? '旁问：带着这个对话的上下文问一句，不进入对话、不打断 Claude（Esc 退出旁问）'
      : '给 Claude 发消息，Enter 发送，Shift+Enter 换行，输入 / 查看命令';
    this.renderButtons();
    if (this.btwOn) { this.renderPanel(true); input.focus(); }
    // 关掉旁问时面板一起收起（之后子任务有结果会再弹出来）
    else { this.open = false; this.renderPanel(); }
  },

  planOn() {
    const s = findSession(currentId);
    return s ? !!s.planMode : this.newChatPlan;
  },

  setPlan(on) {
    const s = findSession(currentId);
    if (s) { s.planMode = !!on; save(); } else this.newChatPlan = !!on;
    this.renderButtons();
    toast(on ? '计划模式：Claude 先调研、写方案，你批准后才动手（从下一条消息开始）' : '已退出计划模式', 3500);
  },

  // ---------- 权限模式：自动 / 默认 / 计划 / 危险（计划沿用 planMode，其余存在 permMode） ----------
  MODES: [
    ['auto', '自动', 'Claude 自己判断：安全的直接做，拿不准的才停下来问你'],
    ['manual', '默认', '改文件、运行命令前都先问你，你点允许才做'],
    ['plan', '计划', '只调研、写方案，你批准后才动手'],
    ['bypass', '危险', '全部放行，什么都不问（等同 --dangerously-skip-permissions）'],
  ],
  defaultPerm() { const d = data.settings && data.settings.defaultPermMode; return ['auto', 'manual', 'bypass'].includes(d) ? d : 'auto'; },
  modeOf(s) {
    if (s === undefined) s = findSession(currentId);
    if (s ? s.planMode : this.newChatPlan) return 'plan';
    return this.permOf(s);
  },
  // 不算计划的那个模式（计划批准后回到它）
  permOf(s) { const p = s ? s.permMode : this.newChatPerm; return ['auto', 'manual', 'bypass'].includes(p) ? p : this.defaultPerm(); },
  setMode(mode, quiet) {
    if (!this.MODES.some((m) => m[0] === mode)) return;
    const s = findSession(currentId);
    const plan = mode === 'plan';
    if (s) { s.planMode = plan; if (!plan) s.permMode = mode; save(s.id); }
    else { this.newChatPlan = plan; if (!plan) this.newChatPerm = mode; }
    this.renderButtons();
    const m = this.MODES.find((x) => x[0] === mode);
    if (!quiet) toast(`${m[1]}模式：${m[2]}${s && live[s.id] ? '（从下一条消息开始）' : ''}`, 3500);
  },
  cycleMode() {
    const order = this.MODES.map((m) => m[0]);
    this.setMode(order[(order.indexOf(this.modeOf()) + 1) % order.length]);
  },
  modeMenu(e) {
    const cur = this.modeOf();
    const r = document.querySelector('#btn-plan').getBoundingClientRect();
    showMenu([{ label: '权限模式（Shift+Tab 切换）' }, ...this.MODES.map(([k, t, d]) => ({ text: t, desc: d, danger: k === 'bypass', current: k === cur, onClick: () => this.setMode(k) }))], { clientX: r.left, clientY: r.top, above: r.top });
  },

  renderButtons() {
    const b = document.querySelector('#btn-btw');
    const p = document.querySelector('#btn-plan');
    if (b) b.classList.toggle('on', this.btwOn);
    if (p) {
      const mode = this.modeOf();
      const m = this.MODES.find((x) => x[0] === mode);
      p.dataset.mode = mode;
      p.classList.toggle('on', mode !== 'auto');
      p.querySelector('span:last-child').textContent = m[1];
      p.title = `权限模式：${m[1]} —— ${m[2]}。点击切换，或在输入框里按 Shift+Tab`;
    }
    this.composer().classList.toggle('plan-mode', this.planOn() && !this.btwOn);
    this.composer().classList.toggle('bypass-mode', this.modeOf() === 'bypass' && !this.btwOn);
  },

  // ---------- 输入框发送前：旁问 / 命令 ----------
  // 返回 true = 已处理；返回字符串 = 用它代替原来的内容继续发送
  intercept(text, files) {
    // /rename 新名字：软件自己改（侧栏 + 同步到服务器），不当消息发给 Claude
    const rn = /^\/(rename|name)\s+([\s\S]+)$/i.exec(text);
    if (rn) {
      const s = findSession(currentId);
      const name = rn[2].replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!s) { toast('还没有对话可以改名'); return true; }
      s.title = name;
      s.titleLocked = true;
      save();
      renderSidebar();
      if (typeof renderTitle === 'function') renderTitle();
      if (typeof syncTitle === 'function') syncTitle(s);
      this.clearInput();
      toast('已改名为「' + name + '」');
      return true;
    }
    // 软件自己实现的命令（/branch /status /export …），带了参数也由软件处理，不发给 Claude Code（那边无界面模式下多半用不了）
    const ac = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
    const appCmd = ac && typeof SLASH_APP !== 'undefined' && SLASH_APP.find((c) => !c.arg && (c.cmd === ac[1].toLowerCase() || (c.alias || []).includes(ac[1].toLowerCase())));
    if (appCmd) {
      const arg = (ac[2] || '').trim();
      this.clearInput();
      if (appCmd.sub) { slash.setInput(`/${appCmd.cmd} ${arg}`); slash.show(appCmd.sub, arg.toLowerCase()); }
      else appCmd.run(arg);
      return true;
    }
    const m = /^\/(btw|plan|fork|subtask)(?:\s+([\s\S]*))?$/i.exec(text);
    const cmd = m && m[1].toLowerCase();
    const rest = m ? (m[2] || '').trim() : '';
    if (cmd === 'btw') {
      if (!rest) { this.setBtw(!this.btwOn); this.clearInput(); return true; }
      this.ask(rest); this.clearInput(); return true;
    }
    if (cmd === 'plan') {
      if (!rest) { this.setPlan(!this.planOn()); this.clearInput(); return true; }
      if (!this.planOn()) this.setPlan(true);
      return rest;
    }
    if (cmd === 'fork' || cmd === 'subtask') {
      if (!rest) { toast(`在 /${cmd} 后面写上要交给它做的事`); return true; }
      this.fork(rest, cmd === 'subtask');
      this.clearInput();
      return true;
    }
    if (this.btwOn) {
      if (files.length) { toast('旁问不能带文件，先退出旁问再发'); return true; }
      this.ask(text);
      this.clearInput();
      return true;
    }
    return false;
  },

  clearInput() {
    const input = document.querySelector('#input');
    input.value = '';
    autoGrow();
  },

  // ---------- 旁问 ----------
  async ask(question) {
    const s = findSession(currentId);
    const item = { id: uid(), kind: 'btw', q: question, a: '', status: 'running', ts: Date.now() };
    const list = this.listFor(s, true);
    list.push(item);
    if (list.length > 30) list.splice(0, list.length - 30);
    this.renderPanel(true);
    const srv = s && s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
    if (!srv || srv.id === data.currentServer) {
      const c = await api.connect();
      if (!c.ok) return this.finish(item, '连接服务器失败：' + c.message);
    }
    this.running = this.running || {};
    this.running[item.id] = { item, sid: s ? s.id : null };
    const r = await api.btw({
      btwId: item.id,
      claudeId: s ? s.claudeId || s.id : null,
      started: !!(s && s.started),
      question,
      model: currentModel(),
      cwd: s ? s.cwd : null,
      server: srv ? pickServer(srv) : null,
    });
    if (!r.ok) this.finish(item, r.message);
  },

  finish(item, error) {
    item.status = error ? 'error' : 'done';
    if (error) item.a = item.a || error;
    if (this.running) delete this.running[item.id];
    save();
    this.renderPanel();
  },

  onEvent(e) {
    const r = this.running && this.running[e.btwId];
    if (!r) return;
    const item = r.item;
    if (e.type === 'text') item.a += e.text;
    else if (e.type === 'done') {
      if (e.text) item.a += e.text;
      return this.finish(item, e.isError ? item.a || '回答失败' : null);
    } else if (e.type === 'closed') return this.finish(item, item.a ? null : e.err || '没有拿到回答');
    this.renderPanel();
  },

  // 每个对话自己的旁路记录（还没开始的新对话用一份临时的）
  listFor(s, create) {
    if (!s) { this.loose = this.loose || []; return this.loose; }
    if (!s.side && create) s.side = [];
    return s.side || [];
  },

  // ---------- 后台分支 ----------
  fork(task, subtask) {
    const s = findSession(currentId);
    if (!s) return toast('先开始一个对话');
    const i = s.messages.map((m, k) => (m.role === 'assistant' && m.anchor ? k : -1)).filter((k) => k >= 0).pop();
    if (i == null) return toast('这个对话还没有可以分出去的回复');
    const m = s.messages[i];
    const b = {
      serverId: s.serverId || data.currentServer || null,
      id: uid(),
      title: `${subtask ? '子任务' : '分支'}：${task.replace(/\s+/g, ' ').slice(0, 30)}`,
      groupId: s.groupId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      started: true,
      claudeId: null,
      cwd: s.cwd || null,
      pendingFork: { from: m.anchorSid || s.claudeId || s.id, at: m.anchor },
      caps: s.caps ? JSON.parse(JSON.stringify(s.caps)) : null,
      messages: JSON.parse(JSON.stringify(s.messages.slice(0, i + 1))),
      subtaskOf: subtask ? s.id : null,
    };
    b.claudeId = b.id;
    data.sessions.push(b);
    save();
    sendMessage({ text: task, files: [], sid: b.id });
    if (subtask) {
      const list = this.listFor(s, true);
      list.push({ id: uid(), kind: 'subtask', q: task, a: '', status: 'running', ts: Date.now(), sid: b.id });
      this.renderPanel(true);
      toast('子任务已在后台开始，做完后结果会出现在输入框上方', 4000);
    } else {
      renderSidebar();
      toast(`已在后台分出「${b.title}」，做完后侧栏里会亮点`, 4000);
    }
  },

  // 分出去的对话结束了：子任务把结果送回原对话的旁路面板
  runEnded(b, msg) {
    if (!b.subtaskOf) return;
    const s = findSession(b.subtaskOf);
    const item = s && (s.side || []).find((x) => x.kind === 'subtask' && x.sid === b.id && x.status === 'running');
    if (!item) return;
    item.status = msg.error ? 'error' : 'done';
    item.a = msg.error || msgText(msg) || '（没有文字结果）';
    save();
    if (s.id === currentId) this.renderPanel(true);
    if (typeof needsAttention === 'function' && s.id !== currentId) toast(`「${s.title}」的子任务做完了`, 4000);
  },

  // ---------- 旁路面板（输入框上方） ----------
  renderPanel(show) {
    let p = document.querySelector('#side-panel');
    if (!p) {
      p = el('div', 'side-panel hidden');
      p.id = 'side-panel';
      document.querySelector('#composer-wrap').insertBefore(p, this.composer());
    }
    const s = findSession(currentId);
    const list = this.listFor(s, false);
    if (show) this.open = true;
    if (!this.open || (!list.length && !this.btwOn)) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    const keep = p.querySelector('.sp-list') ? p.querySelector('.sp-list').scrollTop : null;
    p.innerHTML = `<div class="sp-head"><b>旁路</b><span>旁问和子任务的结果不进入对话，Claude 看不到</span><button class="icon-btn sp-x" title="收起">${icon('close')}</button></div><div class="sp-list"></div>`;
    p.querySelector('.sp-x').onclick = () => { this.open = false; if (this.btwOn) this.setBtw(false); p.classList.add('hidden'); };
    const box = p.querySelector('.sp-list');
    if (!list.length) box.appendChild(el('div', 'sp-empty', '问点什么吧：可以问刚才的回复是什么意思、某个词怎么理解，不会打断 Claude 手上的事'));
    for (const it of list) {
      const card = el('div', 'sp-item ' + it.status);
      card.appendChild(el('div', 'sp-q', `<span class="sp-kind">${it.kind === 'subtask' ? '子任务' : '旁问'}</span>${esc(it.q)}`));
      const a = el('div', 'sp-a');
      if (it.a) a.appendChild(renderMarkdown(it.a));
      else a.innerHTML = it.status === 'running' ? `<span class="spin"></span><span>${it.kind === 'subtask' ? '子任务在后台做…' : '正在想…'}</span>` : '<span class="sp-none">（没有拿到文字回答，换个问法再试）</span>';
      card.appendChild(a);
      if (it.status !== 'running' && it.a) {
        const foot = el('div', 'sp-foot');
        const cp = el('button', 'mp-link', '复制');
        cp.onclick = () => { navigator.clipboard.writeText(it.a); toast('已复制'); };
        const send = el('button', 'mp-link', '发给 Claude');
        send.title = '把这段内容作为一条消息发到对话里';
        send.onclick = () => {
          const input = document.querySelector('#input');
          if (this.btwOn) this.setBtw(false);
          input.value = `${it.kind === 'subtask' ? '子任务' : '我刚才旁问'}「${it.q}」的结果：\n\n${it.a}`;
          autoGrow();
          input.focus();
        };
        const del = el('button', 'mp-link', '删除');
        del.onclick = () => { const i = list.indexOf(it); if (i >= 0) list.splice(i, 1); save(); this.renderPanel(); };
        foot.append(cp, send, del);
        if (it.kind === 'subtask' && it.sid) {
          const open = el('button', 'mp-link', '打开那个对话');
          open.onclick = () => openSession(it.sid);
          foot.appendChild(open);
        }
        card.appendChild(foot);
      }
      box.appendChild(card);
    }
    box.scrollTop = keep != null && !show ? keep : box.scrollHeight;
  },
};

// ---------- 计划卡片（Claude 写好方案，等你批准） ----------
// b.plan = { requestId, sid, text, state: pending | approved | rejected | expired }
function renderPlan(b) {
  const plan = b.plan || null;
  const text = (plan && plan.text) || (b.input && b.input.plan) || '';
  const state = plan ? plan.state : 'done';
  const w = el('div', 'plan-card' + (state === 'pending' ? ' pending' : ''));
  const tag = { approved: '已批准，开始执行', rejected: '已打回修改', expired: '已失效' }[state];
  w.appendChild(el('div', 'ask-head', `${icon('list')}<span>${state === 'pending' ? 'Claude 写好了计划，等你批准' : 'Claude 的计划'}</span>${tag ? `<span class="ask-state ${state}">${tag}</span>` : ''}`));
  const body = el('div', 'plan-body');
  body.appendChild(renderMarkdown(text || '（计划是空的）'));
  w.appendChild(body);
  if (state === 'pending') {
    const fb = el('textarea', 'plan-fb');
    fb.rows = 1;
    fb.placeholder = '想改哪里？写在这里再点「打回修改」（也可以不写）';
    const bar = el('div', 'plan-bar');
    const go = el('button', 'btn primary', '按计划开始做');
    const no = el('button', 'btn', '打回修改');
    const answer = async (approve) => {
      go.disabled = no.disabled = true;
      const r = await api.planAnswer({ sessionId: plan.sid, requestId: plan.requestId, approve, feedback: fb.value });
      if (!r.ok) { plan.state = 'expired'; toast(r.message, 5000); }
      else {
        plan.state = approve ? 'approved' : 'rejected';
        // 批准后这个对话退出计划模式；打回则留在计划模式里接着改
        const s = findSession(plan.sid);
        if (approve && s) { s.planMode = false; side.renderButtons(); }
      }
      save(plan.sid);
      renderSidebar();
      if (plan.sid === currentId) scheduleLiveRender();
    };
    go.onclick = () => answer(true);
    no.onclick = () => answer(false);
    bar.append(fb, no, go);
    w.appendChild(bar);
  }
  return w;
}

// 默认 / 自动模式下 Claude 要做一步需要你点头的操作：b.perm = { requestId, sid, reason, state: pending | allowed | denied | expired }
function permDetail(b) {
  const i = b.input || {};
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n) + '\n…' : t; };
  if (b.name === 'Bash') return i.command || '';
  if (b.name === 'Write') return `${i.file_path || ''}\n\n${clip(i.content, 1500)}`;
  if (b.name === 'Edit' || b.name === 'MultiEdit') {
    const edits = i.edits || [{ old_string: i.old_string, new_string: i.new_string }];
    return `${i.file_path || ''}\n` + edits.slice(0, 3).map((e) => `\n- ${clip(e.old_string, 400)}\n+ ${clip(e.new_string, 400)}`).join('\n');
  }
  if (b.name === 'WebFetch') return i.url || '';
  return clip(JSON.stringify(i, null, 2), 1500);
}
function renderPerm(b) {
  const perm = b.perm;
  const state = perm.state;
  const [, label] = TOOL_LABELS[b.name] || mcpLabel(b.name) || ['', b.name];
  const w = el('div', 'perm-card' + (state === 'pending' ? ' pending' : ''));
  const tag = { allowed: '已允许', denied: '已拒绝', expired: '已失效' }[state];
  w.appendChild(el('div', 'ask-head', `${icon('alert')}<span>${state === 'pending' ? `Claude 想要「${esc(label)}」，等你允许` : `Claude 请求「${esc(label)}」`}</span>${tag ? `<span class="ask-state ${state === 'allowed' ? 'approved' : state === 'denied' ? 'rejected' : 'expired'}">${tag}</span>` : ''}`));
  const d = permDetail(b);
  if (d) w.appendChild(el('pre', 'perm-detail', esc(d)));
  if (perm.reason) w.appendChild(el('div', 'perm-reason', esc(perm.reason)));
  if (state === 'pending') {
    const bar = el('div', 'plan-bar');
    const no = el('button', 'btn', '拒绝');
    const ok = el('button', 'btn primary', '允许');
    const answer = async (allow) => {
      ok.disabled = no.disabled = true;
      const r = await api.permAnswer({ sessionId: perm.sid, requestId: perm.requestId, allow });
      perm.state = !r.ok ? 'expired' : allow ? 'allowed' : 'denied';
      if (!r.ok) toast(r.message, 5000);
      save(perm.sid);
      renderSidebar();
      if (perm.sid === currentId) scheduleLiveRender();
    };
    ok.onclick = () => answer(true);
    no.onclick = () => answer(false);
    bar.append(no, ok);
    w.appendChild(bar);
  }
  return w;
}

api.onBtw((e) => side.onEvent(e));
document.querySelector('#btn-btw').onclick = () => side.setBtw(!side.btwOn);
document.querySelector('#btn-plan').onclick = (e) => side.modeMenu(e);
// Shift+Tab：在输入框里轮流切换权限模式（和 Claude Code 一样）
document.querySelector('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && e.shiftKey && !e.isComposing && !side.btwOn && !(typeof slash !== 'undefined' && slash.open)) { e.preventDefault(); side.cycleMode(); }
});
// Esc：旁问模式下先退出旁问（不停止正在进行的回复）
document.querySelector('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && side.btwOn && !e.isComposing && !(typeof slash !== 'undefined' && slash.open)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    side.setBtw(false);
  }
}, true);
