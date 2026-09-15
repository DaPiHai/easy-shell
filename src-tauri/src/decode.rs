//! 本地 Shell 输出的字符集解码。
//!
//! 为什么需要这个模块：Windows 控制台默认代码页是 936（GBK），PowerShell / cmd
//! 吐出来的中文不是 UTF-8。而 xterm.js 拿到的字节一律按 UTF-8 解释 —— 不做转换的话
//! 中文文件名、`git log`、报错信息全是乱码。
//!
//! 策略（PLAN.md 风险表里定的）：先按 UTF-8 解，解不动的部分按 GBK 解。
//! UTF-8 流零开销，只有真的解不动时才走 GBK 那条路。
//!
//! 真正的难点是**跨帧截断**：Rust 侧每 16ms 攒一帧再推给前端，帧边界是随机的，
//! 完全可能落在一个多字节字符中间（UTF-8 汉字 3 字节、GBK 汉字 2 字节）。
//! 所以解码器必须自己留着结尾那几个"看起来不完整"的字节，等下一帧拼上再解 ——
//! 否则每个被切断的汉字都会变成一个问号。

use encoding_rs::GBK;

/// UTF-8 完整序列最长 4 字节，GBK 最长 2 字节。残留超过这个数说明流本身有问题，
/// 别让缓冲无限涨下去，强制用替换字符冲掉。
const MAX_PENDING: usize = 4;

pub struct ShellDecoder {
    /// 上一帧末尾没解完的字节
    pending: Vec<u8>,
}

impl ShellDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// 追加一段字节，返回此刻能确定的文本。
    /// 结尾不完整的字符会留在内部缓冲里，等下一帧拼上再解。
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        self.drain(false)
    }

    /// 流结束了：把残留的字节强制解出来（能解多少算多少）
    pub fn finish(&mut self) -> String {
        let out = self.drain(true);
        self.pending.clear();
        out
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn drain(&mut self, flush: bool) -> String {
        let mut out = String::new();
        let buf = std::mem::take(&mut self.pending);
        let mut start = 0usize;

        loop {
            if start >= buf.len() {
                break;
            }
            match std::str::from_utf8(&buf[start..]) {
                // 这一段是干净的 UTF-8，直接吐出去
                Ok(s) => {
                    out.push_str(s);
                    start = buf.len();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        // 无效序列之前的部分还是好 UTF-8，先吐出去
                        out.push_str(std::str::from_utf8(&buf[start..start + valid]).unwrap());
                        start += valid;
                    }
                    match e.error_len() {
                        // error_len 为 None = 结尾卡着一个不完整的 UTF-8 序列
                        None if !flush => break,
                        None => {
                            // 流都结束了还拼不全，只能按丢失处理
                            out.push_str(&String::from_utf8_lossy(&buf[start..]));
                            start = buf.len();
                            break;
                        }
                        // 真不是 UTF-8 → 剩下这段按 GBK 解
                        Some(_) => {
                            let (text, used) = decode_gbk_head(&buf[start..], flush);
                            if used == 0 {
                                break;
                            }
                            out.push_str(&text);
                            start += used;
                        }
                    }
                }
            }
        }

        let leftover = buf[start..].to_vec();
        if flush || leftover.len() > MAX_PENDING {
            // 要么流结束了，要么残留异常地长（流本身有问题）——都冲掉
            if !leftover.is_empty() {
                out.push_str(&String::from_utf8_lossy(&leftover));
            }
            self.pending.clear();
        } else {
            self.pending = leftover;
        }
        out
    }
}

impl Default for ShellDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// GBK 的尾字节范围（0x7F 不在内）
fn is_gbk_trail(b: u8) -> bool {
    (0x40..=0xFE).contains(&b) && b != 0x7F
}

/// 从头扫一遍，找出「到哪为止是完整的 GBK 字符」。
///
/// 末尾如果剩一个孤立的前导字节（比如只收到汉字的前半），这一段就不能解 ——
/// 留着等下一个字节。但如果是**无效**的前导字节（后面跟的不是尾字节），
/// 那就把它消耗掉让 GBK 输出替换字符，不能卡在这儿不动。
fn gbk_complete_len(bytes: &[u8]) -> usize {
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        let b = bytes[i];
        if b < 0x80 {
            i += 1;
        } else if (0x81..=0xFE).contains(&b) {
            if i + 1 >= len {
                // 前导字节在末尾，尾字节还没来
                return i;
            } else if is_gbk_trail(bytes[i + 1]) {
                i += 2;
            } else {
                // 不是合法双字节，放它过去（GBK 会给出替换字符）
                i += 1;
            }
        } else {
            // 0x80 / 0xFF 在 GBK 里无效，当单字节处理
            i += 1;
        }
    }
    i
}

