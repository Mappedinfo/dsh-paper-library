# PlainDeck 源码子项目

此目录固定复用 [Mappedinfo/PlainDeck](https://github.com/Mappedinfo/PlainDeck) 的提交 `95356c109f0d79e0a1547ef5a9a7c521b2262780`，保留上游相对目录结构和许可。它是 Paper Library 的 slides 编辑器基础；宿主 API、主机持久化、项目切换和入口适配放在主仓库 `src/slides/`，不直接修改本目录的上游文件。

当前上游包声明为 0.10.0，但固定提交包含该标签之后的制作指导与布局修复。Web、core、render、react 必须一起更新，不能把本目录的编辑器配上 registry 0.10.0 的核心包。构建别名分别使用：

- `plaindeck/core` → `packages/plaindeck/src/core/index.ts`
- `plaindeck/render` → `packages/plaindeck/src/render/index.ts`
- `plaindeck/react` → `packages/plaindeck/src/react/index.tsx`

## 来源与范围

`UPSTREAM.json` 记录提交和精确文件清单。快照只含受控的 `src/` 非测试源码、核心／HTML 渲染／React 渲染源码、包元数据与许可；不读取或复制上游 `projects/`、个人稿件、运行依赖、演示导出或构建产物。用户提供的本地参考 clone 名为 AnyPre。

上游 `src/main.tsx`、浏览器目录／OPFS／IndexedDB／localStorage 存储与分析入口保留为未改动的来源文件；Paper Library 使用自己的入口和存储桥，不调用这些上游持久化及分析功能。Node 的 Playwright 渲染文件也不作为浏览器入口，不因此安装或启动额外服务。

## 核对与升级

在主仓库运行：

```sh
node scripts/vendor-plaindeck.mjs --source /path/to/AnyPre --check
```

要升级，先审查上游变更，再修改 `scripts/vendor-plaindeck.mjs` 中的固定 revision，执行同一命令去掉 `--check`。脚本仅通过 `git ls-tree` 与 `git show` 读取固定提交的白名单，更新其拥有的快照文件和来源说明；不会读取上游工作区，也不会覆盖 `src/slides/` 集成层。之后检查 diff，运行 Paper Library 的相关 slides 测试与构建，再提交快照与集成改动。无需 Git 子模块初始化或额外下载已编译前端。

## 许可

原创代码为 [MIT](LICENSE)。包的 [第三方声明](packages/plaindeck/THIRD_PARTY_NOTICES.md) 保留 juya-news-card 派生设计目录等来源。React、zustand、lucide-react、JSZip、zod 等实际构建依赖继续按各自许可分发，由 Paper Library 的依赖与第三方声明统一维护。
