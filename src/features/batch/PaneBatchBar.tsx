import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Send,
  Square,
} from 'lucide-react'
import { useApp, type Pane } from '@/lib/store'
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
 * 常开一块面板等于让终端少看五行。
 */

/** 一格上的这一次执行 */
interface Hit {
  status: 'queued' | 'running' | 'ok' | 'failed' | 'error'
  exitCode: number | null
  stdout: string
  stderr: string
  ms: number
  message?: string
  timedOut?: boolean
}

const STATUS_TEXT: Record<Hit['status'], string> = {
  queued: '排队中',
  running: '执行中',
  ok: '成功',
  failed: '非零退出',
  error: '失败',
}

const STATUS_CLASS: Record<Hit['status'], string> = {
  queued: 'text-ink-tertiary',
  running: 'text-accent',
  ok: 'text-success',
  failed: 'text-warning',
  error: 'text-danger',
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

export function PaneBatchBar({ panes, deadPanes }: { panes: Pane[]; deadPanes: Record<string, boolean> }) {
  const { setError, setConfirmPrompt } = useApp()

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

  /** 停止只挡住还没开跑的格子，已经在跑的那条让它跑完 */
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
    if (targets.length === 0) {
      setError('这一屏没有勾选任何终端')
      return
    }

    const go = async () => {
      stopped.current = false
      setRunning(true)
      // 每格各跑各的，互不排队：一屏就几格，串行只会让人觉得慢
      setHits(
        Object.fromEntries(targets.map((p) => [p.id, { ...blank(), status: 'queued' as const }])),
      )
      await Promise.all(
        targets.map(async (p) => {
          if (stopped.current) return
          await runOne(p, command)
        }),
      )
      setRunning(false)
    }

    if (DANGEROUS.some((re) => re.test(command))) {
      setConfirmPrompt({
        kind: 'confirm',
        danger: true,
        title: '这条命令有破坏性',
        message: `将在这一屏的 ${targets.length} 个终端上执行它，且没有撤销的机会。`,
        detail: command,
        confirmLabel: `在 ${targets.length} 个终端上执行`,
        onConfirm: () => void go(),
      })
      return
    }
    void go()
  }

  /** 只发送：把命令敲进这几格（要的是现场，拿不到退出码） */
  const send = (targets: Pane[]) => {
    if (command.length === 0) {
      setError('先写要执行的命令')
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
    <div className="shrink-0 border-t border-hairline bg-surface-1">
      {/* 把手：常驻一条，折叠时也只有这一条 —— 分屏的竖向空间比横向金贵 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2 px-2 text-left text-[11px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
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
        <div className="border-t border-hairline px-2 pb-2 pt-1.5">
          {/* 目标：按屏上的顺序列出，勾选 = 这一格参不参与 */}
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
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

          <div className="flex items-start gap-2">
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(chosen)
              }}
              rows={2}
              spellCheck={false}
              placeholder="df -h（Ctrl+Enter 执行）"
              className="min-h-[52px] flex-1 resize-none rounded-md border border-hairline bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
            />
            <div className="flex shrink-0 flex-col gap-1">
              <button
                onClick={() => run(chosen)}
                disabled={running || !canRun}
                className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                title={canRun ? '在勾选的终端上执行（Ctrl+Enter）' : '这一屏只有本地 Shell，用「发送」'}
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                执行
              </button>
              <button
                onClick={() => send(chosen)}
                className="flex h-7 items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
                title="只把命令敲进这几格，不收结果"
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
                title="不再开跑剩下的格子（已经在跑的会跑完）"
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
              className="mt-1.5 text-[11px] text-ink-subtle transition-colors hover:text-ink"
              title="只重跑没成功的那几格"
            >
              重跑未成功的 {failing.length} 格
            </button>
          )}

          {/* 结果：一格一块，横向排 —— 与上面分屏的格子顺序对得上 */}
          {Object.keys(hits).length > 0 && (
            <div className="mt-1.5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {live.map((p, i) => {
                const hit = hits[p.id]
                if (!hit) return null
                const body = [hit.stdout, hit.stderr, hit.message ? `错误：${hit.message}` : '']
                  .filter(Boolean)
                  .join('\n')
                return (
                  <div
                    key={p.id}
                    className="min-w-[240px] flex-1 rounded-md border border-hairline bg-surface-2"
                  >
                    <div className="flex items-center gap-2 border-b border-hairline px-2 py-1">
                      <span className="shrink-0 text-[11px] text-ink-muted">
                        第 {i + 1} 格 · {p.title}
                      </span>
                      <span className={`shrink-0 text-[11px] ${STATUS_CLASS[hit.status]}`}>
                        {hit.status === 'running' && (
                          <Loader2 size={10} className="mr-1 inline animate-spin" />
                        )}
                        {STATUS_TEXT[hit.status]}
                      </span>
                      {hit.exitCode !== null && (
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
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-muted">
                      {body || '（没有输出）'}
                    </pre>
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
