@echo off
rem 区块侦探：Windows 双击启动。已在运行时只打开浏览器；没有运行就在这个窗口里启动（关闭窗口即停止）。
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8765/api/chains | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  start "" http://127.0.0.1:8765
  echo 区块侦探已在运行，已打开浏览器。这个窗口可以关掉。
  timeout /t 3 >nul
  exit /b 0
)

set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY ( where python >nul 2>nul && set PY=python )
if not defined PY (
  echo 没有找到 Python 3。请先到 https://www.python.org/downloads/ 安装（安装时勾选 "Add python.exe to PATH"），再双击本文件。
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8765"
echo 正在启动区块侦探……关闭这个窗口即停止。
%PY% server.py
pause
