import { useCallback, useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { openSearchPanel } from '@codemirror/search'
import type { EditorView as CodeMirrorView } from '@codemirror/view'
import { Check, Loader2, Save, Search } from 'lucide-react'
import {
  localReadText,
  localWriteText,
  sftpReadText,
  sftpWriteText,
  type EditorTarget,
} from '@/lib/api'
import { useApp } from '@/lib/store'

const readFile = (t: EditorTarget) =>
  t.side === 'remote'
    ? sftpReadText(t.sftpId!, t.path)
    : localReadText(t.path)

const writeFile = (t: EditorTarget, content: string) =>
  t.side === 'remote'
    ? sftpWriteText(t.sftpId!, t.path, content)
    : localWriteText(t.path, content)

/** 按文件名猜语言，猜不出就当纯文本（不加高亮） */
function useLanguage(fileName: string) {
  const [support, setSupport] = useState<LanguageSupport | null>(null)

  useEffect(() => {
    let alive = true
    const desc = LanguageDescription.matchFilename(languages, fileName)
    if (!desc) {
      setSupport(null)
      return
    }
    void desc.load().then((lang) => {
      if (alive) setSupport(lang)
    })
    return () => {
      alive = false
    }
  }, [fileName])

  return support
}

export function EditorView({ target, tabId }: { target: EditorTarget; tabId?: string }) {
  const setError = useApp((s) => s.setError)
  const theme = useApp((s) => s.theme)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const support = useLanguage(target.path.split(/[\\/]/).pop() ?? target.path)

  // 内容放 ref 里，好让键盘快捷键拿到最新值而不必重挂监听
  const contentRef = useRef('')
  contentRef.current = content
  const targetRef = useRef(target)
  targetRef.current = target
  /**
   * 已保存内容的 ref 版本。
   *
   * 守卫的 isDirty 会被 store 在"关标签"那一刻同步调用，那时拿 state 可能还没重渲染；
   * 存完之后也显式更新它，避免连点两下时读到旧值。
   */
  const originalRef = useRef('')
  originalRef.current = original

  /**
   * CodeMirror 的 EditorView 实例，给工具栏的「查找」按钮用。
   *
   * 查找面板是 CodeMirror 自带的（`@codemirror/search`），但它的入口只有 Ctrl+F ——
   * 工具栏上没有任何按钮，等于"知道才用得上"。这里拿到 view 就能调 `openSearchPanel`。
   * 注意 `@uiw/react-codemirror` 只 re-export view / state / basic-setup，**不含 search**，
   * 所以那个包是本项目的直接依赖（版本必须与 @uiw 用的那份去重，见 AGENTS.md）。
   */
  const cmViewRef = useRef<CodeMirrorView | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void readFile(target)
      .then((text) => {
        if (!alive) return
        setContent(text)
        setOriginal(text)
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.path, target.side])

  /**
   * 真正落盘的那一步。返回 null 表示成功，字符串是错误文案 ——
   * 关标签的守卫要的是"成没成 + 为什么不成"，不能像按钮那样只 toast 一下就完事。
   */
  const saveOnce = useCallback(async (): Promise<string | null> => {
    setSaving(true)
    setSaved(false)
    try {
      await writeFile(targetRef.current, contentRef.current)
      originalRef.current = contentRef.current
      setOriginal(contentRef.current)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return null
    } catch (e) {
      return String(e)
    } finally {
      setSaving(false)
    }
  }, [])

  const save = useCallback(async () => {
    const failure = await saveOnce()
    if (failure) setError(failure)
  }, [saveOnce, setError])

  /**
   * 把"脏不脏 / 怎么存"交给 store，关标签时它要同步问。
   * guard 对象只随 tabId 注册一次，内部一律读 ref —— 注册时若跟着内容变，
   * 每敲一个字都会 set 一次 store，全应用跟着重渲染。
   */
  useEffect(() => {
    if (!tabId) return
    const guard = {
      isDirty: () => contentRef.current !== originalRef.current,
      save: saveOnce,
    }
    useApp.getState().registerEditorGuard(tabId, guard)
    return () => useApp.getState().unregisterEditorGuard(tabId)
  }, [tabId, saveOnce])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const dirty = content !== original

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-ink-tertiary">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="truncate text-[12px] text-ink-muted">
          {target.path.split(/[\\/]/).pop()}
        </span>
        <span className="truncate text-[11px] text-ink-tertiary">{target.path}</span>
        {dirty && <span className="shrink-0 text-[11px] text-warning">未保存</span>}
        {/*
          查找/替换面板的入口。CodeMirror 的面板本来只能按 Ctrl+F 叫出来，
          工具栏上没有任何痕迹 —— 跟终端里的查找是同一类问题（功能在，入口不存在）。
        */}
        <button
          onClick={() => {
            const view = cmViewRef.current
            if (!view) return
            try {
              if (!openSearchPanel(view)) {
                setError('打不开查找面板 —— 编辑器可能还没就绪，稍后再试')
              }
            } catch (e) {
              // 面板打不开不该把整个标签带崩，说清楚就行
              setError(`打不开查找面板：${String(e)}`)
            }
          }}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          title="在文件里查找 / 替换（Ctrl+F）"
        >
          <Search size={12} />
          查找
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="flex shrink-0 items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          title="Ctrl+S"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" />
          ) : saved ? (
            <Check size={12} className="text-success" />
          ) : (
            <Save size={12} />
          )}
          {saved ? '已保存' : '保存'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={content}
          height="100%"
          extensions={support ? [support] : []}
          onChange={(v) => setContent(v)}
          theme={theme === 'dark' ? 'dark' : 'light'}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            autocompletion: false,
          }}
          // 拿到 view 才能用工具栏的「查找」调 openSearchPanel。
          // 语言包加载完 extensions 会变，@uiw 重建 view 时这里会再回调一次，ref 跟着更新
          onCreateEditor={(view) => {
            cmViewRef.current = view
          }}
          className="h-full text-[13px]"
        />
      </div>
    </div>
  )
}
