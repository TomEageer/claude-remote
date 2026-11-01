/* global api, el, esc, modal, data, save, toast */
'use strict';

// 更新日志弹窗：更新到新版本后第一次打开，告诉你这次新增、优化、修复了什么；「新版本已下载」那一栏也能提前看。
// 内容来自更新日志（CHANGELOG.md，每条英文后面跟一行中文），这里只取中文
const releaseNotes = {
  // 'x.y.z' 比大小
  cmp(a, b) {
    const x = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const y = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  },
  hasCJK: (s) => /[一-鿿]/.test(s),

  // 解析更新日志：[{ version, date, sections: [{ title, items: [中文] }] }]
  parse(md) {
    const out = [];
    let ver = null;
    let sec = null;
    const lines = String(md || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const v = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/.exec(line);
      if (v) { ver = { version: v[1], date: (v[2] || '').trim(), sections: [] }; out.push(ver); sec = null; continue; }
      if (!ver) continue;
      const h = /^###\s+(.*)$/.exec(line);
      if (h) {
        const parts = h[1].split('·').map((x) => x.trim());
        const title = parts.find((x) => this.hasCJK(x)) || parts[parts.length - 1];
        // 还没随这一版发布的、文档类的，不在弹窗里讲
        sec = /开发中|文档/.test(title) ? null : { title: this.normTitle(title), items: [] };
        if (sec) ver.sections.push(sec);
        continue;
      }
      if (!sec || !/^- /.test(line)) continue;
      // 一条：英文一行，下一行缩进的是中文；本来就是中文的直接用
      const next = lines[i + 1] || '';
      let zh = /^\s{2,}\S/.test(next) && this.hasCJK(next) ? next.trim() : this.hasCJK(line) ? line.slice(2).trim() : '';
      if (!zh) continue;
      zh = zh.replace(/\*\*(.+?)\*\*/g, '$1');
      sec.items.push(zh);
    }
    out.forEach((v) => { v.sections = v.sections.filter((s) => s.items.length); });
    return out.filter((v) => v.sections.length);
  },
  // 各版本用过的叫法统一成三类：新增 / 优化 / 修复（其余照原样）
  normTitle(t) {
    if (/新功能|功能|新增/.test(t)) return '新增';
    if (/优化|改动|改进/.test(t)) return '优化';
    if (/修复/.test(t)) return '修复';
    return t;
  },

  // 弹窗里每条只讲一两句：取开头的第一句（括号里的句号不算），第一句太短就带上第二句
  brief(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    const ends = [];
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '（' || c === '(') depth++;
      else if (c === '）' || c === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === '。' || c === '！' || c === '？')) ends.push(i + 1);
    }
    if (!ends.length) return t.length > 90 ? t.slice(0, 88) + '…' : t;
    let cut = ends[0];
    if (cut < 20 && ends.length > 1) cut = ends[1];
    return t.slice(0, cut).replace(/[。]$/, '');
  },

  render(list, lead) {
    const box = el('div', 'rn-box');
    if (lead) box.appendChild(el('p', 'rn-lead', esc(lead)));
    const ORDER = { 新增: 0, 优化: 1, 修复: 2 };
    for (const v of list) {
      const card = el('div', 'rn-ver', `<div class="rn-head"><b>${esc(v.version)}</b>${v.date ? `<span>${esc(v.date)}</span>` : ''}</div>`);
      // 同一版本里同名的分组合并，按 新增、优化、修复 的顺序
      const merged = [];
      for (const s of v.sections) { const m = merged.find((x) => x.title === s.title); if (m) m.items.push(...s.items); else merged.push({ title: s.title, items: [...s.items] }); }
      merged.sort((a, b) => (ORDER[a.title] ?? 9) - (ORDER[b.title] ?? 9));
      for (const s of merged) {
        card.appendChild(el('div', 'rn-sec ' + ({ 新增: 'new', 优化: 'imp', 修复: 'fix' }[s.title] || ''), esc(s.title)));
        const ul = el('ul', 'rn-list');
        for (const it of s.items) ul.appendChild(el('li', '', esc(this.brief(it))));
        card.appendChild(ul);
      }
      box.appendChild(card);
    }
    return box;
  },

  show(list, title, lead) {
    if (!list.length) return;
    return modal({ title, body: this.render(list, lead), buttons: [{ text: '知道了', cls: 'primary', value: true }], wide: true });
  },

  // 启动时：版本比上次打开时新，就把中间这些版本的更新内容弹出来
  async onStart() {
    const cur = String(await api.appVersion()).replace(/-test.*/, '');
    const seen = data.ui.notesSeen;
    data.ui.notesSeen = cur;
    save();
    // 第一次装的人不弹；以前没有这个记录的老用户（这一版之前装的），只给看这一版
    const old = seen || ((data.sessions || []).length ? null : cur);
    if (old && this.cmp(cur, old) <= 0) return;
    const md = await api.changelog().catch(() => '');
    const list = this.parse(md).filter((v) => this.cmp(v.version, cur) <= 0 && (old ? this.cmp(v.version, old) > 0 : v.version === cur));
    if (list.length) this.show(list.slice(0, 8), `已更新到 ${cur}`, list.length > 1 ? `距离上次打开，一共更新了 ${list.length} 个版本：` : '');
  },

  // 还没装的新版本：从发布页取更新内容
  async preview(target) {
    const cur = String(await api.appVersion()).replace(/-test.*/, '');
    const r = await api.releaseNotes();
    if (!r || !r.ok) return toast('读取更新内容失败：' + ((r && r.message) || '网络不通'), 4000);
    const list = this.parse(r.md).filter((v) => this.cmp(v.version, cur) > 0 && (!target || this.cmp(v.version, target) <= 0));
    if (!list.length) return toast('发布页上还没有这个版本的说明');
    this.show(list, `新版本 ${target || list[0].version} 更新了什么`, '');
  },
};
