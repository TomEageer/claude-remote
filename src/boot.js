// 启动入口：决定从哪里加载软件代码。
//
// 快速更新下载的新代码放在用户数据目录（app-update/），不再替换安装目录里的 app.asar。
// 原因：macOS 认程序靠签名，签名把 app.asar 也算进去了；以前每次快速更新都改了 .app，
// 系统就当成另一个程序，之前允许过的文件夹 / 完全磁盘访问权限全部作废，要重新点。
// 现在 .app 只在完整更新（Electron 版本变了）时才变，权限能一直保留。
//
// app-update/current.json 记着当前用哪个包：{ version, electron, file }。
// 只有比安装包自带的版本新、而且 Electron 版本一致时才用；否则用自带的，并清掉过时的包。
const { app } = require('electron');
// .asar 文件要用 original-fs 操作，Electron 自带的 fs 会把它当成文件夹
let fs;
try { fs = require('original-fs'); } catch (_) { fs = require('fs'); }
const path = require('path');

if (!app.isPackaged && process.env.CR_USERDATA) app.setPath('userData', process.env.CR_USERDATA);

const builtin = require('../package.json').version;
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function external() {
  const dir = path.join(app.getPath('userData'), 'app-update');
  let cur = null;
  if (!fs.existsSync(dir)) return null;
  try { cur = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')); } catch (_) { cur = null; }
  const file = cur && cur.file && path.join(dir, path.basename(cur.file));
  const usable = file && cur.electron === process.versions.electron && cmp(cur.version, builtin) > 0 && fs.existsSync(file);
  // 用不上的（装了更新的完整版、Electron 换了）就清掉，下次不再看
  if (!usable) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} return null; }
  // 顺手删掉以前的旧包（Windows 上正在用的包删不掉，所以每个版本一个文件名）
  try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.asar') && n !== path.basename(file)) fs.rmSync(path.join(dir, n), { force: true }); } catch (_) {}
  return file;
}

const ext = external();
if (ext) {
  try {
    require(path.join(ext, 'src', 'main.js'));
  } catch (e) {
    // 新包坏了：把它作废，重新启动一次，就会用安装包自带的版本（不在这里直接加载，免得半截注册过的东西冲突）
    try { fs.renameSync(path.join(path.dirname(ext), 'current.json'), path.join(path.dirname(ext), 'current.bad.json')); } catch (_) {}
    console.error('加载更新的代码失败，改用安装包自带的版本：', e);
    app.relaunch();
    app.exit(0);
  }
} else {
  require('./main.js');
}
