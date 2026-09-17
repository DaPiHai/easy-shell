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
# 备份固定叫 dist.bak 且只留上一版 —— 早先按时间戳命名，打几次包就堆一地目录
if [ -d dist.bak ]; then
  rm -rf dist.bak || true
fi
if [ -d dist ]; then
  mv dist dist.bak || true
fi

npm run tauri build
