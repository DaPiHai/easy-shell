import { useCallback, useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Check, Loader2, Save } from 'lucide-react'
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

export function EditorView({ target }: { target: EditorTarget }) {
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

  const save = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    try {
      await writeFile(targetRef.current, contentRef.current)
      setOriginal(contentRef.current)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }, [setError])

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
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
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
          className="h-full text-[13px]"
        />
      </div>
    </div>
  )
}
