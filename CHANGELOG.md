# Changelog · 更新日志

## 1.1.0 — 2026-10-11

First public release. 首个公开版本。

### Features · 功能
- First-run setup wizard: server IP + password (or key file) → app-owned ed25519 key installed, dedicated non-root account created when logging in as root, Claude Code installed, Claude login via `claude setup-token` or an API key
  首次配置向导：填服务器 IP + 密码（或密钥文件），自动生成并安装软件专用密钥；root 登录时自动建专用普通账号；自动安装 Claude Code；通过 `claude setup-token` 或 API Key 登录 Claude
- Chat UI on top of `claude -p --output-format stream-json`: streaming Markdown, tool-call cards, stop button, multi-turn via `--resume`
  基于 `claude -p --output-format stream-json` 的聊天界面：流式 Markdown、工具调用卡片、停止按钮、通过 `--resume` 多轮对话
- Sessions with folders, search, rename, drag-to-regroup
  会话分组、搜索、重命名、拖动换组
- Drag & drop / paste files → SFTP upload to `~/workspace/uploads/<date>/`; uploads finish before the message is sent
  拖入或粘贴文件 → SFTP 上传到 `~/workspace/uploads/<日期>/`，上传完成后自动发送
- Per-turn "generated files" list with download buttons (detected with `find -newermt`, so files written by scripts are included)
  每轮"本轮生成的文件"下载列表（用 `find -newermt` 检测，脚本生成的文件也能列出）
- Model picker in the input box (Opus / Fable / Sonnet / Haiku); labels come from the model the server actually ran
  输入框里的模型切换（Opus / Fable / Sonnet / Haiku），显示名取自服务器实际运行的模型
- Server file browser with download; editable extra system prompt for non-technical users
  服务器文件浏览与下载；可编辑的附加系统提示（默认面向不懂技术的用户）
- Windows (NSIS installer) and macOS (Apple Silicon + Intel DMG)
  Windows（NSIS 安装包）与 macOS（Apple 芯片 + Intel DMG）

### Known limitations · 已知限制
- Installers are **not code-signed**: Windows SmartScreen and macOS Gatekeeper warn on first launch
  安装包**未签名**，Windows 与 macOS 首次打开都会有安全提示
- The Windows executable itself shows the default Electron icon (window and taskbar icons are correct); it is built on macOS without Wine
  Windows 程序文件本身显示 Electron 默认图标（窗口和任务栏图标正确），因为是在 macOS 上不借助 Wine 打包的
- **Password login has not been tested against a real server yet** (the test server only allows key login); key-file login is tested
  **密码登录还没在真实服务器上测过**（测试服务器只允许密钥登录）；密钥文件登录已实测
- Claude runs with `bypassPermissions` — there is no per-command approval; isolation relies on the dedicated account
  Claude 以 `bypassPermissions` 运行，不逐条确认命令，安全靠专用账号隔离
- Linux servers only; generated-file detection needs GNU `find` (`-newermt`, `-printf`)
  只支持 Linux 服务器；生成文件检测依赖 GNU `find`（`-newermt`、`-printf`）
- Folders cannot be uploaded directly (zip them first); passphrase-protected keys are not supported
  不能直接上传文件夹（需先压缩）；不支持带密码的私钥
- Session history is stored per computer; it does not sync between devices
  会话记录按电脑保存，不在多台设备间同步
- No auto-update yet
  暂无自动更新
