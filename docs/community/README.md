# Community showcase

`showcase.md` and `showcase.json` are the reviewed post for the upstream
[plugin category](https://github.com/deepseek-ai/deepseek-harness/discussions/2004).
`discussion.json` records the published topic only after remote readback succeeds.

## Reproduce the screenshots

The project showcase leads with the complete literature-to-writing workflow.
Its current screenshots are direct Chromium captures, using only synthetic
documents and isolated state:

| Views | Reproduction | Provenance and checks |
| --- | --- | --- |
| Current library, PDF annotations and learning-loop board | `node scripts/capture-learning-demo.mjs` | [Learning demo](learning-demo.md) and `learning-demo.json` |
| Current LaTeX workspace with a successfully compiled PDF | `node scripts/capture-latex-demo.mjs` | [LaTeX demo](latex-demo.md) and `latex-demo.json` |
| Contextual handwriting, saved preview and ink location | `node scripts/capture-handwriting-demo.mjs` | [Handwriting demo](handwriting-demo.md) and `handwriting-demo.json` |

The scripts use the shipped pages, controls and persistence paths. Images have
no retouching or injected layout; no private library or real model reply is
shown. LaTeX compilation uses a real local TeX installation. Handwriting uses
deterministic browser pen input, not a physical Pencil trial. The model rail in
the standalone LaTeX demonstration accurately reports its missing connection.

Public demonstration content is restricted to generic learning methods, such as
how to read, think and write. Private research topics, plans, sources and project
structures must never be used as demonstration material.

## Release announcements

`release-v0.1.0.md` and `release-v0.2.0.md` are the reviewed comments that
announce one release each on the existing discussion (`showcase.json` points at
the newest one); `discussion-comments.json` records each published comment only
after remote readback. `node scripts/announce-release.mjs` runs preflight
without arguments, posts only when no comment with the same body hash exists
(`--publish`) and re-reads the recorded comment (`--verify`). The discussion is
never recreated and a published comment is never rewritten: a changed body needs
a new reviewed file and a new receipt, so history stays auditable.

## Publication

Publish the reviewed screenshots to the source repository before running the
discussion tool. With maintainer authorization, `--publish` creates a missing
discussion; `--update` updates only the existing topic in a verified local
receipt. Project showcase updates edit Discussion #6623 in place, keeping
its comments and release history.

```sh
node scripts/publish-discussion.mjs --update
node scripts/publish-discussion.mjs --verify
```

An update checks the recorded identity and the last verified title/body before
writing. Unexpected remote changes stop the update for review. GitHub does not
offer an atomic revision condition on this mutation; the script checks the
latest remote copy immediately before the request. A retry after uncertain
readback recognizes an already-applied update and does not submit it again.
The tool compares public image bytes, title, body, author, repository and category
before recording success. `--verify` reads the saved topic without changing it.

## 使用说明演示与主题更新（2026-11-06）

`docs/demo/` 的说明主稿、PDF、PlainDeck 源项目与 PPTX 共用公开的使用说明。`scripts/build-user-guide.mjs` 生成文件，`scripts/capture-guide-demo.mjs` 用隔离合成库操作实际主题开关并写入一条 PDF 批注。[复现与验证边界](../demo/README.md)。

`update-2026-11-06.md` 是现有讨论下的新进展评论，`update-2026-11-06.json` 保存发布回执；旧发版评论保持原样。当前 `showcase.json` 指向这份新评论，仍由 `announce-release.mjs --publish` 发布并读回核对。主帖由 `publish-discussion.mjs --update` 更新。先推送演示文件，再发布下载链接。

## 仓库首页与讨论更新（2026-11-09）

README 顶部使用实时 npm 版本／下载量徽章，以及 DSH 社区插件、讨论和原创代码许可入口。GitHub About 的网站指向 Discussion #6623；Topics 包括 dsh、deepseek-harness、deepseek-harness-plugin、文献管理、PDF 批注、图谱、LaTeX 与 PlainDeck。包源码补齐 keywords，需下次 npm 发版才更新到 registry。

本次原位更新 `showcase.md` 主帖与标题，保留既有截图及评论历史；没有另发重复宣传评论。近期功能说明以 main 为准，npm registry 核实仍为 0.2.5，未发布新包，也未修改 npm dist-tags。发布脚本读回核对后的回执仍保存在 `discussion.json`。

## 英文介绍

英文首页位于 [README.en.md](../../README.en.md)，中文首页保留并提供双向切换。英文宣传稿单独存放在 [showcase.en.md](showcase.en.md)，按用户选择作为现有 Discussion #6623 下的新评论发布，不替换中文主帖。下载演示仍为中文，英文稿已明确说明。

以下命令复用现有发布器；不带 `--publish` 时只做预检，正文与回执参数必须成对指定。历史更新仍使用 `showcase.json` 中的默认路径。

```sh
node scripts/announce-release.mjs --body docs/community/showcase.en.md --receipt docs/community/discussion.en.json
node scripts/announce-release.mjs --body docs/community/showcase.en.md --receipt docs/community/discussion.en.json --publish
node scripts/announce-release.mjs --body docs/community/showcase.en.md --receipt docs/community/discussion.en.json --verify
```

发布后 `discussion.en.json` 保存评论地址与远端核对结果；重复运行相同正文不会再发一条评论。既有中文主帖与历史更新评论不被修改。
