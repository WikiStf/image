"""imageAI 配置系统。

支持三种方式提供大模型接入信息（优先级从高到低）：
1. 代码中显式传参：ImageAI(api_key=..., base_url=..., model=...)
2. 环境变量：IMAGEAI_API_KEY / IMAGEAI_BASE_URL / IMAGEAI_MODEL
3. .env 文件（项目根目录），例如：
   IMAGEAI_API_KEY=sk-xxxx
   IMAGEAI_BASE_URL=https://api.openai.com/v1   # 也可填 DeepSeek/月之暗面/通义等兼容地址
   IMAGEAI_MODEL=gpt-4o
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _load_dotenv(path: str = ".env") -> None:
    """极简 dotenv 解析，避免额外依赖。"""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


@dataclass
class Config:
    api_key: str | None = None
    base_url: str | None = None          # OpenAI 兼容网关地址
    model: str = "gpt-4o"                # 对话默认模型
    vision_model: str | None = None      # 视觉模型（默认为 model）
    image_model: str = "dall-e-3"        # 文生图模型
    tts_model: str = "tts-1"             # 语音合成模型
    tts_voice: str = "alloy"
    stt_model: str = "whisper-1"         # 语音识别模型
    embedding_model: str = "text-embedding-3-small"
    timeout: float = 120.0
    max_retries: int = 2
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, **overrides) -> "Config":
        _load_dotenv()
        kwargs = {}
        env_map = {
            "api_key": "IMAGEAI_API_KEY",
            "base_url": "IMAGEAI_BASE_URL",
            "model": "IMAGEAI_MODEL",
            "vision_model": "IMAGEAI_VISION_MODEL",
            "image_model": "IMAGEAI_IMAGE_MODEL",
            "tts_model": "IMAGEAI_TTS_MODEL",
            "stt_model": "IMAGEAI_STT_MODEL",
            "embedding_model": "IMAGEAI_EMBEDDING_MODEL",
        }
        for field_name, env_name in env_map.items():
            if overrides.get(field_name) is None and os.getenv(env_name):
                kwargs[field_name] = os.getenv(env_name)
        # OPENAI_* 作为兜底（方便直接复用已有 OpenAI Key）
        if overrides.get("api_key") is None and "api_key" not in kwargs:
            if os.getenv("OPENAI_API_KEY"):
                kwargs["api_key"] = os.getenv("OPENAI_API_KEY")
        if overrides.get("base_url") is None and "base_url" not in kwargs:
            if os.getenv("OPENAI_BASE_URL"):
                kwargs["base_url"] = os.getenv("OPENAI_BASE_URL")
        merged = {**{k: v for k, v in overrides.items() if v is not None}, **{k: v for k, v in kwargs.items() if k not in overrides or overrides[k] is None}}
        return cls(**merged)
