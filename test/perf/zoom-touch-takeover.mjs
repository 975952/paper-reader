/**
 * 触摸屏捏合「谁拿手势」对照实验（调研工具，不是断言套件）。
 *
 *   node test/perf/zoom-touch-takeover.mjs
 *
 * 背景：用户反馈「触摸屏缩放不丝滑」。实测发现触摸屏两指捏合在 Chromium 里
 * **不产生** `wheel + ctrlKey`（那是触摸板的路径），而是被浏览器当成**整页 Page Scale 缩放**：
 * `visualViewport.scale` 从 1 跳到 4，JS 一次 zoomAt 都收不到。
 *
 * 本脚本把 5 种「拿回手势」的写法放在同一台机器上跑一遍，回答两个问题：
 *   ① 哪种写法能挡住浏览器原生整页缩放？
 *   ② 挡住之后，单指拖动还能不能是原生滚动？
 *
 * 结论（2026-10-08 实测）：
 *   auto + passive            → 整页缩放 1→4（就是用户看到的那个 bug）
 *   auto + preventDefault     → 不整页缩放，单指滚动正常
 *   pan-x pan-y + passive     → 不整页缩放，单指滚动正常，touchmove 照旧送达 ✅
 *   pan-x pan-y + preventDef  → 同上（产品用的就是这条：CSS 兜底 + 事件兜底）
 *   none + preventDefault     → 不整页缩放，但单指滚动也没了 ❌
 * 所以 style.css 用 `html { touch-action: pan-x pan-y }`，
 * pdfview.js 的 _bindTouchZoom() 再叠一层非 passive 的 preventDefault。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'artifacts', 'perf-takeover');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8971);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
for (const f of ['cn-sample.pdf', 'multipage-sample.pdf', 'image-sample.pdf']) {
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', f), path.join(PAPERS, f));
}
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0' },
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(400); up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false); }
if (!up) { server.kill(); throw new Error('server 没起来（端口被占？换 PORT=… 再试）'); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  // --enable-pinch 是必须的：不加它 Chromium 不会走原生捏合那条路，实验就测不到东西。
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900', '--enable-pinch'],
  defaultViewport: { width: 1400, height: 900, hasTouch: true, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const openDoc = async () => {
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fileList li', { timeout: 20000 });
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#fileList li')].find((x) => /multipage/i.test(x.textContent)) || document.querySelector('#fileList li');
    li.click();
  });
  await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
  await sleep(2200);
};
await openDoc();

const install = (variant) => page.evaluate((v) => {
  const viewer = document.getElementById('viewer');
  window.__t = { start: 0, move: 0, end: 0, cancel: 0, prevented: 0, pinchSeen: 0, maxTouches: 0 };
  viewer.style.touchAction = v.touchAction;
  const opts = { passive: !v.nonPassive };
  viewer.addEventListener('touchstart', (e) => {
    window.__t.start++;
    window.__t.maxTouches = Math.max(window.__t.maxTouches, e.touches.length);
    if (v.nonPassive && e.touches.length >= 2) { e.preventDefault(); window.__t.prevented++; }
  }, opts);
  viewer.addEventListener('touchmove', (e) => {
    window.__t.move++;
    window.__t.maxTouches = Math.max(window.__t.maxTouches, e.touches.length);
    if (e.touches.length >= 2) {
      window.__t.pinchSeen++;
      if (v.nonPassive) { e.preventDefault(); window.__t.prevented++; }
    }
  }, opts);
  viewer.addEventListener('touchend', () => { window.__t.end++; }, { passive: true });
  viewer.addEventListener('touchcancel', () => { window.__t.cancel++; }, { passive: true });
  window.__vv0 = visualViewport ? visualViewport.scale : 1;
  window.__scroll0 = viewer.scrollTop;
}, variant);

const read = () => page.evaluate(() => ({
  vv0: window.__vv0,
  vv1: visualViewport ? visualViewport.scale : 1,
  t: window.__t,
  scrollDelta: Math.round(document.getElementById('viewer').scrollTop - window.__scroll0),
}));

const twoFingerPinch = async () => {
  const cx = 700; const cy = 450;
  const mk = (d) => ([
    { x: cx - d, y: cy, radiusX: 12, radiusY: 12, force: 1, id: 1 },
    { x: cx + d, y: cy, radiusX: 12, radiusY: 12, force: 1, id: 2 },
  ]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: mk(60) });
  for (let i = 0; i <= 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: mk(60 + i * 6) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
};

const oneFingerDrag = async () => {
  const mk = (y) => ([{ x: 700, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: mk(700) });
  for (let i = 0; i <= 16; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: mk(700 - i * 10) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
};

const CASES = [
  { name: '1 auto + passive（修复前）', touchAction: 'auto', nonPassive: false },
  { name: '2 auto + preventDefault', touchAction: 'auto', nonPassive: true },
  { name: '3 pan-x pan-y + passive', touchAction: 'pan-x pan-y', nonPassive: false },
  { name: '4 pan-x pan-y + preventDefault（修复后）', touchAction: 'pan-x pan-y', nonPassive: true },
  { name: '5 none + preventDefault', touchAction: 'none', nonPassive: true },
];

for (const c of CASES) {
  await openDoc();
  await install(c);
  await twoFingerPinch();
  const pinch = await read();
  await oneFingerDrag();
  const drag = await read();
  const wholePageZoomed = pinch.vv1 !== pinch.vv0;
  console.log(`\n=== ${c.name} ===`);
  console.log(`  两指捏合: vvScale ${pinch.vv0} → ${pinch.vv1}${wholePageZoomed ? '  ← 整页被缩放了 ❌' : '  ← 没有整页缩放 ✅'}`);
  console.log(`            touch 事件 ${JSON.stringify(pinch.t)}`);
  console.log(`  单指拖动: scrollTop 位移 ${drag.scrollDelta}px${drag.scrollDelta > 40 ? '（原生滚动正常 ✅）' : '（原生滚动没了 ❌）'}`);
}

await browser.close();
server.kill();
console.log('\n完成。');
process.exit(0);
