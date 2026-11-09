"""Intervention level switch: Enforcing / Permissive (observe only) / Off.

Stored in a small state file (no database; reads and writes are atomic single-file operations,
and the hook reads it on every call, so it must stay cheap). The three levels mean different
things; this is not a simple on/off switch:

- running (default): fully normal. Rules decide allow/block/confirm and everything is recorded.
- paused / permissive: observe only, record without blocking. Rules still run and the computed
  risk/matched_rule is recorded, but nothing is ever actually blocked and no confirmation prompt is
  shown; everything is allowed. Useful for "I know the next batch of operations is somewhat risky,
  but I do not want to be interrupted; I will read the log later", or to leave on for a long time
  to learn what the AI actually does before deciding what to block.
  Named after SELinux's permissive / AppArmor's complain mode: evaluation runs and violations are
  recorded, only nothing is prevented.
- stopped: no intervention at all. No evaluation, no recording; same as not having the hook
  installed. Useful for checking whether CC-Monitor itself causes a problem, or for simply not
  keeping any record.

Note that auditing only really stops at the stopped level; in running and permissive auditing
keeps going. So user-facing text always says "intervention level / Permissive (observe only)",
never "audit paused".

On disk the values are still running/paused/stopped. permissive is an alias of paused and is
normalised on input, so older CC-Monitor versions and any script that reads this file directly or
calls /api/audit-state keep working after the rename.
"""
import json
import os
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
STATE_FILE = CONFIG_DIR / "audit_state.json"

# Canonical values written to disk. Do not change them: external scripts and older versions read these three values.
VALID_STATES = ("running", "paused", "stopped")

# Accepted aliases -> canonical value. permissive/observe both mean the paused level,
# enforcing means running, disabled/off mean stopped.
STATE_ALIASES = {
    "permissive": "paused",
    "observe": "paused",
    "log-only": "paused",
    "log_only": "paused",
    "enforcing": "running",
    "enforce": "running",
    "disabled": "stopped",
    "off": "stopped",
}


def normalize_state(state):
    """Map an alias to its canonical on-disk value. Canonical values are returned unchanged; anything unrecognised returns None."""
    if not isinstance(state, str):
        return None
    s = state.strip().lower()
    if s in VALID_STATES:
        return s
    return STATE_ALIASES.get(s)


def get_state():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        state = data.get("state")
        if state in VALID_STATES:
            return state
    except (OSError, json.JSONDecodeError):
        pass
    return "running"


def get_state_info():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if data.get("state") in VALID_STATES:
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"state": "running", "changedAt": None}


def set_state(state):
    canonical = normalize_state(state)
    if canonical is None:
        raise ValueError(
            "state must be one of {} (aliases {} are also accepted)".format(VALID_STATES, tuple(STATE_ALIASES))
        )
    state = canonical
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"state": state, "changedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}),
        encoding="utf-8",
    )
