/* global $, toast */
'use strict';

// 引用回复的来回跳转：
// 1) 点消息里的引用卡片 → 滚到被引用的原文并闪一下；
// 2) 原文里被引用过的文字用虚线标出，点一下回到引用它的那条消息；同一段被引用过好几次就去最新的那条。
// 链接、按钮、文件标签等本身有点击功能的东西优先，选中文字时也不跳，引用跳转排最后
const quoteLinks = {
  links: [], // { range, qi, qEl, card }
  timer: null,
  SKIP: 'script, style, textarea, .tool, .live-st, .q-card, .msg-files',
  INTERACTIVE: 'a, button, input, select, textarea, summary, label, img, video, canvas, [role="button"], [data-path], .tool, .q-card',

  // 一条消息里所有文字去掉空白后拼成一串，记下每个字对应的位置（选中的文字和页面里的换行、空格不一定一样，所以不比空白）
  compact(msgEl) {
    const chars = [];
    const parts = [];
    const w = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest(this.SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let n;
    while ((n = w.nextNode())) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) continue;
        parts.push(v[i]);
        chars.push([n, i]);
      }
    }
    return { str: parts.join(''), chars };
  },
  find(msgEl, quote) {
    const q = String(quote || '').replace(/\s+/g, '');
    if (q.length < 2) return null;
    const { str, chars } = this.compact(msgEl);
    const at = str.indexOf(q);
    if (at < 0) return null;
    const a = chars[at];
    const b = chars[at + q.length - 1];
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1] + 1);
    return r;
  },
  // 这张引用卡片引用的是哪一段原文：往前找最近一条含有这段文字的消息
  sourceFor(card) {
    const c = card._src;
    if (c && c.el.isConnected && c.range.startContainer.isConnected && c.range.endContainer.isConnected) return c;
    const qEl = card.closest('.msg[data-index]');
    if (!qEl) return null;
    const qi = +qEl.dataset.index;
    const msgs = [...document.querySelectorAll('#messages .msg[data-index]')].filter((m) => +m.dataset.index < qi).reverse();
    for (const m of msgs) {
      const range = this.find(m, card._quote);
      if (range) return (card._src = { el: m, range });
    }
    card._src = null;
    return null;
  },

  refresh() {
    this.links = [];
    if (window.CSS && CSS.highlights) CSS.highlights.delete('cr-quoted');
    const cards = [...document.querySelectorAll('#messages .q-card')].filter((c) => c._quote);
    if (!cards.length || !(window.CSS && CSS.highlights && typeof Highlight === 'function')) return;
    for (const card of cards) {
      const src = this.sourceFor(card);
      const qEl = card.closest('.msg[data-index]');
      if (src && qEl) this.links.push({ range: src.range, qi: +qEl.dataset.index, qEl, card });
    }
    if (this.links.length) CSS.highlights.set('cr-quoted', new Highlight(...this.links.map((l) => l.range)));
  },
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  },

  caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  },
  // 点的位置本身有点击功能（链接、按钮、文件标签、自己设了 onclick 的）就不算引用的点击
  interactive(elm) {
    const box = $('#messages');
    for (let n = elm; n && n !== box; n = n.parentElement) {
      if (n.matches && n.matches(this.INTERACTIVE)) return true;
      if (typeof n.onclick === 'function') return true;
    }
    return false;
  },
  hitAt(x, y) {
    if (!this.links.length) return null;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !$('#messages').contains(hit) || this.interactive(hit)) return null;
    const pos = this.caretAt(x, y);
    if (!pos) return null;
    let best = null;
    for (const l of this.links) {
      if (!l.range.startContainer.isConnected || !l.qEl.isConnected) continue;
      let inside = false;
      try { inside = l.range.isPointInRange(pos.node, pos.offset); } catch (_e) { /* 节点已经换掉了 */ }
      if (!inside) continue;
      // 行尾空白处也会算到最近的字上：必须真的点在文字占的方框里
      const onText = [...l.range.getClientRects()].some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
      if (!onText) continue;
      if (!best || l.qi > best.qi) best = l; // 被引用过好几次：去最新的
    }
    return best;
  },

  scrollCenter(rect) {
    const sc = $('#scroller');
    const box = sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + rect.top - (box.top + box.height / 2) + rect.height / 2, behavior: 'smooth' });
  },
  flash(elm) {
    elm.classList.remove('q-flash');
    void elm.offsetWidth;
    elm.classList.add('q-flash');
    setTimeout(() => elm.classList.remove('q-flash'), 1800);
  },
  jumpToQuoter(l) {
    this.scrollCenter(l.qEl.getBoundingClientRect());
    this.flash(l.qEl.querySelector('.bubble') || l.qEl);
  },
  jumpToSource(card) {
    const src = this.sourceFor(card);
    if (!src) return false;
    this.scrollCenter(src.range.getBoundingClientRect());
    if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
      CSS.highlights.set('cr-quoted-flash', new Highlight(src.range));
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => CSS.highlights.delete('cr-quoted-flash'), 1800);
    }
    return true;
  },
};

(function initQuoteLinks() {
  const box = $('#messages');
  new MutationObserver(() => quoteLinks.schedule()).observe(box, { childList: true, subtree: true, characterData: true });
  box.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = quoteLinks.hitAt(e.clientX, e.clientY);
    if (hit) quoteLinks.jumpToQuoter(hit);
  });
  let raf = 0;
  box.addEventListener('mousemove', (e) => {
    if (raf || !quoteLinks.links.length) return;
    const x = e.clientX, y = e.clientY;
    raf = requestAnimationFrame(() => { raf = 0; box.classList.toggle('q-hot', !!quoteLinks.hitAt(x, y)); });
  });
  box.addEventListener('mouseleave', () => box.classList.remove('q-hot'));
})();
