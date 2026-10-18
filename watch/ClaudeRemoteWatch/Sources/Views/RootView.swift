import SwiftUI

struct RootView: View {
  @EnvironmentObject var store: Store
  var body: some View {
    ZStack(alignment: .bottom) {
      if store.pairing == nil || store.pairStage == .done { PairView() }
      else { NavigationStack(path: $store.path) { HomeView() } }
      if let t = store.toastText {
        Text(t).font(.footnote).padding(.horizontal, 10).padding(.vertical, 6).background(.ultraThinMaterial, in: Capsule()).padding(.bottom, 4)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.easeOut(duration: 0.2), value: store.toastText)
  }
}
