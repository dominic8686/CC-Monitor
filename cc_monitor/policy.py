import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from . import workdir

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
RULES_PATH = CONFIG_DIR / "rules.json"
SNAPSHOT_PATH = CONFIG_DIR / "rules.defaults_snapshot.json"
DEFAULT_RULES_PATH = Path(__file__).parent / "default_rules.json"

FIELD_CANDIDATES = {
    "command": ["command"],
    "file_path": ["file_path", "path", "notebook_path"],
    "url": ["url"],
    # Write uses "content", Edit uses "new_string", NotebookEdit uses "new_source". For all three
    # tools this means "the content about to be written to the file", so a rule that scans content
    # for key formats must accept all three field names, for the same reason file_path above has
    # several candidates.
    "content": ["content", "new_string", "new_source"],
}


def _atomic_write(path, text):
    # The hook starts a separate process for every tool call. If two processes try to change
    # rules.json at once, writing a temp file and then renaming it guarantees readers always see
    # a complete JSON file, never half of one.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, str(path))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _sync_new_default_rules(defaults):
    """Merge rules newly added to default_rules.json into the user's ~/.cc-monitor/rules.json.

    rules.json is a copy made on first run. Rules added by later upgrades (such as history_read)
    used to never reach existing users' files, so "the new version has this rule but never
    detects it". Merge rules:
    - Default rules missing locally are added by id, right after the rule that precedes them in
      the default list (the list is ordered and the first match wins, so position matters).
    - rules.defaults_snapshot.json holds the default list from the last sync. If a local rule is
      identical to its snapshot entry, the user has not changed it, so when the default changes
      (a regex fix, for example) it is replaced with the new one. If it differs from the snapshot
      (the user changed action/pattern), it is never touched.
    - An id missing locally but present in the snapshot was deleted by the user and is not re-added.
    - With no snapshot (the first run after upgrading from an old version) we cannot tell "changed
      by the user" from "old default", so we only add missing rules and leave existing ones alone,
      the most conservative choice."""
    local = _read_json(RULES_PATH)
    if not isinstance(local, list):
        return None
    snapshot = _read_json(SNAPSHOT_PATH)
    snapshot = {r.get("id"): r for r in snapshot if isinstance(r, dict)} if isinstance(snapshot, list) else {}

    local_ids = {r.get("id") for r in local if isinstance(r, dict)}
    changed = False
    insert_at = 0
    for rule in defaults:
        rid = rule.get("id")
        if rid in local_ids:
            idx = next(i for i, r in enumerate(local) if isinstance(r, dict) and r.get("id") == rid)
            insert_at = idx + 1
            if rid in snapshot and local[idx] == snapshot[rid] and rule != snapshot[rid]:
                local[idx] = copy.deepcopy(rule)
                changed = True
            continue
        if rid in snapshot:
            continue
        local.insert(insert_at, copy.deepcopy(rule))
        local_ids.add(rid)
        insert_at += 1
        changed = True

    try:
        if changed:
            _atomic_write(RULES_PATH, json.dumps(local, ensure_ascii=False, indent=2) + "\n")
        if list(snapshot.values()) != defaults:
            _atomic_write(SNAPSHOT_PATH, json.dumps(defaults, ensure_ascii=False, indent=2) + "\n")
    except OSError:
        # For example a read-only config directory: use the merged result in memory this time; the hook keeps running.
        pass
    return local if changed else None


def ensure_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    defaults = _read_json(DEFAULT_RULES_PATH) or []
    if not RULES_PATH.exists():
        _atomic_write(RULES_PATH, DEFAULT_RULES_PATH.read_text(encoding="utf-8"))
        _atomic_write(SNAPSHOT_PATH, DEFAULT_RULES_PATH.read_text(encoding="utf-8"))
        return None
    return _sync_new_default_rules(defaults)


def _fill_display_text(rules):
    """Fill in title/desc for rules that lack them, by id, from the built-in default list (in
    memory only, never written back to the user's rules.json). Rules the user changed are not
    overwritten by _sync_new_default_rules, so they miss text added in newer versions; but an
    approval prompt still needs a plain description, so the display falls back to the default text."""
    defaults = _read_json(DEFAULT_RULES_PATH) or []
    by_id = {r.get("id"): r for r in defaults if isinstance(r, dict)}
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        src = by_id.get(rule.get("id"))
        if not src:
            continue
        for key in ("title", "desc", "title_en", "desc_en"):
            if not rule.get(key) and src.get(key):
                rule[key] = src[key]
    return rules


