// prt —— 独立 Windows 桌面壳
//
// 一个进程里同时跑：
//   * 后台线程里的本地 HTTP 服务（tiny_http，只监听 127.0.0.1）
//   * 主线程里的原生窗口（tao + wry/WebView2）
// 前端资源用 rust-embed 打进 exe，不需要 Node，也不需要打开浏览器。
//
// release 构建不弹黑框；需要看日志就加 `--console`。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod assets;
mod auth;
mod chat;
mod icon_geometry;
mod limits;
mod server;
mod store;
mod util;
mod window;

use std::io::Write;

/// 统一日志出口。
/// 注意：绝对不能用 eprintln!/println! —— GUI 子系统下标准句柄可能是空的，
/// 宏在写失败时会 panic，那就违背"任何异常都不该让进程退出"了。
pub fn log_line(msg: &str) {
    let mut err = std::io::stderr();
    let _ = writeln!(err, "{}", msg);
    let _ = err.flush();

    // 顺手落一份到 data/prt.log，GUI 模式下也有据可查
    let p = util::dirs().data.join("prt.log");
    if let Ok(md) = std::fs::metadata(&p) {
        if md.len() > 512 * 1024 {
            return;
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", msg);
    }
}

#[cfg(windows)]
fn attach_console() {
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    unsafe extern "system" {
        fn AttachConsole(dwProcessId: u32) -> i32;
        fn AllocConsole() -> i32;
    }
    // 有父控制台就挂上去，没有就自己开一个（GUI 子系统下默认是空的）
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            AllocConsole();
        }
    }
}

#[cfg(not(windows))]
fn attach_console() {}

/// 单实例守卫：同一个 data 目录只允许一个阅读器窗口。
///
/// 为什么需要：桌面壳把 WebView2 的用户数据目录固定放在 `data/webview2`。两个实例
/// 同时跑时会共用同一个用户数据目录（WebView2 不支持同 UDF 多进程），本地服务也会
/// 抢同一份 data/state，实测出现过「打开文档显示 Unexpected server response」这类
/// 偶发失败。用命名互斥体做守卫：进程退出（含崩溃）时系统自动释放，不需要清理。
#[cfg(windows)]
fn single_instance_allowed(data_dir: &std::path::Path) -> bool {
    use std::ffi::c_void;
    use std::hash::{Hash, Hasher};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(lpMutexAttributes: *mut c_void, bInitialOwner: i32, lpName: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> *mut c_void;
        fn ShowWindow(hWnd: *mut c_void, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hWnd: *mut c_void) -> i32;
    }

    // 自动化验收需要开第二实例时用这个环境变量显式放开。
    let allow_multi = std::env::var("PRT_ALLOW_MULTI_INSTANCE")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false);
    if allow_multi {
        return true;
    }

    // 互斥体名字跟 data 目录一一对应：隔离测试 / 多套数据目录互不影响。
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data_dir.to_string_lossy().to_lowercase().hash(&mut hasher);
    let mut name: Vec<u16> = format!("Local\\prt-{:016x}", hasher.finish())
        .encode_utf16()
        .collect();
    name.push(0);

    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle.is_null() {
        // 拿不到互斥体不该拦用户：记一笔，照常启动。
        log_line("[boot] 单实例互斥体创建失败，按普通模式继续");
        return true;
    }
    if unsafe { GetLastError() } != 183 {
        // ERROR_ALREADY_EXISTS = 183；句柄故意不关，跟进程一起活到退出。
        let _ = handle;
        return true;
    }

    // 已有实例：尽量把它的窗口提到前台（失败也无所谓）。
    unsafe {
        let title: Vec<u16> = "prt".encode_utf16().chain(std::iter::once(0)).collect();
        let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
        if !hwnd.is_null() {
            ShowWindow(hwnd, 9); // SW_RESTORE
            SetForegroundWindow(hwnd);
        }
    }
    log_line("[boot] 同一个 data 目录已有实例在运行，本次启动退出");
    false
}

#[cfg(not(windows))]
fn single_instance_allowed(_data_dir: &std::path::Path) -> bool {
    true
}

/// 第二个实例启动时给用户一句人话提示（后台 / 控制台模式不弹框）。
#[cfg(windows)]
fn notify_already_running() {
    use std::ffi::c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hWnd: *mut c_void, lpText: *const u16, lpCaption: *const u16, uType: u32) -> i32;
    }
    let text: Vec<u16> = concat!(
        "prt 已经在运行了。\n\n",
        "同一个数据目录使用一个 prt 进程。请切换到已经打开的 prt；\n",
        "要同时阅读多篇论文，请右键文档或标签，选择「在新窗口打开」。"
    )
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
    let caption: Vec<u16> = "prt".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x0000_0040);
    }
}

