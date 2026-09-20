import { Channel } from '@tauri-apps/api/core'
import { create } from 'zustand'
import {
  type EditorTarget,
  type TransferEvent,
} from './api'
import {
  groupsDelete,
  groupsList,
  groupsSave,
  hostsDelete,
  hostsList,
  hostsSave,
  isDesktop,
  pickFile,
  sshClose,
  syncWindowTheme,
  vaultChangePassword,
  vaultLock,
  vaultRecoveryClear,
  vaultRecoverySet,
  vaultReset,
  vaultSetup,
  vaultStatus,
  vaultUnlock,
  vaultUnlockWithKey,
  type GroupRecord,
  type HostRecord,
} from './api'
import { APP_SCHEME_ID, isKnownSchemeId, isValidScheme, type TermScheme } from './termSchemes'

/** 终端字号可调范围。再小就看不清，再大一个屏幕放不下几行 */
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 28
/**
 * 终端默认字号。1080p 上 13px 刚好，高分屏偏小 —— 所以是可调的。
 * Ctrl+0、状态栏那个「13px」、命令面板的复位项、设置面板的复位都认它，
 * 别再各写一遍：改默认值的时候漏掉一处，用户就会发现"复位到的地方不一样"。
 */
export const DEFAULT_FONT_SIZE = 13

/** 终端默认字体栈。用户在设置里填了自定义字体就用他填的 */
export const DEFAULT_TERM_FONT =
  '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace'
export const MIN_LINE_HEIGHT = 1
export const MAX_LINE_HEIGHT = 2
export const MIN_SCROLLBACK = 500
export const MAX_SCROLLBACK = 100000
export const MIN_RETRY_ATTEMPTS = 0
export const MAX_RETRY_ATTEMPTS = 10
export const MIN_RETRY_DELAY = 1
export const MAX_RETRY_DELAY = 60

export type CursorStyle = 'bar' | 'block' | 'underline'

/** 从一个可能写坏的 localStorage 值里读数字，夹到范围内，读不到就给默认 */
function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    // 必须判 null：Number(null) 是 0，而 0 落在合法区间里（重连次数下限就是 0），
    // 不判的话"没存过"会被当成"用户设成 0"
    if (raw === null) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) return fallback
    return n
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式可能写不动，忽略 */
  }
}

/**
 * 分屏比例（列 / 行各一份）。夹在 0.2–0.8：再极端两边就看不清了。
 * 上下限写在读写两处共用的一份里，免得改了一边忘了另一边。
 */
const MIN_SPLIT_RATIO = 0.2
const MAX_SPLIT_RATIO = 0.8

function readRatio(key: string): number {
  try {
    const v = localStorage.getItem(key)
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) && n >= MIN_SPLIT_RATIO && n <= MAX_SPLIT_RATIO ? n : 0.5
  } catch {
    return 0.5
  }
}

/**
 * 每个带分多宽？没拖过（或存的数据不对）就等分。
 *
 * 存的数据是用户可能手改的 localStorage JSON，逐条校验：长度对得上带数、
 * 每带 > 1%、总和 ≈ 1 —— 半套数据画出来的分屏比没有更糟。
 */
export function bandWidths(record: Record<number, number[]>, bands: number): number[] {
  const stored = record[bands]
  const usable =
    Array.isArray(stored) &&
    stored.length === bands &&
    stored.every((w) => Number.isFinite(w) && w > 0.01) &&
    Math.abs(stored.reduce((a, b) => a + b, 0) - 1) < 0.02
  if (usable) return stored as number[]
  return Array.from({ length: bands }, () => 1 / bands)
}

/** 从 localStorage 读带宽度记录。key 是带数，只认 2–4，其余丢掉 */
function readBands(key: string): Record<number, number[]> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<number, number[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const bands = Number(k)
      const widths = v as unknown
      if (
        !Number.isInteger(bands) ||
        bands < 2 ||
        bands > 4 ||
        !Array.isArray(widths) ||
        widths.length !== bands ||
        !widths.every((w) => Number.isFinite(w) && w > 0.01) ||
        Math.abs(widths.reduce((a, b) => a + b, 0) - 1) >= 0.02
      ) {
        continue
      }
      out[bands] = widths
    }
    return out
  } catch {
    return {}
  }
}

function writeBands(key: string, record: Record<number, number[]>) {
  writeLocal(key, JSON.stringify(record))
}

/** 用户自定义配色方案的 key */
const CUSTOM_SCHEMES_KEY = 'termCustomSchemes'

/**
 * 「配一把恢复公钥吧」这个提示被永久关掉了没。
 *
 * 走 localStorage 而不是库里的 meta：这是「我不想再看见这个提示」的表达，
 * 属于用户偏好（同主题、字号）。用户偏好不属于密钥库，也不该跟着库一起被加密。
 */
const RECOVERY_PROMPT_MUTED = 'recoveryPromptMuted'
const isRecoveryPromptMuted = () => {
  try {
    return localStorage.getItem(RECOVERY_PROMPT_MUTED) === '1'
  } catch {
    return false
  }
}

/**
 * 读自定义配色。**逐套校验**：这份 JSON 是用户可能手改的、跨版本升级的，
 * 半套色板渲染出来比没有更糟（终端会变成一片白），坏数据直接丢掉。
 */
function readCustomSchemes(): TermScheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SCHEMES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidScheme).map((s) => ({ ...s, custom: true }))
  } catch {
    return []
  }
}

function writeCustomSchemes(list: TermScheme[]) {
  writeLocal(CUSTOM_SCHEMES_KEY, JSON.stringify(list))
}

/** 初始值要同时喂给 customSchemes 和 termScheme 的校验，读一次就够 */
const initialCustomSchemes = readCustomSchemes()

export type Theme = 'dark' | 'light'
/** batch = 批量执行：一屏勾多台主机跑同一条命令（见 `features/batch/BatchPanel`） */
export type TabKind = 'terminal' | 'sftp' | 'local' | 'editor' | 'batch'

/**
 * 切主题的三处落点必须一起改：`data-theme` 属性（驱动 CSS 变量）、localStorage（下次启动）、
 * 原生窗口主题（标题栏）。
 *
 * 第三个最容易漏 —— 只改前两个的话，页面是浅色的、标题栏还是系统那条深色的。
 * 所有入口都走这里（状态栏按钮、设置面板、命令面板、恢复默认、启动时那次应用），
 * 以后加新入口也不会漏。
 *
 * 终端的配色也挂在它上面：TerminalView 订阅 store 的 `theme`，切主题时按新主题取
 * 配色方案里对应的那一版（见 `lib/termSchemes.ts`）。
 */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  writeLocal('theme', theme)
  void syncWindowTheme(theme)
}

/** loading=检查中 setup=首次设置主密码 locked=待解锁 ready=已解锁 */
/**
 * 需要用户拍板才能继续的操作。见 store 里 `confirmPrompt` 的说明。
 *
 * 前两个 arm 是安全事项（连不上/降级），后面三个是通用的：
 * 危险操作确认、未保存改动确认、需要填一个值的输入框。
 * 全走同一套自绘弹窗，不用 `window.confirm/prompt` ——
 * WebView2 里 confirm 压根不渲染（直接当确认），prompt 弹的是原生框，跟整套视觉不搭。
 */
export type ConfirmPrompt =
  | { kind: 'host_key_mismatch'; host: string; detail: string; retry: () => void }
  | { kind: 'algo_compat'; message: string; retry: () => void }
  | {
      kind: 'confirm'
      title: string
      message: string
      /** 可选的等宽块，用来摊开路径、目标这类不该被文案淹没的信息 */
      detail?: string
      confirmLabel: string
      /** 危险操作：盾牌图标 + 红色按钮。默认是主色按钮 */
      danger?: boolean
      onConfirm: () => void
    }
  | {
      kind: 'unsaved'
      /** 标签名，用在文案里 */
      name: string
      /** 返回 null 表示保存成功；返回字符串是给用户看的错误，弹窗留在原地 */
      onSave: () => Promise<string | null>
      /** 关掉这个标签。「不保存关闭」与「保存成功后」共用同一个收尾 */
      close: () => void
    }
  | {
      kind: 'input'
      title: string
      label: string
      defaultValue?: string
      placeholder?: string
      confirmLabel: string
      onConfirm: (value: string) => void | Promise<void>
    }

export type VaultPhase = 'loading' | 'setup' | 'locked' | 'ready'

/** 编辑器标签交给 store 的"守卫"：关标签前问一句要不要保存 */
export interface EditorGuard {
  /** 有没保存的改动 */
  isDirty: () => boolean
  /** 存一次。返回 null 表示成功，字符串是给用户看的错误 */
  save: () => Promise<string | null>
}

