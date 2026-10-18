import SwiftUI

struct RootView: View {
  @EnvironmentObject var store: Store
  var body: some View {
    ZStack(alignment: .bottom) {
      // 一台电脑都没有：只有配对流程；配好了：首页（从设置里再添加电脑走的是首页里的路由）
      if store.pairings.isEmpty || (store.pairStage == .done && !store.adding) {
        NavigationStack { PairFlow().navigationTitle("连接电脑") }
      } else {
        NavigationStack(path: $store.path) {
          HomeView().navigationDestination(for: Route.self) { r in
            switch r {
            case .chat(let sid): ChatView(sid: sid)
            case .reply(let sid): ReplyView(sid: sid)
            case .text(let title, let body): FullTextView(title: title, body: body)
            case .settings: SettingsView()
            case .computer(let key): ComputerView(key: key)
            case .pair: PairFlow().navigationTitle("添加电脑")
            }
          }
        }
      }
      if let t = store.toastText {
        Text(t).font(.footnote).padding(.horizontal, 10).padding(.vertical, 6).background(.ultraThinMaterial, in: Capsule()).padding(.bottom, 4)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.easeOut(duration: 0.2), value: store.toastText)
  }
}
