import { useState } from 'react'
import { ArrowLeft, Check, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useApp } from '@/lib/store'
import {
  PALETTE_FIELD_GROUPS,
  findScheme,
  listSchemeChoices,
  newCustomScheme,
  parseImportedPalette,
  type SchemeChoice,
  type TermPalette,
  type TermScheme,
  type TermSchemeMode,
} from '@/lib/termSchemes'
import { Segmented } from './controls'
import { Swatches } from './Swatches'

/**
 * 设置面板里的「终端配色」一节。
 *
 * 两个视图来回切：卡片列表 ⇄ 单套编辑。编辑**不另开弹窗** —— 设置本身就是弹窗，
 * 再叠一个的话两个都是 `z-50`，后挂的（设置）会盖住先挂的，点都点不着。
 *
 * 改动即时生效、即时落 localStorage，跟面板里其他设置一致，没有「保存」按钮。
 */
export function TermSchemeSection() {
  // 预览哪一版由应用当前主题决定：切了浅色主题就该看到浅色版长什么样
  const mode = useApp((s) => s.theme)
  const customSchemes = useApp((s) => s.customSchemes)
  const [editing, setEditing] = useState<string | null>(null)

  const editingScheme = editing ? (customSchemes.find((s) => s.id === editing) ?? null) : null
  if (editingScheme) {
    return <SchemeEditor scheme={editingScheme} onBack={() => setEditing(null)} />
  }
  return <SchemeGrid mode={mode} onEdit={(id) => setEditing(id)} />
}

function nextCustomName(customs: TermScheme[]): string {
  let n = customs.length + 1
  while (customs.some((s) => s.name === `自定义配色 ${n}`)) n += 1
  return `自定义配色 ${n}`
}

