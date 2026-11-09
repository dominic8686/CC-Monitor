"""Cross-workdir detection: does a path touched by this AI tool call lie outside the current project directory?

The rules in default_rules.json are all "a regex on some field", and a regex cannot see the cwd in the
hook input, so it cannot tell where a path sits relative to the current project. This module fills that
gap: it extracts every filesystem path a tool call will access (file tools: read file_path/path
directly; Bash: split into subcommands, recognise paths token by token, track cd), resolves them to
absolute paths, compares them with cwd, and sorts the ones outside the project into tiers by location:

- homeDotfile   : hidden files/directories in the home directory (~/.ssh, ~/.aws, ~/.config, ~/.claude …),
                  where credentials and configuration almost always live
- otherUserHome : another user's home directory (/home/<other>, /Users/<other>, /root)
- system        : system directories (/etc, /usr, /var, /opt, /Library …)
- otherProject  : everything else: other projects under the home directory, /data, /mnt and so on

Each hit is also marked read or write: Write/Edit-type tools, rm/mv/cp targets, tee and redirections
are writes; everything else is a read. Rules with match="workdir" in policy.evaluate() filter this
result by scopes/access, and a hit then goes through log/confirm/block like any other rule.

Places deliberately not reported (reporting them is pure noise):
- The "working directory" is the project root, not the cwd the hook reports: after Claude Code's Bash
  tool cds into a subdirectory, the cwd in the hook follows it (say proj/webui), yet editing
  proj/README.md is still inside the project. We walk up from cwd looking for project markers such as
  .git/.hg/.svn/CLAUDE.md/.claude and take the topmost marked level below the home directory as the
  project root; with no marker at all we fall back to cwd.
- Temporary directories (/tmp, /var/tmp, $TMPDIR, macOS /private/var/folders) and /dev.
- **Reads** in read-only system directories (/usr, /lib*, /bin, /opt, /Library …): running programs,
  loading shared libraries and reading headers all read these places, and reporting them would mean
  hundreds of entries a day; **writes** there are still reported. Same for ~/.cache.
- ~/.claude/projects (Claude Code's own session transcripts, auto-memory and todos); that is part of
  its normal work.
- A subcommand's executable itself living in a system directory (/usr/bin/python3 x.py runs python, it
  does not read it).
- Claude Code's own permissions.additionalDirectories (extra directories the user explicitly allowed).
- Paths listed in a rule's ignore_paths.

Known limitations:
- Claude Code's Bash tool remembers the shell cwd between calls, but the hook only sees the Claude Code
  process's own cwd (the project root). `cd ../x && ...` within one command is tracked; a cd in an
  earlier command followed by a relative path in this one is not recognised, though that cd itself was
  already recorded.
- A path that is literally inside the project counts as inside; symlinks are not followed (a service ->
  /etc/sv link in a rootfs unpacked inside the project is literally a read of project files, and
  following it would falsely flag the whole tree as system directories). Only paths literally outside
  the project go through realpath before being tiered.
"""
import json
import os
import re
import shlex

from pathlib import Path

TIER_HOME_DOTFILE = "homeDotfile"
TIER_OTHER_USER = "otherUserHome"
TIER_SYSTEM = "system"
TIER_OTHER = "otherProject"
ALL_TIERS = (TIER_HOME_DOTFILE, TIER_OTHER_USER, TIER_SYSTEM, TIER_OTHER)

ACCESS_READ = "read"
ACCESS_WRITE = "write"

READ_TOOLS = ("Read", "Glob", "Grep", "LS")
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
FILE_TOOL_FIELDS = ("file_path", "path", "notebook_path")

SYSTEM_ROOTS = (
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/var", "/opt",
    "/proc", "/sys", "/run", "/srv", "/snap", "/nix", "/cores",
    "/System", "/Library", "/Applications", "/private", "/Network", "/Volumes",
)
USER_HOME_PARENTS = ("/home", "/Users")
# Path prefixes never reported: temporary directories and device files. $TMPDIR is added at runtime in _ignored_roots().
DEFAULT_IGNORE = ("/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/dev")
# Paths under the home directory that are never reported (applies to every home directory the session involves)
HOME_IGNORE = (".claude/projects",)
# Read-only system directories: reads here are not reported (running programs, loading libraries, reading headers); writes are still reported as tier system
SYSTEM_READ_QUIET = (
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/snap", "/nix",
    "/System", "/Library", "/Applications",
)
HOME_READ_QUIET = (".cache",)
# Project root markers: walking up from cwd, the topmost marked directory below the home directory is the project root
PROJECT_MARKERS = (".git", ".hg", ".svn", "CLAUDE.md", ".claude")

