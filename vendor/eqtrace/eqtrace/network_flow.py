"""Extract source-level tensor dependencies without importing a model or running project code."""
from __future__ import annotations

import ast
from collections import Counter, defaultdict, deque
from pathlib import Path
import re
import tokenize

from .tensor_shapes import annotated_shape, infer_network_tensor, overview_tensors


def _dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted(node.value)
        if parent:
            return f"{parent}.{node.attr}"
    return ""


def _aliases(tree):
    names = {}
    for item in tree.body:
        if isinstance(item, ast.Import):
            for alias in item.names:
                head = alias.name.partition(".")[0]
                names[alias.asname or head] = alias.name if alias.asname else head
        elif isinstance(item, ast.ImportFrom) and item.module and not item.level:
            for alias in item.names:
                names[alias.asname or alias.name] = f"{item.module}.{alias.name}"
    return names


def _qualified(node, aliases):
    name = _dotted(node)
    head, dot, tail = name.partition(".")
    return aliases.get(head, head) + dot + tail


def _layer_declarations(cls):
    """Only unconditional constructor assignments identify a particular layer."""
    init = next((f for f in cls.body if isinstance(f, ast.FunctionDef) and f.name == "__init__"), None)
    args = [*init.args.posonlyargs, *init.args.args] if init else []
    if not args:
        return {}
    owner = args[0].arg
    prefix = owner + "."
    writes = Counter(
        _dotted(n)[len(prefix):] for n in ast.walk(init)
        if isinstance(n, ast.Attribute) and isinstance(n.ctx, (ast.Store, ast.Del))
        and _dotted(n).startswith(prefix)
    )
    layers = {}
    for stmt in init.body:
        if not isinstance(stmt, (ast.Assign, ast.AnnAssign)) or not isinstance(stmt.value, ast.Call):
            continue
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        for target in targets:
            name = _dotted(target)
            if not name.startswith(prefix):
                continue
            key = name[len(prefix):]
            owner_path = key.rpartition(".")[0]
            if writes[key] == 1 and (not owner_path or owner_path in layers):
                layers[key] = stmt.value
    return layers


def _source_value(expr):
    if isinstance(expr, ast.Constant) and isinstance(expr.value, (str, bool, int, float, type(None))):
        return expr.value
    return ast.unparse(expr)


# Keep mathematical operators explicit, including the source expression for order and literals.
_SYMBOLS = {ast.Add: "+", ast.Sub: "−", ast.Mult: "×", ast.MatMult: "@", ast.Div: "/",
            ast.FloorDiv: "//", ast.Pow: "**", ast.Mod: "%"}
_LAYER_ARGS = {
    "Linear": ("in_features", "out_features", "bias"),
    "Embedding": ("num_embeddings", "embedding_dim"),
    "Conv1d": ("in_channels", "out_channels", "kernel_size", "stride", "padding", "dilation", "groups", "bias"),
    "Conv2d": ("in_channels", "out_channels", "kernel_size", "stride", "padding", "dilation", "groups", "bias"),
    "Conv3d": ("in_channels", "out_channels", "kernel_size", "stride", "padding", "dilation", "groups", "bias"),
    "LayerNorm": ("normalized_shape", "eps", "elementwise_affine", "bias"),
    "MultiheadAttention": ("embed_dim", "num_heads", "dropout", "bias", "add_bias_kv",
                           "add_zero_attn", "kdim", "vdim", "batch_first"),
    "Dropout": ("p", "inplace"),
    "ReLU": ("inplace",), "ReLU6": ("inplace",), "SiLU": ("inplace",),
    "LeakyReLU": ("negative_slope", "inplace"),
    "LSTM": ("input_size", "hidden_size", "num_layers"),
    "GRU": ("input_size", "hidden_size", "num_layers"),
    "BatchNorm1d": ("num_features",), "BatchNorm2d": ("num_features",),
}
_TENSOR_METHODS = set("""
    abs add all any argmax argmin bmm cat chunk clamp clamp_min clamp_max clone contiguous cos cpu cuda
    detach div double einsum exp expand expand_as flatten float gather index_select int item log log1p
    long masked_fill matmul max mean min mm mul narrow norm permute pow relu repeat repeat_interleave
    reshape reshape_as round select sigmoid sin size softmax split sqrt square squeeze std sub sum
    tanh to transpose type_as unbind unfold unsqueeze var view view_as where
""".split())


