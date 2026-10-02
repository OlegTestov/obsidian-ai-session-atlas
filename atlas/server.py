"""Локальный сервер на stdlib. 127.0.0.1 — не граница доверия, поэтому проверок здесь много."""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import actions, active, autoclassify, classify, commands, config, db, delete, enrich, feed, index, launch, limits, messages, plans, relocate, runner, search, stats, touched, uploads
from .messages import msg

HOST, PORT = "127.0.0.1", 8787
UPLOAD_BODY_LIMIT = 15 * 1024 * 1024   # 10 МБ картинки в base64 + запас
STATIC_NAME = re.compile(r"[a-z][a-z0-9-]*\.(js|css)")
STATIC_TYPES = {"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8"}
TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{5,15}(?:Z|[+-][0-9:]{4,5})?")
# Пути, которые зовут модель: при выключенных ИИ-функциях отвечают 403.
LLM_PATHS = {"/api/job", "/api/classify", "/api/auto-classify"}
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}


# Индекс догоняется на каждом открытии и запросе списка: иначе интерфейс показывал каталог
# четырёхдневной давности, пока не нажмёшь «обновить индекс». Проход без изменений — сотые
# доли секунды, но живая сессия дописывается постоянно и перечитывается целиком: 2–5 с.
# Такой проход уходит в фон, ответ получает то, что есть, и флаг — страница перерисуется сама.
CATCHUP_EVERY = 15.0  # чаще не гоняем: поиск шлёт запрос на каждое нажатие
CATCHUP_WAIT = 0.3    # быстрый проход успевает, долгий не держит набор текста
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_catchup_lock = threading.Lock()
_catchup_proc = None
_catchup_at = 0.0


