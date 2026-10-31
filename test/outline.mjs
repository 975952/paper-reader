/**
 * 目录跳转：点一项应该让那个标题顶在最上面，而不是只跳到那一页的页顶。
 *   BASE=http://127.0.0.1:8787 node test/outline.mjs
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2000);

const outline = await page.evaluate(async () => {
  const items = await window.__viewer.getOutline();
  return items.map((it) => ({ title: it.title, page: it.page, top: it.top }));
});
check('这篇 PDF 有书签目录', outline.length > 0, `${outline.length} 项`);
if (!outline.length) {
  // 没有目录就没法继续往下验。这条提前退出也要按结果给退出码，
  // 否则「大纲为空」时报了 ❌ 却仍然 exit(0)，套件就成了假绿。
  await browser.close();
  const failed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${failed}/${results.length} 通过`);
  await sleep(200);
  process.exit(failed === results.length ? 0 : 1);
}
check('目录项里解析出了目标 Y 坐标（这是能顶到标题的前提）',
  outline.some((it) => it.top !== null), `${outline.filter((it) => it.top !== null).length}/${outline.length} 项有 Y`);

// 找一个「不在页顶」的条目 —— 只有这种才验得出「顶到标题」而不是「顶到页顶」
const mid = outline.find((it) => it.top !== null);
check('找到可验证的条目', !!mid, mid ? `${mid.title} → p.${mid.page} top=${mid.top}` : '');

if (mid) {
  const target = await page.evaluate((t) => {
    const items = [...document.querySelectorAll('#outlineList li')];
    const li = items.find((x) => x.textContent.trim() === t);
    if (!li) return null;
    li.scrollIntoView({ block: 'nearest' });
    li.click();
    return true;
  }, mid.title);
  check('目录里有这一项，能点到', target === true);
  await sleep(1800);   // 等平滑滚动到位

  // 点完之后：视口顶部附近应该就是这个标题（而不是页面最上沿的页眉/页码）
  const landed = await page.evaluate((title) => {
    const v = document.getElementById('viewer');
    const vr = v.getBoundingClientRect();
    // 取页面上所有可见的文本 span，找最靠上的那批
    const spans = [...document.querySelectorAll('.page .textLayer span:not(.markedContent)')]
      .map((s) => ({ t: s.textContent.trim(), r: s.getBoundingClientRect() }))
      .filter((x) => x.t && x.r.width > 0 && x.r.bottom > vr.top && x.r.top < vr.bottom);
    spans.sort((a, b) => a.r.top - b.r.top);
    const key = title.replace(/^\d+(\.\d+)*\s*/, '').slice(0, 12).toLowerCase();
    const atTop = spans.filter((x) => x.r.top < vr.top + 120);
    return {
      topText: atTop.slice(0, 8).map((x) => x.t).join(' | '),
      hitAtTop: atTop.some((x) => x.t.toLowerCase().includes(key)),
      firstTop: spans[0] ? Math.round(spans[0].r.top - vr.top) : null,
    };
  }, mid.title);
  check('跳转后该标题出现在视口顶部（不是停在页面中间）', landed.hitAtTop,
    `顶部文本: ${landed.topText.slice(0, 70)}`);
  check('标题基本贴着容器上沿（偏移 < 120px）',
    landed.firstTop !== null && landed.firstTop >= -8 && landed.firstTop < 120,
    `首个可见文本距顶 ${landed.firstTop}px`);
}

/* 对照：同一个条目，旧的 goToPage（只到页顶）会落在哪 —— 说明这个改动确实有意义 */
if (mid) {
  const byPage = await page.evaluate(async (m) => {
    await window.__viewer.goToPage(m.page, { smooth: false });
    await new Promise((r) => setTimeout(r, 700));
    const v = document.getElementById('viewer');
    const vr = v.getBoundingClientRect();
    const spans = [...document.querySelectorAll('.page .textLayer span:not(.markedContent)')]
      .map((s) => ({ t: s.textContent.trim(), r: s.getBoundingClientRect() }))
      .filter((x) => x.t && x.r.width > 0 && x.r.bottom > vr.top && x.r.top < vr.bottom);
    spans.sort((a, b) => a.r.top - b.r.top);
    const key = m.title.replace(/^\d+(\.\d+)*\s*/, '').slice(0, 12).toLowerCase();
    const hitIdx = spans.findIndex((x) => x.t.toLowerCase().includes(key));
    return {
      topText: spans.slice(0, 6).map((x) => x.t).join(' | '),
      hitOffset: hitIdx >= 0 ? Math.round(spans[hitIdx].r.top - vr.top) : null,
    };
  }, mid);
  console.log(`  （对照）只滚到页顶时，顶部是：${byPage.topText.slice(0, 60)}`);
  check('对照：只滚到页顶时标题并不在顶部（说明这次改动真的改变了结果）',
    byPage.hitOffset === null || byPage.hitOffset > 40,
    byPage.hitOffset === null ? '页顶内容里根本看不到该标题' : `标题距顶 ${byPage.hitOffset}px`);
}

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'outline.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
