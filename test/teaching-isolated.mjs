/** 使用合成论文验收教学与深入阅读，绝不依赖用户书架。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';

fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'teaching-'));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const objects = [];
const add = (s) => { objects.push(s); return objects.length; };
const catalog = add(''), root = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const pages = Array.from({ length: 4 }, (_, n) => {
  const lines = ['Synthetic Attention Paper', `Page ${n + 1}`, 'We combine queries keys and values with matrix multiplication.',
    ...(n === 3 ? ['Figure 2: Two attention heads', 'Attention(Q, K, V) = softmax(QK / sqrt(d)) V (1)'] : ['This is deterministic test material, not a research claim.'])];
  const content = 'BT\n/F1 12 Tf\n22 TL\n50 730 Td\n' + lines.map((s) => `(${s.replace(/[()\\]/g, '\\$&')}) Tj\nT*\n`).join('') + 'ET\n';
  const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  return add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${root} 0 R >>`;
objects[root - 1] = `<< /Type /Pages /Count 4 /Kids [${pages.map((n) => `${n} 0 R`).join(' ')}] >>`;
let pdf = '%PDF-1.4\n'; const offsets = [0];
objects.forEach((s, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${s}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(papers, 'attention-arxiv.pdf'), pdf, 'ascii');
const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise((r) => probe.close(r));
const base = `http://127.0.0.1:${port}`;
const reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
} });
try {
  let ready = false;
  for (let n = 0; n < 100 && !ready; n++) { await new Promise((r) => setTimeout(r, 100)); try { ready = (await fetch(base + '/api/health')).ok; } catch { /* starting */ } }
  if (!ready) throw new Error('isolated reader did not start');
  for (const suite of ['teaching.mjs', 'ops.mjs']) {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', suite)], { windowsHide: true, stdio: 'inherit', env: { ...process.env, BASE: base } });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    if (code !== 0) throw new Error(`${suite} failed: ${code}`);
  }
} finally { reader.kill(); }
