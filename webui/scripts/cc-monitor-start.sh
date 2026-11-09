#!/usr/bin/env bash
# The packaged AppImage is a single executable; double-clicking or running it directly goes
# through no npm script, so the "node launcher adds --no-sandbox depending on the user" approach
# from electron-main.js does not apply here. Chromium's root-sandbox check happens in the native
# startup phase, before any JS code in the AppImage, so the only thing that works is to put
# --no-sandbox (and --disable-gpu-sandbox: the GPU process has its own sandbox layer, which
# likewise fails to start as root) into its launch arguments from outside, before the binary
# actually starts. This script does only that: it adds the two flags for root and starts it
# unchanged for any other user, so sandbox protection is unaffected.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE="$(ls "$DIR"/CC-Monitor-*.AppImage 2>/dev/null | head -n1)"

if [ -z "$APPIMAGE" ]; then
  echo "Cannot find CC-Monitor-*.AppImage in the same directory. Make sure this script and the AppImage are together." >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  exec "$APPIMAGE" --no-sandbox --disable-gpu-sandbox "$@"
else
  exec "$APPIMAGE" "$@"
fi
