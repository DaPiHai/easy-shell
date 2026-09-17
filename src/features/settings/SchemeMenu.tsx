import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useApp } from '@/lib/store'
import { listSchemeChoices, type TermSchemeMode } from '@/lib/termSchemes'
import { Swatches } from './Swatches'

/**
 * 状态栏的配色切换按钮 + 弹出列表（含触发器，所以点按钮不会先关再开）。
 *
 * 列表比设置面板里的卡片小一号：名字 + 8 个常规色块。状态栏是随手切一下的地方，
 * 要挑细节请去设置面板。Esc 得自己处理 —— App 里那段全局 Esc 关的是各个弹窗，
 * 不管这个浮层。
 */
export function SchemeMenu({ mode }: { mode: TermSchemeMode }) {
  const termScheme = useApp((s) => s.termScheme)
  const customSchemes = useApp((s) => s.customSchemes)
  const setTermScheme = useApp((s) => s.setTermScheme)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choices = listSchemeChoices(mode, customSchemes)
  const current = choices.find((c) => c.id === termScheme) ?? choices[0]

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 transition-colors hover:text-ink"
        title={`终端配色：${current.name}（点开换一套）`}
      >
        <Swatches palette={current.palette} count={8} width={5} height={9} />
        {current.name}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 max-h-72 w-60 overflow-y-auto rounded-md border border-hairline-tertiary bg-surface-1 p-1">
          {choices.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setTermScheme(c.id)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-2 ${
                c.id === termScheme ? 'text-ink' : 'text-ink-muted'
              }`}
            >
              <Swatches palette={c.palette} count={8} width={6} height={10} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 text-[10px] text-ink-tertiary">{c.variant}</span>
              {c.id === termScheme && <Check size={12} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
