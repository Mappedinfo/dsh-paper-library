"""合成 PDF 验证：双栏、规范化来源、缓存、逐页图像预算与空文字覆盖。"""
import base64
import hashlib
import json
import random

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library
from dsh_paper_library import paper_analysis, pdf_preprocessing as preprocessing
from dsh_paper_library import library_knowledge as knowledge


@pytest.fixture
def document(tmp_path):
    original = tmp_path / "synthetic-layout.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=600, height=800)
        left = "\n".join(f"Left column row {n:02d} has an independent sentence." for n in range(1, 13))
        right = "\n".join(f"Right column row {n:02d} has a different sentence." for n in range(1, 13))
        page.insert_textbox(fitz.Rect(30, 50, 280, 650), left, fontsize=9)
        page.insert_textbox(fitz.Rect(320, 50, 570, 650), right, fontsize=9)
        page.add_freetext_annot(fitz.Rect(30, 700, 540, 750), "PRIVATE ANNOTATION MUST NOT ENTER INPUT", fontsize=10)
        page = doc.new_page(width=600, height=800)
        page.insert_text((30, 60), "Synthetic inter-\nnational finding.", fontsize=12)
        page = doc.new_page(width=600, height=800)
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40), False)
        pixmap.clear_with(128)
        page.insert_image(fitz.Rect(0, 0, 600, 800), pixmap=pixmap)
        page = doc.new_page(width=600, height=800)
        page.insert_text((30, 60), "Synthetic last page.", fontsize=12)
        doc.save(original)
    library = Library(tmp_path / "library")
    paper = library.create({"title": "Synthetic two-column paper"})
    paper = library.attach(paper["id"], str(original))
    yield library, paper, original
    library.close()


def batch(document, **options):
    library, paper, _ = document
    return paper_analysis.batch(library, {"id": paper["id"], "input_format": "markdown", **options})


def test_two_columns_preserve_order_and_separate_raw_derived_provenance(document):
    library, paper, original = document
    managed = library.pdf_path(paper["id"])
    hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (original, managed)}
    result = batch(document, pages=[1, 2])
    text = result["sources"][0]["text"]
    assert text.index("Left column row 12") < text.index("Right column row 01")
    first = result["preprocessing"]["pages"][0]
    raw = (library.root / first["cache_files"]["raw_text"]).read_text()
    assert raw.index("Right column row 01") < raw.index("Left column row 12"), "Fixture must demonstrate the old row-order problem"
    assert "PRIVATE ANNOTATION" not in text and "PRIVATE ANNOTATION" not in raw
    second = result["preprocessing"]["pages"][1]
    raw_hyphen = (library.root / second["cache_files"]["raw_text"]).read_text()
    markdown = (library.root / second["cache_files"]["markdown"]).read_text()
    assert "inter-\nnational" in raw_hyphen
    assert "international" in markdown
    source = result["sources"][1]
    assert source["pdf_snapshot"]["representation"] == "normalized-markdown"
    assert source["pdf_snapshot"]["raw_verbatim"] is False
    assert source["pdf_snapshot"]["exact_quote_basis"] == "saved-source-text"
    assert source["pdf_snapshot"]["raw_text_sha256"] == preprocessing.digest(raw_hyphen)
    assert source["pdf_snapshot"]["markdown_sha256"] == preprocessing.digest(markdown)
    assert source["content_hash"] == preprocessing.digest(source["text"])
    assert all(hashlib.sha256(p.read_bytes()).hexdigest() == expected for p, expected in hashes.items())
    assert library.get(paper["id"])["modified"] == paper["modified"]


def test_soft_hyphen_linebreak_normalization_in_synthetic_two_column_pdf(tmp_path):
    original = tmp_path / "synthetic-soft-hyphen.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=600, height=800)
        # 显式嵌入字体以保留 PDF 文字层里的 U+00AD，而非让编码转成普通连字符。
        page.insert_font(fontname="F1", fontbuffer=fitz.Font("helv").buffer)
        left = ("Left premise be\u00ad\ncomes stronger with selected evidence.\n"
                "The synthetic inter\u00ad\nvention keeps the two columns separate.\n"
                "Term state-of-the-art remains literal.\nArithmetic 7 - 3 = 4 remains literal.")
        right = "\n".join(f"Right column sentence {n} stays independent." for n in range(1, 7))
        page.insert_textbox(fitz.Rect(30, 50, 280, 650), left, fontname="F1", fontsize=9)
        page.insert_textbox(fitz.Rect(320, 50, 570, 650), right, fontname="F1", fontsize=9)
        doc.save(original)
    before = preprocessing.digest(original.read_bytes())
    library = Library(tmp_path / "library")
    try:
        paper = library.create({"title": "Synthetic soft hyphen columns"})
        paper = library.attach(paper["id"], str(original))
        result = batch((library, paper, original), pages=[1])
        source = result["sources"][0]
        text = source["text"]
        assert "becomes" in text and "intervention" in text and "\u00ad" not in text
        assert "state-of-the-art" in text and "7 - 3 = 4" in text
        assert text.index("Arithmetic") < text.index("Right column sentence 1")
        details = result["preprocessing"]["pages"][0]
        raw = (library.root / details["cache_files"]["raw_text"]).read_text()
        assert "be\u00ad" in raw and "inter\u00ad" in raw
        assert preprocessing.digest(raw) == details["raw_text_sha256"]
        assert source["pdf_snapshot"]["normalizations"] == ["soft-hyphen-single-linebreak-v1"]
        assert source["pdf_snapshot"]["version"] == "pdf-markdown-v2"
        assert preprocessing.digest(original.read_bytes()) == before
    finally:
        library.close()


