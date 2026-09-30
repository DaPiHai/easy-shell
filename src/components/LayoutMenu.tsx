import { useLayoutEffect, useRef, useState } from 'react'
import { LAYOUT_ORDER, PANE_LAYOUTS, type PaneLayout } from '@/lib/store'
import { LayoutIcon } from './LayoutIcon'
import { useDismiss } from './useDismiss'

interface Props {
  /** 锚点（clientX/clientY）：菜单从按钮底下展开 */
  x: number
  y: number
  /**
   * 当前生效的形状（打勾）。
   *
   * **null = 这一屏是拖出来的自定义排布**，菜单里一项都不打勾 —— 它本来就不在这张表里，
   * 挑个"最像的"标上反而会让人以为点一下能回到那个形状。
   */
  current: PaneLayout | null
  onPick: (layout: PaneLayout) => void
  onClose: () => void
}

/** 离窗口边缘至少留这么多，贴边时往里收 */
const EDGE = 8

/** 按格数分组，组名就是菜单里的小标题 */
const GROUP_LABEL: Record<number, string> = { 1: '1 格', 2: '2 格', 3: '3 格', 4: '4 格' }

/**
 * 分屏布局的缩略图弹层。
 *
 * 十六种形状平铺成一列太高（窗口矮时底部的项够不着），所以按格数分成四组、
 * 组内用小示意图排成网格：挑形状是"看图选"的事，名字反而次要。
 * 关闭时机（点外 / Esc / 滚轮 / 失焦 / resize）与右键菜单共用一套（useDismiss）。
 */
export function LayoutMenu({ x, y, current, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
      ready: true,
    })
  }, [x, y])

  /**
   * **必须把 ref 传进去。**
   *
   * useDismiss 的关闭监听挂在 `mousedown`（capture）上 —— 不传 ref 时任何一次
   * 按下去都会先关菜单，等 mouseup 到来时按钮已经不在 DOM 里了，`onClick` 根本
   * 不会派发。表现就是「点布局菜单里任何一项都没反应」，而菜单自己好好地关掉了。
   * 传 ref 之后「点在菜单里」就被放过，click 才轮得到（右键菜单一直是这么用的）。
   */
  useDismiss(onClose, ref)

  const groups: Array<[number, PaneLayout[]]> = [1, 2, 3, 4].map((count) => [
    count,
    LAYOUT_ORDER.filter((key) => PANE_LAYOUTS[key].cells.length === count),
  ])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      className="fixed z-40 w-[340px] rounded-md border border-hairline bg-surface-1 p-2 text-[12px]"
    >
      {groups.map(([count, keys]) => (
        <div key={count} className="mb-1 last:mb-0">
          <div className="px-1 pb-1 text-[10px] text-ink-tertiary">{GROUP_LABEL[count]}</div>
          <div className="flex flex-wrap gap-1">
            {keys.map((key) => {
              const active = key === current
              return (
                <button
                  key={key}
                  role="menuitem"
                  title={PANE_LAYOUTS[key].label}
                  onClick={() => {
                    onClose()
                    onPick(key)
                  }}
                  className={`flex w-[76px] flex-col items-center gap-1 rounded-md border px-1 py-1.5 transition-colors ${
                    active
                      ? 'border-accent/60 bg-accent/10 text-ink'
                      : 'border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <LayoutIcon layout={key} size={22} className={active ? 'text-accent' : ''} />
                  <span className="text-[11px] leading-none">{PANE_LAYOUTS[key].label}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
