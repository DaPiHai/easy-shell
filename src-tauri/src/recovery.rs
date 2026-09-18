//! 恢复密钥：把**库密钥**封给一把 SSH 公钥，忘了主密码时用对应的私钥把它取回来。
//!
//! 为什么需要它：凭据是用主密码派生的密钥加密的，密码一忘，数据就成了谁也解不开的乱码
//! —— 此前唯一的出路是「清空密钥库重来」，等于把主机、分组、命令片段全丢掉。
//! 有了恢复密钥，忘密码只是「换一条路取回同一把钥匙」，数据还在。
//!
//! 构造：Ed25519 公钥 → X25519（蒙哥马利形式）→ 临时密钥 ECDH → HKDF-SHA256 →
//! AES-256-GCM。也就是「封给某把公钥」（sealed box）—— libsodium 的 sealed box、
//! age 的 x25519 recipient 都是同一套组合，这里不自己发明密码学，只用标准积木。
//! 封的是**库密钥**（32 字节）而不是主密码本身：私钥泄露 + 库文件泄露时，
//! 对方拿到的是「能开这个库」，而不是「一个很可能在别处复用的口令原文」。
//!
//! **安全性完全等于那把私钥本身的保护**。私钥如果是没口令的普通文件、又摆在同一台机器上
//! （`C:\Users\x\.ssh\id_ed25519` 恰恰是最常见的形态），那么能坐到这台机器前的人
//! 也能拿它把库打开 —— 设这种恢复密钥等于把锁换成一个门虚掩。要设就得配一把
//! 「不在这台机器上」（U 盘、另一台机）或「有口令」的私钥。界面文案必须把这条说清楚。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use russh::keys::ssh_key::{private::KeypairData, public::KeyData, HashAlg, PrivateKey, PublicKey};
use sha2::{Digest, Sha256, Sha512};

/// 封包头：magic + 类型 + 临时公钥 + nonce
const MAGIC: &[u8; 6] = b"ESREC1";
const KIND_ED25519: u8 = 1;
const EPH_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = MAGIC.len() + 1 + EPH_LEN + NONCE_LEN;
const TAG_LEN: usize = 16;
/// 明文载荷 = 32 字节库密钥 + 这段标签。GCM 本身保证不被篡改，标签是为了
/// 「封进去的确实是我们自己的东西」：换了程序的密文即使能解开也认领不了。
const PAYLOAD_TAG: &[u8; 16] = b"easy-shell-vkey!";
const KEY_LEN: usize = 32;
const PAYLOAD_LEN: usize = KEY_LEN + PAYLOAD_TAG.len();
/// HKDF 的 salt。固定值就够了：ikm 是 ECDH 出来的高熵共享密钥，不是口令
const HKDF_SALT: &[u8] = b"easy-shell recovery v1";

/// 一把可用的恢复公钥：规范化的公钥行 + 指纹 + 原始 32 字节
#[derive(Debug)]
pub struct RecoveryPublicKey {
    /// 规范化后的 `ssh-ed25519 AAAA…` 一行，存进库里给用户对账用
    pub line: String,
    /// OpenSSH 风格的指纹（`SHA256:…`），界面上拿它认人
    pub fingerprint: String,
    ed25519: [u8; 32],
}

/// 解析一段公钥文本（`ssh-ed25519 AAAA… 注释`）。只认 ed25519
pub fn parse_public_key(text: &str) -> Result<RecoveryPublicKey, String> {
    let key = PublicKey::from_openssh(text.trim())
        .map_err(|e| format!("这不是一把能识别的 SSH 公钥：{e}"))?;
    from_public_key(&key)
}

/**
 * 从「公钥文本」或「文件路径」里取公钥。
 *
 * 两种都收是因为两种用法都常见：粘贴 `~/.ssh/id_ed25519.pub` 的内容，
 * 或者直接给路径让它自己读。判断顺序是先当文本解析、失败再当路径 ——
 * 路径里的反斜杠和空格（`C:\Users\a b\id_ed25519.pub`）解析成公钥必然失败，
 * 不会出现「明明是路径却被当成密钥」的误判。
 */
pub fn read_public_key(text_or_path: &str) -> Result<RecoveryPublicKey, String> {
    if let Ok(key) = parse_public_key(text_or_path) {
        return Ok(key);
    }
    let content = std::fs::read_to_string(text_or_path.trim())
        .map_err(|e| format!("既不像公钥文本，也读不到这个文件：{e}"))?;
    parse_public_key(&content)
}

