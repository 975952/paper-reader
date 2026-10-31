import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'artifacts', 'perf-touch');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8973);
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
  executablePath: CHROME, headless: 'shell',
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
const uninstallApp = () => page.evaluate(() => {
  const v = window.__viewer;
  const tz = v._touchZoomHandlers;
  if (tz) {
    v.container.removeEventListener('touchstart', tz.onStart);
    v.container.removeEventListener('touchmove', tz.onMove);
    v.container.removeEventListener('touchend', tz.onEnd);
    v.container.removeEventListener('touchcancel', tz.onEnd);
    v._touchZoomHandlers = null;
  }
});

/** 平行下滑 200px（间距不变） */
const panFrames = (t) => { const dy = 200 * t; return [{ x: 640, y: 220 + dy, id: 1, force: 1 }, { x: 760, y: 220 + dy, id: 2, force: 1 }]; };
/** 对称张开（中点不动） */
const pinchFrames = (t) => { const d = 60 + 60 * t; return [{ x: 700 - d, y: 450, id: 1, force: 1 }, { x: 700 + d, y: 450, id: 2, force: 1 }]; };
/** 先平移再张开 */
const bothFrames = (t) => {
  const pan = Math.min(1, t / 0.5);
  const zoom = Math.max(0, (t - 0.5) / 0.5);
  const dy = 120 * pan;
  const d = 60 + 60 * zoom;
  return [{ x: 700 - d, y: 300 + dy, id: 1, force: 1 }, { x: 700 + d, y: 300 + dy, id: 2, force: 1 }];
};
/** 只有 3px 抖动 */
const jitterFrames = (t) => [{ x: 640, y: 300 + 3 * t, id: 1, force: 1 }, { x: 760, y: 300 + 3 * t, id: 2, force: 1 }];

const run = async (frames, steps = 20, gap = 16) => {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: frames(0) });
  for (let i = 1; i <= steps; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: frames(i / steps) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(gap);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
};
const state = () => page.evaluate(() => ({
  scale: +window.__viewer.scale.toFixed(3),
  scroll: Math.round(document.getElementById('viewer').scrollTop),
  vv: visualViewport.scale,
}));
const resetView = async () => {
  await page.evaluate(() => { window.__viewer.setScale(window.__viewer._computeFitScale(), { keepCenter: false }); document.getElementById('viewer').scrollTop = 700; });
  await sleep(1000);
};

/* ══════════ ① 浏览器会不会抢两指手势 ══════════ */
console.log('\n══ ① 浏览器对两指手势的处理（touch-action: pan-x pan-y）══');
const installDumb = (mode) => page.evaluate((m) => {
  const el = window.__viewer.container;
  if (window.__inst) { for (const [n, f] of window.__inst) el.removeEventListener(n, f); window.__inst = null; }
  window.__t = { start: 0, move: 0, end: 0, cancel: 0 };
  window.__sc0 = el.scrollTop;
  const inst = [];
  const add = (n, f, o) => { el.addEventListener(n, f, o); inst.push([n, f]); };
  add('touchstart', () => { window.__t.start++; }, { passive: true });
  add('touchend', () => { window.__t.end++; }, { passive: true });
  add('touchcancel', () => { window.__t.cancel++; }, { passive: true });
  if (m === 'passive') add('touchmove', () => { window.__t.move++; }, { passive: true });
  if (m === 'nonpassive') add('touchmove', () => { window.__t.move++; }, { passive: false });
  if (m === 'prevent') add('touchmove', (e) => { window.__t.move++; e.preventDefault(); }, { passive: false });
  if (m === 'scroll') add('touchmove', (e) => { window.__t.move++; const y = (e.touches[0].clientY + e.touches[1].clientY) / 2; el.scrollTop = el.scrollTop + (window.__lastY ? window.__lastY - y : 0); window.__lastY = y; }, { passive: true });
  window.__inst = inst;
}, mode);
const readDumb = () => page.evaluate(() => ({ ...window.__t, scrollDelta: Math.round(document.getElementById('viewer').scrollTop - window.__sc0) }));

for (const mode of ['none', 'passive', 'nonpassive', 'prevent', 'scroll']) {
  await openDoc();
  await uninstallApp();
  await page.evaluate(() => { window.__viewer.setScale(window.__viewer._computeFitScale(), { keepCenter: false }); document.getElementById('viewer').scrollTop = 700; });
  // eslint-disable-next-line no-await-in-loop
  await sleep(800);
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate(() => { window.__lastY = 0; });
  // eslint-disable-next-line no-await-in-loop
  await installDumb(mode);
  // eslint-disable-next-line no-await-in-loop
  await run(panFrames);
  // eslint-disable-next-line no-await-in-loop
  const r = await readDumb();
  const label = { none: '不装 touchmove 监听', passive: 'passive 监听', nonpassive: '非 passive 监听（不 prevent）', prevent: '非 passive + 每次都 preventDefault', scroll: 'passive 监听 + 每帧写 scrollTop' }[mode];
  console.log(`  ${label.padEnd(32)} start=${r.start} move=${r.move} end=${r.end} cancel=${r.cancel} 滚动=${r.scrollDelta}px`);
}
console.log('  → 结论：不写 scroll 就一切正常（连 preventDefault 都不需要）；一写 scrollTop，序列立刻断掉。');

console.log('\n══ ② 应用判定（用应用自己的处理）══');
const CASES = [
  { name: '两指平行下滑（间距不变）', frames: panFrames, want: '只滚不缩' },
  { name: '两指 3px 抖动', frames: jitterFrames, want: '纹丝不动' },
  { name: '对称张开 2 倍', frames: pinchFrames, want: '只缩（滚动会因为锚点补偿而变，正常）' },
  { name: '先平移后张开', frames: bothFrames, want: '先滚后缩' },
];
for (const c of CASES) {
  await openDoc();                       // 重载会重建应用自己的触摸处理
  await resetView();
  const before = await state();
  // eslint-disable-next-line no-await-in-loop
  await run(c.frames, 24);
  // eslint-disable-next-line no-await-in-loop
  await sleep(1200);
  const after = await state();
  const dz = after.scale / before.scale;
  console.log(`  ${c.name.padEnd(24)} scale ${before.scale} → ${after.scale}（×${dz.toFixed(3)}）  scroll ${before.scroll} → ${after.scroll}  vv=${after.vv}`);
  console.log(`    ${' '.repeat(22)}期望：${c.want}`);
}

await browser.close();
server.kill();
console.log('\n完成。');
process.exit(0);
