//! 本地 HTTP 接口：静态资源 + papers / pdf / config / state / notes / health。
//!
//! 每个处理函数的返回体、状态码、字段名都和 server.js 一一对应，
//! 因为前端 public/js/*.js 已经按那个契约写死了。

use std::fs::File;
use std::io::{empty, Read, Seek, SeekFrom};
use std::time::UNIX_EPOCH;

use serde_json::{json, Map, Value};
use tiny_http::{Method, Request};

use crate::assets;
use crate::auth;
use crate::limits;
use crate::server::{err_json, send_html, send_json, send_raw, send_reader, send_text, Ctx};
use crate::store;
use crate::util::*;

/// 诊断模式（审计 §P2）：只有显式 `PRT_DIAGNOSTICS=1` 才在接口里返回本机绝对路径。
/// 测试 harness 需要它来做「隔离目录」安全断言（test/_env.mjs 的
/// assertIsolatedDataDir(resolveDataDir(papers.dir))），所以它们 spawn 服务时要带上。
fn diagnostics() -> bool {
    match std::env::var("PRT_DIAGNOSTICS") {
        Ok(v) => v.trim() == "1",
        Err(_) => false,
    }
}

/* --------------------------------------------------------------- health */

pub fn health(rq: Request, ctx: &Ctx) {
    send_json(rq, 200, &json!({ "ok": true, "port": ctx.port }));
}

/* --------------------------------------------------------------- papers */

pub fn papers(rq: Request, _ctx: &Ctx) {
    let dir = &dirs().papers;
    let mut out: Vec<Value> = Vec::new();

    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.to_ascii_lowercase().ends_with(".pdf") {
                continue;
            }
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !md.is_file() {
                continue;
            }
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(json!({
                "name": name,
                "size": md.len(),
                "mtime": mtime,
                "docId": doc_id_of(&name),
                "url": format!("/api/pdf?name={}", encode_uri_component(&name)),
            }));
        }
    }

    // mtime 倒序（server.js: b.mtime - a.mtime）
    out.sort_by(|a, b| {
        let am = a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let bm = b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        bm.cmp(&am)
    });

    // 审计 §P2：默认不返回本机绝对路径；只有显式开启诊断才给
    let mut payload = Map::new();
    payload.insert("papers".to_string(), Value::Array(out));
    if diagnostics() {
        payload.insert(
            "dir".to_string(),
            Value::String(dir.to_string_lossy().to_string()),
        );
    }
    send_json(rq, 200, &Value::Object(payload));
}

/* ------------------------------------------------------------------ pdf */

enum RangeSpec {
    /// 没带 Range（或格式不认识）→ 整文件 200
    None,
    /// 可满足的区间
    Ok(u64, u64),
    /// 416
    Bad,
}

/// 完全按 server.js 的 `/bytes=(\d*)-(\d*)/` + 后续夹取逻辑实现
fn parse_range(header: &str, total: u64) -> RangeSpec {
    let bytes = header.as_bytes();
    let pos = match header.find("bytes=") {
        Some(i) => i + 6,
        None => return RangeSpec::None,
    };
    let rest = &header[pos..];
    let rb = rest.as_bytes();

    let mut i = 0usize;
    while i < rb.len() && rb[i].is_ascii_digit() {
        i += 1;
    }
    let m1 = &rest[..i];

    if i >= rb.len() || rb[i] != b'-' {
        return RangeSpec::None; // 正则不匹配 → 当作没有 Range
    }
    i += 1;
    let d2 = i;
    while i < rb.len() && rb[i].is_ascii_digit() {
        i += 1;
    }
    let m2 = &rest[d2..i];
    let _ = bytes;

    let total_i: i64 = if total > i64::MAX as u64 {
        i64::MAX
    } else {
        total as i64
    };

    let (start, end): (i64, i64);
    if m1.is_empty() {
        // 后缀区间 bytes=-N
        let n: i64 = m2.parse().unwrap_or(0);
        if n == 0 {
            return RangeSpec::Bad;
        }
        start = (total_i - n).max(0);
        end = total_i - 1;
    } else {
        start = m1.parse().unwrap_or(i64::MAX); // 溢出按"超大"处理 → 416
        end = if m2.is_empty() {
            total_i - 1
        } else {
            m2.parse().unwrap_or(i64::MAX)
        };
    }

    let mut start = start;
    let mut end = end;
    if start < 0 {
        start = 0;
    }
    if end >= total_i {
        end = total_i - 1;
    }
    if start > end || start >= total_i {
        return RangeSpec::Bad;
    }
    RangeSpec::Ok(start as u64, end as u64)
}

// tiny_http 的 equiv() 只接受 &'static str，所以这里固定用字面量
fn header_of(rq: &Request, name: &'static str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

pub fn pdf(rq: Request, raw_query: &str, method: &Method) {
    let name = query_get(raw_query, "name").unwrap_or_default();
    let abs = match safe_join(&dirs().papers, &name) {
        Some(p) => p,
        None => return send_text(rq, 400, "非法文件名"),
    };

    let md = match std::fs::metadata(&abs) {
        Ok(m) if m.is_file() => m,
        _ => return send_text(rq, 404, "PDF 不存在"),
    };
    let total = md.len();
    let is_head = *method == Method::Head;

    let range = header_of(&rq, "range");

    match range.as_deref().map(|r| parse_range(r, total)) {
        Some(RangeSpec::Ok(start, end)) => {
            let len = end - start + 1;
            let content_range = format!("bytes {}-{}/{}", start, end, total);
            let extra: [(&str, &str); 3] = [
                ("Accept-Ranges", "bytes"),
                ("Cache-Control", "no-cache"),
                ("Content-Range", content_range.as_str()),
            ];

            if is_head {
                return send_reader(rq, 206, "application/pdf", &extra, empty(), len as usize);
            }
            match File::open(&abs).and_then(|mut f| {
                f.seek(SeekFrom::Start(start))?;
                Ok(f)
            }) {
                Ok(f) => send_reader(rq, 206, "application/pdf", &extra, f.take(len), len as usize),
                Err(e) => {
                    store::log_line(&format!("[pdf] 打开失败 {:?}: {}", abs, e));
                    send_text(rq, 404, "PDF 不存在");
                }
            }
        }
        Some(RangeSpec::Bad) => {
            let cr = format!("bytes */{}", total);
            send_raw(rq, 416, None, Vec::new(), &[("Content-Range", cr.as_str())]);
        }
        _ => {
            let extra: [(&str, &str); 2] =
                [("Accept-Ranges", "bytes"), ("Cache-Control", "no-cache")];
            if is_head {
                return send_reader(
                    rq,
                    200,
                    "application/pdf",
                    &extra,
                    empty(),
                    total as usize,
                );
            }
            match File::open(&abs) {
                Ok(f) => send_reader(
                    rq,
                    200,
                    "application/pdf",
                    &extra,
                    f.take(total),
                    total as usize,
                ),
                Err(e) => {
                    store::log_line(&format!("[pdf] 打开失败 {:?}: {}", abs, e));
                    send_text(rq, 404, "PDF 不存在");
                }
            }
        }
    }
}

/* --------------------------------------------------------------- 配置 */

pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
pub const DEFAULT_MODEL: &str = "deepseek-flash";
pub const DEFAULT_TEMPERATURE: f64 = 0.2;
pub const DEFAULT_IDLE_MS: u64 = 60_000;

/// 与 server.js 的 DEFAULT_CONFIG 完全一致（+ idleMs，前端也能读）
pub fn default_config() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("baseURL".into(), json!(DEFAULT_BASE_URL));
    m.insert("apiKey".into(), json!(""));
    m.insert("model".into(), json!(DEFAULT_MODEL));
    m.insert("visionModel".into(), json!(""));
    m.insert("targetLang".into(), json!("中文"));
    m.insert("temperature".into(), json!(DEFAULT_TEMPERATURE));
    m.insert("theme".into(), json!("light"));
    m.insert("fontSize".into(), json!(15));
    m.insert("autoTranslate".into(), json!(true));
    m.insert("stream".into(), json!(true));
    m.insert("glossary".into(), json!(""));
    m.insert("idleMs".into(), json!(DEFAULT_IDLE_MS));
    m
}

/// JS 的 truthiness
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// 近似 JS 的 `String(x)`
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => String::new(),
    }
}

