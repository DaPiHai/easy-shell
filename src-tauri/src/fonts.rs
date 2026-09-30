//! 系统字体清单：设置面板那个「字体族」下拉框要列出本机真装了哪些字体。
//!
//! **为什么跑在 Rust 侧**：浏览器里拿不到这份清单。`document.fonts.check()` 对
//! 根本不存在的字体名也返回 `true`（Chromium 只查"有没有待加载的 webfont"，不查本机，
//! 实测过）；`queryLocalFonts()` 在 WebView2 里没有授权入口。而 Windows 上装了哪些字体，
//! 注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` 里写着。
//!
//! 非 Windows 平台试一把 `fc-list`（fontconfig 自带，多数 Linux 桌面都有），拿不到就
//! 返回空表 —— 前端这时退回「候选表 + canvas 量宽」那套兜底，不会变成空下拉框。

use std::collections::HashSet;

/**
 * 样式后缀。注册表是**一个样式一条**登记的（`Consolas Bold`、`Consolas Bold Italic`、
 * `Cascadia Code Regular`…），而用户要挑的是"家族"，所以这些词要剥掉。
 *
 * `Light` / `Black` / `Medium` / `Condensed` **故意不在表里** ——
 * `Calibri Light`、`Arial Black`、`Franklin Gothic Medium` 在 Windows 里本来就是
 * 独立的家族（系统自带的字体列表也这么显示），剥了就真少一个。
 *
 * 表必须**长词在前**：先匹配 `Light Italic` 才对，先撞上 `Italic` 会剥出 `Candara Light`
 * 这种半截名字。有一条单测钉着这个顺序。
 */
const STYLE_SUFFIXES: &[&str] = &[
    "Extra Light Italic",
    "Ultra Light Italic",
    "Semi Light Italic",
    "Semi Bold Italic",
    "ExtraBold Italic",
    "Semilight Italic",
    "SemiLight Italic",
    "SemiBold Italic",
    "DemiBold Italic",
    "Light Oblique",
    "Light Italic",
    "Black Italic",
    "Bold Oblique",
    "Bold Italic",
    "Extra Light",
    "Ultra Light",
    "Extra Bold",
    "Ultra Bold",
    "ExtraLight",
    "UltraLight",
    "Semi Light",
    "Semi Bold",
    "Semilight",
    "SemiLight",
    "SemiBold",
    "DemiBold",
    "Oblique",
    "Regular",
    "Italic",
    "Retina",
    "Heavy",
    "Thin",
    "Bold",
];

/**
 * 破折号写法的后缀（`FiraCodeNerdFontMono-Bold`，Nerd Fonts 那类安装包这么登记）。
 *
 * 这份可以比上面激进：`Light`/`Medium` 在空格写法里是独立家族（`Calibri Light` 真存在），
 * 在破折号写法里就只是权重 —— Windows 自带的字体里没有一个家族名是以 `-Bold` 这种结尾的。
 */
const HYPHEN_STYLE_SUFFIXES: &[&str] = &[
    "SemiBold",
    "ExtraLight",
    "UltraLight",
    "Semilight",
    "Regular",
    "Medium",
    "Retina",
    "Italic",
    "Oblique",
    "Light",
    "Black",
    "Heavy",
    "Thin",
    "Book",
    "Bold",
];

/// 列出本机已安装的字体族名：去重、按名字排序。
///
/// 用 `async fn` 而不是同步命令：同步命令跑在 UI 线程上，而这条路在非 Windows 上要起一个
/// `fc-list` 进程，不该拿进程去堵界面。
#[tauri::command]
pub async fn list_system_fonts() -> Vec<String> {
    collect()
}

/// 同步的收集过程单独拎出来，是为了能单测（`#[tauri::command]` 那个函数不好直接调）。
fn collect() -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    #[cfg(windows)]
    read_registry(&mut raw);
    if raw.is_empty() {
        // 非 Windows 走这条；Windows 上注册表读不到时也兜一下（fc-list 一般不在，
        // 那就如实返回空表）
        read_fc_list(&mut raw);
    }
    clean(raw)
}

