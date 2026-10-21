/* global api, data, live, el, esc, icon, toast, save, findSession, currentId, renderAll, renderSidebar, sendMessage, mergeIntoRun, injectMessage,
   scheduleLiveRender, serverLabel, side, nacl, qrcode, closeModal, confirmModal, promptModal, TOOL_LABELS, mcpLabel, uid,
   modelList, modelLabel, currentModel, effortFor, effortLevels, EFFORT_LABEL, renderModel, renderTitle, syncTitle, clearDraft, draftKey, useDraftFor, rememberCwd,
   splitOutputs, KNOWN_EXT, resolveRemote, moveSession, newChatGroup */
'use strict';

// ---------- 远程控制：手机经中转枢纽（crrelay）操控这台电脑上的对话 ----------
// data.remote = { on, relay, token, name, hostId, hostSk, hostPk, page, pageUrl, devices: [...] }
// 手机有两种配对方式：
//   第 2 版 { id, name, v: 2, pk, ticket, ticketExp, pairedAt, lastSeen }：一次性二维码 + 每次连接换密钥，见 e2e.js
//   第 1 版 { id, name, key, addedAt, lastSeen }：二维码里直接带长期密钥（旧版本配的手机，照常能用，提示升级）
// 中转服务器只看到密文。帧格式见 relay/main.go；加密内容：手机 → { id, op, ... }，电脑 → { re: id, ok, ... } 或推送 { push, ... }

