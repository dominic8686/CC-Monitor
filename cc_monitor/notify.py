import os
import platform
import select
import subprocess
import time

from . import storage


def desktop_notify(title, message):
    system = platform.system()
    try:
        if system == "Linux":
            subprocess.run(
                ["notify-send", title, message],
                check=False,
                timeout=2,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif system == "Darwin":
            script = 'display notification "{}" with title "{}"'.format(
                message.replace('"', "'"), title.replace('"', "'")
            )
            subprocess.run(
                ["osascript", "-e", script],
                check=False,
                timeout=2,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        pass


TIMED_ALLOW_MINUTES = {"allowed_10m": 10, "allowed_30m": 30}
ALLOW_STATUSES = ("allowed", "always_allowed") + tuple(TIMED_ALLOW_MINUTES)


def _open_tty():
    """Open the controlling terminal. Return None if there is none (headless/CI); the Web UI path
    still works then.

    It must be unbuffered binary mode. Text mode "r+" wraps the file in a BufferedRandom, which
    requires the underlying file to be seekable when it is built. On Linux, lseek on a tty returns 0
    ("success"); on macOS it returns ESPIPE, so open() raises io.UnsupportedOperation (a subclass of
    OSError). The except swallowed that and tty was always None: Mac users never saw the prompt in
    the terminal and could not type y/N, leaving the web page as the only path. buffering=0 gives a
    raw FileIO, which does not check seekable.
    """
    try:
        return open("/dev/tty", "r+b", buffering=0)
    except OSError:
        return None


def _tty_write(tty, text):
    try:
        tty.write(text.encode("utf-8", "replace"))
    except OSError:
        pass


def _wait_for_decision(approval_id, tty, timeout, parse_answer, timeout_note):
    """Wait on the terminal tty and the Web UI "pending approval" page at the same time and use
    whichever answers first.

    parse_answer(answer_text) -> status or None: turns what was typed in the terminal into a
    pending_approvals.status; None means this input does not count and we keep waiting.
    Returns the status that was finally stored; on timeout returns "expired" (already written to
    the database).
    """
    deadline = time.time() + timeout
    result_status = None
    try:
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            wait_slice = min(1.0, remaining)
            if tty is not None:
                ready, _, _ = select.select([tty], [], [], wait_slice)
                if ready:
                    # Do not use readline(): Claude Code's TUI keeps the terminal in raw mode, so
                    # Enter sends "\r", not "\n". readline would wait forever for a newline that
                    # never comes and freeze the whole polling loop (the web path included). Read
                    # whatever bytes are available and look at the first character. In cooked mode
                    # select is ready only after Enter and we read "y\n"; in raw mode it is ready as
                    # soon as y is typed and we read "y". Both cases are checked the same way.
                    answer = os.read(tty.fileno(), 64).decode("utf-8", "replace").strip().lower()
                    status = parse_answer(answer)
                    if status:
                        storage.resolve_approval(approval_id, status, "tty")
            else:
                time.sleep(wait_slice)
            # Re-read the final status whether or not this round wrote it: the tty and the web
            # page may answer almost at once, so only the result actually stored in the database counts.
            status = storage.poll_approval_status(approval_id)
            if status and status != "pending":
                result_status = status
                break
    finally:
        if tty is not None:
            if result_status is None:
                _tty_write(tty, "\n[CC-Monitor] " + timeout_note + "\n")
            tty.close()

    if result_status is None:
        storage.resolve_approval(approval_id, "expired", "timeout")
        result_status = "expired"
    return result_status


def _remember_session_allow(result_status, session_id, key):
    # allowed_10m/allowed_30m use the same session_always_allow table as "always allow"; the only
    # difference is an expires_at, after which is_session_always_allowed() stops honouring the entry.
    if result_status in ("always_allowed",) + tuple(TIMED_ALLOW_MINUTES) and session_id:
        minutes = TIMED_ALLOW_MINUTES.get(result_status)
        expires_at = (
            time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() + minutes * 60))
            if minutes
            else None
        )
        storage.add_session_always_allow(session_id, key, expires_at=expires_at)


