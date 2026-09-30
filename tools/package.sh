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

# 分屏排布也过一遍穷举校验：拖拽切出来的格子表是纯整数运算，畸形排布（洞、重叠、
# 新格跑到隔壁）在界面上只表现为"有点怪"，指望点几下看出来不现实。几秒的事，别省
npm run check:layout

# 构建前 dist 必须**不存在**：vite 配了 `emptyOutDir: false`（它整目录 rm 会被环境的
# 批量删除保护拦下），而 vite.config.ts 里那个 clean-old-assets 插件是逐个删
# dist/assets —— 同样会撞上保护，然后以一个看不出因果的 `npm run build failed` 收场。
#
# 所以这里用"挪走"代替"删除"，并且**挪到系统临时目录**：早先挪进项目里的 dist.bak，
# 踩了两个坑 ——
#   1. `rm -rf dist.bak` 被静默拦下（不报错、也没删）；
#   2. 于是下一轮 `mv dist dist.bak` 成了"把 dist 挪进 dist.bak 里面"，dist 原地不动，
#      而再往后为了腾位置做的改名让位又会一层层嵌套（dist.bak.old/dist.bak/dist…）。
# 单向往外挪就都没有了：目标永远是新路径，失败也直接看得见。
if [ -d dist ]; then
  mv dist "${TMPDIR:-/tmp}/easy-shell-dist-$(date +%s)" || {
    echo "错误：dist 挪不走（多半被占用）—— 关掉 dev server / 预览窗口再打包。" >&2
    exit 1
  }
fi

npm run tauri build
