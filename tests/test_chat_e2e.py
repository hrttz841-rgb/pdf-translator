"""在无头浏览器中实际跑一遍对话模式的批量处理。

需要 Playwright 及其 Chromium（python -m pip install playwright && python -m playwright install chromium）
和 reportlab（生成测试 PDF）；缺少时自动跳过。AI 回复由测试替换，不会联网。
"""

import json
import re
import threading
from http.server import ThreadingHTTPServer

import pytest

sync_api = pytest.importorskip("playwright.sync_api")
pytest.importorskip("reportlab")

import ai_client
import batch_io
import keystore
import server


def _fake_reply(payload):
    system = payload["messages"][0]["content"]
    user = payload["messages"][1]["content"]
    if system.startswith("你是 Scholar PDF Translator 的对话助手"):
        msg = user.split("用户消息：", 1)[-1]
        out = {"reply": "已调整。", "action": "none", "settings": {}, "glossary_add": []}
        if "不要校对" in msg:
            out["settings"]["proof"] = False
        if "对照" in msg:
            out["settings"]["bilingual"] = True
        m = re.search(r"([A-Za-z ]+?)\s*译为\s*([一-鿿]+)", msg)
        if m:
            out["glossary_add"].append(f"{m.group(1).strip()} = {m.group(2)}")
        return json.dumps(out, ensure_ascii=False)
    if system.startswith("你是学术文献翻译专家"):
        text = user.split("待处理文本：\n", 1)[-1]
        return "\n\n".join("【译】" + p for p in text.split("\n\n") if p.strip())
    if system.startswith("你是学术翻译校对编辑"):
        return user.split("TRANSLATION TO PROOFREAD:\n", 1)[-1]
    if system.startswith("你是学术图书的编辑"):
        body = user.split("待重建的中文译文：\n", 1)[-1].split("\n\n原文对照", 1)[0]
        blocks = []
        for line in body.splitlines():
            line = line.strip()
            if line and not line.startswith("==="):
                blocks.append({"type": "chapter" if not blocks else "body", "text": line, "level": 1 if not blocks else 0})
        return json.dumps({"blocks": blocks}, ensure_ascii=False)
    return "连接正常"


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setattr(keystore, "KEY_DIR", tmp_path / "keys")
    monkeypatch.setattr(server.platform, "system", lambda: "Linux")
    monkeypatch.setenv("PDF_TRANSLATOR_OUTPUT", str(tmp_path / "default-out"))
    monkeypatch.setattr(batch_io, "open_in_file_manager", lambda *a, **k: {"opened": ""})
    for info in server.PROVIDERS.values():
        monkeypatch.delenv(info["env"], raising=False)
    keystore.save_api_key("sk-test-0000", "deepseek")
    keystore.record_key_base("deepseek", "https://api.deepseek.com")
    monkeypatch.setattr(
        ai_client,
        "_post_json",
        lambda url, headers, payload, label: {
            "choices": [{"message": {"content": _fake_reply(payload)}, "finish_reason": "stop"}]
        },
    )
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with sync_api.sync_playwright() as p:
            try:
                browser = p.chromium.launch()
            except Exception as e:  # 没有安装 Chromium
                pytest.skip(f"Chromium 不可用：{e}")
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{httpd.server_address[1]}/")
            page.wait_for_selector(".msg.assistant", timeout=20000)
            yield page, errors
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


def _make_folder(root):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    (root / "sub").mkdir(parents=True)
    c = canvas.Canvas(str(root / "sub" / "Origins.pdf"), pagesize=A4)
    for text in ["Anarchism rejects coercive hierarchy.", "Kropotkin wrote about mutual aid."]:
        c.setFont("Helvetica", 12)
        c.drawString(72, 760, text)
        c.drawString(72, 740, "The state is held to be unnecessary and harmful.")
        c.showPage()
    c.save()
    (root / "已有译文.html").write_text(
        "<html><body><h1>第一章 国家</h1><p>国家由来已久。</p><p>它延续至今。</p></body></html>",
        encoding="utf-8",
    )
    (root / "notes.txt").write_text("忽略")


def _send(page, text):
    page.fill("#chatInput", text)
    page.press("#chatInput", "Enter")


def test_chat_batch_translates_folder_from_pasted_path(live, tmp_path):
    page, errors = live
    folder = tmp_path / "文献"
    _make_folder(folder)

    _send(page, "另外出一份对照版，mutual aid 译为互助")
    page.wait_for_function(
        "document.querySelectorAll('.msg.assistant').length >= 2 && !document.querySelector('.typing')"
    )
    reply = page.locator(".msg.assistant").last.inner_text()
    assert "对照 Word：开启" in reply and "术语表" in reply
    assert "mutual aid = 互助" in page.input_value("#glossary")

    _send(page, str(folder))
    page.wait_for_function(
        "[...document.querySelectorAll('.msg.assistant')].some(m => m.innerText.includes('处理完毕'))",
        timeout=120000,
    )
    card = page.locator(".queue-card").last.inner_text()
    assert card.count("已完成") == 2 and "出错" not in card

    out = folder / "译文"
    for name in [
        "sub/Origins_中文书稿版.docx",
        "sub/Origins_原文译文对照版.docx",
        "sub/Origins.translation-project.json",
        "已有译文_中文书稿版.docx",
    ]:
        assert (out / name).is_file(), name
    proj = json.loads((out / "sub" / "Origins.translation-project.json").read_text("utf-8"))
    assert all(p["translated"] and p["target"].startswith("【译】") for p in proj["pages"])
    imported = json.loads((out / "已有译文.translation-project.json").read_text("utf-8"))
    assert imported["pages"][0]["target"].startswith("第一章 国家\n\n国家由来已久")

    # 再次发送：已完成的文件被跳过
    _send(page, str(folder))
    page.wait_for_function("document.querySelectorAll('.queue-card').length >= 2")
    assert "此前已经译好" in page.locator(".msg.assistant").last.inner_text()
    assert errors == []
