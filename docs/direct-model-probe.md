# 独立验证模型 API

基础元数据检查不要求经过 DSH。可用独立批处理程序调用模型，将结构化草稿交回 Paper Library。OpenAI／Anthropic 在这里是兼容协议；实际提供推理服务的是用户指定的供应商。

`scripts/probe-direct-metadata-api.py` 是合成示例的连接与输出测试，不是完整批量执行器。它使用 Python 标准库直接发送协议兼容的 HTTP 请求，无需安装 SDK 或运行 Harness。

| 服务 | 协议 | 固定测试地址 | 测试模型 |
| --- | --- | --- | --- |
| GLM 普通 API | OpenAI Chat Completions | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4.7-flash` |
| Kimi Code | Anthropic Messages | `https://api.kimi.com/coding/v1/messages` | `kimi-for-coding` |

服务接口依据：[GLM OpenAI 兼容文档](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[Kimi Code 接入文档](https://www.kimi.com/code/docs/)。模型 ID 为本脚本的测试选择，不表示最新型号或可用性保证。Kimi Code 会员 key 与 Kimi 开放平台按量计费 key 使用不同地址；连接成功不扩大会员套餐用途或限额。

## 运行

明确指定包含凭据的文件及一个变量名。脚本不搜索其他配置，不执行该文件、不展开 shell 表达式，仅解析命名变量，重复赋值会报错。

```sh
uv run --offline python scripts/probe-direct-metadata-api.py \
  --provider glm \
  --env-file /absolute/private/credentials.env \
  --key-env GLM_API_KEY \
  --out /absolute/private/new-glm-probe.json

uv run --offline python scripts/probe-direct-metadata-api.py \
  --provider kimi \
  --env-file /absolute/private/credentials.env \
  --key-env KIMI_API_KEY \
  --out /absolute/private/new-kimi-probe.json
```

输出路径必须在源代码仓库之外且尚不存在，父目录需事先建立；回执权限为 0600。回执保存合成请求、经凭据脱敏的响应、HTTP 状态、供应商 token 用量及耗时，不保存认证头。终端只输出最小状态，不打印凭据或原始错误消息。

每次仅发送一个合成样本，最长 45 秒、输出上限 512 token、响应上限 256 KiB。不跟随重定向、不自动重试、换 key 或切换模型。客户端使用真实的自有 `User-Agent`，不伪装其他工具。Kimi 使用 `x-api-key` 与 `anthropic-version`；GLM 使用 Bearer 认证和 JSON 输出模式，两者关闭思考。

校验标题、作者和年份与合成输入一致，并要求缺失 DOI 保持 `null`。可剥离单个 Markdown JSON 代码围栏或唯一 `answer` 对象包装，除此之外不猜字段、不修复或补写模型输出。返回成功只证明此次连接及简单样本通过，不证明真实论文提取准确率、长期容量或通用批量用途。

真实补全队列还需按文件哈希缓存、限制并发、保存逐字段原文证据、处理冲突与恢复中断；参见[元数据检查](pdf-metadata-audit.md)。此测试不会读取真实 PDF、修改文献目录、配置 DSH 或写入 PDF。
