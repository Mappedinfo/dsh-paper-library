"""按训练源文件中的表达式绑定张量形状；流程顺序边不传递张量。"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from .tensor_shapes import annotated_shape, tensor_record


@dataclass
class _Value:
    # tensor 即单个张量；没有秩证据时 shape 为 None，空列表专指标量。
    kind: str = "tensor"
    shape: list | None = None
    items: tuple = ()
    reduction: str | None = None


def _dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute) and (parent := _dotted(node.value)):
        return f"{parent}.{node.attr}"
    return ""


def _row(node, value):
    return {"name": ast.unparse(node)[:100], "shape": value.shape if value.kind == "tensor" else None}


def _annotation(node):
    shape = annotated_shape(node) if node is not None else None
    if shape is not None:
        return _Value(shape=shape)
    if isinstance(node, ast.Subscript):
        name = _dotted(node.value).split(".")[-1]
        if name in {"Iterable", "Iterator", "Sequence", "list", "List"}:
            return _Value("iterable", items=(_annotation(node.slice),))
        if name in {"Tuple", "tuple"} and isinstance(node.slice, ast.Tuple):
            return _Value("tuple", items=tuple(_annotation(item) for item in node.slice.elts))
    return _Value()


def _bind(target, value, env):
    if isinstance(target, ast.Name):
        env[target.id] = value
    elif isinstance(target, (ast.Tuple, ast.List)):
        items = value.items if value.kind == "tuple" and len(value.items) == len(target.elts) else [_Value()] * len(target.elts)
        for part, item in zip(target.elts, items):
            _bind(part, item, env)


def _criterion_reduction(call):
    # 位置参数、弃用的 size_average/reduce 和动态 kwargs 都可能改写 reduction。
    if call.args or any(kw.arg in {None, "size_average", "reduce"} for kw in call.keywords):
        return None
    reduction = next((k.value for k in call.keywords if k.arg == "reduction"), None)
    if reduction is None:
        return "mean"
    if isinstance(reduction, ast.Constant) and reduction.value in ("sum", "mean", "none"):
        return reduction.value
    return None


def _bind_outputs(contract, actuals):
    """把 forward 注解中的符号替换为调用点已知的轴，结论冲突时保留未知。"""
    inputs, results = contract
    if len(actuals) != len(inputs):
        return []
    symbols = {}
    for declared, actual in zip(inputs, actuals):
        dims = declared.get("shape")
        if dims is None or actual.shape is None or "..." in dims or "..." in actual.shape:
            continue
        if len(dims) != len(actual.shape):
            return []
        for expect, found in zip(dims, actual.shape):
            if expect == "?" or found == "?":
                continue
            if isinstance(expect, int) and isinstance(found, int) and expect != found:
                return []
            if isinstance(expect, str) and expect.isidentifier():
                if expect in symbols and symbols[expect] != found:
                    return []
                symbols[expect] = found
    return [dict(out, shape=([symbols.get(d, d) for d in out["shape"]]
                             if out.get("shape") is not None else None)) for out in results]


class _Analysis:
    def __init__(self, tree, network, entry, model):
        self.records = {}
        self.aliases = {}
        self.constructors = set()
        self.contract = ([], [])
        model_class, _, self.method = (network or {}).get("name", "").partition(".")
        for item in tree.body:
            if isinstance(item, ast.Import):
                for alias in item.names:
                    name = alias.asname or alias.name.split(".")[0]
                    self.aliases[name] = alias.name if alias.asname else name
            elif isinstance(item, ast.ImportFrom) and item.module:
                for alias in item.names:
                    self.aliases[alias.asname or alias.name] = item.module + "." + alias.name
        if network:
            if entry == model:
                self.constructors.add(model_class)
            else:
                # 只能把实际选中的源码绑定给对应导入，不能按模型变量的惯例名称猜接。
                for item in tree.body:
                    imports = ([(item.module, a.name, a.asname, item.level) for a in item.names]
                               if isinstance(item, ast.ImportFrom) and item.module else
                               [(a.name, None, a.asname, 0) for a in item.names] if isinstance(item, ast.Import) else [])
                    for module, name, alias, level in imports:
                        if name is not None and name != model_class:
                            continue
                        origin = entry.parent
                        for _ in range(max(0, level - 1)):
                            origin = origin.parent
                        candidates = {origin.joinpath(*module.split(".")).with_suffix(".py").resolve()}
                        if level == 0:
                            # 对带包名的绝对导入，只接受与所选文件真实目录结构匹配的模块路径。
                            suffix = Path(*module.split(".")).with_suffix(".py").parts
                            if tuple(model.parts[-len(suffix):]) == suffix and len(suffix) > 1:
                                candidates.add(model)
                        if model in candidates:
                            self.constructors.add((alias or name) if name else (alias or module) + "." + model_class)
            inputs = [row for n in network["nodes"] if n.get("op") == "input"
                      for row in n.get("tensor", {}).get("outputs", [])]
            returns = [n for n in network["nodes"] if n.get("op") == "return"]
            outputs = returns[0].get("tensor", {}).get("outputs", []) if len(returns) == 1 else []
            self.contract = (inputs, outputs)
        self.block(tree.body, {})

    def value(self, node, env):
        if isinstance(node, ast.Name):
            return env.get(node.id, _Value())
        if isinstance(node, (ast.Tuple, ast.List)):
            return _Value("tuple", items=tuple(self.value(x, env) for x in node.elts))
        if not isinstance(node, ast.Call):
            if node is not None:
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, ast.expr):
                        self.value(child, env)
            return _Value()
        name = _dotted(node.func)
        head, dot, rest = name.partition(".")
        full = self.aliases.get(head, head) + dot + rest if head not in env else ""
        args = [self.value(a, env) for a in node.args]
        kws = {k.arg: self.value(k.value, env) for k in node.keywords}
        if name in self.constructors and (not isinstance(node.func, ast.Name) or name not in env):
            return _Value("model")
        # 只承认已识别的 PyTorch 损失构造器，用户自定义的 criterion 不假定返回标量。
        if full in {"torch.nn." + x for x in ("MSELoss", "L1Loss", "CrossEntropyLoss", "NLLLoss", "SmoothL1Loss", "BCEWithLogitsLoss")}:
            return _Value("criterion", items=(full,), reduction=_criterion_reduction(node))
        obj = self.value(node.func.value, env) if isinstance(node.func, ast.Attribute) else None
        if obj and obj.kind == "model" and node.func.attr in {"to", "cpu", "cuda", "double", "float"}:
            return obj
        receiver = env.get(name)
        expected, _ = self.contract
        if (receiver and receiver.kind == "model" and self.method == "forward") or (
                obj and obj.kind == "model" and node.func.attr == self.method):
            actuals = list(args)
            remaining = [v["name"] for v in expected[len(args):]]
            if set(kws) == set(remaining):
                actuals.extend(kws[key] for key in remaining)
            else:
                actuals = [] if kws else actuals
            rows = [_row(a, v) for a, v in zip(node.args, args)]
            rows.extend(_row(k.value, kws[k.arg]) for k in node.keywords)
            outputs = _bind_outputs(self.contract, actuals) if len(actuals) == len(expected) else []
            self.records[node] = tensor_record(rows, outputs or [{"name": "输出", "shape": None}],
                                              note="按所选模型的方法签名与调用点推导。")
            return _Value(shape=outputs[0]["shape"]) if len(outputs) == 1 else _Value("tuple", items=tuple(_Value(shape=r["shape"]) for r in outputs))
        if receiver and receiver.kind == "criterion":
            rows = [_row(a, v) for a, v in zip(node.args, args)]
            rows.extend(_row(k.value, kws[k.arg]) for k in node.keywords)
            shape = [] if receiver.reduction in {"mean", "sum"} else None
            if (receiver.reduction == "none" and len(args) == 2 and args[0].shape == args[1].shape
                    and receiver.items[0] not in {"torch.nn.CrossEntropyLoss", "torch.nn.NLLLoss"}):
                shape = args[0].shape
            self.records[node] = tensor_record(rows, [{"name": "loss", "shape": shape}])
            return _Value(shape=shape)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "backward":
            self.records[node] = tensor_record([_row(node.func.value, obj)], [], note="梯度写入参与求导的张量。")
            return _Value("control")
        if isinstance(node.func, ast.Attribute) and node.func.attr in {"sum", "mean"} and not node.args and not node.keywords and obj.shape is not None:
            return _Value(shape=[])
        if full in {"torch.save", "numpy.save"}:
            pos = 0 if full == "torch.save" else 1
            if len(args) > pos:
                data = node.args[pos]
                state_dict = isinstance(data, ast.Call) and _dotted(data.func).endswith(".state_dict")
                if not state_dict:
                    self.records[node] = tensor_record([_row(data, args[pos])], [],
                                                       note="写入对象的形状由调用点决定。")
        if isinstance(node.func, ast.Name) and receiver and receiver.kind == "tensor":
            self.records[node] = tensor_record([_row(a, v) for a, v in zip(node.args, args)],
                                              [{"name": "输出", "shape": None}])
        return _Value()

    def block(self, body, env):
        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                args = [*stmt.args.posonlyargs, *stmt.args.args, *stmt.args.kwonlyargs]
                self.block(stmt.body, {a.arg: _annotation(a.annotation) for a in args})
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                value = self.value(stmt.value, env)
                if isinstance(stmt, ast.AnnAssign) and (dims := annotated_shape(stmt.annotation)) is not None:
                    value = _Value(shape=dims)
                for target in stmt.targets if isinstance(stmt, ast.Assign) else (stmt.target,):
                    _bind(target, value, env)
            elif isinstance(stmt, (ast.For, ast.AsyncFor)):
                iterator = self.value(stmt.iter, env)
                inner = env.copy()
                _bind(stmt.target, iterator.items[0] if iterator.kind == "iterable" else _Value(), inner)
                # 只保留首轮与后续迭代都成立的事实。
                for name in self.writes(stmt.body):
                    inner.pop(name, None)
                self.block(stmt.body, inner)
                self.block(stmt.orelse, {})
                for name in self.writes([stmt]):
                    env.pop(name, None)
            elif isinstance(stmt, (ast.If, ast.While, ast.Try, ast.TryStar, ast.With, ast.AsyncWith)):
                mutable = self.writes([stmt])
                for field in ("body", "orelse", "finalbody"):
                    known = env.copy()
                    if field == "finalbody" or isinstance(stmt, ast.While):
                        for name in mutable:
                            known.pop(name, None)
                    self.block(getattr(stmt, field, []), known)
                for handler in getattr(stmt, "handlers", []):
                    self.block(handler.body, {})
                for name in self.writes([stmt]):
                    env.pop(name, None)
            elif isinstance(stmt, (ast.Expr, ast.Return)):
                self.value(stmt.value, env)
            else:
                for name in self.writes([stmt]):
                    env.pop(name, None)

    @staticmethod
    def writes(body):
        return {n.id for stmt in body for n in ast.walk(stmt)
                if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del))}


def training_records(tree, network, entry, model):
    return _Analysis(tree, network, entry, model).records


def step_tensor(op, record=None):
    if record is not None:
        return record
    if op in {"loss", "forward", "model_call", "backward", "unresolved"}:
        return tensor_record(outputs=[{"name": "张量", "shape": None}])
    return tensor_record(applicable=False)
