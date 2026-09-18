use std::fs;
use std::path::{Path, PathBuf};
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

/**
 * 「这个库没设主密码」的标记，存在 meta 表里。
 *
 * 空密码本身是合法的：没有它，用户每次启动都得在锁屏上点一次「解锁」，
 * 而那个框里没有任何要填的东西 —— 无密码的全部意义就是省掉这一步。
 * 前端靠这个标记在启动时直接解锁（`vault_status.no_password`）。
 *
 * 它是**显式标记而不是「拿空密码试一下**：argon2 验证一次要几十毫秒，
 * 而启动路径上每一毫秒都算数。标记与校验串理论上可能被手改的库弄得不一致，
 * 所以自动解锁失败时前端要退回锁屏，不能把启动卡死。
 *
 * 安全上说清楚：无密码库的密钥 = argon2(空串, 库里的盐)，也就是只做了混淆 ——
 * 拿到 vault.db 的人就能读出凭据。界面里必须如实告诉用户。
 */
const NOPASS_KEY: &str = "nopass";

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
    /// 库里没设主密码（空密码）。前端据此在启动时直接解锁，锁屏也只剩一个按钮
    pub no_password: bool,
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
        Self::open(&path)
    }

    /// 从指定文件开库。只有 `new()` 和测试用得到 —— 测试必须能往临时目录开，
    /// 否则重置的单元测试会把真实密钥库清掉
    fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
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

    /**
     * 库的初始化状态 / 有没有设密码 / 现在解没解锁。
     *
     * 做成方法而不是只写在命令里：启动路径的三种分支（首次使用 / 锁定 / 无密码直接进）
     * 全靠这三个字段，测试要能直接问。
     */
    pub fn status(&self) -> Result<VaultStatus, String> {
        let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;
        let initialized = meta_get(&db, "verifier")?.is_some();
        let no_password = is_nopass(&db)?;
        let unlocked = self
            .key
            .lock()
            .map_err(|_| "密钥库状态异常".to_string())?
            .is_some();
        Ok(VaultStatus {
            initialized,
            unlocked,
            no_password,
        })
    }

    /**
     * 首次使用：设置主密码并解锁。**空串是合法输入** —— 表示不设密码。
     *
     * 不给空串加「至少 6 位」这类规则：这是本地单机工具，用户很可能是为了
     * 「别让同事路过时看见我的主机列表」而不是为了抗暴力破解。规则挡的是用户自己，
     * 而库里存的东西始终是同一套加密 —— 真正的分界线是「有没有密码」，不是「几位」。
     * 界面上会如实说明无密码意味着什么（见 `NOPASS_KEY`）。
     */
    pub fn set_password(&self, password: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;
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
        set_nopass(&db, password.is_empty())?;

        let key = derive_key(password, &salt_bytes)?;
        drop(db);
        *self.key.lock().map_err(|_| "密钥库状态异常".to_string())? = Some(key);

        Ok(())
    }

    pub fn unlock_with(&self, password: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;
        let verifier = meta_get(&db, "verifier")?.ok_or_else(|| "尚未设置主密码".to_string())?;
        let salt_b64 = meta_get(&db, "salt")?.ok_or_else(|| "缺少盐值".to_string())?;
        let salt_bytes = B64
            .decode(salt_b64)
            .map_err(|e| format!("盐值解析失败: {e}"))?;

        let parsed = PasswordHash::new(&verifier).map_err(|e| format!("校验串损坏: {e}"))?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .map_err(|_| "主密码错误".to_string())?;

        let key = derive_key(password, &salt_bytes)?;
        drop(db);
        *self.key.lock().map_err(|_| "密钥库状态异常".to_string())? = Some(key);

        Ok(())
    }

    pub fn lock(&self) -> Result<(), String> {
        *self.key.lock().map_err(|_| "密钥库状态异常".to_string())? = None;
        Ok(())
    }

    /**
     * 换主密码：校验旧密码 → 换盐换校验串 → 用新密钥把**已有凭据全部重新加密**。
     *
     * 必须有这条路：凭据是用主密码派生的密钥加密的，改了密码不重加密，
     * 老数据当场变成解不开的乱码。而「改成无密码」在数据结构上就是「新密码 = 空串」，
     * 走同一段代码，顺手把 `nopass` 标记一起翻掉。
     *
     * 两条约束：
     * - **要求已解锁**。重加密要用当前那把钥匙，而且解锁本身就是一道认证 ——
     *   不然一个走开的工位上谁都能把库换个密码锁死。
     * - 旧密码要**当场再验一遍**，不认「反正已经解锁了」：解锁可能是几小时前，
     *   改密码是破坏性动作（改错了旧密码就再也解不开）。
     *
     * 加密与元数据写在**同一个事务**里：中途失败必须整体回滚，否则会出现
     * 一半主机用新钥匙、一半用旧钥匙的库 —— 那种库谁也读不全。
     */
    pub fn change_password(&self, old_password: &str, new_password: &str) -> Result<(), String> {
        // 先拿钥匙再开库：`vault_setup` 也是这个顺序，保持一致免得将来加锁交叉
        let old_key = self.key_or_err()?;
        if old_password == new_password {
            return Err("新密码和当前密码相同，没有需要改的".to_string());
        }

        let mut db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;
        let verifier = meta_get(&db, "verifier")?.ok_or_else(|| "尚未设置主密码".to_string())?;
        let parsed = PasswordHash::new(&verifier).map_err(|e| format!("校验串损坏: {e}"))?;
        Argon2::default()
            .verify_password(old_password.as_bytes(), &parsed)
            .map_err(|_| "当前主密码不正确".to_string())?;

        let salt_bytes: [u8; 16] = rand::random();
        let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| e.to_string())?;
        let new_verifier = Argon2::default()
            .hash_password(new_password.as_bytes(), &salt)
            .map_err(|e| format!("生成校验串失败: {e}"))?
            .to_string();
        let new_key = derive_key(new_password, &salt_bytes)?;

        let tx = db.transaction().map_err(|e| format!("开启事务失败: {e}"))?;

        // 先把 (id, 密文) 全捞出来再逐条更新：语句借着的连接和下面的 UPDATE 是同一把，
        // 边迭代边写容易踩到「查询结果随更新漂移」这类问题，多一份内存换确定性
        let rows: Vec<(String, Vec<u8>)> = {
            let mut stmt = tx
                .prepare("SELECT id, secret FROM hosts")
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in mapped {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };

        for (id, secret) in rows {
            // 解不开就是库已经坏了（或内存里那把钥匙不对），此时整条链路必须失败 ——
            // 继续跑下去会把这条记录的密文写成另一个密码的密文，问题被藏起来
            let plaintext = decrypt_secret(&old_key, &secret)?;
            let re_encrypted = encrypt_secret(&new_key, &plaintext)?;
            tx.execute(
                "UPDATE hosts SET secret = ?2 WHERE id = ?1",
                params![id, re_encrypted],
            )
            .map_err(|e| format!("重新加密凭据失败: {e}"))?;
        }

        meta_set(&tx, "salt", &B64.encode(salt_bytes))?;
        meta_set(&tx, "verifier", &new_verifier)?;
        set_nopass(&tx, new_password.is_empty())?;
        tx.commit().map_err(|e| format!("保存新密码失败: {e}"))?;
        drop(db);

        *self.key.lock().map_err(|_| "密钥库状态异常".to_string())? = Some(new_key);
        Ok(())
    }

    pub fn list_hosts(&self) -> Result<Vec<HostRecord>, String> {
        let key = self.key_or_err()?;
        let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;

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

    pub fn save_host(&self, host: HostRecord) -> Result<(), String> {
        let key = self.key_or_err()?;
        let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;

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

    /**
     * 清空密钥库，回到「首次使用」。
     *
     * 忘记主密码时唯一的出路：所有凭据都是用那把密码派生的密钥加密的，
     * 密码没了谁也解不开 —— 与其留一个打不开的库，不如让用户从界面里清掉重来，
     * 而不是去文件系统里找 vault.db 手删。
     *
     * 只动自己这几张表，**不碰 known_hosts**：那是主机指纹不是凭据，
     * 留着才能在重置之后继续挡住中间人。
     */
    fn reset(&self) -> Result<(), String> {
        {
            // 先释放数据库锁再去动主密钥：顺序和别处保持一致，免得将来加锁交叉
            let db = self.db.lock().map_err(|_| "数据库锁异常".to_string())?;
            db.execute_batch(
                "DELETE FROM meta;
                 DELETE FROM hosts;
                 DELETE FROM groups;
                 DELETE FROM snippets;",
            )
            .map_err(|e| format!("清空密钥库失败: {e}"))?;
        }
        *self.key.lock().map_err(|_| "密钥库状态异常".to_string())? = None;
        Ok(())
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

/** 库里有没有「不设密码」的标记。老库没有这一行 → false，正好是「有密码」 */
fn is_nopass(conn: &Connection) -> Result<bool, String> {
    Ok(meta_get(conn, NOPASS_KEY)?.as_deref() == Some("1"))
}

/**
 * 记/清「不设密码」标记。
 *
 * 取消时是把行**删掉**而不是写 "0"：`is_nopass` 只认 "1"，但留一行 "0" 会让
 * `meta` 表里堆着无意义的状态，将来读表的人还得判断哪个值算真。
 */
fn set_nopass(conn: &Connection, nopass: bool) -> Result<(), String> {
    if nopass {
        meta_set(conn, NOPASS_KEY, "1")
    } else {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![NOPASS_KEY])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
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
    state.status()
}

/// 首次使用：设置主密码。**空串 = 不设密码**（见 `NOPASS_KEY`），前端必须让用户明确选过
#[tauri::command]
pub fn vault_setup(state: State<'_, Vault>, password: String) -> Result<(), String> {
    state.set_password(&password)
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, Vault>, password: String) -> Result<(), String> {
    state.unlock_with(&password)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, Vault>) -> Result<(), String> {
    state.lock()
}

/**
 * 修改主密码（`newPassword` 传空串 = 改成不设密码）。
 *
 * 所有凭据都会用新密码重新加密，已经在跑的连接不受影响 —— 它们早就握着认证结果了。
 */
#[tauri::command]
pub fn vault_change_password(
    state: State<'_, Vault>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    state.change_password(&old_password, &new_password)
}

/**
 * 清空密钥库，回到「首次使用」。**不可撤销**，前端必须让用户明确确认过再调。
 *
 * 这是忘记主密码时唯一的出路，没有它用户只能自己去删 vault.db。
 */
#[tauri::command]
pub fn vault_reset(state: State<'_, Vault>) -> Result<(), String> {
    state.reset()
}

#[tauri::command]
pub fn hosts_list(state: State<'_, Vault>) -> Result<Vec<HostRecord>, String> {
    state.list_hosts()
}

#[tauri::command]
pub fn hosts_save(state: State<'_, Vault>, host: HostRecord) -> Result<(), String> {
    state.save_host(host)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 开一个临时库。**绝不走 `db_path()`** —— 那会动到用户真实的密钥库
    fn temp_vault() -> (Vault, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "easy-shell-vault-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        (Vault::open(&path).expect("开临时库失败"), path)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(-1)
    }

    /**
     * 重置必须把四张表清空、并且丢掉内存里的主密钥。
     *
     * 「忘记主密码」时这是唯一的出路，删漏一张表就等于留了个打不开又删不掉的尾巴；
     * 主密钥不丢则更糟 —— 界面回到了「首次使用」，密钥却还在内存里。
     */
    #[test]
    fn 重置会清空所有数据并丢掉内存里的主密钥() {
        let (vault, path) = temp_vault();
        {
            let db = vault.db.lock().unwrap();
            db.execute_batch(
                "INSERT INTO meta (key, value) VALUES ('verifier', 'x'), ('salt', 'y');
                 INSERT INTO groups (id, name) VALUES ('g1', '生产环境');
                 INSERT INTO hosts (id, name, address, port, username, group_id, secret, compat)
                     VALUES ('h1', 'web-01', '10.0.1.11', 22, 'deploy', NULL, X'00', 0);
                 INSERT INTO snippets (id, name, command, created_at)
                     VALUES ('s1', '看磁盘', 'df -h', 0);",
            )
            .unwrap();
        }
        *vault.key.lock().unwrap() = Some([7u8; 32]);

        vault.reset().unwrap();

        let db = vault.db.lock().unwrap();
        assert_eq!(
            meta_get(&db, "verifier").unwrap(),
            None,
            "重置后还留着主密码校验串 —— 界面会以为库仍然是已初始化的"
        );
        assert_eq!(count(&db, "meta"), 0, "meta 没清干净");
        assert_eq!(count(&db, "hosts"), 0, "hosts 没清干净");
        assert_eq!(count(&db, "groups"), 0, "groups 没清干净");
        assert_eq!(count(&db, "snippets"), 0, "snippets 没清干净");
        drop(db);

        assert!(
            vault.key.lock().unwrap().is_none(),
            "重置后主密钥仍留在内存里"
        );

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    // ---- 改主密码 / 无密码 ----------------------------------------------------

    fn sample_host(id: &str) -> HostRecord {
        HostRecord {
            id: id.to_string(),
            name: format!("web-{id}"),
            address: "10.0.1.11".to_string(),
            port: 22,
            username: "deploy".to_string(),
            group_id: None,
            compat: false,
            auth: AuthRecord::Password {
                password: "s3cret-口令".to_string(),
            },
        }
    }

    /** 库里那条记录的**密文原文**。用来判断「真的重新加密过」而不是只换了校验串 */
    fn ciphertext_of(vault: &Vault, id: &str) -> Vec<u8> {
        let db = vault.db.lock().unwrap();
        db.query_row("SELECT secret FROM hosts WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn read_secret(vault: &Vault, id: &str) -> String {
        let hosts = vault.list_hosts().unwrap();
        let host = hosts.iter().find(|h| h.id == id).expect("主机不在库里");
        match &host.auth {
            AuthRecord::Password { password } => password.clone(),
            _ => panic!("凭据类型不对"),
        }
    }

    /** 盐 / 校验串 / 某条密文的快照，用来断言「失败时一个字节都没动」 */
    fn snapshot(vault: &Vault, id: &str) -> (Option<String>, Option<String>, Vec<u8>) {
        let db = vault.db.lock().unwrap();
        (
            meta_get(&db, "salt").unwrap(),
            meta_get(&db, "verifier").unwrap(),
            db.query_row("SELECT secret FROM hosts WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .unwrap(),
        )
    }

    /**
     * 改密码必须真的把凭据重新加密。
     *
     * 只换校验串的那种「改密码」是最坏的形态：界面说改好了，旧密码照样能
     * 解出全部凭据 —— 所以这里既验解锁行为，也验密文本身换过。
     * 两台主机是为了覆盖重加密的循环（只处理第一条就会留下一条解不开的记录）。
     */
    #[test]
    fn 改主密码后旧密码解不开新密码能解开() {
        let (vault, path) = temp_vault();
        vault.set_password("旧密码-abc").unwrap();
        vault.save_host(sample_host("h1")).unwrap();
        vault.save_host(sample_host("h2")).unwrap();
        let before1 = ciphertext_of(&vault, "h1");
        let before2 = ciphertext_of(&vault, "h2");

        vault.change_password("旧密码-abc", "新密码-xyz").unwrap();

        // 改完当场还能读：内存里那把钥匙已经换成新的了
        assert_eq!(read_secret(&vault, "h1"), "s3cret-口令");
        assert_eq!(read_secret(&vault, "h2"), "s3cret-口令");
        assert_ne!(
            ciphertext_of(&vault, "h1"),
            before1,
            "第一条凭据的密文没变，说明没有重新加密"
        );
        assert_ne!(
            ciphertext_of(&vault, "h2"),
            before2,
            "第二条凭据的密文没变，说明只重加密了第一条"
        );

        vault.lock().unwrap();
        assert!(
            vault.unlock_with("旧密码-abc").is_err(),
            "改完之后旧密码还能解锁"
        );
        assert!(vault.unlock_with("新密码-xyz").is_ok());
        assert_eq!(read_secret(&vault, "h1"), "s3cret-口令");

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    /**
     * 旧密码不对时必须整体失败，且一个字节都不改。
     *
     * 这条是「改密码」最危险的失败模式：半途改了盐或校验串，旧密码立刻作废，
     * 而凭据还是旧钥匙的密文 —— 库就成了谁也读不全的状态。
     */
    #[test]
    fn 旧密码不对时一个字节都不改() {
        let (vault, path) = temp_vault();
        vault.set_password("真密码").unwrap();
        vault.save_host(sample_host("h1")).unwrap();
        let before = snapshot(&vault, "h1");

        let err = vault.change_password("猜的密码", "新密码").unwrap_err();
        assert!(
            err.contains("不正确"),
            "错误信息该说清是当前密码不对，实际是：{err}"
        );

        assert_eq!(snapshot(&vault, "h1"), before, "失败的改密码把库改了");

        // 旧密码仍能解锁并读出凭据，说明盐/校验串/密文三者都没动
        vault.lock().unwrap();
        assert!(vault.unlock_with("真密码").is_ok());
        assert_eq!(read_secret(&vault, "h1"), "s3cret-口令");

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn 锁定状态下不能改密码也不能改成同一个密码() {
        let (vault, path) = temp_vault();
        vault.set_password("真密码").unwrap();

        vault.lock().unwrap();
        assert!(
            vault.change_password("真密码", "新密码").is_err(),
            "锁着的时候也能改密码 —— 走开的工位上谁都能把库锁死"
        );

        vault.unlock_with("真密码").unwrap();
        let err = vault.change_password("真密码", "真密码").unwrap_err();
        assert!(err.contains("相同"), "改成同一个密码应该被拦住：{err}");

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    /**
     * 空密码是合法的：要写上标记，之后空密码就能解锁。
     *
     * 标记（而不是「拿空密码试一次」）是启动路径快得起来的原因 ——
     * 前端靠 `status().no_password` 直接解锁，不用先花一次 argon2。
     */
    #[test]
    fn 空密码库会记下标记并能用空密码解锁() {
        let (vault, path) = temp_vault();
        let fresh = vault.status().unwrap();
        assert!(!fresh.initialized && !fresh.no_password, "空库的状态不对");

        vault.set_password("").unwrap();
        let status = vault.status().unwrap();
        assert!(
            status.initialized && status.unlocked && status.no_password,
            "空密码库没有写上无密码标记：{status:?}"
        );

        vault.save_host(sample_host("h1")).unwrap();
        vault.lock().unwrap();
        assert!(vault.unlock_with("").is_ok(), "无密码库居然解不开");
        assert_eq!(read_secret(&vault, "h1"), "s3cret-口令");

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn 有密码的库空密码打不开() {
        let (vault, path) = temp_vault();
        vault.set_password("真密码").unwrap();
        assert!(!vault.status().unwrap().no_password, "设了密码却标成无密码");

        vault.lock().unwrap();
        assert!(vault.unlock_with("").is_err(), "空密码就能开一把有密码的库");

        drop(vault);
        let _ = fs::remove_file(&path);
    }

    /// 两种状态之间来回改，标记与可解锁性必须跟着翻（无密码 ↔ 有密码）
    #[test]
    fn 有密码与无密码之间可以来回改() {
        let (vault, path) = temp_vault();
        vault.set_password("真密码").unwrap();
        vault.save_host(sample_host("h1")).unwrap();

        vault.change_password("真密码", "").unwrap();
        assert!(vault.status().unwrap().no_password, "改成无密码后没写标记");
        vault.lock().unwrap();
        assert!(vault.unlock_with("").is_ok(), "改成无密码后空密码解不开");
        assert!(vault.unlock_with("真密码").is_err(), "旧密码还能开这个库");

        vault.change_password("", "新密码").unwrap();
        assert!(!vault.status().unwrap().no_password, "设回密码后 nopass 标记没清掉");
        vault.lock().unwrap();
        assert!(vault.unlock_with("").is_err(), "设了密码还能空密码进");
        assert!(vault.unlock_with("新密码").is_ok());
        assert_eq!(read_secret(&vault, "h1"), "s3cret-口令");

        drop(vault);
        let _ = fs::remove_file(&path);
    }
}
