use known_hosts::KnownHosts;

mod batcher;
/// 批量执行：在一条已认证的会话上开 exec 通道跑一条命令（只跑一条，
/// 「跑哪几台 / 并发几个 / 重不重试」是前端的事）。单独成模块是因为
/// 它跟终端那条长跑的 shell 通道是两种生命周期
pub mod batch;
/// decode 对外可见，tests/local_pty.rs 要用 ShellDecoder 验证真实 PTY 输出
pub mod decode;
mod known_hosts;
/// 恢复密钥：把库密钥封给一把 SSH 公钥。单独成模块是为了能单测那套 ECDH 组合
mod recovery;
mod local;
/// sftp 模块对外可见，tests/ 里的端到端测试要用 list_dir
pub mod sftp;
/// ssh 模块对外可见，tests/ 里的端到端测试要用 connect_and_auth
pub mod ssh;
mod store;
/// tunnel 模块对外可见，tests/ 里的端到端测试要驱动转发自身的监听循环
pub mod tunnel;

pub fn run() {
    let vault = store::Vault::new().expect("初始化密钥库失败");

    // known_hosts 失败不致命 —— 最多就是主机密钥校验退化成全盘接受，
    // 总比因为写不了文件就起不来强
    if let Err(e) = known_hosts::default_path().and_then(KnownHosts::init) {
        eprintln!("known_hosts 初始化失败，主机密钥校验已关闭: {e}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(local::LocalState::default())
        .manage(tunnel::TunnelState::default())
        .manage(vault)
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_reconnect,
            ssh::ssh_open_shell,
            ssh::ssh_input,
            ssh::ssh_resize,
            // 整条会话连锅端。只给「锁定密钥库」用：平时关标签走 ssh_close_channel，
            // 用这个会把共用同一条 SSH 的兄弟标签一起带死
            ssh::ssh_close,
            ssh::ssh_close_channel,
            // 在已有会话上跑一条命令并收回 stdout / stderr / 退出码（批量执行用）
            batch::ssh_exec,
            known_hosts::known_hosts_forget,
            store::vault_status,
            store::vault_setup,
            store::vault_unlock,
            // 改主密码（传空串 = 改成不设密码），所有凭据用新密钥重新加密
            store::vault_change_password,
            // 恢复密钥：把主密钥封给一把 SSH 公钥；忘密码时用对应私钥解锁
            store::vault_recovery_set,
            store::vault_recovery_clear,
            store::vault_unlock_with_key,
            store::vault_lock,
            // 清空密钥库（忘记主密码时的唯一出路），不可撤销
            store::vault_reset,
            store::hosts_list,
            store::hosts_save,
            store::hosts_delete,
            store::groups_list,
            store::groups_save,
            store::groups_delete,
            store::snippets_list,
            store::snippets_save,
            store::snippets_delete,
            sftp::sftp_open,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_pwd,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_close,
            sftp::local_list,
            sftp::local_home,
            sftp::local_mkdir,
            sftp::local_remove,
            sftp::local_rename,
            sftp::local_copy,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            sftp::local_read_text,
            sftp::local_write_text,
            local::local_open,
            local::local_input,
            local::local_resize,
            local::local_close,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running easy-shell")
}
