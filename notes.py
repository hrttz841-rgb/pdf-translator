"""注释配对：把正文中的注号与注释条目一一对应，供 Word 页下注导出与书稿预览使用。

支持三种来源：
1. 页下注：解析 PDF 时从页面底部提取，条目带页码，按“同页同编号”配对；
2. 章末注、书末注：集中出现在章末或书末的编号列表，按编号重新开始的位置切分成若干组，
   与正文中同样切分的注号组依次对应；
3. 兼容旧格式 [[FN:作用域:编号]]：模型给出的作用域一致时直接配对。
"""

import re

MARKER_RE = re.compile(r"\[\^(\d{1,4}|[*†‡§])\]|\[\[FN:([^:\]\n]+):([^\]\n]+)\]\]")
NOTE_NUM_RE = re.compile(
    r"^\s*(?:\[\^)?(\d{1,4})(?:\])?\s*[.．、)）:：]?\s+(.*)$", re.S
)
SUPERSCRIPT = str.maketrans("0123456789*", "⁰¹²³⁴⁵⁶⁷⁸⁹*")
HEADING_TYPES = {
    "part",
    "chapter",
    "preface_title",
    "appendix",
    "section",
    "subsection",
    "notes_heading",
}


def _num(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _scope_key(scope, nid):
    scope = re.sub(r"\s+", "-", str(scope or "").strip().lower())
    nid = str(nid or "").strip()
    return f"{scope}:{nid}" if scope and nid else ""


def normalize_notes(blocks):
    """整理注释条目：补出缺失的编号，把续行（编号为 +）并入前一条页下注。"""
    out = []
    for b in blocks:
        b = dict(b)
        if b.get("type") == "footnote":
            nid = str(b.get("note_id") or "").strip()
            text = (b.get("text") or "").strip()
            if nid == "+":
                prev = next(
                    (x for x in reversed(out) if x.get("type") == "footnote"), None
                )
                if prev is not None:
                    a, b2 = prev["text"].rstrip(), text.lstrip()
                    # 中文之间直接相连，西文之间补一个空格
                    sep = (
                        ""
                        if re.search(r"[\u3000-\u9fff\uff00-\uffef]$", a)
                        or re.match(r"[\u3000-\u9fff\uff00-\uffef]", b2)
                        else " "
                    )
                    prev["text"] = (a + sep + b2).strip()
                    continue
                nid = ""
            if not nid:
                m = NOTE_NUM_RE.match(text)
                if m:
                    nid, text = m.group(1), m.group(2).strip()
            b["note_id"], b["text"] = nid, text
        out.append(b)
    return out


def _runs(items, key=lambda x: x["num"], breaks=None):
    """按编号重新开始（不再递增）或分组标题切分成若干组。"""
    runs, cur, last = [], [], None
    for it in items:
        n = key(it)
        if cur and (
            (breaks and breaks(it))
            or (n is not None and last is not None and n <= last)
        ):
            runs.append(cur)
            cur = []
        cur.append(it)
        if n is not None:
            last = n
    if cur:
        runs.append(cur)
    return runs


def pair_notes(blocks):
    """返回 (改写后的 blocks, note_bank, report)。

    改写后正文中已配对的注号变为 [[FN:k序号:编号]]，note_bank 以同样的键保存注释文字；
    未配对的注号改为上标数字保留在正文中，未配对的注释列在 report["unmatched_notes"]。
    """
    blocks = normalize_notes(blocks)
    notes = []
    for i, b in enumerate(blocks):
        if b.get("type") == "footnote":
            notes.append(
                {
                    "bi": i,
                    "num": _num(b.get("note_id")),
                    "id": str(b.get("note_id") or ""),
                    "page": _num(b.get("page")),
                    "origin": b.get("origin") or "",
                    "key": _scope_key(b.get("note_scope"), b.get("note_id")),
                    "text": b.get("text", ""),
                    "used": False,
                    "group_break": False,
                }
            )
    # 章末注或书末注列表中的小标题（如“第二章”）作为分组边界
    last_heading_bi = -1
    for n in notes:
        for j in range(n["bi"] - 1, last_heading_bi, -1):
            if blocks[j].get("type") in (
                "notes_heading",
                "chapter",
                "part",
                "appendix",
            ):
                n["group_break"] = True
                last_heading_bi = j
                break
            if blocks[j].get("type") == "footnote":
                break

    markers = []
    for i, b in enumerate(blocks):
        if b.get("type") == "footnote":
            continue
        for m in MARKER_RE.finditer(b.get("text", "")):
            if m.group(1):
                num, sym = _num(m.group(1)), m.group(1)
                key = ""
            else:
                num, sym = _num(m.group(3)), m.group(3)
                key = _scope_key(m.group(2), m.group(3))
            markers.append(
                {
                    "bi": i,
                    "span": m.span(),
                    "num": num,
                    "sym": sym,
                    "key": key,
                    "page": _num(b.get("page")),
                    "note": None,
                    "how": "",
                }
            )

    def link(mk, nt, how):
        mk["note"], mk["how"], nt["used"] = nt, how, True

    # 1. 旧格式：作用域与编号一致
    by_key = {}
    for n in notes:
        if n["key"]:
            by_key.setdefault(n["key"], []).append(n)
    for mk in markers:
        if mk["key"] and by_key.get(mk["key"]):
            cand = next((n for n in by_key[mk["key"]] if not n["used"]), None)
            if cand:
                link(mk, cand, "scope")

    # 2. 页下注：同页同编号，其次是前一页（注号在页末、注释排到下一页的情况）
    for n in notes:
        if n["used"] or n["origin"] != "page" or n["page"] is None:
            continue
        for dp in (0, -1, 1):
            mk = next(
                (
                    m
                    for m in markers
                    if m["note"] is None
                    and m["page"] == n["page"] + dp
                    and (
                        m["num"] == n["num"]
                        if n["num"] is not None
                        else m["sym"] == n["id"]
                    )
                ),
                None,
            )
            if mk:
                link(mk, n, "page")
                break

    # 3. 章末注、书末注：编号重新开始处切分，按顺序逐组对应
    rest_m = [m for m in markers if m["note"] is None and m["num"] is not None]
    rest_n = [n for n in notes if not n["used"] and n["num"] is not None]
    m_runs = _runs(rest_m)
    n_runs = _runs(rest_n, breaks=lambda n: n["group_break"])
    j = 0
    for run in m_runs:
        nums = {m["num"] for m in run}
        best, best_score = None, 0
        for k in range(j, min(len(n_runs), j + 3)):
            have = {n["num"] for n in n_runs[k] if not n["used"]}
            score = len(nums & have) / max(1, len(nums | have))
            if score > best_score + 1e-9:
                best, best_score = k, score
        if best is None or best_score < 0.34:
            continue
        pool = {}
        for n in n_runs[best]:
            if not n["used"]:
                pool.setdefault(n["num"], []).append(n)
        for m in run:
            if pool.get(m["num"]):
                link(m, pool[m["num"]].pop(0), "sequence")
        j = best + 1

    # 改写正文
    note_bank, key_of = {}, {}
    for idx, mk in enumerate(markers):
        if mk["note"] is not None:
            key = f"k{idx}:{mk['sym']}"
            key_of[id(mk)] = key
            note_bank[key] = mk["note"]["text"]
    by_block = {}
    for mk in markers:
        by_block.setdefault(mk["bi"], []).append(mk)
    out = []
    for i, b in enumerate(blocks):
        if i in by_block:
            text = b["text"]
            for mk in sorted(by_block[i], key=lambda m: m["span"][0], reverse=True):
                s, e = mk["span"]
                rep = (
                    f"[[FN:{key_of[id(mk)]}]]"
                    if id(mk) in key_of
                    else mk["sym"].translate(SUPERSCRIPT)
                )
                text = text[:s] + rep + text[e:]
            b = dict(b, text=text)
        out.append(b)

    paired = [m for m in markers if m["note"] is not None]
    report = {
        "markers": len(markers),
        "notes": len(notes),
        "paired": len(paired),
        "by_method": {
            h: sum(1 for m in paired if m["how"] == h)
            for h in ("page", "sequence", "scope")
        },
        "unmatched_markers": [
            {"page": m["page"], "num": m["sym"]} for m in markers if m["note"] is None
        ],
        "unmatched_notes": [
            {"page": n["page"], "num": n["id"], "text": n["text"]}
            for n in notes
            if not n["used"]
        ],
    }
    return out, note_bank, report


# ---------- 版权页：只保留引用所需的原书信息 ----------

PUBLICATION_JUNK_RE = re.compile(
    r"all rights reserved|printed in|no part of this|reproduced|retrieval system|without (the )?(prior )?(written )?permission"
    r"|cataloging|cataloguing|library of congress|british library|lccn|\bisbn\b|\bissn\b|\bdoi\b|subjects?:|classification:"
    r"|\bddc\b|\blcc\b|typeset|book design|cover design|cover image|cover photo|printing|first published in paperback"
    r"|^\s*(\d+\s+){4,}\d+\s*$|acid-free|alk\. paper|paper used in this|permanence of paper|ansi|www\.|https?://"
    r"|版权所有|侵权必究|印刷|印次|印张|开本|字数|定价|书号|图书在版编目|cip|责任编辑|封面设计|装帧|版式设计|发行|经销",
    re.I,
)


def condense_publication_info(blocks):
    """返回引用所需的原书信息（一段文字），并去掉其余版权页内容。

    优先使用模型给出的 source_info；没有时从 copyright 块里挑出含年份、出版社或作者信息的行。
    """
    info = [
        b["text"].strip()
        for b in blocks
        if b.get("type") == "source_info" and b.get("text", "").strip()
    ]
    if info:
        return info[0]
    keep = []
    for b in blocks:
        if b.get("type") != "copyright":
            continue
        for line in re.split(r"\s*\n\s*|(?<=[.。])\s+(?=[A-Z©])", b.get("text", "")):
            line = line.strip()
            if not line or PUBLICATION_JUNK_RE.search(line):
                continue
            if re.search(r"(19|20)\d{2}", line) or re.search(
                r"press|publish|出版社|出版", line, re.I
            ):
                keep.append(line)
    return "；".join(dict.fromkeys(keep[:2]))
