"""Generate a 24-page synthetic mixed-layout reader fixture; no research data."""
import argparse
import json
from pathlib import Path

import pymupdf


def create(output: Path):
    output.mkdir(parents=True, exist_ok=True)
    path = output / "continuous-reader-synthetic.pdf"
    with pymupdf.open() as doc:
        for index in range(24):
            number = index + 1
            if number in (12, 24):
                width, height, rotation = 595, 842, 0
            else:
                width, height, rotation = [(595, 842, 0), (612, 792, 0), (420, 595, 90), (595, 842, 180), (842, 595, 0), (420, 595, 270)][index % 6]
            page = doc.new_page(width=width, height=height)
            page.insert_text((48, 48), "PAPER LIBRARY / SYNTHETIC READER FIXTURE", fontsize=9)
            page.insert_text((48, 80), f"Continuous reading / page {number}", fontsize=18)
            page.insert_text((48, 114), "Evidence sentence for standard PDF annotation.", fontsize=12)
            page.insert_textbox((48, 145, width - 42, height - 60),
                "This document is a synthetic interface fixture. It contains no research evidence.\n\n"
                "A reading question can connect a claim to an observation. The tools should preserve both the quoted source and the reader comment.\n\n"
                "Scroll to another page, inspect the page number, and return to an annotation. Only nearby pages should retain raster images and text layers.\n\n"
                "PDF annotations should remain standard objects after the application closes. Their page, color, type and stable identity belong to the saved document.",
                fontsize=11, lineheight=1.5)
            page.insert_text((48, height - 30), f"Synthetic fixture / {number} of 24", fontsize=9)
            if number == 12:
                note = page.add_text_annot((32, 135), "Synthetic existing page 12 note")
                note.set_info(title="Synthetic fixture")
                note.update()
            page.set_rotation(rotation)
        doc.set_metadata({"title": "Synthetic continuous reader acceptance", "author": "Ada Example"})
        doc.save(path)
    item = {"id": "SyntheticReader2026", "title": "Synthetic continuous reader acceptance",
            "type": "article-journal", "author": [{"given": "Ada", "family": "Example", "affiliation": [{"name": "Synthetic Reading Institute", "source": "Synthetic fixture"}]}],
            "issued": {"date-parts": [[2026, 9, 15]]}, "container-title": "Synthetic Reader Tests",
            "attachments": [{"path": str(path.resolve()), "contentType": "application/pdf"}]}
    second_path = output / "second-reader-synthetic.pdf"
    with pymupdf.open() as doc:
        for index in range(2):
            page = doc.new_page(width=595, height=842)
            page.insert_text((48, 80), f"Distinct second document / page {index + 1}", fontsize=18)
            page.insert_text((48, 114), "SecondIdentityProof belongs only to document B.", fontsize=12)
        doc.set_metadata({"title": "Synthetic second reader identity", "author": "Bert Example"})
        doc.save(second_path)
    second = {"id": "SyntheticReaderSecond2026", "title": "Synthetic second reader identity",
              "author": [{"given": "Bert", "family": "Example"}],
              "attachments": [{"path": str(second_path.resolve()), "contentType": "application/pdf"}]}
    manifest = output / "reader-export.json"
    manifest.write_text(json.dumps({"items": [item, second]}, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(create(args.output))
