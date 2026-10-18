// 生成加密协议一致性测试向量：固定所有密钥，手表的 Swift 实现必须算出同样的结果
// 用法：node scripts/e2e-vectors.js > watch/ClaudeRemoteCore/Tests/ClaudeRemoteCoreTests/Resources/vectors.json
global.nacl = require('../mobile/vendor/nacl-fast.min.js');
globalThis.crypto = require('crypto').webcrypto;
require('../mobile/e2e.js');
const { _: I, phone, host, watch, b64 } = globalThis.crE2E;
const seed = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 13) & 255);
const kp = (n) => nacl.box.keyPair.fromSecretKey(seed(n));
(async () => {
  const hostId = 'h0st1d0000000000', deviceId = 'dev1ce0000000000';
  const H = kp(1), P = kp(2), HE = kp(3), PE = kp(4);
  const ticketRaw = seed(5);
  const ticket = b64.url(ticketRaw);
  const ticketKey = I.kdf('ticket', ticketRaw, I.sid(hostId, deviceId));
  const pairKey = I.pairKeyOf(P.secretKey, H.publicKey, hostId, deviceId);
  const pairKey2 = I.pairKeyOf(H.secretKey, P.publicKey, hostId, deviceId);
  if (b64.enc(pairKey) !== b64.enc(pairKey2)) throw new Error('pair key mismatch');
  const p2Payload = { pk: b64.enc(P.publicKey), label: 'Apple Watch', ts: 1760000000000 };
  const q2Payload = { ok: true, name: '测试电脑' };
  const h2Payload = { e: b64.enc(PE.publicKey), ts: 1760000000000 };
  const i2Payload = { e: b64.enc(HE.publicKey), pe: b64.enc(PE.publicKey), ts: 1760000000001 };
  const ee = nacl.scalarMult(PE.secretKey, HE.publicKey);
  const sk = I.sessionKeys(ee, pairKey, PE.publicKey, HE.publicKey);
  const phoneChan = I.channel(sk.p2h, sk.h2p);
  const hostChan = I.channel(sk.h2p, sk.p2h);
  const m1 = '{"id":1,"op":"info"}', m2 = '{"id":2,"op":"list"}', r1 = '{"re":1,"ok":true,"name":"测试电脑"}';
  const s2 = [phoneChan.seal(JSON.parse(m1)), phoneChan.seal(JSON.parse(m2))];
  const s2host = [hostChan.seal(JSON.parse(r1))];
  const code = '482913';
  const wpayload = { v: 2, h: hostId, d: deviceId, t: ticket, k: b64.url(H.publicKey), n: '测试电脑', r: 'http://127.0.0.1:18797' };
  const ws = await watch.seal(code, wpayload);
  const wk = await (async () => { const sub = crypto.subtle; const lookup = new Uint8Array(await sub.digest('SHA-256', new TextEncoder().encode('claude-remote/watch/lookup\0' + code))); const base = await sub.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']); return b64.enc(new Uint8Array(await sub.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: lookup, iterations: watch.ROUNDS }, base, 256))); })();
  const out = {
    hostId, deviceId, ticket,
    hostSk: b64.enc(H.secretKey), hostPk: b64.enc(H.publicKey), hostPkUrl: b64.url(H.publicKey),
    phoneSk: b64.enc(P.secretKey), phonePk: b64.enc(P.publicKey),
    phoneEphSk: b64.enc(PE.secretKey), phoneEphPk: b64.enc(PE.publicKey), hostEphSk: b64.enc(HE.secretKey), hostEphPk: b64.enc(HE.publicKey),
    ticketKey: b64.enc(ticketKey), pairKey: b64.enc(pairKey), shortCode: I.shortCode(pairKey),
    kdfHash: b64.enc(nacl.hash(new TextEncoder().encode('abc'))),
    p2: 'P2.' + I.sealWith(ticketKey, p2Payload), p2Payload,
    q2: host.pairReply(pairKey, q2Payload), q2Payload,
    h2: 'H2.' + I.sealWith(pairKey, h2Payload), h2Payload,
    i2: 'I2.' + I.sealWith(pairKey, i2Payload), i2Payload,
    sessionP2h: b64.enc(sk.p2h), sessionH2p: b64.enc(sk.h2p),
    s2FromPhone: [{ json: m1, box: s2[0] }, { json: m2, box: s2[1] }],
    s2FromHost: [{ json: r1, box: s2host[0] }],
    watchCode: code, watchLookup: ws.lookup, watchKey: wk, watchBlob: ws.blob, watchPayload: wpayload, watchRounds: watch.ROUNDS,
  };
  process.stdout.write(JSON.stringify(out, null, 1));
})();
