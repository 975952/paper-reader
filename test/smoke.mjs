import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8911';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
assertIsolatedDataDir(resolveDataDir(papers.dir));
// 列表按 mtime 倒序，取体积最大的一篇才是真正的多页论文（小夹具会把断言带偏）
const doc = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
if (!doc) {
  console.error(`隔离书架是空的（${papers.dir}）—— 先把 test/fixtures/*.pdf 拷进 papers/ 再跑`);
  process.exit(2);
}
console.log(`服务    : ${BASE}`);
console.log(`隔离目录: ${papers.dir}`);
console.log(`打开    : ${doc.name}（${Math.round((doc.size || 0) / 1024)} KB）`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e}`));
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} :: ${r.failure()?.errorText}`));
await page.goto(`${BASE}/?open=${encodeURIComponent(doc.name)}`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
const st = await page.evaluate(() => ({
  docName: document.getElementById('docName')?.textContent,
  pages: document.querySelectorAll('.page').length,
  canvases: document.querySelectorAll('.page canvas').length,
  // 状态栏已删除：改看页码那一格的就绪信号
  pageLabel: document.getElementById('pageInput')?.value,
  // #welcome 已升级成独立首页 #home，阅读态由 body.reading 表达
  reading: document.body.classList.contains('reading'),
  home: !!document.getElementById('home'),
  hasViewer: !!window.__viewer,
  papers: document.querySelectorAll('#fileList li').length,
  // 2026-10 删减后的结构口径：右栏恒为 1 列、只有 #aiArea 一个结果区
  rightCols: document.querySelectorAll('#rightCols > .side.right').length,
  aiArea2: !!document.getElementById('aiArea2'),
  opsItems: document.querySelectorAll('#opsMenu .ops-item').length,
}));
console.log('状态:', JSON.stringify(st, null, 1));
console.log('\n日志:');
for (const l of logs.slice(0, 30)) console.log('  ' + l);
const fatal = logs.filter((l) => l.startsWith('[pageerror]'));
console.log(`\n页面硬报错: ${fatal.length ? fatal.length + ' 条（见上）' : '无'}`);
await browser.close();
process.exit(fatal.length ? 1 : 0);
