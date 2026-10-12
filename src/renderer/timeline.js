/* global el, esc, findSession, currentId, msgText */
'use strict';

// 对话时间轴：右侧一条细轨道，AI 的回复画在左边，你说的话画在右边；
// 鼠标靠近时刻度放大并显示摘要，点击跳到对应消息。
const timeline = {
  ticks: [],
  rafBuild: 0,

  init() {
    this.root = document.querySelector('#timeline');
    this.scroller = document.querySelector('#scroller');
    this.box = document.querySelector('#messages');
    this.root.innerHTML = '<div class="tl-rail"></div><div class="tl-view"></div><div class="tl-ticks"></div><div class="tl-tip hidden"></div>';
    this.rail = this.root.querySelector('.tl-ticks');
    this.view = this.root.querySelector('.tl-view');
    this.tip = this.root.querySelector('.tl-tip');
    this.scroller.addEventListener('scroll', () => this.updateView(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.box);
    new ResizeObserver(() => this.place()).observe(document.querySelector('#composer-wrap'));
    new MutationObserver(() => this.schedule()).observe(this.box, { childList: true });
    window.addEventListener('resize', () => { this.place(); this.schedule(); });
    this.root.addEventListener('mousemove', (e) => this.hover(e));
    this.root.addEventListener('mouseleave', () => this.unhover());
    this.root.addEventListener('click', (e) => this.click(e));
    this.place();
  },

  // 轨道上下边界跟随顶栏和输入框
  place() {
    const top = document.querySelector('#topbar').offsetHeight;
    const bottom = document.querySelector('#composer-wrap').offsetHeight;
    this.root.style.top = top + 12 + 'px';
    this.root.style.bottom = bottom + 12 + 'px';
  },

  schedule() {
    cancelAnimationFrame(this.rafBuild);
    this.rafBuild = requestAnimationFrame(() => this.build());
  },

  build() {
    const s = findSession(currentId);
    const nodes = [...this.box.querySelectorAll(':scope > .msg')];
    const total = this.scroller.scrollHeight;
    const show = s && nodes.length >= 3 && total > this.scroller.clientHeight + 40;
    this.root.classList.toggle('hidden', !show);
    if (!show) return;
    const h = this.root.clientHeight;
    this.rail.innerHTML = '';
    this.ticks = nodes.map((n) => {
      const idx = Number(n.dataset.index);
      const m = s.messages[idx];
      const user = n.classList.contains('user');
      const y = Math.round(((n.offsetTop + 4) / total) * h);
      const t = el('div', 'tl-tick ' + (user ? 'u' : 'a'));
      t.style.top = y + 'px';
      this.rail.appendChild(t);
      const text = m ? (typeof msgText === 'function' ? msgText(m) : '') : '';
      return { el: t, node: n, y, user, text: text.replace(/\s+/g, ' ').trim().slice(0, 60) || (user ? '（文件）' : '（工具操作）') };
    });
    this.updateView();
  },

  updateView() {
    if (this.root.classList.contains('hidden')) return;
    const total = this.scroller.scrollHeight;
    const h = this.root.clientHeight;
    this.view.style.top = (this.scroller.scrollTop / total) * h + 'px';
    this.view.style.height = Math.max(8, (this.scroller.clientHeight / total) * h) + 'px';
  },

  nearest(y) {
    let best = null;
    for (const t of this.ticks) if (!best || Math.abs(t.y - y) < Math.abs(best.y - y)) best = t;
    return best;
  },

  hover(e) {
    const r = this.root.getBoundingClientRect();
    const y = e.clientY - r.top;
    // 鱼眼放大：离鼠标越近的刻度越长
    for (const t of this.ticks) {
      const d = Math.abs(t.y - y);
      const k = Math.max(0, 1 - d / 70);
      t.el.style.setProperty('--k', k.toFixed(2));
    }
    const t = this.nearest(y);
    this.ticks.forEach((x) => x.el.classList.toggle('on', x === t));
    if (!t) return;
    this.tip.classList.remove('hidden');
    this.tip.innerHTML = `<b>${t.user ? '你' : 'Claude'}</b>${esc(t.text)}`;
    this.tip.style.top = Math.min(Math.max(0, t.y - 14), r.height - 40) + 'px';
    this.root.classList.add('hot');
  },

  unhover() {
    this.ticks.forEach((t) => { t.el.style.setProperty('--k', 0); t.el.classList.remove('on'); });
    this.tip.classList.add('hidden');
    this.root.classList.remove('hot');
  },

  click(e) {
    const r = this.root.getBoundingClientRect();
    const t = this.nearest(e.clientY - r.top);
    if (!t) return;
    this.scroller.scrollTo({ top: Math.max(0, t.node.offsetTop - 16), behavior: 'smooth' });
    t.node.classList.add('flash');
    setTimeout(() => t.node.classList.remove('flash'), 1200);
  },
};

timeline.init();
