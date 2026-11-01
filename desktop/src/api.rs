//! 本地 HTTP 接口：静态资源 + papers / pdf / config / state / notes / health。
//!
//! 每个处理函数的返回体、状态码、字段名都和 server.js 一一对应，
//! 因为前端 public/js/*.js 已经按那个契约写死了。

use std::collections::HashSet;
use std::fs::File;
use std::io::{empty, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// 用户手工排好的书架顺序（与 server.js 的 `papers-order.json` 同一份数据）。
/// 顺序只写 data/，不改 papers/ 里的文件名 —— 文件名是 docId / 笔记 / 会话的主键。
fn paper_order() -> Vec<String> {
    let v = store::read_json("papers-order.json", json!({ "order": [] }));
    match v.get("order").and_then(|x| x.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        None => Vec::new(),
    }
}

fn write_paper_order(order: &[String]) -> bool {
    store::write_json("papers-order.json", &json!({ "order": order }))
}

/// 校验前端传来的顺序：收 papers/ 里合法相对路径（根 PDF、文件夹、夹内 PDF）。
/// 允许 '/'（文件夹层级），拒绝 \、控制符、..、隐藏路径段（对齐 server.js 的 sanitizePaperOrder）
fn sanitize_paper_order(body: &[u8]) -> Option<Vec<String>> {
    let payload = parse_json(body).ok()?;
    let arr = payload.get("order")?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for v in arr {
        let raw = match v.as_str() {
            Some(s) => s.trim(),
            None => continue,
        };
        if raw.is_empty() || raw.len() > 200 {
            continue;
        }
        if raw.contains('\\') || raw.contains('\0') || raw.contains("..") {
            continue;
        }
        if raw.starts_with('/') || raw.ends_with('/') || raw.split('/').any(|s| s.starts_with('.')) {
            continue;
        }
        if out.iter().any(|x| x == raw) {
            continue;
        }
        out.push(raw.to_string());
        if out.len() >= 5000 {
            break;
        }
    }
    Some(out)
}

/// 用户传来的相对路径规范化：\ 归一为 /、去前导 /、去首尾空白
fn normalize_rel(p: &str) -> String {
    let s = p.replace('\\', "/");
    s.trim_start_matches('/').trim().to_string()
}

/// 文件夹名清洗：去掉路径分隔符与控制符，返回干净 basename
fn sanitize_folder_name(name: &str) -> Option<String> {
    let mut n: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    n = n.trim_start_matches(['.', ' ', '\t']).trim_end_matches(['.', ' ', '\t']).to_string();
    if n.is_empty() || n == "." || n == ".." {
        return None;
    }
    n = n.chars().take(80).collect();
    Some(n)
}

/// 在指定目录里找不重名的文件夹名（重名加 (2)(3)）
fn unique_folder_name(dir: &std::path::Path, base: &str) -> String {
    for i in 1..200u32 {
        let candidate = if i == 1 { base.to_string() } else { format!("{} ({})", base, i) };
        if std::fs::metadata(dir.join(&candidate)).is_err() {
            return candidate;
        }
    }
    format!("{}-{}", base, now_millis())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 在指定目录里找不重名的 PDF 文件名（重名加 (2)(3)）；size 同则视为同一份直接复用
fn unique_pdf_name_in_dir(dir: &std::path::Path, base: &str, size: u64) -> String {
    let stem = base
        .strip_suffix(".pdf")
        .or_else(|| base.strip_suffix(".PDF"))
        .unwrap_or(base);
    for i in 1..200u32 {
        let candidate = if i == 1 {
            base.to_string()
        } else {
            format!("{} ({}).pdf", stem, i)
        };
        let abs = dir.join(&candidate);
        match std::fs::metadata(&abs) {
            Ok(m) if m.len() == size => return candidate, // 同一份文件，不重复存
            Ok(_) => continue,                            // 同名不同大小，换个名字
            Err(_) => return candidate,                   // 不存在，就用它
        }
    }
    format!("{}-{}.pdf", stem, now_millis())
}

/// 解析目标文件夹：''=根；非空必须是存在的文件夹（不存在则尝试创建，供导入用）
fn resolve_target_dir(folder_rel: &str) -> Option<std::path::PathBuf> {
    if folder_rel.is_empty() {
        return Some(dirs().papers.clone());
    }
    let abs = safe_join(&dirs().papers, folder_rel)?;
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => Some(abs),
        Ok(_) => None,
        Err(_) => {
            let _ = std::fs::create_dir_all(&abs);
            std::fs::metadata(&abs).map(|_| abs).ok()
        }
    }
}

/// 全库按 basename 找 PDF（旧 ?name= 链接回退用），取第一个命中的绝对路径
fn find_pdf_by_basename(dir: &std::path::Path, base: &str) -> Option<std::path::PathBuf> {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(hit) = find_pdf_by_basename(&p, base) {
                    return Some(hit);
                }
            } else if entry.file_name().to_string_lossy() == base {
                return Some(p);
            }
        }
    }
    None
}

