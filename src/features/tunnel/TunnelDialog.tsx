import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { panesOf, useApp } from '@/lib/store'
import { hostEndpoint, hostLabel } from '@/lib/hosts'
import { tunnelList, tunnelStart, tunnelStop, type TunnelInfo } from '@/lib/api'

const inputClass =
  'h-8 w-full rounded-md border border-hairline bg-surface-3 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent'

const labelClass = 'mb-1.5 block text-[11px] font-medium tracking-[0.4px] text-ink-subtle'

export function TunnelDialog() {
  const { tunnelOpen, setTunnelOpen, tabs, deadPanes, hosts, activeTabId, setError } = useApp()

  const [list, setList] = useState<TunnelInfo[]>([])
  const [sessionId, setSessionId] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * 能走隧道的会话 = **每一格活着的远程终端**。
   *
   * 早先这里读的是 `tab.sessionId`，而终端标签的连接在 `panes` 里（`tab.sessionId` 只有
   * SFTP / 编辑器标签用）—— 于是不管连了多少台，下拉框永远只有「没有已连接的会话」。
   * 分屏下一个标签有好几条会话，得逐格收；断线的格子不算（那条连接已经废了）。
   * 按 sessionId 去重：新格子继承的是同一条会话，一条连接只该出现一次。
   * 当前标签排在最前面，默认选中的就是用户眼前这一屏。
   */
  const targets = useMemo(() => {
    const ordered = [...tabs].sort((a, b) => Number(b.id === activeTabId) - Number(a.id === activeTabId))
    const seen = new Set<string>()
    const out: Array<{ sessionId: string; label: string; where: string }> = []
    for (const tab of ordered) {
      const panes = panesOf(tab)
      panes.forEach((p, i) => {
        if (!p.sessionId || deadPanes[p.id] || seen.has(p.sessionId)) return
        seen.add(p.sessionId)
        const host = hosts.find((h) => h.id === p.hostId)
        // 分屏才写第几格：单格标签重复一遍「第 1 格」只是噪音（和批量执行面板同一套写法）
        const name = host ? hostLabel(host) : p.title
        const label = panes.length > 1 ? `${name} · 第 ${i + 1} 格` : name
        out.push({ sessionId: p.sessionId, label, where: host ? hostEndpoint(host) : '' })
      })
    }
    return out
  }, [tabs, deadPanes, hosts, activeTabId])

  useEffect(() => {
    if (!tunnelOpen) return
    void tunnelList().then(setList)
  }, [tunnelOpen])

  // 对话框开着的时候连上/断开主机也要跟着变：选中的会话可能已经废了，也可能刚连上一条
  useEffect(() => {
    if (!tunnelOpen) return
    if (targets.some((t) => t.sessionId === sessionId)) return
    setSessionId(targets[0]?.sessionId ?? '')
  }, [tunnelOpen, targets, sessionId])

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
              {targets.length === 0 && <option value="">没有已连接的会话</option>}
              {targets.map((t) => (
                <option key={t.sessionId} value={t.sessionId}>
                  {t.where ? `${t.label} · ${t.where}` : t.label}
                </option>
              ))}
            </select>
            {targets.length === 0 && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-tertiary">
                端口转发要复用一条已认证的 SSH 连接，先连上一台主机（Ctrl+N）。
              </p>
            )}
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
                  className="border-b border-hairline px-3 py-2 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        t.lastError ? 'bg-danger' : 'bg-success'
                      }`}
                    />
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
                  {/* 规则看着是"活着"的（端口确实在监听），但每次连接都被对面拒掉 ——
                      不把原因摆出来，用户只会以为是自己填错了目标地址 */}
                  {t.lastError && (
                    <p className="mt-1 pl-3.5 text-[11px] leading-relaxed text-danger">
                      转发被服务端拒绝：{t.lastError}
                      <br />
                      常见原因是对方 sshd 关了 AllowTcpForwarding，或不允许连这个目标。
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
