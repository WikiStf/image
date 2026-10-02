/** imageAI 主页交互逻辑（TypeScript，严格模式） */

type Mode = "chat" | "draw" | "translate";

interface ApiRequest {
  mode: Mode;
  text: string;
}

interface ApiResponse {
  reply?: string;
  image?: string; // base64 png
  error?: string;
}

/* ---------------- 星空背景动画 ---------------- */
class StarField {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stars: Array<{ x: number; y: number; r: number; s: number; o: number }> = [];

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.loop();
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    const count = Math.floor((this.canvas.width * this.canvas.height) / 9000);
    this.stars = Array.from({ length: count }, () => ({
      x: Math.random() * this.canvas.width,
      y: Math.random() * this.canvas.height,
      r: Math.random() * 1.5 + 0.3,
      s: Math.random() * 0.35 + 0.05,
      o: Math.random(),
    }));
  }

  private loop = (): void => {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const st of this.stars) {
      st.y += st.s;
      st.o += 0.01;
      if (st.y > canvas.height) { st.y = -2; st.x = Math.random() * canvas.width; }
      ctx.globalAlpha = 0.3 + Math.abs(Math.sin(st.o)) * 0.7;
      ctx.fillStyle = "#cdd6ff";
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(this.loop);
  };
}

/* ---------------- 打字机效果 ---------------- */
class Typewriter {
  private el: HTMLElement;
  private cursor: HTMLSpanElement;
  private queue: string[] = [];
  private timer: number | null = null;

  constructor(elId: string) {
    this.el = document.getElementById(elId)!;
    this.cursor = document.createElement("span");
    this.cursor.className = "cursor";
  }

  type(text: string, speed = 45): Promise<void> {
    return new Promise((resolve) => {
      this.queue = [...text];
      this.el.textContent = "";
      this.el.appendChild(this.cursor);
      const step = () => {
        const ch = this.queue.shift();
        if (ch === undefined) {
          resolve();
          return;
        }
        this.el.insertBefore(document.createTextNode(ch), this.cursor);
        this.timer = window.setTimeout(step, speed);
      };
      step();
    });
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

/* ---------------- API 调用 ---------------- */
async function callApi(mode: Mode, text: string): Promise<ApiResponse> {
  const body: ApiRequest = { mode, text };
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ApiResponse;
}

/* ---------------- 体验区（练习大模型） ---------------- */
class Playground {
  private mode: Mode = "chat";
  private input: HTMLInputElement;
  private replyBox: HTMLElement;
  private sendBtn: HTMLButtonElement;

  constructor() {
    this.input = document.getElementById("pg-input-el") as HTMLInputElement;
    this.replyBox = document.getElementById("pg-reply")!;
    this.sendBtn = document.getElementById("pg-send") as HTMLButtonElement;

    document.querySelectorAll<HTMLDivElement>(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        this.mode = chip.dataset.mode as Mode;
        this.input.placeholder =
          this.mode === "draw" ? "描述你想画的图，例如：赛博朋克风格的猫…" :
          this.mode === "translate" ? "输入中文，自动翻译成英文…" :
          "向 imageAI 提问，回车发送…";
      });
    });

    this.sendBtn.addEventListener("click", () => this.send());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.send();
    });
  }

  private esc(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.sendBtn.disabled = true;
    this.replyBox.innerHTML = `<div class="reply-card thinking">🧠 ${
      this.mode === "draw" ? "绘画中，请稍候…" : "思考中…"
    }</div>`;
    try {
      const j = await callApi(this.mode, text);
      if (j.error) {
        this.replyBox.innerHTML = `<div class="reply-card">❌ ${this.esc(j.error)}</div>`;
      } else if (j.image) {
        this.replyBox.innerHTML =
          `<div class="reply-card">${this.esc(j.reply ?? "")}` +
          `<img src="data:image/png;base64,${j.image}" alt="generated"></div>`;
      } else {
        this.replyBox.innerHTML = `<div class="reply-card">${this.esc(j.reply ?? "（空回复）")}</div>`;
      }
    } catch (err) {
      this.replyBox.innerHTML = `<div class="reply-card">❌ 请求失败：${this.esc(String(err))}<br>提示：请通过 python app.py 启动后端后访问本页。</div>`;
    } finally {
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }
}

/* ---------------- 滚动入场动画 ---------------- */
function initScrollReveal(): void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.15 },
  );
  document.querySelectorAll(".card").forEach((c) => io.observe(c));
}

/* ---------------- 主入口 ---------------- */
async function main(): Promise<void> {
  new StarField("stars");
  initScrollReveal();
  new Playground();

  const tw = new Typewriter("typewriter");
  const demoText =
    "你好！我是 imageAI 🤖\n" +
    "我已接入真实大模型，支持：多轮对话、流式输出、文生图、图像理解、语音合成/识别、翻译、摘要、代码生成与 Function-Calling Agent。\n" +
    "向下滚动了解功能，或在「在线体验」里直接和我练习吧！";
  await tw.type(demoText);
}

document.addEventListener("DOMContentLoaded", () => {
  void main();
});
