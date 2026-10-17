#!/bin/bash
# 打正式版，产物都在 dist/：Mac（arm64 + x64 两个 dmg）、Windows（只打 x64）、快速更新包、VPN 组件、中转服务、安卓 App。
# Mac 和 Windows 必须分两条命令：--arm64 会同时作用到 Windows，安装包里多塞一整套 ARM 程序（体积翻倍）。
# 快速更新包（app-update.json 等）必须在两边都打完后生成，否则会把上一个版本的旧文件传上去。
set -e
cd "$(dirname "$0")/.."
sh scripts/build-vpn.sh
node scripts/check-main.js
node scripts/check-renderer.js
npx electron-builder --mac dmg --arm64 --x64
npx electron-builder --win nsis --x64
node scripts/make-update.js
bash scripts/build-relay.sh
bash scripts/build-android.sh
VER=$(node -p "require('./package.json').version")
node -e "const v=require('./dist/app-update.json').version; if (v !== '$VER') { console.error('快速更新包版本 ' + v + ' 和 $VER 不一致'); process.exit(1) }"
ls -la dist/*.dmg dist/*.exe | awk '{printf "%.1f MB  %s\n", $5/1048576, $9}'
