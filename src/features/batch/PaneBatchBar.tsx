import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Send,
  Square,
} from 'lucide-react'
import { MIN_BATCH_BAR_H, useApp, type Pane } from '@/lib/store'
import { sshExec } from '@/lib/api'

/**
 * 分屏底部的批量执行条。
 *
 * 为什么标签里还要再有一个（而不是让人切到「批量执行」标签）：分屏的意图就是
 * "这几格同时看着"，把命令发到其中几格属于同一件事的下一步，切标签等于把眼睛
 * 从目标上挪开。所以这里**只做这一屏的事** —— 勾本屏哪几格、跑、就地看结果。
 * 「批量执行」标签（`BatchPanel`）管的是跨主机的批量采集，两边共用后端的 `ssh_exec`。
 *
 * 折叠成一条 28px 的把手而不是常开：分屏时本来就没剩多少竖向空间，
 * 常开一块面板等于让终端少看五行。所以高度是**可拖**的（把手最上面那条细线），
 * 拖多少存多少（`store.batchBarHeight`）——"展开"到底看多大一块，因人因屏而异。
 */

/** 某一行的结果（逐行模式） */
interface LineHit {
  /** 这一行的原文（显示出来，光看输出对不上是哪一条） */
  text: string
  status: 'queued' | 'running' | 'ok' | 'failed' | 'error' | 'skipped' | 'sent'
  exitCode: number | null
  stdout: string
  stderr: string
  ms: number
  message?: string
  timedOut?: boolean
}

/** 一格上的这一次执行 */
interface Hit {
  status: 'queued' | 'running' | 'ok' | 'failed' | 'error' | 'stopped' | 'sent'
  exitCode: number | null
  stdout: string
  stderr: string
  ms: number
  message?: string
  timedOut?: boolean
  /**
   * 逐行模式：每一行的结果。
   *
   * 非逐行**没有这个字段** —— 那种情况整条命令是一次 exec，输出就是一整块，
   * 渲染也走老路（一个 `<pre>`）。
   */
  lines?: LineHit[]
}

const STATUS_TEXT: Record<Hit['status'], string> = {
  queued: '排队中',
  running: '执行中',
  ok: '成功',
  failed: '非零退出',
  error: '失败',
  stopped: '已停止',
  sent: '已发送',
}

const STATUS_CLASS: Record<Hit['status'], string> = {
  queued: 'text-ink-tertiary',
  running: 'text-accent',
  ok: 'text-success',
  failed: 'text-warning',
  error: 'text-danger',
  stopped: 'text-warning',
  sent: 'text-accent',
}

const LINE_TEXT: Record<LineHit['status'], string> = {
  queued: '等待',
  running: '执行中',
  ok: '成功',
  failed: '非零退出',
  error: '失败',
  skipped: '已跳过',
  sent: '已发送',
}

const LINE_CLASS: Record<LineHit['status'], string> = {
  queued: 'text-ink-tertiary',
  running: 'text-accent',
  ok: 'text-success',
  failed: 'text-warning',
  error: 'text-danger',
  skipped: 'text-ink-tertiary',
  sent: 'text-accent',
}

/**
 * 一眼就该拦下的命令（与「批量执行」标签同一份判断）。
 *
 * 这里是在**一屏里的几台机器**上同时跑，按错一次的后果是几倍；
 * 全量确认会让人盲点，所以只在这几条"跑错就出事"的命令上问一句。
 */
