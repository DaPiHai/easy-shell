/**
 * 分屏形状的数学。
 *
 * 独立成模块（不 import store / api / 浏览器 API）是为了能离线跑校验：
 * `tools/check-layout.mjs` 用 esbuild 把它转出来，穷举「形状 × 格 × 落点」的所有组合，
 * 断言算出来的格子表**无洞、无重叠、每个位置恰好被一格盖住**。
 * 这套东西只看代码推演不可靠 —— 它是纯整数运算，最适合穷举验证。
 *
 * 数据模型：`cols × rows` 的网格，每格记 (c, r) 从 1 开始，`cs` / `rs` 是跨列 / 跨行数。
 * 列宽行高不是每格自带的，而是**按带数存一份全局比例**（`splitColBands` / `splitRowBands`）——
 * 所以任意排布只要落在同一个网格上，比例就能复用，分割线也只需要挪带边界。
 */

/** 一个格子在网格里的位置：c / r 从 1 开始，cs / rs 是跨列 / 跨行数（默认 1） */
export interface CellSpec {
  c: number
  r: number
  cs?: number
  rs?: number
}

export interface LayoutSpec {
  /** 菜单 / tooltip 里显示的名字 */
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
 * 所以形状是**每个标签自己的选择**（`Tab.layout`）；拖拽切出来的排布如果对不上任何预设，
 * 就作为**自定义格子表**存在 `Tab.layoutSpec` 里（见 `splitPlan`）。
 *
 * 格子数必须跟 `Tab.panes` 一样长：换形状时少则补格、多则收格，都在 `setPaneLayout` 里做。
 */
/**
 * 一屏最多几格。
 *
 * 不是随手定的上限：格子再多，每格都会小于 `PaneGrid` 的最小边长（120px），
 * 1080p 上四宫格已经是看得清的下限。附带的好处是"形状 × 格 × 落点"的组合数
 * 停在能穷举的范围里（见 `tools/check-layout.mjs`）。
 */
export const MAX_PANES = 4

/** 对不上任何预设的排布用这个名字（菜单里没有它，标签栏的提示直接写它） */
const CUSTOM_LABEL = '自定义排布'

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
 * 每种格数回落到哪个形状。
 *
 * 收格时优先用 `pruneSpec` 算"邻居长过来"的结果；算不出来（比如关掉的是「左一右二」
 * 右上那格，填不上）才按格数取这个默认值。
 */
export const DEFAULT_LAYOUT_BY_COUNT: Record<number, PaneLayout> = {
  1: 'single',
  2: 'cols2',
  3: 'top2Bottom1',
  4: 'grid4',
}

/** 格数变了之后该用哪个形状：当前形状的格子数对得上就留着，对不上回落默认 */
export function layoutForCount(count: number, current: PaneLayout | undefined): PaneLayout {
  if (current && PANE_LAYOUTS[current].cells.length === count) return current
  return DEFAULT_LAYOUT_BY_COUNT[count] ?? 'single'
}

/* ---------------- 格子表的基本操作 ---------------- */

function span(x: CellSpec): { cs: number; rs: number } {
  return { cs: x.cs ?? 1, rs: x.rs ?? 1 }
}

/** 这一格占不占（列带 col、行带 row）这个位置。带都从 0 起算 */
export function covers(cell: CellSpec, col: number, row: number): boolean {
  const { cs, rs } = span(cell)
  return col >= cell.c - 1 && col < cell.c - 1 + cs && row >= cell.r - 1 && row < cell.r - 1 + rs
}

/** 盖住（列带 col、行带 row）的那一格。合法排布里恰好一个 */
function cellAt(cells: CellSpec[], col: number, row: number): number {
  return cells.findIndex((x) => covers(x, col, row))
}

/** 有重叠吗（同一位置被两格盖住） */
function hasOverlap(cells: CellSpec[]): boolean {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i]
      const b = cells[j]
      const { cs: acs, rs: ars } = span(a)
      const { cs: bcs, rs: brs } = span(b)
      const overlap =
        a.c < b.c + bcs && b.c < a.c + acs && a.r < b.r + brs && b.r < a.r + ars
      if (overlap) return true
    }
  }
  return false
}