const remoteCtl = (() => {
  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let state = 'off'; // off | connecting | on | error
  let lastError = '';
  let relayVersion = '';
  const online = new Set();  // 在线的手机
  const watching = {};       // 手机 → 正在看的对话
  const sentList = {};       // 手机 → 上次推送的列表（没变就不推）
  let listeners = [];
  let pairListeners = []; // 手机扫码配对成功（看二维码的窗口用）
  const heard = new Set(); // 这次连上以后已经收到过能解开的消息的手机

  const cfg = () => (data.remote = data.remote || { on: false, relay: '', token: '', name: '', devices: [] });
  const devices = () => (cfg().devices = cfg().devices || []);
  const findDevice = (id) => devices().find((d) => d.id === id);
  const randId = () => uid().replace(/-/g, '');
  const E = window.crE2E;
  let hostVer = '';
  api.appVersion().then((v) => { hostVer = v; });
  const isV2 = (dev) => dev.v === 2;
  const isLegacy = (dev) => !isV2(dev) && !!dev.key;
  const chans = {}; // 手机 → 这次连接的加密通道（第 2 版，断开就扔）
  const TICKET_TTL = 5 * 60 * 1000; // 二维码 5 分钟内有效
  let confirmers = []; // 手机扫码后核对数字的地方（二维码窗口开着就在窗口里核对）

  // 这台电脑自己的一对密钥：公钥放进二维码，私钥只在这台电脑上
  function hostKeys() {
    const c = cfg();
    if (!c.hostSk || !c.hostPk) {
      const k = E.host.keyPair();
      c.hostSk = E.b64.enc(k.secretKey);
      c.hostPk = E.b64.url(k.publicKey);
      save();
    }
    return { sk: E.b64.dec(c.hostSk), pk: c.hostPk };
  }
  const pairKeys = new Map();
  function pairKeyOf(dev) {
    let k = pairKeys.get(dev.id);
    if (!k) { k = E.host.pairKey(hostKeys().sk, dev.pk, cfg().hostId, dev.id); pairKeys.set(dev.id, k); }
    return k;
  }

  // 手机页面从哪里加载：安全模式从 GitHub 上公开的代码加载（中转服务器碰不到页面代码），快速模式从中转服务器加载
  const PAGE_DEFAULT = 'https://tomeageer.github.io/claude-remote/';
  const pageMode = () => (cfg().page === 'fast' ? 'fast' : 'safe');
  function pageBase() {
    if (pageMode() === 'fast') return relayHttp() + '/';
    let u = String(cfg().pageUrl || '').trim() || PAGE_DEFAULT;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/[#?].*$/, '').replace(/\/*$/, '/');
  }

  // ---------- 加密 ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function seal(dev, obj) {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, fromB64(dev.key));
    const out = new Uint8Array(24 + box.length);
    out.set(nonce);
    out.set(box, 24);
    return toB64(out);
  }
  function unseal(dev, s) {
    try {
      const raw = fromB64(s);
      const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), fromB64(dev.key));
      return plain ? JSON.parse(dec.decode(plain)) : null;
    } catch (_) { return null; }
  }

  function setState(s, err) {
    state = s;
    lastError = err || '';
    listeners.forEach((f) => f());
  }

  // ---------- 连接中转 ----------
  function relayHttp() {
    let u = String(cfg().relay || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  function start() {
    stop(true);
    const c = cfg();
    api.keepAwake(!!(c.on && relayHttp() && c.token && c.keepAwake !== false));
    if (!c.on || !relayHttp() || !c.token) { setState('off'); return; }
    if (!c.hostId) { c.hostId = randId(); save(); }
    setState('connecting');
    let sock;
    try { sock = new WebSocket(relayHttp().replace(/^http/i, 'ws') + '/ws'); } catch (e) { setState('error', '中转地址不对'); return; }
    ws = sock;
    // name 只给中转的管理看板显示「这是谁的电脑」，对话内容照样是加密的
    sock.onopen = () => sock.send(JSON.stringify({ t: 'host', hostId: c.hostId, token: c.token, name: String(c.name || '').slice(0, 40) }));
    lastRx = Date.now();
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastRx = Date.now();
      let f;
      try { f = JSON.parse(e.data); } catch (_) { return; }
      if (f.t === 'ok') {
        retry = 0;
        relayVersion = f.version || '';
        online.clear();
        (f.online || []).forEach((d) => peer(d, true));
        setState('on');
      } else if (f.t === 'error') {
        setState('error', f.code === 'token' ? '访问令牌不对：和中转服务器上 crrelay token list 列出的令牌核对一下' : f.message || '中转服务器拒绝连接');
        sock.onclose = null;
        sock.close();
        ws = null;
      } else if (f.t === 'peer') peer(f.deviceId, f.on);
      else if (f.t === 'msg') onMessage(f.from, f.box);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      online.clear();
      setState('error', state === 'on' ? '和中转服务器断开了，正在重连…' : '连不上中转服务器，正在重试…');
      retryTimer = setTimeout(start, Math.min(30000, 1000 * 2 ** retry++));
    };
  }

  // 心跳：每 15 秒问一声中转，40 秒没收到任何东西就认为连接已经假死（睡眠唤醒、换网络后常见），立刻重连
  // 先发心跳、等回应：发出去 20 秒还什么都没收到才算断了（不能只看「多久没收到」——定时器被系统推迟时会误判）
  let lastRx = 0;
  let pingAt = 0;
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (pingAt && pingAt > lastRx && now - pingAt > 20000) { pingAt = 0; const w = ws; w.onclose && w.onclose(); try { w.close(); } catch (_) {} return; }
    if (now - lastRx > 12000 && !(pingAt > lastRx)) { pingAt = now; try { ws.send('{"t":"ping"}'); } catch (_) {} }
  }, 5000);
  window.addEventListener('online', () => { if (cfg().on && state !== 'on') { retry = 0; start(); } });
  // 电脑睡醒、解锁：旧连接多半已经断了但还没发现，直接重连，不等心跳超时和重试间隔
  api.onWake(() => { if (cfg().on) { retry = 0; start(); } });

  function stop(quiet) {
    clearTimeout(retryTimer);
    if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch (_) {} }
    online.clear();
    if (!quiet) setState('off');
  }

  function rawSend(frame) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  }
  function sendTo(devId, obj) {
    const dev = findDevice(devId);
    if (!dev || !online.has(devId)) return;
    if (isV2(dev)) { const ch = chans[devId]; if (ch) rawSend({ t: 'msg', to: devId, box: ch.seal(obj) }); }
    else if (dev.key) rawSend({ t: 'msg', to: devId, box: seal(dev, obj) });
  }

  function peer(devId, on) {
    const dev = findDevice(devId);
    // 撤销过、或者根本不是这台电脑配对的手机：让中转把它踢掉，手机那边会提示重新配对
    if (!dev) { if (on) rawSend({ t: 'revoked', to: devId }); return; }
    // 以前就连过的手机（老版本没记配对时间）：算已经配对过，不再弹「配对成功」
    if (on && dev.lastSeen && !dev.pairedAt) dev.pairedAt = dev.lastSeen;
    if (on) { online.add(devId); dev.lastSeen = Date.now(); save(); }
    else { online.delete(devId); delete watching[devId]; delete sentList[devId]; delete chans[devId]; heard.delete(devId); }
    listeners.forEach((f) => f());
  }

  // ---------- 手机看到的数据 ----------
  const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '\n\n…（内容太长，手机上只显示前面一部分）' : t || '');
  // 工具调用：命令和输出、子助手的每一步和结论、后台任务的状态都带上（手机上点开能看）
  const toolOf = (b, task) => {
    const [, label, sum] = TOOL_LABELS[b.name] || mcpLabel(b.name) || ['', b.name, () => ''];
    let summary = '';
    try { summary = String(sum(b.input || {}) || ''); } catch (_) {}
    const i = b.input || {};
    const out = { type: 'tool', name: b.name, label, summary: summary.slice(0, 300), status: b.status, preview: String(b.preview || '').slice(-3000) };
    if (b.name === 'Bash') out.cmd = String(i.command || '').slice(0, 3000);
    else if (b.name === 'Agent' || b.name === 'Task') {
      out.prompt = String(i.prompt || '').slice(0, 1500);
      out.model = b.model || i.model || '';
      const sub = b.sub || [];
      out.sub = sub.filter((x) => x.type === 'tool').slice(-60).map((x) => {
        const [, l, f] = TOOL_LABELS[x.name] || mcpLabel(x.name) || ['', x.name, () => ''];
        let t = '';
        try { t = String(f(x.input || {}) || ''); } catch (_) {}
        return { label: l, summary: t.slice(0, 160), status: x.status };
      });
      out.subCount = sub.filter((x) => x.type === 'tool').length;
      const lastText = [...sub].reverse().find((x) => x.type === 'text');
      if (lastText) out.subText = String(lastText.text || '').slice(-2000);
    } else if (i.file_path) { out.detail = String(i.file_path); if (/^(Read|Write|Edit|MultiEdit)$/.test(b.name)) out.file = String(i.file_path); }
    // 改文件：把改前改后带给手机（每段最多 4000 字），手机上点开也能看差异
    if (b.name === 'Edit' && (i.old_string != null || i.new_string != null)) out.change = { edits: [{ o: String(i.old_string || '').slice(0, 4000), n: String(i.new_string || '').slice(0, 4000), all: !!i.replace_all }] };
    else if (b.name === 'MultiEdit' && Array.isArray(i.edits)) out.change = { edits: i.edits.slice(0, 20).map((e) => ({ o: String(e.old_string || '').slice(0, 4000), n: String(e.new_string || '').slice(0, 4000), all: !!e.replace_all })) };
    else if ((b.name === 'Write' && i.content != null) || (b.name === 'NotebookEdit' && i.new_source != null)) out.change = { whole: String(i.content != null ? i.content : i.new_source).slice(0, 6000) };
    else if (i.url || i.query || i.pattern) out.detail = String(i.url || i.query || i.pattern).slice(0, 500);
    if (task) out.task = { kind: task.kind, status: task.status, progress: String(task.progress || '').slice(0, 200), summary: String(task.summary || '').slice(0, 1500) };
    return out;
  };
  function simplify(m, s) {
    // 附件带上服务器路径：手机上点一下能预览
    if (m.role === 'user') return { role: 'user', text: clip(m.text, 20000), files: (m.files || []).map((f) => ({ name: f.name, path: f.remotePath || '', thumb: f.thumb && f.thumb.length < 40000 ? f.thumb : '' })), ts: m.ts, merged: !!m.merged };
    const tasks = {};
    for (const x of (s && s.messages) || []) for (const t of x.tasks || []) if (t.toolId) tasks[t.toolId] = t;
    const blocks = [];
    for (const b of m.blocks || []) {
      if (b.type === 'text') blocks.push({ type: 'text', text: clip(b.text, 60000) });
      else if (b.type !== 'tool') continue;
      else if (b.ask) blocks.push({ type: 'ask', requestId: b.ask.requestId, questions: b.ask.questions, state: b.ask.state, answers: b.ask.answers });
      else if (b.plan) blocks.push({ type: 'plan', requestId: b.plan.requestId, text: clip(b.plan.text, 60000), state: b.plan.state });
      else {
        blocks.push(toolOf(b, tasks[b.id]));
        if (b.perm) blocks.push({ type: 'perm', requestId: b.perm.requestId, state: b.perm.state, name: b.name, label: (TOOL_LABELS[b.name] || mcpLabel(b.name) || ['', b.name])[1], detail: clip(typeof permDetail === 'function' ? permDetail(b) : '', 4000), reason: b.perm.reason || '' });
      }
    }
    const out = { role: 'assistant', blocks, error: m.error || '', doneAt: m.doneAt || null, ts: m.ts };
    // 这一轮生成的文件（和电脑上一样只列文档类，脚本、缓存只给个数）
    if (m.outputs && m.outputs.length && typeof splitOutputs === 'function') {
      const { main, other } = splitOutputs(m.outputs);
      out.outputs = main.slice(0, 40).map((f) => ({ path: f.path, rel: f.rel, size: f.size }));
      out.otherOutputs = other.length;
    }
    return out;
  }


  function listOf() {
    const servers = new Map((data.servers || []).map((s) => [s.id, serverLabel(s)]));
    return [...data.sessions]
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 100)
      .map((s) => ({ id: s.id, title: s.title, server: servers.get(s.serverId) || '对话', serverId: s.serverId || null, groupId: s.history ? '__history' : s.groupId || null, pinned: !!s.pinned && !s.history, updatedAt: s.updatedAt, running: !!live[s.id], unread: s.unread || '', pending: (pendingOf(s) || {}).kind || '' }));
  }
  // 「历史版本」在手机上也是一个分组，放最后
  const groupsOf = () => [...(data.groups || []).map((g) => ({ id: g.id, name: g.name })), ...(data.sessions.some((s) => s.history) ? [{ id: '__history', name: '历史版本', fixed: true }] : [])];

  // 手机上要用的电脑端设置：服务器、模型和强度、最近的文件夹、斜杠命令、额度
  function infoOf() {
    const servers = (data.servers || []).map((x) => ({ id: x.id, name: serverLabel(x), workdir: x.workdir || '~/workspace', dirs: ((data.ui.recentDirs || {})[x.id] || []).slice(0, 8) }));
    const models = (modelList() || []).map((m) => ({ value: m.value, label: m.value === 'default' ? `默认（${modelLabel(m.value)}）` : modelLabel(m.value), desc: m.description || '', efforts: m.efforts || [] }));
    const cmds = ((data.ui.commands || {})[data.currentServer] || []).map((c) => ({ name: c.name, desc: String(c.description || '').slice(0, 90) }));
    return {
      name: cfg().name || '我的电脑',
      servers,
      currentServer: data.currentServer || null,
      models,
      ...modelFields(null),
      page: pageBase(), // 手机页面据此判断自己是不是旧地址（比如还钉在主屏幕上的旧图标）
      effortNames: EFFORT_LABEL,
      commands: cmds.slice(0, 200),
      usage: (data.ui.usage || {})[data.currentServer] || null,
      exts: typeof KNOWN_EXT === 'string' ? KNOWN_EXT : '',
      hostVersion: hostVer,
      watchPhrases: watchPhrases(), // 手机页面比电脑新、要用到电脑还没有的功能时，提示去更新电脑上的软件
    };
  }

  // 排队等这一轮结束再发的消息（Claude 正在回复、又没法直接交给它的时候）：手机上也要看得到、能撤回
  const queueOf = (s) => (s.queue || []).map((q) => ({ id: q.id, text: clip(q.text, 4000), files: (q.files || []).map((f) => f.name) }));
  const PAGE = 30;
  function chatOf(s, before) {
    const end = before != null ? Math.max(0, Math.min(before, s.messages.length)) : s.messages.length;
    const from = Math.max(0, end - PAGE);
    return { title: s.title, offset: from, messages: s.messages.slice(from, end).map((m) => simplify(m, s)), running: !!live[s.id], n: s.messages.length, plan: !!s.planMode, pinned: !!s.pinned, queue: queueOf(s), ...modelFields(s) };
  }
  // 对话自己记的模型和思考强度（没记就是新对话默认）：手机上打开对话、改模型时都按这个显示
  function modelFields(s) {
    const m = typeof modelOf === 'function' ? modelOf(s) : currentModel();
    const e = typeof effortOf === 'function' ? effortOf(s) : '';
    return { model: m, modelLabel: modelLabel(m), effort: effortLevels(m).includes(e) ? e : '', efforts: effortLevels(m) };
  }

  // 有变化就推给手机（节流）：正在看的对话推最后几条，列表变了推列表
  let pushTimer = null;
  function changed() {
    if (!online.size || pushTimer) return;
    pushTimer = setTimeout(flush, 120);
  }
  // 每台手机记着已经发过的每条消息：只发有变化的那几条（回复中工具多的时候省流量、不卡）
  const sentMsgs = {}; // 手机 → { sid, sigs: 序号 → 内容 }
  // 和上次发给这台手机的版本比：没变的不发；变了的只发差异——文字只发新增的那一截，工具只发变了的那一步
  function patchOf(prev, m) {
    if (!prev || prev.role !== m.role || m.role !== 'assistant') return null;
    const rest = (x) => { const { blocks, ...r } = x; return JSON.stringify(r); };
    const p = { bn: m.blocks.length, ch: [] };
    if (rest(prev) !== rest(m)) { const { blocks, ...r } = m; p.f = r; }
    m.blocks.forEach((b, bi) => {
      const o = prev.blocks[bi];
      if (o && JSON.stringify(o) === JSON.stringify(b)) return;
      if (o && o.type === 'text' && b.type === 'text' && b.text.startsWith(o.text)) p.ch.push({ bi, add: b.text.slice(o.text.length), len: b.text.length });
      else p.ch.push({ bi, b });
    });
    return p;
  }
  function flush() {
    pushTimer = null;
    let list = null;
    for (const devId of online) {
      const sid = watching[devId];
      const s = sid && findSession(sid);
      if (s) {
        const n = s.messages.length;
        let st = sentMsgs[devId];
        if (!st || st.sid !== sid) st = sentMsgs[devId] = { sid, sigs: new Map(), meta: '' };
        const items = [];
        for (let i = Math.max(0, n - 4); i < n; i++) {
          const m = simplify(s.messages[i], s);
          const j = JSON.stringify(m);
          const old = st.sigs.get(i);
          if (old === j) continue;
          const p = old ? patchOf(JSON.parse(old), m) : null;
          items.push(p && JSON.stringify(p).length < j.length ? { i, p } : { i, m });
          st.sigs.set(i, j);
        }
        for (const k of [...st.sigs.keys()]) if (k >= n) st.sigs.delete(k);
        const queue = queueOf(s);
        const meta = [n, !!live[s.id], s.title, !!s.planMode, JSON.stringify(queue)].join('|');
        if (items.length || meta !== st.meta) {
          st.meta = meta;
          sendTo(devId, { push: 'msgs', sid, n, items, running: !!live[s.id], title: s.title, plan: !!s.planMode, queue });
        }
      }
      list = list || listOf();
      const groups = groupsOf();
      const ls = JSON.stringify(list) + JSON.stringify(groups);
      if (ls !== sentList[devId]) { sentList[devId] = ls; sendTo(devId, { push: 'list', sessions: list, groups }); }
    }
  }



  // ---------- 手机发来的操作 ----------
  function onMessage(devId, box) {
    const dev = findDevice(devId);
    if (!dev) { rawSend({ t: 'revoked', to: devId }); return; }
    box = String(box || '');
    const kind = E.kind(box);
    if (kind === 'P2') return onPair(dev, box);
    let req = null;
    if (isV2(dev)) {
      if (!dev.pk) return;
      if (kind === 'H2') {
        // 手机这次连上来的握手：换一把只用这一次的会话密钥
        const r = E.host.accept(box, pairKeyOf(dev));
        if (r) { chans[devId] = r.chan; rawSend({ t: 'msg', to: devId, box: r.box }); }
        return;
      }
      if (kind !== 'S2') return;
      const ch = chans[devId];
      // 电脑重启过、手机还拿着上次的通道：让它重新握手（这条提示不含任何内容）
      if (!ch) { rawSend({ t: 'msg', to: devId, box: 'R2' }); return; }
      req = ch.open(box);
    } else if (kind === 'v1' && dev.key) req = unseal(dev, box);
    if (!req || typeof req.op !== 'string') return;
    // 这台手机发来的第一条能解开的消息：说明它真拿到了密钥，配对成功
    if (!heard.has(devId)) {
      heard.add(devId);
      const first = !dev.pairedAt;
      if (first) { dev.pairedAt = Date.now(); save(); }
      pairListeners.forEach((f) => f(devId, first));
    }
    dev.lastSeen = Date.now();
    const reply = (obj) => sendTo(devId, { re: req.id, ok: true, ...obj });
    const fail = (message) => sendTo(devId, { re: req.id, ok: false, message });
    handle(devId, req).then((r) => (r && r.ok === false ? fail(r.message) : reply(r || {}))).catch((e) => fail(String((e && e.message) || e)));
  }

  async function handle(devId, req) {
    switch (req.op) {
      case 'hello':
      case 'info':
        return infoOf();
      case 'list': {
        delete watching[devId];
        const sessions = listOf();
        const groups = groupsOf();
        sentList[devId] = JSON.stringify(sessions) + JSON.stringify(groups);
        return { sessions, groups };
      }
      case 'model': {
        const m = (modelList() || []).find((x) => x.value === req.model);
        if (req.model && !m && req.model !== 'default') return { ok: false, message: '电脑上没有这个模型' };
        const target = req.sid && typeof findSession === 'function' ? findSession(req.sid) : null;
        if (target) {
          if (req.model) { if (!target.model) target.effort = typeof effortOf === 'function' ? effortOf(target) : ''; target.model = req.model; }
          if (req.effort !== undefined) { if (!target.model) target.model = typeof modelOf === 'function' ? modelOf(target) : 'default'; target.effort = req.effort || ''; }
        } else {
          if (req.model) data.settings.model = req.model;
          if (req.effort !== undefined) data.settings.effort = req.effort || '';
        }
        save();
        if (typeof renderModel === 'function') renderModel();
        return { ...infoOf(), ...modelFields(target) };
      }
      case 'planmode': {
        const s = findSession(req.sid);
        if (!s) return { ok: false, message: '这个对话已经不在了' };
        s.planMode = !!req.on;
        save();
        if (s.id === currentId && typeof side !== 'undefined') side.renderButtons();
        return {};
      }
      case 'rename': {
        const s = findSession(req.sid);
        const title = String(req.title || '').trim().slice(0, 80);
        if (!s || !title) return { ok: false, message: '名字不能为空' };
        s.title = title;
        s.titleLocked = true;
        save();
        renderSidebar();
        if (s.id === currentId && typeof renderTitle === 'function') renderTitle();
        if (typeof syncTitle === 'function') syncTitle(s);
        return {};
      }
      case 'pin': {
        const s = findSession(req.sid);
        if (!s) return { ok: false, message: '这个对话已经不在了' };
        s.pinned = !s.pinned;
        delete s.order;
        save();
        renderSidebar();
        return { pinned: s.pinned };
      }
      case 'delete': {
        const s = findSession(req.sid);
        if (!s) return {};
        if (live[s.id]) return { ok: false, message: '这个对话还在回复，先停止再删除' };
        data.sessions = data.sessions.filter((x) => x.id !== s.id);
        if (typeof clearDraft === 'function') clearDraft(s.id);
        if (currentId === s.id) { currentId = null; draftKey = null; useDraftFor(null); }
        save();
        renderAll();
        return {};
      }
      case 'file': return sendFile(req);
      // 分组：手机上新建、改名、删除、把对话移进移出（和电脑上同一份数据）
      case 'group-create': {
        const name = String(req.name || '').trim().slice(0, 40);
        if (!name) return { ok: false, message: '分组名不能为空' };
        const g = { id: uid(), name, collapsed: false, createdAt: Date.now() };
        data.groups.push(g);
        save();
        renderSidebar();
        return { gid: g.id, groups: groupsOf() };
      }
      case 'group-rename': {
        const g = data.groups.find((x) => x.id === req.gid);
        const name = String(req.name || '').trim().slice(0, 40);
        if (!g || !name) return { ok: false, message: g ? '分组名不能为空' : '这个分组已经不在了' };
        g.name = name;
        save();
        renderSidebar();
        if (typeof renderTitle === 'function') renderTitle();
        return { groups: groupsOf() };
      }
      case 'group-delete': {
        const g = data.groups.find((x) => x.id === req.gid);
        if (!g) return { groups: groupsOf() };
        data.sessions.forEach((x) => { if (x.groupId === g.id) x.groupId = null; });
        data.groups = data.groups.filter((x) => x.id !== g.id);
        if (typeof newChatGroup !== 'undefined' && newChatGroup === g.id) newChatGroup = null;
        save();
        renderAll();
        return { groups: groupsOf() };
      }
      case 'move': {
        const s = findSession(req.sid);
        if (!s) return { ok: false, message: '这个对话已经不在了' };
        if (req.gid === '__history') { if (typeof toHistory === 'function') toHistory(s.id); return {}; }
        if (req.gid && !data.groups.some((x) => x.id === req.gid)) return { ok: false, message: '这个分组已经不在了' };
        if (typeof moveSession === 'function') moveSession(s.id, req.gid || null);
        else { s.groupId = req.gid || null; s.pinned = false; save(); renderSidebar(); }
        return {};
      }
      case 'unqueue': {
        const s = findSession(req.sid);
        if (!s || !s.queue) return { ok: false, message: '这条消息已经发出去了' };
        const before = s.queue.length;
        s.queue = s.queue.filter((q) => q.id !== req.qid);
        if (s.queue.length === before) return { ok: false, message: '这条消息已经发出去了' };
        save();
        if (s.id === currentId && typeof renderQueue === 'function') renderQueue();
        return {};
      }
      case 'upload-begin': {
        if (!(req.size > 0) || req.size > 50 * 1048576) return { ok: false, message: '文件太大（最大 50 MB）' };
        const id = randId();
        // 传到这个对话所在的服务器；新对话按手机上选的服务器
        const owner = req.sid && findSession(req.sid);
        uploads[id] = { serverId: (owner && owner.serverId) || req.serverId || data.currentServer || null, name: String(req.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120), parts: [], got: 0, size: req.size, at: Date.now() };
        return { uploadId: id };
      }
      case 'upload-chunk': {
        const u = uploads[req.uploadId];
        if (!u) return { ok: false, message: '上传已失效，请重新选择文件' };
        const part = fromB64(req.data || '');
        u.parts.push(part);
        u.got += part.length;
        if (u.got > u.size) { delete uploads[req.uploadId]; return { ok: false, message: '文件大小不对' }; }
        return {};
      }
      case 'upload-end': {
        const u = uploads[req.uploadId];
        delete uploads[req.uploadId];
        if (!u || u.got !== u.size) return { ok: false, message: '文件没有传完整，请重试' };
        const buf = new Uint8Array(u.size);
        let off = 0;
        for (const p of u.parts) { buf.set(p, off); off += p.length; }
        const t = await api.saveTemp(u.name, buf);
        if (!t.ok) return { ok: false, message: t.message };
        const srv = u.serverId && (data.servers || []).find((x) => x.id === u.serverId);
        let up;
        if (srv && srv.id !== data.currentServer) up = await api.upload(uid(), t.path, pickServer(srv));
        else {
          const c = await api.connect();
          if (!c.ok) return { ok: false, message: '电脑连不上服务器：' + c.message };
          up = await api.upload(uid(), t.path);
        }
        if (!up.ok) return { ok: false, message: up.message };
        return { name: u.name, remotePath: up.remotePath, promptPath: up.promptPath, size: up.size };
      }
      case 'open': {
        const s = findSession(req.sid);
        if (!s) return { ok: false, message: '这个对话已经不在了' };
        watching[devId] = s.id;
        const c = chatOf(s, req.before);
        if (req.before == null) {
          const sigs = new Map();
          c.messages.forEach((m, k) => sigs.set(c.offset + k, JSON.stringify(m)));
          sentMsgs[devId] = { sid: s.id, sigs, meta: [c.n, c.running, c.title, c.plan, JSON.stringify(c.queue)].join('|') };
        }
        return c;
      }
      case 'send': return send(req);
      case 'stop':
        if (!live[req.sid]) return {};
        await api.stop(req.sid);
        return {};
      case 'ask': return answerAsk(req);
      case 'plan': return answerPlan(req);
      case 'perm': return answerPerm(req);
      default:
        return { ok: false, message: '电脑上的软件版本太旧，不认识这个操作' };
    }
  }

  const uploads = {}; // 手机传过来的文件，分块拼好后存成临时文件再上传到服务器

  // 手机上预览服务器上的文件：借电脑的预览缓存从服务器取下来，再分块加密发给手机（手机按 offset 一块块要）
  const FILE_CHUNK = 256 * 1024;
  const FILE_LIMIT = 50 * 1048576;
  const files = new Map(); // 路径 → { data, at }
  setInterval(() => { for (const [k, v] of files) if (Date.now() - v.at > 120000) files.delete(k); }, 30000);
  async function sendFile(req) {
    let p = String(req.path || '').trim();
    if (!p) return { ok: false, message: '没有文件路径' };
    const s = req.sid && findSession(req.sid);
    if (s && s.serverId && data.currentServer && s.serverId !== data.currentServer) {
      return { ok: false, message: '这个对话在另一台服务器上：电脑上切到那台服务器后才能取文件' };
    }
    // 相对路径：按对话的文件夹（没有就是服务器的工作文件夹）
    if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(p)) {
      const base = (s && s.cwd) || null;
      p = base ? `${base.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}` : await resolveRemote(p);
    }
    let f = files.get(p);
    if (!f || !req.offset) {
      const r = await api.previewFetch(p);
      if (!r.ok) return { ok: false, message: r.message };
      if (r.size > FILE_LIMIT) return { ok: false, message: '文件超过 50 MB，手机上看不了，请在电脑上打开' };
      const rd = await api.previewRead(r.localPath);
      if (!rd.ok) return { ok: false, message: rd.message };
      f = { data: new Uint8Array(rd.data), at: Date.now(), path: p };
      files.set(p, f);
    }
    f.at = Date.now();
    const off = Math.max(0, Number(req.offset) || 0);
    return { path: p, size: f.data.length, offset: off, data: toB64(f.data.subarray(off, off + FILE_CHUNK)) };
  }

  async function send(req) {
    const text = String(req.text || '').trim();
    const files = (Array.isArray(req.files) ? req.files : []).filter((f) => f && f.remotePath).map((f) => ({ name: String(f.name || ''), remotePath: f.remotePath, promptPath: f.promptPath, size: f.size, status: 'done' }));
    if (!text && !files.length) return { ok: false, message: '内容是空的' };
    let s = req.sid && findSession(req.sid);
    if (req.sid && !s) return { ok: false, message: '这个对话已经不在了' };
    if (!s) {
      // 新对话：手机上选的服务器和文件夹（没选就用电脑当前的服务器、默认文件夹），不切换电脑上正在看的对话
      const srv = (data.servers || []).find((x) => x.id === req.serverId) || null;
      const cwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd.trim() : null;
      s = { id: uid(), title: (text || files[0].name).replace(/\s+/g, ' ').slice(0, 30), groupId: null, createdAt: Date.now(), updatedAt: Date.now(), started: false, claudeId: null, serverId: srv ? srv.id : data.currentServer || null, cwd, caps: null, messages: [] };
      s.claudeId = s.id;
      if (req.plan) s.planMode = true;
      if (cwd && (!srv || srv.id === data.currentServer) && typeof rememberCwd === 'function') rememberCwd(cwd);
      data.sessions.push(s);
      save();
      renderSidebar();
    }
    const lv = live[s.id];
    if (lv && lv.replied && (await injectMessage(s, text, files, false))) return { sid: s.id };
    if (lv && (await mergeIntoRun(s, text, files, false))) return { sid: s.id };
    if (lv) {
      s.queue = s.queue || [];
      s.queue.push({ id: uid(), text, files });
      save();
      return { sid: s.id, queued: true };
    }
    sendMessage({ text, files, sid: s.id });
    return { sid: s.id };
  }

  function findBlock(s, pick) {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const b = (s.messages[i].blocks || []).find(pick);
      if (b) return b;
    }
    return null;
  }

  async function answerAsk(req) {
    const s = findSession(req.sid);
    const b = s && findBlock(s, (x) => x.ask && x.ask.requestId === req.requestId);
    if (!b || b.ask.state !== 'pending') return { ok: false, message: '这个问题已经回答过或者失效了' };
    const r = await api.answer({ sessionId: s.id, requestId: req.requestId, answers: req.skip ? {} : req.answers || {}, skip: !!req.skip });
    if (!r.ok) { b.ask.state = 'expired'; save(s.id); return { ok: false, message: r.message }; }
    b.ask.state = req.skip ? 'skipped' : 'answered';
    b.ask.answers = req.skip ? null : req.answers;
    save(s.id);
    renderSidebar();
    if (s.id === currentId) scheduleLiveRender();
    return {};
  }

  async function answerPlan(req) {
    const s = findSession(req.sid);
    const b = s && findBlock(s, (x) => x.plan && x.plan.requestId === req.requestId);
    if (!b || b.plan.state !== 'pending') return { ok: false, message: '这个计划已经处理过或者失效了' };
    const r = await api.planAnswer({ sessionId: s.id, requestId: req.requestId, approve: !!req.approve, feedback: '' });
    if (!r.ok) { b.plan.state = 'expired'; save(s.id); return { ok: false, message: r.message }; }
    b.plan.state = req.approve ? 'approved' : 'rejected';
    if (req.approve) { s.planMode = false; if (typeof side !== 'undefined') side.renderButtons(); }
    save(s.id);
    renderSidebar();
    if (s.id === currentId) scheduleLiveRender();
    return {};
  }

  async function answerPerm(req) {
    const s = findSession(req.sid);
    const b = s && findBlock(s, (x) => x.perm && x.perm.requestId === req.requestId);
    if (!b || b.perm.state !== 'pending') return { ok: false, message: '这一步已经处理过或者失效了' };
    const r = await api.permAnswer({ sessionId: s.id, requestId: req.requestId, allow: !!req.allow, always: !!req.always });
    b.perm.state = !r.ok ? 'expired' : req.allow ? 'allowed' : 'denied';
    save(s.id);
    renderSidebar();
    if (s.id === currentId) scheduleLiveRender();
    return r.ok ? {} : { ok: false, message: r.message };
  }

  // 回复过程中的每个事件、以及任何会存盘的改动，都可能需要推给手机
  api.onEvent(() => changed());

  // ---------- 配对（第 2 版：一次性二维码） ----------
  function b64url(str) {
    return toB64(enc.encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // 二维码里：这台电脑的编号和公钥、手机编号、一次性门票、电脑名字、中转地址（页面不一定在中转上：安全模式、安卓 App）
  function pairCode(dev) {
    const c = cfg();
    return b64url(JSON.stringify({ v: 2, h: c.hostId, d: dev.id, t: dev.ticket, k: hostKeys().pk, n: c.name || '我的电脑', r: relayHttp() }));
  }
  const pairUrl = (dev) => `${pageBase()}#p=${pairCode(dev)}`;
  const ticketLeft = (dev) => (dev.ticket ? Math.max(0, dev.ticketExp - Date.now()) : 0);
  function newTicket(dev) {
    dev.ticket = E.host.newTicket();
    dev.ticketExp = Date.now() + TICKET_TTL;
    save();
  }
  // replaces：升级旧配对时，新的配好后把旧的那条撤销
  function addDevice(name, replaces) {
    const dev = { id: randId(), v: 2, name: name || `手机 ${devices().length + 1}`, pk: null, addedAt: Date.now(), lastSeen: null };
    if (replaces) dev.replaces = replaces;
    newTicket(dev);
    devices().push(dev);
    save();
    return dev;
  }

  // ---------- 手表：6 位数字码配对 ----------
  // 手表扫不了码：把二维码里那份内容加密成包寄存到中转（见 e2e.js 的 watch），手表输码取回，之后和手机一样走 P2 配对
  const WATCH_PHRASES_DEFAULT = ['同意', '继续', '说中文', '停一下', '换个办法', '先别改文件', '先总结一下做到哪了', '等我回电脑再说'];
  const watchPhrases = () => (Array.isArray(cfg().watchPhrases) && cfg().watchPhrases.length ? cfg().watchPhrases : WATCH_PHRASES_DEFAULT).slice(0, 20);
  async function putWatchBundle(dev) {
    const c = cfg();
    const payload = { v: 2, h: c.hostId, d: dev.id, t: dev.ticket, k: hostKeys().pk, n: c.name || '我的电脑', r: relayHttp() };
    for (let i = 0; i < 3; i++) {
      const code = E.watch.newCode();
      const { lookup, blob } = await E.watch.seal(code, payload);
      const res = await api.relayPairPut(relayHttp(), c.token, { id: lookup, blob });
      if (res.status === 200) { dev.code = code; save(); return code; }
      if (res.status === 409) continue; // 撞号，换一个
      if (res.status === 404) throw new Error('中转程序版本太旧，还不支持手表配对：在服务器上再运行一次安装命令更新中转');
      throw new Error(res.status ? '中转服务器没有接受配对码（HTTP ' + res.status + '）' : '连不上中转服务器：' + (res.message || ''));
    }
    throw new Error('配对码连续撞号，再试一次');
  }
  async function addWatch(name) {
    const dev = { id: randId(), v: 2, kind: 'watch', name: name || 'Apple Watch', pk: null, addedAt: Date.now(), lastSeen: null };
    newTicket(dev);
    devices().push(dev);
    save();
    try { await putWatchBundle(dev); } catch (e) { revoke(dev.id); throw e; }
    return dev;
  }
  // 码过期了重新生成：新门票 + 新码 + 重新寄存
  async function renewWatch(dev) {
    newTicket(dev);
    return putWatchBundle(dev);
  }

  // 手机扫码发来的配对请求：用门票解开 → 门票立刻作废 → 你在电脑上核对数字 → 记下手机公钥
  function onPair(dev, box) {
    const expired = () => rawSend({ t: 'msg', to: dev.id, box: 'X2' }); // 「二维码失效了」，不含任何内容
    if (!isV2(dev) || dev.pk || !ticketLeft(dev)) return expired();
    const r = E.host.openPair(box, dev.ticket, hostKeys().sk, cfg().hostId, dev.id);
    if (!r) return expired(); // 解不开（不是扫这个码来的）：门票不作废，免得被人随便发点东西就搞失效
    delete dev.ticket;
    delete dev.ticketExp;
    save();
    listeners.forEach((f) => f());
    confirmPair(dev, r);
  }
  async function confirmPair(dev, r) {
    // 开着的二维码窗口是这台手机的，就在窗口里核对；否则弹窗
    let pending = null;
    for (const f of [...confirmers].reverse()) { pending = f(dev, r); if (pending) break; }
    const ok = await (pending || defaultConfirm(dev, r));
    if (!findDevice(dev.id)) return;
    if (!ok) {
      rawSend({ t: 'msg', to: dev.id, box: E.host.pairReply(r.key, { ok: false }) });
      listeners.forEach((f) => f());
      return;
    }
    dev.pk = r.pk;
    dev.label = r.label;
    dev.pairedAt = dev.lastSeen = Date.now();
    pairKeys.delete(dev.id);
    const old = dev.replaces;
    delete dev.replaces;
    save();
    rawSend({ t: 'msg', to: dev.id, box: E.host.pairReply(r.key, { ok: true, name: cfg().name || '我的电脑' }) });
    if (old && findDevice(old)) revoke(old);
    pairListeners.forEach((f) => f(dev.id, true));
    listeners.forEach((f) => f());
  }
  // 二维码窗口已经关了（比如把链接发到了手机上）：弹个窗核对
  function defaultConfirm(dev, r) {
    return modal({
      title: '有手机要配对',
      body: `<p style="margin:4px 0 10px">${esc(r.label || '一台手机')}正在配对「${esc(dev.name)}」。手机屏幕上显示的数字是：</p><div class="rc-pin">${esc(r.code)}</div><p class="help" style="margin-top:10px">一样才点「配对」。不一样、或者你现在没在扫码，说明二维码被别人拿去用了，点「不是我」。</p>`,
      buttons: [{ text: '不是我', value: false }, { text: '一样，配对', cls: 'primary', value: true }],
    }).then((v) => !!v);
  }

  function revoke(devId) {
    pairKeys.delete(devId);
    delete chans[devId];
    cfg().devices = devices().filter((d) => d.id !== devId);
    save();
    rawSend({ t: 'revoked', to: devId });
    online.delete(devId);
    listeners.forEach((f) => f());
  }

  return {
    start, stop, changed, addDevice, addWatch, renewWatch, watchPhrases, revoke, pairUrl, pairCode, newTicket, ticketLeft, isLegacy, pageMode, pageBase, PAGE_DEFAULT,
    onConfirm(f) { confirmers.push(f); return () => { confirmers = confirmers.filter((x) => x !== f); }; },
    get state() { return state; },
    get error() { return lastError; },
    get relayVersion() { return relayVersion; },
    isOnline: (id) => online.has(id),
    onChange(f) { listeners.push(f); return () => { listeners = listeners.filter((x) => x !== f); }; },
    onPaired(f) { pairListeners.push(f); return () => { pairListeners = pairListeners.filter((x) => x !== f); }; },
    relayHttp,
    cfg,
  };
})();

