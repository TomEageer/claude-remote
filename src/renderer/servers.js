/* global api, el, esc, icon, toast, data, save, uid, live, showMenu, modal, confirmModal, promptModal, openWizard, renderAll, showView, caps, historyView, fm */
'use strict';

// 多台服务器：每台一份连接配置（data.servers），当前这台的配置同步在 data.settings 里，
// 主进程和其它模块照常读 data.settings；对话按 serverId 归属，侧栏只显示当前服务器的对话。
const SERVER_KEYS = ['mode', 'host', 'port', 'user', 'keyPath', 'workdir', 'proxy', 'bindDirect', 'vpn'];
// mode 总是带上（老的服务器记录没有这个字段，切过去时要把「本机」清掉）
const pickServer = (o) => ({ ...Object.fromEntries(SERVER_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])), mode: o.mode || '' });

function curServer() {
  return (data.servers || []).find((s) => s.id === data.currentServer) || null;
}

// 界面上只显示名字，不显示用户名和地址（避免截图泄露）
function serverLabel(s) {
  if (!s) return '未配置服务器';
  return s.name || `服务器 ${(data.servers || []).indexOf(s) + 1}`;
}

// 邮箱不需要打码（用户确认过），保留函数名方便以后改
function maskEmail(e) {
  return e || '';
}

