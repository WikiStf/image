"""imageAI 统一对话服务：接入真实大模型，任何异常都优雅降级，绝不报错。"""

from __future__ import annotations

import datetime as _dt
import hashlib
import math
import random
import re

from .connectors import hub
from .models import MODEL_IDS, THINKING_MODELS, build_reasoning, system_prompt


def _fallback_answer(prompt: str, model_id: str) -> str:
    """离线兜底回答（本地知识引擎），保证永远有回复。"""
    p = prompt.strip()
    low = p.lower()
    if re.search(r"你好|hello|hi|在吗", low):
        return f"你好！我是 {model_id}（imageAI 家族成员，由 WikiGroup 开发）。今天想聊点什么？"
    if "你是谁" in p or "介绍" in p and "自己" in p:
        return (f"我是 {model_id}，imageAI 全家族的一员，由 WikiGroup 开发。"
                "我支持多轮对话、文生图、图像理解、语音合成/识别、翻译与连接器工具调用；"
                "配置 API Key 后即可直连云端大模型获得更强能力。")
    if any(k in p for k in ("时间", "几点", "日期", "今天")):
        now = _dt.datetime.now()
        return f"现在是 {now:%Y年%m月%d日 %H:%M:%S}，星期{'一二三四五六日'[now.weekday()]}。"
    m = re.search(r"(\d+(?:\.\d+)?)\s*[-+*/×÷^]\s*(\d+(?:\.\d+)?)", p.replace("×", "*").replace("÷", "/"))
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        op = re.search(r"[-+*/^]", p[m.end() - 10:m.end() + 3] or "-+-*/^")
        sym = op.group(0) if op else "+"
        val = {"+": a + b, "-": a - b, "*": a * b, "/": (a / b if b else "除数不能为0"), "^": a ** b}.get(sym, a + b)
        return f"{a} {sym} {b} = {val}"
    if "天气" in p:
        return hub.run("weather", p)
    if "wiki" in low or "维基百科" in p:
        term = re.sub(r".*(搜索|查询|查一下|看看)", "", p).strip() or p[:20]
        return f"关于「{term[:30]}」：可访问 https://zh.wikipedia.org/wiki/{term} 获取百科资料。（离线模式建议联网后重试）"
    seed = int(hashlib.md5(p.encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    pts = ["明确问题核心与目标", "拆解关键要素与约束", "结合知识给出可行方案", "总结要点并提示注意事项"]
    body = "\n".join(f"{i}. {t}" for i, t in enumerate(pts, 1))
    extra = "" if model_id not in THINKING_MODELS else "\n（如需更深入的逐层剖析，可切换到 image Ultra。）"
    return (f"围绕「{p[:40]}」，给你一份结构化参考：\n{body}\n"
            f"提示：当前为本地演示模式，配置 IMAGEAI_API_KEY 后将由真实大模型生成高质量回答。{extra}")


class ChatService:
    def __init__(self) -> None:
        self.ai = None
        self.online = False
        try:
            from .client import ImageAI
            ai = ImageAI()
            if not ai.demo_mode:
                self.ai, self.online = ai, True
        except Exception:
            self.ai, self.online = None, False
        self.history: list[dict] = []
        self.model = "image1.0"

    def set_model(self, model_id: str) -> str:
        if model_id in MODEL_IDS:
            self.model = model_id
        return self.model

    def _remote_chat(self, prompt: str) -> tuple[str | None, str | None]:
        if not self.ai or getattr(self.ai, "demo_mode", False):
            return None, None
        try:
            old_sys, old_hist = self.ai.system_prompt, self.ai.history
            self.ai.system_prompt = system_prompt(self.model)
            remote_model = self.model if self.model in ("image1.0", "imageMax") else self.ai.config.model
            thinking = self.model in THINKING_MODELS
            reasoning = ""
            if thinking:
                rc = getattr(self.ai.config, "reasoning_model", None) or remote_model
                resp = self.ai.client.chat.completions.create(
                    model=rc, messages=[{"role": "system", "content": self.ai.system_prompt},
                                        {"role": "user", "content": prompt}], max_tokens=900)
                msg = resp.choices[0].message
                reasoning = getattr(msg, "reasoning_content", "") or ""
                answer = self.ai._extract_content(msg) or ""
                if not isinstance(answer, str):
                    answer = str(answer)
                if not reasoning:
                    reasoning = "\n".join(build_reasoning(prompt))
                self.ai.system_prompt, self.ai.history = old_sys, old_hist
                return answer, reasoning
            answer = self.ai.chat(prompt, model=remote_model, remember=False)
            self.ai.system_prompt, self.ai.history = old_sys, old_hist
            answer = answer if isinstance(answer, str) else str(answer)
            return (answer.strip() or None), None
        except Exception:
            return None, None

    def chat(self, prompt: str) -> dict:
        try:
            return self._chat_inner(prompt)
        except Exception:
            p = (prompt or "").strip()
            return {"reply": _fallback_answer(p, self.model), "thinking": "",
                    "model": self.model, "sources": [], "mode": "demo"}

    def _chat_inner(self, prompt: str) -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            return {"reply": "请输入内容～", "thinking": "", "model": self.model, "sources": []}

        used_connector, conn_note = None, ""
        cid = self._detect_connector(prompt)
        if cid:
            used_connector = cid
            result = hub.run(cid, prompt)
            conn_note = result

        if conn_note and self.model not in THINKING_MODELS:
            return self._pack(prompt, conn_note, "", used_connector)

        answer, reasoning = self._remote_chat(prompt + (f"\n\n【连接器结果】{conn_note}" if conn_note else ""))
        if answer is None and self.online:
            try:
                a2 = self.ai.chat(prompt, remember=False)
                a2 = a2 if isinstance(a2, str) else str(a2)
                answer = a2.strip() or None
            except Exception:
                answer = None
        if answer is None:
            answer = _fallback_answer(prompt, self.model)
            if reasoning and self.model not in THINKING_MODELS:
                reasoning = ""
            elif reasoning is None and self.model in THINKING_MODELS:
                reasoning = "\n".join(build_reasoning(prompt))
        if conn_note and conn_note not in answer:
            answer = f"{conn_note}\n\n{answer}"

        return self._pack(prompt, answer, reasoning or "", used_connector)

    def _pack(self, prompt: str, answer: str, reasoning: str, cid: str | None) -> dict:
        if self.model in THINKING_MODELS and not (reasoning or "").strip():
            reasoning = "\n".join(build_reasoning(prompt))
        if self.model not in THINKING_MODELS:
            reasoning = ""
        sources = []
        if cid:
            c = hub.connectors[cid]
            sources.append({"icon": c.icon, "name": c.name})
        self.history.append({"role": "user", "content": prompt})
        self.history.append({"role": "assistant", "content": answer})
        if len(self.history) > 40:
            self.history = self.history[-40:]
        return {"reply": answer.strip(), "thinking": reasoning, "model": self.model,
                "sources": sources, "mode": "online" if self.online else "demo"}

    @staticmethod
    def _detect_connector(prompt: str) -> str | None:
        p = prompt.lower()
        enabled = {c.id for c in hub.active()}
        rules = [
            ("datetime", ("几点", "时间", "日期", "今天星期", "现在")),
            ("calculator", ("计算", "算一下", "+", "-", "*", "×", "÷", "等于")),
            ("weather", ("天气", "气温", "下雨")),
            ("web_search", ("搜索", "查一下", "查询", "最新")),
            ("translate_api", ("翻译成", "英文怎么说")),
            ("shell", ("运行命令", "执行命令")),
            ("notes_view", ("我的笔记", "笔记列表")),
            ("notes", ("记住", "备注", "记一下")),
        ]
        for cid, keys in rules:
            if cid in enabled and any(k in p for k in keys):
                if cid == "calculator" and not re.search(r"\d", prompt):
                    continue
                return cid
        return None

    def draw(self, prompt: str) -> dict:
        try:
            return self._draw_inner(prompt)
        except Exception:
            return {"kind": "image", "image_svg": self._svg_art(prompt or "创意插画"),
                    "reply": "🎨 已为你生成创意插画（本地渲染）"}

    def _draw_inner(self, prompt: str) -> dict:
        prompt = (prompt or "").strip() or "一只赛博朋克风格的猫"
        if self.ai and not getattr(self.ai, "demo_mode", False):
            try:
                paths = self.ai.generate_image(prompt, path="static/gen.png")
                import base64
                with open(paths[0], "rb") as f:
                    img = base64.b64encode(f.read()).decode()
                return {"kind": "image", "image": img, "reply": f"🎨 已按描述生成图片（{self.model}）"}
            except Exception:
                pass
        svg = self._svg_art(prompt)
        return {"kind": "image", "image_svg": svg,
                "reply": f"🎨 「{prompt[:30]}」创意插画（本地渲染 · 配置 API Key 后可用真实图像大模型）"}

    @staticmethod
    def _svg_art(prompt: str) -> str:
        seed = int(hashlib.md5(prompt.encode()).hexdigest()[:8], 16)
        rng = random.Random(seed)
        hue = rng.randint(0, 360)
        shapes = []
        for i in range(9):
            x, y = rng.randint(40, 760), rng.randint(40, 560)
            r = rng.randint(30, 160)
            h = (hue + rng.randint(-50, 50)) % 360
            if rng.random() < 0.5:
                shapes.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="hsl({h},80%,60%)" opacity="0.5"/>')
            else:
                w, hh = rng.randint(60, 260), rng.randint(50, 200)
                rot = rng.randint(0, 360)
                shapes.append(f'<rect x="{x}" y="{y}" width="{w}" height="{hh}" rx="24" '
                              f'fill="hsl({h},75%,55%)" opacity="0.45" transform="rotate({rot} {x} {y})"/>')
        esc = prompt.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")[:46]
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">'
                f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
                f'<stop offset="0" stop-color="hsl({hue},70%,18%)"/>'
                f'<stop offset="1" stop-color="hsl({(hue + 90) % 360},70%,30%)"/></linearGradient></defs>'
                '<rect width="800" height="600" fill="url(#g)"/>' + "".join(shapes) +
                f'<text x="400" y="560" font-size="26" fill="#fff" text-anchor="middle" '
                f'font-family="sans-serif" opacity="0.9">{esc}</text></svg>')

    def connectors(self) -> list[dict]:
        return hub.catalog()

    def toggle(self, cid: str, on: bool) -> bool:
        if cid in hub.connectors:
            return hub.toggle(cid, on)
        return False


service = ChatService()
