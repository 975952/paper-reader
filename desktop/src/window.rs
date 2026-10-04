//! 原生窗口（tao + wry/WebView2）。
//!
//! 窗口尺寸记在 data/window.json；关闭窗口直接结束进程（tao 的 run() 不会返回）。

use std::time::{Duration, Instant};

use serde_json::json;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

use crate::icon_geometry;
use crate::store;
use crate::util::{self, is_external_url, open_in_browser};

const DEFAULT_W: f64 = 1400.0;
const DEFAULT_H: f64 = 900.0;
const MIN_W: f64 = 560.0;
const MIN_H: f64 = 400.0;

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
fn decorate_builder<'a>(
    builder: WebViewBuilder<'a>,
    origin: &str,
) -> WebViewBuilder<'a> {
    let origin_for_nav = origin.to_string();
    let origin_for_new = origin.to_string();
    builder
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
    let event_loop = EventLoopBuilder::<()>::with_user_event()
        .build();
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

    event_loop.run(move |event, _event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
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
