import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { useApp } from '@/lib/store'

const inputClass =
  'h-9 w-full rounded-md border border-hairline bg-surface-3 px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

export function UnlockScreen() {
  const { phase, vaultError, setupVault, unlockVault, resetVault, vaultNoPassword } = useApp()
  const isSetup = phase === 'setup'

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  /**
   * 新建库时选了「不设主密码」。
   *
   * 刻意做成显式勾选而不是「密码框留空就当没有密码」：留空多半是还没想好、
   * 或者手滑，而这两者都会让凭据从此仅剩混淆保护 —— 这种事不能由空白框替用户决定。
   * 库已经建好的不能在这里取消密码（那要走设置里的「修改主密码」）。
   */
  const [noPass, setNoPass] = useState(false)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  /**
   * 「忘记主密码」的两步确认。
   *
   * 没做成 ConfirmDialog 的第三种 kind：那个组件挂在 App 的 ready 分支里，
   * 解锁页根本渲染不到它。两步内联反而更稳 —— 第二次点的是同一位置上的另一个
   * 按钮，不看清就不会误触。
   */
  const [resetArmed, setResetArmed] = useState(false)

  /** 库里本来就没密码的锁屏：连密码框都不该有，点一下就进 */
  const passless = !isSetup && vaultNoPassword
  const askPassword = !passless && !noPass

  const doReset = async () => {
    setBusy(true)
    setLocalError(null)
    try {
      await resetVault()
    } catch (e) {
      setLocalError(String(e))
      setResetArmed(false)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (askPassword) {
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
    }

    setBusy(true)
    setLocalError(null)
    try {
      if (isSetup) {
        await setupVault(askPassword ? password : '')
      } else {
        await unlockVault(passless ? '' : password)
      }
    } catch {
      // 错误信息已写入 store
    } finally {
      setBusy(false)
    }
  }

  const error = localError ?? vaultError

  const subtitle = isSetup
    ? noPass
      ? '不设密码：凭据只做混淆存储，拿到 vault.db 的人就能读出来。适合本机只有自己用的情况。'
      : '主密码用于加密保存的密码和私钥，不会被存储。忘了它就只能清空这些数据重来。'
    : passless
      ? '这个密钥库没有设置主密码，直接进去即可。'
      : '输入主密码以读取已保存的会话凭据。'

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
          <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">{subtitle}</p>
        </div>

        {askPassword && (
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
        )}

        {isSetup && !noPass && (
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

        {isSetup && (
          <label
            className={`${noPass ? 'mb-1' : 'mb-4'} flex cursor-pointer items-center gap-2 text-[12px] text-ink-subtle`}
          >
            <input
              type="checkbox"
              checked={noPass}
              onChange={(e) => {
                setNoPass(e.target.checked)
                setLocalError(null)
              }}
              className="h-3.5 w-3.5 accent-accent"
            />
            不设主密码
          </label>
        )}

        {isSetup && noPass && (
          <p className="mb-4 text-[11px] leading-relaxed text-ink-tertiary">
            密码为空时，库里的凭据只做混淆 —— 它挡不住任何人，只是让主机列表不摆在明面上。
            以后想加密码：设置 → 密钥库 → 设置主密码。
          </p>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        <button
          onClick={() => void submit()}
          disabled={busy}
          className="h-9 w-full rounded-md bg-accent text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus disabled:opacity-50"
        >
          {busy ? '处理中…' : isSetup ? (noPass ? '不设密码并进入' : '创建并解锁') : '解锁'}
        </button>

        {/* 新建密钥库时没什么可重置的，所以只在解锁这一侧给入口 */}
        {!isSetup && (
          <div className="mt-4 border-t border-hairline pt-3">
            {resetArmed ? (
              <div className="text-[12px] leading-relaxed">
                <p className="text-danger">
                  确认清空？已保存的主机、分组、命令片段都会删掉，密钥库要重新初始化。
                  这一步无法撤销。
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => setResetArmed(false)}
                    disabled={busy}
                    className="h-7 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void doReset()}
                    disabled={busy}
                    className="h-7 rounded-md border border-danger/40 bg-danger/10 px-2.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                  >
                    {busy ? '清空中…' : '清空并重新设置'}
                  </button>
                </div>
              </div>
            ) : (
              // 没有密码的库没什么可忘记的，这里的入口就只剩「清空数据」这一个含义
              <button
                onClick={() => setResetArmed(true)}
                className="mx-auto block text-[12px] text-ink-tertiary transition-colors hover:text-ink-muted"
              >
                {vaultNoPassword ? '清空密钥库' : '忘记主密码？'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
