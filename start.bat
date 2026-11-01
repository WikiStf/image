@echo off
rem =====================================================================
rem start.bat - one-click launcher (Windows 10 / PowerShell-free, pure cmd)
rem ---------------------------------------------------------------------
rem Flow: read API Key (masked input) -> start proxy-server.js -> open app
rem NOTE: keep this file OUT of git if you choose the "fill-in-top" mode.
rem       ⚠ NEVER hardcode a real key in production; prefer env injection.
rem =====================================================================
setlocal EnableDelayedExpansion
title imageAI Launcher

rem ---------- [Mode B] pre-filled key: uncomment & edit the next line ----------
rem set "LLM_KEY=sk-xxxxxxxxxxxxxxxx"

rem ---------- [Mode A] masked interactive input (default) ----------
if not defined LLM_KEY (
    echo   ----------------------------------------------
    echo    imageAI Chat  -  secure launcher
    echo    Your API Key is stored ONLY in this console
    echo    process environment. It never touches files
    echo    or browser code.  (⚠ do NOT commit keys!)
    echo   ----------------------------------------------
    rem mask input with PowerShell Read-Host -AsSecureString, then decrypt to var
    for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "$s=Read-Host 'Paste API Key (input hidden)' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "LLM_KEY=%%K"
)
if "%LLM_KEY%"=="" (
    echo [X] No API Key entered. Exiting.
    pause & exit /b 1
)

rem ---------- config ----------
if not defined UPSTREAM set "UPSTREAM=https://api.deepseek.com"
set "PORT=3001"

rem ---------- start proxy (new minimized window, key passed via env only) ----------
pushd "%~dp0"
set "OPENAI_API_KEY=%LLM_KEY%"
start "imageAI Proxy (:3001)" /min cmd /c "node proxy-server.js & echo Proxy exited. Press any key & pause>nul"

rem ---------- wait for /health heartbeat (max ~10s) ----------
echo [*] Waiting for proxy health check...
set /a TRIES=0
:waitloop
powershell -NoProfile -Command "try{Invoke-RestMethod http://localhost:%PORT%/health -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}" 2>nul
if %errorlevel%==0 goto healthy
set /a TRIES+=1
if %TRIES% GEQ 10 (echo [X] Proxy failed to start. Check server.log for details. & popd & pause & exit /b 1)
timeout /t 1 /nobreak >nul
goto waitloop

:healthy
echo [+] Proxy is alive: GET /health OK  (upstream=%UPSTREAM%)
rem ---------- open the chat app ----------
start "" "%~dp0index.html"
echo [+] index.html opened in your default browser.
echo     Tip: for full features serve it instead:  python -m http.server 8000
echo     Close the minimized "imageAI Proxy" window to stop the server.
popd
endlocal
