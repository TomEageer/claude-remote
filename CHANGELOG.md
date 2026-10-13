# Changelog · 更新日志

## 1.5.11 — 2026-10-13

### Features · 功能
- **Keep talking while helpers work**: once Claude's reply is done and only background jobs or subagents are still running, a new message goes straight to Claude and is answered right away; the background work carries on and Claude reports when it finishes. (While the main reply is still streaming, messages are queued as before; Windows hosts always queue)
  **助手在后台跑时也能接着聊**：Claude 的主回复结束、只剩后台命令或子助手在跑时，新消息直接发给 Claude 马上回答，后台任务照常进行，结束后 Claude 再汇报（主回复还在输出时仍然排队；Windows 主机仍然排队）
- **Sign-in links surface**: when a tool returns a sign-in / authorization link (Feishu, OAuth, device login…), it is shown under the tool card with *Open in browser* and *Copy link*, instead of being hidden in the collapsed result while Claude waits for you
  **授权链接直接显示**：工具返回登录 / 授权链接（飞书授权、OAuth、设备码登录等）时，在卡片下面显示「在浏览器中打开」「复制链接」，不再藏在折叠的结果里让人以为卡住了
- **Times and durations**: every message shows when it was sent, and each reply shows how long it took; while Claude works, a light strip runs along the top of the input box with the elapsed time beside it
  **时间与用时**：每条消息显示发送时间，回复显示用了多久；回复中输入框上沿有一条流动的灯带，旁边显示已用时间
- MCP tools are labelled *MCP · server* with the tool name, instead of `mcp__server__tool`
  MCP 工具显示为「MCP · 服务名」加工具名，不再是 `mcp__服务名__工具名`

## 1.5.10 — 2026-10-13

### Changes · 改动
- Opening a preview widens the window instead of squeezing the conversation (the chat keeps at least 560 px; the window moves left if it would run off the screen), and closing the preview puts the window back where it was. When the screen has no room left (maximized or full screen), the preview gets narrower instead
  打开预览时窗口向外加宽，不再挤压对话（对话区至少保留 560 像素；右边放不下会整体往左挪），关闭预览后窗口恢复原来的大小和位置；屏幕已经没有空间（最大化或全屏）时改为缩窄预览

## 1.5.9 — 2026-10-13

### Features · 功能
- **Use this computer directly**: if Claude Code is installed on the computer running the app, the setup wizard offers *Use this computer* at the top. Claude then runs as a local process — no SSH, no *Remote Login*, no 127.0.0.1 — so on a Mac the login you already have in Terminal works as is (local processes can read the keychain). Files are read and written directly, and deleting moves them to the Trash. If Claude is not logged in yet, the wizard opens Terminal so you can log in the usual way
  **直接使用这台电脑**：运行软件的这台电脑装了 Claude Code 时，配置向导最上面会出现「直接使用这台电脑」。Claude 作为本地进程运行，不经过 SSH，不用开「远程登录」，也不用填 127.0.0.1；Mac 上终端里已有的登录直接可用（本地进程能读钥匙串）。文件直接读写，删除会放进废纸篓。还没登录时，向导会打开终端让你按平常的方式登录一次
- Servers that pointed at 127.0.0.1 / localhost with your own user name are switched to this mode automatically; existing conversations continue as before
  以前用 127.0.0.1 / localhost 加本机用户名连接的服务器，会自动改成这种方式，已有对话照常接着聊

## 1.5.8 — 2026-10-13

### Changes · 改动
- The timeline is redrawn as one slim track of segments: Claude's replies in soft gray, yours in a soft accent tint, and the segment you are reading is the slider itself (solid and slightly wider) instead of a separate marker
  时间轴改成一条由小段拼成的细轨道：Claude 的回复是浅灰，你的消息是淡淡的主题色；正在看的那段本身就是滑块（实色、略宽），不再另外画刻度和标记

## 1.5.7 — 2026-10-13

