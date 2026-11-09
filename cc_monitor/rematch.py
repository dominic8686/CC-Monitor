"""After the rules change, re-evaluate (rematch) the PreToolUse events already in the audit
database with the current rules.

The stat cards on Home (software install, sensitive operations, sensitive data, ...) all aggregate
events.matched_rule, and matched_rule is computed and fixed by the hook at the moment of the event,
using the rules of that time. After a rule is fixed for false positives or false negatives, the
numbers on the cards stay wrong unless past events are re-evaluated. (Before the port false
positive was fixed, the 10 events that matched "System package manager install" were all false
positives from grep/heredoc text that merely mentioned the words; fixing the rule does not make
them go away on its own.)

Two triggers:
- Automatic: on every call the hook computes the fingerprint of the current rule set
  (policy.rules_fingerprint). If it differs from the "fingerprint used for the last rematch" stored
  in the meta table, the hook claims the job and starts a separate background process running
  run(apply=True). The hook does not re-evaluate itself: running the regexes over thousands of
  events takes seconds, and PreToolUse cannot stall that long.
- Manual: `CC-Monitor rematch` previews what would change; `--apply` actually writes.

Only the risk/matched_rule columns change. decision (the real allow/block outcome at the time) is
never touched, and the archive databases (archives/) are left alone.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from . import policy, storage

FINGERPRINT_KEY = "rules_fingerprint"


def run(apply=False, rules=None):
    """Return (total, changes); changes is [(event_id, tool_name, old_rule, new_rule, new_risk, summary)]."""
    if rules is None:
        rules = policy.load_rules()
    changes = []
    total = 0
    for event_id, tool_name, risk, matched_rule, detail_raw, cwd in storage.iter_hook_pre_events():
        total += 1
        try:
            tool_input = json.loads(detail_raw) if detail_raw else {}
        except json.JSONDecodeError:
            continue
        if not isinstance(tool_input, dict):
            continue
        rule, _ = policy.evaluate(tool_name or "", tool_input, rules=rules, cwd=cwd)
        new_rule = rule["id"] if rule else None
        new_risk = rule["risk"] if rule else "low"
        if new_rule != matched_rule or (new_rule and new_risk != risk):
            summary = tool_input.get("command") or tool_input.get("file_path") or tool_input.get("path") or ""
            summary = " ".join(str(summary).split())[:90]
            changes.append((event_id, tool_name, matched_rule, new_rule, new_risk, summary))
    if apply:
        storage.update_event_matches([(new_risk, new_rule, event_id) for event_id, _, _, new_rule, new_risk, _ in changes])
        storage.claim_meta(FINGERPRINT_KEY, policy.rules_fingerprint(rules))
    return total, changes


def maybe_schedule(rules):
    """Called from the hook: if the rules fingerprint differs from the last rematch, start a
    background rematch --apply. The process starts only if the claim succeeds; failures and
    exceptions are silent. This is only cleanup and must not affect the hook's main flow."""
    try:
        fp = policy.rules_fingerprint(rules)
        if not storage.claim_meta(FINGERPRINT_KEY, fp):
            return False
        launcher = Path(__file__).resolve().parent.parent / "bin" / "CC-Monitor"
        if launcher.exists():
            cmd = [sys.executable, str(launcher), "rematch", "--apply", "--quiet"]
        else:
            cmd = [sys.executable, "-m", "cc_monitor.cli", "rematch", "--apply", "--quiet"]
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(Path(__file__).resolve().parent.parent),
            env=dict(os.environ),
        )
        return True
    except Exception:
        return False
