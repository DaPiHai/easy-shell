import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Loader2,
  Play,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import { panesOf, useApp } from '@/lib/store'
import {
  parseConnectError,
  sshClose,
  sshConnect,
  sshExec,
  type HostRecord,
} from '@/lib/api'
import { hostToConfig } from '../session/connectHost'
import { hostEndpoint, hostLabel, tagTone } from '@/lib/hosts'

/**
 * 批量执行面板：勾几台主机、写一条命令、并发跑完把每台的输出收回来。
 *
 * 两条路都在这里，因为它们回答的是两个不同的问题：
 *   - **执行**（`ssh_exec`）：要的是结果 —— 退出码、stdout、耗时，能导出能重跑；
 *   - **发到已开终端**：要的是现场 —— 把命令敲进你已经开着的那些终端里继续盯。
 *
 * 后端只提供「在一条已连着的会话上跑一条命令」这一件事，**连不连、并发几个都在前端**：
 * 哪台主机已经有连接（`Tab.panes` 上的 sessionId）只有前端知道。
 */

/** 一台主机上的一次执行 */
interface Row {
  hostId: string
  name: string
  address: string
  /** queued 排队中 / running 跑着 / ok 退出码 0 / failed 非 0 / error 连不上或超时 / sent 已发到终端 */
  status: 'queued' | 'running' | 'ok' | 'failed' | 'error' | 'sent'
  exitCode: number | null
  stdout: string
  stderr: string
  /** 毫秒 */
  ms: number
  /** 失败原因（连不上、超时…） */
  message?: string
  /** 用的是已经建好的连接，没重新认证 */
  reused: boolean
  timedOut?: boolean
}

const inputClass =
  'h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

/** 小号数字输入（超时 / 并发） */
const numClass = 'h-8 w-16 rounded-md border border-hairline bg-surface-3 px-2 text-[13px] text-ink outline-none focus:border-accent'

const btnClass =
  'flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40'

const primaryClass =
  'flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus disabled:cursor-not-allowed disabled:opacity-40'

const STATUS_TEXT: Record<Row['status'], string> = {
  queued: '排队中',
  running: '执行中',
  ok: '成功',
  failed: '非零退出',
  error: '失败',
  sent: '已发送',
}

const STATUS_CLASS: Record<Row['status'], string> = {
  queued: 'text-ink-tertiary',
  running: 'text-accent',
  ok: 'text-success',
  failed: 'text-warning',
  error: 'text-danger',
  sent: 'text-ink-subtle',
}

