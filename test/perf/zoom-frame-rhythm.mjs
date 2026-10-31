import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'artifacts', 'perf-frame-rhythm');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
// 8974 落在 Windows 的保留端口段里（netsh int ipv4 show excludedportrange 能看到），别用
const PORT = Number(process.env.PORT || 8977);
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
if (!up) { server.kill(); throw new Error('server 没起来'); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900', '--enable-pinch'],
  defaultViewport: { width: 1400, height: 900, hasTouch: true, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate(() => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => /multipage/i.test(x.textContent)) || document.querySelector('#fileList li');
  li.click();
});
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2500);

await page.evaluate(() => {
  window.__f = [];
  let last = performance.now();
  const tick = (t) => { window.__f.push(+(t - last).toFixed(1)); last = t; window.__raf = requestAnimationFrame(tick); };
  window.__raf = requestAnimationFrame(tick);
  window.__mark = (s) => window.__f.push(`|${s}|`);
});

const pinch = async (d0, d1, steps, gap) => {
  const cx = 700; const cy = 450;
  const mk = (d) => ([{ x: cx - d, y: cy, id: 1, force: 1 }, { x: cx + d, y: cy, id: 2, force: 1 }]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: mk(d0) });
  for (let i = 1; i <= steps; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: mk(d0 + ((d1 - d0) * i) / steps) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(gap);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

const summarize = (frames) => {
  const nums = frames.filter((x) => typeof x === 'number');
  if (!nums.length) return { n: 0 };
  const s = [...nums].sort((a, b) => a - b);
  return {
    n: nums.length,
    avg: +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1),
    p50: s[Math.floor(nums.length * 0.5)],
    p95: s[Math.floor(nums.length * 0.95)],
    max: s[s.length - 1],
    over25: nums.filter((x) => x > 25).length,
    over50: nums.filter((x) => x > 50).length,
  };
};

const startSampler = () => page.evaluate(() => {
  window.__f = [];
  let last = performance.now();
  const tick = (t) => { window.__f.push(+(t - last).toFixed(1)); last = t; window.__raf = requestAnimationFrame(tick); };
  window.__raf = requestAnimationFrame(tick);
  window.__mark = (s) => window.__f.push(`|${s}|`);
});

const MODES = [
  { name: 'A 正常（每帧写 transform）', patch: false },
  { name: 'B 对照：把 transform 写操作去掉', patch: true },
];

for (const m of MODES) {
  for (let run = 0; run < 2; run++) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fileList li', { timeout: 20000 });
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('#fileList li')].find((x) => /multipage/i.test(x.textContent)) || document.querySelector('#fileList li');
      li.click();
    });
    await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
    // eslint-disable-next-line no-await-in-loop
    await sleep(2500);
    // eslint-disable-next-line no-await-in-loop
    await startSampler();
    if (m.patch) {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate(() => {
        const v = window.__viewer;
        v._writePreviewTransform = () => {};   // 不写 transform：手势照旧判定、照旧 commit
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => window.__viewer.fitWidth());
    // eslint-disable-next-line no-await-in-loop
    await sleep(1800);
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => { window.__f = []; });
    // eslint-disable-next-line no-await-in-loop
    await pinch(60, 130, 24, 16);
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => window.__mark('TOUCH_END'));
    // eslint-disable-next-line no-await-in-loop
    await sleep(1500);
    // eslint-disable-next-line no-await-in-loop
    const f = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__f; });
    const cut = f.indexOf('|TOUCH_END|');
    const during = f.slice(0, cut === -1 ? f.length : cut);
    const after = f.slice(cut === -1 ? f.length : cut + 1);
    console.log(`\n=== ${m.name} · run ${run} ===`);
    console.log(`  捏合过程  ${JSON.stringify(summarize(during))}`);
    console.log(`  松手之后  ${JSON.stringify(summarize(after))}`);
  }
}

await browser.close();
server.kill();
process.exit(0);
