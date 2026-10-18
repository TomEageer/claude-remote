// 「按住允许」：按住 1 秒圆环填满才算，防止手腕误触（拒绝只要轻点，不对称设计）
import SwiftUI
import WatchKit

struct HoldButton: View {
  let title: String
  var color: Color = Ring.accent
  let action: () -> Void
  @State private var progress: CGFloat = 0
  @State private var timer: Timer?
  @State private var fired = false
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12).fill(color.opacity(0.28))
      GeometryReader { g in RoundedRectangle(cornerRadius: 12).fill(color).frame(width: g.size.width * progress) }
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
    }
    .frame(height: 40)
    .contentShape(Rectangle())
    .gesture(DragGesture(minimumDistance: 0).onChanged { _ in start() }.onEnded { _ in stop() })
    .accessibilityAddTraits(.isButton)
  }
  private func start() {
    guard timer == nil, !fired else { return }
    progress = 0
    timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { t in
      progress = min(1, progress + 0.05)
      if progress >= 1 { t.invalidate(); timer = nil; fired = true; WKInterfaceDevice.current().play(.success); action() }
    }
  }
  private func stop() {
    timer?.invalidate(); timer = nil
    if !fired { withAnimation(.easeOut(duration: 0.2)) { progress = 0 } }
  }
}
