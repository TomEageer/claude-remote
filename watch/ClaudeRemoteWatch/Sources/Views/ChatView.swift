// 进对话：顶上一行状态；在等你就先给处理卡片；然后是你最后说的 + Claude 最后回的（各最多两三行，点开看全文）；底下「回复」
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
      VStack(alignment: .leading, spacing: 8) {
        statusLine
        if let d = detail {
          if let r = result { Text(r).font(.footnote).foregroundStyle(.secondary) }
          else if let p = d.pending { pendingCard(p) }
          if !d.lastUser.isEmpty { bubble("你", d.lastUser, lines: 2, mine: true) }
          if !d.lastText.isEmpty { bubble("Claude", d.lastText, lines: 3, mine: false) }
          else if d.running { Text("Claude 还没开口…").font(.caption2).foregroundStyle(.secondary) }
          if d.outputs > 0 { Text("生成 \(d.outputs) 个文件 · 手机或电脑上看").font(.caption2).foregroundStyle(.secondary) }
        } else { ProgressView().frame(maxWidth: .infinity) }
      }
    }
    .navigationTitle(detail?.title ?? store.sessionTitle(sid) ?? "对话")
    .toolbar {
      ToolbarItem(placement: .bottomBar) {
        NavigationLink(value: Route.reply(sid)) { Label("回复", systemImage: "arrowshape.turn.up.left") }.tint(Ring.accent)
      }
    }
    .task { await reload() }
    .onAppear { store.onChatPush = { s in if s == sid { Task { await reload() } } }; if detail != nil { Task { await reload() } } }
    .onDisappear { if store.watchingSid == sid { store.watchingSid = nil } }
  }
  func reload() async { if let d = await store.openChat(sid) { detail = d; if d.pending == nil { result = nil } } }

  /// 状态行：列表推送来的实时状态优先（正在进行 / 等你允许 / 已完成…）
  var statusLine: some View {
    let row = store.sessions.first { $0.id == sid }
    let running = row?.running ?? detail?.running ?? false
    let text: String = {
      if let p = detail?.pending, result == nil { return ["perm": "等你允许", "plan": "等你批准", "ask": "等你回答"][p.kind.rawValue] ?? "等你处理" }
      if let t = row?.statusText, !t.isEmpty { return t }
      if running { return "正在进行" }
      if detail?.error == true { return "出错了" }
      return detail == nil ? "正在读取…" : "已完成"
    }()
    let state: RingState = (detail?.pending != nil && result == nil) ? .wait : (row?.ring ?? (running ? .think : (detail?.error == true ? .error : .done)))
    return HStack(spacing: 6) { Ring(state: state == .idle ? .done : state, size: 12); Text(text).font(.caption).foregroundStyle(.secondary) }
  }

  /// 一条消息只露两三行，点一下看全文
  func bubble(_ who: String, _ text: String, lines: Int, mine: Bool) -> some View {
    NavigationLink(value: Route.text(who, text)) {
      VStack(alignment: .leading, spacing: 2) {
        Text(who).font(.caption2).foregroundStyle(mine ? Ring.accent : .secondary)
        Text(text).font(.footnote).lineLimit(lines).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(8)
      .background((mine ? Ring.accent : Color.white).opacity(mine ? 0.14 : 0.08), in: RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder func pendingCard(_ p: PendingItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      switch p.kind {
      case .perm:
        Text("想\(p.label)").font(.headline)
        if !p.detail.isEmpty {
          NavigationLink(value: Route.text(p.label, p.detail)) {
            Text(p.detail).font(.system(size: 12, design: .monospaced)).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading).padding(6).background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
          }.buttonStyle(.plain)
        }
        if !p.reason.isEmpty { Text(p.reason).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
        acts(no: "拒绝", yes: "按住允许") { await store.answerPerm(p, allow: false) } yes: { await store.answerPerm(p, allow: true) } done: { "已\($0 ? "允许" : "拒绝")" }
      case .plan:
        let steps = p.planSteps
        Text("计划写好了\(steps.isEmpty ? "" : " · \(steps.count) 步")").font(.headline)
        NavigationLink(value: Route.text("计划", p.detail)) {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(steps.prefix(3).enumerated()), id: \.offset) { i, s in Text("\(i + 1). \(s)").font(.caption).lineLimit(1) }
            if steps.isEmpty { Text(p.detail).font(.caption).lineLimit(3) }
            if steps.count > 3 { Text("…还有 \(steps.count - 3) 步，点开看").font(.caption2).foregroundStyle(.secondary) }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
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
      Text(q.question).font(.subheadline).lineLimit(4)
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
}

/// 看全文：滚动阅读
struct FullTextView: View {
  let title: String
  let body_: String
  init(title: String, body: String) { self.title = title; body_ = body }
  var body: some View {
    ScrollView { Text(body_).font(.footnote).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 2) }
      .navigationTitle(title)
  }
}
