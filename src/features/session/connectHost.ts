import { parseConnectError, sshConnect, type HostRecord } from '@/lib/api'
import { useApp } from '@/lib/store'

/**
 * `compatOverride` 供确认框里的「用兼容算法重试」把兼容模式强开一次；
 * 平时走 host.compat —— 那是保存时勾了兼容模式的主机，不带上等于白存。
 */
export function hostToConfig(host: HostRecord, compatOverride?: boolean) {
  return {
    host: host.address,
    port: host.port,
    username: host.username,
    password: host.auth.type === 'password' ? host.auth.password : undefined,
    privateKeyPath: host.auth.type === 'key' ? host.auth.privateKeyPath : undefined,
    passphrase: host.auth.type === 'key' ? (host.auth.passphrase ?? undefined) : undefined,
    compat: compatOverride ?? host.compat ?? false,
  }
}

interface Options {
  /** 已经"忘掉旧密钥"重试过一次就别再弹窗了，否则会死循环 */
  retried?: boolean
  forceCompat?: boolean
}

/**
 * 连一台主机，连上之后交给调用方处置。
 *
 * 三条失败路径的处理（主机密钥变了 / 算法谈不拢 / 其它）与重试的往返逻辑都在这里，
 * 调用方只提供「会话拿到后放哪儿」——开一条新标签，还是塞进某个格子。
 * 分开写两份的话，迟早只有一份会跟着确认框的改动更新。
 */
export async function connectHost(
  host: HostRecord,
  onConnected: (sessionId: string) => void,
  options: Options = {},
): Promise<void> {
  const { retried = false, forceCompat = false } = options
  const s = useApp.getState()
  try {
    const sessionId = await sshConnect(hostToConfig(host, forceCompat))
    onConnected(sessionId)
  } catch (e) {
    const failure = parseConnectError(e)
    if (failure.kind === 'host_key_mismatch' && !retried) {
      s.setConfirmPrompt({
        kind: 'host_key_mismatch',
        host: failure.host,
        detail: failure.detail,
        retry: () => void connectHost(host, onConnected, { retried: true }),
      })
      return
    }
    /**
     * 算法谈不拢时给一条出路，而不是只甩一段红字。
     *
     * compatHint 为 false 说明重试也是白试（对面只要 ssh-dss 主机密钥，
     * 或者卡在 mac / 压缩上 —— 兼容模式不放开这两类），那就别浪费用户一次点击。
     */
    if (failure.kind === 'algorithms_unsupported' && failure.compatHint && !retried) {
      s.setConfirmPrompt({
        kind: 'algo_compat',
        message: failure.message,
        retry: () => void connectHost(host, onConnected, { retried: true, forceCompat: true }),
      })
      return
    }
    s.setError(`连接 ${host.name} 失败：${failure.message}`)
  }
}
