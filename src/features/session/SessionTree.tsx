import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { useApp } from '@/lib/store'
import { parseConnectError, sshConnect, type HostRecord } from '@/lib/api'

function hostToConfig(host: HostRecord) {
  return {
    host: host.address,
    port: host.port,
    username: host.username,
    password: host.auth.type === 'password' ? host.auth.password : undefined,
    privateKeyPath: host.auth.type === 'key' ? host.auth.privateKeyPath : undefined,
    passphrase: host.auth.type === 'key' ? (host.auth.passphrase ?? undefined) : undefined,
  }
}

export function SessionTree() {
  const {
    groups,
    hosts,
    collapsed,
    toggleGroup,
    setConnectOpen,
    addTab,
    setError,
    removeHost,
    setConfirmPrompt,
  } = useApp()

  /** retried：已经"忘掉旧密钥"重试过一次就别再弹窗了，否则会死循环 */
  const connect = async (
    host: HostRecord,
    kind: 'terminal' | 'sftp' = 'terminal',
    retried = false,
  ) => {
    try {
      const sessionId = await sshConnect(hostToConfig(host))
      addTab({
        title: kind === 'sftp' ? `${host.name} · 文件` : `${host.username}@${host.address}`,
        kind,
        sessionId,
        hostId: host.id,
      })
    } catch (e) {
      const failure = parseConnectError(e)
      if (failure.kind === 'host_key_mismatch' && !retried) {
        setConfirmPrompt({
          kind: 'host_key_mismatch',
          host: failure.host,
          detail: failure.detail,
          retry: () => void connect(host, kind, true),
        })
        return
      }
      setError(`连接 ${host.name} 失败：${failure.message}`)
    }
  }

  /**
   * 打开这台主机的 SFTP 双栏。
   *
   * 先找有没有已经连上的标签能复用 —— 直接重拨意味着要重新认证一次，
   * 有些服务端还限制单用户连接数，多拨一条会把先前那条顶掉。
   * 断线了（deadTabs）的不算，那条连接已经废了，得重新连。
   */
  const openSftp = (host: HostRecord) => {
    const s = useApp.getState()
    const existing = s.tabs.find((t) => t.hostId === host.id && t.sessionId && !s.deadTabs[t.id])
    if (existing?.sessionId) {
      s.addTab({
        title: `${host.name} · 文件`,
        kind: 'sftp',
        sessionId: existing.sessionId,
        hostId: host.id,
      })
      return
    }
    void connect(host, 'sftp')
  }

  const createGroup = () => {
    const name = window.prompt('新分组名称')
    if (!name?.trim()) return
    void useApp.getState().saveGroup({ id: crypto.randomUUID(), name: name.trim() })
  }

  const renameGroup = (id: string, oldName: string) => {
    const name = window.prompt('重命名分组', oldName)
    if (!name?.trim() || name.trim() === oldName) return
    void useApp.getState().saveGroup({ id, name: name.trim() })
  }

  const deleteGroup = (id: string, name: string) => {
    if (!window.confirm(`删除分组「${name}」？组里的主机会被移到未分组，不会被删掉。`)) return
    void useApp.getState().removeGroup(id)
  }

  /** 把主机拖到某个分组上 = 移入该分组 */
  const moveToGroup = (hostId: string, groupId: string | null) => {
    const host = hosts.find((h) => h.id === hostId)
    if (!host || host.groupId === groupId) return
    void useApp.getState().saveHost({ ...host, groupId })
  }

  const ungrouped = hosts.filter((h) => !h.groupId)

  const renderHost = (host: HostRecord) => (
    <div
      key={host.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-easy-shell-host', host.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className="group flex h-7 items-center rounded pl-5 pr-1 text-ink-muted transition-colors hover:bg-surface-2"
    >
      <div
        onClick={() => void connect(host)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
        title="点击连接"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-tertiary" />
        <span className="truncate text-[13px]">{host.name}</span>
        <span className="ml-auto truncate text-[11px] text-ink-tertiary">{host.address}</span>
      </div>
      {/* 常驻 + 有 hover 反馈：只有 12px 的淡灰图标等于没有入口，用户根本不会去点 */}
      <button
        onClick={() => openSftp(host)}
        className="ml-1 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-3 hover:text-accent"
        title="打开 SFTP 文件管理器（复用已有的连接，不再拨一次）"
      >
        <FolderOpen size={13} />
      </button>
      <button
        onClick={() => void removeHost(host.id)}
        className="ml-1 shrink-0 rounded p-0.5 text-ink-tertiary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
        title="删除主机"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-hairline bg-surface-1">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-[11px] font-medium tracking-[0.4px] text-ink-subtle">会话</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={createGroup}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
            title="新建分组"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => setConnectOpen(true)}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
            title="新建会话"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((group) => {
          const members = hosts.filter((h) => h.groupId === group.id)
          const isCollapsed = collapsed[group.id]
          return (
            <div key={group.id} className="mb-1">
              <div
                className="group flex h-7 items-center gap-1 rounded px-1 text-ink-subtle transition-colors hover:bg-surface-2"
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-easy-shell-host')) {
                    e.preventDefault()
                  }
                }}
                onDrop={(e) => {
                  const hostId = e.dataTransfer.getData('application/x-easy-shell-host')
                  if (hostId) {
                    e.preventDefault()
                    moveToGroup(hostId, group.id)
                  }
                }}
              >
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex min-w-0 flex-1 items-center gap-1 hover:text-ink"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className="truncate text-[12px] font-medium">{group.name}</span>
                  <span className="ml-auto text-[11px] text-ink-tertiary">{members.length}</span>
                </button>
                <button
                  onClick={() => renameGroup(group.id, group.name)}
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                  title="重命名分组"
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => deleteGroup(group.id, group.name)}
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  title="删除分组"
                >
                  <Trash2 size={11} />
                </button>
              </div>
              {!isCollapsed && <div className="mt-0.5">{members.map(renderHost)}</div>}
            </div>
          )
        })}

        <div
          className="mb-1"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-easy-shell-host')) {
              e.preventDefault()
            }
          }}
          onDrop={(e) => {
            const hostId = e.dataTransfer.getData('application/x-easy-shell-host')
            if (hostId) {
              e.preventDefault()
              moveToGroup(hostId, null)
            }
          }}
        >
          <div className="flex h-7 items-center px-1 text-[12px] font-medium text-ink-subtle">
            未分组
          </div>
          <div className="mt-0.5">{ungrouped.map(renderHost)}</div>
        </div>

        {hosts.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-tertiary">
            还没有保存的主机
            <br />
            按 Ctrl+N 新建会话
          </p>
        )}
      </div>

      {/* 本地 Shell 是常用入口，放常驻区而不是只藏在命令面板里 */}
      <div className="shrink-0 border-t border-hairline p-2">
        <button
          onClick={() => addTab({ title: '本地 Shell', kind: 'local' })}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="在本机开一个终端（Windows 走 PowerShell / ConPTY）"
        >
          <SquareTerminal size={13} className="shrink-0" />
          本地 Shell
        </button>
      </div>
    </aside>
  )
}
