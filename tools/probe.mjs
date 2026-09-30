/**
 * 交互探针：用 headless Edge + CDP 在预览页上跑一段**真实鼠标操作**，把结果打出来。
 *
 * 为什么需要它：拖拽、菜单点选这类交互靠读代码推演不可靠 —— 到底哪一步没生效，
 * 只有真跑一遍才知道（M29 那个「松手没反应」就是这么定位的：临时日志打出来
 * `onUp {draggedTabId: null, plan: null}`，一眼看到是状态被提前清了）。
 * 本机没有 agent-browser（装它要下 ~500MB Chromium），但 Edge 在，CDP 用
 * Node 内置的 WebSocket 就能连，零依赖。
 *
 * 前置：另开一个终端跑 `npm run dev:web`（探针自己要连 1420 端口的预览页）。
 *
 * 用法：
 *   node tools/probe.mjs                # 所有场景
 *   node tools/probe.mjs drag           # 只跑「拖标签进终端窗口并分屏」
 *   node tools/probe.mjs newline        # 只跑「命令框里只有换行」
 *   node tools/probe.mjs tags           # 只跑「标签筛选 / 关键词过滤 / 编辑主机（含改分组）」
 *   node tools/probe.mjs menu           # 只跑「各处右键菜单 + 原生菜单拦截」
 *   node tools/probe.mjs connect        # 只跑「新建会话表单的状态清理」
 *   node tools/probe.mjs paste          # 只跑「粘贴次数」
 *   node tools/probe.mjs sidebar        # 只跑「收起会话侧栏」
 *   node tools/probe.mjs dropzone       # 只跑「多分屏拖拽落点 + 拖出来的形状」
 *   node tools/probe.mjs batchbar       # 只跑「本屏批量执行：拖高度 + 逐行运行」
 *   node tools/probe.mjs fonts          # 只跑「设置里的字体下拉框（清单/筛选/自定义栈）」
 *   node tools/probe.mjs rename         # 只跑「双击标签改名」
 *   node tools/probe.mjs sessiondrag    # 只跑「拖主机换分组」
 *   node tools/probe.mjs rightpanel     # 只跑「右侧文件栏 + 空白右键」
 *
 * 环境变量：EDGE_PATH / PROBE_PORT / PROBE_URL 可覆盖默认值。
 * 截图落在 `.workbuddy-ai/shots/`（该目录不进版本库）。
 *
 * 场景里用到的 DOM 约定（改 UI 时留意，探针断了多半是这里变了）：
 *   - 标签栏的标签：`div[title]` 且 class 含 `h-9` + `cursor-pointer`
 *   - 会话树主机行的可点区：`div[data-host-title]`
 *   - 本屏批量执行条：`[data-batch-bar]`、上沿把手 `[data-batch-resizer]`、
 *     「逐行」勾选框 `[data-batch-linebyline]`、每格的结果卡 `[data-batch-card]`
 *   - 会话树过滤框：`[data-host-filter]`；标签快捷条：`[data-tag-filter="<标签>"]`
 *   - 顶栏开关：`[data-sidebar-toggle]`（会话侧栏）、`[data-right-panel-toggle]`（右侧文件栏）
 *   - 右侧文件栏：`[data-right-panel]`、拖宽手柄 `[data-right-panel-resizer]`
 *   - 文件栏栏头换绑按钮：`[data-pane-binding]`；文件行菜单项 `data-menu-item`
 *     （`file-*` / `blank-new-file` / `blank-new-folder` / `blank-refresh`）
 *   - 主机行里的标签 chip：`[data-tag-chip]`；主机行编辑按钮：`[data-host-edit="<hostId>"]`
 *   - 分组块：`[data-group-id]`（未分组用空串），组里有几台 = 里面 `[data-host-edit]` 的个数
 *   - 终端窗口：`[data-pane-grid]`，格数 = 里面 `[data-pane-title]` 的个数
 *   - 设置面板的字体下拉框：`[data-font-picker]`（触发器）、`[data-font-panel]`、
 *     `[data-font-search]`、`[data-font-mono-only]`、`[data-font-list]`、
 *     `[data-font-option="<字体名>"]`、`[data-font-custom]` / `[data-font-custom-input]`
 *   - 投放高亮层：`div[aria-hidden]` 且 class 含 `border-dashed`
 *   - 右下角提示条：`div.fixed.bottom-8.right-4`
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(process.env.PROBE_PORT ?? 9333)
const PAGE = process.env.PROBE_URL ?? 'http://localhost:1420/'
const USER_DIR = `${process.env.TEMP ?? '/tmp'}/edge-probe`.replaceAll('\\', '/')
const SHOT_DIR = '.workbuddy-ai/shots'

/* ---------------- 极简 CDP 客户端 ---------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiting = new Map()
    this.logs = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      // 控制台与页面异常都收着：走了哪条分支、有没有报错，全靠它
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ''}`)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }

  /** 在页面里跑一段 JS 并把结果取回来（awaitPromise 让 Promise 也能等） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面里报错: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result.value
  }

  async shot(name) {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${SHOT_DIR}/${name}`, Buffer.from(r.data, 'base64'))
    return `${SHOT_DIR}/${name}`
  }

  /** 真实鼠标：按下 / 移动 / 抬起。buttons 必须显式带上，页面里读的就是它 */
  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    })
  }

  /**
   * 真实右键（右键菜单要用真事件）。
   *
   * `button: 'right'` 和 `buttons: 2` 两个都得给：浏览器是**看着 buttons 位**
   * 决定要不要派发 `contextmenu` 的，只给 button 的话页面里只会收到一个孤零零的
   * mouseup，菜单永远不开 —— 而那时你会以为是功能坏了。
   */
  async rightClick(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    })
  }

  /** 发一个 Esc（菜单靠它关；真实按键才能走到 window 的 keydown 监听） */
  async escape() {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
}

/* ---------------- 启动 / 收尾 ---------------- */

async function launch() {
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,820',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  let target = null
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) {
    proc.kill()
    throw new Error('Edge 的调试端口没起来')
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  return { cdp, proc }
}

/* ---------------- 场景 ---------------- */

/**
 * 页面里那些会用到的小工具（注入一次，后面直接调）。
 *
 * 注意：整段是**模板字符串**，里面不能出现反引号 —— 连注释里拿来当代码引号也不行，
 * 会把模板截断成语法错误，报的还是「Invalid left-hand side expression in postfix operation」
 * 这种完全看不出因果的话（被自己坑过一次）。要用引号就老实写引号。
 * 正则也留神：反斜杠会被模板字符串先吃掉一层，`\d` 到了页面里就成了 `d`，
 * 报的是「missing ) after argument list」（这条也踩过），所以正则一律写双反斜杠。
 */
