"""Shape contracts inferred from source syntax. Dimensions are never sampled at runtime."""

from __future__ import annotations

import ast
import re
from collections import Counter
from math import prod


def annotated_shape(annotation: ast.expr | None) -> list | None:
    """Read Annotated[Tensor, 'B,T,64']; [] is scalar, ? one axis, ... an arbitrary prefix."""
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        try:
            annotation = ast.parse(annotation.value, mode="eval").body
        except SyntaxError:
            return None
    if not (
        isinstance(annotation, ast.Subscript)
        and ast.unparse(annotation.value).split(".")[-1] == "Annotated"
        and isinstance(annotation.slice, ast.Tuple)
        and len(annotation.slice.elts) >= 2
        and ast.unparse(annotation.slice.elts[0]).split(".")[-1] == "Tensor"
    ):
        return None
    for meta in annotation.slice.elts[1:]:
        if not isinstance(meta, ast.Constant) or not isinstance(meta.value, str):
            continue
        text = meta.value.strip()
        if text.startswith("shape:"):
            text = text[6:].strip()
        if text == "[]":
            return []
        dims = [item.strip() for item in text.split(",")]
        if all(re.fullmatch(r"[A-Za-z][A-Za-z_0-9]*|\d+|\?|\.\.\.", d) for d in dims):
            if "..." not in dims[1:]:
                return [int(d) if d.isdecimal() else d for d in dims]
    return None


def tensor_record(inputs=(), outputs=(), parameters=(), *, note=None, applicable=True):
    ins, outs, params = list(inputs), list(outputs), list(parameters)
    shapes = [x["shape"] for x in [*ins, *outs, *params] if x.get("kind") != "none"]
    status = "not_applicable"
    if applicable:
        if not shapes or all(s is None for s in shapes):
            status = "unknown"
        elif any(s is None or any(d in ("?", "...") for d in s) for s in shapes):
            status = "partial"
        else:
            status = "inferred"
    result = dict(inputs=ins, outputs=outs, parameters=params, status=status)
    if note:
        result["note"] = note
    return result


def _entry(name, shape, note=None):
    entry = {"name": name, "shape": shape}
    if note:
        entry["note"] = note
    return entry


def _int(expr):
    if isinstance(expr, ast.Constant) and type(expr.value) is int:
        return expr.value
    if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.USub):
        value = _int(expr.operand)
        return -value if value is not None else None
    return None


def _dim(value):
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[a-zA-Z_]\w*(?:\.\w+)*", value):
        return value
    return "?"


def _dimensions(value, size):
    if isinstance(value, str) and value.startswith(("(", "[")):
        try:
            node = ast.parse(value, mode="eval").body
        except SyntaxError:
            return ["?"] * size
        if isinstance(node, (ast.Tuple, ast.List)) and len(node.elts) == size:
            return [_dim(_int(d)) for d in node.elts]
        return ["?"] * size
    return [_dim(value)] * size


def _known_rank(shape):
    return shape is not None and "..." not in shape


def _axis(i, rank):
    return i % rank if i is not None and rank and -rank <= i < rank else None


def _broadcast(a, b):
    if a is None or b is None:
        return None
    if not a or a == b:
        return list(b)
    if not b:
        return list(a)
    if "..." in a or "..." in b:
        return None
    output = []
    for i in range(1, max(len(a), len(b)) + 1):
        x, y = a[-i] if i <= len(a) else 1, b[-i] if i <= len(b) else 1
        if x == 1 or x == y:
            output.append(y)
        elif y == 1:
            output.append(x)
        elif isinstance(x, int) and isinstance(y, int):
            return None
        else:
            output.append("?")  # Different symbols can be 1, equal, or incompatible.
    return output[::-1]


