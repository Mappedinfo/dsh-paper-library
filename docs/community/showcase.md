> **非官方项目，由社区成员独立开发和维护。**

项目地址 [Mappedinfo/dsh-paper-library](https://github.com/Mappedinfo/dsh-paper-library)

我做了一个 DSH 文献插件 **Paper Library**，把收论文、阅读、引用、批注和 AI 追问放进同一个阅读流程。资料保存在本地，独立于 Zotero 运行，也支持导入 Zotero 的导出数据。

把 PDF 拖进文献库，或者粘贴 DOI／论文链接，插件会获取可用的公开 PDF，解析资料并自动命名落盘。读到想追问的段落，可以保存高亮或评论，再交给当前 DSH 会话的模型反馈。

### 已有功能

- **导入与检索**。多 PDF 顺序导入、公开链接／DOI／arXiv 获取，按标题、作者、引用键、标签和摘要快速检索。
- **引用与导出**。复制 APA 7 富文本或纯文本，导出单篇或整库 BibLaTeX，保留已有引用键。
- **批注随 PDF 保存**。高亮和评论写入管理副本的标准 PDF 对象，原始文件保持不变。已测试复制 PDF 后在全新资料库恢复批注；另可导出 XFDF、JSON 和 Markdown。
- **文献关系图**。查看共享标签，记录引用、支持、矛盾或相关关系，并附上自己的依据。
- **基于批注的 AI 反馈**。沿用当前 DSH 会话的模型与推理强度，也可开启保存批注后自动反馈。AI 回复有明确标记，并随 PDF 保存。

### 与 DSH 怎样集成

这是原生插件，安装后从 **右侧面板 → 文献库** 打开。插件注册文献检索、导入、引用、批注和反馈等 9 个工具，复用 Harness 的模型服务与 Web 认证，不需要修改 Harness 源码。

内置 `paper-library-fetch` skill，可以在 DSH 中这样使用

> 用 paper-library-fetch 把这个 DOI 对应的论文保存到文献库，核对标题，并给我 APA 引用。

### 界面截图

以下是独立预览模式下的实际界面截图，文献与批注均为合成演示内容。DSH 内通过右侧面板加载同一阅读界面。

![Paper Library 文献列表与 PDF 阅读界面](https://raw.githubusercontent.com/Mappedinfo/dsh-paper-library/main/docs/images/paper-library-reading.jpg)

![标准 PDF 批注与评论](https://raw.githubusercontent.com/Mappedinfo/dsh-paper-library/main/docs/images/paper-library-annotations.jpg)

### 内存与当前范围

插件采用磁盘 SQLite 索引、短时 PDF 进程和单页渲染；检索时不打开 PDF，也没有常驻向量模型或后台全库解析。当前检索覆盖元数据与摘要，尚未提供全文检索或 OCR。

容量验证使用了 2,000 条记录和 1,000 个小型合成文字 PDF，不能替代真实扫描件、大图 PDF 和浏览器总内存测试。[验证方法与结果](https://github.com/Mappedinfo/dsh-paper-library/blob/main/docs/validation.md)已公开。

### 安装

当前为 v0.1 源码版本，需要已构建的本地 DSH checkout（运行时依赖 `>=0.1.5-rc.2 <0.2.0`）、Node、Python 和 uv。按 [README 安装步骤](https://github.com/Mappedinfo/dsh-paper-library#安装与开发)注册到目标 profile，重启 DSH 后打开右侧文献库；目前尚未发布到 npm。

Zotero 中仅保存在数据库里的批注，需要先导出到 PDF 或提供带位置的 JSON。当前不迁移收藏夹层级和独立笔记；WPS 保存往返兼容性尚未验证。

原创代码采用 **MIT**；默认 PyMuPDF、citeproc 运行时涉及 AGPL，CSL 资源保留 CC BY-SA，详见 [第三方许可](https://github.com/Mappedinfo/dsh-paper-library/blob/main/THIRD_PARTY.md)。

欢迎试用，也欢迎反馈导入失败的文件类型、批注兼容性，以及长时间阅读时的内存表现。