const HELPERS = `
window.__probe = {
  /** 标签栏里的标签（标题 + 中点坐标） */
  tabs() {
    return [...document.querySelectorAll('div[title]')]
      .filter((el) => el.className.includes('h-9') && el.className.includes('cursor-pointer'))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { title: el.getAttribute('title'), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
      })
  },
  /** 会话树里的主机行 */
  hosts() {
    return [...document.querySelectorAll('div[data-host-title]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { text: el.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
  },
  /** 每个终端窗口的范围与格数 */
  grids() {
    return [...document.querySelectorAll('[data-pane-grid]')].map((el) => {
      const r = el.getBoundingClientRect()
      const hidden = el.closest('.hidden') !== null
      return {
        tabId: el.getAttribute('data-pane-grid'),
        hidden,
        cells: el.querySelectorAll('[data-pane-title]').length,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      }
    })
  },
  /** 有几块"投放高亮"覆盖层，各自的位置（用来验证只高亮该高亮的那半边） */
  highlights() {
    return [...document.querySelectorAll('div[aria-hidden]')]
      .filter((el) => el.className.includes('border-dashed'))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      })
  },
  ghost() {
    const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('fixed') && d.className.includes('z-50') && d.textContent.includes('松手'))
    return el ? { text: el.textContent, rect: el.getBoundingClientRect().toJSON() } : null
  },
  /** 会话树里当前**可见**的主机行文字（过滤生效后剩几行，看它） */
  hostsVisible() {
    return [...document.querySelectorAll('div[data-host-title]')].map((el) => el.textContent)
  },
  /** 顶部标签快捷条上的标签 */
  tagBar() {
    return [...document.querySelectorAll('[data-tag-filter]')].map((el) => el.getAttribute('data-tag-filter'))
  },
  /** 主机行里那些标签 chip 的文字 */
  rowTags() {
    return [...document.querySelectorAll('[data-tag-chip]')].map((el) => el.textContent)
  },
  /** 表单里所有输入框的当前值（编辑主机时用来看有没有预填） */
  inputValues() {
    return [...document.querySelectorAll('input')].map((el) => el.value)
  },
  /** 每个分组里有几行主机（按 data-group-id 数，空串那个是「未分组」） */
  groupCounts() {
    return [...document.querySelectorAll('[data-group-id]')].map((el) => ({
      group: el.getAttribute('data-group-id'),
      hosts: el.querySelectorAll('[data-host-edit]').length,
    }))
  },
  /** 所有"问号"提示的文案（说明改挂在 hover 上了，正文里应该看不到） */
  hints() {
    return [...document.querySelectorAll('[aria-label][title]')]
      .filter((el) => el.textContent.trim() === '')
      .map((el) => el.getAttribute('title'))
  },

  /**
   * 当前打开的右键菜单（没开返回 null）。
   *
   * 只读**第一层**的直接子元素：分隔线是 div、展开的子菜单又是个 [role=menu] 的 div，
   * 三种东西要分开认，不然断言写不准。
   */
  menu() {
    const read = (el) =>
      [...el.children].map((c) => {
        if (c.getAttribute('role') === 'menu') return { submenu: read(c) }
        if (c.tagName !== 'BUTTON') return { sep: true }
        const r = c.getBoundingClientRect()
        return {
          id: c.getAttribute('data-menu-item'),
          text: (c.querySelector('span') ?? c).textContent.trim(),
          disabled: c.disabled,
          checked: !!c.querySelector('svg.lucide-check'),
          hasSub: !!c.querySelector('svg.lucide-chevron-right'),
          x: r.left + 24,
          y: r.top + r.height / 2,
        }
      })
    const root = document.querySelector('[role="menu"]')
    return root ? read(root) : null
  },
  /** 菜单项的 id 列表，拍平了好断言（--- 是分隔线、>sub: 后面跟子菜单） */
  menuIds() {
    const m = window.__probe.menu()
    if (!m) return null
    // 这里**不能用模板字符串**：整段 HELPERS 本身就是模板字符串，反引号会把它截断
    return m.map((e) => {
      if (e.submenu) return '>sub:' + e.submenu.map((s) => s.id).join(',')
      if (e.sep) return '---'
      return e.id + (e.disabled ? '(禁用)' : '')
    })
  },
  /**
   * 开始记录每一次 contextmenu 有没有被应用拦下。
   *
   * 监听挂在 window 上、加在应用自己的处理器**之后**，所以跑到我们时
   * defaultPrevented 才有意义 —— 这是「原生菜单被屏蔽了没」唯一能自动验的方式
   * （合成事件不触发浏览器默认行为，拦没拦都看不出来）。
   */
  watchCtx() {
    window.__ctxLog = []
    if (!window.__ctxWatched) {
      window.__ctxWatched = true
      window.addEventListener('contextmenu', (e) => {
        window.__ctxLog.push({ prevented: e.defaultPrevented, tag: e.target.tagName })
      })
    }
    return 'watching'
  },
  ctxLog() {
    return window.__ctxLog ?? []
  },
  clearCtxLog() {
    window.__ctxLog = []
    return 'cleared'
  },
  /** SFTP 两栏里的文件行（size 是 — 的那行是目录） */
  fileRows() {
    return [...document.querySelectorAll('table tbody tr')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        name: el.querySelector('td')?.textContent?.trim() ?? '',
        size: el.children[1]?.textContent?.trim() ?? '',
        x: r.left + 40,
        y: r.top + r.height / 2,
      }
    })
  },
  /** CodeMirror 编辑区里一块可以右键的地方 */
  editorBox() {
    const el = document.querySelector('.cm-editor')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + 24 }
  },
  /**
   * 给 placeholder 里含某段文字的那个受控输入框塞值。
   *
   * 走原生 setter + input 事件：Input.insertText 和直接改 el.value 都绕过 React 的
   * 受控更新，界面看着变了、React 那边还是旧值（这条踩过）。
   */
  fill(placeholderPart, text) {
    const el = [...document.querySelectorAll('input')].find((i) =>
      i.placeholder.includes(placeholderPart),
    )
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  },
  /** 表单里每个输入框的 placeholder 与当前值 */
  dialogInputs() {
    return [...document.querySelectorAll('input')].map((i) => ({
      ph: i.placeholder,
      value: i.value,
    }))
  },
  /** 「新建会话 / 编辑主机」对话框的标题（它靠 editingHostId 切形态） */
  dialogTitle() {
    const el = [...document.querySelectorAll('span')].find((s) =>
      ['新建会话', '编辑主机', '连接这一格'].includes(s.textContent.trim()),
    )
    return el ? el.textContent.trim() : null
  },
  /** 文本完全匹配的按钮的中点坐标（找不到返回 null） */
  buttonBox(text) {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  },
  /**
   * 关键容器的尺寸，用来查"黑屏 / 布局塌陷"这类问题。
   *
   * docScroll 比 inner 大就说明整页被内容撑破了 —— 那时标题栏会被顶出可视区，
   * 看起来就是"一片黑只剩窗口边框"。
   */
  layout() {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: Math.round(r.top),
        left: Math.round(r.left),
      }
    }
    return {
      inner: [window.innerWidth, window.innerHeight],
      docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      root: box('#root'),
      aside: box('aside'),
      main: box('main'),
      tabbar: box('main > div'),
      grid: box('[data-pane-grid]'),
      xterm: box('.xterm'),
      status: box('footer'),
    }
  },
  /** 当前**可见**那个终端窗口里每一格的矩形（按格子顺序） */
  cells() {
    const grid = [...document.querySelectorAll('[data-pane-grid]')].find(
      (g) => !g.closest('.hidden'),
    )
    if (!grid) return []
    return [...grid.querySelectorAll('[data-pane-title]')].map((t) => {
      const cell = t.closest('[style]')
      const r = cell.getBoundingClientRect()
      return {
        title: t.textContent,
        left: Math.round(r.left),
        top: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    })
  },
  /**
   * 开始数"粘贴这件事发生了几次"。
   *
   * 两条独立的插入路径要分开数：
   *  - readText 调用次数 = 我们自己的 Ctrl+Shift+V 处理（读剪贴板 → term.paste）
   *  - paste 事件次数 = 浏览器原生粘贴（Chromium 把 Ctrl+Shift+V 当"粘贴为纯文本"），
   *    事件落到 xterm 藏的 textarea 上，xterm 自己也会贴一次
   * 内容到底发出去几遍看 window.__shellLog（mock 记的）。
   */
  watchPaste() {
    window.__readText = 0
    window.__pasteEvents = 0
    if (!window.__pasteWatched) {
      window.__pasteWatched = true
      const orig = navigator.clipboard.readText.bind(navigator.clipboard)
      navigator.clipboard.readText = function () {
        window.__readText += 1
        return orig()
      }
      document.addEventListener(
        'paste',
        () => {
          window.__pasteEvents += 1
        },
        true,
      )
    }
    return 'watching'
  },
  pasteStats() {
    return { readText: window.__readText, pasteEvents: window.__pasteEvents }
  },
  /** mock 记下的终端输入原文（预览里唯一能"看见发出去什么"的地方） */
  shellLog() {
    return window.__shellLog
  },
  clearShellLog() {
    window.__shellLog.length = 0
    return 'cleared'
  },
  /** 现在焦点在谁身上（键盘事件发给谁） */
  activeEl() {
    const el = document.activeElement
    if (!el) return null
    return el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '')
  },
  /** 「本屏批量执行」条：高度、上边缘把手的坐标、展开没 */
  batchBar() {
    const el = document.querySelector('[data-batch-bar]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const grip = el.querySelector('[data-batch-resizer]')
    const g = grip ? grip.getBoundingClientRect() : null
    return {
      h: Math.round(r.height),
      top: Math.round(r.top),
      gripX: g ? Math.round(g.left + g.width / 2) : null,
      gripY: g ? Math.round(g.top + g.height / 2) : null,
      open: !!el.querySelector('textarea'),
    }
  },
  /** 批量执行每格一张结果卡：标题 + 全文（逐行的状态就在里面） */
  batchCards() {
    return [...document.querySelectorAll('[data-batch-card]')].map((el) => ({
      title: el.getAttribute('data-batch-card'),
      text: el.textContent,
    }))
  },
  /** 一批结果卡里某段文字出现了几次（判"整段跑一次"还是"按行跑了 N 次"） */
  countInCards(needle) {
    return [...document.querySelectorAll('[data-batch-card]')]
      .map((el) => el.textContent.split(needle).length - 1)
      .reduce((a, b) => a + b, 0)
  },
  /** mock 记下的 ssh_exec 命令原文（一次调用一条）：逐行 = N 条，整段 = 1 条 */
  execLog() {
    return window.__execLog
  },
  clearExecLog() {
    window.__execLog.length = 0
    return 'cleared'
  },
  /**
   * 往批量执行那个 textarea 塞多行命令（React 受控 → 原生 setter + input 事件）。
   *
   * 选择器必须**限定在这条栏里**：xterm 自己也藏着一个 textarea（helper），
   * 而它在 DOM 里更靠前 —— 直接 querySelector('textarea') 抓到的是它，
   * 命令写进去静默消失，表现成"点了执行什么都没发生"。
   */
  fillBatch(text) {
    const el = document.querySelector('[data-batch-bar] textarea')
    if (!el) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  },
  /** 当前可见那一屏里的分割线（拖比例的那几条）：自定义排布也该有 */
  separators() {
    const grid = [...document.querySelectorAll('[data-pane-grid]')].find((g) => !g.closest('.hidden'))
    if (!grid) return []
    return [...grid.querySelectorAll('[role=separator]')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        axis: el.getAttribute('aria-orientation') === 'vertical' ? 'col' : 'row',
        left: Math.round(r.left),
        top: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      }
    })
  },
  /** 字体下拉框：触发器上写的名字、面板开没开、列出哪些字体、勾的是哪个 */
  fontPicker() {
    const trigger = document.querySelector('[data-font-picker]')
    const panel = document.querySelector('[data-font-panel]')
    const opts = [...document.querySelectorAll('[data-font-option]')]
    return {
      trigger: trigger ? trigger.textContent : null,
      open: !!panel,
      options: opts.map((el) => el.getAttribute('data-font-option')),
      checked: opts
        .filter((el) => el.querySelector('svg.lucide-check'))
        .map((el) => el.getAttribute('data-font-option')),
      monoOnly: panel ? panel.querySelector('[data-font-mono-only]').getAttribute('aria-pressed') : null,
      countText: panel ? (panel.textContent.match(/\\d+ \\/ \\d+ 个字体/) || [''])[0] : '',
    }
  },
  /**
   * 候选行的名字是不是真用它自己的字体画的。
   *
   * 无效的 font-family（比如多词族名不加引号）浏览器会整条丢掉、退回继承的字体，
   * 所以这里读计算值：里头必须出现这个族名。
   */
  fontOptionCss(label) {
    const el = document.querySelector('[data-font-option="' + label + '"] span')
    return el ? getComputedStyle(el).fontFamily : null
  },
  /**
   * 终端字符格子的物理痕迹：xterm 按当前字体量出格子尺寸，
   * 字体一换这个数字就变（这是"字体真作用到终端上了"唯一的可观察点 ——
   * 画布渲染器不在 DOM 里写 font-family，ctx.font 也被 save/restore 复位了）。
   */
  termMetrics() {
    const canvases = [...document.querySelectorAll('.xterm canvas')]
    const atlas = canvases[canvases.length - 1]
    const screen = document.querySelector('.xterm-screen')
    return {
      canvases: canvases.length,
      atlas: atlas ? [atlas.width, atlas.height] : null,
      screen: screen ? screen.getAttribute('style') : null,
    }
  },
}
'injected'
`

/** 轮询等页面里某个条件成立（SPA 首屏、解锁、终端挂载都有先后） */
async function waitFor(cdp, expr, label, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cdp.eval(expr)) return
    await sleep(200)
  }
  throw new Error(`等不到：${label}（页面文本：${(await cdp.eval('document.body.innerText')).slice(0, 300)}）`)
}

/** 拿选择器对应的中点坐标，找不到就报错（比静默点空地方好查） */
async function boxOf(cdp, sel) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!box) throw new Error(`找不到元素：${sel}`)
  return box
}

/** 真鼠标点一下某个选择器 */
async function clickSel(cdp, sel) {
  const box = await boxOf(cdp, sel)
  await cdp.mouse('mousePressed', box.x, box.y)
  await cdp.mouse('mouseReleased', box.x, box.y)
  return box
}

/**
 * 先滚进可视区再点。
 *
 * 设置面板的内容区是滚动的，字体那一行在下面 —— 不滚的话 `getBoundingClientRect()`
 * 给的坐标落在面板外面（那一层正好是"点一下就关面板"的遮罩），表现成
 * 「点了没反应，面板还关了」。列表内部的滚动条 `scrollIntoView` 也一起管。
 */
async function clickSelScrolled(cdp, sel) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!box) throw new Error(`找不到元素：${sel}`)
  await cdp.mouse('mousePressed', box.x, box.y)
  await cdp.mouse('mouseReleased', box.x, box.y)
  return box
}

/**
 * 往受控输入框里塞值。
 *
 * 必须走**原生 setter + input 事件**：`Input.insertText` 和直接改 `el.value`
 * 都绕过了 React 的受控更新，界面看着变了、React 那边还是旧值。
 */
async function typeInto(cdp, sel, text) {
  return cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'no-element'
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
}

