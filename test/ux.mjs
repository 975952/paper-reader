/** Isolated UX regression: synthetic papers, a temporary Node server, and a fake AI upstream. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'ux-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
let rejectedRealData = false;
try { assertIsolatedDataDir(path.join(ROOT, 'data')); } catch { rejectedRealData = true; }
if (!rejectedRealData) throw new Error('test guard accepted the real data directory');
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-a.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'fixture-b.pdf'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForStableScroll = (page) => page.evaluate(async () => {
  const node = window.__viewer.container;
  let previous = node.scrollTop;
  let stable = 0;
  for (let i = 0; i < 100 && stable < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = node.scrollTop;
    stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
    previous = current;
  }
  return node.scrollTop;
});
async function findPort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const plans = [];
const upstreamRequests = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const longChunks = [
  '## 流式排版检查\n\n',
  '已完成段落中的公式 $E = mc^2$ 应尽早渲染。\n\n',
  '| 项目 | 结果 |\n|---|---|\n| 表格 | 已渲染 |\n| 状态 | 正常 |\n\n',
  '```js\nconst sum = (a, b) => a + b;\nconst sample = sum(20, 22);\n```\n\n',
  '$$\nE = mc^2\n$$\n\n',
  ...Array.from({ length: 18 }, (_, i) => `完整段落 ${i + 1}：流式排版保持已完成内容，并继续检查用户滚动时的位置。\n\n`),
  '未完成代码片段：\n```js\n',
  'const partial = {\n',
  '  value: 42,\n',
  '};\n',
  '```\n\n',
  ...Array.from({ length: 14 }, (_, i) => `尾部继续生成 ${i + 1}，用于检查阅读跟随。`),
];

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* failed request body is still recorded */ }
    upstreamRequests.push(body);
    const plan = plans.shift() || { kind: 'quick', chunks: ['模拟回答完成。'] };
    if (plan.kind === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock deliberate failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const item of plan.chunks || []) {
      if (res.destroyed || res.writableEnded) return;
      const text = typeof item === 'string' ? item : item.text;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      await delay(typeof item === 'string' ? (plan.delay ?? 70) : (item.delay ?? plan.delay ?? 70));
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

let browser;
let reader;
let readerPort;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const aiPort = upstream.address().port;
  readerPort = await findPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1' },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait for isolated server */ }
  }
  check('隔离目录中的本地服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'ux-mock', apiKey: 'ux-mock-key' }),
  });

  const chrome = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx && !!window.__state);
  check('没有打开论文时隐藏发送范围提示', await page.$eval('#sendScope', (n) => n.classList.contains('hidden')));

  await page.goto(`${BASE}/?open=fixture-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await page.waitForFunction(() => window.__state.doc?.name === 'fixture-a.pdf' && window.__viewer.numPages === 16 && window.__state.viewerDocId === window.__state.doc.docId, { timeout: 30000 });
  check('切回论文时默认不预读整篇', await page.evaluate(() => !window.__state.docText && !window.__state.docTextDoc));
  const docA = await page.evaluate(() => window.__state.doc.docId);
  check('打开合成多页论文并提取全文', !!docA);

  // 设置只把高频项直接露出；低频样式默认折叠但仍可展开，避免阅读时被一长串滑杆打断。
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 6000 });
  const settingsCore = await page.evaluate(() => ({
    core: [...document.querySelectorAll('#settingsModal .settings-core-grid .field')]
      .filter((n) => n.getBoundingClientRect().height > 0)
      .map((n) => n.querySelector('select, input')?.id),
    open: !!document.querySelector('#advancedStyles[open]'),
    summary: document.querySelector('#advancedStyles > summary')?.textContent.trim(),
  }));
  // 核心区默认放「主题 / 结果密度 / 顶栏」三项：顶栏是 2026-10-03 新增的
  // 「悬停才出现 / 常驻」开关 —— 自动隐藏时顶栏在静息态整个移出屏幕，任何按坐标点击
  // 的路径（自动化、辅助技术）都会失败，所以必须给用户一个能关掉它的可见入口。
  check('设置默认只显示主题 / 结果密度 / 顶栏三项',
    settingsCore.core.join() === 'uiTheme,uiDensity,uiTopbar' && !settingsCore.open && settingsCore.summary === '更多样式',
    JSON.stringify(settingsCore));
  await page.click('#advancedStyles > summary');
  await wait(120);
  const advancedStyleIds = await page.evaluate(() => [...document.querySelectorAll('#advancedStyles input')].map((n) => n.id));
  check('展开更多样式后低频设置仍可用', advancedStyleIds.includes('uiUiFontSize') && advancedStyleIds.includes('uiOpacity') && advancedStyleIds.includes('uiShowSources'), advancedStyleIds.join(','));
  await page.click('#closeSettings');
  await wait(180);

  // Continuously jump through two outline entries, then restore exact scroll and zoom one step at a time.
  await page.evaluate(() => {
    window.__viewer.setScale(1.15, { keepCenter: false });
    window.__viewer.container.scrollTop = 360;
  });
  const origin = await page.evaluate(() => window.__viewer.capturePosition());
  await page.evaluate(() => [...document.querySelectorAll('#outlineList li')].find((n) => n.textContent.trim() === 'Section 2')?.click());
  await wait(700);
  const afterFirst = await page.evaluate(() => window.__viewer.capturePosition());
  await page.evaluate(() => [...document.querySelectorAll('#outlineList li')].find((n) => n.textContent.trim() === 'Section 4')?.click());
  await wait(700);
  const historyForA = await page.evaluate((id) => window.__state.jumpHistory.get(id)?.length || 0, docA);
  check('连续目录跳转各自记录阅读位置', historyForA === 2, `${historyForA} 个位置`);
  await page.click('#returnPosition');
  await page.waitForFunction((top, scale) => Math.abs(window.__viewer.container.scrollTop - top) < 2 && Math.abs(window.__viewer.scale - scale) < 0.005, {}, afterFirst.scrollTop, afterFirst.scale);
  await page.click('#returnPosition');
  await page.waitForFunction((top, scale) => Math.abs(window.__viewer.container.scrollTop - top) < 2 && Math.abs(window.__viewer.scale - scale) < 0.005, {}, origin.scrollTop, origin.scale);
  check('逐步返回恢复具体滚动位置和缩放', true);
  check('普通滚动不会生成跳转历史', await page.$eval('#returnPosition', (n) => n.classList.contains('hidden')));

  // Another document owns a separate history stack.
  await page.evaluate(() => window.__ctx.jumpToPageWithHistory(Math.min(2, window.__viewer.numPages), { smooth: false }));
  await wait(500);
  await page.evaluate(() => [...document.querySelectorAll('#fileList li')].find((n) => n.title.includes('fixture-b.pdf'))?.click());
  await page.waitForFunction(() => window.__state.doc?.name === 'fixture-b.pdf' && window.__state.viewerDocId === window.__state.doc.docId, { timeout: 30000 });
  check('切换论文后不显示另一篇论文的返回历史', await page.$eval('#returnPosition', (n) => n.classList.contains('hidden')));
  const docB = await page.evaluate(() => window.__state.doc.docId);
  await page.evaluate(() => window.__ctx.jumpToPageWithHistory(Math.min(3, window.__viewer.numPages), { smooth: false }));
  await wait(350);
  const bStack = await page.evaluate((id) => window.__state.jumpHistory.get(id)?.length || 0, docB);
  const aStack = await page.evaluate((id) => window.__state.jumpHistory.get(id)?.length || 0, docA);
  check('不同论文的返回栈互相独立', bStack === 1 && aStack === 1, `A=${aStack}，B=${bStack}`);
  await page.evaluate(() => [...document.querySelectorAll('#fileList li')].find((n) => n.title.includes('fixture-a.pdf'))?.click());
  await page.waitForFunction((id) => window.__state.doc?.docId === id && window.__state.viewerDocId === id, { timeout: 30000 }, docA);
  check('返回原论文时仍能看到该论文自己的历史', await page.$eval('#returnPosition', (n) => !n.classList.contains('hidden')));

  // Same-page individual matches, snippets, Enter navigation, exact highlight, and Escape focus return.
  await page.evaluate(() => {
    window.__viewer.container.scrollTop = 420;
    document.querySelector('#searchBtn').click();
    const input = document.querySelector('#searchInput');
    input.value = 'uniquesignal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const searchOrigin = await page.evaluate(() => window.__viewer.capturePosition());
  await page.waitForFunction(() => document.querySelectorAll('#searchResults .search-result').length >= 2, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.search-hit.current').length > 0, { timeout: 15000 });
  const firstHitPosition = await waitForStableScroll(page);
  const autoHitHistory = await page.evaluate((id) => window.__state.jumpHistory.get(id)?.map((p) => ({ scrollTop: p.scrollTop, scale: p.scale })) || [], docA);
  check('搜索自动跳转记录输入前位置', Math.abs((autoHitHistory.at(-1)?.scrollTop ?? NaN) - searchOrigin.scrollTop) < 2, JSON.stringify(autoHitHistory.at(-1)));
  const searchState = await page.evaluate(() => ({
    hits: window.__state.search.hits,
    rows: [...document.querySelectorAll('#searchResults .search-result')].slice(0, 12).map((n) => ({
      page: n.querySelector('.sr-page')?.textContent,
      mark: n.querySelector('mark')?.textContent,
      snippet: n.querySelector('.sr-snippet')?.textContent,
    })),
    currentMarks: document.querySelectorAll('.search-hit.current').length,
  }));
  const samePage = searchState.hits.filter((h) => h.page === 1);
  check('搜索列表展示同页的多个独立命中', samePage.length >= 2 && searchState.rows[0]?.page === 'p.1' && searchState.rows[0]?.mark.toLowerCase() === 'uniquesignal', `${samePage.length} 个 p.1 命中`);
  check('搜索跳转突出具体命中位置', searchState.currentMarks > 0, `${searchState.currentMarks} 个高亮片段`);
  await page.focus('#searchInput');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__state.search.idx === 1);
  await waitForStableScroll(page);
  check('Enter 跳到下一个（同页）结果', await page.$eval('#searchResults .search-result.current .sr-page', (n) => n.textContent === 'p.1'));
  await page.click('#returnPosition');
  await page.waitForFunction(() => window.__state.search.idx === 1 && !document.querySelector('#returnPosition').classList.contains('hidden'));
  await page.waitForFunction((top) => Math.abs(window.__viewer.container.scrollTop - top) < 2, {}, firstHitPosition);
  await page.click('#returnPosition');
  try {
    await page.waitForFunction((top, scale) => Math.abs(window.__viewer.container.scrollTop - top) < 2 && Math.abs(window.__viewer.scale - scale) < 0.005, { timeout: 8000 }, searchOrigin.scrollTop, searchOrigin.scale);
  } catch (error) {
    const actual = await page.evaluate(() => ({ top: window.__viewer.container.scrollTop, scale: window.__viewer.scale, stack: window.__state.jumpHistory.get(window.__state.doc.docId)?.length }));
    throw new Error(`${error.message}; search origin ${JSON.stringify(searchOrigin)}, actual ${JSON.stringify(actual)}`);
  }
  check('搜索命中跳转也能返回到原滚动和缩放', true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#searchBar').classList.contains('hidden') && document.activeElement.id === 'viewer');
  check('Esc 关闭搜索并把焦点交回阅读区', true);

  // Search results from an older term/document are discarded after a newer input or a paper switch.
  await page.evaluate(() => {
    const original = window.__viewer.search.bind(window.__viewer);
    window.__viewer.search = async (q, opts) => {
      if (q === 'delayed-old') {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return { hits: [{ page: 1, pageIndex: 0, index: 0, before: '', match: q, after: '' }], total: 1 };
      }
      return original(q, opts);
    };
    document.querySelector('#searchBtn').click();
    const input = document.querySelector('#searchInput');
    input.value = 'delayed-old'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(330);
  await page.evaluate(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'transformer'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#searchResults .search-result').length > 0, { timeout: 30000 });
  await wait(750);
  check('新搜索词立即使旧异步结果失效', await page.$eval('#searchResults', (n) => !n.textContent.includes('delayed-old')));
  await page.evaluate(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'delayed-old'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(330);
  await page.evaluate(() => [...document.querySelectorAll('#fileList li')].find((n) => n.title.includes('fixture-b.pdf'))?.click());
  await page.waitForFunction(() => window.__state.doc?.name === 'fixture-b.pdf' && window.__state.viewerDocId === window.__state.doc.docId, { timeout: 30000 });
  await wait(700);
  check('切换论文后旧搜索结果不串入新论文', await page.evaluate(() => document.querySelector('#searchResults').children.length === 0 && !window.__state.search.hits.length));

  await page.evaluate((id) => [...document.querySelectorAll('#fileList li')].find((n) => n.dataset.id === id)?.click(), docA);
  await page.waitForFunction((id) => window.__state.doc?.docId === id && window.__viewer.numPages === 16 && window.__state.viewerDocId === id, { timeout: 30000 }, docA);
  check('切回论文后仍不预读整篇', await page.evaluate(() => !window.__state.docText && !window.__state.docTextDoc));

  // The visible scope is built from the same immutable request snapshot.
  await page.evaluate(() => {
    const ctx = window.__ctx;
    if (!window.__state.useFullText) document.querySelector('#optFull').click();
    window.__state.useWeb = false;
    ctx.addToChat({ cleanText: 'selection alpha', page: 1 });
    ctx.addToChat({ cleanText: 'selection beta', page: 1 });
  });
  await page.click('#regionBtn');
  await page.waitForFunction(() => !document.querySelector('#regionOverlay').classList.contains('hidden'));
  const crop = await page.evaluate(() => {
    const vr = document.querySelector('#viewer').getBoundingClientRect();
    const p = [...document.querySelectorAll('.page')].map((n) => n.getBoundingClientRect())
      .find((r) => r.top < vr.bottom - 150 && r.bottom > vr.top + 150);
    return p ? { x: p.left + 55, y: Math.max(p.top, vr.top) + 90 } : null;
  });
  if (!crop) throw new Error('No visible synthetic PDF page for screenshot crop');
  await page.mouse.move(crop.x, crop.y);
  await page.mouse.down();
  await page.mouse.move(crop.x + 210, crop.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('#attachRow .attach.image img').length > 0, { timeout: 20000 });
  const capturedImage = await page.$eval('#attachRow .attach.image img', (img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  check('框选正文生成真实截图附件', capturedImage.w > 50 && capturedImage.h > 50, `${capturedImage.w}×${capturedImage.h}`);
  await page.evaluate(() => {
    const ctx = window.__ctx;
    const input = document.querySelector('#chatInput');
    input.value = '请说明选区和图片'; input.dispatchEvent(new Event('input', { bubbles: true }));
    ctx.updateSendScope();
  });
  const scopeBefore = await page.$eval('#sendScope', (n) => n.textContent);
  check('发送范围提示包含选区、图片、附近上下文和整篇论文', /选区 2 段/.test(scopeBefore) && /图片 1 张/.test(scopeBefore) && /附近上下文/.test(scopeBefore) && /整篇论文/.test(scopeBefore), scopeBefore);
  plans.push({ kind: 'fail', chunks: [] });
  const usersBefore = await page.$$eval('#aiArea .msg.user', (rows) => rows.length);
  await page.click('#sendBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .acts button')].some((b) => b.textContent.includes('重试这次发送')), { timeout: 15000 });
  const failed = await page.evaluate(() => ({
    input: document.querySelector('#chatInput').value,
    attachments: window.__state.attachments.map((a) => ({ kind: a.kind, text: a.text, dataUrl: a.dataUrl })),
    users: document.querySelectorAll('#aiArea .msg.user').length,
    scope: document.querySelector('#sendScope').textContent,
  }));
  const firstRequest = upstreamRequests.at(-1);
  const firstLast = firstRequest.messages.at(-1).content;
  const firstText = Array.isArray(firstLast) ? firstLast.find((p) => p.type === 'text')?.text || '' : firstLast;
  check('发送失败保留问题和两段文字及截图附件', failed.input === '请说明选区和图片' && failed.attachments.length === 3 && failed.users === usersBefore + 1);
  check('失败请求的实际范围与提示一致', /选区 2 段/.test(scopeBefore) && /图片 1 张/.test(scopeBefore) && /所在页上下文/.test(firstText) && /论文全文/.test(firstText) && Array.isArray(firstLast) && firstLast.filter((p) => p.type === 'image_url').length === 1);
  await wait(950);
  const docSession = await page.evaluate(async () => fetch(`/api/session?doc=${encodeURIComponent(window.__state.doc.docId)}`).then((r) => r.json()));
  check('失败状态兼容会话保存，截图只记标记不持久化', docSession.entries.some((e) => e.status === 'failed') && docSession.entries.some((e) => e.kind === 'user' && e.screenshot) && !JSON.stringify(docSession).includes('data:image'));

  // Keep formatted blocks flowing while the tail is still incomplete; do not yank a reader who scrolls up.
  plans.push({ kind: 'long', chunks: longChunks, delay: 75 });
  const retryRequestIndex = upstreamRequests.length;
  await page.evaluate(() => {
    const retry = [...document.querySelectorAll('#aiArea .msg.assistant .acts button')].find((b) => b.textContent.includes('重试这次发送'));
    retry.click();
    document.querySelector('#composer').requestSubmit();
  });
  await page.waitForFunction(() => window.__state.busy, { timeout: 10000 });
  await page.waitForFunction(() => {
    const body = [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1);
    return body?.querySelector('.katex') && body?.querySelector('table.md-table') && [...body.querySelectorAll('pre code')].some((n) => n.textContent.includes('const sample'));
  }, { timeout: 20000 });
  const liveBlocks = await page.evaluate(() => ({
    busy: window.__state.busy,
    math: !!document.querySelector('#aiArea .msg.assistant .text .katex'),
    table: !!document.querySelector('#aiArea .msg.assistant .text table.md-table'),
    code: [...document.querySelectorAll('#aiArea .msg.assistant .text pre code')].some((n) => n.textContent.includes('const sample')),
    users: document.querySelectorAll('#aiArea .msg.user').length,
  }));
  check('生成期间已完成段落、公式、表格和代码块提前渲染', liveBlocks.busy && liveBlocks.math && liveBlocks.table && liveBlocks.code && liveBlocks.users === usersBefore + 1);
  await page.waitForFunction(() => {
    const body = document.querySelector('.ai-body');
    return [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.querySelectorAll('p').length >= 12
      && body.scrollHeight > body.clientHeight + 100;
  }, { timeout: 15000 });
  await page.evaluate(() => { const body = document.querySelector('.ai-body'); body.scrollTop = 0; });
  await wait(160);
  const scrollAtTop = await page.$eval('.ai-body', (n) => n.scrollTop);
  await wait(320);
  check('用户上滚阅读时流式更新不把滚动条拉回底部', await page.$eval('.ai-body', (n) => Math.abs(n.scrollTop - 0) <= 2) && scrollAtTop <= 2);
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('const partial') && ![...document.querySelectorAll('#aiArea .msg.assistant .text pre code')].some((n) => n.textContent.includes('const partial')), { timeout: 15000 });
  check('未闭合代码块以稳定的增量文本显示', true);
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .text pre code')].some((n) => n.textContent.includes('const partial')), { timeout: 15000 });
  check('代码块闭合后在生成期间转为格式化代码', await page.evaluate(() => window.__state.busy));
  await page.waitForFunction(() => !window.__state.busy, { timeout: 30000 });
  const retryRequestText = JSON.stringify(upstreamRequests[retryRequestIndex]?.messages || []);
  check('失败后重试沿用原来的整篇范围', retryRequestText.includes('【论文全文'));
  const finalMarkdown = await page.evaluate(() => {
    const body = [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1);
    return { math: !!body.querySelector('.katex'), rows: body.querySelectorAll('table.md-table tbody tr').length, code: [...body.querySelectorAll('pre code')].map((n) => n.textContent).join('\n'), top: document.querySelector('.ai-body').scrollTop };
  });
  check('流式结束后公式、表格和完整代码仍正确', finalMarkdown.math && finalMarkdown.rows >= 2 && finalMarkdown.code.includes('const sample') && finalMarkdown.code.includes('const partial'));

  // Screenshot of the actual synthetic-paper UI for layout inspection.
  const layoutPng = await page.$eval('#aiArea .msg.user img', (img) => img.src);
  await page.evaluate((png) => {
    window.__ctx.addToChat({ cleanText: '版面检查选区一', page: 1 });
    window.__ctx.addToChat({ cleanText: '版面检查选区二', page: 1 });
    window.__ctx.addImageToChat({ dataUrl: png, width: 1, height: 1, pages: 1 }, 1, '版面检查截图');
    const draft = document.querySelector('#chatInput');
    draft.value = '检查发送范围提示'; draft.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.querySelector('#searchInput');
    document.querySelector('#searchBtn').click();
    input.value = 'attention'; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, layoutPng);
  await page.waitForFunction(() => document.querySelectorAll('#searchResults .search-result').length > 0, { timeout: 30000 });
  const layoutPath = path.join(SANDBOX, `ux-layout-${Date.now()}.png`);
  await page.screenshot({ path: layoutPath, fullPage: false });
  const layout = await page.evaluate(() => {
    const rect = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    return { search: rect('#searchBar'), viewer: rect('#viewer'), body: rect('.ai-body'), composer: rect('#composer'), scope: rect('#sendScope'), returnButton: rect('#returnPosition'), topbar: rect('.topbar'), scopeText: document.querySelector('#sendScope').textContent };
  });
  check('界面提示和输入区在布局内且没有重叠', layout.search.bottom <= layout.viewer.y + 2 && layout.body.bottom <= layout.composer.y + 2 && layout.scope.bottom <= layout.composer.bottom + 1 && layout.returnButton.x >= 0 && layout.returnButton.right <= 1500 && layout.topbar.bottom <= 47, layoutPath);
  console.log(`界面截图：${layoutPath}`);
  await page.evaluate(() => document.querySelector('#searchClose').click());
  await page.evaluate(() => {
    window.__state.attachments = [];
    window.__ctx.renderAttachments();
    const input = document.querySelector('#chatInput'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Stop keeps the partial answer and exposes copy/regenerate. Regenerating reuses its user row.
  plans.push({ kind: 'stop', chunks: [{ text: '部分回答已收到。', delay: 40 }, ...Array.from({ length: 20 }, (_, i) => ({ text: ` 后续${i + 1}`, delay: 180 }))] });
  await page.evaluate(() => {
    const input = document.querySelector('#chatInput');
    input.value = '停止后保留已收到的回答'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const beforeStopUsers = await page.$$eval('#aiArea .msg.user', (rows) => rows.length);
  const beforeStopRequests = upstreamRequests.length;
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelector('#stopBtn') && !document.querySelector('#stopBtn').classList.contains('hidden') && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('部分回答已收到'), { timeout: 15000 });
  await page.click('#stopBtn');
  await page.waitForFunction(() => !window.__state.busy, { timeout: 15000 });
  const stopped = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1);
    return { text: row.querySelector('.text').textContent, meta: row.querySelector('.entry-meta')?.textContent || '', actions: [...row.querySelectorAll('.acts button')].map((b) => b.textContent), users: document.querySelectorAll('#aiArea .msg.user').length };
  });
  check('主动停止保留部分回答且提供复制与重新生成', stopped.text.includes('部分回答已收到') && !stopped.text.includes('已停止') && /已停止/.test(stopped.meta) && stopped.actions.includes('复制') && stopped.actions.includes('重新生成'));
  check('停止中的连点没有重复发送', upstreamRequests.length === beforeStopRequests + 1 && stopped.users === beforeStopUsers + 1);
  plans.push({ kind: 'quick', chunks: ['重新生成成功。'] });
  await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .acts button')].find((b) => b.textContent === '重新生成')?.click());
  await page.waitForFunction(() => !window.__state.busy && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('重新生成成功'), { timeout: 15000 });
  check('停止后重新生成复用原用户消息', await page.$$eval('#aiArea .msg.user', (rows, expected) => rows.length === expected + 1, beforeStopUsers));

  // A long-paper downgrade is named in the live scope and matches the final request.
  const digestRequestStart = upstreamRequests.length;
  plans.push({ kind: 'quick', chunks: ['模拟阅读索引。'] }, { kind: 'quick', chunks: ['已提取相关段落。'] });
  await page.evaluate(() => {
    window.__ctx.setFullLimit(2000);
    if (!window.__state.useFullText) document.querySelector('#optFull').click();
    const input = document.querySelector('#chatInput');
    input.value = '定位关键结论'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__state.busy && document.querySelector('#sendScope').textContent.includes('整篇论文索引 + 6 段相关原文'), { timeout: 15000 });
  const liveDigestScope = await page.$eval('#sendScope', (n) => n.textContent);
  await page.waitForFunction(() => !window.__state.busy && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('已提取相关段落'), { timeout: 20000 });
  const finalDigestRequest = upstreamRequests.at(-1);
  const digestRequestText = JSON.stringify(finalDigestRequest?.messages || []);
  check('长文降级提示与实际索引/相关段落请求一致',
    upstreamRequests.length === digestRequestStart + 2
      && liveDigestScope.includes('整篇论文索引 + 6 段相关原文')
      && digestRequestText.includes('【阅读索引】')
      && digestRequestText.includes('与本次问题最相关的原文段落'));
  await page.evaluate(() => window.__ctx.setFullLimit(100000));
  check('浏览器运行无未处理错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (reader) { try { reader.kill(); } catch { /* already exited */ } }
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}

const passed = checks.filter((x) => x.ok).length;
console.log(`结果：${passed}/${checks.length} 通过`);
process.exitCode = passed === checks.length ? 0 : 1;
