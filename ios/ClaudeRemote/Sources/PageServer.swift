// 本机小 HTTP 服务器：只监听 127.0.0.1、只读 App 自带的 mobile/ 文件夹、只支持 GET。
// 端口固定（页面的配对信息存在 localStorage，按「地址 + 端口」隔离，端口变了数据就找不到了）。
import Foundation
import Network

final class PageServer: ObservableObject {
  static let port: UInt16 = 17373
  @Published var url: URL?
  @Published var error: String?
  private var listener: NWListener?
  private let root: URL? = Bundle.main.resourceURL?.appendingPathComponent("mobile", isDirectory: true)

  func start() {
    guard listener == nil else { return }
    do {
      let params = NWParameters.tcp
      params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
      params.allowLocalEndpointReuse = true
      let l = try NWListener(using: params)
      l.newConnectionHandler = { [weak self] c in self?.serve(c) }
      l.stateUpdateHandler = { [weak self] st in
        DispatchQueue.main.async {
          switch st {
          case .ready: self?.url = URL(string: "http://127.0.0.1:\(Self.port)/index.html")
          case .failed(let e): self?.error = e.localizedDescription; self?.listener = nil
          default: break
          }
        }
      }
      l.start(queue: DispatchQueue(label: "page-server"))
      listener = l
    } catch { self.error = error.localizedDescription }
  }

  private func serve(_ c: NWConnection) {
    c.start(queue: DispatchQueue(label: "page-conn"))
    read(c, Data())
  }
  private func read(_ c: NWConnection, _ acc: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, done, err in
      guard let self, err == nil, let data else { c.cancel(); return }
      var buf = acc; buf.append(data)
      if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
        self.respond(c, head)
      } else if done || buf.count > 65536 { c.cancel() }
      else { self.read(c, buf) }
    }
  }
  private func respond(_ c: NWConnection, _ head: String) {
    let line = head.split(separator: "\r\n").first.map(String.init) ?? ""
    let parts = line.split(separator: " ")
    let method = parts.first.map(String.init) ?? ""
    var path = parts.count > 1 ? String(parts[1]) : "/"
    if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
    path = path.removingPercentEncoding ?? path
    if path.hasSuffix("/") { path += "index.html" }
    guard method == "GET" || method == "HEAD" else { return send(c, 405, "text/plain", Data("method not allowed".utf8)) }
    // 只允许读 mobile/ 里面的文件，不许用 .. 往上爬
    let comps = path.split(separator: "/").map(String.init)
    guard !comps.contains(".."), !comps.contains(where: { $0.hasPrefix(".") }), let root else { return send(c, 404, "text/plain", Data("not found".utf8)) }
    let file = comps.reduce(root) { $0.appendingPathComponent($1) }
    guard let data = try? Data(contentsOf: file) else { return send(c, 404, "text/plain", Data("not found".utf8)) }
    send(c, 200, Self.mime(file.pathExtension), method == "HEAD" ? Data() : data, length: data.count)
  }
  private func send(_ c: NWConnection, _ code: Int, _ type: String, _ body: Data, length: Int? = nil) {
    let reason = ["200": "OK", "404": "Not Found", "405": "Method Not Allowed"][String(code)] ?? "OK"
    var out = Data("HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(length ?? body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
    out.append(body)
    c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
  }
  static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js": return "application/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json", "webmanifest": return "application/json"
    case "png": return "image/png"
    case "svg": return "image/svg+xml"
    case "ico": return "image/x-icon"
    case "woff2": return "font/woff2"
    default: return "application/octet-stream"
    }
  }
}
