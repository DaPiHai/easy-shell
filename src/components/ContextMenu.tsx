import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { useDismiss } from '@/components/useDismiss'

/**
 * 应用里所有右键菜单的公共外壳。
 *
 * 原来只有终端有一份（`features/terminal/TerminalMenu.tsx`），别的区域右键弹的是
 * **WebView2 的原生菜单** —— 「刷新 / 另存为 / 打印 / 检查」这种跟 SSH 客户端
 * 毫无关系的东西。要做成一致的观感就得让各处共用同一个件，而不是各画一个。
 *
 * 自己画而不是用系统的还有个现实理由：终端那处必须自己来（xterm 不拦原生菜单，
 * 它只把选中文本塞进隐藏的 textarea 好让原生「复制」能用），既然终端躲不开，
 * 就别让其余区域长得跟它不一样。
 */

/** 菜单里的一项。分隔线是同一数组里的另一种元素，顺序就是画出来的顺序 */
export type MenuEntry =
  | { separator: true }
  | {
      /**
       * 显式写上 `undefined` 才能用 `entry.separator` 做判别式收窄 ——
       * 只在一边出现的字段不算判别式，TS 会直接报"属性不存在"。
       */
      separator?: undefined
      label: string
      /** 右侧的灰色提示：通常是快捷键，也可以是"这项为什么是灰的" */
      hint?: string
      /** 前置图标 */
      icon?: ReactNode
      /** 当前生效的那一项，右侧给个勾 */
      checked?: boolean
      disabled?: boolean
      /** 危险动作（删除 / 重置），标红 */
      danger?: boolean
      /**
       * 子菜单。**只支持一层** —— 再多就该换个对话框，而不是继续往右伸。
       * 有 children 的项点击不执行任何事，只负责展开
       */
      children?: MenuEntry[]
      onSelect?: () => void
      /** 探针（tools/probe.mjs）定位用的锚点，写成稳定的英文短名 */
      testId?: string
    }

/** 分隔线。写成函数是为了让调用点的数组字面量短一点 */
export const sep = (): MenuEntry => ({ separator: true })

/** 只挑能点的项：分隔线没有 ref，灰掉的按钮带 disabled */
function focusable(refs: Array<HTMLButtonElement | null>): HTMLButtonElement[] {
  return refs.filter((el): el is HTMLButtonElement => !!el && !el.disabled)
}

/**
 * 在 `onContextMenu` 里调它，代替自己写 `preventDefault` + 取坐标。
 *
 * 返回 null 表示这次右键**不该**开菜单：点在了已经打开的菜单上。
 * 不挡的话菜单会跳到光标底下（右键→菜单移动→又在新位置右键，会一直飘）。
 */
export function menuAt(e: React.MouseEvent): { x: number; y: number } | null {
  const el = e.target as HTMLElement | null
  if (el?.closest('[role="menu"]')) return null
  e.preventDefault()
  // 挡住外层容器：终端外壳、SFTP 面板各自都挂了 onContextMenu，
  // 不拦的话内层开了菜单、外层再开一个，两个重叠在一起
  e.stopPropagation()
  return { x: e.clientX, y: e.clientY }
}

