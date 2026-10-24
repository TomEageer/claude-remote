// 协议自测：配对、握手、收发、防重放、篡改、门票错误、旧会话
global.nacl = require('../mobile/vendor/nacl-fast.min.js');
require('../mobile/e2e.js');
const { phone, host, b64 } = globalThis.crE2E;
const assert = require('assert');
const H = host.keyPair(), hostId = 'host12345678', dev = 'dev12345678';
const ticket = host.newTicket();
const qr = { v: 2, h: hostId, d: dev, t: ticket, k: b64.url(H.publicKey), n: '电脑' };
const req = phone.pairRequest(qr, 'iPhone');
assert(!req.box.includes(ticket));
const op = host.openPair(req.box, ticket, H.secretKey, hostId, dev);
assert(op && op.code === req.code, 'code match');
assert.strictEqual(host.openPair(req.box, host.newTicket(), H.secretKey, hostId, dev), null, 'wrong ticket');
assert.strictEqual(host.openPair(req.box, ticket, H.secretKey, hostId, 'other1234'), null, 'bound to device');
const K = host.pairKey(H.secretKey, op.pk, hostId, dev);
assert.deepStrictEqual(K, phone.pairKey(req.pair));
assert.deepStrictEqual(phone.pairResult(req.pair, host.pairReply(K, { ok: true })), { ok: true });
// 握手
const hs = phone.hello(req.pair);
const acc = host.accept(hs.box, K);
const pc = hs.finish(acc.box), hc = acc.chan;
assert(pc);
const m1 = pc.seal({ op: 'list', id: 1 });
assert.deepStrictEqual(hc.open(m1), { op: 'list', id: 1 });
assert.strictEqual(hc.open(m1), null, 'replay dropped');
const m2 = hc.seal({ re: 1, ok: true });
const t = b64.dec(m2.slice(3)); t[t.length - 1] ^= 1;
assert.strictEqual(pc.open('S2.' + b64.enc(t)), null, 'tamper');
assert.deepStrictEqual(pc.open(m2), { re: 1, ok: true });
// 另一次连接的密文在这次连接里解不开
const hs2 = phone.hello(req.pair); const acc2 = host.accept(hs2.box, K); const pc2 = hs2.finish(acc2.box);
assert.strictEqual(acc2.chan.open(pc.seal({ x: 1 })), null, 'cross-session');
assert.deepStrictEqual(acc2.chan.open(pc2.seal({ x: 2 })), { x: 2 });
// 握手回应被换成另一次的：手机不认
assert.strictEqual(phone.hello(req.pair).finish(acc.box), null, 'stale I2');
// 不知道长期密钥的人伪造握手
const fake = phone.hello({ ...req.pair, sk: b64.enc(host.keyPair().secretKey) });
assert.strictEqual(host.accept(fake.box, K), null, 'forged hello');
console.log('e2e ok, code', req.code);
// 手表配对包：封装 / 解开 / 查找号稳定 / 错码解不开
(async () => {
  globalThis.crypto = require('crypto').webcrypto;
  const { watch } = globalThis.crE2E;
  const code = watch.newCode(); assert(/^\d{6}$/.test(code));
  const payload = { h: 'host12345678', d: 'dev12345678', k: 'pk', t: 'ticket', n: '电脑' };
  const s1 = await watch.seal(code, payload);
  assert.strictEqual(s1.lookup, await watch.lookup(code)); assert.strictEqual(s1.lookup.length, 64);
  assert.deepStrictEqual(await watch.open(code, s1.blob), payload);
  assert.strictEqual(await watch.open(String((Number(code) + 1) % 1000000).padStart(6, '0'), s1.blob), null);
  console.log('watch bundle ok, code', code, 'lookup', s1.lookup.slice(0, 12));
})();

// 网页登录码：8 位字母数字、输入容错、封装 / 解开、错码解不开、码互不相同
(async () => {
  globalThis.crypto = require('crypto').webcrypto;
  const { web } = globalThis.crE2E;
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = web.newCode(); assert(/^[A-HJ-NP-Z2-9]{8}$/.test(c), c); seen.add(c); }
  assert(seen.size > 195, 'codes should not repeat');
  assert.strictEqual(web.normalize(' ab3d-k7mn '), 'AB3DK7MN');
  assert(web.valid('AB3DK7MN') && !web.valid('AB3DK7M') && !web.valid('AB3DK7M0') && !web.valid('AB3DK7MI'));
  const code = web.newCode();
  const payload = { v: 2, h: 'host12345678', d: 'dev12345678', k: 'pk', t: 'ticket', n: '电脑', r: 'https://r.example' };
  const t0 = Date.now();
  const s1 = await web.seal(code, payload);
  const cost = Date.now() - t0;
  assert.strictEqual(s1.lookup, await web.lookup(code)); assert.strictEqual(s1.lookup.length, 64);
  assert.deepStrictEqual(await web.open(code, s1.blob), payload);
  const other = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
  assert.strictEqual(await web.open(other, s1.blob), null);
  assert.notStrictEqual(await web.lookup(other), s1.lookup);
  const w6 = await globalThis.crE2E.watch.seal('123456', payload);
  assert.notStrictEqual(w6.lookup, await web.lookup('123456'), 'web and watch lookups must differ');
  console.log('web code ok, code', code, 'lookup', s1.lookup.slice(0, 12), 'seal ms', cost);
})();
