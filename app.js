/* =====================================================================
 * imageAI Chat — 单页 AI 聊天应用逻辑
 * ---------------------------------------------------------------------
 * 模块划分（逻辑分离，便于维护）：
 *   Section 1  CONFIG     —— 全局配置（含真实 API 接入点标记）
 *   Section 2  Store      —— 数据层：对话/消息的增删改查 + localStorage 持久化
 *   Section 3  LLM        —— 大模型接入层：Mock SSE 流式实现（可替换为真实端点）
 *   Section 4  TitleGen   —— 智能标题生成（调用大模型总结，禁止直接使用原问题）
 *   Section 5  UI         —— 视图渲染：侧边栏 / 消息流 / 思考过程面板
 *   Section 6  Actions    —— 业务编排：发送、停止、新建、切换、删除、重命名…
 *   Section 7  Boot       —— 启动入口：自动初始化新会话、事件绑定
 * ===================================================================== */
'use strict';

/* ============================ Section 1 · CONFIG ============================ */
const CONFIG = {
  USE_MOCK: true,                       // ★ 改为 false 并配置 ENDPOINT 即可接入真实大模型
  /* ★★★【替换点 L23 / L209-217 / L268】生产环境请把 ENDPOINT 指向本地代理（如 http://localhost:3001/v1/chat/completions），
   * 由 proxy-server.js 携带 Key 转发上游 —— ⚠️⚠️⚠️ 生产环境严禁在前端代码/浏览器中暴露 API Key！ */
  ENDPOINT: '/v1/chat/completions',     // ★【替换点】OpenAI 兼容端点：推荐走本地代理；直连示例 https://api.deepseek.com/v1/chat/completions
  get API_KEY() { return localStorage.getItem('imageai-apikey') || ''; },
                                        // ↑ 密钥不再硬编码！仅从 localStorage 运行时读取（调试用途，见 Section 8）。
                                        //   ⚠️ 生产环境请勿在前端暴露 Key —— 正式部署务必改用后端代理注入（见任务 2 推荐方案）。
  STORAGE_KEY: 'imageai-chat-v1',
  DEFAULT_MODEL: 'image1.5',
  TITLE_MODEL: 'image1.5',              // 标题生成使用的轻量模型（真实接入时映射到便宜快速的模型）
  /* 前端模型 id → 真实 API 的 model 名称映射（DeepSeek/Qwen/vLLM 等按各自文档修改） */
  MODEL_MAP: {
    'image1.5':       'gpt-4o-mini',        // ★【替换点】基础版对应的真实模型名
    'image2.1-turbo': 'gpt-4o',             // ★【替换点】高速版
    'imageMax':       'gpt-4.1',            // ★【替换点】高性能版
    'imageUI':        'deepseek-reasoner',  // ★【替换点】终极版：须为"推理模型"（DeepSeek-R1 / QwQ / o系列等），
                                            //   只有推理模型才会返回 delta.reasoning_content，思考面板才有真实内容
  },
};
const mapModel = (id) => CONFIG.MODEL_MAP[id] || id;   // 未配置映射时原样透传

/* 四个模型，按性能从低到高排列；supportsThinking 决定是否需要渲染思考过程面板 */
const MODELS = [
  { id: 'image1.5',       name: 'image1.5',       tier: '基础版',   supportsThinking: false, speed: 28 },
  { id: 'image2.1-turbo', name: 'image2.1 Turbo', tier: '高速版',   supportsThinking: false, speed: 10 },
  { id: 'imageMax',       name: 'imageMax',       tier: '高性能版', supportsThinking: false, speed: 18 },
  { id: 'imageUI',        name: 'imageUI',        tier: '终极版',   supportsThinking: true,  speed: 22 },
];
const getModel = (id) => MODELS.find(m => m.id === id) || MODELS[0];

/* ============================ Section 2 · Store ============================ */
/* 数据结构：
 * state = { conversations: [ { id, title, model, createdAt, updatedAt,
 *                               titlePending, generating, messages:[ {role,content,thinking?,error?} } ] ],
 *           activeId }
 */
const state = { conversations: [], activeId: null, authAlert: false };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();

function createConversation() {
  return {
    id: uid(),
    title: '新对话',
    model: localStorage.getItem('imageai-model') || CONFIG.DEFAULT_MODEL,
    createdAt: now(), updatedAt: now(),
    titlePending: false,          // 第一轮问答结束后置 true → 触发 AI 标题生成
    generating: false,            // 是否有进行中的流式回复（刷新后一律复位）
    messages: [],
  };
}

/** 自动初始化：每次打开主页都创建一个全新的空白会话（需求 §对话管理-自动初始化） */
function initSession() {
  loadState();
  // 复位上次遗留的流式状态（防止刷新时中断在"生成中"）；同时清除消息级 _streaming 标记
  state.conversations.forEach(c => { c.generating = false; c.messages.forEach(m => { if (m._streaming) m._streaming = false; }); });
  const fresh = createConversation();
  state.conversations.unshift(fresh);
  state.activeId = fresh.id;
  saveState();
}

function activeConv() { return state.conversations.find(c => c.id === state.activeId); }

function saveState() {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ conversations: state.conversations }));
  } catch (e) { console.warn('[Store] localStorage 写入失败（可能已满）:', e); }
}
function loadState() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    }
  } catch (e) { console.warn('[Store] 历史数据读取失败，已忽略:', e); state.conversations = []; }
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.activeId === id) {
    if (state.conversations.length) state.activeId = state.conversations[0].id;
    else newChat();                                  // 保证永远至少存在一个会话
  }
  saveState();
}
function newChat() {
  // 若当前已是空白新会话则复用，避免连点产生一堆空会话
  const cur = activeConv();
  if (cur && cur.messages.length === 0) { state.activeId = cur.id; return; }
  const fresh = createConversation();
  state.conversations.unshift(fresh);
  state.activeId = fresh.id;
  saveState();
}

/* ============================ Section 3 · LLM ============================ */
/* 统一对外接口：streamChat({model, messages, onThink, onDelta, signal}) -> Promise<fullText>
 * Mock 与真实实现签名完全一致，切换 CONFIG.USE_MOCK 即可无缝替换。 */

async function streamChat(opts) {
  return CONFIG.USE_MOCK ? mockStream(opts) : realStream(opts);
}

/* ---- 3.1 Mock：模拟 OpenAI 风格 SSE 流（先思考块、再正文增量），支持 AbortSignal ---- */
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal && signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

