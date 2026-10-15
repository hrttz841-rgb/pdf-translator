// 对话式入口：把文件夹或文件交给对话框，逐个完成解析、翻译、校对、书稿重建并保存到本地。
// 处理逻辑全部复用 app.js 中的引擎（engine），这里只负责对话、队列和文件来源。
import { engine } from "./app.js";

const $ = (id) => document.getElementById(id);
const OUTPUT_DIR_NAME = "译文";
const OWN_OUTPUT_RE = /_(中文书稿版|原文译文对照版)\.docx$/i;
const PROJECT_RE = /\.translation-project\.json$/i;
const SUPPORTED_RE = /\.(pdf|docx|html?)$/i;
const STAGE_LABELS = {
  解析: "解析",
  翻译: "翻译",
  校对: "校对",
  "AI 书稿重建": "书稿重建",
};
const PATH_RE = /^\s*(["']?)(~[\\/]|~$|\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/;

const chat = {
  jobs: [],
  batches: [],
  running: false,
  pauseRequested: false,
  current: null, // 正在处理（或暂停中）的任务
  loaded: null, // 引擎中当前载入的是哪个任务
  waitingForKey: false,
};

// ---------- 小工具 ----------
function esc(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, onclick, cls = "btn small") {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
}
function isSupported(rel) {
  const parts = rel.split("/");
  const name = parts.at(-1);
  if (parts.some((p) => p.startsWith(".")) || name.startsWith("~$"))
    return false;
  if (parts.length > 1 && parts[0] === OUTPUT_DIR_NAME) return false;
  if (OWN_OUTPUT_RE.test(name)) return false;
  return PROJECT_RE.test(name) || SUPPORTED_RE.test(name);
}
function kindOf(name) {
  if (PROJECT_RE.test(name)) return "项目文件";
  const ext = (name.split(".").pop() || "").toLowerCase();
  return { pdf: "PDF", docx: "Word", html: "HTML", htm: "HTML" }[ext] || ext;
}
function countKinds(names) {
  const c = {};
  for (const n of names) c[kindOf(n)] = (c[kindOf(n)] || 0) + 1;
  return Object.entries(c)
    .map(([k, v]) => `${v} 个 ${k}`)
    .join("、");
}
function prettyPath(p) {
  return p || "";
}
function outputs() {
  const s = engine.settings();
  return { manuscript: s.manuscript, bilingual: s.bilingual };
}
async function api(path, body) {
  const r = await engine.apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    let msg = await r.text();
    try {
      msg = JSON.parse(msg).error || msg;
    } catch (e) {}
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return r;
}
const naturalSort = (a, b) =>
  a.rel.localeCompare(b.rel, "zh-CN", { numeric: true });

// ---------- 消息 ----------
function scrollToEnd() {
  const s = $("chatScroll");
  requestAnimationFrame(() => (s.scrollTop = s.scrollHeight));
}
function addMessage(role, content) {
  const m = el("div", "msg " + role);
  if (role === "assistant") m.appendChild(el("div", "avatar", "译"));
  const body = el("div", "msg-body");
  for (const part of [].concat(content)) {
    if (part == null) continue;
    if (typeof part === "string") {
      for (const para of part.split(/\n{2,}/)) {
        const p = el("p");
        p.textContent = para;
        body.appendChild(p);
      }
    } else body.appendChild(part);
  }
  m.appendChild(body);
  $("chatThread").appendChild(m);
  scrollToEnd();
  return body;
}
function actions(...buttons) {
  const row = el("div", "msg-actions");
  for (const b of buttons) if (b) row.appendChild(b);
  return row;
}
function typing() {
  const body = addMessage("assistant", el("div", "typing", "正在理解…"));
  return () => body.parentElement.remove();
}
function settingsButton(label = "设置模型与 Key") {
  return button(label, () => engine.openSettings("ai"));
}

// ---------- 设置摘要 ----------
function renderSettings() {
  const s = engine.settings();
  const chips = [];
  const src = s.source_lang === "auto" ? "自动识别" : s.labels.source_lang;
  chips.push(`${src} → ${s.labels.target_lang}`);
  chips.push(s.labels.style.split("：")[0]);
  chips.push(s.proof ? "翻译后校对" : "不校对");
  const outs = [s.manuscript && "中文书稿", s.bilingual && "对照稿"].filter(
    Boolean,
  );
  chips.push(outs.length ? outs.join(" + ") : "只保存项目文件");
  if (s.glossary.trim())
    chips.push(`术语 ${s.glossary.split("\n").filter((l) => l.includes("=")).length} 条`);
  if (s.requirements.trim()) chips.push("有额外要求");
  const box = $("chatSettings");
  box.replaceChildren();
  for (const c of chips) box.appendChild(el("span", "chip", c));
  const eng = el("span", "chip engine" + (s.keySaved ? "" : " needs-key"));
  eng.textContent = s.keySaved
    ? `${s.provider} · ${s.model || "未填写模型"}`
    : `${s.provider} · 尚未设置 Key`;
  box.appendChild(eng);
  const edit = button("修改", () => engine.openSettings("output"), "link-btn");
  box.appendChild(edit);
}

// ---------- 队列卡片 ----------
const STATUS_TEXT = {
  waiting: "等待",
  running: "处理中",
  paused: "已暂停",
  done: "已完成",
  skipped: "已跳过",
  error: "出错",
};
function renderJob(job) {
  const row = job.row;
  row.className = "job s-" + job.status;
  row.querySelector(".job-status").textContent =
    job.stageText || STATUS_TEXT[job.status];
  const bar = row.querySelector(".job-bar i");
  bar.style.width = (job.status === "done" ? 100 : job.pct || 0) + "%";
  row.querySelector(".job-bar").hidden = !(
    job.status === "running" || job.status === "paused"
  );
  const note = row.querySelector(".job-note");
  note.textContent = job.error || job.note || "";
  note.hidden = !note.textContent;
  const act = row.querySelector(".job-actions");
  act.replaceChildren();
  if (job.status === "done" && job.written?.length) {
    const kind =
      job.written.find((w) => w.kind === "manuscript")?.kind ||
      job.written[0].kind;
    act.appendChild(
      button(
        "显示",
        () =>
          api("/api/output/open", {
            out_id: job.batch.outId,
            rel: job.rel,
            kind,
          }).catch((e) => addMessage("assistant", "打开失败：" + e.message)),
        "link-btn",
      ),
    );
  }
  renderBatch(job.batch);
}
function renderBatch(b) {
  const jobs = b.jobs;
  const n = (s) => jobs.filter((j) => j.status === s).length;
  const done = n("done"),
    skipped = n("skipped"),
    err = n("error");
  const finished = done + skipped + err;
  const head = b.card.querySelector(".queue-progress");
  const running = jobs.some((j) => j.status === "running");
  const paused = jobs.some((j) => j.status === "paused");
  head.textContent =
    finished === jobs.length
      ? `完成 ${done}${skipped ? ` · 跳过 ${skipped}` : ""}${err ? ` · 出错 ${err}` : ""}`
      : `${running ? "进行中" : paused || chat.pauseRequested ? "已暂停" : "排队中"} ${finished}/${jobs.length}`;
  const eta = b.card.querySelector(".queue-eta");
  eta.textContent = running ? $("eta")?.textContent || "" : "";
  const toggle = b.card.querySelector(".queue-toggle");
  const active = finished < jobs.length;
  toggle.hidden = !active;
  toggle.textContent = chat.pauseRequested || paused ? "继续" : "暂停";
}
function createBatchCard(b) {
  const card = el("div", "queue-card");
  const head = el("div", "queue-head");
  const title = el("div", "queue-title");
  title.appendChild(el("strong", "", b.name));
  title.appendChild(el("span", "queue-progress"));
  title.appendChild(el("span", "queue-eta"));
  head.appendChild(title);
  const btns = el("div", "queue-buttons");
  const toggle = button(
    "暂停",
    () => (chat.pauseRequested ? resume() : pause()),
    "btn small queue-toggle",
  );
  btns.appendChild(toggle);
  btns.appendChild(
    button(
      "打开译文文件夹",
      () =>
        api("/api/output/open", { out_id: b.outId }).catch((e) =>
          addMessage("assistant", "打开失败：" + e.message),
        ),
      "btn small quiet",
    ),
  );
  head.appendChild(btns);
  card.appendChild(head);
  const list = el("ol", "job-list");
  for (const job of b.jobs) {
    const li = el("li", "job");
    li.innerHTML =
      '<i class="dot"></i><span class="job-name"></span><span class="job-status"></span><span class="job-actions"></span><span class="job-bar" hidden><i></i></span><span class="job-note" hidden></span>';
    li.querySelector(".job-name").textContent = job.rel;
    li.querySelector(".job-name").title = job.rel;
    job.row = li;
    list.appendChild(li);
  }
  card.appendChild(list);
  b.card = card;
  for (const job of b.jobs) renderJob(job);
  return card;
}

// ---------- 接收文件 ----------
async function addBatch({ name, files, source, folderId, outId, outDir, skipped = 0, done = [] }) {
  files.sort(naturalSort);
  if (!files.length) {
    addMessage(
      "assistant",
      `「${name}」里没有找到可以处理的文件。支持 PDF、Word（.docx）、HTML，以及本工具保存的项目文件（.translation-project.json）。`,
    );
    return;
  }
  const b = { name, outId, outDir, jobs: [] };
  const doneSet = new Set(done);
  for (const f of files)
    b.jobs.push({
      batch: b,
      rel: f.rel,
      name: f.rel.split("/").pop(),
      file: f.file || null,
      folderId,
      source,
      status: doneSet.has(f.rel) ? "skipped" : "waiting",
      note: doneSet.has(f.rel) ? "此前已经译好，这次跳过" : "",
    });
  chat.batches.push(b);
  chat.jobs.push(...b.jobs);
  const todo = b.jobs.filter((j) => j.status === "waiting");
  const lines = [
    `收到「${name}」：共 ${files.length} 个可处理的文件（${countKinds(files.map((f) => f.rel))}）` +
      (skipped ? `，另有 ${skipped} 个不支持的文件已忽略` : "") +
      "。",
  ];
  if (doneSet.size)
    lines.push(
      `其中 ${doneSet.size} 个此前已经译好，这次跳过；想重新翻译的话，先删掉译文文件夹里对应的文件再发一次。`,
    );
  lines.push(`译文保存在：${prettyPath(outDir)}`);
  const s = engine.settings();
  if (!todo.length) lines.push("没有需要处理的文件。");
  else if (!s.keySaved) {
    await engine.refreshKeyStatus();
  }
  const keyOk = engine.settings().keySaved;
  if (todo.length && !keyOk) {
    lines.push(
      `开始前需要先设置 ${s.provider} 的 API Key。保存后我会自动开始；Key 用环境变量提供的话，直接回复“开始”。`,
    );
    chat.waitingForKey = true;
  } else if (todo.length) lines.push(chat.running ? "已加入队列，当前文件完成后接着处理。" : "现在开始处理。");
  addMessage("assistant", [
    lines.join("\n\n"),
    createBatchCard(b),
    todo.length && !keyOk ? actions(settingsButton()) : null,
  ]);
  if (todo.length && keyOk) pump();
}
async function addServerFolder(pathText) {
  let obj;
  try {
    const r = await api("/api/folder/list", {
      path: pathText,
      outputs: outputs(),
    });
    obj = await r.json();
  } catch (e) {
    addMessage("assistant", `没能打开这个路径：${e.message}`);
    return;
  }
  await addBatch({
    name: obj.name,
    files: obj.files.map((f) => ({ rel: f.rel })),
    source: "server",
    folderId: obj.folder_id,
    outId: obj.out_id,
    outDir: obj.out_dir,
    skipped: obj.skipped,
    done: obj.files.filter((f) => f.done).map((f) => f.rel),
  });
  if (obj.truncated)
    addMessage(
      "assistant",
      "这个文件夹里的文件太多，只列出了前 500 个。剩下的可以分批发送子文件夹。",
    );
}
async function addLocalFiles(name, items) {
  const all = items.length;
  const files = items.filter((f) => isSupported(f.rel));
  let prep;
  try {
    const r = await api("/api/output/prepare", {
      name,
      rels: files.map((f) => f.rel),
      outputs: outputs(),
    });
    prep = await r.json();
  } catch (e) {
    addMessage("assistant", `无法准备保存位置：${e.message}`);
    return;
  }
  await addBatch({
    name,
    files,
    source: "local",
    outId: prep.out_id,
    outDir: prep.out_dir,
    skipped: all - files.length,
    done: prep.done,
  });
}
function stamp() {
  const d = new Date(),
    z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}
// 拖入的条目可能是文件夹：递归读出其中的文件
function readEntry(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (f) => resolve([{ rel: prefix + f.name, file: f }]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory || entry.name.startsWith(".")) {
      resolve([]);
      return;
    }
    const reader = entry.createReader(),
      out = [];
    const readBatch = () =>
      reader.readEntries(
        async (entries) => {
          if (!entries.length) {
            resolve(out);
            return;
          }
          for (const e of entries)
            out.push(...(await readEntry(e, prefix + entry.name + "/")));
          readBatch();
        },
        () => resolve(out),
      );
    readBatch();
  });
}
async function handleDrop(dt) {
  const entries = [...(dt.items || [])]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    const single = entries.length === 1 && entries[0].isDirectory;
    let items = [];
    for (const e of entries) items.push(...(await readEntry(e, "")));
    if (single) {
      const root = entries[0].name + "/";
      items = items.map((f) => ({ ...f, rel: f.rel.slice(root.length) }));
    }
    const name = single
      ? entries[0].name
      : entries.length === 1
        ? entries[0].name.replace(/\.[^.]+$/, "")
        : `拖入的文件 ${stamp()}`;
    userFilesMessage(name, items.length, single);
    await addLocalFiles(name, items);
    return;
  }
  const files = [...(dt.files || [])];
  if (files.length) handlePicked(files, false);
}
function handlePicked(fileList, fromFolder) {
  const files = [...fileList];
  if (!files.length) return;
  let name, items;
  if (fromFolder) {
    name = (files[0].webkitRelativePath || "").split("/")[0] || "所选文件夹";
    items = files.map((f) => ({
      rel: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name,
      file: f,
    }));
  } else {
    name =
      files.length === 1
        ? files[0].name.replace(/\.[^.]+$/, "")
        : `所选文件 ${stamp()}`;
    items = files.map((f) => ({ rel: f.name, file: f }));
  }
  userFilesMessage(name, items.length, fromFolder);
  addLocalFiles(name, items);
}
function userFilesMessage(name, count, isFolder) {
  const chip = el("div", "file-chip");
  chip.appendChild(el("span", "file-icon", isFolder ? "▤" : "▢"));
  chip.appendChild(el("span", "", name));
  chip.appendChild(el("span", "file-count", `${count} 个文件`));
  addMessage("user", chip);
}