### Changes · 改动
- **Uses the Claude Code you already have**: the setup wizard looks in the default location, Homebrew, `/usr/local/bin`, npm global and your login shell's PATH, and uses the newest one instead of installing another copy (SSH sessions do not load `~/.zprofile`, so Homebrew's `/opt/homebrew/bin` used to be missed); its folder is recorded in `~/.claude-env`
  **用你已经装好的 Claude Code**：配置向导会在默认位置、Homebrew、`/usr/local/bin`、npm 全局和登录 shell 的 PATH 里找，用版本最新的那个，不再重复安装（SSH 不加载 `~/.zprofile`，以前会漏掉 Homebrew 的 `/opt/homebrew/bin`）；所在目录记在 `~/.claude-env`
- **Pick a folder you already use**: at the end of setup the wizard lists folders where Claude Code was used before (with how many conversations and when), so you can make one the default working folder or keep a new one, and optionally open *Server sessions* to import the old conversations. Skipping the login step no longer skips this
  **选择已有的工作文件夹**：配置最后会列出这台机器上用过 Claude Code 的文件夹（对话数和最近使用时间），可以选一个作为默认工作文件夹或者用新建的，并可顺便打开「服务器上的会话」导入以前的对话；登录那一步点「稍后再说」也不会跳过这一步
- **Timeline shows message length**: each message is a segment as long as the message itself, Claude on the left and you on the right, so long replies stand out
  **时间轴显示消息长短**：每条消息是一段，长度和消息实际长短成比例；Claude 在左、你在右，长回复一眼就能看出来

## 1.5.6 — 2026-10-13

### Changes · 改动
- Send and Stop share one button: while Claude is replying the button is *Stop*; as soon as you type, it turns back into *Send* (queued)
  「发送」和「停止」合成一个按钮：回复中显示「停止」，一输入内容就变回「发送」（排队）
- **Esc stops the current reply**, like in Claude Code. If a preview, menu, dialog or edit box is open, Esc closes that first
  **按 Esc 停止当前回复**（和 Claude Code 一样）；有预览、菜单、对话框或编辑框开着时，Esc 先关掉它们
- The disclaimer is gone from the status bar, leaving room for the server, account and usage
  状态栏去掉免责提示，留给服务器、账号和额度

## 1.5.5 — 2026-10-13

### Fixes · 修复
- **Your own Mac as a host said "Not logged in"** even though Claude was logged in there: macOS does not let SSH sessions read the login keychain, where Claude Code keeps its login. The reply now explains this and offers *Log in to Claude*, which creates a long-lived token stored only in that Mac's `~/.claude-env` (your terminal's Claude is unaffected); the setup wizard says the same when adding a Mac
  **连自己的 Mac 提示"Not logged in"**（明明在这台 Mac 上登录过）：macOS 不允许 SSH 远程会话读取钥匙串，而 Claude Code 的登录信息存在钥匙串里。现在回复里会说明原因并给出「登录 Claude」按钮，授权后生成的长期令牌只保存在这台 Mac 的 `~/.claude-env`，不影响终端里的 Claude；添加 Mac 主机时配置向导也会提示
- Login errors from Claude are shown in plain Chinese with a *Log in to Claude* button, and the status bar shows *Not logged in* instead of an old account
  Claude 的未登录/登录失效错误改成中文说明并带「登录 Claude」按钮；状态栏显示「未登录 Claude」，不再显示过期的账号
- Changing a server's address or user clears its old account and usage figures
  修改服务器地址或用户名后，清掉这台服务器旧的账号和额度显示

### Docs · 文档
- New screenshots: main window, Claude asking a question, subagent steps and background tasks
  更新截图：主界面、Claude 提问、子助手步骤与后台任务

## 1.5.4 — 2026-10-13

### Features · 功能
- **Claude can ask you to choose**: when Claude uses its question tool, the options show up as buttons in the reply — one click answers a single question; several questions, multi-select and your own typed answer are supported, and *Skip* lets Claude decide. Works on Linux and macOS hosts (messages now go to Claude Code as JSON over stdin with the stdio permission channel; Windows hosts keep the old mode)
  **Claude 让你选，直接点**：Claude 提问时，选项在回复里显示成按钮，单个问题点一下就发出；支持多个问题、多选和自己填写，也可以「跳过」让 Claude 自己判断。适用于 Linux 和 macOS 主机（消息改为以 JSON 经标准输入发给 Claude Code，并走标准输入输出的权限通道；Windows 主机保持原方式）
