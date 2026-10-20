/* global api, el, esc, icon, toast, modal, confirmModal, data, save, findSession, currentId, showView, newChatCaps, showMenu, openSettings, renderMarkdown, fmtSize */
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
  q: {}, // 每个页自己的搜索词

  // 顶栏右边的搜索框：按名称和说明实时过滤下面的卡片（不重画，输入不丢焦点）
  addSearch(bar, box, placeholder) {
    const inp = el('input', 'cp-filter');
    inp.type = 'search';
    inp.placeholder = placeholder;
    inp.value = this.q[this.tab] || '';
    const tab = this.tab;
    const apply = () => {
      const q = inp.value.trim().toLowerCase();
      this.q[tab] = inp.value;
      let shown = 0;
      box.querySelectorAll('.pl-card').forEach((c) => { const hit = !q || (c.dataset.k || c.textContent.toLowerCase()).includes(q); c.hidden = !hit; if (hit) shown++; });
      let none = box.querySelector('.cp-nomatch');
      if (q && !shown) { if (!none) { none = el('div', 'fm-empty cp-nomatch'); box.appendChild(none); } none.textContent = `没有找到「${inp.value.trim()}」`; }
      else if (none) none.remove();
    };
    inp.oninput = apply;
    bar.appendChild(inp);
    setTimeout(apply, 0);
    return inp;
  },

  async open() {
    const v = document.querySelector('#view-caps');
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="pl-wrap">
          <div class="pl-head">
            <div><h2>MCP、Skill 与插件</h2><p class="wsub">这里是服务器上为 Claude 装好的扩展能力。每个对话默认都能用；想在某个对话里关掉一部分，点输入框旁边的「能力」。</p></div>
            <button class="icon-btn" id="cp-refresh" title="刷新">${icon('refresh')}</button>
          </div>
          <div class="seg pl-tabs cp-tabs"><button data-t="mcp">MCP 服务器</button><button data-t="skill">Skill</button><button data-t="plugin">Claude 插件</button></div>
          <div id="cp-list"></div>
        </div>`;
      v.querySelectorAll('.cp-tabs button').forEach((b) => (b.onclick = () => { this.tab = b.dataset.t; this.render(); }));
      v.querySelector('#cp-refresh').onclick = () => { this.cplug = null; this.reload(true); };
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
    this.addSearch(bar, box, '搜索 MCP 服务器');
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
    bar.appendChild(add);
    box.appendChild(bar);
    this.addSearch(bar, box, '搜索 Skill');
    box.appendChild(el('div', 'cp-hint block', '添加：选择一个含有 SKILL.md 的文件夹，或者单个 SKILL.md 文件'));
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
      c.classList.add('clickable');
      c.title = '点击查看完整内容';
      c.onclick = (e) => { if (!e.target.closest('button')) this.showDetail('skill', s); };
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

  // Claude Code 插件：读 claude plugin list --json，能安装、更新、启用 / 停用、卸载（和终端里的 /plugin 一样）
  cplug: null,
  async loadPlugins(force) {
    if (this.cplug && !force) return;
    this.cplug = { loading: true };
    const r = await api.claudePlugins();
    this.cplug = r.ok ? { installed: r.installed } : { error: r.message };
    if (this.tab === 'plugin') this.render();
  },

  renderPlugins(box) {
    if (!this.cplug) { this.loadPlugins(); box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取 Claude 插件…</span></div>'; return; }
    if (this.cplug.loading) { box.innerHTML = '<div class="fm-empty"><span class="spin"></span><span>正在读取 Claude 插件…</span></div>'; return; }
    // 和 MCP、Skill 两页一样的顶栏：左边安装按钮、右边搜索；说明放到下面一行
    const bar = el('div', 'cp-bar');
    const add = el('button', 'btn primary', `${icon('plus')}<span>安装插件…</span>`);
    add.onclick = () => this.installDialog();
    bar.appendChild(add);
    box.appendChild(bar);
    this.addSearch(bar, box, '搜索插件');
    box.appendChild(el('div', 'cp-hint block', 'Claude Code 插件可以一次带来多个命令、Skill、钩子和 MCP。装好、启用或停用后，从下一条消息开始生效。'));
    if (this.cplug.error) { box.appendChild(el('div', 'err-box', `${icon('alert')}<span>${esc(this.cplug.error)}</span>`)); return; }
    const list = this.cplug.installed || [];
    if (!list.length) { box.appendChild(el('div', 'fm-empty', '还没有安装 Claude Code 插件')); return; }
    const loaded = data.ui.lastPlugins || [];
    for (const p of list) {
      const [name, market] = String(p.id).split('@');
      const scope = p.scope === 'user' ? '所有项目' : `只在 ${p.projectPath || '某个项目'}`;
      const c = el('div', 'pl-card' + (p.enabled ? '' : ' off'));
      c.innerHTML = `<div class="pl-ico">${icon('puzzle')}</div><div class="pl-main">
        <div class="pl-name">${esc(name)}${p.version && p.version !== 'unknown' ? `<span class="pl-ver">${esc(p.version)}</span>` : ''}${p.enabled ? '' : '<span class="pl-tag">已停用</span>'}${loaded.includes(name) ? '<span class="pl-tag on">上一条对话已加载</span>' : ''}</div>
        <div class="pl-desc">${esc(market ? '来自 ' + market : '')} · ${esc(scope)}</div></div><div class="pl-act"></div>`;
      const act = c.querySelector('.pl-act');
      const btn = (label, action, cls) => {
        const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
        b.onclick = () => this.pluginAction(action, p, b);
        act.appendChild(b);
      };
      c.classList.add('clickable');
      c.title = '点击查看它带来的命令、Skill、子助手、钩子和 MCP';
      c.onclick = (e) => { if (!e.target.closest('button')) this.showDetail('plugin', p); };
      btn(p.enabled ? '停用' : '启用', p.enabled ? 'disable' : 'enable');
      btn('更新', 'update');
      btn('卸载', 'uninstall', 'danger-text');
      box.appendChild(c);
    }
  },

  // 点开一个 Skill / 插件：看它的完整说明和里面带了什么（内容从服务器上读，只读）
  async showDetail(kind, x) {
    const name = kind === 'skill' ? x.name : String(x.id).split('@')[0];
    const body = el('div', 'cd-body', '<div class="fm-empty"><span class="spin"></span><span>正在读取…</span></div>');
    modal({ title: name, body, wide: 'xl', buttons: [{ text: '关闭', value: null }] });
    if (kind === 'skill' && x.builtin) {
      body.innerHTML = `<p class="cd-desc">${esc(x.description || 'Claude Code 自带的 Skill')}</p><p class="help">这是 Claude Code 自带的，内容在 Claude Code 程序里，没有单独的文件可以查看。</p>`;
      return;
    }
    const r = await api.capsDetail({ kind, name: kind === 'skill' ? x.dir : x.id });
    if (!body.isConnected) return;
    if (!r.ok) { body.innerHTML = `<div class="err-box">${icon('alert')}<span>${esc(r.message)}</span></div>`; return; }
    body.innerHTML = '';
    const sec = (title, n) => body.appendChild(el('div', 'cd-sec', `${esc(title)}${n != null ? `<span class="cd-n">${n}</span>` : ''}`));
    const list = (rows) => {
      const box = el('div', 'cd-list');
      rows.forEach(([t, d]) => box.appendChild(el('div', 'cd-row', `<b>${esc(t)}</b>${d ? `<span>${esc(d)}</span>` : ''}`)));
      body.appendChild(box);
    };
    const fold = (title, node, open) => {
      const d = el('details', 'cd-fold');
      if (open) d.open = true;
      d.appendChild(el('summary', '', esc(title)));
      d.appendChild(node);
      body.appendChild(d);
    };
    const filesNode = (files) => {
      const box = el('div', 'cd-files');
      files.forEach((f) => box.appendChild(el('div', 'cd-file', `<span>${esc(f.rel)}</span><span>${typeof fmtSize === 'function' ? fmtSize(f.size) : f.size}</span>`)));
      if (files.length >= 200) box.appendChild(el('div', 'help', '只列出前 200 个文件'));
      return box;
    };
    if (r.description) body.appendChild(el('p', 'cd-desc', esc(r.description)));
    if (kind === 'plugin') {
      const meta = [r.version && r.version !== 'unknown' ? '版本 ' + r.version : '', r.author ? '作者 ' + r.author : '', String(x.id).includes('@') ? '来自 ' + String(x.id).split('@')[1] : '', x.scope === 'user' ? '所有项目' : x.projectPath ? '只在 ' + x.projectPath : ''].filter(Boolean);
      if (meta.length) body.appendChild(el('div', 'cd-meta', esc(meta.join(' · '))));
      const groups = [
        ['命令', r.commands.map((c) => [c.name, c.description])],
        ['Skill', r.skills.map((c) => [c.name, c.description])],
        ['子助手', r.agents.map((c) => [c.name, c.description])],
        ['钩子', r.hooks.map((h) => [h, ''])],
        ['MCP 服务器', r.mcp.map((h) => [h, ''])],
        ['语言服务', r.lsp.map((h) => [h, ''])],
        ['可以配置的选项', (r.options || []).map((o) => [o.title, [o.description, o.default != null ? '默认 ' + o.default : ''].filter(Boolean).join(' · ')])],
      ].filter(([, rows]) => rows.length);
      if (!groups.length) body.appendChild(el('p', 'help', '这个插件没有带命令、Skill、子助手、钩子或 MCP，可能只提供文档或在别处生效。'));
      for (const [t, rows] of groups) { sec(t, rows.length); list(rows); }
      if (r.readme) fold('说明文档（README）', renderMarkdown(r.readme), !groups.length);
    } else if (r.body) {
      fold('完整内容（SKILL.md）', renderMarkdown(r.body), true);
    }
    if (r.files && r.files.length) fold(`包含的文件（${r.files.length >= 200 ? '200+' : r.files.length}）`, filesNode(r.files), false);
    if (r.path) body.appendChild(el('div', 'cd-path', esc(r.path)));
  },

  async pluginAction(action, p, b) {
    const name = String(p.id).split('@')[0];
    if (action === 'uninstall' && !(await confirmModal('卸载插件', `卸载「${name}」后，它带来的命令、Skill 和 MCP 都不能用了，之后可以重新安装。`, '卸载'))) return;
    const label = { enable: '启用', disable: '停用', uninstall: '卸载', update: '更新', install: '安装' }[action];
    if (b) {
      // 按钮保持原来的宽度，显示「转圈 + 更新中…」；同一行其他按钮先禁用，免得连点
      b.style.minWidth = b.offsetWidth + 'px';
      b.classList.add('busy');
      b.innerHTML = `<span class="spin"></span><span>${label}中…</span>`;
      const act = b.closest('.pl-act');
      (act ? act.querySelectorAll('button') : [b]).forEach((x) => { x.disabled = true; });
    }
    const r = await api.claudePluginAction({ action, id: p.id || p.pluginId, scope: p.scope, projectPath: p.projectPath });
    if (!r.ok) toast(`${label}失败：${r.message}`, 6000);
    else toast(`已${label}「${name}」，从下一条消息开始生效`, 4000);
    await this.loadPlugins(true);
    if (typeof caps !== 'undefined') caps.load(true).catch(() => {});
    return r.ok;
  },

  async installDialog() {
    const body = el('div', 'cp-install');
    body.innerHTML = '<input class="cp-search" placeholder="搜索插件名称或用途" /><div class="cp-avail"><div class="fm-empty"><span class="spin"></span><span>正在读取插件市场…</span></div></div>';
    const listBox = body.querySelector('.cp-avail');
    const search = body.querySelector('.cp-search');
    const done = modal({ title: '安装 Claude 插件', body, wide: true, buttons: [{ text: '关闭', value: null }] });
    const r = await api.claudePlugins({ available: true });
    if (!r.ok) { listBox.innerHTML = `<div class="err-box">${icon('alert')}<span>${esc(r.message)}</span></div>`; return; }
    const installed = new Set((r.installed || []).map((x) => x.id));
    const avail = (r.available || []).filter((x) => !installed.has(x.pluginId));
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const items = avail.filter((x) => !q || `${x.name} ${x.description || ''}`.toLowerCase().includes(q)).slice(0, 60);
      listBox.innerHTML = '';
      if (!items.length) { listBox.appendChild(el('div', 'fm-empty', avail.length ? '没有匹配的插件' : '插件市场里没有可安装的插件（可以先在服务器上用 claude plugin marketplace add 添加市场）')); return; }
      for (const x of items) {
        const c = el('div', 'pl-card');
        c.innerHTML = `<div class="pl-ico">${icon('puzzle')}</div><div class="pl-main"><div class="pl-name">${esc(x.name)}${x.installCount ? `<span class="pl-ver">${Number(x.installCount).toLocaleString()} 次安装</span>` : ''}</div>
          <div class="pl-desc cp-desc">${esc((x.description || '').slice(0, 160))}</div><div class="pl-desc">来自 ${esc(x.marketplaceName || '')}</div></div><div class="pl-act"></div>`;
        const b = el('button', 'btn primary', '安装');
        b.onclick = async () => {
          const ok = await this.pluginAction('install', { id: x.pluginId, scope: 'user' }, b);
          b.classList.remove('busy');
          b.textContent = ok ? '已安装' : '安装';
          b.disabled = ok;
        };
        c.querySelector('.pl-act').appendChild(b);
        listBox.appendChild(c);
      }
    };
    search.oninput = draw;
    draw();
    search.focus();
    await done;
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

// 每一行：勾选 = 这个对话用不用；「⋯」里是它本身的操作（MCP 重新连接 / 删除、Skill 删除、插件启用停用更新卸载）
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
    if (!pop.isConnected) return document.removeEventListener('mousedown', close);
    // 点「⋯」弹出的菜单、确认框时不要关掉面板
    if (!pop.contains(e.target) && !e.target.closest('#btn-caps, #menu, .overlay')) { pop.remove(); document.removeEventListener('mousedown', close); }
  }), 0);
  await caps.load(false);
  if (pop.isConnected) drawCapsPanel(pop);
  // 插件列表要跑一次 claude plugin list，单独异步读
  if (!capsView.cplug || capsView.cplug.error) await capsView.loadPlugins(true);
  if (pop.isConnected) drawCapsPanel(pop);
}

function drawCapsPanel(pop) {
  const s = findSession(currentId);
  const init = s && s.lastInit;
  const sc = sessionCaps();
  const mcps = (caps.global && caps.global.mcp) || [];
  const skills = caps.allSkills();
  const plugins = (capsView.cplug && capsView.cplug.installed) || null;
  const mcpState = (name) => {
    const st = caps.status && caps.status[name];
    if (st) return st.ok ? ['ok', '已连接'] : ['bad', '连接失败' + (st.text ? '：' + st.text : '')];
    const m = init && init.mcp.find((x) => x.name === name);
    if (!m) return null;
    return m.status === 'connected' ? ['ok', '已连接'] : m.status === 'pending' ? ['', '连接中'] : ['bad', '未连接'];
  };
  const keep = pop.scrollTop;
  pop.innerHTML = '<div class="cp-pop-head">这个对话可以用的能力</div>';
  const section = (title) => pop.appendChild(el('div', 'cp-sec', esc(title)));
  const row = ({ kind, name, desc, off, state, tag, menu }) => {
    const r = el('div', 'cp-row' + (tag === '已停用' ? ' off' : ''));
    const label = el('label', 'cp-main');
    if (kind) {
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !off;
      cb.onchange = () => {
        const list = kind === 'mcp' ? sc.mcpOff : sc.skillsOff;
        const k = list.indexOf(name);
        if (cb.checked && k >= 0) list.splice(k, 1);
        if (!cb.checked && k < 0) list.push(name);
        save();
        renderCapsButton();
      };
      label.appendChild(cb);
    }
    const body = el('span', 'cp-body');
    const top = el('span', 'cp-top');
    top.appendChild(el('span', 'cp-name', esc(name)));
    if (state) top.appendChild(el('span', 'cp-st ' + state[0], esc(state[1])));
    if (tag) top.appendChild(el('span', 'pl-tag', esc(tag)));
    body.appendChild(top);
    if (desc) {
      const d = el('span', 'cp-desc' + (kind === 'mcp' ? ' mono' : ''), esc(desc));
      d.title = desc;
      body.appendChild(d);
    }
    label.appendChild(body);
    r.appendChild(label);
    if (menu && menu.length) {
      const more = el('button', 'mini-btn cp-more', icon('more'));
      more.title = '更多操作';
      more.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showMenu(menu, e); };
      r.appendChild(more);
    }
    pop.appendChild(r);
  };

  section('MCP 服务器');
  if (!mcps.length) pop.appendChild(el('div', 'cp-none', '服务器上还没有 MCP 服务器'));
  for (const m of mcps) {
    row({ kind: 'mcp', name: m.name, desc: mcpSummary(m.config), off: sc.mcpOff.includes(m.name), state: mcpState(m.name), menu: [
      { text: '重新连接', icon: 'refresh', onClick: async () => {
        toast(`正在重新连接 ${m.name}…`);
        const r = await api.capsMcpStatus();
        if (!r.ok) return toast('检测失败：' + r.message, 5000);
        caps.status = r.status;
        const st = r.status[m.name];
        toast(st ? (st.ok ? `${m.name} 已连接` : `${m.name} 连接失败：${st.text || ''}`) : `${m.name} 没有返回状态`, 5000);
        if (pop.isConnected) drawCapsPanel(pop);
      } },
      { text: '在设置里管理', icon: 'gear', onClick: () => { pop.remove(); capsView.tab = 'mcp'; openSettings('caps'); } },
      '-',
      { text: '删除', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmModal('删除 MCP 服务器', `删除「${m.name}」后，所有对话都不能再用它。`, '删除'))) return;
        const r = await api.capsMcpRemove(m.name, m.scope);
        if (!r.ok) return toast(r.message, 5000);
        toast(`已删除 ${m.name}`);
        await caps.load(true);
        if (pop.isConnected) drawCapsPanel(pop);
      } },
    ] });
  }

  section('Skill');
  if (!skills.length) pop.appendChild(el('div', 'cp-none', '发一条消息后会显示可用的 Skill'));
  for (const k of skills) {
    const menu = k.builtin || !k.dir ? [] : [
      { text: '删除', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmModal('删除 Skill', `删除「${k.name}」后，所有对话都不能再用它。`, '删除'))) return;
        const r = await api.capsSkillRemove(k.dir);
        if (!r.ok) return toast(r.message, 5000);
        toast(`已删除 ${k.name}`);
        await caps.load(true);
        if (pop.isConnected) drawCapsPanel(pop);
      } },
    ];
    row({ kind: 'skill', name: k.name, desc: k.builtin ? '内置' : k.description, off: sc.skillsOff.includes(k.name), menu });
  }

  section('Claude 插件（所有对话通用）');
  if (!plugins) pop.appendChild(el('div', 'cp-none', capsView.cplug && capsView.cplug.error ? capsView.cplug.error : '正在读取…'));
  else if (!plugins.length) pop.appendChild(el('div', 'cp-none', '还没有安装 Claude 插件，输入 /plugin 可以安装'));
  else {
    for (const pl of plugins) {
      const [name, market] = String(pl.id).split('@');
      const act = (action) => async () => {
        await capsView.pluginAction(action, pl);
        if (pop.isConnected) drawCapsPanel(pop);
      };
      row({ name, desc: market ? '来自 ' + market : '', tag: pl.enabled ? '' : '已停用', menu: [
        pl.enabled ? { text: '停用', onClick: act('disable') } : { text: '启用', onClick: act('enable') },
        { text: '更新', icon: 'refresh', onClick: act('update') },
        '-',
        { text: '卸载', icon: 'trash', danger: true, onClick: act('uninstall') },
      ] });
    }
  }

  const foot = el('div', 'cp-pop-foot', '<span>勾选的从下一条消息开始生效</span><a href="#">管理全局 MCP、Skill 与插件</a>');
  foot.querySelector('a').onclick = (e) => { e.preventDefault(); pop.remove(); openSettings('caps'); };
  pop.appendChild(foot);
  if (caps.error) pop.appendChild(el('div', 'err-box', esc(caps.error)));
  if (init) pop.appendChild(el('div', 'cp-meta', `上次运行加载了 ${init.mcp.length} 个 MCP、${init.skills.length} 个 Skill、${init.tools} 个工具`));
  pop.scrollTop = keep;
}

document.querySelector('#btn-caps').onclick = openCapsPanel;

// /plugin：打开设置里的 Claude 插件页
function openClaudePlugins() {
  capsView.tab = 'plugin';
  capsView.cplug = null;
  openSettings('caps');
}
