/**
 * 书架：批量导入 / 拖动排序 / 删除（2026-10 用户口径：
 * 「要有一次性导入或者拖入多个 pdf 文件的功能，而且要能够移动 pdf 的顺序和删除 pdf 的功能」）。
 *
 *   BASE=http://127.0.0.1:8971 node test/library.mjs
 *
 * 覆盖：
 *   L1 文件选择器支持多选（multiple），每行有抓手与删除按钮
 *   L2 一次选多个 PDF → 全部落盘并出现在列表里，且不会自动打开其中一篇
 *   L3 删除按钮：确认后文件真的从 papers/ 与列表里消失，正在读的那篇删除后回首页
 *   L4 拖拽排序：DOM 顺序变化 + POST /api/papers 持久化
 *   L5 刷新后顺序仍然生效（data/papers-order.json 生效）
 *   L6 接口边界：非法 order → 400，重复删除 → 404
 *
 * 所有写入只发生在隔离沙箱（test/artifacts/）—— 由 _env.mjs 的 assertIsolatedDataDir 兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8971';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const TOKEN = process.env.PRT_API_TOKEN || '';
const SANDBOX = path.resolve(import.meta.dirname, 'artifacts', 'library');

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = TOKEN ? { 'Content-Type': 'application/json', 'X-PRT-Token': TOKEN } : { 'Content-Type': 'application/json' };
const api = (p, opts = {}) => fetch(`${BASE}${p}`, { headers: H, ...opts });
const listPapers = () => api('/api/papers').then((r) => r.json());

const papersInfo = await listPapers();
assertIsolatedDataDir(resolveDataDir(papersInfo.dir));
const dataDir = resolveDataDir(papersInfo.dir);
const papersDir = papersInfo.dir;
if (!papersInfo.papers?.length) { console.error('隔离书架是空的 —— 先把 test/fixtures/*.pdf 拷进去'); process.exit(2); }
console.log(`服务    : ${BASE}`);
console.log(`隔离目录: ${papersDir}\n`);

/* 准备两份**名字唯一**的夹具：同名同大小会被服务端当成重复导入直接复用，测不出「多了一个」 */
fs.mkdirSync(SANDBOX, { recursive: true });
const stamp = Date.now();
const srcA = path.join(SANDBOX, `batch-a-${stamp}.pdf`);
const srcB = path.join(SANDBOX, `batch-b-${stamp}.pdf`);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), srcA);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), srcB);
const nameA = path.basename(srcA);
const nameB = path.basename(srcB);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await sleep(1500);

