/* global live, el, esc, icon, data, save, curServer, openSession, renderSidebar, renderAll, openSettings, closeModal, historyView, showView, currentId, uid */
'use strict';

// 第一次用的人的功能介绍：一步一步高亮要点的地方，旁边一个说明气泡。
// 五部分：服务器上的会话（演示数据）· 公司 VPN（只给连远程服务器的人）· 拓展功能和文件预览 · 飞书通知 · 手机远程控制和用量统计。
// 用到的演示会话、演示的服务器会话列表都打上 demo 标记，介绍结束（或中途跳过、软件被关掉后下次启动）都会清掉，不碰真实数据。
const tour = {
  active: false,
  busy: false,
  seq: 0,
  i: 0,
  steps: [],
  prevSession: null,

  // ---------- 演示数据 ----------
  demoHistory() {
    const now = Date.now();
    const H = (h) => now - h * 3600e3;
    const items = [
      { id: 'demo-h1', title: '整理第三季度销售数据，出一份汇总表', first: '把 data 文件夹里三个月的销售表合并，按区域汇总', cwd: '~/workspace/sales-report', mtime: H(3), prompts: 6, replies: 6 },
      { id: 'demo-h2', title: '官网首页改版', first: '首页的大图换成新的，导航栏加一个「案例」', cwd: '~/workspace/website', mtime: H(20), prompts: 14, replies: 14 },
      { id: 'demo-h3', title: '修复登录页在手机上错位', first: '手机打开登录页，输入框跑到屏幕外面去了', cwd: '~/workspace/website', mtime: H(46), prompts: 5, replies: 5 },
      { id: 'demo-h4', title: '写一份新员工入职手册', first: '根据这几份制度文件，整理一份入职手册（Word）', cwd: '~/workspace/docs', mtime: H(80), prompts: 9, replies: 9 },
    ];
    const folders = [['~/workspace/website', 2], ['~/workspace/sales-report', 1], ['~/workspace/docs', 1]];
    const load = (id) => {
      const x = items.find((y) => y.id === id) || items[0];
      return {
        ok: true, id: x.id, title: x.title, cwd: x.cwd, mtime: x.mtime,
        messages: [
          { role: 'user', text: x.first, files: [], ts: x.mtime - 600e3 },
          { role: 'assistant', ts: x.mtime - 590e3, doneAt: x.mtime - 300e3, blocks: [
            { type: 'tool', id: 'd1', name: 'Bash', input: { command: 'ls data', description: '看看有哪些文件' }, status: 'ok', preview: '7月.xlsx\n8月.xlsx\n9月.xlsx' },
            { type: 'text', text: '这是演示用的会话内容。真实的会话导入后，在终端里和 Claude Code 聊过的每一条、每一步操作都会完整显示在这里，**还能接着聊**。' },
          ] },
        ],
      };
    };
    return { items, folders, load };
  },

  demoSession() {
    const now = Date.now();
    const s = {
      id: 'demo-' + uid(), demo: true, title: '示例：第三季度销售汇总', serverId: data.currentServer || null, groupId: null,
      createdAt: now, updatedAt: now, started: true, claudeId: 'demo-preview',
      messages: [
        { role: 'user', text: '把三个月的销售表合并，按区域汇总成一张表，再出一页 PPT 给老板看', files: [], ts: now - 300e3 },
        { role: 'assistant', ts: now - 290e3, doneAt: now - 120e3, blocks: [
          { type: 'tool', id: 'p1', name: 'Bash', input: { command: 'python3 merge.py', description: '合并三个月的表格' }, status: 'ok', preview: '已合并 3 个文件，共 1,284 行' },
          { type: 'text', text: '汇总表和 PPT 都做好了，在下面「本轮生成的文件」里。点文件名下载，点旁边的**眼睛**直接预览。\n\n（这是演示会话，文件并不存在，介绍结束后会自动删掉。）' },
        ],
        outputs: [
          { rel: '第三季度销售汇总.xlsx', path: '~/workspace/sales-report/第三季度销售汇总.xlsx', size: 48213, mtime: now - 130e3 },
          { rel: '汇报.pptx', path: '~/workspace/sales-report/汇报.pptx', size: 1254400, mtime: now - 125e3 },
          { rel: '销售说明.pdf', path: '~/workspace/sales-report/销售说明.pdf', size: 352100, mtime: now - 122e3 },
        ] },
      ],
    };
    data.sessions.push(s);
    return s;
  },

  // 清掉所有演示数据（介绍结束、跳过、或者上次没走完就关了软件）
  cleanup() {
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((s) => !s.demo);
    if (historyView.demo) { historyView.demo = null; historyView.items = null; }
    if (data.sessions.length !== before) {
      save();
      if (currentId && !data.sessions.find((s) => s.id === currentId)) {
        if (this.prevSession && data.sessions.find((s) => s.id === this.prevSession)) openSession(this.prevSession);
        else if (typeof startNewChat === 'function') startNewChat(); // eslint-disable-line no-undef
      }
      renderSidebar();
    }
  },

  // ---------- 小工具 ----------
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
  async until(fn, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await this.wait(80); }
    return null;
  },
  async settingsTab(t) {
    if (!document.querySelector('.overlay .st-wrap')) { openSettings(t); await this.until(() => document.querySelector('.overlay .st-wrap')); }
    const b = await this.until(() => document.querySelector(`.st-tabs button[data-t="${t}"]`));
    if (b && !b.classList.contains('on')) b.click();
    await this.wait(250);
  },
  // 「上一步」退回时把界面恢复成那一步需要的样子（会话列表开着、菜单弹着、设置开着等）
  async historyOpen(allFolders) {
    this.closeSettings();
    if (typeof hideMenu === 'function') hideMenu();
    if (document.body.dataset.view !== 'history') showView('history');
    if (allFolders && historyView.folder) historyView.setFolder('');
    await this.until(() => document.querySelector('.hi-card') && document.querySelector('#hi-folder').getClientRects().length);
  },
  async folderMenu() {
    await this.historyOpen(true);
    document.querySelector('#hi-folder').click();
    await this.until(() => document.querySelector('#menu:not(.hidden) button'));
  },
  async settingsOpen() {
    if (!document.querySelector('.overlay .st-wrap')) { openSettings(); await this.until(() => document.querySelector('.overlay .st-wrap')); }
  },
  chatView() {
    this.closeSettings();
    if (typeof hideMenu === 'function') hideMenu();
    if (typeof showView === 'function') showView('chat');
  },
  closeSettings() {
    const w = document.querySelector('.overlay .st-wrap');
    if (w) closeModal(w);
  },

  // ---------- 步骤 ----------
  build() {
    // 和设置页一样按当前连接方式判断：本机模式不需要网络设置，跳过 VPN 这部分
    const remote = !!curServer() && (data.settings.mode || '') !== 'local' && curServer().mode !== 'local';
    const S = [];
    // 第一部分：服务器上的会话
    S.push({ part: 1, center: true, title: '欢迎使用 Claude 远程助手', text: '花两三分钟带你看一遍主要功能，分五部分：服务器上的会话、公司 VPN、拓展功能和文件预览、飞书通知、手机远程控制。介绍里用的都是演示数据，看完自动清掉，不会动你的对话。', next: '开始' });
    S.push({ part: 1, target: '#btn-history', title: '服务器上的会话', text: '你在服务器终端里用 Claude Code 聊过的会话，都能在这里找到并导入。点一下打开。', click: true, prep: () => this.chatView(),
      before: () => { historyView.demo = this.demoHistory(); } });
    S.push({ part: 1, target: '#hi-refresh', prep: () => this.historyOpen(true), title: '自动读取，也能手动刷新', text: '打开这一页时会自动读取服务器上的全部会话。刚在终端里聊过新的、列表里还没有时，点这个刷新。', before: () => this.until(() => document.querySelector('.hi-card')) });
    S.push({ part: 1, target: '#hi-folder', title: '按文件夹找', text: '会话多了，可以只看某个项目文件夹里的。点这里选文件夹。', click: true, prep: () => this.historyOpen(true) });
    S.push({ part: 1, target: () => [...document.querySelectorAll('#menu:not(.hidden) button')].find((n) => /website/.test(n.textContent)), title: '选一个文件夹', text: '比如点「website」，只看这个项目里的会话（包括子文件夹）。', click: true, prep: () => this.folderMenu(),
      before: () => this.until(() => document.querySelector('#menu:not(.hidden) button')) });
    S.push({ part: 1, target: () => document.querySelector('.hi-card .pl-act .btn'), title: '导入会话', text: '点「导入」，这个会话就会出现在左边列表里，完整还原所有内容，可以接着聊。', click: true,
      prep: async () => { await this.folderMenu(); const b = [...document.querySelectorAll('#menu:not(.hidden) button')].find((n) => /website/.test(n.textContent)); if (b) b.click(); },
      before: () => this.until(() => document.querySelectorAll('.hi-card').length === 2) });
    S.push({ part: 1, target: '#messages', title: '导入好了', text: '在终端里聊的每一句、Claude 做的每一步都在这里，输入框里直接接着聊就行。', place: 'left', prep: () => this.chatView(),
      before: () => this.until(() => document.querySelector('#messages .msg')) });

    // 第二部分：公司 VPN（只给连远程服务器的人）
    if (remote) {
      S.push({ part: 2, center: true, title: '在公司外面也能连服务器', text: '公司的服务器一般只能在公司网络里访问。离开公司、在家或出差时，可以让软件自己通过公司 VPN 连过去，不用另外开 VPN 客户端。', next: '看看在哪设置' });
      S.push({ part: 2, target: '#st-vpn', title: '公司 VPN', text: '在「设置 → 网络」里打开「通过公司 VPN 连接」，填公司给你的 VPN 地址、选用户组、填自己的账号密码就行（支持 AnyConnect / OpenConnect，如 Cisco AnyConnect、AnyLink、ocserv）。只给这个软件连服务器用，不影响电脑上其他软件，也不用管理员权限；密码用系统钥匙串加密保存。',
        before: () => this.settingsTab('network') });
      S.push({ part: 2, target: () => document.querySelector('#st-proxy') && document.querySelector('#st-proxy').closest('.field'), title: '或者用自己的网络通道', text: '如果你有自建的跳板或代理（比如在家能直连公司的一台机器），在这里填 socks5 或 http 代理地址，软件的连接都会从这里走。两种方式选一种就行。',
        before: () => this.settingsTab('network') });
    }

    // 第三部分：拓展功能和文件预览
    S.push({ part: 3, center: true, title: '拓展功能：不下载也能看文件', text: 'Claude 做出来的 Word、Excel、PPT、PDF，装上对应的拓展后，点一下就能直接在软件里预览。', next: '去看看', before: () => this.closeSettings() });
    S.push({ part: 3, target: '#btn-settings-side', title: '打开设置', text: '点「设置」。', click: true, prep: () => this.chatView() });
    S.push({ part: 3, target: '.st-tabs button[data-t="plugins"]', title: '拓展功能', text: '点左边栏「自定义」下面的「拓展功能」。', click: true, prep: () => this.settingsOpen(), before: () => this.until(() => document.querySelector('.st-tabs')) });
    S.push({ part: 3, target: '#pl-list', prep: () => this.settingsTab('plugins'), title: '按需安装', text: '这里列出能装的拓展：PDF、Word、Excel、PPT、代码高亮等。点「安装」就装好，不用的可以卸载。拓展在隔离环境里运行，不能联网，也碰不到你的数据。', place: 'left',
      before: () => this.until(() => document.querySelector('#pl-list .pl-card, #pl-list > *'), 6000) });
    S.push({ part: 3, target: () => document.querySelector('#messages .outputs'), title: '每轮生成的文件', text: '每次回复结束，Claude 新做出来的文档、表格、PPT、图片都会列在这里：点文件名下载，点旁边的眼睛直接预览，装了拓展的格式也能看。（这是演示会话。）',
      before: async () => { this.closeSettings(); const s = this.demoSession(); openSession(s.id); await this.until(() => document.querySelector('#messages .outputs')); } });

    // 第四部分：飞书通知
    S.push({ part: 4, target: () => document.querySelector('.nt-kind'), title: '回复完成发到飞书', text: '让 Claude 干一件要很久的事，人可以先走开：在「设置 → 通知」选「飞书机器人」，填群机器人的 Webhook 地址，回复完成、出错或者在等你做选择时，飞书里会收到一张卡片。获取方法：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 Webhook 地址。',
      before: () => this.settingsTab('notify') });

    // 第五部分：手机远程控制、安卓 App、用量统计
    S.push({ part: 5, target: () => document.querySelector('.rc-pane'), title: '在手机上用', text: '把一个中转程序装到你自己的服务器上（这一页「第一步」有一键安装说明），电脑连上中转后点「添加手机」，手机扫二维码就配对好了，在手机上就能看回复、发消息、批准计划。内容在手机和电脑两端加密，中转服务器也看不到。', place: 'left',
      before: () => this.settingsTab('remote') });
    S.push({ part: 5, target: () => document.querySelector('.rc-pane'), title: 'iPhone：用 Safari 打开就行', text: 'iPhone 不用装 App：用 Safari 打开你的中转地址（就是这页填的「中转地址」），扫码配对后点分享按钮 →「添加到主屏幕」，就会像 App 一样全屏打开。', place: 'left' });
    S.push({ part: 5, target: () => document.querySelector('#rc-android') || document.querySelector('.rc-pane'), title: '安卓：下载 App', text: '安卓手机可以装 App：点「下载安卓 App」，把安装包发到手机上安装，打开后扫电脑上的二维码配对。也可以和 iPhone 一样直接用浏览器打开中转地址。', place: 'left' });
    S.push({ part: 5, target: () => document.querySelector('.st-tabs button[data-t="stats"]'), title: '用量统计', text: '最后，左边栏最下面的「用量统计」能看到每天、每个会话、每个模型用了多少，以及 5 小时和每周额度的走势。', click: true, before: () => this.settingsTab('remote') });
    S.push({ part: 5, center: true, title: '介绍完了', text: '演示用的会话已经清掉。想再看一遍，在「设置 → 常规」底部点「功能介绍」。', next: '开始用',
      before: () => this.wait(600) });
    return S;
  },

  start(force) {
    if (this.active) return;
    if (!force && data.ui && data.ui.tourDone) return;
    this.active = true;
    this.prevSession = currentId;
    this.steps = this.build();
    this.i = 0;
    this.root = el('div', 'tour');
    this.root.innerHTML = '<div class="tour-shade t"></div><div class="tour-shade l"></div><div class="tour-shade r"></div><div class="tour-shade b"></div><div class="tour-ring"></div><div class="tour-card"></div>';
    document.body.appendChild(this.root);
    this.card = this.root.querySelector('.tour-card');
    // 点说明气泡不要触发「点别处关菜单」之类的逻辑
    this.card.addEventListener('mousedown', (e) => e.stopPropagation());
    this.ring = this.root.querySelector('.tour-ring');
    this.onResize = () => this.place();
    window.addEventListener('resize', this.onResize);
    // 目标位置会变（弹窗打开的动画、列表刷新）：每一帧都对一下，不会慢半拍
    const follow = () => { if (!this.active) return; this.place(); this.raf = requestAnimationFrame(follow); };
    this.raf = requestAnimationFrame(follow);
    this.show();
  },

  finish() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.detach();
    this.root.remove();
    this.closeSettings();
    data.ui.tourDone = Date.now();
    this.cleanup();
    save();
    if (typeof showView === 'function' && document.body.dataset.view === 'history') showView('chat');
  },

  target() {
    const st = this.steps[this.i];
    if (!st || st.center || !st.target) return null;
    const t = typeof st.target === 'function' ? st.target() : document.querySelector(st.target);
    return t && t.getClientRects().length ? t : null;
  },

  detach() {
    if (this.clickT) { this.clickT.removeEventListener('click', this.onTargetClick, true); this.clickT = null; }
  },

  async show() {
    const st = this.steps[this.i];
    if (!st) return this.finish();
    const seq = ++this.seq;
    this.detach();
    // 准备这一步（打开设置、等列表加载）的时候，旧的说明按钮不响应，免得连点跳过好几步
    this.busy = true;
    this.card.classList.add('busy');
    if (st.before) { try { await st.before(); } catch (_) {} }
    if (!this.active || seq !== this.seq) return;
    // 目标还没出现（比如列表还在加载）：等一会儿；实在没有就当居中说明
    const t = st.center ? null : await this.until(() => this.target(), 5000);
    if (!this.active || seq !== this.seq) return;
    const parts = Math.max(...this.steps.map((x) => x.part));
    const inPart = this.steps.filter((x) => x.part === st.part);
    const k = inPart.indexOf(st) + 1;
    const clickable = st.click && t;
    this.card.innerHTML = `<div class="tour-part">第 ${st.part} / ${parts} 部分 · ${k} / ${inPart.length}</div>
      <h3>${esc(st.title)}</h3><p>${esc(st.text)}</p>
      ${clickable ? '<div class="tour-hint">点一下高亮的地方，或者点「下一步」</div>' : ''}
      <div class="tour-acts"><button class="tour-skip">跳过介绍</button><span class="sp"></span>
        ${this.i > 0 ? '<button class="btn tour-back">上一步</button>' : ''}<button class="btn${clickable ? '' : ' primary'} tour-next">${esc(clickable ? '下一步' : st.next || (this.i === this.steps.length - 1 ? '完成' : '下一步'))}</button></div>`;
    this.card.querySelector('.tour-skip').onclick = () => this.finish();
    const back = this.card.querySelector('.tour-back');
    if (back) back.onclick = () => this.back();
    this.card.querySelector('.tour-next').onclick = () => this.advance(true);
    this.card.classList.remove('busy');
    this.busy = false;
    if (clickable) {
      this.clickT = t;
      this.onTargetClick = () => { this.detach(); setTimeout(() => { this.busy = false; this.advance(false); }, 120); };
      t.addEventListener('click', this.onTargetClick, true);
    }
    this.root.classList.toggle('center', !t);
    this.place();
  },

  // 「下一步」：要点的步骤没点就替他点一下（让演示照常往下走）
  advance(byButton) {
    if (this.busy) return;
    this.busy = true;
    const st = this.steps[this.i];
    if (byButton && st && st.click) {
      const t = this.target();
      this.detach();
      if (t) t.click();
    }
    this.detach();
    this.i++;
    setTimeout(() => this.show(), byButton && st && st.click ? 250 : 0);
  },

  // 「上一步」：先把界面恢复成上一步需要的样子，再显示它
  async back() {
    if (this.busy || this.i <= 0) return;
    this.busy = true;
    this.card.classList.add('busy');
    this.detach();
    this.i--;
    const st = this.steps[this.i];
    if (st && st.prep) { try { await st.prep(); } catch (_) {} }
    if (this.active) this.show();
  },

  // 遮罩 = 四块暗色围出一个洞。洞的位置由这里逐帧往目标靠（不交给 CSS 过渡），四块和高亮框每帧用同一个位置，永远对得上
  place() {
    if (!this.active) return;
    const t = this.target();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const p = 6;
    let goal;
    if (t) {
      const r = t.getBoundingClientRect();
      goal = [Math.max(0, r.left - p), Math.max(0, r.top - p), Math.min(W, r.right + p), Math.min(H, r.bottom + p)];
    } else {
      const cx = W / 2, cy = H / 2.4;
      goal = [cx, cy, cx, cy];
    }
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 1;
    this.lastT = now;
    if (!this.cur || this.jump) { this.cur = goal.slice(); this.jump = false; }
    else {
      const k = 1 - Math.exp(-dt / 0.06);
      this.cur = this.cur.map((v, i) => (Math.abs(goal[i] - v) < 0.5 ? goal[i] : v + (goal[i] - v) * k));
    }
    // 四条边先取整，再算每块的宽高：各自取整会差 1 像素，两块半透明叠出一条深色细线
    const [x0, y0, x1, y1] = this.cur.map(Math.round);
    const key = [W, H, ...this.cur.map(Math.round), this.card.offsetWidth, this.card.offsetHeight, this.i, !!t].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const [top, left, right, bottom] = this.root.querySelectorAll('.tour-shade');
    const px = (v) => Math.round(v) + 'px';
    Object.assign(top.style, { left: '0', top: '0', width: W + 'px', height: px(y0) });
    Object.assign(bottom.style, { left: '0', top: px(y1), width: W + 'px', height: px(Math.max(0, H - y1)) });
    Object.assign(left.style, { left: '0', top: px(y0), width: px(x0), height: px(y1 - y0) });
    Object.assign(right.style, { left: px(x1), top: px(y0), width: px(Math.max(0, W - x1)), height: px(y1 - y0) });
    const hole = x1 - x0 > 2 && y1 - y0 > 2;
    Object.assign(this.ring.style, { display: hole ? 'block' : 'none', left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) });
    const card = this.card;
    const cw = card.offsetWidth, ch = card.offsetHeight, g = 14;
    if (!t) {
      card.style.left = Math.round((W - cw) / 2) + 'px';
      card.style.top = Math.round((H - ch) / 2.4) + 'px';
      return;
    }
    // 说明气泡按目标的最终位置放：优先右边，放不下放下面、上面、左边
    const [gx0, gy0, gx1, gy1] = goal;
    const st = this.steps[this.i] || {};
    const spots = [
      ['right', gx1 + g, Math.min(Math.max(12, gy0), H - ch - 12)],
      ['bottom', Math.min(Math.max(12, gx0), W - cw - 12), gy1 + g],
      ['top', Math.min(Math.max(12, gx0), W - cw - 12), gy0 - ch - g],
      ['left', gx0 - cw - g, Math.min(Math.max(12, gy0), H - ch - 12)],
    ];
    const fits = ([, x, y]) => x >= 8 && y >= 8 && x + cw <= W - 8 && y + ch <= H - 8;
    let spot = st.place && spots.find((s) => s[0] === st.place && fits(s));
    spot = spot || spots.find(fits) || ['in', Math.max(12, gx1 - cw - 12), Math.max(12, gy1 - ch - 12)];
    card.style.left = Math.round(spot[1]) + 'px';
    card.style.top = Math.round(spot[2]) + 'px';
  },
};

// 上次介绍没走完就关了软件：演示数据清掉
setTimeout(() => { if (!tour.active && data && data.sessions && data.sessions.some((s) => s.demo)) tour.cleanup(); }, 1500);

// 第一次用（配好服务器、没有弹窗挡着、没在回复）时自动开始介绍
(function autoStart() {
  const ok = () => typeof data !== 'undefined' && data && data.ui && !data.ui.tourDone && typeof curServer === 'function' && curServer()
    && !document.querySelector('.overlay') && !document.querySelector('#wizard:not(.hidden)') && !Object.keys(live || {}).length; // eslint-disable-line no-undef
  let tries = 0;
  const tick = () => {
    if (tour.active || (typeof data !== 'undefined' && data && data.ui && data.ui.tourDone) || ++tries > 400) return;
    if (ok()) return setTimeout(() => { if (ok()) tour.start(); else setTimeout(tick, 3000); }, 1200);
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 2500);
})();
