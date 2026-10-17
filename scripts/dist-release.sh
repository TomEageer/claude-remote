#!/bin/bash
# 打正式版：Mac（arm64 + x64 两个 dmg）和 Windows（只打 x64）分开打。
# 别合成一条命令：--arm64 会同时作用到 Windows，安装包里多塞一整套 ARM 程序（体积翻倍）。
set -e
cd "$(dirname "$0")/.."
npx electron-builder --mac dmg --arm64 --x64
npx electron-builder --win nsis --x64
ls -la dist/*.dmg dist/*.exe | awk '{printf "%.1f MB  %s\n", $5/1048576, $9}'
