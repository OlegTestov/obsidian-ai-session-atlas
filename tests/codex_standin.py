"""A stand-in `codex` binary for Codex's own commands: `app-server` (JSON-RPC on stdio),
`delete --force <id>` and `exec` (logs argv, stdin and the output schema; writes STANDIN_REPLY
to `-o`). STANDIN_MODE picks the answer; every run appends one JSON line to
STANDIN_LOG: argv, CODEX_HOME, cwd and the app-server requests ({method, params})."""
from __future__ import annotations

SCRIPT = r'''
import glob, json, os, sys, time
mode = os.environ.get("STANDIN_MODE", "ok")
calls = []
def log():
    with open(os.environ["STANDIN_LOG"], "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "home": os.environ.get("CODEX_HOME"),
                             "cwd": os.getcwd(), "calls": calls}) + "\n")
def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
if sys.argv[1:2] == ["exec"]:
    prompt = sys.stdin.read()
    args = sys.argv[1:]
    schema = args[args.index("--output-schema") + 1] if "--output-schema" in args else None
    with open(os.environ["STANDIN_LOG"], "a") as fh:
        fh.write(json.dumps({"argv": args, "cwd": os.getcwd(), "stdin": prompt,
                             "schema": json.load(open(schema)) if schema else None}) + "\n")
    if mode == "exec_hang":                  # a native codex behind a wrapper, still talking to the model
        import subprocess
        child = subprocess.Popen(["sleep", "60"])
        open(os.environ["STANDIN_LOG"] + ".child", "w").write(str(child.pid))
        time.sleep(60)
    if mode == "exec_too_long":
        sys.stderr.write("ERROR: Codex ran out of room in the model's context window. Start a new thread.\n")
        sys.exit(1)
    if mode == "exec_fails":
        sys.stderr.write("OpenAI Codex v0\nERROR: You've hit your usage limit.\n"); sys.exit(1)
    with open(args[args.index("-o") + 1], "w") as fh:
        fh.write(os.environ.get("STANDIN_REPLY", "PROBE-OK"))
    sys.exit(0)
if sys.argv[1:2] == ["delete"]:
    log()
    if mode == "delete_fails":
        sys.stderr.write("Error: failed to delete session\n"); sys.exit(1)
    if mode == "old":
        sys.stderr.write("error: unrecognized subcommand 'delete'\n"); sys.exit(2)
    home = os.environ["CODEX_HOME"]
    for sub in ("sessions/*/*/*", "archived_sessions"):
        for p in glob.glob(os.path.join(home, sub, "rollout-*-" + sys.argv[-1] + ".jsonl")):
            os.remove(p)
    print("Deleted session " + sys.argv[-1] + ".")
    sys.exit(0)
for line in sys.stdin:
    req = json.loads(line)
    calls.append({"method": req.get("method"), "params": req.get("params")})
    if req.get("method") == "initialize":
        out({"method": "remoteControl/status/changed", "params": {}})
        out({"id": req["id"], "result": {"userAgent": "standin"}})
    elif "id" in req:
        log()
        if mode == "hang":
            time.sleep(60)
        elif mode == "old":
            out({"id": req["id"], "error": {"code": -32601, "message": "method not found"}})
        elif mode == "no_thread":
            out({"id": req["id"], "error": {"code": -32600, "message": "no rollout found for thread id x"}})
        else:
            out({"method": "thread/name/updated", "params": req.get("params")})
            out({"id": req["id"], "result": {}})
'''
