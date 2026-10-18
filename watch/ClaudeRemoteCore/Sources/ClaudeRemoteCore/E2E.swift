// 手表和电脑之间的端到端加密：mobile/e2e.js「手机这边」的 Swift 移植，算法、标签、字节格式必须和那份文件一模一样。
// 改协议时两边一起改，并重新生成 tools/e2e-vectors.js 的向量跑测试。
//
// 中转只转发，这里的每一步都假设中转会偷看、篡改、重放：
//   配对：电脑的一次性门票 + 双方各自生成的密钥对（X25519）算出长期密钥，两边核对 4 位数字
//   每次连接：各生成一对临时密钥，算出只用这一次的会话密钥（向前保密）
//   每条消息：递增序号做 nonce，序号不比上一条大的直接丢掉（防重放）；XSalsa20-Poly1305 认证加密
import Foundation
import CommonCrypto
import CryptoKit

public typealias JSONObject = [String: Any]

enum JSONUtil {
  static func encode(_ obj: JSONObject) -> [UInt8] {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return [] }
    return [UInt8](d)
  }
  static func decode(_ bytes: [UInt8]) -> JSONObject? {
    (try? JSONSerialization.jsonObject(with: Data(bytes))) as? JSONObject
  }
}

public enum E2E {
  /// 握手里的时间和本机相差超过 10 分钟就不认（电脑、手表时钟差不多准就行）
  public static let freshWindowMs: Double = 10 * 60 * 1000
  public static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
  static func fresh(_ ts: Double, now: Double) -> Bool { abs(now - ts) < freshWindowMs }

  /// 派生密钥：SHA-512(用途标签 + 输入) 取前 32 字节
  public static func kdf(_ label: String, _ parts: [[UInt8]]) -> [UInt8] {
    var m = Array(("claude-remote/e2e/v2/" + label).utf8) + [0]
    for p in parts { m += p }
    return Array(NaCl.hash(m)[0..<32])
  }
  public static func sid(_ hostId: String, _ deviceId: String) -> [UInt8] { Array((hostId + "|" + deviceId).utf8) }

  /// 用一把密钥加密一个对象：随机 nonce 放在密文前面，整体 base64
  public static func sealWith(_ key: [UInt8], _ obj: JSONObject) -> String { sealWith(key, raw: JSONUtil.encode(obj)) }
  public static func sealWith(_ key: [UInt8], raw: [UInt8]) -> String {
    let nonce = NaCl.randomBytes(24)
    return B64.enc(nonce + NaCl.secretbox(raw, nonce: nonce, key: key))
  }
  public static func openWith(_ key: [UInt8], _ s: String) -> JSONObject? {
    guard let raw = B64.dec(s), raw.count >= 40 else { return nil }
    guard let plain = NaCl.secretboxOpen(Array(raw[24...]), nonce: Array(raw[0..<24]), key: key) else { return nil }
    return JSONUtil.decode(plain)
  }

  public static func pairKeyOf(mySecret: [UInt8], theirPublic: [UInt8], hostId: String, deviceId: String) -> [UInt8] {
    kdf("pair", [NaCl.scalarMult(mySecret, theirPublic), sid(hostId, deviceId)])
  }
  /// 两边屏幕上核对的 4 位数字
  public static func shortCode(_ pairKey: [UInt8]) -> String {
    let h = kdf("code", [pairKey])
    return String(format: "%04d", ((Int(h[0]) << 8) | Int(h[1])) % 10000)
  }
  public static func sessionKeys(ee: [UInt8], pairKey: [UInt8], phoneEph: [UInt8], hostEph: [UInt8]) -> (p2h: [UInt8], h2p: [UInt8]) {
    let base = [ee, pairKey, phoneEph, hostEph]
    return (kdf("p2h", base), kdf("h2p", base))
  }

  /// 一次连接的加密通道：两个方向各一把密钥，nonce 就是递增序号（前 8 字节 = 序号的 IEEE754 大端表示）
  public final class Channel {
    private let sendKey: [UInt8]
    private let recvKey: [UInt8]
    private var tx: Double = 0
    private var rx: Double = 0
    public init(sendKey: [UInt8], recvKey: [UInt8]) { self.sendKey = sendKey; self.recvKey = recvKey }
    static func nonce(_ n: Double) -> [UInt8] {
      var bits = n.bitPattern.bigEndian
      let head = withUnsafeBytes(of: &bits) { [UInt8]($0) }
      return head + [UInt8](repeating: 0, count: 16)
    }
    public func seal(_ obj: JSONObject) -> String { seal(raw: JSONUtil.encode(obj)) }
    public func seal(raw: [UInt8]) -> String {
      tx += 1
      let nonce = Self.nonce(tx)
      return "S2." + B64.enc(Array(nonce[0..<8]) + NaCl.secretbox(raw, nonce: nonce, key: sendKey))
    }
    public func open(_ s: String) -> JSONObject? {
      guard s.hasPrefix("S2."), let raw = B64.dec(String(s.dropFirst(3))), raw.count >= 24 else { return nil }
      let n = Double(bitPattern: UInt64(bigEndian: raw[0..<8].withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) }))
      guard n > rx else { return nil } // 旧的、重复的消息：丢掉
      let nonce = Array(raw[0..<8]) + [UInt8](repeating: 0, count: 16)
      guard let plain = NaCl.secretboxOpen(Array(raw[8...]), nonce: nonce, key: recvKey) else { return nil }
      rx = n
      return JSONUtil.decode(plain)
    }
  }
}

