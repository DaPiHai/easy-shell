//! 批量执行：在一条**已认证**的 SSH 会话上开 exec 通道跑一条命令，把结果收回来。
//!
//! 为什么单独成模块：终端那条 shell 通道要 PTY、要攒帧往前端推、要一直活着；
//! exec 通道是「发一条命令 → 收 stdout / stderr / 退出码 → 关掉」的一次性动作。
//! 两种生命周期塞进 `ssh.rs` 会让那里同时管长跑和短跑，通道账本更难对。
//!
//! **这里只管"跑一条"，不管"跑几台、跑哪几台"**。连不连、并发几台、失败重不重试
//! 都是前端的事：哪台主机已经连着（`Tab.panes` 上的 sessionId）只有前端知道，
//! 后端替用户决定"要不要复用现有连接"就会在没连过的主机上凭空多拨一次。

use std::time::Duration;

use russh::client::Msg;
use russh::Channel;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;
use tokio::time::timeout;

use crate::decode::ShellDecoder;
use crate::ssh::SshState;

/// 没给时限时的默认值。
///
/// 30 秒：`df -h`、`systemctl status` 这类采集命令绰绰有余，又不至于让一台
/// 挂死的机器把整批拖住 —— 批量是并发跑的，卡住一台就白占一个槽位。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 上限一小时。再长就不是"批量采集"了，那是把批量面板当终端用。
const MAX_TIMEOUT: Duration = Duration::from_secs(3600);

/**
 * 把前端给的秒数夹成时限。
 *
 * 0 按"没给"处理：0 秒意味着命令必然超时，那是不小心填出来的值，
 * 不是用户的真实意图（真想立刻超时得自己按停止）。
 */
fn clamp_timeout(secs: Option<u64>) -> Duration {
    match secs {
        Some(0) | None => DEFAULT_TIMEOUT,
        Some(s) => Duration::from_secs(s).min(MAX_TIMEOUT),
    }
}

/// 一条命令在一台机器上的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /** 退出码。命令被信号杀掉、连接中途断掉、或者超时掐断时都拿不到 —— 别猜成 0 */
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    /** 到了时限还没跑完：输出是**截断**的，别当完整结果看 */
    pub timed_out: bool,
}

/**
 * 收集器：把通道消息分进 stdout / stderr / 退出码三个桶。
 *
 * 抽出来是为了能单测"哪类消息进哪个桶、什么时候算结束" —— 这两件事靠读代码
 * 推演不可靠（`ExtendedData` 是不是 stderr、退出码之后还会不会有数据），
 * 而打真服务端验证每种组合太慢。
 */
struct Sink {
    out: String,
    err: String,
    dec_out: ShellDecoder,
    dec_err: ShellDecoder,
    exit_code: Option<u32>,
}

impl Sink {
    fn new() -> Self {
        Self {
            out: String::new(),
            err: String::new(),
            dec_out: ShellDecoder::new(),
            dec_err: ShellDecoder::new(),
            exit_code: None,
        }
    }

    /// 喂一条通道消息，返回「这条消息意味着这次执行结束了没」
    fn feed(&mut self, msg: ChannelMsg) -> bool {
        match msg {
            ChannelMsg::Data { data } => {
                let text = self.dec_out.push(&data[..]);
                self.out.push_str(&text);
                false
            }
            // SSH 协议里 stderr 走的是 extended data（类型 1）
            ChannelMsg::ExtendedData { data, .. } => {
                let text = self.dec_err.push(&data[..]);
                self.err.push_str(&text);
                false
            }
            // 退出码之后服务端可能还要补最后一段输出，所以这里**不能**结束
            ChannelMsg::ExitStatus { exit_status } => {
                self.exit_code = Some(exit_status);
                false
            }
            ChannelMsg::Eof | ChannelMsg::Close => true,
            _ => false,
        }
    }

    /// 流已结束：把解码器里攒着的尾巴冲出来
    fn finish(mut self) -> (String, String) {
        self.out.push_str(&self.dec_out.finish());
        self.err.push_str(&self.dec_err.finish());
        (self.out, self.err)
    }
}

/**
 * 收一条 exec 通道的输出，直到结束或超时。
 *
 * 抽成 pub 是为了让集成测试能打真服务端验证「退出码之后还有数据」「stderr 走
 * extended data」这两件事（`tests/e2e.rs`）—— 它们靠读协议推演不可靠，
 * 而每次找真服务器手动点太慢。开通道那段留在 `ssh_exec` 里，测试的假服务端自己开。
 */