// 任何存盘的改动（回答问题、改名、新对话…）顺便通知手机
// eslint-disable-next-line no-global-assign
save = ((orig) => function (...a) { orig(...a); remoteCtl.changed(); })(save);

// ---------- 设置页「远程控制」 ----------
const RELAY_DOC = 'https://github.com/TomEageer/claude-remote/blob/main/docs/remote-control.md';
const RELAY_RELEASES = 'https://github.com/TomEageer/claude-remote/releases/latest';
const ANDROID_APK = 'https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-Android.apk';
const SRC = 'https://github.com/TomEageer/claude-remote/blob/main/';
// Apple Watch 还在做：手表 App 能装到真表上之前，设置里先不露出手表入口（代码保留，手表端对接已通）
const WATCH_UI = false;
const E2E_RELAY_MIN = '1.9.0'; // 从这个版本起，中转自带的手机页面认识一次性二维码（快速模式要用）

// a 比 b 旧（只比数字部分）
const verOlder = (a, b) => {
  if (!a || !b || a === 'dev') return false;
  const x = a.split('-')[0].split('.').map(Number);
  const y = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

const remoteView = {
  open(pane) {
    const c = remoteCtl.cfg();
    pane.innerHTML = '';
    const box = el('div', 'rc-pane');
    box.innerHTML = `
      <p class="help rc-intro">在手机上查看和操控这台电脑上的对话：发消息、看回复、回答 Claude 的提问、批准计划。手机和电脑都连到你自己的中转服务器，内容在两端加密，中转服务器只转发、解不开。<a href="#" id="rc-why">加密原理</a></p>
      <div class="rc-dl">${icon('download')}<div><b>第一步：在一台有公网地址的服务器上装好中转程序</b><span>一行命令安装，跟着软件一起更新</span></div>
        <button class="btn" id="rc-doc">安装说明</button><button class="btn" id="rc-dl">下载</button></div>
      <div class="st-sec">第二步：连接中转服务器</div>
      <label class="check"><input type="checkbox" id="rc-on" ${c.on ? 'checked' : ''} /> 开启远程控制（软件开着时一直保持连接）</label>
      <label class="check"><input type="checkbox" id="rc-awake" ${c.keepAwake !== false ? 'checked' : ''} /> 开着远程控制时不让电脑自动睡眠（屏幕照样会关；笔记本合上盖子仍会睡）</label>
      <div class="frow2">
        <div class="field grow"><label>中转地址</label><input id="rc-relay" placeholder="https://relay.example.com" value="${esc(c.relay || '')}" spellcheck="false" /></div>
        <div class="field grow"><label>访问令牌</label><div class="row"><input id="rc-token" class="secret" value="${esc(c.token || '')}" spellcheck="false" autocomplete="off" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
      </div>
      <div class="field"><label>这台电脑在手机上显示的名字</label><input id="rc-name" placeholder="我的电脑" value="${esc(c.name || '')}" /></div>
      <div class="field"><label>手机页面从哪里加载</label>
        <select id="rc-page">
          <option value="safe"${remoteCtl.pageMode() === 'safe' ? ' selected' : ''}>安全模式：从 GitHub 上公开的代码加载（推荐）</option>
          <option value="fast"${remoteCtl.pageMode() === 'fast' ? ' selected' : ''}>快速模式：从中转服务器加载</option>
        </select>
        <div class="rc-page-safe"${remoteCtl.pageMode() === 'safe' ? '' : ' hidden'}><div class="row"><input id="rc-pageurl" value="${esc(c.pageUrl || remoteCtl.PAGE_DEFAULT)}" spellcheck="false" /></div>
          <span class="help">页面代码和 GitHub 上的源码一致，中转服务器只负责转发密文，就算中转被人控制也改不了页面、拿不到内容。中转服务器不是你自己的时候，用这个。</span></div>
        <span class="help rc-page-fast"${remoteCtl.pageMode() === 'fast' ? '' : ' hidden'}>页面由中转服务器提供，国内打开更快。前提是你信任这台中转服务器：理论上它能换掉页面代码。只在中转是你自己的服务器时用。</span>
      </div>
      <div class="rc-status-row"><button class="btn primary" id="rc-save">保存并连接</button><span class="rc-status" id="rc-status"></span></div>
      <div class="st-sec">第三步：添加手机</div>
      <div class="rc-devs" id="rc-devs"></div>
      <div class="row"><button class="btn" id="rc-add">${icon('plus')}添加手机</button>${WATCH_UI ? `<button class="btn" id="rc-add-watch">${icon('plus')}添加 Apple Watch</button>` : ''}</div>
      <div class="rc-phones">
        <div><b>iPhone</b><span>不用装 App：用相机扫电脑上的二维码，在 Safari 里配对，然后点分享按钮 →「添加到主屏幕」，像 App 一样全屏打开</span></div>
        <div><b>安卓</b><span>可以装 App（页面代码打包在 App 里，打开后扫电脑上的二维码配对），也可以和 iPhone 一样直接用浏览器</span><button class="btn" id="rc-android">${icon('download')}下载安卓 App</button></div>
        ${WATCH_UI ? `<div><b>Apple Watch</b><span>装手表 App 后，在手表上输入中转地址和电脑显示的 6 位配对码。手表上只做三件事：处理 Claude 在等你的操作、看哪些对话在跑、发一句话</span></div>` : ''}
      </div>
      ${WATCH_UI ? `<div class="st-sec">手表快捷短语</div>
      <p class="help">手表上点一下就发到正在看的对话，一行一条，最多 20 条。</p>
      <textarea id="rc-phrases" class="rc-phrases" rows="4" spellcheck="false">${esc(remoteCtl.watchPhrases().join('\n'))}</textarea>` : ''}`;
    pane.appendChild(box);
    const $ = (s) => box.querySelector(s);
    $('.reveal').onclick = () => $('#rc-token').classList.toggle('secret');
    $('#rc-doc').onclick = () => api.openExternal(RELAY_DOC);
    $('#rc-dl').onclick = () => api.openExternal(RELAY_RELEASES);
    $('#rc-android').onclick = () => api.openExternal(ANDROID_APK);
    $('#rc-why').onclick = (e) => { e.preventDefault(); showE2EDoc(); };
    $('#rc-page').onchange = () => {
      const safe = $('#rc-page').value === 'safe';
      $('.rc-page-safe').hidden = !safe;
      $('.rc-page-fast').hidden = safe;
    };
    const status = () => {
      const s = remoteCtl.state;
      const st = $('#rc-status');
      st.className = 'rc-status ' + (s === 'on' ? 'ok' : s === 'error' ? 'bad' : '');
      const rv = remoteCtl.relayVersion;
      const older = verOlder(rv, appVer);
      st.textContent = s === 'on' ? `已连接中转服务器${rv ? `（中转程序 ${rv}）` : ''}${older ? '，有新版本：在服务器上再运行一次安装命令就能更新' : ''}` : s === 'connecting' ? '正在连接…' : s === 'error' ? remoteCtl.error : '未开启';
    };
    const renderDevs = () => {
      const list = $('#rc-devs');
      list.innerHTML = '';
      const devs = remoteCtl.cfg().devices || [];
      if (!devs.length) list.appendChild(el('div', 'help', '还没有手机。连接好中转服务器后点「添加手机」，用手机相机扫码。'));
      for (const d of devs) {
        const on = remoteCtl.isOnline(d.id);
        const legacy = remoteCtl.isLegacy(d);
        const waiting = d.v === 2 && !d.pk;
        const left = remoteCtl.ticketLeft(d);
        const isWatch = d.kind === 'watch';
        const seen = waiting ? (left ? `${isWatch ? '等待输入配对码（还能用' : '等待扫码（二维码还能用'} ${Math.ceil(left / 60000)} 分钟）` : (isWatch ? '配对码已过期' : '没有扫码，二维码已过期')) : on ? '在线' : d.lastSeen ? '上次连接 ' + new Date(d.lastSeen).toLocaleString() : '还没连接过';
        const row = el('div', 'rc-dev', `<span class="rc-dot${on && !waiting ? ' on' : ''}"></span><b class="rc-name" title="点击改名">${esc(d.name)}</b><button class="icon-btn rc-rename" title="改名">${icon('pencil')}</button>${isWatch ? '<span class="rc-tag">手表</span>' : ''}${legacy ? '<span class="rc-tag" title="二维码里带着长期密钥，截图外传就能一直解开内容。建议升级">旧配对方式</span>' : ''}<span class="rc-seen">${esc(seen)}</span>`);
        // 改名：点名字或旁边的笔
        const rename = async () => {
          const v = await promptModal(isWatch ? '手表名称' : '手机名称', '比如：我的 iPhone、iPad、公司手机', d.name);
          if (v == null || !v.trim()) return;
          d.name = v.trim().slice(0, 30);
          save();
          renderDevs();
        };
        row.querySelector('.rc-name').onclick = rename;
        row.querySelector('.rc-rename').onclick = rename;
        if (legacy) {
          const up = el('button', 'btn primary', '升级配对');
          up.title = '生成一个新的一次性二维码，手机扫完后旧配对自动作废';
          up.onclick = () => upgrade(d);
          row.appendChild(up);
        }
        if (waiting && isWatch) {
          const b = el('button', 'btn', left ? '配对码' : '重新生成配对码');
          b.onclick = async () => {
            if (remoteCtl.state !== 'on') return toast('先连上中转服务器');
            if (!remoteCtl.ticketLeft(d)) { try { await remoteCtl.renewWatch(d); } catch (e) { return toast(e.message, 6000); } }
            renderDevs();
            showWatchCode(d);
          };
          row.appendChild(b);
        } else if (waiting) {
          const qr = el('button', 'btn', left ? '二维码' : '重新生成二维码');
          qr.onclick = () => { if (remoteCtl.state !== 'on') return toast('先连上中转服务器'); if (!remoteCtl.ticketLeft(d)) remoteCtl.newTicket(d); renderDevs(); showQr(d); };
          row.appendChild(qr);
        }
        const rm = el('button', 'btn', waiting ? '删除' : '撤销');
        rm.onclick = async () => {
          if (waiting || await confirmModal(isWatch ? '撤销这块手表' : '撤销这台手机', `「${d.name}」将不能再连接这台电脑，要再用需要重新添加。`, '撤销')) { remoteCtl.revoke(d.id); renderDevs(); }
        };
        row.appendChild(rm);
        list.appendChild(row);
      }
    };
    const upgrade = (old) => {
      if (remoteCtl.state !== 'on') return toast('先连上中转服务器，再升级配对');
      const d = remoteCtl.addDevice(old.name, old.id);
      renderDevs();
      showQr(d);
    };
    $('#rc-save').onclick = () => {
      Object.assign(c, { on: $('#rc-on').checked, keepAwake: $('#rc-awake').checked, relay: $('#rc-relay').value.trim(), token: $('#rc-token').value.trim(), name: $('#rc-name').value.trim(), page: $('#rc-page').value, pageUrl: $('#rc-pageurl').value.trim() === remoteCtl.PAGE_DEFAULT ? '' : $('#rc-pageurl').value.trim() });
      if (c.on && (!c.relay || !c.token)) return toast('先填中转地址和访问令牌');
      save();
      remoteCtl.start();
    };
    $('#rc-add').onclick = async () => {
      if (remoteCtl.state !== 'on') return toast('先连上中转服务器，再添加手机');
      // 快速模式的页面在中转上：中转程序太旧的话页面还不认识新的二维码
      if (remoteCtl.pageMode() === 'fast' && verOlder(remoteCtl.relayVersion, E2E_RELAY_MIN)) return toast('中转程序版本太旧，手机页面还不支持新的配对方式：在服务器上再运行一次安装命令更新中转，或者改用安全模式', 7000);
      const name = await promptModal('添加手机', '给这台手机起个名字', `手机 ${(c.devices || []).length + 1}`);
      if (name == null) return;
      const d = remoteCtl.addDevice(name.trim());
      renderDevs();
      showQr(d);
    };
    if ($('#rc-add-watch')) $('#rc-add-watch').onclick = async () => {
      if (remoteCtl.state !== 'on') return toast('先连上中转服务器，再添加手表');
      const name = await promptModal('添加 Apple Watch', '给这块手表起个名字', 'Apple Watch');
      if (name == null) return;
      let d;
      try { d = await remoteCtl.addWatch(name.trim()); } catch (e) { return toast(e.message, 7000); }
      renderDevs();
      showWatchCode(d);
    };
    // 快捷短语：失焦就存
    if ($('#rc-phrases')) $('#rc-phrases').onchange = () => {
      const list = $('#rc-phrases').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);
      c.watchPhrases = list;
      save();
      toast('手表快捷短语已保存，手表下次刷新时生效');
    };
    let appVer = '';
    api.appVersion().then((v) => { appVer = v; status(); });
    status();
    renderDevs();
    const off = remoteCtl.onChange(() => { if (!box.isConnected) return off(); status(); renderDevs(); });
    // 「还能用几分钟」每半分钟刷一下
    const tick = setInterval(() => { if (!box.isConnected) return clearInterval(tick); if ((remoteCtl.cfg().devices || []).some((d) => d.v === 2 && !d.pk)) renderDevs(); }, 30000);
  },
};

