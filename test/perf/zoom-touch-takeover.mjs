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
