/* global api, data, live, el, esc, icon, toast, save, findSession, currentId, renderAll, renderSidebar, sendMessage, mergeIntoRun, injectMessage,
   scheduleLiveRender, serverLabel, side, nacl, qrcode, closeModal, confirmModal, promptModal, TOOL_LABELS, mcpLabel, uid,
   modelList, modelLabel, currentModel, effortFor, effortLevels, EFFORT_LABEL, renderModel, renderTitle, syncTitle, clearDraft, draftKey, useDraftFor, rememberCwd,
   splitOutputs, KNOWN_EXT, resolveRemote, moveSession, newChatGroup */
'use strict';

// ---------- 远程控制：手机经中转枢纽（crrelay）操控这台电脑上的对话 ----------
// data.remote = { on, relay, token, name, hostId, devices: [{ id, name, key, addedAt, lastSeen }] }
// 和手机之间的内容全部用每台手机自己的密钥加密（tweetnacl secretbox），中转服务器只看到密文。
// 帧格式见 relay/main.go；加密内容：手机 → { id, op, ... }，电脑 → { re: id, ok, ... } 或推送 { push, ... }

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
    if (dev && online.has(devId)) rawSend({ t: 'msg', to: devId, box: seal(dev, obj) });
  }

  function peer(devId, on) {
    const dev = findDevice(devId);
    // 撤销过、或者根本不是这台电脑配对的手机：让中转把它踢掉，手机那边会提示重新配对
    if (!dev) { if (on) rawSend({ t: 'revoked', to: devId }); return; }
    // 以前就连过的手机（老版本没记配对时间）：算已经配对过，不再弹「配对成功」
    if (on && dev.lastSeen && !dev.pairedAt) dev.pairedAt = dev.lastSeen;
    if (on) { online.add(devId); dev.lastSeen = Date.now(); save(); }
    else { online.delete(devId); delete watching[devId]; delete sentList[devId]; heard.delete(devId); }
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
    } else if (i.file_path) out.detail = String(i.file_path);
    else if (i.url || i.query || i.pattern) out.detail = String(i.url || i.query || i.pattern).slice(0, 500);
    if (task) out.task = { kind: task.kind, status: task.status, progress: String(task.progress || '').slice(0, 200), summary: String(task.summary || '').slice(0, 1500) };
    return out;
  };
  function simplify(m, s) {
    if (m.role === 'user') return { role: 'user', text: clip(m.text, 20000), files: (m.files || []).map((f) => ({ name: f.name, thumb: f.thumb && f.thumb.length < 40000 ? f.thumb : '' })), ts: m.ts, merged: !!m.merged };
    const tasks = {};
    for (const x of (s && s.messages) || []) for (const t of x.tasks || []) if (t.toolId) tasks[t.toolId] = t;
    const blocks = [];
    for (const b of m.blocks || []) {
      if (b.type === 'text') blocks.push({ type: 'text', text: clip(b.text, 60000) });
      else if (b.type !== 'tool') continue;
      else if (b.ask) blocks.push({ type: 'ask', requestId: b.ask.requestId, questions: b.ask.questions, state: b.ask.state, answers: b.ask.answers });
      else if (b.plan) blocks.push({ type: 'plan', requestId: b.plan.requestId, text: clip(b.plan.text, 60000), state: b.plan.state });
      else blocks.push(toolOf(b, tasks[b.id]));
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
      .map((s) => ({ id: s.id, title: s.title, server: servers.get(s.serverId) || '对话', serverId: s.serverId || null, groupId: s.groupId || null, pinned: !!s.pinned, updatedAt: s.updatedAt, running: !!live[s.id], unread: s.unread || '', pending: (pendingOf(s) || {}).kind || '' }));
  }
  const groupsOf = () => (data.groups || []).map((g) => ({ id: g.id, name: g.name }));

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
      model: currentModel(),
      modelLabel: modelLabel(currentModel()),
      effort: effortFor(currentModel()),
      efforts: effortLevels(currentModel()),
      effortNames: EFFORT_LABEL,
      commands: cmds.slice(0, 200),
      usage: (data.ui.usage || {})[data.currentServer] || null,
      exts: typeof KNOWN_EXT === 'string' ? KNOWN_EXT : '',
    };
  }

  // 排队等这一轮结束再发的消息（Claude 正在回复、又没法直接交给它的时候）：手机上也要看得到、能撤回
  const queueOf = (s) => (s.queue || []).map((q) => ({ id: q.id, text: clip(q.text, 4000), files: (q.files || []).map((f) => f.name) }));
  const PAGE = 30;
  function chatOf(s, before) {
    const end = before != null ? Math.max(0, Math.min(before, s.messages.length)) : s.messages.length;
    const from = Math.max(0, end - PAGE);
    return { title: s.title, offset: from, messages: s.messages.slice(from, end).map((m) => simplify(m, s)), running: !!live[s.id], n: s.messages.length, plan: !!s.planMode, pinned: !!s.pinned, queue: queueOf(s) };
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
    const req = unseal(dev, box);
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
        if (req.model) data.settings.model = req.model;
        if (req.effort !== undefined) data.settings.effort = req.effort || '';
        save();
        if (typeof renderModel === 'function') renderModel();
        return infoOf();
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
    if (!r.ok) { b.ask.state = 'expired'; save(); return { ok: false, message: r.message }; }
    b.ask.state = req.skip ? 'skipped' : 'answered';
    b.ask.answers = req.skip ? null : req.answers;
    save();
    renderSidebar();
    if (s.id === currentId) scheduleLiveRender();
    return {};
  }

  async function answerPlan(req) {
    const s = findSession(req.sid);
    const b = s && findBlock(s, (x) => x.plan && x.plan.requestId === req.requestId);
    if (!b || b.plan.state !== 'pending') return { ok: false, message: '这个计划已经处理过或者失效了' };
    const r = await api.planAnswer({ sessionId: s.id, requestId: req.requestId, approve: !!req.approve, feedback: '' });
    if (!r.ok) { b.plan.state = 'expired'; save(); return { ok: false, message: r.message }; }
    b.plan.state = req.approve ? 'approved' : 'rejected';
    if (req.approve) { s.planMode = false; if (typeof side !== 'undefined') side.renderButtons(); }
    save();
    renderSidebar();
    if (s.id === currentId) scheduleLiveRender();
    return {};
  }

  // 回复过程中的每个事件、以及任何会存盘的改动，都可能需要推给手机
  api.onEvent(() => changed());

  // ---------- 配对 ----------
  function b64url(str) {
    return toB64(enc.encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function pairCode(dev) {
    const c = cfg();
    return b64url(JSON.stringify({ v: 1, h: c.hostId, d: dev.id, k: dev.key, n: c.name || '我的电脑' }));
  }
  const pairUrl = (dev) => `${relayHttp()}/#p=${pairCode(dev)}`;
  function addDevice(name) {
    const dev = { id: randId(), name: name || `手机 ${devices().length + 1}`, key: toB64(nacl.randomBytes(32)), addedAt: Date.now(), lastSeen: null };
    devices().push(dev);
    save();
    return dev;
  }
  function revoke(devId) {
    cfg().devices = devices().filter((d) => d.id !== devId);
    save();
    rawSend({ t: 'revoked', to: devId });
    online.delete(devId);
    listeners.forEach((f) => f());
  }

  return {
    start, stop, changed, addDevice, revoke, pairUrl, pairCode,
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

const remoteView = {
  open(pane) {
    const c = remoteCtl.cfg();
    pane.innerHTML = '';
    const box = el('div', 'rc-pane');
    box.innerHTML = `
      <p class="help rc-intro">在手机上查看和操控这台电脑上的对话：发消息、看回复、回答 Claude 的提问、批准计划。手机和电脑都连到你自己的中转服务器，内容在两端加密，中转服务器看不到。</p>
      <div class="rc-dl">${icon('download')}<div><b>第一步：在一台有公网地址的服务器上装好中转程序</b><span>一行命令安装，自带手机网页，跟着软件一起更新</span></div>
        <button class="btn" id="rc-doc">安装说明</button><button class="btn" id="rc-dl">下载</button></div>
      <div class="st-sec">第二步：连接中转服务器</div>
      <label class="check"><input type="checkbox" id="rc-on" ${c.on ? 'checked' : ''} /> 开启远程控制（软件开着时一直保持连接）</label>
      <label class="check"><input type="checkbox" id="rc-awake" ${c.keepAwake !== false ? 'checked' : ''} /> 开着远程控制时不让电脑自动睡眠（屏幕照样会关；笔记本合上盖子仍会睡）</label>
      <div class="frow2">
        <div class="field grow"><label>中转地址</label><input id="rc-relay" placeholder="https://relay.example.com" value="${esc(c.relay || '')}" spellcheck="false" /></div>
        <div class="field grow"><label>访问令牌</label><div class="row"><input id="rc-token" class="secret" value="${esc(c.token || '')}" spellcheck="false" autocomplete="off" /><button class="icon-btn reveal" title="显示 / 隐藏">${icon('eye')}</button></div></div>
      </div>
      <div class="field"><label>这台电脑在手机上显示的名字</label><input id="rc-name" placeholder="我的电脑" value="${esc(c.name || '')}" /></div>
      <div class="rc-status-row"><button class="btn primary" id="rc-save">保存并连接</button><span class="rc-status" id="rc-status"></span></div>
      <div class="st-sec">第三步：添加手机</div>
      <div class="rc-devs" id="rc-devs"></div>
      <button class="btn" id="rc-add">${icon('plus')}添加手机</button>
      <div class="rc-phones">
        <div><b>iPhone</b><span>不用装 App：用 Safari 打开上面的中转地址，扫码配对后点分享按钮 →「添加到主屏幕」，像 App 一样全屏打开</span></div>
        <div><b>安卓</b><span>可以装 App（打开后扫电脑上的二维码配对），也可以和 iPhone 一样直接用浏览器打开中转地址</span><button class="btn" id="rc-android">${icon('download')}下载安卓 App</button></div>
      </div>`;
    pane.appendChild(box);
    const $ = (s) => box.querySelector(s);
    $('.reveal').onclick = () => $('#rc-token').classList.toggle('secret');
    $('#rc-doc').onclick = () => api.openExternal(RELAY_DOC);
    $('#rc-dl').onclick = () => api.openExternal(RELAY_RELEASES);
    $('#rc-android').onclick = () => api.openExternal(ANDROID_APK);
    const status = () => {
      const s = remoteCtl.state;
      const st = $('#rc-status');
      st.className = 'rc-status ' + (s === 'on' ? 'ok' : s === 'error' ? 'bad' : '');
      const rv = remoteCtl.relayVersion;
      const older = rv && appVer && rv !== 'dev' && rv.split('.').map(Number).some((n, i, a) => { const b = appVer.split('.').map(Number); return a.slice(0, i).every((x, j) => x === b[j]) && n < b[i]; });
      st.textContent = s === 'on' ? `已连接中转服务器${rv ? `（中转程序 ${rv}）` : ''}${older ? '，有新版本：在服务器上再运行一次安装命令就能更新' : ''}` : s === 'connecting' ? '正在连接…' : s === 'error' ? remoteCtl.error : '未开启';
    };
    const renderDevs = () => {
      const list = $('#rc-devs');
      list.innerHTML = '';
      const devs = remoteCtl.cfg().devices || [];
      if (!devs.length) list.appendChild(el('div', 'help', '还没有手机。连接好中转服务器后点「添加手机」，用手机相机扫码。'));
      for (const d of devs) {
        const on = remoteCtl.isOnline(d.id);
        const row = el('div', 'rc-dev', `<span class="rc-dot${on ? ' on' : ''}"></span><b>${esc(d.name)}</b><span class="rc-seen">${on ? '在线' : d.lastSeen ? '上次连接 ' + new Date(d.lastSeen).toLocaleString() : '还没扫码'}</span>`);
        const show = el('button', 'btn', '二维码');
        show.title = '换手机浏览器或清了数据时，重新扫这个码';
        show.onclick = () => showQr(d);
        const rm = el('button', 'btn', '撤销');
        rm.onclick = async () => {
          if (await confirmModal('撤销这台手机', `「${d.name}」将不能再连接这台电脑，要再用需要重新扫码添加。`, '撤销')) { remoteCtl.revoke(d.id); renderDevs(); }
        };
        row.append(show, rm);
        list.appendChild(row);
      }
    };
    $('#rc-save').onclick = () => {
      Object.assign(c, { on: $('#rc-on').checked, keepAwake: $('#rc-awake').checked, relay: $('#rc-relay').value.trim(), token: $('#rc-token').value.trim(), name: $('#rc-name').value.trim() });
      if (c.on && (!c.relay || !c.token)) return toast('先填中转地址和访问令牌');
      save();
      remoteCtl.start();
    };
    $('#rc-add').onclick = async () => {
      if (remoteCtl.state !== 'on') return toast('先连上中转服务器，再添加手机');
      const name = await promptModal('添加手机', '给这台手机起个名字', `手机 ${(c.devices || []).length + 1}`);
      if (name == null) return;
      const d = remoteCtl.addDevice(name.trim());
      renderDevs();
      showQr(d);
    };
    let appVer = '';
    api.appVersion().then((v) => { appVer = v; status(); });
    status();
    renderDevs();
    const off = remoteCtl.onChange(() => { if (!box.isConnected) return off(); status(); renderDevs(); });
  },
};

function showQr(dev) {
  const url = remoteCtl.pairUrl(dev);
  const code = remoteCtl.pairCode(dev);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const ov = el('div', 'overlay rc-qr-ov');
  const card = el('div', 'rc-qr', `<b>在「${esc(dev.name)}」上扫码</b><div class="rc-qr-img">${qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true })}</div>
    <span class="help">用手机相机扫，或者打开 <code>${esc(remoteCtl.relayHttp())}</code> 点「扫描二维码」。扫不了码的话，在手机页面点「输入配对码」，粘贴下面这串。</span>
    <div class="rc-code"><code>${esc(code)}</code></div>
    <span class="help">配对码和二维码里都有这台手机的加密密钥，只发给你自己。</span>`);
  const row = el('div', 'rc-qr-btns');
  const copyCode = el('button', 'btn', '复制配对码');
  copyCode.onclick = () => { navigator.clipboard.writeText(code); toast('配对码已复制：只发给你自己的手机'); };
  const copy = el('button', 'btn', '复制链接');
  copy.onclick = () => { navigator.clipboard.writeText(url); toast('链接已复制：只发给你自己的手机'); };
  const done = el('button', 'btn primary', '完成');
  row.append(copyCode, copy, done);
  card.appendChild(row);
  ov.appendChild(card);
  // 手机扫码连上来：二维码换成「配对成功」，2.5 秒后自己关
  let shut = 0;
  const off = remoteCtl.onPaired((devId) => {
    if (devId !== dev.id || !ov.isConnected) return;
    off();
    card.innerHTML = `<div class="rc-ok">${icon('check')}</div><b>「${esc(dev.name)}」配对成功</b><span class="help">手机已经连上这台电脑，可以在手机上看对话、发消息了。添加到主屏幕后像 App 一样打开。</span>`;
    const ok = el('button', 'btn primary', '好的');
    ok.onclick = close;
    card.appendChild(ok);
    shut = setTimeout(close, 2500);
  });
  function close() { clearTimeout(shut); off(); ov.remove(); }
  done.onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);
}

// 二维码窗口已经关了、手机这时才第一次扫码连上：右下角提示一下
remoteCtl.onPaired((devId, first) => {
  if (!first || document.querySelector('.rc-qr-ov')) return;
  const d = (data.remote && data.remote.devices || []).find((x) => x.id === devId);
  if (d) toast(`「${d.name}」配对成功，手机已经连上这台电脑`, 4000);
});
