"""System-layer probe (macOS / nettop).

The Linux probe (probe.py) watches execve/connect in the kernel with bpftrace/eBPF. macOS has nothing
like it (Endpoint Security Framework needs a signed system extension; see the plan in DESIGN.md).
This probe uses Apple's built-in `nettop` (/usr/bin/nettop, no root needed) and covers **network**
only: every 2 seconds it samples each connection of the claude process tree (claude itself plus the
bash/curl/node/python... it spawns) and writes the remote IP:port and the upload/download byte deltas
into the same network_traffic table and the same source='os_net' events as the Linux probe, so the
Web UI's Network page, world map and AI trail need no per-platform handling.

What is missing compared with the Linux probe (nettop cannot provide any of it):
- No execve, so the `CC-Monitor verify` cross-check ("compare the hook layer with the probe layer to
  find bypasses") is not available on macOS.
- No getaddrinfo domain capture; domains come only from the reverse DNS fallback (many CDN/cloud
  egress IPs have no PTR record, and then the domain is empty).
- Only "which address the process connected to" is visible: if Claude Code has HTTPS_PROXY set to a
  local proxy, the remote seen here is 127.0.0.1:<proxy port> and the real target is on the proxy's
  side; the Linux probe cannot see through that either.

Usage: python3 -m cc_monitor.probe_darwin   (or bin/CC-Monitor-probe, no sudo needed)
"""
import re
import shutil
import signal
import subprocess
import sys

from . import colors as col
from . import storage
from .probe import _reverse_dns

SAMPLE_INTERVAL_SEC = 2

# CSV from nettop -L: each sample starts with a header line, then "process lines"
# (<name>.<pid>,in,out,), each followed by its connection lines (<proto> <local><-><remote>,in,out,).
# The name column of the header line is empty.
_HEADER_RE = re.compile(r"^,bytes_in,bytes_out,$")
_PROCESS_RE = re.compile(r"^(?P<name>.*)\.(?P<pid>\d+),(?P<rx>\d*),(?P<tx>\d*),$")
_CONN_RE = re.compile(r"^(?P<proto>tcp4|tcp6|udp4|udp6) (?P<local>\S+)<->(?P<remote>\S+),(?P<rx>\d*),(?P<tx>\d*),$")


def _split_endpoint(proto, endpoint):
    """nettop endpoint notation: IPv4 is `1.2.3.4:443`, IPv6 is `2001:db8::1.443` (the port is
    separated by a dot because the colons belong to the address); `*` means unspecified (listening
    socket / unconnected UDP) and is skipped."""
    if endpoint.startswith("*") or endpoint.endswith("*"):
        return None, None
    sep = "." if proto.endswith("6") else ":"
    if sep not in endpoint:
        return None, None
    ip, _, port = endpoint.rpartition(sep)
    if not ip or not port.isdigit():
        return None, None
    return ip, int(port)


def _is_claude_argv(args):
    exe = (args or "").strip().split(None, 1)[0] if args and args.strip() else ""
    return exe.rsplit("/", 1)[-1] == "claude"