async function scenarioDragTab(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)

  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  // 开两个终端标签
  const hosts = await cdp.eval('__probe.hosts()')
  console.log('会话树主机:', hosts.length, hosts.map((h) => h.text).join(' | '))
  await cdp.mouse('mousePressed', hosts[0].x, hosts[0].y)
  await cdp.mouse('mouseReleased', hosts[0].x, hosts[0].y)
  await sleep(800)
  await cdp.mouse('mousePressed', hosts[1].x, hosts[1].y)
  await cdp.mouse('mouseReleased', hosts[1].x, hosts[1].y)
  await waitFor(cdp, '__probe.tabs().length >= 2', '两个标签')

  const tabs = await cdp.eval('__probe.tabs()')
  console.log('标签:', JSON.stringify(tabs))
  await cdp.shot('probe-1-two-tabs.png')

  const grids = await cdp.eval('__probe.grids()')
  console.log('窗口:', JSON.stringify(grids))

  // 把第一个标签拖到第二个窗口的下半部
  const src = tabs[0]
  const target = grids.find((g) => !g.hidden)
  const dropX = target.x
  const dropY = target.bottom - (target.bottom - target.top) * 0.25

  await cdp.mouse('mousePressed', src.x, src.y)
  await sleep(60)
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12
    await cdp.mouse('mouseMoved', src.x + (dropX - src.x) * t, src.y + (dropY - src.y) * t)
    await sleep(40)
  }
  await sleep(200)
  console.log('拖到一半时的浮签:', JSON.stringify(await cdp.eval('__probe.ghost()')))
  console.log('高亮层:', JSON.stringify(await cdp.eval('__probe.highlights()')))
  console.log('此刻窗口:', JSON.stringify(await cdp.eval('__probe.grids()')))
  await cdp.shot('probe-2-hover.png')

  await cdp.mouse('mouseReleased', dropX, dropY, { buttons: 0 })
  await sleep(1500)
  console.log('松手后窗口:', JSON.stringify(await cdp.eval('__probe.grids()')))
  console.log('松手后标签:', JSON.stringify(await cdp.eval('__probe.tabs()')))
  await cdp.shot('probe-3-after-drop.png')

  // 顺手验证「格子改名」那个按钮：双击用不了（标题的单击已经被换主机占用），
  // 所以它是明摆着的铅笔按钮 —— 这里确认它真的能改名
  const paneIds = await cdp.eval(
    `[...document.querySelectorAll('[data-pane-rename]')].map((e) => e.getAttribute('data-pane-rename'))`,
  )
  console.log('可改名的格子:', JSON.stringify(paneIds))
  if (paneIds.length < 2) throw new Error('分屏之后应该有 2 个格子可改名')
  await clickSel(cdp, `[data-pane-rename="${paneIds[1]}"]`)
  await sleep(250)
  await cdp.eval(`(() => {
    // 改名输入框就长在标题条的 data-pane-action 里面（外面那个是筛选框，别点错）
    const el = document.querySelector('[data-pane-action] input')
    if (!el) return 'no-input'
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '第二格')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  console.log(
    '改完之后各格的标题:',
    JSON.stringify(
      await cdp.eval(`[...document.querySelectorAll('[data-pane-title]')].map((e) => e.textContent)`),
    ),
  )
  await cdp.shot('probe-3b-pane-rename.png')

  console.log('\n--- 页面控制台 ---')
  for (const l of cdp.logs.slice(-40)) console.log(l)
}

/** 只有换行的命令应该也能发出去（曾经的 bug：trim 后判空 → 被拦下） */

/**
 * 场景：拖主机换分组。
 *
 * 曾经用 HTML5 拖拽（draggable + onDragOver/onDrop），而 `tauri.conf.json` 开着
 * `dragDropEnabled` —— wry 的 IDropTarget 会让内部 HTML5 拖拽在 Windows 打包版
 * 整体失效，拖了没有任何反应（用户报的问题 1）。现在照 PaneGrid 那套用鼠标事件
 * 自绘，这条探针钉住三件事：拖着走时有说清去向的浮签、松手真的换了分组、
 * 拖完不会误触发「点击连接」（浏览器会在拖完补一次 click）。
 */
async function scenarioSessionDrag(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  const counts = () =>
    cdp.eval(`[...document.querySelectorAll('[data-group-id]')].map((b) => ({
      group: b.getAttribute('data-group-id'),
      hosts: b.querySelectorAll('[data-host-edit]').length,
    }))`)
  console.log('拖之前各组行数:', JSON.stringify(await counts()))

  /** 未分组里那台的标题中心，和「内网」分组行的中心 */
  const from = await cdp.eval(`(() => {
    const r = document.querySelector('[data-group-id=""] [data-host-title]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const to = await cdp.eval(`(() => {
    const r = document.querySelector('[data-group-id="g-intra"] > div').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)

  const tabsBefore = (await cdp.eval('__probe.tabs()')).length

  await cdp.mouse('mousePressed', from.x, from.y)
  for (const t of [0.25, 0.5, 0.75, 1]) {
    await cdp.mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
    await sleep(60)
  }
  // 拖着走时的浮签得说清"要挪去哪"
  const ghost = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.className.includes('fixed') && d.textContent.trim().startsWith('移动'),
    )
    return el ? el.textContent.trim() : null
  })()`)
  console.log('拖到一半时的浮签:', JSON.stringify(ghost))
  if (!ghost || !ghost.includes('内网')) throw new Error(`浮签没说目标分组：${ghost}`)
  await cdp.shot('probe-session-drag-0-hover.png')

  await cdp.mouse('mouseReleased', to.x, to.y, { buttons: 0 })
  await sleep(500)

  const after = await counts()
  console.log('拖之后各组行数:', JSON.stringify(after))
  const intra = after.find((g) => g.group === 'g-intra')
  const none = after.find((g) => g.group === '')
  if (!intra || intra.hosts !== 3) throw new Error(`拖进「内网」没生效：${JSON.stringify(after)}`)
  if (!none || none.hosts !== 0) throw new Error(`未分组里还剩人：${JSON.stringify(after)}`)

  // 松手后浏览器会补一次 click —— 不能连带触发「点击连接」
  const tabsAfter = (await cdp.eval('__probe.tabs()')).length
  if (tabsAfter !== tabsBefore) throw new Error('拖完误触发了连接（标签数变了）')

  // 再拖回未分组：反方向也要通（顺便把数据还原，不然后面的场景数不对）
  const from2 = await cdp.eval(`(() => {
    const r = document.querySelector('[data-group-id="g-intra"] [data-host-title]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const to2 = await cdp.eval(`(() => {
    const r = document.querySelector('[data-group-id=""] > div').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await cdp.mouse('mousePressed', from2.x, from2.y)
  for (const t of [0.25, 0.5, 0.75, 1]) {
    await cdp.mouse('mouseMoved', from2.x + (to2.x - from2.x) * t, from2.y + (to2.y - from2.y) * t)
    await sleep(60)
  }
  await cdp.mouse('mouseReleased', to2.x, to2.y, { buttons: 0 })
  await sleep(500)

  const back = await counts()
  console.log('拖回未分组后:', JSON.stringify(back))
  const noneBack = back.find((g) => g.group === '')
  if (!noneBack || noneBack.hosts !== 1) throw new Error(`拖回未分组没生效：${JSON.stringify(back)}`)
  await cdp.shot('probe-session-drag-1-done.png')

  console.log('拖拽换分组探针：全部通过')
}

/**
 * 场景：右侧文件栏（问题 3 / 5 的冒烟）。
 *
 * 顶栏右上角的 📁 开出文件栏；空白区右键给「新建文件 / 新建文件夹 / 刷新」；
 * 栏头「本机 ▾」能换绑定（本机 / 已连接会话 / 连接主机）。
 */
async function scenarioRightPanel(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  if ((await cdp.eval(`!!document.querySelector('[data-right-panel]')`)))
    throw new Error('文件栏默认不该开着')

  await clickSel(cdp, '[data-right-panel-toggle]')
  await sleep(400)
  const panel = await cdp.eval(`(() => {
    const el = document.querySelector('[data-right-panel]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), text: el.textContent.slice(0, 80) }
  })()`)
  console.log('文件栏:', JSON.stringify(panel))
  if (!panel) throw new Error('点 📁 之后文件栏没出来')
  await cdp.shot('probe-right-panel-0-open.png')

  // 底部那排操作按钮：图标 + 悬停提示，窄栏里不许溢出/换行
  // （文字按钮版在 320px 宽的文件栏里挤成一团，就是用户报的"显示问题"）
  const bar = await cdp.eval(`(() => {
    const btn = document.querySelector('[data-transfer-resume]')
    const row = btn.parentElement
    const r = row.getBoundingClientRect()
    return {
      scroll: row.scrollWidth,
      client: row.clientWidth,
      h: Math.round(r.height),
      titles: [...row.querySelectorAll('button')].map((b) => b.getAttribute('title')),
    }
  })()`)
  console.log('底部工具条:', JSON.stringify(bar))
  if (bar.scroll > bar.client + 1 || bar.h > 30)
    throw new Error(`底部工具条溢出/换行了：${JSON.stringify(bar)}`)
  if (bar.titles.length < 5 || bar.titles.some((t) => !t))
    throw new Error(`有按钮没挂悬停提示：${JSON.stringify(bar.titles)}`)

  // 空白区右键：新建文件 / 新建文件夹 / 刷新
  const blank = await cdp.eval(`(() => {
    const r = document.querySelector('[data-right-panel]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.bottom - 80 }
  })()`)
  await cdp.rightClick(blank.x, blank.y)
  await sleep(250)
  const menu = await cdp.eval(`[...document.querySelectorAll('[data-menu-item]')].map((e) => e.getAttribute('data-menu-item'))`)
  console.log('空白右键菜单:', JSON.stringify(menu))
  for (const id of ['blank-new-file', 'blank-new-folder', 'blank-refresh']) {
    if (!menu.includes(id)) throw new Error(`空白菜单少了 ${id}（现有：${menu.join(', ')}）`)
  }

  // 新建文件 → 弹「新建本地文件」输入框（文件栏默认绑本机）
  await clickMenuItem(cdp, 'blank-new-file')
  await sleep(300)
  const dialog = await cdp.eval(`document.body.innerText.includes('新建本地文件')`)
  console.log('新建文件弹窗:', dialog)
  if (!dialog) throw new Error('点「新建文件」没弹输入框')
  await cdp.shot('probe-right-panel-1-newfile.png')
  const cancel = await cdp.eval(`__probe.buttonBox('取消')`)
  if (cancel) {
    await cdp.mouse('mousePressed', cancel.x, cancel.y)
    await cdp.mouse('mouseReleased', cancel.x, cancel.y)
  }
  await sleep(200)

  // 栏头换绑菜单
  await clickSel(cdp, '[data-pane-binding]')
  await sleep(250)
  const bind = await cdp.eval(`[...document.querySelectorAll('[data-menu-item]')].map((e) => e.getAttribute('data-menu-item'))`)
  console.log('换绑菜单:', JSON.stringify(bind))
  for (const id of ['bind-local', 'bind-live', 'bind-connect']) {
    if (!bind.includes(id)) throw new Error(`换绑菜单少了 ${id}（现有：${bind.join(', ')}）`)
  }
  await cdp.mouse('mouseMoved', blank.x, blank.y)
  await cdp.mouse('mousePressed', blank.x, blank.y)
  await cdp.mouse('mouseReleased', blank.x, blank.y)
  await sleep(150)

  // 再点一次收起
  await clickSel(cdp, '[data-right-panel-toggle]')
  await sleep(300)
  if (await cdp.eval(`!!document.querySelector('[data-right-panel]')`))
    throw new Error('再点 📁 文件栏没收起')
  await cdp.shot('probe-right-panel-2-closed.png')

  console.log('右侧文件栏探针：全部通过')
}
async function scenarioNewlineOnly(cdp) {
  await cdp.eval(HELPERS)

  // 分屏后底部出现「本屏批量执行」把手，点开
  const handle = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('本屏批量执行'))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!handle) throw new Error('没找到本屏批量执行把手')
  await cdp.mouse('mousePressed', handle.x, handle.y)
  await cdp.mouse('mouseReleased', handle.x, handle.y)
  await sleep(400)
  await cdp.shot('probe-4-pane-bar.png')

  // 往命令框里塞一个换行（受控组件要走原生 setter + input 事件）
  const filled = await cdp.eval(`(() => {
    const ta = [...document.querySelectorAll('textarea')].pop()
    if (!ta) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '\\n')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value.length
  })()`)
  console.log('命令框内容长度（应为 1 = 一个换行）:', filled)

  // 点「发送」
  const sendBtn = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!sendBtn) throw new Error('没找到发送按钮')
  await cdp.mouse('mousePressed', sendBtn.x, sendBtn.y)
  await cdp.mouse('mouseReleased', sendBtn.x, sendBtn.y)
  await sleep(300)

  const toast = await cdp.eval(
    `(document.querySelector('div.fixed.bottom-8.right-4')?.textContent ?? '(没有提示)')`,
  )
  console.log('点「发送」后的提示:', toast)
  await cdp.shot('probe-5-newline-send.png')

  // 再点一次「执行」，看 exec 那条路是否也放行
  const runBtn = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '执行')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (runBtn) {
    await cdp.mouse('mousePressed', runBtn.x, runBtn.y)
    await cdp.mouse('mouseReleased', runBtn.x, runBtn.y)
    await sleep(600)
    console.log(
      '点「执行」后的提示:',
      await cdp.eval(`(document.querySelector('div.fixed.bottom-8.right-4')?.textContent ?? '(没有提示)')`),
    )
    console.log(
      '结果卡片:',
      await cdp.eval(`[...document.querySelectorAll('pre')].map((p) => p.textContent).join(' || ')`),
    )
    await cdp.shot('probe-6-newline-exec.png')
  }
}

/* ---------------- main ---------------- */

/**
 * 标签筛选 / 关键词过滤 / 编辑主机对话框。
 *
 * 这几条都是"点了之后界面该变成什么样"，靠读代码推演等于自我确认 ——
 * 真正要证的是：筛选真的把行筛掉了、对话框真的预填了那条记录。
 */
