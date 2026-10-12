# Changelog · 更新日志

## 1.4.2 — 2026-10-12

### Features · 功能
- **Import sessions from the server**: a new *Server sessions* page lists every Claude Code session saved on the server (including ones started in a terminal) with its title, folder, time and size; import one or all, see the full conversation with tool cards, and keep chatting — the run happens in the session's original folder so `--resume` finds it. Right-click → *Reload from server* picks up turns added elsewhere
  **导入服务器上的会话**：新页面列出服务器上 Claude Code 保存的所有会话（包括终端里用过的），显示标题、目录、时间；可单个或全部导入，完整还原内容和工具卡片，并能接着聊（在会话原来的目录里运行）。右键「从服务器重新载入」可同步在别处继续过的内容

### Fixes · 修复
- The context meter's "no data yet" state shared a class name with the welcome screen and was stretched over the whole chat area
  上下文显示在没有数据时和欢迎页的样式重名，被拉满整个对话区
- The setup wizard's login check no longer leaves "只回复 OK" sessions on the server (`--no-session-persistence`)
  配置向导检查登录时不再在服务器上留下测试会话

## 1.4.1 — 2026-10-12

### Fixes · 修复
- Connecting from a computer that runs a TUN-mode proxy (Clash, Flowgate, Shadowrocket …) to a server that only accepts the local network failed with "Connection lost before handshake". New option **Bypass local proxy** binds the SSH connection to the physical network adapter's address; the setup wizard turns it on automatically when the first attempt fails this way
  电脑开着 TUN 全局代理（Clash、Flowgate、Shadowrocket 等）、而服务器只接受本地网络访问时，会报 "Connection lost before handshake"。新增**绕过本机代理直连**：SSH 连接绑定到物理网卡的地址直接出去；配置向导第一次连接这样失败时会自动打开
- That error now has a plain-language explanation
  这个报错改成了看得懂的中文说明

## 1.4.0 — 2026-10-12

### Features · 功能
- **Branch and rewind**: hover a reply → *Branch from here* opens a new conversation that continues from that point; hover one of your messages → *Rewind to here* takes it back (text returns to the input box) and keeps the full original as a separate conversation. Built on Claude Code's `--resume-session-at` + `--fork-session`; tested that the branch only remembers what came before the fork point
  **分支与回退**：在回复上点「从这里分支」，从这一点开出新对话；在自己的消息上点「回退到这里」，撤回这条及之后的内容（文字放回输入框），原对话完整另存一份。实测分支后只记得分支点之前的内容
- **Context meter** next to the send button: tokens in use / the model's context window, turning amber at 70% and red at 90%
  发送按钮旁显示**上下文用量**（已用 / 模型上限），70% 变黄、90% 变红
- **MCP & Skill page**: lists the MCP servers, Skills and Claude Code plugins installed on the server; check MCP connection status; add / remove MCP servers (stdio, HTTP, SSE) and Skills (folder or SKILL.md)
  **MCP 与 Skill 页**：列出服务器上的 MCP、Skill、Claude Code 插件；检测 MCP 连接；添加/删除 MCP（命令行、HTTP、SSE）和 Skill
- **Per-conversation capabilities**: the *Capabilities* button in the input box turns individual MCP servers and Skills on or off for this conversation only (`--strict-mcp-config` / `--disallowedTools Skill(…)`), with live connection status from the last run
  **按对话启用能力**：输入框里的「能力」按钮可以只对当前对话开关某个 MCP 或 Skill，并显示上次运行时的连接状态
- **Timeline scrollbar**: a rail on the right with your messages on one side and Claude's replies on the other; ticks magnify near the cursor, show a preview, and jump on click
  **时间轴滚动条**：右侧细轨道，你的消息和 Claude 的回复分两侧，靠近放大、显示摘要、点击跳转
- Rename conversations in place (double-click in the sidebar); copy any message
  侧栏双击就地重命名；每条消息可复制
- **Updates from GitHub Releases**: Windows downloads updates in the background (block-level differential via blockmap from the next release on) and asks to restart; macOS shows a "new version" link because unsigned apps cannot replace themselves
  **从 GitHub 更新**：Windows 后台下载（从下一个版本起按块增量）后提示重启；macOS 安装包未签名无法自替换，只提示去下载

### Known limitations · 已知限制
- Windows auto-update has not been tried on a real Windows machine yet; the first differential update needs this release's blockmap, so 1.4.0 → 1.4.1 is the first one that can be partial
  Windows 自动更新还没在真机上验证；增量更新需要上一版本的 blockmap，所以 1.4.0 → 1.4.1 才是第一次能增量
- Messages from versions before 1.4.0 have no anchor and cannot be branched from or rewound to
  1.4.0 之前产生的消息没有定位点，不能从它们分支或回退
- Disabling a Skill blocks the Skill tool for it; Claude still sees it in its list and may try once before being told it is blocked
  关掉的 Skill 会被拦截调用，但 Claude 仍能看到它的名字，可能会先尝试一次再被拒绝

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
