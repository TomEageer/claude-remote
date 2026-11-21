/* global remoteCtl, foldGroup, moveSession, retheme, groupsHere, modal, serverItems, renderAll, animateHeight, serverMenu, api, data, save, el, esc, icon, toast, live, currentId, searchText, findGroup, findSession, curServer, sessionOnCurrentServer, sortedSessions, renderItem, renderSidebar, unreadOf, pendingOf, togglePin, toHistory, showMenu, openSettings, msgSearch, renderPendingChip, animPhase, HISTORY, $ */
'use strict';

// 新界面（灰白风格）：侧栏改成一列入口 + 状态筛选 + 按时间自动分段的对话列表，底部是账号菜单和手机入口；侧栏宽度可以拖。
// 设置里可以切回原来的暖色风格（uiStyle = classic）和按分组的列表（listMode = group）。样式在 newui.css。
const newUi = {
  gf: '', // 只看哪个分组（分组 id），空 = 全部
  filter: 'all', // all（没标完成的）| todo（待处理）| run（进行中）| done（已完成）
  more: {}, // 旧月份已经展开到第几条
  NAME: '雾灰',
  DATE_RE: /^\d{1,2}月\d{1,2}日$/,
  // 原来的暖色外观是「默认主题」；「雾灰」要在设置 → 主题里选
  on: () => data.settings.uiStyle === 'slate',
  timeList: () => newUi.on() && (data.settings.listMode || 'time') === 'time',

  // 按当前设置摆好界面：根节点标记、侧栏里的入口位置、底部账号栏、侧栏宽度
  apply() {
    const on = this.on();
    document.documentElement.dataset.ui = on ? 'slate' : 'classic';
    try { localStorage.setItem('uiStyle', on ? 'slate' : 'classic'); } catch (_) {} // 下次启动时 theme-early.js 先按它上色
    this.initSearch();
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
    // 雾灰主题没有底部状态栏：额度挪到输入框下面那一行的最右边，连接状态显示在账号头像上；
    // 发送按钮放在输入框里的右下角（默认主题在工具栏最右边）
    const usage = $('#usage-box');
    const slot = document.querySelector('.send-slot');
    const cbar = document.querySelector('.composer-bar');
    const cbody = $('#composer-body');
    // 发送按钮不能放进输入框里面：输入框内容多了会自己滚动，按钮会跟着滚走。放在输入框后面一个不占高度的容器里，往上贴到输入框的右下角
    let anchor = document.querySelector('.send-anchor');
    if (!anchor) { anchor = el('div', 'send-anchor'); cbody.parentNode.insertBefore(anchor, cbody.nextSibling); }
    if (on) { if (usage.parentNode !== cbar) cbar.appendChild(usage); if (slot.parentNode !== anchor) anchor.appendChild(slot); }
    else { if (usage.parentNode === cbar) document.querySelector('#statusbar .sb-right').appendChild(usage); if (slot.parentNode !== cbar) cbar.appendChild(slot); }
    // 收起 / 展开侧栏的按钮：位置固定在左上角（Mac 上在红绿灯右边），收起后还在原处
    let tg = $('#side-toggle');
    if (!tg) {
      tg = el('button', 'side-toggle', '<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M9 5v14"/></svg><i></i>');
      tg.id = 'side-toggle';
      document.body.appendChild(tg);
      tg.onclick = () => this.toggleSide();
      document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && this.on() && !(document.activeElement && document.activeElement.closest('#term-view'))) { e.preventDefault(); this.toggleSide(); } });
    }
    tg.title = `收起 / 展开侧栏（${api.platform === 'darwin' ? '⌘' : 'Ctrl+'}B）`;
    this.sideOff(on && !!data.ui.sideOff);
    this.width();
    this.renderAcct();
  },
  toggleSide() { data.ui.sideOff = !data.ui.sideOff; save(); this.sideOff(!!data.ui.sideOff); },
  sideOff(off) {
    const side = $('#sidebar');
    document.body.classList.toggle('side-off', off);
    side.style.marginLeft = off ? -side.getBoundingClientRect().width + 'px' : '';
    setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
  },

  // 整理分组：一次清掉空分组、解散手动建的日期分组、合并重名的。只动分组，对话一个不删
  async tidyGroups() {
    const gs = groupsHere();
    const count = (g) => data.sessions.filter((x) => x.groupId === g.id).length;
    const seen = {};
    const rows = gs.map((g) => {
      const n = count(g);
      const dup = seen[g.name];
      if (!dup) seen[g.name] = g;
      const why = dup ? 'dup' : this.DATE_RE.test(g.name) ? 'date' : n === 0 ? 'empty' : '';
      return { g, n, dup, why };
    });
    const body = el('div', 'tidy');
    body.innerHTML = `<p class="help" style="margin:0 0 10px">勾上的分组会被处理，对话本身不会删。日期分组解散后，里面的对话变成未分组（列表已经按时间自动分段）；重名的分组并进第一个；空分组直接删掉。</p>`;
    const TXT = { dup: '重名，并进同名的第一个', date: '日期分组，解散', empty: '空分组，删除', '': '保留' };
    for (const r of rows) {
      const row = el('label', 'tidy-row', `<input type="checkbox"${r.why ? ' checked' : ''} /><span class="tr-name">${esc(r.g.name)}</span><span class="tr-n">${r.n} 个对话</span><span class="tr-why${r.why ? ' on' : ''}">${TXT[r.why]}</span>`);
      r.box = row.querySelector('input');
      if (!r.why) { r.box.disabled = r.n > 0; if (r.n > 0) row.title = '里面有对话、也不是日期或重名分组：要处理请在对话的右键菜单里挪走'; }
      body.appendChild(row);
    }
    if (!rows.length) body.appendChild(el('div', 'group-empty', '这台服务器上还没有分组'));
    const okd = await modal({ title: '整理分组', body, wide: true, buttons: [{ text: '取消', value: false }, { text: '整理勾选的', cls: 'primary', value: true }] });
    if (!okd) return;
    let n = 0;
    for (const r of rows) {
      if (!r.box.checked) continue;
      const to = r.why === 'dup' ? r.dup.id : null;
      for (const x of data.sessions) if (x.groupId === r.g.id) x.groupId = to;
      data.groups = data.groups.filter((x) => x.id !== r.g.id);
      n++;
    }
    if (!n) return;
    save();
    renderSidebar();
    toast(`整理了 ${n} 个分组，对话都还在`);
  },

  setStyle(v) {
    data.settings.uiStyle = v;
    save();
    this.apply();
    if (typeof renderAll === 'function') renderAll();
    window.dispatchEvent(new Event('resize'));
    if (typeof retheme === 'function') retheme();
  },
  // 两个主题的对比卡片：设置 → 主题、更新后的介绍弹窗都用它。onPick 不传就是点了直接换
  cards(onPick) {
    const cur = this.on() ? 'slate' : 'classic';
    const box = el('div', 'th-cards');
    const defs = [
      ['classic', '默认主题', '原来的样子：暖色调，对话按分组文件夹排，底部有状态栏'],
      ['slate', this.NAME, '灰白色调。入口排成一列，对话按今天、昨天、月份自动分段，账号菜单和手机入口在侧栏底部，侧栏宽度可以拖'],
    ];
    for (const [k, name, desc] of defs) {
      const c = el('button', 'th-card' + (k === cur ? ' on' : ''), `<img src="img/theme-${k}.png" alt="" /><span class="th-name">${esc(name)}${k === cur ? '<i>正在使用</i>' : ''}</span><span class="th-desc">${esc(desc)}</span>`);
      c.onclick = () => { if (onPick) onPick(k); else { this.setStyle(k); box.replaceWith(this.cards()); } };
      box.appendChild(c);
    }
    return box;
  },
  themePane(pane) {
    pane.innerHTML = '';
    pane.appendChild(this.cards((k) => { this.setStyle(k); this.themePane(pane); }));
    // 外观：跟随系统 / 浅色 / 深色，两个主题都能用
    const mode = ['light', 'dark'].includes(data.settings.colorMode) ? data.settings.colorMode : 'system';
    const mrow = el('div', 'st-row', `<div class="st-rt"><b>外观</b><span>跟随系统、浅色、深色，两个主题都适用</span></div><div class="cm-seg">${[['system', 'computer', '跟随系统'], ['light', 'sun', '浅色'], ['dark', 'moon', '深色']].map(([k, ic, t]) => `<button data-m="${k}" class="${k === mode ? 'on' : ''}" title="${t}" aria-label="${t}">${icon(ic)}</button>`).join('')}</div>`);
    mrow.querySelectorAll('.cm-seg button').forEach((b) => {
      b.onclick = () => {
        data.settings.colorMode = b.dataset.m;
        save();
        api.colorMode(b.dataset.m);
        mrow.querySelectorAll('.cm-seg button').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    pane.appendChild(mrow);
    const row = el('div', 'st-row', `<div class="st-rt"><b>对话列表</b><span>按时间：自动分成今天、昨天、本周更早和各个月份；按分组：原来的分组文件夹。只在「${this.NAME}」主题下可选</span></div><select${this.on() ? '' : ' disabled'}><option value="time">按时间</option><option value="group">按分组</option></select>`);
    const sel = row.querySelector('select');
    sel.value = this.on() ? data.settings.listMode || 'time' : 'group';
    sel.onchange = () => { data.settings.listMode = sel.value; save(); renderSidebar(); };
    pane.appendChild(row);
  },
  // 老用户更新上来第一次打开：介绍新主题、给一个直接换的按钮，并说明以后在哪里切换。返回要放进弹窗的内容
  introBlock(done) {
    const box = el('div', 'th-intro');
    box.appendChild(el('p', 'th-lead', `这一版多了一个新主题「${esc(this.NAME)}」。现在用的还是默认主题，点下面的图可以直接换过去；以后随时在 <b>设置 → 主题</b> 里切换。`));
    box.appendChild(this.cards((k) => { this.setStyle(k); done(k); }));
    return box;
  },
  width() {
    const w = data.ui.sideWidth;
    $('#sidebar').style.width = w ? w + 'px' : '';
  },

  // 搜索框里有字的时候：一直保持「正在搜索」的样子（白底、阴影、蓝色描边），字后面有一根闪动的光标，右边一个清除按钮。
  // 不然搜完去干别的，忘了里面还留着字，列表一直是筛过的也看不出来
  initSearch() {
    const box = document.querySelector('.search');
    const input = document.querySelector('#search');
    if (!box || !input || box.querySelector('.search-caret')) return;
    box.style.position = 'relative';
    const caret = el('i', 'search-caret');
    const clear = el('button', 'search-clear', icon('close'));
    clear.type = 'button';
    clear.title = '清除搜索';
    box.append(caret, clear);
    const cv = document.createElement('canvas').getContext('2d');
    const sync = () => {
      const has = !!input.value;
      box.classList.toggle('has-text', has);
      if (!has) return;
      const cs = getComputedStyle(input);
      cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const w = Math.min(cv.measureText(input.value).width, input.clientWidth - 2);
      caret.style.left = input.offsetLeft + w + 1 + 'px';
    };
    clear.onmousedown = (e) => e.preventDefault();
    clear.onclick = () => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); sync(); };
    ['input', 'focus', 'blur', 'change'].forEach((ev) => input.addEventListener(ev, sync));
    this.syncSearch = sync;
    sync();
  },

  // 左下角手机按钮点开的小窗口：远程控制开没开、连没连上中转、有哪些手机（在不在线），以及添加手机 / 全部设置两个入口
  phonePop(anchor) {
    const old = document.querySelector('.ph-pop');
    if (old) return old.remove();
    if (typeof remoteCtl === 'undefined') return openSettings('remote');
    const pop = el('div', 'ph-pop');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - 300 - 8)) + 'px';
    pop.style.bottom = window.innerHeight - r.top + 8 + 'px';
    const go = (after) => { pop.remove(); Promise.resolve(openSettings('remote')).then(() => after && setTimeout(after, 150)); };
    const draw = () => {
      if (!pop.isConnected) return;
      const c = remoteCtl.cfg();
      const st = remoteCtl.state;
      const ready = !!(c.relay && c.token);
      const devs = (c.devices || []).filter((d) => !d.temp || d.pk);
      const online = devs.filter((d) => remoteCtl.isOnline(d.id)).length;
      const [cls, text] = !c.on ? ['', '没有开启'] : st === 'on' ? ['ok', online ? `${online} 台设备在线` : '已就绪，等手机连上来'] : st === 'connecting' ? ['wait', '正在连接中转服务器…'] : ['bad', remoteCtl.error ? '没连上：' + remoteCtl.error : '没连上中转服务器'];
      const ago = (t) => (t ? this.timeText(t, Date.now()) + '在线过' : '还没连过');
      const kindIcon = (d) => (d.kind === 'watch' ? 'bell' : d.kind === 'web' ? 'globe' : 'phone');
      pop.innerHTML = `
        <div class="ph-head"><div class="ph-t"><b>手机远程</b><span class="ph-st ${cls}"><i></i>${esc(text)}</span></div><label class="st-sw" title="${ready ? '开启 / 关闭远程控制' : '第一次用要先在设置里填中转地址'}"><input type="checkbox" class="ph-on" ${c.on ? 'checked' : ''} /></label></div>
        ${devs.length ? `<div class="ph-list">${devs.slice(0, 6).map((d) => { const on = remoteCtl.isOnline(d.id); return `<div class="ph-dev${on ? ' on' : ''}">${icon(kindIcon(d))}<span class="ph-name">${esc(d.name || '手机')}</span><span class="ph-when">${on ? '在线' : !d.pk ? '等待扫码' : esc(ago(d.lastSeen))}</span></div>`; }).join('')}${devs.length > 6 ? `<div class="ph-more">还有 ${devs.length - 6} 台，在设置里看</div>` : ''}</div>` : `<div class="ph-empty">用手机看对话、回复 Claude、处理它的提问。${ready ? '点下面「添加手机」，用手机扫码就能连上。' : '第一次用要先在设置里填好中转服务器。'}</div>`}
        <div class="ph-foot"><button class="btn ph-add">${icon('plus')}添加手机</button><button class="btn ph-set">全部设置</button></div>`;
      pop.querySelector('.ph-on').onchange = (e) => {
        if (e.target.checked && !ready) { e.target.checked = false; toast('先在设置里填中转地址和访问令牌'); return go(); }
        c.on = e.target.checked;
        save();
        if (c.on) remoteCtl.start(); else remoteCtl.stop();
        setTimeout(draw, 60);
      };
      pop.querySelector('.ph-add').onclick = () => go(() => { const b = document.querySelector('#rc-add'); if (b) b.click(); });
      pop.querySelector('.ph-set').onclick = () => go();
    };
    draw();
    const off = remoteCtl.onChange(draw);
    setTimeout(() => document.addEventListener('mousedown', function close(e) {
      if (!pop.isConnected) { off(); return document.removeEventListener('mousedown', close); }
      if (!pop.contains(e.target) && !e.target.closest('.sa-phone')) { pop.remove(); off(); document.removeEventListener('mousedown', close); }
    }), 0);
  },

  // 底部：左边是「服务器 · 套餐」（点开是菜单），右边是手机入口
  renderAcct() {
    const box = $('#side-acct');
    if (!box) return;
    const srv = typeof curServer === 'function' ? curServer() : null;
    const name = (srv && srv.name) || '未配置服务器';
    const a = (srv && srv.account) || {};
    const plan = a.plan ? String(a.plan).replace(/^./, (c) => c.toUpperCase()) : '';
    const c = $('#conn');
    const conn = (c.className.match(/connected|connecting|disconnected|error/) || [''])[0];
    box.innerHTML = `<button class="sa-main" title="${esc(c.title || '设置、用量、切换服务器')}"><span class="sa-ava">${esc(name.trim().slice(0, 1) || '?')}<i class="sa-conn ${esc(conn)}"></i></span><span class="sa-name">${esc(name)}</span>${plan ? `<span class="sa-plan">· ${esc(plan)}</span>` : ''}${icon('chevDown')}</button><button class="sa-phone" title="在手机上继续：扫码或输入连接码，在手机上查看和回复这台电脑上的对话">${icon('phone')}</button>`;
    box.querySelector('.sa-main').onclick = (e) => { e.stopPropagation(); this.acctMenu(e.currentTarget, a); };
    box.querySelector('.sa-phone').onclick = (e) => { e.stopPropagation(); this.phonePop(box.querySelector('.sa-phone')); };
  },
  async acctMenu(anchor, a) {
    const r = anchor.getBoundingClientRect();
    const v = await api.appVersion().catch(() => '');
    const srv = curServer();
    // 最上面直接是服务器列表（切换最常用，点开就能选），下面才是设置这些
    const items = [
      ...serverItems(),
      '-',
      { text: '设置', icon: 'gear', desc: api.platform === 'darwin' ? '⌘,' : 'Ctrl+,', onClick: () => openSettings() },
      { text: '用量统计', icon: 'chart', onClick: () => openSettings('stats') },
      { text: 'MCP · Skill', icon: 'plug', onClick: () => openSettings('caps') },
      { text: '拓展功能', icon: 'puzzle', onClick: () => openSettings('plugins') },
      '-',
      { text: '新建分组', icon: 'folderPlus', onClick: () => $('#btn-new-group').click() },
      { text: '整理分组…', icon: 'folder', desc: groupsHere().length + ' 个', onClick: () => this.tidyGroups() },
      { text: '检查更新', icon: 'up', desc: v ? 'v' + String(v).replace(/-test.*/, ' 测试版') : '', onClick: () => { toast('正在检查更新…'); api.checkUpdate(); } },
    ];
    showMenu(items, { clientX: r.left, above: r.top, anchor });
  },

  // ---------- 对话列表：按时间自动分段 ----------
  // 一个对话算在哪几个筛选里。待处理 = 你手动标的 + Claude 在等你选择 / 批准 + 回复完了还没看
  inTab(s, tab) {
    if (tab === 'done') return s.mark === 'done';
    if (s.mark === 'done') return false;
    if (tab === 'run') return !!live[s.id];
    if (tab === 'todo') return s.mark === 'todo' || !!s.unread || (typeof pendingOf === 'function' && !!pendingOf(s));
    return true;
  },
  // 手动标记：todo 待处理、done 已完成、空 = 取消。标完成后从「全部」里消失，只在「已完成」里；再发消息会自动回来
  setMark(sid, mark) {
    const s = findSession(sid);
    if (!s) return;
    if (mark) s.mark = mark; else delete s.mark;
    if (mark === 'done') delete s.unread;
    save(sid);
    renderSidebar();
    if (mark === 'done') toast('已标为完成，在「已完成」里能找到；再发消息会自动回到列表');
  },
  markItems(s) {
    return [
      s.mark === 'todo' ? { text: '取消待处理', icon: 'bell', onClick: () => this.setMark(s.id, '') } : { text: '标为待处理', icon: 'bell', onClick: () => this.setMark(s.id, 'todo') },
      s.mark === 'done' ? { text: '放回列表（取消完成）', icon: 'back', onClick: () => this.setMark(s.id, '') } : { text: '标为完成', icon: 'check', onClick: () => this.setMark(s.id, 'done') },
      '-',
    ];
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
  // 当前主题的颜色，发给预览插件用（默认主题不发，插件用自己原来的配色）
  palette() {
    if (!this.on()) return null;
    const c = getComputedStyle(document.documentElement);
    const v = (n) => c.getPropertyValue(n).trim();
    return { bg: v('--bg'), fg: v('--text'), line: v('--line'), accent: v('--accent'), muted: v('--text-2'), panel: v('--side'), hover: v('--side-hover'), stage: v('--code-bg') };
  },

  renderFilter(all) {
    const bar = $('#side-filter');
    const n = { todo: 0, run: 0, done: 0 };
    for (const s of all) for (const k in n) if (this.inTab(s, k)) n[k]++;
    const tip = { all: '没标完成的全部对话', todo: '你标了待处理的、Claude 在等你选择或批准的、回复完了还没看的', run: 'Claude 正在回复的', done: '你标了完成的' };
    // 按钮和底下那块白色的「选中块」只建一次，之后只改文字和位置：这样选中块才能从旧位置滑到新位置，而不是每次重画时瞬间出现
    if (!bar.querySelector('.sf-ind')) {
      bar.innerHTML = '<span class="sf-ind"></span>' + [['all', '全部'], ['todo', '待处理'], ['run', '进行中'], ['done', '已完成']].map(([k]) => `<button data-f="${k}"></button>`).join('');
      bar.querySelectorAll('button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; renderSidebar(); }; });
    }
    const name = { all: '全部', todo: '待处理', run: '进行中', done: '已完成' };
    bar.querySelectorAll('button').forEach((b) => {
      const k = b.dataset.f;
      const html = name[k] + (k !== 'all' && k !== 'done' && n[k] ? `<i>${n[k]}</i>` : '');
      if (b.innerHTML !== html) b.innerHTML = html;
      b.title = tip[k];
      b.classList.toggle('on', this.filter === k);
    });
    this.moveFilterInd();
  },
  // 选中块滑过去：像一滴水，朝前的那一边先到、后面那一边慢半拍跟上（先拉长再收拢），不是匀速平移
  moveFilterInd() {
    const bar = $('#side-filter');
    const ind = bar && bar.querySelector('.sf-ind');
    const on = bar && bar.querySelector('button.on');
    if (!ind || !on || !bar.offsetWidth) return;
    const left = on.offsetLeft;
    const right = bar.clientWidth - left - on.offsetWidth;
    const first = !ind.dataset.ready;
    const prev = parseFloat(ind.style.left) || 0;
    ind.classList.toggle('no-anim', first);
    ind.classList.toggle('to-right', left > prev);
    ind.classList.toggle('to-left', left < prev);
    ind.style.left = left + 'px';
    ind.style.right = right + 'px';
    if (first) { ind.dataset.ready = '1'; void ind.offsetWidth; ind.classList.remove('no-anim'); }
  },

  renderSidebar() {
    // 展开 / 收起的动画放到一半时别整个重画（切换服务器后会连着刷新好几次，动画会被打断成「瞬间出现」）：等动画放完再画
    if (this._anim && Date.now() - this._anim < 700) { this._dirty = true; return; }
    this._anim = 0;
    const tree = $('#tree');
    const keepScroll = tree.scrollTop;
    tree.innerHTML = '';
    const now = Date.now();
    const mine = data.sessions.filter((s) => (typeof sessionOnCurrentServer !== 'function' || sessionOnCurrentServer(s)) && !s.history);
    this.renderFilter(mine);
    document.body.classList.toggle('has-todo', mine.some((x) => this.inTab(x, 'todo')));
    const shown = mine
      .filter((s) => !searchText || (s.title || '').toLowerCase().includes(searchText))
      .filter((s) => this.inTab(s, this.filter))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // 我的分组：收成一组文件夹（默认收起）。点一个就只看这个分组里的对话，照样按时间分段；再点一次或点「看全部」回来。
    // 手动建的日期分组（11月18日）和时间段重复，不列出来；对话拖到某个分组上就是移进去
    const groups = groupsHere().filter((g) => !this.DATE_RE.test(g.name));
    if (this.gf && !groups.some((g) => g.id === this.gf)) this.gf = '';
    if (groups.length && !searchText) {
      const gopen = this.isOpen('groups') || !!this.gf;
      const g = el('div', 'group' + (gopen ? ' open' : ''));
      const head = el('div', 'group-head', `<span class="gname">我的分组</span><span class="count">${groups.length}</span><span class="chev">${icon('chevDown')}</span>`);
      head.onclick = () => { data.ui.timeOpen = { ...(data.ui.timeOpen || {}), groups: !gopen }; if (gopen) this.gf = ''; save(); foldGroup(g, !gopen); };
      g.appendChild(head);
      const body = el('div', 'group-body');
      for (const x of groups) {
        const row = el('button', 'gf-row' + (this.gf === x.id ? ' on' : ''), `${icon('folder')}<span class="gf-name">${esc(x.name)}</span><span class="gf-n">${mine.filter((s) => s.groupId === x.id).length}</span>`);
        row.title = '只看这个分组里的对话；把对话拖到这里就是移进这个分组';
        row.onclick = () => { this.gf = this.gf === x.id ? '' : x.id; renderSidebar(); };
        row.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/session')) { e.preventDefault(); row.classList.add('drop-target'); } };
        row.ondragleave = () => row.classList.remove('drop-target');
        row.ondrop = (e) => { e.preventDefault(); row.classList.remove('drop-target'); const sid = e.dataTransfer.getData('text/session'); if (sid) moveSession(sid, x.id); };
        body.appendChild(row);
      }
      g.appendChild(body);
      tree.appendChild(g);
      if (this.gf) {
        const chip = el('div', 'gf-chip', `<span>只看分组 <b>${esc(findGroup(this.gf).name)}</b></span><button>看全部</button>`);
        chip.querySelector('button').onclick = () => { this.gf = ''; renderSidebar(); };
        tree.appendChild(chip);
      }
    }
    const inG = this.gf ? shown.filter((s) => s.groupId === this.gf) : shown;
    const secs = [];
    const pins = inG.filter((s) => s.pinned);
    if (pins.length) secs.push({ key: 'pin', name: '置顶', list: pins, pinned: true });
    for (const s of inG) {
      if (s.pinned) continue;
      const b = this.bucket(s.updatedAt || s.createdAt || 0, now);
      let sec = secs.find((x) => x.key === b.key);
      if (!sec) { sec = { ...b, list: [] }; secs.push(sec); }
      sec.list.push(s);
    }
    const hist = sortedSessions(HISTORY);
    if (hist.length && this.filter === 'all' && !this.gf) secs.push({ key: 'hist', name: '历史版本', list: hist, history: true });

    for (const sec of secs) {
      const forced = !!searchText || this.filter !== 'all' || (sec.history && hist.some((x) => x.id === currentId));
      const open = forced || this.isOpen(sec.key);
      const g = el('div', 'group' + (open ? ' open' : '') + (sec.pinned ? ' pinned' : ''));
      const head = el('div', 'group-head');
      const un = unreadOf(sec.list);
      const runs = sec.list.filter((x) => live[x.id]).length;
      head.innerHTML = `<span class="gname">${esc(sec.name)}</span><span class="count">${sec.list.length}</span>${!open && runs ? `<span class="grun"><i style="${animPhase(900)}"></i></span>` : ''}${!open && un ? `<span class="gbadge ${un.kind}">${un.n}</span>` : ''}<span class="chev">${icon('chevDown')}</span>`;
      if (sec.history) head.title = '编辑前、回退前另存的对话，和还没用过的分支';
      // 展开、收起和原来的分组一样带高度动画，动画放完再整个重画
      head.onclick = () => {
        const opening = !g.classList.contains('open');
        data.ui.timeOpen = { ...(data.ui.timeOpen || {}), [sec.key]: opening };
        save();
        if (forced) return renderSidebar();
        foldGroup(g, opening);
      };
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
    if (!secs.length) tree.appendChild(el('div', 'group-empty', searchText ? '没有搜到标题里带这些字的对话' : { todo: '没有待处理的对话。在对话上点右键可以「标为待处理」', run: '现在没有正在回复的对话', done: '还没有标为完成的对话。鼠标移到对话上，点右边的勾就能标为完成' }[this.filter] || '还没有对话'));
    if (searchText && typeof msgSearch !== 'undefined') { tree.appendChild(msgSearch.container()); msgSearch.paint(); }
    tree.scrollTop = keepScroll;
    if (typeof renderPendingChip === 'function') renderPendingChip();
  },

  // 一条对话：原来的那一行，右边加上分组小标签和最后活动时间
  item(s, now) {
    const it = renderItem(s);
    const more = it.querySelector('.more');
    const g = s.groupId && findGroup(s.groupId);
    if (g) it.title = `${s.title}\n分组：${g.name}`;
    // 你手动标了待处理：前面一个橙色的点（已经有别的状态点就不重复加）
    if (s.mark === 'todo' && !it.querySelector('.unread-dot, .running-dot')) { const d = el('span', 'unread-dot ask'); d.title = '你标了待处理'; it.insertBefore(d, it.firstChild); }
    // 鼠标移上来：右边一个勾，点一下标为完成（已完成里是放回列表）
    const done = s.mark === 'done';
    const ok = el('button', 'mini-btn mark-btn', icon(done ? 'back' : 'check'));
    ok.title = done ? '放回列表' : '标为完成';
    ok.onclick = (e) => { e.stopPropagation(); this.setMark(s.id, done ? '' : 'done'); };
    it.insertBefore(ok, more);
    it.insertBefore(el('span', 'itime', this.timeText(s.updatedAt || s.createdAt || now, now)), more);
    return it;
  },
};
