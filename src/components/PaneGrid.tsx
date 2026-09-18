import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Plus, RotateCw, Terminal, X } from 'lucide-react'
import { acceptsPanes, MAX_PANES, panesOf, useApp, type Pane } from '@/lib/store'

/** 拖拽判定阈值：手抖点一下不该被当成拖动 */
const DRAG_THRESHOLD = 5
/** 分割线离两端的最近距离，别让某一格被拖到看不见 */
const MIN_PANE = 120

/** 拖标签落到本窗口时的几种结果：能并 / 拖到了自己身上 / 满了 / 放不下 / 有一边不是终端 */
type TabDropState = 'ok' | 'self' | 'full' | 'tight' | 'notTerminal'

/** 每种状态给用户看的一句话 */
const TAB_DROP_TEXT: Record<TabDropState, string> = {
  ok: '松手：把这个标签并进这里（那一格会重开一个 shell）',
  self: '这是它自己的窗口 —— 拖到别的终端窗口里才能并',
  full: `并不下来：这个窗口已经 ${MAX_PANES} 格了`,
  tight: '并不下来：这个窗口剩下的格子放不下它',
  notTerminal: '并不下来：文件面板和编辑器里没有格子',
}


interface Props {
  tabId: string
  /** 1–4 个格子，**顺序就是屏幕位置**（见 store 的 `Tab.panes`） */
  panes: Pane[]
  colRatio: number
  rowRatio: number
  onColRatioChange: (ratio: number) => void
  onRowRatioChange: (ratio: number) => void
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
export function PaneGrid({
  tabId,
  panes,
  colRatio,
  rowRatio,
  onColRatioChange,
  onRowRatioChange,
  renderPane,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** 每一格的 DOM，拖拽换位时做命中测试用 */
  const cellsRef = useRef(new Map<string, HTMLDivElement>())

  const focusedPaneId = useApp((s) => s.focusedPane[tabId])

  const count = panes.length
  // 3 格是 2×2 缺一角，所以从第 3 格起就是两行
  const twoRows = count >= 3
  // 单格不显示标题条（保持现在的干净外观），但**位置留着**，用 hidden 藏 —— 理由见文件头第 1 条
  const showTitle = count > 1
  const activeId = focusedPaneId && panes.some((p) => p.id === focusedPaneId) ? focusedPaneId : panes[0]?.id

  /* ---------------- 分隔条 ---------------- */

  const dragAxis = useRef<'col' | 'row' | null>(null)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const axis = dragAxis.current
      if (!axis) return
      // 松手发生在窗口外面时 webview 收不到 pointerup，靠"当前没按键"判回来
      if (e.buttons === 0) {
        stopAxisDrag()
        return
      }
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      if (axis === 'col') {
        if (rect.width <= 0) return
        const lo = Math.min(0.45, MIN_PANE / rect.width)
        const ratio = (e.clientX - rect.left) / rect.width
        onColRatioChange(Math.min(1 - lo, Math.max(lo, ratio)))
      } else {
        if (rect.height <= 0) return
        const lo = Math.min(0.45, MIN_PANE / rect.height)
        const ratio = (e.clientY - rect.top) / rect.height
        onRowRatioChange(Math.min(1 - lo, Math.max(lo, ratio)))
      }
    },
    [onColRatioChange, onRowRatioChange],
  )

