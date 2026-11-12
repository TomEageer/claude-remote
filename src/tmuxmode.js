// tmux 模式（实验功能）：这个对话的 Claude 跑在服务器上一个 tmux 窗口里，是平时终端里那个交互式 Claude。
// 任何人 tmux attach 进去，看到和操作的都是标准的 Claude 界面；软件这边：
//   发消息 = 把文字粘贴进那个窗口再回车；
//   看回复 = 实时读 Claude 自己写的会话记录（~/.claude/projects/<目录>/<会话ID>.jsonl），翻译成和普通模式一样的事件；
//   状态和提问 = Claude 的钩子（hooks）：启动时用 --settings 带上一份钩子配置，Claude 在「提交了消息、要权限、一轮结束、换会话、退出」时
//               把事件写进服务器上的事件文件，软件读这个文件；要权限、问选择题时钩子会等软件回复，软件点了按钮就写回复文件，Claude 当场收到；
//   停止 = 在窗口里按 Esc。
// 读窗口画面只用在启动时钩子管不到的框（信任这个文件夹、确认 bypass 模式）和「窗口卡在没见过的界面」的提示上。
// 断网、关软件都不影响 Claude 在 tmux 里继续干活，重连后从上次读到的那一行接着读。Windows 服务器没有 tmux，不支持。
'use strict';

const NAME_RE = /^[^\s:.'"`$\\;|&<>()*?!#]{1,60}$/; // tmux 会话名、窗口名：不能有空格、冒号、点和 shell 特殊字符
const SOCK_RE = /^\/[A-Za-z0-9._\/-]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELL_RE = /^-?(bash|zsh|sh|fish|dash|ksh|tcsh|csh)$/;
const FOOTER_RE = /Esc to cancel|Enter to confirm|Enter to select|Enter to continue/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'StopFailure'];
// 钩子脚本：Claude 每触发一次钩子就运行一次。把事件记成一行 JSON；权限请求要等软件把回复文件放进来，再原样交给 Claude
// （终端里的人先点了也行：看到这一轮已结束就自己退出，Claude 退了也退出）
const HOOK_SH = `#!/bin/sh
d=$1; e=$2
id="$(date +%s)$$"
p=$(cat | tr '\\n' ' ')
[ -n "$p" ] || p=null
printf '{"e":"%s","id":"%s","d":%s}\\n' "$e" "$id" "$p" >> "$d/events"
[ "$e" = PermissionRequest ] || exit 0
n=$(wc -l < "$d/events")
i=0
while [ "$i" -lt 172800 ]; do
  if [ -f "$d/resp-$id" ]; then cat "$d/resp-$id"; /usr/bin/trash "$d/resp-$id"; exit 0; fi
  kill -0 "$PPID" 2>/dev/null || exit 0
  if [ $((i % 8)) -eq 7 ] && tail -n +"$((n + 1))" "$d/events" 2>/dev/null | grep -Eq '"e":"(Stop|StopFailure|SessionEnd|UserPromptSubmit)"'; then exit 0; fi
  sleep 0.5
  i=$((i + 1))
done
exit 0
`;
const HOOK_MARK = '/.claude-remote/tmux/';

