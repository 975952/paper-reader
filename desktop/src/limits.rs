//! 字段白名单 / 范围限制 / 请求体上限 / 错误脱敏。
//!
//! 与 `security.js` 一一对应（审计 §P0 请求体白名单、§P1 配置白名单与大小限制、§P2 脱敏）。
//! 两套后端的判定结果必须一致，所以这里每个常量都注明 Node 那边的对应值。

use serde_json::{json, Map, Value};


/// `/api/chat` 允许出现在请求体里的字段（审计 §P0：只允许 messages / stream /
/// 受限 temperature / max_tokens / 上下文范围）。
pub const CHAT_FIELDS: [&str; 18] = [
    "messages", "stream", "temperature", "max_tokens", "idleMs", "useVision",
    "context", "scope", "doc", "docId", "page", "files", "meta", "webResults", "history",
    // A 线 P2.5：只读工具调用（形状/大小受限，见 pick_tools；与 security.js 一一对应）
    "tools", "tool_choice", "parallel_tool_calls",
];

/// 出现这些字段说明调用方在试图覆盖密钥 / 地址 / 模型 —— 一律忽略。
pub const CHAT_FORBIDDEN: [&str; 7] = [
    "baseURL", "baseUrl", "apiKey", "apikey", "model", "visionModel", "endpoint",
];


pub const TEMPERATURE_MIN: f64 = 0.0;
pub const TEMPERATURE_MAX: f64 = 2.0;
pub const MAX_TOKENS_MIN: i64 = 1;
pub const MAX_TOKENS_MAX: i64 = 131_072;
pub const IDLE_MS_MIN: i64 = 1_000;
pub const IDLE_MS_MAX: i64 = 900_000;
pub const FONT_SIZE_MIN: i64 = 8;
pub const FONT_SIZE_MAX: i64 = 40;

/// 字符串长度上限（字符数），与 security.js 的 LIMITS.str 一致
pub const MAX_API_KEY_LEN: usize = 4096;
pub const MAX_BASE_URL_LEN: usize = 2048;
pub const MAX_MODEL_LEN: usize = 256;
pub const MAX_TARGET_LANG_LEN: usize = 32;
pub const MAX_GLOSSARY_LEN: usize = 100_000;
/// 用户手写的长期记忆（与 security.js 的 LIMITS.str.longTermMemory 一致）
pub const MAX_LONG_TERM_MEMORY_LEN: usize = 4000;

/// A 线 P2.5：工具定义的条数 / 序列化大小上限（与 security.js 的 pickTools 一致）
pub const TOOLS_MAX_ITEMS: usize = 32;
pub const TOOLS_MAX_CHARS: usize = 100_000;


/// 与 security.js 的 BODY_LIMITS 一致。
/// `BODY_CHAT` 就是 server.rs 里的 `MAX_BODY`（通用默认值），列在这里是为了和 Node 对齐。
pub const BODY_CONFIG: usize = 1024 * 1024;
pub const BODY_STATE: usize = 1024 * 1024;
pub const BODY_NOTES: usize = 4 * 1024 * 1024;
pub const BODY_SESSION: usize = 16 * 1024 * 1024;
// 会话 meta 的 PATCH（/api/session 的 PATCH）与文件夹迁移：只改标题/置顶/归档，
// 正常不到 1KB；与 security.js 的 BODY_LIMITS.sessionPatch 一致。
pub const BODY_SESSION_PATCH: usize = 64 * 1024;
// 图片附件（单张）：与 security.js 的 BODY_LIMITS.attachment / server.js 的 ATTACHMENT_LIMIT 一致。
// 图片单独存成文件，不进会话 JSON，所以这是「单张图」的上限。
pub const BODY_ATTACHMENT: usize = 8 * 1024 * 1024;
// 学习档案：全局一份，正常几 KB；与 security.js 的 BODY_LIMITS.profile 一致
pub const BODY_PROFILE: usize = 512 * 1024;
#[allow(dead_code)]
pub const BODY_CHAT: usize = 64 * 1024 * 1024;

/// 学习档案的条目数 / 总字符数 / 单字段长度上限（与 security.js 的 PROFILE_LIMITS 一致）
pub const PROFILE_MAX_ITEMS: usize = 200;
pub const PROFILE_MAX_TOTAL_CHARS: usize = 400_000;
pub const PROFILE_MAX_TOPIC: usize = 120;
pub const PROFILE_MAX_LEVEL: usize = 300;
pub const PROFILE_MAX_BOUNDARY: usize = 2_000;
pub const PROFILE_MAX_SELF_REPORT: usize = 4_000;
pub const PROFILE_MAX_NOTE: usize = 2_000;

pub const NOTES_MAX_ITEMS: usize = 5_000;
pub const NOTES_MAX_CHARS: usize = 4 * 1024 * 1024;
pub const SESSION_MAX_ITEMS: usize = 5_000;
pub const SESSION_MAX_CHARS: usize = 8 * 1024 * 1024;
pub const SESSION_MAX_BYTES: usize = 4 * 1024 * 1024;


