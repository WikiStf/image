interface ModelInfo { id: string; name: string; desc: string; thinking: boolean; speed: string; icon: string }
interface ConnectorInfo { id: string; name: string; icon: string; desc: string; placeholder: string; enabled: boolean }
interface ChatResp { reply?: string; thinking?: string; model?: string; sources?: { icon: string; name: string }[]; mode?: string; kind?: string; image?: string; image_svg?: string }

type Mode = "chat" | "draw";

class StarField {
  private ctx: CanvasRenderingContext2D;
  private pts: { x: number; y: number; r: number; s: number; a: number }[] = [];
  constructor(private cv: HTMLCanvasElement) {
    this.ctx = cv.getContext("2d")!;
    this.resize(); addEventListener("resize", () => this.resize());
    for (let i = 0; i < 140; i++) this.pts.push(this.spawn(true));
    requestAnimationFrame(() => this.tick());
  }
  private resize() { this.cv.width = innerWidth; this.cv.height = innerHeight; }
  private spawn(anyY: boolean) { return { x: Math.random() * this.cv.width, y: anyY ? Math.random() * this.cv.height : -4, r: Math.random() * 1.6 + .3, s: Math.random() * .35 + .06, a: Math.random() }; }
  private tick() {
    const { ctx, cv } = this;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of this.pts) {
      p.y += p.s; p.a += .02;
      if (p.y > cv.height) Object.assign(p, this.spawn(false));
      ctx.globalAlpha = .35 + Math.abs(Math.sin(p.a)) * .65;
      ctx.fillStyle = "#9db8ff";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(() => this.tick());
  }
}

