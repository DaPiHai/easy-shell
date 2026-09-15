import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 出错时顶上来的一句人话，别只甩个堆栈 */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * 兜住子树里的渲染 / effect 异常。
 *
 * 为什么需要：终端那套（xterm + WebGL + 各种 addon）在特定机器上会炸，
 * 之前炸了就只剩一个纯黑的框，用户既看不出是崩了也看不出为啥。
 * 有了这个，至少把错误原因和堆栈拍在屏幕上，方便定位。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[easy-shell] 界面出错:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="h-full w-full overflow-auto bg-canvas p-4">
        <div className="mb-2 text-[13px] font-medium text-danger">
          {this.props.label ?? '这个面板出错了'}
        </div>
        <pre className="whitespace-pre-wrap break-all rounded-md border border-danger/40 bg-danger/5 p-3 text-[12px] leading-relaxed text-ink-muted">
          {error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-3 rounded-md border border-hairline bg-surface-2 px-3 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          重试
        </button>
      </div>
    )
  }
}