pub fn config(rq: Request, method: &Method, body: &[u8]) {
    match method {
        Method::Get => {
            let stored = store::read_json("config.json", json!({}));
            let mut merged = default_config();
            if let Value::Object(m) = stored {
                for (k, v) in m {
                    merged.insert(k, v);
                }
            }
            let has_key = merged.get("apiKey").map(truthy).unwrap_or(false);
            merged.insert("apiKey".into(), json!("")); // 密钥永远不回传
            merged.insert("hasApiKey".into(), json!(has_key));
            send_json(rq, 200, &Value::Object(merged));
        }
        Method::Post => {
            let raw = match parse_json(body) {
                Ok(v) => v,
                // 与 server.js 一致：解析失败回 400
                Err(e) => return send_json(rq, 400, &err_json(&e)),
            };
            // 审计 §P1：严格字段白名单 + 范围限制，未知字段忽略
            let filtered = limits::sanitize_config_patch(&raw);
            if !filtered.ignored.is_empty() {
                store::log_line(&format!(
                    "[diag] /api/config 忽略字段: {}",
                    filtered.ignored.join(", ")
                ));
            }
            /*
             * 超长字段 → 400，**绝不截断保存**（审计 §验收：「超限返回 413/400，
             * 不截断后静默保存」）。从前一个 5000 字的 model 会被悄悄存成 256 字、
             * 接口还回 200 —— 用户以为保存成功了，设置其实已经被改坏。
             */
            if !filtered.capped.is_empty() {
                let detail = filtered
                    .capped
                    .iter()
                    .map(|(f, n)| format!("{}（上限 {} 字符）", f, n))
                    .collect::<Vec<_>>()
                    .join("、");
                return send_json(
                    rq,
                    400,
                    &err_json(&format!("字段超长：{}。请缩短后重试（未保存任何改动）", detail)),
                );
            }
            let patch = Value::Object(filtered.patch);

            let cur = store::read_json("config.json", json!({}));
            let base = Value::Object(default_config());
            let next = store::merge(&store::merge(&base, &cur), &patch);

            let patch_key_truthy = patch.get("apiKey").map(truthy).unwrap_or(false);
            let mut next = next;
            if !patch_key_truthy {
                // 空字符串/缺失 → 保留原来的 key
                let cur_key = cur.get("apiKey").cloned().unwrap_or(Value::Null);
                let keep = if truthy(&cur_key) {
                    cur_key
                } else {
                    json!("")
                };
                if let Value::Object(m) = &mut next {
                    m.insert("apiKey".into(), keep);
                }
            }
            let has_key = next.get("apiKey").map(truthy).unwrap_or(false);
            if !store::write_json("config.json", &next) {
                return send_json(rq, 500, &err_json("保存配置失败，请检查磁盘空间和目录权限"));
            }
            send_json(rq, 200, &json!({ "ok": true, "hasApiKey": has_key }));
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

/* ---------------------------------------------------------------- 进度 */

pub fn state(rq: Request, method: &Method, body: &[u8]) {
    match method {
        Method::Get => {
            let cur = store::read_json("state.json", json!({}));
            send_json(rq, 200, &cur);
        }
        Method::Post => {
            let patch = match parse_json(body) {
                Ok(v) => v,
                Err(e) => return send_json(rq, 500, &err_json(&e)),
            };
            let cur = store::read_json("state.json", json!({}));
            let next = store::merge(&cur, &patch);
            if !store::write_json("state.json", &next) {
                return send_json(rq, 500, &err_json("保存阅读进度失败，请重试"));
            }
            send_json(rq, 200, &json!({ "ok": true }));
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

/* ---------------------------------------------------------------- 笔记 */

pub fn notes(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    let doc = query_get(raw_query, "doc").unwrap_or_else(|| "default".to_string());
    // 关键：docId 再过一次 docIdOf()，`doc=../../x` 也只会变成合法文件名
    let file = format!("notes-{}.json", doc_id_of(&doc));

    match method {
        Method::Get => {
            let items = store::read_json(&file, json!([]));
            send_json(rq, 200, &json!({ "items": items }));
        }
        Method::Post => {
            let payload = match parse_json(body) {
                Ok(v) => v,
                Err(e) => return send_json(rq, 400, &err_json(&e)),
            };
            let items = match payload.get("items") {
                Some(Value::Array(a)) => Value::Array(a.clone()),
                _ => return send_json(rq, 400, &err_json("请求体缺少 items 数组")),
            };
            // 审计 §P1：条目数 + 总字符数（请求体字节上限在 server.rs 里）
            if let Err(msg) = limits::check_notes(&items) {
                return send_json(rq, 413, &err_json(&msg));
            }
            if !store::write_json(&file, &items) {
                return send_json(rq, 500, &err_json("保存笔记失败，请重试"));
            }
            send_json(rq, 200, &json!({ "ok": true }));
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

/** 会话文件名：有 sid 走新布局，没有就用老的单会话文件 */
fn session_file(doc: &str, sid: &str) -> String {
    session_file_for(&doc_id_of(doc), sid)
}

fn session_file_for(key: &str, sid: &str) -> String {
    if sid.is_empty() {
        format!("session-{}.json", key)
    } else {
        format!("session-{}-{}.json", key, sid)
    }
}

/**
 * 找这个 (doc, sid) 真正对应的文件，**优先认老键**。
 *
 * 为什么需要：修 `doc_id_of` 幂等之前，前端传 docId 时会被二次哈希，
 * 于是同一个文档存在两种键名。已经用老键写过的会话不能因为修了 bug 就"消失"：
 * 老键文件存在就继续用它，不存在才用新的正确键。
 */
fn session_file_resolved(doc: &str, sid: &str) -> String {
    for key in doc_key_candidates(doc) {
        let f = session_file_for(&key, sid);
        if store::read_json_opt(&f).is_some() {
            return f;
        }
    }
    session_file(doc, sid)
}

/**
 * 一个 doc 参数可能对应的所有历史键（新的正确键 + 老的双哈希键 + 文件名形式）。
 * 与 Node 版 `docKeyCandidates()` 保持一致。
 */
fn doc_key_candidates(doc: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: String| {
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
        }
    };
    push(doc_id_of(doc));
    let s = doc.to_string();
    let mut h: u32 = 5381;
    for b in s.bytes() {
        h = (h.wrapping_mul(33)) ^ (b as u32);
    }
    let slug: String = s
        .rsplit_once('.')
        .map(|(a, _)| a.to_string())
        .unwrap_or_else(|| s.clone())
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' || (c as u32) >= 0x4e00 { c } else { '_' })
        .take(48)
        .collect();
    push(format!("{}-{:x}", slug, h));
    out
}

/**
 * `/api/session` —— 一篇论文的对话。
 *
 * 2026-10 起支持**多会话**（与 Node 版行为一致，用户口径「问答是不是要做多对话分对话」）：
 *   老： session-<docId>.json                ← 单会话时代的文件，仍然照读照写
 *   新： session-<docId>-<sid>.json          ← 每个会话一个文件，sid 由前端生成
 * 不传 `sid` 时行为与以前完全一致（读/写老文件），所以老存档不会读坏。
 */
pub fn session(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    let doc = query_get(raw_query, "doc").unwrap_or_else(|| "default".to_string());
    let sid = query_get(raw_query, "sid")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect::<String>();
    // 读 / 写 / 删都先解析到"真正存在的那一份"，避免修了幂等之后老会话读不到
    let file = session_file_resolved(&doc, &sid);
    match method {
        Method::Get => send_json(rq, 200, &store::read_json(&file, json!({"entries":[],"history":[],"ops":[]}))),
        Method::Post => {
            let payload = match parse_json(body) {
                Ok(v) => v,
                Err(e) => return send_json(rq, 400, &err_json(&e)),
            };
            // 审计 §P1：条目数 + 总字符数 + 附件元数据体积
            if let Err(msg) = limits::check_session(&payload) {
                return send_json(rq, 413, &err_json(&msg));
            }
            if !store::write_json(&file, &payload) {
                return send_json(rq, 500, &err_json("保存阅读会话失败，请重试"));
            }
            send_json(rq, 200, &json!({"ok":true}));
        }
        // 删掉一个会话文件（不碰论文本身）
        Method::Delete => {
            if store::remove_file(&file) {
                send_json(rq, 200, &json!({"ok":true}))
            } else {
                send_json(rq, 500, &err_json("删除会话失败"))
            }
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

/**
 * `/api/sessions?doc=<doc>` —— 会话列表（只回元信息，不回正文）。
 * 对所有历史键都扫一遍，老的单会话文件以 `sid: ""` 出现（前端当"默认会话"）。
 */
pub fn sessions(rq: Request, _method: &Method, raw_query: &str) {
    let doc = query_get(raw_query, "doc").unwrap_or_else(|| "default".to_string());
    let keys = doc_key_candidates(&doc);

    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for name in store::list_data_files() {
        // 先判断这个文件名属于哪个候选键、sid 是什么；不属于任何一个就跳过
        let sid = keys.iter().find_map(|key| {
            let legacy = format!("session-{}.json", key);
            let prefix = format!("session-{}-", key);
            if name == legacy {
                Some(String::new())
            } else if name.starts_with(&prefix) && name.ends_with(".json") {
                Some(name[prefix.len()..name.len() - 5].to_string())
            } else {
                None
            }
        });
        let sid = match sid {
            Some(s) => s,
            None => continue,
        };
        if seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        let data = store::read_json(&name, json!(null));
        if data.is_null() {
            continue;
        }
        let entries = data.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let first_user = entries.iter().find(|e| e.get("kind").and_then(|k| k.as_str()) == Some("user"));
        let last_text = entries.iter().rev().find(|e| {
            e.get("text").and_then(|t| t.as_str()).map(|t| !t.trim().is_empty()).unwrap_or(false)
        });
        let clip = |v: Option<&Value>, n: usize| -> String {
            v.and_then(|x| x.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(n)
                .collect()
        };
        let updated = data.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        out.push(json!({
            "sid": sid,
            "count": entries.len(),
            "title": clip(first_user, 60),
            "preview": clip(last_text, 80),
            "updatedAt": updated,
        }));
    }
    out.sort_by(|a, b| {
        let av = a.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bv = b.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
    send_json(rq, 200, &json!({ "sessions": out }));
}

/* ------------------------------------------------------------ 静态资源 */

/* ---------------------------------------------------------------- upload */

/// 文件名洗净：去掉路径分隔符和控制字符，保证以 .pdf 结尾
fn sanitize_pdf_name(name: &str) -> Option<String> {
    let mut n: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    n = n.trim_start_matches(['.', ' ', '\t']).trim().to_string();
    if n.is_empty() {
        return None;
    }
    if !n.to_lowercase().ends_with(".pdf") {
        n.push_str(".pdf");
    }
    if n.chars().count() > 150 {
        n = n.chars().take(146).collect::<String>() + ".pdf";
    }
    Some(n)
}

/// 同名同大小 → 认为已经导入过，直接复用；否则加 (2)(3) 后缀
fn unique_pdf_name(base: &str, size: u64) -> String {
    let dir = &dirs().papers;
    let stem = base.strip_suffix(".pdf").or_else(|| base.strip_suffix(".PDF")).unwrap_or(base);
    for i in 1..200u32 {
        let candidate = if i == 1 { base.to_string() } else { format!("{} ({}).pdf", stem, i) };
        let abs = dir.join(&candidate);
        match std::fs::metadata(&abs) {
            Ok(m) if m.len() == size => return candidate,   // 同一份文件，不重复存
            Ok(_) => continue,                               // 同名不同大小，换个名字
            Err(_) => return candidate,                      // 不存在，就用它
        }
    }
    format!("{}-{}.pdf", stem, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))
}

/// POST /api/upload?name=xxx.pdf  —— 原始字节就是 PDF 内容
pub fn upload(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    if *method != Method::Post {
        return send_text(rq, 405, "Method Not Allowed");
    }
    let raw = query_get(raw_query, "name").unwrap_or_else(|| "uploaded.pdf".to_string());
    let name = match sanitize_pdf_name(&raw) {
        Some(n) => n,
        None => return send_json(rq, 400, &err_json("文件名不合法")),
    };
    if body.is_empty() {
        return send_json(rq, 400, &err_json("空文件"));
    }
    if !body.starts_with(b"%PDF-") {
        return send_json(rq, 400, &err_json("这不是一个 PDF 文件"));
    }

    let final_name = unique_pdf_name(&name, body.len() as u64);
    let abs = dirs().papers.join(&final_name);
    if let Err(e) = std::fs::write(&abs, body) {
        return send_json(rq, 500, &err_json(&format!("写入 papers/ 失败：{}", e)));
    }
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(body.len() as u64);
    store::log_line(&format!("[upload] {} ({}KB)", final_name, body.len() / 1024));

    send_json(
        rq,
        200,
        &json!({
            "ok": true,
            "name": final_name,
            "size": size,
            "docId": doc_id_of(&final_name),
            "url": format!("/api/pdf?name={}", encode_uri_component(&final_name)),
        }),
    );
}

pub fn static_file(rq: Request, decoded_path: &str, is_head: bool) {
    let key = match static_asset_key(decoded_path) {
        Some(k) => k,
        None => return send_text(rq, 400, "Bad path"),
    };

    if let Some(asset) = assets::get(&key) {
        let ext = extname(&key);
        // 应用自己的 HTML 页面：注入 token（审计 §P0 第 2 条：只注入本应用页面）
        if ext.eq_ignore_ascii_case(".html") {
            let html = String::from_utf8_lossy(&asset.data).to_string();
            let injected = auth::inject_into_html(&html);
            return send_html(rq, injected.into_bytes(), is_head);
        }
        let mime = mime_of(&ext);
        return send_raw(
            rq,
            200,
            Some(mime),
            asset.data.into_owned(),
            &[("Cache-Control", "no-cache")],
        );
    }

    // 单页应用：未知且没有扩展名的路径回落到 index.html
    if extname(&key).is_empty() {
        if let Some(index) = assets::get("index.html") {
            let html = String::from_utf8_lossy(&index.data).to_string();
            let injected = auth::inject_into_html(&html);
            return send_html(rq, injected.into_bytes(), is_head);
        }
    }

    send_text(rq, 404, "Not Found")
}

/* ---------------------------------------------------------------- 工具 */

pub fn parse_json(body: &[u8]) -> Result<Value, String> {
    if body.is_empty() {
        return Err("请求体不能为空".to_string());
    }
    serde_json::from_slice::<Value>(body).map_err(|e| format!("请求体解析失败: {}", e))
}

/* ------------------------------------------------------- 参考文献检索 */

fn http_agent() -> ureq::Agent {
    http_agent_with(10, 15)
}

/// 带 native-tls 的 agent。**必须显式装 TLS 连接器**：ureq 用的是
/// `default-features = false, features = ["native-tls"]`，不装的话
/// 所有 https 请求都会报 "no TLS backend is configured"（联网导入就踩过这个）。
fn http_agent_with(connect_secs: u64, read_secs: u64) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(connect_secs))
        .timeout_read(std::time::Duration::from_secs(read_secs))
        .timeout_write(std::time::Duration::from_secs(15));
    if let Ok(c) = ureq::native_tls::TlsConnector::new() {
        b = b.tls_connector(std::sync::Arc::new(c));
    }
    b.build()
}

fn fetch_text(agent: &ureq::Agent, url: &str) -> Option<String> {
    match agent
        .get(url)
        .set("User-Agent", "paper-reader/1.0 (local; reference lookup)")
        .call()
    {
        Ok(r) => r.into_string().ok(),
        Err(_) => None,
    }
}

/// 从一条参考文献里猜标题：作者列表通常在第一段，标题紧随其后
fn guess_title(reference: &str) -> String {
    let s = reference.trim();
    let s = if let Some(rest) = s.strip_prefix('[') {
        match rest.find(']') {
            Some(i) => rest[i + 1..].trim(),
            None => s,
        }
    } else {
        s
    };
    let parts: Vec<&str> = s.split(". ").collect();
    let mut out = if parts.len() >= 2 {
        let first = parts[0];
        let looks_like_authors =
            (first.contains(',') || first.contains(" and ")) && first.split_whitespace().count() <= 80;
        if looks_like_authors { parts[1] } else { parts[0] }
    } else {
        parts[0]
    };
    let t = out.trim();
    if t.starts_with("In ") || t.starts_with("Proceedings") || t.starts_with("Advances") {
        out = s;
    }
    out.trim()
        .trim_end_matches(['.', ',', ';', ':'])
        .chars()
        .take(160)
        .collect()
}

/// 取 XML 里某个标签的文本（把换行折成空格）
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let i = xml.find(&open)? + open.len();
    let j = xml[i..].find(&close)? + i;
    Some(xml[i..j].split_whitespace().collect::<Vec<_>>().join(" "))
}

fn norm_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|x| x.to_string())
        .collect()
}

fn score_title(a: &str, b: &str) -> f64 {
    let ta = norm_tokens(a);
    let tb = norm_tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let hit = ta.iter().filter(|w| tb.contains(w)).count();
    hit as f64 / ta.len().max(tb.len()) as f64
}

/// OpenAlex 条目该给哪个链接：**有 doi 用 doi，没有就回落到落地页**。
/// 与 server.js:464 `w.doi || w.primary_location?.landing_page_url || ''` 等价（desktop/README.md D8）。
/// 抽成纯函数是为了能单测 —— 原来它内联在 ref_search 里，没法离线验证。
fn openalex_link<'a>(doi: &'a str, landing: &'a str) -> &'a str {
    if !doi.is_empty() { doi } else { landing }
}

/// 参考文献条目的打分：标题相似度 + 有 PDF 直链加 0.35 + doi.org/arxiv.org 再加 0.1。
/// 与 server.js:515 等价（desktop/README.md D9）。
fn ref_score(want_title: &str, got_title: &str, has_pdf: bool, link: &str) -> f64 {
    let bonus = if link.contains("doi.org") || link.contains("arxiv.org") { 0.1 } else { 0.0 };
    score_title(want_title, got_title) + if has_pdf { 0.35 } else { 0.0 } + bonus
}

/* --------------------------------------------------------- 联网导入 PDF */

/// 一次性导入的大小上限
const MAX_IMPORT: usize = 128 * 1024 * 1024;

/// 内网地址不接：这个接口是「让本机去下载一个外部 URL」，
/// 不挡的话就成了可被网页利用的内网探测器（SSRF）。导入论文用的都是公网地址。
/// 与 server.js 的 `isPrivateHost()` 逐条一致。
/// [a,b,c,d] 是不是回环 / 私网 / 链路本地 / 保留地址。
/// 与 server.js 的 `isPrivateIPv4()` 逐条一致。
fn is_private_ipv4(quad: [u32; 4]) -> bool {
    if quad.iter().any(|n| *n > 255) {
        return true; // 不合法的字面量一律当内网（宁严勿松）
    }
    let (a, b) = (quad[0], quad[1]);
    matches!(a, 0 | 10 | 127)
        || (a == 169 && b == 254)          // 链路本地 + 云元数据 169.254.169.254
        || (a == 192 && b == 168)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))   // 基准测试网段
        || a >= 224                              // 组播 / 保留
}

/// 点分四段 → [a,b,c,d]；段不合法返回 None
fn parse_ipv4_quad(s: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u32; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}

/// 内网地址不接（SSRF 防护）。与 server.js 的 `isPrivateHost()` 逐条一致。
///
/// 两个实测发现的真实绕过口子都在这里堵上：
///   * `http://localhost./` —— 结尾的点，DNS 上等价于 localhost（解析到 ::1）；
///   * `http://[::ffff:169.254.169.254]/` —— IPv4-mapped IPv6，会被规范化成十六进制
///     `[::ffff:a9fe:a9fe]`，按点分四段匹配是匹配不到的。
fn is_private_host(host: &str) -> bool {
    let mut h = host.to_ascii_lowercase();
    // IPv6 字面量可能带方括号（`URL.hostname` 就有；Node 那边同样处理）
    if h.starts_with('[') && h.ends_with(']') && h.len() >= 2 {
        h = h[1..h.len() - 1].to_string();
    }
    let h = h.trim_end_matches('.').to_string();
    if h.is_empty() {
        return true;
    }

    // 主机名形态
    if h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".home.arpa")
        || h.ends_with(".lan")
        || h.ends_with(".intranet")
    {
        return true;
    }

    // IPv6：只在确实是 IPv6 字面量（含冒号）时按前缀判，
    // 避免 `fc…` / `fd…` 开头的主机名被误伤
    if h.contains(':') {
        if h == "::1" || h == "::" {
            return true;
        }
        // ::ffff:a9fe:a9fe（IPv4-mapped 的十六进制规范化形式）
        if let Some(rest) = h.strip_prefix("::ffff:") {
            if let Some((hi, lo)) = rest.split_once(':') {
                if let (Ok(a), Ok(b)) = (u32::from_str_radix(hi, 16), u32::from_str_radix(lo, 16)) {
                    let v = a * 65536 + b;
                    return is_private_ipv4([
                        (v >> 24) & 255,
                        (v >> 16) & 255,
                        (v >> 8) & 255,
                        v & 255,
                    ]);
                }
            }
            // ::ffff:169.254.169.254（点分四段写法的 mapped 地址）
            if rest.contains('.') {
                if let Some(q) = parse_ipv4_quad(rest) {
                    return is_private_ipv4(q);
                }
                return true; // 认不出来但确实是 mapped 形式 → 按内网处理
            }
        }
        if h.starts_with("fe80:") || h.starts_with("fec0:") {
            return true; // 链路本地 / 站点本地
        }
        // fc00::/7 唯一本地地址。写法必须是「f」+「c 或 d」+ 最多两位十六进制 +「:」——
        // `fc00::1` 的冒号在第 5 个字符，`fc::1` 在第 3 个，两种都要认出来。
        let b = h.as_bytes();
        if b.len() >= 3 && b[0] == b'f' && (b[1] == b'c' || b[1] == b'd') {
            let digits = b[2..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
            if digits <= 2 && b.get(2 + digits) == Some(&b':') {
                return true;
            }
        }
        if h.starts_with("ff") {
            return true; // 组播
        }
        if h.starts_with("2001:db8:") || h.starts_with("2001:0db8:") {
            return true; // 文档用网段
        }
        if h.starts_with("64:ff9b:") || h.starts_with("2002:") {
            return true; // NAT64 / 6to4（可能映射到内网）
        }
        return false;
    }

    // IPv4
    match parse_ipv4_quad(&h) {
        Some(q) => is_private_ipv4(q),
        None => false,
    }
}

/// 重定向跳数上限（审计 §P1：例如最多 3 跳）
const MAX_REDIRECTS: usize = 3;

/// 解析一个「允许让本机去下载」的 URL：协议 + 凭证（+ 可选的内网检查）。
/// 审计 §P1 要求**重定向的每一跳**都重新做检查。
///
/// `check_private` 之所以要能关掉：**第一跳**的内网检查由调用方用原始错误码/文案做
/// （`import_pdf` 顶部的 `check_fetch_url`，回 400「内网地址不允许导入」）。
/// 用户自己指定、且已经过检查的地址不该被查第二遍；要挡的是**重定向** ——
/// 所以第 2 跳起每一跳都必须做内网检查。
fn check_fetch_url(raw: &str, check_private: bool) -> Result<String, String> {
    let s = raw.trim();
    if !is_external_url(s) {
        return Err("只支持 http/https 链接".to_string());
    }
    let parsed = url::Url::parse(s).map_err(|_| "链接格式无效".to_string())?;
    if parsed.username().len() > 0 || parsed.password().is_some() {
        return Err("url 不允许携带用户名密码".to_string());
    }
    if check_private {
        let host = parsed.host_str().unwrap_or("");
        if is_private_host(&host) {
            return Err("内网地址不允许导入".to_string());
        }
    }
    Ok(s.to_string())
}

/// 相对 Location 也要能解析：以当前 URL 为基准拼出绝对地址。
/// （`rust_url` 依赖不在，这里只处理 http(s) 下最常见的三种形式。）
fn resolve_redirect(base: &str, loc: &str) -> Option<String> {
    let loc = loc.trim();
    if loc.is_empty() {
        return None;
    }
    if is_external_url(loc) {
        return Some(loc.to_string());
    }
    if loc.starts_with("//") {
        let scheme = base.split_once("://").map(|(s, _)| s).unwrap_or("https");
        return Some(format!("{}:{}", scheme, loc));
    }
    let (scheme, rest) = base.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if loc.starts_with('/') {
        return Some(format!("{}://{}{}", scheme, authority, loc));
    }
    // 相对路径：砍掉最后一段再拼
    let path = &rest[authority.len()..];
    let base_path = path.split(['?', '#']).next().unwrap_or("/");
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..=i],
        None => "/",
    };
    Some(format!("{}://{}{}{}", scheme, authority, dir, loc))
}

/// 手动跟随重定向（最多 MAX_REDIRECTS 跳），**每一跳**重新做协议 + 内网检查。
///
/// 从前这里是 `agent.get(&target).call()` —— ureq 默认自动跟随重定向，
/// 于是公网地址只要 302 到 http://127.0.0.1:… 或 http://169.254.169.254/
/// 就能绕过全部内网检查（审计 §P1）。
///
/// `check_private_on_first_hop`：默认 true（直连地址照旧立刻被拒）。
/// 传 false 只有一种场合 —— 调用方自己已经在顶层做过第一跳的内网判定
/// （`import_pdf` 就是这样），避免重复判定、也让直连地址的错误码保持原样。
///
/// 返回最终响应，或用户可见的错误文案。
fn fetch_following_safely(
    agent: &ureq::Agent,
    target: &str,
    check_private_on_first_hop: bool,
) -> Result<ureq::Response, String> {
    let mut current = target.to_string();
    for hop in 0..=MAX_REDIRECTS {
        let check_private = if hop == 0 { check_private_on_first_hop } else { true };
        let checked = check_fetch_url(&current, check_private)?;
        let resp = agent
            .get(&checked)
            .set("User-Agent", SEARCH_UA)
            .set("Accept", "application/pdf,*/*;q=0.8")
            .call()
            .map_err(|e| format!("下载失败：{}", sanitize_transport(&e)))?;

        let status = resp.status();
        if !(300..400).contains(&status) {
            return Ok(resp);
        }
        let loc = resp.header("Location").unwrap_or("").to_string();
        if loc.is_empty() {
            drop(resp);
            return Err("对方返回了一个没有 Location 的跳转".to_string());
        }
        drop(resp); // 丢掉这次响应体，再重新检查下一跳
        if hop == MAX_REDIRECTS {
            return Err(format!("跳转次数过多（超过 {} 次），已停止", MAX_REDIRECTS));
        }
        let next = match resolve_redirect(&checked, &loc) {
            Some(n) => n,
            None => return Err("对方返回的跳转地址不合法".to_string()),
        };
        store::log_line(&format!("[diag] /api/import-pdf 跟随跳转 -> {}", host_of(&next)));
        current = next;
    }
    Err("跳转次数过多，已停止".to_string())
}

/// 网络异常 → 用户可见文案（去掉底层细节里的本机信息）
fn sanitize_transport(e: &ureq::Error) -> String {
    let raw = match e {
        ureq::Error::Transport(t) => t
            .message()
            .map(|m| m.to_string())
            .unwrap_or_else(|| t.to_string()),
        other => other.to_string(),
    };
    limits::sanitize_message(&raw, "网络请求失败")
}

/// 从 URL / Content-Disposition 里猜文件名
fn guess_pdf_name(final_url: &str, disposition: &str) -> String {
    let mut raw = String::new();
    let lower = disposition.to_ascii_lowercase();
    if let Some(i) = lower.find("filename*=") {
        let rest = &disposition[i + 10..];
        let rest = rest.split(';').next().unwrap_or(rest).trim().trim_matches('"');
        // filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf
        let v = match rest.splitn(3, '\'').nth(2) {
            Some(v) => v,
            None => rest,
        };
        raw = percent_decode(v);
    } else if let Some(i) = lower.find("filename=") {
        let rest = &disposition[i + 9..];
        raw = rest.split(';').next().unwrap_or(rest).trim().trim_matches('"').to_string();
    }
    if raw.is_empty() {
        let path = final_url.split(['?', '#']).next().unwrap_or(final_url);
        raw = path.rsplit('/').next().unwrap_or("").to_string();
        raw = percent_decode(&raw);
    }
    let stem = raw.trim_end_matches(".pdf").trim_end_matches(".PDF");
    let stem = if stem.is_empty() { "imported" } else { stem };
    format!("{}.pdf", stem)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// GET /api/import-pdf?url=<http(s) 链接>[&name=...]
/// 把远处的 PDF 抓回来存进 papers/。只认真正的 PDF（校验文件头）。
pub fn import_pdf(rq: Request, raw_query: &str) {
    let target = query_get(raw_query, "url").unwrap_or_default().trim().to_string();
    if target.is_empty() {
        return send_json(rq, 400, &err_json("缺少 url"));
    }
    if target.chars().count() > 2000 {
        return send_json(rq, 400, &err_json("url 过长"));
    }
    // 初始 URL 先检查一次（错误码/文案与从前一致），随后**每一跳**都会再检查一次。
    // 直连就已经挡掉内网地址（不发出任何请求）；重定向目标由 fetch_following_safely
    // 逐跳检查 —— 所以透传「第一跳已检查过」。
    if let Err(msg) = check_fetch_url(&target, true) {
        return send_json(rq, 400, &err_json(&msg));
    }

    // 下载用更长的读超时；同样必须带 TLS
    let agent = http_agent_with(15, 60);

    // 手动跟随重定向：每一跳重新做协议 / 凭证 / 内网检查（审计 §P1）
    let resp = match fetch_following_safely(&agent, &target, false) {
        Ok(r) => r,
        Err(msg) => {
            store::log_line(&format!("[diag] /api/import-pdf 失败 host={} err={}", host_of(&target), msg));
            return send_json(rq, 502, &err_json(&msg));
        }
    };

    let status = resp.status();
    if !(200..300).contains(&status) {
        return send_json(rq, 502, &err_json(&format!("对方返回 {}，没能拿到 PDF", status)));
    }
    let final_url = resp.get_url().to_string();
    let disposition = resp.header("Content-Disposition").unwrap_or("").to_string();
    let declared: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if declared > MAX_IMPORT as u64 {
        drop(resp);
        return send_json(
            rq,
            413,
            &err_json(&format!("文件太大（{}MB）", declared / 1048576)),
        );
    }

    let mut body: Vec<u8> = Vec::new();
    {
        use std::io::Read;
        // 边读边计数：没有 Content-Length（chunked）时也不能让内存无上限地涨
        let mut limited = resp.into_reader().take((MAX_IMPORT + 1) as u64);
        if let Err(e) = limited.read_to_end(&mut body) {
            store::log_line(&format!("[diag] /api/import-pdf 读取内容失败: {}", e));
            return send_json(
                rq,
                502,
                &err_json(&format!(
                    "读取内容失败：{}",
                    limits::sanitize_message(&e.to_string(), "网络中断")
                )),
            );
        }
    }
    if body.len() > MAX_IMPORT {
        return send_json(
            rq,
            413,
            &err_json(&format!("文件太大（超过 {}MB）", MAX_IMPORT / 1048576)),
        );
    }
    if body.is_empty() {
        return send_json(rq, 400, &err_json("下回来的是空文件"));
    }
    if !body.starts_with(b"%PDF-") {
        return send_json(
            rq,
            400,
            &err_json("这个链接不是 PDF（可能是个网页，试着直接找 PDF 直链）"),
        );
    }

    let wanted = query_get(raw_query, "name")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| guess_pdf_name(&final_url, &disposition));
    let name = match sanitize_pdf_name(&wanted) {
        Some(n) => n,
        None => "imported.pdf".to_string(),
    };
    let size = body.len() as u64;
    let final_name = unique_pdf_name(&name, size);
    let abs = crate::util::dirs().papers.join(&final_name);
    if std::fs::write(&abs, &body).is_err() {
        return send_json(rq, 500, &err_json("写入 papers/ 失败：请检查磁盘空间与目录权限"));
    }
    let real = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(size);
    // 日志里不打印完整 URL 的查询串（可能带 token / 签名），只留主机名
    store::log_line(&format!(
        "[import] {} ({}KB) <- {}",
        final_name,
        body.len() / 1024,
        host_of(&final_url)
    ));

    send_json(
        rq,
        200,
        &json!({
            "ok": true,
            "name": final_name,
            "size": real,
            "docId": doc_id_of(&final_name),
            "url": format!("/api/pdf?name={}", encode_uri_component(&final_name)),
        }),
    );
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = hostport.rsplit_once('@').map(|(_, h)| h).unwrap_or(hostport);
    host.split(':').next().unwrap_or("").to_string()
}

/* --------------------------------------------------------- 联网搜索 */

/// 浏览器 UA。搜索引擎对非浏览器 UA 常直接返回空页或验证页。
const SEARCH_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const SEARCH_TTL_SECS: u64 = 300;
const SEARCH_CACHE_MAX: usize = 200;

type SearchCache = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Value)>>;

fn search_cache() -> &'static SearchCache {
    static C: std::sync::OnceLock<SearchCache> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn find_after(s: &str, from: usize, needle: &str) -> Option<usize> {
    if from >= s.len() {
        return None;
    }
    s[from..].find(needle).map(|i| i + from)
}

/// 取 `attr="值"`，返回（值，引号结束位置）
fn attr_value(s: &str, from: usize, attr: &str) -> Option<(String, usize)> {
    let pat = format!("{}=\"", attr);
    let i = find_after(s, from, &pat)? + pat.len();
    let j = s[i..].find('"')? + i;
    Some((s[i..j].to_string(), j))
}

/// 取 `<open ...>文本</close>` 的文本（已去标签）。`open` 是起始标记的字面前缀，如 `<h2`。
fn inner_text(s: &str, from: usize, open: &str, close: &str) -> Option<(String, usize)> {
    let o = find_after(s, from, open)?;
    let gt = find_after(s, o, ">")? + 1;
    let c = find_after(s, gt, close)?;
    Some((strip_tags(&s[gt..c]), c + close.len()))
}

/// 去掉标签 + 展开常见 HTML 实体 + 折叠空白
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '<' {
            // <script ...> 直到 </script> 整段丢掉
            let head: String = bytes[i..bytes.len().min(i + 8)].iter().collect();
            if head.to_lowercase().starts_with("<script") {
                let tail: String = bytes[i..].iter().collect();
                match tail.to_lowercase().find("</script>") {
                    Some(k) => { i += k + 9; continue; }
                    None => break,
                }
            }
            in_tag = true;
            i += 1;
            continue;
        }
        if c == '>' && in_tag {
            in_tag = false;
            out.push(' ');
            i += 1;
            continue;
        }
        if !in_tag {
            out.push(c);
        }
        i += 1;
    }
    let mut s = out
        .replace("&nbsp;", " ")
        .replace("&ensp;", " ")
        .replace("&emsp;", " ")
        .replace("&thinsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&hellip;", "…")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–");
    // &#123; 这类数字实体
    while let Some(p) = s.find("&#") {
        let tail = &s[p + 2..];
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || !tail[digits.len()..].starts_with(';') {
            break;
        }
        let ch = digits.parse::<u32>().ok().and_then(char::from_u32).unwrap_or(' ');
        s.replace_range(p..p + 2 + digits.len() + 1, &ch.to_string());
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_result(out: &mut Vec<Value>, title: String, url: String, snippet: String) {
    if title.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    out.push(json!({ "title": title, "url": url, "snippet": snippet }));
}

/// Bing 的结果块最规整：直链 + 摘要
fn parse_bing(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for block in html.split("<li class=\"b_algo\"").skip(1).take(40) {
        let Some(h) = block.find("<h2") else { continue };
        let Some((url, _)) = attr_value(block, h, "href") else { continue };
        let Some((title, _)) = inner_text(block, h, "<a", "</a>") else { continue };
        let snippet = inner_text(block, 0, "<p", "</p>").map(|(t, _)| t).unwrap_or_default();
        push_result(&mut out, title, url, snippet);
    }
    out
}

fn parse_sogou(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for block in html.split("<div class=\"vrwrap\"").skip(1).take(40) {
        let Some(h) = block.find("<h3") else { continue };
        let Some((mut url, _)) = attr_value(block, h, "href") else { continue };
        if url.starts_with("/link") {
            url = format!("https://www.sogou.com{}", url);
        }
        let Some((title, _)) = inner_text(block, h, "<a", "</a>") else { continue };
        let snippet = inner_text(block, 0, "<div class=\"text-layout", "</div>")
            .or_else(|| inner_text(block, 0, "<p class=\"star-wiki\"", "</p>"))
            .map(|(t, _)| t)
            .unwrap_or_default();
        push_result(&mut out, title, url, snippet);
    }
    out
}

fn parse_baidu(html: &str) -> Vec<Value> {
    // 结果块以 class="result..." 开头，但属性顺序不固定，所以先收集每个块的起点
    let mut starts: Vec<usize> = Vec::new();
    let mut idx = 0usize;
    while let Some(i) = find_after(html, idx, "class=\"result") {
        if let Some(s) = html[..i].rfind('<') {
            starts.push(s);
        }
        idx = i + 1;
        if starts.len() >= 40 {
            break;
        }
    }
    let mut out = Vec::new();
    for w in 0..starts.len() {
        let end = if w + 1 < starts.len() { starts[w + 1] } else { html.len() };
        let block = &html[starts[w]..end];
        let Some(h) = block.find("<h3") else { continue };
        let Some((url, _)) = attr_value(block, h, "href") else { continue };
        let Some((title, _)) = inner_text(block, h, "<a", "</a>") else { continue };
        let snippet = inner_text(block, 0, "<span class=\"c-abstract", "</span>")
            .map(|(t, _)| t)
            .unwrap_or_default();
        push_result(&mut out, title, url, snippet);
    }
    out
}

fn fetch_search(agent: &ureq::Agent, url: &str) -> Option<String> {
    match agent
        .get(url)
        .set("User-Agent", SEARCH_UA)
        .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .call()
    {
        Ok(r) => r.into_string().ok(),
        Err(_) => None,
    }
}

/// 查询串里「有辨识度的词」：英文单词 + 所有中文二字组
fn push_tok(toks: &mut Vec<String>, t: String) {
    if !t.is_empty() && !toks.contains(&t) {
        toks.push(t);
    }
}

fn query_tokens(q: &str) -> Vec<String> {
    let lower = q.to_lowercase();
    let mut toks: Vec<String> = Vec::new();
    // 与 server.js 的 /[a-z][a-z0-9+#._-]*/g **必须等价**：词元只能**以字母开头**。
    //
    // 原来这里是把串按「非 [A-Za-z0-9+#._-]」切开、再裁掉首尾的 . _ -，于是
    // 纯数字/数字开头的串（`2017`、`3`）也会被当成词元 —— 相关度门槛更松，
    // Node 判「不相关 → 丢掉 → 换下一个引擎」的结果，exe 上会被当成来源列出来（desktop/README.md D11）。
    for w in lower.split(|c: char| {
        !(c.is_ascii_alphanumeric() || c == '+' || c == '#' || c == '.' || c == '_' || c == '-')
    }) {
        let w = w.trim_matches(|c| c == '.' || c == '_' || c == '-');
        // 首字符必须是字母（ASCII a-z；lower 之后不会有大写）
        let starts_alpha = w.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false);
        if starts_alpha && w.len() >= 2 {
            push_tok(&mut toks, w.to_string());
        }
    }
    let chars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !(chars[i] >= '\u{4e00}' && chars[i] <= '\u{9fa5}') {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && chars[j] >= '\u{4e00}' && chars[j] <= '\u{9fa5}' {
            j += 1;
        }
        let run = &chars[i..j];
        for k in 0..run.len().saturating_sub(1) {
            push_tok(&mut toks, run[k..k + 2].iter().collect());
        }
        i = j;
    }
    toks
}

/// 结果与查询串是不是完全沾不上边。
///
/// 真实踩过的坑：把一整句中文问句丢给 Bing，它会退化成单字查询，返回一堆
/// 「这」字的字典释义。这种结果当成「来源」列给用户比没有还糟。
/// 判据是「过半数结果都沾边」—— 只要求 1 条的话，长问句里的二字组太多，
/// 几乎必然蒙中一个，兜底就形同虚设。
fn looks_relevant(query: &str, results: &[Value]) -> bool {
    let toks = query_tokens(query);
    if toks.is_empty() {
        return true;
    }
    let hit = results
        .iter()
        .filter(|r| {
            let hay = format!(
                "{} {}",
                r.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                r.get("snippet").and_then(|x| x.as_str()).unwrap_or("")
            )
            .to_lowercase();
            toks.iter().any(|t| hay.contains(t.as_str()))
        })
        .count();
    let need = std::cmp::max(2, (results.len() + 1) / 2);
    hit >= need
}

/// GET /api/web-search?q=<查询>&n=6
/// 依次试 Bing(cn) → 搜狗 → 百度，谁先给出够用的结果就用谁。
/// 都是公开页面、不需要密钥；结果缓存 5 分钟。
pub fn web_search(rq: Request, raw_query: &str) {
    let raw = query_get(raw_query, "q").unwrap_or_default();
    let query: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let query: String = query.chars().take(200).collect();
    let n: usize = query_get(raw_query, "n")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(6)
        .clamp(1, 10);
    if query.is_empty() {
        return send_json(rq, 400, &err_json("缺少 q"));
    }

    let key = query.to_lowercase();
    {
        let cache = search_cache().lock().unwrap();
        if let Some((at, data)) = cache.get(&key) {
            if at.elapsed().as_secs() < SEARCH_TTL_SECS {
                return send_json(rq, 200, data);
            }
        }
    }

    let agent = http_agent();
    let engines: [(&str, String, fn(&str) -> Vec<Value>); 3] = [
        (
            "Bing",
            format!(
                "https://cn.bing.com/search?q={}&setlang=zh-CN",
                encode_uri_component(&query)
            ),
            parse_bing,
        ),
        (
            "搜狗",
            format!("https://www.sogou.com/web?query={}", encode_uri_component(&query)),
            parse_sogou,
        ),
        (
            "百度",
            format!("https://www.baidu.com/s?wd={}", encode_uri_component(&query)),
            parse_baidu,
        ),
    ];

    let mut dropped = 0usize;
    for (name, url, parse) in engines {
        let Some(html) = fetch_search(&agent, &url) else { continue };
        let results: Vec<Value> = parse(&html).into_iter().take(n).collect();
        if results.len() >= 2 && looks_relevant(&query, &results) {
            let data = json!({ "query": query, "provider": name, "results": results });
            if let Ok(mut cache) = search_cache().lock() {
                if cache.len() > SEARCH_CACHE_MAX {
                    cache.clear();
                }
                cache.insert(key, (std::time::Instant::now(), data.clone()));
            }
            return send_json(rq, 200, &data);
        }
        if results.len() >= 2 {
            dropped += 1;
        }
    }

    // 这里**不能**写「反正别的引擎失败了，就把这批不相关的先给出去」。
    // 之前留过这么一个兜底，结果 Bing 退化成单字查询时，一堆「这」字的字典释义
    // 照样被当成来源返回给模型和用户。宁可不给，也别给错的。
    let msg = if dropped > 0 {
        "搜到的结果和问题对不上，已丢弃（换个更具体的问法试试）"
    } else {
        "几个搜索引擎都没返回可用结果（可能被限流或断网）"
    };
    send_json(
        rq,
        200,
        &json!({ "query": query, "provider": "", "results": [], "error": msg }),
    );
}

/// GET /api/open-url?url=<http(s) 链接>
/// 用系统默认浏览器打开。页面里的外链统一走这里 —— WebView2 外壳不会自己处理
/// `<a target="_blank">`，直接点等于没反应。
pub fn open_url(rq: Request, raw_query: &str) {
    let url = query_get(raw_query, "url").unwrap_or_default();
    let url = url.trim().to_string();
    if url.is_empty() {
        return send_json(rq, 400, &err_json("缺少 url"));
    }
    if url.chars().count() > 2000 {
        return send_json(rq, 400, &err_json("url 过长"));
    }
    if !is_external_url(&url) {
        return send_json(rq, 400, &err_json("只允许打开 http/https 链接"));
    }
    match open_in_browser(&url) {
        Ok(()) => {
            store::log_line(&format!("[open] 已交给系统浏览器: {}", url));
            send_json(rq, 200, &json!({ "ok": true, "url": url }))
        }
        Err(e) => {
            store::log_line(&format!("[open] 打开失败: {} ({})", url, e));
            send_json(rq, 500, &err_json(&e))
        }
    }
}

/// GET /api/ref-search?q=<文献条目>
/// 依次查 arXiv（常有直链 PDF）→ OpenAlex（免费、有开放获取链接）→ Crossref（覆盖最广）。
/// 全是公开接口、不需要密钥；某个源失败就跳过，不会整体失败。
pub fn ref_search(rq: Request, raw_query: &str) {
    let raw = query_get(raw_query, "q").unwrap_or_default();
    let raw = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if raw.is_empty() {
        return send_json(rq, 400, &err_json("缺少 q"));
    }
    let raw: String = raw.chars().take(300).collect();
    let title = guess_title(&raw);
    let agent = http_agent();
    let mut results: Vec<Value> = Vec::new();

    // 1) arXiv
    for q in [format!("ti:\"{}\"", title), format!("all:\"{}\"", title)] {
        let url = format!(
            "https://export.arxiv.org/api/query?search_query={}&max_results=3",
            encode_uri_component(&q)
        );
        if let Some(xml) = fetch_text(&agent, &url) {
            let before = results.len();
            for entry in xml.split("<entry>").skip(1) {
                let id = tag_text(entry, "id").unwrap_or_default();
                if !id.contains("arxiv.org/abs/") {
                    continue;
                }
                results.push(json!({
                    "source": "arXiv",
                    "title": tag_text(entry, "title").unwrap_or_default(),
                    "year": tag_text(entry, "published").map(|p| p.chars().take(4).collect::<String>()).unwrap_or_default(),
                    "venue": "arXiv",
                    "url": id,
                    "pdfUrl": id.replace("/abs/", "/pdf/"),
                }));
            }
            if results.len() > before {
                break;
            }
        }
    }

    // 2) OpenAlex
    let url = format!(
        "https://api.openalex.org/works?search={}&per-page=4&select=title,publication_year,doi,open_access,primary_location",
        encode_uri_component(&title)
    );
    if let Some(txt) = fetch_text(&agent, &url) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(arr) = v.get("results").and_then(|x| x.as_array()) {
                for w in arr {
                    let oa = w
                        .pointer("/open_access/oa_url")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let pdf = if oa.to_lowercase().contains(".pdf") { oa.to_string() } else { String::new() };
                    // 与 server.js:464 一致：doi 缺失时回落到 primary_location.landing_page_url。
                    // 不回落的话，**没有 DOI 的条目在 exe 上点不开**（Node 版还能落到落地页）——
                    // 这是用户可见差异（desktop/README.md D8）。
                    let doi = w.get("doi").and_then(|x| x.as_str()).unwrap_or("");
                    let landing = w
                        .pointer("/primary_location/landing_page_url")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let link = openalex_link(doi, landing);
                    results.push(json!({
                        "source": "OpenAlex",
                        "title": w.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                        "year": w.get("publication_year").and_then(|x| x.as_i64()).map(|y| y.to_string()).unwrap_or_default(),
                        "venue": w.pointer("/primary_location/source/display_name").and_then(|x| x.as_str()).unwrap_or(""),
                        "url": link,
                        "pdfUrl": pdf,
                    }));
                }
            }
        }
    }

    // 3) Crossref（用整条文献串检索，覆盖最广）
    let url = format!(
        "https://api.crossref.org/works?query.bibliographic={}&rows=3&select=title,DOI,URL,issued,container-title",
        encode_uri_component(&raw.chars().take(220).collect::<String>())
    );
    if let Some(txt) = fetch_text(&agent, &url) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(arr) = v.pointer("/message/items").and_then(|x| x.as_array()) {
                for w in arr {
                    let doi = w.get("DOI").and_then(|x| x.as_str()).unwrap_or("");
                    let link = w
                        .get("URL")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| if doi.is_empty() { String::new() } else { format!("https://doi.org/{}", doi) });
                    results.push(json!({
                        "source": "Crossref",
                        "title": w.get("title").and_then(|x| x.as_array()).and_then(|a| a.first()).and_then(|x| x.as_str()).unwrap_or(""),
                        "year": w.pointer("/issued/date-parts/0/0").and_then(|x| x.as_i64()).map(|y| y.to_string()).unwrap_or_default(),
                        "venue": w.get("container-title").and_then(|x| x.as_array()).and_then(|a| a.first()).and_then(|x| x.as_str()).unwrap_or(""),
                        "url": link,
                        "pdfUrl": "",
                    }));
                }
            }
        }
    }

    // 4) Semantic Scholar：能通就补一条（公开接口经常 429，失败无所谓）。
    //    与 server.js:490 对齐 —— 少这一个源时，同一条文献在 exe 上可能少几条、排序也不同
    //    （desktop/README.md D9，用户可见）。
    let url = format!(
        "https://api.semanticscholar.org/graph/v1/paper/search?query={}&limit=3&fields=title,year,venue,url,openAccessPdf",
        encode_uri_component(&title)
    );
    if let Some(txt) = fetch_text(&agent, &url) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
                for p in arr {
                    results.push(json!({
                        "source": "Semantic Scholar",
                        "title": p.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                        "year": p.get("year").and_then(|x| x.as_i64()).map(|y| y.to_string()).unwrap_or_default(),
                        "venue": p.get("venue").and_then(|x| x.as_str()).unwrap_or(""),
                        "url": p.get("url").and_then(|x| x.as_str()).unwrap_or(""),
                        "pdfUrl": p.pointer("/openAccessPdf/url").and_then(|x| x.as_str()).unwrap_or(""),
                    }));
                }
            }
        }
    }

    // 去重 → 按「标题相似度 + 有没有 PDF 直链」排序
    let mut seen: Vec<String> = Vec::new();
    let mut scored: Vec<(f64, Value)> = Vec::new();
    for mut r in results {
        let key: String = r
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(60)
            .collect();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let t = r.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let has_pdf = r.get("pdfUrl").and_then(|x| x.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        // 与 server.js:515 一致：doi.org / arxiv.org 链接再 +0.1。
        // 少这一项会让「有稳定 DOI 的正式版本」排不过随手抓到的条目（D9）。
        let link = r.get("url").and_then(|x| x.as_str()).unwrap_or("");
        let s = ref_score(&title, t, has_pdf, link);
        if let Some(obj) = r.as_object_mut() {
            obj.remove("score");
        }
        scored.push((s, r));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let list: Vec<Value> = scored.into_iter().take(6).map(|(_, v)| v).collect();

    let search_url = format!(
        "https://www.bing.com/search?q={}",
        encode_uri_component(&format!("{} pdf", title))
    );
    let scholar_url = format!(
        "https://scholar.google.com/scholar?q={}",
        encode_uri_component(&title)
    );

    send_json(
        rq,
        200,
        &json!({
            "query": raw,
            "title": title,
            "results": list,
            "searchUrl": search_url,
            "scholarUrl": scholar_url,
        }),
    );
}

/* ------------------------------------------------- 契约一致性测试 */

/// 这一组测试锁死「与 server.js 逐条等价」的那几处用户可见差异（desktop/README.md D5/D8/D9/D11）。
/// 它们都是**纯函数**，所以不需要联网就能验证 —— 这正是把它们从大函数里抽出来的原因。
#[cfg(test)]
mod tests {
    use super::*;

    /// D11：词元只能以字母开头 —— 纯数字 / 数字开头的串不算词元。
    /// server.js: `s.match(/[a-z][a-z0-9+#._-]*/g)`，`if (w.length >= 2)`。
    #[test]
    fn query_tokens_require_leading_letter() {
        let t = query_tokens("attention 2017 3 x is all you need");
        assert!(t.contains(&"attention".to_string()), "{:?}", t);
        assert!(t.contains(&"is".to_string()), "{:?}", t);
        assert!(t.contains(&"all".to_string()), "{:?}", t);
        // 数字开头的一律不要 —— 这是 D11 的核心
        assert!(!t.contains(&"2017".to_string()), "2017 不该是词元: {:?}", t);
        assert!(!t.contains(&"3".to_string()), "3 不该是词元: {:?}", t);
        // 单字母也不算
        assert!(!t.contains(&"x".to_string()), "单字母不该是词元: {:?}", t);
    }

    /// SSRF 主机分类：公开地址放行，回环 / 私网 / 链路本地 / 云元数据 / 各种等价写法全挡。
    /// 与 server.js 的 `isPrivateHost()` 必须给出完全相同的结论。
    #[test]
    fn private_host_classification() {
        for bad in [
            "127.0.0.1", "127.0.0.1.", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
            "169.254.169.254",          // 云元数据
            "100.64.0.1",               // CGNAT
            "0.0.0.0", "198.18.0.1", "224.0.0.1", "255.255.255.255",
            "999.1.1.1",                // 不合法字面量 → 宁严勿松
            "localhost", "localhost.", "LOCALHOST.", "foo.localhost", "x.local", "y.internal",
            "x.home.arpa", "z.lan", "w.intranet",
            "::1", "::", "[::1]", "[::]", "fe80::1", "fec0::1", "fc00::1", "fd12:3456::1",
            "::ffff:127.0.0.1", "::ffff:169.254.169.254",
            "::ffff:7f00:1", "::ffff:a9fe:a9fe",   // IPv4-mapped 被规范化成十六进制后的形态
            "[::ffff:a9fe:a9fe]", "[::ffff:7f00:1]",
            "ff02::1", "2001:db8::1", "64:ff9b::1", "2002::1",
        ] {
            assert!(is_private_host(bad), "{} 应该被判为内网/保留", bad);
        }
        for good in [
            "example.com", "api.deepseek.com", "arxiv.org", "export.arxiv.org",
            "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "198.20.0.1",
            "223.5.5.5", "100.63.0.1", "100.128.0.1",
            "fcmontreal.example", "fdic.example",   // 不能因为前缀像 fc/fd 就被误伤
        ] {
            assert!(!is_private_host(good), "{} 是公网地址，不该被挡", good);
        }
    }

    /// D11 补充：`gpt-4o` / `c++` / `a_b.c` 这类带符号的照旧可用（首字符是字母）。
    #[test]
    fn query_tokens_keep_symbolic_terms() {        let t = query_tokens("gpt-4o c++ a_b.c");
        assert!(t.contains(&"gpt-4o".to_string()), "{:?}", t);
        assert!(t.contains(&"c++".to_string()), "{:?}", t);
        assert!(t.contains(&"a_b.c".to_string()), "{:?}", t);
    }

    /// D11 补充：中文二字组照旧（与 Node 的 CJK 分支一致），且不受「首字符是字母」影响。
    #[test]
    fn query_tokens_keep_cjk_bigrams() {
        let t = query_tokens("注意力机制");
        assert!(t.contains(&"注意".to_string()), "{:?}", t);
        assert!(t.contains(&"意力".to_string()), "{:?}", t);
    }

    /// D8：有 doi 用 doi；没有就回落到落地页（不能返回空串）。
    #[test]
    fn openalex_link_falls_back_to_landing_page() {
        assert_eq!(openalex_link("https://doi.org/10.1/x", "https://ex.com/land"), "https://doi.org/10.1/x");
        assert_eq!(openalex_link("", "https://ex.com/land"), "https://ex.com/land");
        assert_eq!(openalex_link("", ""), "");
    }

    /// D9：doi.org / arxiv.org 的链接额外 +0.1；有 PDF 直链 +0.35。
    #[test]
    fn ref_score_matches_node_weights() {
        // 标题完全相同 → 相似度 1.0
        let base = ref_score("attention is all you need", "attention is all you need", false, "https://ex.com/a");
        assert!((base - 1.0).abs() < 1e-9, "base={}", base);

        let with_pdf = ref_score("attention is all you need", "attention is all you need", true, "https://ex.com/a");
        assert!((with_pdf - 1.35).abs() < 1e-9, "with_pdf={}", with_pdf);

        let doi = ref_score("attention is all you need", "attention is all you need", true, "https://doi.org/10.1/x");
        assert!((doi - 1.45).abs() < 1e-9, "doi={}", doi);

        let arxiv = ref_score("attention is all you need", "attention is all you need", false, "https://arxiv.org/abs/1706.03762");
        assert!((arxiv - 1.1).abs() < 1e-9, "arxiv={}", arxiv);
    }

    /// D9：加分必须真的影响排序 —— 同相似度下带 DOI 的排前面。
    #[test]
    fn ref_score_boost_actually_reorders() {
        let t = "attention is all you need";
        let plain = ref_score(t, t, false, "https://random.example/x");
        let doi = ref_score(t, t, false, "https://doi.org/10.1/x");
        assert!(doi > plain, "doi={} 应大于 plain={}", doi, plain);
    }
}
