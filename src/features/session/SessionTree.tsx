import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  ListChecks,
  Pencil,
  Plus,
  ScrollText,
  Settings,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { useApp, panesOf, terminalTab } from '@/lib/store'
import type { GroupRecord, HostRecord } from '@/lib/api'
import { hostEndpoint, hostLabel, matchesHost, tagTone } from '@/lib/hosts'
import { copyQuietly } from '@/lib/clipboard'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { connectHost } from './connectHost'

/** 主机行下面那排标签最多摆几个。再多给个 `+N`，完整清单在 tooltip 里 */
const MAX_ROW_TAGS = 4

/** 拖拽判定阈值：手抖点一下不该被当成拖动（PaneGrid / TabBar 同款） */
const DRAG_THRESHOLD = 5

export function SessionTree() {
  const {
    groups,
    hosts,
    collapsed,
    toggleGroup,
    sidebarCollapsed,
    tabs,
    deadPanes,
    setConnectOpen,
    setSnippetsOpen,
    setTunnelOpen,
    setSettingsOpen,
    openLocalFileDialog,
    addTab,
    openBatchTab,
    openNewHostIn,
    removeHost,
    setConfirmPrompt,
    promptNewGroup,
    promptRenameGroup,
  } = useApp()

  /** 关键词：名称 / 地址 / 用户名 / 标签，任一命中就算 */
  const [keyword, setKeyword] = useState('')
  /** 点标签快捷条选中的那个标签，精确匹配。null = 不按标签筛 */
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const filtering = keyword.trim().length > 0 || activeTag !== null

  /**
   * 所有出现过的标签，按大小写不敏感去重（两台机器一个写 `Prod` 一个写 `prod`
   * 时，快捷条上不该出现两个看着一样的按钮）。排序固定，免得每次重渲染都跳位置。
   */
  const allTags = useMemo(() => {
    const seen = new Map<string, string>()
    for (const h of hosts) {
      for (const t of h.tags ?? []) {
        const key = t.toLowerCase()
        if (!seen.has(key)) seen.set(key, t)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [hosts])

  /** 连上之后开一条标签。失败路径（密钥不符 / 算法不兼容）在 connectHost 里统一处理 */
  const connect = useCallback((host: HostRecord, kind: 'terminal' | 'sftp' = 'terminal') => {
    void connectHost(host, (sessionId) => {
      const s = useApp.getState()
      const label = hostLabel(host)
      const title = kind === 'sftp' ? `${label} · 文件` : label
      s.addTab(
        kind === 'sftp'
          ? { title, kind, sessionId, hostId: host.id }
          : terminalTab({ title, sessionId, hostId: host.id }),
      )
    })
  }, [])

  /**
   * 打开这台主机的 SFTP 双栏。
   *
   * 先找有没有已经连上的格子能复用 —— 直接重拨意味着要重新认证一次，
   * 有些服务端还限制单用户连接数，多拨一条会把先前那条顶掉。
   * 断线了（deadPanes）的不算，那条连接已经废了，得重新连。
   * 四宫格下同一台主机可能有好几格，随便挑一条活的都行。
   */
  const openSftp = (host: HostRecord) => {
    const s = useApp.getState()
    const live = s.tabs
      .flatMap(panesOf)
      .find((p) => p.hostId === host.id && p.sessionId && !s.deadPanes[p.id])
    if (live?.sessionId) {
      s.addTab({
        title: `${hostLabel(host)} · 文件`,
        kind: 'sftp',
        sessionId: live.sessionId,
        hostId: host.id,
      })
      return
    }
    connect(host, 'sftp')
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
      title: `删除主机「${hostLabel(host)}」？`,
      message: '只从列表里移除这台主机，已保存的密码/私钥会一起删掉。',
      detail: hostEndpoint(host),
      confirmLabel: '删除主机',
      onConfirm: () => void removeHost(host.id),
    })
  }

  /** 改名字、改标签、改地址都走这一个对话框（它同时是「新建会话」那个） */
  const editHost = (host: HostRecord) => {
    useApp.getState().setEditingHostId(host.id)
    setConnectOpen(true)
  }

  /** 把主机拖到某个分组上 = 移入该分组 */
  const moveToGroup = useCallback((hostId: string, groupId: string | null) => {
    const s = useApp.getState()
    const host = s.hosts.find((h) => h.id === hostId)
    if (!host || host.groupId === groupId) return
    void s.saveHost({ ...host, groupId })
  }, [])

  /**
   * 「拖主机换分组」这一轮拖拽。起点记在 ref 里，视觉状态（源行半透明、
   * 落点高亮、跟手浮签）在 state 里。
   *
   * **不能用 HTML5 拖拽**：`tauri.conf.json` 开着 `dragDropEnabled: true`，
   * wry 装的 IDropTarget 会让内部 HTML5 拖拽在 Windows 上整体失效
   * （PaneGrid 文件头有详细记载）—— 改造前这里就是 `draggable` + `onDragOver/onDrop`，
   * 打包版里拖了没有任何反应。照 PaneGrid / TabBar 的手法用鼠标事件自己实现。
   */
  const dragRef = useRef<{ hostId: string; ox: number; oy: number; active: boolean } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  /** 落点那一块的 `data-group-id`（'' = 未分组）；undefined = 不在任何落点上 */
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)

  const endDrag = useCallback(() => {
    dragRef.current = null
    document.body.style.userSelect = ''
    setDragId(null)
    setDropTarget(undefined)
    setGhost(null)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      // 松手在窗口外面时 webview 收不到 mouseup：靠"当前没按着键"把这一轮收掉，
      // 否则源行会一直是半透明的、高亮也留在那儿
      if (e.buttons === 0) {
        endDrag()
        return
      }
      if (!st.active) {
        if (Math.abs(e.clientX - st.ox) + Math.abs(e.clientY - st.oy) < DRAG_THRESHOLD) return
        st.active = true
        document.body.style.userSelect = 'none'
        setDragId(st.hostId)
      }
      // 落点按"哪一块分组"判：分组块与未分组块都带 data-group-id（'' = 未分组）
      const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-group-id]')
      setDropTarget(zone ? (zone as HTMLElement).dataset.groupId : undefined)
      setGhost({ x: e.clientX, y: e.clientY })
    }
    const onUp = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      const moved = st.active
      const el = e.target as HTMLElement | null
      const zone = el?.closest('[data-group-id]')
      const target = zone ? (zone as HTMLElement).dataset.groupId : undefined
      endDrag()
      if (moved) {
        // 落在空白处 = 取消；落回自己那组时 moveToGroup 自己会 no-op
        if (target === undefined) return
        moveToGroup(st.hostId, target === '' ? null : target)
        return
      }
      /**
       * 没拖动就是点击：标题点了就连。**故意不用 onClick** —— 拖完（哪怕拖回原地
       * 松手）浏览器照样会补一次 click，挂 onClick 的话"拖一下就蹦出个连接"。
       * 这里在 mouseup 里按 `moved` 判，落点还在标题上才算（PaneGrid 同款）。
       */
      if (el?.closest('[data-host-title]')) {
        const host = useApp.getState().hosts.find((h) => h.id === st.hostId)
        if (host) connect(host)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) endDrag()
    }
    // 指针离开窗口 / 窗口失焦：这一轮拖拽作废（松在窗口外的 mouseup 到不了这里）
    const onLeave = () => {
      if (dragRef.current) endDrag()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onLeave)
      document.body.style.userSelect = ''
    }
  }, [endDrag, moveToGroup, connect])

  /** 在主机行上按下：起一轮"换分组"拖拽（位移过阈值才算，见 onMove） */
  const beginDrag = (host: HostRecord) => (e: ReactMouseEvent) => {
    // 只认左键；行里的按钮和标签 chip 自己处理点击，别在它们身上起拖
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('button') || t.closest('[data-tag-chip]')) return
    dragRef.current = { hostId: host.id, ox: e.clientX, oy: e.clientY, active: false }
  }

  const pickTag = (tag: string) => setActiveTag((cur) => (cur === tag ? null : tag))

  const visible = (list: HostRecord[]) => list.filter((h) => matchesHost(h, keyword, activeTag))

  const ungrouped = visible(hosts.filter((h) => !h.groupId))
  const matchedCount = visible(hosts).length

  /**
   * 哪几台主机「连着」：有**某一格**挂着它的 sessionId，且那条连接还没断。
   *
   * 跟 openSftp 挑"能复用的连接"是同一条规则 —— 点亮就等于告诉用户
   * 点「打开 SFTP」不会再拨一次、不会再认证一次。四宫格可以四格四台机器，
   * 所以这里要逐格看，不能只看标签上那一条。
   * 快速连接（没有 hostId）的格子不点亮任何主机；反过来，只剩 SFTP 标签时
   * 断了也没人标 deadPanes（那是终端在管的），那一格要等下次交互才发现已经死了。
   */
  const connectedHosts = new Set<string>()
  for (const p of tabs.flatMap(panesOf)) {
    if (p.hostId && p.sessionId && !deadPanes[p.id]) connectedHosts.add(p.hostId)
  }

  /**
   * 右键菜单：开在哪儿、针对谁。
   *
   * 「复制地址 / 复制名称 / 移入分组」这些动作本来就存在，只是以前要么得先点进对话框、
   * 要么得靠拖动 —— 右键是它们唯一说得清的入口。菜单里的项按 `kind` 分支生成，
   * 两种行的菜单差别很大，合成一个数组只会让每一项都要判类型。
   */
  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: 'host'; host: HostRecord }
    | { x: number; y: number; kind: 'group'; group: GroupRecord }
    | { x: number; y: number; kind: 'ungrouped' }
    | null
  >(null)

  /** 主机行的菜单 */
  const hostMenu = (host: HostRecord): MenuEntry[] => {
    const tags = host.tags ?? []
    return [
      {
        label: '连接（新标签页）',
        testId: 'host-connect',
        icon: <SquareTerminal size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => connect(host),
      },
      {
        label: '打开 SFTP',
        testId: 'host-sftp',
        icon: <FolderOpen size={13} className="shrink-0 text-ink-tertiary" />,
        // 有活着的连接就复用，没有才新建 —— 跟工具栏那个按钮同一条路径
        onSelect: () => openSftp(host),
      },
      {
        label: '批量执行（勾上这台）',
        testId: 'host-batch',
        icon: <ListChecks size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => openBatchTab([host.id]),
      },
      sep(),
      {
        label: '编辑…',
        testId: 'host-edit',
        icon: <Pencil size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => editHost(host),
      },
      {
        label: '移入分组',
        testId: 'host-move-group',
        icon: <FolderInput size={13} className="shrink-0 text-ink-tertiary" />,
        // 一个分组都没有时整项灰掉并说明原因 —— 展开一个只有「未分组」的子菜单
        // 只会让人以为分组功能坏了
        disabled: groups.length === 0,
        hint: groups.length === 0 ? '还没有分组' : undefined,
        children:
          groups.length === 0
            ? []
            : [
                { label: '未分组', checked: !host.groupId, onSelect: () => moveToGroup(host.id, null) },
                ...groups.map((g) => ({
                  label: g.name,
                  checked: host.groupId === g.id,
                  onSelect: () => moveToGroup(host.id, g.id),
                })),
              ],
      },
      sep(),
      {
        label: '复制地址',
        testId: 'host-copy-address',
        hint: hostEndpoint(host),
        // 提示里回显要复制的内容，省得复制完还得找地方粘一下才知道对不对
        onSelect: () => copyQuietly(hostEndpoint(host)),
      },
      {
        label: '复制名称',
        testId: 'host-copy-name',
        // 没起过名就没什么可复制的，灰掉而不是复制一个空串
        disabled: !host.name,
        onSelect: () => copyQuietly(host.name),
      },
      ...(tags.length > 0
        ? [
            {
              label: '复制标签',
              testId: 'host-copy-tags',
              onSelect: () => copyQuietly(tags.join(', ')),
            } satisfies MenuEntry,
          ]
        : []),
      sep(),
      {
        label: '删除主机',
        testId: 'host-delete',
        danger: true,
        icon: <Trash2 size={13} className="shrink-0" />,
        onSelect: () => deleteHost(host),
      },
    ]
  }

  /** 分组行的菜单。未分组那一块没有记录，只给「在这里新建会话」 */
  const groupMenu = (group: GroupRecord | null): MenuEntry[] => [
    {
      label: group ? `在「${group.name}」里新建会话` : '在未分组里新建会话',
      testId: 'group-new-host',
      icon: <Plus size={13} className="shrink-0 text-ink-tertiary" />,
      // 预选分组再开门：不然新建完还得把那台机器拖进来，漏一步就落进未分组
      onSelect: () => openNewHostIn(group?.id ?? null),
    },
    ...(group
      ? [
          {
            label: '重命名分组',
            testId: 'group-rename',
            icon: <Pencil size={13} className="shrink-0 text-ink-tertiary" />,
            onSelect: () => renameGroup(group.id, group.name),
          } satisfies MenuEntry,
          {
            label: '复制分组名',
            testId: 'group-copy-name',
            onSelect: () => copyQuietly(group.name),
          } satisfies MenuEntry,
          sep(),
          {
            label: '删除分组',
            testId: 'group-delete',
            danger: true,
            icon: <Trash2 size={13} className="shrink-0" />,
            onSelect: () => deleteGroup(group.id, group.name),
          } satisfies MenuEntry,
        ]
      : []),
  ]

  const renderHost = (host: HostRecord) => {
    const tags = host.tags ?? []
    const connected = connectedHosts.has(host.id)
    /**
     * 有标签的主机把**地址挪到第二行**。
     *
     * 不为整齐，是被宽度逼的：侧栏 240px，第一行要放下「点 + 名字 + 地址 + 三个按钮」，
     * 实测名字只剩 50px，而 `db-primary` 要 71px —— 直接变成 `db-pri…`（真试过）。
     * 地址跟着标签走之后第一行能空出 57px，长一点的名字也放得下。
     * 没标签的主机维持原样（一行），不为少数情况把整棵树都撑高。
     */
    const addressBelow = tags.length > 0
    return (
      <div
        key={host.id}
        onMouseDown={beginDrag(host)}
        className={`group rounded pl-5 pr-1 text-ink-muted transition-colors hover:bg-surface-2 ${
          dragId === host.id ? 'opacity-50' : ''
        }`}
        // 挂在整行上（含标签那一行）：行里空的地方右键也该出菜单，
        // 否则用户得精确点在名字上，而这一行本来就没多少像素
        onContextMenu={(e) => {
          const at = menuAt(e)
          if (at) setMenu({ ...at, kind: 'host', host })
        }}
      >
        <div className="flex h-7 items-center">
          <div
            // 点击连接由 window mouseup 判定（见 onUp）：拖完浏览器会补一次 click，
            // 挂 onClick 的话拖一下就蹦出个连接框
            data-host-title={host.id}
            title="点击连接，拖动换分组"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
          >
            {/*
              这台主机有没有活着的连接。以前这里写死 bg-ink-tertiary，
              等于一个永远灰的点 —— 有连接和没连接长得一模一样
            */}
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                connected ? 'bg-success' : 'bg-ink-tertiary'
              }`}
            />
            <span className="min-w-0 truncate text-[13px]">{hostLabel(host)}</span>
            {!addressBelow && (
              <span className="ml-auto shrink-0 truncate pl-1 text-[11px] text-ink-tertiary">
                {host.address}
              </span>
            )}
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
            onClick={() => editHost(host)}
            data-host-edit={host.id}
            className="ml-1 shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-3 hover:text-accent"
            title="编辑名称、标签、地址与认证方式"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => deleteHost(host)}
            className="ml-1 shrink-0 rounded p-0.5 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
            title="删除主机"
          >
            <Trash2 size={12} />
          </button>
        </div>

        {/*
          标签行：标签在左、地址在右。chip 可点，一点就把筛选切到这个标签 ——
          它在**可点区外面**，所以不必再拦冒泡。行内最多摆 4 个，多的给个 +N，
          完整清单挂在 +N 上（"这台机器挂了哪些标签"是行里最容易丢的信息）
        */}
        {addressBelow && (
          <div className="flex items-center gap-1 pb-1 pl-3">
            {tags.slice(0, MAX_ROW_TAGS).map((t) => (
              <span
                key={t}
                data-tag-chip={t}
                onClick={() => pickTag(t)}
                title={`只看带「${t}」的主机`}
                className={`shrink-0 cursor-pointer rounded-sm px-1 text-[10px] leading-4 transition-opacity hover:opacity-80 ${
                  activeTag?.toLowerCase() === t.toLowerCase()
                    ? `${tagTone(t)} ring-1 ring-accent`
                    : tagTone(t)
                }`}
              >
                {t}
              </span>
            ))}
            {tags.length > MAX_ROW_TAGS && (
              <span
                className="shrink-0 text-[10px] leading-4 text-ink-tertiary"
                title={`标签：${tags.join('、')}`}
              >
                +{tags.length - MAX_ROW_TAGS}
              </span>
            )}
            <span className="ml-auto shrink-0 truncate pl-1 text-[11px] text-ink-tertiary">
              {host.address}
            </span>
          </div>
        )}
      </div>
    )
  }

  /**
   * 收起时整块不渲染：一块 0 宽的壳留着也没意义，回来有状态栏那个按钮。
   *
   * **必须放在所有 hook 之后**。这条以前在中间（`const [menu, setMenu] = useState(...)`
   * 之前），于是收起侧栏时 hook 少跑一个 —— React 抛
   * 「Rendered fewer hooks than expected」并把整棵树卸载，表现是**整个窗口变黑**
   * （只剩窗口标题栏），而不是"侧栏没了"。收起状态存在 localStorage，所以重启后照样黑。
   */
  if (sidebarCollapsed) return null

  return (
    /*
      外面这层壳带的是"侧栏占地"的那几个类（宽 240 / 满高 / 右边线），
      兜底组件在里面 —— 这样侧栏内部炸了（比如主机数据里有个 null），
      红字只会占住侧栏这块 240px，主区照常能用；壳留在外面则不会把布局挤歪。
      `h-full` 两个都要：aside 现在是壳的子元素，不再是 flex 直接子项，拿不到 stretch。
    */
    <div className="h-full w-60 shrink-0 border-r border-hairline bg-surface-1">
      <ErrorBoundary label="会话侧栏出错了">
        <aside className="flex h-full min-h-0 flex-col">
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
          {/* 收起侧栏的入口在全宽顶栏左上角（App.tsx），这里不再放 —— 收起后就找不着了 */}
        </div>
      </div>

      {/*
        筛选区。主机一多，"找到那台"就比"看到所有"更重要 —— 分组是纵向归属，
        标签是横向特征，两个方向各一个入口：左边点分组、这里按标签 + 关键词搜。
      */}
      <div className="shrink-0 border-b border-hairline px-2 pb-2">
        <div className="relative">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="过滤名称 / 地址 / 用户名 / 标签"
            data-host-filter
            className="h-6 w-full rounded border border-hairline bg-surface-2 pl-2 pr-6 text-[12px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent"
          />
          {keyword && (
            <button
              onClick={() => setKeyword('')}
              className="absolute right-1 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-ink-tertiary hover:bg-surface-3 hover:text-ink"
              title="清空"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {allTags.length > 0 && (
          // 标签多了让它自己滚，别把主机列表顶下去
          <div className="mt-1.5 flex max-h-16 flex-wrap gap-1 overflow-y-auto">
            {allTags.map((t) => (
              <button
                key={t}
                data-tag-filter={t}
                onClick={() => pickTag(t)}
                title={activeTag?.toLowerCase() === t.toLowerCase() ? '取消这个筛选' : `只看带「${t}」的主机`}
                className={`rounded-sm px-1.5 py-0.5 text-[10px] leading-4 transition ${
                  activeTag?.toLowerCase() === t.toLowerCase()
                    ? `${tagTone(t)} ring-1 ring-accent`
                    : `${tagTone(t)} opacity-60 hover:opacity-100`
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {groups.map((group) => {
          const members = visible(hosts.filter((h) => h.groupId === group.id))
          // 筛选中时把空分组收起来：一列「0 个」的分组名只会把结果推走
          if (filtering && members.length === 0) return null
          const isCollapsed = collapsed[group.id]
          return (
            <div key={group.id} className="mb-1" data-group-id={group.id}>
              <div
                className={`group flex h-7 items-center gap-1 rounded px-1 text-ink-subtle transition-colors hover:bg-surface-2 ${
                  dropTarget === group.id ? 'bg-accent/10 ring-1 ring-accent' : ''
                }`}
                onContextMenu={(e) => {
                  const at = menuAt(e)
                  if (at) setMenu({ ...at, kind: 'group', group })
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

        {(ungrouped.length > 0 || !filtering) && (
          <div
            className="mb-1"
            // 未分组这一块没有 id，用空串占位 —— 探针按 data-group-id 数每个组里有几行
            data-group-id=""
          >
            <div
              className={`flex h-7 items-center px-1 text-[12px] font-medium text-ink-subtle ${
                dropTarget === '' ? 'rounded bg-accent/10 ring-1 ring-accent' : ''
              }`}
              onContextMenu={(e) => {
                const at = menuAt(e)
                if (at) setMenu({ ...at, kind: 'ungrouped' })
              }}
            >
              未分组
            </div>
            <div className="mt-0.5">{ungrouped.map(renderHost)}</div>
          </div>
        )}

        {hosts.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-tertiary">
            还没有保存的主机
            <br />
            按 Ctrl+N 新建会话
          </p>
        )}

        {hosts.length > 0 && filtering && matchedCount === 0 && (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-tertiary">
            没有匹配的主机
            <br />
            换关键词，或点掉上面的标签
          </p>
        )}
      </div>

      {/*
        常驻工具区。这几件事以前只能从命令面板或快捷键调出来 ——
        界面上没有任何按钮，等于只有知道的人才会用。
      */}
      <div className="shrink-0 space-y-0.5 border-t border-hairline p-2">
        <button
          onClick={() => addTab(terminalTab({ title: '本地 Shell', kind: 'local' }))}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="在本机开一个终端（Windows 走 PowerShell / ConPTY）"
        >
          <SquareTerminal size={13} className="shrink-0" />
          本地 Shell
        </button>
        <button
          onClick={() => openBatchTab()}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          title="勾几台主机跑同一条命令，把每台的输出收回来"
        >
          <ListChecks size={13} className="shrink-0" />
          批量执行
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

      {/*
        拖拽浮签：跟着光标说清"要把它挪去哪"。fixed + pointer-events-none，
        不参与布局也吃不到 mousemove（落点判的是它下面的元素）
      */}
      {dragId && ghost && (() => {
        const dragged = hosts.find((h) => h.id === dragId)
        return (
        <div
          className="pointer-events-none fixed z-50 rounded border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-ink"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {dropTarget === undefined
            ? dragged
              ? `移动「${hostLabel(dragged)}」`
              : '移动主机'
            : dropTarget === ''
              ? '移到未分组'
              : `移动到「${groups.find((g) => g.id === dropTarget)?.name ?? ''}」`}
        </div>
        )
      })()}

      {/*
        会话树的两套右键菜单。主机行和分组行的动作差别很大（前者管一台机器、
        后者管一个容器），所以按 `kind` 各生成一份，而不是拉一个通用列表再逐项判类型
      */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'host'
              ? hostMenu(menu.host)
              : groupMenu(menu.kind === 'group' ? menu.group : null)
          }
        />
      )}
        </aside>
      </ErrorBoundary>
    </div>
  )
}
