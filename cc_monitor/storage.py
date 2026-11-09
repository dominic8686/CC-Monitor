import json
import os
import sqlite3
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
DB_PATH = CONFIG_DIR / "events.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT,
    source TEXT,
    tool_name TEXT,
    cwd TEXT,
    risk TEXT,
    matched_rule TEXT,
    decision TEXT,
    detail TEXT
);

-- An action=confirm operation can be answered with y/N in the terminal that triggered it, or
-- with a button on the Web UI "pending approval" page. Whichever path writes to this table first
-- wins (once status changes from 'pending', the other path's UPDATE has no effect because
-- WHERE status='pending' no longer holds).
-- kind='confirm' is the original "allow this to run?" confirmation prompt; whichever of the web
-- page and terminal answers first wins. kind='notify' was added later for interactions with no
-- allow/deny meaning at all, where Claude Code asks the user a clarifying question
-- (AskUserQuestion and the like). The hook only records it so the web page can show "a question
-- is waiting for you"; it never blocks and never shows a confirmation prompt. The answer can only
-- be given in the terminal that triggered it (we do not, and should not, pick an option for the
-- user). When the matching PostToolUse event arrives, the record is marked answered and drops out
-- of the pending list automatically.
CREATE TABLE IF NOT EXISTS pending_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT,
    tool_name TEXT,
    cwd TEXT,
    matched_rule TEXT,
    matched_value TEXT,
    risk TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT,
    resolved_via TEXT,
    kind TEXT NOT NULL DEFAULT 'confirm',
    resolved_value TEXT
);

-- "Always allow" applies per session; it does not change the global rules. Within the same
-- session this rule is not asked again; other sessions (even running the exact same command)
-- are still asked. An empty expires_at means truly "always"; a value means a timed version
-- ("approve and do not ask again for N minutes"), after which is_session_always_allowed() stops
-- honouring it and normal prompting resumes.
CREATE TABLE IF NOT EXISTS session_always_allow (
    session_id TEXT NOT NULL,
    matched_rule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (session_id, matched_rule)
);

-- Traffic totals aggregated by (ip, port), from the tcp_sendmsg/tcp_cleanup_rbuf kernel probe
-- points added to the system-layer probe; byte counts are summed in every 2 seconds. This
-- complements the single CONNECT records with source='os_net' in the events table: those are a
-- timeline of "when was this address contacted", this table is the running total of "how many
-- bytes were transferred". It only has data when bpftrace is installed and the probe is running.
-- Key-value table with a single key for now: rules_fingerprint, the rule set last used to
-- re-evaluate past events (see rematch.py). On every call the hook compares the current rules
-- fingerprint with it; if they differ, the rules changed and matched_rule on past events is out
-- of date, so a background rematch process re-evaluates them.
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS network_traffic (
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    host TEXT,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    connect_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (ip, port)
);
"""


def _connect():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=5)
    conn.execute("PRAGMA journal_mode=WAL;")
    # SCHEMA is now several CREATE TABLE statements joined together. sqlite3.Connection.execute()
    # runs only one statement at a time; several need executescript().
    conn.executescript(SCHEMA)
    try:
        conn.execute("ALTER TABLE events ADD COLUMN transcript_path TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists (the old database was upgraded once already)
    try:
        conn.execute("ALTER TABLE session_always_allow ADD COLUMN expires_at TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists (the old database was upgraded once already)
    try:
        conn.execute("ALTER TABLE pending_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'confirm'")
    except sqlite3.OperationalError:
        pass  # column already exists (the old database was upgraded once already)
    try:
        conn.execute("ALTER TABLE pending_approvals ADD COLUMN resolved_value TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists (the old database was upgraded once already)
    return conn


def log_event(session_id, source, tool_name, detail, cwd, risk, matched_rule, decision, transcript_path=None):
    conn = _connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO events "
                "(ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail, transcript_path) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    session_id,
                    source,
                    tool_name,
                    cwd,
                    risk,
                    matched_rule,
                    decision,
                    json.dumps(detail, ensure_ascii=False, default=str),
                    transcript_path,
                ),
            )
    finally:
        conn.close()


def iter_hook_pre_events():
    """Yield every PreToolUse event in ascending id order: (id, tool_name, risk, matched_rule, detail, cwd).
    Used by rematch to re-evaluate past events with the current rules after the rules change
    (cwd is needed to re-evaluate workdir rules)."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, tool_name, risk, matched_rule, detail, cwd FROM events WHERE source = 'hook_pre' ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    return rows


