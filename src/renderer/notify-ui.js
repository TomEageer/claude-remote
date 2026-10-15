/* global api, el, esc, data, save, toast, findSession, currentId, renderSidebar, msgText, serverLabel, live, openSession */
'use strict';

// ---------- 完成提醒 ----------
// 1. 侧栏标记：回复完成 / 出错 / 等你处理时，如果你没在看这个对话（在看别的对话，或软件不在前台），
//    对话前面亮一个点，点开就消失；macOS 程序坞图标上显示还没看的个数。
// 2. Webhook：按「设置 → 通知」的配置发到飞书机器人或通用 JSON 地址。

// 你正看着这个对话：软件在前台，而且打开的就是它
const watching = (s) => document.hasFocus() && s.id === currentId;

function updateBadge() {
  api.setBadge((data.sessions || []).filter((x) => x.unread).length);
}

function markUnread(s, kind) {
  if (watching(s)) return;
  s.unread = kind;
  updateBadge();
  save();
  renderSidebar();
}

function clearUnread(id) {
  const s = findSession(id);
  if (!s || !s.unread) return;
  delete s.unread;
  updateBadge();
  save();
}

// 回到软件时，正开着的那个对话就算看过了
window.addEventListener('focus', () => {
  const s = currentId && findSession(currentId);
  if (s && pendingFresh(s)) { seePending(s); renderSidebar(); }
  if (s && s.unread) { clearUnread(s.id); renderSidebar(); }
});

// 一轮回复结束（不含自己点的停止）
function runFinished(s, msg) {
  const kind = msg.error ? 'error' : 'done';
  markUnread(s, kind);
  const reply = kind === 'error' ? msg.error : typeof msgText === 'function' ? msgText(msg) : '';
  notifyWebhook(s, { kind, durationMs: msg.doneAt && msg.ts ? msg.doneAt - msg.ts : null, summary: reply });
}

// 回复过程中需要你处理：Claude 在等你做选择（ask），或者要你去浏览器授权（auth）
// ---------- 等你做选择 ----------
// 回复进行中、最近的回复里有还没回答的提问 / 还没批准的计划：侧栏这一行一直闪，点开看过后不闪，只留「待选择」标记，回答完消失
function pendingOf(s) {
  if (!s || !live[s.id]) return null;
  for (let i = s.messages.length - 1; i >= Math.max(0, s.messages.length - 4); i--) {
    const m = s.messages[i];
    if (m.role !== 'assistant') continue;
    for (const b of m.blocks || []) {
      if (b.ask && b.ask.state === 'pending') return { kind: 'ask', id: b.ask.requestId };
      if (b.plan && b.plan.state === 'pending') return { kind: 'plan', id: b.plan.requestId };
    }
  }
  return null;
}
// 还没点开看过的（要闪）
function pendingFresh(s) {
  const p = pendingOf(s);
  return p && s.pendingSeen !== p.id ? p : null;
}
function seePending(s) {
  const p = pendingOf(s);
  if (p && s.pendingSeen !== p.id) { s.pendingSeen = p.id; save(); }
}

// 顶栏提醒：别的对话在等你
function renderPendingChip() {
  const chip = document.querySelector('#pending-chip');
  if (!chip) return;
  const list = (data.sessions || []).filter((x) => x.id !== currentId && pendingOf(x));
  chip.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const p = pendingOf(list[0]);
  chip.innerHTML = `<i></i><span>${list.length > 1 ? `${list.length} 个对话在等你处理` : `「${esc(list[0].title || '新对话')}」${p.kind === 'plan' ? '的计划等你批准' : '在等你选择'}`}</span>`;
  chip.onclick = () => openSession(list[0].id);
}

function needsAttention(s, msg, type, detail) {
  if (watching(s)) seePending(s);
  else api.attention();
  markUnread(s, 'ask');
  renderSidebar();
  notifyWebhook(s, {
    kind: 'ask',
    statusText: type === 'auth' ? '需要你在浏览器里完成授权' : type === 'plan' ? '计划写好了，等你批准' : '在等你做选择',
    // 授权链接不发出去（发到群里别人也能点），只提示回软件里看
    summary: type === 'auth' ? '打开 Claude 远程助手，在对话里点授权链接，授权后 Claude 会自动继续' : detail || '',
  });
}

// ---------- Webhook ----------
const NOTIFY_DEFAULT = { kind: '', url: '', secret: '', done: true, error: true, ask: true, onlyAway: true, summary: true };
const notifyCfg = () => ({ ...NOTIFY_DEFAULT, ...((data.settings && data.settings.notify) || {}) });

function notifyEvent(s, e) {
  const srv = s && s.serverId && (data.servers || []).find((x) => x.id === s.serverId);
  const cfg = notifyCfg();
  const summary = cfg.summary && e.summary ? String(e.summary).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return {
    kind: e.kind,
    statusText: e.statusText || null,
    title: (s && s.title) || '新对话',
    server: srv ? serverLabel(srv) : '',
    durationMs: e.durationMs || null,
    summary: summary && summary.length >= 200 ? summary + '…' : summary,
    sessionId: s ? s.id : null,
    time: Date.now(),
  };
}

