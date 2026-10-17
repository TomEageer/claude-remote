# Changelog · 更新日志

## 1.7.5 — 2026-10-17

### Changes · 改动
- **Saving no longer blocks the window**: large conversations are written to disk in the background instead of synchronously; the main process event loop is freed within 1 ms instead of 20–30 ms. Only conversations that actually changed are written — folding a group, switching models, or switching away from a big conversation no longer rewrites 6 MB to disk
  **存盘不再卡窗口**：大对话改成后台写盘，主进程事件循环从卡 20-30 毫秒降到 1 毫秒以内。只有真正改过的对话才重写——折叠分组、切模型、从大对话切走不再每次写 6 MB
- **Replies are saved every two seconds while streaming**, so closing the window mid-reply no longer loses the half-written answer
  **回复过程中每两秒存一次**，回复到一半关窗口不再丢掉已经显示的那半截
- **Disk writes are atomic**: a temporary file is written first and then renamed, so a crash or force-quit can never leave a half-written file; on Windows, retries handle brief EPERM/EBUSY locks from antivirus or indexing
  **写盘是原子的**：先写临时文件再改名替换，强退或崩溃不会留下写了一半的文件；Windows 上杀毒软件或索引短暂占用文件时会自动重试

### Fixes · 修复
- When the phone answered an expired question in a background conversation, the "expired" state was not saved
  手机回答后台对话里已过期的提问时，「已过期」状态没有存下来
- Test builds no longer show extra icons in the Dock
  测试包不再在 Dock 上弹出多余的图标

## 1.7.4 — 2026-10-17

### Changes · 改动
- **Phone stays connected when the computer's screen turns off**: while remote control is on, the computer no longer goes to sleep on its own (the screen still turns off; closing a laptop lid still sleeps — can be turned off in Settings → Remote control), and after waking or unlocking it reconnects to the phone right away instead of waiting for the heartbeat to time out
  **电脑息屏后手机照样能连**：开着远程控制时电脑不再自己睡着（屏幕照样会关；笔记本合盖仍会睡，可在「设置 → 远程控制」关掉），睡醒或解锁后立刻重连手机，不再等心跳超时
- **Phone stays in portrait**: the Android app and the phone page added to the home screen on Android no longer rotate to landscape (Safari on iPhone does not allow pages to lock orientation; use the rotation lock in Control Center)
  **手机固定竖屏**：安卓 App 和安卓上添加到主屏幕的手机页面不再转成横屏（iPhone 的 Safari 不允许网页锁方向，用控制中心的竖排方向锁定）
- **Timeline tooltip shows the full date and time** of each question (with today / yesterday marked) and how long the reply took; the timeline also pages by itself when the pointer rests at its top or bottom edge
  **时间轴提示显示完整日期时间**（今天 / 昨天会标出来）和这一轮回复用了多久；鼠标停在时间轴上下边缘会自己往前 / 往后翻
- **Groups show when something inside is running**: a small spinner (and the count when more than one) next to the group name, visible even when the group is collapsed
  **分组里有对话在跑会显示出来**：分组名旁一个转圈（不止一个时带个数），折叠着也看得到
- **Compacting the context shows elapsed time and an estimated progress bar** (Claude does not report real progress, so the bar is an estimate based on the context size and says so)
  **压缩上下文显示已用时间和预估进度条**（Claude 不汇报真实进度，进度条按上下文大小估算，界面上写明了）
- **Uses less CPU**: while Claude replies the message is redrawn at most about 12 times a second and finished paragraphs are kept as they are (text you have selected and table columns you have dragged are no longer reset); parsed Markdown is reused; the glowing bar above the input box and the "waiting for you" blink no longer recalculate styles every frame; when the window is minimized animations and redraws pause and catch up when it comes back
  **更省 CPU**：回复过程中每秒最多重画十来次，已经写完的段落原样保留（选中的文字、拖过的表格列宽不再被冲掉）；排好版的 Markdown 复用；输入框上方的灯带和「等你选择」的闪烁不再每帧重算样式；窗口最小化时动画和重画暂停，恢复后一次补齐
- **Saving large conversations blocks the window less**: messages are converted to text before being handed to the main process
  **大对话存盘卡得更少**：消息先转成文本再交给主进程写盘
- **macOS: folder access is remembered across updates** when the app is signed with a stable identity (it asks once more after this update)
  **macOS：文件夹访问权限升级后不再重复询问**（用固定签名，这次升级后还会再问一次）
- **Test builds are labelled**: local test builds carry a `-test` version and a 测试版 tag, and update to the release of the same version
  **测试包有标签**：本地测试包带 `-test` 版本号和「测试版」标记，正式版出来后会提示更新

### Fixes · 修复
- When sending in a conversation you were not looking at failed, the error message was not saved
  在没打开的对话里发送失败时，错误信息没有存下来

## 1.7.3 — 2026-10-17

### Changes · 改动
- **Feature tour for first-time users**: a step-by-step guide that highlights where to click — conversations on the server (refresh, filter by folder, import), company VPN for remote servers, extensions and file preview, Feishu notifications, using it from a phone (iPhone via the browser, Android app) and usage statistics. It uses demo data that is removed when the tour ends; run it again from Settings → General
  **第一次用的功能介绍**：一步步高亮该点的地方——服务器上的会话（刷新、按文件夹找、导入）、远程服务器的公司 VPN、拓展功能和文件预览、飞书通知、手机远程控制（iPhone 用浏览器、安卓 App）和用量统计。用的是演示数据，介绍结束自动清掉；在「设置 → 通用」里可以再看一遍
- **Android app** (`ClaudeRemote-Android.apk`): opens your relay's phone page full screen, remembers the relay address, lets the page use the camera to scan the pairing code and pick photos and files to send. Settings → Remote control has a download button and explains how to use it on iPhone
  **安卓 App**（`ClaudeRemote-Android.apk`）：全屏打开你中转服务器上的手机页面，记住中转地址，页面里能用摄像头扫配对码、选照片和文件发送。「设置 → 远程控制」里有下载按钮，也写了 iPhone 怎么用
- **Scrolling up while Claude replies no longer fights you**: any upward scroll (wheel, trackpad, scrollbar, keys) stops following new text; scroll back to the bottom or click "back to latest" to follow again
  **Claude 回复时往上翻不再被拽回去**：只要往上翻（滚轮、触控板、拖滚动条、键盘）就不再跟着新内容走，自己滚回底部或点「回到底部」才接着跟
- **"Claude is still working…"** appears when a reply pauses for a few seconds after some text, so a turn that is still running no longer looks finished
  **「Claude 还在继续…」**：回复写完一段后停了几秒（在想下一步、在等别的助手），末尾会显示这个提示，不会看着像结束了却还在转
