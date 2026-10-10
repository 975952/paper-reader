/**
 * 触摸屏手势回归：先判意图，再动手；捏合要跟手、要不掉帧。
 *
 *   BASE=http://127.0.0.1:8787 node test/zoom-touch.mjs
 *
 * 背景（用户口径）：
 *   2026-10-08「触摸屏缩放不丝滑」→ 触摸屏捏合其实被浏览器拿去做整页 Page Scale 缩放
 *   （实测 visualViewport.scale 1→4，而阅读器的 zoomAt 一次都没被调用）。
 *   2026-10-09「用户下手到底是滑动还是缩放判断清楚，不要先划又变大变小。还是有一点点小卡顿」
 *   → ①两指手势要**先判定意图**：间距没明显变化就只平移、绝不碰比例；
 *     ②捏合过程逐帧写 transform 会把文本层一起重新栅格化 → 预览期间把文本层藏掉
 *       （它本来就是透明的，只负责命中/选区），捏合过程从 9~10 帧掉帧变成 0~3 帧。
 *
 * ⚠️ 为什么这里**不断言帧率**：帧数是机器负载的函数（同一份代码实测 0~12 帧不等，
 *    尤其是同时开着 exe 窗口的时候）。帧的量化对比放在 test/perf/zoom-frame-rhythm.mjs
 *    与 test/perf/touch-pan-vs-pinch.mjs（打印数字给人看，带 A/B 对照）。
 *    本套件只钉**确定性的东西**：行为、几何、结构，以及「重画是不是排队开工」。
 *
 * 契约清单：
 *   ① 捏合**不许**动整页缩放（visualViewport.scale 保持 1）；② 两指平行拖动只滚动、比例不动；
 *   ③ 两指微抖什么都不发生；④ 对称捏合真的放大且锚点不飘；⑤ 先平移后捏合两件事都发生；
 *   ⑥ 预览期间文本层被藏起、松手恢复；⑦ 松手后的重画是排队开工的（不叠一起）；
 *   ⑧ 松手后视口内回到清晰位图，没有灰条/空白；⑨ 单指拖动仍是原生滚动；
 *   ⑩ 触摸板捏合（ctrl+wheel）没被改坏。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const PERF = {
  /* 长任务预算是**冒烟**口径：捡的是「一次冻住半秒以上」这种灾难性回归。
     实测（软件光栅、与 exe 抢 CPU 时）单次会到 300~330ms，所以阈值放宽。 */
  maxSingleLongTaskMs: 450,
  totalLongTaskMs: 1500,
  textLayerPassMs: 80,       // _bindRealFonts + _normalizeTextScale + _nudgeTextLayer 单页合计（旧实现 ~190ms）
  /* 排队重画的判据：两次 _renderPage 的**开始**时间至少隔这么久。
     旧实现（_renderVisible 一次性全开工 + _refreshSlices 又抢一页）实测是同一刻开两个（间隔 ~0ms）。 */
  rerenderStartGapMs: 25,
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  // --enable-pinch：让 Chromium 真的有「原生捏合」这条路径。没有它，本套件测不到
  // 「浏览器会不会把两指手势抢去做整页缩放」这个核心问题（修复前就靠它复现出 1→4）。
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950', '--enable-pinch'],
  defaultViewport: { width: 1500, height: 950, hasTouch: true, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2500);

/* ── 页面内埋点 ── */
await page.evaluate(() => {
  window.__zt = { long: [], ctrlWheel: 0, touchStart: 0, touchMove: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zt.long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch { /* 老引擎没有 longtask 就算了 */ }
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) window.__zt.ctrlWheel++; }, { capture: true, passive: true });
  document.addEventListener('touchstart', () => { window.__zt.touchStart++; }, { capture: true, passive: true });
  document.addEventListener('touchmove', () => { window.__zt.touchMove++; }, { capture: true, passive: true });
  /* 记下每次 _renderPage 的开始时刻：松手后的重画必须是排队开工的（一个个来） */
  const v = window.__viewer;
  window.__starts = [];
  const orig = v._renderPage.bind(v);
  v._renderPage = (i, o) => { window.__starts.push(performance.now()); return orig(i, o); };
});
const resetPerf = () => page.evaluate(() => { window.__zt.long = []; window.__zt.ctrlWheel = 0; window.__zt.touchStart = 0; window.__zt.touchMove = 0; window.__starts = []; });
const readPerf = () => page.evaluate(() => ({ ...window.__zt }));

const viewerState = () => page.evaluate(() => ({
  scale: +window.__viewer.scale.toFixed(3),
  scroll: Math.round(document.getElementById('viewer').scrollTop),
  vv: visualViewport ? visualViewport.scale : 1,
  docW: document.documentElement.clientWidth,
}));

const twoFinger = async (frames, { steps = 20, gap = 16, beforeEnd = null } = {}) => {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: frames(0) });
  for (let i = 1; i <= steps; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: frames(i / steps) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(gap);
  }
  if (beforeEnd) await beforeEnd();
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

const resetView = async () => {
  await page.evaluate(() => {
    const v = window.__viewer;
    v.setScale(v._computeFitScale(), { keepCenter: false });
    document.getElementById('viewer').scrollTop = 700;
  });
  await sleep(1400);
};

const panFramesFn = (t) => {
  const dy = 200 * t;
  return [{ x: 640, y: 220 + dy, id: 1, force: 1 }, { x: 760, y: 220 + dy, id: 2, force: 1 }];
};
const pinchFramesFn = (t) => {
  const d = 60 + 70 * t;
  return [{ x: 750 - d, y: 430, id: 1, force: 1 }, { x: 750 + d, y: 430, id: 2, force: 1 }];
};

