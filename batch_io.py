"""对话式批量处理用到的本地文件读写：列出文件夹、读取其中的文件、写出译文。

浏览器只能拿到用户拖入的文件，拿不到它们在磁盘上的位置，也不能直接写盘。
这里由本地服务代为读写，范围限定为：

- 读：只读本次运行中列出过的文件夹里、扩展名受支持的文件；
- 写：只写入本次运行中登记过的输出文件夹（所选文件夹下的“译文”子文件夹，
  或默认输出目录下以来源文件夹命名的子文件夹）。

文件夹和输出目录都用随机 id 指代，浏览器传来的相对路径会再次校验，不能越出登记的目录。
"""

import json, os, platform, re, secrets, subprocess, urllib.parse
from pathlib import Path

OUTPUT_DIR_NAME = "译文"
SUPPORTED_EXTS = {".pdf", ".docx", ".html", ".htm"}
PROJECT_SUFFIX = ".translation-project.json"
MANUSCRIPT_SUFFIX = "_中文书稿版.docx"
BILINGUAL_SUFFIX = "_原文译文对照版.docx"
# 本工具自己生成的文件，出现在来源文件夹里时不再当作待翻译文件
OWN_OUTPUT_SUFFIXES = (MANUSCRIPT_SUFFIX, BILINGUAL_SUFFIX, PROJECT_SUFFIX)
MAX_DEPTH = 4
MAX_FILES = 500
MAX_SCAN = 5000

_folders = {}  # folder_id -> Path
_outputs = {}  # out_id -> Path


def default_output_root():
    env = os.environ.get("PDF_TRANSLATOR_OUTPUT", "").strip()
    if env:
        return Path(env).expanduser()
    home = Path.home()
    docs = home / "Documents"
    return (docs if docs.is_dir() else home) / "Scholar PDF Translator 译文"


def _clean_path_text(text):
    t = (text or "").strip().strip("'\"").strip()
    if t.lower().startswith("file://"):
        t = urllib.parse.unquote(urllib.parse.urlparse(t).path)
        # file:///C:/Users/... 在 Windows 上解析为 /C:/Users/...
        if re.match(r"^/[A-Za-z]:/", t):
            t = t[1:]
    # 终端里拖入的路径会把空格写成 "\ "（Windows 路径本身用反斜杠分隔，不做这一步）
    if os.sep == "/":
        t = re.sub(r"\\(.)", r"\1", t)
    return t


def _safe_name(name, fallback="未命名"):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(name or "")).strip(" .")
    return name[:120] or fallback


def file_stem(name):
    if name.lower().endswith(PROJECT_SUFFIX):
        return name[: -len(PROJECT_SUFFIX)]
    return Path(name).stem


def _rel_parts(rel):
    """校验浏览器传来的相对路径，返回各级目录名（不含文件名）。"""
    parts = [p for p in re.split(r"[\\/]+", str(rel or "")) if p not in ("", ".")]
    if not parts:
        raise ValueError("缺少文件名")
    if any(p == ".." for p in parts) or re.match(r"^[A-Za-z]:$", parts[0]):
        raise ValueError("文件路径无效")
    return parts


def is_supported(name):
    low = name.lower()
    if low.endswith(OWN_OUTPUT_SUFFIXES[:2]):
        return False
    if low.endswith(PROJECT_SUFFIX):
        return True
    return Path(low).suffix in SUPPORTED_EXTS


def _register_output(path):
    for oid, p in _outputs.items():
        if p == path:
            return oid
    oid = secrets.token_urlsafe(12)
    _outputs[oid] = path
    return oid


def output_dir(out_id):
    d = _outputs.get(out_id or "")
    if d is None:
        raise ValueError("输出位置已失效，请重新发送文件夹")
    return d


def output_paths(out_dir, rel):
    parts = _rel_parts(rel)
    sub = out_dir.joinpath(*[_safe_name(p) for p in parts[:-1]])
    stem = _safe_name(file_stem(parts[-1]), "译文")
    return {
        "manuscript": sub / (stem + MANUSCRIPT_SUFFIX),
        "bilingual": sub / (stem + BILINGUAL_SUFFIX),
        "project": sub / (stem + PROJECT_SUFFIX),
    }


def _is_done(out_dir, rel, outputs):
    paths = output_paths(out_dir, rel)
    kinds = [k for k in ("manuscript", "bilingual") if outputs.get(k)]
    if not kinds:
        kinds = ["manuscript"]
    return all(paths[k].is_file() for k in kinds)


def done_rels(out_id, rels, outputs=None):
    d = output_dir(out_id)
    outputs = outputs or {"manuscript": True}
    done = []
    for rel in rels or []:
        try:
            if _is_done(d, rel, outputs):
                done.append(rel)
        except ValueError:
            pass
    return done


