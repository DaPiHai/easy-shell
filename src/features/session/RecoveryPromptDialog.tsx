import { useState } from 'react'
import { KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import { isDesktop, pickFile } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ModalActions, ModalShell, modalButton, modalPrimaryButton } from '@/components/ModalShell'

/**
 * 刚设完主密码就问一句：要不要顺手配一把恢复公钥？
 *
 * 为什么是**这个时候**问：这是唯一说得上话的时机。用户刚亲手设了密码，也刚意识到
 * 「密码忘了会怎样」；而「忘密码 = 清空重来 = 主机列表全丢」这件事，
 * 等他想起来的时候已经晚了 —— 藏在设置面板里没人会主动去看。
 *
 * 为什么要把不配的代价写这么直白：这是**如实告知**的一部分。不配恢复密钥时，
 * 锁屏上那个「清空重来」是唯一出路，而它不认人 —— 谁坐在机器前都能点两下把你的库抹掉。
 * 用户有权在一条不显眼的设置项和一段实话之间做选择，而不是在两个都不说清的按钮之间。
 *
 * 也把「它只等于那把私钥的保管强度」一起说了：私钥没口令又摆在同一个用户目录里
 * （这个应用自己最常用的情况）等于没设 —— 只讲好处不讲这个就是误导。
 */
export function RecoveryPromptDialog() {
  const { recoveryPromptOpen, setRecoveryPromptOpen } = useApp()
  if (!recoveryPromptOpen) return null
  return <Body onClose={() => setRecoveryPromptOpen(false)} />
}

function Body({ onClose }: { onClose: () => void }) {
  const { setRecoveryKey, muteRecoveryPrompt } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 配好之后就地给回执（指纹），而不是关掉框去别处飘一句提示 */
  const [done, setDone] = useState<string | null>(null)

  const importKey = async () => {
    setError(null)
    const picked = await pickFile('选择作为恢复密钥的 SSH 公钥', [
      { name: 'SSH 公钥', extensions: ['pub'] },
      { name: '所有文件', extensions: ['*'] },
    ])
    if (!picked) {
      if (!isDesktop()) {
        setError('浏览器预览里没有原生文件框 —— 桌面版里这里会弹出「选择公钥」的对话框')
      }
      return
    }
    setBusy(true)
    try {
      setDone(await setRecoveryKey(picked))
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
        width={460}
        icon={<KeyRound size={16} className="mt-0.5 shrink-0 text-success" />}
        title="恢复密钥配好了"
        subtitle="忘掉主密码时，用对应的私钥就能把库解锁回来 —— 主机和凭据都还在。"
      >
        <div className="mb-4 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[12px] text-ink-muted">
          公钥指纹 <span className="font-mono">{done}</span>
          <div className="mt-1 text-[11px] leading-relaxed text-ink-tertiary">
            真要试一次的话，去锁屏上点「用 SSH 私钥解锁」—— 但现在别把主密码忘了。
          </div>
        </div>
        <ModalActions>
          <button onClick={onClose} className={modalPrimaryButton}>
            关闭
          </button>
        </ModalActions>
      </ModalShell>
    )
  }

  return (
    <ModalShell
      onClose={onClose}
      width={460}
      icon={<KeyRound size={16} className="mt-0.5 shrink-0 text-ink-subtle" />}
      title="给主密码配一把恢复公钥？"
      subtitle="主密码已经设好了。再花一分钟配一把 SSH 公钥，忘掉主密码时还能把库拿回来。"
    >
      <div className="mb-3 flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
        <span>
          <span className="text-ink">不配的代价，说清楚：</span>
          忘掉主密码就只剩「清空密钥库重来」这一条路 —— 已保存的主机、分组、命令片段全部丢掉。
          而那个清空按钮在锁屏上谁都点得到，程序分不出坐在机器前的是不是你。
        </span>
      </div>

      <div className="mb-3 text-[12px] leading-relaxed text-ink-subtle">
        <div className="mb-1 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">怎么弄</div>
        用你已经有的 SSH 密钥就行（没有的话
        <span className="font-mono"> ssh-keygen -t ed25519 </span>
        生成一对）。公钥一般是{' '}
        <span className="font-mono">C:\Users\你\.ssh\id_ed25519.pub</span>；
        <span className="text-ink-muted">私钥自己留着，程序只存公钥，永远不碰私钥。</span>
      </div>

      <div className="mb-3 flex gap-2 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-ink-tertiary">
        <TriangleAlert size={13} className="mt-0.5 shrink-0" />
        <span>
          它的安全性<span className="text-ink-muted">等于那把私钥的保管强度</span>
          ：私钥要是没口令、又摆在这台机器的同一个用户目录里，等于没设。
          那种情况先给私钥加个口令（<span className="font-mono">ssh-keygen -p</span>），
          或者换成不在本机的那把。目前只支持 ed25519 密钥。
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </div>
      )}

      <ModalActions>
        <button
          onClick={muteRecoveryPrompt}
          className={`${modalButton} mr-auto`}
          title="以后设完密码也不再问这个"
        >
          不再提示
        </button>
        <button onClick={onClose} className={modalButton}>
          稍后再说
        </button>
        <button onClick={() => void importKey()} disabled={busy} className={modalPrimaryButton}>
          {busy ? '读取中…' : '导入公钥…'}
        </button>
      </ModalActions>
    </ModalShell>
  )
}
