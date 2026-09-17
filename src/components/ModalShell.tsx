import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * 自绘弹窗的外壳：遮罩 + 居中面板 + 头部 + 底部按钮行。
 *
 * 抽出来是因为弹窗已经从 2 种长到 5 种，外壳再各写一遍就会出现
 * 「这个框 top-[16%]、那个 top-[18%]」这种谁也说不清的偏差。
 * Esc / 点遮罩关闭由 `App.tsx` 的全局 keydown 与这里的 onClose 分别负责。
 */
export function ModalShell({
  icon,
  title,
  subtitle,
  width = 480,
  children,
  onClose,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  /** 面板宽度，默认 480。窄一点的信息（输入框）用 420 更紧凑 */
  width?: number
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/*
        面板限高 + 内容区自己滚：设置面板比别的弹窗长得多，
        窗口最小高度是 560，不限高的话底部的按钮会顶出屏幕、够不着。
      */}
      <div
        className="absolute left-1/2 top-[16%] flex max-h-[76vh] -translate-x-1/2 flex-col rounded-xl border border-hairline-tertiary bg-surface-1"
        style={{ width }}
      >
        <div className="flex shrink-0 items-start gap-2.5 border-b border-hairline px-4 py-3">
          {icon}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">{title}</div>
            {subtitle && (
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{subtitle}</div>
            )}
          </div>
          <button
            onClick={onClose}
            title="关闭"
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

/** 底部按钮行：右对齐，间距一致 */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2">{children}</div>
}

/** 次按钮（取消） */
export const modalButton =
  'h-8 rounded-md border border-hairline bg-surface-2 px-3 text-[13px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink'

/** 主按钮 */
export const modalPrimaryButton =
  'h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus disabled:opacity-50'

/** 危险按钮（删除、丢弃改动） */
export const modalDangerButton =
  'h-8 rounded-md border border-danger/40 bg-danger/10 px-3 text-[13px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50'
