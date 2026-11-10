# 划线阅读轨迹

文献表每条标题下方的标签行显示「划线分布」。位置从左到右对应 PDF 物理页与页内纵向位置，不是已读百分比，也不衡量理解程度。普通列表和当前文献标签区复用同一显示。

- 浅绿：其他划线，来源未确认，不能直接称为人工阅读。
- 浅蓝：符合原生 AI 蓝色虚线样式的划线。同款人工标记也会匹配；旧 AI 标记没有这种样式时仍在「其他」中。样式约定见 [AI 标注](ai-annotation-style.md)。
- 数字是所读取的根划线批注数。悬停或键盘聚焦可查看两类数量、涉及页数、页数分母、读取边界及说明。
- 「未知」不等于 0；「未发现划线」仅表示已完整检查的 PDF 中没有符合类型的标记。部分读取用 ≥ 和下限说明；局部未发现不会称作全文无划线。

## 设置

插件设置及 DSH 设置 → Paper Library 共用「划线阅读轨迹」：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| reading_distribution_enabled | true | 显示／关闭条带 |
| reading_distribution_mode | density | density 平滑密度或 bands 离散条带 |
| reading_distribution_ai | true | 单独显示 AI 样式层 |
| reading_distribution_smoothing | 3 | 密度平滑强度，整数 1–6 |

设置保存到主机，立即更新显示；不会改变 PDF 原生颜色或批注。关闭后停止新读取并忽略在途结果。设置服务暂不可用时不覆盖最后已确认的开关。

## 数据和拟合

`reading_distribution {id}` 按需只读一篇文献，返回 96 个固定桶。只统计原生 Highlight、Underline、Squiggly、StrikeOut 根批注；排除任何非空 `/IRT` 回复，以及便笺、矩形、笔迹和模型回复。以每条可定位批注在实际旋转／裁剪后的可见矩形纵向中点作为一个单位，不按字符长度、备注数或回复数增重。横轴按 `(零基物理页 + 页内位置) / PDF 总页数` 归一。

多栏论文、跨行长划线、同页多个标记的真实阅读顺序不能由该近似恢复。每条跨行标记仍只计一次，条带不是逐句覆盖率。

密度使用有界高斯核，边缘重新归一以保留标记总质量。两层共用本篇的峰值，避免一条稀疏 AI 标记被独立拉伸成同样密集。强度仅比较本篇位置的相对集中程度；不可据此比较不同文献的阅读投入。空组不绘制虚假基线标记。

返回结构：

- `status`: ready / partial / unknown。
- `page_count`, `bin_count:96`, `total_marks`, `marked_pages`。
- `other`, `ai_style`: `{bins:[96 counts], annotation_count, marked_pages}`。
- `reason`, `reasons`, `coverage:{scanned_pages,visited_pages,scanned_annotations,skipped_marks}`。
- `limits:{pages:2000,annotations:20000,bins:96}`。

unknown 的计数为 null，不可把占位零数组当作实际零。partial 的计数和分布是已观察下限。2000 页以上沿用 PDF 打开器的拒绝边界；20,000 个原生批注预算计入回复和非划线类型，避免通过非目标类型绕过预算。损坏页面、循环对象、无法定位、样式解析失败及读取期间文件变化都有显式状态。不会读取批注内容、正文、图像或渲染页面；不保存统计到目录或批注表。

## 性能与刷新

仅读取进入视野附近的条带，单个页面最多串行一个统计请求；没有 PDF 的元数据条目不启动 worker。前端缓存最多 120 篇，60 秒后在重新进入视野、窗口聚焦或刷新时更新，不定时轮询整库。在当前页创建／修改／删除标记后失效重读；外部软件或其他窗口修改后可点文献库刷新。退出页面、关闭显示、切换列表和旧请求返回均有取消／去重保护。

## 验证

- Python 合成 PDF：页尺寸、旋转与裁剪、根/回复分离、原生 AI 样式、未知/部分/真实零、页与批注预算、循环对象、文件变化和无数据写入。
- JavaScript：平滑质量守恒、共享峰值、视野读取与串行去重、缓存刷新、取消和重排、设置故障、未知与空组。
- `node scripts/reading-distribution-browser-fixture.mjs`：隔离 Chromium 和合成 PDF，实际 HTTP 接入、目标标签行、宽窄/明暗布局、设置切换和重开、刷新，无真实库或模型请求。可用 `PLAYWRIGHT_MODULE` 指向现有 Playwright；版本不一致时用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安装的兼容 Chromium。

合成检查与运行中插件、用户当前浏览器加载状态分别记录，不能以源码或隔离检查代替用户页面验收。
