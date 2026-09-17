import { useEffect, useState } from 'react'
import { Play, Plus, Trash2, X } from 'lucide-react'
import { useApp } from '@/lib/store'
import {
  snippetsDelete,
  snippetsList,
  snippetsSave,
  type SnippetRecord,
} from '@/lib/api'

const inputClass =
  'h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

const labelClass = 'mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle'

export function SnippetsDialog() {
  const { snippetsOpen, setSnippetsOpen, activeTabId, setError } = useApp()

  const [list, setList] = useState<SnippetRecord[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  useEffect(() => {
    if (!snippetsOpen) return
    void snippetsList().then(setList).catch((e: unknown) => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippetsOpen])

  if (!snippetsOpen) return null

  const close = () => setSnippetsOpen(false)

  const add = async () => {
    if (!name.trim() || !command.trim()) {
      setError('名称和命令都要填')
      return
    }
    try {
      await snippetsSave({ id: crypto.randomUUID(), name: name.trim(), command: command.trim() })
      setList(await snippetsList())
      setName('')
      setCommand('')
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (id: string) => {
    await snippetsDelete(id)
    setList(await snippetsList())
  }

  /** 把命令塞进当前终端并回车执行 */
  const send = (snippet: SnippetRecord) => {
    const sink = activeTabId ? useApp.getState().terminalSinks[activeTabId] : undefined
    if (!sink) {
      setError('当前标签不是终端，先切到一个终端标签')
      return
    }
    sink(`${snippet.command}\n`)
    close()
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="absolute left-1/2 top-[16%] w-[520px] -translate-x-1/2 rounded-xl border border-hairline-tertiary bg-surface-1">
        <div className="flex h-11 items-center justify-between border-b border-hairline px-4">
          <span className="text-[13px] font-medium text-ink">命令片段</span>
          <button
            onClick={close}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4">
          <p className="mb-3 text-[12px] leading-relaxed text-ink-subtle">
            发送 = 把命令写进当前终端并回车。带 sudo 之类的命令记得自己先确认一遍。
          </p>

          <div className="mb-3 flex gap-2">
            <div className="w-40">
              <label className={labelClass}>名称</label>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="查看磁盘"
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>命令</label>
              <input
                className={inputClass}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                placeholder="df -h"
              />
            </div>
            <button
              onClick={() => void add()}
              className="mt-[22px] h-8 shrink-0 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus"
            >
              <Plus size={13} className="inline" /> 添加
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-hairline">
            {list.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-ink-tertiary">还没有保存的片段</p>
            ) : (
              list.map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center gap-2 border-b border-hairline px-3 py-2 last:border-b-0 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{s.name}</div>
                    <div className="truncate font-mono text-[11px] text-ink-tertiary">
                      {s.command}
                    </div>
                  </div>
                  <button
                    onClick={() => send(s)}
                    className="shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-accent"
                    title="发送到当前终端"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    onClick={() => void remove(s.id)}
                    className="shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