def claude_process_tree():
    """Return {pid: (uid, comm)} covering every claude process and all its descendants. Recomputed on
    every sample: child processes (bash/curl...) come and go all the time, and newly started claude
    sessions must be picked up automatically."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,uid=,comm=,args="],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return {}
    procs = {}
    children = {}
    roots = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        pid, ppid, uid, comm = int(parts[0]), int(parts[1]), int(parts[2]), parts[3]
        args = parts[4] if len(parts) > 4 else ""
        procs[pid] = (uid, comm.rsplit("/", 1)[-1])
        children.setdefault(ppid, []).append(pid)
        if _is_claude_argv(args) or comm.rsplit("/", 1)[-1] == "claude":
            roots.append(pid)
    tree = {}
    stack = list(roots)
    while stack:
        pid = stack.pop()
        if pid in tree:
            continue
        tree[pid] = procs.get(pid, (0, "?"))
        stack.extend(children.get(pid, []))
    return tree


class NettopProbe:
    def __init__(self):
        self.seen_conns = set()  # (pid, proto, local, remote): connections already seen, used to detect "new connection"
        self.first_sample = True  # the first sample holds totals, not deltas: record connections only, not bytes
        self.tree = {}
        self.current_pid = None

    def handle_line(self, line):
        line = line.rstrip("\n")
        if _HEADER_RE.match(line):
            # A new sample starts: fetch the process tree again (the order matters: connection lines
            # follow their process line, so the tree must be fresh before this sample's process lines
            # are handled)
            self.tree = claude_process_tree()
            self.current_pid = None
            return
        m = _PROCESS_RE.match(line)
        if m:
            pid = int(m.group("pid"))
            self.current_pid = pid if pid in self.tree else None
            return
        if self.current_pid is None:
            return
        m = _CONN_RE.match(line)
        if not m:
            return
        proto = m.group("proto")
        ip, port = _split_endpoint(proto, m.group("remote"))
        if ip is None:
            return
        rx = int(m.group("rx") or 0)
        tx = int(m.group("tx") or 0)
        key = (self.current_pid, proto, m.group("local"), m.group("remote"))
        if key not in self.seen_conns:
            self.seen_conns.add(key)
            self._on_connect(self.current_pid, ip, port)
        if not self.first_sample and (rx or tx):
            storage.record_network_bytes(ip, port, tx_bytes=tx, rx_bytes=rx)

    def end_of_sample(self):
        self.first_sample = False
        # seen_conns only grows, so it creeps up over time; keys of long-closed connections are useless.
        # Crude but simple: clear it past 10,000 entries; the only cost is that connections still
        # open get one more CONNECT recorded in the next round.
        if len(self.seen_conns) > 10000:
            self.seen_conns.clear()

    def _on_connect(self, pid, ip, port):
        uid, comm = self.tree.get(pid, (0, "?"))
        host = _reverse_dns(ip)
        target = "{} ({})".format(ip, host) if host else ip
        storage.log_event(
            session_id="",
            source="os_net",
            tool_name=comm,
            detail={"pid": str(pid), "uid": str(uid), "ip": ip, "port": str(port), "host": host},
            cwd="",
            risk="info",
            matched_rule=None,
            decision="observed",
        )
        storage.record_network_connect(ip, port, host)
        print("[CC-Monitor][probe] Network connection: pid={} comm={} -> {}:{}".format(
            pid, col.c(comm, color="cyan"), col.c(target, color="blue"), port
        ), flush=True)


def run():
    if not shutil.which("nettop"):
        print("Error: nettop not found (macOS ships it at /usr/bin/nettop)", file=sys.stderr)
        sys.exit(1)
    print(col.c(
        "[CC-Monitor][probe] Starting system-layer probe (macOS nettop), sampling network connections/bytes of the claude process tree every {}s...".format(SAMPLE_INTERVAL_SEC),
        color="cyan",
    ))
    # -n: no reverse lookup (we do it ourselves, with our own cache); -x: raw numbers; -d: delta mode
    # (the first sample is totals, each later one is the delta from the previous); -L 0: sample
    # forever, CSV output. No -p: the process set changes (new sessions/child processes) and nettop
    # fixes -p at startup, so we take the full output and filter by pid ourselves.
    cmd = ["nettop", "-n", "-x", "-d", "-L", "0", "-s", str(SAMPLE_INTERVAL_SEC), "-J", "bytes_in,bytes_out"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    probe = NettopProbe()
    # On kill/system shutdown (SIGTERM) we must still reach the finally below and reap the nettop
    # child, or it becomes an orphan that keeps sampling. The default SIGTERM handling ends the
    # process at once, and finally never runs.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(col.c("[CC-Monitor][probe] Ready (no root needed; Ctrl+C to stop)", color="green"), flush=True)
    try:
        pending_header = False
        for line in proc.stdout:
            if _HEADER_RE.match(line.rstrip("\n")):
                # the previous sample ends here
                if pending_header:
                    probe.end_of_sample()
                pending_header = True
            probe.handle_line(line)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    if proc.returncode not in (None, 0, -15):
        err = (proc.stderr.read() or "").strip()
        print(col.c("[CC-Monitor][probe] nettop exited with code {}: {}".format(proc.returncode, err), color="yellow"), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