- **Subagents**: everything a dispatched subagent does (its commands, results and final report) is listed inside its card, with live progress in the card header
  **子助手**：派出去的助手做的每一步（命令、结果、最终汇报）都列在它的卡片里，卡片标题实时显示进度
- **Background jobs**: commands Claude runs in the background and subagents get a *Background tasks* button next to the model picker (also `/tasks`): status, running time, live output of each command, and a *Stop* button for a single command without stopping Claude (Claude is told it was stopped by you). After the main reply the chat says it is waiting for background jobs, and Claude's follow-up appears in the same reply; *Stop waiting* ends the turn
  **后台任务**：Claude 放到后台跑的命令和派出的助手，在模型选择旁有「后台任务」按钮（也可以输入 `/tasks`）：状态、运行时长、每个命令的实时输出，并能单独停止某个命令而不打断 Claude（Claude 会知道是你停的）。主回复结束后会提示正在等后台任务，任务结束后 Claude 接着在同一条回复里汇报；也可以「不等了，结束这一轮」
- **Web pages preview rendered**: `.html` files open as a page in an isolated sandbox (scripts run, but cannot reach the app or your computer; links cannot navigate away); a *Source* button switches to the code
  **网页直接显示**：`.html` 文件按网页显示，运行在隔离沙盒里（脚本能跑，但碰不到软件和电脑，也不能跳到别的网站）；「源码」按钮切换看代码
- **Download progress for previews**: size, percentage, speed and time left while a file is fetched from the server
  **预览下载进度**：从服务器取文件时显示大小、百分比、速度和剩余时间
- **Preview cache**: files under 50 MB stay cached for 30 days and reopen instantly (re-downloaded automatically if changed on the server); larger files are kept for a day; the cache is capped at 1 GB
  **预览缓存**：50MB 以内的文件在本地缓存 30 天，再次打开秒开（服务器上改过会自动重新下载）；更大的文件只留 1 天；缓存总量不超过 1GB
- **Resizable table columns**: drag the edge of a header cell in replies, Markdown previews and spreadsheets (plugins *Code & text* 1.1.2, *Spreadsheet* 1.0.2); double-click to reset
  **表格列宽可拖动**：回复里的表格、Markdown 预览和 Excel 预览都能拖表头边缘调整列宽（插件「代码与文本」1.1.2、「表格预览」1.0.2），双击恢复
- Consecutive messages from Claude are shown as separate paragraphs instead of running together
  Claude 连续的几段话分段显示，不再连在一起

### Fixes · 修复
- The copy button of a code block scrolled away with long lines; it now stays in the corner
  代码块的「复制」按钮会跟着横向滚动跑掉，现在固定在右上角
- Switching servers while the previous one was still connecting could leave the new server's conversations in the old server's folder
  上一台服务器还在连接时切换服务器，新服务器的对话可能用上旧服务器的文件夹
- In a narrow window the conversation title could overlap the folder button; it now moves left and truncates
  窗口较窄时对话标题会压住文件夹按钮，现在会靠左并截断
- Table headers no longer break into one character per line in narrow windows
  窗口较窄时表头不再被挤成一字一行

## 1.5.3 — 2026-10-12

### Changes · 改动
- The conversation and input box widen with the window (up to 1280 px) instead of staying 780 px wide
  对话和输入框跟着窗口变宽（最宽 1280 像素），不再固定 780
- New **status bar** at the bottom: connection, server switcher, Claude account, 5-hour and weekly usage with the weekly reset time. Click the usage for every window with its exact reset time
  新增底部**状态栏**：连接状态、服务器切换、Claude 账号、5 小时和本周额度及周重置时间；点击查看所有额度窗口和具体重置时间
