import type { ITheme } from '@xterm/xterm'

/**
 * 终端配色方案。
 *
 * 一套方案 = 深色版 + 浅色版两套色板，跟着应用的深/浅主题自动切 —— 终端窗口和
 * 应用画布同调才不会切了浅色主题、终端还黑着一块（默认那套本来就是这样）。
 *
 * 色板只有 19 个槽位，xterm 的 `cursorAccent` 和 `selectionBackground` 是派生的：
 * 前者永远等于背景色（方块光标下的字才读得清），后者缺省由前景色调 alpha。
 * 这样第三方方案的色值能直接照抄，不用为了补两个派生值去「翻译」一遍。
 *
 * 「应用默认」是唯一不在这张表里的：它的色板仍在 `styles/tokens.css` 的 `--term-*`
 * 里，由 `readAppPalette()` 运行时读（见该函数注释）。
 */

/** 色板的 19 个槽位 */
export interface TermPalette {
  background: string
  foreground: string
  cursor: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
  /** 选中背景。缺省 = 前景色 28% 透明；只有「应用默认」显式给值（跟改造前一致） */
  selection?: string
}

export interface TermScheme {
  id: string
  name: string
  /** 深浅两版的叫法不一样时给个副标，比如 Dracula 的浅色版叫 Alucard */
  darkLabel?: string
  lightLabel?: string
  dark: TermPalette
  light: TermPalette
  /** 用户自己加/改的（存在 localStorage，不在内置表里） */
  custom?: boolean
}

/** 深浅模式。与 store 的 Theme 同构，这里单定义一份避免 store ↔ 本模块循环 import */
export type TermSchemeMode = 'dark' | 'light'

/** 「跟随应用」——用应用自己的设计色板，也就是改造前唯一那套 */
export const APP_SCHEME_ID = 'app'

/** 编辑器里的字段顺序与中文标签，UI 遍历它生成输入框，别在组件里手写 19 行 */
export const PALETTE_FIELD_GROUPS: Array<{
  title: string
  fields: Array<{ key: keyof TermPalette; label: string }>
}> = [
  {
    title: '基础',
    fields: [
      { key: 'background', label: '背景' },
      { key: 'foreground', label: '前景' },
      { key: 'cursor', label: '光标' },
    ],
  },
  {
    title: '常规 8 色',
    fields: [
      { key: 'black', label: '黑' },
      { key: 'red', label: '红' },
      { key: 'green', label: '绿' },
      { key: 'yellow', label: '黄' },
      { key: 'blue', label: '蓝' },
      { key: 'magenta', label: '紫' },
      { key: 'cyan', label: '青' },
      { key: 'white', label: '白' },
    ],
  },
  {
    title: '亮色 8 色',
    fields: [
      { key: 'brightBlack', label: '亮黑' },
      { key: 'brightRed', label: '亮红' },
      { key: 'brightGreen', label: '亮绿' },
      { key: 'brightYellow', label: '亮黄' },
      { key: 'brightBlue', label: '亮蓝' },
      { key: 'brightMagenta', label: '亮紫' },
      { key: 'brightCyan', label: '亮青' },
      { key: 'brightWhite', label: '亮白' },
    ],
  },
]

/**
 * 内置的 8 套。
 *
 * 色值来源逐套标注在注释里：iTerm2-Color-Schemes 的 Windows Terminal 导出、
 * 各方案官方仓库/README，或应用默认那套的 CSS 变量。Nord 与 Monokai 官方没有浅色版，
 * 那两版是**按同色相在浅底上重调的**（注释里写了「非官方」），其余 6 套的浅色版都有出处。
 */
