/* =====================================================================
 * ecosystem.config.js — PM2 进程守护配置（★ 任务 1：服务器持久化 / 24·7 运行）
 * ---------------------------------------------------------------------
 * 适用：长期后台运行（Linux/macOS/Windows 均可，Windows 推荐用 start-daemon.bat）
 *
 * 使用（需先安装 PM2：npm i -g pm2）：
 *   pm2 start ecosystem.config.js          # 启动守护
 *   pm2 logs imageai-proxy --lines 50      # 查看日志（同时写 server.log）
 *   pm2 startup && pm2 save                # 开机自启 + 保存进程列表
 *   pm2 restart imageai-proxy              # 手动重启
 *   curl http://localhost:3001/health      # 心跳探活
 *
 * ⚠️ API Key 通过 shell 环境变量注入（pm2 会继承当前环境），严禁写入本文件！
 *    $env:OPENAI_API_KEY="sk-xxx"; pm2 start ecosystem.config.js   (PowerShell)
 * ===================================================================== */
module.exports = {
  apps: [{
    name: 'imageai-proxy',            // pm2 进程名
    script: 'proxy-server.js',
    cwd: __dirname,
    /* 崩溃自动重启策略 */
    autorestart: true,                // 进程退出后自动拉起
    restart_delay: 3000,              // 每次重启间隔 3s，防止疯狂重启风暴
    max_restarts: 50,                 // 连续快速失败上限（超过则进入 stopped，见日志排查）
    min_uptime: '10s',                // 存活不足 10s 视为异常退出，计入 restart 风暴检测
    max_memory_restart: '256M',       // 内存超 256MB 自动平滑重启（长稳运行保险丝）
    /* 日志（PM2 层，与 proxy 自身 server.log 互补） */
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    time: true,                       // 日志行前加时间戳
    /* 环境变量（只放非敏感项；Key 来自启动时的 shell 环境） */
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      UPSTREAM: 'https://api.deepseek.com',   // ★ 按需改为你的上游：Qwen=https://dashscope.aliyuncs.com/compatible-mode
    },
  }],
};
