import { useCallback, useEffect, useState } from 'react'
import {
  localHome,
  localList,
  localMkdir,
  localRemove,
  localRename,
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
import { useApp } from '@/lib/store'
import { FilePane, type Side } from './FilePane'
import { TransferQueue } from './TransferQueue'

interface Props {
  sessionId: string
}

export function SftpPanel({ sessionId }: Props) {
  const setError = useApp((s) => s.setError)
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
  /** 断点续传开关。默认开：同名文件只补差量，传过的不用重来 */
  const [resume, setResume] = useState(true)

  // 开一个 sftp 子系统通道，挂在已有 SSH 会话上
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const id = await sftpOpen(sessionId)
        if (!alive) return
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
    else void upload([entry])
  }

  const download = async (entries: FileEntry[]) => {
    if (sftpId == null) return
    for (const entry of entries) {
      await runTransfer('download', entry.name, (ch) =>
        sftpDownload(sftpId, entry.path, localPath, resume, ch),
      )
    }
    void refreshLocal(localPath)
  }

  const upload = async (entries: FileEntry[]) => {
    if (sftpId == null) return
    for (const entry of entries) {
      await runTransfer('upload', entry.name, (ch) =>
        sftpUpload(sftpId, entry.path, remotePath, resume, ch),
      )
    }
    void refreshRemote(remotePath)
  }

  const handleDrop = (entries: FileEntry[], from: Side) => {
    if (from === 'local') void upload(entries)
    else void download(entries)
  }

  const mkdir = async (side: Side) => {
    const name = window.prompt('新目录名称')
    if (!name?.trim()) return
    const name2 = name.trim()
    if (side === 'local') {
      const sep = localPath.includes('\\') ? '\\' : '/'
      const target = `${localPath.replace(/[\\/]+$/, '')}${sep}${name2}`
      try {
        await localMkdir(target)
        void refreshLocal(localPath)
      } catch (e) {
        setError(String(e))
      }
    } else {
      if (sftpId == null) return
      const target = `${remotePath.replace(/\/+$/, '')}/${name2}`
      try {
        await sftpMkdir(sftpId, target)
        void refreshRemote(remotePath)
      } catch (e) {
        setError(String(e))
      }
    }
  }

  const remove = async (side: Side) => {
    const paths = selected[side]
    if (paths.length === 0) return
    if (!window.confirm(`删除选中的 ${paths.length} 项？目录会连同内容一起删掉，不可撤销。`)) return

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
  const rename = async (side: Side) => {
    const path = selected[side][0]
    if (!path) return
    const oldName = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    const name = window.prompt('新的名称', oldName)
    if (!name?.trim() || name.trim() === oldName) return

    const parent = path.slice(0, path.length - oldName.length)
    const target = `${parent}${name.trim()}`

    try {
      if (side === 'local') {
        await localRename(path, target)
        await refreshLocal(localPath)
      } else {
        if (sftpId == null) return
        await sftpRename(sftpId, path, target)
        await refreshRemote(remotePath)
      }
      setSelected((s) => ({ ...s, [side]: [] }))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <FilePane
          side="local"
          title="本地"
          path={localPath}
          entries={localEntries}
          loading={loading === 'local'}
          selected={selected.local}
          onSelect={(paths) => setSelected((s) => ({ ...s, local: paths }))}
          onActivate={(entry) => activate('local', entry)}
          onNavigate={(p) => navigate('local', p)}
          onRefresh={() => void refreshLocal(localPath)}
          onMkdir={() => void mkdir('local')}
          onDelete={() => void remove('local')}
          onRename={() => void rename('local')}
          onEdit={() => openEditor('local')}
          onDropEntries={handleDrop}
        />
        <div className="w-px shrink-0 bg-hairline" />
        <FilePane
          side="remote"
          title="远程"
          path={remotePath}
          entries={remoteEntries}
          loading={loading === 'remote'}
          selected={selected.remote}
          onSelect={(paths) => setSelected((s) => ({ ...s, remote: paths }))}
          onActivate={(entry) => activate('remote', entry)}
          onNavigate={(p) => navigate('remote', p)}
          onRefresh={() => void refreshRemote(remotePath)}
          onMkdir={() => void mkdir('remote')}
          onDelete={() => void remove('remote')}
          onRename={() => void rename('remote')}
          onEdit={() => openEditor('remote')}
          onDropEntries={handleDrop}
        />
      </div>
      <TransferQueue resume={resume} onToggleResume={() => setResume((v) => !v)} />
    </div>
  )
}
