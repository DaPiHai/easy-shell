import { useState } from 'react'
import { FolderOpen, KeyRound, LockKeyhole } from 'lucide-react'
import { pickFile } from '@/lib/api'
import { useApp } from '@/lib/store'

const inputClass =
  'h-9 w-full rounded-md border border-hairline bg-surface-3 px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

export function UnlockScreen() {
  const {
    phase,
    vaultError,
    setupVault,
    unlockVault,
    unlockWithKey,
    resetVault,
    vaultNoPassword,
    vaultRecoveryFp,
  } = useApp()
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
  /**
   * 走「用 SSH 私钥解锁」那一条路。
   *
   * 展开式而不是另开一页：忘密码的人需要的是**看见两条路**，
   * 而不是点了才知道还有第二种解锁方式。
   */
  const [keyMode, setKeyMode] = useState(false)
  const [keyPath, setKeyPath] = useState('')
  const [keyPass, setKeyPass] = useState('')
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

  /** 用恢复密钥解锁：读一把私钥，把主密钥取回来 */
  const submitKey = async () => {
    if (!keyPath.trim()) {
      setLocalError('请选择恢复用的私钥文件')
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      await unlockWithKey(keyPath.trim(), keyPass || undefined)
    } catch {
      // 错误信息已写入 store
    } finally {
      setBusy(false)
    }
  }

  const browseKey = async () => {
    const picked = await pickFile('选择恢复密钥用的 SSH 私钥')
    if (picked) setKeyPath(picked)
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

        {/*
          恢复密钥这条后路。只有配过的库才出现 —— 没配的库摆一个「用私钥解锁」
          等于给用户一个必然失败的按钮；无密码库也不需要它（那里点一下就进）。
        */}
        {!isSetup && vaultRecoveryFp && !passless && !keyMode && (
          <button
            onClick={() => {
              setKeyMode(true)
              setLocalError(null)
            }}
            className="mt-3 flex w-full items-center justify-center gap-1.5 text-[12px] text-ink-subtle transition-colors hover:text-ink"
          >
            <KeyRound size={12} />
            用 SSH 私钥解锁
          </button>
        )}

        {!isSetup && vaultRecoveryFp && !passless && keyMode && (
          <div className="mt-3 rounded-md border border-hairline bg-surface-2 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-muted">
              <KeyRound size={12} className="shrink-0" />
              用恢复密钥解锁
            </div>
            <p className="mb-2.5 text-[11px] leading-relaxed text-ink-tertiary">
              已配置的公钥指纹为 <span className="font-mono">{vaultRecoveryFp}</span>
              。请选择对应的私钥文件 —— 私钥仅在解锁时读取，不会被保存。
            </p>
            <div className="mb-2 flex gap-1.5">
              <input
                className={inputClass}
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder={'私钥文件，例如 C:\\Users\\<用户名>\\.ssh\\id_ed25519'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitKey()
                }}
              />
              <button
                onClick={() => void browseKey()}
                title="选择私钥文件"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-hairline bg-surface-3 text-ink-subtle transition-colors hover:bg-surface-4 hover:text-ink"
              >
                <FolderOpen size={14} />
              </button>
            </div>
            <input
              className={`${inputClass} mb-2.5`}
              type="password"
              value={keyPass}
              onChange={(e) => setKeyPass(e.target.value)}
              placeholder="私钥口令（没有就留空）"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitKey()
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setKeyMode(false)
                  setLocalError(null)
                }}
                disabled={busy}
                className="h-7 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                取消
              </button>
              <button
                onClick={() => void submitKey()}
                disabled={busy}
                className="h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? '解锁中…' : '用私钥解锁'}
              </button>
            </div>
          </div>
        )}

        {/* 新建密钥库时没什么可重置的，所以只在解锁这一侧给入口 */}
        {!isSetup && (
          <div className="mt-4 border-t border-hairline pt-3">
            {/*
              配了恢复密钥时，这一块整段收起来：有正经后路（那把私钥）之后，
              「清空重来」就只对想搞破坏的人有用了 —— 谁都能删 %APPDATA% 里的 vault.db，
              所以省掉的只是「方便」，但那是「顺手毁掉别人数据」的方便。
              没配恢复密钥时它是唯一出路，只能留着。这里补一句说明，
              否则用户会以为「忘记主密码」这个功能没了。
            */}
            {vaultRecoveryFp ? (
              <p className="text-[11px] leading-relaxed text-ink-tertiary">
                {'已配置恢复密钥。忘记主密码时，可用对应的 SSH 私钥解锁；' +
                  '本密钥库不再提供「清空重来」入口，以免他人在锁屏界面清除数据。'}
              </p>
            ) : resetArmed ? (
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
