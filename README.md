# 🤖 imageAI Chat — AI 聊天工作台（Windows 快速部署版）

基于 `index.html + app.js` 的零构建单页 AI 聊天应用：自动新会话、AI 智能标题、四档模型切换、
**imageUI 思考过程面板**、Markdown/代码高亮渲染，以及解决前端密钥泄露的本地代理 `proxy-server.js`。

> ⚠️ **安全铁律：生产环境请勿在前端暴露 API Key。** 本项目的 Key 只存在于代理进程的环境变量中。

---

## 🚀 任务 1 · 快速开始（Windows PowerShell）

### 方式 A：一键脚本（推荐）
双击或在 PowerShell 中运行：

```powershell
.\start.bat        # 隐藏输入 Key → 启动代理(3001) → /health 探活通过 → 自动打开 index.html
```

### 方式 B：手动命令
```powershell
# 1) 注入 Key（仅当前会话有效，不落盘、不进代码）
$env:OPENAI_API_KEY = "sk-xxxxxxxx"
$env:UPSTREAM       = "https://api.deepseek.com"     # 可选，默认 api.openai.com

# 2) 启动 LLM 代理（Node.js >= 18，零依赖）
node proxy-server.js

# 3) 另开一个终端，启动静态服务并访问
python -m http.server 8000     # 浏览器打开 http://localhost:8000/index.html
```

### 切换真实 API（app.js Section 1 · CONFIG，约 L17-L36）
| 配置项 | Mock 模式 | 真实模式 |
|---|---|---|
| `USE_MOCK` | `true` | **`false`** |
| `ENDPOINT` | `/v1/chat/completions` | **`http://localhost:3001/v1/chat/completions`**（走代理） |
| `MODEL_MAP` | 任意 | 映射到上游真实模型名，见下 |

```powershell
# DeepSeek（imageUI 建议映射 deepseek-reasoner，才有真实 reasoning_content）
$env:UPSTREAM = "https://api.deepseek.com"
# 通义千问 Qwen（DashScope OpenAI 兼容模式）
$env:UPSTREAM = "https://dashscope.aliyuncs.com/compatible-mode"
# 私有部署 vLLM/Ollama
$env:UPSTREAM = "http://192.168.1.10:8000"
```

## 🧰 任务 1+ · 24/7 稳定运行
- **心跳检测**：`GET http://localhost:3001/health` → `{status:"ok", uptimeSec, keyConfigured...}`
- **日志系统**：所有启动/错误请求/崩溃堆栈写入 `server.log`（超 5MB 自动轮转为 `.log.1`）
- **崩溃自重启**：
  - Windows 零安装：双击 `start-daemon.bat`（守护循环，崩溃 3 秒后自动拉起）
  - PM2 方案：`npm i -g pm2` → `$env:OPENAI_API_KEY="sk-xxx"; pm2 start ecosystem.config.js; pm2 save`
    （含内存超限重启、开机自启；Key 仍走环境变量，严禁写进配置文件）

## 📝 任务 2 · Markdown 渲染特性
回复区支持 GFM Markdown（CDN 加载 marked + DOMPurify + highlight.js，断网自动降级纯文本）：
- **代码块**：语法高亮（JS/Python/HTML/CSS…）+ 语言标签 + **一键复制**按钮
- **表格**：斑马纹美化 + 手机端横向滚动不撑破布局
- **任务列表** `- [ ]` / 标题 / 引用块 / 删除线 / 链接新窗口打开
- **XSS 防护**：DOMPurify 白名单消毒，`<script>`/`on*=`/`javascript:` 一律清除
- 数学公式：按“可暂缓”处理未引入 KaTeX（如需要，加两行 CDN 即可）

### ✅ 测试文本（粘贴到输入框发送，验证渲染效果）
````text
# Markdown 渲染自检

**粗体**、*斜体*、~~删除线~~、行内 `code`、[链接](https://example.com)

- 无序列表项
- [x] 已完成的任务
- [ ] 未完成的任务

> 引用块：长文阅读舒适度测试。

| 模型 | 档位 | 思考链 |
|---|---|---|
| image1.5 | 基础版 | ✘ |
| imageUI | 终极版 | ✔ |

```python
def hello(name):
    """docstring"""
    return f"Hi, {name}!"   # 注释高亮
```

```javascript
const x = [1, 2, 3].map(n => n * 2);
console.log(x); // 复制按钮测试
```
````

## 🔧 任务 1++ · 故障排查
| 症状 | 原因 | 解决 |
|---|---|---|
| `端口 3001 已被占用` / EADDRINUSE | 旧代理还在跑 | `netstat -ano \| findstr :3001` → `taskkill /PID <pid> /F`；或 `$env:PORT=3002` |
| 红色警告框 HTTP 401/403 | Key 无效/未设置 | 检查代理窗口是否有 Key；页面警告框内临时填 Key（仅调试），正式仍走环境变量 |
| 回复报 `Bad gateway` | 上游地址/网络错误 | 核对 `$env:UPSTREAM`；查看 `server.log` 中的上游状态码 |
| imageUI 无思考面板内容 | 上游非推理模型 | `MODEL_MAP.imageUI` 必须是返回 `reasoning_content` 的模型（deepseek-reasoner / QwQ） |
| Markdown 不高亮 | CDN 被拦截/离线 | 正常降级为纯文本；可将三个库下载到本地改为相对路径引用 |
| 页面空白/脚本错误 | file:// 限制 | 用 `python -m http.server 8000` 经 http 访问 |
| 代理静默退出 | 崩溃 | 看 `server.log` FATAL 行；用 `start-daemon.bat` 自动拉起 |

## 📦 任务 3 · 项目打包
```powershell
python package.py     # 生成 AI_Chat_Project.zip
```
白名单打包（index.html/app.js/proxy-server.js/start*.bat/ecosystem.config.js/.vscode/README 等），
自动排除 `node_modules`、`.env`、`server.log`，并对入包文件做 **sk- 密钥扫描兜底**——发现疑似 Key 立即拒绝入包。

## 📁 项目结构
```
├── index.html            # UI + CSS（主题变量/Markdown 排版/微交互动画）
├── app.js                # 逻辑：CONFIG/Store/LLM/TitleGen/UI(Markdown)/Actions/Boot/KeyUI
├── proxy-server.js       # 生产级代理：/health 心跳 + server.log 日志 + 崩溃捕获
├── start.bat             # 一键启动（隐藏输入 Key → 代理 → 探活 → 开浏览器）
├── start-daemon.bat      # 24/7 守护循环（崩溃自动重启）
├── ecosystem.config.js   # PM2 配置（开机自启/内存保险丝）
├── package.py            # 交付打包（白名单 + 密钥扫描）
└── .vscode/              # F5 全栈调试配置
```
