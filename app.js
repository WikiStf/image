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
  ENDPOINT: '/v1/chat/completions',     // ★【替换点】真实 OpenAI 兼容 API 端点，例如 https://api.openai.com/v1/chat/completions
  API_KEY: '',                          // ★【替换点】真实环境请通过后端代理注入，切勿在前端硬编码 Key
  STORAGE_KEY: 'imageai-chat-v1',
  DEFAULT_MODEL: 'image1.5',
};

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
const state = { conversations: [], activeId: null };

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
  // 复位上次遗留的流式状态（防止刷新时中断在"生成中"）
  state.conversations.forEach(c => { c.generating = false; });
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

/* ---- 3.2 真实 API 框架（预留）----
 * ★★★【替换点】接入真实大模型时：
 *   1. CONFIG.USE_MOCK = false，ENDPOINT 指向你自己的后端代理（由代理注入 API Key）；
 *   2. 后端转发时带上 stream:true；推理模型（DeepSeek-R1 / QwQ 等）的思考内容
 *      位于每个 chunk 的 delta.reasoning_content 字段，本函数已解析并经 onThink 透出，
 *      前端 imageUI 的思考面板无需任何改动即可显示真实思维链。 */
async function realStream({ model, messages, onThink, onDelta, signal }) {
  const resp = await fetch(CONFIG.ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CONFIG.API_KEY ? { Authorization: 'Bearer ' + CONFIG.API_KEY } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`API 错误 HTTP ${resp.status}`);

  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const d = JSON.parse(payload).choices?.[0]?.delta || {};
        if (d.reasoning_content) onThink && onThink(d.reasoning_content);   // 思维链增量
        if (d.content) { full += d.content; onDelta(d.content); }           // 正文增量
      } catch {/* 忽略心跳/不完整帧 */}
    }
  }
  return full;
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
    /* ★★★【替换点】真实实现：向 ENDPOINT 发一个非流式小请求即可 */
    try {
      const r = await fetch(CONFIG.ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(CONFIG.API_KEY ? { Authorization: 'Bearer ' + CONFIG.API_KEY } : {}) },
        body: JSON.stringify({
          model: CONFIG.DEFAULT_MODEL,
          messages: [{ role: 'system', content: TITLE_PROMPT },
                     { role: 'user', content: `用户问题：${userMsg}\n助手回答摘要：${assistantMsg.slice(0, 400)}` }],
          stream: false, max_tokens: 32, temperature: 0.3,
        }),
      });
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

/* ---- 5.1 侧边栏渲染 ---- */
function renderSidebar() {
  const kw = el.searchInput.value.trim().toLowerCase();
  const list = [...state.conversations]
    .filter(c => !kw || c.title.toLowerCase().includes(kw) || c.messages.some(m => m.content.toLowerCase().includes(kw)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  el.convList.innerHTML = '';
  if (!list.length) {
    el.convList.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:12px;padding:24px 8px">${kw ? '没有匹配的对话' : '暂无历史对话'}</div>`;
    return;
  }
  for (const c of list) {
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
    item.querySelector('.name').textContent = c.title;
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
  /* 思考过程面板：仅当该消息携带 thinking 字段（即产生于 imageUI 模型）时渲染 */
  if (typeof msg.thinking === 'string') {
    panel = document.createElement('div');
    panel.className = 'thinking-panel open';
    panel.innerHTML = `
      <div class="thinking-head">
        <span class="brain">🧠</span><span class="label">正在深度思考…</span><span class="chev">▶</span>
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
        panel.className = 'thinking-panel';
        panel.innerHTML = `<div class="thinking-head done"><span class="brain">🧠</span><span class="label">已完成思考 · 点击查看推理过程</span><span class="chev">▶</span></div><div class="thinking-body"></div>`;
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
function renderAll() { renderSidebar(); renderHeader(); renderMessages(); }

/* ============================ Section 6 · Actions ============================ */
let abortCtl = null;   // 当前流式请求的中止控制器

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
      onThink: (seg) => {                                   // 仅 imageUI 走到这里（思维链流式）
        reply.thinking += seg;
        if (nodes.thinkBody) { nodes.thinkBody.textContent = reply.thinking; scrollBottom(); }
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
    } else {
      reply.error = navigator.onLine ? (e.message || '请求失败') : '网络不可用，无法连接模型服务';
      if (!reply.content) nodes.content.textContent = '—';
      toast('❌ ' + reply.error);
    }
  } finally {
    reply._streaming = false;
    reply.ts = now();
    if (nodes.thinkHead) {                                  // 思考面板收尾：标记完成并自动折叠
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

/* ============================ Section 7 · Boot ============================ */
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
    const conv = activeConv(); if (!conv || !conv.messages.length) return;
    if (confirm('清空当前对话的全部消息？（标题保留）')) {
      conv.messages = []; conv.titlePending = false; conv.aiTitled = false; conv.title = '新对话';
      saveState(); renderAll();
    }
  });

  el.searchInput.addEventListener('input', renderSidebar);

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
