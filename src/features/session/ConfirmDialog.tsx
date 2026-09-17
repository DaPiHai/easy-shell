import { useEffect, useRef, useState } from 'react'
import { Loader2, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useApp } from '@/lib/store'
import { knownHostsForget } from '@/lib/api'
import {
  ModalActions,
  ModalShell,
  modalButton,
  modalDangerButton,
  modalPrimaryButton,
} from '@/components/ModalShell'

/**
 * 需要用户拍板的事，全在这一个弹窗里。
 *
 * 安全类：
 * - `host_key_mismatch`：后端是 TOFU，第一次连自动记住，之后密钥对不上直接拒绝。
 *   但"拒绝"不能是死路 —— 服务器重装、换 SSH 密钥都是正常运维操作，
 *   所以给"忘掉旧记录并重连"这条路，同时把风险说清楚，别让人无脑点确认。
 * - `algo_compat`：对面是老设备，要连上就得放开已废弃的算法（dh-group1/14-sha1、
 *   aes-cbc）。这是实打实的安全降级，必须让用户知道并主动点头。
 *
 * 通用类：
 * - `confirm`：删除这类不可撤销的动作，先问一句。
 * - `unsaved`：编辑器有没保存的改动，关标签前给"保存 / 不保存 / 取消"。
 * - `input`：取一个名字（新建目录、重命名、分组名）。
 *
 * 为什么不用 `window.confirm` / `window.prompt`：打包版里 confirm 压根不渲染，
 * 直接当"确认"返回 —— 删除操作就这么静默执行了；prompt 弹的是 WebView2 原生框，
 * 标题写着 tauri.localhost，跟整套视觉完全不是一回事。
 */
