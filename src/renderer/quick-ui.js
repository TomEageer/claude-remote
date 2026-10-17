/* global api, data, save, toast, esc, el, findSession, currentId, live, openSession, startNewChat, sendMessage, uid, renderQueue, pendingOf */
'use strict';

// ---------- 快速输入：任何软件里按快捷键呼出小输入条（窗口和快捷键在主进程的 quick.js） ----------
const quickUI = {
  isMac: api.platform === 'darwin',
  defaults() { return { mode: 'double', key: this.isMac ? 'alt' : 'ctrl', combo: 'CommandOrControl+Shift+Space', pos: 'center' }; },
  cfg() { return { ...this.defaults(), ...((data.settings && data.settings.quick) || {}) }; },
  status: null,

  async start() {
    this.status = await api.quickConfig(this.cfg());
    // macOS 双击修饰键要辅助功能权限：只提示一次，不主动弹系统授权框
    if (this.status && this.status.needGrant && !data.ui.quickTipShown) {
      data.ui.quickTipShown = 1;
      save();
      setTimeout(() => toast('快速输入（双击 Option 呼出）需要辅助功能权限：到「设置 → 常规 → 快速输入」点「去允许」', 8000), 3000);
    }
    // 当前对话 + 最近 5 个对话和它们的状态，变了才推给小输入条
    let last = '';
    setInterval(() => {
      const s = currentId && findSession(currentId);
      const recent = (data.sessions || [])
        .filter((x) => !x.demo && (!x.serverId || x.serverId === data.currentServer))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 5)
        .map((x) => ({
          sid: x.id,
          title: x.title || '新对话',
          state: live[x.id] ? (typeof pendingOf === 'function' && pendingOf(x) ? 'wait' : 'run') : x.unread === 'error' ? 'error' : x.unread ? 'done' : 'idle',
          at: x.updatedAt || 0,
        }));
      const ctx = { sid: s ? s.id : null, title: s ? s.title : '', recent };
      const k = JSON.stringify(ctx) + Math.floor(Date.now() / 60000);
      if (k !== last) { last = k; api.quickCtx(ctx); }
    }, 1000);
  },

  async set(patch) {
    data.settings.quick = { ...this.cfg(), ...patch };
    save();
    this.status = await api.quickConfig(this.cfg());
    this.renderStatus();
  },

  // 设置 → 常规 里的「快速输入」
  mount(box) {
    this.box = box;
    const c = this.cfg();
    const keys = this.isMac ? [['alt', 'Option'], ['meta', 'Command'], ['ctrl', 'Control'], ['shift', 'Shift']] : [['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift']];
    box.innerHTML = `
      <div class="st-sec">快速输入</div>
      <p class="help">在任何软件里按快捷键，弹出一个小输入条，打字回车直接发给 Claude（可以选新对话或继续上一个对话，也能把文件拖进去），不用切回这个窗口。</p>
      <div class="qk-row">
        <select id="qk-mode">
          <option value="double"${c.mode === 'double' ? ' selected' : ''}>双击一个键</option>
          <option value="combo"${c.mode === 'combo' ? ' selected' : ''}>组合键</option>
          <option value="off"${c.mode === 'off' ? ' selected' : ''}>关闭</option>
        </select>
        <select id="qk-key"${c.mode === 'double' ? '' : ' hidden'}>${keys.map(([k, t]) => `<option value="${k}"${c.key === k ? ' selected' : ''}>双击 ${t}</option>`).join('')}</select>
        <input id="qk-combo" readonly value="${esc(this.comboText(c.combo))}" title="点一下，然后按下想用的组合键"${c.mode === 'combo' ? '' : ' hidden'} />
      </div>
      <div class="qk-status"></div>
      <div class="qk-row"><span class="qk-label">出现位置</span>
        <select id="qk-pos">${[['mouse', '跟随鼠标的高度'], ['center', '屏幕正中（拖动后记住位置）'], ['bottom', '屏幕底部']].map(([k, t]) => `<option value="${k}"${c.pos === k ? ' selected' : ''}>${t}</option>`).join('')}</select></div>`;
    const mode = box.querySelector('#qk-mode');
    const key = box.querySelector('#qk-key');
    const combo = box.querySelector('#qk-combo');
    mode.onchange = () => { key.hidden = mode.value !== 'double'; combo.hidden = mode.value !== 'combo'; this.set({ mode: mode.value }); };
    key.onchange = () => this.set({ key: key.value });
    box.querySelector('#qk-pos').onchange = (e) => this.set({ pos: e.target.value });
    combo.onfocus = () => { combo.value = '请按下组合键…'; };
    combo.onblur = () => { combo.value = this.comboText(this.cfg().combo); };
    combo.onkeydown = (e) => {
      e.preventDefault();
      if (e.key === 'Escape') return combo.blur();
      const acc = this.accelerator(e);
      if (!acc) { combo.value = '至少按一个 ' + (this.isMac ? '⌘ / ⌥ / ⌃' : 'Ctrl / Alt') + ' 再加一个键'; return; }
      this.set({ combo: acc }).then(() => { combo.value = this.comboText(acc); combo.blur(); });
    };
    this.renderStatus();
  },

  renderStatus() {
    const st = this.box && this.box.querySelector('.qk-status');
    if (!st || !this.status) return;
    st.className = 'qk-status ' + (this.status.ok ? 'ok' : 'bad');
    st.innerHTML = `<span>${esc(this.status.message || '')}</span>`;
    if (this.status.needGrant) {
      const b = el('button', 'btn', '去允许');
      b.onclick = async () => { await api.quickGrant(); toast('在弹出的系统设置里打开「Claude 远程助手」的开关，回来就能用了', 6000); };
      st.appendChild(b);
    }
  },

  // 键盘事件 → Electron 的快捷键写法（例如 CommandOrControl+Shift+Space）
  accelerator(e) {
    const mods = [];
    if (this.isMac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
    if (this.isMac && e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let k = e.code;
    if (/^Key[A-Z]$/.test(k)) k = k.slice(3);
    else if (/^Digit\d$/.test(k)) k = k.slice(5);
    else if (!/^F\d{1,2}$/.test(k)) k = { Space: 'Space', Enter: 'Enter', Backquote: '`', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=' }[k];
    if (!k || !mods.some((m) => m !== 'Shift')) return null;
    return [...mods, k].join('+');
  },
  comboText(acc) {
    return String(acc || '').replace('CommandOrControl', this.isMac ? '⌘' : 'Ctrl').replace('Control', '⌃').replace('Alt', this.isMac ? '⌥' : 'Alt').replace('Shift', this.isMac ? '⇧' : 'Shift').replace(/\+/g, this.isMac ? '' : ' + ').replace('Space', this.isMac ? ' 空格' : '空格');
  },
};

// 小输入条里回车：发到新对话，或接着发到选的那个对话（在回复中就排队）
api.onQuickSubmit(async ({ text, paths, sid }) => {
  const target = sid ? findSession(sid) : null;
  const files = [];
  for (const p of paths || []) {
    const r = await api.upload(uid(), p);
    if (r.ok) files.push({ name: p.split(/[\\/]/).pop(), remotePath: r.remotePath, promptPath: r.promptPath, size: r.size, status: 'done' });
    else toast(`${p.split(/[\\/]/).pop()} 上传失败：${r.message}`, 5000);
  }
  if (!text && !files.length) return;
  if (target && live[target.id]) {
    target.queue = target.queue || [];
    target.queue.push({ id: uid(), text, files });
    save(target.id);
    if (target.id === currentId && typeof renderQueue === 'function') renderQueue();
    toast(`「${target.title}」正在回复，已排队，回复完自动发出`, 4000);
    return;
  }
  if (target) { if (target.id !== currentId) openSession(target.id); }
  else startNewChat(null);
  await sendMessage({ text, files, sid: target ? target.id : null });
});
api.onQuickStatus((st) => { quickUI.status = st; quickUI.renderStatus(); if (st && st.ok) toast('快速输入' + st.message, 4000); });
