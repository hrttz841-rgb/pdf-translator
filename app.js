// 第三方库优先使用仓库内 vendor/ 目录中的本地副本，离线可用；本地副本缺失时回退到 CDN。
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38";
const localUrl = (p) => new URL(p, document.baseURI).href;
async function loadPdfjs() {
  const sources = [
    {
      lib: localUrl("vendor/pdfjs/pdf.min.mjs"),
      root: localUrl("vendor/pdfjs/"),
    },
    { lib: PDFJS_CDN + "/pdf.min.mjs", root: PDFJS_CDN + "/" },
  ];
  for (const s of sources) {
    try {
      const mod = await import(s.lib);
      mod.GlobalWorkerOptions.workerSrc = s.root + "pdf.worker.min.mjs";
      return {
        lib: mod,
        cMapUrl: s.root === sources[0].root ? s.root + "cmaps/" : null,
        standardFontDataUrl:
          s.root === sources[0].root ? s.root + "standard_fonts/" : null,
      };
    } catch (e) {
      console.warn("pdf.js 加载失败：" + s.lib, e);
    }
  }
  throw new Error("无法加载 pdf.js（本地 vendor 目录缺失且无法访问 CDN）");
}
const PDFJS = await loadPdfjs();
const pdfjsLib = PDFJS.lib;
// 本地服务的会话令牌由服务端注入页面；所有 /api 请求都需携带，其他网站无法获取。
const SESSION_TOKEN =
  document.querySelector('meta[name="spt-token"]')?.content || "";
