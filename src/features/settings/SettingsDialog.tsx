import { useState } from 'react'
import { RotateCcw, Settings as SettingsIcon } from 'lucide-react'
import {
  DEFAULT_TERM_FONT,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MIN_RETRY_ATTEMPTS,
  MIN_RETRY_DELAY,
  MIN_SCROLLBACK,
  useApp,
  type CursorStyle,
} from '@/lib/store'
import { ModalActions, ModalShell, modalButton } from '@/components/ModalShell'

/**
 * 设置面板。
 *
 * 这里收拢的是原先散落各处的常量与开关：字号以前只有快捷键、字体族/行高/光标样式/
 * 回滚行数/重连策略干脆写死在代码里、主题重启就回深色。**改完即时生效**，
 * 不设「保存」按钮 —— 调字号这种事本来就该一边看一边调。
 *
 * 目前只放前端设置。主机/凭据这类跟 vault 有关的留在各自的地方（会话树、连接对话框）。
 */
export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useApp()
  if (!settingsOpen) return null
  return <SettingsBody onClose={() => setSettingsOpen(false)} />
}
/** 分段按钮组：选项少、需要一眼看全，比下拉合适 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-hairline p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`h-6 rounded px-2 text-[12px] transition-colors ${
            value === o.value
              ? 'bg-accent/15 text-ink'
              : 'text-ink-subtle hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 数字输入：右侧带单位，失焦/回车时夹到范围里 */
function NumberField({
  value,
  min,
  max,
  step = 1,
  suffix,
  width = 88,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  width?: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  // 外部改了（比如点了恢复默认）要跟上，但不能在输入过程中打断
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(String(value))
  }

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, n))
    setDraft(String(clamped))
    onCommit(clamped)
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        style={{ width }}
        className="h-7 rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink outline-none focus:border-accent"
      />
      {suffix && <span className="text-[11px] text-ink-tertiary">{suffix}</span>}
    </div>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[12px] text-ink-muted">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-ink-tertiary">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">{title}</div>
      <div className="divide-y divide-hairline rounded-md border border-hairline px-3">
        {children}
      </div>
    </div>
  )
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const {
    theme,
    setTheme,
    termFontSize,
    setTermFontSize,
    termFontFamily,
    setTermFontFamily,
    termLineHeight,
    setTermLineHeight,
    termCursorStyle,
    setTermCursorStyle,
    termScrollback,
    setTermScrollback,
    reconnectAttempts,
    setReconnectAttempts,
    reconnectDelaySec,
    setReconnectDelaySec,
    transferResumeDefault,
    setTransferResumeDefault,
    resetSettings,
  } = useApp()

  const [fontDraft, setFontDraft] = useState(termFontFamily)

  return (
    <ModalShell
      onClose={onClose}
      width={560}
      icon={<SettingsIcon size={16} className="mt-0.5 shrink-0 text-ink-subtle" />}
      title="设置"
      subtitle="改完立刻生效，不用保存。"
    >
      <Section title="外观">
        <Row label="主题">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
            ]}
          />
        </Row>
        <Row label="终端字号" hint={`${MIN_FONT_SIZE} – ${MAX_FONT_SIZE} px`}>
          <NumberField
            value={termFontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            suffix="px"
            onCommit={setTermFontSize}
          />
        </Row>
      </Section>

      <Section title="终端">
        <Row
          label="字体族"
          hint={`留空用内置字体栈。改了会立即重排已有终端`}
        >
          <input
            value={fontDraft}
            placeholder="例如 Fira Code, Consolas"
            onChange={(e) => setFontDraft(e.target.value)}
            onBlur={() => setTermFontFamily(fontDraft.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setTermFontFamily(fontDraft.trim())
              }
            }}
            style={{ width: 240 }}
            className="h-7 rounded-md border border-hairline bg-surface-3 px-2 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
        </Row>
        <Row label="行高" hint={`${MIN_LINE_HEIGHT} – ${MAX_LINE_HEIGHT}`}>
          <NumberField
            value={termLineHeight}
            min={MIN_LINE_HEIGHT}
            max={MAX_LINE_HEIGHT}
            step={0.1}
            onCommit={setTermLineHeight}
          />
        </Row>
        <Row label="光标样式">
          <Segmented<CursorStyle>
            value={termCursorStyle}
            onChange={setTermCursorStyle}
            options={[
              { value: 'bar', label: '竖线' },
              { value: 'block', label: '方块' },
              { value: 'underline', label: '下划线' },
            ]}
          />
        </Row>
        <Row
          label="回滚行数"
          hint={`往上能翻多少行历史，${MIN_SCROLLBACK} – ${MAX_SCROLLBACK}`}
        >
          <NumberField
            value={termScrollback}
            min={MIN_SCROLLBACK}
            max={MAX_SCROLLBACK}
            step={1000}
            suffix="行"
            width={100}
            onCommit={setTermScrollback}
          />
        </Row>
      </Section>

      <Section title="连接">
        <Row label="断线自动重连" hint="0 次表示断开就停下，等标签栏的 ↻ 手动重连">
          <NumberField
            value={reconnectAttempts}
            min={MIN_RETRY_ATTEMPTS}
            max={MAX_RETRY_ATTEMPTS}
            suffix="次"
            onCommit={setReconnectAttempts}
          />
        </Row>
        <Row label="重连间隔" hint={`${MIN_RETRY_DELAY} – ${MAX_RETRY_DELAY} 秒`}>
          <NumberField
            value={reconnectDelaySec}
            min={MIN_RETRY_DELAY}
            max={MAX_RETRY_DELAY}
            suffix="秒"
            onCommit={setReconnectDelaySec}
          />
        </Row>
      </Section>

      <Section title="传输">
        <Row
          label="默认开启断点续传"
          hint="新开的 SFTP 面板按这个来；面板上还能临时改"
        >
          <button
            onClick={() => setTransferResumeDefault(!transferResumeDefault)}
            className={`h-6 rounded-md border px-2.5 text-[12px] transition-colors ${
              transferResumeDefault
                ? 'border-accent/40 bg-accent/15 text-ink'
                : 'border-hairline text-ink-subtle hover:text-ink'
            }`}
          >
            {transferResumeDefault ? '开' : '关'}
          </button>
        </Row>
      </Section>

      <div className="mb-4 rounded-md border border-hairline bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-ink-tertiary">
        字体族留空时用内置栈：<span className="font-mono">{DEFAULT_TERM_FONT}</span>
      </div>

      <ModalActions>
        <button
          onClick={resetSettings}
          className={`${modalButton} mr-auto flex items-center gap-1.5`}
          title="主题、字体、连接策略、传输默认值都回到出厂状态"
        >
          <RotateCcw size={12} />
          恢复默认
        </button>
        <button onClick={onClose} className={modalButton}>
          关闭
        </button>
      </ModalActions>
    </ModalShell>
  )
}
