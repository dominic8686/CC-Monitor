"""System-layer probe (Linux / eBPF).

Independent of Claude Code's hooks: uses bpftrace to trace, directly in the kernel, execve/connect in
the process tree spawned from the `claude` process. Purpose: cross-check whether the application-layer
hooks were bypassed or tampered with. Hooks are self-reported; this is an independent observation
that needs no cooperation from Claude Code, which is why it must run as root.

Usage: sudo python3 -m cc_monitor.probe   (or sudo bin/CC-Monitor-probe)
"""
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from . import colors as col
from . import policy, storage

BT_SCRIPT = Path(__file__).parent / "probe_linux.bt"

# comm values of top-level shells. Used to tell whether an EXEC is an "entry command" (directly
# comparable with the command field of hook_pre) rather than a grandchild spawned by one (say
# python/awk run inside bash -c, which are naturally part of the approved top-level command and need
# no separate alert).
SHELL_COMMS = {"sh", "bash", "zsh", "dash", "ksh"}

# The Claude Code CLI's own infrastructure calls (running hooks, status line refresh, terminal size
# probing and so on). These are CLI implementation details, not tool operations the model started,
# so they never appear in hook_pre records and must be excluded, or every tool call would produce a
# few false positives. Extend this list as needed.
INFRA_NOISE_PATTERNS = [
    re.compile(r"CC-Monitor-hook"),
    re.compile(r"ccmon-hook"),  # hook path installed by old versions before the rename; kept for compatibility
    re.compile(r"aimon-hook"),  # hook path left by the earlier project name (AI-Monitor)
    re.compile(r"open-island-hook\.js"),
    re.compile(r"ccstatusline"),
    re.compile(r"herdr-agent-state\.sh"),
    re.compile(r"^ps -o (ppid|tty)="),
    re.compile(r"^stty -F \S+ size"),
]

# The same command seen in the hook layer and the probe layer within this window counts as a match.
CORRELATION_WINDOW_SEC = 15
DNS_CACHE_TTL_SEC = 3600


def _is_infra_noise(command_text):
    return any(p.search(command_text) for p in INFRA_NOISE_PATTERNS)


def _reverse_dns(ip, cache={}):
    now = time.time()
    cached = cache.get(ip)
    if cached and now - cached[1] < DNS_CACHE_TTL_SEC:
        return cached[0]
    try:
        host = socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror, OSError):
        host = None
    cache[ip] = (host, now)
    return host


def _extract_shell_command(argv_line):
    """Extract <command> from an argv such as `bash -c '<command>'`, for comparison with the hook layer."""
    parts = argv_line.split(None, 1)
    if not parts:
        return None
    prog = parts[0].rsplit("/", 1)[-1]
    if prog not in SHELL_COMMS:
        return None
    rest = parts[1] if len(parts) > 1 else ""
    if rest.startswith("-c "):
        cmd = rest[3:]
        return None if _is_infra_noise(cmd) else cmd
    return None


_QUOTE_CHARS = str.maketrans("", "", "'\"")


def _normalize(text):
    """Remove every quote character.

    When the shell wraps the original command in an `eval '<command>'` script and the command itself
    contains single quotes, they are escaped as `'"'"'` (close quote, escaped quote, reopen quote).
    That only changes quote notation, not what the command does. Stripping quotes from both sides
    before comparing keeps this escaping difference from producing false positives.
    """
    return text.translate(_QUOTE_CHARS)


def _find_matching_hook_command(haystack_text, around_ts_epoch):
    """Check whether any recent hook_pre Bash record has its original command contained, whole, in
    the shell invocation text observed this time.

    The search runs the other way round ("is the hook record a substring of the observed text")
    because Claude Code's Bash tool often wraps the user command in a shell snapshot/eval script
    before running it (for example
    `zsh -c "source snapshot.sh && eval '<original command>' < /dev/null && ..."`),
    so the argv text the probe sees is usually longer than, and contains, the hook record's command field.
    """
    if not haystack_text:
        return True  # not a comparable shell -c command (e.g. child processes such as ps/awk); skip comparison
    haystack_norm = _normalize(haystack_text)
    rows = storage.fetch_last(limit=300)
    for row in rows:
        (_id, ts, source, tool_name, _risk, _rule, _decision, detail_raw, _cwd) = row
        if source != "hook_pre" or tool_name != "Bash":
            continue
        try:
            ts_epoch = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if abs(ts_epoch - around_ts_epoch) > CORRELATION_WINDOW_SEC:
            continue
        try:
            hook_cmd = (json.loads(detail_raw).get("command") or "").strip()
        except json.JSONDecodeError:
            continue
        needle = _normalize(hook_cmd[:80])
        if needle and needle in haystack_norm:
            return True
    return False


_recent_exec_seen = {}
DEDUP_WINDOW_SEC = 1.0


def _already_seen(pid, argv_line, now):
    """Skip the same (pid, argv) repeated within a short time; common with high-frequency polling
    processes (such as status line refresh) when the kernel reuses the same pid very quickly."""
    if len(_recent_exec_seen) > 5000:
        _recent_exec_seen.clear()
    key = (pid, argv_line)
    last = _recent_exec_seen.get(key)
    _recent_exec_seen[key] = now
    return last is not None and now - last < DEDUP_WINDOW_SEC