- **The timeline stays readable in very long conversations**: one tick per question you asked (Claude's reply sits between two ticks), always at a comfortable fixed spacing; when they don't fit, the timeline shows the stretch you are reading and slides along with you, fading at the ends, instead of squeezing thousands of ticks into a smear. The tip shows "round N of M", your question and the start of the reply; dragging to an edge keeps paging, faster the longer you hold
  **超长对话的时间轴不再越挤越密**：只给你的提问画刻度（每轮一根，Claude 的回复在两根之间），永远是舒服的固定间距；放不下时只显示你正在看的那一段，跟着阅读位置滑动，上下两头淡出，而不是把几千根挤成一片。提示显示「第几 / 共几轮」、你问的话和回复开头；拖到上下边缘会一直往前 / 往后翻，按得越久越快
- **Choose the default folder for new conversations from the folder button**: the menu says where new conversations start (the folder you used last, or a fixed one), lets you pin the current folder as the default or switch back, and for a new conversation offers "choose folder…" and recently used folders
  **在右上角文件夹按钮里设新对话的默认文件夹**：菜单里写明新对话默认在哪（用上次选的，或者你固定的），可以把当前文件夹设为默认、也能改回；新对话时还能直接选最近用过的文件夹
- **Side questions (btw) never end blank**: if the streamed text is missing the answer is taken from the full message, and if Claude gave no text at all the panel says so instead of showing an empty card; the "thinking" spinner there is no longer squashed
  **旁问不会再空白结束**：逐字的流没收到时从完整消息里取回答；Claude 真的一个字没答时会说明原因，不再留空白；「正在想」前面的转圈不再被挤成一条线
- Layout fixes: the Android download button and the feature-tour row in Settings
  排版修正：设置里的「下载安卓 App」按钮和「功能介绍」那一行

## 1.7.2 — 2026-10-17

### Changes · 改动
- **"Back to latest" button** like Claude's: when you scroll up more than half a screen, a small round button appears above the input box; it gets a dot when new reply text arrives below, and one click scrolls to the bottom (or jumps back to the latest messages after the timeline took you far back)
  **「回到底部」按钮**（照着 Claude）：往上翻超过半屏时输入框上方出现一个小圆按钮，下面有新回复时带个小点，点一下滚到最底（从时间轴跳到很早的位置时直接回到最新）
- **Pairing a phone shows "paired"**: as soon as the phone that scanned the QR code talks to this computer, the QR window turns into a success message and closes itself; if the window was already closed, a notice pops up instead
  **手机扫码配对成功会提示**：扫码的手机一连上，二维码窗口就变成「配对成功」并自动关闭；窗口已经关了的话会弹一条提示
- **The slash-command menu no longer jumps** when you press ↑ / ↓ with the mouse resting over the list — the selection only follows the mouse when the mouse actually moves
  **斜杠命令菜单上下选不再乱跳**：鼠标停在列表上时按方向键，选中项不会被鼠标底下滚过来的项抢走，只有鼠标真的动了才跟着鼠标
- **Settings → Remote control and Notifications use the full width** like the other tabs
  **设置里「远程控制」「通知」两页和其他页一样铺满宽度**
- **Relay management page** at `/admin` (open the link from `crrelay admin`): one access token per person — create, edit, disable, delete, regenerate and reveal them in the browser; global rules and per-person overrides; this month's, today's and daily traffic per person and per computer, today's remaining allowance, current speed and who is being throttled; also how much the phone web app itself used. Computers now send their remote-control name so you can tell whose computer it is
  **中转管理页面** `/admin`（用 `crrelay admin` 打印的链接打开）：每人一个访问令牌，在网页上新建、编辑、停用、删除、换新、再看一次；全局规则和每人单独设置；每个人、每台电脑本月 / 今天 / 每天的流量，今天额度还剩多少、此刻多快、谁在被限速，以及手机网页本身用了多少。电脑端连接时带上「远程控制」里的名字，能看出是谁的电脑
- **Traffic control that never disconnects**: chat and replies are never limited. Uploading and previewing files first uses a daily full-speed allowance (default 20 MB per computer), then slows to a set speed (default 128 KB/s) while still letting small files (default 2 MB) through instantly. A monthly cap for everyone together (default 50 GB, people set to "unlimited" not counted) slows file transfers further (default 32 KB/s) until the 1st. You can give one computer extra allowance for today. Days reset at midnight Beijing time
  **不会断开的流量管控**：聊天和看回复永远不限。传文件、预览文件先用每天的全速额度（默认每台电脑 20 MB），用完后限速（默认 128 KB/s），小文件（默认 2 MB 以内）照样秒传。全员每月总量上限（默认 50 GB，「不限」的人不算）超了以后传文件再降速（默认 32 KB/s），下月 1 号恢复。可以给某台电脑临时加今天的额度。按北京时间 0 点算一天
- The relay no longer prints the access token in its log · 中转启动日志里不再打印令牌原文

## 1.7.1 — 2026-10-16

### Changes · 改动
- **See what background tasks are doing**: a running helper (subagent) lists its latest three steps right in the background tasks panel — done steps ticked, the current one highlighted; background commands show the command they are running, and an empty output now says the command simply hasn't printed anything yet
  **后台任务看得出在干什么**：运行中的助手在后台任务面板里直接列出最近三步（做完的打勾，正在做的高亮）；后台命令显示正在跑的是哪条命令；没有输出时说明是命令还没打印内容，而不是一个空框
- **Very long conversations stay smooth**: only the latest 40 messages are drawn when you open a conversation; scrolling up loads earlier ones without the view jumping, and jumping far back on the timeline draws just that stretch (a bar at the bottom brings you back to the latest). A 3,000-message conversation now opens in about 35 ms
  **超长对话不再卡**：打开对话时只画最后 40 条，往上滚自动补更早的（画面不跳）；时间轴跳到很早的地方只画那一段，底部有一条「回到最新」。3000 条消息的对话打开约 35 毫秒
- **The timeline is drawn on one canvas** and only recalculated when the number of messages changes, so thousands of messages cost one element instead of thousands; crowded ticks become a fine light texture instead of a thick bar
  **时间轴改成画在一块画布上**，只有消息条数变了才重算；几千条消息不再是几千个元素。挤在一起的刻度变成一片细密的淡纹理，不再糊成一根粗柱子
- **Saving only writes what changed**: each conversation's messages now live in their own file, and while Claude replies only that conversation is written (about 1.5 ms instead of copying the whole history every 0.4 s). Existing data is split automatically the first time it is saved
  **存盘只写有变化的对话**：每个对话的消息单独存一个文件，回复过程中只写正在回复的那个（约 1.5 毫秒，以前每 0.4 秒整份复制全部历史）。老数据第一次存盘时自动拆开

## 1.7.0 — 2026-10-16

### Changes · 改动
- **The timeline magnifier chases the pointer**: instead of snapping to the mouse, the magnified spot follows it like a spring — it speeds up when the pointer is far away, slows down as it arrives, then tracks it; zooming in and out fades instead of popping
  **时间轴的放大效果追着鼠标走**：放大中心不再一下跳到鼠标下，而是像弹簧一样追过去——离得远先加速、快到了减速、追上后贴着走；放大和收起也是渐变的
- **The phone's Claude spark eases**: each turn speeds up and slows down instead of spinning at one constant speed, and the speed matches across loops so there is no seam
  **手机上的 Claude 星芒有加减速了**：每一圈先快后慢地转，不再匀速；圈与圈之间速度接得上，没有接缝
- **New README screenshots** of the current app, light and dark, plus the phone remote control
  **README 换成当前版本的截图**（浅色和深色），新增手机远程控制的截图

## 1.6.9 — 2026-10-16

### Changes · 改动
- **Background tasks grouped by the message that started them**: each group shows the start of your message, when you sent it and how many tasks it has (or how many are still running); groups with running tasks and the newest group are open, older ones fold away, and each task is now a compact single row with running ones first
  **后台任务按「你的哪条消息触发的」分组**：每组显示那条消息的开头、发送时间和任务数（或几个还在运行）；有任务在跑的组和最新一组展开，旧的自动收起；每个任务压成紧凑的一行，运行中的排最前
- **The send / stop button stays put**: it sits in a fixed spot and fades between send and stop instead of jumping as the elapsed time and context numbers change width
  **发送 / 停止按钮不再乱跳**：固定在一个位置，发送和停止原地淡入淡出切换；旁边的用时、上下文数字变长变短也不会挤动它
- **Softer "replying" light strip** above the input box: it fades out at both ends instead of being cut off, and fades in when a reply starts
  **输入框上方「回复中」的灯带更柔和**：两头渐隐，不再在端点硬切，开始回复时淡入
- **The Claude spark on the phone spins smoothly**: one continuous turn with a separate gentle pulse, no more pause and jump between loops
  **手机上的 Claude 星芒转得顺了**：匀速连续旋转，另加轻微呼吸，不再每转一段就停顿、跳回去

## 1.6.8 — 2026-10-16

### Changes · 改动
- **A light divider line between groups** in the sidebar (computer and phone)
  **侧栏分组之间加了一条浅色分隔线**（电脑和手机）
- **"Finished, not yet read" marks use Claude's clay orange** (#d97757, from the official app) instead of green, on the computer and the phone; errors stay red and "waiting for your choice" stays amber
  **「回复完了、还没看」的提示点改成 Claude 官方的陶土橙**（#d97757，取自官方客户端），不再是绿色，电脑和手机都改了；出错仍是红色，等你选择仍是琥珀色
- **Conversation timeline redesigned after macOS Time Machine**: one short tick per message, evenly spaced instead of squeezing the whole conversation into the bar; hovering magnifies and spreads the ticks around the pointer like the Dock, so even hundreds of messages can be picked one by one. Your messages have longer accent ticks; the current one is longest. Click, drag, wheel, arrow keys and trackpad haptics work as before
  **对话时间轴照着 macOS「时间机器」重做**：每条消息一根短刻度、间距均匀，不再把整段对话按篇幅塞满整条轴（消息多了会挤成一坨）；鼠标移上去，附近的刻度像程序坞一样放大拉开，几百条消息也能一条条点中。你说的话刻度更长、带主题色，当前那条最长；点击、拖动、滚轮、方向键和触控板震感照旧
- **MCP · Skill · Plugins: same toolbar on all three tabs, now with search**: the main button on the left (the plugin install button no longer drifts right), a search box on the right that filters by name and description
  **「MCP · Skill · 插件」三页统一顶栏，并加了搜索**：主按钮都在左边（插件页的安装按钮不再跑到右边），右边是搜索框，按名称和说明实时过滤

## 1.6.7 — 2026-10-16

### Changes · 改动
- **Groups stand out in the sidebar** (computer and phone): each group header has an icon, a darker bold name and a count badge, and its conversations are indented under a guide line, with more space between groups
  **侧栏分组更醒目**（电脑和手机）：分组标题带图标、名字加深加粗、数量用角标，组里的对话缩进并挂在一条竖线下，分组之间留出间隔

## 1.6.6 — 2026-10-16

### Changes · 改动
- **Manage groups from the phone**: create, rename and delete groups (conversations in a deleted group move to Ungrouped), and move a conversation into a group from its long-press menu, with "new group and move in" in one step; group headers on the phone collapse and expand; everything stays in sync with the computer
  **手机上可以管理分组**：新建、改名、删除分组（删除后里面的对话移到「未分组」），长按对话「移到分组」，也可以一步「新建分组并移进去」；手机上的分组标题可以收起 / 展开；和电脑上的分组保持同步

## 1.6.6 — 2026-10-16

### Changes · 改动
- **Manage groups from the phone**: create, rename and delete groups (the folder button at the top of the chat list, or "⋯" on a group), and move a conversation into a group by long-pressing it; changes go straight to the computer. Group headers on the phone collapse and expand, and empty groups stay visible so you can move conversations into them
  **手机上可以管理分组**：新建、改名、删除分组（对话列表顶部的文件夹按钮，或分组右边的「⋯」），长按对话可以移到分组，改动直接同步到电脑；手机上的分组标题可以收起展开，空分组也会显示，方便往里移

## 1.6.5 — 2026-10-16

### Fixes · 修复
- **Remote control dropped every two minutes while the app was in the background**, so messages and pictures sent from the phone could hang. The background window no longer slows its timers, and the heartbeat now sends a ping and waits for the answer instead of judging from the last message received
  **软件在后台时远程连接每两分钟断一次**，手机发的消息和图片会卡住。现在窗口在后台也不降低定时器频率，心跳改成先发再等回应，不再按「多久没收到消息」误判断线
- **Pictures sent from the phone went to the wrong server**: they were uploaded to the server selected on the computer instead of the one the conversation runs on, so Claude could not find them
  **手机发的图片传错了服务器**：之前传到电脑上当前选中的服务器，而不是对话所在的那台，Claude 找不到文件
- **The phone's status bar follows the chosen appearance** instead of always following the system light / dark mode
  **手机顶部状态栏的颜色跟着选择的外观走**，不再总是跟随系统深浅模式

## 1.6.4 — 2026-10-15

### Changes · 改动
- **Preview generated files on the phone**: replies show a "files generated this turn" card, and file paths in replies are tappable. Files are fetched through the computer (end-to-end encrypted) and open right on the phone: Markdown is rendered, images can be pinch-zoomed, CSV shows as a table, PDFs, videos and audio play inline, and web pages run in an isolated sandbox. Word, Excel, PowerPoint and other files open through the share button (Quick Look, Save to Files, other apps)
  **手机上可以预览生成的文件**：回复下面有「本轮生成的文件」，回复里的文件路径也能点。文件经电脑取过来（端到端加密），直接在手机上看：Markdown 按格式显示、图片可以双指放大、CSV 显示成表格、PDF 和音视频直接播放、网页在隔离的沙盒里运行；Word、Excel、PPT 等用分享按钮交给系统打开（快速查看、存到「文件」、发给别的应用）
- **Remote control uses about 1/250 of the data**: while Claude replies, only the new text and the steps that changed are sent to the phone instead of the whole message every time (a reply with 20 tool steps and 3,000 characters went from 16 MB to 67 KB)
  **远程控制的流量降到原来的约 1/250**：回复过程中只把新增的文字和有变化的步骤发给手机，不再每次重发整条消息（一次 20 个工具步骤、3000 字的回复，从 16MB 降到 67KB）
- **Messages waiting in the queue show on the phone**: a message sent while Claude is busy and that will go out when the reply finishes now shows as a dashed "queued" bubble you can withdraw (the text goes back into the input box); messages Claude will pick up mid-reply are labelled as such
  **排队中的消息在手机上看得到了**：Claude 忙的时候发的、要等这一轮结束才发出的消息，现在显示成虚线的「排队中」气泡，可以撤回（内容放回输入框）；回复途中直接交给 Claude 的消息也会注明
- **More room for the chat list on the phone**: the quota bars moved to Settings; the bottom of the list is now one line with the computer status and two small quota rings
  **手机上对话列表更宽敞**：额度条挪到了设置页，列表底部只留一行：电脑状态和两个额度小圆环
- **The phone page opens instantly**: it is cached on the phone, the server sends compressed files, and the chat list from last time shows right away
  **手机页面秒开**：页面缓存在手机上，服务器发压缩过的文件，上次的对话列表马上显示

## 1.6.3 — 2026-10-15

### Changes · 改动
- **See shell commands and subagents on the phone**: tap a step to see the full command and its output; subagents show their task, model, every step they took and their conclusion; commands running in the background are marked and show their progress; the collapsed row follows whatever is running right now
  **手机上能看到命令和子助手的内容**：点开一步可以看到完整命令和输出；子助手显示任务、模型、它做的每一步和最后的结论；放到后台运行的命令有标记并显示进度；折叠的那一行实时显示正在做什么
- **Swipe the keyboard away**: drag down on the messages (or tap them) to close the keyboard
  **滑动收起输入法**：在消息区往下拖（或点一下消息区）就收起键盘

### Fixes · 修复
- **"No response" on the phone**: connections that iOS silently dropped in the background were only noticed much later. The phone and the computer now send a heartbeat and reconnect within seconds; requests made while reconnecting wait for the connection instead of failing, and reading requests are retried once
  **手机上经常「没有响应」**：iPhone 在后台时会悄悄断开连接，很久之后才发现。现在手机和电脑都有心跳，几秒内自动重连；重连期间的操作会等连上后再发，读取类的操作断了会自动重试一次
- **Choosing a server on the phone showed no conversations** when the computer was on an older version
  **手机上选了某台服务器后对话列表是空的**（电脑端是旧版本时）
- **Less data while Claude works**: only the messages that changed are sent to the phone
  **回复时流量更省**：只把有变化的消息发给手机

## 1.6.2 — 2026-10-15

### Changes · 改动
- **Phone app feels native**: swipe right from anywhere to open the chat list and swipe left to close it (it follows your finger), drag sheets down to dismiss, swipe right to leave Settings; the composer stays right above the keyboard instead of jumping to the top; double-tap and pinch zoom are disabled
  **手机端操作更顺手**：任意位置从左往右滑打开对话列表、往左滑收起（跟手），底部弹层往下拖关闭，设置页往右滑返回；输入法弹出时输入框贴在键盘上方，不再被顶到最上面；禁止双击和双指放大
- **Replies stream smoothly on the phone**: the computer pushes updates about three times as often, only the message that changed is redrawn, and new text is typed out continuously instead of arriving in chunks
  **手机上的回复流畅了**：电脑推送更频繁，只重画有变化的那条消息，新文字连续地打出来，不再一段一段地跳
- **Phone settings page**: computer status and reconnect, server, model and thinking effort (now a slider), quota, appearance (system / light / dark), text size, re-pair or unpair
  **手机端设置页**：电脑状态和重新连接、服务器、模型和思考强度（改成滑动条）、额度、外观（跟随系统 / 浅色 / 深色）、文字大小、重新配对或取消配对
- **Switch servers on the phone**: the chat list can show one server or all of them, and new chats default to the chosen server
  **手机上可以切换服务器**：对话列表可以只看某台服务器或全部，新对话默认在选中的那台运行
- **Relay auto-update never downgrades**: a relay updated by hand is no longer replaced by an older GitHub release
  **中转程序自动更新只往新版本升**：手动装了新版本后，不会被 GitHub 上的旧版换回去

## 1.6.1 — 2026-10-15

### Changes · 改动
- **Phone app redesigned after the Claude mobile app**: chat list in a side drawer (pinned, groups, search, long-press to rename / pin / delete, computer status and quota at the bottom), a greeting home screen, a rounded composer, consecutive tool steps folded into one expandable row, copy buttons for replies and code
  **手机端照 Claude 手机版重新设计**：对话列表放进左侧抽屉（置顶、分组、搜索，长按可重命名 / 置顶 / 删除，底部显示电脑状态和额度），问候首页，圆角输入卡片，连续的工具步骤收成一行可展开，回复和代码块可以一键复制
- **More of the desktop on the phone**: send photos and files (camera, photo library, files; large photos are shrunk first), switch model and thinking effort, plan mode, pick the server and folder for a new chat, `/` command list
  **手机上能做更多电脑上的事**：发图片和文件（拍照、相册、文件，大照片先压缩）、切换模型和思考强度、计划模式、新对话选服务器和文件夹、输入 `/` 列出命令
- **Pairing without the system camera**: the phone page can scan the QR code itself, or take a pairing code copied from the desktop
  **配对不再依赖系统相机**：手机页面里可以直接调起摄像头扫码，也可以粘贴电脑上复制的配对码
- **Hard to miss when Claude needs you**: a conversation waiting for your choice or approval pulses in the sidebar until you open it, then keeps a "待选择" tag until answered; collapsed groups pulse too; the top bar links to it from other conversations; the Dock icon bounces (taskbar flashes on Windows) when the app is in the background; the phone shows the same
  **需要你做选择时更显眼**：在等你选择或批准的对话在侧栏里一直闪，点开看过后留「待选择」标记，回答完消失；收起的分组也会闪；在看别的对话时顶栏有提醒，点一下跳过去；软件在后台时程序坞图标跳动（Windows 任务栏闪烁）；手机上同样会提醒
- **Version number moved into the Settings row** instead of taking a line of its own
  **版本号并到「设置」那一行**，不再单独占一行

## 1.6.0 — 2026-10-15

### New · 新功能
- **Remote control from your phone, through your own server**: install the relay `crrelay` on any server with one command (it serves the phone web app too), enter its address and token under Settings → Remote control, then scan a QR code with your phone. On the phone you can watch replies stream in, send messages (merged into a running reply like on the desktop), start new conversations, stop a reply, answer Claude's questions and approve plans. Everything between phone and computer is end-to-end encrypted with a per-phone key; the relay only sees ciphertext. The relay is released with every version and updates itself daily. See [docs/remote-control.md](docs/remote-control.md)
  **手机远程控制（走你自己的服务器）**：一条命令在服务器上装好中转程序 `crrelay`（手机网页也在里面），在「设置 → 远程控制」填上地址和令牌，用手机扫码就能用。手机上可以看实时回复、发消息（回复进行中会像电脑上一样合并进当前这一轮）、开新对话、停止回复、回答 Claude 的提问、批准计划。手机和电脑之间的内容用每台手机独立的密钥端到端加密，中转服务器只看到密文。中转程序跟着每个版本一起发布，装好后每天自动更新。说明见 [docs/remote-control.md](docs/remote-control.md)

### Changes · 改动
- **Quota panel shows how long until each reset**, then the date and time, e.g. "11 h 16 min left · Fri Oct 16 06:00"
  **额度面板先显示还剩多久重置**，再写哪天几点，比如「还剩 11 小时 16 分钟 · 10月16日 周五 06:00 重置」

### Fixes · 修复
- **Server files went blank after switching servers**: opening Server files for the first time after switching servers showed an empty page
  **切换服务器后「服务器文件」白屏**：切换过服务器之后第一次打开「服务器文件」，整页是空白的
- **Usage statistics counted branches, rewinds and imported conversations twice**: their first reply carried the original conversation's accumulated usage, which was recorded again. The app now subtracts the source conversation's reading; for imported conversations without one, only the reply's own main-model usage is recorded
  **用量统计把分支、回退、导入的对话重复算了**：这些对话第一次回复时带着原对话以前的累计用量，被又记了一遍。现在会减掉来源对话的读数；导入的对话没有读数时，只记这一轮主模型自己的用量

## 1.5.45 — 2026-10-15

### Changes · 改动
- **Each conversation keeps its own draft**: unsent text and attachments stay with the conversation you typed them in, instead of following you to the next one; they come back when you return (and survive a restart)
  **每个对话有自己的草稿**：没发出的文字和附件留在原来的对话里，不再跟着切到别的对话；切回来就恢复（重启后也在）
- **Conversation names follow the server**: a name set with `/rename` in the terminal (or by Claude Code's automatic title, for conversations you haven't renamed yourself) now updates the sidebar when the app connects or comes back to the front
  **对话名字跟服务器同步**：在终端里 `/rename` 改的名字（以及没手动改过名的对话的 Claude Code 自动标题），在软件连上服务器或回到前台时会同步到侧栏
- **Drag groups to reorder them** in the sidebar (Pinned and Ungrouped stay where they are)
  **侧栏分组可以拖动排序**（「置顶」和「未分组」位置固定）

## 1.5.44 — 2026-10-15

### Fixes · 修复
- **App commands typed with an argument went to Claude Code**: e.g. `/branch test` was sent as a message and Claude Code answered "/branch isn't available in this environment". Commands the app implements (`/branch`, `/rename`, `/status`, `/export`, …) are now always handled by the app, with or without arguments; `/branch name` creates the branch and names it
  **带参数的软件命令被发给了 Claude Code**：比如 `/branch test` 被当成消息发出去，Claude Code 回复「/branch isn't available in this environment」。现在软件自己实现的命令（`/branch`、`/rename`、`/status`、`/export` 等）不管带不带参数都由软件处理；`/branch 名字` 会分出分支并直接命名

## 1.5.43 — 2026-10-15

### Fixes · 修复
- **Update stuck at "downloading 100%"**: after the code package finished, the VPN component was downloaded in the same step with no progress and no timeout, so a stalled connection left the update hanging. The update is now ready as soon as the code package is in; the VPN component downloads separately in the background, and every download gives up after 30 seconds without data (and is retried at the next check)
  **更新卡在「正在下载 100%」**：代码包下完后，同一步里还要下载 VPN 组件，既没有进度也没有超时，网络一卡就一直挂着。现在代码包下好就提示可以重启，VPN 组件另外在后台下载；所有下载 30 秒没有数据就放弃，下次检查时再试

## 1.5.42 — 2026-10-15

### Changes · 改动
- **Server files: sorting and a typeable path**: sort by name, size, modified, added (creation) or last-opened time — click a column header (again to reverse), or use the sort button in the narrow panel; folders stay on top and the choice is remembered. Click an empty spot of the path bar (or the last part) to type or paste a path and press Enter to go there
  **服务器文件：可以排序、路径可以直接输入**：按名称、大小、修改时间、添加时间（创建时间）、上次打开时间排序——点列头（再点一次反过来），窄面板用顶栏的排序按钮；文件夹始终在前，排序方式会记住。点路径栏空白处（或最后一级）可以直接输入 / 粘贴路径，回车跳过去

## 1.5.41 — 2026-10-15

### Changes · 改动
- **Messages sent during a reply work like Claude Code**: instead of waiting in a local queue until the turn ends, a message you send while Claude is working goes straight to it; Claude reads it at its next step and folds it into the current work (falls back to the queue only if the turn has just ended, or on Windows servers)
  **回复中发的消息和 Claude Code 原生一样处理**：不再在本地排队等这一轮结束，而是直接交给正在工作的 Claude，它在下一步读到后合并进当前的工作一起处理（只有这一轮刚好结束、或 Windows 服务器时才退回排队）

## 1.5.40 — 2026-10-15

### Changes · 改动
- **Attachments you can see**: image attachments show a thumbnail above the input box and in the sent message; uploads show their percentage; click an uploaded attachment to preview it on the right
  **附件看得见**：图片附件在输入框上方和发出的消息里都显示缩略图；上传中显示百分比；传好的附件点一下在右边预览
- **Preview from file tool cards**: "Read / create / edit file" cards have a Preview button; when Claude reads an image the card no longer shows just "[image]"
  **文件工具卡片可以预览**：「读取 / 创建 / 修改文件」卡片右上角有「预览」按钮；Claude 读图片时不再只显示「[image]」

## 1.5.39 — 2026-10-15

### Fixes · 修复
- **`/rename new name` didn't rename the conversation in the app**: it was sent to Claude Code, which renamed the server session, but the sidebar kept the old name. The app now handles `/rename <name>` itself: renames the conversation and syncs it to the server, without sending a message
  **`/rename 新名字` 没改到软件里的对话名**：这条命令被当成消息发给了 Claude Code，服务器上的名字改了，侧栏还是旧名字。现在 `/rename 名字` 由软件自己处理：改对话名并同步到服务器，不再发消息

## 1.5.38 — 2026-10-14

### Fixes · 修复
- **Settings would no longer open** after opening a conversation from the usage statistics, or after using "Log in to Claude" / "Run setup again" in Settings or "Add server": these removed the settings window without closing it properly, so the MCP and Extensions pages it had borrowed were lost. Dialogs are now always closed the proper way
  **设置打不开了**：从用量统计里点开对话，或者在设置里点「登录 Claude」「重新运行配置向导」、在服务器管理里点「添加服务器」之后，设置窗口没有按正常流程关闭，它借用的「MCP」「拓展功能」页面跟着丢了。现在弹窗一律按正常流程关闭

## 1.5.37 — 2026-10-14

### Fixes · 修复
- **Pasting screenshots and dragging in images did nothing**: content without a file on disk — screenshots, images copied from a web page, WeChat or Feishu, images dragged out of a browser — was silently ignored. It is now saved as a temporary file and uploaded like any other file; drags that only carry a file link are handled too, and anything that really can't be read shows a message
  **粘贴截图、拖入图片没反应**：没有本地文件的内容（截图、从网页 / 微信 / 飞书复制的图片、从浏览器拖出来的图片）之前被悄悄忽略了；现在先存成临时文件再照常上传，只带文件链接的拖拽也能识别，实在读不出的会提示
- **Timeline dragging**: the handle takes a fixed length the moment you start dragging; only when you rest on a message for half a second does it stretch or shrink to that message's length
  **时间轴拖动**：一按下滑块就变成固定长度；在某条消息上停半秒，才伸缩成那条消息的长度

## 1.5.36 — 2026-10-14

### Fixes · 修复
- **Timeline dragging**: while dragging, the handle now takes the length of the message segment under the pointer (with a short transition), instead of keeping the length of the segment you grabbed
  **时间轴拖动**：拖动时滑块的长度跟着手指下面那一段消息变（有短暂过渡），不再一直用按下时那一段的长度

## 1.5.35 — 2026-10-14

### Changes · 改动
- **Usage statistics by conversation**: a new table lists conversations by equivalent API cost, highest first, with the models used, turns and tokens; click a row to open that conversation. Usage is recorded per conversation from this version on (earlier records can't be split and are noted)
  **用量统计按对话排序**：新增「按对话」表，按折合 API 金额从高到低列出每个对话用到的模型、轮数和 token，点一行打开那个对话。从这个版本起按对话记录（之前的记录没法拆开，会注明）

## 1.5.34 — 2026-10-14

### Fixes · 修复
- **macOS: clicks on dialogs and menus were sometimes lost** — parts of a dialog lying over the window's drag area (top of the sidebar, title bar) were treated as "drag the window", e.g. the left settings tabs. Dialogs and pop-up menus are now always clickable
  **macOS：弹窗和菜单有时点不动**——弹窗压在窗口可拖动区域（侧栏顶部、顶栏）上方的部分会被当成「拖动窗口」，比如设置页左边几个标签。现在弹窗和弹出菜单的范围始终可以正常点击
- Tabs in Settings (and other segmented switches) now react to hover and press, with a pointer cursor
  设置页的标签（以及其他分段切换）悬停、按下都有反馈，鼠标变成手形

## 1.5.33 — 2026-10-14

### Changes · 改动
- **Renames sync to the server**: renaming a conversation (right-click, double-click, or `/rename`) now writes the name into Claude Code's session record on the server, the same way `/rename` does in the terminal, so `claude --resume` shows it too. Automatic titles are written as Claude Code's automatic title, and a name you set yourself always wins — also when reading sessions from the server
  **改名同步到服务器**：在软件里改对话名称（右键、双击或 `/rename`）会写进服务器上 Claude Code 的会话记录，和终端里 `/rename` 一样，`claude --resume` 里也能看到；自动起的标题按 Claude Code 自动标题的方式写入，手动改的名字始终优先（读取服务器会话时也是）

## 1.5.32 — 2026-10-14

### Fixes · 修复
- **Company VPN: "EOF" when connecting.** With a proxy tool (Shadowrocket, Clash…) running, the connection to the VPN server is occasionally dropped midway; the VPN component now retries login and tunnel setup on fresh connections instead of failing at once (a wrong password or certificate problem is still reported right away)
  **公司 VPN 连接时报「EOF」**：电脑开着 Shadowrocket、Clash 等代理软件时，到 VPN 服务器的连接偶尔会被中途断开；现在登录和建隧道都会换新连接重试，不会一次失败就放弃（密码错误、证书问题仍然立即提示）
- **VPN component updates no longer need the full installer**: it is now delivered with quick updates (about 4 MB) and checked against its hash; after updating to this version, the new component is fetched automatically on first start
  **VPN 组件更新不用再下完整安装包**：改为随快速更新下发（约 4 MB，校验后使用）；升级到这个版本后，启动时会自动取到新的组件

## 1.5.31 — 2026-10-14

### Changes · 改动
- **Settings → Network** is its own tab now (company VPN, proxy, bypass local proxy), instead of being mixed into General
  设置里新增**「网络」标签**：公司 VPN、代理、绕过本机代理都在这里，不再混在「通用」里
- **Extension sources moved to the Extensions tab**: extensions come from the official repository by default; the optional custom repository is set at the bottom of that tab and saves automatically
  **拓展来源移到「拓展功能」标签**：默认从官方仓库获取；可选的自定义仓库在这一页底部设置，改了自动保存
- **Stronger trackpad haptics**: the timeline now uses macOS's most noticeable haptic by default, with a light / medium / strong choice in Settings (it ticks once when you change it so you can feel it)
  **触控板震感更明显**：时间轴默认改用 macOS 最明显的那种震感，设置里可以选强 / 中 / 轻（选的时候会震一下让你感受）

## 1.5.30 — 2026-10-14

### Changes · 改动
- **Company VPN built in (AnyConnect / OpenConnect protocol)**: servers that are only reachable through the company VPN (Cisco AnyConnect, AnyLink, ocserv…) can now be connected directly — tick "connect through a company VPN" under Network, enter the VPN address, fetch and pick the user group, enter the account and password, and test. A small bundled component runs the VPN inside its own process for the app's SSH connection only: no virtual adapter, no system route changes, no admin rights, other apps unaffected. It dials automatically, reconnects if the link drops, asks for a one-time code if the VPN requires one, shows the certificate fingerprint for untrusted servers, and hangs up when the app quits. Passwords are encrypted with the system keychain / Windows credential store. Works on macOS and Windows. This version needs the full installer once (it is downloaded automatically)
  **内置公司 VPN（AnyConnect / OpenConnect 协议）**：只有连公司 VPN 才能访问的服务器（Cisco AnyConnect、AnyLink、ocserv 等）现在可以直接连——在「网络」里勾选通过公司 VPN 连接，填 VPN 地址、点「获取」选用户组、填账号密码，点「测试连接」。软件自带的小组件在自己进程里完成 VPN 连接，只给软件连服务器用：不建虚拟网卡、不改系统路由、不需要管理员权限，不影响别的软件。连服务器时自动拨号，断了自动重连，需要动态口令时会弹框，证书不受信任时显示指纹让你确认，退出软件自动断开；密码用系统钥匙串 / Windows 凭据加密保存。Mac 和 Windows 都支持。这个版本需要装一次完整安装包（会自动下载）
- **Pin conversations**: right-click → Pin, or drag onto the 置顶 section; pinned ones stay at the very top
  **对话置顶**：右键「置顶」，或拖到「置顶」区；置顶的对话固定在最上面
- **Conversations follow time**: a conversation you just sent a message in moves to the top of its list
  **对话按时间排**：刚发过消息的对话回到所在列表的最上面
- **Group headers**: smooth expand / collapse (like Tacivan's sidebar), counts aligned on the right, and a colored badge with the number of conversations that have unseen replies (red if any failed, orange if any wait for you)
  **分组标题**：展开收起有平滑的抽屉动画（和 Tacivan 侧栏一样），右边的数字对齐，有没看过的回复时显示彩色角标和个数（有出错的红色，有等你处理的橙色）

## 1.5.29 — 2026-10-14

### Fixes · 修复
- **Windows: "restart to update" did nothing.** Versions up to 1.5.21 replaced the app files with a cmd script after exiting; with the Chinese install folder name the script could not find the files, so the old version simply started again. Since 1.5.22 updates no longer touch the install folder, but older copies still ran their own broken updater. The Windows quick-update package is now published under a new name, so those older copies fall back to the full installer (which works) and come up to date; the full update also installs silently and reopens the app
  **Windows：点「重启更新」后没有更新。** 1.5.21 及以前的版本在退出后用 cmd 脚本替换程序文件，安装目录名有中文，脚本找不到文件，于是打开的还是旧版本。1.5.22 起更新已经不再改安装目录，但旧版本仍在用自己那套坏掉的更新方式。现在 Windows 的快速更新包换了名字，旧版本会自动改用完整安装包更新（这条路是好的）升上来；完整更新也改成静默安装、装完自动打开

## 1.5.28 — 2026-10-14

### Fixes · 修复
- Turning off side questions left the empty side panel open
  关掉旁问后，旁路面板还留在那里
- In a narrow window the buttons under the input box were squeezed into vertical text; they now stay on one line and show icons only (hover for the name) when there isn't room
  窗口变窄时输入框下面的按钮被挤成竖排；现在始终一行，放不下时只显示图标（鼠标移上去有名称）

## 1.5.27 — 2026-10-14

### Changes · 改动
- **Plan mode** (`/plan`, or the 计划 button): Claude researches and writes a plan first; a card shows the plan with "start" and "send back with notes" — nothing is changed until you approve
  **计划模式**（`/plan` 或输入框下的「计划」按钮）：Claude 先调研、写方案，弹出计划卡片，你点「按计划开始做」才动手，也可以写上意见打回修改
- **Side questions** (`/btw question`, or the 旁问 switch): ask something with the conversation as context without interrupting Claude or adding to the conversation; answers appear in a panel above the input, with copy / send to Claude. Esc leaves side-question mode
  **旁问**（`/btw 问题` 或「旁问」开关）：带着对话上下文插问一句，不打断 Claude、不进入对话；回答显示在输入框上方的「旁路」面板，可复制或发给 Claude；Esc 退出旁问模式
- **`/fork task`** runs the task in a background branch of the conversation; **`/subtask task`** does the same and brings the result back to this conversation's panel
  **`/fork 任务`** 从最新回复分出一个对话在后台做；**`/subtask 任务`** 同样在后台做，结果送回当前对话的旁路面板
- **Sub-agent model shown on its card**: the model it was sent with, then the exact model once it reports back
  **子代理卡片显示它用的模型**：派出时显示指定的模型，交回结果后显示实际型号

## 1.5.26 — 2026-10-14

### Changes · 改动
- **All of Claude Code's slash commands**: the list now comes from Claude Code on the server (everything it supports without the terminal UI, plus your skills and custom commands), instead of a fixed list. Terminal-only commands that matter are done by the app: `/status` (version, account, login method, model, working folder, MCP, quota), `/usage` (`/cost`), `/stats`, `/effort`, `/export` (Markdown), `/copy`, `/memory` (CLAUDE.md files), `/permissions` and `/hooks` (settings.json), `/cd`, `/update`, `/help`
  **Claude Code 的斜杠命令都能用**：命令列表直接来自服务器上的 Claude Code（无界面模式下能用的全部，加上你的 Skill 和自定义命令），不再写死；终端专用但有用的由软件实现：`/status`（版本、账号、登录方式、模型、工作目录、MCP、额度）、`/usage`（`/cost`）、`/stats`、`/effort`、`/export`（导出 Markdown）、`/copy`、`/memory`（CLAUDE.md）、`/permissions` 和 `/hooks`（settings.json）、`/cd`、`/update`、`/help`
- **Quota from Claude Code's own /usage**: refreshing reads `/usage` (no model request, no quota used) and shows where the usage went, in Chinese; only when that endpoint is rate limited does it fall back to the tiny Haiku / Fable requests. The account shown is re-checked when you open the quota panel, so switching accounts in the terminal shows up
  **额度改从 Claude Code 的 /usage 读取**：刷新时读 `/usage`（不调用模型、不花额度），并显示「用量都花在哪了」；只有它被限流时才退回到发极小请求的办法。打开额度面板时会重新核对账号，在终端里换了号也能看到
- **Live exchange rate** in usage statistics instead of a fixed 7.1
  用量统计里的人民币按**实时汇率**折算，不再写死 7.1
- **Extensions: official repository plus an optional custom one** — the repository field is gone; tick "custom repository" to add another source alongside the official one
  **拓展功能：官方仓库 + 可选的自定义仓库**——不再显示仓库地址；勾选「自定义拓展仓库」后，它作为官方之外的额外来源
- **Windows installer lets you choose the install folder**
  **Windows 安装时可以选择安装目录**

### Fixes · 修复
- Logging in to Claude could time out: the SSH connection now sends keep-alives while you sign in in the browser, a dropped connection is reported right away, and the code and Enter are sent separately; also fixed a main-process error after login
  登录 Claude 可能超时：在浏览器里登录期间 SSH 连接会发心跳保持；连接断了会立即提示；授权码和回车分开发送；修复登录后的主进程报错
- Settings opened to a blank page from the sidebar button
  从侧栏按钮打开设置是空白页
- With `"verbose": true` in Claude Code's settings, context details, titles and the post-login check failed to read Claude's result
  Claude Code 设置里开了 `"verbose": true` 时，上下文明细、起标题、登录后的测试读不到结果

## 1.5.25 — 2026-10-14

### Changes · 改动
- **Server sessions by folder**: the server sessions page has a folder picker — pick one of the folders that already have sessions (sorted by count), or browse the server and choose any folder; only sessions in that folder and its subfolders are read, so older projects are no longer cut off by the 500 most recent limit. Also honours `CLAUDE_CONFIG_DIR` if Claude Code keeps its data somewhere else
  **服务器会话按文件夹读取**：「服务器上的会话」页加了文件夹选择——可以从已有会话的文件夹里挑（按会话数排序），也可以浏览服务器选任意文件夹，只读这个文件夹及其子文件夹里的会话，旧项目不会再被「只取最近 500 个」挤掉。Claude Code 数据目录设置了 `CLAUDE_CONFIG_DIR` 的也能读到

## 1.5.24 — 2026-10-14

### Changes · 改动
- **"Just finished" marks**: when a reply finishes, fails or needs you while you're not looking at that conversation (another conversation is open, or the app is in the background), a dot appears in front of it in the sidebar — green done, red error, orange waiting for you — and disappears when you open it; collapsed groups show the dot too, and on macOS the Dock icon shows how many are unseen
  **「刚完成」标记**：回复完成、出错或需要你处理时，如果你没在看那个对话（开着别的对话，或软件在后台），侧栏里它前面亮一个点——绿色完成、红色出错、橙色等你处理——点开就消失；收起的分组也会亮点，macOS 程序坞图标显示还没看的个数
- **Webhook notifications (Settings → Notifications)**: send a message when a reply finishes, fails or needs you (waiting for your choice, or a browser authorization). Feishu group bots get a card with the conversation title, status, server, duration, a short summary and the time (signature verification supported); a generic JSON format works for your own services, Slack, Discord and others. Options: which events, only when the app isn't in front, include a summary, and a test button that explains common Feishu errors. Authorization links are never sent
  **Webhook 通知（设置 → 通知）**：回复完成、出错或需要你处理（等你做选择、需要去浏览器授权）时发消息。飞书群机器人收到的是卡片：会话标题、状态、服务器、耗时、回复摘要和时间（支持签名校验）；也可以选通用 JSON，自建服务、Slack、Discord 等都能用。可选通知哪些事件、只在软件不在前台时发、是否附带摘要，有「发送测试」按钮并会解释飞书常见报错。授权链接不会发出去

## 1.5.23 — 2026-10-14

### Changes · 改动
- **Usage statistics (Settings → Usage)**: counts the tokens used by conversations started in this app — per model and per thinking effort, split into input / output / cache write / cache read — with the equivalent API cost as computed by Claude Code at Anthropic's list prices (and an approximate RMB figure). Today / 7 days / 30 days / all, a daily chart, and a filter per server. It does not read your account, so usage by other people sharing the account is not included. Claude Code reports running totals that can carry over when a conversation is resumed; only the increase of each reply is recorded, so nothing is counted twice
  **用量统计（设置 → 用量统计）**：统计在本软件里发起的对话用了多少 token——按模型、按思考强度，分输入 / 输出 / 缓存写入 / 缓存读取——以及按 Anthropic API 公开价格（Claude Code 自己的算法）折合的金额（附人民币约数）。可看今天 / 近 7 天 / 近 30 天 / 全部，有每天的柱状图，多台服务器可分开看。不读账号数据，同一账号其他人的使用不会算进来。Claude Code 报的是累计值、续接对话时还可能带上以前的，这里每轮只记增量，不会重复计算

## 1.5.22 — 2026-10-14

### Fixes · 修复
- **macOS no longer forgets folder permissions after an update**: quick updates used to replace `app.asar` inside the app, which changes the app's signature, so macOS treated every update as a new app and asked again for Desktop / Documents / Full Disk Access. Updates are now stored in the app's data folder and loaded at startup; the installed app is left untouched (a broken update falls back to the installed version automatically). This takes effect from the update after 1.5.22 — grant access once more after installing 1.5.22
  **macOS 更新后不再丢失文件夹授权**：以前快速更新会替换 .app 里的 `app.asar`，签名随之改变，macOS 把每次更新都当成新程序，桌面 / 文稿 / 完全磁盘访问要重新允许。现在新版本代码放在软件自己的数据目录、启动时加载，安装目录不再改动（新包有问题会自动退回安装包自带的版本）。从 1.5.22 之后的更新开始生效：装上 1.5.22 后再允许一次即可

## 1.5.21 — 2026-10-14

### Changes · 改动
- **Trackpad haptics on the timeline (macOS)**: scrolling, dragging or stepping through the timeline gives a light tick on the Force Touch trackpad for every message it passes, like turning a notched wheel; can be turned off in Settings
  **时间轴触控板震感（macOS）**：在时间轴上滚动、拖动或用键盘翻时，每经过一条消息触控板轻轻「咔」一下，像在拨一个有刻度的滚轮；可在设置里关掉

## 1.5.20 — 2026-10-13

### Changes · 改动
- **Keyboard on the timeline**: click the timeline, then use ↑ / ↓ to step through messages (Home / End for the first / last); Esc leaves it without stopping a running reply
  **时间轴可以用键盘翻**：点一下时间轴后按 ↑ / ↓ 跳到上一条 / 下一条消息（Home / End 到第一条 / 最后一条），按 Esc 退出（不会停止正在进行的回复）

## 1.5.19 — 2026-10-13

### Changes · 改动
- **New model picker, like the Claude desktop app**: a short list of models (from Claude Code's `/model`); the arrow next to a model shows its other versions, read from Anthropic's model list for your account (including older ones and which are being retired); thinking effort is a slider whose stops are exactly the levels the chosen model supports
  **新的模型选择（参考 Claude 桌面版）**：只列几个模型（来自 Claude Code 的 `/model`），点模型右边的箭头展开它的其他版本（来自 Anthropic 的模型列表，按你的账号返回，包括老版本和即将停用的）；思考强度改成拖动条，档位就是所选模型实际支持的那几档
- Background updates are silent: nothing is shown while downloading, only "restart to update" once it is ready. When you check manually, a single line shows the progress
  后台更新不打扰：下载时不显示任何东西，下载好了才提示重启；手动检查更新时只显示一行进度文字

## 1.5.18 — 2026-10-13

### Changes · 改动
- **Models and effort come from Claude Code itself**: the model menu and `/model` now show the list the server's Claude Code reports (the same one as its own `/model`), cached per server, with each model's real version and the effort levels it supports — nothing is hard-coded any more. Older models not in that list can still be typed as a custom model ID. If you never picked a model, replies now use Claude Code's default model (as in the terminal) instead of Sonnet
  **模型和思考强度改为向 Claude Code 获取**：模型菜单和 `/model` 显示服务器上 Claude Code 给出的列表（和它自己的 `/model` 一样），按服务器缓存，包含每个模型实际对应的版本和支持的强度档位，不再写死；列表里没有的老模型仍可填自定义模型 ID。没手动选过模型时，改用 Claude Code 的默认模型（和终端一致），不再固定 Sonnet
- **Automatic updates switch** in Settings (on by default): new versions download in the background and you are asked to restart. Turn it off to only be told about new versions and download with one click
  设置里新增「自动下载更新」开关（默认开）：有新版本时后台下载好再提示重启；关掉后只提示，点「下载」才下载

## 1.5.17 — 2026-10-13

### Features · 功能
- **Thinking effort**: pick Default / Low / Medium / High / Extra high / Max from the model menu (Claude Code's `--effort`); the input box shows it next to the model, e.g. "Opus 5.5 · High". Haiku does not support effort, so it is skipped there
  **思考强度**：模型菜单里可以选「默认 / 低 / 中 / 高 / 超高 / 最高」（对应 Claude Code 的 `--effort`），输入框旁显示成「Opus 5.5 · 高」；Haiku 不支持调强度，选 Haiku 时不传
- **Older models**: besides the latest Opus / Fable / Sonnet / Haiku, pick a specific version (Fable 5, Opus 5, Opus 4.8, 4.7, 4.6, Sonnet 4.6) or type any model ID. `/model` lists the same choices
  **可以选老模型**：除了最新的 Opus / Fable / Sonnet / Haiku，还能指定版本（Fable 5、Opus 5、Opus 4.8、4.7、4.6、Sonnet 4.6），或者自己填模型 ID；`/model` 里也是同样的选项

### Fixes · 修复
- Menus opened from the capabilities panel (the *⋯* menus) were hidden behind it
  「能力」面板里点「⋯」弹出的菜单被面板挡住
- Long menus scroll instead of running off the window; the model menu now names Sonnet 5 and Haiku 4.5 correctly
  很长的菜单放不下时可以滚动，不会超出窗口；模型菜单里 Sonnet 5、Haiku 4.5 的名字改正

## 1.5.16 — 2026-10-13

### Changes · 改动
- **Preview tabs keep their page**: switching between tabs no longer reloads or re-downloads anything. A preview's cached file is deleted when you close its tab, and the whole preview cache is cleared when the app starts and quits
  **预览标签保留页面**：标签之间切换不再重新加载、重新下载；关掉标签时删掉它的缓存文件，软件启动和退出时清空整个预览缓存
- The tab bar shows whenever the side panel is open, even with a single tab; tabs no longer shrink to one character
  右侧面板打开就显示标签栏（哪怕只有一个），标签不会再被挤成一个字
- **Capabilities panel has real actions**: each MCP server, Skill and Claude plugin has a *⋯* menu — reconnect or delete an MCP server, delete a Skill, enable / disable / update / uninstall a plugin. Plugins are listed there too, and long Skill descriptions are clamped to two lines
  **「能力」面板可以直接操作**：每个 MCP、Skill、Claude 插件都有「⋯」菜单——MCP 重新连接、删除，Skill 删除，插件启用 / 停用 / 更新 / 卸载；面板里也列出插件，过长的 Skill 说明只显示两行

### Fixes · 修复
- Plugin buttons kept their size while working (they used to collapse into a sliver) and show "Updating…"
  插件操作按钮执行中不再缩成一条，显示「更新中…」
- The drop line when dragging conversations is straight instead of following the rounded corners
  拖动对话时的插入线改成直线，不再跟着圆角弯曲

## 1.5.15 — 2026-10-13

### Features · 功能
- **Updates download inside the app on both Windows and macOS**: when only the app's own code changed (most releases), the update is a few MB (`app-<platform>.asar.gz`) instead of the full installer, verified with SHA-512 and applied on restart. When Electron itself changes, Windows uses its differential updater and macOS downloads the DMG and swaps the app after quitting — no more trips to the download page. (Takes effect from this version on; updating *to* 1.5.15 still uses the old way)
  **Windows 和 macOS 都在软件里自动下载更新**：只改了软件代码时（大多数版本）只下载几 MB 的更新包（`app-平台.asar.gz`），SHA-512 校验后重启生效；Electron 本体变了才下载完整包：Windows 用差量更新，macOS 自动下载 DMG、退出后替换程序，不再跳下载页（从这个版本开始生效，升级到 1.5.15 这一次仍按旧方式）
- **Right-side panel with tabs**: the file panel and previews share one panel; with more than one open, a browser-style tab bar appears (close, close others / left / right, close all, middle-click). Closing everything removes the panel and restores the window width; the panel can be resized and the file panel is wider by default
  **右侧面板改成标签页**：文件面板和预览共用一个面板，开了多个时顶部出现浏览器式标签栏（关闭、关闭其他 / 左侧 / 右侧、全部关闭、中键关闭）；全部关掉后面板收起、窗口宽度恢复；面板宽度可拖动，文件面板默认加宽
- **`/plugin` manages Claude Code plugins**: install from marketplaces (with search), update, enable / disable and uninstall, like `/plugin` in Claude Code. The app's own preview plugins are now called **Extensions (拓展功能)** and live only in Settings
  **`/plugin` 管理 Claude Code 插件**：从插件市场搜索安装、更新、启用 / 停用、卸载，和 Claude Code 里的 `/plugin` 一样；软件自己的预览插件改名「拓展功能」，只在设置里打开
- **Drag conversations to reorder them** in the sidebar (onto another conversation: before or after it; onto a group title: to the top of that group). Reordered conversations stay where you put them
  **侧栏对话可以拖动排序**（拖到另一个对话上方 / 下方，或拖到分组标题上放到最前），排过的位置固定不变
- The timeline tooltip shows when each message was sent (yours) or finished (Claude's)
  时间轴悬停提示显示时间：你的消息是发送时间，Claude 的是完成时间
- File names written on their own (e.g. a list under "the file is in /home/x/dir:") become clickable links, using the directory mentioned just before them or the conversation folder
  单独写出来的文件名（比如「文件在 /home/x/目录：」下面列出的文件）也能点击下载、预览，路径用前面提到的目录或对话的文件夹
- SSH traffic is compressed, so text files (Markdown, CSV, logs, code) download several times faster on slow links
  SSH 传输开启压缩，慢线路上 Markdown、CSV、日志、代码等文本文件下载快很多

### Fixes · 修复
- Markdown: a single `~` is no longer strikethrough (dates and ranges like `7/1~8/13`, `6~9 月` were being swallowed), and `**bold**` works next to Chinese punctuation (`**结论。**后面的话`). The same fix ships in the *Code & text* extension 1.1.3
  Markdown：单个 `~` 不再当删除线（`7/1~8/13`、`6~9 月` 之类不会被吞掉），中文标点旁的 `**加粗**` 能正常显示；「代码与文本预览」拓展 1.1.3 同步修复
- The logo and name next to the window buttons are gone, as in similar apps; the logo stays on the new-conversation screen
  去掉窗口按钮旁的 logo 和名字（和同类软件一致），logo 保留在新对话的欢迎页

### Docs · 文档
- README tells how the project started
  README 补充项目缘起

## 1.5.14 — 2026-10-13

### Features · 功能
- **Switch servers while a reply is running**: each server keeps its own connection, so a conversation that is replying carries on in the background on its server after you switch away (the connection closes once it is done). Queued messages, *Stop* and background tasks go to the conversation's own server, usage is recorded for the right server, and the server menu shows how many conversations are still replying there
  **回复中也能切换服务器**：每台服务器各用各的连接，切走后正在回复的对话在它那台服务器上继续跑完（跑完再断开连接）；排队的消息、停止、后台任务都发往对话所在的服务器，额度也记在对应服务器名下，服务器菜单会显示那边还有几个对话在回复

### Fixes · 修复
- **Windows shows the app's own icon**: the installed program (and so the desktop shortcut and taskbar) used Electron's default icon, because the Windows build is made on a Mac where electron-builder cannot edit the .exe. The icon is now written into the .exe with a pure-JavaScript resource editor, and the installer uses the same icon as macOS
  **Windows 显示正确的图标**：之前装好的程序（以及桌面快捷方式、任务栏）显示的是 Electron 默认图标，因为 Windows 包是在 Mac 上打的，打包工具改不了 .exe 里的图标。现在打包时用纯 JS 的资源编辑把图标写进 .exe，安装包也和 macOS 用同一个图标
- **macOS: no more "damaged" for people who download the app**: the app is now ad-hoc signed when built. Without it, files changed during packaging broke the original signature, so a downloaded copy was reported as damaged with no way to open it. Now macOS says the developer cannot be verified, and it can be opened from *System Settings → Privacy & Security → Open Anyway* (a paid Apple Developer ID would remove the prompt entirely)
  **macOS 别人下载后不再提示「已损坏」**：打包时给程序做本机临时签名。以前打包改过的文件让原签名失效，别人下载后会被提示「已损坏」且无法打开；现在提示「无法验证开发者」，在「系统设置 → 隐私与安全性」里点「仍要打开」即可（要完全不弹提示需要付费的 Apple 开发者证书）

## 1.5.13 — 2026-10-13

### Fixes · 修复
- The background-tasks button no longer shows a bare total (which read like "11 still running"): it says how many are running, or that they have all finished; the total is in the tooltip
  后台任务按钮不再只显示总数（容易看成「还有 11 个在跑」）：有在跑的显示「后台 N 个运行中」，没有就显示「后台任务都已结束」，总数放在鼠标提示里

## 1.5.12 — 2026-10-13

### Fixes · 修复
- **Imported server sessions did not show up**: sessions imported from *Server sessions* were not tagged with their server, so the sidebar (which shows one server at a time) hid them while the import list said *Open*. Imports now belong to the current server, and sessions imported by earlier versions are matched back to their server automatically the next time you connect to it
  **导入的服务器会话不显示**：从「服务器上的会话」导入的对话没有记录属于哪台服务器，侧栏按服务器显示时把它们藏了起来，导入列表却显示「打开」。现在导入时记在当前服务器下；之前版本导入的对话，下次连上对应的服务器时会自动找回
- Conversations created with *Branch from here* also keep their server now (older ones are repaired on startup)
  「从这里分支」出来的对话也记录所属服务器（以前分支的对话启动时自动修复）

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
