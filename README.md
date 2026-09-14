# Paper Library

独立于 Zotero 的 DeepSeek Harness 文献插件：自动获取与归档、检索、阅读、引用、PDF 批注，以及每篇论文自己的 DSH 对话。

[DSH 社区介绍与讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/6623)包含合成演示截图与当前能力说明。

项目原创代码采用 [MIT](LICENSE)。默认 PDF 引擎 PyMuPDF 采用 AGPL/商业许可，CSL 等第三方组件保留原许可；完整安装的依赖栈并非仅受 MIT 约束。详见 [第三方许可](THIRD_PARTY.md)。

**继续开发前先读 [项目交接](HANDOFF.md)**，其中记录当前能力、验证证据和待验证项。

## 使用

按下方步骤安装到 Harness profile 后，重启 Harness，在右侧面板的入口页选择 **文献库 / Paper Library**。启动时不会导入或扫描现有 Zotero 文献。

1. **把 PDF 拖入窗口，或粘贴论文链接 / DOI**，自动下载或复制、解析并保存。支持多文件顺序导入；也可点击「导入文献」选择文件、输入本地路径，或导入 JSON、RIS、BibTeX。目录和元数据按每批 100 条继续处理，显示累计进度；每条记录保存检查点。
2. 搜索标题、作者、年份、DOI、引用键、标签或摘要，打开论文；一次只显示一页。
3. 选中文字后点击「高亮并批注」，或添加页批注。保存完成后批注已写进管理副本 PDF。
4. 「复制 APA 7」同时提供富文本和纯文本；「导出 BibLaTeX」导出当前文献，「导出文献库」导出全库。
5. 在「知识图谱」中查看标签关系，并明确记录相关、支持、矛盾或引用关系及依据。图中关系不会自动被当作学术证据。
6. 打开论文时，插件自动建立或复用这篇论文的 **DSH 对话**。在「对话」中直接追问，或从批注、选中文本开始讨论；插件内与 DSH 主页面使用同一段历史。
7. 点击「放入主输入框」将引用内容追加到论文主对话的草稿中，由你编辑、发送。也可以「保存并放入主对话」。仅准备草稿不会调用模型；「发送到论文对话」和可选的「保存批注后自动发送到论文对话」会使用模型额度。
8. 对需要随文献携带的回复，点击「保存这条回复到 PDF」。保存的是该论文对话中已完成的 AI 原文，并记录会话与消息标识；再次保存同一回复会复用已有批注。

资料库默认在 `~/.local/share/dsh-paper-library`。PDF 导入时复制到该目录；原件不修改。关闭 Zotero 后可以继续使用全部本地功能。论文对话需要从 Harness 面板使用；独立网页模式保留文献管理和阅读能力。

## 论文对话

首次建立论文对话时，沿用当时 DSH 会话可读取的模型选择和推理强度；没有来源选择时采用 Harness 默认。之后由这篇论文的主对话管理模型，插件显示其实际选择。模型服务、对话历史、工具执行和权限处理均由 Harness 提供。需要查看完整历史、处理工具权限或停止回复时，点击「打开主对话」。

尚未发送消息时，对话已经保存，但 DSH 侧栏会隐藏非当前的空对话，当前空对话则显示「新会话」并收起主页面标题栏。可以从论文的「打开主对话」进入；首次发送后，侧栏会正常显示论文标题。

插件内只显示最近最多 20 条已提交的用户／AI 文本，每条最多 6,000 字符，总计最多 48,000 字符。批注和选文以可读引用进入对话，带上题名、引用键、真实页码及批注标识，与你的问题分别呈现；没有发送整篇 PDF 时不会据此声称已经阅读全文。AI 回复仍需由读者判断。

对话历史保存在 Harness，标准批注和明确保存的 AI 回复保存在 PDF。保存 AI 回复时保留原生会话／消息来源，当前不自动推断它与某条批注的对应关系。插件不把完整对话反复写入 PDF。归档的论文对话会显示状态；当前 Harness 没有供插件调用的恢复归档接口，插件不会自动复制对话。移动文献库目录后，目前不会自动迁移原来的论文会话对应关系。

