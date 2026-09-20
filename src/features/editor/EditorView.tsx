import { useCallback, useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { openSearchPanel } from '@codemirror/search'
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import type { EditorView as CodeMirrorView } from '@codemirror/view'
import {
  Check,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Loader2,
  RefreshCw,
  Redo2,
  Save,
  Scissors,
  Search,
  Undo2,
} from 'lucide-react'
import {
  localReadText,
  localWriteText,
  sftpReadText,
  sftpWriteText,
  type EditorTarget,
} from '@/lib/api'
import { useApp } from '@/lib/store'
import { copyQuietly, readClipboardText } from '@/lib/clipboard'
import { ContextMenu, menuAt, sep, type MenuEntry } from '@/components/ContextMenu'

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

  /** 编辑器区域的右键菜单 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  /**
   * 拿 CodeMirror 的 view 干一件事。
   *
   * 每次都现取 `cmViewRef`，不在闭包里存一份 —— 语言包是异步加载的，加载完
   * `@uiw` 会重建 view，存下来的那份会指向已经作废的实例。
   * 拿不到就说一句，别静默什么都不做（"点了一动不动"是最难报的 bug）。
   */
  const withView = (fn: (view: CodeMirrorView) => void) => {
    const view = cmViewRef.current
    if (!view) {
      setError('编辑器还没就绪，稍后再试')
      return
    }
    fn(view)
  }

  /** 当前选中的内容（没选就是空串） */
  const selectionOf = (view: CodeMirrorView) => {
    const { from, to } = view.state.selection.main
    return { from, to, text: view.state.sliceDoc(from, to) }
  }

  /** 用一段文本替换选中内容，光标落到插入内容之后 */
  const replaceSelection = (view: CodeMirrorView, text: string) => {
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    })
    // 菜单关掉之后焦点得回到编辑器，否则接着敲键盘哪儿都不去
    view.focus()
  }

  /**
   * 重新从磁盘（远端则从 SFTP）读一遍，丢掉没保存的改动。
   *
   * `originalRef` 必须**同步**更新 —— 关标签的守卫读的是它，等 React 重渲染就晚了。
   */
  const reload = () => {
    useApp.getState().setConfirmPrompt({
      kind: 'confirm',
      danger: true,
      title: '重新载入？',
      message: '没保存的改动会丢掉，内容回到文件里的那一份。',
      confirmLabel: '重新载入',
      onConfirm: () => {
        void readFile(targetRef.current)
          .then((text) => {
            originalRef.current = text
            setContent(text)
            setOriginal(text)
          })
          .catch((e: unknown) => setError(String(e)))
      },
    })
  }

  /**
   * 编辑器的右键菜单。
   *
   * 这里**必须**自绘：编辑区是 contenteditable，而 App 里那条全局兜底对
   * contenteditable 是放行的（输入框的原生菜单有用）—— 于是不接管的话，
   * 用户看到的是「撤销/复制/粘贴」混着「打印/检查」那一份。
   * 那几项正是这里要的，所以照着做一遍、把不相关的去掉。
   */
  const menuItems: MenuEntry[] = [
    {
      label: '撤销',
      hint: 'Ctrl+Z',
      testId: 'editor-undo',
      icon: <Undo2 size={13} className="shrink-0 text-ink-tertiary" />,
      // 没得撤销时灰掉，而不是点了没反应
      disabled: !cmViewRef.current || undoDepth(cmViewRef.current.state) === 0,
      onSelect: () => withView((v) => void undo(v)),
    },
    {
      label: '重做',
      hint: 'Ctrl+Y',
      testId: 'editor-redo',
      icon: <Redo2 size={13} className="shrink-0 text-ink-tertiary" />,
      disabled: !cmViewRef.current || redoDepth(cmViewRef.current.state) === 0,
      onSelect: () => withView((v) => void redo(v)),
    },
    sep(),
    {
      label: '剪切',
      hint: 'Ctrl+X',
      testId: 'editor-cut',
      icon: <Scissors size={13} className="shrink-0 text-ink-tertiary" />,
      onSelect: () =>
        withView((v) => {
          const { text } = selectionOf(v)
          if (!text) return
          copyQuietly(text)
          replaceSelection(v, '')
        }),
    },
    {
      label: '复制',
      hint: 'Ctrl+C',
      testId: 'editor-copy',
      icon: <Copy size={13} className="shrink-0 text-ink-tertiary" />,
      disabled: !cmViewRef.current || !selectionOf(cmViewRef.current).text,
      onSelect: () => withView((v) => copyQuietly(selectionOf(v).text)),
    },
    {
      label: '粘贴',
      hint: 'Ctrl+V',
      testId: 'editor-paste',
      icon: <ClipboardPaste size={13} className="shrink-0 text-ink-tertiary" />,
      onSelect: () =>
        withView((v) => {
          void readClipboardText()
            .then((text) => {
              if (text) replaceSelection(v, text)
            })
            .catch(() => setError('读不到剪贴板内容，试试 Ctrl+V'))
        }),
    },
    {
      label: '全选',
      hint: 'Ctrl+A',
      testId: 'editor-select-all',
      onSelect: () =>
        withView((v) => {
          v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
          v.focus()
        }),
    },
    sep(),
    {
      label: '保存',
      hint: 'Ctrl+S',
      testId: 'editor-save',
      icon: <Save size={13} className="shrink-0 text-ink-tertiary" />,
      disabled: saving || !dirty,
      onSelect: () => void save(),
    },
    {
      label: '复制文件路径',
      testId: 'editor-copy-path',
      icon: <ClipboardCopy size={13} className="shrink-0 text-ink-tertiary" />,
      onSelect: () => copyQuietly(target.path),
    },
    // 没有改动就谈不上"丢弃改动"，整个入口收起来
    ...(dirty
      ? [
          sep(),
          {
            label: '重新载入（丢弃改动）',
            testId: 'editor-reload',
            danger: true,
            icon: <RefreshCw size={13} className="shrink-0" />,
            onSelect: reload,
          } satisfies MenuEntry,
        ]
      : []),
  ]

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

      {/*
        右键菜单挂在这一层而不是 CodeMirror 内部：CM 的 DOM 会被语言包/主题变化重建，
        挂进去的监听会跟着没。这里 cover 整个编辑区，右键落在哪一行都算。
      */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onContextMenu={(e) => {
          const at = menuAt(e)
          if (at) setMenu(at)
        }}
      >
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
