"""将静态源码证据导出为 PaperLibrary 可直接导入的流程文档。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile


def _source(root: Path, value: Path) -> Path:
    source = (root / value).resolve(strict=True)
    if not source.is_relative_to(root) or not source.is_file() or source.suffix != ".py":
        raise ValueError(f"请选择项目目录内的 .py 文件：{value}")
    if source.stat().st_size > 1024 * 1024:
        raise ValueError(f"单份源码超过 1 MiB：{source.name}")
    return source


def build_paper_flow(root: Path, entry: Path | None = None, model: Path | None = None,
                     class_name: str | None = None, title: str | None = None) -> dict:
    """显式选择的视图必须能提取；训练和模型在同一文件时只需给训练入口。"""
    from .network_flow import extract_network_flow
    from .training_flow import extract_training_flow

    root = root.resolve(strict=True)
    if not root.is_dir() or (entry is None and model is None):
        raise ValueError("请选择项目目录及训练入口或模型源码。")
    entry = _source(root, entry) if entry is not None else None
    model = _source(root, model) if model is not None else None
    network_source = model or entry
    network = extract_network_flow(network_source, root, class_name)
    if network is None and (model is not None or class_name):
        raise ValueError(f"{network_source.name} 中找不到对应网络，请检查模型类或 Class.method。")
    training = extract_training_flow(entry, root, network=network, model_path=network_source) if entry is not None else None
    if entry is not None and training is None:
        raise ValueError(f"{entry.name} 中没有识别到训练步骤。仅分析网络时请使用 --model。")
    flows = [flow for flow in (network, training) if flow is not None]
    for flow in flows:
        if len(flow["nodes"]) > 100 or len(flow["edges"]) > 200:
            raise ValueError(f"“{flow['name']}”超过画板单图容量（100 节点、200 连线），请选择更小的源码入口。")
    sources = list(dict.fromkeys(p.relative_to(root).as_posix() for p in (entry, model) if p is not None))
    display_title = title or " / ".join(sources)
    if not display_title.strip() or len(display_title) > 200:
        raise ValueError("图题须包含 1–200 个字符。")
    identity = json.dumps([display_title, sources, flows], ensure_ascii=False, sort_keys=True)
    doc_id = "eqtrace-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    return {
        "schemaVersion": 1, "kind": "paper-flow-document",
        "paper": {"id": doc_id, "title": display_title, "sources": sources},
        "flows": flows,
    }


def export_paper_flow(document: dict, destination: str) -> None:
    content = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    if len(content.encode("utf-8")) > 192 * 1024:
        raise ValueError("结果超过 PaperLibrary 的 192 KiB 上限，请选更小的入口。")
    if destination == "-":
        print(content, end="")
        return
    path = Path(destination)
    if path.suffix.lower() != ".json":
        raise ValueError("输出文件应以 .json 结尾，或用 --out - 输出到终端。")
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        try:
            temp.write(content.encode("utf-8"))
            temp.close()
            os.replace(temp.name, path)
        finally:
            Path(temp.name).unlink(missing_ok=True)


def add_figure_arguments(figures):
    figures.add_argument("--root", type=Path, default=Path.cwd(), help="源码根目录")
    figures.add_argument("--entry", type=Path, help="训练入口 .py，相对根目录或绝对路径")
    figures.add_argument("--model", type=Path, help="模型定义 .py，训练与模型同文件时可省略")
    figures.add_argument("--class", dest="class_name", help="模型类名，或 Class.method")
    figures.add_argument("--title", help="画板文档标题")
    figures.add_argument("--out", default="paper-flow.json", help="输出 .json 文件；- 表示标准输出")


def run_figure_command(args) -> int:
    try:
        document = build_paper_flow(args.root, args.entry, args.model, args.class_name, args.title)
        export_paper_flow(document, args.out)
    except (OSError, ValueError, SyntaxError, RecursionError) as exc:
        print(f"EqTrace: {exc}", file=sys.stderr)
        return 1
    if args.out != "-":
        print(f"{args.out} ({', '.join(flow['id'] for flow in document['flows'])})")
    return 0


def main() -> int:
    """PaperLibrary 可只分发静态制图模块并沿用同一命令参数。"""
    parser = argparse.ArgumentParser(description="从 Python 源码生成论文流程图")
    add_figure_arguments(parser)
    return run_figure_command(parser.parse_args())
