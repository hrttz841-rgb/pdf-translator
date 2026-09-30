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
  "skipRefs",
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
function markStep(n) {
  document.querySelectorAll(".step").forEach((x) => {
    const k = +x.dataset.step;
    x.className = "step " + (k < n ? "done" : k === n ? "active" : "");
  });
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
  const ps = state.pages;
  $("mParsed").textContent = ps.filter((p) => p.parsed).length;
  $("mTranslated").textContent = ps.filter((p) => p.translated).length;
  $("mProofed").textContent = ps.filter((p) => p.proofed).length;
  $("mApproved").textContent = ps.filter((p) => p.approved).length;
}
function setButtonsForProject({ hasPdf = false, hasTranslation = false } = {}) {
  for (const id of [
    "reconstructBtn",
    "saveProject",
    "exportHtml",
    "exportWord",
  ])
    $(id).disabled = !hasTranslation;
  $("exportBilingual").disabled = !state.pages.some(
    (p) => p.source && p.target,
  );
  $("exportBilingualWord").disabled = !state.pages.some(
    (p) => p.source && p.target,
  );
  $("auditBtn").disabled = !hasTranslation;
  $("proofBtn").disabled = !hasTranslation;
  $("runBtn").disabled = !hasPdf;
  $("parseBtn").disabled = !hasPdf;
  $("translateBtn").disabled = !hasPdf;
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
  };
}
function activateImportedProject(name, pages, kind) {
  if (!pages?.length) throw new Error("没有识别到可导入的译文内容");
  state.pdf = null;
  state.fileName = name || "已有译文";
  state.manuscript = null;
  state.importMode = kind || "translated";
  state.current = 0;
  state.pages = pages.map((p, i) =>
    importedPage(Number(p.n) || i + 1, p.source || "", p.target || ""),
  );
  setButtonsForProject({
    hasPdf: false,
    hasTranslation: state.pages.some((p) => p.target.trim()),
  });
  markStep(6);
  status(
    `已导入已有${kind === "bilingual" ? "双语" : "中文译文"} · ${state.pages.length} 个文本单元，可直接 AI 书稿重建`,
  );
  log(
    `导入已有${kind === "bilingual" ? "双语" : "译文"}文件，跳过 OCR 与翻译。`,
  );
  showPage(0);
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
    if (cur && cur.length + para.length > 7000) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  if (cur) chunks.push(cur);
  return {
    kind: "translated",
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
    activateImportedProject(name, obj.pages, obj.kind);
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
      })),
      obj.pages.some((p) => p.source && p.target) ? "bilingual" : "translated",
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
    activateImportedProject(name, obj.pages, obj.kind);
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
  }));
  setButtonsForProject({ hasPdf: true, hasTranslation: false });
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
    d.style.top = (viewport.height - b.y - b.h) * sy + "px";
    d.style.width = b.w * sx + "px";
    d.style.height = Math.max(8, b.h * sy) + "px";
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
  $("pageState").textContent = st;
  $("pageState").className =
    "pill " +
    (p.approved || p.proofed || p.translated ? "ok" : p.parsed ? "warn" : "");
  $("pageMeta").innerHTML =
    `<span class="chip">${p.layout === "imported" ? "导入文稿" : p.layout === "double" ? "双栏" : p.layout === "single" ? "单栏" : "未判断"}</span><span class="chip">${state.pdf ? (p.ocr ? "OCR" : "文本层") : "跳过 OCR/翻译"}</span><span class="chip">${p.charCount || 0} 字符</span>`;
  if (state.pdf) {
    $("canvasWrap").style.display = "flex";
    await renderPage(p.n);
  } else {
    $("canvasWrap").style.display = "none";
    $("overlay").innerHTML = "";
  }
  updateMetrics();
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
    const line = { text, x: minX, y: r.y, w: maxX - minX, h };
    const gap = current ? Math.abs(current.lastY - r.y) : 999;
    const sameColumn = current && Math.abs(current.x - line.x) < pageW * 0.12;
    if (current && sameColumn && gap < Math.max(18, h * 1.7)) {
      current.text += (current.text.endsWith("-") ? "\n" : " ") + text;
      current.w = Math.max(current.w, line.w);
      current.h += gap || h;
      current.lastY = r.y;
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
    for (const s of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const n = normalizeHF(s);
      if (n.length < 3 || n.length > 140) continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const need = Math.max(2, Math.ceil(state.pages.length * 0.35));
  state.headerFooter = new Set(
    [...counts].filter(([, c]) => c >= need).map(([s]) => s),
  );
  log(`检测到 ${state.headerFooter.size} 个重复页眉/页脚模式。`);
}
function applyCleanup() {
  markStep(3);
  if ($("removeHeaders").checked) headerFooterCandidates();
  for (const p of state.pages) {
    let lines = (p.raw || p.source || "").split(/\n+/);
    if ($("removeHeaders").checked)
      lines = lines.filter((s) => {
        const n = normalizeHF(s);
        return !state.headerFooter.has(n) && !/^\s*\d{1,4}\s*$/.test(s);
      });
    p.source = cleanText(lines.join("\n"));
    p.charCount = p.source.length;
  }
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
    help: "自定义：填写 OpenAI-compatible API Base 与模型 ID。",
  },
};
function providerName() {
  return $("provider").value || "deepseek";
}
function syncProviderUI() {
  const p = providerName(),
    x = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.custom;
  $("providerSettings").value = p;
  $("modelSettings").value = $("model").value;
  $("providerHelp").textContent = x.help;
}
function applyProviderPreset(p) {
  const x = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.custom;
  $("provider").value = p;
  $("providerSettings").value = p;
  $("apiBase").value = x.base;
  $("model").value = x.model;
  $("modelSettings").value = x.model;
  $("providerHelp").textContent = x.help;
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
      ? `${label} Key 已保存到 ${x.storage} ${x.masked}`
      : `${label} 尚未保存 API Key`;
    $("deleteKeyBtn").disabled = !x.saved;
  } catch (e) {
    $("keyStatus").textContent = "无法读取 Key 状态：" + e.message;
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
  const r = await apiFetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch (e) {}
  if (!r.ok) throw new Error(data.error || raw || `HTTP ${r.status}`);
  return data.text;
}
function prevContext(idx) {
  const n = +$("contextChars").value || 0;
  if (!n || idx <= 0) return "";
  const t = state.pages[idx - 1].target || "";
  return t.slice(-n);
}
async function translatePage(idx) {
  syncEditors();
  const p = state.pages[idx];
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
async function runAll() {
  if (state.busy) return;
  state.busy = true;
  $("runBtn").disabled = true;
  try {
    for (let i = 0; i < state.pages.length; i++) {
      await parsePage(i);
      progress(i + 1, state.pages.length, "版面分析 / OCR");
    }
    applyCleanup();
    for (let i = 0; i < state.pages.length; i++) {
      await translatePage(i);
      progress(i + 1, state.pages.length, "翻译");
    }
    if ($("proofEnabled").checked)
      for (let i = 0; i < state.pages.length; i++) {
        await proofPage(i);
        progress(i + 1, state.pages.length, "校对");
      }
    markStep(6);
    status("完成。建议逐页人工检查后导出。");
    await showPage(state.current);
    log("完整处理流程完成。");
  } catch (e) {
    status("处理失败");
    log("错误：" + e.message);
    alert(e.message);
  } finally {
    state.busy = false;
    $("runBtn").disabled = false;
  }
}
async function auditAll() {
  syncEditors();
  if (!state.pages.some((p) => p.translated)) {
    alert("请先完成翻译");
    return;
  }
  try {
    status("正在做全文术语一致性检查…");
    const sample = state.pages
      .map((p, i) => `[P${i + 1}]\n${p.target}`)
      .join("\n\n")
      .slice(0, 40000);
    const out = await apiCall("audit", sample, "");
    alert(out);
    status("一致性检查完成（结果已弹出）");
  } catch (e) {
    alert(e.message);
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
      all = [];
    let context = "";
    for (let start = 0; start < state.pages.length; start += batch) {
      const group = state.pages
        .slice(start, start + batch)
        .filter((p) => p.target && p.target.trim());
      if (!group.length) continue;
      const unitLabel = state.pdf ? "PDF PAGE" : "IMPORTED TEXT UNIT";
      const text = group
        .map(
          (p) => `=== ${unitLabel} ${p.n} ===\n${prefilterBookText(p.target)}`,
        )
        .join("\n\n");
      const sourceText = group.some(
        (p) =>
          p.source && p.source.trim() && p.source.trim() !== p.target.trim(),
      )
        ? group
            .map(
              (p) =>
                `=== ${unitLabel} ${p.n} ORIGINAL ===\n${prefilterBookText(p.source).slice(0, 3200)}`,
            )
            .join("\n\n")
            .slice(0, 18000)
        : "";
      status(`书稿结构重建：第 ${group[0].n}-${group[group.length - 1].n} 页…`);
      const raw = await apiCall("reconstruct", text, context, sourceText);
      let obj;
      try {
        obj = parseModelJson(raw);
      } catch (e) {
        throw new Error(
          `第 ${group[0].n}-${group[group.length - 1].n} 页的书稿结构 JSON 无法解析，请重试。模型返回开头：${raw.slice(0, 220)}`,
        );
      }
      const blocks = normalizeManuscriptBlocks(obj.blocks);
      all.push(...blocks);
      context = all
        .slice(-8)
        .filter((b) =>
          [
            "part",
            "chapter",
            "section",
            "subsection",
            "preface_title",
          ].includes(b.type),
        )
        .map((b) => `${b.type}: ${b.text}`)
        .join("\n")
        .slice(-1800);
      progress(
        Math.min(start + batch, state.pages.length),
        state.pages.length,
        "AI 书稿重建",
      );
    }
    state.manuscript = {
      version: 2,
      createdAt: new Date().toISOString(),
      blocks: normalizeManuscriptBlocks(all),
    };
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
    $("reconstructBtn").disabled = false;
    $("reconstructBtn").textContent = old;
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
  if (!state.pages.some((p) => p.target && p.target.trim())) {
    alert("没有可导出的译文");
    return;
  }
  const btn = mode === "bilingual" ? $("exportBilingualWord") : $("exportWord");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === "bilingual" ? "正在生成…" : "正在重建书稿…";
  try {
    let manuscript = null;
    if (mode !== "bilingual") manuscript = await reconstructBook(false);
    status(
      mode === "bilingual"
        ? "正在生成原文译文对照 Word…"
        : "正在生成可直接阅读的中文书稿 Word…",
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
      manuscript,
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
    const blob = await r.blob();
    download(
      base() +
        (mode === "bilingual" ? "_原文译文对照版.docx" : "_中文书稿版.docx"),
      blob,
    );
    status("Word 已生成并开始下载。");
    log(
      `已导出${mode === "bilingual" ? "原文译文对照" : "中文正式书稿"} Word。`,
    );
  } catch (e) {
    status("Word 导出失败");
    alert("Word 导出失败：" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
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
$("file").onchange = (e) => e.target.files[0] && loadPdf(e.target.files[0]);
$("importBtn").onclick = async () => {
  try {
    await importExisting($("importFile").files[0]);
  } catch (e) {
    status("导入失败");
    alert("导入已有译文失败：" + e.message);
  }
};
$("importFile").onchange = () => {
  $("importHint").textContent = $("importFile").files[0]
    ? `已选择：${$("importFile").files[0].name}。点击“导入已有译文”。`
    : "双语文件优先：保留原文用于结构判断；纯译文也可直接生成中文书稿。";
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
  const f = e.dataTransfer.files[0];
  if (f?.type === "application/pdf") loadPdf(f);
};
$("prev").onclick = () => showPage(state.current - 1);
$("next").onclick = () => showPage(state.current + 1);
$("runBtn").onclick = runAll;
$("parseBtn").onclick = async () => {
  try {
    await parsePage(state.current);
  } catch (e) {
    alert(e.message);
  }
};
$("translateBtn").onclick = async () => {
  try {
    await translatePage(state.current);
    await showPage(state.current);
  } catch (e) {
    alert(e.message);
  }
};
$("proofBtn").onclick = async () => {
  try {
    await proofPage(state.current);
    await showPage(state.current);
  } catch (e) {
    alert(e.message);
  }
};
$("auditBtn").onclick = auditAll;
$("reconstructBtn").onclick = async () => {
  try {
    await reconstructBook(true);
  } catch (e) {
    status("书稿重建失败");
    alert(e.message);
  }
};
$("approveBtn").onclick = () => {
  syncEditors();
  state.pages[state.current].approved = true;
  showPage(state.current);
};
$("exportWord").onclick = () => exportWord("translated");
$("exportBilingualWord").onclick = () => exportWord("bilingual");
$("saveProject").onclick = exportProject;
$("exportHtml").onclick = () =>
  download(
    base() + "_translated.html",
    new Blob([makeHTML(false)], { type: "text/html;charset=utf-8" }),
  );
$("exportBilingual").onclick = () =>
  download(
    base() + "_bilingual.html",
    new Blob([makeHTML(true)], { type: "text/html;charset=utf-8" }),
  );
$("provider").onchange = () => applyProviderPreset($("provider").value);
$("model").oninput = () => {
  $("modelSettings").value = $("model").value;
};
$("providerSettings").onchange = () =>
  applyProviderPreset($("providerSettings").value);
$("modelSettings").oninput = () => {
  $("model").value = $("modelSettings").value;
};
$("settingsBtn").onclick = () => {
  $("modal").classList.add("open");
  syncProviderUI();
  refreshKeyStatus();
};
$("closeModal").onclick = async () => {
  try {
    $("provider").value = $("providerSettings").value;
    $("model").value = $("modelSettings").value;
    saveSettings();
    if ($("apiKey").value.trim()) await saveKey();
    $("modal").classList.remove("open");
    showPage(state.current);
  } catch (e) {
    alert("保存设置失败：" + e.message);
  }
};
$("saveKeyBtn").onclick = async () => {
  try {
    if (!$("apiKey").value.trim()) {
      alert("请先输入当前平台 API Key");
      return;
    }
    await saveKey();
  } catch (e) {
    alert(e.message);
  }
};
$("deleteKeyBtn").onclick = async () => {
  try {
    await deleteKey();
  } catch (e) {
    alert(e.message);
  }
};
$("testBtn").onclick = async () => {
  try {
    $("testResult").textContent = "测试中…";
    const x = await apiCall("ping", "Hello");
    $("testResult").textContent = "连接成功：" + x.slice(0, 80);
  } catch (e) {
    $("testResult").textContent = "连接失败：" + e.message;
  }
};
$("clearBtn").onclick = () => {
  if (confirm("清空当前项目？")) location.reload();
};
for (const id of ["sourceEditor", "targetEditor"])
  $(id).addEventListener("input", () => (editorsDirty = true));
loadSettings();
if (location.protocol.startsWith("http")) $("backend").value = location.origin;
if (!$("provider").value) $("provider").value = "deepseek";
$("providerSettings").value = $("provider").value;
$("modelSettings").value = $("model").value;
syncProviderUI();
window.addEventListener("beforeunload", saveSettings);
setTimeout(refreshKeyStatus, 300);