def _handle_exec_line(fields):
    # EXEC \t pid \t uid \t comm \t argv...
    _tag, pid, uid, comm, argv_line = fields[0], fields[1], fields[2], fields[3], fields[4] if len(fields) > 4 else ""
    now = time.time()

    if _already_seen(pid, argv_line, now):
        return

    shell_cmd = _extract_shell_command(argv_line)
    matched = _find_matching_hook_command(shell_cmd, now)

    rule, matched_value = (None, None)
    if shell_cmd:
        rule, matched_value = policy.evaluate("Bash", {"command": shell_cmd})

    risk = rule["risk"] if rule else ("high" if not matched else "info")
    note = "Command does not match any hook record; monitoring may have been bypassed" if not matched else None

    storage.log_event(
        session_id="",
        source="os_exec",
        tool_name=comm,
        detail={
            "pid": pid,
            "uid": uid,
            "argv": argv_line,
            "shell_command": shell_cmd,
            "hook_matched": matched,
            "matched_rule": rule["id"] if rule else None,
            "note": note,
        },
        cwd="",
        risk=risk,
        matched_rule=rule["id"] if rule else ("hook_bypass_suspected" if not matched else None),
        decision="observed",
    )
    if not matched:
        msg = "[CC-Monitor][probe] ⚠ Suspected monitoring bypass: pid={} comm={} command not found in hook records: {}".format(
            pid, comm, (shell_cmd or argv_line)[:200]
        )
        print(col.c(msg, color="bright_red", bold=True), file=sys.stderr)
    elif rule:
        msg = "[CC-Monitor][probe] [{}] pid={} comm={} matched rule {}: {}".format(
            risk, pid, comm, rule["id"], shell_cmd[:200]
        )
        print(col.c(msg, color=col.RISK_COLOR.get(risk, "gray"), bold=(risk == "high")))


def _handle_connect_line(fields):
    # CONNECT \t pid \t uid \t comm \t ip \t port \t dns_query_host
    # dns_query_host is the domain this process actually looked up before connecting, captured by
    # uprobe:libc:getaddrinfo (e.g. "api.anthropic.com"). Far more reliable than reverse DNS on the IP
    # afterwards: many cloud/CDN egress IPs have no PTR record, so a reverse lookup never yields a
    # domain, whereas here the domain is known before the connection happens. Reverse DNS stays as a
    # fallback (in case getaddrinfo was not used, e.g. connecting to a literal IP).
    _tag, pid, uid, comm, ip, port, dns_query_host = fields
    host = dns_query_host or _reverse_dns(ip)
    target = "{} ({})".format(ip, host) if host else ip
    storage.log_event(
        session_id="",
        source="os_net",
        tool_name=comm,
        detail={"pid": pid, "uid": uid, "ip": ip, "port": port, "host": host},
        cwd="",
        risk="info",
        matched_rule=None,
        decision="observed",
    )
    storage.record_network_connect(ip, int(port), host)
    msg = "[CC-Monitor][probe] Network connection: pid={} comm={} -> {}:{}".format(
        pid, col.c(comm, color="cyan"), col.c(target, color="blue"), port
    )
    print(msg)


# bpftrace prints aggregate maps in its own default format, not our tag\tfields layout, so they
# need their own regex, e.g. `@tx_bytes[160.79.104.10, 443]: 725`.
_BYTES_MAP_LINE = re.compile(r"^@(tx_bytes|rx_bytes)\[([^,]+), (\d+)\]: (\d+)$")


def _handle_bytes_line(line):
    m = _BYTES_MAP_LINE.match(line)
    if not m:
        return False
    direction, ip, port, num_bytes = m.groups()
    tx = int(num_bytes) if direction == "tx_bytes" else 0
    rx = int(num_bytes) if direction == "rx_bytes" else 0
    storage.record_network_bytes(ip, int(port), tx_bytes=tx, rx_bytes=rx)
    return True


def run():
    if shutil.which("bpftrace") is None:
        print(
            "Error: bpftrace not found. Install it first (e.g. Debian/Ubuntu: apt install bpftrace). "
            "This probe relies on the Linux kernel's eBPF subsystem; macOS has no equivalent, so it cannot be installed or run there.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not BT_SCRIPT.exists():
        print("Error: probe script not found: {}".format(BT_SCRIPT), file=sys.stderr)
        sys.exit(1)

    print(col.c("[CC-Monitor][probe] Starting system-layer probe (bpftrace), tracing exec/connect in the claude process tree...", color="cyan"))
    proc = subprocess.Popen(
        ["bpftrace", str(BT_SCRIPT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    known_tags = {"READY", "EXEC", "CONNECT"}
    pending = None  # record being assembled (list of fields); the last field may span several lines

    def flush(rec):
        if not rec:
            return
        try:
            if rec[0] == "READY":
                print(col.c("[CC-Monitor][probe] Ready", color="green"))
            elif rec[0] == "EXEC":
                _handle_exec_line(rec)
            elif rec[0] == "CONNECT":
                _handle_connect_line(rec)
        except Exception as exc:  # the probe must never exit because one record failed to parse
            msg = "[CC-Monitor][probe] Error parsing event: {} (record: {})".format(exc, rec)
            print(col.c(msg, color="yellow"), file=sys.stderr)

    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip("\n")
            if not line or line.startswith("Attaching"):
                continue
            # @tx_bytes[...]/@rx_bytes[...] is bpftrace's own default format when print()ing a map:
            # no \t, nothing like the tag\tfields layout of EXEC/CONNECT. It must be recognised
            # and handled before splitting on \t and checking for multi-line continuation, or it
            # would be taken as a continuation line of the EXEC record being assembled and corrupt
            # the command text.
            if _handle_bytes_line(line):
                continue
            fields = line.split("\t")
            if fields[0] in known_tags:
                flush(pending)
                pending = fields
            elif pending is not None:
                # The command itself contains newlines (e.g. a multi-line script) and bpftrace
                # prints them as is; append the line to the last field (argv/command) of the previous
                # record instead of dropping it as a new record.
                pending[-1] = pending[-1] + "\n" + line
        flush(pending)
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()


if __name__ == "__main__":
    run()
