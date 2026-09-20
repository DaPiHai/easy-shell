import type { HostRecord } from './api'

/**
 * 主机的展示规则与标签规则。
 *
 * 收在一个文件里是因为这几条规则**到处都要用同一份**：会话树、命令面板、
 * 批量执行、标签标题、以及"改了名字之后把标题同步过去"。抄成好几份的话，
 * 迟早只有一份会跟着改 —— 上一轮 `useDismiss` 那个 bug 就是这么来的。
 */

/* ---------------- 名称 ---------------- */

/**
 * 这台主机在界面上该叫什么。
 *
 * `name` 是**用户起的名字**，可以是空串（＝没起名）。注意不能拿
 * `name === address` 判断"没起名"：早先的版本把 IP 直接写进了 name，
 * 老库里那批记录看着像起过名，其实没有。
 *
 * 没起名时回退成 `用户名@地址` —— 那是这个程序里"一台机器"最自然的说法，
 * 也是分屏标题条一直在用的写法。
 */
export function hostLabel(host: Pick<HostRecord, 'name' | 'username' | 'address'>): string {
  return host.name || `${host.username}@${host.address}`
}

/** 这台的完整落点，用在确认框的明细里 */
export function hostEndpoint(host: Pick<HostRecord, 'username' | 'address' | 'port'>): string {
  return `${host.username}@${host.address}:${host.port}`
}

/* ---------------- 标签 ---------------- */

/** 一个主机最多挂几个标签。后端 `store.rs` 里的 `MAX_TAGS_PER_HOST` 是同一个数 */
export const MAX_TAGS_PER_HOST = 20
/** 单个标签最长几个字符（按字符数，中文标签不该被腰斩） */
export const MAX_TAG_CHARS = 32

/**
 * 一行输入 -> 标签表。逗号 / 顿号 / 分号 / 空白都当分隔符。
 *
 * 和 `store.rs` 的 `normalize_tags` 走同一套规则（去空白、丢空串、去重、截断）：
 * 前端这份是为了让输入框下面即时显示的就是**最终存下去的样子**，
 * 后端那份是因为不能信任调用方。两边都留着是有意的。
 */
export function parseTags(input: string): string[] {
  const out: string[] = []
  for (const raw of input.split(/[,，、;；\s]+/)) {
    const tag = raw.trim().slice(0, MAX_TAG_CHARS).trim()
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_TAGS_PER_HOST) break
  }
  return out
}

/** 标签表 -> 输入框里的一行文本 */
export function tagsToInput(tags: string[] | undefined): string {
  return (tags ?? []).join(', ')
}

/**
 * 标签的配色。**按文本算一个稳定的档，不存颜色** —— 存的话就得再维护一份
 * "标签 → 颜色"的映射，改名之后还得跟着搬。同一台机器上看到的 `prod`
 * 和另一台上的 `prod` 因此天然同色。
 *
 * 这几条是完整的类名字面量：Tailwind 只会生成它在源码里**看得见**的类名，
 * 拼字符串（`bg-\${x}/15`）出来的一律不生成。
 */
const TAG_TONES = [
  'bg-accent/15 text-accent',
  'bg-success/15 text-success',
  'bg-warning/15 text-warning',
  'bg-danger/15 text-danger',
  'bg-ink-subtle/20 text-ink-muted',
] as const

export function tagTone(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) | 0
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length]
}

/** 这台主机有没有某个标签（不区分大小写，跟筛选框的手感保持一致） */
export function hasTag(host: Pick<HostRecord, 'tags'>, tag: string): boolean {
  const want = tag.toLowerCase()
  return (host.tags ?? []).some((t) => t.toLowerCase() === want)
}

/**
 * 关键词 / 标签能不能同时命中这台主机。
 *
 * `keyword` 匹配名称、地址、用户名、标签（任何一个命中就算）；`tag` 是
 * 从标签快捷条点出来的精确筛选，两者是**与**的关系 —— 先按标签圈一批，
 * 再在里面搜关键词，这是用户按下这两下时脑子里想的事。
 */
export function matchesHost(
  host: HostRecord,
  keyword: string,
  tag: string | null,
): boolean {
  if (tag && !hasTag(host, tag)) return false
  const kw = keyword.trim().toLowerCase()
  if (!kw) return true
  const haystack = [host.name, host.address, host.username, ...(host.tags ?? [])]
  return haystack.some((s) => s.toLowerCase().includes(kw))
}
