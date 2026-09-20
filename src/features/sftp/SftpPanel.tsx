import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Download, Eye, EyeOff, FileCode2, FolderPlus, PencilLine, SquareTerminal, Trash2, Upload } from 'lucide-react'
import {
  isDesktop,
  localCopy,
  localHome,
  localList,
  localMkdir,
  localRemove,
  localRename,
  sftpClose,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpOpen,
  sftpPwd,
  sftpRemove,
  sftpRename,
  sftpUpload,
  type FileEntry,
} from '@/lib/api'
import { liveLocalPane, livePaneOfSession, terminalTab, useApp } from '@/lib/store'
import { copyQuietly } from '@/lib/clipboard'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'
import { FilePane, parentPath, type Side, type SortKey, type SortState } from './FilePane'
import { TransferQueue } from './TransferQueue'
import type { ConflictPolicy } from '@/lib/api'

interface Props {
  sessionId: string
}

const SIDES: readonly Side[] = ['local', 'remote']

/** 超过这个位移才算真在拖，不然就是手抖点了一下 */
const DRAG_THRESHOLD = 5

export function SftpPanel({ sessionId }: Props) {
  const setError = useApp((s) => s.setError)
  const setConfirmPrompt = useApp((s) => s.setConfirmPrompt)
  const runTransfer = useApp((s) => s.runTransfer)
  const addTab = useApp((s) => s.addTab)

  const [sftpId, setSftpId] = useState<number | null>(null)
  // 空串表示还没拿到远端家目录，拿到了才会触发首次列目录
  const [remotePath, setRemotePath] = useState('')
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([])
  const [localPath, setLocalPath] = useState('')
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState<Side | null>(null)
  const [selected, setSelected] = useState<Record<Side, string[]>>({ local: [], remote: [] })
  /** 断点续传开关。初值取设置里的默认值，面板上改了只影响这个面板 */
  const [resume, setResume] = useState(() => useApp.getState().transferResumeDefault)
  /** 同名文件策略。默认覆盖，与改造前一致；做成面板级选项，批内不逐个问 */
  const [conflict, setConflict] = useState<ConflictPolicy>('overwrite')
  /**
   * 列表排序。默认按名称升序（与后端给的顺序一致），点表头切换。
   * 放前端排而不是给后端命令加参数：省掉两个命令的签名与三方样板，
   * 而一屏几十上百个条目在前端排完全够用。
   */
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  /** 远端栏是否显示点文件（.git/.env 这类）。默认显示，与改造前一致 */
  const [showHidden, setShowHidden] = useState(true)

  /** 文件行的右键菜单：开在哪儿、哪一栏、点的是哪一项 */
  const [menu, setMenu] = useState<
    { x: number; y: number; side: Side; entry: FileEntry } | null
  >(null)

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    )

  /** 排序：目录永远在前，同类之间按选中的列；缺值（null）排在最后 */
  const sortEntries = (entries: FileEntry[]): FileEntry[] =>
    [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      const sign = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'name') return a.name.localeCompare(b.name) * sign
      if (sort.key === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * sign
      const am = a.modified ?? 0
      const bm = b.modified ?? 0
      return (am - bm) * sign
    })

  /** 当前拖拽落点在哪一栏。内部拖拽和系统拖入共用同一个高亮 */
  const [dropSide, setDropSide] = useState<Side | null>(null)
  /** 内部拖拽时跟着光标走的小浮标 */
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)

  const paneRefs = useRef<Record<Side, HTMLDivElement | null>>({ local: null, remote: null })
  const dragRef = useRef<{
    from: Side
    entries: FileEntry[]
    ox: number
    oy: number
    active: boolean
  } | null>(null)

  /**
   * 拖放监听是一次性注册的长生命周期回调，而 sftpId / 当前目录这些会变。
   * 走 ref 拿最新值，免得闭包把旧目录传进上传。
   */
  const latest = useRef({ sftpId, remotePath, localPath, resume, conflict })
  latest.current = { sftpId, remotePath, localPath, resume, conflict }

  // 开一个 sftp 子系统通道，挂在已有 SSH 会话上
  useEffect(() => {
    let alive = true
    /**
     * 卸载时要关掉谁。必须记在局部变量里，不能依赖 sftpId 这个 state：
     * 打开是异步的，组件可能在 sftpOpen 返回之前就卸载了，那时 sftpId 还是 null。
     */
    let opened: number | null = null

    void (async () => {
      try {
        const id = await sftpOpen(sessionId)
        if (!alive) {
          // 打开完成时组件已经没了 —— 立刻还回去，否则这条通道永远没人关
          void sftpClose(id)
          return
        }
        opened = id
        const home = await sftpPwd(id).catch(() => '/')
        if (!alive) return
        setSftpId(id)
        setRemotePath(home)
      } catch (e) {
        if (alive) setError(`打开 SFTP 失败：${String(e)}`)
      }
    })()

    return () => {
      alive = false
      /**
       * 归还通道。后端按引用计数，只有最后一个使用者释放才真关 ——
       * 所以对同一台主机开多个 SFTP 标签时，关掉一个不会影响其余的。
       * 不关的话每开一次就永久占服务端一个 session 槽位（sshd 默认上限 10）。
       */
      if (opened != null) void sftpClose(opened)
    }
  }, [sessionId, setError])

  useEffect(() => {
    void localHome()
      .then(setLocalPath)
      .catch(() => setLocalPath('C:\\'))
  }, [])

  const refreshRemote = useCallback(
    async (path: string) => {
      if (sftpId == null) return
      setLoading('remote')
      try {
        setRemoteEntries(await sftpList(sftpId, path))
      } catch (e) {
        setError(`读取远程目录失败：${String(e)}`)
      } finally {
        setLoading(null)
      }
    },
    [sftpId, setError],
  )

  const refreshLocal = useCallback(
    async (path: string) => {
      setLoading('local')
      try {
        setLocalEntries(await localList(path))
      } catch (e) {
        setError(`读取本地目录失败：${String(e)}`)
      } finally {
        setLoading(null)
      }
    },
    [setError],
  )

  useEffect(() => {
    if (sftpId != null && remotePath) void refreshRemote(remotePath)
  }, [sftpId, remotePath, refreshRemote])

  useEffect(() => {
    if (localPath) void refreshLocal(localPath)
  }, [localPath, refreshLocal])

  const navigate = (side: Side, path: string) => {
    setSelected((s) => ({ ...s, [side]: [] }))
    if (side === 'local') {
      setLocalPath(path)
    } else {
      setRemotePath(path)
    }
  }

  const activate = (side: Side, entry: FileEntry) => {
    if (entry.isDir) {
      navigate(side, entry.path)
      return
    }
    // 双击文件 = 传到对侧当前目录
    if (side === 'remote') void download([entry])
    else void uploadPaths([entry.path])
  }

  const download = async (entries: FileEntry[]) => {
    const { sftpId: id, localPath: dir, resume: rs, conflict: cf } = latest.current
    if (id == null) return
    for (const entry of entries) {
      await runTransfer('download', entry.name, (ch) =>
        sftpDownload(id, entry.path, dir, rs, cf, ch),
      )
    }
    void refreshLocal(dir)
  }

  /** 按**本地绝对路径**上传。双栏互拖给的是 FileEntry，系统拖入给的是裸路径，统一走这里 */
  const uploadPaths = useCallback(
    async (paths: string[]) => {
      const { sftpId: id, remotePath: dir, resume: rs, conflict: cf } = latest.current
      if (id == null) return
      for (const p of paths) {
        const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p
        await runTransfer('upload', name, (ch) => sftpUpload(id, p, dir, rs, cf, ch))
      }
      void refreshRemote(dir)
    },
    [runTransfer, refreshRemote],
  )

  /** 从资源管理器拖进来的文件落进本地栏：复制到本地当前目录 */
  const copyToLocal = useCallback(
    async (paths: string[]) => {
      const dir = latest.current.localPath
      try {
        await localCopy(paths, dir)
        void refreshLocal(dir)
      } catch (e) {
        setError(`复制失败：${String(e)}`)
      }
    },
    [refreshLocal, setError],
  )

  const handleDrop = useCallback(
    (entries: FileEntry[], from: Side) => {
      if (from === 'local') void uploadPaths(entries.map((e) => e.path))
      else void download(entries)
    },
    // download 每次渲染都是新函数，放进来会让这个回调每次都变；它内部只读 latest，用谁都一样
    [uploadPaths],
  )

  const handleDropRef = useRef(handleDrop)
  handleDropRef.current = handleDrop

  /** 从系统拖进来的：落到远程栏就上传，落到本地栏就复制 */
  const dropExternal = useCallback(
    async (paths: string[], side: Side) => {
      if (paths.length === 0) return
      if (side === 'remote') await uploadPaths(paths)
      else await copyToLocal(paths)
    },
    [uploadPaths, copyToLocal],
  )

  const dropExternalRef = useRef(dropExternal)
  dropExternalRef.current = dropExternal

  /** 命中测试：客户端坐标落在哪一栏。落在传输队列之类返回 null */
  const sideAt = useCallback((x: number, y: number): Side | null => {
    for (const side of SIDES) {
      const el = paneRefs.current[side]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return side
    }
    return null
  }, [])

  // 系统文件拖入。Tauri 给的是物理像素坐标，要按 dpr 折算回 CSS 像素
  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const stop = await getCurrentWindow().onDragDropEvent((event) => {
          const p = event.payload
          if (p.type === 'leave') {
            setDropSide(null)
            return
          }
          const scale = window.devicePixelRatio || 1
          const side = sideAt(p.position.x / scale, p.position.y / scale)
          if (p.type === 'drop') {
            setDropSide(null)
            // 落在两栏之外就不动，别把文件传到用户没打算传的地方
            if (side) void dropExternalRef.current(p.paths, side)
            return
          }
          setDropSide(side)
        })
        if (cancelled) stop()
        else unlisten = stop
      } catch (e) {
        console.warn('[easy-shell] 注册文件拖放监听失败:', e)
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [sideAt])

  // 双栏互拖：鼠标事件自己实现，不碰 HTML5 dataTransfer（原因写在 FilePane 的注释里）
  useEffect(() => {
    const finish = () => {
      dragRef.current = null
      document.body.style.userSelect = ''
      setGhost(null)
      setDropSide(null)
    }

    const onMove = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      if (!st.active) {
        if (Math.abs(e.clientX - st.ox) + Math.abs(e.clientY - st.oy) < DRAG_THRESHOLD) return
        st.active = true
        document.body.style.userSelect = 'none'
      }
      const side = sideAt(e.clientX, e.clientY)
      setDropSide(side && side !== st.from ? side : null)
      const first = st.entries[0]
      setGhost({
        x: e.clientX,
        y: e.clientY,
        label: st.entries.length > 1 ? `${first.name} 等 ${st.entries.length} 项` : first.name,
      })
    }

    const onUp = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      const side = sideAt(e.clientX, e.clientY)
      const moved = st.active
      finish()
      if (!moved) return
      if (side && side !== st.from) void handleDropRef.current(st.entries, st.from)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) finish()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.userSelect = ''
    }
  }, [sideAt])

  const beginDrag =
    (side: Side) =>
    (e: ReactMouseEvent, entry: FileEntry): void => {
      if (e.button !== 0) return
      const pool = side === 'local' ? localEntries : remoteEntries
      const picked = selected[side]
      const entries = picked.includes(entry.path)
        ? pool.filter((x) => picked.includes(x.path))
        : [entry]
      dragRef.current = { from: side, entries, ox: e.clientX, oy: e.clientY, active: false }
    }

  const mkdir = (side: Side) => {
    setConfirmPrompt({
      kind: 'input',
      title: side === 'local' ? '新建本地目录' : '新建远程目录',
      label: '目录名称',
      confirmLabel: '创建',
      onConfirm: async (value) => {
        const name = value.trim()
        if (!name) return
        if (side === 'local') {
          const sep = localPath.includes('\\') ? '\\' : '/'
          const target = `${localPath.replace(/[\\/]+$/, '')}${sep}${name}`
          await localMkdir(target)
          void refreshLocal(localPath)
        } else {
          if (sftpId == null) return
          const target = `${remotePath.replace(/\/+$/, '')}/${name}`
          await sftpMkdir(sftpId, target)
          void refreshRemote(remotePath)
        }
      },
    })
  }

  const remove = (side: Side) => {
    const paths = selected[side]
    if (paths.length === 0) return
    setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: `删除选中的 ${paths.length} 项？`,
      message: '目录会连同里面的内容一起删掉，这个操作不可撤销。',
      confirmLabel: '删除',
      onConfirm: () => void doRemove(side, paths),
    })
  }

  const doRemove = async (side: Side, paths: string[]) => {
    if (side === 'local') {
      const entries = localEntries.filter((e) => paths.includes(e.path))
      for (const entry of entries) {
        try {
          await localRemove(entry.path, entry.isDir)
        } catch (e) {
          setError(String(e))
        }
      }
      setSelected((s) => ({ ...s, local: [] }))
      void refreshLocal(localPath)
      return
    }

    if (sftpId == null) return
    for (const path of paths) {
      const entry = remoteEntries.find((e) => e.path === path)
      try {
        await sftpRemove(sftpId, path, entry?.isDir ?? false)
      } catch (e) {
        setError(String(e))
      }
    }
    setSelected((s) => ({ ...s, remote: [] }))
    void refreshRemote(remotePath)
  }

  /** 在内置编辑器里打开选中的文件 */
  const openEditor = (side: Side) => {
    const path = selected[side][0]
    if (!path) return
    if (side === 'remote' && sftpId == null) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    addTab({
      title: name,
      kind: 'editor',
      editorTarget: { side, path, sftpId: side === 'remote' ? sftpId : null },
    })
  }

  /** 重命名：本地和远端都只改最后一段，同级内改名 */
  const rename = (side: Side) => {
    const path = selected[side][0]
    if (!path) return
    const oldName = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    setConfirmPrompt({
      kind: 'input',
      title: '重命名',
      label: '新的名称',
      defaultValue: oldName,
      confirmLabel: '重命名',
      onConfirm: async (value) => {
        const name = value.trim()
        if (!name || name === oldName) return
        const parent = path.slice(0, path.length - oldName.length)
        const target = `${parent}${name}`
        if (side === 'local') {
          await localRename(path, target)
          await refreshLocal(localPath)
        } else {
          if (sftpId == null) return
          await sftpRename(sftpId, path, target)
          await refreshRemote(remotePath)
        }
        setSelected((s) => ({ ...s, [side]: [] }))
      },
    })
  }

  /**
   * 把路径包成 shell 里的**字面量**。
   *
   * 不用双引号是被真实路径教育过的：Windows 的 `C:\$Recycle.Bin` 在 PowerShell 的
   * 双引号里会把 `$Recycle` 当变量吃掉，POSIX 那边 `$`、反引号同理。
   * 单引号在两个世界里都是字面量，只有"路径本身带单引号"时的转义规则不同：
   * PowerShell 连着写两个，POSIX 是 `'\''`。
   *
   * 远端一律按 POSIX 算 —— ssh 过去的那一端是 sh 系。
   */
  const quotePath = (dir: string, side: Side): string => {
    if (side === 'local' && navigator.userAgent.includes('Windows')) {
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
  const openInTerminal = (side: Side, dir: string) => {
    const s = useApp.getState()
    const command = `cd ${quotePath(dir, side)}\n`
    if (side === 'remote') {
      const pane = livePaneOfSession(sessionId)
      if (!pane) {
        setError('这台主机没有开着的终端 —— 先连上它（或在它上面开个标签）再试')
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

  /**
   * 文件行的右键菜单。
   *
   * 动作都作用在**选中集合**上（FilePane 保证右键那一行一定在里面），
   * 所以标签里要带上数量 —— 「删除」后面跟着「3 项」和只有一项，是两次完全不同的确认。
   */
  const fileMenu = (side: Side, entry: FileEntry): MenuEntry[] => {
    const picked = selected[side]
    const many = picked.length
    const pool = side === 'local' ? localEntries : remoteEntries
    const chosen = pool.filter((e) => picked.includes(e.path))
    /** 要"在终端里打开"的目录：目录自己，文件则取它所在的目录 */
    const dir = entry.isDir ? entry.path : (parentPath(entry.path) ?? '')
    const only = many === 1
    return [
      {
        label: entry.isDir ? '打开' : side === 'remote' ? '下载到本地' : '上传到远程',
        testId: 'file-activate',
        hint: entry.isDir ? undefined : '双击',
        onSelect: () => activate(side, entry),
      },
      sep(),
      {
        label:
          side === 'local'
            ? `上传${many > 1 ? ` ${many} 项` : ''}`
            : `下载${many > 1 ? ` ${many} 项` : ''}`,
        testId: 'file-transfer',
        icon:
          side === 'local' ? (
            <Upload size={13} className="shrink-0 text-ink-tertiary" />
          ) : (
            <Download size={13} className="shrink-0 text-ink-tertiary" />
          ),
        onSelect: () =>
          side === 'local'
            ? void uploadPaths(picked)
            : void download(chosen.length > 0 ? chosen : [entry]),
      },
      {
        label: '用内置编辑器打开',
        testId: 'file-edit',
        icon: <FileCode2 size={13} className="shrink-0 text-ink-tertiary" />,
        // 一次只能编辑一个文件，选了一堆时先灰掉，别猜用户想要哪个
        disabled: entry.isDir || !only,
        hint: entry.isDir ? '这是目录' : !only ? `选了 ${many} 项` : undefined,
        onSelect: () => openEditor(side),
      },
      {
        label: '重命名',
        testId: 'file-rename',
        icon: <PencilLine size={13} className="shrink-0 text-ink-tertiary" />,
        disabled: !only,
        hint: only ? undefined : `选了 ${many} 项`,
        onSelect: () => rename(side),
      },
      {
        label: '新建目录',
        testId: 'file-mkdir',
        icon: <FolderPlus size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => mkdir(side),
      },
      {
        label: `删除${many > 1 ? ` ${many} 项` : ''}`,
        testId: 'file-delete',
        danger: true,
        icon: <Trash2 size={13} className="shrink-0" />,
        onSelect: () => remove(side),
      },
      sep(),
      {
        label: '复制路径',
        testId: 'file-copy-path',
        // 选中多个时每行一条 —— 这是唯一能把整批路径一次拿去用的形式
        onSelect: () => copyQuietly(picked.join('\n')),
      },
      {
        label: '复制名称',
        testId: 'file-copy-name',
        onSelect: () => copyQuietly(entry.name),
      },
      sep(),
      {
        label:
          side === 'remote'
            ? entry.isDir
              ? '在终端里 cd 过去'
              : '在终端里 cd 到所在目录'
            : entry.isDir
              ? '在终端里打开这个目录'
              : '在终端里打开所在目录',
        testId: 'file-open-terminal',
        icon: <SquareTerminal size={13} className="shrink-0 text-ink-tertiary" />,
        // 根目录没有父目录可去（parentPath 给 null），那就没什么可 cd 的
        disabled: !dir,
        onSelect: () => openInTerminal(side, dir),
      },
    ]
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <FilePane
          side="local"
          title="本地"
          path={localPath}
          entries={sortEntries(localEntries)}
          sort={sort}
          onSort={toggleSort}
          loading={loading === 'local'}
          selected={selected.local}
          onSelect={(paths) => setSelected((s) => ({ ...s, local: paths }))}
          onActivate={(entry) => activate('local', entry)}
          onNavigate={(p) => navigate('local', p)}
          onRefresh={() => void refreshLocal(localPath)}
          onMkdir={() => mkdir('local')}
          onDelete={() => remove('local')}
          onRename={() => rename('local')}
          onEdit={() => openEditor('local')}
          onTransfer={() => void uploadPaths(selected.local)}
          onRowMouseDown={beginDrag('local')}
          onRowMenu={(e, entry) => {
            const at = menuAt(e)
            if (at) setMenu({ ...at, side: 'local', entry })
          }}
          dropActive={dropSide === 'local'}
          paneRef={(el) => {
            paneRefs.current.local = el
          }}
        />
        <div className="w-px shrink-0 bg-hairline" />
        <FilePane
          side="remote"
          title="远程"
          path={remotePath}
          entries={sortEntries(
            showHidden ? remoteEntries : remoteEntries.filter((e) => !e.name.startsWith('.')),
          )}
          sort={sort}
          onSort={toggleSort}
          loading={loading === 'remote'}
          selected={selected.remote}
          onSelect={(paths) => setSelected((s) => ({ ...s, remote: paths }))}
          onActivate={(entry) => activate('remote', entry)}
          onNavigate={(p) => navigate('remote', p)}
          onRefresh={() => void refreshRemote(remotePath)}
          onMkdir={() => mkdir('remote')}
          onDelete={() => remove('remote')}
          onRename={() => rename('remote')}
          onEdit={() => openEditor('remote')}
          onTransfer={() =>
            void download(remoteEntries.filter((e) => selected.remote.includes(e.path)))
          }
          onRowMouseDown={beginDrag('remote')}
          onRowMenu={(e, entry) => {
            const at = menuAt(e)
            if (at) setMenu({ ...at, side: 'remote', entry })
          }}
          dropActive={dropSide === 'remote'}
          paneRef={(el) => {
            paneRefs.current.remote = el
          }}
          toolbar={
            // 隐藏文件开关只给远端：Windows 本地栏没有点文件这套约定，加了也没意义
            <button
              onClick={() => setShowHidden((v) => !v)}
              className={`transition-colors hover:text-ink ${
                showHidden ? '' : 'text-ink-tertiary'
              }`}
              title={showHidden ? '隐藏以点开头的文件' : '显示以点开头的文件'}
            >
              {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          }
        />
      </div>
      <TransferQueue
        resume={resume}
        onToggleResume={() => setResume((v) => !v)}
        conflict={conflict}
        onConflictChange={setConflict}
      />

      {ghost && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-ink shadow-lg"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {ghost.label}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={fileMenu(menu.side, menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
