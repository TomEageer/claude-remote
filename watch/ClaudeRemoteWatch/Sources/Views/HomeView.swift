// 首页：电脑名 + 对话列表（等你处理 > 正在跑 > 刚完成没看 > 其他）+ 底部「快捷短语」「说一句」
import SwiftUI

struct HomeView: View {
  @EnvironmentObject var store: Store
  var body: some View {
    List {
      if store.hostTooOld {
        Text("请更新电脑上的软件：设置 → 检查更新（手表需要 \(Store.needHost) 或更新）").font(.caption2).foregroundStyle(.orange)
      } else if store.replaced {
        Text("另一台设备正在用这块手表的配对，两边会互相挤掉：在电脑上为这块手表单独添加").font(.caption2).foregroundStyle(.orange)
      } else if store.conn != .on {
        Text(store.conn == .connecting ? "正在连接中转…" : "连接断开，正在重连…").font(.caption2).foregroundStyle(.secondary)
      } else if !store.hostOnline {
        Text("「\(store.info.name)」不在线：电脑上的 Claude 远程助手要开着").font(.caption2).foregroundStyle(.secondary)
      } else if !store.secured {
        Text("正在建立加密连接…").font(.caption2).foregroundStyle(.secondary)
      }
      if store.sessions.isEmpty {
        Text(store.secured ? "还没有对话" : " ").foregroundStyle(.secondary).font(.footnote)
      }
      ForEach(store.sessions) { s in
        NavigationLink(value: Route.chat(s.id)) {
          HStack(spacing: 8) {
            Ring(state: s.ring, size: 14)
            VStack(alignment: .leading, spacing: 2) {
              Text(s.title).font(.system(size: 15)).lineLimit(1)
              if !s.statusText.isEmpty { Text(s.statusText).font(.caption2).foregroundStyle(s.pending.isEmpty ? .secondary : Ring.accent) }
            }
          }
        }
      }
    }
    .opacity(store.hostOnline ? 1 : 0.55)
    .navigationTitle(store.info.name)
    .navigationDestination(for: Route.self) { r in
      switch r {
      case .chat(let sid): ChatView(sid: sid)
      case .phrases: PhrasesView()
      case .dictate(let sid): DictateView(sid: sid ?? store.lastOpened)
      }
    }
    .toolbar {
      ToolbarItemGroup(placement: .bottomBar) {
        NavigationLink(value: Route.phrases) { Image(systemName: "text.bubble") }
        Spacer()
        NavigationLink(value: Route.dictate(nil)) { Image(systemName: "mic.fill") }.tint(Ring.accent)
      }
    }
    .refreshable { await store.loadList() }
  }
}
