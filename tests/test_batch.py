"""对话式批量处理的文件夹读取与译文写出。"""

import json

import pytest

import batch_io
from tests.test_server import PAGES, request


@pytest.fixture()
def folder(tmp_path):
    root = tmp_path / "文献 资料"
    (root / "第二批").mkdir(parents=True)
    (root / "a.pdf").write_bytes(b"%PDF-1.4 a")
    (root / "b.docx").write_bytes(b"PK docx")
    (root / "第二批" / "c.pdf").write_bytes(b"%PDF-1.4 c")
    (root / "notes.txt").write_text("skip")
    (root / ".hidden.pdf").write_bytes(b"x")
    (root / "~$b.docx").write_bytes(b"x")
    (root / "旧书_中文书稿版.docx").write_bytes(b"x")
    (root / "译文").mkdir()
    (root / "译文" / "a_中文书稿版.docx").write_bytes(b"done")
    # macOS 的临时目录经由符号链接（/var → /private/var），服务端返回的是解析后的路径
    return root.resolve()


@pytest.fixture()
def out_root(tmp_path, monkeypatch):
    d = tmp_path / "out"
    monkeypatch.setenv("PDF_TRANSLATOR_OUTPUT", str(d))
    return d


def post(srv, path, body):
    r, data = request(srv, "POST", path, body)
    return r, data


def test_list_folder_finds_supported_files_and_skips_outputs(srv, folder):
    r, data = post(srv, "/api/folder/list", {"path": str(folder)})
    assert r.status == 200, data
    obj = json.loads(data)
    rels = [f["rel"] for f in obj["files"]]
    assert rels == ["a.pdf", "b.docx", "第二批/c.pdf"]
    assert obj["skipped"] == 2  # notes.txt 与本工具生成的书稿
    done = {f["rel"]: f["done"] for f in obj["files"]}
    assert done == {"a.pdf": True, "b.docx": False, "第二批/c.pdf": False}
    assert obj["out_dir"] == str(folder / "译文")


@pytest.mark.parametrize("fmt", ["'{p}'", '"{p}"', "{uri}", "{p}/"])
def test_list_folder_accepts_quoted_and_url_paths(srv, folder, fmt):
    text = fmt.format(p=str(folder), uri=folder.as_uri())
    r, data = post(srv, "/api/folder/list", {"path": text})
    assert r.status == 200, data
    assert len(json.loads(data)["files"]) == 3


@pytest.mark.skipif(
    batch_io.os.sep != "/", reason="Windows 路径以反斜杠分隔"
)
def test_list_folder_escaped_spaces(srv, folder):
    r, data = post(srv, "/api/folder/list", {"path": str(folder).replace(" ", "\\ ")})
    assert r.status == 200, data


def test_list_single_file(srv, folder):
    r, data = post(srv, "/api/folder/list", {"path": str(folder / "b.docx")})
    obj = json.loads(data)
    assert [f["rel"] for f in obj["files"]] == ["b.docx"]


@pytest.mark.parametrize("path", ["", "relative/dir", "/no/such/dir/xyz"])
def test_list_folder_errors(srv, path):
    r, data = post(srv, "/api/folder/list", {"path": path})
    assert r.status == 500
    assert json.loads(data)["error"]


def test_read_file_only_inside_listed_folder(srv, folder):
    obj = json.loads(post(srv, "/api/folder/list", {"path": str(folder)})[1])
    fid = obj["folder_id"]
    r, data = post(srv, "/api/folder/read", {"folder_id": fid, "rel": "第二批/c.pdf"})
    assert r.status == 200 and data == b"%PDF-1.4 c"
    for rel in ["../out.pdf", "notes.txt", "/etc/passwd", "第二批/../../x.pdf"]:
        r, _ = post(srv, "/api/folder/read", {"folder_id": fid, "rel": rel})
        assert r.status == 500, rel
    r, _ = post(srv, "/api/folder/read", {"folder_id": "bogus", "rel": "a.pdf"})
    assert r.status == 500


def test_folder_endpoints_require_token(srv, folder):
    for path in ["/api/folder/list", "/api/folder/read", "/api/output/export"]:
        r, _ = request(srv, "POST", path, {"path": str(folder)}, token=False)
        assert r.status == 403


