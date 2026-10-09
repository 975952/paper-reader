/**
 * 用**真实论文**量渲染参数与开销（调研工具，不做断言）：
 * 每页 canvas 到底多少像素、ratio 多少、切片多大、一次 _renderPage 多久、滚动时掉多少帧。
 *
 *   node test/perf/real-paper-perf.mjs            # 默认用 papers/attention-arxiv.pdf
 *   PAPER=xxx.pdf node test/perf/real-paper-perf.mjs
 *
 * 为什么要有它：夹具（合成 PDF、纯文字、3 页）太轻，量不出真机上的开销。
 * 2026-10-09 就是靠它发现 `renderRatio()` 在 1× 屏上硬按 2 倍渲染 —— 每页 10.3 MP、
 * 滚动时 13 个长任务共 1329ms；改成按 dpr 之后是 2.6 MP / 1 个长任务 54ms。
 *
 * ⚠️ 会**只读**拷一份你的论文到 `test/artifacts/`（gitignore + pack.mjs 拒收非夹具 PDF），
 *    原始文件一个字节都不动；papers/ 里没有论文时自动退回夹具。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(import.meta.dirname, '..', 'artifacts', 'perf-real-paper');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8976);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
const SRC = path.join(ROOT, 'papers', process.env.PAPER || 'attention-arxiv.pdf');
const useReal = fs.existsSync(SRC);
const fallback = path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
const from = useReal ? SRC : fallback;
const NAME = path.basename(from);
fs.copyFileSync(from, path.join(PAPERS, NAME));
console.log(`用${useReal ? '真实论文' : '夹具'}：${NAME}（${(fs.statSync(from).size / 1048576).toFixed(1)} MB）`
  + (useReal ? '（只读拷贝，原文件不动）' : '（papers/ 里没有指定论文，退回夹具）'));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(400); up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false); }
if (!up) { server.kill(); throw new Error('server 没起来'); }
process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950', '--enable-pinch'],
  defaultViewport: { width: 1500, height: 950, hasTouch: true, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate(() => document.querySelector('#fileList li').click());
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 60000 });
await sleep(4000);

await page.evaluate(() => {
  window.__frames = [];
  window.__long = [];
  window.__sample = (on) => {
    if (!on) { if (window.__raf) cancelAnimationFrame(window.__raf); window.__raf = 0; return; }
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => { window.__frames.push(+(t - last).toFixed(1)); last = t; window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  };
  window.__stats = () => {
    const n = window.__frames.filter((x) => typeof x === 'number');
    if (!n.length) return { n: 0 };
    const s = [...n].sort((a, b) => a - b);
    return { n: n.length, avg: +(n.reduce((a, b) => a + b, 0) / n.length).toFixed(1), p95: s[Math.floor(n.length * 0.95)], max: s[s.length - 1], drops: n.filter((x) => x > 25).length };
  };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch { /* */ }
});

/* ── ① 现役渲染参数 ── */
const dumpParams = () => page.evaluate(() => {
  const v = window.__viewer;
  const out = { scale: +v.scale.toFixed(2), dpr: window.devicePixelRatio, pages: [], viewer: { w: v.container.clientWidth, h: v.container.clientHeight } };
  for (const [i, e] of v.rendered) {
    const c = e.canvas;
    const mp = (c.width * c.height) / 1e6;
    out.pages.push({
      i, device: `${c.width}×${c.height}`, mp: +mp.toFixed(1),
      css: `${Math.round(parseFloat(c.style.width))}×${Math.round(parseFloat(c.style.height))}`,
      ratio: e.ratio, slice: e.slice ? `${e.slice.w}×${e.slice.h}` : '整页',
      renderScale: +e.renderScale.toFixed(2), soft: c.classList.contains('soft-zoom'),
    });
  }
  return out;
});
console.log('\n══ ① fitWidth 时每页的渲染参数 ══');
const p1 = await dumpParams();
console.log(`  scale=${p1.scale} dpr=${p1.dpr} 阅读区=${p1.viewer.w}×${p1.viewer.h}`);
for (const x of p1.pages) console.log(`   第${x.i}页 ${x.device} 设备像素 = ${x.mp} MP（CSS ${x.css}，ratio ${x.ratio}，${x.slice}）`);

