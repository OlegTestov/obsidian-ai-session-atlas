#!/usr/bin/env python3
"""agent-mail: a tiny mailbox shared by local agents (Claude Code, Codex, ...).

Messages are JSON files under $AGENT_MAIL_HOME (default ~/.agent-mail):
  <name>/inbox/<time>-<id>.json   unread
  <name>/read/<time>-<id>.json    read
Run as an MCP stdio server (no arguments) or as a CLI:
  agent_mail.py send <from> <to> <text...>
  agent_mail.py send-title <from> <title> <text...>
  agent_mail.py inbox <name> [--wait SECONDS] [--peek]
  agent_mail.py watch <name> [--timeout SECONDS]   exit 0 and print when mail arrives (for background waiters)
  agent_mail.py peers
  agent_mail.py register <name> <session-id>      bind a mailbox to an agent session (a terminal host can then nudge it)
Standard library only; Python 3.8+.
"""

import datetime
import json
import os
import re
import stat
import sys
import time
import unicodedata
import uuid

HOME = os.path.expanduser(os.environ.get("AGENT_MAIL_HOME", "~/.agent-mail"))
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
MAX_TEXT = 100_000
MAX_WAIT = 50  # Codex cancels a tool call after 60 s by default
TAB_DIR = ".atlas-tabs"
TAB_TTL = 30  # Session Atlas refreshes its open-tab snapshots every 5 seconds.
TAB_LIMIT = 2 * 1024 * 1024
UUID_RE = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
TAB_PREFIX = {"claude": "c", "codex": "x"}
TITLE_STATUS = re.compile(r"^[✳◐◓◑◒\u2800-\u28ff] ")


def _name(n):
    n = (n or "").strip().lower()
    if not NAME_RE.match(n):
        raise ValueError(f"bad mailbox name {n!r}: use a-z, 0-9, '.', '_', '-' (max 40)")
    return n


def _dir(name, sub):
    d = os.path.join(HOME, name, sub)
    os.makedirs(d, exist_ok=True)
    return d


def touch(name):
    """Mark a mailbox as present (shown by peers)."""
    _dir(_name(name), "inbox")
    with open(os.path.join(HOME, _name(name), ".seen"), "w") as f:
        f.write(str(time.time()))


