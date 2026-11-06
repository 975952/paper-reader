/**
 * 文件夹内 / 全部论文全文搜索验收（隔离 server + 合成 PDF，不碰真实书库）：
 *  - 搜索范围三档按钮、持久化、placeholder；
 *  - folder 只搜当前文件夹，all 跨文件夹；
 *  - 命中靠后的页（>30 页）不丢 —— 旧 read_other_paper 只看前 30 页；
 *  - 结果按论文分组，点击结果打开另一篇并跳到命中页；
 *  - 与 Agent 共用的 searchLibraryPages 返回 docId/docName/page/snippet。
 *
 *   node test/library-search.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'library-search-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
const FOLDER_A = '离散数学';
const FOLDER_B = '其它';
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(path.join(PAPERS, FOLDER_A), { recursive: true });
fs.mkdirSync(path.join(PAPERS, FOLDER_B), { recursive: true });

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（240s），强制退出'); process.exit(3); }, 240000);
watchdog.unref?.();

function makeFixture(out, pages, mark = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'make-multipage-pdf.mjs')], {
      env: { ...process.env, FIXTURE_OUT: out, FIXTURE_PAGES: String(pages), ...(mark ? { FIXTURE_LAST_MARK: mark } : {}) },
      stdio: 'ignore',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture 生成失败（exit ${code}）：${out}`))));
    child.on('error', reject);
  });
}

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

async function until(fn, { timeout = 40000, interval = 120 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) return last;
    await wait(interval);
  }
  return last;
}

/** 轮询直到返回值连续两次相同（对象比较用 JSON），用于等打开/跳页/渲染稳定。 */
async function untilSettled(fn, { timeout = 45000, interval = 160 } = {}) {
  const started = Date.now();
  let prev = null;
  let stable = 0;
  while (Date.now() - started < timeout) {
    const v = await fn();
    const snap = JSON.stringify(v);
    if (snap === prev) {
      stable += 1;
      if (stable >= 2) return v;
    } else { prev = snap; stable = 0; }
    await wait(interval);
  }
  return prev ? JSON.parse(prev) : null;
}

const CH1 = '《离散数学》第1章.pdf';
const CH6 = '《离散数学》第6章.pdf';
const OTHER = 'attention-其它.pdf';
await makeFixture(path.join(PAPERS, FOLDER_A, CH1), 16);
await makeFixture(path.join(PAPERS, FOLDER_A, CH6), 40, 'LateSignal 例: A = {handsome boys}');
await makeFixture(path.join(PAPERS, FOLDER_B, OTHER), 16, 'OtherFolderSignal');