def _reshape(input_shape, requested):
    if requested.count(-1) > 1 or any(type(d) is int and d < -1 for d in requested):
        return None
    result = list(requested)
    if -1 not in result:
        if (
            _known_rank(input_shape)
            and all(type(d) is int for d in [*input_shape, *result])
            and prod(input_shape) != prod(result)
        ):
            return None
        return result
    idx = result.index(-1)
    result[idx] = "?"
    if not _known_rank(input_shape) or "?" in input_shape:
        return result
    explicit = requested[:idx] + requested[idx + 1 :]
    if "?" in explicit or 0 in explicit:
        return result
    symbols = Counter(d for d in input_shape if isinstance(d, str))
    symbols.subtract(d for d in explicit if isinstance(d, str))
    numerator = prod(d for d in input_shape if isinstance(d, int))
    divisor = prod(d for d in explicit if isinstance(d, int))
    if any(v < 0 for v in symbols.values()) or numerator % divisor:
        return result if any(symbols.values()) else None
    factors = sorted(symbols.elements())
    factor = numerator // divisor
    result[idx] = (
        factor if not factors else "×".join(factors + ([str(factor)] if factor != 1 else []))
    )
    return result


def _arg(call, name, position, function=False):
    aliases = {"dim": "axis", "keepdim": "keepdims"}
    for word in call.keywords:
        if word.arg == name or (word.arg is not None and word.arg == aliases.get(name)):
            return word.value
    return (
        call.args[position + int(function)] if len(call.args) > position + int(function) else None
    )


def _shape_expr(expr, lookup):
    value = _int(expr)
    if value is not None:
        return value
    owner, index = None, None
    if (
        isinstance(expr, ast.Call)
        and isinstance(expr.func, ast.Attribute)
        and expr.func.attr == "size"
        and len(expr.args) == 1
    ):
        owner, index = expr.func.value, _int(expr.args[0])
    elif (
        isinstance(expr, ast.Subscript)
        and isinstance(expr.value, ast.Attribute)
        and expr.value.attr == "shape"
    ):
        owner, index = expr.value.value, _int(expr.slice)
    shape = lookup(owner.id) if isinstance(owner, ast.Name) else None
    axis = _axis(index, len(shape)) if _known_rank(shape) else None
    return shape[axis] if axis is not None else "?"


def _sliced(shape, key):
    if not _known_rank(shape):
        return None
    keys = key.elts if isinstance(key, ast.Tuple) else [key]
    ellipses = sum(isinstance(k, ast.Constant) and k.value is Ellipsis for k in keys)
    occupied = sum(
        not (isinstance(k, ast.Constant) and (k.value is None or k.value is Ellipsis)) for k in keys
    )
    if ellipses > 1 or occupied > len(shape):
        return None
    out, i = [], 0
    for k in keys:
        if isinstance(k, ast.Constant) and k.value is None:
            out.append(1)
        elif isinstance(k, ast.Constant) and k.value is Ellipsis:
            end = i + len(shape) - occupied
            out.extend(shape[i:end])
            i = end
        elif isinstance(k, ast.Slice):
            bound = [None if item is None else _int(item) for item in (k.lower, k.upper, k.step)]
            if k.lower is None and k.upper is None and k.step is None:
                out.append(shape[i])
            elif (
                type(shape[i]) is int
                and bound[2] != 0
                and all(
                    v is None or n is not None for v, n in zip((k.lower, k.upper, k.step), bound)
                )
            ):
                out.append(len(range(*slice(*bound).indices(shape[i]))))
            else:
                out.append("?")
            i += 1
        elif _int(k) is not None:
            i += 1
        else:
            return None  # Advanced indexing needs the index shape and often its values.
    return out + shape[i:]


def _parameter_shape(node):
    try:
        ctor = ast.parse(node["config"]["layer_call"], mode="eval").body
    except (KeyError, SyntaxError):
        return None
    if not isinstance(ctor, ast.Call) or not ctor.args or not isinstance(ctor.args[0], ast.Call):
        return None
    init = ctor.args[0]
    if ast.unparse(init.func).split(".")[-1] not in {
        "empty",
        "zeros",
        "ones",
        "full",
        "rand",
        "randn",
    }:
        return None
    dims = list(init.args)
    if dims and isinstance(dims[0], (ast.List, ast.Tuple)):
        if not dims[0].elts:
            return []
        dims = dims[0].elts
    elif len(dims) == 1 and isinstance(dims[0], (ast.Name, ast.Attribute)):
        return None
    elif ast.unparse(init.func).split(".")[-1] == "full":
        return None
    if not dims or any(isinstance(d, ast.Starred) for d in dims):
        return None
    return [_dim(_int(d) if _int(d) is not None else ast.unparse(d)) for d in dims]