# When these commands take path arguments, those paths are what gets modified.
WRITE_ALL_CMDS = {
    "rm", "rmdir", "touch", "mkdir", "chmod", "chown", "chgrp", "truncate", "shred", "unlink", "tee",
    "dd", "patch", "chattr", "setfacl", "mkfifo", "mknod",
}
# The last path argument is the target (write); the earlier ones are sources (read).
WRITE_LAST_CMDS = {"cp", "mv", "ln", "rsync", "install", "scp"}
GIT_WRITE_LAST_SUBCMDS = {"clone", "init"}

_REDIRECT_TOKEN_RE = re.compile(r"^(\d*)(>>|>\||>|&>>|&>)(.*)$")
_HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
_OPT_ASSIGN_RE = re.compile(r"^--?[A-Za-z][\w-]*=(.+)$")
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_]\w*=(.*)$")


class Hit(object):
    __slots__ = ("path", "tier", "access")

    def __init__(self, path, tier, access):
        self.path = path
        self.tier = tier
        self.access = access

    @property
    def display(self):
        home = _home()
        if home and (self.path == home or self.path.startswith(home + "/")):
            return "~" + self.path[len(home):]
        return self.path

    def __repr__(self):
        return "Hit({!r}, {}, {})".format(self.path, self.tier, self.access)


def _home():
    return os.path.expanduser("~").rstrip("/") or "/"


def _norm(path):
    return os.path.normpath(path).rstrip("/") or "/"


def _canon(path):
    """Normalisation for comparison: realpath when possible (if cwd and the target are both symlinks,
    both must be resolved to compare correctly). For a path that does not exist realpath is just
    normpath and does not raise. What people are shown is still the _norm() version
    (/etc/os-release must not turn into /usr/lib/os-release)."""
    try:
        return os.path.realpath(path).rstrip("/") or "/"
    except (OSError, ValueError):
        return _norm(path)


def _under(path, root):
    return path == root or path.startswith(root + "/")


def _ignored_roots(extra=None, homes=()):
    roots = list(DEFAULT_IGNORE)
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.append(_canon(tmpdir))
    for home in homes:
        for rel in HOME_IGNORE:
            roots.append(home + "/" + rel)
    for p in extra or ():
        if isinstance(p, str) and p.strip():
            roots.append(_canon(os.path.expanduser(p)))
    return roots


def _read_quiet_roots(homes):
    roots = list(SYSTEM_READ_QUIET)
    for home in homes:
        for rel in HOME_READ_QUIET:
            roots.append(home + "/" + rel)
    return roots


def project_root(cwd):
    """Walk up from cwd to find the project root: the topmost directory below the home directory
    (excluding the home directory itself and /) that carries a PROJECT_MARKERS marker. With no
    marker at all, return cwd itself.
    Topmost rather than nearest: proj/webui may have a subproject marker such as package.json, but
    proj/.git is the boundary of the whole project, and editing proj/README.md must not count as
    leaving it."""
    cwd = _norm(cwd)
    stop = set(_session_homes(cwd) + ["/"])
    best = None
    cur = cwd
    while cur not in stop and cur != "/":
        for marker in PROJECT_MARKERS:
            try:
                if os.path.exists(os.path.join(cur, marker)):
                    best = cur
                    break
            except OSError:
                pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return best or cwd


