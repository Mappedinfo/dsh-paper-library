"""Private, disposable page index for on-demand reader searches."""
from contextlib import closing
import json
import os
import re
import sqlite3
import unicodedata


INDEX_NAME = "reader-text-index-v1.sqlite3"
MAX_PAGE_TEXT = 24_000
MAX_ROWS = 2_000


def key(text):
    # Broad prefilter for ASCII words only. Ignore boundaries, accents and
    # discretionary hyphens here. MuPDF still confirms every hit on the page.
    return re.sub(r"[^A-Z0-9]", "", unicodedata.normalize("NFKD", text).upper())


def read(library, paper_id, version, first, last):
    path = library.root / INDEX_NAME
    if not path.is_file():
        return {}
    try:
        with closing(sqlite3.connect(path, timeout=.1)) as index:
            rows = index.execute(
                """SELECT page,haystack,no_text,sections FROM pages
                   WHERE paper_id=? AND version=? AND page BETWEEN ? AND ?""",
                (paper_id, version, first, last),
            )
            return {page: (haystack, bool(no_text), json.loads(sections) if sections else None)
                    for page, haystack, no_text, sections in rows}
    except (sqlite3.Error, ValueError):
        return {}


def write(library, paper_id, version, pages):
    if not pages:
        return
    path = library.root / INDEX_NAME
    try:
        with closing(sqlite3.connect(path, timeout=.1)) as index, index:
            os.chmod(path, 0o600)
            index.execute("""CREATE TABLE IF NOT EXISTS pages(
                paper_id TEXT NOT NULL, version TEXT NOT NULL, page INTEGER NOT NULL,
                haystack TEXT, no_text INTEGER NOT NULL, sections TEXT,
                UNIQUE(paper_id,version,page)
            )""")
            index.executemany(
                """INSERT INTO pages VALUES(?,?,?,?,?,?)
                   ON CONFLICT(paper_id,version,page) DO UPDATE SET
                       haystack=excluded.haystack, no_text=excluded.no_text,
                       sections=COALESCE(excluded.sections,pages.sections)""",
                [(paper_id, version, page, haystack, no_text, json.dumps(sections) if sections else None)
                 for page, haystack, no_text, sections in pages],
            )
            index.execute("DELETE FROM pages WHERE rowid IN (SELECT rowid FROM pages ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
                          (MAX_ROWS,))
    except (OSError, sqlite3.Error):
        pass  # Search still works on a read-only volume or busy cache.
