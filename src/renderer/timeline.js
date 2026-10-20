/* global esc, findSession, currentId, msgText, live, api, data, msgWin, ensureMsgRendered */
'use strict';

// 对话时间轴（左侧），照着 macOS「时间机器」右边那条刻度做。
// 只给你的提问画刻度（每轮一根，Claude 的回复就在两根之间）：长对话的刻度少一半以上，要找的也正是「我当时问了什么」。
// 刻度永远是舒服的固定间距：放得下就整体居中；放不下也不压缩，而是只显示你正在看的那一段，跟着阅读位置平滑滑动，
// 上下两头淡出表示前后还有。鼠标移上去附近的刻度像程序坞那样放大、拉开，放大中心像弹簧一样追着鼠标走；
// 点一下跳过去，按住拖一路翻（拖到上下边缘会自动往前 / 往后翻），滚轮、方向键一轮一轮跳。
// 整条轴画在一块画布上，几千轮也只是一个元素。
const timeline = {
  ticks: [], // { idx: 消息序号, y, g }
  sid: null,
  active: -1, // 当前在看的那一轮（刻度序号）
  hoverI: -1,
  tipI: -1,
  dragging: false,
  focus: null, // 放大中心要去的地方（鼠标所在的高度），null 表示不放大
  fy: 0, // 放大中心现在在哪（追着 focus 走）
  fv: 0,
  amp: 0, // 放大程度 0~1（渐变进出）
  mouseY: null,
  view: 0, // 放不下时：最上面那根刻度的序号（小数，平滑滑动）
  viewTo: 0,
  rafBuild: 0,
  rafAnim: 0,
  // 橡皮筋：只有按下去抓住的那一根刻度跟着鼠标上下走（保持水平），其余刻度不动；拉过头或松手后弹回原位，抖几下
  band: -1, // 被抓住的刻度序号
  pullY: 0, // 这根线离开原位多少（像素，带正负）
  vY: 0,
  toY: 0,
  snapped: false, // 拉过头「啪」地弹断了，这次拖动里不再拉

  SPACING: 9, // 每轮刻度的间距
  ZOOM_SPACING: 16, // 放大中心处的间距
  SIGMA: 3.5, // 放大范围（按刻度数）
  EDGE: 22, // 上下淡出的高度；拖到这里自动翻
  PULL_FREE: 40, // 鼠标离开原位这么远以内，线和鼠标一一对应地跟着走
  PULL_MAX: 110, // 再往外越拉越费劲，线最多被拉离原位这么远
  PULL_SNAP: 150, // 鼠标离开原位超过这么远，弹回去

  init() {
    this.root = document.querySelector('#timeline');
    this.scroller = document.querySelector('#scroller');
    this.box = document.querySelector('#messages');
    this.root.innerHTML = '<canvas class="tl-canvas"></canvas><div class="tl-tip hidden"></div>';
    this.cv = this.root.querySelector('.tl-canvas');
    this.ctx = this.cv.getContext('2d');
    this.tip = this.root.querySelector('.tl-tip');
    // 滚动对话：每经过一条消息（不只是时间轴上按轮的刻度）震一下；触控板的震感只有手指还在板上时才感觉得到，惯性滑动阶段系统不震
    // 只认人手滚的（滚轮 / 触控板事件之后紧接着的滚动）：回复刷新时自动跟到底部的滚动不震
    this.scroller.addEventListener('wheel', () => { this.wheelAt = Date.now(); }, { passive: true });
    this.scroller.addEventListener('scroll', () => {
      if (this.dragging || this.jumping) return;
      const idx = this.topMessage();
      const user = Date.now() - (this.wheelAt || 0) < 200;
      if (this.lastTop != null && idx !== this.lastTop && user) this.buzz();
      this.lastTop = idx;
      this.sync(false, !user);
    }, { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.box);
    new ResizeObserver(() => { this.resize(); this.layout(); }).observe(this.root);
    new ResizeObserver(() => this.place()).observe(document.querySelector('#composer-wrap'));
    new MutationObserver(() => this.schedule()).observe(this.box, { childList: true });
    window.addEventListener('resize', () => { this.place(); this.schedule(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors(); this.draw(); });
    this.root.addEventListener('mousemove', (e) => { if (!this.dragging) this.hover(e); });
    this.root.addEventListener('mouseleave', () => { if (!this.dragging) this.unhover(); });
    this.root.addEventListener('mousedown', (e) => { this.root.focus({ preventScroll: true }); this.startDrag(e); });
    this.root.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
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
    const users = s ? s.messages.reduce((a, m, i) => (m.role === 'user' ? (a.push(i), a) : a), []) : [];
    const show = s && users.length >= 2 && (partial || this.scroller.scrollHeight > this.scroller.clientHeight + 40);
    this.root.classList.toggle('hidden', !show);
    document.querySelector('#main').classList.toggle('has-timeline', !!show);
    if (!show) { this.ticks = []; this.sid = null; this.lastTop = null; return; }
    // 只有换了对话或轮数变了才重算刻度
    if (this.sid !== s.id || this.ticks.length !== users.length) {
      const fresh = this.sid !== s.id;
      this.sid = s.id;
      this.ticks = users.map((idx) => ({ idx, y: 0, g: 0 }));
      if (fresh) { this.active = -1; this.hoverI = -1; this.view = this.viewTo = Math.max(0, users.length - this.cap()); }
      this.colors();
      this.resize();
      this.layout();
    }
    if (!this.dragging && !this.jumping) this.sync(true);
  },

  H() { return Math.max(40, this.root.clientHeight); },
  cap() { return Math.max(1, Math.floor((this.H() - 8) / this.SPACING)); }, // 一屏放得下几根
  scrolling() { return this.ticks.length > this.cap(); },

  // 第 k 轮：你问了什么、什么时候问的、Claude 回了什么（提示里用，用到时才取）
  info(k) {
    const s = findSession(currentId);
    const t = this.ticks[k];
    const m = s && t && s.messages[t.idx];
    const next = s && t && s.messages[t.idx + 1];
    const q = (m && typeof msgText === 'function' ? msgText(m) : '').replace(/\s+/g, ' ').trim();
    const a = (next && next.role === 'assistant' && typeof msgText === 'function' ? msgText(next) : '').replace(/\s+/g, ' ').trim();
    const pending = !!(next && next.role === 'assistant' && !next.doneAt && live[s.id] && t.idx + 1 === s.messages.length - 1);
    const took = next && next.role === 'assistant' && next.doneAt && m && m.ts ? next.doneAt - m.ts : 0;
    return { n: k + 1, total: this.ticks.length, time: m ? m.ts : 0, took, q: q.slice(0, 60) || '（文件）', a: pending ? '回复中…' : a.slice(0, 50) };
  },

  // 完整日期时间：2026年10月16日 周五 23:36（今天 / 昨天再标出来）
  when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
    const rel = diff === 0 ? '（今天）' : diff === 1 ? '（昨天）' : '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}${rel}`;
  },
  dur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  },

  // 摆刻度：固定间距。放得下就整体居中；放不下就从 view 那根开始往下排（超出的画在画布外面，看不见）。
  // 放大时按到中心的距离加权（高斯），中心附近间距拉开，被放大的那一片停在鼠标下面
  layout() {
    const n = this.ticks.length;
    if (!n || !this.root) return;
    const H = this.H();
    const S = this.SPACING;
    const scroll = this.scrolling();
    const off0 = scroll ? 4 - this.view * S : 4 + (H - 8 - S * n) / 2;
    const base = (i) => off0 + S * (i + 0.5);
    if (this.amp < 0.002) {
      this.ticks.forEach((t, i) => { t.y = base(i); t.g = 0; });
    } else {
      const f = Math.max(0, Math.min(n - 1, (this.fy - off0) / S - 0.5));
      const A = (this.ZOOM_SPACING / S - 1) * this.amp;
      const cut = this.SIGMA * 5;
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
      const i0 = Math.floor(f);
      const i1 = Math.min(n - 1, i0 + 1);
      const cf = (cum[i0] + (cum[i1] - cum[i0]) * (f - i0)) * S;
      let start = this.fy - cf;
      // 放得下时：整串以原来的中心向两边撑开，不跟着鼠标跑（轮数少时整串被拖到鼠标那边，手感发黏）；也别超出轴
      if (!scroll) start = Math.max(4, Math.min(H - 4 - acc * S, off0 + (S * n - acc * S) / 2));
      const mix = Math.min(1, this.amp * 1.5);
      this.ticks.forEach((t, i) => { const p0 = base(i); t.y = p0 + (start + cum[i] * S - p0) * mix; });
    }
    this.draw();
  },

  draw() {
    const c = this.ctx;
    if (!c) return;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    c.clearRect(0, 0, W, H);
    const zoom = this.amp >= 0.002;
    const n = this.ticks.length;
    const shown = (t) => t.y > -4 && t.y < H + 4;
    for (let i = 0; i < n; i++) {
      if (i === this.active || i === this.hoverI || i === this.band) continue;
      const t = this.ticks[i];
      if (!shown(t)) continue;
      const g = t.g;
      c.globalAlpha = zoom ? 0.5 + 0.5 * g : 0.6;
      c.fillStyle = this.col.acc;
      c.fillRect(6, t.y - 1, 12 * (1 + 1.2 * g), 2);
    }
    c.globalAlpha = 1;
    // 放不下时：上下两头淡出，表示前后还有（当前那根和鼠标下那根最后画，不被淡掉）
    if (this.scrolling()) {
      const E = this.EDGE;
      c.save();
      c.globalCompositeOperation = 'destination-out';
      if (this.view > 0.05) {
        const g1 = c.createLinearGradient(0, 0, 0, E);
        g1.addColorStop(0, 'rgba(0,0,0,1)');
        g1.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g1;
        c.fillRect(0, 0, W, E);
      }
      if (this.view < n - this.cap() - 0.05) {
        const g2 = c.createLinearGradient(0, H - E, 0, H);
        g2.addColorStop(0, 'rgba(0,0,0,0)');
        g2.addColorStop(1, 'rgba(0,0,0,1)');
        c.fillStyle = g2;
        c.fillRect(0, H - E, W, E);
      }
      c.restore();
    }
    for (const i of [this.hoverI, this.active]) {
      const t = this.ticks[i];
      if (!t || !shown(t) || i === this.band) continue;
      const cur = i === this.active;
      c.globalAlpha = 1;
      c.fillStyle = cur ? this.col.t : this.col.acc;
      c.fillRect(6, t.y - 1.5, (cur ? 20 : 12) * (1 + 1.2 * t.g), 3);
    }
    // 被抓住的那一根：保持水平，上下跟着鼠标走（带弹性，会滞后、过头），其余刻度不动
    const bt = this.ticks[this.band];
    if (bt && (Math.abs(this.pullY) > 0.3 || this.dragging)) {
      const cur = this.band === this.active;
      c.globalAlpha = 1;
      c.fillStyle = cur ? this.col.t : this.col.acc;
      c.fillRect(6, bt.y + this.pullY - (cur ? 1.5 : 1), (cur ? 20 : 12) * (1 + 1.2 * bt.g), cur ? 3 : 2);
    } else if (bt) {
      c.fillStyle = this.band === this.active ? this.col.t : this.col.acc;
      c.fillRect(6, bt.y - 1, 12 * (1 + 1.2 * bt.g), 2);
    }
  },

  setFocus(y) {
    if (y != null && this.amp < 0.05) { this.fy = y; this.fv = 0; }
    this.focus = y;
    this.animate();
  },

  // 让第 k 根刻度留在能看见的范围里（离上下边缘至少 3 根），轴平滑滑过去
  follow(k) {
    if (!this.scrolling()) return;
    const C = this.cap();
    const m = Math.min(3, Math.floor(C / 4));
    let v = this.viewTo;
    if (k < v + m) v = k - m;
    if (k > v + C - 1 - m) v = k - C + 1 + m;
    this.viewTo = Math.max(0, Math.min(this.ticks.length - C, v));
    if (Math.abs(this.viewTo - this.view) > 0.01) this.animate();
  },

  // 每帧推一步：放大中心按临界阻尼弹簧追鼠标；放大程度渐变；放不下时轴滑向目标位置；拖到边缘时自动翻
  animate() {
    if (this.rafAnim) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const W = 22;
      if (this.focus != null) {
        const acc = W * W * (this.focus - this.fy) - 2 * W * this.fv;
        this.fv += acc * dt;
        this.fy += this.fv * dt;
      }
      // 橡皮筋：欠阻尼弹簧追着「手拉出的长度」，松手后目标回到 0，越过去再弹回来
      this.vY += (700 * (this.toY - this.pullY) - 13 * this.vY) * dt;
      this.pullY += this.vY * dt;
      const to = this.focus != null ? 1 : 0;
      this.amp += (to - this.amp) * (1 - Math.exp(-dt * (to ? 14 : 10)));
      // 鼠标停在（或拖到）上下边缘：轴一直往前 / 往后翻，越靠边、停得越久越快。悬停时只翻轴，点了才跳过去
      const edgeOn = this.scrolling() && this.mouseY != null;
      if (edgeOn) {
        const E = this.EDGE;
        const H = this.H();
        const d = this.mouseY < E ? -(E - this.mouseY) / E : this.mouseY > H - E ? (this.mouseY - (H - E)) / E : 0;
        // 按得越久翻得越快：起步每秒 25 轮，按住 2 秒后约每秒 250 轮
        if (d) { this.edgeHold = (this.edgeHold || 0) + dt; this.viewTo = Math.max(0, Math.min(this.ticks.length - this.cap(), this.viewTo + d * 25 * (1 + this.edgeHold * this.edgeHold * 2.5) * dt)); }
        else this.edgeHold = 0;
      }
      // 在边缘翻页时轴直接跟上，平时平滑滑过去
      this.view += (this.viewTo - this.view) * (this.edgeHold ? 1 : 1 - Math.exp(-dt * 12));
      if (Math.abs(this.viewTo - this.view) < 0.005) this.view = this.viewTo;
      const pullIdle = Math.abs(this.pullY - this.toY) < 0.05 && Math.abs(this.vY) < 1;
      if (pullIdle) { this.pullY = this.toY; this.vY = 0; if (!this.dragging && !this.toY) this.band = -1; }
      const settled = pullIdle && Math.abs(to - this.amp) < 0.002 && (this.focus == null || (Math.abs(this.focus - this.fy) < 0.2 && Math.abs(this.fv) < 2))
        && this.view === this.viewTo && !(edgeOn && (this.mouseY < this.EDGE || this.mouseY > this.H() - this.EDGE));
      if (Math.abs(to - this.amp) < 0.002) this.amp = to;
      if (settled && this.focus != null) { this.fy = this.focus; this.fv = 0; }
      this.layout();
      if (this.dragging) this.dragTo(this.mouseY);
      else if (this.mouseY != null && !this.tip.classList.contains('hidden')) this.showTip(this.nearest(this.mouseY));
      this.rafAnim = settled ? 0 : requestAnimationFrame(step);
    };
    this.rafAnim = requestAnimationFrame(step);
  },

  // 消息序号 → 它属于哪一轮（之前最近的一次提问）
  tickOf(msgIdx) {
    const t = this.ticks;
    let lo = 0;
    let hi = t.length - 1;
    let k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid].idx <= msgIdx) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return k;
  },

  // 视口顶部附近那条消息的编号
  topMessage() {
    const top = this.scroller.scrollTop + 24;
    let idx = msgWin.start;
    for (const node of this.box.querySelectorAll(':scope > .msg:not(.queued)')) {
      if (node.offsetTop <= top) idx = Number(node.dataset.index);
      else break;
    }
    return idx;
  },
  // 当前在看的那一轮：画面里视口顶部附近那条消息所在的轮（滚到最底时取最后一轮）
  currentIndex() {
    const n = this.ticks.length;
    const s = findSession(currentId);
    if (s && msgWin.end >= s.messages.length && this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) return n - 1;
    return this.tickOf(this.topMessage());
  },

  sync(instant, quiet) {
    if (!this.ticks.length) return;
    const k = this.currentIndex();
    this.setActive(k, instant, quiet);
    if (!this.dragging) this.follow(k);
  },

  buzz() {
    if (api.platform === 'darwin' && !(data.settings && data.settings.haptics === false)) api.haptic((data.settings && data.settings.hapticLevel) || 'strong');
  },

  setActive(i, instant, quiet) {
    if (i === this.active && !instant) return;
    if (!instant && !quiet && this.active >= 0) this.buzz();
    this.active = i;
    this.draw();
  },

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

  // 滚到第 k 轮（不在画面里的先画出来）
  scrollToTick(k, smooth) {
    const t = this.ticks[k];
    const node = t && ensureMsgRendered(t.idx);
    if (!node) return null;
    this.scroller.scrollTo({ top: Math.max(0, node.offsetTop - 16), behavior: smooth ? 'smooth' : 'auto' });
    return node;
  },

  jumpTo(k) {
    if (!this.ticks[k]) return;
    this.jumping = true;
    clearTimeout(this.jumpTimer);
    const node = this.scrollToTick(k, true);
    this.jumpTimer = setTimeout(() => { this.jumping = false; }, 600);
    this.setActive(k);
    this.follow(k);
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
    this.showTip(this.nearest(y));
  },

  showTip(k) {
    const t = this.ticks[k];
    if (!t) return;
    if (this.hoverI !== k) { this.hoverI = k; this.draw(); }
    if (this.tipI !== k || this.tip.classList.contains('hidden')) {
      this.tipI = k;
      const x = this.info(k);
      const when = this.when(x.time);
      this.tip.innerHTML = `<div class="tl-tip-h"><b>第 ${x.n} / ${x.total} 轮</b>${x.took ? `<span>回复用了 ${esc(this.dur(x.took))}</span>` : ''}</div>${when ? `<div class="tl-when">${esc(when)}</div>` : ''}<div class="tl-q">${esc(x.q)}</div>${x.a ? `<div class="tl-a">${esc(x.a)}</div>` : ''}`;
      this.tip.classList.remove('hidden');
    }
    this.tip.style.top = Math.min(Math.max(0, t.y - 16), this.root.clientHeight - this.tip.offsetHeight) + 'px';
  },

  unhover() {
    this.mouseY = null;
    this.edgeHold = 0;
    // 鼠标离开：轴滑回你正在看的那一段
    if (this.active >= 0) this.follow(this.active);
    this.hoverI = -1;
    this.tipI = -1;
    this.tip.classList.add('hidden');
    this.setFocus(null);
    this.draw();
  },

  // 拖动中：鼠标下那一轮变了就滚过去（触控板咔一下）
  dragTo(y) {
    if (!this.dragMoved || y == null) return;
    const k = this.nearest(y);
    if (k !== this.dragIndex) {
      this.dragIndex = k;
      this.buzz();
      this.scrollToTick(k, false);
      this.setActive(k, true, true);
    }
    this.showTip(k);
  },

  startDrag(e) {
    if (e.button !== 0 || !this.ticks.length) return;
    e.preventDefault();
    const y0 = this.yOf(e);
    this.dragMoved = false;
    this.dragIndex = this.nearest(y0);
    this.mouseY = y0;
    this.dragging = true;
    this.root.classList.add('dragging');
    this.snapped = false;
    this.band = this.dragIndex;
    this.toY = 0;
    const move = (ev) => {
      const y = this.yOf(ev);
      if (Math.abs(y - y0) > 3) this.dragMoved = true;
      if (!this.dragMoved) return;
      // 近处线和鼠标一一对应地跟着走，再远就越来越费劲；拉过头弹回原位
      const bt = this.ticks[this.band];
      if (bt) {
        const oy = y - bt.y;
        const d = Math.abs(oy);
        if (!this.snapped && d > this.PULL_SNAP) { this.snapped = true; this.buzz(); }
        const F = this.PULL_FREE;
        const eased = d <= F ? d : F + (this.PULL_MAX - F) * (1 - Math.exp(-(d - F) / (this.PULL_MAX - F)));
        this.toY = this.snapped ? 0 : Math.sign(oy) * eased;
      }
      this.mouseY = y;
      this.setFocus(y);
      this.animate();
      this.dragTo(y);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.dragging = false;
      this.toY = 0;
      this.snapped = false;
      this.animate();
      this.root.classList.remove('dragging');
      if (this.dragMoved) { this.active = -1; this.setActive(this.dragIndex, false, true); this.follow(this.dragIndex); }
      else this.jumpTo(this.dragIndex);
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
    requestAnimationFrame(() => { this.setFocus(this.ticks[next].y); this.showTip(next); });
  },

  wheel(e) {
    if (!this.ticks.length) return;
    e.preventDefault();
    if (this.wheelLock) return;
    this.wheelLock = true;
    setTimeout(() => { this.wheelLock = false; }, 160);
    const next = Math.max(0, Math.min(this.ticks.length - 1, this.active + (e.deltaY > 0 ? 1 : -1)));
    this.jumpTo(next);
    requestAnimationFrame(() => { this.setFocus(this.ticks[next].y); this.showTip(next); });
  },
};

timeline.init();