/**
 * 一眼就该拦下的命令。
 *
 * 为什么只拦这几条而不是每条都问：批量执行是**一次在 N 台机器上**跑命令，
 * 按下去的后果是 N 倍。全问一遍的话第一次之后人人都会盲点确认，
 * 那道确认就等于没有了 —— 所以只在这几条"跑错了就出事"的命令上问。
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

function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command))
}

export function BatchPanel({ initialHostIds }: { initialHostIds?: string[] }) {
  const { hosts, groups, setError, setConfirmPrompt, tabs, deadPanes } = useApp()

  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialHostIds ?? []))
  const [command, setCommand] = useState('')
  const [timeoutSecs, setTimeoutSecs] = useState(30)
  const [concurrency, setConcurrency] = useState(8)
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * 勾中的**终端格子**（paneId），跟上面那组主机 id 是两码事。
   *
   * 分屏窗口的批量执行走这一组：「发到已开终端」按格子投递、**不去重**，
   * 所以同一台主机上开着的两格（分屏很常见）会各收到一份，
   * 而按主机投递永远只能投一格 —— 那正是分屏下少了半边的原因。
   */
  const [pickedPanes, setPickedPanes] = useState<Set<string>>(new Set())

  /** 「停止」只挡住还没开始的那几台，已经在跑的命令让它跑完 —— 半路掐掉更糟 */
  const stopped = useRef(false)
  useEffect(() => () => { stopped.current = true }, [])

  /** 哪些主机已经有活着的连接（跟会话树那个绿灯同一条规则） */
  const connectedHosts = useMemo(() => {
    const set = new Set<string>()
    for (const p of tabs.flatMap(panesOf)) {
      if (p.hostId && p.sessionId && !deadPanes[p.id]) set.add(p.hostId)
    }
    return set
  }, [tabs, deadPanes])

  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    if (!kw) return hosts
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(kw) ||
        h.address.toLowerCase().includes(kw) ||
        h.username.toLowerCase().includes(kw),
    )
  }, [hosts, filter])

  /**
   * 现在开着的终端格子（一行一格，含分屏）。
   *
   * 这是「分屏窗口批量执行」的目标来源：一个标签里有几格就列几行，
   * 勾上谁就把命令敲进谁 —— 想同时给分屏里的两格发同一批命令，勾两行即可。
   */
  const openPanes = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    const out: Array<{ paneId: string; tabId: string; tabTitle: string; title: string; where: string }> = []
    for (const tab of tabs) {
      const panes = panesOf(tab)
      panes.forEach((p, i) => {
        if (!p.sessionId || deadPanes[p.id]) return
        const host = hosts.find((h) => h.id === p.hostId)
        const where = host ? `${host.username}@${host.address}:${host.port}` : '本地 Shell'
        // 分屏才写第几格：单格标签重复一遍"第 1 格"只是噪音
        const title = panes.length > 1 ? `${p.title} · 第 ${i + 1} 格` : p.title
        if (kw && !`${title} ${where}`.toLowerCase().includes(kw)) return
        out.push({ paneId: p.id, tabId: tab.id, tabTitle: tab.title, title, where })
      })
    }
    return out
  }, [tabs, deadPanes, hosts, filter])

  /**
   * 关掉的格子要从勾选集合里退出去。
   *
   * 不退的话「已选 N 个终端格子」会一直算着那个已经不存在的格子 ——
   * 数字对不上、发送时又静默跳过，看着像丢了一份命令。
   */
  useEffect(() => {
    const alive = new Set(openPanes.map((p) => p.paneId))
    setPickedPanes((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [openPanes])

  const togglePane = (paneId: string) =>
    setPickedPanes((prev) => {
      const next = new Set(prev)
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      return next
    })

  /** 一键勾上当前标签的所有格子 —— 分屏下"这一屏全发"的最短路径 */
  const pickActiveTabPanes = () => {
    const s = useApp.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const panes = panesOf(tab).filter((p) => p.sessionId && !s.deadPanes[p.id])
    if (panes.length === 0) {
      setError('当前标签没有开着的终端 —— 先切到一个终端标签')
      return
    }
    setPickedPanes(new Set(panes.map((p) => p.id)))
  }

  const rowOf = (hostId: string) => rows.find((r) => r.hostId === hostId)

  /**
   * 结果的同步镜像。
   *
   * 并发跑的时候每一行都在各自更新，`rows` 在闭包里读到的是这一轮开始时的旧值 ——
   * 收尾那句「成功几台 / 失败几台」要数的是**最新**结果，所以顺手留一份引用。
   */
  const rowsRef = useRef<Row[]>([])
  const patch = (hostId: string, p: Partial<Row>) =>
    setRows((prev) => {
      const next = prev.map((r) => (r.hostId === hostId ? { ...r, ...p } : r))
      rowsRef.current = next
      return next
    })

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleGroup = (groupId: string | null) => {
    const members = hosts.filter((h) => (h.groupId ?? null) === groupId)
    setSelected((prev) => {
      const next = new Set(prev)
      const allIn = members.length > 0 && members.every((h) => next.has(h.id))
      for (const h of members) {
        if (allIn) next.delete(h.id)
        else next.add(h.id)
      }
      return next
    })
  }

  const chosen = hosts.filter((h) => selected.has(h.id))

  /** 这台主机现在有没有一个开着的终端可以"投递命令" */
  const livePaneOf = (hostId: string) => {
    const s = useApp.getState()
    return s.tabs
      .flatMap(panesOf)
      .find((p) => p.hostId === hostId && p.sessionId && !s.deadPanes[p.id])
  }

  /**
   * 连一台主机。
   *
   * **失败不弹窗**：批量跑的时候弹一次确认框会把整批打断，而后面十几台还在排队。
   * 所以把原因翻成人话返回，由那一行自己显示 —— 主机密钥不符 / 算法不兼容这种
   * 「单台自己的问题」正好是该留在行里的信息。
   */
  const connectFor = async (host: HostRecord): Promise<{ sessionId: string } | { error: string }> => {
    try {
      return { sessionId: await sshConnect(hostToConfig(host)) }
    } catch (e) {
      const failure = parseConnectError(e)
      if (failure.kind === 'host_key_mismatch') {
        return { error: '主机密钥与已记录的不符（在会话树里连一次可处理）' }
      }
      if (failure.kind === 'algorithms_unsupported') {
        return {
          error: failure.compatHint
            ? '算法不兼容：在这台主机上勾「兼容模式」再试'
            : failure.message.split('\n')[0],
        }
      }
      return { error: failure.message }
    }
  }

  const runOne = async (host: HostRecord) => {
    patch(host.id, { status: 'running', message: undefined, timedOut: undefined })
    const started = Date.now()

    // 已连着的就复用那条会话（不再认证一次，也不多占服务端一个连接槽位），
    // 没连过的才为这一条命令单独建连，跑完立刻还回去
    const live = livePaneOf(host.id)
    let sessionId = live?.sessionId ?? null
    const reused = !!sessionId
    if (!sessionId) {
      const got = await connectFor(host)
      if ('error' in got) {
        patch(host.id, { status: 'error', message: got.error, ms: Date.now() - started })
        return
      }
      sessionId = got.sessionId
    }

    try {
      const result = await sshExec(sessionId, command, timeoutSecs)
      const ms = Date.now() - started
      if (result.timedOut) {
        patch(host.id, {
          status: 'error',
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          message: '执行超时，输出已截断',
          timedOut: true,
          ms,
        })
        return
      }
      patch(host.id, {
        status: result.exitCode === 0 ? 'ok' : 'failed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ms,
      })
    } catch (e) {
      patch(host.id, { status: 'error', message: String(e), ms: Date.now() - started })
    } finally {
      // 这条连接是为这一条命令开的：用完就还。留着等于每台机器常驻一条连接，
      // 服务端 MaxSessions 一下就见底
      if (!reused && sessionId) void sshClose(sessionId)
    }
  }

  const blankRow = (h: HostRecord): Row => ({
    hostId: h.id,
    // 显示用名字：用户起过名就用那个，没起名回退成 用户名@地址
    name: hostLabel(h),
    address: `${h.username}@${h.address}:${h.port}`,
    status: 'queued',
    exitCode: null,
    stdout: '',
    stderr: '',
    ms: 0,
    reused: false,
  })

  /**
   * 跑一批。
   *
   * `retry` 为真时只把这几台重置回「排队中」，**保留**其它台的结果 ——
   * 重跑失败项不该把已经成功的那些从列表里抹掉，那是用户正看着的东西。
   */
  const runAll = async (targets: HostRecord[], retry = false) => {
    if (running) return
    /**
     * 判空看**原值**，不 trim。
     *
     * `trim()` 会把用户敲的换行一起吃掉 —— 于是"只发一个空回车"这种命令
     * 永远发不出去（输入框里看着有内容，一点执行就说"先写命令"）。
     * 空回车在真实场景里是有用的：确认一个提示、把提示符推下来一行。
     * 只有长度真的是 0 才算"没写"。
     */
    if (command.length === 0) {
      setError('先写要执行的命令')
      return
    }
    if (targets.length === 0) {
      if (retry) {
        setError('没有失败的项需要重跑')
      } else if (pickedPanes.size > 0) {
        // 只勾了终端格子：那是「发到已开终端」的目标，别让人以为按键坏了
        setError('「执行」按主机跑（要结果）—— 只给分屏里那几格发命令请用「发到已开终端」')
      } else {
        setError('先在左边勾上要执行的主机')
      }
      return
    }

    const go = async () => {
      stopped.current = false
      setRunning(true)
      if (retry) {
        const ids = new Set(targets.map((h) => h.id))
        setRows((prev) => {
          const next = prev.map((r) =>
            ids.has(r.hostId)
              ? {
                  ...r,
                  status: 'queued' as const,
                  exitCode: null,
                  stdout: '',
                  stderr: '',
                  ms: 0,
                  message: undefined,
                  timedOut: undefined,
                }
              : r,
          )
          rowsRef.current = next
          return next
        })
      } else {
        // 结果按勾选顺序排，跑完一台就更新一台 —— 别让用户干等到最后一批
        const fresh = targets.map(blankRow)
        rowsRef.current = fresh
        setRows(fresh)
      }

      const queue = [...targets]
      const lanes = Math.max(1, Math.min(concurrency, queue.length))
      const worker = async () => {
        while (queue.length > 0 && !stopped.current) {
          const host = queue.shift()
          if (!host) return
          await runOne(host)
        }
      }
      await Promise.all(Array.from({ length: lanes }, worker))
      setRunning(false)

      // 收尾给一句总计：跑完 20 台时不说一句，用户得自己去数绿的有几个。
      // 读 rowsRef —— 这里的 rows 是这一轮开始时的闭包值，早过时了
      const ok = rowsRef.current.filter((r) => r.status === 'ok').length
      const bad = rowsRef.current.filter(
        (r) => r.status === 'failed' || r.status === 'error',
      ).length
      setError(`完成：${ok} 台成功，${bad} 台失败`)
    }

    // 危险命令问一句。**不在这里问"确定要在 N 台机器上跑吗"** ——
    // 那句每次都弹，弹到第三次就没人看了
    if (isDangerous(command)) {
      setConfirmPrompt({
        kind: 'confirm',
        danger: true,
        title: '这条命令有破坏性',
        message: `将在 ${targets.length} 台主机上执行它，且没有撤销的机会。`,
        detail: command,
        confirmLabel: `在 ${targets.length} 台主机上执行`,
        onConfirm: () => void go(),
      })
      return
    }
    await go()
  }

  /**
   * 把命令敲进已经开着的终端。
   *
   * 两类目标，优先级分明：
   * 1. **勾了终端格子**（上面那段）—— 按格子逐个投，**不去重**。这就是分屏窗口的
   *    批量执行：同一台主机开两格也各收一份（按主机投递永远只能投一格，分屏下正是少了半边）；
   * 2. 只勾了主机 —— 退回"每台一格"的老行为，省得为了发一条命令还得先去勾格子。
   */
  const sendToTerminals = () => {
    // 同 runAll：只拦"真的什么都没写"。**输入的换行要原样留着** ——
    // 敲一个空回车到终端是很常见的需求（推一行提示符、确认掉一个提示），
    // trim 之后这类命令会被判成空而被拦住
    if (command.length === 0) {
      setError('先写要执行的命令')
      return
    }
    // 末尾有换行就照原样发，没有才补一个：发"空回车"时补一个会变成两个
    const payload = command.endsWith('\n') ? command : `${command}\n`
    const s = useApp.getState()
    let sent = 0

    if (pickedPanes.size > 0) {
      for (const paneId of pickedPanes) {
        const sink = s.terminalSinks[paneId]
        if (!sink) continue
        sink(payload)
        sent += 1
      }
      if (sent === 0) {
        setError('勾中的终端格子都没了 —— 重新勾一次')
        return
      }
      setError(`已发到 ${sent} 个终端格子`)
      return
    }

    const seen = new Set<string>()
    for (const host of chosen) {
      if (seen.has(host.id)) continue
      const pane = livePaneOf(host.id)
      if (!pane) continue
      const sink = s.terminalSinks[pane.id]
      if (!sink) continue
      seen.add(host.id)
      sink(payload)
      sent += 1
    }
    if (sent === 0) {
      setError('没有可投递的终端 —— 上面勾终端格子，或用「执行」自己建连')
      return
    }
    setError(`已发到 ${sent} 个终端`)
  }

  const copyResults = async () => {
    if (rows.length === 0) {
      setError('还没有结果可复制')
      return
    }
    const text = rows
      .map((r) => {
        const head = `=== ${r.name} (${r.address}) === ${STATUS_TEXT[r.status]}${
          r.exitCode === null ? '' : ` exit=${r.exitCode}`
        } ${r.ms}ms${r.reused ? ' （复用已有连接）' : ''}`
        const body = [r.stdout, r.stderr, r.message ? `错误：${r.message}` : '']
          .filter(Boolean)
          .join('\n')
        return `${head}\n${body}`
      })
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setError(`已复制 ${rows.length} 条结果`)
    } catch {
      setError('复制失败：系统剪贴板不可用')
    }
  }

  const failedHosts = hosts.filter((h) => {
    const r = rowOf(h.id)
    return !!r && (r.status === 'failed' || r.status === 'error')
  })

  const renderHost = (host: HostRecord) => {
    const row = rowOf(host.id)
    return (
      <div
        key={host.id}
        className="flex h-7 items-center gap-2 rounded px-1 text-ink-muted transition-colors hover:bg-surface-2"
      >
        <input
          type="checkbox"
          checked={selected.has(host.id)}
          onChange={() => toggle(host.id)}
          className="h-3 w-3 shrink-0 accent-accent"
        />
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            connectedHosts.has(host.id) ? 'bg-success' : 'bg-ink-tertiary'
          }`}
          title={connectedHosts.has(host.id) ? '已连接（执行时复用这条）' : '未连接'}
        />
        <button
          onClick={() => toggle(host.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={hostEndpoint(host)}
        >
          {/* 起了名显名字，没起名就是 用户名@地址 —— 跟会话树同一套写法 */}
          <span className="min-w-0 truncate text-[13px]">{hostLabel(host)}</span>
          {(host.tags ?? []).slice(0, 2).map((t) => (
            <span key={t} className={`shrink-0 rounded-sm px-1 py-px text-[10px] ${tagTone(t)}`}>
              {t}
            </span>
          ))}
          <span className="ml-auto truncate pl-1 text-[11px] text-ink-tertiary">
            {host.address}
          </span>
        </button>
        {/* 结果状态就地显示在目标列表上：跑完不用挨个点开看哪台红了 */}
        {row && (
          <span
            className={`shrink-0 text-[11px] ${STATUS_CLASS[row.status]}`}
            title={row.message ?? (row.exitCode === null ? '' : `退出码 ${row.exitCode}`)}
          >
            {STATUS_TEXT[row.status]}
          </span>
        )}
      </div>
    )
  }

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* 命令区 */}
      <div className="shrink-0 border-b border-hairline bg-surface-1 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] font-medium text-ink">批量执行</span>
          <span className="text-[11px] text-ink-tertiary">
            已选 {chosen.length} 台主机
            {pickedPanes.size > 0 ? ` / ${pickedPanes.size} 个终端格子` : ''}
            {' · '}
            连接着的会复用，没连的跑完即断
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => void runAll(chosen)}
              disabled={running}
              className={primaryClass}
              title="在勾选的主机上并发执行（Ctrl+Enter）"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              执行
            </button>
            <button
              onClick={() => {
                stopped.current = true
              }}
              disabled={!running}
              className={btnClass}
              title="不再启动剩下的主机（已经在跑的会跑完）"
            >
              <Square size={12} />
              停止
            </button>
          </div>
        </div>

        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void runAll(chosen)
          }}
          rows={3}
          spellCheck={false}
          placeholder="df -h"
          className="w-full resize-none rounded-md border border-hairline bg-surface-3 px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
        />

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
            超时
            <input
              type="number"
              min={1}
              max={3600}
              value={timeoutSecs}
              onChange={(e) => setTimeoutSecs(Number(e.target.value))}
              className={numClass}
            />
            秒
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
            并发
            <input
              type="number"
              min={1}
              max={32}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className={numClass}
            />
            台
          </label>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={sendToTerminals}
              className={btnClass}
              title={
                pickedPanes.size > 0
                  ? `把命令敲进勾中的 ${pickedPanes.size} 个终端格子（分屏各格各一份）`
                  : '把命令敲进勾选主机已经开着的终端（每台一格）'
              }
            >
              <Send size={12} />
              发到已开终端
            </button>
            <button
              onClick={() => void runAll(failedHosts, true)}
              disabled={running || failedHosts.length === 0}
              className={btnClass}
              title="只重跑失败/非零退出的那几台"
            >
              <RotateCcw size={12} />
              重跑失败项{failedHosts.length > 0 ? `（${failedHosts.length}）` : ''}
            </button>
            <button onClick={() => void copyResults()} className={btnClass} title="把所有结果复制成文本">
              <ClipboardCopy size={12} />
              复制结果
            </button>
            <button
              onClick={() => {
                rowsRef.current = []
                setRows([])
                setExpanded(new Set())
              }}
              disabled={running || rows.length === 0}
              className={btnClass}
              title="清空结果列表"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：选目标 —— 上半是开着的终端格子（分屏那一屏就在这儿勾），下半是主机库 */}
        <div className="flex w-64 shrink-0 flex-col border-r border-hairline bg-surface-1">
          <div className="flex items-center gap-1 px-2 py-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤主机 / 终端"
              className={inputClass}
            />
          </div>

          {/* 开着的终端：分屏窗口的批量执行在这里勾格子 */}
          <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-ink-tertiary">
            <span className="font-medium text-ink-subtle">开着的终端</span>
            <span className="text-ink-tertiary">{openPanes.length}</span>
            <button
              onClick={pickActiveTabPanes}
              className="ml-auto hover:text-ink"
              title="勾上当前标签的所有格子（分屏一屏全发）"
            >
              本屏格子
            </button>
            <button onClick={() => setPickedPanes(new Set())} className="hover:text-ink">
              清空
            </button>
          </div>
          <div className="max-h-40 shrink-0 overflow-y-auto border-b border-hairline px-2 pb-2">
            {openPanes.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-tertiary">
                现在没有开着的终端
              </p>
            ) : (
              openPanes.map((t) => (
                <label
                  key={t.paneId}
                  className="flex h-7 cursor-pointer items-center gap-2 rounded px-1 text-ink-muted transition-colors hover:bg-surface-2"
                  title={`${t.tabTitle} · ${t.where} —— 勾上就把命令敲进这一格`}
                >
                  <input
                    type="checkbox"
                    checked={pickedPanes.has(t.paneId)}
                    onChange={() => togglePane(t.paneId)}
                    className="h-3 w-3 shrink-0 accent-accent"
                  />
                  <span className="truncate text-[13px]">{t.title}</span>
                  <span className="ml-auto truncate text-[11px] text-ink-tertiary">{t.where}</span>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] text-ink-tertiary">
            <span className="font-medium text-ink-subtle">主机</span>
            <button onClick={() => setSelected(new Set(visible.map((h) => h.id)))} className="ml-auto hover:text-ink">
              全选
            </button>
            <button onClick={() => setSelected(new Set())} className="hover:text-ink">
              清空
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {groups.map((g) => {
              const members = visible.filter((h) => h.groupId === g.id)
              if (members.length === 0) return null
              return (
                <div key={g.id} className="mb-1">
                  <button
                    onClick={() => toggleGroup(g.id)}
                    className="flex h-7 w-full items-center gap-1 rounded px-1 text-left text-[12px] font-medium text-ink-subtle hover:bg-surface-2 hover:text-ink"
                  >
                    <ChevronDown size={12} />
                    {g.name}
                    <span className="ml-auto text-[11px] text-ink-tertiary">{members.length}</span>
                  </button>
                  {members.map(renderHost)}
                </div>
              )
            })}
            {(() => {
              const members = visible.filter((h) => !h.groupId)
              if (members.length === 0) return null
              return (
                <div className="mb-1">
                  <button
                    onClick={() => toggleGroup(null)}
                    className="flex h-7 w-full items-center gap-1 rounded px-1 text-left text-[12px] font-medium text-ink-subtle hover:bg-surface-2 hover:text-ink"
                  >
                    <ChevronDown size={12} />
                    未分组
                    <span className="ml-auto text-[11px] text-ink-tertiary">{members.length}</span>
                  </button>
                  {members.map(renderHost)}
                </div>
              )
            })()}
            {hosts.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-tertiary">
                还没有保存的主机
                <br />
                按 Ctrl+N 新建会话
              </p>
            )}
          </div>
        </div>

        {/* 右：结果 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-[12px] leading-relaxed text-ink-tertiary">
              勾主机、写命令，然后点「执行」
              <br />
              每台的输出、退出码和耗时会列在这里
            </p>
          ) : (
            rows.map((r) => {
              const open = expanded.has(r.hostId)
              const body = [r.stdout, r.stderr].filter(Boolean).join('\n')
              return (
                <div key={r.hostId} className="border-b border-hairline">
                  <button
                    onClick={() => toggleExpand(r.hostId)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-1"
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-ink-tertiary" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-ink-tertiary" />
                    )}
                    <span className="shrink-0 text-[13px] text-ink">{r.name}</span>
                    <span className="truncate text-[11px] text-ink-tertiary">{r.address}</span>
                    <span className={`shrink-0 text-[11px] ${STATUS_CLASS[r.status]}`}>
                      {r.status === 'running' && <Loader2 size={11} className="mr-1 inline animate-spin" />}
                      {STATUS_TEXT[r.status]}
                    </span>
                    {r.exitCode !== null && (
                      <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                        exit {r.exitCode}
                      </span>
                    )}
                    {r.timedOut && (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning">
                        <AlertTriangle size={11} />
                        超时
                      </span>
                    )}
                    {r.reused && (
                      <span className="shrink-0 text-[11px] text-ink-tertiary" title="用的是已建好的连接">
                        复用
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">
                      {r.ms} ms
                    </span>
                  </button>
                  {open && (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-surface-1 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-muted">
                      {body || r.message || '（没有输出）'}
                      {r.message && body ? `\n错误：${r.message}` : ''}
                    </pre>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
