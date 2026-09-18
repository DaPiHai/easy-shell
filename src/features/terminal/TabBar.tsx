import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Columns2,
  FileCode2,
  FolderOpen,
  FolderTree,
  Grid2x2,
  RotateCw,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { isSplittable, panesOf, tabHasDeadPane, useApp, type Tab } from '@/lib/store'

/** 拖拽判定阈值：手抖点一下不该被当成拖动 */
const DRAG_THRESHOLD = 5

/**
 * 分屏档位循环：1 → 2 → 4 → 1。
 *
 * 3 格（关掉四宫格里的一格就到这个状态）必须**补满到 4**，不能落进"回到 2 格"那一档 ——
 * 那等于按一下按钮就悄悄关掉一格终端。踩过：拼进来三格之后再点分屏，结果少了一格。
 */
function nextPaneCount(current: number): 1 | 2 | 4 {
  if (current >= 4) return 1
  if (current === 1) return 2
  return 4
}

/** 按钮上的图标画的是**当前**档位，提示语说的是点下去会变成什么 */
function SplitIcon({ count }: { count: number }) {
  if (count >= 3) return <Grid2x2 size={12} />
  if (count === 2) return <Columns2 size={12} />
  return <Square size={12} />
}

function splitTitle(count: number): string {
  if (count >= 4) return '恢复单格'
  if (count === 1) {
    // 新格沿用这条连接是"立刻能用"的默认；去哪换机器得写在提示里，
    // 不然用户会以为分屏只能连同一台
    return '左右分屏 —— 新格沿用这条连接，点格子标题可换成别的主机'
  }
  return `分成四宫格（现在 ${count} 格；四格可各自连不同主机）`
}

/** 这个标签当前聚焦的格子；没记过就取第一个。SFTP 按钮按它取会话 */
function focusedPaneOf(tab: Tab, focusedPane: Record<string, string>) {
  const panes = panesOf(tab)
  return panes.find((p) => p.id === focusedPane[tab.id]) ?? panes[0] ?? null
}

