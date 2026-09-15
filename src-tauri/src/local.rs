//! 本地 Shell。Windows 走 ConPTY，Unix 走 forkpty，都由 portable-pty 抹平。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel as IpcChannel;
use tauri::State;

use crate::ssh::ShellEvent;

/// 跟 ssh 侧保持一致的攒批帧长
const FRAME: Duration = Duration::from_millis(16);

struct LocalShell {
    /// pty 主端，只用来 resize
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// 往 shell 写输入
    writer: Mutex<Box<dyn Write + Send>>,
    /// 留着句柄好在关闭时 kill 掉
    child: Mutex<Box<dyn Child + Send>>,
}

#[derive(Default)]
pub struct LocalState {
    shells: Mutex<HashMap<u32, LocalShell>>,
    next_id: AtomicU32,
}

fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
}

/// 起一个本地 shell，返回句柄 id。输出通过 on_data 以 base64 流回推
#[tauri::command]
pub fn local_open(
    state: State<'_, LocalState>,
    cols: u16,
    rows: u16,
    on_data: IpcChannel<ShellEvent>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建 PTY 失败: {e}"))?;

    let child = pair
        .slave
        .spawn_command(default_shell())
        .map_err(|e| format!("启动 shell 失败: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读端失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取 PTY 写端失败: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    state.shells.lock().unwrap().insert(
        id,
        LocalShell {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        },
    );

    // pty 读端是阻塞的，丢到独立线程里读，别占着 async 运行时。
    // 读线程只管往共享缓冲里堆，由下面这个 async 任务按帧攒批发给前端 ——
    // 本地 cat 一个大文件跟 ssh 一样会把 IPC 打满
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicBool::new(false));

    {
        let buf = buf.clone();
        let finished = finished.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            finished.store(true, Ordering::SeqCst);
        });
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(FRAME).await;

            let batch: Vec<u8> = std::mem::take(&mut *buf.lock().unwrap());
            if !batch.is_empty() {
                let payload = ShellEvent::Data {
                    data: B64.encode(&batch[..]),
                };
                if on_data.send(payload).is_err() {
                    // 前端没了，退出。读线程会一直阻塞到 pty 关闭，届时自行结束
                    return;
                }
            }

            if finished.load(Ordering::SeqCst) {
                // 退出前再排一次，别把最后那点输出落下
                let rest: Vec<u8> = std::mem::take(&mut *buf.lock().unwrap());
                if !rest.is_empty() {
                    let _ = on_data.send(ShellEvent::Data {
                        data: B64.encode(&rest[..]),
                    });
                }
                let _ = on_data.send(ShellEvent::Closed);
                break;
            }
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn local_input(state: State<'_, LocalState>, shell_id: u32, data: String) -> Result<(), String> {
    let shells = state.shells.lock().unwrap();
    let shell = shells
        .get(&shell_id)
        .ok_or_else(|| "本地 shell 不存在".to_string())?;
    let mut writer = shell.writer.lock().unwrap();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入失败: {e}"))?;
    writer.flush().map_err(|e| format!("刷新失败: {e}"))
}

#[tauri::command]
pub fn local_resize(
    state: State<'_, LocalState>,
    shell_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shells = state.shells.lock().unwrap();
    let shell = shells
        .get(&shell_id)
        .ok_or_else(|| "本地 shell 不存在".to_string())?;
    let master = shell.master.lock().unwrap();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

/// 关掉 shell。Windows 下 ConPTY 不 kill 子进程的话，子进程会一直挂着
#[tauri::command]
pub fn local_close(state: State<'_, LocalState>, shell_id: u32) -> Result<(), String> {
    let shell = state.shells.lock().unwrap().remove(&shell_id);
    if let Some(shell) = shell {
        let mut child = shell.child.lock().unwrap();
        let _ = child.kill();
    }
    Ok(())
}
