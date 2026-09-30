import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRightLeft,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus,
  FolderPlus,
  PencilLine,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  isDesktop,
  localCopy,
  sftpCopy,
  sftpDownload,
  sftpUpload,
  type ConflictPolicy,
  type FileEntry,
} from '@/lib/api'
import { useApp } from '@/lib/store'
import { copyQuietly } from '@/lib/clipboard'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'
import { FilePane, parentPath, type SortKey, type SortState } from './FilePane'
import { TransferQueue } from './TransferQueue'
import {
  BindingButton,
  bindingForSession,
  bindingMenuItems,
  openInTerminalFor,
  useFileBrowser,
  type FileBrowser,
  type PaneBinding,
} from './binding'

interface Props {
  /** 这个标签默认绑的远程会话（另一栏默认是本机） */
  sessionId: string
}

/** 双栏的键。0 = 左，1 = 右 */
type PaneKey = 0 | 1
const PANES: readonly PaneKey[] = [0, 1]

/** 超过这个位移才算真在拖，不然就是手抖点了一下 */
const DRAG_THRESHOLD = 5

/** 传输方向的动词：按「源 × 目标」的绑定组合决定叫上传、下载还是复制 */
function transferVerb(src: PaneBinding, dst: PaneBinding): string {
  if (src.kind === 'local' && dst.kind === 'remote') return '上传'
  if (src.kind === 'remote' && dst.kind === 'local') return '下载'
  return '复制'
}

/**
 * 双栏文件窗口。
 *
 * **每栏各自可绑「本地 或 任意一台已连接主机」** —— 本地|远程、同主机两个目录、
 * 跨主机远程|远程都行，栏头「主机名 ▾」点选换绑定。传输按「源 × 目标」分派：
 * 本地→远程 = 上传、远程→本地 = 下载、远程→远程 = Rust 侧流式中转（sftp_copy）、
 * 本地→本地 = 复制（同名自动改名）。
 */
