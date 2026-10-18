# Claude 远程 · iPhone App（含 Apple Watch）

iPhone 上的薄壳：显示打包在 App 里的手机页面（和用 Safari 打开、安卓 App 里的是同一份 `mobile/` 代码），
并把 Apple Watch App 作为配套应用一起装到手机上，再由 iPhone 的「Watch」App 推到手表，**不需要 Xcode 直接识别手表**。

- 页面由 App 内的本机小服务器提供（只听 `127.0.0.1:17373`，只读 App 自带文件），这样页面是安全上下文，扫码用的摄像头才能用
- 配对、密钥都在页面的 localStorage 里，和网页版一样是端到端加密，中转碰不到明文
- 壳只补浏览器缺的几样：摄像头权限、外部链接交给 Safari、alert/confirm 弹窗
- 手表 App 源码在 [`../watch/`](../watch/)，这里直接引用同一份源码，只是以「配套 App」身份打包（bundle id 以 iPhone App 的为前缀）

## 自己装（免费 Apple ID 即可）

需要 Mac + Xcode 16 以上 + [XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）。

1. 生成工程并打开：
   ```sh
   cd ios && xcodegen generate && open ClaudeRemote.xcodeproj
   ```
2. Xcode 里左侧点工程 → 分别选 **ClaudeRemote** 和 **ClaudeRemoteWatch** 两个 target → Signing & Capabilities → Team 选你的 Apple ID（Personal Team）。
   Bundle Identifier 被别人占用时，把两个 target 的前缀一起改掉（手表的必须是 iPhone 的加 `.watchkitapp`）。
3. iPhone 用数据线连 Mac，顶部设备选你的 iPhone，⌘R。第一次要在 iPhone 上：设置 → 通用 → VPN 与设备管理 → 信任你的开发者。
4. 装手表：iPhone 打开「Watch」App → 我的手表 → 往下翻到「可用的 App」→ Claude 远程 → 安装。
5. 手表上打开 App，按电脑「设置 → 远程控制 → 添加 Apple Watch」的 6 位码配对（见 [`../docs/remote-control.md`](../docs/remote-control.md)）。

免费签名的 App **7 天过期**（手机和手表一起），到期重复第 3 步即可，配对信息不会丢。付费开发者账号可以走 TestFlight，90 天一续、还能发给别人。

## 开发

- 页面改动在 `mobile/`，工程里是文件夹引用，重新编译就生效
- 模拟器自动化测试用环境变量 `CR_TEST_HASH` 直接带配对链接的 `#` 部分（仅 Debug）
- 注意：Xcode 自带的部分 iOS 模拟器缺中文字体，页面上会显示问号方块，真机正常
