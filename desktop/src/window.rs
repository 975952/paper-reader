//! 原生窗口（tao + wry/WebView2）。
//!
//! 窗口**无边框**：系统那行标题栏（最小化 / 关闭按钮那一行）由页面自己画，
//! 几何与悬停反馈 1:1 照 VS Code 的自定义标题栏（见 public/index.html 的
//! `.window-controls` 与 public/js/app.js 的 `initWindowChrome()`）。
//! 页面上的按钮 / 拖动 / 八向缩放都通过 wry 的 IPC 发到这里，由 tao 执行系统动作。
//!
//! 窗口尺寸记在 data/window.json；关闭窗口直接结束进程（tao 的 run() 不会返回）。

use std::time::{Duration, Instant};

use serde_json::json;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::{ResizeDirection, WindowBuilder},
};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

use crate::icon_geometry;
use crate::store;
use crate::util::{self, is_external_url, open_in_browser};

const DEFAULT_W: f64 = 1400.0;
const DEFAULT_H: f64 = 900.0;
const MIN_W: f64 = 560.0;
const MIN_H: f64 = 400.0;

/* ------------------------------------------------------------ 窗口动作（页面 → 壳） */

/// 应用内标题栏发来的动作。页面侧构造：`{type:"minimize"|"maximize"|"close"|"drag"}`、
/// `{type:"resize", dir:"n"|"s"|"w"|"e"|"nw"|"ne"|"sw"|"se"}`。
#[derive(Debug, Clone, Copy)]
enum WindowAction {
    Drag,
    Resize(ResizeDirection),
    Minimize,
    Maximize,
    Close,
}

fn parse_action(msg: &str) -> Option<WindowAction> {
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    match v.get("type").and_then(|x| x.as_str())? {
        "drag" => Some(WindowAction::Drag),
        "minimize" => Some(WindowAction::Minimize),
        "maximize" => Some(WindowAction::Maximize),
        "close" => Some(WindowAction::Close),
        "resize" => {
            let dir = v.get("dir").and_then(|x| x.as_str())?;
            Some(WindowAction::Resize(match dir {
                "n" => ResizeDirection::North,
                "s" => ResizeDirection::South,
                "w" => ResizeDirection::West,
                "e" => ResizeDirection::East,
                "nw" => ResizeDirection::NorthWest,
                "ne" => ResizeDirection::NorthEast,
                "sw" => ResizeDirection::SouthWest,
                "se" => ResizeDirection::SouthEast,
                _ => return None,
            }))
        }
        _ => None,
    }
}

/// IPC 只接受**应用自己页面**发来的窗口动作。
///
/// 背景（外部评审指出的 P0）：这两个动作集直接落到操作系统 —— `close` 会退出进程，
/// `minimize`/`maximize` 会改窗口状态。而 wry 的 `with_ipc_handler` 默认对**任何**
/// 能在 WebView 里执行脚本的页面开放。应用自己的页面本来就在同一信任域，但
/// `data:` / `blob:` / `about:` 这类导航页面、以及将来任何漏网的同 WebView 文档，
/// 都不该有资格触发系统动作。所以按「同源才放行」收紧一格 —— 代价是零：
/// 自家页面恒满足。
///
/// 判据（任一不满足即拒绝）：
///   ① 来源非空 —— wry 把「发消息那一帧的 URL」放在 `Request.uri()`；拿不到就不放行，
///      宁可不响应也不猜（**注意**：若 wry 某次不再填这个字段，表现为按钮失效，
///      所以必须有「合法路径仍可用」的端到端回归，见 test/artifacts/phase1/shell-dom.mjs）
///   ② 必须是 http(s) —— `data:` / `blob:` / `about:` / `file:` 一律拒
///   ③ 必须与应用同源（沿用 `is_local_target` 的口径：origin 本身、或 origin + `/ ? #`）
fn ipc_sender_allowed(origin: &str, sender: &str) -> bool {
    if sender.is_empty() || origin.is_empty() { return false; }
    let lower = sender.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) { return false; }
    is_local_target(origin, sender)
}

/// 把「最大化 / 还原」状态推回页面：前端用它切图标（`body.window-maximized` + 两个 SVG）。
/// 只回推布尔值，不传任何用户数据。
fn push_window_state(webview: &wry::WebView, maximized: bool) {
    let js = format!(
        "window.__prtWindowState && window.__prtWindowState({{ maximized: {} }});",
        maximized
    );
    if let Err(e) = webview.evaluate_script(&js) {
        crate::log_line(&format!("[window] 回推窗口状态失败: {}", e));
    }
}