/// 存在手表上的配对信息（和手机页面 localStorage 里的 crPair 第 2 版字段一致）
public struct Pairing: Codable, Equatable {
  public var v: Int = 2
  public var host: String
  public var device: String
  public var name: String
  public var relay: String
  public var hostPk: String // URL 安全 base64
  public var sk: String     // 标准 base64，手表自己的私钥
  public init(host: String, device: String, name: String, relay: String, hostPk: String, sk: String) {
    self.host = host; self.device = device; self.name = name; self.relay = relay; self.hostPk = hostPk; self.sk = sk
  }
}

/// 「手机这边」的协议：手表就是电脑眼里的又一台手机
public enum Phone {
  public struct PairRequest { public let pairing: Pairing; public let box: String; public let code: String }

  /// 拿到配对包（二维码里的那份内容 {h, d, k, t, n, r}）→ 生成自己的密钥对 → 用门票加密公钥发给电脑
  public static func pairRequest(bundle: JSONObject, label: String, keyPair: (publicKey: [UInt8], secretKey: [UInt8])? = nil, now: Double = E2E.nowMs()) -> PairRequest? {
    guard let h = bundle["h"] as? String, let d = bundle["d"] as? String, let k = bundle["k"] as? String, let t = bundle["t"] as? String,
          let hostPk = B64.unurl(k), hostPk.count == 32, let ticket = B64.unurl(t) else { return nil }
    let me = keyPair ?? NaCl.boxKeyPair()
    let key = E2E.pairKeyOf(mySecret: me.secretKey, theirPublic: hostPk, hostId: h, deviceId: d)
    let ticketKey = E2E.kdf("ticket", [ticket, E2E.sid(h, d)])
    let box = "P2." + E2E.sealWith(ticketKey, ["pk": B64.enc(me.publicKey), "label": String(label.prefix(60)), "ts": Int64(now)])
    let pairing = Pairing(host: h, device: d, name: (bundle["n"] as? String) ?? "我的电脑", relay: (bundle["r"] as? String) ?? "", hostPk: k, sk: B64.enc(me.secretKey))
    return PairRequest(pairing: pairing, box: box, code: E2E.shortCode(key))
  }

  public static func pairKey(_ p: Pairing) -> [UInt8]? {
    guard let sk = B64.dec(p.sk), let pk = B64.unurl(p.hostPk), sk.count == 32, pk.count == 32 else { return nil }
    return E2E.pairKeyOf(mySecret: sk, theirPublic: pk, hostId: p.host, deviceId: p.device)
  }
  public static func codeOf(_ p: Pairing) -> String? { pairKey(p).map(E2E.shortCode) }
  /// 电脑回的配对结果 {ok, name}
  public static func pairResult(_ p: Pairing, _ box: String) -> JSONObject? {
    guard box.hasPrefix("Q2."), let key = pairKey(p) else { return nil }
    return E2E.openWith(key, String(box.dropFirst(3)))
  }

  /// 每次连上：发起握手（H2），收到回应（I2）后得到加密通道
  public final class Hello {
    public let box: String
    private let eph: (publicKey: [UInt8], secretKey: [UInt8])
    private let key: [UInt8]
    private let now: Double
    public init?(_ p: Pairing, eph: (publicKey: [UInt8], secretKey: [UInt8])? = nil, now: Double = E2E.nowMs()) {
      guard let key = pairKey(p) else { return nil }
      self.key = key
      self.eph = eph ?? NaCl.boxKeyPair()
      self.now = now
      self.box = "H2." + E2E.sealWith(key, ["e": B64.enc(self.eph.publicKey), "ts": Int64(now)])
    }
    public func finish(_ box: String) -> E2E.Channel? {
      guard box.hasPrefix("I2."), let r = E2E.openWith(key, String(box.dropFirst(3))) else { return nil }
      guard (r["pe"] as? String) == B64.enc(eph.publicKey), let ts = (r["ts"] as? NSNumber)?.doubleValue, E2E.fresh(ts, now: now) else { return nil }
      guard let e = r["e"] as? String, let hostEph = B64.dec(e), hostEph.count == 32 else { return nil }
      let k = E2E.sessionKeys(ee: NaCl.scalarMult(eph.secretKey, hostEph), pairKey: key, phoneEph: eph.publicKey, hostEph: hostEph)
      return E2E.Channel(sendKey: k.p2h, recvKey: k.h2p)
    }
  }
}

/// 手表配对包：手表输入 6 位码 → 算查找号去中转取包 → 用码派生的密钥解开（算法见 e2e.js 的 watch）
public enum WatchPair {
  public static let rounds: UInt32 = 200_000
  static func lookupBytes(_ code: String) -> [UInt8] {
    Array(SHA256.hash(data: Data(("claude-remote/watch/lookup\0" + code).utf8)))
  }
  public static func lookup(_ code: String) -> String { lookupBytes(code).map { String(format: "%02x", $0) }.joined() }
  public static func key(_ code: String) -> [UInt8] {
    let salt = lookupBytes(code)
    var out = [UInt8](repeating: 0, count: 32)
    let pw = Array(code.utf8)
    _ = pw.withUnsafeBufferPointer { p in
      salt.withUnsafeBufferPointer { s in
        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) }, pw.count, s.baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds, &out, out.count)
      }
    }
    return out
  }
  public static func open(code: String, blob: String) -> JSONObject? { E2E.openWith(key(code), blob) }
}