def _layer(node, loc, ins, lookup):
    op = node["op"].split(".")[-1]
    params = node["config"]["parameters"]
    shape = ins[0]["shape"] if ins else None
    if (
        any(w.get("name") == "**" for w in node["config"].get("extra_keywords", []))
        or any(isinstance(v, str) and v.startswith("*") for v in params.values())
        or any(isinstance(a, ast.Starred) for a in loc.args)
        or any(k.arg is None for k in loc.keywords)
    ):
        return tensor_record(
            ins, [_entry("output", None)], note="Arguments are expanded dynamically."
        )
    weights, out, note = [], None, None

    def dim(k):
        return _dim(params.get(k))

    if op == "Linear":
        n, m = dim("in_features"), dim("out_features")
        weights = [_entry("weight", [m, n])]
        if shape is None:
            if ins:
                ins[0] = {
                    **ins[0],
                    "shape": ["...", n],
                    "note": "Required by the Linear declaration.",
                }
            out = ["...", m]
        elif not shape or (isinstance(shape[-1], int) and isinstance(n, int) and shape[-1] != n):
            note = "Input shape conflicts with the declared Linear input width."
        else:
            out = ["...", m] if shape[-1] == "..." else [*shape[:-1], m]
    elif op == "Embedding":
        n, m = dim("num_embeddings"), dim("embedding_dim")
        weights = [_entry("weight", [n, m])]
        out = [*(shape if shape is not None else ["..."]), m]
    elif op in ("Conv1d", "Conv2d", "Conv3d"):
        rank = int(op[-2])
        ci, co = dim("in_channels"), dim("out_channels")
        k = _dimensions(params.get("kernel_size"), rank)
        stride = _dimensions(params.get("stride", 1), rank)
        dilation = _dimensions(params.get("dilation", 1), rank)
        padding = params.get("padding", 0)
        pads = _dimensions(0 if padding in ("same", "valid") else padding, rank)
        groups = params.get("groups", 1)
        per_group = (
            ci
            if groups == 1
            else (
                ci // groups
                if type(ci) is int and type(groups) is int and groups > 0 and ci % groups == 0
                else "?"
            )
        )
        weights = [_entry("weight", [co, per_group, *k])]
        if _known_rank(shape) and len(shape) in (rank + 1, rank + 2):
            axis = len(shape) - rank - 1
            if isinstance(shape[axis], int) and isinstance(ci, int) and shape[axis] != ci:
                note = "Input channel count conflicts with the convolution declaration."
            else:
                spatial = []
                for d, kernel, step, pad, dil in zip(shape[axis + 1 :], k, stride, pads, dilation):
                    if padding == "same" and step == 1:
                        spatial.append(d)
                    elif all(type(v) is int for v in (kernel, step, pad, dil)) and step > 0:
                        offset = 2 * pad - dil * (kernel - 1) - 1
                        if type(d) is int:
                            value = (d + offset) // step + 1
                            spatial.append(value if value > 0 else "?")
                        elif step == 1 and offset == -1:
                            spatial.append(d)
                        else:
                            spatial.append("?")
                    else:
                        spatial.append("?")
                out = [*shape[:axis], co, *spatial]
        else:
            note = f"{op} requires {rank} spatial axes and permits zero or one leading batch axis."
    elif op == "MultiheadAttention":
        return _attention(loc, params, ins, lookup)
    elif op == "LayerNorm":
        value = params.get("normalized_shape")
        if isinstance(value, str) and value.startswith(("[", "(")):
            try:
                dims = ast.parse(value, mode="eval").body
            except SyntaxError:
                dims = None
            norm = (
                [_dim(_int(d) if _int(d) is not None else ast.unparse(d)) for d in dims.elts]
                if isinstance(dims, (ast.Tuple, ast.List))
                else None
            )
        else:
            norm = [_dim(value)] if type(value) is int else None
        affine = params.get("elementwise_affine", True)
        if affine is not False:
            note_if = None if affine is True else "Conditional on elementwise_affine."
            weights = [_entry("weight", norm, note_if)]
            if params.get("bias", True) is not False:
                weights.append(_entry("bias", norm, note_if))
        if shape is None and norm:
            out = ["...", *norm]
        elif (
            norm
            and _known_rank(shape)
            and (
                len(shape) < len(norm)
                or any(
                    type(a) is int and type(b) is int and a != b
                    for a, b in zip(shape[-len(norm) :], norm)
                )
            )
        ):
            note = "Input suffix conflicts with normalized_shape."
        else:
            out = shape
    elif op in (
        "ReLU",
        "ReLU6",
        "GELU",
        "SiLU",
        "Sigmoid",
        "Tanh",
        "LeakyReLU",
        "Dropout",
        "Identity",
        "Softmax",
        "LogSoftmax",
    ):
        out = shape
    else:
        note = "No static shape rule for this layer."
    if op in ("Linear", "Conv1d", "Conv2d", "Conv3d"):
        bias = params.get("bias", True)
        if bias is not False:
            weights.append(
                _entry(
                    "bias",
                    [dim("out_features" if op == "Linear" else "out_channels")],
                    None if bias is True else "Present only when the source bias option is true.",
                )
            )
    return tensor_record(ins, [_entry("output", out)], weights, note=note)


