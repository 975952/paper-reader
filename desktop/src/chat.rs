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
use crate::limits;
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

    let mut forbidden: Vec<String> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    if let Value::Object(m) = &payload {
        for k in m.keys() {
            if limits::is_chat_forbidden(k) {
                forbidden.push(k.clone());
            } else if !limits::is_chat_field(k) {
                unknown.push(k.clone());
            }
        }
    }
    if !forbidden.is_empty() {
        store::log_line(&format!(
            "[diag] /api/chat 请求体里的 {} 已忽略（只能来自 data/config.json）",
            forbidden.join(", ")
        ));
    }
    if !unknown.is_empty() {
        store::log_line(&format!("[diag] /api/chat 忽略未知字段: {}", unknown.join(", ")));
    }

    /* ---------- 取配置（**只**从 data/config.json 读，缺省用内置默认值） ---------- */
    let stored = store::read_json("config.json", json!({}));
    let defaults = default_config();

    let from_stored = |key: &str, def: &Value| -> Value {
        stored
            .get(key)
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| def.clone())
    };

    let base_url = js_string(&from_stored(
        "baseURL",
        defaults.get("baseURL").unwrap_or(&json!(DEFAULT_BASE_URL)),
    ));
    // Node: stored.apiKey || ''
    let api_key: Value = match stored.get("apiKey") {
        Some(v) if truthy(v) => v.clone(),
        _ => json!(""),
    };
    // 视觉模型：前端只传 useVision 标记，模型名仍只从本机 config 取（请求体里的 model 被忽略）。
    let wants_vision = matches!(payload.get("useVision"), Some(v) if truthy(v));
    let model = if wants_vision {
        match stored.get("visionModel").filter(|v| truthy(v)) {
            Some(v) => js_string(v),
            None => js_string(&from_stored(
                "model",
                defaults.get("model").unwrap_or(&json!(DEFAULT_MODEL)),
            )),
        }
    } else {
        js_string(&from_stored(
            "model",
            defaults.get("model").unwrap_or(&json!(DEFAULT_MODEL)),
        ))
    };

    let url = match normalize_chat_url(&base_url) {
        Ok(u) => u,
        Err(e) => return send_json(rq, 400, &err_json(&e)),
    };

    let messages = match payload.get("messages") {
        Some(Value::Array(a)) if !a.is_empty() => Value::Array(a.clone()),
        _ => return send_json(rq, 400, &err_json("messages 不能为空")),
    };

    // 向后兼容：payload 里显式给 false 才是非流式（和 Node 的 `!== false` 一致）
    let stream = !matches!(payload.get("stream"), Some(Value::Bool(false)));

    // temperature：必须落在 [0,2]，超范围 400（不静默改写用户请求）
    let temperature = match limits::pick_temperature(payload.get("temperature")) {
        Ok(Some(n)) => json!(n),
        Ok(None) => defaults
            .get("temperature")
            .cloned()
            .unwrap_or(json!(DEFAULT_TEMPERATURE)),
        Err(msg) => return send_json(rq, 400, &err_json(&msg)),
    };

    // max_tokens：正整数且在上限内
    let max_tokens = match limits::pick_max_tokens(payload.get("max_tokens")) {
        Ok(v) => v,
        Err(msg) => return send_json(rq, 400, &err_json(&msg)),
    };

    let mut upstream_body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "temperature": temperature,
    });
    if let Some(n) = max_tokens {
        if let Value::Object(m) = &mut upstream_body {
            m.insert("max_tokens".into(), json!(n));
        }
    }

    // A 线 P2.5：只读工具的受限透传（形状/大小校验，不合规 400；与 server.js 行为一致）
    let tools = match limits::pick_tools(payload.get("tools")) {
        Ok(v) => v,
        Err(msg) => return send_json(rq, 400, &err_json(&msg)),
    };
    let tool_choice = match limits::pick_tool_choice(payload.get("tool_choice"), tools.as_ref()) {
        Ok(v) => v,
        Err(msg) => return send_json(rq, 400, &err_json(&msg)),
    };
    if let (Some(tools), Value::Object(m)) = (tools, &mut upstream_body) {
        m.insert("tools".into(), tools);
        if let Some(choice) = tool_choice {
            m.insert("tool_choice".into(), choice);
        }
        if matches!(payload.get("parallel_tool_calls"), Some(Value::Bool(false))) {
            m.insert("parallel_tool_calls".into(), json!(false));
        }
    }

    // idleMs：请求体可以缩短看门狗，但同样夹在范围内；否则用已保存配置，再否则默认
    let idle_ms = payload
        .get("idleMs")
        .and_then(|v| v.as_f64())
        .map(|f| f.round() as i64)
        .map(|n| n.clamp(limits::IDLE_MS_MIN, limits::IDLE_MS_MAX))
        .or_else(|| {
            stored
                .get("idleMs")
                .and_then(|v| v.as_f64())
                .map(|f| (f.round() as i64).clamp(limits::IDLE_MS_MIN, limits::IDLE_MS_MAX))
        })
        .map(|n| n as u64)
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
            // 审计 §P2：不回显完整上游 URL 和底层网络异常原文，细节只进本地日志
            store::log_line(&format!("[diag] 连接上游失败 url={} err={}", url, reason));
            let msg = format!(
                "连接 API 地址失败：{}。请到设置页检查 API 地址 / 网络 / 代理。",
                limits::sanitize_message(&reason, "网络请求失败")
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
