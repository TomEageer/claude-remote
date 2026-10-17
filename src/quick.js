'use strict';
// 快速输入：在任何软件里按快捷键（默认 Mac 双击 Option、Windows 双击 Ctrl，也可以设成组合键）呼出一个小输入条，回车就发给 Claude。
// 组合键用系统的全局快捷键注册，不需要额外权限；「双击某个修饰键」系统不支持注册，要用 uiohook 监听键盘，
// macOS 上需要在「辅助功能」里允许一次。监听只用来认出双击，不记录、不保存任何按键。
const path = require('path');
const { BrowserWindow, globalShortcut, screen, systemPreferences, ipcMain } = require('electron');

const isMac = process.platform === 'darwin';
const DEFAULTS = { mode: 'double', key: isMac ? 'alt' : 'ctrl', combo: 'CommandOrControl+Shift+Space' };
const TAP_MAX = 350; // 按下到松开不超过这么久才算「点一下」
const GAP_MAX = 400; // 两次点之间不超过这么久才算「双击」

let qwin = null;
let ctx = { sid: null, title: '' };
let send = () => {};
let cfg = { ...DEFAULTS };
let status = { ok: false, message: '' };
let combo = null;
let hook = null;
let hookOn = false;
let grantTimer = null;

function position() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = 700;
  const b = qwin.getBounds();
  qwin.setBounds({ x: Math.round(d.workArea.x + (d.workArea.width - w) / 2), y: Math.round(d.workArea.y + d.workArea.height * 0.2), width: w, height: b.height });
}

function create() {
  qwin = new BrowserWindow({
    width: 700, height: 130, show: false, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (isMac) qwin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  qwin.setAlwaysOnTop(true, 'floating');
  qwin.loadFile(path.join(__dirname, 'quick.html'));
  qwin.on('blur', () => hide());
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
function keyCodes(k) {
  const K = require('uiohook-napi').UiohookKey;
  return { alt: [K.Alt, K.AltRight], ctrl: [K.Ctrl, K.CtrlRight], shift: [K.Shift, K.ShiftRight], meta: [K.Meta, K.MetaRight] }[k] || [];
}
let started = false;
function startHook() {
  const { uIOhook } = require('uiohook-napi');
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
  ipcMain.handle('quick:config', (_e, c) => apply(c));
  ipcMain.handle('quick:grant', () => grant());
  ipcMain.on('quick:ctx', (_e, c) => { ctx = { sid: c && c.sid ? String(c.sid) : null, title: c && c.title ? String(c.title).slice(0, 60) : '' }; });
  ipcMain.on('quick:hide', () => hide());
  ipcMain.on('quick:resize', (_e, h) => {
    if (!qwin || qwin.isDestroyed()) return;
    const b = qwin.getBounds();
    const height = Math.max(90, Math.min(400, Math.round(Number(h) || 0)));
    if (height !== b.height) qwin.setBounds({ ...b, height });
  });
  ipcMain.on('quick:submit', (_e, p) => {
    hide();
    const text = String((p && p.text) || '').slice(0, 100000);
    const paths = Array.isArray(p && p.paths) ? p.paths.filter((x) => typeof x === 'string').slice(0, 20) : [];
    if (text || paths.length) send('quick:submit', { text, paths, sid: p && typeof p.target === 'string' ? p.target : null });
  });
}

function dispose() {
  stopHook();
  globalShortcut.unregisterAll();
  clearInterval(grantTimer);
}

module.exports = { init, dispose, DEFAULTS };
