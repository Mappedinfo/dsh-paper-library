"""Extract source-level training steps without importing or running the input."""
from __future__ import annotations

import ast
from dataclasses import dataclass, field, replace
from pathlib import Path
import re
import tokenize



@dataclass
class Step:
    op: str
    title: str
    line: int
    detail: str = ""
    children: list[Step] = field(default_factory=list)
    alternatives: bool = False
    training: bool = False
    function_body: bool = False
    condition: str = ""
    members: list[str] = field(default_factory=list)
    exit_members: list[str] = field(default_factory=list)


def _source(node):
    return ast.unparse(node)


def _short(text, limit=96):
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = _name(node.value)
        return head + "." + node.attr if head else node.attr
    return ""


def _resolve(node, env, seen=frozenset()):
    """Resolve name aliases only. Arbitrary attributes and calls remain symbolic."""
    if isinstance(node, ast.Name) and node.id in env and node.id not in seen:
        return _resolve(env[node.id], env, seen | {node.id})
    return node


def _capture_word(node, env, seen=frozenset()):
    """Freeze operands when the command list is built, before later rebindings."""
    value = _resolve(node, env)
    if value in seen:
        return ast.Subscript(ast.Name(id="unresolved"), ast.Constant(_source(node)), ast.Load())
    seen = seen | {value}
    if isinstance(value, ast.Name):
        return ast.Subscript(ast.Name(id="unresolved"), ast.Constant(value.id), ast.Load())
    if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Div):
        return ast.BinOp(value.left, value.op, _capture_word(value.right, env, seen))
    if isinstance(value, ast.Call) and _name(value.func) in {"str", "Path", "pathlib.Path"}:
        return ast.Call(value.func, [_capture_word(arg, env, seen) for arg in value.args], value.keywords)
    return value


def _mutate_list(env, name, replacement=None):
    previous = env.get(name)
    if previous is None:
        return
    for alias, current in list(env.items()):
        if current is previous:
            if replacement is None:
                env.pop(alias)
            else:
                env[alias] = replacement


def _argv(node, env, seen=frozenset()):
    if isinstance(node, ast.Name) and node.id in env and node.id not in seen:
        return _argv(env[node.id], env, seen | {node.id})
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_capture_word(item, env) for item in node.elts]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _argv(node.left, env, seen)
        right = _argv(node.right, env, seen)
        if left is not None and right is not None:
            return left + right
    return None


def _target_name(node, env, seen=frozenset()):
    node = _resolve(node, env)
    if node in seen:
        return ""
    seen = seen | {node}
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Call) and _name(node.func) in {"str", "Path", "pathlib.Path"} and len(node.args) == 1:
        return _target_name(node.args[0], env, seen)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        # A known basename in a staged or argument-supplied directory identifies
        # the requested command, but does not resolve it to a local source file.
        return _target_name(node.right, env, seen)
    return ""


def _training_name(text):
    return bool(re.search(r"(?:^|[./_\s-])(?:train|training|trainer|fit|finetune)(?:$|[./_\s-])", text.lower()))


def _command(call, fullname, env):
    arg = call.args[0] if call.args else next((kw.value for kw in call.keywords if kw.arg == "args"), None)
    if arg is None:
        return None
    words = _argv(arg, env)
    target = ""
    shell = next((kw.value for kw in call.keywords if kw.arg == "shell"), None)
    direct = shell is None or (isinstance(shell, ast.Constant) and shell.value is False)
    if words and direct:
        exe = _target_name(words[0], env)
        # Inspect script operands only for Python interpreters. A script-shaped
        # string given to echo, for example, is merely an argument.
        if _name(_resolve(words[0], env)) == "sys.executable" or re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", Path(exe).name):
            for i, word in enumerate(words[1:], 1):
                text = _target_name(word, env)
                if text == "-m" and i + 1 < len(words):
                    target = _target_name(words[i + 1], env)
                    break
                if text.endswith(".py"):
                    target = text
                    break
                if text not in {"-B", "-u", "-O", "-OO", "-I", "-s", "-E"}:
                    break
        elif exe:
            target = exe
    parallel = fullname == "subprocess.Popen"
    op = "spawn" if parallel else "command"
    verb = "Launch" if parallel else "Run"
    detail = f"{fullname} called with {_source(arg)}."
    if words is not None:
        detail += " Arguments: " + _short(", ".join(_source(w) for w in words), 360) + "."
    if not target:
        detail += " Command target unresolved statically."
    return Step(op, f"{verb} {target or 'command (unresolved)'}", call.lineno, detail, training=_training_name(target))


