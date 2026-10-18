// tweetnacl 的 Swift 薄封装。接口和手机网页用的 nacl-fast.js 对齐：
// secretbox 返回的密文不带前导的 16 个零字节，和 JS 一样可以直接拼接。
import Foundation
import CTweetNaCl

public enum NaCl {
  public static let keyBytes = 32
  public static let nonceBytes = 24
  public static let boxOverhead = 16 // Poly1305 认证标签

  public static func randomBytes(_ n: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: n)
    randombytes(&out, UInt64(n))
    return out
  }

  /// SHA-512（JS 里的 nacl.hash）
  public static func hash(_ m: [UInt8]) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: 64)
    _ = crypto_hash_sha512_tweet(&out, m, UInt64(m.count))
    return out
  }

  /// X25519 公私钥对（JS 里的 nacl.box.keyPair）
  public static func boxKeyPair() -> (publicKey: [UInt8], secretKey: [UInt8]) {
    var pk = [UInt8](repeating: 0, count: 32)
    var sk = [UInt8](repeating: 0, count: 32)
    _ = crypto_box_curve25519xsalsa20poly1305_tweet_keypair(&pk, &sk)
    return (pk, sk)
  }

  public static func boxKeyPair(fromSecretKey sk: [UInt8]) -> (publicKey: [UInt8], secretKey: [UInt8]) {
    var pk = [UInt8](repeating: 0, count: 32)
    _ = crypto_scalarmult_curve25519_tweet_base(&pk, sk)
    return (pk, sk)
  }

  /// JS 里的 nacl.scalarMult(n, p)
  public static func scalarMult(_ n: [UInt8], _ p: [UInt8]) -> [UInt8] {
    var q = [UInt8](repeating: 0, count: 32)
    _ = crypto_scalarmult_curve25519_tweet(&q, n, p)
    return q
  }

  /// XSalsa20-Poly1305 加密（JS 里的 nacl.secretbox）。返回 16 字节标签 + 密文
  public static func secretbox(_ message: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8] {
    precondition(nonce.count == 24 && key.count == 32)
    let padded = [UInt8](repeating: 0, count: 32) + message
    var c = [UInt8](repeating: 0, count: padded.count)
    _ = crypto_secretbox_xsalsa20poly1305_tweet(&c, padded, UInt64(padded.count), nonce, key)
    return Array(c[16...])
  }

  /// 解密（JS 里的 nacl.secretbox.open）；密文被改过一个字节就返回 nil
  public static func secretboxOpen(_ box: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8]? {
    guard nonce.count == 24, key.count == 32, box.count >= 16 else { return nil }
    let c = [UInt8](repeating: 0, count: 16) + box
    var m = [UInt8](repeating: 0, count: c.count)
    guard crypto_secretbox_xsalsa20poly1305_tweet_open(&m, c, UInt64(c.count), nonce, key) == 0 else { return nil }
    return Array(m[32...])
  }
}

// ---------- base64（标准 / URL 安全两种，和 e2e.js 的 b64 一致） ----------
public enum B64 {
  public static func enc(_ u8: [UInt8]) -> String { Data(u8).base64EncodedString() }
  public static func dec(_ s: String) -> [UInt8]? { Data(base64Encoded: s).map { [UInt8]($0) } }
  public static func url(_ u8: [UInt8]) -> String {
    enc(u8).replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  public static func unurl(_ s: String) -> [UInt8]? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return dec(t)
  }
}