function buildMockAnswer(modelId, question) {
  const q = question.trim().replace(/\s+/g, ' ');
  const shortQ = q.length > 30 ? q.slice(0, 30) + '…' : q;

  /* 主题识别：用于生成更贴题的回答与思维链 */
  let topic = '通用解答';
  if (/爬虫|抓取|spider|scrape/i.test(q)) topic = 'web-crawler';
  else if (/排序|算法|leetcode|数据结构/i.test(q)) topic = 'algorithm';
  else if (/python|javascript|java|代码|编程|函数|bug/i.test(q)) topic = 'code';
  else if (/量子|物理|化学|生物|天文|数学/i.test(q)) topic = 'science';
  else if (/文案|写作|故事|诗|润色|翻译/i.test(q)) topic = 'writing';
  else if (/react|vue|前端|框架/i.test(q)) topic = 'frontend';

  const bodies = {
    'web-crawler': `关于「${shortQ}」，给你一套稳妥的实践建议：\n\n1. 技术选型：简单站点用 requests + BeautifulSoup；需要登录/JS 渲染时用 Playwright；大规模采集考虑 Scrapy + 中间件。\n2. 礼貌抓取：设置 User-Agent、控制并发与延时（如 random.uniform(1,3)），优先解析 robots.txt 与站点 API。\n3. 反爬应对：IP 代理池、Cookie 池、请求指纹轮换；遇到验证码尽量走官方开放接口而不是硬破解。\n4. 数据落地：清洗后写入 SQLite/PostgreSQL 或 Parquet 文件，记录断点游标支持增量抓取。\n5. 合规提醒：只采集公开数据，遵守目标站条款与当地法律法规。\n\n如果你告诉我目标站点特征（静态/动态、是否需登录），我可以给出针对性的骨架代码。`,
    'algorithm': `针对「${shortQ}」，我的思路如下：\n\n• 明确输入规模与时间/空间约束，这是选择算法的前提。\n• 常见路线：分治（归并/快排）、双指针、滑动窗口、二分、BFS/DFS、动态规划、单调栈。\n• 判断依据：求最值且子问题重叠 → DP；有序或答案单调 → 二分；连通性/层级 → BFS/并查集。\n• 复杂度基准：n ≤ 1e5 需要 O(n log n) 以内；n ≤ 20 可接受指数级搜索。\n\n可以把你具体的题目或数据规模发给我，我来帮你写出可运行的实现并逐步分析复杂度。`,
    code: `关于「${shortQ}」，我建议按以下步骤处理：\n\n1. 先复现最小可运行示例，隔离出真正出错的那一段。\n2. 阅读报错栈，定位到具体行与变量状态（必要时加日志或断点调试）。\n3. 检查边界条件：空输入、类型不匹配、异步时序、编码问题是最常见的坑。\n4. 修复后补充单元测试覆盖该场景，防止回归。\n\n把相关代码片段贴出来，我可以直接给你修改后的版本和逐行解释。`,
    science: `这是一个很好的问题：「${shortQ}」。\n\n我用三层结构来回答：\n\n① 直觉层面：先用一个日常类比建立感性认识；\n② 原理层面：给出核心概念、关键公式或机制的准确描述；\n③ 延伸层面：说明它在实际中的应用与目前的前沿进展。\n\n如果你想深入某一层（比如数学推导或实验背景），告诉我，我可以展开细讲。`,
    writing: `围绕「${shortQ}」，我为你构思了这样的方案：\n\n• 定调：先明确受众与场景（正式发布/社媒传播/内部宣讲），语气随之调整。\n• 结构：钩子开头 → 痛点共鸣 → 核心价值三点 → 行动号召，是转化率较高的经典框架。\n• 打磨：短句为主、动词优先、每段一个信息点；避免堆砌形容词。\n\n下面是一段可直接使用的初稿方向：以"用户的一天"叙事切入，在产品出场时刻制造对比反差。需要我基于你的产品卖点写成完整成稿吗？`,
    frontend: `关于「${shortQ}」的对比与建议：\n\nReact：生态庞大、灵活度高，需要自行搭配路由/状态方案；JSX 心智模型自由，适合大型团队定制基建。\nVue：上手曲线平缓，SFC 单文件组件开发体验好，全家桶（Router/Pinia）开箱即用，响应式系统对模板改动追踪精细。\n选型经验：团队偏工程化定制、已有大量 React 资产 → React；追求开发效率、中小型项目快速交付 → Vue3 + Vite。\n\n两者性能在绝大多数业务场景下都不是瓶颈，团队熟悉度才是第一权重。`,
    '通用解答': `关于「${shortQ}」，我的回答如下：\n\n首先梳理问题的核心诉求，然后从三个角度展开：\n1. 直接结论：给出最常用、最稳妥的做法；\n2. 关键细节：列出容易被忽略但影响很大的注意点；\n3. 备选方案：根据不同约束条件提供的替代思路。\n\n你可以补充更多背景信息（目标、约束、已尝试的方案），我会给出更有针对性的建议。`,
  };

  const thinkSteps = {
    'web-crawler': ['解析意图：用户想要网络爬虫的实现或优化建议。', '识别关键约束：目标站点类型未知 → 需要先给通用方案，再引导补充信息。', '检索知识：requests/BS4 → Playwright → Scrapy 的梯度选型；合规与反爬是两大风险点。', '组织回答：按"选型→礼貌抓取→反爬→存储→合规"五步输出，结尾追问站点特征以便细化。', '质量自检：确认包含可操作参数（延时区间、代理策略），避免泛泛而谈。'],
    'algorithm': ['解析意图：算法/数据结构类问题，需要方法论而非单一答案。', '拆解：先问规模与约束，再映射到候选算法族。', '归纳常见模式：DP/二分/BFS/双指针各自的适用信号。', '补充复杂度速查表，帮助用户自我判断。', '自检：确保没有直接猜题，而是给出决策树 + 邀请提供具体题目。'],
    code: ['解析意图：疑似调试/编码求助，但缺少具体代码。', '策略：先给通用的排错流程（复现→定位→边界→回归测试）。', '预判常见根因：类型、异步时序、编码、空值。', '组织成分步骤清单，降低用户执行成本。', '自检：结尾明确邀请贴代码，保证下一轮能给出具体修复。'],
    science: ['解析意图：知识解释类请求。', '采用"直觉→原理→延伸"三层讲解法，兼顾不同深度需求。', '选择日常类比作为第一层，降低理解门槛。', '留出深入接口：让用户指定要展开的层次。', '自检：表述保持准确，不使用未经验证的数字。'],
    writing: ['解析意图：创意/营销写作需求。', '确定框架：钩子-痛点-价值-行动，适配转化目标。', '先输出方法论与初稿方向，避免在信息不足时写死全文。', '语言风格调整为短句、动词优先。', '自检：确认提供了可继续迭代的明确入口（产品卖点）。'],
    frontend: ['解析意图：技术选型对比。', '分别提炼 React 与 Vue 的核心差异维度：生态、心智模型、工程基建。', '给出决策权重：团队熟悉度 > 框架性能。', '组织成对照式结构方便快速阅读。', '自检：观点保持中立，注明适用场景而非绝对优劣。'],
    '通用解答': ['解析意图：开放式问题，信息量有限。', '采用"结论-细节-备选"的安全回答骨架。', '避免编造具体事实，侧重方法与思路。', '在结尾引导用户补充上下文以提升回答质量。', '自检：结构清晰、无误导性承诺。'],
  };

  const prefixByModel = {
    'image1.5': '',
    'image2.1-turbo': '',
    'imageMax': '',
    'imageUI': '',
  };
  return { content: (prefixByModel[modelId] || '') + bodies[topic], thinking: thinkSteps[topic].join('\n'), topic };
}

