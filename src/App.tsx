import { useEffect } from 'react'
import { SessionTree } from '@/features/session/SessionTree'
import { TabBar } from '@/features/terminal/TabBar'
import { TerminalView } from '@/features/terminal/TerminalView'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SftpPanel } from '@/features/sftp/SftpPanel'
import { ConnectDialog } from '@/features/session/ConnectDialog'
import { HostKeyDialog } from '@/features/session/HostKeyDialog'
import { TunnelDialog } from '@/features/tunnel/TunnelDialog'
import { SnippetsDialog } from '@/features/snippets/SnippetsDialog'
import { EditorView } from '@/features/editor/EditorView'
import { UnlockScreen } from '@/features/session/UnlockScreen'
import { EmptyState, StatusBar } from '@/components/EmptyState'
import { useApp } from '@/lib/store'
import { SplitPane } from '@/components/SplitPane'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export default function App() {
  const phase = useApp((s) => s.phase)

  useEffect(() => {
    void useApp.getState().initVault()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { paletteOpen, setPaletteOpen, connectOpen, setConnectOpen } = useApp.getState()

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setConnectOpen(!connectOpen)
        return
      }
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        if (connectOpen) setConnectOpen(false)
      }

      /**
       * Ctrl+W 关当前标签。
       *
       * 必须拦：Tauri 不管这个键，webview 里按下去有可能直接把整个窗口关掉，
       * 用户想关的只是一个标签。但焦点在输入框或终端里时不抢 ——
       * bash 里 Ctrl+W 是"删掉光标前一个词"，那是终端的语义。
       */
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'w') {
        const el = document.activeElement as HTMLElement | null
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          return
        }
        const { activeTabId, closeTab } = useApp.getState()
        if (activeTabId) {
          e.preventDefault()
          closeTab(activeTabId)
        }
        return
      }

      // Ctrl+Tab / Ctrl+Shift+Tab 切标签（Windows Terminal 的习惯）
      if (e.ctrlKey && e.key === 'Tab') {
        const { tabs, activeTabId, setActiveTab } = useApp.getState()
        if (tabs.length > 1) {
          e.preventDefault()
          const i = tabs.findIndex((t) => t.id === activeTabId)
          const next = e.shiftKey
            ? (i - 1 + tabs.length) % tabs.length
            : (i + 1) % tabs.length
          setActiveTab(tabs[next].id)
        }
      }

      // 终端字号。Ctrl+0 复位
      if (e.ctrlKey && !e.metaKey) {
        const { bumpTermFontSize, setTermFontSize } = useApp.getState()
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          bumpTermFontSize(1)
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          bumpTermFontSize(-1)
        } else if (e.key === '0') {
          e.preventDefault()
          setTermFontSize(13)
        }
      }
    }

    /**
     * 用 capture 而不是冒泡：xterm 把键盘监听挂在自己的 textarea 上，
     * 冒泡到 window 时它已经把按键当输入吃进终端了。字号这种全局快捷键
     * 必须在它之前拦下来。
     */
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const error = useApp((s) => s.error)
  const splitRatio = useApp((s) => s.splitRatio)
  const setSplitRatio = useApp((s) => s.setSplitRatio)

  if (phase === 'loading') {
    return (
      <div className="grid h-full place-items-center bg-canvas text-[13px] text-ink-subtle">
        载入中…
      </div>
    )
  }
  if (phase !== 'ready') {
    return <UnlockScreen />
  }

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <div className="flex min-h-0 flex-1">
        <SessionTree />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="min-h-0 flex-1">
            {tabs.length === 0 && <EmptyState />}
            {/* 所有标签都保持挂载，切换时只隐藏，避免终端被重建、会话丢失 */}
            {tabs.map((tab) => (
              <div key={tab.id} className={tab.id === activeTabId ? 'h-full' : 'hidden'}>
                {/* 包一层：终端/SFTP/编辑器任一处炸了都别留黑框，把错误显示出来 */}
                <ErrorBoundary label={`「${tab.title}」这个标签出错了`}>
                {tab.kind === 'editor' && tab.editorTarget ? (
                  <EditorView target={tab.editorTarget} />
                ) : tab.kind === 'sftp' && tab.sessionId ? (
                  <SftpPanel sessionId={tab.sessionId} />
                ) : tab.kind === 'local' ? (
                  <TerminalView
                    kind="local"
                    tabId={tab.id}
                    onClosed={() => useApp.getState().closeTab(tab.id)}
                  />
                ) : tab.kind === 'terminal' && tab.sessionId ? (
                  <SplitPane
                    split={!!tab.split}
                    ratio={splitRatio}
                    onRatioChange={setSplitRatio}
                    left={<TerminalView sessionId={tab.sessionId} tabId={tab.id} />}
                    // 右半边共享 tabId（这样断线时标签栏的 ↻ 能同时拉起两边），
                    // 但不接命令片段，否则会把左半边顶掉
                    right={
                      <TerminalView sessionId={tab.sessionId} tabId={tab.id} snippets={false} />
                    }
                  />
                ) : (
                  <EmptyState />
                )}
                </ErrorBoundary>
              </div>
            ))}
          </div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <ConnectDialog />
      <HostKeyDialog />
      <TunnelDialog />
      <SnippetsDialog />

      {error && (
        <div className="fixed bottom-8 right-4 z-50 max-w-sm rounded-md border border-danger/40 bg-surface-1 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  )
}
