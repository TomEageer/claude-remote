/* global nacl */
// 手机和电脑之间的端到端加密（第 2 版）。电脑端和手机网页用的是同一个文件（src/renderer/e2e.js 是它的拷贝，检查脚本会核对两份一致）。
//
// 中转服务器只负责转发，这里的每一步都假设中转会偷看、篡改、重放：
//
// 1. 配对：电脑生成一张一次性门票（随机 32 字节，5 分钟内有效，只能用一次），和电脑的公钥一起放进二维码。
//    二维码里没有长期密钥。手机扫码后自己生成一对密钥，把公钥用「门票」加密发给电脑；
//    两边各用自己的私钥和对方的公钥算出同一把长期密钥（X25519），这把密钥从不出现在网络上，也不在二维码里。
//    门票用掉就作废：之后谁拿到二维码截图都没用。
//    两边屏幕上显示一个由长期密钥算出来的 4 位数字，你在电脑上确认一致才算配对成功（防止二维码在你扫之前被别人抢先用掉）。
// 2. 每次连接：手机和电脑各生成一对只用这一次的临时密钥，用长期密钥加密交换，算出这次连接的会话密钥，断开就扔。
//    以后就算长期密钥泄露，录下来的旧流量也解不开（向前保密）。
// 3. 每条消息：两个方向各用一把会话密钥，消息带递增序号，序号不比上一条大的直接丢掉（防重放）；
//    加密用 XSalsa20-Poly1305（tweetnacl secretbox），被改过一个字节都会解密失败。
//
// 中转上看到的 box 字段格式（第 1 版是不带前缀的 base64，旧手机继续能用）：
//   P2.  手机 → 电脑  配对请求（用门票加密）       Q2.  电脑 → 手机  配对结果（用长期密钥加密）
//   H2.  手机 → 电脑  连接握手（用长期密钥加密）   I2.  电脑 → 手机  握手回应（用长期密钥加密）
//   S2.  双向         会话消息（会话密钥 + 序号）  R2.  电脑 → 手机  「没有会话，请重新握手」（不含任何内容）
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = {
    enc(u8) {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
    dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    url: (u8) => b64.enc(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    unurl(s) {
      s = String(s).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return b64.dec(s);
    },
  };

  function cat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  }
  // 派生密钥：SHA-512(用途标签 + 输入) 取前 32 字节，不同用途的标签不同，算出来的密钥互不相关
  const kdf = (label, ...parts) => nacl.hash(cat(enc.encode('claude-remote/e2e/v2/' + label + '\0'), ...parts)).slice(0, 32);
  const sid = (hostId, deviceId) => enc.encode(String(hostId) + '|' + String(deviceId));

  // 用一把密钥加密 / 解密一个对象（随机 nonce，放在密文前面）
  function sealWith(key, obj) {
    const nonce = nacl.randomBytes(24);
    return b64.enc(cat(nonce, nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, key)));
  }
  function openWith(key, s) {
    try {
      const raw = b64.dec(s);
      if (raw.length < 40) return null;
      const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), key);
      return plain ? JSON.parse(dec.decode(plain)) : null;
    } catch (_) { return null; }
  }

  const keyPair = () => nacl.box.keyPair();
  const pairKeyOf = (mySecret, theirPublic, hostId, deviceId) => kdf('pair', nacl.scalarMult(mySecret, theirPublic), sid(hostId, deviceId));
  // 两边屏幕上核对的 4 位数字
  function shortCode(pairKey) {
    const h = kdf('code', pairKey);
    return String(((h[0] << 8) | h[1]) % 10000).padStart(4, '0');
  }
  const FRESH = 10 * 60 * 1000; // 握手里的时间和本机相差超过 10 分钟就不认（电脑、手机时钟差不多准就行）
  const fresh = (ts) => Number.isFinite(ts) && Math.abs(Date.now() - ts) < FRESH;

  // 一次连接的加密通道：两个方向各一把密钥，nonce 就是递增序号
  function channel(sendKey, recvKey) {
    let tx = 0;
    let rx = 0;
    const nonceOf = (n) => {
      const u = new Uint8Array(24);
      new DataView(u.buffer).setFloat64(0, n); // 序号最大到 2^53，用不完
      return u;
    };
    return {
      seal(obj) {
        const n = ++tx;
        const nonce = nonceOf(n);
        return 'S2.' + b64.enc(cat(nonce.subarray(0, 8), nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, sendKey)));
      },
      open(s) {
        try {
          const raw = b64.dec(s.slice(3));
          if (raw.length < 24) return null;
          const n = new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0);
          if (!(n > rx)) return null; // 旧的、重复的消息：丢掉
          const nonce = new Uint8Array(24);
          nonce.set(raw.subarray(0, 8));
          const plain = nacl.secretbox.open(raw.subarray(8), nonce, recvKey);
          if (!plain) return null;
          rx = n;
          return JSON.parse(dec.decode(plain));
        } catch (_) { return null; }
      },
    };
  }
  function sessionKeys(ee, pairKey, phoneEph, hostEph) {
    const base = [ee, pairKey, phoneEph, hostEph];
    return { p2h: kdf('p2h', ...base), h2p: kdf('h2p', ...base) };
  }

  // ---------- 手机这边 ----------
  const phone = {
    // 扫到的二维码内容 → 配对请求。返回要存下来的配对信息、要发给电脑的 box、核对数字
    pairRequest(p, label) {
      const me = keyPair();
      const hostPk = b64.unurl(p.k);
      const key = pairKeyOf(me.secretKey, hostPk, p.h, p.d);
      const ticketKey = kdf('ticket', b64.unurl(p.t), sid(p.h, p.d));
      const box = 'P2.' + sealWith(ticketKey, { pk: b64.enc(me.publicKey), label: String(label || '').slice(0, 60), ts: Date.now() });
      const pair = { v: 2, host: p.h, device: p.d, name: p.n || '我的电脑', relay: p.r || '', hostPk: p.k, sk: b64.enc(me.secretKey) };
      return { pair, box, code: shortCode(key) };
    },
    pairKey: (pair) => pairKeyOf(b64.dec(pair.sk), b64.unurl(pair.hostPk), pair.host, pair.device),
    codeOf: (pair) => shortCode(phone.pairKey(pair)),
    // 电脑回的配对结果
    pairResult: (pair, box) => (box.startsWith('Q2.') ? openWith(phone.pairKey(pair), box.slice(3)) : null),
    // 每次连上：发起握手，收到回应后得到加密通道
    hello(pair) {
      const eph = keyPair();
      const key = phone.pairKey(pair);
      return {
        box: 'H2.' + sealWith(key, { e: b64.enc(eph.publicKey), ts: Date.now() }),
        finish(box) {
          if (!box.startsWith('I2.')) return null;
          const r = openWith(key, box.slice(3));
          if (!r || r.pe !== b64.enc(eph.publicKey) || !fresh(r.ts)) return null;
          const hostEph = b64.dec(r.e);
          const k = sessionKeys(nacl.scalarMult(eph.secretKey, hostEph), key, eph.publicKey, hostEph);
          return channel(k.p2h, k.h2p);
        },
      };
    },
  };

  // ---------- 电脑这边 ----------
  const host = {
    keyPair,
    newTicket: () => b64.url(nacl.randomBytes(32)),
    // 手机发来的配对请求：用门票解开，得到手机公钥，算出长期密钥和核对数字
    openPair(box, ticket, hostSecret, hostId, deviceId) {
      if (!box.startsWith('P2.')) return null;
      const r = openWith(kdf('ticket', b64.unurl(ticket), sid(hostId, deviceId)), box.slice(3));
      if (!r || typeof r.pk !== 'string' || !fresh(r.ts)) return null;
      let pk;
      try { pk = b64.dec(r.pk); } catch (_) { return null; }
      if (pk.length !== 32) return null;
      const key = pairKeyOf(hostSecret, pk, hostId, deviceId);
      return { pk: r.pk, label: String(r.label || ''), key, code: shortCode(key) };
    },
    pairKey: (hostSecret, phonePk, hostId, deviceId) => pairKeyOf(hostSecret, b64.dec(phonePk), hostId, deviceId),
    pairReply: (key, obj) => 'Q2.' + sealWith(key, obj),
    // 手机的握手：回一个握手回应，得到加密通道
    accept(box, key) {
      if (!box.startsWith('H2.')) return null;
      const r = openWith(key, box.slice(3));
      if (!r || typeof r.e !== 'string' || !fresh(r.ts)) return null;
      let phoneEph;
      try { phoneEph = b64.dec(r.e); } catch (_) { return null; }
      if (phoneEph.length !== 32) return null;
      const eph = keyPair();
      const k = sessionKeys(nacl.scalarMult(eph.secretKey, phoneEph), key, phoneEph, eph.publicKey);
      return { box: 'I2.' + sealWith(key, { e: b64.enc(eph.publicKey), pe: r.e, ts: Date.now() }), chan: channel(k.h2p, k.p2h) };
    },
  };

  // ---------- 手表配对包（手表没有摄像头，只能输 6 位数字码） ----------
  // 电脑把二维码里那份内容 {h, d, k, t, n, r} 加密后寄存在中转（/pair/put），手表输码后按同一个查找号取回（/pair/get）。
  //   查找号 = SHA-256("claude-remote/watch/lookup\0" + 码) 的十六进制
  //   密钥   = PBKDF2-HMAC-SHA256(码, 盐 = 查找号的 32 字节, 200000 轮, 32 字节)
  //   包     = base64( 随机 24 字节 nonce ‖ secretbox(JSON, nonce, 密钥) )
  // 6 位码只有一百万种：中转理论上能离线穷举出包里的内容，但那里面只有公开信息和一张 5 分钟内有效的门票，
  // 真正的配对仍要你在电脑上核对手表屏幕上的 4 位数字，冒充不了手表。
  const WATCH_ROUNDS = 200000;
  const toHex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');
  async function watchKeys(code) {
    const sub = (root.crypto || globalThis.crypto).subtle;
    const lookup = new Uint8Array(await sub.digest('SHA-256', enc.encode('claude-remote/watch/lookup\0' + code)));
    const base = await sub.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
    const key = new Uint8Array(await sub.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: lookup, iterations: WATCH_ROUNDS }, base, 256));
    return { lookup: toHex(lookup), key };
  }
  const watch = {
    newCode: () => String(nacl.randomBytes(4).reduce((a, b) => a * 256 + b, 0) % 1000000).padStart(6, '0'),
    // 电脑：把配对内容封成包
    async seal(code, payload) { const k = await watchKeys(code); return { lookup: k.lookup, blob: sealWith(k.key, payload) }; },
    // 手表：取回后解开（Swift 端照这个算法实现；这里留着给测试用）
    async open(code, blob) { const k = await watchKeys(code); return openWith(k.key, blob); },
    lookup: async (code) => (await watchKeys(code)).lookup,
    ROUNDS: WATCH_ROUNDS,
  };

  root.crE2E = { phone, host, watch, b64, kind: (box) => (/^[A-Z]2\./.test(box) ? box.slice(0, 2) : box === 'R2' ? 'R2' : 'v1') };
})(typeof window !== 'undefined' ? window : globalThis);
