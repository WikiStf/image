#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
package.py — 项目打包脚本（任务 3：一键生成 AI_Chat_Project.zip）

用法：python package.py            # 在项目根目录运行
产物：AI_Chat_Project.zip

规则：
  - 仅打包"白名单"必要文件（见 INCLUDE），杜绝 node_modules/.env/server.log 等
    无关或敏感内容混入；
  - 额外做一层黑名单 + 密钥扫描兜底：任何包含疑似 API Key 的文件会被拒绝入包并告警。
"""
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(ROOT, "AI_Chat_Project.zip")

# ---- 白名单：交付必需文件 / 目录（目录会递归，但受黑名单约束）----
INCLUDE = [
    "index.html",
    "app.js",
    "proxy-server.js",
    "README.md",
    ".gitignore",
    ".env.example",          # 模板（无真实 Key），方便用户 cp .env.example .env
    "start.bat",
    "start-daemon.bat",
    "ecosystem.config.js",
    "package.json",
    "LICENSE",
    ".vscode",               # 调试配置目录
]

# ---- 黑名单：任何层级命中即排除（无关/敏感/生成物）----
EXCLUDE_NAMES  = {"node_modules", "__pycache__", ".git", "logs", "dist_backup"}
EXCLUDE_SUFFIX = (".log", ".log.1", ".pyc", ".zip", ".env")     # server.log / *.env 等
EXCLUDE_FILES  = {".env", "server.log", "package.py", "AI_Chat_Project.zip"}

KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9]{20,}")   # 疑似 OpenAI 风格 Key（含测试残留也拦下）

def is_excluded(name: str) -> bool:
    return (name in EXCLUDE_NAMES or name in EXCLUDE_FILES
            or name.startswith(".") and name not in (".gitignore", ".env.example", ".vscode")
            or any(name.endswith(s) for s in EXCLUDE_SUFFIX))

def scan_file(path: str):
    """对文本类文件做密钥扫描；二进制/过大文件跳过内容检查。"""
    try:
        if os.path.getsize(path) > 2 * 1024 * 1024:
            return None
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            m = KEY_PATTERN.search(f.read())
        return m.group(0)[:8] + "…" if m else None
    except OSError:
        return None

def collect(base: str, rel: str = ""):
    """递归收集白名单条目，返回 (abs, arcname) 列表。"""
    items = []
    entry = os.path.join(base, rel) if rel else base
    if os.path.isfile(entry):
        if rel.split("/")[0] not in INCLUDE and os.path.basename(entry) not in INCLUDE:
            return items
        if is_excluded(os.path.basename(entry)):
            return items
        return [(entry, rel or os.path.basename(entry))]
    for name in sorted(os.listdir(entry)):
        if is_excluded(name):
            print(f"  [skip] {rel}{name}/  (黑名单)")
            continue
        items += collect(entry, f"{rel}{name}/" if os.path.isdir(os.path.join(entry, name)) else f"{rel}{name}")
    return items

def main():
    files = []
    for inc in INCLUDE:
        p = os.path.join(ROOT, inc)
        if not os.path.exists(p):
            print(f"  [warn] 缺少 {inc} —— 仍继续打包其余文件")
            continue
        if os.path.isfile(p):
            files.append((p, inc))
        else:
            files += collect(p, f"{inc}/")

    blocked = []
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for abs_path, arc in files:
            leak = scan_file(abs_path)
            if leak:
                blocked.append((arc, leak))
                print(f"  [BLOCKED] {arc} 疑似含密钥 {leak} —— 已拒绝入包！")
                continue
            zf.write(abs_path, arc)
            print(f"  [+ ] {arc}")

    size = os.path.getsize(OUT)
    print(f"\n✅ 打包完成：{OUT}（{len(files)-len(blocked)} 个文件，{size/1024:.1f} KB）")
    if blocked:
        print("⚠️  发现疑似密钥并已排除，请清理源码后重新打包：", blocked)
        sys.exit(2)

if __name__ == "__main__":
    main()
