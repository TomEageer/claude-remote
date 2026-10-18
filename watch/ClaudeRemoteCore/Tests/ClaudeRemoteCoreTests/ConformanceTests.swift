// 和 mobile/e2e.js 的一致性：向量由 tools/e2e-vectors.js 生成，Swift 必须算出同样的密钥、同样的密文
import XCTest
@testable import ClaudeRemoteCore

final class ConformanceTests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUpWithError() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "vectors", withExtension: "json"))
    v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }
  func s(_ k: String) -> String { v[k] as! String }
  func b(_ k: String) -> [UInt8] { B64.dec(s(k))! }
  func obj(_ k: String) -> [String: Any] { v[k] as! [String: Any] }
  func same(_ a: [String: Any]?, _ b: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
    let x = a.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    let y = try? JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
    XCTAssertEqual(x.map { String(decoding: $0, as: UTF8.self) }, y.map { String(decoding: $0, as: UTF8.self) }, file: file, line: line)
  }

  func testHashAndKdf() {
    XCTAssertEqual(B64.enc(NaCl.hash(Array("abc".utf8))), s("kdfHash"))
    let ticketKey = E2E.kdf("ticket", [B64.unurl(s("ticket"))!, E2E.sid(s("hostId"), s("deviceId"))])
    XCTAssertEqual(B64.enc(ticketKey), s("ticketKey"))
  }
  func testPairKeyBothDirectionsAndShortCode() {
    let a = E2E.pairKeyOf(mySecret: b("phoneSk"), theirPublic: b("hostPk"), hostId: s("hostId"), deviceId: s("deviceId"))
    let c = E2E.pairKeyOf(mySecret: b("hostSk"), theirPublic: b("phonePk"), hostId: s("hostId"), deviceId: s("deviceId"))
    XCTAssertEqual(B64.enc(a), s("pairKey")); XCTAssertEqual(a, c)
    XCTAssertEqual(E2E.shortCode(a), s("shortCode"))
    XCTAssertEqual(NaCl.boxKeyPair(fromSecretKey: b("phoneSk")).publicKey, b("phonePk"))
  }
  func testOpenJsBoxes() {
    same(E2E.openWith(b("ticketKey"), String(s("p2").dropFirst(3))), obj("p2Payload"))
    same(E2E.openWith(b("pairKey"), String(s("h2").dropFirst(3))), obj("h2Payload"))
    let pairing = Pairing(host: s("hostId"), device: s("deviceId"), name: "x", relay: "", hostPk: s("hostPkUrl"), sk: s("phoneSk"))
    same(Phone.pairResult(pairing, s("q2")), obj("q2Payload"))
    XCTAssertNil(E2E.openWith(b("pairKey"), String(s("p2").dropFirst(3))), "错的密钥解不开")
  }
  func testPairRequestMatchesJs() throws {
    let bundle: [String: Any] = ["h": s("hostId"), "d": s("deviceId"), "k": s("hostPkUrl"), "t": s("ticket"), "n": "测试电脑", "r": "http://127.0.0.1:18797"]
    let req = try XCTUnwrap(Phone.pairRequest(bundle: bundle, label: "Apple Watch", keyPair: (b("phonePk"), b("phoneSk")), now: 1760000000000))
    XCTAssertEqual(req.code, s("shortCode"))
    XCTAssertTrue(req.box.hasPrefix("P2."))
    let opened = try XCTUnwrap(E2E.openWith(b("ticketKey"), String(req.box.dropFirst(3))))
    XCTAssertEqual(opened["pk"] as? String, s("phonePk")); XCTAssertEqual(opened["label"] as? String, "Apple Watch")
    XCTAssertEqual(req.pairing.hostPk, s("hostPkUrl")); XCTAssertEqual(req.pairing.relay, "http://127.0.0.1:18797")
  }
  func testHandshakeAndChannelBytesIdentical() throws {
    let pairing = Pairing(host: s("hostId"), device: s("deviceId"), name: "x", relay: "", hostPk: s("hostPkUrl"), sk: s("phoneSk"))
    let hello = try XCTUnwrap(Phone.Hello(pairing, eph: (b("phoneEphPk"), b("phoneEphSk")), now: 1760000000000))
    same(E2E.openWith(b("pairKey"), String(hello.box.dropFirst(3))), obj("h2Payload"))
    let chan = try XCTUnwrap(hello.finish(s("i2")))
    let keys = E2E.sessionKeys(ee: NaCl.scalarMult(b("phoneEphSk"), b("hostEphPk")), pairKey: b("pairKey"), phoneEph: b("phoneEphPk"), hostEph: b("hostEphPk"))
    XCTAssertEqual(B64.enc(keys.p2h), s("sessionP2h")); XCTAssertEqual(B64.enc(keys.h2p), s("sessionH2p"))
    // 手表发出的 S2 必须和 JS 发出的字节完全一样（nonce 是序号，没有随机成分）
    let fromPhone = v["s2FromPhone"] as! [[String: String]]
    for m in fromPhone { XCTAssertEqual(chan.seal(raw: Array(m["json"]!.utf8)), m["box"]!) }
    // 收电脑发来的 S2
    let fromHost = v["s2FromHost"] as! [[String: String]]
    let got = try XCTUnwrap(chan.open(fromHost[0]["box"]!))
    same(got, try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fromHost[0]["json"]!.utf8)) as? [String: Any]))
    XCTAssertNil(chan.open(fromHost[0]["box"]!), "重放要被丢掉")
    var t = Array(fromHost[0]["box"]!.utf8); t[t.count - 2] = t[t.count - 2] == 65 ? 66 : 65
    XCTAssertNil(E2E.Channel(sendKey: keys.p2h, recvKey: keys.h2p).open(String(decoding: t, as: UTF8.self)), "改过一个字节要解不开")
    XCTAssertNil(Phone.Hello(pairing, eph: (b("phoneEphPk"), b("phoneEphSk")), now: 1760000000000 + 11 * 60 * 1000)!.finish(s("i2")), "时间差超过 10 分钟不认")
  }
  func testWatchBundle() {
    let code = s("watchCode")
    XCTAssertEqual(WatchPair.lookup(code), s("watchLookup"))
    XCTAssertEqual(B64.enc(WatchPair.key(code)), s("watchKey"))
    same(WatchPair.open(code: code, blob: s("watchBlob")), obj("watchPayload"))
    XCTAssertNil(WatchPair.open(code: "000000", blob: s("watchBlob")))
  }
  func testRandomRoundTrip() {
    let kp = NaCl.boxKeyPair(); XCTAssertEqual(NaCl.boxKeyPair(fromSecretKey: kp.secretKey).publicKey, kp.publicKey)
    let key = NaCl.randomBytes(32)
    same(E2E.openWith(key, E2E.sealWith(key, ["a": 1, "b": "中文"])), ["a": 1, "b": "中文"])
  }
}
