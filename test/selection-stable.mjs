/**
 * 选词稳定性验收 —— 用户反馈（2026-10-06）：
 *   「有时候不是按鼠标选中的区域，有时候一搞就选中一大块」。
 *
 *   BASE=http://127.0.0.1:8791 node test/selection-stable.mjs
 *
 * 这套断言全部用**真实鼠标事件**（page.mouse），裁判是「鼠标点/扫过的地方」：
 *   · 期望的字符范围由**独立的几何实现**算出来（逐字符 Range 外接框 + 最近字符），
 *     与被测代码不是同一套逻辑；
 *   · 选中方块还额外拿 **canvas 真实墨迹**做裁判（方块里必须真有字）。
 *
 * 覆盖：行内小拖选 / 拖到左右页边 / 跨行 / 行距缝隙 / 逆向拖 / 引用热点 [n] /
 *       双击选词 / 缩放后 / 程序化选区不被改写 / 引用卡片仍能打开。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const list = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0));
const first = list[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
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
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 60000 });

/* ══════════════════════ 页面侧工具（独立于被测代码） ══════════════════════ */
await page.evaluate(() => {
  const pageEl = (n) => document.querySelector(`.page[data-page="${n}"]`);
  window.__pg = pageEl;
  window.__pgRect = (n) => { const p = pageEl(n); if (!p) return null; const r = p.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };

  /** 逐字符外接框（DOM 顺序，**视口坐标**）。缓存到文本层节点换掉为止。 */
  window.__chars = (n) => {
    const el = pageEl(n);
    const layer = el?.querySelector('.textLayer') || null;
    if (window.__charsCache?.el === layer && layer) return window.__charsCache.data;
    if (!el) return [];
    const out = [];
    for (const span of el.querySelectorAll('.textLayer span:not(.markedContent)')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const text = node.textContent || '';
      const rg = document.createRange();
      for (let i = 0; i < text.length; i++) {
        rg.setStart(node, i); rg.setEnd(node, i + 1);
        const r = rg.getBoundingClientRect();
        if (!(r.width > 0 || r.height > 0)) continue;
        out.push({ i, ch: text[i], x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, node, off: i });
      }
    }
    window.__charsCache = { el: layer, data: out };
    return out;
  };

  /**
   * 独立实现：鼠标点 → 它所在的那个**连续文字段**（同一行、相邻字符水平间隙 < 30px）。
   * 为什么要按「段」而不是整行：论文里有双栏 / 作者栏，同一行可能有两个不相干的栏，
   * 按整行取字符会把另一栏的字也算进来。
   */
  window.__seg = (n, x, y) => {
    const chars = window.__chars(n).filter((c) => c.h > 0);
    const rows = [];
    for (const c of chars) {
      let row = rows.find((r) => Math.abs(r.cy - c.cy) < 6);
      if (!row) { row = { cy: c.cy, items: [] }; rows.push(row); }
      row.items.push(c);
    }
    if (!rows.length) return null;
    let row = rows[0];
    for (const r of rows) if (Math.abs(r.cy - y) < Math.abs(row.cy - y)) row = r;
    const items = row.items.slice().sort((a, b) => a.x - b.x);
    let ai = 0;
    let bd = Infinity;
    items.forEach((c, i) => {
      const d = x < c.x ? c.x - x : (x > c.x + c.w ? x - (c.x + c.w) : 0);
      if (d < bd) { bd = d; ai = i; }
    });
    const touching = (a, b) => (b.x - (a.x + a.w)) < 30;
    let lo = ai;
    while (lo > 0 && touching(items[lo - 1], items[lo])) lo--;
    let hi = ai;
    while (hi < items.length - 1 && touching(items[hi], items[hi + 1])) hi++;
    const seg = items.slice(lo, hi + 1);
    return { cy: row.cy, items: seg, nearest: items[ai], count: seg.length };
  };

  /**
   * 独立实现：两点之间**应该**被选中的文本。
   * 顺序按 DOM 顺序切（Range 的语义就是 DOM 顺序），两端各留 ±1 字符的容差留给调用方。
   */
  window.__expect = (n, x1, y1, x2, y2) => {
    const chars = window.__chars(n).filter((c) => c.h > 0);
    const s1 = window.__seg(n, x1, y1);
    const s2 = window.__seg(n, x2, y2);
    if (!s1 || !s2) return null;
    const i1 = chars.indexOf(s1.nearest);
    const i2 = chars.indexOf(s2.nearest);
    if (i1 < 0 || i2 < 0) return null;
    const lo = Math.min(i1, i2);
    const hi = Math.max(i1, i2);
    return {
      text: chars.slice(lo, hi + 1).map((c) => c.ch).join(''),
      sameRow: Math.abs(s1.cy - s2.cy) < 6,
      seg1: s1.items.length,
      seg2: s2.items.length,
      rowChars: Math.max(s1.count, s2.count) + s1.items.length + s2.items.length,
    };
  };

  /** 一行行墨迹 (canvas 暗像素)，坐标相对 .page */
  window.__ink = (n) => {
    const el = pageEl(n);
    const canvas = el?.querySelector('canvas');
    if (!canvas || !canvas.width) return null;
    const pr = el.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: cw, height: ch } = canvas;
    const img = ctx.getImageData(0, 0, cw, ch).data;
    const kx = cr.width / cw;
    const ky = cr.height / ch;
    const offX = cr.left - pr.left;
    const offY = cr.top - pr.top;
    const lines = [];
    let cur = null;
    for (let y = 0; y < ch; y++) {
      let dark = 0;
      for (let x = 0; x < cw; x += 2) { const i = (y * cw + x) * 4; if (img[i] < 150 || img[i + 1] < 150 || img[i + 2] < 150) dark++; }
      const on = dark / (cw / 2) > 0.004;
      if (on && !cur) cur = { y0: y, y1: y };
      else if (on) cur.y1 = y;
      else if (cur) { lines.push(cur); cur = null; }
    }
    if (cur) lines.push(cur);
    return {
      img, cw, ch, kx, ky, offX, offY,
      lines: lines.map((r) => ({ top: r.y0 * ky + offY, bottom: (r.y1 + 1) * ky + offY })).filter((r) => r.bottom - r.top >= 2),
      /** 矩形里有多少墨迹（比例） */
      inkRatio: (x, y, w, h) => {
        const x0 = Math.max(0, Math.round((x - offX) / kx));
        const x1 = Math.min(cw - 1, Math.round((x + w - offX) / kx));
        const y0 = Math.max(0, Math.round((y - offY) / ky));
        const y1 = Math.min(ch - 1, Math.round((y + h - offY) / ky));
        let dark = 0; let total = 0;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) { const i = (yy * cw + xx) * 4; total++; if (img[i] < 150 || img[i + 1] < 150 || img[i + 2] < 150) dark++; }
        }
        return total ? dark / total : 0;
      },
    };
  };

  /** caretRangeFromPoint 落在哪种节点上 */
  window.__caretKind = (x, y) => {
    const r = document.caretRangeFromPoint(Math.round(x), Math.round(y));
    if (!r) return 'null';
    const c = r.startContainer;
    if (c.nodeType === 3) return c.parentElement?.closest?.('.textLayer') ? 'TEXT' : 'TEXT-OUT';
    return `EL:${c.nodeName}${c.classList?.contains('textLayer') ? '.textLayer' : ''}@${r.startOffset}`;
  };

  window.__sel = () => {
    const s = window.getSelection();
    const text = s ? s.toString() : '';
    const state = window.__state.selection;
    const marks = [...document.querySelectorAll('.sel-mark')].map((m) => m.getBoundingClientRect());
    let rects = [];
    let ends = [];
    if (s && s.rangeCount) {
      const r = s.getRangeAt(0);
      rects = [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5).map((x) => ({ x: x.left, y: x.top, w: x.width, h: x.height }));
      const kind = (n) => (n.nodeType === 3 ? 'TEXT' : `EL:${n.nodeName}.${String(n.className || '').split(' ')[0]}`);
      ends = [kind(r.startContainer), kind(r.endContainer)];
    }
    return { text, len: text.replace(/\s/g, '').length, stateText: state ? state.cleanText : null, marks: marks.length, marksBox: marks, rects, ends };
  };
});

