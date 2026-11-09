"""Turn the raw tool_input/tool_response captured by the hook into plain, readable event descriptions."""
import re

from . import colors as col

MAX_SUMMARY_LEN = 240
MAX_OUTPUT_LEN = 300

TOOL_LABELS = {
    "Bash": "Run shell command",
    "Write": "Write file",
    "Edit": "Edit file",
    "MultiEdit": "Edit multiple files",
    "NotebookEdit": "Edit notebook",
    "Read": "Read file",
    "Glob": "Find files",
    "Grep": "Search file contents",
    "WebFetch": "Fetch web page",
    "WebSearch": "Web search",
    "Task": "Start subagent",
    "Agent": "Start subagent",
    "TodoWrite": "Update task list",
    "UserPromptSubmit": "User prompt submitted",
    "SessionStart": "Session started",
    "SessionEnd": "Session ended",
    "PreCompact": "Before context compaction",
    "Stop": "Main task finished",
    "SubagentStop": "Subagent finished",
}

STAGE_LABELS = {
    "hook_pre": "About to run",
    "hook_post": "Completed",
    "hook_prompt": "User input",
    "hook_lifecycle": "Lifecycle",
    "os_exec": "Kernel observation",
    "os_net": "Kernel observation",
}


def _collapse(text, limit=MAX_SUMMARY_LEN):
    if text is None:
        return ""
    text = str(text).replace("\r\n", " ⏎ ").replace("\n", " ⏎ ")
    if len(text) > limit:
        return text[:limit] + "...({} chars total, truncated)".format(len(text))
    return text


# Simple syntax highlighting for Bash commands: command names, flags, strings, variables and
# pipe/redirect operators each get their own colour. This is not a full shell parser; it only
# needs to make the structure readable at a glance in the terminal log.
_SHELL_TOKEN_RE = re.compile(
    r"(?P<comment>#[^⏎]*)"
    r"|(?P<dstring>\"(?:[^\"\\]|\\.)*\")"
    r"|(?P<sstring>'[^']*')"
    r"|(?P<var>\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])"
    r"|(?P<op>\|\||&&|;;|>>|<<|[|;&<>])"
    r"|(?P<flag>(?<!\S)--?[A-Za-z][\w-]*)"
    r"|(?P<glyph>⏎)"
    r"|(?P<word>[^\s|;&<>$'\"#]+)"
    r"|(?P<space>\s+)"
    r"|(?P<other>.)"  # Fallback: any single character not covered above (a stray $ / # / quote) so no character is lost
)


def _highlight_bash(text):
    if not col.ENABLED or not text:
        return text
    out = []
    expect_command = True
    for m in _SHELL_TOKEN_RE.finditer(text):
        kind = m.lastgroup
        tok = m.group()
        if kind == "comment":
            out.append(col.c(tok, dim=True))
        elif kind in ("dstring", "sstring"):
            out.append(col.c(tok, color="green"))
        elif kind == "var":
            out.append(col.c(tok, color="yellow"))
        elif kind == "op":
            out.append(col.c(tok, color="magenta", bold=True))
            expect_command = True
        elif kind == "flag":
            out.append(col.c(tok, color="cyan"))
        elif kind == "glyph":
            out.append(col.c(tok, dim=True))
        elif kind == "word":
            if expect_command:
                out.append(col.c(tok, color="blue", bold=True))
                expect_command = False
            else:
                out.append(tok)
        else:  # space
            out.append(tok)
    return "".join(out)


# Simple highlighting for command output and logs. It does not parse any particular format; it only
# colours the strongest signals: error/exception keywords, warning keywords, success keywords and file paths.
_LOG_TOKEN_RE = re.compile(
    r"(?P<error>\b(?:error|exception|traceback|fatal|failed?|panic|denied|refused)\b|错误|异常|失败|拒绝)"
    r"|(?P<warn>\b(?:warn(?:ing)?|deprecated)\b|警告)"
    r"|(?P<ok>\b(?:success(?:ful)?|passed|done|ok)\b|成功|完成)"
    r"|(?P<path>(?:(?<=\s)|^)/[\w./-]+|\b[\w.-]+\.(?:py|js|ts|json|sh|log|txt|md|yaml|yml|c|cpp|h|go|rs)\b)"
    r"|(?P<glyph>⏎)",
    re.IGNORECASE,
)


