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
import { NumberField, Row, Section, Segmented } from './controls'
import { TermSchemeSection } from './TermSchemeSection'

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

      <Section title="终端配色">
        <TermSchemeSection />
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
          title="主题、配色、字体、连接策略、传输默认值都回到出厂状态（自己加的配色方案会留着）"
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
