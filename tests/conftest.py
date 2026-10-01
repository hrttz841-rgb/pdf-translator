import threading
from http.server import ThreadingHTTPServer

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
