use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use russh::client::{self, AuthResult, Config, Handle, Handler};
use russh::{cipher, kex, AlgorithmKind, Preferred};
use russh::ChannelMsg;

use crate::batcher::FrameBatcher;
use crate::known_hosts::{take_mismatch, KeyCheck, KnownHosts};
use crate::sftp::SftpState;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tauri::State;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

const POLL_TIMEOUT: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    /// 兼容模式：额外接受一批已废弃但仍被老交换机/路由器依赖的算法
    /// （dh-group1/14-sha1、aes*-cbc、3des-cbc）。
    ///
    /// 默认关 —— 这些算法有已知弱点，不该为了"能连"就把所有连接都降级。
    /// 只有明确知道对面是老设备时才勾。
    #[serde(default)]
    pub compat: bool,
}

fn default_port() -> u16 {
    22
}

/**
 * 构造算法优先表。
 *
 * 兼容模式追加的废弃算法一律放在**末尾**：SSH 协商挑的是客户端列表里第一个
 * 双方都支持的，放末尾意味着现代设备照旧选 chacha20 / curve25519，
 * 不会因为"要兼容老设备"就把日常连接一起拖回 3des-cbc。顺序是刻意的，别挪。
 *
 * 主机密钥算法不在追加范围内 —— russh 压根没实现 ssh-dss，加上也连不上。
 * 这是能力边界，不是配置问题（见 `algo_failure` 里对 ssh-dss 的专门说明）。
 */
fn preferred(compat: bool) -> Preferred {
    if !compat {
        return Preferred::DEFAULT;
    }

    let mut kex = Preferred::DEFAULT.kex.to_vec();
    // dh-group14/group1-sha1：老交换机和路由器的标配
    kex.extend([kex::DH_G14_SHA1, kex::DH_G1_SHA1, kex::DH_GEX_SHA1]);

    let mut cipher = Preferred::DEFAULT.cipher.to_vec();
    // 只加 aes-cbc，不加 3des-cbc：后者被 russh 的 `des` feature 门控着，
    // 而且 64 位块长的 3des 有 SWEET32 实锤攻击，为了连老设备引入一个已知破的
    // 算法不划算。真撞上只支持 3des 的设备再单独权衡。
    cipher.extend([cipher::AES_256_CBC, cipher::AES_192_CBC, cipher::AES_128_CBC]);

    Preferred {
        kex: Cow::Owned(kex),
        cipher: Cow::Owned(cipher),
        ..Preferred::DEFAULT
    }
}

/**
 * 把 russh 的 NoCommonAlgo 翻译成人话。
 *
 * 单独抽出来是为了能单测：起一个只支持废弃算法的服务端很麻烦，而真正要守住的是
 * 这些分支判断，不是网络往返。
 */
fn algo_failure(kind: &AlgorithmKind, ours: &[String], theirs: &[String]) -> ConnectError {
    let theirs_joined = theirs.join(", ");
    let ours_joined = ours.join(", ");

    // 主机密钥算法谈不拢时 compat 帮不上忙（它只动 kex 和 cipher），得另说
    if matches!(kind, AlgorithmKind::Key) {
        // 对面只肯用 ssh-dss 是死局：russh 没实现它，重试多少次都一样。
        // 必须挑明，否则用户会以为是自己密码打错了。
        if !theirs.is_empty() && theirs.iter().all(|a| a.contains("dss")) {
            return ConnectError::AlgorithmsUnsupported {
                compat_hint: false,
                message: format!(
                    "算法协商失败：这台设备只提供 ssh-dss 主机密钥。\n\
                     ssh-dss 早已被废弃，本项目依赖的 russh 没有实现它，无法连接。\n\
                     服务端支持：{theirs_joined}\n\
                     建议：在设备上改用 rsa 或 ecdsa 主机密钥后再连。"
                ),
            };
        }
        return ConnectError::AlgorithmsUnsupported {
            compat_hint: false,
            message: format!(
                "算法协商失败：双方没有共同的主机密钥算法。\n\
                 服务端支持：{theirs_joined}\n\
                 我们支持：{ours_joined}\n\
                 兼容模式只放开密钥交换和加密算法，救不了主机密钥 —— 需要在设备上启用我们支持的密钥类型。"
            ),
        };
    }

    let what = match kind {
        AlgorithmKind::Kex => "密钥交换算法",
        AlgorithmKind::Cipher => "加密算法",
        AlgorithmKind::Mac => "消息认证算法",
        AlgorithmKind::Compression => "压缩算法",
        AlgorithmKind::Key => unreachable!("上面已经处理"),
    };

    // 只有 kex / cipher 是 compat 能救的；mac 与压缩默认列表已经够宽
    let compat_hint = matches!(kind, AlgorithmKind::Kex | AlgorithmKind::Cipher);

    let tail = if compat_hint {
        "这台设备可能比较老 —— 可以用兼容模式（放开 dh-group1/14-sha1 与 aes-cbc）再试一次。"
    } else {
        "兼容模式不放开这一类算法，重试没有意义。"
    };

    ConnectError::AlgorithmsUnsupported {
        compat_hint,
        message: format!(
            "算法协商失败：双方没有共同的{what}。\n\
             服务端支持：{theirs_joined}\n\
             我们支持：{ours_joined}\n\
             {tail}"
        ),
    }
}

