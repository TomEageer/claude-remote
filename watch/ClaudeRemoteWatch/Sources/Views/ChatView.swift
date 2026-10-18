// 进对话：在等你就先给处理卡片；否则给「刚才的回复」摘要
import SwiftUI

struct ChatView: View {
  @EnvironmentObject var store: Store
  let sid: String
  @State private var detail: ChatDetail?
  @State private var result: String?
  @State private var busy = false
  @State private var err: String?
  var body: some View {
    ScrollView {
      if let d = detail {
        VStack(alignment: .leading, spacing: 8) {
          if let r = result { Text(r).font(.footnote).foregroundStyle(.secondary) }
          else if let p = d.pending { pendingCard(p) }
          summary(d)
        }
      } else { ProgressView() }
    }
    .navigationTitle(detail?.title ?? store.sessionTitle(sid) ?? "对话")
    .task { await reload() }
    .onAppear { store.onChatPush = { s in if s == sid { Task { await reload() } } } }
    .onDisappear { if store.watchingSid == sid { store.watchingSid = nil } }
  }
  func reload() async { detail = await store.openChat(sid) }

  @ViewBuilder func pendingCard(_ p: PendingItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      switch p.kind {
      case .perm:
        Text("想\(p.label)").font(.headline)
        if !p.detail.isEmpty { Text(p.detail).font(.system(size: 12, design: .monospaced)).lineLimit(6).padding(6).background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8)) }
        if !p.reason.isEmpty { Text(p.reason).font(.caption2).foregroundStyle(.secondary) }
        acts(no: "拒绝", yes: "按住允许") { await store.answerPerm(p, allow: false) } yes: { await store.answerPerm(p, allow: true) } done: { "已\($0 ? "允许" : "拒绝")" }
      case .plan:
        let steps = p.planSteps
        Text("计划写好了\(steps.isEmpty ? "" : " · \(steps.count) 步")").font(.headline)
        ForEach(Array(steps.prefix(12).enumerated()), id: \.offset) { i, s in Text("\(i + 1). \(s)").font(.caption).lineLimit(2) }
        if steps.isEmpty { Text(p.detail).font(.caption).lineLimit(8) }
        acts(no: "再想想", yes: "按住批准") { await store.answerPlan(p, approve: false) } yes: { await store.answerPlan(p, approve: true) } done: { $0 ? "已批准" : "已退回，让 Claude 等你在手机上补意见" }
      case .ask:
        askCard(p)
      }
      if let e = err { Text(e).font(.caption2).foregroundStyle(.red) }
    }
    .padding(8)
    .background(Ring.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
  }

  func acts(no: String, yes: String, no act: @escaping () async -> String?, yes yesAct: @escaping () async -> String?, done: @escaping (Bool) -> String) -> some View {
    HStack(spacing: 6) {
      Button(no) { run(false, act, done) }.buttonStyle(.bordered).disabled(busy)
      HoldButton(title: yes) { run(true, yesAct, done) }.disabled(busy)
    }
  }
  func run(_ v: Bool, _ act: @escaping () async -> String?, _ done: @escaping (Bool) -> String) {
    busy = true; err = nil
    Task { if let e = await act() { err = e } else { result = done(v) }; busy = false }
  }

  @State private var picked: String?
  @ViewBuilder func askCard(_ p: PendingItem) -> some View {
    if let q = p.questions.first {
      Text(q.question).font(.subheadline)
      if q.multiSelect || p.questions.count > 1 || q.options.isEmpty {
        Text("这个问题要选多项或者有多个问题，请在手机或电脑上回答").font(.caption2).foregroundStyle(.secondary)
      } else {
        ForEach(q.options) { o in
          Button { picked = o.label } label: {
            HStack { Image(systemName: picked == o.label ? "largecircle.fill.circle" : "circle").foregroundStyle(Ring.accent); Text(o.label).font(.caption).lineLimit(2) }
          }.buttonStyle(.plain)
        }
        Button("就这么办") { if let a = picked { run(true, { await store.answerAsk(p, answers: [q.question: a]) }, { _ in "已回答「\(a)」" }) } }
          .buttonStyle(.borderedProminent).tint(Ring.accent).disabled(picked == nil || busy)
      }
    }
  }

  func summary(_ d: ChatDetail) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) { Ring(state: d.running ? .think : .idle, size: 12); Text(d.running ? "正在进行" : "刚才的回复").font(.caption).foregroundStyle(.secondary) }
      if !d.lastText.isEmpty { Text(d.lastText).font(.footnote).padding(8).background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10)) }
      if d.outputs > 0 { Text("生成 \(d.outputs) 个文件 · 手机上看").font(.caption2).foregroundStyle(.secondary) }
      NavigationLink(value: Route.dictate(sid)) { Label("回一句", systemImage: "mic.fill") }.tint(Ring.accent)
    }
  }
}
