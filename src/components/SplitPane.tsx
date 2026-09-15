import { useCallback, useEffect, useRef } from 'react'

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  ratio: number
  onRatioChange: (next: number) => void
  minPane?: number
  /**
   * 关掉时只渲染左半边。
   * 为什么要这个开关而不是让调用方在 SplitPane / 单终端之间切：
   * 那样元素类型一变，React 会把左边那个终端也一起拆掉重连，
   * 之前敲的命令和滚动历史全丢了。常驻 SplitPane 才能让左半边一直活着。
   */
  split?: boolean
}

export function SplitPane({
  left,
  right,
  ratio,
  onRatioChange,
  minPane = 120,
  split = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      const minRatio = minPane / rect.width
      const maxRatio = 1 - minPane / rect.width
      const next = Math.min(maxRatio, Math.max(minRatio, (e.clientX - rect.left) / rect.width))
      onRatioChange(next)
    },
    [onRatioChange, minPane],
  )

  const stop = useCallback(() => {
    draggingRef.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onPointerMove, stop])

  return (
    <div ref={containerRef} className="flex h-full">
      <div
        className="min-w-0 overflow-hidden"
        style={split ? { flexBasis: `${ratio * 100}%` } : { flexBasis: '100%' }}
      >
        {left}
      </div>
      {split && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => {
              e.preventDefault()
              draggingRef.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
            className="group relative w-px shrink-0 cursor-col-resize bg-hairline transition-colors hover:bg-accent/60"
            title="拖动调整分屏比例"
          >
            <div className="absolute inset-y-0 -left-2.5 -right-2.5" />
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">{right}</div>
        </>
      )}
    </div>
  )
}