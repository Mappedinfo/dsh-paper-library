"""Reading projects: a paper can belong to several projects, and a project groups many papers.

The relation is many-to-many and lives in the catalog next to the papers, so it is queryable,
exportable and available to the agent. A project never owns or copies a paper; unlinking only
removes the edge. Projects are archived rather than deleted, exactly like papers.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

MAX_PROJECTS = 500
MAX_PAPERS_PER_PROJECT = 2000
MAX_TITLE = 200
MAX_DESCRIPTION = 2000
MAX_TAGS = 20
MAX_TAG = 50

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  tags TEXT,
  created TEXT NOT NULL,
  modified TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_papers(
  project_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  PRIMARY KEY(project_id, paper_id)
);
CREATE INDEX IF NOT EXISTS project_papers_paper ON project_papers(paper_id);
CREATE TABLE IF NOT EXISTS project_archive(project_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value: Any, name: str, maximum: int, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ValueError(f"{name}不能为空")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name}必须是文本")
    cleaned = value.strip()
    if required and not cleaned:
        raise ValueError(f"{name}不能为空")
    if len(cleaned) > maximum:
        raise ValueError(f"{name}超过 {maximum} 个字符")
    return cleaned


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 60 or not all(character.isalnum() or character in "_-" for character in value):
        raise ValueError(f"{name}无效")
    return value


def _tags(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        raise ValueError(f"项目标签最多 {MAX_TAGS} 个")
    cleaned: list[str] = []
    for entry in value:
        tag = _text(entry, "项目标签", MAX_TAG, required=True)
        if tag not in cleaned:
            cleaned.append(tag)
    return cleaned


def _row(record) -> dict:
    return {
        "id": record["id"],
        "title": record["title"],
        "description": record["description"] or "",
        "tags": [tag for tag in (record["tags"] or "").split("\u0000") if tag],
        "created": record["created"],
        "modified": record["modified"],
        "archived": record["archived_at"] is not None,
    }


def _project(library, project_id: str, include_archived: bool = False):
    row = library.db.execute(
        "SELECT projects.*, project_archive.archived_at FROM projects"
        " LEFT JOIN project_archive ON project_archive.project_id=projects.id WHERE projects.id=?",
        (project_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"阅读项目 {project_id} 不存在")
    if row["archived_at"] is not None and not include_archived:
        raise ValueError(f"阅读项目 {project_id} 已归档；恢复后才能修改或关联")
    return row


def _count(library, project_id: str) -> int:
    return library.db.execute("SELECT count(*) FROM project_papers WHERE project_id=?", (project_id,)).fetchone()[0]


def _paper_exists(library, paper_id: str) -> bool:
    return library.db.execute(
        "SELECT 1 FROM papers LEFT JOIN paper_archive ON paper_archive.paper_id=papers.id"
        " WHERE papers.id=? AND paper_archive.paper_id IS NULL",
        (paper_id,),
    ).fetchone() is not None


def create(library, title, description=None, tags=None) -> dict:
    clean_title = _text(title, "项目标题", MAX_TITLE, required=True)
    clean_description = _text(description, "项目说明", MAX_DESCRIPTION) or ""
    clean_tags = _tags(tags)
    live = library.db.execute("SELECT count(*) FROM projects WHERE id NOT IN (SELECT project_id FROM project_archive)").fetchone()[0]
    if live >= MAX_PROJECTS:
        raise ValueError(f"阅读项目最多 {MAX_PROJECTS} 个")
    project_id = "p-" + secrets.token_hex(6)
    stamp = now()
    library.db.execute(
        "INSERT INTO projects(id,title,description,tags,created,modified) VALUES(?,?,?,?,?,?)",
        (project_id, clean_title, clean_description, "\u0000".join(clean_tags), stamp, stamp),
    )
    library.db.commit()
    row = _project(library, project_id)
    return {"project": {**_row(row), "paper_count": 0}, "created": True}


def update(library, id, title=None, description=None, tags=None, include_archived=False) -> dict:
    project_id = _identifier(id, "项目标识")
    row = _project(library, project_id, include_archived)
    next_title = _text(title, "项目标题", MAX_TITLE, required=True) if title is not None else row["title"]
    next_description = _text(description, "项目说明", MAX_DESCRIPTION) if description is not None else (row["description"] or "")
    next_tags = _tags(tags) if tags is not None else [tag for tag in (row["tags"] or "").split("\u0000") if tag]
    library.db.execute(
        "UPDATE projects SET title=?,description=?,tags=?,modified=? WHERE id=?",
        (next_title, next_description or "", "\u0000".join(next_tags), now(), project_id),
    )
    library.db.commit()
    updated = _project(library, project_id, include_archived=True)
    return {"project": {**_row(updated), "paper_count": _count(library, project_id)}}


def get(library, id, include_archived=False) -> dict:
    project_id = _identifier(id, "项目标识")
    row = _project(library, project_id, include_archived)
    papers = library.db.execute(
        "SELECT papers.id, papers.title, papers.citekey, papers.metadata, project_papers.position,"
        " paper_archive.archived_at AS paper_archived_at"
        " FROM project_papers JOIN papers ON papers.id=project_papers.paper_id"
        " LEFT JOIN paper_archive ON paper_archive.paper_id=papers.id"
        " WHERE project_papers.project_id=? ORDER BY project_papers.position, papers.title, papers.id LIMIT ?",
        (project_id, MAX_PAPERS_PER_PROJECT),
    ).fetchall()
    items = [
        {
            "id": paper["id"],
            "title": paper["title"],
            "citekey": paper["citekey"],
            "year": (paper["metadata"] and _year(paper["metadata"])),
            "archived": paper["paper_archived_at"] is not None,
            "position": paper["position"],
        }
        for paper in papers
    ]
    return {"project": {**_row(row), "paper_count": len(items)}, "papers": items, "total": len(items)}


def _year(metadata: str):
    import json

    try:
        value = json.loads(metadata)
    except ValueError:
        return None
    parts = ((value.get("issued") or {}).get("date-parts") or [[None]])[0]
    return parts[0] if parts and isinstance(parts[0], int) else None


def listing(library, query=None, include_archived=False, limit=50, offset=0) -> dict:
    if not isinstance(limit, int) or limit < 1 or limit > 200:
        raise ValueError("limit 必须是 1–200")
    if not isinstance(offset, int) or offset < 0 or offset > 100000:
        raise ValueError("offset 必须是 0–100000")
    needle = _text(query, "项目检索词", 200) or ""
    where = [] if include_archived else ["project_archive.project_id IS NULL"]
    parameters: list[Any] = []
    if needle:
        where.append("(projects.title LIKE ? OR projects.description LIKE ? OR projects.tags LIKE ?)")
        parameters.extend([f"%{needle}%"] * 3)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    base = " FROM projects LEFT JOIN project_archive ON project_archive.project_id=projects.id"
    total = library.db.execute(f"SELECT count(*){base}{clause}", parameters).fetchone()[0]
    rows = library.db.execute(
        f"SELECT projects.*, project_archive.archived_at,"
        " (SELECT count(*) FROM project_papers WHERE project_papers.project_id=projects.id) AS paper_count"
        f"{base}{clause} ORDER BY projects.modified DESC, projects.id LIMIT ? OFFSET ?",
        [*parameters, limit, offset],
    ).fetchall()
    return {
        "projects": [{**_row(row), "paper_count": row["paper_count"]} for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def archive(library, id) -> dict:
    project_id = _identifier(id, "项目标识")
    _project(library, project_id)
    library.db.execute("INSERT OR REPLACE INTO project_archive(project_id,archived_at) VALUES(?,?)", (project_id, now()))
    library.db.commit()
    row = _project(library, project_id, include_archived=True)
    return {"project": {**_row(row), "paper_count": _count(library, project_id)}}


def restore(library, id) -> dict:
    project_id = _identifier(id, "项目标识")
    _project(library, project_id, include_archived=True)
    library.db.execute("DELETE FROM project_archive WHERE project_id=?", (project_id,))
    library.db.commit()
    row = _project(library, project_id)
    return {"project": {**_row(row), "paper_count": _count(library, project_id)}}


def link(library, id, paper_id, position=None) -> dict:
    project_id = _identifier(id, "项目标识")
    paper = _identifier(paper_id, "文献标识")
    _project(library, project_id)
    if not _paper_exists(library, paper):
        raise ValueError("这篇文献不在活动文献库中（可能已归档或已删除）")
    count = _count(library, project_id)
    existing = library.db.execute("SELECT 1 FROM project_papers WHERE project_id=? AND paper_id=?", (project_id, paper)).fetchone()
    if existing is not None:
        return {"project": {**_row(_project(library, project_id)), "paper_count": count}, "linked": False, "duplicate": True}
    if count >= MAX_PAPERS_PER_PROJECT:
        raise ValueError(f"一个阅读项目最多 {MAX_PAPERS_PER_PROJECT} 篇文献")
    if position is None:
        position = (library.db.execute("SELECT coalesce(max(position),-1)+1 FROM project_papers WHERE project_id=?", (project_id,)).fetchone()[0])
    if not isinstance(position, int) or position < 0 or position > 1000000:
        raise ValueError("position 必须是 0–1000000")
    library.db.execute(
        "INSERT INTO project_papers(project_id,paper_id,position,created) VALUES(?,?,?,?)",
        (project_id, paper, position, now()),
    )
    library.db.execute("UPDATE projects SET modified=? WHERE id=?", (now(), project_id))
    library.db.commit()
    return {"project": {**_row(_project(library, project_id)), "paper_count": count + 1}, "linked": True, "duplicate": False}


def unlink(library, id, paper_id) -> dict:
    project_id = _identifier(id, "项目标识")
    paper = _identifier(paper_id, "文献标识")
    _project(library, project_id)
    cursor = library.db.execute("DELETE FROM project_papers WHERE project_id=? AND paper_id=?", (project_id, paper))
    if cursor.rowcount:
        library.db.execute("UPDATE projects SET modified=? WHERE id=?", (now(), project_id))
        library.db.commit()
    return {"project": {**_row(_project(library, project_id)), "paper_count": _count(library, project_id)}, "unlinked": bool(cursor.rowcount)}


def for_paper(library, paper_id) -> dict:
    paper = _identifier(paper_id, "文献标识")
    rows = library.db.execute(
        "SELECT projects.id, projects.title, projects.modified,"
        " (SELECT count(*) FROM project_papers WHERE project_papers.project_id=projects.id) AS paper_count"
        " FROM project_papers JOIN projects ON projects.id=project_papers.project_id"
        " LEFT JOIN project_archive ON project_archive.project_id=projects.id"
        " WHERE project_papers.paper_id=? AND project_archive.project_id IS NULL"
        " ORDER BY projects.title, projects.id LIMIT 200",
        (paper,),
    ).fetchall()
    return {"projects": [{"id": row["id"], "title": row["title"], "paper_count": row["paper_count"], "modified": row["modified"]} for row in rows], "total": len(rows)}


ACTIONS = {
    "project_create": (create, ("title", "description", "tags")),
    "project_update": (update, ("id", "title", "description", "tags", "include_archived")),
    "project_get": (get, ("id", "include_archived")),
    "project_list": (listing, ("query", "include_archived", "limit", "offset")),
    "project_archive": (archive, ("id",)),
    "project_restore": (restore, ("id",)),
    "project_link": (link, ("id", "paper_id", "position")),
    "project_unlink": (unlink, ("id", "paper_id")),
    "project_for_paper": (for_paper, ("paper_id",)),
}


def dispatch_projects(library, action: str, request: dict) -> dict:
    handler = ACTIONS.get(action)
    if handler is None:
        raise ValueError("Unknown project action")
    function, keys = handler
    return function(library, **{key: request[key] for key in keys if key in request})
