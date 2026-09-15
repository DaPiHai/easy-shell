//! SFTP 端到端测试：起一个真·sftp 服务端，后端目录是本机磁盘上的真实临时目录，
//! 然后用 easy-shell 自己的 list_dir / 下载逻辑去读它。
//!
//! 重点验证三件靠读代码推不准的事：
//!   1. DirEntry::path() 返回的是绝对路径还是相对路径（决定目录能不能导航）
//!   2. is_dir / size / 权限串映射对不对
//!   3. 递归下载能不能把整棵目录树还原出来

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use easy_shell_lib::sftp::{download_to, list_dir, TransferEvent};
use easy_shell_lib::ssh::{connect_and_auth, ConnectConfig};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const TEST_USER: &str = "tester";
const TEST_PASS: &str = "secret";

/// 服务端把 sftp 请求都打到这个本机目录上
static mut ROOT: Option<PathBuf> = None;

fn root() -> PathBuf {
    #[allow(static_mut_refs)]
    unsafe {
        ROOT.clone().expect("测试还没设置 ROOT")
    }
}

/// 把客户端看到的路径映射到本机真实路径。
/// canonicalize 返回的是本机绝对路径，所以绝对路径要能直接命中，不能再拼一次 root
fn resolve(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        root().join(p)
    }
}

struct SshSession {
    clients: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl Default for SshSession {
    fn default() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl SshSession {
    async fn take_channel(&mut self, channel_id: ChannelId) -> Channel<Msg> {
        self.clients
            .lock()
            .await
            .remove(&channel_id)
            .expect("找不到通道")
    }
}

#[derive(Clone)]
struct TestServer;

impl server::Server for TestServer {
    type Handler = SshSession;
    fn new_client(&mut self, _: Option<SocketAddr>) -> SshSession {
        SshSession::default()
    }
}

impl server::Handler for SshSession {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_USER && password == TEST_PASS {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.clients.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.take_channel(channel_id).await;
            session.channel_success(channel_id)?;
            russh_sftp::server::run(channel.into_stream(), TestSftp::default()).await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct TestSftp {
    /// opendir 之后待返回的目录路径
    open_dirs: HashMap<String, PathBuf>,
    /// 已经返回过内容的目录句柄，再读要回 Eof
    read_done: std::collections::HashSet<String>,
}

impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        Ok(ok_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = resolve(&path);
        if !dir.is_dir() {
            return Err(StatusCode::NoSuchFile)
        }
        let handle = format!("dir:{}", path);
        self.open_dirs.insert(handle.clone(), dir);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        // 客户端会一直 readdir 到 Eof，所以第二次调用必须回 Eof 而不是报错
        if self.read_done.contains(&handle) {
            return Err(StatusCode::Eof)
        }
        let dir = match self.open_dirs.get(&handle) {
            Some(d) => d.clone(),
            None => return Err(StatusCode::Eof),
        };
        self.read_done.insert(handle.clone());

        let mut files = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|_| StatusCode::Failure)?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32);

            // 权限位里带上文件类型位，客户端就是靠它判断 is_dir 的
            let mode_bits: u32 = if is_dir { 0o040_755 } else { 0o100_644 };
            files.push(File::new(
                name,
                FileAttributes {
                    size: Some(size),
                    permissions: Some(mode_bits),
                    mtime,
                    ..Default::default()
                },
            ));
        }

        if files.is_empty() {
            return Err(StatusCode::Eof)
        }
        Ok(Name { id, files })
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let abs = if path == "." {
            root().to_string_lossy().to_string()
        } else {
            resolve(&path).to_string_lossy().to_string()
        };
        Ok(Name {
            id,
            files: vec![File::dummy(abs)],
        })
    }

    async fn open(
        &mut self,
        id: u32,
        path: String,
        _flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let file = resolve(&path);
        if !file.is_file() {
            return Err(StatusCode::NoSuchFile)
        }
        let handle = format!("file:{}", path);
        // 直接把内容塞进 handle，read 时按字节切
        let content = std::fs::read(&file).map_err(|_| StatusCode::Failure)?;
        self.open_dirs.insert(handle.clone(), PathBuf::from(String::from_utf8_lossy(&content).to_string()));
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let content = self
            .open_dirs
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .clone();
        let bytes = content.to_string_lossy().to_string().into_bytes();
        let start = offset.min(bytes.len() as u64) as usize;
        let end = (start + len as usize).min(bytes.len());
        Ok(russh_sftp::protocol::Data {
            id,
            data: bytes[start..end].to_vec(),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let target = resolve(&path);
        let meta = std::fs::metadata(&target).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(meta.len()),
                permissions: Some(if meta.is_dir() { 0o040_755 } else { 0o100_644 }),
                ..Default::default()
            },
        })
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

async fn spawn_server() -> u16 {
    let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_secs(1),
        ..Default::default()
    });

    // run_on_address 的 future 借用 &mut self，得让它活过 spawn，这里直接泄漏
    let instance: &'static mut TestServer = Box::leak(Box::new(TestServer));
    let server = instance.run_on_address(config, ("127.0.0.1", port));
    tokio::spawn(async move {
        let _ = server.await;
    });

    for _ in 0..50 {
        if TcpListener::bind(("127.0.0.1", port)).await.is_err() {
            return port
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("测试服务端没能在 {port} 上起来")
}

async fn connect_sftp(port: u16) -> russh_sftp::client::SftpSession {
    let cfg = ConnectConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: TEST_USER.to_string(),
        password: Some(TEST_PASS.to_string()),
        private_key_path: None,
        passphrase: None,
    };
    let handle = connect_and_auth(&cfg).await.unwrap();
    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .unwrap()
}