def _attention(call, params, inputs, lookup):
    """nn.MultiheadAttention returns a pair; only query sets the output sequence length."""
    size, heads = _dim(params.get("embed_dim")), _dim(params.get("num_heads"))
    packed = 3 * size if type(size) is int else (f"3×{size}" if size != "?" else "?")
    kd = params.get("kdim") or size
    vd = params.get("vdim") or size
    if kd == size and vd == size:
        weights = [_entry("in_proj_weight", [packed, size])]
    else:
        weights = [
            _entry("q_proj_weight", [size, size]),
            _entry("k_proj_weight", [size, _dim(kd)]),
            _entry("v_proj_weight", [size, _dim(vd)]),
        ]
    weights.append(_entry("out_proj.weight", [size, size]))
    if params.get("bias", True) is not False:
        weights.extend([_entry("in_proj_bias", [packed]), _entry("out_proj.bias", [size])])
    if params.get("add_bias_kv") is True:
        weights.extend([_entry("bias_k", [1, 1, size]), _entry("bias_v", [1, 1, size])])
    shapes = []
    for i, name in enumerate(("query", "key", "value")):
        expr = _arg(call, name, i)
        # Positional graph operands preserve duplicates (e.g. self attention).
        shape = (
            lookup(expr.id)
            if isinstance(expr, ast.Name)
            else inputs[i]["shape"]
            if i < len(call.args) and i < len(inputs)
            else None
        )
        shapes.append(shape)
    ins = [_entry(n, shape) for n, shape in zip(("query", "key", "value"), shapes)]
    ins.extend(inputs[3:])
    q, k, v = shapes
    layout = params.get("batch_first", False)
    valid = q is not None and len(q) in (2, 3) and "..." not in q
    for shape, width in zip(shapes, (size, kd, vd)):
        if shape is not None and (
            not shape or (type(shape[-1]) is int and type(width) is int and width != shape[-1])
        ):
            valid = False
    if valid and any(_known_rank(x) and len(x) != len(q) for x in (k, v)):
        valid = False
    axis = 0 if valid and len(q) == 2 else (int(layout) if type(layout) is bool else None)
    if valid and axis is not None and _known_rank(k) and _known_rank(v):
        pairs = [(k[axis], v[axis])]
        if len(q) == 3:
            pairs.extend([(q[1 - axis], k[1 - axis]), (q[1 - axis], v[1 - axis])])
        if any(type(a) is int and type(b) is int and a != b for a, b in pairs):
            valid = False
    output = [*q[:-1], size] if valid else None
    needs_arg, avg_arg = _arg(call, "need_weights", 4), _arg(call, "average_attn_weights", 6)
    needs = (
        True
        if needs_arg is None
        else (needs_arg.value if isinstance(needs_arg, ast.Constant) else None)
    )
    average = (
        True if avg_arg is None else (avg_arg.value if isinstance(avg_arg, ast.Constant) else None)
    )
    weight_shape = None
    if valid and _known_rank(k) and axis is not None and type(average) is bool:
        prefix = [] if len(q) == 2 else [q[1 - axis]]
        source_length = k[axis]
        flags = [params.get("add_bias_kv", False), params.get("add_zero_attn", False)]
        if not all(isinstance(f, bool) for f in flags):
            source_length = "?"
        elif sum(flags):
            source_length = (
                source_length + sum(flags)
                if type(source_length) is int
                else f"{source_length}+{sum(flags)}"
                if source_length != "?"
                else "?"
            )
        weight_shape = [*prefix, *([] if average else [heads]), q[axis], source_length]
    if needs is False:
        attention = {
            **_entry("attn_weights", None, "None because need_weights=False."),
            "kind": "none",
        }
    else:
        attention = _entry(
            "attn_weights",
            weight_shape if needs is True else None,
            "Conditional on need_weights." if needs is None else None,
        )
    return tensor_record(ins, [_entry("attn_output", output), attention], weights)


