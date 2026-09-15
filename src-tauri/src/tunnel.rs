//! 本地端口转发（-L）：监听本地端口，把流量经 SSH 隧道送到远端地址。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::ssh::SshState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: u32,
    pub listen_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

struct Tunnel {
    info: TunnelInfo,
    /// 置 true 让监听循环退场
    stop: Arc<AtomicBool>,
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
    state.tunnels.lock().await.insert(
        id,
        Tunnel {
            info: TunnelInfo {
                id,
                listen_port,
                remote_host: remote_host.clone(),
                remote_port,
            },
            stop: stop.clone(),
        },
    );

    let stop_for_accept = stop.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if stop_for_accept.load(Ordering::SeqCst) {
                break;
            }

            let accept = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            let Ok(Ok((stream, _))) = accept else { continue };

            let handle = handle.clone();
            let remote_host = remote_host.clone();
            tauri::async_runtime::spawn(async move {
                // 开完 channel 立刻放锁，别一直占着，否则同会话的终端输入会卡住
                let mut channel = {
                    let guard = handle.lock().await;
                    match guard
                        .channel_open_direct_tcpip("127.0.0.1", 0, remote_host, remote_port as u32)
                        .await
                    {
                        Ok(c) => c,
                        Err(_) => return,
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
    });

    Ok(id)
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
    Ok(state
        .tunnels
        .lock()
        .await
        .values()
        .map(|t| t.info.clone())
        .collect())
}
