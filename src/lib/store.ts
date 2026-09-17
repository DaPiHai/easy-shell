import { Channel } from '@tauri-apps/api/core'
import { create } from 'zustand'
import {
  type EditorTarget,
  type TransferEvent,
} from './api'
import {
  groupsDelete,
  groupsList,
  groupsSave,
  hostsDelete,
  hostsList,
  hostsSave,
  isDesktop,
  pickFile,
  sshClose,
  syncWindowTheme,
  vaultLock,
  vaultReset,
  vaultSetup,
  vaultStatus,
  vaultUnlock,
  type GroupRecord,
  type HostRecord,
} from './api'

/** 终端字号可调范围。再小就看不清，再大一个屏幕放不下几行 */
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 28

/** 终端默认字体栈。用户在设置里填了自定义字体就用他填的 */
export const DEFAULT_TERM_FONT =
  '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace'
export const MIN_LINE_HEIGHT = 1
export const MAX_LINE_HEIGHT = 2
export const MIN_SCROLLBACK = 500
export const MAX_SCROLLBACK = 100000
export const MIN_RETRY_ATTEMPTS = 0
export const MAX_RETRY_ATTEMPTS = 10
export const MIN_RETRY_DELAY = 1
export const MAX_RETRY_DELAY = 60

export type CursorStyle = 'bar' | 'block' | 'underline'

/** 从一个可能写坏的 localStorage 值里读数字，夹到范围内，读不到就给默认 */
function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    // 必须判 null：Number(null) 是 0，而 0 落在合法区间里（重连次数下限就是 0），
    // 不判的话"没存过"会被当成"用户设成 0"
    if (raw === null) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) return fallback
    return n
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式可能写不动，忽略 */
  }
}

export type Theme = 'dark' | 'light'
export type TabKind = 'terminal' | 'sftp' | 'local' | 'editor'

/**
 * 切主题的三处落点必须一起改：`data-theme` 属性（驱动 CSS 变量）、localStorage（下次启动）、
 * 原生窗口主题（标题栏）。
 *
 * 第三个最容易漏 —— 只改前两个的话，页面是浅色的、标题栏还是系统那条深色的。
 * 所有入口都走这里（状态栏按钮、设置面板、命令面板、恢复默认、启动时那次应用），
 * 以后加新入口也不会漏。
 */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  writeLocal('theme', theme)
  void syncWindowTheme(theme)
}

/** loading=检查中 setup=首次设置主密码 locked=待解锁 ready=已解锁 */
/**
 * 需要用户拍板才能继续的操作。见 store 里 `confirmPrompt` 的说明。
 *
 * 前两个 arm 是安全事项（连不上/降级），后面三个是通用的：
 * 危险操作确认、未保存改动确认、需要填一个值的输入框。
 * 全走同一套自绘弹窗，不用 `window.confirm/prompt` ——
 * WebView2 里 confirm 压根不渲染（直接当确认），prompt 弹的是原生框，跟整套视觉不搭。
 */
export type ConfirmPrompt =
  | { kind: 'host_key_mismatch'; host: string; detail: string; retry: () => void }
  | { kind: 'algo_compat'; message: string; retry: () => void }
  | {
      kind: 'confirm'
      title: string
      message: string
      /** 可选的等宽块，用来摊开路径、目标这类不该被文案淹没的信息 */
      detail?: string
      confirmLabel: string
      /** 危险操作：盾牌图标 + 红色按钮。默认是主色按钮 */
      danger?: boolean
      onConfirm: () => void
    }
  | {
      kind: 'unsaved'
      /** 标签名，用在文案里 */
      name: string
      /** 返回 null 表示保存成功；返回字符串是给用户看的错误，弹窗留在原地 */
      onSave: () => Promise<string | null>
      /** 关掉这个标签。「不保存关闭」与「保存成功后」共用同一个收尾 */
      close: () => void
    }
  | {
      kind: 'input'
      title: string
      label: string
      defaultValue?: string
      placeholder?: string
      confirmLabel: string
      onConfirm: (value: string) => void | Promise<void>
    }

export type VaultPhase = 'loading' | 'setup' | 'locked' | 'ready'

/** 编辑器标签交给 store 的"守卫"：关标签前问一句要不要保存 */
export interface EditorGuard {
  /** 有没保存的改动 */
  isDirty: () => boolean
  /** 存一次。返回 null 表示成功，字符串是给用户看的错误 */
  save: () => Promise<string | null>
}

