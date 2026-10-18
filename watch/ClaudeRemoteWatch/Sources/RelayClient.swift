// 和中转的 WebSocket 连接：收发文本帧、心跳、断线通知。重连由 Store 决定
import Foundation

final class RelayClient: NSObject, URLSessionWebSocketDelegate {
  var onOpen: (() -> Void)?
  var onMessage: ((String) -> Void)?
  var onClose: ((String?) -> Void)?
  private var task: URLSessionWebSocketTask?
  private var session: URLSession?
  private var pingTimer: Timer?
  private(set) var isOpen = false

  func connect(_ url: URL) {
    close()
    let s = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    session = s
    let t = s.webSocketTask(with: url)
    task = t
    t.resume()
    receive(t)
  }

  func send(_ text: String) {
    task?.send(.string(text)) { [weak self] err in if err != nil { self?.closed(reason: nil) } }
  }

  func close() {
    pingTimer?.invalidate(); pingTimer = nil
    isOpen = false
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    session?.invalidateAndCancel()
    session = nil
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self, self.task === t else { return }
      switch result {
      case .success(let msg):
        if case .string(let s) = msg { self.onMessage?(s) }
        else if case .data(let d) = msg, let s = String(data: d, encoding: .utf8) { self.onMessage?(s) }
        self.receive(t)
      case .failure:
        self.closed(reason: nil)
      }
    }
  }

  private func closed(reason: String?) {
    guard task != nil else { return }
    let r = reason
    close()
    onClose?(r)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    isOpen = true
    pingTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: true) { [weak self] _ in self?.send("{\"t\":\"ping\"}") }
    onOpen?()
  }
  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closed(reason: reason.flatMap { String(data: $0, encoding: .utf8) })
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil { closed(reason: nil) }
  }
}
