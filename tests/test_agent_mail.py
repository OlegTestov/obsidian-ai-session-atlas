"""Tests for agent-mail: library, CLI and the MCP stdio protocol. Run: python3 -m unittest test_agent_mail.py"""

import datetime
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "atlas", "agent_mail.py")


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = temp.name
        from atlas import agent_mail

        env = patch.dict(os.environ, {"AGENT_MAIL_HOME": self.tmp})
        env.start()
        self.addCleanup(env.stop)
        home = patch.object(agent_mail, "HOME", self.tmp)
        home.start()
        self.addCleanup(home.stop)
        self.m = agent_mail

    def env(self, **kw):
        return dict(os.environ, AGENT_MAIL_HOME=self.tmp, **kw)


class Library(Base):
    def test_send_then_read_once(self):
        self.m.send("claude", "codex", "hello", thread="ux5")
        got = self.m.inbox("codex")
        self.assertEqual([(g["from"], g["text"], g["thread"]) for g in got], [("claude", "hello", "ux5")])
        self.assertEqual(self.m.inbox("codex"), [])  # marked read

    def test_peek_keeps_unread_and_order_is_by_time(self):
        self.m.send("a", "b", "1")
        time.sleep(0.01)
        self.m.send("a", "b", "2")
        self.assertEqual([g["text"] for g in self.m.inbox("b", peek=True)], ["1", "2"])
        self.assertEqual(len(self.m.inbox("b")), 2)

    def test_wait_returns_when_mail_arrives(self):
        threading.Timer(0.6, lambda: self.m.send("a", "b", "late")).start()
        t = time.time()
        got = self.m.inbox("b", wait=5)
        self.assertEqual([g["text"] for g in got], ["late"])
        self.assertLess(time.time() - t, 3)

    def test_bad_names_and_empty_text_are_refused(self):
        for bad in ("", "../x", "A B", "x" * 41):
            with self.assertRaises(ValueError):
                self.m.send("a", bad, "t")
        with self.assertRaises(ValueError):
            self.m.send("a", "b", "  ")

    def test_peers_lists_unread(self):
        self.m.send("claude", "codex", "x")
        rows = {r["name"]: r for r in self.m.peers()}
        self.assertEqual(rows["codex"]["unread"], 1)
        self.assertIsNotNone(rows["claude"]["last_seen"])


class Register(Base):
    def test_register_writes_session_and_peers_show_it(self):
        self.m.register("codex", "01a1eb54-e762-7fa2-92fd-81e593efa0be")
        self.assertEqual(
            (Path(self.tmp) / "codex" / "session").read_text().strip(), "01a1eb54-e762-7fa2-92fd-81e593efa0be"
        )
        self.assertEqual(
            {r["name"]: r["session"] for r in self.m.peers()}["codex"], "01a1eb54-e762-7fa2-92fd-81e593efa0be"
        )
        for bad in ("", "x y", "../../etc"):
            with self.assertRaises(ValueError):
                self.m.register("codex", bad)


class Cli(Base):
    def test_watch_exits_on_mail(self):
        p = subprocess.Popen(
            [sys.executable, SCRIPT, "watch", "claude", "--timeout", "10"],
            env=self.env(),
            stdout=subprocess.PIPE,
            text=True,
        )
        time.sleep(1.2)
        subprocess.run(
            [sys.executable, SCRIPT, "send", "codex", "claude", "step", "6", "done"],
            env=self.env(),
            check=True,
            capture_output=True,
        )
        out, _ = p.communicate(timeout=8)
        self.assertEqual(p.returncode, 0)
        self.assertIn("step 6 done", out)
        self.assertEqual(len(self.m.inbox("claude")), 1)  # watch only peeks


