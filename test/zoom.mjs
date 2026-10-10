/**
 * 缩放不能闪灰条。
 *
 *   BASE=http://127.0.0.1:8787 node test/zoom.mjs
 *
 * 背景：`.page.placeholder::after` 是一条灰色斜条纹。旧实现里 setScale / _renderVisible(true)
 * 每次都把所有页 _teardownPage() 掉，于是拖动缩放时那几条灰纹一直在闪（用户反馈）。
 * 现在改成双缓冲：旧位图先留着当预览，新的画好再换。
 *
 * 这里在**缩放过程中连续采样**，数「视口内有多少页处于 placeholder / 没有画布」。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

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
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(2200);

/** 开始连续采样：视口内的页里，有多少是 placeholder / 没有画布 */
const startWatch = () => page.evaluate(() => {
  window.__z = { samples: 0, greyFrames: 0, blankFrames: 0, maxGrey: 0, maxBlank: 0 };
  window.__zTimer = setInterval(() => {
    const vr = document.getElementById('viewer').getBoundingClientRect();
    let grey = 0;
    let blank = 0;
    for (const el of document.querySelectorAll('.page')) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= vr.top || r.top >= vr.bottom) continue;    // 不在视口里，不算
      if (el.classList.contains('placeholder')) grey++;
      if (!el.querySelector('canvas')) blank++;
    }
    const z = window.__z;
    z.samples++;
    if (grey) { z.greyFrames++; z.maxGrey = Math.max(z.maxGrey, grey); }
    if (blank) { z.blankFrames++; z.maxBlank = Math.max(z.maxBlank, blank); }
  }, 30);
});
const stopWatch = () => page.evaluate(() => {
  clearInterval(window.__zTimer);
  return window.__z;
});

/* ── 一、拖动缩放（模拟滑块连续 input） ── */
console.log('\n-- 拖动缩放');
await startWatch();
await page.evaluate(async () => {
  const v = window.__viewer;
  const base = v.scale;
  // 像拖滑块那样连续改比例：0.9→1.5 来回，每次隔一帧
  for (let i = 0; i <= 20; i++) {
    v.setScale(base * (0.9 + (0.6 * i) / 20));
    await new Promise((r) => setTimeout(r, 35));
  }
  for (let i = 20; i >= 0; i--) {
    v.setScale(base * (0.9 + (0.6 * i) / 20));
    await new Promise((r) => setTimeout(r, 35));
  }
});
const z1 = await stopWatch();
check('拖动缩放全程没有出现灰条（placeholder）', z1.greyFrames === 0,
  `${z1.samples} 次采样，灰条帧 ${z1.greyFrames}，最多 ${z1.maxGrey} 页`);
check('拖动缩放全程页面没有空白（画布一直在）', z1.blankFrames === 0,
  `空白帧 ${z1.blankFrames}，最多 ${z1.maxBlank} 页`);

/**
 * ⚠️ 这里**轮询等待**，不用固定 sleep（2026-10-09 第二次修正）。
 * 重画现在是「排队 + 一页一页让帧」的（为了「松手之后不顿一下」，见
 * pdfview.js 的 _runRerenderPass），代价是「全部变清晰」的总时间比以前并行开工更长：
 * 视口内两页要 2×~250ms，机器忙的时候单页能到 400~500ms。
 * 之前写死 2500ms，在同时开着 exe 的机器上偶发假红（实测 20/21）。
 * 改成「最多等 10 秒、每 150ms 看一次」，判据一点没放松（视口内必须一页不剩地清晰），
 * 只是不再把「机器多快」写进断言 —— 顺便把实际等了多久打出来当参考。
 */
