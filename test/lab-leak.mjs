/**
 * 受控实验：给**一个** span 加不同大小的 padding，
 * 看 Range.getClientRects() 里属于它的矩形会不会跟着变大（会不会污染画出来的方块）。
 *
 *   BASE=http://127.0.0.1:8787 node test/lab-leak.mjs
 *
 * ⚠️ 这不是验收套件（没有断言、不改文件），是 `pdfview.js` 里
 * `_tileTextHitBoxes()` / `HIT_PAD_MAX` 那条**硬约束**的证据来源：
 *   · 横向 padding 一加，跨 span 的选区内该 span 会被浏览器整盒返回
 *     （300/953 边框盒，而不是 52/434 行盒）→ 选中方块横贯整页；
 *   · 纵向 padding 在 158px 这个量级上也会开始被整盒返回。
 * 改文本层命中逻辑之前请先跑一遍，别凭感觉调 padding。
 * 需要先起服务：`PRT_PAPERS_DIR=... node server.js`（见 AGENTS.md 的测试说明）。
 */
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json());
const list = (papers.papers || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
const target = list.find((p) => /attention-arxiv/.test(p.name)) || list[0];
await fetch(`${BASE}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }) });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1500, height: 950 } });
const page = await browser.newPage();
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => { const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li'); li.click(); }, target.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 60000 });
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(2600);

const res = await page.evaluate(() => {
  const pageEl = document.querySelector('.page[data-page="1"]');
  const pr = pageEl.getBoundingClientRect();
  const spans = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')].filter((s) => (s.textContent || '').trim().length > 8);
  const pick = spans[3];   // 随便取第 4 个有文字的 span
  const res = [];
  const measure = () => {
    // ① 单独 selectNodeContents
    const solo = document.createRange();
    solo.selectNodeContents(pick);
    const a = solo.getBoundingClientRect();
    // ② 整页范围里属于它的矩形：取与 solo 矩形中心最接近的那个
    const all = document.createRange();
    all.setStart(spans[0].firstChild, 0);
    all.setEnd(spans[spans.length - 1].firstChild, spans[spans.length - 1].textContent.length);
    const rects = [...all.getClientRects()].map((r) => ({ x: Math.round(r.left - pr.left), y: Math.round(r.top - pr.top), w: Math.round(r.width), h: Math.round(r.height) }));
    const cx = (a.left + a.right) / 2 - pr.left;
    const cy = (a.top + a.bottom) / 2 - pr.top;
    let best = null;
    for (const r of rects) {
      const d = Math.abs(r.x + r.w / 2 - cx) + Math.abs(r.y + r.h / 2 - cy);
      if (!best || d < best.d) best = { d, r };
    }
    return {
      solo: { x: Math.round(a.left - pr.left), y: Math.round(a.top - pr.top), w: Math.round(a.width), h: Math.round(a.height) },
      inWhole: best ? best.r : null,
    };
  };
  for (const pad of [0, 40, 80, 90, 100, 110, 120, 130, 140, 150, 200]) {
    pick.style.padding = `${pad}px ${pad * 2}px`;
    pick.style.left = '0px';   // 让盒子左边界固定，便于比较
    const m = measure();
    const boxH = Math.round(pick.getBoundingClientRect().height);
    const boxW = Math.round(pick.getBoundingClientRect().width);
    res.push({ pad, boxH, boxW, soloH: m.solo.h, soloW: m.solo.w, wholeH: m.inWhole?.h, wholeW: m.inWhole?.w, wholeX: m.inWhole?.x });
  }
  // 只加纵向 / 只加横向，看是哪一维触发「矩形=盒子」
  for (const [label, css] of [['仅纵向 120', '120px 0px'], ['仅纵向 200', '200px 0px'], ['仅横向 300', '0px 300px'], ['仅横向 500', '0px 500px']]) {
    pick.style.padding = css;
    pick.style.left = '0px';
    const m = measure();
    res.push({ pad: label, boxH: Math.round(pick.getBoundingClientRect().height), boxW: Math.round(pick.getBoundingClientRect().width), soloH: m.solo.h, soloW: m.solo.w, wholeH: m.inWhole?.h, wholeW: m.inWhole?.w, wholeX: m.inWhole?.x });
  }
  pick.style.padding = ''; pick.style.left = '';
  return { text: (pick.textContent || '').slice(0, 30), role: pick.getAttribute('role'), res };
});
console.log(`span「${res.text}」 role=${res.role}`);
console.log('pad | 盒高 | 盒宽 | 单独Range h/w | 整页Range里属于它的 h/w/x');
for (const r of res.res) console.log(`${String(r.pad).padStart(9)} | ${String(r.boxH).padStart(4)} | ${String(r.boxW).padStart(4)} | ${String(r.soloH).padStart(5)}/${String(r.soloW).padStart(5)} | ${String(r.wholeH).padStart(5)}/${String(r.wholeW).padStart(5)}  x=${r.wholeX}`);
await browser.close();
