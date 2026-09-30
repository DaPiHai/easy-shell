import { PANE_LAYOUTS, type LayoutSpec, type PaneLayout } from '@/lib/store'

interface Props {
  /** 预设形状的名字。给 `spec` 时不看它 */
  layout?: PaneLayout
  /**
   * 直接给格子表。
   *
   * 拖拽切出来的自定义排布没有名字（`Tab.layoutSpec`），只有表 —— 标签栏那个图标
   * 得画**真实**的形状，不能拿"最像的预设"糊弄（用户一眼就能看出格子对不上）。
   */
  spec?: LayoutSpec
  /** 边长（px）。标签栏按钮用 12，菜单里用 14 */
  size?: number
  className?: string
}

/**
 * 把一种分屏形状画成小示意图。
 *
 * 直接用形状表里那份格子数据算位置 —— 加一种形状只要往 `PANE_LAYOUTS` 里加一行，
 * 图标、网格、菜单就都跟着有了，不用另画一套图（这也是没做成 SVG 图标集的原因：
 * 形状一多，手画的图标跟真实布局迟早对不上）。
 *
 * 颜色用 `bg-current`：谁用谁决定颜色（标签栏里是强调色 / 灰，菜单里跟着文字色）。
 */
export function LayoutIcon({ layout, spec: wanted, size = 14, className = '' }: Props) {
  const spec = wanted ?? PANE_LAYOUTS[layout ?? 'single']
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
