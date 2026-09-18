import { useState } from 'react'
import { KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useApp } from '@/lib/store'
import {
  ModalActions,
  ModalShell,
  modalButton,
  modalPrimaryButton,
} from '@/components/ModalShell'

const inputClass =
  'h-9 w-full rounded-md border border-hairline bg-surface-3 px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

/**
 * 改主密码 / 改成不设密码。
 *
 * 两件事共用这一个对话框，因为它们在数据结构上是同一件事：**新密码是空串就是不设密码**
 * （后端 `vault_change_password` 一条路走完，顺便翻掉 `nopass` 标记）。
 * 分成两个功能会让用户以为"取消密码"是什么特殊操作，其实它只是"把密码改成空的"。
 *
 * 为什么必须验当前密码：库多半是几小时前解锁的，而改密码是**破坏性**动作 ——
 * 改错了（比如手滑打错新密码）旧密码就再也解不开。所以后端会当场再验一遍旧密码，
 * 这里也要把这一栏摆出来，不认「反正已经解锁了」。
 *
 * 入口是设置面板和命令面板，都在 ready 分支里 —— 也就是库一定已经解锁。
 */
export function ChangePasswordDialog() {
  const { changePasswordOpen, setChangePasswordOpen } = useApp()
  if (!changePasswordOpen) return null
  return <Body onClose={() => setChangePasswordOpen(false)} />
}

function Body({ onClose }: { onClose: () => void }) {
  const { vaultNoPassword, changeMasterPassword } = useApp()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  /** 「不设主密码」：勾上之后新密码那两栏就锁住，提交的新密码是空串 */
  const [noPass, setNoPass] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async () => {
    if (busy) return
    if (!noPass) {
      if (next.length < 6) {
        setError('新主密码至少 6 位')
        return
      }
      if (next !== confirm) {
        setError('两次输入不一致')
        return
      }
      if (!vaultNoPassword && next === current) {
        setError('新主密码和当前的一样，没有需要改的')
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      // 当前没密码时旧密码就是空串，那栏本来也没显示
      await changeMasterPassword(vaultNoPassword ? '' : current, noPass ? '' : next)
      setDone(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <ModalShell
        onClose={onClose}
        width={420}
        icon={<KeyRound size={16} className="mt-0.5 shrink-0 text-success" />}
        title="主密码已更新"
        subtitle={
          vaultNoPassword
            ? '以后启动直接进主界面，锁定后也只要点一下「解锁」。'
            : '下次解锁请用新密码。已经打开的连接不受影响，不用重连。'
        }
      >
        <p className="mb-4 text-[12px] leading-relaxed text-ink-subtle">
          {vaultNoPassword
            ? '已保存的凭据全都重新存过了 —— 现在这个库不再需要密码。'
            : '已保存的凭据都用新密码重新加密过一遍，旧密码从这一刻起不再有效。'}
        </p>
        <ModalActions>
          <button onClick={onClose} className={modalPrimaryButton}>
            关闭
          </button>
        </ModalActions>
      </ModalShell>
    )
  }

  const canSubmit =
    !busy && (vaultNoPassword || !!current) && (noPass || (!!next && !!confirm))

  return (
    <ModalShell
      onClose={onClose}
      width={420}
      icon={<KeyRound size={16} className="mt-0.5 shrink-0 text-ink-subtle" />}
      title="修改主密码"
      subtitle="保存的凭据会用新密码重新加密。已经打开的连接和标签不受影响。"
    >
      {vaultNoPassword && (
        <div className="mb-3 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-subtle">
          当前没有设置主密码 —— 填一个新密码即可启用。
        </div>
      )}

      {!vaultNoPassword && (
        <div className="mb-3">
          <label className="mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
            当前主密码
          </label>
          <input
            className={inputClass}
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </div>
      )}

      {!noPass && (
        <>
          <div className="mb-3">
            <label className="mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
              新主密码
            </label>
            <input
              className={inputClass}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="至少 6 位"
              autoFocus={vaultNoPassword}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </div>
          <div className="mb-3">
            <label className="mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle">
              再输一遍
            </label>
            <input
              className={inputClass}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
          </div>
        </>
      )}

      {/* 只有已经设了密码时才谈得上「取消密码」 */}
      {!vaultNoPassword && (
        <>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-subtle">
            <input
              type="checkbox"
              checked={noPass}
              onChange={(e) => setNoPass(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            不设主密码
          </label>
          {noPass && (
            <div className="mb-3 mt-2 flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" />
              <span>
                凭据只做了混淆：<span className="font-mono">vault.db</span>{' '}
                里的主机密码不再受任何密码保护，拿到这个文件的人就能读出来。
                只在「本机只有自己用、嫌每次解锁麻烦」时选它。
              </span>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-3 flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4">
        <ModalActions>
          <button onClick={onClose} disabled={busy} className={modalButton}>
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className={modalPrimaryButton}
          >
            {busy ? '重新加密中…' : '修改'}
          </button>
        </ModalActions>
      </div>
    </ModalShell>
  )
}
