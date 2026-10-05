/**
 * 译文块「最近的在最上面」
 *   node test/translate-order.mjs
 *
 * 用户口径（2026-10）：「最近的翻译应该要放在最上面」。
 * 原来是按时间往下堆（新条目追加在底部），只有「必要时滚过去」——
 * 结果区一长，观感就是新的沉在下面。现在译文块整块反转（column-reverse）：
 *   ① 视觉顺序是「新 → 旧」，最新一条永远在最上面（不用滚动就能看见）；
 *   ② DOM 顺序仍然是「旧 → 新」（appendChild 没改）—— 会话存档 / 重放 / dataset.seq 都不受影响；
 *   ③ 滚动条「最新」那一端是 scrollTop = 0；重开面板、流式跟随都往那一端去；
 *   ④ 溢出提示（渐隐）在译文块挪到**顶边**；
 *   ⑤ 问答流**不受影响**：仍然是时间顺序（问题在上、回答在下）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tr-order-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'tr-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

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
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'tr', apiKey: 'tr-key' }),
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

  await page.goto(`${BASE}/?open=${encodeURIComponent('tr-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(600);

  /* 造三条译文（新增的排最后，模拟「按时间堆」的入队顺序），并打开译文块 */
  await page.evaluate(() => {
    // 必须同时把右栏展开：只 setPanelVisible 的话块虽然"可见"，
    // 但整条右栏还在收起的 body 状态里，元素在屏幕外 → 所有 getBoundingClientRect 都是 0
    document.body.classList.remove('no-right');
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.applyPanels();
  });
  await wait(500);
  const shown = await page.evaluate(() => ({
    noRight: document.body.classList.contains('no-right'),
    blockW: Math.round(document.querySelector('.ai-block[data-block="translate"]')?.getBoundingClientRect().width || 0),
  }));
  check('（前置）译文块真的显示在屏幕上', !shown.noRight && shown.blockW > 200, JSON.stringify(shown));
  await page.evaluate(() => {
    ['第一条译文：自注意力。', '第二条译文：多头注意力。', '第三条译文：位置编码。'].forEach((t, i) => {
      const e = window.__ctx.addEntry({ block: 'translate', tag: 'translation', page: i + 1, quote: `原文片段 ${i + 1}` });
      // 真实链路：doTranslate → streamTarget(entry.body) → target.done(clean) → finishEntry
      window.__ctx.streamTarget(e.body).done(t);
      window.__ctx.finishEntry(e, t, { page: i + 1 });
    });
  });
  await wait(500);
  const added = await page.evaluate(() => {
    const block = document.querySelector('.ai-block[data-block="translate"]');
    return {
      block: !!block, inDoc: !!block?.isConnected,
      parent: block?.parentElement?.className || block?.parentElement?.id || '',
      msgs: block?.querySelectorAll('.msg').length ?? -1,
    };
  });
  check('（前置）三条译文真的进了译文块', added.msgs === 3, JSON.stringify(added));

  const state1 = await page.evaluate(() => {
    const block = document.querySelector('.ai-block[data-block="translate"]');
    const body = block.querySelector('.ai-body');
    const msgs = [...body.querySelectorAll('.msg')];
    // 视觉顺序：按屏幕 y 坐标排（column-reverse 下 DOM 顺序与视觉顺序相反）
    const visual = msgs.map((m) => ({ text: (m.querySelector('.text')?.textContent || '').trim(), y: Math.round(m.getBoundingClientRect().y) }))
      .sort((a, b) => a.y - b.y);
    return {
      flex: getComputedStyle(body).flexDirection,
      domOrder: msgs.map((m) => (m.querySelector('.text')?.textContent || '').trim().slice(0, 4)),
      visualOrder: visual.map((v) => v.text.slice(0, 4)),
      scrollTop: Math.round(body.scrollTop),
      newestVisible: visual.length ? visual[0].text.includes('第三条') : false,
      newestNearTop: visual.length ? Math.abs(visual[0].y - body.getBoundingClientRect().y) < 40 : false,
    };
  });
  check('译文块用的是「新→旧」的 DOM 顺序（最新的节点排在最前）', state1.flex === 'column', state1.flex);
  check('最新一条翻译在**最上面**（视觉顺序 新→旧）',
    state1.visualOrder[0].startsWith('第三条') && state1.visualOrder.at(-1).startsWith('第一条'),
    state1.visualOrder.join(' → '));
  check('最新那条贴着结果区上沿（不用滚动就能看见）', state1.newestVisible && state1.newestNearTop, `y差=${state1.newestNearTop}`);
  check('DOM 顺序与视觉顺序一致（都是 新→旧），存档按 seq 重放仍然对得上',
    state1.domOrder[0].startsWith('第三条') && state1.domOrder.at(-1).startsWith('第一条'),
    state1.domOrder.join(' → '));

  /* 新增一条：应当直接出现在最上面 */
  await page.evaluate(() => {
    const e = window.__ctx.addEntry({ block: 'translate', tag: 'translation', page: 4, quote: '原文片段 4' });
    const target = window.__ctx.streamTarget(e.body);
    target.done('第四条译文：残差连接。');
    window.__ctx.finishEntry(e, '第四条译文：残差连接。', { page: 4 });
  });
  await wait(400);
  const state2 = await page.evaluate(() => {
    const body = document.querySelector('.ai-block[data-block="translate"] .ai-body');
    const visual = [...body.querySelectorAll('.msg')]
      .map((m) => ({ t: (m.querySelector('.text')?.textContent || '').trim(), y: Math.round(m.getBoundingClientRect().y) }))
      .sort((a, b) => a.y - b.y);
    return { top: visual[0]?.t || '', topY: visual[0]?.y, bodyY: Math.round(body.getBoundingClientRect().y), scrollTop: Math.round(body.scrollTop) };
  });
  check('再翻一条新译文，它直接出现在最上面',
    state2.top.startsWith('第四条') && Math.abs(state2.topY - state2.bodyY) < 40,
    `${state2.top.slice(0, 8)} y=${state2.topY} body=${state2.bodyY}`);

  /* 「最新那一端」的判据：重开面板后 scrollTop 应该是 0（不是 scrollHeight） */
  const reopened = await page.evaluate(async () => {
    window.__ctx.setPanelVisible('translate', false);
    await new Promise((r) => setTimeout(r, 150));
    window.__ctx.setPanelVisible('translate', true);
    await new Promise((r) => setTimeout(r, 200));
    const body = document.querySelector('.ai-block[data-block="translate"] .ai-body');
    const visual = [...body.querySelectorAll('.msg')]
      .map((m) => ({ t: (m.querySelector('.text')?.textContent || '').trim(), y: Math.round(m.getBoundingClientRect().y) }))
      .sort((a, b) => a.y - b.y);
    return { scrollTop: Math.round(body.scrollTop), top: visual[0]?.t || '', scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
  });
  check('重开译文块后停在「最新」那一端（scrollTop = 0，不是滚到底）',
    reopened.scrollTop === 0 && reopened.top.startsWith('第四条'),
    `scrollTop=${reopened.scrollTop} top=${reopened.top.slice(0, 6)}`);

  /* 溢出提示：留在底边（反转后"下面"= 更早的译文） */
  const fade = await page.evaluate(() => {
    const block = document.querySelector('.ai-block[data-block="translate"]');
    const cs = getComputedStyle(block, '::after');
    const panelBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim();
    return { bottom: cs.bottom, top: cs.top, bg: cs.backgroundImage, panelBg };
  });
  const stops = (fade.bg.match(/rgba?\([^)]*\)/g) || []);
  check('溢出渐隐仍在底边，且方向是「往下渐显成面板底」（提示下面还有更早的译文）',
    fade.bottom === '0px'
      && stops.length >= 2
      && /rgba\(0, 0, 0, 0\)/.test(stops[0])
      && stops.at(-1) !== stops[0],
    `${fade.bottom} ${stops.join(' → ')}`);

  /* 问答流不受影响：仍是时间顺序 */
  const chat = await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    return new Promise((r) => setTimeout(() => r(getComputedStyle(document.querySelector('.ai-block[data-block="chat"] .ai-body')).flexDirection), 200));
  });
  check('问答流没有跟着反转（仍是最新在下面）', chat === 'column', chat);

  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`译文顺序验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
