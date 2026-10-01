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
};
const persistIds = [
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
function groupLines(items, pageW) {
  const rows = [];
  for (const it of items) {
    const x = it.transform?.[4] || 0,
      y = it.transform?.[5] || 0,
      h = Math.max(6, Math.abs(it.height || it.transform?.[3] || 10)),
      w = Math.max(1, it.width || 0),
      text = (it.str || "").trim();
    if (!text) continue;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.35));
    if (!row) {
      row = { y, h, items: [] };
      rows.push(row);
    }
    row.items.push({ x, y, h, w, text });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  rows.sort((a, b) => b.y - a.y);
  return rows;
}
function detectColumns(rows, pageW) {
  if ($("layoutMode").value === "single") return "single";
  if ($("layoutMode").value === "double") return "double";
  const mid = pageW / 2,
    gap = pageW * 0.055;
  let left = 0,
    right = 0,
    cross = 0;
  for (const r of rows) {
    const min = Math.min(...r.items.map((i) => i.x)),
      max = Math.max(...r.items.map((i) => i.x + i.w));
    if (max < mid - gap) left++;
    else if (min > mid + gap) right++;
    else cross++;
  }
  return left > 4 && right > 4 && cross < Math.max(5, (left + right) * 0.35)
    ? "double"
    : "single";
}
function rowsToBlocks(rows, pageW, pageH, layout) {
  const blocks = [];
  const makeText = (r) =>
    r.items
      .map(
        (it, j) =>
          it.text +
          (j < r.items.length - 1 &&
          r.items[j + 1].x - (it.x + it.w) > Math.max(3, it.h * 0.25)
            ? " "
            : ""),
      )
      .join("")
      .trim();
  let ordered = rows;
  if (layout === "double") {
    const mid = pageW / 2;
    const spanning = [],
      left = [],
      right = [];
    for (const r of rows) {
      const min = Math.min(...r.items.map((i) => i.x)),
        max = Math.max(...r.items.map((i) => i.x + i.w));
      if (min < mid && max > mid) spanning.push(r);
      else if ((min + max) / 2 < mid) left.push(r);
      else right.push(r);
    }
    const topSpan = spanning.filter((r) => r.y > pageH * 0.72),
      bottomSpan = spanning.filter((r) => r.y <= pageH * 0.72);
    ordered = [...topSpan, ...left, ...right, ...bottomSpan];
  }
  let current = null;
  for (const r of ordered) {
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
    if (current && sameColumn && gap < Math.max(18, h * 1.7)) {
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
    text: cleanText(b.text),
  }));
}
async function extractStructured(idx) {
  const page = await state.pdf.getPage(idx + 1),
    vp = page.getViewport({ scale: 1 }),
    tc = await page.getTextContent();
  const rows = groupLines(tc.items, vp.width),
    layout = detectColumns(rows, vp.width),
    blocks = rowsToBlocks(rows, vp.width, vp.height, layout);
  return {
    layout,
    blocks,
    text: cleanText(blocks.map((b) => b.text).join("\n\n")),
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
    await renderPage(idx + 1);
    const ocrLang = $("ocrLang").value;
    const result = await Tesseract.recognize(
      $("pdfCanvas").toDataURL("image/png"),
      ocrLang,
      {
        ...(await tesseractOptions(ocrLang)),
        logger: (m) => {
          if (m.status === "recognizing text")
            progress(
              Math.round((m.progress || 0) * 100),
              100,
              `OCR 第 ${idx + 1} 页`,
            );
        },
      },
    );
    s = { layout: "ocr", blocks: [], text: cleanText(result.data.text) };
    state.pages[idx].ocr = true;
    log(`第 ${idx + 1} 页启用 OCR，${s.text.length} 字符。`);
  } else
    log(
      `第 ${idx + 1} 页读取文本层，识别为${s.layout === "double" ? "双栏" : "单栏"}。`,
    );
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
      if (n.length < 3 || n.length > 140) continue;
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
function applyCleanup() {
  markStep(3);
  if ($("removeHeaders").checked) headerFooterCandidates();
  for (const p of state.pages) {
    // 按单行拆分并保留空行，这样段落之间的空行（段落边界）不会在清洗中丢失
    let lines = (p.raw || p.source || "").split("\n");
    if ($("removeHeaders").checked)
      lines = lines.filter((s) => {
        if (!s.trim()) return true;
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
    if (p.length > maxLen) {
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
  "bibliography",
  "appendix",
  "toc_entry",
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
  return (text || "")
    .split(/\n+/)
    .filter((x) => !junk.some((r) => r.test(x.trim())))
    .join("\n")
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
      !/[。！？!?]$/.test(prev.text) &&
      text.length < 900
    ) {
      prev.text += text;
      continue;
    }
    const item = { type, text, page, level, confidence };
    if (type === "footnote") {
      item.note_id = note_id;
      item.note_scope = note_scope;
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
async function reconstructGroup(group, context, job, retried = false) {
  const unitLabel = state.pdf ? "PDF PAGE" : "IMPORTED TEXT UNIT";
  const text = group
    .map((p) => `=== ${unitLabel} ${p.n} ===\n${prefilterBookText(p.target)}`)
    .join("\n\n");
  const sourceText = group.some(
    (p) => p.source && p.source.trim() && p.source.trim() !== p.target.trim(),
  )
    ? group
        .map(
          (p) =>
            `=== ${unitLabel} ${p.n} ORIGINAL ===\n${prefilterBookText(p.source).slice(0, 3200)}`,
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
    return normalizeManuscriptBlocks(obj.blocks);
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
  return splitParas(prefilterBookText(p.target)).map((t) => ({
    type: "body",
    text: t,
    page: p.n,
    level: 0,
    confidence: 0.3,
  }));
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
function makeHTML(bilingual = false) {
  syncEditors();
  const pages = state.pages
    .map(
      (p, i) =>
        `<section class="page"><div class="pn">${i + 1}</div>${bilingual ? `<div class="grid"><article><h3>Original</h3><div>${esc(p.source).replace(/\n/g, "<br>")}</div></article><article><h3>Translation</h3><div>${esc(p.target || p.source).replace(/\n/g, "<br>")}</div></article></div>` : `<article>${esc(p.target || p.source).replace(/\n/g, "<br>")}</article>`}</section>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(base())}</title><style>@page{size:A4;margin:18mm 18mm 20mm}body{font-family:"Noto Serif SC","Songti SC","Times New Roman",serif;color:#111;line-height:1.75;margin:0}.page{page-break-after:always;position:relative}.pn{position:absolute;right:0;top:-8mm;font:9pt sans-serif;color:#777}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9mm}.grid article+article{border-left:1px solid #ddd;padding-left:9mm}article{font-size:10.5pt;text-align:justify}h3{font:600 9pt sans-serif;color:#666;border-bottom:1px solid #ddd;padding-bottom:4px}@media(max-width:800px){.grid{grid-template-columns:1fr}.grid article+article{border-left:0;padding-left:0;border-top:1px solid #ddd;padding-top:8px}}</style></head><body>${pages}</body></html>`;
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
      true_footnotes: $("trueFootnotes").checked,
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
function openPreview() {
  const blocks = state.manuscript?.blocks || [];
  const anchors = new Set(),
    notes = new Map();
  for (const b of blocks) {
    if (b.type === "footnote")
      notes.set(noteKey(b.note_scope, b.note_id), b.text);
    else
      for (const m of b.text.matchAll(/\[\[FN:([^:\]\n]+):([^\]\n]+)\]\]/g))
        anchors.add(noteKey(m[1], m[2]));
  }
  notes.delete("");
  const matched = [...anchors].filter((k) => notes.has(k));
  const noNote = [...anchors].filter((k) => !notes.has(k));
  const noAnchor = [...notes.keys()].filter((k) => !anchors.has(k));
  const headings = blocks.filter((b) => b.type in HEADING_TYPES);
  const body = blocks.filter((b) => b.type === "body").length;
  $("previewStats").innerHTML = [
    ["结构块", blocks.length],
    ["标题", headings.length],
    ["正文段落", body],
    ["注号", anchors.size],
    ["注释", notes.size],
    ["已配对", matched.length],
  ]
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join("");
  $("previewToc").innerHTML = headings.length
    ? headings
        .map(
          (h) =>
            `<li class="lv${HEADING_TYPES[h.type]}"><span>${esc(h.text.replace(/\[\[FN:[^\]]+\]\]/g, ""))}</span>${h.page ? `<em>p.${h.page}</em>` : ""}</li>`,
        )
        .join("")
    : '<li class="empty">没有识别到章节标题，导出的 Word 将没有目录层级。</li>';
  const list = (arr, label) =>
    arr.length
      ? `<p class="warn-text">${label}（${arr.length}）</p><ul class="key-list">${arr
          .slice(0, 30)
          .map((k) => `<li>${esc(k)}</li>`)
          .join(
            "",
          )}${arr.length > 30 ? `<li>…另有 ${arr.length - 30} 条</li>` : ""}</ul>`
      : "";
  const fb = state.manuscript?.fallbackPages || [];
  $("previewNotes").innerHTML =
    (fb.length
      ? `<p class="warn-text">第 ${fb.join("、")} 页未能识别结构，已按正文段落保留，这些页中的标题和注释不会单独排版。</p>`
      : "") +
    (anchors.size || notes.size
      ? `<p>${matched.length} 个注号找到了对应注释${$("trueFootnotes").checked ? "，导出时转为 Word 页下注" : ""}。</p>`
      : "<p>没有识别到注释。</p>") +
    list(noNote, "有注号但缺少注释") +
    list(noAnchor, "有注释但正文中找不到注号");
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