/// 前端兜底用的标记。
///
/// Tauri 把 `Err` 传回去时，理论上保留我们序列化的对象，但万一哪天被压成
/// 字符串，前端还能靠这个前缀认出"是密钥不匹配"，不至于退化成一句没救的红字。
pub const MISMATCH_MARK: &str = "__HOST_KEY_MISMATCH__";

/// 建连失败的原因。
///
/// 为什么要分类型而不是一律 String：主机密钥不匹配时前端必须能给出
/// "忘掉旧密钥并重连"这个补救动作。只甩一句红字的话，用户连一台重装过的
/// 服务器都再也连不上 —— 除非手动去删 known_hosts 文件。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectError {
    /// 主机密钥变了：可能是中间人，也可能是服务器重装了
    HostKeyMismatch { host: String, detail: String },
    /**
     * 算法协商谈不拢。老设备的典型症状。
     *
     * `compat_hint` 为 true 表示"换兼容模式再试一次"有可能通；
     * false 表示这台设备要的东西我们根本没有（比如 ssh-dss），重试无意义。
     * 前端据此决定要不要给"用兼容算法重试"这个按钮 —— 给了却救不活更糟。
     */
    AlgorithmsUnsupported {
        message: String,
        #[serde(rename = "compatHint")]
        compat_hint: bool,
    },
    /// 其余情况，前端把 message 显示出来就行
    Other { message: String },
}

impl ConnectError {
    pub fn other(message: impl Into<String>) -> Self {
        ConnectError::Other {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::HostKeyMismatch { host, detail } => {
                write!(f, "{MISMATCH_MARK} {host}\n{detail}")
            }
            ConnectError::AlgorithmsUnsupported { message, .. } => f.write_str(message),
            ConnectError::Other { message } => f.write_str(message),
        }
    }
}

/// 连接时要记住"这仗打的是谁"，check_server_key 才知道该查哪条记录
pub struct ClientHandler {
    host_key: String,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // known_hosts 没初始化（比如集成测试）就退回全盘接受
        let Some(known) = KnownHosts::global() else {
            return Ok(true)
        };

        // 证书那条路返回的是 &KeyData，跟 &PublicKey 不是一回事，得转成同一种类型
        let key: russh::keys::PublicKey = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().clone().into()
            }
        };
        let Ok(openssh) = key.to_openssh() else {
            return Ok(true)
        };

        match known.check(&self.host_key, &openssh) {
            KeyCheck::Matches => Ok(true),
            KeyCheck::Unknown => {
                // TOFU：第一次见就记下并放行
                if let Err(e) = known.add(&self.host_key, &openssh) {
                    eprintln!("写入 known_hosts 失败: {e}");
                }
                Ok(true)
            }
            KeyCheck::Mismatch { expected } => {
                // 密钥变了。要么服务器重装了，要么有人在中间 —— 两种情况都该拦一下
                eprintln!(
                    "警告：{} 的主机密钥变了！\n  记录的是: {}\n  现在收到: {}\n\
                     如果确认服务器重装过，删掉 known_hosts 里这一行再连。",
                    self.host_key, expected, openssh
                );
                Ok(false)
            }
        }
    }
}

enum ShellCmd {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum ShellEvent {
    #[serde(rename = "data")]
    Data { data: String },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "closed")]
    Closed,
}

