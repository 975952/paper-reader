//! 内嵌前端资源。`../public/` 整个目录在 release 构建里被打进 exe，
//! 运行时不依赖任何外部文件夹。

use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../public/"]
pub struct PublicAssets;

pub fn get(path: &str) -> Option<rust_embed::EmbeddedFile> {
    PublicAssets::get(path)
}

pub fn contains(path: &str) -> bool {
    PublicAssets::get(path).is_some()
}

/// 启动时自检用：内嵌了多少个文件
pub fn count() -> usize {
    PublicAssets::iter().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_embedded() {
        assert!(contains("index.html"));
        assert!(contains("js/app.js"));
        assert!(contains("vendor/pdf.min.mjs"));
        assert!(count() > 100);
    }

    /// A 线 P1：新增的 public/js/prompts/ 是目录整体内嵌的，但 rust-embed 对**新增文件**
    /// 不会自动触发重编译（build.bat 会 touch 本文件）。这里逐类抽查，防止
    /// 「public/ 里有、exe 里没有」这种只会在真机上才暴露的漏嵌。
    #[test]
    fn prompts_are_embedded() {
        for path in [
            "js/prompts/index.js",
            "js/prompts/registry.js",
            "js/prompts/compose.js",
            "js/prompts/base.js",
            "js/prompts/contracts.js",
            "js/prompts/materials.js",
            "js/prompts/memory.js",
            "js/prompts/history.js",
            "js/prompts/budget.js",
            "js/prompts/capabilities/qa.js",
            "js/prompts/capabilities/translate.js",
            "js/prompts/capabilities/teach.js",
            "js/prompts/capabilities/ops.js",
            "js/prompts/capabilities/background.js",
            "js/prompts/capabilities/legacy.js",
        ] {
            assert!(contains(path), "exe 缺少前端文件：{path}（重新跑 desktop\\build.bat）");
        }
    }
}
