//! 与 `server.js` 逐条对齐的 JS 语义工具函数。
//!
//! 这些函数的返回值必须和 Node 版本一模一样，前端已经按那个契约写好了，
//! 所以这里宁可写得啰嗦一点，也不"顺手优化"。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/* ------------------------------------------------------------- 目录约定 */

#[derive(Debug, Clone)]
pub struct Dirs {
    /// exe 所在目录
    pub exe: PathBuf,
    /// <exe>/papers
    pub papers: PathBuf,
    /// <exe>/data
    pub data: PathBuf,
}

static DIRS: OnceLock<Dirs> = OnceLock::new();

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 初始化（并记住）exe 同级目录；papers/ data/ 不存在就创建。
pub fn init_dirs() -> &'static Dirs {
    DIRS.get_or_init(|| {
        let exe = exe_dir();
        let papers = std::env::var_os("PRT_PAPERS_DIR").map(PathBuf::from).unwrap_or_else(|| exe.join("papers"));
        let data = std::env::var_os("PRT_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| exe.join("data"));
        let d = Dirs {
            papers,
            data,
            exe,
        };
        // 建目录失败不致命：后面每个写操作自己还会兜底
        let _ = std::fs::create_dir_all(&d.papers);
        let _ = std::fs::create_dir_all(&d.data);
        d
    })
}

pub fn dirs() -> &'static Dirs {
    init_dirs()
}

/* ------------------------------------------------------------------ MIME */

/// 与 server.js 的 MIME 表逐条一致（大小写不敏感，按扩展名查）
pub fn mime_of(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".mjs" => "text/javascript; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" => "image/jpeg",
        ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".pdf" => "application/pdf",
        ".txt" => "text/plain; charset=utf-8",
        ".map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub const MIME_JSON: &str = "application/json; charset=utf-8";
pub const MIME_HTML: &str = "text/html; charset=utf-8";
pub const MIME_TEXT: &str = "text/plain; charset=utf-8";

/// `path.extname()`（win32 语义：`/` 和 `\` 都算分隔符）
pub fn extname(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        None | Some(0) => String::new(),
        Some(i) => base[i..].to_string(),
    }
}

/* --------------------------------------------------------------- docId */

fn looks_like_doc_id(s: &str) -> bool {
    if s.len() > 64 || s.contains('.') {
        return false;
    }
    let Some(dash) = s.rfind('-') else { return false };
    let (head, tail) = s.split_at(dash);
    if head.is_empty() {
        return false;
    }
    let hex = &tail[1..];
    (6..=10).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn doc_id_of(name: &str) -> String {
    if looks_like_doc_id(name) {
        return name.to_string();
    }
    let mut h: u32 = 5381;
    for cu in name.encode_utf16() {
        h = h.wrapping_mul(33) ^ (cu as u32);
    }

    // s.replace(/\.[^.]+$/, '') —— 去掉最后一个点后面的扩展名
    let mut stem = name;
    if let Some(i) = name.rfind('.') {
        if i + 1 < name.len() {
            stem = &name[..i];
        }
    }

    // .replace(/[^\w\u4e00-\u9fa5-]+/g, '_') —— 连续非法字符折叠成一个下划线
    let mut slug = String::new();
    let mut in_bad_run = false;
    for c in stem.chars() {
        let ok = c.is_ascii_alphanumeric()
            || c == '_'
            || c == '-'
            || ('\u{4e00}'..='\u{9fa5}').contains(&c);
        if ok {
            slug.push(c);
            in_bad_run = false;
        } else if !in_bad_run {
            slug.push('_');
            in_bad_run = true;
        }
    }

    // .slice(0, 48)（按字符截断；BMP 字符与 JS 的 UTF-16 下标等价）
    if slug.chars().count() > 48 {
        slug = slug.chars().take(48).collect();
    }

    format!("{}-{:x}", slug, h)
}

/* --------------------------------------------------------- URL / 百分号 */

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent()`：非法转义或非法 UTF-8 都返回 None（调用方回 400）
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let (hi, lo) = match (
                bytes.get(i + 1).and_then(|b| hex_val(*b)),
                bytes.get(i + 2).and_then(|b| hex_val(*b)),
            ) {
                (Some(a), Some(b)) => (a, b),
                _ => return None,
            };
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// URLSearchParams 的解码规则：`+` → 空格，非法转义原样保留（宽松，不报错）
pub fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                match (
                    bytes.get(i + 1).and_then(|b| hex_val(*b)),
                    bytes.get(i + 2).and_then(|b| hex_val(*b)),
                ) {
                    (Some(a), Some(b)) => {
                        out.push((a << 4) | b);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `encodeURIComponent()`：只保留 `A-Za-z0-9-_.!~*'()`
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// 把请求行里的 target 拆成 (raw_path, raw_query)
pub fn split_target(target: &str) -> (&str, &str) {
    let t = target.trim();
    // 兼容 absolute-form（GET http://host/path HTTP/1.1）
    let t = if let Some(rest) = t.strip_prefix("http://").or_else(|| t.strip_prefix("https://")) {
        match rest.find('/') {
            Some(i) => &rest[i..],
            None => "/",
        }
    } else {
        t
    };
    match t.find('?') {
        Some(i) => (&t[..i], &t[i + 1..]),
        None => (t, ""),
    }
}

/// 取查询串里的第一个同名参数（Node 的 `searchParams.get()` 语义）
pub fn query_get(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => (pair, ""),
        };
        if form_decode(k) == key {
            return Some(form_decode(v));
        }
    }
    None
}

