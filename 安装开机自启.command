#!/bin/bash
# 区块侦探：设置为登录 Mac 后自动在后台运行（跟单机器人、后台提醒、每天备份才会一直工作）。
# 双击运行一次即可；取消请双击“取消开机自启.command”。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "没有找到 python3，请先安装 Python 3：https://www.python.org/downloads/"; read -n1 -r -p "按任意键关闭…"; exit 1; fi
LABEL="com.blockdetective.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/BlockDetective"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$LOG/server.log</string>
  <key>StandardErrorPath</key><string>$LOG/server.log</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 20); do curl -s -m 2 -o /dev/null http://127.0.0.1:8765/api/chains && break; sleep 1; done
open "http://127.0.0.1:8765"
echo "已设置开机自启，服务在后台运行。日志：$LOG/server.log"