export function SftpPanel({ sessionId }: Props) {
  const setError = useApp((s) => s.setError)
  const runTransfer = useApp((s) => s.runTransfer)

  const [bindings, setBindings] = useState<[PaneBinding, PaneBinding]>(() => [
    { kind: 'local' },
    bindingForSession(sessionId),
  ])
  const browser0 = useFileBrowser(bindings[0])
  const browser1 = useFileBrowser(bindings[1])
  const browsers: [FileBrowser, FileBrowser] = [browser0, browser1]

  /**
   * 拖放监听是一次性注册的长生命周期回调，而绑定 / 当前目录这些会变。
   * 走 ref 拿最新值，免得闭包把旧目录传进上传。
   */
  const latest = useRef({ browsers, resume: false, conflict: 'overwrite' as ConflictPolicy })
  /** 断点续传开关。初值取设置里的默认值，面板上改了只影响这个面板 */
  const [resume, setResume] = useState(() => useApp.getState().transferResumeDefault)
  /** 同名文件策略。默认覆盖，与改造前一致；做成面板级选项，批内不逐个问 */
  const [conflict, setConflict] = useState<ConflictPolicy>('overwrite')
  latest.current = { browsers, resume, conflict }

  /**
   * 列表排序。默认按名称升序（与后端给的顺序一致），点表头切换。
   * 放前端排而不是给后端命令加参数：省掉两个命令的签名与三方样板，
   * 而一屏几十上百个条目在前端排完全够用。
   */
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  /** 远程栏是否显示点文件（.git/.env 这类）。默认显示，与改造前一致 */
  const [showHidden, setShowHidden] = useState(true)

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

  /** 右键菜单：行菜单 / 空白菜单 / 换绑菜单，三者共用一个浮层状态 */
  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: 'file'; pane: PaneKey; entry: FileEntry }
    | { x: number; y: number; kind: 'blank'; pane: PaneKey }
    | { x: number; y: number; kind: 'bind'; pane: PaneKey }
    | null
  >(null)

  /* ---------------- 传输：按「源 × 目标」的绑定组合分派 ---------------- */

  /** 本地路径 → 某个远程栏（上传）。系统拖入也走这里 */
  const uploadPaths = async (paths: string[], to: PaneKey) => {
    const dst = latest.current.browsers[to]
    if (dst.binding.kind !== 'remote' || dst.sftpId == null) return
    const { path: dir, sftpId } = dst
    const { resume: rs, conflict: cf } = latest.current
    for (const p of paths) {
      const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p
      await runTransfer('upload', name, (ch) => sftpUpload(sftpId, p, dir, rs, cf, ch))
    }
    void dst.refresh()
  }

  /** 远程栏 → 本地栏（下载） */
  const downloadEntries = async (entries: FileEntry[], from: PaneKey, to: PaneKey) => {
    const src = latest.current.browsers[from]
    const dst = latest.current.browsers[to]
    if (src.binding.kind !== 'remote' || src.sftpId == null) return
    if (dst.binding.kind !== 'local') return
    const id = src.sftpId
    const dir = dst.path
    const { resume: rs, conflict: cf } = latest.current
    for (const entry of entries) {
      await runTransfer('download', entry.name, (ch) =>
        sftpDownload(id, entry.path, dir, rs, cf, ch),
      )
    }
    void dst.refresh()
  }

  /** 远程 → 远程对拷（两台主机之间、或同一台的两个目录之间）：Rust 侧流式中转 */
  const copyRemoteEntries = async (entries: FileEntry[], from: PaneKey, to: PaneKey) => {
    const src = latest.current.browsers[from]
    const dst = latest.current.browsers[to]
    if (src.binding.kind !== 'remote' || src.sftpId == null) return
    if (dst.binding.kind !== 'remote' || dst.sftpId == null) return
    const fromId = src.sftpId
    const toId = dst.sftpId
    const dir = dst.path
    const { conflict: cf } = latest.current
    for (const entry of entries) {
      await runTransfer('copy', entry.name, (ch) =>
        sftpCopy(fromId, entry.path, toId, dir, cf, ch),
      )
    }
    void dst.refresh()
  }

  /** 本地 → 本地：复制到目标栏当前目录（同名自动改名，与系统拖入同一后端） */
  const copyLocalPaths = async (paths: string[], to: PaneKey) => {
    const dst = latest.current.browsers[to]
    if (dst.binding.kind !== 'local') return
    try {
      await localCopy(paths, dst.path)
      void dst.refresh()
    } catch (e) {
      setError(`复制失败：${String(e)}`)
    }
  }

  /** 把 from 栏的 entries 传到 to 栏 */
  const handleDrop = (from: PaneKey, to: PaneKey, entries: FileEntry[]) => {
    const src = latest.current.browsers[from]
    const dst = latest.current.browsers[to]
    if (src.binding.kind === 'local' && dst.binding.kind === 'remote') {
      void uploadPaths(
        entries.map((e) => e.path),
        to,
      )
    } else if (src.binding.kind === 'remote' && dst.binding.kind === 'local') {
      void downloadEntries(entries, from, to)
    } else if (src.binding.kind === 'remote' && dst.binding.kind === 'remote') {
      void copyRemoteEntries(entries, from, to)
    } else {
      void copyLocalPaths(
        entries.map((e) => e.path),
        to,
      )
    }
  }

  /** 从系统拖进来的（资源管理器）：落到远程栏就上传，落到本地栏就复制进来 */
  const dropExternal = async (paths: string[], to: PaneKey) => {
    if (paths.length === 0) return
    const dst = latest.current.browsers[to]
    if (dst.binding.kind === 'remote') await uploadPaths(paths, to)
    else await copyLocalPaths(paths, to)
  }

  /** 一次性注册的长生命周期监听走 ref 拿最新回调，免得闭包过期 */
  const handleDropRef = useRef(handleDrop)
  handleDropRef.current = handleDrop
  const dropExternalRef = useRef(dropExternal)
  dropExternalRef.current = dropExternal

  /* ---------------- 拖拽：鼠标事件自己实现，不碰 HTML5 dataTransfer ---------------- */

  /** 当前拖拽落点在哪一栏。内部拖拽和系统拖入共用同一个高亮 */
  const [dropPane, setDropPane] = useState<PaneKey | null>(null)
  /** 内部拖拽时跟着光标走的小浮标 */
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)

  const paneRefs = useRef<Record<PaneKey, HTMLDivElement | null>>({ 0: null, 1: null })
  const dragRef = useRef<{
    from: PaneKey
    entries: FileEntry[]
    ox: number
    oy: number
    active: boolean
  } | null>(null)

  /** 命中测试：客户端坐标落在哪一栏。落在传输队列之类返回 null */
  const paneAt = useCallback((x: number, y: number): PaneKey | null => {
    for (const pane of PANES) {
      const el = paneRefs.current[pane]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return pane
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
            setDropPane(null)
            return
          }
          const scale = window.devicePixelRatio || 1
          const pane = paneAt(p.position.x / scale, p.position.y / scale)
          if (p.type === 'drop') {
            setDropPane(null)
            // 落在两栏之外就不动，别把文件传到用户没打算传的地方
            if (pane !== null) void dropExternalRef.current(p.paths, pane)
            return
          }
          setDropPane(pane)
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
    // dropExternal 走 ref：这个监听是一次性注册的，不能跟着面板状态重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneAt])

  // 双栏互拖：鼠标事件自己实现，不碰 HTML5 dataTransfer（原因写在 FilePane 的注释里）
  useEffect(() => {
    const finish = () => {
      dragRef.current = null
      document.body.style.userSelect = ''
      setGhost(null)
      setDropPane(null)
    }

    const onMove = (e: MouseEvent) => {
      const st = dragRef.current
      if (!st) return
      // 松手在窗口外面时 webview 收不到 mouseup：靠"当前没按着键"把这一轮收掉
      if (e.buttons === 0) {
        finish()
        return
      }
      if (!st.active) {
        if (Math.abs(e.clientX - st.ox) + Math.abs(e.clientY - st.oy) < DRAG_THRESHOLD) return
        st.active = true
        document.body.style.userSelect = 'none'
      }
      const pane = paneAt(e.clientX, e.clientY)
      setDropPane(pane !== null && pane !== st.from ? pane : null)
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
      const pane = paneAt(e.clientX, e.clientY)
      const moved = st.active
      finish()
      if (!moved) return
      if (pane !== null && pane !== st.from) void handleDropRef.current(st.from, pane, st.entries)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) finish()
    }
    // 指针离开窗口 / 窗口失焦：这一轮拖拽作废（松在窗口外的 mouseup 到不了这里）
    const onLeave = () => {
      if (dragRef.current) finish()
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
  }, [paneAt])

  const beginDrag =
    (pane: PaneKey) =>
    (e: ReactMouseEvent, entry: FileEntry): void => {
      if (e.button !== 0) return
      const browser = latest.current.browsers[pane]
      const picked = browser.selected
      const entries = picked.includes(entry.path)
        ? browser.entries.filter((x) => picked.includes(x.path))
        : [entry]
      dragRef.current = { from: pane, entries, ox: e.clientX, oy: e.clientY, active: false }
    }

  /* ---------------- 菜单动作 ---------------- */

  /** 双击行 / 菜单第一项：目录进去，文件传到对侧 */
  const activate = (pane: PaneKey, entry: FileEntry) => {
    const browser = latest.current.browsers[pane]
    if (entry.isDir) {
      browser.navigate(entry.path)
      return
    }
    handleDrop(pane, pane === 0 ? 1 : 0, [entry])
  }

  /** 把这一栏选中的东西传到对侧 */
  const transferPicked = (pane: PaneKey) => {
    const browser = latest.current.browsers[pane]
    const other: PaneKey = pane === 0 ? 1 : 0
    const chosen = browser.entries.filter((e) => browser.selected.includes(e.path))
    handleDrop(pane, other, chosen)
  }

  /**
   * 文件行的右键菜单。
   *
   * 动作都作用在**选中集合**上（FilePane 保证右键那一行一定在里面），
   * 所以标签里要带上数量 —— 「删除」后面跟着「3 项」和只有一项，是两次完全不同的确认。
   */
  const fileMenu = (pane: PaneKey, entry: FileEntry): MenuEntry[] => {
    const browser = latest.current.browsers[pane]
    const other = latest.current.browsers[pane === 0 ? 1 : 0]
    const picked = browser.selected
    const many = picked.length
    const verb = transferVerb(browser.binding, other.binding)
    /** 要"在终端里打开"的目录：目录自己，文件则取它所在的目录 */
    const dir = entry.isDir ? entry.path : (parentPath(entry.path) ?? '')
    const isLocal = browser.binding.kind === 'local'
    const only = many === 1
    return [
      {
        label: entry.isDir ? '打开' : `${verb}到对侧`,
        testId: 'file-activate',
        hint: entry.isDir ? undefined : '双击',
        onSelect: () => activate(pane, entry),
      },
      sep(),
      {
        label: `${verb}${many > 1 ? ` ${many} 项` : ''}`,
        testId: 'file-transfer',
        icon:
          verb === '上传' ? (
            <Upload size={13} className="shrink-0 text-ink-tertiary" />
          ) : verb === '下载' ? (
            <Download size={13} className="shrink-0 text-ink-tertiary" />
          ) : (
            <ArrowRightLeft size={13} className="shrink-0 text-ink-tertiary" />
          ),
        onSelect: () => transferPicked(pane),
      },
      {
        label: '用内置编辑器打开',
        testId: 'file-edit',
        icon: <FileCode2 size={13} className="shrink-0 text-ink-tertiary" />,
        // 一次只能编辑一个文件，选了一堆时先灰掉，别猜用户想要哪个
        disabled: entry.isDir || !only,
        hint: entry.isDir ? '这是目录' : !only ? `选了 ${many} 项` : undefined,
        onSelect: () => browser.openEditor(),
      },
      {
        label: '重命名',
        testId: 'file-rename',
        icon: <PencilLine size={13} className="shrink-0 text-ink-tertiary" />,
        disabled: !only,
        hint: only ? undefined : `选了 ${many} 项`,
        onSelect: () => browser.rename(),
      },
      {
        label: '新建文件',
        testId: 'file-new-file',
        icon: <FilePlus size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => browser.createFile(),
      },
      {
        label: '新建目录',
        testId: 'file-mkdir',
        icon: <FolderPlus size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => browser.mkdir(),
      },
      {
        label: `删除${many > 1 ? ` ${many} 项` : ''}`,
        testId: 'file-delete',
        danger: true,
        icon: <Trash2 size={13} className="shrink-0" />,
        onSelect: () => browser.remove(),
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
        label: isLocal
          ? entry.isDir
            ? '在终端里打开这个目录'
            : '在终端里打开所在目录'
          : entry.isDir
            ? '在终端里 cd 过去'
            : '在终端里 cd 到所在目录',
        testId: 'file-open-terminal',
        icon: <SquareTerminal size={13} className="shrink-0 text-ink-tertiary" />,
        // 根目录没有父目录可去（parentPath 给 null），那就没什么可 cd 的
        disabled: !dir,
        onSelect: () => openInTerminalFor(browser.binding, dir),
      },
    ]
  }

  /** 空白区域的右键：目录级操作（新建文件 / 新建文件夹 / 刷新） */
  const blankMenu = (pane: PaneKey): MenuEntry[] => {
    const browser = latest.current.browsers[pane]
    return [
      {
        label: '新建文件',
        testId: 'blank-new-file',
        icon: <FilePlus size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => browser.createFile(),
      },
      {
        label: '新建文件夹',
        testId: 'blank-new-folder',
        icon: <FolderPlus size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => browser.mkdir(),
      },
      {
        label: '刷新',
        testId: 'blank-refresh',
        icon: <RefreshCw size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: () => void browser.refresh(),
      },
    ]
  }

  const bindBrowser = (pane: PaneKey, binding: PaneBinding) => {
    setBindings((prev) => {
      const next = [...prev] as [PaneBinding, PaneBinding]
      next[pane] = binding
      return next
    })
  }

  const renderPane = (pane: PaneKey) => {
    const browser = browsers[pane]
    const isLocal = browser.binding.kind === 'local'
    const entries = isLocal
      ? browser.entries
      : showHidden
        ? browser.entries
        : browser.entries.filter((e) => !e.name.startsWith('.'))
    return (
      <FilePane
        key={pane}
        side={isLocal ? 'local' : 'remote'}
        title={
          <BindingButton
            binding={browser.binding}
            onClick={(e) => {
              const at = menuAt(e)
              if (at) setMenu({ ...at, kind: 'bind', pane })
            }}
            className="flex min-w-0 max-w-40 items-center gap-0.5 truncate rounded px-1 py-0.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          />
        }
        path={browser.path}
        entries={sortEntries(entries)}
        sort={sort}
        onSort={toggleSort}
        loading={browser.loading}
        selected={browser.selected}
        onSelect={browser.setSelected}
        onActivate={(entry) => activate(pane, entry)}
        onNavigate={browser.navigate}
        onRefresh={() => void browser.refresh()}
        onMkdir={browser.mkdir}
        onDelete={browser.remove}
        onRename={browser.rename}
        onEdit={browser.openEditor}
        onTransfer={() => transferPicked(pane)}
        transferTitle={`把选中的项目${transferVerb(
          browser.binding,
          browsers[pane === 0 ? 1 : 0].binding,
        )}到对侧`}
        onRowMouseDown={beginDrag(pane)}
        onRowMenu={(e, entry) => {
          const at = menuAt(e)
          if (at) setMenu({ ...at, kind: 'file', pane, entry })
        }}
        onBlankMenu={(e) => {
          const at = menuAt(e)
          if (at) setMenu({ ...at, kind: 'blank', pane })
        }}
        dropActive={dropPane === pane}
        paneRef={(el) => {
          paneRefs.current[pane] = el
        }}
        toolbar={
          // 隐藏文件开关只给远程栏：Windows 本地栏没有点文件这套约定，加了也没意义
          !isLocal ? (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className={`transition-colors hover:text-ink ${showHidden ? '' : 'text-ink-tertiary'}`}
              title={showHidden ? '隐藏以点开头的文件' : '显示以点开头的文件'}
            >
              {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {renderPane(0)}
        <div className="w-px shrink-0 bg-hairline" />
        {renderPane(1)}
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
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'file'
              ? fileMenu(menu.pane, menu.entry)
              : menu.kind === 'blank'
                ? blankMenu(menu.pane)
                : bindingMenuItems(
                    latest.current.browsers[menu.pane].binding,
                    (b) => bindBrowser(menu.pane, b),
                  )
          }
        />
      )}
    </div>
  )
}