/* ------------------------------------------------------- 路径穿越防护 */

/// 与 server.js 的 `safeJoin()` 等价：把相对路径限制在 base 之内，越界返回 None。
pub fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    if cleaned.is_empty() || cleaned.contains('\0') {
        return None;
    }
    let mut out = base.to_path_buf();
    let mut depth: i64 = 0;
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                if depth == 0 {
                    return None; // 想跑出 base，直接拒绝
                }
                depth -= 1;
                out.pop();
            }
            s => {
                if s.contains(':') {
                    return None; // 绝对路径 / 驱动器号 / NTFS 数据流
                }
                out.push(s);
                depth += 1;
            }
        }
    }
    if depth <= 0 {
        return None;
    }
    Some(out)
}

/// 静态资源：把已经 `decodeURIComponent` 过的路径变成 rust-embed 的 key。
/// 返回 None 表示这是穿越/非法路径，应该 400。
pub fn static_asset_key(decoded_path: &str) -> Option<String> {
    if decoded_path.contains('\0') {
        return None;
    }
    let cleaned = decoded_path.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    if cleaned.is_empty() {
        return Some("index.html".to_string());
    }
    let mut stack: Vec<&str> = Vec::new();
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                if stack.pop().is_none() {
                    return None; // 逃出 public/
                }
            }
            s => {
                if s.contains(':') {
                    return None;
                }
                stack.push(s);
            }
        }
    }
    if stack.is_empty() {
        return Some("index.html".to_string());
    }
    Some(stack.join("/"))
}

/* ------------------------------------------------- 交给系统浏览器打开 */

/// 是不是可以交给外部浏览器打开的地址。只放行 http(s)：
/// `file:`、`javascript:`、`data:` 这些一律不放行（从网页里来的字符串不能直接执行）。
pub fn is_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 用系统默认浏览器打开链接。
///
/// 为什么需要它：应用是 WebView2 外壳，页面里的 `<a target="_blank">` 默认什么都不会发生
/// （用户反馈「论文查找的网页链接点不动」就是这个）。而在应用窗口里直接跳走又会把界面顶掉，
/// 所以统一走这里交给系统浏览器。
///
/// 用 `rundll32 url.dll,FileProtocolHandler` 而不是 `cmd /c start`：
/// cmd 会把 URL 里的 `&` 当成命令分隔符，而搜索结果里的链接经常带查询串
/// （`?q=a&b=c`），用 cmd 会被截断甚至执行到半截命令。
pub fn open_in_browser(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !is_external_url(url) {
        return Err("只允许打开 http/https 链接".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 别弹出黑框
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // 依次试三种「不经过 shell」的打开方式，谁先成功用谁
        let attempts: [(&str, Vec<String>); 3] = [
            ("rundll32.exe", vec!["url.dll,FileProtocolHandler".into(), url.into()]),
            ("explorer.exe", vec![url.into()]),
            // 兜底给 cmd，但 URL 必须自己加引号：
            // Rust 只在参数含空格时才加引号，而 http://x/?a=1&b=2 没有空格，
            // 不加引号的话 cmd 会把 & 当命令分隔符，链接就被截断了。
            ("cmd", vec!["/C".into(), "start".into(), String::new(), format!("\"{}\"", url.replace('"', ""))]),
        ];
        let mut last = String::new();
        for (exe, args) in attempts {
            match std::process::Command::new(exe)
                .args(&args)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(e) => last = format!("{}: {}", exe, e),
            }
        }
        Err(format!("启动浏览器失败: {}", last))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("启动浏览器失败: {}", e))
    }
}

/* ------------------------------------------------------------- chat URL */

/// 与 server.js 的 `normalizeChatUrl()` 一致。
pub fn normalize_chat_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    let base = trimmed.trim_end_matches('/');
    if base.is_empty() {
        return Err("没有配置 API 地址".to_string());
    }
    let lower = base.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("API 地址必须以 http:// 或 https:// 开头".to_string());
    }
    if lower.ends_with("/chat/completions") {
        return Ok(base.to_string());
    }
    Ok(format!("{}/chat/completions", base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_id_matches_node() {
        // 期望值由 node 跑 server.js 里的 docIdOf() 得到，用来锁死算法
        assert_eq!(doc_id_of("a.pdf"), "a-a45a758");
        assert_eq!(doc_id_of("../../x"), "_-d7d6ab7d");
        assert_eq!(doc_id_of("论文 1.pdf"), "论文_1-1b72b675");
        assert_eq!(
            doc_id_of("attention is all you need.pdf"),
            "attention_is_all_you_need-cd8ccfd"
        );
        assert_eq!(doc_id_of(".pdf"), "-7c4d6d19");
        assert_eq!(doc_id_of("abc."), "abc_-7c6d830b");
        assert_eq!(doc_id_of("no_ext"), "no_ext-622f6292");
        // doc=../../x 必须被清洗成纯文件名，不能穿越
        assert!(!doc_id_of("../../x").contains('/'));
        assert!(!doc_id_of("../../x").contains('.'));
    }

    #[test]
    fn traversal_blocked() {
        assert!(static_asset_key("/../server.js").is_none());
        assert!(static_asset_key("/..%2f".replace("%2f", "/").as_str()).is_none());
        assert_eq!(static_asset_key("/js/app.js").unwrap(), "js/app.js");
        assert_eq!(static_asset_key("/").unwrap(), "index.html");
    }
}
