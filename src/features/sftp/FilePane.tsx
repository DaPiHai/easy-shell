import { useState, type ReactNode } from 'react'
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
  onDropEntries: (entries: FileEntry[], from: Side) => void
  toolbar?: ReactNode
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
  onDropEntries,
  toolbar,
}: FilePaneProps) {
  const [dropActive, setDropActive] = useState(false)

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropActive(false)
        const raw = e.dataTransfer.getData('application/x-easy-shell')
        if (!raw) return
        try {
          const payload = JSON.parse(raw) as { from: Side; entries: FileEntry[] }
          if (payload.from === side) return
          onDropEntries(payload.entries, payload.from)
        } catch {
          /* 不是本应用的拖拽，忽略 */
        }
      }}
    >
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
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-canvas">
              <tr className="text-ink-tertiary">
                <th className="border-b border-hairline px-2 py-1.5 text-left font-medium">名称</th>
                <th className="w-20 border-b border-hairline px-2 py-1.5 text-right font-medium">
                  大小
                </th>
                <th className="w-28 border-b border-hairline px-2 py-1.5 text-left font-medium">
                  修改时间
                </th>
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
                    draggable
                    onDragStart={(e) => {
                      const payload = selected.includes(entry.path) ? selected : [entry.path]
                      const picked = entries.filter((x) => payload.includes(x.path))
                      e.dataTransfer.setData(
                        'application/x-easy-shell',
                        JSON.stringify({ from: side, entries: picked }),
                      )
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
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
        <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent" />
      )}
    </div>
  )
}
