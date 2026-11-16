import pymupdf as fitz

from dsh_paper_library.core import dispatch


def test_notes_index_unions_stars_and_pdf_tags_before_filtering(tmp_path):
    library = str(tmp_path / "library")

    def call(action, **inputs):
        if action in {"annotation_notes_list", "annotation_notes_prepare"}:
            inputs = {"view": "notes", "prepare": action.endswith("_prepare"), **inputs}
            action = "annotation_favorites_list"
        return dispatch({"action": action, "library": library, **inputs})

    def add_pdf(title):
        source = tmp_path / f"{title}.pdf"
        with fitz.open() as doc:
            doc.new_page().insert_text((40, 80), title)
            doc.set_metadata({"title": title})
            doc.save(source)
        return call("import", path=str(source))["items"][0]["id"]

    def add_note(paper, name):
        return call("annotate", id=paper, page=1, type="underline", rects=[[40, 68, 90, 83]],
                    text=name, comment=f"Memo for {name}")["annotation"]["id"]

    def mark(paper, note, favorite):
        call("annotation_favorite_set", id=paper, annotation_id=note, page=1, favorite=favorite)

    def tag(paper, note, before, after):
        call("annotation_tags_update", id=paper, annotation_id=note, page=1, expected_tags=before, tags=after)

    first, second = add_pdf("Synthetic first paper"), add_pdf("Synthetic second paper")
    starred, tagged, both, neither = [add_note(first, name) for name in ("Starred", "Tagged", "Both", "Neither")]
    other = add_note(second, "Other")
    mark(first, starred, True)
    mark(first, both, True)
    tag(first, tagged, [], ["Mobility"])
    tag(first, both, [], ["Mobility", "交通"])
    tag(second, other, [], ["交通"])
    project = call("project_create", title="Synthetic project")["project"]["id"]
    call("project_link", id=project, paper_id=second)

    assert call("annotation_notes_list")["coverage"]["pending"] == 2
    assert call("annotation_notes_prepare")["pending"] == 0
    all_notes = call("annotation_notes_list")
    assert {row["annotation_id"] for row in all_notes["items"]} == {starred, tagged, both, other}
    assert all_notes["total"] == 4
    assert call("annotation_notes_list", category="both", tag="#MOBILITY")["items"][0]["annotation_id"] == both
    assert call("annotation_notes_list", field="content", query="memo for tagged")["items"][0]["annotation_id"] == tagged
    assert call("annotation_notes_list", field="paper", query="second paper")["total"] == 1
    assert call("annotation_notes_list", paper_id=first)["total"] == 3
    assert call("annotation_notes_list", project_id=project, tag="交通")["items"][0]["annotation_id"] == other

    mark(first, both, False)
    tag(first, tagged, ["Mobility"], [])
    assert call("annotation_notes_list", paper_id=first)["coverage"]["pending"] == 1
    assert call("annotation_notes_prepare", paper_id=first)["pending"] == 0
    assert call("annotation_notes_list", paper_id=first, category="tagged")["items"][0]["annotation_id"] == both
    assert call("annotation_notes_list", paper_id=first, category="starred")["items"][0]["annotation_id"] == starred
    call("archive", id=second)
    assert call("annotation_notes_list", project_id=project)["total"] == 0
