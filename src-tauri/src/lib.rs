use known_hosts::KnownHosts;

mod batcher;
/// decode 对外可见，tests/local_pty.rs 要用 ShellDecoder 验证真实 PTY 输出
pub mod decode;
mod known_hosts;
mod local;
/// sftp 模块对外可见，tests/ 里的端到端测试要用 list_dir
pub mod sftp;
/// ssh 模块对外可见，tests/ 里的端到端测试要用 connect_and_auth
pub mod ssh;
mod store;
mod tunnel;

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
            known_hosts::known_hosts_forget,
            store::vault_status,
            store::vault_setup,
            store::vault_unlock,
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