/// /api/papers：GET 列表 / POST 保存顺序 / DELETE 删除
pub fn papers(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    match method {
        Method::Get => papers_list(rq),
        Method::Post => match sanitize_paper_order(body) {
            Some(order) => {
                if !write_paper_order(&order) {
                    return send_json(rq, 500, &err_json("保存文件顺序失败，请检查磁盘空间与目录权限"));
                }
                send_json(rq, 200, &json!({ "ok": true, "count": order.len() }))
            }
            None => send_json(rq, 400, &err_json("请求体缺少 order 数组")),
        },
        Method::Delete => papers_delete(rq, raw_query),
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

fn papers_list(rq: Request) {
    let dir = &dirs().papers;
    let order = paper_order();
    let rank: std::collections::HashMap<String, usize> =
        order.iter().enumerate().map(|(i, n)| (n.clone(), i)).collect();

    // 扫描一层目录：返回直接子项（文件夹 + PDF），已按 order 排序。
    // 没排过序的**保持目录扫描顺序、排在已排序项之后**（用户口径：左侧文档不做自动排序，
    // 不再按 mtime 倒序）；随后在 papers_list 末尾把看到的顺序冻结进 papers-order.json。
    fn scan_dir(dir: &std::path::Path, rel: &str, rank: &std::collections::HashMap<String, usize>) -> Vec<(bool, String, String, u64, u64)> {
        // (is_folder, name, rel, mtime, size)
        let mut items: Vec<(bool, String, String, u64, u64)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.contains('\\') || name.contains('/') || name.contains('\0') {
                    continue;
                }
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                let md = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if md.is_dir() {
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    items.push((true, name, child_rel, mtime, 0));
                } else if md.is_file() && name.to_ascii_lowercase().ends_with(".pdf") {
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    items.push((false, name, child_rel, mtime, md.len()));
                }
            }
        }
        items.sort_by(|a, b| {
            let ra = rank.get(&a.2);
            let rb = rank.get(&b.2);
            match (ra, rb) {
                // 都没排过：保持 readdir 顺序（sort_by 是稳定排序）
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(x), Some(y)) => x.cmp(y),
            }
        });
        items
    }

    // 递归收集文件夹树
    fn collect_tree(
        dir: &std::path::Path,
        rel: &str,
        rank: &std::collections::HashMap<String, usize>,
        folders: &mut Vec<Value>,
        papers: &mut Vec<Value>,
    ) {
        for (is_folder, name, child_rel, mtime, size) in scan_dir(dir, rel, rank) {
            if is_folder {
                folders.push(json!({ "name": name, "path": child_rel }));
                collect_tree(&dir.join(&name), &child_rel, rank, folders, papers);
            } else {
                papers.push(json!({
                    "name": name,
                    "folder": rel,
                    "path": child_rel,
                    "size": size,
                    "mtime": mtime,
                    "docId": doc_id_of(&name),
                    "url": format!("/api/pdf?path={}", encode_uri_component(&child_rel)),
                }));
            }
        }
    }

    let mut folders: Vec<Value> = Vec::new();
    let mut papers: Vec<Value> = Vec::new();
    collect_tree(dir, "", &rank, &mut folders, &mut papers);

    // 「不做自动排序」：把这次看到的完整顺序冻结进 order 文件（已有条目保持原顺序，
    // 新出现的按显示位置追加），之后只有用户手动拖拽才会改变顺序。
    let mut seen: Vec<String> = Vec::new();
    for f in &folders {
        if let Some(p) = f.get("path").and_then(|v| v.as_str()) {
            seen.push(p.to_string());
        }
    }
    for p in &papers {
        if let Some(path) = p.get("path").and_then(|v| v.as_str()) {
            seen.push(path.to_string());
        }
    }
    {
        let seen_set: std::collections::HashSet<&str> = seen.iter().map(|s| s.as_str()).collect();
        let kept: Vec<String> = order.iter().filter(|rel| seen_set.contains(rel.as_str())).cloned().collect();
        let kept_set: std::collections::HashSet<&str> = kept.iter().map(|s| s.as_str()).collect();
        let missing: Vec<&String> = seen.iter().filter(|rel| !kept_set.contains(rel.as_str())).collect();
        if !missing.is_empty() || kept.len() != order.len() {
            let mut next = kept;
            next.extend(missing.into_iter().cloned());
            let _ = write_paper_order(&next);
        }
    }

    // count = 直接子 PDF 数（不含子文件夹里的）
    let mut by_dir: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for p in &papers {
        let f = p.get("folder").and_then(|v| v.as_str()).unwrap_or("");
        *by_dir.entry(f).or_insert(0) += 1;
    }
    for f in &mut folders {
        let key = f.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        f.as_object_mut().map(|o| o.insert("count".to_string(), json!(by_dir.get(key.as_str()).copied().unwrap_or(0))));
    }

    // 审计 §P2：默认不返回本机绝对路径；只有显式开启诊断才给
    let mut payload = Map::new();
    payload.insert("folders".to_string(), Value::Array(folders));
    payload.insert("papers".to_string(), Value::Array(papers));
    if diagnostics() {
        payload.insert(
            "dir".to_string(),
            Value::String(dir.to_string_lossy().to_string()),
        );
    }
    send_json(rq, 200, &Value::Object(payload));
}

/// DELETE /api/papers?path=rel.pdf（兼容 ?name=）—— 删除篇论文文件，并把它从顺序里摘掉。
/// 只删 papers/ 里的 PDF，data/ 里按 docId 存的笔记 / 会话 / 进度保留。
fn papers_delete(rq: Request, raw_query: &str) {
    let rel = normalize_rel(&query_get(raw_query, "path").or_else(|| query_get(raw_query, "name")).unwrap_or_default());
    let abs = match safe_join(&dirs().papers, &rel) {
        Some(p) => p,
        None => return send_json(rq, 400, &err_json("非法文件名")),
    };
    let name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if !name.to_ascii_lowercase().ends_with(".pdf") || name.is_empty() {
        return send_json(rq, 400, &err_json("非法文件名"));
    }
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_file() => {}
        _ => return send_json(rq, 404, &err_json("文件不存在（可能已被手动删除）")),
    }
    if let Err(e) = std::fs::remove_file(&abs) {
        store::log_line(&format!("[delete] {} 失败: {}", rel, e));
        return send_json(rq, 500, &err_json("删除失败：文件可能正被其它程序占用"));
    }
    let mut order = paper_order();
    order.retain(|n| n != &rel);
    let _ = write_paper_order(&order);
    store::log_line(&format!("[delete] {}", rel));
    send_json(rq, 200, &json!({ "ok": true, "name": rel }));
}

/* ----------------------------------------------------------- 文件夹管理 */

/// POST /api/folders?name=xxx —— 根下新建文件夹（重名自动加 (2)）
pub fn folders_create(rq: Request, raw_query: &str) {
    let name = match sanitize_folder_name(&query_get(raw_query, "name").unwrap_or_default()) {
        Some(n) => n,
        None => return send_json(rq, 400, &err_json("文件夹名不合法")),
    };
    let parent = normalize_rel(&query_get(raw_query, "parent").unwrap_or_default()); // '' = 根
    let abs_parent = if parent.is_empty() {
        dirs().papers.clone()
    } else {
        match safe_join(&dirs().papers, &parent) {
            Some(p) if p != dirs().papers.as_path() => p,
            _ => return send_json(rq, 400, &err_json("父文件夹路径不合法")),
        }
    };
    match std::fs::metadata(&abs_parent) {
        Ok(m) if m.is_dir() => {}
        _ => return send_json(rq, 404, &err_json("父文件夹不存在")),
    }
    let final_name = unique_folder_name(&abs_parent, &name);
    match std::fs::create_dir(abs_parent.join(&final_name)) {
        Ok(()) => {
            let rel = if parent.is_empty() {
                final_name.clone()
            } else {
                format!("{}/{}", parent, final_name)
            };
            store::log_line(&format!("[mkdir] {}", rel));
            send_json(rq, 200, &json!({ "ok": true, "name": final_name, "path": rel }))
        }
        Err(e) => {
            store::log_line(&format!("[mkdir] {} 失败: {}", final_name, e));
            send_json(rq, 500, &err_json("创建文件夹失败：请检查磁盘空间与目录权限"))
        }
    }
}

/// PATCH /api/folders {from,to} —— 同级重命名文件夹（order 前缀同步）
pub fn folders_rename(rq: Request, body: &[u8]) {
    let payload = match parse_json(body) {
        Ok(p) => p,
        Err(_) => return send_json(rq, 400, &err_json("请求体不是合法 JSON")),
    };
    let from = payload
        .get("from")
        .and_then(|v| v.as_str())
        .map(normalize_rel)
        .unwrap_or_default();
    let to = match payload.get("to").and_then(|v| v.as_str()).and_then(sanitize_folder_name) {
        Some(t) => t,
        None => return send_json(rq, 400, &err_json("参数不合法")),
    };
    if from.is_empty() {
        return send_json(rq, 400, &err_json("参数不合法"));
    }
    let abs_from = match safe_join(&dirs().papers, &from) {
        Some(p) if p != dirs().papers.as_path() => p,
        _ => return send_json(rq, 400, &err_json("非法路径")),
    };
    match std::fs::metadata(&abs_from) {
        Ok(m) if m.is_dir() => {}
        _ => return send_json(rq, 404, &err_json("文件夹不存在")),
    }
    let abs_to = abs_from.parent().unwrap_or(&dirs().papers).join(&to);
    if std::fs::metadata(&abs_to).is_ok() {
        return send_json(rq, 409, &err_json(&format!("已存在同名文件夹「{}」", to)));
    }
    if let Err(e) = std::fs::rename(&abs_from, &abs_to) {
        store::log_line(&format!("[rename] {} -> {} 失败: {}", from, to, e));
        return send_json(rq, 500, &err_json("重命名失败：文件夹可能正被其它程序占用"));
    }
    let to_rel = match from.rfind('/') {
        Some(i) => format!("{}/{}", &from[..i], to),
        None => to.clone(),
    };
    let order: Vec<String> = paper_order()
        .into_iter()
        .map(|n| {
            if n == from {
                to_rel.clone()
            } else if let Some(rest) = n.strip_prefix(&format!("{}/", from)) {
                format!("{}/{}", to_rel, rest)
            } else {
                n
            }
        })
        .collect();
    let _ = write_paper_order(&order);
    store::log_line(&format!("[rename] {} -> {}", from, to_rel));
    send_json(rq, 200, &json!({ "ok": true, "from": from, "to": to_rel }));
}