def load_rules():
    try:
        merged = ensure_config()
    except OSError:
        merged = None
    if merged is not None:
        return _fill_display_text(merged)
    local = _read_json(RULES_PATH)
    if isinstance(local, list):
        return _fill_display_text(local)
    return json.loads(DEFAULT_RULES_PATH.read_text(encoding="utf-8"))


def _extract(tool_input, field):
    for key in FIELD_CANDIDATES.get(field, [field]):
        value = tool_input.get(key)
        if value is not None:
            if isinstance(value, str):
                return value
            # A field that is not a string (AskUserQuestion's questions is a list, for example).
            # Use json.dumps rather than str(): str() gives the Python repr (single quotes,
            # capitalised True/False), which the frontend cannot parse as JSON. Every existing
            # rule's field is a string (command/file_path/url), so this branch does not change
            # their behaviour.
            return json.dumps(value, ensure_ascii=False)
    return None


# ---- "segment" match mode: look only at the start of each subcommand ----
#
# The default match="search" runs re.search over the whole command text, so quoted strings,
# heredoc bodies and grep search terms are all scanned. In a real audit database, all 10 events
# that matched the "System package manager install" rule were commands like `grep "port install"`
# or a python heredoc containing the words "apt install"; not one actually installed software.
# match="segment" splits the command into subcommands at top-level ; & | and newlines (separators
# inside quotes or heredocs do not count), strips wrapper prefixes such as sudo/env/xargs/time and
# the executable's path prefix from each one, then matches from the start with re.match.
# `bash -c "..."` and `osascript ... do shell script "..."`, where the string is the command to run,
# are split again recursively, so an extra layer of quotes does not hide a real install. Same idea
# as splitShellSegments in webui/lib/audit.js.