  const stopAxisDrag = useCallback(() => {
    dragAxis.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopAxisDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopAxisDrag)
    }
  }, [onPointerMove, stopAxisDrag])

  const startAxisDrag = (axis: 'col' | 'row') => (e: React.PointerEvent) => {
    e.preventDefault()
    dragAxis.current = axis
    document.body.style.cursor = axis === 'col' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  /* ---------------- 拖标题条换位 ---------------- */

  const swapRef = useRef<{ paneId: string; ox: number; oy: number; active: boolean } | null>(null)
  /** 正在拖的那一格（拖起来才有值） */
  const [swapSource, setSwapSource] = useState<string | null>(null)
  /** 松手会落到哪一格 */
  const [swapTarget, setSwapTarget] = useState<string | null>(null)

  /**
   * 标签栏拖着一个标签、且落点在本窗口上时，记住是哪个标签。
   * 用 ref 而不是直接读 store：mouseup 时 TabBar 可能已经把手松开并清掉了
   * `draggingTabId`（两个监听器都挂在 window 上，谁先跑不保证）。
   */
  const tabDragOverRef = useRef<string | null>(null)
  /** 落点在本窗口时给用户看的高亮；state 决定它说的话（见下面的遮罩） */
  const [tabDrop, setTabDrop] = useState<TabDropState | null>(null)

  // 拖拽取消（Esc）或标签被放下时不会再有 mousemove，高亮得跟着灭
  const draggingTabId = useApp((s) => s.draggingTabId)
  useEffect(() => {
    if (!draggingTabId) {
      tabDragOverRef.current = null
      setTabDrop((cur) => (cur ? null : cur))
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
   * 作废这一轮"拖标签"：清掉落点、高亮，以及 store 里的拖拽标记。
   *
   * 三种情况都要走这里 —— 鼠标松在窗口外面（webview 收不到 mouseup）、
   * 源标签在拖的过程中没了、指针离开窗口。少了它屏幕上会留一块死高亮，
   * 而且那之后随便动一下鼠标都还在按旧状态算落点。
   */
  const cancelTabDrop = useCallback(() => {
    tabDragOverRef.current = null
    setTabDrop((cur) => (cur ? null : cur))
    useApp.getState().setDraggingTabId(null)
  }, [])

  useEffect(() => {
    /** 落点在本窗口里没？隐藏的标签（display:none）矩形是 0，一律不算 */
    const insideMe = (x: number, y: number) => {
      const r = containerRef.current?.getBoundingClientRect()
      return !!r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }

    const onMove = (e: MouseEvent) => {
      /**
       * 先看是不是"标签栏里拖着某个标签来找地方拼"。
       * 用 ref 记住落点，别在 mouseup 里问 store —— TabBar 的 mouseup 可能先跑，
       * 它会把 draggingTabId 清掉（两个监听器都在 window 上，顺序不保证）。
       */
      const dragTabId = useApp.getState().draggingTabId
      if (dragTabId) {
        const src = useApp.getState().tabs.find((t) => t.id === dragTabId)
        // 已经松手了（松在窗口外面时 mouseup 到不了这儿），或者源标签没了：这一轮作废
        if (e.buttons === 0 || !src) {
          cancelTabDrop()
          return
        }
        const inside = insideMe(e.clientX, e.clientY)
        tabDragOverRef.current = inside ? dragTabId : null
        if (inside) {
          // 一律读**实时** store：这个 effect 只注册一次，闭包里的 panes 是旧的
          const now = useApp.getState()
          const target = now.tabs.find((t) => t.id === tabId)
          const targetCount = panesOf(target).length
          const state: TabDropState =
            dragTabId === tabId
              ? 'self'
              : panesOf(src).length === 0 || !acceptsPanes(target)
                ? 'notTerminal'
                : targetCount >= MAX_PANES
                  ? 'full'
                  : panesOf(src).length <= MAX_PANES - targetCount
                    ? 'ok'
                    : 'tight'
          setTabDrop((cur) => (cur && cur === state ? cur : state))
        } else {
          setTabDrop((cur) => (cur ? null : cur))
        }
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
      // 拖着标签松手：把这个标签并进本窗口
      const draggedTabId = tabDragOverRef.current
      if (draggedTabId) {
        tabDragOverRef.current = null
        setTabDrop(null)
        if (insideMe(e.clientX, e.clientY)) {
          useApp.getState().mergeTabIntoPane(tabId, draggedTabId)
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
      const onOwnTitle = !!(e.target as HTMLElement | null)?.closest(
        `[data-pane-title="${st.paneId}"]`,
      )
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
          gridTemplateColumns: count > 1 ? `${colRatio}fr ${1 - colRatio}fr` : '1fr',
          gridTemplateRows: twoRows ? `${rowRatio}fr ${1 - rowRatio}fr` : '1fr',
        }}
      >
        {panes.map((pane) => (
          <PaneFrame
            key={pane.id}
            tabId={tabId}
            pane={pane}
            showTitle={showTitle}
            focused={pane.id === activeId}
            dragging={swapSource === pane.id}
            dropActive={swapTarget === pane.id}
            closable={count > 1}
            registerCell={(el) => {
              if (el) cellsRef.current.set(pane.id, el)
              else cellsRef.current.delete(pane.id)
            }}
            onTitleMouseDown={beginSwap(pane.id)}
          >
            {renderPane(pane)}
          </PaneFrame>
        ))}
        {/* 3 格时补一个「＋」角。它只跟格子数有关，跟哪个格子被关掉无关 */}
        {count === 3 && (
          <div className="grid place-items-center border border-dashed border-hairline-strong">
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={() => useApp.getState().addPane(tabId)}
                title="新格子沿用第一格的连接（同一条会话再开一条 shell，不重新认证）"
                className="flex flex-col items-center gap-1 rounded-md px-4 py-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Plus size={16} />
                添加终端
              </button>
              {/*
                这条路是给"四格四台机器"用的：先按普通方式建格（沿用第一格），
                立刻弹出换主机对话框。取消了也不亏 —— 格子照样能用
              */}
              <button
                onClick={() => {
                  const paneId = useApp.getState().addPane(tabId)
                  if (paneId) useApp.getState().setPaneHostTarget({ tabId, paneId })
                }}
                className="rounded px-2 py-0.5 text-[11px] text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-ink"
              >
                或连别的主机…
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 竖线：左右两格之间（2 格就是唯一的线，四宫格里是列分隔） */}
      {count > 1 && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startAxisDrag('col')}
          title="拖动调整左右比例"
          className="group absolute inset-y-0 w-px cursor-col-resize bg-hairline transition-colors hover:bg-accent/60"
          style={{ left: `calc(${colRatio * 100}% - 0.5px)` }}
        >
          <div className="absolute inset-y-0 -left-2 -right-2" />
        </div>
      )}
      {/* 横线：四宫格才有 */}
      {twoRows && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={startAxisDrag('row')}
          title="拖动调整上下比例"
          className="group absolute inset-x-0 h-px cursor-row-resize bg-hairline transition-colors hover:bg-accent/60"
          style={{ top: `calc(${rowRatio * 100}% - 0.5px)` }}
        >
          <div className="absolute -top-2 -bottom-2 inset-x-0" />
        </div>
      )}

      {/*
        标签栏里拖着某个标签落在本窗口上：整块高亮 + 一句说明，松手就拼进来。
        接不下时（这个窗口已经四格、或者拖来的不是终端标签）换成警示色，
        别让人以为松手能成
      */}
      {tabDrop && (
        <div
          className={`pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed ${
            tabDrop === 'ok' ? 'border-accent bg-accent/10' : 'border-danger bg-danger/10'
          }`}
        >
          <span className="rounded-md border border-hairline bg-surface-1/95 px-3 py-1.5 text-[12px] text-ink">
            {TAB_DROP_TEXT[tabDrop]}
          </span>
        </div>
      )}
    </div>
  )
}

interface FrameProps {
  tabId: string
  pane: Pane
  showTitle: boolean
  focused: boolean
  /** 这一格正在被拖动 */
  dragging: boolean
  /** 别格被拖到这一格上（松手就换位） */
  dropActive: boolean
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
  showTitle,
  focused,
  dragging,
  dropActive,
  closable,
  registerCell,
  onTitleMouseDown,
  children,
}: FrameProps) {
  const dead = useApp((s) => !!s.deadPanes[pane.id])

  return (
    <div
      ref={registerCell}
      // 点这一格里任何地方都算聚焦：命令片段投给谁、查找搜谁都以它为准
      onMouseDownCapture={() => useApp.getState().focusPane(tabId, pane.id)}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden transition-opacity ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      <div
        onMouseDown={onTitleMouseDown}
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
        <span
          data-pane-title={pane.id}
          title={showTitle ? '点一下换一台主机连到这一格 · 拖动可以跟别的格子换位' : undefined}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <Terminal size={11} className="shrink-0 text-ink-tertiary" />
          <span className="min-w-0 truncate">{pane.title}</span>
          <ChevronDown size={11} className="shrink-0 text-ink-tertiary" />
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
          className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent bg-accent/10"
          aria-hidden
        />
      )}
    </div>
  )
}