// ---------- 队列处理 ----------
function onActivity(ev) {
  const job = chat.current;
  if (!job || job.status !== "running") return;
  if (ev.type === "progress") {
    const stage = STAGE_LABELS[ev.label];
    if (stage) {
      job.stage = stage;
      job.pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      job.stageText = `${stage} ${ev.done}/${ev.total} 页`;
    } else if (/^OCR/.test(ev.label)) {
      job.stageText = `${job.stage || "解析"} · ${ev.label} ${ev.done}%`;
    }
    renderJob(job);
  } else if (ev.type === "status" && /正在生成|正在重建|书稿重建/.test(ev.text)) {
    renderJob(job);
  }
}
async function loadJob(job) {
  let file = job.file;
  if (!file) {
    const r = await api("/api/folder/read", {
      folder_id: job.folderId,
      rel: job.rel,
    });
    file = new File([await r.blob()], job.name, {
      type: /\.pdf$/i.test(job.name) ? "application/pdf" : "",
    });
  }
  const info = await engine.loadFile(file);
  job.note = {
    pdf: `PDF，${info.pages} 页`,
    original: "Word / HTML 原文，先翻译再排版",
    translated: "已有译文，直接进行书稿重建",
    bilingual: "已有双语译文，直接进行书稿重建",
  }[info.kind];
  chat.loaded = job;
}
async function processJob(job) {
  chat.current = job;
  job.status = "running";
  job.error = "";
  job.stageText = "读取文件";
  job.pct = 0;
  renderJob(job);
  if (chat.loaded !== job) await loadJob(job);
  renderJob(job);
  const res = await engine.run();
  if (res.paused) {
    job.status = "paused";
    job.stageText = `已暂停${job.stage ? "（" + job.stage + "）" : ""}`;
    renderJob(job);
    return "paused";
  }
  if (!res.hasTarget) throw new Error("没有得到任何译文");
  job.stageText = "保存";
  renderJob(job);
  const out = await engine.export(job.batch.outId, job.rel);
  job.written = out.written;
  const notes = [];
  const kinds = out.written.map(
    (w) => ({ manuscript: "中文书稿", bilingual: "对照稿", project: "项目文件" })[w.kind],
  );
  notes.push(`已保存${kinds.join("、")}`);
  if (res.manuscriptError)
    notes.push(`书稿重建失败（${res.manuscriptError}），已改存对照稿`);
  if (res.errorPages.length)
    notes.push(
      `第 ${res.errorPages.slice(0, 12).join("、")}${res.errorPages.length > 12 ? " 等" : ""} 页处理失败，可在工作台打开项目文件补译`,
    );
  job.note = notes.join("；");
  job.status = "done";
  job.stageText = "";
  chat.loaded = null;
  renderJob(job);
  return "done";
}
function finishedBatch(b) {
  return b.jobs.every((j) => ["done", "skipped", "error"].includes(j.status));
}
function reportBatch(b) {
  if (b.reported) return;
  b.reported = true;
  const done = b.jobs.filter((j) => j.status === "done");
  const err = b.jobs.filter((j) => j.status === "error");
  const skipped = b.jobs.filter((j) => j.status === "skipped").length;
  const parts = [`「${b.name}」处理完毕：${done.length} 个完成`];
  if (skipped) parts.push(`${skipped} 个跳过`);
  if (err.length) parts.push(`${err.length} 个出错`);
  let text = parts.join("，") + "。";
  if (err.length)
    text +=
      "\n\n" +
      err
        .slice(0, 8)
        .map((j) => `${j.rel}：${j.error}`)
        .join("\n") +
      "\n\n出错的文件可以回复“重试”再处理一次。";
  addMessage("assistant", [
    text,
    actions(
      button("打开译文文件夹", () =>
        api("/api/output/open", { out_id: b.outId }).catch((e) =>
          addMessage("assistant", "打开失败：" + e.message),
        ),
      ),
    ),
  ]);
}
async function pump() {
  if (chat.running) return;
  chat.running = true;
  chat.pauseRequested = false;
  chat.waitingForKey = false;
  engine.state.batchActive = true;
  try {
    while (!chat.pauseRequested) {
      const job =
        chat.jobs.find((j) => j.status === "paused") ||
        chat.jobs.find((j) => j.status === "waiting");
      if (!job) break;
      try {
        const r = await processJob(job);
        if (r === "paused") break;
      } catch (e) {
        if (engine.isFatal(e)) {
          job.status = "paused";
          job.stageText = "等待设置";
          renderJob(job);
          chat.pauseRequested = true;
          const s = engine.settings();
          const keyIssue = /Key|401|403/.test(e.message);
          addMessage("assistant", [
            keyIssue
              ? `${s.provider} 的 API Key 不可用（${e.message}）。设置好之后回复“继续”，会从中断处接着做。`
              : `处理被中止：${e.message}\n\n检查设置后回复“继续”即可从中断处接着做。`,
            actions(settingsButton("打开设置")),
          ]);
          break;
        }
        job.status = "error";
        job.error = e.message;
        job.stageText = "";
        chat.loaded = null;
        renderJob(job);
      } finally {
        if (finishedBatch(job.batch)) reportBatch(job.batch);
      }
    }
  } finally {
    chat.running = false;
    engine.state.batchActive = false;
    for (const b of chat.batches) renderBatch(b);
    // 暂停结束后工作台的按钮恢复可用
    engine.showPage(engine.state.current).catch(() => {});
  }
}
function pause() {
  if (!chat.running) return "现在没有正在处理的文件。";
  chat.pauseRequested = true;
  engine.pause();
  for (const b of chat.batches) renderBatch(b);
  return "好的，正在进行的几页完成后暂停。回复“继续”会从中断处接着做。";
}
function resume() {
  const pending = chat.jobs.some((j) =>
    ["waiting", "paused"].includes(j.status),
  );
  if (!pending) return "没有等待处理的文件。";
  chat.pauseRequested = false;
  pump();
  return "继续处理。";
}
function retry() {
  const errs = chat.jobs.filter((j) => j.status === "error");
  if (!errs.length) return "没有出错的文件。";
  for (const j of errs) {
    j.status = "waiting";
    j.error = "";
    j.batch.reported = false;
    renderJob(j);
  }
  chat.pauseRequested = false;
  pump();
  return `重新处理 ${errs.length} 个出错的文件。`;
}
function openLatest() {
  const b = chat.batches.at(-1);
  if (!b) return "还没有处理过文件。";
  api("/api/output/open", { out_id: b.outId }).catch((e) =>
    addMessage("assistant", "打开失败：" + e.message),
  );
  return `已打开：${b.outDir}`;
}
function progressSummary() {
  if (!chat.jobs.length) return "还没有收到文件。把文件夹拖进来，或者粘贴文件夹路径就可以开始。";
  const c = (s) => chat.jobs.filter((j) => j.status === s).length;
  const cur = chat.jobs.find((j) => ["running", "paused"].includes(j.status));
  let t = `共 ${chat.jobs.length} 个文件：已完成 ${c("done")}，等待 ${c("waiting")}，跳过 ${c("skipped")}，出错 ${c("error")}。`;
  if (cur)
    t += `\n\n${cur.status === "paused" ? "暂停在" : "正在处理"}：${cur.rel}${cur.stageText ? "（" + cur.stageText + "）" : ""}`;
  const eta = $("eta")?.textContent;
  if (cur?.status === "running" && eta) t += `，当前阶段${eta}`;
  return t;
}
const HELP_TEXT =
  "用法很简单：\n\n" +
  "1. 把文件夹（或几个文件）拖进这个窗口，或者点“选择文件夹”，也可以粘贴文件夹路径，比如 ~/Downloads/文献。\n" +
  "2. 我会逐个完成解析、OCR、翻译、校对和书稿重建，译文保存成 Word。\n" +
  "3. 翻译要求可以直接说，比如“这批是法文，不要校对，另外出一份对照版，sovereignty 统一译为主权”。\n\n" +
  "处理中可以说“暂停”“继续”“进度”“重试”“打开文件夹”。想逐页检查某个文件，用右上角切换到工作台，打开译文文件夹里的项目文件即可。";

