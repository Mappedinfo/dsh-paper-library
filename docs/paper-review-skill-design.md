# 论文自动解析与评审技能：设计契约

2026-09-20。性质：设计契约（已实施）。范围：把既有的严苛评审方法论内置为**随插件发布的通用技能**，把**个人定制**留在使用方自己的私有仓库，并让插件在后台整理论文时**自动**产出一份证据图谱评审草稿。

## 1. 目标与来源

- 来源：先前开发记录中被升级过的 `strict-phd-reviewer`（本地 commit `87197c688`、`95d4de20e`），其核心是六组评审方法论，已集中在 `references/evidence-atlas-review.md`：案例拆分 + 八维编码、attribution 三态、结构化缺失、联合覆盖反拼接、形容词操作化、逐项状态机 + 自检反例。
- 目标一：这些方法论作为**通用技能**随插件发布，任何使用者开箱可用。
- 目标二：**个人定制**（阶段标准、目标期刊、评分偏好、配对评审协议、质量记录）不进插件仓库，留在使用方的私有仓库，由插件按显式配置读取。
- 目标三：插件在后台整理 PDF 时**自动**生成一份评审草稿，供读者逐条核对（AI 产物，一律待审阅）。

## 2. 通用 / 个人边界

| | 通用（随插件发布） | 个人（使用方私有仓库） |
|---|---|---|
| 存放 | `skills/paper-library-review/`（SKILL.md + references） | 例如 `.../skills/strict-phd-reviewer/references/personal-overlay.md` |
| 内容 | 评审流程、量表、报告模板、证据图谱方法、自动解析契约 | 阶段标准、目标期刊、评分偏好、配对评审协议、质量/学习索引、导师与项目信息 |
| 读取 | DSH 技能注册表（`ctx.skills.register`） | 插件配置 `reviewProfile` 指向的本地文件 |
| 约束 | 不含个人标识、私有路径、私有质量记录 | 不得放宽通用硬约束 |

硬约束（任何覆盖层都不能放宽）：逐字引用与真实页码、摘要形容词只能算作者声称、缺失必须结构化、联合声称必须由同一案例/配置/协议支撑、未操作化的阈值为 `unassessable`、AI 产物一律待审阅。

`tests-js/bundled-skill-generic.test.mjs` 是这条边界的守卫：扫描内置技能的所有 Markdown，出现个人姓名、私有仓库/质量记录路径、私有组合技能或绝对家目录路径即失败。

## 3. 内置技能内容

`skills/paper-library-review/SKILL.md`（通用，加载预算 16,000 字符）：

1. 何时使用；2. 只用库里的真实材料（`library_resources`、`library_knowledge`、`library_annotations`、`library_challenges`）；3. 九步工作流（快速判定 → A/X/P/Y/E/C → gap/贡献 → **证据与联合覆盖审计** → 设计审计 → 阶段成熟度 → 评分与否决 → 修改清单 → 红队问题）；4. 输出规则（归因 + 案例绑定的结论边界三段式）；5. 参考文件索引；6. 通用/个人边界。

`references/`：`evidence-atlas-review.md`（方法本体）、`review-rubric.md`（量表与否决项）、`output-template.md`（14 节报告模板）、`auto-parse.md`（自动解析契约与覆盖层配置）。

## 4. 自动解析管线

在既有 `paper_analysis` 作业末尾新增一个**受限评审阶段**（与精读笔记并列）：

```
批次图谱草稿（已提交，逐批落盘）
        │
精读笔记（1 次模型调用）
        │
证据图谱评审（1 次模型调用，可关闭）
   输入：同一份 bounded 批次投影（≤24,000 字符）+ 可选个人覆盖层（≤8,000 字符）
   输出：{title（≤40 字符，以 证据图谱评审 开头）, body（Markdown，≤64,000 字节，含 9 个必需小节）}
        │
knowledge_draft_put(mode:note, origin:llm, status:needs-review)
```

- 触发：`paper_analysis_start` 的 `review` 参数（默认 true）；实时偏好 `auto_review`（默认 true）由客户端与自动排队路径传入。
- 失败语义：缺少必需小节、超预算、无可用来源都会让该阶段失败，**只记为作业警告**，不影响图谱与笔记，也不会覆盖已保存内容。
- 不新增 PDF 读取、不做 OCR、不使用第二套模型配置：路由沿用该论文在 DSH 中的模型。
- 幂等：`request_id = analysis-review-<hash(id, request_id)>`；同一请求重复提交返回已保存草稿，不重放模型。

## 5. 个人覆盖层注入

- 配置：插件 config `reviewProfile`（部署侧，绝对文件路径，可选），DSH 补丁示例 `reviewProfile: !!js process.env.DSH_PAPER_LIBRARY_REVIEW_PROFILE`。
- 读取：每次评审生成时读取一次；>`8,000` 字符截断并记录 `truncated`；读取失败只记录错误并跳过覆盖层。
- 记录：作业返回 `review_profile = {path, characters, truncated, error?}`，界面对读者展示（路径 + 字符数 + 是否截断）；未配置时为 `null`。
- 提示词把覆盖层包在 `PERSONAL_REVIEW_OVERLAY` 标记内，并声明它只能调整阶段标准、期刊与侧重，不能放宽硬约束。

## 6. 结果与界面

- `paper_analysis_get` 新增 `review_draft_id`、`review_coverage`、`review_profile`。
- 「后台整理」面板：新增「完成后生成证据图谱评审草稿」开关（`#analysis-auto-review`，偏好 `auto_review`），完成后显示草稿与覆盖层信息，并提供打开知识工作流的入口。
- 草稿在「知识笔记」工作流中逐条核对；接受与否决由读者完成。

## 7. 验证

| 层次 | 证据 |
|---|---|
| 单元（宿主） | `tests-js/paper-analysis.test.mjs`：草稿字段与受限来源、覆盖层注入与截断、不可用覆盖层 + 缺小节报告只留警告、`review:false` 跳过、选项校验 |
| 技能边界 | `tests-js/bundled-skill.test.mjs`（注册与参考文件齐全）、`tests-js/bundled-skill-generic.test.mjs`（无个人内容） |
| 浏览器 | `scripts/paper-analysis-browser-fixture.mjs`：开关默认值、完成后显示评审草稿、刷新后恢复偏好（9 项检查） |
| 原生宿主 | `scripts/paper-analysis-harness-smoke.mjs`：真实隔离 DSH 主机 + 确定性夹具，断言评审草稿为 `needs-review`、9 个小节齐全、每个生成都有独立隔离子代理、零外部模型请求（10 项检查） |

## 8. 不做的事

- 不做机器可读的案例节点图（阶段二候选）：当前只产出 Markdown 评审草稿，案例/归因写在正文里。
- 不引入向量库、常驻服务或第二套模型/密钥配置。
- 不自动接受草稿、不自动写入知识正文；个人覆盖层不随插件发布，也不被插件发现式搜索。
