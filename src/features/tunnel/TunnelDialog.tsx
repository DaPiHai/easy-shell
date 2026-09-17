import { useEffect, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { useApp } from '@/lib/store'
import { tunnelList, tunnelStart, tunnelStop, type TunnelInfo } from '@/lib/api'

const inputClass =
  'h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

const labelClass = 'mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle'

export function TunnelDialog() {
  const { tunnelOpen, setTunnelOpen, tabs, setError } = useApp()

  const [list, setList] = useState<TunnelInfo[]>([])
  const [sessionId, setSessionId] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('')
  const [busy, setBusy] = useState(false)

  const sshTabs = tabs.filter((t) => t.kind === 'terminal' && t.sessionId)

  useEffect(() => {
    if (!tunnelOpen) return
    void tunnelList().then(setList)
    if (!sessionId && sshTabs[0]?.sessionId) setSessionId(sshTabs[0].sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelOpen])

  if (!tunnelOpen) return null

  const close = () => setTunnelOpen(false)

  const start = async () => {
    const lp = Number(listenPort)
    const rp = Number(remotePort)
    if (!sessionId) {
      setError('需要先连上一个 SSH 会话')
      return
    }
    if (!lp || !rp || !remoteHost) {
      setError('监听端口、远端主机、远端端口都要填')
      return
    }
    setBusy(true)
    try {
      await tunnelStart(sessionId, lp, remoteHost, rp)
      setList(await tunnelList())
      setListenPort('')
      setRemotePort('')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (id: number) => {
    await tunnelStop(id)
    setList(await tunnelList())
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="absolute left-1/2 top-[16%] w-[460px] -translate-x-1/2 rounded-xl border border-hairline-tertiary bg-surface-1">
        <div className="flex h-11 items-center justify-between border-b border-hairline px-4">
          <span className="text-[13px] font-medium text-ink">端口转发</span>
          <button
            onClick={close}
            className="grid h-5 w-5 place-items-center rounded text-ink-subtle hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4">
          <p className="mb-3 text-[12px] leading-relaxed text-ink-subtle">
            把本地端口的流量经 SSH 隧道转发到远端地址。监听地址固定为本机 127.0.0.1。
          </p>

          <div className="mb-3">
            <label className={labelClass}>走哪个会话</label>
            <select
              className={inputClass}
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              {sshTabs.length === 0 && <option value="">没有已连接的会话</option>}
              {sshTabs.map((t) => (
                <option key={t.id} value={t.sessionId}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-4 flex items-end gap-2">
            <div className="w-24">
              <label className={labelClass}>本地端口</label>
              <input
                className={inputClass}
                value={listenPort}
                onChange={(e) => setListenPort(e.target.value)}
                placeholder="8080"
              />
            </div>
            <span className="pb-2 text-ink-tertiary">→</span>
            <div className="flex-1">
              <label className={labelClass}>远端主机</label>
              <input
                className={inputClass}
                value={remoteHost}
                onChange={(e) => setRemoteHost(e.target.value)}
              />
            </div>
            <div className="w-24">
              <label className={labelClass}>远端端口</label>
              <input
                className={inputClass}
                value={remotePort}
                onChange={(e) => setRemotePort(e.target.value)}
                placeholder="80"
              />
            </div>
            <button
              onClick={() => void start()}
              disabled={busy}
              className="h-8 shrink-0 rounded-md bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover active:bg-accent-focus disabled:opacity-50"
            >
              <Plus size={13} className="inline" /> 添加
            </button>
          </div>

          <div className="rounded-md border border-hairline">
            {list.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-ink-tertiary">还没有转发规则</p>
            ) : (
              list.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 border-b border-hairline px-3 py-2 last:border-b-0"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  <span className="font-mono text-[12px] text-ink-muted">
                    127.0.0.1:{t.listenPort}
                  </span>
                  <span className="text-ink-tertiary">→</span>
                  <span className="font-mono text-[12px] text-ink-muted">
                    {t.remoteHost}:{t.remotePort}
                  </span>
                  <button
                    onClick={() => void stop(t.id)}
                    className="ml-auto shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-3 hover:text-danger"
                    title="停止转发"
                  >
                    <Trash2 size={12} />
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
