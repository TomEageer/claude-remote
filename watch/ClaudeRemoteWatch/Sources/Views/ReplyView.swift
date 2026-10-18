// 回复：一个「输入」按钮打开系统输入面板（键盘 / 听写），往下滚是快捷回复（点一下直接发）
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
        // 系统输入面板：键盘和听写都在里面（watchOS 10 起苹果不开放直接进听写的接口）
        TextFieldLink(prompt: Text("要说的话")) {
          HStack(spacing: 8) { Image(systemName: "keyboard"); Image(systemName: "mic.fill"); Text("输入").font(.body) }.frame(maxWidth: .infinity, minHeight: 48)
        } onSubmit: { fire($0) }
        .buttonStyle(.borderedProminent).tint(Ring.accent)
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