class Typewriter {
  constructor(private el: HTMLElement, private text: string, private speed = 45) { this.run(); }
  private async run() {
    for (;;) {
      this.el.textContent = "";
      for (let i = 0; i < this.text.length; i++) {
        this.el.textContent += this.text[i];
        await new Promise(r => setTimeout(r, this.speed));
      }
      await new Promise(r => setTimeout(r, 3200));
      while (this.el.textContent.length) { this.el.textContent = this.el.textContent.slice(0, -1); await new Promise(r => setTimeout(r, 18)); }
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

class ChatApp {
  private box: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private modelSel: HTMLElement;
  private connSel: HTMLElement;
  private models: ModelInfo[] = [];
  private connectors: ConnectorInfo[] = [];
  private mode: Mode = "chat";
  private busy = false;

  constructor() {
    this.box = document.getElementById("chat-box")!;
    this.input = document.getElementById("chat-input") as HTMLTextAreaElement;
    this.sendBtn = document.getElementById("chat-send") as HTMLButtonElement;
    this.modelSel = document.getElementById("model-select")!;
    this.connSel = document.getElementById("conn-chips")!;
    this.bind();
    this.loadModels();
    this.loadConnectors();
    this.greet();
  }

  private bind() {
    this.sendBtn.onclick = () => this.submit();
    this.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.submit(); } });
    document.getElementById("new-chat")?.addEventListener("click", async () => {
      await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_chat: true, text: "" }) });
      this.box.innerHTML = ""; this.greet();
    });
    document.querySelectorAll(".pg-tab").forEach(t => t.addEventListener("click", () => {
      document.querySelectorAll(".pg-tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      this.mode = (t as HTMLElement).dataset.mode as Mode;
      this.input.placeholder = this.mode === "draw" ? "描述你想画的图片，回车生成…" : "向 imageAI 提问，回车发送…";
    }));
  }

  private async loadModels() {
    try { this.models = await (await fetch("/api/models")).json(); } catch { return; }
    this.modelSel.innerHTML = "";
    for (const m of this.models) {
      const card = document.createElement("div");
      card.className = "model-card" + (m.thinking ? " deep" : ""); card.dataset.mid = m.id;
      card.innerHTML = `<span class="mi">${m.icon}</span><b>${esc(m.name)}</b>
        <small>${esc(m.desc)}</small><em>${m.speed}${m.thinking ? " · 显示思考过程" : " · 快速直答"}</em>`;
      card.onclick = () => {
        document.querySelectorAll(".model-card").forEach(c => c.classList.remove("on"));
        card.classList.add("on");
        this.bubble("sys", `已切换到 ${m.name}（${m.thinking ? "深度思考，会展示剖析过程" : "快速模式，直接作答"}）`);
      };
      this.modelSel.appendChild(card);
    }
    const want = (window as any).INIT_MODEL as string | undefined;
    const cards = Array.from(this.modelSel.children) as HTMLElement[];
    (cards.find(c => this.models.find(m => m.id === want && c.innerHTML.includes(m.name))) ?? cards[0])?.classList.add("on");
  }

  private async loadConnectors() {
    try { this.connectors = await (await fetch("/api/connectors")).json(); } catch { return; }
    this.renderConnectors();
  }

  private renderConnectors() {
    this.connSel.innerHTML = "";
    for (const c of this.connectors) {
      const chip = document.createElement("button");
      chip.className = "conn-chip" + (c.enabled ? " on" : "");
      chip.innerHTML = `${c.icon} ${esc(c.name)}`;
      chip.title = c.desc;
      chip.onclick = async () => {
        const r = await fetch("/api/connector/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, enabled: !c.enabled }) });
        const j = await r.json(); this.connectors = j.connectors; this.renderConnectors();
      };
      this.connSel.appendChild(chip);
    }
  }

  private greet() {
    this.bubble("bot", "你好，我是 imageAI（由 WikiGroup 开发）。可以选择模型、开启连接器，试试「北京天气」「计算 128*64」或直接聊天、生图～");
  }

  private currentModel(): string {
    return (this.modelSel.querySelector(".on") as HTMLElement)?.dataset.mid ?? "";
  }
  private bubble(role: string, html: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "msg " + role;
    d.innerHTML = html;
    this.box.appendChild(d);
    this.box.scrollTop = this.box.scrollHeight;
    return d;
  }

  private thinkingBlock(text: string): string {
    return `<details class="think" open><summary>🧠 深入剖析问题中…</summary><div class="think-body">${esc(text).replace(/\n/g, "<br>")}</div></details>`;
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.busy = true; this.sendBtn.disabled = true;
    this.input.value = "";
    this.bubble("user", esc(text).replace(/\n/g, "<br>"));
    const wait = this.bubble("bot", '<span class="dots"><i></i><i></i><i></i></span>');
    let resp: ChatResp | null = null;
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: this.mode, text, model: this.currentModel() }) });
      resp = await r.json();
    } catch { /* 网络异常也走优雅提示 */ }
    if (!resp) { wait.innerHTML = "服务暂时不可用，请稍后再试。"; this.busy = false; this.sendBtn.disabled = false; return; }
    const srcTags = (resp.sources ?? []).map(s => `<span class="src">${s.icon} ${esc(s.name)}·连接器</span>`).join("");
    const think = resp.thinking ? this.thinkingBlock(resp.thinking) : "";
    if (resp.image_svg) wait.innerHTML = `${think}<div class="art">${resp.image_svg}</div><p>${esc(resp.reply ?? "")}</p>${srcTags}`;
    else if (resp.image) wait.innerHTML = `${think}<img class="genimg" src="data:image/png;base64,${resp.image}"><p>${esc(resp.reply ?? "")}</p>${srcTags}`;
    else wait.innerHTML = `${think}<p>${esc(resp.reply ?? "").replace(/\n/g, "<br>")}</p>${srcTags}`;
    const tb = wait.querySelector(".think-body");
    if (tb) { tb.innerHTML = ""; this.typeInto(tb as HTMLElement, (resp.thinking ?? "").split("\n")); }
    this.box.scrollTop = this.box.scrollHeight;
    this.busy = false; this.sendBtn.disabled = false; this.input.focus();
  }

  private async typeInto(el: HTMLElement, lines: string[]) {
    for (const line of lines) {
      const p = document.createElement("div");
      el.appendChild(p);
      for (const ch of line) { p.textContent += ch; await new Promise(r => setTimeout(r, 12)); }
      el.parentElement!.parentElement!.scrollTop = 9e9;
    }
    const sum = el.parentElement!.querySelector("summary");
    if (sum) sum.innerHTML = "🧠 已完成深度剖析（点击展开/收起）";
  }
}

function initReveal() {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { (e.target as HTMLElement).classList.add("show"); io.unobserve(e.target); } }), { threshold: .12 });
  document.querySelectorAll(".card,.model-card,.conn-card").forEach(x => io.observe(x));
}

addEventListener("DOMContentLoaded", () => {
  const cv = document.getElementById("stars") as HTMLCanvasElement;
  if (cv) new StarField(cv);
  const tw = document.getElementById("typewriter");
  if (tw) new Typewriter(tw as HTMLElement, "我是 imageAI，一个名字，全部 AI 能力。对话、生图、看图、语音、翻译、连接器，全由 WikiGroup 精心打造。");
  if (document.getElementById("chat-box")) new ChatApp();
  initReveal();
});