async function scenarioTags(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  const all = await cdp.eval('__probe.hostsVisible()')
  console.log('主机行（初始）:', JSON.stringify(all))
  console.log('标签快捷条:', JSON.stringify(await cdp.eval('__probe.tagBar()')))
  console.log('行内标签 chip:', JSON.stringify(await cdp.eval('__probe.rowTags()')))
  await cdp.shot('probe-tags-1-overview.png')

  // 点快捷条里的 prod（假数据里正好两台带它）
  await clickSel(cdp, '[data-tag-filter="prod"]')
  await sleep(300)
  const byTag = await cdp.eval('__probe.hostsVisible()')
  console.log('按标签 prod 筛选后:', JSON.stringify(byTag))
  if (byTag.length !== 2) throw new Error(`按 prod 应该剩 2 台，实际 ${byTag.length}`)
  await cdp.shot('probe-tags-2-filter.png')

  // 再点一次 = 取消
  await clickSel(cdp, '[data-tag-filter="prod"]')
  await sleep(300)
  const back = await cdp.eval('__probe.hostsVisible()')
  console.log('取消标签筛选后:', JSON.stringify(back))
  if (back.length !== all.length) throw new Error('取消筛选后行数没恢复')

  // 关键词用**标签文字**：能搜到说明标签确实进了搜索范围
  await typeInto(cdp, '[data-host-filter]', '开发')
  await sleep(300)
  const byKw = await cdp.eval('__probe.hostsVisible()')
  console.log('关键词「开发」（只有一台带这个标签）:', JSON.stringify(byKw))
  if (byKw.length !== 1) throw new Error(`关键词「开发」应该剩 1 台，实际 ${byKw.length}`)
  await cdp.shot('probe-tags-3-keyword.png')

  // 关键词 + 标签是"与"的关系：两者同时命中才留下
  await typeInto(cdp, '[data-host-filter]', 'prod')
  await clickSel(cdp, '[data-tag-filter="开发"]')
  await sleep(300)
  const both = await cdp.eval('__probe.hostsVisible()')
  console.log('关键词 prod + 标签 开发（互斥，应为 0）:', JSON.stringify(both))
  if (both.length !== 0) throw new Error(`互斥条件应该剩 0 台，实际 ${both.length}`)
  await clickSel(cdp, '[data-tag-filter="开发"]')
  await typeInto(cdp, '[data-host-filter]', '')
  await sleep(300)

  // 点 web-01 的编辑按钮：对话框该切成编辑形态并预填
  await clickSel(cdp, '[data-host-edit="h-1"]')
  await sleep(500)
  console.log(
    '编辑对话框:',
    JSON.stringify({
      hasEditTitle: await cdp.eval(`document.body.innerText.includes('编辑主机')`),
      hasSaveButton: await cdp.eval(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存')`,
      ),
      inputs: await cdp.eval('__probe.inputValues()'),
      名称框的兜底提示: await cdp.eval(
        `document.querySelector('input[placeholder*="@"]')?.placeholder ?? '(没有)'`,
      ),
    }),
  )

  /**
   * 说明文字改成 hover 才出现（挂在问号上）。
   * 判据是**可见正文里不该再有那几段**，但 title 属性得在 —— 只删不挂等于把说明弄丢了。
   */
  console.log(
    '字段说明:',
    JSON.stringify({
      问号个数: (await cdp.eval('__probe.hints()')).length,
      正文里残留的长句: await cdp.eval(
        `['额外接受 dh-group1', '给这台机器起个顺口', '逗号或空格分隔', '标签是横着切的一类机器', '改完只更新主机列表'].filter((s) => document.body.innerText.includes(s))`,
      ),
      挂在_tooltip_上的说明: (await cdp.eval('__probe.hints()')).map((t) => t.slice(0, 12)),
    }),
  )

  // 分组下拉：默认应该就是这台主机现在所在的分组
  console.log(
    '分组下拉:',
    JSON.stringify(
      await cdp.eval(`(() => {
        const el = document.querySelector('select')
        if (!el) return null
        return { 当前值: el.value, 选项: [...el.options].map((o) => o.textContent) }
      })()`),
    ),
  )
  await cdp.shot('probe-tags-4-edit.png')

  // 改分组：web-01 从「生产环境」挪到「内网」，存下去看会话树里的行数变化
  console.log('改分组前各组行数:', JSON.stringify(await cdp.eval('__probe.groupCounts()')))
  await cdp.eval(`(() => {
    const el = document.querySelector('select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, 'g-intra')
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
  await sleep(200)
  const saveBtn = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!saveBtn) throw new Error('没找到保存按钮')
  await cdp.mouse('mousePressed', saveBtn.x, saveBtn.y)
  await cdp.mouse('mouseReleased', saveBtn.x, saveBtn.y)
  await sleep(700)
  console.log('改分组后各组行数:', JSON.stringify(await cdp.eval('__probe.groupCounts()')))
  console.log(
    '对话框关掉了吗:',
    await cdp.eval(`!document.body.innerText.includes('编辑主机')`),
  )
  await cdp.shot('probe-tags-5-after-group-change.png')
}

/** 双击标签名就地改名 */
async function scenarioTabRename(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  // 先连一台把标签开出来（改名得先有个标签）
  const hosts = await cdp.eval('__probe.hosts()')
  await cdp.mouse('mousePressed', hosts[2].x, hosts[2].y)
  await cdp.mouse('mouseReleased', hosts[2].x, hosts[2].y)
  await waitFor(cdp, '__probe.tabs().length > 0', '至少一个标签')
  await sleep(500)

  const before = await cdp.eval('__probe.tabs()')
  console.log('改名前的标签:', JSON.stringify(before.map((t) => t.title)))

  // 真双击：两轮 pressed/released，clickCount 依次 1、2
  const t = before[0]
  await cdp.mouse('mousePressed', t.x, t.y, { clickCount: 1 })
  await cdp.mouse('mouseReleased', t.x, t.y, { clickCount: 1, buttons: 0 })
  await cdp.mouse('mousePressed', t.x, t.y, { clickCount: 2 })
  await cdp.mouse('mouseReleased', t.x, t.y, { clickCount: 2, buttons: 0 })
  await sleep(300)

  const editor = await cdp.eval(`(() => {
    const inputs = [...document.querySelectorAll('input')]
    return { count: inputs.length, values: inputs.map((i) => i.value) }
  })()`)
  console.log('双击后页面上的输入框:', JSON.stringify(editor))
  if (editor.count === 0) throw new Error('双击标签名没有进入改名态（没出现输入框）')

  // 输入新名字，回车提交
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input')].find((i) => i.value === ${JSON.stringify(t.title)})
    if (!el) return 'no-input'
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '我的生产机')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input')].find((i) => i.value === '我的生产机')
    if (!el) return 'no-input'
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'enter-sent'
  })()`)
  await sleep(400)

  const after = await cdp.eval('__probe.tabs()')
  console.log('改名后的标签:', JSON.stringify(after.map((x) => x.title)))
  if (!after.some((x) => x.title === '我的生产机')) throw new Error('改名没生效')
  await cdp.shot('probe-rename.png')
}

/** 点菜单里 id 为 X 的那一项（真鼠标）。找不到就把现有项列出来，免得只报一句"没有" */
async function clickMenuItem(cdp, id) {
  const items = await cdp.eval('__probe.menu()')
  const flat = []
  for (const it of items ?? []) {
    if (it.submenu) flat.push(...it.submenu)
    else if (!it.sep) flat.push(it)
  }
  const hit = flat.find((i) => i.id === id)
  if (!hit) {
    throw new Error(`菜单里没有 ${id}（现有：${flat.map((i) => i.id).join(', ')}）`)
  }
  await cdp.mouse('mousePressed', hit.x, hit.y)
  await cdp.mouse('mouseReleased', hit.x, hit.y)
  await sleep(350)
  return hit
}

/**
 * 场景：右键菜单。
 *
 * 全部走**真鼠标**（`Input.dispatchMouseEvent` 的 button:'right'），不用合成事件 ——
 * "原生菜单有没有被拦下"只有真事件序列能验：合成事件不触发浏览器的默认行为，
 * 拦没拦从外面看不出来。
 */
async function scenarioContextMenu(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  const t0 = (await cdp.eval('__probe.hosts()'))[0]

  /* ---------- 1. 主机行 ---------- */
  await cdp.rightClick(t0.x, t0.y)
  await sleep(300)
  const hostMenu = await cdp.eval('__probe.menuIds()')
  console.log('主机行菜单:', JSON.stringify(hostMenu))
  if (!hostMenu) throw new Error('主机行右键没出菜单')
  for (const id of ['host-connect', 'host-sftp', 'host-move-group', 'host-copy-address', 'host-delete']) {
    if (!hostMenu.some((m) => m.startsWith(id))) throw new Error(`主机行菜单少了 ${id}`)
  }
  await cdp.shot('probe-menu-1-host.png')

  /* ---------- 2. 子菜单（移入分组） ---------- */
  const hostItems = await cdp.eval('__probe.menu()')
  const moveItem = hostItems.find((i) => i.id === 'host-move-group')
  await cdp.mouse('mouseMoved', moveItem.x, moveItem.y)
  await sleep(350)
  const withSub = await cdp.eval('__probe.menuIds()')
  console.log('展开「移入分组」后:', JSON.stringify(withSub))
  if (!withSub?.some((m) => m.startsWith('>sub:'))) throw new Error('「移入分组」没有展开子菜单')
  await cdp.shot('probe-menu-2-submenu.png')
  await cdp.escape()
  await sleep(250)

  /* ---------- 3. 分组行 ---------- */
  const group = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('[data-group-id]')].find((d) => d.getAttribute('data-group-id'))
    const row = el && el.firstElementChild
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!group) throw new Error('找不到分组行')
  await cdp.rightClick(group.x, group.y)
  await sleep(300)
  const groupMenu = await cdp.eval('__probe.menuIds()')
  console.log('分组行菜单:', JSON.stringify(groupMenu))
  if (!groupMenu?.some((m) => m.startsWith('group-new-host'))) throw new Error('分组行菜单少了「新建会话」')
  if (!groupMenu.some((m) => m.startsWith('group-delete'))) throw new Error('分组行菜单少了「删除分组」')
  await cdp.shot('probe-menu-3-group.png')
  await cdp.escape()
  await sleep(250)

  /* ---------- 4. 原生菜单：输入框放行、普通区域拦下 ---------- */
  await cdp.eval('__probe.watchCtx()')

  await cdp.eval('__probe.clearCtxLog()')
  const filter = await boxOf(cdp, '[data-host-filter]')
  await cdp.rightClick(filter.x, filter.y)
  await sleep(250)
  const inputLog = await cdp.eval('__probe.ctxLog()')
  console.log('过滤框上右键:', JSON.stringify(inputLog))
  if (inputLog.some((e) => e.prevented)) {
    throw new Error('输入框上不该拦原生菜单（剪切/粘贴还得用）')
  }
  await cdp.escape()
  await sleep(200)

  await cdp.eval('__probe.clearCtxLog()')
  const toolbar = await boxOf(cdp, 'aside > div:last-child')
  await cdp.rightClick(toolbar.x, toolbar.y)
  await sleep(250)
  const plainLog = await cdp.eval('__probe.ctxLog()')
  console.log('侧栏工具区右键:', JSON.stringify(plainLog))
  if (!plainLog.some((e) => e.prevented)) {
    throw new Error('普通区域的原生右键菜单没被拦住')
  }
  await cdp.escape()
  await sleep(200)

  /* ---------- 5. 标签栏 ---------- */
  const hosts = await cdp.eval('__probe.hosts()')
  for (const h of hosts.slice(0, 2)) {
    await cdp.mouse('mousePressed', h.x, h.y)
    await cdp.mouse('mouseReleased', h.x, h.y)
    await sleep(500)
  }
  await waitFor(cdp, '__probe.tabs().length >= 2', '两个标签')
  const tabs = await cdp.eval('__probe.tabs()')
  await cdp.rightClick(tabs[0].x, tabs[0].y)
  await sleep(300)
  const tabMenu = await cdp.eval('__probe.menuIds()')
  console.log('标签菜单:', JSON.stringify(tabMenu))
  if (!tabMenu?.some((m) => m.startsWith('tab-close-others'))) throw new Error('标签菜单少了「关闭其它」')
  if (!tabMenu.some((m) => m.startsWith('tab-close-right'))) throw new Error('标签菜单少了「关闭右侧」')
  await cdp.shot('probe-menu-4-tab.png')

  await clickMenuItem(cdp, 'tab-close-others')
  await sleep(500)
  const left = await cdp.eval('__probe.tabs()')
  console.log('「关闭其它」之后剩:', left.length, JSON.stringify(left.map((t) => t.title)))
  if (left.length !== 1) throw new Error(`「关闭其它」没生效，还剩 ${left.length} 个标签`)

  /* ---------- 6. SFTP 文件行 ---------- */
  const h0 = (await cdp.eval('__probe.hosts()'))[0]
  await cdp.rightClick(h0.x, h0.y)
  await sleep(250)
  await clickMenuItem(cdp, 'host-sftp')
  await waitFor(cdp, `document.querySelectorAll('table tbody tr').length > 0`, 'SFTP 文件列表')
  await sleep(400)

  const rows = await cdp.eval('__probe.fileRows()')
  console.log('文件行:', JSON.stringify(rows.map((r) => `${r.name}/${r.size}`)))
  const fileRow = rows.find((r) => r.size !== '—')
  if (!fileRow) throw new Error('SFTP 里没有文件（全是目录？）')
  await cdp.rightClick(fileRow.x, fileRow.y)
  await sleep(300)
  const fileMenu = await cdp.eval('__probe.menuIds()')
  console.log(`文件行（${fileRow.name}）菜单:`, JSON.stringify(fileMenu))
  for (const id of ['file-transfer', 'file-edit', 'file-copy-path', 'file-open-terminal']) {
    if (!fileMenu?.some((m) => m.startsWith(id))) throw new Error(`文件行菜单少了 ${id}`)
  }
  await cdp.shot('probe-menu-5-file.png')

  /* ---------- 7. 编辑器（从文件行菜单进去） ---------- */
  await clickMenuItem(cdp, 'file-edit')
  await waitFor(cdp, `document.querySelector('.cm-editor') !== null`, '内置编辑器')
  await sleep(500)
  const editor = await cdp.eval('__probe.editorBox()')
  if (!editor) throw new Error('编辑器区域量不到')
  await cdp.rightClick(editor.x, editor.y)
  await sleep(300)
  const editorMenu = await cdp.eval('__probe.menuIds()')
  console.log('编辑器菜单:', JSON.stringify(editorMenu))
  for (const id of ['editor-undo', 'editor-copy', 'editor-save', 'editor-copy-path']) {
    if (!editorMenu?.some((m) => m.startsWith(id))) throw new Error(`编辑器菜单少了 ${id}`)
  }
  await cdp.shot('probe-menu-6-editor.png')
  await cdp.escape()
  await sleep(200)

  /* ---------- 8. 「在终端里打开」：没有本地 Shell 时应顺手开一个 ---------- */
  // 回 SFTP 标签（编辑器标签把它挡住了，坐标也能点，但切过去更接近真人操作）
  const tabsNow = await cdp.eval('__probe.tabs()')
  const sftpTab = tabsNow.find((t) => t.title.includes('文件'))
  if (sftpTab) {
    await cdp.mouse('mousePressed', sftpTab.x, sftpTab.y)
    await cdp.mouse('mouseReleased', sftpTab.x, sftpTab.y)
    await sleep(400)
  }
  const localFile = (await cdp.eval('__probe.fileRows()')).find((r) => r.size !== '—')
  await cdp.rightClick(localFile.x, localFile.y)
  await sleep(300)
  await clickMenuItem(cdp, 'file-open-terminal')
  await sleep(1200)
  const titles = (await cdp.eval('__probe.tabs()')).map((t) => t.title)
  console.log('「在终端里打开」之后标签:', JSON.stringify(titles))
  if (!titles.some((t) => t === '本地 Shell')) {
    throw new Error('本地目录的「在终端里打开」没有开出本地 Shell 标签')
  }
  await cdp.shot('probe-menu-7-open-in-terminal.png')

  console.log('\n右键菜单探针：全部通过')
}

