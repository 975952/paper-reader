/**
 * 把「P」图标嵌进 exe。
 *
 * 为什么需要它：窗口图标（window.rs）只在程序运行时才画上去，
 * exe 文件本身没有图标资源 —— 资源管理器里是白板，快捷方式也是白板。
 * 这里在编译期生成一个多尺寸 .ico 并用 winres 编译进 PE 资源，
 * 于是 exe、桌面快捷方式、任务栏、Alt+Tab 全都有图标了，**不需要安装程序**。
 *
 * 形状不在这里重复定义：直接 include 运行时的那份 icon_geometry.rs，
 * 保证「网页 logo / 窗口图标 / exe 图标」永远是同一个图。
 */
use std::env;
use std::fs;
use std::path::PathBuf;

include!("src/icon_geometry.rs");

/// 把一个尺寸渲染成 ICO 里用的 BMP(DIB) 图像块。
/// ICO 允许内嵌 PNG，但 BMP 不需要任何编码器，手写更省事。
fn dib(size: u32) -> Vec<u8> {
    let rgba = render_icon_rgba(size);
    let mut out = Vec::new();
    let xor_len = (size * size * 4) as u32;
    let and_row = ((size + 31) / 32) * 4; // AND 掩码每行按 4 字节对齐
    let and_len = and_row * size;

    // BITMAPINFOHEADER
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(size as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&((size * 2) as i32).to_le_bytes()); // biHeight = 2×（XOR+AND）
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(xor_len + and_len).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&0i32.to_le_bytes()); // XPelsPerMeter
    out.extend_from_slice(&0i32.to_le_bytes()); // YPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    // 像素：BGRA、自下而上
    for y in (0..size).rev() {
        for x in 0..size {
            let i = ((y * size + x) * 4) as usize;
            out.push(rgba[i + 2]); // B
            out.push(rgba[i + 1]); // G
            out.push(rgba[i]); // R
            out.push(rgba[i + 3]); // A
        }
    }
    // AND 掩码：32bpp 下不用它，全 0 即可，但必须存在
    out.extend(std::iter::repeat(0u8).take(and_len as usize));
    out
}

fn build_ico(sizes: &[u32]) -> Vec<u8> {
    let images: Vec<Vec<u8>> = sizes.iter().map(|s| dib(*s)).collect();
    let mut out = Vec::new();
    // ICONDIR
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type = icon
    out.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    // ICONDIRENTRY × n
    let mut offset = 6 + 16 * sizes.len() as u32;
    for (i, s) in sizes.iter().enumerate() {
        out.push(if *s >= 256 { 0 } else { *s as u8 }); // 256 要写 0
        out.push(if *s >= 256 { 0 } else { *s as u8 });
        out.push(0); // 调色板数
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bpp
        out.extend_from_slice(&(images[i].len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += images[i].len() as u32;
    }
    for img in &images {
        out.extend_from_slice(img);
    }
    out
}

fn main() {
    println!("cargo:rerun-if-changed=src/icon_geometry.rs");
    println!("cargo:rerun-if-changed=build.rs");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let ico = out_dir.join("app.ico");
    // 16/24/32/48/64/128/256：从任务栏小图标到资源管理器大图标都覆盖
    fs::write(&ico, build_ico(&[16, 24, 32, 48, 64, 128, 256])).expect("写 app.ico 失败");

    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon(ico.to_str().expect("ico 路径不是 UTF-8"));
        res.set("FileDescription", "论文阅读器");
        res.set("ProductName", "论文阅读器");
        res.set("LegalCopyright", "");
        // 版本号写死字符串，避免为它再引一个 crate
        res.set_version_info(winres::VersionInfo::FILEVERSION, 0x0001_0000_0000_0000);
        res.set_version_info(winres::VersionInfo::PRODUCTVERSION, 0x0001_0000_0000_0000);
        if let Err(e) = res.compile() {
            // 没有 rc.exe（缺 Windows SDK）时不要整个构建失败 —— 只是没有 exe 图标而已
            println!("cargo:warning=嵌入 exe 图标失败（不影响功能）：{}", e);
        }
    }
}
