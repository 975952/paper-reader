/**
 * 译文块：纯净界面 / 滚动 / 引用跳回
 *   node test/translate-pure.mjs
 *
 * 用户口径（2026-10）：
 *   ①「翻译的怎么滚动不了了」—— 译文多了以后滚不动；
 *   ②「翻译的去掉所有的功能按键，就做最纯净的界面」；
 *   ③「把原文引用的那一块做成可点击的，点击就自动跳回」。
 *
 * 三个都验：
 *   · 长译文（24 段）能滚：scrollHeight > clientHeight，且真的能改 scrollTop；
 *   · 译文条目的动作条里**没有任何按钮**（复制 / 回原文 / 接着问 / 笔记全去掉），
 *     role 行里也不再有「回原文」图标；
 *   · 原文引用整块可点（button + 手型 + 可访问名），点它页码跳到引用所在页；
 *   · 问答条目的动作条**不受影响**（复制 / 笔记仍在）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tr-pure-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'pure-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const QUOTE = 'An attention function can be described as mapping a query and a set of key-value pairs to an output';

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const p = probe.address().port;
  await new Promise((r) => probe.close(r));
  return p;
}

let browser;
let server;
try {
  const port = await findPort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { await wait(100); try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ } }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('服务没起来');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'pure', apiKey: 'pure-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/?open=${encodeURIComponent('pure-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(500);
  await page.evaluate(() => { document.body.classList.remove('no-right'); window.__ctx.setPanelVisible('translate', true); window.__ctx.applyPanels(); });
  await wait(500);

  /* 一条长译文（24 段，确保溢出）+ 一条问答（对照）。
     注意：addEntry 默认会把「它所在的那一块」设为可见，所以最后要显式把译文块打开。 */
  await page.evaluate((quote) => {
    const chat = window.__ctx.addEntry({ block: 'chat', tag: 'answer', page: 2, quote: '当前页上下文' });
    window.__ctx.streamTarget(chat.body).done('这是一条问答回答，用来对照动作条没有被一起清掉。');
    window.__ctx.finishEntry(chat, '这是一条问答回答，用来对照动作条没有被一起清掉。', { page: 2 });
    const tr = window.__ctx.addEntry({ block: 'translate', tag: 'translation', page: 3, quote });
    const long = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段译文：注意力函数把 query 与一组 key-value 对映射成输出，权重由兼容度计算。`).join('\n\n');
    window.__ctx.streamTarget(tr.body).done(long);
    window.__ctx.finishEntry(tr, long, { page: 3, onAsk: () => { window.__asked = true; } });
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.applyPanels();
  }, QUOTE);
  await wait(700);

  /* ① 滚动 */
  const scroll = await page.evaluate(() => {
    const body = document.querySelector('.ai-block[data-block="translate"] .ai-body');
    const before = body.scrollTop;
    body.scrollTop = 400;                      // 直接改，验证真的能滚
    const after = body.scrollTop;
    body.scrollTop = 0;
    return {
      scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      overflow: body.scrollHeight - body.clientHeight,
      before: Math.round(before), after: Math.round(after),
      canScroll: body.scrollHeight > body.clientHeight + 4,
    };
  });
  check('① 长译文撑出了可滚高度（条目没被 flex 压扁）', scroll.canScroll, `overflow=${scroll.overflow}px`);
  check('① 真的能滚（改 scrollTop 生效）', scroll.after > 0, `${scroll.before} → ${scroll.after}`);

  /* ② 译文块没有功能按键 */
  const pure = await page.evaluate(() => {
    const msg = document.querySelector('.ai-block[data-block="translate"] .msg');
    const acts = msg.querySelector('.acts');
    const visible = (el) => !!el && el.getClientRects().length > 0;
    return {
      actsButtons: [...acts.querySelectorAll('button')].length,
      actsVisibleButtons: [...acts.querySelectorAll('button')].filter(visible).length,
      actsVisible: visible(acts),
      roleButtons: [...msg.querySelectorAll('.role button')].filter(visible).length,
      allButtons: [...msg.querySelectorAll('button')].filter(visible)
        .map((b) => b.className || b.getAttribute('aria-label') || ''),
    };
  });
  check('② 译文条目的动作条里没有任何按钮',
    pure.actsButtons === 0 && pure.actsVisibleButtons === 0, JSON.stringify(pure));
  check('② 动作条本身也不占位（视觉上完全消失）', !pure.actsVisible, '');
  check('② role 行里的「回原文」图标也去掉了', pure.roleButtons === 0, JSON.stringify(pure));
  check('② 整条译文上唯一的可见按钮就是那块引用（最纯净）',
    pure.allButtons.length === 1 && /ref-jump/.test(pure.allButtons[0]), JSON.stringify(pure.allButtons));

  /* ② 问答块不受影响（切到问答再量） */
  const chatActs = await page.evaluate(async () => {
    window.__ctx.setPanelVisible('chat', true);
    window.__ctx.applyPanels();
    await new Promise((r) => setTimeout(r, 200));
    const msg = [...document.querySelectorAll('.ai-block[data-block="chat"] .msg.assistant')].at(-1);
    if (!msg) return { visible: false, buttons: 0, labels: [] };
    const acts = msg.querySelector('.acts');
    return {
      visible: acts.getClientRects().length > 0,
      buttons: acts.querySelectorAll('button').length,
      labels: [...acts.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
    };
  });
  check('② 问答条目的动作条没被一起清掉（复制 / 笔记还在）',
    chatActs.visible && chatActs.buttons >= 2 && chatActs.labels.some((l) => /复制/.test(l)) && chatActs.labels.some((l) => /笔记/.test(l)),
    JSON.stringify(chatActs));

  /* 切回译文，后面几条断言都在译文块上做 */
  await page.evaluate(async () => {
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.applyPanels();
    await new Promise((r) => setTimeout(r, 250));
  });

  /* ③ 原文引用可点击跳回 */
  const ref = await page.evaluate(() => {
    const msg = document.querySelector('.ai-block[data-block="translate"] .msg');
    const r = msg.querySelector('.ref');
    const cs = getComputedStyle(r);
    const rect = r.getBoundingClientRect();
    return {
      tag: r.tagName, cls: r.className, role: r.getAttribute('type') || '',
      cursor: cs.cursor, aria: r.getAttribute('aria-label') || '',
      title: (r.getAttribute('title') || '').slice(0, 30),
      text: (r.textContent || '').slice(0, 30),
      width: Math.round(rect.width), msgWidth: Math.round(msg.getBoundingClientRect().width),
      pageBefore: document.getElementById('pageInput')?.value || '',
    };
  });
  check('③ 原文引用是一个真正的按钮（可点、可键盘触发）',
    ref.tag === 'BUTTON' && ref.type !== undefined || ref.tag === 'BUTTON', JSON.stringify({ tag: ref.tag }));
  check('③ 引用块是手型 + 有可访问名 + 占满整行',
    ref.cursor === 'pointer' && /跳回第 3 页原文/.test(ref.aria) && ref.width > ref.msgWidth * 0.8,
    `${ref.cursor} / ${ref.aria} / ${ref.width}·${ref.msgWidth}`);

  const beforeJump = await page.evaluate(() => document.getElementById('pageInput')?.value || '');
  await page.click('.ai-block[data-block="translate"] .msg .ref');
  await wait(900);
  const afterJump = await page.evaluate(() => ({
    page: document.getElementById('pageInput')?.value || '',
    returnVisible: !document.getElementById('returnPosition')?.classList.contains('hidden'),
  }));
  check('③ 点引用块自动跳回引用所在页（第 3 页）',
    String(afterJump.page) === '3' && String(beforeJump) !== '3', `${beforeJump} → ${afterJump.page}`);
  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`译文块纯净化验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
