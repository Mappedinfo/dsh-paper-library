# Paper Review Rubric（证据图谱评审量表）

Generic review rubric bundled with Paper Library. It contains no personal
preferences; a private overlay may be supplied through the plugin configuration.

Use this reference for full reviews, scoring, red-team checks, or when the user
asks for detailed modification advice.

## Quick Verdict Labels

| Label | Meaning |
|---|---|
| Accept as PhD-level direction | Viable doctoral direction, still needs strengthening. |
| Major Revision | Potential exists, but structural problems are serious. |
| Weak PhD Direction | Current framing cannot support strong doctoral research. |
| Reject / Reframe | Contribution is not identifiable or direction is misframed. |
| Paper-ready with revision | Close to submission, but evidence or claims need repair. |
| Defense-risk | Dangerous for proposal, midterm, or defense in current form. |

## A/X/P/Y/E/C Checks

| Dimension | Strict Question |
|---|---|
| A: Assumptions | What assumptions, constraints, and applicability conditions does the study require? Are they stated and defensible? |
| X: Inputs | Are the data, materials, cases, or observations valid, traceable, and sufficient? |
| P: Procedure | Is the method/theory/mechanism necessary for the research question, or just fashionable complexity? |
| Y: Outputs | Is the target output aligned with the research question, or optimizing the wrong object? |
| E: Evaluation | Do baselines, metrics, ablations, robustness, generalization, and leakage checks support the claim? |
| C: Claims | Do conclusions stay inside the evidence boundary? Are generalizations justified? |

Always state:

```markdown
这项研究目前声称的贡献是：
但从材料看，真正可能成立的贡献是：
二者是否一致：
如果不一致，必须重写贡献表述。
```

## Gap Types

| Gap Type | Diagnostic Question |
|---|---|
| Formulation gap | Did prior work frame the problem incorrectly? |
| Assumption gap | Does prior work depend on assumptions that are too strong or unrealistic? |
| Input gap | Does prior work miss critical inputs or use unsuitable inputs? |
| Method gap | Are existing mechanisms insufficient, inefficient, non-generalizable, or misfit? |
| Output gap | Does prior work optimize the wrong target? |
| Evaluation gap | Are existing protocols distorted, unfair, incomplete, or poorly aligned? |
| Claim gap | Are prior claims too broad, underspecified, or boundary-free? |
| Mechanism gap | Does prior work show correlation without explaining mechanism? |
| Scale gap | Does prior work work only at toy scale or in narrow scenes? |
| Transfer gap | Does prior work fail across domains, datasets, regions, or time periods? |

Pseudo-gaps to reject or reframe:

- "Nobody used this method here."
- "Nobody tested this scenario."
- "We apply A to B."
- Hotword stacking: multimodal, LLM, graph, causal, digital twin, foundation
  model, etc.
- System implementation without a research proposition.
- Case demonstration without a testable claim.

Required output:

```markdown
该研究的主 GAP 是：
次级 GAP 是：
目前 GAP 证明是否充分：
最大问题是：
```

## Contribution Types

| Contribution | Strict Check |
|---|---|
| New problem definition | Does it genuinely reconstruct the research object? |
| New theoretical framework | Does it explain, not just rename concepts? |
| New method | Is it necessary and better than reasonable baselines? |
| New data/materials | Are they irreplaceable and tied to the research problem? |
| New evaluation protocol | Does it correct a distortion in prior evaluation? |
| New empirical finding | Does it produce generalizable knowledge? |
| New system/tool | Does it serve a research proposition rather than a demo? |
| New boundary proof | Does it clarify limits, impossibility, or trade-offs? |

If the work claims too many contribution dimensions, say:

```markdown
当前贡献过度分散。建议收敛到 1-2 个核心创新维度，否则无法判断结果提升来自哪里。
```

## Research Question Checks

| Standard | Strict Question |
|---|---|
| Clarity | Can the question be stated in one precise sentence? |
| Importance | Why does the academic community need this answer? |
| Researchability | Can it be tested by data, theory, experiments, or formal analysis? |
| Falsifiability | What result would prove the hypothesis wrong? |
| Boundary | What does the research deliberately not solve? |
| Independence | Is it a PhD problem rather than only an advisor/project task? |
| Academic value | Does it generate publishable knowledge, not just engineering function? |
| Progressability | Can it yield a stage result in 6-12 months? |

Output:

```markdown
原研究问题：
问题：
建议改写为：
更强版本：
更保守版本：
```

## Literature Review Checks

A qualified literature review must answer:

1. What are the mainstream problems in the field?
2. What schools of methods exist?
3. What does each school solve and fail to solve?
4. How do those failures lead to this research problem?
5. What breakpoint does this work stand on?
6. Which opposing literature weakens the contribution?
7. Has the problem already been solved elsewhere?
8. Are classic or latest key works missing?

Use this table when needed:

| Module | Current Coverage | Missing | Literature Type To Add | Impact On Positioning |
|---|---|---|---|---|
| Classic theory | | | | |
| Core papers from last five years | | | | |
| Direct competitors | | | | |
| Evaluation protocol literature | | | | |
| Opposing or alternative explanations | | | | |
| Application/domain literature | | | | |

## Method And Design Risks

Check:

- Necessity: could a simpler method solve it?
- Fit: does the method match the structure of the research object?
- Variable control: are too many factors changed at once?
- Causality/mechanism: is this only correlation fitting?
- Interpretability: can it explain why it works?
- Complexity: is complexity justified?
- Reproducibility: can others reproduce it from the description?
- Scalability: can it scale to larger data or scenes?
- Failure conditions: when does it fail?

Output:

