// 论文阅读器 —— 独立 Windows 桌面壳
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

    // 顺手落一份到 data/paper-reader.log，GUI 模式下也有据可查
    let p = util::dirs().data.join("paper-reader.log");
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
        log_line("  📖  论文阅读器（桌面版）");
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
        log_line("  用法: 论文阅读器.exe [--console] [--port N]");
        log_line("      --console   挂上控制台并打印日志（不弹黑框是默认行为）");
        log_line("      --port N    从这个端口开始试（默认 8787，被占用就往后找）");
        log_line("");
        return;
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
    window::run(url);
}
