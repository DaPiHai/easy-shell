import { Columns2, FileCode2, FolderTree, RotateCw, Terminal, X } from 'lucide-react'
import { useApp } from '@/lib/store'

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, toggleSplit, deadTabs, reconnectSinks } =
    useApp()

  if (tabs.length === 0) return null

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-hairline bg-canvas">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            // 中键关标签 —— 浏览器里的肌肉记忆，不接的话按了没反应很别扭
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(tab.id)
              }
            }}
            className={`group relative flex h-9 cursor-pointer items-center gap-2 border-r border-hairline px-3 text-[13px] transition-colors ${
              active ? 'bg-surface-1 text-ink' : 'text-ink-subtle hover:bg-surface-1'
            }`}
          >
            {tab.kind === 'sftp' ? (
              <FolderTree size={12} className="shrink-0 text-ink-tertiary" />
            ) : tab.kind === 'editor' ? (
              <FileCode2 size={12} className="shrink-0 text-ink-tertiary" />
            ) : (
              <Terminal size={12} className="shrink-0 text-ink-tertiary" />
            )}
            <span className="max-w-40 truncate">{tab.title}</span>
            {/* 断线且自动重连已放弃：给个 ↻。不给的话只能关标签重开，现场全没了 */}
            {deadTabs[tab.id] && (
              <span title="重新连接" className="flex shrink-0">
                <RotateCw
                  size={12}
                  className="text-warning transition-opacity hover:opacity-70"
                  onClick={(e) => {
                    e.stopPropagation()
                    // 分屏时左右都注册了，一次全触发
                    reconnectSinks[tab.id]?.forEach((fn) => fn())
                  }}
                />
              </span>
            )}
            {/* 分屏只对远程终端有意义：本地 shell 和文件面板没这个需求 */}
            {tab.kind === 'terminal' && (
              // title 挂 span 上：svg 元素的 title 属性不弹提示
              <span title={tab.split ? '合并分屏' : '左右分屏'} className="flex shrink-0">
                <Columns2
                  size={12}
                  className={`transition-colors ${
                    tab.split
                      ? 'text-accent'
                      : 'text-ink-tertiary opacity-0 hover:text-ink group-hover:opacity-100'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSplit(tab.id)
                  }}
                />
              </span>
            )}
            <X
              size={12}
              className="shrink-0 text-ink-tertiary opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                // 只关标签：通道由 TerminalView 卸载时自己关。
                // 在这里先关通道的话，后端会推 'closed' 事件，
                // 终端还没卸载就会去走重连逻辑 —— 白折腾还可能出错
                closeTab(tab.id)
              }}
            />
            {active && (
              <span className="absolute bottom-0 h-0.5 w-full bg-accent" aria-hidden />
            )}
          </div>
        )
      })}
    </div>
  )
}