/**
 * 场景：新建会话表单
 *
 * 用户报的 bug —— 连着新建两次，第二次还留着上一次填的内容（连密码都在）。
 * 根因是对话框**一直挂着**（App 里无条件渲染 + `if (!connectOpen) return null`），
 * `useState` 的初值只在应用启动那一瞬算过一次，不显式清就一直是上一份。
 * 顺带钉住同源的第二条：编辑主机 → Esc → 新建，不该带着编辑目标开门（那样点保存
 * 会改掉刚才那台机器，而不是新建）。
 */
async function scenarioConnectForm(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  /** 侧栏头部那个「+」就是新建会话，跟 Ctrl+N 同一个入口 */
  const openNew = async () => {
    await clickSel(cdp, 'aside button[title="新建会话"]')
    await sleep(400)
  }
  const fillAll = async (suffix) => {
    await cdp.eval(`__probe.fill("192.168.1.10", "10.9.9.${suffix}")`)
    await cdp.eval('__probe.fill("root", "alice")')
    await cdp.eval('__probe.fill("登录密码", "pw-上一次")')
    await cdp.eval('__probe.fill("@", "上次的名字")')
    await cdp.eval('__probe.fill("prod, 客户A", "prod, 机房9")')
    await sleep(250)
  }
  /**
   * 只看"本该空着"的那几个。端口不算 —— 它的初值本来就是 22，
   * 而 placeholder 为空的输入框就是它
   */
  const leftovers = async () =>
    (await cdp.eval('__probe.dialogInputs()')).filter((f) => f.value !== '' && f.ph !== '')

  /* ---------- 1. 填满 → Esc 关 → 再开 ---------- */
  await openNew()
  const firstTitle = await cdp.eval('__probe.dialogTitle()')
  console.log('第一次打开:', firstTitle)
  await fillAll(9)
  console.log('填完:', JSON.stringify(await cdp.eval('__probe.dialogInputs()')))
  await cdp.shot('probe-connect-1-filled.png')

  await cdp.escape()
  await sleep(400)
  await openNew()
  const afterEsc = await leftovers()
  console.log('Esc 关掉再打开，残留字段:', JSON.stringify(afterEsc))
  if (afterEsc.length > 0) {
    throw new Error('Esc 关掉后重开还留着上一次的内容：' + JSON.stringify(afterEsc))
  }

  /* ---------- 2. 填满 → 点「连接」成功关掉 → 再开（用户报的就是这条） ---------- */
  await fillAll(10)
  const before = (await cdp.eval('__probe.tabs()')).length
  const connectBtn = await cdp.eval('__probe.buttonBox("连接")')
  if (!connectBtn) throw new Error('找不到「连接」按钮')
  await cdp.mouse('mousePressed', connectBtn.x, connectBtn.y)
  await cdp.mouse('mouseReleased', connectBtn.x, connectBtn.y)
  await sleep(1200)
  const after = (await cdp.eval('__probe.tabs()')).length
  if (after !== before + 1) throw new Error(`连接之后标签数不对：${before} → ${after}`)
  if (await cdp.eval('__probe.dialogTitle()')) throw new Error('连上之后对话框没关掉')

  await openNew()
  const afterConnect = await leftovers()
  console.log('连接成功再新建，残留字段:', JSON.stringify(afterConnect))
  if (afterConnect.length > 0) {
    throw new Error('连接成功后重开还留着上一次的内容：' + JSON.stringify(afterConnect))
  }
  await cdp.shot('probe-connect-2-reopened.png')

  /* ---------- 3. 编辑主机 → Esc → 新建 ---------- */
  await cdp.escape()
  await sleep(300)
  await clickSel(cdp, '[data-host-edit]')
  await sleep(400)
  console.log('编辑形态的标题:', await cdp.eval('__probe.dialogTitle()'))
  await cdp.escape()
  await sleep(400)

  await openNew()
  const title3 = await cdp.eval('__probe.dialogTitle()')
  const fields3 = await leftovers()
  console.log('编辑 Esc 之后新建:', title3, JSON.stringify(fields3))
  if (title3 !== '新建会话') {
    throw new Error(`编辑目标没清掉，标题是「${title3}」（点保存会改掉刚那台机器）`)
  }
  if (fields3.length > 0) {
    throw new Error('编辑 Esc 之后重开还留着内容：' + JSON.stringify(fields3))
  }

  console.log('\n新建会话表单探针：全部通过')
}

/**
 * 场景：收起会话侧栏
 *
 * 用户报的：收起之后整块内容变黑，只剩窗口标题栏。开合状态不跨启动记忆
 * （每次启动默认「左开右关」），所以刷新这一下验的是"全新启动回到默认展开、
 * 且页面不许塌" —— 用户重启后就是这么撞上黑屏的。
 */
async function scenarioSidebar(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  // 开一个终端标签：黑屏只在有终端时才看得出来
  const host = (await cdp.eval('__probe.hosts()'))[0]
  await cdp.mouse('mousePressed', host.x, host.y)
  await cdp.mouse('mouseReleased', host.x, host.y)
  await waitFor(cdp, '__probe.tabs().length > 0', '一个终端标签')
  await sleep(900)
  console.log('收起前:', JSON.stringify(await cdp.eval('__probe.layout()')))
  await cdp.shot('probe-sidebar-0-expanded.png')

  await clickSel(cdp, '[data-sidebar-toggle]')
  await sleep(900)
  const collapsed = await cdp.eval('__probe.layout()')
  console.log('收起后:', JSON.stringify(collapsed))
  await cdp.shot('probe-sidebar-1-collapsed.png')

  /* 侧栏收起了、主区该占满整宽 */
  if (collapsed.aside) throw new Error('侧栏没真收起（aside 还在）')
  if (collapsed.main.left !== 0) throw new Error(`主区左边没归零：${collapsed.main.left}`)
  if (collapsed.main.w !== collapsed.inner[0]) {
    throw new Error(`主区没占满宽：${collapsed.main.w} / ${collapsed.inner[0]}`)
  }
  /* 状态栏必须还在可视区里 —— 它在底部，被顶出去就等于"整页塌了" */
  if (!collapsed.status || collapsed.status.top + collapsed.status.h > collapsed.inner[1] + 1) {
    throw new Error('状态栏被挤出可视区：' + JSON.stringify(collapsed.status))
  }
  if (collapsed.docScroll[1] > collapsed.inner[1] + 1 || collapsed.docScroll[0] > collapsed.inner[0] + 1) {
    throw new Error(`整页被撑破了：docScroll ${collapsed.docScroll} vs 视口 ${collapsed.inner}`)
  }
  if (collapsed.grid.h > collapsed.inner[1]) {
    throw new Error(`终端区比视口还高：${collapsed.grid.h} > ${collapsed.inner[1]}`)
  }

  /* 刷新 = 一次全新启动：侧栏应回到「默认展开」，并且页面不许塌 */
  await cdp.send('Page.reload')
  await sleep(1500)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.tabs().length > 0 || document.body.innerText.length > 0', '刷新后')
  await sleep(800)
  const reloaded = await cdp.eval('__probe.layout()')
  console.log('刷新后（应恢复默认展开）:', JSON.stringify(reloaded))
  if (!reloaded.aside) throw new Error('刷新后侧栏没有恢复默认展开（开合不该跨启动记忆）')
  if (reloaded.docScroll[1] > reloaded.inner[1] + 1) {
    throw new Error('刷新后整页被撑破：' + JSON.stringify(reloaded.docScroll))
  }
  await cdp.shot('probe-sidebar-2-reloaded.png')

  console.log('\n侧栏探针：全部通过')
}

/** 把某个标签拖到 (x,y) 上，按住不松（拖标签并分屏与拖标签拼窗口共用） */
async function dragTabTo(cdp, tab, x, y) {
  await cdp.mouse('mousePressed', tab.x, tab.y)
  await sleep(60)
  for (let i = 1; i <= 10; i += 1) {
    const t = i / 10
    await cdp.mouse('mouseMoved', tab.x + (x - tab.x) * t, tab.y + (y - tab.y) * t)
    await sleep(40)
  }
  await sleep(250)
}

/**
 * 场景：多分屏窗口里的拖拽落点 + 拖得出哪些形状
 *
 * 用户报的两件事：
 *   1. 多分屏时"特殊显示的区域"不对 —— 高亮盖住的那一格，并不是新格子真正会落下的位置；
 *   2. 三、四分屏**拖不出所有形式** —— 拖到某一格的半边本该"切开那一格"，
 *      旧实现却只会给"下一档预设"，于是「左二右一」「上二下一」这类只能去菜单里点。
 *
 * 所以这个场景分两半：前半验高亮与落点一致（老），后半验**形状**真的切开了（新）。
 */