let reader = null;
let browser = null;
try {
  const port = await findPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0',
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  const ready = await until(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, { timeout: 15000 });
  check('隔离服务启动', !!ready);
  if (!ready) throw new Error('isolated server failed to start');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?open=${encodeURIComponent(CH1)}&topbar=static`, { waitUntil: 'domcontentloaded' });
  const opened = await until(() => page.evaluate(() => !!(
    window.__state?.doc && window.__viewer?.numPages > 0 && (window.__state.papers || []).length >= 3
  )), { timeout: 45000 });
  check('打开第1章且论文库可见', !!opened);

  const folder = await page.evaluate(() => window.__ctx.currentFolder);
  check('当前文件夹识别正确', folder === FOLDER_A, String(folder));

  /* ── 1. 检索核心（与 Agent 共用）：folder 过滤 / all 跨文件夹 / 靠后页 ── */
  const lateFolder = await page.evaluate(async () => (await window.__ctx.searchLibraryPages('LateSignal', 'folder')).hits.map((h) => ({
    docName: h.docName, folder: h.folder, page: h.page,
  })));
  check('文件夹内搜索命中第6章第40页（超过旧 30 页上限）',
    lateFolder.length === 1 && lateFolder[0].docName === CH6 && lateFolder[0].page === 40, JSON.stringify(lateFolder));

  const otherFolder = await page.evaluate(async () => (await window.__ctx.searchLibraryPages('OtherFolderSignal', 'folder')).hits.length);
  check('文件夹内搜索不会命中其它文件夹', otherFolder === 0, String(otherFolder));

  const otherAll = await page.evaluate(async () => (await window.__ctx.searchLibraryPages('OtherFolderSignal', 'all')).hits.map((h) => ({
    docName: h.docName, folder: h.folder, page: h.page,
  })));
  check('全部论文搜索能跨文件夹命中',
    otherAll.length === 1 && otherAll[0].docName === OTHER && otherAll[0].folder === FOLDER_B && otherAll[0].page === 16,
    JSON.stringify(otherAll));

  const snippets = await page.evaluate(async () => {
    const result = await window.__ctx.searchLibraryPages('LateSignal', 'folder');
    const hit = result.hits[0] || {};
    return { total: result.total, scanned: result.scanned, snippet: String(hit.snippet || ''), hasDocId: !!hit.docId };
  });
  check('命中带片段/docId 且扫描了文件夹内论文', snippets.total === 2 && snippets.scanned === 2
    && /LateSignal/.test(snippets.snippet) && snippets.hasDocId, JSON.stringify(snippets).slice(0, 200));

  /* ── 2. UI：范围按钮、持久化、分组结果、点击跨论文跳页 ── */
  await page.click('#searchBtn');
  await page.waitForSelector('#searchBar:not(.hidden)');
  await page.click('#searchScope [data-scope="folder"]');
  const scopeState = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll('#searchScope [data-scope]')].map((b) => [b.dataset.scope, b.getAttribute('aria-pressed')]),
    stored: localStorage.getItem('reader.searchScope'),
    placeholder: document.querySelector('#searchInput').placeholder,
  }));
  check('范围按钮选中文件夹并持久化',
    scopeState.pressed.some(([s, p]) => s === 'folder' && p === 'true')
    && scopeState.stored === 'folder' && /当前文件夹/.test(scopeState.placeholder), JSON.stringify(scopeState));

  await page.type('#searchInput', 'LateSignal');
  await page.keyboard.press('Enter');
  const uiFolder = await untilSettled(() => page.evaluate(() => ({
    count: document.querySelector('#searchCount')?.textContent || '',
    docs: [...document.querySelectorAll('#searchResults .search-result-doc')].map((n) => n.textContent),
    rows: [...document.querySelectorAll('#searchResults .search-result')].map((n) => n.textContent),
  })), { timeout: 45000 });
  check('文件夹范围结果按论文分组且显示第40页',
    uiFolder.rows.length === 1 && uiFolder.docs.some((d) => d.includes(CH6)) && /p\.40/.test(uiFolder.rows[0] || ''),
    JSON.stringify(uiFolder).slice(0, 240));

  await page.click('#searchResults .search-result');
  const jumped = await untilSettled(() => page.evaluate(() => ({
    name: window.__state?.doc?.name || '',
    page: window.__viewer?.current || 0,
    barHidden: document.querySelector('#searchBar')?.classList.contains('hidden'),
    rows: document.querySelectorAll('#searchResults .search-result').length,
    count: document.querySelector('#searchCount')?.textContent || '',
  })), { timeout: 45000 });
  check('点击结果打开另一篇论文并跳到命中页',
    jumped.name === CH6 && jumped.page === 40, JSON.stringify(jumped));
  check('跨论文跳转后搜索栏与结果仍可继续用',
    jumped.barHidden === false && jumped.rows === 1 && /1\/1/.test(jumped.count), JSON.stringify(jumped));

  /* 换篇后文件夹变成 FOLDER_A（第6章同文件夹），范围仍是 folder */
  const folderAfterJump = await page.evaluate(() => window.__ctx.currentFolder);
  check('跳到第6章后文件夹仍是离散数学', folderAfterJump === FOLDER_A, String(folderAfterJump));

  /* ── 3. 全部范围：跨文件夹结果 + 分组标题 ── */
  await page.click('#searchScope [data-scope="all"]');
  await page.evaluate(() => { document.querySelector('#searchInput').value = ''; });
  await page.type('#searchInput', 'OtherFolderSignal');
  await page.keyboard.press('Enter');
  const uiAll = await untilSettled(() => page.evaluate(() => ({
    count: document.querySelector('#searchCount')?.textContent || '',
    docs: [...document.querySelectorAll('#searchResults .search-result-doc')].map((n) => n.textContent),
    rows: [...document.querySelectorAll('#searchResults .search-result')].map((n) => n.textContent),
  })), { timeout: 45000 });
  check('全部范围跨文件夹返回分组结果',
    uiAll.rows.length === 1 && uiAll.docs.some((d) => d.includes(OTHER)) && /p\.16/.test(uiAll.rows[0] || ''),
    JSON.stringify(uiAll).slice(0, 240));

  await page.click('#searchResults .search-result');
  const jumped2 = await untilSettled(() => page.evaluate(() => ({
    name: window.__state?.doc?.name || '', page: window.__viewer?.current || 0,
  })), { timeout: 45000 });
  check('全部范围点结果能打开其它文件夹的论文', jumped2.name === OTHER && jumped2.page === 16, JSON.stringify(jumped2));

  const otherFolderNow = await page.evaluate(() => window.__ctx.currentFolder);
  check('打开其它文件夹论文后文件夹切换正确', otherFolderNow === FOLDER_B, String(otherFolderNow));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n文件夹/全部论文搜索：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
