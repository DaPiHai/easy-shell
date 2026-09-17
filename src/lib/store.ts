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
  vaultLock,
  vaultSetup,
  vaultStatus,
  vaultUnlock,
  type GroupRecord,
  type HostRecord,
} from './api'

/** 终端字号可调范围。再小就看不清，再大一个屏幕放不下几行 */
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 28

export type Theme = 'dark' | 'light'
export type TabKind = 'terminal' | 'sftp' | 'local' | 'editor'

/** loading=检查中 setup=首次设置主密码 locked=待解锁 ready=已解锁 */
/**
 * 需要用户拍板才能继续的连接失败。见 store 里 `confirmPrompt` 的说明。
 */
export type ConfirmPrompt =
  | { kind: 'host_key_mismatch'; host: string; detail: string; retry: () => void }
  | { kind: 'algo_compat'; message: string; retry: () => void }

export type VaultPhase = 'loading' | 'setup' | 'locked' | 'ready'

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
  message?: string
}

interface AppState {
  theme: Theme
  toggleTheme: () => void

  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void

  connectOpen: boolean
  setConnectOpen: (open: boolean) => void

  tunnelOpen: boolean
  setTunnelOpen: (open: boolean) => void

  /**
   * 需要用户拍板才能继续的连接失败。
   *
   * 两种情况都是**不该由程序替用户决定**的安全事项，所以共用同一个确认弹窗：
   * - 主机密钥变了：可能是中间人，也可能只是服务器重装了
   * - 算法谈不拢：要连上就得放开已废弃的算法
   *
   * `retry` 由调用方塞进来，因为"重试后是开终端还是开 SFTP"只有调用方知道。
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
  lockVault: () => Promise<void>

  hosts: HostRecord[]
  groups: GroupRecord[]
  refreshHosts: () => Promise<void>
  saveHost: (host: HostRecord) => Promise<void>
  removeHost: (id: string) => Promise<void>
  saveGroup: (group: GroupRecord) => Promise<void>
  removeGroup: (id: string) => Promise<void>

  collapsed: Record<string, boolean>
  toggleGroup: (id: string) => void

  tabs: Tab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  addTab: (tab: Omit<Tab, 'id'>) => string
  closeTab: (id: string) => void
  toggleSplit: (id: string) => void

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
  theme: 'dark',
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      return { theme: next }
    }),

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

  lockVault: async () => {
    await vaultLock()
    set({ phase: 'locked', hosts: [], groups: [], tabs: [], activeTabId: null })
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

  toggleSplit: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, split: !t.split } : t)),
    })),

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
    try {
      localStorage.setItem('termFontSize', String(clamped))
    } catch {
      /* 隐私模式可能写不动，忽略 */
    }
    set({ termFontSize: clamped })
  },
  bumpTermFontSize: (delta) => get().setTermFontSize(get().termFontSize + delta),

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
