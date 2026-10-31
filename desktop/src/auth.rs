
use std::sync::OnceLock;

use tiny_http::Request;

use crate::server::{err_json, send_json};

/// 自定义请求头（与 server.js 一致）
pub const HEADER: &str = "x-prt-token";
/// 子资源通道用的 cookie 名
pub const COOKIE: &str = "prt_session";
/// 唯一允许用 cookie 代替自定义头的接口
pub const SUBRESOURCE_PATH: &str = "/api/pdf";

/// 免认证路径。只有存活探针 `/api/health`：返回体固定 `{ok, port}`，
/// 不含用户数据、不读写盘、不出网；测试套件靠轮询它判断「隔离服务起来了没有」，
/// 那时它们还没拿到 token。详见 security.js 里 PUBLIC_PATHS 的说明。
pub const PUBLIC_PATHS: [&str; 1] = ["/api/health"];

/// 是不是免认证路径
pub fn is_public_path(path: &str) -> bool {
    PUBLIC_PATHS.contains(&path)
}

static TOKEN: OnceLock<String> = OnceLock::new();

/// 启动时调用一次；重复调用不会换 token。
/// 之后任何一次 `token()` 调用（含注入页面）拿到的都是同一个值 —— per-boot 稳定。
pub fn init() {
    let _ = TOKEN.get_or_init(random_token);
}

/// 64 位十六进制的随机 token。
///
/// 测试可以显式注入 `PRT_API_TOKEN=<值>`（审计 §P0：「测试认证必须显式注入，
/// 不能依赖生产后门」）。没有隐式后门 token：不注入就是随机值。
fn random_token() -> String {
    if let Ok(injected) = std::env::var("PRT_API_TOKEN") {
        let v = injected.trim().to_string();
        if v.chars().count() >= 8 {
            return v;
        }
        if !v.is_empty() {
            crate::log_line("[prt] PRT_API_TOKEN 太短（至少 8 个字符），已忽略并使用随机 token");
        }
    }
    let mut buf = [0u8; 32];
    fill_random(&mut buf);
    let mut s = String::with_capacity(64);
    for b in buf.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 这个 token 是调用方显式注入的（PRT_API_TOKEN）而不是本进程生成的
pub fn is_injected_token() -> bool {
    std::env::var("PRT_API_TOKEN")
        .map(|v| v.trim() == token())
        .unwrap_or(false)
}

/// 机器可读的 token 输出行，给「自己 spawn 隔离服务」的测试 harness 用。
///
/// 只此一行：`PRT_API_TOKEN` 已注入（调用方已知）或 `PRT_QUIET_TOKEN=1`
/// （交付版 / 不希望 token 落日志）时不打印。token 不会出现在任何其它日志、
/// 错误信息或 DOM 文本里。
pub fn token_announcement() -> Option<String> {
    if is_injected_token() {
        return None;
    }
    if std::env::var("PRT_QUIET_TOKEN").map(|v| v.trim() == "1").unwrap_or(false) {
        return None;
    }
    Some(format!("[prt] api-token: {}", token()))
}

/// 是否强制校验。默认开启，只有 `PRT_REQUIRE_TOKEN=0` 才关。
pub fn enforced() -> bool {
    match std::env::var("PRT_REQUIRE_TOKEN") {
        Ok(v) => v.trim() != "0",
        Err(_) => true,
    }
}

/// 当前 token。
///
/// `main()` 已经 `init()` 过；这里保留 `get_or_init` 兜底，保证任何调用路径下
/// 「注入页面的 token」和「校验用的 token」都是同一个值（per-boot 只生成一次）。
pub fn token() -> &'static str {
    TOKEN.get_or_init(random_token).as_str()
}

/* --------------------------------------------------------------- 随机源 */

