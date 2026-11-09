#!/usr/bin/env bash
# One-shot install: register the hooks into Claude Code + install the Web UI deps.
# Usage:
#   ./install.sh                        # global hooks (writes ~/.claude/settings.json)
#   ./install.sh --project /path        # hooks scoped to one project
#   ./install.sh --skip-geoip           # skip the GeoIP database download (offline / no world map needed)
#   ./install.sh --skip-ccstatusline    # skip installing/wiring the ccstatusline status line
#   Any other flag is exactly what install.py accepts and is passed straight through to it.
set -euo pipefail

# ---------- language detection ----------
# Messages follow the system language: Chinese for a Chinese locale, English for everything else.
# Priority: explicit CC_MONITOR_LANG > LC_ALL / LC_MESSAGES / LANG > macOS system region.
# Terminals opened from the macOS GUI often set no LANG at all, so AppleLocale is queried as well;
# otherwise Chinese users on a Mac would get English.
_cc_detect_lang() {
  case "${CC_MONITOR_LANG:-}" in
    zh*) printf 'zh'; return ;;
    en*) printf 'en'; return ;;
  esac
  local loc="${LC_ALL:-}"
  [ -z "$loc" ] && loc="${LC_MESSAGES:-}"
  [ -z "$loc" ] && loc="${LANG:-}"
  if [ -z "$loc" ] && [ "$(uname -s)" = "Darwin" ] && command -v defaults >/dev/null 2>&1; then
    loc="$(defaults read -g AppleLocale 2>/dev/null || true)"
  fi
  case "$loc" in
    zh*|*_CN*|*_TW*|*_HK*|*Hans*|*Hant*) printf 'zh' ;;
    *) printf 'en' ;;
  esac
}
CC_LANG="$(_cc_detect_lang)"

# say <Chinese> <English>: print the one matching the current language; say_err does the same on stderr
say() { if [ "$CC_LANG" = "zh" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
say_err() { if [ "$CC_LANG" = "zh" ]; then printf '%s\n' "$1" >&2; else printf '%s\n' "$2" >&2; fi; }

# --skip-geoip / --skip-ccstatusline are handled by this script and must not be passed on to
# install.py (argparse would reject them as unknown). The environment variables
# CC_MONITOR_SKIP_GEOIP=1 / CC_MONITOR_SKIP_CCSTATUSLINE=1 work too.
SKIP_GEOIP="${CC_MONITOR_SKIP_GEOIP:-}"
SKIP_CCSTATUSLINE="${CC_MONITOR_SKIP_CCSTATUSLINE:-}"
PASSTHRU=()
for arg in "$@"; do
  case "$arg" in
    --skip-geoip) SKIP_GEOIP=1 ;;
    --skip-ccstatusline) SKIP_CCSTATUSLINE=1 ;;
    *) PASSTHRU+=("$arg") ;;
  esac
done
set -- "${PASSTHRU[@]+"${PASSTHRU[@]}"}"

# Whatever directory this script is called from, REPO_ROOT is the script's own directory;
# we cannot assume the user cd'd here before running it.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  say_err "[CC-Monitor] 没找到 python3，装完 Python 3 再重跑这个脚本" \
          "[CC-Monitor] python3 not found — install Python 3 and run this script again"
  exit 1
fi

say "[CC-Monitor] 1/5 ccstatusline（终端状态栏，显示模型/额度/git 分支等）..." \
    "[CC-Monitor] 1/5 ccstatusline (terminal status line: model / quota / git branch)..."
# Install the package first: only then can the install.py step find the `ccstatusline` command
# and wire it into the statusLine setting, so the order matters. Both layers skip what is already
# there: here we check whether the command is already on PATH (whether this script installed it
# earlier or the user did) and do not reinstall/upgrade it; whether to wire it into statusLine is
# decided by install.py's configure_statusline(), which checks settings.json for a statusLine key.
# Each side is idempotent, and neither overwrites the user's existing customisations.
if [ -n "$SKIP_CCSTATUSLINE" ]; then
  say "[CC-Monitor] 跳过 ccstatusline（--skip-ccstatusline）。" \
      "[CC-Monitor] Skipping ccstatusline (--skip-ccstatusline)."
