'use strict';
// 快速输入：在任何软件里按快捷键（默认 Mac 双击 Option、Windows 双击 Ctrl，也可以设成组合键）呼出一个小输入条，回车就发给 Claude。
// 组合键用系统的全局快捷键注册，不需要额外权限；「双击某个修饰键」系统不支持注册，要用 uiohook 监听键盘，
// macOS 上需要在「辅助功能」里允许一次。监听只用来认出双击，不记录、不保存任何按键。
const path = require('path');
const fs = require('fs');
const { BrowserWindow, globalShortcut, screen, systemPreferences, ipcMain } = require('electron');

const isMac = process.platform === 'darwin';
const DEFAULTS = { mode: 'double', key: isMac ? 'alt' : 'ctrl', combo: 'CommandOrControl+Shift+Space', pos: 'center' };
const WIN_W = 756; // 输入条本身约 700 宽，两边各留 28 给阴影
const TAP_MAX = 350; // 按下到松开不超过这么久才算「点一下」
const GAP_MAX = 400; // 两次点之间不超过这么久才算「双击」

let qwin = null;
let ctx = { sid: null, title: '', recent: [] };
let send = () => {};
let getWin = () => null;
let posFile = null;
let cfg = { ...DEFAULTS };
let status = { ok: false, message: '' };
let combo = null;
let hook = null;
let hookOn = false;
let grantTimer = null;

// 出现位置：跟随鼠标高度 / 屏幕正中（拖动过就记住） / 屏幕底部。底部和靠下时往上长，列表变长也不会超出屏幕
let anchorBottom = false;
function position() {
  const b = qwin.getBounds();
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  const a = d.workArea;
  const cx = Math.round(a.x + (a.width - WIN_W) / 2);
  anchorBottom = false;
  if (cfg.pos === 'center') {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(posFile, 'utf8')); } catch (_) {}
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const on = screen.getAllDisplays().some((x) => saved.x >= x.workArea.x - 40 && saved.x + 200 <= x.workArea.x + x.workArea.width + 40 && saved.y >= x.workArea.y - 10 && saved.y + 80 <= x.workArea.y + x.workArea.height);
      if (on) return qwin.setBounds({ x: saved.x, y: saved.y, width: WIN_W, height: b.height });
    }
    return qwin.setBounds({ x: cx, y: Math.round(a.y + (a.height - 300) / 2), width: WIN_W, height: b.height });
  }
  if (cfg.pos === 'bottom') {
    anchorBottom = true;
    return qwin.setBounds({ x: cx, y: a.y + a.height - b.height - 24, width: WIN_W, height: b.height });
  }
  // 跟随鼠标：输入框落在鼠标那一行（放不下时整体往上挪，不超出屏幕）
  qwin.setBounds({ x: cx, y: Math.max(a.y, Math.min(a.y + a.height - b.height, Math.round(pt.y - 36))), width: WIN_W, height: b.height });
}
let posTimer = null;
function savePos() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (!qwin || qwin.isDestroyed() || !posFile) return;
    const { x, y } = qwin.getBounds();
    try { fs.writeFileSync(posFile, JSON.stringify({ x, y })); } catch (_) {}
  }, 400);
}

// 打开完整窗口（带上会话就直接打开那个会话）
function openMain(sid) {
  hide();
  const w = getWin();
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (sid) send('notify:open', sid);
}