fn sane(v: Option<f64>, def: f64) -> f64 {
    match v {
        Some(f) if f.is_finite() && f >= 200.0 && f <= 20000.0 => f,
        _ => def,
    }
}

/// 记住的是"逻辑像素"，换显示器/改缩放都不会突然变小
fn load_size() -> (f64, f64) {
    let v = store::read_json("window.json", json!({}));
    (
        sane(v.get("width").and_then(|x| x.as_f64()), DEFAULT_W),
        sane(v.get("height").and_then(|x| x.as_f64()), DEFAULT_H),
    )
}

fn save_size(width: f64, height: f64) {
    let w = width.round().max(MIN_W) as u64;
    let h = height.round().max(MIN_H) as u64;
    store::write_json("window.json", &json!({ "width": w, "height": h }));
}

fn is_local_target(origin: &str, target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    lower == origin
        || lower.starts_with(&format!("{}/", origin))
        || lower.starts_with(&format!("{}?", origin))
        || lower.starts_with(&format!("{}#", origin))
}

fn is_panel_target(origin: &str, target: &str) -> bool {
    if !is_local_target(origin, target) { return false; }
    let lower = target.to_ascii_lowercase();
    let mode = lower.contains("window=panel") || lower.contains("window%3dpanel");
    let known = ["files", "outline", "notes", "relations", "translate", "chat"]
        .iter()
        .any(|id| lower.contains(&format!("panel={id}")) || lower.contains(&format!("panel%3d{id}")));
    mode && known
}

/// 所有 WebView 共用这套导航规则：本机页面留在应用里，外链交给系统浏览器；
/// 面板 URL 不再创建 Tao 顶层窗口，面板的展开由前端应用内卡片负责。
/// 另外挂上 IPC：应用内标题栏的窗口动作（拖动 / 缩放 / 最小化 / 最大化 / 关闭）从这里进来。
fn decorate_builder<'a>(
    builder: WebViewBuilder<'a>,
    origin: &str,
    proxy: EventLoopProxy<WindowAction>,
) -> WebViewBuilder<'a> {
    let origin_for_nav = origin.to_string();
    let origin_for_new = origin.to_string();
    let origin_for_ipc = origin.to_string();
    builder
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            /* P0：先校验来源，再解析动作。任何非应用同源页面（data:/blob:/about:、
               外站、不同端口的本地页面）发来的窗口动作一律拒绝并留日志。 */
            let sender = req.uri().to_string();
            if !ipc_sender_allowed(&origin_for_ipc, &sender) {
                crate::log_line(&format!(
                    "[window] 拒绝非应用页面的窗口动作（来源 {}）",
                    if sender.is_empty() { "(空)" } else { sender.as_str() }
                ));
                return;
            }
            let msg = req.body().as_str();
            match parse_action(msg) {
                Some(action) => {
                    // 必须回到事件循环线程再动窗口（tao 的窗口不是 Send）
                    if proxy.send_event(action).is_err() {
                        crate::log_line("[window] 事件循环已关闭，窗口动作被丢弃");
                    }
                }
                None => crate::log_line(&format!("[window] 收到无法解析的 IPC: {}", msg)),
            }
        })
        .with_navigation_handler(move |target| {
            let lower = target.to_ascii_lowercase();
            if is_local_target(&origin_for_nav, &target)
                || lower.starts_with("data:")
                || lower.starts_with("blob:")
                || lower.starts_with("about:")
            {
                return true;
            }
            if is_external_url(&target) {
                match open_in_browser(&target) {
                    Ok(()) => crate::log_line(&format!("[open] 导航被拦下，改用系统浏览器: {}", target)),
                    Err(e) => crate::log_line(&format!("[open] 打开失败: {} ({})", target, e)),
                }
            } else {
                crate::log_line(&format!("[open] 拦住了一次非 http(s) 导航: {}", target));
            }
            false
        })
        .with_new_window_req_handler(move |target, _features| {
            if is_panel_target(&origin_for_new, &target) {
                crate::log_line(&format!("[open] 面板窗口请求已拒绝：面板改为阅读器内部卡片: {}", target));
            } else if is_external_url(&target) {
                match open_in_browser(&target) {
                    Ok(()) => crate::log_line(&format!("[open] 新窗口请求 → 系统浏览器: {}", target)),
                    Err(e) => crate::log_line(&format!("[open] 打开失败: {} ({})", target, e)),
                }
            }
            NewWindowResponse::Deny
        })
}