def test_export_writes_manuscript_bilingual_and_project(srv, folder):
    obj = json.loads(post(srv, "/api/folder/list", {"path": str(folder)})[1])
    manuscript = {
        "file_name": "c.pdf",
        "title": "c",
        "pages": PAGES,
        "manuscript": {
            "blocks": [
                {"type": "chapter", "text": "第一章", "level": 1},
                {"type": "body", "text": "国家由来已久。"},
            ]
        },
    }
    r, data = post(
        srv,
        "/api/output/export",
        {
            "out_id": obj["out_id"],
            "rel": "第二批/c.pdf",
            "manuscript": manuscript,
            "bilingual": {"file_name": "c.pdf", "pages": PAGES},
            "project": {"version": 5, "pages": PAGES},
        },
    )
    assert r.status == 200, data
    res = json.loads(data)
    out = folder / "译文" / "第二批"
    assert (out / "c_中文书稿版.docx").read_bytes()[:2] == b"PK"
    assert (out / "c_原文译文对照版.docx").read_bytes()[:2] == b"PK"
    proj = json.loads((out / "c.translation-project.json").read_text("utf-8"))
    assert proj["pages"][0]["target"].startswith("第一章")
    assert len(res["written"]) == 3
    assert not list(out.glob("*.part"))
    # 再次列出时这个文件显示为已完成
    obj = json.loads(post(srv, "/api/folder/list", {"path": str(folder)})[1])
    assert {f["rel"]: f["done"] for f in obj["files"]}["第二批/c.pdf"]


def test_export_rejects_escape_and_unknown_output(srv, folder):
    obj = json.loads(post(srv, "/api/folder/list", {"path": str(folder)})[1])
    body = {"out_id": obj["out_id"], "rel": "../../evil.pdf", "project": {"x": 1}}
    r, _ = post(srv, "/api/output/export", body)
    assert r.status == 500
    r, _ = post(
        srv, "/api/output/export", {"out_id": "nope", "rel": "a.pdf", "project": {}}
    )
    assert r.status == 500
    assert not (folder.parent / "evil.translation-project.json").exists()


def test_prepare_default_output_for_dropped_folder(srv, out_root):
    r, data = post(
        srv,
        "/api/output/prepare",
        {"name": "anarchism/../x", "rels": ["sub/a.pdf", "b.pdf"]},
    )
    assert r.status == 200, data
    obj = json.loads(data)
    assert obj["out_dir"].startswith(str(out_root))
    assert batch_io.Path(obj["out_dir"]).parent == out_root
    assert obj["done"] == []
    r, data = post(
        srv,
        "/api/output/export",
        {"out_id": obj["out_id"], "rel": "sub/a.pdf", "project": {"pages": []}},
    )
    assert r.status == 200, data
    r, data = post(
        srv,
        "/api/output/status",
        {
            "out_id": obj["out_id"],
            "rels": ["sub/a.pdf", "b.pdf"],
            "outputs": {"manuscript": False, "bilingual": False},
        },
    )
    assert json.loads(data)["done"] == []


def test_done_requires_every_enabled_output(tmp_path):
    out = tmp_path / "o"
    oid = batch_io._register_output(out)
    p = batch_io.output_paths(out, "x.pdf")
    p["manuscript"].parent.mkdir(parents=True)
    p["manuscript"].write_bytes(b"x")
    assert batch_io.done_rels(oid, ["x.pdf"]) == ["x.pdf"]
    assert batch_io.done_rels(oid, ["x.pdf"], {"manuscript": True, "bilingual": True}) == []


def test_open_output_uses_file_manager(srv, folder, monkeypatch):
    calls = []
    monkeypatch.setattr(batch_io.subprocess, "Popen", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(batch_io.platform, "system", lambda: "Darwin")
    obj = json.loads(post(srv, "/api/folder/list", {"path": str(folder)})[1])
    r, data = post(srv, "/api/output/open", {"out_id": obj["out_id"]})
    assert r.status == 200, data
    assert calls == [["open", str(folder / "译文")]]
    r, data = post(
        srv,
        "/api/output/open",
        {"out_id": obj["out_id"], "rel": "a.pdf", "kind": "manuscript"},
    )
    assert calls[-1] == ["open", "-R", str(folder / "译文" / "a_中文书稿版.docx")]


def test_project_json_input_stem():
    assert batch_io.file_stem("书.translation-project.json") == "书"
    assert batch_io.is_supported("书.translation-project.json")
    assert not batch_io.is_supported("data.json")
    assert not batch_io.is_supported("x_原文译文对照版.docx")
