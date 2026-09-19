import { useEffect } from 'react'

/**
 * 「点外面 / Esc / 滚轮 / 失焦 / 改窗口大小就关掉」这套监听。
 *
 * 终端右键菜单（TerminalMenu）和分屏布局菜单（LayoutMenu）是同一套关闭时机 ——
 * 菜单挂着不动会盖住下一次点击，而每个入口各写一遍迟早有关不掉的框。
 * `layoutEffect` 不用：监听挂上的时机由调用方自己控制（打开它的那次点击
 * 不能立刻触发关闭，靠的是"监听那时还没挂上"）。
 */
export function useDismiss(onClose: () => void, ref?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      // 传了 ref 就"点在菜单里不关"（右键菜单要能点里面的项）；
      // 不传（或没量到）就任何按压都关（布局菜单的项自己会在 onClick 里先做事再关）
      if (ref && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onWheel = () => onClose()
    const onBlur = () => onClose()
    const onResize = () => onClose()
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose, ref])
}
