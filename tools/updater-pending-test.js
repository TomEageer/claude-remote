// 用假的 GitHub 返回验证：已经下好旧版本的更新后，又出了新版本，会不会改下新的
const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os'); const zlib = require('zlib'); const crypto = require('crypto');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'crupd-'));
let latest = '1.9.18'; const calls = [];
const asarOf = (v) => Buffer.from('asar-' + v);
const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');
const plat = process.platform;
const fakeFetch = async (url) => {
  calls.push(url);
  const ok = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: new Uint8Array(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) })) }; } } });
  if (url.includes('/releases/latest')) {
    const name = plat === 'win32' ? 'app-win32-v2.asar.gz' : `app-${plat}.asar.gz`;
    return ok({ tag_name: 'v' + latest, html_url: 'x', assets: [{ name: 'app-update.json', browser_download_url: 'dl://meta/' + latest }, { name, browser_download_url: 'dl://pack/' + latest }] });
  }
  const v = url.split('/').pop();
  if (url.startsWith('dl://meta/')) { const a = asarOf(v); return ok(Buffer.from(JSON.stringify({ version: v, electron: process.versions.electron, [plat]: { sha512: sha(a), size: a.length } }))); }
  if (url.startsWith('dl://pack/')) return ok(zlib.gzipSync(asarOf(v)));
  throw new Error('unexpected ' + url);
};
const electron = { app: { getPath: () => ud, getVersion: () => '1.9.0', isPackaged: true, relaunch() { electron.relaunched = true; }, exit() { electron.exited = true; } }, net: { fetch: fakeFetch } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'electron' ? electron : r === 'original-fs' ? fs : orig.call(this, r, ...a); };
const { createUpdater } = require('../src/updater');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const events = [];
const u = createUpdater({ repo: 'a/b', send: (c, p) => events.push(p), currentVersion: () => '1.9.17', cmpVer: cmp });
const last = () => JSON.stringify(events[events.length - 1]);
(async () => {
  await u.check(false); console.log('1 先下到', last());
  latest = '1.9.19'; await u.check(false); console.log('2 又出新版后再检查', last());
  latest = '1.9.19'; await u.check(false); console.log('3 没有更新的版本再检查', last());
  latest = '1.9.20'; await u.install();
  console.log('4 点重启时又出了新版', fs.readFileSync(path.join(ud, 'app-update', 'current.json'), 'utf8'), 'exited=', !!electron.exited);
})().catch((e) => { console.log('FAIL', e.stack); process.exit(1); });