// 手表配对：显示 6 位码和倒计时，手表输入后在这里核对 4 位数字（和二维码窗口同一套流程）
function showWatchCode(dev) {
  const ov = el('div', 'overlay rc-qr-ov');
  const card = el('div', 'rc-qr');
  ov.appendChild(card);
  let timer = 0;
  let shut = 0;
  const btn = (text, cls, fn) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); b.onclick = fn; return b; };
  const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  let host = remoteCtl.relayHttp();
  try { host = new URL(host).host; } catch (_) {}
  function showCode() {
    clearInterval(timer);
    const code = String(dev.code || '');
    card.innerHTML = `<b>在「${esc(dev.name)}」上输入配对码</b>
      <div class="rc-pin rc-pin-lg">${esc(code.slice(0, 3))} ${esc(code.slice(3))}</div>
      <span class="rc-left"></span>
      <ol class="rc-steps"><li>手表上打开 Claude 远程助手，第一次会先要中转地址：<code>${esc(host)}</code></li><li>输入上面的 6 位数字</li><li>手表会显示 4 位数字，和这里弹出的核对一致后点「一样，配对」</li></ol>
      <span class="help">配对码 5 分钟内有效、只能用一次，里面没有长期密钥。</span>`;
    const row = el('div', 'rc-qr-btns');
    row.append(btn('关闭', 'primary', close));
    card.appendChild(row);
    const left = card.querySelector('.rc-left');
    const tick = () => {
      const ms = remoteCtl.ticketLeft(dev);
      if (!ms) return expired();
      left.textContent = `还剩 ${mmss(ms)}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  function expired() {
    clearInterval(timer);
    if (dev.pk) return;
    card.innerHTML = `<b>配对码已过期</b><span class="help">为了安全，配对码 5 分钟后自动失效，用过一次也会失效。</span>`;
    const row = el('div', 'rc-qr-btns');
    row.append(btn('关闭', '', close), btn('重新生成', 'primary', async () => { try { await remoteCtl.renewWatch(dev); showCode(); } catch (e) { toast(e.message, 6000); } }));
    card.appendChild(row);
  }
  const offConfirm = remoteCtl.onConfirm((d, r) => {
    if (d.id !== dev.id || !ov.isConnected) return null;
    clearInterval(timer);
    return new Promise((resolve) => {
      card.innerHTML = `<b>核对数字</b><span class="help" style="text-align:center">${esc(r.label || '手表')}输入了配对码，手表屏幕上显示的数字是：</span><div class="rc-pin">${esc(r.code)}</div>
        <span class="help">一样才点「配对」。不一样、或者输码的不是你，点「不是我」，这个配对码已经作废。</span>`;
      const row = el('div', 'rc-qr-btns');
      row.append(btn('不是我', '', () => { resolve(false); expired(); }), btn('一样，配对', 'primary', () => resolve(true)));
      card.appendChild(row);
    });
  });
  const offPaired = remoteCtl.onPaired((devId) => {
    if (devId !== dev.id || !ov.isConnected) return;
    card.innerHTML = `<div class="rc-ok">${icon('check')}</div><b>「${esc(dev.name)}」配对成功</b><span class="help">手表已经连上这台电脑。Claude 在等你的时候手表会震一下，抬腕就能处理。</span>`;
    card.appendChild(btn('好的', 'primary', close));
    shut = setTimeout(close, 2500);
  });
  function close() { clearInterval(timer); clearTimeout(shut); offConfirm(); offPaired(); ov.remove(); }
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);
  showCode();
}

function showQr(dev) {
  const ov = el('div', 'overlay rc-qr-ov');
  const card = el('div', 'rc-qr');
  ov.appendChild(card);
  let timer = 0;
  let shut = 0;
  const btn = (text, cls, fn) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); b.onclick = fn; return b; };
  const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function showCode() {
    clearInterval(timer);
    const url = remoteCtl.pairUrl(dev);
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const safe = remoteCtl.pageMode() === 'safe';
    card.innerHTML = `<b>在「${esc(dev.name)}」上扫码</b><div class="rc-qr-img">${qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true })}</div>
      <span class="rc-left"></span>
      <span class="help">用手机相机扫码，会在浏览器里打开手机页面（${safe ? '安全模式：页面来自 GitHub 上的公开代码' : '快速模式：页面来自你的中转服务器'}）。安卓 App 里点「扫描二维码」。扫不了的话，点「复制链接」发到自己手机上打开。</span>
      <span class="help">这个二维码 5 分钟内有效、只能用一次，里面没有长期密钥。扫完后两边会各显示一个 4 位数字，你核对一致才算配对成功。</span>`;
    const row = el('div', 'rc-qr-btns');
    row.append(btn('复制链接', '', () => { navigator.clipboard.writeText(url); toast('链接已复制：只发给你自己的手机，5 分钟内有效'); }), btn('关闭', 'primary', close));
    card.appendChild(row);
    const left = card.querySelector('.rc-left');
    const tick = () => {
      const ms = remoteCtl.ticketLeft(dev);
      if (!ms) return expired();
      left.textContent = `还剩 ${mmss(ms)}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  function expired() {
    clearInterval(timer);
    if (dev.pk) return;
    card.innerHTML = `<b>二维码已过期</b><span class="help">为了安全，配对二维码 5 分钟后自动失效，扫过一次也会失效。</span>`;
    const row = el('div', 'rc-qr-btns');
    row.append(btn('关闭', '', close), btn('重新生成', 'primary', () => { remoteCtl.newTicket(dev); showCode(); }));
    card.appendChild(row);
  }
  // 手机扫码后：在这里核对数字
  const offConfirm = remoteCtl.onConfirm((d, r) => {
    if (d.id !== dev.id || !ov.isConnected) return null;
    clearInterval(timer);
    return new Promise((resolve) => {
      card.innerHTML = `<b>核对数字</b><span class="help" style="text-align:center">${esc(r.label || '手机')}扫了码，手机屏幕上显示的数字是：</span><div class="rc-pin">${esc(r.code)}</div>
        <span class="help">一样才点「配对」。不一样、或者扫码的不是你，点「不是我」，这个二维码已经作废，别人也用不了。</span>`;
      const row = el('div', 'rc-qr-btns');
      row.append(btn('不是我', '', () => { resolve(false); expired(); }), btn('一样，配对', 'primary', () => resolve(true)));
      card.appendChild(row);
    });
  });
  const offPaired = remoteCtl.onPaired((devId) => {
    if (devId !== dev.id || !ov.isConnected) return;
    card.innerHTML = `<div class="rc-ok">${icon('check')}</div><b>「${esc(dev.name)}」配对成功</b><span class="help">手机已经连上这台电脑，可以在手机上看对话、发消息了。添加到主屏幕后像 App 一样打开。</span>`;
    card.appendChild(btn('好的', 'primary', close));
    shut = setTimeout(close, 2500);
  });
  function close() { clearInterval(timer); clearTimeout(shut); offConfirm(); offPaired(); ov.remove(); }
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);
  showCode();
}

