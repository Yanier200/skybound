#!/usr/bin/env bash
# Builds SKYBOUND-<version>.apk in the project root: the game bundled into a WebView app.
#
# No Gradle or Android Studio needed - aapt2, javac, d8, zipalign and apksigner
# from the SDK in .tooling/android-sdk do the whole job, so the build is quick
# and reproducible offline. Assets are added with `jar`, because aapt2 on
# Windows writes their entry names with backslashes and Android cannot read those.
set -euo pipefail
cd "$(dirname "$0")/.."

SDK=".tooling/android-sdk"
BT="$SDK/build-tools/35.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
JAVA_HOME="${JAVA_HOME:-/c/Program Files/Java/jdk-26.0.1}"
OUT=".tooling/apk"
VERSION="$(node -p "require('./package.json').version")"
CODE="$(node -p "require('./package.json').version.split('.').reduce((a, b, i) => a + Number(b) * [10000, 100, 1][i], 0)")"
APK="SKYBOUND-$VERSION.apk"  # built straight into the project root, easy to grab
KEYSTORE=".tooling/skybound.keystore"
ABS="$(pwd)/$OUT/base.apk"

for p in "$BT/aapt2.exe" "$ANDROID_JAR" "$JAVA_HOME/bin/javac.exe"; do
  [ -e "$p" ] || { echo "missing: $p (run the SDK install first)"; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

# 1. stage the web build
rm -rf android/assets/www
mkdir -p android/assets/www
cp index.html styles.css android/assets/www/
cp -r js vendor assets android/assets/www/

# 2. resources and manifest
"$BT/aapt2.exe" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2.exe" link -o "$OUT/base.apk" -I "$ANDROID_JAR" \
  --manifest android/AndroidManifest.xml \
  --version-code "$CODE" --version-name "$VERSION" \
  --java "$OUT/gen" --auto-add-overlay "$OUT/res.zip"

# 3. java -> bytecode -> dex
"$JAVA_HOME/bin/javac.exe" --release 17 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  android/src/com/skybound/game/MainActivity.java \
  "$OUT/gen/com/skybound/game/R.java"
"$BT/d8.bat" --release --min-api 24 --lib "$ANDROID_JAR" \
  --output "$OUT/dex" "$OUT/classes/com/skybound/game/"*.class

# 4. drop the dex and the game files into the package
( cd "$OUT/dex" && "$JAVA_HOME/bin/jar.exe" uf "$ABS" classes.dex )
mkdir -p "$OUT/assetroot/assets"
cp -r android/assets/www "$OUT/assetroot/assets/www"
( cd "$OUT/assetroot" && "$JAVA_HOME/bin/jar.exe" uf "$ABS" assets )

# 5. align, then sign with a local key (side-loadable, no Play account needed)
"$BT/zipalign.exe" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool.exe" -genkeypair -keystore "$KEYSTORE" -alias skybound \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass skybound -keypass skybound -dname "CN=SKYBOUND, O=SKYBOUND"
fi
"$BT/apksigner.bat" sign --ks "$KEYSTORE" --ks-pass pass:skybound --key-pass pass:skybound \
  --ks-key-alias skybound --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner.bat" verify "$APK"
echo "built $APK"
ls -l "$APK"
