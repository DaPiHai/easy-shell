use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::ipc::Channel as IpcChannel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::io::SeekFrom;
use tokio::sync::Mutex;

use crate::ssh::SshState;

const CHUNK: usize = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// rwxr-xr-x 形式的权限串，拿不到时为 null
    pub mode: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum TransferEvent {
    #[serde(rename = "progress")]
    Progress { transferred: u64, total: u64 },
    #[serde(rename = "done")]
    Done { transferred: u64 },
    #[serde(rename = "error")]
    Error { message: String },
}

/**
 * SFTP 会话的复用与引用计数，跟真实连接无关，所以单独成结构 —— 这样能直接单测。
 *
 * 为什么需要复用：一条 SSH 会话上可以开多个 sftp 通道，但每开一条就占服务端一个
 * session 槽位（sshd 默认 `MaxSessions 10`）。前端允许对同一台主机开多个 SFTP 标签
 * （每个标签一个），不复用就会一条条堆上去，开关十几次之后新通道直接开不出来。
 *
 * 为什么需要引用计数：多个标签共用同一个 sftpId，其中一个关掉时不能真的关通道，
 * 否则兄弟标签会一起失效。只有最后一个引用释放时才真正关闭。
 */
#[derive(Default)]
pub struct SftpRegistry {
    /// SSH sessionId -> sftpId。同一条 SSH 会话上的 SFTP 标签共用一条通道
    by_session: Mutex<HashMap<String, u32>>,
    /// sftpId -> 还有多少个使用者
    refs: Mutex<HashMap<u32, usize>>,
}

impl SftpRegistry {
    /** 这条 SSH 会话上已经有 SFTP 通道的话返回它的 id（调用方据此复用） */
    async fn find(&self, session_id: &str) -> Option<u32> {
        self.by_session.lock().await.get(session_id).copied()
    }

    async fn register(&self, session_id: &str, id: u32) {
        self.by_session.lock().await.insert(session_id.to_string(), id);
        *self.refs.lock().await.entry(id).or_insert(0) += 1;
    }

    /// 复用已有通道时也要 +1，否则先关的那个标签会把别人一起带走
    async fn acquire(&self, id: u32) {
        *self.refs.lock().await.entry(id).or_insert(0) += 1;
    }

    /** 释放一个引用。返回 true 表示归零了，调用方需要真正关掉这条通道 */
    async fn release(&self, session_id: &str, id: u32) -> bool {
        let mut refs = self.refs.lock().await;
        let n = refs.entry(id).or_insert(0);
        *n = n.saturating_sub(1);
        if *n > 0 {
            return false;
        }
        refs.remove(&id);
        drop(refs);
        // 映射可能已经被 take_session 摘走了，这里只是顺手清掉自己的那份
        self.by_session.lock().await.remove(session_id);
        true
    }

    /// 反查这个 sftpId 挂在哪个 SSH 会话上
    async fn session_of(&self, id: u32) -> Option<String> {
        self.by_session
            .lock()
            .await
            .iter()
            .find(|(_, v)| **v == id)
            .map(|(k, _)| k.clone())
    }

    /**
     * SSH 会话断开时清理它名下的 SFTP 通道，返回要关掉的 sftpId。
     * 这是兜底：前端漏调 sftpClose（崩溃、异常路径）时不至于永久泄漏。
     */
    async fn take_session(&self, session_id: &str) -> Option<u32> {
        let id = self.by_session.lock().await.remove(session_id)?;
        self.refs.lock().await.remove(&id);
        Some(id)
    }

    /// 测试用：当前还活着几条通道
    #[cfg(test)]
    async fn live_count(&self) -> usize {
        self.refs.lock().await.len()
    }
}

#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<u32, Arc<SftpSession>>>,
    registry: SftpRegistry,
    next_id: AtomicU32,
}

