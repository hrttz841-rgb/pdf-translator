# Scholar PDF Translator v2.9

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Created and maintained by Yifei Liu.** · [中文说明](README.md)

Scholar PDF Translator is a local tool for translating long academic PDFs (monographs, edited volumes, reports, scanned books) and rebuilding the translation into a structured manuscript you can actually read, cite and edit.

Most AI translation workflows stop once each sentence has been translated. For long scholarly texts the harder problems are structural: two-column pages read in the wrong order, running headers and library stamps mixed into the body, chapter and section levels flattened, endnotes separated from the passages they annotate, and a result that is still a pile of pages rather than a book. This project treats PDF translation as a document-processing pipeline:

**PDF → text layer / OCR → layout and column detection → cleanup → AI translation → proofreading against the source → manuscript structure recovery → table of contents → endnote pairing → native Word footnotes → Chinese manuscript or bilingual Word export**

<p align="center">
  <img src="ui-overview.png" width="90%" alt="Scholar PDF Translator interface: settings on the left, source page in the middle, editable translation on the right">
</p>

The interface follows the processing pipeline. The stage bar at the top shows progress for parsing, cleanup, translation, proofreading, manuscript reconstruction and human review, and each stage can be run on its own. A full run can be paused and resumed without re-sending finished pages to the model; a failing page is flagged instead of stopping the whole book, and failed pages can be retried in one click. The page list marks every page's status and can be filtered to untranslated, unproofed, unreviewed or failed pages. The source can be viewed as the page image with detected text blocks, as editable text, or side by side with the translation paragraph by paragraph. Before a manuscript is exported, a preview lists the detected chapter tree and flags notes that could not be paired. Keyboard shortcuts: `Alt+←/→` to change page, `Ctrl/⌘+Enter` to translate the page, `Ctrl/⌘+Shift+Enter` to mark it reviewed and move on, `?` for the full list. Dark mode follows the system setting.

## Before and after

Raw machine translation of a scanned book often leaves the structure broken: download metadata mixed with the copyright page, a table of contents half translated, inconsistent heading levels.

<p align="center">
  <img src="before-ai-raw-1.png" width="48%" alt="Raw AI translation with metadata, copyright page and body text mixed together">
  <img src="before-ai-raw-2.png" width="48%" alt="Raw AI translation with a partially translated, disordered table of contents">
</p>

After manuscript reconstruction the same material becomes a continuous Chinese book draft with a title page, a regenerated table of contents and properly typeset body text.

<p align="center">
  <img src="after-cover.png" width="32%" alt="Rebuilt title page">
  <img src="after-toc.png" width="32%" alt="Rebuilt table of contents">
  <img src="after-preface.png" width="32%" alt="Rebuilt preface">
</p>

## Features

- **Text layer first, OCR when needed.** Born-digital PDFs are read from their text layer; only scanned or weak pages go through OCR (English, Simplified Chinese and Japanese bundled).
- **Layout recovery.** Text-block coordinates are used to detect single and double columns and restore reading order.
- **Noise removal.** Repeated headers, footers, page numbers, library stamps, scan-platform watermarks and stray OCR fragments are detected and removed.
- **Two-pass AI processing.** A translation pass with cross-page context, followed by a proofreading pass that re-reads source and translation together to catch omissions, mistranslations, OCR errors, names, numbers and terminology drift. A glossary and custom instructions can be supplied.
- **Manuscript reconstruction.** The translated text is re-segmented into book title, author, parts, chapters, sections, body text, block quotations, captions, notes, bibliography and appendices.
- **Real footnotes.** Chapter endnotes and book endnotes are paired with their note markers and exported as native Word footnotes.
- **Exports.** Continuous Chinese manuscript (.docx), side-by-side bilingual Word, translated or bilingual HTML, and a project JSON file.
- **Start from an existing translation.** Import bilingual HTML, translated HTML, .docx or project JSON to skip OCR and translation and go straight to reconstruction.

## Supported AI providers

DeepSeek, OpenAI, Anthropic Claude, Google Gemini, Alibaba Qwen (DashScope, OpenAI-compatible), Moonshot Kimi, OpenRouter, and any OpenAI-compatible endpoint. Model IDs are editable; the presets are defaults only, so check each provider's current documentation for available models.

API keys are stored per provider in the operating system's credential store (macOS Keychain, Windows DPAPI, or a user-only file on Linux) and are never written to HTML, project files or the repository.

## Getting started

**macOS:** double-click `启动翻译工具.command`; stop with `停止翻译工具.command`.

**Windows:** double-click `启动翻译工具.bat` (requires Python 3; the Word export dependency is installed on first run); stop with `停止翻译工具.bat`.

**Linux or manual start:**

```bash
python3 -m pip install --user -r requirements.txt
python3 server.py
```

Then open the address printed in the terminal (default `http://127.0.0.1:8765`). Set `PDF_TRANSLATOR_PORT` to use another port. Always open the tool through that address; opening `index.html` directly from disk cannot reach the local service.

## Privacy and security

PDF parsing and OCR run in the browser. pdf.js, Tesseract.js and the bundled OCR language data ship with the repository (`vendor/`), so these steps work offline. Only the text sent for translation, proofreading or reconstruction leaves your machine, and only to the provider you configure.

The local service listens on `127.0.0.1` only and protects your keys from other websites open in the same browser:

- no cross-origin access, with Host and Origin checks that also block DNS rebinding;
- a random per-launch session token, injected only into the tool's own page, is required on every API call;
- a saved key is only ever sent to the API base registered when it was saved (or the provider's default). To use a different endpoint, re-enter and save the key.

## Development

| File | Purpose |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | Browser UI, PDF parsing, OCR and workflow |
| `server.py` | Local HTTP server entry point and access control |
| `providers.py` | Provider presets |
| `keystore.py` | Credential storage and allowed-endpoint registry |
| `ai_client.py` | Task prompts and provider API calls |
| `docx_export.py` | Reflow, Word manuscript and bilingual export, Word import |
| `vendor/` | Bundled pdf.js and Tesseract.js |

```bash
python3 -m pip install -r requirements.txt pytest
python3 -m pytest
```

GitHub Actions runs the test suite on Linux, macOS and Windows for every push.

## Scope

This is an evolving research tool. Complex scans, mathematical notation, unusual layouts and heavily corrupted OCR still need human review. It is meant to automate the mechanical work between a raw PDF and a readable translated manuscript, leaving terminology, interpretation and fact-checking to the researcher.

## Contributors

- [@hrttz841-rgb](https://github.com/hrttz841-rgb): project lead, product design, academic use cases and maintenance
- OpenAI ChatGPT: prototyping, code iteration, documentation and testing

Issues and pull requests are welcome, especially on OCR, layout analysis, footnote recovery, academic terminology, Word typesetting and model support.
