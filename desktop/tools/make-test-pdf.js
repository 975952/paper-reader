#!/usr/bin/env node
/**
 * 生成一个合法的最小单页 PDF，只用于本地验收测试（Range / 列表接口）。
 *
 *   node make-test-pdf.js <输出路径>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const out = process.argv[2] || path.join(__dirname, '..', 'testdata', 'sample.pdf');

const objects = [];
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
objects.push(
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] '
  + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
);
const stream = 'BT /F1 20 Tf 24 120 Td (Hello PDF Range Test) Tj ET\n';
objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefPos = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out} (${Buffer.byteLength(pdf)} bytes)`);
