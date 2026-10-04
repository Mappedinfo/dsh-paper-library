> **非官方项目，由社区成员独立开发和维护。**

项目地址 [Mappedinfo/dsh-paper-library](https://github.com/Mappedinfo/dsh-paper-library) · [安装与使用](https://github.com/Mappedinfo/dsh-paper-library#安装与开发)

我做了一个 DSH 文献插件 **Paper Library**，把收论文、阅读、引用、批注和 AI 追问放进同一个阅读流程。资料保存在本地，独立于 Zotero 运行，也支持导入 Zotero 的导出数据。

**2026-10-04 更新了原页手写。** 读到一句值得追问的话，先高亮，再点这条批注的「手写」，就能在原页写下想法、圈出图表、画箭头。笔迹和这条批注一起保存，之后从侧栏就能看回、跳回。

### 高亮后，直接把想法写在原文旁

高亮、下划线和删除线绑定正文文字。点侧栏批注的 **手写** 后，继续在 PDF 上写画，保留原文与笔迹的空间关系；顶部也保留不关联批注的自由手写。

进入手写时就显示固定的一行状态与操作栏，落下第一笔、自动保存、接着写时，页面位置保持稳定。手写开关和完成按钮的点击高度至少为 44 px。

![高亮后在原 PDF 页面写画，使用合并为一行的手写工具栏](https://raw.githubusercontent.com/Mappedinfo/dsh-paper-library/main/docs/images/handwriting-inline.jpg)

### 收笔继续阅读，原笔迹留在批注卡片里

关联手写时，停笔约 1.5 秒后自动暂存。点击 **完成手写**，立即回到之前的高亮、下划线等工具，保存继续在后台进行。界面区分待存与已保存到 PDF，保存遇到问题可重试。

批注卡片展示原笔迹预览。接入 DSH 视觉模型后，还能在结束手写后自动转文字，展开校对；原笔迹继续保留，校对文字也不会被后续自动识别覆盖。识别会把笔迹图片发送给当前配置的 DSH 视觉模型。

![保存后的批注卡片包含原文摘录与手写预览](https://raw.githubusercontent.com/Mappedinfo/dsh-paper-library/main/docs/images/handwriting-preview.jpg)

### 点预览，找回笔迹所在的位置

点摘录回到原文，点手写预览回到笔迹。相距较远的手写区域可以分别定位，目标短暂描亮；查看后点 **返回刚才位置**，继续刚才的阅读。

高亮和页面笔迹写入管理副本的标准 PDF 批注，笔迹保留与高亮的回复关联。导出 PDF 后重新导入，可恢复批注与笔迹；导入的原文件保持不变。

![点击笔迹预览，定位并短暂描亮原页上的手写区域](https://raw.githubusercontent.com/Mappedinfo/dsh-paper-library/main/docs/images/handwriting-locate.jpg)

这三张图来自当前 `main` 的实际 Chromium 界面，使用合成文档和程序输入的演示笔画，无真实论文或模型生成内容。[演示复现方法](https://github.com/Mappedinfo/dsh-paper-library/blob/main/docs/community/handwriting-demo.md)

### Apple Pencil 与随航

这一轮按 Apple Pencil 随航阅读的使用场景开发，目前以 Chrome 为开发与验证目标。在浏览器能区分笔和触控时，笔负责高亮、手写，手指负责滚动；「笔输入」可以查看实际识别类型，再决定是否开启「仅用笔标注」。默认也支持鼠标输入。

实际识别能力取决于系统和浏览器转发的事件。物理 Pencil／随航、Safari 和 Electron 仍需设备验证；当前使用固定笔宽，没有压感、Pencil 双击或挤压切换工具。自动转文字需要 DSH 视觉模型，识别准确率仍取决于模型和笔迹。[手写功能与验证范围](https://github.com/Mappedinfo/dsh-paper-library#pencil-文字标注与关联手写)

### 同一个文献库里还可以做什么

- **收集与引用**。拖入 PDF，或粘贴公开论文链接／DOI／arXiv；按标题、作者、引用键、标签和摘要检索，复制 APA 7，导出 BibLaTeX。
- **带着批注问 DSH**。每篇论文有自己的 DSH 对话，把选中的批注和临时选文带进问题；关联的 AI 回复保存在批注下，明确标示来源。
- **组织阅读项目与画板**。把文献放入阅读项目，在画板上记录概念、便笺和关系，再从文献节点回到原文。
- **边读边写**。LaTeX 工作台提供源码、PDF 预览和 DSH 写作协作；模型修改先成为提案，由读者审阅接受。

### 安装与当前版本

**试用上述手写功能，请按 [README](https://github.com/Mappedinfo/dsh-paper-library#安装与开发) 安装当前 `main` 源码。** 截至 2026-10-04，npm 的 `@mappedinfo/dsh-paper-library@0.2.2` 已发布，但不包含这轮手写更新。

这是原生 DSH 插件，从右侧面板打开「文献库」，复用 Harness 模型服务与 Web 认证，无需修改 Harness 源码。源码安装需要 Node、Python、uv 和已构建的本地 DSH checkout；具体版本与注册步骤见 README。

插件按需运行 PDF 处理进程，仅渲染阅读位置附近的页面；检索时不打开 PDF，没有常驻向量模型或后台全库解析。当前检索覆盖元数据与摘要，扫描 PDF 尚无全文 OCR；手写转文字是单独的视觉模型功能。[验证记录](https://github.com/Mappedinfo/dsh-paper-library/blob/main/docs/validation.md)

原创代码采用 **MIT**；默认 PyMuPDF、citeproc 运行时涉及 AGPL，CSL 资源保留 CC BY-SA，详见 [第三方许可](https://github.com/Mappedinfo/dsh-paper-library/blob/main/THIRD_PARTY.md)。

欢迎试用原页手写，尤其想听听连续书写、笔与手指切换，以及从批注找回笔迹时的实际体验。遇到笔画问题，可以从「笔输入 → 导出手写诊断」取得本机诊断记录；记录不含正文、图片或笔迹坐标。
