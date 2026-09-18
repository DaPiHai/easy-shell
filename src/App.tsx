import { useEffect } from 'react'
import { SessionTree } from '@/features/session/SessionTree'
import { TabBar } from '@/features/terminal/TabBar'
import { TerminalView } from '@/features/terminal/TerminalView'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SftpPanel } from '@/features/sftp/SftpPanel'
import { ConnectDialog } from '@/features/session/ConnectDialog'
import { PaneHostDialog } from '@/features/session/PaneHostDialog'
import { ConfirmDialog } from '@/features/session/ConfirmDialog'
import { ChangePasswordDialog } from '@/features/session/ChangePasswordDialog'
import { RecoveryPromptDialog } from '@/features/session/RecoveryPromptDialog'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { TunnelDialog } from '@/features/tunnel/TunnelDialog'
import { SnippetsDialog } from '@/features/snippets/SnippetsDialog'
import { EditorView } from '@/features/editor/EditorView'
import { UnlockScreen } from '@/features/session/UnlockScreen'
import { EmptyState, StatusBar } from '@/components/EmptyState'
import { useApp, DEFAULT_FONT_SIZE, panesOf } from '@/lib/store'
import { PaneGrid } from '@/components/PaneGrid'
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
      /**
       * Ctrl+Shift+B 收起/展开会话侧栏（VS Code 的肌肉记忆；mac 上是 Cmd+Shift+B）。
       *
       * 跟 Ctrl+W 不同，这条**不看焦点在哪**：它管的是窗口布局，不是文本编辑，
       * 终端里敲 Ctrl+Shift+B 也只是把 Ctrl+B 重复一遍（readline 里是"后退一个字符"，
       * 没人会用带 Shift 的那版），犯不着为它让路。
       */
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useApp.getState().toggleSidebar()
        return
      }
      /**
       * Ctrl+Shift+F 在当前终端里查找。
       *
       * 用带 Shift 的那版是 Windows Terminal / gnome-terminal 的习惯：裸 Ctrl+F 是控制字符
       * （readline 里是"前进一个字符"），抢了会得罪真在终端里干活的人。
       * 其他标签一律放行不拦 —— 编辑器里 CodeMirror 自带 Ctrl+F，SFTP 的搜索还没做，
       * 在这儿吃掉按键只会让人以为按键坏了。
       */
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (!useApp.getState().findablePane()) return
        e.preventDefault()
        useApp.getState().toggleFind()
        return
      }
      if (e.key === 'Escape') {
        // 所有自绘弹窗都要能被 Esc 关掉 —— 只关一部分的话，
        // 用户在端口转发/命令片段上按 Esc 会以为按键坏了
        const {
          tunnelOpen,
          setTunnelOpen,
          snippetsOpen,
          setSnippetsOpen,
          settingsOpen,
          setSettingsOpen,
          changePasswordOpen,
          setChangePasswordOpen,
          recoveryPromptOpen,
          setRecoveryPromptOpen,
          paneHostTarget,
          setPaneHostTarget,
          confirmPrompt,
          setConfirmPrompt,
          setConnectPaneTarget,
        } = useApp.getState()
        if (paletteOpen) setPaletteOpen(false)
        // 关对话框时把「这一格要连主机」的目标一起清掉，理由见 ConnectDialog.close
        if (connectOpen) {
          setConnectOpen(false)
          setConnectPaneTarget(null)
        }
        if (paneHostTarget) setPaneHostTarget(null)
        if (tunnelOpen) setTunnelOpen(false)
        if (snippetsOpen) setSnippetsOpen(false)
        if (settingsOpen) setSettingsOpen(false)
        if (changePasswordOpen) setChangePasswordOpen(false)
        if (recoveryPromptOpen) setRecoveryPromptOpen(false)
        // 安全确认框同理：Esc = 取消（确认框自己没处理，不在这里关就成了关不掉的框）
        if (confirmPrompt) setConfirmPrompt(null)
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
        const { activeTabId, requestCloseTab } = useApp.getState()
        if (activeTabId) {
          e.preventDefault()
          // 走 requestCloseTab：编辑器里有没保存的改动时会先问一句
          requestCloseTab(activeTabId)
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
          setTermFontSize(DEFAULT_FONT_SIZE)
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
  const splitRatioY = useApp((s) => s.splitRatioY)
  const setSplitRatioY = useApp((s) => s.setSplitRatioY)

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
                  <EditorView target={tab.editorTarget} tabId={tab.id} />
                ) : tab.kind === 'sftp' && tab.sessionId ? (
                  <SftpPanel sessionId={tab.sessionId} />
                ) : (tab.kind === 'terminal' || tab.kind === 'local') &&
                  panesOf(tab).length > 0 ? (
                  <PaneGrid
                    tabId={tab.id}
                    panes={panesOf(tab)}
                    colRatio={splitRatio}
                    rowRatio={splitRatioY}
                    onColRatioChange={setSplitRatio}
                    onRowRatioChange={setSplitRatioY}
                    // 每格各包一层 ErrorBoundary：一格炸了（xterm 渲染器那类问题）
                    // 不该把同一个标签里其它三格一起带走
                    renderPane={(pane) => (
                      <ErrorBoundary label={`「${tab.title}」的这一格出错了`}>
                        <TerminalView
                          paneId={pane.id}
                          kind={pane.kind}
                          sessionId={pane.sessionId}
                          // 本地 shell 退出就是退出，没有重连可言。
                          // 只关这一格 —— 本地 Shell 跟远程并到一屏之后（拖标签进来），
                          // 一句 exit 不该把旁边的远程终端一起带走；只剩它自己时才关标签
                          onClosed={
                            pane.kind === 'local'
                              ? () => {
                                  const s = useApp.getState()
                                  const live = s.tabs.find((t) => t.id === tab.id)
                                  if (panesOf(live).length > 1) s.closePane(tab.id, pane.id)
                                  else s.closeTab(tab.id)
                                }
                              : undefined
                          }
                        />
                      </ErrorBoundary>
                    )}
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
      {/* 「换主机」紧跟着快速连接：那条路会先把它收掉再开连接框 */}
      <PaneHostDialog />
      <ConfirmDialog />
      <ChangePasswordDialog />
      {/* 排在改密码那个之后：它可能是「改完密码紧接着弹出来」的，要压在上面 */}
      <RecoveryPromptDialog />
      <SettingsDialog />
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