const DANGEROUS = [
  /\brm\s+(-[a-z]*\s+)*(-r|-rf|-fr)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+0\b/,
  /:\(\)\s*\{/,
  /\bchmod\s+(-R\s+)?777\b/i,
]

/** 拖动调高度时，上面的终端至少要留这么高（不然连提示符都看不见） */
const MIN_GRID_H = 160

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 逐行模式要跑的行。
 *
 * 空行与 `#` 开头的行**跳过**：空行在 exec 通道上是一条没有任何意义的命令
 * （发送路径上多一个空回车也只是刷屏），注释行则是写给自己看的。都不该占一行结果。
 * 两条路（执行 / 发送）用同一份规则 —— 同一个勾选不该在两个按钮下有两套含义。
 */
function splitLines(command: string): string[] {
  return command
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
}

export function PaneBatchBar({ panes, deadPanes }: { panes: Pane[]; deadPanes: Record<string, boolean> }) {
  const { setError, setConfirmPrompt } = useApp()
  const batchBarHeight = useApp((s) => s.batchBarHeight)

  const [open, setOpen] = useState(false)
  const [command, setCommand] = useState('')
  const [timeoutSecs, setTimeoutSecs] = useState(30)
  /**
   * 被**排除**的格子。
   *
   * 用"排除"而不是"选中"：分屏的默认意图就是"这一屏都在"，所以默认全选；
   * 换分屏形状补出来的新格子会自动算在内，不用再手动勾一次。
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [hits, setHits] = useState<Record<string, Hit>>({})
  const [running, setRunning] = useState(false)
  /**
   * 逐行：一行一条命令，上一行走完再走下一行。
   *
   * 不进 localStorage：它是"这一次怎么跑"的选择，跟命令内容绑在一起 ——
   * 记住它反而危险（下次敲一条单行命令，结果上来就是逐行序）。
   */
  const [lineByLine, setLineByLine] = useState(false)
  /** 逐行 + 发送时行与行之间的间隔（毫秒）。发送拿不到退出码，只能靠时间往下走 */
  const [lineGapMs, setLineGapMs] = useState(300)

  const lines = useMemo(() => splitLines(command), [command])

  /** 停止挡住还没开跑的行 / 格子，已经在跑的那一条让它跑完 */
  const stopped = useRef(false)
  useEffect(() => () => { stopped.current = true }, [])

  /** 连的都断了 / 格子被收掉之后，排除名单里别留着已经不存在的 id */
  useEffect(() => {
    const alive = new Set(panes.map((p) => p.id))
    setExcluded((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [panes])

  const live = panes.filter((p) => p.sessionId && !deadPanes[p.id])
  const chosen = live.filter((p) => !excluded.has(p.id))
  const canRun = useMemo(() => live.some((p) => p.kind !== 'local'), [live])

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const patch = (paneId: string, p: Partial<Hit>) =>
    setHits((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? blank()), ...p } }))

  const patchLine = (paneId: string, index: number, p: Partial<LineHit>) =>
    setHits((prev) => {
      const hit = prev[paneId] ?? blank()
      const list = [...(hit.lines ?? [])]
      list[index] = { ...(list[index] ?? blankLine('')), ...p }
      return { ...prev, [paneId]: { ...hit, lines: list } }
    })

  /* ---------------- 拖拽调高度 ---------------- */

  const barRef = useRef<HTMLDivElement>(null)
  /** 一次拖动：起点、开始时的高度、这一屏最多能给它多少 */
  const resizeRef = useRef<{ startY: number; startH: number; max: number } | null>(null)

  const stopResize = useCallback(() => {
    resizeRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const drag = resizeRef.current
      if (!drag) return
      // 松手发生在窗口外面时收不到 pointerup，靠"当前没按键"判回来（同 PaneGrid）
      if (e.buttons === 0) {
        stopResize()
        return
      }
      // 往上拖变高：光标离底的差就是新的高度
      const want = drag.startH + (drag.startY - e.clientY)
      useApp.getState().setBatchBarHeight(Math.min(drag.max, Math.max(MIN_BATCH_BAR_H, want)))
    },
    [stopResize],
  )

  const startResize = (e: React.PointerEvent) => {
    const bar = barRef.current
    const parent = bar?.parentElement
    if (!bar || !parent) return
    e.preventDefault()
    // 上限按"这一屏还剩多少地方"算，不是常量：窗口矮的时候 900px 会吃掉整个终端
    const max = Math.max(MIN_BATCH_BAR_H, parent.getBoundingClientRect().height - MIN_GRID_H)
    // 折叠着拖 = 把它拉出来：高度按"往上拖了多远"算（最少就是最小高度）
    if (!open) setOpen(true)
    resizeRef.current = {
      startY: e.clientY,
      startH: open ? bar.getBoundingClientRect().height : 0,
      max,
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopResize()
    }
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onResizeMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('keydown', onKey)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [onResizeMove, stopResize])

  /* ---------------- 跑 ---------------- */

  /** 非逐行：整条命令一次 exec */
  const runOne = async (pane: Pane, text: string) => {
    patch(pane.id, { status: 'running', message: undefined, timedOut: undefined })
    const started = Date.now()

    // 本地 Shell 没有 exec 通道（它是 ConPTY 上的一条 PTY），只能用「发送」
    if (pane.kind === 'local' || !pane.sessionId) {
      patch(pane.id, {
        status: 'error',
        message: '本地 Shell 没有 exec 通道 —— 用「发送」把它敲进去',
        ms: Date.now() - started,
      })
      return
    }

    try {
      const r = await sshExec(pane.sessionId, text, timeoutSecs)
      const ms = Date.now() - started
      if (r.timedOut) {
        patch(pane.id, {
          status: 'error',
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          message: '执行超时，输出已截断',
          timedOut: true,
          ms,
        })
        return
      }
      patch(pane.id, {
        status: r.exitCode === 0 ? 'ok' : 'failed',
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        ms,
      })
    } catch (e) {
      patch(pane.id, { status: 'error', message: String(e), ms: Date.now() - started })
    }
  }

  /**
   * 逐行：一格内部串行，格子之间并行。
   *
   * 为什么格子不排队：逐行的意义是"上一行走完再走下一行"，跟几台机器是不是同时
   * 开始无关；串起来只会让总耗时变成"几格相加"。
   *
   * 某一行没成功（非零退出 / 超时 / 抛错）就**停下这一格的后续行**，剩下的标「已跳过」——
   * 逐行跑通常就是为了一步一步确认，失败还往下跑容易把问题放大（第 1 行的目录没建成，
   * 后面几步全在错地方执行）。
   */
  const runLines = async (pane: Pane, todo: string[], mode: 'exec' | 'send') => {
    const runStart = Date.now()
    // 整体状态先落到"执行中"：这一格要跑好几行，卡片头不能一直停在"排队中"
    patch(pane.id, { status: 'running', message: undefined, timedOut: undefined })
    const skipRest = (from: number) => {
      for (let j = from; j < todo.length; j++) patchLine(pane.id, j, { status: 'skipped' })
    }
    /** 收尾：整体状态 + 一句说清"停在哪一行、剩几行没跑" */
    const finish = (status: Hit['status'], message: string, extra: Partial<Hit> = {}) =>
      patch(pane.id, { status, message, ms: Date.now() - runStart, ...extra })

    if (mode === 'exec' && (pane.kind === 'local' || !pane.sessionId)) {
      skipRest(0)
      finish('error', '本地 Shell 没有 exec 通道 —— 用「发送」把它敲进去')
      return
    }

    for (let i = 0; i < todo.length; i++) {
      if (stopped.current) {
        skipRest(i)
        finish('stopped', `已停止：第 ${i + 1} 行起没跑`)
        return
      }
      const t0 = Date.now()
      patchLine(pane.id, i, { status: 'running' })

      if (mode === 'send') {
        const sink = useApp.getState().terminalSinks[pane.id]
        if (!sink) {
          patchLine(pane.id, i, { status: 'error', ms: 0, message: '没有可投递的终端' })
          skipRest(i + 1)
          finish('error', '没有可投递的终端')
          return
        }
        // 末尾补一个换行：一行就是一条命令，没有换行就只是打在提示符后面
        sink(`${todo[i]}\n`)
        // 发送没有退出码可等，只能按间隔往下走（这就是「间隔」这个输入的用处）
        patchLine(pane.id, i, { status: 'sent', ms: Date.now() - t0 })
        if (i < todo.length - 1) await sleep(lineGapMs)
        continue
      }

      try {
        const r = await sshExec(pane.sessionId as string, todo[i], timeoutSecs)
        const ms = Date.now() - t0
        if (r.timedOut) {
          patchLine(pane.id, i, {
            status: 'error',
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            message: '执行超时，输出已截断',
            timedOut: true,
            ms,
          })
          skipRest(i + 1)
          finish('error', `第 ${i + 1} 行超时；后面 ${todo.length - i - 1} 行没跑`, {
            exitCode: r.exitCode,
            timedOut: true,
          })
          return
        }
        patchLine(pane.id, i, {
          status: r.exitCode === 0 ? 'ok' : 'failed',
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          ms,
        })
        if (r.exitCode !== 0) {
          skipRest(i + 1)
          finish(
            'failed',
            i === todo.length - 1
              ? `最后一行非零退出（${r.exitCode}）`
              : `第 ${i + 1} 行非零退出（${r.exitCode}）；后面 ${todo.length - i - 1} 行没跑`,
            { exitCode: r.exitCode },
          )
          return
        }
      } catch (e) {
        patchLine(pane.id, i, { status: 'error', message: String(e), ms: Date.now() - t0 })
        skipRest(i + 1)
        finish('error', `第 ${i + 1} 行出错：${String(e)}`)
        return
      }
    }
    finish(mode === 'send' ? 'sent' : 'ok', mode === 'send' ? `已按行发送 ${todo.length} 行` : `全部 ${todo.length} 行成功`)
  }

  /** 真正的开跑：置状态、按模式分派到每一格 */
  const runAll = async (targets: Pane[], mode: 'exec' | 'send') => {
    stopped.current = false
    setRunning(true)
    setHits(
      Object.fromEntries(
        targets.map((p) => [
          p.id,
          lineByLine
            ? { ...blank(), lines: lines.map((text) => blankLine(text)) }
            : { ...blank(), status: 'queued' as const },
        ]),
      ),
    )
    await Promise.all(
      targets.map(async (p) => {
        if (stopped.current) return
        // 逐行走 runLines；整段只有「执行」这一条路（「发送」的整段是同步敲进去的，
        // 见 send()，不走这里）
        if (lineByLine) await runLines(p, lines, mode)
        else if (mode === 'exec') await runOne(p, command)
      }),
    )
    setRunning(false)
  }

  const run = (targets: Pane[]) => {
    if (running) return
    /**
     * 判空看**原值**，不 trim。
     *
     * trim 会连用户敲的换行一起吃掉 —— "只发一个空回车"就永远发不出去
     * （输入框里明明有内容，一点执行却说"先写命令"）。空回车是有用的：
     * 推一行提示符、确认掉一个交互提示。只有长度真是 0 才算没写。
     */
    if (command.length === 0) {
      setError('先写要执行的命令')
      return
    }
    if (lineByLine && lines.length === 0) {
      setError('逐行模式里没有可跑的行（空行与 # 开头的行会跳过）')
      return
    }
    if (targets.length === 0) {
      setError('这一屏没有勾选任何终端')
      return
    }

    if (DANGEROUS.some((re) => re.test(command))) {
      setConfirmPrompt({
        kind: 'confirm',
        danger: true,
        title: '这条命令有破坏性',
        message: `将在这一屏的 ${targets.length} 个终端上执行它${lineByLine ? '（逐行）' : ''}，且没有撤销的机会。`,
        detail: command,
        confirmLabel: `在 ${targets.length} 个终端上执行`,
        onConfirm: () => void runAll(targets, 'exec'),
      })
      return
    }
    void runAll(targets, 'exec')
  }

  /** 只发送：把命令敲进这几格（要的是现场，拿不到退出码） */
  const send = (targets: Pane[]) => {
    if (running) return
    if (command.length === 0) {
      setError('先写要执行的命令')
      return
    }
    // 逐行：按行敲，行与行之间留「间隔」那么久（本地格也能用，它没有 exec 通道）
    if (lineByLine) {
      if (lines.length === 0) {
        setError('逐行模式里没有可跑的行（空行与 # 开头的行会跳过）')
        return
      }
      if (targets.length === 0) {
        setError('这一屏没有勾选任何终端')
        return
      }
      void runAll(targets, 'send')
      return
    }
    // 末尾已有换行就原样发：发"空回车"时再补一个会变成两个空行
    const payload = command.endsWith('\n') ? command : `${command}\n`
    const s = useApp.getState()
    let sent = 0
    for (const p of targets) {
      const sink = s.terminalSinks[p.id]
      if (!sink) continue
      sink(payload)
      sent += 1
    }
    if (sent === 0) setError('没有可投递的终端')
    else setError(`已发到 ${sent} 个终端`)
  }

  const failing = live.filter((p) => hits[p.id]?.status === 'failed' || hits[p.id]?.status === 'error')

  return (
    <div
      ref={barRef}
      data-batch-bar
      // 展开时高度由拖动决定（存 store）；折叠时只有把手那一条，别让高度把它撑成一整块空白
      style={open ? { height: batchBarHeight } : undefined}
      /*
        `relative z-10`：上面 PaneGrid 的分割线命中层往外多探了 8px（`-bottom-2`），
        而那一层是绝对定位、这条栏不是 —— 绘制顺序上绝对定位的压在上面，于是这条栏
        最上面那几像素（正是调高度的把手）点不到，拖它反而在拖分割线。
        抬一层之后把手才是这一段里最上面的东西（浮签 z-50、菜单 z-40 仍在它上面）。
      */
      className={`relative z-10 shrink-0 border-t border-hairline bg-surface-1 ${
        open ? 'flex min-h-0 flex-col' : ''
      }`}
    >
      {/*
        调高度的把手：一条 6px 的细线，拖它改这一块的高度。
        放在最上面（也就是"这块与终端之间的那条边"）而不是底部 —— 用户想让结果区变大时，
        眼睛和手都在那条边上。
      */}
      <div
        data-batch-resizer
        onPointerDown={startResize}
        title="拖动调整这块的高度"
        className="h-1.5 shrink-0 cursor-row-resize transition-colors hover:bg-accent/40"
      />
      {/* 把手：常驻一条，折叠时也只有这一条 —— 分屏的竖向空间比横向金贵 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full shrink-0 items-center gap-2 px-2 text-left text-[11px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
        title="在本屏选几个终端跑同一条命令（结果就在下面）"
      >
        {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        <span className="font-medium">本屏批量执行</span>
        <span className="text-ink-tertiary">
          {chosen.length}/{live.length} 格
        </span>
        {running && <Loader2 size={11} className="animate-spin text-accent" />}
        {/* 收起时也要能看出"跑过、有几台红了" —— 否则得展开才知道 */}
        {!running && Object.keys(hits).length > 0 && (
          <span className={failing.length > 0 ? 'text-warning' : 'text-success'}>
            {failing.length > 0 ? `${failing.length} 格未成功` : '全部成功'}
          </span>
        )}
      </button>

      {open && (
        // overflow-hidden：把这块钉在拖出来的高度里。命令框随内容长高时，
        // 宁可裁掉自己的尾巴，也不能让它把终端压下去或盖到上面
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-hairline px-2 pb-2 pt-1.5">
          {/* 目标：按屏上的顺序列出，勾选 = 这一格参不参与 */}
          <div className="mb-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
            {live.length === 0 && (
              <span className="text-[11px] text-ink-tertiary">这一屏还没有连上的终端</span>
            )}
            {live.map((p, i) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted"
                title={`${p.title} —— 勾上就把命令发给这一格`}
              >
                <input
                  type="checkbox"
                  checked={!excluded.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-3 w-3 accent-accent"
                />
                <span className="truncate">
                  第 {i + 1} 格 · {p.title}
                </span>
                {p.kind === 'local' && <span className="text-ink-tertiary">（只能发送）</span>}
              </label>
            ))}
          </div>

          {/* 一次一行还是一整段。规则写在 tooltip 里，别让人从行为上猜 */}
          <div className="mb-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
            <label
              className="flex cursor-pointer items-center gap-1.5"
              title="一行一条命令：上一行跑完（发送则是等够间隔）再走下一行。空行与 # 开头的行跳过；某一行没成功就停下，这一格剩下的标「已跳过」"
            >
              <input
                type="checkbox"
                data-batch-linebyline
                checked={lineByLine}
                onChange={(e) => setLineByLine(e.target.checked)}
                className="h-3 w-3 accent-accent"
              />
              逐行
            </label>
            {lineByLine && (
              <>
                <label
                  className="flex items-center gap-1 text-ink-subtle"
                  title="「发送」时每行之间等这么久 —— 它拿不到退出码，只能按时间往下走。「执行」是等上一行真的跑完，不看这个"
                >
                  间隔
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    step={100}
                    value={lineGapMs}
                    onChange={(e) => setLineGapMs(Math.max(0, Number(e.target.value)))}
                    className="h-6 w-16 rounded-md border border-hairline bg-surface-3 px-1.5 text-[11px] text-ink outline-none focus:border-accent"
                  />
                  毫秒
                </label>
                <span className={lines.length > 0 ? 'text-ink-tertiary' : 'text-warning'}>
                  {lines.length > 0
                    ? `这次有 ${lines.length} 行可跑`
                    : '没有可跑的行（空行与 # 开头的行会跳过）'}
                </span>
              </>
            )}
          </div>

          <div className="flex shrink-0 items-start gap-2">
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(chosen)
              }}
              /*
                随内容长高（2–6 行）。逐行跑的就是一串命令，写的时候只看得见两行
                等于一边写一边盲 —— 但也别由着它长：这一条自己会被面板高度裁掉，
                真要看结果的人是把这块往上拖（见上面的把手）。
              */
              rows={Math.min(6, Math.max(2, command.split('\n').length))}
              spellCheck={false}
              placeholder="df -h（Ctrl+Enter 执行）"
              className="min-h-[52px] flex-1 resize-none rounded-md border border-hairline bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <div className="flex shrink-0 flex-col gap-1">
              <button
                onClick={() => run(chosen)}
                disabled={running || !canRun}
                className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  !canRun
                    ? '这一屏只有本地 Shell，用「发送」'
                    : lineByLine
                      ? '在勾选的终端上逐行执行（Ctrl+Enter）'
                      : '在勾选的终端上执行（Ctrl+Enter）'
                }
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                执行
              </button>
              <button
                onClick={() => send(chosen)}
                disabled={running}
                className="flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  lineByLine
                    ? '只把命令敲进这几格：按行敲，行间等「间隔」（本地 Shell 也能用）'
                    : '只把命令敲进这几格，不收结果'
                }
              >
                <Send size={12} />
                发送
              </button>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                onClick={() => {
                  stopped.current = true
                }}
                disabled={!running}
                className="flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  lineByLine
                    ? '不再开跑后面的行与格子（正在跑的那一行会跑完）'
                    : '不再开跑剩下的格子（已经在跑的会跑完）'
                }
              >
                <Square size={11} />
                停止
              </button>
              <label className="flex items-center gap-1 text-[11px] text-ink-subtle">
                超时
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={timeoutSecs}
                  onChange={(e) => setTimeoutSecs(Number(e.target.value))}
                  className="h-7 w-14 rounded-md border border-hairline bg-surface-3 px-1.5 text-[12px] text-ink outline-none focus:border-accent"
                />
                秒
              </label>
            </div>
          </div>

          {failing.length > 0 && (
            <button
              onClick={() => run(failing)}
              disabled={running}
              className="mt-1.5 shrink-0 self-start text-[11px] text-ink-subtle transition-colors hover:text-ink"
              title="只重跑没成功的那几格"
            >
              重跑未成功的 {failing.length} 格
            </button>
          )}

          {/*
            结果：一格一块，横向排 —— 与上面分屏的格子顺序对得上。
            这块吃满剩下的高度（`flex-1`）：栏拉高就该多看见几行输出，而不是留一圈空白。
          */}
          {Object.keys(hits).length > 0 && (
            <div className="mt-1.5 flex min-h-0 flex-1 flex-wrap gap-1.5 overflow-y-auto">
              {live.map((p, i) => {
                const hit = hits[p.id]
                if (!hit) return null
                const body = [hit.stdout, hit.stderr, hit.message ? `错误：${hit.message}` : '']
                  .filter(Boolean)
                  .join('\n')
                {/* 「跑了几行 / 一共几行」：跳过的行不算跑过，不然失败停下时会显示成"全跑完了" */}
                const done = hit.lines?.filter(
                  (l) => l.status !== 'queued' && l.status !== 'running' && l.status !== 'skipped',
                ).length
                return (
                  <div
                    key={p.id}
                    data-batch-card={p.title}
                    className="flex min-h-[92px] min-w-[240px] max-h-full flex-1 flex-col rounded-md border border-hairline bg-surface-2"
                  >
                    <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 py-1">
                      <span className="shrink-0 text-[11px] text-ink-muted">
                        第 {i + 1} 格 · {p.title}
                      </span>
                      <span className={`shrink-0 text-[11px] ${STATUS_CLASS[hit.status]}`}>
                        {hit.status === 'running' && (
                          <Loader2 size={10} className="mr-1 inline animate-spin" />
                        )}
                        {STATUS_TEXT[hit.status]}
                      </span>
                      {hit.lines && (
                        <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                          {done}/{hit.lines.length} 行
                        </span>
                      )}
                      {hit.exitCode !== null && !hit.lines && (
                        <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                          exit {hit.exitCode}
                        </span>
                      )}
                      {hit.timedOut && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning">
                          <AlertTriangle size={10} />
                          超时
                        </span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">
                        {hit.ms} ms
                      </span>
                    </div>
                    {/*
                      整体那句话（"第 2 行非零退出；后面 1 行没跑"）单独占一条。
                      逐行的卡片只逐行显示输出，不把这句话摆出来的话，"为什么停下"就没地方看
                      —— 一排"已跳过"看着像自己跳过的。
                    */}
                    {hit.lines && hit.message && (
                      <div
                        className={`shrink-0 border-b border-hairline px-2 py-0.5 text-[10px] ${STATUS_CLASS[hit.status]}`}
                      >
                        {hit.message}
                      </div>
                    )}
                    {hit.lines ? (
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {hit.lines.map((ln, li) => {
                          const lineBody = [
                            ln.stdout,
                            ln.stderr,
                            ln.message ? `错误：${ln.message}` : '',
                          ]
                            .filter(Boolean)
                            .join('\n')
                          return (
                            <div key={li} className="border-b border-hairline last:border-b-0">
                              <div className="flex items-center gap-2 px-2 py-0.5">
                                <span className="shrink-0 text-[10px] text-ink-tertiary">
                                  第 {li + 1} 行
                                </span>
                                <span className={`shrink-0 text-[10px] ${LINE_CLASS[ln.status]}`}>
                                  {ln.status === 'running' && (
                                    <Loader2 size={9} className="mr-1 inline animate-spin" />
                                  )}
                                  {LINE_TEXT[ln.status]}
                                </span>
                                {ln.exitCode !== null && (
                                  <span className="shrink-0 font-mono text-[10px] text-ink-tertiary">
                                    exit {ln.exitCode}
                                  </span>
                                )}
                                {ln.timedOut && (
                                  <span className="shrink-0 text-[10px] text-warning">超时</span>
                                )}
                                <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-tertiary">
                                  {ln.ms > 0 ? `${ln.ms} ms` : ''}
                                </span>
                              </div>
                              {/* 命令原文也留着：结果一多，光看输出对不上是哪一条 */}
                              <div
                                className="truncate px-2 font-mono text-[10px] text-ink-subtle"
                                title={ln.text}
                              >
                                {ln.text}
                              </div>
                              {lineBody && (
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-muted">
                                  {lineBody}
                                </pre>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <pre className="min-h-[64px] flex-1 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-muted">
                        {body || '（没有输出）'}
                      </pre>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function blank(): Hit {
  return {
    status: 'queued',
    exitCode: null,
    stdout: '',
    stderr: '',
    ms: 0,
  }
}

function blankLine(text: string): LineHit {
  return { text, status: 'queued', exitCode: null, stdout: '', stderr: '', ms: 0 }
}
