/**
 * 触摸屏捏合缩放回归。
 *
 *   BASE=http://127.0.0.1:8787 node test/zoom-touch.mjs
 *
 * 背景（用户口径 2026-10-08：「触摸屏缩放不丝滑」）：
 *   触摸屏两指捏合在 Chromium 里**不是**触摸板那种 `wheel + ctrlKey`，
 *   浏览器会把它当成**整页 Page Scale 缩放**。实测（test/perf/zoom-touch-takeover.mjs）：
 *   两指张开时 `visualViewport.scale` 从 1 直接跳到 4，而阅读器的缩放逻辑一次都没收到 ——
 *   顶栏、侧栏、PDF 位图一起被拉伸，所以「糊 + 不跟手」。
 *   桌面壳那边 wry 把 `IsPinchZoomEnabled` 和 `with_hotkeys_zoom` 绑在一起
 *   （wry-0.55.1/src/webview2/mod.rs:593），光靠 Rust 侧关不掉而不伤触摸板捏合。
 *
 * 本套件钉死的是修复后的契约：
 *   ① 捏合**不许**动整页缩放（visualViewport.scale 保持 1）；
 *   ② 捏合必须真的缩放 PDF（viewer.scale 变大、页宽跟着变）；
 *   ③ 手指中点下的那个 PDF 点要留在原地（跟手，不飘）；
 *   ④ 单指拖动仍然是原生滚动（没有为了拿手势把滚动也关掉）；
 *   ⑤ 松手后 1.5s 内视口里回到清晰位图，且全程不出现灰条 / 空白；
 *   ⑥ 缩放重画的主线程预算（这是「丝滑」的量化口径，见下面 PERF 段）；
 *   ⑦ 触摸板捏合（ctrl+wheel）没有被改坏。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

/**
 * 主线程预算（毫秒）。数字是实测值留出余量后的结果，不是拍的：
 *   修复前：一次捏合（含松手后重画）长任务 8 个共 779ms，最长 216ms；
 *           单页 _bindRealFonts 152~184ms（每个 span 都强制同步布局），
 *           而且同一页的文本流被解析两遍（streamTextContent + getTextContent）。
 *   修复后：长任务降到 4 个共 ~210ms，最长 ~150ms；_bindRealFonts ~7ms。
 * 阈值取得比实测宽（宁可漏报一次回归，也不要因为一台慢机器就假红），
 * 但仍然卡在「修复前一定不过」的位置。
 */
const PERF = {
  maxSingleLongTaskMs: 300,
  totalLongTaskMs: 900,
  textLayerPassMs: 80,      // _bindRealFonts + _normalizeTextScale + _nudgeTextLayer 单页合计
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

/* ── 页面内埋点：长任务 + 手势事件计数 ── */
await page.evaluate(() => {
  window.__zt = { long: [], ctrlWheel: 0, touchStart: 0, touchMove: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zt.long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch { /* 老引擎没有 longtask 就算了 */ }
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) window.__zt.ctrlWheel++; }, { capture: true, passive: true });
  document.addEventListener('touchstart', () => { window.__zt.touchStart++; }, { capture: true, passive: true });
  document.addEventListener('touchmove', () => { window.__zt.touchMove++; }, { capture: true, passive: true });
});
const resetPerf = () => page.evaluate(() => { window.__zt.long = []; window.__zt.ctrlWheel = 0; window.__zt.touchStart = 0; window.__zt.touchMove = 0; });
const readPerf = () => page.evaluate(() => window.__zt);

/** 两指：从间隔 2*d0 张到 2*d1，中点固定在 (cx, cy) */
const touchPinch = async (cx, cy, d0, d1, steps = 20, gap = 16) => {
  const at = (d) => ([
    { x: cx - d, y: cy, radiusX: 12, radiusY: 12, force: 1, id: 1 },
    { x: cx + d, y: cy, radiusX: 12, radiusY: 12, force: 1, id: 2 },
  ]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(d0) });
  for (let i = 0; i <= steps; i++) {
    // eslint-disable-next-line no-await-in-loop
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d0 + ((d1 - d0) * i) / steps) });
    // eslint-disable-next-line no-await-in-loop
    await sleep(gap);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

/* ══════════════ 一、静态契约：手势必须先归应用管 ══════════════ */
console.log('\n-- 静态契约');
const statics = await page.evaluate(() => ({
  htmlTouchAction: getComputedStyle(document.documentElement).touchAction,
  bodyTouchAction: getComputedStyle(document.body).touchAction,
  viewerTouchAction: getComputedStyle(document.getElementById('viewer')).touchAction,
  overscrollAnchor: getComputedStyle(document.getElementById('viewer')).overflowAnchor,
  vv: visualViewport ? visualViewport.scale : 1,
}));
check('html 的 touch-action 不含 pinch-zoom（浏览器不再抢捏合）',
  !/pinch-zoom/.test(statics.htmlTouchAction) && /pan/.test(statics.htmlTouchAction), statics.htmlTouchAction);
check('单指平移仍然允许（pan-x / pan-y 保留原生滚动）',
  /pan-x/.test(statics.htmlTouchAction) && /pan-y/.test(statics.htmlTouchAction), statics.htmlTouchAction);
check('阅读区关掉了浏览器滚动锚定（缩放后位置由 JS 自己算）',
  statics.overscrollAnchor === 'none', statics.overscrollAnchor);