const gotoPage = async (n) => { await page.evaluate((k) => window.__viewer.goToPage(k), n); await sleep(2200); };
const reset = async () => { await page.evaluate(() => { window.getSelection().removeAllRanges(); window.__ctx.clearSelectionState(); }); await sleep(120); };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 要测的页：**按当前 PDF 的总页数现算**，不写死页码 ——
 * 这套件既要能跑用户的真实论文（15 页），也要能跑 `test/desktop.mjs` 的合成夹具（3 页）。
 */
const NUMPAGES = await page.evaluate(() => window.__viewer.numPages || 1);
const PAGES = [...new Set([1, 2, NUMPAGES])].filter((p) => p >= 1 && p <= NUMPAGES);
console.log(`这篇 PDF 共 ${NUMPAGES} 页，测试页：${PAGES.join(', ')}`);

/** 真实拖选（可选中途停留的步骤） */
async function drag(x1, y1, x2, y2, { steps = 10 } = {}) {
  await reset();
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2), { steps: Math.max(2, steps >> 1) });
  await page.mouse.move(x2, y2, { steps: Math.max(2, steps >> 1) });
  await page.mouse.up();
  await sleep(320);
  return page.evaluate(() => window.__sel());
}

/** 取视口里可用的几行（**视口坐标**，可直接喂给 page.mouse） */
const usableLines = (p, want = 4) => page.evaluate((n, cnt) => {
  const v = document.getElementById('viewer').getBoundingClientRect();
  const chars = window.__chars(n);
  const out = [];
  const seen = new Set();
  for (const c of chars) {
    if (!c.ch.trim()) continue;
    const key = Math.round(c.cy);
    if (seen.has(key)) continue;
    if (c.y < v.top + 80 || c.y + c.h > v.bottom - 120) continue;
    seen.add(key);
    const row = chars.filter((z) => Math.abs(z.cy - c.cy) < 6);
    if (row.length < 12) continue;
    /**
     * 必须是**连续的一段文字**：论文里同一视觉行可能有双栏、图注在左而正文在右，
     * 那种行的 left/right 横跨两个不相干的块，拿它当"一行文本"去拖选，
     * 期望值本身就说不清（实测最后一页的图注行就会这样）。
     * 判据：同一行内相邻字符的水平间隙都 < 40px。
     */
    const sorted = row.slice().sort((a, b) => a.x - b.x);
    let gapOk = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) > 40) { gapOk = false; break; }
    }
    if (!gapOk) continue;
    const left = Math.min(...row.map((z) => z.x));
    const right = Math.max(...row.map((z) => z.x + z.w));
    out.push({ cy: Math.round(c.cy), left: Math.round(left), right: Math.round(right), n: row.length });
    if (out.length >= cnt) break;
  }
  return out;
}, p, want);