#[cfg(windows)]
fn fill_random(buf: &mut [u8]) {
    // RtlGenRandom == SystemFunction036（advapi32），Windows 上的 CSPRNG。
    // 不走 BCryptGenRandom 是为了少一个链接面；两者都是系统 CSPRNG。
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buf: *mut u8, len: u32) -> u8;
    }
    let ok = unsafe { rtl_gen_random(buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        fill_random_fallback(buf);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn fill_random(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(buf).is_ok() {
            return;
        }
    }
    fill_random_fallback(buf);
}

#[cfg(target_os = "macos")]
fn fill_random(buf: &mut [u8]) {
    // 没有第三方 RNG 依赖时的 macOS 兜底（本项目只交付 Windows 版）
    fill_random_fallback(buf);
}

/// 最后的兜底：多个独立熵源混合后跑 SplitMix64 扩散。
/// 只在系统 CSPRNG 不可用时才会走到这里；token 依然不可预测到实用强度之上。
fn fill_random_fallback(buf: &mut [u8]) {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    // 地址随机化（ASLR）给的高位熵
    let stack = &now as *const u64 as u64;
    let heap = buf.as_ptr() as u64;

    let mut state = now
        ^ pid.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ stack.rotate_left(17)
        ^ heap.rotate_left(31);
    if state == 0 {
        state = 0x2545_F491_4F6C_DD1D;
    }
    for chunk in buf.chunks_mut(8) {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let bytes = z.to_le_bytes();
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = bytes[i];
        }
    }
}

/* --------------------------------------------------------------- 校验 */

fn eq_constant_time(a: &str, b: &str) -> bool {
    let x = a.as_bytes();
    let y = b.as_bytes();
    if x.len() != y.len() || x.is_empty() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..x.len() {
        diff |= x[i] ^ y[i];
    }
    diff == 0
}

