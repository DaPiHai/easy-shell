import { listSystemFonts } from './api'

/**
 * 终端字体：本机装了哪些、哪些是等宽的。
 *
 * 清单来自 Rust（`list_system_fonts`，见 `src-tauri/src/fonts.rs`）——
 * 浏览器侧**拿不到**这份东西：`document.fonts.check()` 对根本不存在的字体名也返回 `true`
 * （Chromium 只查有没有待加载的 webfont，实测过），`queryLocalFonts()` 在 WebView2 里
 * 没有授权入口。
 *
 * 读不到系统清单时（非 Windows 又没装 fontconfig、或者哪天命令没了）退回下面这张候选表：
 * 用 canvas 量宽挑出真装了的。量宽是**准的** —— 字体不存在时量出来的就等于兜底字体的宽度，
 * 跟存在的字体一定不同。
 */

export interface FontChoice {
  /** 字体族名，如 `Cascadia Code` */
  family: string
  /** 是不是等宽。终端字体基本只用等宽，所以下拉框默认只看这些 */
  mono: boolean
}

/**
 * 兜底候选：常见终端字体（等宽）+ 几个中文等宽。
 * 只在读不到系统清单时用 —— 它不是"可用字体清单"，是"实在问不到系统时的几个猜测"。
 */
const FALLBACK_CANDIDATES = [
  'JetBrains Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Space Mono',
  'Hack',
  'Inconsolata',
  'Iosevka',
  'Victor Mono',
  'Anonymous Pro',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Noto Sans Mono',
  'Menlo',
  'Monaco',
  'SF Mono',
  'Consolas',
  'Courier New',
  'Lucida Console',
  'Sarasa Mono SC',
  'Sarasa Fixed SC',
  'LXGW WenKai Mono',
  'Noto Sans Mono CJK SC',
  'WenQuanYi Micro Hei Mono',
]

let ctx: CanvasRenderingContext2D | null | undefined
let cached: FontChoice[] | null = null
let inflight: Promise<FontChoice[]> | null = null

/** 量宽用的画布。拿不到 2d context（极老环境）就返回 null，调用方各自退让 */
function canvasCtx(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    ctx = document.createElement('canvas').getContext('2d')
  }
  return ctx
}

/** CSS 里的字体族名要带引号（名字里有空格或非 ASCII 时不加就整条 font 简写失效） */
function quoted(family: string): string {
  return JSON.stringify(family)
}

function widthOf(font: string, sample: string): number {
  const c = canvasCtx()
  if (!c) return 0
  c.font = font
  return c.measureText(sample).width
}

/**
 * 这个字体在本机装没装：**跟兜底字体量出来一样宽**就当没有。
 * 字体不存在时浏览器不会报错，只会默默用兜底字体渲染 —— 宽度一致就是它没生效的证据。
 */
export function isInstalled(family: string): boolean {
  const sample = 'mmmmmmmmmmlliWWWW0000'
  const withFamily = widthOf(`16px ${quoted(family)}, monospace`, sample)
  const fallback = widthOf('16px monospace', sample)
  return withFamily > 0 && Math.abs(withFamily - fallback) > 0.01
}

/**
 * 是不是等宽：等宽字体里这几个字符的步进宽度必须完全一致。
 *
 * 注意它答不了"装没装"：名字解析不出来时量到的是兜底 `monospace` 的宽度，
 * 四组一样宽，于是**一个不存在的名字也会被算成等宽**。清单本来就来自系统（存在的字体），
 * 只有兜底候选表那条路要先 `filter(isInstalled)` 再问它 —— 顺序别倒过来。
 */
export function isMonospace(family: string): boolean {
  const font = `16px ${quoted(family)}, monospace`
  const widths = ['iiiiiiiiii', 'WWWWWWWWWW', '0000000000', '::::::::::'].map((s) => widthOf(font, s))
  return widths.every((w) => w > 0 && Math.abs(w - widths[0]) < 0.01)
}

/** 本机已装的字体（带等宽标记）。同一个进程里只真读一次 */
export function listFonts(): Promise<FontChoice[]> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = load().then((fonts) => {
      cached = fonts
      inflight = null
      return fonts
    })
  }
  return inflight
}

/** 「重新扫描」：用户刚装完字体就不用重启应用了 */
export function forgetFonts() {
  cached = null
  inflight = null
}

async function load(): Promise<FontChoice[]> {
  const fromSystem = await listSystemFonts()
  const families = fromSystem.length ? fromSystem : FALLBACK_CANDIDATES.filter(isInstalled)
  return families.map((family) => ({ family, mono: isMonospace(family) }))
}

/** 提交给 `termFontFamily` 的值：一个带引号的字体族，就是终端要用的那一个 */
export function fontStackValue(family: string): string {
  return quoted(family)
}

/**
 * 设置里存的值可能是一整串字体栈（手写的，像 `"Fira Code", Consolas, monospace`），
 * 这里取它的**第一个**族名当显示名。空串 = 用内置栈。
 */
export function firstFamily(stack: string): string {
  const s = stack.trim()
  if (!s) return ''
  const head = s.match(/^"((?:[^"\\]|\\.)*)"/) ?? s.match(/^'((?:[^'\\]|\\.)*)'/)
  if (head) return head[1]
  return s.split(',')[0].trim()
}
