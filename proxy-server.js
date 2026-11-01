/* =====================================================================
 * proxy-server.js — 生产级 LLM 代理服务器（零依赖，Node.js >= 18）
 * ---------------------------------------------------------------------
 * ★ 任务 2 · 推荐方案：密钥安全管理
 *   前端（index.html + app.js）只请求本代理（http://localhost:3001），
 *   API Key 由本进程从环境变量读取并注入 Authorization 头后转发上游。
 *   Key 永远不进入浏览器代码、网络面板或 localStorage。
 *
 *   ⚠️⚠️⚠️ 生产环境请勿在前端暴露 Key —— 必须经由本类后端代理转发！
 *
 * ★ 稳定性升级（24/7 运行）：
 *   - GET  /health          心跳检测接口 { status, uptime, startedAt, version }
 *   - server.log            结构化日志（启动时间 / 错误请求 / 崩溃堆栈），自动轮转(>5MB)
 *   - uncaughtException / unhandledRejection 捕获 → 记日志后指数退避自杀重启
 *     （Windows 下请配合 start-daemon.bat 的守护循环实现"崩溃自动重启"）
 *   - 优雅退出：Ctrl+C / SIGTERM 时记录 shutdown 日志
 *   - 端口占用友好提示（EADDRINUSE）
 *
 * 运行：
 *   OPENAI_API_KEY=sk-xxxx UPSTREAM=https://api.deepseek.com node proxy-server.js
 *   # 默认 UPSTREAM = https://api.openai.com
 *   # Windows PowerShell: $env:OPENAI_API_KEY="sk-xxx"; $env:UPSTREAM="https://api.deepseek.com"; node proxy-server.js
 *   # Windows 一键启动（隐藏窗口+守护）：双击 start-daemon.bat
 * 前端配合（app.js Section 1）：
 *   USE_MOCK : false
 *   ENDPOINT : 'http://localhost:3001/v1/chat/completions'
 *   （前端不再需要携带任何 Key；CONFIG.API_KEY 留空即可）
 * ===================================================================== */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const VERSION  = '2.0.0';
const PORT     = process.env.PORT || 3001;
const UPSTREAM = (process.env.UPSTREAM || 'https://api.openai.com').replace(/\/+$/, '');
const API_KEY  = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''; // ← Key 只存在于服务端进程环境
const STARTED_AT = new Date().toISOString();

/* ---------------- 日志系统：stdout + server.log 双写，超 5MB 自动轮转 ---------------- */
const LOG_FILE = path.join(__dirname, 'server.log');
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  (level === 'ERROR' ? console.error : console.log)(`[proxy] ${line}`);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');            // 保留一份历史 .1
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志写入失败不影响服务本身 */ }
}
log('INFO', `proxy v${VERSION} 初始化 · 上游=${UPSTREAM} · 端口=${PORT}`);
if (!API_KEY) log('WARN', '未设置 OPENAI_API_KEY 环境变量，启动后将一律返回 401（防止误裸奔）');

const CORS = {
  'Access-Control-Allow-Origin': '*',        // 本地调试放开；生产请收紧为你的前端域名
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const server = http.createServer(async (req, res) => {
  /* 预检请求 */
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  /* ★ 心跳检测：GET /health → 供监控/守护脚本探活（24 小时运行必备） */
  if (req.method === 'GET' && /^\/health\/?$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({
      status: 'ok', version: VERSION, port: +PORT,
      startedAt: STARTED_AT, uptimeSec: Math.round(process.uptime()),
      keyConfigured: !!API_KEY, upstream: UPSTREAM,
    }));
  }

  /* 仅代理 OpenAI 兼容的 chat/completions 路径 */
  if (req.method !== 'POST' || !/^\/v1\/chat\/completions\/?$/.test(req.url)) {
    log('WARN', `404 ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ error: 'Not found. Use POST /v1/chat/completions or GET /health' }));
  }
  if (!API_KEY) {                              // 无 Key 时明确拒绝，避免把失败请求打到上游
    log('WARN', '401 请求被拒：代理未配置 OPENAI_API_KEY');
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
      signal: AbortSignal.timeout(300_000),    // 5 分钟兜底超时，防止上游挂死拖垮代理
    });

    if (!upstream.ok) log('ERROR', `上游返回 ${upstream.status}（model=${(() => { try { return JSON.parse(body.toString()).model; } catch { return '?'; } })()}）`);

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
    log('ERROR', `上游请求失败: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { message: `Bad gateway: ${e.message}` } }));
    } else {
      res.end();                                // 已发出部分 SSE → 只能截断收尾
    }
  }
});

/* ---------------- 进程健壮性：崩溃捕获 + 端口占用提示 + 优雅退出 ---------------- */
process.on('uncaughtException', (e) => {
  log('FATAL', `uncaughtException: ${e.stack || e.message}`);
  setTimeout(() => process.exit(1), 200);       // 落盘日志后退出，交给守护脚本/PM2 拉起
});
process.on('unhandledRejection', (e) => {
  log('ERROR', `unhandledRejection: ${(e && e.stack) || e}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('FATAL', `端口 ${PORT} 已被占用：可能已有代理在运行。请先结束旧进程，或用 PORT=3002 node proxy-server.js 换端口。`);
    console.error(`[proxy] ❌ 端口 ${PORT} 被占用（见 server.log）`);
    process.exit(1);
  } else {
    log('FATAL', `server error: ${e.message}`);
    process.exit(1);
  }
});

function gracefulExit(sig) {
  log('INFO', `收到 ${sig}，正在优雅退出…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();   // 3 秒内强制收尾
}
process.on('SIGINT',  () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

server.listen(PORT, () => {
  log('INFO', `✅ LLM 代理已启动 → http://localhost:${PORT}/v1/chat/completions · 心跳: GET /health`);
  log('INFO', `上游地址: ${UPSTREAM}/v1/chat/completions`);
  log('INFO', '⚠️ 生产环境请勿在前端暴露 Key：Key 仅保存在本进程环境变量中。');
  console.log(`[proxy] ✅ 已就绪 http://localhost:${PORT} （心跳检测: curl http://localhost:${PORT}/health）`);
});
