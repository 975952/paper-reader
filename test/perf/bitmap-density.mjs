import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(import.meta.dirname, '..', 'artifacts', 'perf-density');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8979);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
const SRC = process.env.PAPER ? path.join(ROOT, 'papers', process.env.PAPER) : '';
const from = SRC && fs.existsSync(SRC) ? SRC : path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
fs.copyFileSync(from, path.join(PAPERS, path.basename(from)));
console.log(`用：${SRC && fs.existsSync(SRC) ? '你的论文（只读拷贝）' : '夹具'}（${path.basename(from)}）`);

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(400); up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false); }
if (!up) { server.kill(); throw new Error('server 没起来'); }
process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json());
const first = (papers.papers || [])[0] || {};
const dprs = process.env.DPR ? [Number(process.env.DPR)] : [1, 2];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell', protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

for (const dpr of dprs) {
  await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: dpr });
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fileList li', { timeout: 20000 });
  await page.evaluate((id) => {
    const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
    li.click();
  }, first.docId);
  await page.waitForFunction(() => !!window.__viewer?.pdf, { timeout: 40000 });
  await sleep(2500);
  console.log(`\n===== deviceScaleFactor = ${dpr}（密度要 ≥ ${dpr}）=====`);
  for (const s of [1.2, 2.3, 3.5, 5, 6]) {
    const r = await page.evaluate(async (sc) => {
      const v = window.__viewer;
      v.setScale(sc, { keepCenter: true });
      for (let t = 0; t < 60; t++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 200));
        if (![...v.rendered.values()].some((e) => e.dirty)) break;
      }
      const vr = v.container.getBoundingClientRect();
      const rows = [];
      for (const [i, e] of v.rendered) {
        if (!e.canvas) continue;
        const c = e.canvas.getBoundingClientRect();
        if (Math.min(c.bottom, vr.bottom) - Math.max(c.top, vr.top) < 200) continue;
        const styleW = parseFloat(e.canvas.style.width) || 1;
        rows.push(`第${i}页 密度=${(e.canvas.width / styleW).toFixed(3)} ${e.slice ? `切片${e.slice.w}x${e.slice.h}` : '整页'} ratio=${(e.ratio ?? 0).toFixed(2)} 位图=${e.canvas.width}x${e.canvas.height}(${((e.canvas.width * e.canvas.height) / 1e6).toFixed(1)}MP)`);
      }
      return rows;
    }, s);
    for (const line of r) console.log(`  scale ${String(s).padEnd(4)} ${line}`);
  }
}
await browser.close();
/* 必须显式收尾：`server` 是子进程，它会把这个 node 进程的事件循环一直占着，
   于是 `process.on('exit')` 永远不会触发 —— 第一版就是这么挂了 10 分钟不返回。 */
server.kill();
process.exit(0);
