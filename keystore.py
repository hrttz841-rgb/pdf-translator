"""API Key 的系统凭据存储（macOS Keychain、Windows DPAPI、其他系统为权限受限的本地文件），以及已保存 Key 允许发送的地址登记。"""

import json, os, re, subprocess, platform
from pathlib import Path

from providers import normalize_provider, provider_info

KEYCHAIN_ACCOUNT = (
    os.environ.get("USER")
    or os.environ.get("LOGNAME")
    or os.environ.get("USERNAME")
    or "local-user"
)
KEY_DIR = Path.home() / ".scholar_pdf_translator"


def _windows_powershell():
    for name in ("powershell.exe", "powershell"):
        try:
            r = subprocess.run(
                [name, "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if r.returncode == 0:
                return name
        except Exception:
            pass
    return "powershell.exe"


def _safe_provider_name(provider):
    return re.sub(r"[^a-z0-9_-]+", "_", normalize_provider(provider))


def _keychain_service(provider):
    return "Scholar PDF Translator - " + _safe_provider_name(provider)


def _fallback_key_file(provider):
    return KEY_DIR / (_safe_provider_name(provider) + "_api_key")


def _windows_key_file(provider):
    return KEY_DIR / (_safe_provider_name(provider) + "_api_key.dpapi")


def load_saved_api_key(provider="deepseek"):
    provider = normalize_provider(provider)
    system = platform.system()
    if system == "Darwin":
        try:
            r = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-s",
                    _keychain_service(provider),
                    "-a",
                    KEYCHAIN_ACCOUNT,
                    "-w",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode == 0:
                return r.stdout.strip()
        except Exception:
            pass
        return ""
    if system == "Windows":
        target = _windows_key_file(provider)
        if not target.exists():
            return ""
        ps = _windows_powershell()
        script = r"""$p=$env:PDF_TRANSLATOR_KEY_FILE; if (!(Test-Path -LiteralPath $p)) { exit 3 }; $enc=Get-Content -LiteralPath $p -Raw; $sec=ConvertTo-SecureString $enc; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}"""
        env = os.environ.copy()
        env["PDF_TRANSLATOR_KEY_FILE"] = str(target)
        try:
            r = subprocess.run(
                [ps, "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True,
                text=True,
                timeout=15,
                env=env,
            )
            if r.returncode == 0:
                return r.stdout.strip()
        except Exception:
            pass
        return ""
    try:
        return _fallback_key_file(provider).read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def save_api_key(api_key, provider="deepseek"):
    api_key = (api_key or "").strip()
    provider = normalize_provider(provider)
    if not api_key:
        raise ValueError("API Key 不能为空")
    system = platform.system()
    if system == "Darwin":
        r = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                _keychain_service(provider),
                "-a",
                KEYCHAIN_ACCOUNT,
                "-w",
                api_key,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "无法写入钥匙串").strip())
        return "macOS Keychain"
    if system == "Windows":
        target = _windows_key_file(provider)
        target.parent.mkdir(parents=True, exist_ok=True)
        ps = _windows_powershell()
        script = r"""$sec=ConvertTo-SecureString -String $env:PDF_TRANSLATOR_API_KEY -AsPlainText -Force; $enc=$sec | ConvertFrom-SecureString; Set-Content -LiteralPath $env:PDF_TRANSLATOR_KEY_FILE -Value $enc -Encoding UTF8"""
        env = os.environ.copy()
        env["PDF_TRANSLATOR_API_KEY"] = api_key
        env["PDF_TRANSLATOR_KEY_FILE"] = str(target)
        r = subprocess.run(
            [ps, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        if r.returncode != 0:
            raise RuntimeError(
                (r.stderr or r.stdout or "无法写入 Windows DPAPI 凭据").strip()
            )
        return "Windows DPAPI"
    target = _fallback_key_file(provider)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(api_key, encoding="utf-8")
    try:
        os.chmod(target, 0o600)
    except Exception:
        pass
    return "local secure file"


def delete_saved_api_key(provider="deepseek"):
    provider = normalize_provider(provider)
    system = platform.system()
    if system == "Darwin":
        r = subprocess.run(
            [
                "security",
                "delete-generic-password",
                "-s",
                _keychain_service(provider),
                "-a",
                KEYCHAIN_ACCOUNT,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode not in (0, 44):
            raise RuntimeError((r.stderr or r.stdout or "无法删除钥匙串项目").strip())
        return
    target = (
        _windows_key_file(provider)
        if system == "Windows"
        else _fallback_key_file(provider)
    )
    try:
        target.unlink(missing_ok=True)
    except TypeError:
        if target.exists():
            target.unlink()


def _key_bases_file():
    return KEY_DIR / "key_bases.json"


def _read_key_bases():
    try:
        return json.loads(_key_bases_file().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _normalize_base(base):
    return (base or "").strip().rstrip("/")


def record_key_base(provider, base):
    """登记已保存 Key 允许发送到的 API 地址（地址本身不是机密，以普通 JSON 保存）。"""
    provider = normalize_provider(provider)
    bases = _read_key_bases()
    base = _normalize_base(base) or _normalize_base(provider_info(provider).get("base"))
    if base:
        bases[provider] = base
    else:
        bases.pop(provider, None)
    _key_bases_file().parent.mkdir(parents=True, exist_ok=True)
    _key_bases_file().write_text(
        json.dumps(bases, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def forget_key_base(provider):
    bases = _read_key_bases()
    if bases.pop(normalize_provider(provider), None) is not None:
        _key_bases_file().write_text(
            json.dumps(bases, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def allowed_base_for_stored_key(provider):
    provider = normalize_provider(provider)
    return _normalize_base(_read_key_bases().get(provider)) or _normalize_base(
        provider_info(provider).get("base")
    )


def resolve_api_key(data, provider, base):
    """返回本次请求使用的 Key。

    请求中直接携带的 Key 可发往任意地址（用户正在界面中手动填写）；
    已保存的 Key 与环境变量中的 Key 只能发往登记地址，防止被改写 API Base 后转发到第三方服务器。
    """
    info = provider_info(provider)
    label = info["label"]
    typed = (data.get("api_key") or "").strip()
    if typed:
        return typed
    env_key = os.environ.get(info.get("env", ""), "") if info.get("env") else ""
    stored = (env_key or load_saved_api_key(provider) or "").strip()
    if not stored:
        raise ValueError(f"缺少 {label} API Key")
    allowed = allowed_base_for_stored_key(provider)
    if not allowed:
        # 自定义平台且尚未登记地址（例如旧版本保存的 Key）：首次使用时登记
        record_key_base(provider, base)
        allowed = _normalize_base(base)
    if _normalize_base(base) != allowed:
        raise ValueError(
            f"出于安全考虑，已保存的 {label} Key 只会发送到保存时登记的地址（{allowed or '未登记'}）。"
            f"如需改用 {base}，请在设置中重新输入 Key 并保存。"
        )
    return stored
