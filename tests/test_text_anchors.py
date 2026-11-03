"""合成文字锚点：唯一、歧义、规范化和预算拒绝。"""
from dsh_paper_library.text_anchors import find_unique_anchor, prepare_anchor_text


QUOTE = "The synthetic experiment measures demand across several independent regions and reports a stable comparison."


def test_unique_exact_span_stays_in_original_character_coordinates():
    text = "前置😀\n" + QUOTE + "\nTrailing material."
    got = find_unique_anchor(text, QUOTE)
    assert got["status"] == "matched" and got["method"] == "exact"
    assert text[got["start"]:got["end"]] == QUOTE


def test_nfc_and_whitespace_mapping_includes_original_combining_characters():
    quote = "Café measurements preserve the exact numerical result 12.5."
    current = "prefix\nCafe\u0301\tmeasurements\n  preserve the exact numerical result 12.5.\nsuffix"
    got = find_unique_anchor(current, quote)
    assert got["status"] == "matched" and got["method"] == "normalized"
    assert current[got["start"]:got["end"]] == "Cafe\u0301\tmeasurements\n  preserve the exact numerical result 12.5."
    assert find_unique_anchor(prepare_anchor_text(current), quote) == got


def test_normalized_duplicate_refuses_even_when_only_one_raw_quote_exists():
    text = QUOTE + "\n" + QUOTE.replace(" ", "\n")
    got = find_unique_anchor(text, QUOTE)
    assert got["status"] == "ambiguous" and "start" not in got


def test_short_empty_or_common_labels_are_not_guessed():
    for quote in ("", "   ", "Introduction", "x = 2", "R²", "Method"):
        assert find_unique_anchor("Prefix " + quote + " suffix", quote)["status"] == "unsupported"


def test_small_unique_edit_matches_but_retains_exact_current_span():
    current = QUOTE.replace("stable", "steady")
    got = find_unique_anchor("Unrelated prefix.\n" + current + "\nUnrelated suffix.", QUOTE)
    assert got["status"] == "matched" and got["method"] == "fuzzy"
    assert got["score"] >= 0.96
    assert current == ("Unrelated prefix.\n" + current + "\nUnrelated suffix.")[got["start"]:got["end"]]


def test_two_near_duplicates_are_ambiguous_instead_of_choosing_first_or_closest():
    one = QUOTE.replace("stable", "steady")
    two = QUOTE.replace("demand", "supply")
    assert find_unique_anchor(one + "\nUnrelated separation.\n" + two, QUOTE)["status"] == "ambiguous"
    assert find_unique_anchor(two + "\nUnrelated separation.\n" + one, QUOTE)["status"] == "ambiguous"


def test_case_numbers_and_formula_punctuation_are_not_normalization_rules():
    for quote, body in [("Original Result x=12.5 is measured here.", "original Result x=12.5 is measured here."),
                        ("The reported numerical value is 12.5 units.", "The reported numerical value is 13.5 units."),
                        ("The expression uses a+b while preserving the exact result.", "The expression uses a-b while preserving the exact result.")]:
        assert find_unique_anchor(body, quote, allow_fuzzy=False)["status"] == "unmatched"


def test_insertions_and_deletions_do_not_break_span_mapping():
    for current in (QUOTE.replace("synthetic experiment", "synthetic pilot experiment"), QUOTE.replace("a stable", "stable")):
        got = find_unique_anchor(current, QUOTE)
        assert got["status"] == "matched" and got["method"] == "fuzzy"
        assert current[got["start"]:got["end"]] == current


def test_complete_scan_budget_is_required_to_call_a_match_unique():
    assert find_unique_anchor("x" * 1_000_001, QUOTE)["status"] == "budget"
    assert find_unique_anchor(QUOTE, "x" * 20_001)["status"] == "budget"
    # A frequent seed must not silently drop the rest of the full text search.
    text = "The synthetic experiment " * 1000 + QUOTE.replace("stable", "steady")
    assert find_unique_anchor(text, QUOTE)["status"] == "budget"


def test_repeated_or_large_fuzzy_queries_are_bounded_and_results_deterministic():
    repeated = "abcdefghi " * 500
    assert find_unique_anchor(repeated.replace("a", "z"), repeated)["status"] == "budget"
    result = find_unique_anchor(QUOTE.replace("stable", "steady"), QUOTE)
    assert result == find_unique_anchor(QUOTE.replace("stable", "steady"), QUOTE)


def test_hangul_canonical_composition_preserves_original_offsets():
    text = "prefix \u1100\u1161\u11a8 additional synthetic measurement suffix"
    got = find_unique_anchor(text, "각 additional synthetic measurement")
    assert got["status"] == "matched"
    assert text[got["start"]:got["end"]].startswith("\u1100\u1161\u11a8")


def test_two_high_similarity_passages_with_edits_at_different_offsets_never_become_unique():
    for first, second in ((3, 37), (18, 73), (44, 81), (7, 95)):
        one = QUOTE[:first] + "Z" + QUOTE[first + 1:]
        two = QUOTE[:second] + "Q" + QUOTE[second + 1:]
        got = find_unique_anchor("prefix\n" + one + "\nseparator\n" + two + "\nsuffix", QUOTE)
        assert got["status"] in {"ambiguous", "budget"}


def test_fuzzy_matching_is_textual_and_does_not_add_domain_or_number_presets():
    quote = QUOTE + " Its measured coefficient is 10 units in this synthetic example."
    got = find_unique_anchor(quote.replace("10 units", "11 units"), quote)
    assert got["status"] == "matched" and got["method"] == "fuzzy"


def test_changed_edges_cannot_be_cropped_to_inflate_the_original_quote_coverage():
    quote = "Completelydistinct " + QUOTE
    changed = "Unexpectedlynew " + QUOTE
    got = find_unique_anchor(changed, quote)
    assert got["status"] != "matched"


def test_unicode_normalization_work_is_bounded_before_building_offset_tables():
    got = find_unique_anchor("a" + "\u0301" * 1000, QUOTE)
    assert got["status"] == "budget" and got["reason"] == "unicode_cluster_budget"
