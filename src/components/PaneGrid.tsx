import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Pencil, RotateCw, Terminal, X } from 'lucide-react'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'
import { copyQuietly } from '@/lib/clipboard'
import {
  acceptsPanes,
  bandWidths,
  dividersOfSpec,
  MAX_PANES,
  panesOf,
  specOf,
  splitPlanN,
  useApp,
  type Divider,
  type DropSide,
  type LayoutSpec,
  type Pane,
} from '@/lib/store'

/** 拖拽判定阈值：手抖点一下不该被当成拖动 */
const DRAG_THRESHOLD = 5
/** 分割线离两端的最近距离，别让某一格被拖到看不见 */
const MIN_PANE = 120

/** 投放高亮覆盖层的形状：新格子会长在哪一块，就点亮哪一块 */
const ZONE_CLASS: Record<DropZone, string> = {
  full: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
}

/** 拖标签落到本窗口时的结果：能并 / 拖到了自己身上 / 满了 / 放不下 / 有一边不是终端 */
type TabDropState = 'ok' | 'self' | 'full' | 'tight' | 'notTerminal'

/** 新格子会落在哪一块。单格窗口落上半就是上半，不是"整个窗口" */
type DropZone = 'full' | 'left' | 'right' | 'top' | 'bottom'

/**
 * 这一轮"拖标签来找地方拼"的落点。
 *
 * **写在模块级而不是组件的 ref 里** —— 这是踩过一次的地方：拖动时 TabBar 的
 * mouseup 会先把 store 里的 `draggingTabId` 清成 null，React 随即重渲染并跑
 * PaneGrid 的 effect，那个 effect 会把组件 ref 一并清掉；等 PaneGrid 自己的
 * mouseup 处理函数轮到执行时，ref 已经是 null 了 —— 表现就是"浮签都对、松手
 * 什么都没发生"。放在模块级就没人会顺手清它，谁写谁消费。
 *
 * 同一时刻只可能有一个目标窗口在写，所以单例够用；多写一个 `targetTabId`
 * 是为了让别的 PaneGrid 收到同一个 mouseup 时知道"这不是我的落点"。
 */
let pendingTabDrop: {
  targetTabId: string
  sourceTabId: string
  insertAt: number
  /** 切开落点那一格之后这一屏的格子表（`splitPlanN` 给的）；没命中格子或算不出就是 null */
  spec: LayoutSpec | null
} | null = null

/** 拒绝时的浮签文案（能并的时候文案跟着落点走，见 onMove） */
const TAB_DROP_TEXT: Record<TabDropState, string> = {
  ok: '',
  self: '这是它自己的窗口 —— 拖到别的终端窗口里才能并',
  full: `并不下来：这个窗口已经 ${MAX_PANES} 格了`,
  tight: '并不下来：这个窗口剩下的格子放不下它',
  notTerminal: '并不下来：文件面板和编辑器里没有格子',
}



interface Props {
  tabId: string
  /** 1–4 个格子，**顺序就是视觉顺序**（见 store 的 `Tab.panes`） */
  panes: Pane[]
  /**
   * 这一屏摆成什么形状 —— **真格子表**，不是形状的名字（见 store 的 `specOf`）。
   *
   * 拖拽切出来的排布有一大半对不上任何预设（三列里某一列上下分、两列再切一列…），
   * 那些排布只存在 `Tab.layoutSpec` 里。传名字的话它们根本画不出来，所以这里要的是表。
   */
  spec: LayoutSpec
  /** 渲染某一格的终端。PaneGrid 只管摆位，不关心里面是什么 */
  renderPane: (pane: Pane) => React.ReactNode
}

