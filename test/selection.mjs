/**
 * 选区行为验收 —— 用户反馈「选中文字在翻页或者有些地方有 bug」。
 *
 *   BASE=http://127.0.0.1:8787 node test/selection.mjs
 *
 * 覆盖：翻页前后、翻页按钮、松手位置、取消选择的三种方式、缩放后重新对齐、
 *       跨页选区、送出去的文本与选中的文本是否一致。
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
await page.setRequestInterception(true);
let chatBodies = [];
page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    chatBodies.push(JSON.parse(req.postData() || '{}'));
    const sse = ['假的译文。'].flatMap((t) => t.match(/[\s\S]{1,8}/g) || [])
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  return req.continue();
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1800);

/* ── 工具 ── */
const selectIn = (pageNum, from, to) => page.evaluate(async (p, f, t) => {
  const v = document.getElementById('viewer');
  const pageEl = document.querySelector(`.page[data-page="${p}"]`);
  if (!pageEl) return { ok: false, why: 'no page' };
  if (pageEl.getBoundingClientRect().top < v.getBoundingClientRect().top || pageEl.getBoundingClientRect().bottom > v.getBoundingClientRect().bottom) {
    await window.__viewer.goToPage(p);
    await new Promise((r) => setTimeout(r, 900));
  }
  const pool = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5);
  if (pool.length < t + 1) return { ok: false, why: `only ${pool.length} spans` };
  const range = document.createRange();
  range.setStart(pool[f].firstChild, 0);
  range.setEnd(pool[t].firstChild, pool[t].textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  v.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { ok: true, text: sel.toString() };
}, pageNum, from, to);

const st = () => page.evaluate(() => ({
  page: window.__viewer.current,
  selMarks: document.querySelectorAll('.sel-mark').length,
  marksByPage: (() => {
    const out = {};
    for (const [i, e] of window.__viewer.rendered) out[i] = e.hlLayer.querySelectorAll('.sel-mark').length;
    return out;
  })(),
  bubble: !document.getElementById('bubble').classList.contains('hidden'),
  stateSel: window.__state.selection ? window.__state.selection.cleanText.slice(0, 30) : null,
  live: (window.getSelection()?.toString() || '').slice(0, 30),
}));

/* ═══════════ 一、基础划选 ═══════════ */
console.log('\n-- 基础划选');
const s1 = await selectIn(1, 1, 5);
await sleep(500);
check('能选中正文文字', s1.ok, s1.ok ? s1.text.slice(0, 30) : s1.why);
const a1 = await st();
check('出现气泡', a1.bubble === true);
check('页面上画出了选中方块', a1.selMarks > 0, `${a1.selMarks} 块`);
check('state.selection 记录了选区', !!a1.stateSel, a1.stateSel || '');

/**
 * 方块几何：必须「一行一个、互不重叠」。
 * 半透明的方块一重叠就会一块深一块浅、密的地方糊成一大片蓝，
 * 这正是用户反馈的「整页整块变蓝 / 有的浅蓝有的深蓝」。
 */
const geometry = () => page.evaluate(() => {
  const pageEl = document.querySelector('.page[data-page="1"]');
  if (!pageEl) return null;
  const pr = pageEl.getBoundingClientRect();
  const marks = [...pageEl.querySelectorAll('.sel-mark')].map((m) => {
    const r = m.getBoundingClientRect();
    return { x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height };
  });
  let overlaps = 0;
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i];
      const b = marks[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.002 && oy > 0.002) overlaps++;
    }
  }
  return {
    count: marks.length,
    overlaps,
    maxH: marks.length ? Math.max(...marks.map((m) => m.h)) : 0,
    covered: +marks.reduce((s, m) => s + m.w * m.h, 0).toFixed(3),
  };
});

const g1 = await geometry();
check('选中方块互不重叠（深浅不一就是这么来的）', g1.overlaps === 0, `${g1.count} 块，重叠 ${g1.overlaps} 对`);
check('方块数量按「行」而不是按 span 碎片', g1.count <= 8, `5 个 span → ${g1.count} 块`);
check('没有横跨大半页的方块', g1.maxH < 0.25, `最高一块占页高 ${(g1.maxH * 100).toFixed(1)}%`);

const fidelity = await page.evaluate(() => {
  const live = window.getSelection().toString();
  const clean = window.__state.selection?.cleanText || '';
  // cleanText 会把换行折成空格，比较时把空白都归一化
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  return { same: norm(live) === norm(clean), live: norm(live).slice(0, 40), clean: norm(clean).slice(0, 40) };
});
check('送去处理的文字和实际选中的完全一致（没有错位/丢字）', fidelity.same,
  fidelity.same ? '' : `选中「${fidelity.live}」 vs 记录「${fidelity.clean}」`);

