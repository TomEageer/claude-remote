#!/bin/bash
# 打本地测试版：版本号自动加「-test.月日-时分」（比如 1.7.4-test.1017-0145），装到 dist-test/，不改 package.json、不发布。
# 软件里左下角会标「测试版」；同一版本的正式版发布后，测试版会正常提示更新。
# 用法：bash scripts/dist-test.sh [mac|win|android|all]（默认 mac）
set -e
cd "$(dirname "$0")/.."
BASE=$(node -p "require('./package.json').version")
# 测试的是下一个版本：在当前正式版的最后一位上加 1
NEXT=$(node -p "const [a,b,c]='$BASE'.split('.').map(Number); [a,b,c+1].join('.')")
VER="$NEXT-test.$(date +%m%d-%H%M)"
WHAT="${1:-mac}"
echo "测试版版本号：$VER"
ARGS=(-c.extraMetadata.version="$VER" -c.directories.output=dist-test)
case "$WHAT" in
  mac) npx electron-builder --mac dmg --arm64 --x64 "${ARGS[@]}" ;;
  win) npx electron-builder --win nsis --x64 "${ARGS[@]}" ;;
  android) ;;
  all) npx electron-builder --mac dmg --arm64 --x64 "${ARGS[@]}"; npx electron-builder --win nsis --x64 "${ARGS[@]}" ;;
esac
if [ "$WHAT" = android ] || [ "$WHAT" = all ]; then
  TEST_VERSION="$VER" OUTDIR=dist-test bash scripts/build-android.sh
fi
ls -la dist-test/*.dmg dist-test/*.exe dist-test/*.apk 2>/dev/null | awk '{print $9}'
