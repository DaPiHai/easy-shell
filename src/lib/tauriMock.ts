/**
 * 浏览器里跑前端用的假 Tauri 后端。
 *
 * **只在 `vite --mode web` 下生效** —— vite.config.ts 会把 `@tauri-apps/api/core`
 * 别名到本文件。正常 dev / 打包路径完全不碰这里。
 *
 * 为什么需要它：Tauri 的窗口是原生 webview，playwright 之类的工具够不着，
 * UI 层（布局、主题、交互）就一直没法自动验证。有了这层假数据，
 * `npm run dev:web` 能在普通浏览器里把整个界面跑起来，截图就能看问题。
 */

// 只借类型：`import type` 编译后被完全擦除，不会和 api.ts 形成运行时循环
import type { TransferEvent } from './api'

// ---- 假数据 ----------------------------------------------------------------

const GROUPS = [
  { id: 'g-prod', name: '生产环境' },
  { id: 'g-intra', name: '内网' },
]

const HOSTS = [
  {
    id: 'h-1',
    name: 'web-01',
    address: '10.0.1.11',
    port: 22,
    username: 'deploy',
    groupId: 'g-prod',
    auth: { type: 'password' as const, password: '' },
  },
  {
    id: 'h-2',
    name: 'db-primary',
    address: '10.0.1.20',
    port: 22,
    username: 'root',
    groupId: 'g-prod',
    auth: { type: 'key' as const, privateKeyPath: 'C:\\Users\\hhdlj\\.ssh\\id_ed25519' },
  },
  {
    id: 'h-3',
    name: 'dev-box',
    address: '10.255.0.9',
    port: 2222,
    username: 'hhdlj',
    groupId: 'g-intra',
    auth: { type: 'password' as const, password: '' },
  },
  {
    id: 'h-4',
    name: '跳板机',
    address: '203.0.113.9',
    port: 22,
    username: 'ops',
    groupId: null,
    auth: { type: 'key' as const, privateKeyPath: 'C:\\Users\\hhdlj\\.ssh\\ops.pem' },
  },
  {
    id: 'h-5',
    name: '老交换机',
    address: '10.0.0.1',
    port: 22,
    username: 'admin',
    groupId: 'g-intra',
    auth: { type: 'password' as const, password: '' },
  },
]

/**
 * 只认已废弃算法的假设备。
 *
 * 不勾兼容模式连它必然失败（返回真实的 algorithms_unsupported 形状），
 * 勾了才放行 —— 这样老设备那条恢复路径在浏览器预览里也能整条跑通，
 * 不用真去借一台老交换机。
 */
const OLD_DEVICE = '10.0.0.1'

const SNIPPETS = [
  { id: 's-1', name: '看磁盘', command: 'df -h' },
  { id: 's-2', name: '实时日志', command: 'tail -f /var/log/app.log' },
  { id: 's-3', name: '内存占用 Top10', command: 'ps aux --sort=-%mem | head -10' },
]

const REMOTE_FILES = [
  // 带上点文件：隐藏文件开关要有东西可藏，预览里才看得出效果
  { name: '.ssh', path: '/home/hhdlj/.ssh', isDir: true, size: 0, modified: 1_784_500_000, mode: 'rwx------' },
  { name: '.bashrc', path: '/home/hhdlj/.bashrc', isDir: false, size: 3_772, modified: 1_784_400_000, mode: 'rw-r--r--' },
  { name: 'app.log', path: '/home/hhdlj/app.log', isDir: false, size: 2_411_724, modified: 1_785_000_000, mode: 'rw-r--r--' },
  { name: 'deploy.sh', path: '/home/hhdlj/deploy.sh', isDir: false, size: 1_842, modified: 1_784_900_000, mode: 'rwxr-xr-x' },
  { name: 'notes.md', path: '/home/hhdlj/notes.md', isDir: false, size: 6_310, modified: 1_784_800_000, mode: 'rw-r--r--' },
  { name: '下载', path: '/home/hhdlj/下载', isDir: true, size: 0, modified: 1_784_700_000, mode: 'rwxr-xr-x' },
  { name: 'src', path: '/home/hhdlj/src', isDir: true, size: 0, modified: 1_784_600_000, mode: 'rwxr-xr-x' },
]

const LOCAL_FILES = [
  { name: 'Desktop', path: 'C:\\Users\\hhdlj\\Desktop', isDir: true, size: 0, modified: 1_785_000_000, mode: 'drwxr-xr-x' },
  { name: 'Downloads', path: 'C:\\Users\\hhdlj\\Downloads', isDir: true, size: 0, modified: 1_785_000_000, mode: 'drwxr-xr-x' },
  { name: 'id_ed25519', path: 'C:\\Users\\hhdlj\\.ssh\\id_ed25519', isDir: false, size: 411, modified: 1_784_000_000, mode: '-rw-------' },
  { name: 'todo.txt', path: 'C:\\Users\\hhdlj\\todo.txt', isDir: false, size: 902, modified: 1_785_100_000, mode: '-rw-r--r--' },
]

