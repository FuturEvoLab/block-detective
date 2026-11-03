#!/bin/bash
# 双击即可打开区块侦探（macOS）。
# 已设置开机自启时服务一直在后台运行，这里只打开浏览器；没有在运行时才在这个窗口里启动（关闭窗口即停止）。
cd "$(dirname "$0")"
if curl -s -m 2 http://127.0.0.1:8765/api/chains >/dev/null; then
  open "http://127.0.0.1:8765"
  echo "区块侦探已在后台运行，已打开浏览器。这个窗口可以关掉。"
  exit 0
fi
(sleep 1.5; open "http://127.0.0.1:8765") &
python3 server.py