_ELEMENTWISE = set(
    """relu relu6 gelu silu tanh sigmoid leaky_relu dropout softmax log_softmax exp log log1p
sqrt square abs cos sin clamp clamp_min clamp_max clone detach contiguous float double int long round to cpu cuda type_as""".split()
)


def _matmul(left, right):
    if not (_known_rank(left) and _known_rank(right)) or not left or not right:
        return None
    a = [1, *left] if len(left) == 1 else left
    b = [*right, 1] if len(right) == 1 else right
    if type(a[-1]) is int and type(b[-2]) is int and a[-1] != b[-2]:
        return None
    prefix = _broadcast(a[:-2], b[:-2])
    if prefix is None:
        return None
    return [*prefix, *([a[-2]] if len(left) > 1 else []), *([b[-1]] if len(right) > 1 else [])]


def _tensor_call(loc, op, shapes, lookup):
    base = shapes[0] if shapes else None
    name = op.split(".")[-1]
    fn = op.startswith("torch.")
    if any(isinstance(a, ast.Starred) for a in loc.args) or any(
        k.arg is None for k in loc.keywords
    ):
        return [("output", None)]
    if name in ("matmul", "mm", "bmm") and len(shapes) >= 2:
        rank = {"mm": 2, "bmm": 3}.get(name)
        if rank and not all(_known_rank(s) and len(s) == rank for s in shapes[:2]):
            return [("output", None)]
        if name == "bmm" and shapes[0][0] != shapes[1][0]:
            return [("output", None)]
        return [("output", _matmul(shapes[0], shapes[1]))]
    if fn and name in ("zeros", "ones", "rand", "randn", "empty", "full"):
        if loc.args:
            first = loc.args[0]
            if isinstance(first, (ast.Tuple, ast.List)):
                dims = first.elts
            elif name == "full" or (
                len(loc.args) == 1 and isinstance(first, (ast.Name, ast.Attribute))
            ):
                dims = None
            else:
                dims = loc.args
        else:
            size = next((w.value for w in loc.keywords if w.arg == "size"), None)
            dims = size.elts if isinstance(size, (ast.Tuple, ast.List)) else None
        if dims is None or any(isinstance(d, ast.Starred) for d in dims):
            return [("output", None)]
        return [("output", [_shape_expr(d, lookup) for d in dims])]
    if name in _ELEMENTWISE:
        return [("output", base)]
    if name in {"add", "sub", "mul", "div", "maximum", "minimum", "pow"}:
        return [("output", _broadcast(base, shapes[1]) if len(shapes) > 1 else base)]
    if name in {"view_as", "reshape_as", "expand_as"} and len(shapes) > 1:
        return [("output", shapes[1])]
    if name in {"view", "reshape"}:
        dims = loc.args[int(fn) :]
        if not dims:
            arg = _arg(loc, "shape", 0, fn)
            dims = [arg] if arg else []
        if len(dims) == 1 and isinstance(dims[0], (ast.Tuple, ast.List)):
            dims = dims[0].elts
        elif len(dims) == 1 and isinstance(dims[0], (ast.Name, ast.Attribute)):
            return [("output", None)]  # May denote an entire shape tuple rather than one dimension.
        return [("output", _reshape(base, [_shape_expr(d, lookup) for d in dims]))]
    if name in ("zeros_like", "ones_like", "empty_like", "randn_like", "full_like"):
        return [("output", base)]
    if name in ("cat", "stack"):
        axis_arg = _arg(loc, "dim", 1)
        axis = 0 if axis_arg is None else _int(axis_arg)
        if (
            not shapes
            or not _known_rank(base)
            or not all(_known_rank(s) and len(s) == len(base) for s in shapes)
        ):
            return [("output", None)]
        axis = _axis(axis, len(base) + (name == "stack"))
        if axis is None:
            return [("output", None)]
        result = list(base)
        for i in range(len(base)):
            if name == "cat" and i == axis:
                continue
            vals = {s[i] for s in shapes}
            if len({v for v in vals if type(v) is int}) > 1:
                return [("output", None)]
            if len(vals) > 1:
                result[i] = "?"
        if name == "stack":
            result.insert(axis, len(shapes))
        else:
            sizes = [s[axis] for s in shapes]
            result[axis] = sum(sizes) if all(type(v) is int for v in sizes) else "?"
        return [("output", result)]
    if name in ("sum", "mean", "amax", "amin", "max", "min", "argmax", "argmin"):
        arg = _arg(loc, "dim", 0, fn)
        keep = _arg(loc, "keepdim", 1, fn)
        keepdim = (
            keep.value if isinstance(keep, ast.Constant) else (False if keep is None else None)
        )
        if name in ("max", "min") and any(kw.arg == "other" for kw in loc.keywords):
            return [("output", _broadcast(base, shapes[1]) if len(shapes) > 1 else None)]
        if arg is None:
            out = [] if keepdim is False else None
        elif not _known_rank(base) or type(keepdim) is not bool:
            out = None
        else:
            raw = arg.elts if isinstance(arg, (ast.Tuple, ast.List)) else [arg]
            axes = [_axis(_int(a), len(base)) for a in raw]
            out = (
                None
                if None in axes or len(set(axes)) != len(axes)
                else [1 if i in axes else d for i, d in enumerate(base) if keepdim or i not in axes]
            )
        if name in ("max", "min") and arg is not None:
            # max(x, y) is the distinct elementwise overload; only integer dim returns indices.
            if _int(arg) is None:
                return [("output", None)]
            return [("values", out), ("indices", out)]
        return [("output", out)]
    if name in ("flatten", "permute", "transpose", "unsqueeze", "squeeze"):
        if not _known_rank(base):
            return [("output", None)]
        dims = list(loc.args[int(fn) :])
        if len(dims) == 1 and isinstance(dims[0], (ast.Tuple, ast.List)):
            dims = dims[0].elts
        if name == "flatten":
            a, b = _arg(loc, "start_dim", 0, fn), _arg(loc, "end_dim", 1, fn)
            lo, hi = (
                _axis(0 if a is None else _int(a), len(base)),
                _axis(-1 if b is None else _int(b), len(base)),
            )
            if base == [] and a is None and b is None:
                out = [1]
            elif lo is None or hi is None or lo > hi:
                out = None
            else:
                middle = base[lo : hi + 1]
                flat = (
                    prod(middle)
                    if all(type(i) is int for i in middle)
                    else ("×".join(map(str, middle)) if "?" not in middle else "?")
                )
                out = [*base[:lo], flat, *base[hi + 1 :]]
        elif name == "permute":
            axes = [_axis(_int(d), len(base)) for d in dims]
            out = (
                [base[i] for i in axes]
                if set(axes) == set(range(len(base))) and len(axes) == len(base)
                else None
            )
        elif name == "transpose":
            i, j = (
                _axis(_int(_arg(loc, "dim0", 0, fn)), len(base)),
                _axis(_int(_arg(loc, "dim1", 1, fn)), len(base)),
            )
            out = list(base) if i is not None and j is not None else None
            if out is not None:
                out[i], out[j] = out[j], out[i]
        else:
            dim = _arg(loc, "dim", 0, fn)
            i = _axis(_int(dim), len(base) + (name == "unsqueeze"))
            if name == "unsqueeze":
                out = [*base[:i], 1, *base[i:]] if i is not None else None
            elif dim is None:
                out = [v for v in base if v != 1] if all(type(v) is int for v in base) else None
            elif i is None or type(base[i]) is not int:
                out = None
            else:
                out = [*base[:i], *base[i + 1 :]] if base[i] == 1 else base
        return [("output", out)]
    if name == "where" and len(shapes) == 3:
        return [("output", _broadcast(shapes[0], _broadcast(shapes[1], shapes[2])))]
    return [("output", None)]