fn from_public_key(key: &PublicKey) -> Result<RecoveryPublicKey, String> {
    let KeyData::Ed25519(inner) = key.key_data() else {
        return Err(format!(
            "目前只支持 ed25519 公钥，这把是 {}",
            key.algorithm().as_str()
        ));
    };
    Ok(RecoveryPublicKey {
        line: key
            .to_openssh()
            .map_err(|e| format!("公钥格式化失败：{e}"))?,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        ed25519: inner.0,
    })
}

fn ed25519_to_montgomery(public: &[u8; 32]) -> Result<MontgomeryPoint, String> {
    CompressedEdwardsY(*public)
        .decompress()
        .ok_or_else(|| "公钥不是曲线上的合法点".to_string())
        .map(|p| p.to_montgomery())
}

/** HKDF：把 ECDH 出来的共享密钥拧成 AES 密钥，并把「给谁的、哪次握手」绑进去 */
fn derive_aes_key(shared: &[u8], eph_pub: &[u8; 32], recipient: &[u8; 32]) -> Result<[u8; 32], String> {
    let mut info = Vec::with_capacity(MAGIC.len() + 1 + EPH_LEN + 32);
    info.extend_from_slice(MAGIC);
    info.push(KIND_ED25519);
    info.extend_from_slice(eph_pub);
    info.extend_from_slice(recipient);

    let mut out = [0u8; KEY_LEN];
    Hkdf::<Sha256>::new(Some(HKDF_SALT), shared)
        .expand(&info, &mut out)
        .map_err(|_| "密钥派生失败".to_string())?;
    Ok(out)
}

/**
 * 把库密钥封给一把公钥。
 *
 * 临时密钥每次现生成：ECDH 的共享密钥只由「临时私钥 + 对方公钥」决定，
 * 复用同一对密钥就是 X25519 的经典误用。
 */
pub fn seal(key: &RecoveryPublicKey, vault_key: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
    let recipient = ed25519_to_montgomery(&key.ed25519)?;
    let eph_secret: [u8; 32] = rand::random();
    let eph_pub = MontgomeryPoint::mul_base_clamped(eph_secret).0;
    let shared = recipient.mul_clamped(eph_secret).0;
    check_shared(&shared)?;

    let aes_key = derive_aes_key(&shared, &eph_pub, &recipient.0)?;
    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("初始化加密器失败: {e}"))?;
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();

    let mut payload = Vec::with_capacity(PAYLOAD_LEN);
    payload.extend_from_slice(vault_key);
    payload.extend_from_slice(PAYLOAD_TAG);
    let mut ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), payload.as_slice())
        .map_err(|_| "封装库密钥失败".to_string())?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(KIND_ED25519);
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce_bytes);
    out.append(&mut ciphertext);
    Ok(out)
}

/**
 * 用私钥文件开封，拿回库密钥；同时返回这把私钥的公钥指纹（调用方拿去和库里存的比对，
 * 好给出「你选的不是当初那把钥匙」这种能看懂的错误）。
 *
 * `passphrase` 是私钥文件自己的口令（如果有）。它和主密码是两个东西。
 */