export function ConfirmDialog() {
  const { confirmPrompt, setConfirmPrompt } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 换一种 prompt 时把上一次的忙/错状态清掉，否则上一条的错误会跟过来
  const kind = confirmPrompt?.kind
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [kind])

  if (!confirmPrompt) return null

  const close = () => setConfirmPrompt(null)

  /** 忘掉旧密钥再重连。只有 host_key_mismatch 走这条路 */
  const forgetAndRetry = async (host: string, retry: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await knownHostsForget(host)
    } catch (e) {
      setError(`忘掉旧记录失败：${String(e)}`)
      setBusy(false)
      return
    }
    // 先关弹窗再重连：重连失败的错误要能正常冒到调用方那里
    setConfirmPrompt(null)
    setBusy(false)
    retry()
  }

  if (confirmPrompt.kind === 'algo_compat') {
    const { message, retry } = confirmPrompt
    return (
      <ModalShell
        onClose={close}
        icon={<TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />}
        title="算法协商失败"
        subtitle="这台设备和我们支持的算法谈不拢，通常是比较老的交换机或路由器。"
      >
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
            详情
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline bg-surface-3 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
            {message}
          </pre>
        </div>

        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
          重试会放开 <span className="font-mono">dh-group1-sha1</span>、
          <span className="font-mono">dh-group14-sha1</span> 与
          <span className="font-mono">aes-cbc</span> 等已废弃算法。
          这些算法有已知弱点，只在确认对面确实是老设备时才用。
        </div>

        <ModalActions>
          <button onClick={close} className={modalButton}>
            取消
          </button>
          <button
            onClick={() => {
              setConfirmPrompt(null)
              retry()
            }}
            className={modalPrimaryButton}
          >
            用兼容算法重试
          </button>
        </ModalActions>
      </ModalShell>
    )
  }

  if (confirmPrompt.kind === 'confirm') {
    const { title, message, detail, confirmLabel, danger, onConfirm } = confirmPrompt
    return (
      <ModalShell
        onClose={close}
        icon={
          danger ? (
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
          )
        }
        title={title}
        subtitle={message}
      >
        {detail && (
          <div className="mb-4">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline bg-surface-3 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
              {detail}
            </pre>
          </div>
        )}
        <ModalActions>
          <button onClick={close} className={modalButton}>
            取消
          </button>
          <button
            onClick={() => {
              setConfirmPrompt(null)
              onConfirm()
            }}
            className={danger ? modalDangerButton : modalPrimaryButton}
          >
            {confirmLabel}
          </button>
        </ModalActions>
      </ModalShell>
    )
  }

  if (confirmPrompt.kind === 'unsaved') {
    const { name, onSave, close: closeTab } = confirmPrompt
    const saveAndClose = async () => {
      setBusy(true)
      setError(null)
      const failure = await onSave()
      setBusy(false)
      if (failure) {
        // 保存失败就留在弹窗里：关掉标签等于把改动丢了，
        // 而这正是用户点「保存并关闭」想避免的事
        setError(failure)
        return
      }
      setConfirmPrompt(null)
      closeTab()
    }
    return (
      <ModalShell
        onClose={close}
        icon={<TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />}
        title="有未保存的修改"
        subtitle={`「${name}」的改动还没保存，直接关闭就找不回来了。`}
      >
        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
            保存失败：{error}
          </div>
        )}
        <ModalActions>
          <button onClick={close} disabled={busy} className={modalButton}>
            取消
          </button>
          <button
            onClick={() => {
              setConfirmPrompt(null)
              closeTab()
            }}
            disabled={busy}
            className={modalDangerButton}
          >
            不保存关闭
          </button>
          <button onClick={() => void saveAndClose()} disabled={busy} className={modalPrimaryButton}>
            {busy ? '保存中…' : '保存并关闭'}
          </button>
        </ModalActions>
      </ModalShell>
    )
  }

  if (confirmPrompt.kind === 'input') {
    return <InputPrompt onClose={close} />
  }

  const { host, detail, retry } = confirmPrompt
  return (
    <ModalShell
      onClose={close}
      icon={<ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />}
      title="主机密钥已变更"
      subtitle="这台主机现在的密钥和之前记住的对不上。可能是服务器重装或换过 SSH 密钥，也可能是有人在做中间人攻击 —— 确认前最好跟服务器管理员核实一下。"
    >
      <div className="mb-3">
        <div className="mb-1.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">主机</div>
        <div className="rounded-md border border-hairline bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-ink">
          {host}
        </div>
      </div>

      {detail && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">差异</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline bg-surface-3 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
            {detail}
          </pre>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </div>
      )}

      <ModalActions>
        <button onClick={close} className={modalButton}>
          取消
        </button>
        <button
          onClick={() => void forgetAndRetry(host, retry)}
          disabled={busy}
          className={modalDangerButton}
        >
          {busy ? '处理中…' : '忘掉旧密钥并重连'}
        </button>
      </ModalActions>
    </ModalShell>
  )
}

/** 取一个值再继续（新建目录、重命名、分组名）。空值不许提交 */
function InputPrompt({ onClose }: { onClose: () => void }) {
  const { confirmPrompt, setConfirmPrompt } = useApp()
  const prompt = confirmPrompt?.kind === 'input' ? confirmPrompt : null
  const [value, setValue] = useState(prompt?.defaultValue ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 默认值进来时全选：改名场景下用户多半是整段换掉
    inputRef.current?.select()
  }, [])

  if (!prompt) return null

  const submit = async () => {
    const v = value.trim()
    if (!v || busy) return
    setBusy(true)
    setError(null)
    try {
      await prompt.onConfirm(v)
    } catch (e) {
      setError(String(e))
      setBusy(false)
      return
    }
    setBusy(false)
    setConfirmPrompt(null)
  }

  return (
    <ModalShell onClose={onClose} title={prompt.title} width={420}>
      <label className="mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
        {prompt.label}
      </label>
      <input
        ref={inputRef}
        autoFocus
        value={value}
        placeholder={prompt.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        className="h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
      />

      {error && (
        <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="mt-4">
        <ModalActions>
          <button onClick={onClose} disabled={busy} className={modalButton}>
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className={modalPrimaryButton}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : prompt.confirmLabel}
          </button>
        </ModalActions>
      </div>
    </ModalShell>
  )
}