const waitUntilCrisp = async (maxMs = 10000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    // eslint-disable-next-line no-await-in-loop
    last = await page.evaluate(() => {
      const vr = document.getElementById('viewer').getBoundingClientRect();
      let visibleGrey = 0;
      for (const el of document.querySelectorAll('.page.placeholder')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > vr.top && r.top < vr.bottom) visibleGrey++;
      }
      let visibleSoft = 0;
      let stuck = null;
      for (const c of document.querySelectorAll('canvas.soft-zoom')) {
        const r = c.getBoundingClientRect();
        if (r.bottom > vr.top && r.top < vr.bottom) {
          visibleSoft++;
          // 卡住的是哪一页、它 dirty 吗、渲染任务还在不在 —— 失败时要能一眼看出原因
          const pgEl = c.closest('.page');
          const n = Number(pgEl?.dataset.page);
          const e = window.__viewer.rendered.get(n);
          stuck = {
            page: n,
            dirty: !!e?.dirty,
            renderScale: e ? +e.renderScale.toFixed(3) : null,
            scale: +window.__viewer.scale.toFixed(3),
            tasks: [...window.__viewer.renderTasks.keys()],
            running: !!window.__viewer._rerenderRunning,
            wanted: !!window.__viewer._rerenderWanted,
            timer: !!window.__viewer._rerenderTimer,
            rendered: [...window.__viewer.rendered.keys()].sort((a, b) => a - b),
          };
        }
      }
      return {
        soft: visibleSoft,
        stuck,
        visibleGrey,
        offscreenGrey: document.querySelectorAll('.page.placeholder').length - visibleGrey,
        scale: window.__viewer.scale,
      };
    });
    if (last.soft === 0 && last.visibleGrey === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
  return { ...last, waited: Date.now() - t0 };
};
const afterDrag = await waitUntilCrisp();
check('手势停下后会重画成清晰版（视口内没有残留的拉伸预览）', afterDrag.soft === 0,
  `视口内 soft-zoom 画布 ${afterDrag.soft} 个（等了 ${afterDrag.waited}ms）`
  + (afterDrag.stuck ? ` 现场=${JSON.stringify(afterDrag.stuck)}` : ''));
check('停下后视口内没有 placeholder（离屏的属于正常）',
  afterDrag.visibleGrey === 0, `视口内 ${afterDrag.visibleGrey} 页，离屏 ${afterDrag.offscreenGrey} 页`);

/**
 * 上面两条只保证「视口里」是清晰的。队列外的已渲染页是留着拉伸预览 + dirty 的，
 * 所以这里补一条：把它滚进视口，必须自动重画成清晰版（而不是把糊的留在那）。
 */
const scrolled = await page.evaluate(async () => {
  const v = window.__viewer;
  v.goToPage(Math.min(2, v.numPages));
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const countSoft = () => [...document.querySelectorAll('canvas.soft-zoom')]
    .filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; }).length;
  // 同样轮询：给它最多 8 秒（滚动会触发一次重画，和上面同一套排队逻辑）
  const t0 = Date.now();
  let soft = countSoft();
  while (soft > 0 && Date.now() - t0 < 8000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
    soft = countSoft();
  }
  return { soft, page: v.current, waited: Date.now() - t0 };
});
check('把队列外的页滚进视口后会立刻重画成清晰版', scrolled.soft === 0,
  `第 ${scrolled.page} 页视口内 soft-zoom ${scrolled.soft} 个`);

/* ── 二、工具条按钮 / 键盘缩放 ── */
console.log('\n-- 按钮与快捷键缩放');
await startWatch();
/**
 * 2026-10：翻页与缩放整组从顶栏搬到了**底栏**，id 也随之改名
 * （`#zoomIn` → `#footZoomIn`，以此类推；用户口径：「底栏有的功能上面的一栏就不要了」）。
 * 这里改点底栏那几个按钮 —— 验的还是同一件事：点这些按钮不闪灰条、不出空白。
 */
for (const sel of ['#footZoomIn', '#footZoomIn', '#footZoomOut', '#footFitWidth', '#footZoomIn']) {
  // eslint-disable-next-line no-await-in-loop
  await page.click(sel);
  // eslint-disable-next-line no-await-in-loop
  await sleep(160);
}
const z2 = await stopWatch();
check('点缩放按钮 / 适应宽度都不闪灰条', z2.greyFrames === 0 && z2.blankFrames === 0,
  `灰条帧 ${z2.greyFrames}，空白帧 ${z2.blankFrames}`);

