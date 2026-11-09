import argparse
import json
import platform
import sys
import time
from collections import Counter

from . import audit_state
from . import colors as col
from . import format as fmt
from . import policy, rematch, storage, transcript

# Display text for each intervention level. Do not go back to calling it "audit paused": in the
# paused level auditing keeps running and only blocking stops. "Audit paused" makes people think
# recording stopped too (see the module docstring in audit_state.py).
STATE_LABELS = {
    "running": "Enforcing (evaluate + record + block)",
    "paused": "Permissive (observe only: evaluate + record, no blocking, no confirmation prompts)",
    "stopped": "Off (no evaluation, no recording; same as not installed)",
}

DECISION_LABELS = {
    "allowed": "Allowed",
    "blocked": "Blocked",
    "completed": "Completed",
    "observed": "Observed",
}


_ESC = "\033["


def _color_extra_line(line):
    # Lines such as "Result:" / "Output:" were already coloured field by field and keyword by
    # keyword in format.py (error keywords in the output, file paths). Do not wrap the whole line
    # in another colour here: an ANSI reset does not "pop a stack", so the inner reset also clears
    # the outer colour and the result looks messier. Pass those through unchanged and only colour
    # lines that have no colour yet (such as the probe's ⚠/✓ notes).
    if _ESC in line:
        return line
    if line.startswith("⚠"):
        return col.c(line, color="bright_red", bold=True)
    if line.startswith("✓") or "Matches the hook record" in line:
        return col.c(line, color="green")
    return col.c(line, color="gray")


def cmd_tail(args):
    last_id = 0
    print("[CC-Monitor] Watching monitored events live. Press Ctrl+C to exit.")
    try:
        while True:
            rows = storage.fetch_recent(limit=500, since_id=last_id)
            for row in rows:
                (id_, ts, source, tool_name, risk, matched_rule, decision, detail_raw, cwd) = row
                last_id = id_
                try:
                    detail = json.loads(detail_raw) if detail_raw else {}
                except json.JSONDecodeError:
                    detail = {}

                label, summary, extra = fmt.describe(tool_name, source, detail)
                decision_label = DECISION_LABELS.get(decision, decision)
                rule_text = matched_rule or "-"

                print(
                    "{ts} [{risk}] {stage} · {label} → {decision} (rule={rule}) {cwd}".format(
                        ts=col.c(ts, dim=True),
                        risk=col.risk(risk or "-"),
                        stage=col.c(fmt.stage_label(source), dim=True),
                        label=col.c(label, color="cyan", bold=True),
                        decision=col.c(decision_label, color=col.DECISION_COLOR.get(decision), bold=(decision == "blocked")),
                        rule=col.c(rule_text, color="magenta") if matched_rule else col.c(rule_text, dim=True),
                        cwd=col.c("cwd={}".format(cwd), dim=True),
                    )
                )
                if summary:
                    print("    Content: {}".format(summary))
                for line in extra:
                    print("    {}".format(_color_extra_line(line)))
                if args.verbose:
                    print("    {}".format(col.c("Raw data: {}".format(detail_raw), dim=True)))
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def cmd_rules(args):
    print(json.dumps(policy.load_rules(), ensure_ascii=False, indent=2))


def cmd_rematch(args):
    """Re-evaluate every PreToolUse event in the audit database against the rules now in effect
    (see rematch.py). Preview only by default; --apply writes to the database. --quiet is for the
    hook's automatic background run and prints no details."""
    total, changes = rematch.run(apply=args.apply)
    if args.quiet:
        return
    print("Checked {} PreToolUse events; {} would change matched rule or risk level".format(total, len(changes)))
    for event_id, tool_name, old_rule, new_rule, new_risk, summary in changes:
        print("  #{} {} {} -> {} [{}]  {}".format(event_id, tool_name, old_rule or "-", new_rule or "-", new_risk, summary))
    if not changes:
        return
    if args.apply:
        print(col.c("Updated risk/matched_rule on {} events".format(len(changes)), color="green", bold=True))
    else:
        print(col.c("This is only a preview. Add --apply to write to the database.", dim=True))


def cmd_stats(args):
    rows = storage.fetch_recent(limit=1_000_000, since_id=0)
    by_risk = Counter(r[4] for r in rows)
    by_decision = Counter(r[6] for r in rows)
    print("Total events:", len(rows))
    print("By risk level:", dict(by_risk))
    print("By decision:", dict(by_decision))


