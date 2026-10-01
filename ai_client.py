"""构造提示词并调用各 AI 平台接口。"""

import json, urllib.request, urllib.error, subprocess, platform, ssl
from pathlib import Path

from providers import normalize_provider, provider_info
from keystore import resolve_api_key


def build_ssl_context():
    """Build a verified TLS context, preferring certifi's Mozilla CA bundle."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        # Fall back to the Python/system trust store. We deliberately do not
        # disable certificate verification.
        return ssl.create_default_context()


def _system_curl():
    if platform.system() == "Windows":
        return "curl.exe"
    return "/usr/bin/curl" if Path("/usr/bin/curl").exists() else "curl"


def call_json_via_curl(url, headers, payload, provider_label="AI"):
    body = json.dumps(payload, ensure_ascii=False)
    cmd = [
        _system_curl(),
        "--silent",
        "--show-error",
        "--connect-timeout",
        "20",
        "--max-time",
        "300",
        "--request",
        "POST",
        "--header",
        "Content-Type: application/json",
    ]
    for k, v in headers.items():
        cmd += ["--header", f"{k}: {v}"]
    cmd += ["--data-binary", "@-", "--write-out", "\n__HTTP_STATUS__:%{http_code}", url]
    r = subprocess.run(cmd, input=body, capture_output=True, text=True, timeout=310)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "").strip()
        raise RuntimeError(
            f"系统 curl 连接 {provider_label} 失败："
            + (msg[:1600] or f"退出码 {r.returncode}")
        )
    marker = "\n__HTTP_STATUS__:"
    if marker not in r.stdout:
        raise RuntimeError(f"{provider_label} 返回格式异常：未取得 HTTP 状态码")
    response_text, status_text = r.stdout.rsplit(marker, 1)
    try:
        status = int(status_text.strip())
    except ValueError:
        raise RuntimeError(f"{provider_label} 返回格式异常：HTTP 状态码无效")
    if not (200 <= status < 300):
        raise RuntimeError(f"{provider_label} HTTP {status}: {response_text[:1800]}")
    try:
        return json.loads(response_text)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"{provider_label} 返回了无法解析的 JSON：" + response_text[:1200]
        ) from e


def call_json_via_python(url, headers, payload, provider_label="AI"):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300, context=build_ssl_context()) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"{provider_label} HTTP {e.code}: {detail[:1500]}")


def _post_json(url, headers, payload, provider_label):
    if platform.system() in ("Darwin", "Windows"):
        return call_json_via_curl(url, headers, payload, provider_label)
    try:
        return call_json_via_curl(url, headers, payload, provider_label)
    except Exception:
        return call_json_via_python(url, headers, payload, provider_label)


def _join_url(base, suffix):
    base = (base or "").rstrip("/")
    if base.endswith(suffix):
        return base
    return base + suffix


def _user_prompt(data):
    text = data.get("text") or ""
    context = (data.get("context") or "").strip()
    source = (data.get("source_text") or "").strip()
    task = data.get("task", "translate")
    if task == "proofread":
        user = f"SOURCE:\n{source}\n\nTRANSLATION TO PROOFREAD:\n{text}"
        if context:
            user = f"上一页译文末尾（仅供术语连续性参考）：\n{context}\n\n" + user
    elif task == "reconstruct":
        user = f"待重建的中文译文：\n{text}"
        if source:
            user += f"\n\n原文对照（仅用于判断标题层级、注号、注释边界和 OCR 污染；不要重新翻译）：\n{source}"
        if context:
            user = f"前文结构上下文（只用于章节连续性）：\n{context}\n\n" + user
    else:
        user = text
        if context:
            user = f"前文上下文（只用于术语和衔接，不要重复输出）：\n{context}\n\n待处理文本：\n{text}"
    return user


LANG_NAMES = {
    "auto": "原文语言（自动识别）",
    "en": "英文",
    "zh": "中文",
    "zh-CN": "简体中文",
    "ja": "日文",
    "fr": "法文",
    "de": "德文",
}

STYLE_RULES = {
    "academic": "学术中文：准确、克制，术语前后一致，保留原文论证层次，不添加原文没有的解释。",
    "formal": "正式书面语：表达通顺规范，忠实原意，适度调整语序以符合目标语言习惯。",
    "literal": "偏直译：尽量贴近原文句式与用词，便于逐句对照，不做意译和润色。",
}

MANUSCRIPT_TYPES = (
    "book_title, subtitle, author, copyright, dedication, epigraph, preface_title, "
    "part, chapter, section, subsection, body, blockquote, footnote, figure_caption, "
    "table_caption, bibliography, appendix, toc_entry, notes_heading, source_info, discard"
)


def _glossary_rules(data):
    lines = []
    for raw in (data.get("glossary") or "").splitlines():
        if "=" in raw:
            a, b = raw.split("=", 1)
            if a.strip() and b.strip():
                lines.append(f"- {a.strip()} → {b.strip()}")
    return ("\n术语表（必须严格遵守）：\n" + "\n".join(lines)) if lines else ""


def system_prompt(data):
    task = data.get("task", "translate")
    src = LANG_NAMES.get(data.get("source_lang") or "auto", data.get("source_lang"))
    tgt = LANG_NAMES.get(data.get("target_lang") or "zh-CN", data.get("target_lang"))
    style = STYLE_RULES.get(data.get("style") or "academic", STYLE_RULES["academic"])
    extra = (data.get("custom_prompt") or "").strip()
    extra = f"\n用户额外要求：\n{extra}" if extra else ""
    glossary = _glossary_rules(data)
    if task == "ping":
        return "这是连接测试。请只回复“连接正常”。"
    if task == "translate":
        return (
            f"你是学术文献翻译专家，负责把{src}文本译为{tgt}。\n"
            f"风格要求：{style}\n"
            "规则：\n"
            "- 只输出译文，不要解释、前言或总结，不要使用 Markdown 代码块。\n"
            "- 保留段落划分；标题单独成段。\n"
            "- 人名、机构名首次出现可在译名后括注原文。\n"
            "- 数字、年份、比例、引文页码必须与原文一致。\n"
            "- 形如 [^12] 的记号是注号，必须原样保留在译文中对应词句之后，不得删除、改写或重新编号；没有这种记号的地方不要自行添加。\n"
            "- 以 [^12]: 或 [^+]: 开头的段落是页下注，保留开头的记号，只翻译其后的注释内容；注释中的文献信息（作者、书名、刊名、出版信息、页码）保留原文不译。\n"
            "- 参考文献条目保留原文不译。\n"
            "- 明显的 OCR 断行、连字符断词可直接修复，但不得删减内容。\n"
            "- 提供的前文上下文只用于保持术语与衔接，不要重复翻译。"
            f"{glossary}{extra}"
        )
    if task == "proofread":
        return (
            f"你是学术翻译校对编辑。请对照原文（{src}）检查{tgt}译文，并直接输出修订后的完整译文。\n"
            f"风格要求：{style}\n"
            "重点检查：漏译、误译、OCR 错误导致的误读、人名机构名与专有名词、数字年份与比例、段落遗漏、术语前后不一致。\n"
            "检查译文是否原样保留了原文中所有形如 [^12] 的注号以及以 [^12]: 开头的页下注记号，缺失的要补回到对应位置。\n"
            "只输出修订后的译文全文，不要列出修改说明，不要使用 Markdown 代码块；没有问题时原样输出译文。"
            f"{glossary}{extra}"
        )
    if task == "audit":
        return (
            f"你是学术译稿的术语审校。下面是一份{tgt}译稿的节选，按 [P页码] 分隔。\n"
            "请检查同一术语、人名、机构名在不同页中的译法是否一致，指出明显的前后矛盾和可疑译法。\n"
            "输出简洁的中文清单：每条写明涉及的词、出现的不同译法及页码、建议统一的译法。没有发现问题时说明“未发现明显的术语不一致”。"
            f"{glossary}"
        )
    if task == "reconstruct":
        return (
            "你是学术图书的编辑，负责把按页拼接的译文重建为结构化书稿。\n"
            "输入按 === PDF PAGE n === 或 === IMPORTED TEXT UNIT n === 分隔；可能附带原文，只用于判断结构，不要重新翻译。\n"
            "只输出一个 JSON 对象，不要任何说明文字，格式：\n"
            '{"blocks":[{"type":"chapter","text":"……","page":1,"level":1,"confidence":0.9}]}\n'
            f"type 只能取：{MANUSCRIPT_TYPES}。\n"
            "规则：\n"
            "- 按阅读顺序输出全部内容，正文不得删减或改写，只修复明显的断行和跨页断句；跨页被截断的段落合并为一个 body。\n"
            "- level：part=1，chapter=1，section=2，subsection=3，其余为 0。\n"
            "- 页眉、页脚、页码、馆藏章、扫描平台水印、条码、孤立乱码标为 discard 或直接省略。\n"
            "- 原书目录页的条目标为 toc_entry（导出时会根据章节结构重新生成目录）。\n"
            "- 注号：正文中形如 [^12] 的记号必须原样保留在 text 中原来的位置，不要删除、改写或转换格式。"
            "原文明显是注号、但译文里没有记号的上标数字（如紧跟在句末标点后的孤立数字），改写为 [^编号]。\n"
            "- 章末注、书末注：集中排列的编号注释条目，每条输出一个 type=footnote 的块，note_id 填编号（只填数字），text 只放注释内容，不含编号。"
            "注释列表中按章分组的小标题（如“第二章”“Notes to Chapter 2”）输出为 type=notes_heading；整个注释部分的总标题（如“注释”“Notes”）输出为 chapter。"
            "注释中的文献信息保持原文。\n"
            "- 版权页：只提取引用原书所需的信息，合成一个 type=source_info 的块，按“作者. 书名: 副标题. 出版地: 出版社, 年份.”的格式用原文书写，有版次或译者时一并写入；"
            "版权声明、印刷与印次信息、ISBN、图书在版编目数据、排版与设计人员、纸张说明等全部标为 discard。\n"
            "- 提供的前文结构上下文只用于保持章节层级连续，不要重复输出。"
            f"{extra}"
        )
    return f"请按要求处理以下文本，输出结果即可。{extra}"


def call_ai(data):
    return call_ai_result(data)["text"]


def call_ai_result(data):
    """调用 AI 接口，返回 {"text": 文本, "truncated": 是否因达到输出长度上限而被截断}。"""
    provider = normalize_provider(data.get("provider"))
    info = provider_info(provider)
    label = info["label"]
    base = (data.get("api_base") or info.get("base") or "").rstrip("/")
    model = (data.get("model") or info.get("model") or "").strip()
    if not base:
        raise ValueError(f"{label} API Base 不能为空")
    api_key = resolve_api_key(data, provider, base)
    if not model:
        raise ValueError(f"{label} 模型名称不能为空")
    system = system_prompt(data)
    user = _user_prompt(data)
    kind = info.get("kind", "openai")
    if kind == "anthropic":
        url = _join_url(base, "/v1/messages")
        payload = {
            "model": model,
            "max_tokens": 8192,
            "temperature": 0.15,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        obj = _post_json(
            url,
            {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
            payload,
            label,
        )
        parts = obj.get("content") or []
        text = "".join(
            (p.get("text") or "")
            for p in parts
            if isinstance(p, dict) and p.get("type") == "text"
        ).strip()
        if not text:
            raise RuntimeError(f"{label} 返回中没有可用文本")
        return {"text": text, "truncated": obj.get("stop_reason") == "max_tokens"}
    if kind == "gemini":
        url = _join_url(base, f"/models/{model}:generateContent")
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0.15},
        }
        obj = _post_json(url, {"x-goog-api-key": api_key}, payload, label)
        candidates = obj.get("candidates") or []
        if not candidates:
            raise RuntimeError(
                f"{label} 返回中没有 candidates：{json.dumps(obj,ensure_ascii=False)[:900]}"
            )
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(
            (p.get("text") or "") for p in parts if isinstance(p, dict)
        ).strip()
        if not text:
            raise RuntimeError(f"{label} 返回中没有可用文本")
        return {
            "text": text,
            "truncated": candidates[0].get("finishReason") == "MAX_TOKENS",
        }
    url = _join_url(base, "/chat/completions")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.15,
        "stream": False,
    }
    obj = _post_json(url, {"Authorization": "Bearer " + api_key}, payload, label)
    try:
        choice = obj["choices"][0]
        return {
            "text": (choice["message"]["content"] or "").strip(),
            "truncated": choice.get("finish_reason") == "length",
        }
    except Exception:
        raise RuntimeError(
            f"{label} 返回中没有 choices[0].message.content：{json.dumps(obj,ensure_ascii=False)[:900]}"
        )