def update_event_matches(updates):
    """Bulk-update (risk, matched_rule): updates is [(risk, matched_rule, event_id), ...].
    Only these two columns change. decision is the real allow/block outcome at the time, and a
    rematch does not rewrite history."""
    if not updates:
        return
    conn = _connect()
    try:
        with conn:
            conn.executemany("UPDATE events SET risk = ?, matched_rule = ? WHERE id = ?", updates)
    finally:
        conn.close()


def get_meta(key):
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def claim_meta(key, value):
    """Set meta[key] to value. The claim succeeds (returns True) only if it did not already hold
    that value. When several hook processes notice a rule change at almost the same moment, the
    atomic upsert ensures only one starts the background rematch; the others see rowcount=0 and
    do nothing."""
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS NOT excluded.value",
                (key, value),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def get_latest_session_id():
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT session_id FROM events "
            "WHERE session_id IS NOT NULL AND session_id != '' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def get_transcript_path(session_id):
    """Return the transcript jsonl path most recently recorded for a session (a session should always use the same file)."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT transcript_path FROM events "
            "WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != '' "
            "ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def fetch_recent(limit=50, since_id=0):
    """Return events with id > since_id in ascending id order, for incremental polling such as `tail`."""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (since_id, limit),
        )
        return cur.fetchall()
    finally:
        conn.close()


def fetch_last(limit=200):
    """Return the last N events in descending id order (newest first), for uses such as the cross-check that only care about "what happened recently"."""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return cur.fetchall()
    finally:
        conn.close()


def fetch_by_rule_prefix(prefix, limit=200):
    """Return PreToolUse events whose matched_rule starts with prefix, in descending id order
    (newest first), with the same field order as fetch_recent. `CC-Monitor workdir` uses it to
    list cross-workdir operations."""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events WHERE source = 'hook_pre' AND matched_rule LIKE ? ESCAPE '\\' "
            "ORDER BY id DESC LIMIT ?",
            (prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%", limit),
        )
        return cur.fetchall()
    finally:
        conn.close()


def create_pending_approval(session_id, tool_name, cwd, matched_rule, matched_value, risk, kind="confirm"):
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO pending_approvals "
                "(ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status, kind) "
                "VALUES (?,?,?,?,?,?,?,'pending',?)",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), session_id, tool_name, cwd, matched_rule, matched_value, risk, kind),
            )
            return cur.lastrowid
    finally:
        conn.close()


def resolve_pending_notify(session_id, tool_name, tool_response=None):
    """action='notify' records (AskUserQuestion, for example) cannot be resolved from the tty or the
    web page. The only signal that the wait is over is the matching PostToolUse event actually
    arriving (meaning the user finished choosing in the terminal that triggered it). In theory the
    same tool in the same session may ask several times in quick succession, so only the newest
    'pending' record is marked, and older records that may still be open for other reasons are not
    marked by mistake.

    For AskUserQuestion, tool_response (the tool call's real return value, included with
    PostToolUse) carries `answers`: {question text: the answer the user chose}. It is stored as JSON
    in resolved_value unchanged, so the approval history shows not only what was asked
    (matched_value) but also what the user answered. For other tools, or a tool_response without
    this field, it stays empty; that is not an error.
    """
    resolved_value = None
    if isinstance(tool_response, dict):
        answers = tool_response.get("answers")
        if answers:
            resolved_value = json.dumps(answers, ensure_ascii=False)
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "UPDATE pending_approvals SET status = 'answered', resolved_at = ?, resolved_via = 'post_tool_use', resolved_value = ? "
                "WHERE id = (SELECT id FROM pending_approvals "
                "            WHERE session_id = ? AND tool_name = ? AND kind = 'notify' AND status = 'pending' "
                "            ORDER BY id DESC LIMIT 1)",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), resolved_value, session_id, tool_name),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def poll_approval_status(approval_id):
    conn = _connect()
    try:
        row = conn.execute("SELECT status FROM pending_approvals WHERE id = ?", (approval_id,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def resolve_approval(approval_id, status, via):
    """Mark a pending-approval record with status (allowed/denied/always_allowed/expired).

    WHERE status='pending' is the key: the tty and the Web UI may try to resolve the same record at
    once. Whichever UPDATE lands first gets changes = 1; for the other, status is no longer pending,
    so its UPDATE has no effect. No extra locking is needed; SQLite's own transaction isolation is
    enough.
    """
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_via = ? "
                "WHERE id = ? AND status = 'pending'",
                (status, time.strftime("%Y-%m-%dT%H:%M:%S%z"), via, approval_id),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def is_session_always_allowed(session_id, matched_rule):
    if not session_id or not matched_rule:
        return False
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT expires_at FROM session_always_allow WHERE session_id = ? AND matched_rule = ?",
            (session_id, matched_rule),
        ).fetchone()
        if row is None:
            return False
        expires_at = row[0]
        # An empty expires_at means truly "always allow"; a value means the timed version, compared
        # with the current time as a string. It uses the same strftime format and time zone as the
        # other timestamps in the events table, so a direct comparison works.
        return expires_at is None or expires_at > time.strftime("%Y-%m-%dT%H:%M:%S%z")
    finally:
        conn.close()


def add_session_always_allow(session_id, matched_rule, expires_at=None):
    conn = _connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO session_always_allow (session_id, matched_rule, created_at, expires_at) VALUES (?,?,?,?) "
                "ON CONFLICT(session_id, matched_rule) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at",
                (session_id, matched_rule, time.strftime("%Y-%m-%dT%H:%M:%S%z"), expires_at),
            )
    finally:
        conn.close()


def record_network_connect(ip, port, host):
    """CONNECT event (called each time the probe observes a new connection): insert a row for a
    new address; for a known address, increment connect_count and update host/last_seen (host may
    only now have been reverse-resolved, so fill it in if it was None before).
    """
    conn = _connect()
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with conn:
            conn.execute(
                "INSERT INTO network_traffic (ip, port, host, connect_count, first_seen, last_seen) "
                "VALUES (?,?,?,1,?,?) "
                "ON CONFLICT(ip, port) DO UPDATE SET "
                "host = COALESCE(excluded.host, network_traffic.host), "
                "connect_count = network_traffic.connect_count + 1, "
                "last_seen = excluded.last_seen",
                (ip, port, host, now, now),
            )
    finally:
        conn.close()


def record_network_bytes(ip, port, tx_bytes=0, rx_bytes=0):
    """Byte counts (called by the probe every 2 seconds with totals): added to the existing tx/rx
    totals, not overwritten. This may be the first time this (ip, port) is seen at the byte level
    (the CONNECT record was missed for some reason, or one long-lived connection keeps sending and
    receiving), so this also uses INSERT OR UPDATE and does not assume the row exists.
    """
    conn = _connect()
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with conn:
            conn.execute(
                "INSERT INTO network_traffic (ip, port, tx_bytes, rx_bytes, first_seen, last_seen) "
                "VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(ip, port) DO UPDATE SET "
                "tx_bytes = network_traffic.tx_bytes + excluded.tx_bytes, "
                "rx_bytes = network_traffic.rx_bytes + excluded.rx_bytes, "
                "last_seen = excluded.last_seen",
                (ip, port, tx_bytes, rx_bytes, now, now),
            )
    finally:
        conn.close()


def list_network_traffic(limit=500):
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT ip, port, host, tx_bytes, rx_bytes, connect_count, first_seen, last_seen "
            "FROM network_traffic ORDER BY (tx_bytes + rx_bytes) DESC LIMIT ?",
            (limit,),
        )
        return cur.fetchall()
    finally:
        conn.close()