/// `/api/config` 只接受这些字段（审计 §P1）
pub const CONFIG_FIELDS: [&str; 12] = [
    "apiKey", "baseURL", "model", "visionModel", "targetLang",
    "temperature", "stream", "idleMs", "theme", "fontSize", "glossary",
    "longTermMemory",
];

fn in_list(list: &[&str], key: &str) -> bool {
    list.iter().any(|k| *k == key)
}

pub fn is_chat_field(key: &str) -> bool {
    in_list(&CHAT_FIELDS, key)
}

pub fn is_chat_forbidden(key: &str) -> bool {
    in_list(&CHAT_FORBIDDEN, key)
}

fn clamp_f64(v: f64, min: f64, max: f64) -> f64 {
    if v < min {
        min
    } else if v > max {
        max
    } else {
        v
    }
}

/* --------------------------------------------------------------- URL 校验 */

/// 只能 http/https、无凭证、无控制字符、长度受限。
/// 返回 Some(规范化后的原串) 或 None。
pub fn valid_url_string(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > MAX_BASE_URL_LEN {
        return None;
    }
    if s.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7f) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let rest = match lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return None,
    };
    // 凭证（user:pass@host）不允许
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return None;
    }
    // 必须有非空主机名
    let host = if let Some(inner) = authority.strip_prefix('[') {
        match inner.split_once(']') {
            Some((h, _)) => h.to_string(),
            None => return None,
        }
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    if host.is_empty() {
        return None;
    }
    // 结尾的点（localhost. / 127.0.0.1.）拒绝：留着它会让任何按主机名做的判断失效
    if host.ends_with('.') {
        return None;
    }
    Some(s.to_string())
}

/* --------------------------------------------------------- 配置 patch 过滤 */

/// 过滤后的 patch + 被忽略的字段名 + 超长（被拒）的字段
///
/// `capped` 非空时调用方必须返回 400 并且不写盘 —— 审计 §验收 要求
/// 「超限返回 413/400，不截断后静默保存」。绝不静默截断。
pub struct ConfigPatch {
    pub patch: Map<String, Value>,
    pub ignored: Vec<String>,
    /// (字段名, 上限字符数)
    pub capped: Vec<(String, usize)>,
}

/// 严格白名单 + 类型/范围/长度限制（审计 §P1）。
///
/// 与 server.js 的 `sanitizeConfigPatch()` 行为一致：
///   * 未知字段 → 忽略；
///   * `temperature` / `idleMs` / `fontSize` → 夹到范围内（设置页是滑块，
///     不能因为一个越界值把用户其它改动一起丢掉）；
///   * 字符串字段超长 → 记进 `capped`（调用方回 400，不截断）；
///   * `baseURL` → 必须是合法 http(s) URL，非法则忽略；
///   * `apiKey` 空串 → 由调用方保留原值。
pub fn sanitize_config_patch(raw: &Value) -> ConfigPatch {
    let mut patch = Map::new();
    let mut ignored: Vec<String> = Vec::new();
    let mut capped: Vec<(String, usize)> = Vec::new();

    let obj = match raw {
        Value::Object(m) => m,
        _ => {
            ignored.push("<非对象请求体>".to_string());
            return ConfigPatch { patch, ignored, capped };
        }
    };

    // 长度检查：超长记 capped，非字符串记 ignored
    macro_rules! take_str {
        ($key:expr, $v:expr, $limit:expr) => {
            match $v {
                Value::String(s) => {
                    if s.chars().count() > $limit {
                        capped.push(($key.clone(), $limit));
                    } else {
                        patch.insert($key.clone(), Value::String(s.clone()));
                    }
                }
                _ => ignored.push($key.clone()),
            }
        };
    }

    for (key, v) in obj {
        if !in_list(&CONFIG_FIELDS, key) {
            ignored.push(key.clone());
            continue;
        }
        match key.as_str() {
            "apiKey" => take_str!(key, v, MAX_API_KEY_LEN),
            "baseURL" => match v {
                Value::String(s) if s.is_empty() => {
                    patch.insert(key.clone(), Value::String(String::new()));
                }
                Value::String(s) => {
                    if s.chars().count() > MAX_BASE_URL_LEN {
                        capped.push((key.clone(), MAX_BASE_URL_LEN));
                    } else {
                        match valid_url_string(s) {
                            Some(u) => {
                                patch.insert(key.clone(), Value::String(u));
                            }
                            None => ignored.push(key.clone()),
                        }
                    }
                }
                _ => ignored.push(key.clone()),
            },
            "model" | "visionModel" => take_str!(key, v, MAX_MODEL_LEN),
            "targetLang" => take_str!(key, v, MAX_TARGET_LANG_LEN),
            "glossary" => take_str!(key, v, MAX_GLOSSARY_LEN),
            "longTermMemory" => take_str!(key, v, MAX_LONG_TERM_MEMORY_LEN),
            "theme" => match v {
                Value::String(s) if s == "light" || s == "dark" => {
                    patch.insert(key.clone(), v.clone());
                }
                _ => ignored.push(key.clone()),
            },
            "temperature" => match v.as_f64() {
                Some(n) => {
                    let c = clamp_f64(n, TEMPERATURE_MIN, TEMPERATURE_MAX);
                    patch.insert(key.clone(), serde_json::json!(c));
                }
                None => ignored.push(key.clone()),
            },
            "idleMs" => match v.as_f64() {
                Some(n) => {
                    let c = clamp_f64(n, IDLE_MS_MIN as f64, IDLE_MS_MAX as f64).round() as i64;
                    patch.insert(key.clone(), serde_json::json!(c));
                }
                None => ignored.push(key.clone()),
            },
            "fontSize" => match v.as_f64() {
                Some(n) => {
                    let c = clamp_f64(n, FONT_SIZE_MIN as f64, FONT_SIZE_MAX as f64).round() as i64;
                    patch.insert(key.clone(), serde_json::json!(c));
                }
                None => ignored.push(key.clone()),
            },
            "stream" => match v {
                Value::Bool(_) => {
                    patch.insert(key.clone(), v.clone());
                }
                _ => ignored.push(key.clone()),
            },
            _ => ignored.push(key.clone()),
        }
    }

    ConfigPatch { patch, ignored, capped }
}