const EDIT_CONTENT = `# 部署笔记

1. 先跑 \`./deploy.sh --dry-run\` 看改动
2. 确认无误再 \`--apply\`
3. 出问题回滚：\`git revert HEAD\`

> 记得先关掉 systemd 里的 health-check，否则会在滚动重启的时候误报。

| 环境 | 主机 | 端口 |
| --- | --- | --- |
| 生产 | 10.0.1.11 | 22 |
| 内网 | 10.255.0.9 | 2222 |
`

/**
 * 预览里要不要当成「已初始化」。
 *
 * 存在 localStorage 里而不是模块变量：真后端重置是把行删掉、刷新后依然是
 * 「未初始化」，用模块变量的话一刷新 mock 又说库是好的，重置这条链路在预览里
 * 就成了假象（第一次写就踩了这个坑）。
 */
const INIT_KEY = 'mockVaultInitialized'
const readInitialized = () => localStorage.getItem(INIT_KEY) !== 'false'
const setInitialized = (v: boolean) => localStorage.setItem(INIT_KEY, String(v))

/**
 * 预览里库有没有设主密码（对应真后端的 `nopass` 标记）。
 *
 * 要在预览里看「无密码」这条路，控制台敲一句
 * `localStorage.setItem('mockVaultNoPassword', 'true')` 再刷新即可。
 */
const NOPASS_KEY = 'mockVaultNoPassword'
const readNoPassword = () => localStorage.getItem(NOPASS_KEY) === 'true'
const setNoPassword = (v: boolean) => localStorage.setItem(NOPASS_KEY, String(v))

/**
 * 预览里库锁没锁。
 *
 * 以前 mock 的 `unlocked` 恒等于 `initialized`，于是**锁屏在预览里根本到不了** ——
 * 而「锁定」这条链路（收连接、清标签、无密码库的锁屏）恰恰是这轮改的东西。
 * 锁定状态同样得落在 localStorage 里，不然一刷新就又解锁了，等于没验。
 */
const LOCK_KEY = 'mockVaultLocked'
const readLocked = () => localStorage.getItem(LOCK_KEY) === 'true'
const setLocked = (v: boolean) => localStorage.setItem(LOCK_KEY, String(v))

/** 塞给 xterm 的假输出：带颜色、中文、emoji，顺便测宽字符对齐 */
const BANNER = [
  '\x1b[1;38;2;94;106;210m  easy-shell\x1b[0m \x1b[90m· mock 会话（浏览器预览）\x1b[0m\r\n',
  '\r\n',
  '\x1b[32mhhdlj@web-01\x1b[0m:\x1b[34m~\x1b[0m$ ls -l\r\n',
  'total 28\r\n',
  'drwxr-xr-x 2 hhdlj hhdlj 4096 Sep 14 20:11 \x1b[34m下载\x1b[0m\r\n',
  'drwxr-xr-x 5 hhdlj hhdlj 4096 Sep 14 19:02 \x1b[34msrc\x1b[0m\r\n',
  '-rw-r--r-- 1 hhdlj hhdlj 1842 Sep 14 18:47 deploy.sh\r\n',
  '-rw-r--r-- 1 hhdlj hhdlj 6310 Sep 14 18:30 notes.md\r\n',
  '\r\n',
  '\x1b[32mhhdlj@web-01\x1b[0m:\x1b[34m~\x1b[0m$ echo "宽字符对齐测试 🚀 中文" && df -h\r\n',
  '宽字符对齐测试 🚀 中文\r\n',
  'Filesystem      Size  Used Avail Use% Mounted on\r\n',
  'overlay          40G   18G   21G  47% /\r\n',
  'tmpfs            64M     0   64M   0% /dev\r\n',
  '\r\n',
  '\x1b[32mhhdlj@web-01\x1b[0m:\x1b[34m~\x1b[0m$ ',
].join('')

// ---- 假的 Channel ----------------------------------------------------------

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export class Channel<T> {
  onmessage: ((message: T) => void) | null = null

  /** 测试用：假后端往前端推消息 */
  emit(message: T) {
    this.onmessage?.(message)
  }
}

/** 往 shell 通道里灌一屏假输出，让终端不至于空着 */
function feedShell(channel: Channel<{ type: string; data?: string; message?: string }>) {
  setTimeout(() => channel.emit({ type: 'data', data: encodeUtf8Base64(BANNER) }), 200)
}

// ---- 假的 invoke -----------------------------------------------------------

const DELAY = 60