def _highlight_log(text):
    if not col.ENABLED or not text:
        return text
    out = []
    pos = 0
    for m in _LOG_TOKEN_RE.finditer(text):
        out.append(text[pos:m.start()])
        kind = m.lastgroup
        tok = m.group()
        if kind == "error":
            out.append(col.c(tok, color="bright_red", bold=True))
        elif kind == "warn":
            out.append(col.c(tok, color="yellow"))
        elif kind == "ok":
            out.append(col.c(tok, color="green"))
        elif kind == "path":
            out.append(col.c(tok, color="cyan"))
        elif kind == "glyph":
            out.append(col.c(tok, dim=True))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


def split_detail(source, detail):
    """For PreToolUse the detail is tool_input itself; for PostToolUse it is {input, response}."""
    detail = detail or {}
    if source == "hook_post":
        return detail.get("input", {}) or {}, detail.get("response")
    return detail, None


def stage_label(source):
    return STAGE_LABELS.get(source, source or "-")


def _describe_os_exec(comm, detail):
    detail = detail or {}
    label = "System-layer observation: process exec ({})".format(comm)
    summary = _highlight_bash(_collapse(detail.get("argv", "")))
    extra = []
    if detail.get("shell_command"):
        if detail.get("hook_matched") is False:
            extra.append("⚠ No matching hook record; monitoring may have been bypassed")
        elif detail.get("hook_matched") is True:
            extra.append("✓ Matches the hook record")
    return label, summary, extra


def _describe_os_net(comm, detail):
    detail = detail or {}
    ip = detail.get("ip", "")
    port = detail.get("port", "")
    host = detail.get("host")
    summary = "{}:{}".format(ip, port) + (" ({})".format(host) if host else "")
    return "System-layer observation: network connection ({})".format(comm), summary, []


def describe(tool_name, source, detail):
    """Return (event type label, one-line summary, list of extra info lines)."""
    if source == "os_exec":
        return _describe_os_exec(tool_name, detail)
    if source == "os_net":
        return _describe_os_net(tool_name, detail)

    tool_input, response = split_detail(source, detail)
    label = TOOL_LABELS.get(tool_name, tool_name or "Unknown operation")
    summary = ""
    extra = []

    if tool_name == "Bash":
        summary = _highlight_bash(_collapse(tool_input.get("command", "")))
        if response is not None:
            stderr = (response.get("stderr") or "").strip()
            interrupted = bool(response.get("interrupted"))
            ok = not interrupted and not stderr
            result_text = "Success" if ok else "Failed or had error output"
            extra.append("Result: {}".format(col.c(result_text, color="green" if ok else "bright_red", bold=not ok)))
            tail_src = (response.get("stdout") or "").strip() or stderr
            if tail_src:
                extra.append("Output: {}".format(_highlight_log(_collapse(tail_src[-MAX_OUTPUT_LEN:]))))

    elif tool_name in ("Write", "NotebookEdit"):
        path = tool_input.get("file_path") or tool_input.get("notebook_path", "")
        content = tool_input.get("content") or tool_input.get("new_source", "")
        summary = "{} ({} bytes)".format(path, len(str(content)))

    elif tool_name in ("Edit", "MultiEdit"):
        path = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        new = tool_input.get("new_string", "")
        summary = "{} (-{} / +{} chars)".format(path, len(old), len(new))

    elif tool_name == "Read":
        summary = tool_input.get("file_path", "")

    elif tool_name in ("Glob", "Grep"):
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path")
        summary = pattern + ("  (path: {})".format(path) if path else "")

    elif tool_name == "WebFetch":
        summary = tool_input.get("url", "")

    elif tool_name == "WebSearch":
        summary = tool_input.get("query", "")

    elif tool_name in ("Task", "Agent"):
        summary = tool_input.get("description") or tool_input.get("prompt", "")
        summary = _collapse(summary)

    elif tool_name == "UserPromptSubmit":
        summary = _collapse(tool_input.get("prompt", ""))

    elif tool_name in ("SessionStart", "SessionEnd", "PreCompact"):
        summary = tool_input.get("source") or tool_input.get("reason") or tool_input.get("trigger") or "-"
        if tool_name == "PreCompact" and tool_input.get("custom_instructions"):
            extra.append("Custom compaction instructions: {}".format(_collapse(tool_input["custom_instructions"])))

    elif tool_name in ("Stop", "SubagentStop"):
        summary = "stop_hook_active: {}".format("true" if tool_input.get("stop_hook_active") else "false")

    else:
        for key, value in tool_input.items():
            if value:
                summary = "{}={}".format(key, _collapse(value))
                break

    return label, summary, extra
