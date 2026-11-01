/**
 * 引用定位验收（docs/右栏交互增强-设计.md §2/§3）：
 *  - 回答里的 〔p.N‖原文片段〕 渲染成可点页码；
 *  - 点击 → 跳到第 N 页 + 橙色高亮该片段；
 *  - 取消：再点同一个引用 toggle / Esc / 点正文任意处 / 翻页 / 切文档；
 *  - 找不到片段时退化为纯跳页，不留假激活态；旧格式 〔p.N〕 行为不变。
 *
 *   node test/citation-quote.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'citation-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'citation-paper.pdf'));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'other-paper.pdf'));

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

let answerOverride = '';
const upstreamLog = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    upstreamLog.push(sys);
    if (sys.includes('后台学习记忆提取器')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    if (sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '摘要' } }] })); return;
    }
    const answer = answerOverride || '默认回答。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,40}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

let reader = null;
let browser = null;
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
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'cite-mock', apiKey: 'cite-key' }),
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

  const openDoc = async (name) => {
    await page.goto(`${BASE}/?open=${encodeURIComponent(name)}&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
    await wait(700);
  };
  const state = () => page.evaluate(() => ({
    page: window.__viewer.current,
    hits: document.querySelectorAll('.quote-hit').length,
    active: document.querySelectorAll('.page-ref.quote-ref.active').length,
    quote: window.__ctx.quoteState,
  }));
  const ask = async (question) => {
    await page.evaluate(() => {
      const input = document.querySelector('#chatInput');
      input.value = '引用测试';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#sendBtn');
    await page.waitForFunction(() => !window.__state.busy, { timeout: 30000 });
    await wait(200);
  };
  const clickQuoteRef = async (pageNum = null) => {
    await page.evaluate((p) => {
      const list = [...document.querySelectorAll('.page-ref.quote-ref')];
      const btn = p != null ? list.find((b) => b.dataset.page === String(p)) : list.at(-1);
      btn?.click();
    }, pageNum);
    await wait(700);
  };

  await openDoc('citation-paper.pdf');
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); window.__ctx.setScopeRange('current'); });
  await wait(400);

  /* ── 准备：取第 5 页真实原文片段 ── */
  const snippet = await page.evaluate(async () => {
    const text = (await window.__viewer.getPageText(5)).replace(/\s+/g, ' ').trim();
    return text.slice(0, 70);
  });
  check('拿到第 5 页原文片段用于引用', !!snippet && snippet.length > 20, snippet.slice(0, 40));

  /* ── 1. 渲染：〔p.5‖片段〕变成可点页码 ── */
  answerOverride = `讲解：这段话在说注意力机制。〔p.5‖${snippet}〕\n\n另见〔p.3〕。`;
  await ask();
  const rendered = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#aiArea .page-ref')];
    return buttons.map((b) => ({ page: b.dataset.page, frag: b.dataset.fragment || '', label: b.textContent, title: b.title }));
  });
  check('带片段的引用渲染成页码按钮',
    rendered.some((b) => b.page === '5' && b.frag.length > 20 && b.frag.startsWith(snippet.slice(0, 20))),
    JSON.stringify(rendered).slice(0, 200));
  check('旧格式 〔p.3〕 仍是纯跳页按钮', rendered.some((b) => b.page === '3' && !b.frag), JSON.stringify(rendered).slice(0, 160));
  const visibleQuote = await page.evaluate(() => {
    const text = [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1);
    return {
      all: text?.textContent || '',
      inline: [...(text?.querySelectorAll('.quote-inline') || [])].map((n) => n.textContent).join('\n'),
    };
  });
  check('被引原文渲染后仍然可见（不会被页码按钮吞掉）',
    visibleQuote.inline.includes(snippet.slice(0, 30)), visibleQuote.inline.slice(0, 80));
  check('回答正文同时保留被引原文', visibleQuote.all.includes(snippet.slice(0, 30)), visibleQuote.all.slice(0, 80));

  /* ── 2. 点击：跳页 + 橙色高亮 + 激活态 ── */
  await clickQuoteRef();
  let s = await state();
  check('点击后跳到第 5 页', s.page === 5, String(s.page));
  check('页面上画出橙色高亮块', s.hits > 0, `${s.hits} 块`);
  check('引用按钮进入激活态', s.active === 1 && s.quote?.page === 5, JSON.stringify(s.quote));
  const color = await page.evaluate(() => {
    const el = document.querySelector('.quote-hit');
    return el ? getComputedStyle(el).backgroundColor : '';
  });
  check('高亮是橙色半透明', /rgba?\(\s*255\s*,\s*1[0-9]{2}\s*,\s*[0-9]{1,2}/.test(color), color);

  /* ── 3. 再点同一个 = toggle 取消 ── */
  await clickQuoteRef();
  s = await state();
  check('再点同一个引用取消高亮', s.hits === 0 && s.active === 0 && !s.quote?.page, JSON.stringify(s));

  /* ── 4. Esc 取消 ── */
  await clickQuoteRef();
  await page.keyboard.press('Escape');
  await wait(200);
  s = await state();
  check('Esc 取消高亮', s.hits === 0 && s.active === 0, JSON.stringify(s));

  /* ── 5. 点正文任意处取消 ── */
  await clickQuoteRef();
  const vr = await page.evaluate(() => {
    const r = document.querySelector('#viewer').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(vr.x, vr.y);
  await wait(200);
  s = await state();
  check('点正文任意处取消高亮', s.hits === 0 && s.active === 0, JSON.stringify(s));

  /* ── 6. 翻页自动清除 ── */
  await clickQuoteRef();
  await page.evaluate(async () => { await window.__viewer.goToPage(6); });
  await wait(500);
  s = await state();
  check('翻到别的页自动清除高亮', s.hits === 0 && s.active === 0, JSON.stringify(s));

  /* ── 7. 切文档自动清除 ── */
  await page.evaluate(async () => { await window.__viewer.goToPage(5); });
  await clickQuoteRef();
  await openDoc('other-paper.pdf');
  s = await state();
  check('切换文档后高亮被清掉', s.hits === 0 && !s.quote?.page, JSON.stringify(s));

  /* ── 8. 负例：片段在页面里找不到 → 退化为纯跳页，不留假激活态 ── */
  await openDoc('citation-paper.pdf');
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  answerOverride = '找不到的引用：〔p.7‖这段原文根本不在这一页 XYZ_NOT_FOUND〕';
  await ask();
  await clickQuoteRef(7);
  s = await state();
  check('片段找不到时仍跳到第 7 页', s.page === 7, String(s.page));
  check('片段找不到时不画假高亮/不留激活态', s.hits === 0 && s.active === 0 && !s.quote?.page, JSON.stringify(s));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n引用定位：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
