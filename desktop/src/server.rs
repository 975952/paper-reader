//! HTTP 服务：tiny_http + 与 server.js 一致的路由。
//!
//! 只监听 127.0.0.1；每个请求丢到一个独立线程里处理，
//! 这样 /api/chat 的长连接不会挡住 PDF 的分片读取。

use std::io::{Cursor, Read};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;

use serde_json::Value;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::api;
use crate::chat;
use crate::util::*;

/// 请求体上限，和 server.js 一致
pub const MAX_BODY: usize = 64 * 1024 * 1024;
/// 导入 PDF 用的上限（比普通请求大得多）
pub const MAX_UPLOAD: usize = 256 * 1024 * 1024;

pub struct Ctx {
    pub port: u16,
}

/* ------------------------------------------------------------- 启动服务 */

/// 从 `preferred` 开始找一个能绑上的端口，返回实际端口。
pub fn spawn(preferred: u16) -> std::io::Result<(u16, Arc<Ctx>)> {
    let mut listener = None;
    let mut last_err = None;
    for p in preferred..preferred.saturating_add(64) {
        match TcpListener::bind(("127.0.0.1", p)) {
            Ok(l) => {
                listener = Some((p, l));
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let (port, l) = match listener {
        Some(v) => v,
        None => {
            return Err(last_err.unwrap_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "没有可用端口")
            }))
        }
    };

    let server = Server::from_listener(l, None)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

    let ctx = Arc::new(Ctx { port });

    let ctx_bg = ctx.clone();
    thread::Builder::new()
        .name("paper-reader-http".to_string())
        .spawn(move || accept_loop(server, ctx_bg))?;

    Ok((port, ctx))
}

fn accept_loop(server: Server, ctx: Arc<Ctx>) {
    loop {
        // recv() 自己出问题也不能让线程死掉（除非 server 真的关了）
        let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| server.recv()));
        match got {
            Ok(Ok(rq)) => {
                let ctx = ctx.clone();
                // 每个请求一个线程：chat 的 SSE 会长期占住线程，不能串行
                let spawned = thread::Builder::new()
                    .name("paper-reader-req".to_string())
                    .spawn(move || {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            handle(rq, &ctx)
                        }));
                    });
                if spawned.is_err() {
                    crate::log_line("[server] 线程创建失败，降级为串行处理");
                }
            }
            Ok(Err(e)) => {
                crate::log_line(&format!("[server] recv 失败，停止接收：{}", e));
                break;
            }
            Err(_) => {
                crate::log_line("[server] recv 期间 panic，已忽略并继续");
            }
        }
    }
}

/* --------------------------------------------------------------- 路由 */

fn handle(mut rq: Request, ctx: &Ctx) {
    let method = rq.method().clone();
    let target = rq.url().to_string();
    let (raw_path, raw_query) = split_target(&target);

    // Node 是 decodeURIComponent(url.pathname)：先解码再匹配路由
    let path = match percent_decode(raw_path) {
        Some(p) => p,
        None => return send_text(rq, 400, "Bad path"),
    };
    if path.contains('\0') {
        return send_text(rq, 400, "Bad path");
    }

    // 非 GET/HEAD 一律先把 body 收干净（避免 keep-alive 连接错位）
    // 导入 PDF 的请求体可能是几十 MB，单独放宽
    let limit = if path == "/api/upload" { MAX_UPLOAD } else { MAX_BODY };
    let mut body: Vec<u8> = Vec::new();
    if !matches!(method, Method::Get | Method::Head) {
        match read_body(&mut rq, limit) {
            Ok(b) => body = b,
            Err(()) => {
                return send_json(
                    rq,
                    413,
                    &err_json(&format!("请求体过大（上限 {}MB）", limit / 1048576)),
                )
            }
        }
    }

    match path.as_str() {
        "/api/chat" => {
            if method != Method::Post {
                return send_text(rq, 405, "Method Not Allowed");
            }
            return chat::handle(rq, &body, ctx);
        }
        "/api/papers" => return api::papers(rq, ctx),
        "/api/pdf" => return api::pdf(rq, &raw_query, &method),
        "/api/upload" => return api::upload(rq, &method, &raw_query, &body),
        "/api/config" => return api::config(rq, &method, &body),
        "/api/state" => return api::state(rq, &method, &body),
        "/api/notes" => return api::notes(rq, &method, &raw_query, &body),
        "/api/session" => return api::session(rq, &method, &raw_query, &body),
        "/api/health" => return api::health(rq, ctx),
        "/api/ref-search" => return api::ref_search(rq, &raw_query),
        "/api/web-search" => return api::web_search(rq, &raw_query),
        "/api/open-url" => return api::open_url(rq, &raw_query),
        "/api/import-pdf" => return api::import_pdf(rq, &raw_query),
        _ => {}
    }

    // 静态资源
    if !matches!(method, Method::Get | Method::Head) {
        return send_text(rq, 405, "Method Not Allowed");
    }
    api::static_file(rq, &path);
}