/**
 * 分屏里的一个终端格子。
 *
 * 每格是**自己一条 SSH 连接**，这是「自由组合连接主机」的全部含义：
 * 同一个标签的四格可以挂四台不同的机器。格子自己的终端实例、滚动历史、
 * 通道都在它身上，所以拖动换位时格子整个搬走（见 `movePane`）。
 */
export interface Pane {
  id: string
  /** terminal 走 SSH；local 是本机 shell（只有单格标签用得上，本地 shell 不可分屏） */
  kind: 'terminal' | 'local'
  /** SSH 会话 id。kind 为 local 时没有 */
  sessionId?: string
  /**
   * 这一格属于哪台主机（vault 里的 HostRecord.id）。
   * 会话树点「打开 SFTP」时靠它找到已经建好的连接复用，而不是再拨一次 ——
   * 二次连接意味着二次认证，还可能撞上服务端的连接数限制。
   * 快速连接（没存进 vault）的格子没有这个字段。
   */
  hostId?: string
  /** 格子标题条上显示的名字 */
  title: string
}

export interface Tab {
  id: string
  title: string
  kind: TabKind
  /** SSH 会话 id。**只有 sftp / editor 标签用它**，终端标签的连接在 `panes` 里 */
  sessionId?: string
  /** sftp / editor 标签属于哪台主机；终端标签看各自 pane 的 hostId */
  hostId?: string
  /**
   * 终端标签的格子，1–4 个。**顺序就是视觉顺序**，摆成什么形状看 `layout`。
   * 本地 Shell 标签也是 1 个格子（`kind='local'`），这样命令片段、查找、断线标记
   * 全都按 paneId 索引，不用维护"按标签"和"按格子"两套键。
   */
  panes?: Pane[]
  /** 这一屏怎么摆（左右二分 / 上下二分 / 三格的各种排法 / 四宫格…）。见 `PANE_LAYOUTS` */
  layout?: PaneLayout
  /** kind 为 editor 时的打开目标 */
  editorTarget?: EditorTarget
  /**
   * kind 为 batch 时「一开就替用户勾上」的主机 id。
   *
   * 只是**初始值**：选了哪几台是这一屏自己的状态，面板自己管。
   * 存进 tab 而不是另外开一个 store 字段，是为了让「从会话树带几台主机进来」
   * 跟标签一一对应 —— 开两个批量标签各跑各的，互不干扰。
   */
  batchTargets?: string[]
}

/** 一个标签最多几格。2×2 的极限，也是 sshd `MaxSessions` 底下留得住的数 */
export const MAX_PANES = 4

/** 格子在网格里的位置：c / r 从 1 开始，cs / rs 是跨列 / 跨行数（默认 1） */
interface CellSpec {
  c: number
  r: number
  cs?: number
  rs?: number
}

export interface LayoutSpec {
  /** 菜单里显示的名字 */
  label: string
  /** 网格几列几行 */
  cols: number
  rows: number
  /** 每个格子的位置，**下标 = panes 的下标**（也就是视觉顺序，拖拽换位换的就是这个顺序） */
  cells: CellSpec[]
}

/**
 * 分屏的形状。
 *
 * 光有"几格"不够：两台机器横摆还是竖摆、三台怎么排，取决于屏幕形状和"这台要看什么"。
 * 所以形状是**每个标签自己的选择**（`Tab.layout`），比例（列 / 行）仍是全局的两个值
 * （`splitRatio` / `splitRatioY`）—— 比例是手感偏好，形状是这一屏的摆法。
 *
 * 格子数必须跟 `Tab.panes` 一样长：换形状时少则补格、多则收格，都在 `setPaneLayout` 里做。
 */
export type PaneLayout =
  | 'single'
  | 'cols2'
  | 'rows2'
  | 'cols3'
  | 'rows3'
  | 'cols4'
  | 'rows4'
  | 'left1Right2'
  | 'left2Right1'
  | 'left1Right3'
  | 'left3Right1'
  | 'top1Bottom2'
  | 'top2Bottom1'
  | 'top1Bottom3'
  | 'top3Bottom1'
  | 'grid4'

export const PANE_LAYOUTS: Record<PaneLayout, LayoutSpec> = {
  single: { label: '单格', cols: 1, rows: 1, cells: [{ c: 1, r: 1 }] },
  cols2: {
    label: '左右二分',
    cols: 2,
    rows: 1,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
    ],
  },
  rows2: {
    label: '上下二分',
    cols: 1,
    rows: 2,
    cells: [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
    ],
  },
  cols3: {
    label: '三列',
    cols: 3,
    rows: 1,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
      { c: 3, r: 1 },
    ],
  },
  rows3: {
    label: '三行',
    cols: 1,
    rows: 3,
    cells: [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
      { c: 1, r: 3 },
    ],
  },
  cols4: {
    label: '四列',
    cols: 4,
    rows: 1,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
      { c: 3, r: 1 },
      { c: 4, r: 1 },
    ],
  },
  rows4: {
    label: '四行',
    cols: 1,
    rows: 4,
    cells: [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
      { c: 1, r: 3 },
      { c: 1, r: 4 },
    ],
  },
  left1Right3: {
    label: '左一右三',
    cols: 2,
    rows: 3,
    cells: [
      { c: 1, r: 1, rs: 3 },
      { c: 2, r: 1 },
      { c: 2, r: 2 },
      { c: 2, r: 3 },
    ],
  },
  left3Right1: {
    label: '左三右一',
    cols: 2,
    rows: 3,
    cells: [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
      { c: 1, r: 3 },
      { c: 2, r: 1, rs: 3 },
    ],
  },
  top1Bottom3: {
    label: '上一下三',
    cols: 3,
    rows: 2,
    cells: [
      { c: 1, r: 1, cs: 3 },
      { c: 1, r: 2 },
      { c: 2, r: 2 },
      { c: 3, r: 2 },
    ],
  },
  top3Bottom1: {
    label: '上三下一',
    cols: 3,
    rows: 2,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
      { c: 3, r: 1 },
      { c: 1, r: 2, cs: 3 },
    ],
  },
  left1Right2: {
    label: '左一右二',
    cols: 2,
    rows: 2,
    cells: [
      { c: 1, r: 1, rs: 2 },
      { c: 2, r: 1 },
      { c: 2, r: 2 },
    ],
  },
  left2Right1: {
    label: '左二右一',
    cols: 2,
    rows: 2,
    cells: [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
      { c: 2, r: 1, rs: 2 },
    ],
  },
  top1Bottom2: {
    label: '上一下二',
    cols: 2,
    rows: 2,
    cells: [
      { c: 1, r: 1, cs: 2 },
      { c: 1, r: 2 },
      { c: 2, r: 2 },
    ],
  },
  top2Bottom1: {
    label: '上二下一',
    cols: 2,
    rows: 2,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
      { c: 1, r: 2, cs: 2 },
    ],
  },
  grid4: {
    label: '四宫格',
    cols: 2,
    rows: 2,
    cells: [
      { c: 1, r: 1 },
      { c: 2, r: 1 },
      { c: 1, r: 2 },
      { c: 2, r: 2 },
    ],
  },
}

/** 菜单里的排列顺序：先按格数，再按形状 */
export const LAYOUT_ORDER: PaneLayout[] = [
  'single',
  'cols2',
  'rows2',
  'cols3',
  'rows3',
  'cols4',
  'rows4',
  'left1Right2',
  'left2Right1',
  'left1Right3',
  'left3Right1',
  'top1Bottom2',
  'top2Bottom1',
  'top1Bottom3',
  'top3Bottom1',
  'grid4',
]

/**
 * 「成长」表：往一个窗口里并进一个标签时，形状该长成哪一档。
 *
 * 并标签会 +1 格，形状的格子数得跟着变 —— 若一律回落到"该格数的默认"，
 * 用户摆好的左一右二并进来一个就突然变四宫格。按家族成长：左一右二长成左一右三，
 * 新终端正好落在你指的那一格，其余格子顺移。
 */
const GROWN_LAYOUT: Record<PaneLayout, PaneLayout | null> = {
  single: 'cols2',
  cols2: 'cols3',
  rows2: 'rows3',
  cols3: 'cols4',
  rows3: 'rows4',
  left1Right2: 'left1Right3',
  left2Right1: 'left3Right1',
  top1Bottom2: 'top1Bottom3',
  top2Bottom1: 'top3Bottom1',
  // 以下已经到顶（四格是上限，这几种也没有"再长一档"的形状）
  cols4: null,
  rows4: null,
  left1Right3: null,
  left3Right1: null,
  top1Bottom3: null,
  top3Bottom1: null,
  grid4: null,
}

/** 按当前形状与新格数挑成长后的形状；家族接不上（一次并好几个）才回落默认 */
function grownLayout(current: PaneLayout, newCount: number): PaneLayout {
  const grown = GROWN_LAYOUT[current]
  if (grown && PANE_LAYOUTS[grown].cells.length === newCount) return grown
  return layoutForCount(newCount, current)
}

