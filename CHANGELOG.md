# Changelog · 更新日志

## 1.3.0 — 2026-10-12

### Features · 功能
- File paths in replies become links: click to download, eye icon to preview
  回复里的文件路径变成链接：点击下载，点眼睛图标预览
- Per-turn file list now shows deliverables only (documents, sheets, slides, images, media, archives); scripts and caches are folded into one line. The list is sorted by time before truncation, so a script that writes many files no longer pushes the real result out
  每轮文件列表只显示交付文件，脚本和缓存折叠成一行；先按时间排序再截断，脚本生成大量文件时不会再把真正的结果挤掉
- Server file manager page: back / forward / up, clickable breadcrumb, double-click to open, drag-and-drop upload into the current folder, folder download, rename, new folder, delete (limited to the work folder)
  服务器文件管理页：前进后退上一级、可点的路径、双击打开、拖入上传到当前文件夹、整个文件夹下载、重命名、新建、删除（只限工作文件夹内）
- Preview window: images, video, audio and plain text built in; other formats through plugins
  预览窗口：图片、视频、音频、纯文本内置，其余格式靠插件
- Preview plugins: PDF (pdf.js), Word (docx-preview), Excel/CSV (SheetJS), PowerPoint (pptx-preview), code & Markdown (highlight.js). Plugins run in a separate `crplugin://` origin with a CSP that forbids network access
  预览插件：PDF、Word、Excel/CSV、PPT、代码与 Markdown；插件运行在独立的 `crplugin://` 源里，CSP 禁止联网
- Plugin store backed by the GitHub repository [claude-remote-plugins](https://github.com/TomEageer/claude-remote-plugins), with jsDelivr mirrors as fallback. Every plugin version has a per-file manifest; install / update compares sha256 per file and **downloads only what changed**, retries across mirrors, and re-downloads any local file that was modified
  插件商店改为 GitHub 仓库（带 jsDelivr 镜像兜底）。每个版本附逐文件清单，安装和更新逐个比对 sha256、**只下载变了的文件**，失败自动换镜像重试，本机文件被改动会自动重新下载

### Known limitations · 已知限制
- PowerPoint preview does not draw bullets inherited from the slide master, and body text can sit lower than in PowerPoint; legacy `.doc` / `.ppt` cannot be previewed
  PPT 预览不画母版继承的项目符号，正文位置可能偏下；老格式 `.doc` / `.ppt` 不能预览
- PDF preview has no text layer (no selecting / searching text); sheets show at most 5,000 rows per sheet without cell styles; code over 1 MB is shown without highlighting
  PDF 预览没有文字层（不能选中、搜索）；表格每个工作表最多 5000 行、不还原单元格样式；超过 1MB 的代码不做高亮
- pptx-preview's npm package may be used freely but its source may not be republished, so it is not stored in the plugin repository; the app downloads the unmodified npm build from npm CDNs and checks its sha256
  pptx-preview 的 npm 包可自由使用但源码不得再发布，所以插件仓库不存放它，软件直接从 npm 的 CDN 下载原版文件并校验 sha256

## 1.2.0 — 2026-10-11

### Features · 功能
- Connect through a proxy: `socks5://` or `http://` (CONNECT), optional `user:pass@`; used for SSH, SFTP and the setup wizard. Tested via a corporate-VPN SOCKS5 proxy and a local mixed HTTP/SOCKS5 proxy
  支持经代理连接：`socks5://` 或 `http://`（CONNECT），可带 `用户名:密码@`；SSH、SFTP 和配置向导都走代理。已实测公司 VPN 的 SOCKS5 代理和本机 HTTP/SOCKS5 混合代理

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
