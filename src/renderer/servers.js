/* global api, el, esc, icon, toast, data, save, uid, live, showMenu, modal, confirmModal, promptModal, openWizard, renderAll, showView, caps, historyView, fm */
'use strict';

// 多台服务器：每台一份连接配置（data.servers），当前这台的配置同步在 data.settings 里，
// 主进程和其它模块照常读 data.settings；对话按 serverId 归属，侧栏只显示当前服务器的对话。
const SERVER_KEYS = ['host', 'port', 'user', 'keyPath', 'workdir', 'proxy', 'bindDirect'];
const pickServer = (o) => Object.fromEntries(SERVER_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function curServer() {
  return (data.servers || []).find((s) => s.id === data.currentServer) || null;
}

function serverLabel(s) {
  if (!s) return '未配置服务器';
  return s.name || `${s.user}@${s.host}`;
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

function sessionOnCurrentServer(s) {
  return !data.currentServer || s.serverId === data.currentServer;
}

// 配置向导完成后：新增一台，或者更新当前这台
function applyServerResult(settings, add) {
  if (add || !curServer()) {
    const s = { id: uid(), name: '', port: 22, workdir: '~/workspace', proxy: '', bindDirect: false, ...pickServer(settings) };
    data.servers.push(s);
    data.currentServer = s.id;
    resetServerViews();
    currentId = null;
    newChatGroup = null;
    renderAll();
  } else {
    Object.assign(curServer(), pickServer(settings));
  }
  Object.assign(data.settings, pickServer(curServer()));
  save();
  renderServerSwitcher();
}

// 设置里改了连接参数：写回当前服务器
function syncServerFromSettings() {
  const s = curServer();
  if (s) Object.assign(s, pickServer(data.settings));
  renderServerSwitcher();
}

function resetServerViews() {
  if (typeof caps !== 'undefined') { caps.global = null; caps.status = null; }
  if (typeof historyView !== 'undefined') historyView.items = null;
  if (typeof fm !== 'undefined') { fm.cur = null; fm.root = null; fm.back = []; fm.fwd = []; fm.items = []; }
}

async function switchServer(id) {
  if (id === data.currentServer) return;
  if (Object.keys(live).length) return toast('有对话正在回复，等它结束再切换服务器');
  const s = data.servers.find((x) => x.id === id);
  if (!s) return;
  data.currentServer = id;
  Object.assign(data.settings, pickServer(s));
  save();
  resetServerViews();
  await api.applySettings(data.settings);
  const recent = data.sessions.filter((x) => x.serverId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  currentId = recent ? recent.id : null;
  newChatGroup = null;
  showView('chat');
  renderAll();
  renderServerSwitcher();
  const r = await api.connect();
  toast(r.ok ? `已切换到 ${serverLabel(s)}` : `已切换到 ${serverLabel(s)}，但连接失败：${r.message}`, r.ok ? 2600 : 6000);
}

function renderServerSwitcher() {
  const b = document.querySelector('#server-switch');
  if (!b) return;
  const s = curServer();
  const count = (data.servers || []).length;
  b.innerHTML = `${icon('server')}<span class="sv-name">${esc(serverLabel(s))}</span>${count > 1 ? `<span class="sv-count">${count}</span>` : ''}${icon('chevDown')}`;
  b.title = s ? `当前服务器：${s.user}@${s.host}${s.port && Number(s.port) !== 22 ? ':' + s.port : ''}，点击切换或添加` : '添加服务器';
}

function serverMenu(e) {
  const items = [{ label: '切换服务器' }];
  for (const s of data.servers || []) {
    const n = data.sessions.filter((x) => x.serverId === s.id).length;
    items.push({ text: serverLabel(s), desc: `${n} 个对话`, icon: 'server', current: s.id === data.currentServer, onClick: () => switchServer(s.id) });
  }
  items.push('-');
  items.push({ text: '添加服务器…', icon: 'plus', onClick: () => openWizard(true, { add: true }) });
  if ((data.servers || []).length) items.push({ text: '管理服务器…', icon: 'gear', onClick: manageServers });
  const r = document.querySelector('#server-switch').getBoundingClientRect();
  showMenu(items, { clientX: r.left, clientY: r.bottom + 4 });
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
        <div class="pl-desc mono">${esc(`${s.user}@${s.host}:${s.port || 22}`)}${s.proxy ? ' · 代理 ' + esc(s.proxy) : ''}${s.bindDirect ? ' · 绕过本机代理' : ''}</div>
        <div class="pl-desc">${n} 个对话</div></div><div class="pl-act"></div>`;
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
        save();
        renderServerSwitcher();
        renderAll();
        draw();
      };
      act.append(ren, del);
      body.appendChild(row);
    }
    const add = el('button', 'btn primary', `${icon('plus')}<span>添加服务器</span>`);
    add.onclick = () => { document.querySelector('.overlay').remove(); openWizard(true, { add: true }); };
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