/// 解一段「确定不是 UTF-8」的字节，返回 (文本, 消耗掉的字节数)
fn decode_gbk_head(bytes: &[u8], flush: bool) -> (String, usize) {
    let end = if flush {
        bytes.len()
    } else {
        gbk_complete_len(bytes)
    };
    if end == 0 {
        return (String::new(), 0);
    }
    let (cow, _encoding, _had_errors) = GBK.decode(&bytes[..end]);
    (cow.into_owned(), end)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "中文" 的 GBK 编码：中=D6D0 文=CEC4
    const GBK_ZHONGWEN: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4];
    /// "中文" 的 UTF-8 编码
    const UTF8_ZHONGWEN: &[u8] = "中文".as_bytes();

    #[test]
    fn 纯_ascii_原样通过() {
        let mut d = ShellDecoder::new();
        assert_eq!(d.push(b"hello world\r\n"), "hello world\r\n");
    }

    #[test]
    fn utf8_中文直接通过() {
        let mut d = ShellDecoder::new();
        assert_eq!(d.push(UTF8_ZHONGWEN), "中文");
    }

    #[test]
    fn gbk_中文能转成_utf8() {
        let mut d = ShellDecoder::new();
        assert_eq!(d.push(GBK_ZHONGWEN), "中文");
    }

    #[test]
    fn gbk_中文混着_ascii() {
        let mut d = ShellDecoder::new();
        let mut input = b"dir: ".to_vec();
        input.extend_from_slice(GBK_ZHONGWEN);
        input.extend_from_slice(b"\r\n");
        assert_eq!(d.push(&input), "dir: 中文\r\n");
    }

    #[test]
    fn utf8_被切成两半要等下一帧() {
        let mut d = ShellDecoder::new();
        // "中" = E4 B8 AD，故意在中间切断
        assert_eq!(d.push(&UTF8_ZHONGWEN[..2]), "", "半个汉字不该吐出来");
        assert_eq!(d.push(&UTF8_ZHONGWEN[2..]), "中文");
    }

    #[test]
    fn utf8_逐字节喂也能拼回来() {
        let mut d = ShellDecoder::new();
        let mut out = String::new();
        for b in UTF8_ZHONGWEN {
            out.push_str(&d.push(&[*b]));
        }
        assert_eq!(out, "中文");
    }

    #[test]
    fn gbk_被切成两半要等下一帧() {
        let mut d = ShellDecoder::new();
        // "中" = D6 D0，只给前一半
        assert_eq!(d.push(&GBK_ZHONGWEN[..1]), "", "半个 GBK 字符不该吐出来");
        assert_eq!(d.push(&GBK_ZHONGWEN[1..]), "中文");
    }

    #[test]
    fn gbk_逐字节喂也能拼回来() {
        let mut d = ShellDecoder::new();
        let mut out = String::new();
        for b in GBK_ZHONGWEN {
            out.push_str(&d.push(&[*b]));
        }
        assert_eq!(out, "中文");
    }

    #[test]
    fn 空输入不产出任何东西() {
        let mut d = ShellDecoder::new();
        assert_eq!(d.push(b""), "");
        assert!(d.is_empty());
    }

    #[test]
    fn 一帧里_ascii_后面紧跟_gbk() {
        let mut d = ShellDecoder::new();
        let mut input = b"ls ".to_vec();
        input.extend_from_slice(GBK_ZHONGWEN);
        assert_eq!(d.push(&input), "ls 中文");
    }

    #[test]
    fn 一帧里_utf8_后面紧跟_gbk_各解各的() {
        let mut d = ShellDecoder::new();
        let mut input = Vec::new();
        input.extend_from_slice(UTF8_ZHONGWEN);
        input.extend_from_slice(GBK_ZHONGWEN);
        // 前半是合法 UTF-8，后半解不动走 GBK，两边都该是"中文"
        assert_eq!(d.push(&input), "中文中文");
    }

    #[test]
    fn finish_把残留强制解出来() {
        let mut d = ShellDecoder::new();
        // 只喂半个 UTF-8 汉字，然后流结束
        assert_eq!(d.push(&UTF8_ZHONGWEN[..2]), "");
        let out = d.finish();
        assert!(!out.is_empty(), "流结束时不该把最后那点字节吞掉");
        assert!(d.is_empty(), "finish 之后缓冲必须是空的");
    }

    #[test]
    fn finish_之后还能接着用() {
        let mut d = ShellDecoder::new();
        d.push(&UTF8_ZHONGWEN[..2]);
        d.finish();
        assert_eq!(d.push(b"ok"), "ok");
    }

    #[test]
    fn 孤立的前导字节不会卡死解码器() {
        let mut d = ShellDecoder::new();
        // 0xD6 后面跟空格（不是合法 GBK 尾字节），不能一直挂在缓冲里
        let out = d.push(&[0xD6, b' ']);
        assert!(!out.is_empty(), "无效字节也要解出来（替换字符），不能卡住");
        assert_eq!(d.push(b"end"), "end", "卡住的话后续字节会全被吞");
    }

    #[test]
    fn 二进制字节不会让解码器崩溃() {
        let mut d = ShellDecoder::new();
        // 一段混杂的字节，只要求不 panic 且不丢后续内容
        let _ = d.push(&[0x00, 0x80, 0xFF, 0xFE, 0x41]);
        assert_eq!(d.push(b"END"), "END");
    }
}