def _additional_directories(cwd):
    """Claude Code's own permissions.additionalDirectories (--add-dir is stored here too): the user
    has explicitly said "these directories are part of the workspace", so treat them like cwd. Reads
    all three files, project-level and user-level."""
    home = _home()
    candidates = [
        os.path.join(cwd, ".claude", "settings.local.json"),
        os.path.join(cwd, ".claude", "settings.json"),
        os.path.join(home, ".claude", "settings.json"),
    ]
    dirs = []
    for path in candidates:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        extra = (data.get("permissions") or {}).get("additionalDirectories") if isinstance(data, dict) else None
        if isinstance(extra, list):
            for d in extra:
                if isinstance(d, str) and d.strip():
                    dirs.append(_canon(os.path.join(cwd, os.path.expanduser(d))))
    return dirs


def _session_homes(cwd):
    """The directories this session counts as its "own home": the process's HOME, plus the user home
    directory that contains cwd. Usually they are the same; the typical case where they differ is
    claude running as root with the project under /home/<user>. Then /home/<user>/other-proj is
    "another project", not "another user's home directory"."""
    homes = [_home()]
    for parent in USER_HOME_PARENTS:
        if _under(cwd, parent) and cwd != parent:
            user_home = parent + "/" + cwd[len(parent) + 1:].split("/", 1)[0]
            if user_home not in homes:
                homes.append(user_home)
    if _under(cwd, "/root") and "/root" not in homes:
        homes.append("/root")
    return homes


def classify(path, cwd, allowed_roots=(), ignored_roots=None, homes=None):
    """Return the tier of path (a normalised absolute path) relative to cwd; None if it is inside the workspace or ignored."""
    if _under(path, cwd):
        return None
    for root in allowed_roots:
        if _under(path, root):
            return None
    for root in ignored_roots if ignored_roots is not None else _ignored_roots():
        if _under(path, root):
            return None
    homes = homes if homes is not None else _session_homes(cwd)
    for home in homes:
        if _under(path, home):
            rel = path[len(home):].lstrip("/")
            first = rel.split("/", 1)[0]
            return TIER_HOME_DOTFILE if first.startswith(".") else TIER_OTHER
    if path == "/":
        return TIER_SYSTEM
    if _under(path, "/root"):
        return TIER_OTHER_USER
    for parent in USER_HOME_PARENTS:
        if path != parent and _under(path, parent):
            return TIER_OTHER_USER
    for root in SYSTEM_ROOTS:
        if _under(path, root):
            return TIER_SYSTEM
    return TIER_OTHER


def _expand(token, cwd, shell_cwd):
    """Turn a token into an absolute path; return None if it is not recognisable as a path."""
    if not token or "\n" in token or "\t" in token or " " in token:
        return None
    if "://" in token:
        return None
    if token.startswith(("$HOME/", "${HOME}/")) or token in ("$HOME", "${HOME}"):
        token = _home() + token.split("HOME", 1)[1].lstrip("}")
    elif token.startswith(("$PWD/", "${PWD}/")) or token in ("$PWD", "${PWD}"):
        token = shell_cwd + token.split("PWD", 1)[1].lstrip("}")
    elif token.startswith("~"):
        token = os.path.expanduser(token)
        if token.startswith("~"):
            return None
    elif token.startswith("$"):
        return None  # other variables cannot be resolved
    if token.startswith("/"):
        return _norm(token)
    if token in (".", "..") or token.startswith(("./", "../")) or "/" in token:
        if token.startswith("-"):
            return None
        return _norm(os.path.join(shell_cwd, token))
    return None


def _strip_heredoc(seg):
    m = _HEREDOC_RE.search(seg)
    if not m:
        return seg
    nl = seg.find("\n", m.end())
    rest = seg[m.end():] if nl == -1 else seg[m.end():nl]
    return seg[:m.start()] + " " + rest


def _tokens(seg):
    seg = _strip_heredoc(seg)
    try:
        return shlex.split(seg, posix=True)
    except ValueError:
        return seg.split()


def _iter_segments(command, depth=0):
    """Split into subcommands at top-level ; & | and newlines, recursing one level into bash -c "...". Reuses policy's splitter."""
    from . import policy  # deferred import: policy imports this module at module top level

    for raw in policy.split_shell_segments(command):
        head = policy._normalize_head(raw)
        if not head.strip():
            continue
        m = policy._SHELL_C_RE.match(head) if depth < 3 else None
        if m:
            inner = m.group(1) if m.group(1) is not None else policy._unescape(m.group(2))
            for seg in _iter_segments(inner, depth + 1):
                yield seg
            continue
        yield head