const cleanup = async () => {
  for (const name of [nameA, nameB]) {
    await api(`/api/papers?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
  }
};

try {
  /* ── L1 结构 ── */
  const struct = await page.evaluate(() => ({
    multiple: document.getElementById('fileInput')?.multiple === true,
    rows: [...document.querySelectorAll('#fileList li[data-name]')].map((li) => ({
      name: li.dataset.name,
      grip: !!li.querySelector('.file-grip'),
      del: !!li.querySelector('.file-row-x'),
      text: li.textContent.trim(),
    })),
    draggable: document.querySelector('#fileList li[data-name]')?.draggable === true,
  }));
  check('L1 文件选择器支持多选', struct.multiple);
  check('L1 每行都有拖动抓手 + 删除按钮', struct.rows.length > 0 && struct.rows.every((r) => r.grip && r.del),
    `${struct.rows.length} 行`);
  check('L1 行文本仍然只是文件名（没有 × 之类的可见字符）',
    struct.rows.every((r) => !/[×✕]/.test(r.text)), struct.rows.map((r) => r.text).join('|').slice(0, 80));
  check('L1 行可拖拽', struct.draggable === true);

  /* ── L2 批量导入两个 PDF ── */
  const before = await listPapers();
  const input = await page.$('#fileInput');
  await input.uploadFile(srcA, srcB);
  await page.waitForFunction(
    (names) => names.every((n) => [...document.querySelectorAll('#fileList li[data-name]')].some((li) => li.dataset.name === n)),
    { timeout: 30000 }, [nameA, nameB],
  );
  await sleep(800);
  const afterImport = await listPapers();
  const uiAfter = await page.evaluate(() => ({
    reading: document.body.classList.contains('reading'),
    text: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '),
    order: [...document.querySelectorAll('#fileList li[data-name]')].map((li) => li.dataset.name),
  }));
  check('L2 一次选两个 PDF 都落盘了',
    afterImport.papers.some((p) => p.name === nameA) && afterImport.papers.some((p) => p.name === nameB),
    `${before.papers.length} → ${afterImport.papers.length} 篇`);
  check('L2 两篇都出现在文件列表里',
    uiAfter.order.includes(nameA) && uiAfter.order.includes(nameB));
  check('L2 批量导入不自动打开其中任意一篇（停在原视图）', uiAfter.reading === false, `reading=${uiAfter.reading}`);
  check('L2 提示里说了导入数量', /已导入\s*2\s*篇/.test(uiAfter.text), uiAfter.text.slice(0, 80));

  /* ── L3 删除：先把 A 打开（验证「删正在读的那篇会回首页」）── */
  await page.evaluate((name) => {
    [...document.querySelectorAll('#fileList li[data-name]')].find((li) => li.dataset.name === name)?.click();
  }, nameA);
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await sleep(600);
  check('L3 打开待删除的论文', await page.evaluate(() => document.body.classList.contains('reading')));

  await page.evaluate((name) => {
    const li = [...document.querySelectorAll('#fileList li[data-name]')].find((n) => n.dataset.name === name);
    li?.querySelector('.file-row-x')?.click();
  }, nameA);
  await sleep(1200);
  const afterDelete = await listPapers();
  const delView = await page.evaluate((name) => ({
    reading: document.body.classList.contains('reading'),
    home: !document.getElementById('home')?.classList.contains('hidden'),
    hasA: [...document.querySelectorAll('#fileList li[data-name]')].some((li) => li.dataset.name === name),
  }), nameA);
  check('L3 删除后文件从 /api/papers 消失', !afterDelete.papers.some((p) => p.name === nameA));
  check('L3 删除后磁盘上真的没了', !fs.existsSync(path.join(papersDir, nameA)));
  check('L3 删除后列表行也消失', delView.hasA === false);
  check('L3 删除正在阅读的那篇会自动回首页', delView.reading === false && delView.home === true,
    JSON.stringify(delView));

  /* ── L4 拖拽排序：把 B 拖到最后一行之后 ── */
  // 首页默认收起左栏，行高度是 0，合成拖拽的坐标会全变成 0 —— 先把文件面板展开
  await page.evaluate(() => document.querySelector('#railLeft .rail-btn[data-rail="files"]')?.click());
  await sleep(600);
  const listVisible = await page.evaluate(() => document.querySelector('#fileList li[data-name]')?.getBoundingClientRect().height > 0);
  check('L4 文件面板已展开（行有真实高度，拖拽坐标才有意义）', listVisible);
  const beforeOrder = (await listPapers()).papers.map((p) => p.name);
  const moved = await page.evaluate(async (name) => {
    const list = document.querySelector('#fileList');
    const rows = [...list.querySelectorAll('li[data-name]')];
    const from = rows.find((li) => li.dataset.name === name);
    const last = rows[rows.length - 1];
    if (!from || !last || from === last) return { ok: false, reason: 'not enough rows' };
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = last.getBoundingClientRect();
    const y = r.bottom - 2;   // 落在下半部分 → 插到这一行之后
    last.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    last.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  }, nameB);
  await sleep(1200);
  const afterOrder = (await listPapers()).papers.map((p) => p.name);
  const uiOrder = await page.evaluate(() => [...document.querySelectorAll('#fileList li[data-name]')].map((li) => li.dataset.name));
  check('L4 拖拽事件能触发排序', moved.ok, moved.reason || '');
  check('L4 顺序已保存到服务端', JSON.stringify(afterOrder) !== JSON.stringify(beforeOrder),
    `${beforeOrder.slice(0, 4).join(',')} → ${afterOrder.slice(0, 4).join(',')}`);
  check('L4 界面上 B 排到了最后', uiOrder[uiOrder.length - 1] === nameB, uiOrder.slice(-3).join(','));
  check('L4 服务端顺序与界面一致', JSON.stringify(uiOrder) === JSON.stringify(afterOrder));
  const orderFile = path.join(dataDir, 'papers-order.json');
  const orderSaved = fs.existsSync(orderFile) ? JSON.parse(fs.readFileSync(orderFile, 'utf8')).order : null;
  check('L4 顺序落到了 data/papers-order.json', Array.isArray(orderSaved) && orderSaved[orderSaved.length - 1] === nameB,
    orderFile);

  /* ── L5 刷新后顺序仍然生效 ── */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1600);
  const reloadOrder = await page.evaluate(() => [...document.querySelectorAll('#fileList li[data-name]')].map((li) => li.dataset.name));
  check('L5 刷新后顺序保持', JSON.stringify(reloadOrder) === JSON.stringify(afterOrder), reloadOrder.slice(-3).join(','));

  /* ── L6 接口边界 ── */
  const badOrder = await api('/api/papers', { method: 'POST', body: JSON.stringify({ nope: 1 }) });
  check('L6 非法 order 请求返回 400', badOrder.status === 400, `HTTP ${badOrder.status}`);
  const delB = await api(`/api/papers?name=${encodeURIComponent(nameB)}`, { method: 'DELETE' });
  const delAgain = await api(`/api/papers?name=${encodeURIComponent(nameB)}`, { method: 'DELETE' });
  check('L6 第一次删除成功 / 第二次 404', delB.status === 200 && delAgain.status === 404,
    `${delB.status} / ${delAgain.status}`);
  const traversal = await api(`/api/papers?name=${encodeURIComponent('../data/config.json')}`, { method: 'DELETE' });
  check('L6 路径穿越被拒绝', traversal.status === 400 || traversal.status === 404, `HTTP ${traversal.status}`);
  check('L6 页面没有异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await cleanup();
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n──────── 结果：${passed}/${results.length} 通过 ────────`);
for (const r of results) if (!r.ok) console.log(`  ❌ ${r.name} ${r.detail || r.d || ''}`);
process.exit(passed === results.length ? 0 : 1);