// 二维码窗口已经关了、手机这时才配对成功：右下角提示一下
remoteCtl.onPaired((devId, first) => {
  if (!first || document.querySelector('.rc-qr-ov')) return;
  const d = (data.remote && data.remote.devices || []).find((x) => x.id === devId);
  if (d) toast(`「${d.name}」配对成功，手机已经连上这台电脑`, 4000);
});

// 「加密原理」：说清楚谁能看到什么，附上源码位置，让人自己核对
function showE2EDoc() {
  const link = (path, text) => `<a href="#" data-src="${path}">${text}</a>`;
  const body = el('div', 'rc-doc', `
    <p>远程控制的数据要经过中转服务器。这套设计的目标是：<b>中转服务器只能转发，看不到也改不了内容</b>，就算中转被别人控制也一样。</p>
    <h4>谁能看到你的对话内容</h4>
    <ul>
      <li><b>能看到：</b>这台电脑、配对过的手机。</li>
      <li><b>看不到：</b>中转服务器（包括它的主人和机房）、网络运营商、路上的任何人。他们只能看到「什么时候在通信、每条大概多大」，看不到内容。</li>
      <li>手机发给 Claude 的内容，到电脑后照常经 SSH 交给服务器上的 Claude Code，那一段和以前一样，与远程控制无关。</li>
    </ul>
    <h4>配对：二维码只能用一次</h4>
    <ul>
      <li>二维码里没有长期密钥，只有一张 5 分钟内有效、只能用一次的「门票」和电脑的公钥。</li>
      <li>手机扫码后自己生成一对密钥，两边各用自己的私钥和对方的公钥算出同一把长期密钥（X25519）。这把密钥从不在网络上传，也不在二维码里。</li>
      <li>门票用过就作废，之后谁拿到二维码截图都没用。</li>
      <li>两边各显示一个 4 位数字，你核对一致才配对。如果二维码在你扫之前被别人抢先用了，数字会对不上，点「不是我」就行。</li>
    </ul>
    <h4>每次连接都换钥匙</h4>
    <ul>
      <li>手机每次连上，两边各生成一对只用这一次的临时密钥，算出这次连接的会话密钥，断开就扔。</li>
      <li>就算以后长期密钥泄露，以前录下来的流量也解不开（向前保密）。</li>
      <li>每条消息带递增序号，重放旧消息会被直接丢掉；内容被改动一个字节都会解密失败（XSalsa20-Poly1305）。</li>
    </ul>
    <h4>手机页面从哪里来</h4>
    <ul>
      <li><b>安全模式：</b>手机页面从 GitHub 上公开的源码自动发布，中转服务器碰不到页面代码。你信任的是 GitHub 和这份公开代码。</li>
      <li><b>快速模式：</b>页面由中转服务器提供，打开更快。前提是信任中转服务器：它理论上能换掉页面代码。只建议在中转是你自己的服务器时用。</li>
      <li><b>安卓 App：</b>页面代码打包在 App 里，不从网上加载。</li>
    </ul>
    <h4>加密管不到的地方</h4>
    <ul>
      <li>手机或电脑本身中了木马、或者被别人拿到并解锁：内容在设备上本来就是明文。手机丢了，在这里把它「撤销」。</li>
      <li>中转服务器可以故意不转发（让你连不上），但偷不到、也改不了内容。</li>
    </ul>
    <h4>自己核对源码</h4>
    <ul class="rc-src">
      <li>${link('mobile/e2e.js', '加密协议（手机和电脑共用同一份）')}</li>
      <li>${link('src/renderer/remote.js', '电脑端：配对、核对数字、收发消息')}</li>
      <li>${link('mobile/app.js', '手机页面')}</li>
      <li>${link('relay/main.go', '中转程序：只按编号转发，不解密')}</li>
      <li>${link('.github/workflows/pages.yml', '安全模式的手机页面怎么从源码发布到 GitHub')}</li>
    </ul>`);
  body.querySelectorAll('[data-src]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); api.openExternal(SRC + a.dataset.src); }; });
  modal({ title: '加密原理', body, wide: true, buttons: [{ text: '阅读全部源码', onClick: () => { api.openExternal('https://github.com/TomEageer/claude-remote'); } }, { text: '知道了', cls: 'primary', value: true }] });
}

// 每次升级后：还有手机在用旧的配对方式，提醒一次（旧配对照常能用，只是建议升级）
setTimeout(async () => {
  const old = ((data.remote && data.remote.devices) || []).filter((d) => remoteCtl.isLegacy(d));
  if (!old.length) return;
  const ver = await api.appVersion();
  if (data.ui.e2eNag === ver || document.querySelector('.overlay')) return;
  data.ui.e2eNag = ver;
  save();
  const names = old.map((d) => `「${d.name}」`).join('、');
  const go = await modal({
    title: '建议重新配对手机',
    body: `<p style="margin:4px 0 10px">远程控制换了一套更安全的加密方式：配对二维码只能用一次、5 分钟后失效，手机每次连接都换新的密钥，以前的流量就算被录下来也解不开。</p>
      <p style="margin:0 0 10px">${esc(names)}还在用旧的配对方式，<b>现在照常能用</b>，但旧二维码和配对链接里带着长期密钥：截图或链接一旦被别人拿到，就能一直解开你的对话内容。</p>
      <p class="help" style="margin:0 0 8px">建议花一分钟升级：在「设置 → 远程控制」里点「升级配对」，用手机<b>相机</b>扫新二维码（iPhone 会在 Safari 里打开新页面），配好后旧配对自动作废。</p>
      <p class="help" style="margin:0">手机上以前「添加到主屏幕」的图标打开的还是旧页面：配好后在 Safari 里重新「添加到主屏幕」，再把旧图标删掉。</p>`,
    buttons: [{ text: '加密原理', onClick: () => { showE2EDoc(); } }, { text: '以后再说', value: false }, { text: '去升级', cls: 'primary', value: true }],
  });
  if (go) openSettings('remote');
}, 6000);
