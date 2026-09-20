//! 端到端测试：在本机起一个真实 SSH 服务端（russh 的 server 端），
//! 然后用 easy-shell 自己的连接代码去连它，验证认证、shell 通道、数据双向流、
//! SFTP 子系统握手、以及端口转发这些核心链路。
//!
//! 为什么需要这个：SFTP 的目录递归、ConPTY、转发这些逻辑靠读代码推演不可靠，
//! 而每次都找真服务器手动点太慢，所以把服务端搬进测试里常驻回归。

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use easy_shell_lib::ssh::{connect_and_auth, ConnectConfig, ConnectError};
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{cipher, kex, Channel, ChannelId, ChannelMsg, Preferred};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const TEST_USER: &str = "tester";
const TEST_PASS: &str = "secret";

#[derive(Clone)]
struct TestServer {
    clients: Arc<Mutex<HashMap<usize, (ChannelId, russh::server::Handle)>>>,
    id: usize,
    /// 服务端收到的转发目标 (host, port)。真 sshd 会拿它去连，这里记下来给测试断言
    forward_log: Arc<Mutex<Vec<(String, u32)>>>,
}

impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
        let s = self.clone();
        self.id += 1;
        s
    }
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.clients
            .lock()
            .await
            .insert(self.id, (channel.id(), session.handle()));
        reply.accept().await;
        Ok(())
    }

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

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, b"easy-shell$ ".to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let echo = format!("ECHO:{}\r\n", String::from_utf8_lossy(data).trim_end());
        session.data(channel, echo.into_bytes())?;
        Ok(())
    }

    /**
     * 批量执行那条路：`exec` 请求。
     *
     * 回复顺序**刻意照真 sshd 来**：先输出、再退出码、然后**再补一段输出**、最后 eof。
     * 退出码之后那一段是最容易被丢的（把退出码当结束信号的实现会丢它），
     * 而且丢掉的往往正是报错那几行。
     * 命令里带 `hang` 就不发 eof —— 用来验证超时标记真的会置上。
     */
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        let cmd = cmd.trim().to_string();
        session.data(channel, format!("OUT:{cmd}\n").into_bytes())?;
        session.extended_data(channel, 1, b"ERR:warn\n".to_vec())?;
        // 挂死的命令：只有输出、没有退出码也没有 eof —— 跟真机上一条还在跑的命令一样
        if cmd.contains("hang") {
            return Ok(())
        }
        let _ = session.exit_status_request(channel, 3);
        session.data(channel, b"TAIL\n".to_vec())?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    /// 让端口转发测试有东西可连：把收到的字节原样塞回去。
    ///
    /// 目标端口 0 一律拒 —— 真 sshd 会去连这个 (host, port)，端口 0 谁也连不上。
    /// 假服务端如果闭眼 accept，转发代码把「目标」和「发起方」两组参数写反了
    /// 也照样能收到数据，这个 bug 就是这么溜过去的。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.forward_log
            .lock()
            .await
            .push((host_to_connect.to_string(), port_to_connect));
        let _ = (originator_address, originator_port);
        if port_to_connect == 0 {
            reply
                .reject(russh::ChannelOpenFailure::ConnectFailed)
                .await;
            return Ok(());
        }
        reply.accept().await;
        // 不能在这里直接发：此刻通道还没确认，数据会被丢掉。
        // 交给另一个任务，等通道建好再推
        let handle = session.handle();
        let id = channel.id();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = handle.data(id, b"TUNNEL:".to_vec()).await;
        });
        Ok(())
    }
}

/// 起一个监听 127.0.0.1 随机端口的服务端，返回端口号
async fn spawn_server() -> u16 {
    spawn_server_with(Preferred::DEFAULT).await
}

/// 起一个算法表被限定的服务端 —— 用来假装只认已废弃算法的老设备
async fn spawn_server_with(preferred: Preferred) -> u16 {
    spawn_server_recording(preferred).await.0
}

/// 同上，额外把「服务端收到的转发目标」交给测试断言
async fn spawn_server_recording(
    preferred: Preferred,
) -> (u16, Arc<Mutex<Vec<(String, u32)>>>) {
    // 先占一个端口拿到号，再交给 run_on_address（它内部自己 bind，不借用外部 socket）
    let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        preferred,
        auth_rejection_time: Duration::from_secs(1),
        ..Default::default()
    });

    // run_on_address 的 future 借用 &mut self，要 spawn 就得让它活得够久。
    // 测试里直接泄漏一份，进程退出就回收了
    let log: Arc<Mutex<Vec<(String, u32)>>> = Arc::new(Mutex::new(Vec::new()));
    let instance: &'static mut TestServer = Box::leak(Box::new(TestServer {
        clients: Arc::new(Mutex::new(HashMap::new())),
        id: 0,
        forward_log: log.clone(),
    }));
    let server = instance.run_on_address(config, ("127.0.0.1", port));

    tokio::spawn(async move {
        let _ = server.await;
    });

    // 等服务端真的在听
    // 就绪判定要**真连一次**，不能用「bind 失败」当信号：bind 失败也可能是这个端口
    // 被别的出站连接临时占了，那会被误判成「服务已就绪」，客户端于是连上别人的端口
    // （表现为偶发的「连接被拒绝」，或者更糟 —— 写进了另一个测试的 fixture）。
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return (port, log)
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("测试服务端没能在 {port} 上起来")
}