/* ── ② 一次整页重画要多久（真实内容） ── */
const paintCost = await page.evaluate(async () => {
  const v = window.__viewer;
  const times = [];
  for (const i of [...v.rendered.keys()].slice(0, 3)) {
    const t0 = performance.now();
    v._teardownPage(i);
    await v._renderPage(i, { force: true, gen: v._gen });
    times.push({ page: i, ms: +(performance.now() - t0).toFixed(0) });
  }
  return times;
});
console.log('\n══ ② 真实论文单页重画耗时 ══');
for (const t of paintCost) console.log(`   第${t.page}页 ${t.ms}ms`);

/* ── ③ 放大到 3.5× 之后再量一遍 ── */
await page.evaluate(() => { const v = window.__viewer; v.setScale(3.5, { keepCenter: true }); });
await sleep(3000);
console.log('\n══ ③ 放大到 3.5× 之后 ══');
const p3 = await dumpParams();
console.log(`  scale=${p3.scale}`);
for (const x of p3.pages) console.log(`   第${x.i}页 ${x.device} = ${x.mp} MP（CSS ${x.css}，ratio ${x.ratio}，${x.slice}）`);
const paintCost3 = await page.evaluate(async () => {
  const v = window.__viewer;
  const times = [];
  for (const i of [...v.rendered.keys()].slice(0, 2)) {
    const t0 = performance.now();
    v._teardownPage(i);
    await v._renderPage(i, { force: true, gen: v._gen });
    times.push({ page: i, ms: +(performance.now() - t0).toFixed(0) });
  }
  return times;
});
for (const t of paintCost3) console.log(`   重画第${t.page}页 ${t.ms}ms`);

/* ── ④ 滚动时的帧节奏（用户大概率说的就是它） ── */
await page.evaluate(() => { const v = window.__viewer; v.setScale(2.3, { keepCenter: false }); document.getElementById('viewer').scrollTop = 0; });
await sleep(2500);
await page.evaluate(() => { window.__long = []; window.__sample(true); });
for (let i = 0; i < 30; i++) {
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate((y) => { document.getElementById('viewer').scrollTop = y; }, i * 220);
  // eslint-disable-next-line no-await-in-loop
  await sleep(16);
}
const scrollStats = await page.evaluate(() => { const s = window.__stats(); window.__sample(false); return { s, long: window.__long }; });
console.log('\n══ ④ 连续滚动 6600px（模拟真人快速滚动）══');
console.log(`   帧节奏 ${JSON.stringify(scrollStats.s)}`);
console.log(`   长任务 ${JSON.stringify(scrollStats.long)} 共 ${scrollStats.long.reduce((a, b) => a + b, 0)}ms`);

/* ── ⑤ 滚动期间到底是谁在吃主线程 ── */
const during = await page.evaluate(async () => {
  const v = window.__viewer;
  const log = [];
  const t0 = performance.now();
  const wrap = (name) => {
    const o = v[name].bind(v);
    v[name] = (...a) => { const t = performance.now(); const r = o(...a); const fin = () => log.push(`${name}${a[0] != null && typeof a[0] === 'number' ? '#' + a[0] : ''} ${Math.round(performance.now() - t)}ms @+${Math.round(t - t0)}ms`); if (r && typeof r.then === 'function') { r.then(fin, fin); return r; } fin(); return r; };
  };
  wrap('_renderPage');
  wrap('_renderVisible');
  wrap('_refreshSlices');
  for (let i = 0; i < 24; i++) {
    v.container.scrollTop = 200 + i * 260;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 24));
  }
  return log;
});
console.log('\n══ ⑤ 滚动期间的重画/切片调用 ══');
console.log('   ' + (during.length ? during.join('\n   ') : '(没有调用)'));
const p5 = await dumpParams();
console.log('\n   滚动后每页：');
for (const x of p5.pages) console.log(`    第${x.i}页 ${x.device} = ${x.mp} MP（${x.slice}）`);

await browser.close();
server.kill();
console.log('\n完成。');
process.exit(0);
