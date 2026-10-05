/**
 * 缩放不能闪灰条。
 *
 *   BASE=http://127.0.0.1:8787 node test/zoom.mjs
 *
 * 背景：`.page.placeholder::after` 是一条灰色斜条纹。旧实现里 setScale / _renderVisible(true)
 * 每次都把所有页 _teardownPage() 掉，于是拖动缩放时那几条灰纹一直在闪（用户反馈）。
 * 现在改成双缓冲：旧位图先留着当预览，新的画好再换。
 *
 * 这里在**缩放过程中连续采样**，数「视口内有多少页处于 placeholder / 没有画布」。
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
await sleep(2200);

/** 开始连续采样：视口内的页里，有多少是 placeholder / 没有画布 */
const startWatch = () => page.evaluate(() => {
  window.__z = { samples: 0, greyFrames: 0, blankFrames: 0, maxGrey: 0, maxBlank: 0 };
  window.__zTimer = setInterval(() => {
    const vr = document.getElementById('viewer').getBoundingClientRect();
    let grey = 0;
    let blank = 0;
    for (const el of document.querySelectorAll('.page')) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= vr.top || r.top >= vr.bottom) continue;    // 不在视口里，不算
      if (el.classList.contains('placeholder')) grey++;
      if (!el.querySelector('canvas')) blank++;
    }
    const z = window.__z;
    z.samples++;
    if (grey) { z.greyFrames++; z.maxGrey = Math.max(z.maxGrey, grey); }
    if (blank) { z.blankFrames++; z.maxBlank = Math.max(z.maxBlank, blank); }
  }, 30);
});
const stopWatch = () => page.evaluate(() => {
  clearInterval(window.__zTimer);
  return window.__z;
});

/* ── 一、拖动缩放（模拟滑块连续 input） ── */
console.log('\n-- 拖动缩放');
await startWatch();
await page.evaluate(async () => {
  const v = window.__viewer;
  const base = v.scale;
  // 像拖滑块那样连续改比例：0.9→1.5 来回，每次隔一帧
  for (let i = 0; i <= 20; i++) {
    v.setScale(base * (0.9 + (0.6 * i) / 20));
    await new Promise((r) => setTimeout(r, 35));
  }
  for (let i = 20; i >= 0; i--) {
    v.setScale(base * (0.9 + (0.6 * i) / 20));
    await new Promise((r) => setTimeout(r, 35));
  }
});
const z1 = await stopWatch();
check('拖动缩放全程没有出现灰条（placeholder）', z1.greyFrames === 0,
  `${z1.samples} 次采样，灰条帧 ${z1.greyFrames}，最多 ${z1.maxGrey} 页`);
check('拖动缩放全程页面没有空白（画布一直在）', z1.blankFrames === 0,
  `空白帧 ${z1.blankFrames}，最多 ${z1.maxBlank} 页`);

await sleep(1200);
const afterDrag = await page.evaluate(() => {
  // 只数**视口内**的：离屏的页本来就没渲染过，是 placeholder 属于设计如此
  const vr = document.getElementById('viewer').getBoundingClientRect();
  let visibleGrey = 0;
  for (const el of document.querySelectorAll('.page.placeholder')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > vr.top && r.top < vr.bottom) visibleGrey++;
  }
  return {
    soft: document.querySelectorAll('canvas.soft-zoom').length,
    visibleGrey,
    offscreenGrey: document.querySelectorAll('.page.placeholder').length - visibleGrey,
    scale: window.__viewer.scale,
  };
});
check('手势停下后会重画成清晰版（没有残留的拉伸预览）', afterDrag.soft === 0, `soft-zoom 画布 ${afterDrag.soft} 个`);
check('停下后视口内没有 placeholder（离屏的属于正常）',
  afterDrag.visibleGrey === 0, `视口内 ${afterDrag.visibleGrey} 页，离屏 ${afterDrag.offscreenGrey} 页`);

/* ── 二、工具条按钮 / 键盘缩放 ── */
console.log('\n-- 按钮与快捷键缩放');
await startWatch();
/**
 * 2026-10：翻页与缩放整组从顶栏搬到了**底栏**，id 也随之改名
 * （`#zoomIn` → `#footZoomIn`，以此类推；用户口径：「底栏有的功能上面的一栏就不要了」）。
 * 这里改点底栏那几个按钮 —— 验的还是同一件事：点这些按钮不闪灰条、不出空白。
 */
for (const sel of ['#footZoomIn', '#footZoomIn', '#footZoomOut', '#footFitWidth', '#footZoomIn']) {
  // eslint-disable-next-line no-await-in-loop
  await page.click(sel);
  // eslint-disable-next-line no-await-in-loop
  await sleep(160);
}
const z2 = await stopWatch();
check('点缩放按钮 / 适应宽度都不闪灰条', z2.greyFrames === 0 && z2.blankFrames === 0,
  `灰条帧 ${z2.greyFrames}，空白帧 ${z2.blankFrames}`);