## 自动获取与命名

支持公开 PDF 直链、DOI、arXiv 链接，以及带论文下载元数据的页面。文件按流写入磁盘，再用 PDF 解析器检查可读性。默认读取最多前三页和文件内元数据；检测到 DOI 时，在线题名必须与 PDF 解析标题匹配，才补全作者、年份等字段。不会因正文出现了另一篇论文的 DOI 就替换当前资料。

管理副本命名为 `作者-年份-标题--稳定标识.pdf`；缺失作者或年份使用 `unknown-author` / `undated`，显示“资料待核对”。编辑资料后文件名随之更新。来源链接、获取记录和解析依据保留在条目及 PDF 内。仅取得元数据时明确显示“尚未取得 PDF”，可以稍后补入已有文件。

插件内置 `paper-fetch-skill` 的独立文献库版本：[paper-library-fetch](skills/paper-library-fetch/SKILL.md)，通过 Harness 技能目录提供给当前会话。可以在 DSH 中要求“用 paper-library-fetch 把这个 DOI / 链接的论文保存到文献库”，技能调用插件的 `library_import`，继续使用会话现有模型。内置公开下载流程，不需要额外安装 Zotero、MCP 服务或浏览器抓取运行时。改编来源见 [出处记录](docs/upstream-manifest.md)。

导入队列最多 50 项，PDF 上限 250 MiB。一次失败不会阻断后续文件，结果面板提供重试或重新拖入提示。扫描件暂不自动 OCR；需要登录、验证码或付费的页面可能只能取得元数据，此时使用已有合法 PDF 继续导入。

## 从 Zotero 迁移

支持 CSL JSON、Zotero/Better BibTeX 风格 JSON 的 `items` 数组、RIS 和 BibTeX。带 `attachments[].path` 的 JSON 可保留相对目录结构并一并复制 PDF；保留 `citationKey` / `citation-key` / `Citation Key:`。BibTeX、RIS、CSL JSON 主要用于文献元数据，不能保证携带附件和原生批注。

