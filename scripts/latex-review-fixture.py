"""Create only a marked synthetic manuscript for an existing workbench's UI QA.

No server/browser, real manuscript, live library or model is touched. Register
the printed root in the existing workspace, then compile there once to establish
that library's verified build manifest. Test note cleanup must target this root.
"""
import json
from pathlib import Path
import tempfile

from dsh_paper_library.core import dispatch

root = Path(tempfile.mkdtemp(prefix="dsh-review-qa-", dir="/tmp"))
(root / "sections").mkdir()
(root / ".synthetic-review-fixture").write_text("paper-library single-reader QA; no real manuscript\n")
(root / "main.tex").write_text(r"""\documentclass[12pt]{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\input{sections/one}
\clearpage
\input{sections/two}
\end{document}
""")
(root / "draft.tex").write_text(r"""\documentclass[12pt]{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\input{sections/one}
\clearpage
\input{sections/two}
\clearpage
\section{Draft only}
A separate draft appendix for entry isolation.
\end{document}
""")
(root / "sections" / "one.tex").write_text("\\section{First page}\nFirst page review sentence.\n\nThe observation supports a limited claim.\nWe should check the assumptions before revising it.\n")
(root / "sections" / "two.tex").write_text("\\section{Second page}\nSecond page review sentence.\n\nA counterexample may change the interpretation.\nThis paragraph belongs to an included source file.\n")
library = root / ".fixture-library"
created = dispatch({"library": str(library), "action": "latex_project_create", "root": str(root), "title": "Synthetic single-reader review"})["project"]
built = dispatch({"library": str(library), "action": "latex_compile", "id": created["id"], "engine": "pdflatex"})
if not built["ok"]:
    raise RuntimeError(built["log_tail"])
print(json.dumps({"root": str(root), "title": "自审验收（合成）", "pages": built["pages"], "marker": ".synthetic-review-fixture"}, ensure_ascii=False))