_WRAPPER_RE = re.compile(
    r"^(?:"
    r"sudo(?:\s+(?:-[ugCDhprtUT]\s+\S+|--\S+|-[A-Za-z]+))*"
    r"|doas(?:\s+-u\s+\S+)?"
    r"|env(?:\s+(?:-\S+|\w+=\S*))*"
    r"|xargs(?:\s+(?:-[InLPdsE]\s*\S+|-\S+))*"
    r"|nice(?:\s+-n\s*\S+)?"
    r"|command|exec|time|nohup|builtin|caffeinate"
    r")\s+"
    # No IGNORECASE: sudo's -H/-E/-i take no argument while -h/-u/-t do; only case sensitivity tells them apart.
)
_ENV_ASSIGN_RE = re.compile(r"^(?:[A-Za-z_]\w*=(?:'[^']*'|\"[^\"]*\"|\S*)\s+)+")
_SHELL_C_RE = re.compile(
    r"^(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-\S+\s+)*-c\s+(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")",
    re.IGNORECASE | re.DOTALL,
)
_OSASCRIPT_RE = re.compile(r"do shell script\s+\"((?:[^\"\\]|\\.)*)\"", re.IGNORECASE | re.DOTALL)
_HEREDOC_RE = re.compile(r"^<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def split_shell_segments(cmd):
    """Split into subcommands at top-level ; & | and newlines; separators inside single/double quotes or a heredoc body do not count."""
    cmd = cmd.replace("\\\n", " ")
    segments = []
    cur = []
    i = 0
    n = len(cmd)
    quote = None
    heredoc_end = None
    while i < n:
        if heredoc_end is not None:
            line_end = cmd.find("\n", i)
            line = cmd[i:] if line_end == -1 else cmd[i:line_end]
            cur.append(line)
            if line.strip() == heredoc_end:
                heredoc_end = None
            if line_end == -1:
                i = n
            else:
                cur.append("\n")
                i = line_end + 1
            continue
        ch = cmd[i]
        if quote:
            cur.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                cur.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            cur.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            cur.append(cmd[i:i + 2])
            i += 2
            continue
        if ch == "<" and cmd[i + 1:i + 2] == "<":
            m = _HEREDOC_RE.match(cmd[i:])
            if m:
                cur.append(m.group(0))
                i += len(m.group(0))
                nl = cmd.find("\n", i)
                if nl == -1:
                    cur.append(cmd[i:])
                    i = n
                else:
                    cur.append(cmd[i:nl + 1])
                    i = nl + 1
                    heredoc_end = m.group(2)
                continue
        if ch in ";&|\n":
            segments.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    if cur:
        segments.append("".join(cur))
    return segments


def _normalize_head(seg):
    """Strip leading brackets, environment variable assignments and wrappers such as
    sudo/env/xargs from a subcommand, then drop the executable's path prefix
    (/opt/local/bin/port -> port)."""
    seg = seg.strip().lstrip("({").strip()
    while True:
        before = seg
        seg = _ENV_ASSIGN_RE.sub("", seg)
        seg = _WRAPPER_RE.sub("", seg)
        if seg == before:
            break
    m = re.match(r"^(\S*/)(\S+)", seg)
    if m:
        seg = seg[len(m.group(1)):]
    return seg


def _unescape(text):
    return re.sub(r"\\(.)", r"\1", text)


def segment_heads(cmd, depth=0):
    """Expand a Bash command into a list of subcommands that match="segment" rules match one by
    one from the start.

    Each subcommand comes in two versions: an "as is" version with only brackets and environment
    variable assignments removed (rules such as sudo_usage need to see sudo itself), and a "bare
    head" version that also strips wrappers such as sudo/env/xargs and the executable's path prefix
    (rules for apt/brew/port need the real command name). If both are the same, only one is given."""
    heads = []
    for raw in split_shell_segments(cmd):
        plain = _ENV_ASSIGN_RE.sub("", raw.strip().lstrip("({").strip())
        head = _normalize_head(raw)
        if not head:
            continue
        if plain and plain != head:
            heads.append(plain)
        heads.append(head)
        if depth >= 3:
            continue
        m = _SHELL_C_RE.match(head)
        if m:
            inner = m.group(1) if m.group(1) is not None else _unescape(m.group(2))
            heads.extend(segment_heads(inner, depth + 1))
            continue
        for om in _OSASCRIPT_RE.finditer(head):
            heads.extend(segment_heads(_unescape(om.group(1)), depth + 1))
    return heads


def rules_fingerprint(rules):
    """Fingerprint of the rule set: it changes whenever the rules' content (including order)
    changes. rematch uses it to tell whether the rules changed since the last re-evaluation,
    instead of comparing file mtimes (an automatic merge rewrite or a manual touch changes the mtime
    of rules.json, but if the content is the same there is no need to re-evaluate)."""
    payload = json.dumps(rules, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def evaluate(tool_name, tool_input, rules=None, cwd=None):
    """Return (rule, matched_value) for the first matching rule, or (None, None).

    matched_value: in search mode, the whole field value that matched; in segment mode, the
    subcommand that matched (with sudo/env and other wrappers stripped), which reads better than the
    whole command in AI Approvals and in block reasons; in workdir mode, the paths outside the
    working directory (home directory folded to ~).
    Without rules, rules.json is read on every call (the hook evaluates one event at a time, so one
    read is fine); rematch evaluates thousands of past events one by one, so it passes a preloaded
    list to avoid rereading the file.
    cwd is Claude Code's current working directory from the hook input. Only match="workdir" rules
    use it; without it (old callers, unit tests) those rules never match."""
    if rules is None:
        rules = load_rules()
    workdir_hits = None  # scan paths at most once per evaluate; all workdir rules share the result
    for rule in rules:
        tools = rule.get("tools", ["*"])
        if "*" not in tools and tool_name not in tools:
            continue
        if rule.get("match") == "workdir":
            # Cross-workdir detection is not a regex: it looks at where a path sits relative to
            # cwd (see workdir.py). A rule picks the category it cares about with scopes
            # (homeDotfile/otherUserHome/system/otherProject) and access (read/write/any);
            # ignore_paths adds an allowlist.
            if not cwd:
                continue
            if workdir_hits is None:
                try:
                    workdir_hits = workdir.scan(tool_name, tool_input, cwd)
                except Exception:
                    workdir_hits = []
            selected = workdir.select(workdir_hits, rule.get("scopes"), rule.get("access"), rule.get("ignore_paths"))
            if selected:
                return rule, workdir.describe(selected)
            continue
        # field="tool_name" is a special case: it matches evaluate()'s tool_name argument itself,
        # not a field in tool_input. An MCP tool call's tool_name is a dynamic string known only
        # at run time (of the form "mcp__<server>__<tool>"), so it cannot be listed in "tools" the
        # way Bash/Write can; only the rule's pattern can recognise the server/tool names in it.
        value = tool_name if rule["field"] == "tool_name" else _extract(tool_input, rule["field"])
        if value is None:
            continue
        try:
            if rule.get("match") == "segment":
                for head in segment_heads(value):
                    if re.match(rule["pattern"], head, re.IGNORECASE):
                        return rule, head
            elif re.search(rule["pattern"], value, re.IGNORECASE):
                return rule, value
        except re.error:
            continue
    return None, None
