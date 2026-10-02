"""CLI: index | search | show | rebuild. stdout — только JSON, диагностика в stderr."""
from __future__ import annotations

import argparse
import json
import sys

from . import actions, classify, db, enrich, index, runner, search as search_mod

SCHEMA_VERSION = 1

EXIT_OK, EXIT_NOT_FOUND, EXIT_BAD_USAGE, EXIT_ERROR = 0, 1, 2, 3


def _envelope(conn, payload: dict) -> dict:
    age = index.index_age_seconds(conn)
    return {
        "schema_version": SCHEMA_VERSION,
        "indexed_through": db.get_meta(conn, "indexed_through"),
        "index_age_seconds": None if age is None else round(age, 1),
        **payload,
    }


def _emit(data: dict) -> None:
    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _refresh(conn, args) -> None:
    """search и show освежают индекс сами: агент не должен смотреть в устаревший каталог."""
    if getattr(args, "no_refresh", False):
        return
    index.ensure_indexed(conn)
    stats = index.index_all(conn)
    if stats["errors"]:
        print(f"warning: {stats['errors']} файлов не разобрались", file=sys.stderr)


def cmd_index(conn, args) -> int:
    stats = index.index_all(conn, full=args.full)
    _emit(_envelope(conn, {"command": "index", "stats": stats}))
    return EXIT_OK


def cmd_rebuild(conn, args) -> int:
    """Пересоздаёт только производное — ручные правки в user_overrides остаются."""
    kept = conn.execute("SELECT count(*) AS n FROM user_overrides").fetchone()["n"]
    db.drop_derived(conn)
    stats = index.index_all(conn, full=True)
    _emit(_envelope(conn, {"command": "rebuild", "stats": stats, "overrides_kept": kept}))
    return EXIT_OK


def cmd_purge_cache(conn, args) -> int:
    _emit(_envelope(conn, {"command": "purge-cache", "dropped": db.purge_cache(conn)}))
    return EXIT_OK


def cmd_search(conn, args) -> int:
    _refresh(conn, args)
    results = search_mod.search(
        conn, args.query, limit=args.limit,
        projects=args.project or None, domains=args.domain or None,
        kinds=args.kind or None, since=args.since,
        include_automation=args.include_automation, topics=args.topic or None,
        scope=args.scope, order=args.order,
    )
    _emit(_envelope(conn, {"command": "search", "query": args.query,
                           "count": len(results), "results": results}))
    return EXIT_OK if results else EXIT_NOT_FOUND


def cmd_show(conn, args) -> int:
    _refresh(conn, args)
    data = search_mod.load_session(conn, args.session_id)
    if data is None:
        print(f"сессия не найдена: {args.session_id}", file=sys.stderr)
        return EXIT_NOT_FOUND
    _emit(_envelope(conn, {"command": "show", "session": data}))
    return EXIT_OK


def cmd_serve(conn, args) -> int:
    from . import server
    conn.close()
    server.serve(args.port)
    return EXIT_OK


def cmd_open(conn, args) -> int:
    from . import service
    ok, message = service.open_browser(args.port)
    print(message, file=sys.stderr)
    return EXIT_OK if ok else EXIT_ERROR


def cmd_ensure(conn, args) -> int:
    """Поднять сервер, если он лежит, и выйти. Браузер не открывается — плагину он не нужен."""
    from . import service
    ok, message = service.ensure_running(args.port)
    _emit(_envelope(conn, {"command": "ensure", "ok": ok, "message": message,
                           "url": f"http://127.0.0.1:{args.port}/"}))
    return EXIT_OK if ok else EXIT_ERROR


def cmd_install(conn, args) -> int:
    from . import service
    path = service.install(args.port)
    _emit(_envelope(conn, {"command": "install", "plist": path,
                           "status": service.status(args.port)}))
    return EXIT_OK


def cmd_uninstall(conn, args) -> int:
    from . import service
    _emit(_envelope(conn, {"command": "uninstall", "removed": service.uninstall()}))
    return EXIT_OK


def cmd_status(conn, args) -> int:
    from . import service
    _emit(_envelope(conn, {"command": "status", **service.status(args.port)}))
    return EXIT_OK


def cmd_resume(conn, args) -> int:
    """Печатает команду восстановления. Ничего не запускает — решает пользователь."""
    _refresh(conn, args)
    info = actions.actions_for(conn, args.session_id)
    if not info["resume_command"]:
        print("рабочая папка сессии не существует", file=sys.stderr)
        return EXIT_NOT_FOUND
    _emit(_envelope(conn, {"command": "resume", "session_id": args.session_id, **info}))
    return EXIT_OK


def cmd_handoff(conn, args) -> int:
    """Двухстадийно и здесь: без --confirm показывает, что уйдёт наружу, и выходит."""
    kind = args.kind
    preview = enrich.preview(conn, args.session_id, kind)
    if not args.confirm:
        print(preview["text"], file=sys.stderr)
        _emit(_envelope(conn, {"command": "preview", "artifact_kind": kind,
                               "chars": preview["chars"], "backend": preview["backend"],
                               "model": preview["model"],
                               "sensitivity": preview["sensitivity"],
                               "hint": "перезапусти с --confirm, чтобы отправить"}))
        return EXIT_OK
    runner.grant_egress(conn, args.session_id, preview["content_hash"], kind,
                        preview["backend"], runner.model_for(kind)[0])
    job_id, _ = actions.claim_job(conn, args.session_id, kind, preview["content_hash"])
    try:
        result = enrich.produce(conn, args.session_id, kind, job_id)
        actions.set_job_state(conn, job_id, "done")
    except Exception as exc:
        actions.set_job_state(conn, job_id, "failed", error=str(exc))
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    _emit(_envelope(conn, {"command": "handoff", **result}))
    return EXIT_OK


