"""轻量公式候选规则：复用文本层，不加载图像或识别模型。"""
import re

from .paper_references import HEADING, END_HEADING

NUMBER = re.compile(r'\((?:[A-Z]\.?)?\d+(?:\.\d+)*\)\s*$')
MATH = re.compile(r'[=∑∏∫√≈≠≤≥∈∂∇⊂⊆→^]|[α-ωΑ-Ω]')
URL = re.compile(r'https?\s*:\s*/|www\.|doi\s*:|10\.\d{4,9}/|\.(?:html?|pdf)(?:[?#\s]|$)|available\s+from|[?&][\w-]+\s*=', re.I)
CITATION = re.compile(r'^\s*(?:\[\d+\]\s*)?[A-Z][\w\-]+,\s*[A-Z]\..*\b(?:19|20)\d{2}\b')


def reference_mask(lines, width, state=False):
    """继承上一页区段；None 表示前文未扫描，暂缓公式而不是误判。

    普通双栏先左后右，避免右栏 References 抹掉左栏下方公式。
    状态只随独立标题改变，附录恢复；不根据正文 mentioning references 改变。
    """
    left = [i for i, row in enumerate(lines) if row['rect'].x1 < width * .53]
    right = [i for i, row in enumerate(lines) if row['rect'].x0 > width * .48]
    columns = len(left) >= 2 and len(right) >= 2
    order = sorted(range(len(lines)), key=lambda i: (
        int(columns and lines[i]['rect'].x0 > width * .48), lines[i]['rect'].y0, lines[i]['rect'].x0))
    excluded = set()
    for index in order:
        text = lines[index]['text'].strip().rstrip(':：')
        if HEADING.fullmatch(text):
            state = True
        elif END_HEADING.match(text):
            state = False
        if state is not False:
            excluded.add(index)
    return excluded, state


def non_formula(text):
    return bool(URL.search(text) or CITATION.search(text))


def is_formula(text, math_font=False):
    if len(text) >= 350 or non_formula(text):
        return False
    # 较长自然语言句子即使含 x=1 也不是独立展示公式。
    if len(re.findall(r'\b[A-Za-z]{3,}\b', text)) > 7:
        return False
    numbered = bool(NUMBER.search(text))
    signal = bool(MATH.search(text))
    # 某些旧 PDF 字体把等号映射为 ¼，仅在数学字体下作为候选，原文不伪修复。
    if math_font and '¼' in text:
        signal = True
    return signal and (numbered or math_font or (len(text) < 100 and '=' in text))
