"""Search query parsing: operators, exact and truncated words, FTS5 MATCH, snippets."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .messages import msg

# The order must match the fts schema: highlight() takes the column by index.
FTS_COLUMNS = ("title", "user_text", "assistant_text", "commands", "paths",
               "tickets", "summaries", "subagent_text")

# By default search the conversation, not the whole index: otherwise "figma" finds sessions
# where an MCP tool of that name appeared, but the word itself was never in the requests.
SCOPE_COLUMNS = {
    "prompts": ("title", "user_text"),
    "all": FTS_COLUMNS,
}

# unicode61 does not stem, and a prefix is not enough: «моделям» and «моделей» differ up to
# the word end, so «моделям*» misses «моделей». So a long word is cut to its stem.
PREFIX_MIN_LEN = 5
STEM_FLOOR = 4  # no shorter stem: «на*» matches half the corpus

# Identifiers match exactly: stemming "ABC-1548" gives "ABC-1*", which matches any ticket.
# Numbers too: "1359" must not find "13".
IDENTIFIER_RE = re.compile(r"\d|[/\\._]")
PATHLIKE_RE = re.compile(r"[/\\]|\.[A-Za-z0-9]{1,5}$")

# A short Russian word cannot be cut to a stem («пла*» from «план» finds «плагин»), so
# its forms are listed explicitly: «окно» → окна, окну, окном… Crude, but needs no dictionary.
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
    """A query that cannot run: the explanation goes to the user as is."""


# Endings cut off to get the stem: longer ones are checked first.
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
    """Word stem for prefix search: a tiny stemmer instead of a dictionary.

    A known ending is cut; a word ending in a consonant stays whole: «замер*» finds
    «замера», while a truncated «заме*» would also pull in «заметки».
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
        """Form for NEAR(): only phrases and prefixes are allowed there, not OR groups."""
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
    groups: list[list[Term]] = field(default_factory=list)   # AND between groups, OR inside
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
    """`"phrase"`: as written · `-word`: exclude · `OR` (or `ИЛИ`): either of the two."""
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
    # Explicit AND: FTS5 applies implicit AND only between phrases, not next to parentheses.
    expr = " AND ".join(parts)
    for term in parsed.excluded:
        expr = f"({expr}) NOT {term.fts()}"
    return expr


def build_match(query: str | Parsed, scope: str = "prompts") -> str:
    """Literal search: every token is escaped, long words get a stem and `*`.

    scope narrows the search to columns: FTS5 understands `{col1 col2} : (expression)`.
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
    """Whether the column has at least one query word, so empty fields are not highlighted."""
    return "{" + column + "} : (" + " OR ".join(t.fts() for t in parsed.positive) + ")"


NEAR_DISTANCE = 10  # words between adjacent query words: "near" means within one sentence


def near_pairs(parsed: Parsed, columns: tuple[str, ...]) -> list[str]:
    """One expression per pair of adjacent query words: the more pairs are close, the higher."""
    singles = [g[0] for g in parsed.groups if len(g) == 1]
    cols = "{" + " ".join(columns) + "} : "
    return [cols + f"NEAR({a.near()} {b.near()}, {NEAR_DISTANCE})"
            for a, b in zip(singles, singles[1:])]


def title_match(parsed: Parsed) -> str:
    return "{title} : (" + _expr(Parsed(parsed.groups, [])) + ")"


# Match kind → label key in messages: the label is in the page language.
HOW = {"exact": "query.how.exact", "stem": "query.how.forms", "forms": "query.how.forms",
       "phrase": "query.how.phrase"}


def describe(parsed: Parsed) -> list[dict]:
    """How the query was understood, shown under the search box so results are not a mystery."""
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
    """Text without markers and the match positions in it."""
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
    """The window where most distinct query words meet: "news window" beats two "window"s."""
    best, best_key = 0, (-1, -1)
    for s, _ in spans:
        left = max(0, s - width // 3)
        inside = [text[a:b].lower() for a, b in spans if left <= a and b <= left + width]
        key = (len(set(inside)), len(inside))
        if key > best_key:
            best, best_key = left, key
    return best


def segments(marked: str, width: int = 220) -> tuple[list[dict], int]:
    """Snippet as `{t, hit}` chunks and the number of matches in the field.

    Markers are not text: «» in results mix with Russian quotes and highlight whole phrases.
    """
    text, spans = _unmark(marked)
    if not spans:
        return [], 0
    left = _best_window(text, spans, width)
    right = min(len(text), left + width)
    # The window edge moves to a space so a word is not cut in half.
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
    """For CLI and logs: matches wrapped in «»."""
    return "".join(f"«{s['t']}»" if s["hit"] else s["t"] for s in segs).strip()
