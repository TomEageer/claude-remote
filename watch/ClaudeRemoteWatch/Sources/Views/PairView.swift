// 配对：中转地址 → 6 位配对码 → 显示 4 位核对数字（在电脑上确认）→ 成功。第一次用和从设置里「添加电脑」都走这里
import SwiftUI

struct PairFlow: View {
  @EnvironmentObject var store: Store
  @State private var relay = ""
  @State private var code = ""
  var body: some View {
    Group {
      switch store.pairStage {
      case .idle: entry
      case .fetching: ProgressView("正在取配对包…")
      case .waitingConfirm(let pin): confirm(pin)
      case .done: done
      case .failed(let msg): failed(msg)
      }
    }
    .onAppear { relay = store.relayDefault; if !store.pairings.isEmpty { store.adding = true } }
    .onDisappear { if store.adding && store.pairStage != .done { store.cancelPairing(); store.adding = false } }
  }

  var entry: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("在电脑上：设置 → 远程控制 → 添加 Apple Watch").font(.footnote).foregroundStyle(.secondary)
        TextField("中转地址", text: $relay).textInputAutocapitalization(.never).autocorrectionDisabled()
        Text("例如 relay.example.com").font(.caption2).foregroundStyle(.secondary)
        NavigationLink("输入 6 位配对码") { CodePad(code: $code) { c in store.startPairing(relay: relay, code: c) } }
          .buttonStyle(.borderedProminent).tint(Ring.accent)
          .disabled(relay.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
  }
  func confirm(_ pin: String) -> some View {
    VStack(spacing: 8) {
      Text("电脑上显示的数字是这个吗？").font(.footnote).multilineTextAlignment(.center)
      Text(pin).font(.system(size: 40, weight: .semibold, design: .rounded)).kerning(4)
      Text("一样就在电脑上点「一样，配对」").font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
      Button("取消") { store.cancelPairing() }
    }
  }
  var done: some View {
    VStack(spacing: 10) {
      Ring(state: .done, size: 44)
      Text("已连上「\(store.pairing?.name ?? "电脑")」").font(.headline).multilineTextAlignment(.center)
      Button("开始用") { store.pairStage = .idle; store.adding = false; store.path = NavigationPath() }.buttonStyle(.borderedProminent).tint(Ring.accent)
    }
  }
  func failed(_ msg: String) -> some View {
    ScrollView {
      VStack(spacing: 10) {
        Text(msg).font(.footnote).multilineTextAlignment(.center)
        Button("重试") { code = ""; store.pairStage = .idle }.buttonStyle(.borderedProminent).tint(Ring.accent)
      }
    }
  }
}

/// 数字键盘：满 6 位自动提交
struct CodePad: View {
  @Binding var code: String
  let submit: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    VStack(spacing: 4) {
      Text(code.isEmpty ? "······" : code.padding(toLength: 6, withPad: "·", startingAt: 0))
        .font(.system(size: 22, weight: .semibold, design: .monospaced)).kerning(3).frame(height: 28)
      let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["清除", "0", "删除"]]
      ForEach(rows, id: \.self) { row in
        HStack(spacing: 4) {
          ForEach(row, id: \.self) { k in
            Button { tap(k) } label: { Text(k).font(.system(size: k.count > 1 ? 12 : 18, weight: .medium)).frame(maxWidth: .infinity, minHeight: 30) }
              .buttonStyle(.bordered).tint(k.count > 1 ? .gray : Ring.accent)
          }
        }
      }
    }
    .navigationTitle("配对码")
    .onAppear { code = "" }
  }
  private func tap(_ k: String) {
    if k == "清除" { code = ""; return }
    if k == "删除" { if !code.isEmpty { code.removeLast() }; return }
    guard code.count < 6 else { return }
    code += k
    if code.count == 6 { let c = code; dismiss(); submit(c) }
  }
}
