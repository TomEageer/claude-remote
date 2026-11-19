/* global api, data, save, el, esc, icon, toast, live, currentId, searchText, findGroup, findSession, curServer, sessionOnCurrentServer, sortedSessions, renderItem, renderSidebar, unreadOf, pendingOf, togglePin, toHistory, showMenu, openSettings, msgSearch, renderPendingChip, animPhase, HISTORY, $ */
'use strict';

// 新界面（灰白风格）：侧栏改成一列入口 + 状态筛选 + 按时间自动分段的对话列表，底部是账号菜单和手机入口；侧栏宽度可以拖。
// 设置里可以切回原来的暖色风格（uiStyle = classic）和按分组的列表（listMode = group）。样式在 newui.css。
const newUi = {
  filter: 'all', // all | run | ask | unread
  more: {}, // 旧月份已经展开到第几条
  on: () => (data.settings.uiStyle || 'slate') !== 'classic',
  timeList: () => newUi.on() && (data.settings.listMode || 'time') === 'time',

  // 按当前设置摆好界面：根节点标记、侧栏里的入口位置、底部账号栏、侧栏宽度
  apply() {
    const on = this.on();
    document.documentElement.dataset.ui = on ? 'slate' : 'classic';
    const side = $('#sidebar');
    const files = $('#btn-files');
    const hist = $('#btn-history');
    if (on && files.parentNode !== hist.parentNode) hist.after(files);
    if (!on && files.parentNode === hist.parentNode) $('.side-bottom').insertBefore(files, $('#btn-settings-side'));
    let bar = $('#side-filter');
    if (!bar) { bar = el('div', 'side-filter'); bar.id = 'side-filter'; $('#tree').before(bar); }
    let acct = $('#side-acct');
    if (!acct) {
      acct = el('div', 'side-acct');
      acct.id = 'side-acct';
      side.appendChild(acct);
      const grip = el('div', 'side-grip');
      grip.title = '拖动调整宽度，双击恢复默认';
      side.appendChild(grip);
      grip.onmousedown = (e) => {
        e.preventDefault();
        document.body.classList.add('side-dragging');
        const move = (ev) => { data.ui.sideWidth = Math.max(220, Math.min(520, ev.clientX)); this.width(); };
        const up = () => { document.body.classList.remove('side-dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); save(); window.dispatchEvent(new Event('resize')); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      };
      grip.ondblclick = () => { delete data.ui.sideWidth; this.width(); save(); window.dispatchEvent(new Event('resize')); };
    }
    this.width();
    this.renderAcct();
  },
  width() {
    const w = data.ui.sideWidth;
    $('#sidebar').style.width = w ? w + 'px' : '';
  },

  // 底部：左边是「服务器 · 套餐」（点开是菜单），右边是手机入口
  renderAcct() {
    const box = $('#side-acct');
    if (!box) return;
    const srv = typeof curServer === 'function' ? curServer() : null;
    const name = (srv && srv.name) || '未配置服务器';
    const a = (srv && srv.account) || {};
    const plan = a.plan ? String(a.plan).replace(/^./, (c) => c.toUpperCase()) : '';
    box.innerHTML = `<button class="sa-main" title="设置、用量、切换服务器"><span class="sa-ava">${esc(name.trim().slice(0, 1) || '?')}</span><span class="sa-name">${esc(name)}</span>${plan ? `<span class="sa-plan">· ${esc(plan)}</span>` : ''}${icon('chevDown')}</button><button class="sa-phone" title="在手机上继续：扫码或输入连接码，在手机上查看和回复这台电脑上的对话">${icon('phone')}</button>`;
    box.querySelector('.sa-main').onclick = (e) => { e.stopPropagation(); this.acctMenu(e.currentTarget, a); };
    box.querySelector('.sa-phone').onclick = () => openSettings('remote');
  },
  async acctMenu(anchor, a) {
    const r = anchor.getBoundingClientRect();
    const v = await api.appVersion().catch(() => '');
    const srv = curServer();
    const items = [
      { label: [a.email, srv && srv.name].filter(Boolean).join(' · ') || 'Claude 远程助手' },
      { text: '设置', icon: 'gear', desc: api.platform === 'darwin' ? '⌘,' : 'Ctrl+,', onClick: () => openSettings() },
      { text: '用量统计', icon: 'chart', onClick: () => openSettings('stats') },
      { text: 'MCP · Skill', icon: 'plug', onClick: () => openSettings('caps') },
      { text: '拓展功能', icon: 'puzzle', onClick: () => openSettings('plugins') },
      '-',
      { text: '切换服务器', icon: 'server', desc: (srv && srv.name) || '', onClick: () => setTimeout(() => $('#server-switch').click(), 0) },
      { text: '新建分组', icon: 'folderPlus', onClick: () => $('#btn-new-group').click() },
      { text: '检查更新', icon: 'up', desc: v ? 'v' + String(v).replace(/-test.*/, ' 测试版') : '', onClick: () => { toast('正在检查更新…'); api.checkUpdate(); } },
    ];
    showMenu(items, { clientX: r.left, above: r.top, anchor });
  },

  // ---------- 对话列表：按时间自动分段 ----------
  stateOf(s) {
    if (typeof pendingOf === 'function' && pendingOf(s)) return 'ask';
    if (live[s.id]) return 'run';
    if (s.unread === 'ask') return 'ask';
    return s.unread ? 'unread' : '';
  },
  bucket(t, now) {
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const day = 86400000;
    if (t >= d0.getTime()) return { key: 'today', name: '今天' };
    if (t >= d0.getTime() - day) return { key: 'yest', name: '昨天' };
    if (t >= d0.getTime() - 6 * day) return { key: 'week', name: '本周更早' };
    const x = new Date(t);
    const y = x.getFullYear(), m = x.getMonth() + 1;
    return { key: `m${y}-${m}`, name: (y === d0.getFullYear() ? '' : y + '年') + m + '月', month: true };
  },
  timeText(t, now) {
    const d = now - t;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    if (t >= d0.getTime()) return Math.floor(d / 3600000) + ' 小时前';
    if (t >= d0.getTime() - 86400000) return '昨天';
    if (t >= d0.getTime() - 6 * 86400000) return Math.ceil((d0.getTime() - t) / 86400000) + ' 天前';
    const x = new Date(t);
    return (x.getMonth() + 1) + '月' + x.getDate() + '日';
  },
  isOpen(key) {
    const o = data.ui.timeOpen || {};
    return key in o ? !!o[key] : ['pin', 'today', 'yest'].includes(key);
  },

  renderFilter(all) {
    const bar = $('#side-filter');
    const n = { run: 0, ask: 0, unread: 0 };
    for (const s of all) { const st = this.stateOf(s); if (st) n[st]++; }
    if (this.filter !== 'all' && !n[this.filter]) this.filter = 'all';
    bar.innerHTML = [['all', '全部'], ['run', '进行中'], ['ask', '待处理'], ['unread', '未读']].map(([k, t]) => `<button class="${this.filter === k ? 'on' : ''}" data-f="${k}">${t}${k !== 'all' && n[k] ? `<i>${n[k]}</i>` : ''}</button>`).join('');
    bar.querySelectorAll('button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; renderSidebar(); }; });
  },

  renderSidebar() {
    const tree = $('#tree');
    const keepScroll = tree.scrollTop;
    tree.innerHTML = '';
    const now = Date.now();
    const mine = data.sessions.filter((s) => (typeof sessionOnCurrentServer !== 'function' || sessionOnCurrentServer(s)) && !s.history);
    this.renderFilter(mine);
    const shown = mine
      .filter((s) => !searchText || (s.title || '').toLowerCase().includes(searchText))
      .filter((s) => this.filter === 'all' || this.stateOf(s) === this.filter)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const secs = [];
    const pins = shown.filter((s) => s.pinned);
    if (pins.length) secs.push({ key: 'pin', name: '置顶', list: pins, pinned: true });
    for (const s of shown) {
      if (s.pinned) continue;
      const b = this.bucket(s.updatedAt || s.createdAt || 0, now);
      let sec = secs.find((x) => x.key === b.key);
      if (!sec) { sec = { ...b, list: [] }; secs.push(sec); }
      sec.list.push(s);
    }
    const hist = sortedSessions(HISTORY);
    if (hist.length && this.filter === 'all') secs.push({ key: 'hist', name: '历史版本', list: hist, history: true });

    for (const sec of secs) {
      const forced = !!searchText || this.filter !== 'all' || (sec.history && hist.some((x) => x.id === currentId));
      const open = forced || this.isOpen(sec.key);
      const g = el('div', 'group' + (open ? ' open' : '') + (sec.pinned ? ' pinned' : ''));
      const head = el('div', 'group-head');
      const un = unreadOf(sec.list);
      const runs = sec.list.filter((x) => live[x.id]).length;
      head.innerHTML = `<span class="gname">${esc(sec.name)}</span><span class="count">${sec.list.length}</span>${!open && runs ? `<span class="grun"><i style="${animPhase(900)}"></i></span>` : ''}${!open && un ? `<span class="gbadge ${un.kind}">${un.n}</span>` : ''}<span class="chev">${icon('chevDown')}</span>`;
      if (sec.history) head.title = '编辑前、回退前另存的对话，和还没用过的分支';
      head.onclick = () => { data.ui.timeOpen = { ...(data.ui.timeOpen || {}), [sec.key]: !open }; save(); renderSidebar(); };
      // 拖到「置顶」上就是置顶；拖到别的时间段上 = 取消置顶（时间段是自动排的，不能手动挪）
      head.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/session')) { e.preventDefault(); head.classList.add('drop-target'); } };
      head.ondragleave = () => head.classList.remove('drop-target');
      head.ondrop = (e) => {
        e.preventDefault();
        head.classList.remove('drop-target');
        const x = findSession(e.dataTransfer.getData('text/session'));
        if (!x) return;
        if (sec.history) return toHistory(x.id);
        if (!!x.pinned !== !!sec.pinned) togglePin(x.id);
      };
      g.appendChild(head);
      const body = el('div', 'group-body');
      const lim = sec.month && !forced ? (this.more[sec.key] || 20) : sec.list.length;
      for (const s of sec.list.slice(0, lim)) body.appendChild(this.item(s, now));
      if (sec.list.length > lim) {
        const m = el('button', 'more-row', `还有 ${sec.list.length - lim} 个`);
        m.onclick = () => { this.more[sec.key] = lim + 40; renderSidebar(); };
        body.appendChild(m);
      }
      g.appendChild(body);
      tree.appendChild(g);
    }
    if (!secs.length) tree.appendChild(el('div', 'group-empty', searchText ? '没有搜到标题里带这些字的对话' : this.filter !== 'all' ? '没有这类对话' : '还没有对话'));
    if (searchText && typeof msgSearch !== 'undefined') { tree.appendChild(msgSearch.container()); msgSearch.paint(); }
    tree.scrollTop = keepScroll;
    if (typeof renderPendingChip === 'function') renderPendingChip();
  },

  // 一条对话：原来的那一行，右边加上分组小标签和最后活动时间
  item(s, now) {
    const it = renderItem(s);
    const more = it.querySelector('.more');
    const g = s.groupId && findGroup(s.groupId);
    // 手动建的日期分组（11月18日）和时间段重复，不显示
    if (g && !/^\d{1,2}月\d{1,2}日$/.test(g.name)) { const tag = el('span', 'itag', esc(g.name)); tag.title = '分组：' + g.name; it.insertBefore(tag, more); }
    it.insertBefore(el('span', 'itime', this.timeText(s.updatedAt || s.createdAt || now, now)), more);
    return it;
  },
};
