# Evidence-Atlas Review: Case-Level Evidence and Joint-Coverage Audit

The case-level audit in this reference is adapted, with permission, from a
private research-evidence-atlas design note. Only the review methodology is
included here; the system-building parts of that note (data contracts, LLM
pipeline, UI, storage) are out of scope. This reference does not replace the
A/X/P/Y/E/C main framework or the scoring rubric — it is the special audit for
evidence quality and joint coverage, and it supplies the scoring anchors for
the evidence-chain dimension.

Load this when the reviewed material makes capability claims ("low cost",
"accurate", "interactive"), combines multiple experiments or configurations,
or when a full review is requested.

## 1. Case splitting and eight-dimension coding

One reviewed artifact usually contains several claims or experiments. Split it
into study cases first: **one claim or one evaluation scope = one case**. Do
not review "the paper" or "the proposal" as one undifferentiated whole.

Quick-code each case on eight dimensions:

| Dimension | Question it answers |
|---|---|
| O (object) | What is studied; object structure and heterogeneity |
| T (task) | Prediction, conditional simulation, intervention response, optimization — these are not equivalent |
| I (intervention) | Which variables can be changed, over what range, in which combinations |
| Y (output) | Result or state produced; keep spatial unit, time range, unit, resolution |
| C (context) | Data, supervision, assumptions, scale, region, hardware, budget |
| M (method) | Computation and representation; descriptive by default, never a hard relevance gate |
| Q (quality) | Required and measured performance: error, latency, memory, training cost, data needs, interactivity |
| E (evidence) | Text location, protocol, baselines, data source, proofs, reproduction status |

Mapping to the main framework: assumptions/inputs/boundaries mostly enter
`context`; procedure enters `method`; output enters `output`; evaluation
enters `evidence` and `quality`. Use whichever decomposition reads better for
the material, but keep case identity either way.

Rules:

- Multiple values in one dimension do not prove they were jointly tested.
- Unknown fields may stay empty; never auto-merge cases to fill them.
- A paper with conflicting results across settings becomes several cases with
  counter-evidence preserved, not one case showing only the favorable result.

## 2. Evidence attribution and absence discipline

Tag every load-bearing judgment with its attribution:

- `author_claim` — the authors assert it (abstract adjectives, intro promises);
- `reported_result` — the authors measured or proved it under a stated protocol;
- `reviewer_inference` — the reviewer (you) derived it; say from what.

An author claim is never scored as a measured capability. A reported result
counts as reported support, not as independently reproduced support.

Absence has structure — do not collapse it:

| Status | When to use | Discipline |
|---|---|---|
| `not_reported` | Checked sources do not contain it | Record the checked scope: "not reported in the sections reviewed", never "the paper does not report" after reading only the abstract |
| `not_tested` | The material or a complete-enough experiment check shows no test | Not finding a test is not proof of no test |
| `unclear` | Ambiguous wording blocks a judgment | Quote the ambiguity |
| `not_applicable` | The requirement genuinely does not apply | Give the reason; never count as satisfied |
| `needs_context` | Only partial material was available | Say what is missing |

`unknown` states enter neither the pass column nor the fail column. Material
not mentioning something is not evidence the research did not do it — but it
does cap what the material can claim.

## 3. Joint-coverage audit (anti-stitching)