/**
 * 每种格数回落到哪个形状：关掉一格、并进一个标签之后格数会变，
 * 原来那个形状的格子数就对不上了。挑的是"换过去动得最少"的那个 ——
 * 从四宫格关掉右下角，剩下的正好是「上二下一」。
 */
export const DEFAULT_LAYOUT_BY_COUNT: Record<number, PaneLayout> = {
  1: 'single',
  2: 'cols2',
  3: 'top2Bottom1',
  4: 'grid4',
}

/** 格数变了之后该用哪个形状：当前形状的格子数对得上就留着，对不上回落默认 */
function layoutForCount(count: number, current: PaneLayout | undefined): PaneLayout {
  if (current && PANE_LAYOUTS[current].cells.length === count) return current
  return DEFAULT_LAYOUT_BY_COUNT[count] ?? 'single'
}

/** 标签当前的形状。没记过（或者记的跟格子数对不上）就按格数取默认 */
export function layoutOf(tab: Tab | undefined | null): PaneLayout {
  return layoutForCount(panesOf(tab).length, tab?.layout)
}

/** 标签的格子。非终端标签（SFTP / 编辑器）没有格子，返回空数组 */
export function panesOf(tab: Tab | undefined | null): Pane[] {
  return tab?.panes ?? []
}

/** 一个标签里所有活着的 SSH 会话（终端标签的每格各一条，SFTP/编辑器标签是它自己那条） */
export function tabSessionIds(tab: Tab): string[] {
  const ids = panesOf(tab)
    .map((p) => p.sessionId)
    .filter((id): id is string => !!id)
  if (tab.sessionId) ids.push(tab.sessionId)
  return ids
}

/** 标签里有没有断线不管了的格子（标签栏的 ↻ 认它） */
export function tabHasDeadPane(tab: Tab, deadPanes: Record<string, true>): boolean {
  return panesOf(tab).some((p) => deadPanes[p.id])
}

let paneSeq = 0

/**
 * 造一个格子 id。带上自增序号：同一个标签里连开两格可能落在同一毫秒，
 * 只靠时间戳 + 随机尾巴有撞号的余地，而撞号意味着两个终端共用一个注册键。
 */
