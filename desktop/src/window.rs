//! 原生窗口（tao + wry/WebView2）。
//!
//! 窗口无边框：系统那行标题栏（最小化 / 关闭按钮那一行）由页面自己画，
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
    window::{Fullscreen, ResizeDirection, WindowBuilder},
};
#[cfg(windows)]
use tao::platform::windows::WindowBuilderExtWindows;
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
/// `{type:"resize", dir:"n"|"s"|"w"|"e"|"nw"|"ne"|"sw"|"se"}`、
/// `{type:"fullscreen", on?:boolean}`（不传 on 就切换；Esc 由页面发 on=false）。
#[derive(Debug, Clone, Copy)]
enum WindowAction {
    Drag,
    Resize(ResizeDirection),
    Minimize,
    Maximize,
    Fullscreen(Option<bool>),
    Close,
}

fn parse_action(msg: &str) -> Option<WindowAction> {
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    match v.get("type").and_then(|x| x.as_str())? {
        "drag" => Some(WindowAction::Drag),
        "minimize" => Some(WindowAction::Minimize),
        "maximize" => Some(WindowAction::Maximize),
        "fullscreen" => Some(WindowAction::Fullscreen(v.get("on").and_then(|x| x.as_bool()))),
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

fn ipc_sender_allowed(origin: &str, sender: &str) -> bool {
    if sender.is_empty() || origin.is_empty() { return false; }
    let lower = sender.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) { return false; }
    is_local_target(origin, sender)
}

/// 把「最大化 / 全屏」状态推回页面：前端用它切图标与沉浸式布局（`body.window-maximized` / `body.window-fullscreen`）。
/// 只回推布尔值，不传任何用户数据。
fn push_window_state(webview: &wry::WebView, maximized: bool, fullscreen: bool) {
    let js = format!(
        "window.__prtWindowState && window.__prtWindowState({{ maximized: {}, fullscreen: {} }});",
        maximized, fullscreen
    );
    if let Err(e) = webview.evaluate_script(&js) {
        crate::log_line(&format!("[window] 回推窗口状态失败: {}", e));
    }
}

/// 无边框全屏：盖住任务栏，退出后恢复原来的尺寸/位置（tao 负责还原）。
fn is_fullscreen(window: &tao::window::Window) -> bool {
    window.fullscreen().is_some()
}

fn set_fullscreen(window: &tao::window::Window, on: bool) {
    window.set_fullscreen(if on { Some(Fullscreen::Borderless(None)) } else { None });
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

pub fn run(url: String, background: bool) -> ! {
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

    /* --background：自动化验收专用。窗口创建为隐藏、不抢焦点、不占任务栏，
       验证脚本通过 HTTP / CDP 操作页面，用户屏幕上不会弹出任何东西。
       正常双击启动完全不受影响。 */
    let mut builder = WindowBuilder::new()
        .with_title("prt")
        .with_window_icon(app_icon(64))
        .with_inner_size(LogicalSize::new(w, h))
        .with_min_inner_size(LogicalSize::new(MIN_W, MIN_H))
        .with_decorations(false)
        .with_resizable(true)
        .with_maximizable(true);
    if background {
        builder = builder.with_visible(false).with_focused(false);
        #[cfg(windows)]
        {
            builder = builder.with_skip_taskbar(true);
        }
    }
    let window = match builder.build(&event_loop) {
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
        WebViewBuilder::new_with_web_context(&mut web_context)
            .with_hotkeys_zoom(true)
            .with_url(url.clone()),
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
    let mut last_full = is_fullscreen(&window);
    // 从「最大化」直接进全屏时，Windows 会留下任务栏位置的黑条 / 一圈白边；
    // 先进全屏前先还原窗口，退出全屏后再恢复最大化（用户实测的修复方式）。
    let mut fs_restore_max = false;

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
                    // 全屏：页面传 on 就按它执行（Esc 退出走这条），不传就切换。
                    WindowAction::Fullscreen(on) => {
                        let want = on.unwrap_or_else(|| !is_fullscreen(&window));
                        if want && !is_fullscreen(&window) {
                            fs_restore_max = window.is_maximized();
                            if fs_restore_max {
                                window.set_maximized(false);
                            }
                            set_fullscreen(&window, true);
                        } else if !want && is_fullscreen(&window) {
                            set_fullscreen(&window, false);
                            if fs_restore_max {
                                window.set_maximized(true);
                                fs_restore_max = false;
                            }
                        }
                    }
                    WindowAction::Close => {
                        let logical = window.inner_size().to_logical::<f64>(window.scale_factor());
                        // 全屏时的尺寸是屏幕尺寸，不能覆盖用户平时的窗口大小
                        if !is_fullscreen(&window) {
                            save_size(logical.width, logical.height);
                        }
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                }
                // 动作可能改了最大化 / 全屏状态 → 回推给页面切图标与沉浸式布局
                let now_max = window.is_maximized();
                let now_full = is_fullscreen(&window);
                if now_max != last_max || now_full != last_full {
                    last_max = now_max;
                    last_full = now_full;
                    push_window_state(&main_webview, now_max, now_full);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                window_id,
                ..
            } => {
                // 拖动过程中会疯狂触发，节流一下；全屏时别把屏幕尺寸写进 window.json
                if window_id == main_id && !is_fullscreen(&window) && last_save.elapsed() >= Duration::from_millis(700) {
                    last_save = Instant::now();
                    let logical = size.to_logical::<f64>(window.scale_factor());
                    save_size(logical.width, logical.height);
                }
                // 最大化 / 还原 / 全屏（含双击标题栏、Win+↑、系统菜单）也会走到这里
                if window_id == main_id {
                    let now_max = window.is_maximized();
                    let now_full = is_fullscreen(&window);
                    if now_max != last_max || now_full != last_full {
                        last_max = now_max;
                        last_full = now_full;
                        push_window_state(&main_webview, now_max, now_full);
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if window_id == main_id {
                    if !is_fullscreen(&window) {
                        let logical = window.inner_size().to_logical::<f64>(window.scale_factor());
                        save_size(logical.width, logical.height);
                    }
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
            parse_action(r#"{"type":"fullscreen"}"#),
            Some(WindowAction::Fullscreen(None))
        ));
        assert!(matches!(
            parse_action(r#"{"type":"fullscreen","on":false}"#),
            Some(WindowAction::Fullscreen(Some(false)))
        ));
        assert!(matches!(
            parse_action(r#"{"type":"fullscreen","on":true}"#),
            Some(WindowAction::Fullscreen(Some(true)))
        ));
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