class _ForwardGraph:
    def __init__(self, path, cls, method, aliases):
        self.path, self.cls, self.method, self.aliases = path, cls, method, aliases
        self.statement, self.sites, self.unpack_groups = None, {}, []
        self.nodes, self.edges, self.diagnostics = [], [], []
        self.nodes_by_id = {}
        self.counts, self.bindings = Counter(), {}
        self.layers = _layer_declarations(cls)
        self.attributes = {}
        args = [*method.args.posonlyargs, *method.args.args]
        static = any(_dotted(d) == "staticmethod" for d in method.decorator_list)
        self.owner = args[0].arg if args and not static else None
        data_args = args[1:] if self.owner else args
        for arg in [*data_args, *method.args.kwonlyargs, method.args.vararg, method.args.kwarg]:
            if arg:
                self.bindings[arg.arg] = self.node(
                    arg, "input-" + arg.arg, arg.arg, "data", "input", [], {"argument": arg.arg}
                )

    def node(self, loc, key, label, kind, op, parents, config=None, reason=None):
        stem = re.sub(r"[^\w.-]+", "-", key).strip("-") or "step"
        self.counts[stem] += 1
        uid = f"{stem}.{self.counts[stem]}"
        evidence = f"{self.path}:{loc.lineno}"
        self.sites[uid] = self.statement
        config = dict(config or {})
        if reason:
            config["resolution"] = "unresolved"
            self.diagnostics.append({"code": "unresolved", "evidence": evidence, "message": reason})
        self.nodes.append({
            "id": uid, "label": label, "type": kind, "op": op,
            "ports": {"in": {"in": {"type": "tensor"}}, "out": {"out": {"type": "tensor"}}},
            "evidence": evidence, "detail": reason or ast.unparse(loc), "config": config,
        })
        node = self.nodes[-1]
        def lookup(name):
            ids = self.bindings.get(name, [])
            if len(ids) == 1:
                outs = self.nodes_by_id[ids[0]]["tensor"]["outputs"]
                if len(outs) == 1:
                    return outs[0]["shape"]
            return None
        node["tensor"] = infer_network_tensor(
            node, loc, [self.nodes_by_id[uid] for uid in parents], lookup,
            annotated_shape(loc.annotation) if isinstance(loc, ast.arg) else None,
        )
        self.nodes_by_id[uid] = node
        for source in dict.fromkeys(parents):
            self.edges.append({"id": f"e-{source}-{uid}", "from": source + ":out",
                               "to": uid + ":in", "kind": "candidate" if reason else "data"})
        return [uid]

    def candidates(self, statements):
        names = (n.id for stmt in statements for n in ast.walk(stmt)
                 if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load))
        return [p for name in names for p in self.bindings.get(name, [])]

    def layer(self, attr, ctor, parents, site):
        qualified = _qualified(ctor.func, self.aliases)
        if qualified == "torch.nn.Sequential":
            if (not ctor.keywords and all(isinstance(x, ast.Call) for x in ctor.args)
                    and all(_qualified(x.func, self.aliases).rsplit(".", 1)[-1] != "OrderedDict" for x in ctor.args)):
                for index, child in enumerate(ctor.args):
                    parents = self.layer(f"{attr}.{index}", child, parents, site)
                return parents
            return self.node(site, attr, attr + " · Sequential", "model", qualified, parents,
                             {"layer_call": ast.unparse(ctor)}, "Sequential members are dynamic.")
        name = qualified.rsplit(".", 1)[-1]
        param_names = _LAYER_ARGS.get(name, ()) if qualified.startswith("torch.nn.") else ()
        params, extra = {}, []
        expanded = False
        for i, arg in enumerate(ctor.args):
            expanded |= isinstance(arg, ast.Starred)
            key = param_names[i] if not expanded and i < len(param_names) else f"arg{i}"
            params[key] = _source_value(arg)
        for keyword in ctor.keywords:
            if keyword.arg in (None, "constructor", "prototype", "__proto__") or keyword.arg in params:
                extra.append({"name": keyword.arg or "**", "value": _source_value(keyword.value)})
            else:
                params[keyword.arg] = _source_value(keyword.value)
        config = {"attribute": attr, "layer_call": ast.unparse(ctor), "parameters": params,
                  "declaration": f"{self.path}:{ctor.lineno}"}
        if extra:
            config["extra_keywords"] = extra
        reason = None if qualified.startswith("torch.nn.") else "User-defined or dynamic module internals."
        return self.node(site, attr, f"{attr} · {name}", "model", qualified or attr,
                         parents, config, reason)

    def expression(self, expr):
        if isinstance(expr, ast.Name):
            if expr.id in self.bindings:
                return self.bindings[expr.id]
            return self.node(expr, expr.id, expr.id, "data", "external", [],
                             reason="Free name. Value and type are unresolved.")
        if isinstance(expr, ast.Constant):
            return []
        if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
            return [p for child in expr.elts for p in self.expression(child)]
        if isinstance(expr, ast.Dict):
            return [p for value in expr.values for p in self.expression(value)]
        if isinstance(expr, ast.Attribute):
            if _dotted(expr.value) == self.owner:
                if expr.attr not in self.attributes:
                    ctor = self.layers.get(expr.attr)
                    if ctor and _qualified(ctor.func, self.aliases) == "torch.nn.Parameter":
                        self.attributes[expr.attr] = self.node(
                            expr, expr.attr, expr.attr, "data", "torch.nn.Parameter", [],
                            {"layer_call": ast.unparse(ctor), "declaration": f"{self.path}:{ctor.lineno}"},
                        )
                    else:
                        self.attributes[expr.attr] = self.node(
                            expr, expr.attr, expr.attr, "data", "attribute", [],
                            reason="Instance attribute value is unresolved.",
                        )
                return self.attributes[expr.attr]
            root = _dotted(expr).partition(".")[0]
            if root in self.aliases and self.aliases[root].partition(".")[0] == "torch":
                # Qualified API constants (e.g. torch.float32) remain in the call expression.
                return []
            return self.node(expr, expr.attr, "." + expr.attr, "method", "attribute",
                             self.expression(expr.value))
        if isinstance(expr, ast.Subscript):
            return self.node(expr, "select", "Index / slice", "method", "getitem",
                             self.expression(expr.value) + self.expression(expr.slice))
        if isinstance(expr, ast.Slice):
            return [p for v in (expr.lower, expr.upper, expr.step) if v for p in self.expression(v)]
        if isinstance(expr, (ast.BinOp, ast.UnaryOp)):
            op = type(expr.op).__name__
            children = (expr.left, expr.right) if isinstance(expr, ast.BinOp) else (expr.operand,)
            parents = [p for child in children for p in self.expression(child)]
            if not parents:
                return []  # Pure scalar expression; the caller retains its source spelling.
            symbol = _SYMBOLS.get(type(expr.op), "")
            return self.node(expr, op, f"{op} {symbol}".rstrip(), "method", op, parents)
        if isinstance(expr, ast.Call):
            return self.call(expr)
        if isinstance(expr, ast.Starred):
            return self.expression(expr.value)
        return self.node(expr, "unresolved", type(expr).__name__, "method", "unresolved",
                         self.candidates([expr]), reason="Unsupported expression. Its inputs are candidates.")

    def call(self, expr):
        callee = expr.func
        receiver = callee.value if isinstance(callee, ast.Attribute) else None
        member = _dotted(callee).removeprefix(self.owner + ".") if self.owner and _dotted(callee).startswith(self.owner + ".") else ""
        declared = member in self.layers
        qualified = _qualified(callee, self.aliases)
        root = _dotted(callee).partition(".")[0]
        torch_api = qualified.startswith("torch.") and root not in self.bindings
        parents = []
        if receiver is not None and _dotted(receiver) != self.owner and not torch_api and not declared:
            parents = list(self.expression(receiver))
        elif not isinstance(callee, (ast.Name, ast.Attribute)):
            parents = list(self.expression(callee))
        elif isinstance(callee, ast.Name) and callee.id in self.bindings:
            parents = self.bindings[callee.id].copy()
        parents += [p for arg in expr.args for p in self.expression(arg)]
        parents += [p for kw in expr.keywords for p in self.expression(kw.value)]
        if declared:
            return self.layer(member, self.layers[member], parents, expr)
        name = qualified or ast.unparse(callee)
        reason = None
        if not torch_api:
            if receiver is not None and _dotted(receiver) != self.owner and callee.attr in _TENSOR_METHODS:
                name = "." + callee.attr  # The method spelling is known, its receiver type is not.
            else:
                reason = "Call target or internal tensor operations are unresolved."
        return self.node(expr, name, name, "method", name, parents, reason=reason)

    def assign(self, target, parents, site):
        if isinstance(target, ast.Name):
            self.bindings[target.id] = parents
        else:
            for index, member in enumerate(target.elts):
                selected = self.node(site, "unpack", f"Select item {index}", "method", "unpack",
                                     parents, {"index": index})
                self.assign(member, selected, site)

    def may_mutate(self, stmt):
        """A mutable call can change tensor aliases that are not among its return values."""
        for call in (node for node in ast.walk(stmt) if isinstance(node, ast.Call)):
            name = _dotted(call.func)
            if isinstance(call.func, ast.Attribute):
                if call.func.attr.endswith("_") and not call.func.attr.startswith("__"):
                    return True
                member = name[len(self.owner) + 1:] if self.owner and name.startswith(self.owner + ".") else ""
                if member in self.layers:
                    ctor = self.layers[member]
                    for item in ast.walk(ctor):
                        if not isinstance(item, ast.Call):
                            continue
                        if _keyword_enabled(item, "inplace"):
                            return True
                        args = _LAYER_ARGS.get(_qualified(item.func, self.aliases).split(".")[-1], ())
                        if "inplace" in args and len(item.args) > args.index("inplace"):
                            value = item.args[args.index("inplace")]
                            if not isinstance(value, ast.Constant) or value.value is not False:
                                return True
            if name and (_keyword_enabled(call, "inplace") or _keyword_enabled(call, "out")):
                return True
        return False

    def build(self):
        for index, stmt in enumerate(self.method.body):
            self.statement = stmt
            if isinstance(stmt, ast.Return) and not self.may_mutate(stmt):
                values = self.expression(stmt.value) if stmt.value else []
                self.node(stmt, "output", "Return", "output", "return", values)
                break
            if (isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None
                    and not self.may_mutate(stmt)):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                if all(_simple_target(t) for t in targets):
                    if (len(targets) == 1 and isinstance(targets[0], (ast.Tuple, ast.List))
                            and isinstance(stmt.value, (ast.Tuple, ast.List))
                            and len(targets[0].elts) == len(stmt.value.elts)):
                        values = [self.expression(v) for v in stmt.value.elts]
                        for member, parents in zip(targets[0].elts, values):
                            self.assign(member, parents, stmt)
                    else:
                        start = len(self.nodes)
                        parents = self.expression(stmt.value)
                        after_expression = len(self.nodes)
                        for target in targets:
                            self.assign(target, parents, stmt)
                        if (len(targets) == 1 and isinstance(targets[0], (ast.Tuple, ast.List))
                                and len(parents) == 1 and after_expression > start
                                and self.nodes[after_expression - 1]["id"] == parents[0]):
                            names = ast.unparse(targets[0]).strip("()[]")
                            members = [parents[0], *(n["id"] for n in self.nodes[after_expression:])]
                            self.unpack_groups.append((members, names))
                    continue
            if (isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name)
                    and not self.may_mutate(stmt)
                    and all(n.id == stmt.target.id or n.id not in self.bindings
                            for s in self.method.body[index + 1:] for n in ast.walk(s)
                            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load))):
                name = stmt.target.id
                parents = self.expression(stmt.target) + self.expression(stmt.value)
                op = type(stmt.op).__name__
                self.bindings[name] = self.node(stmt, op, op, "method", op, parents)
                continue
            if isinstance(stmt, ast.Pass) or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant)):
                continue
            # The remaining code may mutate tensors or return along different paths.
            rest = self.method.body[index:]
            parents = self.candidates(rest)
            unresolved = self.node(stmt, "unresolved-region", "Unresolved code region", "method",
                                   "unresolved", parents, {"endLine": rest[-1].end_lineno},
                                   "Control flow or side effects require review. Incoming dependencies are candidates.")
            if any(isinstance(n, ast.Return) for s in rest for n in ast.walk(s)):
                self.node(rest[-1], "output", "Possible return", "output", "return", unresolved,
                          reason="Return value depends on the unresolved code region.")
            break
        graph = {"id": "network", "name": f"{self.cls.name}.{self.method.name}",
                 "nodes": self.nodes, "edges": self.edges, "diagnostics": self.diagnostics}
        if len(self.nodes) > 12:
            overview = _network_overview(graph, self.sites, self.unpack_groups)
            if overview:
                graph["figure_overview"] = overview
        return graph


