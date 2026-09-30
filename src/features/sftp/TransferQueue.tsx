import {
  Check,
  CopyPlus,
  History,
  ListX,
  Loader2,
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  MinusCircle,
  Replace,
  SkipForward,
  type LucideIcon,
} from 'lucide-react'
import { useApp } from '@/lib/store'
import type { ConflictPolicy } from '@/lib/api'
import { formatSize } from './FilePane'

interface Props {
  resume: boolean
  onToggleResume: () => void
  conflict: ConflictPolicy
  onConflictChange: (next: ConflictPolicy) => void
}

/**
 * 同名文件的三种处理方式，按「用户看到选项时的直觉」排序。
 * 一排文字按钮在右侧窄栏里挤不下，全换成图标 —— 名称与说明都在悬停提示里。
 */
const CONFLICT_OPTIONS: Array<{
  value: ConflictPolicy
  icon: LucideIcon
  label: string
  hint: string
}> = [
  { value: 'overwrite', icon: Replace, label: '覆盖', hint: '同名文件：目标已存在就直接覆盖' },
  { value: 'skip', icon: SkipForward, label: '跳过', hint: '同名文件：目标已存在就不动它，并在队列里标出来' },
  { value: 'keepBoth', icon: CopyPlus, label: '保留两者', hint: '同名文件：目标改名为「xxx (2)」，两份都留下' },
]

/** 顶部一排工具按钮的公共样式（与 FilePane 工具栏同款） */
const TOOL_BTN =
  'grid h-6 w-6 place-items-center rounded transition-colors hover:bg-surface-2 hover:text-ink'

export function TransferQueue({ resume, onToggleResume, conflict, onConflictChange }: Props) {
  const transfers = useApp((s) => s.transfers)
  const clearFinished = useApp((s) => s.clearFinished)

  const active = transfers.filter((t) => t.status === 'active')

  return (
    <div className="flex max-h-40 shrink-0 flex-col border-t border-hairline bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
          传输{active.length > 0 ? ` · ${active.length} 个进行中` : ''}
        </span>

        {/* 全是图标 + 悬停提示：右侧文件栏只有 240–560px 宽，文字按钮一排摆不下 */}
        <button
          onClick={onToggleResume}
          title="断点续传：只从上次没传完的 .part 文件接着传，不从头重传"
          data-transfer-resume
          className={`${TOOL_BTN} ${resume ? 'bg-accent/15 text-accent' : 'text-ink-tertiary'}`}
        >
          <History size={13} />
        </button>

        <div className="flex overflow-hidden rounded border border-hairline">
          {CONFLICT_OPTIONS.map((o) => {
            const Icon = o.icon
            return (
              <button
                key={o.value}
                onClick={() => onConflictChange(o.value)}
                title={o.hint}
                aria-label={o.label}
                data-transfer-conflict={o.value}
                className={`grid h-6 w-6 place-items-center transition-colors ${
                  conflict === o.value
                    ? 'bg-surface-3 text-ink'
                    : 'text-ink-tertiary hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <Icon size={12} />
              </button>
            )
          })}
        </div>

        <button
          onClick={clearFinished}
          title="清除已完成"
          data-transfer-clear
          className={`${TOOL_BTN} text-ink-tertiary`}
        >
          <ListX size={13} />
        </button>
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
              ) : t.direction === 'copy' ? (
                // 远程 → 远程对拷
                <ArrowRightLeft size={11} className="shrink-0 text-ink-tertiary" />
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

              {/* 跳过的文件要显出来：以前是发个 progress 假装传过了，用户以为传上了 */}
              {t.skipped > 0 && t.status !== 'error' && (
                <span
                  className="flex shrink-0 items-center gap-1 text-[11px] text-ink-tertiary"
                  title={t.skipHint ? `最近一个：${t.skipHint}` : undefined}
                >
                  <MinusCircle size={11} />
                  跳过 {t.skipped}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