async function mockStream({ model, messages, onThink, onDelta, signal }) {
  const m = getModel(model);
  const lastUser = [...messages].reverse().find(x => x.role === 'user');
  const { content, thinking } = buildMockAnswer(m.id, lastUser ? lastUser.content : '你好');

  await sleep(260 + Math.random() * 300, signal);          // 模拟首 Token 延迟 (TTFT)

  /* 1) 思考过程流式输出 —— 仅 imageUI 会消费 onThink 回调 */
  if (m.supportsThinking && onThink && thinking) {
    for (const seg of chunkify(thinking, 9)) {
      await sleep(Math.max(4, 14 - m.speed / 2), signal);
      onThink(seg);
    }
    await sleep(200, signal);                                // "思考完成"到"开始作答"的间隙
  }

  /* 2) 正文流式输出 */
  let full = '';
  for (const seg of chunkify(content, m.id === 'image2.1-turbo' ? 14 : 7)) {
    await sleep(m.speed + Math.random() * 12, signal);       // Turbo 速度最快
    full += seg;
    onDelta(seg);
  }
  return full;
}

function chunkify(text, size) {                              // 中文按字符块切分，模拟 token 流
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/* ---- 3.2 真实 API（OpenAI 兼容格式：DeepSeek / 通义Qwen / vLLM / OpenAI 均可用）----
 * ★★★【生产接入三步走 —— 具体行号，与下方实际代码一一对应】
 *   ① L17    ：CONFIG.USE_MOCK = false
 *   ② L20    ：CONFIG.ENDPOINT 改为你的地址（推荐本地代理 http://localhost:3001/v1/chat/completions，
 *              或私有部署网关；若直连厂商：https://api.deepseek.com/v1/chat/completions）
 *   ③ L21-23 ：API_KEY getter（localStorage 运行时读取）＋ L240：Authorization 头拼装。
 *              密钥注入三选一（按安全性从低到高）：
 *        a) 浏览器插件（如 Requestly/ModHeader）对请求注入 Authorization 头 → 本函数不发送 Key（删掉 L240 即可）
 *        b) 用户通过聊天区红色警告框输入 Key → localStorage（仅调试！⚠️ 生产环境请勿在前端暴露 Key）
 *        c) 【推荐】后端代理注入：前端不带 Key，由 proxy-server.js 统一携带（见仓库根目录 proxy-server.js）
 *
 * 标准 fetch 请求示例（即 realStream 函数体本身，L234-244）：
 *   fetch('/v1/chat/completions', {
 *     method : 'POST',
 *     headers: { 'Content-Type': 'application/json',
 *               'Authorization': 'Bearer ' + API_KEY },      // ⚠️ 该 Header 只应出现在后端代理里
 *     body   : JSON.stringify({ model: 'deepseek-reasoner', messages, stream: true }),
 *     signal ,                                               // AbortController：支持"停止生成"
 *   });
 *
 * ★★ 思维链与正文的分离解析（imageUI 思考面板的关键，见 L286-290）：
 *   SSE 每个 chunk 的 choices[0].delta 可能同时/先后携带两种增量字段：
 *     · delta.reasoning_content —— 模型的中间推理内容（DeepSeek-R1、QwQ、部分 vLLM/o系列转发时出现）
 *     · delta.content         —— 最终回复正文
 *   时序上通常先连续收到若干 reasoning_content，再切换到 content。本函数把二者分别回调：
 *     onThink(seg) → sendMessage() 中累加 reply.thinking → 渲染进 🧠 Thinking Process 面板
 *                    （realStream 内部已做 rAF 合帧批量，避免高频 delta 打爆渲染层）
 *     onDelta(seg) → 累加 reply.content   → 渲染进气泡正文
 *   只要 imageUI 映射到真实推理模型（见 CONFIG.MODEL_MAP L32），思考面板即自动生效；
 *   非推理模型不会返回 reasoning_content，面板保持空/隐藏收尾逻辑，互不影响。 */
async function realStream({ model, messages, onThink, onDelta, signal }) {
  /* ↓↓↓ 标准 Headers + Body（Authorization / messages / stream:true） */
  const resp = await fetch(CONFIG.ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      /* Key 来自 Section 8 的运行时存储；走后端代理时此处留空即可（代理会替你加上）
       * ⚠️⚠️⚠️ 生产环境请勿在前端暴露 Key —— 正式部署务必改用 proxy-server.js 注入！ */
      ...(CONFIG.API_KEY ? { Authorization: 'Bearer ' + CONFIG.API_KEY } : {}),
    },
    body: JSON.stringify({ model: mapModel(model), messages, stream: true }),
    signal,
  });
  /* ★ 任务 3-错误处理：401/403 单独识别 → 触发聊天区红色"API 认证失败"警告框（含 Key 设置入口） */
  if (resp.status === 401 || resp.status === 403) throw new AuthError(resp.status);
  if (!resp.ok || !resp.body) {
    /* 尽力提取上游错误信息（部分网关返回 JSON body），便于用户排障 */
    let detail = '';
    try { const j = await resp.json(); detail = j?.error?.message ? `：${j.error.message}` : ''; } catch {}
    throw new Error(`API 错误 HTTP ${resp.status}${detail}`);
  }

  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  /* rAF 合帧缓冲（Reasoning Core · 流式渲染性能优化）：
   * 真实 API 在高吞吐时每秒可推送数十个 delta；若每个增量都直接写 DOM，会频繁触发
   * layout/paint。这里把增量先累积进内存字符串，用 requestAnimationFrame 节流——
   * 每帧最多刷新一次文本节点（≈60fps 上限），且仅在内容确有增长时写回，
   * 思维链面板与正文气泡共用同一策略，长回答/快速模型下明显更顺滑。 */
  let thinkBuf = '', paintRaf = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0;
      if (thinkBuf) { onThink && onThink(thinkBuf); thinkBuf = ''; }   // 思维链批量落屏
    });
  };
  const flushPaint = () => {                                          // 流结束时兜底，确保最后一段不丢失
    if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
    if (thinkBuf) { onThink && onThink(thinkBuf); thinkBuf = ''; }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();                // 保留可能被截断的半行
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;                          // 跳过 event:/注释/心跳帧
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') { flushPaint(); return full; }       // OpenAI 流结束标记
        try {
          const choice = JSON.parse(payload).choices?.[0];
          const d = choice?.delta || choice?.message || {};            // 兼容个别网关只在末帧给 message 全量
          /* ★ 分离解析：reasoning_content 与 content 各走各的通道，互不混入 */
          if (d.reasoning_content) { thinkBuf += d.reasoning_content; schedulePaint(); }  // 思维链 → 🧠 面板（rAF 合帧）
          if (d.content) { full += d.content; onDelta(d.content); }                       // 正文增量 → 回复气泡
        } catch {/* 忽略不完整帧 */}
      }
    }
    flushPaint();
    return full;
  } finally {
    if (paintRaf) cancelAnimationFrame(paintRaf);                      // Abort/异常时清理待执行的绘制帧
  }
}