def _bash_paths(command, cwd):
    """Return [(abs_path, access, is_exec)] in order of appearance; after a cd within the same
    command, later relative paths are resolved against the new directory."""
    out = []
    shell_cwd = cwd
    for seg in _iter_segments(command):
        toks = _tokens(seg)
        if not toks:
            continue
        cmd = os.path.basename(toks[0])
        args = toks[1:]

        if cmd in ("cd", "pushd"):
            target = next((a for a in args if not a.startswith("-")), None)
            if target is None:
                new_cwd = _home()
            elif target == "-":
                continue
            else:
                new_cwd = _expand(target, cwd, shell_cwd)
                if new_cwd is None:
                    new_cwd = _norm(os.path.join(shell_cwd, target))
            out.append((new_cwd, ACCESS_READ, False))
            shell_cwd = new_cwd
            continue

        exec_path = _expand(toks[0], cwd, shell_cwd) if "/" in toks[0] else None
        if exec_path:
            out.append((exec_path, ACCESS_READ, True))

        write_all = cmd in WRITE_ALL_CMDS
        if cmd in ("sed", "perl") and any(a.startswith("-i") or a == "--in-place" for a in args):
            write_all = True
        if cmd == "find" and "-delete" in args:
            write_all = True
        write_last = cmd in WRITE_LAST_CMDS or (cmd == "git" and args and args[0] in GIT_WRITE_LAST_SUBCMDS)
        tar_extract = tar_create = False
        if cmd == "tar" and args:
            flags = args[0].lstrip("-")
            tar_extract = "x" in flags
            tar_create = "c" in flags

        paths = []  # [(abs_path, is_last_positional_arg)]
        pending_redirect = None
        pending_flag = None
        last_positional = None
        for a in args:
            if not a.startswith("-") and not _REDIRECT_TOKEN_RE.match(a) and a not in ("<", "<<<"):
                last_positional = a
        for a in args:
            if pending_redirect is not None:
                p = _expand(a, cwd, shell_cwd)
                if p:
                    out.append((p, ACCESS_WRITE, False))
                pending_redirect = None
                continue
            if pending_flag is not None:
                flag, pending_flag = pending_flag, None
                p = _expand(a, cwd, shell_cwd)
                if p:
                    if cmd == "tar" and flag == "-C":
                        out.append((p, ACCESS_WRITE if tar_extract else ACCESS_READ, False))
                    elif cmd == "tar" and flag == "-f":
                        out.append((p, ACCESS_WRITE if tar_create else ACCESS_READ, False))
                    elif cmd == "unzip" and flag == "-d":
                        out.append((p, ACCESS_WRITE, False))
                    else:
                        paths.append((p, False))
                continue
            m = _REDIRECT_TOKEN_RE.match(a)
            if m:
                if m.group(3):
                    p = _expand(m.group(3), cwd, shell_cwd)
                    if p:
                        out.append((p, ACCESS_WRITE, False))
                else:
                    pending_redirect = True
                continue
            if a in ("<", "<<<"):
                continue
            if cmd == "tar" and a in ("-C", "-f", "--directory", "--file"):
                pending_flag = "-C" if a in ("-C", "--directory") else "-f"
                continue
            if cmd == "unzip" and a == "-d":
                pending_flag = "-d"
                continue
            if cmd == "git" and a == "-C":
                pending_flag = "-C"
                continue
            if a.startswith("-"):
                om = _OPT_ASSIGN_RE.match(a)
                if om:
                    p = _expand(om.group(1), cwd, shell_cwd)
                    if p:
                        paths.append((p, False))
                continue
            em = _ENV_ASSIGN_RE.match(a)
            if em and not a.startswith("/"):
                p = _expand(em.group(1), cwd, shell_cwd)
                if p:
                    paths.append((p, False))
                continue
            p = _expand(a, cwd, shell_cwd)
            if p:
                paths.append((p, a is last_positional))

        # For "last argument is the target" commands such as cp/mv/ln, the target is the last
        # non-option argument itself, whether or not it looks like a path (the target of
        # `cp /etc/hosts hosts.bak` is hosts.bak; /etc/hosts must not be taken as the written one
        # just because hosts.bak has no slash).
        for p, is_last in paths:
            if write_all or (write_last and is_last):
                out.append((p, ACCESS_WRITE, False))
            else:
                out.append((p, ACCESS_READ, False))
    return out


