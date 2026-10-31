
/// 点到线段的距离
pub fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (vx, vy) = (bx - ax, by - ay);
    let (wx, wy) = (px - ax, py - ay);
    let len2 = vx * vx + vy * vy;
    let t = if len2 > 0.0 {
        ((wx * vx + wy * vy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (dx, dy) = (wx - t * vx, wy - t * vy);
    (dx * dx + dy * dy).sqrt()
}

/// 单位坐标系（0..1）里，这个点是否属于「P」
pub fn inside_p(ux: f32, uy: f32) -> bool {
    let (x, y) = (ux * 100.0, uy * 100.0);
    let hw = 7.5; // 笔画半宽 = stroke-width 15 / 2
    if seg_dist(x, y, 34.0, 84.0, 34.0, 18.0) <= hw {
        return true; // 竖笔
    }
    if seg_dist(x, y, 34.0, 18.0, 54.0, 18.0) <= hw {
        return true; // 起笔横
    }
    let (cx, cy, r) = (54.0f32, 39.0f32, 21.0f32); // 碗：圆心(54,39)、半径21、取右半
    let (dx, dy) = (x - cx, y - cy);
    let d = (dx * dx + dy * dy).sqrt();
    if dx >= 0.0 && (d - r).abs() <= hw {
        return true;
    }
    seg_dist(x, y, 54.0, 60.0, 34.0, 60.0) <= hw // 收笔横
}

/// 渲染成 RGBA（透明背景 + 工作台浅绿 #A8BFA7）。4×4 超采样抗锯齿。
pub fn render_icon_rgba(size: u32) -> Vec<u8> {
    let ss = 4u32;
    let (r, g, b) = (0xA8u8, 0xBFu8, 0xA7u8);
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut hit = 0u32;
            for sy in 0..ss {
                for sx in 0..ss {
                    let ux = (x as f32 + (sx as f32 + 0.5) / ss as f32) / size as f32;
                    let uy = (y as f32 + (sy as f32 + 0.5) / ss as f32) / size as f32;
                    if inside_p(ux, uy) {
                        hit += 1;
                    }
                }
            }
            let i = ((y * size + x) * 4) as usize;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = (hit * 255 / (ss * ss)) as u8;
        }
    }
    rgba
}
