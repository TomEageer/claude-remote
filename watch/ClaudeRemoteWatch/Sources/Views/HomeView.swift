// 首页：电脑名 + 对话列表（等你处理 > 正在跑 > 刚完成没看 > 其他），往下滚是快捷输入；底栏：设置 / 新对话
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
        Text(store.secured ? "还没有对话，点下面「新对话」" : " ").foregroundStyle(.secondary).font(.footnote)
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
      if !store.info.phrases.isEmpty {
        Section {
          ForEach(store.info.phrases, id: \.self) { p in
            Button { fire(p) } label: { Text(p).font(.system(size: 14)).lineLimit(2) }
          }
        } header: {
          Text(store.lastOpened == nil ? "快捷输入 · 发到新对话" : "快捷输入 · 发到「\(store.sessionTitle(store.lastOpened) ?? "新对话")」").font(.caption2)
        }
      }
    }
    .opacity(store.hostOnline ? 1 : 0.55)
    .navigationTitle(store.info.name)
    .toolbar {
      ToolbarItemGroup(placement: .bottomBar) {
        NavigationLink(value: Route.settings) { Image(systemName: "gearshape") }
        Spacer()
        NavigationLink(value: Route.reply(nil)) { Label("新对话", systemImage: "plus.bubble") }.tint(Ring.accent)
      }
    }
    .refreshable { await store.loadList() }
  }
  /// 快捷短语：直接发到最近看的对话（没有就开新对话），发完跳进去看状态
  func fire(_ p: String) {
    let sid = store.lastOpened
    Task {
      if let e = await store.send(p, sid: sid) { store.toast(e) }
      else if let s = store.lastOpened { store.toast("已发出"); store.path.append(Route.chat(s)) }
    }
  }
}
