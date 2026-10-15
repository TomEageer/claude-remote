/* global api, el, esc, icon, toast, save, findSession, scheduleLiveRender, currentId */
'use strict';

// ---------- Claude 向你提问（AskUserQuestion）：选项做成可以点的按钮 ----------
// b.ask = { requestId, sid, questions, state: pending | answered | skipped | expired, answers }
// questions: [{ question, header, options: [{ label, description }], multiSelect }]
// 回答格式：{ 问题原文: 选项文字 }，多选用 ", " 连接，自己填写的内容原样作为答案

// 还没提交的选择（界面重绘时保留）：requestId → [{ picked: Set, other: '' }]
const askDrafts = {};

function askDraft(b) {
  const id = b.ask.requestId;
  if (!askDrafts[id]) askDrafts[id] = b.ask.questions.map(() => ({ picked: new Set(), other: '' }));
  return askDrafts[id];
}

function askAnswerOf(q, d) {
  const parts = [...d.picked];
  if (d.other.trim()) parts.push(d.other.trim());
  return parts.join(', ');
}

async function submitAsk(b, skip) {
  const ask = b.ask;
  if (!ask || ask.state !== 'pending' || ask.sending) return;
  const draft = askDraft(b);
  const answers = {};
  if (!skip) {
    for (let i = 0; i < ask.questions.length; i++) {
      const a = askAnswerOf(ask.questions[i], draft[i]);
      if (!a) return toast(ask.questions.length > 1 ? `第 ${i + 1} 个问题还没选` : '先选一个选项，或者自己填写');
      answers[ask.questions[i].question] = a;
    }
  }
  ask.sending = true;
  const r = await api.answer({ sessionId: ask.sid, requestId: ask.requestId, answers, skip: !!skip });
  ask.sending = false;
  if (!r.ok) {
    ask.state = 'expired';
    toast(r.message, 5000);
  } else {
    ask.state = skip ? 'skipped' : 'answered';
    ask.answers = skip ? null : answers;
    delete askDrafts[ask.requestId];
  }
  save();
  if (typeof renderSidebar === 'function') renderSidebar();
  if (ask.sid === currentId) scheduleLiveRender();
}

function renderAsk(b) {
  const input = b.input || {};
  const ask = b.ask || null;
  const questions = (ask && ask.questions) || input.questions || [];
  const state = ask ? ask.state : b.status === 'running' ? 'waiting' : 'done';
  const pending = state === 'pending';
  const w = el('div', 'ask-card' + (pending ? ' pending' : ''));
  const head = el('div', 'ask-head', `${icon('list')}<span>${pending ? 'Claude 想请你做个选择' : 'Claude 的提问'}</span>`);
  const tag = { answered: '已回答', skipped: '已跳过', expired: '已失效', waiting: '', done: '' }[state];
  if (tag) head.appendChild(el('span', 'ask-state ' + state, tag));
  w.appendChild(head);
  const draft = pending ? askDraft(b) : null;
  // 已回答的从答案里还原选中项（只是显示用）
  const answered = (q) => {
    const a = ask && ask.answers && ask.answers[q.question];
    return a ? String(a).split(', ') : [];
  };
  const single = questions.length === 1 && !questions[0].multiSelect;

  questions.forEach((q, qi) => {
    const box = el('div', 'ask-q');
    box.innerHTML = `${q.header ? `<span class="ask-chip">${esc(q.header)}</span>` : ''}<div class="ask-title">${esc(q.question)}</div>${q.multiSelect ? '<div class="ask-hint">可以多选</div>' : ''}`;
    const opts = el('div', 'ask-opts');
    const picked = draft ? draft[qi].picked : new Set(answered(q));
    for (const o of q.options || []) {
      const btn = el('button', 'ask-opt' + (picked.has(o.label) ? ' on' : '') + (q.multiSelect ? ' multi' : ''));
      btn.innerHTML = `<span class="ask-mark"></span><span class="ask-txt"><span class="ask-label">${esc(o.label)}</span>${o.description ? `<span class="ask-desc">${esc(o.description)}</span>` : ''}</span>`;
      if (!pending) btn.disabled = true;
      else btn.onclick = () => {
        const d = draft[qi];
        if (q.multiSelect) {
          if (d.picked.has(o.label)) d.picked.delete(o.label); else d.picked.add(o.label);
        } else {
          d.picked = new Set([o.label]);
          d.other = '';
        }
        // 只有一个单选问题：点了就提交
        if (single) return submitAsk(b);
        scheduleLiveRender();
      };
      opts.appendChild(btn);
    }
    box.appendChild(opts);
    if (pending) {
      const other = el('div', 'ask-other');
      const inp = el('input', 'ask-input');
      inp.placeholder = '都不合适？自己写（回车提交）';
      inp.value = draft[qi].other;
      inp.oninput = () => {
        draft[qi].other = inp.value;
        if (!q.multiSelect && inp.value.trim()) draft[qi].picked.clear();
      };
      inp.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitAsk(b); }
      };
      other.appendChild(inp);
      box.appendChild(other);
    } else {
      // 自己填写的答案（不在选项里的部分）
      const extra = answered(q).filter((a) => !(q.options || []).some((o) => o.label === a));
      if (extra.length) box.appendChild(el('div', 'ask-mine', `你填写的：${esc(extra.join('，'))}`));
    }
    w.appendChild(box);
  });

  if (pending) {
    const foot = el('div', 'ask-foot');
    if (!single) {
      const ok = el('button', 'btn primary', '提交');
      ok.onclick = () => submitAsk(b);
      foot.appendChild(ok);
    }
    const skip = el('button', 'btn', '跳过');
    skip.title = '不回答，让 Claude 自己判断';
    skip.onclick = () => submitAsk(b, true);
    foot.appendChild(skip);
    foot.appendChild(el('span', 'ask-tip', single ? '点一个选项就会发给 Claude' : '选好后点提交'));
    w.appendChild(foot);
  } else if (state === 'expired') {
    w.appendChild(el('div', 'ask-tip', '这一轮已经结束，这个问题不能再回答了，可以直接发消息告诉 Claude 你的选择'));
  } else if (state === 'waiting') {
    w.appendChild(el('div', 'ask-tip', '正在等待…'));
  }
  return w;
}