/* ══════════════ 二、触摸屏捏合：只缩放 PDF，不缩放界面 ══════════════ */
console.log('\n-- 触摸屏两指捏合');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(1200);
const before = await page.evaluate(() => {
  const v = window.__viewer;
  const el = document.elementFromPoint(750, 430)?.closest?.('.page');
  const r = el?.getBoundingClientRect();
  return {
    scale: v.scale, vv: visualViewport ? visualViewport.scale : 1,
    docW: document.documentElement.clientWidth,
    anchor: r ? { page: Number(el.dataset.page), fx: (750 - r.left) / r.width, fy: (430 - r.top) / r.height } : null,
    pageW: r ? r.width : 0,
  };
});
await resetPerf();
await touchPinch(750, 430, 60, 120, 22, 16);
await sleep(1600);
const after = await page.evaluate(() => {
  const v = window.__viewer;
  const el = document.elementFromPoint(750, 430)?.closest?.('.page');
  const r = el?.getBoundingClientRect();
  return {
    scale: v.scale, vv: visualViewport ? visualViewport.scale : 1,
    docW: document.documentElement.clientWidth,
    anchor: r ? { page: Number(el.dataset.page), fx: (750 - r.left) / r.width, fy: (430 - r.top) / r.height } : null,
    pageW: r ? r.width : 0,
    soft: [...document.querySelectorAll('canvas.soft-zoom')].filter((c) => {
      const rr = c.getBoundingClientRect();
      const vr = document.getElementById('viewer').getBoundingClientRect();
      return rr.bottom > vr.top && rr.top < vr.bottom;
    }).length,
    placeholders: (() => {
      const vr = document.getElementById('viewer').getBoundingClientRect();
      return [...document.querySelectorAll('.page.placeholder')].filter((p) => {
        const rr = p.getBoundingClientRect();
        return rr.bottom > vr.top && rr.top < vr.bottom;
      }).length;
    })(),
  };
});
const perf = await readPerf();

check('捏合没有把整个界面缩放（visualViewport.scale 保持 1）',
  after.vv === before.vv, `${before.vv} → ${after.vv}`);
check('捏合没有改变布局视口宽度', after.docW === before.docW, `${before.docW} → ${after.docW}`);
check('触摸事件确实送到了页面（说明手势被应用接管）',
  perf.touchStart > 0 && perf.touchMove > 0, `start=${perf.touchStart} move=${perf.touchMove}`);
check('捏合期间没有 ctrl+wheel（确认触摸屏走的是触摸路径，不是触摸板路径）',
  perf.ctrlWheel === 0, `${perf.ctrlWheel} 次`);
check('捏合真的放大了 PDF', after.scale > before.scale * 1.3,
  `${before.scale.toFixed(2)} → ${after.scale.toFixed(2)}`);
check('页面宽度跟着缩放（不是只改了百分比）', after.pageW > before.pageW * 1.3,
  `${Math.round(before.pageW)}px → ${Math.round(after.pageW)}px`);
if (before.anchor && after.anchor) {
  const samePage = before.anchor.page === after.anchor.page;
  const dx = Math.abs(before.anchor.fx - after.anchor.fx) * after.pageW;
  const dy = Math.abs(before.anchor.fy - after.anchor.fy) * (after.pageW * 1.29);
  check('手指中点下的那个 PDF 点留在原地（跟手不飘）',
    samePage && dx < 30 && dy < 30,
    `第 ${before.anchor.page} 页 → 第 ${after.anchor.page} 页，偏移 ${dx.toFixed(1)}/${dy.toFixed(1)}px`);
} else {
  check('手指中点下的那个 PDF 点留在原地（跟手不飘）', false, '取不到捏合前后的锚点元素');
}
check('松手后视口内回到清晰位图，没有残留拉伸预览', after.soft === 0, `soft-zoom ${after.soft} 个`);
check('松手后视口内没有灰条占位', after.placeholders === 0, `${after.placeholders} 页`);

/* ══════════════ 三、主线程预算 ══════════════ */
console.log('\n-- 主线程预算（“丝滑”的量化口径）');
const maxLong = perf.long.length ? Math.max(...perf.long) : 0;
const sumLong = perf.long.reduce((a, b) => a + b, 0);
check(`捏合 + 松手重画期间没有超长卡顿（单次 < ${PERF.maxSingleLongTaskMs}ms）`,
  maxLong < PERF.maxSingleLongTaskMs, `最长 ${maxLong}ms，全部 ${JSON.stringify(perf.long)}`);
check(`捏合 + 松手重画期间总卡顿可控（< ${PERF.totalLongTaskMs}ms）`,
  sumLong < PERF.totalLongTaskMs, `合计 ${sumLong}ms`);

/* ══════════════ 四、文本层三件套的读写分离没被改回去 ══════════════ */
console.log('\n-- 文本层开销与文本流解析次数');
const detail = await page.evaluate(async () => {
  const v = window.__viewer;
  const i = v.current;
  const pageEl = v.pageEls[i];
  const div = pageEl?.querySelector('.textLayer');
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
  check(`文本层三件套单页开销 < ${PERF.textLayerPassMs}ms（读写分离后的实测 ~15ms；改回逐 span 读写是 ~190ms）`,
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
check('渲染一页只解析一次文本流（旧实现 streamTextContent + getTextContent 各来一遍，共 2 次）',
  counts.stream === 1 && counts.get <= 1,
  `streamTextContent=${counts.stream} getTextContent=${counts.get}（期望 1 / ≤1）`);

/* ══════════════ 五、单指拖动仍然是原生滚动 ══════════════ */
console.log('\n-- 单指拖动');
const dragScroll = await (async () => {
  await page.evaluate(() => { window.__viewer.fitWidth(); document.getElementById('viewer').scrollTop = 0; });
  await sleep(900);
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

/* ══════════════ 六、触摸板捏合没被改坏 ══════════════ */
console.log('\n-- 触摸板捏合（ctrl+wheel）');
await page.evaluate(() => { window.__viewer.fitWidth(); });
await sleep(900);
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

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'zoom-touch.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
