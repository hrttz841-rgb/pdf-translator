"""注释配对与原书信息提取的测试。"""

import io
import re
import zipfile

import notes
import server


def B(t, text, page=None, **kw):
    return dict(type=t, text=text, page=page, **kw)


def test_page_footnotes_pair_by_page_and_number_with_continuation():
    blocks = [
        B("chapter", "第一章", 3),
        B("body", "权力是一种能力。[^1] 这一定义影响深远。[^2]", 3),
        B("footnote", "达尔，《权力的概念》。", 3, note_id="1", origin="page"),
        B(
            "footnote",
            "参见波尔斯比的综述，其中收录了主要立场和",
            3,
            note_id="2",
            origin="page",
        ),
        B("body", "批评者认为这只看到了最显眼的权力。[^3]", 4),
        B("footnote", "批评者在随后十年里的回应。", 4, note_id="+", origin="page"),
        B(
            "footnote",
            "巴卡拉克和巴拉茨，《权力的两张面孔》。",
            4,
            note_id="3",
            origin="page",
        ),
    ]
    out, bank, rep = notes.pair_notes(blocks)
    assert rep["paired"] == 3 and rep["by_method"]["page"] == 3
    assert not rep["unmatched_markers"] and not rep["unmatched_notes"]
    texts = list(bank.values())
    assert "主要立场和批评者在随后十年里的回应。" in texts[1]
    assert all("[^" not in b["text"] for b in out if b["type"] != "footnote")


def test_endnotes_restart_per_chapter_pair_in_order():
    blocks = [
        B("chapter", "第二章", 5),
        B("body", "观念塑造了欲望。[^1] 没有不满本身也可能是支配的迹象。[^2]", 5),
        B("body", "这些说法能否检验仍有争议。[^3]", 5),
        B("chapter", "第三章", 6),
        B("body", "福柯把权力定位在学校、医院和监狱。[^1] 考试教人自我监视。[^2]", 6),
        B("chapter", "注释", 7),
        B("notes_heading", "第二章", 7),
        B("footnote", "Lukes, Power, 23-25.", 7, note_id="1"),
        B("footnote", "Lukes, Power, 24.", 7, note_id="2"),
        B("footnote", "第二版所收论文。", 7, note_id="3"),
        B("notes_heading", "第三章", 7),
        B("footnote", "Foucault, Discipline and Punish.", 7, note_id="1"),
        B("footnote", "Foucault, Discipline and Punish, 184-194.", 7, note_id="2"),
    ]
    out, bank, rep = notes.pair_notes(blocks)
    assert rep["paired"] == 5 and rep["by_method"]["sequence"] == 5
    ch3 = next(b for b in out if "福柯" in b["text"])
    keys = re.findall(r"\[\[FN:([^\]]+)\]\]", ch3["text"])
    assert [bank[k] for k in keys] == [
        "Foucault, Discipline and Punish.",
        "Foucault, Discipline and Punish, 184-194.",
    ]


def test_endnote_groups_without_headings_split_on_number_restart():
    blocks = [
        B("body", "甲[^1]乙[^2]", 1),
        B("body", "丙[^1]", 2),
        B("footnote", "1. 注一", 9),
        B("footnote", "2. 注二", 9),
        B("footnote", "1. 第二组注一", 9),
    ]
    out, bank, rep = notes.pair_notes(blocks)
    assert rep["paired"] == 3
    assert sorted(bank.values()) == ["注一", "注二", "第二组注一"]


def test_continuous_book_wide_numbering():
    blocks = [B("body", f"句子{i}[^{i}]", i) for i in range(1, 8)] + [
        B("footnote", f"注释{i}", 50, note_id=str(i)) for i in range(1, 8)
    ]
    _, bank, rep = notes.pair_notes(blocks)
    assert rep["paired"] == 7 and not rep["unmatched_notes"]


def test_legacy_scope_markers_still_work():
    blocks = [
        B("body", "文字[[FN:ch1:1]]", 1),
        B("footnote", "旧格式注释", 9, note_id="1", note_scope="ch1"),
    ]
    _, bank, rep = notes.pair_notes(blocks)
    assert rep["paired"] == 1 and rep["by_method"]["scope"] == 1


def test_unmatched_marker_becomes_superscript_and_note_is_reported():
    blocks = [
        B("body", "没有注释的注号[^4]", 1),
        B("footnote", "孤立注释", 1, note_id="9", origin="page"),
    ]
    out, bank, rep = notes.pair_notes(blocks)
    assert "⁴" in out[0]["text"] and "[^4]" not in out[0]["text"]
    assert rep["unmatched_notes"][0]["num"] == "9"


