import { CircleHelp } from 'lucide-react'

/**
 * 「这儿还有说明」的小问号：鼠标停上去（或键盘 focus）才展开。
 *
 * 为什么不做成常驻小字：对话框里每多一段两行说明，下面真正要填的字段就被顶下去一屏。
 * 说明基本只在第一次用时需要，而第一次用的人会去 hover 那个问号。
 *
 * 说明走原生 `title`，跟全站一致（没有自造 tooltip 组件，这里也不起一个）。
 * 只把 title 挂在这个图标上、不另外挂在父 label 上：一处来源，改的时候不会漏。
 */
export function InfoHint({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      title={text}
      aria-label={text}
      className="ml-1 inline-flex cursor-help align-middle text-ink-tertiary transition-colors hover:text-ink-subtle focus:text-ink-subtle focus:outline-none"
    >
      <CircleHelp size={11} />
    </span>
  )
}
