import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  PencilLine,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import {
  isDesktop,
  localCopy,
  localHome,
  sftpDownload,
  sftpUpload,
  type ConflictPolicy,
  type FileEntry,
} from '@/lib/api'
import { useApp } from '@/lib/store'
import { copyQuietly } from '@/lib/clipboard'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'
import { FilePane, parentPath, type SortKey, type SortState } from '@/features/sftp/FilePane'
import { TransferQueue } from '@/features/sftp/TransferQueue'
import {
  BindingButton,
  bindingForSession,
  bindingMenuItems,
  openInTerminalFor,
  useFileBrowser,
  type PaneBinding,
} from '@/features/sftp/binding'

/**
 * 打开文件栏时默认绑谁：**当前聚焦终端的那条连接**；一个终端都没有就先看本机。
 * 打开即跟随、之后手动换（换绑菜单里有全部已连接会话）—— 切标签就自动跳走
 * 会打断"正在看这个目录"的状态。
 */
function followBinding(): PaneBinding {
  const s = useApp.getState()
  const pane = s.activePane()
  if (pane?.sessionId) return bindingForSession(pane.sessionId)
  return { kind: 'local' }
}

/**
 * 右侧文件栏的「文件」页：单栏文件浏览器，可绑「本机 或 任意一台已连接主机」。
 *
 * 双栏对拷在文件窗口（SFTP 标签）里做；这里管的是"随手看看/改改某台机器上的文件"。
 * 下载/复制需要一个目标目录，没有"对侧"可指，所以目标目录用输入框问（记住上次的）。
 */
