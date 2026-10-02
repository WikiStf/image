"""imageAI 核心引擎 —— 通过 OpenAI 兼容协议接入真实大模型。

支持的能力（"所有 AI 功能"）：
- chat / stream_chat : 多轮对话（文本生成）
- vision             : 图像理解（视觉大模型）
- generate_image     : 文生图
- edit_image         : 图像编辑
- tts / stt          : 语音合成 / 语音识别
- embed              : 文本向量化
- translate / summarize / rewrite / extract / classify / code ... : 高层任务封装
- tool-calling       : Function Calling（工具调用）
- Agent              : 带记忆 + 工具的自主智能体
"""

from __future__ import annotations

import base64
import mimetypes
import os
from typing import Any, Callable, Generator, Iterable

from openai import OpenAI

from .config import Config


class ImageAI:
    """imageAI：一个接入真实大模型的通用 AI 客户端。"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        **kwargs,
    ) -> None:
        self.config = Config.from_env(api_key=api_key, base_url=base_url, model=model, **kwargs)
        self.demo_mode = not bool(self.config.api_key)
        if self.demo_mode:  # 无 Key：本地演示模式，绝不抛错
            self.config.api_key = "imageai-demo"
        self.client = OpenAI(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            timeout=self.config.timeout,
            max_retries=self.config.max_retries,
        )
        self.history: list[dict] = []
        self.system_prompt = (
            "你是 imageAI，一个全能 AI 助手，可以对话、写作、编程、翻译、"
            "分析图片、生成图片、调用工具。回答准确、简洁、友好。"
        )

    # ------------------------------------------------------------------ #
    # 基础对话
    # ------------------------------------------------------------------ #
    def chat(
        self,
        prompt: str,
        *,
        system: str | None = None,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        tools: list[dict] | None = None,
        history: list[dict] | None = None,
        remember: bool = True,
        json_mode: bool = False,
    ) -> Any:
        """单轮/多轮对话。返回回复文本；若传入 tools 且模型触发工具，返回 tool_calls。"""
        messages = [
            {"role": "system", "content": system or self.system_prompt},
            *(history if history is not None else self.history),
            {"role": "user", "content": prompt},
        ]
        params: dict[str, Any] = {
            "model": model or self.config.model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens:
            params["max_tokens"] = max_tokens
        if tools:
            params["tools"] = tools
            params["tool_choice"] = "auto"
        if json_mode:
            params["response_format"] = {"type": "json_object"}

        if getattr(self, "demo_mode", False):
            raise RuntimeError("本地演示模式：未配置 API Key，请设置 IMAGEAI_API_KEY 以接入云端大模型。")
        resp = self.client.chat.completions.create(**params)
        msg = resp.choices[0].message
        content = self._extract_content(msg)

        if remember:
            self.history.append({"role": "user", "content": prompt})
            if content:
                self.history.append({"role": "assistant", "content": content})

        if isinstance(content, list):  # 部分网关返回 OpenAI Responses 风格的 output 列表
            text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "response.output_text")
            return text or (msg.content if isinstance(msg.content, str) else "")
        if tools and msg.tool_calls:
            return {"content": content, "tool_calls": [tc.model_dump() for tc in msg.tool_calls], "raw_message": msg}
        return content

    @staticmethod
    def _extract_content(msg) -> Any:
        """兼容不同网关的返回格式：字符串 / 内容块列表 / reasoning 模型仅有 reasoning_content。"""
        content = getattr(msg, "content", None)
        if isinstance(content, str) and content:
            return content
        if isinstance(content, list):
            text = "".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") in ("text", "output_text")
            )
            if text:
                return text
        reasoning = getattr(msg, "reasoning_content", None)
        if reasoning:
            return reasoning
        return content if isinstance(content, str) else (content or "")

    def stream_chat(self, prompt: str, *, system: str | None = None, **kwargs) -> Generator[str, None, None]:
        """流式对话，逐 token 产出文本，适合打字机效果。"""
        messages = [
            {"role": "system", "content": system or self.system_prompt},
            *self.history,
            {"role": "user", "content": prompt},
        ]
        if getattr(self, "demo_mode", False):
            raise RuntimeError("本地演示模式：未配置 API Key，请设置 IMAGEAI_API_KEY 以接入云端大模型。")
        stream = self.client.chat.completions.create(
            model=kwargs.pop("model", None) or self.config.model,
            messages=messages,
            stream=True,
            **kwargs,
        )
        collected = []
        stream_error = None
        try:
            for chunk in stream:
                if not getattr(chunk, "choices", None):
                    continue
                delta = chunk.choices[0].delta
                piece = getattr(delta, "content", None) or getattr(delta, "reasoning_content", None)
                if piece:
                    collected.append(piece)
                    yield piece
        except Exception as e:  # noqa: BLE001
            stream_error = e  # 网关可能不支持 SSE 流式，稍后降级
        if not collected:  # 部分网关收到 stream=true 仍返回普通 JSON（0 个增量）或直接报错 → 自动降级为一次性输出
            full = self.chat(prompt, system=system, history=messages[1:-1], remember=False, **kwargs)
            yield full
            collected.append(full)
        elif stream_error is not None:
            pass  # 已产出部分内容但流中断：保留已有输出
        self.history.append({"role": "user", "content": prompt})
        self.history.append({"role": "assistant", "content": "".join(collected)})

    def clear_history(self) -> None:
        self.history.clear()

    # ------------------------------------------------------------------ #
    # 视觉理解
    # ------------------------------------------------------------------ #
    def vision(self, prompt: str, image_path_or_url: str, *, model: str | None = None, detail: str = "auto") -> str:
        """图像理解：把本地图片或 URL 交给视觉大模型并提问。"""
        if image_path_or_url.startswith(("http://", "https://")):
            image_url = image_path_or_url
        else:
            mime = mimetypes.guess_type(image_path_or_url)[0] or "image/png"
            with open(image_path_or_url, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            image_url = f"data:{mime};base64,{b64}"

        resp = self.client.chat.completions.create(
            model=model or self.config.vision_model or self.config.model,
            messages=[
                {"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url, "detail": detail}},
                ]},
            ],
        )
        return resp.choices[0].message.content

    # ------------------------------------------------------------------ #
    # 图像生成 / 编辑
    # ------------------------------------------------------------------ #
    def generate_image(self, prompt: str, *, path: str = "generated.png", size: str = "1024x1024", n: int = 1, model: str | None = None) -> list[str]:
        """文生图，保存图片到本地并返回路径列表。

        兼容两类网关：/images/generations 端点（DALL·E 等）与聊天式图像模型
        （如 gemini image / qwen-vl 系列，通过 chat 接口返回 base64 图片）。
        """
        try:
            resp = self.client.images.generate(
                model=model or self.config.image_model,
                prompt=prompt,
                size=size,
                n=n,
            )
            items = list(getattr(resp, "data", None) or [])
        except Exception:
            items = []
        if not any(getattr(it, "b64_json", None) or getattr(it, "url", None) for it in items):
            items = self._chat_image_fallback(prompt, model)
        if not items:
            return []

        saved = []
        for i, item in enumerate(items or []):
            b64 = getattr(item, "b64_json", None) if not isinstance(item, dict) else item.get("b64_json")
            url = getattr(item, "url", None) if not isinstance(item, dict) else item.get("url")
            if b64:
                img_bytes = base64.b64decode(b64)
            elif url:
                import requests
                img_bytes = requests.get(url, timeout=60).content
            else:
                continue
            p = path if len(items) == 1 else f"{os.path.splitext(path)[0]}_{i}{os.path.splitext(path)[1]}"
            with open(p, "wb") as f:
                f.write(img_bytes)
            saved.append(p)
        if not saved:
            raise RuntimeError("图像模型未返回可解析的图片数据。")
        return saved

    def _chat_image_fallback(self, prompt: str, model: str | None) -> list[dict]:
        """通过 chat completions 接口获取图片（部分图像模型只支持聊天协议）。"""
        import json as _json
        import re
        resp = self.client.chat.completions.create(
            model=model or self.config.image_model,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = self._extract_content(resp.choices[0].message)
        text = raw if isinstance(raw, str) else _json.dumps(raw, ensure_ascii=False, default=str)
        found = []
        m = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)", text)
        if m:
            found.append({"b64_json": m.group(1)})
        else:
            for u in re.findall(r"https?://\S+\.(?:png|jpe?g|webp)\S*", text):
                found.append({"url": u.rstrip('"\\)')})
        return found

    def edit_image(self, image_path: str, prompt: str, *, path: str = "edited.png", mask: str | None = None) -> str:
        """图像编辑（局部重绘）。"""
        with open(image_path, "rb") as img, (open(mask, "rb") if mask else _NoneCtx()) as m:
            resp = self.client.images.edit(
                model=self.config.image_model,
                image=img,
                prompt=prompt,
                mask=m,
            )
        data = resp.data[0]
        img_bytes = base64.b64decode(data.b64_json) if getattr(data, "b64_json", None) else __import__("requests").get(data.url, timeout=60).content
        with open(path, "wb") as f:
            f.write(img_bytes)
        return path

    # ------------------------------------------------------------------ #
    # 语音
    # ------------------------------------------------------------------ #
    def tts(self, text: str, *, path: str = "speech.mp3", voice: str | None = None, model: str | None = None) -> str:
        """文字转语音，保存为音频文件。"""
        resp = self.client.audio.speech.create(
            model=model or self.config.tts_model,
            voice=voice or self.config.tts_voice,
            input=text,
        )
        resp.stream_to_file(path)
        return path

    def stt(self, audio_path: str, *, language: str | None = None, model: str | None = None) -> str:
        """语音转文字。"""
        kwargs: dict[str, Any] = {}
        if language:  # 不传时让 API 自动检测语言
            kwargs["language"] = language
        with open(audio_path, "rb") as f:
            resp = self.client.audio.transcriptions.create(
                model=model or self.config.stt_model,
                file=f,
                **kwargs,
            )
        return resp.text

    # ------------------------------------------------------------------ #
    # 向量 / Embedding
    # ------------------------------------------------------------------ #
    def embed(self, texts: str | Iterable[str], *, model: str | None = None) -> list[list[float]]:
        resp = self.client.embeddings.create(
            model=model or self.config.embedding_model,
            input=[texts] if isinstance(texts, str) else list(texts),
        )
        return [d.embedding for d in resp.data]

    # ------------------------------------------------------------------ #
    # 高层任务封装（"支持所有 AI 的功能"）
    # ------------------------------------------------------------------ #
    def _task(self, instruction: str, content: str, **kw) -> str:
        return self.chat(f"{instruction}\n\n内容：\n{content}", **kw)

    def translate(self, text: str, target_lang: str = "中文") -> str:
        return self._task(f"请把以下内容翻译成{target_lang}，只输出译文：", text, temperature=0.3)

    def summarize(self, text: str, length: int = 200) -> str:
        return self._task(f"请总结以下内容，控制在{length}字以内：", text, temperature=0.3)

    def rewrite(self, text: str, style: str = "更专业") -> str:
        return self._task(f"请把以下内容改写为{style}的风格：", text)

    def extract(self, text: str, fields: list[str]) -> dict:
        import json
        import re
        out = self.chat(
            f"从下面内容中提取字段 {fields}，以 JSON 输出，缺失字段填 null。\n内容：\n{text}",
            json_mode=True, temperature=0.1, remember=False,
        )
        if isinstance(out, dict):
            return out
        raw = str(out)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{[\s\S]*\}", raw)  # 容错：截取首个 JSON 对象（兼容 markdown 代码块包裹）
            if m:
                return json.loads(m.group(0))
            return {"_raw": raw}

    def classify(self, text: str, labels: list[str]) -> str:
        return self.chat(
            f"请把下面文本分类到且仅到一个标签：{labels}。只输出标签名。\n文本：{text}",
            temperature=0.0, remember=False,
        ).strip()

    def code(self, prompt: str, language: str = "python") -> str:
        return self.chat(f"请用{language}实现：{prompt}。只输出代码和必要注释。", temperature=0.2)

    # ------------------------------------------------------------------ #
    # Function Calling / Agent
    # ------------------------------------------------------------------ #
    def run_tool_loop(self, prompt: str, tool_funcs: dict[str, Callable], *, max_rounds: int = 5, **kw) -> str:
        """自动执行工具调用的对话循环（内置轻量 Agent）。"""
        schemas = [self._func_to_schema(fn) for fn in tool_funcs.values()]
        msgs: list[dict] = [{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}]
        model = kw.pop("model", None) or self.config.model
        for _ in range(max_rounds):
            resp = self.client.chat.completions.create(
                model=model, messages=msgs, tools=schemas, tool_choice="auto", **kw)
            msg = resp.choices[0].message
            if not msg.tool_calls:
                content = self._extract_content(msg)
                return content if isinstance(content, str) else str(content)
            msgs.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                import json
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                fn = tool_funcs.get(tc.function.name)
                if fn is None:
                    result = f"(未知工具 {tc.function.name})"
                else:
                    try:
                        result = fn(**args)
                    except Exception as e:  # 工具报错也回传给模型，让它自行修正
                        result = f"(工具执行失败: {e})"
                msgs.append({"role": "tool", "tool_call_id": tc.id, "content": str(result)})
        return "(达到最大工具调用轮数)"

    @staticmethod
    def _func_to_schema(fn: Callable) -> dict:
        import inspect, json as _json
        sig = inspect.signature(fn)
        props, required = {}, []
        type_map = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}
        for name, p in sig.parameters.items():
            t = type_map.get(p.annotation, "string")
            props[name] = {"type": t, "description": (fn.__doc__ or "").split(":")[-1].strip() if p.default is inspect._empty else ""}
            if p.default is inspect._empty:
                required.append(name)
        return {
            "type": "function",
            "function": {
                "name": fn.__name__,
                "description": (fn.__doc__ or fn.__name__).strip().splitlines()[0],
                "parameters": {"type": "object", "properties": props, "required": required},
            },
        }


class _NoneCtx:
    """占位上下文管理器（无 mask 时使用）。"""
    def __enter__(self):
        return None
    def __exit__(self, *a):
        return False
