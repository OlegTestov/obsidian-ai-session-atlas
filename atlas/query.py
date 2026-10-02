"""Разбор поискового запроса: операторы, точные и усечённые слова, MATCH для FTS5, фрагменты."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .messages import msg

# Порядок обязан совпадать со схемой fts: по индексу колонки берётся highlight().
FTS_COLUMNS = ("title", "user_text", "assistant_text", "commands", "paths",
               "tickets", "summaries", "subagent_text")

# По умолчанию ищем в разговоре, а не по всему индексу: «figma» иначе находит сессии,
# где фигурировал одноимённый MCP-тул, а самого слова в запросах не было.
SCOPE_COLUMNS = {
    "prompts": ("title", "user_text"),
    "all": FTS_COLUMNS,
}

# unicode61 не стеммит, и одного префикса мало: «моделям» и «моделей» расходятся до конца
# слова, так что «моделям*» не найдёт «моделей». Поэтому длинное слово усекается до основы.
PREFIX_MIN_LEN = 5
STEM_FLOOR = 4  # короче основу не режем — «на*» матчит пол-корпуса

# Идентификатор ищется точно: усечение «ABC-1548» до основы даёт «ABC-1*» и матчит любой тикет.
# И число тоже: «1359» не должно находить «13».
IDENTIFIER_RE = re.compile(r"\d|[/\\._]")
PATHLIKE_RE = re.compile(r"[/\\]|\.[A-Za-z0-9]{1,5}$")

# Короткое русское слово основой не усечь («пла*» из «план» найдёт «плагин»), поэтому
# перебираем его формы явно: «окно» → окна, окну, окном… Грубо, но без словаря.
SHORT_CYR_RE = re.compile(r"^[а-яё]{3,4}$", re.I)
_VOWEL_TAIL = "аоуеёыиьйяю"
ENDINGS = ("а", "о", "у", "е", "ы", "и", "ой", "ом", "ам", "ами", "ах", "ов", "ей",
           "ю", "я", "ую", "ем", "ям", "ях")

OR_WORDS = {"или", "or", "|"}
_TOKEN_RE = re.compile(r'(-?)"([^"]*)"|(\S+)')
_STRIP = ".,;:!?()[]{}\"'«»"
_WORDLIKE = re.compile(r"\w")

MARK_OPEN, MARK_CLOSE = "\x02", "\x03"
_MARKED_RE = re.compile(MARK_OPEN + "(.*?)" + MARK_CLOSE, re.S)


def word_forms(word: str) -> list[str]:
    base = word[:-1] if word[-1].lower() in _VOWEL_TAIL else word
    return list(dict.fromkeys([word] + [base + e for e in ENDINGS]))


class QueryError(ValueError):
    """Запрос, который нельзя выполнить: объяснение уходит пользователю как есть."""


# Окончания, которые срезаются до основы: длинные проверяются первыми.
_ENDINGS_RU = sorted((
    "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ует", "ает", "яет", "ать", "ять",
    "ить", "еть", "ешь", "ишь",
    "ах", "ях", "ам", "ям", "ом", "ем", "ов", "ев", "ой", "ей", "ий", "ый", "ая", "яя", "ое",
    "ее", "ые", "ие", "ую", "юю", "ых", "их", "ым", "им", "ет", "ит", "ут", "ют", "ат", "ят",
    "ть", "ла", "ли", "ло", "ал", "ял", "ил", "ел", "ул",
), key=len, reverse=True)
_SOFT_TAIL = "аоуеёыиэюяйь"
_CYR = re.compile(r"[а-яё]", re.I)


def stem_prefix(token: str) -> str:
    """Основа слова для префиксного поиска — маленький стеммер вместо словаря.

    Срезается известное окончание; слово на согласную остаётся целым: «замер*» находит
    «замера», а усечённое «заме*» тащило бы «заметки».
    """
    n = len(token)
    if n < PREFIX_MIN_LEN:
        return token
    low = token.lower()
    if _CYR.search(low):
        cut = next((len(e) for e in _ENDINGS_RU if low.endswith(e)), 0)
        if not cut and low[-1] in _SOFT_TAIL:
            cut = 1
    else:
        cut = 3 if low.endswith("ing") else (1 if low.endswith("s") else 0)
    return token[: max(STEM_FLOOR, n - cut)]


def _quote(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


@dataclass
class Term:
    text: str
    kind: str  # exact | stem | forms | phrase
    negate: bool = False

    def fts(self) -> str:
        if self.kind == "stem":
            return _quote(stem_prefix(self.text)) + "*"
        if self.kind == "forms":
            return "(" + " OR ".join(_quote(f) for f in word_forms(self.text)) + ")"
        return _quote(self.text)

    def near(self) -> str | None:
        """Вид для NEAR(): там допустимы только фразы и префиксы, не группы ИЛИ."""
        if self.kind == "stem":
            return self.fts()
        if self.kind == "forms":
            base = word_forms(self.text)[1][:-1]
            return _quote(base) + "*" if len(base) >= 3 else _quote(self.text)
        return _quote(self.text)

    def shown(self) -> str:
        return stem_prefix(self.text) + "…" if self.kind == "stem" else self.text


@dataclass
class Parsed:
    groups: list[list[Term]] = field(default_factory=list)   # И между группами, ИЛИ внутри
    excluded: list[Term] = field(default_factory=list)

    @property
    def positive(self) -> list[Term]:
        return [t for g in self.groups for t in g]


def _classify(word: str, quoted: bool) -> str:
    if quoted:
        return "phrase" if " " in word.strip() else "exact"
    if IDENTIFIER_RE.search(word):
        return "exact"
    if SHORT_CYR_RE.match(word):
        return "forms"
    if len(word) < PREFIX_MIN_LEN:
        return "exact"
    return "stem"


def parse(query: str) -> Parsed:
    """`"фраза"` — как написано · `-слово` — исключить · `ИЛИ` — любое из двух."""
    parsed = Parsed()
    join_or = False
    for m in _TOKEN_RE.finditer(query):
        if m.group(3) is not None:
            raw = m.group(3)
            negate = raw.startswith("-") and len(raw) > 1
            word = (raw[1:] if negate else raw).strip(_STRIP)
            quoted = False
            if raw.lower() in OR_WORDS:
                join_or = bool(parsed.groups)
                continue
        else:
            negate, word, quoted = bool(m.group(1)), " ".join(m.group(2).split()), True
        if not word or not _WORDLIKE.search(word):
            continue
        term = Term(word, _classify(word, quoted), negate)
        if negate:
            parsed.excluded.append(term)
        elif join_or:
            parsed.groups[-1].append(term)
        else:
            parsed.groups.append([term])
        join_or = False
    return parsed


def _expr(parsed: Parsed) -> str:
    parts = []
    for group in parsed.groups:
        if len(group) == 1:
            parts.append(group[0].fts())
        else:
            parts.append("(" + " OR ".join(t.fts() for t in group) + ")")
    # Явный AND: неявное «И» FTS5 понимает только между фразами, а не рядом со скобками.
    expr = " AND ".join(parts)
    for term in parsed.excluded:
        expr = f"({expr}) NOT {term.fts()}"
    return expr


def build_match(query: str | Parsed, scope: str = "prompts") -> str:
    """Литеральный поиск: каждый токен экранируется, длинные слова получают основу и `*`.

    scope сужает поиск до колонок: FTS5 понимает `{col1 col2} : (выражение)`.
    """
    parsed = parse(query) if isinstance(query, str) else query
    if not parsed.groups:
        if parsed.excluded:
            raise QueryError(msg("query.only_excluded"))
        return ""
    expr = _expr(parsed)
    columns = SCOPE_COLUMNS.get(scope, SCOPE_COLUMNS["prompts"])
    if columns == FTS_COLUMNS:
        return expr
    return "{" + " ".join(columns) + "} : (" + expr + ")"


def column_match(parsed: Parsed, column: str) -> str:
    """Есть ли в колонке хоть одно искомое слово — чтобы не подсвечивать пустые поля."""
    return "{" + column + "} : (" + " OR ".join(t.fts() for t in parsed.positive) + ")"


NEAR_DISTANCE = 10  # слов между соседними словами запроса: «рядом» в одном предложении


def near_pairs(parsed: Parsed, columns: tuple[str, ...]) -> list[str]:
    """По выражению на каждую пару соседних слов запроса: чем больше пар рядом, тем выше."""
    singles = [g[0] for g in parsed.groups if len(g) == 1]
    cols = "{" + " ".join(columns) + "} : "
    return [cols + f"NEAR({a.near()} {b.near()}, {NEAR_DISTANCE})"
            for a, b in zip(singles, singles[1:])]


def title_match(parsed: Parsed) -> str:
    return "{title} : (" + _expr(Parsed(parsed.groups, [])) + ")"


# Вид совпадения → ключ подписи в messages: подпись на языке страницы.
HOW = {"exact": "query.how.exact", "stem": "query.how.forms", "forms": "query.how.forms",
       "phrase": "query.how.phrase"}


def describe(parsed: Parsed) -> list[dict]:
    """Как понят запрос — показывается под строкой поиска, чтобы выдача не была загадкой."""
    out = []
    for i, group in enumerate(parsed.groups):
        for j, term in enumerate(group):
            out.append({"text": term.shown(), "how": msg(HOW[term.kind]), "negate": False,
                        "or_with_previous": j > 0, "group": i})
    for term in parsed.excluded:
        out.append({"text": term.shown(), "how": msg(HOW[term.kind]), "negate": True,
                    "or_with_previous": False, "group": None})
    return out


def is_pathlike(query: str) -> bool:
    return any(PATHLIKE_RE.search(tok) for tok in query.split())


def _unmark(marked: str) -> tuple[str, list[tuple[int, int]]]:
    """Текст без меток и координаты совпадений в нём."""
    plain, spans, pos, size = [], [], 0, 0
    for m in _MARKED_RE.finditer(marked):
        gap, word = marked[pos:m.start()], m.group(1)
        plain += [gap, word]
        spans.append((size + len(gap), size + len(gap) + len(word)))
        size += len(gap) + len(word)
        pos = m.end()
    plain.append(marked[pos:])
    return "".join(plain), spans


def _best_window(text: str, spans: list[tuple[int, int]], width: int) -> int:
    """Окно, где сходится больше разных слов запроса: «окно новостей» лучше, чем два «окна»."""
    best, best_key = 0, (-1, -1)
    for s, _ in spans:
        left = max(0, s - width // 3)
        inside = [text[a:b].lower() for a, b in spans if left <= a and b <= left + width]
        key = (len(set(inside)), len(inside))
        if key > best_key:
            best, best_key = left, key
    return best


def segments(marked: str, width: int = 220) -> tuple[list[dict], int]:
    """Фрагмент кусками `{t, hit}` и число совпадений в поле.

    Метки не текстовые: «» в выдаче путались с русскими кавычками, и подсвечивались целые фразы.
    """
    text, spans = _unmark(marked)
    if not spans:
        return [], 0
    left = _best_window(text, spans, width)
    right = min(len(text), left + width)
    # Край окна сдвигается к пробелу, чтобы не резать слово пополам.
    if left > 0:
        first_hit = min((a for a, _ in spans if a >= left), default=left)
        space = text.find(" ", left, min(left + 20, first_hit))
        left = space + 1 if space >= 0 else left
    if right < len(text):
        space = text.rfind(" ", right - 20, right)
        right = space if space > left else right
    out: list[dict] = []

    def add(chunk: str, hit: bool) -> None:
        chunk = re.sub(r"\s+", " ", chunk)
        if chunk:
            out.append({"t": chunk, "hit": hit})

    if left > 0:
        add("…", False)
    pos = left
    for a, b in spans:
        if b <= left or a >= right:
            continue
        a, b = max(a, left), min(b, right)
        add(text[pos:a], False)
        add(text[a:b], True)
        pos = b
    add(text[pos:right], False)
    if right < len(text):
        add("…", False)
    return out, len(spans)


def as_text(segs: list[dict]) -> str:
    """Для CLI и логов: совпадения в «», как было до кусков."""
    return "".join(f"«{s['t']}»" if s["hit"] else s["t"] for s in segs).strip()