def test_source_info_prefers_model_output_and_falls_back_to_filtering():
    assert notes.condense_publication_info(
        [
            B(
                "source_info",
                "Hartley, M. L. The Grammar of Power. Cambridge, MA: Northfield UP, 2019.",
            )
        ]
    ).startswith("Hartley")
    cr = B(
        "copyright",
        "Copyright © 2019 by Northfield University Press\nAll rights reserved\nPrinted in the United States of America\n"
        "10 9 8 7 6 5 4 3 2 1\nISBN 9780674987654\nTypeset in Minion by Westchester",
    )
    info = notes.condense_publication_info([cr])
    assert (
        "2019" in info
        and "ISBN" not in info
        and "Printed" not in info
        and "Typeset" not in info
    )


def _export(blocks, true_footnotes=True):
    data = {
        "mode": "manuscript",
        "file_name": "t.pdf",
        "pages": [],
        "manuscript": {"blocks": blocks},
        "true_footnotes": true_footnotes,
    }
    z = zipfile.ZipFile(io.BytesIO(server.build_manuscript_docx(data)))
    doc = z.read("word/document.xml").decode("utf-8")
    fn = (
        z.read("word/footnotes.xml").decode("utf-8")
        if "word/footnotes.xml" in z.namelist()
        else ""
    )
    return doc, fn


def test_word_export_page_and_end_notes_become_true_footnotes():
    blocks = [
        B("book_title", "权力的语法"),
        B(
            "source_info",
            "Hartley, M. L. The Grammar of Power. Cambridge, MA: Northfield University Press, 2019.",
        ),
        B("copyright", "All rights reserved. ISBN 9780674987654"),
        B("chapter", "第一章", 3),
        B("body", "权力是一种能力。[^1]", 3),
        B("footnote", "Dahl, The Concept of Power.", 3, note_id="1", origin="page"),
        B("chapter", "第二章", 5),
        B("body", "观念塑造欲望。[^1]", 5),
        B("chapter", "注释", 7),
        B("notes_heading", "第二章", 7),
        B("footnote", "Lukes, Power, 23.", 7, note_id="1"),
    ]
    doc, fn = _export(blocks)
    assert doc.count("w:footnoteReference") == 2
    assert "Dahl, The Concept of Power." in fn and "Lukes, Power, 23." in fn
    assert "原书信息" in doc and "Northfield University Press, 2019" in doc
    assert "ISBN" not in doc and "All rights reserved" not in doc
    assert ">注释<" not in doc  # 注释全部转为页下注后，空的“注释”章标题被删去
    assert "[^" not in doc and "[[FN" not in doc


def test_word_export_without_true_footnotes_keeps_notes_as_endnotes():
    blocks = [
        B("chapter", "第一章", 1),
        B("body", "文字[^1]", 1),
        B("footnote", "注释内容", 1, note_id="1", origin="page"),
    ]
    doc, fn = _export(blocks, true_footnotes=False)
    assert "¹" in doc and "注释内容" in doc and "w:footnoteReference" not in doc


def test_manuscript_report_endpoint_matches_export(srv):
    from tests.test_server import request
    import json

    blocks = [
        B("body", "文字[^1]", 1),
        B("footnote", "注释", 1, note_id="1", origin="page"),
        B("source_info", "A. B. C: D, 2000."),
    ]
    r, data = request(
        srv, "POST", "/api/manuscript-report", {"manuscript": {"blocks": blocks}}
    )
    rep = json.loads(data)
    assert (
        r.status == 200
        and rep["paired"] == 1
        and rep["source_info"] == "A. B. C: D, 2000."
    )


def test_footnote_numbering_options():
    blocks = [
        B("chapter", "第一章", 1),
        B("body", "文字[^1]", 1),
        B("footnote", "注", 1, note_id="1", origin="page"),
    ]
    for opt, fmt, restart in [
        ("page", "decimalEnclosedCircleChinese", "eachPage"),
        ("continuous", "decimal", "continuous"),
        ("chapter", "decimal", "eachSect"),
    ]:
        data = {
            "mode": "manuscript",
            "pages": [],
            "manuscript": {"blocks": blocks},
            "footnote_numbering": opt,
        }
        doc = (
            zipfile.ZipFile(io.BytesIO(server.build_manuscript_docx(data)))
            .read("word/document.xml")
            .decode()
        )
        assert (
            f'w:numFmt w:val="{fmt}"' in doc
            and f'w:numRestart w:val="{restart}"' in doc
        )
