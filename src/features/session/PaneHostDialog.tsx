import { ArrowLeftRight, FolderTree, Plus } from 'lucide-react'
import { ModalShell } from '@/components/ModalShell'
import { panesOf, useApp } from '@/lib/store'
import type { HostRecord } from '@/lib/api'
import { connectHost } from './connectHost'

/**
 * 「这一格连哪台机器」。
 *
 * 分屏的每一格是**自己一条 SSH 连接**，所以换主机不是"换个显示名"：
 * 新会话连上之后写进那一格，旧通道随终端卸载关闭，旧会话空闲了由后端回收。
 *
 * 入口只有格子标题条上那个 ⇄。列的是 vault 里的主机（按分组），
 * 外加一条「快速连接」——不进 vault 的机器也得能给某一格用。
 */
export function PaneHostDialog() {
  const target = useApp((s) => s.paneHostTarget)
  const hosts = useApp((s) => s.hosts)
  const groups = useApp((s) => s.groups)
  const tabs = useApp((s) => s.tabs)

  if (!target) return null

  const close = () => useApp.getState().setPaneHostTarget(null)

  const tab = tabs.find((t) => t.id === target.tabId)
  const pane = panesOf(tab).find((p) => p.id === target.paneId)
  const paneTitle = pane?.title ?? '这一格'
  /** 这一格现在用的是哪台主机。选中它不做任何事 —— 重连一次同一条连接纯属浪费 */
  const currentHostId = pane?.hostId

  const pick = (host: HostRecord) => {
    close()
    void connectHost(host, (sessionId) => {
      useApp.getState().setPaneConnection(target.tabId, target.paneId, {
        sessionId,
        hostId: host.id,
        // 跟标签标题同一套写法，分屏里一眼能看出哪格是哪台
        title: `${host.username}@${host.address}`,
      })
    })
  }

  const openQuickConnect = () => {
    const s = useApp.getState()
    // 先把选择框收掉再开快速连接：两个 ModalShell 都是 fixed inset-0 z-50，
    // 叠着就是两层遮罩（改密码那条路上踩过同一个坑）
    s.setPaneHostTarget(null)
    s.setConnectPaneTarget(target)
    s.setConnectOpen(true)
  }

  const renderHost = (host: HostRecord) => {
    const current = !!currentHostId && host.id === currentHostId
    return (
      <button
        key={host.id}
        // 已经是这一格在用的主机：点它就是关掉框，别白白重连一次
        onClick={() => (current ? close() : pick(host))}
        title={current ? '这一格现在用的就是这台' : `把这一格连到 ${host.name}`}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-2 hover:text-ink ${
          current ? 'text-ink' : 'text-ink-muted'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            current ? 'bg-success' : 'bg-ink-tertiary'
          }`}
        />
        <span className="min-w-0 flex-1 truncate">
          {host.name}
          <span className="ml-2 text-[11px] text-ink-tertiary">
            {host.username}@{host.address}
          </span>
        </span>
        {/* 四宫格常常四格四台机器，得一眼看出哪一行是这一格正在用的 */}
        {current && (
          <span className="shrink-0 rounded border border-hairline bg-surface-2 px-1 text-[10px] text-ink-subtle">
            当前
          </span>
        )}
      </button>
    )
  }

  return (
    <ModalShell
      icon={<ArrowLeftRight size={15} className="mt-0.5 shrink-0 text-ink-subtle" />}
      title="换一台主机连到这一格"
      subtitle={`「${paneTitle}」当前的连接会被收掉，换上新连的这条。`}
      width={440}
      onClose={close}
    >
      <button
        onClick={openQuickConnect}
        className="mb-3 flex w-full items-center gap-2 rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <Plus size={14} className="shrink-0" />
        快速连接（不存进主机列表）
      </button>

      {hosts.length === 0 ? (
        <p className="px-1 py-4 text-center text-[12px] text-ink-tertiary">
          主机列表是空的 —— 用上面的「快速连接」，或者先在侧栏里存一台主机。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {hosts.length === 1 && (
            // 列表里只有一台时最容易误会成"这功能没用"：那一台多半就是这一格在用的。
            // 说清楚别的机器从哪来，别让人以为只能在这几台里挑
            <p className="px-1 text-[11px] leading-relaxed text-ink-tertiary">
              主机列表里只有这一台。要连别的机器，用上面的「快速连接」填地址，
              或者先在左侧会话树里把那台存下来（存过之后这里就能一键切）。
            </p>
          )}
          {groups.map((group) => {
            const inGroup = hosts.filter((h) => h.groupId === group.id)
            if (inGroup.length === 0) return null
            return (
              <div key={group.id}>
                <div className="mb-1 flex items-center gap-1.5 px-2 text-[11px] text-ink-tertiary">
                  <FolderTree size={11} />
                  {group.name}
                </div>
                {inGroup.map(renderHost)}
              </div>
            )
          })}
          {hosts.some((h) => !h.groupId) && (
            <div>
              {groups.length > 0 && (
                <div className="mb-1 px-2 text-[11px] text-ink-tertiary">未分组</div>
              )}
              {hosts.filter((h) => !h.groupId).map(renderHost)}
            </div>
          )}
        </div>
      )}
    </ModalShell>
  )
}
