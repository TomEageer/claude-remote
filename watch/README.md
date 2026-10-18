# Apple Watch 版

手表只做三件事：处理 Claude 在等你的那一下（允许 / 批准 / 回答）、瞄一眼哪些对话在跑、一句话发过去（键盘、语音或快捷回复）；配了几台电脑就在设置里切。完整对话、文件、代码留在手机和电脑上。

- `ClaudeRemoteCore/`：加密核心。tweetnacl（公有领域 C 实现）+ `mobile/e2e.js` 的 Swift 移植。`swift test` 用 `scripts/e2e-vectors.js` 生成的向量核对两边算出的字节完全一致。
- `ClaudeRemoteWatch/`：watchOS App（SwiftUI）。`xcodegen generate` 生成工程。

配对：电脑「设置 → 远程控制 → 添加 Apple Watch」显示 6 位配对码（5 分钟有效、只能用一次）；手表输入中转地址和配对码，两边核对 4 位数字后在电脑上确认。之后手表在电脑眼里就是又一台手机，协议、加密、中转都一样。