interface Props {
  /** 鼠标位置（clientX/clientY，逻辑像素） */
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

/** 离窗口边缘至少留这么多，贴边时往里收 */
const EDGE = 8

/**
 * 右键菜单。
 *
 * 定位用 `position: fixed`：终端容器是 `overflow-hidden`，但没有任何 transform，
 * fixed 不会被裁掉。子菜单同样用 fixed，位置按父项的实际矩形算出来 ——
 * 用 absolute 嵌在列表项里就没法在贴近窗口边缘时翻到左边去。
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const subRef = useRef<HTMLDivElement>(null)
  const subItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  /** 展开的子菜单挂在第几项上。null = 没展开 */
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })
  /**
   * 子菜单的位置。带着 `for`（它是为哪一项量的）——
   * 换了展开项时旧坐标立刻失效，就不会在量好之前先在错地方闪一下
   */
  const [subPos, setSubPos] = useState<{
    for: number
    left: number
    top: number
  } | null>(null)
  /** 键盘按 → 展开的才去抢焦点；鼠标悬停展开的不抢（那会把焦点从别处拽走） */
  const wantSubFocus = useRef(false)

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

  /** 子菜单：默认往右伸，右边放不下就翻到左边；纵向也夹一下 */
  useLayoutEffect(() => {
    if (openSub === null) return
    const item = itemRefs.current[openSub]
    const panel = subRef.current
    if (!item || !panel) return
    const r = item.getBoundingClientRect()
    const { width, height } = panel.getBoundingClientRect()
    const toRight = r.right + width + EDGE <= window.innerWidth
    setSubPos({
      for: openSub,
      left: toRight ? r.right - 4 : Math.max(EDGE, r.left - width + 4),
      top: Math.max(EDGE, Math.min(r.top - 4, window.innerHeight - height - EDGE)),
    })
  }, [openSub, items])

  /** 打开就把焦点给第一项，键盘用户不用先 Tab 一圈 */
  useEffect(() => {
    focusable(itemRefs.current)[0]?.focus()
  }, [])

  /** 键盘 → 展开的子菜单：焦点跟进去，否则方向键还是在动外层 */
  useEffect(() => {
    if (openSub === null || !wantSubFocus.current) return
    wantSubFocus.current = false
    focusable(subItemRefs.current)[0]?.focus()
  }, [openSub])

  /**
   * 关闭时机（监听在 useDismiss 里，全应用几个菜单共用同一套）。
   *
   * 打开它的那次右键不会误关 —— `mousedown` 早于 `contextmenu`，那时监听还没挂上。
   * ref 一定要传：不传就等于"任何按压都算点在菜单外面"，
   * mousedown 先把菜单关掉、React 随即卸载它，等 mouseup 到来时按钮已经不在 DOM 里，
   * onClick 根本不会派发（布局菜单当初就是栽在这儿）。
   */
  useDismiss(onClose, ref)

  const childrenOf = (entry: MenuEntry | undefined): MenuEntry[] | undefined =>
    entry && !entry.separator ? entry.children : undefined

  const subEntries = openSub !== null ? (childrenOf(items[openSub]) ?? []) : []

  /** ↑/↓ 在可用的项之间循环。焦点在子菜单里就动子菜单，两级各自独立绕圈 */
  const move = (delta: number) => {
    const inSub = !!subRef.current?.contains(document.activeElement)
    const list = focusable(inSub ? subItemRefs.current : itemRefs.current)
    if (list.length === 0) return
    const current = list.indexOf(document.activeElement as HTMLButtonElement)
    list[current < 0 ? 0 : (current + delta + list.length) % list.length]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'ArrowRight') {
      const index = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement)
      if (index >= 0 && childrenOf(items[index])) {
        e.preventDefault()
        wantSubFocus.current = true
        setOpenSub(index)
      }
    } else if (e.key === 'ArrowLeft' && openSub !== null) {
      // 退回外层，并停在刚展开的那一项上 —— 而不是把焦点丢回第一项
      e.preventDefault()
      const back = openSub
      setOpenSub(null)
      itemRefs.current[back]?.focus()
    }
  }

  /** 分隔线之外的那些项长什么样。外层和子菜单共用，免得两处样式漂移 */
  const renderRow = (
    entry: Exclude<MenuEntry, { separator: true }>,
    key: string,
    setRef: (el: HTMLButtonElement | null) => void,
    opts: { hasSub: boolean; onMouseEnter: () => void; onClick: () => void },
  ) => (
    <button
      key={key}
      ref={setRef}
      role="menuitem"
      type="button"
      disabled={entry.disabled}
      data-menu-item={entry.testId ?? entry.label}
      onMouseEnter={opts.onMouseEnter}
      onClick={opts.onClick}
      className={`flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors disabled:opacity-40 ${
        entry.danger
          ? 'text-danger hover:bg-danger/10'
          : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
      } disabled:hover:bg-transparent disabled:hover:text-ink-muted`}
    >
      {entry.icon}
      <span className="flex-1">{entry.label}</span>
      {entry.checked && <Check size={12} className="shrink-0 text-accent" />}
      {entry.hint && <span className="shrink-0 text-[11px] text-ink-tertiary">{entry.hint}</span>}
      {opts.hasSub && <ChevronRight size={12} className="shrink-0 text-ink-tertiary" />}
    </button>
  )

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      className="fixed z-40 max-h-[70vh] min-w-[176px] overflow-y-auto rounded-md border border-hairline bg-surface-1 py-1 text-[12px]"
    >
      {items.map((entry, i) => {
        if (entry.separator) {
          return <div key={`sep-${i}`} className="my-1 h-px bg-hairline" />
        }
        const kids = entry.children
        return renderRow(
          entry,
          `item-${i}`,
          (el) => {
            itemRefs.current[i] = el
          },
          {
            hasSub: !!kids,
            // 悬停展开是鼠标用户的主要路径（多点一下是白费的摩擦）；
            // 换到别的项上就收掉，跟系统菜单一个观感
            onMouseEnter: () => setOpenSub(kids ? i : null),
            onClick: () => {
              if (kids) {
                setOpenSub((cur) => (cur === i ? null : i))
                return
              }
              // 先关再执行：选「删除」会弹确认框，菜单留在下面会挡住它。
              // 子菜单第一层也一样，整棵一起收 —— 留着它挂在对话框后面很难看
              setOpenSub(null)
              onClose()
              entry.onSelect?.()
            },
          },
        )
      })}

      {openSub !== null && subEntries.length > 0 && (
        <div
          ref={subRef}
          role="menu"
          style={{
            left: subPos?.for === openSub ? subPos.left : 0,
            top: subPos?.for === openSub ? subPos.top : 0,
            visibility: subPos?.for === openSub ? 'visible' : 'hidden',
          }}
          className="fixed z-40 max-h-[70vh] min-w-[160px] overflow-y-auto rounded-md border border-hairline bg-surface-1 py-1 text-[12px]"
        >
          {subEntries.map((entry, i) => {
            if (entry.separator) {
              return <div key={`subsep-${i}`} className="my-1 h-px bg-hairline" />
            }
            return renderRow(
              entry,
              `sub-${i}`,
              (el) => {
                subItemRefs.current[i] = el
              },
              {
                hasSub: false,
                onMouseEnter: () => {},
                onClick: () => {
                  setOpenSub(null)
                  onClose()
                  entry.onSelect?.()
                },
              },
            )
          })}
        </div>
      )}
    </div>
  )
}