elif command -v ccstatusline >/dev/null 2>&1; then
  say "[CC-Monitor] 已检测到 ccstatusline，跳过安装（下一步会检查要不要接进 statusLine 配置）。" \
      "[CC-Monitor] ccstatusline already present, skipping install (the next step checks the statusLine wiring)."
elif command -v npm >/dev/null 2>&1; then
  if npm install -g ccstatusline; then
    say "[CC-Monitor] ccstatusline 安装完成。" "[CC-Monitor] ccstatusline installed."
  else
    say_err "[CC-Monitor] ccstatusline 安装失败（网络问题？）。这是可选功能，不影响其它部分，之后可以手动: npm install -g ccstatusline" \
            "[CC-Monitor] ccstatusline install failed (network?). It's optional and affects nothing else; you can run 'npm install -g ccstatusline' later."
  fi
else
  say_err "[CC-Monitor] 没找到 npm，跳过 ccstatusline 安装（可选功能，不影响主功能）。" \
          "[CC-Monitor] npm not found, skipping ccstatusline (optional, nothing else is affected)."
fi

echo
say "[CC-Monitor] 2/5 注册 hooks 到 Claude Code..." \
    "[CC-Monitor] 2/5 Registering hooks into Claude Code..."
if [ -n "$SKIP_CCSTATUSLINE" ]; then
  python3 install.py "$@" --skip-statusline
else
  python3 install.py "$@"
fi

echo
say "[CC-Monitor] 3/5 安装 Web UI 依赖..." "[CC-Monitor] 3/5 Installing Web UI dependencies..."
if command -v npm >/dev/null 2>&1; then
  (cd webui && npm install)
else
  say_err "[CC-Monitor] 没找到 npm，跳过 Web UI 依赖安装——只想用 CLI（tail/rules/stats/verify/tap）的话不影响；想用 Web UI 的话装好 Node.js/npm 后手动跑一次: cd webui && npm install" \
          "[CC-Monitor] npm not found, skipping Web UI dependencies — fine if you only want the CLI (tail/rules/stats/verify/tap). For the Web UI, install Node.js/npm and run: cd webui && npm install"
fi

echo
if [ "$(uname -s)" = "Darwin" ]; then
  say "[CC-Monitor] 4/5 macOS：系统层探针用系统自带的 nettop，不用装东西，直接 bin/CC-Monitor-probe（不需要 sudo）。" \
      "[CC-Monitor] 4/5 macOS: the system-layer probe uses the built-in nettop — nothing to install, just run bin/CC-Monitor-probe (no sudo needed)."
elif command -v bpftrace >/dev/null 2>&1; then
  say "[CC-Monitor] 4/5 检测到 bpftrace，系统层探针（CC-Monitor-probe）可以直接用。" \
      "[CC-Monitor] 4/5 bpftrace detected — the system-layer probe (CC-Monitor-probe) is ready to use."
else
  say "[CC-Monitor] 4/5 没检测到 bpftrace（系统层探针是可选的，跳过不影响主功能）。" \
      "[CC-Monitor] 4/5 bpftrace not found (the system-layer probe is optional; skipping affects nothing else)."
  say "             想用的话：Debian/Ubuntu 用 'sudo apt install bpftrace'，其它发行版参考 bpftrace 官方文档。" \
      "             To enable it: 'sudo apt install bpftrace' on Debian/Ubuntu, or see the bpftrace docs for your distro."
fi

