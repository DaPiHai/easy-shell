import { FileCode2, Lock, SquareTerminal, Terminal } from 'lucide-react'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, useApp } from '@/lib/store'
import { SchemeMenu } from '@/features/settings/SchemeMenu'

const isMac = navigator.platform.toLowerCase().includes('mac')
const modKey = isMac ? '⌘' : 'Ctrl'

export function EmptyState() {
  const { setPaletteOpen, setConnectOpen, openLocalFileDialog, addTab } = useApp()

  const rowClass =
    'flex items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-surface-1 hover:text-ink-muted'
  const kbdClass =
    'rounded border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]'

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
          <button onClick={() => setPaletteOpen(true)} className={rowClass}>
            <kbd className={kbdClass}>{modKey} K</kbd>
            <span>命令面板</span>
          </button>
          {/* 这三条以前只有前两条，而且「新建会话」实际打开的是命令面板 */}
          <button onClick={() => setConnectOpen(true)} className={rowClass}>
            <kbd className={kbdClass}>{modKey} N</kbd>
            <span>新建会话</span>
          </button>
          <button
            onClick={() => addTab({ title: '本地 Shell', kind: 'local' })}
            className={rowClass}
          >
            <SquareTerminal size={13} className="shrink-0" />
            <span>本地 Shell</span>
          </button>
          <button onClick={() => void openLocalFileDialog()} className={rowClass}>
            <FileCode2 size={13} className="shrink-0" />
            <span>打开本地文件…</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function StatusBar() {
  const { theme, toggleTheme, tabs, activeTabId, lockVault, termFontSize, bumpTermFontSize } =
    useApp()
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
        {/* 字号以前只有 Ctrl+= / Ctrl+- / Ctrl+0 三个快捷键，界面上没有任何入口 */}
        <div className="flex items-center gap-1" title={`终端字号 ${termFontSize}px`}>
          <button
            onClick={() => bumpTermFontSize(-1)}
            disabled={termFontSize <= MIN_FONT_SIZE}
            className="px-0.5 transition-colors hover:text-ink disabled:opacity-40 disabled:hover:text-ink-subtle"
            title="缩小终端字号（Ctrl -）"
          >
            A-
          </button>
          <span className="w-8 text-center text-ink-tertiary">{termFontSize}px</span>
          <button
            onClick={() => bumpTermFontSize(1)}
            disabled={termFontSize >= MAX_FONT_SIZE}
            className="px-0.5 transition-colors hover:text-ink disabled:opacity-40 disabled:hover:text-ink-subtle"
            title="放大终端字号（Ctrl +）"
          >
            A+
          </button>
        </div>
        <button
          onClick={() => void lockVault()}
          className="flex items-center gap-1 transition-colors hover:text-ink"
          title="锁定密钥库并关闭所有连接"
        >
          <Lock size={11} />
          锁定
        </button>
        {/* 终端配色：状态栏是随手切一下的地方，详细的预览在设置面板里 */}
        <SchemeMenu mode={theme} />
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