/// 读请求体，超过上限返回 Err
pub fn read_body(rq: &mut Request, limit: usize) -> Result<Vec<u8>, ()> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut limited = rq.as_reader().take(limit as u64 + 1);
        if limited.read_to_end(&mut buf).is_err() {
            // 读失败不能 panic：当作空 body
            return Ok(Vec::new());
        }
    }
    if buf.len() > limit {
        return Err(());
    }
    Ok(buf)
}

/* ----------------------------------------------------------- 响应工具 */

pub fn push_header(headers: &mut Vec<Header>, k: &str, v: &str) {
    if let Ok(h) = Header::from_bytes(k.as_bytes().to_vec(), v.as_bytes().to_vec()) {
        headers.push(h);
    }
}

/// 定长响应。tiny_http 默认超过 32KB 就改用 chunked（会丢掉 Content-Length），
/// 这里把阈值顶到最大，保证和 server.js 一样总是带 Content-Length。
pub fn send_raw(
    rq: Request,
    status: u16,
    ctype: Option<&str>,
    body: Vec<u8>,
    extra: &[(&str, &str)],
) {
    let mut headers: Vec<Header> = Vec::new();
    if let Some(ct) = ctype {
        push_header(&mut headers, "Content-Type", ct);
    }
    for (k, v) in extra {
        push_header(&mut headers, k, v);
    }
    let len = body.len();
    let resp = Response::new(
        StatusCode(status),
        headers,
        Cursor::new(body),
        Some(len),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    let _ = rq.respond(resp);
}

pub fn send_json(rq: Request, status: u16, value: &Value) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    send_raw(
        rq,
        status,
        Some(MIME_JSON),
        body,
        &[("Cache-Control", "no-store")],
    );
}

pub fn send_text(rq: Request, status: u16, text: &str) {
    send_raw(
        rq,
        status,
        Some(MIME_TEXT),
        text.as_bytes().to_vec(),
        &[("Cache-Control", "no-store")],
    );
}

pub fn err_json(message: &str) -> Value {
    serde_json::json!({ "error": { "message": message } })
}

/// 把（已经限制好范围的）文件流发给客户端。
/// 读文件出错只会让这次响应中断，不会影响进程 —— io::copy 的错误被 tiny_http 吞掉/返回，
/// 我们这里也一并忽略。
pub fn send_reader<R: Read + Send + 'static>(
    rq: Request,
    status: u16,
    ctype: &str,
    extra: &[(&str, &str)],
    reader: R,
    len: usize,
) {
    let mut headers: Vec<Header> = Vec::new();
    push_header(&mut headers, "Content-Type", ctype);
    for (k, v) in extra {
        push_header(&mut headers, k, v);
    }
    let resp = Response::new(StatusCode(status), headers, reader, Some(len), None)
        .with_chunked_threshold(usize::MAX);
    let _ = rq.respond(resp);
}

/// 流式响应（SSE 专用）。
///
/// 为什么要绕开 `Response`：tiny_http 给每条连接套的是
/// `BufWriter::with_capacity(1024, socket)`，而且这个 BufWriter 由整条连接共享，
/// `Response::raw_print` 最后才 flush 一次 —— 意味着小于 1KB 的 SSE 片段会被
/// 攒到响应结束才发出去，"流式"就变成了"整体缓冲"。
///
/// 所以这里拿 `into_writer()` 自己写状态行 + 头，然后**每个片段都显式 flush**。
/// 分块编码（chunked）由我们自己拼，保证和 Node 版行为一致。
pub fn send_sse<R: Read>(rq: Request, extra: &[(&str, &str)], mut reader: R) {
    use std::io::Write;

    let version = rq.http_version().clone();
    let chunked = (version.0, version.1) > (1, 0);

    let mut w = rq.into_writer();

    let mut head = String::with_capacity(256);
    head.push_str(&format!(
        "HTTP/{}.{} 200 OK\r\n",
        version.0, version.1
    ));
    for (k, v) in extra {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    if chunked {
        head.push_str("Transfer-Encoding: chunked\r\n");
        head.push_str("Connection: keep-alive\r\n");
    } else {
        // HTTP/1.0 不支持 chunked：不写长度，靠关闭连接表示结束
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");

    if w.write_all(head.as_bytes()).is_err() || w.flush().is_err() {
        return; // 客户端已经走了
    }

    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let ok = if chunked {
            // 一片一个 chunk，写完立刻 flush —— 这一步是"真流式"的关键
            w.write_all(format!("{:X}\r\n", n).as_bytes()).is_ok()
                && w.write_all(&buf[..n]).is_ok()
                && w.write_all(b"\r\n").is_ok()
                && w.flush().is_ok()
        } else {
            w.write_all(&buf[..n]).is_ok() && w.flush().is_ok()
        };
        if !ok {
            // 客户端断开：直接返回，reader 被 drop → 上游连接随之关闭
            break;
        }
    }

    if chunked {
        let _ = w.write_all(b"0\r\n\r\n");
    }
    let _ = w.flush();
    // 显式 drop：释放 SequentialWriter，让同一连接上的下一个响应能开始写
    drop(w);
}
