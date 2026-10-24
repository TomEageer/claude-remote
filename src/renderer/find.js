/* global $, el, icon, msgWin, findSession, currentId */
'use strict';

// 对话内查找（⌘F / Ctrl+F）：只在当前对话的消息里找，命中的地方用浏览器的高亮接口（CSS Custom Highlight）标出来，
// 不改消息的 DOM；回车下一个、Shift+回车上一个、Esc 关闭。消息还在更新时命中位置会跟着刷新
const chatFind = {
  bar: null,
  input: null,
  count: null,
  ranges: [],
  cur: -1,
  timer: null,
  observer: null,
  get open() { return !!(this.bar && !this.bar.hidden); },

  mount() {
    if (this.bar) return;
    const wrap = el('div', 'findbar-wrap');
    wrap.innerHTML = `<div class="findbar" role="search">
      <input id="find-input" type="text" placeholder="在对话里查找" spellcheck="false" autocomplete="off" />
      <span class="find-count"></span>
      <button class="icon-btn find-prev" title="上一个（Shift+回车）">${icon('chevronUp')}</button>
      <button class="icon-btn find-next" title="下一个（回车）">${icon('chevronDown')}</button>
      <button class="icon-btn find-close" title="关闭（Esc）">${icon('close')}</button>
    </div>`;
    const scroller = $('#scroller');
    scroller.insertBefore(wrap, scroller.firstChild);
    wrap.hidden = true;
    this.bar = wrap;
    this.input = wrap.querySelector('#find-input');
    this.count = wrap.querySelector('.find-count');
    this.input.addEventListener('input', () => this.schedule());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.go(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    wrap.querySelector('.find-prev').onclick = () => this.go(-1);
    wrap.querySelector('.find-next').onclick = () => this.go(1);
    wrap.querySelector('.find-close').onclick = () => this.close();
    // 回复还在更新、切换了对话：命中位置重新算
    this.observer = new MutationObserver(() => { if (this.open) this.schedule(); });
  },

  show(prefill) {
    this.mount();
    this.bar.hidden = false;
    this.observer.observe($('#messages'), { childList: true, subtree: true, characterData: true });
    if (prefill) this.input.value = prefill;
    this.input.focus();
    this.input.select();
    this.search();
  },
  close() {
    if (!this.open) return;
    this.bar.hidden = true;
    this.observer.disconnect();
    this.clear();
    const inp = $('#input');
    if (inp) inp.focus();
  },
  clear() {
    this.ranges = [];
    this.cur = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('cr-find'); CSS.highlights.delete('cr-find-cur'); }
    this.count.textContent = '';
  },
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(true), 80);
  },

  // 把 #messages 里所有看得见的文字节点扫一遍，记下每个命中的范围
  search(keep) {
    const q = this.input.value.trim().toLowerCase();
    const prevIndex = keep ? this.cur : -1;
    const prevNode = keep && this.ranges[this.cur] ? this.ranges[this.cur].startContainer : null;
    this.ranges = [];
    this.cur = -1;
    if (!q || !(window.CSS && CSS.highlights && typeof Highlight === 'function')) { this.clear(); if (q && !(window.CSS && CSS.highlights)) this.count.textContent = '不支持'; return; }
    const root = $('#messages');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || !n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest('.findbar-wrap, script, style, textarea')) return NodeFilter.FILTER_REJECT;
        if (!p.getClientRects().length) return NodeFilter.FILTER_REJECT; // 折叠起来的工具内容等看不见的
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const text = n.nodeValue.toLowerCase();
      let i = text.indexOf(q);
      while (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        this.ranges.push(r);
        i = text.indexOf(q, i + q.length);
      }
    }
    CSS.highlights.set('cr-find', new Highlight(...this.ranges));
    this.outside = this.countOutside(q);
    if (!this.ranges.length) { CSS.highlights.delete('cr-find-cur'); this.count.textContent = this.outside ? `这一段没有 · 更早 ${this.outside} 条消息里有` : '无结果'; return; }
    // 内容刷新后尽量停在原来那个命中上，不然从离屏幕中间最近的开始
    let start = prevNode ? this.ranges.findIndex((r) => r.startContainer === prevNode) : -1;
    if (start < 0 && prevIndex >= 0) start = Math.min(prevIndex, this.ranges.length - 1);
    if (start < 0) start = this.nearest();
    this.cur = start - 1;
    this.go(1, keep);
  },
  // 很长的对话只画了一段：没画出来的更早消息里有没有（往上滚加载后才能定位到）
  countOutside(q) {
    if (typeof msgWin === 'undefined' || typeof findSession !== 'function' || typeof currentId === 'undefined' || !currentId) return 0;
    const s = findSession(currentId);
    if (!s || !msgWin.start) return 0;
    let n = 0;
    for (const m of s.messages.slice(0, msgWin.start)) {
      const parts = [m.text || '', m.error || ''].concat((m.blocks || []).map((b) => b.type === 'text' ? b.text || '' : ''));
      if (parts.join('\n').toLowerCase().includes(q)) n++;
    }
    return n;
  },
  nearest() {
    const sc = $('#scroller').getBoundingClientRect();
    const mid = sc.top + sc.height / 2;
    let best = 0, bestD = Infinity;
    this.ranges.forEach((r, i) => { const d = Math.abs(r.getBoundingClientRect().top - mid); if (d < bestD) { bestD = d; best = i; } });
    return best;
  },
  go(dir, noScroll) {
    if (!this.ranges.length) return;
    this.cur = (this.cur + dir + this.ranges.length) % this.ranges.length;
    const r = this.ranges[this.cur];
    CSS.highlights.set('cr-find-cur', new Highlight(r));
    this.count.textContent = `${this.cur + 1} / ${this.ranges.length}` + (this.outside ? ` · 更早还有 ${this.outside} 条` : '');
    const rect = r.getBoundingClientRect();
    const sc = $('#scroller');
    const box = sc.getBoundingClientRect();
    if (!noScroll || rect.top < box.top + 60 || rect.bottom > box.bottom - 40) sc.scrollTop += rect.top - (box.top + box.height / 2);
  },
};

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || e.altKey || e.shiftKey) return;
  // 弹窗、预览开着时让它们自己处理
  if (document.querySelector('.overlay, .wizard')) return;
  // 右边的预览栏开着也照常查找对话；只有焦点就在预览栏里时才让给它
  const pv = document.querySelector('#preview');
  if (pv && !pv.classList.contains('hidden') && pv.contains(document.activeElement)) return;
  e.preventDefault();
  const sel = String(window.getSelection() || '').trim();
  chatFind.show(sel && sel.length < 80 && !sel.includes('\n') ? sel : '');
});