def cmd_verify(args):
    # Bypass detection compares the execve calls seen by the system-layer probe with the commands
    # the hook layer recorded. Only the Linux bpftrace probe sees execve; the macOS probe uses
    # nettop, covers only the network and never produces execve observations, so the
    # hook_bypass_suspected flag is always empty on macOS. Printing the usual green "No suspicious
    # records" there would tell the user "check passed" when the check never ran. That false sense
    # of safety is worse than not having the feature, so on macOS we state plainly that it is missing.
    if platform.system() == "Darwin":
        print(col.c("This platform (macOS) does not support the execution-layer cross-check.", color="yellow", bold=True))
        print(
            "Bypass detection needs the kernel layer to observe every execve and compare it with the\n"
            "hook records. The system-layer probe on macOS uses nettop, which sees network connections\n"
            "but not command execution (Apple's Endpoint Security Framework needs a signed system\n"
            "extension; see the plan in DESIGN.md). So the absence of an alert here does not mean you\n"
            "are safe: this check does not run on this platform at all."
        )
        print(col.c("Still working: the full hook-layer audit log and the probe's network connection/traffic observation.", dim=True))
        return

    rows = storage.fetch_last(limit=args.limit)
    suspects = [r for r in rows if r[5] == "hook_bypass_suspected"]
    if not suspects:
        print(col.c("No suspicious records: every command the system-layer probe (bpftrace) observed has a matching hook record.", color="green"))
        print(col.c("(This assumes the `sudo CC-Monitor-probe` probe is running; if it is not, this list is always empty.)", dim=True))
        return
    print(col.c("⚠ Found {} commands observed at the system layer with no matching hook-layer record (monitoring may have been bypassed):".format(len(suspects)), color="bright_red", bold=True))
    for row in suspects:
        (_id, ts, _source, tool_name, _risk, _rule, _decision, detail_raw, _cwd) = row
        try:
            detail = json.loads(detail_raw)
        except json.JSONDecodeError:
            detail = {}
        cmd_text = detail.get("shell_command") or detail.get("argv") or ""
        print(
            "  [{ts}] pid={pid} comm={comm} command: {cmd}".format(
                ts=col.c(ts, dim=True),
                pid=detail.get("pid"),
                comm=col.c(str(tool_name), color="cyan"),
                cmd=col.c(cmd_text[:200], color="yellow"),
            )
        )


WORKDIR_RULE_LABELS = {
    "workdir_escape_write_sensitive": "Write · sensitive location (hidden home-dir file / another user's home directory / system directory)",
    "workdir_escape_write_other": "Write · another project directory",
    "workdir_escape_read_sensitive": "Read · sensitive location (hidden home-dir file / another user's home directory)",
    "workdir_escape_read_other": "Read · system directory / another project directory",
}


def cmd_workdir(args):
    """List file operations the AI made outside the current working directory (events that matched a workdir_escape_* rule)."""
    rows = storage.fetch_by_rule_prefix("workdir_escape_", limit=args.limit)
    if not rows:
        print(col.c("No cross-workdir file operations found.", color="green"))
        print(col.c("(Only events that matched a workdir_escape_* rule are counted. Events a more specific rule matched first, such as reading ~/.ssh, count under that rule.)", dim=True))
        return
    by_rule = Counter(r[5] for r in rows)
    print(col.c("Last {} cross-workdir file operations:".format(len(rows)), bold=True))
    for rule, n in by_rule.most_common():
        print("  {} {}".format(col.c(str(n).rjust(5), color="cyan"), WORKDIR_RULE_LABELS.get(rule, rule)))
    print()
    for row in rows:
        (_id, ts, _source, tool_name, risk, matched_rule, decision, detail_raw, cwd) = row
        try:
            detail = json.loads(detail_raw) if detail_raw else {}
        except json.JSONDecodeError:
            detail = {}
        _label, summary, _extra = fmt.describe(tool_name, "hook_pre", detail)
        print(
            "{ts} [{risk}] {tool} → {decision} {rule}  {cwd}".format(
                ts=col.c(ts, dim=True),
                risk=col.risk(risk or "-"),
                tool=col.c(fmt.TOOL_LABELS.get(tool_name, tool_name), color="cyan", bold=True),
                decision=col.c(DECISION_LABELS.get(decision, decision), color=col.DECISION_COLOR.get(decision), bold=(decision == "blocked")),
                rule=col.c(WORKDIR_RULE_LABELS.get(matched_rule, matched_rule), color="magenta"),
                cwd=col.c("cwd={}".format(cwd), dim=True),
            )
        )
        if summary:
            print("    Content: {}".format(summary))