async function notifyWebhook(s, e) {
  const cfg = notifyCfg();
  if (!cfg.kind || !cfg.url || !cfg[e.kind]) return;
  if (cfg.onlyAway && document.hasFocus()) return;
  const r = await api.notifySend({ kind: cfg.kind, url: cfg.url, secret: cfg.secret }, notifyEvent(s, e));
  if (!r.ok) toast('通知发送失败：' + r.message, 6000);
}

// 设置 → 通知
const notifyView = {
  open(pane) {
    this.pane = pane;
    this.render();
  },

  set(patch) {
    data.settings.notify = { ...notifyCfg(), ...patch };
    save();
  },

  render() {
    const pane = this.pane;
    const c = notifyCfg();
    const kinds = [['', '不发送'], ['feishu', '飞书机器人'], ['json', '通用 JSON']];
    pane.innerHTML = `
      <div class="nt-sec">完成提醒</div>
      <p class="help">回复完成、出错或在等你处理时，如果你没在看那个对话，侧栏里它前面会亮一个点（绿色完成、红色出错、橙色等你处理），点开就消失${api.platform === 'darwin' ? '；程序坞图标上会显示还没看的个数' : ''}。</p>
      <div class="nt-sec">Webhook 通知</div>
      <div class="seg nt-kind">${kinds.map(([k, t]) => `<button data-k="${k}" class="${c.kind === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="nt-body"${c.kind ? '' : ' hidden'}>
        <div class="field"><label>Webhook 地址</label><input id="nt-url" class="secret" value="${esc(c.url)}" placeholder="${c.kind === 'feishu' ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…' : 'https://…'}" spellcheck="false" /></div>
        ${c.kind === 'feishu' ? `<div class="field"><label>签名密钥（机器人安全设置里开了「签名校验」才填）</label><input id="nt-secret" class="secret" value="${esc(c.secret)}" spellcheck="false" /></div>` : ''}
        <div class="nt-checks">
          <label class="check"><input type="checkbox" data-c="done" ${c.done ? 'checked' : ''} /> 回复完成</label>
          <label class="check"><input type="checkbox" data-c="error" ${c.error ? 'checked' : ''} /> 回复出错</label>
          <label class="check"><input type="checkbox" data-c="ask" ${c.ask ? 'checked' : ''} /> 需要我处理（等我做选择、需要去浏览器授权）</label>
          <label class="check"><input type="checkbox" data-c="onlyAway" ${c.onlyAway ? 'checked' : ''} /> 只在软件不在前台时发送（正看着软件就不发）</label>
          <label class="check"><input type="checkbox" data-c="summary" ${c.summary ? 'checked' : ''} /> 附带回复开头的摘要（前 200 字）</label>
        </div>
        <div class="nt-test"><button class="btn" id="nt-test">发送测试</button><span class="nt-result"></span></div>
        ${c.kind === 'feishu'
          ? '<p class="help">获取地址：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 Webhook 地址。机器人如果设置了「自定义关键词」，把「Claude」加进去。通知是一张卡片：会话标题、状态（完成 / 出错 / 等你处理）、服务器、耗时、回复摘要和时间。</p>'
          : '<p class="help">以 POST 发送 JSON：<code>event</code>（done / error / ask / test）、<code>status</code>、<code>title</code>（会话标题）、<code>server</code>、<code>durationMs</code>、<code>summary</code>、<code>sessionId</code>、<code>time</code>，另外 <code>text</code> 和 <code>content</code> 是一行文字版，Slack、Discord 等可以直接显示。</p>'}
      </div>`;

    pane.querySelectorAll('.nt-kind button').forEach((b) => (b.onclick = () => { this.set({ kind: b.dataset.k }); this.render(); }));
    const url = pane.querySelector('#nt-url');
    if (url) url.onchange = () => this.set({ url: url.value.trim() });
    const secret = pane.querySelector('#nt-secret');
    if (secret) secret.onchange = () => this.set({ secret: secret.value.trim() });
    pane.querySelectorAll('.nt-checks input').forEach((i) => (i.onchange = () => this.set({ [i.dataset.c]: i.checked })));
    const test = pane.querySelector('#nt-test');
    if (test) test.onclick = async () => {
      if (url) this.set({ url: url.value.trim() });
      if (secret) this.set({ secret: secret.value.trim() });
      const cfg = notifyCfg();
      const out = pane.querySelector('.nt-result');
      if (!cfg.url) { out.className = 'nt-result bad'; out.textContent = '先填 Webhook 地址'; return; }
      test.disabled = true;
      out.className = 'nt-result';
      out.textContent = '正在发送…';
      const s = findSession(currentId);
      const r = await api.notifySend({ kind: cfg.kind, url: cfg.url, secret: cfg.secret }, notifyEvent(s, { kind: 'test', statusText: '测试成功', summary: '收到这条说明通知配置好了。之后回复完成、出错或需要你处理时会发到这里。' }));
      test.disabled = false;
      out.className = 'nt-result ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.ok ? '已发送，去看看收到没有' : r.message;
    };
  },
};

