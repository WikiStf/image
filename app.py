"""Web 界面：浏览器里和 imageAI 对话、生图、看图、语音合成。

运行：python app.py  →  http://localhost:8000
"""

from __future__ import annotations

import base64
import os

from flask import Flask, jsonify, render_template_string, request, send_from_directory

from imageai import ImageAI

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")           # TypeScript 前端源码 + 编译产物
DIST_DIR = os.path.join(WEB_DIR, "dist")          # tsc 编译输出（main.js / main.css）

app = Flask(__name__, static_folder=DIST_DIR, static_url_path="/static")
ai = ImageAI()  # 自动读取 .env / 环境变量中的真实大模型配置

PAGE = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>imageAI · 全能 AI</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;display:flex;flex-direction:column;height:100vh}
 header{padding:14px 20px;background:#1e293b;font-size:20px;font-weight:700}
 header small{color:#94a3b8;font-weight:400;margin-left:10px}
 #chat{flex:1;overflow-y:auto;padding:20px}
 .msg{max-width:720px;margin:8px auto;padding:12px 16px;border-radius:12px;white-space:pre-wrap;line-height:1.6}
 .user{background:#2563eb;margin-left:auto}
 .bot{background:#1e293b}
 .imgbox img{max-width:320px;border-radius:8px;margin-top:8px}
 footer{display:flex;gap:8px;padding:14px 20px;background:#1e293b;max-width:780px;margin:0 auto;width:100%;box-sizing:border-box}
 input,select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:10px}
 input[type=text]{flex:1}
 button{background:#2563eb;border:0;color:#fff;border-radius:8px;padding:10px 16px;cursor:pointer}
 button:hover{background:#1d4ed8}
</style></head><body>
<header>🤖 imageAI <small>对话 · 文生图 · 视觉分析 · 翻译 | 已接入真实大模型 ({{ model }})</small></header>
<div id="chat"></div>
<footer>
 <select id="mode">
   <option value="chat">💬 对话</option>
   <option value="draw">🎨 生图</option>
   <option value="translate">🌐 译成英文</option>
 </select>
 <input id="q" type="text" placeholder="输入内容，回车发送…" onkeydown="if(event.key==='Enter')send()">
 <button onclick="send()">发送</button>
</footer>
<script>
const chat=document.getElementById('chat');
function add(cls,html){const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d}
async function send(){
 const q=document.getElementById('q').value.trim(); if(!q)return;
 document.getElementById('q').value='';
 add('user',q);
 const box=add('bot','…思考中');
 try{
  const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:document.getElementById('mode').value,text:q})});
  const j=await r.json();
  if(j.error){box.textContent='❌ '+j.error}
  else if(j.image){box.innerHTML=j.reply+`<div class="imgbox"><img src="data:image/png;base64,${j.image}"></div>`}
  else box.textContent=j.reply
 }catch(e){box.textContent='请求失败: '+e}
}
</script></body></html>"""


@app.route("/")
def index():
    """主页：优先使用 web/index.html（TypeScript 构建的美化页面），缺失时回退内置页面。"""
    home = os.path.join(WEB_DIR, "index.html")
    if os.path.isfile(home):
        with open(home, "r", encoding="utf-8") as f:
            html = f.read().replace("{{ model }}", ai.config.model)
        return html
    return render_template_string(PAGE, model=ai.config.model)


@app.route("/legacy")
def legacy():
    """旧版简易对话页（保留备用）。"""
    return render_template_string(PAGE, model=ai.config.model)


@app.route("/api", methods=["POST"])
def api():
    data = request.get_json(force=True)
    mode, text = data.get("mode", "chat"), data.get("text", "")
    try:
        if mode == "draw":
            paths = ai.generate_image(text, path="static/gen.png")
            with open(paths[0], "rb") as f:
                img = base64.b64encode(f.read()).decode()
            return jsonify(reply=f"已生成图片（{paths[0]}）：", image=img)
        if mode == "translate":
            return jsonify(reply=ai.translate(text, target_lang="英文"))
        return jsonify(reply=ai.chat(text))
    except Exception as e:  # noqa: BLE001
        return jsonify(error=str(e)), 200


if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    app.run(host="0.0.0.0", port=8000, debug=False)
