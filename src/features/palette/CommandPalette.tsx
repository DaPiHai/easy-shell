import { Command } from 'cmdk'
import {
  ArrowRightLeft,
  Columns,
  FileCode2,
  FolderOpen,
  FolderPlus,
  Lock,
  Plus,
  RotateCcw,
  ScrollText,
  Settings,
  SunMoon,
  TerminalSquare,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useApp } from '@/lib/store'
import { listSchemeChoices } from '@/lib/termSchemes'
import { Swatches } from '../settings/Swatches'

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    toggleTheme,
    theme,
    termScheme,
    setTermScheme,
    customSchemes,
    setConnectOpen,
    setTunnelOpen,
    setSnippetsOpen,
  } = useApp()

  if (!paletteOpen) return null

  const close = () => setPaletteOpen(false)

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="absolute left-1/2 top-[18%] w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-hairline-tertiary bg-surface-1">
        <Command>
          <Command.Input
            autoFocus
            placeholder="输入命令或搜索…"
            className="h-11 w-full border-b border-hairline bg-transparent px-4 text-[13px] text-ink outline-none placeholder:text-ink-tertiary"
          />
          <Command.List className="max-h-80 overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-[12px] text-ink-tertiary">
              没有匹配的命令
            </Command.Empty>

            <Command.Group heading="会话">
              <Command.Item
                onSelect={() => {
                  setConnectOpen(true)
                  close()
                }}
              >
                <Plus size={14} />
                新建会话
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  useApp.getState().addTab({ title: '本地 Shell', kind: 'local' })
                  close()
                }}
              >
                <TerminalSquare size={14} />
                新建本地 Shell
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  // 分组取名走自绘输入弹窗，逻辑在 store 里
                  useApp.getState().promptNewGroup()
                  close()
                }}
              >
                <FolderPlus size={14} />
                新建分组
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  const { activeTabId, requestCloseTab } = useApp.getState()
                  close()
                  if (activeTabId) requestCloseTab(activeTabId)
                }}
              >
                <X size={14} />
                关闭当前标签
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl W</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="视图">
              <Command.Item
                onSelect={() => {
                  useApp.getState().bumpTermFontSize(1)
                  close()
                }}
              >
                <ZoomIn size={14} />
                放大终端字号
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl +</span>
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  useApp.getState().bumpTermFontSize(-1)
                  close()
                }}
              >
                <ZoomOut size={14} />
                缩小终端字号
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl -</span>
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  useApp.getState().setTermFontSize(13)
                  close()
                }}
              >
                <RotateCcw size={14} />
                复位终端字号
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl 0</span>
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  close()
                  // 逻辑在 store 里：侧栏工具区和空状态也要用同一套
                  void useApp.getState().openLocalFileDialog()
                }}
              >
                <FileCode2 size={14} />
                打开本地文件…
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  setSnippetsOpen(true)
                  close()
                }}
              >
                <ScrollText size={14} />
                命令片段
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  setTunnelOpen(true)
                  close()
                }}
              >
                <ArrowRightLeft size={14} />
                端口转发
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  const s = useApp.getState()
                  // SFTP 复用已有 SSH 连接。优先用当前标签那条；
                  // 停在别的标签（本地 Shell、编辑器）时 current 没有 sessionId，
                  // 但机器可能还连着 —— 这时该复用任意一条活着的，
                  // 而不是报「先连一台主机」，那句提示在明明连着的时候是错的。
                  const current = s.tabs.find((t) => t.id === s.activeTabId)
                  const target =
                    (current?.sessionId && !s.deadTabs[current.id] ? current : undefined) ??
                    s.tabs.find((t) => t.sessionId && !s.deadTabs[t.id])
                  if (!target?.sessionId) {
                    s.setError('还没有连上的主机 —— SFTP 要复用 SSH 连接，先 Ctrl+N 连一台')
                    close()
                    return
                  }
                  s.addTab({
                    title: `${target.title} · 文件`,
                    kind: 'sftp',
                    sessionId: target.sessionId,
                    hostId: target.hostId,
                  })
                  close()
                }}
              >
                <FolderOpen size={14} />
                打开 SFTP 双栏
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  const s = useApp.getState()
                  if (s.activeTabId) s.toggleSplit(s.activeTabId)
                  close()
                }}
              >
                <Columns size={14} />
                切换分屏
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  toggleTheme()
                  close()
                }}
              >
                <SunMoon size={14} />
                切换到{theme === 'dark' ? '浅色' : '深色'}主题
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  useApp.getState().setSettingsOpen(true)
                  close()
                }}
              >
                <Settings size={14} />
                设置
              </Command.Item>
            </Command.Group>

            <Command.Group heading="终端配色">
              {listSchemeChoices(theme, customSchemes).map((c) => (
                <Command.Item
                  key={c.id}
                  // cmdk 按条目文字过滤，只写方案名的话搜「配色」「颜色」都找不到它们
                  keywords={['配色', '颜色', '终端配色', c.name, c.variant]}
                  onSelect={() => {
                    setTermScheme(c.id)
                    close()
                  }}
                >
                  <Swatches palette={c.palette} count={8} width={5} height={9} />
                  {c.name}
                  {c.id === termScheme && (
                    <span className="ml-auto text-[11px] text-ink-tertiary">当前</span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="安全">
              <Command.Item
                onSelect={() => {
                  close()
                  void useApp.getState().lockVault()
                }}
              >
                <Lock size={14} />
                锁定密钥库
                <span className="ml-auto text-[11px] text-ink-tertiary">关闭所有连接</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
