"""Web 服务：imageAI 主页 + 在线体验（对话 / 生图 / 连接器）。

运行：python app.py  →  http://localhost:8000    （由 WikiGroup 开发）
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, request, send_from_directory

from imageai.core.service import service
from imageai.core.models import FAMILY

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DIST_DIR = os.path.join(WEB_DIR, "dist")

app = Flask(__name__, static_folder=DIST_DIR, static_url_path="/static")


@app.route("/")
def index():
    home = os.path.join(WEB_DIR, "index.html")
    with open(home, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ model }}", service.model)
    html = html.replace("{{ status }}", "已接入真实大模型" if service.online else "本地演示模式")
    html = html.replace("{{ online }}", "true" if service.online else "false")
    html = html.replace("{{ status }}", "已接入真实大模型" if service.online else "本地演示模式")
    return html


@app.route("/api/chat", methods=["POST"])
def api_chat():
    data = request.get_json(silent=True) or {}
    model = (data.get("model") or "").strip()
    if model:
        service.set_model(model)
    if data.get("new_chat"):
        service.history.clear()
    mode = data.get("mode", "chat")
    text = data.get("text", "")
    if mode == "draw":
        return jsonify(service.draw(text))
    return jsonify(service.chat(text))


@app.route("/api/models")
def api_models():
    return jsonify([{
        "id": m.id, "name": m.name, "desc": m.desc,
        "thinking": m.thinking, "speed": m.speed, "icon": m.icon,
    } for m in FAMILY])


@app.route("/api/connectors")
def api_connectors():
    return jsonify(service.connectors())


@app.route("/api/connector/toggle", methods=["POST"])
def api_toggle():
    data = request.get_json(silent=True) or {}
    ok = service.toggle(data.get("id", ""), bool(data.get("enabled")))
    return jsonify({"ok": ok, "connectors": service.connectors()})


if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    app.run(host="0.0.0.0", port=8000, debug=False)