The core question for every combined claim ("simultaneously cheap, accurate
and interactive"): **is there one case — one system, configuration, protocol
and scope — where all required properties hold at once?**

Correct form: there exists a case such that for every necessary requirement,
that same case satisfies it. Wrong form: for every requirement there exists
some case somewhere that satisfies it. These two judgments must never be
mixed.

Stitching detection checklist:

- Latency from configuration A combined with accuracy from configuration B;
- Results merged across experiments, datasets, or evaluation protocols;
- Best sub-scenario of a multi-city / multi-scale protocol presented as the
  joint configuration;
- Shared paper ID, model name, or dataset name offered as proof of a shared
  configuration (it is not);
- Simulator success claimed toward a real-world intervention requirement;
- Historical-prediction accuracy claimed toward a post-intervention
  prediction requirement.

A legitimate evaluation bundle needs a common, evidenced system/configuration
identity, protocol and scope. When the joint claim fails, downgrade it to the
individual supported claims and move the joint version into "本文不能声称".

Numbers are comparable only with unit, metric definition, measurement scope
and conditions attached; a number without hardware and measurement scope does
not satisfy a latency target. An undefined threshold (`null`) makes the
requirement `unassessable`, never passed.

## 4. Adjective operationalization checklist

Every capability adjective in the material needs a definition, a metric, and
conditions — otherwise treat it as `author_claim` and exclude it from measured
capability.

| Adjective | Must be decomposed into | Not sufficient |
|---|---|---|
| 复杂 | Object scale, interaction structure, nonlinearity, constraint combinations | "complex" in the abstract |
| 异质 | Which heterogeneity: object types, relations, data sources, behavior | Naming a multi-type noun without saying how it is handled |
| 多尺度 | Which spatial/temporal scales, cross-scale relation, evaluated range | Running at several independent resolutions |
| 低成本 | Itemized: data, annotation, training, inference, hardware, human config | Few parameters, single-GPU runnable, or "cheap" claim |
| 高效 | Named workload, end-to-end time/throughput, memory, hardware | Omitting preprocessing or external solver cost |
| 精准 | Task metric, reference truth, baseline, split, uncertainty | Historical accuracy treated as post-intervention accuracy |
| 可交互 | Supported edit operations, feedback latency, validity checks | Having an input box or a demo video |
| 可解释 | Explanation object, form, faithfulness or explicit check rule | An attention map presented as verified explanation |
| 可验证 | Checkable I/O, protocol, sources, appropriate validation design | A code link or a schematic |
| 可泛化 | Named domain shift, test protocol, adaptation data/compute budget | Testing inside the training-covered region |

These are review heuristics, not authoritative definitions of the terms; when
the material defines one differently and defensibly, review against its own
definition and note the mapping.

## 5. Per-requirement status machine

When the material (or the review itself) evaluates against a set of
requirements, judge each atom separately:

| Status | Meaning |
|---|---|
| `satisfied` | Requirement defined, conditions compatible, evidence meets its rule |
| `failed` | Conditions compatible and explicit evidence falls short |
| `unknown` | Insufficient source, not reported, not tested, or unresolvable ambiguity |
| `not_comparable` | Task, scale, budget, metric definition or other key condition incompatible |
| `not_applicable` | Requirement genuinely does not apply; reason required |
| `unassessable` | Requirement itself not operationalized (e.g. threshold undefined) |

Aggregate labels (直接支持 / 部分支持 / 条件不兼容 / 证据未知 / 不满足 /
目标待定义) may summarize, but the per-requirement states are authoritative —
no single score may hide a `failed` or `unknown`. For full reports, an optional
case × requirement status matrix (rows: cases, columns: requirements, cells:
the states above) gives the auditable view.

## 6. Reviewer self-check counterexamples

Before delivering the review, answer honestly:

1. Did I stitch one paper's latency with another paper's accuracy into joint
   support? (T01)
2. Did I merge a fast small-scale configuration with an accurate large-scale
   one? (T02)
3. For every joint claim I accepted, can I point to one case and its two or
   more source evidences? (T03)
4. Did I score abstract adjectives ("efficient", "accurate") as measured
   capability? (T04)
5. Did I accept a number lacking hardware / measurement scope as satisfying a
   condition-bound target? (T05)
6. Did I write "not reported" for anything I only searched partially? (T06)
7. Did I pass any requirement whose threshold or metric is undefined? (T07)
8. Did I record an author-reported failure as `failed` rather than softening
   it to unknown? (T08)
9. Did I avoid ranking across incompatible tasks, units or normalizations?
   (T09)
10. Did I keep simulator-scope and historical-prediction support away from
    real-intervention claims? (T10/T11)
11. Did I count "not found in my checked scope" as failure anywhere? (T06)
12. Did my overall conclusion get dragged up by favorable cases while
    conflicting cases exist? (T15)