/// DELETE /api/folders?path=folder&mode=to-root|recursive —— 删除文件夹
pub fn folders_delete(rq: Request, raw_query: &str) {
    let rel = normalize_rel(&query_get(raw_query, "path").unwrap_or_default());
    let mode = match query_get(raw_query, "mode").as_deref() {
        Some("recursive") => "recursive",
        _ => "to-root",
    };
    if rel.is_empty() {
        return send_json(rq, 400, &err_json("缺少 path"));
    }
    let abs = match safe_join(&dirs().papers, &rel) {
        Some(p) if p != dirs().papers.as_path() => p,
        _ => return send_json(rq, 400, &err_json("非法路径")),
    };
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => {}
        _ => return send_json(rq, 404, &err_json("文件夹不存在")),
    }
    // 收集该文件夹树下的所有 PDF
    let mut pdfs: Vec<(String, std::path::PathBuf)> = Vec::new();
    fn collect_pdfs(dir: &std::path::Path, rel: &str, out: &mut Vec<(String, std::path::PathBuf)>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.contains('\\') || name.contains('/') || name.contains('\0') {
                    continue;
                }
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                let p = entry.path();
                if p.is_dir() {
                    collect_pdfs(&p, &child_rel, out);
                } else if p.is_file() && name.to_ascii_lowercase().ends_with(".pdf") {
                    out.push((child_rel, p));
                }
            }
        }
    }
    collect_pdfs(&abs, &rel, &mut pdfs);

    let n = pdfs.len();
    if mode == "to-root" {
        // PDF 移到根（同名自动加后缀），再删空文件夹树
        for (_, p) in &pdfs {
            let base = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let final_name = unique_pdf_name_in_dir(&dirs().papers, &base, u64::MAX);
            let _ = std::fs::rename(p, dirs().papers.join(final_name));
        }
    } else {
        // recursive：连同 PDF 一起删（data/ 里按 docId 的笔记/会话/进度保留）
        for (_, p) in &pdfs {
            let _ = std::fs::remove_file(p);
        }
    }
    if let Err(e) = std::fs::remove_dir_all(&abs) {
        store::log_line(&format!("[rmdir] {} 失败: {}", rel, e));
        return send_json(rq, 500, &err_json("删除文件夹失败：文件夹可能正被其它程序占用"));
    }
    let order: Vec<String> = paper_order()
        .into_iter()
        .filter(|n| n != &rel && !n.starts_with(&format!("{}/", rel)))
        .collect();
    let _ = write_paper_order(&order);
    store::log_line(&format!("[rmdir] {} mode={} pdfs={}", rel, mode, n));
    send_json(rq, 200, &json!({ "ok": true, "path": rel, "mode": mode, "moved": n }));
}

