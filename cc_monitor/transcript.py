"""Claude Tap: parse the transcript Claude Code writes locally (~/.claude/projects/.../<session>.jsonl)
and turn the full conversation it actually sent to and received from the model (text, thinking,
tool calls, tool results, token usage) into structured "turn" data for the CLI (`CC-Monitor tap`)
and the Web UI to render.

This is not packet capture or MITM: the transcript is something Claude Code already writes to the
local disk. It is already on this machine, so no TLS traffic needs decrypting.
"""
import json

from . import colors as col
from . import format as fmt


def count_lines(path):
    n = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for _ in f:
                n += 1
    except OSError:
        return 0
    return n


def _normalize_content(content):
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def describe_entry(obj):
    """Turn one raw JSON line from the transcript into {kind, ts, uuid, blocks, usage, model}.
    Unknown line types (summary, file-history-snapshot, etc.) return None and the caller skips them."""
    etype = obj.get("type")
    ts = obj.get("timestamp")
    uuid = obj.get("uuid")

    if etype == "user":
        msg = obj.get("message", {}) or {}
        blocks = _normalize_content(msg.get("content"))
        return {"kind": "user", "ts": ts, "uuid": uuid, "blocks": blocks, "usage": None, "model": None}

    if etype == "assistant":
        msg = obj.get("message", {}) or {}
        blocks = _normalize_content(msg.get("content"))
        return {
            "kind": "assistant",
            "ts": ts,
            "uuid": uuid,
            "blocks": blocks,
            "usage": msg.get("usage"),
            "model": msg.get("model"),
        }

    if etype == "attachment":
        att = obj.get("attachment", {}) or {}
        text = att.get("text")
        if text is None:
            text = json.dumps(att, ensure_ascii=False)[:500]
        return {"kind": "system", "ts": ts, "uuid": uuid, "blocks": [{"type": "text", "text": text}], "usage": None, "model": None}

    return None


def read_entries(path, start_line=0, limit=500):
    """Read from line start_line on (0-based: the number of lines already read) and return at most
    limit parsed entries. Returns (entries, next_line); pass next_line as start_line on the next call
    for an incremental tail."""
    entries = []
    next_line = start_line
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for i, raw in enumerate(f):
                if i < start_line:
                    continue
                next_line = i + 1
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                entry = describe_entry(obj)
                if entry is not None:
                    entries.append(entry)
                if len(entries) >= limit:
                    break
    except OSError:
        pass
    return entries, next_line


KIND_LABEL = {"user": "User", "assistant": "Claude", "system": "System"}
KIND_COLOR = {"user": "cyan", "assistant": "green", "system": "gray"}


def render_entry_cli(entry):
    """Render one entry as terminal text lines (with ANSI colours) for `CC-Monitor tap` to print."""
    kind = entry["kind"]
    lines = []
    header = "[{}] {}".format(
        (entry.get("ts") or "")[:19].replace("T", " "),
        col.c(KIND_LABEL.get(kind, kind), color=KIND_COLOR.get(kind, "gray"), bold=True),
    )
    if kind == "assistant" and entry.get("usage"):
        u = entry["usage"]
        header += "  " + col.c(
            "in={} out={} cache_read={}".format(
                u.get("input_tokens", 0), u.get("output_tokens", 0), u.get("cache_read_input_tokens", 0)
            ),
            dim=True,
        )
    lines.append(header)
    for block in entry["blocks"]:
        lines.extend(_render_block_cli(block))
    return lines


def _render_block_cli(block):
    btype = block.get("type")
    out = []
    if btype == "text":
        text = (block.get("text") or "").strip()
        if text:
            out.append("  " + fmt._collapse(text, 600))
    elif btype == "thinking":
        text = (block.get("thinking") or "").strip()
        shown = text[:300] if text else "(content omitted)"
        out.append("  " + col.c("💭 Thinking: ", dim=True) + col.c(shown, dim=True))
    elif btype == "tool_use":
        name = block.get("name", "?")
        inp = block.get("input", {}) or {}
        prefix = col.c("🔧 Call {}: ".format(name), color="blue", bold=True)
        if name == "Bash" and "command" in inp:
            out.append("  " + prefix + fmt._highlight_bash(fmt._collapse(inp.get("command", ""), 300)))
        else:
            out.append("  " + prefix + fmt._collapse(json.dumps(inp, ensure_ascii=False), 300))
    elif btype == "tool_result":
        content = block.get("content")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        is_error = bool(block.get("is_error"))
        rendered = fmt._highlight_log(fmt._collapse(text, 400))
        prefix = (
            col.c("✗ Tool result (error): ", color="bright_red", bold=True)
            if is_error
            else col.c("✓ Tool result: ", color="green")
        )
        out.append("  " + prefix + rendered)
    elif btype == "image":
        out.append("  " + col.c("🖼 [image content, not shown]", dim=True))
    else:
        out.append("  " + col.c("[{}]".format(btype), dim=True))
    return out
