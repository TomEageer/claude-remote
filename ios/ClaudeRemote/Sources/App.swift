// Claude 远程（iPhone）：一个薄壳，显示打包在 App 里的手机页面（和用 Safari 打开的是同一份代码）。
// 页面由 App 内的本机小服务器提供（http://127.0.0.1:端口），这样页面是「安全上下文」，扫码要的摄像头才能用；
// 中转服务器只负责转发密文，碰不到页面代码。壳只补浏览器缺的几样：摄像头权限、外链跳 Safari、弹窗。
// 配套的 Apple Watch App 随 iPhone App 一起安装（iPhone 的「Watch」App 里装）。
import SwiftUI

@main
struct ClaudeRemoteApp: App {
  @StateObject private var server = PageServer()
  var body: some Scene {
    WindowGroup {
      Group {
        if let url = server.url { WebShell(url: Self.testURL(url)).ignoresSafeArea() }
        else if let e = server.error { Text("页面服务启动失败：\(e)").padding() }
        else { ProgressView() }
      }
      .onAppear { server.start() }
    }
  }
  /// 模拟器自动化测试：用环境变量带上配对链接的 # 部分，直接走配对
  static func testURL(_ u: URL) -> URL {
    #if DEBUG
    if let h = ProcessInfo.processInfo.environment["CR_TEST_HASH"], let x = URL(string: u.absoluteString + "#" + h) { return x }
    #endif
    return u
  }
}