export interface Tab {
  id: string
  title: string
  kind: TabKind
  sessionId?: string
  /**
   * 这条标签属于哪台主机（vault 里的 HostRecord.id）。
   * 用来在会话树上点「打开 SFTP」时找到已经建好的连接复用，
   * 而不是再拨一次 —— 二次连接意味着二次认证，还可能撞上服务端的连接数限制。
   * 快速连接（没存进 vault）的标签没有这个字段。
   */
  hostId?: string
  /** 是否左右分屏（同一会话开两个 shell 通道） */
  split?: boolean
  /** kind 为 editor 时的打开目标 */
  editorTarget?: EditorTarget
}

export type TransferStatus = 'active' | 'done' | 'error'

export interface TransferItem {
  id: string
  direction: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  status: TransferStatus
  /**
   * 这次传输里有多少个文件没动（目标已存在按策略跳过，或本地那份已是最新）。
   *
   * 单独记账而不是塞进 message：批量传一个目录时它是个计数，
   * 用户要的是「有几个没传」，不是一长串文件名。
   */
  skipped: number
  /** 最近一次跳过的文件名 + 原因，鼠标悬停时看 */
  skipHint?: string
  message?: string
}

interface AppState {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void

  connectOpen: boolean
  setConnectOpen: (open: boolean) => void

  tunnelOpen: boolean
  setTunnelOpen: (open: boolean) => void

  /**
   * 需要用户拍板才能继续的操作。
   *
   * 安全类（主机密钥变了 / 算法谈不拢）是**不该由程序替用户决定**的事，
   * `retry` 由调用方塞进来，因为"重试后是开终端还是开 SFTP"只有调用方知道。
   *
   * 通用类（confirm / unsaved / input）同样是"程序不该替用户拍板"：
   * 删东西之前问一句、有没保存的改动先问一句、要个名字先问一句。
   */
  confirmPrompt: ConfirmPrompt | null
  setConfirmPrompt: (prompt: ConfirmPrompt | null) => void

  snippetsOpen: boolean
  setSnippetsOpen: (open: boolean) => void

  phase: VaultPhase
  vaultError: string | null

  /** 全局轻提示，4 秒后自动消失 */
  error: string | null
  setError: (message: string | null) => void

  initVault: () => Promise<void>
  setupVault: (password: string) => Promise<void>
  unlockVault: (password: string) => Promise<void>
  /**
   * 锁定密钥库：收掉所有连接、清空标签。
   * `force` 是"确认过了"的重入标志 —— 有没保存的编辑器时它会先弹一次确认，
   * 用户点确认后再带着 force 调回来。
   */
  lockVault: (force?: boolean) => Promise<void>
  /** 清空密钥库回到「首次使用」。**不可撤销**，调用前必须让用户明确确认 */
  resetVault: () => Promise<void>

  hosts: HostRecord[]
  groups: GroupRecord[]
  refreshHosts: () => Promise<void>
  saveHost: (host: HostRecord) => Promise<void>
  removeHost: (id: string) => Promise<void>
  saveGroup: (group: GroupRecord) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  /** 让用户填分组名再创建。会话树与命令面板共用这一条 */
  promptNewGroup: () => void
  promptRenameGroup: (id: string, oldName: string) => void

  /**
   * 挑一个本地文件用内置编辑器打开。
   * 命令面板、侧栏工具区、空状态三个入口共用 —— 逻辑放这里就不用抄三遍。
   */
  openLocalFileDialog: () => Promise<void>

  collapsed: Record<string, boolean>
  toggleGroup: (id: string) => void

  tabs: Tab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  addTab: (tab: Omit<Tab, 'id'>) => string
  closeTab: (id: string) => void
  /**
   * 用户主动关标签都走这里：标签里有没保存的编辑器就先弹确认，
   * 否则直接关。程序自动关（本地 shell 退出、锁库清标签）仍用 closeTab 绕开它。
   */
  requestCloseTab: (id: string) => void
  toggleSplit: (id: string) => void

  /**
   * 编辑器标签注册的守卫。关标签时要同步问"脏不脏"，
   * 所以放 store 而不是 React state（和 terminalSinks 是同一个理由）。
   */
  editorGuards: Record<string, EditorGuard>
  registerEditorGuard: (tabId: string, guard: EditorGuard) => void
  unregisterEditorGuard: (tabId: string) => void

  /** 左右分屏的比例（左半 / 总宽），拖过分隔条就改这里，localStorage 持久化 */
  splitRatio: number
  setSplitRatio: (ratio: number) => void

