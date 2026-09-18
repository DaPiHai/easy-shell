import { useEffect, useMemo, useRef, useState } from 'react'
import { SearchAddon } from '@xterm/addon-search'
import type { IDecoration, Terminal } from '@xterm/xterm'
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useApp } from '@/lib/store'
import { paletteFor, searchHighlightColors } from '@/lib/termSchemes'

interface Props {
  /**
   * 搜哪个终端。传 ref 而不是实例：终端重连时会整个换一个 Terminal 对象，
   * 传实例的话搜索栏会一直挂在已经 dispose 的那个上，按了没反应。
   */
  termRef: React.RefObject<Terminal | null>
  onClose: () => void
}

const iconButton =
  'grid h-6 w-6 shrink-0 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink'

/**
 * 终端内查找（`@xterm/addon-search`）。
 *
 * 搜索插件是**按终端**挂的，所以整个生命周期跟着这个框走：框一开就 loadAddon，
 * 框一关就 dispose —— 高亮也跟着一起消失。常驻挂着的话，一段刚 match 过的输出
 * 会在每次写入时重新算一遍装饰，而且关掉框还留着一屏高亮。
 */
export function FindBar({ termRef, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  /** null = 还没搜；index 为 -1 表示匹配数超过插件的 1000 条高亮上限 */
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const addonRef = useRef<SearchAddon | null>(null)
  /** 插件出错只提示一次：查找是边打字边搜的，不拦就会刷满一屏同一个错误 */
  const reportedRef = useRef(false)
  /** 我们自己给「当前匹配」挂的那个 top 层装饰，见 markCurrentMatch */
  const activeDecoRef = useRef<IDecoration | null>(null)

  const report = (e: unknown) => {
    console.warn('[easy-shell] 终端查找失败:', e)
    if (reportedRef.current) return
    reportedRef.current = true
    useApp.getState().setError(`终端查找不可用：${String(e)}`)
  }

  /**
   * 所有搜索动作都从这里走。
   *
   * 插件抛错绝不能冒到 React 的渲染流程里 —— 那会把整个终端标签换成 ErrorBoundary
   * （webgl 的 dispose 就是这么炸过一次）。搜索坏了大不了搜不了，终端得留着。
   */
  const run = (action: (addon: SearchAddon) => void) => {
    const addon = addonRef.current
    if (!addon) return
    try {
      action(addon)
    } catch (e) {
      report(e)
    }
  }

  // 高亮色跟着配色方案走：装饰只认 #RRGGBB，且 8 套方案 × 深浅两版都不能糊，
  // 所以从当前方案自己的选中色派生（见 termSchemes.searchHighlightColors）
  const termScheme = useApp((s) => s.termScheme)
  const theme = useApp((s) => s.theme)
  const customSchemes = useApp((s) => s.customSchemes)

  const options = useMemo(() => {
    const colors = searchHighlightColors(paletteFor(termScheme, theme, customSchemes))
    return {
      caseSensitive,
      decorations: {
        matchBackground: colors.match,
        activeMatchBackground: colors.active,
        matchOverviewRuler: colors.match,
        activeMatchColorOverviewRuler: colors.active,
      },
    }
  }, [termScheme, theme, customSchemes, caseSensitive])

  const clearCurrentMatch = () => {
    const deco = activeDecoRef.current
    activeDecoRef.current = null
    try {
      deco?.dispose()
    } catch {
      /* 终端可能已经没了 */
    }
  }

  /**
   * 把「当前匹配」标出来。
   *
   * 为什么不用插件的 `activeMatchBackground`：xterm 的装饰服务对**同一条线上的**
   * 装饰是按插入位置反着画的（`SortedList` 把相同键的新元素插在最前面），而插件先建
   * 全部普通匹配、最后才建当前匹配 —— 于是当前匹配那几格永远被普通匹配的颜色盖住
   * （实测采样过像素，两个颜色里画出来的是普通那个）。它顺手做的 `select()` 也救不了：
   * 装饰的底色压得住选区。
   * 所以自己挂一个 **top 层**装饰 —— 解析顺序里 top 层排在选区和 bottom 层装饰之后，
   * 谁都盖不住它。位置直接取插件刚设好的选区，`getSelectionPosition()` 给的是缓冲区绝对行。
   */
  const markCurrentMatch = (term: Terminal) => {
    clearCurrentMatch()
    const pos = term.getSelectionPosition()
    if (!pos) return
    // 装饰挂在 marker 上（跟着内容走），而 marker 的偏移是相对光标行算的
    const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY
    const marker = term.registerMarker(pos.start.y - cursorLine)
    if (!marker) return
    // 匹配跨行时只标第一行剩下那段：跨行的多个装饰要一个个建，收益不值这个复杂度
    const width =
      pos.end.y === pos.start.y ? Math.max(1, pos.end.x - pos.start.x) : term.cols - pos.start.x
    const deco = term.registerDecoration({
      marker,
      x: pos.start.x,
      width,
      layer: 'top',
      backgroundColor: options.decorations.activeMatchBackground,
    })
    if (!deco) {
      marker.dispose()
      return
    }
    deco.onDispose(() => marker.dispose())
    activeDecoRef.current = deco
  }

  /** 搜一下 + 把当前匹配标出来。incremental 只高亮不往后跳（边打字边看结果） */
  const search = (direction: 'next' | 'previous' | 'incremental') => {
    const addon = addonRef.current
    const term = termRef.current
    if (!addon || !term || !query) return
    try {
      if (direction === 'incremental') addon.findNext(query, { ...options, incremental: true })
      else if (direction === 'next') addon.findNext(query, options)
      else addon.findPrevious(query, options)
      markCurrentMatch(term)
      repaint(term)
    } catch (e) {
      report(e)
    }
  }

  /**
   * 主动推一次重绘。
   *
   * 高亮是写进渲染模型里的，注册装饰本身**不触发**重绘：不推这一把，高亮要等下一次
   * 终端输出（或窗口尺寸变化）才冒出来，用户会以为搜索没生效 —— 实测就是这个现象。
   */
  const repaint = (term: Terminal) => {
    try {
      term.refresh(0, term.rows - 1)
    } catch (e) {
      report(e)
    }
  }

  // 装载搜索插件。必须早于下面那个查找 effect 声明 —— 同一次 commit 里
  // 副作用按声明顺序跑，反过来的话第一次搜索会撞上 addonRef 还是 null
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    const addon = new SearchAddon()
    const sub = addon.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex, count: e.resultCount }),
    )
    try {
      term.loadAddon(addon)
    } catch (e) {
      console.warn('[easy-shell] 搜索插件加载失败:', e)
      sub.dispose()
      return
    }
    addonRef.current = addon

    return () => {
      addonRef.current = null
      sub.dispose()
      clearCurrentMatch()
      try {
        addon.clearDecorations()
        addon.dispose()
      } catch (e) {
        // 关标签时 React 先跑父组件的清理，终端可能已经被 dispose 了，
        // 这时 addon 的 dispose 会踩到 xterm 里已经清空的状态（跟 webgl 那个坑同源）。
        // 拦下来，别让它冒到 ErrorBoundary 变成黑面板
        console.warn('[easy-shell] 搜索插件卸载抛错（已忽略）:', e)
      }
      try {
        term.clearSelection()
      } catch {
        /* 终端已经没了 */
      }
    }
  }, [termRef])

  /**
   * 查询一变就重搜一次，incremental 只把视口带到匹配处、不往后跳 ——
   * 边打字边看得到结果，这正是搜索框该有的手感，「下一个」交给 Enter / 按钮。
   */
  useEffect(() => {
    if (!query) {
      clearCurrentMatch()
      run((addon) => addon.clearDecorations())
      setResults(null)
      // 清空查询也要重绘一次，否则上一次的高亮会赖在屏幕上
      const term = termRef.current
      if (term) repaint(term)
      return
    }
    search('incremental')
    // search 每次都新读 addonRef/termRef，不该进依赖表（进去就每次渲染都重搜）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, options])

  const step = (direction: 'next' | 'previous') => {
    if (!query) return
    search(direction)
  }

  const close = () => {
    // 焦点还给终端：用户是从终端里按 Ctrl+Shift+F 喊出来的，关掉就该能接着敲命令
    termRef.current?.focus()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? 'previous' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  const label = !query
    ? ''
    : !results || results.count === 0
      ? '无匹配'
      : results.index < 0
        ? `${results.count}+`
        : `${results.index + 1}/${results.count}`

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-md border border-hairline bg-surface-1 py-1 pl-2 pr-1">
      <Search size={12} className="shrink-0 text-ink-tertiary" />
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="在终端里查找…"
        className="h-6 w-40 bg-transparent px-1 text-[12px] text-ink outline-none placeholder:text-ink-tertiary"
      />
      <span
        className={`w-12 shrink-0 text-center text-[11px] ${
          label === '无匹配' ? 'text-danger' : 'text-ink-tertiary'
        }`}
      >
        {label}
      </span>
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        className={`${iconButton} ${caseSensitive ? 'bg-surface-3 text-accent' : ''}`}
        title={caseSensitive ? '区分大小写（已开）' : '区分大小写（已关）'}
      >
        <CaseSensitive size={13} />
      </button>
      <button onClick={() => step('previous')} className={iconButton} title="上一个（Shift+Enter）">
        <ChevronUp size={13} />
      </button>
      <button onClick={() => step('next')} className={iconButton} title="下一个（Enter）">
        <ChevronDown size={13} />
      </button>
      <button onClick={close} className={iconButton} title="关闭（Esc）">
        <X size={13} />
      </button>
    </div>
  )
}
