"""Server start, LaunchAgent and `atlas open`. launchd does not inherit the interactive PATH."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import config, db, server


def label() -> str:
    return config.get("service_label")


def plist_path() -> str:
    return os.path.expanduser(f"~/Library/LaunchAgents/{label()}.plist")

PLIST_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python}</string>
    <string>-m</string>
    <string>atlas.cli</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>{workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONPATH</key><string>{workdir}</string>
    <key>HOME</key><string>{home}</string>
    <key>PATH</key><string>{path}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{err}</string>
</dict>
</plist>
"""


def _log_paths() -> tuple[str, str]:
    home = db.atlas_home()
    return os.path.join(home, "server.log"), os.path.join(home, "server.err")


def health(port: int = server.PORT, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def spawn(port: int = server.PORT) -> bool:
    """Starts the server as a separate process when the LaunchAgent is not installed or did not work."""
    out, err = _log_paths()
    workdir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(out, "a") as o, open(err, "a") as e:
        subprocess.Popen(
            [sys.executable, "-m", "atlas.cli", "serve", "--port", str(port)],
            cwd=workdir, stdout=o, stderr=e, start_new_session=True,
            env={**os.environ, "PYTHONPATH": workdir},
        )
    for _ in range(40):
        if health(port):
            return True
        time.sleep(0.25)
    return False


def ensure_running(port: int = server.PORT) -> tuple[bool, str]:
    """A dead server cannot fix itself through the health endpoint, so it is started here."""
    if health(port):
        return True, "already running"
    return (True, "started") if spawn(port) else (False, "failed to start, see server.err")


def open_browser(port: int = server.PORT) -> tuple[bool, str]:
    ok, message = ensure_running(port)
    if not ok:
        return False, message
    subprocess.run(["open", f"http://127.0.0.1:{port}/"], check=False)
    return True, message


def install(port: int = server.PORT) -> str:
    out, err = _log_paths()
    workdir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(os.path.dirname(plist_path()), exist_ok=True)
    with open(plist_path(), "w") as fh:
        fh.write(PLIST_TEMPLATE.format(
            label=label(), python=sys.executable, workdir=workdir,
            home=os.path.expanduser("~"),
            # ~/.local/bin first: claude lives there, and launchd does not inherit the user's PATH.
            path=os.path.expanduser("~/.local/bin")
                 + ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            log=out, err=err))
    subprocess.run(["launchctl", "unload", plist_path()], capture_output=True)
    subprocess.run(["launchctl", "load", plist_path()], check=True, capture_output=True)
    return plist_path()


def uninstall() -> bool:
    if not os.path.exists(plist_path()):
        return False
    subprocess.run(["launchctl", "unload", plist_path()], capture_output=True)
    os.remove(plist_path())
    return True


def status(port: int = server.PORT) -> dict:
    loaded = subprocess.run(["launchctl", "list", label()], capture_output=True, text=True)
    return {
        "plist": plist_path() if os.path.exists(plist_path()) else None,
        "launchagent_loaded": loaded.returncode == 0,
        "health": health(port),
        "url": f"http://127.0.0.1:{port}/",
        "logs": list(_log_paths()),
    }