/// 注册表里的**值名**就是字体名，长这样：
/// `Consolas (TrueType)`、`Microsoft YaHei & Microsoft YaHei UI (TrueType)`、`8514oem (All res)`。
/// 一个值名里可能挤着好几个家族（`&` 分隔），尾部的括号是格式说明不是名字的一部分。
// 非 Windows 上只有单测会用它
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_registry_name(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    let base = match raw.rfind(" (") {
        Some(i) if raw.ends_with(')') => &raw[..i],
        _ => raw,
    };
    base.split('&')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| strip_style(s).to_string())
        .collect()
}

/// 剥掉样式后缀（`Consolas Bold Italic` → `Consolas`）。
/// 也认破折号写法：Nerd Fonts 那类安装包会登记成 `FiraCodeNerdFontMono-Bold`。
///
/// 匹配不区分大小写：注册表里 `Segoe UI Semibold`（小写 b）与 `Consolas Bold`
/// 是同一个词根的两种写法。
fn strip_style(name: &str) -> &str {
    for suffix in STYLE_SUFFIXES {
        // 名字本身就不比后缀长多少的，别剥 —— 真有个字体就叫 Bold 也别把自己剥没了
        if name.len() <= suffix.len() + 1 {
            continue;
        }
        let cut = name.len() - suffix.len();
        let (Some(head), Some(tail)) = (name.get(..cut), name.get(cut..)) else {
            continue; // 切在字符中间：这个后缀对不上
        };
        if tail.eq_ignore_ascii_case(suffix) {
            if let Some(rest) = head.strip_suffix(' ') {
                return rest.trim_end();
            }
        }
    }
    if let Some((head, tail)) = name.rsplit_once('-') {
        if !head.is_empty()
            && STYLE_SUFFIXES
                .iter()
                .chain(HYPHEN_STYLE_SUFFIXES)
                .any(|s| tail.eq_ignore_ascii_case(s))
        {
            return head;
        }
    }
    name
}

/// 大小写不敏感地去重 + 排序（保留先见到的那个拼法）。
/// 系统里 `HKLM` 与用户级 `HKCU` 两边常常各有一份同名条目，用户自己装的字体尤其如此。
fn clean(names: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim().to_string();
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        out.push(name);
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

#[cfg(windows)]
fn read_registry(out: &mut Vec<String>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    // 机器级 + 用户级（"为当前用户安装"的字体在后者里）
    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";
    for root in [
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CURRENT_USER),
    ] {
        let Ok(key) = root.open_subkey(KEY) else {
            continue;
        };
        // 读值名就够了，值本身（字体文件名）用不上
        for name in key.enum_values().flatten().map(|(name, _)| name) {
            out.extend(parse_registry_name(&name));
        }
    }
}