fn build_fixture() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("easy-shell-sftp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("subdir")).unwrap();
    std::fs::write(dir.join("hello.txt"), b"hello world").unwrap();
    std::fs::write(dir.join("subdir").join("nested.txt"), b"nested").unwrap();
    dir
}

#[tokio::test]
async fn sftp_列目录能拿到文件与子目录() {
    let fixture = build_fixture();
    #[allow(static_mut_refs)]
    unsafe {
        ROOT = Some(fixture.clone())
    }

    let port = spawn_server().await;
    let sftp = connect_sftp(port).await;

    let entries = list_dir(&sftp, ".").await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"hello.txt"), "少了 hello.txt：{names:?}");
    assert!(names.contains(&"subdir"), "少了 subdir：{names:?}");

    let sub = entries.iter().find(|e| e.name == "subdir").unwrap();
    assert!(sub.is_dir, "subdir 应该被识别为目录");
    assert_eq!(sub.size, 0, "目录的 size 应该是 0");

    let file = entries.iter().find(|e| e.name == "hello.txt").unwrap();
    assert!(!file.is_dir, "hello.txt 不该是目录");
    assert_eq!(file.size, 11, "hello.txt 应该是 11 字节");
    assert_eq!(file.mode.as_deref(), Some("rw-r--r--"), "权限串不对：{:?}", file.mode);

    // 目录排前面
    assert_eq!(entries[0].name, "subdir", "目录没排在前面：{names:?}");
}

#[tokio::test]
async fn sftp_列目录_path_是绝对路径() {
    let fixture = build_fixture();
    #[allow(static_mut_refs)]
    unsafe {
        ROOT = Some(fixture.clone())
    }

    let port = spawn_server().await;
    let sftp = connect_sftp(port).await;

    let entries = list_dir(&sftp, ".").await.unwrap();
    let sub = entries.iter().find(|e| e.name == "subdir").unwrap();

    // 这条最关键：path 如果不是绝对路径/完整路径，双击目录就没法导航过去
    assert!(
        !sub.path.is_empty() && sub.path != "subdir",
        "DirEntry::path() 只给了裸名字，没法用来导航：{:?}",
        sub.path
    );
}

#[tokio::test]
async fn sftp_递归下载能还原整棵目录树() {
    let fixture = build_fixture();
    #[allow(static_mut_refs)]
    unsafe {
        ROOT = Some(fixture.clone())
    }

    let port = spawn_server().await;
    let sftp = Arc::new(connect_sftp(port).await);

    // 下载到另一个临时目录，别和源目录混在一起
    let dest = std::env::temp_dir().join(format!("easy-shell-dl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();

    let events: Arc<Mutex<Vec<TransferEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let result = download_to(
        sftp.clone(),
        &fixture.to_string_lossy(),
        &dest.to_string_lossy(),
        false,
        move |e: TransferEvent| {
            // 回调是在 async 流程里同步调用的，try_lock 就够，不会死锁
            if let Ok(mut v) = sink.try_lock() {
                v.push(e);
            }
        },
    )
    .await;

    assert!(result.is_ok(), "递归下载失败: {:?}", result.err());
    assert!(
        events
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransferEvent::Done { .. })),
        "没收到 Done 事件，进度回调没打通"
    );

    // 顶层文件
    let hello = dest.join(fixture.file_name().unwrap()).join("hello.txt");
    assert!(hello.exists(), "顶层文件没下载下来：{:?}", hello);
    assert_eq!(std::fs::read_to_string(&hello).unwrap(), "hello world");

    // 子目录里的文件 —— 这条验证递归和相对路径还原
    let nested = dest.join(fixture.file_name().unwrap()).join("subdir").join("nested.txt");
    assert!(nested.exists(), "子目录里的文件没还原：{:?}", nested);
    assert_eq!(std::fs::read_to_string(&nested).unwrap(), "nested");
}

#[tokio::test]
async fn sftp_断点续传能接着上次的进度传完() {
    let fixture = build_fixture();
    #[allow(static_mut_refs)]
    unsafe {
        ROOT = Some(fixture.clone())
    }

    let port = spawn_server().await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-resume-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let target_dir = dest.join(fixture.file_name().unwrap());
    std::fs::create_dir_all(&target_dir).unwrap();

    // 伪造上次传到一半的现场：hello.txt 只有前 5 字节
    std::fs::write(target_dir.join("hello.txt"), b"hello").unwrap();

    let result = download_to(
        sftp.clone(),
        &fixture.to_string_lossy(),
        &dest.to_string_lossy(),
        true,
        |_e: TransferEvent| {},
    )
    .await;

    assert!(result.is_ok(), "续传失败: {:?}", result.err());

    // 应该只补了后 6 字节，拼起来是完整的 "hello world"
    let got = std::fs::read_to_string(target_dir.join("hello.txt")).unwrap();
    assert_eq!(got, "hello world", "续传拼出来的内容不对：{got:?}");
}

#[tokio::test]
async fn sftp_canonicalize_能拿到家目录绝对地址() {
    let fixture = build_fixture();
    #[allow(static_mut_refs)]
    unsafe {
        ROOT = Some(fixture.clone())
    }

    let port = spawn_server().await;
    let sftp = connect_sftp(port).await;

    let pwd = sftp.canonicalize(".").await.unwrap();
    assert!(!pwd.is_empty(), "canonicalize 返回了空路径");
    assert_ne!(pwd, ".", "canonicalize 没把 . 展开成绝对路径：{pwd}");
}