def cmd_classify(conn, args) -> int:
    """Домен и тема силами модели. Без --confirm показывает, что уйдёт наружу, и выходит."""
    _refresh(conn, args)
    preview = classify.preview_batch(conn)
    if not args.confirm:
        for sample in preview["samples"]:
            print(sample + "\n---", file=sys.stderr)
        _emit(_envelope(conn, {"command": "classify-preview", **{
            k: v for k, v in preview.items() if k != "samples"},
            "hint": "перезапусти с --confirm"}))
        return EXIT_OK
    ids = classify.pending(conn)[: args.limit] if args.limit else classify.pending(conn)
    if not ids:
        _emit(_envelope(conn, {"command": "classify", "classified": 0,
                               "note": "нечего классифицировать"}))
        return EXIT_OK
    result = classify.classify_batch(conn, ids)
    _emit(_envelope(conn, {"command": "classify", **result}))
    return EXIT_OK if not result["failed"] else EXIT_ERROR


def cmd_topics(conn, args) -> int:
    if args.merge:
        result = classify.merge_topics(conn)
        _emit(_envelope(conn, {"command": "topics-merge", **result}))
        return EXIT_OK
    _emit(_envelope(conn, {"command": "topics",
                           "topics": [{"topic": t, "sessions": c}
                                      for t, c in classify.registry(conn, limit=200)]}))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="atlas", description="Каталог сессий Claude Code")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("index", help="проиндексировать изменившиеся транскрипты")
    p.add_argument("--full", action="store_true", help="перечитать все файлы")
    p.set_defaults(func=cmd_index)

    p = sub.add_parser("rebuild", help="пересоздать производные таблицы")
    p.set_defaults(func=cmd_rebuild)

    p = sub.add_parser("purge-cache", help="удалить описания, хендоффы и классификацию")
    p.set_defaults(func=cmd_purge_cache)

    p = sub.add_parser("search", help="найти сессии")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--project", action="append", default=[])
    p.add_argument("--domain", action="append", default=[])
    p.add_argument("--kind", action="append", default=[],
                   help="interactive | automation")
    p.add_argument("--topic", action="append", default=[])
    p.add_argument("--scope", choices=["prompts", "all"], default="prompts",
                   help="prompts — по запросам и заголовку (по умолчанию), all — по всему индексу")
    p.add_argument("--order", choices=["date", "relevance"], default="date")
    p.add_argument("--include-automation", action="store_true",
                   help="показать и фоновые прогоны (хуки, ночной агент)")
    p.add_argument("--since", help="ISO-дата нижней границы последней активности")
    p.add_argument("--no-refresh", action="store_true")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("show", help="карточка сессии")
    p.add_argument("session_id")
    p.add_argument("--no-refresh", action="store_true")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("resume", help="команда восстановления сессии")
    p.add_argument("session_id")
    p.add_argument("--no-refresh", action="store_true")
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("handoff", help="сжать сессию (по умолчанию только preview)")
    p.add_argument("session_id")
    p.add_argument("--kind", choices=["handoff", "catalog_summary"], default="handoff")
    p.add_argument("--confirm", action="store_true", help="подтвердить отправку наружу")
    p.add_argument("--no-refresh", action="store_true")
    p.set_defaults(func=cmd_handoff)

    p = sub.add_parser("classify", help="проставить домен и тему моделью")
    p.add_argument("--confirm", action="store_true", help="подтвердить отправку наружу")
    p.add_argument("--limit", type=int, help="сколько сессий за прогон")
    p.add_argument("--no-refresh", action="store_true")
    p.set_defaults(func=cmd_classify)

    p = sub.add_parser("topics", help="реестр тем")
    p.add_argument("--merge", action="store_true", help="схлопнуть синонимы моделью")
    p.set_defaults(func=cmd_topics)

    p = sub.add_parser("serve", help="поднять локальный сервер")
    p.add_argument("--port", type=int, default=8787)
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("open", help="открыть интерфейс (поднимет сервер, если нужно)")
    p.add_argument("--port", type=int, default=8787)
    p.set_defaults(func=cmd_open)

    for name, fn, help_text in (("ensure", cmd_ensure, "поднять сервер, если он не работает"),
                                ("install", cmd_install, "поставить LaunchAgent"),
                                ("uninstall", cmd_uninstall, "снять LaunchAgent"),
                                ("status", cmd_status, "состояние сервера и агента")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--port", type=int, default=8787)
        p.set_defaults(func=fn)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    conn = db.connect()
    try:
        return args.func(conn, args)
    except BrokenPipeError:
        return EXIT_OK
    except Exception as exc:  # диагностика в stderr, stdout остаётся машиночитаемым
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