/** 第一个没人盖的位置（都盖满了返回 null） */
function firstHole(cells: CellSpec[], cols: number, rows: number) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cellAt(cells, c, r) < 0) return { c, r }
    }
  }
  return null
}

/**
 * 规范化：所有格子都横跨满整幅的行（或列）时，把那一维收掉。
 *
 * 没有它，每次切一刀都会多出一层"没人用到的带"：比如「左一右二」关掉右上角，
 * 算出来的是 2 列 2 行、两格都 `rs:2` —— 长得跟「左右二分」一模一样，却对不上预设，
 * 于是布局菜单里一项都不打勾、还得按自定义排布伺候。收掉之后就对上了。
 */
function normalize(spec: LayoutSpec): LayoutSpec {
  let cols = spec.cols
  let rows = spec.rows
  let cells = spec.cells.map((x) => ({ ...x }))
  if (rows > 1 && cells.length > 0 && cells.every((x) => span(x).rs === rows)) {
    cells = cells.map((x) => ({ ...x, r: 1, rs: undefined }))
    rows = 1
  }
  if (cols > 1 && cells.length > 0 && cells.every((x) => span(x).cs === cols)) {
    cells = cells.map((x) => ({ ...x, c: 1, cs: undefined }))
    cols = 1
  }
  return { ...spec, cols, rows, cells }
}

/**
 * 排布合法吗：每格都在网格内、彼此不重叠、**每个位置恰好被盖一次**（无洞、无重叠）。
 *
 * 返回错误说明（合法时返回 null）。`tools/check-layout.mjs` 拿它穷举所有组合；
 * 生产代码里也算一次兜底 —— 万一某条路径算歪了，退回预设也比把畸形排布喂给界面强。
 */
export function validateSpec(spec: LayoutSpec): string | null {
  const { cols, rows, cells } = spec
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    return `网格尺寸不合法：${cols}×${rows}`
  }
  for (let i = 0; i < cells.length; i++) {
    const { cs, rs } = span(cells[i])
    const x = cells[i]
    if (cs < 1 || rs < 1 || !Number.isInteger(x.c) || !Number.isInteger(x.r)) {
      return `第 ${i + 1} 格的跨度不合法`
    }
    if (x.c < 1 || x.r < 1 || x.c - 1 + cs > cols || x.r - 1 + rs > rows) {
      return `第 ${i + 1} 格超出了 ${cols}×${rows} 的网格`
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const owners = cells.filter((x) => covers(x, c, r)).length
      if (owners === 0) return `位置 (${c + 1}, ${r + 1}) 没有任何格子`
      if (owners > 1) return `位置 (${c + 1}, ${r + 1}) 被 ${owners} 格重复覆盖`
    }
  }
  return null
}

/** 这张格子表跟哪个预设一模一样（名字不算），没有就 null */
export function matchPreset(spec: LayoutSpec): PaneLayout | null {
  const key = LAYOUT_ORDER.find((k) => {
    const p = PANE_LAYOUTS[k]
    if (p.cols !== spec.cols || p.rows !== spec.rows) return false
    if (p.cells.length !== spec.cells.length) return false
    return p.cells.every((c, i) => {
      const x = spec.cells[i]
      return c.c === x.c && c.r === x.r && (c.cs ?? 1) === (x.cs ?? 1) && (c.rs ?? 1) === (x.rs ?? 1)
    })
  })
  return key ?? null
}

/* ---------------- 切开一格（拖拽并进来的落点） ---------------- */

/** 落点在某一格的哪一侧 */
export type DropSide = 'left' | 'right' | 'top' | 'bottom'

export interface GrowResult {
  /** 切开之后这一屏该怎么摆 */
  spec: LayoutSpec
  /** 新格的起始下标：新格占住 `panes[insertAt .. insertAt + n)`，其余格子顺移 */
  insertAt: number
  /** 能对上某个预设就给 key，否则 null —— 这时用上面的自定义格子表 */
  preset: PaneLayout | null
}