- Refreshing usage now sends one tiny Haiku and one tiny Fable request (neither saved), so the Fable weekly window shows up even if you have not used Fable yet
  刷新额度会用 Haiku 和 Fable 各发一个极小的请求（都不保存），没用过 Fable 也能看到 Fable 的周额度
- Sidebar tidied: *Server sessions* sits under the search box; *MCP & Skill* and *Preview plugins* moved into **Settings**, which now has tabs (General / MCP & Skill / Preview plugins)
  侧栏整理：「服务器上的会话」放到搜索框下面；「MCP 与 Skill」「预览插件」并入**设置**，设置改为分页
- macOS: the app title sits on the same row as the window buttons
  macOS：标题和窗口按钮在同一行
- The account email is shown in full
  账号邮箱不再打码

## 1.5.2 — 2026-10-12

### Features · 功能
- **Windows hosts**: connect to a Windows PC running the OpenSSH server. The app detects Windows (and whether its SSH shell is cmd or PowerShell) and runs everything through Git Bash, which Claude Code on Windows needs anyway; commands and their input travel as one script on stdin, so no cmd / PowerShell quoting is involved. Paths are converted between SFTP (`/C:/Users/…`) and shell (`C:/Users/…`) forms; files you upload are given to Claude in Windows form. *Stop* ends the whole process tree with `taskkill /T`. The setup wizard authorizes the key in `administrators_authorized_keys` (with the required ACL) for administrators or `%USERPROFILE%\.ssh\authorized_keys` otherwise, installs Claude Code with the official PowerShell script and runs `setup-token` through PowerShell
  **支持 Windows 主机**：连接开了 OpenSSH 服务器的 Windows 电脑。软件会识别 Windows（以及 SSH 默认 shell 是 cmd 还是 PowerShell），所有命令交给 Git Bash 执行（Windows 上的 Claude Code 本来就需要它），命令和输入数据作为一个脚本经标准输入传过去，不涉及 cmd/PowerShell 的引号转义；SFTP 路径和命令行路径自动互转；上传的文件以 Windows 写法告诉 Claude；「停止」用 `taskkill /T` 结束整个进程树；配置向导会把钥匙写到管理员的 `administrators_authorized_keys`（并设置所需权限）或普通账号的 `.ssh\authorized_keys`，用官方 PowerShell 脚本安装 Claude Code
- Python helpers (server sessions, MCP / Skill lists) use whichever of `python3`, `python`, `py` works
  读取会话、MCP/Skill 列表时自动使用可用的 `python3` / `python` / `py`
- File paths like `C:\Users\…\report.pptx` in replies become links too
  回复里的 `C:\Users\…\report.pptx` 这类路径也能点击

### Fixes · 修复
- An upload progress update could throw when the file panel had never been opened
  文件面板从没打开过时，上传进度更新会报错

### Known limitations · 已知限制
- **Windows hosts have not been tested on a real Windows machine yet.** The command wrapping was verified by running the exact generated scripts through bash, and Linux hosts were regression-tested end to end; please report anything that fails on Windows
  **Windows 主机还没在真实 Windows 电脑上测试过。**命令包装已经用生成的脚本在 bash 里逐条验证，Linux 主机也做了完整回归；在 Windows 上遇到问题请反馈
- Windows hosts need Git for Windows; the Windows *user* creation step of the wizard is skipped (the logged-in account is used)
  Windows 主机需要先装 Git for Windows；向导不会在 Windows 上新建账号，直接使用登录的账号

## 1.5.1 — 2026-10-12

### Features · 功能
- **Conversation titles**: after the first reply, Haiku names the conversation (one tiny request, not saved on the server), since headless Claude Code does not write titles; conversations you renamed keep your name, imported ones keep Claude's own title
  **对话标题**：第一轮回复后用 Haiku 自动起标题（一次极小的请求，不在服务器留记录）；自己改过名的不会被覆盖，导入的沿用 Claude 原来的标题
