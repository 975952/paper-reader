//! 原生窗口（tao + wry/WebView2）。
//!
//! 窗口无边框：系统那行标题栏（最小化 / 关闭按钮那一行）由页面自己画，
//! 几何与悬停反馈 1:1 照 VS Code 的自定义标题栏（见 public/index.html 的
//! `.window-controls` 与 public/js/app.js 的 `initWindowChrome()`）。
//! 页面上的按钮 / 拖动 / 八向缩放都通过 wry 的 IPC 发到这里，由 tao 执行系统动作。
//!
//! 窗口尺寸记在 data/window.json；关闭窗口直接结束进程（tao 的 run() 不会返回）。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::json;
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget},
    window::{Fullscreen, ResizeDirection, WindowBuilder, WindowId, Window},
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
#[derive(Debug, Clone)]
enum WindowAction {
    Drag,
    Resize(ResizeDirection),
    Minimize,
    Maximize,
    Fullscreen(Option<bool>),
    Close,
    CommitClose,
    CancelClose,
    Open { key: String, doc: String, request: String },
    CancelOpen(String),
    Ready { doc: String, title: String },
    Focus(String),
    Tile,
    Place { x: i32, y: i32, width: u32, height: u32 },
    List,
    Quit,
}

#[derive(Debug, Clone)]
struct WindowMessage { source: WindowId, action: WindowAction }

