# AI 阅读批注：蓝色与虚线

新建 AI 阅读标记使用固定蓝色 `#2F80ED`（RGB `47,128,237`）、`3 2` PDF point 虚线和 `1.1 pt` 线宽。标准 `/C`、`/BS << /S /D /D [3 2] /W 1.1 >>` 与 `/AP/N` 绘图流同时保存，导出 PDF 后无需资料库标签即可识别。

## 使用

- PDF 阅读侧栏 →「批注」→ 放大镜 →「AI 阅读（蓝色虚线）」。不输入任何关键词即可筛选；另外填写关键词时才叠加文本检索。
- 仅筛选当前论文已读取的原生批注，不扫描整库，不调用模型。命中主标记后保留其整个讨论。
- `library_annotations` / `annotations` 可传 `ai_reading_only:true`，返回匹配原生样式的对象及其原生 `/IRT` 后续回复。默认仍返回全部；沿用原有截断预算，`truncated:true` 不代表读全。
- `library_annotate` 是 AI 工具入口，自动采用此样式。原生 `Highlight` 没有可靠的虚线填色，故该入口把 `highlight` 转成原生 `Underline`；`note` 转为可带弹出内容的原生虚线 `Square`，无位置时放在页角。普通 UI 的人工创建样式保持原样。
- HTTP / Python `annotate` 显式传 `annotation_profile:"ai-reading"` 可复用相同写入器；不要仅传作者名字或伪造文本标记。程序入口是 `src/dsh_paper_library/ai_annotation_style.py` 的 `apply_ai_reading_style(doc, annot)`。
- 有界全文分析本身仍先写待审草稿，不自动改 PDF。AI 回复、翻译、图像说明仍是各自的原生回复，不把既有人工根标记改成 AI 样式；它们的独立分类继续可用。

## 识别规则与边界

- 只读原生颜色与边线属性，绝不以作者、主题、正文、模型名或 `source_kind` 猜 AI 阅读来源。`ai_reading_style` 是样式命中，不是作者身份认证；人手使用相同样式也会命中。
- RGB 各通道容许 `2/255` 舍入误差。兼容 DeviceRGB、DeviceGray（不能命中这个蓝色）以及 DeviceCMYK 的明确近似转换；不推断 ICC、专色或观感相近的任意颜色。
- `/BS` 优先于旧 `/Border`。兼容间接对象、标准默认 dash `[3]`、旧 `[0 0 width [dash gap]]`、多段/奇数 dash 数组；接受其他真实虚线（例如 `[6 3]`）。点线（所有实段不大于 2 pt）、没有间隙、零宽线、非法数值或声明为实线的样式不命中。
- 支持标准 Line、Square、Circle、Polygon、PolyLine、Underline、StrikeOut、Ink 的蓝色虚线。Highlight、Text 便笺图标及 Squiggly 不因附加一个虚线字典而假装可见虚线。
- 仅在自定义 appearance 流中绘制颜色/虚线、而缺少上述原生字典的外部批注，不猜测识别；正文中的虚线、扁平化批注、扫描图像也不是可筛选的原生标记。外部工具若改写/移除标准样式会改变匹配结果。读取不逐像素审计外部自定义 AP 是否与属性声明一致。
- 不自动修改或迁移旧批注。旧 AI 文字标签仍可用普通关键词找，不能再进入这个纯样式筛选。
- 修改备注/选区时同步已有虚线 appearance；保存沿用备份、锁内检查和原子替换。并发冲突不覆盖。

## 检查

合成 PDF 检查保存/重新打开后的字典、真实栅格虚线间隔、原件/旧标注保留、不同标准结构、正反例、原生回复以及工具和侧栏筛选。

```sh
.venv/bin/python -m pytest -q tests/test_ai_annotation_style.py tests/test_annotation_style.py
JSDOM_MODULE=/path/to/jsdom node --test tests-js/ink-tools.test.mjs tests-js/reader-search.test.mjs
```

PyMuPDF 的 Underline `annot.border` 可能是空对象，读取必须使用标准 `/BS`，不能因此判作实线。测试只含合成资料，不修改真实论文。已打开的页面需要保存草稿后自行刷新才能载入新前端；不能以热载成功代替当前页面验收。
