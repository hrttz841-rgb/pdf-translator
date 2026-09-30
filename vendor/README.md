# 第三方库本地副本

这些文件随仓库分发，使 PDF 解析和 OCR 在离线环境下也能运行。页面会优先加载这里的文件，缺失时自动回退到 CDN。

| 目录 | 来源 | 版本 | 许可证 |
| --- | --- | --- | --- |
| `pdfjs/` | [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)（`build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`） | 4.10.38 | Apache-2.0 |
| `tesseract/tesseract.min.js`、`tesseract/worker.min.js` | [tesseract.js](https://www.npmjs.com/package/tesseract.js) | 5.1.1 | Apache-2.0 |
| `tesseract/core/` | [tesseract.js-core](https://www.npmjs.com/package/tesseract.js-core)（LSTM 与 SIMD-LSTM 两个 WebAssembly 版本） | 5.1.1 | Apache-2.0 |
| `tesseract/lang/` | [@tesseract.js-data](https://www.npmjs.com/org/tesseract.js-data) `eng`、`chi_sim`、`jpn`（`4.0.0_best_int`） | 1.0.0 | Apache-2.0 |

## 更新方法

```bash
npm pack pdfjs-dist@<版本> tesseract.js@<版本> tesseract.js-core@<版本> \
  @tesseract.js-data/eng @tesseract.js-data/chi_sim @tesseract.js-data/jpn
```

解压后按上表路径替换文件，并同步修改 `app.js` 中 `PDFJS_CDN` 与 `index.html` 中回退地址的版本号。

## 增加 OCR 语言

把对应语言的 `<lang>.traineddata.gz`（来自 `@tesseract.js-data/<lang>` 的 `4.0.0_best_int` 目录）放入 `tesseract/lang/`，再在 `index.html` 的 OCR 语言下拉框中加入选项即可。本地缺少某种语言数据时，会自动从 CDN 下载。
