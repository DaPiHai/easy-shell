use std::fs;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

const NONCE_LEN: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthRecord {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "key")]
    Key {
        private_key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group_id: Option<String>,
    /// 兼容模式（连老设备用的废弃算法）。后加的字段，老库里没有，所以要给默认值
    #[serde(default)]
    pub compat: bool,
    pub auth: AuthRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}

pub struct Vault {
    db: StdMutex<Connection>,
    /// 解锁后驻留内存的主密钥；锁定或重启即失效
    key: StdMutex<Option<[u8; 32]>>,
}

impl Vault {
    pub fn new() -> Result<Self, String> {
        let path = db_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败: {e}"))?;
        init_schema(&conn)?;
        Ok(Self {
            db: StdMutex::new(conn),
            key: StdMutex::new(None),
        })
    }

    fn key_or_err(&self) -> Result<[u8; 32], String> {
        self.key
            .lock()
            .map_err(|_| "密钥库状态异常".to_string())?
            .ok_or_else(|| "密钥库已锁定".to_string())
    }
}

fn db_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or_else(|| "无法定位数据目录".to_string())?;
    Ok(dir.join("easy-shell").join("vault.db"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hosts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            group_id TEXT,
            secret BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("初始化数据库失败: {e}"))?;

    // compat 是后加的列：老库建表时没有，而 CREATE TABLE IF NOT EXISTS 对已存在的表
    // 什么都不做，所以只能单独 ALTER 补上。也不能无脑 ALTER —— 列已存在会报错。
    if !column_exists(conn, "hosts", "compat")? {
        conn.execute(
            "ALTER TABLE hosts ADD COLUMN compat INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级 hosts 表失败: {e}"))?;
    }

    Ok(())
}

/** 表里有没有这一列。用来给老库补字段，避免 ALTER 到一个已存在的列上报错 */
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in rows {
        if name.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM meta WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| format!("密钥派生失败: {e}"))?;
    Ok(out)
}

