import { Channel, invoke } from '@tauri-apps/api/core'

export interface ConnectConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  /**
   * 兼容模式：额外接受 dh-group1/14-sha1 与 aes-cbc 等已废弃算法。
   * 只该在明确知道对面是老设备时开 —— 默认关，避免把所有连接都降级。
   */
  compat?: boolean
}

/**
 * 跟 Rust 侧 `MISMATCH_MARK` 对齐。
 * Tauri 一般会把 Err 原样反序列化成对象，但万一被压成 Display 出来的字符串，
 * 前端还能靠这个前缀认出"是主机密钥不匹配"，不至于退化成一句没救的红字。
 */
const MISMATCH_MARK = '__HOST_KEY_MISMATCH__'

export type ConnectFailure =
  | { kind: 'host_key_mismatch'; host: string; detail: string; message: string }
  | {
      kind: 'algorithms_unsupported'
      message: string
      /** true 表示换兼容模式再试有可能通；false 表示这台设备要的东西我们没有 */
      compatHint: boolean
    }
  | { kind: 'other'; message: string }

/**
 * 把 ssh_connect / ssh_reconnect 抛出来的东西规整成 ConnectFailure。
 *
 * 两种形态都要认：对象（正常路径）和带标记的字符串（兜底路径）。
 * 不然 `String(e)` 一个结构化错误只会得到 `[object Object]`。
 */
export function parseConnectError(e: unknown): ConnectFailure {
  if (typeof e === 'object' && e !== null) {
    const p = e as {
      kind?: string
      host?: string
      detail?: string
      message?: string
      compatHint?: unknown
    }
    if (p.kind === 'host_key_mismatch' && p.host && p.detail) {
      return {
        kind: 'host_key_mismatch',
        host: p.host,
        detail: p.detail,
        message: `主机 ${p.host} 的密钥与已记录的不符`,
      }
    }
    if (p.kind === 'algorithms_unsupported' && typeof p.message === 'string') {
      return {
        kind: 'algorithms_unsupported',
        message: p.message,
        compatHint: p.compatHint === true,
      }
    }
    if (typeof p.message === 'string') return { kind: 'other', message: p.message }
    return { kind: 'other', message: String(e) }
  }

  const text = String(e)
  if (text.startsWith(MISMATCH_MARK)) {
    const rest = text.slice(MISMATCH_MARK.length)
    const nl = rest.indexOf('\n')
    const host = (nl === -1 ? rest : rest.slice(0, nl)).trim()
    return {
      kind: 'host_key_mismatch',
      host,
      detail: nl === -1 ? '' : rest.slice(nl + 1),
      message: `主机 ${host} 的密钥与已记录的不符`,
    }
  }
  return { kind: 'other', message: text }
}

export function knownHostsForget(host: string): Promise<void> {
  return invoke<void>('known_hosts_forget', { host })
}

export type ShellEvent =
  | { type: 'data'; data: string }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export function sshConnect(config: ConnectConfig): Promise<string> {
  return invoke<string>('ssh_connect', { config })
}

export function sshReconnect(sessionId: string): Promise<void> {
  return invoke<void>('ssh_reconnect', { sessionId })
}

/**
 * 同一个会话的重连合并成一次。
 *
 * 分屏时左右两个终端共用同一个 sessionId，各重一次的话，后一次 ssh_reconnect
 * 会把前一次刚建好的 shell 通道一起清掉 —— 两边互相拆台，谁也活不下来。
 * 这里按 sessionId 去重，两边等同一个 promise，之后各自开自己的通道。
 */
const reconnecting = new Map<string, Promise<void>>()

export function reconnectSession(sessionId: string): Promise<void> {
  const existing = reconnecting.get(sessionId)
  if (existing) return existing
  const p = sshReconnect(sessionId).finally(() => reconnecting.delete(sessionId))
  reconnecting.set(sessionId, p)
  return p
}

