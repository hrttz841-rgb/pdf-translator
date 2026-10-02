# Scholar PDF Translator v2.12

面向学术论文、报告和扫描图书的本地 PDF 翻译与中文书稿重建工具。

## 支持的 AI 平台

- DeepSeek
- OpenAI
- Anthropic Claude
- Google Gemini
- Alibaba Qwen（DashScope OpenAI-compatible）
- Moonshot Kimi（OpenAI-compatible）
- OpenRouter
- 任意 OpenAI-compatible 自定义接口

API Key 按平台分别保存在系统安全凭据存储中：macOS 使用 Keychain；Windows 使用 DPAPI。切换平台不会覆盖其他平台的 Key。API Key 不写入 HTML、项目 JSON 或仓库。

## 核心流程

PDF → 文本层/按需 OCR → 版面和单双栏识别 → 清洗 → 翻译 → 校对 → AI 书稿重建 → 目录层级恢复 → 页眉页脚/馆藏章/扫描噪声清理 → 章末/书末注释配对 → Word 原生页下注 → 中文书稿 Word / 双语 Word。

## macOS

双击 `启动翻译工具.command`。

## Windows

双击 `启动翻译工具.bat`。需要 Python 3；首次运行会自动安装 Word 导出组件。

## 已有译文

支持导入双语 HTML、纯译文 HTML、`.docx` 或项目 JSON，跳过 OCR 和重新翻译，直接进行中文书稿重建。

## 模型设置

模型 ID 均可手动修改。各平台预设只是默认值，实际可用模型以你自己的 API 账户为准。

## 隐私

PDF 解析与 OCR 在浏览器本地完成，所需的 pdf.js、Tesseract.js 和常用 OCR 语言数据随程序分发，可以离线运行。需要 AI 的翻译、校对与书稿重建文本会发送给用户自行选择的 API 平台。

Windows 的 Key 使用 DPAPI 加密后保存，仅当前 Windows 用户可解密。

本地服务只接受本工具自己页面发出的请求，已保存的 Key 只会发送到保存时登记的 API 地址。
