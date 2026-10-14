/* global api, el, esc, icon, toast, data, save, findSession, currentId, live, confirmModal, renderMessages, scheduleLiveRender */
'use strict';

// ---------- 后台任务：后台运行的命令（local_bash）和派出的助手（local_agent） ----------
// 任务记在启动它的那条回复上：msg.tasks = [{ id, kind, toolId, desc, status, start, end, progress, summary, sid }]
// status: running | done | failed | stopped | ended（这一轮结束时任务还没报告结果）
const TASK_STATUS = { running: '运行中', done: '已完成', failed: '失败', stopped: '已停止', ended: '已随本轮结束' };

function normTaskStatus(x) {
  const v = String(x || '').toLowerCase();
  if (!v || v === 'running' || v === 'pending' || v === 'started') return 'running';
  if (v === 'completed' || v === 'success' || v === 'done') return 'done';
  if (/kill|stop|cancel|abort/.test(v)) return 'stopped';
  return 'failed';
}

function onTaskEvent(s, msg, ev) {
  if (!ev.taskId) return;
  // 任务可能是之前那条回复启动的（之后又接着聊了）：先在整个对话里找
  let t = null;
  for (const m of s.messages) { const x = (m.tasks || []).find((y) => y.id === ev.taskId); if (x) { t = x; break; } }
  msg.tasks = msg.tasks || [];
  if (!t) {
    const tool = ev.toolId && msg.blocks.find((b) => b.type === 'tool' && b.id === ev.toolId);
    const agent = ev.taskType === 'local_agent' || (tool && (tool.name === 'Agent' || tool.name === 'Task'));
    t = { id: ev.taskId, kind: agent ? 'agent' : 'bash', toolId: ev.toolId || null, desc: ev.description || '', status: 'running', start: Date.now(), sid: s.claudeId || s.id };
    msg.tasks.push(t);
  }
  if (ev.toolId && !t.toolId) t.toolId = ev.toolId;
  switch (ev.subtype) {
    case 'task_started':
      if (ev.description) t.desc = ev.description;
      break;
    case 'task_progress':
      if (ev.description) t.progress = ev.description;
      if (ev.usage) t.usage = ev.usage;
      break;
    case 'task_updated':
    case 'task_notification':
      if (ev.status && !t.userStopped) {
        t.status = normTaskStatus(ev.status);
        if (t.status !== 'running' && !t.end) t.end = Date.now();
      }
      if (ev.summary) t.summary = ev.summary;
      break;
  }
}

// 子助手的进度描述是英文的 "Running xxx"
function taskProgressText(p) {
  return String(p || '').replace(/^Running\s+/i, '正在：');
}

function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

// 当前对话里的所有后台任务，新的在前
function sessionTasks(s) {
  const out = [];
  if (!s) return out;
  s.messages.forEach((m, index) => (m.tasks || []).forEach((t) => out.push({ t, m, index })));
  return out.sort((a, b) => b.t.start - a.t.start);
}

function renderTasksUi() {
  const btn = document.querySelector('#btn-tasks');
  if (!btn) return;
  const s = findSession(currentId);
  const all = sessionTasks(s);
  const running = all.filter((x) => x.t.status === 'running').length;
  btn.classList.toggle('hidden', !all.length);
  btn.classList.toggle('busy', running > 0);
  // 只说现在的状态：有在跑的就说几个在跑，没有就明确说都结束了（总数放在提示里，免得被当成「还有这么多在跑」）
  btn.querySelector('.tk-label').textContent = running ? `后台 ${running} 个运行中` : '后台任务都已结束';
  btn.title = (running ? `后台 ${running} 个运行中` : '后台任务都已结束') + '：后台运行的命令和派出的助手';
  btn.title = running ? `这个对话共 ${all.length} 个后台任务，${running} 个还在运行，点开查看` : `这个对话共 ${all.length} 个后台任务，全部已结束，点开查看`;
  if (document.querySelector('.tk-pop')) tasksPanel.render();
}