export function TabBar() {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    requestCloseTab,
    setPaneCount,
    deadPanes,
    reconnectSinks,
    focusedPane,
  } = useApp()

  /* ---------------- 拖标签排序 ---------------- */

  const barRef = useRef<HTMLDivElement>(null)
  /** 每个标签的 DOM，拖到哪儿要按它们的实时位置算 */
  const tabEls = useRef(new Map<string, HTMLDivElement>())
  const dragRef = useRef<{ id: string; from: number; ox: number; oy: number; active: boolean } | null>(
    null,
  )
  /** 正在拖的标签 id */
  const [dragId, setDragId] = useState<string | null>(null)
  /** 松手会插到第几个位置（原数组下标），null = 没在拖 */
  const [insertAt, setInsertAt] = useState<number | null>(null)
  /** 插入指示线的 x（相对标签栏） */
  const [insertX, setInsertX] = useState(0)

  const endDrag = useCallback(() => {
    dragRef.current = null
    document.body.style.userSelect = ''
    setDragId(null)
    setInsertAt(null)
    // 告诉 PaneGrid「这一轮标签拖拽结束了」，它靠这个把落点高亮收掉
    useApp.getState().setDraggingTabId(null)
  }, [])

  /**
   * 落点在标签栏这条带子里没？（下沿多给 16px）
   *
   * 这条线是"排序"和"拼进窗口"的分界：带子里 = 排序，带子下面 = 落到某个终端窗口里
   * （由 PaneGrid 的 mouseup 处理）。下沿多给一截是因为误判的两个方向代价不对等 ——
   * 想排序却落到窗口里会把标签拼掉（标签直接消失），反过来只是没排成。
   */
  const inBarBand = useCallback((y: number) => {
    const bar = barRef.current?.getBoundingClientRect()
    return !bar || y <= bar.bottom + 16
  }, [])

  const locate = useCallback(
    (x: number): { index: number; left: number } => {
      const bar = barRef.current
      for (let i = 0; i < tabs.length; i += 1) {
        const el = tabEls.current.get(tabs[i].id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (x < r.left + r.width / 2) {
          return { index: i, left: r.left - (bar?.getBoundingClientRect().left ?? 0) }
        }
      }
      const last = tabEls.current.get(tabs[tabs.length - 1]?.id ?? '')
      const barLeft = bar?.getBoundingClientRect().left ?? 0
      return { index: tabs.length, left: last ? last.getBoundingClientRect().right - barLeft : 0 }
    },
    [tabs],
  )

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      // 松手在窗口外面时 webview 收不到 mouseup：靠"当前没按着键"把这一轮收掉，
      // 否则标签会一直是半透明的、插入线也留在那儿
      if (e.buttons === 0) {
        endDrag()
        return
      }
      if (!st.active) {
        if (Math.abs(e.clientX - st.ox) + Math.abs(e.clientY - st.oy) < DRAG_THRESHOLD) return
        st.active = true
        document.body.style.userSelect = 'none'
        setDragId(st.id)
        // PaneGrid 靠这个知道"现在拖的是标签"，不是格子换位
        useApp.getState().setDraggingTabId(st.id)
      }
      // 出了标签栏这条带子就不是排序了：下面要么是终端窗口（拼进去），要么什么都不接
      if (!inBarBand(e.clientY)) {
        setInsertAt(null)
        return
      }
      const { index, left } = locate(e.clientX)
      setInsertAt(index)
      setInsertX(left)
    }
    const onUp = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      const moved = st.active
      const droppedIntoWindow = !inBarBand(e.clientY)
      const { index } = locate(e.clientX)
      endDrag()
      if (!moved) return
      // 落在终端窗口那块：并进去这件事由 PaneGrid 的 mouseup 干
      //（它按自己的矩形判落点），这里只负责不把它当成排序
      if (droppedIntoWindow) return
      // 落点下标要按"先把自己抽走"之后的数组算，否则往后拖会差一位
      const to = index > st.from ? index - 1 : index
      if (to !== st.from) useApp.getState().moveTab(st.from, to)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) endDrag()
    }
    // 指针离开窗口 / 窗口失焦：这一轮拖拽作废（松在窗口外的 mouseup 到不了这里）
    const onLeave = () => {
      if (dragRef.current) endDrag()
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
  }, [locate, endDrag, inBarBand])

  const beginDrag = (tab: Tab, index: number) => (e: React.MouseEvent) => {
    // 只认左键；标签上的小按钮（SFTP / 分屏 / 关闭）自己处理点击，别在它们身上起拖
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    dragRef.current = { id: tab.id, from: index, ox: e.clientX, oy: e.clientY, active: false }
  }

  if (tabs.length === 0) return null

  return (
    // relative：插入指示线要绝对定位在这条栏里
    <div ref={barRef} className="relative flex h-9 shrink-0 items-center border-b border-hairline bg-canvas">
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId
        const panes = panesOf(tab)
        const pane = focusedPaneOf(tab, focusedPane)
        const hasDead = tabHasDeadPane(tab, deadPanes)
        return (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) tabEls.current.set(tab.id, el)
              else tabEls.current.delete(tab.id)
            }}
            onMouseDown={beginDrag(tab, index)}
            onClick={() => setActiveTab(tab.id)}
            // 中键关标签 —— 浏览器里的肌肉记忆，不接的话按了没反应很别扭
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                // 中键也走守卫，否则它会变成绕过「未保存」提示的后门
                requestCloseTab(tab.id)
              }
            }}
            // min-w-0 两处都不能省：flex 子项的 min-width 默认是 min-content，
            // 而标题是 nowrap 的（truncate），于是标签根本缩不动 —— 最小窗口宽度下
            // 开到第 5 个标签起就被挤出可视区，还没有滚动条可以找回来。
            // 标题 span 也要 min-w-0 才会真的让位给省略号
            title={tab.title}
            className={`group relative flex h-9 min-w-0 cursor-pointer items-center gap-2 border-r border-hairline px-3 text-[13px] transition-colors ${
              dragId === tab.id ? 'opacity-50' : ''
            } ${active ? 'bg-surface-1 text-ink' : 'text-ink-subtle hover:bg-surface-1'}`}
          >
            {tab.kind === 'sftp' ? (
              <FolderTree size={12} className="shrink-0 text-ink-tertiary" />
            ) : tab.kind === 'editor' ? (
              <FileCode2 size={12} className="shrink-0 text-ink-tertiary" />
            ) : (
              <Terminal size={12} className="shrink-0 text-ink-tertiary" />
            )}
            <span className="min-w-0 max-w-40 truncate">{tab.title}</span>
            {/* 有一格断线且自动重连已放弃：给个 ↻，一次把整个标签的格子都拉一遍 */}
            {hasDead && (
              <span data-no-drag title="重新连接" className="flex shrink-0">
                <RotateCw
                  size={12}
                  className="text-warning transition-opacity hover:opacity-70"
                  onClick={(e) => {
                    e.stopPropagation()
                    for (const p of panes) reconnectSinks[p.id]?.()
                  }}
                />
              </span>
            )}
            {/*
              就地开 SFTP，复用**当前聚焦那一格**的连接。
              必须常驻而不是 hover 才出现：Ctrl+N 快速连接的机器不进会话树，
              这个按钮就是它唯一的可见入口 —— 藏起来等于没有。
            */}
            {pane?.sessionId && (
              <span data-no-drag title="打开 SFTP 文件管理器" className="flex shrink-0">
                <FolderOpen
                  size={12}
                  className="text-ink-muted transition-colors hover:text-accent"
                  onClick={(e) => {
                    e.stopPropagation()
                    useApp.getState().addTab({
                      title: `${tab.title} · 文件`,
                      kind: 'sftp',
                      sessionId: pane.sessionId,
                      hostId: pane.hostId,
                    })
                  }}
                />
              </span>
            )}
            {/* 分屏只对远程终端有意义：本地 shell 和文件面板没这个需求 */}
            {isSplittable(tab) && (
              // title 挂 span 上：svg 元素的 title 属性不弹提示
              <span data-no-drag title={splitTitle(panes.length)} className="flex shrink-0">
                <span
                  className={`flex transition-colors ${
                    panes.length > 1
                      ? 'text-accent'
                      : 'text-ink-tertiary opacity-70 hover:text-ink hover:opacity-100'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPaneCount(tab.id, nextPaneCount(panes.length))
                  }}
                >
                  <SplitIcon count={panes.length} />
                </span>
              </span>
            )}
            <span data-no-drag title="关闭标签" className="flex shrink-0">
              <X
                size={12}
                // 常驻但压暗：完全藏起来等于没有入口，全亮又太容易误点关掉
                className="text-ink-tertiary opacity-60 transition-opacity hover:text-ink hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  // 只关标签：通道由 TerminalView 卸载时自己关。
                  // 在这里先关通道的话，后端会推 'closed' 事件，
                  // 终端还没卸载就会去走重连逻辑 —— 白折腾还可能出错
                  requestCloseTab(tab.id)
                }}
              />
            </span>
            {/*
              高亮线必须用 inset-x-0 卡住左右两边，**别写成 w-full**：
              绝对定位子元素的 left 是 auto，此时它取的是 flex 容器内容盒的起点，
              于是整条线被 padding-left 顶到右边去了（宽 100% 算的却是 padding 盒，
              结果左边差 12px、右边又多探出去 12px，正好压在隔壁）。inset-x-0 两头对齐，
              宽度由包含块直接算出，跟 padding 无关。
            */}
            {active && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" aria-hidden />
            )}
          </div>
        )
      })}

      {/*
        拖拽时的插入位置指示线。落点靠每个标签的实时矩形算（`locate`），
        所以窗口缩放、标签宽度不一都不影响它指的位置
      */}
      {insertAt !== null && (
        <span
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-accent"
          style={{ left: insertX }}
          aria-hidden
        />
      )}
    </div>
  )
}
