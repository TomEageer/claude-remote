/* global api, el, esc, icon, toast, fmtTime, data, save, uid, renderSidebar, openSession, showView */
'use strict';

// 服务器上的历史会话：列出 Claude Code 在服务器上保存的会话，导入后可以接着聊
const historyView = {
  items: null,
  error: '',
  filter: '',
  busy: {},

  async open() {
    const v = document.querySelector('#view-history');
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="pl-wrap">
          <div class="pl-head">
            <div><h2>服务器上的会话</h2><p class="wsub">这里是服务器上 Claude Code 保存的所有会话，包括在终端里用过的。导入后能看到完整内容，也能接着聊。</p></div>
            <button class="icon-btn" id="hi-refresh" title="刷新">${icon('refresh')}</button>
          </div>
          <div class="hi-bar">
            <div class="search"><span class="ico">${icon('search')}</span><input id="hi-search" placeholder="搜索标题、内容或目录" /></div>
            <button class="btn primary" id="hi-all">${icon('download')}<span>全部导入</span></button>
          </div>
          <div id="hi-list"></div>
        </div>`;
      v.querySelector('#hi-refresh').onclick = () => this.reload();
      v.querySelector('#hi-search').oninput = (e) => { this.filter = e.target.value.trim().toLowerCase(); this.render(); };
      v.querySelector('#hi-all').onclick = () => this.importAll();
      v.dataset.built = '1';
    }
    this.reload();
  },

  async reload() {
    this.items = null;
    this.error = '';
    this.render();
    const c = await api.connect();
    if (!c.ok) { this.error = '连接服务器失败：' + c.message; return this.render(); }
    const r = await api.historyList();
    if (r.ok) this.items = r.items;
    else this.error = r.message;
    this.render();
  },

  imported(id) {
    return data.sessions.find((s) => s.claudeId === id);
  },

  visible() {
    const f = this.filter;
    return (this.items || []).filter((x) => !f || `${x.title} ${x.first} ${x.cwd}`.toLowerCase().includes(f));
  },

  render() {
    const box = document.querySelector('#hi-list');
    if (!box) return;
    if (this.error) { box.innerHTML = `<div class="fm-empty err">${esc(this.error)}</div>`; return; }
    if (!this.items) { box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取服务器上的会话…</span></div>'; return; }
    const list = this.visible();
    const left = list.filter((x) => !this.imported(x.id)).length;
    const all = document.querySelector('#hi-all');
    all.disabled = !left;
    all.querySelector('span').textContent = left ? `全部导入（${left}）` : '都已导入';
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = `<div class="fm-empty">${this.items.length ? '没有匹配的会话' : '服务器上还没有 Claude Code 会话'}</div>`; return; }
    for (const x of list) {
      const done = this.imported(x.id);
      const c = el('div', 'pl-card hi-card');
      const title = (x.title || x.first || '（没有内容）').replace(/\s+/g, ' ');
      c.innerHTML = `
        <div class="pl-ico">${icon('chat')}</div>
        <div class="pl-main">
          <div class="pl-name hi-title">${esc(title.slice(0, 80))}</div>
          ${x.title && x.first ? `<div class="pl-desc hi-first">${esc(x.first.replace(/\s+/g, ' ').slice(0, 120))}</div>` : ''}
          <div class="hi-meta"><span class="mono">${esc(x.cwd || x.project)}</span><span>${fmtTime(x.mtime)}</span><span>${x.prompts} 问 · ${x.replies} 答</span></div>
        </div>
        <div class="pl-act"></div>`;
      const act = c.querySelector('.pl-act');
      if (this.busy[x.id]) act.innerHTML = '<span class="spin"></span>';
      else if (done) {
        const b = el('button', 'btn', '打开');
        b.onclick = () => openSession(done.id);
        act.appendChild(b);
      } else {
        const b = el('button', 'btn primary', '导入');
        b.onclick = async () => { const s = await this.importOne(x); if (s) openSession(s.id); };
        act.appendChild(b);
      }
      box.appendChild(c);
    }
  },

  groupId() {
    let g = data.groups.find((x) => x.name === '服务器上的会话');
    if (!g) {
      g = { id: uid(), name: '服务器上的会话', collapsed: false, createdAt: Date.now() };
      data.groups.push(g);
    }
    return g.id;
  },

  async importOne(x, quiet) {
    if (this.imported(x.id)) return this.imported(x.id);
    this.busy[x.id] = true;
    this.render();
    const r = await api.historyLoad(x.id);
    delete this.busy[x.id];
    if (!r.ok) { toast(`导入失败：${r.message}`, 5000); this.render(); return null; }
    const s = {
      id: uid(),
      title: (r.title || x.title || x.first || '服务器会话').replace(/\s+/g, ' ').slice(0, 40),
      groupId: this.groupId(),
      createdAt: x.mtime,
      updatedAt: r.mtime || x.mtime,
      started: true,
      claudeId: r.id,
      cwd: r.cwd || x.cwd || null,
      imported: true,
      messages: r.messages,
    };
    data.sessions.push(s);
    save();
    renderSidebar();
    this.render();
    if (!quiet) toast(`已导入「${s.title}」`);
    return s;
  },

  async importAll() {
    const todo = this.visible().filter((x) => !this.imported(x.id));
    let n = 0;
    for (const x of todo) if (await this.importOne(x, true)) n++;
    toast(`已导入 ${n} 个会话，放在「服务器上的会话」分组里`, 4000);
  },
};

// 已有会话：从服务器重新载入（比如在终端里接着聊过）
async function reloadFromServer(sid) {
  const s = data.sessions.find((x) => x.id === sid);
  if (!s || !s.claudeId) return;
  const r = await api.historyLoad(s.claudeId);
  if (!r.ok) return toast(`载入失败：${r.message}`, 5000);
  s.messages = r.messages;
  s.cwd = s.cwd || r.cwd || null;
  s.updatedAt = Math.max(s.updatedAt || 0, r.mtime || 0);
  save();
  if (typeof openSession === 'function') openSession(s.id);
  toast(`已载入服务器上的最新内容（${r.messages.length} 条消息）`);
}

document.querySelector('#btn-history').onclick = () => showView('history');
