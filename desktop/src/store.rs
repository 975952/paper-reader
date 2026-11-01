//! data/ 目录里的 JSON 读写。
//!
//! 三条硬性要求（对齐 server.js 的 writeDataFile）：
//!   1. 写盘串行化 —— 并发请求不能交叉写坏同一个文件
//!   2. 临时文件 + rename —— 不能出现半截 JSON
//!   3. 任何失败都不能让服务挂掉

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::util::dirs;

/// 串行化所有写操作。用 Mutex（而不是 promise 链）的好处是：
/// 上一个写失败了，下一个照样能拿到锁继续写，不会像 server.js 注释里说的那样
/// 让整条链永久 rejected。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // 锁中毒（某个线程 panic）也要继续用，不然之后所有保存都会失效
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn data_path(name: &str) -> PathBuf {
    std::env::var_os("PRT_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| dirs().data.clone()).join(name)
}

/// 读 JSON；文件不存在 / 解析失败一律返回 fallback（对齐 readDataFile）
pub fn read_json(name: &str, fallback: Value) -> Value {
    let p = data_path(name);
    match std::fs::read(&p) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

/// 读 JSON，失败返回 None（用于需要区分"文件里到底是什么"的场合）
#[allow(dead_code)]
pub fn read_json_opt(name: &str) -> Option<Value> {
    let p = data_path(name);
    let bytes = std::fs::read(&p).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

/**
 * data/ 目录下所有文件名（只取文件名本身，不含路径）。
 * 给 `/api/sessions` 列会话用：它要扫出 `session-<docId>*.json` 这一族文件。
 * 目录不存在 / 读不到就返回空表 —— 调用方按"没有会话"处理，不该因此报错。
 */
pub fn list_data_files() -> Vec<String> {
    let dir = data_path("");
    match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 删除一个数据文件（删不掉 / 本来就不在都返回 false，调用方自己决定怎么提示）
pub fn remove_file(name: &str) -> bool {
    let _guard = lock();
    std::fs::remove_file(data_path(name)).is_ok()
}

/// 原子写 JSON。调用方必须检查返回值，失败时向客户端返回错误。
pub fn write_json(name: &str, value: &Value) -> bool {
    let _guard = lock();

    let target = data_path(name);
    let tmp = {
        let mut s = target.clone().into_os_string();
        s.push(".tmp");
        PathBuf::from(s)
    };

    let text = match serde_json::to_string_pretty(value) {
        Ok(t) => t,
        Err(e) => {
            log_line(&format!("[store] 序列化 {} 失败: {}", name, e));
            return false;
        }
    };

    let write_result = (|| -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.flush()?;
        drop(f);
        // Windows 上 std::fs::rename 走 MoveFileEx(MOVEFILE_REPLACE_EXISTING)，可以直接覆盖；
        // 但目标文件可能正被另一个请求读取（EPERM/EACCES/EBUSY）。退避重试几次，
        // 避免「拖动排序 / 保存顺序」偶发失败（用户实测过）。
        let mut last_err: Option<std::io::Error> = None;
        for i in 0..12u64 {
            match std::fs::rename(&tmp, &target) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let kind = e.kind();
                    let retryable = matches!(
                        kind,
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Other
                    );
                    last_err = Some(e);
                    if !retryable {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25 + i * 15));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "rename failed")))
    })();

    match write_result {
        Ok(()) => true,
        Err(e) => {
            log_line(&format!("[store] 写入 {} 失败: {}", name, e));
            let _ = std::fs::remove_file(&tmp);
            false
        }
    }
}

/// 浅合并（对齐 `{...cur, ...patch}`）；patch 不是对象时按空对象处理
pub fn merge(base: &Value, patch: &Value) -> Value {
    let mut out = match base {
        Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    if let Value::Object(p) = patch {
        for (k, v) in p {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

pub fn log_line(msg: &str) {
    crate::log_line(msg);
}