def _network_overview(flow, sites, unpack_groups):
    """Contract explicit tuple outputs and unbranched chains; retain distinct source inputs."""
    original = {n["id"]: n for n in flow["nodes"]}
    outgoing, incoming = defaultdict(set), defaultdict(set)
    endpoints = []
    for edge in flow["edges"]:
        a, b = edge["from"].rsplit(":", 1)[0], edge["to"].rsplit(":", 1)[0]
        outgoing[a].add(b)
        incoming[b].add(a)
        endpoints.append((a, b, edge))

    groups, assigned = [], set()

    def group(members, label, op):
        groups.append((members, label, op))
        assigned.update(members)

    for members, names in unpack_groups:
        root, *outputs = members
        # Unpacking gives names to multiple ports of one expression. Leave unrelated fan-out intact.
        if (not assigned.intersection(members) and outgoing[root] <= set(outputs)
                and all(incoming[child] <= set(members) for child in outputs)):
            label = original[root]["label"]
            group(members, names if original[root]["op"] == "unresolved" else label, original[root]["op"])
    for uid, node in original.items():
        if uid in assigned:
            continue
        chain = [uid]
        while len(chain) < 4:
            last = chain[-1]
            if len(outgoing[last]) != 1:
                break
            successor = next(iter(outgoing[last]))
            before, after = original[last], original[successor]
            if (successor in assigned or incoming[successor] != {last}
                    or sites[last] is not sites[successor]
                    or before["type"] not in ("model", "method") or before["type"] != after["type"]
                    or any(n["config"].get("resolution") == "unresolved" for n in (before, after))):
                break
            chain.append(successor)
        if len(chain) > 1:
            labels = [original[i]["op"].rsplit(".", 1)[-1] for i in chain]
            group(chain, " → ".join(labels), "chain")
    if not groups:
        return None

    for uid, node in original.items():
        if uid not in assigned:
            group([uid], node["label"], node["op"])
    order = {uid: i for i, uid in enumerate(original)}
    groups.sort(key=lambda item: min(order[uid] for uid in item[0]))
    projected, owners = [], {}
    for i, (members, label, op) in enumerate(groups):
        first = original[members[0]]
        key = f"group-{i + 1}"
        owners.update({uid: key for uid in members})
        sources = list(dict.fromkeys(original[uid]["evidence"] for uid in members))
        config = {"members": members, "source_evidence": sources}
        if len(members) == 1:
            for item in ("parameters", "attribute", "declaration"):
                if item in first["config"]:
                    config[item] = first["config"][item]
        if any(original[uid]["config"].get("resolution") == "unresolved" for uid in members):
            config["resolution"] = "unresolved"
        projected.append({"id": key, "label": label, "op": op, "type": first["type"],
                          "ports": first["ports"], "config": config, "evidence": sources[0]})

    edges, seen = [], {}
    successors, indegrees = defaultdict(set), Counter()
    for a, b, edge in endpoints:
        start, end = owners[a], owners[b]
        if start == end:
            continue
        pair = (start, end, edge["kind"])
        if pair not in seen:
            seen[pair] = {"id": f"overview-edge-{len(edges) + 1}", "from": start + ":out",
                          "to": end + ":in", "kind": edge["kind"], "source_edges": []}
            edges.append(seen[pair])
            if end not in successors[start]:
                successors[start].add(end)
                indegrees[end] += 1
        seen[pair]["source_edges"].append(edge["id"])

    # A contraction is published only if it preserves the original graph's acyclic order.
    ready = deque(n["id"] for n in projected if not indegrees[n["id"]])
    visited = 0
    while ready:
        visited += 1
        for child in successors[ready.popleft()]:
            indegrees[child] -= 1
            if not indegrees[child]:
                ready.append(child)
    if visited != len(projected):
        return None
    overview_tensors(projected, original, endpoints, owners)
    return {"id": "network-overview", "name": flow["name"], "nodes": projected, "edges": edges}


