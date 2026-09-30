/**
 * 「这一栏文件浏览器连着哪儿」= 绑定（PaneBinding）+ 一栏的状态与操作。
 *
 * SftpPanel（双栏对拷）和右侧文件栏（单栏）共用这套：两边除了摆法不同，
 * 列目录 / 新建 / 重命名 / 删除 / 编辑 / 在终端里打开完全一样。
 *
 * 远程栏的 SFTP 通道生命周期全在 `useSftpBinding` 里，一条铁律：
 * **开了一定要还**（后端按引用计数，不还就永久占服务端一个 session 槽位），
 * 异步 open 回来时绑定已经换了/组件已经没了的分支要立刻 close。
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  localCreateFile,
  localHome,
  localList,
  localMkdir,
  localRemove,
  localRename,
  sftpClose,
  sftpCreateFile,
  sftpList,
  sftpMkdir,
  sftpOpen,
  sftpPwd,
  sftpRemove,
  sftpRename,
  type FileEntry,
  type HostRecord,
} from '@/lib/api'
import { liveLocalPane, livePaneOfSession, panesOf, terminalTab, useApp } from '@/lib/store'
import { hostLabel } from '@/lib/hosts'
import type { MenuEntry } from '@/components/ContextMenu'
import { connectHost } from '@/features/session/connectHost'

/** 一栏文件浏览器绑定到哪：本机，或某条已建立的 SSH 会话 */
export type PaneBinding =
  | { kind: 'local' }
  | { kind: 'remote'; sessionId: string; hostId?: string; label: string }

/** 远程绑定（换绑菜单里列的就是这些） */
export type RemoteBinding = Extract<PaneBinding, { kind: 'remote' }>

/** 绑定的稳定标识：换没换绑定只看它 */
function bindingKey(binding: PaneBinding): string {
  return binding.kind === 'local' ? 'local' : binding.sessionId
}

/**
 * 已经连着的会话清单（去重），给「换绑定」菜单用。
 *
 * 终端格子、SFTP 标签自己那条会话都算 —— 只看格子的话，
 * 「只有一个 SFTP 标签」时菜单里会是空的。
 */
export function liveRemoteBindings(): RemoteBinding[] {
  const s = useApp.getState()
  const seen = new Map<string, RemoteBinding>()
  for (const tab of s.tabs) {
    for (const pane of panesOf(tab)) {
      if (pane.sessionId && !s.deadPanes[pane.id] && !seen.has(pane.sessionId)) {
        seen.set(pane.sessionId, {
          kind: 'remote',
          sessionId: pane.sessionId,
          hostId: pane.hostId,
          label: pane.title,
        })
      }
    }
    if (tab.sessionId && !seen.has(tab.sessionId)) {
      seen.set(tab.sessionId, {
        kind: 'remote',
        sessionId: tab.sessionId,
        hostId: tab.hostId,
        label: tab.title,
      })
    }
  }
  return [...seen.values()]
}

/** 某条会话对应的绑定（带主机名标签），拿不到格子信息时给个兜底名字 */
export function bindingForSession(sessionId: string): PaneBinding {
  const s = useApp.getState()
  for (const tab of s.tabs) {
    for (const pane of panesOf(tab)) {
      if (pane.sessionId === sessionId && pane.hostId) {
        return { kind: 'remote', sessionId, hostId: pane.hostId, label: pane.title }
      }
    }
    if (tab.sessionId === sessionId && tab.hostId) {
      return { kind: 'remote', sessionId, hostId: tab.hostId, label: tab.title }
    }
  }
  return { kind: 'remote', sessionId, label: '远程' }
}

/** 从保存的主机里找标签名（换绑菜单里对上「这台连的是哪台主机」） */
export function hostOfBinding(binding: PaneBinding): HostRecord | undefined {
  if (binding.kind !== 'remote' || !binding.hostId) return undefined
  return useApp.getState().hosts.find((h) => h.id === binding.hostId)
}

