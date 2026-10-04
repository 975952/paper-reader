//! `/api/chat`：把前端的请求转发到任意 OpenAI 兼容接口。
//!
//! 关键点：
//!   * 流式：上游收到多少就往下吐多少（绝不整体缓冲），HTTP/1.1 下走 chunked
//!   * 空闲超时：idleMs 内一个字节都没收到 → 给客户端补一条 SSE error 再收尾
//!   * 客户端断开：tiny_http 写失败后停止读取 body reader，reader 被 drop
//!     → ureq 的连接随之关闭，等于中止了上游请求
//!   * 上游非 2xx / 连不上：分别回同样的状态码 / 502，格式与 server.js 一致

use std::io::Read;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::Request;

use crate::api::{default_config, js_string, truthy, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_IDLE_MS};
use crate::server::{err_json, send_json, send_raw, send_sse, Ctx};
use crate::store;
use crate::util::normalize_chat_url;

/// 非流式响应最多读这么多（防止上游返回一个无底洞把内存吃光）
const MAX_NON_STREAM: u64 = 256 * 1024 * 1024;

fn tls_connector() -> Option<Arc<ureq::native_tls::TlsConnector>> {
    static C: OnceLock<Option<Arc<ureq::native_tls::TlsConnector>>> = OnceLock::new();
    C.get_or_init(|| {
        match ureq::native_tls::TlsConnector::new() {
            Ok(c) => Some(Arc::new(c)),
            Err(e) => {
                // 拿不到就退化成只能用 http:// 的接口（本机 Ollama 之类）
                store::log_line(&format!("[chat] native-tls 初始化失败，https 将不可用: {}", e));
                None
            }
        }
    })
    .clone()
}

pub fn handle(rq: Request, body: &[u8], _ctx: &Ctx) {
    /* ---------- 解析请求体 ---------- */
    let payload: Value = match crate::api::parse_json(body) {
        Ok(v) => v,
        Err(e) => return send_json(rq, 400, &err_json(&e)),
    };

    /* ---------- 取配置（缺省回落 data/config.json） ---------- */
    let stored = store::read_json("config.json", json!({}));
    let defaults = default_config();

    let pick = |key: &str, fallback_key: &str, def: &Value| -> Value {
        let from_payload = payload.get(key).filter(|v| truthy(v));
        if let Some(v) = from_payload {
            return v.clone();
        }
        let from_stored = stored.get(fallback_key).filter(|v| truthy(v));
        if let Some(v) = from_stored {
            return v.clone();
        }
        def.clone()
    };

    let base_url_raw = pick(
        "baseURL",
        "baseURL",
        defaults.get("baseURL").unwrap_or(&json!(DEFAULT_BASE_URL)),
    );
    let base_url = js_string(&base_url_raw);

    // Node: payload.apiKey !== undefined && payload.apiKey !== '' ? payload.apiKey : stored.apiKey || ''
    let api_key: Value = match payload.get("apiKey") {
        None => stored.get("apiKey").cloned().unwrap_or(json!("")),
        Some(Value::String(s)) if s.is_empty() => {
            stored.get("apiKey").cloned().unwrap_or(json!(""))
        }
        Some(v) => v.clone(),
    };

    let model = js_string(&pick(
        "model",
        "model",
        defaults.get("model").unwrap_or(&json!(DEFAULT_MODEL)),
    ));

    let url = match normalize_chat_url(&base_url) {
        Ok(u) => u,
        Err(e) => return send_json(rq, 400, &err_json(&e)),
    };

    let messages = match payload.get("messages") {
        Some(Value::Array(a)) if !a.is_empty() => Value::Array(a.clone()),
        _ => return send_json(rq, 400, &err_json("messages 不能为空")),
    };

    let stream = !matches!(payload.get("stream"), Some(Value::Bool(false)));

    let temperature = match payload.get("temperature") {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => defaults
            .get("temperature")
            .cloned()
            .unwrap_or(json!(DEFAULT_TEMPERATURE)),
    };

    let mut upstream_body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "temperature": temperature,
    });
    if let Some(mt) = payload.get("max_tokens") {
        if let Some(n) = mt.as_f64() {
            if n > 0.0 {
                if let Value::Object(m) = &mut upstream_body {
                    m.insert("max_tokens".into(), mt.clone());
                }
            }
        }
    }

    let idle_ms = stored
        .get("idleMs")
        .and_then(|v| v.as_f64())
        .filter(|f| *f > 0.0)
        .map(|f| f as u64)
        .unwrap_or(DEFAULT_IDLE_MS);

    /* ---------- 发起上游请求 ---------- */
    let mut builder = ureq::AgentBuilder::new()
        .timeout_read(Duration::from_millis(idle_ms))
        .timeout_connect(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(60));
    if let Some(c) = tls_connector() {
        builder = builder.tls_connector(c);
    }
    let agent = builder.build();

    let payload_str = serde_json::to_string(&upstream_body).unwrap_or_else(|_| "{}".to_string());

    let mut req = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("User-Agent", "paper-reader/1.0");
    if truthy(&api_key) {
        req = req.set("Authorization", &format!("Bearer {}", js_string(&api_key)));
    }

    let resp = match req.send_string(&payload_str) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let msg = extract_upstream_error(&text, code);
            return send_json(rq, code, &err_json(&msg));
        }
        Err(ureq::Error::Transport(t)) => {
            let reason = t
                .message()
                .map(|m| m.to_string())
                .unwrap_or_else(|| t.to_string());
            let msg = format!(
                "连接 {} 失败：{}。请检查 API 地址 / 网络 / 代理。",
                url, reason
            );
            return send_json(rq, 502, &err_json(&msg));
        }
    };

    /* ---------- 非流式：原样回传 ---------- */
    if !stream {
        let mut buf: Vec<u8> = Vec::new();
        let mut reader = resp.into_reader();
        if let Err(e) = reader.by_ref().take(MAX_NON_STREAM).read_to_end(&mut buf) {
            return send_json(
                rq,
                502,
                &err_json(&format!("读取上游响应失败：{}", e)),
            );
        }
        // Node 直接 res.end(text)：这里也只有 content-type 和 no-store
        return send_raw(
            rq,
            200,
            Some("application/json; charset=utf-8"),
            buf,
            &[("Cache-Control", "no-store")],
        );
    }

    /* ---------- 流式：边收边发 ---------- */
    // 上游可能忽略 stream:true 直接回普通 JSON（兼容网关、部分 Ollama 版本、代理错误页）。
    // 这时绝不能贴上 text/event-stream —— 前端会按 SSE 解析，一个 data: 行都没有，
    // 表现为「模型没有返回任何内容」的空白气泡。
    let upstream_ct = resp.header("Content-Type").unwrap_or("").to_string();
    if !upstream_ct.to_ascii_lowercase().contains("event-stream") {
        let mut buf: Vec<u8> = Vec::new();
        let mut reader = resp.into_reader();
        if let Err(e) = reader.by_ref().take(MAX_NON_STREAM).read_to_end(&mut buf) {
            return send_json(
                rq,
                502,
                &err_json(&format!("读取上游响应失败：{}", e)),
            );
        }
        let ct = if upstream_ct.trim().is_empty() {
            "application/json; charset=utf-8".to_string()
        } else {
            upstream_ct
        };
        return send_raw(
            rq,
            200,
            Some(&ct),
            buf,
            &[("Cache-Control", "no-store")],
        );
    }

    let reader = ChatStream::new(resp.into_reader(), idle_ms);
    send_sse(
        rq,
        &[
            ("Content-Type", "text/event-stream; charset=utf-8"),
            ("Cache-Control", "no-cache, no-transform"),
            ("X-Accel-Buffering", "no"),
        ],
        reader,
    );
}

