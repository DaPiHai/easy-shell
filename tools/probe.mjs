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
 *   node tools/probe.mjs rename         # 只跑「双击标签改名」
 *
 * 环境变量：EDGE_PATH / PROBE_PORT / PROBE_URL 可覆盖默认值。
 * 截图落在 `.workbuddy-ai/shots/`（该目录不进版本库）。
 *
 * 场景里用到的 DOM 约定（改 UI 时留意，探针断了多半是这里变了）：
 *   - 标签栏的标签：`div[title]` 且 class 含 `h-9` + `cursor-pointer`
 *   - 会话树主机行的可点区：`div[title="点击连接"]`
 *   - 会话树过滤框：`[data-host-filter]`；标签快捷条：`[data-tag-filter="<标签>"]`
 *   - 主机行里的标签 chip：`[data-tag-chip]`；主机行编辑按钮：`[data-host-edit="<hostId>"]`
 *   - 分组块：`[data-group-id]`（未分组用空串），组里有几台 = 里面 `[data-host-edit]` 的个数
 *   - 终端窗口：`[data-pane-grid]`，格数 = 里面 `[data-pane-title]` 的个数
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
    return [...document.querySelectorAll('div[title="点击连接"]')].map((el) => {
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
    return [...document.querySelectorAll('div[title="点击连接"]')].map((el) => el.textContent)
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
 * 用户报的：收起之后整块内容变黑，只剩窗口标题栏。侧栏的收起状态存在 localStorage，
 * 所以"刷新一下就黑"也能复现 —— 这条比点按钮更值得验，用户重启后就是这么撞上的。
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

  await clickSel(cdp, 'aside button[title^="收起侧栏"]')
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

  /* 刷新一次（收起状态是持久化的）也得是好的 */
  await cdp.send('Page.reload')
  await sleep(1500)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.tabs().length > 0 || document.body.innerText.length > 0', '刷新后')
  await sleep(800)
  const reloaded = await cdp.eval('__probe.layout()')
  console.log('收起状态下刷新:', JSON.stringify(reloaded))
  if (reloaded.docScroll[1] > reloaded.inner[1] + 1) {
    throw new Error('收起状态下刷新，整页还是被撑破：' + JSON.stringify(reloaded.docScroll))
  }
  await cdp.shot('probe-sidebar-2-reloaded.png')

  // 收尾：展开回去，别把持久化状态留给后面的场景
  await cdp.eval(`window.localStorage.setItem('sidebarCollapsed', '0')`)
  console.log('\n侧栏探针：全部通过')
}

/**
 * 场景：多分屏窗口里的拖拽落点
 *
 * 用户报的：多分屏时"特殊显示的区域"不对 —— 高亮盖住的那一格，
 * 并不是新格子真正会落下的位置。
 */
async function scenarioDropZone(cdp) {
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(1200)
  await cdp.eval(HELPERS)
  await waitFor(cdp, '__probe.hosts().length > 2', '至少三台主机')

  const hosts = await cdp.eval('__probe.hosts()')
  for (const h of hosts.slice(0, 3)) {
    await cdp.mouse('mousePressed', h.x, h.y)
    await cdp.mouse('mouseReleased', h.x, h.y)
    await sleep(500)
  }
  await waitFor(cdp, '__probe.tabs().length >= 3', '三个标签')

  /** 把某个标签拖到 (x,y) 上，按住不松 */
  const dragTabTo = async (tab, x, y) => {
    await cdp.mouse('mousePressed', tab.x, tab.y)
    await sleep(60)
    for (let i = 1; i <= 10; i += 1) {
      const t = i / 10
      await cdp.mouse('mouseMoved', tab.x + (x - tab.x) * t, tab.y + (y - tab.y) * t)
      await sleep(40)
    }
    await sleep(250)
  }

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
  await dragTabTo(tabs[2], halfX, midY)
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
  await dragTabTo(src, hoverX, hoverY)
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

  console.log('\n多分屏落点探针：全部通过')
}

const want = process.argv[2] ?? 'all'
const { cdp, proc } = await launch()
try {
  if (want === 'all' || want === 'drag' || want === 'newline') await scenarioDragTab(cdp)
  if (want === 'all' || want === 'newline') await scenarioNewlineOnly(cdp)
  if (want === 'all' || want === 'tags') await scenarioTags(cdp)
  if (want === 'rename') await scenarioTabRename(cdp)
  if (want === 'all' || want === 'menu') await scenarioContextMenu(cdp)
  if (want === 'all' || want === 'connect') await scenarioConnectForm(cdp)
  if (want === 'sidebar') await scenarioSidebar(cdp)
  if (want === 'dropzone') await scenarioDropZone(cdp)
  // 这两个也进 all：它们各自先 navigate，不会互相污染；侧栏那条结尾会把 localStorage 复位
  if (want === 'all') {
    await scenarioSidebar(cdp)
    await scenarioDropZone(cdp)
  }
} catch (e) {
  console.error('探针失败:', e)
  console.log('--- 页面控制台 ---')
  for (const l of cdp.logs.slice(-40)) console.log(l)
} finally {
  await cdp.send('Browser.close').catch(() => {})
  proc.kill()
}