// ---------- 对话 ----------
const COMMANDS = [
  [/^(暂停|先停|停一下|停下|pause|stop)(吧|一下)?\s*[。.!！]?$/i, pause],
  [/^(继续|接着|恢复|resume|continue)(吧|处理|翻译)?\s*[。.!！]?$/i, resume],
  [/^(开始|开始吧|开始处理|开始翻译|start|go)\s*[。.!！]?$/i, resume],
  [/^(重试|再试一次|再试|重新处理出错的?(文件)?)\s*[。.!！]?$/, retry],
  [/^(打开|显示).{0,6}(文件夹|目录|译文)|保存在哪|存在哪/, openLatest],
  [/^(进度|状态|做到哪了?|到哪了|还要多久)\s*[？?]?$/, progressSummary],
  [/^(帮助|help|怎么用|如何使用|\?|？)\s*$/i, () => HELP_TEXT],
];
const SETTING_NAMES = {
  source_lang: "原文语言",
  target_lang: "目标语言",
  style: "翻译风格",
  proof: "校对",
  manuscript: "中文书稿 Word",
  bilingual: "对照 Word",
  ocr: "OCR",
  ocr_lang: "OCR 语言",
  footnote_numbering: "页下注编号",
  glossary: "术语表",
  requirements: "额外要求",
};
function describeChange(k, s) {
  if (k === "glossary") return "术语表";
  if (k === "requirements") return "额外要求";
  const v = s[k],
    label = s.labels[k];
  if (typeof v === "boolean") return `${SETTING_NAMES[k]}：${v ? "开启" : "关闭"}`;
  return `${SETTING_NAMES[k]}：${label}`;
}
async function askModel(text) {
  const done = typing();
  const s = engine.settings();
  const ctx = JSON.stringify({
    settings: {
      source_lang: s.source_lang,
      target_lang: s.target_lang,
      style: s.style,
      proof: s.proof,
      manuscript: s.manuscript,
      bilingual: s.bilingual,
      ocr: s.ocr,
      ocr_lang: s.ocr_lang,
      footnote_numbering: s.footnote_numbering,
      glossary: s.glossary,
      requirements: s.requirements,
    },
    queue: {
      total: chat.jobs.length,
      waiting: chat.jobs.filter((j) => j.status === "waiting").length,
      running: chat.current?.status === "running" ? chat.current.rel : null,
      paused: chat.jobs.some((j) => j.status === "paused"),
      errors: chat.jobs.filter((j) => j.status === "error").length,
    },
  });
  let res;
  try {
    res = await engine.chat(text, ctx);
  } catch (e) {
    done();
    if (engine.isFatal(e))
      addMessage("assistant", [
        `要理解这类要求需要先设置模型（翻译本身也要用到）：${e.message}`,
        actions(settingsButton()),
      ]);
    else
      addMessage(
        "assistant",
        `这句话我没能处理（${e.message}）。可以换个说法，或者直接在设置里修改。`,
      );
    return;
  }
  done();
  const changed = engine.apply(res || {});
  const after = engine.settings();
  const parts = [];
  if (res?.reply) parts.push(String(res.reply));
  if (changed.length) {
    const list = el("div", "change-list");
    for (const k of changed) list.appendChild(el("span", "chip ok", describeChange(k, after)));
    parts.push(list);
    if (chat.running)
      parts.push("正在处理的文件中还没翻译的页面，以及后面的文件，都会按新设置处理。");
  }
  let extra = "";
  switch (res?.action) {
    case "start":
    case "resume":
      extra = resume();
      break;
    case "pause":
      extra = pause();
      break;
    case "retry":
      extra = retry();
      break;
    case "open_output":
      extra = openLatest();
      break;
  }
  if (extra && extra !== res?.reply) parts.push(extra);
  if (!parts.length) parts.push("好的。");
  addMessage("assistant", parts);
  renderSettings();
}
async function send(text) {
  text = (text || "").trim();
  if (!text) return;
  addMessage("user", text);
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const paths = lines.filter((l) => PATH_RE.test(l));
  if (paths.length && paths.length === lines.length) {
    for (const p of paths) await addServerFolder(p);
    return;
  }
  for (const [re, fn] of COMMANDS)
    if (re.test(text)) {
      addMessage("assistant", fn());
      return;
    }
  await askModel(text);
}

