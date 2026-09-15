import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useApp } from '@/lib/store'
import { knownHostsForget } from '@/lib/api'

/**
 * 主机密钥变更确认。
 *
 * 后端是 TOFU：第一次连自动记住，之后密钥对不上就直接拒绝。
 * 但"拒绝"不能是死路 —— 服务器重装、换 SSH 密钥都是正常运维操作，
 * 这里给出"忘掉旧记录并重连"这条路，同时把风险说清楚，别让人无脑点确认。
 */
export function HostKeyDialog() {
  const { hostKeyPrompt, setHostKeyPrompt } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!hostKeyPrompt) return null
  const { host, detail, retry } = hostKeyPrompt

  const close = () => setHostKeyPrompt(null)

  const confirm = async () => {
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
    setHostKeyPrompt(null)
    setBusy(false)
    retry()
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="absolute left-1/2 top-[16%] w-[480px] -translate-x-1/2 rounded-xl border border-hairline-tertiary bg-surface-1">
        <div className="flex items-start gap-2.5 border-b border-hairline px-4 py-3">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">主机密钥已变更</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">
              这台主机现在的密钥和之前记住的对不上。可能是服务器重装或换过 SSH
              密钥，也可能是有人在做中间人攻击 —— 确认前最好跟服务器管理员核实一下。
            </div>
          </div>
        </div>

        <div className="p-4">
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
              主机
            </div>
            <div className="rounded-md border border-hairline bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-ink">
              {host}
            </div>
          </div>

          {detail && (
            <div className="mb-4">
              <div className="mb-1.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
                差异
              </div>
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

          <div className="flex justify-end gap-2">
            <button
              onClick={close}
              className="h-8 rounded-md border border-hairline bg-surface-2 px-3 text-[13px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              取消
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy}
              className="h-8 rounded-md border border-danger/40 bg-danger/10 px-3 text-[13px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
            >
              {busy ? '处理中…' : '忘掉旧密钥并重连'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
