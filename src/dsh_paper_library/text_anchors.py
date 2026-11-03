"""有界、只读的文字锚点匹配；不推断文件、章节或学科含义。"""

from array import array
from dataclasses import dataclass
from difflib import SequenceMatcher
import math
import re
import unicodedata


MAX_TEXT = 1_000_000
MAX_QUOTE = 20_000
MAX_FUZZY_QUOTE = 2_048
MAX_CANDIDATES = 256
MAX_COMPARISON_WORK = 12_000_000
MIN_EXACT_CONTENT = 16
MIN_FUZZY_CONTENT = 48
FUZZY_SCORE = 0.96
COMPETITOR_SCORE = 0.90
MIN_MARGIN = 0.05


@dataclass(frozen=True)
class AnchorText:
    """一次准备可复用于同一文件／完整 PDF 文字中的多条批注。"""

    text: str
    normalized: str
    starts: array
    ends: array
    error: str | None = None


def prepare_anchor_text(text):
    """NFC 和空白折叠保留原始字符范围；不折叠大小写、数字或标点。"""
    if not isinstance(text, str):
        return AnchorText("", "", array("I"), array("I"), "invalid_text")
    if len(text) > MAX_TEXT:
        return AnchorText("", "", array("I"), array("I"), "text_budget")
    output, starts, ends = [], array("I"), array("I")
    cluster, first = [], 0

    def emit(end):
        for char in unicodedata.normalize("NFC", "".join(cluster)):
            if char.isspace():
                if output and output[-1] == " ":
                    ends[-1] = end
                    continue
                char = " "
            output.append(char)
            starts.append(first)
            ends.append(end)

    for index, char in enumerate(text):
        if not cluster:
            cluster, first = [char], index
        elif unicodedata.combining(char):
            cluster.append(char)
            if len(cluster) > 64:
                return AnchorText("", "", array("I"), array("I"), "unicode_cluster_budget")
        else:
            # NFC also composes Hangul Jamo and a few spacing combining signs.
            raw = "".join(cluster)
            if len(cluster) < 4 and unicodedata.normalize("NFC", raw + char) != unicodedata.normalize("NFC", raw) + unicodedata.normalize("NFC", char):
                cluster.append(char)
            else:
                emit(index)
                cluster, first = [char], index
    if cluster:
        emit(len(text))
    normalized = "".join(output)
    # An unfamiliar canonical composition must not produce a misleading map.
    expected = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text))
    if normalized != expected:
        return AnchorText("", "", array("I"), array("I"), "unsupported_unicode_mapping")
    return AnchorText(text, normalized, starts, ends)


def _result(status, reason, **extra):
    return {"status": status, "reason": reason, **extra}


def _occurrences(haystack, needle, limit):
    hits, cursor = [], 0
    while True:
        found = haystack.find(needle, cursor)
        if found < 0:
            return hits, False
        hits.append(found)
        if len(hits) >= limit:
            return hits, True
        cursor = found + 1


def _span(prepared, start, end):
    return prepared.starts[start], prepared.ends[end - 1]


def _same_passage(a, b):
    overlap = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    return overlap >= 0.7 * min(a[1] - a[0], b[1] - b[0])