impl SftpState {
    async fn get(&self, id: u32) -> Result<Arc<SftpSession>, String> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| "SFTP 会话不存在".to_string())
    }

    /// 断开一条 SSH 会话时调用：清掉它名下的 SFTP 通道
    pub async fn close_for_session(&self, session_id: &str) {
        if let Some(id) = self.registry.take_session(session_id).await {
            self.sessions.lock().await.remove(&id);
        }
    }
}

/// 在已建立的 SSH 会话上开一个 sftp 子系统通道
#[tauri::command]
pub async fn sftp_open(
    ssh: State<'_, SshState>,
    state: State<'_, SftpState>,
    session_id: String,
) -> Result<u32, String> {
    // 同一条 SSH 会话上已经有 SFTP 通道就直接复用：每多开一条就多占服务端一个
    // session 槽位，而前端允许对同一台主机开好几个 SFTP 标签
    if let Some(id) = state.registry.find(&session_id).await {
        state.registry.acquire(id).await;
        return Ok(id)
    }

    let channel = {
        let sessions = ssh.sessions.lock().await;
        let entry = sessions.get(&session_id).ok_or("SSH 会话不存在")?;
        let handle = entry.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开通道失败: {e}"))?
    };

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 sftp 子系统失败: {e}"))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("建立 SFTP 会话失败: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    state.sessions.lock().await.insert(id, Arc::new(sftp));
    state.registry.register(&session_id, id).await;
    Ok(id)
}

/// 列远端目录。抽成 pub 是为了让集成测试能直接验证这段映射逻辑
///（尤其是 DirEntry::path() 到底返回相对还是绝对路径，直接影响能不能导航）
pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>, String> {
    // "." 展开成服务器上的绝对路径，好让 DirEntry::path() 返回可导航的完整路径
    let resolved = if path == "." {
        sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| ".".to_string())
    } else {
        path.to_string()
    };

    let entries = sftp
        .read_dir(&resolved)
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?;

    let mut out: Vec<FileEntry> = entries
        .map(|entry| {
            let meta = entry.metadata();
            let is_dir = meta.file_type().is_dir();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            FileEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified,
                mode: Some(meta.permissions().to_string()),
            }
        })
        .collect();

    // 目录在前，同类型按名字排
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpState>,
    sftp_id: u32,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let sftp = state.get(sftp_id).await?;
    list_dir(&sftp, &path).await
}

/// 待传输条目。rel 是相对于本次传输根目录的路径，用于在对端还原目录结构
struct Item {
    /// 源端完整路径
    src: String,
    /// 相对根的路径，目录分隔符统一用 /
    rel: String,
    size: u64,
    is_dir: bool,
}

/// 递归展开远端目录。async fn 不能直接递归，只能靠 Box::pin 打住
fn collect_remote(
    sftp: Arc<SftpSession>,
    dir: String,
    rel: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Item>, String>> + Send>> {
    Box::pin(async move {
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("读取远端目录 {dir} 失败: {e}"))?;

        let mut out = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            let meta = entry.metadata();
            let full = entry.path();
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if meta.file_type().is_dir() {
                out.push(Item {
                    src: full.clone(),
                    rel: child_rel.clone(),
                    size: 0,
                    is_dir: true,
                });
                out.extend(collect_remote(sftp.clone(), full, child_rel).await?);
            } else {
                out.push(Item {
                    src: full,
                    rel: child_rel,
                    size: meta.len(),
                    is_dir: false,
                });
            }
        }
        Ok(out)
    })
}

/// 递归展开本地目录，dir 是目录本身，rel 是它在传输根下的相对位置
fn collect_local(dir: &std::path::Path, rel: &str) -> Result<Vec<Item>, String> {
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("读取本地目录 {} 失败: {e}", dir.display()))?;

    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let src = entry.path().to_string_lossy().to_string();
        if meta.is_dir() {
            out.push(Item {
                src: src.clone(),
                rel: child_rel.clone(),
                size: 0,
                is_dir: true,
            });
            out.extend(collect_local(std::path::Path::new(&src), &child_rel)?);
        } else {
            out.push(Item {
                src,
                rel: child_rel,
                size: meta.len(),
                is_dir: false,
            });
        }
    }
    Ok(out)
}