def scan(tool_name, tool_input, cwd):
    """Return every path in this tool call that falls outside the working directory: [Hit], in order
    of first appearance, one entry per path (write wins over read). If cwd is empty or not absolute
    there is no way to judge, so return [].
    A rule's own ignore_paths allowlist is not applied here: several workdir rules in one evaluate
    share the same scan result, and each one's allowlist is filtered in select()."""
    if not cwd or not isinstance(cwd, str) or not cwd.startswith("/"):
        return []
    if not isinstance(tool_input, dict):
        return []
    cwd = _norm(cwd)
    homes = _session_homes(_canon(cwd))
    # Relative paths resolve against the cwd the hook reports (the shell really is there); "inside the project" is judged against the project root
    root = project_root(cwd)
    root_real = _canon(root)
    allowed = _additional_directories(cwd)
    if root != cwd:
        allowed += _additional_directories(root)
    ignored = _ignored_roots(homes=homes)
    read_quiet = _read_quiet_roots(homes)

    candidates = []
    if tool_name == "Bash":
        command = tool_input.get("command")
        if isinstance(command, str) and command.strip():
            candidates = _bash_paths(command, cwd)
    elif tool_name in READ_TOOLS or tool_name in WRITE_TOOLS:
        access = ACCESS_WRITE if tool_name in WRITE_TOOLS else ACCESS_READ
        for key in FILE_TOOL_FIELDS:
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                p = _expand(value.strip(), cwd, cwd)
                if p is None and not value.startswith("-"):
                    p = _norm(os.path.join(cwd, value.strip()))
                if p:
                    candidates.append((p, access, False))
    else:
        return []

    hits = {}
    order = []
    for path, access, is_exec in candidates:
        # Judge the literal path first: inside the project or an ignored directory ends here, without
        # realpath. Otherwise a freshly created link into a system directory, as in
        # `ln -sf /usr/lib/x.so /tmp/build/x.so`, would resolve to "write to /usr/lib" when the write
        # actually went to /tmp.
        if _under(path, root) or any(_under(path, r) for r in ignored):
            continue
        tier = classify(_canon(path), root_real, allowed_roots=allowed, ignored_roots=ignored, homes=homes)
        if tier is None:
            continue
        if is_exec and tier == TIER_SYSTEM:
            continue  # e.g. /usr/bin/python3 is running a system program, not accessing a system directory
        # Reads in read-only system or cache directories (running programs, loading libraries,
        # reading headers) are harmless. Judged on the literal path without following symlinks:
        # /etc/os-release links to /usr/lib/os-release but is literally in /etc, so it is still reported.
        if access == ACCESS_READ and any(_under(path, r) for r in read_quiet):
            continue
        if path in hits:
            if access == ACCESS_WRITE:
                hits[path].access = ACCESS_WRITE
            continue
        hits[path] = Hit(path, tier, access)
        order.append(path)
    return [hits[p] for p in order]


def select(hits, scopes=None, access=None, ignore_paths=None):
    """Filter scan() results by the rule's scopes (list of tiers), access (read/write/any) and
    ignore_paths (extra allowlist, ~ supported)."""
    scopes = set(scopes) if scopes else set(ALL_TIERS)
    ignored = [_canon(os.path.expanduser(p)) for p in ignore_paths or () if isinstance(p, str) and p.strip()]
    return [
        h for h in hits
        if h.tier in scopes
        and (not access or access == "any" or h.access == access)
        # Compare both the literal path and the realpath: ignore_paths says /etc, but on some
        # distributions /etc/os-release is a symlink to /usr/lib/os-release, so comparing only the
        # realpath would miss it.
        and not any(_under(h.path, root) or _under(_canon(h.path), root) for root in ignored)
    ]


def describe(hits, limit=5):
    shown = [h.display for h in hits[:limit]]
    if len(hits) > limit:
        shown.append("…(+{})".format(len(hits) - limit))
    return ", ".join(shown)
