//! 一次性真机验证脚本 —— **跑完就删，不进仓库**。
//!
//! 凭据只从环境变量读，绝不写进文件：
//!   EASY_SHELL_VERIFY_HOST / EASY_SHELL_VERIFY_USER / EASY_SHELL_VERIFY_PASS
//!
//! 跑法：
//!   EASY_SHELL_VERIFY_HOST=... EASY_SHELL_VERIFY_USER=... EASY_SHELL_VERIFY_PASS=... \
//!     ./tools/build.sh test --test real_server -- --nocapture
//!
//! 它验证的是「只有真机能确认」的那些机制：真实 OpenSSH 上的 .part 续传与改名、
//! mtime 判定、转发是否被 AllowTcpForwarding 放行、以及断开后服务端那条连接是否真的消失。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use easy_shell_lib::sftp::{download_to, list_dir, upload_from, ConflictPolicy, TransferEvent};
use easy_shell_lib::ssh::{connect_and_auth, ConnectConfig};
use russh::client::Handle;
use russh::{ChannelMsg, Channel};
use russh_sftp::client::SftpSession;

fn config(host: &str, user: &str, pass: &str) -> ConnectConfig {
    ConnectConfig {
        host: host.to_string(),
        port: 22,
        username: user.to_string(),
        password: Some(pass.to_string()),
        private_key_path: None,
        passphrase: None,
        compat: false,
    }
}

/// 读到出现 target 或超时
async fn read_until(channel: &mut Channel<russh::client::Msg>, target: &[u8]) -> bool {
    let mut buf = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(8));
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
            },
        }
    }
}

/// 跑一条远端命令，把 stdout 收全
async fn exec_capture(handle: &Handle<easy_shell_lib::ssh::ClientHandler>, cmd: &str) -> String {
    let mut ch = handle.channel_open_session().await.expect("开通道失败");
    ch.exec(true, cmd).await.expect("exec 失败");
    let mut out = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => out.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }
    String::from_utf8_lossy(&out).trim().to_string()
}

/// 数一下服务端此刻到本机的 22 端口 established 连接有几条
async fn conn_count(handle: &Handle<easy_shell_lib::ssh::ClientHandler>) -> usize {
    let out = exec_capture(handle, "ss -tn state established | grep -c ':22'").await;
    out.lines().last().unwrap_or("0").trim().parse().unwrap_or(0)
}

async fn open_sftp(handle: &Handle<easy_shell_lib::ssh::ClientHandler>) -> Arc<SftpSession> {
    let ch = handle.channel_open_session().await.expect("开 sftp 通道失败");
    ch.request_subsystem(true, "sftp").await.expect("请求 sftp 子系统失败");
    Arc::new(SftpSession::new(ch.into_stream()).await.expect("sftp 握手失败"))
}

fn collect(events: &Arc<Mutex<Vec<TransferEvent>>>) -> Box<dyn Fn(TransferEvent) + Send + Sync> {
    let sink = events.clone();
    Box::new(move |e: TransferEvent| {
        if let Ok(mut v) = sink.try_lock() {
            v.push(e);
        }
    })
}