- **Privacy for screenshots**: servers are shown only by a name you choose (default "服务器 1"), never as user@address; the address, user name and key path in Settings are masked until you click the eye; file paths in the preview header use `~`
  **截图隐私**：服务器只显示你起的名字（默认「服务器 1」），不再显示 用户名@地址；设置里的地址、用户名、密钥路径默认遮住，点眼睛才显示；预览顶部的路径用 `~`
- **Which Claude account**: the usage box and server menu show the account each server uses (email masked, plan), read from `claude auth status`; for long-lived tokens, where the account is unknown, you can add a note in Settings
  **显示 Claude 账号**：额度区和服务器菜单显示每台服务器用的账号（邮箱打码 + 套餐）；用长期令牌时看不到账号，可以在设置里备注
- **macOS servers**, including your own Mac at 127.0.0.1: the wizard accepts macOS, and file detection, timeouts and memory checks work with macOS' BSD tools. Turn on *System Settings → General → Sharing → Remote Login* first
  **支持 macOS 服务器**（包括本机 127.0.0.1）：向导识别 macOS，文件检测、超时、内存检查都兼容 macOS 自带工具；需要先在「系统设置 → 通用 → 共享」打开「远程登录」
- Local and LAN addresses never use *Bypass local proxy*
  本机和局域网地址不再走「绕过本机代理」