fn valid_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn parse_action(msg: &str) -> Option<WindowAction> {
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    match v.get("type").and_then(|x| x.as_str())? {
        "drag" => Some(WindowAction::Drag),
        "minimize" => Some(WindowAction::Minimize),
        "maximize" => Some(WindowAction::Maximize),
        "fullscreen" => Some(WindowAction::Fullscreen(v.get("on").and_then(|x| x.as_bool()))),
        "close" => Some(WindowAction::Close),
        "close-commit" => Some(WindowAction::CommitClose),
        "close-cancel" => Some(WindowAction::CancelClose),
        "windows-list" => Some(WindowAction::List),
        "windows-tile" => Some(WindowAction::Tile),
        "window-place" => Some(WindowAction::Place {
            x: i32::try_from(v.get("x")?.as_i64()?).ok()?,
            y: i32::try_from(v.get("y")?.as_i64()?).ok()?,
            width: u32::try_from(v.get("width")?.as_u64()?).ok()?.clamp(400, 20000),
            height: u32::try_from(v.get("height")?.as_u64()?).ok()?.clamp(300, 20000),
        }),
        "windows-quit" => Some(WindowAction::Quit),
        "window-open-cancel" => Some(WindowAction::CancelOpen(v.get("request")?.as_str()?.to_string())),
        "window-focus" => Some(WindowAction::Focus(v.get("key")?.as_str()?.to_string())),
        "window-ready" => Some(WindowAction::Ready {
            doc: v.get("doc").and_then(|x| x.as_str()).unwrap_or("").chars().take(1000).collect(),
            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("prt").chars().take(300).collect(),
        }),
        "window-open" => {
            let key = v.get("key")?.as_str()?;
            let doc = v.get("doc")?.as_str()?;
            let request = v.get("request")?.as_str()?;
            if !valid_key(key) || doc.is_empty() || doc.len() > 4000 || !valid_key(request) { return None; }
            Some(WindowAction::Open { key: key.into(), doc: doc.into(), request: request.into() })
        },
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
    proxy: EventLoopProxy<WindowMessage>,
    source: WindowId,
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
                    if proxy.send_event(WindowMessage { source, action }).is_err() {
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

// Each webview owns its JS state; the service and authentication stay in one process.
struct ReaderWindow {
    webview: wry::WebView,
    window: Window,
    key: String,
    doc: String,
    title: String,
    closing: bool,
    restore_max: bool,
    pending: Option<(WindowId, String, String)>,
}

fn emit(reader: &ReaderWindow, value: serde_json::Value) {
    let _ = reader.webview.evaluate_script(&format!(
        "window.dispatchEvent(new CustomEvent('prt-desktop', {{detail:{value}}}));"
    ));
}

fn create_reader(
    target: &EventLoopWindowTarget<WindowMessage>, context: &mut WebContext,
    proxy: EventLoopProxy<WindowMessage>, base: &str, origin: &str,
    key: &str, doc: &str, geometry: &serde_json::Value, background: bool,
) -> Result<ReaderWindow, String> {
    let (w, h) = load_size();
    let mut builder = WindowBuilder::new().with_title("prt")
        .with_window_icon(app_icon(64))
        .with_inner_size(LogicalSize::new(
            sane(geometry.get("width").and_then(|x| x.as_f64()), w),
            sane(geometry.get("height").and_then(|x| x.as_f64()), h)))
        .with_min_inner_size(LogicalSize::new(MIN_W, MIN_H))
        .with_decorations(false).with_resizable(true).with_maximizable(true);
    if background {
        builder = builder.with_visible(false).with_focused(false);
        #[cfg(windows)] { builder = builder.with_skip_taskbar(true); }
    }
    let window = builder.build(target).map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (geometry["x"].as_i64(), geometry["y"].as_i64()) {
        // A disconnected monitor must never strand a restored window off-screen.
        if window.available_monitors().any(|m| {
            let p = m.position(); let s = m.size();
            x >= p.x as i64 && y >= p.y as i64
                && x + 100 < p.x as i64 + s.width as i64 && y + 80 < p.y as i64 + s.height as i64
        }) { window.set_outer_position(PhysicalPosition::new(x as i32, y as i32)); }
    }
    let mut url = url::Url::parse(base).map_err(|e| e.to_string())?;
    if !doc.is_empty() { url.query_pairs_mut().append_pair("document", doc); }
    let init = format!("window.__PRT_WINDOW_ID = {};", json!(key));
    let webview = decorate_builder(
        WebViewBuilder::new_with_web_context(context).with_hotkeys_zoom(true)
            .with_url(url.as_str()).with_initialization_script(&init),
        origin, proxy, window.id(),
    ).build(&window).map_err(|e| e.to_string())?;
    if geometry["maximized"].as_bool() == Some(true) { window.set_maximized(true); }
    Ok(ReaderWindow { webview, window, key: key.into(), doc: doc.into(), title: "prt".into(),
        closing: false, restore_max: false, pending: None })
}

fn save_windows(windows: &HashMap<WindowId, ReaderWindow>) {
    let mut rows: Vec<_> = windows.values().map(|r| {
        let size = r.window.inner_size().to_logical::<f64>(r.window.scale_factor());
        let pos = r.window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let normal = !r.window.is_maximized() && !is_fullscreen(&r.window);
        json!({"key":r.key, "x":pos.x, "y":pos.y,
            "width":if normal {size.width} else {DEFAULT_W},
            "height":if normal {size.height} else {DEFAULT_H},
            "maximized":r.window.is_maximized()})
    }).collect();
    rows.sort_by_key(|r| r["key"].as_str().unwrap_or("").to_string());
    store::write_json("reader-windows.json", &json!({"windows":rows}));
}

fn request_close(reader: &mut ReaderWindow) {
    if reader.closing { return; }
    reader.closing = true;
    emit(reader, json!({"type":"close-request"}));
}

pub fn run(url: String, background: bool) -> ! {
    let event_loop = EventLoopBuilder::<WindowMessage>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let origin = url::Url::parse(&url).expect("local service URL").origin().ascii_serialization().to_ascii_lowercase();
    let webview_dir = util::dirs().data.join("webview2");
    let _ = std::fs::create_dir_all(&webview_dir);
    let mut context = WebContext::new(Some(webview_dir));
    let saved = store::read_json("reader-windows.json", json!({}));
    let mut rows = saved["windows"].as_array().cloned().unwrap_or_default();
    rows.retain(|r| r["key"].as_str().map(valid_key).unwrap_or(false));
    rows.truncate(10);
    if rows.is_empty() { rows.push(json!({"key":"main"})); }
    let mut windows = HashMap::new();
    for row in rows {
        let key = row["key"].as_str().unwrap_or("main");
        if windows.values().any(|r: &ReaderWindow| r.key == key) { continue; }
        match create_reader(&event_loop, &mut context, proxy.clone(), &url, &origin, key, "", &row, background) {
            Ok(r) => { windows.insert(r.window.id(), r); },
            Err(e) => crate::log_line(&format!("[window] 创建窗口失败: {e}")),
        }
    }
    if windows.is_empty() { std::process::exit(4); }
    let mut last_save = Instant::now();
    let mut quitting = false;
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(WindowMessage { source, action }) => {
                if !windows.contains_key(&source) { return; }
                match action {
                    WindowAction::CancelOpen(request) => {
                        windows.retain(|_, r| !r.pending.as_ref().map(|(parent, req, _)| *parent == source && *req == request).unwrap_or(false));
                        save_windows(&windows);
                    },
                    WindowAction::Open { key, doc, request } => {
                        let result = if windows.len() >= 10 {
                            Err("最多同时打开 10 个窗口".to_string())
                        } else if windows.values().any(|r| r.key == key) {
                            Err("窗口标识重复，请重试".to_string())
                        } else {
                            create_reader(target, &mut context, proxy.clone(), &url, &origin, &key, &doc, &json!({}), background)
                        };
                        match result {
                            Ok(mut r) => {
                                r.pending = Some((source, request, doc));
                                windows.insert(r.window.id(), r);
                                save_windows(&windows);
                            },
                            Err(error) => emit(&windows[&source], json!({"type":"open-result","request":request,"ok":false,"error":error})),
                        }
                    },
                    WindowAction::Ready { doc, title } => {
                        let r = windows.get_mut(&source).unwrap();
                        r.doc = doc.clone(); r.title = title;
                        r.window.set_title(&format!("{} · prt", r.title));
                        let mut failed = false;
                        if let Some((parent, request, wanted)) = r.pending.take() {
                            failed = doc != wanted;
                            if let Some(p) = windows.get(&parent) {
                                emit(p, json!({"type":"open-result","request":request,"ok":doc == wanted,
                                    "error":"文档未能加载，原标签已保留"}));
                            }
                        }
                        if failed { windows.remove(&source); save_windows(&windows); }
                        let rows: Vec<_> = windows.values().map(|r| json!({"key":r.key,"title":r.title})).collect();
                        for r in windows.values() { emit(r, json!({"type":"windows","windows":rows})); }
                    },
                    WindowAction::List => {
                        let rows: Vec<_> = windows.values().map(|r| json!({"key":r.key,"title":r.title})).collect();
                        emit(&windows[&source], json!({"type":"windows","windows":rows}));
                    },
                    WindowAction::Focus(key) => {
                        if let Some(r) = windows.values().find(|r| r.key == key) {
                            if !background { r.window.set_minimized(false); r.window.set_focus(); }
                        }
                    },
                    WindowAction::Place { x, y, width, height } => {
                        let r = &windows[&source];
                        set_fullscreen(&r.window, false); r.window.set_maximized(false);
                        if !background { r.window.set_minimized(false); }
                        r.window.set_outer_position(PhysicalPosition::new(x, y));
                        r.window.set_inner_size(PhysicalSize::new(width, height));
                        emit(r, json!({"type":"placed"}));
                    },
                    WindowAction::Tile => {
                        if let Some(m) = windows[&source].window.current_monitor() {
                            let p = m.position(); let s = m.size();
                            let count = windows.len() as u32;
                            let cols = if count <= 3 { count } else { (count as f64).sqrt().ceil() as u32 };
                            let rows = (count + cols - 1) / cols;
                            let mut ordered: Vec<_> = windows.values().collect();
                            ordered.sort_by_key(|r| &r.key);
                            for (i, r) in ordered.iter().enumerate() {
                                let w = s.width / cols; let h = s.height.saturating_sub(48) / rows;
                                emit(r, json!({"type":"place", "x":p.x + (i as u32 % cols * w) as i32,
                                    "y":p.y + (i as u32 / cols * h) as i32, "width":w, "height":h}));
                            }
                            save_windows(&windows);
                        }
                    },
                    WindowAction::Quit => {
                        save_windows(&windows); quitting = true;
                        for r in windows.values_mut() { request_close(r); }
                    },
                    WindowAction::CommitClose => {
                        if !windows[&source].closing { return; }
                        if windows.len() == 1 && !quitting { save_windows(&windows); }
                        windows.remove(&source);
                        if windows.is_empty() { *control_flow = ControlFlow::Exit; }
                        else if !quitting { save_windows(&windows); }
                    },
                    WindowAction::CancelClose => {
                        windows.get_mut(&source).unwrap().closing = false; quitting = false;
                    },
                    other => {
                        let r = windows.get_mut(&source).unwrap();
                        match other {
                            WindowAction::Drag => { let _ = r.window.drag_window(); },
                            WindowAction::Resize(dir) => { let _ = r.window.drag_resize_window(dir); },
                            WindowAction::Minimize => r.window.set_minimized(true),
                            WindowAction::Maximize => r.window.set_maximized(!r.window.is_maximized()),
                            WindowAction::Close => request_close(r),
                            WindowAction::Fullscreen(on) => {
                                let want = on.unwrap_or_else(|| !is_fullscreen(&r.window));
                                if want && !is_fullscreen(&r.window) {
                                    r.restore_max = r.window.is_maximized();
                                    if r.restore_max { r.window.set_maximized(false); }
                                    set_fullscreen(&r.window, true);
                                } else if !want && is_fullscreen(&r.window) {
                                    set_fullscreen(&r.window, false);
                                    if r.restore_max { r.window.set_maximized(true); r.restore_max = false; }
                                }
                            },
                            _ => {},
                        }
                        push_window_state(&r.webview, r.window.is_maximized(), is_fullscreen(&r.window));
                    },
                }
            },
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                if let Some(r) = windows.get_mut(&window_id) { request_close(r); }
            },
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. }
            | Event::WindowEvent { window_id, event: WindowEvent::Moved(_), .. } => {
                if let Some(r) = windows.get(&window_id) {
                    push_window_state(&r.webview, r.window.is_maximized(), is_fullscreen(&r.window));
                }
                if !quitting && last_save.elapsed() > Duration::from_millis(700) {
                    save_windows(&windows); last_save = Instant::now();
                }
            },
            _ => {},
        }
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