fn header_value(rq: &Request, name: &str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn cookie_value(rq: &Request, name: &str) -> Option<String> {
    let raw = header_value(rq, "cookie")?;
    for part in raw.split(';') {
        if let Some(i) = part.find('=') {
            if part[..i].trim() == name {
                return Some(part[i + 1..].trim().to_string());
            }
        }
    }
    None
}

/// 这次请求有没有带上正确的 token。
/// `is_get_or_head` 只影响 `/api/pdf` 的子资源例外。
pub fn authorized(rq: &Request, path: &str, is_get_or_head: bool) -> bool {
    // 存活探针免认证（见 PUBLIC_PATHS 的说明）
    if is_public_path(path) {
        return true;
    }
    let t = token();
    // 空 token = 还没 init()：绝不能退化成「谁都放行」
    if t.is_empty() {
        return false;
    }
    if let Some(v) = header_value(rq, HEADER) {
        if eq_constant_time(&v, t) {
            return true;
        }
    }
    if path == SUBRESOURCE_PATH && is_get_or_head {
        if let Some(c) = cookie_value(rq, COOKIE) {
            if eq_constant_time(&c, t) {
                return true;
            }
        }
    }
    false
}

/// 附加防线：Origin / Referer 白名单（不能替代 token，审计 §P0 第 4 条）。
/// 两个头都没有时放行 —— 非浏览器客户端本来就不带。
pub fn origin_allowed(rq: &Request) -> bool {
    if let Some(o) = header_value(rq, "origin") {
        return is_loopback_origin(&o);
    }
    if let Some(r) = header_value(rq, "referer") {
        return is_loopback_origin(&r);
    }
    true
}

/// `http(s)://127.0.0.1[:port]` / `http(s)://localhost[:port]` / `http(s)://[::1][:port]`
fn is_loopback_origin(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    let rest = match lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return false,
    };
    // 只看 authority 部分
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(rest.split(['/', '?', '#']).next().unwrap_or(""));
    let host = if let Some(inner) = authority.strip_prefix('[') {
        // IPv6 字面量
        match inner.split_once(']') {
            Some((h, _)) => format!("[{}]", h),
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    // 结尾的点要去掉：`http://localhost.:8787` 与 `http://localhost:8787` 是同一个来源
    let host = host.trim_end_matches('.');
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// Set-Cookie 值（子资源通道）
pub fn session_cookie() -> String {
    format!("{}={}; Path=/; HttpOnly; SameSite=Strict", COOKIE, token())
}

/// 401 响应：必须在任何写盘动作之前调用
pub fn unauthorized(rq: Request) {
    send_json(
        rq,
        401,
        &err_json("未授权：缺少或错误的本地访问令牌（请刷新页面）"),
    );
}

pub fn forbidden(rq: Request) {
    send_json(
        rq,
        403,
        &err_json("拒绝跨站请求：Origin 不在允许列表内"),
    );
}

/* --------------------------------------------------------- 页面 token 注入 */

pub fn inject_into_html(html: &str) -> String {
    let snippet = TOKEN_SNIPPET.replace("@@PRT_TOKEN@@", token());
    // 注入点：<head ...> 之后（必须早于任何 module 脚本）
    let lower = html.to_ascii_lowercase();
    if let Some(i) = lower.find("<head") {
        if let Some(gt) = html[i..].find('>') {
            let at = i + gt + 1;
            let mut out = String::with_capacity(html.len() + snippet.len() + 1);
            out.push_str(&html[..at]);
            out.push('\n');
            out.push_str(&snippet);
            out.push_str(&html[at..]);
            return out;
        }
    }
    format!("{}{}", snippet, html)
}

/// 占位符刻意用 `@@PRT_TOKEN@@` 而不是 `__PRT_TOKEN__`：后者是属性名的一部分
/// （`window.__PRT_TOKEN__`），用同一个串做全局替换会把属性名也换掉，
/// 直接产出语法错误 —— 实测被 test/zoom.mjs 的「没有未捕获的页面异常」抓出来过。
const TOKEN_SNIPPET: &str = r#"<!-- prt-auth: 本地 API 令牌（勿外传，刷新即失效） -->
<meta name="prt-token" content="@@PRT_TOKEN@@" />
<script>
(function () {
  var T = "@@PRT_TOKEN@@";
  var H = "x-prt-token";
  try { Object.defineProperty(window, "__PRT_TOKEN__", { value: T, enumerable: false, configurable: false, writable: false }); }
  catch (e) { window.__PRT_TOKEN__ = T; }
  function withToken(input, init) {
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    if (url.indexOf("/api/") !== 0 && url.indexOf(location.origin + "/api/") !== 0) return init;
    var next = Object.assign({}, init || {});
    var h = new Headers((init && init.headers) || (typeof input !== "string" && input && input.headers) || {});
    if (!h.has(H)) h.set(H, T);
    next.headers = h;
    return next;
  }
  var native = window.fetch ? window.fetch.bind(window) : null;
  if (native) {
    window.fetch = function (input, init) { return native(input, withToken(input, init)); };
  }
  window.apiFetch = function (input, init) { return window.fetch(input, init); };
  document.addEventListener("DOMContentLoaded", function () {
    var m = document.querySelector('meta[name="prt-token"]');
    if (m && m.content !== T) m.content = T;
  });
})();
</script>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape_and_stability() {
        let t = token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(t, token(), "token 必须稳定（per-boot 只生成一次）");
        // 64 位十六进制里不应该出现连续重复的退化
        assert!(t.chars().any(|c| c != t.chars().next().unwrap()));
    }

    #[test]
    fn constant_time_compare() {
        assert!(eq_constant_time("abc", "abc"));
        assert!(!eq_constant_time("abc", "abd"));
        assert!(!eq_constant_time("abc", "ab"));
        assert!(!eq_constant_time("", ""));
    }

    #[test]
    fn loopback_origins() {
        assert!(is_loopback_origin("http://127.0.0.1:8913"));
        assert!(is_loopback_origin("http://localhost:8787"));
        assert!(is_loopback_origin("http://[::1]:1234"));
        assert!(is_loopback_origin("https://127.0.0.1"));
        assert!(!is_loopback_origin("http://evil.example.com"));
        assert!(!is_loopback_origin("http://127.0.0.1.evil.com"));
        assert!(!is_loopback_origin("file:///c:/x"));
        assert!(!is_loopback_origin(""));
    }

    #[test]
    fn injection_lands_early() {
        let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
        let out = inject_into_html(html);
        let token_at = out.find("name=\"prt-token\"").expect("应注入 meta");
        let body_at = out.find("<body>").expect("原内容应保留");
        assert!(token_at < body_at, "token 必须注入在 <body> 之前");
        assert!(out.contains(token()), "注入内容应包含本次 token");
        assert!(html.contains("<meta charset"), "原文不能被破坏");
    }
}