/* ══════════════════════ 一、行距缝隙处拖选 ══════════════════════ */
console.log('\n-- 一、起手/终点落在行距缝隙里：不许变成"一大块"，也不许一个字都选不出来');
/**
 * 缝隙点在几何上是**歧义**的（算上面那行还是下面那行都合理），所以这里不比文本，
 * 只验用户真正在意的两条：① 选出来的量级正常（不超过两行 + 余量）② 两端都落在文字上。
 */
const seamPoints = (p, max = 4) => page.evaluate((n, cnt) => {
  const v = document.getElementById('viewer').getBoundingClientRect();
  const chars = window.__chars(n).filter((c) => c.h > 0);
  const rows = [];
  for (const c of chars) {
    if (!c.ch.trim()) continue;
    let row = rows.find((r) => Math.abs(r.cy - c.cy) < 6);
    if (!row) { row = { cy: c.cy, items: [] }; rows.push(row); }
    row.items.push(c);
  }
  rows.sort((a, b) => a.cy - b.cy);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const A = rows[i - 1];
    const B = rows[i];
    if (B.cy - A.cy > 34) continue;                       // 段落之间的大空白不算「缝隙」
    if (A.items.length < 12 || B.items.length < 12) continue;
    const aL = Math.min(...A.items.map((z) => z.x));
    const aR = Math.max(...A.items.map((z) => z.x + z.w));
    const bL = Math.min(...B.items.map((z) => z.x));
    const bR = Math.max(...B.items.map((z) => z.x + z.w));
    // 上下两行必须横向重叠（同一栏），否则「缝隙」跨栏没有意义
    if (Math.min(aR, bR) - Math.max(aL, bL) < 120) continue;
    const x = Math.round(Math.max(aL, bL) + (Math.min(aR, bR) - Math.max(aL, bL)) * 0.5);
    const y = Math.round((A.cy + B.cy) / 2);
    if (y < v.top + 80 || y > v.bottom - 90) continue;
    out.push({ x, y: Math.max(v.top + 60, Math.min(v.bottom - 60, y)), aboveCy: Math.round(A.cy), belowCy: Math.round(B.cy), left: Math.round(Math.max(aL, bL)), right: Math.round(Math.min(aR, bR)) });
    if (out.length >= cnt) break;
  }
  return out;
}, p, max);