/* ═══════════ 二、翻页 ═══════════ */
console.log('\n-- 翻页');
const keptText = a1.stateSel;
await page.evaluate(() => window.__viewer.goToPage(10));
await sleep(1800);
const p10 = await st();
check('翻页后气泡收起（不会悬在无关文字上）', p10.bubble === false, `page=${p10.page}`);
check('翻页后仍记得选的是哪一段', p10.stateSel === keptText, `${p10.stateSel}`);

await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1800);
const back = await st();
check('翻回来时选中方块被重新画出来（不会凭空消失）', back.selMarks > 0, `${back.selMarks} 块 · ${JSON.stringify(back.marksByPage)}`);

// 用工具条按钮翻页：这是真实点击，但**不该**把选区弄没 ——
// 选区会记着，翻回来还能看到方块（原生阅读器就是这个行为）
// 2026-10：翻页按钮从顶栏搬到底栏，id 由 `#nextPage` 改成 `#footNextPage`。
await page.click('#footNextPage');
await sleep(1500);
const viaBtn = await st();
check('点工具条翻页按钮不会把选区弄没', viaBtn.stateSel === keptText, `state=${viaBtn.stateSel}`);
check('翻页后气泡收起', viaBtn.bubble === false);
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1600);
const backAgain = await st();
check('用按钮翻走再翻回来，方块还在', backAgain.selMarks > 0, `${backAgain.selMarks} 块`);

/* ═══════════ 三、松手位置 ═══════════ */
console.log('\n-- 松手位置');
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1200);
// 3.1 松手在右侧面板上
const pts = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const s = [...document.querySelectorAll('.page[data-page="1"] .textLayer span:not(.markedContent)')]
    .filter((x) => (x.textContent || '').trim().length > 3 && x.getBoundingClientRect().width > 0.5)
    .find((x) => { const r = x.getBoundingClientRect(); return r.top > vr.top + 20 && r.bottom < vr.bottom - 20; });
  const r = s.getBoundingClientRect();
  return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2), outX: Math.round(vr.right + 260), outY: Math.round(vr.top + vr.height / 2) };
});
await page.evaluate(() => window.getSelection().removeAllRanges());
await page.evaluate(() => window.__ctx.clearSelectionState());
await sleep(200);
await page.mouse.move(pts.x, pts.y);
await page.mouse.down();
await page.mouse.move(pts.x + 240, pts.y + 30, { steps: 5 });
await page.mouse.move(pts.outX, pts.outY, { steps: 5 });   // 拖到右侧面板
await page.mouse.up();
await sleep(700);
const outside = await st();
check('拖到正文区外松手，气泡照样弹出来', outside.bubble === true && !!outside.stateSel,
  `bubble=${outside.bubble} sel=${outside.stateSel}`);

/* ═══════════ 四、取消选择的三种方式 ═══════════ */
console.log('\n-- 取消选择');
const before = await st();
check('（前置）此刻有选区', before.stateSel !== null && before.selMarks > 0);

// 4.1 Esc
await page.keyboard.press('Escape');
await sleep(400);
const esc = await st();
check('按 Esc 清掉选区与方块', esc.stateSel === null && esc.selMarks === 0 && esc.bubble === false,
  `state=${esc.stateSel} marks=${esc.selMarks}`);

// 4.2 单击正文别处
await selectIn(1, 2, 5);
await sleep(500);
check('（前置）重新选中', (await st()).stateSel !== null);
const blank = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const p = document.querySelector('.page[data-page="1"]');
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.right + 30), y: Math.round(r.top + 200) };   // 页面右侧的灰色空白
});
await page.mouse.click(blank.x, blank.y);
await sleep(500);
const clicked = await st();
check('在正文空白处单击会清掉选区', clicked.stateSel === null && clicked.selMarks === 0,
  `state=${clicked.stateSel} marks=${clicked.selMarks}`);

// 4.3 点右侧问答区
await selectIn(1, 2, 5);
await sleep(500);
await page.mouse.click(1390, 120);   // 右侧面板
await sleep(500);
const panel = await st();
check('点右侧问答区也会清掉选区', panel.stateSel === null && panel.selMarks === 0,
  `state=${panel.stateSel} marks=${panel.selMarks}`);