pub(crate) struct SessionEntry {
    /// Arc 包一层，好让端口转发之类的长任务 clone 出去自己用
    pub(crate) handle: Arc<Mutex<Handle<ClientHandler>>>,
    /// 保存连接参数，断线后用它自动重连
    config: ConnectConfig,
}

#[derive(Default)]
pub struct SshState {
    pub(crate) sessions: Mutex<HashMap<String, SessionEntry>>,
    /// Arc 包一层：shell 任务结束时得自己把通道摘掉，否则会漏（见 ssh_open_shell）
    channels: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ShellCmd>>>>,
    channel_owners: Arc<Mutex<HashMap<u32, String>>>,
    next_channel_id: AtomicU32,
}

/// 建连 + 认证。抽成 pub 是为了让集成测试能直接打真实 SSH 服务端验证这条链路
pub async fn connect_and_auth(config: &ConnectConfig) -> Result<Handle<ClientHandler>, ConnectError> {
    // keepalive 这里**刻意不开**。
    //
    // 开着的代价：russh 的 alive_timeouts 只在收到服务端数据时才清零，一旦对方
    // 不回 keepalive@openssh.com（不少非 OpenSSH 的设备是静默忽略的），
    // 一个空闲几分钟的终端会被判 KeepaliveTimeout 直接掐断 —— 正在跑的东西就没了。
    // 误杀的代价远大于"探出半开连接"的收益，所以默认关。
    // TODO: 真要做半开检测，应该做成连接级可配项，并且只在用户显式开启时才发。
    let cfg = Arc::new(Config {
        preferred: preferred(config.compat),
        ..Config::default()
    });

    let addr = (config.host.as_str(), config.port);

    let handler = ClientHandler {
        host_key: format!("{}:{}", config.host, config.port),
    };
    // 主机密钥不匹配时 russh 只给个通用错误，把详情捞出来拼上
    let handle = match client::connect(cfg, addr, handler).await {
        Ok(h) => h,
        Err(e) => {
            // 算法谈不拢要第一个认出来：这句话决定用户下一步做什么。
            // 甩一句通用的"连接失败"会让人去查密码和网络，方向全错。
            if let russh::Error::NoCommonAlgo { kind, ours, theirs } = &e {
                return Err(algo_failure(kind, ours, theirs));
            }
            return Err(match take_mismatch() {
                Some(detail) => ConnectError::HostKeyMismatch {
                    host: format!("{}:{}", config.host, config.port),
                    detail,
                },
                None => ConnectError::other(format!(
                    "连接 {}:{} 失败: {e}",
                    config.host, config.port
                )),
            });
        }
    };
    let mut handle = handle;

    if let Some(password) = &config.password {
        let result = handle
            .authenticate_password(config.username.as_str(), password.as_str())
            .await
            .map_err(|e| ConnectError::other(format!("认证失败: {e}")))?;
        match result {
            AuthResult::Success => {}
            _ => return Err(ConnectError::other("密码认证被拒绝")),
        }
    } else if let Some(path) = &config.private_key_path {
        let key = russh::keys::load_secret_key(path, config.passphrase.as_deref())
            .map_err(|e| ConnectError::other(format!("读取私钥失败: {e}")))?;
        let with_alg = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
        let result = handle
            .authenticate_publickey(config.username.as_str(), with_alg)
            .await
            .map_err(|e| ConnectError::other(format!("密钥认证失败: {e}")))?;
        match result {
            AuthResult::Success => {}
            _ => return Err(ConnectError::other("密钥认证被拒绝")),
        }
    } else {
        return Err(ConnectError::other("必须提供密码或私钥"));
    }

    Ok(handle)
}

/// 通知并清掉属于某个会话的所有 shell 通道
async fn drop_channels(state: &SshState, session_id: &str) {
    let mut channels = state.channels.lock().await;
    let mut owners = state.channel_owners.lock().await;
    let owned: Vec<u32> = owners
        .iter()
        .filter(|(_, owner)| owner.as_str() == session_id)
        .map(|(id, _)| *id)
        .collect();
    for id in owned {
        if let Some(tx) = channels.remove(&id) {
            let _ = tx.send(ShellCmd::Close);
        }
        owners.remove(&id);
    }
}