async function scenarioDropZone(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 3', '至少四台主机')

  // 挑四台**连得上**的主机：老交换机（10.0.0.1）是预览里专门用来演练
  // "算法不兼容 → 勾兼容模式重试"的那台，点它只会弹一条连接失败，起不来标签
  const hosts = (await cdp.eval('__probe.hosts()')).filter((h) => !h.text.includes('老交换机'))
  for (const h of hosts.slice(0, 4)) {
    await cdp.mouse('mousePressed', h.x, h.y)
    await cdp.mouse('mouseReleased', h.x, h.y)
    await sleep(500)
  }
  await waitFor(cdp, '__probe.tabs().length >= 4', '四个标签')

  /* ---------- 1. 先拼出两格（左右二分） ---------- */
  // 先**切到第 1 个标签**再量它的窗口：隐藏的标签 display:none，矩形全是 0，
  // 而拖动源不能是落点那个标签自己（那是"拖回自己"，按设计不并）
  let tabs = await cdp.eval('__probe.tabs()')
  await cdp.mouse('mousePressed', tabs[0].x, tabs[0].y)
  await cdp.mouse('mouseReleased', tabs[0].x, tabs[0].y)
  await sleep(600)
  const g0 = (await cdp.eval('__probe.grids()')).find((g) => !g.hidden)
  const halfX = Math.round(g0.left + (g0.right - g0.left) * 0.25)
  const midY = Math.round((g0.top + g0.bottom) / 2)
  await dragTabTo(cdp, tabs[2], halfX, midY)
  console.log('拖到一半时的浮签:', JSON.stringify(await cdp.eval('__probe.ghost()')))
  console.log('拖到一半时的高亮:', JSON.stringify(await cdp.eval('__probe.highlights()')))
  await cdp.mouse('mouseReleased', halfX, midY, { buttons: 0 })
  await sleep(1800)
  const two = await cdp.eval('__probe.cells()')
  console.log('拼两格后:', JSON.stringify(two))
  if (two.length !== 2) throw new Error(`应该拼成两格，实际 ${two.length}`)

  /* ---------- 2. 把剩下的那个标签拖到**右格的后半边** ---------- */
  tabs = await cdp.eval('__probe.tabs()')
  const src = tabs[tabs.length - 1]
  const right = two[1]
  const hoverX = Math.round(right.left + right.w * 0.75)
  const hoverY = Math.round(right.top + right.h / 2)
  await dragTabTo(cdp, src, hoverX, hoverY)
  const ghost = await cdp.eval('__probe.ghost()')
  const zone = await cdp.eval('__probe.highlights()')
  console.log('悬停右格（偏右）时的浮签:', JSON.stringify(ghost))
  console.log('悬停右格（偏右）时的高亮:', JSON.stringify(zone))
  console.log('此刻两格:', JSON.stringify(two))
  await cdp.shot('probe-dropzone-1-hover-right.png')

  /*
   * 高亮必须**只盖住右格的后半边**。
   * 以前这里是整格 —— 于是"高亮盖着 web-01 那一格、新格子却插到了它左边"，
   * 用户看到的就是"特殊显示的区域不对"。
   */
  if (!ghost?.text.includes('右侧')) {
    throw new Error(`浮签没说清落点：${ghost?.text}`)
  }
  const expectLeft = Math.round(right.left + right.w / 2)
  const expectW = Math.round(right.w / 2)
  const hl = zone[0]
  if (!hl || Math.abs(hl.left - expectLeft) > 3 || Math.abs(hl.w - expectW) > 3) {
    throw new Error(
      `高亮区域不对：${JSON.stringify(hl)}，应该盖住右格的后半边（left≈${expectLeft} w≈${expectW}）`,
    )
  }

  await cdp.mouse('mouseReleased', hoverX, hoverY, { buttons: 0 })
  await sleep(1800)
  const after = await cdp.eval('__probe.cells()')
  console.log('松手后:', JSON.stringify(after))
  await cdp.shot('probe-dropzone-2-after.png')

  /* 新格子必须落在**右格之后**（最右），而不是插到它左边 */
  if (after.length !== 3) throw new Error(`应该变成三格，实际 ${after.length}`)
  if (after[1].title !== right.title) {
    throw new Error(`web-01 不在中间了：${JSON.stringify(after.map((c) => c.title))}`)
  }
  if (!(after[2].left > after[1].left)) {
    throw new Error(`新格子没落在最右边：${JSON.stringify(after)}`)
  }

  /* ---------- 3. 四格：拖到**左格的下半边**，那一格要被切开 ---------- */
  /*
   * 这一步是"三四分屏拖不出所有形式"的正面验证：三格时拖到左格下半边，
   * 期望左列被切成上下两格、右两格整高（几何排布 cols3×rows2，对不上任何预设 ——
   * 所以它同时验了"自定义排布能存下来、能画出来、还能拖比例"）。
   * 旧实现会按"下一档预设"给个四宫格之类，格子落不到你指的那半边。
   */
  tabs = await cdp.eval('__probe.tabs()')
  const src3 = tabs[tabs.length - 1]
  const leftCell = after[0]
  const dropX = Math.round(leftCell.left + leftCell.w / 2)
  const dropY = Math.round(leftCell.top + leftCell.h * 0.75)
  await dragTabTo(cdp, src3, dropX, dropY)
  const ghost3 = await cdp.eval('__probe.ghost()')
  const hl3 = (await cdp.eval('__probe.highlights()'))[0]
  console.log('悬停左格（偏下）时的浮签:', JSON.stringify(ghost3))
  console.log('悬停左格（偏下）时的高亮:', JSON.stringify(hl3))
  await cdp.shot('probe-dropzone-3-hover-left-bottom.png')
  if (!ghost3?.text.includes('下方')) throw new Error(`浮签没说清落点：${ghost3?.text}`)
  if (
    !hl3 ||
    Math.abs(hl3.left - leftCell.left) > 3 ||
    Math.abs(hl3.top - (leftCell.top + leftCell.h / 2)) > 3 ||
    Math.abs(hl3.h - leftCell.h / 2) > 3
  ) {
    throw new Error(`高亮不是左格的下半边：${JSON.stringify(hl3)}，左格 ${JSON.stringify(leftCell)}`)
  }

  await cdp.mouse('mouseReleased', dropX, dropY, { buttons: 0 })
  await sleep(1800)
  const four = await cdp.eval('__probe.cells()')
  const seps = await cdp.eval('__probe.separators()')
  console.log('松手后（四格）:', JSON.stringify(four))
  console.log('分割线:', JSON.stringify(seps))
  await cdp.shot('probe-dropzone-4-custom-layout.png')

  if (four.length !== 4) throw new Error(`应该变成四格，实际 ${four.length}`)
  // 左列上下两格：左边对齐、上格在下格之上、宽度一样
  if (Math.abs(four[0].left - four[1].left) > 3) {
    throw new Error(`新格子没落在左列（第 1、2 格左边不对齐）：${JSON.stringify(four)}`)
  }
  if (!(four[1].top > four[0].top + 10)) {
    throw new Error(`新格子没落在左格下方：${JSON.stringify(four)}`)
  }
  if (Math.abs(four[0].w - four[1].w) > 3) {
    throw new Error(`左列两格宽度不一致：${JSON.stringify(four)}`)
  }
  // 第 3、4 格整高（跨两行），且在左边两格的右侧
  for (const i of [2, 3]) {
    if (Math.abs(four[i].top - four[0].top) > 3) {
      throw new Error(`第 ${i + 1} 格没有从顶部开始（应该整高）：${JSON.stringify(four)}`)
    }
    if (!(four[i].h > four[1].h)) {
      throw new Error(`第 ${i + 1} 格不是整高：${JSON.stringify(four)}`)
    }
  }
  if (!(four[2].left > four[1].left && four[3].left > four[2].left)) {
    throw new Error(`右边两格的顺序不对：${JSON.stringify(four)}`)
  }
  // 分割线：两条竖的整高 + 一条只画在左列的横线（自定义排布也得能拖比例）
  const cols = seps.filter((s) => s.axis === 'col')
  const rows = seps.filter((s) => s.axis === 'row')
  if (cols.length !== 2 || rows.length !== 1) {
    throw new Error(`分割线数量不对：竖 ${cols.length} 条、横 ${rows.length} 条 —— ${JSON.stringify(seps)}`)
  }
  if (Math.abs(rows[0].w - four[0].w) > 4 || Math.abs(rows[0].left - four[0].left) > 4) {
    throw new Error(`那条横线应该只画在左列里：${JSON.stringify(rows[0])}，左格 ${JSON.stringify(four[0])}`)
  }
  for (const s of cols) {
    if (Math.abs(s.h - (four[2].top + four[2].h - four[0].top)) > 4) {
      throw new Error(`竖分割线应该整高：${JSON.stringify(s)}`)
    }
  }

  /* ---------- 4. 自定义排布下的布局菜单：一项都不打勾，点一个预设要真的换过去 ---------- */
  /*
   * 这一条钉的是 `setPaneLayout` 的幂等守卫：它以前比的是 `layoutOf`（形状的**名字**），
   * 而自定义排布的 layoutOf 会回落成"该格数的默认" —— 于是"拖出来的四格排布 +
   * 点菜单里的四宫格"被当成没变，点了没反应（用户看到的明明不是四宫格）。
   */
  await clickSel(cdp, '[title^="分屏布局"][title*="4 格"]')
  await sleep(350)
  const menu = await cdp.eval(
    `[...document.querySelectorAll('[role=menu] button')].map((b) => ({ title: b.getAttribute('title'), active: b.className.includes('border-accent/60') }))`,
  )
  const active = menu.filter((m) => m.active)
  console.log(`布局菜单 ${menu.length} 项，打勾的：${JSON.stringify(active)}`)
  if (menu.length === 0) throw new Error('布局菜单没打开')
  if (active.length !== 0) {
    throw new Error(`自定义排布下不该有项打勾（会让人以为点一下能回到那个形状）：${JSON.stringify(active)}`)
  }
  if (!menu.some((m) => m.title === '四宫格')) throw new Error(`菜单里没有「四宫格」：${JSON.stringify(menu)}`)
  await clickSel(cdp, '[role=menu] button[title="四宫格"]')
  await sleep(800)
  const quad = await cdp.eval('__probe.cells()')
  console.log('点了「四宫格」之后:', JSON.stringify(quad))
  await cdp.shot('probe-dropzone-5-after-menu.png')
  if (quad.length !== 4) throw new Error(`点四宫格后还是 ${quad.length} 格`)
  if (Math.abs(quad[0].left - quad[2].left) > 3 || Math.abs(quad[1].left - quad[3].left) > 3) {
    throw new Error(`不是两列：${JSON.stringify(quad)}`)
  }
  if (Math.abs(quad[0].top - quad[1].top) > 3 || !(quad[2].top > quad[0].top + 10)) {
    throw new Error(`不是两行：${JSON.stringify(quad)}`)
  }

  console.log('\n多分屏落点探针：全部通过')
}

/**
 * 场景：本屏批量执行 —— 拖高度 + 逐行运行
 *
 * 用户提的两件事：这条栏"无法调整大小"；批量执行要能"逐行运行"。
 *
 * 逐行这条在预览里能真验：mock 的 `ssh_exec` 对含 `fail` 的命令返回退出码 1，
 * 于是"第 1 行成功 → 第 2 行非零退出 → 第 3 行已跳过"这一串状态是**跑出来的**，
 * 不是看代码推的。而且"整段跑一次"与"按行跑三次"的结果长得不一样（输出里
 * `mock-host: ` 出现几次），所以能直接断言它确实是逐行。
 */
