#!/usr/bin/env bash
# Start the Web UI: installs dependencies on first run, then runs in the
# foreground (Ctrl+C to stop).
# To run it in the background: nohup ./start.sh > /tmp/cc-monitor-webui.log 2>&1 &
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

cd "$REPO_ROOT/webui"

# The Web UI and the cc_monitor hook each derive their ~/.cc-monitor/ directory from the OS user
# of the current process. If this is started with sudo/root while you normally run claude in the
# terminal as your regular account, the two sides write two unrelated SQLite databases: the
# terminal's confirmation prompts and audit events never show up on the Web UI's pending approval
# and audit log pages. This is only a warning, not an exit (running both sides as root works too).
if [ "$(id -u)" -eq 0 ] && [ -z "${CC_MONITOR_ALLOW_ROOT:-}" ]; then
  say "[CC-Monitor] 警告：正在用 root 启动 Web UI。如果你平时跑 claude 用的是普通账号，" \
      "[CC-Monitor] Warning: starting the Web UI as root. If you normally run claude as a regular user,"
  say "             两边会各写各的 ~/.cc-monitor/ 数据库，互相看不到彼此。" \
      "             each side writes its own ~/.cc-monitor/ database and neither can see the other."
  say "             建议改用你平时跑 claude 的那个账号启动（比如 sudo -u <你的用户名> ./start.sh）。" \
      "             Prefer starting it as that user (e.g. sudo -u <your-username> ./start.sh)."
  say "             确认就是要用 root（比如 claude 本来就是 root 跑的），设 CC_MONITOR_ALLOW_ROOT=1 消除这条提示。" \
      "             If root is intended (claude also runs as root), set CC_MONITOR_ALLOW_ROOT=1 to silence this."
fi

if [ ! -d node_modules ]; then
  say "[CC-Monitor] 还没装过依赖，先跑一次 npm install..." \
      "[CC-Monitor] Dependencies not installed yet, running npm install first..."
  npm install
fi

say "[CC-Monitor] 启动 Web UI..." "[CC-Monitor] Starting the Web UI..."
exec node server.js