def send(sender, to, text, thread=None):
    sender, to = _name(sender), _name(to)
    if not text or not text.strip():
        raise ValueError("empty message")
    if len(text) > MAX_TEXT:
        raise ValueError(f"message longer than {MAX_TEXT} characters")
    now = time.time()
    msg = {
        "id": uuid.uuid4().hex[:12],
        "from": sender,
        "to": to,
        "at": round(now, 3),
        "at_text": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
        "thread": thread,
        "text": text,
    }
    inbox = _dir(to, "inbox")
    fn = f"{int(now * 1000):013d}-{msg['id']}.json"
    tmp = os.path.join(inbox, "." + fn + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(msg, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(inbox, fn))  # atomic: a reader never sees half a file
    touch(sender)
    return msg


def register(name, session_id):
    """Bind a mailbox to a session so a terminal host can prompt the agent to read it."""
    name, sid = _name(name), (session_id or "").strip()
    if not re.match(r"^[A-Za-z0-9-]{8,80}$", sid):
        raise ValueError(f"bad session id {sid!r}")
    touch(name)
    tmp = os.path.join(HOME, name, ".session.tmp")
    with open(tmp, "w") as f:
        f.write(sid + "\n")
    os.replace(tmp, os.path.join(HOME, name, "session"))
    return sid


def _unread(name):
    inbox = _dir(name, "inbox")
    return sorted(f for f in os.listdir(inbox) if f.endswith(".json") and not f.startswith("."))


def inbox(name, wait=0, peek=False):
    name = _name(name)
    touch(name)
    end = time.time() + max(0, min(float(wait or 0), MAX_WAIT))
    files = _unread(name)
    while not files and time.time() < end:
        time.sleep(0.5)
        files = _unread(name)
    out, src, dst = [], _dir(name, "inbox"), _dir(name, "read")
    for f in files:
        try:
            with open(os.path.join(src, f), encoding="utf-8") as fh:
                out.append(json.load(fh))
            if not peek:
                os.replace(os.path.join(src, f), os.path.join(dst, f))
        except (OSError, ValueError):
            continue
    return out


def _title_key(title):
    return unicodedata.normalize("NFC", " ".join(title.split())).casefold()


def _read_snapshot(file):
    fd = os.open(file.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as fh:
        info = os.fstat(fh.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > TAB_LIMIT:
            return None
        if not 0 <= time.time() - info.st_mtime <= TAB_TTL:
            return None
        raw = fh.read(TAB_LIMIT + 1)
    if len(raw) > TAB_LIMIT:
        return None
    return info.st_mtime, json.loads(raw)


def open_tabs():
    """Read the freshest title for each live session advertised by Session Atlas."""
    by_mailbox = {}
    directory = os.path.join(HOME, TAB_DIR)
    try:
        if not stat.S_ISDIR(os.lstat(directory).st_mode):
            return []
        with os.scandir(directory) as files:
            for file in files:
                if not file.name.endswith(".json") or not UUID_RE.fullmatch(file.name[:-5]):
                    continue
                try:
                    snapshot = _read_snapshot(file)
                except (OSError, ValueError):
                    continue
                if not snapshot or not isinstance(snapshot[1], list):
                    continue
                seen, tabs = snapshot
                for tab in tabs:
                    if not isinstance(tab, dict):
                        continue
                    agent, sid, title = tab.get("agent"), tab.get("id"), tab.get("title")
                    if (
                        agent not in ("claude", "codex")
                        or not isinstance(sid, str)
                        or not UUID_RE.fullmatch(sid)
                        or not isinstance(title, str)
                        or not 0 < len(title) <= 1000
                        or not _title_key(title)
                    ):
                        continue
                    mailbox = f"atlas-{TAB_PREFIX[agent]}-{sid.replace('-', '')}"
                    if tab.get("mailbox") != mailbox:
                        continue
                    if mailbox not in by_mailbox or by_mailbox[mailbox][0] <= seen:
                        by_mailbox[mailbox] = (seen, tab)
    except OSError:
        pass
    return [by_mailbox[name][1] for name in sorted(by_mailbox)]


def _matches_title(tab, key):
    visible = _title_key(tab["title"])
    if visible == key:
        return True
    # Both TUIs can prefix the OSC title with an activity symbol.
    return TITLE_STATUS.sub("", visible) == TITLE_STATUS.sub("", key)


def mailbox_for_title(title, agent=None):
    if not isinstance(title, str) or not 0 < len(title) <= 1000 or not _title_key(title):
        raise ValueError("provide the terminal tab title in to_title")
    if agent not in (None, "claude", "codex"):
        raise ValueError("to_agent must be claude or codex")
    key = _title_key(title)
    matches = [tab for tab in open_tabs() if _matches_title(tab, key) and (agent is None or tab["agent"] == agent)]
    if not matches:
        raise ValueError(
            "no open Session Atlas tab with that title; check the title, tab and Wake agents on new mail setting"
        )
    if len(matches) > 1:
        choices = [{"to": tab["mailbox"], "agent": tab["agent"], "session": tab["id"]} for tab in matches]
        raise ValueError(
            "multiple open tabs have that title; ask which session to use. Candidates: "
            + json.dumps(choices, ensure_ascii=False)
        )
    return matches[0]["mailbox"]


def _limit_time(value):
    if not isinstance(value, str) or not re.fullmatch(r"20\d{2}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value):
        return None
    try:
        return datetime.datetime.fromisoformat(value[:-1] + "+00:00").timestamp()
    except ValueError:
        return None


def _visible_limit(tab):
    raw = tab.get("usage_limit")
    if not isinstance(raw, dict):
        return None
    expiry = _limit_time(raw.get("expires_at"))
    if expiry is None or not 0 < expiry - time.time() <= 8 * 86400:
        return None
    reset = _limit_time(raw.get("reset_at"))
    label = raw.get("reset_text")
    if not isinstance(label, str) or not re.fullmatch(r"[A-Za-z0-9 _+:()/\-]{1,80}", label):
        label = None
    return {"kind": "usage_limit", "reset_at": raw["reset_at"] if reset == expiry else None, "reset_text": label}


def recipient_limit(mailbox):
    tabs = open_tabs()
    target = next((tab for tab in tabs if tab["mailbox"] == mailbox), None)
    if target is None:
        try:
            with open(os.path.join(HOME, _name(mailbox), "session"), encoding="utf-8") as binding:
                sid = binding.read(128).strip()
        except (OSError, UnicodeError):
            return None
        matches = [tab for tab in tabs if tab["id"] == sid]
        if len(matches) == 1:
            target = matches[0]
    return _visible_limit(target) if target else None


def _limit_notice(limit):
    if not limit:
        return ""
    when = limit["reset_text"] or limit["reset_at"]
    reset = f" Reported reset: {when}." if when else " No reset time was shown."
    return f" Recipient has reached a usage limit.{reset} The letter is queued; wait rather than resending."


def peers():
    rows = []
    if os.path.isdir(HOME):
        for n in sorted(os.listdir(HOME)):
            if not NAME_RE.match(n):
                continue
            try:
                with open(os.path.join(HOME, n, ".seen"), encoding="utf-8") as file:
                    seen = float(file.read())
            except (OSError, ValueError):
                seen = None
            try:
                with open(os.path.join(HOME, n, "session"), encoding="utf-8") as file:
                    sess = file.read().strip()
            except OSError:
                sess = None
            rows.append(
                {
                    "name": n,
                    "unread": len(_unread(n)),
                    "session": sess,
                    "last_seen": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(seen)) if seen else None,
                }
            )
    by_name = {row["name"]: row for row in rows}
    tabs = open_tabs()
    limits_by_session = {tab["id"]: limit for tab in tabs if (limit := _visible_limit(tab))}
    for row in rows:
        limit = limits_by_session.get(row.get("session"))
        if limit:
            row["status"] = limit
    for tab in tabs:
        name = tab["mailbox"]
        row = by_name.get(name)
        if row is None:
            row = {"name": name, "unread": 0, "last_seen": None}
            rows.append(row)
        row.update(session=tab["id"], title=tab["title"], agent=tab["agent"])
        if limit := _visible_limit(tab):
            row["status"] = limit
    return sorted(rows, key=lambda row: row["name"])


def _fmt(msgs):
    if not msgs:
        return "No new messages."
    return "\n\n".join(
        f"[{m['at_text']}] from {m['from']}"
        + (f" (thread {m['thread']})" if m.get("thread") else "")
        + f" id={m['id']}:\n{m['text']}"
        for m in msgs
    )


# ---------------- MCP stdio server ----------------
TOOLS = [
    {
        "name": "mail_send",
        "description": "Send mail to another local agent. If the user gives a terminal tab title, "
        "copy the title into to_title (including non-English text). Use to only for a known mailbox name. "
        "For multiple matching tabs, ask the user which session to use; never guess. "
        "If a reply is delayed, call mail_peers to check the recipient's usage limit before resending.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Known mailbox name; omit when using to_title"},
                "to_title": {
                    "type": "string",
                    "description": "Title shown on the recipient's open Session Atlas terminal tab",
                },
                "to_agent": {
                    "type": "string",
                    "enum": ["claude", "codex"],
                    "description": "Optional agent filter when the user names the recipient's agent type",
                },
                "text": {"type": "string", "description": "Message text"},
                "thread": {"type": "string", "description": "Optional thread label, e.g. 'ux5'"},
                "as": {"type": "string", "description": "Sender name; defaults to AGENT_MAIL_NAME"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "mail_inbox",
        "description": "Read and mark as read new messages for this agent. "
        "Set wait (seconds, max 50) to wait for a message if none is there yet.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "wait": {"type": "number", "description": "Seconds to wait for the first message (0-50)"},
                "peek": {"type": "boolean", "description": "Do not mark as read"},
                "as": {"type": "string", "description": "Mailbox name; defaults to AGENT_MAIL_NAME"},
            },
        },
    },
    {
        "name": "mail_register",
        "description": "Bind this mailbox to your agent session id, so a terminal host "
        "(the Session Atlas plugin) can type a 'you have mail' nudge into your terminal when you are idle.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Your Claude Code or Codex session id"},
                "as": {"type": "string", "description": "Mailbox name; defaults to AGENT_MAIL_NAME"},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "mail_peers",
        "description": "List mailboxes and open tab titles. Check a recipient here if a reply is delayed. "
        "A status of usage_limit means to wait for the reported reset before expecting a reply.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _me(args):
    me = (args or {}).get("as") or os.environ.get("AGENT_MAIL_NAME")
    if not me:
        raise ValueError("no mailbox name: set AGENT_MAIL_NAME in the MCP config or pass 'as'")
    return _name(me)


def _call(name, args):
    if name == "mail_send":
        to, title = args.get("to"), args.get("to_title")
        if (to is None) == (title is None) or (to is not None and "to_agent" in args):
            raise ValueError("use either to for a mailbox or to_title with optional to_agent")
        recipient = to if to is not None else mailbox_for_title(title, args.get("to_agent"))
        m = send(_me(args), recipient, args.get("text"), args.get("thread"))
        status = _limit_notice(recipient_limit(m["to"]))
        return (
            f"Sent to {m['to']} at {m['at_text']} (id {m['id']})."
            + (status or " If the recipient is slow to reply, check their status with mail_peers.")
        )
    if name == "mail_inbox":
        return _fmt(inbox(_me(args), args.get("wait", 0), bool(args.get("peek"))))
    if name == "mail_register":
        return f"Mailbox {_me(args)} is bound to session {register(_me(args), args.get('session_id'))}."
    if name == "mail_peers":
        return json.dumps(peers(), ensure_ascii=False, indent=1)
    raise ValueError(f"unknown tool {name}")


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
        if rid is None:  # notification
            continue
        if method == "initialize":
            res = {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "agent-mail", "version": "0.1.0"},
            }
        elif method == "tools/list":
            res = {"tools": TOOLS}
        elif method == "tools/call":
            try:
                res = {"content": [{"type": "text", "text": _call(params.get("name"), params.get("arguments") or {})}]}
            except Exception as e:  # report to the agent, keep the server alive
                res = {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}
        elif method == "ping":
            res = {}
        else:
            print(
                json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"no method {method}"}}),
                flush=True,
            )
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": res}, ensure_ascii=False), flush=True)


