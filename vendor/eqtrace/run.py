"""使用 PaperLibrary 随附的 EqTrace 静态制图模块。"""
from pathlib import Path
import sys

if sys.version_info < (3, 11):
    sys.exit("EqTrace 制图需要 Python 3.11 或更高版本。")
# -I 隔离启动，只将随包发布的模块加入路径。读者选择的源码目录仅作为数据输入。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eqtrace.paper_flow import main

raise SystemExit(main())
