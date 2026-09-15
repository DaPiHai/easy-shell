import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { useApp } from '@/lib/store'

const inputClass =
  'h-9 w-full rounded-md border border-hairline bg-surface-3 px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

export function UnlockScreen() {
  const { phase, vaultError, setupVault, unlockVault } = useApp()
  const isSetup = phase === 'setup'

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const submit = async () => {
    if (!password) {
      setLocalError('请输入主密码')
      return
    }
    if (isSetup && password !== confirm) {
      setLocalError('两次输入不一致')
      return
    }
    if (isSetup && password.length < 6) {
      setLocalError('主密码至少 6 位')
      return
    }

    setBusy(true)
    setLocalError(null)
    try {
      if (isSetup) {
        await setupVault(password)
      } else {
        await unlockVault(password)
      }
    } catch {
      // 错误信息已写入 store
    } finally {
      setBusy(false)
    }
  }

  const error = localError ?? vaultError

  return (
    <div className="grid h-full place-items-center bg-canvas">
      <div className="w-[360px] rounded-xl border border-hairline-tertiary bg-surface-1 p-6">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-hairline bg-surface-2">
            <LockKeyhole size={18} className="text-ink-subtle" />
          </div>
          <h1 className="text-[15px] font-medium text-ink">
            {isSetup ? '设置主密码' : '解锁 easy-shell'}
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">
            {isSetup
              ? '主密码用于加密保存的密码和私钥，不会被存储。忘记只能重置数据。'
              : '输入主密码以读取已保存的会话凭据。'}
          </p>
        </div>

        <div className="mb-3">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="主密码"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </div>

        {isSetup && (
          <div className="mb-4">
            <input
              className={inputClass}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        <button
          onClick={() => void submit()}
          disabled={busy}
          className="h-9 w-full rounded-md bg-accent text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? '处理中…' : isSetup ? '创建并解锁' : '解锁'}
        </button>
      </div>
    </div>
  )
}
