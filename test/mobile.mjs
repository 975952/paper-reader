// 手机版阅读器回归套件。
//
//   cd test && node mobile.mjs
//
// 用户口径（2026-10-03，原话）：
//   「阅读的时候要只显示 pdf 本身。pdf 字体如果能放大就很好，图片的大小不变。
//     或者说图片长按可以单独放大查看。然后也是长按选词。然后界面就不要做伸缩了，
//     字体在设置调节。手机版的。」
//
// 判定的是可量的东西，不是观感：
//   M1  打开 PDF：页数 / 文本层 / canvas 都正常
//   M2  只显示 PDF：阅读区铺满整屏，顶栏与底栏都是 fixed 浮层、不占布局高度
//   M3  界面不做伸缩：320 / 390 / 430 三种宽度都铺满、无横向滚动、页面不溢出
//   M4  字号只改文字：调到 150% 后 span 字号变大，而 canvas 像素尺寸一个像素不变
//       （图片是画在 canvas 上的，canvas 不变 = 图片尺寸不变）
//   M5  字号持久化
//   M6  长按选词：长按正文选中的是一个词，不是一整行/一整块
//   M7  长按图片区域 -> 全屏查看器（纯文字页不误触发；带图页能触发）
//   M8  顶栏：默认收起、点一下出现、滚动自动收起
//   M9  页面底色 / 阅读区底色可切换且真的生效
//   M10 file:// 下也能加载并打开本地 PDF（APK 就是这么加载的）
//   M11 零 JS 报错
//
// 写入纪律：本文件曾被 PowerShell 的 Set-Content 写坏过两次（UTF-8 被按 ANSI 读、
// 中文变乱码且部分字节不可逆丢失），最后只能整体重写。改这个文件请只用编辑工具，
// 千万不要用 Set-Content / Out-File / > 写它。
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 仓库根目录：不再写死本机路径 —— 换台电脑 clone 下来也能直接跑
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8927;
const BASE = 'http://127.0.0.1:' + PORT;
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
const IMAGE_PDF = path.join(ROOT, 'test', 'fixtures', 'image-sample.pdf');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
// 三种手机宽度：很小的屏 / 主流 / 大屏
const PHONES = [[320, 640, 2], [390, 844, 3], [430, 932, 3]];
const MAIN = [390, 844, 3];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let currentSection = '';
function section(t) { currentSection = t; console.log('\n---- ' + t + ' ----'); }
function check(name, ok, actual = '') {
  let pass = false;
  try { pass = ok === true; } catch { pass = false; }
  results.push({ section: currentSection, name, ok: pass, actual: String(actual) });
  console.log((pass ? '[OK] ' : '[XX] ') + name + (actual ? '  -- ' + actual : ''));
}
const fmt = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };

fs.mkdirSync(path.join(ROOT, 'test', 'artifacts', 'ug-mobile'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-mobile-'));
const DATA = path.join(tmp, 'data');
const PAPERS = path.join(tmp, 'papers');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(FIXTURE_PDF, path.join(PAPERS, 'mobile-sample.pdf'));

const REAL_CONFIG = path.join(ROOT, 'data', 'config.json');
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(读不到)'; } };
const REAL_CONFIG_BEFORE = sha(REAL_CONFIG);
const browserPath = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

console.log('==========================================================');
console.log('手机版：只显示 PDF / 字号只改文字 / 长按选词 / 长按看图 / 不做伸缩');
console.log('时间    : ' + new Date().toLocaleString('zh-CN'));
console.log('浏览器  : ' + (browserPath || '(没找到)'));
console.log('==========================================================');

let server = null;
let browser = null;
const pageErrors = [];

async function openMobile(br, url, size) {
  const p = await br.newPage();
  p.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e && e.message).slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text().slice(0, 160)); });
  await p.emulate({
    viewport: { width: size[0], height: size[1], isMobile: true, hasTouch: true, deviceScaleFactor: size[2] },
    userAgent: PHONE_UA,
  });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__viewer, { timeout: 25000 });
  try { await p.waitForFunction(() => window.__viewer && window.__viewer.pdf, { timeout: 45000 }); } catch { /* 由断言报出 */ }
  await sleep(2200);
  return p;
}

