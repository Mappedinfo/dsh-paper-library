"""User-owned paper stars and hierarchical tags, independent of synced metadata."""
import json
import unicodedata


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS paper_organization(
  paper_id TEXT PRIMARY KEY, favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', modified TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_organization_favorite ON paper_organization(favorite,paper_id);
"""


def normalize_tag(value):
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("标签须为 1–200 字符的文本")
    value = value.strip().removeprefix("#")
    parts = [part.strip() for part in value.split("/")]
    if not 1 <= len(parts) <= 8 or any(not part or "#" in part for part in parts):
        raise ValueError("标签使用 #标签/子标签 格式，最多 8 层，每层不能为空")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("标签不能包含换行或控制字符")
    result = "#" + "/".join(parts)
    if len(result) > 200:
        raise ValueError("标签最多 200 字符（含 #）")
    return result


def source_tag(value):
    # Older exports also use Zotero-shaped objects. Invalid source metadata is
    # left untouched; it cannot turn an otherwise valid catalog read into an error.
    try:
        if isinstance(value, str) and value.startswith("{"):
            try:
                obj = json.loads(value)
            except ValueError:
                obj = None
            if isinstance(obj, dict):
                value = obj.get("tag", obj.get("name"))
        return normalize_tag(value)
    except (ValueError, TypeError):
        return None


def register(db):
    db.create_function("paper_tag", 1, source_tag, deterministic=True)
    db.create_function("paper_tag_parent", 1, lambda tag: tag.rsplit("/", 1)[0] if "/" in tag else None, deterministic=True)


def get(library, id):
    row = library.db.execute("SELECT * FROM paper_organization WHERE paper_id=?", (id,)).fetchone()
    return {"id": id, "favorite": bool(row["favorite"]) if row else False,
            "manual_tags": json.loads(row["tags"]) if row else [],
            "organization_modified": row["modified"] if row else None}


def update(library, request):
    from .core import now
    if not any(key in request for key in ("favorite", "tags")):
        raise ValueError("请选择收藏状态或手动标签")
    if "favorite" in request and not isinstance(request["favorite"], bool):
        raise ValueError("favorite must be boolean")
    tags = request.get("tags")
    if "tags" in request:
        if not isinstance(tags, list) or len(tags) > 100:
            raise ValueError("每篇论文最多 100 个手动标签")
        tags = list(dict.fromkeys(normalize_tag(tag) for tag in tags))
    with library.lock():
        id = request.get("id")
        library.get(id)  # Reject missing, dataset and archived identities.
        current = get(library, id)
        if "expected_organization_modified" in request:
            expected = request["expected_organization_modified"]
            if expected is not None and (not isinstance(expected, str) or not expected):
                raise ValueError("expected_organization_modified must be a saved stamp or null")
            if expected != current["organization_modified"]:
                raise ValueError("这篇论文的收藏或标签已在其他窗口更新，请重新打开后保存")
        favorite = request.get("favorite", current["favorite"])
        tags = tags if "tags" in request else current["manual_tags"]
        if favorite == current["favorite"] and tags == current["manual_tags"]:
            return current
        library.db.execute("""INSERT INTO paper_organization(paper_id,favorite,tags,modified) VALUES(?,?,?,?)
          ON CONFLICT(paper_id) DO UPDATE SET favorite=excluded.favorite,tags=excluded.tags,modified=excluded.modified""",
                           (id, int(favorite), json.dumps(tags, ensure_ascii=False), now()))
        return get(library, id)


def filters(request, id_column, metadata_column, kind_column=None):
    favorite = request.get("favorite", False)
    if not isinstance(favorite, bool):
        raise ValueError("favorite must be boolean")
    tag = request.get("tag", "")
    if not isinstance(tag, str):
        raise ValueError("tag must be text")
    tag = normalize_tag(tag) if tag.strip() else ""
    where, args = [], []
    if favorite or tag:
        if kind_column:
            where.append(f"{kind_column}='paper'")
    if favorite:
        where.append(f"{id_column} IN (SELECT paper_id FROM paper_organization WHERE favorite=1)")
    if tag:
        # Prefix equality avoids LIKE wildcard semantics for %, _ and backslash.
        where.append(f"""EXISTS (SELECT 1 FROM (
          SELECT paper_tag(value) AS tag FROM json_each({metadata_column},'$.tags')
          UNION ALL SELECT value FROM json_each(coalesce((SELECT tags FROM paper_organization WHERE paper_id={id_column}),'[]'))
        ) WHERE tag=? OR substr(tag,1,length(?)+1)=?||'/')""")
        args.extend([tag, tag, tag])
    return where, args


def listing(library, request):
    query = request.get("query", "")
    if not isinstance(query, str) or len(query) > 200:
        raise ValueError("标签检索词最多 200 字符")
    offset, limit = request.get("offset", 0), request.get("limit", 40)
    if type(offset) is not int or not 0 <= offset <= 10000000 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("标签分页超出范围")
    archived = request.get("archived", False)
    if not isinstance(archived, bool):
        raise ValueError("archived must be boolean")
    where = ["a.paper_id IS " + ("NOT NULL" if archived else "NULL")]
    extra, args = filters({"favorite": request.get("favorite", False)}, "p.id", "p.metadata")
    where.extend(extra)
    if request.get("project") is not None:
        project = request["project"]
        if not isinstance(project, str) or not project or len(project) > 60:
            raise ValueError("project must be a project id")
        if not library.db.execute("SELECT 1 FROM projects WHERE id=?", (project,)).fetchone():
            raise ValueError("阅读项目不存在")
        where.append("p.id IN (SELECT paper_id FROM project_papers WHERE project_id=?)")
        args.append(project)
    prefix = """WITH RECURSIVE scoped AS (
      SELECT p.id,p.metadata,o.tags FROM papers p LEFT JOIN paper_archive a ON a.paper_id=p.id
      LEFT JOIN paper_organization o ON o.paper_id=p.id WHERE """ + " AND ".join(where) + """
    ), raw(id,tag) AS (
      SELECT s.id,paper_tag(t.value) FROM scoped s,json_each(s.metadata,'$.tags') t
      UNION ALL SELECT s.id,t.value FROM scoped s,json_each(coalesce(s.tags,'[]')) t
    ), hierarchy(id,tag) AS (
      SELECT id,tag FROM raw WHERE tag IS NOT NULL
      UNION SELECT id,paper_tag_parent(tag) FROM hierarchy WHERE paper_tag_parent(tag) IS NOT NULL
    ), found AS (SELECT tag,count(DISTINCT id) AS count FROM hierarchy
       WHERE tag LIKE ? ESCAPE '\\' GROUP BY tag) """
    needle = query.strip().removeprefix("#").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    args.append("%" + needle + "%")
    total = library.db.execute(prefix + "SELECT count(*) FROM found", args).fetchone()[0]
    rows = library.db.execute(prefix + "SELECT tag,count FROM found ORDER BY tag COLLATE NOCASE,tag LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "offset": offset, "limit": limit,
            "next_offset": offset + len(rows) if offset + len(rows) < total else None}
