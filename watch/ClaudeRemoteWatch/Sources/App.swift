import SwiftUI

@main
struct ClaudeRemoteWatchApp: App {
  @StateObject private var store = Store()
  var body: some Scene {
    WindowGroup { RootView().environmentObject(store) }
  }
}