/* ══════════════ 一、静态契约 ══════════════ */
console.log('\n-- 静态契约');
const statics = await page.evaluate(() => ({
  htmlTouchAction: getComputedStyle(document.documentElement).touchAction,
  overscrollAnchor: getComputedStyle(document.getElementById('viewer')).overflowAnchor,
}));
check('html 的 touch-action 不含 pinch-zoom（浏览器不再抢捏合）',
  !/pinch-zoom/.test(statics.htmlTouchAction) && /pan/.test(statics.htmlTouchAction), statics.htmlTouchAction);
check('单指平移仍然允许（pan-x / pan-y 保留原生滚动）',
  /pan-x/.test(statics.htmlTouchAction) && /pan-y/.test(statics.htmlTouchAction), statics.htmlTouchAction);
check('阅读区关掉了浏览器滚动锚定（缩放后位置由 JS 自己算）',
  statics.overscrollAnchor === 'none', statics.overscrollAnchor);

/* ══════════════ 二、意图判定 ══════════════ */
console.log('\n-- 意图判定：滑动 vs 缩放');
await resetView();
await resetPerf();
const panBefore = await viewerState();
await twoFinger(panFramesFn);
await sleep(500);
const panAfter = await viewerState();
check('两指平行拖动只滚动，比例一分不动',
  Math.abs(panAfter.scale / panBefore.scale - 1) < 0.005,
  `scale ${panBefore.scale} → ${panAfter.scale}（×${(panAfter.scale / panBefore.scale).toFixed(4)}）`);
check('两指平行拖动确实滚动了内容（不是被浏览器吃掉）',
  panAfter.scroll < panBefore.scroll - 120,
  `scrollTop ${panBefore.scroll} → ${panAfter.scroll}`);
check('两指平行拖动也不缩放整个界面', panAfter.vv === panBefore.vv, `vvScale ${panBefore.vv} → ${panAfter.vv}`);

/* 用户口径（2026-10-09 定稿）：
   「只要是两指之间距离增大，**不管是哪个方向**都是放大，缩小也一样」
   → 竖着张开、斜着张开都必须算放大（判定只看距离，与方向无关）。 */
await resetView();
for (const [dirName, mk] of [
  ['横着张开', (t) => { const d = 50 + 90 * t; return [{ x: 700 - d, y: 430, id: 1, force: 1 }, { x: 700 + d, y: 430, id: 2, force: 1 }]; }],
  ['竖着张开', (t) => { const d = 50 + 90 * t; return [{ x: 700, y: 430 - d, id: 1, force: 1 }, { x: 700, y: 430 + d, id: 2, force: 1 }]; }],
  ['斜着张开', (t) => { const d = 50 + 90 * t; return [{ x: 700 - d, y: 430 - d, id: 1, force: 1 }, { x: 700 + d, y: 430 + d, id: 2, force: 1 }]; }],
]) {
  // eslint-disable-next-line no-await-in-loop
  await resetView();
  // eslint-disable-next-line no-await-in-loop
  const b = await viewerState();
  // eslint-disable-next-line no-await-in-loop
  await twoFinger(mk, { steps: 18 });
  // eslint-disable-next-line no-await-in-loop
  await sleep(1500);
  // eslint-disable-next-line no-await-in-loop
  const a = await viewerState();
  check(`两指${dirName}也算放大（判定只看距离）`, a.scale > b.scale * 1.5,
    `scale ${b.scale} → ${a.scale}（×${(a.scale / b.scale).toFixed(2)}）`);
  // eslint-disable-next-line no-await-in-loop
  await resetView();
}

/* 用户口径：「只要判断是缩放，就不要移动位置」——
   手指搓动（中点漂移）时画面**只缩不放平移**，锚点必须钉在按下去的位置上。 */
