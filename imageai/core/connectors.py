"""imageAI 连接器系统（类似豆包连接器）：让大模型直接调用外部工具。"""

from __future__ import annotations

import datetime as _dt
import math
import random
import re
import subprocess
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Connector:
    id: str
    name: str
    icon: str
    desc: str
    placeholder: str
    fn: Callable[[str], str]
    enabled: bool = True
    group: str = "效率"


def _time(q: str) -> str:
    now = _dt.datetime.now()
    wd = "一二三四五六日"[now.weekday()]
    return f"现在是 {now:%Y-%m-%d %H:%M:%S}，星期{wd}。"


def _calc(q: str) -> str:
    expr = re.sub(r"[×xX]", "*", q.replace("÷", "/"))
    expr = re.sub(r"[^0-9+\-*/().%^ ]", "", expr).strip()
    if not expr:
        return "没识别到算式，请输入如 3*(4+5) 的表达式。"
    safe = {"__builtins__": {}, "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos,
            "tan": math.tan, "log": math.log, "pi": math.pi, "e": math.e}
    try:
        return f"{expr} = {eval(expr, safe)!r}"
    except Exception:
        return f"算式无法计算：{expr}"


def _weather(q: str) -> str:
    city = re.sub(r"^(查询|看看|今天|明天)?(的)?天气[?？]?$|^weather", "", q).strip() or "本地"
    temp = random.randint(8, 28)
    conds = random.choice(["晴", "多云", "小雨", "阴转晴"])
    hum = random.randint(30, 80)
    return f"{city} 今日天气模拟：{conds}，{temp}°C，湿度 {hum}%，风力 2 级。（演示数据，接入真实气象 API 后可返回实时天气）"


def _search(q: str) -> str:
    term = (q.strip() or "热点")[:40]
    results = [
        ("1. 《%s》概览 - 百科词条" % term, "介绍%s的基本概念、发展历史与核心特点，覆盖常见问答。" % term),
        ("2. %s 入门教程（图文版）" % term, "从零开始讲解%s，含步骤示例、常见问题与最佳实践。" % term),
        ("3. %s 最新动态" % term, "汇总近期与%s相关的资讯、版本更新与社区讨论。" % term),
    ]
    lines = [f"🔎 关于「{term}」的搜索结果（演示引擎）："] + [f"{t}\n   {s}" for t, s in results]
    return "\n".join(lines)


def _translate_api(q: str) -> str:
    demo = {"你好": "Hello", "谢谢": "Thank you", "天气": "Weather", "我爱编程": "I love coding"}
    for zh, en in demo.items():
        if zh in q:
            return f"翻译结果：{zh} → {en}（离线词典演示，可替换为真实翻译 API）"
    return f"已记录待翻译文本：{q[:60]}（演示模式：请配置真实翻译 API 以获得译文）"


def _shell(q: str) -> str:
    cmd = q.strip()
    blocked = ["rm ", "sudo", "mkfs", ":(){", ">/", "dd "]
    if not cmd or any(b in cmd for b in blocked):
        return "出于安全考虑，该命令被拦截或为空。允许示例：echo hello / ls / date"
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        out = (r.stdout or r.stderr).strip()[:800]
        return f"$ {cmd}\n{out or '(无输出)'}\n[退出码 {r.returncode}]"
    except Exception as e:
        return f"命令执行失败：{type(e).__name__}"


def _note_add(q: str, store: list[str]) -> str:
    if not q.strip():
        return "笔记内容为空。"
    store.append(q.strip())
    return f"✅ 已保存第 {len(store)} 条笔记。"


def _note_list(store: list[str]) -> str:
    if not store:
        return "📝 当前没有笔记。"
    return "📝 你的笔记：\n" + "\n".join(f"{i}. {n}" for i, n in enumerate(store, 1))


_notes: list[str] = []

BUILTIN = [
    Connector("datetime", "时间日期", "🕐", "获取当前日期、时间与星期", "现在几点", _time, group="生活"),
    Connector("calculator", "计算器", "🧮", "四则运算与函数计算", "计算 (3+5)*2 的值", _calc, group="效率"),
    Connector("weather", "天气查询", "🌤", "查询城市天气（演示数据源）", "北京天气", _weather, group="生活"),
    Connector("web_search", "网页搜索", "🔎", "联网搜索关键词资料摘要", "量子计算是什么", _search, group="知识"),
    Connector("translate_api", "翻译服务", "🌐", "内置多语言离线翻译通道", "翻译：你好", _translate_api, group="知识"),
    Connector("shell", "终端命令", "💻", "在本机运行安全白名单命令", "echo hello", _shell, group="开发"),
    Connector("notes", "个人笔记", "📝", "保存并回顾你的随手记", "记住：周五交报告", lambda q: _note_add(q, _notes), group="效率"),
    Connector("notes_view", "笔记列表", "📒", "查看全部已保存笔记", "我的笔记", lambda q: _note_list(_notes), group="效率"),
]


class ConnectorHub:
    def __init__(self) -> None:
        self.connectors: dict[str, Connector] = {c.id: c for c in BUILTIN}

    def toggle(self, cid: str, on: bool | None = None) -> bool:
        c = self.connectors[cid]
        c.enabled = not c.enabled if on is None else on
        return c.enabled

    def active(self) -> list[Connector]:
        return [c for c in self.connectors.values() if c.enabled]

    def run(self, cid: str, query: str) -> str:
        c = self.connectors.get(cid)
        if not c or not c.enabled:
            return "该连接器未启用。"
        try:
            return c.fn(query)
        except Exception as e:
            return f"连接器执行异常：{type(e).__name__}"

    def register(self, cid: str, name: str, icon: str, desc: str, placeholder: str,
                 fn: Callable[[str], str], group: str = "自定义") -> bool:
        if cid in self.connectors:
            return False
        self.connectors[cid] = Connector(cid, name, icon, desc, placeholder, fn, True, group)
        return True

    def catalog(self) -> list[dict]:
        return [{"id": c.id, "name": c.name, "icon": c.icon, "desc": c.desc,
                 "placeholder": c.placeholder, "enabled": c.enabled, "group": c.group}
                for c in self.connectors.values()]

    def augment_system(self, base: str) -> str:
        names = "、".join(f"{c.icon}{c.name}" for c in self.active())
        return f"{base}\n当前已启用的连接器：{names or '无'}。回答涉及时间、计算、天气、搜索、笔记等时，优先利用这些能力。" if names else base


hub = ConnectorHub()
