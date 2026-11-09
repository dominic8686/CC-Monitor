"""Regression tests for the intervention level switch: the permissive alias, backward
compatibility of the on-disk value, and the hook's "evaluate and record as usual, but never block"
behaviour in Permissive (observe only) mode.

Run directly: python3 -m unittest tests/test_audit_state.py
Uses an isolated CC_MONITOR_HOME and never touches the user's own state and database in ~/.cc-monitor.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import audit_state  # noqa: E402


class TestStateAliases(unittest.TestCase):
    def test_canonical_values_pass_through(self):
        for s in ("running", "paused", "stopped"):
            self.assertEqual(audit_state.normalize_state(s), s)

    def test_permissive_is_an_alias_of_paused(self):
        # permissive is the preferred public name for this level; observe / log-only are synonyms.
        for alias in ("permissive", "observe", "log-only", "log_only"):
            self.assertEqual(audit_state.normalize_state(alias), "paused")

    def test_enforcing_and_off_aliases(self):
        for alias in ("enforcing", "enforce"):
            self.assertEqual(audit_state.normalize_state(alias), "running")
        for alias in ("disabled", "off"):
            self.assertEqual(audit_state.normalize_state(alias), "stopped")

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(audit_state.normalize_state("  PERMISSIVE "), "paused")

    def test_unknown_is_rejected(self):
        self.assertIsNone(audit_state.normalize_state("bogus"))
        self.assertIsNone(audit_state.normalize_state(None))
        with self.assertRaises(ValueError):
            audit_state.set_state("bogus")

    def test_disk_format_stays_backward_compatible(self):
        """Writing permissive must still store paused on disk: older CC-Monitor versions and any
        script that reads this file directly parse the three values running/paused/stopped, and
        the rename must not break them."""
        audit_state.set_state("permissive")
        on_disk = json.loads(open(audit_state.STATE_FILE, encoding="utf-8").read())
        self.assertEqual(on_disk["state"], "paused")
        self.assertEqual(audit_state.get_state(), "paused")


def run_hook(payload):
    """Run the PreToolUse hook once and return (exit_code, stderr)."""
    proc = subprocess.run(
        [sys.executable, "-m", "cc_monitor.hook", "pre"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_REPO,
        env={**os.environ, "CC_MONITOR_HOME": _TMP},
    )
    return proc.returncode, proc.stderr


def open_test_db():
    """Connect to this test's own events.db.

    The connection helper in cc_monitor.storage cannot be used: its DB_PATH is a module-level
    constant fixed from CC_MONITOR_HOME when storage is first imported. In the same pytest run,
    other files under tests/ set their own CC_MONITOR_HOME, and whichever imports first wins. Relying
    on that order means the test passes alone but reads another test's database in a full run.
    Here the path is built explicitly from _TMP, independent of import order.
    """
    import sqlite3

    return sqlite3.connect(os.path.join(_TMP, "events.db"), timeout=5)


DANGEROUS = {
    "tool_name": "Bash",
    "tool_input": {"command": "rm -rf /"},
    "session_id": "test-audit-state",
    "cwd": "/tmp",
}


class TestPermissiveNeverBlocks(unittest.TestCase):
    def tearDown(self):
        audit_state.set_state("running")

    def test_enforcing_blocks(self):
        audit_state.set_state("running")
        code, err = run_hook(DANGEROUS)
        self.assertEqual(code, 2, "The Enforcing level must actually block")
        self.assertIn("Operation blocked", err)

    def test_permissive_allows_but_still_records(self):
        audit_state.set_state("permissive")
        code, err = run_hook(DANGEROUS)
        self.assertEqual(code, 0, "Permissive mode must never block")
        self.assertNotIn("Operation blocked", err)

        # The key point: it was allowed, but risk / matched_rule must still be recorded as usual;
        # otherwise this level degrades into "Off".
        conn = open_test_db()
        row = conn.execute(
            "SELECT risk, matched_rule, decision FROM events "
            "WHERE session_id=? AND source='hook_pre' ORDER BY id DESC LIMIT 1",
            (DANGEROUS["session_id"],),
        ).fetchone()
        conn.close()
        self.assertIsNotNone(row, "Permissive mode must leave an audit record")
        self.assertEqual(row[0], "high")
        self.assertEqual(row[1], "dangerous_delete")
        self.assertEqual(row[2], "allowed")

    def test_permissive_creates_no_pending_approvals(self):
        """Permissive mode promises "no confirmation prompts", so no pending entries may appear in AI Approvals."""
        conn = open_test_db()
        conn.execute("DELETE FROM pending_approvals")
        conn.commit()
        conn.close()

        audit_state.set_state("permissive")
        # A confirm rule: web search. Enforcing mode asks; Permissive mode must allow it directly.
        code, _ = run_hook({
            "tool_name": "WebSearch",
            "tool_input": {"query": "anything"},
            "session_id": "test-audit-state",
            "cwd": "/tmp",
        })
        self.assertEqual(code, 0)

        conn = open_test_db()
        n = conn.execute("SELECT count(*) FROM pending_approvals").fetchone()[0]
        conn.close()
        self.assertEqual(n, 0, "Permissive mode must not create any pending confirmation entries")


if __name__ == "__main__":
    unittest.main()
