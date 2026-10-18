// 快捷短语：点一下直接发到最近看的对话（没有就开新对话），不二次确认
import SwiftUI

struct PhrasesView: View {
  @EnvironmentObject var store: Store
  @State private var sent: String?
  var body: some View {
    let list = store.info.phrases
    ScrollView {
      if let s = sent { Text(s).font(.caption2).foregroundStyle(.secondary).padding(.bottom, 4) }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 70), spacing: 6)], spacing: 6) {
        ForEach(list, id: \.self) { p in
          Button { fire(p) } label: { Text(p).font(.system(size: 13)).lineLimit(2).frame(maxWidth: .infinity, minHeight: 34) }
            .buttonStyle(.bordered).tint(Ring.accent)
            .gridCellColumns(p.count > 6 ? 2 : 1)
        }
      }
      if list.isEmpty { Text("电脑上「设置 → 远程控制 → 手表快捷短语」可以改").font(.caption2).foregroundStyle(.secondary) }
    }
    .navigationTitle("快捷短语")
  }
  func fire(_ p: String) {
    let sid = store.lastOpened
    Task {
      if let e = await store.send(p, sid: sid) { sent = e }
      else { sent = "已发到「\(store.sessionTitle(sid) ?? "新对话")」：\(p)" }
    }
  }
}