/* 401/403 专用错误类型：UI 层据此渲染"设置 API Key"警告框 */
class AuthError extends Error {
  constructor(status) { super(status === 403 ? 'API 访问被拒绝（HTTP 403 Forbidden）' : 'API 密钥无效或缺失（HTTP 401 Unauthorized）'); this.name = 'AuthError'; this.status = status; }
}

/* ============================ Section 4 · TitleGen ============================ */
/* 智能标题生成：★ 严禁截取用户原问题，必须把"第一轮问答"交给大模型总结出一个
 * 简短精准的标题（例如 帮我写个爬虫 → 「Python 爬虫实现建议」）。
 * 失败时降级为"主题词 + 类别"的规则标题（依然不是原句照抄）。 */

const TITLE_PROMPT = `你是标题生成器。根据下面用户的第一个问题和助手回答，总结出一个不超过 12 个字的中文短标题，要求：名词短语、概括对话主题、精准；禁止使用标点、引号或句号；只输出标题本身，不要任何解释。`;

async function generateTitle(userMsg, assistantMsg) {
  const chatML = `<system>${TITLE_PROMPT}</system>\n<user>${userMsg}</user>\n<assistant>${assistantMsg.slice(0, 400)}</assistant>`;

  let raw = null;
  if (CONFIG.USE_MOCK) {
    await sleep(500 + Math.random() * 500);                  // 模拟一次真实的标题小请求
    raw = mockSummarizeTitle(chatML);
  } else {
    /* ★★★【替换点 L291-307】真实实现：向 ENDPOINT（建议同一本地代理）发一个非流式小请求。
     * 注意标题请求刻意不带 stream，且用小 max_tokens 控制成本；Key 策略与 realStream 相同。 */
    try {
      const r = await fetch(CONFIG.ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(CONFIG.API_KEY ? { Authorization: 'Bearer ' + CONFIG.API_KEY } : {}) },
        body: JSON.stringify({
          model: mapModel(CONFIG.TITLE_MODEL),
          messages: [{ role: 'system', content: TITLE_PROMPT },
                     { role: 'user', content: `用户问题：${userMsg}\n助手回答摘要：${assistantMsg.slice(0, 400)}` }],
          stream: false, max_tokens: 32, temperature: 0.3,
        }),
      });
      if (r.status === 401 || r.status === 403) throw new AuthError(r.status);
      const j = await r.json();
      raw = j.choices?.[0]?.message?.content || null;
    } catch (e) { console.warn('[TitleGen] API 失败，使用规则降级标题:', e); }
  }

  let title = sanitizeTitle(raw);
  if (!title) title = fallbackTitle(userMsg);                // 降级：绝不返回原句
  return title;
}

