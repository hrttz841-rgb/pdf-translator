#!/bin/bash
set -u

cd "$(dirname "$0")" || exit 1
PID_FILE=".pdf_translator.pid"
PORT_FILE=".pdf_translator.port"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  PORT=$(cat "$PORT_FILE" 2>/dev/null || echo "8765")
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for i in {1..20}; do
      if ! kill -0 "$PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; fi
    echo "PDF 翻译工具已停止（端口 $PORT）。"
  else
    echo "记录的进程已经结束。"
  fi
  rm -f "$PID_FILE" "$PORT_FILE"
  sleep 1
  exit 0
fi

# No PID file: this can happen when an older copy of the tool started the server.
# Offer a safe best-effort stop only for a Python process actually listening on 8765.
LISTENER=$(lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
if [ -n "$LISTENER" ]; then
  CMD=$(ps -p "$LISTENER" -o command= 2>/dev/null || true)
  if echo "$CMD" | grep -q 'server.py'; then
    kill "$LISTENER" 2>/dev/null || true
    echo "已停止旧版本留下的 PDF 翻译服务（PID $LISTENER）。"
    sleep 1
    exit 0
  fi
fi

echo "没有发现由这个工具启动的后台服务。"
sleep 1