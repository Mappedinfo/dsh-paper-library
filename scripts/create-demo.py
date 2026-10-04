"""Create generic learning-method fixtures for reading, thinking and writing.

Usage: uv run python scripts/create-demo.py --output .local/demo-source
The output is disposable when integration/visual checks finish.
"""
import argparse
import json
from pathlib import Path
import pymupdf


def create_demo(output: Path):
    output.mkdir(parents=True, exist_ok=True)
    papers = [
        ("How to read a paragraph", "LearningReading2026", ["reading", "learning"]),
        ("How to ask a clear question", "LearningThinking2026", ["thinking", "learning"]),
        ("How to revise a draft", "LearningWriting2026", ["writing", "learning"]),
    ]
    records = []
    for n, (title, citekey, tags) in enumerate(papers):
        path = output / f"example-{n + 1}.pdf"
        with pymupdf.open() as doc:
            for page_no in range(3):
                page = doc.new_page(width=595, height=842)
                page.insert_text((52, 62), "PAPER LIBRARY  /  SYNTHETIC READING EXAMPLE", fontsize=9, color=(.18, .36, .34))
                page.insert_text((52, 114), title, fontsize=24)
                page.insert_text((52, 143), "Learning Demo  |  Learning methods example  |  2026", fontsize=10)
                page.insert_textbox((52, 184, 540, 650),
                    "This synthetic document is for testing reading and annotation. It makes no scientific claim.\n\n"
                    "A useful reading note connects the author's claim to its supporting evidence. Select this sentence and save a highlight with a question.\n\n"
                    "Read one paragraph, summarize it in your own words, and write one question. Revise a sentence to make its meaning clearer.\n\n"
                    "Portable annotations are stored in the PDF document. Copying the PDF should preserve the note, author and page location.\n\n"
                    "The library loads a small window of pages while scrolling. Search retrieves bounded records from an index on disk.", fontsize=13, lineheight=1.65)
                page.insert_text((52, 785), f"Synthetic fixture / page {page_no + 1}", fontsize=9)
            doc.set_metadata({"title": title, "author": "Learning Demo"})
            doc.save(path)
        records.append({"id":f"demo-{n+1}","citationKey":citekey,"itemType":"journalArticle","title":title,
            "creators":[{"creatorType":"author","name":"Learning Demo","fieldMode":1}],"date":"2026","publicationTitle":"Synthetic Reading Examples",
            "tags":[{"tag":tag} for tag in tags],"attachments":[{"path":str(path.resolve()),"contentType":"application/pdf"}]})
    (output/"zotero-export.json").write_text(json.dumps({"items":records},ensure_ascii=False,indent=2))
    return output/"zotero-export.json"


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",type=Path,default=Path(".local/demo-source"))
    print(create_demo(parser.parse_args().output))