export function FilesPage() {
  const setError = useApp((s) => s.setError)
  const setConfirmPrompt = useApp((s) => s.setConfirmPrompt)
  const runTransfer = useApp((s) => s.runTransfer)

  const [binding, setBinding] = useState<PaneBinding>(followBinding)
  const browser = useFileBrowser(binding)

  /** 断点续传 / 同名策略：与文件窗口同一套面板级选项 */
  const [resume, setResume] = useState(() => useApp.getState().transferResumeDefault)
  const [conflict, setConflict] = useState<ConflictPolicy>('overwrite')
  /** 下载/复制的目标目录，记住上次填的（初值 = 本机家目录） */
  const [targetDir, setTargetDir] = useState('')

  useEffect(() => {
    if (targetDir) return
    void localHome()
      .then(setTargetDir)
      .catch(() => setTargetDir('C:\\'))
  }, [targetDir])

  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const [showHidden, setShowHidden] = useState(true)
  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    )

  const sortEntries = (entries: FileEntry[]): FileEntry[] =>
    [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      const sign = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'name') return a.name.localeCompare(b.name) * sign
      if (sort.key === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * sign
      return ((a.modified ?? 0) - (b.modified ?? 0)) * sign
    })

  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: 'file'; entry: FileEntry }
    | { x: number; y: number; kind: 'blank' }
    | { x: number; y: number; kind: 'bind' }
    | null
  >(null)

  /** 双击行：目录进去，文件用内置编辑器打开（单栏没有"对侧"可传） */
  const activate = (entry: FileEntry) => {
    if (entry.isDir) browser.navigate(entry.path)
    else browser.openEditor(entry.path)
  }

  /**
   * 工具栏/菜单的「传出」：远程绑定 = 下载到本地目录，本地绑定 = 复制到目录。
   * 目标目录用输入框问（默认上次那个），单栏没有对侧可指。
   */
  const transferOut = () => {
    const chosen = browser.entries.filter((e) => browser.selected.includes(e.path))
    if (chosen.length === 0) return
    const remote = binding.kind === 'remote'
    setConfirmPrompt({
      kind: 'input',
      title: remote ? '下载到本地目录' : '复制到目录',
      label: '目标目录',
      defaultValue: targetDir,
      confirmLabel: remote ? '下载' : '复制',
      onConfirm: async (value) => {
        const dir = value.trim()
        if (!dir) return
        setTargetDir(dir)
        if (remote) {
          const id = browser.sftpId
          if (id == null) return
          for (const entry of chosen) {
            await runTransfer('download', entry.name, (ch) =>
              sftpDownload(id, entry.path, dir, resume, conflict, ch),
            )
          }
        } else {
          try {
            await localCopy(
              chosen.map((e) => e.path),
              dir,
            )
          } catch (e) {
            setError(`复制失败：${String(e)}`)
          }
        }
      },
    })
  }

  /* ---------------- 系统拖入（资源管理器 → 当前目录） ---------------- */

  const paneElRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ binding, browser, resume, conflict })
  latest.current = { binding, browser, resume, conflict }

  const dropExternal = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    const { binding: b, browser: br, resume: rs, conflict: cf } = latest.current
    if (b.kind === 'remote') {
      if (br.sftpId == null) return
      const id = br.sftpId
      const dir = br.path
      for (const p of paths) {
        const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p
        await runTransfer('upload', name, (ch) => sftpUpload(id, p, dir, rs, cf, ch))
      }
      void br.refresh()
    } else {
      try {
        await localCopy(paths, br.path)
        void br.refresh()
      } catch (e) {
        setError(`复制失败：${String(e)}`)
      }
    }
    // runTransfer 是 store 的稳定引用；面板状态一律走 latest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dropExternalRef = useRef(dropExternal)
  dropExternalRef.current = dropExternal

  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const stop = await getCurrentWindow().onDragDropEvent((event) => {
          const p = event.payload
          if (p.type === 'leave') return
          const scale = window.devicePixelRatio || 1
          const el = paneElRef.current
          if (!el) return
          const r = el.getBoundingClientRect()
          const x = p.position.x / scale
          const y = p.position.y / scale
          // 只落在本栏里才接；收起/被遮住的面板 rect 是 0，天然不会误收
          const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
          if (p.type === 'drop' && inside) void dropExternalRef.current(p.paths)
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
  }, [])

  /* ---------------- 菜单 ---------------- */

  const fileMenu = (entry: FileEntry): MenuEntry[] => {
    const picked = browser.selected
    const many = picked.length
    const only = many === 1
    const dir = entry.isDir ? entry.path : (parentPath(entry.path) ?? '')
    const isLocal = binding.kind === 'local'
    return [
      {
        label: entry.isDir ? '打开' : '用内置编辑器打开',
        testId: 'file-activate',
        hint: entry.isDir ? undefined : '双击',
        onSelect: () => activate(entry),
      },
      {
        label: isLocal ? `复制到目录${many > 1 ? `（${many} 项）` : ''}` : `下载到本地${many > 1 ? `（${many} 项）` : ''}`,
        testId: 'file-transfer',
        icon: <Download size={13} className="shrink-0 text-ink-tertiary" />,
        onSelect: transferOut,
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
        disabled: !dir,
        onSelect: () => openInTerminalFor(binding, dir),
      },
    ]
  }

  const blankMenu = (): MenuEntry[] => [
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

  const isLocal = binding.kind === 'local'
  const entries = isLocal
    ? browser.entries
    : showHidden
      ? browser.entries
      : browser.entries.filter((e) => !e.name.startsWith('.'))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilePane
        side={isLocal ? 'local' : 'remote'}
        title={
          <BindingButton
            binding={binding}
            onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
              const at = menuAt(e)
              if (at) setMenu({ ...at, kind: 'bind' })
            }}
            className="flex min-w-0 max-w-32 items-center gap-0.5 truncate rounded px-1 py-0.5 text-[11px] font-medium tracking-[0.4px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          />
        }
        path={browser.path}
        entries={sortEntries(entries)}
        sort={sort}
        onSort={toggleSort}
        loading={browser.loading}
        selected={browser.selected}
        onSelect={browser.setSelected}
        onActivate={activate}
        onNavigate={browser.navigate}
        onRefresh={() => void browser.refresh()}
        onMkdir={browser.mkdir}
        onDelete={browser.remove}
        onRename={browser.rename}
        onEdit={browser.openEditor}
        onTransfer={transferOut}
        transferTitle={
          isLocal ? '把选中的项目复制到指定目录' : '把选中的项目下载到本地指定目录'
        }
        onRowMouseDown={() => {
          // 单栏没有双栏互拖，行按下只用于选择
        }}
        onRowMenu={(e, entry) => {
          const at = menuAt(e)
          if (at) setMenu({ ...at, kind: 'file', entry })
        }}
        onBlankMenu={(e) => {
          const at = menuAt(e)
          if (at) setMenu({ ...at, kind: 'blank' })
        }}
        dropActive={false}
        paneRef={(el) => {
          paneElRef.current = el
        }}
        toolbar={
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
      <TransferQueue
        resume={resume}
        onToggleResume={() => setResume((v) => !v)}
        conflict={conflict}
        onConflictChange={setConflict}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'file'
              ? fileMenu(menu.entry)
              : menu.kind === 'blank'
                ? blankMenu()
                : bindingMenuItems(binding, (b) => setBinding(b))
          }
        />
      )}
    </div>
  )
}