/// 尽量取出上游的 `error.message`
fn extract_upstream_error(text: &str, status: u16) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let Some(m) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return m.to_string();
        }
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    if text.is_empty() {
        format!("上游返回 {}", status)
    } else {
        text.to_string()
    }
}

/// 直接包住 ureq 的响应体 reader：
///   * 正常：读到多少返回多少（tiny_http 一次 read 就发一个 chunk）
///   * 空闲超时 / 读失败：先吐一条 `data: {"error":...}` 再 EOF
struct ChatStream {
    inner: Box<dyn Read + Send + Sync + 'static>,
    pending: Vec<u8>,
    pending_pos: usize,
    idle_ms: u64,
    finished: bool,
}

impl ChatStream {
    fn new(inner: Box<dyn Read + Send + Sync + 'static>, idle_ms: u64) -> Self {
        ChatStream {
            inner,
            pending: Vec::new(),
            pending_pos: 0,
            idle_ms,
            finished: false,
        }
    }

    fn fail(&mut self, message: String) -> usize {
        self.finished = true;
        let line = format!("data: {}\n\n", json!({ "error": { "message": message } }));
        self.pending = line.into_bytes();
        self.pending_pos = 0;
        0
    }
}

impl Read for ChatStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        // 先把待发的错误行吐完
        if self.pending_pos < self.pending.len() {
            let n = std::cmp::min(buf.len(), self.pending.len() - self.pending_pos);
            buf[..n].copy_from_slice(&self.pending[self.pending_pos..self.pending_pos + n]);
            self.pending_pos += n;
            return Ok(n);
        }
        if self.finished {
            return Ok(0);
        }

        match self.inner.read(buf) {
            Ok(0) => {
                self.finished = true;
                Ok(0)
            }
            Ok(n) => Ok(n),
            Err(e) => {
                let msg = if is_timeout(&e) {
                    // 文案与 server.js:361 逐字一致（「任何」二字别丢）——
                    // 这句会经 data:{"error":…} 原样显示在聊天区，是用户可见契约（desktop/README.md D5）。
                    format!(
                        "上游超过 {} 秒没有返回任何数据",
                        (self.idle_ms as f64 / 1000.0).round() as u64
                    )
                } else {
                    format!("读取上游流失败：{}", e)
                };
                self.fail(msg);
                // 把刚准备好的错误行立刻交出去
                let n = std::cmp::min(buf.len(), self.pending.len());
                buf[..n].copy_from_slice(&self.pending[..n]);
                self.pending_pos = n;
                Ok(n)
            }
        }
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => true,
        _ => {
            let s = e.to_string().to_ascii_lowercase();
            s.contains("timed out") || s.contains("would block")
        }
    }
}