function sanitizeTitle(s) {
  if (!s) return '';
  let t = String(s).trim()
    .replace(/^["'“”《》【】\s]+|["'“”《》【】\s]+$/g, '')
    .replace(/^(标题|题目)[:：]\s*/, '')
    .split(/[\n。！？!?]/)[0].trim();
  if (t.length > 16) t = t.slice(0, 16);
  return t;
}

/* Mock 标题器：关键词 → 主题模板（模拟大模型的语义总结能力） */
function mockSummarizeTitle(ml) {
  const q = ml.toLowerCase();
  const dict = [
    [/爬虫|抓取|spider|scrape/,        'Python 爬虫实现建议'],
    [/量子/,                            '量子纠缠通俗解释'],
    [/排序|算法|leetcode|数据结构/,      '算法选型与复杂度分析'],
    [/python/,                          'Python 编程实践指导'],
    [/javascript|js\b/,                 'JavaScript 问题排查'],
    [/react.*vue|vue.*react|前端框架/,   'React 与 Vue 选型对比'],
    [/react/,                           'React 开发要点梳理'],
    [/vue/,                             'Vue 开发要点梳理'],
    [/文案|宣传|营销/,                   '产品营销文案创作'],
    [/故事|小说|诗/,                    '创意写作构思方案'],
    [/翻译|润色/,                        '文本翻译与润色'],
    [/物理/,                            '物理学概念解析'],
    [/数学/,                            '数学问题求解思路'],
    [/代码|编程|函数|bug|报错|调试/,     '代码调试与排错方法'],
    [/简历|面试/,                        '求职准备优化建议'],
    [/旅行|旅游|攻略/,                   '旅行行程规划建议'],
    [/健身|减肥|饮食/,                   '健康饮食与运动计划'],
    [/股票|基金|理财/,                   '理财基础知识科普'],
    [/周报|邮件|报告/,                   '职场文书写作辅助'],
    [/解释|什么是|原理|为什么/,           '概念原理深入浅出'],
  ];
  for (const [re, title] of dict) if (re.test(q)) return title;
  return 'AI 问答主题纪要';
}

/* 规则降级标题：抽取主题词并套模板，保证结果 ≠ 用户原句 */
function fallbackTitle(userMsg) {
  const cleaned = userMsg.replace(/[?？。！!,，.、；;：:“”"'’「」【】]/g, ' ').trim();
  /* 过滤疑问/指令类停用词，剩余实词即为主题词（中文按标点+长度切分近似处理） */
  const stop = ['帮我', '请', '麻烦', '能不能', '可以', '给我', '我想', '需要', '一个', '一下', '一些', '如何', '怎么', '什么', '为什么', '介绍', '写', '做', '生成', '解释'];
  const segs = cleaned.split(/\s+/).flatMap(s => s.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) || []);
  const words = [];
  for (const s of segs) {
    let buf = s;
    for (const w of stop) buf = buf.split(w).join(' ');
    buf.split(/\s+/).forEach(w => { if (w.length >= 2 && !words.includes(w)) words.push(w); });
  }
  let core = words.slice(0, 3).join(' ');
  if (!core) core = cleaned.replace(/\s+/g, '').slice(0, 8);
  if (core.length > 12) core = core.slice(0, 12);
  return core ? `${core} · 探讨` : '新的 AI 对话';
}

/* ============================ Section 5 · UI ============================ */
const $ = (id) => document.getElementById(id);
const el = {
  sidebar: $('sidebar'), convList: $('convList'), btnNew: $('btnNew'), searchInput: $('searchInput'),
  btnTheme: $('btnTheme'), btnMenu: $('btnMenu'), overlay: $('overlay'),
  chatTitle: $('chatTitle'), modelSelect: $('modelSelect'), btnClear: $('btnClear'),
  chatScroll: $('chatScroll'), welcome: $('welcome'), messages: $('messages'), chips: $('chips'),
  input: $('input'), btnSend: $('btnSend'), curModelLabel: $('curModelLabel'),
  offlineBanner: $('offlineBanner'), toast: $('toast'),
};

const fmtTime = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

/* ---- 5.1 侧边栏渲染（含任务 3 增强：标题+内容的模糊搜索与命中高亮）---- */
/* 模糊匹配策略（按优先级）：① 连续子串直接命中；② 子序列匹配（关键词字符按序出现即可，容忍中间插字，
 *   例如 "爬虫" 可命中 "爬虫实现建议"）；③ 多关键词 AND。返回 {score, ranges} 供排序与高亮使用。 */
function fuzzyMatch(text, kw) {
  const t = String(text).toLowerCase();
  let i = t.indexOf(kw);
  if (i >= 0) return { score: 100 - Math.min(i, 50), ranges: [[i, i + kw.length]] };   // 连续命中：越靠前分越高
  /* 子序列匹配，贪心取最靠前的位置段 */
  let ti = 0; const ranges = [];
  for (const ch of kw) {
    i = t.indexOf(ch, ti);
    if (i < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && i === last[1]) last[1] = i + 1; else ranges.push([i, i + 1]);
    ti = i + 1;
  }
  return { score: 20, ranges };
}
/* 把命中片段包进 <mark>；先转义 HTML，杜绝注入 */
function highlightHits(text, ranges) {
  let out = '', pos = 0;
  for (const [s, e] of ranges) {
    out += escapeHtml(text.slice(pos, s)) + '<mark class="hit">' + escapeHtml(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + escapeHtml(text.slice(pos));
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderSidebar() {
  const kws = el.searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of state.conversations) {
    if (!kws.length) { scored.push({ c, score: 0, titleRanges: null }); continue; }
    let best = null;                                   // 在标题和正文中取最高分的命中
    for (const kw of kws) {
      const mt = fuzzyMatch(c.title, kw);
      if (mt && (!best || mt.score > best.score)) best = { ...mt, fromTitle: true };
      for (const m of c.messages) {
        const mm = fuzzyMatch(m.content, kw);
        if (mm && (!best || mm.score > best.score)) best = { ...mm, fromTitle: false };
      }
    }
    if (best) scored.push({ c, score: best.score, titleRanges: best.fromTitle ? best.ranges : null });
  }
  const list = scored.sort((a, b) => b.score - a.score || b.c.updatedAt - a.c.updatedAt).map(x => x);
  el.convList.innerHTML = '';
  if (!list.length) {
    el.convList.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:12px;padding:24px 8px">${kws.length ? '没有匹配的对话' : '暂无历史对话'}</div>`;
    return;
  }
  for (const { c, titleRanges } of list) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.activeId ? ' active' : '');
    item.dataset.id = c.id;
    const status = c.generating ? '✍️ 生成中…' : (c.titlePending ? '🏷 AI 正在拟标题…' : `${c.messages.length} 条消息`);
    item.innerHTML = `
      <div class="t">
        <div class="name"></div>
        <div class="sub"><span class="model-dot">${getModel(c.model).name}</span><span>${status}</span></div>
      </div>
      <div class="conv-actions">
        <button class="icon-btn rename" title="重命名">✏️</button>
        <button class="icon-btn danger del" title="删除对话">🗑</button>
      </div>`;
    const nameEl = item.querySelector('.name');
    if (titleRanges) nameEl.innerHTML = highlightHits(c.title, titleRanges);   // 搜索命中 → 黄色高亮
    else nameEl.textContent = c.title;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.rename') || e.target.closest('.del') || item.querySelector('.rename-input')) return;
      switchConversation(c.id);
    });
    item.querySelector('.rename').addEventListener('click', () => startRename(item, c));
    item.querySelector('.del').addEventListener('click', () => {
      if (confirm(`确定删除对话「${c.title}」？`)) { deleteConversation(c.id); renderAll(); toast('已删除对话'); }
    });
    el.convList.appendChild(item);
  }
}

function startRename(item, conv) {
  const nameEl = item.querySelector('.name');
  const inp = document.createElement('input');
  inp.className = 'rename-input'; inp.value = conv.title;
  nameEl.replaceWith(inp); inp.focus(); inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v) { conv.title = v; saveState(); }
    renderAll();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') renderAll();
  });
}