/**
 * 「换绑定」菜单：本机 / 已连接的会话 / 连接一台保存的主机。
 *
 * 保存的主机那项点了会**先连再绑**（connectHost 统一处理密钥不符、算法降级
 * 这些失败路径），所以是异步的 —— 菜单关掉之后才可能弹确认框，这是有意的。
 */
export function bindingMenuItems(
  current: PaneBinding,
  onPick: (b: PaneBinding) => void,
): MenuEntry[] {
  const s = useApp.getState()
  const live = liveRemoteBindings()
  return [
    {
      label: '本机',
      testId: 'bind-local',
      checked: current.kind === 'local',
      onSelect: () => onPick({ kind: 'local' }),
    },
    {
      label: '已连接的会话',
      testId: 'bind-live',
      disabled: live.length === 0,
      hint: live.length === 0 ? '还没有已连接的会话' : undefined,
      children: live.map((b) => ({
        label: b.label,
        checked: current.kind === 'remote' && current.sessionId === b.sessionId,
        onSelect: () => onPick(b),
      })),
    },
    {
      label: '连接主机',
      testId: 'bind-connect',
      disabled: s.hosts.length === 0,
      hint: s.hosts.length === 0 ? '还没有保存的主机' : undefined,
      children: s.hosts.map((h) => ({
        label: hostLabel(h),
        onSelect: () => {
          void connectHost(h, (sessionId) => {
            onPick({ kind: 'remote', sessionId, hostId: h.id, label: hostLabel(h) })
          })
        },
      })),
    },
  ]
}

/**
 * 远程绑定的 SFTP 通道。本地绑定恒返回 null。
 *
 * 换绑定的**当帧**就把旧通道 id 作废（渲染期派生状态）：异步开新通道那段时间里
 * 拿旧 id 去列目录会读到上一台机器的 pwd。
 */
export function useSftpBinding(binding: PaneBinding): number | null {
  const key = bindingKey(binding)
  const [state, setState] = useState<{ key: string; id: number | null }>({ key, id: null })
  if (state.key !== key) setState({ key, id: null })

  useEffect(() => {
    if (binding.kind !== 'remote') return
    const sessionId = binding.sessionId
    let alive = true
    /**
     * 卸载/换绑时要关掉谁。必须记在局部变量里，不能依赖 state：
     * 打开是异步的，组件可能在 sftpOpen 返回之前就换了绑定，那时 state 还是 null。
     */
    let opened: number | null = null

    void (async () => {
      try {
        const id = await sftpOpen(sessionId)
        if (!alive) {
          // 打开完成时绑定已经换了/组件已经没了 —— 立刻还回去，否则这条通道永远没人关
          void sftpClose(id)
          return
        }
        opened = id
        setState({ key, id })
      } catch (e) {
        if (alive) useApp.getState().setError(`打开 SFTP 失败：${String(e)}`)
      }
    })()

    return () => {
      alive = false
      if (opened != null) void sftpClose(opened)
    }
  }, [key])

  return state.key === key ? state.id : null
}

/** 一栏文件浏览器：目录、列表、选择、以及这一栏上的全部文件操作 */
export interface FileBrowser {
  binding: PaneBinding
  /** 远程绑定的通道 id（本地绑定恒 null） */
  sftpId: number | null
  /** 远程通道还没开好时是 false，操作按钮该灰着 */
  ready: boolean
  /** 当前目录。空串 = 还没拿到初始目录 */
  path: string
  entries: FileEntry[]
  loading: boolean
  selected: string[]
  setSelected: (paths: string[]) => void
  navigate: (path: string) => void
  refresh: () => Promise<void>
  mkdir: () => void
  /** 新建空文件（同名已存在后端报错、绝不覆盖） */
  createFile: () => void
  remove: () => void
  rename: () => void
  /**
   * 在内置编辑器里打开。不传路径就取选中的第一个 ——
   * 双击行这种场合必须显式传：双击那一下的闭包里"选中集合"还是旧的
   */
  openEditor: (path?: string) => void
}