def _param_env(fn, call, outer):
    # Preserve symbolic caller argument lists when the callee uses the same
    # parameter name, rather than creating an alias that points to itself.
    bindings = dict(outer)
    params = [*fn.args.posonlyargs, *fn.args.args]
    supplied = {p.arg: a for p, a in zip(params, call.args)}
    supplied.update({kw.arg: kw.value for kw in call.keywords if kw.arg})
    for p in [*params, *fn.args.kwonlyargs]:
        bindings.pop(p.arg, None)
    for key, value in supplied.items():
        words = _argv(value, outer)
        bindings[key] = ast.List(elts=words, ctx=ast.Load()) if words is not None else _resolve(value, outer)
    return bindings


class Reader:
    """Walk the executable entry and directly named local function bodies."""

    def __init__(self, tree):
        self.expansions = 0
        self.aliases = {}
        for stmt in tree.body:
            if isinstance(stmt, ast.Import):
                for item in stmt.names:
                    self.aliases[item.asname or item.name.split(".")[0]] = item.name if item.asname else item.name.split(".")[0]
            elif isinstance(stmt, ast.ImportFrom) and stmt.module:
                for item in stmt.names:
                    self.aliases[item.asname or item.name] = stmt.module + "." + item.name

    def operation(self, call, env):
        name = _name(call.func)
        head, _, tail = name.partition(".")
        full = self.aliases.get(head, head) + ("." + tail if tail else "")
        if full in {"subprocess.run", "subprocess.call", "subprocess.check_output", "subprocess.check_call", "subprocess.Popen"}:
            return _command(call, full, env)
        receiver, _, method = name.rpartition(".")
        variable = receiver.rsplit(".", 1)[-1]
        if method in {"wait", "communicate", "join", "wait_for_everyone"}:
            op, title = "wait", "Wait"
        elif method == "backward":
            op, title = "backward", "Backward pass"
        elif method == "zero_grad":
            op, title = "zero_grad", "Clear gradients"
        elif method == "step" and (variable in {"opt", "optim", "optimizer", "optimiser"} or "optim" in _source(_resolve(ast.Name(id=variable), env)).lower()):
            op, title = "optimizer_step", "Optimizer update"
        elif method == "forward" or (not receiver and method in {"model", "network", "net"}):
            op, title = "forward", "Forward pass"
        elif variable in {"model", "net", "network"} and method in {"predict", "pairs", "encode", "decode"}:
            op, title = "model_call", "Model call"
        elif full.startswith("torch.optim.") and method[:1].isupper():
            op, title = "optimizer", "Create optimizer"
        elif full.startswith("torch.nn.") and method.endswith("Loss"):
            op, title = "loss_function", "Create loss function"
        elif method.lower() in {"loss", "loss_fn", "criterion"} or method.lower().endswith("_loss"):
            op, title = "loss", "Compute loss"
        elif method == "fit" and receiver:
            op, title = "fit", "Fit"
        elif method in {"train", "eval"} and variable in {"model", "network", "net", "module"}:
            op, title = "mode", "Set model mode"
        elif method == "save" and full in {"torch.save", "numpy.save", "numpy.savez"}:
            op, title = "save", "Save"
        elif full in {"builtins.eval", "eval", "exec", "__import__", "importlib.import_module"}:
            return Step("unresolved", "Dynamic call", call.lineno, f"Unresolved static target: {_short(_source(call))}.")
        else:
            return None
        return Step(op, f"{title} · {name}", call.lineno, _short(_source(call), 350),
                    training=op in {"fit", "backward", "optimizer_step"})

    def expression(self, node, env, defs, active):
        if node is None or isinstance(node, ast.Lambda):
            return []
        if isinstance(node, ast.IfExp):
            yes = self.expression(node.body, env, defs, active)
            no = self.expression(node.orelse, env, defs, active)
            arms = [Step("branch", label, node.lineno, children=items)
                    for label, items in (("When true", yes), ("Otherwise", no)) if items]
            return [Step("condition", "If " + _short(_source(node.test)), node.lineno, children=arms)] if arms else []
        steps = []
        for child in ast.iter_child_nodes(node):
            steps.extend(self.expression(child, env, defs, active))
        if not isinstance(node, ast.Call):
            return steps
        operation = self.operation(node, env)
        fn = defs.get(node.func.id) if isinstance(node.func, ast.Name) else None
        if fn is not None and fn not in active:
            if len(active) >= 24 or self.expansions >= 300:
                steps.append(Step("unresolved", "Unexpanded call · " + fn.name, node.lineno, "Static call expansion limit."))
                return steps
            self.expansions += 1
            inner = self.block(fn.body, _param_env(fn, node, env), defs.copy(), active + (fn,))
            if any(child.op != "exit" for child in inner):
                label = fn.name
                if node.args:
                    first = _resolve(node.args[0], env)
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        label += "(" + repr(first.value) + ")"
                wrapper = operation or Step("call", _short(label), node.lineno, _short(_source(node), 350))
                wrapper.children = inner
                wrapper.function_body = True
                steps.append(wrapper)
            elif operation:
                steps.append(operation)
        elif operation:
            steps.append(operation)
        elif not _name(node.func):
            steps.append(Step("unresolved", "Dynamic call", node.lineno, _short(_source(node), 350)))
        elif fn in active:
            steps.append(Step("unresolved", "Recursive call · " + fn.name, node.lineno, "Recursive expansion stops at this call site."))
        return steps

    def block(self, stmts, env, defs, active=()):
        out = []
        for stmt in stmts:
            line = stmt.lineno
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs[stmt.name] = stmt
            elif isinstance(stmt, ast.If):
                yes = self.block(stmt.body, env.copy(), defs.copy(), active)
                no = self.block(stmt.orelse, env.copy(), defs.copy(), active)
                test = _source(stmt.test)
                aborts = len(stmt.body) == 1 and isinstance(stmt.body[0], (ast.Raise, ast.Return, ast.Break, ast.Continue))
                if aborts and not stmt.orelse:
                    action = stmt.body[0]
                    out.append(Step("guard", "If " + _short(test), line, _source(action), condition=test))
                elif yes or no:
                    if aborts:
                        yes = [Step("exit", "Exit branch", line, _source(stmt.body[0]))]
                    paths = [Step("branch", label, body[0].line, children=body)
                             for label, body in (("When true", yes), ("Otherwise", no)) if body]
                    if test in {"__name__ == '__main__'", "'__main__' == __name__"}:
                        out.extend(yes)
                    else:
                        out.append(Step("condition", "If " + _short(test), line, test, paths, alternatives=True))
                # Assignments from alternate branches cannot be substituted as
                # one unconditional value in later commands.
                self.invalidate(stmts=[*stmt.body, *stmt.orelse], env=env)
            elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
                groups = self.block(stmt.body, env.copy(), defs.copy(), active)
                if groups:
                    label = _source(stmt.test) if isinstance(stmt, ast.While) else f"{_source(stmt.target)} in {_source(stmt.iter)}"
                    test = label if isinstance(stmt, ast.While) else "Another item in " + _source(stmt.iter)
                    out.append(Step("loop", "Repeat · " + _short(label), line, "Repeated source block; iteration count is not observed.", groups, condition=test))
                tail = self.block(stmt.orelse, env.copy(), defs.copy(), active)
                if tail:
                    out.append(Step("branch", "On loop completion without break", stmt.orelse[0].lineno, children=tail))
                self.invalidate([stmt], env)
            elif isinstance(stmt, (ast.With, ast.AsyncWith)):
                inner = self.block(stmt.body, env.copy(), defs.copy(), active)
                if inner:
                    out.append(Step("scope", "With " + _short(", ".join(_source(i.context_expr) for i in stmt.items)), line, children=inner))
                self.invalidate(stmt.body, env)
            elif isinstance(stmt, (ast.Try, ast.TryStar)):
                groups = []
                sections = [("Try", stmt.body)] + [("Except " + (_source(h.type) if h.type else "any"), h.body) for h in stmt.handlers]
                sections.extend([("On success", stmt.orelse), ("Finally", stmt.finalbody)])
                for label, section in sections:
                    inner = self.block(section, env.copy(), defs.copy(), active)
                    if inner:
                        groups.append(Step("branch", label, section[0].lineno, children=inner))
                if groups:
                    out.append(Step("scope", "Try / exception handling", line, children=groups, alternatives=True))
                self.invalidate([stmt], env)
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Expr, ast.Return, ast.Raise)):
                value = stmt.exc if isinstance(stmt, ast.Raise) else stmt.value
                out.extend(self.expression(value, env, defs, active))
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and isinstance(value, ast.Call):
                    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                    ctor = value
                    while isinstance(ctor.func, ast.Attribute) and ctor.func.attr in {"to", "cuda", "cpu", "double", "float"} and isinstance(ctor.func.value, ast.Call):
                        ctor = ctor.func.value
                    name = _name(ctor.func)
                    var = targets[0].id if len(targets) == 1 and isinstance(targets[0], ast.Name) else ""
                    if var in {"model", "network", "net"} and name and name.rsplit(".", 1)[-1][:1].isupper():
                        out.append(Step("model_init", f"Create {var} · {name}", line, _short(_source(stmt), 350)))
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and value is not None:
                    for target in (stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]):
                        if isinstance(target, ast.Name):
                            words = _argv(value, env)
                            if words is not None and not isinstance(value, ast.Name):
                                env[target.id] = ast.List(elts=words, ctx=ast.Load())
                            else:
                                env[target.id] = _resolve(value, env)
                            defs.pop(target.id, None)
                        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
                            _mutate_list(env, target.value.id)
                if isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
                    before, more = _argv(stmt.target, env), _argv(value, env)
                    if isinstance(stmt.op, ast.Add) and before is not None and more is not None:
                        _mutate_list(env, stmt.target.id, ast.List(elts=before + more, ctx=ast.Load()))
                    else:
                        _mutate_list(env, stmt.target.id)
                if isinstance(stmt, ast.Expr) and isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
                    target = value.func.value
                    if isinstance(target, ast.Name) and (words := _argv(target, env)) is not None:
                        if value.func.attr == "append" and len(value.args) == 1:
                            _mutate_list(env, target.id, ast.List(elts=words + [_capture_word(value.args[0], env)], ctx=ast.Load()))
                        elif value.func.attr == "extend" and len(value.args) == 1:
                            extra = _argv(value.args[0], env)
                            _mutate_list(env, target.id, ast.List(elts=words + (extra if extra is not None else [ast.Starred(value.args[0])]), ctx=ast.Load()))
                        elif value.func.attr in {"clear", "insert", "pop", "remove", "sort", "reverse"}:
                            _mutate_list(env, target.id)
                if isinstance(stmt, (ast.Return, ast.Raise)):
                    out.append(Step("exit", type(stmt).__name__, line, _source(stmt)))
                    break
            elif isinstance(stmt, (ast.Break, ast.Continue)):
                out.append(Step("exit", type(stmt).__name__, line, _source(stmt)))
                break
            elif isinstance(stmt, ast.Delete):
                self.invalidate([stmt], env)
            elif isinstance(stmt, ast.Match):
                out.append(Step("unresolved", "Match · " + _short(_source(stmt.subject)), line, "Pattern matching is outside the supported training control-flow rules."))
                self.invalidate([stmt], env)
        return out

    @staticmethod
    def invalidate(stmts, env):
        # Conditional additions preserve a known argv prefix; replacing or
        # reordering a list invalidates the command target.
        writes = set()
        appended = set()
        for stmt in stmts:
            for node in ast.walk(stmt):
                if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and isinstance(node.op, ast.Add):
                    appended.add(node.target.id)
                elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.Delete, ast.For, ast.AsyncFor, ast.NamedExpr)):
                    targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
                    for target in targets:
                        for name in ast.walk(target):
                            if isinstance(name, ast.Name):
                                writes.add(name.id)
                elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                    if node.func.attr in {"append", "extend"}:
                        appended.add(node.func.value.id)
                    elif node.func.attr in {"clear", "insert", "pop", "remove", "sort", "reverse"}:
                        writes.add(node.func.value.id)
                elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
                    writes.add(node.target.id)
        for name in writes:
            _mutate_list(env, name)
        for name in appended - writes:
            words = _argv(ast.Name(id=name), env)
            if words is not None:
                _mutate_list(env, name, ast.List(elts=words + [ast.Starred(ast.Name(id="conditional_arguments"))], ctx=ast.Load()))