/**
 * 把某一格沿落点方向切开一刀，算出切开之后的整张格子表。
 *
 * 这是拖拽并分屏的**唯一**算法：高亮画在哪儿、松手落成什么样，都由它一份结果决定 ——
 * 以前落点高亮按"半格"算、形状却交给"下一档预设"（`GROWN_LAYOUT`）决定，于是
 * 「亮在右格后半边、新格子却出现在它左边」这种对不上的事就来了。
 *
 * 两种切法：
 * - 这一格只占一列（一行）→ **插一整列（行）进去**，其余格子顺移。这就是
 *   "左右二分再左右二分"；
 * - 这一格本来就跨了多列（多行）→ 一分为二（比如「上一下二」上面那一整条）。
 *
 * 算不出（跨度是奇数、或结果不合法）返回 null，调用方退回按格数取默认形状。
 */
export function splitPlan(spec: LayoutSpec, cellIndex: number, side: DropSide): GrowResult | null {
  return splitPlanN(spec, cellIndex, side, 1)
}

/**
 * 沿同一侧**连切 n 刀**：一次并进 n 格（拖一个分屏窗口进来）时用。
 *
 * 每一刀都切"上一刀刚切出来的那一格"，于是 n 个新格紧挨着排在落点那一侧，
 * 拉出来的形状和"连着拖 n 次"完全一致 —— 不再是"形状按家族长一档"的猜测
 * （那时「两格并进单格窗口」会莫名变成「上二下一」）。
 *
 * 块内位置只由 `insertAt` 与 n 决定：n 个新格在网格上是几何完全相同的一串，
 * 所以调用方按源标签的顺序往这个位置插就行，不用关心哪一刀切的是哪一个。
 *
 * 落点在窗口空白处（没命中格子）不该调它 —— 那种情况退回按家族长一档。
 */
export function splitPlanN(
  spec: LayoutSpec,
  cellIndex: number,
  side: DropSide,
  n: number,
): GrowResult | null {
  if (!Number.isInteger(n) || n < 1) return null
  let cur = spec
  let anchor = cellIndex
  let insertAt = -1
  for (let k = 0; k < n; k++) {
    const one = splitOnce(cur, anchor, side)
    if (!one) return null
    if (k === 0) insertAt = one.insertAt
    cur = one.spec
    // 下一刀切刚切出来的那一格：同侧再切一刀，新格紧挨着上一刀排下去
    anchor = one.insertAt
  }
  return { spec: cur, insertAt, preset: matchPreset(cur) }
}

/** 一刀：切开一格，返回新表与新格的落点 */
function splitOnce(
  spec: LayoutSpec,
  cellIndex: number,
  side: DropSide,
): { spec: LayoutSpec; insertAt: number } | null {
  const cell = spec.cells[cellIndex]
  if (!cell) return null
  // 落点在左右 → 竖着一刀（插一列）；上下 → 横着一刀（插一行）
  const before = side === 'left' || side === 'top'
  const grown =
    side === 'left' || side === 'right'
      ? splitAlongCol(spec, cellIndex, cell, before)
      : splitAlongRow(spec, cellIndex, cell, before)
  if (!grown) return null

  const norm = normalize({ label: CUSTOM_LABEL, ...grown })
  // 数学上不该算错，真错了就别把畸形排布喂给界面
  if (validateSpec(norm)) return null
  // 新格的下标只看"切之前那一格"的位置：插在它前还是后（收掉多余带不影响顺序）
  return { spec: norm, insertAt: before ? cellIndex : cellIndex + 1 }
}