/* ------------------------------------------------------------ 内容上限 */

/// 统计字符串/数组/对象里的总字符数（与 security.js 的 countChars 等价）
pub fn count_chars(v: &Value) -> usize {
    match v {
        Value::String(s) => s.chars().count(),
        Value::Array(a) => a.iter().map(count_chars).sum(),
        Value::Object(m) => m
            .iter()
            .map(|(k, x)| k.chars().count() + count_chars(x))
            .sum(),
        _ => 0,
    }
}

/// notes 的条目数 / 总字符数校验；返回 Err(给用户看的文案)
pub fn check_notes(items: &Value) -> Result<(), String> {
    let arr = match items {
        Value::Array(a) => a,
        _ => return Err("notes.items 必须是数组".to_string()),
    };
    if arr.len() > NOTES_MAX_ITEMS {
        return Err(format!("笔记条目过多（上限 {} 条）", NOTES_MAX_ITEMS));
    }
    if count_chars(items) > NOTES_MAX_CHARS {
        return Err("笔记内容过大，请分文档保存".to_string());
    }
    Ok(())
}

/// session 的条目数 / 总字符数 / 体积校验
pub fn check_session(payload: &Value) -> Result<(), String> {
    let obj = match payload {
        Value::Object(m) => m,
        _ => return Err("会话必须是对象".to_string()),
    };
    for key in ["entries", "history", "ops", "attachments", "files"] {
        if let Some(Value::Array(a)) = obj.get(key) {
            if a.len() > SESSION_MAX_ITEMS {
                return Err(format!("会话 {} 条目过多（上限 {} 条）", key, SESSION_MAX_ITEMS));
            }
        }
    }
    if count_chars(payload) > SESSION_MAX_CHARS {
        return Err("会话内容过大".to_string());
    }
    match serde_json::to_string(payload) {
        Ok(s) if s.len() > SESSION_MAX_BYTES => Err("会话体积过大".to_string()),
        Err(_) => Err("会话包含无法序列化的内容".to_string()),
        Ok(_) => Ok(()),
    }
}

/* ------------------------------------------------------------ 学习档案 */

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 时间格式与 security.js 的 `ISO_LIKE` 一致：
/// `YYYY-MM-DDTHH:MM:SS[.mmm](Z|±HH:MM)`。不用正则（Rust 这边没引入 regex），手写逐位判断。
fn is_iso_like(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 {
        return false;
    }
    if !(b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':') {
        return false;
    }
    for i in [0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !b[i].is_ascii_digit() {
            return false;
        }
    }
    let mut i = 19usize;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let n = i - start;
        if !(1..=3).contains(&n) {
            return false;
        }
    }
    let rest = &b[i..];
    if rest == b"Z" {
        return true;
    }
    rest.len() == 6
        && (rest[0] == b'+' || rest[0] == b'-')
        && rest[3] == b':'
        && rest[1].is_ascii_digit()
        && rest[2].is_ascii_digit()
        && rest[4].is_ascii_digit()
        && rest[5].is_ascii_digit()
}

