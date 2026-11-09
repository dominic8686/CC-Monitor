#!/usr/bin/env python3
"""Install CC-Monitor's hooks into Claude Code's settings.json: PreToolUse/PostToolUse/
PermissionRequest (decisions/approval for tool calls) plus UserPromptSubmit/SessionStart/SessionEnd/
PreCompact/Stop/SubagentStop (session lifecycle, audit trail only, never block).

Usage:
    python3 install.py                     # install into the global ~/.claude/settings.json
    python3 install.py --project DIR       # install into the project's DIR/.claude/settings.json
    python3 install.py --target FILE       # install into the given settings.json (for installing as another user without relying on HOME)
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
HOOK_BIN = REPO_ROOT / "bin" / "CC-Monitor-hook"


def merge_hooks(settings, hook_cmd_pre, hook_cmd_post, hook_cmd_permission=None, extra_hooks=None):
    hooks = settings.setdefault("hooks", {})

    def add(event_name, command):
        entries = hooks.setdefault(event_name, [])
        for entry in entries:
            for h in entry.get("hooks", []):
                if h.get("command") == command:
                    return  # already installed, skip
        entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command}]})

    add("PreToolUse", hook_cmd_pre)
    add("PostToolUse", hook_cmd_post)
    # PermissionRequest fires when Claude Code is about to show its own native "Do you want to
    # proceed?" prompt. It brings tool calls that matched none of our confirm rules, but that Claude
    # Code itself wants to ask about, into AI Approvals as well (configurations installed by old
    # versions lack this entry; rerunning install adds it and leaves the existing two alone).
    if hook_cmd_permission:
        add("PermissionRequest", hook_cmd_permission)
    # UserPromptSubmit/SessionStart/SessionEnd/PreCompact/Stop/SubagentStop: session lifecycle
    # hooks, audit trail only (see the comments on the matching handlers in cc_monitor/hook.py),
    # never confirm/block. Configurations installed by old versions lack these; rerunning install
    # adds them and leaves existing entries alone, the same patching logic as PermissionRequest above.
    for event_name, command in (extra_hooks or {}).items():
        add(event_name, command)
    return settings


def configure_statusline(settings):
    """Wire ccstatusline into Claude Code's terminal status line (it reads the same data as the
    quota/account page; see the comment at the top of webui/lib/usage.js). Acts only when both
    conditions hold:
      1. ccstatusline is already installed on the system (install.sh runs npm install -g first;
         this only does the wiring, not the install: installing an npm package from python is
         impractical, and we should not couple across languages);
      2. settings.json has no statusLine key yet.
    If either condition fails, do nothing: if it is not installed there is nothing to wire (it
    would just run empty), and an existing configuration (ccstatusline or not, whatever its
    parameters) is never overwritten: the user may have tuned padding/refreshInterval or switched
    to another status line tool, and install.py must not silently wipe that out.
    Returns True if the configuration was actually written this time, False if skipped (not
    installed / already configured); the caller uses this to decide whether to print a note.
    """
    if "statusLine" in settings:
        return False
    if not shutil.which("ccstatusline"):
        return False
    settings["statusLine"] = {
        "type": "command",
        "command": "ccstatusline",
        "padding": 0,
        "refreshInterval": 10,
    }
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project",
        help="Install into the given project directory's .claude/settings.json instead of the global ~/.claude/settings.json",
    )
    parser.add_argument(
        "--target",
        help="Absolute path of the settings.json to use (highest priority; for installing for another user)",
    )
    parser.add_argument(
        "--skip-statusline",
        action="store_true",
        help="Do not wire ccstatusline into the statusLine setting (install.sh's --skip-ccstatusline turns into this)",
    )
    args = parser.parse_args()

    if args.target:
        target = Path(args.target).resolve()
    elif args.project:
        target = Path(args.project).resolve() / ".claude" / "settings.json"
    else:
        target = Path.home() / ".claude" / "settings.json"

    target.parent.mkdir(parents=True, exist_ok=True)

    settings = {}
    if target.exists():
        try:
            settings = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            backup = target.with_suffix(".json.bak")
            print(
                "Warning: {} is not valid JSON; backed it up as {} and started a new one".format(target, backup),
                file=sys.stderr,
            )
            target.rename(backup)
            settings = {}

    os.chmod(REPO_ROOT / "bin" / "CC-Monitor", 0o755)
    os.chmod(HOOK_BIN, 0o755)

    hook_cmd_pre = '"{}" pre'.format(HOOK_BIN)
    hook_cmd_post = '"{}" post'.format(HOOK_BIN)
    hook_cmd_permission = '"{}" permission'.format(HOOK_BIN)
    extra_hooks = {
        "UserPromptSubmit": '"{}" prompt'.format(HOOK_BIN),
        "SessionStart": '"{}" session_start'.format(HOOK_BIN),
        "SessionEnd": '"{}" session_end'.format(HOOK_BIN),
        "PreCompact": '"{}" precompact'.format(HOOK_BIN),
        "Stop": '"{}" stop'.format(HOOK_BIN),
        "SubagentStop": '"{}" subagent_stop'.format(HOOK_BIN),
    }
    settings = merge_hooks(settings, hook_cmd_pre, hook_cmd_post, hook_cmd_permission, extra_hooks)
    statusline_configured = False if args.skip_statusline else configure_statusline(settings)

    target.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("Wrote: {}".format(target))
    print("Hook script: {}".format(HOOK_BIN))
    print("Restart Claude Code for this to take effect. Run `{}/bin/CC-Monitor tail` to watch monitoring events live.".format(REPO_ROOT))
    if statusline_configured:
        print("Configured statusLine: ccstatusline (the terminal will show model, quota, git branch and other status information)")
    elif args.skip_statusline:
        print("Skipped statusLine configuration (--skip-statusline).")
    elif "statusLine" not in settings:
        print("statusLine not configured: ccstatusline was not found. Run install.sh to install and wire it automatically, "
              "or run `npm install -g ccstatusline` yourself and rerun install.py.")


if __name__ == "__main__":
    main()