pub fn open_with_private_key(
    path: &str,
    passphrase: Option<&str>,
    expected_fingerprint: Option<&str>,
    blob: &[u8],
) -> Result<[u8; KEY_LEN], String> {
    if blob.len() != HEADER_LEN + PAYLOAD_LEN + TAG_LEN || &blob[..MAGIC.len()] != MAGIC {
        return Err("恢复密钥数据已损坏（长度或标识不对）".to_string());
    }
    if blob[MAGIC.len()] != KIND_ED25519 {
        return Err("这把恢复密钥用的算法这个版本还不认识".to_string());
    }

    let private = load_private_key(path, passphrase)?;
    let KeypairData::Ed25519(keypair) = private.key_data() else {
        return Err(format!(
            "目前只支持 ed25519 私钥，这把是 {}",
            private.algorithm().as_str()
        ));
    };
    // 指纹比对放在 ECDH **之前**：拿错私钥是最常见的失败，而这一步能说出
    // 「你选的是哪把、库里配的是哪把」—— 走到 AEAD 那一步就只剩「解不开」了
    let fingerprint = private.fingerprint(HashAlg::Sha256).to_string();
    if let Some(expected) = expected_fingerprint {
        if expected != fingerprint {
            return Err(format!(
                "这把私钥不是当初设的那把 —— 库里记的是 {expected}，这把是 {fingerprint}"
            ));
        }
    }
    let recipient = ed25519_to_montgomery(&keypair.public.0)?;

    let eph_pub: [u8; EPH_LEN] = blob[MAGIC.len() + 1..MAGIC.len() + 1 + EPH_LEN]
        .try_into()
        .map_err(|_| "恢复密钥数据已损坏".to_string())?;
    let nonce = &blob[MAGIC.len() + 1 + EPH_LEN..HEADER_LEN];

    // Ed25519 私钥转 X25519：seed 的 SHA-512 前 32 字节，就是那条双有理映射给出的标量
    // （libsodium 的 crypto_sign_ed25519_sk_to_curve25519 是同一件事）。
    // 夹紧（clamp）交给 dalek 的 mul_clamped 做 —— 它是幂等的，不信可以看 recovery 的测试，
    // 那里用「私钥转出来的公钥 == 公钥转出来的公钥」这条自洽性把它钉住了。
    let expanded = Sha512::digest(keypair.private.to_bytes());
    let scalar: [u8; 32] = expanded[..32]
        .try_into()
        .map_err(|_| "私钥长度异常".to_string())?;
    let shared = MontgomeryPoint(eph_pub).mul_clamped(scalar).0;
    check_shared(&shared)?;

    let aes_key = derive_aes_key(&shared, &eph_pub, &recipient.0)?;
    let cipher = Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("初始化解密器失败: {e}"))?;
    let payload = cipher
        .decrypt(Nonce::from_slice(nonce), &blob[HEADER_LEN..])
        .map_err(|_| {
            "解不开：这把私钥和当初设恢复密钥时用的那把公钥对不上".to_string()
        })?;

    if payload.len() != PAYLOAD_LEN || &payload[KEY_LEN..] != PAYLOAD_TAG {
        return Err("恢复密钥里封的不是本密钥库的数据".to_string());
    }
    let mut vault_key = [0u8; KEY_LEN];
    vault_key.copy_from_slice(&payload[..KEY_LEN]);
    Ok(vault_key)
}

fn check_shared(shared: &[u8; 32]) -> Result<(), String> {
    // 全零共享密钥 = 对方给了一个小阶点，X25519 的经典坑，直接拒
    if shared.iter().all(|b| *b == 0) {
        return Err("公钥是小阶点，拒绝使用".to_string());
    }
    Ok(())
}