for (const p of PAGES) {
  await gotoPage(p);
  const pts = await seamPoints(p, 4);
  let bad = 0;
  let containerEnds = 0;
  let n = 0;
  for (const q of pts) {
    const spanChars = await page.evaluate((n2, a, b) => {
      const s = window.__seg(n2, a, b);
      return s ? s.items.length : 0;
    }, p, q.x, q.aboveCy);
    const limit = Math.max(120, spanChars * 3);
    for (const [x1, y1, x2, y2, tag] of [
      [q.left + 30, q.aboveCy, q.x, q.y, '终点在缝隙'],
      [q.x, q.y, q.right - 30, q.belowCy, '起手在缝隙'],
    ]) {
      const got = await drag(x1, y1, x2, y2);
      n++;
      const ok = got.len > 0 && got.len <= limit && got.marks > 0;
      if (!ok) {
        bad++;
        if (bad <= 3) console.log(`        ${tag}：${got.len} 字（上限 ${limit}）· 方块 ${got.marks} · 「${norm(got.text).slice(0, 50)}」`);
      }
      if (got.ends.some((e) => e !== 'TEXT')) containerEnds++;
    }
  }
  check(`p${p} 缝隙处拖选量级正常（${n} 次）`, n === 0 || bad === 0,
    n === 0 ? '跳过：这一页没有"行距紧凑"的相邻两行（图页/文献表常见）' : `异常 ${bad}/${n}`);
  check(`p${p} 缝隙处选区两端都在文字上`, containerEnds === 0, `非文字端 ${containerEnds} 次`);
}

/* ══════════════════════ 二、真实拖选：选出来的就是鼠标扫过的 ══════════════════════ */
console.log('\n-- 二、真实拖选（期望值由独立几何实现算出）');
/* 注意：坐标是**视口坐标**，必须「算一页、立刻拖一页」——
   先把三页的坐标都算好再统一拖，等于拿着第 1 页的坐标去点第 11 页。 */