/* ── 三、拖分栏条（改阅读区宽度 → 重新适配/重画） ── */
console.log('\n-- 拖分栏条');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(600);
const sp = await page.evaluate(() => {
  const r = document.getElementById('splitRight').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await startWatch();
await page.mouse.move(sp.x, sp.y);
await page.mouse.down();
for (let i = 0; i < 12; i++) {
  // eslint-disable-next-line no-await-in-loop
  await page.mouse.move(sp.x + i * 12, sp.y);
  // eslint-disable-next-line no-await-in-loop
  await sleep(45);
}
await page.mouse.up();
await sleep(900);
const z3 = await stopWatch();
check('拖分栏条改变阅读区宽度时也不闪灰条', z3.greyFrames === 0,
  `${z3.samples} 次采样，灰条帧 ${z3.greyFrames}，最多 ${z3.maxGrey} 页`);
check('拖分栏条时画面也没空白', z3.blankFrames === 0, `空白帧 ${z3.blankFrames}`);

/* ── 四、连续滚轮缩放 ── */
console.log('\n-- 滚轮缩放');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(500);
await startWatch();
await page.mouse.move(700, 400);
for (let i = 0; i < 10; i++) {
  // eslint-disable-next-line no-await-in-loop
  await page.mouse.wheel({ deltaY: i % 2 ? 120 : -120 });
  // eslint-disable-next-line no-await-in-loop
  await sleep(60);
}
const z4 = await stopWatch();
check('滚轮连续缩放也不闪灰条', z4.greyFrames === 0 && z4.blankFrames === 0,
  `灰条帧 ${z4.greyFrames}，空白帧 ${z4.blankFrames}`);

/* ── 五、缩放后画面仍然正确（别为了不闪把渲染搞坏了） ── */
await sleep(1400);
const sharp = await page.evaluate(() => {
  const v = window.__viewer;
  const canvas = document.querySelector('.page canvas');
  const pageEl = document.querySelector('.page');
  return {
    canvases: document.querySelectorAll('.page canvas').length,
    cssW: canvas ? Math.round(parseFloat(canvas.style.width)) : 0,
    pageW: pageEl ? Math.round(pageEl.getBoundingClientRect().width) : 0,
    containerW: document.getElementById('viewer').clientWidth,
  };
});
check('缩放结束后每页都有画布', sharp.canvases >= 1, `${sharp.canvases} 个`);
check('画布宽度和页面宽度一致（重画后没有拉伸错位）',
  Math.abs(sharp.cssW - sharp.pageW) <= 2, `画布 ${sharp.cssW} / 页面 ${sharp.pageW}`);
check('页面宽度仍然铺满阅读区（fitWidth 后）',
  Math.abs(sharp.pageW - (sharp.containerW - 32)) <= 3, `页宽 ${sharp.pageW} / 阅读区 ${sharp.containerW}`);

/* ── 六、缩放之后仍然能选文字 ── */
/**
 * 回归：双缓冲换帧时曾经给新画布设 z-index:2 想压住旧画布，
 * 但文本层没有 z-index（靠 DOM 顺序盖在画布上），结果画布盖住了文本层 ——
 * 鼠标点不到文字，选取直接失效。改成靠 DOM 顺序插在旧画布后面。
 */
console.log('\n-- 缩放后选文字');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(1400);
const probe = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const pool = [...document.querySelectorAll('.page .textLayer span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5)
    .filter((s) => { const r = s.getBoundingClientRect(); return r.top > vr.top + 20 && r.bottom < vr.bottom - 20; });
  const canvas = document.querySelector('.page canvas');
  const s0 = pool[0]?.getBoundingClientRect();
  const hit = s0 ? document.elementFromPoint(s0.left + 3, s0.top + s0.height / 2) : null;
  return {
    spans: pool.length,
    hitsText: !!(hit && hit.closest && hit.closest('.textLayer')),
    hitWhat: hit ? `${hit.tagName}.${hit.className || ''}` : '(无)',
    canvasZ: canvas ? getComputedStyle(canvas).zIndex : '(无画布)',
    first: s0 ? { x: Math.round(s0.left + 3), y: Math.round(s0.top + s0.height / 2) } : null,
    last: pool[3] ? { x: Math.round(pool[3].getBoundingClientRect().right - 3), y: Math.round(pool[3].getBoundingClientRect().top + pool[3].getBoundingClientRect().height / 2) } : null,
  };
});
check('缩放后文本层还在', probe.spans > 3, `${probe.spans} 个可见 span`);
check('鼠标能点到文本层（画布没有盖在上面）', probe.hitsText, `命中 ${probe.hitWhat}`);
check('画布没有残留 z-index', probe.canvasZ === 'auto' || probe.canvasZ === '0', probe.canvasZ);

if (probe.first && probe.last) {
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.mouse.move(probe.first.x, probe.first.y);
  await page.mouse.down();
  await page.mouse.move(probe.last.x, probe.last.y, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  const sel = await page.evaluate(() => ({
    text: (window.getSelection()?.toString() || '').trim(),
    bubble: !document.getElementById('bubble').classList.contains('hidden'),
    state: window.__state.selection?.cleanText || '',
  }));
  check('缩放后用鼠标能真的选出一段文字', sel.text.length > 3, JSON.stringify(sel.text.slice(0, 30)));
  check('选中后气泡正常弹出', sel.bubble && !!sel.state, sel.state.slice(0, 24));
}

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'zoom.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