/// 关掉单个 shell 通道 + 回收 channelId。
/// 如果这个 session 名下再没有别的通道了，整个 SSH 连接也一起断掉。
async fn drop_one_channel(state: &SshState, channel_id: u32) -> Option<String> {
    let tx = state.channels.lock().await.remove(&channel_id);
    if let Some(tx) = tx {
        let _ = tx.send(ShellCmd::Close);
    }
    let owner = state.channel_owners.lock().await.remove(&channel_id)?;
    // 数一下这个 session 还剩几条通道 —— 没了就连锅端掉，免得资源漏
    let still_has_channels = state
        .channel_owners
        .lock()
        .await
        .values()
        .any(|s| s == &owner);
    if !still_has_channels {
        if let Some(entry) = state.sessions.lock().await.remove(&owner) {
            let handle = entry.handle.lock().await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
    Some(owner)
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, SshState>,
    config: ConnectConfig,
) -> Result<String, ConnectError> {
    let handle = connect_and_auth(&config).await?;

    let id = Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(
        id.clone(),
        SessionEntry {
            handle: Arc::new(Mutex::new(handle)),
            config,
        },
    );

    Ok(id)
}

/// 用保存的参数重新连接，替换掉已经失效的 handle。前端拿到成功结果后
/// 再调一次 ssh_open_shell 即可恢复终端。
#[tauri::command]
pub async fn ssh_reconnect(state: State<'_, SshState>, session_id: String) -> Result<(), ConnectError> {
    let config = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .ok_or_else(|| ConnectError::other("会话不存在，无法重连"))?
            .config
            .clone()
    };

    drop_channels(&state, &session_id).await;
    let handle = connect_and_auth(&config).await?;

    let sessions = state.sessions.lock().await;
    if let Some(entry) = sessions.get(&session_id) {
        let mut guard = entry.handle.lock().await;
        *guard = handle;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_open_shell(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
    on_data: IpcChannel<ShellEvent>,
) -> Result<u32, String> {
    let mut channel = {
        let sessions = state.sessions.lock().await;
        let entry = sessions.get(&session_id).ok_or("会话不存在或已断开")?;
        let handle = entry.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开会话通道失败: {e}"))?
    };

    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("请求 PTY 失败: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("请求 shell 失败: {e}"))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
    let channel_id = state.next_channel_id.fetch_add(1, Ordering::SeqCst);
    state.channels.lock().await.insert(channel_id, tx);
    state
        .channel_owners
        .lock()
        .await
        .insert(channel_id, session_id);

    // 让 shell 任务能在自己退出时把通道摘掉
    let channels = state.channels.clone();
    let owners = state.channel_owners.clone();

    tauri::async_runtime::spawn(async move {
        let mut batch = FrameBatcher::new();
        // batch 当参数传而不是捕获进来：不然可变借用会跟下面的 push 打架
        let flush = |batch: &mut FrameBatcher| {
            if let Some(frame) = batch.take() {
                let _ = on_data.send(ShellEvent::Data {
                    data: B64.encode(&frame[..]),
                });
            }
        };

        loop {
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    ShellCmd::Input(bytes) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            flush(&mut batch);
                            let _ = on_data.send(ShellEvent::Error {
                                message: format!("写入失败: {e}"),
                            });
                            return;
                        }
                    }
                    ShellCmd::Resize { cols, rows } => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    ShellCmd::Close => {
                        flush(&mut batch);
                        let _ = channel.close().await;
                        return;
                    }
                }
            }

            if batch.ready() {
                flush(&mut batch);
            }

            match tokio::time::timeout(POLL_TIMEOUT, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => batch.push(&data[..]),
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => batch.push(&data[..]),
                Ok(Some(ChannelMsg::ExitStatus { .. })) => {}
                Ok(Some(ChannelMsg::Eof | ChannelMsg::Close)) => {
                    // 退出前把攒着的尾巴发出去，别丢最后几个字节
                    flush(&mut batch);
                    let _ = on_data.send(ShellEvent::Closed);
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    flush(&mut batch);
                    let _ = on_data.send(ShellEvent::Closed);
                    break;
                }
                // 超时说明这一轮没数据了，攒着的发掉，别让用户干等下一帧
                Err(_) => flush(&mut batch),
            }
        }
        let _ = channel.close().await;

        // 通道已经结束了，把自己从表里摘掉。
        //
        // 不摘的后果有两个：
        // 1. 断线重连会分配新的 channel_id，旧的永远留在表里 —— 纯泄漏
        // 2. 更要命的是 drop_one_channel 靠"这个 session 还剩几条通道"来决定
        //    要不要断 SSH，数到这些死条目就会以为还有通道在，于是关了标签
        //    也不关连接 —— 进程和 TCP 一直挂在后台
        channels.lock().await.remove(&channel_id);
        owners.lock().await.remove(&channel_id);
    });

    Ok(channel_id)
}