class _Pass:
    """Проход индексатора отдельным процессом: в потоке он забирал GIL, и поиск во время
    прохода отвечал 0.5–0.8 с вместо 0.1."""

    def __init__(self) -> None:
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        self.proc = subprocess.Popen([sys.executable, "-m", "atlas.cli", "index"], cwd=REPO_ROOT,
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def is_alive(self) -> bool:
        if self.proc.poll() is None:
            return True
        if self.proc.returncode:
            err = self.proc.stderr.read().decode(errors="replace") if self.proc.stderr else ""
            print(f"atlas index: код {self.proc.returncode}\n{err}", file=sys.stderr)
            self.proc.returncode = 0  # сообщить один раз
        return False

    def join(self, timeout: float | None = None) -> None:
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            pass


def catch_up() -> bool:
    """Догнать индекс. True — проход ещё идёт в фоне, данные в ответе могут быть старыми."""
    global _catchup_proc, _catchup_at
    with _catchup_lock:
        if _catchup_proc is not None and _catchup_proc.is_alive():
            return True     # чужой проход не ждём: иначе каждое нажатие во время него +0.3 с
        if time.monotonic() - _catchup_at < CATCHUP_EVERY:
            return False
        _catchup_at = time.monotonic()
        current = _catchup_proc = _Pass()
    current.join(CATCHUP_WAIT)
    return current.is_alive()


def runtime_version() -> str | None:
    """Версия сборки, из которой распакован сервер; у запуска из репозитория её нет."""
    try:
        with open(os.path.join(REPO_ROOT, ".version"), encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def csrf_token() -> str:
    """Живёт в файле 0600: страница получает его при отдаче, чужой origin — нет."""
    path = os.path.join(db.atlas_home(), "csrf.token")
    if not os.path.exists(path):
        with open(path, "w") as fh:
            fh.write(secrets.token_urlsafe(32))
        os.chmod(path, 0o600)
    return open(path).read().strip()


def export_destinations(lang: str | None = None) -> dict[str, str]:
    """Allowlist целей экспорта: произвольный путь от страницы не принимается."""
    home = os.path.expanduser("~")
    out = {}
    for label, path in ((msg("export.desktop", lang), os.path.join(home, "Desktop")),
                        (msg("export.documents", lang), os.path.join(home, "Documents"))):
        if os.path.isdir(path):
            out[label] = path
    containers = set(config.workspace_containers())
    for root in config.workspace_roots():
        if root in containers or not os.path.isdir(root):
            continue
        short = "~" + root[len(home):] if root.startswith(home + os.sep) else root
        for name in sorted(os.listdir(root))[:200]:
            full = os.path.join(root, name)
            if os.path.isdir(full) and not name.startswith("."):
                out[f"{short}/{name}"] = full
    return out


# Список активных опрашивают страница (раз в 5 с) и плагин (раз в 10 с). Холодный проход —
# секунды на чтение хвостов транскриптов; параллельные копии делили GIL и шли по 20 с каждая.
# Поэтому проход один на всех, а свежий ответ отдаётся повторно ACTIVE_REUSE_SECONDS.
ACTIVE_REUSE_SECONDS = 2.0
_active_lock = threading.Lock()
_active_cached: dict = {"at": 0.0, "sessions": None}


def active_sessions(conn) -> list[dict]:
    with _active_lock:
        if _active_cached["sessions"] is not None and \
                time.monotonic() - _active_cached["at"] < ACTIVE_REUSE_SECONDS:
            return _active_cached["sessions"]
        sessions = active.list_active(conn)
        _active_cached.update(at=time.monotonic(), sessions=sessions)
        return sessions


def _run_job(job_id: str, session_id: str, artifact_kind: str, backend: str, model: str,
             lang: str = messages.DEFAULT) -> None:
    conn = db.connect()
    try:
        messages.set_lang(lang, remember=False)     # у фонового потока нет своего запроса
        actions.set_job_state(conn, job_id, "running")
        result = enrich.produce(conn, session_id, artifact_kind, job_id,
                                backend=backend, model=model)
        actions.set_job_state(conn, job_id, "done", result=json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        actions.set_job_state(conn, job_id, "failed", error=f"{type(exc).__name__}: {exc}")
    finally:
        conn.close()


def _run_classify(job_id: str, session_ids: list[str], lang: str = messages.DEFAULT) -> None:
    conn = db.connect()
    try:
        messages.set_lang(lang, remember=False)
        actions.set_job_state(conn, job_id, "running")
        result = classify.classify_batch(conn, session_ids, job_id=job_id)
        actions.set_job_state(conn, job_id, "done",
                              result=json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        actions.set_job_state(conn, job_id, "failed", error=f"{type(exc).__name__}: {exc}")
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "SessionAtlas"

    def log_message(self, fmt, *args):  # тише стандартного логгера
        pass

    # --- инфраструктура ответа ---

    def _send(self, code: int, body: bytes, content_type: str, nonce: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # Страница отдаётся с диска: без no-store браузер держит старую разметку
        # после обновления интерфейса и показывает её же после перезагрузки.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        if nonce:
            self.send_header(
                "Content-Security-Policy",
                f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                "img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; "
                # Встраивание только в саму себя и в Obsidian — он живёт на схеме app://.
                "frame-ancestors 'self' app:",
            )
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json")

    def _guard(self, mutating: bool) -> bool:
        if (self.headers.get("Host") or "") not in ALLOWED_HOSTS:
            self._json(403, {"error": msg("server.bad_host")})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self._json(403, {"error": msg("server.foreign_origin")})
            return False
        if mutating:
            if origin is None:
                self._json(403, {"error": msg("server.no_origin")})
                return False
            if self.headers.get("X-Atlas-Token") != csrf_token():
                self._json(403, {"error": msg("server.bad_csrf")})
                return False
        return True

    def _body(self, limit: int = 1_000_000) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    # --- маршруты ---

    def _lang(self) -> None:
        """Язык ответа — язык страницы: заголовок на каждом запросе, без него — английский."""
        messages.set_lang(self.headers.get("X-Atlas-Lang"))

    def do_GET(self) -> None:
        self._lang()
        if not self._guard(mutating=False):
            return
        url = urlparse(self.path)
        query = parse_qs(url.query)
        try:
            if url.path in ("/", "/index.html"):
                catch_up()
                return self._page()
            if url.path.startswith("/static/"):
                return self._static(url.path[len("/static/"):])
            if url.path == "/api/commands":
                return self._json(200, {"commands": commands.all_commands()})
            if url.path == "/health":
                from . import APP
                return self._json(200, {"ok": True, "app": APP, "port": PORT,
                                        "python": "%d.%d" % sys.version_info[:2],
                                        "version": runtime_version()})
            conn = db.connect()
            try:
                index.ensure_indexed(conn)      # после апгрейда схемы соберём индекс заново
                if url.path == "/api/index-status":           # экран проверок в настройках
                    count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
                    return self._json(200, {"sessions": count, "indexing": catch_up()})
                if url.path == "/api/sessions":
                    indexing = catch_up()
                    return self._json(200, dict(self._list(conn, query), indexing=indexing))
                if url.path == "/api/active":
                    indexing = catch_up()
                    sessions = active_sessions(conn)
                    msgs = (query.get("msgs") or ["1"])[0]
                    msgs = min(feed.HISTORY_MAX, int(msgs)) if msgs.isdigit() else 1
                    if msgs > 1:          # хвост переписки подробной карточки; список в кэше не трогаем
                        sessions = [dict(s, history=feed.messages_tail(
                            active._transcript(conn, s["session_id"], index.PROJECTS_ROOT), msgs))
                            for s in sessions]
                    return self._json(200, {"count": len(sessions), "sessions": sessions,
                                            "recent_closed": active.recently_closed(
                                                conn, {s["session_id"] for s in sessions}),
                                            "limits": limits.read_limits(),
                                            "indexing": indexing})
                if url.path.startswith("/api/active/feed/"):
                    sid = url.path.rsplit("/", 1)[-1]
                    if not actions.valid_session_id(sid):
                        return self._json(400, {"error": msg("server.bad_session_id")})
                    path = active._transcript(conn, sid, index.PROJECTS_ROOT)
                    if not path:
                        return self._json(404, {"error": msg("server.no_session")})
                    if (query.get("view") or [""])[0] == "files":
                        return self._json(200, dict(touched.session_files(path), session_id=sid,
                                                    home=os.path.expanduser("~")))
                    turns = (query.get("turns") or [str(feed.DEFAULT_TURNS)])[0]
                    stamp = lambda name: next((v for v in query.get(name) or []
                                               if TIMESTAMP.fullmatch(v)), None)
                    page = feed.feed_page(path, int(turns) if turns.isdigit() else feed.DEFAULT_TURNS,
                                          with_events=(query.get("view") or [""])[0] == "steps",
                                          before=stamp("before"), since=stamp("since"))
                    return self._json(200, dict(page, session_id=sid))
                if url.path.startswith("/api/active/plan/"):
                    sid = url.path.rsplit("/", 1)[-1]
                    if not actions.valid_session_id(sid):
                        return self._json(400, {"error": msg("server.bad_session_id")})
                    found = plans.plan_text(active._transcript(conn, sid, index.PROJECTS_ROOT),
                                            (query.get("path") or [None])[0])
                    return self._json(200 if found else 404, found or {"error": msg("server.plan_not_found")})
                if url.path.startswith("/api/active/reply/"):
                    sid = url.path.rsplit("/", 1)[-1]
                    if not actions.valid_session_id(sid):
                        return self._json(400, {"error": msg("server.bad_session_id")})
                    found = active.last_reply(conn, sid)
                    return self._json(200 if found else 404, found or {"error": msg("server.no_session")})
                if url.path == "/api/workdirs":
                    return self._json(200, {"workdirs": launch.workdirs(conn)})
                if url.path == "/api/stats":
                    catch_up()
                    return self._json(200, stats.summary(
                        conn, (query.get("period") or ["7d"])[0],
                        automation=(query.get("auto") or ["0"])[0] == "1"))
                if url.path == "/api/facets":
                    return self._json(200, self._facets(conn))
                if url.path.startswith("/api/prompts/"):
                    return self._json(200, self._prompts(conn, url.path.rsplit("/", 1)[-1]))
                if url.path.startswith("/api/session/"):
                    return self._json(200, self._card(conn, url.path.rsplit("/", 1)[-1]))
                if url.path.startswith("/api/job/"):
                    job = actions.get_job(conn, url.path.rsplit("/", 1)[-1])
                    return self._json(200 if job else 404, job or {"error": msg("server.no_job")})
            finally:
                conn.close()
            self._json(404, {"error": msg("server.no_path")})
        except Exception as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}",
                             "trace": traceback.format_exc()[-600:]})

    def do_POST(self) -> None:
        self._lang()
        if not self._guard(mutating=True):
            return
        url = urlparse(self.path)
        # Картинка в base64 крупнее обычного запроса: предел поднят только для загрузки.
        body = self._body(UPLOAD_BODY_LIMIT if url.path == "/api/upload" else 1_000_000)
        session_id = body.get("session_id", "")
        conn = db.connect()
        try:
            if url.path != "/api/override" and session_id and \
                    not actions.valid_session_id(session_id):
                return self._json(400, {"error": msg("session_id.invalid")})
            if url.path in LLM_PATHS and not (url.path == "/api/auto-classify"
                                              and body.get("enabled") is False):
                runner.require_llm()
            handler = {
                "/api/preview": self._preview, "/api/job": self._start_job,
                "/api/cancel": self._cancel, "/api/terminal": self._terminal,
                "/api/launch": self._launch, "/api/override": self._override,
                "/api/export": self._export, "/api/reindex": self._reindex,
                "/api/rename": self._rename,
                "/api/classify/preview": self._classify_preview,
                "/api/classify": self._classify,
                "/api/upload": self._upload,
                "/api/auto-classify": self._auto_classify,
                "/api/new-session": self._new_session,
                "/api/relocate": self._relocate,
                "/api/shutdown": self._shutdown,
                "/api/delete/preview": self._delete_preview,
                "/api/delete": self._delete,
            }.get(url.path)
            if handler is None:
                return self._json(404, {"error": msg("server.no_path")})
            return handler(conn, body)
        except runner.EgressDenied as exc:
            self._json(403, {"error": str(exc)})
        except Exception as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
        finally:
            conn.close()

    # --- реализация ---

    def _page(self) -> None:
        nonce = secrets.token_urlsafe(16)
        with open(os.path.join(WEB_DIR, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        html = html.replace("__NONCE__", nonce).replace("__TOKEN__", csrf_token())
        self._send(200, html.encode(), "text/html; charset=utf-8", nonce=nonce)

    def _static(self, name: str) -> None:
        """Скрипты и стили страницы: только файлы web/js с простым именем — ни каталогов, ни «..»."""
        if not STATIC_NAME.fullmatch(name):
            return self._json(404, {"error": msg("server.no_file")})
        path = os.path.join(WEB_DIR, "js", name)
        if not os.path.isfile(path):
            return self._json(404, {"error": msg("server.no_file")})
        # Токен в скрипты не подставляется: чужая страница может подключить их тегом <script>
        # и прочитать глобальные переменные. Токен — только во встроенном скрипте страницы.
        with open(path, "rb") as fh:
            self._send(200, fh.read(), STATIC_TYPES[name.rsplit(".", 1)[1]])

    def _list(self, conn, query) -> dict:
        q = (query.get("q") or [""])[0].strip()
        limit = min(int((query.get("limit") or ["60"])[0]), 200)
        projects = query.get("project") or None
        domains = query.get("domain") or None
        include_automation = (query.get("automation") or ["0"])[0] == "1"
        since = (query.get("since") or [None])[0]
        topics = query.get("topic") or None
        scope = (query.get("scope") or ["prompts"])[0]
        order = (query.get("order") or ["date"])[0]
        found = {"plan": [], "elsewhere": None, "error": None}
        if q:
            found = search.run(conn, q, limit=limit, projects=projects, domains=domains,
                               since=since, include_automation=include_automation,
                               topics=topics, scope=scope, order=order)
            rows, total = found["results"], found["total"]
        else:
            rows = search.recent(conn, limit=limit, projects=projects, domains=domains,
                                 since=since, include_automation=include_automation,
                                 topics=topics)
            total = len(rows)
        for row in rows:
            art = enrich.cached(conn, row["session_id"], "catalog_summary")
            row["summary"] = _summary_view(art)
        return {"count": total, "shown": len(rows), "results": rows,
                "plan": found["plan"], "elsewhere": found["elsewhere"],
                "error": found["error"],
                "indexed_through": db.get_meta(conn, "indexed_through")}

    def _facets(self, conn) -> dict:
        """Отдаёт и карту проект→домены: фильтр проектов сужается выбранными доменами."""
        effective = {}
        for row in conn.execute("""
            SELECT s.session_id,
                   COALESCE((SELECT u.domain FROM user_overrides u WHERE u.session_id=s.session_id),
                            (SELECT c.domain FROM classification c WHERE c.session_id=s.session_id),
                            (SELECT d.domain FROM session_domains d WHERE d.session_id=s.session_id
                             LIMIT 1)
                   ) AS domain,
                   (SELECT c.topic FROM classification c WHERE c.session_id=s.session_id) AS topic
            FROM sessions s WHERE s.session_kind='interactive'"""):
            effective[row["session_id"]] = (row["domain"], row["topic"])

        project_domains: dict[str, set] = {}
        project_count: dict[str, int] = {}
        for row in conn.execute("SELECT session_id, project_id FROM session_projects"):
            if row["session_id"] not in effective:
                continue
            domain = effective[row["session_id"]][0]
            project_domains.setdefault(row["project_id"], set())
            project_count[row["project_id"]] = project_count.get(row["project_id"], 0) + 1
            if domain:
                project_domains[row["project_id"]].add(domain)

        topics: dict[str, set] = {}
        for domain, topic in effective.values():
            if topic:
                topics.setdefault(topic, set())
                if domain:
                    topics[topic].add(domain)

        return {
            "projects": sorted(project_domains, key=lambda p: -project_count.get(p, 0)),
            "project_domains": {k: sorted(v) for k, v in project_domains.items()},
            "domains": sorted({d for d, _ in effective.values() if d}),
            "domain_options": list(config.domain_ids()),
            "topics": sorted(topics),
            "topic_domains": {k: sorted(v) for k, v in topics.items()},
            "unclassified": len(classify.pending(conn)),
            # Джоба живёт на сервере: страницу можно закрыть и вернуться к прогрессу.
            "classify_job": (lambda r: r["job_id"] if r else None)(conn.execute(
                "SELECT job_id FROM jobs WHERE action_kind='classification' "
                "AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1").fetchone()),
            "destinations": sorted(export_destinations()),
            "auto_classify": autoclassify.status(conn),
            "llm_enabled": runner.llm_enabled(),
        }

    def _prompts(self, conn, session_id: str) -> dict:
        return {"prompts": search.load_prompts(conn, session_id)}

    def _card(self, conn, session_id: str) -> dict:
        data = search.load_session(conn, session_id)
        if data is None:
            return {"error": msg("server.no_such_session")}
        data["actions"] = actions.actions_for(conn, session_id)
        data["state"] = search.local_state(conn, session_id)
        data["summary"] = _summary_view(enrich.cached(conn, session_id, "catalog_summary"))
        data["handoff"] = _summary_view(enrich.cached(conn, session_id, "handoff"))
        return data

    def _preview(self, conn, body) -> None:
        self._json(200, enrich.preview(conn, body["session_id"],
                                       body.get("artifact_kind", "handoff")))

    def _start_job(self, conn, body) -> None:
        session_id = body["session_id"]
        kind = body.get("artifact_kind", "handoff")
        if kind not in actions.JOB_KINDS:
            return self._json(400, {"error": msg("server.unknown_artifact")})
        backend = body.get("backend", runner.EXTERNAL_BACKEND)
        model = runner.model_for(kind)[0]           # модель и окно 1M — только из MODELS
        payload = runner.build_payload(conn, session_id, kind)
        if body.get("confirmed") is not True:
            return self._json(400, {"error": msg("server.need_confirm")})
        runner.grant_egress(conn, session_id, payload["content_hash"], kind, backend, model)
        job_id, created = actions.claim_job(conn, session_id, kind, payload["content_hash"])
        if created:
            threading.Thread(target=_run_job, daemon=True,
                             args=(job_id, session_id, kind, backend, model,
                                   messages.request_lang())).start()
        self._json(200, {"job_id": job_id, "created": created})

    def _cancel(self, conn, body) -> None:
        self._json(200, {"cancelled": actions.cancel_job(conn, body["job_id"])})

    def _terminal(self, conn, body) -> None:
        cwd = actions.resume_cwd(conn, body["session_id"])
        command = body.get("command") or actions.resume_command(cwd, body["session_id"])
        if not cwd or not command:
            return self._json(400, {"error": msg("server.no_workdir")})
        ok, message = actions.open_in_terminal(cwd, command)
        self._json(200 if ok else 500, {"ok": ok, "message": message})

    def _launch(self, conn, body) -> None:
        session_id = body["session_id"]
        art = enrich.cached(conn, session_id, "handoff")
        if not art or not art["payload"]:
            return self._json(400, {"error": msg("server.handoff_first")})
        path = os.path.join(enrich.handoff_dir(), f"launch-{session_id[:8]}.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(art["payload"])
        new_id = actions.register_pending_launch(conn, session_id, path)
        cwd = actions.resume_cwd(conn, session_id)
        self._json(200, {"new_session_id": new_id, "handoff_path": path, "cwd": cwd,
                         "command": actions.new_session_command(cwd, new_id, path)})

    def _override(self, conn, body) -> None:
        fields = {k: body.get(k)
                  for k in ("domain", "sensitivity", "work_outcome", "project_id", "topic")}
        conn.execute(
            "INSERT INTO user_overrides (session_id, domain, sensitivity, work_outcome, "
            "project_id, topic, updated_at) VALUES (?,?,?,?,?,?,datetime('now')) "
            "ON CONFLICT(session_id) DO UPDATE SET domain=COALESCE(excluded.domain, domain), "
            "sensitivity=COALESCE(excluded.sensitivity, sensitivity), "
            "work_outcome=COALESCE(excluded.work_outcome, work_outcome), "
            "project_id=COALESCE(excluded.project_id, project_id), "
            "topic=COALESCE(excluded.topic, topic), updated_at=datetime('now')",
            (body["session_id"], fields["domain"], fields["sensitivity"],
             fields["work_outcome"], fields["project_id"], fields["topic"]),
        )
        conn.commit()
        self._json(200, {"ok": True})

    def _rename(self, conn, body) -> None:
        result = actions.rename_session(conn, body["session_id"], body.get("title", ""),
                                        write_to_transcript=body.get("to_claude", True))
        self._json(200, result)

    def _export(self, conn, body) -> None:
        # Подпись могла прийти с языком прошлой отрисовки: принимаем подписи обоих языков.
        destinations = {}
        for lang in messages.LANGS:
            destinations.update(export_destinations(lang))
        label = body.get("destination")
        if label not in destinations:
            return self._json(400, {"error": msg("server.bad_destination")})
        path = enrich.export_handoff(conn, body["session_id"], destinations[label])
        self._json(200, {"path": path})

    def _classify_preview(self, conn, body) -> None:
        self._json(200, classify.preview_batch(conn))

    def _classify(self, conn, body) -> None:
        if body.get("confirmed") is not True:
            return self._json(400, {"error": msg("server.need_confirm")})
        ids = classify.pending(conn)
        if not ids:
            return self._json(200, {"job_id": None, "pending": 0})
        job_id, created = actions.claim_job(conn, "batch", "classification",
                                            f"pending-{len(ids)}")
        if created:
            threading.Thread(target=_run_classify, daemon=True,
                             args=(job_id, ids, messages.request_lang())).start()
        self._json(200, {"job_id": job_id, "created": created, "pending": len(ids)})

    def _relocate(self, conn, body) -> None:
        """Сессию из iTerm/VS Code — во вкладку Obsidian: завершить там, вернуть команду resume."""
        sid = body.get("session_id", "")
        try:
            stopped = relocate.stop_for_move(sid, body.get("pid"))
        except relocate.RelocateError as exc:
            return self._json(400, {"error": str(exc)})
        cwd = actions.resume_cwd(conn, sid)
        _active_cached["sessions"] = None          # список активных уже другой
        self._json(200, dict(stopped, cwd=cwd, command=actions.resume_command(cwd, sid)))

    def _new_session(self, conn, body) -> None:
        try:
            self._json(200, launch.new_session(conn, body.get("cwd"), body.get("prompt", "")))
        except launch.LaunchError as exc:
            self._json(400, {"error": str(exc)})

    def _auto_classify(self, conn, body) -> None:
        if not isinstance(body.get("enabled"), bool):
            return self._json(400, {"error": msg("server.enabled_bool")})
        self._json(200, autoclassify.set_enabled(conn, body["enabled"]))

    def _upload(self, conn, body) -> None:
        try:
            self._json(200, uploads.save_image(body.get("data", "")))
        except uploads.UploadError as exc:
            self._json(400, {"error": str(exc)})

    def _delete_preview(self, conn, body) -> None:
        try:
            self._json(200, delete.footprint(conn, body.get("session_id", "")))
        except delete.DeleteError as exc:
            self._json(400, {"error": str(exc)})

    def _delete(self, conn, body) -> None:
        """Необратимо: только после окна подтверждения со списком того, что удаляется."""
        if body.get("confirmed") is not True:
            return self._json(400, {"error": msg("server.need_confirm")})
        try:
            result = delete.delete_session(conn, body.get("session_id", ""))
        except delete.DeleteError as exc:
            return self._json(409, {"error": str(exc)})
        _active_cached["sessions"] = None
        self._json(200, result)

    def _shutdown(self, conn, body) -> None:
        """Плагин новой версии останавливает сервер старой, который запустил не он."""
        self._json(200, {"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _reindex(self, conn, body) -> None:
        stats = index.index_all(conn)
        actions.confirm_launches(conn)
        self._json(200, {"stats": stats})


def _summary_view(art: dict | None) -> dict | None:
    if art is None:
        return None
    return {"payload": art["payload"], "error": art["error"], "fresh": art["fresh"],
            "model": art["model"], "created_at": art["created_at"]}


def serve(port: int = PORT) -> None:
    global PORT, ALLOWED_HOSTS, ALLOWED_ORIGINS
    PORT = port
    ALLOWED_HOSTS = {f"127.0.0.1:{port}", f"localhost:{port}"}
    ALLOWED_ORIGINS = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    autoclassify.start_scheduler()          # ничего не делает, пока автоклассификация выключена
    print(f"session-atlas слушает http://{HOST}:{port}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()         # после /api/shutdown порт свободен сразу