/* ------------------------------------------------------------ 应用图标 */

/// 「P」的几何统一放在 src/icon_geometry.rs —— build.rs 生成 .ico 时 include 的是同一份，
/// 不会再出现「网页一个样、exe 一个样」。
/// 这里只负责把它交给 tao 当窗口（标题栏 / 任务栏）图标。
fn app_icon(size: u32) -> Option<tao::window::Icon> {
    tao::window::Icon::from_rgba(icon_geometry::render_icon_rgba(size), size, size).ok()
}

pub fn run(url: String) -> ! {
    let event_loop = EventLoopBuilder::<WindowAction>::with_user_event()
        .build();
    // 页面（WebView 里的 JS）不能直接碰窗口：它把动作 post 进事件循环，由这里执行。
    let proxy = event_loop.create_proxy();
    let (w, h) = load_size();

    // 本机服务的前缀，如 "http://127.0.0.1:8787"。只有以它开头的导航才算「应用自己」，
    // 其余一律当成外链丢给系统浏览器 —— 免得应用窗口被外站顶掉、又退不回来。
    let origin = url
        .split_once("://")
        .and_then(|(scheme, rest)| rest.find('/').map(|i| format!("{}://{}", scheme, &rest[..i])))
        .unwrap_or_else(|| url.clone())
        .to_ascii_lowercase();

    let window = match WindowBuilder::new()
        .with_title("论文阅读器")
        .with_window_icon(app_icon(64))
        .with_inner_size(LogicalSize::new(w, h))
        .with_min_inner_size(LogicalSize::new(MIN_W, MIN_H))
        /* 无边框：系统那行标题栏（最小化 / 关闭按钮那一行）不要了，改由页面画。
           用户口径 2026-10-04：「把最上面那一栏做成应用内部的，完全模仿 VS Code」。
           随之而来的三件事都在页面侧补齐（见 js/app.js 的 initWindowChrome()）：
          拖动（tao drag_window）、八向缩放（tao drag_resize_window）、三个按钮（IPC）。 */
        .with_decorations(false)
        .with_resizable(true)
        .with_maximizable(true)
        .build(&event_loop)
    {
        Ok(win) => win,
        Err(e) => {
            crate::log_line(&format!("[fatal] 创建窗口失败: {}", e));
            std::process::exit(3);
        }
    };

    // WebView2 的用户数据放在 data/webview2，保证"整个应用只用一个目录"
    let webview_dir = util::dirs().data.join("webview2");
    let _ = std::fs::create_dir_all(&webview_dir);
    let mut web_context = WebContext::new(Some(webview_dir));

    // 页面里的外链交给系统浏览器；面板 URL 由前端应用内卡片处理，不创建新的顶层窗口。
    let webview = decorate_builder(
        WebViewBuilder::new_with_web_context(&mut web_context).with_url(url.clone()),
        &origin,
        proxy,
    )
    .build(&window);

    let main_webview = match webview {
        Ok(v) => v,
        Err(e) => {
            crate::log_line(&format!("[fatal] WebView2 初始化失败: {}", e));
            crate::log_line("       请确认已安装 WebView2 运行时（Win10/11 一般自带）");
            std::process::exit(4);
        }
    };

    crate::log_line(&format!("[window] 已加载 {}", url));

    let main_id = window.id();
    let mut last_save = Instant::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or_else(Instant::now);
    let mut last_max = window.is_maximized();

    event_loop.run(move |event, _event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            /* 应用内标题栏发来的窗口动作 */
            Event::UserEvent(action) => {
                match action {
                    WindowAction::Drag => {
                        // 进入系统拖动循环（内部是 WM_NCLBUTTONDOWN/HTCAPTION），
                        // 按下的那一刻发过来最顺；失败只记日志，不影响别的事。
                        if let Err(e) = window.drag_window() {
                            crate::log_line(&format!("[window] 拖动窗口失败: {}", e));
                        }
                    }
                    WindowAction::Resize(dir) => {
                        if let Err(e) = window.drag_resize_window(dir) {
                            crate::log_line(&format!("[window] 缩放窗口失败: {}", e));
                        }
                    }
                    WindowAction::Minimize => window.set_minimized(true),
                    WindowAction::Maximize => window.set_maximized(!window.is_maximized()),
                    WindowAction::Close => {
                        let logical = window.inner_size().to_logical::<f64>(window.scale_factor());
                        save_size(logical.width, logical.height);
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                }
                // 动作可能改了最大化状态 → 回推给页面切图标
                let now = window.is_maximized();
                if now != last_max {
                    last_max = now;
                    push_window_state(&main_webview, now);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                window_id,
                ..
            } => {
                // 拖动过程中会疯狂触发，节流一下
                if window_id == main_id && last_save.elapsed() >= Duration::from_millis(700) {
                    last_save = Instant::now();
                    let logical = size.to_logical::<f64>(window.scale_factor());
                    save_size(logical.width, logical.height);
                }
                // 最大化 / 还原（含双击标题栏、Win+↑、系统菜单）也会走到这里
                if window_id == main_id {
                    let now = window.is_maximized();
                    if now != last_max {
                        last_max = now;
                        push_window_state(&main_webview, now);
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if window_id == main_id {
                    let logical = window.inner_size().to_logical::<f64>(window.scale_factor());
                    save_size(logical.width, logical.height);
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }

        // 这两者必须活到进程结束（run() 不会返回，这里只是显式保活）
        let _ = &main_webview;
        let _ = &web_context;
    });
}

/* ------------------------------------------------------------ 单元测试 */

/**
 * 这两组用例是 P0（IPC 来源限制）的**可复现证据**：桌面行为没法在当前环境自动化，
 * 但"谁能触发窗口动作"这条判据是纯函数，必须钉死 —— 判错一边就是安全洞
 * （放行了外站/非 http 页面），判错另一边就是功能坏（自家页面被拒 → 三个按钮全失效）。
 *
 * 跑法：`cd desktop && cargo test`（不依赖 GUI，也不需要 WebView2）。
 */
#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:8787";

    /// 应用自己的页面必须放行（否则窗口按钮全失效）
    #[test]
    fn ipc_allows_app_pages() {
        for ok in [
            "http://127.0.0.1:8787/",
            "http://127.0.0.1:8787/?topbar=static",
            "http://127.0.0.1:8787/index.html#x",
            "HTTP://127.0.0.1:8787/",           // 大小写不敏感
        ] {
            assert!(ipc_sender_allowed(ORIGIN, ok), "该放行却被拒: {ok}");
        }
    }

    /// 其余来源一律拒绝：非 http(s)、外站、同机不同端口、前缀相似但不是同一 origin
    #[test]
    fn ipc_rejects_foreign_and_non_http() {
        for bad in [
            "",
            r#"data:text/html,<script>window.ipc.postMessage('{"type":"close"}')</script>"#,
            "blob:http://127.0.0.1:8787/9c1f",
            "about:blank",
            "file:///C:/tmp/x.html",
            "http://example.com/",
            "http://127.0.0.1:8788/",           // 换端口 = 不同源
            "https://127.0.0.1:8787/",          // 换 scheme
            "http://127.0.0.1:87871/",          // 前缀像，但不是同一 origin
        ] {
            assert!(!ipc_sender_allowed(ORIGIN, bad), "不该放行: {bad}");
        }
        // 拿不到 origin（比如调用方传空）时也不放行：宁可不响应，也不猜
        assert!(!ipc_sender_allowed("", "http://127.0.0.1:8787/"));
    }

    /// 动作白名单：只认小写 type，resize 必须带合法 dir
    #[test]
    fn action_whitelist() {
        assert!(matches!(parse_action(r#"{"type":"minimize"}"#), Some(WindowAction::Minimize)));
        assert!(matches!(parse_action(r#"{"type":"maximize"}"#), Some(WindowAction::Maximize)));
        assert!(matches!(parse_action(r#"{"type":"close"}"#), Some(WindowAction::Close)));
        assert!(matches!(parse_action(r#"{"type":"drag"}"#), Some(WindowAction::Drag)));
        assert!(matches!(
            parse_action(r#"{"type":"resize","dir":"se"}"#),
            Some(WindowAction::Resize(ResizeDirection::SouthEast))
        ));
        for bad in [
            r#"{"type":"exec"}"#,                       // 未知动作
            r#"{"type":"resize"}"#,                     // 缺 dir
            r#"{"type":"resize","dir":"center"}"#,      // 非法方向
            r#"{"type":"CLOSE"}"#,                      // 大小写敏感：只认小写
            r#"not json"#,
            "",
        ] {
            assert!(parse_action(bad).is_none(), "不该解析: {bad}");
        }
    }
}
