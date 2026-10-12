/* global api, el, esc, icon, toast, modal, confirmModal, data, save, findSession, currentId, showView, newChatCaps */
'use strict';

// ---------- 全局能力缓存 ----------
const caps = {
  global: null, // { mcp: [{name, scope, config}], skills: [{name, dir, description}], plugins: [] }
  error: '',
  status: null, // mcp 名称 → { ok, text }
  loading: null,

  async load(force) {
    if (this.global && !force) return this.global;
    if (!this.loading) {
      this.loading = (async () => {
        const c = await api.connect();
        if (!c.ok) throw new Error('连接服务器失败：' + c.message);
        const r = await api.capsGlobal();
        if (!r.ok) throw new Error(r.message);
        return r;
      })()
        .then((r) => { this.global = r; this.error = ''; return r; })
        .catch((e) => { this.error = e.message; return null; })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  },

  // Skill 全集：服务器上用户装的 + 最近一次会话报告的（含内置）
  allSkills() {
    const user = (this.global && this.global.skills) || [];
    const names = new Set(user.map((s) => s.name));
    const builtin = (data.ui.lastSkills || []).filter((n) => !names.has(n)).map((n) => ({ name: n, builtin: true }));
    return [...user, ...builtin];
  },
};

const SCOPE_LABEL = { user: '全局', local: '本目录', project: '项目' };

function mcpSummary(cfg) {
  if (!cfg) return '';
  if (cfg.url) return `${cfg.type || 'http'} · ${cfg.url}`;
  return [cfg.command, ...(cfg.args || [])].join(' ');
}

// ---------- 全局页面 ----------
const capsView = {
  tab: 'mcp',

  async open() {
    const v = document.querySelector('#view-caps');
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="pl-wrap">
          <div class="pl-head">
            <div><h2>MCP 与 Skill</h2><p class="wsub">这里是服务器上为 Claude 装好的扩展能力。每个对话默认都能用；想在某个对话里关掉一部分，点输入框旁边的「能力」。</p></div>
            <button class="icon-btn" id="cp-refresh" title="刷新">${icon('refresh')}</button>
          </div>
          <div class="seg pl-tabs cp-tabs"><button data-t="mcp">MCP 服务器</button><button data-t="skill">Skill</button><button data-t="plugin">Claude 插件</button></div>
          <div id="cp-list"></div>
        </div>`;
      v.querySelectorAll('.cp-tabs button').forEach((b) => (b.onclick = () => { this.tab = b.dataset.t; this.render(); }));
      v.querySelector('#cp-refresh').onclick = () => this.reload(true);
      v.dataset.built = '1';
    }
    this.reload(false);
  },

  async reload(force) {
    this.render(true);
    await caps.load(force);
    this.render();
  },

  render(loading) {
    const box = document.querySelector('#cp-list');
    if (!box) return;
    document.querySelectorAll('.cp-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === this.tab));
    if (loading && !caps.global) {
      box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取服务器上的配置…</span></div>';
      return;
    }
    if (caps.error && !caps.global) {
      box.innerHTML = `<div class="fm-empty err">${esc(caps.error)}</div>`;
      return;
    }
    box.innerHTML = '';
    if (this.tab === 'mcp') this.renderMcp(box);
    else if (this.tab === 'skill') this.renderSkills(box);
    else this.renderPlugins(box);
  },

  renderMcp(box) {
    const bar = el('div', 'cp-bar');
    const add = el('button', 'btn primary', `${icon('plus')}<span>添加 MCP 服务器</span>`);
    add.onclick = () => this.addMcp();
    const check = el('button', 'btn', `${icon('refresh')}<span>检测连接</span>`);
    check.onclick = async () => {
      check.disabled = true;
      check.innerHTML = '<span class="spin"></span><span>检测中…</span>';
      const r = await api.capsMcpStatus();
      caps.status = r.ok ? r.status : null;
      if (!r.ok) toast(r.message, 5000);
      this.render();
    };
    bar.append(add, check);
    box.appendChild(bar);
    const list = (caps.global && caps.global.mcp) || [];
    if (!list.length) {
      box.appendChild(el('div', 'fm-empty', '还没有 MCP 服务器。MCP 能让 Claude 连接外部工具和数据，比如数据库、网页搜索、公司内部系统'));
      return;
    }
    for (const m of list) {
      const st = caps.status && caps.status[m.name];
      const c = el('div', 'pl-card');
      const envKeys = Object.keys((m.config && (m.config.env || m.config.headers)) || {});
      c.innerHTML = `
        <div class="pl-ico">${icon('plug')}</div>
        <div class="pl-main">
          <div class="pl-name">${esc(m.name)} <span class="pl-ver">${esc(SCOPE_LABEL[m.scope] || m.scope)}</span>
            ${st ? `<span class="cp-st ${st.ok ? 'ok' : 'bad'}">${st.ok ? '已连接' : esc(st.text || '连接失败')}</span>` : ''}</div>
          <div class="pl-desc mono">${esc(mcpSummary(m.config))}</div>
          ${envKeys.length ? `<div class="pl-exts">${envKeys.map((k) => `<span class="pl-ext">${esc(k)}=••••</span>`).join('')}</div>` : ''}
        </div>
        <div class="pl-act"></div>`;
      if (m.scope === 'user' || m.scope === 'local') {
        const del = el('button', 'btn', '删除');
        del.onclick = async () => {
          if (!(await confirmModal('删除 MCP 服务器', `删除「${m.name}」后，所有对话都不能再用它。`, '删除'))) return;
          const r = await api.capsMcpRemove(m.name, m.scope);
          if (!r.ok) return toast(r.message, 5000);
          toast('已删除');
          this.reload(true);
        };
        c.querySelector('.pl-act').appendChild(del);
      }
      box.appendChild(c);
    }
  },

  renderSkills(box) {
    const bar = el('div', 'cp-bar');
    const add = el('button', 'btn primary', `${icon('plus')}<span>添加 Skill</span>`);
    add.onclick = async () => {
      const r = await api.capsSkillAdd();
      if (r.canceled) return;
      if (!r.ok) return toast(r.message, 5000);
      toast(`已添加 Skill：${r.name}`);
      this.reload(true);
    };
    bar.append(add, el('span', 'cp-hint', '选择一个含有 SKILL.md 的文件夹，或者单个 SKILL.md 文件'));
    box.appendChild(bar);
    const skills = caps.allSkills();
    if (!skills.length) {
      box.appendChild(el('div', 'fm-empty', '还没有 Skill。发一条消息后，这里会显示 Claude Code 自带的 Skill'));
      return;
    }
    for (const s of skills) {
      const c = el('div', 'pl-card');
      c.innerHTML = `
        <div class="pl-ico">${icon('spark')}</div>
        <div class="pl-main">
          <div class="pl-name">${esc(s.name)} <span class="pl-ver">${s.builtin ? '内置' : '自己添加'}</span></div>
          <div class="pl-desc">${esc(s.description || (s.builtin ? 'Claude Code 自带' : ''))}</div>
        </div>
        <div class="pl-act"></div>`;
      if (!s.builtin) {
        const del = el('button', 'btn', '删除');
        del.onclick = async () => {
          if (!(await confirmModal('删除 Skill', `删除「${s.name}」后，所有对话都不能再用它。`, '删除'))) return;
          const r = await api.capsSkillRemove(s.dir);
          if (!r.ok) return toast(r.message, 5000);
          toast('已删除');
          this.reload(true);
        };
        c.querySelector('.pl-act').appendChild(del);
      }
      box.appendChild(c);
    }
  },

  renderPlugins(box) {
    const installed = (caps.global && caps.global.plugins) || [];
    const loaded = data.ui.lastPlugins || [];
    const all = [...new Set([...installed, ...loaded])];
    box.appendChild(el('div', 'cp-hint block', 'Claude Code 插件可以一次带来多个命令、Skill 和 MCP，目前在服务器上用 claude plugin 命令安装。这里列出已安装和最近一次对话实际加载的插件。'));
    if (!all.length) {
      box.appendChild(el('div', 'fm-empty', '没有安装 Claude Code 插件'));
      return;
    }
    for (const p of all) {
      const c = el('div', 'pl-card');
      c.innerHTML = `<div class="pl-ico">${icon('puzzle')}</div><div class="pl-main"><div class="pl-name">${esc(p)}</div>
        <div class="pl-desc">${loaded.includes(p) ? '最近一次对话已加载' : '已安装'}</div></div>`;
      box.appendChild(c);
    }
  },

  addMcp() {
    const body = el('div');
    body.innerHTML = `
      <div class="field"><label>名称</label><input id="mc-name" placeholder="例如 search" /></div>
      <div class="seg" id="mc-type"><button data-t="stdio" class="on">命令行程序</button><button data-t="http">网址（HTTP）</button><button data-t="sse">网址（SSE）</button></div>
      <div id="mc-stdio">
        <div class="field"><label>启动命令</label><input id="mc-cmd" placeholder="例如 npx -y @modelcontextprotocol/server-filesystem /home/claude/workspace" /></div>
        <div class="field"><label>环境变量（可选，每行一个 KEY=VALUE）</label><textarea id="mc-env" rows="3"></textarea></div>
      </div>
      <div id="mc-http" class="hidden">
        <div class="field"><label>地址</label><input id="mc-url" placeholder="https://example.com/mcp" /></div>
        <div class="field"><label>请求头（可选，每行一个 Key: Value）</label><textarea id="mc-headers" rows="3"></textarea></div>
      </div>
      <div class="help">会以全局范围添加到服务器上的 Claude Code，所有对话默认都能用。</div>`;
    let type = 'stdio';
    body.querySelectorAll('#mc-type button').forEach((b) => (b.onclick = () => {
      type = b.dataset.t;
      body.querySelectorAll('#mc-type button').forEach((x) => x.classList.toggle('on', x === b));
      body.querySelector('#mc-stdio').classList.toggle('hidden', type !== 'stdio');
      body.querySelector('#mc-http').classList.toggle('hidden', type === 'stdio');
    }));
    const lines = (id) => body.querySelector(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    modal({
      title: '添加 MCP 服务器',
      body,
      buttons: [
        { text: '取消', value: null },
        { text: '添加', cls: 'primary', onClick: async () => {
          const spec = { name: body.querySelector('#mc-name').value.trim(), transport: type };
          if (type === 'stdio') {
            const parts = (body.querySelector('#mc-cmd').value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^["']|["']$/g, ''));
            spec.command = parts[0];
            spec.args = parts.slice(1);
            spec.env = Object.fromEntries(lines('#mc-env').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]).filter(([k]) => k));
          } else {
            spec.url = body.querySelector('#mc-url').value.trim();
            spec.headers = Object.fromEntries(lines('#mc-headers').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]).filter(([k]) => k));
          }
          const r = await api.capsMcpAdd(spec);
          if (!r.ok) { toast(r.message, 6000); return undefined; }
          toast(`已添加 ${spec.name}`);
          this.reload(true);
          return true;
        } },
      ],
    });
  },
};

// ---------- 会话里的「能力」面板 ----------
function sessionCaps() {
  const s = findSession(currentId);
  if (s) return (s.caps = s.caps || { mcpOff: [], skillsOff: [] });
  return (newChatCaps = newChatCaps || { mcpOff: [], skillsOff: [] });
}

function renderCapsButton() {
  const b = document.querySelector('#btn-caps');
  if (!b) return;
  const s = findSession(currentId);
  const c = s ? s.caps : newChatCaps;
  const off = c ? c.mcpOff.length + c.skillsOff.length : 0;
  b.classList.toggle('dot', off > 0);
  b.title = off ? `这个对话关掉了 ${off} 项 MCP / Skill` : '这个对话可以用的 MCP 和 Skill';
}

async function openCapsPanel() {
  const old = document.querySelector('.caps-pop');
  if (old) return old.remove();
  const pop = el('div', 'caps-pop');
  pop.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>读取中…</span></div>';
  document.body.appendChild(pop);
  const btn = document.querySelector('#btn-caps').getBoundingClientRect();
  pop.style.left = Math.max(8, btn.left - 8) + 'px';
  pop.style.bottom = window.innerHeight - btn.top + 8 + 'px';
  setTimeout(() => document.addEventListener('mousedown', function close(e) {
    if (!pop.contains(e.target) && !e.target.closest('#btn-caps')) { pop.remove(); document.removeEventListener('mousedown', close); }
  }), 0);

  await caps.load(false);
  if (!pop.isConnected) return;
  const s = findSession(currentId);
  const init = s && s.lastInit;
  const sc = sessionCaps();
  const mcps = (caps.global && caps.global.mcp) || [];
  const skills = caps.allSkills();
  const stOf = (name) => {
    const m = init && init.mcp.find((x) => x.name === name);
    return m ? m.status : null;
  };
  const row = (kind, name, desc, off, status) => `
    <label class="cp-row"><input type="checkbox" data-kind="${kind}" data-name="${esc(name)}" ${off ? '' : 'checked'} />
      <span class="cp-name">${esc(name)}</span>
      ${status ? `<span class="cp-st ${status === 'connected' ? 'ok' : status === 'pending' ? '' : 'bad'}">${status === 'connected' ? '已连接' : status === 'pending' ? '连接中' : '未连接'}</span>` : ''}
      <span class="cp-desc">${esc(desc || '')}</span></label>`;
  pop.innerHTML = `
    <div class="cp-pop-head">这个对话可以用的能力</div>
    <div class="cp-sec">MCP 服务器</div>
    ${mcps.length ? mcps.map((m) => row('mcp', m.name, mcpSummary(m.config), sc.mcpOff.includes(m.name), stOf(m.name))).join('') : '<div class="cp-none">服务器上还没有 MCP 服务器</div>'}
    <div class="cp-sec">Skill</div>
    ${skills.length ? skills.map((k) => row('skill', k.name, k.builtin ? '内置' : k.description, sc.skillsOff.includes(k.name))).join('') : '<div class="cp-none">发一条消息后会显示可用的 Skill</div>'}
    <div class="cp-pop-foot"><span>勾选的从下一条消息开始生效</span><a href="#" id="cp-manage">管理全局 MCP 与 Skill</a></div>
    ${caps.error ? `<div class="err-box">${esc(caps.error)}</div>` : ''}
    ${init ? `<div class="cp-meta">上次运行加载了 ${init.mcp.length} 个 MCP、${init.skills.length} 个 Skill、${init.tools} 个工具</div>` : ''}`;
  pop.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.onchange = () => {
    const list = cb.dataset.kind === 'mcp' ? sc.mcpOff : sc.skillsOff;
    const n = cb.dataset.name;
    const i = list.indexOf(n);
    if (cb.checked && i >= 0) list.splice(i, 1);
    if (!cb.checked && i < 0) list.push(n);
    save();
    renderCapsButton();
  }));
  pop.querySelector('#cp-manage').onclick = (e) => { e.preventDefault(); pop.remove(); openSettings('caps'); };
}

document.querySelector('#btn-caps').onclick = openCapsPanel;
