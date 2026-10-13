/* global el, esc, findSession, currentId, msgText, live, fmtMsgTime */
'use strict';

// 对话时间轴（左侧）：每条消息一段，长短和消息在对话里实际占的高度成比例，一眼看出哪条长；
// 整条轴就是一列首尾相接的小段：Claude 的回复是浅灰，你说的话是淡淡的主题色；当前在看的那段就是滑块（加宽、实色）。
// 不是滚动条：有一个标记吸附在「当前正在看的那条消息」的刻度上，随对话滚动带回弹地跳到下一条；
// 可以按住拖动（会被拉长），松手吸附到最近的刻度，对话同步滚过去。滚轮在上面一条一条地跳。
const timeline = {
  ticks: [],
  active: -1,
  dragging: false,
  rafBuild: 0,

  init() {
    this.root = document.querySelector('#timeline');
    this.scroller = document.querySelector('#scroller');
    this.box = document.querySelector('#messages');
    this.root.innerHTML = '<div class="tl-ticks"></div><div class="tl-handle"></div><div class="tl-tip hidden"></div>';
    this.rail = this.root.querySelector('.tl-ticks');
    this.handle = this.root.querySelector('.tl-handle');
    this.tip = this.root.querySelector('.tl-tip');
    this.scroller.addEventListener('scroll', () => { if (!this.dragging && !this.jumping) this.sync(); }, { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.box);
    new ResizeObserver(() => this.place()).observe(document.querySelector('#composer-wrap'));
    new MutationObserver(() => this.schedule()).observe(this.box, { childList: true });
    window.addEventListener('resize', () => { this.place(); this.schedule(); });
    this.root.addEventListener('mousemove', (e) => { if (!this.dragging) this.hover(e); });
    this.root.addEventListener('mouseleave', () => { if (!this.dragging) this.unhover(); });
    this.root.addEventListener('mousedown', (e) => this.startDrag(e));
    this.root.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.place();
  },

  place() {
    const top = document.querySelector('#topbar').offsetHeight;
    const bottom = document.querySelector('#composer-wrap').offsetHeight + (document.querySelector('#statusbar') ? document.querySelector('#statusbar').offsetHeight : 0);
    this.root.style.top = top + 12 + 'px';
    this.root.style.bottom = bottom + 12 + 'px';
  },

  schedule() {
    cancelAnimationFrame(this.rafBuild);
    this.rafBuild = requestAnimationFrame(() => this.build());
  },

  // 每段长度按消息高度分配；每段至少 MIN 像素，保证再短的消息也点得到；消息太多放不下时退回均匀分布
  build() {
    const s = findSession(currentId);
    const nodes = [...this.box.querySelectorAll(':scope > .msg:not(.queued)')];
    const show = s && nodes.length >= 3 && this.scroller.scrollHeight > this.scroller.clientHeight + 40;
    this.root.classList.toggle('hidden', !show);
    document.querySelector('#main').classList.toggle('has-timeline', !!show);
    if (!show) return;
    const h = this.root.clientHeight - 8;
    const MIN = 6;
    const end = this.box.scrollHeight;
    const lens = nodes.map((n, i) => Math.max(1, (i + 1 < nodes.length ? nodes[i + 1].offsetTop : end) - n.offsetTop));
    const total = lens.reduce((a, b) => a + b, 0);
    const spare = h - MIN * nodes.length;
    let y = 4;
    this.rail.innerHTML = '';
    this.ticks = nodes.map((n, i) => {
      const idx = Number(n.dataset.index);
      const m = s.messages[idx];
      const user = n.classList.contains('user');
      const len = spare > 0 ? MIN + (spare * lens[i]) / total : h / nodes.length;
      const top = Math.round(y);
      const size = Math.max(2, Math.round(y + len) - top - 2);
      y += len;
      const seg = el('div', 'tl-seg ' + (user ? 'u' : 'a'));
      seg.style.top = top + 'px';
      seg.style.height = size + 'px';
      this.rail.appendChild(seg);
      const text = m && typeof msgText === 'function' ? msgText(m) : '';
      // 时间：你的消息是发送时间，Claude 的是完成时间（还在回复的没有完成时间）
      const time = !m ? 0 : user ? m.ts : m.doneAt || 0;
      const pending = !!(m && !user && !m.doneAt && live[s.id] && idx === s.messages.length - 1);
      return { el: seg, seg, node: n, y: top, end: top + size, user, time, pending, text: text.replace(/\s+/g, ' ').trim().slice(0, 60) || (user ? '（文件）' : '（工具操作）') };
    });
    this.active = -1;
    this.sync(true);
  },

  // 当前在看的消息：视口顶部以下第一条（滚到底时取最后一条）
  currentIndex() {
    const top = this.scroller.scrollTop + 24;
    if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) return this.ticks.length - 1;
    let idx = 0;
    this.ticks.forEach((t, i) => { if (t.node.offsetTop <= top) idx = i; });
    return idx;
  },

  sync(instant) {
    if (!this.ticks.length) return;
    this.setActive(this.currentIndex(), instant);
  },

  setActive(i, instant) {
    if (i === this.active && !instant) return;
    this.active = i;
    const t = this.ticks[i];
    if (!t) return;
    this.handle.classList.toggle('instant', !!instant);
    this.handle.classList.toggle('u', t.user);
    this.handle.style.top = t.y + 'px';
    this.handle.style.height = t.end - t.y + 'px';
    this.handle.style.transform = '';
    this.ticks.forEach((x, k) => { x.el.classList.toggle('cur', k === i); x.seg.classList.toggle('cur', k === i); });
  },

  // 落在哪一段里就是哪条消息
  nearest(y) {
    let best = 0;
    this.ticks.forEach((t, i) => { if (y >= t.y - 2) best = i; });
    return best;
  },

  jumpTo(i) {
    const t = this.ticks[i];
    if (!t) return;
    this.jumping = true;
    clearTimeout(this.jumpTimer);
    this.scroller.scrollTo({ top: Math.max(0, t.node.offsetTop - 16), behavior: 'smooth' });
    this.jumpTimer = setTimeout(() => { this.jumping = false; }, 600);
    this.setActive(i);
    t.node.classList.add('flash');
    setTimeout(() => t.node.classList.remove('flash'), 1200);
  },

  hover(e) {
    const r = this.root.getBoundingClientRect();
    const y = e.clientY - r.top;
    const i = this.nearest(y);
    this.ticks.forEach((t, k) => {
      const d = k === i ? 0 : Math.min(Math.abs(t.y - y), Math.abs(t.end - y));
      t.el.style.setProperty('--k', Math.max(0, 1 - d / 60).toFixed(2));
    });
    this.showTip(i);
  },

  showTip(i) {
    const t = this.ticks[i];
    if (!t) return;
    this.ticks.forEach((x, k) => { x.el.classList.toggle('on', k === i); x.seg.classList.toggle('on', k === i); });
    this.tip.classList.remove('hidden');
    const when = t.pending ? '回复中' : t.time && typeof fmtMsgTime === 'function' ? (t.user ? '' : '完成于 ') + fmtMsgTime(t.time) : '';
    this.tip.innerHTML = `<div class="tl-tip-h"><b>${t.user ? '你' : 'Claude'}</b>${when ? `<span>${esc(when)}</span>` : ''}</div>${esc(t.text)}`;
    this.tip.style.top = Math.min(Math.max(0, t.y - 14), this.root.clientHeight - 40) + 'px';
  },

  unhover() {
    this.ticks.forEach((t) => { t.el.style.setProperty('--k', 0); t.el.classList.remove('on'); t.seg.classList.remove('on'); });
    this.tip.classList.add('hidden');
  },

  // 拖动：标记跟着鼠标走，速度越快被拉得越长；经过哪条刻度对话就同步到哪条；松手弹回吸附
  startDrag(e) {
    if (e.button !== 0 || !this.ticks.length) return;
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const y0 = e.clientY - r.top;
    const cur = this.ticks[this.active];
    const onHandle = !!cur && y0 >= cur.y - 6 && y0 <= cur.end + 6;
    if (!onHandle) { this.jumpTo(this.nearest(y0)); return; }
    this.dragging = true;
    this.root.classList.add('dragging');
    this.handle.classList.add('instant');
    let lastY = y0;
    let lastT = performance.now();
    let target = this.active;
    const move = (ev) => {
      const y = Math.max(0, Math.min(ev.clientY - r.top, this.root.clientHeight));
      const now = performance.now();
      const v = (y - lastY) / Math.max(1, now - lastT); // px/ms
      lastY = y;
      lastT = now;
      // 拖得越快滑块被拉得越长，松手弹回
      const stretch = Math.min(2.2, 1 + Math.abs(v) * 2);
      this.handle.style.top = y + 'px';
      this.handle.style.transform = `translateY(-50%) scaleY(${stretch.toFixed(2)})`;
      const i = this.nearest(y);
      if (i !== target) {
        target = i;
        const t = this.ticks[i];
        this.scroller.scrollTop = Math.max(0, t.node.offsetTop - 16);
        this.ticks.forEach((x, k) => { x.el.classList.toggle('cur', k === i); x.seg.classList.toggle('cur', k === i); });
      }
      this.showTip(i);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.dragging = false;
      this.root.classList.remove('dragging');
      this.handle.classList.remove('instant');
      this.active = -1;
      this.setActive(target);
      this.unhover();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  wheel(e) {
    if (!this.ticks.length) return;
    e.preventDefault();
    if (this.wheelLock) return;
    this.wheelLock = true;
    setTimeout(() => { this.wheelLock = false; }, 160);
    const next = Math.max(0, Math.min(this.ticks.length - 1, this.active + (e.deltaY > 0 ? 1 : -1)));
    this.jumpTo(next);
  },
};

timeline.init();
