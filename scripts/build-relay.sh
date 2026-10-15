#!/bin/sh
# 编译中转枢纽 crrelay（Go，纯静态、无依赖，手机网页打包在程序里），版本号跟软件一致
# 输出到 dist/：crrelay-<系统>-<架构>.gz（Windows 是 .zip）和一键安装脚本 install-relay.sh，发版时一起传到 GitHub Release
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
ver=$(node -p "require('$root/package.json').version")
cd "$root/relay"
mkdir -p web && cp -R ../mobile/. web/
out="$root/dist"
mkdir -p "$out" .build
build() {
  name="crrelay-$1-$2"
  bin=".build/crrelay"
  [ "$1" = windows ] && bin=".build/crrelay.exe"
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "-s -w -X main.version=$ver" -o "$bin" .
  if [ "$1" = windows ]; then
    (cd .build && zip -q -FS "$name.zip" crrelay.exe) && mv -f ".build/$name.zip" "$out/$name.zip"
    echo "  • $name.zip $(du -h "$out/$name.zip" | cut -f1)"
  else
    gzip -9 -c "$bin" > "$out/$name.gz"
    echo "  • $name.gz $(du -h "$out/$name.gz" | cut -f1)"
  fi
}
build linux amd64
build linux arm64
build darwin arm64
build darwin amd64
build windows amd64
cp install-relay.sh "$out/install-relay.sh"
echo "  • install-relay.sh"
