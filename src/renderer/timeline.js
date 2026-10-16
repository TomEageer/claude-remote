/* global el, esc, findSession, currentId, msgText, live, fmtMsgTime, api, data */
'use strict';

// 对话时间轴（左侧），照着 macOS「时间机器」右边那条刻度做：
// 每条消息一根短横线，间距均匀（不再按消息长短把整条轴塞满——消息一多就挤成一坨）；消息少时紧凑地排在中间。
// 鼠标移上去，附近的刻度像程序坞那样放大、拉开间距，远处的收紧，几百条消息也能一条条点中；旁边显示那条消息的时间和开头。
// 你说的话刻度长一点、带主题色；当前在看的那条加长加深。点一下跳过去，按住上下拖一路翻，滚轮 / 方向键一条条跳。
const timeline = {
  ticks: [],
  active: -1,
  dragging: false,
  focus: null, // 放大的中心（鼠标所在的高度），null 表示不放大
  rafBuild: 0,
  rafLayout: 0,

  SPACING: 8, // 放得下时每根刻度的间距
  ZOOM_SPACING: 14, // 放大中心处的间距
  SIGMA: 5, // 放大范围（按刻度数）

  init() {
    this.root = document.querySelector('#timeline');
    this.scroller = document.querySelector('#scroller');
    this.box = document.querySelector('#messages');
    this.root.innerHTML = '<div class="tl-ticks"></div><div class="tl-tip hidden"></div>';
    this.rail = this.root.querySelector('.tl-ticks');
    this.tip = this.root.querySelector('.tl-tip');
    this.scroller.addEventListener('scroll', () => { if (!this.dragging && !this.jumping) this.sync(); }, { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.box);
    new ResizeObserver(() => this.place()).observe(document.querySelector('#composer-wrap'));
    new MutationObserver(() => this.schedule()).observe(this.box, { childList: true });
    window.addEventListener('resize', () => { this.place(); this.schedule(); });
    this.root.addEventListener('mousemove', (e) => { if (!this.dragging) this.hover(e); });
    this.root.addEventListener('mouseleave', () => { if (!this.dragging) this.unhover(); });
    this.root.addEventListener('mousedown', (e) => { this.root.focus({ preventScroll: true }); this.startDrag(e); });
    this.root.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // 点过时间轴后可以用键盘翻：↑ ↓ 上一条 / 下一条，Home / End 第一条 / 最后一条，Esc 退出
    this.root.tabIndex = 0;
    this.root.addEventListener('keydown', (e) => this.key(e));
    this.root.addEventListener('blur', () => { if (!this.dragging) this.unhover(); });
    this.place();
  },

  place() {
    const top = document.querySelector('#topbar').offsetHeight;
    const bottom = document.querySelector('#composer-wrap').offsetHeight + (document.querySelector('#statusbar') ? document.querySelector('#statusbar').offsetHeight : 0);
    this.root.style.top = top + 12 + 'px';
    this.root.style.bottom = bottom + 12 + 'px';
    this.layout();
  },

  schedule() {
    cancelAnimationFrame(this.rafBuild);
    this.rafBuild = requestAnimationFrame(() => this.build());
  },

  build() {
    const s = findSession(currentId);
    const nodes = [...this.box.querySelectorAll(':scope > .msg:not(.queued)')];
    const show = s && nodes.length >= 3 && this.scroller.scrollHeight > this.scroller.clientHeight + 40;
    this.root.classList.toggle('hidden', !show);
    document.querySelector('#main').classList.toggle('has-timeline', !!show);
    if (!show) { this.ticks = []; return; }
    this.rail.innerHTML = '';
    this.ticks = nodes.map((n) => {
      const idx = Number(n.dataset.index);
      const m = s.messages[idx];
      const user = n.classList.contains('user');
      const tick = el('div', 'tl-tick ' + (user ? 'u' : 'a'));
      this.rail.appendChild(tick);
      const text = m && typeof msgText === 'function' ? msgText(m) : '';
      // 时间：你的消息是发送时间，Claude 的是完成时间（还在回复的没有完成时间）
      const time = !m ? 0 : user ? m.ts : m.doneAt || 0;
      const pending = !!(m && !user && !m.doneAt && live[s.id] && idx === s.messages.length - 1);
      return { el: tick, node: n, user, time, pending, y: 0, text: text.replace(/\s+/g, ' ').trim().slice(0, 60) || (user ? '（文件）' : '（工具操作）') };
    });
    this.active = -1;
    this.layout(true);
    this.sync(true);
  },

  // 摆刻度：不放大时均匀排开（放得下就用固定间距、整体居中，放不下就压紧铺满）；
  // 放大时按到中心的距离加权（高斯），中心附近间距拉开、远处压紧，被放大的那一片尽量停在鼠标下面
  layout(instant) {
    const n = this.ticks.length;
    if (!n || !this.root) return;
    const H = Math.max(40, this.root.clientHeight - 8);
    const base = Math.min(this.SPACING, H / n);
    const span0 = base * n;
    const off0 = 4 + (H - span0) / 2;
    const g = new Array(n).fill(0);
    let pos;
    if (this.focus == null) {
      pos = this.ticks.map((_, i) => off0 + base * (i + 0.5));
    } else {
      const f = Math.max(0, Math.min(n - 1, (this.focus - off0) / base - 0.5));
      const A = Math.max(0.8, this.ZOOM_SPACING / base - 1);
      const w = this.ticks.map((_, i) => { g[i] = Math.exp(-((i - f) ** 2) / (2 * this.SIGMA ** 2)); return 1 + A * g[i]; });
      const sum = w.reduce((a, b) => a + b, 0);
      const span = Math.min(H, sum * base);
      const k = span / (sum * base);
      let acc = 0;
      const cum = w.map((x) => { const c = acc + x / 2; acc += x; return c * base * k; });
      // 让放大中心对准鼠标，再夹在轴的范围内
      const fi = Math.round(f);
      let start = this.focus - cum[fi];
      start = Math.max(4, Math.min(4 + H - span, start));
      pos = cum.map((c) => start + c);
    }
    this.root.classList.toggle('zoom', this.focus != null);
    this.root.classList.toggle('instant', !!instant);
    this.ticks.forEach((t, i) => {
      t.y = pos[i];
      t.el.style.transform = `translateY(${pos[i].toFixed(1)}px)`;
      t.el.style.setProperty('--g', g[i].toFixed(3));
    });
  },

  setFocus(y) {
    this.focus = y;
    cancelAnimationFrame(this.rafLayout);
    this.rafLayout = requestAnimationFrame(() => this.layout());
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

  // macOS 触控板震一下：滚动、拖动、翻页经过每一条消息都「咔」一下，像在拨一个有刻度的滚轮
  buzz() {
    if (api.platform === 'darwin' && !(data.settings && data.settings.haptics === false)) api.haptic((data.settings && data.settings.hapticLevel) || 'strong');
  },

  setActive(i, instant, quiet) {
    if (i === this.active && !instant) return;
    if (!instant && !quiet && this.active >= 0) this.buzz();
    this.active = i;
    this.ticks.forEach((x, k) => x.el.classList.toggle('cur', k === i));
  },

  // 离鼠标最近的那根刻度（按当前摆好的位置算，放大后也准）
  nearest(y) {
    let best = 0;
    let d = Infinity;
    this.ticks.forEach((t, i) => { const dd = Math.abs(t.y - y); if (dd < d) { d = dd; best = i; } });
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

  yOf(e) {
    const r = this.root.getBoundingClientRect();
    return Math.max(0, Math.min(e.clientY - r.top, this.root.clientHeight));
  },

  hover(e) {
    const y = this.yOf(e);
    this.setFocus(y);
    // 放大是下一帧才摆好的：先按旧位置挑，摆好后再挑一次，保证提示对准鼠标下的那根
    this.showTip(this.nearest(y));
    requestAnimationFrame(() => requestAnimationFrame(() => { if (this.focus != null) this.showTip(this.nearest(y)); }));
  },

  showTip(i) {
    const t = this.ticks[i];
    if (!t) return;
    this.ticks.forEach((x, k) => x.el.classList.toggle('on', k === i));
    this.tip.classList.remove('hidden');
    const when = t.pending ? '回复中' : t.time && typeof fmtMsgTime === 'function' ? (t.user ? '' : '完成于 ') + fmtMsgTime(t.time) : '';
    this.tip.innerHTML = `<div class="tl-tip-h"><b>${t.user ? '你' : 'Claude'}</b>${when ? `<span>${esc(when)}</span>` : ''}</div>${esc(t.text)}`;
    this.tip.style.top = Math.min(Math.max(0, t.y - 16), this.root.clientHeight - 40) + 'px';
  },

  unhover() {
    this.ticks.forEach((t) => t.el.classList.remove('on'));
    this.tip.classList.add('hidden');
    this.setFocus(null);
  },

  // 按住拖：放大跟着手走，经过哪根刻度对话就同步到哪条（触控板咔一下）；没怎么动就算点击，跳过去
  startDrag(e) {
    if (e.button !== 0 || !this.ticks.length) return;
    e.preventDefault();
    const y0 = this.yOf(e);
    let moved = false;
    let target = this.nearest(y0);
    this.dragging = true;
    this.root.classList.add('dragging');
    const move = (ev) => {
      const y = this.yOf(ev);
      if (Math.abs(y - y0) > 3) moved = true;
      if (!moved) return;
      this.setFocus(y);
      const i = this.nearest(y);
      if (i !== target) {
        target = i;
        this.buzz();
        this.scroller.scrollTop = Math.max(0, this.ticks[i].node.offsetTop - 16);
        this.setActive(i, true, true);
      }
      this.showTip(i);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.dragging = false;
      this.root.classList.remove('dragging');
      if (moved) { this.active = -1; this.setActive(target, false, true); }
      else this.jumpTo(target);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  },

  key(e) {
    if (!this.ticks.length) return;
    const last = this.ticks.length - 1;
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(last, this.active + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(0, this.active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.root.blur(); return; }
    if (next == null) return;
    e.preventDefault();
    if (next !== this.active) this.jumpTo(next);
    // 键盘翻的时候放大跟着当前这条走
    this.setFocus(this.ticks[next].y);
    this.showTip(next);
  },

  wheel(e) {
    if (!this.ticks.length) return;
    e.preventDefault();
    if (this.wheelLock) return;
    this.wheelLock = true;
    setTimeout(() => { this.wheelLock = false; }, 160);
    const next = Math.max(0, Math.min(this.ticks.length - 1, this.active + (e.deltaY > 0 ? 1 : -1)));
    this.jumpTo(next);
    this.setFocus(this.ticks[next].y);
    this.showTip(next);
  },
};

timeline.init();
