//! known_hosts：主机密钥指纹库，防中间人攻击。
//!
//! 文件格式跟 OpenSSH 的 known_hosts 一致（每行 `host:port keytype base64`），
//! 好处是可以直接从 `~/.ssh/known_hosts` 复制过来，也能被别的工具读。
//!
//! 策略是 TOFU（Trust On First Use）：第一次连自动记住并放行；
//! 之后如果同一台主机的密钥变了，**直接拒绝**——这大概率是有人在中间，
//! 或者是服务器重装了，两种情况都该让人看一眼。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub enum KeyCheck {
    /// 记录里有，且对得上
    Matches,
    /// 第一次见这台主机
    Unknown,
    /// 记录里有，但对不上。多半是中间人或者服务器重装了
    Mismatch { expected: String },
}

pub struct KnownHosts {
    path: PathBuf,
    /// "host:port" -> "ssh-ed25519 AAAA..."
    entries: Mutex<HashMap<String, String>>,
}

static INSTANCE: OnceLock<KnownHosts> = OnceLock::new();

/// 最近一次密钥不匹配的详情。
///
/// 为什么绕这么一圈：check_server_key 只能回 true/false，russh 拿到 false 就抛一个
/// 通用错误，用户那边只能看到"连接失败"，看不出是中间人还是服务器重装。
/// 所以这里把详情暂存一下，connect_and_auth 捕获错误时捞出来拼进报错里。
static LAST_MISMATCH: Mutex<Option<String>> = Mutex::new(None);

/// 取出并清空最近一次不匹配详情
pub fn take_mismatch() -> Option<String> {
    LAST_MISMATCH.lock().unwrap().take()
}

impl KnownHosts {
    fn from_path(path: PathBuf) -> Self {
        let entries = Self::read_file(&path);
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    /// 在应用启动时调一次。之后用 global() 取
    pub fn init(path: PathBuf) -> Result<(), String> {
        INSTANCE
            .set(Self::from_path(path))
            .map_err(|_| "known_hosts 重复初始化".to_string())
    }

    /// 没初始化过就是 None —— 此时校验退化为全盘接受（集成测试走这条路）
    pub fn global() -> Option<&'static KnownHosts> {
        INSTANCE.get()
    }

    fn read_file(path: &PathBuf) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let Ok(text) = std::fs::read_to_string(path) else {
            return map;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // host:port keytype base64
            let mut parts = line.split_whitespace();
            let host = parts.next();
            let keytype = parts.next();
            let key = parts.next();
            if let (Some(h), Some(t), Some(k)) = (host, keytype, key) {
                map.insert(h.to_string(), format!("{t} {k}"));
            }
        }
        map
    }

    fn persist(&self) -> Result<(), String> {
        let mut lines: Vec<String> = Vec::new();
        {
            let entries = self.entries.lock().unwrap();
            // 排序后写，文件才不会每次连接都乱跳
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort();
            for host in keys {
                if let Some(key) = entries.get(host) {
                    lines.push(format!("{host} {key}"));
                }
            }
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
        std::fs::write(&self.path, lines.join("\n") + "\n")
            .map_err(|e| format!("写入 known_hosts 失败: {e}"))
    }

    /// 比对这台主机的密钥。key_openssh 是 `ssh-ed25519 AAAA...` 这种整串
    pub fn check(&self, host: &str, key_openssh: &str) -> KeyCheck {
        let entries = self.entries.lock().unwrap();
        match entries.get(host) {
            Some(expected) if expected == key_openssh => KeyCheck::Matches,
            Some(expected) => {
                // 顺便记下详情，好让上层能把"为什么连不上"说清楚
                *LAST_MISMATCH.lock().unwrap() = Some(format!(
                    "主机密钥与已知记录不符。\n  记录: {expected}\n  收到: {key_openssh}"
                ));
                KeyCheck::Mismatch {
                    expected: expected.clone(),
                }
            }
            None => KeyCheck::Unknown,
        }
    }

    /// 记住这台主机的密钥（TOFU）
    pub fn add(&self, host: &str, key_openssh: &str) -> Result<(), String> {
        {
            let mut entries = self.entries.lock().unwrap();
            entries.insert(host.to_string(), key_openssh.to_string());
        }
        self.persist()
    }

    /// 忘掉这台主机。密钥确实换过（服务器重装）时用它，然后重连会重新记录
    pub fn remove(&self, host: &str) -> Result<(), String> {
        {
            let mut entries = self.entries.lock().unwrap();
            entries.remove(host);
        }
        self.persist()
    }
}

