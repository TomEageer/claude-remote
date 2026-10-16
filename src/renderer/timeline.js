/* global esc, findSession, currentId, msgText, live, fmtMsgTime, api, data, msgWin, ensureMsgRendered */
'use strict';

// 对话时间轴（左侧），照着 macOS「时间机器」右边那条刻度做：
// 每条消息一根短横线，间距均匀（不再按消息长短把整条轴塞满——消息一多就挤成一坨）；消息少时紧凑地排在中间。
// 鼠标移上去，附近的刻度像程序坞那样放大、拉开间距，远处的收紧，几百条消息也能一条条点中；旁边显示那条消息的时间和开头。
// 你说的话刻度长一点、带主题色；当前在看的那条加长加深。点一下跳过去，按住上下拖一路翻，滚轮 / 方向键一条条跳。
// 放大中心不直接跳到鼠标上，而是像弹簧一样追过去：离得远先加速、快到了减速，追上后贴着鼠标走；放大和收起也是渐变的。
// 刻度按对话数据算（不看画面上有哪几条：长对话只画了一段），整条轴画在一块画布上：几千条消息也只是一个元素，每帧重画也不卡
const timeline = {
  ticks: [], // { idx, user, y, g }
  sid: null,
  active: -1,
  hoverI: -1,
  tipI: -1,
  dragging: false,
  focus: null, // 放大中心要去的地方（鼠标所在的高度），null 表示不放大
  fy: 0, // 放大中心现在在哪（追着 focus 走）
  fv: 0, // 追的速度
  amp: 0, // 放大程度 0~1（渐变进出）
  mouseY: null, // 鼠标在轴上的高度：提示跟着鼠标下那根刻度走
  rafBuild: 0,
  rafAnim: 0,

  SPACING: 8, // 放得下时每根刻度的间距
  ZOOM_SPACING: 14, // 放大中心处的间距
  SIGMA: 5, // 放大范围（按刻度数）

  init() {
    this.root = document.querySelector('#timeline');
    this.scroller = document.querySelector('#scroller');
    this.box = document.querySelector('#messages');
    this.root.innerHTML = '<canvas class="tl-canvas"></canvas><div class="tl-tip hidden"></div>';
    this.cv = this.root.querySelector('.tl-canvas');
    this.ctx = this.cv.getContext('2d');
    this.tip = this.root.querySelector('.tl-tip');
    this.scroller.addEventListener('scroll', () => { if (!this.dragging && !this.jumping) this.sync(); }, { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.box);
    new ResizeObserver(() => { this.resize(); this.layout(); }).observe(this.root);
    new ResizeObserver(() => this.place()).observe(document.querySelector('#composer-wrap'));
    new MutationObserver(() => this.schedule()).observe(this.box, { childList: true });
    window.addEventListener('resize', () => { this.place(); this.schedule(); });
    // 换了深浅色：刻度颜色跟着变
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors(); this.draw(); });
    this.root.addEventListener('mousemove', (e) => { if (!this.dragging) this.hover(e); });
    this.root.addEventListener('mouseleave', () => { if (!this.dragging) this.unhover(); });
    this.root.addEventListener('mousedown', (e) => { this.root.focus({ preventScroll: true }); this.startDrag(e); });
    this.root.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // 点过时间轴后可以用键盘翻：↑ ↓ 上一条 / 下一条，Home / End 第一条 / 最后一条，Esc 退出
    this.root.tabIndex = 0;
    this.root.addEventListener('keydown', (e) => this.key(e));
    this.root.addEventListener('blur', () => { if (!this.dragging) this.unhover(); });
    this.colors();
    this.place();
  },

  place() {
    const top = document.querySelector('#topbar').offsetHeight;
    const bottom = document.querySelector('#composer-wrap').offsetHeight + (document.querySelector('#statusbar') ? document.querySelector('#statusbar').offsetHeight : 0);
    this.root.style.top = top + 12 + 'px';
    this.root.style.bottom = bottom + 12 + 'px';
    this.resize();
    this.layout();
  },

  // 画布按屏幕像素密度放大，线条才清楚
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (!w || !h) return;
    if (this.cv.width === Math.round(w * dpr) && this.cv.height === Math.round(h * dpr)) return;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  colors() {
    const cs = getComputedStyle(this.root);
    const v = (k) => cs.getPropertyValue(k).trim();
    this.col = { t: v('--text'), t2: v('--text-2'), t3: v('--text-3'), acc: v('--accent') };
  },

  schedule() {
    cancelAnimationFrame(this.rafBuild);
    this.rafBuild = requestAnimationFrame(() => this.build());
  },

  build() {
    const s = findSession(currentId);
    const n = s ? s.messages.length : 0;
    const partial = msgWin.start > 0 || msgWin.end < n;
    const show = s && n >= 3 && (partial || this.scroller.scrollHeight > this.scroller.clientHeight + 40);
    this.root.classList.toggle('hidden', !show);
    document.querySelector('#main').classList.toggle('has-timeline', !!show);
    if (!show) { this.ticks = []; this.sid = null; return; }
    // 只有换了对话或条数变了才重算刻度；回复过程中每帧刷新最后一条不用重来
    if (this.sid !== s.id || this.ticks.length !== n) {
      if (this.sid !== s.id) { this.active = -1; this.hoverI = -1; }
      this.sid = s.id;
      this.ticks = s.messages.map((m, i) => ({ idx: i, user: m.role === 'user', y: 0, g: 0 }));
      this.colors();
      this.resize();
      this.layout();
    }
    if (!this.dragging && !this.jumping) this.sync(true);
  },

  // 提示里的内容用到时才取（几千条消息不用每次都提取文字）
  info(i) {
    const s = findSession(currentId);
    const m = s && s.messages[i];
    const user = !!(m && m.role === 'user');
    const text = m && typeof msgText === 'function' ? msgText(m) : '';
    // 时间：你的消息是发送时间，Claude 的是完成时间（还在回复的没有完成时间）
    const time = !m ? 0 : user ? m.ts : m.doneAt || 0;
    const pending = !!(m && !user && !m.doneAt && live[s.id] && i === s.messages.length - 1);
    return { user, time, pending, text: text.replace(/\s+/g, ' ').trim().slice(0, 60) || (user ? '（文件）' : '（工具操作）') };
  },

  // 摆刻度：不放大时均匀排开（放得下就用固定间距、整体居中，放不下就压紧铺满）；
  // 放大时按到中心的距离加权（高斯），中心附近间距拉开、远处压紧，被放大的那一片尽量停在鼠标下面
  layout() {
    const n = this.ticks.length;
    if (!n || !this.root) return;
    const H = Math.max(40, this.root.clientHeight - 8);
    const base = Math.min(this.SPACING, H / n);
    const span0 = base * n;
    const off0 = 4 + (H - span0) / 2;
    if (this.amp < 0.002) {
      this.ticks.forEach((t, i) => { t.y = off0 + base * (i + 0.5); t.g = 0; });
    } else {
      const f = Math.max(0, Math.min(n - 1, (this.fy - off0) / base - 0.5));
      const A = Math.max(0.8, this.ZOOM_SPACING / base - 1) * this.amp;
      const cut = this.SIGMA * 5; // 再远的放大系数小到可以当 0，省掉几千次指数运算
      const cum = new Float64Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const d = i - f;
        const e = d > cut || d < -cut ? 0 : Math.exp(-(d * d) / (2 * this.SIGMA ** 2));
        this.ticks[i].g = this.amp * e;
        const w = 1 + A * e;
        cum[i] = acc + w / 2;
        acc += w;
      }
      const span = Math.min(H, acc * base);
      const k = span / (acc * base);
      // 让放大中心对准它此刻的位置（按小数位置插值，移动时连续不跳格），再夹在轴的范围内
      const i0 = Math.floor(f);
      const i1 = Math.min(n - 1, i0 + 1);
      const cf = (cum[i0] + (cum[i1] - cum[i0]) * (f - i0)) * base * k;
      let start = this.fy - cf;
      start = Math.max(4, Math.min(4 + H - span, start));
      // 没放大时的位置和放大后的位置按放大程度混合：渐变进出时刻度不会整体跳一下
      const mix = Math.min(1, this.amp * 1.5);
      this.ticks.forEach((t, i) => { const p0 = off0 + base * (i + 0.5); t.y = p0 + (start + cum[i] * base * k - p0) * mix; });
    }
    this.draw();
  },

  // 画刻度：你的话长一点、主题色；当前在看的那条加长加深；鼠标下那条加粗
  draw() {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, this.root.clientWidth, this.root.clientHeight);
    const zoom = this.amp >= 0.002;
    const n = this.ticks.length;
    // 消息太多、刻度挤在一起时（间距不到 3 像素）：没被放大的那些每个像素只画一根、画淡一点，
    // 看起来是一片细密的刻度纹理，而不是糊成一根粗柱子
    const dense = n && this.root.clientHeight / n < 3;
    let row = -1;
    for (let i = 0; i < n; i++) {
      if (i === this.active || i === this.hoverI) continue;
      const t = this.ticks[i];
      const g = t.g;
      const packed = dense && g < 0.05;
      if (packed) {
        const r = Math.round(t.y);
        if (r === row) continue;
        row = r;
      }
      const w = (t.user ? 13 : 8) * (1 + 1.5 * g);
      const a0 = t.user ? (zoom ? 0.5 + 0.5 * g : 0.6) : zoom ? 0.45 + 0.45 * g : 0.55;
      c.globalAlpha = packed ? a0 * 0.45 : a0;
      c.fillStyle = t.user ? this.col.acc : this.col.t3;
      c.fillRect(6, packed ? t.y - 0.5 : t.y - 1, w, packed ? 1 : 2);
    }
    // 当前那条和鼠标下那条最后画，压在别的上面
    for (const i of [this.hoverI, this.active]) {
      const t = this.ticks[i];
      if (!t) continue;
      const cur = i === this.active;
      const w = (cur ? 20 : t.user ? 13 : 8) * (1 + 1.5 * t.g);
      c.globalAlpha = 1;
      c.fillStyle = t.user ? this.col.acc : cur ? this.col.t : this.col.t2;
      c.fillRect(6, t.y - 1.5, w, 3);
    }
    c.globalAlpha = 1;
  },

  setFocus(y) {
    // 从不放大开始：直接从鼠标处放大，不从上次的位置追过来
    if (y != null && this.amp < 0.05) { this.fy = y; this.fv = 0; }
    this.focus = y;
    this.animate();
  },

  // 每帧推一步：放大中心按临界阻尼弹簧追 focus（远了加速、近了减速、不过冲），放大程度指数渐变
  animate() {
    if (this.rafAnim) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const W = 22; // 越大追得越紧
      if (this.focus != null) {
        const acc = W * W * (this.focus - this.fy) - 2 * W * this.fv;
        this.fv += acc * dt;
        this.fy += this.fv * dt;
      }
      const to = this.focus != null ? 1 : 0;
      this.amp += (to - this.amp) * (1 - Math.exp(-dt * (to ? 14 : 10)));
      const settled = Math.abs(to - this.amp) < 0.002 && (this.focus == null || (Math.abs(this.focus - this.fy) < 0.2 && Math.abs(this.fv) < 2));
      if (settled) { this.amp = to; if (this.focus != null) { this.fy = this.focus; this.fv = 0; } }
      this.layout();
      if (this.mouseY != null && !this.tip.classList.contains('hidden')) this.showTip(this.dragging ? this.dragIndex : this.nearest(this.mouseY));
      this.rafAnim = settled ? 0 : requestAnimationFrame(step);
    };
    this.rafAnim = requestAnimationFrame(step);
  },

  // 当前在看的消息：画面里视口顶部以下第一条（滚到最新消息的底部时取最后一条）
  currentIndex() {
    const n = this.ticks.length;
    if (msgWin.end >= n && this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) return n - 1;
    const top = this.scroller.scrollTop + 24;
    let idx = msgWin.start;
    for (const node of this.box.querySelectorAll(':scope > .msg:not(.queued)')) {
      if (node.offsetTop <= top) idx = Number(node.dataset.index);
      else break;
    }
    return Math.max(0, Math.min(idx, n - 1));
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
    this.draw();
  },

  // 离鼠标最近的那根刻度（按当前摆好的位置算，放大后也准）；刻度从上到下排好了，二分查找
  nearest(y) {
    const t = this.ticks;
    if (!t.length) return 0;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid].y < y) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && Math.abs(t[lo - 1].y - y) <= Math.abs(t[lo].y - y) ? lo - 1 : lo;
  },

  // 滚到第 i 条（不在画面里的先画出来）
  scrollToMsg(i, smooth) {
    const node = ensureMsgRendered(i);
    if (!node) return null;
    this.scroller.scrollTo({ top: Math.max(0, node.offsetTop - 16), behavior: smooth ? 'smooth' : 'auto' });
    return node;
  },

  jumpTo(i) {
    if (!this.ticks[i]) return;
    this.jumping = true;
    clearTimeout(this.jumpTimer);
    const node = this.scrollToMsg(i, true);
    this.jumpTimer = setTimeout(() => { this.jumping = false; }, 600);
    this.setActive(i);
    if (node) {
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1200);
    }
  },

  yOf(e) {
    const r = this.root.getBoundingClientRect();
    return Math.max(0, Math.min(e.clientY - r.top, this.root.clientHeight));
  },

  hover(e) {
    const y = this.yOf(e);
    this.mouseY = y;
    this.setFocus(y);
    // 刻度还在往鼠标这边挪：先按现在的位置挑，之后每帧动画里再挑，提示始终对准鼠标下的那根
    this.showTip(this.nearest(y));
  },

  showTip(i) {
    const t = this.ticks[i];
    if (!t) return;
    if (this.hoverI !== i) { this.hoverI = i; this.draw(); }
    if (this.tipI !== i || this.tip.classList.contains('hidden')) {
      this.tipI = i;
      const x = this.info(i);
      const when = x.pending ? '回复中' : x.time && typeof fmtMsgTime === 'function' ? (x.user ? '' : '完成于 ') + fmtMsgTime(x.time) : '';
      this.tip.innerHTML = `<div class="tl-tip-h"><b>${x.user ? '你' : 'Claude'}</b>${when ? `<span>${esc(when)}</span>` : ''}</div>${esc(x.text)}`;
      this.tip.classList.remove('hidden');
    }
    this.tip.style.top = Math.min(Math.max(0, t.y - 16), this.root.clientHeight - 40) + 'px';
  },

  unhover() {
    this.mouseY = null;
    this.hoverI = -1;
    this.tipI = -1;
    this.tip.classList.add('hidden');
    this.setFocus(null);
    this.draw();
  },

  // 按住拖：放大跟着手走，经过哪根刻度对话就同步到哪条（触控板咔一下）；没怎么动就算点击，跳过去
  startDrag(e) {
    if (e.button !== 0 || !this.ticks.length) return;
    e.preventDefault();
    const y0 = this.yOf(e);
    let moved = false;
    let target = this.nearest(y0);
    this.dragIndex = target;
    this.mouseY = y0;
    this.dragging = true;
    this.root.classList.add('dragging');
    const move = (ev) => {
      const y = this.yOf(ev);
      if (Math.abs(y - y0) > 3) moved = true;
      if (!moved) return;
      this.mouseY = y;
      this.setFocus(y);
      const i = this.nearest(y);
      if (i !== target) {
        target = i;
        this.dragIndex = i;
        this.buzz();
        this.scrollToMsg(i, false);
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