echo
# GeoIP database: the location column and world map on the Network page rely on it. It is not
# shipped with the repository (tens of MB, and the licence requires obtaining it separately). By
# default we download the DB-IP Lite IPv4 city database (CC BY 4.0, no account needed) as the .mmdb
# that sapics/ip-location-db converts automatically every day. If any usable database is already
# present (including a MaxMind GeoLite2 you placed yourself) nothing is downloaded; a failed download
# only prints a note and does not stop the install, since this is optional.
# Skip it with CC_MONITOR_SKIP_GEOIP=1 / --skip-geoip.
GEOIP_DIR="${CC_MONITOR_HOME:-$HOME/.cc-monitor}"
GEOIP_TARGET="$GEOIP_DIR/dbip-city.mmdb"
# CC_MONITOR_GEOIP_URL can point the download at a mirror (e.g. when GitHub is hard to reach).
GEOIP_URL="${CC_MONITOR_GEOIP_URL:-https://github.com/sapics/ip-location-db/releases/download/latest/dbip-city-ipv4.mmdb}"
if [ -n "$SKIP_GEOIP" ]; then
  say "[CC-Monitor] 5/5 跳过 GeoIP 数据库下载（--skip-geoip）。" \
      "[CC-Monitor] 5/5 Skipping the GeoIP database download (--skip-geoip)."
elif [ -f "$GEOIP_TARGET" ] || [ -f "$GEOIP_DIR/GeoLite2-City.mmdb" ] || [ -f "$GEOIP_DIR/GeoLite2-Country.mmdb" ]; then
  say "[CC-Monitor] 5/5 GeoIP 数据库已存在（$GEOIP_DIR 下已有 .mmdb），跳过下载。" \
      "[CC-Monitor] 5/5 A GeoIP database is already present (.mmdb found in $GEOIP_DIR), skipping the download."
else
  say "[CC-Monitor] 5/5 下载 GeoIP 数据库（DB-IP Lite，约 60MB）到 $GEOIP_TARGET ..." \
      "[CC-Monitor] 5/5 Downloading the GeoIP database (DB-IP Lite, ~60MB) to $GEOIP_TARGET ..."
  mkdir -p "$GEOIP_DIR"
  GEOIP_TMP="$GEOIP_TARGET.part"
  geoip_ok=""
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar --retry 2 --connect-timeout 15 -m 600 -o "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -t 2 -O "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  else
    say_err "[CC-Monitor] 没找到 curl 或 wget，没法自动下载。" \
            "[CC-Monitor] Neither curl nor wget found — cannot download automatically."
  fi
  # Never keep an empty or partial file: geoip.js fails silently on a broken mmdb and the page looks
  # "not configured", which is harder to track down than a missing file. A real database is tens of
  # MB, so anything under 1MB counts as a failed download.
  GEOIP_SIZE=$(( $(wc -c < "$GEOIP_TMP" 2>/dev/null || echo 0) ))  # macOS wc pads with leading spaces; the arithmetic expansion strips them
  if [ -n "$geoip_ok" ] && [ "$GEOIP_SIZE" -gt 1000000 ]; then
    mv -f "$GEOIP_TMP" "$GEOIP_TARGET"
    say "[CC-Monitor] GeoIP 数据库已就绪: $GEOIP_TARGET" \
        "[CC-Monitor] GeoIP database ready: $GEOIP_TARGET"
  else
    rm -f "$GEOIP_TMP"
    say_err "[CC-Monitor] GeoIP 数据库下载失败（网络不通/被墙？）。这是可选功能，不影响其它部分。" \
            "[CC-Monitor] GeoIP database download failed (network issues?). It's optional and affects nothing else."
    say_err "             之后可以手动下载: curl -L -o $GEOIP_TARGET $GEOIP_URL" \
            "             You can download it later: curl -L -o $GEOIP_TARGET $GEOIP_URL"
    say_err "             或者用 MaxMind GeoLite2，放到 $GEOIP_DIR/GeoLite2-City.mmdb" \
            "             Or use MaxMind GeoLite2 and place it at $GEOIP_DIR/GeoLite2-City.mmdb"
  fi
fi

echo
echo "======================================================================"
say " 安装完成。接下来：" " Installation complete. Next steps:"
say "  1. 重启 Claude Code（新开的会话才会读到刚写进去的 hooks 配置）" \
    "  1. Restart Claude Code (only new sessions pick up the hooks config just written)"
say "  2. 想用 Web UI 的话运行: ./start.sh" \
    "  2. For the Web UI, run: ./start.sh"
echo "======================================================================"
