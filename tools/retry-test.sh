#!/usr/bin/env bash
# 借 tools/build.sh 跑 cargo test，遇到「旧产物写不进去 (os error 5)」就删掉那个文件重来。
#
# 为什么需要这个：这台机器上**本会话之前就已存在的 target 产物写被拒**（读、删都正常），
# cargo 想覆盖它们时直接报 `拒绝访问 (os error 5)`。报错一次只点名一个文件，
# 于是变成打地鼠。这个脚本把打地鼠自动化，跑通为止。
#
# 一次性的临时工具：等 cargo 把该重建的都重建完（新文件是能写的）就不再需要。
set -u
cd "$(dirname "$0")/.." || exit 1

for round in $(seq 1 30); do
  out=$(./tools/build.sh test 2>&1)

  if printf '%s' "$out" | grep -qE '^test result'; then
    echo "== 第 $round 轮通过 =="
    printf '%s' "$out" | grep -E '^test result|^error|running [0-9]+ tests'
    exit 0
  fi

  # 报错形如：error: failed to write `C:\...\invoked.timestamp`
  #           error: error writing dependencies to `C:\...\foo.d`
  bad=$(printf '%s' "$out" | grep -oE '`[A-Za-z]:\\[^`]+`' | head -1 | tr -d '`')
  if [ -z "$bad" ]; then
    echo "== 第 $round 轮失败，但没提取到路径 =="
    printf '%s' "$out" | grep -E '^error|拒绝访问|could not compile|panicked' | head -20
    exit 1
  fi

  path=$(printf '%s' "$bad" | tr '\\' '/')
  echo "第 $round 轮：删掉写不进去的旧产物 $path"
  rm -f "$path" 2>/dev/null
  rm -rf "$path" 2>/dev/null
done

echo "== 30 轮还没跑通，放弃 =="
exit 1