function SchemeGrid({ mode, onEdit }: { mode: TermSchemeMode; onEdit: (id: string) => void }) {
  const { termScheme, setTermScheme, customSchemes, saveCustomScheme } = useApp()
  const choices = listSchemeChoices(mode, customSchemes)

  /** 复制一套现有的（没选中任何方案时拿应用默认）做新方案，并直接进编辑器 */
  const duplicateFrom = (fromId: string) => {
    const scheme = newCustomScheme(nextCustomName(customSchemes), findScheme(fromId, customSchemes))
    saveCustomScheme(scheme)
    setTermScheme(scheme.id)
    onEdit(scheme.id)
  }

  return (
    <div className="py-2">
      <div className="mb-2 text-[11px] leading-relaxed text-ink-tertiary">
        每套都带深色、浅色两版，跟着「外观 · 主题」自动切；这里预览的是
        {mode === 'dark' ? '深色' : '浅色'}版。卡片右上角的图标能复制出一套自己的配色。
      </div>
      <div className="grid grid-cols-2 gap-2">
        {choices.map((c) => (
          <SchemeCard
            key={c.id}
            choice={c}
            selected={c.id === termScheme}
            editable={c.custom}
            onSelect={() => setTermScheme(c.id)}
            onAction={() => (c.custom ? onEdit(c.id) : duplicateFrom(c.id))}
          />
        ))}
        <button
          onClick={() => duplicateFrom(termScheme)}
          className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-hairline py-3 text-[12px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
        >
          <Plus size={12} />
          自定义配色
        </button>
      </div>
    </div>
  )
}

function SchemeCard({
  choice,
  selected,
  editable,
  onSelect,
  onAction,
}: {
  choice: SchemeChoice
  selected: boolean
  editable: boolean
  onSelect: () => void
  onAction: () => void
}) {
  return (
    <div
      className={`group relative rounded-md border transition-colors ${
        selected ? 'border-accent/50 bg-accent/10' : 'border-hairline hover:border-hairline-strong'
      }`}
    >
      <button onClick={onSelect} aria-pressed={selected} className="block w-full px-2 py-1.5 text-left">
        {/* 预览条：方案自己的底色 + 16 色小方块 + 一行前景色样例 */}
        <span
          className="flex items-center justify-between rounded px-1.5 py-1"
          style={{ background: choice.palette.background }}
        >
          <Swatches palette={choice.palette} />
          <span
            className="ml-1.5 shrink-0 text-[10px] leading-none"
            style={{ color: choice.palette.foreground }}
          >
            Aa
          </span>
        </span>
        <span className="mt-1.5 flex items-center gap-1.5">
          {selected && <Check size={11} className="shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{choice.name}</span>
          <span className="shrink-0 text-[10px] text-ink-tertiary">{choice.variant}</span>
        </span>
      </button>
      {/* 用透明而不是 hidden：hidden 的元素没法 Tab 聚焦，键盘用户就够不着了 */}
      <button
        onClick={onAction}
        title={editable ? '编辑这套配色' : '复制成一套自定义配色'}
        className="absolute right-1 top-1 rounded bg-surface-1/85 p-1 text-ink-subtle opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
      >
        {editable ? <Pencil size={11} /> : <Copy size={11} />}
      </button>
    </div>
  )
}

function SchemeEditor({ scheme, onBack }: { scheme: TermScheme; onBack: () => void }) {
  // 打开时停在当前应用主题那一版 —— 多半就是要改的那版
  const appTheme = useApp((s) => s.theme)
  const { saveCustomScheme, deleteCustomScheme } = useApp()
  const [mode, setMode] = useState<TermSchemeMode>(appTheme)
  const [nameDraft, setNameDraft] = useState(scheme.name)
  const [importText, setImportText] = useState('')
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const palette = scheme[mode]
  const otherMode: TermSchemeMode = mode === 'dark' ? 'light' : 'dark'
  const modeLabel = (m: TermSchemeMode) => (m === 'dark' ? '深色版' : '浅色版')

  const setColor = (key: keyof TermPalette, value: string) =>
    saveCustomScheme(
      mode === 'dark'
        ? { ...scheme, dark: { ...scheme.dark, [key]: value } }
        : { ...scheme, light: { ...scheme.light, [key]: value } },
    )

  const commitName = () => {
    const name = nameDraft.trim() || scheme.name
    setNameDraft(name)
    saveCustomScheme({ ...scheme, name })
  }

  /** 另一版整套抄过来：从一套深色方案做浅色版时，比一个个挑颜色快得多 */
  const copyOther = () =>
    saveCustomScheme(
      mode === 'dark'
        ? { ...scheme, dark: { ...scheme.light } }
        : { ...scheme, light: { ...scheme.dark } },
    )

  const runImport = () => {
    try {
      const result = parseImportedPalette(importText)
      const next: TermScheme = { ...scheme }
      if (result.palettes.dark) next.dark = result.palettes.dark
      if (result.palettes.light) next.light = result.palettes.light
      saveCustomScheme(next)
      // 单版的方案导入后切到它落进去的那一版，否则用户会以为没导进来
      const single = result.palettes.dark ? (result.palettes.light ? null : 'dark') : 'light'
      if (single) setMode(single)
      setImportMsg({
        ok: true,
        text: `已导入${result.name ? `「${result.name}」的` : ''}${single ? modeLabel(single) : '深浅两版'}`,
      })
      setImportText('')
    } catch (e) {
      setImportMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="py-2">
      <button
        onClick={onBack}
        className="mb-2 flex items-center gap-1 text-[11px] text-ink-subtle transition-colors hover:text-ink"
      >
        <ArrowLeft size={12} />
        返回配色列表
      </button>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={nameDraft}
          placeholder="配色名"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitName()
            }
          }}
          className="h-7 w-40 rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
        />
        <Segmented<TermSchemeMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'dark', label: '深色版' },
            { value: 'light', label: '浅色版' },
          ]}
        />
        <button
          onClick={copyOther}
          title={`把${modeLabel(otherMode)}的 19 个颜色整套抄到${modeLabel(mode)}`}
          className="h-6 rounded-md border border-hairline px-2 text-[11px] text-ink-subtle transition-colors hover:text-ink"
        >
          复制{modeLabel(otherMode)}的颜色
        </button>
      </div>

      {/* 当前这一版的实时预览：改一个色块上面就跟着变 */}
      <div className="mb-3 rounded-md px-2 py-1.5" style={{ background: palette.background }}>
        <div className="flex items-center justify-between gap-2">
          <Swatches palette={palette} />
          <span className="shrink-0 text-[11px]" style={{ color: palette.foreground }}>
            Aa 终端文字样例
          </span>
        </div>
      </div>

      {PALETTE_FIELD_GROUPS.map((group) => (
        <div key={group.title} className="mb-3">
          <div className="mb-1 text-[11px] text-ink-tertiary">{group.title}</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {group.fields.map((f) => (
              <ColorField
                key={f.key}
                label={f.label}
                value={palette[f.key] ?? '#000000'}
                onCommit={(v) => setColor(f.key, v)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mb-3 rounded-md border border-hairline bg-surface-2 p-2">
        <div className="mb-1.5 text-[11px] leading-relaxed text-ink-tertiary">
          导入：粘一套现成的配色进去。支持 Windows Terminal 导出的方案、base16，以及本应用导出的{' '}
          <span className="font-mono">{'{ dark, light }'}</span>。单版的方案按背景明暗自动归到深色版或浅色版。
        </div>
        <textarea
          value={importText}
          onChange={(e) => {
            setImportText(e.target.value)
            setImportMsg(null)
          }}
          rows={3}
          spellCheck={false}
          placeholder='{ "name": "My Theme", "background": "#1e1e2e", "black": "#45475a", … }'
          className="mb-1.5 w-full resize-y rounded border border-hairline bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={runImport}
            disabled={!importText.trim()}
            className="h-6 rounded-md border border-hairline px-2 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:opacity-40 disabled:hover:text-ink-subtle"
          >
            导入
          </button>
          {importMsg && (
            <span className={`text-[11px] ${importMsg.ok ? 'text-success' : 'text-danger'}`}>
              {importMsg.text}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-hairline pt-2">
        {confirmDelete ? (
          <>
            <span className="text-[11px] text-ink-muted">删掉这套配色？删了找不回来。</span>
            <button
              onClick={() => {
                deleteCustomScheme(scheme.id)
                onBack()
              }}
              className="h-6 rounded-md border border-danger/40 bg-danger/10 px-2 text-[11px] text-danger"
            >
              确认删除
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="h-6 rounded-md border border-hairline px-2 text-[11px] text-ink-subtle transition-colors hover:text-ink"
            >
              取消
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 text-[11px] text-ink-subtle transition-colors hover:text-danger"
          >
            <Trash2 size={11} />
            删除这套配色
          </button>
        )}
      </div>
    </div>
  )
}

/** 一个色槽：取色控件 + hex 文本框。文本框失焦/回车才提交，免得打字中途把半个色值写进色板 */
function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  // 外部改了（导入、复制另一版、换深浅版）要跟上
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value)
  }

  const commit = () => {
    const v = draft.trim().replace(/^#/, '')
    if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
      const hex = `#${v.toLowerCase()}`
      setDraft(hex)
      onCommit(hex)
    } else {
      // 认不出的写法打回原值：色板里塞进 xterm 解析不了的颜色，终端会整块变黑
      setDraft(value)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onCommit(e.target.value)}
        className="h-6 w-6 shrink-0 cursor-pointer rounded border border-hairline bg-surface-3 p-0.5"
      />
      <span className="w-7 shrink-0 text-[11px] text-ink-tertiary">{label}</span>
      <input
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        className="h-6 min-w-0 flex-1 rounded border border-hairline bg-surface-3 px-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
      />
    </div>
  )
}
