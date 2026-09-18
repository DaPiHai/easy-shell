import { useState } from 'react'
import { KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import { isDesktop, pickFile } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ModalActions, ModalShell, modalButton, modalPrimaryButton } from '@/components/ModalShell'

/**
 * 刚设完主密码就问一句：是否配置恢复密钥？
 *
 * 为什么是**这个时候**问：这是唯一说得上话的时机。用户刚亲手设了密码，也刚意识到
 * 「密码忘了会怎样」；而「忘密码 = 清空重来 = 主机列表全丢」这件事，
 * 等他想起来的时候已经晚了 —— 藏在设置面板里没人会主动去看。
 *
 * 文案取**陈述句 + 不用「你」**：这是安全告知，不是产品推荐。代价、做法、前提
 * 各说各的，不加修辞，也不替用户做决定（三个出口都留着）。
 *
 * 两段实话不能省：① 不配置的代价（忘密码只能清空重来，而那个入口不需要凭据）；
 * ② 它的安全性等同于那把私钥的保管强度 —— 只讲好处就是误导。
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
  /** 配好之后就地在框里给回执（指纹），而不是关掉框去别处飘一句提示 */
  const [done, setDone] = useState<string | null>(null)

  const importKey = async () => {
    setError(null)
    const picked = await pickFile('选择作为恢复密钥的 SSH 公钥', [
      { name: 'SSH 公钥', extensions: ['pub'] },
      { name: '所有文件', extensions: ['*'] },
    ])
    if (!picked) {
      if (!isDesktop()) {
        setError('浏览器预览不提供原生文件选择框，此功能需在桌面版使用。')
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
        title="恢复密钥已配置"
        subtitle="忘记主密码时，可用对应的 SSH 私钥解锁密钥库。"
      >
        <div className="mb-4 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[12px] text-ink-muted">
          公钥指纹 <span className="font-mono">{done}</span>
          <div className="mt-1 text-[11px] leading-relaxed text-ink-tertiary">
            可在锁屏界面通过「用 SSH 私钥解锁」验证该私钥是否可用。
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
      title="配置恢复密钥"
      subtitle="主密码已设置。配置恢复密钥后，忘记主密码时可用对应的 SSH 私钥解锁密钥库。"
    >
      <div className="mb-3 flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
        <span>
          {/* 中文段落用字符串拼接而不是换行缩进：JSX 会把换行折成一个空格，
              句子中间冒出空格在中文里很难看 */}
          <span className="text-ink">未配置恢复密钥的影响：</span>
          {'忘记主密码将无法恢复数据，只能清空密钥库重新初始化，已保存的主机、分组和命令片段都会丢失。' +
            '锁屏上的「清空」入口不需要任何凭据即可执行。'}
        </span>
      </div>

      <div className="mb-3 text-[12px] leading-relaxed text-ink-subtle">
        <div className="mb-1 text-[11px] font-medium tracking-[0.4px] text-ink-subtle">配置方法</div>
        {'选择已有的 SSH 公钥文件（通常为 '}
        <span className="font-mono">C:\Users\&lt;用户名&gt;\.ssh\id_ed25519.pub</span>
        {'），也可先用 '}
        <span className="font-mono">ssh-keygen -t ed25519</span>
        {' 生成一对。'}
        <span className="text-ink-muted">程序只保存公钥，私钥仅在解锁时读取一次。</span>
      </div>

      <div className="mb-3 flex gap-2 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-ink-tertiary">
        <TriangleAlert size={13} className="mt-0.5 shrink-0" />
        <span>
          {'恢复密钥的安全性等同于该私钥的保管强度。私钥未设置口令、且与本程序位于同一用户目录时，等同于未配置 —— 建议先用 '}
          <span className="font-mono">ssh-keygen -p</span>
          {' 为私钥设置口令，或使用不在本机保存的私钥。当前仅支持 ed25519 密钥。'}
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
          title="此后设置主密码时不再提示"
        >
          不再提示
        </button>
        <button onClick={onClose} className={modalButton}>
          暂不配置
        </button>
        <button onClick={() => void importKey()} disabled={busy} className={modalPrimaryButton}>
          {busy ? '读取中…' : '导入公钥…'}
        </button>
      </ModalActions>
    </ModalShell>
  )
}
