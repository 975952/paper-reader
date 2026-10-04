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
}
