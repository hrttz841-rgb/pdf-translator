"""本地服务的安全与导出功能测试。

运行：python -m pytest tests
"""

import base64
import http.client
import io
import json
import re
import threading
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import ai_client
import keystore
import server


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    """在随机端口启动服务；Key 存放在临时目录，AI 请求被拦截记录，不会真正联网。"""
    monkeypatch.setattr(keystore, "KEY_DIR", tmp_path / "keys")
    monkeypatch.setattr(server.platform, "system", lambda: "Linux")
    for info in server.PROVIDERS.values():
        monkeypatch.delenv(info["env"], raising=False)
    calls = []

    def fake_post_json(url, headers, payload, label):
        calls.append({"url": url, "headers": headers, "payload": payload})
        return {"choices": [{"message": {"content": "译文"}}]}

    monkeypatch.setattr(ai_client, "_post_json", fake_post_json)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield {"port": port, "calls": calls, "tmp": tmp_path}
    httpd.shutdown()
    httpd.server_close()


def request(srv, method, path, body=None, headers=None, token=True, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv["port"], timeout=10)
    h = {"Host": host or f"127.0.0.1:{srv['port']}"}
    if token:
        h["X-SPT-Token"] = server.SESSION_TOKEN
    if body is not None:
        body = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    conn.request(method, path, body=body, headers=h)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r, data


def save_key(srv, provider="openai", key="sk-test-1234", base=None):
    r, data = request(
        srv,
        "POST",
        "/api/save-key",
        {"provider": provider, "api_key": key, "api_base": base or ""},
    )
    assert r.status == 200, data
    return json.loads(data)


# ---------- 页面与静态文件 ----------


def test_index_injects_token_and_sends_no_cors(srv):
    r, data = request(srv, "GET", "/", token=False)
    assert r.status == 200
    assert f'content="{server.SESSION_TOKEN}"' in data.decode("utf-8")
    assert r.getheader("Access-Control-Allow-Origin") is None


def test_static_assets_have_correct_mime(srv):
    r, _ = request(srv, "GET", "/app.js", token=False)
    assert r.status == 200 and r.getheader("Content-Type").startswith("text/javascript")
    r, _ = request(srv, "GET", "/styles.css", token=False)
    assert r.status == 200 and r.getheader("Content-Type").startswith("text/css")


def test_head_request_for_vendor_asset(srv):
    r, _ = request(srv, "HEAD", "/vendor/pdfjs/pdf.min.mjs", token=False)
    assert r.status == 200


@pytest.mark.parametrize(
    "path", ["/../server.py", "/%2e%2e/server.py", "/.gitignore", "/pdf-translator.log"]
)
def test_static_does_not_leak_files(srv, path):
    r, _ = request(srv, "GET", path, token=False)
    assert r.status == 404


def test_rejects_foreign_host_header(srv):
    # DNS 重绑定：恶意域名解析到 127.0.0.1 时，Host 头仍是该域名
    r, _ = request(srv, "GET", "/", token=False, host="evil.example:8765")
    assert r.status == 403


def test_options_preflight_not_allowed(srv):
    r, _ = request(srv, "OPTIONS", "/api/process", token=False)
    assert r.status >= 400
    assert r.getheader("Access-Control-Allow-Origin") is None


# ---------- 接口访问控制 ----------


def test_health_needs_no_token(srv):
    r, data = request(srv, "GET", "/api/health", token=False)
    assert r.status == 200 and json.loads(data)["ok"] is True


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/key-status?provider=openai"),
        ("POST", "/api/process"),
        ("POST", "/api/save-key"),
        ("POST", "/api/delete-key"),
        ("POST", "/api/export-docx"),
    ],
)
def test_api_requires_token(srv, method, path):
    r, _ = request(
        srv, method, path, body={} if method == "POST" else None, token=False
    )
    assert r.status == 403


def test_cross_site_origin_rejected_even_with_token(srv):
    r, _ = request(
        srv,
        "POST",
        "/api/process",
        {"provider": "openai", "text": "x"},
        headers={"Origin": "https://evil.example"},
    )
    assert r.status == 403
    assert srv["calls"] == []


