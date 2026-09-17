//! 本地端口转发（-L）：监听本地端口，把流量经 SSH 隧道送到远端地址。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::ssh::{ClientHandler, SshState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: u32,
    pub listen_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// 最近一次开通道失败的原因。没有它，用户看到的就只是「本地端口能连上、立刻断」，
    /// 而真正的原因（服务端 AllowTcpForwarding no 之类）全在服务端日志里
    pub last_error: Option<String>,
}

struct Tunnel {
    info: TunnelInfo,
    /// 置 true 让监听循环退场
    stop: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
pub struct TunnelState {
    tunnels: Mutex<HashMap<u32, Tunnel>>,
    next_id: AtomicU32,
}

#[tauri::command]
pub async fn tunnel_start(
    ssh: State<'_, SshState>,
    state: State<'_, TunnelState>,
    session_id: String,
    listen_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<u32, String> {
    // Handle 不能 clone，所以 clone 的是包它的 Arc，任务里再各自上锁
    let handle = {
        let sessions = ssh.sessions.lock().await;
        let entry = sessions
            .get(&session_id)
            .ok_or_else(|| "SSH 会话不存在".to_string())?;
        entry.handle.clone()
    };

    let addr: SocketAddr = ([127, 0, 0, 1], listen_port).into();
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("监听本地端口 {listen_port} 失败: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let stop = Arc::new(AtomicBool::new(false));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    state.tunnels.lock().await.insert(
        id,
        Tunnel {
            info: TunnelInfo {
                id,
                listen_port,
                remote_host: remote_host.clone(),
                remote_port,
                last_error: None,
            },
            stop: stop.clone(),
            last_error: last_error.clone(),
        },
    );

    let stop_for_accept = stop.clone();
    tauri::async_runtime::spawn(forward_accept_loop(
        handle,
        listener,
        remote_host,
        remote_port,
        stop_for_accept,
        last_error,
    ));

    Ok(id)
}

/// 监听循环 + 每连接一个 direct-tcpip 通道。
///
/// 单独抽成 pub 是为了让集成测试能驱动**应用自己**这段代码：以前 e2e 是绕过它
/// 直接调 russh 的 `channel_open_direct_tcpip`，于是参数写反了测试照样绿，
/// 真机上却表现为「本地端口能连上、数据一个字节不来就断」。
pub async fn forward_accept_loop(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
    stop: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let accept = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
        let Ok(Ok((stream, _))) = accept else { continue };

        let handle = handle.clone();
        let remote_host = remote_host.clone();
        let last_error = last_error.clone();
        tokio::spawn(async move {
            // 开完 channel 立刻放锁，别一直占着，否则同会话的终端输入会卡住
            let mut channel = {
                let guard = handle.lock().await;
                // 顺序按 russh 的签名：先「要连到哪」(host, port)，再「谁发起的」(addr, port)。
                // 发起方只是给服务端记日志用的，固定本机 + 0 端口即可。
                match guard
                    .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
                    .await
                {
                    Ok(c) => c,
                    Err(e) => {
                        // 常见原因是对面 AllowTcpForwarding no。不记下来，用户只能看到
                        // 「端口通了、立刻断」，然后去猜是不是自己填错了
                        *last_error.lock().await = Some(format!("{e}"));
                        return;
                    }
                }
            };

            let (mut tcp_read, mut tcp_write) = stream.into_split();
            let mut tcp_buf = [0u8; 8192];

            // 两端都阻塞式 await，靠 select! 同时盯着。
            // 处理体里对 channel 的借用是串行的，不会和 wait() 撞上
            loop {
                tokio::select! {
                    read = tcp_read.read(&mut tcp_buf) => {
                        match read {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if channel.data(&tcp_buf[..n]).await.is_err() {
                                    break
                                }
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if tcp_write.write_all(&data).await.is_err() {
                                    break
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                }
            }
            let _ = channel.close().await;
        });
    }
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, TunnelState>, tunnel_id: u32) -> Result<(), String> {
    if let Some(tunnel) = state.tunnels.lock().await.remove(&tunnel_id) {
        tunnel.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn tunnel_list(state: State<'_, TunnelState>) -> Result<Vec<TunnelInfo>, String> {
    let tunnels = state.tunnels.lock().await;
    let mut out = Vec::with_capacity(tunnels.len());
    for t in tunnels.values() {
        let mut info = t.info.clone();
        info.last_error = t.last_error.lock().await.clone();
        out.push(info);
    }
    Ok(out)
}
