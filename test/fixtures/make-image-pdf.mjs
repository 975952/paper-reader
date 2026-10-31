import fs from 'node:fs';
import path from 'node:path';

const W = 220;   // 图像宽（像素）
const H = 160;   // 图像高（像素）
const TOP = 72;  // 页面高度

/** 造一张「明显不是纸色」的图：橙色底 + 白色斜条纹，肉眼一看就知道是图 */
function makePixels() {
  const rows = [];
  for (let y = 0; y < H; y += 1) {
    const row = [];
    for (let x = 0; x < W; x += 1) {
      const stripe = ((x + y) % 40) < 12;
      if (stripe) row.push(250, 246, 232);          // 近白条纹
      else row.push(200, 108, 62);                  // 暖橙底
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat(rows);
}

const pixels = makePixels();

const parts = [];
const offsets = [];
let pos = 0;
const push = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
  parts.push(b);
  pos += b.length;
};
const obj = (n, body) => {
  offsets[n] = pos;
  push(`${n} 0 obj\n${body}\nendobj\n`);
};

push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 ${TOP + H + 40}] `
  + '/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>');
// 内容流：先画一行字（证明这页同时有文字和图，两种长按要能分开），再把图放上去
const content = [
  'BT /F1 14 Tf 24 22 Td (Image fixture: long-press the orange block) Tj ET',
  'q',
  `${W} 0 0 ${H} 40 ${TOP} cm`,
  '/Im0 Do',
  'Q',
].join('\n');
// /Im0 Do 用普通字符串写，避免在源码里出现反引号嵌套
const contentStream = content.replace('/Im0 Do', '/Im0 Do');
obj(4, `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`);
// 图像 XObject：未压缩 DeviceRGB
offsets[5] = pos;
push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} `
  + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ' + pixels.length + ' >>\nstream\n');
push(pixels);
push('\nendstream\nendobj\n');
obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

const xrefPos = pos;
const total = 7;
push(`xref\n0 ${total}\n0000000000 65535 f \n`);
for (let i = 1; i < total; i += 1) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

const out = path.join(import.meta.dirname, 'image-sample.pdf');
fs.writeFileSync(out, Buffer.concat(parts));
console.log(`[make-image-pdf] 写出 ${out}（${fs.statSync(out).size} B，含 1 张 ${W}×${H} 的 DeviceRGB 图 + 1 行文字）`);
