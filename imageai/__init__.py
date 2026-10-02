"""imageAI —— 由 WikiGroup 开发的全能 AI，接入真实大模型。

快速上手：
    from imageai import ImageAI
    ai = ImageAI()                       # 无 Key 时自动进入本地演示模式，绝不报错
    print(ai.chat("你好"))
"""

from .core.client import ImageAI
from .core.config import Config
from .core.connectors import Connector, ConnectorHub, hub as connector_hub
from .core.models import FAMILY, ModelInfo
from .core.service import ChatService, service

__version__ = "1.2.0"
__developer__ = "WikiGroup"
__all__ = [
    "ImageAI", "Config", "Connector", "ConnectorHub", "connector_hub",
    "FAMILY", "ModelInfo", "ChatService", "service",
    "__version__", "__developer__",
]