/**
 * 终端标签的分屏布局。
 *
 * 三条不能破的约束：
 *
 * 1. **常驻，不随格子数换结构**。1 格和 4 格共用同一套 DOM 形状（永远是一个 grid，
 *    每格永远是一个 PaneFrame，标题条只藏在 `hidden` 里）—— 结构一变，React 就会把
 *    已经连上的终端拆掉重建，重连一次、滚动历史全丢。这就是改造前 SplitPane 宁可
 *    常驻一个"关了分屏的空壳"的原因，这里把同样的克制用在格子数上。
 * 2. **分隔条用绝对定位压在格子上**，不占布局。`.grid` 的子项位置由列宽比例算出，
 *    再插一个真占位的分隔条就得额外算一条，容易跟比例对不上。
 *    `inset-x-0` / `inset-y-0` 两头钉死是必须的：只写 `w-full` 时绝对定位元素的
 *    left 取的是包含块**内容盒**起点，跟宽度算的 padding 盒对不上（标签高亮线踩过）。
 * 3. **拖拽只用鼠标事件**。`tauri.conf.json` 开着 `dragDropEnabled: true`，
 *    wry 装的 IDropTarget 会让内部 HTML5 拖拽在 Windows 上整体失效 —— 同一套
 *    手法在 SftpPanel 的双栏拖拽上已经跑通，这里照搬。
 */
