//! 本地 Shell 的真实 PTY 测试。
//!
//! decode.rs 里的单元测试用的是手写字节，能证明解码逻辑正确，但证明不了
//! 「Windows 上 PowerShell 真的会吐出非 UTF-8 的中文」这个前提 —— 而这个前提
//! 正是整个转码功能的立身之本。这里起一个真的 PowerShell，让它输出中文，
//! 把 PTY 的原始字节喂给 ShellDecoder，看最后能不能拿到正确的字符串。
//!
//! 只在 Windows 跑：本地 Shell 的乱码问题本来就是 Windows 控制台代码页造成的。

#![cfg(windows)]

use std::sync::mpsc;
use std::time::{Duration, Instant};

use easy_shell_lib::decode::ShellDecoder;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// 起 PowerShell 输出中文，返回解码后的文本
fn run_powershell(script: &str) -> String {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("创建 PTY 失败");

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-NoProfile");
    // 不加这个的话，PowerShell 有可能停在等输入的地方，读端就一直阻塞着
    cmd.arg("-NonInteractive");
    cmd.arg("-Command");
    cmd.arg(script);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .expect("启动 PowerShell 失败");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("拿不到 PTY 读端");
    let mut writer = pair.master.take_writer().expect("拿不到 PTY 写端");

    // 读端是阻塞的，丢到独立线程里读，主线程用超时兜底 ——
    // 万一 PowerShell 卡住，测试也不至于把整个 cargo test 拖挂
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    // PowerShell 一上来会发 ESC[6n 问光标位置，没人回它就一直干等着，
                    // 后面的命令一个都不执行（实测卡出来的输出就只有这个转义序列）。
                    // 真实应用里是 xterm.js 接住并回应，测试里得自己回一个。
                    if chunk[..n].windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    if tx.send(chunk[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut decoder = ShellDecoder::new();
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(20);

    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(bytes) => text.push_str(&decoder.push(&bytes)),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            // 读线程结束了，输出已经收完
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // 流结束，把末尾可能卡着的半个字逼出来
    text.push_str(&decoder.finish());
    let _ = child.kill();
    text
}

#[test]
fn powershell_的中文输出能解成正确的字符串() {
    let text = run_powershell("Write-Output '中文测试'");
    assert!(
        text.contains("中文测试"),
        "PowerShell 输出的中文没解出来。解码后拿到的内容：{text:?}"
    );
}

#[test]
fn powershell_输出中文文件名不乱码() {
    // 顺带验证中文路径这种更实际的场景
    let text = run_powershell("$env:LOCALAPPDATA; Write-Output '结束'");
    assert!(
        text.contains("结束"),
        "中文输出没解出来。解码后拿到的内容：{text:?}"
    );
}
