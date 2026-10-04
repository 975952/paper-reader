/**
 * 顶栏自动隐藏回归套件。
 *
 *   cd test && node topbar-autohide.mjs
 *
 * 用户口径（2026-10-03，原话）：
 *   「在阅读的时候，最上面那一栏应该是鼠标悬停在上面才出现，鼠标移走就收起。」
 *   「控件需要下移的可以跟着下移，文章不动。」
 *
 * 判定的是**几何关系**，不是观感：
 *   T1 静息态：顶栏不在屏幕里（translateY(-100%)、top = -46）
 *   T2 鼠标进顶部热区：顶栏滑出（top = 0）
 *   T3 鼠标移开：顶栏收回
 *   T4 **文章不动**：正文区上沿在「收起 / 展开 / 再收起」三个时刻完全相同
 *   T5 顶栏展开时盖在正文上，而不是把正文往下推（正文高度三态不变）
 *   T6 悬停组：鼠标从热区移进顶栏里（y 落在 0..46）顶栏保持展开 ——
 *      否则一离开那 6px 热区就收回，按钮一个都点不到
 *   T7 键盘：焦点进顶栏（Tab）保持展开；焦点离开后能收起
 *   T8 键盘焦点在顶栏内部的输入控件上时**不自动收起**（打字打到一半顶栏滑走最烦人）
 *   T9 底部严丝合缝：状态栏底边 = 视口底边，且不出现页面滚动条
 *   T10 正文顶到屏幕上沿（顶栏收起时不留 46px 白带）
 *   T11 独立窗口页（?window=panel）没有顶栏、也不该有热区
 *   T12 全程零 JS 报错
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:\\Users\\Wang Wenbo\\Desktop\\prt';
const PORT = 8926;
const CDP_PORT = 9454;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const W = 1400; const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let currentSection = '';
function section(t) { currentSection = t; console.log(`\n──── ${t} ────`); }
function check(name, ok, actual = '') {
  let pass = false;
  try { pass = ok === true; } catch { pass = false; }
  results.push({ section: currentSection, name, ok: pass, actual: String(actual) });
  console.log(`${pass ? '[OK]' : '[XX]'} ${name}${actual ? `  — ${actual}` : ''}`);
}

fs.mkdirSync(path.join(ROOT, 'test', 'artifacts', 'ug-topbar'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-topbar-'));
const DATA = path.join(tmp, 'data'); const PAPERS = path.join(tmp, 'papers');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(FIXTURE_PDF, path.join(PAPERS, 'topbar-sample.pdf'));

const REAL_CONFIG = path.join(ROOT, 'data', 'config.json');
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(读不到)'; } };
const REAL_CONFIG_BEFORE = sha(REAL_CONFIG);
const browserPath = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

console.log('══════════════════════════════════════════════════════════');
console.log('顶栏自动隐藏：悬停才出现 / 文章不动 / 底部严丝合缝');
console.log(`时间    : ${new Date().toLocaleString('zh-CN')}`);
console.log(`浏览器  : ${browserPath || '(没找到)'}`);
console.log('══════════════════════════════════════════════════════════');

let server = null; let browser = null; let browserProc = null;
const pageErrors = [];

function spawnLogged(exe, args, opts = {}) {
  const logFile = path.join(tmp, `${path.basename(exe, '.exe')}-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'w');
  const proc = spawn(exe, args, { ...opts, stdio: ['ignore', fd, fd] });
  proc.__logFile = logFile;
  return proc;
}
const procLog = (p) => { try { return fs.readFileSync(p.__logFile, 'utf8'); } catch { return ''; } };

async function launchBrowser(exe) {
  const errors = [];
  try {
    const b = await puppeteer.launch({
      executablePath: exe, headless: true, userDataDir: path.join(tmp, 'pl'),
      args: ['--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`],
      defaultViewport: { width: W, height: H },
    });
    return { browser: b, mode: 'puppeteer.launch' };
  } catch (e) { errors.push(`launch: ${e && e.message}`); }
  try {
    browserProc = spawnLogged(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'pc')}`, `--window-size=${W},${H}`, 'about:blank'], {});
    let ws = null;
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } } catch { /* */ }
      if (browserProc.exitCode !== null) break;
      await sleep(250);
    }
    if (!ws) throw new Error(`CDP 没起来 ${procLog(browserProc).slice(0, 150)}`);
    const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: { width: W, height: H } });
    return { browser: b, mode: `spawn + CDP(${CDP_PORT})` };
  } catch (e) { errors.push(`cdp: ${e && e.message}`); }
  return { error: errors.join('\n  ') };
}