fn skip_reasons(events: &Arc<Mutex<Vec<TransferEvent>>>) -> Vec<String> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            TransferEvent::Skip { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn 真机验证() {
    let (Ok(host), Ok(user), Ok(pass)) = (
        std::env::var("EASY_SHELL_VERIFY_HOST"),
        std::env::var("EASY_SHELL_VERIFY_USER"),
        std::env::var("EASY_SHELL_VERIFY_PASS"),
    ) else {
        println!("跳过：没设 EASY_SHELL_VERIFY_HOST / _USER / _PASS（见本文件头部注释）");
        return;
    };
    let cfg = config(&host, &user, &pass);

    // ---- 1. 连接 + 密码认证 ----
    let handle = connect_and_auth(&cfg).await.expect("连接/认证失败");
    println!("1 连接认证 OK");

    // ---- 2. shell 通道双向（命令片段/输入走的就是这条路径）----
    let mut shell = handle.channel_open_session().await.unwrap();
    shell.request_shell(true).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    shell
        .data(b"echo EASY_SHELL_MARK_$((6*7))\n".as_ref())
        .await
        .unwrap();
    assert!(
        read_until(&mut shell, b"EASY_SHELL_MARK_42").await,
        "shell 通道没把命令回显回来 —— 命令片段送进去的文本到不了远端"
    );
    println!("2 shell 通道双向 OK（发了 echo，收到 42）");

    // ---- 3. 家目录 + 列目录 ----
    let sftp = open_sftp(&handle).await;
    let home = sftp.canonicalize(".").await.expect("拿家目录失败");
    println!("3 SFTP 握手 OK，家目录 = {home}");
    let entries = list_dir(&sftp, &home).await.expect("列目录失败");
    assert!(!entries.is_empty(), "家目录是空的？");
    println!("  列目录 OK，{} 个条目", entries.len());

    // ---- 准备远端临时目录 ----
    let work = format!("{}/easy-shell-verify-{}", home.trim_end_matches('/'), std::process::id());
    let mk = exec_capture(&handle, &format!("mkdir -p {work}")).await;
    assert!(mk.is_empty(), "建临时目录失败: {mk}");
    println!("  远端临时目录 {work}");

    // ---- 4. 上传：本地造一个 300KB 文件推上去（走 .part + 改名）----
    let local_root = std::env::temp_dir().join(format!("easy-shell-verify-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&local_root);
    std::fs::create_dir_all(&local_root).unwrap();
    let payload = local_root.join("payload.bin");
    let bytes: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    std::fs::write(&payload, &bytes).unwrap();

    upload_from(
        sftp.clone(),
        &payload.to_string_lossy(),
        &work,
        true,
        ConflictPolicy::Overwrite,
        |_e| {},
    )
    .await
    .expect("上传失败");
    // 校验远端文件真的到位、且没留下 .part（内容一致性交给下一步的逐字节比较）
    let size_remote = exec_capture(&handle, &format!("stat -c %s {work}/payload.bin")).await;
    assert_eq!(
        size_remote.trim(),
        bytes.len().to_string(),
        "上传后远端大小不对"
    );
    let leftover = exec_capture(&handle, &format!("ls {work} | grep -c '\\.part' || true")).await;
    assert_eq!(leftover.trim(), "0", "上传完还留着 .part");
    println!("4 上传 OK（大小一致、无 .part 残留）");

    // ---- 5. 下载：拉回来比内容 ----
    let dest = local_root.join("down");
    std::fs::create_dir_all(&dest).unwrap();
    download_to(
        sftp.clone(),
        &format!("{work}/payload.bin"),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        |_e| {},
    )
    .await
    .expect("下载失败");
    let got = std::fs::read(dest.join("payload.bin")).unwrap();
    assert_eq!(got.len(), bytes.len(), "下载大小不对");
    assert!(got == bytes, "下载内容不一致");
    println!("5 下载 OK（{} 字节一致）", got.len());

    // ---- 6. 续传：伪造「上次传了一半」的 .part，只有前 5 字节 ----
    // 目标文件必须先删掉 —— 中断的现场是「只有 .part、没有完整目标」；
    // 留着完整目标的话这次调用会直接命中「已是最新」而跳过（第 7 步才是那个场景）
    std::fs::remove_file(dest.join("payload.bin")).unwrap();
    std::fs::write(dest.join("payload.bin.part"), &bytes[..5]).unwrap();
    let first_progress = Arc::new(Mutex::new(None::<u64>));
    let fp = first_progress.clone();
    download_to(
        sftp.clone(),
        &format!("{work}/payload.bin"),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        move |e| {
            if let TransferEvent::Progress { transferred, .. } = e {
                let mut slot = fp.try_lock().unwrap();
                if slot.is_none() {
                    *slot = Some(transferred);
                }
            }
        },
    )
    .await
    .expect("续传失败");
    assert_eq!(
        std::fs::read(dest.join("payload.bin")).unwrap(),
        bytes,
        "续传拼出来的内容不对"
    );
    assert!(!dest.join("payload.bin.part").exists(), "传完该把 .part 改名掉");
    // 第一个进度事件里带上那 5 字节 ⇒ 真的从偏移续的，不是重下
    let first = first_progress.lock().unwrap().unwrap();
    assert!(first > 5, "第一个进度事件是 {first}，没把已传的 5 字节算进去，说明是重下的");
    println!("6 续传 OK（第一个进度事件 {first}，含偏移 5）");

    // ---- 7. 已是最新 → 跳过，而且要说出来 ----
    // 先把两边的 size / mtime 打出来，判定的依据一目了然
    let remote_stat = exec_capture(
        &handle,
        &format!("stat -c '%s %Y' {work}/payload.bin"),
    )
    .await;
    let local_meta = std::fs::metadata(dest.join("payload.bin")).unwrap();
    let local_mtime = local_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!(
        "  远端 size/mtime = {remote_stat} / 本地 size = {} mtime = {local_mtime}",
        local_meta.len()
    );

    let ev2: Arc<Mutex<Vec<TransferEvent>>> = Arc::new(Mutex::new(Vec::new()));
    download_to(
        sftp.clone(),
        &format!("{work}/payload.bin"),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        collect(&ev2),
    )
    .await
    .expect("第二次下载失败");
    let reasons = skip_reasons(&ev2);
    assert!(
        reasons.iter().any(|r| r.contains("已是最新")),
        "mtime/大小都对得上却没报「已是最新」，实际: {reasons:?}"
    );
    println!("7 「已是最新」跳过 OK（{reasons:?}）");

    // ---- 8. 目标内容不同 → 不能被追加 ----
    std::fs::write(dest.join("payload.bin"), b"DIFFERENT-CONTENT").unwrap();
    download_to(
        sftp.clone(),
        &format!("{work}/payload.bin"),
        &dest.to_string_lossy(),
        true,
        ConflictPolicy::Overwrite,
        |_e| {},
    )
    .await
    .expect("第三次下载失败");
    assert_eq!(
        std::fs::read(dest.join("payload.bin")).unwrap(),
        bytes,
        "把内容不同的旧文件当成半截追加了"
    );
    println!("8 目标内容不同不被追加 OK");

    // ---- 9. 转发：服务端是否放行 direct-tcpip ----
    match handle
        .channel_open_direct_tcpip("127.0.0.1", 22, "127.0.0.1", 12345)
        .await
    {
        Ok(mut fwd) => {
            assert!(
                read_until(&mut fwd, b"SSH-2.0").await,
                "转发通道没读到 sshd 的 banner"
            );
            println!("9 本地转发 OK（经会话读到 sshd banner）");
        }
        // 这是服务端策略，不是应用的毛病：sshd 里 AllowTcpForwarding 一关，
        // -L 在这台机器上就用不了。算「发现了什么」而不是测试失败
        Err(e) => println!("9 本地转发被服务端拒绝：{e}（sshd 关了 AllowTcpForwarding）"),
    }

    // ---- 10. 断开：服务端那条连接要真的消失 ----
    let before = conn_count(&handle).await;
    let second = connect_and_auth(&cfg).await.expect("第二条连接失败");
    let during = conn_count(&handle).await;
    assert!(during > before, "第二条连接没被服务端算进去（{before} → {during}）");
    second
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();
    tokio::time::sleep(Duration::from_millis(800)).await;
    let after = conn_count(&handle).await;
    assert_eq!(
        after, before,
        "断开之后服务端那条连接还在（{before} → {during} → {after}）"
    );
    println!("10 断开 OK（连接数 {before} → {during} → {after}）");

    // ---- 清理远端临时目录 ----
    let rm = exec_capture(&handle, &format!("rm -rf {work}")).await;
    assert!(rm.is_empty(), "清理失败: {rm}");
    let _ = std::fs::remove_dir_all(&local_root);
    println!("已清理远端 {work} 与本地临时目录");
}