pub fn check_profile(raw: &Value) -> Result<Value, String> {
    let obj = match raw {
        Value::Object(m) => m,
        _ => return Err("学习档案必须是对象".to_string()),
    };
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("学习档案版本不支持".to_string());
    }
    let items = match obj.get("items") {
        Some(Value::Array(a)) => a,
        _ => return Err("学习档案缺少 items 数组".to_string()),
    };
    if items.len() > PROFILE_MAX_ITEMS {
        return Err(format!("学习档案条目过多（上限 {} 条）", PROFILE_MAX_ITEMS));
    }
    let mut out_items: Vec<Value> = Vec::with_capacity(items.len());
    for (idx, it) in items.iter().enumerate() {
        let io = match it {
            Value::Object(m) => m,
            _ => return Err("学习档案条目必须是对象".to_string()),
        };
        let topic = io
            .get("topic")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if topic.is_empty() {
            return Err("学习档案条目缺少 topic".to_string());
        }
        let status = match io.get("status").and_then(Value::as_str) {
            Some("pending") => "pending",
            Some("confirmed") => "confirmed",
            _ => return Err("学习档案条目状态不合法".to_string()),
        };
        let basis = match io.get("basis").and_then(Value::as_str) {
            Some("user_confirmed") => "user_confirmed",
            Some("user_self_report") => "user_self_report",
            Some("model_inferred") => "model_inferred",
            _ => "user_confirmed",
        };
        let created = match io.get("createdAt").and_then(Value::as_str) {
            Some(s) if is_iso_like(s) => s.to_string(),
            _ => return Err("学习档案条目缺少合法的 createdAt 时间".to_string()),
        };
        let updated = match io.get("updatedAt").and_then(Value::as_str) {
            Some(s) if is_iso_like(s) => s.to_string(),
            _ => created.clone(),
        };
        let last_confirmed = match io.get("lastConfirmedAt").and_then(Value::as_str) {
            Some(s) if is_iso_like(s) => Value::String(s.to_string()),
            _ => Value::Null,
        };
        let aliases: Vec<Value> = match io.get("aliases") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .take(8)
                .map(|s| Value::String(clip(s.trim(), PROFILE_MAX_TOPIC)))
                .collect(),
            _ => Vec::new(),
        };
        let source = match io.get("source") {
            Some(Value::Object(sm)) => json!({
                "docId": clip(sm.get("docId").and_then(Value::as_str).unwrap_or(""), 120),
                "paper": clip(sm.get("paper").and_then(Value::as_str).unwrap_or(""), 300),
                "capability": clip(sm.get("capability").and_then(Value::as_str).unwrap_or(""), 40),
            }),
            _ => Value::Null,
        };
        let id = match io.get("id").and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => clip(s.trim(), 80),
            _ => format!("kp-{}", idx),
        };
        let memory = match io.get("memory").and_then(Value::as_object) {
            Some(m) if matches!(m.get("kind").and_then(Value::as_str), Some("knowledge" | "preference" | "identity"))
                && matches!(m.get("signal").and_then(Value::as_str),
                    Some("self_report" | "needs_help" | "demonstrated" | "inferred" | "preference")) => json!({
                "kind": m["kind"],
                "scope": if m.get("scope").and_then(Value::as_str) == Some("paper") { "paper" } else { "global" },
                "signal": m["signal"],
                "evidence": clip(m.get("evidence").and_then(Value::as_str).unwrap_or("").trim(), 500),
            }),
            _ => Value::Null,
        };
        out_items.push(json!({
            "id": id,
            "topic": clip(topic.trim(), PROFILE_MAX_TOPIC),
            "aliases": aliases,
            "level": clip(io.get("level").and_then(Value::as_str).unwrap_or(""), PROFILE_MAX_LEVEL),
            "boundary": clip(io.get("boundary").and_then(Value::as_str).unwrap_or(""), PROFILE_MAX_BOUNDARY),
            "basis": basis,
            "status": status,
            "createdAt": created,
            "updatedAt": updated,
            "lastConfirmedAt": last_confirmed,
            "source": source,
            "note": clip(io.get("note").and_then(Value::as_str).unwrap_or(""), PROFILE_MAX_NOTE),
            "memory": memory,
        }));
    }
    let revision = obj.get("revision").and_then(Value::as_u64).unwrap_or(0);
    let updated_at = match obj.get("updatedAt").and_then(Value::as_str) {
        Some(s) if is_iso_like(s) => Value::String(s.to_string()),
        _ => Value::String(String::new()),
    };
    let self_report_at = match obj.get("selfReportAt").and_then(Value::as_str) {
        Some(s) if is_iso_like(s) => Value::String(s.to_string()),
        _ => Value::String(String::new()),
    };
    let value = json!({
        "version": 1,
        "revision": revision,
        "updatedAt": updated_at,
        "selfReport": clip(obj.get("selfReport").and_then(Value::as_str).unwrap_or("").trim(), PROFILE_MAX_SELF_REPORT),
        "selfReportAt": self_report_at,
        "items": out_items,
    });
    if count_chars(&value) > PROFILE_MAX_TOTAL_CHARS {
        return Err("学习档案内容过大".to_string());
    }
    Ok(value)
}

/* -------------------------------------------------------------- 脱敏 */