/// 远端路径拼接，分隔符固定 /
fn remote_join(dir: &str, rel: &str) -> String {
    let dir = dir.trim_end_matches(['/', '\\']);
    format!("{dir}/{rel}")
}

/// 取路径最后一段。远端也可能是 Windows 主机（OpenSSH on Windows），
/// 所以两种分隔符都要认；只按 / 切的话 `C:\a\b` 会整个被当成文件名
fn base_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if last.is_empty() {
        "download"
    } else {
        last
    }
}

/// 把 remote 拉到 local_dir 下，remote 是目录就整棵递归。
/// 进度回调抽成泛型 Fn，这样集成测试不依赖 Tauri 的 IPC Channel 也能直接测
pub async fn download_to<F>(
    sftp: Arc<SftpSession>,
    remote: &str,
    local_dir: &str,
    resume: bool,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(TransferEvent),
{
    let remote = remote.to_string();
    let local_dir = local_dir.to_string();
    // 出错时先给前端一个 error 事件，好让进度条停在失败态而不是卡在半路
    let fail = |e: String| {
        on_progress(TransferEvent::Error { message: e.clone() });
        e
    };

    let meta = sftp
        .metadata(&remote)
        .await
        .map_err(|e| fail(format!("读取远端属性失败: {e}")))?;

    let items: Vec<Item> = if meta.file_type().is_dir() {
        let name = base_name(&remote).to_string();
        let mut v = vec![Item {
            src: remote.clone(),
            rel: name.clone(),
            size: 0,
            is_dir: true,
        }];
        v.extend(
            collect_remote(sftp.clone(), remote.clone(), name)
                .await
                .map_err(&fail)?,
        );
        v
    } else {
        let name = base_name(&remote).to_string();
        vec![Item {
            src: remote,
            rel: name,
            size: meta.len(),
            is_dir: false,
        }]
    };

    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut transferred = 0u64;
    let mut buf = vec![0u8; CHUNK];

    // 先把目录骨架建好，空目录才不会丢
    for item in items.iter().filter(|i| i.is_dir) {
        let target = std::path::Path::new(&local_dir).join(&item.rel);
        tokio::fs::create_dir_all(&target)
            .await
            .map_err(|e| fail(format!("创建本地目录 {} 失败: {e}", target.display())))?;
    }

    for item in items.iter().filter(|i| !i.is_dir) {
        let target = std::path::Path::new(&local_dir).join(&item.rel);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| fail(format!("创建本地目录 {} 失败: {e}", parent.display())))?;
        }

        // 断点续传：本地已经有了一部分就接着传，传完了就整个跳过
        let existing = tokio::fs::metadata(&target)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if resume && existing >= item.size && item.size > 0 {
            transferred += item.size;
            on_progress(TransferEvent::Progress { transferred, total });
            continue;
        }
        let offset = if resume && existing > 0 { existing } else { 0 };

        let mut reader = sftp
            .open(&item.src)
            .await
            .map_err(|e| fail(format!("打开远端文件 {} 失败: {e}", item.src)))?;
        if offset > 0 {
            reader
                .seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| fail(format!("定位远端文件失败: {e}")))?;
        }

        let mut writer = if offset > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&target)
                .await
                .map_err(|e| fail(format!("打开本地文件 {} 失败: {e}", target.display())))?
        } else {
            tokio::fs::File::create(&target)
                .await
                .map_err(|e| fail(format!("创建本地文件 {} 失败: {e}", target.display())))?
        };

        // offset 那部分是上次传完的，也得算进总量，否则进度条到不了 100%
        transferred += offset;
        loop {
            let n = reader
                .read(&mut buf)
                .await
                .map_err(|e| fail(format!("读取远端文件失败: {e}")))?;
            if n == 0 {
                break;
            }
            writer
                .write_all(&buf[..n])
                .await
                .map_err(|e| fail(format!("写入本地文件失败: {e}")))?;
            transferred += n as u64;
            on_progress(TransferEvent::Progress {
                transferred,
                total,
            });
        }

        writer
            .flush()
            .await
            .map_err(|e| fail(format!("刷新本地文件失败: {e}")))?;
    }

    on_progress(TransferEvent::Done { transferred });
    Ok(())
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SftpState>,
    sftp_id: u32,
    remote: String,
    local_dir: String,
    resume: bool,
    on_progress: IpcChannel<TransferEvent>,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    download_to(sftp, &remote, &local_dir, resume, |e| {
        let _ = on_progress.send(e);
    })
    .await
}