def extract_training_flow(entry: Path, root: Path):
    """Return a static flow for a Python script with a recognized training operation."""
    root = Path(root).resolve()
    entry = Path(entry)
    if not entry.is_absolute() and not entry.is_file():
        entry = root / entry
    entry = entry.resolve()
    relative = entry.relative_to(root).as_posix()
    with tokenize.open(entry) as source:
        tree = ast.parse(source.read(), filename=relative)
    reader = Reader(tree)
    defs, env = {}, {}
    steps = reader.block(tree.body, env, defs)

    def has_training(group):
        return any(step.training or has_training(step.children) for step in group)

    if not has_training(steps):
        if any(isinstance(stmt, ast.If) and _source(stmt.test) in {"__name__ == '__main__'", "'__main__' == __name__"} for stmt in tree.body):
            return None
        # A source file can expose a training API without a script entry. Select
        # a single explicitly identifiable training definition, not every helper.
        candidates = []
        for name, fn in defs.items():
            if not _training_name(name):
                continue
            inner = reader.block(fn.body, env.copy(), defs.copy(), (fn,))
            if has_training(inner):
                candidates.append(Step("definition", name, fn.lineno, "Training function definition; invocation is not observed.", inner))
        if len(candidates) != 1:
            return None
        steps = candidates
    graph, step_ids = _render(steps, relative)
    if sum(node["op"] in {"spawn", "command"} for node in graph["nodes"]) >= 3:
        overview = _overview(steps, relative, graph, step_ids)
        if overview:
            graph["figure_overview"] = overview
    return graph