export function sshOpenShell(
  sessionId: string,
  cols: number,
  rows: number,
  onData: Channel<ShellEvent>,
): Promise<number> {
  return invoke<number>('ssh_open_shell', { sessionId, cols, rows, onData })
}

export function sshInput(channelId: number, data: string): Promise<void> {
  return invoke<void>('ssh_input', { channelId, data })
}

export function sshResize(channelId: number, cols: number, rows: number): Promise<void> {
  return invoke<void>('ssh_resize', { channelId, cols, rows })
}

/**
 * 关掉整条 SSH 会话（连带它名下所有通道）。
 *
 * **只该在锁定密钥库时用它**（`store.lockVault` 统一收连接）。
 * 平时关标签只能用 `sshCloseChannel` —— 调这个会把共用同一条 SSH 的兄弟标签一起带死。
 */
export function sshClose(sessionId: string): Promise<void> {
  return invoke<void>('ssh_close', { sessionId })
}

/** 只关一个标签的 shell 通道，共用同一 SSH 的兄弟标签不受影响 */
export function sshCloseChannel(channelId: number): Promise<void> {
  return invoke<void>('ssh_close_channel', { channelId })
}

export type AuthRecord =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKeyPath: string; passphrase?: string | null }

export interface HostRecord {
  id: string
  name: string
  address: string
  port: number
  username: string
  groupId: string | null
  /** 兼容模式（老设备）。老库里没有这个字段，所以是可选的 */
  compat?: boolean
  auth: AuthRecord
}

export interface GroupRecord {
  id: string
  name: string
}

export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
}

export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status')
}

export function vaultSetup(password: string): Promise<void> {
  return invoke<void>('vault_setup', { password })
}

export function vaultUnlock(password: string): Promise<void> {
  return invoke<void>('vault_unlock', { password })
}

export function vaultLock(): Promise<void> {
  return invoke<void>('vault_lock')
}

export function hostsList(): Promise<HostRecord[]> {
  return invoke<HostRecord[]>('hosts_list')
}

export function hostsSave(host: HostRecord): Promise<void> {
  return invoke<void>('hosts_save', { host })
}

export function hostsDelete(id: string): Promise<void> {
  return invoke<void>('hosts_delete', { id })
}

export function groupsList(): Promise<GroupRecord[]> {
  return invoke<GroupRecord[]>('groups_list')
}

export function groupsSave(group: GroupRecord): Promise<void> {
  return invoke<void>('groups_save', { group })
}

export function groupsDelete(id: string): Promise<void> {
  return invoke<void>('groups_delete', { id })
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: number | null
  mode: string | null
}

export type TransferEvent =
  | { type: 'progress'; transferred: number; total: number }
  | { type: 'done'; transferred: number }
  | { type: 'error'; message: string }

export function sftpOpen(sessionId: string): Promise<number> {
  return invoke<number>('sftp_open', { sessionId })
}

export function sftpClose(sftpId: number): Promise<void> {
  return invoke<void>('sftp_close', { sftpId })
}

export function sftpList(sftpId: number, path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>('sftp_list', { sftpId, path })
}

export function sftpDownload(
  sftpId: number,
  remote: string,
  localDir: string,
  resume: boolean,
  onProgress: Channel<TransferEvent>,
): Promise<void> {
  return invoke<void>('sftp_download', { sftpId, remote, localDir, resume, onProgress })
}

export function sftpUpload(
  sftpId: number,
  local: string,
  remoteDir: string,
  resume: boolean,
  onProgress: Channel<TransferEvent>,
): Promise<void> {
  return invoke<void>('sftp_upload', { sftpId, local, remoteDir, resume, onProgress })
}

export function sftpPwd(sftpId: number): Promise<string> {
  return invoke<string>('sftp_pwd', { sftpId })
}

export function sftpMkdir(sftpId: number, path: string): Promise<void> {
  return invoke<void>('sftp_mkdir', { sftpId, path })
}

export function sftpRemove(sftpId: number, path: string, isDir: boolean): Promise<void> {
  return invoke<void>('sftp_remove', { sftpId, path, isDir })
}

