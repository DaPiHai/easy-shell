import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { FolderTree, type LucideIcon } from 'lucide-react'
import { useApp, type RightPanelPage } from '@/lib/store'
import { FilesPage } from './FilesPage'

/**
 * 右侧多功能栏的页签。本轮只有「文件」一页 —— 加一页 = 这里加一项 + 一个组件，
 * 外壳（拖宽、开关、页签行）不再动。
 */
const PAGES: Array<{ id: RightPanelPage; icon: LucideIcon; title: string }> = [
  { id: 'files', icon: FolderTree, title: '文件' },
]

/**
 * 右侧栏。宽度可拖（左缘 4px 手柄），页签行在顶上。
 * 开关在全宽顶栏右上角（App.tsx 的 📁），这里自己不再放收起按钮 —— 一处开关一处管。
 */
export function RightPanel() {
  const width = useApp((s) => s.rightPanelWidth)
  const page = useApp((s) => s.rightPanelPage)

  /* 左缘拖宽。照 PaneGrid 分割线的 pointer 事件手法：松手在窗口外靠 buttons===0 收尾 */
  const dragging = useRef(false)
  const stop = useCallback(() => {
    dragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])
  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      if (e.buttons === 0) {
        stop()
        return
      }
      useApp.getState().setRightPanelWidth(window.innerWidth - e.clientX)
    },
    [stop],
  )
  useEffect(() => {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onMove, stop])

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <aside
      data-right-panel
      className="relative flex h-full shrink-0 flex-col border-l border-hairline bg-surface-1"
      style={{ width }}
    >
      {/* 左缘拖宽手柄：4px 命中条压在边线上 */}
      <div
        onPointerDown={startDrag}
        title="拖动调整宽度"
        data-right-panel-resizer
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/30"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        {PAGES.map((p) => {
          const Icon = p.icon
          const active = p.id === page
          return (
            <button
              key={p.id}
              onClick={() => useApp.getState().setRightPanelPage(p.id)}
              title={p.title}
              data-right-panel-page={p.id}
              className={`grid h-6 w-6 place-items-center rounded transition-colors ${
                active
                  ? 'bg-surface-2 text-ink'
                  : 'text-ink-tertiary hover:bg-surface-2 hover:text-ink'
              }`}
            >
              <Icon size={14} />
            </button>
          )
        })}
        <span className="ml-auto truncate text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
          {PAGES.find((p) => p.id === page)?.title}
        </span>
      </div>
      <div className="min-h-0 flex-1">{page === 'files' && <FilesPage />}</div>
    </aside>
  )
}