  /**
   * 终端字号。13px 在 1080p 上刚好，高分屏上就偏小了 ——
   * 不给个调的口子只能干瞪眼，所以做成可调并持久化。
   */
  termFontSize: number
  setTermFontSize: (size: number) => void
  /** 按步长增减，delta 传 +1 / -1 */
  bumpTermFontSize: (delta: number) => void

  /** 终端字体族。空串表示用内置字体栈 */
  termFontFamily: string
  setTermFontFamily: (family: string) => void

  /** 行高倍数。改它要重新 fit（字符高度变了），和字号是一类 */
  termLineHeight: number
  setTermLineHeight: (lineHeight: number) => void

  termCursorStyle: CursorStyle
  setTermCursorStyle: (style: CursorStyle) => void

  /** 回滚缓冲行数。改它不用 refit */
  termScrollback: number
  setTermScrollback: (lines: number) => void

  /**
   * 断线自动重连策略。0 次 = 不自动重连，直接等人点 ↻。
   * 这两种环境（跳板机抖动 / 一次性命令机器）想要的策略完全相反，
   * 写死 3 次 / 2 秒总有一边别扭。
   */
  reconnectAttempts: number
  setReconnectAttempts: (times: number) => void
  reconnectDelaySec: number
  setReconnectDelaySec: (seconds: number) => void

  /** 传输默认是否续传。SFTP 面板上还能临时改，这里定的是新面板的初值 */
  transferResumeDefault: boolean
  setTransferResumeDefault: (on: boolean) => void

  /** 把上面这些设置全部恢复默认 */
  resetSettings: () => void

  /**
   * 每个终端标签注册一个"投喂函数"，命令片段面板靠它把命令送进对应终端。
   * 不放进 React state，避免每次注册都触发重渲染。
   */
  terminalSinks: Record<string, (text: string) => void>
  registerTerminalSink: (tabId: string, sink: (text: string) => void) => void
  unregisterTerminalSink: (tabId: string) => void

  /**
   * 每个终端标签注册的"手动重连"回调。
   *
   * 断线自动重试几次都失败之后，标签栏得给一个 ↻ 让用户再试一次 ——
   * 否则唯一的出路就是关掉标签重开，之前看的东西全没了。
   *
   * 用数组是因为分屏时一个标签挂着两个终端：点一次 ↻ 要能同时把两边都拉起来，
   * 只存一个的话后注册的会把先注册的顶掉。
   */
  reconnectSinks: Record<string, Array<() => void>>
  registerReconnect: (tabId: string, fn: () => void) => void
  unregisterReconnect: (tabId: string, fn: () => void) => void

  /** 自动重连已放弃、正等着用户手动介入的标签 */
  deadTabs: Record<string, true>
  setTabDead: (tabId: string, dead: boolean) => void

  /** 传输队列，最新在前 */
  transfers: TransferItem[]
  /** 跑一次传输并接管进度事件；结束后返回 true/false 表示成功 */
  runTransfer: (
    direction: 'upload' | 'download',
    name: string,
    run: (onProgress: Channel<TransferEvent>) => Promise<void>,
  ) => Promise<boolean>
  clearFinished: () => void
}