def _render(steps, relative, overview=False):
    nodes, edges, step_ids = [], [], {}

    def add(step, incoming, owner):
        nid = ("s" if overview else "t") + str(len(nodes) + 1)
        step_ids[id(step)] = nid
        if step.op in {"model_init", "forward", "model_call"}:
            typ = "model"
        else:
            typ = "output" if step.op == "save" else "method"
        node = {"id": nid, "label": step.title, "type": typ, "op": step.op, "evidence": f"{relative}:{step.line}",
                "ports": {"in": {"in": {"type": "flow"}}, "out": {"out": {"type": "flow"}}}, "detail": step.detail}
        if step.op in {"loop", "guard", "condition"}:
            node["condition"] = step.condition or step.title.removeprefix("If ")
        if owner:
            node["config"] = {"enclosing_node": owner}
        if step.members:
            node.setdefault("config", {})["members"] = step.members
        nodes.append(node)
        for pred, kind in dict.fromkeys(incoming):
            edges.append({"id": f"e{len(edges)+1}", "from": pred + ":out", "to": nid + ":in", "kind": kind})
        return nid

    def escape(nid, statement, exits):
        verb = statement.split(maxsplit=1)[0]
        if verb in exits:
            exits[verb].append((nid, verb))

    def walk(group, incoming, owner, exits):
        # Incoming paths carry their branch reason until the first reachable
        # operation. Containment stays in metadata, never as a second set of edges.
        for index, step in enumerate(group):
            if not incoming and (owner or index):
                break
            nid = add(step, incoming, owner)
            if step.op == "loop":
                local = {**exits, "break": [], "continue": []}
                body = walk(step.children, [(nid, "iteration")], nid, local)
                outcomes = [(pred, "last-iteration") for pred, _ in body + local["continue"]]
                outcomes += [(nid, "zero-iterations"), *local["break"]]
                end = Step("loop_exit", "After loop", step.line, "Repeated iterations are folded; exit after exhaustion or a recognized break.", members=step.exit_members)
                incoming = [(add(end, outcomes, nid), "source-order")]
            elif step.op == "condition":
                paths = {branch.title: branch.children for branch in step.children}
                incoming = []
                for label, kind in (("When true", "condition-true"), ("Otherwise", "condition-false")):
                    incoming.extend(walk(paths.get(label, []), [(nid, kind)], nid, exits))
            elif step.op in {"guard", "exit"}:
                escape(nid, step.detail, exits)
                incoming = [(nid, "condition-false")] if step.op == "guard" else []
            elif step.alternatives:
                sections = {branch.title: branch.children for branch in step.children}
                normal = walk(sections.get("Try", []), [(nid, "try")], nid, exits)
                normal = walk(sections.get("On success", []), normal, nid, exits)
                for label, section in sections.items():
                    if label.startswith("Except "):
                        normal += walk(section, [(nid, "exception-candidate")], nid, exits)
                incoming = walk(sections.get("Finally", []), normal, nid, exits)
            elif step.children:
                if step.op in {"call", "definition"} or step.function_body:
                    local = {**exits, "return": []}
                    incoming = walk(step.children, [(nid, "enter")], nid, local) + local["return"]
                else:
                    incoming = walk(step.children, [(nid, "enter")], nid, exits)
            else:
                incoming = [(nid, "after-launch" if step.op == "spawn" else "source-order")]
        return incoming

    walk(steps, [], None, {})
    outgoing = {}
    for relation in edges:
        outgoing.setdefault(relation["from"].split(":")[0], []).append(relation)
    branch_conditions = {"condition-true": "true", "condition-false": "false", "iteration": "yes",
                         "zero-iterations": "no", "break": "true", "continue": "true", "return": "true"}
    for node in nodes:
        if "condition" not in node:
            continue
        relations = outgoing.get(node["id"], [])
        labels = [branch_conditions.get(relation["kind"]) for relation in relations]
        if len(set(labels)) >= 2 and all(labels):
            node["type"] = "decision"
            for relation, label in zip(relations, labels):
                relation["condition"] = label
    return {"id": "training-overview" if overview else "training",
            "name": "Training stages (static)" if overview else "Training flow (static)",
            "nodes": nodes, "edges": edges}, step_ids


