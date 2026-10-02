"""图片与表格导出的测试。"""

import base64
import io
import struct
import zipfile
import zlib

import docx_export
import server


def _png(w=40, h=20):
    raw = b"".join(b"\x00" + b"\x80\x80\x80" * w for _ in range(h))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(data).decode()


ASSETS = {
    "FIG:2-1": {"kind": "figure", "image": _png(), "w": 300, "h": 150},
    "TABLE:3-1": {"kind": "table", "image": _png(), "w": 420, "h": 100},
}
ROWS = [
    ["议题领域", "决策数", "占比（%）"],
    ["城市更新", "24", "41.7"],
    ["公共教育", "18", "33.3"],
]


def _doc(data):
    z = zipfile.ZipFile(io.BytesIO(server.build_manuscript_docx(data)))
    return z.read("word/document.xml").decode(), z.namelist()


def test_parse_table_text():
    text = "[[TABLE:3-1]]\n| a | b |\n|  | 2 |\n[[/TABLE]]"
    assert docx_export.parse_table_text(text) == [["a", "b"], ["", "2"]]
    assert docx_export._asset_ref(text) == ("TABLE", "3-1")
    assert docx_export._asset_ref("[[FIG:2-1]]") == ("FIG", "2-1")
    assert docx_export._asset_ref("正文") is None


def test_manuscript_figure_and_three_line_table():
    blocks = [
        {"type": "chapter", "text": "第一章", "page": 1},
        {"type": "body", "text": "正文。", "page": 1},
        {"type": "figure", "text": "[[FIG:2-1]]", "page": 2, "asset_id": "FIG:2-1"},
        {"type": "figure_caption", "text": "图 1.2 各方赢得的决策", "page": 2},
        {"type": "table_caption", "text": "表 1.1 议题领域", "page": 3},
        {
            "type": "table",
            "text": "[[TABLE:3-1]]",
            "page": 3,
            "asset_id": "TABLE:3-1",
            "rows": ROWS,
        },
    ]
    doc, names = _doc(
        {
            "mode": "manuscript",
            "pages": [],
            "manuscript": {"blocks": blocks},
            "assets": ASSETS,
        }
    )
    assert doc.count("<w:drawing>") == 1 and any(
        n.startswith("word/media/") for n in names
    )
    assert "<w:tbl>" in doc and "城市更新" in doc and "41.7" in doc
    tbl = doc[doc.index("<w:tbl>") : doc.index("</w:tbl>")]
    assert '<w:top w:val="single" w:sz="12"' in tbl
    assert '<w:insideV w:val="nil"/>' in tbl and "<w:tblHeader" in tbl
    assert "[[" not in doc


def test_table_without_rows_falls_back_to_image():
    blocks = [
        {"type": "chapter", "text": "第一章", "page": 1},
        {"type": "table", "text": "[[TABLE:3-1]]", "page": 3, "asset_id": "TABLE:3-1"},
    ]
    doc, _ = _doc(
        {
            "mode": "manuscript",
            "pages": [],
            "manuscript": {"blocks": blocks},
            "assets": ASSETS,
        }
    )
    assert "<w:drawing>" in doc and "<w:tbl>" not in doc


def test_bilingual_export_renders_figures_and_tables():
    table = "[[TABLE:3-1]]\n| Issue | N |\n| Taxation | 11 |\n[[/TABLE]]"
    table_zh = "[[TABLE:3-1]]\n| 议题 | N |\n| 税收 | 11 |\n[[/TABLE]]"
    pages = [
        {
            "n": 1,
            "source": f"Text.\n\n[[FIG:2-1]]\n\n{table}",
            "target": f"正文。\n\n[[FIG:2-1]]\n\n{table_zh}",
        }
    ]
    out = docx_export.build_translation_docx(
        {"pages": pages, "assets": ASSETS}, bilingual=True
    )
    doc = zipfile.ZipFile(io.BytesIO(out)).read("word/document.xml").decode()
    assert doc.count("<w:drawing>") == 2
    assert "税收" in doc and "Taxation" in doc and "[[" not in doc


def test_fallback_without_manuscript_keeps_tables():
    pages = [
        {
            "n": 1,
            "source": "",
            "target": "第一段。\n\n[[TABLE:1-1]]\n| 甲 | 乙 |\n| 1 | 2 |\n[[/TABLE]]\n\n第二段。",
        }
    ]
    doc, _ = _doc({"mode": "manuscript", "pages": pages, "manuscript": None})
    assert "<w:tbl>" in doc and "甲" in doc and "[[" not in doc


def test_word_import_keeps_tables_in_order():
    from docx import Document

    d = Document()
    d.add_paragraph("表格前的段落。")
    tb = d.add_table(rows=2, cols=3)
    for i, row in enumerate([["甲", "乙", "丙"], ["1", "2", "3"]]):
        for j, v in enumerate(row):
            tb.cell(i, j).text = v
    d.add_paragraph("表格后的段落。")
    buf = io.BytesIO()
    d.save(buf)
    res = docx_export.import_docx_bytes(buf.getvalue())
    text = res["pages"][0]["target"]
    assert text.index("表格前") < text.index("[[TABLE:W1]]") < text.index("表格后")
    assert "| 甲 | 乙 | 丙 |" in text and "| 1 | 2 | 3 |" in text