fn config_for(port: u16) -> ConnectConfig {
    ConnectConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: TEST_USER.to_string(),
        password: Some(TEST_PASS.to_string()),
        private_key_path: None,
        passphrase: None,
        compat: false,
    }
}

#[tokio::test]
async fn 密码认证能连上() {
    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await;
    assert!(handle.is_ok(), "认证失败: {:?}", handle.err());
}

#[tokio::test]
async fn 错误密码被拒绝() {
    let port = spawn_server().await;
    let mut cfg = config_for(port);
    cfg.password = Some("wrong".to_string());
    let result = connect_and_auth(&cfg).await;
    assert!(result.is_err(), "错误密码竟然通过了");
}

/**
 * 老设备：服务端只提供 dh-group1-sha1 + aes128-cbc，别的都不谈。
 *
 * 单测只能验证「算法表里有没有这些名字」，协商到底成不成得靠真握手 ——
 * 这条用例同时守住两头：不带兼容模式要失败**且明确说值得重试**（前端靠
 * compat_hint 决定要不要给「用兼容算法重试」那个按钮），带了就要真能连上。
 */
#[tokio::test]
async fn 老设备只认废弃算法时兼容模式能连上() {
    let port = spawn_server_with(Preferred {
        kex: Cow::Owned(vec![kex::DH_G1_SHA1]),
        cipher: Cow::Owned(vec![cipher::AES_128_CBC]),
        ..Preferred::DEFAULT
    })
    .await;

    let strict = connect_and_auth(&config_for(port)).await;
    match strict {
        Err(ConnectError::AlgorithmsUnsupported {
            compat_hint,
            message,
        }) => {
            assert!(compat_hint, "kex 谈不拢却没告诉前端可以试兼容模式: {message}");
        }
        Err(other) => panic!("期望算法不兼容错误，实际拿到: {other:?}"),
        // Handle 没有实现 Debug，所以这条分支不能塞进上面那句里
        Ok(_) => panic!("默认算法竟然连上了 —— 测试服务端的算法限制没生效"),
    }

    let mut cfg = config_for(port);
    cfg.compat = true;
    let handle = connect_and_auth(&cfg).await;
    assert!(
        handle.is_ok(),
        "开了兼容模式仍然连不上，这条路就是死的: {:?}",
        handle.err()
    );
}

#[tokio::test]
async fn rsa_私钥能认证() {
    let port = spawn_server().await;

    // 生成一把 RSA 私钥，以 OpenSSH 格式落到临时文件
    let key =
        PrivateKey::random(&mut rand10::rng(), Algorithm::Rsa { hash: Some(HashAlg::Sha256) })
            .expect("生成 RSA 密钥失败");
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .expect("序列化 RSA 私钥失败");
    let path = std::env::temp_dir().join(format!("easy-shell-rsa-{}.key", std::process::id()));
    std::fs::write(&path, pem.as_bytes()).expect("写私钥文件失败");

    let cfg = ConnectConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: TEST_USER.to_string(),
        password: None,
        private_key_path: Some(path.to_string_lossy().to_string()),
        passphrase: None,
        compat: false,
    };

    let result = connect_and_auth(&cfg).await;
    assert!(result.is_ok(), "RSA 密钥认证失败: {:?}", result.err());

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn shell_通道能收发数据() {
    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    let mut channel = handle.channel_open_session().await.unwrap();
    channel.request_shell(true).await.unwrap();

    // 服务端在 shell 建立时会推一个提示符
    let prompt = read_until(&mut channel, b"easy-shell$ ").await;
    assert!(prompt, "没收到 shell 提示符");

    channel.data(b"hello\n".as_ref()).await.unwrap();

    let echoed = read_until(&mut channel, b"ECHO:hello").await;
    assert!(echoed, "发出去的 hello 没被回显回来");
}

/**
 * 批量执行：`exec` 一次、把输出收回来。
 *
 * 这条链路的三件事靠读协议推演不可靠 —— stderr 到底走不走 extended data、
 * 退出码之后还会不会有数据、超时到底会不会被标记。假服务端按真 sshd 的顺序回，
 * 于是这三件事都在这个用例里有断言。
 */