@pytest.mark.parametrize(("content", "expected"), [
    ("be\u00ad\ncomes", "becomes"),
    ("inter\u00ad \t\r\n\t vention", "intervention"),
    ("研\u00ad\n究", "研究"),
    ("be\u00ad\n\ncomes", "be\u00ad\n\ncomes"),
    ("be\u00ad\n \ncomes", "be\u00ad\n \ncomes"),
    ("be\u00ad\v\ncomes", "be\u00ad\v\ncomes"),
    ("be\u00ad\u001c\ncomes", "be\u00ad\u001c\ncomes"),
    ("be\u00ad\u2009\n\u00a0comes", "becomes"),
    ("be\u00ad\n\u2028comes", "be\u00ad\n\u2028comes"),
    ("inter-\nvention", "inter-\nvention"),
    ("x -\ny; x −\ny; well-being; x-y", "x -\ny; x −\ny; well-being; x-y"),
    ("be\u00adcomes", "be\u00adcomes"),
    ("\u00ad\nword; word\u00ad\n.", "\u00ad\nword; word\u00ad\n."),
])
def test_soft_hyphen_normalization_does_not_join_other_lines(content, expected):
    assert preprocessing.normalize_markdown(content) == expected


def test_preprocessing_v2_invalidates_v1_cache_and_cursor(document, monkeypatch):
    with monkeypatch.context() as old:
        old.setattr(preprocessing, "SCHEMA_VERSION", "pdf-markdown-v1")
        previous = batch(document, include_images=True)
    current = batch(document, include_images=True)
    assert previous["preprocessing"]["pages"][0]["cache_key"] != current["preprocessing"]["pages"][0]["cache_key"]
    with pytest.raises(ValueError, match="another input format or preprocessing version"):
        batch(document, include_images=True, cursor=previous["next_cursor"])


def test_conversion_only_accesses_selected_original_page_and_has_no_ocr(document, monkeypatch):
    library, paper, _ = document
    read = []
    insert = fitz.Document.insert_pdf
    def observed(doc, source, **kwargs):
        if source.name:
            read.extend(range(kwargs["from_page"], kwargs["to_page"] + 1))
        assert kwargs["annots"] is False
        return insert(doc, source, **kwargs)
    def forbidden(*args, **kwargs):
        pytest.fail("Markdown preparation must not invoke OCR, rasterize, or iterate the whole PDF")
    monkeypatch.setattr(fitz.Document, "insert_pdf", observed)
    monkeypatch.setattr(fitz.Document, "__iter__", forbidden, raising=False)
    monkeypatch.setattr(fitz.Page, "get_textpage_ocr", forbidden)
    monkeypatch.setattr(fitz.Page, "get_pixmap", forbidden)
    result = batch(document, pages=[2])
    assert set(read) == {1}
    assert result["coverage"]["read_pages"] == [2]
    assert result["preprocessing"]["ocr"] is False
    assert result["preprocessing"]["layout_model"] is False


def test_dense_markdown_resumes_exact_unicode_and_reuses_cache(document, monkeypatch):
    content = "科研😀" * 2666 + "\n\n" + "  " + "科研😀" * 9000
    converted = []
    monkeypatch.setattr(preprocessing, "markdown_page", lambda doc, n: (converted.append(n), content)[1])
    result, chunks, spans = None, [], []
    while True:
        args = {} if result is None else {"cursor": result["next_cursor"], "file_version": result["file_version"]}
        result = batch(document, pages=[2], **args)
        assert len(result["sources"]) <= 8 and result["coverage"]["characters"] <= 24000
        for source in result["sources"]:
            assert len(source["text"]) <= 8000
            chunks.append(source["text"])
            spans.append((source["pdf_snapshot"]["character_start"], source["pdf_snapshot"]["character_end"]))
        if result["next_cursor"] is None:
            break
        assert result["next_cursor"]["input_format"] == "markdown"
    assert "".join(chunks) == content
    assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
    assert converted == [2], "Dense continuation must reuse the converted page"


