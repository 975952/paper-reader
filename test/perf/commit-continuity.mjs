/**
 * 验收两件事（用户 2026-10-09 评审提出的）：
 *   ① 提交时文本层是不是被「双倍缩放」了（_softRescale 的 scale(k) + layout 改 --total-scale-factor）
 *   ② 提交那一帧锚点的屏幕坐标有没有跳（视觉连续性）
 * 调研工具（打印数字，不做断言），自带隔离服务。
 *
 * 跑法：node test/perf/commit-continuity.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { assertIsolatedDataDir, resolveDataDir } from '../_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(import.meta.dirname, '..', 'artifacts', 'perf-commit-continuity');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
const PORT = Number(process.env.PORT || 8975);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
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
  // PRT_DIAGNOSTICS=1 是必须的：只有它开着 `/api/papers` 才会回 `dir`，
  // 而下面的隔离护栏（assertIsolatedDataDir）要拿它确认这不是用户的真实 data/。
  env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(400); up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false); }
if (!up) { server.kill(); throw new Error('server 没起来（端口被占？换 PORT=… 再试）'); }
/* 中途抛错也要把这个隔离服务收掉：否则它会继续占着端口，
   下一次运行的健康检查会打到这个「数据目录已经被删掉」的旧服务上，报出很误导的错误。 */
process.on('exit', () => { try { server.kill(); } catch { /* ignore */ } });

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch((e) => ({ __err: String(e) }));
if (papers.__err || !papers.dir) {
  console.error('隔离服务异常：BASE=', BASE, '（`dir` 缺失通常是忘了 PRT_DIAGNOSTICS=1）');
  process.exit(2);
}
assertIsolatedDataDir(resolveDataDir(papers.dir));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};

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
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2500);
// 固定到第 1 页并等它渲染完（不这样做的话会接着上次保存的阅读位置，取到的页可能没有文本层）
await page.evaluate(() => { document.getElementById('viewer').scrollTop = 0; window.__viewer.goToPage(1); });
await sleep(2500);

/* ══════════ ① 文本层双倍缩放 ══════════ */
const r1 = await page.evaluate(() => {
  const v = window.__viewer;
  // 找一个「已经渲染好且真的有 span」的页，别假设 current 就是它
  let i = null;
  let entry = null;
  let span = null;
  for (const [n, e] of v.rendered) {
    const s = e.textDiv?.querySelector('span:not(.markedContent)');
    if (s) { i = n; entry = e; span = s; break; }
  }
  if (!i) return { error: '没有任何已渲染页带文本层', rendered: [...v.rendered.keys()] };
  const pageEl = v.pageEls[i];

  const geom = () => {
    const pr = pageEl.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    return {
      pageW: +pr.width.toFixed(2),
      pageH: +pr.height.toFixed(2),
      // span 中心相对页左上角的比例（缩放前后应当不变）
      fx: +((sr.left + sr.width / 2 - pr.left) / pr.width).toFixed(5),
      fy: +((sr.top + sr.height / 2 - pr.top) / pr.height).toFixed(5),
      fontSize: parseFloat(getComputedStyle(span).fontSize).toFixed(2),
      layerTransform: entry.textDiv.style.transform || '(none)',
      pageScaleVar: pageEl.style.getPropertyValue('--total-scale-factor'),
    };
  };
  const before = geom();

  // 造一个预览：目标比例 = 当前 ×1.5
  const target = v.scale * 1.5;
  v.previewScale(target, { clientX: 750, clientY: 430 });
  const during = geom();

  // 提交（同步）：返回后立刻量一次 —— 这就是"提交那一帧"的 DOM 状态
  v.commitZoomPreview();
  const justAfterCommit = geom();

  // 文本层里有没有"看得见"的东西（决定双倍缩放会不会被肉眼看到）
  const visibleInTextLayer = [...entry.textDiv.querySelectorAll('span')].filter((s) => {
    const cs = getComputedStyle(s);
    return (cs.color !== 'rgba(0, 0, 0, 0)' && cs.color !== 'transparent') || cs.backgroundImage !== 'none';
  }).length;
  const roleImg = entry.textDiv.querySelectorAll('span[role="img"]').length;

  return {
    before, during, justAfterCommit,
    pageNum: i,
    k: +(v.scale / parseFloat(before.pageScaleVar || '1')).toFixed(4),
    visibleInTextLayer, roleImg,
    spanCount: entry.textDiv.querySelectorAll('span').length,
  };
});
console.log('\n══ ① 提交前后的文本层几何 ══');
if (r1.error) console.log('  ', r1.error);
else {
  console.log('  预览前    :', JSON.stringify(r1.before));
  console.log('  预览中    :', JSON.stringify(r1.during));
  console.log('  提交后立刻:', JSON.stringify(r1.justAfterCommit));
  const fxDrift = Math.abs(r1.justAfterCommit.fx - r1.before.fx);
  const fyDrift = Math.abs(r1.justAfterCommit.fy - r1.before.fy);
  const pageRatio = r1.justAfterCommit.pageW / r1.before.pageW;
  const sizeRatio = parseFloat(r1.justAfterCommit.fontSize) / parseFloat(r1.before.fontSize);
  console.log(`  页面放大 ${pageRatio.toFixed(3)}×，span 字号放大 ${sizeRatio.toFixed(3)}×`);
  console.log(`  span 在页内的相对位置漂移 fx=${fxDrift.toFixed(5)} fy=${fyDrift.toFixed(5)}（应当≈0）`);
  console.log(`  文本层里"看得见"的 span：${r1.visibleInTextLayer} 个；role=img：${r1.roleImg} 个；span 总数 ${r1.spanCount}`);
  console.log(`  → 相对位置漂移 ${fxDrift > 0.01 ? '明显（说明被多缩了一次）' : '很小'}`);
}