**只有 Zotero 数据库中存在的批注，需要先导出到 PDF，或提供带位置数据的 JSON。** 原样复制 Zotero 存储目录中的 PDF 不一定带有这些批注；[Zotero 官方说明](https://www.zotero.org/support/kb/annotations_in_database)对此有明确区分。插件可读取已嵌入的外部批注，也可导入 JSON 中带 `annotationPosition` 的高亮和文字批注；缺少坐标会显示警告。

导入前保留 Zotero 原库及导出副本。重复 DOI、同来源引用键、相同 PDF 哈希会去重；引用键与不同论文发生冲突时明确跳过并报告，避免误合并。当前不迁移 Zotero 收藏夹层级、独立笔记、快照附件或文字处理器中的动态引用字段。

## 批注跟随 PDF 的方式

- 标准 PDF `/Highlight`、`/Text` 对象保存高亮和评论，`/Contents` 是普通可读评论；包含作者、日期、标识与坐标。
- CSL 元数据作为 `paper-library.csl.json` 内嵌附件保存，复制 PDF 后重新导入可恢复标题和引用键。
- 支持导出 XFDF、JSON 和 Markdown。PDF 中的批注为权威数据，检索目录不会替代它。
- 写入前保留上一版 PDF 到资料库 `backups/`，验证新文件后原子替换；每篇仅保留一个上一版备份。恢复时关闭该文件，复制对应备份覆盖管理副本后刷新。
- 加密、带签名及需修复的 PDF 拒绝写入。外部阅读器可能改写或删除自定义元数据，原生高亮和评论仍按标准对象读取。

已通过 PDF 复制至新位置、导入全新资料库后的批注恢复测试。**WPS 的实际保存往返尚未验证**；本机原生应用自动化未成功完成打开副本，因此没有将格式测试宣称为 WPS 兼容性认证。当前没有 WPS 动态引用插件。

## 内存设计与验证

按约 **2,000 条记录、1,000 个 PDF** 设计验证规模。SQLite FTS5 trigram 索引在磁盘，缓存预算 2 MiB；短于 3 字符的查询使用字面检索回退。检索不会打开 PDF。PDF 渲染、修改和 CSL 引用格式化均使用短时进程，完成后退出；界面只保留当前页，隐藏 Harness 阅读面板时卸载 iframe。

PDF 上传和下载均使用流式处理，不做整份 Base64 拷贝。服务器限制同时接收的 PDF / JSON 请求，导入队列还设有独立载荷预算，避免大量排队的元数据文件持续占用内存。下载和资料补全只在导入时触发。

打开论文时只保存一个轻量的原生对话记录，不启动 Agent 或调用模型；不会在批量导入时为所有文献启动对话。插件只在当前对话视图可见时刷新有限历史，隐藏后停止刷新。真正打开 DSH 主对话或发送消息后，Agent 的驻留与释放由 Harness 管理；当前未测量大量已激活对话长期阅读后的总内存。

没有常驻向量模型、后台 OCR 或全库 PDF 预解析。目前快速检索覆盖元数据和摘要，**不包含全文检索**。这是当前版本的功能边界，不能据此判断 Zotero 的高内存原因。

实测数据与方法见 [验证记录](docs/validation.md)。其中区分 Python 内核、Node 适配器、Harness 主进程和未测量的浏览器。合成文件是小型文字 PDF，不能代替真实扫描件/大图 PDF 的容量验证。

## 安装与开发

Node `^22.19 || >=24`、Python `>=3.11`、`uv` 和已构建的本地 DeepSeek Harness。

```sh
git clone https://github.com/mappedinfo/dsh-paper-library.git
cd dsh-paper-library
npm ci --ignore-scripts --legacy-peer-deps
uv sync --locked
npm run build
node scripts/install-harness.mjs --harness /absolute/deepseek-harness --home /absolute/dsh-home --profile web
```

将示例中的路径替换为本地已构建的 Harness checkout 和目标 DSH 配置目录。不传 `--home` 时安装脚本使用项目内隔离 profile；不会默默修改用户全局配置。脚本仅链接声明的 Harness 运行时依赖，并调用官方插件命令注册。重装依赖后可重新运行它恢复本地依赖链接。源码通过 GitHub 发布；`private: true` 仅防止意外发布到 npm。

独立本地界面与 JSON CLI：

```sh
npm start -- --library /absolute/library --port 43121
node src/cli.mjs --library /absolute/library < request.json
```

默认服务仅监听 `127.0.0.1`，拒绝跨来源写入；Harness 内使用其现有认证服务。论文对话不读取其他应用的密钥，不创建第二套服务配置。部署配置支持绝对路径 `library`、`python`；`provider`、`model`、`maxOutputTokens` 保留给原有独立反馈 API，论文对话使用 Harness 自身的会话配置。详见 [API](docs/api.md) 与 `cordis.patch.yml`。

验证命令：

```sh
node scripts/validate.mjs
npm run test:harness
uv run python scripts/benchmark.py --output artifacts/capacity-new
node --expose-gc scripts/benchmark-node.mjs artifacts/capacity-new/library artifacts/capacity-new/node-report.json
```

测试使用合成数据，产物与文献目录不进入 Git。CSL 使用官方 APA 样式与 `citeproc-js`，BibLaTeX 使用 Citation.js；出处、版权声明及依赖的许可义务见 [THIRD_PARTY.md](THIRD_PARTY.md)。

论文对话已通过 101 项 JavaScript、39 项 Python 测试，以及隔离 Harness 的原生会话和浏览器交互检查，包含主输入框草稿保留、同一论文历史接续、页码恢复与 PDF 回复保存。现有安装已升级并重启，通过认证接口及客户端资源检查；原生 PWA 已显示新版入口并重新打开文献库面板。完整阅读交互使用合成文献验证，未打开用户论文或调用其模型。具体证据见 [验证记录](docs/validation.md)。