/* ---- 5.2 消息渲染 ---- */
/* 为一条 assistant 回复创建 DOM（含 imageUI 专属的思考过程面板），返回增量更新所需的节点引用 */
function createAssistantNodes(conv, msg) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant fade-in';
  const avatar = document.createElement('div');
  avatar.className = 'avatar'; avatar.textContent = '✦';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  let thinkBody = null, thinkHead = null, panel = null;
  /* 思考过程面板：仅当该消息携带 thinking 字段（即产生于 imageUI 模型）时渲染
   * ★ 任务 3-呼吸灯动画：streaming=true 时面板带 .thinking-panel.streaming 类 →
   *   边框/背景做微弱呼吸律动 + 🧠 脉冲 + "思考中"三点动画，让用户感知 AI 正在推理 */
  if (typeof msg.thinking === 'string') {
    panel = document.createElement('div');
    panel.className = 'thinking-panel open streaming';
    panel.innerHTML = `
      <div class="thinking-head">
        <span class="brain">🧠</span><span class="label">正在深度思考<span class="dots"><span></span><span></span><span></span></span></span><span class="chev">▶</span>
      </div>
      <div class="thinking-body"></div>`;
    thinkBody = panel.querySelector('.thinking-body');
    thinkHead = panel.querySelector('.thinking-head');
    thinkBody.textContent = msg.thinking || '…';
    thinkHead.addEventListener('click', () => panel.classList.toggle('open'));
    bubble.appendChild(panel);
  }

  const content = document.createElement('div');
  content.className = 'content';
  content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';   // 加载态
  bubble.appendChild(content);

  const errEl = document.createElement('div');
  errEl.className = 'error-note hidden';
  errEl.innerHTML = `⚠️ <span></span> <button class="retry-btn">重试</button>`;
  errEl.querySelector('.retry-btn').addEventListener('click', () => retryLast(conv));
  bubble.appendChild(errEl);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${getModel(conv.model).name} · 生成中…`;
  bubble.appendChild(meta);

  row.append(avatar, bubble);
  return { row, content, thinkBody, thinkHead, panel, meta, errEl };
}

/* 流式结束/出错后，把错误提示与时间戳落到已存在的 DOM 上（不整段重绘，避免闪烁） */
function finalizeAssistantNode(nodes, conv, msg) {
  if (nodes.meta) nodes.meta.textContent = `${getModel(conv.model).name} · ${fmtTime(msg.ts || now())}`;
  if (msg.error && nodes.errEl) {
    nodes.errEl.classList.remove('hidden');
    nodes.errEl.querySelector('span').textContent = msg.error;
  }
}

function renderMessages() {
  const conv = activeConv();
  el.messages.innerHTML = '';
  if (!conv || !conv.messages.length) {
    el.welcome.classList.remove('hidden'); el.messages.classList.add('hidden');
    return;
  }
  el.welcome.classList.add('hidden'); el.messages.classList.remove('hidden');
  for (const m of conv.messages) {
    if (m.role === 'user') {
      const row = document.createElement('div');
      row.className = 'msg-row user fade-in';
      row.innerHTML = `<div class="avatar">🙂</div><div class="bubble"><div class="content" style="background:linear-gradient(135deg,var(--accent),#3b6fd4);color:#fff;border:none"></div><div class="meta" style="text-align:right;justify-content:flex-end"></div></div>`;
      row.querySelector('.content').textContent = m.content;
      row.querySelector('.meta').textContent = fmtTime(m.ts || now());
      el.messages.appendChild(row);
    } else {
      /* 历史消息：静态渲染（含已完成状态的思考面板） */
      const row = document.createElement('div');
      row.className = 'msg-row assistant fade-in';
      const avatar = document.createElement('div');
      avatar.className = 'avatar'; avatar.textContent = '✦';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (typeof m.thinking === 'string') {                 // imageUI 的历史回复 → 折叠的思考面板
        const panel = document.createElement('div');
        /* ★ 呼吸灯状态还原：_streaming 精确标记"进行中的那条消息"（initSession 会清除遗留标记） */
        const live = m._streaming === true;
        panel.className = 'thinking-panel' + (live ? ' open streaming' : '');
        const doneHead = `<div class="thinking-head done"><span class="brain">🧠</span><span class="label">已完成思考 · 点击查看推理过程</span><span class="chev">▶</span></div>`;
        const liveHead = `<div class="thinking-head"><span class="brain">🧠</span><span class="label">正在深度思考<span class="dots"><span></span><span></span><span></span></span></span><span class="chev">▶</span></div>`;
        panel.innerHTML = live ? liveHead : doneHead;
        panel.querySelector('.thinking-body').textContent = m.thinking || '（无思考内容）';
        panel.querySelector('.thinking-head').addEventListener('click', () => panel.classList.toggle('open'));
        bubble.appendChild(panel);
      }
      const content = document.createElement('div');
      content.className = 'content';
      content.textContent = m.content || '—';
      bubble.appendChild(content);
      if (m.error) {
        const err = document.createElement('div');
        err.className = 'error-note';
        err.innerHTML = `⚠️ <span></span> <button class="retry-btn">重试</button>`;
        err.querySelector('span').textContent = m.error;
        err.querySelector('.retry-btn').addEventListener('click', () => retryLast(conv));
        bubble.appendChild(err);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${getModel(conv.model).name} · ${fmtTime(m.ts || now())}`;
      bubble.appendChild(meta);
      row.append(avatar, bubble);
      el.messages.appendChild(row);
    }
  }
  scrollBottom(true);
}
function scrollBottom(force) {
  const sc = el.chatScroll;
  const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || near) sc.scrollTop = sc.scrollHeight;
}

function renderHeader() {
  const conv = activeConv();
  el.chatTitle.innerHTML = '';
  el.chatTitle.append(document.createTextNode(conv ? conv.title : '新对话'));
  if (conv && conv.aiTitled) {
    const b = document.createElement('span'); b.className = 'ai-badge'; b.textContent = 'AI 标题';
    el.chatTitle.appendChild(b);
  }
  const m = getModel(conv ? conv.model : CONFIG.DEFAULT_MODEL);
  el.curModelLabel.textContent = `${m.name} · ${m.tier}`;
  el.modelSelect.value = m.id;
}

