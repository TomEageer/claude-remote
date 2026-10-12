<div align="center">

<img src="assets/icon_1024.png" width="120" alt="Claude 远程助手图标">

# Claude 远程助手

**给你服务器上的 Claude Code 配一个桌面聊天窗口**

Claude Code 很强，但它跑在 SSH 后面的终端里，不写代码的人根本用不起来。<br>
Claude 远程助手在它上面套了一个熟悉的聊天界面：左边是会话和分组，文件拖进来就上传，<br>
Claude 做出来的每个文件都会变成一个**下载**按钮。首次配置只需要服务器 IP 和密码。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/TomEageer/claude-remote?color=brightgreen&label=release)](https://github.com/TomEageer/claude-remote/releases/latest)
[![Download](https://img.shields.io/badge/download-107%20MB-brightgreen)](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-Setup.exe)
[![Setup](https://img.shields.io/badge/server%20setup-~25%20s-brightgreen)](#快速开始)
[![Downloads](https://img.shields.io/github/downloads/TomEageer/claude-remote/total?color=brightgreen&label=downloads)](https://github.com/TomEageer/claude-remote/releases)
[![Telemetry](https://img.shields.io/badge/telemetry-none-success)](#隐私)
[![Platform](https://img.shields.io/badge/platform-Windows%20·%20macOS-lightgrey)](#系统要求)

[**⬇ Windows**](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-Setup.exe) · [**⬇ macOS（Apple 芯片）**](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-arm64.dmg) · [macOS（Intel）](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-x64.dmg) · [快速开始](#快速开始) · [工作原理](#工作原理) · [常见问题](#常见问题) · [**English**](README.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/main-dark.png">
  <img src="docs/images/main.png" width="880" alt="Claude 远程助手主界面：分组会话、工具调用卡片、每轮生成文件的下载列表">
</picture>

</div>

---

## 为什么做 Claude 远程助手

把 Claude Code 放在服务器上跑有很多好处：电脑合上它照样干活，需要什么软件自己装，文件都集中在一处。但入口是 `ssh` 加终端界面，不懂技术的人根本不会用。Claude 远程助手就是补上的这扇门：

- 🧭 **两分钟上手** —— 填一次服务器 IP 和密码，软件自动生成自己的 SSH 密钥并装到服务器、建一个专用普通账号、安装 Claude Code，再一步步带你登录 Claude。密码不会被保存
- 💬 **用起来像 Claude App** —— 流式回复、Markdown 和表格、会话分组、搜索、重命名、拖动换组
- 📎 **文件拖进来，Claude 就能读** —— 通过 SFTP 上传到服务器，路径自动告诉 Claude
- 📦 **Claude 做的东西一键下载** —— 回复里提到的文件路径自动变成链接，点一下下载，点旁边的眼睛直接预览；每轮结束还会列出这一轮生成的文档、表格、PPT、图片，脚本和缓存文件自动折叠
- 👀 **不下载也能看** —— 图片、视频、音频直接看；PDF、Word、Excel、PPT、代码通过可安装/卸载的预览插件打开，插件在隔离环境里运行、不能联网
- 📁 **每个对话一个项目文件夹** —— 在你指定的目录里干活，旁边就是这个文件夹的文件面板；Claude 回复时也能接着发消息（先排队，可撤回）
- 📊 **用量一目了然** —— 侧栏常驻 5 小时/本周额度，点上下文用量看明细并一键压缩
- 🖥️ **多台服务器随手切** —— 侧栏顶部切换服务器，每台有自己的对话；`/login` 随时重新登录 Claude
- ⌨️ **斜杠命令和编辑** —— 输入框里打 `/` 就有命令菜单（切换对话、换模型、压缩上下文、调用 Skill…）；发出去的消息也能改了重发
- 🗃️ **认得服务器上的老会话** —— 终端里用 Claude Code 聊过的会话也能一键导入，完整还原并接着聊
- 🌿 **分支与回退** —— 从任意一条回复分出新对话，或把对话回退到某条消息之前改了重发，原对话自动另存
- 🧩 **MCP 与 Skill 一目了然** —— 看到服务器上装了哪些 MCP、Skill、插件以及连接状态，能添加删除，还能只对某个对话开关
- 📏 **上下文和时间轴** —— 输入框旁实时显示上下文用量和上限；右侧时间轴像时光机一样快速定位每条消息
- 🔄 **从 GitHub 更新** —— Windows 后台增量下载新版本，Mac 有新版本时提示
- 🗂️ **服务器文件管理器** —— 前进后退、面包屑路径、双击进入、拖文件进来上传到当前文件夹、整个文件夹下载、重命名、新建、删除
- 🛡️ **默认隔离** —— Claude 在一个单独的普通账号里干活，说错一句话也碰不到服务器上的其他服务
- 🔀 **每条消息都能换模型** —— 输入框里直接选 Opus / Fable / Sonnet / Haiku，显示的名字来自服务器实际运行的模型
- 🆓 **免费开源** —— MIT 协议，无埋点，不需要注册我们的任何账号，约 2500 行代码

<img src="docs/images/wizard.png" width="560" alt="首次配置向导：服务器地址、端口、用户名、密码">

|  | Claude 远程助手 | SSH 终端里直接跑 Claude Code | VS Code Remote-SSH + Claude Code |
|---|---|---|---|
| 界面 | **聊天窗口** | 终端界面 | 代码编辑器 + 插件面板 |
| 首次配置服务器 | **向导：填 IP + 密码** | 手动（密钥、安装、登录） | 手动（密钥、安装、登录） |
| 把本地文件给 Claude | **拖进输入框** | 手动 `scp` | 拖进远程资源管理器 |
| 拿到 Claude 生成的文件 | **每轮下载列表** | 手动 `scp` | 右键 → 下载 |
| 会话历史 | 本地保存，可分组 | `claude --resume` 选择 | 未实测 |
| 每条命令执行前确认 | **不确认**，在专用账号内自动放行 | 确认 | 确认 |
| 需要自备 Linux 服务器 | 需要 | 需要 | 需要 |
| 安装包签名 | **没有**（见常见问题） | — | 有 |

不如别人的地方：执行命令前不逐条确认（这是为不懂技术的用户特意设计的，风险靠专用账号兜住）；安装包暂未签名；它不是代码编辑器。

## 快速开始

1. **下载** —— [Windows](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-Setup.exe) · [macOS Apple 芯片](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-arm64.dmg) · [macOS Intel](https://github.com/TomEageer/claude-remote/releases/latest/download/ClaudeRemote-x64.dmg)
2. **安装** —— Windows：双击安装包（提示"已保护你的电脑"时点"更多信息"→"仍要运行"）。macOS：拖进"应用程序"，第一次打开时**右键 → 打开**
3. **连接服务器** —— 填 IP、端口、用户名和密码（或密钥文件），向导自动配好一切。新账号约 25 秒，需要安装 Claude Code 时再加约 15 秒
4. **登录 Claude** —— 点"打开浏览器登录"，授权后把网页上的授权码粘回来；也可以直接填 Anthropic API Key
5. **开始聊天** —— 拖文件、选模型、下载结果

## 工作原理

```
┌──────────────── 你的电脑 ────────────────┐            ┌─────────────── 你的 Linux 服务器 ───────────────┐
│ Electron 界面 ── ssh2（一条长连接）──────┼── SSH ────►│ claude -p --output-format stream-json           │
│   会话、分组（本地 JSON）                │            │        --resume <session-id>                    │
│   拖入文件 ── SFTP 上传 ─────────────────┼── SFTP ───►│ ~/workspace/uploads/<日期>/                     │
│   本轮文件 ◄── SFTP 下载 ────────────────┼◄── SFTP ───│ find ~/workspace -newermt @<本轮开始时间>       │
└──────────────────────────────────────────┘            └─────────────────────────────────────────────────┘
```

- **每条消息**都在服务器上用无界面模式运行官方 Claude Code：`claude -p --output-format stream-json --include-partial-messages`，第一轮带 `--session-id`，之后用 `--resume`，对话记录保存在服务器上 Claude Code 自己的会话库里
- **流式显示**：把 JSON 事件流解析成文字增量、工具调用和工具结果，渲染成 Markdown 和可展开的工具卡片
- **停止**：在 `exec` 之前先打印 PID，停止时向这个远程进程精确发送 `SIGINT`
- **生成的文件**：在服务器上记下本轮开始时间，结束后对工作目录跑 `find -newermt`（跳过 `uploads/`、隐藏目录和依赖缓存），结果显示成下载按钮
- **配置向导**：用你的密码或密钥登录一次，把软件自己的 ed25519 公钥写进 `authorized_keys`（root 登录时写给新建的专用账号），用官方安装脚本装 Claude Code，再在伪终端里跑 `claude setup-token` 拿到长期令牌
- **权限**：Claude 以 `--permission-mode bypassPermissions` 运行，所以向导默认把它隔离在普通账号里

## 隐私

- **没有任何埋点和统计**，软件只和你自己的服务器通信；唯一的例外是**预览插件**：打开「预览插件」页或预览需要插件的文件时，会从 GitHub 插件仓库 [claude-remote-plugins](https://github.com/TomEageer/claude-remote-plugins)（国内自动走 jsDelivr 镜像，可在设置里换成你自己 fork 的仓库）读取插件列表和下载插件文件，不会上传任何东西
- 预览插件**逐个文件校验 sha256**，运行在独立的源里，内容安全策略禁止它们联网，也访问不到软件本身；更新时只下载变了的文件
- **密码只在配置时用一次**，不会写到硬盘上
- Claude 令牌**只保存在你的服务器上**的 `~/.claude-env`（权限 `600`），配置完成后桌面端不再接触它
- 会话和设置保存在本机的应用数据目录（Windows：`%APPDATA%\Claude 远程助手`；macOS：`~/Library/Application Support/Claude 远程助手`）

## 常见问题

<details>
<summary><b>这算不算 Claude 中转站？</b></summary>

不算。它是你自己服务器上官方 Claude Code 的图形界面，用的是你自己的登录，没有转发或倒卖任何请求。但要注意：个人版 Claude 订阅只供本人使用，多人用这个软件时，请让每个人用自己的 Claude 账号（或改用 API Key）。
</details>

<details>
<summary><b>打开时系统提示"未知开发者"/"已保护你的电脑"</b></summary>

安装包暂时没有代码签名。Windows：点"更多信息"→"仍要运行"。macOS：右键点应用 →"打开"→"打开"，或者到"系统设置 → 隐私与安全性"里点"仍要打开"。
</details>

<details>
<summary><b>为什么执行命令前不让我确认？</b></summary>

目标用户本来就看不懂命令，逐条确认只会变成无意义的点击。所以向导默认建一个专用普通账号让 Claude 在里面干活；如果你用普通账号登录，Claude 的权限就和这个账号完全一样。
</details>

<details>
<summary><b>什么样的服务器可以用？</b></summary>

能 SSH 登录、有 `bash` 和 `curl`、能访问 `claude.ai` 的 Linux 服务器都行。建议内存或交换分区至少 2 GB，因为每个正在回复的对话都是一个 Claude Code 进程。
</details>

<details>
<summary><b>服务器只允许公司网络（或跳板）访问，怎么连？</b></summary>

在向导的"高级选项"或设置里填**代理**：支持 `socks5://主机:端口` 和 `http://主机:端口`（HTTP CONNECT），需要认证时写成 `socks5://用户名:密码@主机:端口`。例如公司 VPN 在本机提供了 SOCKS5 代理 `127.0.0.1:1080`，就填 `socks5://127.0.0.1:1080`。SSH、文件上传下载、Claude 登录全部会走这个代理。
</details>

<details>
<summary><b>多台电脑能连同一台服务器吗？</b></summary>

可以。每台电脑各跑一次向导（或者把它的公钥加到服务器上），共用同一个工作目录；会话历史保存在各自电脑上。
</details>

## 系统要求

- **电脑**：Windows 10/11（x64），或 macOS 12 及以上（Apple 芯片或 Intel）
- **服务器**：Linux，支持 SSH，有 `bash`、`curl`，能访问 `claude.ai` / `api.anthropic.com`
- **Claude**：Claude Pro/Max 订阅，或 Anthropic API Key

## 支持作者

Claude 远程助手免费使用。如果它帮你省了时间，可以看看 [DONATE.md](DONATE.md)。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 联系

问题和建议：[GitHub Issues](https://github.com/TomEageer/claude-remote/issues) · [tomeageer.com](https://tomeageer.com)

## 许可证

[MIT](LICENSE)。本项目与 Anthropic 无关。Claude 和 Claude Code 是 Anthropic, PBC 的商标。

<sub>Claude Code 图形界面 · Claude Code 桌面客户端 · SSH 远程 Claude Code · Claude Code Windows 版 · Claude Code Mac 版 · 不会编程也能用 Claude Code · 自建 Claude 工作台</sub>