class Mcp(Base):
    def rpc(self, msgs, name="codex"):
        lines = "\n".join(json.dumps(m) for m in msgs) + "\n"
        out = subprocess.run(
            [sys.executable, SCRIPT],
            input=lines,
            env=self.env(AGENT_MAIL_NAME=name),
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout
        return [json.loads(line) for line in out.splitlines() if line.strip()]

    def test_initialize_list_send_inbox(self):
        r = self.rpc(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "t", "version": "0"},
                    },
                },
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "mail_send", "arguments": {"to": "claude", "text": "привет"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "mail_inbox", "arguments": {"as": "claude"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "mail_send", "arguments": {"to": "../etc", "text": "x"}},
                },
            ]
        )
        by = {x["id"]: x for x in r}
        self.assertEqual(by[1]["result"]["serverInfo"]["name"], "agent-mail")
        self.assertEqual(
            {t["name"] for t in by[2]["result"]["tools"]}, {"mail_send", "mail_inbox", "mail_peers", "mail_register"}
        )
        self.assertIn("Sent to claude", by[3]["result"]["content"][0]["text"])
        self.assertIn("from codex", by[4]["result"]["content"][0]["text"])
        self.assertIn("привет", by[4]["result"]["content"][0]["text"])
        self.assertTrue(by[5]["result"]["isError"])
        self.assertNotIn(None, [x.get("id") for x in r])  # no reply to the notification

    def test_send_by_tab_title_over_stdio(self):
        tabs = [
            self.tab("claude", "✳ Проверка отчёта", "1"),
            self.tab("codex", "⠸ Сверка заметок", "2"),
        ]
        self.snapshot(tabs)

        def send(title, text, **kw):
            return ("mail_send", dict(to_title=title, text=text, **kw))

        results = self.calls(
            [
                send("  проверка  ОТЧЁТА ", "request"),
                ("mail_inbox", {"as": tabs[0]["mailbox"]}),
                send("Сверка заметок", "reply", **{"as": "claude"}),
                ("mail_inbox", {"as": tabs[1]["mailbox"]}),
                ("mail_peers", {}),
            ]
        )
        self.assertTrue(all(not r.get("isError") for r in results), results)
        self.assertIn("request", results[1]["content"][0]["text"])
        self.assertIn("reply", results[3]["content"][0]["text"])
        peers = {r["name"]: r for r in json.loads(results[4]["content"][0]["text"])}
        self.assertEqual(peers[tabs[0]["mailbox"]]["title"], tabs[0]["title"])
        self.assertEqual(peers[tabs[1]["mailbox"]]["unread"], 0)
        self.assertFalse(any(Path(self.tmp).glob("atlas-*/session")))

    def test_duplicate_titles_do_not_deliver_and_agent_filter_disambiguates(self):
        claude = self.tab("claude", "✳ Shared title", "1")
        codex = self.tab("codex", "Shared title", "2")
        self.snapshot([claude, codex])
        (result,) = self.calls([("mail_send", {"to_title": "Shared title", "text": "ambiguous"})])
        self.assertTrue(result["isError"])
        for tab in (claude, codex):
            self.assertIn(tab["mailbox"], result["content"][0]["text"])
            self.assertFalse((Path(self.tmp) / tab["mailbox"]).exists())
        (result,) = self.calls([("mail_send", {"to_title": "Shared title", "to_agent": "codex", "text": "selected"})])
        self.assertFalse(result.get("isError"))
        self.assertEqual([m["text"] for m in self.m.inbox(codex["mailbox"])], ["selected"])

    def test_renamed_expired_closed_and_untrusted_routes(self):
        old = self.tab("claude", "Old", "1")
        first = self.snapshot([old])
        renamed = dict(old, title="New")
        other = self.snapshot([renamed, dict(renamed, title="Invalid", mailbox="other")], "2")
        older = time.time() - 10
        os.utime(first, (older, older))
        self.assertEqual(self.m.mailbox_for_title("New"), old["mailbox"])
        self.assertEqual(len(self.m.open_tabs()), 1)
        with self.assertRaisesRegex(ValueError, "no open"):
            self.m.mailbox_for_title("Old")
        earlier = time.time() - self.m.TAB_TTL - 1
        os.utime(first, (earlier, earlier))
        other.unlink()
        other.symlink_to(first)
        self.assertEqual(self.m.open_tabs(), [])
        (result,) = self.calls([("mail_send", {"to_title": "New", "text": "closed"})])
        self.assertTrue(result["isError"])
        self.assertFalse((Path(self.tmp) / old["mailbox"]).exists())

    def test_mcp_reports_usage_limit_on_send_and_on_later_status_check(self):
        claude = self.tab("claude", "Review", "1")
        codex = self.tab("codex", "Build", "2")
        self.snapshot([claude, codex])
        (sent,) = self.calls([("mail_send", {"to_title": "Review", "text": "request"})])
        self.assertIn("Sent to ", sent["content"][0]["text"])
        now = datetime.datetime.now(datetime.timezone.utc)

        def iso(dt):
            return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        next_hour = iso(now + datetime.timedelta(hours=1))
        claude["usage_limit"] = {
            "reset_text": "8:50 PM (Europe/Madrid)",
            "reset_at": next_hour,
            "expires_at": next_hour,
        }
        codex["usage_limit"] = dict(claude["usage_limit"], reset_text="9:30 PM")
        self.snapshot([claude, codex])
        peers, sent = self.calls(
            [
                ("mail_peers", {}),
                ("mail_send", {"to_title": "Build", "text": "reverse direction", "as": "claude"}),
            ]
        )
        rows = {row["name"]: row for row in json.loads(peers["content"][0]["text"])}
        self.assertEqual(
            rows[claude["mailbox"]]["status"],
            {
                "kind": "usage_limit",
                "reset_text": "8:50 PM (Europe/Madrid)",
                "reset_at": next_hour,
            },
        )
        self.assertEqual(rows[claude["mailbox"]]["unread"], 1)
        status = sent["content"][0]["text"]
        self.assertIn("Recipient has reached a usage limit", status)
        self.assertIn("9:30 PM", status)
        self.assertEqual(self.m.inbox(codex["mailbox"])[0]["text"], "reverse direction")
        self.m.register("review-agent", claude["id"])
        self.assertEqual(self.m.recipient_limit("review-agent")["reset_at"], next_hour)

        expired = iso(now - datetime.timedelta(seconds=1))
        claude["usage_limit"]["expires_at"] = expired
        self.snapshot([claude, codex])
        self.assertIsNone(self.m.recipient_limit(claude["mailbox"]))

    def test_send_title_cli(self):
        tab = self.tab("codex", "Сверка заметок", "2")
        self.snapshot([tab])
        result = subprocess.run(
            [sys.executable, SCRIPT, "send-title", "claude", tab["title"], "test"],
            env=self.env(),
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(self.m.inbox(tab["mailbox"])[0]["id"], result.stdout.strip())

    def calls(self, calls):
        return [
            r["result"]
            for r in self.rpc(
                [
                    {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}}
                    for i, (name, args) in enumerate(calls)
                ]
            )
        ]

    @staticmethod
    def tab(agent, title, digit):
        sid = f"00000000-0000-0000-0000-00000000000{digit}"
        prefix = {"claude": "c", "codex": "x"}[agent]
        return {"id": sid, "agent": agent, "title": title, "mailbox": f"atlas-{prefix}-{sid.replace('-', '')}"}

    def snapshot(self, rows, digit="1"):
        folder = Path(self.tmp) / ".atlas-tabs"
        folder.mkdir(exist_ok=True)
        file = folder / f"00000000-0000-0000-0000-00000000000{digit}.json"
        file.write_text(json.dumps(rows), encoding="utf-8")
        return file


if __name__ == "__main__":
    unittest.main()