/* ═══════════ 五、缩放后重新对齐 ═══════════ */
console.log('\n-- 缩放后重新对齐');
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1200);
await selectIn(1, 1, 4);
await sleep(500);
const alignBefore = await page.evaluate(() => window.__ctx.alignProbe());
// 2026-10：缩放按钮搬到底栏，id 由 `#zoomIn` 改成 `#footZoomIn`。
await page.click('#footZoomIn');
await sleep(1600);
const alignAfter = await page.evaluate(() => window.__ctx.alignProbe());
check('缩放后方块仍然跟着选中的文字（没有跑位）',
  alignAfter.ratio >= 0.75 && alignAfter.marks > 0,
  `命中 ${alignAfter.hit}/${alignAfter.total}（缩放前 ${alignBefore.hit}/${alignBefore.total}）· ${alignAfter.marks} 块`);

/* ═══════════ 六、跨页选区 ═══════════ */
console.log('\n-- 跨页选区');
await page.evaluate(() => window.__viewer.fitWidth());
await sleep(1000);
const cross = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  v.scrollTop = 0;
  const p1 = document.querySelector('.page[data-page="1"]');
  const p2 = document.querySelector('.page[data-page="2"]');
  if (!p1 || !p2) return { ok: false, why: 'page missing' };
  const pool = (el) => [...el.querySelectorAll('.textLayer span:not(.markedContent)')]
    .filter((s) => (s.textContent || '').trim().length > 3 && s.getBoundingClientRect().width > 0.5);
  const a = pool(p1).pop();       // 第 1 页最后一段
  const b = pool(p2)[0];          // 第 2 页第一段
  if (!a || !b) return { ok: false, why: 'spans missing' };
  const range = document.createRange();
  range.setStart(a.firstChild, 0);
  range.setEnd(b.firstChild, Math.min(20, b.textContent.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  v.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { ok: true };
});
await sleep(800);
check('能构造跨页选区', cross.ok, cross.ok ? '' : cross.why);
if (cross.ok) {
  const info = await page.evaluate(() => {
    const s = window.__state.selection;
    return { pages: s?.pages || [], page: s?.page, endPage: s?.endPage, byPage: Object.keys(s?.rectsByPage || {}) };
  });
  check('跨页选区记录了两页', info.pages.length >= 2 || info.byPage.length >= 2, JSON.stringify(info));
  const marks2 = await page.evaluate(() => Object.fromEntries([...window.__viewer.rendered].map(([i, e]) => [i, e.hlLayer.querySelectorAll('.sel-mark').length])));
  const pagesWithMarks = Object.entries(marks2).filter(([, n]) => n > 0).map(([i]) => Number(i));
  check('两页上都画出了方块', pagesWithMarks.length >= 2, JSON.stringify(marks2));
}

/* ═══════════ 七、整页选区的方块形态 ═══════════ */
console.log('\n-- 整页选区');
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1600);
await page.evaluate(() => {
  const pageEl = document.querySelector('.page[data-page="1"]');
  const pool = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')].filter((s) => s.textContent.trim().length > 3);
  const range = document.createRange();
  range.setStart(pool[0].firstChild, 0);
  range.setEnd(pool[pool.length - 1].firstChild, pool[pool.length - 1].textContent.length);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await sleep(800);
const gAll = await geometry();
check('整页选中时方块仍然互不重叠（不会糊成一块深蓝）', gAll.overlaps === 0, `${gAll.count} 块，重叠 ${gAll.overlaps} 对`);
check('整页选中时没有半页大的方块', gAll.maxH < 0.25, `最高一块占页高 ${(gAll.maxH * 100).toFixed(1)}%`);
check('整页选中时只覆盖正文行、不覆盖整页',
  gAll.covered < 0.55 && gAll.count > 10,
  `覆盖 ${(gAll.covered * 100).toFixed(1)}% 页面积 · ${gAll.count} 块`);

/* ═══════════ 八、送给模型的文本 ═══════════ */
console.log('\n-- 送给模型的文本');
await page.evaluate(() => window.__viewer.goToPage(1));
await sleep(1200);
await page.evaluate(() => window.getSelection().removeAllRanges());
await page.evaluate(() => window.__ctx.clearSelectionState());
const s7 = await selectIn(1, 1, 5);
await sleep(500);
const expectText = await page.evaluate(() => window.__state.selection.cleanText);
chatBodies = [];
await page.evaluate(() => document.querySelector('#bubble button[data-act="translate"]').click());
await sleep(2500);
const sentMsg = chatBodies.length ? JSON.stringify(chatBodies[0].messages) : '';
check('翻译请求里带的就是刚才选的那段', chatBodies.length === 1 && sentMsg.includes(expectText.slice(0, 40)),
  chatBodies.length ? `选中「${expectText.slice(0, 32)}」` : '(没发出请求)');

/* ═══════════ 汇总 ═══════════ */
check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'selection.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
