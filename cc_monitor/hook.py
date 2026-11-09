import json
import sys

from . import audit_state, notify, policy, rematch, storage


def read_hook_input():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def handle_pre(data):
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path")

    state = audit_state.get_state()
    if state == "stopped":
        # Do not intervene at all: no evaluation, no recording; same as not having this hook installed.
        sys.exit(0)

    rules = policy.load_rules()
    rule, matched_value = policy.evaluate(tool_name, tool_input, rules=rules, cwd=cwd)
    # If the rule set differs from the one used for the last re-evaluation of past events (the
    # user edited rules.json, or an upgrade brought new default rules), start a background process
    # that recomputes matched_rule for past events with the new rules so the Home stats stay accurate.
    rematch.maybe_schedule(rules)
    decision = "allowed"
    risk = "low"
    # Only when our own confirm flow actually ran (a remembered "always allow", or we really asked
    # on the tty/web page this time) have we "taken over" this question. Only then do we print
    # hookSpecificOutput.permissionDecision=allow on stdout so Claude Code skips its own native
    # "Do you want to proceed?" prompt (otherwise a user who clicked "Allow" on our web page would
    # still have to press y in the terminal, and our question would be wasted). When no rule
    # matched, or the rule is log/block, this field is left alone: for tools we did not review,
    # Claude Code's default prompt must still appear. Our hook must not quietly remove that safety net.
    handled_via_confirm = False

    if rule:
        risk = rule["risk"]
        action = rule["action"]
        if state == "paused":
            # Paused (Permissive): evaluate the rule and record it as usual, but never actually block or show a confirmation prompt.
            decision = "allowed"
        elif action == "block":
            decision = "blocked"
        elif action == "confirm":
            # If "always allow" was chosen for this rule earlier in this session, do not ask again.
            # This is remembered per session; another session running the same command is still asked.
            if storage.is_session_always_allowed(session_id, rule["id"]):
                decision = "allowed"
                handled_via_confirm = True
            else:
                approved = notify.confirm(tool_name, rule, matched_value, session_id=session_id, cwd=cwd)
                decision = "allowed" if approved else "blocked"
                handled_via_confirm = approved
        elif action == "notify":
            # Not an allow-or-not question (tools such as AskUserQuestion, where Claude Code itself
            # asks the user something, have no allow/deny meaning at all). We only show on the web
            # page that "something is waiting for you": no blocking, no tty confirmation prompt, and
            # Claude Code's native interaction is unchanged. We just note on the side that this
            # terminal is waiting; the matching PostToolUse clears it automatically (see
            # resolve_pending_notify in handle_post).
            decision = "allowed"
            storage.create_pending_approval(
                session_id=session_id,
                tool_name=tool_name,
                cwd=cwd,
                matched_rule=rule["id"],
                matched_value=matched_value,
                risk=risk,
                kind="notify",
            )
        else:  # "log"
            decision = "allowed"

    storage.log_event(
        session_id=session_id,
        source="hook_pre",
        tool_name=tool_name,
        detail=tool_input,
        cwd=cwd,
        risk=risk,
        matched_rule=rule["id"] if rule else None,
        decision=decision,
        transcript_path=transcript_path,
    )

    if decision == "blocked":
        reason = "[CC-Monitor] Operation blocked (rule: {}): {}".format(rule["id"], matched_value)
        print(reason, file=sys.stderr)
        sys.exit(2)

    if handled_via_confirm:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "CC-Monitor: {} approved".format(rule["id"]),
            }
        }))
    sys.exit(0)


