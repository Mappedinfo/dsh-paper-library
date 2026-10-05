# 检查同页面、不同批注的 PDF

本工具供本地按需检查使用，不进入日常备份、导入或阅读流程。它只读取明确清单中的 PDF，分别比较页面与阅读批注，不合并或删除文件。

文件 SHA-256 相同，表示文件字节相同，嵌入的批注也相同。若 SHA-256 不同，可能是批注变化，也可能只是保存结构、元数据或正文版本变化，不能仅凭文件名或批注数量判断。

## 运行

先用 [Vault Sync](https://github.com/mappedinfo/dsh-vault-sync) 的 `scripts/find-pdf-duplicates.mjs` 生成当前配置所管理的本地文件清单。将其 `report.json` 作为输入：

```sh
uv run --offline python scripts/audit-pdf-annotation-variants.py \
  --inventory /absolute/private/inventory/report.json \
  --out /absolute/private/new-annotation-report
```

输出目录必须尚不存在，且位于所有备份源之外；其父目录须已存在。目录权限为 0700，JSON、CSV 和 Markdown 报告为 0600。报告含本地文件路径，不能提交到公开仓库。正文和评论原文不导出，报告保留页码、批注类型、位置和散列。

脚本使用项目已有的 PyMuPDF 环境，不获取凭据、不创建云端客户端、不调用模型。PyMuPDF 保留其 AGPL／商业许可。

## 判定方法

1. 重新计算文件 SHA-256，读取页数、页面几何、逐页文本指纹及标准阅读批注。
2. 用相同页数、页面几何和折叠空白后的文本筛选候选。候选至少有一份包含阅读批注，且文件字节不同。
3. 候选的全部页面以预乘 RGBA 120 dpi、`annots=False` 渲染，逐页比较图像指纹。保留透明度可避免批注透明组对白底合成造成的舍入差异，不使用像素容差。文字相同但图表、布局不同的文件不会因此判作页面相同。
4. 另外比较批注语义与开启批注后的全页渲染。语义包括内容、作者、几何、样式、回复关系及手写附件；忽略时间、内部 ID 和已知保存事务字段。
5. 分别报告语义与外观都有差异、仅语义不同、仅外观不同待复核，以及页面和批注均相同但文件字节不同。

关闭批注渲染的行为见 [PyMuPDF 官方说明](https://pymupdf.readthedocs.io/en/latest/recipes-images.html#how-to-create-or-suppress-annotation-images)；附件与批注属性见 [Annot API](https://pymupdf.readthedocs.io/en/latest/annot.html)。

## 结果与边界

- `summary.md` 给出分组、各文件批注数量、类型与页码，以及本地文件链接。
- `variants.csv` 列出发现批注差异的全部文件。
- `report.json` 保存成对差异、批注集合的包含关系、全部检查结果与不完整项。
- `inspections.jsonl` 保留逐文件和逐阶段检查记录；最终状态以 `report.json` 为准。

默认最多 10,000 份文件，每个子进程最长 90 秒、并发 4，单份最多 2,000 页、单页最多 1,600 万像素，候选累计最多渲染 50,000 页。单文件指纹工具另限制文件大小及附件提取大小。macOS 未驻留文件不会被打开；变化、损坏、加密、超时或超限会明确记录，失败不算作没有批注。完整运行退出 0，不完整退出 2。

结论是指定分辨率下的页面显示一致，不是 PDF 内部结构、隐藏内容或法律意义上的等价证明。提取顺序、OCR 层、页面裁切不同会漏掉候选。压平在正文中的笔迹不能可靠剥离；应用数据库或 sidecar 中尚未嵌入 PDF 的笔记不在范围。Link、Widget、Popup 分开计数，含表单控件的外观差异需要复核。

“批注更多”“文件较新”或“批注集合包含另一份”均不自动产生删除或覆盖建议。
