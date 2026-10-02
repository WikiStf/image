"""imageAI —— 接入真实大模型的全能 AI。

快速上手：
    from imageai import ImageAI
    ai = ImageAI()                       # 自动读取 .env / 环境变量
    print(ai.chat("你好，介绍一下你自己"))
    print(ai.translate("Hello world"))
    ai.generate_image("一只赛博朋克风格的猫")
"""

from .core.client import ImageAI
from .core.config import Config

__version__ = "1.0.0"
__all__ = ["ImageAI", "Config", "__version__"]