def test_cross_site_fetch_metadata_rejected(srv):
    r, _ = request(
        srv,
        "POST",
        "/api/process",
        {"provider": "openai", "text": "x"},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert r.status == 403


# ---------- 已保存 Key 的发送范围 ----------


def test_saved_key_used_for_registered_default_base(srv):
    save_key(srv, "openai", "sk-saved-9999")
    r, data = request(
        srv,
        "POST",
        "/api/process",
        {"provider": "openai", "text": "Hello", "task": "translate"},
    )
    assert r.status == 200, data
    assert json.loads(data)["text"] == "译文"
    call = srv["calls"][-1]
    assert call["url"].startswith("https://api.openai.com/v1/")
    assert call["headers"]["Authorization"] == "Bearer sk-saved-9999"


def test_saved_key_never_sent_to_other_base(srv):
    save_key(srv, "openai", "sk-saved-9999")
    r, data = request(
        srv,
        "POST",
        "/api/process",
        {
            "provider": "openai",
            "text": "Hello",
            "api_base": "https://attacker.example/v1",
        },
    )
    assert r.status == 500
    assert "登记" in json.loads(data)["error"]
    assert srv["calls"] == []


def test_saved_key_follows_base_registered_at_save_time(srv):
    save_key(srv, "custom", "sk-custom", base="https://llm.internal.example/v1/")
    ok, _ = request(
        srv,
        "POST",
        "/api/process",
        {
            "provider": "custom",
            "text": "Hi",
            "api_base": "https://llm.internal.example/v1",
            "model": "m",
        },
    )
    assert ok.status == 200
    bad, _ = request(
        srv,
        "POST",
        "/api/process",
        {
            "provider": "custom",
            "text": "Hi",
            "api_base": "https://other.example/v1",
            "model": "m",
        },
    )
    assert bad.status == 500
    assert len(srv["calls"]) == 1


def test_typed_key_may_use_any_base(srv):
    r, _ = request(
        srv,
        "POST",
        "/api/process",
        {
            "provider": "custom",
            "text": "Hi",
            "api_key": "sk-typed",
            "api_base": "https://my-proxy.example/v1",
            "model": "m",
        },
    )
    assert r.status == 200
    assert srv["calls"][-1]["headers"]["Authorization"] == "Bearer sk-typed"


def test_env_key_restricted_to_default_base(srv, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    bad, _ = request(
        srv,
        "POST",
        "/api/process",
        {"provider": "openai", "text": "Hi", "api_base": "https://attacker.example"},
    )
    assert bad.status == 500 and srv["calls"] == []


def test_key_status_and_delete(srv):
    save_key(srv, "deepseek", "sk-abcd1234")
    r, data = request(srv, "GET", "/api/key-status?provider=deepseek")
    info = json.loads(data)
    assert info["saved"] is True and info["masked"].endswith("1234")
    assert "sk-abcd1234" not in data.decode("utf-8")
    request(srv, "POST", "/api/delete-key", {"provider": "deepseek"})
    r, data = request(srv, "GET", "/api/key-status?provider=deepseek")
    assert json.loads(data)["saved"] is False


def test_oversized_body_rejected(srv):
    conn = http.client.HTTPConnection("127.0.0.1", srv["port"], timeout=10)
    conn.putrequest("POST", "/api/process", skip_host=True)
    conn.putheader("Host", f"127.0.0.1:{srv['port']}")
    conn.putheader("X-SPT-Token", server.SESSION_TOKEN)
    conn.putheader("Content-Length", str(server.MAX_BODY_BYTES + 1))
    conn.endheaders()
    r = conn.getresponse()
    assert r.status == 413
    conn.close()


# ---------- Word 导出与导入 ----------

PAGES = [
    {
        "n": 1,
        "source": "Chapter One\n\nThe state is old.",
        "target": "第一章\n\n国家由来已久。",
    },
    {"n": 2, "source": "It persists.", "target": "它延续至今。"},
]


def export(srv, payload):
    r, data = request(srv, "POST", "/api/export-docx", payload)
    assert r.status == 200, data[:500]
    z = zipfile.ZipFile(io.BytesIO(data))
    return z, z.read("word/document.xml").decode("utf-8")


@pytest.mark.parametrize("mode", ["translated", "bilingual"])
def test_export_translation_docx(srv, mode):
    _, xml = export(srv, {"mode": mode, "file_name": "test.pdf", "pages": PAGES})
    assert "国家由来已久" in xml
    if mode == "bilingual":
        assert "The state is old" in xml


def test_export_manuscript_with_true_footnotes(srv):
    manuscript = {
        "blocks": [
            {"type": "book_title", "text": "国家的起源"},
            {"type": "chapter", "text": "第一章 导论", "level": 1},
            {"type": "body", "text": "国家由来已久。[[FN:ch1:1]]"},
            {
                "type": "footnote",
                "text": "参见韦伯的相关论述。",
                "note_id": "1",
                "note_scope": "ch1",
            },
        ]
    }
    z, xml = export(
        srv,
        {
            "mode": "manuscript",
            "file_name": "t.pdf",
            "pages": PAGES,
            "manuscript": manuscript,
            "true_footnotes": True,
        },
    )
    assert "国家的起源" in xml and "第一章 导论" in xml
    assert "[[FN:" not in xml
    footnotes = z.read("word/footnotes.xml").decode("utf-8")
    assert "参见韦伯的相关论述" in footnotes
    assert re.search(r"w:footnoteReference", xml)


def test_import_docx_roundtrip(srv):
    _, _ = export(srv, {"mode": "translated", "file_name": "t.pdf", "pages": PAGES})
    r, data = request(
        srv, "POST", "/api/export-docx", {"mode": "translated", "pages": PAGES}
    )
    b64 = base64.b64encode(data).decode("ascii")
    r, out = request(
        srv, "POST", "/api/import-docx", {"base64": b64, "file_name": "t.docx"}
    )
    assert r.status == 200, out[:300]
    assert "国家由来已久" in out.decode("utf-8")


# ---------- 纯函数 ----------


def test_reflow_joins_paragraph_split_across_pages():
    pages = [
        {"n": 1, "target": "这是一个跨页的段落，前半部分"},
        {"n": 2, "target": "后半部分在下一页。"},
    ]
    texts = [b["text"] for b in server.reflow_blocks(pages, "target", target=True)]
    assert any("前半部分后半部分" in t for t in texts)


def test_note_key_normalization():
    assert server._note_key(" Chapter 1 ", "3") == "chapter-1:3"
    assert server._note_key("", "3") == ""


@pytest.mark.parametrize(
    "task", ["translate", "proofread", "audit", "reconstruct", "ping"]
)
def test_every_frontend_task_has_a_system_prompt(task):
    p = server.system_prompt(
        {
            "task": task,
            "source_lang": "en",
            "target_lang": "zh-CN",
            "glossary": "state capacity = 国家能力",
        }
    )
    assert p.strip()
    if task in ("translate", "proofread"):
        assert "国家能力" in p


def test_reconstruct_prompt_matches_frontend_contract():
    p = server.system_prompt({"task": "reconstruct"})
    assert "[[FN:" in p and '"blocks"' in p
    for t in ("chapter", "footnote", "discard", "toc_entry"):
        assert t in p


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
def test_call_ai_builds_requests_for_each_api_kind(monkeypatch, provider):
    seen = {}

    def fake(url, headers, payload, label):
        seen.update(url=url, headers=headers, payload=payload)
        if provider == "anthropic":
            return {"content": [{"type": "text", "text": "好"}]}
        if provider == "gemini":
            return {"candidates": [{"content": {"parts": [{"text": "好"}]}}]}
        return {"choices": [{"message": {"content": "好"}}]}

    monkeypatch.setattr(ai_client, "_post_json", fake)
    out = server.call_ai(
        {"provider": provider, "api_key": "k", "text": "good", "task": "translate"}
    )
    assert out == "好"
    assert seen["url"].startswith(server.PROVIDERS[provider]["base"])


def test_pdfjs_cmaps_and_fonts_are_served(srv):
    for path in (
        "/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap",
        "/vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
    ):
        r, data = request(srv, "GET", path, token=False)
        assert r.status == 200 and len(data) > 100, path
