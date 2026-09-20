/**
 * 剪贴板读写。
 *
 * 原来只有一个 `copyText` 藏在 `TerminalView.tsx` 里，现在终端、会话树、SFTP 文件行、
 * 内置编辑器都要复制东西，而"读不到剪贴板时该说哪句话"必须全应用一致 ——
 * 分散开写迟早变成「快捷键能粘、菜单点了没反应」这种查不出来的差异。
 */
import { useApp } from './store'

/**
 * 复制到剪贴板。
 *
 * 优先用 clipboard API，某些 webview 里它没权限（需要用户手势 + 安全上下文），
 * 这时退回 execCommand —— 老接口虽然废弃，但在 WebView2 里反而更可靠。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 接着走 fallback */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

/**
 * 读剪贴板。
 *
 * 返回 null = 剪贴板确实是空的；**抛出异常** = 压根读不到（webview 的权限限制）。
 * 两者要分开：空的没什么好说的，读不到则必须告诉用户「改用快捷键」，
 * 否则就是"点了没反应"。所以这里不吞异常，由调用方决定怎么说。
 */
export async function readClipboardText(): Promise<string | null> {
  const text = await navigator.clipboard.readText()
  return text || null
}

/**
 * 复制并只在**失败**时吭声。
 *
 * 成功时静默是有意的：跟终端里 Ctrl+Shift+C 的观感保持一致，也免得每次复制都弹一句话。
 * 但失败必须说话 —— 静默的失败等于"点了没反应"，用户只会以为是自己没选中东西。
 */
export function copyQuietly(text: string): void {
  void copyText(text).then((ok) => {
    if (ok) return
    // 提示里只提键盘那条路，不提原生右键菜单 —— 那是我们刚换掉的东西
    useApp.getState().setError('复制失败，试试 Ctrl+C')
  })
}