async function scenarioBatchBar(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 1', '至少两台主机')

  /* ---------- 0. 先拼一个两格窗口（批量执行条只有多格标签才有） ---------- */
  const hosts = await cdp.eval('__probe.hosts()')
  for (const h of hosts.slice(0, 2)) {
    await cdp.mouse('mousePressed', h.x, h.y)
    await cdp.mouse('mouseReleased', h.x, h.y)
    await sleep(500)
  }
  await waitFor(cdp, '__probe.tabs().length >= 2', '两个标签')
  let tabs = await cdp.eval('__probe.tabs()')
  await cdp.mouse('mousePressed', tabs[0].x, tabs[0].y)
  await cdp.mouse('mouseReleased', tabs[0].x, tabs[0].y)
  await sleep(600)
  const g0 = (await cdp.eval('__probe.grids()')).find((g) => !g.hidden)
  const halfX = Math.round(g0.left + (g0.right - g0.left) * 0.25)
  const midY = Math.round((g0.top + g0.bottom) / 2)
  await dragTabTo(cdp, tabs[1], halfX, midY)
  await cdp.mouse('mouseReleased', halfX, midY, { buttons: 0 })
  await sleep(1800)
  if ((await cdp.eval('__probe.cells()')).length !== 2) throw new Error('没拼成两格')

  const collapsed = await cdp.eval('__probe.batchBar()')
  console.log('折叠时:', JSON.stringify(collapsed))
  if (!collapsed) throw new Error('这一屏没有批量执行条')
  if (collapsed.open) throw new Error('批量执行条一开始应该是折叠的')

  /* ---------- 1. 展开、拖高度 ---------- */
  await clickSel(cdp, '[data-batch-bar] button')
  await sleep(300)
  const opened = await cdp.eval('__probe.batchBar()')
  console.log('展开后:', JSON.stringify(opened))
  if (!opened.open) throw new Error('点把手没展开')
  /*
   * 把手必须**点得到**：上面 PaneGrid 的分割线命中层往外多探 8px，位置正好落在
   * 这条栏的上沿（实测过：栏中心 x=745 也正是一条竖分割线的位置），
   * 而它是绝对定位、栏不是 —— 绘制顺序上就压住了把手，"拖高度"成了"拖分割线"。
   */
  const gripHit = await cdp.eval(
    `(() => { const el = document.querySelector('[data-batch-resizer]'); const r = el.getBoundingClientRect()
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { ok: !!t?.hasAttribute?.('data-batch-resizer'), tag: t?.tagName, cls: String(t?.className ?? '').slice(0, 40) } })()`,
  )
  console.log('把手位置上最顶层的元素:', JSON.stringify(gripHit))
  if (!gripHit.ok) throw new Error(`把手被别的东西盖住了，点不到：${JSON.stringify(gripHit)}`)
  const gridBefore = (await cdp.eval('__probe.grids()')).find((g) => !g.hidden)
  const gridH0 = Math.round(gridBefore.bottom - gridBefore.top)

  // 往上拖 120px：栏变高、终端区变矮（终端由 TerminalView 自己的 ResizeObserver refit）
  const want = 120
  await cdp.mouse('mousePressed', opened.gripX, opened.gripY)
  for (let i = 1; i <= 6; i += 1) {
    await cdp.mouse('mouseMoved', opened.gripX, opened.gripY - (want * i) / 6)
    await sleep(50)
  }
  await cdp.mouse('mouseReleased', opened.gripX, opened.gripY - want, { buttons: 0 })
  await sleep(400)
  const resized = await cdp.eval('__probe.batchBar()')
  const gridAfter = (await cdp.eval('__probe.grids()')).find((g) => !g.hidden)
  const gridH1 = Math.round(gridAfter.bottom - gridAfter.top)
  const stored = await cdp.eval(`window.localStorage.getItem('batchBarHeight')`)
  console.log(`拖高 ${want}px 后: 栏 ${opened.h} → ${resized.h}，终端区 ${gridH0} → ${gridH1}，存下 ${stored}`)
  if (Math.abs(resized.h - (opened.h + want)) > 6) {
    throw new Error(`栏高没跟上拖动：${opened.h} + ${want} ≠ ${resized.h}`)
  }
  if (Math.abs(gridH0 - gridH1 - want) > 6) {
    throw new Error(`终端区没跟着让位：${gridH0} → ${gridH1}（少${gridH0 - gridH1}）`)
  }
  if (Number(stored) !== resized.h) throw new Error(`高度没存进 localStorage：${stored} ≠ ${resized.h}`)
  await cdp.shot('probe-batchbar-1-resized.png')

  /* ---------- 2. 逐行「执行」：第 2 行失败 → 第 3 行已跳过 ---------- */
  await cdp.eval(`__probe.fillBatch('echo one\\necho fail two\\necho three')`)
  await clickSel(cdp, '[data-batch-linebyline]')
  await sleep(150)
  const runBox = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '执行')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
  )
  if (!runBox) throw new Error('找不到「执行」按钮')
  await cdp.mouse('mousePressed', runBox.x, runBox.y)
  await cdp.mouse('mouseReleased', runBox.x, runBox.y)
  await sleep(1600)

  const cards = await cdp.eval('__probe.batchCards()')
  console.log('逐行执行的结果卡:', JSON.stringify(cards))
  await cdp.shot('probe-batchbar-2-linebyline.png')
  if (cards.length !== 2) throw new Error(`应该有 2 张结果卡（两格），实际 ${cards.length}`)
  const text = cards[0].text
  for (const want of ['第 1 行', '第 2 行', '第 3 行', '非零退出', '已跳过', '后面 1 行没跑']) {
    if (!text.includes(want)) throw new Error(`结果里没有「${want}」：${text}`)
  }
  /*
   * 走的是 exec 而不是"整段跑一次"：mock 每条命令回一行 `mock-host: <命令>`，
   * 光看输出认不出来（失败那行本来就没有回显），所以数 mock 收到的 exec 调用：
   * 三行里跑了两行、两格各一遍 → 4 次；整段跑只会是 2 次（每格一次）。
   */
  const execs = await cdp.eval('__probe.execLog()')
  console.log(`exec 调用 ${execs.length} 次:`, JSON.stringify(execs))
  if (execs.length !== 4) throw new Error(`不像逐行：exec 调了 ${execs.length} 次，逐行应该是 4 次`)
  if (execs.some((c) => c.includes('\n'))) {
    throw new Error(`有一条 exec 里塞了好几行（那就是整段跑了）：${JSON.stringify(execs)}`)
  }
  // 格子之间是并行的，所以这 4 条是交错的 —— 按内容数，不按顺序
  const count = (s) => execs.filter((c) => c === s).length
  if (count('echo one') !== 2 || count('echo fail two') !== 2) {
    throw new Error(`两格各该跑前两行各一次：${JSON.stringify(execs)}`)
  }
  if (count('echo three') !== 0) {
    throw new Error(`第 3 行不该被执行（上一行非零退出就该停）：${JSON.stringify(execs)}`)
  }

  /* ---------- 3. 逐行「发送」：按行敲进去，行间等间隔 ---------- */
  await cdp.eval('__probe.clearShellLog()')
  await cdp.eval(`__probe.fillBatch('echo a\\necho b')`)
  await sleep(150)
  const sendBox = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
  )
  if (!sendBox) throw new Error('找不到「发送」按钮')
  await cdp.mouse('mousePressed', sendBox.x, sendBox.y)
  await cdp.mouse('mouseReleased', sendBox.x, sendBox.y)
  await sleep(1500)

  const log = await cdp.eval('__probe.shellLog()')
  console.log('终端收到:', JSON.stringify(log))
  const sentCards = await cdp.eval('__probe.batchCards()')
  console.log('逐行发送的结果卡:', JSON.stringify(sentCards.map((c) => c.text)))
  // 两行 × 两格 = 4 次投递，且每次都以换行结尾（一行就是一条命令）
  const expectLines = ['echo a\n', 'echo b\n']
  if (log.length !== 4) throw new Error(`应该投递 4 次（两行 × 两格），实际 ${log.length}：${JSON.stringify(log)}`)
  for (const want of expectLines) {
    const n = log.filter((l) => l === want).length
    if (n !== 2) throw new Error(`「${want.trim()}」应该各投 2 次（两格），实际 ${n} 次`)
  }
  if ((await cdp.eval(`__probe.countInCards('已按行发送')`)) !== 2) {
    throw new Error(`两张卡都该写「已按行发送」：${JSON.stringify(sentCards.map((c) => c.text))}`)
  }

  /* ---------- 4. 折叠状态下拖那条把手 = 直接把它拉出来 ---------- */
  await clickSel(cdp, '[data-batch-bar] button')
  await sleep(250)
  const shut = await cdp.eval('__probe.batchBar()')
  console.log('折叠回去:', JSON.stringify(shut))
  if (shut.open) throw new Error('点把手没折叠回去')
  const pullTo = 220
  await cdp.mouse('mousePressed', shut.gripX, shut.gripY)
  for (let i = 1; i <= 5; i += 1) {
    await cdp.mouse('mouseMoved', shut.gripX, shut.gripY - (pullTo * i) / 5)
    await sleep(50)
  }
  await cdp.mouse('mouseReleased', shut.gripX, shut.gripY - pullTo, { buttons: 0 })
  await sleep(350)
  const pulled = await cdp.eval('__probe.batchBar()')
  console.log(`从折叠状态往上拖 ${pullTo}px:`, JSON.stringify(pulled))
  if (!pulled.open) throw new Error('拖折叠状态的把手没把它拉出来')
  if (Math.abs(pulled.h - pullTo) > 8) {
    throw new Error(`拉出来的高度不对：${pulled.h}，期望 ≈${pullTo}（高度应当跟拖了多远走）`)
  }
  await cdp.shot('probe-batchbar-3-pulled-open.png')

  // 收尾：把高度恢复默认，别把持久化状态留给后面的场景
  await cdp.eval(`window.localStorage.removeItem('batchBarHeight')`)
  console.log('\n批量执行条探针：全部通过')
}