export function PaneGrid({ tabId, panes, spec, renderPane }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** 每一格的 DOM，拖拽换位时做命中测试用 */
  const cellsRef = useRef(new Map<string, HTMLDivElement>())

  const focusedPaneId = useApp((s) => s.focusedPane[tabId])
  const splitColBands = useApp((s) => s.splitColBands)
  const splitRowBands = useApp((s) => s.splitRowBands)

  const count = panes.length
  // 单格不显示标题条（保持现在的干净外观），但**位置留着**，用 hidden 藏 —— 理由见文件头第 1 条
  const showTitle = count > 1
  const activeId = focusedPaneId && panes.some((p) => p.id === focusedPaneId) ? focusedPaneId : panes[0]?.id

  /** 这一形状的列宽 / 行高（各带数一份，没拖过就等分） */
  const colWidths = bandWidths(splitColBands, spec.cols)
  const rowWidths = bandWidths(splitRowBands, spec.rows)
  const gridColumns = colWidths.map((w) => `${w}fr`).join(' ')
  const gridRows = rowWidths.map((w) => `${w}fr`).join(' ')
  // 分割线从格子表推出来（见 paneLayout 的 dividersOfSpec）：自定义排布也有，不用一张张形状写死
  const dividers: Divider[] = dividersOfSpec(spec, colWidths, rowWidths)

  /* ---------------- 分隔条 ---------------- */

  /** 拖的是哪条轴的哪条边界（band = 边界左边那带的下标） */
  const dragBand = useRef<{ axis: 'col' | 'row'; band: number } | null>(null)

  const stopAxisDrag = useCallback(() => {
    dragBand.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragBand.current
      if (!drag) return
      // 松手发生在窗口外面时 webview 收不到 pointerup，靠"当前没按键"判回来
      if (e.buttons === 0) {
        stopAxisDrag()
        return
      }
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const isCol = drag.axis === 'col'
      const size = isCol ? rect.width : rect.height
      const pos = isCol ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height
      if (size <= 0) return
      // 拖第 band 条边界 = 在带 band 和 band+1 之间挪宽度，各自夹住最小格
      const bands = isCol ? spec.cols : spec.rows
      const widths = bandWidths(
        isCol ? useApp.getState().splitColBands : useApp.getState().splitRowBands,
        bands,
      )
      const minFrac = MIN_PANE / size
      const offset = widths.slice(0, drag.band).reduce((a, b) => a + b, 0)
      const pairTotal = widths[drag.band] + widths[drag.band + 1]
      const na = Math.min(pairTotal - minFrac, Math.max(minFrac, pos - offset))
      const next = [...widths]
      next[drag.band] = na
      next[drag.band + 1] = pairTotal - na
      if (isCol) useApp.getState().setSplitColBands(bands, next)
      else useApp.getState().setSplitRowBands(bands, next)
    },
    [spec.cols, spec.rows, stopAxisDrag],
  )

  const startAxisDrag = (axis: 'col' | 'row', band: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    dragBand.current = { axis, band }
    document.body.style.cursor = axis === 'col' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopAxisDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopAxisDrag)
    }
  }, [onPointerMove, stopAxisDrag])

  /* ---------------- 拖标题条换位 ---------------- */

  const swapRef = useRef<{ paneId: string; ox: number; oy: number; active: boolean } | null>(null)
  /** 正在拖的那一格（拖起来才有值） */
  const [swapSource, setSwapSource] = useState<string | null>(null)
  /** 松手会落到哪一格 */
  const [swapTarget, setSwapTarget] = useState<string | null>(null)

  /**
   * 落点格 + 结果（ok 时高亮那一格，其余只给浮签）。
   * 高亮只是"给人看"的，真正的落点记在模块级的 `pendingTabDrop` 里 ——
   * 这份 state 会被 effect 清掉（见那边注释），清掉不可惜。
   * `zone` 决定高亮画整格还是半格：新格子会出现在哪半边，就点亮哪半边。
   */
  const [tabDrop, setTabDrop] = useState<{
    state: TabDropState
    paneId: string | null
    zone: DropZone
  } | null>(null)
  /** 跟着光标的浮签（SftpPanel 那套 ghost）：动作或拒绝原因 */
  const [ghost, setGhost] = useState<{ x: number; y: number; text: string } | null>(null)

  // 拖拽取消（Esc）或标签被放下时不会再有 mousemove，高亮得跟着灭。
  // **只清给人看的那些**：模块级的 pendingTabDrop 留给 mouseup 去消费 ——
  // 在这儿清掉它就是那个"松手没反应"的老 bug
  const draggingTabId = useApp((s) => s.draggingTabId)
  useEffect(() => {
    if (!draggingTabId) {
      setTabDrop((cur) => (cur ? null : cur))
      setGhost((cur) => (cur ? null : cur))
    }
  }, [draggingTabId])

  const cellAt = useCallback((x: number, y: number): string | null => {
    for (const [id, el] of cellsRef.current) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id
    }
    return null
  }, [])

  const endSwap = useCallback(() => {
    swapRef.current = null
    document.body.style.userSelect = ''
    setSwapSource(null)
    setSwapTarget(null)
  }, [])

  /**
   * 作废这一轮"拖标签"：清掉落点、高亮、浮签，以及 store 里的拖拽标记。
   *
   * 三种情况都要走这里 —— 鼠标松在窗口外面（webview 收不到 mouseup）、
   * 源标签在拖的过程中没了、指针离开窗口。少了它屏幕上会留一块死高亮，
   * 而且那之后随便动一下鼠标都还在按旧状态算落点。
   */
  const cancelTabDrop = useCallback(() => {
    // 只作废**本窗口**的那份落点：别的 PaneGrid 可能正拿它做自己的判断
    if (pendingTabDrop?.targetTabId === tabId) pendingTabDrop = null
    setTabDrop((cur) => (cur ? null : cur))
    setGhost((cur) => (cur ? null : cur))
    useApp.getState().setDraggingTabId(null)
  }, [tabId])

  useEffect(() => {
    /** 落点在本窗口里没？隐藏的标签（display:none）矩形是 0，一律不算 */
    const insideMe = (x: number, y: number) => {
      const r = containerRef.current?.getBoundingClientRect()
      return !!r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }

    const onMove = (e: MouseEvent) => {
      /**
       * 先看是不是"标签栏里拖着某个标签来找地方拼"。
       *
       * 落点写进模块级的 `pendingTabDrop`（而不是组件 ref）：TabBar 的 mouseup
       * 会先清掉 store 里的 `draggingTabId`，React 随即重渲染并跑 effect ——
       * 那一刻 ref 会被清空，等我们的 mouseup 轮到执行时就什么都没了。
       */
      const dragTabId = useApp.getState().draggingTabId
      if (!dragTabId) {
        // 没在拖标签：上一轮的落点若还留着（松在别处没人消费），现在就清掉，
        // 免得下一次普通松手把它当成"并进来"
        if (pendingTabDrop?.targetTabId === tabId) pendingTabDrop = null
      }
      if (dragTabId) {
        const src = useApp.getState().tabs.find((t) => t.id === dragTabId)
        // 已经松手了（松在窗口外面时 mouseup 到不了这儿），或者源标签没了：这一轮作废
        if (e.buttons === 0 || !src) {
          cancelTabDrop()
          return
        }
        if (!insideMe(e.clientX, e.clientY)) {
          if (pendingTabDrop?.targetTabId === tabId) pendingTabDrop = null
          setTabDrop((cur) => (cur ? null : cur))
          setGhost((cur) => (cur ? null : cur))
          return
        }

        // 一律读**实时** store：这个 effect 只注册一次，闭包里的 panes 是旧的
        const now = useApp.getState()
        const target = now.tabs.find((t) => t.id === tabId)
        const targetPanes = panesOf(target)
        const hit = cellAt(e.clientX, e.clientY)
        const state: TabDropState =
          dragTabId === tabId
            ? 'self'
            : panesOf(src).length === 0 || !acceptsPanes(target)
              ? 'notTerminal'
              : targetPanes.length >= MAX_PANES
                ? 'full'
                : panesOf(src).length <= MAX_PANES - targetPanes.length
                  ? 'ok'
                  : 'tight'

        if (state !== 'ok') {
          if (pendingTabDrop?.targetTabId === tabId) pendingTabDrop = null
          setTabDrop({ state, paneId: null, zone: 'full' })
          setGhost({ x: e.clientX, y: e.clientY, text: TAB_DROP_TEXT[state] })
          return
        }

        /**
         * 落点：插到这一格的**哪一侧**，以及切开它之后这一屏变成什么形状。
         *
         * **所有情况都按半格判**（以前只有"单格窗口"这么算，多格窗口退化成整格 +
         * 插到那一格**之前**）—— 于是把标签拖到右格上，高亮盖着右格、新格子却出现在
         * 它左边（实测：两格 `dev-box | web-01`，悬停右格偏右，松手后变成
         * `dev-box | db-primary | web-01`）。高亮画在哪儿，新格子就该出现在哪儿：
         * 压在这一格的左/上半边 = 插到它之前，右/下半边 = 插到它之后。
         *
         * **形状由 `splitPlanN` 切开落点那一格算出**（源标签有几格就切几刀），
         * 不再交给"下一档预设"（`GROWN_LAYOUT`）—— 那正是"三四分屏拖不出所有形式"
         * 的根因：拖到某一格的半边不会真的切开它，于是「左二右一」「上二下一」这些
         * 只能去菜单里点。splitPlanN 切不出来（拖到窗口空白处）才不给方案，由 store 兜底。
         */
        const hitIndex = targetPanes.findIndex((p) => p.id === hit)
        let insertAt = hitIndex >= 0 ? hitIndex : targetPanes.length
        let dropSpec: LayoutSpec | null = null
        let zone: DropZone = 'full'
        let text = '松手：并到这一格（那一格会重开一个 shell）'
        const r = (hit ? cellsRef.current.get(hit) : null)?.getBoundingClientRect()
        if (r) {
          // 横着还是竖着切：看光标偏离中心的那根轴，哪边偏得多就按哪边算
          const horizontal =
            Math.abs(e.clientX - (r.left + r.width / 2)) >
            Math.abs(e.clientY - (r.top + r.height / 2))
          const after = horizontal
            ? e.clientX - r.left > r.width / 2
            : e.clientY - r.top > r.height / 2
          zone = horizontal ? (after ? 'right' : 'left') : after ? 'bottom' : 'top'
          insertAt = (hitIndex >= 0 ? hitIndex : targetPanes.length) + (after ? 1 : 0)
          if (hitIndex >= 0) {
            const side: DropSide = zone
            dropSpec = splitPlanN(
              specOf(target),
              hitIndex,
              side,
              Math.min(panesOf(src).length, MAX_PANES - targetPanes.length),
            )?.spec ?? null
          }
          const sideText = horizontal
            ? after
              ? '右侧'
              : '左侧'
            : after
              ? '下方'
              : '上方'
          text = `松手：插到这一格的${sideText}（这一格会被切成两半，那一格重开一个 shell）`
        }
        pendingTabDrop = { targetTabId: tabId, sourceTabId: dragTabId, insertAt, spec: dropSpec }
        setTabDrop({ state, paneId: hit, zone })
        setGhost((cur) =>
          cur && cur.text === text ? cur : { x: e.clientX, y: e.clientY, text },
        )
        return
      }

      const st = swapRef.current
      if (!st) return
      // 同上：松手在窗口外面时也要收手，别把某一格留在半透明状态里
      if (e.buttons === 0) {
        endSwap()
        return
      }
      // 过阈值才算拖：按下就动会让"顺手点一下标题条"变成误拖
      if (!st.active) {
        if (Math.abs(e.clientX - st.ox) + Math.abs(e.clientY - st.oy) < DRAG_THRESHOLD) return
        st.active = true
        document.body.style.userSelect = 'none'
        setSwapSource(st.paneId)
      }
      const hit = cellAt(e.clientX, e.clientY)
      setSwapTarget(hit && hit !== st.paneId ? hit : null)
    }

    const onUp = (e: MouseEvent) => {
      /**
       * 拖着标签松手：把这个标签并进本窗口（插到落点格的位置）。
       *
       * 认的是模块级的落点，**不是** store 里的 `draggingTabId` ——
       * TabBar 的 mouseup 挂在同一个 window 上、可能先跑，它一清，
       * 我们就无从知道这一拖本来要落到哪儿了（这正是"松手没反应"的根因）。
       * 多个 PaneGrid 会同时收到这个 mouseup，所以先看落点是不是本窗口的。
       */
      const plan = pendingTabDrop?.targetTabId === tabId ? pendingTabDrop : null
      if (plan) {
        pendingTabDrop = null
        setTabDrop((cur) => (cur ? null : cur))
        setGhost((cur) => (cur ? null : cur))
        useApp.getState().setDraggingTabId(null)
        if (insideMe(e.clientX, e.clientY)) {
          useApp
            .getState()
            .mergeTabIntoPane(tabId, plan.sourceTabId, { insertAt: plan.insertAt, spec: plan.spec })
        }
        return
      }

      const st = swapRef.current
      if (!st) return
      const hit = st.active ? cellAt(e.clientX, e.clientY) : null
      const moved = st.active
      // 没拖动就是「点了一下标题」：打开这一格的换主机对话框。
      // 刻意**不用** click 事件 —— 拖完（哪怕拖回原地）浏览器照样会补一次 click，
      // 那时候弹框就成了"拖一下就蹦出个对话框"。mouseup 只在这里判一次，干净。
      // target 可能不是元素（事件直接派发到 window 上时是 window），closest 前先验
      const upTarget = e.target instanceof HTMLElement ? e.target : null
      const onOwnTitle = !!upTarget?.closest(`[data-pane-title="${st.paneId}"]`)
      endSwap()
      if (!moved) {
        if (onOwnTitle) useApp.getState().setPaneHostTarget({ tabId, paneId: st.paneId })
        return
      }
      if (!hit || hit === st.paneId) return
      useApp.getState().movePane(tabId, st.paneId, hit)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && swapRef.current) endSwap()
      if (e.key === 'Escape') cancelTabDrop()
    }
    /**
     * 指针离开窗口 / 窗口失焦：这一轮拖拽直接作废。
     *
     * 不接这个的话，拖到窗口外面松手就再也没人来收尾（mouseup 发生在窗口外，
     * webview 根本收不到），屏幕上会一直挂着一块高亮或半透明的格子。
     * 反正我们也不支持往窗口外面放东西，取消是最省事也最好懂的处理。
     */
    const onLeave = () => {
      if (swapRef.current) endSwap()
      cancelTabDrop()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onLeave)
      document.body.style.userSelect = ''
    }
  }, [cellAt, endSwap, tabId, cancelTabDrop])

  const beginSwap = (paneId: string) => (e: React.MouseEvent) => {
    if (e.button !== 0 || count < 2) return
    // 标题条上的按钮自己处理点击，别在它们身上起拖
    if ((e.target as HTMLElement).closest('[data-pane-action]')) return
    swapRef.current = { paneId, ox: e.clientX, oy: e.clientY, active: false }
  }

  /* ---------------- 渲染 ---------------- */

  return (
    // data-pane-grid：标签栏那边靠它认"落点在哪个窗口里"（拖标签过来拼）
    <div ref={containerRef} data-pane-grid={tabId} className="relative h-full">
      <div
        className="grid h-full"
        style={{
          gridTemplateColumns: gridColumns,
          gridTemplateRows: gridRows,
        }}
      >
        {panes.map((pane, i) => {
          // 位置由形状表决定：panes 的下标 → 网格里的行列（见 paneLayout 的 LayoutSpec）。
          // 这层映射是"形状"唯一的落地点，换形状时格子挪窝但组件不重建
          const cell = spec.cells[i] ?? { c: 1, r: 1 }
          return (
            <PaneFrame
              key={pane.id}
              tabId={tabId}
              pane={pane}
              cell={cell}
              showTitle={showTitle}
              focused={pane.id === activeId}
              dragging={swapSource === pane.id}
              // 两类拖拽共用这一格高亮：拖标题换位（swapTarget）、拖标签并进来（tabDrop）
              dropActive={swapTarget === pane.id || tabDrop?.paneId === pane.id}
              // 换位是整格，并进来则按落点点亮半个 —— 新格子长在哪儿就亮哪儿
              dropZone={tabDrop?.paneId === pane.id ? tabDrop.zone : 'full'}
              closable={count > 1}
              registerCell={(el) => {
                if (el) cellsRef.current.set(pane.id, el)
                else cellsRef.current.delete(pane.id)
              }}
              onTitleMouseDown={beginSwap(pane.id)}
            >
              {renderPane(pane)}
            </PaneFrame>
          )
        })}
      </div>

      {/* 分割线：按形状给位置和跨度，能拖的才画（单格没有） */}
      {dividers.map((d) => (
        <div
          key={`${d.axis}-${d.band}`}
          role="separator"
          aria-orientation={d.axis === 'col' ? 'vertical' : 'horizontal'}
          onPointerDown={startAxisDrag(d.axis, d.band)}
          title={d.axis === 'col' ? '拖动调整左右比例' : '拖动调整上下比例'}
          className={`group absolute bg-hairline transition-colors hover:bg-accent/60 ${
            d.axis === 'col' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
          }`}
          style={
            d.axis === 'col'
              ? // 两头都钉住（top + bottom），不留"只写宽度"的余地 —— 见文件头第 2 条
                {
                  left: `calc(${d.at * 100}% - 0.5px)`,
                  top: `${d.from * 100}%`,
                  bottom: `${(1 - d.to) * 100}%`,
                }
              : {
                  top: `calc(${d.at * 100}% - 0.5px)`,
                  left: `${d.from * 100}%`,
                  right: `${(1 - d.to) * 100}%`,
                }
          }
        >
          <div
            className={`absolute -left-2 -right-2 -top-2 -bottom-2 ${
              d.axis === 'col' ? 'cursor-col-resize' : 'cursor-row-resize'
            }`}
          />
        </div>
      ))}

      {/*
        拖标签进来的浮签：跟着光标走，说明松手会发生什么（或为什么接不下）。
        高亮画在具体那一格上（PaneFrame 的 dropActive），这里不再整窗罩一层 ——
        "拖到哪、落在哪"要一眼能对上
      */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-hairline bg-surface-1/95 px-2.5 py-1 text-[11px] text-ink"
          style={{ left: ghost.x + 14, top: ghost.y + 12 }}
        >
          {ghost.text}
        </div>
      )}
    </div>
  )
}

