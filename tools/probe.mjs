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

/** 页面里那些会用到的小工具（注入一次，后面直接调） */
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

const want = process.argv[2] ?? 'all'
const { cdp, proc } = await launch()
try {
  if (want === 'all' || want === 'drag' || want === 'newline') await scenarioDragTab(cdp)
  if (want === 'all' || want === 'newline') await scenarioNewlineOnly(cdp)
  if (want === 'all' || want === 'tags') await scenarioTags(cdp)
  if (want === 'rename') await scenarioTabRename(cdp)
} catch (e) {
  console.error('探针失败:', e)
  console.log('--- 页面控制台 ---')
  for (const l of cdp.logs.slice(-40)) console.log(l)
} finally {
  await cdp.send('Browser.close').catch(() => {})
  proc.kill()
}
