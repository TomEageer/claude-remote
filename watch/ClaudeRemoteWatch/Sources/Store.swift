// 手表端的状态中心：配对、连中转、加密握手、收发消息、对话列表。协议和手机页面（mobile/app.js）完全一致
import Foundation
import SwiftUI
import WatchKit
import ClaudeRemoteCore

@MainActor
final class Store: ObservableObject {
  enum Conn { case off, connecting, on }
  enum PairStage: Equatable { case idle, fetching, waitingConfirm(String), done, failed(String) }
  /// 手表要用到的功能（快捷短语下发等）从这个电脑端版本开始有
  static let needHost = "1.9.10"

  /// 配好的所有电脑；当前用哪台由 currentKey 决定（host|device）
  @Published var pairings: [Pairing] = []
  @Published var currentKey: String? { didSet { UserDefaults.standard.set(currentKey, forKey: "current") } }
  var pairing: Pairing? { pairings.first { Self.key($0) == currentKey } ?? pairings.first }
  static func key(_ p: Pairing) -> String { p.host + "|" + p.device }
  /// 已经有电脑了，正在从设置里再添加一台
  @Published var adding = false
  @Published var conn: Conn = .off
  @Published var hostOnline = false
  @Published var secured = false
  @Published var replaced = false
  @Published var hostTooOld = false
  @Published var sessions: [SessionRow] = []
  @Published var info = HostInfo()
  @Published var pairStage: PairStage = .idle
  @Published var lastOpened: String?
  @Published var toastText: String?
  @Published var path = NavigationPath()

  var relayDefault: String {
    get { UserDefaults.standard.string(forKey: "relay") ?? "" }
    set { UserDefaults.standard.set(newValue, forKey: "relay") }
  }

  private let client = RelayClient()
  private var chan: E2E.Channel?
  private var hello: Phone.Hello?
  private var hsTries = 0
  private var reqSeq = 0
  private var waiting: [Int: CheckedContinuation<JSONObject, Never>] = [:]
  private var retry = 0
  private var retryTask: Task<Void, Never>?
  private var pairingReq: Phone.PairRequest?
  private var pairSent = false
  var watchingSid: String?
  var onChatPush: ((String) -> Void)?

  init() {
    if let d = Keychain.load(account: "pairings"), let l = try? JSONDecoder().decode([Pairing].self, from: d) { pairings = l }
    else if let d = Keychain.load(account: "pairing"), let p = try? JSONDecoder().decode(Pairing.self, from: d) {
      pairings = [p]; savePairings(); Keychain.delete(account: "pairing") // 老版本只存一台
    }
    currentKey = UserDefaults.standard.string(forKey: "current") ?? pairings.first.map(Self.key)
    client.onOpen = { [weak self] in self?.onOpen() }
    client.onMessage = { [weak self] s in self?.onFrame(s) }
    client.onClose = { [weak self] r in self?.onClosed(r) }
    if pairing != nil { connect() }
    #if DEBUG
    // 模拟器自动化测试：用环境变量直接走配对，不用在小屏幕上敲
    let env = ProcessInfo.processInfo.environment
    if env["CR_TEST_RESET"] != nil { Keychain.delete(account: "pairings"); Keychain.delete(account: "pairing"); pairings = []; currentKey = nil; client.close(); conn = .off }
    if let relay = env["CR_TEST_RELAY"], let code = env["CR_TEST_CODE"] { adding = pairing != nil; if adding { path.append(Route.pair) }; startPairing(relay: relay, code: code) }
    #endif
  }

