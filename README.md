# Paper Library

独立于 Zotero 的 DeepSeek Harness 文献插件：检索、阅读、引用、PDF 批注与 AI 反馈。

**继续开发前先读 [项目交接](HANDOFF.md)**，其中记录当前能力、验证证据和待验证项。

## 使用

本机已通过 Harness 官方插件命令安装到现有 `web` profile。重启 Harness 后，在右侧面板的入口页选择 **文献库 / Paper Library**。启动时不会导入或扫描现有 Zotero 文献。

1. 点击「导入文献」，输入 DOI、本地 PDF/目录路径，或上传 JSON、RIS、BibTeX。目录和元数据按每批 100 条继续处理，显示累计进度；每条记录保存检查点。
2. 搜索标题、作者、年份、DOI、引用键、标签或摘要，打开论文；一次只显示一页。
3. 选中文字后点击「高亮并批注」，或添加页批注。保存完成后批注已写进管理副本 PDF。
4. 「复制 APA 7」同时提供富文本和纯文本；「导出 BibLaTeX」导出当前文献，「导出文献库」导出全库。
5. 在「知识图谱」中查看标签关系，并明确记录相关、支持、矛盾或引用关系及依据。图中关系不会自动被当作学术证据。
6. 在「批注」中获取反馈，默认自动跟随当前 DSH 会话的模型和推理强度，复用 Harness 的服务配置。切换模型会同步更新，保留当前 PDF 和批注草稿；模型加载期间暂停请求。开启「每次保存批注后自动请求 AI 反馈」后，新批注会触发调用。发送内容限于选定批注及其上下文，响应标记为 AI 生成并写入 PDF。

资料库默认在 `~/.local/share/dsh-paper-library`。PDF 导入时复制到该目录；原件不修改。关闭 Zotero 后可以继续使用全部本地功能；独立网页模式的 AI 调用需要 Harness 接入。

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

没有常驻向量模型、后台 OCR 或全库 PDF 预解析。目前快速检索覆盖元数据和摘要，**不包含全文检索**。这是当前版本的功能边界，不能据此判断 Zotero 的高内存原因。

实测数据与方法见 [验证记录](docs/validation.md)。其中区分 Python 内核、Node 适配器、Harness 主进程和未测量的浏览器。合成文件是小型文字 PDF，不能代替真实扫描件/大图 PDF 的容量验证。

## 安装与开发

Node `^22.19 || >=24`、Python `>=3.11`、`uv` 和已构建的本地 DeepSeek Harness。

```sh
npm ci --ignore-scripts --legacy-peer-deps
uv sync --locked
npm run build
node scripts/install-harness.mjs --harness /absolute/deepseek-harness --home /absolute/dsh-home --profile web
```

不传 `--home` 时安装脚本使用项目内隔离 profile；不会默默修改用户全局配置。脚本仅链接声明的 Harness 运行时依赖，并调用官方插件命令注册。重装依赖后可重新运行它恢复本地依赖链接。包保持 `private: true`，尚未发布。

独立本地界面与 JSON CLI：

```sh
npm start -- --library /absolute/library --port 43121
node src/cli.mjs --library /absolute/library < request.json
```

默认服务仅监听 `127.0.0.1`，拒绝跨来源写入；Harness 内使用其现有认证服务。AI 不读取其他应用的密钥，不创建第二套服务配置。部署配置支持绝对路径 `library`、`python`，以及 `provider`、`model`、`maxOutputTokens`。详见 [API](docs/api.md) 与 `cordis.patch.yml`。

验证命令：

```sh
node scripts/validate.mjs
npm run test:harness
uv run python scripts/benchmark.py --output artifacts/capacity-new
node --expose-gc scripts/benchmark-node.mjs artifacts/capacity-new/library artifacts/capacity-new/node-report.json
```

测试使用合成数据，产物与文献目录不进入 Git。CSL 使用官方 APA 样式与 `citeproc-js`，BibLaTeX 使用 Citation.js；出处和许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。项目代码使用 AGPL-3.0-or-later。
