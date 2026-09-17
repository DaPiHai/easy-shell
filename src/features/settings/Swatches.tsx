import type { TermPalette } from '@/lib/termSchemes'

/** ANSI 色槽的顺序。前 8 个是常规色，后 8 个是亮色 */
const ANSI_KEYS: Array<keyof TermPalette> = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

/**
 * 一排 ANSI 小色块，用来一眼认出是哪套配色。
 *
 * 颜色只能走 inline style —— Tailwind 的工具类是构建时生成的静态类名，
 * 这里的色值是运行时从方案里取的，`bg-[...]` 也拿不到动态值。
 */
export function Swatches({
  palette,
  count = 16,
  width = 7,
  height = 10,
}: {
  palette: TermPalette
  count?: 8 | 16
  width?: number
  height?: number
}) {
  return (
    <span className="flex shrink-0 items-center gap-[2px]">
      {ANSI_KEYS.slice(0, count).map((key) => (
        <span
          key={key}
          className="rounded-[1px]"
          style={{ background: palette[key], width, height }}
        />
      ))}
    </span>
  )
}