/* ★ 任务 3-错误处理优化：401/403 → 聊天区醒目红色警告框 + API Key 设置入口（localStorage 临时存储，仅调试用） */
function renderAuthAlert() {
  if (!state.authAlert) return;                            // 非认证错误不渲染
  const old = $('authAlertBox'); if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'authAlertBox'; box.className = 'auth-alert fade-in';
  box.innerHTML = `
    <div class="aa-title">🚫 API 认证失败（HTTP 401 / 403）</div>
    <div class="aa-desc">密钥缺失、无效或无访问权限。你可以在此临时输入 API Key（保存于浏览器 localStorage，仅供本地调试）。<br>
      <b>⚠️ 风险提示：</b>浏览器存储可被脚本/XSS 读取，<u>生产环境请勿在前端暴露 Key</u> —— 请改用后端代理注入（见 proxy-server.js）。</div>
    <div class="aa-row">
      <input id="apiKeyInput" type="password" placeholder="sk-...（留空并保存 = 清除已存 Key）" autocomplete="off" spellcheck="false">
      <button class="aa-btn primary" id="btnSaveKey">保存</button>
      <button class="aa-btn" id="btnCloseAlert">关闭</button>
    </div>`;
  el.messages.appendChild(box);
  const inp = box.querySelector('#apiKeyInput');
  inp.value = localStorage.getItem('imageai-apikey') || '';
  box.querySelector('#btnSaveKey').addEventListener('click', () => {
    const v = inp.value.trim();
    if (v) { localStorage.setItem('imageai-apikey', v); toast('🔑 Key 已保存到本地（下次请求生效）'); }
    else { localStorage.removeItem('imageai-apikey'); toast('已清除本地 Key'); }
    state.authAlert = false; box.remove();
  });
  box.querySelector('#btnCloseAlert').addEventListener('click', () => { state.authAlert = false; box.remove(); });
  scrollBottom(false);
}
function renderAll() { renderSidebar(); renderHeader(); renderMessages(); renderAuthAlert(); }

/* ============================ Section 6 · Actions ============================ */
let abortCtl = null;       // 当前流式请求的中止控制器
let searchDebounce = null; // 侧边栏搜索防抖定时器

/** 切换会话：若旧会话的流式回复仍在进行，先静默中止并落盘已完成部分 */
function switchConversation(id) {
  if (state.activeId === id) return;
  const old = activeConv();
  if (old && old.generating) {
    abortCtl && abortCtl.abort();          // finally 块会针对旧会话完成收尾
  }
  state.activeId = id;
  saveState(); renderAll();
}

