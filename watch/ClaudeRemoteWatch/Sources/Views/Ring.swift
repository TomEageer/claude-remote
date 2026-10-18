// 三端同一套符号：呼吸 = 思考 / 进行中，转圈 = 操作，实心带光晕 = 等你，绿 = 完成，红 = 出错，灰 = 空闲
import SwiftUI

enum RingState { case idle, think, act, wait, done, error }

struct Ring: View {
  var state: RingState
  var size: CGFloat = 16
  @State private var phase = false
  @State private var spin = false
  static let accent = Color(red: 0.85, green: 0.47, blue: 0.34)
  var color: Color {
    switch state { case .done: return .green; case .error: return .red; case .idle: return .gray.opacity(0.55); default: return Self.accent }
  }
  var body: some View {
    ZStack {
      if state == .act {
        Circle().trim(from: 0.12, to: 0.88).stroke(color, style: StrokeStyle(lineWidth: size * 0.26, lineCap: .round))
          .rotationEffect(.degrees(spin ? 360 : 0))
          .onAppear { withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { spin = true } }
      } else if state == .wait {
        Circle().fill(color).shadow(color: color.opacity(0.7), radius: size * 0.35)
      } else {
        Circle().stroke(color, lineWidth: size * 0.26)
          .scaleEffect(state == .think ? (phase ? 1 : 0.74) : 1)
          .opacity(state == .think ? (phase ? 1 : 0.7) : 1)
          .onAppear { if state == .think { withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { phase = true } } }
      }
    }
    .frame(width: size, height: size)
  }
}

extension SessionRow {
  var ring: RingState {
    if !pending.isEmpty { return .wait }
    if running { return .think }
    if unread == "error" { return .error }
    if unread == "done" { return .done }
    return .idle
  }
}