try {
  if (!browserPath) throw new Error('找不到 Edge / Chrome');
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1' },
  });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) throw new Error('隔离服务没起来');
  await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-m-fake', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  });

  browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    userDataDir: path.join(tmp, 'profile'),
    // APK 里页面是 file://，ES module / worker 需要放行同源文件读取；这里用同样的开关预演
    args: ['--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files'],
  });

  // ============ M1 / M2 ============
  section('M1-M2 打开 PDF，并且阅读时只有 PDF 本身');
  const main = await openMobile(browser, BASE + '/mobile/?open=mobile-sample.pdf', MAIN);
  const m1 = await main.evaluate(() => {
    const v = document.getElementById('mViewer').getBoundingClientRect();
    const bar = document.getElementById('mTopbar').getBoundingClientRect();
    const foot = document.getElementById('mFooter').getBoundingClientRect();
    return {
      pdf: !!(window.__viewer && window.__viewer.pdf),
      numPages: window.__viewer ? window.__viewer.numPages : 0,
      pages: document.querySelectorAll('.page').length,
      spans: document.querySelectorAll('.textLayer span').length,
      canvas: !!document.querySelector('.page canvas'),
      viewerTop: Math.round(v.top),
      viewerH: Math.round(v.height),
      winH: window.innerHeight,
      barFixed: getComputedStyle(document.getElementById('mTopbar')).position,
      barH: Math.round(bar.height),
      footFixed: getComputedStyle(document.getElementById('mFooter')).position,
      footBottom: Math.round(foot.bottom),
      extraInViewer: [...document.querySelectorAll('.m-viewer > *')]
        .map((n) => String(n.className || n.tagName))
        .filter((c) => !/^m-welcome|^pages|^page/.test(c)),
      hasDesktopChrome: !!document.querySelector('.side, .topbar, .statusbar, .rail'),
    };
  });
  check('M1 打开 PDF：页数 / 文本层 / canvas 都正常',
    m1.pdf && m1.numPages > 1 && m1.pages === m1.numPages && m1.spans > 20 && m1.canvas,
    '页数=' + m1.numPages + ' .page=' + m1.pages + ' span=' + m1.spans + ' canvas=' + m1.canvas);
  check('M2a 阅读区铺满整屏（上沿 = 0、高度 = 视口高）',
    m1.viewerTop === 0 && m1.viewerH === m1.winH, 'viewer=' + m1.viewerTop + '+' + m1.viewerH + ' 视口=' + m1.winH);
  check('M2b 顶栏 / 底栏都是 fixed 浮层，不占布局高度',
    m1.barFixed === 'fixed' && m1.footFixed === 'fixed', 'bar=' + m1.barFixed + ' foot=' + m1.footFixed);
  check('M2c 底栏压在屏幕底边（不悬空、不溢出）',
    Math.abs(m1.footBottom - m1.winH) <= 1, 'footBottom=' + m1.footBottom + ' 视口=' + m1.winH);
  check('M2d 阅读区里没有桌面版的侧栏 / 状态栏 / 顶栏',
    !m1.hasDesktopChrome && m1.extraInViewer.length === 0,
    'desktopChrome=' + m1.hasDesktopChrome + ' extra=' + fmt(m1.extraInViewer));

  // ============ M4 ============
  section('M4 字号只放大文字，canvas 位图一个像素都不变（= 图片尺寸不变）');
  const m4 = await main.evaluate(async () => {
    const canvas = document.querySelector('.page canvas');
    const span = document.querySelector('.page .textLayer span:not(.markedContent)');
    const before = { canvasW: canvas.width, canvasH: canvas.height, font: parseFloat(getComputedStyle(span).fontSize) };
    const fsEl = document.getElementById('mFontScale');
    fsEl.value = '150';
    fsEl.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const c2 = document.querySelector('.page canvas');
    const s2 = document.querySelector('.page .textLayer span:not(.markedContent)');
    return {
      before: before,
      after: { canvasW: c2.width, canvasH: c2.height, font: parseFloat(getComputedStyle(s2).fontSize) },
      boost: getComputedStyle(document.documentElement).getPropertyValue('--m-text-boost').trim(),
      label: document.getElementById('mFsVal').textContent,
    };
  });
  check('M4a 设置 150% 后文字字号真的变大了',
    m4.after.font > m4.before.font * 1.2,
    m4.before.font + 'px -> ' + m4.after.font + 'px（boost=' + m4.boost + ', 标签=' + m4.label + '）');
  check('M4b canvas 的像素尺寸完全没变（图片 / 表格 / 公式尺寸不变）',
    m4.after.canvasW === m4.before.canvasW && m4.after.canvasH === m4.before.canvasH,
    'canvas ' + m4.before.canvasW + 'x' + m4.before.canvasH + ' -> ' + m4.after.canvasW + 'x' + m4.after.canvasH);

  section('M5 字号持久化');
  await main.reload({ waitUntil: 'domcontentloaded' });
  await main.waitForFunction(() => !!window.__viewer, { timeout: 25000 });
  await sleep(1600);
  const m5 = await main.evaluate(() => ({
    boost: getComputedStyle(document.documentElement).getPropertyValue('--m-text-boost').trim(),
    slider: document.getElementById('mFontScale').value,
  }));
  check('M5 刷新后仍是 150%', m5.boost === '1.5' && m5.slider === '150', fmt(m5));

  // ============ M6 ============
  section('M6 长按选词：选中的是一个词，不是一整块');
  const m6 = await main.evaluate(async () => {
    const spans = [...document.querySelectorAll('.page[data-page="1"] .textLayer span:not(.markedContent)')]
      .filter((s) => (s.textContent || '').trim().length >= 4 && s.getBoundingClientRect().width > 4);
    if (!spans.length) return { ok: false, why: '没有可用的文本 span' };
    const span = spans[Math.floor(spans.length / 2)];
    const r = span.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const v = document.getElementById('mViewer');
    const mk = (type) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
    });
    v.dispatchEvent(mk('pointerdown'));
    await new Promise((res) => setTimeout(res, 620));
    v.dispatchEvent(mk('pointerup'));
    await new Promise((res) => setTimeout(res, 250));
    const sel = window.getSelection();
    return {
      ok: true,
      text: sel ? sel.toString() : '',
      sheetOpen: !document.getElementById('mSelectSheet').classList.contains('hidden'),
      sheetText: document.getElementById('mSelQuote').textContent,
      spanText: span.textContent,
      spanLen: (span.textContent || '').length,
    };
  });
  check('M6a 长按后弹出操作条', m6.ok === true && m6.sheetOpen === true, fmt({ ok: m6.ok, sheetOpen: m6.sheetOpen, why: m6.why }));
  check('M6b 选中的是一个词，不是整行/整块',
    m6.ok === true && m6.text.length > 0 && m6.text.length <= 8 && m6.text.length < m6.spanLen,
    '选中="' + m6.text + '"（' + m6.text.length + ' 字）· 所在 span 共 ' + m6.spanLen + ' 字 · 全文="' + String(m6.spanText || '').slice(0, 24) + '"');
  check('M6c 操作条里显示了选中的文字',
    m6.ok === true && m6.sheetText === m6.text, 'sheet="' + m6.sheetText + '" sel="' + m6.text + '"');

  // ============ M7a 纯文字页不误触发 ============
  section('M7a 纯文字页：长按不会被误判成图片');
  const m7a = await main.evaluate(async () => {
    document.getElementById('mSelectSheet').classList.add('hidden');
    if (window.getSelection()) window.getSelection().removeAllRanges();
    await new Promise((r) => setTimeout(r, 150));
    const pageEl = document.querySelector('.page[data-page="1"]');
    const pr = pageEl.getBoundingClientRect();
    const v = document.getElementById('mViewer');
    const longPress = async (x, y, id) => {
      const mk = (type) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
      });
      v.dispatchEvent(mk('pointerdown'));
      await new Promise((r) => setTimeout(r, 620));
      v.dispatchEvent(mk('pointerup'));
      await new Promise((r) => setTimeout(r, 500));
      return !!document.querySelector('.m-imgview');
    };
    let id = 20;
    const hits = [];
    for (const [fx, fy] of [[0.5, 0.15], [0.2, 0.3], [0.8, 0.6], [0.5, 0.5], [0.5, 0.8]]) {
      id += 1;
      const opened = await longPress(Math.round(pr.left + pr.width * fx), Math.round(pr.top + pr.height * fy), id);
      hits.push({ fx: fx, fy: fy, opened: opened });
      if (opened) return { opened: true, hits: hits };
    }
    return { opened: false, hits: hits };
  });
  check('M7a 纯文字页上长按不开图（文字优先走选词）',
    m7a.opened === false, '试了 ' + m7a.hits.length + ' 个位置都没开图 = 正确');

  // ============ M7b 带图页能触发 ============
  section('M7b 带图 PDF：长按图像区域 -> 全屏查看器');
  if (!fs.existsSync(IMAGE_PDF)) {
    check('M7b 前置：有带图的 fixture', false, '缺少 test/fixtures/image-sample.pdf（跑 node fixtures/make-image-pdf.mjs 生成）');
  } else {
    fs.copyFileSync(IMAGE_PDF, path.join(PAPERS, 'img-sample.pdf'));
    const pi = await openMobile(browser, BASE + '/mobile/?open=img-sample.pdf', MAIN);
    const m7b = await pi.evaluate(async () => {
      const pageEl = document.querySelector('.page');
      const pr = pageEl.getBoundingClientRect();
      const canvas = pageEl.querySelector('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // 找 fixture 里那张橙色块的重心
      let sx = 0; let sy = 0; let n = 0;
      for (let y = 0; y < canvas.height; y += 8) {
        for (let x = 0; x < canvas.width; x += 8) {
          const i = (y * canvas.width + x) * 4;
          const rr = data.data[i]; const gg = data.data[i + 1]; const bb = data.data[i + 2];
          if (rr > 150 && rr - bb > 60 && gg < rr - 40) { sx += x; sy += y; n += 1; }
        }
      }
      if (!n) return { opened: false, why: '画布上找不到橙色块' };
      const imgX = pr.left + ((sx / n) / canvas.width) * pr.width;
      const imgY = pr.top + ((sy / n) / canvas.height) * pr.height;
      // 长按文字优先是设计，所以要点一个不被任何文字 span 覆盖的位置
      const spans = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')]
        .map((s) => s.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const covered = (x, y) => spans.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
      let pt = covered(imgX, imgY) ? null : [imgX, imgY];
      for (let step = 6; step <= 80 && !pt; step += 6) {
        for (const d of [[0, step], [0, -step], [step, 0], [-step, 0], [step, step], [-step, -step]]) {
          const x = imgX + d[0]; const y = imgY + d[1];
          if (x < pr.left + 2 || x > pr.right - 2 || y < pr.top + 2 || y > pr.bottom - 2) continue;
          const px = Math.round(((x - pr.left) / pr.width) * canvas.width);
          const py = Math.round(((y - pr.top) / pr.height) * canvas.height);
          if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
          const i = (py * canvas.width + px) * 4;
          const rr = data.data[i]; const gg = data.data[i + 1]; const bb = data.data[i + 2];
          if (rr > 150 && rr - bb > 60 && gg < rr - 40 && !covered(x, y)) { pt = [x, y]; break; }
        }
      }
      if (!pt) return { opened: false, why: '橙色块整个被文字覆盖，找不到干净点' };
      const v = document.getElementById('mViewer');
      const mk = (type) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 31, pointerType: 'touch', isPrimary: true,
        clientX: pt[0], clientY: pt[1], buttons: type === 'pointerup' ? 0 : 1,
      });
      v.dispatchEvent(mk('pointerdown'));
      await new Promise((res) => setTimeout(res, 620));
      v.dispatchEvent(mk('pointerup'));
      await new Promise((res) => setTimeout(res, 700));
      const node = document.querySelector('.m-imgview img');
      return {
        opened: !!document.querySelector('.m-imgview'),
        pick: { x: Math.round(pt[0]), y: Math.round(pt[1]) },
        // 判据是「真的裁出了一张图」：data URL 长度 + 解码后的自然尺寸
        srcLen: node ? String(node.getAttribute('src') || '').length : 0,
        srcHead: node ? String(node.getAttribute('src') || '').slice(0, 24) : '',
        natural: node ? { w: node.naturalWidth, h: node.naturalHeight } : null,
        bar: !!document.querySelector('.m-imgview-bar'),
      };
    });
    check('M7b 长按图中位置 -> 打开全屏查看器并裁出那一块',
      m7b.opened === true && m7b.srcLen > 1000 && m7b.bar === true, fmt(m7b));
    await pi.close();
  }

  // ============ M8 ============
  section('M8 顶栏：默认收起 / 点一下出现 / 滚动自动收起');
  await main.evaluate(() => {
    const iv = document.querySelector('.m-imgview');
    if (iv) iv.remove();
    document.getElementById('mSelectSheet').classList.add('hidden');
    if (window.getSelection()) window.getSelection().removeAllRanges();
    document.getElementById('mTopbar').classList.remove('on');
  });
  await sleep(350);
  const m8a = await main.evaluate(() => document.getElementById('mTopbar').classList.contains('on'));
  await main.touchscreen.tap(195, 500);
  await sleep(350);
  const m8b = await main.evaluate(() => document.getElementById('mTopbar').classList.contains('on'));
  await main.evaluate(() => { document.getElementById('mViewer').scrollTop += 400; });
  await sleep(400);
  const m8c = await main.evaluate(() => ({
    on: document.getElementById('mTopbar').classList.contains('on'),
    top: Math.round(document.getElementById('mTopbar').getBoundingClientRect().top),
  }));
  check('M8 点一下正文唤出顶栏；滚动后自动收起',
    m8a === false && m8b === true && m8c.on === false,
    '默认=' + m8a + ' 点击后=' + m8b + ' 滚动后=' + m8c.on + '（top=' + m8c.top + '）');

  // ============ M9 ============
  section('M9 页面底色 / 阅读区底色');
  const m9 = await main.evaluate(async () => {
    const pageBg = () => getComputedStyle(document.querySelector('.page')).backgroundColor;
    const viewBg = () => getComputedStyle(document.getElementById('mViewer')).backgroundColor;
    const out = { base: { page: pageBg(), view: viewBg() } };
    const pt = document.getElementById('mPageTone');
    pt.value = 'warm'; pt.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.warm = { page: pageBg(), attr: document.documentElement.dataset.pageTone };
    pt.value = 'paper'; pt.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.paper = { page: pageBg() };
    const bt = document.getElementById('mBackTone');
    bt.value = 'deep'; bt.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.deep = { view: viewBg() };
    return out;
  });
  check('M9a 页面底色切到米白（跟随软件主题）后真的变了',
    m9.warm.page !== m9.base.page && m9.warm.attr === 'warm', m9.base.page + ' -> ' + m9.warm.page);
  check('M9b 切回纸白恢复原色', m9.paper.page === m9.base.page, m9.warm.page + ' -> ' + m9.paper.page);
  check('M9c 阅读区底色切到深色真的生效', m9.deep.view !== m9.base.view, m9.base.view + ' -> ' + m9.deep.view);

  // ============ M3 ============
  section('M3 界面不做伸缩：320 / 390 / 430 三种宽度都铺满且无横向滚动');
  for (const size of PHONES) {
    const p = await openMobile(browser, BASE + '/mobile/?open=mobile-sample.pdf', size);
    const g = await p.evaluate(() => {
      const v = document.getElementById('mViewer').getBoundingClientRect();
      const pageEl = document.querySelector('.page');
      return {
        viewerTop: Math.round(v.top),
        viewerH: Math.round(v.height),
        winH: window.innerHeight,
        winW: window.innerWidth,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        pageW: Math.round(pageEl ? pageEl.getBoundingClientRect().width : 0),
        fields: document.querySelectorAll('#mModal .m-field').length,
      };
    });
    check('M3 @' + size[0] + 'x' + size[1] + ' 阅读区铺满整屏、无横向滚动、页面不溢出',
      g.viewerTop === 0 && g.viewerH === g.winH && g.overflowX <= 1 && g.pageW <= g.winW && g.fields >= 3,
      'viewer=' + g.viewerTop + '+' + g.viewerH + '/' + g.winH + ' overflowX=' + g.overflowX
      + ' pageW=' + g.pageW + ' 视口=' + g.winW + ' 设置项=' + g.fields);
    await p.close();
  }

  // ============ M10 ============
  section('M10 file:// 下也能加载并打开本地 PDF（APK 就是这么加载的）');
  {
    const fileUrl = 'file:///' + path.join(ROOT, 'public', 'mobile', 'index.html').replace(/\\/g, '/');
    const p = await browser.newPage();
    const errs = [];
    const failed = [];
    p.on('pageerror', (e) => errs.push(String(e && e.message).slice(0, 120)));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
    p.on('requestfailed', (r) => failed.push(r.url().split('/').slice(-1)[0] + ' :: ' + ((r.failure() && r.failure().errorText) || '')));
    await p.emulate({
      viewport: { width: MAIN[0], height: MAIN[1], isMobile: true, hasTouch: true, deviceScaleFactor: MAIN[2] },
      userAgent: PHONE_UA,
    });
    await p.goto(fileUrl, { waitUntil: 'domcontentloaded' });
    let loaded = true;
    try { await p.waitForFunction(() => !!window.__viewer, { timeout: 20000 }); } catch { loaded = false; }
    await sleep(1200);
    const info = await p.evaluate(() => ({
      hasViewer: !!window.__viewer,
      mobileUI: !!document.getElementById('mViewer') && !!document.getElementById('mFooter'),
    }));
    check('M10a file:// 下手机版 UI 与 ES module 都能加载（无 404 / 语法错）',
      info.hasViewer && info.mobileUI && loaded,
      fmt(info) + ' 失败请求=' + fmt(failed.slice(0, 3)) + ' 错误=' + fmt(errs.slice(0, 2)));
    // file:// 页面不能 fetch http://（跨源拦截是浏览器的正确行为）。
    // APK 里 PDF 来自用户本机选的文件，所以这里用同目录下的本地 PDF 验同一件事。
    const localPdf = path.join(ROOT, 'public', 'mobile', '_fixture.pdf');
    fs.copyFileSync(FIXTURE_PDF, localPdf);
    const relUrl = new URL('./_fixture.pdf', fileUrl).href;
    const opened = await p.evaluate(async (url) => {
      try { await window.__viewer.load(url, 'fixture.pdf'); return { ok: true, pages: window.__viewer.numPages }; }
      catch (e) { return { ok: false, why: String(e && (e.message || e)).slice(0, 140) }; }
    }, relUrl);
    try { fs.unlinkSync(localPdf); } catch { /* 忽略 */ }
    check('M10b file:// 页面能打开同目录下的本地 PDF（worker 路径在 file:// 下解析正确）',
      opened.ok === true && opened.pages > 1, fmt(opened));
    await p.close();
  }

  section('M11 零 JS 报错');
  check('全程没有 pageerror / console.error', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || '(无)');

  await main.close();
} catch (e) {
  check('套件自身未抛异常', false, '抛出：' + (e && (e.stack || e.message || e)));
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { if (server && server.exitCode === null) server.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const after = sha(REAL_CONFIG);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n==========================================================');
  console.log('真实 data/config.json 改动  : ' + (REAL_CONFIG_BEFORE === after ? '无（只读，符合预期）' : '**变了**'));
  console.log('结果                        : ' + pass + '/' + results.length + ' 通过');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n失败明细：');
    for (const f of failed) console.log('  [XX] ' + f.section + ' · ' + f.name + ' -- ' + f.actual);
  }
  console.log('==========================================================');
  process.exit(failed.length ? 1 : 0);
}