def main(argv):
    if not argv:
        return serve()
    cmd, rest = argv[0], argv[1:]
    if cmd == "send" and len(rest) >= 3:
        message = send(rest[0], rest[1], " ".join(rest[2:]))
        print(message["id"])
        if notice := _limit_notice(recipient_limit(message["to"])):
            print(notice.strip(), file=sys.stderr)
    elif cmd == "send-title" and len(rest) >= 3:
        try:
            recipient = mailbox_for_title(rest[1])
            print(send(rest[0], recipient, " ".join(rest[2:]))["id"])
            if notice := _limit_notice(recipient_limit(recipient)):
                print(notice.strip(), file=sys.stderr)
        except ValueError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 2
    elif cmd == "inbox" and rest:
        wait = float(rest[rest.index("--wait") + 1]) if "--wait" in rest else 0
        print(_fmt(inbox(rest[0], wait, "--peek" in rest)))
    elif cmd == "watch" and rest:
        name, timeout = _name(rest[0]), float(rest[rest.index("--timeout") + 1]) if "--timeout" in rest else 3600
        end = time.time() + timeout
        while time.time() < end:
            if _unread(name):
                print(_fmt(inbox(name, 0, peek=True)))
                return 0
            time.sleep(1)
        print("no mail")
        return 1
    elif cmd == "register" and len(rest) == 2:
        print(register(rest[0], rest[1]))
    elif cmd == "peers":
        print(json.dumps(peers(), ensure_ascii=False, indent=1))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
