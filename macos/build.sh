#!/usr/bin/env bash
#
# Builds FlickSync.app and FlickSync.dmg on a Mac.
#
#   ./build.sh            universal (arm64 + x86_64) if the toolchain allows
#   ./build.sh --native   just this machine's architecture (faster)
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
DIST="$PWD/dist"
APP="$DIST/FlickSync.app"
CONFIG="release"

echo "▸ Compiling Swift ($CONFIG)…"
if [[ "${1:-}" == "--native" ]]; then
  swift build -c "$CONFIG"
else
  if ! swift build -c "$CONFIG" --arch arm64 --arch x86_64 2>/tmp/flicksync-build.log; then
    echo "  universal build unavailable, falling back to native arch"
    swift build -c "$CONFIG"
  fi
fi

BIN="$(swift build -c "$CONFIG" --show-bin-path)/FlickSync"
if [[ ! -x "$BIN" ]]; then
  echo "✗ build produced no binary at $BIN" >&2
  exit 1
fi

echo "▸ Assembling app bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/FlickSync"
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Shared in-page bridge (single source of truth with the Android app).
cp "$ROOT/shared/bridge.js" "$APP/Contents/Resources/bridge.js"

# Icon
if [[ -f Resources/icon-1024.png ]]; then
  ICONSET="$DIST/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z $size $size Resources/icon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double Resources/icon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

echo "▸ Signing (ad-hoc)…"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (ad-hoc signing skipped)"

echo "▸ Building DMG…"
rm -f "$DIST/FlickSync.dmg"
STAGE="$DIST/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create \
  -volname "FlickSync" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DIST/FlickSync.dmg" >/dev/null
rm -rf "$STAGE"

echo
echo "✓ $APP"
echo "✓ $DIST/FlickSync.dmg"
echo
echo "First launch: macOS may say the app is from an unidentified developer."
echo "Right-click the app → Open, or run: xattr -dr com.apple.quarantine /Applications/FlickSync.app"
