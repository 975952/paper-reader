/** Real embedded exe: closed sidebar translation card, open sidebar result, and PDF horizontal reach. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-translation-layout-'));
const data = path.join(temp, 'data');
const papers = path.join(temp, 'papers');
const sampleName = `${path.basename(temp)}.pdf`;
fs.mkdirSync(data);
fs.mkdirSync(papers);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(papers, sampleName));
const exe = path.join(temp, 'reader.exe');
fs.copyFileSync(path.join(root, '论文阅读器.exe'), exe);
const child = spawn(exe, ['--background'], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers, PRT_REQUIRE_TOKEN: '0',
} });
let browser;
try {
  let base;
  // 只认「自己的」服务：papers 里必须有本测试的临时 fixture（Rust 版 /api/papers 不返回 dir 字段，
  // 所以不能拿目录路径比对）；端口从 8760 起扫，避免用户正在用的实例（8787）被误当成测试服务。
  for (let i = 0; i < 80 && !base; i++) {
    await new Promise((r) => setTimeout(r, 250));
    for (let port = 8760; port < 8860; port++) {
      try {
        const url = `http://127.0.0.1:${port}`;
        const listing = await fetch(`${url}/api/papers`, { signal: AbortSignal.timeout(150) }).then((r) => r.json());
        if ((listing.papers || []).some((paper) => paper.name === sampleName)) { base = url; break; }
      } catch {}
    }
  }
  assert.ok(base, 'isolated exe started');
  const embedded = await fetch(`${base}/js/app.js`).then((r) => r.text());
  assert.equal(embedded, fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8'), 'exe embeds current frontend');
  const configResponse = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    baseURL: 'http://127.0.0.1:1/v1', model: 'mock', apiKey: 'layout-test-key',
  }) });
  assert.equal(configResponse.status, 200, 'isolated fake model configured');
  const chrome = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p && fs.existsSync(p));
  assert.ok(chrome, 'Chrome or Edge available');
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], userDataDir: path.join(temp, 'profile'),
    defaultViewport: { width: 1250, height: 850 } });
  const page = await browser.newPage();
  const errors = [];
  let chatCount = 0;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`${r.url()} ${r.failure()?.errorText}`); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().endsWith('/api/chat')) return req.continue();
    chatCount++;
    const answer = '这是测试译文：侧栏关闭时显示卡片。';
    const sse = answer.match(/.{1,8}/gu).map((piece) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fileList li');
  await page.evaluate(() => document.querySelector('#fileList li').click());
  await page.waitForFunction(() => window.__viewer?.pdf && document.querySelector('.page .textLayer span'));
  const select = async (start, end, action = 'translate') => {
    await page.evaluate((a, b) => {
      const spans = [...document.querySelectorAll('.page[data-page="1"] .textLayer span')]
        .filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE && s.textContent.trim().length > 3);
      const range = document.createRange();
      range.setStart(spans[a].firstChild, 0);
      range.setEnd(spans[b].firstChild, spans[b].firstChild.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, start, end);
    await page.waitForSelector('#bubble:not(.hidden)');
    await page.click(`#bubble [data-act="${action}"]`);
  };
  const widthBefore = await page.$eval('#viewer', (el) => el.clientWidth);
  await select(1, 3);
  await page.waitForFunction(() => document.querySelector('#translationCardText').textContent.includes('测试译文'));
  const closed = await page.evaluate(() => {
    const card = document.querySelector('#translationCard').getBoundingClientRect();
    return { cardVisible: !document.querySelector('#translationCard').classList.contains('hidden'),
      rightWidth: document.querySelector('#rightCols').getBoundingClientRect().width,
      viewerWidth: document.querySelector('#viewer').clientWidth,
      saved: window.__state.sessionEntries.some((e) => e.block === 'translate' && e.text.includes('测试译文')),
      cardInWindow: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight };
  });
  assert.ok(chatCount === 1 && closed.cardVisible && closed.rightWidth === 0 && Math.abs(closed.viewerWidth - widthBefore) < 3
    && closed.saved && closed.cardInWindow, `closed sidebar: ${JSON.stringify(closed)}`);
  console.log('PASS closed sidebar: translation card, saved result, PDF width unchanged');

  const drag = await page.$eval('#translationCard', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + 35, y: r.top + 12, left: r.left, top: r.top,
      dx: r.right + 90 < innerWidth ? 90 : -90, dy: r.bottom + 40 < innerHeight ? 40 : -40 };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.dx, drag.y + drag.dy, { steps: 8 });
  await page.mouse.up();
  const moved = await page.$eval('#translationCard', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, visible: !el.classList.contains('hidden') };
  });
  assert.ok(moved.visible && Math.abs(moved.left - drag.left) > 50 && Math.abs(moved.top - drag.top) > 20,
    `card drag: ${JSON.stringify({ drag, moved })}`);
  console.log('PASS translation card: title drag moves card and keeps it open');

  await page.click('#translationCardClose');
  await page.click('#topbarRightToggle');
  await page.waitForFunction(() => document.querySelector('#rightCols').getBoundingClientRect().width > 200);
  await page.click('#aiBar .aibar-btn[data-block="translate"]');
  await page.waitForFunction(() => document.querySelector('#aiArea .msg .text')?.textContent.includes('测试译文'));
  await new Promise((r) => setTimeout(r, 450));
  const fitted = await page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    const vr = viewer.getBoundingClientRect();
    const pr = document.querySelector('.page[data-page="1"]').getBoundingClientRect();
    return { left: pr.left - vr.left, right: vr.right - pr.right, fitMode: window.__viewer._fitMode };
  });
  assert.ok(fitted.fitMode && fitted.left >= -2 && fitted.right >= -2, `fit after opening sidebar: ${JSON.stringify(fitted)}`);
  console.log('PASS opening sidebar: saved translation visible and PDF fits its new width');

  await select(5, 7);
  await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg .text').length >= 2);
  assert.equal(await page.$eval('#translationCard', (el) => el.classList.contains('hidden')), true);
  console.log('PASS open sidebar: translation stays in result pane');

  await page.click('#topbarRightToggle');
  await page.waitForFunction(() => document.querySelector('#rightCols').getBoundingClientRect().width === 0);
  await select(9, 11, 'explain');
  await page.waitForFunction(() => document.querySelector('#rightSide')?.dataset.activePanel === 'chat'
    && document.querySelector('#rightCols').getBoundingClientRect().width > 200
    && [...document.querySelectorAll('#aiArea .msg .text')].some((el) => el.textContent.includes('测试译文')));
  console.log('PASS direct explanation: right sidebar opens in chat mode');

  const horizontal = await page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    window.__viewer.setScale(window.__viewer.scale * 2);
    viewer.scrollLeft = 0;
    const vr = viewer.getBoundingClientRect();
    const page = document.querySelector('.page[data-page="1"]');
    const left = page.getBoundingClientRect().left - vr.left;
    const max = viewer.scrollWidth - viewer.clientWidth;
    viewer.scrollLeft = max;
    const right = vr.right - page.getBoundingClientRect().right;
    return { max, left, right, scrollLeft: viewer.scrollLeft };
  });
  assert.ok(horizontal.max > 100 && horizontal.left >= -3 && horizontal.right >= -20
    && horizontal.scrollLeft > 100, `horizontal access: ${JSON.stringify(horizontal)}`);
  console.log('PASS zoomed PDF: both edges reachable by horizontal scrolling');

  const wheelPoint = await page.$eval('#viewer', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.evaluate(() => { const el = document.querySelector('#viewer'); el.scrollLeft = 100; el.scrollTop = 0; });
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel({ deltaX: 110, deltaY: 130 });
  await new Promise((r) => setTimeout(r, 250));
  const swiped = await page.$eval('#viewer', (el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(swiped.x > 100 && swiped.y > 0, `two-finger swipe: ${JSON.stringify(swiped)}`);
  console.log('PASS two-finger swipe: PDF scrolls horizontally and vertically');

  const pinchBefore = await page.evaluate(({ x, y }) => {
    const r = document.querySelector('.page[data-page="1"]').getBoundingClientRect();
    return { scale: window.__viewer.scale, x: (x - r.left) / r.width, y: (y - r.top) / r.height };
  }, wheelPoint);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPoint.x, y: wheelPoint.y,
    deltaX: 0, deltaY: -45, modifiers: 2, pointerType: 'mouse' });
  await page.waitForFunction((before) => window.__viewer.scale > before, {}, pinchBefore.scale);
  await new Promise((r) => setTimeout(r, 200));
  const pinchAfter = await page.evaluate(({ x, y }) => {
    const r = document.querySelector('.page[data-page="1"]').getBoundingClientRect();
    return { scale: window.__viewer.scale, x: (x - r.left) / r.width, y: (y - r.top) / r.height };
  }, wheelPoint);
  assert.ok(pinchAfter.scale > pinchBefore.scale && Math.abs(pinchAfter.x - pinchBefore.x) < .04
    && Math.abs(pinchAfter.y - pinchBefore.y) < .04,
  `pinch anchor: ${JSON.stringify({ pinchBefore, pinchAfter })}`);
  console.log('PASS pinch on PDF: zooms around pointer');
  const batched = await page.evaluate(async ({ x, y }) => {
    const v = window.__viewer;
    const startingScale = v.scale;
    const layout = v.layout;
    let layouts = 0;
    v.layout = function (...args) { layouts++; return layout.apply(this, args); };
    try {
      const target = document.elementFromPoint(x, y);
      for (let i = 0; i < 12; i++) target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -4, clientX: x, clientY: y,
      }));
      const immediateLayouts = layouts;
      await new Promise((r) => setTimeout(r, 250));
      return { startingScale, scale: v.scale, immediateLayouts, layouts };
    } finally { v.layout = layout; }
  }, wheelPoint);
  assert.ok(batched.scale > batched.startingScale && batched.immediateLayouts === 0
    && batched.layouts > 0 && batched.layouts < 12, `batched pinch: ${JSON.stringify(batched)}`);
  console.log('PASS rapid pinch events: coalesced into smooth display frames');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
} finally {
  await browser?.close();
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { child.kill(); } catch {}
  if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)
      && path.basename(temp).startsWith('prt-translation-layout-')) {
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
}
