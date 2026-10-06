"""Live probe for "Resume with…": do the installed CLIs resume a converted session and send its history?

Builds the made-up sources (tests/xresume_corpus.py) in a temp folder, converts each into the other
agent's session with atlas/convert.py, resumes it in a pty with a temp CLAUDE_CONFIG_DIR / CODEX_HOME
pointed at a local stand-in API, types one prompt and checks the recorded request: the copied
history is there, the pre-compaction turn and thinking/reasoning are not. Nothing touches ~/.claude or
~/.codex, no model is called. `--save` writes sanitized evidence to tests/fixtures/xresume/.

    python3.11 tools/probe_xresume.py [--save] [--keep]
"""
from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(REPO, "tests", "fixtures", "xresume")
ASK = "PROBE-QUESTION which colour was it"
KEY = "sk-ant-api03-probe-" + "x" * 60
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\r")


def standin(requests: list, tool_use=None) -> ThreadingHTTPServer:
    """Anthropic Messages and OpenAI Responses, streamed; every request body is kept.
    tool_use(body) may return {"name", "input"} to answer a Messages request with that tool call."""
    def sse(events):
        return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, body: bytes, ctype="application/json"):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send(b'{"data": [], "models": []}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            requests.append({"path": self.path, "body": body})
            if "count_tokens" in self.path:
                return self._send(b'{"input_tokens": 100}')
            call = tool_use(body) if tool_use and self.path.startswith("/v1/messages") else None
            if call:
                usage = {"input_tokens": 10, "output_tokens": 1}
                return self._send(sse([
                    {"type": "message_start", "message": {"id": "msg_probe_tool", "type": "message",
                                                          "role": "assistant", "model": body.get("model"),
                                                          "content": [], "usage": usage,
                                                          "stop_reason": None, "stop_sequence": None}},
                    {"type": "content_block_start", "index": 0,
                     "content_block": {"type": "tool_use", "id": "toolu_probe_1", "name": call["name"], "input": {}}},
                    {"type": "content_block_delta", "index": 0,
                     "delta": {"type": "input_json_delta", "partial_json": json.dumps(call["input"])}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                     "usage": {"output_tokens": 2}},
                    {"type": "message_stop"}]), "text/event-stream")
            if self.path.startswith("/v1/messages"):
                usage = {"input_tokens": 10, "output_tokens": 1}
                return self._send(sse([
                    {"type": "message_start", "message": {"id": "msg_probe", "type": "message", "role": "assistant",
                                                          "model": body.get("model"), "content": [], "usage": usage,
                                                          "stop_reason": None, "stop_sequence": None}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "PROBE-OK"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                     "usage": {"output_tokens": 2}},
                    {"type": "message_stop"}]), "text/event-stream")
            item = {"type": "message", "role": "assistant", "id": "msg_probe", "status": "completed",
                    "content": [{"type": "output_text", "text": "PROBE-OK", "annotations": []}]}
            usage = {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 2,
                     "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 12}
            self._send(sse([
                {"type": "response.created", "response": {"id": "resp_probe"}},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": "resp_probe", "usage": usage, "output": [item]}}]),
                "text/event-stream")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def drive(cmd: list[str], env: dict, cwd: str, requests: list, timeout: float = 60,
          marks: dict | None = None) -> str:
    """Start the agent, wait for its screen to settle, type the question, wait for the request.
    marks: {text: None} gets the seconds after the start at which each text first showed on screen."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(cmd[0], cmd, env)
    import fcntl
    import struct
    import termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    out, last, start = bytearray(), time.time(), time.time()

    def pump(seconds: float) -> None:
        nonlocal last
        end = time.time() + seconds
        while time.time() < end:
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if b"\x1b[6n" in data:              # a cursor position query: answer it
                    os.write(fd, b"\x1b[1;1R")
                out.extend(data)
                last = time.time()
                for text in marks or {}:
                    if marks[text] is None and text.encode() in out:
                        marks[text] = round(last - start, 2)
    try:
        # Settled: quiet for 3 s (a TUI may redraw forever, so at most half the timeout).
        while time.time() - start < timeout / 2 and (time.time() - last < 3 or len(out) < 200):
            pump(0.5)
        print(f"  {cmd[0]}: started, {len(out)} bytes on screen", flush=True)
        before = len(requests)
        os.write(fd, ASK.encode())
        pump(1.0)
        os.write(fd, b"\r")
        while time.time() - start < timeout:
            pump(0.5)
            if any(ASK in json.dumps(r["body"]) for r in requests[before:]):
                pump(2.0)
                break
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
                pump(0.5)
            except ProcessLookupError:
                break
        os.close(fd)        # an exiting process waits for its tty output to drain: let it go
        os.waitpid(pid, 0)
    return ANSI.sub("", out.decode("utf-8", "replace"))


def history_request(requests: list) -> dict:
    found = [r for r in requests if ASK in json.dumps(r["body"])]
    if not found:
        raise SystemExit("the agent sent no request with the question")
    return found[0]


def texts(body: dict) -> list[dict]:
    """Messages without system prompts, tools or environment blocks: role and text only."""
    out = []
    for m in body.get("messages") or body.get("input") or []:
        content = m.get("content")
        parts = [content] if isinstance(content, str) else [
            c.get("text", "") for c in content or [] if isinstance(c, dict)]
        parts = [p for p in parts if p and "<system-reminder>" not in p and "<environment_context>" not in p
                 and m.get("role") in ("user", "assistant")]
        if parts:
            out.append({"role": m["role"], "type": m.get("type", "message"), "text": "\n".join(parts)})
    return out


def check(name: str, body: dict, corpus) -> list[dict]:
    msgs = texts(body)
    blob = json.dumps(msgs)
    for marker in ("SUMMARY-MARKER", "EARLY-PROMPT-MARKER", "REPLY-MARKER", "OUTPUT-MARKER",
                   "LAST-REPLY-MARKER", "[Continued conversation]"):
        assert marker in blob, f"{name}: {marker} is not in the request"
    for secret in (corpus.BEFORE, *corpus.SECRETS):
        assert secret not in json.dumps(body), f"{name}: {secret} leaked into the request"
    print(f"{name}: the request carries the converted history ({len(msgs)} messages)")
    return msgs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    root = os.path.realpath(tempfile.mkdtemp(prefix="atlas-xresume-"))
    work, claude_home, codex_home = (os.path.join(root, n) for n in ("work", "claude", "codex"))
    for d in (work, claude_home, codex_home):
        os.makedirs(d)
    os.environ.update(ATLAS_HOME=os.path.join(root, "atlas"), ATLAS_PROJECTS_ROOT=os.path.join(claude_home, "projects"),
                      ATLAS_CODEX_HOME=codex_home, CODEX_HOME=codex_home, CLAUDE_CONFIG_DIR=claude_home)
    sys.path.insert(0, REPO)
    from atlas import convert, db, index
    from tests import xresume_corpus as corpus

    requests: list = []
    server = standin(requests)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    with open(os.path.join(claude_home, ".claude.json"), "w") as fh:
        json.dump({"hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5,
                   "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
                   "projects": {work: {"hasTrustDialogAccepted": True}}}, fh)
    with open(os.path.join(codex_home, "config.toml"), "w") as fh:
        fh.write(f'model = "gpt-5.1"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n\n'
                 f'[model_providers.probe]\nname = "probe"\nbase_url = "{base}/v1"\nwire_api = "responses"\n'
                 f'env_key = "ATLAS_PROBE_KEY"\n\n[projects."{work}"]\ntrust_level = "trusted"\n')
    clean = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "SHELL") if k in os.environ}
    clean.update(TERM="xterm-256color", LANG="en_US.UTF-8")
    try:
        corpus.write_claude(os.path.join(claude_home, "projects"), work)
        corpus.write_codex(codex_home, work)
        # Codex already knows a thread (its state database exists), as on a machine in use.
        subprocess.run(["codex", "exec", "--skip-git-repo-check", "warm up"], cwd=work, capture_output=True,
                       stdin=subprocess.DEVNULL, timeout=120,
                       env=dict(clean, CODEX_HOME=codex_home, ATLAS_PROBE_KEY="dummy"))
        conn = db.connect()
        index.index_all(conn)
        to_codex = convert.resume_with(conn, corpus.CLAUDE_ID, "codex")
        to_claude = convert.resume_with(conn, corpus.CODEX_ID, "claude")
        sizes = {p: os.path.getsize(p) for p in (to_codex["path"], to_claude["path"])}

        screen = drive(["claude", "--resume", to_claude["session_id"], "--model", "haiku"],
                       dict(clean, CLAUDE_CONFIG_DIR=claude_home, ANTHROPIC_BASE_URL=base, ANTHROPIC_API_KEY=KEY,
                            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1"),
                       to_claude["cwd"], requests)
        assert "LAST-REPLY-MARKER" in screen, "Claude Code did not show the converted history"
        claude_msgs = check("claude", history_request(requests)["body"], corpus)

        first = len(requests)
        screen = drive(["codex", "resume", to_codex["session_id"], "--no-alt-screen"],
                       dict(clean, CODEX_HOME=codex_home, ATLAS_PROBE_KEY="dummy"), to_codex["cwd"], requests)
        assert "LAST-REPLY-MARKER" in screen, "Codex did not show the converted history"
        codex_msgs = check("codex", history_request(requests[first:])["body"], corpus)

        if args.save:
            save(to_claude, to_codex, sizes, claude_msgs, codex_msgs, work)
        return 0
    finally:
        server.shutdown()
        # Codex leaves an app-server daemon per CODEX_HOME running: the temp home's goes too.
        for line in subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout.splitlines():
            pid, _, command = line.strip().partition(" ")
            if root in command and pid.isdigit():
                os.kill(int(pid), signal.SIGTERM)
        if args.keep:
            print("kept:", root)
        else:
            shutil.rmtree(root, ignore_errors=True)


def _shape(value):
    """Keys and value types only: what the format is, not what was said."""
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_shape(value[0])] if value else []
    return type(value).__name__


def save(to_claude, to_codex, sizes, claude_msgs, codex_msgs, work) -> None:
    os.makedirs(FIXTURES, exist_ok=True)

    def records(path, size):
        with open(path, "rb") as fh:
            data = fh.read()
        return ([json.loads(x) for x in data[:size].splitlines()], [json.loads(x) for x in data[size:].splitlines()])

    out = {}
    for name, res, msgs in (("claude", to_claude, claude_msgs), ("codex", to_codex, codex_msgs)):
        written, appended = records(res["path"], sizes[res["path"]])
        kinds = sorted({(r.get("type"), (r.get("payload") or {}).get("type")) for r in appended},
                       key=lambda k: (str(k[0]), str(k[1])))
        out[name] = {"accepted_records": [_shape(r) for r in written],
                     "appended_kinds": [list(k) for k in kinds],
                     "request_messages": json.loads(json.dumps(msgs).replace(work, "/work"))}
    out["versions"] = {"claude": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
                       "codex": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip()}
    with open(os.path.join(FIXTURES, "evidence.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print("saved", os.path.join(FIXTURES, "evidence.json"))


if __name__ == "__main__":
    sys.exit(main())