def list_folder(path_text, outputs=None):
    raw = _clean_path_text(path_text)
    if not raw:
        raise ValueError("请提供文件夹路径")
    root = Path(raw).expanduser()
    if not root.is_absolute():
        raise ValueError("请提供完整的文件夹路径，例如 ~/Downloads/文献 或 C:\\Users\\你\\文献")
    root = root.resolve()
    if not root.exists():
        raise ValueError(f"找不到文件夹：{root}")
    if root.is_file():
        # 给的是单个文件：处理这个文件，输出放在它所在的文件夹下
        if not is_supported(root.name):
            raise ValueError(f"不支持的文件格式：{root.name}")
        target_files = [root]
        root = root.parent
    else:
        target_files = None
    files, skipped, scanned = [], 0, 0
    if target_files is None:
        stack = [(root, 0)]
        while stack and len(files) < MAX_FILES and scanned < MAX_SCAN:
            d, depth = stack.pop()
            try:
                entries = sorted(d.iterdir(), key=lambda p: p.name.lower())
            except OSError:
                continue
            subdirs = []
            for e in entries:
                scanned += 1
                if e.name.startswith(".") or e.name.startswith("~$"):
                    continue
                if e.is_dir():
                    if d == root and e.name == OUTPUT_DIR_NAME:
                        continue
                    if depth + 1 <= MAX_DEPTH:
                        subdirs.append(e)
                    continue
                if not e.is_file():
                    continue
                if is_supported(e.name):
                    files.append(e)
                else:
                    skipped += 1
            stack.extend((s, depth + 1) for s in reversed(subdirs))
    else:
        files = target_files
    fid = None
    for k, v in _folders.items():
        if v == root:
            fid = k
    if fid is None:
        fid = secrets.token_urlsafe(12)
        _folders[fid] = root
    out = root / OUTPUT_DIR_NAME
    out_id = _register_output(out)
    outputs = outputs or {"manuscript": True}
    items = []
    for f in files:
        rel = f.relative_to(root).as_posix()
        items.append(
            {
                "rel": rel,
                "name": f.name,
                "size": f.stat().st_size,
                "done": _is_done(out, rel, outputs),
            }
        )
    return {
        "folder_id": fid,
        "path": str(root),
        "name": root.name or str(root),
        "files": items,
        "skipped": skipped,
        "truncated": len(files) >= MAX_FILES,
        "out_id": out_id,
        "out_dir": str(out),
    }


def read_folder_file(folder_id, rel):
    root = _folders.get(folder_id or "")
    if root is None:
        raise ValueError("文件夹已失效，请重新发送文件夹路径")
    parts = _rel_parts(rel)
    f = root.joinpath(*parts).resolve()
    try:
        f.relative_to(root)
    except ValueError:
        raise ValueError("文件路径无效")
    if not f.is_file() or not is_supported(f.name):
        raise ValueError(f"无法读取：{rel}")
    return f.read_bytes()


def prepare_output(name, rels=None, outputs=None):
    root = default_output_root()
    out = root / _safe_name(name, "拖入的文件")
    out_id = _register_output(out)
    return {
        "out_id": out_id,
        "out_dir": str(out),
        "done": done_rels(out_id, rels or [], outputs),
    }


def _write_atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(content)
    os.replace(tmp, path)


def export_outputs(data, build_manuscript, build_bilingual):
    """按请求生成并写出书稿 Word、对照 Word 和项目 JSON，返回写出的文件。"""
    d = output_dir(data.get("out_id"))
    paths = output_paths(d, data.get("rel"))
    written = []
    jobs = []
    if data.get("manuscript"):
        jobs.append(("manuscript", lambda: build_manuscript(data["manuscript"])))
    if data.get("bilingual"):
        jobs.append(("bilingual", lambda: build_bilingual(data["bilingual"])))
    if data.get("project"):
        jobs.append(
            (
                "project",
                lambda: json.dumps(data["project"], ensure_ascii=False).encode("utf-8"),
            )
        )
    if not jobs:
        raise ValueError("没有需要写出的内容")
    # 先全部生成，再写盘：生成失败时不留下只写了一半的结果
    contents = [(k, fn()) for k, fn in jobs]
    for kind, content in contents:
        _write_atomic(paths[kind], content)
        written.append({"kind": kind, "path": str(paths[kind])})
    return {"written": written, "out_dir": str(d)}


def open_in_file_manager(out_id, rel=None, kind=None):
    d = output_dir(out_id)
    d.mkdir(parents=True, exist_ok=True)
    target = d
    if rel and kind:
        p = output_paths(d, rel).get(kind)
        if p is not None and p.exists():
            target = p
    system = platform.system()
    if system == "Darwin":
        cmd = ["open", "-R", str(target)] if target.is_file() else ["open", str(target)]
        subprocess.Popen(cmd)
    elif system == "Windows":
        if target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            os.startfile(str(target))  # noqa
    else:
        subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
    return {"opened": str(target)}
