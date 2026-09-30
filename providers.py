"""AI 平台配置。"""

PROVIDERS = {
    "deepseek": {
        "label": "DeepSeek",
        "env": "DEEPSEEK_API_KEY",
        "base": "https://api.deepseek.com",
        "model": "deepseek-chat",
        "kind": "openai",
    },
    "openai": {
        "label": "OpenAI",
        "env": "OPENAI_API_KEY",
        "base": "https://api.openai.com/v1",
        "model": "gpt-5",
        "kind": "openai",
    },
    "anthropic": {
        "label": "Anthropic Claude",
        "env": "ANTHROPIC_API_KEY",
        "base": "https://api.anthropic.com",
        "model": "claude-sonnet-4-5",
        "kind": "anthropic",
    },
    "gemini": {
        "label": "Google Gemini",
        "env": "GEMINI_API_KEY",
        "base": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-2.5-pro",
        "kind": "gemini",
    },
    "qwen": {
        "label": "Alibaba Qwen",
        "env": "DASHSCOPE_API_KEY",
        "base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "kind": "openai",
    },
    "kimi": {
        "label": "Moonshot Kimi",
        "env": "MOONSHOT_API_KEY",
        "base": "https://api.moonshot.cn/v1",
        "model": "moonshot-v1-32k",
        "kind": "openai",
    },
    "openrouter": {
        "label": "OpenRouter",
        "env": "OPENROUTER_API_KEY",
        "base": "https://openrouter.ai/api/v1",
        "model": "openai/gpt-5",
        "kind": "openai",
    },
    "custom": {
        "label": "OpenAI-compatible custom",
        "env": "PDF_TRANSLATOR_API_KEY",
        "base": "",
        "model": "",
        "kind": "openai",
    },
}


def normalize_provider(provider):
    p = (provider or "deepseek").strip().lower()
    return p if p in PROVIDERS else "custom"


def provider_info(provider):
    return PROVIDERS[normalize_provider(provider)]
