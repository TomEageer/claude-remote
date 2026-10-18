// 设置：电脑列表（切换 / 看详情 / 取消配对）、添加电脑、版本
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var store: Store
  var body: some View {
    List {
      Section("电脑") {
        ForEach(store.pairings, id: \.device) { p in
          let key = Store.key(p)
          let cur = key == store.currentKey
          NavigationLink(value: Route.computer(key)) {
            HStack(spacing: 8) {
              Image(systemName: cur ? "checkmark.circle.fill" : "circle").foregroundStyle(cur ? Ring.accent : .secondary)
              VStack(alignment: .leading, spacing: 2) {
                Text(p.name).font(.system(size: 15)).lineLimit(1)
                Text(cur ? (store.hostOnline ? (store.secured ? "正在用 · 在线" : "正在用 · 加密中…") : "正在用 · 不在线") : "点开切换").font(.caption2).foregroundStyle(.secondary)
              }
            }
          }
        }
        NavigationLink(value: Route.pair) { Label("添加电脑", systemImage: "plus") }
      }
      Section("关于") {
        Text("手表 \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")").font(.caption)
        if !store.info.hostVersion.isEmpty { Text("电脑 \(store.info.hostVersion)").font(.caption) }
        Text("端到端加密：中转只转发密文").font(.caption2).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("设置")
  }
}

struct ComputerView: View {
  @EnvironmentObject var store: Store
  let key: String
  @State private var confirmUnpair = false
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    if let p = store.pairingFor(key) {
      let cur = key == store.currentKey
      List {
        Text(p.name).font(.headline)
        Text("中转 \(p.relay.replacingOccurrences(of: "https://", with: ""))").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        if cur {
          Text(store.hostOnline ? (store.secured ? "在线 · 加密连接已建立" : "在线 · 正在加密…") : (store.conn == .on ? "电脑不在线" : "正在连接中转…")).font(.caption)
        } else {
          Button { store.switchTo(key) } label: { Label("切换到这台", systemImage: "arrow.left.arrow.right") }.tint(Ring.accent)
        }
        Button(role: .destructive) { confirmUnpair = true } label: { Label("取消配对", systemImage: "trash") }
      }
      .navigationTitle("电脑")
      .confirmationDialog("取消和「\(p.name)」的配对？要再用得在电脑上重新添加", isPresented: $confirmUnpair, titleVisibility: .visible) {
        Button("取消配对", role: .destructive) { store.unpair(key, msg: "已取消配对"); if !store.pairings.isEmpty { dismiss() } }
        Button("保留", role: .cancel) {}
      }
    } else {
      Text("这台电脑已经不在了").foregroundStyle(.secondary)
    }
  }
}