export function sftpRename(sftpId: number, from: string, to: string): Promise<void> {
  return invoke<void>('sftp_rename', { sftpId, from, to })
}

export function localList(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>('local_list', { path })
}

export function localHome(): Promise<string> {
  return invoke<string>('local_home')
}

export function localMkdir(path: string): Promise<void> {
  return invoke<void>('local_mkdir', { path })
}

export function localRemove(path: string, isDir: boolean): Promise<void> {
  return invoke<void>('local_remove', { path, isDir })
}

export function localRename(from: string, to: string): Promise<void> {
  return invoke<void>('local_rename', { from, to })
}

/** 把系统里拖进来的文件/目录复制进 destDir。目标已存在会自动改名，不覆盖 */
export function localCopy(paths: string[], destDir: string): Promise<number> {
  return invoke<number>('local_copy', { paths, destDir })
}

export function sftpReadText(sftpId: number, path: string): Promise<string> {
  return invoke<string>('sftp_read_text', { sftpId, path })
}

export function sftpWriteText(sftpId: number, path: string, content: string): Promise<void> {
  return invoke<void>('sftp_write_text', { sftpId, path, content })
}

export function localReadText(path: string): Promise<string> {
  return invoke<string>('local_read_text', { path })
}

export function localWriteText(path: string, content: string): Promise<void> {
  return invoke<void>('local_write_text', { path, content })
}

/** 内置编辑器打开的目标。remote 走 sftp 通道，local 直接读写磁盘 */
export interface EditorTarget {
  side: 'local' | 'remote'
  path: string
  sftpId: number | null
}

/** 本地 Shell：Windows 走 ConPTY，Unix 走 forkpty */
export function localShellOpen(
  cols: number,
  rows: number,
  onData: Channel<ShellEvent>,
): Promise<number> {
  return invoke<number>('local_open', { cols, rows, onData })
}

export function localShellInput(shellId: number, data: string): Promise<void> {
  return invoke<void>('local_input', { shellId, data })
}

export function localShellResize(shellId: number, cols: number, rows: number): Promise<void> {
  return invoke<void>('local_resize', { shellId, cols, rows })
}

export function localShellClose(shellId: number): Promise<void> {
  return invoke<void>('local_close', { shellId })
}

export interface SnippetRecord {
  id: string
  name: string
  command: string
}

export function snippetsList(): Promise<SnippetRecord[]> {
  return invoke<SnippetRecord[]>('snippets_list')
}

export function snippetsSave(snippet: SnippetRecord): Promise<void> {
  return invoke<void>('snippets_save', { snippet })
}

export function snippetsDelete(id: string): Promise<void> {
  return invoke<void>('snippets_delete', { id })
}

export interface TunnelInfo {
  id: number
  listenPort: number
  remoteHost: string
  remotePort: number
}

export function tunnelStart(
  sessionId: string,
  listenPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<number> {
  return invoke<number>('tunnel_start', { sessionId, listenPort, remoteHost, remotePort })
}

export function tunnelStop(tunnelId: number): Promise<void> {
  return invoke<void>('tunnel_stop', { tunnelId })
}

export function tunnelList(): Promise<TunnelInfo[]> {
  return invoke<TunnelInfo[]>('tunnel_list')
}

/** 浏览器预览（dev:web）下有没有 Tauri 运行时。没有就不能调原生对话框 */
export function isDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export interface FileFilter {
  name: string
  extensions: string[]
}

/**
 * 开原生文件选择框挑单个文件。
 *
 * 动态 import 是刻意的：浏览器预览下根本加载不到插件模块，
 * 静态 import 会让整个前端在 dev:web 里直接崩。
 */
export async function pickFile(title: string, filters?: FileFilter[]): Promise<string | null> {
  if (!isDesktop()) return null
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ multiple: false, directory: false, title, filters })
    return typeof picked === 'string' && picked ? picked : null
  } catch (e) {
    console.warn('[easy-shell] 打开文件选择框失败:', e)
    return null
  }
}

export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
