# LaTeX 工作台设计审查

## 目标与方法

面向单人在本机写科研稿件，以「定位文件 → 修改 → 编译 → 复查 → 继续写」为主路径。审查依据包括工作台源码、项目文档及下列公开资料；界面检查使用合成项目，不代表真实用户研究。设计判断遵循项目的目标导向设计和 `frontend-design`：让常用任务获得空间，将异常和下一步放在可发现的位置，保留未保存输入及用户对 AI 修改的决定权。

## 修改前的主要发现

| 发现 | 依据及影响 | 本轮处理 |
| --- | --- | --- |
| 章节／文件／媒体导航固定占用宽度，与 DSH 或自审侧栏共存时压缩源码和 PDF | `web/latex-workspace.css` 和 `web/latex-workspace.js` 的导航与分栏实现；实际可用性仍需目标视口检查 | 导航收合与源码／PDF 专注模式 |
| 原生文本框没有 LaTeX 语法高亮、常用命令补全和编辑器内查找替换 | `web/latex-workspace.js` 原编辑器实现；这些是代码能力观察，不能直接推断使用者困扰程度 | 使用本地打包的 CodeMirror，保留现有写入、批注及定位边界 |
| 界面固定请求 XeLaTeX，虽然后端已支持另外两个引擎 | `web/latex-workspace.js` 编译调用和 `docs/latex-projects.md` 的编译接口 | 提供共享写作偏好，手动及自动编译遵循同一选择 |
| 编译错误在预览下方以文本呈现，文件行号无法直接操作 | `web/latex-workspace.js` 的编译结果处理 | 编译入口旁显示诊断状态；对可核对的项目内文件提供安全定位 |
| 标题说明独占一行；主稿／草稿入口切换作为较大的常驻控件 | 用户在本轮界面审阅中指出，切换编译主文件并非持续写作的高频任务 | 合并标题与操作栏，把主文件切换移入菜单，仅保留当前编译文件提示 |
| 本地自审、AI 提案接受、原子写入与冲突保护已有明确边界 | `docs/latex-self-review.md`、`docs/latex-projects.md` | 编辑器升级时继续复用并验证，不用隐藏式自动改稿替代 |

## 公开项目对照

- [Overleaf 新版编辑器](https://docs.overleaf.com/getting-started/how-do-i-use-overleaf/redesigned-overleaf-editor)将源码、PDF、导航和编译入口围绕写作组织；其[分栏和尺寸选项](https://docs.overleaf.com/navigating-in-the-editor/working-with-the-pdf-viewer/editor-and-pdf-layout-and-sizing)允许调整与隐藏面板。本项目借鉴的是按任务释放空间和保持诊断可见，不要求复制其产品外观。这里的官方文档描述托管产品；[开源 Community Edition 仓库](https://github.com/overleaf/overleaf)与托管服务的功能、部署条件不能等同。
- [TeXstudio](https://github.com/texstudio-org/texstudio) 是本地 LaTeX 编辑器，以源码编辑、结构和预览为中心。本项目可借鉴本地编辑时的即时反馈，同时继续以目录中的源文件为权威。
- [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) 将编译、预览、补全和定位融入通用编辑器。本项目可借鉴编译问题到源码的闭环；其 VS Code 扩展能力与本插件的本地 Web 工作台并不完全可比。

## 有意保留的边界

本轮不建设多人实时协作、云端编译或后台常驻服务，不依赖模型来解释编译失败。项目内搜索、跨文件引用补全和完整 IDE 级语言分析可另行评估，不将单文件搜索或固定命令建议表述为这些能力。SyncTeX、源文件版本及自审批注的有效性仍以已有校验为准。

本轮的设计取舍是：常驻区域服务于正在写、正在看、正在处理的结果；切换编译配置和项目维护进入菜单。导航、自审和 AI 侧栏保留明确入口，可按任务释放空间。源码中的长句允许软换行，编译与保存错误保持可见，未保存的选择不冒充已生效设置。

## 本轮验证（2026-10-28）

- 相关 JavaScript 测试合计 58 项通过，另有 1 项既有的 DSH settings-file 集成因当前测试入口未提供对应已构建模块而跳过；Python LaTeX／导航／自审／lint 测试 68 项通过。构建、语法检查和差异空白检查通过。
- [原工作台浏览器回归](validation/latex-workspace-browser.json) 24 项通过，涵盖 Unicode 源码选区、自审入口、保存冲突、文件／项目对比、自动编译及 AI 提案先审后写。模型使用确定性替身，浏览器外部请求为 0。
- `scripts/latex-desktop-fixture.mjs` 在真实独立服务和 Chromium 的 1512×982 视口完成 7 组检查：单行工具栏与侧栏、导航和专注视图、三引擎真实编译、双向 SyncTeX、键盘输入／命令建议／撤销重做／替换落盘、跨文件错误定位和修改后恢复编译、深浅主题。截图经过人工可见检查，全部资料和截图在临时目录。
- 浏览器检查发现并修复了连续设置写入相互覆盖，以及文件读取中返回原文件会被迟到结果顶掉的问题。检查并未使用私人稿件或真实模型，也不代表已完成当前用户 DSH 宿主或真机输入法验收。
- `npm pack --dry-run` 核对编辑器 bundle、许可声明和本报告包含在分发文件中；没有执行发布。

复跑：先执行 `npm run build`；设置 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs` 后执行 `node scripts/latex-desktop-fixture.mjs`。
原有流程执行 `LATEX_FIXTURE_OUTPUT=/tmp/latex-workbench-check node scripts/latex-workspace-fixture.mjs`（同样设置 Playwright 路径），可将截图和回执留在临时目录。