  // ---------- 连接 ----------
  private var who: (host: String, device: String, relay: String)? {
    if let r = pairingReq { return (r.pairing.host, r.pairing.device, r.pairing.relay.isEmpty ? relayDefault : r.pairing.relay) }
    if let p = pairing { return (p.host, p.device, p.relay) }
    return nil
  }
  static func httpBase(_ relay: String) -> String {
    var u = relay.trimmingCharacters(in: .whitespacesAndNewlines)
    while u.hasSuffix("/") { u.removeLast() }
    if !u.lowercased().hasPrefix("http://") && !u.lowercased().hasPrefix("https://") { u = "https://" + u }
    return u
  }
  func connect() {
    guard let w = who else { return }
    retryTask?.cancel()
    conn = .connecting; chan = nil; hello = nil; secured = false
    let base = Self.httpBase(w.relay)
    guard let url = URL(string: base.replacingOccurrences(of: "http", with: "ws", options: [.anchored]) + "/ws") else { conn = .off; return }
    client.connect(url)
  }
  private func onOpen() {
    guard let w = who else { return }
    client.send(Self.json(["t": "client", "hostId": w.host, "deviceId": w.device]))
  }
  private func onClosed(_ reason: String?) {
    conn = .off; hostOnline = false; chan = nil; hello = nil; secured = false
    replaced = reason == "replaced"
    failInflight("连接断了，没发出去，请再试一次")
    guard who != nil else { return }
    let delay = replaced ? 20.0 : min(8.0, 0.5 * pow(2.0, Double(retry)))
    retry += 1
    retryTask?.cancel()
    retryTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
      guard !Task.isCancelled else { return }
      self?.connect()
    }
  }
  private func failInflight(_ msg: String) {
    let ws = waiting; waiting = [:]
    for (_, c) in ws { c.resume(returning: ["ok": false, "message": msg]) }
  }

  private func onFrame(_ s: String) {
    guard let d = s.data(using: .utf8), let f = (try? JSONSerialization.jsonObject(with: d)) as? JSONObject, let t = f["t"] as? String else { return }
    switch t {
    case "ok":
      conn = .on; retry = 0; replaced = false
      hostOnline = (f["hostOnline"] as? Bool) ?? false
      if pairingReq != nil { if hostOnline { sendPairRequest() } else { pairStage = .failed("「电脑」不在线：电脑上的 Claude 远程助手要开着，并且连上了中转") } }
      else if hostOnline { handshake() }
    case "host-online":
      hostOnline = true
      if pairingReq != nil { sendPairRequest() } else { handshake() }
    case "host-offline":
      hostOnline = false; chan = nil; hello = nil; secured = false
      failInflight("电脑不在线")
    case "revoked":
      if pairingReq != nil { pairStage = .failed("电脑上已经没有这块手表了：在电脑上重新点「添加 Apple Watch」") ; cancelPairing(keepStage: true) }
      else if let p = pairing { unpair(Self.key(p), msg: "「\(p.name)」已经撤销了这块手表，要再用请在电脑上重新添加") }
    case "msg":
      guard let box = f["box"] as? String else { return }
      if pairingReq != nil { onPairFrame(box); return }
      if box == "R2" { chan = nil; secured = false; failInflight("正在重新建立加密连接"); handshake(); return }
      if box.hasPrefix("I2.") {
        if let h = hello, let c = h.finish(box) { chan = c; hello = nil; hsTries = 0; secured = true; hostTooOld = false; refresh() }
        return
      }
      guard box.hasPrefix("S2."), let c = chan, let m = c.open(box) else { return }
      if let re = (m["re"] as? NSNumber)?.intValue { waiting.removeValue(forKey: re)?.resume(returning: m) }
      else if let push = m["push"] as? String { onPush(push, m) }
    default: break
    }
  }

  // 每次连上都先握手：生成只用这一次的临时密钥，用长期密钥加密发给电脑
  private func handshake() {
    guard client.isOpen, hostOnline, let p = pairing, let h = Phone.Hello(p) else { return }
    hello = h
    client.send(Self.json(["t": "msg", "box": h.box]))
    let mine = h
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 8_000_000_000)
      guard let self, self.hello === mine, self.chan == nil, self.client.isOpen, self.hostOnline else { return }
      self.hsTries += 1
      if self.hsTries >= 2 { self.hostTooOld = true } // 电脑不回握手：多半是电脑上的软件太旧
      self.handshake()
    }
  }

  // ---------- 请求 / 推送 ----------
  func call(_ op: String, _ args: JSONObject = [:], timeout: Double = 20) async -> JSONObject {
    guard let c = chan, client.isOpen, hostOnline else { return ["ok": false, "message": hostOnline ? "还没连上电脑，稍等一下" : "电脑不在线"] }
    reqSeq += 1
    let id = reqSeq
    var o = args; o["id"] = id; o["op"] = op
    client.send(Self.json(["t": "msg", "box": c.seal(o)]))
    return await withCheckedContinuation { cont in
      waiting[id] = cont
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9))
        self?.waiting.removeValue(forKey: id)?.resume(returning: ["ok": false, "message": "电脑没有回应，稍后再试"])
      }
    }
  }
  static func ok(_ r: JSONObject) -> Bool { (r["ok"] as? Bool) != false }
  static func msg(_ r: JSONObject) -> String { (r["message"] as? String) ?? "出错了" }

  private func refresh() { Task { await loadInfo(); await loadList() } }
  func loadInfo() async {
    let r = await call("info")
    guard Self.ok(r) else { return }
    info.name = (r["name"] as? String) ?? info.name
    info.phrases = (r["watchPhrases"] as? [String]) ?? []
    info.hostVersion = (r["hostVersion"] as? String) ?? ""
    if verOlder(info.hostVersion, Self.needHost) { hostTooOld = true }
    if let i = pairings.firstIndex(where: { Self.key($0) == currentKey }), pairings[i].name != info.name { pairings[i].name = info.name; savePairings() }
    #if DEBUG
    // 模拟器截图用：启动时直接打开某个页面
    let env = ProcessInfo.processInfo.environment
    if !testOpened {
      testOpened = true
      if let sid = env["CR_TEST_OPEN"] { path.append(env["CR_TEST_SCREEN"] == "reply" ? Route.reply(sid) : Route.chat(sid)) }
      else if env["CR_TEST_SCREEN"] == "reply" { path.append(Route.reply(nil)) }
      else if env["CR_TEST_SCREEN"] == "settings" { path.append(Route.settings) }
      else if env["CR_TEST_SCREEN"] == "computer", let p = pairing { path.append(Route.settings); path.append(Route.computer(Self.key(p))) }
    }
    #endif
  }
  private var testOpened = false
  func loadList() async {
    let r = await call("list")
    guard Self.ok(r) else { return }
    applySessions(r["sessions"])
  }
  private func applySessions(_ raw: Any?) {
    let before = Set(sessions.filter { !$0.pending.isEmpty }.map(\.id))
    let list = ((raw as? [[String: Any]]) ?? []).compactMap(SessionRow.init)
    sessions = list.sorted { a, b in a.rank != b.rank ? a.rank < b.rank : a.updatedAt > b.updatedAt }
    // 新出现的「等你处理」：震一下
    if sessions.contains(where: { !$0.pending.isEmpty && !before.contains($0.id) }) { WKInterfaceDevice.current().play(.notification) }
  }
  private func onPush(_ kind: String, _ m: JSONObject) {
    if kind == "list" { applySessions(m["sessions"]) }
    else if kind == "msgs", let sid = m["sid"] as? String, sid == watchingSid { onChatPush?(sid) }
  }

  // ---------- 对话 ----------
  func openChat(_ sid: String) async -> ChatDetail? {
    watchingSid = sid
    lastOpened = sid
    let r = await call("open", ["sid": sid])
    guard Self.ok(r) else { toast(Self.msg(r)); return nil }
    let msgs = (r["messages"] as? [[String: Any]]) ?? []
    var d = ChatDetail(title: (r["title"] as? String) ?? "", running: (r["running"] as? Bool) ?? false, lastUser: "", lastText: "", outputs: 0, error: false, pending: nil)
    if let u = msgs.last(where: { ($0["role"] as? String) == "user" }), let t = u["text"] as? String { d.lastUser = String(t.trimmingCharacters(in: .whitespacesAndNewlines).prefix(600)) }
    if let last = msgs.last, (last["role"] as? String) == "assistant", (last["error"] as? String).map({ !$0.isEmpty }) ?? false { d.error = true }
    for m in msgs.reversed() where (m["role"] as? String) == "assistant" {
      let blocks = (m["blocks"] as? [[String: Any]]) ?? []
      if d.lastText.isEmpty {
        let texts = blocks.compactMap { ($0["type"] as? String) == "text" ? ($0["text"] as? String) : nil }
        if let t = texts.last?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { d.lastText = String(t.prefix(1500)) }
        d.outputs = ((m["outputs"] as? [[String: Any]])?.count ?? 0) + ((m["otherOutputs"] as? NSNumber)?.intValue ?? 0)
      }
      if d.pending == nil {
        for b in blocks.reversed() {
          guard (b["state"] as? String) == "pending", let rid = b["requestId"] as? String, let type = b["type"] as? String else { continue }
          switch type {
          case "perm": d.pending = PendingItem(id: rid, kind: .perm, sid: sid, label: (b["label"] as? String) ?? (b["name"] as? String) ?? "操作", detail: (b["detail"] as? String) ?? "", reason: (b["reason"] as? String) ?? "", questions: [])
          case "plan": d.pending = PendingItem(id: rid, kind: .plan, sid: sid, label: "计划", detail: (b["text"] as? String) ?? "", reason: "", questions: [])
          case "ask": d.pending = PendingItem(id: rid, kind: .ask, sid: sid, label: "提问", detail: "", reason: "", questions: ((b["questions"] as? [[String: Any]]) ?? []).map(AskQuestion.init))
          default: continue
          }
          break
        }
      }
      if !d.lastText.isEmpty && d.pending != nil { break }
    }
    return d
  }
  func answerPerm(_ it: PendingItem, allow: Bool) async -> String? {
    let r = await call("perm", ["sid": it.sid, "requestId": it.id, "allow": allow])
    return Self.ok(r) ? nil : Self.msg(r)
  }
  func answerPlan(_ it: PendingItem, approve: Bool) async -> String? {
    let r = await call("plan", ["sid": it.sid, "requestId": it.id, "approve": approve])
    return Self.ok(r) ? nil : Self.msg(r)
  }
  func answerAsk(_ it: PendingItem, answers: [String: String]) async -> String? {
    let r = await call("ask", ["sid": it.sid, "requestId": it.id, "answers": answers, "skip": false])
    return Self.ok(r) ? nil : Self.msg(r)
  }
  /// sid 为空就开新对话
  func send(_ text: String, sid: String?) async -> String? {
    var a: JSONObject = ["text": text, "files": []]
    if let sid { a["sid"] = sid }
    let r = await call("send", a)
    if Self.ok(r), let s = r["sid"] as? String { lastOpened = s }
    return Self.ok(r) ? nil : Self.msg(r)
  }
  func sessionTitle(_ sid: String?) -> String? { sid.flatMap { id in sessions.first { $0.id == id }?.title } }

  func toast(_ s: String) {
    toastText = s
    Task { try? await Task.sleep(nanoseconds: 2_500_000_000); if self.toastText == s { self.toastText = nil } }
  }

  // ---------- 配对 ----------
  func startPairing(relay: String, code: String) {
    Task {
      pairStage = .fetching
      let base = Self.httpBase(relay)
      do {
        guard let url = URL(string: base + "/pair/get?id=" + WatchPair.lookup(code)) else { throw URLError(.badURL) }
        var req = URLRequest(url: url); req.timeoutInterval = 15
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let isJSON = ((resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "").contains("json")
        // 填成了手机页面地址（GitHub Pages 之类）或别的网站：那里没有配对接口，回的是网页不是 JSON
        if !isJSON { pairStage = .failed("这个地址不是中转服务器。要填的是电脑「设置 → 远程控制」里「中转地址」那一栏，不是手机页面的地址"); return }
        if status == 404 { pairStage = .failed("配对码不对或已失效（5 分钟内有效、只能用一次）：在电脑上重新生成"); return }
        if status == 429 { pairStage = .failed("试得太频繁，一分钟后再试"); return }
        guard status == 200, let j = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject, let blob = j["blob"] as? String else { pairStage = .failed("中转服务器没有返回配对包（HTTP \(status)）：地址对不对？中转程序是不是太旧？"); return }
        guard let payload = WatchPair.open(code: code, blob: blob) else { pairStage = .failed("配对码不对"); return }
        guard let r = Phone.pairRequest(bundle: payload, label: "Apple Watch") else { pairStage = .failed("配对包格式不对"); return }
        relayDefault = base
        pairingReq = r
        pairSent = false
        pairStage = .waitingConfirm(r.code)
        connect()
      } catch {
        pairStage = .failed("连不上中转服务器：\(error.localizedDescription)")
      }
    }
  }
  private func sendPairRequest() {
    guard let r = pairingReq, !pairSent else { return }
    pairSent = true
    client.send(Self.json(["t": "msg", "box": r.box]))
  }
  private func onPairFrame(_ box: String) {
    guard let r = pairingReq else { return }
    if box == "X2" { pairStage = .failed("配对码已经失效（5 分钟内有效、只能用一次）：在电脑上重新生成"); cancelPairing(keepStage: true); return }
    guard let res = Phone.pairResult(r.pairing, box) else { return }
    if (res["ok"] as? Bool) != true { pairStage = .failed("电脑上没有通过配对：要配对的话在电脑上重新生成配对码"); cancelPairing(keepStage: true); return }
    var p = r.pairing
    if let n = res["name"] as? String, !n.isEmpty { p.name = n }
    pairings.removeAll { Self.key($0) == Self.key(p) }
    pairings.append(p)
    savePairings()
    currentKey = Self.key(p)
    sessions = []; info = HostInfo(); lastOpened = nil; hostTooOld = false
    pairingReq = nil
    pairStage = .done
    WKInterfaceDevice.current().play(.success)
    handshake()
  }
  func cancelPairing(keepStage: Bool = false) {
    pairingReq = nil
    pairSent = false
    if !keepStage { pairStage = .idle }
    if pairing == nil { client.close(); conn = .off; hostOnline = false }
    else if adding { connect() } // 添加没成功：连回原来那台
  }
  private func savePairings() {
    if pairings.isEmpty { Keychain.delete(account: "pairings") }
    else if let d = try? JSONEncoder().encode(pairings) { Keychain.save(d, account: "pairings") }
  }
  /// 切到另一台电脑：断开当前连接，重新连、重新握手
  func switchTo(_ key: String) {
    guard key != currentKey, pairings.contains(where: { Self.key($0) == key }) else { return }
    currentKey = key
    resetHost()
    path = NavigationPath()
    connect()
  }
  private func resetHost() {
    sessions = []; info = HostInfo(); lastOpened = nil; chan = nil; hello = nil; secured = false; hostOnline = false; hostTooOld = false; replaced = false; hsTries = 0
    failInflight("已切换电脑")
  }
  /// 取消某台电脑的配对；取消的是当前这台就切到剩下的第一台
  func unpair(_ key: String, msg: String?) {
    pairings.removeAll { Self.key($0) == key }
    savePairings()
    if key == currentKey || pairing == nil {
      resetHost()
      client.close(); conn = .off; retryTask?.cancel()
      path = NavigationPath()
      currentKey = pairings.first.map(Self.key)
      if pairing != nil { connect() }
    }
    pairStage = .idle
    if let msg { toast(msg) }
  }
  func pairingFor(_ key: String) -> Pairing? { pairings.first { Self.key($0) == key } }

  static func json(_ o: JSONObject) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes]) else { return "{}" }
    return String(decoding: d, as: UTF8.self)
  }
}