#[cfg(not(windows))]
fn notify_already_running() {}

fn parse_port(args: &[String]) -> Option<u16> {
    for (i, a) in args.iter().enumerate() {
        if let Some(v) = a.strip_prefix("--port=") {
            return v.trim().parse().ok();
        }
        if a == "--port" {
            if let Some(v) = args.get(i + 1) {
                return v.trim().parse().ok();
            }
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let want_help = args.iter().any(|a| a == "--help" || a == "-h");
    let console = want_help || args.iter().any(|a| a == "--console" || a == "-c");
    // 验收 / 自动化专用：窗口不显示、不抢焦点、不占任务栏。
    // 只影响「怎么开窗口」，不影响任何功能；用户双击启动的默认行为不变。
    let background = args.iter().any(|a| a == "--background")
        || std::env::var("PRT_BACKGROUND")
            .map(|v| {
                let v = v.trim().to_ascii_lowercase();
                v == "1" || v == "true" || v == "yes"
            })
            .unwrap_or(false);

    if console {
        // 必须在任何输出之前：Rust 的 stdout/stderr 句柄是首次使用时取的
        attach_console();
    }

    // 兜底：任何线程 panic 都只记一条日志，不打断进程
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("[panic] {}", info));
    }));

    let dirs = util::init_dirs();

    // 审计 §P0：per-boot 随机 token。必须在起 HTTP 服务之前生成，
    // 保证「注入页面的 token」和「校验用的 token」是同一个。
    auth::init();

    if console {
        log_line("");
        log_line("  📖  prt（桌面版）");
        log_line(&format!("      exe    : {}", dirs.exe.display()));
        log_line(&format!("      papers : {}", dirs.papers.display()));
        log_line(&format!("      data   : {}", dirs.data.display()));
        log_line(&format!("      内嵌前端文件: {} 个", assets::count()));
        // 绝不打印 token 本身
        log_line(&format!(
            "      API 令牌校验: {}",
            if auth::enforced() {
                "已启用（所有 /api/* 需带 X-PRT-Token）"
            } else {
                "已关闭（PRT_REQUIRE_TOKEN=0）"
            }
        ));
    }

    if want_help {
        log_line("");
        log_line("  用法: prt.exe [--console] [--background] [--port N]");
        log_line("      --console     挂上控制台并打印日志（不弹黑框是默认行为）");
        log_line("      --background  后台启动：不显示窗口、不抢焦点、不占任务栏（自动化验收用）");
        log_line("      --port N      从这个端口开始试（默认 8787，被占用就往后找）");
        log_line("");
        return;
    }

    // 单实例守卫：同一个 data 目录只允许一个窗口。第二个实例直接退出，
    // 免得两个进程抢同一份 data / WebView2 用户数据目录。
    if !single_instance_allowed(dirs.data.as_path()) {
        if !background && !console {
            notify_already_running();
        }
        return;
    }

    if background {
        log_line("[boot] 后台模式：窗口不显示、不抢焦点（自动化验收）");
    }

    if !assets::contains("index.html") {
        log_line("[warn] 没有内嵌 index.html，界面会是空白的");
    }

    // 认证默认开启，但要能一眼看出「有没有可用的 token 注入」，
    // 否则前端加载失败时只会看到一片 401、无从下手。
    if auth::enforced() {
        log_line("[boot] API 认证已启用；页面必须由本服务提供（token 由 index.html 注入）");
    }

    if let Some(line) = auth::token_announcement() {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{}", line);
        let _ = out.flush();
    }

    let start_port = parse_port(&args).unwrap_or(8787);
    let (port, _ctx) = match server::spawn(start_port) {
        Ok(v) => v,
        Err(e) => {
            log_line(&format!(
                "[fatal] 本地服务启动失败（端口 {} 起都不可用）: {}",
                start_port, e
            ));
            std::process::exit(2);
        }
    };

    let url = format!("http://127.0.0.1:{}/", port);
    if console {
        log_line(&format!("      地址   : {}", url));
        log_line("");
    } else {
        log_line(&format!("[boot] {} (papers={})", url, dirs.papers.display()));
    }

    // 主线程交给窗口；HTTP 在后台线程里，窗口关掉即整个进程结束
    window::run(url, background);
}
