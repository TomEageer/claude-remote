// macOS 触控板震感：拖动 / 滚动时间轴每经过一条消息「咔」一下。
// Electron 没有震感接口，系统的 NSHapticFeedbackManager 用 osascript（JavaScript for Automation）调用，
// 常驻一个小进程，收到一行就震一下，不用每次重新起进程。只有手指放在触控板上时才感觉得到。
const { spawn } = require('child_process');

// 系统的三种震感，从轻到重：a = alignment（对齐，最轻）、g = generic（普通）、l = levelChange（档位变化，最明显）。
// 一次读到多行只震最后一下。读到空（本软件退出、管道关了）就退出
const SCRIPT = `
ObjC.import('AppKit');
var p = $.NSHapticFeedbackManager.defaultPerformer;
var fh = $.NSFileHandle.fileHandleWithStandardInput;
for (;;) {
  var s = $.NSString.alloc.initWithDataEncoding(fh.availableData, $.NSUTF8StringEncoding).js;
  if (!s || !s.length) break;
  var c = s.trim().slice(-1);
  if (c === 'a' || c === 'g' || c === 'l') p.performFeedbackPatternPerformanceTime(c === 'l' ? 2 : c === 'g' ? 0 : 1, 1);
}`;

let child = null;
let last = 0;

// level：light / medium / strong（默认 strong）
function haptic(level) {
  if (process.platform !== 'darwin') return;
  const now = Date.now();
  if (now - last < 25) return; // 太密了手感反而是嗡嗡的
  last = now;
  try {
    if (!child) {
      child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', () => { child = null; });
      child.on('error', () => { child = null; });
      child.stdin.on('error', () => {});
    }
    child.stdin.write(level === 'light' ? 'a\n' : level === 'medium' ? 'g\n' : 'l\n');
  } catch (_) { child = null; }
}

function stopHaptic() {
  if (!child) return;
  try { child.stdin.end(); child.kill(); } catch (_) {}
  child = null;
}

module.exports = { haptic, stopHaptic };
