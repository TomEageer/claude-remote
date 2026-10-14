/* global api, el, esc, data, save, prettyModel, fmtTokens, EFFORT_LABEL, serverLabel, openSession */
'use strict';

// ---------- 用量统计（设置 → 用量统计） ----------
// 只统计在本软件里发起的对话：每轮结束时 Claude Code 报告各模型用了多少 token，以及它按 Anthropic API 公开价格算出的金额。
// 不查账号：一个账号可能几个人一起用，账号页面的数字不代表你自己。
//
// 计数口径（和 ccusage 等工具一样分四类）：输入、输出、缓存写入、缓存读取，金额直接用 Claude Code 的 costUSD。
// Claude Code 报的是「这个进程的累计值」，续接对话时还可能带上这段对话以前的累计（实测：第二轮报的是两轮之和），
// 所以每轮都减掉上一次看到的数，只记增量。
//
// 存法：data.stats.days['2026-10-14']['模型|强度|服务器|对话'] = [输入, 输出, 缓存写入, 缓存读取, 金额, 轮数]
// （1.5.35 之前的记录没有「对话」这一段）
// 人民币按实时汇率折算：联网取一次，6 小时内用缓存；取不到就只显示美元
const fx = () => (data.ui && data.ui.fx) || null;
async function loadFx() {
  const f = fx();
  if (f && Date.now() - f.at < 6 * 3600 * 1000) return f;
  const r = await api.fxUsdCny();
  if (!r.ok) return f;
  data.ui.fx = { rate: r.rate, date: r.date, at: Date.now() };
  save();
  return data.ui.fx;
}

