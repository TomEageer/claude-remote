import Foundation

struct SessionRow: Identifiable, Equatable {
  let id: String
  let title: String
  let running: Bool
  let unread: String   // '' | done | error | ask
  let pending: String  // '' | ask | plan | perm
  let updatedAt: Double
  init?(_ j: [String: Any]) {
    guard let id = j["id"] as? String else { return nil }
    self.id = id
    title = (j["title"] as? String) ?? "新对话"
    running = (j["running"] as? Bool) ?? false
    unread = (j["unread"] as? String) ?? ""
    pending = (j["pending"] as? String) ?? ""
    updatedAt = (j["updatedAt"] as? NSNumber)?.doubleValue ?? 0
  }
  /// 排序：需要你处理 > 正在跑 > 刚完成没看 > 其他，同级按时间
  var rank: Int { pending.isEmpty ? (running ? 1 : (unread.isEmpty ? 3 : 2)) : 0 }
  var statusText: String {
    if !pending.isEmpty { return ["perm": "等你允许", "plan": "等你批准", "ask": "等你回答"][pending] ?? "等你处理" }
    if running { return "正在进行" }
    if unread == "error" { return "出错了 · 没看" }
    if unread == "done" { return "已完成 · 没看" }
    return ""
  }
}

struct AskOption: Identifiable { let id = UUID(); let label: String; let description: String }
struct AskQuestion: Identifiable {
  let id = UUID(); let question: String; let header: String; let options: [AskOption]; let multiSelect: Bool
  init(_ j: [String: Any]) {
    question = (j["question"] as? String) ?? ""
    header = (j["header"] as? String) ?? ""
    multiSelect = (j["multiSelect"] as? Bool) ?? false
    options = ((j["options"] as? [[String: Any]]) ?? []).map { AskOption(label: ($0["label"] as? String) ?? "", description: ($0["description"] as? String) ?? "") }
  }
}

enum PendingKind: String { case perm, plan, ask }
struct PendingItem: Identifiable {
  let id: String // requestId
  let kind: PendingKind
  let sid: String
  let label: String    // perm：操作类型
  let detail: String   // perm：命令 / 文件；plan：计划正文
  let reason: String
  let questions: [AskQuestion]
  var planSteps: [String] {
    // 计划正文里的标题行和列表项当作步骤
    detail.split(separator: "\n").map { String($0) }.compactMap { line in
      let t = line.trimmingCharacters(in: .whitespaces)
      if t.hasPrefix("#") { return t.drop { $0 == "#" || $0 == " " }.description }
      if let r = t.range(of: #"^(\d+[.)]|[-*])\s+"#, options: .regularExpression) { return String(t[r.upperBound...]) }
      return nil
    }
  }
}

struct ChatDetail {
  var title: String
  var running: Bool
  var lastText: String
  var outputs: Int
  var pending: PendingItem?
}

enum Route: Hashable { case chat(String), phrases, dictate(String?) }

struct HostInfo {
  var name: String = "我的电脑"
  var phrases: [String] = []
  var hostVersion: String = ""
}

func verOlder(_ a: String, _ b: String) -> Bool {
  let x = a.split(separator: "-")[0].split(separator: ".").map { Int($0) ?? 0 }
  let y = b.split(separator: ".").map { Int($0) ?? 0 }
  for i in 0..<3 { let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0; if p != q { return p < q } }
  return false
}
