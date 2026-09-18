import { Command } from 'cmdk'
import {
  ArrowRightLeft,
  FileCode2,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  ScrollText,
  Search,
  Settings,
  SunMoon,
  TerminalSquare,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { isSplittable, panesOf, terminalTab, useApp, DEFAULT_FONT_SIZE, type PaneLayout } from '@/lib/store'
import { LayoutIcon } from '@/components/LayoutIcon'
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
    sidebarCollapsed,
    setConnectOpen,
    setTunnelOpen,
    setSnippetsOpen,
    vaultNoPassword,
  } = useApp()

  if (!paletteOpen) return null

  const close = () => setPaletteOpen(false)

  /**
   * 换分屏形状。守卫只有这一份：形状要在已有连接上再开 shell 才谈得上 ——
   * 不提示的话按下去什么都不发生，用户只会以为按键/菜单坏了。
   */
  const splitTo = (layout: PaneLayout) => {
    const s = useApp.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!isSplittable(tab)) {
      s.setError('分屏要在已有连接上再开一条 shell —— 本地 Shell 标签和文件面板没有这条路')
      return
    }
    s.setPaneLayout(tab.id, layout)
  }

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
                  useApp.getState().addTab(terminalTab({ title: '本地 Shell', kind: 'local' }))
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
                // cmdk 只按条目文字过滤，不写 keywords 的话搜「侧栏」「收起」都找不到它
                keywords={['侧栏', '侧边栏', '会话树', '收起', '展开', '布局', 'sidebar']}
                onSelect={() => {
                  useApp.getState().toggleSidebar()
                  close()
                }}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
                {sidebarCollapsed ? '展开会话侧栏' : '收起会话侧栏'}
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl Shift B</span>
              </Command.Item>
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
                  useApp.getState().setTermFontSize(DEFAULT_FONT_SIZE)
                  close()
                }}
              >
                <RotateCcw size={14} />
                复位终端字号
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl 0</span>
              </Command.Item>
              <Command.Item
                // cmdk 只按条目文字过滤，只写「查找」的话搜「搜索」「关键词」都找不到它
                keywords={['搜索', '查找', '关键词', 'search', 'find', '高亮']}
                onSelect={() => {
                  const s = useApp.getState()
                  close()
                  if (!s.findablePane()) {
                    s.setError('当前标签没有终端可搜 —— 编辑器用 Ctrl+F；SFTP 的搜索还没做')
                    return
                  }
                  s.toggleFind()
                }}
              >
                <Search size={14} />
                在终端中查找
                <span className="ml-auto text-[11px] text-ink-tertiary">Ctrl Shift F</span>
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
                  // SFTP 复用已有 SSH 连接。优先用当前标签**聚焦那一格**的会话；
                  // 停在别的标签（本地 Shell、编辑器）或者那一格断了时，
                  // 退而用任意一条活着的连接 —— 这时该复用而不是报「先连一台主机」，
                  // 那句提示在明明连着的时候是错的。四宫格下每格可能是不同主机，所以逐格找。
                  const live = (p: { sessionId?: string; id: string } | null | undefined) =>
                    !!p?.sessionId && !s.deadPanes[p.id]
                  const focused = s.activePane()
                  const target = live(focused)
                    ? focused
                    : s.tabs.flatMap(panesOf).find((p) => live(p))
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
              {/*
                分屏形状列成几条常用的（完整的十种在标签栏那个布局菜单里）：
                面板里适合放"最常用的那几个"，全铺开会淹没其他命令。
                共用下面这个守卫 —— 形状要在已有连接上再开 shell 才谈得上。
              */}
              <Command.Item
                keywords={['分屏', '左右', '两格', '竖直', 'split', 'columns']}
                onSelect={() => {
                  close()
                  splitTo('cols2')
                }}
              >
                <LayoutIcon layout="cols2" size={14} />
                左右二分
              </Command.Item>
              <Command.Item
                keywords={['分屏', '上下', '两格', '水平', 'split', 'rows']}
                onSelect={() => {
                  close()
                  splitTo('rows2')
                }}
              >
                <LayoutIcon layout="rows2" size={14} />
                上下二分
              </Command.Item>
              <Command.Item
                keywords={['分屏', '三格', '左一右二', '左右', 'split']}
                onSelect={() => {
                  close()
                  splitTo('left1Right2')
                }}
              >
                <LayoutIcon layout="left1Right2" size={14} />
                三格：左一右二
              </Command.Item>
              <Command.Item
                keywords={['分屏', '三格', '上一下二', '上下', 'split']}
                onSelect={() => {
                  close()
                  splitTo('top1Bottom2')
                }}
              >
                <LayoutIcon layout="top1Bottom2" size={14} />
                三格：上一下二
              </Command.Item>
              <Command.Item
                keywords={['分屏', '四宫格', '四格', '2x2', 'grid', 'quad']}
                onSelect={() => {
                  close()
                  splitTo('grid4')
                }}
              >
                <LayoutIcon layout="grid4" size={14} />
                四宫格
                <span className="ml-auto text-[11px] text-ink-tertiary">每格可连不同主机</span>
              </Command.Item>
              <Command.Item
                keywords={['分屏', '取消', '合并', '单格', 'unsplit']}
                onSelect={() => {
                  close()
                  splitTo('single')
                }}
              >
                <LayoutIcon layout="single" size={14} />
                取消分屏
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
                // cmdk 只按条目文字过滤，只写「修改主密码」的话搜「改密码」「密码」都找不到它
                keywords={['改密码', '密码', '主密码', '密钥库', 'vault', '无密码', 'password']}
                onSelect={() => {
                  useApp.getState().setChangePasswordOpen(true)
                  close()
                }}
              >
                <KeyRound size={14} />
                修改主密码
                <span className="ml-auto text-[11px] text-ink-tertiary">
                  {vaultNoPassword ? '当前未设置' : ''}
                </span>
              </Command.Item>
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