/// 请求体里的 temperature：必须落在 [0,2] 内。
/// `None` 表示「没传」（用默认值）；`Some(Err)` 表示越界，调用方回 400。
pub fn pick_temperature(v: Option<&Value>) -> Result<Option<f64>, String> {
    let raw = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(x) => x,
    };
    let n = match raw.as_f64() {
        Some(n) if raw.is_number() => n,
        _ => return Err("temperature 必须是数字".to_string()),
    };
    if !n.is_finite() || n < TEMPERATURE_MIN || n > TEMPERATURE_MAX {
        return Err(format!(
            "temperature 超出范围（允许 {} ~ {}）",
            TEMPERATURE_MIN, TEMPERATURE_MAX
        ));
    }
    Ok(Some(n))
}

/// 请求体里的 max_tokens：正整数且不超上限
pub fn pick_max_tokens(v: Option<&Value>) -> Result<Option<i64>, String> {
    let raw = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) if s.is_empty() => return Ok(None),
        Some(x) => x,
    };
    let n = match raw.as_i64() {
        Some(n) if raw.is_number() => n,
        _ => return Err("max_tokens 必须是正整数".to_string()),
    };
    if n < MAX_TOKENS_MIN {
        return Err("max_tokens 必须是正整数".to_string());
    }
    if n > MAX_TOKENS_MAX {
        return Err(format!("max_tokens 超出上限（最大 {}）", MAX_TOKENS_MAX));
    }
    Ok(Some(n))
}

/// A 线 P2.5：`tools` 请求字段的受限透传（与 security.js 的 pickTools 一一对应）。
/// 只接受 OpenAI function 形状、≤32 个、序列化后 ≤100KB；不合规返回 Err（→ 400）。
pub fn pick_tools(v: Option<&Value>) -> Result<Option<Value>, String> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) => a,
        _ => return Err("tools 必须是数组".to_string()),
    };
    if arr.is_empty() {
        return Ok(None);
    }
    if arr.len() > TOOLS_MAX_ITEMS {
        return Err(format!("tools 最多 {} 个", TOOLS_MAX_ITEMS));
    }
    let mut out: Vec<Value> = Vec::new();
    for item in arr {
        let obj = match item {
            Value::Object(m) => m,
            _ => return Err("tools 每一项必须是对象".to_string()),
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("function") {
            return Err("tools 只支持 type=function".to_string());
        }
        let func = match obj.get("function") {
            Some(Value::Object(f)) => f,
            _ => return Err("tools.function 必须是对象".to_string()),
        };
        let name = func.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !valid_tool_name(name) {
            return Err(format!(
                "工具名不合法：{}",
                name.chars().take(40).collect::<String>()
            ));
        }
        if let Some(d) = func.get("description") {
            if !d.is_string() {
                return Err("工具 description 必须是字符串".to_string());
            }
        }
        if let Some(p) = func.get("parameters") {
            if !p.is_object() {
                return Err("工具 parameters 必须是对象".to_string());
            }
        }
        let description: String = func
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect();
        let parameters = func
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        out.push(json!({
            "type": "function",
            "function": { "name": name, "description": description, "parameters": parameters },
        }));
    }
    let encoded = serde_json::to_string(&out).map_err(|_| "tools 无法序列化".to_string())?;
    if encoded.len() > TOOLS_MAX_CHARS {
        return Err("tools 定义太大".to_string());
    }
    Ok(Some(Value::Array(out)))
}

fn valid_tool_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap_or(' ');
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `tool_choice`：auto / none / required / {type:'function',function:{name}}，
/// 且 name 必须是本次 tools 里声明过的工具。
pub fn pick_tool_choice(v: Option<&Value>, tools: Option<&Value>) -> Result<Option<Value>, String> {
    let raw = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(x) => x,
    };
    let tool_list = match tools {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Ok(None),
    };
    if let Value::String(s) = raw {
        return if s == "auto" || s == "none" || s == "required" {
            Ok(Some(Value::String(s.clone())))
        } else {
            Err(format!("tool_choice 不合法：{}", s))
        };
    }
    if let Value::Object(m) = raw {
        if m.get("type").and_then(|t| t.as_str()) != Some("function") {
            return Err("tool_choice 不合法".to_string());
        }
        let name = m
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("");
        if !valid_tool_name(name) {
            return Err("tool_choice 不合法".to_string());
        }
        let declared = tool_list.iter().any(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                == Some(name)
        });
        if !declared {
            return Err(format!("tool_choice 指向未声明的工具：{}", name));
        }
        return Ok(Some(json!({ "type": "function", "function": { "name": name } })));
    }
    Err("tool_choice 不合法".to_string())
}

