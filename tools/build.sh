#!/usr/bin/env bash
# 在 Git Bash 里编译 easy-shell 的 Rust 侧。
#
# 为什么需要这个文件：
#   1. Git Bash 的 /usr/bin/link.exe（GNU coreutils）会顶替 MSVC 的 link.exe，
#      导致 rustc 链接时报 "link: extra operand"。必须把 MSVC bin 前置到 PATH。
#   2. MSVC linker 需要 LIB 指向 SDK 的 um/ucrt 目录，否则报 LNK1181 找不到 kernel32.lib。
#
# 用法：
#   ./tools/build.sh            # 等同于 cargo build
#   ./tools/build.sh check      # cargo check
#   ./tools/build.sh release    # cargo build --release

set -euo pipefail

MSVC_BIN="/c/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64"
MSVC_LIB="C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64"
SDK_LIB="C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0"
SDK_UM="$SDK_LIB\\um\\x64"
SDK_UCRT="$SDK_LIB\\ucrt\\x64"

if [ ! -d "$MSVC_BIN" ]; then
  echo "找不到 MSVC 目录：$MSVC_BIN" >&2
  echo "如果 VS 版本不同，请修改本脚本里的路径。" >&2
  exit 1
fi

export PATH="$MSVC_BIN:$PATH"
export LIB="$MSVC_LIB;$SDK_UM;$SDK_UCRT"

cd "$(dirname "$0")/../src-tauri"

case "${1:-build}" in
  check)
    cargo check
    ;;
  release)
    cargo build --release
    ;;
  build)
    cargo build
    ;;
  *)
    cargo "$@"
    ;;
esac
