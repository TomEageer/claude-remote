#!/bin/sh
# 编译公司 VPN 小助手 crvpn（Go，纯静态、无依赖）：Mac arm64 / x64、Windows x64
# 输出到 vpn/dist/<mac|win>-<arch>/，打包时由 electron-builder 按平台放进 resources/bin
set -e
cd "$(dirname "$0")/../vpn"
build() {
  out="dist/$1/$3"
  mkdir -p "dist/$1"
  CGO_ENABLED=0 GOOS=$2 GOARCH=$4 go build -trimpath -ldflags "-s -w" -o "$out" .
  echo "  • $out $(du -h "$out" | cut -f1)"
}
build mac-arm64 darwin crvpn arm64
build mac-x64 darwin crvpn amd64
build win-x64 windows crvpn.exe amd64
