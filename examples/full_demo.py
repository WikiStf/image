"""imageAI 全功能示例：对话 / 流式 / 视觉 / 文生图 / 语音 / Embedding / 工具调用。

运行前请配置 .env 或环境变量（IMAGEAI_API_KEY 等），见 README.md。
"""

from imageai import ImageAI

ai = ImageAI()  # 自动读取 .env / 环境变量，接入真实大模型

# 1. 多轮对话
print(ai.chat("用一句话介绍量子计算"))
print(ai.chat("它和经典计算最大的区别是什么？"))  # 带上下文记忆

# 2. 流式输出（打字机效果）
for token in ai.stream_chat("写一首关于秋天的五言绝句"):
    print(token, end="", flush=True)
print()

# 3. 高层任务
print(ai.translate("床前明月光，疑是地上霜", target_lang="英文"))
print(ai.summarize("大语言模型是基于海量文本训练的深度学习模型，"
                   "能够完成对话、写作、翻译、编程等多种任务，其核心是 Transformer 架构。"))
print(ai.code("快速排序", language="python"))

# 4. 图像理解（视觉大模型）
# print(ai.vision("这张图片里有什么？", "photo.jpg"))

# 5. 文生图
# paths = ai.generate_image("一只戴着宇航员头盔的橘猫，写实风格")
# print("图片已保存:", paths)

# 6. 语音合成 / 识别
# print("音频:", ai.tts("你好，我是 imageAI"))
# print("文字:", ai.stt("speech.mp3"))

# 7. 向量化（可用于语义搜索 / RAG）
vec = ai.embed("imageAI 是全能 AI")[0]
print("embedding 维度:", len(vec))

# 8. Function Calling —— 模型自主决定调用你的 Python 函数
def get_weather(city: str) -> str:
    """查询指定城市的天气"""
    return f"{city}：晴，25°C"

answer = ai.run_tool_loop("北京今天天气怎么样？", {"get_weather": get_weather})
print("Agent 回答:", answer)
