# 手机远程控制 · Remote control from your phone

[中文](#中文) · [English](#english)

---

## 中文

在手机上查看和操控电脑上 Claude 远程助手里的对话：看实时回复、发消息、开新对话、停止回复、回答 Claude 的提问、批准计划。效果类似 Claude Code 的 Remote Control，但**走你自己的服务器**，不经过任何第三方。

```
 手机浏览器 ──┐                         ┌── 电脑上的 Claude 远程助手
（网页 App）  └──►  你的中转服务器  ◄────┘   （开着就保持连接）
                    crrelay
                只转发加密后的内容
```

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="images/phone-chat-dark.png"><img src="images/phone-chat.png" width="260" alt="手机上的对话页"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/phone-list-dark.png"><img src="images/phone-list.png" width="260" alt="手机上的对话列表"></picture></p>

- **端到端加密**：配对二维码 5 分钟内有效、只能用一次，里面没有长期密钥；手机和电脑各用自己的密钥对算出共同的密钥（X25519），每次连接再换一把只用这一次的会话密钥（向前保密），消息带序号防重放（XSalsa20-Poly1305）。中转服务器只看到密文，看不到也改不了内容。协议见 [`mobile/e2e.js`](../mobile/e2e.js)
- **手机页面从哪里来**：默认「安全模式」，页面从 GitHub Pages 加载（由仓库的 `mobile/` 原样发布，见 [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)），中转服务器碰不到页面代码；中转是你自己的服务器时，可以改用「快速模式」由中转提供页面。安卓 App 的页面打包在 App 里
- **手机不用装 App**：扫码就能用；iPhone 和安卓都可以「添加到主屏幕」，像 App 一样全屏打开
- **一个程序、零依赖**：crrelay 是单个 Go 程序（约 8 MB），不需要数据库、Docker、Node
- **跟着软件一起更新**：每次发布新版本都会同时发布对应版本的中转程序；一键安装的服务器默认每天自动更新

### 需要准备

- 一台**电脑和手机都能访问到**的服务器（有公网 IP 的云服务器就行，配置最低的那种完全够用）
- 最好有一个**域名**解析到这台服务器：可以自动申请 HTTPS 证书，手机才能「添加到主屏幕」。没有域名也能用 IP + 端口，只是手机上只能在浏览器里打开
- 电脑上的 Claude 远程助手 1.6.0 或更新的版本

### 第一步：在服务器上安装中转程序

用 root 或 sudo 在服务器上运行下面任意一条（Linux，x86_64 或 ARM 都可以）：

**有域名（推荐）**——先把域名（比如 `relay.example.com`）解析到服务器，并放行 80、443 端口：

```sh
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --domain relay.example.com
```

**没有域名**——直接用 IP 和端口（下面用 8787，记得在云服务器的安全组 / 防火墙里放行这个端口）：

```sh
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --port 8787
```

**已经有 Nginx / Caddy**——让中转程序只监听本机，由它们负责 HTTPS（配置见下文）：

```sh
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --port 8787 --local
```

装完会打印两样东西，下一步要用：

```
  在电脑上打开 Claude 远程助手 → 设置 →「远程控制」，填：
    中转地址：https://relay.example.com
    访问令牌：3f9c…（一长串字母数字）
```

忘了令牌可以在服务器上运行 `sudo crrelay token list` 查看，要给别人用、限制流量见下文「给别人用」。

安装脚本做了这些事：下载对应版本的 `crrelay` 到 `/usr/local/bin`，注册成 systemd 服务 `crrelay`（开机自启、挂了自动重启），访问令牌和证书放在 `/var/lib/crrelay`，并加一个每天检查一次更新的定时任务。

| 想做的事 | 命令 |
|---|---|
| 更新到最新版 | 再运行一次安装命令（不带参数也行，会沿用上次的设置） |
| 关掉自动更新 | 安装命令后面加 `--no-auto-update` |
| 看日志 | `journalctl -u crrelay -f` |
| 重启 | `sudo systemctl restart crrelay` |
| 卸载 | `curl -fsSL …/install-relay.sh \| sudo sh -s -- --uninstall` |

> 服务器访问不了 GitHub？可以先在别的地方下载 `crrelay-linux-amd64.gz` 和 `install-relay.sh` 放到自己的镜像，运行前设置 `CRRELAY_DOWNLOAD=https://你的镜像地址`。

### 第二步：电脑连接中转服务器

打开 Claude 远程助手 → **设置** → **远程控制**：

1. 勾选「开启远程控制」
2. 填上一步打印的**中转地址**和**访问令牌**
3. 点「保存并连接」，看到「已连接中转服务器」就好了

电脑上的软件开着时会一直保持连接，断了会自动重连。

### 第三步：添加手机

1. 在「远程控制」页点「添加手机」，起个名字，电脑上会弹出二维码（5 分钟内有效、只能用一次）
2. 手机配对，几种方式任选：
   - 用手机**相机**扫二维码，会在浏览器里打开手机页面
   - 已经打开着手机页面（或者安卓 App）：点「扫描二维码」，在页面里直接扫
   - 扫不了码：在电脑上点「复制链接」发到自己手机上打开
3. 手机上会显示一个 4 位数字，电脑上同时弹出核对窗口：数字一样就点「一样，配对」。不一样、或者不是你在扫，点「不是我」（说明二维码被别人抢先用了，它已经作废）
4. （推荐）添加到主屏幕：iPhone 在 Safari 里点分享按钮 →「添加到主屏幕」；安卓在 Chrome 菜单里点「添加到主屏幕」/「安装应用」
5. 安卓也可以装 App：在电脑上「设置 → 远程控制」点「下载安卓 App」，或者到 [Release 页面](https://github.com/TomEageer/claude-remote/releases/latest) 下载 `ClaudeRemote-Android.apk` 发到手机上安装。打开后点「扫描二维码」扫电脑上的码就行，中转地址在二维码里

二维码用过或者过了 5 分钟就作废，截图流出去也没用。换了浏览器或清了浏览器数据，在电脑上重新「添加手机」扫一次。手机丢了，在电脑上点「撤销」，它就再也连不上了。

### Apple Watch

手表只做三件事：处理 Claude 在等你的那一下（允许 / 批准 / 回答）、看哪些对话在跑、一句话发过去（快捷短语或听写）。完整对话留在手机和电脑上。

1. 电脑「设置 → 远程控制 → 添加 Apple Watch」，会显示一个 6 位配对码（5 分钟内有效、只能用一次）
2. 手表上打开 Claude 远程助手：第一次先填中转地址（和电脑上一样），再输入 6 位码
3. 手表显示 4 位数字，电脑上弹出同样的数字，一样就在电脑上点「一样，配对」

手表和手机走同一套加密：配对后它在电脑眼里就是又一台手机。配对码经中转的「寄存柜」交换（中转只存密文、取一次即删，需要中转程序 1.10.0 以上）。手表 App 的源码在 [`watch/`](../watch/)，目前需要自己用 Xcode 装到手表上。「允许 / 批准」要按住 1 秒圆环填满才算，防止手腕误触；「拒绝 / 再想想」轻点即可。快捷短语在电脑的远程控制设置里改。

**一台设备一次「添加手机」**：iPhone、iPad、安卓手机每台都要在电脑上单独添加、各扫各的码。两台设备用同一个配对的话，中转只留一个在线，会互相挤掉（手机页面会提示）。

**旧的配对方式**：1.9.0 以前配对的手机，二维码里带着长期密钥，照常能用，但电脑上会标「旧配对方式」并提醒升级：点「升级配对」扫一下新二维码，旧配对自动作废。

### 手机上能做什么

界面照着 Claude 手机版设计：左上角打开对话列表，右上角开新对话，底部是输入卡片。

- **对话列表**：和电脑上一样的置顶、分组，可以搜索；长按一个对话可以重命名、置顶、移到分组、删除；顶部的文件夹按钮新建分组，分组右边的「⋯」改名或删除，点分组标题收起 / 展开；底部显示电脑在线状态和额度
- **实时回复**：回复中的对话实时更新，连续的工具步骤收成一行，点开看每一步和结果；代码块可以一键复制
- **发消息**：对话空闲时直接发出；Claude 正在回复时会像在电脑上一样合并进当前这一轮；输入框为空时发送按钮变成**停止**；输入 `/` 列出命令和 Skill
- **发图片和文件**：输入框左边的 **+**，可以拍照、选照片或文件（大照片会先压缩），经电脑传到服务器交给 Claude
- **模型和思考强度**：点输入框右边的模型名切换（思考强度是滑动条），和电脑上的选择同步
- **手势**：从左往右滑打开对话列表、往左滑收起，弹层往下拖关闭；左上角对话列表顶部可以切换服务器，齿轮进入设置（外观、文字大小、配对管理）
- **计划模式**：**+** 里打开，Claude 先写方案，批准后才动手
- **看生成的文件**：回复下面的「本轮生成的文件」和回复里的文件路径都能点开预览（文档、图片、表格、PDF、音视频、网页）；Office 文件用右上角的分享按钮交给系统打开
- **新对话**：可以选在哪台服务器、哪个文件夹里运行
- **等你做选择时**：列表里那个对话会闪，菜单按钮上有提醒点，顶部有一条可以点的提示；点选项回答 Claude 的提问，批准或打回计划

### 给别人用：每人一个令牌、流量管控、管理页面

在服务器上运行 `sudo crrelay admin`，会打印一个带管理密钥的链接（把前面换成你的中转地址），在浏览器打开就是管理页面。管理密钥和访问令牌是分开的；`crrelay admin reset` 换新密钥，旧链接立即失效。

管理页面能做的事：

- **新建令牌**发给某个人（他填进电脑的「设置 → 远程控制 → 访问令牌」），编辑、停用、删除、换新令牌、再看一次令牌
- **全局规则**：每人每天全速额度（默认 20 MB）、用完后的限速（默认 128 KB/s）、小额放行（默认 2 MB）、全员每月总量上限（默认 50 GB）和超出后的限速（默认 32 KB/s）
- **每个人单独设置**：跟随全局、单独的额度和限速，或者不限（不限的人不算进全员上限，适合你自己）
- **给某台电脑临时加今天的额度**
- **看流量**：本月、今天、最近 30 天每天按人分色、每个人和每台电脑的用量、今天的额度还剩多少、此刻多快、谁正在被限速，以及手机网页本身用了多少

规则只管传文件、预览文件这类大块数据：聊天和看回复永远不限、不扣额度。超出只会变慢，不会断开。额度按电脑算，每天北京时间 0 点重置。流量按「手机↔服务器」和「服务器↔电脑」两段合计，和服务器实际跑掉的流量一致；看不到任何对话内容。

命令行也能管：`crrelay token list`（规则和本月用量）、`add 名字 [不限]`、`show 名字`、`rename 旧 新`、`remove 名字`。原来只有一个令牌的服务器，升级后那个令牌叫「默认」、不限，用法不变。

### 用 Nginx / Caddy 做 HTTPS

中转程序用 `--port 8787 --local` 安装后只监听 `127.0.0.1:8787`。需要把 `/ws` 的 WebSocket 一起转发过去：

**Caddy**

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**Nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

### 不用 Linux / 不想用安装脚本

到 [Release 页面](https://github.com/TomEageer/claude-remote/releases/latest) 下载对应系统的中转程序，解压后直接运行：

| 文件 | 系统 |
|---|---|
| `crrelay-linux-amd64.gz` / `crrelay-linux-arm64.gz` | Linux |
| `crrelay-darwin-arm64.gz` / `crrelay-darwin-amd64.gz` | macOS |
| `crrelay-windows-amd64.zip` | Windows |

```sh
gunzip crrelay-linux-amd64.gz && chmod +x crrelay-linux-amd64
./crrelay-linux-amd64 --domain relay.example.com     # 自动 HTTPS（要 80、443 端口）
./crrelay-linux-amd64 --listen :8787                 # 只开 HTTP
./crrelay-linux-amd64 --cert fullchain.pem --key privkey.pem --listen :443   # 用自己的证书
```

其他参数：`--data 目录`（令牌和证书存放位置，默认 root 用 `/var/lib/crrelay`、普通用户用 `~/.crrelay`），`--token 令牌`（自己指定令牌，也可以用环境变量 `CRRELAY_TOKEN`），`--version`。

### 常见问题

**电脑上显示「访问令牌不对」**：令牌要和服务器上 `crrelay token list` 列出的某一个一致（`crrelay token show 名字` 看完整令牌），注意不要多复制空格。

**电脑上显示「连不上中转服务器」**：先在电脑浏览器里打开 `中转地址/healthz`，应该显示 `ok 版本号`。打不开就是端口没放行、域名没解析好，或者证书还没申请下来（用 `--domain` 时第一次访问要等几秒）。

**手机上显示「电脑不在线」**：电脑上的软件要开着，并且「远程控制」页显示已连接。电脑睡眠时也会断开。

**手机上显示「这台手机已被电脑撤销」**：在电脑上重新添加这台手机再扫码。

**安全吗？** 中转服务器只负责转发，看不到也改不了内容：长期密钥由手机和电脑各自的密钥对算出来，从不经过网络、也不在二维码里；每次连接再换一把会话密钥，断开就扔。用安全模式时页面代码来自 GitHub 上的公开源码，中转服务器换不了页面。加密管不到的是两头的设备本身（中了木马、被人解锁），以及「什么时候在通信、每条多大」这类外壳信息。电脑上「设置 → 远程控制 → 加密原理」有完整说明和源码链接。中转服务器的访问令牌只用来防止别人拿你的服务器给他们的电脑当中转。用 IP + HTTP 方式时，内容依然是加密的，但建议正式使用时配上域名和 HTTPS。

---

## English

Control the conversations in Claude Remote on your computer from your phone: watch replies stream in, send messages, start new chats, stop a reply, answer Claude's questions and approve plans. Similar to Claude Code's Remote Control, but it goes through **your own server** and no third party.

- **End-to-end encrypted** — each phone gets its own key when it scans the pairing QR code (tweetnacl secretbox / XSalsa20-Poly1305); the relay only ever sees ciphertext
- **No app to install** — the relay serves the phone web app; add it to the home screen on iPhone or Android
- **One static binary** — `crrelay` is a single Go program (~8 MB), no database, Docker or Node
- **Released with the app** — every release ships a matching relay; servers installed with the script update themselves daily

### 1. Install the relay on a server

On any Linux server both your computer and phone can reach (x86_64 or ARM):

```sh
# with a domain pointed at the server (automatic HTTPS; ports 80 and 443 open)
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --domain relay.example.com
# without a domain (plain HTTP on a port; open it in your firewall)
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --port 8787
# behind your own Nginx / Caddy (listens on 127.0.0.1 only)
curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --port 8787 --local
```

It prints the **relay URL** and an **access token** (also in `/var/lib/crrelay/token`). Run the command again to update; add `--no-auto-update` to disable the daily update check, or `--uninstall` to remove it. Logs: `journalctl -u crrelay -f`. Binaries for Linux, macOS and Windows are also on the [release page](https://github.com/TomEageer/claude-remote/releases/latest) (`crrelay --domain …`, `--listen :8787`, or `--cert/--key`).

### 2. Connect the desktop app

**Settings → Remote control**: tick *Enable*, enter the relay URL and token, click *Save and connect*.

### 3. Add your phone

Click *Add phone*, scan the QR code with the phone camera, then *Add to Home Screen*. The QR code contains that phone's key — don't share it. Lost a phone? Click *Revoke*.

For Nginx / Caddy reverse-proxy examples see the Chinese section above (the configs are the same); remember to pass WebSocket upgrade headers for `/ws`.
