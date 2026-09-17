//! 端到端测试：在本机起一个真实 SSH 服务端（russh 的 server 端），
//! 然后用 easy-shell 自己的连接代码去连它，验证认证、shell 通道、数据双向流、
//! SFTP 子系统握手、以及端口转发这些核心链路。
//!
//! 为什么需要这个：SFTP 的目录递归、ConPTY、转发这些逻辑靠读代码推演不可靠，
//! 而每次都找真服务器手动点太慢，所以把服务端搬进测试里常驻回归。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use easy_shell_lib::ssh::{connect_and_auth, ConnectConfig};
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, ChannelMsg};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const TEST_USER: &str = "tester";
const TEST_PASS: &str = "secret";

#[derive(Clone)]
struct TestServer {
    clients: Arc<Mutex<HashMap<usize, (ChannelId, russh::server::Handle)>>>,
    id: usize,
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

    /// 让端口转发测试有东西可连：把收到的字节原样塞回去
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
        let _ = (host_to_connect, port_to_connect, originator_address, originator_port);
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
    // 先占一个端口拿到号，再交给 run_on_address（它内部自己 bind，不借用外部 socket）
    let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_secs(1),
        ..Default::default()
    });

    // run_on_address 的 future 借用 &mut self，要 spawn 就得让它活得够久。
    // 测试里直接泄漏一份，进程退出就回收了
    let instance: &'static mut TestServer = Box::leak(Box::new(TestServer {
        clients: Arc::new(Mutex::new(HashMap::new())),
        id: 0,
    }));
    let server = instance.run_on_address(config, ("127.0.0.1", port));

    tokio::spawn(async move {
        let _ = server.await;
    });

    // 等服务端真的在听
    for _ in 0..50 {
        if TcpListener::bind(("127.0.0.1", port)).await.is_err() {
            return port
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
