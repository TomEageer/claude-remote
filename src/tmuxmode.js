// tmux 模式（实验功能）：这个对话的 Claude 跑在服务器上一个 tmux 窗口里，是平时终端里那个交互式 Claude。
// 任何人 tmux attach 进去，看到和操作的都是标准的 Claude 界面；软件这边：
//   发消息 = 把文字粘贴进那个窗口再回车；
//   看回复 = 实时读 Claude 自己写的会话记录（~/.claude/projects/<目录>/<会话ID>.jsonl），翻译成和普通模式一样的事件；
//   等你确认 / 选择 = 读窗口画面，把问题和选项交给界面，点了就替你在窗口里按对应的键；
//   停止 = 在窗口里按 Esc。
// 断网、关软件都不影响 Claude 在 tmux 里继续干活，重连后从上次读到的那一行接着读。Windows 服务器没有 tmux，不支持。
'use strict';

const NAME_RE = /^[^\s:.'"`$\\;|&<>()*?!#]{1,60}$/; // tmux 会话名、窗口名：不能有空格、冒号、点和 shell 特殊字符
const SOCK_RE = /^\/[A-Za-z0-9._\/-]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createTmuxMode({ send, shQuote, previewOf, permArg, claudeEnv }) {
  const watchers = new Map(); // 对话 id -> { conn, cfg, path, line, stream, pollTimer, promptKey, stopped }

  const check = (t) => {
    if (!t || !NAME_RE.test(t.session || '') || !NAME_RE.test(t.window || '')) throw new Error('tmux 会话名或窗口名不合法：不能有空格、冒号、点和特殊符号');
    if (t.socket && !SOCK_RE.test(t.socket)) throw new Error('tmux 服务器位置要写完整路径，比如 /tmp/tmux-1000/default');
  };
  const tmux = (t) => `tmux${t.socket ? ' -S ' + shQuote(t.socket) : ''}`;
  const target = (t) => shQuote(`=${t.session}:${t.window}`);
  const run = async (conn, cmd, stdin) => conn.exec(cmd, stdin);
  const ok = async (conn, cmd, stdin) => { const r = await run(conn, cmd, stdin); return r.code === 0 ? r : null; };

  async function precheck(conn) {
    await conn.ensure();
    if (conn.isWindows()) throw new Error('这台是 Windows 服务器，没有 tmux，用不了 tmux 模式');
    if (!(await ok(conn, 'command -v tmux >/dev/null 2>&1'))) throw new Error('服务器上没有装 tmux：先在服务器上安装（比如 sudo apt install tmux），再打开 tmux 模式');
  }

  // 会话记录文件：Claude 第一次收到消息后才会建，所以可能要等一会儿
  async function findTranscript(conn, claudeId) {
    if (!UUID_RE.test(claudeId || '')) return null;
    const r = await run(conn, `ls -t "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${claudeId}.jsonl 2>/dev/null | head -1`);
    return (r.out || '').trim() || null;
  }
  async function lineCount(conn, p) {
    const r = await run(conn, `wc -l < ${shQuote(p)} 2>/dev/null`);
    return parseInt((r.out || '').trim(), 10) || 0;
  }

  // 窗口里正在跑的东西：shell 还是 Claude
  async function paneInfo(conn, t) {
    const r = await ok(conn, `${tmux(t)} display-message -p -t ${target(t)} '#{pane_current_command}|#{pane_current_path}'`);
    if (!r) return null;
    const [cmd, cwd] = r.out.trim().split('|');
    return { cmd, cwd, claude: /claude|node/i.test(cmd || '') };
  }

  // 保证 tmux 会话和窗口在、窗口里有 Claude 在跑。返回 { claudeId, adopted, started }
  async function ensure({ conn, t, cwd, claudeId, isNew, model, perm }) {
    check(t);
    await precheck(conn);
    const dir = cwd || '~';
    const cdir = dir === '~' || dir.startsWith('~/') ? dir.replace(/^~/, '"$HOME"') : shQuote(dir);
    if (!(await ok(conn, `${tmux(t)} has-session -t ${shQuote('=' + t.session)} 2>/dev/null`))) {
      const r = await run(conn, `mkdir -p ${cdir} && ${tmux(t)} new-session -d -s ${shQuote(t.session)} -n ${shQuote(t.window)} -c ${cdir} -x 200 -y 50`);
      if (r.code !== 0) throw new Error('建 tmux 会话失败：' + (r.err || r.out).trim().slice(0, 200));
    } else {
      const w = await run(conn, `${tmux(t)} list-windows -t ${shQuote('=' + t.session)} -F '#{window_name}'`);
      if (!w.out.split('\n').map((x) => x.trim()).includes(t.window)) {
        const r = await run(conn, `mkdir -p ${cdir} && ${tmux(t)} new-window -d -t ${shQuote('=' + t.session + ':')} -n ${shQuote(t.window)} -c ${cdir}`);
        if (r.code !== 0) throw new Error('建 tmux 窗口失败：' + (r.err || r.out).trim().slice(0, 200));
      }
    }
    const info = await paneInfo(conn, t);
    if (!info) throw new Error('找不到 tmux 窗口 ' + t.session + ':' + t.window);
    if (info.claude) {
      // 窗口里本来就有 Claude 在跑：接上它，跟着它用的会话走（找这个目录下最近在写的记录）
      const proj = info.cwd.replace(/[^a-zA-Z0-9]/g, '-');
      const r = await run(conn, `ls -t "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/${shQuote(proj)}/*.jsonl 2>/dev/null | head -1`);
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl\s*$/i.exec(r.out || '');
      return { claudeId: m ? m[1] : claudeId, adopted: !!(m && m[1] !== claudeId), started: false };
    }
    // 窗口里是 shell：在里面启动 Claude（用这个对话的会话编号，接着之前的内容）
    if (!UUID_RE.test(claudeId || '')) throw new Error('会话编号不合法');
    const args = [isNew ? '--session-id' : '--resume', claudeId];
    if (model && model !== 'default' && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
    if (perm) args.push('--permission-mode', permArg(perm));
    // command：跳过 shell 里同名的函数、别名（有人在 .zshrc 里把 claude 包了一层，比如强制走某个代理），和普通模式一样直接运行程序
    const line = `cd ${cdir} && ${claudeEnv} command claude ${args.map(shQuote).join(' ')}`;
    await run(conn, `${tmux(t)} send-keys -t ${target(t)} -l ${shQuote(line)} && ${tmux(t)} send-keys -t ${target(t)} Enter`);
    // 等 Claude 起来（窗口里的程序从 shell 变成 Claude）
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const p = await paneInfo(conn, t);
      if (p && p.claude) break;
    }
    await new Promise((r) => setTimeout(r, 1500)); // 界面画出来、能接收输入
    return { claudeId, adopted: false, started: true };
  }

  // ---------- 读会话记录 ----------
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '');
  function translate(d, emit) {
    const m = d.message || {};
    if (d.type === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && c.text && c.text.trim()) emit({ type: 'text', text: c.text, whole: true });
        else if (c.type === 'tool_use') emit({ type: 'tool', id: c.id, name: c.name, input: c.input });
        else if (c.type === 'thinking') emit({ type: 'thinking' });
      }
      const u = m.usage;
      if (u) emit({ type: 'tusage', context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) });
    } else if (d.type === 'user' && !d.isMeta) {
      if (Array.isArray(m.content) && m.content.some((c) => c && c.type === 'tool_result')) {
        for (const c of m.content) if (c && c.type === 'tool_result') emit({ type: 'tool_result', id: c.tool_use_id, isError: !!c.is_error, preview: previewOf(c.content) });
        return;
      }
      const text = textOf(m.content).trim();
      if (!text) return;
      if (/^\[Request interrupted by user/.test(text)) { emit({ type: 'stopped' }); emit({ type: 'end' }); return; }
      if (/^<(command-|local-command|system-reminder)|^Caveat:/.test(text)) return;
      emit({ type: 'tuser', text });
    } else if (d.type === 'system' && d.subtype === 'turn_duration') {
      emit({ type: 'result', isError: false, durationMs: d.durationMs || 0 });
      emit({ type: 'end' });
    }
  }

  // ---------- 等你确认 / 选择：读窗口画面 ----------
  // 认菜单：问题一行 + 若干选项（当前选中的前面有 ❯），底下是「Enter to confirm / Esc to cancel」之类的提示
  function parsePrompt(screen) {
    const lines = screen.split('\n');
    let end = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (/Esc to cancel|Enter to confirm|Enter to select/i.test(lines[i])) { end = i; break; }
    if (end < 0) return null;
    const opts = [];
    let cur = 0;
    let i = end - 1;
    for (; i >= 0; i--) {
      const l = lines[i];
      const m = /^\s*(❯|›|>)?\s*(?:(\d+)\.\s+)?(\S.*?)\s*$/.exec(l);
      if (!l.trim()) { if (opts.length) break; continue; }
      if (!m || (!m[1] && !m[2] && !/^\s{2,}/.test(l))) break;
      opts.unshift({ label: m[3], num: m[2] || '', on: !!m[1] });
    }
    if (opts.length < 2) return null;
    opts.forEach((o, k) => { if (o.on) cur = k; });
    // 问题：选项上面最近的几行非空文字
    const q = [];
    for (let j = i; j >= 0 && q.length < 3; j--) { const l = lines[j].trim(); if (!l || /^[─━╌-]{6,}/.test(l)) { if (q.length) break; continue; } q.unshift(l); }
    return { question: q.join(' '), options: opts.map((o) => ({ label: o.label })), cur };
  }

  async function snapshot(sid) {
    const w = watchers.get(sid);
    if (!w) return '';
    const r = await run(w.conn, `${tmux(w.cfg)} capture-pane -p -t ${target(w.cfg)}`);
    return r.code === 0 ? r.out.replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n') : '';
  }

  // ---------- 开始 / 停止看着这个对话 ----------
  async function watch(sid, { conn, cfg, claudeId, from }) {
    check(cfg);
    const old = watchers.get(sid);
    if (old && !old.stopped && old.claudeId === claudeId) return { ok: true, line: old.line };
    if (old) unwatch(sid);
    const w = { conn, cfg, claudeId, path: null, line: Number.isFinite(from) ? from : -1, stream: null, pollTimer: null, promptKey: '', stopped: false };
    watchers.set(sid, w);
    const emit = (ev) => send('claude:event', { sessionId: sid, ev: { ...ev, tline: w.line } });
    // 等会话记录出现，然后从上次读到的地方接着读
    (async () => {
      for (let i = 0; i < 600 && !w.stopped && !w.path; i++) {
        w.path = await findTranscript(conn, claudeId).catch(() => null);
        if (!w.path) await new Promise((r) => setTimeout(r, 1000));
      }
      if (w.stopped || !w.path) return;
      if (w.line < 0) w.line = await lineCount(conn, w.path); // 第一次接上：以前的内容已经在对话里了，从现在开始读
      const stream = await conn.execStream(`tail -n +${w.line + 1} -F ${shQuote(w.path)} 2>/dev/null`, '');
      w.stream = stream;
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, k);
          buf = buf.slice(k + 1);
          w.line++;
          let d;
          try { d = JSON.parse(ln); } catch (_) { continue; }
          try { translate(d, emit); } catch (_) {}
        }
      });
      stream.on('close', () => { if (watchers.get(sid) === w && !w.stopped) { w.stopped = true; watchers.delete(sid); send('claude:event', { sessionId: sid, ev: { type: 'tdetached' } }); } });
    })().catch(() => {});
    // 每 1.5 秒看一眼窗口画面：出现选择菜单就告诉界面，菜单没了也告诉界面
    w.pollTimer = setInterval(async () => {
      if (w.stopped || w.polling) return;
      w.polling = true;
      try {
        const r = await run(conn, `${tmux(cfg)} capture-pane -p -t ${target(cfg)}`);
        const p = r.code === 0 ? parsePrompt(r.out) : null;
        const key = p ? JSON.stringify(p) : '';
        if (key !== w.promptKey) { w.promptKey = key; emit({ type: 'tprompt', prompt: p }); }
      } catch (_) {} finally { w.polling = false; }
    }, 1500);
    return { ok: true };
  }
  function unwatch(sid) {
    const w = watchers.get(sid);
    if (!w) return;
    w.stopped = true;
    clearInterval(w.pollTimer);
    try { if (w.stream) w.stream.close(); } catch (_) {}
    watchers.delete(sid);
  }

  // 发消息：粘贴进窗口（-p 是「括号粘贴」，多行不会被当成好几次回车）再回车
  async function sendText(sid, text) {
    const w = watchers.get(sid);
    if (!w) throw new Error('还没接上 tmux 窗口');
    const buf = 'cr' + sid.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const r = await run(w.conn, `${tmux(w.cfg)} load-buffer -b ${buf} - && ${tmux(w.cfg)} paste-buffer -p -d -b ${buf} -t ${target(w.cfg)}`, String(text));
    if (r.code !== 0) throw new Error('往 tmux 窗口里输入失败：' + (r.err || r.out).trim().slice(0, 200));
    await new Promise((res) => setTimeout(res, 400));
    await run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)} Enter`);
  }

  // 按键：停止（Esc），或在菜单里选第 k 项（从当前选中的位置按上下键移过去再回车）
  async function key(sid, { esc, choose, cur }) {
    const w = watchers.get(sid);
    if (!w) throw new Error('还没接上 tmux 窗口');
    if (esc) return run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)} Escape`);
    const k = Number(choose);
    if (!Number.isInteger(k) || k < 0 || k > 20) throw new Error('选项不对');
    const d = k - (Number(cur) || 0);
    const moves = d === 0 ? '' : ` ${Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up').join(' ')}`;
    if (moves) await run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)}${moves}`);
    await new Promise((res) => setTimeout(res, 200));
    await run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)} Enter`);
    w.promptKey = '__sent__'; // 下一轮画面检查一定通知界面（菜单消失或换成下一个）
  }

  return { ensure, watch, unwatch, sendText, key, snapshot, watching: () => [...watchers.keys()], parsePrompt, NAME_RE };
}

module.exports = { createTmuxMode };
