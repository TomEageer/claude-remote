// 不启动界面，检查 main.js 的顶层代码能不能跑通（比如变量在定义之前就被用到这类一启动就崩的错误）。
// 用法：node scripts/check-main.js
const Module = require('module');
const path = require('path');
const noop = () => {};
const handlers = new Set();
const fakeApp = {
  isPackaged: true, getPath: () => '/tmp/cr-check', setPath: noop, getVersion: () => '0.0.0',
  whenReady: () => new Promise(noop), on: noop, quit: noop, exit: noop,
  requestSingleInstanceLock: () => true, setAppUserModelId: noop, name: 'check',
};
const electron = {
  app: fakeApp,
  BrowserWindow: function () {},
  ipcMain: { handle: (ch) => { if (handlers.has(ch)) throw new Error('重复注册 IPC：' + ch); handlers.add(ch); }, on: noop },
  dialog: {}, shell: {}, net: {}, screen: {}, nativeTheme: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop },
};
const load = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return electron;
  if (req === 'electron-updater') return { autoUpdater: { on: noop } };
  return load.call(this, req, ...rest);
};
try {
  require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'src', 'main.js'));
  console.log(`main.js 顶层代码正常，注册了 ${handlers.size} 个 IPC 接口`);
  process.exit(0);
} catch (e) {
  console.error('main.js 启动就会出错：\n' + e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
