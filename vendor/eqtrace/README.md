# EqTrace 静态制图模块

此目录随 PaperLibrary 分发 EqTrace 的 Python 静态制图模块和 MIT 许可。源码上游为 [Mappedinfo/eqtrace](https://github.com/Mappedinfo/eqtrace)，同步版本见 [REVISION](REVISION)。同步清单包含上游 `eqtrace/` 包的六个文件。

- `__init__.py` 提供包入口。
- `network_flow.py` 提取网络结构。
- `training_flow.py` 提取训练流程。
- `tensor_shapes.py` 从模型源码推导张量维度。
- `training_tensors.py` 为训练流程关联张量信息。
- `paper_flow.py` 组装画板文档并提供命令行入口。

`run.py` 是 PaperLibrary 的本地隔离启动入口，使用 Python 3.11+ 标准库。

解析规则在 EqTrace 修改并验证。在 PaperLibrary 仓库运行 `node scripts/vendor-eqtrace.mjs <上游仓库目录> <提交>` 同步指定版本，再运行 `node --test tests-js/board-eqtrace.test.mjs` 核对宿主接口与画板校验。