def test_preserve_whitespace_is_internal_only_and_legacy_default_is_unchanged(document):
    library, paper, _ = document
    knowledge.setup(library)
    request = {"entity": {"kind": "paper", "id": paper["id"]}, "kind": "source-note",
               "text": "  Synthetic excerpt.\n", "preserve_text": True}
    assert knowledge.source_put(library, request)["text"] == "Synthetic excerpt."
    with pytest.raises(ValueError, match="trusted extractor provenance"):
        knowledge.source_put(library, request, preserve_text=True)
    source = knowledge.source_put(library, request, trusted_provenance={"kind": "synthetic-test"}, preserve_text=True)
    assert source["text"] == request["text"]
    assert source["content_hash"] == preprocessing.digest(request["text"])


def test_cursor_rejects_format_and_version_changes_before_pdf_open(document, monkeypatch):
    library, _, _ = document
    first = batch(document, include_images=True)
    cursor = first["next_cursor"]
    monkeypatch.setattr(Library, "_open_pdf", lambda *a, **k: pytest.fail("Invalid cursor opened the PDF"))
    for values in ({"input_format": "text", "cursor": cursor},
                   {"cursor": {**cursor, "preprocessing_version": "changed"}},
                   {"cursor": {"index": 1, "offset": 0}}):
        with pytest.raises(ValueError, match="PAPER_ANALYSIS_INVALID"):
            batch(document, **values)


def test_images_have_correct_pages_budgets_no_annotations_and_cache(document, monkeypatch):
    library, paper, _ = document
    managed = library.pdf_path(paper["id"])
    original_hash = preprocessing.digest(managed.read_bytes())
    render = fitz.Page.get_pixmap
    calls = []
    def observed(page, *args, **kwargs):
        calls.append((page.number + 1, kwargs.get("annots")))
        return render(page, *args, **kwargs)
    monkeypatch.setattr(fitz.Page, "get_pixmap", observed)
    first = batch(document, pages=[2, 1, 4, 3], include_images=True)
    assert first["coverage"]["read_pages"] == [2, 1]
    assert first["coverage"]["completed_pages"] == [2, 1]
    assert first["visual_coverage"]["rendered_pages"] == [2, 1]
    assert calls == [(2, False), (1, False)]
    assert len(first["images"]) == 2
    assert sum(len(base64.b64decode(i["data"])) for i in first["images"]) <= 2 * 1024 * 1024
    for image in first["images"]:
        data = base64.b64decode(image["data"])
        assert data.startswith(b"\x89PNG\r\n\x1a\n")
        assert image["sha256"] == preprocessing.digest(data)
        assert len(data) <= 1024 * 1024 and max(image["width"], image["height"]) <= 1600
        assert image["mime_type"] == "image/png"
    again = batch(document, pages=[2, 1], include_images=True)
    assert calls == [(2, False), (1, False)]
    assert all(i["cache_hit"] for i in again["images"])
    assert [s["id"] for s in first["sources"]] == again["source_ids"]
    second = batch(document, pages=[2, 1, 4, 3], include_images=True,
                   cursor=first["next_cursor"], file_version=first["file_version"])
    assert second["coverage"]["read_pages"] == [4, 3] and second["next_cursor"] is None
    assert preprocessing.digest(managed.read_bytes()) == original_hash
    assert "data" not in json.dumps(first["sources"])  # no encoded images in persistent source snapshots


def test_image_only_page_stays_without_textual_evidence(document, monkeypatch):
    monkeypatch.setattr(preprocessing, "markdown_page", lambda *a: pytest.fail("Image-only page was sent to text converter"))
    result = batch(document, pages=[3], include_images=True)
    assert result["sources"] == [] and result["source_ids"] == []
    assert result["coverage"]["blank_pages"] == []
    assert result["coverage"]["no_extractable_text_pages"] == [3]
    assert result["coverage"]["image_only_pages"] == [3]
    assert result["coverage"]["full_document"] is False
    assert result["visual_coverage"]["rendered_pages"] == [3]
    assert result["visual_coverage"]["ocr"] is False


def test_text_with_images_also_excludes_free_text_annotations(document):
    result = batch(document, pages=[1], input_format="text", include_images=True)
    assert result["input_format"] == "text"
    assert "PRIVATE ANNOTATION" not in result["sources"][0]["text"]
    assert result["visual_coverage"]["rendered_pages"] == [1]
    first = batch(document, input_format="text", include_images=True)
    assert first["next_cursor"]["input_format"] == "text"
    resumed = batch(document, input_format="text", include_images=True,
                    cursor=first["next_cursor"], file_version=first["file_version"])
    assert resumed["coverage"]["read_pages"] == [3, 4]
    with pytest.raises(ValueError, match="another input format or preprocessing version"):
        batch(document, input_format="text", cursor=first["next_cursor"])