fn encrypt_secret(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化加密器失败: {e}"))?;
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("加密失败: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.append(&mut ciphertext);
    Ok(out)
}

fn decrypt_secret(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() <= NONCE_LEN {
        return Err("密文长度异常".to_string());
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密器失败: {e}"))?;
    let nonce = Nonce::from_slice(&blob[..NONCE_LEN]);
    cipher
        .decrypt(nonce, &blob[NONCE_LEN..])
        .map_err(|_| "解密失败，主密码可能不正确".to_string())
}

#[tauri::command]
pub fn vault_status(state: State<'_, Vault>) -> Result<VaultStatus, String> {
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    let initialized = meta_get(&db, "verifier")?.is_some();
    let unlocked = state
        .key
        .lock()
        .map_err(|_| "密钥库状态异常".to_string())?
        .is_some();
    Ok(VaultStatus {
        initialized,
        unlocked,
    })
}

/// 首次使用：设置主密码。会生成随机盐、argon2id 校验串，并派生主密钥。
#[tauri::command]
pub fn vault_setup(state: State<'_, Vault>, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("主密码不能为空".to_string());
    }

    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    if meta_get(&db, "verifier")?.is_some() {
        return Err("主密码已设置过，请使用解锁".to_string());
    }

    let salt_bytes: [u8; 16] = rand::random();
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
    let verifier = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("生成校验串失败: {e}"))?
        .to_string();

    meta_set(&db, "salt", &B64.encode(salt_bytes))?;
    meta_set(&db, "verifier", &verifier)?;

    let key = derive_key(&password, &salt_bytes)?;
    drop(db);
    *state
        .key
        .lock()
        .map_err(|_| "密钥库状态异常".to_string())? = Some(key);

    Ok(())
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, Vault>, password: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    let verifier = meta_get(&db, "verifier")?.ok_or_else(|| "尚未设置主密码".to_string())?;
    let salt_b64 = meta_get(&db, "salt")?.ok_or_else(|| "缺少盐值".to_string())?;
    let salt_bytes = B64
        .decode(salt_b64)
        .map_err(|e| format!("盐值解析失败: {e}"))?;

    let parsed = PasswordHash::new(&verifier).map_err(|e| format!("校验串损坏: {e}"))?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| "主密码错误".to_string())?;

    let key = derive_key(&password, &salt_bytes)?;
    drop(db);
    *state
        .key
        .lock()
        .map_err(|_| "密钥库状态异常".to_string())? = Some(key);

    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, Vault>) -> Result<(), String> {
    *state
        .key
        .lock()
        .map_err(|_| "密钥库状态异常".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn hosts_list(state: State<'_, Vault>) -> Result<Vec<HostRecord>, String> {
    let key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;

    let mut stmt = db
        .prepare("SELECT id, name, address, port, username, group_id, secret, compat FROM hosts")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u16>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut hosts = Vec::new();
    for row in rows {
        let (id, name, address, port, username, group_id, secret, compat) =
            row.map_err(|e| e.to_string())?;
        let plaintext = decrypt_secret(&key, &secret)?;
        let auth: AuthRecord =
            serde_json::from_slice(&plaintext).map_err(|e| format!("凭据解析失败: {e}"))?;
        hosts.push(HostRecord {
            id,
            name,
            address,
            port,
            username,
            group_id,
            compat,
            auth,
        });
    }
    Ok(hosts)
}

#[tauri::command]
pub fn hosts_save(state: State<'_, Vault>, host: HostRecord) -> Result<(), String> {
    let key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;

    let plaintext =
        serde_json::to_vec(&host.auth).map_err(|e| format!("凭据序列化失败: {e}"))?;
    let secret = encrypt_secret(&key, &plaintext)?;

    db.execute(
        "INSERT INTO hosts (id, name, address, port, username, group_id, secret, compat)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            address = excluded.address,
            port = excluded.port,
            username = excluded.username,
            group_id = excluded.group_id,
            secret = excluded.secret,
            compat = excluded.compat",
        params![
            host.id,
            host.name,
            host.address,
            host.port,
            host.username,
            host.group_id,
            secret,
            host.compat,
        ],
    )
    .map_err(|e| format!("保存主机失败: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn hosts_delete(state: State<'_, Vault>, id: String) -> Result<(), String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    db.execute("DELETE FROM hosts WHERE id = ?1", params![id])
        .map_err(|e| format!("删除主机失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn groups_list(state: State<'_, Vault>) -> Result<Vec<GroupRecord>, String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    let mut stmt = db
        .prepare("SELECT id, name FROM groups")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GroupRecord {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    for g in rows {
        groups.push(g.map_err(|e| e.to_string())?);
    }
    Ok(groups)
}

#[tauri::command]
pub fn groups_save(state: State<'_, Vault>, group: GroupRecord) -> Result<(), String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    db.execute(
        "INSERT INTO groups (id, name) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        params![group.id, group.name],
    )
    .map_err(|e| format!("保存分组失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn groups_delete(state: State<'_, Vault>, id: String) -> Result<(), String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    db.execute("DELETE FROM groups WHERE id = ?1", params![id])
        .map_err(|e| format!("删除分组失败: {e}"))?;
    db.execute("UPDATE hosts SET group_id = NULL WHERE group_id = ?1", params![id])
        .map_err(|e| format!("解除主机关联失败: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRecord {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// 命令片段不是凭据，不加密，但也要解锁后才能读写——避免锁屏后还能翻到运维命令
#[tauri::command]
pub fn snippets_list(state: State<'_, Vault>) -> Result<Vec<SnippetRecord>, String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    let mut stmt = db
        .prepare("SELECT id, name, command FROM snippets ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SnippetRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for s in rows {
        out.push(s.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn snippets_save(state: State<'_, Vault>, snippet: SnippetRecord) -> Result<(), String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    db.execute(
        "INSERT INTO snippets (id, name, command, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, command = excluded.command",
        params![snippet.id, snippet.name, snippet.command, now],
    )
    .map_err(|e| format!("保存片段失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn snippets_delete(state: State<'_, Vault>, id: String) -> Result<(), String> {
    let _key = state.key_or_err()?;
    let db = state.db.lock().map_err(|_| "数据库锁异常".to_string())?;
    db.execute("DELETE FROM snippets WHERE id = ?1", params![id])
        .map_err(|e| format!("删除片段失败: {e}"))?;
    Ok(())
}