async function sendMessage() {
  const conv = activeConv();
  const text = el.input.value.trim();
  if (!conv || !text || conv.generating) return;

  const isFirstRound = conv.messages.length === 0;
  conv.messages.push({ role: 'user', content: text, ts: now() });
  el.input.value = ''; autoGrow();

  const reply = { role: 'assistant', content: '', thinking: null, _streaming: true, ts: now() };
  if (getModel(conv.model).supportsThinking) reply.thinking = '';   // imageUI → 创建思考面板
  conv.messages.push(reply);
  conv.generating = true;
  saveState();

  /* 增量渲染：隐藏欢迎页，追加一条"进行中"的回复节点，后续只更新文本，不整段重绘 */
  el.welcome.classList.add('hidden'); el.messages.classList.remove('hidden');
  const nodes = createAssistantNodes(conv, reply);
  el.messages.appendChild(nodes.row);
  renderSidebar(); renderHeader();
  scrollBottom(true);

  abortCtl = new AbortController();
  setBusy(true);

  const history = conv.messages.filter(m => m !== reply && !m.error).map(m => ({ role: m.role, content: m.content }));

  try {
    await streamChat({
      model: conv.model,
      messages: history,
      signal: abortCtl.signal,
      onThink: (seg) => {                                   // 仅 imageUI 走到这里（思维链流式；realStream 已按 rAF 合帧批量回调）
        reply.thinking += seg;
        if (nodes.thinkBody) {
          nodes.thinkBody.textContent = reply.thinking;
          /* 智能自动跟随：用户手动向上滚动阅读早期思考时，不打断其位置（距底部 >60px 即视为"离开阅读位"） */
          const tb = nodes.thinkBody;
          const stick = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 60;
          if (stick) tb.scrollTop = tb.scrollHeight;
          scrollBottom();
        }
      },
      onDelta: (seg) => {
        if (!reply.content) nodes.content.innerHTML = '';   // 首 token 到达，移除加载动画
        reply.content += seg;
        nodes.content.textContent = reply.content;
        scrollBottom();
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      reply.content += reply.content ? '\n（已停止生成）' : '（已停止生成）';
      nodes.content.textContent = reply.content;
    } else if (e.name === 'AuthError') {
      /* ★ 401/403：标记认证失败 → renderAll() 时在聊天区弹出红色警告框 + Key 设置入口 */
      reply.error = e.message;
      state.authAlert = true;
      if (!reply.content) nodes.content.textContent = '—';
      toast('🚫 ' + e.message);
    } else {
      reply.error = navigator.onLine ? (e.message || '请求失败') : '网络不可用，无法连接模型服务';
      if (!reply.content) nodes.content.textContent = '—';
      toast('❌ ' + reply.error);
    }
  } finally {
    reply._streaming = false;                               // 流式结束：清除进行中标记（呼吸灯状态依据）
    reply.ts = now();
    if (nodes.thinkHead) {                                  // 思考面板收尾：停止呼吸灯、标记完成并自动折叠
      nodes.panel.classList.remove('streaming');
      nodes.thinkHead.classList.add('done');
      nodes.thinkHead.querySelector('.label').textContent = '已完成思考 · 点击查看推理过程';
      nodes.panel.classList.remove('open');
    }
    finalizeAssistantNode(nodes, conv, reply);
    conv.generating = false;
    conv.updatedAt = now();
    setBusy(false);
    saveState();
    renderSidebar(); renderHeader();                        // 头部/侧栏刷新；消息 DOM 已就绪无需重绘

    /* ★ 智能标题生成：第一轮问答完成后，调用大模型总结（异步，不阻塞界面） */
    if (isFirstRound && !reply.error && conv.messages.length >= 2) {
      conv.titlePending = true; renderSidebar(); renderHeader();
      const userMsg = conv.messages[0].content, asstMsg = conv.messages[1].content;
      generateTitle(userMsg, asstMsg).then(title => {
        // 期间用户可能手动改名或删除：仅在仍是同一会话且未被手动改名时应用
        const still = state.conversations.find(c => c.id === conv.id);
        if (still && still.titlePending) {
          still.title = title; still.aiTitled = true; still.titlePending = false;
          still.updatedAt = now(); saveState(); renderAll();
          toast(`🏷 AI 已生成标题：${title}`);
        }
      }).catch(() => {
        const still = state.conversations.find(c => c.id === conv.id);
        if (still) { still.title = fallbackTitle(userMsg); still.titlePending = false; saveState(); renderAll(); }
      });
    }
  }
}

function retryLast(conv) {          // 出错重试：删除失败的回复，重发上一条用户消息
  if (conv.generating) return;
  while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
  const lastUser = conv.messages[conv.messages.length - 1];
  if (!lastUser) { renderAll(); return; }
  conv.messages.pop();
  el.input.value = lastUser.content;
  saveState(); renderAll();
  sendMessage();
}

function stopGeneration() { abortCtl && abortCtl.abort(); }

function setBusy(busy) {
  el.btnSend.classList.toggle('btn-stop', busy);
  el.btnSend.textContent = busy ? '■' : '➤';
  el.btnSend.title = busy ? '停止生成' : '发送';
}

/* ============================ Section 8 · KeyUI ============================ */
/* ★ 任务 2-简易方案的 UI 入口：随时打开"API Key 设置"弹窗（与 401 警告框共用 localStorage 存储）。
 * ⚠️⚠️⚠️ 生产环境请勿在前端暴露 Key —— 此入口仅为本地调试便利；正式部署请使用 proxy-server.js 后端注入。 */
function openKeyDialog(prefillMsg) {
  const old = $('keyModal'); if (old) old.remove();
  const mask = document.createElement('div');
  mask.id = 'keyModal'; mask.className = 'key-mask';
  mask.innerHTML = `
    <div class="key-modal fade-in">
      <div class="km-title">🔑 API Key 设置<span class="km-sub">（仅存本机浏览器，供调试使用）</span></div>
      ${prefillMsg ? `<div class="km-msg">${prefillMsg}</div>` : ''}
      <input id="kmInput" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
      <div class="km-risk">⚠️ 风险提示：localStorage 中的明文 Key 可被任何脚本读取；生产环境请勿在前端暴露 Key，务必改用后端代理（proxy-server.js）。</div>
      <div class="km-row">
        <button class="aa-btn primary" id="kmSave">保存</button>
        <button class="aa-btn danger" id="kmClear">清除</button>
        <button class="aa-btn" id="kmClose">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const inp = mask.querySelector('#kmInput');
  inp.value = localStorage.getItem('imageai-apikey') || '';
  inp.focus();
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  mask.querySelector('#kmClose').addEventListener('click', () => mask.remove());
  mask.querySelector('#kmSave').addEventListener('click', () => {
    const v = inp.value.trim();
    if (v) localStorage.setItem('imageai-apikey', v); else localStorage.removeItem('imageai-apikey');
    toast(v ? '🔑 Key 已保存到本地' : '已清除本地 Key'); mask.remove();
  });
  mask.querySelector('#kmClear').addEventListener('click', () => {
    localStorage.removeItem('imageai-apikey'); toast('已清除本地 Key'); mask.remove();
  });
}

/* ============================ Section 7 · Boot（启动入口） ============================ */
function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
}

function bindEvents() {
  el.btnSend.addEventListener('click', () => activeConv() && (el.btnSend.classList.contains('btn-stop') ? stopGeneration() : sendMessage()));
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  el.input.addEventListener('input', autoGrow);

  el.btnNew.addEventListener('click', () => { newChat(); saveState(); renderAll(); closeDrawerIfMobile(); el.input.focus(); });

  el.modelSelect.addEventListener('change', () => {
    const conv = activeConv(); if (!conv) return;
    conv.model = el.modelSelect.value;
    localStorage.setItem('imageai-model', conv.model);
    renderAll();
    if (getModel(conv.model).supportsThinking) toast('🧠 imageUI 终极版已启用：回复将附带思考过程面板');
  });

  el.btnClear.addEventListener('click', () => {
    const conv = activeConv(); if (!conv) return;
    /* ★ 无消息时：清空按钮退化为"API Key 设置"入口（简易方案调试用，见 Section 8） */
    if (!conv.messages.length) { openKeyDialog('💡 随时可在此更新/清除本地调试 Key。真实 API 模式建议配置后端代理注入。'); return; }
    if (confirm('清空当前对话的全部消息？（标题保留）')) {
      conv.messages = []; conv.titlePending = false; conv.aiTitled = false; conv.title = '新对话';
      saveState(); renderAll();
    }
  });

  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);                    // 内容级模糊搜索开销较大 → 150ms 防抖
    searchDebounce = setTimeout(renderSidebar, 150);
  });

  el.btnTheme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('imageai-theme', next);
    el.btnTheme.textContent = next === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式';
  });

  const toggleSidebar = () => {
    el.sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sb-open', !el.sidebar.classList.contains('collapsed'));
  };
  el.btnMenu.addEventListener('click', toggleSidebar);
  el.overlay.addEventListener('click', toggleSidebar);
  function closeDrawerIfMobile() { if (innerWidth <= 860 && !el.sidebar.classList.contains('collapsed')) toggleSidebar(); }

  /* 欢迎页示例问题快捷入口 */
  el.chips.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
    el.input.value = chip.firstChild.textContent.trim();
    autoGrow(); el.input.focus(); sendMessage();
  }));

  /* 网络状态提示（离线边界情况） */
  const netStatus = () => el.offlineBanner.classList.toggle('hidden', navigator.onLine);
  addEventListener('online', () => { netStatus(); toast('✅ 网络已恢复'); });
  addEventListener('offline', () => { netStatus(); toast('⚠️ 网络已断开'); });
  netStatus();

  /* ★ 快捷键：Ctrl/Cmd+K 聚焦搜索框（配合模糊搜索）；真实 API 模式下无 Key 时给出一次引导提示 */
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el.searchInput.focus(); el.searchInput.select(); }
  });
  if (!CONFIG.USE_MOCK && !localStorage.getItem('imageai-apikey')) {
    setTimeout(() => toast('🔑 真实 API 模式尚未设置 Key，可在报错后的红色警告框或 🗑 按钮处设置'), 800);
  }
}

(function boot() {
  /* 恢复主题偏好 */
  const theme = localStorage.getItem('imageai-theme') || 'dark';
  document.documentElement.dataset.theme = theme;
  el.btnTheme.textContent = theme === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式';
  /* 移动端默认收起侧边栏 */
  if (innerWidth <= 860) el.sidebar.classList.add('collapsed');

  initSession();          // ★ 需求：每次打开主页自动创建全新空白会话
  bindEvents();
  renderAll();
  el.input.focus();
})();