/**
 * 底栏那个缩放滑块走的是 `previewScale()` **不带指针坐标**这条分支
 * （见 app.js 的 `#zoomRange` input 监听）：锚点取阅读区中心，松手时 commit。
 * 2026-10-08 重写了锚点算法（原先每帧 elementFromPoint + 两次 getBoundingClientRect），
 * 这条分支没有别的覆盖，所以在这里补一段：拖滑块不许闪灰条、不许出空白、
 * 停下后要回到清晰位图，而且**阅读区中心那一页不许跳**。
 */
console.log('\n-- 拖底栏缩放滑块');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(700);
const centerPage = () => page.evaluate(() => {
  const vr = document.getElementById('viewer').getBoundingClientRect();
  const el = document.elementFromPoint(vr.left + vr.width / 2, vr.top + vr.height / 2)?.closest?.('.page');
  const r = el?.getBoundingClientRect();
  return r ? { page: Number(el.dataset.page), fx: (vr.left + vr.width / 2 - r.left) / r.width } : null;
});
const centerBefore = await centerPage();
await startWatch();
await page.evaluate(async () => {
  const range = document.getElementById('zoomRange');
  const target = Math.round(window.__viewer.scale * 1.35 * 100);
  const from = Number(range.value);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    range.value = String(Math.round(from + ((target - from) * i) / steps));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  range.dispatchEvent(new Event('change', { bubbles: true }));
});
const z2b = await stopWatch();
await sleep(1400);
const centerAfter = await centerPage();
check('拖缩放滑块全程不闪灰条、不出空白', z2b.greyFrames === 0 && z2b.blankFrames === 0,
  `灰条帧 ${z2b.greyFrames}，空白帧 ${z2b.blankFrames}`);
check('拖滑块放大后中心那一页没有跳走',
  !!centerBefore && !!centerAfter && centerBefore.page === centerAfter.page
    && Math.abs(centerBefore.fx - centerAfter.fx) < 0.08,
  centerBefore && centerAfter
    ? `第 ${centerBefore.page} 页 fx ${centerBefore.fx.toFixed(3)} → 第 ${centerAfter.page} 页 fx ${centerAfter.fx.toFixed(3)}`
    : '(取不到中心页)');
check('滑块停下后视口内回到清晰位图',
  await page.evaluate(() => {
    const vr = document.getElementById('viewer').getBoundingClientRect();
    return ![...document.querySelectorAll('canvas.soft-zoom')].some((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > vr.top && r.top < vr.bottom;
    });
  }), '视口内没有 soft-zoom');

