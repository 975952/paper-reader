import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PDF = path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf');

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  [OK]' : '  [XX]'} ${n}${d ? `  -- ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(PDF)) {
  console.error(`缺少测试文件 ${PDF}`);
  process.exit(2);
}

// 上传接口会返回最终落盘的文件名（重名时会被改成 xxx-1.pdf），拿它才能准确清理
let uploadedName = null;
let papersDir = null;
try {
  const j = await fetch(`${BASE}/api/papers`).then((r) => r.json());
  papersDir = j.dir;
} catch { /* 稍后回退到默认目录 */ }
papersDir = papersDir || path.join(import.meta.dirname, '..', 'papers');

// 临时文件会更新测试环境的「上次打开文档」状态；数据始终限制在隔离测试根目录。
assertIsolatedDataDir(resolveDataDir(papersDir));

const cleanup = () => {
  if (!uploadedName) return;
  try { fs.rmSync(path.join(papersDir, uploadedName), { force: true }); } catch { /* 尽力而为 */ }
  uploadedName = null;
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', async (res) => {
  if (!res.url().includes('/api/upload')) return;
  try {
    const j = await res.json();
    if (j?.name) uploadedName = j.name;
  } catch { /* 忽略 */ }
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileInput');
const input = await page.$('#fileInput');
await input.uploadFile(PDF);
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await sleep(2500);
check('上传返回了落盘文件名（结束时好清理）', !!uploadedName, uploadedName || '(没拿到)');

/* 1. 中文文本能提取出来（cMap 路径） */
const cn = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.page[data-page="1"] .textLayer span:not(.markedContent)')].map((s) => s.textContent);
  return { joined: spans.join(''), count: spans.length };
});
check('中文 PDF 文本层非空', cn.count > 0, `${cn.count} 个 span`);
check('提取到中文字符', /[\u4e00-\u9fa5]{4,}/.test(cn.joined), JSON.stringify(cn.joined.slice(0, 50)));
check('提取到英文摘要', /attention-augmented|Abstract/i.test(cn.joined), JSON.stringify(cn.joined.match(/Abstract[^。]{0,40}/)?.[0] || ''));

/* 2. 文本层与画布对齐：真实文本 span 的联合包围盒应覆盖页面的主要区域
   （要排除 .markedContent 包装 span —— 它是 display:contents，尺寸恒为 0，
     且 textContent 会重复包含内部文字，统计进去会得到错误结论） */
const align = await page.evaluate(() => {
  const pageEl = document.querySelector('.page[data-page="1"]');
  const pr = pageEl.getBoundingClientRect();
  const spans = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim() && s.getBoundingClientRect().width > 0.5);
  if (!spans.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of spans) {
    const r = s.getBoundingClientRect();
    minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
  }
  return {
    pageW: Math.round(pr.width), pageH: Math.round(pr.height),
    spanW: Math.round(maxX - minX), spanH: Math.round(maxY - minY),
    offX: Math.round(minX - pr.left), offY: Math.round(minY - pr.top),
    lastSpanBottom: Math.round(maxY - pr.top),
  };
});
check('文本层联合包围盒存在', !!align, JSON.stringify(align));
if (align) {
  const wRatio = align.spanW / align.pageW;
  const hRatio = align.spanH / align.pageH;
  check('文本层横向覆盖合理（>40% 页宽）', wRatio > 0.4, `${(wRatio * 100).toFixed(0)}% 页宽`);
  check('文本层纵向覆盖合理（>30% 页高）', hRatio > 0.3, `${(hRatio * 100).toFixed(0)}% 页高`);
  check('文本层起点在页面内（不是漂到页面外）', align.offX >= -5 && align.offX < align.pageW * 0.3 && align.offY >= -5 && align.offY < align.pageH * 0.3,
    `起点偏移 (${align.offX}, ${align.offY})`);
  check('文本层不溢出页面底部', align.lastSpanBottom <= align.pageH + 5, `末行 ${align.lastSpanBottom} / 页高 ${align.pageH}`);
}

/* 3. 中文文献自动跳过翻译（可选行为，只记录不判定） */
const autoSkip = await page.evaluate(() => {
  const sel = window.getSelection();
  const span = [...document.querySelectorAll('.page[data-page="1"] .textLayer span')].find((s) => /[\u4e00-\u9fa5]{2,}/.test(s.textContent));
  if (!span) return 'no-cn-span';
  const range = document.createRange();
  range.selectNodeContents(span);
  sel.removeAllRanges(); sel.addRange(range);
  document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return 'ok';
});
await sleep(400);
const bubbleShown = await page.evaluate(() => !document.getElementById('bubble').classList.contains('hidden'));
check('中文也能划词（气泡出现）', autoSkip === 'ok' && bubbleShown, autoSkip);

console.log('\n──────── 错误 ────────');
console.log(errors.length ? errors.map((e) => '  ! ' + e).join('\n') : '  无');
await browser.close();
check('测试上传的文件已从 papers/ 清理掉', (() => {
  cleanup();
  return !fs.existsSync(path.join(papersDir, 'cn-sample.pdf'));
})(), 'papers/cn-sample.pdf');
const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length && !errors.length ? 0 : 1);