/** 往左/右切：插一整列，或者把跨列的那一格一分为二 */
function splitAlongCol(
  spec: LayoutSpec,
  cellIndex: number,
  cell: CellSpec,
  before: boolean,
): { cols: number; rows: number; cells: CellSpec[] } | null {
  const cells0 = spec.cells
  const { cs } = span(cell)
  if (cs > 1) {
    if (cs % 2 !== 0) return null
    const half = cs / 2
    const left: CellSpec = { c: cell.c, r: cell.r, cs: half > 1 ? half : undefined, rs: cell.rs }
    const right: CellSpec = {
      c: cell.c + half,
      r: cell.r,
      cs: half > 1 ? half : undefined,
      rs: cell.rs,
    }
    // 位置顺序永远是 [左, 右]：新格落在哪一半由 insertAt 决定（见 splitPlan）
    const cells = [...cells0]
    cells.splice(cellIndex, 1, left, right)
    return { cols: spec.cols, rows: spec.rows, cells }
  }
  const fresh: CellSpec = { c: before ? cell.c : cell.c + 1, r: cell.r, rs: cell.rs }
  const kept: CellSpec = before ? { ...cell, c: cell.c + 1 } : { ...cell }
  const cells = reflow(spec.cells, cellIndex, fresh, kept, before, 'col')
  return { cols: spec.cols + 1, rows: spec.rows, cells }
}

/** 上下切：与 `splitAlongCol` 完全对称 */
function splitAlongRow(
  spec: LayoutSpec,
  cellIndex: number,
  cell: CellSpec,
  before: boolean,
): { cols: number; rows: number; cells: CellSpec[] } | null {
  const cells0 = spec.cells
  const { rs } = span(cell)
  if (rs > 1) {
    if (rs % 2 !== 0) return null
    const half = rs / 2
    const top: CellSpec = { c: cell.c, r: cell.r, cs: cell.cs, rs: half > 1 ? half : undefined }
    const bottom: CellSpec = {
      c: cell.c,
      r: cell.r + half,
      cs: cell.cs,
      rs: half > 1 ? half : undefined,
    }
    const cells = [...cells0]
    cells.splice(cellIndex, 1, top, bottom)
    return { cols: spec.cols, rows: spec.rows, cells }
  }
  const fresh: CellSpec = { c: cell.c, r: before ? cell.r : cell.r + 1, cs: cell.cs }
  const kept: CellSpec = before ? { ...cell, r: cell.r + 1 } : { ...cell }
  const cells = reflow(spec.cells, cellIndex, fresh, kept, before, 'row')
  return { cols: spec.cols, rows: spec.rows + 1, cells }
}

/**
 * 插了一条带之后，其余格子怎么挪。
 *
 * 只有三种情况，但**第二种最容易写错**：
 * 1. 整格在被切那一带**之前** → 一动不动；
 * 2. **盖住了**被切那一带（跨行的那一格、或同一带里另一行的格子）→ 跟着长一格。
 *    少写这一条就会在新带上留个洞 —— 于是"左右二分里把左格上下切"被算成"右格往下挪",
 *    网格右下角空着，整刀作废（校验脚本就是这么抓出来的）；
 * 3. 整格在被切那一带**之后** → 往后挪一格。
 */
function reflow(
  cells0: CellSpec[],
  cellIndex: number,
  fresh: CellSpec,
  kept: CellSpec,
  before: boolean,
  axis: 'col' | 'row',
): CellSpec[] {
  const target = cells0[cellIndex]
  const band = (axis === 'col' ? target.c : target.r) - 1
  const out: CellSpec[] = []
  cells0.forEach((x, i) => {
    if (i === cellIndex) {
      out.push(...(before ? [fresh, kept] : [kept, fresh]))
      return
    }
    const s = (axis === 'col' ? x.c : x.r) - 1
    const w = span(x)[axis === 'col' ? 'cs' : 'rs']
    if (s <= band && s + w - 1 >= band) {
      out.push(axis === 'col' ? { ...x, cs: w + 1 } : { ...x, rs: w + 1 })
    } else if (s > band) {
      out.push(axis === 'col' ? { ...x, c: x.c + 1 } : { ...x, r: x.r + 1 })
    } else {
      out.push({ ...x })
    }
  })
  return out
}

/* ---------------- 收掉一格 ---------------- */