const squash = (s) => String(s || '').replace(/\s+/g, '');
for (const p of PAGES) {
  await gotoPage(p);
  const lines = await usableLines(p, 3);
  if (lines.length < 2) { check(`p${p} 有可测的正文行`, false, `只有 ${lines.length} 行`); continue; }
  const cases = [];
  for (let li = 0; li < Math.min(2, lines.length - 1); li++) {
    const L = lines[li];
    const y = L.cy;
    const xMid = Math.round(L.left + (L.right - L.left) * 0.35);
    cases.push(
      { name: `p${p} 行${li + 1} 行内拖 20px`, x1: xMid, y1: y, x2: xMid + 20, y2: y, max: 12 },
      { name: `p${p} 行${li + 1} 行中→行尾右侧空白`, x1: xMid, y1: y, x2: L.right + 60, y2: y, max: 120 },
      { name: `p${p} 行${li + 1} 行中→左页边空白`, x1: xMid, y1: y, x2: L.left - 80, y2: y, max: 120 },
      { name: `p${p} 行${li + 1} 逆向拖（右→左）`, x1: L.right - 20, y1: y, x2: L.left + 40, y2: y, max: 320 },
    );
    if (li === 0) {
      const L2 = lines[1];
      cases.push({
        name: `p${p} 跨两行拖选`,
        x1: xMid, y1: y,
        x2: Math.round(L2.left + (L2.right - L2.left) * 0.5),
        y2: L2.cy,
        max: 420,
      });
    }
  }
  for (const c of cases) {
    const expect = await page.evaluate((kk) => window.__expect(kk.p, kk.x1, kk.y1, kk.x2, kk.y2), { p, ...c });
    const got = await drag(c.x1, c.y1, c.x2, c.y2);
    const A = squash(got.text);
    const E = squash(expect?.text || '');
    const same = A.length > 0 && E.length > 0 && (E.includes(A) || A.includes(E));
    const slack = Math.abs(A.length - E.length) <= 8;
    const bounded = got.len <= c.max;
    const textEnds = got.ends.length === 2 && got.ends.every((e) => e === 'TEXT');
    const ok = same && slack && bounded && got.marks > 0 && textEnds;
    check(c.name, ok,
      `${got.len} 字（期望 ${E.length} 字，上限 ${c.max}）· 方块 ${got.marks} 块${ok ? '' : `\n       实得「${A.slice(0, 60)}」\n       期望「${E.slice(0, 60)}」\n       两端 ${got.ends.join('<')}`}`);
  }
}

/* ══════════════════════ 三、方块必须压在真实墨迹上 ══════════════════════ */
console.log('\n-- 三、选中方块压在 canvas 墨迹上');
{
  const p = 2;
  await gotoPage(p);
  const L = (await usableLines(p, 2))[0];
  await drag(Math.round(L.left + (L.right - L.left) * 0.3), L.cy, Math.round(L.left + (L.right - L.left) * 0.7), L.cy);
  const geo = await page.evaluate((n) => {
    const ink = window.__ink(n);
    const pr = window.__pgRect(n);
    const marks = [...document.querySelectorAll('.page[data-page="' + n + '"] .sel-mark')].map((m) => {
      const r = m.getBoundingClientRect();
      return { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height };
    });
    return {
      marks: marks.map((m) => ({ ...m, ratio: +ink.inkRatio(m.x, m.y, m.w, m.h).toFixed(4) })),
      maxH: marks.length ? Math.max(...marks.map((m) => m.h)) : 0,
      pageH: pr.h,
    };
  }, p);
  const empty = geo.marks.filter((m) => m.ratio < 0.004);
  check('每个选中方块里都真有墨迹（没有画到空白处）', geo.marks.length > 0 && empty.length === 0,
    `${geo.marks.length} 块，空块 ${empty.length}${empty.length ? '：' + JSON.stringify(empty.slice(0, 2)) : ''}`);
  check('没有横跨大半页的方块', geo.maxH < geo.pageH * 0.1, `最高 ${(geo.maxH / geo.pageH * 100).toFixed(1)}% 页高`);
}

