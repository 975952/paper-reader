/**
 * 问答「所在页 / 上下文」定位验收：
 *  1. 打开后页码等于屏幕实际显示页（不是被尺寸未补齐时的保守值/最后一页）；
 *  2. 滚动到第 N 页问「这一页」→ 上下文与「第 N 页」跟着屏幕走；
 *  3. 先解释过第 2 页、再滚到第 8 页追问「为什么」→ 对象和所在页都是第 2 页的话题，
 *     不能把屏幕上的第 8 页当成新上下文；历史里要能带上一轮回答；
 *  4. 追问后又说「这一页」→ 屏幕页重新生效（第 8 页）；
 *  5. 问题里明说「第 5 页」→ 即使屏幕在第 12 页也用第 5 页；
 *  6. 右栏回答里划来的文字不是 PDF 原文：不挂页码，语境按屏幕页；
 *  7. 直接改 scrollTop（不等节流）后立刻提问 → 仍按新页面取上下文。
 *
 *   node test/context-page.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'context-page-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'context-paper.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（180s），强制退出'); process.exit(3); }, 180000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

const upstreamLog = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    const last = body.messages?.at(-1);
    const text = Array.isArray(last?.content)
      ? (last.content.find((p) => p.type === 'text')?.text || '')
      : String(last?.content || '');
    upstreamLog.push({ sys, text, messages: body.messages || [] });
    if (sys.includes('后台学习记忆提取器')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    if (sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '摘要' } }] })); return;
    }
    const answer = '这是回答。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  });
});

let reader = null;
let browser = null;
const chatBodies = () => upstreamLog.filter((r) => !/后台学习记忆提取器|滚动摘要/.test(r.sys));
try {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const aiPort = upstream.address().port;
  const readerPort = await findPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'page-mock', visionModel: '', apiKey: 'page-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?open=context-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0 && window.__ctx, { timeout: 40000 });
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await wait(1500);   // 等分页尺寸补齐（第二轮 _handleScroll）

  const opened = await page.evaluate(() => ({
    current: window.__viewer.current,
    visible: window.__viewer.currentVisiblePage(),
    scrollTop: document.querySelector('#viewer').scrollTop,
  }));
  check('打开后「当前页」是第 1 页（不是最后一页）',
    opened.visible === 1 && opened.scrollTop < 5, JSON.stringify(opened));

  const pageTexts = await page.evaluate(async () => {
    const out = {};
    for (const n of [2, 5, 8, 12]) out[n] = (await window.__viewer.getPageText(n)).replace(/\s+/g, ' ').trim();
    return out;
  });
  check('夹具各页文本不同（断言才有意义）',
    pageTexts[2] !== pageTexts[8] && pageTexts[8] !== pageTexts[12]);

  const ask = async (question) => {
    await page.evaluate((q) => {
      const input = document.querySelector('#chatInput');
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, question);
    await page.click('#sendBtn');
    await page.waitForFunction(() => !window.__state.busy, { timeout: 30000 });
    await wait(150);
    return chatBodies().at(-1) || {};
  };

  /* ── 1. 滚到第 5 页问「这一页」：上下文与页码都应是 5 ── */
  await page.evaluate(() => window.__ctx.setScopeRange('current'));
  await page.evaluate(async () => { await window.__viewer.goToPage(5); });
  await wait(400);
  let req = await ask('这一页讲了什么？');
  check('滚动后问「这一页」带第 5 页', /第\s*5\s*页/.test(req.text), (req.text || '').slice(0, 80));
  check('上下文是第 5 页正文', pageTexts[5].slice(0, 40) && req.text.includes(pageTexts[5].slice(0, 40)),
    (pageTexts[5] || '').slice(0, 40));
  const entryPage = await page.evaluate(() => window.__state.sessionEntries.at(-1)?.page);
  check('回答条目标注第 5 页', entryPage === 5, String(entryPage));

  /* ── 2. 先解释第 2 页，再滚到第 8 页追问「为什么」：留在第 2 页话题，不吃屏幕页 ── */
  const excerpt2 = pageTexts[2].slice(0, 60);
  await page.evaluate((t) => window.__ctx.doExplain({ text: t, cleanText: t, page: 2 }), excerpt2);
  await page.waitForFunction(() => !window.__state.busy, { timeout: 30000 });
  await page.evaluate(async () => { await window.__viewer.goToPage(8); });
  await wait(400);
  req = await ask('为什么？');
  check('追问带话题页「第 2 页」而不是屏幕第 8 页', /第\s*2\s*页/.test(req.text), (req.text || '').slice(0, 120));
  check('追问上下文是第 2 页原文', req.text.includes(pageTexts[2].slice(0, 40)), (pageTexts[2] || '').slice(0, 40));
  check('追问上下文没有混入屏幕第 8 页', !req.text.includes(pageTexts[8].slice(0, 40)), (pageTexts[8] || '').slice(0, 40));
  const followEntryPage = await page.evaluate(() => window.__state.sessionEntries.at(-1)?.page);
  check('追问条目标注话题页 2', followEntryPage === 2, String(followEntryPage));
  check('追问请求带上了一轮回答（会话内记忆）',
    req.messages?.some((m) => m.role === 'assistant' && String(m.content).includes('这是回答')));
  check('系统提示要求追问别把滚动到的页当新话题', /不要因为读者滚到了别的页/.test(req.sys || ''));

  /* ── 3. 追问后又说「这一页」：以屏幕第 8 页为准 ── */
  req = await ask('这一页讲了什么？');
  check('再用「这一页」时回到屏幕第 8 页', /第\s*8\s*页/.test(req.text), (req.text || '').slice(0, 100));
  check('「这一页」上下文是第 8 页正文', req.text.includes(pageTexts[8].slice(0, 40)), (pageTexts[8] || '').slice(0, 40));

  /* ── 4. 明说「第 5 页」：屏幕在第 8 页也用第 5 页 ── */
  req = await ask('第 5 页讲了什么？');
  check('明说页码时按第 5 页取上下文', /第\s*5\s*页/.test(req.text) && req.text.includes(pageTexts[5].slice(0, 40)),
    (pageTexts[5] || '').slice(0, 40));

  /* ── 5. 直接改 scrollTop（不等滚动节流）后立刻提问：按新页面 ── */
  await page.evaluate(() => {
    const v = window.__viewer;
    v.container.scrollTop = v.offsets[12] ?? 0;
  });
  req = await ask('这一页呢？');
  check('直接改 scrollTop 后立即提问也按第 12 页', /第\s*12\s*页/.test(req.text), (req.text || '').slice(0, 80));
  check('直接改 scrollTop 后上下文是第 12 页', req.text.includes(pageTexts[12].slice(0, 40)), (pageTexts[12] || '').slice(0, 40));

  /* ── 6. 右栏回答里划来的文字：不冒充第 2 页原文，语境按屏幕第 8 页 ── */
  const rightExcerpt = pageTexts[2].slice(0, 50);
  await page.evaluate((t) => window.__ctx.addToChat({ text: t, cleanText: t, page: null, source: 'right' }), rightExcerpt);
  await page.evaluate(async () => { await window.__viewer.goToPage(8); });
  await wait(400);
  req = await ask('为什么？');
  check('右栏划来的文字标明来自右栏、不标成某页原文',
    /来自右栏回答/.test(req.text) && !/第\s*2\s*页/.test(req.text), (req.text || '').slice(0, 160));
  check('右栏文字提问的语境按屏幕第 8 页', /第\s*8\s*页/.test(req.text) && req.text.includes(pageTexts[8].slice(0, 40)),
    (pageTexts[8] || '').slice(0, 40));
  const rightEntryPage = await page.evaluate(() => window.__state.sessionEntries.at(-1)?.page);
  check('右栏文字问答条目标注屏幕页 8', rightEntryPage === 8, String(rightEntryPage));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n当前页定位：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
