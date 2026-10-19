/* global el, esc */
'use strict';

// 文件改动的差异显示：修改文件（Edit / MultiEdit）的「改前 → 改后」、创建文件（Write）的全文，和终端里看到的一样
// 按行做最长公共子序列的对比；太长的（任一边超过 300 行）不算了，直接整段删 + 整段加
function diffLines(a, b) {
  const x = String(a || '').split('\n');
  const y = String(b || '').split('\n');
  if (x.length === 1 && x[0] === '') x.length = 0;
  if (y.length === 1 && y[0] === '') y.length = 0;
  if (x.length > 300 || y.length > 300) return x.map((s) => ['-', s]).concat(y.map((s) => ['+', s]));
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  while (i < n) out.push(['-', x[i++]]);
  while (j < m) out.push(['+', y[j++]]);
  return out;
}

// 一次工具调用里的改动：每组是一段差异。adds / dels 是加减的行数，给卡片标题用
function changesOf(name, input) {
  const i = input || {};
  const groups = [];
  if (name === 'Edit' && (i.old_string != null || i.new_string != null)) groups.push({ ops: diffLines(i.old_string, i.new_string), all: !!i.replace_all });
  else if (name === 'MultiEdit' && Array.isArray(i.edits)) for (const e of i.edits) groups.push({ ops: diffLines(e.old_string, e.new_string), all: !!e.replace_all });
  else if (name === 'Write' && i.content != null) groups.push({ ops: diffLines('', i.content), whole: true });
  else if (name === 'NotebookEdit' && i.new_source != null) groups.push({ ops: diffLines('', i.new_source), whole: true });
  if (!groups.length) return null;
  let adds = 0, dels = 0;
  for (const g of groups) for (const [t] of g.ops) { if (t === '+') adds++; else if (t === '-') dels++; }
  return { groups, adds, dels };
}

// 画出来：加的绿、删的红、没变的灰；全文（创建文件）超过 120 行只画前 120 行
function renderDiff(ch) {
  const box = el('div', 'tdiff');
  ch.groups.forEach((g, gi) => {
    if (gi) box.appendChild(el('div', 'dl sep', '<span class="dg"></span><span class="dt">⋯</span>'));
    if (g.all) box.appendChild(el('div', 'dl note', '<span class="dg"></span><span class="dt">替换文件里所有相同的地方</span>'));
    const ops = g.whole && g.ops.length > 120 ? g.ops.slice(0, 120) : g.ops;
    for (const [t, s] of ops) box.appendChild(el('div', 'dl ' + (t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'), `<span class="dg">${t === ' ' ? '' : t}</span><span class="dt">${esc(s) || ' '}</span>`));
    if (ops.length < g.ops.length) box.appendChild(el('div', 'dl note', `<span class="dg"></span><span class="dt">…还有 ${g.ops.length - ops.length} 行，点右上角「预览」看全文</span>`));
  });
  return box;
}