def confirm(tool_name, rule, matched_value, session_id=None, cwd=None, timeout=90):
    """Ask whether to allow this operation. Wait on the terminal tty and the Web UI "pending
    approval" page at the same time and use whichever answers first. Having no tty (headless)
    does not affect the Web UI path at all.

    The timeout is much longer than the old tty-only version (20s): a person has to notice the
    desktop notification or web prompt, open the page, find the entry and click a button, which is
    far slower than typing y in the current terminal. 20s was rarely enough for the web path.

    Returns True (allowed, either "allow once" or "always allow for this session") or False
    (denied or timed out). For "always allow" this function also records session_id+matched_rule
    in session_always_allow, so the caller (hook.py) does not need to.
    """
    # The rule's title/desc (every rule in default_rules.json has them) tell the person what they
    # are being asked to confirm; an id such as git_force_push alone means little to most people.
    # Prefer the English title_en/desc_en, fall back to the Chinese title/desc, and fall back to
    # the id for user-added rules that have neither.
    title = rule.get("title_en") or rule.get("title") or rule["id"]
    desc = rule.get("desc_en") or rule.get("desc") or ""
    desktop_notify("CC-Monitor needs confirmation: {}".format(title), "{}: {}".format(tool_name, matched_value[:80]))
    approval_id = storage.create_pending_approval(
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        matched_rule=rule["id"],
        matched_value=matched_value,
        risk=rule["risk"],
    )

    tty = _open_tty()
    if tty is not None:
        _tty_write(
            tty,
            "\n[CC-Monitor] Confirmation needed: {title}\n"
            "{desc}"
            "Rule: {rule} · Risk: {risk} · Tool: {tool}\nMatched content: {value}\n"
            "Allow? [y/N] (you can also answer in AI Approvals in the Web UI; denied after {timeout}s): ".format(
                title=title,
                desc=("Details: " + desc + "\n") if desc else "",
                rule=rule["id"],
                risk=rule.get("risk", "-"),
                tool=tool_name,
                value=matched_value,
                timeout=timeout,
            ),
        )

    result_status = _wait_for_decision(
        approval_id,
        tty,
        timeout,
        parse_answer=lambda answer: "allowed" if answer[:1] == "y" else "denied",
        timeout_note="Timed out; denied by default",
    )
    _remember_session_allow(result_status, session_id, rule["id"])
    return result_status in ALLOW_STATUSES


def permission_session_key(tool_name):
    """The PermissionRequest path has no rule id, so "always allow" is recorded per tool name
    (later native prompts for this tool in the same session are allowed directly). That is about
    the same granularity as Claude Code's own "don't ask again": per session."""
    return "permission:" + tool_name


def permission_request(tool_name, matched_value, session_id=None, cwd=None, timeout=90):
    """Claude Code is about to show its native "Do you want to proceed?" confirmation prompt
    (the PermissionRequest hook event). Mirror it to AI Approvals in the Web UI; a click on the
    web page answers it for the user.

    Unlike confirm(), this did not come from our rules: Claude Code's own permission system is
    asking. So the fallback when nobody answers is not to deny but to hand the question back to
    Claude Code's native confirmation prompt unchanged (the hook exits quietly and Claude Code shows
    its prompt as usual). Typing y/n in the terminal answers directly; Enter or any other key hands
    it back to the native prompt at once (the person is at the terminal, and the native prompt has
    more options).

    Returns "allow" / "deny" / None (None = hand back to the native confirmation prompt).
    """
    desktop_notify("CC-Monitor: Claude is requesting permission", "{}: {}".format(tool_name, matched_value[:80]))
    approval_id = storage.create_pending_approval(
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        matched_rule=permission_session_key(tool_name),
        matched_value=matched_value,
        risk="low",
        kind="permission",
    )

    tty = _open_tty()
    if tty is not None:
        _tty_write(
            tty,
            "\n[CC-Monitor] Claude Code is requesting permission\n"
            "Tool: {}\nContent: {}\n"
            "Allow? [y/n] (you can also answer in AI Approvals in the Web UI; press Enter or wait {}s to return to Claude Code's native confirmation prompt): ".format(
                tool_name, matched_value, timeout
            ),
        )

    def parse_answer(answer):
        if answer[:1] == "y":
            return "allowed"
        if answer[:1] == "n":
            return "denied"
        return "deferred"

    result_status = _wait_for_decision(
        approval_id, tty, timeout, parse_answer=parse_answer, timeout_note="Timed out; returning to Claude Code's native confirmation prompt"
    )
    _remember_session_allow(result_status, session_id, permission_session_key(tool_name))
    if result_status in ALLOW_STATUSES:
        return "allow"
    if result_status == "denied":
        return "deny"
    return None
