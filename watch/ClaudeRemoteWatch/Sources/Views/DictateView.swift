// 说一句：系统听写 → 选发到哪 → 发送
import SwiftUI

struct DictateView: View {
  @EnvironmentObject var store: Store
  let sid: String?
  @State private var text = ""
  @State private var toCurrent = true
  @State private var status: String?
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    let cur = store.sessionTitle(sid)
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        TextField("点这里说话", text: $text, axis: .vertical).lineLimit(2...5)
        if cur != nil {
          Picker("发到", selection: $toCurrent) { Text("继续「\(cur!)」").tag(true); Text("新对话").tag(false) }.pickerStyle(.navigationLink)
        } else { Text("发到：新对话").font(.caption2).foregroundStyle(.secondary) }
        if let s = status { Text(s).font(.caption2).foregroundStyle(.secondary) }
        Button("发送") {
          let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !t.isEmpty else { return }
          Task {
            if let e = await store.send(t, sid: toCurrent ? sid : nil) { status = e }
            else { store.toast("已发出"); dismiss() }
          }
        }.buttonStyle(.borderedProminent).tint(Ring.accent).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .navigationTitle("说一句")
    .onAppear { toCurrent = cur != nil }
  }
}
