import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { DEFAULT_TERM_FONT, useApp } from '@/lib/store'
import { firstFamily, fontStackValue, forgetFonts, listFonts, type FontChoice } from '@/lib/fonts'

/**
 * 终端字体的挑选器：下拉框列出**本机真装了**的字体，每个名字用它自己的字体渲染。
 *
 * 为什么不做成浮层：设置面板的内容区是 `overflow-y-auto` 的，而面板自己还带
 * `-translate-x-1/2`（transform 会把 `position: fixed` 的包含块拽到自己身上）——
 * 浮层会被裁在面板里。所以这个下拉框是**就地展开**的一块内容，跟着面板一起滚。
 *
 * 清单来自 `lib/fonts.ts`（Rust 那边读系统字体表），这里只管挑：
 * 搜索、只看等宽、以及"自定义…"那条手写整串字体栈的口子。
 * Esc 不在这里处理 —— 按项目惯例，Esc 关的是整个设置面板（`App.tsx` 的全局按键）。
 */
export function FontFamilyPicker() {
  const termFontFamily = useApp((s) => s.termFontFamily)
  const setTermFontFamily = useApp((s) => s.setTermFontFamily)

  const [open, setOpen] = useState(false)
  const [fonts, setFonts] = useState<FontChoice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [monoOnly, setMonoOnly] = useState(true)
  /** 非 null = 正在手写一整串字体栈 */
  const [custom, setCustom] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = async (force: boolean) => {
    if (force) forgetFonts()
    setLoading(true)
    setFonts(await listFonts())
    setLoading(false)
  }

  useEffect(() => {
    // 只依赖 open：清单读一次就够（`listFonts` 自己缓存），"刚装完字体"那条路走重新扫描按钮
    if (open && !fonts && !loading) void load(false)
    // 展开时把光标送进搜索框：这里多半就是来打几个字过滤的
    if (open) searchRef.current?.focus()
  }, [open])

  /**
   * 挑中一个字体的收尾。两个入口分开：
   * - 列表里的字体族名要**加引号**（`Fira Code` 不加引号整条 font 简写会失效）
   * - 「自定义」写进来的是一整串栈，原样存（它自己该带引号）
   *
   * 混成一个函数的话，自定义那串会被当成"一个族名"再套一层引号 ——
   * 探针量出来过：存进去成了 `"\"Fira Code\", Consolas"`，终端当然解析不了。
   */
  const finish = (value: string) => {
    setTermFontFamily(value)
    setOpen(false)
    setQuery('')
    setCustom(null)
  }
  const pick = (family: string) => finish(family ? fontStackValue(family) : '')

  const q = query.trim().toLowerCase()
  const shown = (fonts ?? []).filter(
    (f) => (!monoOnly || f.mono) && (!q || f.family.toLowerCase().includes(q)),
  )
  const current = firstFamily(termFontFamily)

  return (
    <div className="w-[240px]">
      <button
        data-font-picker
        onClick={() => setOpen((v) => !v)}
        title={termFontFamily || `内置字体栈：${DEFAULT_TERM_FONT}`}
        className="flex h-7 w-full items-center gap-1.5 rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink transition-colors hover:border-hairline-tertiary"
      >
        <span className="min-w-0 flex-1 truncate text-left">{current || '内置字体栈'}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-ink-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div data-font-panel className="mt-2 rounded-md border border-hairline bg-surface-2 p-2">
          <input
            data-font-search
            ref={searchRef}
            value={query}
            placeholder="搜索字体…"
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-full rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
            <button
              data-font-mono-only
              aria-pressed={monoOnly}
              onClick={() => setMonoOnly((v) => !v)}
              title="终端字体基本都是等宽的。关掉它就能看到本机全部字体"
              className={`h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors ${
                monoOnly
                  ? 'border-accent/40 bg-accent/15 text-ink'
                  : 'border-hairline text-ink-subtle hover:text-ink'
              }`}
            >
              只看等宽
            </button>
            <span className="min-w-0 flex-1 truncate">
              {loading ? '正在读系统字体…' : fonts ? `${shown.length} / ${fonts.length} 个字体` : ''}
            </span>
            <button
              data-font-custom
              onClick={() => setCustom(termFontFamily)}
              title="手写一整串字体栈，比如一套中文 + 一套等宽"
              className="shrink-0 transition-colors hover:text-ink"
            >
              自定义…
            </button>
            <button
              onClick={() => void load(true)}
              disabled={loading}
              title="重新扫描本机字体（刚装完字体不用重启）"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-hairline text-ink-subtle transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {custom !== null ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                data-font-custom-input
                autoFocus
                value={custom}
                placeholder='例如 "Fira Code", Consolas, monospace'
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    finish(custom.trim())
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-surface-3 px-2 font-mono text-[11px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
              />
              <button
                data-font-custom-apply
                onClick={() => finish(custom.trim())}
                className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                应用
              </button>
              <button
                onClick={() => setCustom(null)}
                className="h-7 shrink-0 rounded-md border border-hairline px-2 text-[12px] text-ink-muted transition-colors hover:text-ink"
              >
                返回列表
              </button>
            </div>
          ) : (
            <div
              data-font-list
              className="mt-1.5 max-h-56 overflow-y-auto rounded-md border border-hairline bg-surface-1"
            >
              <FontOption
                label="内置字体栈"
                cssFont={DEFAULT_TERM_FONT}
                active={termFontFamily === ''}
                onClick={() => pick('')}
              />
              {shown.map((f) => (
                <FontOption
                  key={f.family}
                  label={f.family}
                  cssFont={fontStackValue(f.family)}
                  note={f.mono ? undefined : '非等宽'}
                  active={termFontFamily === fontStackValue(f.family)}
                  onClick={() => pick(f.family)}
                />
              ))}
              {!loading && shown.length === 0 && (
                <div className="px-2 py-3 text-[11px] leading-relaxed text-ink-tertiary">
                  {fonts && fonts.length === 0
                    ? '没读到本机的字体清单。可以用「自定义…」直接写字体名或一整串字体栈。'
                    : '没有匹配的字体。'}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 一行候选：名字用它**自己的**字体画出来，就是最直观的预览。
 *
 * `cssFont` 要的是**能直接塞进 `style.fontFamily` 的值**（族名要带引号，或者干脆是一整串栈）——
 * 给裸的多词族名（`Fira Code`）是无效 CSS，浏览器会整条丢掉、悄悄退回继承的字体。
 */
function FontOption({
  label,
  cssFont,
  note,
  active,
  onClick,
}: {
  label: string
  cssFont: string
  note?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      data-font-option={label}
      onClick={onClick}
      title={label}
      className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-2 ${
        active ? 'text-ink' : 'text-ink-muted'
      }`}
    >
      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: cssFont }}>
        {label}
      </span>
      {note && <span className="shrink-0 text-[10px] text-ink-tertiary">{note}</span>}
      {active && <Check size={12} className="shrink-0 text-accent" />}
    </button>
  )
}