export const useApp = create<AppState>((set, get) => ({
  // 主题以前不持久化：设成浅色、重启回来又变深色。存在 localStorage 里
  theme: (() => {
    try {
      const v = localStorage.getItem('theme')
      return v === 'light' || v === 'dark' ? (v as Theme) : 'dark'
    } catch {
      return 'dark' as Theme
    }
  })(),
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      return { theme: next }
    }),
  setTheme: (theme) =>
    set(() => {
      applyTheme(theme)
      return { theme }
    }),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  connectOpen: false,
  setConnectOpen: (open) => set({ connectOpen: open }),

  tunnelOpen: false,
  setTunnelOpen: (open) => set({ tunnelOpen: open }),

  confirmPrompt: null,
  setConfirmPrompt: (prompt) => set({ confirmPrompt: prompt }),

  snippetsOpen: false,
  setSnippetsOpen: (open) => set({ snippetsOpen: open }),

  phase: 'loading',
  vaultError: null,

  error: null,
  setError: (message) => {
    set({ error: message })
    if (message) {
      setTimeout(() => set({ error: null }), 4000)
    }
  },

  initVault: async () => {
    try {
      const status = await vaultStatus()
      if (!status.initialized) {
        set({ phase: 'setup', vaultError: null })
        return
      }
      if (!status.unlocked) {
        set({ phase: 'locked', vaultError: null })
        return
      }
      await get().refreshHosts()
      set({ phase: 'ready' })
    } catch (e) {
      set({ phase: 'locked', vaultError: String(e) })
    }
  },

  setupVault: async (password) => {
    set({ vaultError: null })
    try {
      await vaultSetup(password)
      await get().refreshHosts()
      set({ phase: 'ready' })
    } catch (e) {
      set({ vaultError: String(e) })
      throw e
    }
  },

  unlockVault: async (password) => {
    set({ vaultError: null })
    try {
      await vaultUnlock(password)
      await get().refreshHosts()
      set({ phase: 'ready' })
    } catch (e) {
      set({ vaultError: String(e) })
      throw e
    }
  },

  /**
   * 锁定密钥库。
   *
   * 不只是「回到解锁界面」：锁了库还把已认证的连接留在后端，等于门锁了人还在屋里 ——
   * 会话在界面上消失了，服务端却仍占着槽位（sshd 默认 MaxSessions 10），
   * 何况它本来就是用这把现在已被清掉的钥匙开的。
   *
   * 标签卸载时各自会关掉自己的通道，但那一步只覆盖「有 shell 通道的」标签：
   * 连上了却没开出终端的会话（open_shell 失败、或只开了 SFTP 的）会留在后端，
   * 所以锁完再按 sessionId 逐条明确断开。
   *
   * 顺序是刻意的：先清标签再收连接。反过来的话，终端还挂着时会收到 closed 事件
   * 去走重连流程，凭空制造一次竞态。
   *
   * 标签里的编辑器如果还有没保存的改动，锁库会把它一起收掉 —— 先让用户确认一次。
   */
  lockVault: async (force = false) => {
    if (!force) {
      const dirty = Object.values(get().editorGuards).filter((g) => g.isDirty()).length
      if (dirty > 0) {
        set({
          confirmPrompt: {
            kind: 'confirm',
            danger: true,
            title: `还有 ${dirty} 个文件没保存`,
            message: '锁定密钥库会关掉所有标签，这些未保存的改动会一起丢掉。',
            confirmLabel: '仍然锁定',
            onConfirm: () => void get().lockVault(true),
          },
        })
        return
      }
    }
    const sessionIds = [
      ...new Set(
        get()
          .tabs.map((t) => t.sessionId)
          .filter((id): id is string => !!id),
      ),
    ]
    await vaultLock()
    set({ phase: 'locked', hosts: [], groups: [], tabs: [], activeTabId: null })
    for (const id of sessionIds) void sshClose(id)
  },

  /**
   * 清空密钥库，回到「设置主密码」。
   *
   * 不需要像 lockVault 那样收连接：这个入口只在解锁页上，能走到那里
   * 说明标签早被锁定时清干净了。hosts 也一并清掉，免得重置后界面上还留着旧主机。
   */
  resetVault: async () => {
    await vaultReset()
    set({
      phase: 'setup',
      vaultError: null,
      hosts: [],
      groups: [],
      tabs: [],
      activeTabId: null,
    })
  },

  hosts: [],
  groups: [],

  refreshHosts: async () => {
    const [hosts, groups] = await Promise.all([hostsList(), groupsList()])
    set({ hosts, groups })
  },

  saveHost: async (host) => {
    await hostsSave(host)
    await get().refreshHosts()
  },

  removeHost: async (id) => {
    await hostsDelete(id)
    await get().refreshHosts()
  },

  saveGroup: async (group) => {
    await groupsSave(group)
    await get().refreshHosts()
  },

  removeGroup: async (id) => {
    // 后端删分组时会把组里主机的 group_id 置空，主机本身不会跟着没
    await groupsDelete(id)
    await get().refreshHosts()
  },

  collapsed: {},
  toggleGroup: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),

  tabs: [],
  activeTabId: null,
  setActiveTab: (id) => set({ activeTabId: id }),

  addTab: (tab) => {
    const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    set((s) => ({ tabs: [...s.tabs, { ...tab, id }], activeTabId: id }))
    return id
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const nextActive =
        s.activeTabId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId: nextActive }
    }),

  requestCloseTab: (id) => {
    const s = get()
    const guard = s.editorGuards[id]
    // 只有编辑器标签会注册守卫；脏了就问一句，别让改动无声消失
    if (guard?.isDirty()) {
      const tab = s.tabs.find((t) => t.id === id)
      set({
        confirmPrompt: {
          kind: 'unsaved',
          name: tab?.title ?? '这个文件',
          onSave: guard.save,
          close: () => get().closeTab(id),
        },
      })
      return
    }
    get().closeTab(id)
  },

  editorGuards: {},
  registerEditorGuard: (tabId, guard) =>
    set((s) => ({ editorGuards: { ...s.editorGuards, [tabId]: guard } })),
  unregisterEditorGuard: (tabId) =>
    set((s) => {
      if (!s.editorGuards[tabId]) return {}
      const next = { ...s.editorGuards }
      delete next[tabId]
      return { editorGuards: next }
    }),

  toggleSplit: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, split: !t.split } : t)),
    })),

  // 分组的取名/改名放 store 而不是组件里：会话树和命令面板都要用，
  // 而且都得走自绘输入弹窗（window.prompt 在打包版里是原生框，观感对不上）
  promptNewGroup: () =>
    set({
      confirmPrompt: {
        kind: 'input',
        title: '新建分组',
        label: '分组名称',
        confirmLabel: '创建',
        onConfirm: (value) => {
          const name = value.trim()
          if (!name) return
          void get().saveGroup({ id: crypto.randomUUID(), name })
        },
      },
    }),

  promptRenameGroup: (id, oldName) =>
    set({
      confirmPrompt: {
        kind: 'input',
        title: '重命名分组',
        label: '分组名称',
        defaultValue: oldName,
        confirmLabel: '保存',
        onConfirm: (value) => {
          const name = value.trim()
          if (!name || name === oldName) return
          void get().saveGroup({ id, name })
        },
      },
    }),

  openLocalFileDialog: async () => {
    if (!isDesktop()) {
      // 浏览器预览里没有原生文件选择框。明说一句，别让点了没反应
      set({ error: '文件选择只在桌面版可用' })
      return
    }
    const path = await pickFile('打开文件')
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    get().addTab({
      title: name,
      kind: 'editor',
      editorTarget: { side: 'local', path, sftpId: null },
    })
  },

  // 从 localStorage 读上次拖出来的位置，找不到或者解析失败就 0.5
  splitRatio: (() => {
    try {
      const v = localStorage.getItem('splitRatio')
      const n = v ? Number(v) : NaN
      return Number.isFinite(n) && n >= 0.2 && n <= 0.8 ? n : 0.5
    } catch {
      return 0.5
    }
  })(),
  setSplitRatio: (ratio) => {
    // 拖得太极端两边就看不清了，夹一下
    const clamped = Math.min(0.8, Math.max(0.2, ratio))
    try {
      localStorage.setItem('splitRatio', String(clamped))
    } catch {
      /* 隐私模式可能写不动，忽略 */
    }
    set({ splitRatio: clamped })
  },

  termFontSize: (() => {
    try {
      const n = Number(localStorage.getItem('termFontSize'))
      return Number.isFinite(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE ? n : 13
    } catch {
      return 13
    }
  })(),
  setTermFontSize: (size) => {
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
    writeLocal('termFontSize', String(clamped))
    set({ termFontSize: clamped })
  },
  bumpTermFontSize: (delta) => get().setTermFontSize(get().termFontSize + delta),

  termFontFamily: (() => {
    try {
      return localStorage.getItem('termFontFamily') ?? ''
    } catch {
      return ''
    }
  })(),
  setTermFontFamily: (family) => {
    writeLocal('termFontFamily', family)
    set({ termFontFamily: family })
  },

  termLineHeight: readNumber('termLineHeight', 1.5, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT),
  setTermLineHeight: (lineHeight) => {
    const clamped = Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, lineHeight))
    writeLocal('termLineHeight', String(clamped))
    set({ termLineHeight: clamped })
  },

  termCursorStyle: (() => {
    try {
      const v = localStorage.getItem('termCursorStyle')
      return v === 'block' || v === 'underline' || v === 'bar' ? (v as CursorStyle) : 'bar'
    } catch {
      return 'bar' as CursorStyle
    }
  })(),
  setTermCursorStyle: (style) => {
    writeLocal('termCursorStyle', style)
    set({ termCursorStyle: style })
  },

  termScrollback: readNumber('termScrollback', 5000, MIN_SCROLLBACK, MAX_SCROLLBACK),
  setTermScrollback: (lines) => {
    const clamped = Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(lines)))
    writeLocal('termScrollback', String(clamped))
    set({ termScrollback: clamped })
  },

  reconnectAttempts: readNumber(
    'reconnectAttempts',
    3,
    MIN_RETRY_ATTEMPTS,
    MAX_RETRY_ATTEMPTS,
  ),
  setReconnectAttempts: (times) => {
    const clamped = Math.min(MAX_RETRY_ATTEMPTS, Math.max(MIN_RETRY_ATTEMPTS, Math.round(times)))
    writeLocal('reconnectAttempts', String(clamped))
    set({ reconnectAttempts: clamped })
  },
  reconnectDelaySec: readNumber('reconnectDelaySec', 2, MIN_RETRY_DELAY, MAX_RETRY_DELAY),
  setReconnectDelaySec: (seconds) => {
    const clamped = Math.min(MAX_RETRY_DELAY, Math.max(MIN_RETRY_DELAY, seconds))
    writeLocal('reconnectDelaySec', String(clamped))
    set({ reconnectDelaySec: clamped })
  },

  transferResumeDefault: (() => {
    try {
      return localStorage.getItem('transferResumeDefault') !== '0'
    } catch {
      return true
    }
  })(),
  setTransferResumeDefault: (on) => {
    writeLocal('transferResumeDefault', on ? '1' : '0')
    set({ transferResumeDefault: on })
  },

  resetSettings: () => {
    get().setTheme('dark')
    get().setTermFontSize(13)
    get().setTermFontFamily('')
    get().setTermLineHeight(1.5)
    get().setTermCursorStyle('bar')
    get().setTermScrollback(5000)
    get().setReconnectAttempts(3)
    get().setReconnectDelaySec(2)
    get().setTransferResumeDefault(true)
  },

  terminalSinks: {},
  registerTerminalSink: (tabId, sink) =>
    set((s) => ({ terminalSinks: { ...s.terminalSinks, [tabId]: sink } })),
  unregisterTerminalSink: (tabId) =>
    set((s) => {
      const next = { ...s.terminalSinks }
      delete next[tabId]
      return { terminalSinks: next }
    }),

  reconnectSinks: {},
  registerReconnect: (tabId, fn) =>
    set((s) => ({
      reconnectSinks: { ...s.reconnectSinks, [tabId]: [...(s.reconnectSinks[tabId] ?? []), fn] },
    })),
  unregisterReconnect: (tabId, fn) =>
    set((s) => {
      const rest = (s.reconnectSinks[tabId] ?? []).filter((f) => f !== fn)
      const next = { ...s.reconnectSinks }
      // 全撤了就把 key 删掉，别留一堆空数组
      if (rest.length) next[tabId] = rest
      else delete next[tabId]
      return { reconnectSinks: next }
    }),

  deadTabs: {},
  setTabDead: (tabId, dead) =>
    set((s) => {
      // 没变化就别造新对象，省得白触发一轮重渲染
      if (!!s.deadTabs[tabId] === dead) return s
      const next = { ...s.deadTabs }
      if (dead) next[tabId] = true
      else delete next[tabId]
      return { deadTabs: next }
    }),

  transfers: [],

  runTransfer: async (direction, name, run) => {
    const id = `xfer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const patch = (p: Partial<TransferItem>) =>
      set((s) => ({
        transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...p } : t)),
      }))

    set((s) => ({
      transfers: [
        {
          id,
          direction,
          name,
          transferred: 0,
          total: 0,
          status: 'active' as TransferStatus,
          skipped: 0,
        },
        ...s.transfers,
      ].slice(0, 50),
    }))

    const onProgress = new Channel<TransferEvent>()
    onProgress.onmessage = (event) => {
      if (event.type === 'progress') {
        patch({ transferred: event.transferred, total: event.total })
      } else if (event.type === 'done') {
        patch({ transferred: event.transferred, status: 'done' })
      } else if (event.type === 'skip') {
        // 跳过不是失败：只累计，不改状态。落到下面的 else 会被标成错误
        set((s) => ({
          transfers: s.transfers.map((t) =>
            t.id === id
              ? { ...t, skipped: t.skipped + 1, skipHint: `${event.name}（${event.reason}）` }
              : t,
          ),
        }))
      } else {
        patch({ status: 'error', message: event.message })
        get().setError(event.message)
      }
    }

    try {
      await run(onProgress)
      return true
    } catch (e) {
      const message = String(e)
      patch({ status: 'error', message })
      get().setError(message)
      return false
    }
  },

  clearFinished: () =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.status === 'active') })),
}))

// 持久化的主题要在首帧之前落到 documentElement 上：
// 放在组件 effect 里的话，浅色用户每次启动都会先闪一下深色。
// 窗口主题也一并定下来，否则会先看到系统主题的标题栏再跳成应用主题的
applyTheme(useApp.getState().theme)
