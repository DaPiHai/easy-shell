#!/usr/bin/env bash
# 给 dev:web 用的浏览器自动化小工具 —— 截图、点击主机行之类。
# 跟 agent-browser 协作；本身不开新进程。

set -euo pipefail

SHOT_DIR=".workbuddy-ai/shots"
mkdir -p "$SHOT_DIR"

# 从 snapshot -i 输出里找第一个匹配 label 的元素的 @eN。
# 主机行：引号文本含 IPv4 且整行 < 80 字符（容器文本会被拼成长串）。
extract_ref() {
  python3 -c '
import re, sys
needle = sys.argv[1].lower()
for line in sys.stdin:
    stripped = line.lstrip()
    if not stripped.startswith(("- generic", "- button")):
        continue
    m_text = re.search("\"([^\"]+)\"", line)
    m_ref = re.search("\\[ref=e(\\d+)\\]", line)
    if not (m_text and m_ref):
        continue
    text = m_text.group(1)
    is_host = bool(re.search(r"\d+\.\d+\.\d+\.\d+", text)) and len(line) < 80
    is_button = stripped.startswith("- button")
    if not (is_host or is_button):
        continue
    if needle in text.lower():
        print("@e" + m_ref.group(1))
        sys.exit(0)
sys.exit(1)
' "$1"
}

ensure_open() {
  local url="${1:-http://localhost:1420/}"
  agent-browser open "$url" >/dev/null 2>&1 || true
}

cmd="${1:-}"
shift || true

case "$cmd" in
  shot)
    name="${1:-page.png}"
    ensure_open
    agent-browser screenshot "" "$SHOT_DIR/$name" 2>&1 | tail -2
    ;;
  click)
    label="${1:-}"; name="${2:-after-click.png}"
    if [ -z "$label" ]; then echo "usage: click LABEL NAME" >&2; exit 1; fi
    ensure_open
    sleep 1
    refs=$(agent-browser snapshot -i 2>&1)
    ref=$(echo "$refs" | extract_ref "$label" || true)
    echo "ref=$ref"
    if [ -n "${ref:-}" ]; then
      agent-browser click "$ref" 2>&1 | tail -2
    else
      echo "no ref found for label: $label" >&2
    fi
    sleep 3
    agent-browser screenshot "" "$SHOT_DIR/$name" 2>&1 | tail -2
    ;;
  dump)
    # 把 snapshot 整段存到文件，方便手工看
    ensure_open
    sleep 1
    agent-browser snapshot -i > "$SHOT_DIR/snapshot.txt" 2>&1
    echo "saved $SHOT_DIR/snapshot.txt"
    ;;
  close)
    agent-browser close 2>&1 | tail -2
    ;;
  *)
    echo "用法: $0 {shot NAME|click LABEL NAME|close} [shot-dir]"
    exit 1
    ;;
esac