/** 真按键（带修饰键）。modifiers 是位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift */
async function pressKey(cdp, { key, code, modifiers = 0, vk }) {
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * 模拟一次 **Ctrl+Shift+V**。
 *
 * 不能只发按键事件：CDP 的 `Input.dispatchKeyEvent` 不走浏览器那套编辑器命令，
 * 光发 Ctrl+Shift+V 只会让 xterm 把 `^V` 发给远端（实测，日志里是 "\u0016"），
 * 一点粘贴都不会发生 —— 那样就复现不出这个 bug。
 * `commands: ['pasteAndMatchStyle']` 才是 Chromium 给这个快捷键准备的默认动作
 * （粘贴为纯文本），也就是真机按下时会被执行的那一条。诊断过：只有它能让
 * 页面里真的冒出 `paste` 事件。
 */
async function pressPasteShortcut(cdp) {
  const base = {
    key: 'V',
    code: 'KeyV',
    modifiers: 2 | 8,
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...base,
    commands: ['pasteAndMatchStyle'],
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * 场景：设置面板的「字体族」下拉框
 *
 * 这条链路有四层，探针逐层钉：Rust 给出清单 → `lib/fonts.ts` 标出等宽 → 下拉框过滤/搜索/
 * 勾选 → store 与 localStorage → 终端按新字体重新量格子。
 *
 * 清单在预览里来自 `tauriMock`（假数据），但**等宽与否是真量出来的** ——
 * 所以假清单里挑的都是这台机器上真装了的字体，断言才立得住（Consolas 等宽、
 * Microsoft YaHei 非等宽，都实测过）。
 */
async function scenarioFonts(cdp) {
  const exceptions = () => cdp.logs.filter((l) => l.startsWith('[exception]'))
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  /* ---------- 0. 开一个终端：后面要看字体有没有真的落到终端上 ---------- */
  const host = (await cdp.eval('__probe.hosts()'))[0]
  await cdp.mouse('mousePressed', host.x, host.y)
  await cdp.mouse('mouseReleased', host.x, host.y)
  await waitFor(cdp, `document.querySelectorAll('.xterm canvas').length > 0`, '终端画布')
  await sleep(500)
  /*
   * 记一条异常基线。预览里开终端本身就会冒一条 xterm 内部的
   * `Cannot read properties of undefined (reading 'dimensions')`（Viewport.syncScrollArea，
   * webgl 渲染器在无头下的老问题，跟字体无关）—— 所以这里只盯"换字体的这一段有没有新异常"。
   */
  const excBase = exceptions().length

  /* ---------- 1. 打开设置面板 ---------- */
  // 侧栏可能被上一个场景收起来了（localStorage 是跨场景留着的），设置按钮在侧栏底部
  if (!(await cdp.eval(`!!document.querySelector('[title="主题、终端外观、重连策略、传输默认值"]')`))) {
    const toggle = await cdp.eval(`__probe.buttonBox('侧栏')`)
    if (!toggle) throw new Error('侧栏收着，又找不到状态栏那个「侧栏」按钮')
    await cdp.mouse('mousePressed', toggle.x, toggle.y)
    await cdp.mouse('mouseReleased', toggle.x, toggle.y)
    await sleep(400)
  }
  await clickSelScrolled(cdp, '[title="主题、终端外观、重连策略、传输默认值"]')
  await waitFor(cdp, `!!document.querySelector('[data-font-picker]')`, '设置面板里的字体下拉框')

  /* ---------- 2. 展开：清单读出来了、默认只看等宽 ---------- */
  await clickSelScrolled(cdp, '[data-font-picker]')
  await waitFor(cdp, `__probe.fontPicker().options.length > 1`, '字体清单')
  let picker = await cdp.eval('__probe.fontPicker()')
  console.log('展开后:', JSON.stringify({ ...picker, options: undefined }), '\n  列出的字体:', picker.options.join(' | '))
  if (!picker.options.includes('内置字体栈')) throw new Error('清单里没有「内置字体栈」这一项')
  if (!picker.options.includes('Consolas')) throw new Error('清单里没有 Consolas（mock 里给了它）')
  if (picker.monoOnly !== 'true') throw new Error('「只看等宽」默认该是开的')
  if (picker.options.includes('Microsoft YaHei')) {
    throw new Error('开着「只看等宽」却列出了非等宽的 Microsoft YaHei')
  }
  // 候选行得真用它自己的字体画（多词族名不加引号的话这条 CSS 会被浏览器整条丢掉）
  const rowCss = await cdp.eval(`__probe.fontOptionCss('Cascadia Code')`)
  console.log('候选行上的字体:', rowCss)
  if (!rowCss || !rowCss.includes('Cascadia Code')) {
    throw new Error(`候选行没用自己的字体渲染（font-family 成了 ${rowCss}）—— 多半是族名没加引号`)
  }
  await cdp.shot('probe-fonts-1-picker-open.png')

  /* ---------- 3. 关掉「只看等宽」：非等宽的字体带着标注出现 ---------- */
  await clickSelScrolled(cdp, '[data-font-mono-only]')
  await waitFor(cdp, `__probe.fontPicker().monoOnly === 'false'`, '「只看等宽」关掉')
  picker = await cdp.eval('__probe.fontPicker()')
  console.log('关掉只看等宽:', picker.countText, '·', picker.options.join(' | '))
  if (!picker.options.includes('Microsoft YaHei')) throw new Error('关掉筛选后仍看不到非等宽字体')
  await clickSelScrolled(cdp, '[data-font-mono-only]')
  await sleep(200)

  /* ---------- 4. 搜索过滤 ---------- */
  await typeInto(cdp, '[data-font-search]', 'cons')
  await sleep(300)
  const filtered = await cdp.eval('__probe.fontPicker()')
  console.log('搜「cons」:', filtered.countText, '·', filtered.options.join(' | '))
  if (!filtered.options.includes('Consolas')) throw new Error('搜索把 Consolas 也过滤掉了')
  if (filtered.options.some((o) => o !== '内置字体栈' && !o.toLowerCase().includes('cons'))) {
    throw new Error(`搜索没起作用，还列着无关的字体：${filtered.options.join(' | ')}`)
  }
  await typeInto(cdp, '[data-font-search]', '')
  await sleep(300)

  /* ---------- 5. 挑一个字体：写进 store，并且终端真换了字体 ---------- */
  const before = await cdp.eval('__probe.termMetrics()')
  // 挑 Lucida Console：它的字符格子跟默认栈明显不同（本机实测 32×30 → 32×27），
  // 这样"终端重新量过格子"这件事是能看出来的
  await clickSelScrolled(cdp, '[data-font-option="Lucida Console"]')
  await sleep(600)
  const after = await cdp.eval('__probe.termMetrics()')
  const stored = await cdp.eval(`window.localStorage.getItem('termFontFamily')`)
  picker = await cdp.eval('__probe.fontPicker()')
  console.log(`挑「Lucida Console」: 触发器显示「${picker.trigger}」，本地存 ${stored}`)
  console.log('  终端格子:', JSON.stringify(before), '→', JSON.stringify(after))
  if (picker.trigger !== 'Lucida Console') throw new Error(`触发器上该是选中的字体，实际「${picker.trigger}」`)
  if (stored !== JSON.stringify('Lucida Console')) {
    throw new Error(`localStorage 里该是带引号的字体名，实际 ${stored}`)
  }
  if (picker.open) throw new Error('挑完字体面板该收起来')
  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error('字体没落到终端上：xterm 量出来的格子尺寸一点没变')
  }
  if (after.canvases === 0) throw new Error('终端被换字体搞没了（画布不见了）')

  /* ---------- 6. 再打开：勾在选中的那一项上 ---------- */
  await clickSelScrolled(cdp, '[data-font-picker]')
  await waitFor(cdp, `__probe.fontPicker().options.length > 1`, '再次展开')
  await typeInto(cdp, '[data-font-search]', 'lucida')
  await sleep(300)
  picker = await cdp.eval('__probe.fontPicker()')
  console.log('重新打开并搜 lucida:', JSON.stringify(picker.checked))
  if (!picker.checked.includes('Lucida Console')) throw new Error('选中的字体没有打勾')

  /* ---------- 7. 「自定义…」手写一整串字体栈 ---------- */
  const stack = '"Microsoft YaHei", Consolas, monospace'
  await clickSelScrolled(cdp, '[data-font-custom]')
  await waitFor(cdp, `!!document.querySelector('[data-font-custom-input]')`, '自定义输入框')
  await typeInto(cdp, '[data-font-custom-input]', stack)
  await clickSelScrolled(cdp, '[data-font-custom-apply]')
  await sleep(400)
  const storedStack = await cdp.eval(`window.localStorage.getItem('termFontFamily')`)
  picker = await cdp.eval('__probe.fontPicker()')
  console.log(`自定义字体栈: 本地存 ${JSON.stringify(storedStack)}，触发器显示 ${JSON.stringify(picker.trigger)}`)
  if (storedStack !== stack) throw new Error(`自定义字体栈没存对：${storedStack}`)
  if (picker.trigger !== 'Microsoft YaHei') {
    throw new Error(`触发器该显示栈里第一个字体，实际「${picker.trigger}」`)
  }

  /* ---------- 8. 回到内置栈：存空串 ---------- */
  await clickSelScrolled(cdp, '[data-font-picker]')
  await waitFor(cdp, `__probe.fontPicker().options.length > 1`, '第三次展开')
  await clickSelScrolled(cdp, '[data-font-option="内置字体栈"]')
  await sleep(400)
  const backToBuiltin = await cdp.eval(`window.localStorage.getItem('termFontFamily')`)
  picker = await cdp.eval('__probe.fontPicker()')
  console.log(`选回内置栈: 本地存「${backToBuiltin}」，触发器显示「${picker.trigger}」`)
  if (backToBuiltin !== '') throw new Error(`内置栈该存空串（终端那边空串=用默认栈），实际 ${backToBuiltin}`)
  if (picker.trigger !== '内置字体栈') throw new Error('触发器该显示「内置字体栈」')

  const fresh = exceptions().slice(excBase)
  if (fresh.length) throw new Error('换字体的过程里冒出了页面异常：' + fresh.join(' / '))

  await cdp.shot('probe-fonts-1-picker.png')
  console.log('\n字体下拉框探针：全部通过')
}

/**
 * 场景：终端里粘贴一次会粘两遍
 *
 * 用户报的现象。机制：Chromium 把 **Ctrl+Shift+V** 当成"粘贴为纯文本"的原生快捷键，
 * 而 xterm 的键盘监听是用 `addEventListener` 挂的、自定义处理器的返回值被包装函数丢掉 ——
 * 返回 `false` 只是"这次按键 xterm 不处理"，**不会拦原生默认动作**。于是按一次：
 *   ① 我们的处理 → readText → term.paste（一次）
 *   ② 浏览器默认动作 → 在 xterm 藏的 textarea 上触发 paste 事件 → xterm 自己也贴一次
 * 两条路径各贴一遍 = 粘两遍。Ctrl+V 我们没接管，只有原生那条路，所以它是好的
 * （这也是"只有 Ctrl+Shift+V 会双粘"的原因）。
 */
async function scenarioPaste(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 0', '会话树里的主机行')

  // 开一个终端标签，等通道起来（mock 里 ssh_open_shell 60ms + banner 200ms）
  const host = (await cdp.eval('__probe.hosts()'))[0]
  await cdp.mouse('mousePressed', host.x, host.y)
  await cdp.mouse('mouseReleased', host.x, host.y)
  await waitFor(cdp, '__probe.tabs().length > 0', '一个终端标签')
  await sleep(1200)

  // 点一下终端，让 xterm 的 textarea 拿到焦点
  await clickSel(cdp, '.xterm')
  await sleep(300)

  /* ---------- 0. 自检：普通按键真的会走到"后端" ---------- */
  await cdp.eval('__probe.clearShellLog()')
  await pressKey(cdp, { key: 'a', code: 'KeyA', vk: 65 })
  await sleep(500)
  const typed = await cdp.eval('__probe.shellLog()')
  console.log('敲一个 a 之后的输入:', JSON.stringify(typed))
  if (!typed.join('').includes('a')) {
    throw new Error('普通按键没走到后端 —— 后面关于粘贴次数的结论都不可信')
  }

  /* ---------- 1. 往真剪贴板放一个标记串 ---------- */
  const wrote = await cdp.eval(`(async () => {
    try {
      await navigator.clipboard.writeText('PASTE-ME')
      return 'ok'
    } catch (e) {
      return String(e)
    }
  })()`)
  console.log('写剪贴板:', wrote)
  if (wrote !== 'ok') throw new Error('剪贴板写不进去，没法验原生粘贴那条路：' + wrote)

  /** 数一次操作到底把内容发出去几遍 */
  const countPaste = async (label) => {
    const log = (await cdp.eval('__probe.shellLog()')).join('')
    const stats = await cdp.eval('__probe.pasteStats()')
    const hits = log.split('PASTE-ME').length - 1
    console.log(`${label}: 发出去 ${hits} 遍 · readText ${stats.readText} 次 · 原生 paste 事件 ${stats.pasteEvents} 次`)
    return { hits, stats, log }
  }

  /* ---------- 2. 右键菜单的「粘贴」：只有我们这一条路径 ---------- */
  await cdp.eval('__probe.watchPaste()')
  await cdp.eval('__probe.clearShellLog()')
  const term = await boxOf(cdp, '.xterm')
  await cdp.rightClick(term.x, term.y)
  await sleep(300)
  console.log('打开菜单时焦点:', await cdp.eval('__probe.activeEl()'))
  await clickMenuItem(cdp, 'term-paste')
  await sleep(700)
  const viaMenu = await countPaste('右键菜单「粘贴」')
  if (viaMenu.hits !== 1) {
    throw new Error(`右键菜单的粘贴应该只粘一次，实际 ${viaMenu.hits} 次`)
  }
  const focusAfterMenu = await cdp.eval('__probe.activeEl()')
  console.log('用完菜单后焦点:', focusAfterMenu)
  if (!String(focusAfterMenu).includes('xterm')) {
    throw new Error(`用完菜单后焦点没回到终端（现在是 ${focusAfterMenu}）—— 接着敲键盘一个字都进不去`)
  }

  /* ---------- 3. 被报的那条：Ctrl+Shift+V ---------- */
  await cdp.eval('__probe.watchPaste()')
  await cdp.eval('__probe.clearShellLog()')
  await pressPasteShortcut(cdp)
  await sleep(700)
  const viaKey = await countPaste('Ctrl+Shift+V')
  if (viaKey.hits !== 1) {
    throw new Error(`Ctrl+Shift+V 应该只粘一次，实际 ${viaKey.hits} 次`)
  }
  // 两条路径叠加时，hits（发出去几遍）已经拦在上面了；这两条是为了把"病根"说清楚
  if (viaKey.stats.readText !== 1) {
    throw new Error(`我们自己应该读一次剪贴板，实际 ${viaKey.stats.readText} 次`)
  }
  if (viaKey.stats.pasteEvents !== 0) {
    throw new Error(
      `原生粘贴路径没被拦住（paste 事件 ${viaKey.stats.pasteEvents} 次）—— 会和我们的处理各贴一遍`,
    )
  }

  console.log('\n粘贴探针：全部通过')
}

const want = process.argv[2] ?? 'all'
const { cdp, proc } = await launch()

/**
 * 放行剪贴板读写。
 *
 * 页面对 `navigator.clipboard.readText()` 需要 `clipboard-read` 权限，浏览器会弹框问 ——
 * 无头下等于直接拒，于是"我们的粘贴路径"一点内容都读不到，测出来的是假象。
 * 写（writeText）默认就放行，读必须显式授权。
 */
try {
  await cdp.send('Browser.grantPermissions', {
    origin: new URL(PAGE).origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  })
  console.log('已放行剪贴板读写权限')
} catch (e) {
  console.log('放行剪贴板权限失败（后面的粘贴计数可能不可信）:', e.message)
}

try {
  // newline 依赖 drag（底部那条把手只有多格标签才有），所以它顺手先把 drag 跑一遍。
  // 其余每个场景开头都自己 navigate，所以 all 里顺序无所谓
  if (want === 'all' || want === 'drag' || want === 'newline') await scenarioDragTab(cdp)
  if (want === 'all' || want === 'newline') await scenarioNewlineOnly(cdp)
  if (want === 'all' || want === 'tags') await scenarioTags(cdp)
  if (want === 'all' || want === 'sessiondrag') await scenarioSessionDrag(cdp)
  if (want === 'all' || want === 'rightpanel') await scenarioRightPanel(cdp)
  if (want === 'rename') await scenarioTabRename(cdp)
  if (want === 'all' || want === 'menu') await scenarioContextMenu(cdp)
  if (want === 'all' || want === 'connect') await scenarioConnectForm(cdp)
  if (want === 'all' || want === 'paste') await scenarioPaste(cdp)
  if (want === 'all' || want === 'sidebar') await scenarioSidebar(cdp)
  if (want === 'all' || want === 'dropzone') await scenarioDropZone(cdp)
  if (want === 'all' || want === 'batchbar') await scenarioBatchBar(cdp)
  if (want === 'all' || want === 'fonts') await scenarioFonts(cdp)
} catch (e) {
  console.error('探针失败:', e)
  console.log('--- 页面控制台 ---')
  for (const l of cdp.logs.slice(-40)) console.log(l)
} finally {
  await cdp.send('Browser.close').catch(() => {})
  proc.kill()
}