/// 把 local 推到 remote_dir 下，local 是目录就整棵递归。
/// 同样用泛型进度回调，方便测试直接调
pub async fn upload_from<F>(
    sftp: Arc<SftpSession>,
    local: &str,
    remote_dir: &str,
    resume: bool,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(TransferEvent),
{
    let local = local.to_string();
    let remote_dir = remote_dir.to_string();
    let fail = |e: String| {
        on_progress(TransferEvent::Error { message: e.clone() });
        e
    };

    let local_path = std::path::Path::new(&local);
    let meta = tokio::fs::metadata(&local)
        .await
        .map_err(|e| fail(format!("读取本地属性失败: {e}")))?;

    let items: Vec<Item> = if meta.is_dir() {
        let name = local_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "upload".to_string());
        let mut v = vec![Item {
            src: local.clone(),
            rel: name.clone(),
            size: 0,
            is_dir: true,
        }];
        v.extend(collect_local(local_path, &name).map_err(&fail)?);
        v
    } else {
        let name = local_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        vec![Item {
            src: local,
            rel: name,
            size: meta.len(),
            is_dir: false,
        }]
    };

    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut transferred = 0u64;
    let mut buf = vec![0u8; CHUNK];

    // 远端建目录。已存在会报错，这里直接忽略——我们要的是"确保存在"
    for item in items.iter().filter(|i| i.is_dir) {
        let _ = sftp.create_dir(remote_join(&remote_dir, &item.rel)).await;
    }

    for item in items.iter().filter(|i| !i.is_dir) {
        let target = remote_join(&remote_dir, &item.rel);

        // 断点续传：远端已经有了一部分就接着传
        let existing = sftp
            .metadata(&target)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if resume && existing >= item.size && item.size > 0 {
            transferred += item.size;
            on_progress(TransferEvent::Progress { transferred, total });
            continue;
        }
        let offset = if resume && existing > 0 { existing } else { 0 };

        let mut reader = tokio::fs::File::open(&item.src)
            .await
            .map_err(|e| fail(format!("打开本地文件 {} 失败: {e}", item.src)))?;
        if offset > 0 {
            reader
                .seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| fail(format!("定位本地文件失败: {e}")))?;
        }

        let mut writer = if offset > 0 {
            // 不加 TRUNCATE，否则会把已传的部分清掉
            sftp
                .open_with_flags(&target, OpenFlags::WRITE | OpenFlags::CREATE)
                .await
                .map_err(|e| fail(format!("打开远端文件 {target} 失败: {e}")))?
        } else {
            sftp
                .create(&target)
                .await
                .map_err(|e| fail(format!("创建远端文件 {target} 失败: {e}")))?
        };
        if offset > 0 {
            writer
                .seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| fail(format!("定位远端文件失败: {e}")))?;
        }

        transferred += offset;
        loop {
            let n = reader
                .read(&mut buf)
                .await
                .map_err(|e| fail(format!("读取本地文件失败: {e}")))?;
            if n == 0 {
                break;
            }
            writer
                .write_all(&buf[..n])
                .await
                .map_err(|e| fail(format!("写入远端文件失败: {e}")))?;
            transferred += n as u64;
            on_progress(TransferEvent::Progress { transferred, total });
        }

        writer
            .flush()
            .await
            .map_err(|e| fail(format!("刷新远端文件失败: {e}")))?;
    }

    on_progress(TransferEvent::Done { transferred });
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpState>,
    sftp_id: u32,
    local: String,
    remote_dir: String,
    resume: bool,
    on_progress: IpcChannel<TransferEvent>,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    upload_from(sftp, &local, &remote_dir, resume, |e| {
        let _ = on_progress.send(e);
    })
    .await
}

