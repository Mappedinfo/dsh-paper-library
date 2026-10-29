# Slides 工作台

Paper Library 内集成 PlainDeck，用于本机制作演示文稿。DSH「开始」页选择 **Slides 工作台**；文献库顶部的 **Slides** 也可打开独立标签。独立服务使用 `/slides.html`，DSH 路径为 `/api/paper-library/slides.html`。

## 制作与保存

在项目页填写名称并选择空白、论文阅读、方法汇报、数据叙事、课程、流程或提案模板。打开后可编辑文字、拖动元素、添加图片／原生表格／摘要卡片、调整版式和主题；保留 PlainDeck 的撤销重做、键盘移动、复制元素和缩放操作。

- 停止编辑约 700 ms 后自动保存；保存按钮或 `⌘/Ctrl-S` 立即保存。项目标题显示在工作台中，可返回项目列表或文献库。
- 图片可从工具栏选择、拖入画布或粘贴，保存到项目的 `assets/`；支持 PNG、JPEG、WebP、GIF，每张最多 8 MiB。SVG 图片暂不导入，上游的固定图片占位符继续可用。
- 「制作指导」提供听众、目的、时长、核心主张和证据深度，生成可复制的制作提示词，列出可定位的审阅提示；简报保存在当前主机项目中。提示不代表内容已经人工核验，也不发起模型请求。
- 「放映」支持方向键切页、Esc 退出。「导出」提供可独立打开的 HTML、可重新编辑的 PlainDeck ZIP，以及浏览器打印／保存 PDF。导出包含当前草稿。没有 PPTX 或视频导出入口。

项目位于当前资料库的 `slides/pd-<标识>/`，保持 `deck.json`、`theme.json`、`slides/*.json` 和 `assets/` 的 PlainDeck 布局；项目登记和制作简报分别保存在隐藏的 `.paper-library.json`、`.presentation-brief.json`。没有把演示内容保存在 localStorage、IndexedDB、OPFS 或浏览器缓存中。无需额外服务进程。

## 打开既有 PlainDeck 项目

从原编辑器导出 ZIP，再从本工作台导入；原目录不受修改。导入的图片复制到资料库，页面记录使用本项目内路径。ZIP 最多 8 MiB、200 文件、解压内容最多 16 MiB；单个文件最多 8 MiB。不接受路径穿越、外部图片、任意 SVG、ZIP64 和分卷包。字体与颜色限定为本机字体名称及颜色值，避免导出的独立 HTML 携带外部资源或样式注入。

单个演示最多 100 页、5000 元素、8 MiB 源码；超过限制会拒绝保存或导入，保留现有内容。项目列表分批加载，扫描上限 1000 个项目。图片读取和写入限定在对应受管项目中，拒绝符号链接重定向。

## 冲突与恢复

保存携带读入版本；另一窗口或外部编辑器修改后，旧版本保存会被拒绝，当前草稿留在界面，提供重试、导出以及显式放弃并重新读取。保存失败或简报仍有未保存改动时，项目切换会暂停。切换 DSH 标签时，Slides 的 iframe 保持挂载，以便继续保存并保留失败草稿。关闭页面之前应确认已保存，或先导出草稿。

读写按项目排他，避免读到保存中间状态；每个文件通过临时文件同步并原子替换，普通保存错误尝试回滚。本轮没有实现断电级的多文件事务日志；进程意外退出留下的 `.paper-library.lock` 会阻止后续写入并显示错误，不会擅自移除未知写入锁。

## 子项目与升级

采用 **固定提交的源码子项目**，放在 [`vendor/plaindeck/`](../vendor/plaindeck/README.md)。上游为 [Mappedinfo/PlainDeck](https://github.com/Mappedinfo/PlainDeck)，本轮固定 `95356c109f0d79e0a1547ef5a9a7c521b2262780`；编辑器、core、React 渲染器与 HTML 渲染器来自同一提交。该提交包含 `0.10.0` 标签之后的制作指导，不能混用 registry 的 `plaindeck@0.10.0` core。

| 方案 | 本轮判断 |
| --- | --- |
| Git submodule | 克隆和 npm 分发需要额外处理子模块内容，不利于直接安装 |
| 仅依赖 npm 包 | 当前包不包含完整 Web 编辑器，且与本地编辑器版本不同 |
| 固定源码子项目 | 构建和分发自包含，上游代码保持原样，宿主适配层单独维护 |

宿主适配位于 `src/slides/`、`src/slides-store.mjs`；现有 esbuild 构建把浏览器目录存储和语言偏好替换为项目 API 与内存状态，不引入上游 PWA、分析埋点或浏览器草稿。上游 MIT、Juya 及运行依赖许可均保留。本轮不修改 AnyPre 工作区、不读取其 `projects/`，也不修改 DSH 源码。

更新固定提交后按白名单重新提取；更新脚本仅使用 Git 对象，未跟踪文件不会进入快照：

```sh
node scripts/vendor-plaindeck.mjs --source /path/to/PlainDeck --check
npm run build
npm run typecheck:slides
node --test tests-js/slides-store.test.mjs tests-js/slides-http.test.mjs src/slides/*.test.mjs
```

检查范围包括合成项目持久化、并发保存冲突、路径边界、图片与简报、ZIP 往返和切换保护；代码检查不能代替实际的用户界面验收。

合成 DOM 组件测试可设置 `JSDOM_MODULE=/path/to/jsdom` 复用已安装的 jsdom；未设置时明确跳过这两项，不下载浏览器、不连接用户标签页。

运行中的 DSH 另有 `scripts/slides-live-fixture.mjs` 实际浏览器检查：通过进程环境提供 `DSH_TEST_LAUNCH_URL` 和已安装的 `PLAYWRIGHT_MODULE`，在隔离的 1512×982 Chromium 会话中验证编辑、保存、冲突恢复、图片、表格、卡片、简报、放映和导出，以及浅深色控件对比度。仅打开本轮创建的合成项目，截图和下载写入临时目录，不操作已有用户标签页；热重载由原生插件管理器单独执行。检查结束会报告本轮项目标识，供保留示例及限定清理。浏览器打印布局检查不代替系统打印对话框验收。
