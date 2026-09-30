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
import { isDesktop, pickFile } from '@/lib/api'
import { ModalActions, ModalShell, modalButton } from '@/components/ModalShell'
import { NumberField, Row, Section, Segmented } from './controls'
import { FontFamilyPicker } from './FontFamilyPicker'
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
    vaultNoPassword,
    vaultRecoveryFp,
    vaultByRecovery,
    setRecoveryKey,
    clearRecoveryKey,
    setChangePasswordOpen,
    setConfirmPrompt,
    setError,
  } = useApp()

  /**
   * 改主密码要开的是另一个弹窗。这里**先关掉设置面板**再开它 ——
   * 两个 ModalShell 都是 `fixed inset-0 z-50`，叠着就是两层遮罩、两层 Esc，
   * 看起来像界面坏了。跳出去把当前的收掉，是这个项目里更稳的做法。
   */
  const openChangePassword = () => {
    onClose()
    setChangePasswordOpen(true)
  }

  /**
   * 恢复密钥那一行有四种形态：
   * - `import`：还没配 → 「导入公钥…」
   * - `replace`：配过了 → 显示指纹，能换能移除
   * - `remove`：配过但已经无意义（库改成不设密码了，忘密码这件事不存在了）→ 只能移除
   * - `hidden`：用不上（没设主密码）或这轮不许改（用恢复密钥解锁进来的）
   *
   * 「用不上」和「不许改」都**不摆按钮**：给一个点下去必然报错的按钮，
   * 比没有按钮更让人困惑。
   */
  const recoveryAction: 'import' | 'replace' | 'remove' | 'hidden' = vaultByRecovery
    ? 'hidden'
    : vaultRecoveryFp
      ? vaultNoPassword
        ? 'remove'
        : 'replace'
      : vaultNoPassword
        ? 'hidden'
        : 'import'

  const recoveryHint = vaultByRecovery
    ? '本次是用恢复密钥解锁的。更换或移除恢复密钥前，请先用主密码解锁。'
    : vaultNoPassword
      ? vaultRecoveryFp
        ? '密钥库未设置主密码，恢复密钥已无作用，可以移除。'
        : '未设置主密码时无需恢复密钥。请先设置主密码。'
      : vaultRecoveryFp
        ? `忘记主密码时，可用对应的 SSH 私钥解锁。已配置：${vaultRecoveryFp}`
        : '配置一把 SSH 公钥：忘记主密码时可用对应的私钥解锁密钥库，数据不会丢失。' +
          '其安全性等同于该私钥的保管强度 —— 私钥未设置口令、且与本程序位于同一用户目录时，等同于未配置。'

  const importRecovery = async () => {
    const picked = await pickFile('选择作为恢复密钥的 SSH 公钥', [
      { name: 'SSH 公钥', extensions: ['pub'] },
      { name: '所有文件', extensions: ['*'] },
    ])
    if (!picked) {
      // 预览里没有原生文件框。按钮做成禁用的话预览就成了一张不能点的假界面，
      // 所以这里保持可点、点了给一句实话
      if (!isDesktop()) {
        setError('浏览器预览里没有原生文件框 —— 桌面版里这里会弹出「选择公钥」的对话框')
      }
      return
    }
    try {
      const fingerprint = await setRecoveryKey(picked)
      setError(`恢复密钥已设置：${fingerprint}`)
    } catch (e) {
      setError(`设置恢复密钥失败：${String(e)}`)
    }
  }

  const removeRecovery = () => {
    setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: '移除恢复密钥？',
      message:
        '移除后，忘记主密码将无法恢复数据，只能清空密钥库重新初始化，已保存的主机、分组和命令片段都会丢失。' +
        '锁屏上的「忘记主密码」入口也会重新出现。',
      confirmLabel: '仍然移除',
      onConfirm: () => {
        void clearRecoveryKey().catch((e) => setError(`移除恢复密钥失败：${String(e)}`))
      },
    })
  }

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
          hint="点开挑本机已装的字体；要写一整串字体栈就用里面的「自定义…」。改了会立即重排已有终端"
        >
          <FontFamilyPicker />
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

      {/*
        密钥库这一节只有一个「改密码」入口 —— 主密码本身不在这里编辑，
        那边要验当前密码、要重新加密全部凭据，值得一个正经的对话框。
        锁定在状态栏和命令面板上，不再重复放一份。
      */}
      <Section title="密钥库">
        <Row
          label="主密码"
          hint={
            vaultNoPassword
              ? '当前没有设置密码：启动直接进主界面，凭据在 vault.db 里只做混淆'
              : '用于加密已保存的密码和私钥。改密码会用新密码重新加密全部凭据'
          }
        >
          <button onClick={openChangePassword} className={modalButton}>
            {vaultNoPassword ? '设置主密码…' : '修改…'}
          </button>
        </Row>
        <Row label="恢复密钥" hint={recoveryHint}>
          {recoveryAction === 'hidden' ? null : (
            <div className="flex items-center gap-1.5">
              {/* 移除只在配过了之后才有意义 */}
              {(recoveryAction === 'replace' || recoveryAction === 'remove') && (
                <button
                  onClick={removeRecovery}
                  className="h-8 rounded-md border border-danger/40 bg-danger/10 px-3 text-[13px] font-medium text-danger transition-colors hover:bg-danger/20"
                >
                  移除
                </button>
              )}
              {(recoveryAction === 'import' || recoveryAction === 'replace') && (
                <button
                  onClick={() => void importRecovery()}
                  title="选择 SSH 公钥文件（.pub）。预览模式下不提供原生文件选择框"
                  className={modalButton}
                >
                  {recoveryAction === 'replace' ? '更换公钥…' : '导入公钥…'}
                </button>
              )}
            </div>
          )}
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