/// 内置编辑器能扛的最大文件。再大就不是"编辑"了，该用 vim
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

/// 读远端文本文件给内置编辑器用。太大或非 UTF-8 直接拒绝，别把内存吃掉
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, SftpState>,
    sftp_id: u32,
    path: String,
) -> Result<String, String> {
    let sftp = state.get(sftp_id).await?;
    let meta = sftp
        .metadata(&path)
        .await
        .map_err(|e| format!("读取文件属性失败: {e}"))?;
    if meta.len() > MAX_EDIT_BYTES {
        return Err("文件超过 2MB，内置编辑器打不开，建议用命令行编辑".to_string());
    }

    let mut file = sftp
        .open(&path)
        .await
        .map_err(|e| format!("打开文件失败: {e}"))?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?;

    String::from_utf8(buf).map_err(|_| "文件不是 UTF-8 文本，无法在编辑器里打开".to_string())
}

/// 把编辑后的文本写回远端。整文件覆盖，不做合并
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, SftpState>,
    sftp_id: u32,
    path: String,
    content: String,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    let mut file = sftp
        .create(&path)
        .await
        .map_err(|e| format!("打开文件失败: {e}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("写入文件失败: {e}"))?;
    file.flush()
        .await
        .map_err(|e| format!("刷新文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn local_read_text(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件属性失败: {e}"))?;
    if meta.len() > MAX_EDIT_BYTES {
        return Err("文件超过 2MB，内置编辑器打不开".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

#[tauri::command]
pub fn local_write_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败: {e}"))
}

/// 远端当前工作目录的绝对路径。前端拿它做面包屑和上传目标目录
#[tauri::command]
pub async fn sftp_pwd(state: State<'_, SftpState>, sftp_id: u32) -> Result<String, String> {
    let sftp = state.get(sftp_id).await?;
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("获取远端当前目录失败: {e}"))
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SftpState>,
    sftp_id: u32,
    path: String,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpState>,
    sftp_id: u32,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    if is_dir {
        sftp.remove_dir(&path)
            .await
            .map_err(|e| format!("删除目录失败: {e}"))
    } else {
        sftp.remove_file(&path)
            .await
            .map_err(|e| format!("删除文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    sftp_id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = state.get(sftp_id).await?;
    sftp.rename(&from, &to)
        .await
        .map_err(|e| format!("重命名失败: {e}"))
}

/// 关掉一个 sftp 子系统通道。关掉后对应的 sftpId 立即失效
#[tauri::command]
pub async fn sftp_close(state: State<'_, SftpState>, sftp_id: u32) -> Result<(), String> {
    // 只有最后一个使用者释放才真关 —— 共用同一条通道的兄弟标签还在用着。
    // 要先反查它挂在哪个 SSH 会话上，才能把 by_session 里的映射一起摘掉
    let session_id = state.registry.session_of(sftp_id).await.unwrap_or_default();
    if state.registry.release(&session_id, sftp_id).await {
        state.sessions.lock().await.remove(&sftp_id);
    }
    Ok(())
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("读取目录失败: {e}"))?;

    let mut out: Vec<FileEntry> = Vec::new();
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        out.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified,
            mode: local_mode(&meta),
        });
    }

    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// 删除本地文件/目录。目录是递归删，前端已经弹过确认框了
#[tauri::command]
pub fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        std::fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败: {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("删除文件失败: {e}"))
    }
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("重命名失败: {e}"))
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {e}"))
}

