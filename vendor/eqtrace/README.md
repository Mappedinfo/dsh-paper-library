# EqTrace 静态制图模块

此目录随 PaperLibrary 分发 EqTrace 的 Python 静态制图模块和 MIT 许可。源码上游为 [Mappedinfo/eqtrace](https://github.com/Mappedinfo/eqtrace)，版本见 [REVISION](REVISION)，四个包文件由上游原样同步。`run.py` 是 PaperLibrary 的隔离启动入口。只需 Python 3.11+ 标准库。

解析规则在 EqTrace 修改并验证。在 PaperLibrary 仓库运行 `node scripts/vendor-eqtrace.mjs <上游仓库目录> <提交>` 同步指定版本，再运行 `node --test tests-js/board-eqtrace.test.mjs` 核对宿主接口与画板校验。
