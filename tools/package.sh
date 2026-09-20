#!/usr/bin/env bash
# 打 release 包：前端 vite build + Rust release + 生成 msi/nsis 安装包。
#
# 复用 build.sh 里那套 MSVC 环境（Git Bash 的 link.exe 会顶替 MSVC linker，
# 且 MSVC 需要 LIB 指向 SDK 的 um/ucrt）。这里把环境变量直接导出来，
# 好让 npm 起的 tauri CLI 子进程也能继承。
#
# 用法：./tools/package.sh
# 产物：src-tauri/target/release/bundle/msi/ 与 /nsis/

set -euo pipefail

MSVC_BIN="/c/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64"
MSVC_LIB="C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64"
SDK_LIB="C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0"
SDK_UM="$SDK_LIB\\um\\x64"
SDK_UCRT="$SDK_LIB\\ucrt\\x64"

if [ ! -d "$MSVC_BIN" ]; then
  echo "找不到 MSVC 目录：$MSVC_BIN" >&2
  exit 1
fi

export PATH="$MSVC_BIN:$PATH"
export LIB="$MSVC_LIB;$SDK_UM;$SDK_UCRT"

cd "$(dirname "$0")/.."

# 先过命令面校验：后端注册、api.ts 包装、预览 mock 三方对齐。
# 打包是交付前的最后一道门，死命令（注册了没人调 / 调了没注册）不该跟着安装包出去
npm run check:commands

# vite 配了 emptyOutDir:false，所以这里手动把旧产物挪走，避免历史文件混进安装包。
# 备份固定叫 dist.bak 且只留上一版 —— 早先按时间戳命名，打几次包就堆一地目录。
#
# 这一小段踩过两个坑，改之前先读完：
# 1. 整目录 `rm -rf dist.bak` 会被环境的批量删除保护**静默拦下**（`|| true` 吞掉），
#    于是 dist.bak 还在；
# 2. 而 `mv dist dist.bak` 在目标已存在时是把 dist **挪进** dist.bak 里面 ——
#    dist 原地不动。紧接着 vite 的 clean-old-assets 插件去逐个删 dist/assets，
#    又撞上同一道保护，构建以一个看不出因果的异常收场（`npm run build` failed）。
# 所以：先把旧备份**改名让位**，再挪 dist，挪完还要验一眼。
if [ -d dist.bak ]; then
  mv dist.bak dist.bak.old 2>/dev/null || true
fi
if [ -d dist ]; then
  mv dist dist.bak || true
fi
if [ -d dist ]; then
  echo "错误：dist 没能挪走，vite 清理旧 assets 会被批量删除保护拦下。先手动处理 dist 再打包。" >&2
  exit 1
fi

npm run tauri build