/// 本地权限串。Windows 没有 unix mode，只能给个只读标记，干脆返回 null 让前端占位
#[cfg(unix)]
fn local_mode(meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let m = meta.permissions().mode();
    let triple = |b: u32| {
        format!(
            "{}{}{}",
            if b & 4 != 0 { "r" } else { "-" },
            if b & 2 != 0 { "w" } else { "-" },
            if b & 1 != 0 { "x" } else { "-" }
        )
    };
    Some(format!(
        "{}{}{}",
        triple((m >> 6) & 7),
        triple((m >> 3) & 7),
        triple(m & 7)
    ))
}

#[cfg(not(unix))]
fn local_mode(_meta: &std::fs::Metadata) -> Option<String> {
    None
}

#[tauri::command]
pub fn local_home() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

/// 把一批本地文件/目录复制进 `dest_dir`，返回复制的顶层条目数。
///
/// 这是给「从资源管理器拖文件到本地栏」用的：系统拖拽只能给出绝对路径，
/// 落到本地栏就只能靠复制落地。远端那侧不需要它 —— 上传走 `sftp_upload`。
#[tauri::command]
pub fn local_copy(paths: Vec<String>, dest_dir: String) -> Result<usize, String> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("目标目录不存在: {dest_dir}"));
    }
    let dest_canon = dest
        .canonicalize()
        .map_err(|e| format!("无法解析目标目录 {dest_dir}: {e}"))?;

    let mut copied = 0usize;
    for raw in &paths {
        let src = PathBuf::from(raw);
        if !src.exists() {
            return Err(format!("源不存在: {raw}"));
        }
        let src_canon = src
            .canonicalize()
            .map_err(|e| format!("无法解析源 {raw}: {e}"))?;

        // 把目录复制进它自己的子目录，递归永远走不到底，直接挡掉
        if dest_canon.starts_with(&src_canon) {
            return Err(format!("不能把 {raw} 复制进它自己的子目录"));
        }

        let name = src
            .file_name()
            .ok_or_else(|| format!("取不到文件名: {raw}"))?;
        let target = unique_path(&dest, name);
        copy_entry(&src, &target)?;
        copied += 1;
    }
    Ok(copied)
}

/// 目标已存在就往后找空位：`a.txt` → `a (2).txt` → `a (3).txt`
fn unique_path(dir: &Path, name: &OsStr) -> PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }

    let file_name = name.to_string_lossy().to_string();
    // 只有最后一个点后面还有字符、且不在开头（比如 `.gitignore`），才当扩展名切出来
    let (stem, ext) = match file_name.rfind('.') {
        Some(i) if i > 0 && i < file_name.len() - 1 => {
            let (s, e) = file_name.split_at(i);
            (s.to_string(), e.to_string())
        }
        _ => (file_name, String::new()),
    };

    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 撞名一千次这种事大概不会发生，真发生了用时间戳兜底，也比覆盖用户文件强
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("{stem} ({stamp}){ext}"))
}