function statsStore() {
  data.stats = data.stats || { since: Date.now(), days: {} };
  return data.stats;
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const totalOf = (mu) => Object.values(mu || {}).reduce((a, x) => a + x.in + x.out + x.cr + x.cw, 0);

// ev: { modelUsage: { 模型: { in, out, cr, cw, cost } }, turn, first }；lv：这轮的运行状态（记着模型和强度）
function recordTokens(s, ev, lv) {
  const cur = ev.modelUsage || {};
  let base = lv.tokPrev;
  if (ev.first || !base) {
    // 进程里的第一次：如果累计值 ≥ 上次记下的 + 这一轮主模型的用量，说明 Claude Code 带上了以前的累计，从上次的数往上减
    const snap = s.tokSnap && s.tokSnap.id === s.claudeId ? s.tokSnap.mu : null;
    base = snap && totalOf(cur) >= totalOf(snap) + (ev.turn || 0) ? snap : {};
  }
  lv.tokPrev = cur;
  s.tokSnap = { id: s.claudeId, mu: cur };

  const delta = {};
  for (const [m, x] of Object.entries(cur)) {
    const b = base[m] || { in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
    const d = { in: Math.max(0, x.in - b.in), out: Math.max(0, x.out - b.out), cr: Math.max(0, x.cr - b.cr), cw: Math.max(0, x.cw - b.cw), cost: Math.max(0, x.cost - b.cost) };
    if (d.in + d.out + d.cr + d.cw > 0) delta[m] = d;
  }
  const models = Object.keys(delta);
  if (!models.length) return;
  // 选的强度算在这一轮的主模型（花费最多的那个）上；其他模型是子任务 / 后台用的
  const main = models.reduce((a, b) => (delta[b].cost > delta[a].cost ? b : a));
  const st = statsStore();
  const day = (st.days[dayKey(Date.now())] = st.days[dayKey(Date.now())] || {});
  for (const m of models) {
    const key = `${m}|${m === main ? lv.effort || '' : '-'}|${s.serverId || ''}|${s.id}`;
    const row = day[key] || (day[key] = [0, 0, 0, 0, 0, 0]);
    const d = delta[m];
    row[0] += d.in; row[1] += d.out; row[2] += d.cw; row[3] += d.cr; row[4] += d.cost;
    if (m === main) row[5] += 1;
  }
}

// ---------- 页面 ----------
const fmtUsd = (v) => (v > 0 && v < 0.01 ? '<$0.01' : '$' + v.toFixed(v >= 100 ? 0 : 2));
const fmtCny = (v) => {
  const f = fx();
  if (!f) return '人民币汇率读取中…';
  const y = v * f.rate;
  return '约 ¥' + y.toFixed(y >= 100 ? 0 : 2);
};
const fmtFull = (n) => n.toLocaleString('en-US');

const statsView = {
  range: '30',
  server: '',
  armed: false,

  open(pane) {
    this.pane = pane;
    this.render();
    const before = fx();
    loadFx().then((f) => { if (f && f !== before && this.pane === pane) this.render(); });
  },

  // 按范围、服务器筛出来的明细：[{ day, model, effort, server, v: [6 个数] }]
  rows() {
    const st = statsStore();
    const today = dayKey(Date.now());
    const from = this.range === 'all' ? '' : this.range === 'today' ? today : dayKey(Date.now() - (Number(this.range) - 1) * 86400000);
    const out = [];
    for (const [day, m] of Object.entries(st.days)) {
      if (day < from) continue;
      for (const [key, v] of Object.entries(m)) {
        const [model, effort, server, sid] = key.split('|');
        if (this.server && server !== this.server) continue;
        out.push({ day, model, effort, server, sid: sid || '', v });
      }
    }
    return out;
  },

  render() {
    const pane = this.pane;
    if (!pane) return;
    const st = statsStore();
    const rows = this.rows();
    const sum = (list) => list.reduce((a, r) => a.map((x, i) => x + r.v[i]), [0, 0, 0, 0, 0, 0]);
    const all = sum(rows);
    const tokens = all[0] + all[1] + all[2] + all[3];
    const inputSide = all[0] + all[2] + all[3];
    const hit = inputSide ? Math.round((all[3] / inputSide) * 100) : 0;
    const servers = [...new Set(Object.values(st.days).flatMap((m) => Object.keys(m).map((k) => k.split('|')[2])))];
    const srvName = (id) => {
      const s = (data.servers || []).find((x) => x.id === id);
      return s ? serverLabel(s) : id ? '已删除的服务器' : '未知服务器';
    };
    const since = new Date(st.since);

    pane.innerHTML = `
      <div class="sx-head">
        <div class="seg sx-range">
          ${[['today', '今天'], ['7', '近 7 天'], ['30', '近 30 天'], ['all', '全部']].map(([k, t]) => `<button data-r="${k}" class="${this.range === k ? 'on' : ''}">${t}</button>`).join('')}
        </div>
        ${servers.length > 1 ? `<select class="sx-server"><option value="">全部服务器</option>${servers.map((id) => `<option value="${esc(id)}"${this.server === id ? ' selected' : ''}>${esc(srvName(id))}</option>`).join('')}</select>` : ''}
      </div>
      <div class="sx-cards">
        <div class="sx-card main"><span>相当于 API 金额</span><b>${fmtUsd(all[4])}</b><em>${fmtCny(all[4])}</em></div>
        <div class="sx-card"><span>总 token</span><b>${fmtTokens(tokens)}</b><em>${fmtFull(tokens)}</em></div>
        <div class="sx-card"><span>对话轮数</span><b>${fmtFull(all[5])}</b><em>${all[5] ? '平均每轮 ' + fmtUsd(all[4] / all[5]) : '—'}</em></div>
        <div class="sx-card"><span>缓存命中</span><b>${hit}%</b><em>输入里从缓存读取的比例</em></div>
      </div>
      <div class="sx-chart"></div>
      <div class="sx-sec">按模型</div>
      <div class="sx-table sx-models"></div>
      <div class="sx-sec">按思考强度</div>
      <div class="sx-table sx-efforts"></div>
      <div class="sx-sec">按对话 <span class="sx-sub">从高到低，点一行打开那个对话</span></div>
      <div class="sx-table sx-sessions"></div>
      <div class="sx-foot">
        <p>只统计在本软件里发起的对话，从 ${since.getFullYear()}年${since.getMonth() + 1}月${since.getDate()}日 开始记录，存在这台电脑上；同一个账号在别处的使用不算在内。</p>
        <p>金额是 Claude Code 按 Anthropic API 公开价格算的估算值（输入、输出、缓存写入、缓存读取分别计价），用来对比「如果按量付费要花多少」；订阅用户不会因此额外扣费。${fx() ? `人民币按实时汇率 1 美元 = ${fx().rate.toFixed(4)} 元换算（${esc(fx().date || '')}）。` : '人民币按实时汇率换算（正在读取汇率）。'}</p>
        <button class="mp-link sx-reset">${this.armed ? '再点一次确认清空' : '清空统计'}</button>
      </div>`;

    pane.querySelectorAll('.sx-range button').forEach((b) => (b.onclick = () => { this.range = b.dataset.r; this.render(); }));
    const sel = pane.querySelector('.sx-server');
    if (sel) sel.onchange = () => { this.server = sel.value; this.render(); };
    pane.querySelector('.sx-reset').onclick = () => {
      if (!this.armed) {
        this.armed = true;
        this.render();
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => { this.armed = false; this.render(); }, 3000);
        return;
      }
      this.armed = false;
      data.stats = { since: Date.now(), days: {} };
      save();
      this.render();
    };

    this.drawChart(pane.querySelector('.sx-chart'), rows);

    // 按模型
    const byModel = {};
    rows.forEach((r) => { (byModel[r.model] = byModel[r.model] || []).push(r); });
    const models = Object.entries(byModel).map(([m, list]) => ({ m, v: sum(list) })).sort((a, b) => b.v[4] - a.v[4] || b.v[1] - a.v[1]);
    const maxCost = Math.max(...models.map((x) => x.v[4]), 1e-9);
    pane.querySelector('.sx-models').innerHTML = !models.length
      ? '<div class="sx-empty">这段时间还没有记录。发起对话后，每轮结束都会记在这里。</div>'
      : `<div class="sx-tr sx-th"><span>模型</span><span>输入</span><span>输出</span><span>缓存写入</span><span>缓存读取</span><span>金额</span></div>` +
        models.map(({ m, v }) => `<div class="sx-tr" title="${esc(m)}">
          <span class="sx-name"><b>${esc(prettyModel(m))}</b><i style="--w:${((v[4] / maxCost) * 100).toFixed(1)}%"></i></span>
          <span title="${fmtFull(v[0])}">${fmtTokens(v[0])}</span><span title="${fmtFull(v[1])}">${fmtTokens(v[1])}</span>
          <span title="${fmtFull(v[2])}">${fmtTokens(v[2])}</span><span title="${fmtFull(v[3])}">${fmtTokens(v[3])}</span>
          <span class="sx-cost">${fmtUsd(v[4])}</span></div>`).join('');

    // 按强度（子任务 / 后台用的模型单独一行）
    const byEffort = {};
    rows.forEach((r) => { (byEffort[r.effort] = byEffort[r.effort] || []).push(r); });
    const order = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    const efforts = Object.entries(byEffort).map(([e, list]) => ({ e, v: sum(list), models: [...new Set(list.map((r) => prettyModel(r.model)))] }))
      .sort((a, b) => (a.e === '-') - (b.e === '-') || order.indexOf(a.e) - order.indexOf(b.e));
    const effortName = (e) => (e === '-' ? '子任务 / 后台' : e ? (EFFORT_LABEL && EFFORT_LABEL[e]) || e : '默认');
    pane.querySelector('.sx-efforts').innerHTML = !efforts.length ? '' :
      `<div class="sx-tr sx-th sx-e"><span>强度</span><span>用到的模型</span><span>轮数</span><span>token</span><span>金额</span></div>` +
      efforts.map(({ e, v, models: ms }) => `<div class="sx-tr sx-e">
        <span><b>${esc(effortName(e))}</b></span><span class="sx-dim">${esc(ms.join('、'))}</span>
        <span>${e === '-' ? '—' : fmtFull(v[5])}</span><span title="${fmtFull(v[0] + v[1] + v[2] + v[3])}">${fmtTokens(v[0] + v[1] + v[2] + v[3])}</span>
        <span class="sx-cost">${fmtUsd(v[4])}</span></div>`).join('');

    // 按对话：金额从高到低（没记对话的老记录单独说明）
    const bySid = {};
    rows.forEach((r) => { if (r.sid) (bySid[r.sid] = bySid[r.sid] || []).push(r); });
    const sessions = Object.entries(bySid).map(([sid, list]) => ({ sid, v: sum(list), models: [...new Set(list.map((r) => prettyModel(r.model)))] }))
      .sort((a, b) => b.v[4] - a.v[4] || b.v[1] - a.v[1]);
    const old = rows.some((r) => !r.sid);
    const maxS = Math.max(...sessions.map((x) => x.v[4]), 1e-9);
    const shown = this.allSessions ? sessions : sessions.slice(0, 15);
    const box = pane.querySelector('.sx-sessions');
    box.innerHTML = !sessions.length
      ? `<div class="sx-empty">${old ? '这段时间的记录是在会话统计加入之前产生的，没法按对话拆开；之后的对话会出现在这里' : '这段时间还没有记录'}</div>`
      : `<div class="sx-tr sx-th sx-s"><span>对话</span><span>用到的模型</span><span>轮数</span><span>token</span><span>金额</span></div>` +
        shown.map(({ sid, v, models: ms }) => {
          const s = data.sessions.find((x) => x.id === sid);
          return `<div class="sx-tr sx-s${s ? ' link' : ''}" data-sid="${esc(sid)}" title="${s ? '打开这个对话' : '这个对话已经删除'}">
            <span class="sx-name"><b>${esc(s ? s.title || '新对话' : '已删除的对话')}</b><i style="--w:${((v[4] / maxS) * 100).toFixed(1)}%"></i></span>
            <span class="sx-dim">${esc(ms.join('、'))}</span><span>${fmtFull(v[5])}</span>
            <span title="${fmtFull(v[0] + v[1] + v[2] + v[3])}">${fmtTokens(v[0] + v[1] + v[2] + v[3])}</span><span class="sx-cost">${fmtUsd(v[4])}</span></div>`;
        }).join('') +
        (sessions.length > 15 ? `<button class="sx-more mp-link">${this.allSessions ? '收起' : `显示全部 ${sessions.length} 个对话`}</button>` : '') +
        (old ? '<div class="sx-note">更早的记录是在会话统计加入之前产生的，没算在上面</div>' : '');
    box.querySelectorAll('.sx-tr.link').forEach((r) => (r.onclick = () => {
      const ov = r.closest('.overlay');
      if (ov) ov.remove();
      if (typeof openSession === 'function') openSession(r.dataset.sid);
    }));
    const more = box.querySelector('.sx-more');
    if (more) more.onclick = () => { this.allSessions = !this.allSessions; this.render(); };
  },

  // 每天一根柱子（金额）；「今天」不画
  drawChart(box, rows) {
    if (this.range === 'today') { box.remove(); return; }
    const n = this.range === 'all' ? Math.min(90, Math.max(7, Math.ceil((Date.now() - statsStore().since) / 86400000) + 1)) : Number(this.range);
    const days = Array.from({ length: n }, (_, i) => dayKey(Date.now() - (n - 1 - i) * 86400000));
    const per = Object.fromEntries(days.map((d) => [d, [0, 0]]));
    rows.forEach((r) => { if (per[r.day]) { per[r.day][0] += r.v[4]; per[r.day][1] += r.v[0] + r.v[1] + r.v[2] + r.v[3]; } });
    const max = Math.max(...days.map((d) => per[d][0]), 1e-9);
    box.innerHTML = `<div class="sx-bars">${days.map((d) => {
      const [c, t] = per[d];
      const [, mo, da] = d.split('-').map(Number);
      return `<div class="sx-bar${c ? '' : ' zero'}" title="${mo}月${da}日 · ${fmtUsd(c)} · ${fmtTokens(t)} token"><i style="height:${c ? Math.max(3, (c / max) * 100) : 0}%"></i></div>`;
    }).join('')}</div>
      <div class="sx-axis"><span>${days[0].slice(5).replace('-', '/')}</span><span>每天的估算金额</span><span>今天</span></div>`;
  },
};
