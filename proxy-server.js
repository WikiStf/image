/* =====================================================================
 * proxy-server.js — 最简 LLM 代理服务器（零依赖，Node.js >= 18）
 * ---------------------------------------------------------------------
 * ★ 任务 2 · 推荐方案：密钥安全管理
 *   前端（index.html + app.js）只请求本代理（http://localhost:3001），
 *   API Key 由本进程从环境变量读取并注入 Authorization 头后转发上游。
 *   Key 永远不进入浏览器代码、网络面板或 localStorage。
 *
 *   ⚠️⚠️⚠️ 生产环境请勿在前端暴露 Key —— 必须经由本类后端代理转发！
 *
 * 运行：
 *   OPENAI_API_KEY=sk-xxxx UPSTREAM=https://api.deepseek.com node proxy-server.js
 *   # 默认 UPSTREAM = https://api.openai.com
 * 前端配合（app.js Section 1）：
 *   USE_MOCK : false
 *   ENDPOINT : 'http://localhost:3001/v1/chat/completions'
 *   （前端不再需要携带任何 Key；CONFIG.API_KEY 留空即可）
 * ===================================================================== */
'use strict';

const http = require('http');

const PORT     = process.env.PORT || 3001;
const UPSTREAM = (process.env.UPSTREAM || 'https://api.openai.com').replace(/\/+$/, '');
const API_KEY  = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''; // ← Key 只存在于服务端进程环境
if (!API_KEY) console.warn('[proxy] ⚠️ 未设置 OPENAI_API_KEY 环境变量，启动后将一律返回 401（防止误裸奔）');

const CORS = {
  'Access-Control-Allow-Origin': '*',        // 本地调试放开；生产请收紧为你的前端域名
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const server = http.createServer(async (req, res) => {
  /* 预检请求 */
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  /* 仅代理 OpenAI 兼容的 chat/completions 路径 */
  if (req.method !== 'POST' || !/^\/v1\/chat\/completions\/?$/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'Not found. Use POST /v1/chat/completions' }));
  }
  if (!API_KEY) {                              // 无 Key 时明确拒绝，避免把失败请求打到上游
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: { message: 'Proxy missing OPENAI_API_KEY', type: 'proxy_auth_error' } }));
  }

  /* 收集前端请求体（messages / model / stream ...），原样转发，仅替换鉴权头 */
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  try {
    const upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,    // ★★★ Key 只在这一行出现——且只在服务端
      },
      body,
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
      ...CORS,
    });

    /* 流式（SSE）逐块透传；非流式则整体转发 —— 保留 delta.reasoning_content 供前端思考面板解析 */
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (e) {
    console.error('[proxy] 上游请求失败:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: `Bad gateway: ${e.message}` } }));
  }
});

server.listen(PORT, () => {
  console.log(`[proxy] ✅ LLM 代理已启动 → http://localhost:${PORT}/v1/chat/completions`);
  console.log(`[proxy]    上游地址: ${UPSTREAM}/v1/chat/completions`);
  console.log(`[proxy]    ⚠️ 生产环境请勿在前端暴露 Key：Key 仅保存在本进程环境变量中。`);
});