fn copy_entry(src: &Path, dst: &Path) -> Result<(), String> {
    // 用 symlink_metadata：符号链接本身不展开成目录，交给 fs::copy 去跟随
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| format!("读取 {} 的元信息失败: {e}", src.display()))?;

    if !meta.is_dir() {
        return std::fs::copy(src, dst)
            .map_err(|e| format!("复制 {} 失败: {e}", src.display()))
            .map(|_| ());
    }

    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {e}", dst.display()))?;
    let rd =
        std::fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {e}", src.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("遍历 {} 失败: {e}", src.display()))?;
        copy_entry(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 测试用的临时目录，Drop 时自己清掉，别在系统临时区里堆垃圾
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let p = std::env::temp_dir().join(format!(
                "easy-shell-copy-{tag}-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir_all(&p).expect("建临时目录失败");
            TempDir(p)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn 复制单个文件() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let file = src.0.join("a.txt");
        write(&file, "hello");

        let n = local_copy(vec![file.to_string_lossy().to_string()], dst.path()).unwrap();
        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(dst.0.join("a.txt")).unwrap(), "hello");
    }

    #[test]
    fn 复制目录会连子目录一起带走() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let dir = src.0.join("pkg");
        write(&dir.join("a.txt"), "a");
        write(&dir.join("sub").join("b.txt"), "b");

        let n = local_copy(vec![dir.to_string_lossy().to_string()], dst.path()).unwrap();
        assert_eq!(n, 1);
        assert_eq!(fs::read_to_string(dst.0.join("pkg").join("a.txt")).unwrap(), "a");
        assert_eq!(
            fs::read_to_string(dst.0.join("pkg").join("sub").join("b.txt")).unwrap(),
            "b"
        );
    }

    #[test]
    fn 同名时自动改名而不是覆盖() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let file = src.0.join("a.txt");
        write(&file, "first");
        write(&dst.0.join("a.txt"), "existing");

        local_copy(vec![file.to_string_lossy().to_string()], dst.path()).unwrap();

        // 原来那个必须原封不动
        assert_eq!(fs::read_to_string(dst.0.join("a.txt")).unwrap(), "existing");
        assert_eq!(
            fs::read_to_string(dst.0.join("a (2).txt")).unwrap(),
            "first"
        );
    }

    #[test]
    fn 连续复制同名会一直往后排号() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let file = src.0.join("a.txt");
        write(&file, "x");

        let p = file.to_string_lossy().to_string();
        local_copy(vec![p.clone()], dst.path()).unwrap();
        local_copy(vec![p.clone()], dst.path()).unwrap();
        local_copy(vec![p], dst.path()).unwrap();

        // 目标目录一开始是空的：第一次落 a.txt，第二次 a (2).txt，第三次 a (3).txt
        assert!(dst.0.join("a.txt").exists());
        assert!(dst.0.join("a (2).txt").exists());
        assert!(dst.0.join("a (3).txt").exists());
        assert!(!dst.0.join("a (4).txt").exists());
    }

    #[test]
    fn 没有扩展名的文件改名时不会多点一个点() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let file = src.0.join("Makefile");
        write(&file, "all:");
        write(&dst.0.join("Makefile"), "old");

        local_copy(vec![file.to_string_lossy().to_string()], dst.path()).unwrap();
        assert!(dst.0.join("Makefile (2)").exists());
    }

    #[test]
    fn 复制目录进自己的子目录会被拒绝() {
        let src = TempDir::new("src");
        let dir = src.0.join("pkg");
        write(&dir.join("a.txt"), "a");
        let inner = dir.join("inner");
        fs::create_dir_all(&inner).unwrap();

        let err = local_copy(vec![dir.to_string_lossy().to_string()], inner.to_string_lossy().to_string())
            .unwrap_err();
        assert!(err.contains("子目录"), "错误信息应说明原因，实际: {err}");
    }

    #[test]
    fn 源不存在时报错() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let missing = src.0.join("nope.txt");

        let err =
            local_copy(vec![missing.to_string_lossy().to_string()], dst.path()).unwrap_err();
        assert!(err.contains("源不存在"), "实际: {err}");
    }

    #[test]
    fn 目标目录不存在时报错() {
        let src = TempDir::new("src");
        let file = src.0.join("a.txt");
        write(&file, "x");

        let err = local_copy(
            vec![file.to_string_lossy().to_string()],
            src.0.join("no-such-dir").to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("目标目录不存在"), "实际: {err}");
    }

    #[test]
    fn 一次复制多个源() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let a = src.0.join("a.txt");
        let b = src.0.join("b.txt");
        write(&a, "a");
        write(&b, "b");

        let n = local_copy(
            vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()],
            dst.path(),
        )
        .unwrap();
        assert_eq!(n, 2);
        assert!(dst.0.join("a.txt").exists());
        assert!(dst.0.join("b.txt").exists());
    }

    #[test]
    fn 空目录也能复制() {
        let src = TempDir::new("src");
        let dst = TempDir::new("dst");
        let dir = src.0.join("empty");
        fs::create_dir_all(&dir).unwrap();

        local_copy(vec![dir.to_string_lossy().to_string()], dst.path()).unwrap();
        assert!(dst.0.join("empty").is_dir());
    }
}

