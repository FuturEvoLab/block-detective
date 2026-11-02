#!/bin/bash
# 双击取消区块侦探的开机自启，并停止后台服务。之后可以用“启动区块侦探.command”手动启动。
PLIST="$HOME/Library/LaunchAgents/com.blockdetective.server.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
rm -f "$PLIST"
echo "已取消开机自启，后台服务已停止。"
