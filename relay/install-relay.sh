#!/bin/sh
# Claude 远程助手 · 中转枢纽 crrelay 一键安装 / 更新（Linux + systemd）
#
#   有域名（推荐，自动申请 HTTPS 证书，需要 80 和 443 端口）：
#     curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --domain relay.example.com
#   没有域名（用 IP + 端口，手机不能「添加到主屏幕」，适合先试试）：
#     curl -fsSL https://github.com/TomEageer/claude-remote/releases/latest/download/install-relay.sh | sudo sh -s -- --port 8787
#   已经有 Nginx / Caddy 做 HTTPS：
#     ... | sudo sh -s -- --port 8787 --local      （只监听 127.0.0.1，由它们转发）
#
#   再运行一次（不带参数）就是更新到最新版，沿用上次的设置。默认每天自动检查更新一次（--no-auto-update 关掉）。
#   卸载：sudo sh install-relay.sh --uninstall
set -e

REPO="TomEageer/claude-remote"
BASE="${CRRELAY_DOWNLOAD:-https://github.com/$REPO/releases/latest/download}"
BIN=/usr/local/bin/crrelay
CONF=/etc/crrelay.conf
DATA=/var/lib/crrelay
UNIT=/etc/systemd/system/crrelay.service

say() { printf '%s\n' "$*"; }
die() { printf '安装失败：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "需要 root 权限，请在命令前加 sudo"
[ "$(uname -s)" = Linux ] || die "这个脚本只支持 Linux 服务器（Mac / Windows 请到 GitHub Release 页面直接下载 crrelay 运行）"
command -v systemctl >/dev/null 2>&1 || die "没有 systemd，请到 GitHub Release 页面下载 crrelay 手动运行"

DOMAIN="" PORT="" LOCAL="" AUTO="1" UNINSTALL="" QUIET=""
[ -f "$CONF" ] && . "$CONF"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; PORT=""; LOCAL=""; shift 2 ;;
    --port) PORT="$2"; DOMAIN=""; shift 2 ;;
    --local) LOCAL="1"; shift ;;
    --no-auto-update) AUTO=""; shift ;;
    --auto-update) AUTO="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --quiet) QUIET="1"; shift ;;
    *) die "不认识的参数 $1" ;;
  esac
done

if [ -n "$UNINSTALL" ]; then
  systemctl disable --now crrelay crrelay-update.timer 2>/dev/null || true
  rm -f "$UNIT" /etc/systemd/system/crrelay-update.service /etc/systemd/system/crrelay-update.timer "$BIN" /usr/local/bin/crrelay-update "$CONF"
  systemctl daemon-reload
  say "已卸载（访问令牌和证书还留在 $DATA，不需要的话可以手动删掉）"
  exit 0
fi

[ -z "$DOMAIN" ] && [ -z "$PORT" ] && PORT=8787

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的处理器架构 $(uname -m)" ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  else wget -q -O "$2" "$1"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch "$BASE/crrelay-linux-$ARCH.gz" "$TMP/crrelay.gz" || die "下载失败（服务器访问不了 GitHub 的话，可以设置 CRRELAY_DOWNLOAD 指向镜像地址）"
gunzip -f "$TMP/crrelay.gz"
chmod 755 "$TMP/crrelay"
NEW=$("$TMP/crrelay" --version)
OLD=""
[ -x "$BIN" ] && OLD=$("$BIN" --version 2>/dev/null || true)
if [ -n "$QUIET" ] && [ "$NEW" = "$OLD" ]; then exit 0; fi
install -m 755 "$TMP/crrelay" "$BIN"

# 记下设置，下次更新沿用；脚本本身也留一份给自动更新用
cat > "$CONF" <<EOF2
DOMAIN="$DOMAIN"
PORT="$PORT"
LOCAL="$LOCAL"
AUTO="$AUTO"
EOF2
fetch "$BASE/install-relay.sh" /usr/local/bin/crrelay-update 2>/dev/null && chmod 755 /usr/local/bin/crrelay-update || true

if [ -n "$DOMAIN" ]; then
  ARGS="--domain $DOMAIN"
elif [ -n "$LOCAL" ]; then
  ARGS="--listen 127.0.0.1:$PORT"
else
  ARGS="--listen :$PORT"
fi

mkdir -p "$DATA" && chmod 700 "$DATA"
cat > "$UNIT" <<EOF2
[Unit]
Description=Claude Remote relay (crrelay)
After=network-online.target
Wants=network-online.target

[Service]
Environment=CRRELAY_DATA=$DATA
ExecStart=$BIN $ARGS
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF2

if [ -n "$AUTO" ]; then
  cat > /etc/systemd/system/crrelay-update.service <<EOF2
[Unit]
Description=Update Claude Remote relay

[Service]
Type=oneshot
ExecStart=/bin/sh /usr/local/bin/crrelay-update --quiet
EOF2
  cat > /etc/systemd/system/crrelay-update.timer <<EOF2
[Unit]
Description=Daily update check for Claude Remote relay

[Timer]
OnCalendar=daily
RandomizedDelaySec=3h
Persistent=true

[Install]
WantedBy=timers.target
EOF2
else
  systemctl disable --now crrelay-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/crrelay-update.service /etc/systemd/system/crrelay-update.timer
fi

systemctl daemon-reload
systemctl enable crrelay >/dev/null 2>&1
systemctl restart crrelay
[ -n "$AUTO" ] && systemctl enable --now crrelay-update.timer >/dev/null 2>&1
[ -n "$QUIET" ] && exit 0

i=0
while [ ! -s "$DATA/token" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
TOKEN=$(cat "$DATA/token" 2>/dev/null || true)
systemctl is-active --quiet crrelay || { journalctl -u crrelay -n 20 --no-pager; die "服务没有启动起来，上面是日志"; }

if [ -n "$DOMAIN" ]; then
  URL="https://$DOMAIN"
elif [ -n "$LOCAL" ]; then
  URL="https://你的域名（Nginx / Caddy 转发到 127.0.0.1:$PORT）"
else
  IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  URL="http://$IP:$PORT"
fi

say ""
if [ -n "$OLD" ] && [ "$OLD" != "$NEW" ]; then say "已从 $OLD 更新到 $NEW"; else say "中转枢纽 $NEW 已安装并在运行"; fi
say ""
say "  在电脑上打开 Claude 远程助手 → 设置 →「远程控制」，填："
say "    中转地址：$URL"
say "    访问令牌：$TOKEN"
say ""
[ -n "$DOMAIN" ] && say "  第一次访问时会自动申请 HTTPS 证书，需要域名已经解析到这台服务器，并且 80、443 端口对外开放。"
[ -z "$DOMAIN" ] && [ -z "$LOCAL" ] && say "  记得在云服务器的安全组 / 防火墙里放行 TCP $PORT 端口。"
say "  查看日志：journalctl -u crrelay -f      更新：再运行一次这条安装命令"