/**
 * 复用与引用计数的测试。
 *
 * 这些行为不依赖真实 SSH 连接，所以能直接单测 —— 这正是把 registry 从
 * SftpState 里抽出来的理由。靠真服务器验证"开关十几次会不会泄漏"太慢也太脆。
 */
#[cfg(test)]
mod registry_tests {
    use super::SftpRegistry;

    #[tokio::test]
    async fn 同一会话第二次开返回同一个_id() {
        let r = SftpRegistry::default();
        r.register("s1", 7).await;
        assert_eq!(r.find("s1").await, Some(7));
        // 复用之后再查还是同一条，而不是新开一条
        r.acquire(7).await;
        assert_eq!(r.find("s1").await, Some(7));
        assert_eq!(r.live_count().await, 1, "复用不该增加通道数");
    }

    #[tokio::test]
    async fn 不同会话各开各的() {
        let r = SftpRegistry::default();
        r.register("s1", 7).await;
        r.register("s2", 8).await;
        assert_eq!(r.find("s1").await, Some(7));
        assert_eq!(r.find("s2").await, Some(8));
        assert_eq!(r.live_count().await, 2);
    }

    #[tokio::test]
    async fn 还有别人在用就不真关() {
        let r = SftpRegistry::default();
        r.register("s1", 7).await;
        r.acquire(7).await;

        assert!(!r.release("s1", 7).await, "两个引用，释放一个不该归零");
        assert_eq!(r.live_count().await, 1, "兄弟标签还在用，通道必须留着");
        assert_eq!(r.find("s1").await, Some(7), "映射也还在");

        assert!(r.release("s1", 7).await, "最后一个释放才归零");
        assert_eq!(r.live_count().await, 0);
        assert_eq!(r.find("s1").await, None);
    }

    #[tokio::test]
    async fn 释放不存在的_id_不会把计数搞成负数() {
        let r = SftpRegistry::default();
        assert!(r.release("s1", 99).await);
        assert_eq!(r.live_count().await, 0);
    }

    #[tokio::test]
    async fn ssh_会话断开时把它的通道摘走() {
        let r = SftpRegistry::default();
        r.register("s1", 7).await;
        r.register("s2", 8).await;

        assert_eq!(r.take_session("s1").await, Some(7));
        assert_eq!(r.find("s1").await, None, "映射要清掉，否则复用会拿到已关的通道");
        // 只影响这一条，别的会话不受牵连
        assert_eq!(r.find("s2").await, Some(8));
        assert_eq!(r.live_count().await, 1);
    }

    #[tokio::test]
    async fn 摘走之后再查不到() {
        let r = SftpRegistry::default();
        assert_eq!(r.take_session("没连过").await, None);
    }

    #[tokio::test]
    async fn 反查通道属于哪个会话() {
        let r = SftpRegistry::default();
        r.register("s1", 7).await;
        assert_eq!(r.session_of(7).await, Some("s1".to_string()));
        assert_eq!(r.session_of(404).await, None);
    }

    #[tokio::test]
    async fn 反复开关不会堆积() {
        let r = SftpRegistry::default();
        // 模拟开十个标签又全部关掉：每次开都复用同一条通道
        for _ in 0..10 {
            match r.find("s1").await {
                Some(id) => r.acquire(id).await,
                None => r.register("s1", 42).await,
            }
        }
        assert_eq!(r.live_count().await, 1, "十个标签只占一条通道");
        for _ in 0..10 {
            r.release("s1", 42).await;
        }
        assert_eq!(r.live_count().await, 0, "全关掉之后一条都不剩");
    }
}