/// POST /api/move {from,to} —— 移动 PDF / 文件夹（含拖出拖入）；to='' 表示根
pub fn move_item(rq: Request, body: &[u8]) {
    let payload = match parse_json(body) {
        Ok(p) => p,
        Err(_) => return send_json(rq, 400, &err_json("请求体不是合法 JSON")),
    };
    let from = payload
        .get("from")
        .and_then(|v| v.as_str())
        .map(normalize_rel)
        .unwrap_or_default();
    let to = payload
        .get("to")
        .and_then(|v| v.as_str())
        .map(normalize_rel)
        .unwrap_or_default();
    if from.is_empty() {
        return send_json(rq, 400, &err_json("缺少 from"));
    }
    let abs_from = match safe_join(&dirs().papers, &from) {
        Some(p) => p,
        None => return send_json(rq, 400, &err_json("非法路径")),
    };
    let md = match std::fs::metadata(&abs_from) {
        Ok(m) => m,
        Err(_) => return send_json(rq, 404, &err_json("源不存在（可能已被删除）")),
    };
    let is_folder = md.is_dir();

    let abs_to_dir = if to.is_empty() {
        dirs().papers.clone()
    } else {
        match safe_join(&dirs().papers, &to) {
            Some(p) => match std::fs::metadata(&p) {
                Ok(m) if m.is_dir() => p,
                Ok(_) => return send_json(rq, 400, &err_json("目标不是文件夹")),
                Err(_) => return send_json(rq, 404, &err_json("目标文件夹不存在")),
            },
            None => return send_json(rq, 400, &err_json("非法目标路径")),
        }
    };
    // 文件夹移动禁区：不能移到自己或自己的子孙目录里
    if is_folder && (to == from || to.starts_with(&format!("{}/", from))) {
        return send_json(rq, 400, &err_json("不能把文件夹移到自己的子目录里"));
    }

    // 移到自身所在目录：无操作（排序交给 /api/papers；绝不能走「同名同 size 去重」把源文件删了）
    let src_dir = abs_from.parent().map(|p| p.to_path_buf());
    if let Some(sd) = src_dir {
        if sd == abs_to_dir {
            let base = abs_from
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            return send_json(rq, 200, &json!({ "ok": true, "from": from, "to": to, "name": base, "moved": false }));
        }
    }

    let base = abs_from
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let target_abs = abs_to_dir.join(&base);
    let final_name = match std::fs::metadata(&target_abs) {
        Ok(_) if is_folder => unique_folder_name(&abs_to_dir, &base),
        Ok(tm) if tm.len() == md.len() => {
            // 目标已有同一份文件（同名同 size）→ 直接删源，等效移动完成
            let _ = std::fs::remove_file(&abs_from);
            let new_rel = if to.is_empty() { base.clone() } else { format!("{}/{}", to, base) };
            let order: Vec<String> = paper_order().into_iter().filter(|n| n != &from).collect();
            let _ = write_paper_order(&order);
            store::log_line(&format!("[move] {} -> {} (去重)", from, new_rel));
            return send_json(rq, 200, &json!({ "ok": true, "from": from, "to": new_rel, "name": base, "moved": true }));
        }
        Ok(_) => unique_pdf_name_in_dir(&abs_to_dir, &base, md.len()),
        Err(_) => base.clone(),
    };
    let abs_new = abs_to_dir.join(&final_name);
    if let Err(e) = std::fs::rename(&abs_from, &abs_new) {
        store::log_line(&format!("[move] {} -> {} 失败: {}", from, final_name, e));
        return send_json(rq, 500, &err_json("移动失败：文件可能正被其它程序占用"));
    }
    let new_rel = if to.is_empty() {
        final_name.clone()
    } else {
        format!("{}/{}", to, final_name)
    };
    // order 前缀替换 + 去重
    let mut seen: HashSet<String> = HashSet::new();
    let order: Vec<String> = paper_order()
        .into_iter()
        .filter_map(|n| {
            let v = if n == from {
                new_rel.clone()
            } else if is_folder {
                match n.strip_prefix(&format!("{}/", from)) {
                    Some(rest) => format!("{}/{}", new_rel, rest),
                    None => n.clone(),
                }
            } else {
                n.clone()
            };
            if seen.insert(v.clone()) {
                Some(v)
            } else {
                None
            }
        })
        .collect();
    let _ = write_paper_order(&order);
    store::log_line(&format!("[move] {} -> {}", from, new_rel));
    send_json(rq, 200, &json!({ "ok": true, "from": from, "to": new_rel, "name": final_name, "moved": true }));
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
    let has_path = query_get(raw_query, "path").is_some();
    let rel = normalize_rel(
        &query_get(raw_query, "path")
            .or_else(|| query_get(raw_query, "name"))
            .unwrap_or_default(),
    );
    let abs = match safe_join(&dirs().papers, &rel) {
        Some(p) => p,
        None => return send_text(rq, 400, "非法文件名"),
    };
    // ?name= 兼容：根目录找不到时按 basename 全库回退（旧链接）
    let abs = if !has_path {
        match std::fs::metadata(&abs) {
            Ok(m) if m.is_file() => abs,
            _ => match find_pdf_by_basename(&dirs().papers, &rel) {
                Some(hit) => hit,
                None => abs, // 404 由下面 metadata 处理
            },
        }
    } else {
        abs
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
    m.insert("longTermMemory".into(), json!(""));
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

const PROFILE_FIELDS: [&str; 6] = ["model", "baseURL", "apiKey", "visionModel", "temperature", "stream"];

fn model_profiles(cfg: &Value) -> (Vec<Value>, usize) {
    let mut list = cfg.get("modelProfiles").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut current = serde_json::Map::new();
    for key in PROFILE_FIELDS {
        let fallback = match key { "stream" => json!(true), "temperature" => json!(0.2), _ => json!("") };
        current.insert(key.into(), cfg.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(fallback));
    }
    let current = Value::Object(current);
    let active = match list.iter().position(|p| PROFILE_FIELDS.iter().all(|k| p.get(*k) == current.get(*k))) {
        Some(i) => i,
        None => { list.push(current); list.len() - 1 }
    };
    (list, active)
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
            let (profiles, active) = model_profiles(&Value::Object(merged.clone()));
            merged.insert("modelProfiles".into(), json!(profiles.iter().enumerate().map(|(i, p)| json!({
                "id": i.to_string(), "model": p.get("model"), "baseURL": p.get("baseURL"),
                "hasApiKey": p.get("apiKey").map(truthy).unwrap_or(false)
            })).collect::<Vec<_>>()));
            merged.insert("activeProfile".into(), json!(active.to_string()));
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
             * 超长字段 → 400，绝不截断保存（审计 §验收：「超限返回 413/400，
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
            let (profiles, _) = model_profiles(&store::merge(&base, &cur));
            if let Some(selected) = raw.get("selectProfile") {
                let profile = selected.as_str().and_then(|s| profiles.iter().enumerate().find(|(i, _)| i.to_string() == s).map(|(_, p)| p));
                match profile {
                    Some(p) => { for key in PROFILE_FIELDS { next[key] = p[key].clone(); } },
                    None => return send_json(rq, 400, &err_json("模型配置不存在，请重新打开设置")),
                }
            }
            next["modelProfiles"] = json!(profiles);
            next["modelProfiles"] = json!(model_profiles(&next).0);
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

/* ---------------------------------------------------------------- 学习档案 */

pub fn profile(rq: Request, method: &Method, body: &[u8]) {
    static PROFILE_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    match method {
        Method::Get => {
            let cur = store::read_json("learning-profile.json", Value::Null);
            if cur.is_object() {
                send_json(rq, 200, &cur);
            } else {
                send_json(
                    rq,
                    200,
                    &json!({ "version": 1, "revision": 0, "updatedAt": "", "selfReport": "", "selfReportAt": "", "items": [] }),
                );
            }
        }
        Method::Post => {
            let payload = match parse_json(body) {
                Ok(v) => v,
                Err(e) => return send_json(rq, 400, &err_json(&e)),
            };
            match limits::check_profile(&payload) {
                Err(msg) => send_json(rq, 400, &err_json(&msg)),
                Ok(value) => {
                    let _guard = PROFILE_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(header) = rq.headers().iter().find(|h| h.field.equiv("If-Match")) {
                        let cur = store::read_json("learning-profile.json", json!({}));
                        let revision = cur.get("revision").and_then(Value::as_u64).unwrap_or(0);
                        if header.value.as_str().parse::<u64>().ok() != Some(revision)
                            || value.get("revision").and_then(Value::as_u64) != Some(revision + 1) {
                            return send_json(rq, 409, &err_json("学习记忆已更新，请重新读取"));
                        }
                    }
                    if !store::write_json("learning-profile.json", &value) {
                        return send_json(rq, 500, &err_json("保存学习档案失败，请重试"));
                    }
                    send_json(rq, 200, &json!({ "ok": true, "revision": value["revision"].clone() }))
                }
            }
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

fn session_file_resolved(doc: &str, sid: &str) -> String {
    for key in doc_key_candidates(doc) {
        let f = session_file_for(&key, sid);
        if store::read_json_opt(&f).is_some() {
            return f;
        }
    }
    session_file(doc, sid)
}

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

/* ------------------------------------------------- 图片附件（单独存） */

const ATTACHMENT_EXTS: [&str; 3] = ["png", "jpg", "webp"];
static ATTACHMENT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 会话键：与会话文件名共用 doc_id_of(doc)（+ sid），不许带路径分隔符
fn attachment_session_key(doc: &str, sid: &str) -> String {
    let key = doc_id_of(doc);
    if sid.is_empty() {
        key
    } else {
        format!("{}-{}", key, sid)
    }
}

fn attachment_dir(doc: &str, sid: &str) -> PathBuf {
    store::data_path("attachments").join(attachment_session_key(doc, sid))
}

/// 只看文件头判断图片类型（Content-Type / 扩展名都不可信；只接受截图会用的三种）
fn sniff_image_ext(buf: &[u8]) -> Option<&'static str> {
    if buf.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if buf.len() >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some("jpg");
    }
    if buf.len() >= 12 && buf.starts_with(b"RIFF") && buf[8..12] == *b"WEBP" {
        return Some("webp");
    }
    None
}

fn valid_attachment_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 32 位十六进制 id：时间纳秒 + 进程内自增序号（不需要密码学随机，只要不撞名）
fn new_attachment_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = ATTACHMENT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}{:016x}", nanos, seq)
}

/// 从会话 payload 里收集所有还被引用的附件 id（用户条目的 shots[] + retry 里的图片附件）
fn collect_attachment_ids(payload: &Value, out: &mut HashSet<String>) {
    let Some(entries) = payload.get("entries").and_then(|v| v.as_array()) else {
        return;
    };
    for e in entries {
        if let Some(shots) = e.get("shots").and_then(|v| v.as_array()) {
            for s in shots {
                if let Some(id) = s.get("id").and_then(|v| v.as_str()) {
                    if valid_attachment_id(id) {
                        out.insert(id.to_string());
                    }
                }
            }
        }
        let atts = e
            .get("retry")
            .and_then(|r| r.get("attachments"))
            .and_then(|v| v.as_array());
        if let Some(atts) = atts {
            for a in atts {
                if a.get("kind").and_then(|v| v.as_str()) != Some("image") {
                    continue;
                }
                if let Some(id) = a.get("id").and_then(|v| v.as_str()) {
                    if valid_attachment_id(id) {
                        out.insert(id.to_string());
                    }
                }
            }
        }
    }
}

/// 会话保存成功之后调用：删掉本会话目录里不再被 payload 引用的图
fn prune_attachments(doc: &str, sid: &str, payload: &Value) {
    let dir = attachment_dir(doc, sid);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut alive: HashSet<String> = HashSet::new();
    collect_attachment_ids(payload, &mut alive);
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some((stem, ext)) = name.rsplit_once('.') else {
            continue;
        };
        if !ATTACHMENT_EXTS.contains(&ext) || !valid_attachment_id(stem) {
            continue;
        }
        if alive.contains(stem) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
    // 空目录也收掉：清空会话之后 data/attachments/ 下不留一堆空文件夹
    if let Ok(mut left) = std::fs::read_dir(&dir) {
        if left.next().is_none() {
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

/// 删掉一个会话的整个附件目录（删除会话时用）
fn remove_attachment_dir(doc: &str, sid: &str) {
    let _ = std::fs::remove_dir_all(attachment_dir(doc, sid));
}

pub fn attachment(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    let doc = query_get(raw_query, "doc").unwrap_or_else(|| "default".to_string());
    let sid: String = query_get(raw_query, "sid")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    let dir = attachment_dir(&doc, &sid);
    match method {
        Method::Post => {
            if body.is_empty() {
                return send_json(rq, 400, &err_json("空图片"));
            }
            let ext = match sniff_image_ext(body) {
                Some(e) => e,
                None => return send_json(rq, 400, &err_json("只支持 PNG / JPEG / WebP 截图")),
            };
            let id = new_attachment_id();
            if let Err(e) = std::fs::create_dir_all(&dir) {
                store::log_line(&format!("[attachment] 建目录失败: {}", e));
                return send_json(rq, 500, &err_json("保存截图失败（磁盘空间或目录权限）"));
            }
            let path = dir.join(format!("{}.{}", id, ext));
            if let Err(e) = std::fs::write(&path, body) {
                store::log_line(&format!("[attachment] 写文件失败: {}", e));
                return send_json(rq, 500, &err_json("保存截图失败（磁盘空间或目录权限）"));
            }
            send_json(
                rq,
                200,
                &json!({ "ok": true, "id": id, "mime": mime_of(&format!(".{}", ext)) }),
            );
        }
        Method::Get => {
            let id = query_get(raw_query, "id").unwrap_or_default();
            if !valid_attachment_id(&id) {
                return send_json(rq, 400, &err_json("附件 id 不合法"));
            }
            for ext in ATTACHMENT_EXTS {
                let path = dir.join(format!("{}.{}", id, ext));
                if !path.is_file() {
                    continue;
                }
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        return send_raw(rq, 200, Some(mime_of(&format!(".{}", ext))), bytes, &[])
                    }
                    Err(e) => {
                        store::log_line(&format!("[attachment] 读文件失败: {}", e));
                        return send_json(rq, 500, &err_json("读取截图失败"));
                    }
                }
            }
            send_json(rq, 404, &err_json("附件不存在（可能已被清理）"));
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

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
            // 图片单独存：会话写成功之后按「还引用着的 id」清理本会话的附件目录
            // （清空会话 = 没有引用 → 图全删；发送失败留下的孤儿图也在这里被清掉）
            prune_attachments(&doc, &sid, &payload);
            send_json(rq, 200, &json!({"ok":true}));
        }
        // 删掉一个会话文件（不碰论文本身）。与 Node 版一致：文件本来就不在也算成功（幂等）。
        Method::Delete => {
            let existed = store::data_path(&file).exists();
            if !existed || store::remove_file(&file) {
                // 会话没了，它单独存的截图附件也一起删（否则会变成永远没人引用的垃圾文件）
                remove_attachment_dir(&doc, &sid);
                send_json(rq, 200, &json!({"ok":true}))
            } else {
                send_json(rq, 500, &err_json("删除会话失败"))
            }
        }
        _ => send_text(rq, 405, "Method Not Allowed"),
    }
}

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

/// POST /api/upload?name=xxx.pdf[&folder=rel]  —— 原始字节就是 PDF 内容
pub fn upload(rq: Request, method: &Method, raw_query: &str, body: &[u8]) {
    if *method != Method::Post {
        return send_text(rq, 405, "Method Not Allowed");
    }
    let raw = query_get(raw_query, "name").unwrap_or_else(|| "uploaded.pdf".to_string());
    let name = match sanitize_pdf_name(&raw) {
        Some(n) => n,
        None => return send_json(rq, 400, &err_json("文件名不合法")),
    };
    let folder_rel = normalize_rel(&query_get(raw_query, "folder").unwrap_or_default());
    let abs_dir = match resolve_target_dir(&folder_rel) {
        Some(d) => d,
        None => return send_json(rq, 400, &err_json("目标文件夹不存在或不可写")),
    };
    if body.is_empty() {
        return send_json(rq, 400, &err_json("空文件"));
    }
    if !body.starts_with(b"%PDF-") {
        return send_json(rq, 400, &err_json("这不是一个 PDF 文件"));
    }

    let final_name = unique_pdf_name_in_dir(&abs_dir, &name, body.len() as u64);
    let abs = abs_dir.join(&final_name);
    if let Err(e) = std::fs::write(&abs, body) {
        return send_json(rq, 500, &err_json(&format!("写入 papers/ 失败：{}", e)));
    }
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(body.len() as u64);
    let rel = if folder_rel.is_empty() {
        final_name.clone()
    } else {
        format!("{}/{}", folder_rel, final_name)
    };
    store::log_line(&format!("[upload] {} ({}KB)", rel, body.len() / 1024));

    send_json(
        rq,
        200,
        &json!({
            "ok": true,
            "name": final_name,
            "folder": folder_rel,
            "path": rel,
            "size": size,
            "docId": doc_id_of(&final_name),
            "url": format!("/api/pdf?path={}", encode_uri_component(&rel)),
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

/// 带 native-tls 的 agent。必须显式装 TLS 连接器：ureq 用的是
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


/// 刊名 / 出版信息的前缀：以这些词开头的段不是标题（JS 里是 `REF_VENUE_RE`）
const REF_VENUE_PREFIXES: [&str; 35] = [
    "in", "proceedings", "proc", "advances", "journal", "transactions", "conference", "workshop",
    "symposium", "arxiv", "corr", "page", "pages", "vol", "pp", "press", "ieee", "acm", "springer",
    "elsevier", "wiley", "neurips", "nips", "icml", "iclr", "cvpr", "iccv", "eccv", "acl", "emnlp",
    "naacl", "aaai", "ijcai", "kdd", "sigir",
];

fn is_cjk_char(c: char) -> bool {
    ('\u{4e00}'..='\u{9fa5}').contains(&c)
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(is_cjk_char)
}

/// JS 的 `\b`（`\w` = 字母数字下划线）
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `lower` 是不是以 `kw` 开头、且 `kw` 后面是词的边界（等价 JS 的 `^kw\b`）
fn has_word_prefix(lower: &str, kw: &str) -> bool {
    match lower.strip_prefix(kw) {
        Some(rest) => rest.chars().next().map(|c| !is_word_char(c)).unwrap_or(true),
        None => false,
    }
}

fn is_venue_like(t: &str) -> bool {
    let lower = t.to_lowercase();
    REF_VENUE_PREFIXES.iter().any(|kw| has_word_prefix(&lower, kw))
}

/// `V.` → 真（段尾是「开头或空白 + 单个大写字母」= 缩写点）
fn ends_with_single_upper(s: &str) -> bool {
    let t = s.trim_end();
    let mut it = t.chars().rev();
    match it.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    match it.next() {
        None => true,
        Some(c) => c.is_whitespace(),
    }
}

/// `Hochreiter, S` → 真（段尾是「逗号 + 空白 + 单个大写字母」= 完整的作者名写法）
/// 这种段末的点号是句子边界，该切；`V. Sindhwani` 那种才不切。
fn ends_with_comma_upper(s: &str) -> bool {
    let t = s.trim_end();
    let mut it = t.chars().rev();
    match it.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    for c in it {
        if c.is_whitespace() {
            continue;
        }
        return c == ',';
    }
    false
}

/// 「姓, 名首字母」被切成一段：`Hochreiter, S` / `Schmidhuber, J.`（JS `/,[ ]*[A-Z]\.?$/`）
fn ends_with_comma_initial(s: &str) -> bool {
    let t = s.trim_end().trim_end_matches('.');
    if !ends_with_single_upper(t) {
        return false;
    }
    let mut it = t.chars().rev();
    it.next(); // 那个大写字母
    let mut saw_comma = false;
    for c in it {
        if c.is_whitespace() {
            continue;
        }
        saw_comma = c == ',';
        break;
    }
    saw_comma
}

/// `V.` / `A.` 这种单个大写字母（可带点）的词
fn is_initial_token(w: &str) -> bool {
    let b = w.strip_suffix('.').unwrap_or(w);
    let mut it = b.chars();
    matches!(it.next(), Some(c) if c.is_ascii_uppercase()) && it.next().is_none()
}

/// `Smith,` / `Smith.` / `Smith` 这种「首字母大写、后面全是字母」的词（JS `/^[A-Z][A-Za-z'’-]+[,.]?$/`）
fn is_name_token(w: &str) -> bool {
    let b = w.strip_suffix(',').or_else(|| w.strip_suffix('.')).unwrap_or(w);
    let mut it = b.chars();
    match it.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    let rest: Vec<char> = it.collect();
    !rest.is_empty()
        && rest
            .iter()
            .all(|c| c.is_ascii_alphabetic() || matches!(c, '\'' | '’' | '-'))
}

/// `/(^|\s)[A-Z]\.[\s,]/` —— 段里有没有「缩写点 + 后面还是作者」的形态
fn has_initial_dot_pattern(t: &str) -> bool {
    let cs: Vec<char> = t.chars().collect();
    for (i, &c) in cs.iter().enumerate() {
        if c != '.' || i == 0 {
            continue;
        }
        if !cs[i - 1].is_ascii_uppercase() {
            continue;
        }
        let before_ok = i < 2 || cs[i - 2].is_whitespace();
        let after_ok = cs.get(i + 1).map(|n| n.is_whitespace() || *n == ',').unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// 按「句末点号」切段，但缩写点不切（`V. Sindhwani`），中文句号照切。
/// 与 server.js 的 `splitRefSegments` 逐条一致。
fn split_ref_segments(s: &str) -> Vec<String> {
    let cs: Vec<char> = s.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    fn flush(out: &mut Vec<String>, buf: &mut String) {
        let t = buf.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
        buf.clear();
    }
    for (i, &ch) in cs.iter().enumerate() {
        if matches!(ch, '。' | '．' | '！' | '？') {
            flush(&mut out, &mut buf);
            continue;
        }
        if ch == '.' {
            let next_is_ws = cs.get(i + 1).map(|c| c.is_whitespace()).unwrap_or(true);
            if next_is_ws {
                let initial = ends_with_single_upper(&buf);
                if !initial || ends_with_comma_upper(&buf) {
                    flush(&mut out, &mut buf);
                    continue;
                }
            }
        }
        buf.push(ch);
    }
    flush(&mut out, &mut buf);
    out
}

/// 这一段像不像「作者列表」
fn looks_like_authors(seg: &str) -> bool {
    let t = seg.trim();
    if t.is_empty() {
        return false;
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if !words.is_empty() && words.iter().all(|w| is_initial_token(w)) {
        return true; // 纯缩写：V. T. S.
    }
    // 作者列表被切成两段的后半截：`and Schmidhuber, J`
    if words.len() >= 2
        && words.len() <= 6
        && matches!(words[0].to_ascii_lowercase().as_str(), "and" | "&")
        && !t.contains(',')
    {
        return true;
    }
    if ends_with_comma_initial(t) {
        return true; // 「姓, 名首字母」被切成一段
    }
    let lower = t.to_lowercase();
    if ends_with_phrase(&lower, "et al.") || ends_with_phrase(&lower, "et al")
        || lower.ends_with("等人") || lower.ends_with("等")
    {
        return true; // et al. / 等
    }
    if words.len() > 16 {
        return false; // 太长不像作者
    }
    let commas = t.chars().filter(|c| matches!(c, ',' | '，' | '、')).count();
    let ands = words.iter().any(|w| w.eq_ignore_ascii_case("and")) || t.contains('&');
    if commas >= 2 {
        return true; // A, B, C
    }
    if commas >= 1 && (ands || (has_cjk(t) && t.chars().count() <= 20)) {
        return true;
    }
    if has_initial_dot_pattern(t) {
        let names = words.iter().filter(|w| is_initial_token(w) || is_name_token(w)).count();
        if names >= words.len().saturating_sub(1) {
            return true; // 带缩写的人名：J. Smith
        }
    }
    false
}

/// 结尾是不是一个独立的短语（前面必须是开头或空白）
fn ends_with_phrase(lower: &str, phrase: &str) -> bool {
    match lower.strip_suffix(phrase) {
        Some(head) => head.is_empty() || head.ends_with(char::is_whitespace),
        None => false,
    }
}

/// 这一段像不像「标题」（而不是出版信息 / 期刊名 / 页码）
fn looks_like_title(seg: &str) -> bool {
    let t = seg.trim();
    if t.is_empty() || is_venue_like(t) {
        return false;
    }
    let letters = t.chars().filter(|c| c.is_ascii_alphabetic() || is_cjk_char(*c)).count();
    if has_cjk(t) {
        return t.chars().count() >= 6; // 中文标题没空格，按字数
    }
    letters >= 12 && t.split_whitespace().count() >= 2
}

/// 去掉开头的 `[12]`（纯数字的编号）
fn strip_ref_number(s: &str) -> String {
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            let num = &rest[..close];
            if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                return rest[close + 1..].trim_start().to_string();
            }
        }
    }
    s.to_string()
}

/// 去掉首尾的点号 / 空白，并截到 160 字（JS `cleanTitle`）
fn clean_title(t: &str) -> String {
    let is_trim = |c: char| c.is_whitespace() || matches!(c, '.' | ',' | ';' | ':' | '，' | '。' | '；' | '：');
    t.trim_matches(is_trim).chars().take(160).collect()
}

/// 从一条参考文献里猜标题。与 server.js 的 `guessTitle` 逐条一致。
fn guess_title(reference: &str) -> String {
    let collapsed = reference.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = strip_ref_number(&collapsed);
    if s.is_empty() {
        return String::new();
    }
    let segs = split_ref_segments(&s);
    if segs.is_empty() {
        return String::new();
    }
    let mut i = 0usize;
    while i + 1 < segs.len() && i < 6 && looks_like_authors(&segs[i]) {
        i += 1;
    }
    for seg in segs.iter().skip(i) {
        if looks_like_title(seg) {
            return clean_title(seg);
        }
    }
    clean_title(&segs[i])
}

/// 猜出来的标题能不能拿去检索：单字母 / 一两个词的碎片不算（JS `titleIsSearchable`）
fn title_is_searchable(t: &str) -> bool {
    let s = t.trim();
    let letters = s.chars().filter(|c| c.is_ascii_alphabetic() || is_cjk_char(*c)).count();
    if has_cjk(s) {
        return letters >= 4; // 中文标题没空格，4 个字就够
    }
    if letters < 6 {
        return false;
    }
    let words = s.split_whitespace().count();
    words >= 2 || letters >= 8
}

/// 归一化成一堆词（小写、只留字母数字汉字）。与 JS `normWords` 同口径：
/// 注意这里不能用 `is_alphanumeric()`，那会把西里尔 / 希腊字母也算进词里。
fn norm_words(x: &str) -> Vec<String> {
    let mut s = String::new();
    for c in x.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || is_cjk_char(c) {
            s.push(c);
        } else {
            s.push(' ');
        }
    }
    s.split_whitespace().map(|w| w.to_string()).collect()
}

/// 去重后的词集合（JS 里用的是 `Set`）
fn unique_words(x: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in norm_words(x) {
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// 这条结果和我们搜的那个标题到底是不是同一篇（JS `resultMatchesTitle`）。
/// 检索标题认错时几个源都会返回一堆无关论文，老实现照单全收 —— 这就是用户看到的
/// 「我都不知道这个查找是怎么在找」。
fn result_matches_title(search_title: &str, confident: bool, cand_title: &str) -> bool {
    let q = unique_words(search_title);
    let c = unique_words(cand_title);
    if q.is_empty() || c.is_empty() {
        return false;
    }
    let hit = c.iter().filter(|w| q.contains(w)).count();
    if !confident {
        // 标题没认出来（退回整条文献串）：只要求候选标题的词几乎都出现在这条串里
        return hit as f64 / c.len() as f64 >= 0.8;
    }
    hit as f64 / q.len().max(c.len()) as f64 >= 0.34
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

/// OpenAlex 条目该给哪个链接：有 doi 用 doi，没有就回落到落地页。
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
/// 审计 §P1 要求重定向的每一跳都重新做检查。
///
/// `check_private` 之所以要能关掉：第一跳的内网检查由调用方用原始错误码/文案做
/// （`import_pdf` 顶部的 `check_fetch_url`，回 400「内网地址不允许导入」）。
/// 用户自己指定、且已经过检查的地址不该被查第二遍；要挡的是重定向 ——
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
    // 初始 URL 先检查一次（错误码/文案与从前一致），随后每一跳都会再检查一次。
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
    let folder_rel = normalize_rel(&query_get(raw_query, "folder").unwrap_or_default());
    let abs_dir = match resolve_target_dir(&folder_rel) {
        Some(d) => d,
        None => return send_json(rq, 400, &err_json("目标文件夹不存在或不可写")),
    };
    let size = body.len() as u64;
    let final_name = unique_pdf_name_in_dir(&abs_dir, &name, size);
    let abs = abs_dir.join(&final_name);
    if std::fs::write(&abs, &body).is_err() {
        return send_json(rq, 500, &err_json("写入 papers/ 失败：请检查磁盘空间与目录权限"));
    }
    let real = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(size);
    let rel = if folder_rel.is_empty() {
        final_name.clone()
    } else {
        format!("{}/{}", folder_rel, final_name)
    };
    // 日志里不打印完整 URL 的查询串（可能带 token / 签名），只留主机名
    store::log_line(&format!(
        "[import] {} ({}KB) <- {}",
        rel,
        body.len() / 1024,
        host_of(&final_url)
    ));

    send_json(
        rq,
        200,
        &json!({
            "ok": true,
            "name": final_name,
            "folder": folder_rel,
            "path": rel,
            "size": real,
            "docId": doc_id_of(&final_name),
            "url": format!("/api/pdf?path={}", encode_uri_component(&rel)),
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
    // 与 server.js 的 /[a-z][a-z0-9+#._-]*/g 必须等价：词元只能以字母开头。
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

    // 这里不能写「反正别的引擎失败了，就把这批不相关的先给出去」。
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

fn openalex_abstract(work: &Value) -> String {
    let Some(index) = work.get("abstract_inverted_index").and_then(|v| v.as_object()) else {
        return String::new();
    };
    let mut words: Vec<(u64, &str)> = Vec::new();
    for (word, positions) in index {
        if let Some(positions) = positions.as_array() {
            for position in positions {
                if let Some(p) = position.as_u64().filter(|p| *p < 10000) {
                    words.push((p, word.as_str()));
                }
            }
        }
    }
    words.sort_by_key(|w| w.0);
    words.into_iter().take(800).map(|w| w.1).collect::<Vec<_>>().join(" ").chars().take(4000).collect()
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
    // 标题认不出来（单字母 / 碎片）就别拿它去搜 —— 退回整条文献串。
    // 事故回顾：`V. Sindhwani, …` 猜成 `V`，arXiv 就按「标题含 V」返回了一堆无关论文。
    let guessed = guess_title(&raw);
    let confident = title_is_searchable(&guessed);
    let title = if confident { guessed } else { raw.clone() };
    let reading = query_get(raw_query, "scope").as_deref() == Some("reading");
    let agent = if reading { http_agent_with(2, 3) } else { http_agent() };
    let mut results: Vec<Value> = Vec::new();

    // 1) arXiv
    for q in [format!("ti:\"{}\"", title), format!("all:\"{}\"", title)].into_iter().take(if reading { 1 } else { 2 }) {
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
                    "snippet": tag_text(entry, "summary").unwrap_or_default().chars().take(4000).collect::<String>(),
                    "excerptKind": "abstract",
                }));
            }
            if results.len() > before {
                break;
            }
        }
    }

    // 2) OpenAlex
    let have_abstract = reading && results.iter().any(|r| {
        !r.get("snippet").and_then(|v| v.as_str()).unwrap_or("").is_empty()
            && result_matches_title(&title, confident, r.get("title").and_then(|v| v.as_str()).unwrap_or(""))
    });
    if !have_abstract {
    let url = format!(
        "https://api.openalex.org/works?search={}&per-page=4&select=title,publication_year,doi,open_access,primary_location,abstract_inverted_index",
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
                    // 不回落的话，没有 DOI 的条目在 exe 上点不开（Node 版还能落到落地页）——
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
                        "snippet": openalex_abstract(w),
                        "excerptKind": "abstract",
                    }));
                }
            }
        }
    }

    }
    if !reading {
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

    }
    // 去重 → 丢掉和标题无关的 → 按「标题相似度 + 有没有 PDF 直链」排序
    results.sort_by_key(|r| r.get("snippet").and_then(|v| v.as_str()).unwrap_or("").is_empty());
    let mut seen: Vec<String> = Vec::new();
    let mut scored: Vec<(f64, Value)> = Vec::new();
    let mut dropped = 0usize;
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
        // 相关性判据：和标题无关的直接丢掉，不再列给用户（JSON 里回报 dropped，
        // 前端据此解释「为什么一条都没有」）。与 server.js 的 resultMatchesTitle 同口径。
        if !result_matches_title(&title, confident, t) {
            dropped += 1;
            continue;
        }
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
            // false = 没认出标题，这次是拿整条文献串搜的（前端据此提示用户）
            "titleGuessed": confident,
            // 被相关性判据丢掉的条数（前端据此解释「为什么一条都没有」）
            "dropped": dropped,
            "results": list,
            "searchUrl": search_url,
            "scholarUrl": scholar_url,
        }),
    );
}

