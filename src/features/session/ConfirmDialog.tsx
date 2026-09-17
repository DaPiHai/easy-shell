import { useState } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { useApp } from '@/lib/store'
import { knownHostsForget } from '@/lib/api'

/**
 * 连接失败时要用户拍板的两种情形，共用一个弹窗。
 *
 * 共同点：都不该由程序替用户决定，且都需要"改点什么再重试一次"这个动作。
 *
 * - `host_key_mismatch`：后端是 TOFU，第一次连自动记住，之后密钥对不上直接拒绝。
 *   但"拒绝"不能是死路 —— 服务器重装、换 SSH 密钥都是正常运维操作，
 *   所以给"忘掉旧记录并重连"这条路，同时把风险说清楚，别让人无脑点确认。
 *
 * - `algo_compat`：对面是老设备，要连上就得放开已废弃的算法（dh-group1/14-sha1、
 *   aes-cbc）。这是实打实的安全降级，必须让用户知道并主动点头。
 */
export function ConfirmDialog() {
  const { confirmPrompt, setConfirmPrompt } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/60" onClick={close} />
        <div className="absolute left-1/2 top-[16%] w-[480px] -translate-x-1/2 rounded-xl border border-hairline-tertiary bg-surface-1">
          <div className="flex items-start gap-2.5 border-b border-hairline px-4 py-3">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">算法协商失败</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">
                这台设备和我们支持的算法谈不拢，通常是比较老的交换机或路由器。
              </div>
            </div>
          </div>

          <div className="p-4">
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

            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                className="h-8 rounded-md border border-hairline bg-surface-2 px-3 text-[13px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setConfirmPrompt(null)
                  retry()
                }}
                className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                用兼容算法重试
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { host, detail, retry } = confirmPrompt
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
              onClick={() => void forgetAndRetry(host, retry)}
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