/* 等重画完，再看一次 */
await sleep(3000);
const r1b = await page.evaluate((n) => {
  const v = window.__viewer;
  const pageEl = v.pageEls[n];
  const entry = v.rendered.get(n);
  const span = entry?.textDiv?.querySelector('span:not(.markedContent)');
  if (!span) return { error: '重画后没有 span' };
  const pr = pageEl.getBoundingClientRect();
  const sr = span.getBoundingClientRect();
  return {
    fx: +((sr.left + sr.width / 2 - pr.left) / pr.width).toFixed(5),
    fy: +((sr.top + sr.height / 2 - pr.top) / pr.height).toFixed(5),
    layerTransform: entry.textDiv.style.transform || '(none)',
    softZoom: entry.canvas.classList.contains('soft-zoom'),
  };
}, r1.pageNum);
console.log('  重画完成后:', JSON.stringify(r1b), '（这里的 fx/fy 才是"正确值"）');
if (!r1.error && !r1b.error) {
  console.log(`  → 提交瞬间的 fx(${r1.justAfterCommit.fx}) vs 重画后的 fx(${r1b.fx})：差 ${Math.abs(r1.justAfterCommit.fx - r1b.fx).toFixed(5)}`);
}

/* ══════════ ② 提交那一帧的视觉连续性（锚点屏幕坐标）══════════ */
console.log('\n══ ② 手势全程（含提交那一帧）锚点的屏幕坐标 ══');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(1500);
const r2 = await page.evaluate(async () => {
  const v = window.__viewer;
  const midX = 750;
  const midY = 430;
  // 锚点：中点落在哪一页的哪个相对位置
  const el = document.elementFromPoint(midX, midY)?.closest?.('.page');
  if (!el) return { error: '中点不在页面上' };
  const pageNum = Number(el.dataset.page);
  const r0 = el.getBoundingClientRect();
  const fx = (midX - r0.left) / r0.width;
  const fy = (midY - r0.top) / r0.height;

  const samples = [];
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const pr = v.pageEls[pageNum]?.getBoundingClientRect();
    if (pr && pr.width > 0) {
      samples.push({
        t: Math.round(performance.now()),
        x: +(pr.left + fx * pr.width).toFixed(1),
        y: +(pr.top + fy * pr.height).toFixed(1),
        phase: v._zoomPreview ? 'preview' : 'steady',
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // 模拟捏合：从 1.0 涨到 1.5，每帧一步（走真实的 previewScale / commit 路径）
  const base = v.scale;
  for (let i = 1; i <= 24; i++) {
    v.previewScale(base * (1 + 0.5 * (i / 24)), { clientX: midX, clientY: midY });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  v.commitZoomPreview();                       // ← 提交就在这一行
  for (let i = 0; i < 12; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  stopped = true;
  return { midX, midY, pageNum, fx: +fx.toFixed(4), fy: +fy.toFixed(4), samples };
});
if (r2.error) console.log('  ', r2.error);
else {
  const dev = r2.samples.map((s) => Math.hypot(s.x - r2.midX, s.y - r2.midY));
  const jumps = [];
  for (let i = 1; i < r2.samples.length; i++) {
    jumps.push(+Math.hypot(r2.samples[i].x - r2.samples[i - 1].x, r2.samples[i].y - r2.samples[i - 1].y).toFixed(1));
  }
  console.log(`  锚点：第 ${r2.pageNum} 页 fx=${r2.fx} fy=${r2.fy}，手指中点固定在 (${r2.midX}, ${r2.midY})`);
  console.log(`  采样 ${r2.samples.length} 帧；锚点离手指中点的距离：最大 ${Math.max(...dev).toFixed(1)}px，平均 ${(dev.reduce((a, b) => a + b, 0) / dev.length).toFixed(1)}px`);
  console.log(`  逐帧位移：最大 ${Math.max(...jumps).toFixed(1)}px，全部 = ${jumps.join(' ')}`);
  console.log(`  → 提交那一帧的位移 ${jumps.length ? jumps[jumps.length - 13] ?? '(窗口外)' : '?'}px（看有没有突跳）`);
}

await browser.close();
server.kill();
console.log('\n完成。');
process.exit(0);
