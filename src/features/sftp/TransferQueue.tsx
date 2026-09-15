import { Check, Loader2, AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react'
import { useApp } from '@/lib/store'
import { formatSize } from './FilePane'

interface Props {
  resume: boolean
  onToggleResume: () => void
}

export function TransferQueue({ resume, onToggleResume }: Props) {
  const transfers = useApp((s) => s.transfers)
  const clearFinished = useApp((s) => s.clearFinished)

  const active = transfers.filter((t) => t.status === 'active')

  return (
    <div className="flex max-h-40 shrink-0 flex-col border-t border-hairline bg-surface-1">
      <div className="flex h-7 shrink-0 items-center justify-between px-3">
        <span className="text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
          传输{active.length > 0 ? ` · ${active.length} 个进行中` : ''}
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleResume}
            className="flex items-center gap-1 text-[11px] text-ink-tertiary transition-colors hover:text-ink"
            title="同名文件只补差量，不从头重传"
          >
            <span
              className={`h-2.5 w-2.5 rounded-sm border transition-colors ${
                resume ? 'border-accent bg-accent' : 'border-hairline-strong'
              }`}
            />
            断点续传
          </button>
          <button
            onClick={clearFinished}
            className="text-[11px] text-ink-tertiary transition-colors hover:text-ink"
          >
            清除已完成
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {transfers.length === 0 && (
          <p className="py-2 text-[11px] text-ink-tertiary">拖拽文件到对侧栏即可传输</p>
        )}

        {transfers.map((t) => {
          const pct = t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : 0
          return (
            <div key={t.id} className="mb-1.5 flex items-center gap-2">
              {t.status === 'active' ? (
                <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
              ) : t.status === 'done' ? (
                <Check size={12} className="shrink-0 text-success" />
              ) : (
                <AlertTriangle size={12} className="shrink-0 text-danger" />
              )}

              {t.direction === 'download' ? (
                <ArrowDown size={11} className="shrink-0 text-ink-tertiary" />
              ) : (
                <ArrowUp size={11} className="shrink-0 text-ink-tertiary" />
              )}

              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted" title={t.name}>
                {t.name}
              </span>

              <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                {formatSize(t.transferred)}
                {t.total > 0 ? ` / ${formatSize(t.total)}` : ''}
              </span>

              <div className="h-1 w-24 shrink-0 overflow-hidden rounded-pill bg-surface-3">
                <div
                  className={`h-full rounded-pill transition-[width] duration-150 ${
                    t.status === 'error' ? 'bg-danger' : t.status === 'done' ? 'bg-success' : 'bg-accent'
                  }`}
                  style={{ width: `${t.status === 'done' ? 100 : pct}%` }}
                />
              </div>

              {t.status === 'error' && t.message && (
                <span className="max-w-40 shrink-0 truncate text-[11px] text-danger" title={t.message}>
                  {t.message}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
