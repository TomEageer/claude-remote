/* global api, el, esc, icon, toast, modal */
'use strict';

// ---------- 公司 VPN 设置（设置页和首次配置向导共用） ----------
// 结果：{ on, server, group, user, pin, pass }，pass 是主进程加密过的（系统钥匙串 / Windows 凭据），界面上不保留明文
function vpnFields(initial) {
  const v0 = initial || {};
  const box = el('div', 'vpn-fields');
  box.innerHTML = `
    <label class="check"><input type="checkbox" class="vpn-on" ${v0.on ? 'checked' : ''} /> 通过公司 VPN 连接这台服务器（AnyConnect / OpenConnect 协议：Cisco AnyConnect、AnyLink、ocserv 等）</label>
    <div class="vpn-body"${v0.on ? '' : ' hidden'}>
      <div class="help vpn-intro">只给本软件连服务器用：不改系统网络、不影响别的软件，也不需要管理员权限。连服务器时自动拨号，退出软件自动断开。</div>
      <div class="frow2">
        <div class="field grow"><label>VPN 服务器地址</label><input class="vpn-server" placeholder="vpn.example.com:443" value="${esc(v0.server || '')}" spellcheck="false" /></div>
        <div class="field grow"><label>用户组</label><div class="row"><select class="vpn-group"><option value="">${v0.group ? esc(v0.group) : '先点「获取」'}</option></select><button class="btn vpn-probe" type="button">获取</button></div></div>
      </div>
      <div class="vpn-cert hidden"></div>
      <div class="frow2">
        <div class="field grow"><label>账号</label><input class="vpn-user" value="${esc(v0.user || '')}" spellcheck="false" autocomplete="off" /></div>
        <div class="field grow"><label>密码</label><input class="vpn-pass" type="password" placeholder="${v0.pass ? '已保存（不改就留空）' : ''}" autocomplete="new-password" /></div>
      </div>
      <div class="vpn-test-row"><button class="btn vpn-test" type="button">测试连接</button><span class="vpn-result"></span></div>
    </div>`;
  const $ = (s) => box.querySelector(s);
  const state = { pin: v0.pin || '', pass: v0.pass || '', group: v0.group || '' };
  const groupSel = $('.vpn-group');
  if (state.group) groupSel.innerHTML = `<option value="${esc(state.group)}">${esc(state.group)}</option>`;
  const result = (cls, text) => { const r = $('.vpn-result'); r.className = 'vpn-result ' + cls; r.innerHTML = text; };

  $('.vpn-on').onchange = (e) => {
    $('.vpn-body').hidden = !e.target.checked;
    box.dispatchEvent(new CustomEvent('vpnchange', { bubbles: true, detail: { on: e.target.checked } }));
  };

  // 证书不受系统信任：显示指纹，用户确认后记下（之后指纹变了会拒绝连接）
  const showCert = (pin, subject, then) => {
    const c = $('.vpn-cert');
    c.classList.remove('hidden');
    c.innerHTML = `${icon('alert')}<div><b>VPN 服务器的证书不受系统信任</b><span>证书：${esc(subject || '未知')}<br>指纹：<code>${esc(pin)}</code><br>确认是你们公司的 VPN（可以找管理员核对指纹）再点信任</span></div><button class="btn" type="button">信任这个证书</button>`;
    c.querySelector('button').onclick = () => {
      state.pin = pin;
      c.classList.add('hidden');
      if (then) then();
    };
  };

  const probe = async () => {
    const server = $('.vpn-server').value.trim();
    if (!server) return toast('先填 VPN 服务器地址');
    const b = $('.vpn-probe');
    b.disabled = true;
    b.textContent = '获取中…';
    const r = await api.vpnProbe({ server, pin: state.pin });
    b.disabled = false;
    b.textContent = '获取';
    if (!r.ok) return result('bad', esc(r.message));
    if (r.event === 'error') {
      if (r.code === 'cert') return showCert(r.pin, r.subject, probe);
      return result('bad', esc(r.message));
    }
    const groups = r.groups || [];
    const keep = groupSel.value || state.group;
    groupSel.innerHTML = groups.length ? groups.map((g) => `<option value="${esc(g)}"${g === (keep || r.default) ? ' selected' : ''}>${esc(g)}</option>`).join('') : '<option value="">服务器没有列出用户组</option>';
    result('ok', groups.length ? `找到 ${groups.length} 个用户组，选一个` : '这台 VPN 不用选用户组');
  };
  $('.vpn-probe').onclick = probe;

  const read = async () => {
    const on = $('.vpn-on').checked;
    const pw = $('.vpn-pass').value;
    if (pw) { state.pass = await api.vpnEncrypt(pw); $('.vpn-pass').value = ''; $('.vpn-pass').placeholder = '已保存（不改就留空）'; }
    return { on, server: $('.vpn-server').value.trim(), group: groupSel.value || '', user: $('.vpn-user').value.trim(), pin: state.pin, pass: state.pass };
  };

  $('.vpn-test').onclick = async () => {
    const v = await read();
    if (!v.server || !v.user || !v.pass) return result('bad', '地址、账号、密码都要填');
    const b = $('.vpn-test');
    b.disabled = true;
    result('', '<span class="spin"></span> 正在连接 VPN…');
    const r = await api.vpnTest({ ...v, on: true });
    b.disabled = false;
    if (r.ok) return result('ok', `已连上，VPN 分配的内网地址 ${esc(r.ip || '')}`);
    if (/证书不受信任/.test(r.message)) { result('bad', ''); return probe(); }
    result('bad', esc(r.message));
  };

  return { el: box, read, isOn: () => $('.vpn-on').checked };
}

// VPN 要求输入动态口令等额外验证时弹窗
api.onVpn(async (e) => {
  if (!e.need) return;
  const body = el('div');
  body.innerHTML = `<p class="help" style="margin-top:0">${esc(e.need.message || '公司 VPN 要求额外验证')}</p><div class="field"><label>${esc(e.need.label || '验证码')}</label><input id="vpn-need" type="${e.need.secret ? 'password' : 'text'}" autocomplete="one-time-code" /></div>`;
  setTimeout(() => { const i = body.querySelector('#vpn-need'); if (i) i.focus(); }, 50);
  const v = await modal({ title: '公司 VPN 验证', body, buttons: [{ text: '取消', value: null }, { text: '确定', cls: 'primary', onClick: () => body.querySelector('#vpn-need').value }] });
  if (v == null) return api.vpnDisconnect(e.key);
  const r = await api.vpnAnswer(e.key, v);
  if (!r.ok) toast(r.message, 5000);
});
