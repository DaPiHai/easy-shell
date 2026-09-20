import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { terminalTab, useApp } from '@/lib/store'
import { isDesktop, parseConnectError, pickFile, sshConnect } from '@/lib/api'
import { hostLabel, parseTags, tagTone, tagsToInput } from '@/lib/hosts'

const inputClass =
  'h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

const labelClass = 'mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle'

/**
 * 新建会话 / 编辑主机，同一个表单。
 *
 * 两种用途放一起是刻意的：字段完全一样（名称、标签、地址、端口、用户名、认证），
 * 分成两个对话框迟早会漂移 —— 加一个字段只有一边有，或者校验规则两边不一样。
 * 靠 `editingHostId` 切形态：**编辑时只保存、不连接**，因为用户来这儿是改配置的，
 * 不是要重开一条连接（已经开着的那些连接也不受影响）。
 */
export function ConnectDialog() {
  const { connectOpen, setConnectOpen, addTab, saveHost, setError: showError, setConfirmPrompt } =
    useApp()
  /**
   * 从某一格的「换主机 → 快速连接」进来时非空：连上后会话写进那一格，不开新标签。
   * 读的是 store 里的即时值（不是进对话框时快照），因为确认框重试会绕回来再走一遍这里。
   */
  const connectPaneTarget = useApp((s) => s.connectPaneTarget)
  /** 非 null = 编辑模式 */
  const editingHostId = useApp((s) => s.editingHostId)
  const editing = useApp((s) => (editingHostId ? s.hosts.find((h) => h.id === editingHostId) : null))
  const isEdit = !!editing

  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  /** 用户起的名字，留空 = 没起名（标题回退成 `用户名@地址`） */
  const [name, setName] = useState('')
  /** 标签的原始输入，逗号/空格分隔。存下去的是 `parseTags` 解析后的结果 */
  const [tagInput, setTagInput] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveToVault, setSaveToVault] = useState(true)
  const [compat, setCompat] = useState(false)

  /**
   * 进编辑模式时把那条记录摊进表单。
   *
   * 依赖只写 `editingHostId`，主机表在 effect 里现取 —— 写进依赖的话，
   * 每次 `refreshHosts` 都会把用户正在敲的改动冲掉（保存后刷新正是必然会发生的）。
   * 密码也一起回填：它本来就已经在前端了（`hosts_list` 解密后给的就是明文），
   * 不填只会逼用户在"只想改个名字"的时候重新输一遍密码。
   */
  useEffect(() => {
    const rec = editingHostId
      ? useApp.getState().hosts.find((h) => h.id === editingHostId)
      : null
    if (!rec) return
    setHost(rec.address)
    setPort(String(rec.port))
    setUsername(rec.username)
    setName(rec.name)
    setTagInput(tagsToInput(rec.tags))
    setAuthMode(rec.auth.type)
    if (rec.auth.type === 'password') {
      setPassword(rec.auth.password)
      setPrivateKeyPath('')
      setPassphrase('')
    } else {
      setPrivateKeyPath(rec.auth.privateKeyPath)
      setPassphrase(rec.auth.passphrase ?? '')
      setPassword('')
    }
    setCompat(!!rec.compat)
    setError(null)
  }, [editingHostId])

  if (!connectOpen) return null

  const tags = parseTags(tagInput)

  const close = () => {
    setConnectOpen(false)
    useApp.getState().setEditingHostId(null)
    // 目标格必须跟着对话框一起清：留着它，下次 Ctrl+N 建会话会莫名其妙写进那一格
    useApp.getState().setConnectPaneTarget(null)
    setError(null)
  }

  /** 开原生文件选择框挑私钥。浏览器预览下调不动插件，说清楚而不是静默失败 */
  const pickPrivateKey = async () => {
    if (!isDesktop()) {
      setError('文件选择只在桌面版可用，浏览器预览请手填路径')
      return
    }
    const picked = await pickFile('选择 SSH 私钥')
    if (picked) setPrivateKeyPath(picked)
  }

  /** 两边共用的校验：地址与用户名必填、私钥模式下得有私钥文件 */
  const validate = (): boolean => {
    if (!host.trim() || !username.trim()) {
      setError('主机和用户名必填')
      return false
    }
    if (authMode === 'key' && !privateKeyPath) {
      setError('私钥模式下必须指定私钥文件')
      return false
    }
    return true
  }

  /** 编辑模式：只更新库里的这一条，不碰任何连接 */
  const save = async () => {
    if (!editing || !validate()) return
    setBusy(true)
    setError(null)
    try {
      await saveHost({
        ...editing,
        name: name.trim(),
        address: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        tags,
        auth:
          authMode === 'key'
            ? { type: 'key', privateKeyPath, passphrase: passphrase || null }
            : { type: 'password', password },
        compat,
      })
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** retried：已经"忘掉旧密钥"重试过一次就别再弹窗了，否则会死循环 */
  const submit = async (retried = false, forceCompat = false) => {
    if (!validate()) return
    // 兼容模式重试时把勾选框也点亮，让用户看见"这次确实降级了"
    const useCompat = compat || forceCompat
    if (forceCompat && !compat) setCompat(true)

    setBusy(true)
    setError(null)
    try {
      const sessionId = await sshConnect({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        // 密码优先，所以私钥模式下必须把 password 留空
        password: authMode === 'password' ? password || undefined : undefined,
        privateKeyPath: authMode === 'key' ? privateKeyPath : undefined,
        passphrase: authMode === 'key' ? passphrase || undefined : undefined,
        compat: useCompat,
      })
      // 存进 vault 的才给 hostId：会话树靠它找到这条已建立的连接，
      // 点 SFTP 时直接复用，不必再拨一次
      const hostId = saveToVault ? crypto.randomUUID() : undefined
      // 标题优先用用户起的名字；没起名就是 `用户名@地址`（和以前一样）
      const title = hostLabel({ name: name.trim(), username: username.trim(), address: host.trim() })
      if (connectPaneTarget) {
        // 从格子标题条进来的：会话交给那一格，标签栏不新增东西
        useApp.getState().setPaneConnection(connectPaneTarget.tabId, connectPaneTarget.paneId, {
          sessionId,
          hostId,
          title,
        })
        useApp.getState().setConnectPaneTarget(null)
      } else {
        addTab(terminalTab({ title, sessionId, hostId }))
      }

      if (saveToVault) {
        await saveHost({
          id: hostId as string,
          name: name.trim(),
          address: host.trim(),
          port: Number(port) || 22,
          username: username.trim(),
          groupId: null,
          tags,
          auth:
            authMode === 'key'
              ? { type: 'key', privateKeyPath, passphrase: passphrase || null }
              : { type: 'password', password },
          // 存进去才能让会话树「点一下就带上兼容模式」——否则老设备每次都得手勾
          compat: useCompat,
        })
      }
      close()
    } catch (e) {
      const failure = parseConnectError(e)
      if (failure.kind === 'host_key_mismatch' && !retried) {
        setConfirmPrompt({
          kind: 'host_key_mismatch',
          host: failure.host,
          detail: failure.detail,
          retry: () => void submit(true),
        })
        return
      }
      /**
       * 算法谈不拢时给一条出路，而不是只甩一段红字。
       *
       * compatHint 为 false 说明重试也是白试（对面只要 ssh-dss 主机密钥，
       * 或者卡在 mac / 压缩上 —— 兼容模式不放开这两类），那就别浪费用户一次点击。
       */
      if (failure.kind === 'algorithms_unsupported' && failure.compatHint && !retried) {
        setConfirmPrompt({
          kind: 'algo_compat',
          message: failure.message,
          retry: () => void submit(true, true),
        })
        return
      }
      setError(failure.message)
      showError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="absolute left-1/2 top-[10%] w-[420px] -translate-x-1/2 rounded-xl border border-hairline-tertiary bg-surface-1">
        <div className="flex h-11 items-center justify-between border-b border-hairline px-4">
          <span className="text-[13px] font-medium text-ink">
            {isEdit ? '编辑主机' : connectPaneTarget ? '连接这一格' : '新建会话'}
          </span>
          <button
            onClick={close}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4">
          <div className="mb-3 flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>主机</label>
              <input
                className={inputClass}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                autoFocus
              />
            </div>
            <div className="w-20">
              <label className={labelClass}>端口</label>
              <input
                className={inputClass}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>

          <div className="mb-3">
            <label className={labelClass}>用户名</label>
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
            />
          </div>

          <div className="mb-3 flex gap-1 rounded-md border border-hairline bg-surface-2 p-0.5">
            {(['password', 'key'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setAuthMode(mode)}
                className={`h-6 flex-1 rounded text-[12px] transition-colors ${
                  authMode === mode
                    ? 'bg-surface-4 text-ink'
                    : 'text-ink-subtle hover:text-ink'
                }`}
              >
                {mode === 'password' ? '密码' : '私钥'}
              </button>
            ))}
          </div>

          {authMode === 'password' ? (
            <div className="mb-4">
              <label className={labelClass}>密码</label>
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void (isEdit ? save() : submit())
                }}
                placeholder="登录密码"
              />
            </div>
          ) : (
            <>
              <div className="mb-3">
                <label className={labelClass}>私钥文件</label>
                <div className="flex gap-1.5">
                  <input
                    className={inputClass}
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    placeholder="C:\Users\你\.ssh\id_rsa"
                  />
                  <button
                    type="button"
                    onClick={() => void pickPrivateKey()}
                    className="h-8 shrink-0 rounded-md border border-hairline bg-surface-2 px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
                    title="从文件管理器里选"
                  >
                    浏览…
                  </button>
                </div>
              </div>
              <div className="mb-4">
                <label className={labelClass}>私钥密码（没有就留空）</label>
                <input
                  className={inputClass}
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void (isEdit ? save() : submit())
                  }}
                />
              </div>
            </>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-subtle">
            <input
              type="checkbox"
              checked={compat}
              onChange={(e) => setCompat(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            兼容模式（老设备）
          </label>
          <p className="mb-3 mt-1 text-[11px] leading-relaxed text-ink-tertiary">
            额外接受 dh-group1/14-sha1、aes-cbc 这类已废弃算法。这是安全降级，
            只在确认对面是老交换机、路由器时才勾。
          </p>

          {/*
            名称与标签跟上面那半截不是一回事：上面决定"连到哪儿、怎么认证"，
            这里只决定"这台机器在界面上叫什么"。用一道分隔线说清这条界限，
            省得有人以为改名字会影响连接
          */}
          <div className="mb-3 border-t border-hairline pt-3">
            <label className={labelClass}>名称（可选）</label>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void (isEdit ? save() : submit())
              }}
              placeholder={`${username.trim() || '用户名'}@${host.trim() || '主机'}`}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-tertiary">
              给这台机器起个顺口的名字（「生产 Web 机」比 `10.0.1.11` 好认）。
              留空就用上面那个 `用户名@主机`。
            </p>
          </div>

          <div className="mb-3">
            <label className={labelClass}>标签（可选）</label>
            <input
              className={inputClass}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="prod, 客户A, 机房2"
            />
            {/* 即时把解析结果摊出来：逗号还是空格分隔、有没有被去重、会不会被截断，一眼看见 */}
            {tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {tags.map((t) => (
                  <span
                    key={t}
                    className={`rounded-sm px-1.5 py-0.5 text-[10px] leading-4 ${tagTone(t)}`}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-ink-tertiary">
              逗号或空格分隔。标签是横着切的一类机器（`prod`、某个客户、某个机房），
              跟左边的分组不同 —— 一台机器可以挂好几个标签，侧栏靠它筛选。
            </p>
          </div>

          {!isEdit && (
            <label className="mb-4 flex cursor-pointer items-center gap-2 text-[12px] text-ink-subtle">
              <input
                type="checkbox"
                checked={saveToVault}
                onChange={(e) => setSaveToVault(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              保存到主机列表（密码以主密码加密存储）
            </label>
          )}

          {isEdit && (
            <p className="mb-4 text-[11px] leading-relaxed text-ink-tertiary">
              改完只更新主机列表，不影响已经打开的连接；下次连接（或重连）才用新的。
            </p>
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
              onClick={() => void (isEdit ? save() : submit())}
              disabled={busy}
              className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus disabled:opacity-50"
            >
              {busy ? (isEdit ? '保存中…' : '连接中…') : isEdit ? '保存' : '连接'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