def cmd_tap(args):
    session_id = args.session or storage.get_latest_session_id()
    if not session_id:
        print("No audit events yet, so there is no session to show. Let Claude Code run a few operations and try again.")
        return

    path = storage.get_transcript_path(session_id)
    if not path:
        print(
            "No transcript file found for session {}. The session may have started before the hook was "
            "installed, so no tool call has recorded a transcript_path yet.".format(session_id)
        )
        return

    print(col.c("[CC-Monitor] Session: {}".format(session_id), bold=True))
    print(col.c("[CC-Monitor] Transcript: {}".format(path), dim=True))

    if not args.follow:
        entries, _ = transcript.read_entries(path, start_line=0, limit=args.limit)
        for e in entries:
            for line in transcript.render_entry_cli(e):
                print(line)
        return

    total = transcript.count_lines(path)
    start_line = max(0, total - 20)
    print(col.c("Following live. Press Ctrl+C to exit.", dim=True))
    try:
        while True:
            entries, start_line = transcript.read_entries(path, start_line=start_line, limit=1000)
            for e in entries:
                for line in transcript.render_entry_cli(e):
                    print(line)
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def cmd_audit(args):
    if args.action == "status":
        info = audit_state.get_state_info()
        label = STATE_LABELS.get(info["state"], info["state"])
        print(col.c("Current state: {}".format(label), bold=True))
        if info.get("changedAt"):
            print(col.c("Changed at: {}".format(info["changedAt"]), dim=True))
        return
    state = {
        "start": "running",
        "enforcing": "running",
        # permissive is the preferred name; pause stays so existing users' habits and scripts keep working.
        "permissive": "paused",
        "observe": "paused",
        "pause": "paused",
        "stop": "stopped",
        "off": "stopped",
    }[args.action]
    audit_state.set_state(state)
    print(col.c("Switched to: {}".format(STATE_LABELS[state]), color="green", bold=True))


def main():
    parser = argparse.ArgumentParser(prog="CC-Monitor", description="CC-Monitor: a monitor for Claude Code operations")
    sub = parser.add_subparsers(dest="cmd")

    p_tail = sub.add_parser("tail", help="Watch monitored events live")
    p_tail.add_argument("-v", "--verbose", action="store_true", help="Print event details")
    p_tail.set_defaults(func=cmd_tail)

    p_rules = sub.add_parser("rules", help="Show the rules now in effect")
    p_rules.set_defaults(func=cmd_rules)

    p_rematch = sub.add_parser("rematch", help="Re-evaluate the matched rule of past events with the current rules (preview by default; --apply writes to the database)")
    p_rematch.add_argument("--apply", action="store_true", help="Actually update risk/matched_rule in the database")
    p_rematch.add_argument("--quiet", action="store_true", help="Print no details (used when the hook runs it in the background)")
    p_rematch.set_defaults(func=cmd_rematch)

    p_stats = sub.add_parser("stats", help="Show statistics")
    p_stats.set_defaults(func=cmd_stats)

    p_verify = sub.add_parser("verify", help="Show records the system-layer probe flagged as suspicious (suspected bypass)")
    p_verify.add_argument("--limit", type=int, default=5000, help="Maximum number of past events to check")
    p_verify.set_defaults(func=cmd_verify)

    p_workdir = sub.add_parser("workdir", help="Show file reads and writes the AI made outside the working directory (events that matched a workdir_escape_* rule)")
    p_workdir.add_argument("--limit", type=int, default=100, help="Maximum number of records to show (default 100)")
    p_workdir.set_defaults(func=cmd_workdir)

    p_tap = sub.add_parser("tap", help="Claude Tap: show the full conversation a session sent to and received from the model")
    p_tap.add_argument("--session", help="session id (defaults to the most recently monitored session)")
    p_tap.add_argument("--limit", type=int, default=200, help="Maximum number of entries to show without -f")
    p_tap.add_argument("-f", "--follow", action="store_true", help="Keep following new content, like tail -f")
    p_tap.set_defaults(func=cmd_tap)

    p_audit = sub.add_parser(
        "audit",
        help="Switch the intervention level (Enforcing / Permissive / Off) or show the current level",
    )
    p_audit.add_argument(
        "action",
        choices=[
            "start", "enforcing",
            "permissive", "observe", "pause",
            "stop", "off",
            "status",
        ],
        help=(
            "start/enforcing=block as usual; permissive/observe=observe only, record without blocking or prompting "
            "(pause is its old name and still works); stop/off=do not intervene at all; status=show the current level"
        ),
    )
    p_audit.set_defaults(func=cmd_audit)

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()