/* ══════════════════════ 四、引用热点 [n] 不再吃鼠标 ══════════════════════ */
console.log('\n-- 四、正文引用热点 [n]');
/**
 * 找一个**有可见 [n] 热点**的页：逐页翻，最多找 12 页。
 * 不写死页码：合成夹具（`test/desktop.mjs` 用）可能压根没有引用热点，
 * 那种情况下这一节整体跳过，而不是报红 —— 断言要测的是"热点存在时的行为"。
 */
const citePage = await (async () => {
  for (let p = 1; p <= Math.min(NUMPAGES, 12); p++) {
    await gotoPage(p);
    const n = await page.evaluate((k) => {
      const pr = window.__pgRect(k);
      if (!pr) return 0;
      const v = document.getElementById('viewer').getBoundingClientRect();
      return [...document.querySelectorAll(`.page[data-page="${k}"] .cite-link`)].filter((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 1 && r.top > v.top + 20 && r.bottom < v.bottom - 20;
      }).length;
    }, p);
    if (n > 0) return p;
  }
  return 0;
})();
if (!citePage) {
  check('（跳过）这篇 PDF 没有可见的 [n] 引用热点', true, `翻了 ${Math.min(NUMPAGES, 12)} 页都没找到`);
} else {
  const cites = await page.evaluate((k) => {
    const v = document.getElementById('viewer').getBoundingClientRect();
    return [...document.querySelectorAll(`.page[data-page="${k}"] .cite-link`)].map((d) => {
      const r = d.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: d.title, visible: r.top > v.top + 20 && r.bottom < v.bottom - 20, w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((c) => c.visible);
  }, citePage);
  check(`p${citePage} 有可见的引用热点`, cites.length > 0, `${cites.length} 个`);
if (cites.length) {
  const c0 = cites[0];
  // 4.1 从 [n] 上按下往外拖：不能选出跨页的一大块
  const from = await drag(c0.x, c0.y, c0.x + 120, c0.y);
  check('从 [n] 上起手拖选不会选出跨页的一大块', from.len > 0 && from.len <= 60,
    `${from.len} 字 · 两端 ${from.ends.join('<')} 「${norm(from.text).slice(0, 40)}」`);
  check('从 [n] 起手拖选的锚点落在 [n] 附近的文字上', from.ends[0] === 'TEXT' && from.ends[1] === 'TEXT', from.ends.join('<'));

  // 4.2 终点落在 [n] 上
  const into = await drag(c0.x - 120, c0.y, c0.x, c0.y);
  check('终点落在 [n] 上也能正常选出一小段', into.len > 0 && into.len <= 60,
    `${into.len} 字 「${norm(into.text).slice(0, 40)}」`);

  // 4.3 双击 [n]：应该选中这几个字，而不是弹卡片跳走
  await reset();
  await page.mouse.click(c0.x, c0.y, { clickCount: 2, delay: 20 });
  await sleep(700);
  const dbl = await page.evaluate(() => ({ ...window.__sel(), citeOpen: !document.getElementById('citeBox').classList.contains('hidden') }));
  check('双击 [n] 选中这几个字（卡片不抢这次操作）',
    dbl.len > 0 && dbl.len <= 12 && dbl.citeOpen === false,
    `选中 ${dbl.len} 字「${norm(dbl.text)}」· 卡片开着=${dbl.citeOpen}`);

  // 4.4 悬停点亮（.cite-link 现在不吃鼠标事件，靠几何命中补回来）
  /* 注意顺序：**必须放在"单击 [n]"之前**。单击会 `jumpToPageWithHistory()` 跳到文末的
     参考文献页，之后再拿原来的坐标去悬停，指针下面已经不是那个热点了（实测假红）。
     另外要先把鼠标挪开再移上去：指针**已经**在热点上时浏览器不补发 mousemove。 */
  await reset();
  await page.mouse.move(c0.x, Math.max(60, c0.y - 80));
  await sleep(200);
  await page.mouse.move(c0.x, c0.y);
  await sleep(260);
  const hot = await page.evaluate(() => document.querySelectorAll('.cite-link.hot').length);
  await page.mouse.move(c0.x, c0.y - 60);
  await sleep(260);
  const hotAfter = await page.evaluate(() => document.querySelectorAll('.cite-link.hot').length);
  check('鼠标移上 [n] 会点亮、移开会熄灭', hot === 1 && hotAfter === 0, `移入 ${hot} 个 / 移开 ${hotAfter} 个`);

  // 4.5 单击 [n]：卡片照旧要能打开（功能不能被这次修改弄坏；这一下会跳到参考文献页）
  await reset();
  await page.mouse.click(c0.x, c0.y);
  await sleep(1600);
  const opened = await page.evaluate(() => ({
    open: !document.getElementById('citeBox').classList.contains('hidden'),
    text: document.getElementById('citeText')?.textContent || '',
  }));
  check('单击 [n] 仍然打开参考文献卡片', opened.open && opened.text.length > 20,
    `open=${opened.open} 文本 ${opened.text.length} 字`);
  await page.evaluate(() => document.getElementById('citeBox').classList.add('hidden'));
  }
}

/* ══════════════════════ 五、双击选词 ══════════════════════ */
console.log('\n-- 五、双击选词（词内部字符）');
for (const p of [...new Set([2, NUMPAGES])].filter((x) => x >= 1 && x <= NUMPAGES)) {
  await gotoPage(p);
  const pts = await page.evaluate((n) => {
    const el = window.__pg(n);
    const v = document.getElementById('viewer').getBoundingClientRect();
    const out = [];
    for (const span of el.querySelectorAll('.textLayer span:not(.markedContent)')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const text = node.textContent || '';
      const rg = document.createRange();
      // 取每个词的第 2~n-1 个字符（避开边界，浏览器对边界字符的词切分本来就模糊）
      for (const m of text.matchAll(/[A-Za-z]{5,}/g)) {
        const i = m.index + Math.floor(m[0].length / 2);
        rg.setStart(node, i); rg.setEnd(node, i + 1);
        const r = rg.getBoundingClientRect();
        if (r.top < v.top + 60 || r.bottom > v.bottom - 60) continue;
        out.push({ ch: text[i], word: m[0], x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        if (out.length >= 12) break;
      }
      if (out.length >= 12) break;
    }
    return out;
  }, p);
  let bad = 0;
  for (const q of pts) {
    await reset();
    await page.mouse.click(q.x, q.y, { clickCount: 2, delay: 20 });
    await sleep(220);
    const got = await page.evaluate(() => window.getSelection()?.toString() || '');
    const g = got.replace(/\s+/g, '');
    if (!g.includes(q.ch) || g.length > q.word.length + 4) {
      bad++;
      if (bad <= 2) console.log(`        偏差：点「${q.ch}」（词 ${q.word}）→ 选中「${g}」`);
    }
  }
  check(`p${p} 双击选词命中（${pts.length} 次）`, pts.length >= 6 && bad === 0, `偏差 ${bad}/${pts.length}`);
}

/* ══════════════════════ 六、程序化选区不被改写 ══════════════════════ */
console.log('\n-- 六、程序化构造的选区原样保留（修复不能越界）');
await gotoPage(1);
{
  const before = await page.evaluate(() => {
    const el = window.__pg(1);
    const pool = [...el.querySelectorAll('.textLayer span:not(.markedContent)')].filter((s) => (s.textContent || '').trim().length > 3);
    const range = document.createRange();
    range.setStart(pool[1].firstChild, 0);
    range.setEnd(pool[4].firstChild, pool[4].textContent.length);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const t = sel.toString();
    document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return t;
  });
  await sleep(500);
  const after = await page.evaluate(() => ({ text: window.getSelection()?.toString() || '', state: window.__state.selection?.cleanText || '' }));
  check('程序化选区没有被"修复"改掉', norm(after.text) === norm(before) && norm(after.state) === norm(before),
    `选中 ${norm(before).length} 字 → 仍是 ${norm(after.text).length} 字`);
}

/* ══════════════════════ 七、缩放后依然稳定 ══════════════════════ */
console.log('\n-- 七、放大后重新验证');
await gotoPage(2);
for (let i = 0; i < 3; i++) { await page.click('#footZoomIn'); await sleep(900); }
await sleep(1200);
{
  const scan = await page.evaluate(() => {
    const n = 2;
    const chars = window.__chars(n).filter((c) => c.h > 0);
    const v = document.getElementById('viewer').getBoundingClientRect();
    const rows = [];
    for (const c of chars) {
      if (!c.ch.trim()) continue;
      let row = rows.find((r) => Math.abs(r.cy - c.cy) < 6);
      if (!row) { row = { cy: c.cy, items: [] }; rows.push(row); }
      row.items.push(c);
    }
    rows.sort((a, b) => a.cy - b.cy);
    const probes = [];
    for (let i = 1; i < rows.length; i++) {
      const A = rows[i - 1];
      const B = rows[i];
      if (B.cy - A.cy > 60) continue;
      if (A.items.length < 8 || B.items.length < 8) continue;
      const aL = Math.min(...A.items.map((z) => z.x));
      const aR = Math.max(...A.items.map((z) => z.x + z.w));
      const bL = Math.min(...B.items.map((z) => z.x));
      const bR = Math.max(...B.items.map((z) => z.x + z.w));
      if (Math.min(aR, bR) - Math.max(aL, bL) < 100) continue;
      const x = Math.round(Math.max(aL, bL) + (Math.min(aR, bR) - Math.max(aL, bL)) * 0.5);
      const y = Math.round((A.cy + B.cy) / 2);
      if (y < v.top + 80 || y > v.bottom - 80) continue;
      probes.push({ x, y, aboveCy: Math.round(A.cy), belowCy: Math.round(B.cy), left: Math.round(Math.max(aL, bL)), right: Math.round(Math.min(aR, bR)), rowChars: A.items.length + B.items.length });
      if (probes.length >= 3) break;
    }
    return probes;
  });
  let bad = 0;
  let n = 0;
  for (const q of scan) {
    const limit = Math.max(150, q.rowChars * 3);
    for (const [x1, y1, x2, y2] of [[q.left + 20, q.aboveCy, q.x, q.y], [q.x, q.y, q.right - 20, q.belowCy]]) {
      const got = await drag(x1, y1, x2, y2);
      n++;
      if (!(got.len > 0 && got.len <= limit && got.ends.every((e) => e === 'TEXT'))) {
        bad++;
        if (bad <= 2) console.log(`        放大后缝隙拖选：${got.len} 字（上限 ${limit}）两端 ${got.ends.join('<')} 「${norm(got.text).slice(0, 40)}」`);
      }
    }
  }
  check('放大后缝隙处拖选量级仍然正常', n >= 4 && bad === 0, `${n} 次，异常 ${bad}`);

  const L = (await usableLines(2, 1))[0];
  if (L) {
    const y = L.cy;
    const got = await drag(Math.round(L.left + (L.right - L.left) * 0.3), y, L.right + 50, y);
    check('放大后拖到行尾空白仍只选这一行的一段', got.len > 0 && got.len <= 90, `${got.len} 字 · 方块 ${got.marks} 块`);
  }
  await page.evaluate(() => window.__viewer.fitWidth());
  await sleep(1200);
}

/* ══════════════════════ 汇总 ══════════════════════ */
check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'selection-stable.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