function create() {
  qwin = new BrowserWindow({
    width: WIN_W, height: 160, show: false, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (isMac) qwin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  qwin.setAlwaysOnTop(true, 'floating');
  qwin.loadFile(path.join(__dirname, 'quick.html'));
  qwin.on('blur', () => hide());
  qwin.on('moved', () => { if (cfg.pos === 'center') savePos(); });
  qwin.on('closed', () => { qwin = null; });
}

function show() {
  if (!qwin || qwin.isDestroyed()) create();
  position();
  const go = () => { qwin.webContents.send('quick:show', ctx); qwin.show(); qwin.focus(); };
  if (qwin.webContents.isLoading()) qwin.webContents.once('did-finish-load', go);
  else go();
}
function hide() { if (qwin && !qwin.isDestroyed() && qwin.isVisible()) qwin.hide(); }
function toggle() { if (qwin && !qwin.isDestroyed() && qwin.isVisible()) hide(); else show(); }

// ---------- 双击修饰键 ----------
// 键盘监听是原生模块，二进制文件只在安装包的 app.asar.unpacked 里。快速更新的代码包放在用户数据目录，
// 旁边没有 .unpacked，直接 require 会报「Cannot find module」：找不到就从安装包里的 app.asar 加载
// （Electron 会自动去它旁边的 app.asar.unpacked 取二进制文件）
let hookMod = null;
function uiohook() {
  if (hookMod) return hookMod;
  try { hookMod = require('uiohook-napi'); } catch (e) {
    if (!process.resourcesPath) throw e;
    hookMod = require(path.join(process.resourcesPath, 'app.asar', 'node_modules', 'uiohook-napi'));
  }
  return hookMod;
}
function keyCodes(k) {
  const K = uiohook().UiohookKey;
  return { alt: [K.Alt, K.AltRight], ctrl: [K.Ctrl, K.CtrlRight], shift: [K.Shift, K.ShiftRight], meta: [K.Meta, K.MetaRight] }[k] || [];
}
let started = false;
function startHook() {
  const { uIOhook } = uiohook();
  if (!hook) {
    // 监听只挂一次（uIOhook 是全局唯一的），之后只开关
    hook = uIOhook;
    let down = false;
    let downAt = 0;
    let dirty = false; // 按着修饰键时又按了别的键（比如 Option+C），不算点一下
    let lastTap = 0;
    hook.on('keydown', (e) => {
      if (!hookOn) return;
      if (keyCodes(cfg.key).includes(e.keycode)) { if (!down) { down = true; downAt = Date.now(); dirty = false; } }
      else { dirty = true; lastTap = 0; }
    });
    hook.on('keyup', (e) => {
      if (!hookOn || !keyCodes(cfg.key).includes(e.keycode) || !down) return;
      down = false;
      const now = Date.now();
      if (dirty || now - downAt > TAP_MAX) { lastTap = 0; return; }
      if (lastTap && now - lastTap < GAP_MAX) { lastTap = 0; toggle(); } else lastTap = now;
    });
    hook.on('mousedown', () => { lastTap = 0; dirty = true; });
  }
  if (!started) { hook.start(); started = true; }
  hookOn = true;
}
function stopHook() {
  hookOn = false;
  if (hook && started) { try { hook.stop(); } catch (_) {} started = false; }
}

const KEY_NAME = { alt: isMac ? 'Option' : 'Alt', ctrl: 'Ctrl', shift: 'Shift', meta: isMac ? 'Command' : 'Win' };

function apply(next) {
  cfg = { ...DEFAULTS, ...(next || {}) };
  if (combo) { globalShortcut.unregister(combo); combo = null; }
  stopHook();
  clearInterval(grantTimer);
  if (cfg.mode === 'off') return (status = { ok: true, message: '已关闭' });
  if (cfg.mode === 'combo') {
    let ok = false;
    try { ok = globalShortcut.register(cfg.combo, toggle); } catch (_) {}
    if (ok) combo = cfg.combo;
    return (status = ok ? { ok: true, message: `已生效：${cfg.combo.replace('CommandOrControl', isMac ? 'Command' : 'Ctrl')}` } : { ok: false, message: '这个组合键被别的软件占用了，或者系统不允许，换一个试试' });
  }
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
    watchGrant();
    return (status = { ok: false, needGrant: true, message: `双击 ${KEY_NAME[cfg.key]} 需要在「系统设置 → 隐私与安全性 → 辅助功能」里允许本软件` });
  }
  try { startHook(); } catch (e) { return (status = { ok: false, message: '键盘监听启动失败：' + e.message }); }
  return (status = { ok: true, message: `已生效：双击 ${KEY_NAME[cfg.key]}` });
}

// 还没授权时每 3 秒看一眼：不管是点「去允许」还是自己去系统设置里打开的开关，一允许就生效，不用重启
function watchGrant() {
  clearInterval(grantTimer);
  grantTimer = setInterval(() => {
    if (systemPreferences.isTrustedAccessibilityClient(false)) { clearInterval(grantTimer); send('quick:status', apply(cfg)); }
  }, 3000);
}

// macOS：弹系统的授权提示
function grant() {
  if (!isMac) return status;
  systemPreferences.isTrustedAccessibilityClient(true);
  watchGrant();
  return status;
}

function init(opts) {
  send = opts.send;
  getWin = opts.getWin || getWin;
  posFile = opts.posFile || null;
  ipcMain.on('quick:open', (_e, sid) => openMain(typeof sid === 'string' ? sid : null));
  ipcMain.handle('quick:config', (_e, c) => apply(c));
  ipcMain.handle('quick:grant', () => grant());
  ipcMain.on('quick:ctx', (_e, c) => {
    const recent = Array.isArray(c && c.recent) ? c.recent.slice(0, 5).map((r) => ({ sid: String(r.sid), title: String(r.title || '').slice(0, 80), state: String(r.state || 'idle'), at: Number(r.at) || 0 })) : [];
    ctx = { sid: c && c.sid ? String(c.sid) : null, title: c && c.title ? String(c.title).slice(0, 60) : '', recent };
    if (qwin && !qwin.isDestroyed() && qwin.isVisible()) qwin.webContents.send('quick:ctx', ctx);
  });
  ipcMain.on('quick:hide', () => hide());
  ipcMain.on('quick:resize', (_e, h) => {
    if (!qwin || qwin.isDestroyed()) return;
    const b = qwin.getBounds();
    const height = Math.max(90, Math.min(560, Math.round(Number(h) || 0)));
    if (height === b.height) return;
    // 底部模式往上长；其余往下长，但不超出所在屏幕的底边
    const a = screen.getDisplayMatching(b).workArea;
    let y = anchorBottom ? b.y + b.height - height : b.y;
    y = Math.max(a.y, Math.min(y, a.y + a.height - height));
    qwin.setBounds({ ...b, height, y });
  });
  ipcMain.on('quick:submit', (_e, p) => {
    hide();
    const text = String((p && p.text) || '').slice(0, 100000);
    const paths = Array.isArray(p && p.paths) ? p.paths.filter((x) => typeof x === 'string').slice(0, 20) : [];
    if (!text && !paths.length) return;
    send('quick:submit', { text, paths, sid: p && typeof p.target === 'string' ? p.target : null });
    // 发出去后打开完整窗口，界面那边会跳到这个对话
    openMain(null);
  });
}

function closeWindow() {
  if (qwin && !qwin.isDestroyed()) qwin.destroy();
  qwin = null;
}

function dispose() {
  stopHook();
  globalShortcut.unregisterAll();
  clearInterval(grantTimer);
}

module.exports = { init, dispose, closeWindow, show, apply, DEFAULTS };