/**
 * 收掉一格之后剩下的那张表。
 *
 * 不是简单删掉一项：删完会出现"洞"（原来被这一格占着的位置没人盖）。所以先去掉
 * 空掉的列 / 行，再让邻居**长过来**填洞 —— 只有整块要占的地方都没主才让长，
 * 否则会吃掉邻居。填不上就返回 null，调用方退回按格数取默认形状。
 *
 * 例：四宫格去掉右下角 → 左下那格往右长成「上二下一」，与"关掉的是右下角"对得上。
 */
export function pruneSpec(spec: LayoutSpec, removeIndex: number): LayoutSpec | null {
  if (!spec.cells[removeIndex]) return null
  let cells = spec.cells.filter((_, i) => i !== removeIndex).map((x) => ({ ...x }))
  let cols = spec.cols
  let rows = spec.rows
  if (cells.length === 0) return null

  // 去掉没人用的列 / 行（一轮一条，去干净为止）
  for (let guard = 0; guard < cols + rows + 2; guard++) {
    let changed = false
    for (let c = 0; c < cols; c++) {
      if (cells.some((x) => c >= x.c - 1 && c < x.c - 1 + span(x).cs)) continue
      cells = cells.map((x) => (x.c - 1 >= c ? { ...x, c: x.c - 1 } : x))
      cols -= 1
      changed = true
      break
    }
    if (changed) continue
    for (let r = 0; r < rows; r++) {
      if (cells.some((x) => r >= x.r - 1 && r < x.r - 1 + span(x).rs)) continue
      cells = cells.map((x) => (x.r - 1 >= r ? { ...x, r: x.r - 1 } : x))
      rows -= 1
      changed = true
      break
    }
    if (!changed) break
  }

  for (let guard = 0; guard < cols * rows + 4; guard++) {
    const hole = firstHole(cells, cols, rows)
    if (!hole) {
      const norm = normalize({ label: CUSTOM_LABEL, cols, rows, cells })
      return validateSpec(norm) ? null : norm
    }
    if (!fillHole(cells, hole.c, hole.r)) return null
  }
  return null
}

/**
 * 让某一格长过去盖住 (col, row)。
 *
 * 方向优先级是 **右 → 左 → 下 → 上**，按观感定的：四宫格关掉右下角时希望左下那格
 * 往右长（变成"上面两格、下面一整条"），而不是右上那格往下长（变成"左边一整列"）——
 * 两种都合法，但前者跟"关掉的是右下角"这件事更对得上，也是改造前就有的行为。
 */
function fillHole(cells: CellSpec[], col: number, row: number): boolean {
  const dirs: Array<{
    match: (x: CellSpec) => boolean
    grow: (x: CellSpec) => CellSpec
    /** 长过去要新占的位置，全都没主才允许 */
    area: (x: CellSpec) => Array<[number, number]>
  }> = [
    {
      // 往右长：这一格在洞的正左边
      match: (x) => {
        const { rs } = span(x)
        return x.c - 1 + span(x).cs === col && row >= x.r - 1 && row < x.r - 1 + rs
      },
      grow: (x) => ({ ...x, cs: span(x).cs + 1 }),
      area: (x) => {
        const { rs } = span(x)
        const out: Array<[number, number]> = []
        for (let r = x.r - 1; r < x.r - 1 + rs; r++) out.push([col, r])
        return out
      },
    },
    {
      // 往左长
      match: (x) => {
        const { rs } = span(x)
        return x.c - 1 === col + 1 && row >= x.r - 1 && row < x.r - 1 + rs
      },
      grow: (x) => ({ ...x, c: x.c - 1, cs: span(x).cs + 1 }),
      area: (x) => {
        const { rs } = span(x)
        const out: Array<[number, number]> = []
        for (let r = x.r - 1; r < x.r - 1 + rs; r++) out.push([col, r])
        return out
      },
    },
    {
      // 往下长：这一格在洞的正上方
      match: (x) => {
        const { cs, rs } = span(x)
        return col >= x.c - 1 && col < x.c - 1 + cs && x.r - 1 + rs === row
      },
      grow: (x) => ({ ...x, rs: span(x).rs + 1 }),
      area: (x) => {
        const { cs } = span(x)
        const out: Array<[number, number]> = []
        for (let c = x.c - 1; c < x.c - 1 + cs; c++) out.push([c, row])
        return out
      },
    },
    {
      // 往上长
      match: (x) => {
        const { cs } = span(x)
        return col >= x.c - 1 && col < x.c - 1 + cs && x.r - 1 === row + 1
      },
      grow: (x) => ({ ...x, r: x.r - 1, rs: span(x).rs + 1 }),
      area: (x) => {
        const { cs } = span(x)
        const out: Array<[number, number]> = []
        for (let c = x.c - 1; c < x.c - 1 + cs; c++) out.push([c, row])
        return out
      },
    },
  ]

  for (const dir of dirs) {
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i]
      if (!dir.match(x)) continue
      const taken = dir.area(x).some(([c, r]) => {
        const owner = cellAt(cells, c, r)
        return owner >= 0 && owner !== i
      })
      if (taken) continue
      const next = cells.map((y, j) => (j === i ? dir.grow(y) : y))
      if (hasOverlap(next)) continue
      cells[i] = dir.grow(x)
      return true
    }
  }
  return false
}