def _overview(steps, relative, graph, step_ids):
    """Fold process boundaries on the normal path while retaining branch structure."""
    by_id = {node["id"]: node for node in graph["nodes"]}
    children = {}
    for nid, node in by_id.items():
        owner = node.get("config", {}).get("enclosing_node")
        children.setdefault(owner, []).append(nid)
    omissions = []

    def members(step):
        nid = step_ids.get(id(step))
        if not nid:
            return []
        ids = [nid]
        for member in ids:
            ids.extend(children.get(member, []))
        return ids

    def compact(group):
        out = []
        for step in group:
            ids = members(step)
            if step.op == "branch":
                out.append(replace(step, children=compact(step.children)))
                continue
            if not ids:
                continue
            items = [by_id[i] for i in ids]
            actions = [n for n in items if n["op"] in {"spawn", "command"}]
            waits = [n for n in items if n["op"] == "wait"]
            guards = [n for n in items if n["op"] == "guard"]
            decisions = any(n["op"] == "condition" or (n["op"] == "guard" and not n["detail"].startswith("raise")) for n in items)
            if step.alternatives and step.op == "scope":
                for section in step.children:
                    cleanup = any(re.search(r"(?:^|_)(?:stop|close|clean|terminate|release|cancel|shutdown)(?:_|$)", c.title, re.I) for c in section.children)
                    if section.title in {"Try", "On success"} or (section.title == "Finally" and not cleanup):
                        out.extend(compact(section.children))
                    else:
                        for item in section.children:
                            omissions.extend(members(item))
                continue
            if step.op == "guard" and step.detail.startswith("raise"):
                explanation = f"{relative}:{step.line}: if {step.condition}, {step.detail}."
                if out and out[-1].op in {"checks", "stage", "wait_group"}:
                    last = out[-1]
                    last.detail += "\n" + explanation
                    last.members.extend(ids)
                else:
                    out.append(Step("checks", "Check prerequisites", step.line, explanation, members=ids))
                continue
            if step.op == "loop" and not decisions:
                scope = step.title.removeprefix("Repeat · ")
                if len(actions) == 1 and not waits:
                    action = actions[0]
                    stem = "Launch per group · " if action["op"] == "spawn" else "Run per item · "
                    op, label = "launch_group", stem + action["label"].partition(" ")[2]
                elif len(waits) == 1 and not actions:
                    worker_loop = re.search(r"worker|process|thread|future", scope, re.I)
                    op, label = "wait_group", "Wait for each worker" if worker_loop else "Wait for each item"
                elif guards and not actions and not waits and all(n["op"] in {"loop", "loop_exit", "guard"} for n in items):
                    frozen = any("frozen" in n.get("condition", "").lower() for n in guards)
                    op, label = "checks", "Check each frozen status" if frozen else "Check each item"
                else:
                    op = ""
                if op:
                    evidence = [scope] + [n["evidence"] + ": " + n.get("condition", n["label"]) for n in items if n["op"] in {"spawn", "command", "wait", "guard"}]
                    out.append(Step(op, label, step.line, "\n".join(evidence), members=ids))
                    continue
            if step.op == "call" and len(actions) == 1 and not decisions:
                label = step.title if "(" in step.title else actions[0]["label"]
                out.append(Step("stage", label, step.line, step.detail + "\n" + actions[0]["label"], members=ids))
            elif step.op in {"scope", "call", "definition"} and step.children:
                out.extend(compact(step.children))
            elif step.op in {"spawn", "command"}:
                out.append(replace(step, op="stage", members=ids))
            else:
                # Retained control blocks own only their header. Their visible
                # branches and folded loop exit own disjoint detailed members.
                own_id = ids[0]
                exits = [i for i in children.get(own_id, []) if by_id[i]["op"] == "loop_exit"]
                out.append(replace(step, members=[own_id], exit_members=exits, children=compact(step.children)))
        return out

    phases = compact(steps)
    if not phases:
        return None
    reduced, _ = _render(phases, relative, overview=True)
    if len(reduced["nodes"]) >= len(graph["nodes"]):
        return None
    if omissions:
        reduced["detail"] = "Normal path. Exception handling and finally cleanup remain in the detailed training flow."
        reduced["omitted_members"] = list(dict.fromkeys(omissions))
    return reduced
