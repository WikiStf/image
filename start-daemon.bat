@echo off
rem =====================================================================
rem start-daemon.bat - 24/7 watchdog launcher (Windows 10, zero install)
rem ---------------------------------------------------------------------
rem 作用：把 proxy-server.js 挂在无限守护循环里 —— 进程崩溃 / 被杀 / 端口
rem       冲突退出后，等待 3 秒自动重新拉起；日志统一追加到 server.log。
rem 用法：
rem   1) 先设置环境变量（推荐）：set OPENAI_API_KEY=sk-xxxx  （或运行 start.bat）
rem   2) 双击本文件即可；关闭本命令行窗口 = 停止守护。
rem 提示：需要"开机自启 + 静默后台"请改用 PM2：pm2 start ecosystem.config.js
rem ⚠️ 生产环境请勿在前端暴露 Key —— Key 只进代理进程环境。
rem =====================================================================
setlocal
cd /d "%~dp0"

if "%OPENAI_API_KEY%"=="" (
    echo [!] OPENAI_API_KEY not set in this session.
    echo     Example:  set OPENAI_API_KEY=sk-xxxxxxxx
    echo     Or just run start.bat ^(masked input + auto launch^).
    set /p "OPENAI_API_KEY=Paste API Key now (shown once, env-only): "
)

:watchdog
echo [%date% %time%] [daemon] starting proxy-server.js ...
node proxy-server.js
echo [%date% %time%] [daemon] proxy exited with code %errorlevel%. Restarting in 3s... (Ctrl+C to stop)
timeout /t 3 /nobreak >nul
goto watchdog

endlocal