```markdown
该方法当前最大风险是：
- 理论风险：
- 数据风险：
- 实验风险：
- 工程风险：
- 解释风险：
```

## Data And Case Checks

| Dimension | Strict Question |
|---|---|
| Source | Is the data legal, reliable, and traceable? |
| Coverage | Does it cover the target scene? |
| Bias | Are there sampling, spatial, temporal, or selection biases? |
| Granularity | Does the granularity match the research question? |
| Label quality | Are labels consistent, accurate, and auditable? |
| Missing/noisy data | How are missingness and noise handled? |
| Case selection | Are cases principled or merely convenient? |
| Generalization | Can it validate across region, time, or object type? |

Output:

```markdown
当前数据最可能无法支持的 claim 是：
如果不补数据，必须把 claim 收窄为：
```

## Evaluation Protocol Checks

| Item | Strict Question |
|---|---|
| Baseline | Are baselines strong, fair, and current? |
| Ablation | Does each module have proven necessity? |
| Metric | Does the metric match the research objective? |
| Robustness | Are noise, perturbation, and edge cases tested? |
| Generalization | Are cross-data, cross-region, or cross-time tests included? |
| Leakage | Is there data, spatial, temporal, or label leakage? |
| Statistical validity | Are variance, significance, or stability reported? |
| Failure cases | Are failures analyzed instead of hidden? |
| Human/expert evaluation | If subjective, are experts/users involved with a protocol? |
| Reproducibility | Are code, parameters, logs, and versions available? |

Minimum acceptable experiment package:

```markdown
1. 主实验：
2. Baseline：
3. 消融实验：
4. 鲁棒性测试：
5. 泛化测试：
6. 失败案例分析：
7. 统计或稳定性检验：
```

## Claim Boundary

Force this distinction:

```markdown
本文最多能声称：
本文不能声称：
如果要声称更强结论，还需要补充：
```

Also check whether the material confuses correlation, prediction, explanation,
and causation.

## PhD Stage Standards

| Stage | Passing Standard |
|---|---|
| 博一 / 入门 | Builds a problem map and identifies core gaps. |
| 开题前 | Has clear research question, literature positioning, method route, feasible data. |
| 博二 / 博三 | Has baselines, experiment pipeline, preliminary results, publishable unit. |
| 中期 | Has stable research line and at least one mature research unit. |
| 投稿前 | Has complete evidence chain, strong baselines, clear contribution. |
| 答辩前 | Has systematic contribution, multiple units, theory/method closure. |

## 100-Point Scoring

| Dimension | Points |
|---|---:|
| Problem definition clarity and importance | 10 |
| Literature mastery and gap positioning | 12 |
| Contribution originality and necessity | 12 |
| Method/theory/framework rigor | 12 |
| Evidence chain and evaluation protocol | 12 |
| Data/material/case validity | 8 |
| Result interpretation and claim boundary | 8 |
| Theoretical depth and mechanism explanation | 8 |
| Reproducibility, ethics, and research norms | 6 |
| Writing and argumentative structure | 6 |
| PhD-stage feasibility and development potential | 6 |

Score interpretation:

| Score | Evaluation |
|---:|---|
| 90-100 | Near-mature PhD research or strong submission potential. |
| 80-89 | Solid direction, but evidence or theory still needs strengthening. |
| 70-79 | Potential exists, but structural problems are obvious. |
| 60-69 | Insufficient for strong paper/proposal; major repair needed. |
| 50-59 | Research question, method, or evidence chain is seriously weak. |
| <50 | Reframe before continuing. |

## Hard Vetoes

Flag serious warning when any apply:

1. No clear research question.
2. Gap is a slogan and cannot be derived from literature.
3. Method is fashionable application without necessity.
4. No strong baseline.
5. Metric does not match research target.
6. Leakage or unfair comparison.
7. Conclusion exceeds evidence.
8. Contribution cannot be distinguished from prior work.
9. System demo without academic proposition.
10. Data cannot support the claim.
11. Missing failure analysis.
12. Scope cannot produce results in 6-12 months.

Output:

```markdown
硬性否决项检查：
- 是否触发：
- 触发项：
- 后果：
- 必须如何修改：
```

## Revision Advice Schema

Each advice item must include:

```markdown
问题：
严重程度：致命 / 高 / 中 / 低
为什么是问题：
如果不改的后果：
具体修改动作：
预期产物：
优先级：P0 / P1 / P2
时间尺度：今天 / 1周 / 2周 / 1个月 / 3个月
验收标准：
```

Group advice into:

- A. Immediate repair: research question rewrite, key literature table, baseline
  list, narrowed claim, failure cases, method figure, metric clarification.
- B. Structural reconstruction: related work rewrite, task redefinition,
  evaluation redesign, experiment redesign, ablation, reproducible pipeline.
- C. Strategic pivot: move from broad system to testable question, from method
  stacking to mechanism explanation, from case demo to generalizable framework,
  from broad buzzword to specific task contribution.

## Red-Team Questions

Use and customize these:

1. What is your research question in one sentence?
2. Why is this important to the academic community, not only to you?
3. Who has done the closest work, and what exactly do you add?
4. Is your gap real, or have you not read enough literature?
5. Why is your method necessary? Can a simpler method solve it?
6. Which A/X/P/Y/E/C dimension contains your contribution?
7. If a baseline with one simple module matches your result, what remains?
8. Does your metric correspond to your research target?
9. Could results come from data bias or experimental setup?
10. Under what conditions does your method fail?
11. How far can your conclusion generalize?
12. If half the work must be cut, what core contribution survives?
13. If the metric does not improve, does the research still have value?
14. Why is this PhD research instead of coursework or engineering delivery?
15. Does the next paper naturally grow from this work?