await resetView();
const pinned = await page.evaluate(async () => {
  const v = window.__viewer;
  const ax = 700;
  const ay = 400;
  const el = document.elementFromPoint(ax, ay)?.closest?.('.page');
  if (!el) return { error: '按下的位置不在页面上' };
  const pageNum = Number(el.dataset.page);
  const r0 = el.getBoundingClientRect();
  const fx = (ax - r0.left) / r0.width;
  const fy = (ay - r0.top) / r0.height;
  const xs = [];
  const ys = [];
  let stop = false;
  let started = false;
  const sample = () => {
    const pr = v.pageEls[pageNum]?.getBoundingClientRect();
    if (pr && pr.width > 0) { xs.push(pr.left + fx * pr.width); ys.push(pr.top + fy * pr.height); }
  };
  const tick = () => {
    if (stop) return;
    // 只统计「进入预览之后」的帧：第一帧之前本来就没变换
    if (v._zoomPreview) started = true;
    if (started) sample();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const base = v.scale;
  /* 故意让**中点一边往下走一边张开**（真实手指就会这样搓）：
     如果画面跟着中点走，这里的 x/y 会一路漂 140px。
     第一帧不动中点，是刻意的：锚点记在「第一次真正改比例」的那一帧的指针位置上，
     那一帧指针在哪锚点就在哪。要是判定帧指针已经挪了 6px，那 6px 就成了
     「锚点 vs 按下点」的固定差，再被 k 放大（实测 dy = −k·6.36，k=1.7 时 4.5px）——
     那是**测量参考点**的问题，不是画面在动。所以判定帧与按下点重合，
     剩下的 140px 中点漂移才是这句断言真正要否掉的东西（旧实现会漂满 140px）。 */
  for (let i = 1; i <= 22; i++) {
    const t = i / 22;
    const drift = i === 1 ? 0 : (140 * (i - 1)) / 21;
    v.previewScale(base * (1 + 0.7 * t), { clientX: ax, clientY: ay + drift });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  v.commitZoomPreview();
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  stop = true;
  const span = (a) => (a.length > 4 ? +(Math.max(...a) - Math.min(...a)).toFixed(2) : -1);
  return { spanX: span(xs), spanY: span(ys), n: xs.length, k: +(v.scale / base).toFixed(2) };
});
if (pinned.error) {
  check('缩放时画面不跟着手指平移（锚点钉住）', false, pinned.error);
} else {
  check('缩放时画面不跟着手指平移（中点漂 140px 也钉住不动）',
    pinned.spanX >= 0 && pinned.spanX < 2 && pinned.spanY < 2,
    `中点往右下漂了 140px 的情况下，锚点在整段手势（含提交帧）里的位置波动 ${pinned.spanX}×${pinned.spanY}px（${pinned.n} 帧，×${pinned.k}）`);
}

await resetView();
const jitterBefore = await viewerState();await twoFinger((t) => [{ x: 640, y: 300 + 3 * t, id: 1, force: 1 }, { x: 760, y: 300 + 3 * t, id: 2, force: 1 }], { steps: 12 });
await sleep(400);
const jitterAfter = await viewerState();
check('两指只有几像素抖动时纹丝不动',
  Math.abs(jitterAfter.scale / jitterBefore.scale - 1) < 0.003 && Math.abs(jitterAfter.scroll - jitterBefore.scroll) < 6,
  `scale ${jitterBefore.scale} → ${jitterAfter.scale}，scroll ${jitterBefore.scroll} → ${jitterAfter.scroll}`);

/* ══════════════ 三、对称捏合 ══════════════ */
console.log('\n-- 对称捏合');
await resetView();
const before = await page.evaluate(() => {
  const v = window.__viewer;
  const el = document.elementFromPoint(750, 430)?.closest?.('.page');
  const r = el?.getBoundingClientRect();
  return {
    scale: v.scale, vv: visualViewport ? visualViewport.scale : 1, docW: document.documentElement.clientWidth,
    anchor: r ? { page: Number(el.dataset.page), fx: (750 - r.left) / r.width, fy: (430 - r.top) / r.height } : null,
    pageW: r ? r.width : 0,
  };
});
await resetPerf();
/* 预览期间：文本层必须是 hidden、且真的写上了 zoom-preview 类 */
const previewProbe = page.evaluate(() => new Promise((resolve) => {
  const p = document.querySelector('.pages');
  const t0 = performance.now();
  const probe = () => {
    if (p.classList.contains('zoom-preview')) {
      const tl = p.querySelector('.textLayer');
      resolve({ cls: true, visibility: tl ? getComputedStyle(tl).visibility : '(没有文本层)' });
      return;
    }
    if (performance.now() - t0 > 5000) { resolve({ cls: false, visibility: '(没等到预览)' }); return; }
    requestAnimationFrame(probe);
  };
  probe();
}));
await twoFinger(pinchFramesFn);
const previewSeen = await previewProbe;
await sleep(2000);
const after = await page.evaluate(() => {
  const v = window.__viewer;
  const el = document.elementFromPoint(750, 430)?.closest?.('.page');
  const r = el?.getBoundingClientRect();
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const inView = (n) => { const rr = n.getBoundingClientRect(); return rr.bottom > vr.top && rr.top < vr.bottom; };
  return {
    scale: v.scale, vv: visualViewport ? visualViewport.scale : 1, docW: document.documentElement.clientWidth,
    anchor: r ? { page: Number(el.dataset.page), fx: (750 - r.left) / r.width, fy: (430 - r.top) / r.height } : null,
    pageW: r ? r.width : 0,
    soft: [...document.querySelectorAll('canvas.soft-zoom')].filter(inView).length,
    placeholders: [...document.querySelectorAll('.page.placeholder')].filter(inView).length,
    zoomPreviewClass: document.querySelector('.pages')?.classList.contains('zoom-preview'),
    textLayerVisibility: (() => { const tl = document.querySelector('.pages .textLayer'); return tl ? getComputedStyle(tl).visibility : '(没有)' })(),
  };
});
const perf = await readPerf();

check('捏合没有把整个界面缩放（visualViewport.scale 保持 1）', after.vv === before.vv, `${before.vv} → ${after.vv}`);
check('捏合没有改变布局视口宽度', after.docW === before.docW, `${before.docW} → ${after.docW}`);
check('触摸事件确实送到了页面（说明手势被应用接管）', perf.touchStart > 0 && perf.touchMove > 0, `start=${perf.touchStart} move=${perf.touchMove}`);
check('捏合期间没有 ctrl+wheel（确认触摸屏走的是触摸路径）', perf.ctrlWheel === 0, `${perf.ctrlWheel} 次`);
check('捏合真的放大了 PDF', after.scale > before.scale * 1.3, `${before.scale.toFixed(2)} → ${after.scale.toFixed(2)}`);
check('页面宽度跟着缩放（不是只改了百分比）', after.pageW > before.pageW * 1.3, `${Math.round(before.pageW)}px → ${Math.round(after.pageW)}px`);
if (before.anchor && after.anchor) {
  const dx = Math.abs(before.anchor.fx - after.anchor.fx) * after.pageW;
  const dy = Math.abs(before.anchor.fy - after.anchor.fy) * (after.pageW * 1.29);
  check('手指中点下的那个 PDF 点留在原地（跟手不飘）',
    before.anchor.page === after.anchor.page && dx < 30 && dy < 30,
    `第 ${before.anchor.page} 页 → 第 ${after.anchor.page} 页，偏移 ${dx.toFixed(1)}/${dy.toFixed(1)}px`);
} else {
  check('手指中点下的那个 PDF 点留在原地（跟手不飘）', false, '取不到捏合前后的锚点元素');
}
check('预览期间加了 zoom-preview 类', previewSeen.cls === true, JSON.stringify(previewSeen));
check('预览期间文本层被隐藏（这是「不掉帧」的手段）', previewSeen.visibility === 'hidden', `visibility=${previewSeen.visibility}`);
check('松手后文本层恢复可见', after.zoomPreviewClass === false && after.textLayerVisibility === 'visible',
  `zoom-preview=${after.zoomPreviewClass} visibility=${after.textLayerVisibility}`);
check('松手后视口内回到清晰位图，没有残留拉伸预览', after.soft === 0, `soft-zoom ${after.soft} 个`);
check('松手后视口内没有灰条占位', after.placeholders === 0, `${after.placeholders} 页`);

/* 重画必须排队：两次 _renderPage 的开始时刻不能只隔几毫秒 */
const starts = await page.evaluate(() => window.__starts.slice());
const gaps = [];
for (let i = 1; i < starts.length; i++) gaps.push(+(starts[i] - starts[i - 1]).toFixed(1));
const minGap = gaps.length ? Math.min(...gaps) : Infinity;
check('松手后的重画是排队开工的（不是同一刻全开工）',
  starts.length < 2 || minGap >= PERF.rerenderStartGapMs,
  `重画 ${starts.length} 次，开始间隔 ${JSON.stringify(gaps)}（最小 ${Number.isFinite(minGap) ? minGap : 'n/a'}ms，要求 ≥ ${PERF.rerenderStartGapMs}ms）`);

/* 长任务冒烟预算 */
const maxLong = perf.long.length ? Math.max(...perf.long) : 0;
const sumLong = perf.long.reduce((a, b) => a + b, 0);
check(`捏合 + 松手重画期间没有超长卡顿（单次 < ${PERF.maxSingleLongTaskMs}ms）`,
  maxLong < PERF.maxSingleLongTaskMs, `最长 ${maxLong}ms，全部 ${JSON.stringify(perf.long)}`);
check(`捏合 + 松手重画期间总卡顿可控（< ${PERF.totalLongTaskMs}ms）`,
  sumLong < PERF.totalLongTaskMs, `合计 ${sumLong}ms`);

/* ══════════════ 四、提交阶段的状态机契约 ══════════════ */
/**
 * 用户 2026-10-09 评审提出的两条，都在这里钉死：
 *   ① 提交那一帧锚点的屏幕坐标不许跳（视觉连续性）；
 *   ② 「旧 layer 的 CSS transform」和「新 page 的 scale factor」不许同时生效 ——
 *      实测过一次真事故：文本层里 pdf.js 的 span 是百分比定位 + CSS 变量字号，
 *      自己就会跟着页框缩放，再叠一层 scale(k) 就是双倍（fx 0.199 → 0.299）。
 */
console.log('\n-- 提交阶段的状态机契约');
await resetView();
const continuity = await page.evaluate(async () => {
  const v = window.__viewer;
  let n = null;
  for (const [i, e] of v.rendered) {
    if (e.textDiv?.querySelector('span:not(.markedContent)')) { n = i; break; }
  }
  if (n == null) return { error: '没有带文本层的已渲染页' };
  const pageEl = v.pageEls[n];
  const geom = () => {
    const entry = v.rendered.get(n);
    const span = entry?.textDiv?.querySelector('span:not(.markedContent)');
    const pr = pageEl.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    return {
      pageW: +pr.width.toFixed(2),
      fx: +((sr.left + sr.width / 2 - pr.left) / pr.width).toFixed(5),
      fy: +((sr.top + sr.height / 2 - pr.top) / pr.height).toFixed(5),
      fontSize: +parseFloat(getComputedStyle(span).fontSize).toFixed(2),
    };
  };
  const before = geom();
  v.previewScale(v.scale * 1.5, { clientX: 750, clientY: 430 });   // 真实预览路径
  v.commitZoomPreview();                                          // 真实提交路径
  const afterCommit = geom();
  const layersAtCommit = ['textDiv', 'hlLayer', 'hitLayer', 'pinLayer']
    .map((k) => v.rendered.get(n)?.[k]?.style.transform || '(空)');
  const canvasSoftAtCommit = v.rendered.get(n)?.canvas?.classList.contains('soft-zoom');
  return { n, before, afterCommit, layersAtCommit, canvasSoftAtCommit };
});
if (continuity.error) {
  check('能拿到一页带文本层的已渲染页做连续性测量', false, continuity.error);
} else {
  const { before, afterCommit } = continuity;
  const scaleRatio = afterCommit.pageW / before.pageW;
  const sizeRatio = afterCommit.fontSize / before.fontSize;
  check('提交瞬间文本层没有被双重缩放（页内相对位置不漂）',
    Math.abs(afterCommit.fx - before.fx) < 0.005 && Math.abs(afterCommit.fy - before.fy) < 0.005,
    `fx ${before.fx} → ${afterCommit.fx}，fy ${before.fy} → ${afterCommit.fy}（页面 ×${scaleRatio.toFixed(2)}）`);
  check('提交瞬间字号只被缩放一次（冻结成 px，不再吃 --total-scale-factor）',
    Math.abs(sizeRatio - 1) < 0.01,
    `字号 ×${sizeRatio.toFixed(3)}（修复前是 ×${scaleRatio.toFixed(2)}，正好多缩一次）`);
  check('提交瞬间该页四个覆盖层都挂着统一的 scale(k)',
    continuity.layersAtCommit.every((t) => /^scale\(/.test(t)),
    `layers=${JSON.stringify(continuity.layersAtCommit)}`);
}
await sleep(3000);
const settled = await page.evaluate((n) => {
  const e = window.__viewer.rendered.get(n);
  if (!e) return { error: '页被回收了' };
  return {
    layers: ['textDiv', 'hlLayer', 'hitLayer', 'pinLayer'].map((k) => e[k]?.style.transform || ''),
    soft: e.canvas.classList.contains('soft-zoom'),
    dirty: !!e.dirty,
  };
}, continuity.n);
if (!settled.error) {
  check('重画完成后所有层的 transform 归零（回到 steady）',
    settled.layers.every((t) => t === '') && settled.soft === false && settled.dirty === false,
    `layers=${JSON.stringify(settled.layers)} soft=${settled.soft} dirty=${settled.dirty}`);
}

/* 手势全程（含提交那一帧）锚点的屏幕坐标连续性 */
await resetView();
const anim = await page.evaluate(async () => {
  const v = window.__viewer;
  const midX = 750;
  const midY = 430;
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
    if (pr && pr.width > 0) samples.push({ x: pr.left + fx * pr.width, y: pr.top + fy * pr.height });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const base = v.scale;
  for (let i = 1; i <= 20; i++) {
    v.previewScale(base * (1 + 0.5 * (i / 20)), { clientX: midX, clientY: midY });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  v.commitZoomPreview();
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  stopped = true;
  return { midX, midY, pageNum, samples };
});
if (anim.error) {
  check('手势全程锚点不跳（含提交帧）', false, anim.error);
} else {
  const dev = anim.samples.map((s) => Math.hypot(s.x - anim.midX, s.y - anim.midY));
  const jumps = [];
  for (let i = 1; i < anim.samples.length; i++) jumps.push(Math.hypot(anim.samples[i].x - anim.samples[i - 1].x, anim.samples[i].y - anim.samples[i - 1].y));
  check('手势全程（含提交那一帧）锚点都贴在手指中点上',
    dev.length > 10 && Math.max(...dev) < 8,
    `${anim.samples.length} 帧，离手指最大 ${Math.max(...dev).toFixed(1)}px`);
  check('提交那一帧没有突跳（逐帧位移都很小）',
    jumps.length > 10 && Math.max(...jumps) < 8,
    `逐帧位移最大 ${Math.max(...jumps).toFixed(2)}px`);
}

/**
 * 「手势做完之后偏移闪现」——用户 2026-10-09 的反馈，这一条专门钉它。
 * 根因：预览原来是把 `.pages` 整层 `scale(k)`，**页间距（14px）和内边距也被一起放大**，
 * 而提交后的真实布局里它们是固定值 → 离锚点每远一页就差一个 `间距 × (k−1)`
 * （实测 k=2.18 时视口内第 8 页在提交那一帧跳了 16.5px）。
 * 现在预览逐页预演真实布局，提交那一帧所有页都不该位移。
 */
await resetView();
const shift = await page.evaluate(async () => {
  const v = window.__viewer;
  const rec = [];
  let stop = false;
  const tick = () => {
    if (stop) return;
    const pages = {};
    const vr = v.container.getBoundingClientRect();
    for (const [i, e] of v.rendered) {
      const r = e.canvas.parentElement.getBoundingClientRect();
      // 只记"与视口相交"的页：离屏页在预览里被整体缩放，与真实布局本来就不必逐像素一致
      if (r.bottom > vr.top && r.top < vr.bottom) pages[i] = [r.left, r.top];
    }
    rec.push({ preview: !!v._zoomPreview, pages });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const base = v.scale;
  for (let i = 1; i <= 20; i++) {
    v.previewScale(base * (1 + 0.6 * (i / 20)), { clientX: 750, clientY: 430 });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  v.commitZoomPreview();
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  stop = true;
  let ci = -1;
  for (let i = 1; i < rec.length; i++) if (rec[i - 1].preview && !rec[i].preview) { ci = i; break; }
  if (ci < 0) return { error: '没抓到提交帧' };
  const before = rec[ci - 1].pages;
  const after = rec[ci].pages;
  let worst = 0;
  let which = null;
  for (const k of Object.keys(before)) {
    if (!after[k]) continue;
    const d = Math.hypot(after[k][0] - before[k][0], after[k][1] - before[k][1]);
    if (d > worst) { worst = d; which = { page: k, from: before[k].map((x) => Math.round(x)), to: after[k].map((x) => Math.round(x)) }; }
  }
  return { worst: +worst.toFixed(1), which, pages: Object.keys(before).length, k: +(v.scale / base).toFixed(2) };
});
if (shift.error) {
  check('提交那一帧视口内的页不位移（偏移闪现）', false, shift.error);
} else {
  check('提交那一帧视口内的页不位移（偏移闪现）',
    shift.worst <= 3,
    `放大 ×${shift.k}，视口内 ${shift.pages} 页，最大位移 ${shift.worst}px${shift.which ? `（第 ${shift.which.page} 页 ${JSON.stringify(shift.which.from)} → ${JSON.stringify(shift.which.to)}）` : ''}（整层缩放的旧实现是 16.5px）`);
}

/* ══════════════ 五、先平移后捏合 ══════════════ */
console.log('\n-- 先平移后捏合');
await resetView();
const bothBefore = await viewerState();
await twoFinger((t) => {
  const pan = Math.min(1, t / 0.5);
  const zoom = Math.max(0, (t - 0.5) / 0.5);
  const dy = 120 * pan;
  const d = 60 + 60 * zoom;
  return [{ x: 700 - d, y: 300 + dy, id: 1, force: 1 }, { x: 700 + d, y: 300 + dy, id: 2, force: 1 }];
}, { steps: 24 });
await sleep(2000);
const bothAfter = await viewerState();
check('先平移再张开：两件事都发生了（先滚后缩）',
  bothAfter.scale > bothBefore.scale * 1.4,
  `scale ${bothBefore.scale} → ${bothAfter.scale}（×${(bothAfter.scale / bothBefore.scale).toFixed(2)}）`);

/* ══════════════ 五之二、先拖到边界、再捏合 ══════════════
   真实用户最常见的动作之一：「已经在最上面了，还往下搓一把，然后捏合放大」。
   平移的位移是**夹住**的（到边界就不动了），所以这时「手指底下的那个点」和
   「画面实际上钉住的点」会差一个「搓过头的量」。如果升级成缩放时锚点没跟着
   修正，预览期看不出来（预览本来就钉住不动），**提交那一帧**会整个画面猛拽一下 ——
   正是用户抱怨的「手势做完之后偏移闪现」。
   这里用同步测量（中间不 await 任何帧）：提交前后量同一批页的矩形，差值就是用户
   在「最后一帧预览」与「下一帧」之间会看到的位移。 */
await resetView();
const clamp = await page.evaluate(() => {
  const v = window.__viewer;
  const rects = () => {
    const vr = v.container.getBoundingClientRect();
    const out = {};
    for (const [i, e] of v.rendered) {
      const r = e.canvas.parentElement.getBoundingClientRect();
      if (r.bottom > vr.top && r.top < vr.bottom) out[i] = [r.left, r.top];
    }
    return out;
  };
  const base = v.scale;
  // 顶到最上面：往下搓多少都只会被夹在 scrollTop=0，画面一动不动
  v.container.scrollTop = 0;
  for (let i = 1; i <= 12; i++) v.previewPan(700, 400 + 40 * i);
  const overshoot = 40 * 12;
  const panRects = rects();
  const anchorBefore = v._zoomPreview ? { refX: v._zoomPreview.refX, refY: v._zoomPreview.refY } : null;
  // 搓了一把之后改距离 → 升级成缩放。
  // 升级这一帧用 ×1.001：比例几乎没变，所以「页面矩形动了多少」量的就是
  // **锚点接得对不对**，而不是缩放本身带来的位移。
  v.previewScale(base * 1.001, { clientX: 700, clientY: 400 + overshoot });
  const pinned = v._zoomPreview ? { refX: v._zoomPreview.refX, refY: v._zoomPreview.refY } : null;
  const mid = rects();
  const midShift = Math.max(0, ...Object.keys(panRects).map((k) => (mid[k]
    ? Math.hypot(mid[k][0] - panRects[k][0], mid[k][1] - panRects[k][1]) : 0)));
  // 接着真的放大，然后拿**最后一帧预览**与提交后比（同步量，中间不 await 任何帧）
  v.previewScale(base * 1.5, { clientX: 700, clientY: 400 + overshoot });
  const before = rects();
  v.commitZoomPreview();
  const after = rects();
  let worst = 0;
  let which = null;
  for (const k of Object.keys(before)) {
    if (!after[k]) continue;
    const d = Math.hypot(after[k][0] - before[k][0], after[k][1] - before[k][1]);
    if (d > worst) { worst = d; which = { page: k, from: before[k].map(Math.round), to: after[k].map(Math.round) }; }
  }
  return {
    worst: +worst.toFixed(1), which, pages: Object.keys(before).length, overshoot,
    upgradeShift: +midShift.toFixed(1), anchorBefore, pinned, k: +(v.scale / base).toFixed(2),
  };
});
check('拖到边界后再捏合：升级那一瞬画面也不动（锚点跟着边界修正）',
  clamp.upgradeShift <= 3,
  `搓过头 ${clamp.overshoot}px（被夹住），升级帧最大位移 ${clamp.upgradeShift}px，锚点 ${JSON.stringify(clamp.anchorBefore)} → ${JSON.stringify(clamp.pinned)}`);
check('拖到边界后再捏合：提交那一帧画面不位移（偏移闪现）',
  clamp.worst <= 3,
  `放大 ×${clamp.k}，视口内 ${clamp.pages} 页，最大位移 ${clamp.worst}px${clamp.which ? `（第 ${clamp.which.page} 页 ${JSON.stringify(clamp.which.from)} → ${JSON.stringify(clamp.which.to)}）` : ''}`);

/* ══════════════ 五之三、偏离中心的捏合（横向没得滚时不许横跳） ══════════════
   2026-10-10 用户口径：「要归中就固定归中，不要已经移到左右又闪回中间」。
   预览期画面是**按手指钉住**的，但提交后能停在哪儿取决于新布局的滚动范围：
   缩小时页面会变得比阅读区窄（`maxScrollX` 变 0），布局把页居中 —— 于是预览期已经
   横向挪出去的画面，在提交那一帧被硬拽回中间。修复前实测（同一套激励）：
     缩小 5×→1.75× 中点偏右 **-483.2px**、中点居中 **-268.7px**、
     缩小 2.3×→1.5× 偏左 **+119.8px / 纵向 -130.9px**。
   修法：预览直接预演「提交后的几何」，滚动量夹进新布局真正能滚到的范围
   （横向没得滚时 ≡ 0，预览从头到尾就是居中的）。
   这里量的是**锚点所在页**（可见范围之外的页根本没有 preview transform）。 */
console.log('\n-- 偏离中心的捏合（提交那一帧不许横跳）');
const commitShift = (midX, opts) => page.evaluate(async ({ midX: mx, startScale, zoom, scrollTo }) => {
  const v = window.__viewer;
  if (startScale) v.setScale(startScale, { keepCenter: false });
  else v.fitWidth();
  await new Promise((r) => setTimeout(r, 1800));
  const c = v.container;
  if (scrollTo != null) c.scrollTop = scrollTo;
  await new Promise((r) => setTimeout(r, 500));
  const base = v.scale;
  v.previewScale(base * (1 + (zoom - 1) / 16), { clientX: mx, clientY: 430 });
  const ap = v._zoomPreview?.anchorPage || 1;
  for (let i = 1; i <= 12; i++) {
    v.previewScale(base * (1 + (zoom - 1) * (i / 12)), { clientX: mx, clientY: 430 });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  const before = v.pageEls[ap].getBoundingClientRect();
  const snap = { left: +before.left.toFixed(1), top: +before.top.toFixed(1) };
  v.commitZoomPreview();
  const after = v.pageEls[ap].getBoundingClientRect();
  return {
    ap, snap, dx: +(after.left - before.left).toFixed(1), dy: +(after.top - before.top).toFixed(1),
    scrollTop: Math.round(c.scrollTop),
  };
}, { midX, ...opts });

const offCenterCases = [
  ['放大：中点居中（对照）', 750, { zoom: 1.45, scrollTo: 0 }],
  ['缩小 5×→1.75×：中点偏左', 430, { startScale: 5, zoom: 0.35, scrollTo: 1200 }],
  ['缩小 5×→1.75×：中点偏右', 1080, { startScale: 5, zoom: 0.35, scrollTo: 1200 }],
  ['缩小 5×→1.75×：中点居中', 750, { startScale: 5, zoom: 0.35, scrollTo: 1200 }],
  ['缩小 2.3×→1.5×：中点偏左（顶到文档头）', 430, { startScale: 2.302, zoom: 0.65, scrollTo: 0 }],
];
for (const [name, mx, opts] of offCenterCases) {
  // eslint-disable-next-line no-await-in-loop
  const r = await commitShift(mx, opts);
  check(`偏离中心的捏合 · ${name}：提交那一帧不横跳`, Math.abs(r.dx) <= 3 && Math.abs(r.dy) <= 3,
    `锚点第 ${r.ap} 页，预览末帧 [${r.snap.left},${r.snap.top}] → 提交后位移 ${r.dx}×${r.dy}px（修复前这类场景是 -483 / -269 / +120px）`);
}

/* ══════════════ 六、文本层开销与文本流解析次数 ══════════════ */
console.log('\n-- 文本层开销与文本流解析次数');
const detail = await page.evaluate(async () => {
  const v = window.__viewer;
  const i = v.current;
  const div = v.pageEls[i]?.querySelector('.textLayer');
  if (!div) return { error: '当前页没有文本层' };
  const pdfPage = await v.pdf.getPage(i);
  const t0 = performance.now();
  await v._bindRealFonts(div, pdfPage);
  const bind = performance.now() - t0;
  const t1 = performance.now();
  v._normalizeTextScale(div);
  const norm = performance.now() - t1;
  const t2 = performance.now();
  v._nudgeTextLayer(div, pdfPage);
  const nudge = performance.now() - t2;
  return { bind: +bind.toFixed(1), norm: +norm.toFixed(1), nudge: +nudge.toFixed(1), spans: div.querySelectorAll('span:not(.markedContent)').length };
});
if (detail.error) {
  check('能拿到当前页文本层做测量', false, detail.error);
} else {
  const total = detail.bind + detail.norm + detail.nudge;
  check(`文本层三件套单页开销 < ${PERF.textLayerPassMs}ms（读写分离后 ~15ms；改回逐 span 读写是 ~190ms）`,
    total < PERF.textLayerPassMs, `合计 ${total.toFixed(1)}ms（bind ${detail.bind} / normalize ${detail.norm} / nudge ${detail.nudge}，${detail.spans} 个 span）`);
}

/**
 * 一页渲染期间，pdf.js 的文本流只能被取一次。
 * 注意：`getTextContent()` 内部就是 `streamTextContent()`（见 pdf.min.mjs 的实现），
 * 所以「只解析一次」表现为 **streamTextContent 恰好 1 次**（那是 getTextContent 内部那一次）。
 * 旧实现是 TextLayer 自己 `streamTextContent`（1）+ `_bindRealFonts` 里 `getTextContent`（再来 1 次内部调用）
 * = 2 次解析，这里就会红。
 */
const counts = await page.evaluate(async () => {
  const v = window.__viewer;
  const i = v.numPages;
  const pdfPage = await v.pdf.getPage(i);
  const c = { stream: 0, get: 0 };
  const s1 = pdfPage.streamTextContent.bind(pdfPage);
  const s2 = pdfPage.getTextContent.bind(pdfPage);
  pdfPage.streamTextContent = (...a) => { c.stream++; return s1(...a); };
  pdfPage.getTextContent = (...a) => { c.get++; return s2(...a); };
  const origGetPage = v.pdf.getPage.bind(v.pdf);
  v.pdf.getPage = async (n) => (n === i ? pdfPage : origGetPage(n));
  v._teardownPage(i);
  await v._renderPage(i, { force: true, gen: v._gen });
  v.pdf.getPage = origGetPage;
  return c;
});
check('渲染一页只解析一次文本流（旧实现是 2 次）',
  counts.stream === 1 && counts.get <= 1,
  `streamTextContent=${counts.stream} getTextContent=${counts.get}（期望 1 / ≤1）`);

/* ══════════════ 七、单指拖动仍然是原生滚动 ══════════════ */
console.log('\n-- 单指拖动');
await resetView();
const dragScroll = await (async () => {
  const at = (y) => ([{ x: 750, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(700) });
  for (let i = 0; i <= 16; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(700 - i * 12) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  return page.evaluate(() => document.getElementById('viewer').scrollTop);
})();
check('单指拖动照旧是原生滚动（没有为了拿捏合把滚动也关掉）', dragScroll > 40, `scrollTop=${Math.round(dragScroll)}`);

/* ══════════════ 八、触摸板捏合没被改坏 ══════════════ */
console.log('\n-- 触摸板捏合（ctrl+wheel）');
await resetView();
await resetPerf();
const wheelBefore = await page.evaluate(() => ({ scale: window.__viewer.scale, vv: visualViewport ? visualViewport.scale : 1 }));
for (let i = 0; i < 10; i++) {
  // eslint-disable-next-line no-await-in-loop
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 750, y: 430, deltaX: 0, deltaY: -14, modifiers: 2 });
  // eslint-disable-next-line no-await-in-loop
  await sleep(20);
}
await sleep(1200);
const wheelAfter = await page.evaluate(() => ({ scale: window.__viewer.scale, vv: visualViewport ? visualViewport.scale : 1 }));
check('触摸板捏合（ctrl+wheel）仍然缩放 PDF',
  wheelAfter.scale > wheelBefore.scale * 1.1, `${wheelBefore.scale.toFixed(2)} → ${wheelAfter.scale.toFixed(2)}`);
check('触摸板捏合也不会缩放整个界面', wheelAfter.vv === wheelBefore.vv, `${wheelBefore.vv} → ${wheelAfter.vv}`);

/* ══════════════ 九、缩放速度是设置项（2026-10-10 用户口径「把缩放速度做进设置里面」） ══════════════
   同一段手势、同样的手指行程，只改 `viewer.setZoomSpeed(v)`：
   倍率应当按 (d/d0)^(1.6·v) 走，也就是**取对数之后与 v 成正比** —— 2 倍速度 ≈ 2 倍 log 增量。
   手指行程特意取小（100 → 115px），否则会撞上 scale 上限 6，比出来的全是饱和值。 */
console.log('\n-- 缩放速度设置项');
const pinchAtSpeed = async (speed) => {
  await resetView();
  await page.evaluate((s) => window.__viewer.setZoomSpeed(s), speed);
  const before = await page.evaluate(() => window.__viewer.scale);
  await twoFinger((t) => {
    const d = 100 + 15 * t;
    return [{ x: 750 - d, y: 430, id: 1, force: 1 }, { x: 750 + d, y: 430, id: 2, force: 1 }];
  }, { steps: 12 });
  await sleep(500);
  const after = await page.evaluate(() => window.__viewer.scale);
  return { before, after, log: Math.log(after / before) };
};
const sp05 = await pinchAtSpeed(0.5);
const sp10 = await pinchAtSpeed(1);
const sp20 = await pinchAtSpeed(2);
check('缩放速度 0.5× 时同样手势缩得更少、2× 时缩得更多',
  sp05.log > 0 && sp05.log < sp10.log && sp10.log < sp20.log,
  `log 增量 ${sp05.log.toFixed(3)}（0.5×） < ${sp10.log.toFixed(3)}（1×） < ${sp20.log.toFixed(3)}（2×）`);
check('缩放速度与倍率成正比（取对数后约 2 倍递增）',
  Math.abs(sp20.log / sp10.log - 2) < 0.35 && Math.abs(sp10.log / sp05.log - 2) < 0.35,
  `倍数 ${(sp10.log / sp05.log).toFixed(2)}× / ${(sp20.log / sp10.log).toFixed(2)}×（期望 ≈2）`);
// 触摸板那条路走的是 app.js 的 exp(-px × 0.0022 × speed)，读的是 uiStyle ——
// 所以这里**走真实设置面板**（滑杆 → input → applyUiSettingsFromControls），
// 顺带把「设置页那个滑杆真的接通了」也测掉。
await resetView();
const setSpeedViaSettings = async (v) => {
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.evaluate((s) => {
    const el = document.getElementById('uiZoomSpeed');
    el.value = String(s);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const out = await page.evaluate(() => ({
    viewer: window.__viewer.zoomSpeed,
    label: document.getElementById('uiZoomSpeedValue').textContent,
    stored: (JSON.parse(localStorage.getItem('reader.ui') || '{}').style || {}).zoomSpeed,
  }));
  await page.evaluate(() => document.getElementById('closeSettings').click());
  return out;
};
const wheelAtSpeed = async (speed) => {
  const set = await setSpeedViaSettings(speed);
  await resetView();
  const before = await page.evaluate(() => window.__viewer.scale);
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 750, y: 430, deltaX: 0, deltaY: -12, modifiers: 2 });
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  await sleep(900);
  const after = await page.evaluate(() => window.__viewer.scale);
  return { log: Math.log(after / before), set };
};
const wh05 = await wheelAtSpeed(0.5);
const wh20 = await wheelAtSpeed(2);
check('设置页滑杆真的接通了（viewer 与 localStorage 同步）',
  wh05.set.viewer === 0.5 && wh20.set.viewer === 2
  && wh05.set.stored === 0.5 && wh20.set.stored === 2,
  `0.5× → viewer ${wh05.set.viewer} / 存档 ${wh05.set.stored} / 标签「${wh05.set.label}」；`
  + `2× → viewer ${wh20.set.viewer} / 存档 ${wh20.set.stored} / 标签「${wh20.set.label}」`);
check('触摸板捏合也吃同一个「缩放速度」设置',
  wh20.log > wh05.log * 1.8, `同样滚 8 下：0.5× 时 log 增量 ${wh05.log.toFixed(3)}，2× 时 ${wh20.log.toFixed(3)}`);
// 收尾：速度还原成默认（后面还有别的断言，别让速度影响它们）
await setSpeedViaSettings(1);

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'zoom-touch.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
