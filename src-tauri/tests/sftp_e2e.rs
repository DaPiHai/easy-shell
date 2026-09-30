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

use easy_shell_lib::sftp::{
    copy_to, create_file, download_to, list_dir, local_create_file, upload_from, ConflictPolicy,
    TransferEvent,
};
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

/// 把客户端看到的路径映射到本机真实路径。
/// canonicalize 返回的是本机绝对路径，所以绝对路径要能直接命中，不能再拼一次 root
fn resolve_under(root: &std::path::Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

struct SshSession {
    clients: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    /// 这条连接上的 sftp 请求落到哪个本机目录
    sftp_root: PathBuf,
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
struct TestServer {
    sftp_root: PathBuf,
}

impl server::Server for TestServer {
    type Handler = SshSession;
    fn new_client(&mut self, _: Option<SocketAddr>) -> SshSession {
        SshSession {
            clients: Arc::new(Mutex::new(HashMap::new())),
            sftp_root: self.sftp_root.clone(),
        }
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
            russh_sftp::server::run(
                channel.into_stream(),
                TestSftp {
                    root: self.sftp_root.clone(),
                    ..Default::default()
                },
            )
            .await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct TestSftp {
    /// sftp 请求都落到这个本机目录上。挂在实例上而不是全局静态量 ——
    /// 测试是并行跑的，共用一份 static mut 属于数据竞争（实测会偶发堆损坏）
    root: PathBuf,
    /// opendir 之后待返回的目录路径
    open_dirs: HashMap<String, PathBuf>,
    /// 已经返回过内容的目录句柄，再读要回 Eof
    read_done: std::collections::HashSet<String>,
    /// 打开中的文件。写入模式下内容先攒在内存里，close 时落盘
    open_files: HashMap<String, OpenFile>,
}

struct OpenFile {
    path: PathBuf,
    data: Vec<u8>,
    writable: bool,
}

impl TestSftp {
    fn resolve(&self, path: &str) -> PathBuf {
        resolve_under(&self.root, path)
    }
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

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        // 写模式下的句柄要在这里落盘 —— 客户端就是靠 close 表示"写完收工"的
        if let Some(f) = self.open_files.remove(&handle) {
            if f.writable {
                std::fs::write(&f.path, &f.data).map_err(|_| StatusCode::Failure)?;
            }
        }
        Ok(ok_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = self.resolve(&path);
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
            self.root.to_string_lossy().to_string()
        } else {
            self.resolve(&path).to_string_lossy().to_string()
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
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let file = self.resolve(&path);
        let writable = flags.contains(OpenFlags::WRITE) || flags.contains(OpenFlags::CREATE);
        let truncate = flags.contains(OpenFlags::TRUNCATE);

        if !writable && !file.is_file() {
            return Err(StatusCode::NoSuchFile)
        }
        // 读模式要把已有内容装进来；写模式只在"没有 TRUNCATE 且文件存在"时续写
        let data = if truncate || !file.is_file() {
            Vec::new()
        } else {
            std::fs::read(&file).map_err(|_| StatusCode::Failure)?
        };

        let handle = format!("file:{path}");
        self.open_files.insert(
            handle.clone(),
            OpenFile {
                path: file,
                data,
                writable,
            },
        );
        Ok(Handle { id, handle })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let f = self.open_files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if !f.writable {
            return Err(StatusCode::PermissionDenied)
        }
        let start = offset as usize;
        if f.data.len() < start + data.len() {
            f.data.resize(start + data.len(), 0);
        }
        f.data[start..start + data.len()].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        std::fs::rename(self.resolve(&oldpath), self.resolve(&newpath)).map_err(|_| StatusCode::Failure)?;
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.resolve(&filename)).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.resolve(&path)).map_err(|_| StatusCode::Failure)?;
        Ok(ok_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let f = self.open_files.get(&handle).ok_or(StatusCode::Failure)?;
        let start = (offset as usize).min(f.data.len());
        let end = (start + len as usize).min(f.data.len());
        Ok(russh_sftp::protocol::Data {
            id,
            data: f.data[start..end].to_vec(),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let target = self.resolve(&path);
        let meta = std::fs::metadata(&target).map_err(|_| StatusCode::NoSuchFile)?;
        // mtime 必须给：传输那侧靠它判断「目标是不是已经和源端一致」
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as u32);
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(meta.len()),
                permissions: Some(if meta.is_dir() { 0o040_755 } else { 0o100_644 }),
                mtime,
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

async fn spawn_server(root: PathBuf) -> u16 {
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
    let instance: &'static mut TestServer = Box::leak(Box::new(TestServer { sftp_root: root }));
    let server = instance.run_on_address(config, ("127.0.0.1", port));
    tokio::spawn(async move {
        let _ = server.await;
    });

    // 就绪判定要**真连一次**，不能用「bind 失败」当信号：bind 失败也可能是这个端口
    // 被别的出站连接临时占了，那会被误判成「服务已就绪」，客户端于是连上别人的端口
    // （表现为偶发的「连接被拒绝」，或者更糟 —— 写进了另一个测试的 fixture）。
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
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
        compat: false,
    };
    let handle = connect_and_auth(&cfg).await.unwrap();
    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .unwrap()
}

fn build_fixture() -> PathBuf {
    // 每个测试一个独立目录。全都用 %TEMP%/easy-shell-sftp-{pid} 的话，
    // cargo test 并行跑同一个二进制时就是互相 remove_dir_all —— 之前是靠运气过的
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("easy-shell-sftp-{}-{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("subdir")).unwrap();
    std::fs::write(dir.join("hello.txt"), b"hello world").unwrap();
    std::fs::write(dir.join("subdir").join("nested.txt"), b"nested").unwrap();
    dir
}

#[tokio::test]
async fn sftp_列目录能拿到文件与子目录() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
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
    let port = spawn_server(fixture.clone()).await;
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
    let port = spawn_server(fixture.clone()).await;
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
        ConflictPolicy::Overwrite,
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

/// 收集进度事件，供断言用
fn collector() -> (
    Arc<Mutex<Vec<TransferEvent>>>,
    impl Fn(TransferEvent) + Send + Sync + 'static,
) {
    let events: Arc<Mutex<Vec<TransferEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (events, move |e: TransferEvent| {
        // 回调是在 async 流程里同步调用的，try_lock 就够，不会死锁
        if let Ok(mut v) = sink.try_lock() {
            v.push(e);
        }
    })
}

/// 把文件的 mtime 拨到指定时刻，用来构造「本地那份是不是已经更新」的确定场景
fn set_mtime(path: &std::path::Path, secs_ago: u64) {
    let t = std::time::SystemTime::now() - Duration::from_secs(secs_ago);
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(t).unwrap();
}

fn skips(events: &[TransferEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            TransferEvent::Skip { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

/**
 * 续传只认 `.part`，而且要先确认它确实是源文件的前缀。
 *
 * 造一个比 CHUNK 大的文件：这样从第一个 progress 事件就能看出偏移有没有生效 ——
 * 续传的话它 = 5 + 65536，全量重下则是 65536。只看最终内容的话，
 * 「重下一遍」也能通过，等于没测到续传。
 */
#[tokio::test]
async fn sftp_断点续传从_part文件接着传() {
    const CHUNK: usize = 64 * 1024;
    let fixture = build_fixture();
    let big = vec![b'x'; CHUNK * 2];
    std::fs::write(fixture.join("big.bin"), &big).unwrap();

    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-resume-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();

    // 伪造上次传到一半：目标名 + .part，前 5 个字节和源文件一致
    std::fs::write(dest.join("big.bin.part"), &big[..5]).unwrap();

    let (events, cb) = collector();
    let result = download_to(
        sftp.clone(),
        &fixture.join("big.bin").to_string_lossy(),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        cb,
    )
    .await;

    assert!(result.is_ok(), "续传失败: {:?}", result.err());
    assert_eq!(
        std::fs::read(dest.join("big.bin")).unwrap(),
        big,
        "续传拼出来的内容和源文件不一致"
    );
    assert!(
        !dest.join("big.bin.part").exists(),
        "传完应该把 .part 改名掉，不该留在原地"
    );

    let ev = events.lock().await;
    let first = ev
        .iter()
        .find_map(|e| match e {
            TransferEvent::Progress { transferred, .. } => Some(*transferred),
            _ => None,
        })
        .expect("没收到任何 progress 事件");
    assert!(
        first > CHUNK as u64,
        "第一个进度事件是 {first}，没有把已传的 5 字节算进去 —— 说明根本没续传，是重下的"
    );
}

/**
 * P0-2 的回归：目标文件里有半截内容、但没有 `.part` 时，**绝不能按偏移接着写**。
 *
 * 改造前的判定是「目标文件比源端小就当它是半截」，于是内容完全不同的旧文件
 * 会被当成前缀，拼出一份混合体。
 */
#[tokio::test]
async fn sftp_目标内容不同时不会被追加() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-append-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();

    // 同名文件，5 个字节，但内容和远端毫无关系（也不是 .part）
    std::fs::write(dest.join("hello.txt"), b"XXXXX").unwrap();

    let result = download_to(
        sftp.clone(),
        &fixture.join("hello.txt").to_string_lossy(),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;

    assert!(result.is_ok(), "下载失败: {:?}", result.err());
    assert_eq!(
        std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
        "hello world",
        "旧文件被当成半截追加了 —— 这正是改造前的问题"
    );
}

#[tokio::test]
async fn sftp_上传时远端_part_对不上会重传() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let src_root = std::env::temp_dir().join(format!("easy-shell-upbad-{}", std::process::id()));
    let src = src_root.join("payload");
    let _ = std::fs::remove_dir_all(&src_root);
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("top.txt"), b"top-level").unwrap();

    // 远端先留一个对不上的 .part（模拟"上次中断后本地文件被改过"）
    std::fs::write(fixture.join("top.txt.part"), b"ZZZZZ").unwrap();

    let result = upload_from(
        sftp.clone(),
        &src.join("top.txt").to_string_lossy(),
        ".",
        true,
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;

    assert!(result.is_ok(), "上传失败: {:?}", result.err());
    assert_eq!(
        std::fs::read_to_string(fixture.join("top.txt")).unwrap(),
        "top-level",
        "拿一份对不上的 .part 接着写，在服务端拼出了混合体"
    );
    assert!(
        !fixture.join("top.txt.part").exists(),
        "传完应该把 .part 改名掉"
    );

    let _ = std::fs::remove_dir_all(&src_root);
}

/// `.part` 存在但内容不是源文件的前缀（上次中断后远端换过文件）→ 必须重下，不能接着写
#[tokio::test]
async fn sftp_part_不是前缀时会重下() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-badpart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();

    std::fs::write(dest.join("hello.txt.part"), b"ZZZZZ").unwrap();

    let result = download_to(
        sftp.clone(),
        &fixture.join("hello.txt").to_string_lossy(),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;

    assert!(result.is_ok(), "下载失败: {:?}", result.err());
    assert_eq!(
        std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
        "hello world",
        "拿一份对不上的 .part 接着写，拼出了混合体"
    );
}

/// 目标已经和远端一致（大小相同 + 不早于远端 mtime）→ 跳过，并且**明确报出来**
#[tokio::test]
async fn sftp_已是最新时跳过而不是假装传过() {
    let fixture = build_fixture();
    // 把远端文件的 mtime 拨到一小时前，这样「本地更新」是确定的
    set_mtime(&fixture.join("hello.txt"), 3600);

    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-skip-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("hello.txt"), b"hello world").unwrap();

    let (events, cb) = collector();
    let result = download_to(
        sftp.clone(),
        &fixture.join("hello.txt").to_string_lossy(),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        cb,
    )
    .await;

    assert!(result.is_ok(), "下载失败: {:?}", result.err());
    let reasons = skips(&events.lock().await);
    assert!(
        reasons.iter().any(|r| r.contains("已是最新")),
        "没报「已是最新」的跳过事件，实际: {reasons:?}"
    );
}

/// 冲突策略：跳过就一个字都不动；保留两者则另起一个名字，两边都在
#[tokio::test]
async fn sftp_同名文件按策略跳过或改名保留() {
    let fixture = build_fixture();
    set_mtime(&fixture.join("hello.txt"), 3600);

    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    let dest = std::env::temp_dir().join(format!("easy-shell-conflict-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("hello.txt"), b"local-version").unwrap();

    // 策略 Skip：目标原样不动，并且报出跳过
    let (events, cb) = collector();
    download_to(
        sftp.clone(),
        &fixture.join("hello.txt").to_string_lossy(),
        &dest.to_string_lossy(),
        false,
        ConflictPolicy::Skip,
        cb,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
        "local-version",
        "选了跳过却把目标改了"
    );
    let reasons = skips(&events.lock().await);
    assert!(
        reasons.iter().any(|r| r.contains("目标已存在")),
        "没报「目标已存在」的跳过事件，实际: {reasons:?}"
    );

    // 策略 KeepBoth：目标留着，新内容落到「hello (2).txt」
    download_to(
        sftp.clone(),
        &fixture.join("hello.txt").to_string_lossy(),
        &dest.to_string_lossy(),
        false,
        ConflictPolicy::KeepBoth,
        |_e: TransferEvent| {},
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(dest.join("hello.txt")).unwrap(),
        "local-version",
        "保留两者却把原文件覆盖了"
    );
    assert_eq!(
        std::fs::read_to_string(dest.join("hello (2).txt")).unwrap(),
        "hello world",
        "保留两者没有另起名字"
    );
}

/**
 * 递归上传（此前零覆盖）。
 *
 * 上传方向一直没有测试，而这个假服务端原本连 write 都没有 —— 补上之后
 * 「本地目录树原样推到远端」这条链路才算有人守着。
 */
#[tokio::test]
async fn sftp_递归上传能还原整棵目录树() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    // 另造一个本地源目录，别和 ROOT（远端根）混在一起
    let src_root = std::env::temp_dir().join(format!("easy-shell-up-{}", std::process::id()));
    let src = src_root.join("payload");
    let _ = std::fs::remove_dir_all(&src_root);
    std::fs::create_dir_all(src.join("nested")).unwrap();
    std::fs::write(src.join("top.txt"), b"top-level").unwrap();
    std::fs::write(src.join("nested/deep.txt"), b"deep").unwrap();

    let result = upload_from(
        sftp.clone(),
        &src.to_string_lossy(),
        // 用相对路径当远端目录：假服务端的 resolve 对绝对路径是直通的
        // （真实应用传的本来就是绝对路径），写成 "/" 会落到盘符根目录去
        ".",
        false,
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;

    assert!(result.is_ok(), "递归上传失败: {:?}", result.err());

    let got_top = fixture.join("payload").join("top.txt");
    assert!(got_top.exists(), "顶层文件没传上去：{:?}", got_top);
    assert_eq!(std::fs::read_to_string(&got_top).unwrap(), "top-level");

    let got_deep = fixture.join("payload").join("nested").join("deep.txt");
    assert!(got_deep.exists(), "子目录里的文件没还原：{:?}", got_deep);
    assert_eq!(std::fs::read_to_string(&got_deep).unwrap(), "deep");

    let _ = std::fs::remove_dir_all(&src_root);
}

#[tokio::test]
async fn sftp_canonicalize_能拿到家目录绝对地址() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = connect_sftp(port).await;

    let pwd = sftp.canonicalize(".").await.unwrap();
    assert!(!pwd.is_empty(), "canonicalize 返回了空路径");
    assert_ne!(pwd, ".", "canonicalize 没把 . 展开成绝对路径：{pwd}");
}

/**
 * 远端 → 远端对拷（跨主机）：整棵目录树从 A 机流式搬到 B 机。
 *
 * 用**两个**真服务端模拟两台主机 —— 一个服务端上开两条通道只能覆盖"同一台两个
 * 目录"，跨主机那条（两台机器）才是这功能的主用例。数据在 Rust 侧流式中转，
 * 不经本地落盘，所以断言的是 B 机磁盘上还原出来的树。
 */
#[tokio::test]
async fn sftp_远端到远端对拷能还原整棵目录树() {
    let fixture_a = build_fixture();
    let fixture_b = build_fixture();
    let port_a = spawn_server(fixture_a.clone()).await;
    let port_b = spawn_server(fixture_b.clone()).await;
    let sftp_a = Arc::new(connect_sftp(port_a).await);
    let sftp_b = Arc::new(connect_sftp(port_b).await);

    let (events, cb) = collector();
    let result = copy_to(
        sftp_a.clone(),
        &fixture_a.to_string_lossy(),
        sftp_b.clone(),
        ".",
        ConflictPolicy::Overwrite,
        cb,
    )
    .await;

    assert!(result.is_ok(), "远端对拷失败: {:?}", result.err());
    assert!(
        events
            .lock()
            .await
            .iter()
            .any(|e| matches!(e, TransferEvent::Done { .. })),
        "没收到 Done 事件，进度回调没打通"
    );

    let name = fixture_a.file_name().unwrap();
    let hello = fixture_b.join(name).join("hello.txt");
    assert!(hello.exists(), "顶层文件没拷过去：{:?}", hello);
    assert_eq!(std::fs::read_to_string(&hello).unwrap(), "hello world");

    let nested = fixture_b.join(name).join("subdir").join("nested.txt");
    assert!(nested.exists(), "子目录里的文件没拷过去：{:?}", nested);
    assert_eq!(std::fs::read_to_string(&nested).unwrap(), "nested");
}

/// 同一台机器上把目录抄进它自己的子树 —— 必须拒绝，否则会拷出一个嵌套副本
#[tokio::test]
async fn sftp_对拷不许抄进自己的子目录() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = Arc::new(connect_sftp(port).await);

    // 同一条会话（同一个 SftpSession 句柄）才算"自己抄自己"
    let into_child = copy_to(
        sftp.clone(),
        &fixture.to_string_lossy(),
        sftp.clone(),
        &fixture.join("subdir").to_string_lossy(),
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;
    assert!(into_child.is_err(), "抄进自己的子目录居然成功了");

    let into_self = copy_to(
        sftp.clone(),
        &fixture.to_string_lossy(),
        sftp.clone(),
        &fixture.to_string_lossy(),
        ConflictPolicy::Overwrite,
        |_e: TransferEvent| {},
    )
    .await;
    assert!(into_self.is_err(), "抄进自己居然成功了");
}

/// 对拷的冲突策略：选了跳过就一个字都不动，并且报出跳过
#[tokio::test]
async fn sftp_对拷冲突skip时不覆盖() {
    let fixture_a = build_fixture();
    let fixture_b = build_fixture();
    let port_a = spawn_server(fixture_a.clone()).await;
    let port_b = spawn_server(fixture_b.clone()).await;
    let sftp_a = Arc::new(connect_sftp(port_a).await);
    let sftp_b = Arc::new(connect_sftp(port_b).await);

    std::fs::write(fixture_b.join("hello.txt"), b"B-version").unwrap();

    let (events, cb) = collector();
    copy_to(
        sftp_a.clone(),
        &fixture_a.join("hello.txt").to_string_lossy(),
        sftp_b.clone(),
        ".",
        ConflictPolicy::Skip,
        cb,
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(fixture_b.join("hello.txt")).unwrap(),
        "B-version",
        "选了跳过却把目标改了"
    );
    let reasons = skips(&events.lock().await);
    assert!(
        reasons.iter().any(|r| r.contains("目标已存在")),
        "没报「目标已存在」的跳过事件，实际: {reasons:?}"
    );
}

/// 新建文件是 create_new 语义：同名已存在报错，绝不覆盖
#[tokio::test]
async fn sftp_新建文件同名时报错不覆盖() {
    let fixture = build_fixture();
    let port = spawn_server(fixture.clone()).await;
    let sftp = connect_sftp(port).await;

    create_file(&sftp, &fixture.join("new.txt").to_string_lossy())
        .await
        .unwrap();
    assert!(fixture.join("new.txt").exists(), "新建的文件没落盘");

    let again = create_file(&sftp, &fixture.join("new.txt").to_string_lossy()).await;
    assert!(again.is_err(), "同名已存在居然没报错");

    let over_dir = create_file(&sftp, &fixture.join("subdir").to_string_lossy()).await;
    assert!(over_dir.is_err(), "拿已存在的目录名建文件居然没报错");

    assert_eq!(
        std::fs::read_to_string(fixture.join("hello.txt")).unwrap(),
        "hello world",
        "新建文件把别的文件动了"
    );
}

/// 本地侧的对称行为：local_create_file 同名报错、不覆盖
#[tokio::test]
async fn 本地新建文件同名时报错不覆盖() {
    let dir = std::env::temp_dir().join(format!("easy-shell-newfile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let target = dir.join("a.txt").to_string_lossy().to_string();
    local_create_file(target.clone()).unwrap();
    assert!(dir.join("a.txt").exists(), "新建的文件没落盘");

    let again = local_create_file(target.clone());
    assert!(again.is_err(), "同名已存在居然没报错");

    std::fs::create_dir_all(dir.join("sub")).unwrap();
    let over_dir = local_create_file(dir.join("sub").to_string_lossy().to_string());
    assert!(over_dir.is_err(), "拿已存在的目录名建文件居然没报错");

    let _ = std::fs::remove_dir_all(&dir);
}
