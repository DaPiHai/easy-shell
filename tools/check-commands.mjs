#!/usr/bin/env node
/**
 * 命令面校验：后端注册、前端包装、预览 mock 三方对齐。
 *
 * 为什么需要这个：这个项目已经两次踩到「死命令」——
 *   1. 后端注册了 `known_hosts_forget`，前端一次没调，连重装过的服务器直接是死路；
 *   2. 前端调了没注册的命令，运行到那一步才报「命令不存在」。
 * 光靠人眼对三份清单是靠不住的，而这类问题的共同点是**不会在编译期报错**。
 *
 * 三份清单各自的权威来源：
 *   - 后端：src-tauri/src/lib.rs 的 `invoke_handler(tauri::generate_handler![...])`
 *   - 前端：src/lib/api.ts 里每个 `invoke<...>('name', ...)`（所有 Tauri 调用只此一个出口）
 *   - 预览：src/lib/tauriMock.ts 的 `case 'name':`
 *
 * 用法：`npm run check:commands`（`tools/package.sh` 也会先跑一遍）
 *
 * 已知取舍：注释剥离用的是正则而不是真解析器，遇到 `//` 出现在字符串里
 * （比如 URL 的 `https://`）会轻微误判。这里只拿它判断「有没有人调用」，
 * 误判方向是「以为被调用过」—— 也就是漏报，不会把好代码拦下来。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 刻意保留、暂时没有调用点的命令。
 *
 * 每一项都必须写清理由 —— 这个白名单是「已知的例外」，不是「暂时眼不见为净」。
 * 现在它是空的：曾经的 `sshClose` 已经用上了（锁定密钥库时统一收连接），
 * 留着白名单会掩盖它又变回死命令。
 */
const ALLOW_UNUSED = new Map([])

const read = (p) => readFileSync(join(root, p), 'utf8')

/** 去掉注释，避免把文档里提到的调用当成真调用（TerminalView 里就有一句「千万别 sshClose(…)」） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name)
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel.replaceAll('\\', '/'))
  }
  return out
}

// ---- 1. 后端：lib.rs 的 generate_handler! 清单 --------------------------------

const libRs = read('src-tauri/src/lib.rs')
const handlerBlock = libRs.match(/generate_handler!\s*\[([\s\S]*?)\]/)
if (!handlerBlock) {
  console.error('✗ 在 src-tauri/src/lib.rs 里找不到 generate_handler![...]')
  process.exit(1)
}
const rustCommands = new Set(
  stripComments(handlerBlock[1])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('::').pop()),
)

// ---- 2. 前端：api.ts 的 invoke 字符串 + 包装函数名 -----------------------------

const apiSrc = read('src/lib/api.ts')
const frontendCommands = new Map() // 命令名 -> 包装函数名
const unresolvedInvokes = []

for (const chunk of apiSrc.split(/export (?:async )?function /).slice(1)) {
  const fnName = chunk.match(/^(\w+)/)?.[1]
  for (const m of chunk.matchAll(/\binvoke(?:<[^>]*>)?\(\s*([^,)]+)/g)) {
    const arg = m[1].trim()
    const literal = arg.match(/^'([^']+)'$/) ?? arg.match(/^"([^"]+)"$/)
    if (literal) frontendCommands.set(literal[1], fnName ?? '(顶层)')
    else unresolvedInvokes.push({ fnName, arg })
  }
}

// ---- 3. 预览：tauriMock.ts 的 case 清单 --------------------------------------

const mockSrc = read('src/lib/tauriMock.ts')
const mockCommands = new Set([...mockSrc.matchAll(/case\s+'([a-z0-9_]+)'\s*:/g)].map((m) => m[1]))

// ---- 4. 包装函数的调用点（api.ts 之外，以及 api.ts 内部互相调用） ---------------

const otherSources = walk('src').filter((p) => p !== 'src/lib/tauriMock.ts')
const sources = otherSources.map((p) => ({ path: p, text: stripComments(read(p)) }))

/**
 * api.ts 也要算进调用点：`reconnectSession` 内部就调了 `sshReconnect`，
 * 只扫其他文件会把它误判成死命令。
 *
 * 但得先把 `export function xxx(` 这样的**定义**改名，否则每个包装函数
 * 都会匹配到自己的签名行，这个检查就永远通过 —— 白做。
 * 改名前缀以下划线开头，`\bname\s*\(` 里的词边界就不会命中它。
 */
const apiForCallers = stripComments(apiSrc).replace(
  /export (?:async )?function (\w+)/g,
  'function __def__$1',
)
sources.push({ path: 'src/lib/api.ts', text: apiForCallers })

function callersOf(fnName) {
  const re = new RegExp(`\\b${fnName}\\s*\\(`)
  return sources.filter((s) => re.test(s.text)).map((s) => s.path)
}

// ---- 5. 比对 -----------------------------------------------------------------

const errors = []
const notes = []

for (const cmd of rustCommands) {
  if (!frontendCommands.has(cmd)) {
    errors.push(`后端注册了但 api.ts 没有包装：${cmd}（前端永远调不到它）`)
  }
}

for (const [cmd, fnName] of frontendCommands) {
  if (!rustCommands.has(cmd)) {
    errors.push(`前端调用了未注册的命令：${cmd}（${fnName}）—— 会在运行时才报错`)
  }
}

for (const cmd of rustCommands) {
  if (!mockCommands.has(cmd)) {
    errors.push(
      `tauriMock 没有 case：${cmd} —— \`npm run dev:web\` 预览时会走 console.warn 兜底，` +
        '界面拿着 undefined 继续跑，看起来像成功',
    )
  }
}

for (const [, fnName] of frontendCommands) {
  if (!fnName || fnName === '(顶层)') continue
  if (callersOf(fnName).length === 0 && !ALLOW_UNUSED.has(fnName)) {
    errors.push(
      `包装函数没有任何调用点：${fnName} —— ` +
        '要么接上调用、要么删掉（连同后端注册一起），要么加进本脚本的 ALLOW_UNUSED 并写明理由',
    )
  }
}

for (const { fnName, arg } of unresolvedInvokes) {
  errors.push(`invoke 的第一个参数不是字符串字面量，静态校验不到：${fnName}(${arg}…)`)
}

for (const [fnName, reason] of ALLOW_UNUSED) {
  if (![...frontendCommands.values()].includes(fnName)) {
    errors.push(`ALLOW_UNUSED 里的 ${fnName} 已经不存在了，把它从白名单删掉`)
  } else {
    notes.push(`白名单：${fnName} —— ${reason}`)
  }
}

// ---- 6. 输出 -----------------------------------------------------------------

console.log(
  `命令面：后端 ${rustCommands.size} 个，api.ts 包装 ${frontendCommands.size} 个，` +
    `mock case ${mockCommands.size} 个`,
)

if (notes.length) {
  for (const n of notes) console.log(`  · ${n}`)
}

if (errors.length) {
  console.error('\n✗ 命令面校验没通过：')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('✓ 三方一致')
