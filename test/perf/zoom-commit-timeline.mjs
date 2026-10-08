/**
 * 「松手之后那 200ms 到底花在哪」——缩放提交逐段计时（调研工具，不是断言套件）。
 *
 *   node test/perf/zoom-commit-timeline.mjs
 *
 * 用法：本脚本自己起一个隔离的 node server.js + 无头 Chrome，模拟触摸板捏合
 * （ctrl+wheel，30 步），然后把「最后一次滚轮之后」的每个阶段打在时间轴上：
 *   softRescale / layout / renderPage / pdf.js paint / 文本层三件套。
 *
 * 2026-10-08 修复前的实测（16 页夹具、视口内 2 页）：
 *   softRescale   0.3ms
 *   layout        22~27ms
 *   paint ×2      23~76ms
 *   文本层        91ms（TextLayer.render）+ 100~125ms（_bindRealFonts）×2
 *   长任务        233ms + 74ms
 *   → 「松手之后顿一下」就是这几段叠出来的。
 * 修复后（读写分离 + 文本流只取一次）：
 *   _bindRealFonts 8~10ms（原来 95~125ms）、_normalizeTextScale 2ms、_nudgeTextLayer 5ms
 *   长任务 217ms + 56ms，视口内 1 页时「松手 → 清晰」约 420ms。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'artifacts', 'perf-commit');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8972);
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

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate(() => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => /multipage/i.test(x.textContent)) || document.querySelector('#fileList li');
  li.click();
});
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2500);

await page.evaluate(() => {
  const v = window.__viewer;
  window.__ev = [];
  window.__long = [];
  window.__t0 = performance.now();
  const M = () => +(performance.now() - window.__t0).toFixed(1);
  const wrap = (name, label) => {
    const o = v[name].bind(v);
    v[name] = (...a) => {
      const s = M();
      const r = o(...a);
      const fin = () => window.__ev.push(`${s}->${M()}|${label}`);
      if (r && typeof r.then === 'function') { r.then(fin, fin); return r; }
      fin();
      return r;
    };
  };
  for (const [n, l] of [['_softRescale', 'softRescale'], ['layout', 'layout'], ['_bindRealFonts', 'bindRealFonts'],
    ['_normalizeTextScale', 'normalizeTextScale'], ['_nudgeTextLayer', 'nudgeTextLayer'], ['_tileTextHitBoxes', 'tileHitBoxes']]) wrap(n, l);
  const rp = v._renderPage.bind(v);
  v._renderPage = async (i, o) => { const s = M(); try { return await rp(i, o); } finally { window.__ev.push(`${s}->${M()}|renderPage#${i}`); } };
  const og = v.pdf.getPage.bind(v.pdf);
  v.pdf.getPage = async (n) => {
    const s = M();
    const p = await og(n);
    window.__ev.push(`${s}->${M()}|getPage#${n}`);
    if (!p.__w) {
      p.__w = true;
      const r = p.render.bind(p);
      p.render = (params) => { const s2 = M(); const task = r(params); task.promise.then(() => window.__ev.push(`${s2}->${M()}|paint#${n}`), () => {}); return task; };
    }
    return p;
  };
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) { window.__t0 = performance.now(); } }, { capture: true, passive: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(`${e.startTime.toFixed(0)}+${Math.round(e.duration)}`); })
      .observe({ entryTypes: ['longtask'] });
  } catch { /* 老引擎没有就算了 */ }
});

for (let run = 0; run < 3; run++) {
  await page.evaluate(() => window.__viewer.fitWidth());
  // eslint-disable-next-line no-await-in-loop
  await sleep(1800);
  await page.evaluate(() => { window.__ev = []; window.__long = []; });
  for (let i = 0; i < 18; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: -12, modifiers: 2 });
    // eslint-disable-next-line no-await-in-loop
    await sleep(14);
  }
  // eslint-disable-next-line no-await-in-loop
  await sleep(1800);
  // eslint-disable-next-line no-await-in-loop
  const r = await page.evaluate(() => ({ ev: window.__ev, long: window.__long, scale: +window.__viewer.scale.toFixed(2) }));
  console.log(`\n=== run ${run}（scale=${r.scale}）长任务(起点+时长) ${JSON.stringify(r.long)} ===`);
  console.log('  时间轴（相对最后一次滚轮，毫秒）:');
  console.log('    ' + r.ev.join('\n    '));
}

await browser.close();
server.kill();
console.log('\n完成。');
process.exit(0);
