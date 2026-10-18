// swift-tools-version:5.9
// 手表端用的加密核心：tweetnacl（公有领域 C 实现）+ 和 mobile/e2e.js 一模一样的协议移植。
// 测试用 tools/e2e-vectors.js 生成的向量核对，保证 Swift 和 JavaScript 算出同样的字节。
import PackageDescription

let package = Package(
  name: "ClaudeRemoteCore",
  platforms: [.macOS(.v13), .iOS(.v16), .watchOS(.v10)],
  products: [.library(name: "ClaudeRemoteCore", targets: ["ClaudeRemoteCore"])],
  targets: [
    .target(name: "CTweetNaCl", path: "Sources/CTweetNaCl", cSettings: [.unsafeFlags(["-O2"])]),
    .target(name: "ClaudeRemoteCore", dependencies: ["CTweetNaCl"], path: "Sources/ClaudeRemoteCore"),
    .testTarget(name: "ClaudeRemoteCoreTests", dependencies: ["ClaudeRemoteCore"], path: "Tests/ClaudeRemoteCoreTests", resources: [.copy("Resources/vectors.json")]),
  ]
)
