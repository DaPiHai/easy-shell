import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  ArrowUp,
  File as FileIcon,
  FileCode2,
  Folder,
  FolderPlus,
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { FileEntry } from '@/lib/api'

export type Side = 'local' | 'remote'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

function formatTime(unix: number | null): string {
  if (!unix) return '—'
  const d = new Date(unix * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 同时吃 Windows 反斜杠和 Unix 斜杠，切成面包屑 */
export function splitPath(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean)
}

export function parentPath(path: string): string | null {
  const parts = splitPath(path)
  if (parts.length === 0) return null
  const isUnc = path.startsWith('\\\\')
  if (parts.length === 1) {
    // C:\ 或 / 已经到根了
    return isUnc ? null : path.endsWith('/') || /^[A-Za-z]:$/.test(parts[0]) ? null : '/'
  }
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const parent = idx > 0 ? trimmed.slice(0, idx) : trimmed.slice(0, idx + 1)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || '/'
}

interface FilePaneProps {
  side: Side
  title: string
  path: string
  entries: FileEntry[]
  loading: boolean
  selected: string[]
  onSelect: (paths: string[]) => void
  onActivate: (entry: FileEntry) => void
  onNavigate: (path: string) => void
  onRefresh: () => void
  onMkdir: () => void
  onDelete: () => void
  onRename: () => void
  onEdit: () => void
  /**
   * 按下某一行的瞬间，交给上层去准备拖拽。
   *
   * 这里**刻意不用 HTML5 拖拽**：Tauri 的原生文件拖放处理器开着的时候，
   * Windows 上 WebView2 的内部拖拽会被 OLE 判成"不可放置"而整个失效
   * （见 wry 的 DragEnter：拿不到文件名就直接 return，一个 pdwEffect 都不设）。
   * 而那个处理器又是从资源管理器拖文件进来的唯一途径。两者只能保一个，
   * 所以内部拖拽改用鼠标事件自己实现，谁都不耽误。
   */
  onRowMouseDown: (e: ReactMouseEvent, entry: FileEntry) => void
  /** 当前是不是拖拽的落点，用来画高亮框 */
  dropActive: boolean
  paneRef: React.Ref<HTMLDivElement>
  toolbar?: ReactNode
  /** 当前排序方式。不传就是后端给的顺序（目录在前 + 名称升序） */
  sort?: SortState
  onSort?: (key: SortKey) => void
}

export type SortKey = 'name' | 'size' | 'modified'
export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** 表头单元格：点了就按这一列排（再点一次反向），带个箭头说明当前状态 */
function SortHeader({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string
  col: SortKey
  sort?: SortState
  onSort?: (key: SortKey) => void
  className: string
}) {
  const active = sort?.key === col
  return (
    <th className={className}>
      <button
        onClick={() => onSort?.(col)}
        disabled={!onSort}
        className={`inline-flex items-center gap-0.5 transition-colors ${
          onSort ? 'hover:text-ink' : ''
        } ${active ? 'text-ink-muted' : ''}`}
        title={onSort ? `按${label}排序` : undefined}
      >
        {label}
        {active && <span className="text-[9px]">{sort?.dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )
}

export function FilePane({
  side,
  title,
  path,
  entries,
  loading,
  selected,
  onSelect,
  onActivate,
  onNavigate,
  onRefresh,
  onMkdir,
  onDelete,
  onRename,
  onEdit,
  onRowMouseDown,
  sort,
  onSort,
  dropActive,
  paneRef,
  toolbar,
}: FilePaneProps) {
  return (
    <div ref={paneRef} className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2">
        <span className="text-[11px] font-medium tracking-[0.4px] text-ink-subtle">{title}</span>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {splitPath(path).map((seg, i) => (
            <span key={`${seg}-${i}`} className="flex shrink-0 items-center gap-1">
              {i > 0 && <span className="text-ink-tertiary">/</span>}
              <button
                onClick={() => {
                  const parts = splitPath(path).slice(0, i + 1)
                  const sep = side === 'remote' ? '/' : path.includes('\\') ? '\\' : '/'
                  const rebuilt =
                    side === 'remote'
                      ? `/${parts.join('/')}`
                      : parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])
                        ? `${parts[0]}\\`
                        : parts.join(sep)
                  onNavigate(rebuilt)
                }}
                className="max-w-32 truncate rounded px-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {seg}
              </button>
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {toolbar}
          <button
            onClick={onMkdir}
            title="新建目录"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <FolderPlus size={13} />
          </button>
          <button
            onClick={onEdit}
            disabled={selected.length !== 1}
            title="在内置编辑器里打开"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-subtle"
          >
            <FileCode2 size={13} />
          </button>
          <button
            onClick={onRename}
            disabled={selected.length !== 1}
            title="重命名"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-subtle"
          >
            <PencilLine size={13} />
          </button>
          <button
            onClick={onDelete}
            disabled={selected.length === 0}
            title="删除所选"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-subtle"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={onRefresh}
            title="刷新"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            onClick={() => {
              const parent = parentPath(path)
              if (parent) onNavigate(parent)
            }}
            disabled={!parentPath(path)}
            title="上一级"
            className="grid h-6 w-6 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ArrowUp size={13} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && entries.length === 0 ? (
          <div className="grid h-full place-items-center text-ink-tertiary">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <p className="grid h-full place-items-center text-[12px] text-ink-tertiary">空目录</p>
        ) : (
          <table className="select-none w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-canvas">
              <tr className="text-ink-tertiary">
                <SortHeader
                  label="名称"
                  col="name"
                  sort={sort}
                  onSort={onSort}
                  className="border-b border-hairline px-2 py-1.5 text-left font-medium"
                />
                <SortHeader
                  label="大小"
                  col="size"
                  sort={sort}
                  onSort={onSort}
                  className="w-20 border-b border-hairline px-2 py-1.5 text-right font-medium"
                />
                <SortHeader
                  label="修改时间"
                  col="modified"
                  sort={sort}
                  onSort={onSort}
                  className="w-28 border-b border-hairline px-2 py-1.5 text-left font-medium"
                />
                <th className="w-20 border-b border-hairline px-2 py-1.5 text-left font-medium">
                  权限
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const active = selected.includes(entry.path)
                return (
                  <tr
                    key={entry.path}
                    onMouseDown={(e) => onRowMouseDown(e, entry)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) {
                        onSelect(
                          active
                            ? selected.filter((p) => p !== entry.path)
                            : [...selected, entry.path],
                        )
                      } else {
                        onSelect([entry.path])
                      }
                    }}
                    onDoubleClick={() => onActivate(entry)}
                    className={`cursor-default border-b border-hairline/40 transition-colors ${
                      active ? 'bg-accent/15' : 'hover:bg-surface-1'
                    }`}
                  >
                    <td className="max-w-0 truncate px-2 py-1">
                      <span className="flex items-center gap-1.5">
                        {entry.isDir ? (
                          <Folder size={13} className="shrink-0 text-ink-subtle" />
                        ) : (
                          <FileIcon size={13} className="shrink-0 text-ink-tertiary" />
                        )}
                        <span className={active ? 'text-ink' : 'text-ink-muted'}>{entry.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[11px] text-ink-tertiary">
                      {entry.isDir ? '—' : formatSize(entry.size)}
                    </td>
                    <td className="px-2 py-1 text-[11px] text-ink-tertiary">
                      {formatTime(entry.modified)}
                    </td>
                    <td className="px-2 py-1 font-mono text-[11px] text-ink-tertiary">
                      {entry.mode ?? '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {dropActive && (
        <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent bg-accent/5" />
      )}
    </div>
  )
}
