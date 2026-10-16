#!/bin/bash
# 打安卓 App：dist/ClaudeRemote-Android.apk
# 不用 Gradle，直接用 Android SDK 自带的工具（aapt2 / javac / d8 / zipalign / apksigner）。
# 签名密钥放在仓库外面（~/.config/claude-remote/），第一次运行自动生成；以后升级必须用同一把，别删。
set -e
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
JAR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
[ -f "$JAR" ] || { echo "找不到 Android SDK（设置 ANDROID_HOME）"; exit 1; }
VER="${TEST_VERSION:-$(node -p "require('./package.json').version")}"
CODE=$(node -p "const [a,b,c]='$VER'.split('-')[0].split('.').map(Number); a*10000+b*100+c")

OUT=build/android
DIST="${OUTDIR:-dist}"
mkdir -p "$OUT" "$DIST"
find "$OUT" -mindepth 1 -delete

# 版本号跟着软件走
sed -e "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$CODE\"/" -e "s/android:versionName=\"[^\"]*\"/android:versionName=\"$VER\"/" android/AndroidManifest.xml > "$OUT/AndroidManifest.xml"

# 1. 资源
"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
mkdir -p "$OUT/gen"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest "$OUT/AndroidManifest.xml" -A android/assets --java "$OUT/gen" "$OUT/res.zip" --auto-add-overlay

# 2. 代码
mkdir -p "$OUT/classes"
javac -nowarn -source 1.8 -target 1.8 -bootclasspath "$JAR" -classpath "$JAR" -d "$OUT/classes" $(find android/src "$OUT/gen" -name '*.java') 2>&1 | grep -v "warning:\|^Note:\|^1 warning\|^[0-9]* warnings" || true
[ -n "$(find "$OUT/classes" -name 'MainActivity.class')" ] || { echo "编译失败"; exit 1; }
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class')

# 3. 打包、对齐、签名
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KEYDIR="$HOME/.config/claude-remote"
KS="$KEYDIR/android-release.jks"
PASSF="$KEYDIR/android-keystore.pass"
if [ ! -f "$KS" ]; then
  mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$PASSF"
  chmod 600 "$PASSF"
  keytool -genkeypair -keystore "$KS" -storepass "$(cat "$PASSF")" -keypass "$(cat "$PASSF")" -alias clauderemote \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Claude Remote" >/dev/null 2>&1
  echo "已生成签名密钥：$KS（以后升级要用同一把，别删）"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASSF" --ks-key-alias clauderemote --out "$DIST/ClaudeRemote-Android.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$DIST/ClaudeRemote-Android.apk"
ls -la "$DIST/ClaudeRemote-Android.apk" | awk '{print "打好了：'"$DIST"'/ClaudeRemote-Android.apk（" int($5/1024) " KB，版本 '"$VER"'）"}'
