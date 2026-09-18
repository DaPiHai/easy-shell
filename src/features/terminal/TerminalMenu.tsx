import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface TerminalMenuItem {
  label: string
  /** 右侧的快捷键提示 */
  hint?: string
  disabled?: boolean
  /** 危险动作（重置终端），标红 */
  danger?: boolean
  onSelect: () => void
}

interface Props {
  /** 鼠标位置（clientX/clientY，逻辑像素） */
  x: number
  y: number
  items: TerminalMenuItem[]
  onClose: () => void
}

/** 离窗口边缘至少留这么多，贴边时往里收 */
const EDGE = 8

/**
 * 终端右键菜单。
 *
 * 为什么自己画一个而不是用系统的：xterm 对右键只做了一件事 —— 把选中文本塞进它藏的
 * textarea，好让**浏览器原生菜单**的「复制」能用，它并不拦原生菜单。于是现在右键弹的是
 * WebView2 的原生菜单（观感与应用对不上，也没有清屏/重置/查找这些终端该有的动作）。
 *
 * 定位用 `position: fixed`：终端容器是 `overflow-hidden`，但没有任何 transform，
 * fixed 不会被裁掉。
 */
export function TerminalMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [pos, setPos] = useState({ left: x, top: y, ready: false })

  /**
   * 先按鼠标位置渲染（先藏着），量出真实尺寸再夹到视口内。
   * 少了这一步，在窗口右下角右键就会有一半菜单在窗口外，点不到。
   */
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

  /** 打开就把焦点给第一项，键盘用户不用先 Tab 一圈 */
  useEffect(() => {
    itemRefs.current.find((el) => el && !el.disabled)?.focus()
  }, [])

  /**
   * 关闭时机。菜单挂着不动很烦：它盖在终端上，还挡着下一次点击。
   *
   * 打开它的那次右键不会误关 —— `mousedown` 早于 `contextmenu`，那时监听还没挂上。
   */
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown, true)
    // 滚轮：终端内容要跟着滚，菜单留在原地会跟内容错位
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  /** ↑/↓ 在可用的项之间循环（Enter 交给按钮自己的 click） */
  const move = (delta: number) => {
    const usable = itemRefs.current.filter(
      (el): el is HTMLButtonElement => !!el && !el.disabled,
    )
    if (usable.length === 0) return
    const current = usable.indexOf(document.activeElement as HTMLButtonElement)
    usable[current < 0 ? 0 : (current + delta + usable.length) % usable.length]?.focus()
  }

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        }
      }}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      className="fixed z-40 min-w-[176px] rounded-md border border-hairline bg-surface-1 py-1 text-[12px]"
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            itemRefs.current[i] = el
          }}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            // 先关再执行：选「重置终端」会弹确认框，菜单留在下面会挡住它
            onClose()
            item.onSelect()
          }}
          className={`flex w-full items-center gap-6 px-3 py-1.5 text-left transition-colors disabled:opacity-40 ${
            item.danger
              ? 'text-danger hover:bg-danger/10'
              : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
          } disabled:hover:bg-transparent disabled:hover:text-ink-muted`}
        >
          <span className="flex-1">{item.label}</span>
          {item.hint && <span className="shrink-0 text-[11px] text-ink-tertiary">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
