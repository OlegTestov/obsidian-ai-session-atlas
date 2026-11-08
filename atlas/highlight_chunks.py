"""Render large fields using bounded temporary FTS rows; never change the catalog's stored rows.

Only independent ASCII word terms qualify. Splitting those at ASCII whitespace cannot change token
matches; phrases and all other query forms retain SQLite's original whole-field highlight path.
"""
from __future__ import annotations

import re
import sqlite3

from . import query

LARGE_FIELD = 65536
CHUNK_SIZE = 8192
DENSE_HITS = 512        # measured on a 3.46 GB catalog: fewer hits stay on SQLite's own highlight()
_ASCII_WORD = re.compile(r"[A-Za-z0-9]+\Z")
_WHITESPACE = " \t\r\n\f\v"


class ChunkHighlighter:
    def __init__(self, parsed: query.Parsed, chunk_size: int = CHUNK_SIZE):
        self.eligible = bool(parsed.positive) and all(
            term.kind in ("exact", "stem") and _ASCII_WORD.fullmatch(term.text)
            for term in parsed.positive)
        self.needles = [(query.stem_prefix(t.text) if t.kind == "stem" else t.text).lower() for t in parsed.positive]
        self.expression = " OR ".join(term.fts() for term in parsed.positive)
        self.chunk_size = max(1, chunk_size)
        self.connection = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def dense(self, text) -> bool:
        """Chooses the cheaper path only: an undercount (mixed case, diacritics) keeps SQLite's own highlight()."""
        if not isinstance(text, str):
            return False
        forms = {form for needle in self.needles for form in (needle, needle.capitalize(), needle.upper())}
        return sum(text.count(form) for form in forms) >= DENSE_HITS

    def render(self, text: str) -> str | None:
        """The full marked string, or None when the original highlight() must handle this field."""
        if not self.eligible or not isinstance(text, str) or "\x00" in text:
            return None
        if self.connection is None:
            self.connection = sqlite3.connect(":memory:")
            self.connection.execute("CREATE VIRTUAL TABLE fragment USING fts5(text, tokenize='unicode61')")
        result, start = [], 0
        while start < len(text):
            end = min(start + self.chunk_size, len(text))
            if end < len(text):
                boundary = max(text.rfind(space, start, end) for space in _WHITESPACE)
                if boundary < start:
                    return None                 # an oversized token cannot safely be split
                end = boundary + 1
            chunk = text[start:end]
            # An ASCII chunk without even a literal prefix cannot contain a unicode61 match.
            # Unicode chunks still go through SQLite: diacritics may match an ASCII query.
            if chunk.isascii() and not any(needle in chunk.lower() for needle in self.needles):
                result.append(chunk)
                start = end
                continue
            self.connection.execute("DELETE FROM fragment")
            self.connection.execute("INSERT INTO fragment(rowid, text) VALUES (1, ?)", (chunk,))
            row = self.connection.execute(
                "SELECT highlight(fragment, 0, ?, ?) FROM fragment WHERE fragment MATCH ?",
                (query.MARK_OPEN, query.MARK_CLOSE, self.expression)).fetchone()
            result.append(row[0] if row else chunk)
            start = end
        return "".join(result)
