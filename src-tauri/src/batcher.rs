//! 输出攒批：把零散的字节流合并成一帧再推给前端。
//!
//! 为什么不直接一条一推：`cat` 大文件、跑 `yes` 的时候，服务端会按很小的小块
//! 疯狂下发数据，每一块都过一次 IPC 会把前端刷爆（xterm 的 write 是有成本的）。
//! 按 ~16ms 攒成一帧，跟屏幕刷新率对齐，肉眼无感，IPC 次数能降一到两个数量级。
//!
//! 单独成模块是为了能写单测 —— 这段逻辑在 `ssh_open_shell` 里跑，
//! 而端到端测试走的是 `connect_and_auth`，根本碰不到这条路径。

use std::time::{Duration, Instant};

/// 默认帧长，约等于 60fps 一帧
pub const DEFAULT_FRAME: Duration = Duration::from_millis(16);
/// 攒到这个量就不管时间直接发，免得单帧过大
pub const MAX_BATCH: usize = 64 * 1024;

pub struct FrameBatcher {
    buf: Vec<u8>,
    last_flush: Instant,
    frame: Duration,
    max_batch: usize,
}

impl FrameBatcher {
    pub fn new() -> Self {
        Self::with(DEFAULT_FRAME, MAX_BATCH)
    }

    /// 测试用：可以指定帧长和上限，不用真的等 16ms
    pub fn with(frame: Duration, max_batch: usize) -> Self {
        Self {
            buf: Vec::with_capacity(8192),
            last_flush: Instant::now(),
            frame,
            max_batch,
        }
    }

    /// 塞一段数据进去
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// 该不该发一帧了：要么到点了，要么攒够上限了
    pub fn ready(&self) -> bool {
        // 先看时间再看有货：反过来写，编译器会判 last_flush 写了没人读
        if self.buf.is_empty() {
            return false;
        }
        self.last_flush.elapsed() >= self.frame || self.buf.len() >= self.max_batch
    }

    /// 取出并清空。空缓冲返回 None（顺带重置计时，下一段数据重新计帧）
    pub fn take(&mut self) -> Option<Vec<u8>> {
        self.last_flush = Instant::now();
        if self.buf.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.buf))
    }

    /// 主流程暂时用不上，留着给调用方判断"还有没有没发出去的"
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

impl Default for FrameBatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 帧长设成 0，测"到点就该发"这类逻辑不用真的睡
    fn immediate() -> FrameBatcher {
        FrameBatcher::with(Duration::ZERO, MAX_BATCH)
    }

    /// 帧长设成 1 小时，测"攒够量才发"这类逻辑不受时间干扰
    fn never_by_time() -> FrameBatcher {
        FrameBatcher::with(Duration::from_secs(3600), MAX_BATCH)
    }

    #[test]
    fn 空缓冲取不出东西() {
        let mut b = immediate();
        assert!(b.take().is_none());
        assert!(b.is_empty());
    }

    #[test]
    fn 空缓冲永远没到发射时机() {
        let b = immediate();
        assert!(!b.ready(), "没数据就别发，否则会推一堆空事件给前端");
    }

    #[test]
    fn 没到帧长就先攒着() {
        let mut b = never_by_time();
        b.push(b"hello");
        assert!(!b.ready());
    }

    #[test]
    fn 到点了就发() {
        let mut b = immediate();
        b.push(b"hello");
        assert!(b.ready());
        assert_eq!(b.take().unwrap(), b"hello");
    }

    #[test]
    fn 多段数据会拼成一帧发出去() {
        let mut b = immediate();
        b.push(b"he");
        b.push(b"llo");
        assert_eq!(b.take().unwrap(), b"hello");
    }

    #[test]
    fn 取完就空了不会重复发() {
        let mut b = immediate();
        b.push(b"x");
        assert!(b.take().is_some());
        assert!(b.take().is_none(), "同一帧不能发两次");
    }

    #[test]
    fn 攒够上限不等时间直接发() {
        let mut b = never_by_time();
        b.push(&vec![0u8; MAX_BATCH + 1]);
        assert!(b.ready(), "单帧太大也该发，不然内存会一直涨");
    }

    #[test]
    fn 差一点点到上限就还要等() {
        let mut b = never_by_time();
        b.push(&vec![0u8; MAX_BATCH - 1]);
        assert!(!b.ready());
    }

    #[test]
    fn 取完会重置计时_下一段重新攒一帧() {
        let mut b = FrameBatcher::with(Duration::from_secs(3600), MAX_BATCH);
        b.push(b"first");
        // 强制取一次（不等 ready）
        assert_eq!(b.take().unwrap(), b"first");
        // 计时器刚重置过，新数据又要重新等一帧
        b.push(b"second");
        assert!(!b.ready());
    }

    #[test]
    fn 二进制数据不会被破坏() {
        let mut b = immediate();
        // 一段 UTF-8 中文 + 一个 ANSI 转义序列，攒批不能改字节
        let raw = "中文\x1b[32mok\x1b[0m".as_bytes();
        b.push(&raw[..3]); // "中" 的三个字节
        b.push(&raw[3..]); // 剩下的
        assert_eq!(b.take().unwrap(), raw.to_vec());
    }
}