#[tauri::command]
pub async fn ssh_input(
    state: State<'_, SshState>,
    channel_id: u32,
    data: String,
) -> Result<(), String> {
    let channels = state.channels.lock().await;
    let tx = channels.get(&channel_id).ok_or("通道不存在")?;
    tx.send(ShellCmd::Input(data.into_bytes()))
        .map_err(|e| format!("发送输入失败: {e}"))
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    channel_id: u32,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let channels = state.channels.lock().await;
    let tx = channels.get(&channel_id).ok_or("通道不存在")?;
    tx.send(ShellCmd::Resize { cols, rows })
        .map_err(|e| format!("调整尺寸失败: {e}"))
}

#[tauri::command]
pub async fn ssh_close(
    state: State<'_, SshState>,
    sftp: State<'_, SftpState>,
    session_id: String,
) -> Result<(), String> {
    // 先摘掉这条会话名下挂的 SFTP 通道。它们是另一张表里的条目，
    // 不清理的话 SSH 断了它们还留在内存里，前端又不会再去关一次
    sftp.close_for_session(&session_id).await;
    drop_channels(&state, &session_id).await;

    if let Some(entry) = state.sessions.lock().await.remove(&session_id) {
        let handle = entry.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}

/// 只关一个标签自己的 shell 通道，**不影响共用同一个 SSH session 的兄弟标签**。
/// 这是关标签的正常路径 —— `ssh_close` 是"我主动想断掉整条 SSH"才用。
#[tauri::command]
pub async fn ssh_close_channel(state: State<'_, SshState>, channel_id: u32) -> Result<(), String> {
    drop_one_channel(&state, channel_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 兼容模式追加的废弃算法必须排在末尾。
     *
     * SSH 挑的是客户端列表里第一个双方都支持的，所以顺序决定了现代设备会不会被
     * 无故降级。这是这套改动里最容易写错、也最不容易被发现的地方 ——
     * 写错了功能照常工作，只是所有连接都悄悄退到 CBC 上。
     */
    #[test]
    fn 兼容算法追加在末尾不挤掉现代算法() {
        let kex_names = |p: &Preferred| {
            p.kex
                .iter()
                .map(|n| n.as_ref())
                .collect::<Vec<_>>()
                .join(",")
        };
        let cipher_names = |p: &Preferred| {
            p.cipher
                .iter()
                .map(|n| n.as_ref())
                .collect::<Vec<_>>()
                .join(",")
        };

        let normal = preferred(false);
        assert!(!kex_names(&normal).contains("diffie-hellman-group1-sha1"));
        assert!(!cipher_names(&normal).contains("aes128-cbc"));

        let compat = preferred(true);
        let kex = kex_names(&compat);
        let cipher = cipher_names(&compat);

        // 现代算法必须还在，且仍在废弃算法之前
        assert!(kex.contains("curve25519-sha256"), "现代 kex 被挤掉了: {kex}");
        assert!(
            kex.find("curve25519-sha256").unwrap() < kex.find("diffie-hellman-group1-sha1").unwrap(),
            "废弃 kex 排到了现代算法前面: {kex}"
        );
        assert!(
            cipher.find("chacha20-poly1305").unwrap() < cipher.find("aes128-cbc").unwrap(),
            "废弃 cipher 排到了现代算法前面: {cipher}"
        );
    }

    #[test]
    fn 兼容模式确实放开老设备要的算法() {
        let p = preferred(true);
        let kex: Vec<&str> = p.kex.iter().map(|n| n.as_ref()).collect();
        let cipher: Vec<&str> = p.cipher.iter().map(|n| n.as_ref()).collect();

        assert!(kex.contains(&"diffie-hellman-group1-sha1"));
        assert!(kex.contains(&"diffie-hellman-group14-sha1"));
        assert!(cipher.contains(&"aes128-cbc"));
        assert!(cipher.contains(&"aes256-cbc"));
    }

    /// 只支持 ssh-dss 的设备是死局，必须说清楚并且**不能**建议兼容模式 ——
    /// 给了"重试"按钮却永远救不活，比直接说"连不上"更让人抓狂
    #[test]
    fn ssh_dss_时说明无解() {
        let e = algo_failure(
            &AlgorithmKind::Key,
            &["ssh-ed25519".to_string()],
            &["ssh-dss".to_string()],
        );
        let text = e.to_string();
        assert!(text.contains("ssh-dss"), "没点名 ssh-dss: {text}");

        match e {
            ConnectError::AlgorithmsUnsupported { compat_hint, .. } => {
                assert!(!compat_hint, "ssh-dss 无解却还建议了兼容模式")
            }
            other => panic!("错误类型不对: {other:?}"),
        }
    }

    #[test]
    fn ssh_dss_时给出可操作建议() {
        let e = algo_failure(
            &AlgorithmKind::Key,
            &["ssh-ed25519".to_string()],
            &["ssh-dss".to_string()],
        );
        assert!(e.to_string().contains("rsa"), "没告诉用户该怎么办");
    }

    /// 老设备最典型的症状：只肯用 CBC
    #[test]
    fn cipher_谈不拢时建议兼容模式() {
        let e = algo_failure(
            &AlgorithmKind::Cipher,
            &["chacha20-poly1305@openssh.com".to_string()],
            &["aes128-cbc".to_string(), "3des-cbc".to_string()],
        );
        let text = e.to_string();
        assert!(text.contains("加密算法"), "没说清是哪一类: {text}");
        assert!(
            text.contains("aes128-cbc"),
            "没把服务端算法列出来让人判断: {text}"
        );

        match e {
            ConnectError::AlgorithmsUnsupported { compat_hint, .. } => {
                assert!(compat_hint, "CBC 是 compat 能救的，却没给提示")
            }
            other => panic!("错误类型不对: {other:?}"),
        }
    }

    #[test]
    fn kex_谈不拢时建议兼容模式() {
        let e = algo_failure(
            &AlgorithmKind::Kex,
            &["curve25519-sha256".to_string()],
            &["diffie-hellman-group1-sha1".to_string()],
        );
        assert!(e.to_string().contains("密钥交换算法"));
        match e {
            ConnectError::AlgorithmsUnsupported { compat_hint, .. } => assert!(compat_hint),
            other => panic!("错误类型不对: {other:?}"),
        }
    }

    /// mac / 压缩不在 compat 的放开范围内，给了提示也是白试
    #[test]
    fn mac_谈不拢时不谎称兼容模式有用() {
        let e = algo_failure(
            &AlgorithmKind::Mac,
            &["hmac-sha2-256".to_string()],
            &["hmac-md5".to_string()],
        );
        match e {
            ConnectError::AlgorithmsUnsupported { compat_hint, .. } => {
                assert!(!compat_hint, "compat 改不了 mac，不该给提示")
            }
            other => panic!("错误类型不对: {other:?}"),
        }
    }

    #[test]
    fn 算法错误序列化成前端认得的形状() {
        let e = algo_failure(
            &AlgorithmKind::Cipher,
            &["chacha20-poly1305@openssh.com".to_string()],
            &["aes128-cbc".to_string()],
        );
        let v = serde_json::to_value(&e).expect("序列化失败");
        assert_eq!(v["kind"], "algorithms_unsupported");
        // 前端读的是 camelCase
        assert_eq!(v["compatHint"], true);
        assert!(v["message"].as_str().unwrap().contains("aes128-cbc"));
    }

    /// 前端的 parseConnectError 靠这个前缀兜底（万一 Tauri 把 Err 压成字符串），
    /// 格式不能随便改
    #[test]
    fn mismatch_的文本带可识别标记() {
        let e = ConnectError::HostKeyMismatch {
            host: "1.2.3.4:22".to_string(),
            detail: "记录: AAAA\n收到: BBBB".to_string(),
        };
        let text = e.to_string();
        assert!(text.starts_with(MISMATCH_MARK), "缺了兜底标记: {text}");
        assert!(text.contains("1.2.3.4:22"), "host 没进文本: {text}");
        assert!(text.contains("BBBB"), "detail 没进文本: {text}");
    }

    #[test]
    fn 普通错误不带标记() {
        let text = ConnectError::other("密码认证被拒绝").to_string();
        assert!(!text.starts_with(MISMATCH_MARK));
        assert_eq!(text, "密码认证被拒绝");
    }
}
