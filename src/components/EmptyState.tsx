import { Terminal } from 'lucide-react'
import { useApp } from '@/lib/store'

const isMac = navigator.platform.toLowerCase().includes('mac')
const modKey = isMac ? '⌘' : 'Ctrl'

export function EmptyState() {
  const { setPaletteOpen } = useApp()

  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-lg border border-hairline bg-surface-1">
          <Terminal size={20} className="text-ink-subtle" />
        </div>
        <p className="text-[14px] text-ink-muted">没有打开的会话</p>
        <p className="mt-1 text-[12px] text-ink-subtle">
          从左侧选择主机，或打开命令面板
        </p>

        <div className="mx-auto mt-6 flex w-fit flex-col gap-2 text-[12px] text-ink-tertiary">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-surface-1 hover:text-ink-muted"
          >
            <kbd className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
              {modKey} K
            </kbd>
            <span>命令面板</span>
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-surface-1 hover:text-ink-muted"
          >
            <kbd className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
              {modKey} N
            </kbd>
            <span>新建会话</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function StatusBar() {
  const { theme, toggleTheme, tabs, activeTabId } = useApp()
  // 写死"未连接"是纯假信息 —— 至少把当前这个标签是什么说清楚
  const active = tabs.find((t) => t.id === activeTabId)
  const kindLabel = !active
    ? null
    : active.kind === 'local'
      ? '本地 Shell'
      : active.kind === 'sftp'
        ? 'SFTP'
        : active.kind === 'editor'
          ? '编辑器'
          : 'SSH'

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-hairline bg-surface-1 px-3 text-[11px] text-ink-subtle">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-success' : 'bg-ink-tertiary'}`}
        />
        <span className="truncate">
          {active ? `${kindLabel} · ${active.title}` : '未连接'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={toggleTheme}
          className="transition-colors hover:text-ink"
          title="切换主题"
        >
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
        <span className="text-ink-tertiary">v0.1.0</span>
      </div>
    </footer>
  )
}