const tasksPanel = {
  open: new Set(), // 展开了输出的任务
  out: {}, // 任务编号 → { text, size, at, err }
  timer: null,

  pop() { return document.querySelector('.tk-pop'); },

  render() {
    const pop = this.pop();
    if (!pop) return;
    const s = findSession(currentId);
    const all = sessionTasks(s);
    const lv = s && live[s.id];
    const list = pop.querySelector('.tk-list');
    const keep = list.scrollTop;
    list.innerHTML = '';
    if (!all.length) list.appendChild(el('div', 'cx-none', '这个对话还没有后台任务。Claude 把耗时的命令放到后台运行、或者派出助手时，会显示在这里。'));
    for (const { t, m, index } of all.slice(0, 40)) {
      const row = el('div', 'tk-row ' + t.status);
      const dur = fmtDur((t.end || Date.now()) - t.start);
      const st = t.status === 'running' ? `<span class="spin"></span>${TASK_STATUS.running}` : TASK_STATUS[t.status] || t.status;
      row.innerHTML = `<div class="tk-head">${icon(t.kind === 'agent' ? 'spark' : 'terminal')}
        <span class="tk-name" title="${esc(t.desc)}">${esc(t.desc || (t.kind === 'agent' ? '助手' : '后台命令'))}</span>
        <span class="tk-kind">${t.kind === 'agent' ? '助手' : '命令'}</span></div>
        <div class="tk-meta"><span class="tk-st">${st}</span><span>${dur}</span>${t.kind === 'agent' && t.status === 'running' && t.progress ? `<span class="tk-prog">${esc(taskProgressText(t.progress))}</span>` : ''}${t.usage && t.usage.tools ? `<span>${t.usage.tools} 次操作</span>` : ''}</div>`;
      const acts = el('div', 'tk-acts');
      const add = (label, fn, cls) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; acts.appendChild(b); };
      if (t.kind === 'bash') add(this.open.has(t.id) ? '收起输出' : '查看输出', () => this.toggle(t.id));
      else add('查看步骤', () => this.jump(index, t.toolId));
      if (t.status === 'running' && lv) add('停止', () => this.stop(s, t), 'danger');
      row.appendChild(acts);
      if (t.kind === 'bash' && this.open.has(t.id)) {
        const o = this.out[t.id];
        const pre = el('pre', 'tk-out');
        pre.textContent = !o ? '正在读取…' : o.err ? o.err : o.text || '（还没有输出）';
        row.appendChild(pre);
        requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
      }
      if (t.kind === 'agent' && t.summary && t.status !== 'running') {
        const sm = el('div', 'tk-sum');
        sm.textContent = t.summary.length > 400 ? t.summary.slice(0, 400) + '…' : t.summary;
        row.appendChild(sm);
      }
      list.appendChild(row);
    }
    list.scrollTop = keep;
    const foot = pop.querySelector('.tk-foot');
    foot.innerHTML = '';
    if (lv && lv.replied && all.some((x) => x.t.status === 'running')) {
      const b = el('button', 'btn', '不等了，结束这一轮');
      b.title = '停止整轮回复，后台任务会一起结束';
      b.onclick = async () => {
        if (!(await confirmModal('结束这一轮', 'Claude 的回复已经完成，正在等后台任务。结束这一轮后，还在运行的后台任务会一起停止，之后可以接着发消息。', '结束'))) return;
        api.stop(s.id);
      };
      foot.appendChild(b);
      foot.appendChild(el('span', 'cx-tip', '后台任务没结束前，新发的消息会排队'));
    } else {
      foot.appendChild(el('span', 'cx-tip', '后台命令的输出保存在服务器的临时目录，这一轮结束后仍可查看'));
    }
  },

  async fetch(t) {
    const s = findSession(currentId);
    if (!s) return;
    const r = await api.taskOutput({ sessionId: s.id, taskId: t.id, claudeId: t.sid || s.claudeId || s.id });
    this.out[t.id] = r.ok ? { text: r.text, size: r.size, at: Date.now() } : { err: r.message };
    this.render();
  },

  toggle(id) {
    if (this.open.has(id)) this.open.delete(id);
    else {
      this.open.add(id);
      const x = sessionTasks(findSession(currentId)).find((y) => y.t.id === id);
      if (x) this.fetch(x.t);
    }
    this.render();
  },

  // 定时刷新展开着的、还在运行的命令输出
  tick() {
    if (!this.pop()) return this.close();
    for (const { t } of sessionTasks(findSession(currentId))) {
      if (this.open.has(t.id) && t.status === 'running') this.fetch(t);
    }
    // 运行时长每秒变化
    this.render();
  },

  jump(index, toolId) {
    this.close();
    const msgEl = document.querySelector(`#messages .msg.assistant[data-index="${index}"]`);
    if (!msgEl) return;
    const s = findSession(currentId);
    const m = s && s.messages[index];
    const cards = [...msgEl.querySelectorAll(':scope > .tool, :scope > .tool-wrap > .tool')];
    const tools = m ? m.blocks.filter((b) => b.type === 'tool') : [];
    const card = cards[tools.findIndex((b) => b.id === toolId)] || msgEl;
    card.classList.add('open');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1400);
  },

  async stop(s, t) {
    if (t.kind === 'agent') {
      if (!(await confirmModal('停止助手', '派出的助手不能单独停止。要停止整轮回复吗？其他后台任务也会一起结束。', '停止整轮'))) return;
      return api.stop(s.id);
    }
    const r = await api.stopTask({ sessionId: s.id, taskId: t.id, claudeId: t.sid || s.claudeId || s.id });
    if (!r.ok) return toast('停止失败：' + r.message, 5000);
    if (!r.already) {
      t.userStopped = true;
      t.status = 'stopped';
      t.end = t.end || Date.now();
      save();
      renderTasksUi();
      scheduleLiveRender();
    }
    toast(r.already ? '这个命令已经结束了' : '已停止这个后台命令，Claude 会收到通知');
    if (this.open.has(t.id)) setTimeout(() => this.fetch(t), 800);
  },

  close() {
    const pop = this.pop();
    if (pop) pop.remove();
    clearInterval(this.timer);
    this.timer = null;
  },
};