// 这台服务器上 Claude 用的账号：Claude 账号登录能拿到邮箱和套餐；长期令牌只能靠备注
function accountText(s) {
  if (!s) return '';
  const a = s.account || {};
  if (a.loggedIn === false) return '未登录 Claude';
  const plan = a.plan ? { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' }[a.plan] || a.plan : '';
  if (a.email) return [maskEmail(a.email), plan].filter(Boolean).join(' · ');
  if (s.accountLabel) return s.accountLabel;
  if (a.method === 'oauth_token') return '长期令牌';
  if (a.method) return a.method;
  return '';
}

async function refreshAccount() {
  const s = curServer();
  if (!s) return;
  const r = await api.account();
  if (!r.ok) return;
  s.account = { email: r.email, plan: r.plan, method: r.method, loggedIn: r.known ? r.loggedIn : null, os: r.os, at: Date.now() };
  save();
  if (typeof renderUsage === 'function') renderUsage();
}

// 老版本只有一份配置：转成第一台服务器，已有对话都归它
function migrateServers() {
  if (Array.isArray(data.servers)) return;
  data.servers = [];
  if (data.settings.host && data.settings.user) {
    const s = { id: uid(), name: '', ...pickServer(data.settings) };
    data.servers.push(s);
    data.currentServer = s.id;
    data.sessions.forEach((x) => { if (!x.serverId) x.serverId = s.id; });
  }
  save();
}

// 以前用 SSH 连 127.0.0.1 当「本机」的：同一个用户就直接改成本机模式（会话记录在同一台机器同一个账号下，照常能接着聊）
async function migrateLocalServers() {
  const me = await api.localUser();
  let changed = false;
  for (const s of data.servers || []) {
    if (s.mode !== 'local' && /^(127\.0\.0\.1|localhost|::1)$/i.test(s.host || '') && s.user === me) {
      s.mode = 'local';
      changed = true;
    }
  }
  if (!changed) return;
  const cur = curServer();
  if (cur) Object.assign(data.settings, pickServer(cur));
  save();
  await api.applySettings(data.settings);
  toast('连接本机已改为直接使用这台电脑，不再经过 SSH', 5000);
}

// 老版本分支 / 导入的对话没记服务器，侧栏按服务器过滤后会看不见：按它来自的那个对话找回服务器
function repairOrphanSessions() {
  let n = 0;
  for (const s of data.sessions) {
    if (s.serverId) continue;
    const refs = [s.pendingFork && s.pendingFork.from, ...s.messages.map((m) => m.anchorSid)].filter(Boolean);
    const src = data.sessions.find((x) => x !== s && x.serverId && refs.some((r) => x.claudeId === r || x.id === r));
    if (src) { s.serverId = src.serverId; n++; }
  }
  if (n) save();
}

function sessionOnCurrentServer(s) {
  return !data.currentServer || s.serverId === data.currentServer;
}

// 配置向导完成后：新增一台，或者更新当前这台
function applyServerResult(settings, add, name) {
  if (add || !curServer()) {
    const s = { id: uid(), name: name || '', port: 22, workdir: '~/workspace', proxy: '', bindDirect: false, ...pickServer(settings) };
    data.servers.push(s);
    data.currentServer = s.id;
    resetServerViews();
    if (typeof useDraftFor === 'function') useDraftFor(null);
    currentId = null;
    newChatGroup = null;
    renderAll();
  } else {
    Object.assign(curServer(), pickServer(settings));
    if (name) curServer().name = name;
  }
  Object.assign(data.settings, pickServer(curServer()));
  save();
  renderServerSwitcher();
}

// 设置里改了连接参数：写回当前服务器
function syncServerFromSettings() {
  const s = curServer();
  if (s) {
    const moved = s.host !== data.settings.host || s.user !== data.settings.user || String(s.port) !== String(data.settings.port);
    Object.assign(s, pickServer(data.settings));
    if (moved) {
      s.account = null;
      if (data.ui.usage) delete data.ui.usage[s.id];
      save();
      if (typeof renderUsage === 'function') renderUsage();
      refreshAccount();
    }
  }
  renderServerSwitcher();
}

function resetServerViews() {
  if (typeof caps !== 'undefined') { caps.global = null; caps.status = null; }
  if (typeof historyView !== 'undefined') historyView.items = null;
  // fm.root 是文件页的页面元素，不能清掉（早期版本里它是服务器根目录，清掉后切换服务器再打开文件页会白屏）
  if (typeof fm !== 'undefined') { fm.cur = null; fm.back = []; fm.fwd = []; fm.items = []; fm.seq++; }
}

async function switchServer(id) {
  if (id === data.currentServer) return;
  const s = data.servers.find((x) => x.id === id);
  if (!s) return;
  data.currentServer = id;
  Object.assign(data.settings, pickServer(s));
  save();
  resetServerViews();
  await api.applySettings(data.settings);
  const recent = data.sessions.filter((x) => x.serverId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (typeof useDraftFor === 'function') useDraftFor(recent ? recent.id : null);
  currentId = recent ? recent.id : null;
  newChatGroup = null;
  showView('chat');
  renderAll();
  renderServerSwitcher();
  if (typeof renderUsage === 'function') renderUsage();
  if (typeof filePane !== 'undefined' && filePane.browser) { filePane.browser.cur = null; filePane.browser.back = []; filePane.browser.fwd = []; }
  remoteInfo.workdir = null;
  remoteInfo.home = null;
  const r = await refreshRemoteInfo();
  refreshAccount();
  if (r.ok && typeof adoptOrphansQuietly === 'function') adoptOrphansQuietly();
  if (filePane.open) filePane.follow();
  const away = data.sessions.filter((x) => x.serverId !== id && live[x.id]).length;
  const tail = away ? `；其他服务器上 ${away} 个对话会在后台继续回复` : '';
  toast(r.ok ? `已切换到 ${serverLabel(s)}${tail}` : `已切换到 ${serverLabel(s)}，但连接失败：${r.message}`, r.ok ? (away ? 4000 : 2600) : 6000);
}

function renderServerSwitcher() {
  const b = document.querySelector('#server-switch');
  if (!b) return;
  const s = curServer();
  const count = (data.servers || []).length;
  b.innerHTML = `${icon('server')}<span class="sv-name">${esc(serverLabel(s))}</span>${count > 1 ? `<span class="sv-count">${count}</span>` : ''}${icon('chevDown')}`;
  b.title = s ? `当前服务器：${serverLabel(s)}，点击切换或添加` : '添加服务器';
}

function serverMenu(e) {
  const items = [{ label: '切换服务器' }];
  for (const s of data.servers || []) {
    const n = data.sessions.filter((x) => x.serverId === s.id).length;
    const busy = data.sessions.filter((x) => x.serverId === s.id && live[x.id]).length;
    items.push({ text: serverLabel(s), desc: [busy ? `${busy} 个正在回复` : '', `${n} 个对话`, accountText(s)].filter(Boolean).join(' · '), icon: 'server', current: s.id === data.currentServer, onClick: () => switchServer(s.id) });
  }
  items.push('-');
  items.push({ text: '添加服务器…', icon: 'plus', onClick: () => openWizard(true, { add: true }) });
  if ((data.servers || []).length) items.push({ text: '管理服务器…', icon: 'gear', onClick: manageServers });
  // 切换器在底部状态栏：菜单往上弹
  const r = document.querySelector('#server-switch').getBoundingClientRect();
  showMenu(items, { clientX: r.left, above: r.top });
}

function manageServers() {
  const body = el('div', 'sv-list');
  const draw = () => {
    body.innerHTML = '';
    for (const s of data.servers) {
      const n = data.sessions.filter((x) => x.serverId === s.id).length;
      const row = el('div', 'pl-card sv-row');
      row.innerHTML = `<div class="pl-ico">${icon('server')}</div>
        <div class="pl-main"><div class="pl-name">${esc(serverLabel(s))}${s.id === data.currentServer ? ' <span class="pl-ver">当前</span>' : ''}</div>
        ${s.mode === 'local' ? '<div class="pl-desc sv-addr">这台电脑（不经过 SSH）</div>' : `<div class="pl-desc mono sv-addr" title="点击显示 / 隐藏"><span class="sv-hidden">地址已隐藏 · 点击显示</span><span class="sv-shown">${esc(`${s.user}@${s.host}:${s.port || 22}`)}</span>${s.proxy ? ' · 走代理' : ''}${s.bindDirect ? ' · 绕过本机代理' : ''}</div>`}
        <div class="pl-desc">${n} 个对话${accountText(s) ? ' · ' + esc(accountText(s)) : ''}</div></div><div class="pl-act"></div>`;
      row.querySelector('.sv-addr').onclick = (e) => e.currentTarget.classList.toggle('show');
      const act = row.querySelector('.pl-act');
      const ren = el('button', 'btn', '改名');
      ren.onclick = async () => {
        const v = await promptModal('服务器名称', '名称（留空则显示 用户名@地址）', s.name || '');
        if (v == null) return;
        s.name = v.trim();
        save();
        renderServerSwitcher();
        draw();
      };
      const del = el('button', 'btn', '删除');
      del.onclick = async () => {
        if (s.id === data.currentServer) return toast('不能删除正在使用的服务器，先切换到别的服务器');
        const ok = await confirmModal('删除服务器', `删除「${serverLabel(s)}」后，本机上它的 ${n} 个对话记录也会一起删除（服务器上 Claude Code 自己保存的会话不受影响，以后还能导入）。`, '删除');
        if (!ok) return;
        data.servers = data.servers.filter((x) => x.id !== s.id);
        data.sessions = data.sessions.filter((x) => x.serverId !== s.id);
        data.groups = data.groups.filter((g) => g.serverId !== s.id);
        save();
        renderServerSwitcher();
        renderAll();
        draw();
      };
      act.append(ren, del);
      body.appendChild(row);
    }
    const add = el('button', 'btn primary', `${icon('plus')}<span>添加服务器</span>`);
    add.onclick = () => { closeModal(add); openWizard(true, { add: true }); };
    body.appendChild(add);
  };
  draw();
  modal({ title: '管理服务器', body, wide: true, buttons: [{ text: '关闭', value: true }] });
}

// 重新登录 Claude（令牌过期、换账号）：直接进入向导的登录步骤
function openLogin() {
  if (!curServer()) return openWizard(true, { add: true });
  openWizard(true, { startAt: 'auth' });
}

document.querySelector('#server-switch').onclick = serverMenu;