/* ---------------- 分割线 ---------------- */

/** 一条可拖的分割线（与 PaneGrid 的渲染一一对应） */
export interface Divider {
  axis: 'col' | 'row'
  /** 它在轴上的位置（前若干带宽度之和，0–1） */
  at: number
  /** 它在**另一条轴**上的跨度（0–1）：短线只画在真正分界的那一段 */
  from: number
  to: number
  /** 它分开的是哪两带：拖动时改的就是这两带的宽度 */
  band: number
}

const cum = (w: number[], upto: number) => w.slice(0, upto).reduce((a, b) => a + b, 0)

/**
 * 这张排布有哪些可拖的分割线。
 *
 * 从格子表算，不再一张张形状写死（以前是 16 个 case 的 switch，自定义排布一出来
 * 那套就没法覆盖了）。判定很简单：那条边界在**这一行（列）**上没有格子横跨过去，
 * 就是可拖的一段；几段连着就合并成一条线。
 */
export function dividersOfSpec(spec: LayoutSpec, colW: number[], rowW: number[]): Divider[] {
  const out: Divider[] = []
  const cells = spec.cells
  const draggableCol = (band: number, row: number) => {
    if (band < 0 || band + 1 >= spec.cols) return false
    const i = cellAt(cells, band, row)
    if (i < 0) return false
    const x = cells[i]
    // 这一格的最右列正好是 band → 它没过界，这一段就能拖
    return x.c - 1 + span(x).cs - 1 === band
  }
  const draggableRow = (band: number, col: number) => {
    if (band < 0 || band + 1 >= spec.rows) return false
    const i = cellAt(cells, col, band)
    if (i < 0) return false
    const x = cells[i]
    return x.r - 1 + span(x).rs - 1 === band
  }

  for (let band = 0; band < spec.cols - 1; band++) {
    let start = -1
    for (let row = 0; row <= spec.rows; row++) {
      const ok = row < spec.rows && draggableCol(band, row)
      if (ok && start < 0) start = row
      if (!ok && start >= 0) {
        out.push({
          axis: 'col',
          band,
          at: cum(colW, band + 1),
          from: cum(rowW, start),
          to: cum(rowW, row),
        })
        start = -1
      }
    }
  }
  for (let band = 0; band < spec.rows - 1; band++) {
    let start = -1
    for (let col = 0; col <= spec.cols; col++) {
      const ok = col < spec.cols && draggableRow(band, col)
      if (ok && start < 0) start = col
      if (!ok && start >= 0) {
        out.push({
          axis: 'row',
          band,
          at: cum(rowW, band + 1),
          from: cum(colW, start),
          to: cum(colW, col),
        })
        start = -1
      }
    }
  }
  return out
}