export const BUILTIN_SCHEMES: TermScheme[] = [
  {
    id: 'dracula',
    name: 'Dracula',
    lightLabel: 'Alucard',
    // 官方 ANSI 16 色（dracula/dracula-theme 各终端端口一致的那套）
    dark: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
    // Alucard（官方浅色版）。用它的命名色板（bg/fg/comment + 8 个色相）按 Dracula
    // 端口的映射规则铺成 16 色，亮色是同色相加深；#a49c8c 那个浅灰是手调的。
    light: {
      background: '#f5f5f5',
      foreground: '#1f1f1f',
      cursor: '#1f1f1f',
      black: '#1f1f1f',
      red: '#cb3a2a',
      green: '#14710a',
      yellow: '#846e15',
      blue: '#644ac9',
      magenta: '#a3144d',
      cyan: '#036a96',
      white: '#6c664b',
      brightBlack: '#a49c8c',
      brightRed: '#a32b1e',
      brightGreen: '#0d5206',
      brightYellow: '#66540f',
      brightBlue: '#4a35a0',
      brightMagenta: '#7d0f3a',
      brightCyan: '#024c6d',
      brightWhite: '#1f1f1f',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    lightLabel: 'Nord Light（非官方）',
    // iTerm2-Color-Schemes/windowsterminal/Nord.json
    dark: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#eceff4',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#596377',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
    // 非官方：Nord 只有深色版。浅色版是在 snow storm（#eceff4）底上把 8 个色相
    // 各压深一档得来的，否则 #a3be8c 这类浅色在浅底上根本看不见。
    light: {
      background: '#eceff4',
      foreground: '#2e3440',
      cursor: '#2e3440',
      black: '#3b4252',
      red: '#a2434d',
      green: '#6d8f52',
      yellow: '#b08a2e',
      blue: '#4a6b8a',
      magenta: '#8f5f88',
      cyan: '#4a8fa3',
      white: '#6d7b8d',
      brightBlack: '#8b97a8',
      brightRed: '#7f2f38',
      brightGreen: '#52713a',
      brightYellow: '#8a6914',
      brightBlue: '#365270',
      brightMagenta: '#73496d',
      brightCyan: '#367186',
      brightWhite: '#2e3440',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    lightLabel: 'Gruvbox Light',
    // iTerm2-Color-Schemes/windowsterminal/Gruvbox Dark.json
    dark: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
    // iTerm2-Color-Schemes/windowsterminal/Gruvbox Light.json
    light: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      cursor: '#3c3836',
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    lightLabel: 'Solarized Light',
    // altercation/solarized 官方 xresources；color10–14 就是 base 基调色，不是「更亮的红绿」
    dark: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
    // altercation/solarized 官方 xresources（浅色版）
    light: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      black: '#eee8d5',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#073642',
      brightBlack: '#fdf6e3',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#657b83',
      brightMagenta: '#6c71c4',
      brightCyan: '#586e75',
      brightWhite: '#002b36',
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    darkLabel: 'Mocha',
    lightLabel: 'Latte',
    // iTerm2-Color-Schemes/windowsterminal/Catppuccin Mocha.json
    dark: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f7aec2',
      brightGreen: '#c2ecbf',
      brightYellow: '#fcd682',
      brightBlue: '#aeccfc',
      brightMagenta: '#f398da',
      brightCyan: '#b1eae1',
      brightWhite: '#a6adc8',
    },
    // iTerm2-Color-Schemes/windowsterminal/Catppuccin Latte.json
    light: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      black: '#bcc0cc',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#5c5f77',
      brightBlack: '#acb0be',
      brightRed: '#e7103f',
      brightGreen: '#46b02f',
      brightYellow: '#e49931',
      brightBlue: '#3878f6',
      brightMagenta: '#ef95d7',
      brightCyan: '#19a1a8',
      brightWhite: '#6c6f85',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    lightLabel: 'Day',
    // 官方 README 的 terminal colors 只给 8 色，亮色槽位按同值镜像（该主题的终端端口就是这么干的）
    dark: {
      background: '#1a1b26',
      foreground: '#a9b1d6',
      cursor: '#c0caf5',
      black: '#414868',
      red: '#f7768e',
      green: '#73daca',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#c0caf5',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#73daca',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
    // 同上取自官方 README 的 Day 变体；black/white/brightBlack 三个槽 README 没给
    // 独立值，取该主题的墨色（#343b58）与浅灰（#a1a6c5）补上
    light: {
      background: '#e6e7ed',
      foreground: '#343b58',
      cursor: '#343b58',
      black: '#343b58',
      red: '#8c4351',
      green: '#33635c',
      yellow: '#8f5e15',
      blue: '#2959aa',
      magenta: '#5a3e8e',
      cyan: '#0f4b6e',
      white: '#6172b0',
      brightBlack: '#a1a6c5',
      brightRed: '#8c4351',
      brightGreen: '#33635c',
      brightYellow: '#8f5e15',
      brightBlue: '#2959aa',
      brightMagenta: '#5a3e8e',
      brightCyan: '#0f4b6e',
      brightWhite: '#343b58',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    lightLabel: 'One Light',
    // iTerm2-Color-Schemes/windowsterminal/Atom One Dark.json
    dark: {
      background: '#21252b',
      foreground: '#abb2bf',
      cursor: '#abb2bf',
      black: '#21252b',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#767676',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#abb2bf',
    },
    // iTerm2-Color-Schemes/windowsterminal/Atom One Light.json
    light: {
      background: '#f9f9f9',
      foreground: '#2a2c33',
      cursor: '#bbbbbb',
      black: '#000000',
      red: '#de3e35',
      green: '#3f953a',
      yellow: '#d2b67c',
      blue: '#2f5af3',
      magenta: '#950095',
      cyan: '#3f953a',
      white: '#bbbbbb',
      brightBlack: '#000000',
      brightRed: '#de3e35',
      brightGreen: '#3f953a',
      brightYellow: '#d2b67c',
      brightBlue: '#2f5af3',
      brightMagenta: '#a00095',
      brightCyan: '#3f953a',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    lightLabel: 'Monokai Light（非官方）',
    // 经典 Monokai（Sublime Text 默认配色）的 16 色，各终端端口一直是这套
    dark: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5',
    },
    // 非官方：Monokai 只有深色版。把 8 个色相按浅底压深一档得来，色相不动
    light: {
      background: '#f8f8f2',
      foreground: '#272822',
      cursor: '#272822',
      black: '#272822',
      red: '#c2185b',
      green: '#6b8e00',
      yellow: '#8a7000',
      blue: '#0b7c93',
      magenta: '#7b4fd1',
      cyan: '#1f8f84',
      white: '#75715e',
      brightBlack: '#9a927d',
      brightRed: '#a3144a',
      brightGreen: '#55700a',
      brightYellow: '#6e5900',
      brightBlue: '#086276',
      brightMagenta: '#5f3ba8',
      brightCyan: '#16706a',
      brightWhite: '#272822',
    },
  },
]

function readToken(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * 「应用默认」的色板：读 `styles/tokens.css` 的 `--term-*` 变量。
 *
 * 之所以不把它也写死进上面的表：应用自己的深/浅色板是设计系统的一部分
 * （DESIGN.md 里有对账表），终端默认色跟着它走才能一起改。运行时读计算值，
 * 也意味着切 `data-theme` 之后这里拿到的是新主题的值。
 *
 * 调用前请确保 `data-theme` 已经是当前主题（store 的 applyTheme 负责），否则会读到上一套。
 */
export function readAppPalette(): TermPalette {
  return {
    background: readToken('--term-bg', '#010102'),
    foreground: readToken('--term-fg', '#d0d6e0'),
    cursor: readToken('--term-cursor', '#5e6ad2'),
    black: readToken('--term-black', '#0f1011'),
    red: readToken('--term-red', '#e5484d'),
    green: readToken('--term-green', '#3dd68c'),
    yellow: readToken('--term-yellow', '#e2a03f'),
    blue: readToken('--term-blue', '#5e6ad2'),
    magenta: readToken('--term-magenta', '#a855f7'),
    cyan: readToken('--term-cyan', '#3ddbd9'),
    white: readToken('--term-white', '#d0d6e0'),
    brightBlack: readToken('--term-bright-black', '#62666d'),
    brightRed: readToken('--term-bright-red', '#ff6369'),
    brightGreen: readToken('--term-bright-green', '#56e39f'),
    brightYellow: readToken('--term-bright-yellow', '#ffb224'),
    brightBlue: readToken('--term-bright-blue', '#828fff'),
    brightMagenta: readToken('--term-bright-magenta', '#c084fc'),
    brightCyan: readToken('--term-bright-cyan', '#56e1e1'),
    brightWhite: readToken('--term-bright-white', '#f7f8f8'),
    // 改造前选中背景就是这个硬编码值，深浅两套共用，保持不变
    selection: 'rgba(94, 106, 210, 0.3)',
  }
}

/** 把 #rgb / #rrggbb / #rrggbbaa 转成 rgba()。解析不了就原样返回（宁可不好看也别报错） */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace('#', '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return color
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 色板 → xterm 的 ITheme，补齐两个派生字段 */
function toXtermTheme(p: TermPalette): ITheme {
  return {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    // 方块光标下的字符用底色，任何配色下都读得清
    cursorAccent: p.background,
    selectionBackground: p.selection ?? withAlpha(p.foreground, 0.28),
    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.white,
    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.brightGreen,
    brightYellow: p.brightYellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.brightMagenta,
    brightCyan: p.brightCyan,
    brightWhite: p.brightWhite,
  }
}

/** 颜色解析：`#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`。解析不了返回 null */
function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const text = color.trim().toLowerCase()
  if (text.startsWith('#')) {
    const hex = text.slice(1)
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) return null
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    }
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(text)
  if (!match) return null
  const parts = match[1].split(',').map((p) => Number(p.trim()))
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
  const alpha = parts[3]
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: alpha === undefined || !Number.isFinite(alpha) ? 1 : alpha,
  }
}

/**
 * 查找高亮用的两个实色（普通匹配 / 当前匹配）。
 *
 * xterm 的搜索装饰只认 `#RRGGBB`，喂 rgba 进去它当没给 —— 所以得把方案自己的
 * **选中色**按背景压平成实色。挑选中色是因为它就是这套配色里专为「文字底下铺一层」
 * 定的颜色：8 套方案、深浅两版、用户自定义，都不会糊掉。
 * 当前匹配必须明显比普通匹配重，不然按「下一个」时看不出跳到哪了。
 */
export function searchHighlightColors(p: TermPalette): { match: string; active: string } {
  const base = parseColor(p.selection ?? withAlpha(p.foreground, 0.28))
  const bg = parseColor(p.background)
  // 解析不了就退回应用强调色：宁可不好看，也不能让高亮整个消失
  if (!base || !bg) return { match: '#5e6ad2', active: '#828fff' }

  const flatten = (alpha: number) => {
    const a = Math.min(0.85, Math.max(0, alpha))
    const channel = (from: number, to: number) =>
      Math.round(from * (1 - a) + to * a)
        .toString(16)
        .padStart(2, '0')
    return `#${channel(bg.r, base.r)}${channel(bg.g, base.g)}${channel(bg.b, base.b)}`
  }

  return { match: flatten(base.a), active: flatten(Math.max(base.a * 2, base.a + 0.25)) }
}

/** 找一套方案：内置 / 自定义。'app' 不在表里，返回 null 由调用方走 CSS 变量 */
export function findScheme(id: string, customs: TermScheme[] = []): TermScheme | null {
  if (id === APP_SCHEME_ID) return null
  return BUILTIN_SCHEMES.find((s) => s.id === id) ?? customs.find((s) => s.id === id) ?? null
}

export function isKnownSchemeId(id: string, customs: TermScheme[] = []): boolean {
  return id === APP_SCHEME_ID || findScheme(id, customs) !== null
}

/** 取某套方案在某个模式下生效的色板 */
export function paletteFor(
  id: string,
  mode: TermSchemeMode,
  customs: TermScheme[] = [],
): TermPalette {
  const scheme = findScheme(id, customs)
  // 未知 id（手改坏的 localStorage、自定义方案被删）一律回退应用默认，
  // 不能让终端变成一片白
  return scheme ? scheme[mode] : readAppPalette()
}

/**
 * 解析成 xterm 的 theme。
 * 终端建好后换配色也调它 —— 对象每次都是新的，直接赋给 `term.options.theme` 即可。
 */
export function resolveTermTheme(
  id: string,
  mode: TermSchemeMode,
  customs: TermScheme[] = [],
): ITheme {
  return toXtermTheme(paletteFor(id, mode, customs))
}

/** 设置面板里一张卡片要的全部信息 */
export interface SchemeChoice {
  id: string
  name: string
  /** 当前模式下生效那一版叫什么，Dracula 在浅色下就是 Alucard */
  variant: string
  palette: TermPalette
  custom: boolean
}

/** 卡片列表：应用默认 + 8 套内置 + 用户自定义，顺序固定 */
export function listSchemeChoices(
  mode: TermSchemeMode,
  customs: TermScheme[] = [],
): SchemeChoice[] {
  const appChoice: SchemeChoice = {
    id: APP_SCHEME_ID,
    name: '应用默认',
    variant: '跟随应用主题',
    palette: readAppPalette(),
    custom: false,
  }
  const named = [...BUILTIN_SCHEMES, ...customs].map((s) => ({
    id: s.id,
    name: s.name,
    variant: (mode === 'light' ? s.lightLabel : s.darkLabel) ?? (mode === 'light' ? '浅色版' : '深色版'),
    palette: s[mode],
    custom: !!s.custom,
  }))
  return [appChoice, ...named]
}

/** 用户新建一套方案：从现有方案（或应用默认）复制两版做底，免得从 19 个空色块开始填 */
export function newCustomScheme(name: string, from: TermScheme | null): TermScheme {
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const base: TermScheme = from ?? {
    id,
    name,
    dark: readAppPalette(),
    light: { ...readAppPalette(), selection: undefined },
  }
  return {
    id,
    name,
    dark: { ...base.dark },
    light: { ...base.light },
    custom: true,
  }
}

/** 色板是否可用（读写 localStorage 的 JSON 时把坏数据挡在外面） */
export function isValidPalette(v: unknown): v is TermPalette {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  const required: Array<keyof TermPalette> = [
    'background',
    'foreground',
    'cursor',
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ]
  if (!required.every((k) => typeof p[k] === 'string' && (p[k] as string).trim() !== '')) return false
  return p.selection === undefined || typeof p.selection === 'string'
}

/** 自定义方案是否可用 */
export function isValidScheme(v: unknown): v is TermScheme {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.id !== 'string' || !s.id) return false
  if (typeof s.name !== 'string' || !s.name.trim()) return false
  return isValidPalette(s.dark) && isValidPalette(s.light)
}

// ---------------------------------------------------------------- 导入

/**
 * 颜色归一化：补上没写的 `#`、3 位扩成 6 位、8 位丢掉 alpha。
 *
 * 丢 alpha 是因为编辑器的取色控件（`<input type="color">`）只认 `#rrggbb`，
 * 而终端方案基本不会带透明色。认不出的（`rgb()` 之类）返回 null，由调用方按「缺色」报错。
 */
function normalizeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    return `#${t
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`
  }
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`
  if (/^[0-9a-fA-F]{8}$/.test(t)) return `#${t.slice(0, 6).toLowerCase()}`
  return null
}