function backendBase() {
  // 通过启动脚本打开时页面与接口同源，直接使用当前地址，避免端口变化后指向旧端口
  if (location.protocol.startsWith("http")) return location.origin;
  return $("backend").value.replace(/\/$/, "");
}
function apiFetch(path, opt = {}) {
  const headers = { ...(opt.headers || {}), "X-SPT-Token": SESSION_TOKEN };
  return fetch(backendBase() + path, { ...opt, headers });
}
const localFileExists = async (p) => {
  try {
    return (await fetch(localUrl(p), { method: "HEAD" })).ok;
  } catch (e) {
    return false;
  }
};
async function tesseractOptions(langs) {
  // 本地文件齐全时使用本地路径；缺失的部分不传参数，沿用 Tesseract.js 默认的 CDN 地址
  const opts = {};
  if (await localFileExists("vendor/tesseract/worker.min.js"))
    opts.workerPath = localUrl("vendor/tesseract/worker.min.js");
  if (
    await localFileExists("vendor/tesseract/core/tesseract-core-lstm.wasm.js")
  )
    opts.corePath = localUrl("vendor/tesseract/core");
  const needed = String(langs || "eng")
    .split("+")
    .filter(Boolean);
  let localLang = needed.length > 0;
  for (const l of needed)
    if (!(await localFileExists(`vendor/tesseract/lang/${l}.traineddata.gz`)))
      localLang = false;
  if (localLang) opts.langPath = localUrl("vendor/tesseract/lang");
  return opts;
}
const $ = (id) => document.getElementById(id);
const state = {
  pdf: null,
  fileName: "",
  pages: [],
  current: 0,
  busy: false,
  headerFooter: new Set(),
  scale: 1.35,
  manuscript: null,
  importMode: null,
  // 图片与表格截图：{ "FIG:3-1": { kind, page, image, w, h, rows } }
  assets: {},
};
// 供自动化测试读取当前项目状态
window.SPT = { state };
const persistIds = [
  "footnoteNumbering",
  "concurrency",
  "backend",
  "provider",
  "apiBase",
  "chunkSize",
  "ocrThreshold",
  "ocrLang",
  "contextChars",
  "proofEnabled",
  "removeHeaders",
  "showBoxes",
  "trueFootnotes",
  "manuscriptBatchPages",
  "bilingualLayout",
  "sourceLang",
  "targetLang",
  "model",
  "layoutMode",
  "ocrMode",
  "style",
  "glossary",
  "customPrompt",
];
function log(s) {
  const t = new Date().toLocaleTimeString();
  $("log").textContent += `\n[${t}] ${s}`;
  $("log").scrollTop = $("log").scrollHeight;
}
function status(s) {
  $("status").textContent = s;
}
function progress(i, n, label) {
  const p = n ? Math.round((i / n) * 100) : 0;
  $("progressBar").style.width = p + "%";
  $("progressText").textContent = `${label} ${i}/${n} (${p}%)`;
}
const STEP_STAGE = {
  1: "parse",
  2: "parse",
  3: "clean",
  4: "translate",
  5: "proof",
  6: "reconstruct",
};
function markStep(n) {
  runner.stage = STEP_STAGE[n] || "";
  updatePipeline();
}
function esc(s = "") {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function saveSettings() {
  const o = {};
  for (const id of persistIds) {
    const e = $(id);
    o[id] = e.type === "checkbox" ? e.checked : e.value;
  }
  localStorage.setItem("scholarPdfV2", JSON.stringify(o));
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem("scholarPdfV2") || "{}");
    for (const [id, v] of Object.entries(o)) {
      if (!$(id)) continue;
      $(id).type === "checkbox" ? ($(id).checked = !!v) : ($(id).value = v);
    }
  } catch {}
}
function cleanText(t) {
  return (t || "")
    .replace(/[ \t]+(\[\^\d{1,3}\])/g, "$1")
    .replace(/(\[\^\d{1,3}\])(?=[A-Za-z\u00C0-\u024F"“(])/g, "$1 ")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function normalizeHF(s) {
  return s
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}# ]/gu, "")
    .trim();
}
// 只有用户手动编辑过编辑框时才把内容写回状态，避免程序更新（解析、清洗）后的新内容被旧的编辑框内容覆盖
let editorsDirty = false;
function syncEditors() {
  if (!state.pages.length || !editorsDirty) return;
  editorsDirty = false;
  const p = state.pages[state.current];
  const ns = $("sourceEditor").innerText.trim(),
    nt = $("targetEditor").innerText.trim();
  if (ns !== p.source || nt !== p.target) state.manuscript = null;
  p.source = ns;
  p.target = nt;
}
function updateMetrics() {
  updatePipeline();
  renderPageList();
}
function setButtonsForProject() {
  updateControls();
}
function importedPage(n, source = "", target = "") {
  return {
    n,
    raw: source,
    source: source || "",
    target: target || "",
    blocks: [],
    layout: "imported",
    ocr: false,
    parsed: true,
    translated: !!String(target).trim(),
    proofed: false,
    approved: false,
    charCount: (source || target || "").length,
    error: "",
    errorStage: "",
  };
}
function activateImportedProject(name, pages, kind, unit = "chunk") {
  if (!pages?.length) throw new Error("没有识别到可导入的译文内容");
  state.pdf = null;
  state.fileName = name || "已有译文";
  state.manuscript = null;
  state.assets = {};
  state.importMode = kind || "translated";
  state.current = 0;
  state.pages = pages.map((p, i) => {
    const pg = importedPage(
      Number(p.n) || i + 1,
      p.source || "",
      p.target || "",
    );
    for (const k of ["translated", "proofed", "approved"])
      if (k in p) pg[k] = !!p[k];
    if (p.error)
      Object.assign(pg, { error: p.error, errorStage: p.errorStage || "" });
    return pg;
  });
  state.cleaned = false;
  setDocument(
    state.fileName,
    state.pages.length,
    kind === "bilingual" ? "双语译文" : "译文",
    unit,
  );
  selectView("text");
  status(
    unit === "page"
      ? `已导入${kind === "bilingual" ? "双语" : "中文"}译文，共 ${state.pages.length} 页，可以直接进行书稿重建。`
      : `已导入${kind === "bilingual" ? "双语" : "中文"}译文。文件中没有分页信息，已按约一页的长度分为 ${state.pages.length} 个单元，可以直接进行书稿重建。`,
  );
  log(
    `导入已有${kind === "bilingual" ? "双语" : "译文"}文件，跳过 OCR 与翻译。`,
  );
  showPage(0);
  updateControls();
}
function htmlToImportedPages(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const sections = [...doc.querySelectorAll("section.page")];
  if (sections.length) {
    const pages = sections
      .map((sec, i) => {
        const grid = sec.querySelector(".grid");
        if (grid) {
          const arts = [...grid.querySelectorAll("article")];
          const body = (a) => {
            const c = a?.cloneNode(true);
            c?.querySelectorAll("h3,.pn").forEach((x) => x.remove());
            return (c?.innerText || "").trim();
          };
          return { n: i + 1, source: body(arts[0]), target: body(arts[1]) };
        }
        const art = sec.querySelector("article");
        const c = art?.cloneNode(true);
        c?.querySelectorAll("h3,.pn").forEach((x) => x.remove());
        return {
          n: i + 1,
          source: "",
          target: (c?.innerText || sec.innerText || "").trim(),
        };
      })
      .filter((p) => p.source || p.target);
    return {
      kind: pages.some((p) => p.source && p.target)
        ? "bilingual"
        : "translated",
      unit: "page",
      pages,
    };
  }
  const text = (doc.body?.innerText || "").trim();
  if (!text) throw new Error("HTML 中没有识别到正文");
  const chunks = [];
  let cur = "";
  for (const para of text
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    // 没有分页信息时每个单元约一页长，单元过长会让书稿重建超出模型单次输出长度
    if (cur && cur.length + para.length > 1800) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  if (cur) chunks.push(cur);
  return {
    kind: "translated",
    unit: "chunk",
    pages: chunks.map((t, i) => ({ n: i + 1, source: "", target: t })),
  };
}
async function importExisting(file) {
  if (!file) throw new Error("请先选择文件");
  const name = file.name || "已有译文";
  const ext = (name.split(".").pop() || "").toLowerCase();
  status("正在导入已有译文…");
  if (ext === "html" || ext === "htm") {
    const obj = htmlToImportedPages(await file.text());
    activateImportedProject(name, obj.pages, obj.kind, obj.unit);
    return;
  }
  if (ext === "json") {
    const obj = JSON.parse(await file.text());
    if (!Array.isArray(obj.pages))
      throw new Error("这不是可识别的翻译项目 JSON");
    if (obj.settings)
      for (const [id, v] of Object.entries(obj.settings)) {
        if ($(id))
          $(id).type === "checkbox" ? ($(id).checked = !!v) : ($(id).value = v);
      }
    activateImportedProject(
      obj.fileName || name,
      obj.pages.map((p, i) => ({
        n: p.n || i + 1,
        source: p.source || "",
        target: p.target || "",
        ...("translated" in p
          ? { translated: p.translated && !!(p.target || "").trim() }
          : {}),
        ...("proofed" in p ? { proofed: p.proofed } : {}),
        ...("approved" in p ? { approved: p.approved } : {}),
      })),
      obj.pages.some((p) => p.source && p.target) ? "bilingual" : "translated",
      "page",
    );
    if (obj.manuscript) state.manuscript = obj.manuscript;
    state.assets = obj.assets || {};
    return;
  }
  if (ext === "docx") {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < buf.length; i += step)
      bin += String.fromCharCode(...buf.subarray(i, i + step));
    const b64 = btoa(bin);
    const r = await apiFetch("/api/import-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64: b64, file_name: name }),
    });
    const obj = await r.json();
    if (!r.ok) throw new Error(obj.error || `HTTP ${r.status}`);
    activateImportedProject(name, obj.pages, obj.kind, obj.unit || "chunk");
    return;
  }
  throw new Error("暂不支持该文件格式");
}
async function loadPdf(file) {
  state.fileName = file.name;
  state.manuscript = null;
  state.importMode = null;
  state.assets = {};
  const buf = await file.arrayBuffer();
  state.pdf = await pdfjsLib.getDocument({
    data: buf,
    ...(PDFJS.cMapUrl ? { cMapUrl: PDFJS.cMapUrl, cMapPacked: true } : {}),
    ...(PDFJS.standardFontDataUrl
      ? { standardFontDataUrl: PDFJS.standardFontDataUrl }
      : {}),
  }).promise;
  state.pages = Array.from({ length: state.pdf.numPages }, (_, i) => ({
    n: i + 1,
    raw: "",
    source: "",
    target: "",
    blocks: [],
    layout: "unknown",
    ocr: false,
    parsed: false,
    translated: false,
    proofed: false,
    approved: false,
    charCount: 0,
    error: "",
    errorStage: "",
  }));
  state.cleaned = false;
  state.current = 0;
  setDocument(file.name, state.pdf.numPages, "PDF");
  selectView("page");
  updateControls();
  status(`${file.name} · ${state.pdf.numPages} 页`);
  log(`加载 ${file.name}，共 ${state.pdf.numPages} 页。`);
  await showPage(0);
}
// 同一画布上的渲染必须串行，否则 pdf.js 会报错（例如加载后立即点击解析、快速翻页时）
let renderQueue = Promise.resolve();
function renderPage(pageNo) {
  const job = renderQueue.then(() => renderPageNow(pageNo));
  renderQueue = job.catch(() => {});
  return job;
}
async function renderPageNow(pageNo) {
  const page = await state.pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale: state.scale });
  const c = $("pdfCanvas"),
    ctx = c.getContext("2d");
  c.width = viewport.width;
  c.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  $("overlay").style.width = c.clientWidth + "px";
  $("overlay").style.height = c.clientHeight + "px";
  drawBoxes(state.pages[pageNo - 1], page.getViewport({ scale: 1 }));
}
function drawBoxes(p, viewport) {
  const ov = $("overlay");
  ov.innerHTML = "";
  if (!$("showBoxes").checked || !p?.blocks?.length) return;
  const canvas = $("pdfCanvas");
  const sx = canvas.clientWidth / viewport.width,
    sy = canvas.clientHeight / viewport.height;
  for (const b of p.blocks) {
    const d = document.createElement("div");
    d.className = "bbox";
    d.style.left = b.x * sx + "px";
    const top = b.top ?? b.y + b.h,
      bottom = b.bottom ?? b.y;
    d.style.top = (viewport.height - top) * sy + "px";
    d.style.width = b.w * sx + "px";
    d.style.height = Math.max(8, (top - bottom) * sy) + "px";
    d.title = b.text.slice(0, 160);
    ov.appendChild(d);
  }
}
async function showPage(i) {
  if (!state.pages.length) return;
  syncEditors();
  state.current = Math.max(0, Math.min(i, state.pages.length - 1));
  const p = state.pages[state.current];
  $("sourceEditor").innerText = p.source || "";
  $("targetEditor").innerText = p.target || "";
  editorsDirty = false;
  $("pageInfo").textContent = `${p.n} / ${state.pages.length}`;
  let st = p.approved
    ? "已人工检查"
    : p.proofed
      ? "已校对"
      : p.translated
        ? "已有译文"
        : p.parsed
          ? "已解析"
          : "未处理";
  $("pageState").textContent = p.error ? "出错" : st;
  $("pageState").className = "pill " + pageStatusClass(p);
  $("pageError").hidden = !p.error;
  $("pageError").textContent = p.error || "";
  $("approveBtn").textContent = p.approved ? "取消检查标记" : "标记已检查";
  $("pageMeta").innerHTML =
    `<span class="chip">${p.layout === "imported" ? "导入文稿" : p.layout === "double" ? "双栏" : p.layout === "single" ? "单栏" : "未判断"}</span><span class="chip">${state.pdf ? (p.ocr ? "OCR" : "文本层") : "跳过 OCR/翻译"}</span><span class="chip">${p.charCount || 0} 字符</span>`;
  $("noPageImage").hidden = !!state.pdf;
  $("noPageImage").textContent =
    "导入的译文没有页面图像，可在“原文”或“逐段对照”中查看文字。";
  if (currentView === "pairs") renderPairs();
  updateMetrics();
  updateControls();
  if (state.pdf) {
    $("canvasWrap").style.display = "flex";
    await renderPage(p.n);
  } else {
    $("canvasWrap").style.display = "none";
    $("overlay").innerHTML = "";
  }
}
// 章节标题样式的行：不当作重复页眉删除，并单独成段
const HEADING_LIKE_RE =
  /^(chapter|part|section|book|appendix|第\s*[一二三四五六七八九十百零〇\d]+\s*[章节部篇卷])\s*([\dIVXLC一二三四五六七八九十]+)?\b/i;
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
const SUP_RE = /^(\d{1,3}|[*†‡§])$/;
// 把 pdf.js 文本项整理成行；字号明显偏小、基线抬高、紧跟在正文文字后的数字识别为注号，记作 [^n]
function groupLines(items, pageW) {
  const raw = [];
  for (const it of items) {
    const text = (it.str || "").trim();
    if (!text) continue;
    raw.push({
      x: it.transform?.[4] || 0,
      y: it.transform?.[5] || 0,
      h: Math.max(4, Math.abs(it.height || it.transform?.[3] || 10)),
      w: Math.max(1, it.width || 0),
      text,
    });
  }
  const bodyH =
    median(raw.filter((r) => r.text.length > 3).map((r) => r.h)) || 10;
  for (const r of raw) {
    if (!SUP_RE.test(r.text) || r.h > bodyH * 0.8) continue;
    // 找左侧紧邻的正常字号文字，基线比它高出约 0.15 到 0.75 个字高
    const host = raw.find(
      (o) =>
        o !== r &&
        o.h > r.h * 1.2 &&
        r.y - o.y > o.h * 0.12 &&
        r.y - o.y < o.h * 0.75 &&
        r.x >= o.x - 1 &&
        r.x <= o.x + o.w + o.h * 1.2,
    );
    if (host) {
      r.y = host.y;
      r.sup = true;
      r.text = `[^${r.text}]`;
    }
  }
  const rows = [];
  for (const it of raw) {
    let row = rows.find(
      (r) => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.35),
    );
    if (!row) {
      row = { y: it.y, h: it.h, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    const hs = r.items.filter((i) => !i.sup).map((i) => i.h);
    r.h = hs.length ? median(hs) : r.items[0].h;
  }
  rows.sort((a, b) => b.y - a.y);
  rows.bodyH = bodyH;
  return rows;
}
// 页面底部字号偏小、以编号开头的行识别为页下注，返回 { rows: 正文行, notes: [{n, text}] }
const NOTE_START_RE = /^(?:\[\^(\d{1,3})\]|(\d{1,3})(?:[.)．、]|\s))\s*/;
function splitFootnoteZone(rows, pageH) {
  const bodyH = rows.bodyH || 10;
  const isSmall = (r) => r.h <= bodyH * 0.9;
  const isPageNo = (r) =>
    /^\d{1,4}$/.test(
      r.items
        .map((i) => i.text)
        .join("")
        .trim(),
    ) && r.y < pageH * 0.1;
  let k = rows.length;
  while (
    k > 0 &&
    (isSmall(rows[k - 1]) || isPageNo(rows[k - 1])) &&
    rows[k - 1].y < pageH * 0.45
  )
    k--;
  const zone = rows.slice(k).filter((r) => !isPageNo(r));
  const text = (r) =>
    r.items
      .map((i) => i.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  if (!zone.length || !zone.some((r) => NOTE_START_RE.test(text(r))))
    return { rows, notes: [] };
  const notes = [];
  for (const r of zone) {
    const t = text(r),
      m = t.match(NOTE_START_RE);
    if (m) notes.push({ n: m[1] || m[2], text: t.slice(m[0].length) });
    else if (notes.length) notes[notes.length - 1].text += " " + t;
    else notes.push({ n: "+", text: t }); // 上一页注释的续行
  }
  const keep = new Set(zone);
  return { rows: rows.filter((r) => !keep.has(r) || isPageNo(r)), notes };
}
// ---------- 图片与表格：识别位置、截图保存、表格还原为行列 ----------
// 图片在文字流中记作独立一段 [[FIG:页-序号]]；表格记作
// [[TABLE:页-序号]] 加若干行“| 单元格 | 单元格 |”，以 [[/TABLE]] 结束，翻译时逐格翻译
const CAPTION_RE =
  /^(fig(ure)?\.?|table|tab\.|chart|map|plate|exhibit|图|表)\s*[\dIVXivx一二三四五六七八九十]/i;
const ASSET_RE = /\[\[(FIG|TABLE):([\w.-]+)\]\]/g;
// 表格正文是紧跟在开始记号后、以 | 开头的若干行；结束记号缺失时也能识别
const TABLE_BLOCK_RE =
  /\[\[TABLE:([\w.-]+)\]\][ \t]*((?:\n[ \t]*\|[^\n]*)*)(?:\n[ \t]*\[\[\/TABLE\]\])?/g;
function mulM(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function boxOf(m, x0, y0, x1, y1) {
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}
const boxW = (b) => b.x1 - b.x0,
  boxH = (b) => b.y1 - b.y0;
function boxNear(a, b, d = 0) {
  return (
    a.x0 - d <= b.x1 && b.x0 - d <= a.x1 && a.y0 - d <= b.y1 && b.y0 - d <= a.y1
  );
}
function boxUnion(a, b) {
  return {
    ...a,
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}
function boxPad(b, d) {
  return { x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
}
// 读取页面的绘图指令，得到图片和矢量路径在页面坐标中的范围
async function pageGraphics(page) {
  const O = pdfjsLib.OPS,
    ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [],
    images = [],
    paths = [];
  const fns = ol.fnArray,
    args = ol.argsArray;
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i],
      a = args[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mulM(ctm, a);
    else if (fn === O.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0]))
        ctm = mulM(ctm, Array.from(a[0]));
    } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (
      fn === O.paintImageXObject ||
      fn === O.paintInlineImageXObject ||
      fn === O.paintImageMaskXObject
    )
      images.push(boxOf(ctm, 0, 0, 1, 1));
    else if (fn === O.constructPath) {
      const next = fns[i + 1];
      if (next === O.clip || next === O.eoClip || next === O.endPath) continue;
      const mm = a?.[2];
      if (!mm || mm.length < 4 || ![...mm].slice(0, 4).every(Number.isFinite))
        continue;
      paths.push(boxOf(ctm, mm[0], mm[1], mm[2], mm[3]));
    }
  }
  return { images, paths };
}
function rowText(r) {
  return r.items
    .map(
      (it, j) =>
        it.text +
        (j < r.items.length - 1 &&
        (it.ocr || r.items[j + 1].x - (it.x + it.w) > Math.max(3, it.h * 0.25))
          ? " "
          : ""),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
function rowBox(r) {
  const x0 = Math.min(...r.items.map((i) => i.x)),
    x1 = Math.max(...r.items.map((i) => i.x + i.w));
  return { x0, x1, y0: r.y - r.h * 0.25, y1: r.y + r.h * 0.85 };
}
// 一行中相距较远的文字分成几段，表格的各列就是这样的段
function rowSegments(r) {
  const segs = [],
    gapMin = Math.max(r.h * 1.2, 7);
  let cur = null;
  for (const it of r.items) {
    if (cur && it.x - cur.x1 <= gapMin) {
      cur.items.push(it);
      cur.x1 = Math.max(cur.x1, it.x + it.w);
    } else {
      cur = { x0: it.x, x1: it.x + it.w, items: [it] };
      segs.push(cur);
    }
  }
  for (const s of segs) s.text = rowText(s);
  return segs;
}
function buildTable(region, pageW, layout) {
  const multi = region.filter((x) => x.segs.length >= 2);
  if (multi.length < 3) return null;
  const counts = {};
  for (const x of multi)
    counts[x.segs.length] = (counts[x.segs.length] || 0) + 1;
  const mode = +Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || b[0] - a[0],
  )[0][0];
  // 以分段数最常见的行确定各列的横向范围：各行同一列的文字会重叠，列与列之间留有空白
  const iv = multi
    .filter((x) => x.segs.length === mode)
    .flatMap((x) => x.segs.map((s) => [s.x0, s.x1]))
    .sort((a, b) => a[0] - b[0]);
  const bands = [];
  for (const [a, b] of iv) {
    const last = bands[bands.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else bands.push([a, b]);
  }
  const cols = bands.length;
  if (cols < 2) return null;
  const colW = Array.from({ length: cols }, () => []);
  const grid = region.map((x) => {
    const cells = Array(cols).fill("");
    for (const s of x.segs) {
      let best = 0,
        bestOv = -Infinity;
      bands.forEach(([a, b], k) => {
        const ov = Math.min(b, s.x1) - Math.max(a, s.x0);
        const score = ov > 0 ? ov : -Math.abs((a + b) / 2 - (s.x0 + s.x1) / 2);
        if (score > bestOv) ((bestOv = score), (best = k));
      });
      cells[best] = cells[best] ? cells[best] + " " + s.text : s.text;
      colW[best].push(s.x1 - s.x0);
    }
    return cells;
  });
  if (cols === 2) {
    // 两列时排除双栏正文、编号列表和目录页（标题加页码）
    if (layout === "double") return null;
    if (Math.max(...colW.map((a) => median(a))) > pageW * 0.3) return null;
    const first = grid.map((r) => r[0].trim()).filter(Boolean);
    if (
      first.length &&
      first.every((t) =>
        /^(\d{1,3}[.)、．]|[•·▪◦\-–—]|[a-z][.)]|\(\w{1,4}\)|[ivxlc]{1,5}[.)])$/i.test(
          t,
        ),
      )
    )
      return null;
    const second = grid.map((r) => r[1].trim()).filter(Boolean);
    if (second.length && second.every((t) => /^[\divxlc]{1,5}$/i.test(t)))
      return null;
  }
  if (
    grid.filter((r) => r.filter(Boolean).length >= 2).length <
    region.length * 0.6
  )
    return null;
  let bbox = rowBox(region[0].r);
  for (const x of region) bbox = boxUnion(bbox, rowBox(x.r));
  return { rows: region.map((x) => x.r), grid, bbox };
}
function detectTables(rows, pageW, layout) {
  const info = rows.map((r) => ({ r, segs: rowSegments(r) }));
  const isCand = (x) =>
    x.segs.length >= 2 &&
    x.segs.every((s) => s.x1 - s.x0 < pageW * 0.45) &&
    !CAPTION_RE.test(rowText(x.r)) &&
    !HEADING_LIKE_RE.test(rowText(x.r));
  const tables = [];
  let i = 0;
  while (i < info.length) {
    if (!isCand(info[i])) {
      i++;
      continue;
    }
    let last = i,
      j = i + 1;
    while (j < info.length) {
      const gap = info[last].r.y - info[j].r.y;
      if (gap > Math.max(info[last].r.h, info[j].r.h) * 3) break;
      if (isCand(info[j])) {
        last = j++;
        continue;
      }
      // 允许夹着一行较短的单格行，如分组小标题或换行的单元格
      const s = info[j].segs;
      if (
        s.length === 1 &&
        s[0].x1 - s[0].x0 < pageW * 0.3 &&
        j + 1 < info.length &&
        isCand(info[j + 1])
      ) {
        j++;
        continue;
      }
      break;
    }
    const t = buildTable(info.slice(i, last + 1), pageW, layout);
    if (t) tables.push(t);
    i = last + 1;
  }
  return tables;
}
function detectFigures(g, rows, pageW, pageH, tables) {
  const pageArea = pageW * pageH;
  const tboxes = tables.map((t) => boxPad(t.bbox, 14));
  const inTable = (b) =>
    tboxes.some(
      (t) => b.x0 >= t.x0 && b.x1 <= t.x1 && b.y0 >= t.y0 && b.y1 <= t.y1,
    );
  const regions = [];
  for (const b of g.images) {
    if (boxW(b) < 36 || boxH(b) < 30) continue;
    if (boxW(b) * boxH(b) > pageArea * 0.7) continue; // 扫描页整页图像
    if (inTable(b)) continue;
    regions.push({ ...b, raster: true });
  }
  // 矢量图：把相互靠近的路径聚成一组
  let clusters = g.paths
    .filter((b) => !(boxW(b) > pageW * 0.9 && boxH(b) > pageH * 0.9))
    .filter((b) => !inTable(b))
    .map((b) => ({
      ...b,
      n: 1,
      solid: boxW(b) > 2.5 && boxH(b) > 2.5 ? 1 : 0,
      hz: boxH(b) <= 2.5 ? 1 : 0,
      vt: boxW(b) <= 2.5 ? 1 : 0,
    }));
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < clusters.length && !merged; a++)
      for (let b = a + 1; b < clusters.length; b++)
        if (boxNear(clusters[a], clusters[b], 10)) {
          const A = clusters[a],
            B = clusters[b];
          clusters[a] = {
            ...boxUnion(A, B),
            n: A.n + B.n,
            solid: A.solid + B.solid,
            hz: A.hz + B.hz,
            vt: A.vt + B.vt,
          };
          clusters.splice(b, 1);
          merged = true;
          break;
        }
  }
  for (const c of clusters)
    if (
      c.n >= 4 &&
      boxW(c) >= 60 &&
      boxH(c) >= 40 &&
      (c.solid >= 1 || (c.hz >= 1 && c.vt >= 1))
    )
      regions.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, raster: false });
  for (const r of g.regions || []) regions.push(r);
  // 相互重叠的区域合并，例如图片和它的边框
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < regions.length && !merged; a++)
      for (let b = a + 1; b < regions.length; b++)
        if (boxNear(regions[a], regions[b], 8)) {
          regions[a] = {
            ...boxUnion(regions[a], regions[b]),
            raster: regions[a].raster || regions[b].raster,
            grow: regions[a].grow || regions[b].grow,
          };
          regions.splice(b, 1);
          merged = true;
          break;
        }
  }
  const out = [];
  const taken = new Set();
  for (const reg of regions) {
    const boxes = rows.map((r) => ({ r, b: rowBox(r), t: rowText(r) }));
    const inside = (x, box) => {
      const cx = (x.b.x0 + x.b.x1) / 2,
        cy = (x.b.y0 + x.b.y1) / 2;
      return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
    };
    let box = { x0: reg.x0, y0: reg.y0, x1: reg.x1, y1: reg.y1 };
    let absorbed = boxes.filter((x) => !taken.has(x.r) && inside(x, box));
    if (!reg.raster || reg.grow) {
      // 坐标轴刻度、图例等短文字在图形外侧不远处，一并归入图中
      for (let grew = true; grew;) {
        grew = false;
        for (const x of boxes) {
          if (taken.has(x.r) || absorbed.includes(x)) continue;
          if (x.t.length > 40 || CAPTION_RE.test(x.t)) continue;
          if (boxW(x.b) > Math.max(boxW(box), 60) * 0.9) continue;
          if (!boxNear(x.b, box, 16)) continue;
          absorbed.push(x);
          box = boxUnion(box, x.b);
          grew = true;
        }
      }
    }
    // 框里大多是成段文字的，是文本框，不当作图
    const longRows = absorbed.filter((x) => x.t.length > 60).length;
    if (longRows >= 3 || (absorbed.length && longRows > absorbed.length * 0.5))
      continue;
    if ((!reg.raster || reg.grow) && absorbed.length > 30) continue;
    absorbed.forEach((x) => taken.add(x.r));
    out.push({ ...box, raster: reg.raster, rows: absorbed.map((x) => x.r) });
  }
  return out;
}
// ---------- 扫描页：根据 OCR 结果和页面图像找出图片与表格 ----------
// 文字以外成片的深色区域视为插图；按 OCR 单词的位置还原表格的行列
function analyzeScannedPage(data, img, vp, pageNo) {
  const pageW = vp.width / vp.scale,
    pageH = vp.height / vp.scale;
  const toPdf = (b) => {
    const [ax, ay] = vp.convertToPdfPoint(b.x0, b.y0),
      [bx, by] = vp.convertToPdfPoint(b.x1, b.y1);
    return {
      x0: Math.min(ax, bx),
      y0: Math.min(ay, by),
      x1: Math.max(ax, bx),
      y1: Math.max(ay, by),
    };
  };
  const allWords = (data.words || []).filter((w) => w.text && w.text.trim());
  const isRule = (t) => /^[|_\-—–=~.·:;,'"`]+$/.test(t);
  // 以 OCR 的行为单位，基线相近的行（例如表格同一行的各个单元格）归为一行
  const rows = [],
    words = [];
  // 高度远小于正文行的“行”是表格线、下划线被误认成的文字
  const lineH = median(
    (data.lines || []).map((l) => l.bbox.y1 - l.bbox.y0).filter((h) => h > 0),
  );
  const thinLine = (ln) =>
    ln.bbox.y1 - ln.bbox.y0 < lineH * 0.55 && (ln.confidence ?? 0) < 60;
  for (const ln of data.lines || []) {
    if (thinLine(ln)) continue;
    // 置信度很低的“单词”多是表格线、污点被误认成的文字
    const ws = (ln.words || []).filter(
      (w) =>
        w.text && w.text.trim() && !isRule(w.text.trim()) && w.confidence >= 20,
    );
    if (!ws.length) continue;
    const lb = toPdf(ln.bbox),
      bl =
        ln.baseline && Number.isFinite(ln.baseline.y0)
          ? vp.convertToPdfPoint(0, (ln.baseline.y0 + ln.baseline.y1) / 2)[1]
          : lb.y0 + (lb.y1 - lb.y0) * 0.2,
      h = (lb.y1 - lb.y0) * 0.8;
    let row = rows.find((r) => Math.abs(r.y - bl) <= Math.min(h, r.h) * 0.35);
    if (!row) {
      row = { y: bl, h, items: [], words: [] };
      rows.push(row);
    }
    for (const w of ws) {
      const b = toPdf(w.bbox),
        word = { ...b, text: w.text.trim(), conf: w.confidence, src: w };
      words.push(word);
      row.items.push({
        x: b.x0,
        w: b.x1 - b.x0,
        h,
        text: word.text,
        ocr: true,
      });
      row.words.push(word);
    }
  }
  for (const r of rows) {
    const order = r.items
      .map((it, k) => k)
      .sort((a, b) => r.items[a].x - r.items[b].x);
    r.items = order.map((k) => r.items[k]);
    r.words = order.map((k) => r.words[k]);
  }
  rows.sort((a, b) => b.y - a.y);
  rows.bodyH = median(rows.map((r) => r.h)) || 10;
  let tables = detectTables(rows, pageW, "single");

  // 深色像素网格：每格 4 像素，去掉识别可信的文字后，连成片的部分是插图候选
  const cell = 4,
    W = img.width,
    H = img.height,
    gw = Math.ceil(W / cell),
    gh = Math.ceil(H / cell);
  const ink = new Uint8Array(gw * gh);
  const px = img.data;
  // 纸张底色：抽样亮度的较高分位数；明显比纸张暗的像素算作着墨（包括照片的浅色背景）
  const lum = (i) => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  const sample = [];
  for (let i = 0; i < px.length; i += 4 * 97) sample.push(lum(i));
  sample.sort((a, b) => a - b);
  const paper = sample[Math.floor(sample.length * 0.9)] || 255,
    darkCut = Math.min(200, paper - 30);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let dark = 0,
        n = 0;
      for (let y = gy * cell; y < Math.min(H, gy * cell + cell); y++)
        for (let x = gx * cell; x < Math.min(W, gx * cell + cell); x++) {
          const i = (y * W + x) * 4;
          if (lum(i) < darkCut) dark++;
          n++;
        }
      if (dark / n > 0.08) ink[gy * gw + gx] = 1;
    }
  // 去掉文字之前保留一份，用来判断表格线
  const rawInk = ink.slice();
  for (const w of allWords) {
    if (w.confidence < 55) continue;
    const b = w.bbox;
    for (
      let gy = Math.max(0, Math.floor(b.y0 / cell) - 1);
      gy <= Math.min(gh - 1, Math.ceil(b.y1 / cell));
      gy++
    )
      for (
        let gx = Math.max(0, Math.floor(b.x0 / cell) - 1);
        gx <= Math.min(gw - 1, Math.ceil(b.x1 / cell));
        gx++
      )
        ink[gy * gw + gx] = 0;
  }
  const seen = new Uint8Array(gw * gh),
    comps = [],
    R = 2;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let count = 0,
      minX = gw,
      minY = gh,
      maxX = 0,
      maxY = 0;
    while (stack.length) {
      const c = stack.pop(),
        cx = c % gw,
        cy = (c / gw) | 0;
      count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const nx = cx + dx,
            ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const k = ny * gw + nx;
          if (ink[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
    }
    comps.push({
      count,
      x0: minX * cell,
      y0: minY * cell,
      x1: (maxX + 1) * cell,
      y1: (maxY + 1) * cell,
    });
  }
  const edge = 0.02;
  // 带完整表格线（横线三条以上、竖线两条以上）的区域是表格，以表格线围成的范围为准
  const lineCounts = (c) => {
    const x0 = c.x0 / cell,
      x1 = c.x1 / cell,
      y0 = c.y0 / cell,
      y1 = c.y1 / cell;
    const runs = (n, full) => {
      let lines = 0,
        prev = false;
      for (let k = 0; k < n; k++) {
        const on = full(k);
        if (on && !prev) lines++;
        prev = on;
      }
      return lines;
    };
    // 扫描页常有轻微倾斜，一条线可能跨过相邻几格，所以按 3 格宽的条带统计
    const T = 3;
    const hl = runs(y1 - y0, (k) => {
      let n = 0;
      for (let x = x0; x < x1; x++) {
        let on = 0;
        for (let d = 0; d < T && y0 + k + d < y1; d++)
          on |= rawInk[(y0 + k + d) * gw + x];
        n += on;
      }
      return n >= (x1 - x0) * 0.8;
    });
    const vl = runs(x1 - x0, (k) => {
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let on = 0;
        for (let d = 0; d < T && x0 + k + d < x1; d++)
          on |= rawInk[y * gw + x0 + k + d];
        n += on;
      }
      return n >= (y1 - y0) * 0.8;
    });
    return { hl, vl };
  };
  for (const c of comps) {
    const b = toPdf(c);
    if (c.count < 40 || boxW(b) < 80 || boxH(b) < 30) continue;
    const { hl, vl } = lineCounts(c);
    // 图表外框只有上下两条横线；表格至少还有表头下的一条
    if (hl < 3 || vl < 2) continue;
    tables = tables.filter((t) => !boxNear(t.bbox, b));
    const inRows = rows.filter((r) => {
      const rb = rowBox(r),
        cx = (rb.x0 + rb.x1) / 2,
        cy = (rb.y0 + rb.y1) / 2;
      return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
    });
    if (inRows.length < 2) continue;
    const t = buildTable(
      inRows.map((r) => ({ r, segs: rowSegments(r) })),
      pageW,
      "single",
    ) || { rows: inRows, grid: [], bbox: b };
    t.bbox = boxUnion(t.bbox, b);
    tables.push(t);
  }
  // 识别质量差的表格（表格线干扰、字迹模糊）不还原行列，导出时使用原表截图
  for (const t of tables) {
    const ws = t.rows.flatMap((r) => r.words);
    const conf = ws.length
      ? ws.reduce((sum, w) => sum + w.conf, 0) / ws.length
      : 0;
    const junk = ws.filter((w) => /[\[\]{}|]/.test(w.text)).length;
    if (conf < 70 || junk > ws.length * 0.1) t.grid = [];
  }
  tables.sort((a, b) => b.bbox.y1 - a.bbox.y1);
  const tableRows = new Set(tables.flatMap((t) => t.rows));
  // 表格上下的横线也截进表格图中
  for (const t of tables)
    for (const c of comps) {
      const b = toPdf(c);
      if (
        boxH(b) < 6 &&
        boxW(b) > boxW(t.bbox) * 0.5 &&
        b.x0 < t.bbox.x1 &&
        b.x1 > t.bbox.x0 &&
        b.y0 >= t.bbox.y0 - 16 &&
        b.y1 <= t.bbox.y1 + 16
      )
        t.bbox = boxUnion(t.bbox, b);
    }
  const tboxes = tables.map((t) => boxPad(t.bbox, 14));
  const regions = [];
  for (const c of comps) {
    if (c.count < 80) continue;
    // 扫描时留下的页边阴影、装订线
    if (
      c.x0 < W * edge ||
      c.y0 < H * edge ||
      c.x1 > W * (1 - edge) ||
      c.y1 > H * (1 - edge)
    )
      continue;
    const b = toPdf(c);
    if (boxW(b) < 60 || boxH(b) < 40) continue;
    if (boxW(b) / boxH(b) > 12 || boxH(b) / boxW(b) > 12) continue;
    if (
      tboxes.some(
        (t) => b.x0 >= t.x0 && b.x1 <= t.x1 && b.y0 >= t.y0 && b.y1 <= t.y1,
      )
    )
      continue;
    if (boxW(b) * boxH(b) > pageW * pageH * 0.8) continue;
    // 大部分面积被识别出的文字占据的，是印刷质量差的正文，不当作图
    const covered = words
      .filter((w) => boxNear(w, b))
      .reduce(
        (s, w) =>
          s +
          Math.max(0, Math.min(w.x1, b.x1) - Math.max(w.x0, b.x0)) *
            Math.max(0, Math.min(w.y1, b.y1) - Math.max(w.y0, b.y0)),
        0,
      );
    if (covered > boxW(b) * boxH(b) * 0.45) continue;
    regions.push({ ...b, raster: true, grow: true });
  }
  // 图形旁边的零散小块（坐标轴刻度数字、图例）一并归入图中
  for (const reg of regions)
    for (let grew = true; grew;) {
      grew = false;
      for (const c of comps) {
        if (c.count < 3 || c.used) continue;
        const b = toPdf(c);
        if (boxW(b) > 80 || boxH(b) > 40) continue;
        if (!boxNear(b, reg, 14)) continue;
        if (
          b.x0 >= reg.x0 &&
          b.x1 <= reg.x1 &&
          b.y0 >= reg.y0 &&
          b.y1 <= reg.y1
        )
          continue;
        Object.assign(reg, boxUnion(reg, b));
        c.used = true;
        grew = true;
      }
    }
  const figures = detectFigures(
    { images: [], paths: [], regions },
    rows.filter((r) => !tableRows.has(r)),
    pageW,
    pageH,
    tables,
  );
  // 被表格或插图占用的单词（OCR 结果中同一单词在不同层级是不同对象，按位置对应）
  const wkey = (w) => `${w.bbox.x0},${w.bbox.y0},${w.bbox.x1},${w.bbox.y1}`;
  const owner = new Map();
  tables.forEach((t, k) => {
    t.id = `${pageNo}-${k + 1}`;
    for (const r of t.rows) for (const w of r.words) owner.set(wkey(w.src), t);
  });
  figures.forEach((f, k) => {
    f.id = `${pageNo}-${k + 1}`;
    for (const r of f.rows) for (const w of r.words) owner.set(wkey(w.src), f);
  });
  const marker = (reg) =>
    tables.includes(reg) ? tableToText(reg.id, reg.grid) : `[[FIG:${reg.id}]]`;
  const regionBox = (reg) => (tables.includes(reg) ? reg.bbox : reg);
  // 按 OCR 的阅读顺序重组文字：区域内的行去掉，在区域开始处放入图表记号
  const lines = [];
  for (const blk of data.blocks || [])
    for (const para of blk.paragraphs || []) {
      para.lines.forEach((ln, i) => lines.push({ ln, para, first: i === 0 }));
    }
  const pending = new Set([...tables, ...figures]);
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur.join("\n"));
    cur = [];
  };
  let prevBox = null;
  for (const { ln, first } of lines) {
    if (first) flush();
    if (thinLine(ln)) continue;
    // 行距明显变大或图题、表题所在的行，另起一段
    const nb = toPdf(ln.bbox);
    if (
      prevBox &&
      (prevBox.y0 - nb.y1 > (nb.y1 - nb.y0) * 0.9 ||
        CAPTION_RE.test((ln.text || "").trim()))
    )
      flush();
    prevBox = nb;
    const ws = (ln.words || []).filter((w) => w.text && w.text.trim());
    const regs = ws.map((w) => owner.get(wkey(w))).filter(Boolean);
    const lb = toPdf(ln.bbox),
      cx = (lb.x0 + lb.x1) / 2,
      cy = (lb.y0 + lb.y1) / 2;
    const within = (rb) =>
      cx >= rb.x0 - 2 && cx <= rb.x1 + 2 && cy >= rb.y0 - 2 && cy <= rb.y1 + 2;
    // 本行之前应当出现的区域：本行已经进入区域，或区域在本行上方且水平方向有重叠
    for (const reg of [...pending]) {
      const rb = regionBox(reg);
      const inside = regs.includes(reg) || within(rb);
      const above = rb.y0 >= lb.y1 - 2 && rb.x0 < lb.x1 && rb.x1 > lb.x0;
      if (inside || above) {
        flush();
        out.push(marker(reg));
        pending.delete(reg);
      }
    }
    if (ws.length && regs.length >= ws.length * 0.5) continue;
    if ([...tables, ...figures].some((reg) => within(regionBox(reg)))) continue;
    const t = (ln.text || "").trim();
    if (t) cur.push(t);
    if (CAPTION_RE.test(t)) flush();
  }
  flush();
  for (const reg of pending) out.push(marker(reg));
  const assets = [
    ...tables.map((t) => ({
      id: `TABLE:${t.id}`,
      kind: "table",
      bbox: t.bbox,
      rows: t.grid,
    })),
    ...figures.map((f) => ({
      id: `FIG:${f.id}`,
      kind: "figure",
      bbox: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 },
      raster: true,
    })),
  ];
  return { text: out.join("\n\n"), assets };
}
function tableToText(id, grid) {
  if (!grid.length) return `[[TABLE:${id}]]\n[[/TABLE]]`;
  return (
    `[[TABLE:${id}]]\n` +
    grid
      .map((r) => "| " + r.map((c) => c.replace(/\|/g, "/")).join(" | ") + " |")
      .join("\n") +
    "\n[[/TABLE]]"
  );
}
function parseTableLines(body) {
  return (body || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}
// 从译文中取出表格，换成单行占位，返回 { text, tables: {id: 行列} }
function extractTables(text) {
  const tables = {};
  const out = (text || "").replace(TABLE_BLOCK_RE, (all, id, body) => {
    tables[id] = parseTableLines(body);
    return `[[TABLE:${id}]]`;
  });
  return { text: out, tables };
}
// 在页面渲染图上截取图片和表格区域
async function cropRegions(idx, list) {
  const page = await state.pdf.getPage(idx + 1);
  const vp = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const out = {};
  for (const a of list) {
    const pad = a.kind === "table" ? 1.5 : 4,
      b = boxPad(a.bbox, pad);
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle([
      b.x0,
      b.y0,
      b.x1,
      b.y1,
    ]);
    const sx = Math.max(0, Math.min(x1, x2)),
      sy = Math.max(0, Math.min(y1, y2)),
      ex = Math.min(canvas.width, Math.max(x1, x2)),
      ey = Math.min(canvas.height, Math.max(y1, y2));
    const w = ex - sx,
      h = ey - sy;
    if (w < 4 || h < 4) continue;
    const k = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const cx = c.getContext("2d");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(canvas, sx, sy, w, h, 0, 0, c.width, c.height);
    out[a.id] = {
      image: c.toDataURL(a.raster ? "image/jpeg" : "image/png", 0.88),
      w: Math.round(boxW(b) * 10) / 10,
      h: Math.round(boxH(b) * 10) / 10,
    };
    c.width = c.height = 0;
  }
  canvas.width = canvas.height = 0;
  return out;
}
function detectColumns(rows, pageW) {
  if ($("layoutMode").value === "single") return "single";
  if ($("layoutMode").value === "double") return "double";
  const mid = pageW / 2,
    gap = pageW * 0.055;
  let left = 0,
    right = 0,
    cross = 0;
  // 左右两栏基线对齐时，两栏的文字会落在同一行里，所以按行内的分段判断
  for (const r of rows) {
    const segs = rowSegments(r);
    if (segs.some((s) => s.x0 < mid - gap * 0.5 && s.x1 > mid + gap * 0.5)) {
      cross++;
      continue;
    }
    if (segs.some((s) => s.x1 < mid)) left++;
    if (segs.some((s) => s.x0 > mid)) right++;
  }
  return left > 4 && right > 4 && cross < Math.max(5, (left + right) * 0.35)
    ? "double"
    : "single";
}
function rowsToBlocks(rows, pageW, pageH, layout) {
  const blocks = [];
  const makeText = (r) => (r.special ? "" : rowText(r));
  let ordered = rows;
  if (layout === "double") {
    const mid = pageW / 2;
    const spanning = [],
      left = [],
      right = [];
    for (const r of rows) {
      if (r.special) {
        const c = (r.box.x0 + r.box.x1) / 2;
        (r.box.x0 < mid - 20 && r.box.x1 > mid + 20
          ? spanning
          : c < mid
            ? left
            : right
        ).push(r);
        continue;
      }
      const segs = rowSegments(r);
      if (segs.some((s) => s.x0 < mid && s.x1 > mid)) {
        spanning.push(r);
        continue;
      }
      // 同一行里分属左右两栏的文字拆开
      const li = r.items.filter((i) => i.x + i.w / 2 < mid),
        ri = r.items.filter((i) => i.x + i.w / 2 >= mid);
      if (li.length) left.push({ ...r, items: li });
      if (ri.length) right.push({ ...r, items: ri });
    }
    const topSpan = spanning.filter((r) => r.y > pageH * 0.72),
      bottomSpan = spanning.filter((r) => r.y <= pageH * 0.72);
    ordered = [...topSpan, ...left, ...right, ...bottomSpan];
  }
  let current = null,
    prevRight = null,
    prevH = null;
  // 本页正文行的右边界：没写到右边界附近就结束的行，视为段落结尾
  const rights = ordered.map((r) => Math.max(...r.items.map((i) => i.x + i.w)));
  const colRight =
    layout === "double"
      ? null
      : median(rights.filter((x, k) => makeText(ordered[k]).length > 20)) ||
        null;
  for (const r of ordered) {
    if (r.special) {
      // 图片和表格单独成段，不与前后文字合并
      const b = r.box;
      blocks.push({
        text: r.special,
        special: true,
        x: b.x0,
        y: b.y0,
        w: b.x1 - b.x0,
        h: b.y1 - b.y0,
        top: b.y1,
        bottom: b.y0,
      });
      current = null;
      prevRight = null;
      prevH = null;
      continue;
    }
    const text = makeText(r);
    if (!text) continue;
    const minX = Math.min(...r.items.map((i) => i.x)),
      maxX = Math.max(...r.items.map((i) => i.x + i.w)),
      h = Math.max(...r.items.map((i) => i.h));
    // top/bottom 为 PDF 坐标中文本块的上下边缘（y 是基线），用于在页面上准确绘制文本块
    const line = {
      text,
      x: minX,
      y: r.y,
      w: maxX - minX,
      h,
      top: r.y + h * 0.85,
      bottom: r.y - h * 0.25,
    };
    const gap = current ? Math.abs(current.lastY - r.y) : 999;
    const sameColumn = current && Math.abs(current.x - line.x) < pageW * 0.12;
    const shortPrev =
      colRight && prevRight !== null && prevRight < colRight - pageW * 0.12;
    const sizeChange = prevH && Math.abs(h - prevH) > prevH * 0.12;
    const enumerated =
      /^(\d{1,3}[.)．]|[•·▪])\s/.test(text) || HEADING_LIKE_RE.test(text);
    prevRight = maxX;
    prevH = h;
    if (
      current &&
      sameColumn &&
      gap < Math.max(18, h * 1.7) &&
      !shortPrev &&
      !sizeChange &&
      !enumerated
    ) {
      current.text += (current.text.endsWith("-") ? "\n" : " ") + text;
      current.w = Math.max(current.w, line.w);
      current.h += gap || h;
      current.lastY = r.y;
      current.bottom = Math.min(current.bottom, r.y - h * 0.25);
      current.x = Math.min(current.x, line.x);
    } else {
      current = { ...line, lastY: r.y };
      blocks.push(current);
    }
  }
  return blocks.map((b, i) => ({
    ...b,
    id: `B${String(i + 1).padStart(2, "0")}`,
    text: b.special ? b.text : cleanText(b.text),
  }));
}
async function extractStructured(idx) {
  const page = await state.pdf.getPage(idx + 1),
    vp = page.getViewport({ scale: 1 }),
    tc = await page.getTextContent();
  const all = groupLines(tc.items, vp.width),
    { rows, notes } = splitFootnoteZone(all, vp.height);
  rows.bodyH = all.bodyH;
  const layout = detectColumns(rows, vp.width);
  // 表格和图片：从文字流中取出所在区域的文字，换成独立的段落
  let graphics = { images: [], paths: [] };
  try {
    graphics = await pageGraphics(page);
  } catch (e) {}
  const tables = detectTables(rows, vp.width, layout);
  // 表格上下的横线（三线表的顶线、底线）也截进表格图中
  for (const t of tables)
    for (const pth of graphics.paths)
      if (
        pth.x0 < t.bbox.x1 &&
        pth.x1 > t.bbox.x0 &&
        pth.y0 >= t.bbox.y0 - 16 &&
        pth.y1 <= t.bbox.y1 + 16 &&
        boxW(pth) < vp.width * 0.95
      )
        t.bbox = boxUnion(t.bbox, pth);
  const tableRows = new Set(tables.flatMap((t) => t.rows));
  const figures = detectFigures(
    graphics,
    rows.filter((r) => !tableRows.has(r)),
    vp.width,
    vp.height,
    tables,
  );
  const figRows = new Set(figures.flatMap((f) => f.rows));
  const n = idx + 1,
    assets = [],
    special = [];
  const specialRow = (box, text) => ({
    y: box.y1,
    h: 10,
    box,
    special: text,
    items: [{ x: box.x0, w: box.x1 - box.x0, h: 10, text }],
  });
  tables.forEach((t, k) => {
    const id = `${n}-${k + 1}`;
    assets.push({
      id: `TABLE:${id}`,
      kind: "table",
      bbox: t.bbox,
      rows: t.grid,
    });
    special.push(specialRow(t.bbox, tableToText(id, t.grid)));
  });
  figures.forEach((f, k) => {
    const id = `${n}-${k + 1}`,
      bbox = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
    assets.push({ id: `FIG:${id}`, kind: "figure", bbox, raster: f.raster });
    special.push(specialRow(bbox, `[[FIG:${id}]]`));
  });
  const flow = [
    ...rows.filter((r) => !tableRows.has(r) && !figRows.has(r)),
    ...special,
  ].sort((a, b) => b.y - a.y);
  const blocks = rowsToBlocks(flow, vp.width, vp.height, layout);
  // 页下注以 [^n]: 开头的独立段落放在本页正文之后，续行记作 [^+]:
  const noteText = notes
    .map((n) => `[^${n.n}]: ${n.text.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");
  return {
    layout,
    blocks,
    notes,
    assets,
    text: cleanText(
      blocks.map((b) => b.text).join("\n\n") +
        (noteText ? "\n\n" + noteText : ""),
    ),
    width: vp.width,
    height: vp.height,
  };
}
async function parsePage(idx) {
  markStep(1);
  const mode = $("ocrMode").value,
    threshold = +$("ocrThreshold").value || 80;
  let s =
    mode === "always"
      ? { layout: "unknown", blocks: [], text: "" }
      : await extractStructured(idx);
  let useOCR =
    mode === "always" || (mode === "auto" && s.text.length < threshold);
  if (useOCR) {
    markStep(2);
    status(`OCR 第 ${idx + 1} 页…`);
    const ocrLang = $("ocrLang").value;
    // 在独立画布上以约 144 dpi 渲染页面，供 OCR 和图表识别使用（不受翻页影响）
    const ocrPage = await state.pdf.getPage(idx + 1),
      ocrVp = ocrPage.getViewport({ scale: 2 }),
      canvas = document.createElement("canvas");
    canvas.width = Math.ceil(ocrVp.width);
    canvas.height = Math.ceil(ocrVp.height);
    const octx = canvas.getContext("2d");
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, canvas.width, canvas.height);
    await ocrPage.render({ canvasContext: octx, viewport: ocrVp }).promise;
    const pageImage = octx.getImageData(0, 0, canvas.width, canvas.height),
      pageUrl = canvas.toDataURL("image/png");
    canvas.width = canvas.height = 0;
    const result = await Tesseract.recognize(pageUrl, ocrLang, {
      ...(await tesseractOptions(ocrLang)),
      logger: (m) => {
        if (m.status === "recognizing text")
          progress(
            Math.round((m.progress || 0) * 100),
            100,
            `OCR 第 ${idx + 1} 页`,
          );
      },
    });
    let scan = null;
    try {
      if (result.data.blocks?.length)
        scan = analyzeScannedPage(result.data, pageImage, ocrVp, idx + 1);
    } catch (e) {
      log(`第 ${idx + 1} 页图表识别失败：${e.message}`);
    }
    s = {
      layout: "ocr",
      blocks: [],
      text: cleanText(scan ? scan.text : result.data.text),
      assets: scan?.assets || [],
    };
    state.pages[idx].ocr = true;
    log(`第 ${idx + 1} 页启用 OCR，${s.text.length} 字符。`);
  } else
    log(
      `第 ${idx + 1} 页读取文本层，识别为${s.layout === "double" ? "双栏" : "单栏"}。`,
    );
  // 重新解析时先清掉这一页原有的图表
  for (const k of Object.keys(state.assets))
    if (state.assets[k].page === idx + 1) delete state.assets[k];
  if (s.assets?.length) {
    try {
      const crops = await cropRegions(idx, s.assets);
      for (const a of s.assets)
        if (crops[a.id])
          state.assets[a.id] = {
            kind: a.kind,
            page: idx + 1,
            bbox: a.bbox,
            ...crops[a.id],
            ...(a.rows ? { rows: a.rows } : {}),
          };
      const nf = s.assets.filter((a) => a.kind === "figure").length,
        nt = s.assets.length - nf;
      log(
        `第 ${idx + 1} 页识别到${nf ? ` ${nf} 幅图` : ""}${nf && nt ? "、" : ""}${nt ? ` ${nt} 个表格` : ""}。`,
      );
    } catch (e) {
      log(`第 ${idx + 1} 页图表截图失败：${e.message}`);
    }
  }
  Object.assign(state.pages[idx], {
    raw: s.text,
    source: s.text,
    blocks: s.blocks || [],
    layout: s.layout === "ocr" ? "unknown" : s.layout,
    parsed: true,
    charCount: s.text.length,
  });
  if (idx === state.current) await showPage(idx);
  return s.text;
}
function headerFooterCandidates() {
  const counts = new Map();
  for (const p of state.pages) {
    if (!p.raw) continue;
    const lines = p.raw
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean);
    // 同一页只计一次，避免短页面的首尾两行重叠计数，被误判为跨页重复的页眉页脚
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
    for (const s of edge) {
      const n = normalizeHF(s);
      // 章节标题和页下注（如多页都有的“同上”）不算重复页眉
      if (
        n.length < 3 ||
        n.length > 140 ||
        HEADING_LIKE_RE.test(s.trim()) ||
        /^(\[\^|\||\[\[)/.test(s.trim())
      )
        continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const need = Math.max(2, Math.ceil(state.pages.length * 0.35));
  if (state.pages.length < 3) {
    state.headerFooter = new Set();
    return;
  }
  state.headerFooter = new Set(
    [...counts].filter(([, c]) => c >= need).map(([s]) => s),
  );
  log(`检测到 ${state.headerFooter.size} 个重复页眉/页脚模式。`);
}
// 多页同一位置、同样大小的图片是页眉标志或装饰，不作为插图
function dropRepeatedFigures() {
  const sig = (a) =>
    a.bbox
      ? [a.bbox.x0, a.bbox.y0, a.bbox.x1, a.bbox.y1]
          .map((v) => Math.round(v / 4))
          .join(",")
      : "";
  const count = new Map();
  for (const a of Object.values(state.assets))
    if (a.kind === "figure" && a.bbox)
      count.set(sig(a), (count.get(sig(a)) || 0) + 1);
  const drop = Object.keys(state.assets).filter((id) => {
    const a = state.assets[id];
    return a.kind === "figure" && a.bbox && count.get(sig(a)) >= 3;
  });
  if (!drop.length) return;
  const ids = new Set(drop.map((id) => id.slice(4)));
  for (const id of drop) delete state.assets[id];
  const strip = (t) =>
    (t || "")
      .split("\n")
      .filter((l) => {
        const m = l.trim().match(/^\[\[FIG:([\w.-]+)\]\]$/);
        return !(m && ids.has(m[1]));
      })
      .join("\n");
  for (const p of state.pages) {
    p.raw = strip(p.raw);
    p.source = strip(p.source);
  }
  log(`${drop.length} 处在多页重复出现的图片判断为页眉标志或装饰，已去掉。`);
}
function applyCleanup() {
  markStep(3);
  if ($("removeHeaders").checked) {
    headerFooterCandidates();
    dropRepeatedFigures();
  }
  for (const p of state.pages) {
    // 按单行拆分并保留空行，这样段落之间的空行（段落边界）不会在清洗中丢失
    let lines = (p.raw || p.source || "").split("\n");
    if ($("removeHeaders").checked)
      lines = lines.filter((s) => {
        if (!s.trim() || /^\s*(\||\[\[)/.test(s)) return true;
        const n = normalizeHF(s);
        return !state.headerFooter.has(n) && !/^\s*\d{1,4}\s*$/.test(s);
      });
    p.source = cleanText(lines.join("\n"));
    p.charCount = p.source.length;
  }
  state.cleaned = true;
  updatePipeline();
  log("完成断词、空行与重复页眉页脚清理。");
}
function splitChunks(text, maxLen) {
  const paras = text
      .split(/\n\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean),
    out = [];
  let cur = "";
  for (const p of paras) {
    if (p.length > maxLen && !p.startsWith("[[TABLE:")) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += maxLen)
        out.push(p.slice(i, i + maxLen));
      continue;
    }
    if ((cur ? cur.length + 2 : 0) + p.length > maxLen && cur) {
      out.push(cur);
      cur = p;
    } else cur += (cur ? "\n\n" : "") + p;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}
const PROVIDER_PRESETS = {
  deepseek: {
    base: "https://api.deepseek.com",
    model: "deepseek-chat",
    help: "DeepSeek：deepseek-chat / deepseek-reasoner。",
  },
  openai: {
    base: "https://api.openai.com/v1",
    model: "gpt-5",
    help: "OpenAI：模型 ID 可自行填写。",
  },
  anthropic: {
    base: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    help: "Anthropic Claude：使用官方 Messages API。",
  },
  gemini: {
    base: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
    help: "Google Gemini：使用官方 generateContent API。",
  },
  qwen: {
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    help: "Alibaba Qwen：通过 DashScope OpenAI-compatible 接口。",
  },
  kimi: {
    base: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-32k",
    help: "Moonshot Kimi：通过 OpenAI-compatible 接口；模型 ID 可修改。",
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    help: "OpenRouter：可填写任意 OpenRouter 模型 ID。",
  },
  custom: {
    base: "",
    model: "",
    help: "自定义：填写兼容 OpenAI 接口的 API 地址与模型 ID。",
  },
};
function providerName() {
  return $("provider").value || "deepseek";
}
function syncProviderUI() {
  const p = providerName(),
    x = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.custom;
  $("providerHelp").textContent = x.help;
  updateEngineCard();
}
function applyProviderPreset(p) {
  const x = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.custom;
  $("provider").value = p;
  $("apiBase").value = x.base;
  $("model").value = x.model;
  $("providerHelp").textContent = x.help;
  updateEngineCard();
  refreshKeyStatus();
}
async function keyRequest(path, payload = {}) {
  const provider = providerName();
  const isStatus = path.endsWith("key-status");
  const url =
    path + (isStatus ? `?provider=${encodeURIComponent(provider)}` : "");
  const body = { provider, ...payload };
  const opt = isStatus
    ? {}
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
  const r = await apiFetch(url, opt);
  let data = {};
  try {
    data = await r.json();
  } catch (e) {}
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function refreshKeyStatus() {
  try {
    const x = await keyRequest("/api/key-status");
    const label =
      $("provider").selectedOptions[0]?.textContent || providerName();
    $("keyStatus").textContent = x.saved
      ? `${label} Key 已保存（${x.storage}，${x.masked}）`
      : `${label} 尚未保存 API Key`;
    $("deleteKeyBtn").disabled = !x.saved;
    state.keySaved = !!x.saved;
    $("engineKey").textContent = x.saved
      ? `Key 已保存 ${x.masked}`
      : "尚未设置 API Key，点击设置";
    $("engineCard").classList.toggle("needs-key", !x.saved);
  } catch (e) {
    $("keyStatus").textContent = "无法读取 Key 状态：" + e.message;
    $("engineKey").textContent = "无法连接本地服务";
    $("engineCard").classList.add("needs-key");
  }
}
async function saveKey() {
  const key = $("apiKey").value.trim();
  if (!key) {
    await refreshKeyStatus();
    return false;
  }
  const x = await keyRequest("/api/save-key", {
    api_key: key,
    api_base: $("apiBase").value.trim(),
  });
  $("apiKey").value = "";
  $("keyStatus").textContent = `已保存到 ${x.storage} ${x.masked}`;
  $("deleteKeyBtn").disabled = false;
  return true;
}
async function deleteKey() {
  const label = $("provider").selectedOptions[0]?.textContent || providerName();
  if (!confirm(`确定删除这台电脑上保存的 ${label} API Key？`)) return;
  await keyRequest("/api/delete-key", {});
  $("apiKey").value = "";
  await refreshKeyStatus();
}
async function apiCall(task, text, context = "", source = "") {
  return (await apiCallResult(task, text, context, source)).text;
}
async function apiCallResult(task, text, context = "", source = "") {
  const body = {
    provider: providerName(),
    api_key: $("apiKey").value.trim(),
    api_base: $("apiBase").value.trim(),
    model: $("model").value.trim(),
    task,
    text,
    source_text: source,
    source_lang: $("sourceLang").value,
    target_lang: $("targetLang").value,
    style: $("style").value,
    glossary: $("glossary").value,
    custom_prompt: $("customPrompt").value,
    context,
  };
  // 遇到限流（429）、服务端繁忙（5xx）或网络中断时，等待后自动重试
  const RETRY =
    /HTTP (429|5\d\d)|timed? ?out|超时|Connection|连接|reset|Failed to fetch|NetworkError|overloaded|rate limit/i;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt)
      await new Promise((res) =>
        setTimeout(res, 2000 * 2 ** (attempt - 1) + Math.random() * 800),
      );
    let r, raw;
    try {
      r = await apiFetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      raw = await r.text();
    } catch (e) {
      lastErr = e;
      continue;
    }
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch (e) {}
    if (r.ok) return { text: data.text || "", truncated: !!data.truncated };
    lastErr = new Error(data.error || raw || `HTTP ${r.status}`);
    if (!RETRY.test(lastErr.message)) throw lastErr;
  }
  throw lastErr;
}
function prevContext(idx) {
  const n = +$("contextChars").value || 0;
  if (!n || idx <= 0) return "";
  const prev = state.pages[idx - 1];
  if (prev.target) return prev.target.slice(-n);
  // 并行翻译时上一页可能还没译完，改用其原文末尾帮助衔接
  return prev.source ? "（上一页原文）" + prev.source.slice(-n) : "";
}
async function translatePage(idx) {
  syncEditors();
  const p = state.pages[idx];
  if (!p.source.trim() && !state.pdf)
    throw new Error("这一页没有原文，无法翻译");
  if (!p.source.trim()) await parsePage(idx);
  markStep(4);
  const chunks = splitChunks(p.source, +$("chunkSize").value || 3200),
    outs = [];
  for (let i = 0; i < chunks.length; i++) {
    status(`翻译第 ${idx + 1} 页 · ${i + 1}/${chunks.length}`);
    const ctx = i ? outs[i - 1].slice(-800) : prevContext(idx);
    outs.push(await apiCall("translate", chunks[i], ctx));
    progress(i + 1, chunks.length, `翻译第 ${idx + 1} 页`);
  }
  p.target = outs.join("\n\n");
  state.manuscript = null;
  p.translated = true;
  p.proofed = false;
  p.approved = false;
  if (idx === state.current) $("targetEditor").innerText = p.target;
  updateMetrics();
  return p.target;
}
async function proofPage(idx) {
  syncEditors();
  const p = state.pages[idx];
  if (!p.target.trim()) await translatePage(idx);
  markStep(5);
  status(`校对第 ${idx + 1} 页…`);
  p.target = await apiCall("proofread", p.target, prevContext(idx), p.source);
  state.manuscript = null;
  p.proofed = true;
  p.approved = false;
  if (idx === state.current) $("targetEditor").innerText = p.target;
  log(`第 ${idx + 1} 页校对完成。`);
  updateMetrics();
}
// ---------- 批量处理：出错不中断、可暂停、可续跑 ----------
const runner = { stage: "", pause: false, done: 0, total: 0, started: 0 };
function isFatalError(e) {
  const m = String(e?.message || e);
  return /缺少 .*API Key|HTTP 40[13]|登记的地址|会话令牌|API Base 不能为空|模型名称不能为空|无法连接/.test(
    m,
  );
}
function formatEta(ms) {
  if (!isFinite(ms) || ms <= 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "预计不到 1 分钟";
  if (min < 60) return `预计还需约 ${min} 分钟`;
  return `预计还需约 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}
function updateEta() {
  if (!runner.done || runner.done >= runner.total) {
    $("eta").textContent = "";
    return;
  }
  const perPage = (performance.now() - runner.started) / runner.done;
  $("eta").textContent = formatEta(perPage * (runner.total - runner.done));
}
function concurrencyFor(stage) {
  if (stage === "parse") return 1;
  return Math.max(1, Math.min(8, +$("concurrency").value || 4));
}
// 依次或并行处理 indices 中的页面；单页出错记录在页面上并继续，致命错误（如缺少 Key）立即停止
async function runPages(stage, label, indices, fn) {
  runner.stage = stage;
  runner.done = 0;
  runner.total = indices.length;
  runner.started = performance.now();
  updatePipeline();
  let failed = 0,
    next = 0,
    fatal = null;
  const workers = Math.min(concurrencyFor(stage), indices.length || 1);
  if (workers > 1) log(`${label}：同时处理 ${workers} 页。`);
  async function worker() {
    while (!fatal && !runner.pause && next < indices.length) {
      const idx = indices[next++];
      const p = state.pages[idx];
      try {
        await fn(idx);
        if (p.errorStage === stage) {
          p.error = "";
          p.errorStage = "";
        }
      } catch (e) {
        if (isFatalError(e)) {
          fatal = fatal || e;
          return;
        }
        failed++;
        p.error = `${label}失败：${e.message}`;
        p.errorStage = stage;
        log(`第 ${p.n} 页${label}失败：${e.message}`);
      }
      runner.done++;
      progress(runner.done, runner.total, label);
      updateEta();
      renderPageList();
      updatePipeline();
      scheduleAutosave();
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal) throw fatal;
  return { failed, paused: runner.pause && runner.done < runner.total };
}
function setBusy(on) {
  state.busy = on;
  runner.pause = false;
  $("pauseBtn").hidden = !on;
  $("pauseBtn").disabled = false;
  $("pauseBtn").textContent = "处理完进行中的页后暂停";
  if (!on) {
    runner.stage = "";
    $("eta").textContent = "";
  }
  updateControls();
  updatePipeline();
}
function handleFatal(e) {
  status("处理已停止");
  log("错误：" + e.message);
  if (/缺少 .*API Key/.test(e.message))
    openSettings(
      "ai",
      `还没有设置 ${PROVIDER_LABELS[providerName()] || "当前平台"} 的 API Key。填写并保存后，点击“继续完整处理”即可从中断处继续。`,
    );
  else if (/HTTP 401/.test(e.message))
    openSettings(
      "ai",
      "API Key 无效或已过期（平台返回 401），请检查后重新保存。",
    );
  else if (/Key|登记的地址|API Base|模型名称/.test(e.message))
    openSettings("ai", e.message);
  else notify(e.message, "error");
}
async function stageParse() {
  const todo = state.pages
    .map((p, i) => i)
    .filter((i) => !state.pages[i].parsed);
  const r = await runPages("parse", "解析", todo, (i) => parsePage(i));
  if (todo.length && !r.paused) applyCleanup();
  return r;
}
async function stageTranslate() {
  const todo = state.pages
    .map((p, i) => i)
    .filter(
      (i) =>
        !state.pages[i].translated &&
        (state.pdf || state.pages[i].source.trim()),
    );
  return runPages("translate", "翻译", todo, (i) => translatePage(i));
}
async function stageProof() {
  const todo = state.pages
    .map((p, i) => i)
    .filter((i) => state.pages[i].translated && !state.pages[i].proofed);
  return runPages("proof", "校对", todo, (i) => proofPage(i));
}
function finishRun(results, doneMsg) {
  const failed = results.reduce((n, r) => n + (r?.failed || 0), 0);
  const paused = results.some((r) => r?.paused);
  if (paused) {
    status("已暂停。再次点击“完整处理”会从中断处继续。");
    log("处理已暂停。");
  } else if (failed) {
    status(
      `${failed} 页出错，可点击“重试出错页”，或在页面列表中筛选“出错”查看。`,
    );
    notify(`${failed} 页处理出错，其余页面已完成`, "error");
  } else status(doneMsg);
}
async function runAll() {
  if (state.busy || !canRunAll()) return;
  syncEditors();
  setBusy(true);
  const results = [];
  try {
    if (state.pdf) results.push(await stageParse());
    if (!results.some((r) => r.paused)) results.push(await stageTranslate());
    if (!results.at(-1).paused && $("proofEnabled").checked)
      results.push(await stageProof());
    finishRun(results, "完整处理完成。建议逐页检查后导出。");
    if (!results.some((r) => r.paused)) log("完整处理流程完成。");
  } catch (e) {
    handleFatal(e);
  } finally {
    setBusy(false);
    await showPage(state.current);
  }
}
async function runStage(stage) {
  if (state.busy) return;
  syncEditors();
  if (stage === "approve") {
    const i = state.pages.findIndex((p) => p.translated && !p.approved);
    $("pageFilter").value = "unapproved";
    renderPageList();
    if (i >= 0) showPage(i);
    else notify("所有已翻译的页面都已检查");
    return;
  }
  if (stage === "reconstruct") {
    try {
      await reconstructBook(true);
      openPreview();
    } catch (e) {
      status("书稿重建失败");
      notify(e.message, "error");
    }
    return;
  }
  if (stage === "clean") {
    applyCleanup();
    await showPage(state.current);
    return;
  }
  setBusy(true);
  try {
    const fn = {
      parse: stageParse,
      translate: stageTranslate,
      proof: stageProof,
    }[stage];
    const r = await fn();
    finishRun(
      [r],
      { parse: "解析完成。", translate: "翻译完成。", proof: "校对完成。" }[
        stage
      ],
    );
  } catch (e) {
    handleFatal(e);
  } finally {
    setBusy(false);
    await showPage(state.current);
  }
}
async function retryErrors() {
  if (state.busy) return;
  const byStage = { parse: [], translate: [], proof: [] };
  state.pages.forEach((p, i) => p.error && byStage[p.errorStage]?.push(i));
  setBusy(true);
  const results = [];
  try {
    if (byStage.parse.length)
      results.push(
        await runPages("parse", "解析", byStage.parse, (i) => parsePage(i)),
      );
    if (byStage.translate.length && !results.some((r) => r.paused))
      results.push(
        await runPages("translate", "翻译", byStage.translate, (i) =>
          translatePage(i),
        ),
      );
    if (byStage.proof.length && !results.some((r) => r.paused))
      results.push(
        await runPages("proof", "校对", byStage.proof, (i) => proofPage(i)),
      );
    finishRun(results, "出错页已全部重新处理完成。");
  } catch (e) {
    handleFatal(e);
  } finally {
    setBusy(false);
    await showPage(state.current);
  }
}
async function auditAll() {
  syncEditors();
  if (!state.pages.some((p) => p.translated)) {
    notify("请先完成翻译");
    return;
  }
  $("auditBtn").disabled = true;
  try {
    status("正在检查全文术语一致性…");
    const sample = state.pages
      .map((p, i) => `[P${p.n}]\n${p.target}`)
      .join("\n\n")
      .slice(0, 40000);
    const out = await apiCall("audit", sample, "");
    showInfo("全文术语检查", out);
    status("术语检查完成。");
  } catch (e) {
    if (isFatalError(e)) handleFatal(e);
    else notify(e.message, "error");
  } finally {
    updateControls();
  }
}
const manuscriptTypes = new Set([
  "book_title",
  "subtitle",
  "author",
  "copyright",
  "dedication",
  "epigraph",
  "preface_title",
  "part",
  "chapter",
  "section",
  "subsection",
  "body",
  "blockquote",
  "footnote",
  "figure_caption",
  "table_caption",
  "figure",
  "table",
  "bibliography",
  "appendix",
  "toc_entry",
  "notes_heading",
  "source_info",
  "discard",
]);
function parseModelJson(text) {
  let t = (text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
function prefilterBookText(text) {
  const junk = [
    /^\s*\d{1,5}\s*$/i,
    /barcode/i,
    /call\s*number/i,
    /digitized\s*by/i,
    /scanned\s*by/i,
    /google\s*books/i,
    /hathitrust/i,
    /internet\s*archive/i,
    /图书馆.{0,8}(馆藏|借阅|索书)/,
    /馆藏章/,
    /条形码|条码|索书号/,
    /扫描.{0,8}(编号|制作|来源)/,
  ];
  // 逐行过滤扫描噪声，同时保留空行（段落边界）
  return (text || "")
    .split("\n")
    .filter((x) => !x.trim() || !junk.some((r) => r.test(x.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function normalizeManuscriptBlocks(blocks) {
  const out = [];
  for (const raw of blocks || []) {
    const type = manuscriptTypes.has(String(raw.type || "").toLowerCase())
      ? String(raw.type).toLowerCase()
      : "body";
    const text = String(raw.text || "").trim();
    if (!text || type === "discard") continue;
    const page = Number(raw.page) || null,
      level = Number(raw.level) || 0,
      confidence = Number(raw.confidence) || 0.8;
    const note_id = String(raw.note_id || "").trim(),
      note_scope = String(raw.note_scope || "")
        .trim()
        .toLowerCase();
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === type &&
      type === "body" &&
      prev.page === page &&
      !/[。！？!?.…"”」』)）]$/.test(prev.text) &&
      text.length < 900
    ) {
      prev.text +=
        /[A-Za-z0-9,;:]$/.test(prev.text) && /^[A-Za-z0-9(“"]/.test(text)
          ? " " + text
          : text;
      continue;
    }
    const item = { type, text, page, level, confidence };
    if (type === "figure" || type === "table") {
      const m = text.match(/\[\[(FIG|TABLE):([\w.-]+)\]\]/);
      item.asset_id = raw.asset_id || (m ? `${m[1]}:${m[2]}` : "");
      if (!item.asset_id) item.type = "body";
      if (Array.isArray(raw.rows)) item.rows = raw.rows;
      if (raw.translated != null) item.translated = !!raw.translated;
    }
    if (type === "footnote") {
      item.note_id = note_id;
      item.note_scope = note_scope;
      if (raw.origin) item.origin = raw.origin;
    }
    out.push(item);
  }
  return out;
}
function headingContext(blocks) {
  return blocks
    .slice(-8)
    .filter((b) =>
      ["part", "chapter", "section", "subsection", "preface_title"].includes(
        b.type,
      ),
    )
    .map((b) => `${b.type}: ${b.text}`)
    .join("\n")
    .slice(-1800);
}
function pageRange(group) {
  const a = group[0].n,
    b = group[group.length - 1].n;
  return a === b ? `第 ${a} 页` : `第 ${a}-${b} 页`;
}
// 重建一批页面。模型输出被截断或 JSON 不完整时，把这批页面对半拆开重试；
// 单页仍然失败时先重试一次，再退回为按段落的正文块，保证内容不丢失。
// 页下注（以 [^n]: 开头的段落）由程序直接提取，不交给模型，避免被改写或遗漏
const PAGE_NOTE_RE = /^\s*\[\^(\d{1,4}|\+|[*†‡§])\]\s*[:：]\s*(.*)$/;
function splitPageNotes(text) {
  const body = [],
    notes = [];
  for (const para of (text || "").split(/\n\s*\n/)) {
    const lines = para.split("\n");
    let cur = null;
    const keep = [];
    for (const line of lines) {
      const m = line.match(PAGE_NOTE_RE);
      if (m) {
        cur = { id: m[1], text: m[2].trim() };
        notes.push(cur);
      } else if (cur && line.trim()) cur.text += " " + line.trim();
      else keep.push(line);
    }
    if (keep.join("").trim()) body.push(keep.join("\n"));
  }
  return { body: body.join("\n\n"), notes };
}
async function reconstructGroup(group, context, job, retried = false) {
  const unitLabel = state.pdf ? "PDF PAGE" : "IMPORTED TEXT UNIT";
  const pageNotes = [],
    tables = {};
  const text = group
    .map((p) => {
      const { body: withTables, notes } = splitPageNotes(p.target);
      const ex = extractTables(withTables),
        body = ex.text;
      Object.assign(tables, ex.tables);
      for (const n of notes)
        pageNotes.push({
          type: "footnote",
          text: n.text,
          page: p.n,
          level: 0,
          note_id: n.id,
          origin: "page",
        });
      return `=== ${unitLabel} ${p.n} ===\n${prefilterBookText(body)}`;
    })
    .join("\n\n");
  const sourceText = group.some(
    (p) => p.source && p.source.trim() && p.source.trim() !== p.target.trim(),
  )
    ? group
        .map(
          (p) =>
            `=== ${unitLabel} ${p.n} ORIGINAL ===\n${prefilterBookText(extractTables(p.source).text).slice(0, 3200)}`,
        )
        .join("\n\n")
        .slice(0, 18000)
    : "";
  status(`书稿结构重建：${pageRange(group)}…`);
  const res = await apiCallResult("reconstruct", text, context, sourceText);
  let obj = null;
  if (!res.truncated) {
    try {
      obj = parseModelJson(res.text);
    } catch (e) {}
  }
  if (obj && Array.isArray(obj.blocks)) {
    job.done += group.length;
    progress(job.done, job.total, "AI 书稿重建");
    return withPageNotes(
      attachAssets(normalizeManuscriptBlocks(obj.blocks), group, tables),
      pageNotes,
    );
  }
  const why = res.truncated ? "超出模型单次输出长度" : "返回的结构数据不完整";
  if (group.length > 1) {
    log(`${pageRange(group)}${why}，自动拆成更小的批次重试。`);
    const mid = Math.ceil(group.length / 2);
    if (res.truncated) job.batch = Math.min(job.batch, mid);
    const first = await reconstructGroup(group.slice(0, mid), context, job);
    const second = await reconstructGroup(
      group.slice(mid),
      headingContext(first) || context,
      job,
    );
    return [...first, ...second];
  }
  if (!retried && !res.truncated) {
    log(`${pageRange(group)}${why}，重试一次。`);
    return reconstructGroup(group, context, job, true);
  }
  const p = group[0];
  job.fallbackPages.push(p.n);
  job.done += 1;
  progress(job.done, job.total, "AI 书稿重建");
  log(`${pageRange(group)}${why}，改为按段落保留为正文。`);
  return withPageNotes(
    attachAssets(
      splitParas(
        prefilterBookText(extractTables(splitPageNotes(p.target).body).text),
      ).map((t) => ({
        type: "body",
        text: t,
        page: p.n,
        level: 0,
        confidence: 0.3,
      })),
      group,
      tables,
    ),
    pageNotes,
  );
}
// 图表占位记号变为 figure、table 块；模型漏掉的图表补回到所在页的末尾，保证不丢失
function assetBlock(id, page, tables) {
  const a = state.assets[id],
    [kind, key] = id.split(":");
  const blk = {
    type: kind === "FIG" ? "figure" : "table",
    text: `[[${id}]]`,
    page: a?.page ?? page,
    level: 0,
    confidence: 1,
    asset_id: id,
  };
  if (kind === "TABLE") {
    const rows = tables[key];
    blk.translated = !!rows?.length;
    blk.rows = rows?.length ? rows : a?.rows || [];
  }
  return blk;
}
function attachAssets(blocks, group, tables) {
  const pages = new Set(group.map((p) => p.n)),
    seen = new Set(),
    out = [];
  for (const b of blocks) {
    const parts = (b.text || "").split(/(\[\[(?:FIG|TABLE):[\w.-]+\]\])/);
    if (parts.length === 1) {
      out.push(b);
      continue;
    }
    for (const part of parts) {
      const m = part.match(/^\[\[(FIG|TABLE):([\w.-]+)\]\]$/);
      if (m) {
        const id = `${m[1]}:${m[2]}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(assetBlock(id, b.page, tables));
      } else if (part.trim()) out.push({ ...b, text: part.trim() });
    }
  }
  const missing = Object.keys(state.assets)
    .filter((id) => pages.has(state.assets[id].page) && !seen.has(id))
    .sort();
  for (const id of missing) {
    const blk = assetBlock(id, state.assets[id].page, tables);
    // 优先放在同页还没有配图的图题之前，或还没有配表的表题之后
    const capType = blk.type === "figure" ? "figure_caption" : "table_caption";
    let at = out.findIndex(
      (b, i) =>
        b.page === blk.page &&
        b.type === capType &&
        (blk.type === "figure"
          ? out[i - 1]?.type !== "figure"
          : out[i + 1]?.type !== "table"),
    );
    if (at >= 0 && blk.type === "table") at += 1;
    if (at < 0) {
      out.forEach((b, i) => b.page === blk.page && (at = i));
      at = at >= 0 ? at + 1 : out.length;
    }
    out.splice(at, 0, blk);
  }
  return out;
}
function withPageNotes(blocks, pageNotes) {
  if (!pageNotes.length) return blocks;
  const out = [];
  const byPage = new Map();
  for (const n of pageNotes)
    byPage.set(n.page, [...(byPage.get(n.page) || []), n]);
  const lastIndex = new Map();
  blocks.forEach((b, i) => b.page != null && lastIndex.set(b.page, i));
  blocks.forEach((b, i) => {
    out.push(b);
    for (const [pg, idx] of lastIndex)
      if (idx === i && byPage.has(pg))
        (out.push(...byPage.get(pg)), byPage.delete(pg));
  });
  for (const rest of byPage.values()) out.push(...rest);
  return out;
}
async function reconstructBook(force = false) {
  syncEditors();
  if (state.manuscript && !force) return state.manuscript;
  if (!state.pages.some((p) => p.target && p.target.trim()))
    throw new Error("没有可用于书稿重建的译文");
  if (state.busy) throw new Error("当前已有任务正在运行");
  state.busy = true;
  $("reconstructBtn").disabled = true;
  const old = $("reconstructBtn").textContent;
  $("reconstructBtn").textContent = "正在重建…";
  try {
    const batch = Math.max(2, +$("manuscriptBatchPages").value || 6),
      pages = state.pages.filter((p) => p.target && p.target.trim()),
      all = [];
    // 批次大小会随截断情况自动缩小，后续批次沿用较小的批次，避免反复浪费调用
    const job = { done: 0, total: pages.length, fallbackPages: [], batch };
    let context = "";
    for (let start = 0; start < pages.length;) {
      const size = job.batch;
      const blocks = await reconstructGroup(
        pages.slice(start, start + size),
        context,
        job,
      );
      all.push(...blocks);
      context = headingContext(all) || context;
      start += size;
    }
    state.manuscript = {
      version: 2,
      createdAt: new Date().toISOString(),
      blocks: normalizeManuscriptBlocks(all),
      fallbackPages: job.fallbackPages,
    };
    if (job.fallbackPages.length)
      log(
        `第 ${job.fallbackPages.join("、")} 页未能识别结构，已按正文段落保留全部内容。`,
      );
    if (!state.manuscript.blocks.length)
      throw new Error("没有得到有效书稿结构");
    const noteBlocks = state.manuscript.blocks.filter(
        (b) => b.type === "footnote",
      ).length,
      anchors = state.manuscript.blocks.reduce(
        (n, b) => n + (b.text.match(/\[\[FN:[^\]]+\]\]/g) || []).length,
        0,
      );
    status(
      `书稿重建完成：${state.manuscript.blocks.length} 个结构块，${anchors} 个注号 / ${noteBlocks} 条注释。`,
    );
    log(
      `AI 书稿重建完成：${anchors} 个正文脚注锚点，${noteBlocks} 条注释。导出 Word 时将配对为页下注；旧目录项、扫描噪声和 discard 项不会进入中文书稿。`,
    );
    return state.manuscript;
  } finally {
    state.busy = false;
    $("reconstructBtn").textContent = old;
    updateControls();
    updatePipeline();
  }
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function base() {
  return (state.fileName || "translated").replace(
    /\.(pdf|html?|docx|json)$/i,
    "",
  );
}
// 译文中的图片记号换成图片，表格换成 HTML 表格
function richHTML(text) {
  text = text || "";
  const re =
    /\[\[TABLE:([\w.-]+)\]\][ \t]*((?:\n[ \t]*\|[^\n]*)*)(?:\n[ \t]*\[\[\/TABLE\]\])?|\[\[FIG:([\w.-]+)\]\]/g;
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(esc(text.slice(last, m.index)).replace(/\n/g, "<br>"));
    if (m[3]) {
      const a = state.assets["FIG:" + m[3]];
      if (a?.image)
        parts.push(`<figure><img src="${a.image}" alt=""></figure>`);
    } else
      parts.push(
        `<table class="t">${parseTableLines(m[2])
          .map(
            (r, i) =>
              `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join("")}</tr>`,
          )
          .join("")}</table>`,
      );
    last = m.index + m[0].length;
  }
  parts.push(esc(text.slice(last)).replace(/\n/g, "<br>"));
  return parts.join("");
}
function makeHTML(bilingual = false) {
  syncEditors();
  const pages = state.pages
    .map(
      (p, i) =>
        `<section class="page"><div class="pn">${i + 1}</div>${bilingual ? `<div class="grid"><article><h3>Original</h3><div>${richHTML(p.source)}</div></article><article><h3>Translation</h3><div>${richHTML(p.target || p.source)}</div></article></div>` : `<article>${richHTML(p.target || p.source)}</article>`}</section>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(base())}</title><style>@page{size:A4;margin:18mm 18mm 20mm}body{font-family:"Noto Serif SC","Songti SC","Times New Roman",serif;color:#111;line-height:1.75;margin:0}.page{page-break-after:always;position:relative}.pn{position:absolute;right:0;top:-8mm;font:9pt sans-serif;color:#777}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9mm}.grid article+article{border-left:1px solid #ddd;padding-left:9mm}article{font-size:10.5pt;text-align:justify}figure{margin:8px 0;text-align:center}figure img{max-width:100%}table.t{border-collapse:collapse;margin:8px auto;font-size:9.5pt;border-top:1.5px solid #000;border-bottom:1.5px solid #000}table.t th{border-bottom:.75px solid #000;font-weight:normal}table.t td,table.t th{padding:2px 8px;text-align:center}table.t td:first-child,table.t th:first-child{text-align:left}h3{font:600 9pt sans-serif;color:#666;border-bottom:1px solid #ddd;padding-bottom:4px}@media(max-width:800px){.grid{grid-template-columns:1fr}.grid article+article{border-left:0;padding-left:0;border-top:1px solid #ddd;padding-top:8px}}</style></head><body>${pages}</body></html>`;
}
async function exportWord(mode = "translated") {
  syncEditors();
  closeExportMenu();
  if (!state.pages.some((p) => p.target && p.target.trim())) {
    notify("没有可导出的译文");
    return;
  }
  if (mode !== "bilingual") {
    try {
      await reconstructBook(false);
      openPreview();
    } catch (e) {
      status("书稿重建失败");
      if (isFatalError(e)) handleFatal(e);
      else notify(e.message, "error");
    }
    return;
  }
  await downloadDocx("bilingual");
}
// 只发送导出内容中用到的图表截图
function assetPayload(mode) {
  const ids = new Set();
  if (mode !== "bilingual" && state.manuscript)
    for (const b of state.manuscript.blocks)
      if (b.asset_id) ids.add(b.asset_id);
  if (mode === "bilingual")
    for (const p of state.pages)
      for (const m of `${p.source}\n${p.target}`.matchAll(ASSET_RE))
        ids.add(`${m[1]}:${m[2]}`);
  const out = {};
  for (const id of ids) {
    const a = state.assets[id];
    if (a?.image) out[id] = { kind: a.kind, image: a.image, w: a.w, h: a.h };
  }
  return out;
}
async function downloadDocx(mode) {
  const btn = $("exportMenuBtn");
  btn.disabled = true;
  try {
    status(
      mode === "bilingual" ? "正在生成对照 Word…" : "正在生成中文书稿 Word…",
    );
    const payload = {
      mode: mode === "bilingual" ? "bilingual" : "manuscript",
      file_name: state.fileName,
      title: base(),
      pages: state.pages.map((p) => ({
        n: p.n,
        source: p.source,
        target: p.target,
      })),
      manuscript: mode === "bilingual" ? null : state.manuscript,
      assets: assetPayload(mode),
      true_footnotes: $("trueFootnotes").checked,
      footnote_numbering: $("footnoteNumbering").value,
    };
    const r = await apiFetch("/api/export-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      let msg = await r.text();
      try {
        msg = JSON.parse(msg).error || msg;
      } catch {}
      throw new Error(msg || `HTTP ${r.status}`);
    }
    download(
      base() +
        (mode === "bilingual" ? "_原文译文对照版.docx" : "_中文书稿版.docx"),
      await r.blob(),
    );
    status("Word 已生成，开始下载。");
    notify(
      mode === "bilingual" ? "对照 Word 已导出" : "中文书稿 Word 已导出",
      "ok",
    );
    log(`已导出${mode === "bilingual" ? "原文译文对照" : "中文书稿"} Word。`);
  } catch (e) {
    status("Word 导出失败");
    notify("Word 导出失败：" + e.message, "error");
  } finally {
    updateControls();
  }
}
function exportProject() {
  syncEditors();
  const obj = {
    version: 5,
    fileName: state.fileName,
    settings: Object.fromEntries(
      persistIds.map((id) => [
        id,
        $(id).type === "checkbox" ? $(id).checked : $(id).value,
      ]),
    ),
    manuscript: state.manuscript,
    assets: state.assets,
    pages: state.pages.map(
      ({
        n,
        source,
        target,
        layout,
        ocr,
        parsed,
        translated,
        proofed,
        approved,
        charCount,
      }) => ({
        n,
        source,
        target,
        layout,
        ocr,
        parsed,
        translated,
        proofed,
        approved,
        charCount,
      }),
    ),
  };
  download(
    base() + ".translation-project.json",
    new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
}

// ---------- 界面：文档、页面列表、视图、流程条、提示 ----------
let currentView = "page";
const PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
  qwen: "Alibaba Qwen",
  kimi: "Moonshot Kimi",
  openrouter: "OpenRouter",
  custom: "自定义接口",
};
function notify(msg, kind = "info") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  const close = () => t.remove();
  t.onclick = close;
  $("toasts").appendChild(t);
  setTimeout(close, kind === "error" ? 9000 : 3500);
}
function showInfo(title, text) {
  $("infoTitle").textContent = title;
  $("infoBody").textContent = text;
  openModal("infoModal");
}
function openModal(id) {
  $(id).classList.add("open");
  const f = $(id).querySelector("button.primary, input, select");
  setTimeout(() => f?.focus(), 30);
}
function closeModal(id) {
  $(id).classList.remove("open");
}
function setDocument(name, count, kind, unit = "page") {
  $("docTitle").textContent =
    `${name} · ${count} ${kind === "PDF" || unit === "page" ? "页" : "个单元（按长度切分）"}`;
  $("docTitle").title = name;
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = `${kind}：${name}`;
}
function pageStatusClass(p) {
  if (p.error) return "s-error";
  if (p.approved) return "s-approved";
  if (p.proofed) return "s-proofed";
  if (p.translated) return "s-translated";
  if (p.parsed) return "s-parsed";
  return "s-none";
}
function pageStatusText(p) {
  if (p.error) return "出错";
  if (p.approved) return "已检查";
  if (p.proofed) return "已校对";
  if (p.translated) return "已翻译";
  if (p.parsed) return "已解析";
  return "未处理";
}
const PAGE_FILTERS = {
  all: () => true,
  todo: (p) => !p.translated,
  unproofed: (p) => p.translated && !p.proofed,
  unapproved: (p) => p.translated && !p.approved,
  error: (p) => !!p.error,
};
function renderPageList() {
  const list = $("pageList");
  const f = PAGE_FILTERS[$("pageFilter").value] || PAGE_FILTERS.all;
  const frag = document.createDocumentFragment();
  let shown = 0;
  state.pages.forEach((p, i) => {
    if (!f(p)) return;
    shown++;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className =
      "page-item " +
      pageStatusClass(p) +
      (i === state.current ? " current" : "");
    b.dataset.index = i;
    b.title = `第 ${p.n} 页 · ${pageStatusText(p)}${p.error ? "：" + p.error : ""}`;
    b.innerHTML = `<i class="dot"></i><span>${p.n}</span>`;
    li.appendChild(b);
    frag.appendChild(li);
  });
  list.replaceChildren(frag);
  if (state.pages.length && !shown) {
    const li = document.createElement("li");
    li.className = "rail-empty";
    li.textContent = "没有符合条件的页面";
    list.appendChild(li);
  }
  list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
}
function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}
function updatePipeline() {
  const ps = state.pages,
    n = ps.length;
  const c = (f) => ps.filter(f).length;
  const parsed = c((p) => p.parsed),
    translated = c((p) => p.translated),
    proofed = c((p) => p.proofed),
    approved = c((p) => p.approved);
  const set = (key, text, percent) => {
    $("c" + key).textContent = text;
    $("b" + key).style.width = percent + "%";
  };
  set("Parse", `${parsed}/${n}`, pct(parsed, n));
  set("Clean", state.cleaned ? "已完成" : "未进行", state.cleaned ? 100 : 0);
  set("Translate", `${translated}/${n}`, pct(translated, n));
  set("Proof", `${proofed}/${n}`, pct(proofed, n));
  const blocks = state.manuscript?.blocks?.length || 0;
  set(
    "Reconstruct",
    blocks ? `${blocks} 个结构块` : "未进行",
    blocks ? 100 : 0,
  );
  set("Approve", `${approved}/${n}`, pct(approved, n));
  document.querySelectorAll(".stage").forEach((el) => {
    el.classList.toggle(
      "running",
      state.busy && el.dataset.stage === runner.stage,
    );
    const done = {
      parse: n && parsed === n,
      clean: state.cleaned,
      translate: n && translated === n,
      proof: n && proofed === n,
      reconstruct: !!blocks,
      approve: n && approved === n,
    }[el.dataset.stage];
    el.classList.toggle("done", !!done);
  });
  const errors = c((p) => p.error);
  $("retryBtn").hidden = !errors || state.busy;
  $("retryBtn").textContent = `重试出错页（${errors}）`;
}
function canRunAll() {
  return !!state.pdf || state.pages.some((p) => p.source && p.source.trim());
}
function updateControls() {
  const has = state.pages.length > 0,
    pdf = !!state.pdf,
    busy = !!state.busy;
  const hasTarget = state.pages.some((p) => p.target && p.target.trim());
  const hasPairs = state.pages.some((p) => p.source && p.target);
  const canTranslate = pdf || state.pages.some((p) => p.source.trim());
  const cur = state.pages[state.current];
  const dis = (id, v) => ($(id).disabled = v);
  dis("runBtn", !canRunAll() || busy);
  dis("auditBtn", !hasTarget || busy);
  dis("reconstructBtn", !hasTarget || busy);
  dis("exportMenuBtn", !hasTarget || busy);
  dis("exportWord", !hasTarget);
  dis("exportHtml", !hasTarget);
  dis("saveProject", !has);
  dis("exportBilingual", !hasPairs);
  dis("exportBilingualWord", !hasPairs);
  dis("parseBtn", !pdf || busy);
  dis("translateBtn", !canTranslate || busy || !cur);
  dis("proofBtn", !cur?.target?.trim() || busy);
  dis("approveBtn", !cur?.target?.trim());
  const stageOk = {
    parse: pdf,
    clean: pdf && state.pages.some((p) => p.parsed),
    translate: canTranslate,
    proof: hasTarget,
    reconstruct: hasTarget,
    approve: hasTarget,
  };
  document.querySelectorAll(".stage").forEach((el) => {
    el.disabled = busy || !stageOk[el.dataset.stage];
  });
  $("runBtn").textContent =
    canRunAll() &&
    state.pages.some((p) => p.parsed || p.translated) &&
    state.pages.some(
      (p) => !p.translated || ($("proofEnabled").checked && !p.proofed),
    )
      ? "继续完整处理"
      : "完整处理";
}
function selectView(v) {
  if (v !== currentView) syncEditors();
  currentView = v;
  document.querySelectorAll(".source-pane .tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === v);
    t.setAttribute("aria-selected", t.dataset.view === v);
  });
  document.querySelectorAll(".source-pane .view").forEach((el) => {
    el.hidden = el.dataset.view !== v;
  });
  if (v === "pairs") renderPairs();
}
function splitParas(t) {
  return (t || "")
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function renderPairs() {
  const p = state.pages[state.current];
  const box = $("pairView");
  if (!p) {
    box.innerHTML =
      '<p class="empty">打开文档后，这里按段落并排显示原文和译文。</p>';
    return;
  }
  const a = splitParas(p.source),
    b = splitParas(p.target);
  const rows = Math.max(a.length, b.length);
  let html = "";
  if (a.length && b.length && a.length !== b.length)
    html += `<p class="pair-note">原文 ${a.length} 段，译文 ${b.length} 段，段落没有一一对应，请留意漏译或合并。</p>`;
  for (let i = 0; i < rows; i++)
    html += `<div class="pair"><span class="pair-no">${i + 1}</span><div class="pair-src">${esc(a[i] || "")}</div><div class="pair-tgt${b[i] ? "" : " missing"}">${esc(b[i] || (a[i] ? "（无对应译文）" : ""))}</div></div>`;
  box.innerHTML = html || '<p class="empty">这一页还没有文字。</p>';
}
function updateEngineCard() {
  const p = providerName();
  $("engineName").textContent = PROVIDER_LABELS[p] || p;
  $("engineModel").textContent = $("model").value || "未填写模型";
}
function openSettings(tab = "ai", notice = "") {
  selectSettingsTab(tab);
  $("settingsNotice").hidden = !notice;
  $("settingsNotice").textContent = notice;
  openModal("modal");
  refreshKeyStatus();
}
function selectSettingsTab(tab) {
  document.querySelectorAll("[data-settings-tab]").forEach((el) => {
    if (el.classList.contains("tab"))
      el.classList.toggle("active", el.dataset.settingsTab === tab);
    else el.hidden = el.dataset.settingsTab !== tab;
  });
}
function noteKey(scope, id) {
  scope = String(scope || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  id = String(id || "").trim();
  return scope && id ? `${scope}:${id}` : "";
}
const HEADING_TYPES = {
  book_title: 0,
  preface_title: 1,
  part: 1,
  chapter: 1,
  appendix: 1,
  section: 2,
  subsection: 3,
};
async function openPreview() {
  const blocks = state.manuscript?.blocks || [];
  let rep = null;
  try {
    const r = await apiFetch("/api/manuscript-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manuscript: state.manuscript }),
    });
    if (r.ok) rep = await r.json();
  } catch (e) {}
  const headings = blocks.filter((b) => b.type in HEADING_TYPES);
  const body = blocks.filter((b) => b.type === "body").length;
  $("previewStats").innerHTML = [
    ["结构块", blocks.length],
    ["标题", headings.length],
    ["正文段落", body],
    ["图", blocks.filter((b) => b.type === "figure").length],
    ["表", blocks.filter((b) => b.type === "table").length],
    ["注号", rep ? rep.markers : "?"],
    ["注释", rep ? rep.notes : "?"],
    ["已配对", rep ? rep.paired : "?"],
  ]
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join("");
  $("previewToc").innerHTML = headings.length
    ? headings
        .map(
          (h) =>
            `<li class="lv${HEADING_TYPES[h.type]}"><span>${esc(h.text.replace(/\[\[FN:[^\]]+\]\]|\[\^[^\]]+\]/g, ""))}</span>${h.page ? `<em>p.${h.page}</em>` : ""}</li>`,
        )
        .join("")
    : '<li class="empty">没有识别到章节标题，导出的 Word 将没有目录层级。</li>';
  const where = (x) => (x.page ? `原书第 ${x.page} 页，` : "") + `注 ${x.num}`;
  const list = (arr, label, fmt) =>
    arr.length
      ? `<p class="warn-text">${label}（${arr.length}）</p><ul class="key-list">${arr
          .slice(0, 30)
          .map((x) => `<li>${esc(fmt(x))}</li>`)
          .join(
            "",
          )}${arr.length > 30 ? `<li>…另有 ${arr.length - 30} 条</li>` : ""}</ul>`
      : "";
  const fb = state.manuscript?.fallbackPages || [];
  let html = fb.length
    ? `<p class="warn-text">第 ${fb.join("、")} 页未能识别结构，已按正文段落保留，这些页中的标题和章末注不会单独排版。</p>`
    : "";
  if (!rep) html += "<p>无法连接本地服务，暂时不能统计注释配对情况。</p>";
  else {
    const m = rep.by_method || {};
    html +=
      rep.markers || rep.notes
        ? `<p>${rep.paired} 个注号找到了对应注释${$("trueFootnotes").checked ? "，导出时转为 Word 页下注" : ""}。其中页下注 ${m.page || 0} 条，章末注或书末注 ${(m.sequence || 0) + (m.scope || 0)} 条。</p>`
        : "<p>没有识别到注释。</p>";
    html += list(
      rep.unmatched_markers,
      "有注号但没有找到注释（导出时显示为上标数字）",
      where,
    );
    html += list(
      rep.unmatched_notes,
      "有注释但正文中找不到注号（导出时列在书末）",
      (x) => `${where(x)}：${x.text.slice(0, 40)}`,
    );
    html += rep.source_info
      ? `<p class="source-line">原书信息：${esc(rep.source_info)}</p>`
      : '<p class="warn-text">没有识别到原书出版信息，版权页内容不会出现在导出的书稿中。</p>';
  }
  $("previewNotes").innerHTML = html;
  openModal("previewModal");
}
function closeExportMenu() {
  $("exportMenu").hidden = true;
  $("exportMenuBtn").setAttribute("aria-expanded", "false");
}
async function handleFile(f) {
  if (!f) return;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (state.busy) {
    notify("正在处理中，请先暂停当前任务");
    return;
  }
  if (
    state.pages.some((p) => p.translated) &&
    !confirm("打开新文件会替换当前项目，未导出的译文将丢失。继续吗？")
  )
    return;
  try {
    if (ext === "pdf" || f.type === "application/pdf") await loadPdf(f);
    else await importExisting(f);
  } catch (e) {
    status("打开文件失败");
    notify("打开文件失败：" + e.message, "error");
  }
}
function isTyping(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}
async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    if (isFatalError(e)) handleFatal(e);
    else notify(e.message, "error");
  } finally {
    updateControls();
    updatePipeline();
    renderPageList();
  }
}
async function translateCurrent() {
  const p = state.pages[state.current];
  if (!p || state.busy) return;
  state.busy = true;
  updateControls();
  try {
    await translatePage(state.current);
    p.error = "";
  } finally {
    state.busy = false;
    await showPage(state.current);
  }
}
async function proofCurrent() {
  const p = state.pages[state.current];
  if (!p || state.busy) return;
  state.busy = true;
  updateControls();
  try {
    await proofPage(state.current);
  } finally {
    state.busy = false;
    await showPage(state.current);
  }
}
function toggleApproved(next = false) {
  syncEditors();
  const p = state.pages[state.current];
  if (!p?.target?.trim()) return;
  p.approved = !p.approved;
  if (next && p.approved && state.current < state.pages.length - 1)
    showPage(state.current + 1);
  else showPage(state.current);
}

// ---------- 事件绑定 ----------
$("file").onchange = (e) => {
  handleFile(e.target.files[0]);
  e.target.value = "";
};
const drop = $("drop");
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add("drag");
};
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  handleFile(e.dataTransfer.files[0]);
};
drop.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("file").click();
  }
};
$("prev").onclick = () => showPage(state.current - 1);
$("next").onclick = () => showPage(state.current + 1);
$("pageList").onclick = (e) => {
  const b = e.target.closest(".page-item");
  if (b) showPage(+b.dataset.index);
};
$("pageFilter").onchange = renderPageList;
document
  .querySelectorAll(".source-pane .tab")
  .forEach((t) => (t.onclick = () => selectView(t.dataset.view)));
document
  .querySelectorAll(".stage")
  .forEach((el) => (el.onclick = () => runStage(el.dataset.stage)));
$("runBtn").onclick = runAll;
$("pauseBtn").onclick = () => {
  runner.pause = true;
  $("pauseBtn").disabled = true;
  $("pauseBtn").textContent = "正在暂停…";
};
$("retryBtn").onclick = retryErrors;
$("parseBtn").onclick = () =>
  guarded(async () => {
    state.pages[state.current].parsed = false;
    await parsePage(state.current);
  });
$("translateBtn").onclick = () => guarded(translateCurrent);
$("proofBtn").onclick = () => guarded(proofCurrent);
$("approveBtn").onclick = () => toggleApproved(false);
$("auditBtn").onclick = auditAll;
$("reconstructBtn").onclick = () => runStage("reconstruct");
$("exportMenuBtn").onclick = (e) => {
  e.stopPropagation();
  const open = $("exportMenu").hidden;
  $("exportMenu").hidden = !open;
  $("exportMenuBtn").setAttribute("aria-expanded", String(open));
  if (open) $("exportMenu").querySelector("button:not(:disabled)")?.focus();
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu")) closeExportMenu();
});
$("exportWord").onclick = () => exportWord("translated");
$("exportBilingualWord").onclick = () => {
  closeExportMenu();
  exportWord("bilingual");
};
$("saveProject").onclick = () => {
  closeExportMenu();
  exportProject();
};
$("exportHtml").onclick = () => {
  closeExportMenu();
  download(
    base() + "_translated.html",
    new Blob([makeHTML(false)], { type: "text/html;charset=utf-8" }),
  );
};
$("exportBilingual").onclick = () => {
  closeExportMenu();
  download(
    base() + "_bilingual.html",
    new Blob([makeHTML(true)], { type: "text/html;charset=utf-8" }),
  );
};
$("previewExport").onclick = async () => {
  closeModal("previewModal");
  await downloadDocx("manuscript");
};
$("previewRebuild").onclick = async () => {
  closeModal("previewModal");
  await runStage("reconstruct");
};
$("previewClose").onclick = () => closeModal("previewModal");
$("infoClose").onclick = () => closeModal("infoModal");
$("provider").onchange = () => applyProviderPreset($("provider").value);
$("model").oninput = updateEngineCard;
$("settingsBtn").onclick = () => openSettings("ai");
$("engineCard").onclick = () => openSettings("ai");
document
  .querySelectorAll(".tab[data-settings-tab]")
  .forEach((t) => (t.onclick = () => selectSettingsTab(t.dataset.settingsTab)));
$("closeModal").onclick = async () => {
  try {
    saveSettings();
    if ($("apiKey").value.trim()) await saveKey();
    closeModal("modal");
    updateEngineCard();
    updateControls();
    if (state.pages.length) showPage(state.current);
  } catch (e) {
    notify("保存设置失败：" + e.message, "error");
  }
};
$("saveKeyBtn").onclick = async () => {
  try {
    if (!$("apiKey").value.trim()) {
      notify("请先输入 API Key");
      return;
    }
    await saveKey();
    await refreshKeyStatus();
    notify("Key 已保存", "ok");
  } catch (e) {
    notify(e.message, "error");
  }
};
$("deleteKeyBtn").onclick = async () => {
  try {
    await deleteKey();
  } catch (e) {
    notify(e.message, "error");
  }
};
$("testBtn").onclick = async () => {
  try {
    $("testResult").textContent = "正在测试…";
    const x = await apiCall("ping", "Hello");
    $("testResult").textContent = "连接成功：" + x.slice(0, 60);
  } catch (e) {
    $("testResult").textContent = "连接失败：" + e.message;
  }
};
$("clearBtn").onclick = () => {
  if (confirm("清空当前项目？未导出的译文将丢失。")) location.reload();
};
$("shortcutsBtn").onclick = showShortcuts;
function showShortcuts() {
  showInfo(
    "快捷键",
    [
      "Alt + ← / →　上一页 / 下一页",
      "Ctrl（⌘）+ Enter　翻译本页",
      "Ctrl（⌘）+ Shift + Enter　标记本页已检查并进入下一页",
      "Ctrl（⌘）+ S　保存项目",
      "?　显示本说明（不在输入框中时）",
      "Esc　关闭对话框或菜单",
    ].join("\n"),
  );
}
for (const m of ["modal", "previewModal", "infoModal"])
  $(m).addEventListener("mousedown", (e) => {
    if (e.target === $(m)) closeModal(m);
  });
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") {
    closeExportMenu();
    for (const m of ["infoModal", "previewModal", "modal"])
      if ($(m).classList.contains("open")) {
        closeModal(m);
        break;
      }
    return;
  }
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    showPage(state.current - 1);
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    showPage(state.current + 1);
  } else if (mod && e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    toggleApproved(true);
  } else if (mod && e.key === "Enter") {
    e.preventDefault();
    if (!$("translateBtn").disabled) guarded(translateCurrent);
  } else if (mod && (e.key === "s" || e.key === "S")) {
    if (state.pages.length) {
      e.preventDefault();
      exportProject();
    }
  } else if (e.key === "?" && !isTyping(e)) {
    showShortcuts();
  }
});
for (const id of ["sourceEditor", "targetEditor"])
  $(id).addEventListener("input", () => {
    editorsDirty = true;
    state.manuscript = null;
  });