function openTasksPanel() {
  if (tasksPanel.pop()) return tasksPanel.close();
  const pop = el('div', 'tk-pop');
  pop.innerHTML = '<div class="cx-head">后台任务 <span>后台运行的命令和派出的助手</span></div><div class="tk-list"></div><div class="cx-foot tk-foot"></div>';
  document.body.appendChild(pop);
  const btn = document.querySelector('#btn-tasks');
  const anchor = (btn && !btn.classList.contains('hidden') ? btn : document.querySelector('#composer')).getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - 468)) + 'px';
  pop.style.bottom = window.innerHeight - anchor.top + 8 + 'px';
  tasksPanel.render();
  // 正在运行的命令默认展开输出
  const s = findSession(currentId);
  const run = sessionTasks(s).filter((x) => x.t.kind === 'bash' && x.t.status === 'running');
  if (run.length === 1 && !tasksPanel.open.has(run[0].t.id)) tasksPanel.toggle(run[0].t.id);
  tasksPanel.timer = setInterval(() => tasksPanel.tick(), 2000);
  setTimeout(() => document.addEventListener('mousedown', function close(e) {
    if (!pop.isConnected) return document.removeEventListener('mousedown', close);
    if (!pop.contains(e.target) && !e.target.closest('#btn-tasks') && !e.target.closest('.overlay')) {
      tasksPanel.close();
      document.removeEventListener('mousedown', close);
    }
  }), 0);
}

document.querySelector('#btn-tasks').addEventListener('click', openTasksPanel);
