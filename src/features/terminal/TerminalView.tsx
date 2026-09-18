import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Channel } from '@tauri-apps/api/core'
import {
  decodeBase64,
  localShellClose,
  localShellInput,
  localShellOpen,
  localShellResize,
  parseConnectError,
  reconnectSession,
  sshCloseChannel,
  sshInput,
  sshOpenShell,
  sshResize,
  type ShellEvent,
} from '@/lib/api'
import { useApp, DEFAULT_TERM_FONT } from '@/lib/store'
import { resolveTermTheme } from '@/lib/termSchemes'
import { FindBar } from './FindBar'
import { TerminalMenu } from './TerminalMenu'
import '@xterm/xterm/css/xterm.css'

/** 多久没收到输出就提示一下，别让用户对着黑屏干等 */
const NO_DATA_HINT_MS = 5000

/**
 * 复制到剪贴板。
 *
 * 优先用 clipboard API，某些 webview 里它没权限（需要用户手势 + 安全上下文），
 * 这时退回 execCommand —— 老接口虽然废弃，但在 WebView2 里反而更可靠。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 接着走 fallback */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

/**
 * 从剪贴板粘到终端里。
 *
 * Ctrl+Shift+V 与右键菜单共用：读不到剪贴板是 webview 的常见限制，两处必须给同一句提示，
 * 不然会变成「快捷键能粘、菜单点了没反应」这种查不出来的差异。
 * 传 getter 而不是实例：读剪贴板是异步的，读完那个终端可能已经卸载了。
 */
function pasteFromClipboard(getTerm: () => Terminal | null) {
  void navigator.clipboard
    .readText()
    .then((text) => {
      const term = getTerm()
      if (text && term) term.paste(text)
    })
    .catch(() => {
      // 明确告诉用户还有 Ctrl+V 这条路 —— 别提右键菜单之外的原生菜单，
      // 那是我们刚换掉的东西
      useApp.getState().setError('读不到剪贴板内容，试试 Ctrl+V')
    })
}

interface Props {
  /**
   * 这个终端属于哪一格（Pane.id）。
   *
   * 命令片段投喂、手动重连、断线标记、查找栏都以它为准 —— 一个标签可以有好几格，
   * 用 tabId 的话几格会互相顶掉（改造前两分屏就是靠 `snippets` 手动让位才没出问题）。
   */
  paneId: string
  /** local=本机 shell，terminal=远程 ssh */
  kind: 'terminal' | 'local'
  /** 远程 ssh 必填；本地 shell 不需要 */
  sessionId?: string
  onClosed?: () => void
}

