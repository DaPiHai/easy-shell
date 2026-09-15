import { Command } from 'cmdk'
import {
  ArrowRightLeft,
  Columns,
  FileCode2,
  FolderOpen,
  Plus,
  ScrollText,
  SunMoon,
  TerminalSquare,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useApp } from '@/lib/store'
import { isDesktop, pickFile } from '@/lib/api'

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    toggleTheme,
    theme,
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
                onSelect={async () => {
                  close()
                  // 内置编辑器不一定非要从 SFTP 进，本机文件也能直接开
                  if (!isDesktop()) {
                    useApp.getState().setError('文件选择只在桌面版可用')
                    return
                  }
                  const path = await pickFile('打开文件')
                  if (!path) return
                  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
                  useApp.getState().addTab({
                    title: name,
                    kind: 'editor',
                    editorTarget: { side: 'local', path, sftpId: null },
                  })
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
                  // SFTP 复用当前终端那条的 SSH 连接，没连上就无从谈起
                  const current = s.tabs.find((t) => t.id === s.activeTabId)
                  const sessionId = current?.sessionId
                  if (!sessionId) {
                    s.setError('先连一台主机 —— SFTP 要复用它的 SSH 连接')
                    close()
                    return
                  }
                  s.addTab({
                    title: `${current?.title ?? 'SFTP'} · 文件`,
                    kind: 'sftp',
                    sessionId,
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
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