const GEO = () => {
  const rc = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; };
  const bar = document.querySelector('.topbar');
  return {
    bar: rc('.topbar'),
    barTransform: bar ? getComputedStyle(bar).transform : '',
    barDisplay: bar ? getComputedStyle(bar).display : '',
    hot: rc('.topbar-hot'),
    viewer: rc('#viewer'),
    viewerWrap: rc('.viewer-wrap'),
    statusbar: rc('.statusbar'),
    main: rc('#main'),
    winH: window.innerHeight,
    winW: window.innerWidth,
    overflowY: document.documentElement.scrollHeight - window.innerHeight,
    bodyCls: [...document.body.classList].join(' '),
  };
};

try {
  if (!browserPath) throw new Error('找不到 Edge / Chrome');
  server = spawnLogged(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1' },
  });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error(`隔离服务没起来\n${procLog(server).slice(-300)}`);
  await fetch(`${BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-tb-fake', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }) });

  const launched = await launchBrowser(browserPath);
  if (launched.error) {
    check('浏览器可启动（前置条件）', false, launched.error);
  } else {
    browser = launched.browser;
    console.log(`\n浏览器连接方式：${launched.mode}`);
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e && e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().includes('/api/chat')
      ? r.respond({ status: 200, contentType: 'text/event-stream', body: 'data: [DONE]\n\n' })
      : r.continue()));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__state && !!document.querySelector('.topbar'), { timeout: 25000 });
    await page.waitForSelector('#fileList li', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#fileList li').click());
    await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
    await sleep(2600);   // 开场那 1.2s 的「亮一下」已经结束

    section('T1–T3 静息收起 / 悬停出现 / 移开再收');
    const rest = await page.evaluate(GEO);
    check('T1 静息态顶栏在屏幕外（top = -顶栏高）',
      rest.bar && rest.bar.top <= -40 && /-?\d+/.test(rest.barTransform), `top=${rest.bar?.top} transform=${rest.barTransform} cls=${rest.bodyCls}`);
    check('T1b 触发带贴着屏幕最上沿且保持窄带（仅用于叫出顶栏）',
      rest.hot && rest.hot.top === 0 && rest.hot.h >= 6 && rest.hot.h <= 12
      && rest.bar && rest.hot.h < rest.bar.h,
      `hot=${JSON.stringify(rest.hot)} 顶栏 h=${rest.bar?.h}`);

    await page.mouse.move(Math.round(W / 2), 2);
    await sleep(450);
    const hot = await page.evaluate(GEO);
    check('T2 鼠标进顶部热区 → 顶栏滑出（top = 0）',
      hot.bar && hot.bar.top === 0, `top=${hot.bar?.top} cls=${hot.bodyCls}`);

    await page.mouse.move(Math.round(W / 2), 600);
    // 指针停下后还要等「活跃窗口」过期（TOPBAR_POINTER_IDLE_MS=700）才收，这里等够
    await sleep(1400);
    const away = await page.evaluate(GEO);
    check('T3 鼠标移开 → 顶栏收回',
      away.bar && away.bar.top <= -40, `top=${away.bar?.top} cls=${away.bodyCls}`);

    section('T4–T5 文章不动：三态下正文几何完全一致');
    check('T4 正文区上沿在「收起 / 展开 / 再收起」三态完全相同',
      rest.viewer?.top === hot.viewer?.top && hot.viewer?.top === away.viewer?.top,
      `${rest.viewer?.top} / ${hot.viewer?.top} / ${away.viewer?.top}`);
    check('T5 正文区高度三态完全相同（顶栏是盖上去的，不是把正文推下去）',
      rest.viewer?.h === hot.viewer?.h && hot.viewer?.h === away.viewer?.h,
      `${rest.viewer?.h} / ${hot.viewer?.h} / ${away.viewer?.h}`);
    check('T10 顶栏收起时正文顶到屏幕上沿（不留 46px 白带）',
      rest.viewer?.top <= 0, `viewer.top=${rest.viewer?.top}`);

    /**
     * T13 顶栏不能盖住正文内容 —— 这是用户实测反馈的缺陷：
     *   上一版为了「顶栏收起时不留白带」，把正文区整体上提了 46px（margin-top 负值），
     *   结果**第一页的上沿跑到 y=−26**，页面顶上那几十像素被浮层顶栏压住，
     *   翻到正文开头正好看不见（用户原话「桌面端全都被挡住了」）。
     * 判据：顶栏**展开**时，第一个 .page 的上沿必须在顶栏下边之下（留一点余量），
     *       而且三态下页面上沿不变（文章不动这条不能靠牺牲可见性换）。
     */
    const pageGeo = await page.evaluate(() => {
      const pg = document.querySelector('.page');
      const bar = document.querySelector('.topbar');
      if (!pg || !bar) return null;
      return { pageTop: Math.round(pg.getBoundingClientRect().top), barBottom: Math.round(bar.getBoundingClientRect().bottom) };
    });
    await page.mouse.move(Math.round(W / 2), 2);
    await sleep(450);
    const hotPage = await page.evaluate(() => {
      const pg = document.querySelector('.page');
      const bar = document.querySelector('.topbar');
      if (!pg || !bar) return null;
      return { pageTop: Math.round(pg.getBoundingClientRect().top), barBottom: Math.round(bar.getBoundingClientRect().bottom), bodyCls: [...document.body.classList].join(' ') };
    });
    check('T13 顶栏展开时不会盖住第一页内容（页面上沿在顶栏下边之下）',
      !!hotPage && hotPage.pageTop >= hotPage.barBottom - 2 && hotPage.bodyCls.includes('topbar-near'),
      `顶栏展开：barBottom=${hotPage?.barBottom} pageTop=${hotPage?.pageTop}（收起时 pageTop=${pageGeo?.pageTop}）`);

    /**
     * T14 用户实测缺陷（本轮修复）：鼠标移到屏幕顶边时，**整个阅读区消失**，
     * 只剩顶部一条工具栏，下面一片米黄。
     *
     * 根因：`body` 上的状态类与热区元素的类名同名（都叫 `topbar-hot`），
     * 而 CSS 里 `.topbar-hot { position:fixed; height:var(--topbar-hot); z-index:45;
     * background:transparent }`。于是加状态类 = 把 **`<body>` 自己**变成一条
     * 56px 高的透明固定条，`#main` 与 PDF 被挤出可视区。
     * 定位手段：CDP `CSS.getMatchedStylesForNode(body)` 报出 body 命中了 `.topbar-hot`。
     *
     * 这条断言用**渲染结果**兜住它（不只看 DOM —— 事故当时 DOM 尺寸完全正常，
     * 只有实际画面是空的）：
     *   ① body 不能命中任何「定位/高度」属性 —— 它必须保持 static + 满高
     *   ② 顶栏展开时必须真的能看到 PDF 纸面（截图里数「纸面像素」）
     */
    const bodyBox = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const r = document.body.getBoundingClientRect();
      return { position: cs.position, height: Math.round(r.height), zIndex: cs.zIndex, cls: [...document.body.classList].join(' ') };
    });
    check('T14 body 不能命中热区样式（position 必须 static、高度必须满屏）',
      bodyBox.position === 'static' && bodyBox.height >= 400 && bodyBox.zIndex === 'auto',
      `body: position=${bodyBox.position} height=${bodyBox.height} z-index=${bodyBox.zIndex} cls="${bodyBox.cls}"`);

    const paperTop = await page.evaluate(() => {
      const pg = document.querySelector('.page');
      const cs = pg ? getComputedStyle(pg) : null;
      const r = pg?.getBoundingClientRect();
      return { bg: cs?.backgroundColor, top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null };
    });
    const shot = await page.screenshot({ encoding: 'base64' });
    const painted = await page.evaluate(async (b64) => {
      /* 把截图放进离屏 canvas 数「纸面像素」：纸面 #FFFDF4 的蓝通道≈244，
         背景 #F3E8C3 的蓝通道≈195、正文底色 #E8DFC0 ≈192 —— 用蓝通道区分。 */
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const W = c.width, H = c.height;
      const d = g.getImageData(0, 0, W, H).data;
      let paper = 0, tot = 0;
      for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) {
        const i = (y * W + x) * 4; tot++;
        if (d[i + 2] >= 235 && d[i] >= 248) paper++;
      }
      return Math.round(paper / tot * 100);
    }, shot);
    check('T14b 顶栏展开时 PDF 纸面仍然画在屏幕上（不是一片空白）',
      painted >= 15,
      `纸面像素占比=${painted}%（页面背景 rgb(243,232,195) 不计入；修复前这里是 0%）`
      + ` · 第一页 rect.top=${paperTop.top} bg=${paperTop.bg}`);

    section('T6 悬停组：鼠标从热区移进顶栏内部，顶栏必须保持展开');
    await page.mouse.move(Math.round(W / 2), 2);
    await sleep(400);
    await page.mouse.move(Math.round(W / 2), 24);   // 落在顶栏本体上
    await sleep(500);
    const inBar = await page.evaluate(GEO);
    check('T6 鼠标在顶栏内部（y=24）时保持展开',
      inBar.bar && inBar.bar.top === 0, `top=${inBar.bar?.top} cls=${inBar.bodyCls}`);
    const clickable = await page.evaluate(() => {
      const r = document.getElementById('settingsBtn').getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!(el && el.closest('#settingsBtn'));
    });
    check('T6b 顶栏里的按钮此刻真的可点（命中测试）', clickable === true, `hit=${clickable}`);

    section('T7–T8 键盘：焦点进顶栏保持展开；焦点在输入控件上不自动收起');
    const tabbed = await page.evaluate(() => {
      document.getElementById('pageInput').focus();
      return { active: document.activeElement.id };
    });
    await sleep(500);
    await page.mouse.move(Math.round(W / 2), 600);   // 鼠标移开，但焦点在顶栏输入框上
    await sleep(700);
    const keepOpen = await page.evaluate(GEO);
    check('T8 焦点在顶栏输入框（pageInput）上时，鼠标移开也不收起',
      keepOpen.bar && keepOpen.bar.top === 0 && tabbed.active === 'pageInput',
      `top=${keepOpen.bar?.top} active=${tabbed.active}`);
    await page.evaluate(() => document.activeElement.blur());
    await sleep(1600);   // 焦点离开后同样要等活跃窗口过期
    const afterBlur = await page.evaluate(GEO);
    check('T7 焦点离开顶栏后，顶栏恢复收起', afterBlur.bar && afterBlur.bar.top <= -40, `top=${afterBlur.bar?.top}`);

    section('T9 底部严丝合缝：状态栏底边 = 视口底边，且无页面滚动条');
    check('T9a 状态栏底边贴住视口底边（±2px）',
      Math.abs((afterBlur.statusbar?.bottom || 0) - afterBlur.winH) <= 2,
      `statusbar.bottom=${afterBlur.statusbar?.bottom} 视口高=${afterBlur.winH}`);
    check('T9b 不出现页面级滚动条',
      afterBlur.overflowY <= 0, `overflowY=${afterBlur.overflowY}`);

    section('T11 旧面板 URL：不得再进入全屏面板模式');
    const child = await browser.newPage();
    await child.setViewport({ width: 520, height: 760 });
    await child.goto(`${BASE}/?window=panel&panel=chat`, { waitUntil: 'domcontentloaded' });
    await sleep(600);
    const childGeo = await child.evaluate(() => {
      const hot = document.getElementById('topbarHot');
      const bar = document.querySelector('.topbar');
      const viewer = document.getElementById('viewer')?.getBoundingClientRect();
      return {
        legacyClass: document.body.classList.contains('panel-window'),
        barDisplay: bar ? getComputedStyle(bar).display : '(none)',
        hotDisplay: hot ? getComputedStyle(hot).display : '(none)',
        barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
        viewerW: viewer ? Math.round(viewer.width) : 0,
        winH: window.innerHeight,
      };
    });
    check('T11 旧面板 URL 被降级为普通阅读器，不再隐藏顶栏或撑满单面板',
      childGeo.legacyClass === false && childGeo.barDisplay !== 'none' && childGeo.hotDisplay !== 'none' && childGeo.viewerW > 0,
      JSON.stringify(childGeo));
    await child.close();

    section('T12 零 JS 报错');
    check('全程没有 pageerror / console.error', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || '(无)');
  }
} catch (e) {
  check('套件自身未抛异常', false, `抛出：${e && (e.stack || e.message || e)}`);
} finally {
  try { if (browser) await browser.close(); } catch { /* */ }
  try { if (browserProc && browserProc.exitCode === null) browserProc.kill(); } catch { /* */ }
  try { if (server && server.exitCode === null) server.kill(); } catch { /* */ }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  const after = sha(REAL_CONFIG);
  const pass = results.filter((r) => r.ok).length;
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`真实 data/config.json 改动  : ${REAL_CONFIG_BEFORE === after ? '无（只读，符合预期）' : '**变了**'}`);
  console.log(`结果                        : ${pass}/${results.length} 通过`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('\n失败明细：'); for (const f of failed) console.log(`  [XX] ${f.section} · ${f.name} — ${f.actual}`); }
  console.log('══════════════════════════════════════════════════════════');
  process.exit(failed.length ? 1 : 0);
}