export function TerminalView({ paneId, kind, sessionId, onClosed }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const channelIdRef = useRef<number | null>(null)
  const kindRef = useRef(kind)
  kindRef.current = kind

  // 用 ref 持有回调，避免父组件重渲染导致 effect 重跑、终端重新连接
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  /** 手动重连。由第一个 effect 填，标签栏通过 store 间接调它 */
  const manualReconnectRef = useRef<(() => void) | null>(null)

  /** 右键菜单的位置。null = 没开。位置用 clientX/clientY（逻辑像素），直接喂给 fixed 定位 */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  // 字号是外部可改的，得能拿到 term 和 safeFit 才能在变化时应用
  const termRef = useRef<Terminal | null>(null)
  const safeFitRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: useApp.getState().termFontFamily || DEFAULT_TERM_FONT,
      // 从 store 读而不是 useState：这值变化不该让 effect 重跑（那会重连终端）
      fontSize: useApp.getState().termFontSize,
      lineHeight: useApp.getState().termLineHeight,
      cursorBlink: true,
      cursorStyle: useApp.getState().termCursorStyle,
      cursorWidth: 2,
      scrollback: useApp.getState().termScrollback,
      // 配色方案在 lib/termSchemes.ts：应用默认读 --term-*，其余走各自的色板
      theme: resolveTermTheme(
        useApp.getState().termScheme,
        useApp.getState().theme,
        useApp.getState().customSchemes,
      ),
      /**
       * 必须开：查找用的 `@xterm/addon-search` 靠 `registerDecoration` 画匹配高亮，
       * 而那个 API 在 xterm 里标着 proposed —— 不开的话搜索当场抛
       * 「You must set the allowProposedApi option to true」，整个标签被 ErrorBoundary 接走。
       * 风险可控：xterm 的版本在本仓库是锁死的（升级要自己动 package.json），
       * 不存在"依赖偷偷升级、proposed API 变了"这种情况。
       */
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    /**
     * 容器尺寸为 0 时不能 fit。
     *
     * 切走标签是用 `hidden`（display:none）藏起来的，ResizeObserver 照样会触发，
     * 这时候 fit 会把 cols 压到 0/1，并且通过 onResize 同步给远端 ——
     * 切回来时 vim / top 这类全屏程序的排版已经全乱了。
     */
    const safeFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* 容器尺寸没定下来时 fit 会抛，后面 ResizeObserver 会补 */
      }
    }
    safeFitRef.current = safeFit

    // 这几个状态要早于渲染器声明：WebGL 的 onContextLoss 回调会读 disposed
    let channelId: number | null = null
    let disposed = false
    let retries = 0

    // Unicode 11 宽度表：不开的话中文、emoji 这些宽字符会被当成单宽，
    // 表格和 ll 的输出就全错位了。但万一 addon 没注册上，设置会抛，
    // 不能让它把整个终端带崩 —— 所以单独兜住
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } catch (e) {
      console.warn('[easy-shell] unicode11 不可用，中文宽度可能错位:', e)
    }

    /**
     * 渲染器：WebGL 快，但**上下文丢失时不会抛异常，只会画成一片黑** ——
     * 这正是实机测到的"连上就黑屏"的典型来源。所以除了 loadAddon 的 try，
     * 还要挂 onContextLoss：真丢了就换 Canvas 2D 重画。
     */
    const loadRenderer = () => {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          // 上下文丢失可能在终端已经卸载之后才回调（卸载是同步的，rAF 不是），
          // 这时候再去 dispose / loadAddon 会踩到 xterm 内部已经清空的 _store
          if (disposed) return
          try {
            webgl.dispose()
          } catch (e) {
            console.warn('[easy-shell] webgl dispose 失败:', e)
          }
          try {
            term.loadAddon(new CanvasAddon())
          } catch (e2) {
            console.warn('[easy-shell] canvas 渲染器也失败了:', e2)
          }
          safeFit()
        })
        term.loadAddon(webgl)
      } catch {
        try {
          term.loadAddon(new CanvasAddon())
        } catch (e2) {
          console.warn('[easy-shell] 所有加速渲染器都不可用，退回 DOM 渲染:', e2)
        }
      }
    }
    loadRenderer()

    /**
     * 复制/粘贴快捷键。
     *
     * Ctrl+V 不用管 —— xterm 自己监听了 paste 事件（带 bracketed paste），
     * 原生就能用。这里只补 Ctrl+Shift+C / Ctrl+Shift+V：
     * - 复制必须自己来：Ctrl+C 在终端里是 SIGINT，动不得，只能走 Shift 组合
     * - Ctrl+Shift+V 是双保险，Windows Terminal / VS Code 都是这个习惯
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && key === 'c') {
        const selected = term.getSelection()
        if (selected) void copyText(selected)
        return false
      }
      if (e.ctrlKey && e.shiftKey && key === 'v') {
        pasteFromClipboard(() => (disposed ? null : term))
        return false
      }
      /**
       * Ctrl+Shift+F 是应用层的「终端内查找」，App.tsx 已经在 capture 阶段开好了查找栏。
       * 这里再吞一次是必须的：xterm **不看 `defaultPrevented`**，不吞的话它还会顺手把 ^F
       * 发给远端（readline 里是"前进一个字符"），光标平白挪一格。
       */
      if (e.ctrlKey && e.shiftKey && key === 'f') return false
      return true
    })

    term.open(el)
    termRef.current = term
    safeFit()

    // 先给一行可见的状态，避免"连上了但还没数据"看起来像黑屏
    term.writeln('\x1b[90m正在连接…\x1b[0m')

    const syncChannel = () => {
      channelIdRef.current = channelId
    }

    const channel = new Channel<ShellEvent>()

    /** manual=true 是用户点标签栏的 ↻ 触发的，要重置计数并跳过放弃逻辑 */
    const handleClosed = async (manual = false) => {
      if (disposed) return
      // 本地 shell 退出就是真退出了，没有重连可言
      if (kind === 'local') {
        term.writeln('\r\n\x1b[90mShell 已退出\x1b[0m')
        onClosedRef.current?.()
        return
      }
      // 重连策略是设置项：现场读，改了立刻对下一次断线生效（不用重建终端）
      const maxRetries = useApp.getState().reconnectAttempts
      const retryDelayMs = useApp.getState().reconnectDelaySec * 1000
      if (!manual && retries >= maxRetries) {
        // 这里**不能**关标签：断线就自动把标签干掉的话，用户正在看的输出、
        // 报错信息全没了，等于毁掉现场。留着，让标签栏给个 ↻ 自己决定
        term.writeln('\r\n\x1b[90m连接已关闭。点标签栏的 ↻ 可以再试一次。\x1b[0m')
        useApp.getState().setPaneDead(paneId, true)
        return
      }
      if (manual) retries = 0
      retries += 1
      // 关掉自动重连（0 次）时是用户自己点的 ↻，别写成「1/0」那种别扭的计数
      term.writeln(
        maxRetries > 0
          ? `\r\n\x1b[33m⟳ 连接断开，${retryDelayMs / 1000} 秒后重连（${retries}/${maxRetries}）…\x1b[0m`
          : `\r\n\x1b[33m⟳ 正在重连…\x1b[0m`,
      )
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      if (disposed) return
      try {
        if (!sessionId) throw new Error('缺少 SSH 会话 id')
        await reconnectSession(sessionId)
        if (disposed) return
        channelId = await sshOpenShell(sessionId, term.cols, term.rows, channel)
        if (disposed) {
          // 重连途中被关掉了，别让这条通道变成没人管的孤儿
          void sshCloseChannel(channelId)
          return
        }
        syncChannel()
        retries = 0
        useApp.getState().setPaneDead(paneId, false)
        useApp.getState().setPaneLive(paneId, true)
        term.writeln('\r\n\x1b[32m✓ 已重连\x1b[0m')
      } catch (e) {
        const failure = parseConnectError(e)
        if (failure.kind === 'host_key_mismatch') {
          // 自动重连没法替用户做这个决定（要不要信任新密钥），
          // 说清楚就行，别让人对着一句 [object Object] 猜
          term.writeln('\r\n\x1b[31m✗ 主机密钥已变更，已停止重连。\x1b[0m')
          term.writeln('\x1b[90m关掉这个标签重新连接，届时会让你确认是否信任新密钥。\x1b[0m')
        } else {
          term.writeln(`\r\n\x1b[31m✗ 重连失败: ${failure.message}\x1b[0m`)
        }
      }
    }

    manualReconnectRef.current = () => {
      void handleClosed(true)
    }

    // 连上之后等一会儿还没输出，多半是远端 shell 没吐东西（不是我们没连上）。
    // 不说一句的话，用户只能对着黑屏猜
    const noDataTimer = setTimeout(() => {
      if (disposed || gotData) return
      term.writeln(
        `\r\n\x1b[33m已建立连接，但 ${NO_DATA_HINT_MS / 1000} 秒内没有收到输出。\x1b[0m`,
      )
      term.writeln('\x1b[90m可能是远端 shell 启动慢，或者这台设备不给交互式 shell。\x1b[0m')
    }, NO_DATA_HINT_MS)

    let gotData = false
    channel.onmessage = (ev) => {
      if (disposed) return
      if (ev.type === 'data' && ev.data) {
        // 第一条真实输出到了就把"正在连接…"那行清掉，别留在屏幕上
        if (!gotData) {
          gotData = true
          term.clear()
        }
        term.write(decodeBase64(ev.data))
      } else if (ev.type === 'error') {
        term.writeln(`\r\n\x1b[31m✗ ${ev.message}\x1b[0m`)
      } else if (ev.type === 'closed') {
        void handleClosed()
      }
    }

    const open: () => Promise<number> =
      kind === 'local'
        ? () => localShellOpen(term.cols, term.rows, channel)
        : () => {
            if (!sessionId) return Promise.reject(new Error('缺少 SSH 会话 id'))
            return sshOpenShell(sessionId, term.cols, term.rows, channel)
          }

    void open()
      .then((id) => {
        // 卸载后才返回的 promise：直接关掉，别泄漏
        if (disposed) {
          if (kind === 'local') void localShellClose(id)
          else void sshCloseChannel(id)
          return
        }
        channelId = id
        syncChannel()
        // 「这一格真的连上了」要报给 store：把标签拼进另一个窗口时，
        // 得等新格子开好通道才敢收掉源标签（理由见 store 的 mergeTabIntoPane）
        useApp.getState().setPaneLive(paneId, true)
      })
      .catch((err: unknown) => {
        if (disposed) return
        term.writeln(`\r\n\x1b[31m✗ 打开 shell 失败: ${String(err)}\x1b[0m`)
      })

    const dataSub = term.onData((data) => {
      if (channelId === null) return
      if (kind === 'local') void localShellInput(channelId, data)
      else void sshInput(channelId, data)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (channelId === null) return
      // 兜底：0 尺寸同步过去会让远端全屏程序排版错乱
      if (cols === 0 || rows === 0) return
      if (kind === 'local') void localShellResize(channelId, cols, rows)
      else void sshResize(channelId, cols, rows)
    })

    const observer = new ResizeObserver(() => safeFit())
    observer.observe(el)

    return () => {
      disposed = true
      clearTimeout(noDataTimer)
      channelIdRef.current = null
      manualReconnectRef.current = null
      termRef.current = null
      safeFitRef.current = null
      useApp.getState().setPaneDead(paneId, false)
      useApp.getState().setPaneLive(paneId, false)
      // 后端还会往这个 channel 推事件，先掐掉回调，避免卸载后再动 terminal
      channel.onmessage = () => {}
      // 卸载即关闭自己这条通道：
      // 本地 pty 不关子进程会一直挂在后台；ssh 只关自己的 channel，
      // 千万别 sshClose(sessionId) —— 那会把共用同会话的兄弟分屏一起掐死
      if (channelId !== null) {
        if (kind === 'local') void localShellClose(channelId)
        else void sshCloseChannel(channelId)
      }
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      try {
        term.dispose()
      } catch (e) {
        // xterm 的 webgl addon 在 dispose 时会去读 _core._store._isDisposed，
        // 而 _store 可能已经被清掉了，直接抛。这事儿我们管不了，但绝不能让它
        // 冒到 ErrorBoundary 把整个界面变成黑框
        console.warn('[easy-shell] terminal dispose 抛错（已忽略）:', e)
      }
    }
    // paneId 在组件生命周期里不会变（React key 就是它），列进来只是为了让
    // effect 读的每一份外部状态都有着落；sessionId 变了说明这一格换了主机，要重连
  }, [sessionId, kind, paneId])

  // 字号 / 字体 / 行高变了要应用到已经开着的终端，并重算行列
  const fontSize = useApp((s) => s.termFontSize)
  const fontFamily = useApp((s) => s.termFontFamily)
  const lineHeight = useApp((s) => s.termLineHeight)
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontFamily || DEFAULT_TERM_FONT
    term.options.lineHeight = lineHeight
    // 字符尺寸跟着这几个变，必须重算行列 —— 不然终端画的行列数和远端认为的不一致，
    // 排版立刻就乱了（而且这个不一致还会通过 onResize 同步给远端）
    safeFitRef.current?.()
  }, [fontSize, fontFamily, lineHeight])

  // 光标样式和回滚行数不影响字符尺寸，改完直接生效，不用 refit
  const cursorStyle = useApp((s) => s.termCursorStyle)
  const scrollback = useApp((s) => s.termScrollback)
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = cursorStyle
    term.options.scrollback = scrollback
  }, [cursorStyle, scrollback])

  /**
   * 配色（方案 × 深/浅模式）变了要热换，否则终端会一直停在打开时那套颜色上。
   *
   * 以前这里是拿 MutationObserver 盯 `data-theme`：那时配色只有 CSS 变量一个来源。
   * 现在方案也在 store 里，直接订阅更直接 —— `applyTheme` 改属性和改 store 本来就是
   * 同一个动作的两半，不会不同步。xterm 支持运行时换 theme（WebGL 会自己重建色卡）。
   */
  const termScheme = useApp((s) => s.termScheme)
  const theme = useApp((s) => s.theme)
  const customSchemes = useApp((s) => s.customSchemes)
  const xtermTheme = useMemo(
    () => resolveTermTheme(termScheme, theme, customSchemes),
    [termScheme, theme, customSchemes],
  )
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermTheme
  }, [xtermTheme])

  // 命令片段的投递目标 + 手动重连回调。一格一个键：同一标签的多格各注册各的，
  // 不会互相顶掉（投给谁由 store 的 focusedPane 决定，见 SnippetsDialog）
  useEffect(() => {
    const reconnect = () => manualReconnectRef.current?.()
    const sink = (text: string) => {
      const id = channelIdRef.current
      if (id === null) return
      if (kindRef.current === 'local') void localShellInput(id, text)
      else void sshInput(id, text)
    }
    useApp.getState().registerTerminalSink(paneId, sink)
    useApp.getState().registerReconnect(paneId, reconnect)
    return () => {
      useApp.getState().unregisterTerminalSink(paneId)
      useApp.getState().unregisterReconnect(paneId)
    }
  }, [paneId])

  /**
   * 查找栏开不开，由 store 里「哪一格在搜」决定 —— 快捷键、状态栏、命令面板
   * 三处入口都够不着组件内部的 state，只能放那儿。
   */
  const findPaneId = useApp((s) => s.findPaneId)
  const findOpen = findPaneId === paneId

  /**
   * padding 留在外层，xterm 挂到不带 padding 的内层。
   *
   * FitAddon 按父元素的**盒高**算行列，而 terminal 元素是从 padding 之后的 content box
   * 开始排的 —— 上下各 8px 就凭空多出一行，终端底部会溢出容器（盖住状态栏再往下露一截）。
   * 远程终端有 PaneGrid 的 overflow-hidden 兜着看不出来，本地 Shell 没有，肉眼可见。
   */
  return (
    // padding 那一圈用终端自己的底色，而不是画布色：换了非默认配色之后，
    // 画布色会在终端周围留一圈对不上的边。应用默认那套里 --term-bg 本就等于
    // --canvas（深色都是 #010102、浅色都是 #ffffff），所以观感不变。
    // relative 是给查找栏做定位锚点：它浮在终端右上角，不挤占终端的行列
    <div
      className="relative h-full w-full overflow-hidden p-2"
      style={{ background: xtermTheme.background }}
      onContextMenu={(e) => {
        // 菜单自己身上的右键别再重开一次（否则菜单会跳到光标下）
        if ((e.target as HTMLElement).closest('[role="menu"]')) return
        // xterm 自己也监听右键，但它只把选中文本塞进 textarea 好让**原生菜单**的复制能用，
        // 并不拦原生菜单 —— 想换成自绘菜单就得自己 preventDefault
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
    >
      <div ref={hostRef} className="h-full w-full" />
      {findOpen && <FindBar termRef={termRef} onClose={() => useApp.getState().closeFind()} />}
      {menuAt && (
        <TerminalMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          items={[
            {
              label: '复制',
              hint: 'Ctrl+Shift+C',
              // 没选中东西时置灰，而不是点了没反应
              disabled: !termRef.current?.hasSelection(),
              onSelect: () => {
                const term = termRef.current
                if (term) void copyText(term.getSelection())
              },
            },
            {
              label: '粘贴',
              hint: 'Ctrl+Shift+V',
              onSelect: () => pasteFromClipboard(() => termRef.current),
            },
            { label: '全选', onSelect: () => termRef.current?.selectAll() },
            { label: '清屏', onSelect: () => termRef.current?.clear() },
            {
              label: '重置终端',
              danger: true,
              onSelect: () => {
                const term = termRef.current
                if (!term) return
                // 回滚历史丢了就找不回来，所以问一句（远端不受影响，别让人以为会重启会话）
                useApp.getState().setConfirmPrompt({
                  kind: 'confirm',
                  title: '重置终端',
                  message: '会清掉这个终端的回滚历史。远端那边的会话不受影响，继续吗？',
                  confirmLabel: '重置',
                  danger: true,
                  onConfirm: () => term.reset(),
                })
              },
            },
            {
              label: '查找…',
              hint: 'Ctrl+Shift+F',
              onSelect: () => useApp.getState().toggleFind(),
            },
          ]}
        />
      )}
    </div>
  )
}
