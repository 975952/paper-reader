/**
 * 诊断：1) 超高倍放大时 canvas 是否超出浏览器上限被降采样（=看起来糊）
 *        2) 文本层被 scaleX 压缩的 span，点击命中是否偏移字符
 *   node test/diag3.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8787';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/?open=attention-is-all-you-need.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await sleep(2500);

console.log('═══ 1) 不同缩放级别下的 canvas ═══');
console.log('  浏览器 canvas 上限（面积）:', await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 65535; c.height = 65535;
  return { maxW: c.width, maxH: c.height, probeStillValid: c.width === 65535 };
}));

for (const target of [1.0, 2.0, 3.0, 4.5, 6.0]) {
  await page.evaluate((s) => {
    const v = document.getElementById('viewer');
    // 直接用内部 API 设缩放
    window.__viewer?.setScale?.(s);
  }, target);
  await sleep(1800);
  const d = await page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="1"]');
    const c = pg?.querySelector('canvas');
    if (!c) return null;
    const cssW = c.getBoundingClientRect().width;
    return {
      zoom: document.getElementById('zoomLabel').textContent,
      backingW: c.width, backingH: c.height,
      cssW: Math.round(cssW), cssH: Math.round(c.getBoundingClientRect().height),
      density: +(c.width / cssW).toFixed(3),
      megapixels: +((c.width * c.height) / 1e6).toFixed(1),
    };
  });
  console.log(`  目标 ${target}× →`, JSON.stringify(d));
}

console.log('\n═══ 2) 文本层点击命中精度（scaleX 压缩的 span）═══');
await page.click('#fitWidth');
await sleep(1500);
const hit = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 12 && s.getBoundingClientRect().width > 60);
  const out = [];
  for (const s of spans.slice(0, 6)) {
    const r = s.getBoundingClientRect();
    const st = getComputedStyle(s);
    const txt = s.textContent;
    // 在 span 渲染宽度的 25% / 50% / 75% 处取字符位置
    const samples = [0.25, 0.5, 0.75].map((f) => {
      const x = r.left + r.width * f;
      const y = r.top + r.height / 2;
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      let idx = -1;
      if (range && range.startContainer.nodeType === 3) {
        idx = range.startOffset;
      }
      const expected = Math.round(txt.length * f);
      return { f, idx, expected, delta: idx - expected };
    });
    out.push({ text: txt.slice(0, 34), len: txt.length, scaleX: st.transform, samples });
  }
  return out;
});
for (const h of hit) {
  console.log(`  "${h.text}…" (${h.len} 字符)`);
  for (const s of h.samples) {
    console.log(`     ${Math.round(s.f * 100)}% 处 → 命中字符 ${s.idx}，期望 ${s.expected}，偏差 ${s.delta}`);
  }
}

console.log('\n═══ 3) 用鼠标真实拖选一个词，看选到什么 ═══');
const dragSel = await page.evaluate(() => {
  const s = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
    .find((n) => (n.textContent || '').trim().length > 20 && n.getBoundingClientRect().width > 100);
  const r = s.getBoundingClientRect();
  return { text: s.textContent, left: r.left, top: r.top, w: r.width, h: r.height };
});
await page.mouse.move(dragSel.left + 4, dragSel.top + dragSel.h / 2);
await page.mouse.down();
await page.mouse.move(dragSel.left + dragSel.w * 0.35, dragSel.top + dragSel.h / 2, { steps: 10 });
await page.mouse.up();
await sleep(400);
const got = await page.evaluate(() => window.getSelection().toString());
console.log('  完整 span 文字  :', JSON.stringify(dragSel.text));
console.log('  拖到 35% 处选中 :', JSON.stringify(got));
console.log(`  期望约前 35%    : ${Math.round(dragSel.text.length * 0.35)} 字符，实际 ${got.length} 字符`);

await browser.close();