/// 把底层异常 / 上游响应变成可以给用户看的文案。
/// 与本机路径无关的信息保留，绝对路径 / 完整 URL / token 打码。
pub fn sanitize_message(msg: &str, fallback: &str) -> String {
    let raw = msg.trim();
    if raw.is_empty() {
        return fallback.to_string();
    }
    let first = raw
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let t = scrub_text(first);
    let t: String = t.chars().take(300).collect();
    if t.trim().is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

/// 日志 / 用户文案里的敏感内容打码（与 security.js 的 scrubText 等价）。
///
/// 三件事：密文（Bearer / apiKey / token 的值）、本机绝对路径、本次的 token 本身。
pub fn scrub_text(s: &str) -> String {
    let mut t = s.to_string();
    t = redact_after(&t, "Bearer ", 6);
    t = redact_key_values(&t);
    t = redact_paths(&t);
    let tok = crate::auth::token();
    if !tok.is_empty() {
        t = t.replace(tok, "***");
    }
    t
}

/// 键值对里的密文：支持 `"apiKey": "sk-xxx"` / `apiKey=sk-xxx` / `apiKey: sk-xxx`，
/// 也支持被截断的 JSON（尾部引号已经丢了）。
fn redact_key_values(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let keys = ["apikey", "authorization", "token", "x-prt-token"];
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        // 键名可能带引号，所以从后一个字符开始比对
        let start = if chars[i] == '"' || chars[i] == '\'' { i + 1 } else { i };
        let mut matched: Option<usize> = None;
        for k in keys {
            let n = k.chars().count();
            if start + n <= chars.len() {
                let cand: String = chars[start..start + n].iter().collect::<String>().to_ascii_lowercase();
                if cand == k {
                    matched = Some(start + n);
                    break;
                }
            }
        }
        let after = match matched {
            Some(a) => a,
            None => {
                out.push(chars[i]);
                i += 1;
                continue;
            }
        };
        // 键名整段照抄，再找分隔符
        out.extend(&chars[i..after]);
        let mut j = after;
        // 允许 "key" : value（键名后面还有个引号）
        if j < chars.len() && (chars[j] == '"' || chars[j] == '\'') {
            out.push(chars[j]);
            j += 1;
        }
        while j < chars.len() && chars[j] == ' ' {
            out.push(chars[j]);
            j += 1;
        }
        if j >= chars.len() || (chars[j] != '=' && chars[j] != ':') {
            i = after;
            continue;
        }
        out.push(chars[j]);
        j += 1;
        while j < chars.len() && chars[j] == ' ' {
            out.push(chars[j]);
            j += 1;
        }
        // 值：可选引号包裹，到引号 / 逗号 / 空白为止；够长才打码
        let mut quote: Option<char> = None;
        if j < chars.len() && (chars[j] == '"' || chars[j] == '\'') {
            quote = Some(chars[j]);
            out.push(chars[j]);
            j += 1;
        }
        let vstart = j;
        while j < chars.len() {
            let c = chars[j];
            match quote {
                Some(q) if c == q => break,
                Some(_) => j += 1,
                None if c.is_whitespace() || c == ',' || c == '&' || c == '}' || c == ']' => break,
                None => j += 1,
            }
        }
        if j - vstart >= 6 {
            out.push_str("***");
        } else {
            out.extend(&chars[vstart..j]);
        }
        i = j;
    }
    out
}