/** 远端路径拼接，分隔符固定 /（远端是 OpenSSH on Windows 也认 /） */
export function remoteJoin(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** 本地路径拼接，按现有路径的风格选分隔符 */
export function localJoin(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * 把路径包成 shell 里的**字面量**。
 *
 * 不用双引号是被真实路径教育过的：Windows 的 `C:\$Recycle.Bin` 在 PowerShell 的
 * 双引号里会把 `$Recycle` 当变量吃掉，POSIX 那边 `$`、反引号同理。
 * 单引号在两个世界里都是字面量，只有"路径本身带单引号"时的转义规则不同：
 * PowerShell 连着写两个，POSIX 是 `'\''`。
 */
export function quotePath(dir: string, isLocal: boolean): string {
  if (isLocal && navigator.userAgent.includes('Windows')) {
    return `'${dir.replace(/'/g, "''")}'`
  }
  return `'${dir.replace(/'/g, "'\\''")}'`
}

/**
 * 在终端里切到某个目录。
 *
 * 远端必须**已经有一条活着的终端**才做 —— 建连要认证（还可能撞上主机密钥确认），
 * 不能在右键后面偷偷替你拨一次。本地 Shell 没有认证这回事，没有就顺手开一个，
 * cd 命令排队等到通道就绪再发（见 store 的 `queuePaneInput`）。
 */
export function openInTerminalFor(binding: PaneBinding, dir: string) {
  const s = useApp.getState()
  const isLocal = binding.kind === 'local'
  const command = `cd ${quotePath(dir, isLocal)}\n`
  if (binding.kind === 'remote') {
    const pane = livePaneOfSession(binding.sessionId)
    if (!pane) {
      s.setError('这台主机没有开着的终端 —— 先连上它（或在它上面开个标签）再试')
      return
    }
    s.terminalSinks[pane.id]?.(command)
    return
  }
  const live = liveLocalPane()
  if (live) {
    s.terminalSinks[live.id]?.(command)
    return
  }
  // 新开一个本地 Shell。`terminalTab` 生成的 pane id 之后不会再变（addTab 只补 tab.id），
  // 所以可以现在就把它排进队列
  const spec = terminalTab({ title: '本地 Shell', kind: 'local' })
  s.addTab(spec)
  const paneId = spec.panes?.[0]?.id
  if (paneId) s.queuePaneInput(paneId, command)
}

/** 单栏文件浏览器的状态机。所有文件操作自带输入/确认弹窗，UI 层只管摆按钮 */
export function useFileBrowser(binding: PaneBinding): FileBrowser {
  const sftpId = useSftpBinding(binding)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const key = bindingKey(binding)

  // 换绑定就重来：目录、列表、选择都属于上一条绑定
  useEffect(() => {
    setPath('')
    setEntries([])
    setSelected([])
  }, [key])

  // 拿初始目录：本地 = 家目录；远程 = sftp 通道的 pwd
  useEffect(() => {
    if (path) return
    if (binding.kind === 'local') {
      void localHome()
        .then((p) => setPath(p))
        .catch(() => setPath('C:\\'))
    } else if (sftpId != null) {
      void sftpPwd(sftpId)
        .then((p) => setPath(p))
        .catch(() => setPath('/'))
    }
    // binding.kind 与 key 一起变；sftpId 为 null 时（换绑中）这里就是干等
  }, [path, sftpId, key])

  const refresh = async () => {
    if (!path) return
    setLoading(true)
    try {
      const list =
        binding.kind === 'local'
          ? await localList(path)
          : sftpId != null
            ? await sftpList(sftpId, path)
            : []
      setEntries(list)
    } catch (e) {
      useApp.getState().setError(`读取目录失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (path) void refresh()
  }, [path, sftpId])

  const navigate = (next: string) => {
    setSelected([])
    setPath(next)
  }

  /** 输入一个名字（新建文件/目录、重命名共用）：空名与带分隔符的名字当场挡掉 */
  const promptName = (opts: {
    title: string
    label: string
    defaultValue?: string
    confirmLabel: string
    onConfirm: (name: string) => Promise<void> | void
  }) => {
    useApp.getState().setConfirmPrompt({
      kind: 'input',
      title: opts.title,
      label: opts.label,
      defaultValue: opts.defaultValue,
      confirmLabel: opts.confirmLabel,
      onConfirm: async (value) => {
        const name = value.trim()
        if (!name) return
        if (name.includes('/') || name.includes('\\')) {
          useApp.getState().setError('名称里不能带路径分隔符')
          return
        }
        try {
          await opts.onConfirm(name)
        } catch (e) {
          useApp.getState().setError(String(e))
        }
      },
    })
  }

  const mkdir = () => {
    promptName({
      title: binding.kind === 'local' ? '新建本地目录' : '新建远程目录',
      label: '目录名称',
      confirmLabel: '创建',
      onConfirm: async (name) => {
        if (binding.kind === 'local') {
          await localMkdir(localJoin(path, name))
        } else {
          if (sftpId == null) return
          await sftpMkdir(sftpId, remoteJoin(path, name))
        }
        await refresh()
      },
    })
  }

  const createFile = () => {
    promptName({
      title: binding.kind === 'local' ? '新建本地文件' : '新建远程文件',
      label: '文件名称',
      confirmLabel: '创建',
      onConfirm: async (name) => {
        if (binding.kind === 'local') {
          await localCreateFile(localJoin(path, name))
        } else {
          if (sftpId == null) return
          await sftpCreateFile(sftpId, remoteJoin(path, name))
        }
        await refresh()
      },
    })
  }

  const remove = () => {
    if (selected.length === 0) return
    useApp.getState().setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: `删除选中的 ${selected.length} 项？`,
      message: '目录会连同里面的内容一起删掉，这个操作不可撤销。',
      confirmLabel: '删除',
      onConfirm: () => void doRemove(),
    })
  }

  const doRemove = async () => {
    const chosen = entries.filter((e) => selected.includes(e.path))
    for (const entry of chosen) {
      try {
        if (binding.kind === 'local') {
          await localRemove(entry.path, entry.isDir)
        } else {
          if (sftpId == null) return
          await sftpRemove(sftpId, entry.path, entry.isDir)
        }
      } catch (e) {
        useApp.getState().setError(String(e))
      }
    }
    setSelected([])
    await refresh()
  }

  const rename = () => {
    const path0 = selected[0]
    if (!path0) return
    const oldName = path0.split(/[\\/]/).filter(Boolean).pop() ?? path0
    promptName({
      title: '重命名',
      label: '新的名称',
      defaultValue: oldName,
      confirmLabel: '重命名',
      onConfirm: async (name) => {
        if (name === oldName) return
        const parent = path0.slice(0, path0.length - oldName.length)
        const target = `${parent}${name}`
        if (binding.kind === 'local') {
          await localRename(path0, target)
        } else {
          if (sftpId == null) return
          await sftpRename(sftpId, path0, target)
        }
        setSelected([])
        await refresh()
      },
    })
  }

  const openEditor = (pick?: string) => {
    const target = pick ?? selected[0]
    if (!target) return
    if (binding.kind === 'remote' && sftpId == null) return
    const name = target.split(/[\\/]/).filter(Boolean).pop() ?? target
    useApp.getState().addTab({
      title: name,
      kind: 'editor',
      editorTarget: {
        side: binding.kind === 'local' ? 'local' : 'remote',
        path: target,
        sftpId: binding.kind === 'remote' ? sftpId : null,
      },
    })
  }

  return {
    binding,
    sftpId,
    ready: binding.kind === 'local' || sftpId != null,
    path,
    entries,
    loading,
    selected,
    setSelected,
    navigate,
    refresh,
    mkdir,
    createFile,
    remove,
    rename,
    openEditor,
  }
}

/** 绑定按钮的默认样式（文件栏栏头「主机名 ▾ / 本机 ▾」用） */
export function BindingButton({
  binding,
  onClick,
  className,
}: {
  binding: PaneBinding
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  className?: string
}) {
  const label = binding.kind === 'local' ? '本机' : binding.label
  const title = binding.kind === 'local' ? '本机文件' : `远程：${binding.label}`
  return (
    <button
      onClick={onClick}
      title={`${title}（点击换绑定）`}
      data-pane-binding
      className={className}
    >
      {label} <span className="text-ink-tertiary">▾</span>
    </button>
  )
}
