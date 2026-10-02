# 🤖 imageAI — 全能 AI，接入真实大模型

**imageAI** 是一个开箱即用的全能 AI 框架/助手：通过 OpenAI 兼容协议一行代码接入 **任意真实大模型**（OpenAI、DeepSeek、Kimi、通义千问、智谱 GLM、本地 Ollama/vLLM 等），支持几乎所有主流 AI 能力。

## ✨ 功能一览

| 能力 | 方法 | 说明 |
|---|---|---|
| 💬 多轮对话 | `ai.chat()` / `ai.stream_chat()` | 带上下文记忆、流式打字机输出 |
| 👁 图像理解 | `ai.vision()` | 视觉大模型分析本地图片/URL |
| 🎨 文生图 | `ai.generate_image()` | DALL·E / 兼容图像模型 |
| 🖌 图像编辑 | `ai.edit_image()` | 局部重绘 |
| 🔊 语音合成 | `ai.tts()` | 文字转语音 |
| 🎙 语音识别 | `ai.stt()` | Whisper 转文字 |
| 📐 向量化 | `ai.embed()` | Embedding，可做语义搜索/RAG |
| 🌐 翻译/摘要/改写/抽取/分类/写代码 | `translate/summarize/rewrite/extract/classify/code` | 高层任务一行完成 |
| 🛠 Function Calling | `ai.run_tool_loop()` | 模型自主调用你的 Python 函数（Agent） |
| 🖥 Web 界面 | `python app.py` | 浏览器聊天 + 生图 |
| ⌨️ 命令行 | `python -m imageai` | 终端交互助手 |

## 🚀 快速开始

### 1. 安装依赖

```bash
pip install openai flask requests   # 或 pip install -e .
```

### 2. 配置真实大模型 Key（三选一）

```bash
cp .env.example .env    # 编辑 .env 填入 API Key
```

或直接设置环境变量：

```bash
export IMAGEAI_API_KEY="sk-xxxxxx"
export IMAGEAI_BASE_URL="https://api.deepseek.com/v1"   # 以 DeepSeek 为例
export IMAGEAI_MODEL="deepseek-chat"
```

也兼容 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。

### 3. 使用

```python
from imageai import ImageAI
ai = ImageAI()                          # 自动读取配置，接入真实大模型

print(ai.chat("你好，介绍一下你自己"))     # 真实模型回复
print(ai.translate("床前明月光"))         # 翻译
print(ai.code("写一个快排"))              # 生成代码
ai.generate_image("赛博朋克风格的猫")      # 文生图，保存为 png
print(ai.vision("图里有什么？", "photo.jpg"))  # 图像理解
```

### 4. 命令行 / Web

```bash
python -m imageai                       # 交互式聊天（流式输出）
python -m imageai -p "写一首诗"          # 单次提问
python -m imageai --draw "海报：极简风" -o poster.png   # 生图
python app.py                           # 打开 http://localhost:8000 网页版
python examples/full_demo.py            # 全功能示例
```

## 📁 项目结构

```
imageai/
├── __init__.py        # 包入口 (from imageai import ImageAI)
├── __main__.py        # python -m imageai
├── core/
│   ├── config.py      # 配置系统（.env / 环境变量 / 传参）
│   └── client.py      # 核心引擎：对话/视觉/生图/语音/Embedding/Agent
├── cli/main.py        # 命令行助手
app.py                 # Flask Web 界面
examples/full_demo.py  # 全功能示例
.env.example           # 各大模型接入配置模板
```

## 🔌 支持的大模型平台

任何 OpenAI 兼容 API 均可接入（改 `IMAGEAI_BASE_URL` + `IMAGEAI_MODEL` 即可）：
OpenAI · Azure OpenAI · DeepSeek · Moonshot Kimi · 通义千问 DashScope · 智谱 GLM · 文心 · MiniMax · SiliconFlow · Ollama / vLLM / LM Studio（本地模型）等。

> ⚠️ 安全提示：请把 `.env` 加入 `.gitignore`，切勿泄露 API Key。


## 🌐 美化主页（TypeScript）

`web/` 目录是 imageAI 的主页前端，使用 **TypeScript（严格模式）+ Canvas + CSS3** 构建：

```
web/
├── index.html      # 主页（星空背景、打字机演示、功能卡片、在线体验区）
├── src/main.ts     # TS 源码：StarField 动画 / Typewriter / Playground(fetch 调用大模型 API)
├── src/style.css   # 深空渐变 + 玻璃拟态样式
├── tsconfig.json   # tsc 编译配置
└── dist/           # 编译产物 main.js / main.css（Flask 以 /static 提供）
```

编译与运行：
```bash
cd web && npx tsc && cp src/style.css dist/main.css   # 编译 TypeScript
python app.py                                          # http://localhost:8000 即为主页
```

页面功能：动态星空背景、渐变流光标题、打字机自我介绍、滚动入场卡片动画，
以及「在线体验」区——可直接在网页上与真实大模型练习 💬对话 / 🎨生图 / 🌐翻译。