def find_unique_anchor(text, quote, *, allow_fuzzy=True):
    """返回 matched/ambiguous/unmatched/unsupported/budget 与原文偏移。

    模糊路径只接受长且信息足够的选文；候选、比较或文本预算不足时
    拒绝自动定位，不把已检查的局部范围当作整个文件中的唯一位置。
    """
    if not isinstance(quote, str):
        return _result("unsupported", "invalid_quote")
    if len(quote) > MAX_QUOTE:
        return _result("budget", "quote_budget")
    query = re.sub(r"\s+", " ", unicodedata.normalize("NFC", quote)).strip()
    content = sum(char.isalnum() for char in query)
    if content < MIN_EXACT_CONTENT:
        return _result("unsupported", "short_or_empty_quote")
    prepared = text if isinstance(text, AnchorText) else prepare_anchor_text(text)
    if prepared.error:
        return _result("budget" if prepared.error.endswith("budget") else "unsupported", prepared.error)
    body = prepared.normalized
    hits, stopped = _occurrences(body, query, 2)
    if stopped:
        return _result("ambiguous", "multiple_normalized_matches", candidates=2)
    if hits:
        start, end = _span(prepared, hits[0], hits[0] + len(query))
        method = "exact" if prepared.text[start:end] == quote else "normalized"
        return _result("matched", "unique_match", start=start, end=end, method=method, score=1.0, candidates=1)
    if not allow_fuzzy:
        return _result("unmatched", "no_exact_match")
    if content < MIN_FUZZY_CONTENT:
        return _result("unsupported", "quote_too_short_for_fuzzy")
    if len(query) > MAX_FUZZY_QUOTE:
        return _result("budget", "fuzzy_quote_budget")
    if len(set(query)) < 8 or max(query.count(char) for char in set(query)) > len(query) * 0.35:
        return _result("unsupported", "repetitive_quote")

    # Partitioning into >15% disjoint seeds makes even a 90%-similar competing
    # passage (with <=8% length drift) retain a complete seed. All seed hits are
    # searched; an overflow rejects the whole result rather than dropping rivals.
    size, seeds = len(query), math.ceil(len(query) * 0.15) + 1
    drift = max(4, math.ceil(size * 0.08))
    starts = set()
    for part in range(seeds):
        begin, end = part * size // seeds, (part + 1) * size // seeds
        seed = query[begin:end]
        positions, overflow = _occurrences(body, seed, MAX_CANDIDATES + 1)
        if overflow:
            return _result("budget", "candidate_budget")
        for position in positions:
            starts.add(max(0, position - begin))
            if len(starts) > MAX_CANDIDATES:
                return _result("budget", "candidate_budget")
    if not starts:
        return _result("unmatched", "no_candidates")
    ranked, work = [], 0
    for guessed in sorted(starts):
        left, right = max(0, guessed - drift), min(len(body), guessed + size + drift)
        window = body[left:right]
        work += 2 * size * len(window)
        if work > MAX_COMPARISON_WORK:
            return _result("budget", "comparison_budget")
        blocks = SequenceMatcher(None, query, window, autojunk=False).get_matching_blocks()
        meaningful = [block for block in blocks if block.size]
        if not meaningful:
            continue
        start = left + meaningful[0].b
        end = left + meaningful[-1].b + meaningful[-1].size
        length = end - start
        if not math.floor(size * 0.92) <= length <= math.ceil(size * 1.08):
            continue
        candidate = body[start:end]
        matcher = SequenceMatcher(None, query, candidate, autojunk=False)
        # Cropping a changed edge must not inflate similarity by silently
        # ignoring too much of the original quotation.
        coverage = sum(block.size for block in matcher.get_matching_blocks()) / size
        score = min(matcher.ratio(), coverage)
        if score >= COMPETITOR_SCORE:
            ranked.append((start, end, score))
    ranked.sort(key=lambda item: (-item[2], item[0], item[1]))
    distinct = []
    for candidate in ranked:
        if not any(_same_passage(candidate, accepted) for accepted in distinct):
            distinct.append(candidate)
    if not distinct or distinct[0][2] < FUZZY_SCORE:
        return _result("unmatched", "low_similarity", score=round(distinct[0][2], 6) if distinct else 0.0)
    best = distinct[0]
    if len(distinct) > 1 and (distinct[1][2] >= COMPETITOR_SCORE or best[2] - distinct[1][2] < MIN_MARGIN):
        return _result("ambiguous", "competing_similar_passage", candidates=len(distinct), score=round(best[2], 6))
    start, end = _span(prepared, best[0], best[1])
    return _result("matched", "unique_high_similarity", start=start, end=end, method="fuzzy", score=round(best[2], 6), candidates=1)