def handle_post(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    tool_response = data.get("tool_response", {})
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path")

    storage.log_event(
        session_id=session_id,
        source="hook_post",
        tool_name=tool_name,
        detail={"input": tool_input, "response": tool_response},
        cwd=cwd,
        risk="info",
        matched_rule=None,
        decision="completed",
        transcript_path=transcript_path,
    )
    # The tool call really finished. If this (session, tool_name) earlier created a kind='notify'
    # "waiting for you" record (for example the AskUserQuestion question was finally answered),
    # mark it handled so it does not stay on AI Approvals forever. This does not depend on whether
    # the tool matched a notify rule: with no matching record this is a no-op, so there is no need
    # to check first whether it is a notify-type tool.
    storage.resolve_pending_notify(session_id, tool_name, tool_response)
    sys.exit(0)


# From a PermissionRequest's tool_input, pick the field that best says "what is about to happen"
# for display on the web page: command for Bash, the path for file tools, url for web fetches, and
# so on. If none is present, show the whole tool_input as JSON. This is separate from
# policy.FIELD_CANDIDATES: that one is for rule matching, this one is display only.
PERMISSION_SUMMARY_FIELDS = ("command", "file_path", "path", "notebook_path", "url", "query", "pattern", "prompt")


def summarize_tool_input(tool_input):
    for key in PERMISSION_SUMMARY_FIELDS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value
    try:
        return json.dumps(tool_input, ensure_ascii=False)[:2000]
    except (TypeError, ValueError):
        return str(tool_input)[:2000]


def handle_permission(data):
    """PermissionRequest event: Claude Code's own permission system decided this tool call needs
    to ask a person (it is about to show the native "Do you want to proceed?"). At PreToolUse time
    we cannot know whether it will ask, so confirm rules alone cannot mirror these native
    confirmation prompts. This event fills that gap: it mirrors the question to AI Approvals in the
    Web UI, and when the web page or terminal answers, it answers for the user through
    hookSpecificOutput.decision. If nobody answers (timeout) or the user hands it back, it exits
    quietly (no JSON output) and Claude Code shows its native prompt as usual; our presence never
    removes that safety net. The docs say exit 2 has no effect for this event; denying only works
    through decision.behavior=deny.
    """
    state = audit_state.get_state()
    if state in ("stopped", "paused"):
        # Stopped: do not intervene at all. Paused: never actually block or prompt; the native prompt shows on its own.
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")

    if storage.is_session_always_allowed(session_id, notify.permission_session_key(tool_name)):
        behavior = "allow"
    else:
        behavior = notify.permission_request(
            tool_name, summarize_tool_input(tool_input), session_id=session_id, cwd=cwd
        )
        if behavior is None:
            sys.exit(0)  # hand back to Claude Code's native confirmation prompt

    # Field shape per the docs: decision.message only means something for deny (it tells the model
    # why it was denied); allow carries no extra fields.
    decision = {"behavior": behavior}
    if behavior == "deny":
        decision["message"] = "CC-Monitor: the user denied this operation in AI Approvals"
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    }))
    sys.exit(0)


# The handlers below are Claude Code's session lifecycle hooks. Unlike PreToolUse/PostToolUse
# (which fire only when a tool is called), these fire whether or not the turn called a tool. They
# are audit records only: no evaluation, no blocking, no confirmation prompt (lifecycle events have
# no allow/deny meaning and no notion of an action). They stay out only when state=="stopped"
# (auditing fully off), the same standard as handle_post: in the paused (Permissive) state they
# still record as usual; only handle_pre's confirm/block does not actually block.


def handle_user_prompt_submit(data):
    """The raw input the user submitted with Enter. This is the only hook that shows what the user
    actually asked Claude to do. The audit log used to hold only tool-call records, so turns that
    were pure chat and called no tool left no trace at all. This handler only records; it does no
    rule matching or blocking, since there is no allow/deny for what users type in their own terminal.
    """
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_prompt",
        tool_name="UserPromptSubmit",
        detail={"prompt": data.get("prompt", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="submitted",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_session_start(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SessionStart",
        detail={"source": data.get("source", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_session_end(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SessionEnd",
        detail={"reason": data.get("reason", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_pre_compact(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="PreCompact",
        detail={
            "trigger": data.get("trigger", ""),
            "custom_instructions": data.get("custom_instructions", ""),
        },
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_stop(data, subagent=False):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SubagentStop" if subagent else "Stop",
        detail={"stop_hook_active": data.get("stop_hook_active", False)},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "pre"
    try:
        data = read_hook_input()
        if mode == "pre":
            handle_pre(data)
        elif mode == "post":
            handle_post(data)
        elif mode == "permission":
            handle_permission(data)
        elif mode == "prompt":
            handle_user_prompt_submit(data)
        elif mode == "session_start":
            handle_session_start(data)
        elif mode == "session_end":
            handle_session_end(data)
        elif mode == "precompact":
            handle_pre_compact(data)
        elif mode == "stop":
            handle_stop(data)
        elif mode == "subagent_stop":
            handle_stop(data, subagent=True)
        else:
            sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # fail open: never let a bug in the monitor brick Claude Code
        print("[CC-Monitor] Internal hook error; operation allowed: {}".format(exc), file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
