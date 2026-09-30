import {
  Command,
  FileCode2,
  ListChecks,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SquareTerminal,
  Terminal,
} from 'lucide-react'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, panesOf, terminalTab, useApp } from '@/lib/store'
import { SchemeMenu } from '@/features/settings/SchemeMenu'

const isMac = navigator.platform.toLowerCase().includes('mac')
const modKey = isMac ? '⌘' : 'Ctrl'

export function EmptyState() {
  const { setPaletteOpen, setConnectOpen, openLocalFileDialog, addTab, sidebarCollapsed } = useApp()

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
        {/* 侧栏收起时还写「从左侧选择主机」就是在指一个不存在的东西 */}
        <p className="mt-1 text-[12px] text-ink-subtle">
          {sidebarCollapsed ? '侧栏已收起，展开后选主机，或打开命令面板' : '从左侧选择主机，或打开命令面板'}
        </p>

        <div className="mx-auto mt-6 flex w-fit flex-col gap-2 text-[12px] text-ink-tertiary">
          {/* 收起侧栏后空状态就是唯一的落点，这里补一条回去的路 */}
          {sidebarCollapsed && (
            <button onClick={() => useApp.getState().toggleSidebar()} className={rowClass}>
              <PanelLeftOpen size={13} className="shrink-0" />
              <span>展开会话侧栏</span>
              <kbd className={kbdClass}>{modKey} ⇧ B</kbd>
            </button>
          )}
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
            onClick={() => addTab(terminalTab({ title: '本地 Shell', kind: 'local' }))}
            className={rowClass}
          >
            <SquareTerminal size={13} className="shrink-0" />
            <span>本地 Shell</span>
          </button>
          <button onClick={() => useApp.getState().openBatchTab()} className={rowClass}>
            <ListChecks size={13} className="shrink-0" />
            <span>批量执行</span>
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
  const {
    theme,
    toggleTheme,
    tabs,
    activeTabId,
    lockVault,
    termFontSize,
    setTermFontSize,
    bumpTermFontSize,
    sidebarCollapsed,
    toggleSidebar,
    findPaneId,
    focusedPane,
  } = useApp()
  // 写死"未连接"是纯假信息 —— 至少把当前这个标签是什么说清楚
  const active = tabs.find((t) => t.id === activeTabId)
  const panes = panesOf(active)
  // 当前聚焦的那一格：查找、片段投递都以它为准，状态栏显示它连的是谁
  const focused =
    panes.find((p) => p.id === focusedPane[active?.id ?? '']) ?? panes[0] ?? null
  // 焦点所在的那一格能不能搜（远程 / 本地终端都有 xterm 的查找）
  const findable = !!focused
  const findOpen = !!focused && findPaneId === focused.id
  // 标签类型跟着**聚焦那一格**走，不跟着标签自己的 kind：把本地 Shell 并进远程标签之后
  // （或反过来），标签的 kind 只代表它是怎么建出来的，状态栏写错就等于骗人
  const kindLabel = !active
    ? null
    : active.kind === 'sftp'
      ? 'SFTP'
      : active.kind === 'editor'
        ? '编辑器'
        : focused?.kind === 'local'
          ? '本地 Shell'
          : 'SSH'
  // 分屏时标出聚焦的是哪一格 —— 否则状态栏写的还是标签原本那台机器，跟手里的终端对不上
  const detail = !active
    ? '未连接'
    : focused && panes.length > 1
      ? `${kindLabel} · ${focused.title}（${panes.length} 格）`
      : `${kindLabel} · ${active.title}`

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-hairline bg-surface-1 px-3 text-[11px] text-ink-subtle">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-success' : 'bg-ink-tertiary'}`}
        />
        <span className="truncate">{detail}</span>
      </div>
      <div className="flex items-center gap-3">
        {/*
          命令面板的常驻入口。以前只有空状态里有按钮，一开标签就只剩 Ctrl+K ——
          而命令面板恰恰是"不知道有什么功能时用的东西"，它自己最不该依赖记忆。
          放状态栏而不是侧栏头：侧栏一收起侧栏头整个不渲染，这里才是常驻的把手。
        */}
        <button
          onClick={() => useApp.getState().setPaletteOpen(true)}
          className="flex items-center gap-1 transition-colors hover:text-ink"
          title="命令面板（Ctrl+K）"
        >
          <Command size={11} />
          命令
        </button>
        {/*
          侧栏收起后这里就是唯一的常驻入口 —— 快捷键和命令面板都是"知道才用得上"的，
          侧栏一没就再没有看得见的把手了。图标方向跟着当前状态走：现在开着就是往左收。
        */}
        <button
          onClick={toggleSidebar}
          className="flex items-center gap-1 transition-colors hover:text-ink"
          title={`${sidebarCollapsed ? '展开' : '收起'}会话侧栏（Ctrl+Shift+B）`}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={11} /> : <PanelLeftClose size={11} />}
          侧栏
        </button>
        {/*
          终端内查找：此前连快捷键都没有，等于没有入口。非终端标签置灰 ——
          编辑器有自己的 Ctrl+F，SFTP 还没有，别给假按钮。
        */}
        <button
          onClick={() => useApp.getState().toggleFind()}
          disabled={!findable}
          className={`flex items-center gap-1 transition-colors hover:text-ink disabled:opacity-40 disabled:hover:text-ink-subtle ${
            findOpen ? 'text-ink' : ''
          }`}
          title={
            findable
              ? '在当前终端里查找（Ctrl+Shift+F）'
              : '查找只对终端标签有效（编辑器用 Ctrl+F）'
          }
        >
          <Search size={11} />
          查找
        </button>
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
          {/* 当前值本身可点复位：以前只有 Ctrl+0 和命令面板能回到默认字号 */}
          <button
            onClick={() => setTermFontSize(DEFAULT_FONT_SIZE)}
            className="w-8 text-center text-ink-tertiary transition-colors hover:text-ink"
            title={`复位终端字号（Ctrl+0）· 默认 ${DEFAULT_FONT_SIZE}px`}
          >
            {termFontSize}px
          </button>
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
        <span className="text-ink-tertiary">v0.1.2</span>
      </div>
    </footer>
  )
}
