import { useState } from 'react'

/**
 * 设置面板的通用控件。
 *
 * 从 `SettingsDialog.tsx` 里抽出来的：终端配色那节（`TermSchemeSection`）也要用
 * `Segmented` 和 `Section`，与其抄一份宽度、圆角、间距各不相同的，不如放一处共用。
 */

/** 分段按钮组：选项少、需要一眼看全，比下拉合适 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-hairline p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`h-6 rounded px-2 text-[12px] transition-colors ${
            value === o.value
              ? 'bg-accent/15 text-ink'
              : 'text-ink-subtle hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 数字输入：右侧带单位，失焦/回车时夹到范围里 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  suffix,
  width = 88,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  width?: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  // 外部改了（比如点了恢复默认）要跟上，但不能在输入过程中打断
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(String(value))
  }

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, n))
    setDraft(String(clamped))
    onCommit(clamped)
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        style={{ width }}
        className="h-7 rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink outline-none focus:border-accent"
      />
      {suffix && <span className="text-[11px] text-ink-tertiary">{suffix}</span>}
    </div>
  )
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[12px] text-ink-muted">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-ink-tertiary">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">{title}</div>
      <div className="divide-y divide-hairline rounded-md border border-hairline px-3">
        {children}
      </div>
    </div>
  )
}