$("targetEditor").addEventListener("blur", () => {
  syncEditors();
  updateControls();
  if (currentView === "pairs") renderPairs();
});

loadSettings();
if (location.protocol.startsWith("http")) $("backend").value = location.origin;
if (!$("provider").value) $("provider").value = "deepseek";
syncProviderUI();
updateEngineCard();
updatePipeline();
updateControls();
renderPairs();
$("canvasWrap").style.display = "none";
$("noPageImage").hidden = false;
$("noPageImage").textContent =
  "在左侧打开 PDF 后，这里显示页面和识别出的文本块。";
window.addEventListener("beforeunload", (e) => {
  saveSettings();
  if (state.pages.some((p) => p.translated)) e.preventDefault();
});
setTimeout(refreshKeyStatus, 300);

// ---------- 自动保存：长任务进行中把项目存进浏览器，页面意外关闭后可以恢复 ----------
const AUTOSAVE_DB = "scholar-pdf-translator",
  AUTOSAVE_KEY = "current";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(AUTOSAVE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("projects");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(v) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction("projects", "readwrite");
    tx.objectStore("projects").put(v, AUTOSAVE_KEY);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet() {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db
      .transaction("projects")
      .objectStore("projects")
      .get(AUTOSAVE_KEY);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function projectSnapshot() {
  return {
    version: 5,
    savedAt: new Date().toISOString(),
    fileName: state.fileName,
    manuscript: state.manuscript,
    assets: state.assets,
    pages: state.pages.map(
      ({
        n,
        source,
        target,
        layout,
        ocr,
        parsed,
        translated,
        proofed,
        approved,
        charCount,
        error,
        errorStage,
      }) => ({
        n,
        source,
        target,
        layout,
        ocr,
        parsed,
        translated,
        proofed,
        approved,
        charCount,
        error,
        errorStage,
      }),
    ),
  };
}
let autosaveTimer = null;
function scheduleAutosave() {
  if (autosaveTimer || !state.pages.some((p) => p.translated)) return;
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    try {
      await idbPut(projectSnapshot());
    } catch (e) {
      console.warn("自动保存失败", e);
    }
  }, 3000);
}
async function offerRestore() {
  let snap;
  try {
    snap = await idbGet();
  } catch (e) {
    return;
  }
  if (!snap?.pages?.some((p) => p.translated) || state.pages.length) return;
  const done = snap.pages.filter((p) => p.translated).length;
  const when = new Date(snap.savedAt).toLocaleString();
  const bar = document.createElement("div");
  bar.className = "restore-bar";
  bar.innerHTML = `<span>发现上次未完成的项目：<b></b>，已翻译 ${done}/${snap.pages.length} 页（${when} 自动保存）。</span>`;
  bar.querySelector("b").textContent = snap.fileName || "未命名";
  const ok = document.createElement("button");
  ok.className = "btn small primary";
  ok.textContent = "恢复并继续";
  ok.onclick = () => {
    activateImportedProject(
      snap.fileName,
      snap.pages,
      snap.pages.some((p) => p.source && p.target) ? "bilingual" : "translated",
      "page",
    );
    if (snap.manuscript) state.manuscript = snap.manuscript;
    state.assets = snap.assets || {};
    updatePipeline();
    bar.remove();
    notify("已恢复。点击“继续完整处理”会从未完成的页面接着做。", "ok");
  };
  const no = document.createElement("button");
  no.className = "btn small";
  no.textContent = "忽略";
  no.onclick = () => bar.remove();
  bar.append(ok, no);
  document.querySelector(".main").prepend(bar);
}
window.addEventListener("pagehide", () => {
  if (state.pages.some((p) => p.translated))
    idbPut(projectSnapshot()).catch(() => {});
});
offerRestore();
