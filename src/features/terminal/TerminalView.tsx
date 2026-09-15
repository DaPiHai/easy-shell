import { useEffect, useRef } from 'react'
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
import { useApp } from '@/lib/store'
import '@xterm/xterm/css/xterm.css'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000
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

function readToken(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function buildTheme() {
  return {
    background: readToken('--term-bg', '#010102'),
    foreground: readToken('--term-fg', '#d0d6e0'),
    cursor: readToken('--term-cursor', '#5e6ad2'),
    cursorAccent: readToken('--term-bg', '#010102'),
    selectionBackground: 'rgba(94, 106, 210, 0.3)',
    black: readToken('--term-black', '#0f1011'),
    red: readToken('--term-red', '#e5484d'),
    green: readToken('--term-green', '#3dd68c'),
    yellow: readToken('--term-yellow', '#e2a03f'),
    blue: readToken('--term-blue', '#5e6ad2'),
    magenta: readToken('--term-magenta', '#a855f7'),
    cyan: readToken('--term-cyan', '#3ddbd9'),
    white: readToken('--term-white', '#d0d6e0'),
    brightBlack: readToken('--term-bright-black', '#62666d'),
    brightRed: readToken('--term-bright-red', '#ff6369'),
    brightGreen: readToken('--term-bright-green', '#56e39f'),
    brightYellow: readToken('--term-bright-yellow', '#ffb224'),
    brightBlue: readToken('--term-bright-blue', '#828fff'),
    brightMagenta: readToken('--term-bright-magenta', '#c084fc'),
    brightCyan: readToken('--term-bright-cyan', '#56e1e1'),
    brightWhite: readToken('--term-bright-white', '#f7f8f8'),
  }
}

interface Props {
  /** 远程 ssh 必填；本地 shell 不需要 */
  sessionId?: string
  /** local=本机 shell，terminal=远程 ssh */
  kind?: 'terminal' | 'local'
  /** 传了就注册到 store，命令片段面板可以往这个终端投递命令 */
  tabId?: string
  /**
   * 是否作为命令片段的投递目标，默认 true。
   * 分屏时左右两个终端共用 tabId，只有一边该接命令片段，另一边传 false。
   */
  snippets?: boolean
  onClosed?: () => void
}

export function TerminalView({
  sessionId,
  kind = 'terminal',
  tabId,
  snippets = true,
  onClosed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 分屏时左右两个终端共用 sessionId，只有注册了 tabId 的那个才接收片段 */
  const channelIdRef = useRef<number | null>(null)
  const kindRef = useRef(kind)
  kindRef.current = kind

  // 用 ref 持有回调，避免父组件重渲染导致 effect 重跑、终端重新连接
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  /** 手动重连。由第一个 effect 填，标签栏通过 store 间接调它 */
  const manualReconnectRef = useRef<(() => void) | null>(null)

  // 字号是外部可改的，得能拿到 term 和 safeFit 才能在变化时应用
  const termRef = useRef<Terminal | null>(null)
  const safeFitRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
      // 从 store 读而不是 useState：这值变化不该让 effect 重跑（那会重连终端）
      fontSize: useApp.getState().termFontSize,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 5000,
      theme: buildTheme(),
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
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text && !disposed) term.paste(text)
          })
          .catch(() => {
            // 读不到剪贴板（webview 常见限制），明确告诉用户还有 Ctrl+V 这条路
            useApp
              .getState()
              .setError('读不到剪贴板内容，试试 Ctrl+V（或右键粘贴）')
          })
        return false
      }
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
      if (!manual && retries >= MAX_RETRIES) {
        // 这里**不能**关标签：断线就自动把标签干掉的话，用户正在看的输出、
        // 报错信息全没了，等于毁掉现场。留着，让标签栏给个 ↻ 自己决定
        term.writeln('\r\n\x1b[90m连接已关闭。点标签栏的 ↻ 可以再试一次。\x1b[0m')
        if (tabId) useApp.getState().setTabDead(tabId, true)
        return
      }
      if (manual) retries = 0
      retries += 1
      term.writeln(
        `\r\n\x1b[33m⟳ 连接断开，${RETRY_DELAY_MS / 1000} 秒后重连（${retries}/${MAX_RETRIES}）…\x1b[0m`,
      )
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
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
        if (tabId) useApp.getState().setTabDead(tabId, false)
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

    // 切主题时重刷终端配色，否则终端会一直停在打开时的那套颜色上
    const themeObserver = new MutationObserver(() => {
      term.options.theme = buildTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      disposed = true
      clearTimeout(noDataTimer)
      themeObserver.disconnect()
      channelIdRef.current = null
      manualReconnectRef.current = null
      termRef.current = null
      safeFitRef.current = null
      if (tabId) useApp.getState().setTabDead(tabId, false)
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
  }, [sessionId, kind])

  // 字号变了要应用到已经开着的终端
  const fontSize = useApp((s) => s.termFontSize)
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    // 字符尺寸跟着字号变，必须重算行列 —— 不然终端画的行列数和远端认为的不一致，
    // 排版立刻就乱了（而且这个不一致还会通过 onResize 同步给远端）
    safeFitRef.current?.()
  }, [fontSize])

  // 注册成命令片段的投递目标，同时挂上手动重连
  useEffect(() => {
    if (!tabId) return
    const reconnect = () => manualReconnectRef.current?.()
    // 分屏时左右两个终端共用 tabId，但命令片段只该投给其中一个，
    // 都注册的话后注册的会把先注册的顶掉
    if (snippets) {
      const sink = (text: string) => {
        const id = channelIdRef.current
        if (id === null) return
        if (kindRef.current === 'local') void localShellInput(id, text)
        else void sshInput(id, text)
      }
      useApp.getState().registerTerminalSink(tabId, sink)
    }
    useApp.getState().registerReconnect(tabId, reconnect)
    return () => {
      if (snippets) useApp.getState().unregisterTerminalSink(tabId)
      useApp.getState().unregisterReconnect(tabId, reconnect)
    }
  }, [tabId, snippets])

  return <div ref={hostRef} className="h-full w-full bg-canvas px-2 py-2" />
}