/// 放在跟密钥库同一个目录下：`{data_dir}/easy-shell/known_hosts`
pub fn default_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or_else(|| "无法定位数据目录".to_string())?;
    Ok(dir.join("easy-shell").join("known_hosts"))
}

/// 忘掉某台主机的密钥记录。host 传 `1.2.3.4:22` 这种格式
#[tauri::command]
pub fn known_hosts_forget(host: String) -> Result<(), String> {
    KnownHosts::global()
        .ok_or_else(|| "主机密钥库未初始化".to_string())?
        .remove(&host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_known_hosts(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("easy-shell-kh-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("known_hosts")
    }

    #[test]
    fn 第一次见到的主机返回_unknown() {
        let path = temp_known_hosts("unknown");
        let kh = KnownHosts::from_path(path);
        assert!(matches!(kh.check("a:22", "ssh-ed25519 AAAA"), KeyCheck::Unknown));
    }

    #[test]
    fn 记住之后再比对就匹配() {
        let path = temp_known_hosts("match");
        let kh = KnownHosts::from_path(path);
        kh.add("a:22", "ssh-ed25519 AAAA").unwrap();
        assert!(matches!(
            kh.check("a:22", "ssh-ed25519 AAAA"),
            KeyCheck::Matches
        ));
    }

    #[test]
    fn 密钥换了要报_mismatch() {
        let path = temp_known_hosts("mismatch");
        let kh = KnownHosts::from_path(path);
        kh.add("a:22", "ssh-ed25519 AAAA").unwrap();
        assert!(matches!(
            kh.check("a:22", "ssh-ed25519 BBBB"),
            KeyCheck::Mismatch { .. }
        ));
    }

    #[test]
    fn 记录会落盘并且能重新读回来() {
        let path = temp_known_hosts("persist");
        let kh = KnownHosts::from_path(path.clone());
        kh.add("host:2222", "ssh-ed25519 CCCC").unwrap();

        let reloaded = KnownHosts::from_path(path);
        assert!(matches!(
            reloaded.check("host:2222", "ssh-ed25519 CCCC"),
            KeyCheck::Matches
        ));
    }

    #[test]
    fn 能解析_openssh_格式的行() {
        let dir = std::env::temp_dir().join("easy-shell-kh-parse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        std::fs::write(
            &path,
            "# 注释行\n1.2.3.4:22 ssh-ed25519 AAAAC3Nz\n\n",
        )
        .unwrap();

        let kh = KnownHosts::from_path(path);
        assert!(matches!(
            kh.check("1.2.3.4:22", "ssh-ed25519 AAAAC3Nz"),
            KeyCheck::Matches
        ));
        assert!(matches!(kh.check("1.2.3.4:22", "ssh-ed25519 别的"), KeyCheck::Mismatch { .. }));
    }

    #[test]
    fn remove_之后重新变回_unknown() {
        let path = temp_known_hosts("remove");
        let kh = KnownHosts::from_path(path);
        kh.add("a:22", "ssh-ed25519 AAAA").unwrap();
        kh.remove("a:22").unwrap();
        assert!(matches!(kh.check("a:22", "ssh-ed25519 AAAA"), KeyCheck::Unknown));
    }
}