### Known limitations · 已知限制
- A full wizard run against a real macOS host was not done in this release (it would add a key to the Mac's `authorized_keys`); each macOS-specific command was checked under the same zsh environment sshd uses
  这一版没有对真实 macOS 主机完整跑一遍向导（那会往 Mac 的 authorized_keys 加钥匙）；macOS 相关的每条命令都在 sshd 同样的 zsh 环境下验证过

## 1.5.0 — 2026-10-12

### Features · 功能
- **Each conversation has its own project folder**: pick the folder before the first message (folder browser with recent folders and *New folder*); Claude runs there and the per-turn file list follows it. The folder chip in the top bar shows where the conversation lives; once started it offers *new conversation in this / another folder*
  **每个对话有自己的项目文件夹**：发第一条消息前选文件夹（带最近使用和新建），Claude 就在那里运行；顶栏显示所在文件夹，开始后可以「在这个/其他文件夹开新对话」
- **File panel beside the conversation**: browse the conversation's folder, preview, download, upload by drag-and-drop, rename, delete. The full *Server files* page now covers your whole home folder
  **对话旁的文件面板**：浏览这个对话的文件夹，预览、下载、拖入上传、重命名、删除；「服务器文件」整页可浏览整个用户目录
- Opening a folder switches the path bar immediately and shows loading in the list, instead of staying on the previous folder until the listing arrives
  打开文件夹时路径栏立即切换、列表显示加载中，不再停在上一个文件夹
- **Send while Claude is replying**: messages queue under the conversation and go out in order when the turn ends; a queued message can be withdrawn (its text returns to the input box) without affecting the running turn
  **回复中也能发消息**：先排队，这一轮结束后按顺序发出；排队中的消息可以撤回，不影响 Claude 正在做的事
- **`/restart`**: stop this conversation's running process, reconnect, reload MCP / Skill lists. (Every message already starts a fresh Claude Code process, so new plugins, hooks and global rules apply from the next message)
  **`/restart`**：停掉正在运行的进程、重连、重新读取 MCP/Skill；本来每条消息就会启动新的 Claude Code 进程，新装的插件/钩子/规则下一条消息即生效
- **Context breakdown**: click the context meter to see usage by category (read with `/context` without writing to the conversation) and compact with one click
  **上下文明细**：点击上下文用量查看分类占用（不写入对话），一键压缩
- **Plan usage always visible** in the sidebar: 5-hour and weekly windows (plus any model-specific window Claude reports, e.g. while using Fable), updated after every message, with reset times; a refresh button sends one tiny Haiku request
  侧栏**常驻显示额度**：5 小时、本周（以及使用 Fable 等时报告的其他窗口），每条消息后自动更新并显示重置时间；刷新按钮会发一个极小的 Haiku 请求
- **Timeline moved to the left** and reworked: a marker snaps to the message you are reading and springs to the next one as you scroll; drag it (it stretches) and the conversation follows; the mouse wheel steps message by message
  **时间轴移到左侧**并重做：标记吸附在正在看的那条消息上，滚动时带回弹地跳到下一条；可以拖动（会被拉长），对话同步滚动；滚轮一条一条地跳
- Settings icon is now a gear
  设置图标改成齿轮

### Known limitations · 已知限制
- The plan-usage endpoint (`/api/oauth/usage`) rejects the long-lived token, so usage comes from what Claude reports with each reply; the meaning of `seven_day_overage_included` (seen when using Fable) is not documented and is shown as "本周（含超额）"
  订阅额度接口不接受长期令牌，额度取自每次回复附带的信息；使用 Fable 时出现的 `seven_day_overage_included` 含义无文档，显示为「本周（含超额）」

## 1.4.4 — 2026-10-12

### Features · 功能
- **Multiple servers**: a server switcher at the top of the sidebar lists every server with its conversation count; switch, add a server (through the setup wizard), rename or remove servers. Each server keeps its own connection settings and its own conversations. Existing settings become the first server automatically
  **多台服务器**：侧栏顶部的服务器切换器列出所有服务器和各自的对话数，可以切换、添加（走配置向导）、改名、删除；每台服务器有自己的连接配置和对话列表，原有配置自动成为第一台
- **`/login`** (also *Settings → Log in to Claude again*): re-authorize Claude on the current server — for an expired token or another Claude account. A "login expired" error now carries a *Log in* button
  **`/login`**（设置里也有「重新登录 Claude」）：给当前服务器重新授权 Claude，用于令牌过期或换账号；登录失效的报错里直接带「登录 Claude」按钮
- `/server` switches servers from the input box
  输入框 `/server` 快速切换服务器

### Known limitations · 已知限制
- Completing `/login` with a real authorization code has not been run end to end in this release (the flow is the same one the setup wizard uses)
  这一版没有用真实授权码把 `/login` 从头走完一遍（流程和配置向导用的是同一套）

## 1.4.3 — 2026-10-12

### Features · 功能
- **Slash commands** in the input box: type `/` for a menu (arrow keys + Enter). App commands — `/resume`, `/model`, `/rewind` open an inline picker; `/clear`, `/rename`, `/branch`, `/mcp`, `/history`, `/files`, `/plugins`, `/settings` act directly. Claude Code commands (`/compact`, `/context`, `/cost`, `/init`) and every Skill are sent to Claude; compaction shows progress and a notice
  输入框**斜杠命令**：打 `/` 弹出菜单，方向键选择、回车执行。`/resume`、`/model`、`/rewind` 在菜单里继续选；`/clear`、`/rename`、`/branch`、`/mcp` 等直接执行；`/compact`、`/context`、`/cost`、`/init` 和所有 Skill 发给 Claude，压缩时显示进度
- **Edit any of your messages** and resend: the reply is regenerated from that point; the original conversation is kept as "（编辑前）". Attachments of the edited message are restored
  **编辑历史消息**并重新发送，从这条消息重新生成；原对话另存为「（编辑前）」，附件自动带上
- **Preview opens as a resizable side panel** next to the conversation instead of covering it, with a maximize button
  **预览改为右侧可拖动宽度的分栏**，不再挡住对话，可一键放大
- Settings are easier to find: a labeled *Settings* entry in the sidebar, version number at the bottom (click to check for updates), a *Version & updates* box at the top of Settings, and on macOS *Settings…* (⌘,) and *Check for Updates…* in the app menu
  设置更好找：侧栏有「设置」按钮，底部显示版本号（点击检查更新），设置顶部有「版本与更新」，macOS 菜单栏有「设置…」（⌘,）和「检查更新…」
- Plugin icons on the plugins page and in the store
  插件页和商店显示插件图标

### Fixes · 修复
- The plugin store list is read through the GitHub API first, so new plugin versions show up immediately instead of after CDN caches expire
  插件列表优先通过 GitHub API 读取，新版本发布后立即可见，不再受 CDN 缓存影响

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
