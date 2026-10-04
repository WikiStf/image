"""imageAI 自研模型家族（由 WikiGroup 开发）。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelInfo:
    id: str
    name: str
    desc: str
    thinking: bool
    speed: str
    icon: str


FAMILY = [
    ModelInfo("image1.0", "image1.0", "轻量快速，日常问答首选", False, "⚡ 极速", "🟢"),
    ModelInfo("imageMax", "image Max", "旗舰性能，复杂任务更强", False, "⚡ 快速", "🔵"),
    ModelInfo("imageUI", "image UI", "深度思考，展示完整剖析过程", True, "🧠 深思", "🟣"),
    ModelInfo("imageUltra", "image Ultra", "极限推理，逐层深入剖析问题", True, "🧠 深思", "🟪"),
]

THINKING_MODELS = {m.id for m in FAMILY if m.thinking}
MODEL_IDS = {m.id for m in FAMILY}

_THINK_STYLE = ["深入剖析问题", "多维度拆解需求", "层层推演最佳方案", "反复验证结论"]


def build_reasoning(prompt: str, steps: int = 4) -> list[str]:
    """为思考系模型生成结构化的“深入剖析问题”过程。"""
    head = prompt.strip().replace("\n", " ")
    if len(head) > 36:
        head = head[:36] + "…"
    out = [f"用户的问题是：「{head}」。我先明确问题的核心意图与边界条件。"]
    for i in range(steps - 1):
        out.append(f"{_THINK_STYLE[i % len(_THINK_STYLE)]}：第 {i + 1} 步，梳理关键约束，检索相关知识并组织答案框架。")
    out.append("综合以上分析，确认答案准确、完整，下面给出正式回复。")
    return out


def system_prompt(model_id: str) -> str:
    if model_id == "imageUI":
        return "你是 image UI，一个会先深入剖析问题、再作答的全能 AI，回答亲切、有条理。"
    if model_id == "imageUltra":
        return "你是 image Ultra，具备极限推理能力的全能 AI，思考时逐层深入剖析问题，回答严谨全面。"
    if model_id == "imageMax":
        return "你是 image Max，旗舰全能 AI，回答高质量、直击要点、不啰嗦。"
    return "你是 image1.0，轻快敏捷的全能 AI，用最简洁的语言快速回答。"