def _keyword_enabled(call, key):
    return any(kw.arg == key and not (
        isinstance(kw.value, ast.Constant) and (kw.value.value is False or kw.value.value is None)
    ) for kw in call.keywords)


def _simple_target(node):
    return isinstance(node, ast.Name) or (
        isinstance(node, (ast.Tuple, ast.List)) and all(_simple_target(child) for child in node.elts)
    )


def extract_network_flow(model: Path, root: Path, class_name: str | None = None) -> dict | None:
    """Inspect one Python file. Auto-detect nn.Module.forward or explicitly select Class[.method]."""
    root = Path(root).resolve()
    path = (root / model).resolve()
    relative = path.relative_to(root).as_posix()
    with tokenize.open(path) as stream:
        tree = ast.parse(stream.read(), filename=relative)
    aliases = _aliases(tree)
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef)]
    method_name = "forward"
    if class_name is not None:
        parts = class_name.split(".")
        if len(parts) not in (1, 2) or not all(part.isidentifier() for part in parts):
            raise ValueError("Expected a model selector Class or Class.method")
        classes = [c for c in classes if c.name == parts[0]]
        if len(classes) > 1:
            raise ValueError(f"Ambiguous class {parts[0]} in {relative}")
        if not classes:
            raise ValueError(f"No top-level class {parts[0]} in {relative}")
        if len(parts) == 2:
            method_name = parts[1]
    else:
        modules = set()
        for cls in classes:
            bases = {_qualified(b, aliases) for b in cls.bases}
            if "torch.nn.Module" in bases or bases & modules:
                modules.add(cls.name)
        classes = [cls for cls in classes if cls.name in modules]
    matches = [(cls, f) for cls in classes for f in cls.body
               if isinstance(f, ast.FunctionDef) and f.name == method_name]
    if not matches:
        if class_name:
            raise ValueError(f"Selected class does not define {method_name} in {relative}: {class_name}")
        return None
    if len(matches) > 1:
        choices = ", ".join(f"{cls.name}.{f.name}" for cls, f in matches)
        raise ValueError(f"Ambiguous network selection in {relative}: {choices}. Select a unique class/method.")
    cls, method = matches[0]
    return _ForwardGraph(relative, cls, method, aliases).build()