function later<T>(value: T, ms = DELAY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case 'vault_status': {
      const initialized = readInitialized()
      return later({
        initialized,
        unlocked: initialized && !readLocked(),
        noPassword: readNoPassword(),
      } as T)
    }
    case 'vault_setup':
      setInitialized(true)
      setNoPassword((args.password as string) === '')
      setLocked(false)
      return later(undefined as T)
    case 'vault_reset':
      setInitialized(false)
      setNoPassword(false)
      setLocked(false)
      return later(undefined as T)
    case 'vault_unlock':
      setLocked(false)
      return later(undefined as T)
    case 'vault_lock':
      setLocked(true)
      return later(undefined as T)
    case 'vault_change_password':
      setNoPassword((args.newPassword as string) === '')
      return later(undefined as T)

    case 'hosts_list':
      return later(HOSTS as T)
    case 'groups_list':
      return later(GROUPS as T)
    case 'hosts_save':
    case 'hosts_delete':
    case 'groups_save':
    case 'groups_delete':
      return later(undefined as T)

    case 'snippets_list':
      return later(SNIPPETS as T)
    case 'snippets_save':
    case 'snippets_delete':
      return later(undefined as T)

    case 'ssh_connect': {
      // 参数是 `{ config }`（见 api.ts 的 sshConnect），不是平铺的
      const cfg = (args.config ?? {}) as { host?: string; compat?: boolean }
      if (cfg.host === OLD_DEVICE && !cfg.compat) {
        return Promise.reject({
          kind: 'algorithms_unsupported',
          compatHint: true,
          message:
            '算法协商失败：双方没有共同的密钥交换算法。\n' +
            '服务端支持：diffie-hellman-group1-sha1\n' +
            '我们支持：curve25519-sha256, ecdh-sha2-nistp256, diffie-hellman-group14-sha256\n' +
            '这台设备可能比较老 —— 可以用兼容模式（放开 dh-group1/14-sha1 与 aes-cbc）再试一次。',
        }) as Promise<T>
      }
      return later('mock-session' as T)
    }
    case 'ssh_reconnect':
      return later(undefined as T)
    case 'ssh_open_shell': {
      const ch = args.onData as Channel<{ type: string; data?: string; message?: string }>
      feedShell(ch)
      return later(1 as T)
    }
    case 'ssh_input':
    case 'ssh_resize':
    case 'ssh_close':
    case 'ssh_close_channel':
      return later(undefined as T)

    case 'known_hosts_forget':
      // 真后端会从 known_hosts 里删掉这一行。预览里没有文件可删，
      // 但**必须显式返回**，否则落到 default 的 console.warn，
      // 「忘掉旧密钥并重连」按钮会静默地假装成功
      return later(undefined as T)

    case 'local_open': {
      const ch = args.onData as Channel<{ type: string; data?: string; message?: string }>
      feedShell(ch)
      return later(1 as T)
    }
    case 'local_input':
    case 'local_resize':
    case 'local_close':
      return later(undefined as T)

    case 'sftp_open':
      return later(1 as T)
    case 'sftp_pwd':
      return later('/home/hhdlj' as T)
    case 'sftp_list':
      return later(REMOTE_FILES as T)
    case 'sftp_close':
    case 'sftp_mkdir':
    case 'sftp_remove':
    case 'sftp_rename':
    case 'sftp_write_text':
      return later(undefined as T)
    case 'sftp_read_text':
      return later(EDIT_CONTENT as T)

    /**
     * 传输。之前这两个命令没有 case，落到 default 直接 resolve(undefined)，
     * 而 runTransfer 把「没报错」当成成功 —— 预览里传输会显示「完成但 0 字节」，
     * 是个会骗人的假象。现在分几步把进度推出去，进度条真的会动。
     */
    case 'sftp_download':
    case 'sftp_upload': {
      const progress = args.onProgress as Channel<TransferEvent> | undefined
      const total = 2_411_724
      // 选了「跳过」就演一遍跳过：队列里那个「跳过 N」的标记在预览里才看得到
      if (args.conflict === 'skip') {
        setTimeout(
          () =>
            progress?.emit({
              type: 'skip',
              name: String(args.remote ?? args.local ?? 'file'),
              reason: '目标已存在',
            }),
          DELAY * 2,
        )
      }
      for (const ratio of [0.25, 0.6, 1]) {
        setTimeout(
          () =>
            progress?.emit(
              ratio < 1
                ? { type: 'progress', transferred: Math.round(total * ratio), total }
                : { type: 'done', transferred: total },
            ),
          DELAY * (1 + ratio * 8),
        )
      }
      return later(undefined as T)
    }

    case 'local_list':
      return later(LOCAL_FILES as T)
    case 'local_home':
      return later('C:\\Users\\hhdlj' as T)
    case 'local_mkdir':
    case 'local_remove':
    case 'local_rename':
    case 'local_write_text':
      return later(undefined as T)
    case 'local_copy': {
      const n = Array.isArray(args.paths) ? (args.paths as string[]).length : 0
      return later(n as unknown as T)
    }
    case 'local_read_text':
      return later(EDIT_CONTENT as T)

    case 'tunnel_list':
      return later([] as T)
    case 'tunnel_start':
      return later(1 as T)
    case 'tunnel_stop':
      return later(undefined as T)

    default:
      console.warn(`[tauriMock] 没实现的命令: ${cmd}`, args)
      return later(undefined as T)
  }
}