def test_missing_converter_reports_explicit_install_requirement(document, monkeypatch):
    def missing(name):
        raise preprocessing.importlib.metadata.PackageNotFoundError(name)
    monkeypatch.setattr(preprocessing.importlib.metadata, "version", missing)
    with pytest.raises(ValueError, match="install the pinned pymupdf4llm==0.2.9"):
        batch(document, pages=[2])


def test_cache_reuse_corruption_recovery_and_file_version_invalidation(document, monkeypatch):
    library, paper, _ = document
    convert = preprocessing.markdown_page
    calls = []
    def observed(doc, n):
        calls.append(n)
        return convert(doc, n)
    monkeypatch.setattr(preprocessing, "markdown_page", observed)
    first = batch(document, pages=[2])
    again = batch(document, pages=[2])
    assert first["source_ids"] == again["source_ids"] and calls == [2]
    details = first["preprocessing"]["pages"][0]
    (library.root / details["cache_files"]["markdown"]).write_text("tampered derived text")
    repaired = batch(document, pages=[2])
    assert calls == [2, 2] and repaired["source_ids"] == first["source_ids"]
    library.annotate(paper["id"], page=2, type="note", comment="Synthetic file version change")
    changed = batch(document, pages=[2])
    assert changed["source_ids"] != first["source_ids"] and calls == [2, 2, 2]
    assert changed["preprocessing"]["pages"][0]["cache_key"] != details["cache_key"]
    with pytest.raises(ValueError, match="SOURCE_CHANGED"):
        batch(document, pages=[2], file_version=first["file_version"])


def test_cache_manifest_cannot_redirect_export_paths(document):
    library, _, _ = document
    first = batch(document, pages=[2])
    key = first["preprocessing"]["pages"][0]["cache_key"]
    path = library.root / "derived" / "pdf-analysis" / key / "page.json"
    manifest = json.loads(path.read_text())
    manifest["cache_files"] = {"raw_text": "../../outside.txt", "markdown": "/outside.md"}
    manifest["markdown_characters"] = -100
    path.write_text(json.dumps(manifest))
    again = batch(document, pages=[2])
    assert again["preprocessing"]["pages"] == first["preprocessing"]["pages"]
    assert again["source_ids"] == first["source_ids"]


def test_derived_directory_symlink_is_rejected_without_writing_outside(document, tmp_path):
    library, _, _ = document
    outside = tmp_path / "outside"
    outside.mkdir()
    (library.root / "derived").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="must not use symlinks"):
        batch(document, pages=[2])
    assert list(outside.iterdir()) == []


def test_file_change_during_conversion_rejects_before_saving_sources(document, monkeypatch):
    library, paper, original = document
    before = preprocessing.digest(original.read_bytes())
    convert = preprocessing.markdown_page
    def changed(doc, number):
        result = convert(doc, number)
        library.annotate(paper["id"], page=number, type="note", comment="Concurrent synthetic annotation")
        return result
    monkeypatch.setattr(preprocessing, "markdown_page", changed)
    with pytest.raises(ValueError, match="SOURCE_CHANGED"):
        batch(document, pages=[2])
    assert preprocessing.digest(original.read_bytes()) == before
    assert not library.db.execute("SELECT 1 FROM sqlite_master WHERE name='knowledge_sources'").fetchone()


def test_noisy_page_is_downscaled_to_png_byte_budget(tmp_path):
    library = Library(tmp_path / "library")
    try:
        with fitz.open() as doc:
            page = doc.new_page(width=600, height=600)
            samples = random.Random(42).randbytes(600 * 600 * 3)
            pixmap = fitz.Pixmap(fitz.csRGB, 600, 600, samples, False)
            page.insert_image(page.rect, pixmap=pixmap)
            image = preprocessing.page_image(library, "synthetic-noise", doc, 1, {"synthetic": True})
        assert image["reduced_for_byte_limit"] is True
        assert len(base64.b64decode(image["data"])) <= preprocessing.MAX_IMAGE_BYTES
        assert max(image["width"], image["height"]) <= preprocessing.MAX_IMAGE_EDGE
    finally:
        library.close()


@pytest.mark.parametrize("values", [{"input_format": "html"}, {"input_format": None}, {"include_images": 1}, {"include_images": "false"}])
def test_invalid_options_rejected_before_opening_pdf(document, monkeypatch, values):
    monkeypatch.setattr(Library, "_open_pdf", lambda *a, **k: pytest.fail("Invalid options opened the PDF"))
    with pytest.raises(ValueError, match="PAPER_ANALYSIS_INVALID"):
        batch(document, **values)
