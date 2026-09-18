import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  Pencil,
  Plus,
  ScrollText,
  Settings,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { useApp } from '@/lib/store'
import { parseConnectError, sshConnect, type HostRecord } from '@/lib/api'

/**
 * `compatOverride` 供确认框里的「用兼容算法重试」把兼容模式强开一次；
 * 平时走 host.compat —— 那是保存时勾了兼容模式的主机，不带上等于白存。
 */
function hostToConfig(host: HostRecord, compatOverride?: boolean) {
  return {
    host: host.address,
    port: host.port,
    username: host.username,
    password: host.auth.type === 'password' ? host.auth.password : undefined,
    privateKeyPath: host.auth.type === 'key' ? host.auth.privateKeyPath : undefined,
    passphrase: host.auth.type === 'key' ? (host.auth.passphrase ?? undefined) : undefined,
    compat: compatOverride ?? host.compat ?? false,
  }
}

export function SessionTree() {
  const {
    groups,
    hosts,
    collapsed,
    toggleGroup,
    sidebarCollapsed,
    toggleSidebar,
    tabs,
    deadTabs,
    setConnectOpen,
    setSnippetsOpen,
    setTunnelOpen,
    setSettingsOpen,
    openLocalFileDialog,
    addTab,
    setError,
    removeHost,
    setConfirmPrompt,
    promptNewGroup,
    promptRenameGroup,
  } = useApp()

  /** retried：已经"忘掉旧密钥"重试过一次就别再弹窗了，否则会死循环 */
  const connect = async (
    host: HostRecord,
    kind: 'terminal' | 'sftp' = 'terminal',
    retried = false,
    forceCompat = false,
  ) => {
    try {
      const sessionId = await sshConnect(hostToConfig(host, forceCompat))
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
      // 老设备在这里第一次露馅：给「用兼容算法重试」这条路，
      // 而不是让用户自己去翻对话框重新填一遍。compatHint 为 false 时不给，理由同 ConnectDialog
      if (failure.kind === 'algorithms_unsupported' && failure.compatHint && !retried) {
        setConfirmPrompt({
          kind: 'algo_compat',
          message: failure.message,
          retry: () => void connect(host, kind, true, true),
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
    promptNewGroup()
  }

  const renameGroup = (id: string, oldName: string) => {
    promptRenameGroup(id, oldName)
  }

  const deleteGroup = (id: string, name: string) => {
    setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: `删除分组「${name}」？`,
      message: '组里的主机会被移到未分组，主机本身不会被删掉。',
      confirmLabel: '删除分组',
      onConfirm: () => void useApp.getState().removeGroup(id),
    })
  }

  const deleteHost = (host: HostRecord) => {
    setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: `删除主机「${host.name}」？`,
      message: '只从列表里移除这台主机，已保存的密码/私钥会一起删掉。',
      detail: `${host.username}@${host.address}:${host.port}`,
      confirmLabel: '删除主机',
      onConfirm: () => void removeHost(host.id),
    })
  }

  /** 把主机拖到某个分组上 = 移入该分组 */
  const moveToGroup = (hostId: string, groupId: string | null) => {
    const host = hosts.find((h) => h.id === hostId)
    if (!host || host.groupId === groupId) return
    void useApp.getState().saveHost({ ...host, groupId })
  }

  const ungrouped = hosts.filter((h) => !h.groupId)

  // 收起时整块不渲染：一块 0 宽的壳留着也没意义，回来有状态栏那个按钮
  if (sidebarCollapsed) return null

  /**
   * 哪几台主机「连着」：有标签挂着它的 sessionId，且那条连接还没断。
   *
   * 跟 openSftp 挑"能复用的连接"是同一条规则 —— 点亮就等于告诉用户
   * 点「打开 SFTP」不会再拨一次、不会再认证一次。
   * 快速连接（没有 hostId）的标签不点亮任何主机；反过来，只剩 SFTP 标签时
   * 断了也没人标 deadTabs（那是终端在管的），那一格要等下次交互才发现已经死了。
   */
  const connectedHosts = new Set<string>()
  for (const t of tabs) {
    if (t.hostId && t.sessionId && !deadTabs[t.id]) connectedHosts.add(t.hostId)
  }

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
        {/*
          这台主机有没有活着的连接。以前这里写死 bg-ink-tertiary，
          等于一个永远灰的点 —— 有连接和没连接长得一模一样
        */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            connectedHosts.has(host.id) ? 'bg-success' : 'bg-ink-tertiary'
          }`}
          title={connectedHosts.has(host.id) ? '已连接' : '未连接'}
        />
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
        onClick={() => deleteHost(host)}
        className="ml-1 shrink-0 rounded p-0.5 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
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
          {/* 收起侧栏。收起后入口在状态栏，这里只管关 */}
          <button
            onClick={toggleSidebar}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
            title="收起侧栏（Ctrl+Shift+B）"
          >
            <PanelLeftClose size={14} />
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
                  className="shrink-0 rounded p-0.5 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-ink"
                  title="重命名分组"
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => deleteGroup(group.id, group.name)}
                  className="shrink-0 rounded p-0.5 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
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

      {/*
        常驻工具区。这几件事以前只能从命令面板或快捷键调出来 ——
        界面上没有任何按钮，等于只有知道的人才会用。
      */}
      <div className="shrink-0 space-y-0.5 border-t border-hairline p-2">
        <button
          onClick={() => addTab({ title: '本地 Shell', kind: 'local' })}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="在本机开一个终端（Windows 走 PowerShell / ConPTY）"
        >
          <SquareTerminal size={13} className="shrink-0" />
          本地 Shell
        </button>
        <button
          onClick={() => setSnippetsOpen(true)}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="把存好的命令发到当前终端"
        >
          <ScrollText size={13} className="shrink-0" />
          命令片段
        </button>
        <button
          onClick={() => setTunnelOpen(true)}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="本地端口转发（-L）：需要先连上一台主机"
        >
          <ArrowRightLeft size={13} className="shrink-0" />
          端口转发
        </button>
        <button
          onClick={() => void openLocalFileDialog()}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="用内置编辑器打开本机的一个文件"
        >
          <FileCode2 size={13} className="shrink-0" />
          打开本地文件…
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="主题、终端外观、重连策略、传输默认值"
        >
          <Settings size={13} className="shrink-0" />
          设置
        </button>
      </div>
    </aside>
  )
}
