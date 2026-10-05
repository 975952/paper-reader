/**
 * 诊断：1) 放大后 canvas 的实际像素密度  2) 选区文字 vs 实际送出去的文字
 *   node test/diag2.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:8787';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 2 },   // 模拟高 DPI 屏
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

let captured = null;
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    captured = JSON.parse(req.postData() || '{}');
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\ndata: [DONE]\n\n`;
    return req.respond({ status: 200, contentType: 'text/event-stream', body: sse });
  }
  return req.continue();
});

await page.goto(`${BASE}/?open=attention-is-all-you-need.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
await sleep(2500);

const measure = () => page.evaluate(() => {
  const pg = document.querySelector('.page[data-page="1"]');
  const c = pg?.querySelector('canvas');
  const v = document.getElementById('viewer');
  return {
    dpr: window.devicePixelRatio,
    scale: Number(v.style.getPropertyValue('--x')) || null,
    pageCssW: Math.round(pg?.getBoundingClientRect().width || 0),
    canvasBackingW: c?.width || 0,
    canvasBackingH: c?.height || 0,
    canvasCssW: Math.round(c?.getBoundingClientRect().width || 0),
    canvasCssH: Math.round(c?.getBoundingClientRect().height || 0),
    zoomLabel: document.getElementById('zoomLabel').textContent,
    sharpness: c ? +(c.width / c.getBoundingClientRect().width).toFixed(3) : 0,
  };
});

console.log('═══ 1) 放大清晰度 ═══');
console.log('  fit-width :', JSON.stringify(await measure()));

for (let i = 0; i < 5; i++) { await page.click('#zoomIn'); await sleep(140); }
await sleep(3000);
const z1 = await measure();
console.log('  +5 级放大 :', JSON.stringify(z1));
console.log(`  → 期望像素密度 ≥ dpr(${z1.dpr})，实际 ${z1.sharpness}  ${z1.sharpness >= z1.dpr * 0.98 ? '✅ 清晰' : '❌ 被拉伸变糊'}`);

// 缩放过程中测量
await page.click('#zoomIn'); await sleep(120);
const mid = await measure();
console.log('  刚点完放大(未等待):', JSON.stringify(mid));

console.log('\n═══ 2) 选区 vs 送去翻译的文字 ═══');
await page.click('#fitWidth'); await sleep(1200);
const sel = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.page [class="textLayer"] span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5);
  const a = spans[2], b = spans[3];
  const range = document.createRange();
  range.setStart(a.firstChild, 0);
  range.setEnd(b.firstChild, b.textContent.length);
  const s = window.getSelection();
  s.removeAllRanges(); s.addRange(range);
  document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { raw: s.toString(), first: a.textContent, second: b.textContent };
});
await sleep(300);
await page.click('#bubble button[data-act="translate"]');
await sleep(1500);

const sent = captured?.messages?.[1]?.content || '';
const m = /【需要翻译的片段】\n([\s\S]*)$/.exec(sent);
const sentText = m ? m[1] : '(未捕获)';
const clean = (t) => t.replace(/\r\n?/g, '\n')
  .replace(/[ \t]*\n[ \t]*/g, '\n')
  .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
  .replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n\n')
  .replace(/[ \t]{2,}/g, ' ').trim();
const expected = clean(sel.raw);

console.log('  浏览器选区 toString() :', JSON.stringify(sel.raw));
console.log('  期望送出（cleanText） :', JSON.stringify(expected));
console.log('  实际送出              :', JSON.stringify(sentText));
console.log(`  → ${expected === sentText ? '✅ 完全一致' : '❌ 不一致（偏差 ' + (sentText.length - expected.length) + ' 字符）'}`);
if (expected !== sentText) {
  let i = 0;
  while (i < Math.min(expected.length, sentText.length) && expected[i] === sentText[i]) i++;
  console.log(`     首个不同位置 ${i}: 期望 ${JSON.stringify(expected.slice(i, i + 25))} / 实际 ${JSON.stringify(sentText.slice(i, i + 25))}`);
}

console.log('\n═══ 3) 界面上的选中高亮 vs 送出的文字 ═══');
const vis = await page.evaluate(() => {
  const r = window.getSelection()?.getRangeAt(0);
  return r ? r.toString().slice(0, 80) : '';
});
console.log('  当前页面高亮的文字    :', JSON.stringify(vis));

console.log('\n异常:', errors.length ? errors.join('\n') : '无');
await browser.close();