fn redact_after(s: &str, needle: &str, min_len: usize) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(needle) {
        out.push_str(&rest[..i + needle.len()]);
        out.push_str("***");
        let tail = &rest[i + needle.len()..];
        // 吃掉紧跟其后的密文
        let n = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || "-._~+/=".contains(*c))
            .count();
        if n >= min_len {
            rest = &tail[tail.char_indices().nth(n).map(|(i, _)| i).unwrap_or(tail.len())..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// 本机绝对路径 → `<path>`。
///
/// 难点：同一个路径在日志里可能是原样的（`C:\Users\John Doe\…`），也可能被 JSON
/// 转义过（`C:\\Users\\John Doe\\…`）。所以分隔符统一按「一个或多个 `\` / `/`」处理，
/// 段内允许空格 —— 否则 `John Doe` 会把路径截成两半。
fn redact_paths(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        let drive = i + 2 < chars.len()
            && c.is_ascii_alphabetic()
            && chars[i + 1] == ':'
            && (chars[i + 2] == '\\' || chars[i + 2] == '/');
        // UNC（\\server\share）或 JSON 转义后的分隔符
        let unc = c == '\\'
            && i + 2 < chars.len()
            && chars[i + 1] == '\\'
            && (chars[i + 2].is_alphanumeric() || chars[i + 2] == '_');
        if !drive && !unc {
            out.push(c);
            i += 1;
            continue;
        }
        out.push_str("<path>");
        i += if drive { 3 } else { 2 };
        let mut prev_sep = true;
        while i < chars.len() {
            let ch = chars[i];
            if ch == '\\' || ch == '/' {
                prev_sep = true;
                i += 1;
                continue;
            }
            if ch.is_whitespace() {
                // 路径里允许空格，但下一个字符必须还是路径的一部分（首字符不能是分隔符）
                match chars.get(i + 1) {
                    Some(n) if !n.is_whitespace() && *n != '\\' && *n != '/' => {
                        prev_sep = false;
                        i += 1;
                        continue;
                    }
                    _ => break,
                }
            }
            if "\"',;)]}".contains(ch) {
                break;
            }
            let _ = prev_sep;
            i += 1;
        }
        continue;
    }
    out
}

/// 本机绝对路径 → <path>
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 身份类记忆（kind=identity）与 Node 同契约：双端都接受；未知 kind 降级为 null（不整份拒绝）。
    #[test]
    fn profile_accepts_identity_memory_kind() {
        let profile = json!({
            "version": 1, "revision": 0, "updatedAt": "", "selfReport": "", "selfReportAt": "",
            "items": [
                {
                    "id": "mem-1", "topic": "称呼", "aliases": [], "level": "称呼：Cyan", "boundary": "",
                    "basis": "user_self_report", "status": "confirmed",
                    "createdAt": "2026-11-01T10:00:00+08:00", "updatedAt": "2026-11-01T10:00:00+08:00",
                    "lastConfirmedAt": "2026-11-01T10:00:00+08:00",
                    "source": { "docId": "paper-a", "paper": "x", "capability": "chat" },
                    "note": "",
                    "memory": { "kind": "identity", "scope": "global", "signal": "self_report", "evidence": "我叫Cyan请记住" }
                },
                {
                    "id": "mem-2", "topic": "旧条目", "aliases": [], "level": "", "boundary": "",
                    "basis": "model_inferred", "status": "pending",
                    "createdAt": "2026-11-01T10:00:00+08:00", "updatedAt": "2026-11-01T10:00:00+08:00",
                    "memory": { "kind": "unknown-kind", "scope": "global", "signal": "inferred", "evidence": "x" }
                }
            ]
        });
        let got = check_profile(&profile).expect("identity memory 必须被接受");
        let items = got["items"].as_array().unwrap();
        assert_eq!(items[0]["memory"]["kind"], json!("identity"));
        assert_eq!(items[0]["memory"]["evidence"], json!("我叫Cyan请记住"));
        assert!(items[1]["memory"].is_null(), "未知 kind 应该降级为 null，而不是整份拒绝");
    }

    #[test]
    fn config_whitelist_blocks_unknown_and_clamps() {
        let raw = json!({
            "apiKey": "sk-secret",
            "temperature": 99.0,
            "idleMs": 5,
            "evil": "x",
            "baseURL": "file:///etc/passwd",
            "theme": "neon"
        });
        let got = sanitize_config_patch(&raw);
        assert_eq!(got.patch.get("apiKey").unwrap(), &json!("sk-secret"));
        assert_eq!(got.patch.get("temperature").unwrap(), &json!(2.0));
        assert_eq!(got.patch.get("idleMs").unwrap(), &json!(1000));
        assert!(!got.patch.contains_key("evil"));
        assert!(!got.patch.contains_key("baseURL"));
        assert!(!got.patch.contains_key("theme"));
        assert!(got.ignored.contains(&"evil".to_string()));
        assert!(got.capped.is_empty(), "没有超长字段时 capped 必须为空");
    }

    /// 审计 §验收：「超限返回 413/400，不截断后静默保存」。
    /// 5000 字的 model 必须出现在 capped 里、不能被截成 256 字写进 patch。
    #[test]
    fn oversized_strings_are_rejected_not_truncated() {
        let long_model = "m".repeat(5000);
        let got = sanitize_config_patch(&json!({ "model": long_model, "theme": "dark" }));
        assert!(!got.patch.contains_key("model"), "超长 model 不能进 patch");
        assert_eq!(got.capped, vec![("model".to_string(), MAX_MODEL_LEN)]);
        assert_eq!(got.patch.get("theme").unwrap(), &json!("dark"), "同批次的合法字段照常处理");

        // baseURL 超长同样拒绝（不是先截断再 parse）
        let got = sanitize_config_patch(&json!({ "baseURL": format!("https://x.com/{}", "a".repeat(3000)) }));
        assert!(!got.patch.contains_key("baseURL"));
        assert_eq!(got.capped.len(), 1);

        // apiKey / targetLang / glossary 也一样
        for (field, limit) in [
            ("apiKey", MAX_API_KEY_LEN),
            ("targetLang", MAX_TARGET_LANG_LEN),
            ("glossary", MAX_GLOSSARY_LEN),
        ] {
            let got = sanitize_config_patch(&json!({ field: "z".repeat(limit + 1) }));
            assert!(!got.patch.contains_key(field), "{} 不该被保存", field);
            assert_eq!(got.capped, vec![(field.to_string(), limit)]);
        }

        // 恰好等于上限：必须放行（既有测试套件会 POST 正常长度的值）
        let got = sanitize_config_patch(&json!({ "model": "m".repeat(MAX_MODEL_LEN) }));
        assert!(got.capped.is_empty(), "恰好等于上限不该被拒");
        assert_eq!(got.patch.get("model").unwrap().as_str().unwrap().chars().count(), MAX_MODEL_LEN);
    }

    #[test]
    fn config_url_requires_http_without_credentials() {
        assert!(valid_url_string("https://api.deepseek.com/v1").is_some());
        assert!(valid_url_string("http://127.0.0.1:11434/v1").is_some());
        assert!(valid_url_string("file:///C:/x").is_none());
        assert!(valid_url_string("https://user:pass@evil.com/v1").is_none());
        assert!(valid_url_string("https://evil.com/\r\nX: y").is_none());
        assert!(valid_url_string("javascript:alert(1)").is_none());
        assert!(valid_url_string("").is_none());
    }

    #[test]
    fn chat_limits_match_node() {
        assert!(pick_temperature(Some(&json!(0.2))).unwrap() == Some(0.2));
        assert!(pick_temperature(Some(&json!(2.0))).is_ok());
        assert!(pick_temperature(Some(&json!(2.5))).is_err());
        assert!(pick_temperature(Some(&json!(-0.1))).is_err());
        assert!(pick_temperature(Some(&json!("x"))).is_err());
        assert!(pick_temperature(None).unwrap().is_none());
        assert_eq!(pick_max_tokens(Some(&json!(10))).unwrap(), Some(10));
        assert!(pick_max_tokens(Some(&json!(0))).is_err());
        assert!(pick_max_tokens(Some(&json!(1.5))).is_err());
        assert!(pick_max_tokens(Some(&json!(200000))).is_err());
        assert!(pick_max_tokens(Some(&json!(131072))).is_ok());
    }

    #[test]
    fn content_limits() {
        let ok = json!([{"text": "hi"}]);
        assert!(check_notes(&ok).is_ok());
        let many: Vec<Value> = (0..NOTES_MAX_ITEMS + 1).map(|_| json!({})).collect();
        assert!(check_notes(&Value::Array(many)).is_err());
        assert!(check_notes(&json!({"not": "array"})).is_err());
        assert!(check_session(&json!({"entries": [], "history": []})).is_ok());
        assert!(check_session(&json!([1, 2])).is_err());
    }

    #[test]
    fn scrub_hides_keys_and_paths() {
        // 真实形态一：Windows 路径被 JSON 转义了一遍
        let s = scrub_text(r"connect C:\\Users\\John Doe\\Desktop\\prt\\data\\config.json failed");
        assert!(!s.contains("Users"), "转义路径没打码: {}", s);
        assert!(s.contains("<path>"), "{}", s);
        // 真实形态二：未转义的裸路径
        let s = scrub_text(r"写入 C:\Users\John Doe\Desktop\prt\data\a.json 失败");
        assert!(!s.contains("Users"), "裸路径没打码: {}", s);
        // 密钥：完整 JSON / 等号形式 / 被截断的 JSON 都要打码
        for raw in [
            r#"{"apiKey": "sk-abcdef123456"}"#,
            "apiKey=sk-abcdef123456",
            r#"{"apiKey": "sk-abcdef12345"#,
            "Authorization: Bearer sk-abcdef123456",
        ] {
            let got = scrub_text(raw);
            assert!(!got.contains("sk-abcdef123456"), "{} -> {}", raw, got);
            assert!(!got.contains("abcdef12345"), "{} -> {}", raw, got);
        }
        // 不该误伤正常文案
        assert_eq!(scrub_text("模型没有返回任何内容"), "模型没有返回任何内容");
    }

    /// A 线 P2.5：tools 的受限透传必须与 Node 端 security.js 同契约。
    #[test]
    fn chat_tools_whitelist_and_shape() {
        // 缺省 / 空数组 → 不转发
        assert!(pick_tools(None).unwrap().is_none());
        assert!(pick_tools(Some(&json!([]))).unwrap().is_none());
        // 非数组 / 非 function / 坏工具名 → 400
        assert!(pick_tools(Some(&json!("nope"))).is_err());
        assert!(pick_tools(Some(&json!([{"type": "other"}]))).is_err());
        assert!(pick_tools(Some(&json!([{"type": "function", "function": {"name": "bad name!"}}]))).is_err());
        // 合法定义 → 原样（收敛到白名单字段后）转发
        let ok = pick_tools(Some(&json!([{
            "type": "function",
            "function": {"name": "read_page", "description": "读页", "parameters": {"type": "object"}}
        }]))).unwrap().unwrap();
        assert_eq!(ok[0]["function"]["name"], json!("read_page"));
        assert_eq!(ok[0]["function"]["description"], json!("读页"));
        // tool_choice：auto 合法；未声明工具 / 非法字符串 → 400
        let tools = Some(&ok);
        assert_eq!(
            pick_tool_choice(Some(&json!("auto")), tools).unwrap(),
            Some(json!("auto"))
        );
        assert!(pick_tool_choice(Some(&json!("whatever")), tools).is_err());
        assert!(pick_tool_choice(
            Some(&json!({"type": "function", "function": {"name": "search_paper"}})),
            tools
        )
        .is_err());
        assert!(pick_tool_choice(
            Some(&json!({"type": "function", "function": {"name": "read_page"}})),
            tools
        )
        .is_ok());
    }
}
