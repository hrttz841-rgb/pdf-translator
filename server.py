#!/usr/bin/env python3
import json, os, urllib.parse, platform, base64
import hmac, secrets
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("PDF_TRANSLATOR_PORT", "8765"))
APP_ID = "scholar-pdf-translator"
APP_VERSION = "2.8.0"
# 每次启动随机生成的会话令牌。只注入到本服务提供的页面中，其他网站无法读取，
# 因而无法冒用本地服务调用 AI 接口或管理已保存的 API Key。
SESSION_TOKEN = secrets.token_urlsafe(32)
TOKEN_HEADER = "X-SPT-Token"
MAX_BODY_BYTES = 90 * 1024 * 1024

# PROVIDERS、provider_info、system_prompt、reflow_blocks、_note_key 等在此重新导出，供测试与脚本使用
from providers import PROVIDERS, normalize_provider, provider_info  # noqa: F401
from keystore import (
    load_saved_api_key,
    save_api_key,
    delete_saved_api_key,
    record_key_base,
    forget_key_base,
    allowed_base_for_stored_key,
)
from ai_client import call_ai, system_prompt  # noqa: F401
from docx_export import (  # noqa: F401
    build_translation_docx,
    build_manuscript_docx,
    import_docx_bytes,
    reflow_blocks,
    _note_key,
)

STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".gz": "application/gzip",
    ".md": "text/plain; charset=utf-8",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".ttf": "font/ttf",
}


class Handler(BaseHTTPRequestHandler):
    # 不发送任何 CORS 头：页面与接口同源，跨站网页既无法读取响应，也无法携带自定义令牌头。

    def _allowed_hosts(self):
        port = self.server.server_address[1]
        return {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}

    def _host_ok(self):
        # 校验 Host 头以防御 DNS 重绑定：恶意域名解析到 127.0.0.1 时 Host 仍是该域名
        return (self.headers.get("Host") or "").lower() in self._allowed_hosts()

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if origin and origin.lower() not in {
            "http://" + h for h in self._allowed_hosts()
        }:
            return False
        site = self.headers.get("Sec-Fetch-Site")
        return site in (None, "same-origin", "none")

    def _token_ok(self):
        return hmac.compare_digest(self.headers.get(TOKEN_HEADER, ""), SESSION_TOKEN)

    def _guard(self, api=False, needs_token=True):
        if not self._host_ok():
            self.send_error(403, "Invalid Host header")
            return False
        if api and not self._origin_ok():
            self.json_response({"error": "拒绝跨站请求"}, 403)
            return False
        if api and needs_token and not self._token_ok():
            self.json_response(
                {
                    "error": "会话令牌无效：请通过启动脚本打开的页面使用本工具，或刷新页面后重试"
                },
                403,
            )
            return False
        return True

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def json_response(self, obj, status=200):
        out = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def binary_response(
        self, content, content_type="application/octet-stream", status=200
    ):
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _static_file(self, p):
        if p == "/":
            p = "/index.html"
        rel = urllib.parse.unquote(p).lstrip("/")
        f = (ROOT / rel).resolve()
        try:
            f.relative_to(ROOT)
        except ValueError:
            return None
        if (
            not f.is_file()
            or f.suffix.lower() not in STATIC_MIME
            or any(part.startswith(".") for part in f.relative_to(ROOT).parts)
        ):
            return None
        return f

    def _serve_static(self, p, head=False):
        f = self._static_file(p)
        if f is None:
            self.send_error(404)
            return
        body = f.read_bytes()
        if f.name == "index.html" and f.parent == ROOT:
            meta = f'<meta name="spt-token" content="{SESSION_TOKEN}" />'
            body = body.decode("utf-8").replace("</head>", meta + "\n</head>", 1)
            body = body.encode("utf-8")
        self.send_response(200)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Cache-Control", "no-store" if f.suffix == ".html" else "no-cache"
        )
        self.send_header("Content-Type", STATIC_MIME[f.suffix.lower()])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_HEAD(self):
        if not self._guard():
            return
        p = self.path.split("?", 1)[0]
        if p.startswith("/api/"):
            self.send_error(405)
            return
        self._serve_static(p, head=True)

    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p == "/api/health":
            # 启动脚本用来探测服务是否在运行，不含敏感信息
            if not self._guard(api=True, needs_token=False):
                return
            self.json_response(
                {"ok": True, "app": APP_ID, "version": APP_VERSION, "port": PORT}
            )
            return
        if p.startswith("/api/"):
            if not self._guard(api=True):
                return
            if p == "/api/key-status":
                provider = normalize_provider(
                    urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get(
                        "provider", ["deepseek"]
                    )[0]
                )
                key = load_saved_api_key(provider)
                self.json_response(
                    {
                        "saved": bool(key),
                        "provider": provider,
                        "storage": (
                            "macOS Keychain"
                            if platform.system() == "Darwin"
                            else (
                                "Windows DPAPI"
                                if platform.system() == "Windows"
                                else "local secure file"
                            )
                        ),
                        "masked": ("••••" + key[-4:]) if key else "",
                        "allowed_base": (
                            allowed_base_for_stored_key(provider) if key else ""
                        ),
                    }
                )
                return
            self.send_error(404)
            return
        if not self._guard():
            return
        self._serve_static(p)

    def do_POST(self):
        if not self._guard(api=True):
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n < 0 or n > MAX_BODY_BYTES:
                self.json_response({"error": "请求体过大"}, 413)
                return
            data = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("请求格式错误")
            if self.path == "/api/process":
                text = call_ai(data)
                self.json_response({"text": text})
                return
            if self.path == "/api/export-docx":
                mode = data.get("mode", "translated")
                if mode == "manuscript":
                    content = build_manuscript_docx(data)
                else:
                    content = build_translation_docx(
                        data, bilingual=(mode == "bilingual")
                    )
                self.binary_response(
                    content,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                return
            if self.path == "/api/import-docx":
                raw = data.get("base64", "")
                if "," in raw:
                    raw = raw.split(",", 1)[1]
                try:
                    blob = base64.b64decode(raw, validate=True)
                except Exception:
                    raise ValueError("Word 文件数据无法解析")
                if len(blob) > 50 * 1024 * 1024:
                    raise ValueError("Word 文件过大（上限 50MB）")
                result = import_docx_bytes(blob)
                self.json_response(result)
                return
            if self.path == "/api/save-key":
                provider = normalize_provider(data.get("provider"))
                storage = save_api_key(data.get("api_key"), provider)
                record_key_base(provider, data.get("api_base"))
                key = data.get("api_key", "").strip()
                self.json_response(
                    {
                        "saved": True,
                        "storage": storage,
                        "masked": "••••" + key[-4:],
                        "allowed_base": allowed_base_for_stored_key(provider),
                    }
                )
                return
            if self.path == "/api/delete-key":
                provider = normalize_provider(data.get("provider"))
                delete_saved_api_key(provider)
                forget_key_base(provider)
                self.json_response({"saved": False, "provider": provider})
                return
            self.send_error(404)
        except Exception as e:
            self.json_response({"error": str(e)}, 500)

    def log_message(self, fmt, *args):
        print("[server]", fmt % args)


if __name__ == "__main__":
    print(f"Scholar PDF Translator v{APP_VERSION}: http://{HOST}:{PORT}")
    print("Ctrl+C 退出。各 AI 平台 API Key 可按平台分别保存在系统安全凭据存储中。")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
