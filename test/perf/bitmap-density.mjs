/**
 * 位图密度调研（不做断言，只打印数字）：**屏幕上一个 CSS 像素分到几个位图像素**。
 *   node test/perf/bitmap-density.mjs              # 夹具（快）
 *   DPR=2 node test/perf/bitmap-density.mjs        # 只看 2× 屏（触摸屏笔记本多半是 2×）
 *   PAPER=attention-arxiv.pdf node test/perf/bitmap-density.mjs   # 换你的论文（只读拷贝，慢）
 *
 * 为什么要专门量这个：2026-10-10 用户口径「怎么放大之后就不太清晰了」。
 * 密度 < dpr 就说明浏览器在把位图放大 = 糊。当时的实测（修复前）：
 *   dpr=1：scale 5/6 → 0.75；dpr=2：fit 宽度 1.53、3.5× 1.01、5× 之后 0.75。
 * 根因不是渲染不动，而是像素预算**按整页面积**算：整页一大就把倍率压到 0.75，
 * 再交给切片逻辑 —— 切片明明放得下也继承了 0.75。修好之后：
 *   dpr=1 全档 1.0；dpr=2 fit 宽度 1.87（整页、滚动不重画）、3.5× 起 2.0（切片）。
 * 永久断言在 `test/zoom.mjs`（「放大之后的清晰度」一节），这里只是给人看的数字。
 * 密度只取决于「屏幕 + 缩放比例」，与论文内容无关，所以默认用夹具 —— 有真论文时
 * 每个 scale 要等重画，跑完一遍要好几分钟。
 */
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