/* ------------------------------------------------- 契约一致性测试 */

/// 这一组测试锁死「与 server.js 逐条等价」的那几处用户可见差异（desktop/README.md D5/D8/D9/D11）。
/// 它们都是纯函数，所以不需要联网就能验证 —— 这正是把它们从大函数里抽出来的原因。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openalex_abstract_keeps_word_order_and_repetition() {
        let work = json!({"abstract_inverted_index": {"fast": [2], "a": [0, 3], "transform": [1], "invalid": [-1, 10000]}});
        assert_eq!(openalex_abstract(&work), "a transform fast a");
        assert_eq!(openalex_abstract(&json!({"abstract_inverted_index": null})), "");
    }

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


    /// 用户报的那条：作者缩写点不能被当成句子边界
    #[test]
    fn guess_title_does_not_treat_initial_as_title() {
        let r = "V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088–3096, 2015.";
        assert_eq!(guess_title(r), "Structured transforms for small-footprint deep learning");
        assert_ne!(guess_title(r), "V");
        assert!(title_is_searchable(&guess_title(r)), "猜出来的标题必须可检索");
    }

    #[test]
    fn guess_title_table() {
        let cases: [(&str, &str); 12] = [
            (
                "[1] V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088-3096, 2015.",
                "Structured transforms for small-footprint deep learning",
            ),
            (
                "Ashish Vaswani, Noam Shazeer, Niki Parmar. Attention is all you need. NeurIPS 2017.",
                "Attention is all you need",
            ),
            (
                "K. He, X. Zhang, S. Ren, and J. Sun. Deep residual learning for image recognition. CVPR 2016.",
                "Deep residual learning for image recognition",
            ),
            (
                "Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT: Pre-training of deep bidirectional transformers for language understanding. NAACL 2019.",
                "BERT: Pre-training of deep bidirectional transformers for language understanding",
            ),
            (
                "Vaswani, A., Shazeer, N., Parmar, N., et al. Attention is all you need. In NIPS, 2017.",
                "Attention is all you need",
            ),
            (
                "Hochreiter, S. and Schmidhuber, J. Long short-term memory. Neural computation, 9(8):1735-1780, 1997.",
                "Long short-term memory",
            ),
            (
                "J. Smith. A survey of neural machine translation. ACM Computing Surveys, 2020.",
                "A survey of neural machine translation",
            ),
            (
                "Structured transforms for small-footprint deep learning. NeurIPS 2015.",
                "Structured transforms for small-footprint deep learning",
            ),
            (
                "Y. LeCun, Y. Bengio, and G. Hinton. Deep learning. Nature, 521(7553):436-444, 2015.",
                "Deep learning",
            ),
            (
                "张三, 李四. 基于深度学习的图像识别综述. 计算机学报, 2020, 43(5): 1-20.",
                "基于深度学习的图像识别综述",
            ),
            (
                "王五、赵六. 注意力机制研究进展. 软件学报, 2021.",
                "注意力机制研究进展",
            ),
            (
                "Sindhwani, V., Sainath, T., Kumar, S. Structured transforms for small-footprint deep learning. NIPS 2015.",
                "Structured transforms for small-footprint deep learning",
            ),
        ];
        for (r, want) in cases {
            assert_eq!(guess_title(r), want, "输入：{}", r);
        }
    }

    /// 单字母 / 碎片不能算「可检索的标题」（否则又要拿它去搜）
    #[test]
    fn title_is_searchable_rejects_fragments() {
        assert!(!title_is_searchable("V"));
        assert!(!title_is_searchable("V."));
        assert!(!title_is_searchable(""));
        assert!(!title_is_searchable("2020"));
        assert!(title_is_searchable("Deep learning"));
        assert!(title_is_searchable("AlphaFold"));
        assert!(title_is_searchable("注意力机制"));
    }

    /// 相关性判据：V-rings 那类垃圾必须丢掉，真匹配必须留着
    #[test]
    fn result_matches_title_filters_unrelated() {
        let q = "Structured transforms for small-footprint deep learning";
        assert!(!result_matches_title(q, true, "$V$-rings versus $\\Sigma$-$V$ Rings"));
        assert!(!result_matches_title(q, true, "On a conjecture of V. V. Shchigolev"));
        assert!(!result_matches_title(q, true, "Deep learning"));
        assert!(result_matches_title(q, true, "Structured Transforms for Small-Footprint Deep Learning"));
        assert!(result_matches_title(
            "Attention is all you need",
            true,
            "Attention Is All You Need: A Survey of Transformer Architectures"
        ));

        // 标题认不出来时退回整条文献串：真匹配要留，垃圾要丢
        let raw = "V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. In Advances in Neural Information Processing Systems, pages 3088-3096, 2015.";
        assert!(result_matches_title(raw, false, "Structured Transforms for Small-Footprint Deep Learning"));
        assert!(!result_matches_title(raw, false, "$V$-rings versus $\\Sigma$-$V$ Rings"));
    }

    #[test]
    fn split_ref_segments_keeps_initials() {
        let segs = split_ref_segments("V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms. In NIPS, 2015.");
        assert_eq!(segs[0], "V. Sindhwani, T", "{:?}", segs);
        assert_eq!(segs[2], "Structured transforms", "{:?}", segs);
        assert_eq!(guess_title("V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms. In NIPS, 2015."), "Structured transforms");
        let cn = split_ref_segments("张三, 李四. 深度学习综述. 计算机学报, 2020.");
        assert_eq!(cn.len(), 3, "{:?}", cn);
        assert_eq!(cn[0], "张三, 李四", "{:?}", cn);
    }
}
