import json

import pytest

from dsh_paper_library.algorithm_flow import parse_algorithm


def by_label(result, label):
    return next(node for node in result["nodes"] if node["label"] == label)["id"]


def has_edge(result, source, target, kind):
    return any(edge["source"] == by_label(result, source) and edge["target"] == by_label(result, target)
               and edge["kind"] == kind for edge in result["edges"])


def test_nested_loops_keep_provenance_and_back_edges():
    result = parse_algorithm("""Algorithm 1. Synthetic route traversal
// Construct references
1 Initialize R = ∅ // reference points
2 for each path (s,t) ∈ G do // network
3 Set R = {s}
4 while distance > ε do
5 Update path
6 end while
7 Add endpoint
8 End for
9 Return R""")
    assert result["complete"]
    assert has_edge(result, "Update path", "while distance > ε do", "back")
    assert has_edge(result, "while distance > ε do", "Add endpoint", "false")
    assert has_edge(result, "Add endpoint", "for each path (s,t) ∈ G do", "back")
    assert has_edge(result, "for each path (s,t) ∈ G do", "Return R", "false")
    first = result["nodes"][1]
    assert first["source_line"] == 3 and first["line_number"] == 1
    assert first["source_text"] == "1 Initialize R = ∅ // reference points"


def test_if_else_merge_and_nested_branch():
    result = parse_algorithm("""if A then
if B then
Set x
end if
else
Set y
end if
Output result""")
    assert result["complete"]
    assert has_edge(result, "if A then", "if B then", "true")
    assert has_edge(result, "if A then", "Set y", "false")
    assert has_edge(result, "if B then", "Output result", "false")
    assert has_edge(result, "Set x", "Output result", "next")
    assert has_edge(result, "Set y", "Output result", "next")


def test_return_terminates_only_its_branch():
    result = parse_algorithm("if done then\nreturn x\nelse\nSet x\nend if\nOutput x")
    assert result["complete"]
    assert has_edge(result, "return x", "结束", "next")
    assert not has_edge(result, "return x", "Output x", "next")


def test_break_and_continue_inside_if():
    result = parse_algorithm("""for each x do
if done then
break
else
continue
end if
end for
Output x""")
    assert result["complete"]
    assert has_edge(result, "break", "Output x", "next")
    assert has_edge(result, "continue", "for each x do", "back")


@pytest.mark.parametrize("source", [
    "for each x do\nSet x",
    "while A do\nif B then\nSet x\nend while",
    "Set x\nelse\nSet y",
    "repeat\nSet x\nuntil done",
    "if A then\nSet x\nelse if B then\nSet y\nend if",
    "if A then\nSet x\nend",
    "12 Set x\n14 Return x",
    "Return x\nSet y",
    "goto step 1",
    "if then\nSet x\nend if",
    "for do\nSet x\nend for",
    "end loop",
    "Algorithm 1. Empty\n// only a comment",
])
def test_incomplete_or_unsupported_structure_never_claims_complete(source):
    result = parse_algorithm(source)
    assert not result["complete"]
    assert result["warnings"]
    assert not any(node["kind"] == "end" for node in result["nodes"])


@pytest.mark.parametrize("limits", [
    {"max_nodes": 4}, {"max_chars": 25}, {"max_lines": 3}, {"max_edges": 2},
])
def test_budgets_report_truncation(limits):
    result = parse_algorithm("for each x do\nSet x\nSet y\nSet z\nend for\nreturn x", **limits)
    assert result["truncated"] and not result["complete"]
    assert len(result["nodes"]) <= result["limits"]["nodes"]
    assert len(result["edges"]) <= result["limits"]["edges"]


def test_labels_are_plain_data_and_long_labels_keep_original():
    source = 'Print "<script>alert(1)</script>" and a long synthetic result'
    result = parse_algorithm(source, max_label_chars=10)
    assert result["nodes"][1]["label"] == source[:10]
    assert result["nodes"][1]["source_text"] == source
    assert result["nodes"][1]["label_truncated"]
    assert json.loads(json.dumps(result)) == result


def test_simple_steps_and_explicit_end():
    result = parse_algorithm("1. Initialize x\n2: Set y\n3) End")
    assert result["complete"]
    assert [node["line_number"] for node in result["nodes"][1:-1]] == [1, 2, 3]


def test_empty_loop_preserves_true_branch_on_back_edge():
    result = parse_algorithm("while condition do\nend while")
    assert result["complete"]
    loop = by_label(result, "while condition do")
    assert {"source": loop, "target": loop, "kind": "back", "label": "是"} in result["edges"]
