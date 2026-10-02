#!/bin/bash
set -u

cd "$(dirname "$0")" || exit 1

BASE_PORT=8765
EXPECTED_VERSION="2.12.0"
PID_FILE=".pdf_translator.pid"
PORT_FILE=".pdf_translator.port"
LOG_FILE="pdf-translator.log"

health_json() {
  curl -fsS --max-time 1 "http://127.0.0.1:${1}/api/health" 2>/dev/null || true
}

is_our_server() {
  local health
  health=$(health_json "$1")
  echo "$health" | grep -q '"app"[[:space:]]*:[[:space:]]*"scholar-pdf-translator"'
}

server_version() {
  health_json "$1" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

stop_translator_on_port() {
  local port="$1"
  local pid
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
  if [ -z "$pid" ]; then return 0; fi
  local cmd
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  if echo "$cmd" | grep -q 'server.py'; then
    kill "$pid" 2>/dev/null || true
    for i in {1..30}; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    return 0
  fi
  return 1
}

# If a translator is already running, only reuse it when its version matches
# the files in this folder. Otherwise stop the stale Python server and restart.
if is_our_server "$BASE_PORT"; then
  RUNNING_VERSION=$(server_version "$BASE_PORT")
  if [ "$RUNNING_VERSION" = "$EXPECTED_VERSION" ]; then
    URL="http://127.0.0.1:${BASE_PORT}"
    echo "PDF 翻译工具 v${EXPECTED_VERSION} 已经在运行，正在打开浏览器。"
    open "$URL"
    exit 0
  fi
  echo "检测到旧版后台服务（${RUNNING_VERSION:-未知版本}），正在自动升级到 v${EXPECTED_VERSION}..."
  if ! stop_translator_on_port "$BASE_PORT"; then
    echo "无法安全停止旧服务，将为新版选择其他端口。"
  else
    rm -f "$PID_FILE" "$PORT_FILE"
    sleep 0.5
  fi
fi

# If the PID recorded by this folder is alive on another port, verify version.
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  OLD_PORT=$(cat "$PORT_FILE" 2>/dev/null || echo "$BASE_PORT")
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null && is_our_server "$OLD_PORT"; then
    RUNNING_VERSION=$(server_version "$OLD_PORT")
    if [ "$RUNNING_VERSION" = "$EXPECTED_VERSION" ]; then
      URL="http://127.0.0.1:${OLD_PORT}"
      echo "PDF 翻译工具 v${EXPECTED_VERSION} 已经在运行，正在打开浏览器。"
      open "$URL"
      exit 0
    fi
    stop_translator_on_port "$OLD_PORT" || true
  fi
  rm -f "$PID_FILE" "$PORT_FILE"
fi

# Choose the first free port if 8765 is occupied by some unrelated program.
PORT=$BASE_PORT
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  for candidate in $(seq 8766 8795); do
    if ! lsof -nP -iTCP:${candidate} -sTCP:LISTEN >/dev/null 2>&1; then
      PORT=$candidate
      break
    fi
  done
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "8765-8795 范围内没有可用端口。"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

PYTHON=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON=$(command -v python3)
elif command -v python >/dev/null 2>&1; then
  PYTHON=$(command -v python)
else
  echo "没有找到 Python。请先安装 Python 3。"
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

# Word 导出依赖：只在缺失时安装一次。
if ! "$PYTHON" -c "import docx" >/dev/null 2>&1; then
  echo "正在安装 Word 导出组件 python-docx（仅首次需要）..."
  if ! "$PYTHON" -m pip install --user "python-docx>=1.1,<2" >> "$LOG_FILE" 2>&1; then
    # Homebrew Python 可能启用 PEP 668；仅在 --user 失败时使用该兼容参数。
    "$PYTHON" -m pip install --user --break-system-packages "python-docx>=1.1,<2" >> "$LOG_FILE" 2>&1 || {
      echo "python-docx 安装失败。请查看 $LOG_FILE。"
      read -r -p "按回车键关闭窗口..."
      exit 1
    }
  fi
fi

URL="http://127.0.0.1:${PORT}"
: > "$LOG_FILE"
PDF_TRANSLATOR_PORT="$PORT" nohup "$PYTHON" server.py >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
echo "$PORT" > "$PORT_FILE"

for i in {1..50}; do
  if is_our_server "$PORT"; then
    ACTUAL_VERSION=$(server_version "$PORT")
    if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
      echo "启动到了错误版本：${ACTUAL_VERSION:-未知}，预期 ${EXPECTED_VERSION}。"
      stop_translator_on_port "$PORT" || true
      break
    fi
    echo "PDF 翻译工具 v${ACTUAL_VERSION} 已启动。"
    echo "地址：$URL"
    echo "AI HTTPS：使用 macOS 系统 curl 证书链。"
    echo "后台进程：$SERVER_PID"
    echo "日志：$LOG_FILE"
    open "$URL"
    sleep 1
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.2
done

echo "启动失败。日志如下："
echo "----------------------------------------"
tail -n 60 "$LOG_FILE" 2>/dev/null || true
rm -f "$PID_FILE" "$PORT_FILE"
read -r -p "按回车键关闭窗口..."
exit 1