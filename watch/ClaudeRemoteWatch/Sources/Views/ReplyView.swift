// 回复：左边键盘输入、右边语音输入，往下滚是快捷回复（点一下直接发）
import SwiftUI
import WatchKit

struct ReplyView: View {
  @EnvironmentObject var store: Store
  let sid: String?            // 空 = 新对话
  @State private var sending = false
  @State private var err: String?
  var body: some View {
    let target = store.sessionTitle(sid)
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(target.map { "回复「\($0)」" } ?? "开始新对话").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        HStack(spacing: 8) {
          TextFieldLink(prompt: Text("要说的话")) {
            VStack(spacing: 4) { Image(systemName: "keyboard").font(.title3); Text("输入").font(.caption2) }.frame(maxWidth: .infinity, minHeight: 56)
          } onSubmit: { fire($0) }
          .buttonStyle(.bordered)
          Button { dictate() } label: {
            VStack(spacing: 4) { Image(systemName: "mic.fill").font(.title3); Text("语音").font(.caption2) }.frame(maxWidth: .infinity, minHeight: 56)
          }
          .buttonStyle(.borderedProminent).tint(Ring.accent)
        }
        .disabled(sending)
        if sending { HStack(spacing: 6) { ProgressView().controlSize(.small); Text("正在发送…").font(.caption2).foregroundStyle(.secondary) } }
        if let e = err { Text(e).font(.caption2).foregroundStyle(.red) }
        Text("快捷回复").font(.caption2).foregroundStyle(.secondary).padding(.top, 4)
        if store.info.phrases.isEmpty { Text("电脑上「设置 → 远程控制 → 手表快捷短语」可以改").font(.caption2).foregroundStyle(.secondary) }
        ForEach(store.info.phrases, id: \.self) { p in
          Button { fire(p) } label: { Text(p).font(.system(size: 14)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading) }
            .buttonStyle(.bordered).disabled(sending)
        }
      }
    }
    .navigationTitle("回复")
    #if DEBUG
    .onAppear { if ProcessInfo.processInfo.environment["CR_TEST_DICTATE"] != nil { NSLog("CRTEST visibleInterfaceController=%@", WKExtension.shared().visibleInterfaceController.map { "\($0)" } ?? "nil"); dictate() } }
    #endif
  }

  /// 系统听写：不给候选词就直接进入听写界面；SwiftUI 的 App 里拿不到界面控制器时退回键盘（里面也有话筒）
  func dictate() {
    guard let c = WKExtension.shared().visibleInterfaceController else { err = "这块手表上打不开听写，请用左边「输入」，键盘里也有话筒"; return }
    c.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { res in
      if let s = res?.first as? String { fire(s) }
    }
  }

  func fire(_ raw: String) {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, !sending else { return }
    sending = true; err = nil
    Task {
      if let e = await store.send(t, sid: sid) { err = e; sending = false; return }
      sending = false
      WKInterfaceDevice.current().play(.click)
      store.toast("已发出")
      // 回到对话页看状态：新对话就换成新对话的页面
      if sid == nil, let s = store.lastOpened { store.path = NavigationPath(); store.path.append(Route.chat(s)) }
      else if !store.path.isEmpty { store.path.removeLast() }
    }
  }
}