// 命令行是不是 Claude：原生安装（claude / .../claude/versions/x.y.z）或 npm 安装（node …/claude-code/cli.js）
function isClaudeArgs(args) {
  const tk = String(args || '').trim().split(/\s+/);
  const base = (tk[0] || '').split('/').pop();
  if (base === 'claude' || /\/claude\/versions\//.test(tk[0] || '')) return true;
  if (/^(node|nodejs|bun)$/.test(base) && /claude-code|\/claude(\.js)?$/.test(tk[1] || '')) return true;
  return false;
}

function createTmuxMode({ send, shQuote, previewOf, permArg, claudeEnv }) {
  const watchers = new Map(); // 对话 id -> 看着这个对话的状态（见 watch）
  const CONF = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';

  const check = (t) => {
    if (!t || !NAME_RE.test(t.session || '') || !NAME_RE.test(t.window || '')) throw new Error('tmux 会话名或窗口名不合法：不能有空格、冒号、点和特殊符号');
    if (t.socket && !SOCK_RE.test(t.socket)) throw new Error('tmux 服务器位置要写完整路径，比如 /tmp/tmux-1000/default');
    if (t.wid && !/^@\d+$/.test(t.wid)) throw new Error('tmux 窗口编号不合法');
  };
  // -u：按 UTF-8 处理。软件从桌面启动、或 SSH 上没有中文语言环境时，tmux 会把中文窗口名、画面里的中文全变成下划线
  const tmux = (t) => `tmux -u${t.socket ? ' -S ' + shQuote(t.socket) : ''}`;
  // 找到窗口以后一律用它的编号（@N）：「会话:窗口名」会按前缀、编号、通配去匹配，w1 不在了就会命中 w10
  const target = (t) => shQuote(t.wid || `=${t.session}:${t.window}`);
  const run = async (conn, cmd, stdin) => conn.exec(cmd, stdin);
  const ok = async (conn, cmd, stdin) => { const r = await run(conn, cmd, stdin); return r.code === 0 ? r : null; };
  const homePath = (dir) => (dir === '~' ? '"$HOME"' : dir.startsWith('~/') ? `"$HOME"${shQuote(dir.slice(1))}` : shQuote(dir));

  async function precheck(conn) {
    await conn.ensure();
    if (conn.isWindows()) throw new Error('这台是 Windows 服务器，没有 tmux，用不了 tmux 模式');
    if (!(await ok(conn, 'command -v tmux >/dev/null 2>&1'))) throw new Error('服务器上没有装 tmux：先在服务器上安装（比如 sudo apt install tmux），再打开 tmux 模式');
  }

  // 会话记录文件：Claude 第一次收到消息后才会建，所以可能要等一会儿
  async function findTranscript(conn, claudeId) {
    if (!UUID_RE.test(claudeId || '')) return null;
    const r = await run(conn, `ls -t ${CONF}/projects/*/${claudeId}.jsonl 2>/dev/null | head -1`);
    return (r.out || '').trim() || null;
  }
  async function lineCount(conn, p) {
    const r = await run(conn, `wc -l < ${shQuote(p)} 2>/dev/null`);
    return parseInt((r.out || '').trim(), 10) || 0;
  }

  // 服务器上放钩子脚本、事件文件的地方：~/.claude-remote/tmux/<对话id>/
  async function hookPaths(conn, sid) {
    if (!UUID_RE.test(sid || '')) throw new Error('对话编号不合法');
    const h = ((await run(conn, 'printf %s "$HOME"')).out || '').trim();
    if (!/^\/[^\n\0]+$/.test(h)) throw new Error('读不到服务器上的主目录');
    const base = `${h}/.claude-remote/tmux`;
    return { base, dir: `${base}/${sid}`, script: `${base}/hook.sh` };
  }
  async function setupHooks(conn, sid) {
    const hp = await hookPaths(conn, sid);
    const r = await run(conn, `mkdir -p ${shQuote(hp.dir)} && cat > ${shQuote(hp.script)} && chmod 700 ${shQuote(hp.script)} && : >> ${shQuote(hp.dir + '/events')}`, HOOK_SH);
    if (r.code !== 0) throw new Error('在服务器上准备钩子失败：' + (r.err || r.out).trim().slice(0, 200));
    const cmd = (e) => `sh ${shQuote(hp.script)} ${shQuote(hp.dir)} ${e}`;
    const settings = { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: cmd(e), timeout: e === 'PermissionRequest' ? 86400 : 10 }] }]])) };
    const w = await run(conn, `cat > ${shQuote(hp.dir + '/settings.json')}`, JSON.stringify(settings));
    if (w.code !== 0) throw new Error('在服务器上写钩子配置失败：' + (w.err || w.out).trim().slice(0, 200));
    // 事件文件现在有几行：启动 Claude 之前的位置，从这里开始读才不会漏掉它启动时发的通知
    const lines = await lineCount(conn, hp.dir + '/events');
    return { ...hp, settings: hp.dir + '/settings.json', lines };
  }

  // 窗口编号：按名字精确找（不用 tmux 的模糊匹配）
  // 先认标记（窗口选项 @cr_sid = 对话编号，名字被改过也认得出），再认名字
  async function findWindow(conn, t, sid) {
    const r = await ok(conn, `${tmux(t)} list-windows -t ${shQuote('=' + t.session)} -F '#{window_id}|#{@cr_sid}|#{window_name}'`);
    if (!r) return null;
    const list = r.out.split('\n').map((ln) => { const p = ln.split('|'); return p.length >= 3 ? { id: p[0], tag: p[1], name: p.slice(2).join('|') } : null; }).filter((x) => x && /^@\d+$/.test(x.id));
    const tagged = sid && list.find((x) => x.tag === sid);
    if (tagged) return tagged.id;
    const hit = list.find((x) => x.name === t.window && (!x.tag || !sid));
    return hit ? hit.id : null;
  }
  // 兜底：标记和名字都找不到（旧版本建的窗口、名字被改过）时，看会话里哪个窗口跑着用这个会话编号的 Claude
  async function scanWindow(conn, t, claudeId) {
    if (!UUID_RE.test(claudeId || '')) return null;
    const r = await run(conn, `${tmux(t)} list-panes -s -t ${shQuote('=' + t.session)} -F '#{window_id} #{pane_tty}' 2>/dev/null | while read w tty; do ps -t "\${tty#/dev/}" -ww -o args= 2>/dev/null | grep -q -- ${shQuote(claudeId)} && echo "$w"; done; true`);
    const id = ((r.out || '').split('\n').find((x) => /^@\d+$/.test(x.trim())) || '').trim();
    return id || null;
  }
  // 这个对话的窗口：关掉自动改名（Claude 会设置终端标题，服务器的 tmux 配置允许的话窗口名会被改掉），名字被改过就改回来
  async function pinWindow(conn, t, wid, sid) {
    const T = tmux(t);
    const q = shQuote(wid);
    const tag = UUID_RE.test(sid || '') ? `${T} set-option -w -t ${q} @cr_sid ${sid} 2>/dev/null; ` : '';
    await run(conn, `${tag}${T} set-option -w -t ${q} automatic-rename off 2>/dev/null; ${T} set-option -w -t ${q} allow-rename off 2>/dev/null; [ "$(${T} display-message -p -t ${q} '#{window_name}')" = ${shQuote(t.window)} ] || ${T} rename-window -t ${q} ${shQuote(t.window)} 2>/dev/null; true`).catch(() => {});
  }

  // 窗口里正在跑什么：{ cmd, cwd, shell, proc: 窗口里的 Claude 进程 { pid, sessionId } | null }
  async function inspect(conn, t) {
    const r = await ok(conn, `${tmux(t)} display-message -p -t ${target(t)} '#{pane_current_command}|#{pane_tty}|#{pane_current_path}'`);
    if (!r) return null;
    const parts = r.out.trim().split('|');
    const cmd = parts[0];
    const tty = parts[1] || '';
    const cwd = parts.slice(2).join('|');
    const info = { cmd, cwd, shell: SHELL_RE.test(cmd || ''), proc: null };
    if (/^\/dev\/[A-Za-z0-9\/]+$/.test(tty)) {
      const ps = await run(conn, `ps -t ${shQuote(tty.replace(/^\/dev\//, ''))} -ww -o pid= -o args= 2>/dev/null`);
      for (const ln of (ps.out || '').split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(ln);
        if (!m || !isClaudeArgs(m[2])) continue;
        const pid = Number(m[1]);
        let sessionId = null;
        const j = await run(conn, `cat ${CONF}/sessions/${pid}.json 2>/dev/null`);
        try { const d = JSON.parse(j.out); if (UUID_RE.test(d.sessionId || '')) sessionId = d.sessionId; } catch (_) {}
        if (!sessionId) { const a = /(?:--session-id|--resume|-r)[ =]([0-9a-f-]{36})/i.exec(m[2]); if (a && UUID_RE.test(a[1])) sessionId = a[1]; }
        info.proc = { pid, sessionId, ours: m[2].includes(HOOK_MARK) };
        break;
      }
    }
    return info;
  }

  const foreign = (t, proc) => Object.assign(new Error(`窗口 ${t.session}:${t.window} 里的 Claude 不是这个软件启动的（可能是旧版本启动的，或者有人手动开的），没有带状态通知，接上了也收不到回复和确认请求`), { code: 'foreign', sessionId: (proc && proc.sessionId) || null });
  // 命令行读不全时的补充判断：这个对话的事件文件里记过这个 Claude 的会话，就是软件启动的
  async function markOurs(conn, sid, proc) {
    if (!proc || proc.ours || !proc.sessionId || !UUID_RE.test(sid || '')) return;
    const hp = await hookPaths(conn, sid).catch(() => null);
    if (hp && (await ok(conn, `grep -q ${shQuote('"session_id":"' + proc.sessionId + '"')} ${shQuote(hp.dir + '/events')} 2>/dev/null`))) proc.ours = true;
  }
  // 让窗口里的 Claude 退出，回到命令行：先 Esc 关掉可能开着的菜单、清掉输入，再输入 /exit
  async function restartToShell(conn, tw) {
    for (let k = 0; k < 2; k++) {
      await run(conn, `${tmux(tw)} send-keys -t ${target(tw)} Escape`);
      await sleep(400);
      await run(conn, `${tmux(tw)} send-keys -t ${target(tw)} C-u && sleep 0.2 && ${tmux(tw)} send-keys -t ${target(tw)} -l /exit && sleep 0.3 && ${tmux(tw)} send-keys -t ${target(tw)} Enter`);
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const p = await inspect(conn, tw);
        if (p && p.shell) return;
      }
    }
    throw new Error('窗口里的 Claude 没有退出（可能正在忙或卡在某个界面）。tmux attach 进去手动退出后再试');
  }

  // 保证 tmux 会话和窗口在、窗口里有 Claude 在跑。返回 { claudeId, adopted, started, wid, pid }
  async function ensure({ conn, sid, t, cwd, claudeId, isNew, model, perm, restart }) {
    check(t);
    await precheck(conn);
    const asked = claudeId;
    const cdir = homePath(cwd || '~');
    if (!(await ok(conn, `${tmux(t)} has-session -t ${shQuote('=' + t.session)} 2>/dev/null`))) {
      const r = await run(conn, `mkdir -p ${cdir} && ${tmux(t)} new-session -d -s ${shQuote(t.session)} -n ${shQuote(t.window)} -c ${cdir} -x 200 -y 50`);
      if (r.code !== 0) throw new Error('建 tmux 会话失败：' + (r.err || r.out).trim().slice(0, 200));
    } else if (!(await findWindow(conn, t, sid)) && !(await scanWindow(conn, t, claudeId))) {
      const r = await run(conn, `mkdir -p ${cdir} && ${tmux(t)} new-window -d -t ${shQuote('=' + t.session + ':')} -n ${shQuote(t.window)} -c ${cdir}`);
      if (r.code !== 0) throw new Error('建 tmux 窗口失败：' + (r.err || r.out).trim().slice(0, 200));
    }
    const wid = (await findWindow(conn, t, sid)) || (await scanWindow(conn, t, claudeId));
    if (!wid) throw new Error('找不到 tmux 窗口 ' + t.session + ':' + t.window);
    await pinWindow(conn, t, wid, sid);
    const tw = { ...t, wid };
    const info = await inspect(conn, tw);
    if (!info) throw new Error('找不到 tmux 窗口 ' + t.session + ':' + t.window);
    if (!info.shell) {
      // 窗口里在跑别的东西：是软件之前启动的 Claude 就接上它；不是就不往里敲任何东西
      if (!info.proc) throw new Error(`窗口 ${t.session}:${t.window} 里正在运行「${info.cmd}」，不是 Claude 也不是空闲的命令行。换个窗口名，或者先把里面的程序退出`);
      await markOurs(conn, sid, info.proc);
      if (info.proc.ours && info.proc.sessionId) return { claudeId: info.proc.sessionId, adopted: info.proc.sessionId !== claudeId, started: false, wid, pid: info.proc.pid };
      // 窗口里的 Claude 没带状态通知：用的是这个对话自己的会话（旧版软件启动的）就自动换成新的；是别的会话（有人手动开的）要界面问过你才动它
      const own = !info.proc.sessionId || info.proc.sessionId === claudeId;
      if (!restart && !own) throw foreign(t, info.proc);
      if (!restart) {
        const scr = await run(conn, `${tmux(tw)} capture-pane -p -t ${target(tw)}`);
        // 停在启动时的「信任这个文件夹」上不算在忙（它还没开始干活），可以直接换；正在回复、等你确认权限时不动它
        const pr = parsePrompt(scr.out || '');
        const startup = pr && /Quick safety check|trust this folder/i.test(pr.question + ' ' + pr.options.map((o) => o.label).join(' '));
        if (/esc to interrupt/i.test(scr.out || '') || (pr && !startup) || (!pr && blocked(scr.out || ''))) throw new Error('窗口里的 Claude 是旧版本启动的，要换成新的才能接上，但它现在正在回复或等你操作。等它停下来再发，或者 tmux attach 进去处理完');
      }
      if (info.proc.sessionId) claudeId = info.proc.sessionId;
      await restartToShell(conn, tw);
    }
    // 窗口里是 shell：在里面启动 Claude（用这个对话的会话编号，接着之前的内容）
    if (!UUID_RE.test(claudeId || '')) throw new Error('会话编号不合法');
    const hooks = await setupHooks(conn, sid);
    // 有记录才能接着（--resume）；会话还没聊过（记录不存在）就用这个编号开新的，不然 Claude 会报「找不到会话」直接退出
    const has = !!(await findTranscript(conn, claudeId).catch(() => null));
    const args = ['--settings', hooks.settings, has ? '--resume' : '--session-id', claudeId];
    if (model && model !== 'default' && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
    if (perm) args.push('--permission-mode', permArg(perm));
    // command：跳过 shell 里同名的函数、别名（有人在 .zshrc 里把 claude 包了一层，比如强制走某个代理），和普通模式一样直接运行程序
    const line = `cd ${cdir} && ${claudeEnv} command claude ${args.map(shQuote).join(' ')}`;
    await run(conn, `${tmux(tw)} send-keys -t ${target(tw)} -l ${shQuote(line)} && ${tmux(tw)} send-keys -t ${target(tw)} Enter`);
    // 等 Claude 起来、界面画好能接收输入（或者出现「信任这个文件夹」之类的菜单，交给界面去选）
    let pid = null;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      const p = await inspect(conn, tw);
      if (!p || p.shell) continue;
      if (p.proc) pid = p.proc.pid;
      const scr = await run(conn, `${tmux(tw)} capture-pane -p -t ${target(tw)}`);
      ready = /\? for shortcuts|esc to interrupt/i.test(scr.out || '') || !!parsePrompt(scr.out || '') || FOOTER_RE.test(scr.out || '');
    }
    if (!ready) throw new Error('Claude 在 tmux 窗口里一直没有启动好（30 秒）。用「看终端画面」或 tmux attach 进去看看卡在哪里');
    await sleep(300);
    return { claudeId, adopted: claudeId !== asked, started: true, wid, pid, hline: hooks.lines };
  }

  // 只查窗口现状，不启动任何东西：接回已有的 tmux 对话时用
  async function resolve({ conn, sid, t, claudeId }) {
    check(t);
    await precheck(conn);
    const wid = (await findWindow(conn, t, sid)) || (await scanWindow(conn, t, claudeId));
    if (!wid) return { wid: null, pid: null, sessionId: null, ours: false };
    await pinWindow(conn, t, wid, sid);
    const info = await inspect(conn, { ...t, wid });
    const pr = info && info.proc;
    if (pr) await markOurs(conn, sid, pr);
    // 旧版软件启动的、用这个对话自己会话的 Claude：先当作「不在」，发下一条消息时会自动换成新的
    if (pr && !pr.ours && (!pr.sessionId || pr.sessionId === claudeId)) return { wid, pid: null, sessionId: null, ours: false, old: true };
    if (pr && !pr.ours) throw foreign(t, pr);
    return { wid, pid: pr ? pr.pid : null, sessionId: pr ? pr.sessionId : null, ours: !!(pr && pr.ours) };
  }

    // ---------- 读会话记录 ----------
  // 助手说的话、用的工具、工具结果从这里读（钩子里没有）；「提交了消息」「一轮结束」「换会话」由钩子告诉我们
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '');
  function translate(d, emit) {
    if (d.isSidechain) return;
    const m = d.message || {};
    if (d.type === 'assistant' && Array.isArray(m.content)) {
      if (m.model === '<synthetic>') return; // Claude 自己补写的占位回复（接着旧会话时的「No response requested.」等），不是模型说的
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
      // 按 Esc 打断：钩子不会通知，只有记录里有这一行
      const text = textOf(m.content).trim();
      if (/^\[Request interrupted by user for tool use/.test(text)) return; // 在菜单里选了「否」：这一轮接着走，等 Stop
      if (/^\[Request interrupted by user/.test(text)) { emit({ type: 'stopped' }); emit({ type: 'end' }); }
    }
  }

  // ---------- 认窗口画面上的菜单（只用在启动时：信任这个文件夹、确认 bypass 模式，钩子管不到它们）----------
  const SEP_RE = /^[\s─━╌┄┈\-=_]{6,}$/;
  const OPT_RE = /^\s*(❯|›|>)?\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/;
  function parsePrompt(screen) {
    const lines = String(screen || '').split('\n');
    const tail = [];
    for (let i = lines.length - 1; i >= 0 && tail.length < 4; i--) if (lines[i].trim()) tail.push(i);
    const end = tail.find((i) => FOOTER_RE.test(lines[i]));
    if (end === undefined) return null;
    const opts = [];
    let i = end - 1;
    let desc = '';
    for (; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim() || SEP_RE.test(l)) continue;
      const m = OPT_RE.exec(l);
      if (m) {
        opts.unshift({ label: m[3], desc, num: Number(m[2]), on: !!m[1] });
        desc = '';
        continue;
      }
      if (!opts.length) continue; // 提示行和选项之间的杂行
      if (/^\s{4,}\S/.test(l)) { desc = l.trim() + (desc ? ' ' + desc : ''); continue; } // 选项下面的说明、折行
      break;
    }
    if (opts.length < 2 || !opts.some((o) => o.on)) return null;
    for (let k = 1; k < opts.length; k++) if (opts[k].num !== opts[k - 1].num + 1) return null;
    const q = [];
    for (let j = i; j >= 0 && q.length < 8; j--) { const l = lines[j].trim(); if (SEP_RE.test(l) && q.length) break; if (!l || SEP_RE.test(l)) continue; q.unshift(l); }
    let question = '';
    const qi = q.findIndex((l) => /Quick safety check/i.test(l));
    if (qi >= 0) question = q.slice(qi).filter((l) => !/^Security guide/i.test(l)).join(' ');
    else {
      const pick = q.filter((l) => !/^Security guide/i.test(l));
      const withQ = pick.filter((l) => /[?？]\s*$/.test(l));
      question = (withQ.length ? withQ[withQ.length - 1] : pick[pick.length - 1]) || q[q.length - 1] || '';
    }
    return { kind: 'screen', question, options: opts.map((o, idx) => ({ label: o.label, idx, desc: o.desc })), cur: opts.findIndex((o) => o.on) };
  }
  // 画面上有等操作的界面但认不出是哪种（比如回退菜单、/help 面板）
  const blocked = (screen) => String(screen || '').split('\n').filter((l) => l.trim()).slice(-4).some((l) => FOOTER_RE.test(l));
  // 输入框已经画出来了：最底下几行里有「❯ 」开头的输入行和分隔线
  const inputReady = (screen) => {
    const ls = String(screen || '').split('\n').filter((l) => l.trim()).slice(-6);
    const k = ls.findIndex((l) => /^\s*[❯>]/.test(l) && !OPT_RE.test(l));
    return k >= 0 && ls.slice(k).some((l) => SEP_RE.test(l));
  };

  // 一次取回：窗口里跑着什么 +（要的话）画面
  async function probe(w, withScreen) {
    const tg = target(w.cfg);
    const r = await run(w.conn, `c=$(${tmux(w.cfg)} display-message -p -t ${tg} '#{pane_current_command}' 2>/dev/null) || { echo '@@GONE'; exit 0; }; echo "$c"; ${withScreen ? `echo '@@SCREEN'; ${tmux(w.cfg)} capture-pane -p -t ${tg}` : 'true'}`);
    const out = r.out || '';
    if (r.code !== 0 || out.startsWith('@@GONE')) return { gone: true };
    const [head, scr = ''] = out.split('\n@@SCREEN\n');
    const cmd = head.trim();
    if (!cmd) return { gone: true }; // 窗口被关掉后 display-message 返回空
    return { gone: false, cmd, shell: SHELL_RE.test(cmd), screen: scr };
  }

  // 窗口画面：没在看着这个对话（连不上、Claude 不是软件启动的……）也能看，按名字找窗口
  async function snapshot(sid, fallback) {
    const w = watchers.get(sid);
    let conn, cfg;
    if (w) { conn = w.conn; cfg = w.cfg; } else if (fallback) {
      check(fallback.t);
      conn = fallback.conn;
      const wid = await findWindow(conn, fallback.t, sid);
      if (!wid) return '';
      cfg = { ...fallback.t, wid };
    } else return '';
    const r = await run(conn, `${tmux(cfg)} capture-pane -p -t ${target(cfg)}`);
    return r.code === 0 ? r.out.replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n') : '';
  }

  // ---------- 开始 / 停止看着这个对话 ----------
  const closeStream = (st) => { try { st.end(); } catch (_) {} try { st.close(); } catch (_) {} };
  // 在服务器上 tail 一个文件；我们这边一断（stdin 关了）或者被终止，它就自己把 tail 杀掉，不会留下孤儿进程
  // 注意先 exec 3<&0 再读：dash（Ubuntu/Debian 的 sh）里后台命令的标准输入会被先换成 /dev/null，直接 cat <&0 读到的是空，tail 的输出也跟着丢了
  const tailCmd = (from, file) => `sh -c 'tail -n +"$1" -F "$2" 2>/dev/null & p=$!; trap "kill $p 2>/dev/null; exit" TERM HUP INT; exec 3<&0; cat <&3 >/dev/null & c=$!; wait $c; kill $p 2>/dev/null' _ ${from} ${shQuote(file)}`;
  // 按行读一个流
  const readLines = (stream, onLine) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let k;
      while ((k = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, k); buf = buf.slice(k + 1); onLine(ln); }
    });
  };

  // 读会话记录：等文件出现，然后从 w.line 接着读。换了会话（/clear）时重新调用
  function startReader(sid, w) {
    const gen = ++w.gen;
    const alive = () => !w.stopped && w.gen === gen;
    if (w.stream) { closeStream(w.stream); w.stream = null; }
    w.path = null;
    (async () => {
      const existed = await findTranscript(w.conn, w.claudeId).catch(() => null);
      w.path = existed;
      for (let i = 0; i < 600 && alive() && !w.path; i++) {
        await sleep(1000);
        w.path = await findTranscript(w.conn, w.claudeId).catch(() => null);
      }
      if (!alive() || !w.path) return;
      // 第一次接上一份已有的记录：以前的内容已经在对话里了，从现在开始读；记录是之后才出现的（新对话）就从头读
      if (w.line < 0) w.line = existed ? await lineCount(w.conn, w.path) : 0;
      if (!alive()) return;
      w.emit({ type: 'tpos' }); // 起点马上告诉界面存下来：之后断线重连从这里接着读，不会跳过断开期间的内容
      const stream = await w.conn.execStream(tailCmd(w.line + 1, w.path), '', true);
      if (!alive()) { closeStream(stream); return; }
      w.stream = stream;
      readLines(stream, (ln) => {
        if (!alive()) return;
        w.line++;
        w.lastEv = Date.now();
        let d;
        try { d = JSON.parse(ln); } catch (_) { return; }
        try { translate(d, w.emit); } catch (_) {}
      });
      stream.on('close', () => { if (alive()) detached(sid, w); });
    })().catch(() => {});
  }

  function detached(sid, w) {
    if (w.stopped) return;
    w.stopped = true;
    clearInterval(w.pollTimer);
    clearTimeout(w.endTimer);
    if (w.hstream) closeStream(w.hstream);
    if (w.stream) closeStream(w.stream);
    watchers.delete(sid);
    send('claude:event', { sessionId: sid, ev: { type: 'tdetached' } });
  }

  // 一轮结束：等会话记录读完最后几行（它和钩子是两条通道，钩子可能先到）再通知界面
  function endAfterQuiet(w, error) {
    const t0 = Date.now();
    const tick = () => {
      if (w.stopped) return;
      if (Date.now() - w.lastEv > 500 || Date.now() - t0 > 4000) {
        w.emit({ type: 'result', isError: !!error, durationMs: 0 });
        w.emit({ type: 'end' });
      } else setTimeout(tick, 200);
    };
    setTimeout(tick, 300);
  }

  // 要权限 / 问选择题：界面看到的样子（太长的字段截短）
  const clip = (v) => (typeof v === 'string' && v.length > 3000 ? v.slice(0, 3000) + '…' : v);
  const reqPrompt = (r) => ({
    kind: r.tool === 'AskUserQuestion' ? 'question' : 'permission',
    id: r.id,
    tool: r.tool,
    input: Object.fromEntries(Object.entries(r.input || {}).map(([k, v]) => [k, clip(v)])),
    canSession: Array.isArray(r.suggestions) && r.suggestions.length > 0,
  });
  const writeResp = (w, id, content) => run(w.conn, `d=${shQuote(w.hdir)}; cat > "$d/.tmp-${id}" && mv "$d/.tmp-${id}" "$d/resp-${id}"`, content);

  // 钩子事件
  function onHook(sid, w, rec) {
    const d = rec.d || {};
    const emit = w.emit;
    const release = () => {
      const r = w.req;
      if (!r) return;
      w.req = null;
      if (!r.answered) writeResp(w, r.id, '').catch(() => {}); // 终端里已经回答了：让钩子收工
      emit({ type: 'tprompt', prompt: null });
    };
    switch (rec.e) {
      case 'SessionStart':
        w.started = true;
        clearTimeout(w.endTimer);
        if (w.goneSent) { w.goneSent = false; emit({ type: 'tback' }); }
        if (UUID_RE.test(d.session_id || '') && d.session_id !== w.claudeId) {
          // /clear、/resume 换了会话：跟着读新的记录
          w.claudeId = d.session_id;
          w.line = -1;
          emit({ type: 'tsession', claudeId: d.session_id });
          startReader(sid, w);
        }
        break;
      case 'SessionEnd':
        release();
        // /clear 会先结束旧会话再开新的：等一下，没有新的才算 Claude 退出了
        clearTimeout(w.endTimer);
        w.endTimer = setTimeout(() => { if (!w.stopped && !w.goneSent) { w.goneSent = true; emit({ type: 'tgone', reason: '窗口里的 Claude 已退出' }); } }, 2000);
        break;
      case 'UserPromptSubmit':
        release();
        w.submits++;
        w.pending = true;
        emit({ type: 'tuser', text: String(d.prompt || '') });
        break;
      case 'PermissionRequest':
        w.pending = true;
        w.req = { id: String(rec.id), tool: d.tool_name, input: d.tool_input || {}, suggestions: d.permission_suggestions, answered: false };
        emit({ type: 'tprompt', prompt: reqPrompt(w.req) });
        break;
      case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionDenied':
        release();
        break;
      case 'Stop': case 'StopFailure':
        release();
        w.pending = false;
        endAfterQuiet(w, rec.e === 'StopFailure');
        break;
    }
  }

  // 每 1.5 秒看一眼窗口：Claude 退出、窗口没了就告诉界面；启动时的菜单交给界面；等一轮的时候窗口卡在没见过的界面也告诉界面。空闲时只每 4.5 秒看一次
  async function poll(sid, w) {
    if (w.stopped || w.polling) return;
    w.tick++;
    const screenNeeded = !w.started || w.pending;
    if (!screenNeeded && w.tick % 3) return;
    w.polling = true;
    try {
      // 连接悄悄卡死时命令会一直不返回：15 秒没回音就当这次没看成，下一轮再看
      const p = await Promise.race([probe(w, screenNeeded), sleep(15000).then(() => null)]);
      if (!p) return;
      if (w.stopped) return;
      if (p.gone || p.shell) {
        if (++w.bad >= 2 && !w.goneSent) {
          w.goneSent = true;
          w.req = null;
          w.emit({ type: 'tprompt', prompt: null });
          w.emit({ type: 'tgone', reason: p.gone ? '窗口或 tmux 服务器已经不在了' : '窗口里的 Claude 已退出' });
        }
        return;
      }
      w.bad = 0;
      if (w.goneSent && w.started) { w.goneSent = false; w.emit({ type: 'tback' }); }
      if (!screenNeeded) return;
      const pr = parsePrompt(p.screen);
      if (!w.started) {
        // 还没收到 Claude 的「会话开始」通知：画面上的菜单（信任这个文件夹……）交给界面
        const key = pr ? JSON.stringify(pr) : '';
        if (key !== w.promptKey) { w.promptKey = key; w.emit({ type: 'tprompt', prompt: pr }); }
      } else if (w.pending && !w.req && !pr && !w.sending && Date.now() - w.sentAt > 5000 && Date.now() - w.lastEv > 8000 && inputReady(p.screen) && !/esc to interrupt/i.test(p.screen)) {
        // 界面还在等这一轮，窗口里的 Claude 却已经停在输入框空闲了：多半是连接断过、漏读了。先从断点把记录和通知重读一遍；还对不上再按结束收尾
        if (++w.stale < 3) return;
        w.stale = 0;
        if (!w.resyncAt || Date.now() - w.resyncAt > 60000) {
          w.resyncAt = Date.now();
          startReader(sid, w);
          await startHookReader(sid, w);
        } else if (Date.now() - w.resyncAt > 12000) {
          w.pending = false;
          w.resyncAt = 0;
          endAfterQuiet(w);
        }
      } else if (!pr && !w.req && blocked(p.screen)) {
        if (!w.blockSent && !w.sending && Date.now() - w.sentAt > 3000) { w.blockSent = true; w.emit({ type: 'tblocked' }); }
      } else { w.blockSent = false; w.stale = 0; }
    } catch (_) {} finally { w.polling = false; }
  }

  // 开始看着：读会话记录 + 读钩子事件文件 + 定时看窗口。from / hfrom 是上次读到的位置
  async function watch(sid, { conn, cfg, claudeId, from, hfrom, pid, started, busy }) {
    check(cfg);
    const old = watchers.get(sid);
    if (old && !old.stopped && !old.goneSent && old.claudeId === claudeId && old.cfg.wid === cfg.wid && old.pid === pid) return { ok: true, line: old.line };
    if (old) unwatch(sid);
    const hp = await hookPaths(conn, sid);
    const w = { hgen: 0, stale: 0, resyncAt: 0, conn, cfg, claudeId, pid: pid || null, hdir: hp.dir, path: null, line: Number.isFinite(from) ? from : -1, hline: -1, stream: null, hstream: null, pollTimer: null, promptKey: '', stopped: false, gen: 0, polling: false, tick: 0, bad: 0, goneSent: false, blockSent: false, sentAt: 0, lastEv: 0, started: !!started, pending: !!busy, req: null, submits: 0, endTimer: null };
    w.emit = (ev) => send('claude:event', { sessionId: sid, ev: { ...ev, tline: w.line, hline: w.hline } });
    watchers.set(sid, w);
    startReader(sid, w);
    // 钩子事件：从上次读到的地方接着读（软件关着时发生的确认请求也能看到）；没有记录就从现在开始
    w.hline = Number.isFinite(hfrom) ? hfrom : await lineCount(conn, hp.dir + '/events');
    if (w.stopped) return { ok: true };
    await startHookReader(sid, w);
    w.pollTimer = setInterval(() => poll(sid, w), 1500);
    return { ok: true };
  }
  async function startHookReader(sid, w) {
    const gen = ++w.hgen;
    const alive = () => !w.stopped && w.hgen === gen;
    if (w.hstream) { closeStream(w.hstream); w.hstream = null; }
    const hs = await w.conn.execStream(tailCmd(w.hline + 1, w.hdir + '/events'), '', true);
    if (!alive()) { closeStream(hs); return; }
    w.hstream = hs;
    w.emit({ type: 'tpos' });
    readLines(hs, (ln) => {
      if (!alive()) return;
      w.hline++;
      let rec;
      try { rec = JSON.parse(ln); } catch (_) { return; }
      try { onHook(sid, w, rec); } catch (_) {}
    });
    hs.on('close', () => { if (alive()) detached(sid, w); });
  }
  function unwatch(sid) {
    const w = watchers.get(sid);
    if (!w) return;
    w.stopped = true;
    clearInterval(w.pollTimer);
    clearTimeout(w.endTimer);
    if (w.stream) closeStream(w.stream);
    if (w.hstream) closeStream(w.hstream);
    watchers.delete(sid);
  }
  function unwatchAll() { for (const sid of [...watchers.keys()]) unwatch(sid); }

  // 关掉 tmux 模式时让窗口里的 Claude 一起退出（不然它还占着这个会话，普通模式再用同一个会话会冲突）。只在它空闲时做
  async function exitClaude(sid) {
    const w = watchers.get(sid);
    if (!w) return 'none';
    const p = await probe(w, true);
    if (p.gone || p.shell) return 'already';
    if (w.pending || w.req || parsePrompt(p.screen) || blocked(p.screen)) return 'busy';
    await run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)} -l '/exit' && sleep 0.3 && ${tmux(w.cfg)} send-keys -t ${target(w.cfg)} Enter`);
    return 'sent';
  }

  // 回答 Claude 的权限请求 / 选择题：写回复文件，钩子读到就原样交给 Claude
  // a: { id, kind: 'allow' | 'allowSession' | 'deny' | 'answers', answers: { 问题文字: 答案 } }
  async function answer(sid, a) {
    const w = watchers.get(sid);
    if (!w) throw new Error('还没接上 tmux 窗口');
    const r = w.req;
    if (!r || r.id !== String(a.id)) throw new Error('这个请求已经结束了（可能已经在终端里回答过）');
    let decision;
    if (a.kind === 'deny') decision = { behavior: 'deny', message: '用户在软件里拒绝了这次操作' };
    else if (a.kind === 'allowSession') decision = { behavior: 'allow', updatedPermissions: r.suggestions };
    else if (a.kind === 'answers') {
      const ans = {};
      for (const q of (r.input && r.input.questions) || []) {
        const v = a.answers && a.answers[q.question];
        if (typeof v !== 'string' || !v.trim()) throw new Error('还有问题没有回答');
        ans[q.question] = v.trim();
      }
      decision = { behavior: 'allow', updatedInput: { ...r.input, answers: ans } };
    } else decision = { behavior: 'allow' };
    const res = await writeResp(w, r.id, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    if (res.code !== 0) throw new Error('回复没有送到服务器：' + (res.err || res.out).trim().slice(0, 200));
    r.answered = true;
  }

  // 发消息：粘贴进窗口（-p 是「括号粘贴」，多行不会被当成好几次回车）再回车；等 Claude 的「提交了消息」通知确认送到了
  async function sendText(sid, text) {
    const w = watchers.get(sid);
    if (!w) throw new Error('还没接上 tmux 窗口');
    w.sending = true;
    try { await sendInner(w, sid, text); } finally { w.sending = false; }
  }
  async function sendInner(w, sid, text) {
    const t0 = Date.now();
    let free0 = 0;
    // 窗口里正停在菜单上（信任这个文件夹、是否允许……）：先等你选完，回车才不会替你选了没选的东西；选完界面还要一两秒才画好输入框，也等它
    for (;;) {
      const p = await probe(w, true);
      if (p.gone) throw new Error('tmux 窗口已经不在了');
      if (p.shell) throw new Error('窗口里的 Claude 已经退出了（可能是选了不信任这个文件夹）。再发一条会重新启动它');
      if (w.req || parsePrompt(p.screen)) {
        free0 = 0;
        if (Date.now() - t0 > 180000) throw new Error('窗口里的 Claude 一直在等你选择，这条没有发出去：先选好，再重发');
        await sleep(1000);
        continue;
      }
      if (blocked(p.screen)) throw new Error('窗口里有个界面在等操作（比如回退菜单）。用「看终端画面」确认，在终端里按 Esc 退出后再发');
      if (inputReady(p.screen)) break;
      if (!free0) free0 = Date.now();
      if (Date.now() - free0 > 20000) break; // 一直认不出输入框就不再等，照常发
      await sleep(500);
    }
    let body = String(text).replace(/\0/g, '');
    if (/^[!/#]/.test(body)) body = ' ' + body; // 以 ! / # 开头 Claude 会当成 shell 命令、斜杠命令（/clear 会清空上下文）、记忆指令，前面补一个空格当普通文字发
    const buf = 'cr' + sid.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const s0 = w.submits;
    const r = await run(w.conn, `${tmux(w.cfg)} load-buffer -b ${buf} - && ${tmux(w.cfg)} paste-buffer -p -d -b ${buf} -t ${target(w.cfg)}`, body);
    if (r.code !== 0) throw new Error('往 tmux 窗口里输入失败：' + (r.err || r.out).trim().slice(0, 200));
    await sleep(400);
    const e = await run(w.conn, `${tmux(w.cfg)} send-keys -t ${target(w.cfg)} Enter`);
    if (e.code !== 0) throw new Error('往 tmux 窗口里输入失败：' + (e.err || e.out).trim().slice(0, 200));
    w.sentAt = Date.now();
    w.pending = true;
    // 确认送到：Claude 收到消息会触发「提交了消息」。Claude 正忙着别的（消息排在后面）时不算没送到
    for (let i = 0; i < 20 && w.submits === s0 && !w.stopped; i++) await sleep(500);
    if (w.submits === s0 && !w.stopped) {
      const p = await probe(w, true);
      if (!p.gone && !/esc to interrupt/i.test(p.screen || '')) {
        w.pending = false;
        throw new Error('消息没有送到：Claude 没有收到它（窗口可能停在别的界面，或者这台服务器禁用了钩子）。用「看终端画面」看看再重发');
      }
    }
  }

  // 按键：停止（Esc），或在启动菜单里选第 k 项（从当前选中的位置按上下键移过去再回车）
  async function key(sid, { esc, choose, cur }) {
    const w = watchers.get(sid);
    if (!w) throw new Error('还没接上 tmux 窗口');
    const tg = target(w.cfg);
    const must = async (cmd) => { const r = await run(w.conn, cmd); if (r.code !== 0) throw new Error('按键没有送进 tmux 窗口：' + (r.err || r.out).trim().slice(0, 200)); };
    if (esc) return must(`${tmux(w.cfg)} send-keys -t ${tg} Escape`);
    const k = Number(choose);
    if (!Number.isInteger(k) || k < 0 || k > 20) throw new Error('选项不对');
    const d = k - (Number(cur) || 0);
    const moves = d === 0 ? '' : ` ${Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up').join(' ')}`;
    if (moves) await must(`${tmux(w.cfg)} send-keys -t ${tg}${moves}`);
    await sleep(200);
    await must(`${tmux(w.cfg)} send-keys -t ${tg} Enter`);
    w.promptKey = '__sent__'; // 下一轮画面检查一定通知界面（菜单消失或换成下一个）
  }

  // 可操作的终端：在服务器上开一个只属于你的临时视图（和原会话共用窗口），定位到这个对话的窗口再接进去。
  // 切窗口只影响这个视图，不会把终端里别人看的画面切走；关掉就删掉它
  async function terminal(sid, { conn, t, rows, cols }) {
    check(t);
    await precheck(conn);
    const w = watchers.get(sid);
    const wid = (w && w.cfg.wid) || (await findWindow(conn, t, sid));
    if (!wid) throw new Error('tmux 窗口还没建：先发一条消息，软件会在窗口里启动 Claude');
    const idx = ((await run(conn, `${tmux(t)} display-message -p -t ${shQuote(wid)} '#{window_index}'`)).out || '').trim();
    if (!/^\d+$/.test(idx)) throw new Error('找不到 tmux 窗口 ' + t.session + ':' + t.window);
    const view = 'crv' + require('crypto').randomBytes(4).toString('hex');
    const T = tmux(t);
    const cmd = `${T} new-session -d -t ${shQuote('=' + t.session)} -s ${view} && ${T} select-window -t ${shQuote('=' + view + ':' + idx)} && exec ${T} attach-session -t ${shQuote('=' + view)} \\; set-option destroy-unattached on`;
    const r = Math.max(5, Math.min(300, Number(rows) || 30));
    const c = Math.max(20, Math.min(500, Number(cols) || 100));
    const stream = await conn.ptyExec(cmd, r, c);
    stream.cleanup = () => run(conn, `${T} kill-session -t ${shQuote('=' + view)} 2>/dev/null; true`).catch(() => {});
    // 服务器的 tmux 配置里可能有「接入时切到某个窗口」之类的设置，会把刚选好的窗口切走：接进去以后再切回这个对话的窗口
    const reselect = () => run(conn, `${T} select-window -t ${shQuote('=' + view + ':' + idx)} 2>/dev/null; true`).catch(() => {});
    setTimeout(reselect, 400);
    setTimeout(reselect, 1500);
    return stream;
  }

  // 普通模式的终端视图：在服务器上直接开一个交互式 Claude，接着这个对话的会话（不经过 tmux，关掉它就退出）
  async function claudeTerminal({ conn, cwd, claudeId, model, perm, rows, cols }) {
    await conn.ensure();
    if (conn.isWindows()) throw new Error('Windows 服务器暂不支持终端视图');
    if (!UUID_RE.test(claudeId || '')) throw new Error('会话编号不合法');
    const has = !!(await findTranscript(conn, claudeId).catch(() => null));
    const args = [has ? '--resume' : '--session-id', claudeId];
    if (model && model !== 'default' && /^[a-z0-9.\-\[\]]+$/i.test(model)) args.push('--model', model);
    if (perm) args.push('--permission-mode', permArg(perm));
    const cdir = homePath(cwd || '~');
    const cmd = `cd ${cdir} 2>/dev/null; ${claudeEnv} exec claude ${args.map(shQuote).join(' ')}`;
    const r = Math.max(5, Math.min(300, Number(rows) || 30));
    const c = Math.max(20, Math.min(500, Number(cols) || 100));
    const stream = await conn.ptyExec(cmd, r, c);
    stream.cleanup = () => {};
    return { stream, isNew: !has };
  }

  return { terminal, claudeTerminal, ensure, resolve, watch, unwatch, unwatchAll, exitClaude, sendText, answer, key, snapshot, watching: () => [...watchers.entries()].filter(([, w]) => !w.goneSent).map(([k]) => k), parsePrompt, NAME_RE, isClaudeArgs };
}

module.exports = { createTmuxMode };