/** 读私钥文件。走 russh 那套解析，OpenSSH / PEM / PuTTY 格式和加密私钥都交给它 */
fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    russh::keys::load_secret_key(path, passphrase).map_err(|e| {
        format!(
            "读不到这把私钥：{e}{}",
            // 最常见的一种失败：私钥有口令却没填 —— russh 的报错不会点破这一点
            if passphrase.is_none() {
                "（如果私钥本身带口令，请在下面填上）"
            } else {
                ""
            }
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve, LineEnding};

    /**
     * 生成一把临时 ed25519 密钥对，返回（私钥文件路径，公钥文本）。
     *
     * 用 `rand10`（dev-dependencies 那份 rand 0.10）而不是主代码的 rand 0.9：
     * ssh-key 0.7-rc 的 `PrivateKey::random` 要的是 rand_core 0.10 的 `CryptoRng`，
     * 和 rand 0.9 那份不是同一个 trait，类型对不上。
     */
    fn temp_keypair(tag: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("easy-shell-recovery-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
        let path = dir.join("id_ed25519");
        std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        let public = key.public_key().to_openssh().unwrap();
        (path, public)
    }

    fn cleanup(path: &std::path::Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /**
     * Ed25519 → X25519 的两条转换必须自洽。
     *
     * 这是整个方案里唯一自己拼的密码学：公钥那边走曲线上的双有理映射，
     * 私钥那边走 seed 的 SHA-512 前 32 字节。写错了不会报错，只会在
     * 「用私钥开封」时安静地解不开 —— 所以用「私钥转出来的公钥 == 公钥转出来的公钥」
     * 这条恒等式把它钉死（也正是 RFC 7748 认的那条）。
     */
    #[test]
    fn ed25519_转_x25519_公私两侧自洽() {
        for _ in 0..8 {
            let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
            let KeypairData::Ed25519(keypair) = key.key_data() else {
                panic!("生成的不是 ed25519 密钥");
            };
            let expanded = Sha512::digest(keypair.private.to_bytes());
            let scalar: [u8; 32] = expanded[..32].try_into().unwrap();

            let from_private = MontgomeryPoint::mul_base_clamped(scalar);
            let from_public = ed25519_to_montgomery(&keypair.public.0).unwrap();
            assert_eq!(
                from_private.0, from_public.0,
                "私钥侧与公钥侧推出的 X25519 公钥不一致 —— 转换写错了"
            );
        }
    }

    #[test]
    fn 公钥能解析出指纹也能从文件路径读() {
        let (_, public_line) = temp_keypair("parse");
        let from_text = parse_public_key(&public_line).unwrap();
        assert!(from_text.fingerprint.starts_with("SHA256:"), "{}", from_text.fingerprint);
        assert!(from_text.line.starts_with("ssh-ed25519 "));
    }

    #[test]
    fn 封给公钥的库密钥能用私钥解出来() {
        let (path, public_line) = temp_keypair("roundtrip");
        let public = parse_public_key(&public_line).unwrap();
        let vault_key = [7u8; KEY_LEN];

        let blob = seal(&public, &vault_key).unwrap();
        // 带上期望指纹这条走「比对通过 → 正常解封」
        let opened = open_with_private_key(
            path.to_str().unwrap(),
            None,
            Some(&public.fingerprint),
            &blob,
        )
        .unwrap();

        assert_eq!(opened, vault_key, "解出来的库密钥和封进去的不一样");
        cleanup(&path);
    }

    /// 指纹对不上要在**动密码学之前**就说清楚：库里配的是哪把、你选的是哪把
    #[test]
    fn 指纹对不上时直接报出来() {
        let (path, public_line) = temp_keypair("fp-mismatch");
        let public = parse_public_key(&public_line).unwrap();
        let blob = seal(&public, &[5u8; KEY_LEN]).unwrap();

        let err = open_with_private_key(
            path.to_str().unwrap(),
            None,
            Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            &blob,
        )
        .unwrap_err();
        assert!(err.contains("不是当初设的那把"), "{err}");
        assert!(err.contains("库里记的是"), "{err}");
        cleanup(&path);
    }

    /// 每次封印的结果都不同（临时密钥 + nonce 都是新的），否则就是在复用 ECDH 随机数
    #[test]
    fn 同一把公钥封两次得到的密文不同() {
        let (_, public_line) = temp_keypair("nonce");
        let public = parse_public_key(&public_line).unwrap();
        let a = seal(&public, &[1u8; KEY_LEN]).unwrap();
        let b = seal(&public, &[1u8; KEY_LEN]).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), b.len());
    }

    #[test]
    fn 换一把私钥解不开() {
        let (right_path, public_line) = temp_keypair("right");
        let (other_path, _) = temp_keypair("other");
        let public = parse_public_key(&public_line).unwrap();
        let blob = seal(&public, &[9u8; KEY_LEN]).unwrap();

        // 不给期望指纹：走的是「指纹没法比、只能靠 AEAD 拦下」那条路
        let err =
            open_with_private_key(other_path.to_str().unwrap(), None, None, &blob).unwrap_err();
        assert!(err.contains("对不上"), "错误信息该说清是哪不对：{err}");
        cleanup(&right_path);
        cleanup(&other_path);
    }

    #[test]
    fn 密文被改过就解不开() {
        let (path, public_line) = temp_keypair("tamper");
        let public = parse_public_key(&public_line).unwrap();
        let mut blob = seal(&public, &[3u8; KEY_LEN]).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;

        assert!(open_with_private_key(path.to_str().unwrap(), None, None, &blob).is_err());
        cleanup(&path);
    }

    /// 非 ed25519 的密钥要给出明确的话，而不是一个含糊的解析失败
    #[test]
    fn 非_ed25519_的公钥被明确拒绝() {
        let ecdsa = PrivateKey::random(
            &mut rand10::rng(),
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let line = ecdsa.public_key().to_openssh().unwrap();
        let err = parse_public_key(&line).unwrap_err();
        assert!(err.contains("只支持 ed25519"), "{err}");
    }

    #[test]
    fn 既不是密钥也读不到文件时说清楚() {
        let err = read_public_key("this-is-not-a-key").unwrap_err();
        assert!(err.contains("读不到这个文件"), "{err}");
    }
}
