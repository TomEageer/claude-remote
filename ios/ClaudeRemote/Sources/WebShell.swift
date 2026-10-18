// 网页容器：WKWebView 显示本机地址上的页面。摄像头直接放行（只有扫码会用）、外部链接交给 Safari、alert/confirm 用系统弹窗
import SwiftUI
import WebKit

struct WebShell: UIViewRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.allowsInlineMediaPlayback = true
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.applicationNameForUserAgent = "ClaudeRemoteiOS/1.0"
    // 页面靠这个全局对象知道自己在 App 里（扫到的配对链接不跳转，直接配对；不注册 service worker）
    cfg.userContentController.addUserScript(WKUserScript(source: "window.ClaudeRemoteApp = { ios: true };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let w = WKWebView(frame: .zero, configuration: cfg)
    w.navigationDelegate = context.coordinator
    w.uiDelegate = context.coordinator
    w.scrollView.contentInsetAdjustmentBehavior = .never // 页面自己处理刘海和底部安全区
    w.scrollView.bounces = false
    w.isOpaque = false
    w.backgroundColor = .clear
    context.coordinator.web = w
    w.load(URLRequest(url: url))
    return w
  }
  func updateUIView(_ w: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var web: WKWebView?
    static func isLocal(_ u: URL?) -> Bool { u?.host == "127.0.0.1" && u?.port == Int(PageServer.port) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      let u = action.request.url
      if Self.isLocal(u) || u?.scheme == "about" || u?.scheme == "blob" { return decisionHandler(.allow) }
      // 页面之外的链接（文档、GitHub、授权链接等）交给系统浏览器
      if let u, ["http", "https", "mailto"].contains(u.scheme ?? "") { UIApplication.shared.open(u) }
      decisionHandler(.cancel)
    }
    // target=_blank
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      if let u = action.request.url { if Self.isLocal(u) { webView.load(action.request) } else { UIApplication.shared.open(u) } }
      return nil
    }
    // 扫码要摄像头：页面只在扫二维码时申请，直接放行（系统仍会第一次弹相机权限）
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
      decisionHandler(type == .camera && origin.host == "127.0.0.1" ? .grant : .deny)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
      present(message, cancel: false) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
      present(message, cancel: true, completionHandler)
    }
    private func present(_ message: String, cancel: Bool, _ done: @escaping (Bool) -> Void) {
      guard let vc = topVC() else { return done(true) }
      let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      if cancel { a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in done(false) }) }
      a.addAction(UIAlertAction(title: "好", style: .default) { _ in done(true) })
      vc.present(a, animated: true)
    }
    private func topVC() -> UIViewController? {
      var v = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
      while let p = v?.presentedViewController { v = p }
      return v
    }
    // 网页进程被系统回收（长时间后台）：重新加载
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
  }
}