/* ── 三、拖分栏条（改阅读区宽度 → 重新适配/重画） ── */
console.log('\n-- 拖分栏条');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(600);
const sp = await page.evaluate(() => {
  const r = document.getElementById('splitRight').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await startWatch();
await page.mouse.move(sp.x, sp.y);
await page.mouse.down();
for (let i = 0; i < 12; i++) {
  // eslint-disable-next-line no-await-in-loop
  await page.mouse.move(sp.x + i * 12, sp.y);
  // eslint-disable-next-line no-await-in-loop
  await sleep(45);
}
await page.mouse.up();
await sleep(900);
const z3 = await stopWatch();
check('拖分栏条改变阅读区宽度时也不闪灰条', z3.greyFrames === 0,
  `${z3.samples} 次采样，灰条帧 ${z3.greyFrames}，最多 ${z3.maxGrey} 页`);
check('拖分栏条时画面也没空白', z3.blankFrames === 0, `空白帧 ${z3.blankFrames}`);

/* ── 四、连续滚轮缩放 ── */
console.log('\n-- 滚轮缩放');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(500);
await startWatch();
await page.mouse.move(700, 400);
for (let i = 0; i < 10; i++) {
  // eslint-disable-next-line no-await-in-loop
  await page.mouse.wheel({ deltaY: i % 2 ? 120 : -120 });
  // eslint-disable-next-line no-await-in-loop
  await sleep(60);
}
const z4 = await stopWatch();
check('滚轮连续缩放也不闪灰条', z4.greyFrames === 0 && z4.blankFrames === 0,
  `灰条帧 ${z4.greyFrames}，空白帧 ${z4.blankFrames}`);

/* ── 五、缩放后画面仍然正确（别为了不闪把渲染搞坏了） ── */
await sleep(1400);
const sharp = await page.evaluate(() => {
  const v = window.__viewer;
  const canvas = document.querySelector('.page canvas');
  const pageEl = document.querySelector('.page');
  return {
    canvases: document.querySelectorAll('.page canvas').length,
    cssW: canvas ? Math.round(parseFloat(canvas.style.width)) : 0,
    pageW: pageEl ? Math.round(pageEl.getBoundingClientRect().width) : 0,
    containerW: document.getElementById('viewer').clientWidth,
  };
});
check('缩放结束后每页都有画布', sharp.canvases >= 1, `${sharp.canvases} 个`);
check('画布宽度和页面宽度一致（重画后没有拉伸错位）',
  Math.abs(sharp.cssW - sharp.pageW) <= 2, `画布 ${sharp.cssW} / 页面 ${sharp.pageW}`);
check('页面宽度仍然铺满阅读区（fitWidth 后）',
  Math.abs(sharp.pageW - (sharp.containerW - 32)) <= 3, `页宽 ${sharp.pageW} / 阅读区 ${sharp.containerW}`);

/* ── 六、缩放之后仍然能选文字 ── */
/**
 * 回归：双缓冲换帧时曾经给新画布设 z-index:2 想压住旧画布，
 * 但文本层没有 z-index（靠 DOM 顺序盖在画布上），结果画布盖住了文本层 ——
 * 鼠标点不到文字，选取直接失效。改成靠 DOM 顺序插在旧画布后面。
 */
console.log('\n-- 缩放后选文字');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(1400);
const probe = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const pool = [...document.querySelectorAll('.page .textLayer span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5)
    .filter((s) => { const r = s.getBoundingClientRect(); return r.top > vr.top + 20 && r.bottom < vr.bottom - 20; });
  const canvas = document.querySelector('.page canvas');
  const s0 = pool[0]?.getBoundingClientRect();
  const hit = s0 ? document.elementFromPoint(s0.left + 3, s0.top + s0.height / 2) : null;
  return {
    spans: pool.length,
    hitsText: !!(hit && hit.closest && hit.closest('.textLayer')),
    hitWhat: hit ? `${hit.tagName}.${hit.className || ''}` : '(无)',
    canvasZ: canvas ? getComputedStyle(canvas).zIndex : '(无画布)',
    first: s0 ? { x: Math.round(s0.left + 3), y: Math.round(s0.top + s0.height / 2) } : null,
    last: pool[3] ? { x: Math.round(pool[3].getBoundingClientRect().right - 3), y: Math.round(pool[3].getBoundingClientRect().top + pool[3].getBoundingClientRect().height / 2) } : null,
  };
});
check('缩放后文本层还在', probe.spans > 3, `${probe.spans} 个可见 span`);
check('鼠标能点到文本层（画布没有盖在上面）', probe.hitsText, `命中 ${probe.hitWhat}`);
check('画布没有残留 z-index', probe.canvasZ === 'auto' || probe.canvasZ === '0', probe.canvasZ);

if (probe.first && probe.last) {
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.mouse.move(probe.first.x, probe.first.y);
  await page.mouse.down();
  await page.mouse.move(probe.last.x, probe.last.y, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  const sel = await page.evaluate(() => ({
    text: (window.getSelection()?.toString() || '').trim(),
    bubble: !document.getElementById('bubble').classList.contains('hidden'),
    state: window.__state.selection?.cleanText || '',
  }));
  check('缩放后用鼠标能真的选出一段文字', sel.text.length > 3, JSON.stringify(sel.text.slice(0, 30)));
  check('选中后气泡正常弹出', sel.bubble && !!sel.state, sel.state.slice(0, 24));
}

/* ── 七、放大之后的清晰度：位图密度必须跟上屏幕 ──
   2026-10-10 用户口径：「怎么放大之后就不太清晰了」。
   根因不是渲染不动，而是**像素预算按整页算**：整页面积一大就把倍率压到 0.75，
   再交给切片逻辑 —— 切片明明放得下也继承了 0.75。实测（test/artifacts/sharpness.mjs）：
     dpr=1：scale 5/6 密度 0.75（浏览器放大位图 = 糊）
     dpr=2：fit 宽度 1.53、3.5× 1.0、5× 之后 0.75
   现在改成「先按 dpr 定画哪一块，再按这块的面积分配预算」。
   这里断言的就是那条不变量：**屏幕上一个 CSS 像素至少分到 0.9×min(dpr,2) 个位图像素**，
   另外位图不许超过 10 MP（曾经有一版离屏页回退成整页，一张 48 MP，浏览器直接卡死）。 */
console.log('\n-- 放大之后的清晰度（位图密度）');
const densityAt = (scale) => page.evaluate(async (s) => {
  const v = window.__viewer;
  v.setScale(s, { keepCenter: true });
  /* 等「清晰态」：视口里那一页不再 dirty、也没有 soft-zoom 拉伸标记。
     不等的话量到的是**上一版位图被拉伸中**的中间态（密度会算出 0.46 这种假数字），
     那不是"画得不清楚"，是"还没画完" —— 两种东西必须分开看。 */
  for (let t = 0; t < 60; t++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
    let pending = 0;
    for (const e of v.rendered.values()) {
      if (!e.canvas) continue;
      if (e.dirty || e.canvas.classList.contains('soft-zoom')) pending++;
    }
    if (!pending) break;
  }
  const vr = v.container.getBoundingClientRect();
  const rows = [];
  for (const [i, e] of v.rendered) {
    if (!e.canvas) continue;
    const r = e.canvas.getBoundingClientRect();
    // 只有**真在视口里**的位图才算（同一页的切片也只算露出来的那块）
    const ovW = Math.min(r.right, vr.right) - Math.max(r.left, vr.left);
    const ovH = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    if (ovW < 200 || ovH < 200) continue;
    const styleW = parseFloat(e.canvas.style.width) || 1;
    rows.push({
      i, ratio: +(e.ratio ?? 0).toFixed(3), slice: !!e.slice, dirty: !!e.dirty,
      density: +(e.canvas.width / styleW).toFixed(3),
      mp: +((e.canvas.width * e.canvas.height) / 1e6).toFixed(1),
    });
  }
  return { rows, dpr: window.devicePixelRatio, scale: +v.scale.toFixed(2) };
}, scale);

for (const dpr of [1, 2]) {
  await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: dpr });
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fileList li', { timeout: 20000 });
  await page.evaluate((id) => {
    const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
    li.click();
  }, first.docId);
  await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
  await sleep(2200);
  const seen = [];
  for (const s of [2.3, 3.5, 5]) {
    const r = await densityAt(s);
    seen.push(`${s}×:${r.rows.map((x) => x.density).join('/')}`);
    const worst = r.rows.length ? Math.min(...r.rows.map((x) => x.density)) : 0;
    const biggest = r.rows.length ? Math.max(...r.rows.map((x) => x.mp)) : 0;
    check(`dpr=${dpr} 放大到 ${s}× 时位图密度跟得上屏幕`,
      r.rows.length > 0 && worst >= 0.9 * dpr,
      `最差密度 ${worst}（要 ≥ ${(0.9 * dpr).toFixed(2)}），${r.rows.length} 页：${r.rows.map((x) => `${x.density}${x.slice ? '(切片)' : '(整页)'}`).join(' ')}`);
    check(`dpr=${dpr} ${s}× 时没有超大位图（一张不许超 10 MP）`,
      biggest > 0 && biggest <= 10, `最大 ${biggest} MP`);
  }
  console.log(`   dpr=${dpr} 密度一览 ${seen.join('  ')}`);
}

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'zoom.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
