/* global $, el, esc, data, findSession, openSession, ensureMsgRendered, chatFind, quoteLinks, sessionOnCurrentServer */
'use strict';

// 侧栏搜索框：除了对话标题，也搜所有对话里的消息文字（只搜你说的话和 Claude 回复的文字，不搜工具输出、思考过程）。
// 不建数据库：对话本来就都在内存里，这里只是第一次搜索时把每个对话的文字抽出来转成小写放一份（实测约 9 百万字、32 毫秒），
// 之后每次搜索就是在这份文字里找子串（几毫秒）。抽取按时间片分段做，电脑再慢也不会卡住界面；搜索框清空半分钟后释放这份缓存
const msgSearch = {
  cache: new Map(), // 对话 id -> { sig, items: [{ i: 第几条消息, lc: 小写文字 }] }
  last: null, // { q, hits, more, building }
  timer: null,
  freeTimer: null,
  seq: 0,

  textOf(m) {
    let s = m.text || '';
    if (m.blocks) for (const b of m.blocks) if (b.type === 'text' && b.text) s += (s ? '\n' : '') + b.text;
    return s;
  },
  // 对话变了（来了新消息、回复在更新）才重抽这一个
  sig(s) {
    const n = s.messages.length;
    const m = s.messages[n - 1];
    return n + '|' + (m ? this.textOf(m).length : 0) + '|' + (s.updatedAt || 0);
  },
  sessions() {
    return data.sessions
      .filter((s) => !s.history && Array.isArray(s.messages) && s.messages.length && (typeof sessionOnCurrentServer !== 'function' || sessionOnCurrentServer(s)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  async ensure(list, seq) {
    let t = performance.now();
    for (const s of list) {
      const sig = this.sig(s);
      const c = this.cache.get(s.id);
      if (c && c.sig === sig) continue;
      const items = [];
      for (let i = 0; i < s.messages.length; i++) {
        const x = this.textOf(s.messages[i]);
        if (x) items.push({ i, lc: x.toLowerCase() });
      }
      this.cache.set(s.id, { sig, items });
      if (performance.now() - t > 8) {
        await new Promise((r) => setTimeout(r, 0));
        if (seq !== this.seq) return false;
        t = performance.now();
      }
    }
    const ids = new Set(data.sessions.map((s) => s.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    return true;
  },

  snippet(s, idx, q) {
    const orig = this.textOf(s.messages[idx]);
    const low = orig.toLowerCase();
    const text = low.length === orig.length ? orig : low;
    const p = low.indexOf(q);
    if (p < 0) return esc(text.slice(0, 80));
    const a = Math.max(0, p - 24);
    const b = Math.min(text.length, p + q.length + 56);
    const flat = (x) => esc(x.replace(/\s+/g, ' '));
    return (a > 0 ? '…' : '') + flat(text.slice(a, p)) + '<mark>' + flat(text.slice(p, p + q.length)) + '</mark>' + flat(text.slice(p + q.length, b)) + (b < text.length ? '…' : '');
  },

  async run(q) {
    const seq = ++this.seq;
    this.last = { q, hits: null, more: 0, building: true };
    this.paint();
    const list = this.sessions();
    if (!(await this.ensure(list, seq)) || seq !== this.seq) return;
    const hits = [];
    let more = 0;
    for (const s of list) {
      const c = this.cache.get(s.id);
      if (!c) continue;
      let n = 0;
      let idx = -1;
      for (const it of c.items) if (it.lc.indexOf(q) >= 0) { n++; idx = it.i; }
      if (!n) continue;
      if (hits.length < 40) hits.push({ sid: s.id, title: s.title || '新对话', n, idx, snip: this.snippet(s, idx, q) });
      else more++;
    }
    this.last = { q, hits, more, building: false };
    this.paint();
  },

  // 搜索框里的字变了
  query(q) {
    clearTimeout(this.timer);
    clearTimeout(this.freeTimer);
    if (!q) {
      this.seq++;
      this.last = null;
      this.freeTimer = setTimeout(() => this.cache.clear(), 30000);
      return;
    }
    this.last = { q, hits: null, more: 0, building: true };
    this.timer = setTimeout(() => this.run(q), 150);
  },

  container() {
    return el('div', 'msg-hits');
  },
  // 把结果画在侧栏最下面（侧栏重画时也会调用）
  paint() {
    const box = document.querySelector('#tree .msg-hits');
    if (!box) return;
    const L = this.last;
    box.innerHTML = '';
    if (!L) return;
    if (L.building) { box.appendChild(el('div', 'hits-head', '正在搜索消息内容…')); return; }
    if (!L.hits.length) { box.appendChild(el('div', 'hits-head', '消息内容里没有找到')); return; }
    box.appendChild(el('div', 'hits-head', `消息内容里找到 ${L.hits.length + L.more} 个对话`));
    for (const h of L.hits) {
      const it = el('div', 'item hit', `<div class="hit-top"><span class="iname">${esc(h.title)}</span><span class="hit-n">${h.n} 条</span></div><div class="hit-snip">${h.snip}</div>`);
      it.onclick = () => this.open(h, L.q);
      box.appendChild(it);
    }
    if (L.more) box.appendChild(el('div', 'hits-more', `还有 ${L.more} 个对话也有结果，多输几个字可以缩小范围`));
  },

  // 打开这个对话，滚到最新的一条命中，并打开对话内查找（回车可以在命中之间切换）
  open(h, q) {
    openSession(h.sid);
    const go = () => {
      const n = ensureMsgRendered(h.idx);
      if (n) { n.scrollIntoView({ block: 'center' }); quoteLinks.flash(n.querySelector('.bubble') || n); }
      chatFind.show(q);
    };
    setTimeout(go, 120);
  },
};