/// fontconfig 的 `fc-list`：一行一个字体，`family` 那一栏可能是逗号分开的几个别名。
fn read_fc_list(out: &mut Vec<String>) {
    let Ok(o) = std::process::Command::new("fc-list")
        .args(["--format", "%{family}\n"])
        .output()
    else {
        return; // 没装 fontconfig：不是错误，只是没这能力
    };
    if !o.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        for fam in line.split(',') {
            let fam = fam.trim();
            if !fam.is_empty() {
                out.push(fam.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 注册表值名拆成家族名() {
        assert_eq!(parse_registry_name("Consolas (TrueType)"), ["Consolas"]);
        assert_eq!(parse_registry_name("8514oem (All res)"), ["8514oem"]);
        assert_eq!(
            parse_registry_name("Microsoft YaHei & Microsoft YaHei UI (TrueType)"),
            ["Microsoft YaHei", "Microsoft YaHei UI"]
        );
        assert_eq!(
            parse_registry_name(" 宋体 & 新宋体 (TrueType) "),
            ["宋体", "新宋体"]
        );
        // 括号只在末尾才算格式说明 —— 名字中间的括号得留着
        assert_eq!(parse_registry_name("Foo (Bar) Baz"), ["Foo (Bar) Baz"]);
    }

    #[test]
    fn 样式后缀剥到家族名() {
        for (raw, want) in [
            ("Consolas Bold", "Consolas"),
            ("Consolas Bold Italic", "Consolas"),
            ("Consolas Italic", "Consolas"),
            ("Cascadia Code Regular", "Cascadia Code"),
            // 先匹配 "Light Italic" 才不会剩下半截 "Candara Light"
            ("Candara Light Italic", "Candara"),
            ("Segoe UI Semibold Italic", "Segoe UI"),
            ("Segoe UI Semilight Italic", "Segoe UI"),
            ("Sitka Text Italic", "Sitka Text"),
            ("Franklin Gothic Medium Italic", "Franklin Gothic Medium"),
            // 这几个是 Windows 里独立的家族名，不该被动
            ("Calibri Light", "Calibri Light"),
            ("Arial Black", "Arial Black"),
            ("Franklin Gothic Medium", "Franklin Gothic Medium"),
            ("SimSun-ExtB", "SimSun-ExtB"),
            // 破折号写法（Nerd Fonts 那类）
            ("FiraCodeNerdFontMono-Bold", "FiraCodeNerdFontMono"),
            ("FiraCodeNerdFontPropo-Regular", "FiraCodeNerdFontPropo"),
            ("FiraCodeNerdFont-SemiBold", "FiraCodeNerdFont"),
            ("FiraCodeNerdFont-Light", "FiraCodeNerdFont"),
            ("FiraCodeNerdFont-Medium", "FiraCodeNerdFont"),
            // 带破折号的真家族名不该被动
            ("SimSun-ExtB", "SimSun-ExtB"),
            ("GWZT-EN", "GWZT-EN"),
        ] {
            assert_eq!(strip_style(raw), want, "剥错了：{raw}");
        }
    }

    /// 表必须长词在前 —— 顺序错了只会在个别字体上悄悄剥出半截名字
    #[test]
    fn 样式后缀表按长度降序() {
        for pair in STYLE_SUFFIXES.windows(2) {
            assert!(
                pair[0].len() >= pair[1].len(),
                "{} 排在 {} 前面太短了",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn 去重忽略大小写并按名字排序() {
        let got = clean(vec![
            "consolas".into(),
            "Consolas".into(),
            "  ".into(),
            "宋体".into(),
            "Cascadia Mono".into(),
        ]);
        assert_eq!(got, ["Cascadia Mono", "consolas", "宋体"]);
    }

    /// 真机自检：这台机器上至少得读出一批字体，而且不该再有 `xxx Bold` 这种样式条目。
    /// 读不到就说明注册表路径变了 —— 那时下拉框会空着，用户只会看到"没有字体"。
    #[cfg(windows)]
    #[test]
    fn 本机字体清单非空且没有样式条目() {
        let names = collect();
        assert!(names.len() > 5, "只读到 {} 个字体", names.len());
        for n in &names {
            assert!(!n.ends_with(')'), "{n} 还带着格式说明");
            assert!(!n.ends_with(" Bold"), "{n} 还是个样式条目");
            assert!(!n.ends_with(" Italic"), "{n} 还是个样式条目");
            assert_eq!(n.trim(), n, "{n} 首尾有空白");
        }
        // 随手挑几个 Windows 自带的：一个都没有就说明读的不是字体注册表
        const KNOWN: [&str; 5] = ["Consolas", "Arial", "Microsoft YaHei", "宋体", "SimSun"];
        assert!(
            names
                .iter()
                .any(|n| KNOWN.iter().any(|k| n.eq_ignore_ascii_case(k))),
            "这些自带字体一个都没读到：{names:?}"
        );
    }
}
