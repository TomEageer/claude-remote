/* global with1m, supports1m, modelBase, api, el, esc, icon, toast, data, save, curServer, modelList, modelInfo, loadModels, currentModel, effortLevels, effortFor, setModel, setEffort, customModel, prettyModel, EFFORT_LABEL */
'use strict';

// ---------- 模型选择（参考 Claude 桌面版） ----------
// 上面几行是 Claude Code /model 里的模型；点右边的箭头展开这个模型的其他版本（来自 Anthropic 模型列表接口）；
// 下面一根拖动条调思考强度，档位按当前模型实际支持的来。都不写死。
const versionsKey = () => (typeof curServer === 'function' && curServer() ? curServer().id : '_');
const versionList = () => ((data.ui.modelVersions || {})[versionsKey()] || {}).list || null;
const familyOf = (id) => (/^claude-([a-z]+)-/.exec(String(id || '')) || [])[1] || (/^(opus|sonnet|haiku|fable)/.exec(String(id || '')) || [])[1] || '';

function modelVersion(id) {
  const list = versionList();
  const base = String(id || '').replace(/\[.*\]$/, '');
  return list ? list.find((v) => v.id === base) || null : null;
}

async function loadModelVersions(force) {
  const key = versionsKey();
  const cached = (data.ui.modelVersions || {})[key];
  if (!force && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached.list;
  const r = await api.claudeModelVersions();
  if (!r.ok) return null;
  data.ui.modelVersions = data.ui.modelVersions || {};
  data.ui.modelVersions[key] = { list: r.versions, at: Date.now() };
  save();
  return r.versions;
}

const modelPicker = {
  open: null, // 展开了哪个系列的其他版本
  t: null, // 当前这个弹窗在改什么：{ cur(), set(id), effort, align }；默认是输入框旁边的（当前对话的模型）
  chatTarget: { cur: () => currentModel(), set: (id) => setModel(id), effort: true },

  pop() { return document.querySelector('.mp-pop'); },

  close() {
    const p = this.pop();
    if (p) p.remove();
    this.open = null;
  },

  async toggle(anchor, target) {
    if (this.pop()) return this.close();
    anchor = anchor || document.querySelector('#btn-model');
    this.t = target || this.chatTarget;
    const pop = el('div', 'mp-pop');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = 300;
    pop.style.left = (this.t.align === 'right' ? Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) : Math.max(8, r.left - 6)) + 'px';
    // 上面空间大就往上展开，否则往下
    if (r.top > window.innerHeight / 2) { pop.style.bottom = window.innerHeight - r.top + 8 + 'px'; pop.style.maxHeight = Math.max(240, r.top - 20) + 'px'; }
    else { pop.style.top = r.bottom + 8 + 'px'; pop.style.maxHeight = Math.max(240, window.innerHeight - r.bottom - 20) + 'px'; }
    setTimeout(() => document.addEventListener('mousedown', function close(e) {
      if (!pop.isConnected) return document.removeEventListener('mousedown', close);
      if (!pop.contains(e.target) && !anchor.contains(e.target)) { modelPicker.close(); document.removeEventListener('mousedown', close); }
    }), 0);
    this.render();
    if (!modelList()) { await loadModels(true); this.render(); }
    if (!versionList()) { await loadModelVersions(false); this.render(); }
  },

  // 系列：按 Claude Code /model 的顺序；Default 那一项不单独列，标在它对应的系列上
  families() {
    const list = modelList() || [];
    const def = list.find((m) => m.value === 'default');
    const out = [];
    for (const m of list) {
      if (m.value === 'default') continue;
      const fam = familyOf(m.resolved || m.value);
      if (!fam || out.some((f) => f.fam === fam)) continue;
      out.push({ fam, entry: m, isDefault: !!(def && familyOf(def.resolved) === fam) });
    }
    return out;
  },

  render() {
    const pop = this.pop();
    if (!pop) return;
    const keep = pop.scrollTop;
    pop.innerHTML = '';
    const list = modelList();
    if (!list) {
      pop.appendChild(el('div', 'mp-empty', '<span class="spin"></span><span>正在向 Claude Code 读取模型…</span>'));
      return;
    }
    const t = this.t || this.chatTarget;
    const cur = t.cur();
    const curFam = familyOf(cur === 'default' ? (list.find((m) => m.value === 'default') || {}).resolved : (modelInfo(cur) || {}).resolved || cur);
    const versions = versionList();
    for (const f of this.families()) {
      const chosen = f.fam === curFam;
      // 选的是这个系列的某个旧版本：行里显示出来
      const old = chosen && !modelInfo(cur) && cur !== 'default' ? modelVersion(cur) : null;
      const row = el('div', 'mp-row' + (chosen ? ' on' : ''));
      const main = el('button', 'mp-main', `<span class="mp-name">${esc(prettyModel(f.entry.resolved || f.entry.value))}${f.isDefault ? '<span class="mp-tag">默认</span>' : ''}</span>
        <span class="mp-desc">${esc(old ? '当前：' + old.name : (f.entry.description.split(' · ')[1] || f.entry.description))}</span>`);
      // 默认那个系列：选它就是「跟随 Claude Code 的默认模型」
      main.onclick = () => { t.set(f.isDefault && (!supports1m(f.entry.value) || /\[1m\]/.test(f.entry.resolved || f.entry.value)) ? 'default' : with1m(f.entry.value)); this.render(); };
      row.appendChild(main);
      if (chosen) row.appendChild(el('span', 'mp-check', icon('check')));
      const fv = versions ? versions.filter((v) => v.family === f.fam) : null;
      if (!versions || fv.length > 1) {
        const more = el('button', 'mp-more' + (this.open === f.fam ? ' open' : ''), icon('chevRight'));
        more.title = '这个模型的其他版本';
        more.onclick = async (e) => {
          e.stopPropagation();
          this.open = this.open === f.fam ? null : f.fam;
          this.render();
          if (!versionList()) { await loadModelVersions(true); this.render(); }
        };
        row.appendChild(more);
      }
      pop.appendChild(row);
      if (this.open === f.fam) {
        const box = el('div', 'mp-versions');
        if (!versions) box.appendChild(el('div', 'mp-empty small', '<span class="spin"></span><span>正在读取版本…</span>'));
        else {
          for (const v of fv) {
            const b = el('button', 'mp-ver' + (modelBase(cur) === v.id ? ' on' : ''), `<span>${esc(v.name)}</span>${v.deprecated ? '<span class="mp-tag dim">即将停用</span>' : ''}${modelBase(cur) === v.id ? icon('check') : ''}`);
            b.title = v.id;
            b.onclick = () => { t.set(with1m(v.id)); this.render(); };
            box.appendChild(b);
          }
        }
        pop.appendChild(box);
      }
    }

    // 思考强度：拖动条，最左边是「默认」
    const levels = effortLevels(cur);
    const eff = el('div', 'mp-effort');
    if (!t.effort) {
      // 设置页里只选模型，不带思考强度
    } else if (!levels.length) {
      eff.innerHTML = '<div class="mp-eff-head"><span>思考强度</span><span class="mp-eff-val">这个模型不支持</span></div>';
    } else {
      const stops = ['', ...levels];
      const idx = Math.max(0, stops.indexOf(effortFor(cur)));
      const label = (l) => (l ? EFFORT_LABEL[l] || l : '默认');
      eff.innerHTML = `<div class="mp-eff-head"><span>思考强度</span><span class="mp-eff-val">${esc(label(stops[idx]))}</span></div>
        <input type="range" class="mp-slider" min="0" max="${stops.length - 1}" step="1" value="${idx}" />
        <div class="mp-ticks">${stops.map((l) => `<span>${esc(label(l))}</span>`).join('')}</div>`;
      const slider = eff.querySelector('.mp-slider');
      const paint = () => slider.style.setProperty('--p', (slider.value / (stops.length - 1)) * 100 + '%');
      paint();
      slider.oninput = () => { paint(); eff.querySelector('.mp-eff-val').textContent = label(stops[slider.value]); };
      slider.onchange = () => setEffort(stops[slider.value], true);
    }
    if (t.effort) pop.appendChild(eff);

    // 1M 上下文：完整型号名（比如从「其他版本」里选的）默认只有 20 万；加上 [1m] 才是 100 万
    if (cur !== 'default' && !/haiku/i.test(cur)) {
      const on = /\[1m\]$/.test(cur);
      const row = el('label', 'mp-1m', `<span>1M 上下文<small>${on ? '已开：上限 100 万 tokens' : '未开：上限一般是 20 万 tokens'}</small></span><input type="checkbox"${on ? ' checked' : ''} />`);
      row.querySelector('input').onchange = (e) => { t.set(modelBase(cur) + (e.target.checked ? '[1m]' : '')); this.render(); };
      pop.appendChild(row);
    }

    const foot = el('div', 'mp-foot');
    const custom = el('button', 'mp-link', '自定义模型 ID…');
    custom.onclick = () => { this.close(); customModel(); };
    const refresh = el('button', 'mp-link', '刷新');
    refresh.title = '重新向 Claude Code 读取模型和版本';
    refresh.onclick = async () => {
      refresh.disabled = true;
      await Promise.all([loadModels(true), loadModelVersions(true)]);
      this.render();
    };
    if (t.effort) foot.append(custom);
    foot.append(refresh);
    pop.appendChild(foot);
    pop.scrollTop = keep;
  },
};

document.querySelector('#btn-model').onclick = () => modelPicker.toggle();