export function newPaneId(): string {
  paneSeq += 1
  return `pane-${Date.now().toString(36)}-${paneSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/** 造一个格子。id 统一在这里生成，别在调用点手拼 */
export function makePane(input: Omit<Pane, 'id'>): Pane {
  return { ...input, id: newPaneId() }
}

/**
 * 造一条终端标签（连带它那唯一一格）。
 *
 * 终端标签**必须**有格子：没有格子的终端标签在界面上是一片空白。
 * 让调用点各写一遍 `panes: [makePane({...})]` 迟早会漏一处，所以收在这里。
 * （SFTP / 编辑器标签不吃这套，它们只有 sessionId / editorTarget，没有格子。）
 */
export function terminalTab(input: {
  title: string
  kind?: 'terminal' | 'local'
  sessionId?: string
  hostId?: string
}): Omit<Tab, 'id'> {
  const kind = input.kind ?? 'terminal'
  return {
    title: input.title,
    kind,
    panes: [makePane({ kind, sessionId: input.sessionId, hostId: input.hostId, title: input.title })],
  }
}

/**
 * 这条标签能不能调分屏档位（1 / 2 / 4 格）。
 *
 * 判据是**第一格有 SSH 连接**：加格子靠的是"继承第一格的连接再开一条 shell"，
 * 本地 Shell 没有连接可继承（纯本地标签因此仍然不显示分屏按钮 —— 它要更多 shell
 * 直接再开一个标签就行）。用第一格而不是"有一格是远程"：本地 Shell 排在头一位的
 * 混合标签，点分屏生出来的也该是本地 shell，可它并不是用户按这个按钮想要的东西。
 *
 * 这个谓词同时兜住了 SFTP / 编辑器标签：它们压根没有格子。
 */
export function isSplittable(tab: Tab | undefined | null): tab is Tab {
  const panes = panesOf(tab)
  return panes.length > 0 && !!panes[0].sessionId
}

/**
 * 这条标签能不能当"把别的标签并进来"的落点。有格子的标签才行 ——
 * 也就是远程终端标签和本地 Shell 标签；SFTP / 编辑器标签里没有分屏这一说。
 *
 * 本地 Shell 能当落点是刻意的：一屏里"左边远程、右边本机 PowerShell"是很常见的用法，
 * 早先只放远程标签进来过一次（用户拿本地 Shell 标签拖进来被挡下）。
 */
export function acceptsPanes(tab: Tab | undefined | null): boolean {
  return (
    !!tab &&
    (tab.kind === 'terminal' || tab.kind === 'local') &&
    panesOf(tab).length > 0
  )
}

export type TransferStatus = 'active' | 'done' | 'error'

export interface TransferItem {
  id: string
  direction: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  status: TransferStatus
  /**
   * 这次传输里有多少个文件没动（目标已存在按策略跳过，或本地那份已是最新）。
   *
   * 单独记账而不是塞进 message：批量传一个目录时它是个计数，
   * 用户要的是「有几个没传」，不是一长串文件名。
   */
  skipped: number
  /** 最近一次跳过的文件名 + 原因，鼠标悬停时看 */
  skipHint?: string
  message?: string
}

interface AppState {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void

  connectOpen: boolean
  setConnectOpen: (open: boolean) => void

  tunnelOpen: boolean
  setTunnelOpen: (open: boolean) => void

  /**
   * 需要用户拍板才能继续的操作。
   *
   * 安全类（主机密钥变了 / 算法谈不拢）是**不该由程序替用户决定**的事，
   * `retry` 由调用方塞进来，因为"重试后是开终端还是开 SFTP"只有调用方知道。
   *
   * 通用类（confirm / unsaved / input）同样是"程序不该替用户拍板"：
   * 删东西之前问一句、有没保存的改动先问一句、要个名字先问一句。
   */
  confirmPrompt: ConfirmPrompt | null
  setConfirmPrompt: (prompt: ConfirmPrompt | null) => void

  snippetsOpen: boolean
  setSnippetsOpen: (open: boolean) => void

  phase: VaultPhase
  vaultError: string | null
  /**
   * 密钥库里没设主密码。
   *
   * 三个地方读它：启动时（直接解锁，不弹锁屏）、锁屏上（只有一个「解锁」按钮，
   * 没有密码框）、以及改密码对话框（当前密码那一栏该不该出现）。
   * 来源永远是后端 `vault_status`，别在本地猜。
   */
  vaultNoPassword: boolean
  /**
   * 恢复密钥（一把 SSH 公钥）的指纹；没配的话是 null。
   *
   * 有它锁屏才给「用 SSH 私钥解锁」这条路，**并且**会收掉「忘记主密码 → 清空重来」
   * 那个按钮 —— 有正经后路时，不该再摆一个人人点两下就能毁库的入口。
   */
  vaultRecoveryFp: string | null
  /** 这一轮是不是用恢复密钥解锁的（改密码时不用填旧密码，见 `changeMasterPassword`） */
  vaultByRecovery: boolean

  /** 「修改主密码」对话框开着没 */
  changePasswordOpen: boolean
  setChangePasswordOpen: (open: boolean) => void

  /**
   * 「给主密码配一把恢复公钥？」这个提示开着没。
   *
   * 触发点是**刚设完主密码**（新建库、改密码都算）—— 那是唯一说得上话的时机：
   * 用户手里还有这把密码，也刚意识到「密码忘了会怎样」。藏在设置面板里没人会去看，
   * 而这一条恰恰是「等你想起来的时候已经晚了」的那类设置。
   */
  recoveryPromptOpen: boolean
  setRecoveryPromptOpen: (open: boolean) => void
  /** 「不再提示」：永久关掉这个提示（用户偏好，存 localStorage） */
  muteRecoveryPrompt: () => void

  /** 全局轻提示，4 秒后自动消失 */
  error: string | null
  setError: (message: string | null) => void

  initVault: () => Promise<void>
  setupVault: (password: string) => Promise<void>
  unlockVault: (password: string) => Promise<void>
  /** 用恢复密钥（SSH 私钥文件）解锁。错误原样抛出，锁屏就地显示 */
  unlockWithKey: (privateKeyPath: string, passphrase?: string) => Promise<void>
  /**
   * 设/换恢复公钥（公钥文本或文件路径都行），返回指纹。
   *
   * 只有**用主密码解锁**的那一轮能调：否则「用恢复密钥进来的人又换一把恢复密钥」，
   * 会把状态搞得没边。后端也会拦，两边都拦是有意的。
   */
  setRecoveryKey: (key: string) => Promise<string>
  /** 移除恢复密钥。少一条后路，调用前必须让用户明确确认 */
  clearRecoveryKey: () => Promise<void>
  /**
   * 锁定密钥库：收掉所有连接、清空标签。
   * `force` 是"确认过了"的重入标志 —— 有没保存的编辑器时它会先弹一次确认，
   * 用户点确认后再带着 force 调回来。
   */
  lockVault: (force?: boolean) => Promise<void>
  /** 清空密钥库回到「首次使用」。**不可撤销**，调用前必须让用户明确确认 */
  resetVault: () => Promise<void>
  /**
   * 换主密码；`newPassword` 传空串就是「改成不设密码」。
   *
   * 只有在库**已解锁**时才调得通（后端要拿当前这把钥匙重新加密全部凭据），
   * 失败原样抛出 —— 错误属于那个对话框，不该污染锁屏的 `vaultError`。
   */
  changeMasterPassword: (oldPassword: string, newPassword: string) => Promise<void>

  hosts: HostRecord[]
  groups: GroupRecord[]
  refreshHosts: () => Promise<void>
  saveHost: (host: HostRecord) => Promise<void>
  removeHost: (id: string) => Promise<void>
  saveGroup: (group: GroupRecord) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  /** 让用户填分组名再创建。会话树与命令面板共用这一条 */
  promptNewGroup: () => void
  promptRenameGroup: (id: string, oldName: string) => void

  /**
   * 挑一个本地文件用内置编辑器打开。
   * 命令面板、侧栏工具区、空状态三个入口共用 —— 逻辑放这里就不用抄三遍。
   */
  openLocalFileDialog: () => Promise<void>

  collapsed: Record<string, boolean>
  toggleGroup: (id: string) => void

  /**
   * 会话侧栏收没收起。
   *
   * 终端一开宽，左边 240px 就是纯浪费 —— 而侧栏只在一开始选主机时有用。
   * 收起状态跟其他偏好一样持久化：这是"我平时怎么用"，不该每次启动重设。
   */
  sidebarCollapsed: boolean
  toggleSidebar: () => void

  /**
   * 哪个格子（paneId）的「在终端里查找」栏开着，全局只有一个。
   *
   * 放 store 而不是 TerminalView 自己的 state：快捷键、状态栏、命令面板三处
   * 都要能把它叫出来，而它们够不着某个组件内部的 state。
   * 切标签**不清**它 —— 跟 Windows Terminal / VS Code 一样，搜索框和查询内容
   * 跟着那条标签走，切回来还在。同时在两个格子里搜做不到（一个值只指一格），
   * 在后一格打开时前一格自然收起。
   */
  findPaneId: string | null
  /**
   * 当前标签里聚焦的那一格有没有终端可搜，有就返回它。
   * 编辑器有自己的 Ctrl+F（CodeMirror 自带），SFTP 还没有 —— 在那些标签上叫查找，
   * 该说一句而不是弹一个搜不到东西的框。
   */
  findablePane: () => Pane | null
  /** 开/关当前标签的查找栏。三处入口都调它，别各自判断 */
  toggleFind: () => void
  /** 关掉查找栏（查找栏自己的 ✕ / Esc 走这条，不经过 toggle） */
  closeFind: () => void

  tabs: Tab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  addTab: (tab: Omit<Tab, 'id'>) => string
  /**
   * 开一个「批量执行」标签。`hostIds` 是一开就替用户勾上的主机
   * （会话树、命令面板两个入口共用，别各写一份 addTab）。
   */
  openBatchTab: (hostIds?: string[]) => string
  closeTab: (id: string) => void
  /**
   * 用户主动关标签都走这里：标签里有没保存的编辑器就先弹确认，
   * 否则直接关。程序自动关（本地 shell 退出、锁库清标签）仍用 closeTab 绕开它。
   */
  requestCloseTab: (id: string) => void

  /**
   * 每个标签聚焦在哪一格（tabId → paneId）。点格子里的任何地方都会记一笔，
   * 命令片段投给谁、查找搜谁、状态栏显示谁，都以它为准。
   * 没记录过（或记的那格已经关了）就取第一个格子。
   */
  focusedPane: Record<string, string>
  focusPane: (tabId: string, paneId: string) => void
  /** 某个标签当前聚焦的格子；标签不存在就返回 null */
  focusedPaneOf: (tabId: string) => Pane | null
  /** 当前标签聚焦的格子 */
  activePane: () => Pane | null

  /**
   * 换分屏形状（左右二分 / 上下二分 / 三格的几种排法 / 四宫格…）。
   *
   * 格子多了就补（新格子**继承第一格的连接** —— 同一条会话再开一条 shell 通道，
   * 不用重新认证也不用再选一次主机），少了就把末尾几个收掉（各自的 shell 随之结束，
   * 界面上会给一句回执，别让终端悄悄没了）。
   * 格数相同的形状之间切换只是重新摆位，**一个格子都不会动**。
   */
  setPaneLayout: (tabId: string, layout: PaneLayout) => void
  /** 关掉一格（标题条上的 ✕）。只剩一格时不给关 —— 那等于关标签，走标签的 ✕ */
  closePane: (tabId: string, paneId: string) => void
  /**
   * 把一个标签的终端**并进另一个标签的窗口**（把标签拖到终端窗口里松手）。
   *
   * 实现是"先在目标标签里按同样的连接开新格子，等新格子真的连上了再收掉源标签"，
   * **不是**把格子搬过去。搬过去会让旧通道和新通道的开关撞在一起：格子搬走时
   * 旧终端卸载、通道关闭，而后端的 `close_session_if_idle` 一看到这条会话一条
   * 通道都不剩就把会话整个回收 —— 新格子的 `ssh_open_shell` 于是落在一个
   * 已经不存在的会话上（`ssh_open_shell` 是**网络往返之后**才登记通道的，
   * 关通道那侧却不用等网络，这个赛跑几乎必输）。
   * 等新通道起来了再收源标签，会话两侧交接得上。
   *
   * `insertAt` 是落点格的下标：新格子**插到那个位置**（其余顺移），形状按"成长规则"
   * 选（cols2 长成 cols3、左一右二长成左一右三…，见 `GROWN_LAYOUT`）——
   * 新终端就出现在你指的那一格附近，而不是永远追加到末尾再整屏重排。
   */
  mergeTabIntoPane: (
    targetTabId: string,
    sourceTabId: string,
    insertAt?: number,
    layoutHint?: PaneLayout,
  ) => void
  /**
   * 正在被拖的标签（标签栏拖起来时写，放下或 Esc 取消时清）。
   * 跨组件用：PaneGrid 靠它区分"拖着标签来找地方拼"和"拖格子换位"这两件事。
   */
  draggingTabId: string | null
  setDraggingTabId: (id: string | null) => void
  /**
   * 已经开出 shell 通道的格子。
   *
   * 只有 `mergeTabIntoPane` 用它：得等新格子真的连上了才敢收源标签，
   * 否则就是上面说的那个"会话被提前回收"。除此之外没人读它。
   */
  livePanes: Record<string, true>
  setPaneLive: (paneId: string, live: boolean) => void
  /** 两个格子互换位置（拖标题条）。格子整体搬走，终端现场不丢 */
  /**
   * 把一格**挪到**另一格的位置（拖标题条）。插入语义：被拖的格子插到目标格的位置上，
   * 中间的格子顺移 —— 跟标签栏排序一个手感（互换是旧语义，三格以上会显得跳）。
   * 格子整体搬走，终端现场不丢。
   */
  movePane: (tabId: string, fromPaneId: string, toPaneId: string) => void
  /** 给某一格换主机（先连上再把会话写进来，见 `PaneHostDialog`） */
  setPaneConnection: (
    tabId: string,
    paneId: string,
    conn: { sessionId: string; hostId?: string; title: string },
  ) => void
  /** 标签排序（拖标签）。`from` / `to` 都是数组下标，`to` 是落点下标 */
  moveTab: (from: number, to: number) => void

  /**
   * 「这一格要连哪台主机」的选择对话框。null = 没开。
   * 从格子标题条进来，选中后把连接写进那一格，而不是开新标签。
   */
  paneHostTarget: { tabId: string; paneId: string } | null
  setPaneHostTarget: (target: { tabId: string; paneId: string } | null) => void
  /**
   * 「快速连接」的目标格。非 null 时 ConnectDialog 连完把会话写进这一格，
   * 而不是开一个新标签。
   */
  connectPaneTarget: { tabId: string; paneId: string } | null
  setConnectPaneTarget: (target: { tabId: string; paneId: string } | null) => void

  /**
   * 编辑器标签注册的守卫。关标签时要同步问"脏不脏"，
   * 所以放 store 而不是 React state（和 terminalSinks 是同一个理由）。
   */
  editorGuards: Record<string, EditorGuard>
  registerEditorGuard: (tabId: string, guard: EditorGuard) => void
  unregisterEditorGuard: (tabId: string) => void

  /**
   * 分屏的列宽 / 行高，**按带数各存一份**（和恒为 1）。
   *
   * 光有两个标量撑不起三等分、四等分：三列有两条线、四列有三条。
   * key 是带数（2 = 一条线，3 = 两条，4 = 三条），没拖过的带数不写、用时给等分。
   * 两列 / 三列 / 四列共用一份列宽（手感一致），「左一右三」这类混合形状也是 ——
   * 它的列就是两带，右侧三格的行高跟「三行」共用一份。
   */
  splitColBands: Record<number, number[]>
  splitRowBands: Record<number, number[]>
  setSplitColBands: (bands: number, widths: number[]) => void
  setSplitRowBands: (bands: number, widths: number[]) => void

  /**
   * 终端字号。13px 在 1080p 上刚好，高分屏上就偏小了 ——
   * 不给个调的口子只能干瞪眼，所以做成可调并持久化。
   */
  termFontSize: number
  setTermFontSize: (size: number) => void
  /** 按步长增减，delta 传 +1 / -1 */
  bumpTermFontSize: (delta: number) => void

  /** 终端字体族。空串表示用内置字体栈 */
  termFontFamily: string
  setTermFontFamily: (family: string) => void

  /** 行高倍数。改它要重新 fit（字符高度变了），和字号是一类 */
  termLineHeight: number
  setTermLineHeight: (lineHeight: number) => void

  termCursorStyle: CursorStyle
  setTermCursorStyle: (style: CursorStyle) => void

  /** 回滚缓冲行数。改它不用 refit */
  termScrollback: number
  setTermScrollback: (lines: number) => void

  /**
   * 终端配色方案 id。`APP_SCHEME_ID` 表示跟随应用设计色板（改造前只有这一套），
   * 其余是 `lib/termSchemes.ts` 里的内置方案或用户自定义方案。
   */
  termScheme: string
  setTermScheme: (id: string) => void

  /** 用户自定义的配色方案。跟其他偏好一样存 localStorage */
  customSchemes: TermScheme[]
  saveCustomScheme: (scheme: TermScheme) => void
  deleteCustomScheme: (id: string) => void

  /**
   * 断线自动重连策略。0 次 = 不自动重连，直接等人点 ↻。
   * 这两种环境（跳板机抖动 / 一次性命令机器）想要的策略完全相反，
   * 写死 3 次 / 2 秒总有一边别扭。
   */
  reconnectAttempts: number
  setReconnectAttempts: (times: number) => void
  reconnectDelaySec: number
  setReconnectDelaySec: (seconds: number) => void

  /** 传输默认是否续传。SFTP 面板上还能临时改，这里定的是新面板的初值 */
  transferResumeDefault: boolean
  setTransferResumeDefault: (on: boolean) => void

  /** 把上面这些设置全部恢复默认 */
  resetSettings: () => void

  /**
   * 每个终端格子注册一个"投喂函数"，命令片段面板靠它把命令送进对应终端。
   * 键是 **paneId**（不是 tabId）：一个标签有好几格时，片段该投给聚焦的那一格，
   * 而"哪一格聚焦"是 store 的事（`focusedPane`）。
   * 不放进 React state，避免每次注册都触发重渲染。
   */
  terminalSinks: Record<string, (text: string) => void>
  registerTerminalSink: (paneId: string, sink: (text: string) => void) => void
  unregisterTerminalSink: (paneId: string) => void

  /**
   * 每个终端格子注册的"手动重连"回调。
   *
   * 断线自动重试几次都失败之后，标签栏得给一个 ↻ 让用户再试一次 ——
   * 否则唯一的出路就是关掉标签重开，之前看的东西全没了。
   *
   * 一格一个键，不需要数组：格子各有各的 paneId，不会互相顶掉。
   * 点 ↻ 会把该标签所有格子都拉一遍（`reconnectSession` 按 sessionId 去重，
   * 同一条会话上的几格不会互相清通道）。
   */
  reconnectSinks: Record<string, () => void>
  registerReconnect: (paneId: string, fn: () => void) => void
  unregisterReconnect: (paneId: string) => void

  /** 自动重连已放弃、正等着用户手动介入的格子 */
  deadPanes: Record<string, true>
  setPaneDead: (paneId: string, dead: boolean) => void

  /** 传输队列，最新在前 */
  transfers: TransferItem[]
  /** 跑一次传输并接管进度事件；结束后返回 true/false 表示成功 */
  runTransfer: (
    direction: 'upload' | 'download',
    name: string,
    run: (onProgress: Channel<TransferEvent>) => Promise<void>,
  ) => Promise<boolean>
  clearFinished: () => void
}

export const useApp = create<AppState>((set, get) => ({
  // 主题以前不持久化：设成浅色、重启回来又变深色。存在 localStorage 里
  theme: (() => {
    try {
      const v = localStorage.getItem('theme')
      return v === 'light' || v === 'dark' ? (v as Theme) : 'dark'
    } catch {
      return 'dark' as Theme
    }
  })(),
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      return { theme: next }
    }),
  setTheme: (theme) =>
    set(() => {
      applyTheme(theme)
      return { theme }
    }),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  connectOpen: false,
  setConnectOpen: (open) => set({ connectOpen: open }),

  tunnelOpen: false,
  setTunnelOpen: (open) => set({ tunnelOpen: open }),

  confirmPrompt: null,
  setConfirmPrompt: (prompt) => set({ confirmPrompt: prompt }),

  snippetsOpen: false,
  setSnippetsOpen: (open) => set({ snippetsOpen: open }),

  phase: 'loading',
  vaultError: null,
  vaultNoPassword: false,
  vaultRecoveryFp: null,
  vaultByRecovery: false,

  changePasswordOpen: false,
  setChangePasswordOpen: (open) => set({ changePasswordOpen: open }),

  recoveryPromptOpen: false,
  setRecoveryPromptOpen: (open) => set({ recoveryPromptOpen: open }),
  muteRecoveryPrompt: () => {
    writeLocal(RECOVERY_PROMPT_MUTED, '1')
    set({ recoveryPromptOpen: false })
  },

  error: null,
  setError: (message) => {
    set({ error: message })
    if (message) {
      setTimeout(() => set({ error: null }), 4000)
    }
  },

  initVault: async () => {
    try {
      const status = await vaultStatus()
      // 恢复密钥指纹 / 「这一轮是恢复解锁的」都是后端说了算，本地不猜
      set({
        vaultNoPassword: status.noPassword,
        vaultRecoveryFp: status.recoveryFingerprint,
        vaultByRecovery: status.unlockedByRecovery,
      })
      if (!status.initialized) {
        set({ phase: 'setup', vaultError: null })
        return
      }
      if (!status.unlocked) {
        /**
         * 无密码库直接进 —— 这是「不设主密码」的全部意义：启动时不该被一个
         * 空心密码框再挡一次。
         *
         * 失败就退回锁屏而不是把错误抛给用户：标记与实际校验串不一致（手改过的库、
         * 跨版本迁移）时也没别的办法，用户在那里点一下「解锁」同样能进去。
         * 启动路径上不弹看不懂的错，是这个分支唯一的讲究。
         */
        if (status.noPassword) {
          try {
            await vaultUnlock('')
            await get().refreshHosts()
            set({ phase: 'ready' })
            return
          } catch {
            set({ phase: 'locked', vaultError: null })
            return
          }
        }
        set({ phase: 'locked', vaultError: null })
        return
      }
      await get().refreshHosts()
      set({ phase: 'ready' })
    } catch (e) {
      set({ phase: 'locked', vaultError: String(e) })
    }
  },

  setupVault: async (password) => {
    set({ vaultError: null })
    try {
      await vaultSetup(password)
      // 空串 = 用户在上一步明确选了「不设密码」，标记要跟着走。
      // 新库还没有恢复密钥，那两项也一并归零（重置过的库里可能留着旧的指纹）
      set({ vaultNoPassword: password === '', vaultRecoveryFp: null, vaultByRecovery: false })
      // 这是个**新库**：上一轮「不再提示」的偏好不该跟过来，重新问一次
      writeLocal(RECOVERY_PROMPT_MUTED, '0')
      await get().refreshHosts()
      set({
        phase: 'ready',
        // 没设密码就谈不上「忘密码」，那时恢复密钥没有意义（设置面板里也是这么写的）
        recoveryPromptOpen: password !== '',
      })
    } catch (e) {
      set({ vaultError: String(e) })
      throw e
    }
  },

  unlockVault: async (password) => {
    set({ vaultError: null })
    try {
      await vaultUnlock(password)
      await get().refreshHosts()
      set({ phase: 'ready', vaultByRecovery: false })
    } catch (e) {
      set({ vaultError: String(e) })
      throw e
    }
  },

  /**
   * 用恢复密钥（SSH 私钥）解锁。
   *
   * 和密码那条路的区别只有一个：进去之后改密码不用填旧密码（`vaultByRecovery`），
   * 因为忘密码的人正是靠这条路把库拿回来的。数据、标签、连接的行为完全一样。
   */
  unlockWithKey: async (privateKeyPath, passphrase) => {
    set({ vaultError: null })
    try {
      await vaultUnlockWithKey(privateKeyPath, passphrase)
      await get().refreshHosts()
      set({ phase: 'ready', vaultByRecovery: true })
    } catch (e) {
      set({ vaultError: String(e) })
      throw e
    }
  },

  setRecoveryKey: async (key) => {
    const fingerprint = await vaultRecoverySet(key)
    set({ vaultRecoveryFp: fingerprint })
    return fingerprint
  },

  clearRecoveryKey: async () => {
    await vaultRecoveryClear()
    set({ vaultRecoveryFp: null })
  },

  changeMasterPassword: async (oldPassword, newPassword) => {
    await vaultChangePassword(oldPassword, newPassword)
    // 后端已经把内存里的钥匙换成新的了；hosts 存的是明文凭据，不用重读。
    // 翻掉这两个标记：改完密码就不再是「用恢复密钥进来的那一轮」了
    const state = get()
    const prompt =
      newPassword !== '' && !state.vaultRecoveryFp && !isRecoveryPromptMuted()
    set({
      vaultNoPassword: newPassword === '',
      vaultByRecovery: false,
      // 要弹恢复密钥的提示就先收起改密码那个框 —— 两个 ModalShell 都是
      // `fixed inset-0 z-50`，叠着就是两层遮罩、两层 Esc
      changePasswordOpen: prompt ? false : state.changePasswordOpen,
      recoveryPromptOpen: prompt,
    })
  },

  /**
   * 锁定密钥库。
   *
   * 不只是「回到解锁界面」：锁了库还把已认证的连接留在后端，等于门锁了人还在屋里 ——
   * 会话在界面上消失了，服务端却仍占着槽位（sshd 默认 MaxSessions 10），
   * 何况它本来就是用这把现在已被清掉的钥匙开的。
   *
   * 标签卸载时各自会关掉自己的通道，但那一步只覆盖「有 shell 通道的」标签：
   * 连上了却没开出终端的会话（open_shell 失败、或只开了 SFTP 的）会留在后端，
   * 所以锁完再按 sessionId 逐条明确断开。
   *
   * 顺序是刻意的：先清标签再收连接。反过来的话，终端还挂着时会收到 closed 事件
   * 去走重连流程，凭空制造一次竞态。
   *
   * 标签里的编辑器如果还有没保存的改动，锁库会把它一起收掉 —— 先让用户确认一次。
   */
  lockVault: async (force = false) => {
    if (!force) {
      const dirty = Object.values(get().editorGuards).filter((g) => g.isDirty()).length
      if (dirty > 0) {
        set({
          confirmPrompt: {
            kind: 'confirm',
            danger: true,
            title: `还有 ${dirty} 个文件没保存`,
            message: '锁定密钥库会关掉所有标签，这些未保存的改动会一起丢掉。',
            confirmLabel: '仍然锁定',
            onConfirm: () => void get().lockVault(true),
          },
        })
        return
      }
    }
    // 一个标签可能挂着好几条会话（每格一条），都要收 —— 只按 tab.sessionId 收会漏掉分屏
    const sessionIds = [...new Set(get().tabs.flatMap(tabSessionIds))]
    await vaultLock()
    set({
      phase: 'locked',
      hosts: [],
      groups: [],
      tabs: [],
      activeTabId: null,
      findPaneId: null,
      focusedPane: {},
      deadPanes: {},
      // 「这一轮是用恢复密钥进来的」是**会话**状态，锁了就没了
      vaultByRecovery: false,
    })
    for (const id of sessionIds) void sshClose(id)
  },

  /**
   * 清空密钥库，回到「设置主密码」。
   *
   * 不需要像 lockVault 那样收连接：这个入口只在解锁页上，能走到那里
   * 说明标签早被锁定时清干净了。hosts 也一并清掉，免得重置后界面上还留着旧主机。
   */
  resetVault: async () => {
    await vaultReset()
    set({
      phase: 'setup',
      vaultError: null,
      // 回到「首次使用」：无密码标记与恢复密钥都随库一起清了，由用户重新选
      vaultNoPassword: false,
      vaultRecoveryFp: null,
      vaultByRecovery: false,
      hosts: [],
      groups: [],
      tabs: [],
      activeTabId: null,
      findPaneId: null,
      focusedPane: {},
      deadPanes: {},
    })
  },

  hosts: [],
  groups: [],

  refreshHosts: async () => {
    const [hosts, groups] = await Promise.all([hostsList(), groupsList()])
    set({ hosts, groups })
  },

  saveHost: async (host) => {
    await hostsSave(host)
    await get().refreshHosts()
  },

  removeHost: async (id) => {
    await hostsDelete(id)
    await get().refreshHosts()
  },

  saveGroup: async (group) => {
    await groupsSave(group)
    await get().refreshHosts()
  },

  removeGroup: async (id) => {
    // 后端删分组时会把组里主机的 group_id 置空，主机本身不会跟着没
    await groupsDelete(id)
    await get().refreshHosts()
  },

  collapsed: {},
  toggleGroup: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),

  sidebarCollapsed: (() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1'
    } catch {
      return false
    }
  })(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed
      writeLocal('sidebarCollapsed', next ? '1' : '0')
      return { sidebarCollapsed: next }
    }),

  tabs: [],
  activeTabId: null,
  setActiveTab: (id) => set({ activeTabId: id }),

  focusedPane: {},
  focusPane: (tabId, paneId) =>
    set((s) => (s.focusedPane[tabId] === paneId ? {} : { focusedPane: { ...s.focusedPane, [tabId]: paneId } })),
  focusedPaneOf: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return null
    const panes = panesOf(tab)
    return panes.find((p) => p.id === get().focusedPane[tabId]) ?? panes[0] ?? null
  },
  activePane: () => {
    const { activeTabId } = get()
    return activeTabId ? get().focusedPaneOf(activeTabId) : null
  },

  findPaneId: null,
  findablePane: () => {
    // 聚焦的那一格就是查找的目标：分屏下"当前终端"必须唯一，
    // 否则搜的是哪一格全靠猜
    const pane = get().activePane()
    return pane && (pane.kind === 'terminal' || pane.kind === 'local') ? pane : null
  },
  toggleFind: () =>
    set((s) => {
      const pane = get().findablePane()
      if (!pane) return {}
      return { findPaneId: s.findPaneId === pane.id ? null : pane.id }
    }),
  closeFind: () => set({ findPaneId: null }),

  addTab: (tab) => {
    const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    set((s) => ({ tabs: [...s.tabs, { ...tab, id }], activeTabId: id }))
    return id
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      const closed = s.tabs.find((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const nextActive =
        s.activeTabId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeTabId
      // 跟着这个标签走的还有三份旁路状态：查找栏指向的格子、聚焦格子、断线标记。
      // 不清的话它们会拿着已经不存在的 paneId 一直留着
      const gonePanes = new Set(panesOf(closed).map((p) => p.id))
      const nextFocused = { ...s.focusedPane }
      delete nextFocused[id]
      const nextDead = { ...s.deadPanes }
      for (const pid of gonePanes) delete nextDead[pid]
      return {
        tabs,
        activeTabId: nextActive,
        findPaneId: s.findPaneId && gonePanes.has(s.findPaneId) ? null : s.findPaneId,
        focusedPane: nextFocused,
        deadPanes: nextDead,
      }
    }),

  openBatchTab: (hostIds) =>
    get().addTab({ title: '批量执行', kind: 'batch', batchTargets: hostIds ?? [] }),

  requestCloseTab: (id) => {
    const s = get()
    const guard = s.editorGuards[id]
    // 只有编辑器标签会注册守卫；脏了就问一句，别让改动无声消失
    if (guard?.isDirty()) {
      const tab = s.tabs.find((t) => t.id === id)
      set({
        confirmPrompt: {
          kind: 'unsaved',
          name: tab?.title ?? '这个文件',
          onSave: guard.save,
          close: () => get().closeTab(id),
        },
      })
      return
    }
    get().closeTab(id)
  },

  editorGuards: {},
  registerEditorGuard: (tabId, guard) =>
    set((s) => ({ editorGuards: { ...s.editorGuards, [tabId]: guard } })),
  unregisterEditorGuard: (tabId) =>
    set((s) => {
      if (!s.editorGuards[tabId]) return {}
      const next = { ...s.editorGuards }
      delete next[tabId]
      return { editorGuards: next }
    }),

  /**
   * 换分屏形状。
   *
   * 两个守卫在这里：不是能分屏的标签、形状没变的，一动不动。
   * 入口（标签栏的布局菜单、命令面板）各自还给一句提示。
   */
  setPaneLayout: (tabId, layout) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!isSplittable(tab)) return {}
      const cells = PANE_LAYOUTS[layout].cells.length
      const panes = panesOf(tab)
      if (layoutOf(tab) === layout && panes.length === cells) return {}
      const base = panes[0]
      const next = panes.slice(0, cells)
      // 新格子继承**第一格**的连接：同一条会话再开一条 shell 通道，不重新认证。
      // 挑第一格而不是当前聚焦那格：菜单上选的是"这个标签"的形状，行为要可预期
      while (next.length < cells) {
        next.push(
          makePane({
            kind: base.kind,
            sessionId: base.sessionId,
            hostId: base.hostId,
            title: base.title,
          }),
        )
      }
      // 收掉的那些格子：它们身上的断线标记、查找栏指向都要一起收拾，
      // 留着就是拿着不存在的 paneId 的状态
      const gone = panes.slice(cells).map((p) => p.id)
      const nextDead = { ...s.deadPanes }
      for (const pid of gone) delete nextDead[pid]
      if (gone.length > 0) {
        // 收格子会终止那些终端，说一句 —— 别让一屏的 shell 悄悄没了
        queueMicrotask(() =>
          get().setError(`已收掉末尾 ${gone.length} 格（各自的 shell 也结束了）`),
        )
      }
      return {
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, panes: next, layout } : t)),
        deadPanes: nextDead,
        findPaneId: s.findPaneId && gone.includes(s.findPaneId) ? null : s.findPaneId,
        focusedPane: gone.includes(s.focusedPane[tabId] ?? '')
          ? { ...s.focusedPane, [tabId]: next[0].id }
          : s.focusedPane,
      }
    }),

  closePane: (tabId, paneId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!isSplittable(tab)) return {}
      const panes = panesOf(tab)
      // 只剩一格不给关：那等于关标签，得走标签的 ✕（编辑器还有未保存守卫）
      if (panes.length <= 1) return {}
      const next = panes.filter((p) => p.id !== paneId)
      if (next.length === panes.length) return {}
      const nextDead = { ...s.deadPanes }
      delete nextDead[paneId]
      return {
        // 格数变了，形状跟着回落（原来那个形状的格子数已经对不上了）
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, panes: next, layout: layoutForCount(next.length, t.layout) } : t,
        ),
        deadPanes: nextDead,
        findPaneId: s.findPaneId === paneId ? null : s.findPaneId,
        focusedPane:
          s.focusedPane[tabId] === paneId
            ? { ...s.focusedPane, [tabId]: next[0].id }
            : s.focusedPane,
      }

    }),

  movePane: (tabId, fromPaneId, toPaneId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      const panes = panesOf(tab)
      const from = panes.findIndex((p) => p.id === fromPaneId)
      const to = panes.findIndex((p) => p.id === toPaneId)
      if (from < 0 || to < 0 || from === to) return {}
      // 插入语义：抽出来、插到目标位置，中间顺移（不是互换 —— 三格以上互换会显得跳）
      const next = [...panes]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, panes: next } : t)) }
    }),

  setPaneConnection: (tabId, paneId, conn) =>
    set((s) => {
      // 换过主机的格子不再是"那台断了"，旧标记跟着清
      const nextDead = { ...s.deadPanes }
      delete nextDead[paneId]
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, panes: panesOf(t).map((p) => (p.id === paneId ? { ...p, ...conn } : p)) }
            : t,
        ),
        deadPanes: nextDead,
      }
    }),

  moveTab: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || from >= s.tabs.length) return {}
      const target = Math.max(0, Math.min(s.tabs.length - 1, to))
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(target, 0, moved)
      return { tabs }
    }),

  draggingTabId: null,
  setDraggingTabId: (id) =>
    set((s) => (s.draggingTabId === id ? {} : { draggingTabId: id })),

  livePanes: {},
  setPaneLive: (paneId, live) =>
    set((s) => {
      if (!!s.livePanes[paneId] === live) return {}
      const next = { ...s.livePanes }
      if (live) next[paneId] = true
      else delete next[paneId]
      return { livePanes: next }
    }),

  mergeTabIntoPane: (targetTabId, sourceTabId, insertAt, layoutHint) => {
    const s = get()
    const target = s.tabs.find((t) => t.id === targetTabId)
    const source = s.tabs.find((t) => t.id === sourceTabId)
    if (!target || !source || target.id === source.id) return

    const moving = panesOf(source)
    const room = MAX_PANES - panesOf(target).length
    // 分开判、分开说：这两种"并不进来"的原因不一样，混成一句用户不知道该动哪边
    if (moving.length === 0) {
      s.setError(`「${source.title}」里没有终端可以并 —— 文件面板和编辑器没有格子`)
      return
    }
    if (!acceptsPanes(target)) {
      s.setError(`「${target.title}」里没有格子 —— 并进终端或本地 Shell 的窗口里才行`)
      return
    }
    if (moving.length > room) {
      s.setError(
        room <= 0
          ? `「${target.title}」已经四格了 —— 先关掉一格再拼`
          : `拼不进来：那边只剩 ${room} 格，这个标签有 ${moving.length} 格`,
      )
      return
    }

    // 阶段一：按同样的连接在目标标签里开新格子。这时候源标签的通道还开着，
    // 会话不会因为"最后一条通道关了"被回收。
    // 落到哪一格就插到哪个下标（其余顺移）——"拖到哪、新终端就在哪"；
    // 没给落点（理论上来不到这儿）才退回追加末尾
    const clones = moving.map((p) =>
      makePane({ kind: p.kind, sessionId: p.sessionId, hostId: p.hostId, title: p.title }),
    )
    const at = Math.max(0, Math.min(panesOf(target).length, insertAt ?? panesOf(target).length))
    set((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === target.id
          ? {
              ...t,
              panes: [
                ...panesOf(t).slice(0, at),
                ...clones,
                ...panesOf(t).slice(at),
              ],
              // 格数变了：形状按"成长规则"长一档（cols2→cols3、左一右二→左一右三…），
              // 家族接不上才按新格数回落默认
              layout: layoutHint ?? grownLayout(layoutOf(t), panesOf(t).length + clones.length),
            }
          : t,
      ),
      activeTabId: target.id,
    }))

    // 阶段二：等新格子把 shell 开起来再收源标签。给 5 秒上限，
    // 超了就整体回滚 —— 宁可这次没拼成，也不能把用户的终端弄丢
    const deadline = Date.now() + 5000
    const settle = () => {
      const st = get()
      // 用户手快把哪边关掉了：什么都不做，别去动一个不存在的标签
      if (!st.tabs.some((t) => t.id === target.id)) return
      if (!st.tabs.some((t) => t.id === source.id)) return

      if (clones.every((c) => st.livePanes[c.id])) {
        // 新通道已经在会话上了，现在收源标签是安全的
        st.closeTab(source.id)
        return
      }
      if (Date.now() >= deadline) {
        const cloneIds = new Set(clones.map((c) => c.id))
        set((cur) => ({
          tabs: cur.tabs.map((t) =>
            t.id === target.id
              ? { ...t, panes: panesOf(t).filter((p) => !cloneIds.has(p.id)) }
              : t,
          ),
        }))
        get().setError(`没能在这台机器上再开一条 shell —— 「${source.title}」还留着`)
        return
      }
      setTimeout(settle, 60)
    }
    setTimeout(settle, 60)
  },

  paneHostTarget: null,
  setPaneHostTarget: (target) => set({ paneHostTarget: target }),
  connectPaneTarget: null,
  setConnectPaneTarget: (target) => set({ connectPaneTarget: target }),

  // 分组的取名/改名放 store 而不是组件里：会话树和命令面板都要用，
  // 而且都得走自绘输入弹窗（window.prompt 在打包版里是原生框，观感对不上）
  promptNewGroup: () =>
    set({
      confirmPrompt: {
        kind: 'input',
        title: '新建分组',
        label: '分组名称',
        confirmLabel: '创建',
        onConfirm: (value) => {
          const name = value.trim()
          if (!name) return
          void get().saveGroup({ id: crypto.randomUUID(), name })
        },
      },
    }),

  promptRenameGroup: (id, oldName) =>
    set({
      confirmPrompt: {
        kind: 'input',
        title: '重命名分组',
        label: '分组名称',
        defaultValue: oldName,
        confirmLabel: '保存',
        onConfirm: (value) => {
          const name = value.trim()
          if (!name || name === oldName) return
          void get().saveGroup({ id, name })
        },
      },
    }),

  openLocalFileDialog: async () => {
    if (!isDesktop()) {
      // 浏览器预览里没有原生文件选择框。明说一句，别让点了没反应
      set({ error: '文件选择只在桌面版可用' })
      return
    }
    const path = await pickFile('打开文件')
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    get().addTab({
      title: name,
      kind: 'editor',
      editorTarget: { side: 'local', path, sftpId: null },
    })
  },

  // 带宽度：老用户左右分割线的位置从旧 splitRatio / splitRatioY 键迁过来，不丢
  splitColBands: (() => {
    const stored = readBands('splitColBands')
    return stored[2] ? stored : { ...stored, 2: [readRatio('splitRatio')] }
  })(),
  splitRowBands: (() => {
    const stored = readBands('splitRowBands')
    return stored[2] ? stored : { ...stored, 2: [readRatio('splitRatioY')] }
  })(),
  setSplitColBands: (bands, widths) => {
    const next = { ...get().splitColBands, [bands]: widths }
    writeBands('splitColBands', next)
    set({ splitColBands: next })
  },
  setSplitRowBands: (bands, widths) => {
    const next = { ...get().splitRowBands, [bands]: widths }
    writeBands('splitRowBands', next)
    set({ splitRowBands: next })
  },


  termFontSize: (() => {
    try {
      const n = Number(localStorage.getItem('termFontSize'))
      return Number.isFinite(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE ? n : DEFAULT_FONT_SIZE
    } catch {
      return DEFAULT_FONT_SIZE
    }
  })(),
  setTermFontSize: (size) => {
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
    writeLocal('termFontSize', String(clamped))
    set({ termFontSize: clamped })
  },
  bumpTermFontSize: (delta) => get().setTermFontSize(get().termFontSize + delta),

  termFontFamily: (() => {
    try {
      return localStorage.getItem('termFontFamily') ?? ''
    } catch {
      return ''
    }
  })(),
  setTermFontFamily: (family) => {
    writeLocal('termFontFamily', family)
    set({ termFontFamily: family })
  },

  termLineHeight: readNumber('termLineHeight', 1.5, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT),
  setTermLineHeight: (lineHeight) => {
    const clamped = Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, lineHeight))
    writeLocal('termLineHeight', String(clamped))
    set({ termLineHeight: clamped })
  },

  termCursorStyle: (() => {
    try {
      const v = localStorage.getItem('termCursorStyle')
      return v === 'block' || v === 'underline' || v === 'bar' ? (v as CursorStyle) : 'bar'
    } catch {
      return 'bar' as CursorStyle
    }
  })(),
  setTermCursorStyle: (style) => {
    writeLocal('termCursorStyle', style)
    set({ termCursorStyle: style })
  },

  termScrollback: readNumber('termScrollback', 5000, MIN_SCROLLBACK, MAX_SCROLLBACK),
  setTermScrollback: (lines) => {
    const clamped = Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(lines)))
    writeLocal('termScrollback', String(clamped))
    set({ termScrollback: clamped })
  },

  customSchemes: initialCustomSchemes,
  saveCustomScheme: (scheme) => {
    const list = get().customSchemes
    // 新方案追加在后面，改已有的就地替换 —— 列表顺序就是设置面板里的顺序
    const next = list.some((s) => s.id === scheme.id)
      ? list.map((s) => (s.id === scheme.id ? scheme : s))
      : [...list, scheme]
    writeCustomSchemes(next)
    set({ customSchemes: next })
  },
  deleteCustomScheme: (id) => {
    const next = get().customSchemes.filter((s) => s.id !== id)
    writeCustomSchemes(next)
    set({ customSchemes: next })
    // 删的正好是当前这套就退回应用默认，不然终端会去查一个已经不存在的方案
    if (get().termScheme === id) get().setTermScheme(APP_SCHEME_ID)
  },

  termScheme: (() => {
    try {
      const v = localStorage.getItem('termScheme')
      // 只认当前确实存在的方案：自定义方案被删、localStorage 被手改过都不算数
      return v && isKnownSchemeId(v, initialCustomSchemes) ? v : APP_SCHEME_ID
    } catch {
      return APP_SCHEME_ID
    }
  })(),
  setTermScheme: (id) => {
    const next = isKnownSchemeId(id, get().customSchemes) ? id : APP_SCHEME_ID
    writeLocal('termScheme', next)
    set({ termScheme: next })
  },

  reconnectAttempts: readNumber(
    'reconnectAttempts',
    3,
    MIN_RETRY_ATTEMPTS,
    MAX_RETRY_ATTEMPTS,
  ),
  setReconnectAttempts: (times) => {
    const clamped = Math.min(MAX_RETRY_ATTEMPTS, Math.max(MIN_RETRY_ATTEMPTS, Math.round(times)))
    writeLocal('reconnectAttempts', String(clamped))
    set({ reconnectAttempts: clamped })
  },
  reconnectDelaySec: readNumber('reconnectDelaySec', 2, MIN_RETRY_DELAY, MAX_RETRY_DELAY),
  setReconnectDelaySec: (seconds) => {
    const clamped = Math.min(MAX_RETRY_DELAY, Math.max(MIN_RETRY_DELAY, seconds))
    writeLocal('reconnectDelaySec', String(clamped))
    set({ reconnectDelaySec: clamped })
  },

  transferResumeDefault: (() => {
    try {
      return localStorage.getItem('transferResumeDefault') !== '0'
    } catch {
      return true
    }
  })(),
  setTransferResumeDefault: (on) => {
    writeLocal('transferResumeDefault', on ? '1' : '0')
    set({ transferResumeDefault: on })
  },

  resetSettings: () => {
    get().setTheme('dark')
    // 自定义配色方案本身不删：那是用户自己造的东西，不是「设置」
    get().setTermScheme(APP_SCHEME_ID)
    get().setTermFontSize(DEFAULT_FONT_SIZE)
    get().setTermFontFamily('')
    get().setTermLineHeight(1.5)
    get().setTermCursorStyle('bar')
    get().setTermScrollback(5000)
    get().setReconnectAttempts(3)
    get().setReconnectDelaySec(2)
    get().setTransferResumeDefault(true)
  },

  terminalSinks: {},
  registerTerminalSink: (paneId, sink) =>
    set((s) => ({ terminalSinks: { ...s.terminalSinks, [paneId]: sink } })),
  unregisterTerminalSink: (paneId) =>
    set((s) => {
      const next = { ...s.terminalSinks }
      delete next[paneId]
      return { terminalSinks: next }
    }),

  reconnectSinks: {},
  registerReconnect: (paneId, fn) =>
    set((s) => ({ reconnectSinks: { ...s.reconnectSinks, [paneId]: fn } })),
  unregisterReconnect: (paneId) =>
    set((s) => {
      if (!s.reconnectSinks[paneId]) return {}
      const next = { ...s.reconnectSinks }
      delete next[paneId]
      return { reconnectSinks: next }
    }),

  deadPanes: {},
  setPaneDead: (paneId, dead) =>
    set((s) => {
      // 没变化就别造新对象，省得白触发一轮重渲染
      if (!!s.deadPanes[paneId] === dead) return s
      const next = { ...s.deadPanes }
      if (dead) next[paneId] = true
      else delete next[paneId]
      return { deadPanes: next }
    }),

  transfers: [],

  runTransfer: async (direction, name, run) => {
    const id = `xfer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const patch = (p: Partial<TransferItem>) =>
      set((s) => ({
        transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...p } : t)),
      }))

    set((s) => ({
      transfers: [
        {
          id,
          direction,
          name,
          transferred: 0,
          total: 0,
          status: 'active' as TransferStatus,
          skipped: 0,
        },
        ...s.transfers,
      ].slice(0, 50),
    }))

    const onProgress = new Channel<TransferEvent>()
    onProgress.onmessage = (event) => {
      if (event.type === 'progress') {
        patch({ transferred: event.transferred, total: event.total })
      } else if (event.type === 'done') {
        patch({ transferred: event.transferred, status: 'done' })
      } else if (event.type === 'skip') {
        // 跳过不是失败：只累计，不改状态。落到下面的 else 会被标成错误
        set((s) => ({
          transfers: s.transfers.map((t) =>
            t.id === id
              ? { ...t, skipped: t.skipped + 1, skipHint: `${event.name}（${event.reason}）` }
              : t,
          ),
        }))
      } else {
        patch({ status: 'error', message: event.message })
        get().setError(event.message)
      }
    }

    try {
      await run(onProgress)
      return true
    } catch (e) {
      const message = String(e)
      patch({ status: 'error', message })
      get().setError(message)
      return false
    }
  },

  clearFinished: () =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.status === 'active') })),
}))

// 持久化的主题要在首帧之前落到 documentElement 上：
// 放在组件 effect 里的话，浅色用户每次启动都会先闪一下深色。
// 窗口主题也一并定下来，否则会先看到系统主题的标题栏再跳成应用主题的
applyTheme(useApp.getState().theme)