#[tokio::test]
async fn exec_能收回输出与退出码() {
    use easy_shell_lib::batch::collect_exec;

    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    let mut channel = handle.channel_open_session().await.unwrap();
    channel.exec(true, "ls -l").await.unwrap();

    let result = collect_exec(&mut channel, Duration::from_secs(5)).await;
    assert_eq!(result.exit_code, Some(3), "退出码没拿到");
    assert!(result.stdout.contains("OUT:ls -l"), "stdout 不对: {:?}", result.stdout);
    assert!(
        result.stdout.contains("TAIL"),
        "退出码之后的输出丢了 —— 那一段常常正是报错信息: {:?}",
        result.stdout
    );
    assert!(
        result.stderr.contains("ERR:warn"),
        "stderr 没走 extended data: {:?}",
        result.stderr
    );
    assert!(!result.timed_out, "命令正常结束却被标成了超时");
}

/// 挂死的命令必须能靠时限脱身，而且**要明确标成超时** ——
/// 不标的话前端会拿那段截断的输出当完整结果，退出码又是 null，看着像成功
#[tokio::test]
async fn exec_挂死时按超时收场() {
    use easy_shell_lib::batch::collect_exec;

    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    let mut channel = handle.channel_open_session().await.unwrap();
    channel.exec(true, "hang").await.unwrap();

    let result = collect_exec(&mut channel, Duration::from_millis(300)).await;
    assert!(result.timed_out, "服务端一直不结束，却没有被标成超时");
    // 掐断之前收到的输出要留着 —— 知道它跑到哪一步比什么都看不到强
    assert!(result.stdout.contains("OUT:hang"), "超时前的输出不该丢");
    assert_eq!(result.exit_code, None, "超时了不该凭空编一个退出码出来");
}

#[tokio::test]
async fn sftp_子系统能握手() {
    use russh_sftp::client::SftpSession;

    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    let channel = handle.channel_open_session().await.unwrap();
    // 测试服务端没实现 sftp 子系统，所以这里只验证"请求能被发出去且流程不 panic"。
    // 真正的列目录需要对端有 sftp server，留给真机验证
    let result = channel.request_subsystem(true, "sftp").await;
    assert!(result.is_ok(), "请求 sftp 子系统失败: {:?}", result.err());

    // 即便对端不支持，SftpSession::new 也应该能被调用而不卡死
    let stream = channel.into_stream();
    let _ = tokio::time::timeout(Duration::from_secs(2), SftpSession::new(stream)).await;
}

#[tokio::test]
async fn 端口转发能开通道() {
    let port = spawn_server().await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    let mut channel = handle
        .channel_open_direct_tcpip("127.0.0.1", 12345, "example.com", 80)
        .await
        .unwrap();

    let got = read_until(&mut channel, b"TUNNEL:").await;
    assert!(got, "转发通道没收到服务端数据");
}

/// 走上层的转发代码（`tunnel::forward_accept_loop`），而不是直接调 russh 开通道。
///
/// 上面那条用例只证明「russh 的 API 会用」，没碰应用自己的参数拼装 ——
/// tunnel.rs 把目标 (host, port) 和发起方 (addr, port) 两组参数写反了很久都没人发现，
/// 真机上的表现是「本地端口能连上，然后一个字节都收不到就断」（服务端去连 127.0.0.1:0）。
#[tokio::test]
async fn 端口转发能把本地连接的数据带回来() {
    let (port, forward_log) = spawn_server_recording(Preferred::DEFAULT).await;
    let handle = connect_and_auth(&config_for(port)).await.unwrap();

    // 监听端口交给内核分配，别和别的测试抢固定端口
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let listen_port = listener.local_addr().unwrap().port();

    let stop = Arc::new(AtomicBool::new(false));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    tokio::spawn(easy_shell_lib::tunnel::forward_accept_loop(
        Arc::new(Mutex::new(handle)),
        listener,
        "127.0.0.1".to_string(),
        22,
        stop.clone(),
        last_error.clone(),
    ));

    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", listen_port))
        .await
        .unwrap();
    let mut got = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        let mut chunk = [0u8; 256];
        tokio::select! {
            _ = &mut deadline => break,
            read = client.read(&mut chunk) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    got.extend_from_slice(&chunk[..n]);
                    if got.windows(7).any(|w| w == b"TUNNEL:") {
                        break
                    }
                }
            }
        }
    }
    stop.store(true, Ordering::SeqCst);

    assert!(
        got.windows(7).any(|w| w == b"TUNNEL:"),
        "转发没把服务端数据带回来，收到的是 {:?}",
        String::from_utf8_lossy(&got)
    );
    assert_eq!(
        forward_log.lock().await.clone(),
        vec![("127.0.0.1".to_string(), 22)],
        "服务端收到的转发目标不对 —— 目标应写在前两个参数里"
    );
}

/// 一直读 channel 直到累计数据里出现 target，或超时。
/// 注意这里是客户端的 Channel<client::Msg>，和服务端的 Msg 不是同一个类型
async fn read_until(channel: &mut russh::Channel<russh::client::Msg>, target: &[u8]) -> bool {
    let mut buf = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => return false,
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    buf.extend_from_slice(&data);
                    if buf.windows(target.len()).any(|w| w == target) {
                        return true
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return false,
                _ => {}
            }
        }
    }
}
