'use strict';
// 写盘队列：把存盘从主线程的同步阻塞里挪开（6 MB 的对话同步写一次要卡主线程 20 多毫秒，这段时间 SSH 数据、界面消息都在排队）。
//
// 规则：
// 1. 每个文件一条队列，写入严格串行；写的过程中又来了新内容，只记最新一份，写完这次接着写它（中间的版本直接跳过）。
// 2. 永远「写临时文件 + 改名替换」：临时文件名带进程号和随机数，中途被杀掉，正式文件要么是旧的要么是新的，不会是半截。
// 3. 关窗口时要同步存（writeSync）：直接在主线程同步写完，不等后台。每个文件记着「盘上这份是第几版」，
//    后台那次写完临时文件、准备改名前先看一眼：盘上已经是更新的版本了，就把自己的临时文件扔掉，不会拿旧内容盖掉新内容。
//    改名这一步是同步做的，和同步存盘不会穿插。
// 4. 删除也走同一条队列（内容传 null），不会和写入互相插队。
// 5. Windows 上改名可能被杀毒软件 / 索引短暂占着（EPERM / EBUSY），重试几次。
// 6. 写失败（磁盘满、目录只读）：正式文件不动，记下错误，队列接着跑，不让主进程崩。
// 没有 fsync：防的是进程被杀，不是整机断电（和原来的同步写法一样）。

const fs = require('fs');

const RETRY = 6;
const RETRY_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const busy = (e) => e && (e.code === 'EPERM' || e.code === 'EBUSY');
const tmpName = (file) => `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;

class WriteQueue {
  constructor() {
    this.files = new Map(); // 文件 -> { pending, has, gen, onDisk, running, error }
  }

  st(file) {
    let s = this.files.get(file);
    if (!s) this.files.set(file, (s = { pending: undefined, has: false, gen: 0, onDisk: 0, running: null, error: null }));
    return s;
  }

  // 后台写（content 为 null 是删除）；返回这条队列清空时完成的 Promise
  schedule(file, content) {
    const s = this.st(file);
    s.pending = content;
    s.has = true;
    s.gen++;
    if (!s.running) s.running = this.pump(file, s);
    return s.running;
  }

  async pump(file, s) {
    // 先让出一下：保证 schedule 里 s.running 已经登记上，下面结束时再清掉（否则一次都不用等的删除会留下个永远「在写」的标记）
    await null;
    while (s.has) {
      const content = s.pending;
      const gen = s.gen;
      s.pending = undefined;
      s.has = false;
      try {
        if (content === null) {
          // 删除很快，同步做：先看盘上有没有更新的版本、再删，中间不留空当（否则关窗时刚同步写好的新内容可能被删掉）
          if (!(s.onDisk > gen)) {
            try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            s.onDisk = gen;
          }
        } else {
          const tmp = tmpName(file);
          try {
            await fs.promises.writeFile(tmp, content);
            for (let i = 0; ; i++) {
              // 同步存盘已经写了更新的版本：这份过时了，不替换
              if (s.onDisk > gen) break;
              try { fs.renameSync(tmp, file); s.onDisk = gen; break; } catch (e) {
                if (!busy(e) || i >= RETRY - 1) throw e;
                await sleep(RETRY_MS * (i + 1));
              }
            }
          } finally {
            fs.promises.unlink(tmp).catch(() => {}); // 改名成功后临时文件已经不在了，这里只清失败 / 作废的
          }
        }
        s.error = null;
      } catch (e) {
        s.error = e;
        console.error('存盘失败', file, e.message);
      }
    }
    s.running = null;
  }

  // 关窗口时用：同步写完才返回。排队中还没写的旧内容作废；正在后台写的那次会发现自己过时、不替换
  writeSync(file, content) {
    const s = this.st(file);
    s.pending = undefined;
    s.has = false;
    const gen = ++s.gen;
    if (content === null) {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      s.onDisk = gen;
      return;
    }
    const tmp = tmpName(file);
    try {
      fs.writeFileSync(tmp, content);
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, file); break; } catch (e) {
          if (!busy(e) || i >= RETRY - 1) throw e;
          sleepSync(RETRY_MS * (i + 1));
        }
      }
      s.onDisk = gen;
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  get busy() {
    for (const s of this.files.values()) if (s.running) return true;
    return false;
  }

  // 等所有排队中 / 正在写的都落盘（退出、重启安装更新前用）
  async flushAll() {
    for (let again = true; again; ) {
      again = false;
      for (const s of this.files.values()) {
        const r = s.running;
        if (!r) continue;
        await r;
        if (s.running && s.running !== r) again = true; // 等的过程中又排上了新的
      }
    }
  }
}

// 启动时清掉上次被杀掉时留下的临时文件（新的 名字.进程号.随机.tmp，和老版本的 名字.tmp）
function cleanTmp(dir) {
  let list;
  try { list = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of list) if (/\.json(\.\d+\.[a-z0-9]+)?\.tmp$/.test(f)) { try { fs.unlinkSync(require('path').join(dir, f)); } catch (_) {} }
}

module.exports = { WriteQueue, cleanTmp };
