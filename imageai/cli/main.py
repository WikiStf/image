"""imageAI 命令行助手：终端里直接与真实大模型对话/生图/翻译。

用法：
    python -m imageai                 # 交互聊天（流式输出）
    python -m imageai -p "写一首诗"   # 单次提问
    python -m imageai --draw "海报提示词" -o poster.png   # 文生图
"""

from __future__ import annotations

import argparse
import sys

from ..core.client import ImageAI


BANNER = r"""
 ____                            _    ___ ___
|  _ \ ___ _ __ _____  ___ _   _| |_ |_ _/ _ \
| |_) / _ \ '_ \_ / _ \/ _ \ | | | __| |/ |_| |
|  __/  __/ |_) | (_) |  __/ |_| | |_ _ \__  _|
|_|   \___| .__/ \___/ \___|\__,_|\__|___/ |_|
          |_|   全能 AI · 接入真实大模型 v1.0
"""


def main() -> None:
    parser = argparse.ArgumentParser(prog="imageai", description="imageAI 全能 AI 命令行")
    parser.add_argument("-p", "--prompt", help="单次提问，不进交互模式")
    parser.add_argument("--draw", help="文生图提示词")
    parser.add_argument("-o", "--output", default="generated.png", help="图片输出路径")
    parser.add_argument("--see", metavar="IMAGE", help="让视觉模型分析一张图片")
    parser.add_argument("--say", metavar="TEXT", help="文字转语音")
    parser.add_argument("--model", help="指定模型名")
    parser.add_argument("--api-key", dest="api_key", help="API Key")
    parser.add_argument("--base-url", dest="base_url", help="OpenAI 兼容网关地址")
    args = parser.parse_args()

    print(BANNER)
    ai = ImageAI(api_key=args.api_key, base_url=args.base_url, model=args.model)
    print(f"[imageAI] 已接入大模型：{ai.config.model}"
          f"（网关：{ai.config.base_url or 'https://api.openai.com/v1'}）\n")

    if args.draw:
        paths = ai.generate_image(args.draw, path=args.output)
        print(f"图片已保存：{paths}")
        return
    if args.see:
        question = args.prompt or "请详细描述这张图片的内容。"
        print(ai.vision(question, args.see))
        return
    if args.say:
        print("音频已保存：" + ai.tts(args.say))
        return
    if args.prompt:
        print(ai.chat(args.prompt))
        return

    print("进入交互模式，输入 exit / quit 退出，/clear 清空上下文。\n")
    while True:
        try:
            user = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break
        if not user:
            continue
        if user.lower() in ("exit", "quit"):
            print("再见！")
            break
        if user == "/clear":
            ai.clear_history()
            print("[上下文已清空]")
            continue
        print("AI  > ", end="", flush=True)
        for token in ai.stream_chat(user):
            print(token, end="", flush=True)
        print("\n")


if __name__ == "__main__":
    main()
