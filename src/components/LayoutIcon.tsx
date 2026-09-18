import { PANE_LAYOUTS, type PaneLayout } from '@/lib/store'

interface Props {
  layout: PaneLayout
  /** 边长（px）。标签栏按钮用 12，菜单里用 14 */
  size?: number
  className?: string
}

/**
 * 把一种分屏形状画成小示意图。
 *
 * 直接用 `PANE_LAYOUTS` 里那份格子数据算位置 —— 加一种形状只要往那张表里加一行，
 * 图标、网格、菜单就都跟着有了，不用另画一套图（这也是没做成 SVG 图标集的原因：
 * 形状一多，手画的图标跟真实布局迟早对不上）。
 *
 * 颜色用 `bg-current`：谁用谁决定颜色（标签栏里是强调色 / 灰，菜单里跟着文字色）。
 */
export function LayoutIcon({ layout, size = 14, className = '' }: Props) {
  const spec = PANE_LAYOUTS[layout]
  // 格子之间留 1px 缝，不然几格并在一起看不出分界（尤其单格和四宫格）
  const gap = '1px'

  return (
    <span
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {spec.cells.map((cell, i) => (
        <span
          key={i}
          className="absolute rounded-[1px] bg-current"
          style={{
            left: `calc(${((cell.c - 1) / spec.cols) * 100}% + ${gap})`,
            top: `calc(${((cell.r - 1) / spec.rows) * 100}% + ${gap})`,
            width: `calc(${((cell.cs ?? 1) / spec.cols) * 100}% - ${gap} * 2)`,
            height: `calc(${((cell.rs ?? 1) / spec.rows) * 100}% - ${gap} * 2)`,
            opacity: 0.85,
          }}
        />
      ))}
    </span>
  )
}