function sRGBLuminance(color: string): number {
  const hex = color.replace('#', '')
  if (hex.length < 6) return 0
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export interface ImportedScheme {
  name?: string
  /** 给了哪一版就填哪一版；原生格式两版都给 */
  palettes: { dark?: TermPalette; light?: TermPalette }
}

/**
 * 从粘贴的 JSON 里读出一套配色。吃三种格式：
 *
 * 1. 本应用的原生格式（`{ name, dark, light }`，两版都给）
 * 2. Windows Terminal / iTerm 风格的方案（`background` + `black`…`brightWhite`）
 * 3. base16（`base00`–`base0F`，按 base16-shell 的官方 ANSI 映射）
 *
 * 后两种只有一份色板，按背景亮度判它是深色版还是浅色版。
 * 认不出来就抛错，消息是给用户看的，会直接显示在导入框下面。
 */
export function parseImportedPalette(text: string): ImportedScheme {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('先粘贴一段方案 JSON 再导入')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new Error('不是合法的 JSON —— 需要粘贴完整的方案内容')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('顶层应该是一个 JSON 对象')
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined

  // ① 原生格式：dark / light 两版都在
  const dark = obj.dark
  const light = obj.light
  if (isValidPalette(dark) || isValidPalette(light)) {
    const palettes: ImportedScheme['palettes'] = {}
    if (isValidPalette(dark)) palettes.dark = dark
    if (isValidPalette(light)) palettes.light = light
    return { name, palettes }
  }

  // ② base16
  if (typeof obj.base00 === 'string') {
    const base = (i: number): string | null => {
      const key = `base0${i.toString(16).toUpperCase()}`
      return normalizeColor(obj[key])
    }
    const missing = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter(
      (i) => !base(i),
    )
    if (missing.length) {
      throw new Error(`base16 少了这些色：${missing.map((i) => `base0${i.toString(16).toUpperCase()}`).join('、')}`)
    }
    // base16-shell 的映射：0=base00, 1=base08, 2=base0B, 3=base0A, 4=base0D, 5=base0E,
    // 6=base0C, 7=base05, 8=base03, 9=base09, 10=base01, 11=base02, 12=base04,
    // 13=base06, 14=base0F, 15=base07
    const p: TermPalette = {
      background: base(0)!,
      foreground: base(5)!,
      cursor: base(5)!,
      black: base(0)!,
      red: base(8)!,
      green: base(0xb)!,
      yellow: base(0xa)!,
      blue: base(0xd)!,
      magenta: base(0xe)!,
      cyan: base(0xc)!,
      white: base(5)!,
      brightBlack: base(3)!,
      brightRed: base(9)!,
      brightGreen: base(1)!,
      brightYellow: base(2)!,
      brightBlue: base(4)!,
      brightMagenta: base(6)!,
      brightCyan: base(0xf)!,
      brightWhite: base(7)!,
    }
    return { name: name ?? base16Name(obj), palettes: byLuminance(p) }
  }

  // ③ Windows Terminal / iTerm 风格
  const background = normalizeColor(obj.background)
  const foreground = normalizeColor(obj.foreground)
  const cursor = normalizeColor(obj.cursorColor ?? obj.cursor) ?? foreground
  if (!background || !foreground) {
    throw new Error(
      '认不出这套格式 —— 需要含 background/foreground/black…brightWhite 的终端方案、base00–base0F 的 base16，或本应用导出的 { dark, light }',
    )
  }
  const normal = {
    black: normalizeColor(obj.black),
    red: normalizeColor(obj.red),
    green: normalizeColor(obj.green),
    yellow: normalizeColor(obj.yellow),
    blue: normalizeColor(obj.blue),
    // Windows Terminal 叫 purple，iTerm 叫 magenta，都收
    magenta: normalizeColor(obj.purple ?? obj.magenta),
    cyan: normalizeColor(obj.cyan),
    white: normalizeColor(obj.white),
  }
  const missingNormal = Object.entries(normal)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missingNormal.length) {
    throw new Error(`这套方案缺了常规色：${missingNormal.join('、')}（可以通过 Windows Terminal 的「导出配色方案」拿到完整版）`)
  }
  // 亮色槽位没给就沿用对应的常规色 —— 手写的方案经常只写 8 色
  const bright = (key: string, fallbackKey: keyof typeof normal): string =>
    normalizeColor(obj[key]) ?? normal[fallbackKey]!
  const p: TermPalette = {
    background,
    foreground,
    cursor: cursor!,
    black: normal.black!,
    red: normal.red!,
    green: normal.green!,
    yellow: normal.yellow!,
    blue: normal.blue!,
    magenta: normal.magenta!,
    cyan: normal.cyan!,
    white: normal.white!,
    brightBlack: bright('brightBlack', 'black'),
    brightRed: bright('brightRed', 'red'),
    brightGreen: bright('brightGreen', 'green'),
    brightYellow: bright('brightYellow', 'yellow'),
    brightBlue: bright('brightBlue', 'blue'),
    brightMagenta: bright('brightPurple', 'magenta'),
    brightCyan: bright('brightCyan', 'cyan'),
    brightWhite: bright('brightWhite', 'white'),
  }
  const selection = normalizeColor(obj.selectionBackground)
  if (selection) p.selection = selection
  return { name, palettes: byLuminance(p) }
}

/** 单份色板按背景亮度归到深/浅那一版 */
function byLuminance(p: TermPalette): ImportedScheme['palettes'] {
  const mode: TermSchemeMode = sRGBLuminance(p.background) < 0.5 ? 'dark' : 'light'
  return { [mode]: p }
}

/** base16 方案名：`scheme` 字段（base16 规范里叫这个名字） */
function base16Name(obj: Record<string, unknown>): string | undefined {
  return typeof obj.scheme === 'string' && obj.scheme.trim() ? obj.scheme.trim() : undefined
}