// ---------- 视图切换与事件 ----------
function setMode(mode) {
  document.body.dataset.mode = mode;
  $("modeChat").classList.toggle("active", mode === "chat");
  $("modeWork").classList.toggle("active", mode === "work");
  $("modeChat").setAttribute("aria-selected", mode === "chat");
  $("modeWork").setAttribute("aria-selected", mode === "work");
  try {
    localStorage.setItem("sptMode", mode);
  } catch (e) {}
  if (mode === "work") engine.showPage(engine.state.current).catch(() => {});
  else $("chatInput").focus();
}
function autosize() {
  const t = $("chatInput");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

$("modeChat").onclick = () => setMode("chat");
$("modeWork").onclick = () => setMode("work");
$("composer").onsubmit = (e) => {
  e.preventDefault();
  const t = $("chatInput").value;
  $("chatInput").value = "";
  autosize();
  send(t);
};
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("chatInput").addEventListener("input", autosize);
$("pickFolder").onclick = () => $("folderInput").click();
$("pickFiles").onclick = () => $("filesInput").click();
$("folderInput").onchange = (e) => {
  handlePicked(e.target.files, true);
  e.target.value = "";
};
$("filesInput").onchange = (e) => {
  handlePicked(e.target.files, false);
  e.target.value = "";
};
const view = $("chatView");
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
view.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  view.classList.add("dragging");
});
view.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
view.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) view.classList.remove("dragging");
});
view.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  view.classList.remove("dragging");
  handleDrop(e.dataTransfer);
});
// 设置窗口关闭后刷新摘要；等待 Key 的任务在 Key 保存后自动开始
$("closeModal").addEventListener("click", () =>
  setTimeout(async () => {
    await engine.refreshKeyStatus();
    renderSettings();
    if (chat.waitingForKey && engine.settings().keySaved) {
      addMessage("assistant", "Key 已保存，开始处理。");
      pump();
    }
  }, 400),
);
for (const id of ["sourceLang", "targetLang", "style", "glossary", "customPrompt"])
  $(id).addEventListener("change", renderSettings);
engine.onActivity(onActivity);
setInterval(() => {
  if (chat.running) for (const b of chat.batches) renderBatch(b);
}, 5000);

// ---------- 启动 ----------
function welcome() {
  const s = engine.settings();
  const parts = [
    "把要翻译的文件夹拖进这个窗口，或者点下面的“选择文件夹”，也可以直接粘贴文件夹路径。我会逐个文件完成解析、翻译、校对和书稿重建，把 Word 译稿保存好。",
    "翻译要求直接告诉我就行，比如“原文是德文”“不要校对”“另外出一份对照版”“state capacity 译为国家能力”。",
  ];
  const row = actions(button("选择文件夹", () => $("folderInput").click(), "btn small primary"));
  if (!s.keySaved) {
    parts.push(`还没有设置 ${s.provider} 的 API Key，先设置一下。`);
    row.appendChild(settingsButton());
  }
  row.appendChild(button("怎么用？", () => send("怎么用"), "btn small quiet"));
  addMessage("assistant", [...parts, row]);
}
let mode = "chat";
try {
  mode = localStorage.getItem("sptMode") || "chat";
} catch (e) {}
setMode(mode === "work" ? "work" : "chat");
await engine.refreshKeyStatus();
renderSettings();
welcome();