def infer_network_tensor(node, loc, parents, lookup, argument_shape=None):
    """Infer one graph node using SSA producer records; keep indeterminate ranks unknown."""
    op = node["op"]
    ins = []
    for parent in parents:
        outs = parent["tensor"]["outputs"]
        if len(outs) == 1:
            ins.append(_entry(parent["label"], outs[0]["shape"]))
        else:
            ins.extend({**o, "name": parent["label"] + "." + o["name"]} for o in outs)
    shapes = [x["shape"] for x in ins]
    if op in (".size",) or (
        op == "attribute" and isinstance(loc, ast.Attribute) and loc.attr == "shape"
    ):
        return tensor_record(applicable=False, note="Python dimension or shape metadata.")
    if op == "input":
        return tensor_record(
            outputs=[_entry(node["label"], argument_shape)],
            note=(
                "Source Annotated tensor shape."
                if argument_shape is not None
                else "Input rank is undeclared."
            ),
        )
    if node["config"].get("resolution") == "unresolved":
        return tensor_record(
            ins, [_entry("output", None)], note="Unresolved source region or operation."
        )
    if op == "torch.nn.Parameter":
        shape = _parameter_shape(node)
        return tensor_record(
            outputs=[_entry(node["label"], shape)], parameters=[_entry(node["label"], shape)]
        )
    if node["type"] == "model":
        return _layer(node, loc, ins, lookup)
    if op == "return":
        outs = [_entry(x["name"], x["shape"]) for x in ins]
        if not outs and isinstance(loc, ast.Return) and isinstance(loc.value, ast.Constant):
            return tensor_record(applicable=False, note="Return of a Python constant.")
        return tensor_record(ins, outs)
    if op == "unpack":
        index = node["config"]["index"]
        outs = parents[0]["tensor"]["outputs"] if len(parents) == 1 else []
        shape = outs[index]["shape"] if len(outs) > 1 and index < len(outs) else None
        if len(outs) == 1 and _known_rank(outs[0]["shape"]) and outs[0]["shape"]:
            shape = outs[0]["shape"][1:]
        return tensor_record(ins, [_entry(f"item {index}", shape)])
    base = shapes[0] if shapes else None
    if op == "MatMult":
        outputs = [("output", _matmul(base, shapes[1] if len(shapes) > 1 else None))]
    elif op in {"Add", "Sub", "Mult", "Div", "FloorDiv", "Pow", "Mod"}:
        shape = _broadcast(base, shapes[1]) if len(shapes) > 1 else base
        outputs = [("output", shape)]
    elif op in {"USub", "UAdd"}:
        outputs = [("output", base)]
    elif op == "getitem" and isinstance(loc, ast.Subscript):
        values = parents[0]["tensor"]["outputs"] if parents else []
        if len(values) > 1:
            i = _axis(_int(loc.slice), len(values))
            if i is not None and values[i].get("kind") == "none":
                return tensor_record(applicable=False, note=values[i].get("note"))
            outputs = [("output", values[i]["shape"] if i is not None else None)]
        else:
            outputs = [("output", _sliced(base, loc.slice))]
    elif isinstance(loc, ast.Call):
        outputs = _tensor_call(loc, op, shapes, lookup)
    else:
        outputs = [("output", None)]
    return tensor_record(ins, [_entry(name, shape) for name, shape in outputs])


def overview_tensors(projected, original, endpoints, owners):
    """Expose the tensors crossing each source-backed group and its member parameters."""
    for group in projected:
        members = group["config"]["members"]
        if len(members) == 1:
            group["tensor"] = original[members[0]]["tensor"]
            continue
        local = set(members)
        entering = list(dict.fromkeys(a for a, b, _ in endpoints if b in local and a not in local))
        leaving = list(dict.fromkeys(a for a, b, _ in endpoints if a in local and b not in local))
        leaving.extend(i for i in members if original[i]["type"] == "output" and i not in leaving)

        def boundary(ids, role):
            found = []
            for uid in ids:
                node = original[uid]
                for entry in node["tensor"][role]:
                    prefix = node["config"].get("attribute", node["label"])
                    name = (
                        prefix
                        if entry["name"] in ("output", prefix)
                        else prefix + "." + entry["name"]
                    )
                    found.append({**entry, "name": name})
            return found

        group["tensor"] = tensor_record(
            boundary(entering, "outputs"),
            boundary(leaving, "outputs"),
            boundary(members, "parameters"),
            note="Detailed member boundaries.",
        )