pub async fn collect_exec(channel: &mut Channel<Msg>, limit: Duration) -> ExecResult {
    let mut sink = Sink::new();
    // 超时按整条命令算，不是按"两次数据之间的间隔"算：
    // 一条跑了 29 秒才吐第一个字节的命令，跟卡死的命令是两回事
    let finished = timeout(limit, async {
        loop {
            match channel.wait().await {
                Some(msg) => {
                    if sink.feed(msg) {
                        return
                    }
                }
                // 通道已经关了：服务端没给 eof 也可能是正常结束（有的设备只发 close）
                None => return,
            }
        }
    })
    .await
    .is_ok();

    // exec 是一次性的，命令跑完服务端自己会发 eof。这里主动 close 只是把
    // "我也不要了"说清楚，失败无所谓（连接可能已经断了）
    let _ = channel.close().await;

    let exit_code = sink.exit_code;
    let (stdout, stderr) = sink.finish();
    ExecResult {
        exit_code,
        stdout,
        stderr,
        timed_out: !finished,
    }
}

/**
 * 在一条已经连着的会话上跑一条命令（批量执行的后端那一半）。
 *
 * `timeout_secs` 不传就是 30 秒，0 同样按 30 秒算（见 `clamp_timeout`）。
 */
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, SshState>,
    session_id: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, String> {
    let limit = clamp_timeout(timeout_secs);

    // 只有开通道这段要抓着 handle。整条命令期间都持有的话，同一会话上的终端
    // （敲字、resize）会被一起堵住 —— 批量跑一条慢命令时那台机器的终端就跟着卡住了
    let mut channel = {
        let sessions = state.sessions.lock().await;
        let entry = sessions
            .get(&session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        let handle = entry.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 exec 通道失败: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("发送命令失败: {e}"))?;
        channel
    };

    Ok(collect_exec(&mut channel, limit).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(text: &str) -> ChannelMsg {
        ChannelMsg::Data {
            data: text.as_bytes().to_vec().into(),
        }
    }

    fn extended(text: &str) -> ChannelMsg {
        ChannelMsg::ExtendedData {
            data: text.as_bytes().to_vec().into(),
            ext: 1,
        }
    }

    /// 没给时限时用默认值；0 按没给处理 —— 那是不小心填出来的值
    #[test]
    fn 时限缺省与_zero_都按默认() {
        assert_eq!(clamp_timeout(None), DEFAULT_TIMEOUT);
        assert_eq!(clamp_timeout(Some(0)), DEFAULT_TIMEOUT);
        assert_eq!(clamp_timeout(Some(15)), Duration::from_secs(15));
    }

    #[test]
    fn 时限夹到上限() {
        assert_eq!(clamp_timeout(Some(86400)), MAX_TIMEOUT);
    }

    /// stdout 与 stderr 必须分开：批量面板靠这个把「命令本身报错」和
    /// 「命令写到标准错误的告警」分开显示，混在一起就分不清成功失败了
    #[test]
    fn 标准输出与标准错误分开收() {
        let mut sink = Sink::new();
        assert!(!sink.feed(data("hello")));
        assert!(!sink.feed(extended("boom")));
        let (out, err) = sink.finish();
        assert_eq!(out, "hello");
        assert_eq!(err, "boom");
    }

    /**
     * 退出码之后还可能跟着数据。
     *
     * 真 sshd 的顺序是 data… → exit-status → eof，把退出码当成"结束信号"会
     * 丢掉最后一段输出 —— 而最后一段往往正是报错的那几行。
     */
    #[test]
    fn 退出码之后还能接着收数据() {
        let mut sink = Sink::new();
        assert!(!sink.feed(ChannelMsg::ExitStatus { exit_status: 7 }));
        assert!(!sink.feed(data("tail output")));
        assert!(sink.feed(ChannelMsg::Eof));
        let exit_code = sink.exit_code;
        let (out, err) = sink.finish();
        assert_eq!(out, "tail output");
        assert_eq!(err, "");
        assert_eq!(exit_code, Some(7));
    }

    /// eof 与 close 都算结束；其余消息（比如窗口变更）不该被当成结束
    #[test]
    fn 只有_eof_和_close_结束这一轮() {
        let mut sink = Sink::new();
        assert!(!sink.feed(ChannelMsg::Success));
        assert!(sink.feed(ChannelMsg::Close));

        let mut other = Sink::new();
        assert!(other.feed(ChannelMsg::Eof));
    }

    /// 结果序列化成前端读的 camelCase
    #[test]
    fn 结果序列化成前端认得的形状() {
        let v = serde_json::to_value(ExecResult {
            exit_code: Some(1),
            stdout: "out".into(),
            stderr: "err".into(),
            timed_out: false,
        })
        .expect("序列化失败");
        assert_eq!(v["exitCode"], 1);
        assert_eq!(v["stdout"], "out");
        assert_eq!(v["timedOut"], false);
    }
}