interface FrameProps {
  tabId: string
  pane: Pane
  /** 在网格里占哪一格（行列从 1 开始，可跨行跨列） */
  cell: { c: number; r: number; cs?: number; rs?: number }
  showTitle: boolean
  focused: boolean
  /** 这一格正在被拖动 */
  dragging: boolean
  /** 别格被拖到这一格上（松手就换位） */
  dropActive: boolean
  /** 高亮画哪一块：整格 / 上下左右半边（拖标签并进来时就说新格子会长在哪儿） */
  dropZone: DropZone
  closable: boolean
  registerCell: (el: HTMLDivElement | null) => void
  onTitleMouseDown: (e: React.MouseEvent) => void
  children: React.ReactNode
}

/**
 * 一格的外壳：标题条 + 终端。
 *
 * 标题条在单格时是 `hidden` 而不是不渲染 —— 见 PaneGrid 文件头第 1 条。
 */
function PaneFrame({
  tabId,
  pane,
  cell,
  showTitle,
  focused,
  dragging,
  dropActive,
  dropZone,
  closable,
  registerCell,
  onTitleMouseDown,
  children,
}: FrameProps) {
  const dead = useApp((s) => !!s.deadPanes[pane.id])
  /** 正在就地改这一格的名字 */
  const [renaming, setRenaming] = useState(false)
  /** Esc 取消时置上：blur 才是收尾点（Enter 也会走 blur），得让它知道该不该提交 */
  const cancelRenameRef = useRef(false)
  /** 标题条的右键菜单位置 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  /**
   * 标题条的右键菜单。
   *
   * 这里**不放复制/粘贴**：那些是终端内容上的动作，终端自己的右键菜单里有，
   * 而这一格的终端满屏都是 —— 同一个菜单在同一个区域出现两种含义只会让人搞不清
   * 粘到哪儿去了。这一份只管"这一格"本身。
   */
  const menuItems: MenuEntry[] = [
    {
      label: '换一台主机…',
      testId: 'pane-swap-host',
      icon: <ChevronDown size={13} className="shrink-0 text-ink-tertiary" />,
      // 跟单击标题是同一个入口，见 onUp 里那段注释
      onSelect: () => useApp.getState().setPaneHostTarget({ tabId, paneId: pane.id }),
    },
    {
      label: '重命名这一格',
      testId: 'pane-rename',
      icon: <Pencil size={13} className="shrink-0 text-ink-tertiary" />,
      onSelect: () => setRenaming(true),
    },
    {
      label: '复制这一格的名字',
      testId: 'pane-copy-title',
      onSelect: () => copyQuietly(pane.title),
    },
    ...(pane.sessionId
      ? [
          {
            label: '打开这一格的 SFTP',
            testId: 'pane-sftp',
            icon: <FolderOpen size={13} className="shrink-0 text-ink-tertiary" />,
            onSelect: () =>
              useApp.getState().addTab({
                title: `${pane.title} · 文件`,
                kind: 'sftp',
                sessionId: pane.sessionId,
                hostId: pane.hostId,
              }),
          } satisfies MenuEntry,
        ]
      : []),
    // 断线且自动重连已放弃时才有得连（跟标题条上那个 ↻ 同一个回调）
    ...(dead
      ? [
          {
            label: '重新连接这一格',
            testId: 'pane-reconnect',
            icon: <RotateCw size={13} className="shrink-0 text-warning" />,
            onSelect: () => useApp.getState().reconnectSinks[pane.id]?.(),
          } satisfies MenuEntry,
        ]
      : []),
    // 只剩一格时不给关（那等于关标签，走标签的 ✕），跟标题条上的按钮一个规矩
    ...(closable
      ? [
          sep(),
          {
            label: '关掉这一格',
            testId: 'pane-close',
            danger: true,
            icon: <X size={13} className="shrink-0" />,
            onSelect: () => useApp.getState().closePane(tabId, pane.id),
          } satisfies MenuEntry,
        ]
      : []),
  ]

  /**
   * 改这一格的名字。
   *
   * 空串按取消处理：格子的名字是"这是哪台机器"的唯一线索，清掉之后
   * 四宫格里就剩四个图标，只能一个个点进去找。
   */
  const commitRename = (raw: string) => {
    setRenaming(false)
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      return
    }
    const title = raw.trim()
    if (!title || title === pane.title) return
    useApp.getState().renamePane(tabId, pane.id, title)
  }

  return (
    <div
      ref={registerCell}
      // 位置由形状给（行列 + 跨度）
      style={{
        gridColumn: `${cell.c} / span ${cell.cs ?? 1}`,
        gridRow: `${cell.r} / span ${cell.rs ?? 1}`,
      }}
      // 点这一格里任何地方都算聚焦：命令片段投给谁、查找搜谁都以它为准
      onMouseDownCapture={() => useApp.getState().focusPane(tabId, pane.id)}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden transition-opacity ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      <div
        onMouseDown={onTitleMouseDown}
        // 右键也开菜单。这个 mousedown 起的是"拖动换位"，但它只认左键
        // （beginSwap 里 `e.button !== 0` 直接 return），所以右键不会误起拖拽
        onContextMenu={(e) => {
          const at = menuAt(e)
          if (at) setMenu(at)
        }}
        className={`flex h-6 shrink-0 select-none items-center gap-1 border-b border-hairline px-2 text-[11px] ${
          showTitle ? 'cursor-grab active:cursor-grabbing' : 'hidden'
        } ${focused ? 'bg-surface-2 text-ink' : 'bg-surface-1 text-ink-subtle'}`}
      >
        {/*
          标题本身就是「这一格连哪台机器」的入口：点一下换，拖一下跟别的格子换位。
          改成明摆着的下拉样子（▾ + pointer 光标 + 写清两件事的 tooltip），
          因为改造后第一版只在右边放了个 11px 的灰 ⇄ 图标 —— 用户根本看不出那能点，
          于是以为"分屏只能连同一台机器"。
          点击在 window 的 mouseup 里判（见 onUp），不挂 onClick。
        */}
        {renaming ? (
          /*
            改名用的输入框必须整块包在 data-pane-action 里：标题条的 mousedown
            会起"拖动换位"，不排除掉的话在输入框里选字会被当成拖格子。
            它也不能带 data-pane-title —— 否则松手时外面那套逻辑会顺手弹出换主机框。
          */
          <span data-pane-action className="flex min-w-0 flex-1 items-center gap-1 px-1 -mx-1">
            <Terminal size={11} className="shrink-0 text-ink-tertiary" />
            <input
              autoFocus
              defaultValue={pane.title}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  cancelRenameRef.current = true
                  e.currentTarget.blur()
                }
              }}
              className="h-4 w-full min-w-0 rounded border border-accent bg-surface-2 px-1 text-[11px] text-ink outline-none"
            />
          </span>
        ) : (
          <span
            data-pane-title={pane.id}
            title={showTitle ? '点一下换一台主机连到这一格 · 拖动可以跟别的格子换位' : undefined}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <Terminal size={11} className="shrink-0 text-ink-tertiary" />
            <span className="min-w-0 truncate">{pane.title}</span>
            <ChevronDown size={11} className="shrink-0 text-ink-tertiary" />
          </span>
        )}

        {/*
          改这一格的名字。**不给双击** —— 标题的单击已经被"换主机"占着
          （在 window 的 mouseup 里判），双击等于连点两下，会弹出两轮换主机框。
          所以这里用一个明摆着的按钮。
        */}
        <span
          data-pane-action
          data-pane-rename={pane.id}
          title="改这一格显示的名字（只影响显示）"
          className="flex shrink-0"
          onClick={() => setRenaming(true)}
        >
          <Pencil
            size={11}
            className="text-ink-tertiary opacity-60 transition-colors hover:text-accent hover:opacity-100"
          />
        </span>

        {pane.sessionId && (
          <span
            data-pane-action
            title="打开这一格的 SFTP"
            className="flex shrink-0"
            onClick={() =>
              useApp.getState().addTab({
                title: `${pane.title} · 文件`,
                kind: 'sftp',
                sessionId: pane.sessionId,
                hostId: pane.hostId,
              })
            }
          >
            <FolderOpen
              size={11}
              className="text-ink-tertiary opacity-60 transition-colors hover:text-accent hover:opacity-100"
            />
          </span>
        )}

        {/* 断线且自动重连已放弃：给个 ↻（标签栏那个会把所有格子一起拉） */}
        {dead && (
          <span
            data-pane-action
            title="重新连接这一格"
            className="flex shrink-0"
            onClick={() => useApp.getState().reconnectSinks[pane.id]?.()}
          >
            <RotateCw size={11} className="text-warning transition-opacity hover:opacity-70" />
          </span>
        )}

        {closable && (
          <span
            data-pane-action
            title="关掉这一格"
            className="flex shrink-0"
            onClick={() => useApp.getState().closePane(tabId, pane.id)}
          >
            <X
              size={11}
              className="text-ink-tertiary opacity-60 transition-opacity hover:text-ink hover:opacity-100"
            />
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">{children}</div>

      {/* 聚焦与投放的高亮都走绝对定位覆盖层：改成 border 会改变内容盒，终端要重排 */}
      {focused && showTitle && !dropActive && (
        <div className="pointer-events-none absolute inset-0 border border-accent/40" aria-hidden />
      )}
      {dropActive && (
        <div
          // 半格高亮的形状：整格用 inset-0，半边各自钉住两条边 —— 别写成 w-1/2 配默认
          // 的 left:auto（绝对定位的 left 取的是内容盒起点，会偏出 padding）
          className={`pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10 ${ZONE_CLASS[dropZone]}`}
          aria-hidden
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
