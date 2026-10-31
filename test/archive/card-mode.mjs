import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 归档套件也走相对路径（本文件在 test/archive/，所以往上两层才是仓库根）
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 8919;
const CDP_PORT = 9453;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
const BROWSERS = [
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const VIEW_W = 1600;
const VIEW_H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let currentSection = '';
const section = (name) => { currentSection = name; console.log(`\n──── ${name} ────`); };
const check = (name, ok, detail = '') => {
  results.push({ section: currentSection, name, ok: !!ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-card-'));
const DATA = path.join(tmp, 'data');
const PAPERS = path.join(tmp, 'papers');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(FIXTURE_PDF, path.join(PAPERS, 'card-sample.pdf'));

const REAL_CONFIG = path.join(ROOT, 'data', 'config.json');
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(读不到)'; } };
const REAL_CONFIG_BEFORE = sha(REAL_CONFIG);

const browserPath = BROWSERS.find((p) => fs.existsSync(p));
let server = null;
let browser = null;
let browserProc = null;
const pageErrors = [];

function spawnLogged(exe, args, opts = {}) {
  const logFile = path.join(tmp, `${path.basename(exe, '.exe')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
  const fd = fs.openSync(logFile, 'w');
  const proc = spawn(exe, args, { ...opts, stdio: ['ignore', fd, fd] });
  proc.__logFile = logFile;
  return proc;
}
const procLog = (proc) => { try { return fs.readFileSync(proc.__logFile, 'utf8'); } catch { return ''; } };

async function launchBrowser(exe) {
  const errors = [];
  try {
    const b = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      userDataDir: path.join(tmp, 'profile-launch'),
      args: ['--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', `--window-size=${VIEW_W},${VIEW_H}`],
      defaultViewport: { width: VIEW_W, height: VIEW_H },
    });
    return { browser: b, mode: 'puppeteer.launch' };
  } catch (e) { errors.push(`puppeteer.launch: ${e && (e.message || e)}`); }
  try {
    const profile = path.join(tmp, 'profile-cdp');
    browserProc = spawnLogged(exe, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      `--window-size=${VIEW_W},${VIEW_H}`, 'about:blank',
    ], {});
    let ws = null;
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } } catch { /* 还没起来 */ }
      if (browserProc.exitCode !== null) break;
      await sleep(250);
    }
    if (!ws) throw new Error(`CDP 端口没起来（exit=${browserProc.exitCode}）`);
    const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: { width: VIEW_W, height: VIEW_H } });
    return { browser: b, mode: `spawn + CDP(${CDP_PORT})` };
  } catch (e) { errors.push(`spawn+CDP: ${e && (e.message || e)}`); }
  return { error: errors.join('\n  ') };
}

const PROBE = () => {
  window.__c = {
    /** 一次性取齐：面板模型 + 卡片 DOM + 窗口命中 */
    snap(id) {
      const p = window.__state?.panels?.[id] || null;
      const layer = document.getElementById('floatLayer');
      const box = layer ? layer.querySelector(`[data-panel="${id}"], [data-shell="${id}"]`) : null;
      const r = box ? box.getBoundingClientRect() : null;
      return {
        visible: !!(p && p.visible),
        dock: p ? p.dock : '',
        home: p ? p.home : '',
        rect: p && p.rect ? { ...p.rect } : null,
        isFloat: !!(box && box.classList.contains('panel-float')),
        inLayer: !!(box && box.parentElement && box.parentElement.id === 'floatLayer'),
        boxRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        boxPos: box ? getComputedStyle(box).position : '',
        detachedKey: (() => { try { return JSON.parse(localStorage.getItem('reader.detachedWindows') || '{}')[id] || null; } catch { return 'bad-json'; } })(),
        openCalls: (window.__openCalls || []).length,
      };
    },
    /** 卡片压住可见纸面的百分比（防「大块遮挡」复发） */
    overlap(id) {
      const layer = document.getElementById('floatLayer');
      const box = layer ? layer.querySelector(`[data-panel="${id}"], [data-shell="${id}"]`) : null;
      if (!box) return -1;
      const vw = innerWidth, vh = innerHeight;
      const br = box.getBoundingClientRect();
      const papers = [...document.querySelectorAll('.page')]
        .map((p) => p.getBoundingClientRect())
        .filter((x) => x.bottom > 0 && x.top < vh && x.right > 0 && x.left < vw);
      let paperArea = 0, over = 0;
      for (const pr of papers) {
        const pw = Math.min(pr.right, vw) - Math.max(pr.left, 0);
        const ph = Math.min(pr.bottom, vh) - Math.max(pr.top, 0);
        if (pw <= 0 || ph <= 0) continue;
        paperArea += pw * ph;
        const ow = Math.min(br.right, pr.right, vw) - Math.max(br.left, pr.left, 0);
        const oh = Math.min(br.bottom, pr.bottom, vh) - Math.max(br.top, pr.top, 0);
        if (ow > 0 && oh > 0) over += ow * oh;
      }
      return paperArea ? Math.round(over / paperArea * 100) : 0;
    },
    /** 卡片右下角缩放手柄拖到 (dx,dy) */
    resizeBy(id, dx, dy) {
      const layer = document.getElementById('floatLayer');
      const box = layer ? layer.querySelector(`[data-panel="${id}"], [data-shell="${id}"]`) : null;
      const grip = box ? box.querySelector('.panel-grip-se, .panel-resize') : null;
      if (!grip) return 'no-grip';
      const r = grip.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const fire = (type, cx, cy) => grip.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
        clientX: cx, clientY: cy,
      }));
      fire('pointerdown', x, y);
      fire('pointermove', x + dx, y + dy);
      fire('pointerup', x + dx, y + dy);
      return 'ok';
    },
    /** 把卡片拖到窗口外（越界测试用） */
    dragOutside(id) {
      const layer = document.getElementById('floatLayer');
      const box = layer ? layer.querySelector(`[data-panel="${id}"], [data-shell="${id}"]`) : null;
      const head = box ? box.querySelector('.ai-head, .sec-head') : null;
      if (!head) return 'no-head';
      const r = head.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const fire = (type, cx, cy) => head.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1,
        clientX: cx, clientY: cy,
      }));
      fire('pointerdown', x, y);
      fire('pointermove', x + 4000, y + 4000);
      fire('pointerup', x + 4000, y + 4000);
      return 'ok';
    },
    closeCard(id) {
      const layer = document.getElementById('floatLayer');
      const box = layer ? layer.querySelector(`[data-panel="${id}"], [data-shell="${id}"]`) : null;
      const btn = box ? box.querySelector('.panel-float-x') : null;
      if (!btn) return 'no-close-btn';
      btn.click();
      return 'ok';
    },
    hideManager() { if (!document.getElementById('panelMenu')?.classList.contains('hidden')) window.__ctx.togglePanelMenu(); },
  };
};

try {
  if (!browserPath) throw new Error('找不到 Edge / Chrome 可执行文件');
  if (!fs.existsSync(FIXTURE_PDF)) throw new Error(`缺少 fixture PDF：${FIXTURE_PDF}`);

  server = spawnLogged(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1' },
  });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) throw new Error(`隔离服务没起来（${BASE}）\n${procLog(server).slice(-600)}`);
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-card-fake', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  });

  const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
  const first = (papers.papers || [])[0];
  check('隔离书架能看到合成论文（前置条件）', !!first && !!docIdOf(first), `${first ? first.name : '(无)'}`);
  function docIdOf(p) { return p.docId || p.id || ''; }

  const launched = await launchBrowser(browserPath);
  if (launched.error) throw new Error(`浏览器起不来：\n  ${launched.error}`);
  browser = launched.browser;
  console.log(`浏览器连接方式：${launched.mode}`);
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e && e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/chat')) return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: 'data: [DONE]\n\n' });
    if (u.includes('/api/ref-search') || u.includes('/api/search') || u.includes('/api/open-url')) return req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true,"results":[]}' });
    return req.continue();
  });
  /* 记录 window.open 调用（产品不该再弹系统窗口） */
  await page.evaluateOnNewDocument(() => {
    window.__openCalls = [];
    const orig = window.open;
    window.open = (...args) => { window.__openCalls.push(args.map(String)); return null; };
    window.__origOpen = orig;
  });

  const boot = async (query = '') => {
    await page.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__state && !!window.__ctx, { timeout: 25000 });
    await page.evaluate(PROBE);
    await sleep(500);
  };

  /** 打开论文（点左栏文件列表；不依赖 URL 自动打开） */
  const openDoc = async () => {
    await page.waitForSelector('#fileList li', { timeout: 25000 }).catch(() => {});
    await page.evaluate(() => { document.querySelector('#fileList li')?.click(); });
    await page.waitForSelector('.page canvas', { timeout: 35000 }).catch(() => {});
    await sleep(2000);
  };

  /** 等某个面板的 dock 不再是 float（卡片的收回是带 CSS 动画的异步过程：
   *  closeFloatPanel 要等动画结束才 dockPanelTo —— 用固定 sleep 判定会把「慢一拍」
   *  误判成「收不回」，实测就栽在这里）。 */
  const waitDocked = (id, ms = 6000) => page.waitForFunction(
    (pid) => window.__state?.panels?.[pid]?.dock !== 'float',
    { timeout: ms, polling: 120 }, id,
  ).then(() => true).catch(() => false);

  /* ── 一、旧 URL 必须退化成普通阅读器 ── */
  section('一、旧 ?window=panel URL 不再整页变成某一个面板');
  for (const id of ['chat', 'relations', 'translate', 'files']) {
    await boot(`?window=panel&panel=${id}&topbar=static`);
    await openDoc();
    const s = await page.evaluate(() => {
      const viewer = document.getElementById('viewer');
      const vr = viewer ? viewer.getBoundingClientRect() : null;
      const aside = document.querySelector('.side.right');
      const ar = aside ? aside.getBoundingClientRect() : null;
      return {
        body: document.body.className,
        panelMode: /panel-window/.test(document.body.className),
        viewerW: vr ? Math.round(vr.width) : 0,
        asideW: ar ? Math.round(ar.width) : 0,
        pages: document.querySelectorAll('.page').length,
        canvases: document.querySelectorAll('.page canvas').length,
      };
    });
    check(`旧 URL panel=${id} 不再进入面板窗口模式，且阅读区正常`,
      s.panelMode === false && s.viewerW > 300 && s.canvases >= 1,
      `body="${s.body}" viewer=${s.viewerW}px aside=${s.asideW}px 页=${s.pages} canvas=${s.canvases}`);
  }

  /* ── 二、浮出 = 应用内卡片 ── */
  section('二、浮出面板进入 #floatLayer 成为应用内卡片（不是系统窗口）');
  await boot('?topbar=static');
  await openDoc();

  for (const id of ['chat', 'translate', 'relations', 'files']) {
    const opened = await page.evaluate((pid) => window.__ctx.detachPanelToWindow(pid), id);
    await sleep(900);
    const s = await page.evaluate((pid) => window.__c.snap(pid), id);
    const over = await page.evaluate((pid) => window.__c.overlap(pid), id);
    const w = s.boxRect ? s.boxRect[2] : 0, h = s.boxRect ? s.boxRect[3] : 0;
    check(`「${id}」浮出后是 #floatLayer 里的 fixed 卡片，尺寸 ≥260×180，且不再打开系统窗口`,
      opened === true && s.isFloat && s.inLayer && s.boxPos === 'fixed' && w >= 260 && h >= 180 && s.detachedKey === null && s.openCalls === 0,
      `dock=${s.dock} rect=${fmt(s.boxRect)} pos=${s.boxPos} detachedKey=${fmt(s.detachedKey)} openCalls=${s.openCalls}`);
    check(`「${id}」卡片没有大块压住阅读区（<50%）`, over >= 0 && over < 50, `压住纸面 ${over}%`);
    /* 收回：点卡片自己的 ✕，然后等它真的回停靠区 */
    await page.evaluate((pid) => { window.__c.closeCard(pid); }, id);
    const docked = await waitDocked(id);
    const back = await page.evaluate((pid) => window.__c.snap(pid), id);
    check(`「${id}」用卡片自己的收回按钮回到停靠区且仍然可见`,
      docked && back.dock !== 'float' && back.visible === true && back.isFloat === false,
      `6s 内回到停靠=${docked} dock=${back.dock} visible=${back.visible}`);
  }

  /* ── 三、卡片不会被「点外面」关掉 ── */
  section('三、点正文 / 侧栏不会关掉卡片（这是明确的产品要求）');
  /* ⚠️ 必须已经打开论文：没有 doc 时 floatPanel() 直接返回 false（产品行为正确），
     测试会误判成「卡片打不开」。 */
  await openDoc();
  const openedForOutside = await page.evaluate(() => window.__ctx.detachPanelToWindow('chat'));
  await sleep(900);
  check('前置：卡片确实打开了', openedForOutside === true, `detachPanelToWindow 返回 ${openedForOutside}`);
  await page.mouse.click(800, 600);
  await sleep(400);
  await page.mouse.click(60, 700);
  await sleep(400);
  const afterOutside = await page.evaluate(() => window.__c.snap('chat'));
  check('点正文与左栏之后卡片仍在（没有被误关）',
    afterOutside.dock === 'float' && afterOutside.isFloat === true,
    `dock=${afterOutside.dock} isFloat=${afterOutside.isFloat}`);

  section('四、Esc 能收回卡片');
  const cardRect = await page.evaluate(() => {
    const box = document.querySelector('#floatLayer [data-panel="chat"], #floatLayer [data-shell="chat"]');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 28) };
  });
  if (cardRect) await page.mouse.click(cardRect.x, cardRect.y);
  await sleep(400);
  await page.keyboard.press('Escape');
  const escDocked = await waitDocked('chat');
  const afterEsc = await page.evaluate(() => window.__c.snap('chat'));
  check('点过卡片之后按 Esc 能收回', escDocked && afterEsc.dock !== 'float',
    `6s 内回到停靠=${escDocked} dock=${afterEsc.dock}`);

  /* ── 五、越界 / 缩放钳制 ── */
  section('五、卡片拖到窗口外会被钳回可见区域；缩放手柄不能把它撑出窗口');
  const reopen5 = await page.evaluate(() => window.__ctx.detachPanelToWindow('chat'));
  await sleep(900);
  check('前置：第五段开始时卡片已打开', reopen5 === true, `detachPanelToWindow 返回 ${reopen5}`);

  const CARD_SEL = '#floatLayer .panel-shell[data-shell="chat"], #floatLayer .panel-float[data-panel="chat"], #floatLayer [data-shell="chat"], #floatLayer [data-panel="chat"]';
  const cardProbe = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return {
      cls: String(box.className).split(/\s+/).slice(0, 3).join('.'),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      hasHead: !!box.querySelector('.ai-head, .sec-head, .side-head'),
      hasGrip: !!box.querySelector('.panel-grip-se, .panel-resize'),
    };
  }, CARD_SEL);
  console.log(`   （现场）卡片盒=${cardProbe && cardProbe.cls} rect=${fmt(cardProbe && cardProbe.rect)} 抓手=${cardProbe && cardProbe.hasGrip}`);

  await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    const head = box ? box.querySelector('.ai-head, .sec-head, .side-head') : null;
    if (!head) return;
    const r = head.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const fire = (type, cx, cy) => head.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: cy,
    }));
    fire('pointerdown', x, y);
    fire('pointermove', innerWidth - 4, y);      // 最右侧停靠带
    fire('pointerup', innerWidth - 4, y);
  }, CARD_SEL);
  const dockedByDrag = await waitDocked('chat');
  const afterDrag = await page.evaluate(() => window.__c.snap('chat'));
  check('拖到最右停靠带松手 → 卡片按契约回到右栏（不弹系统窗口）',
    dockedByDrag && afterDrag.dock === 'right' && afterDrag.openCalls === 0,
    `回到停靠=${dockedByDrag} dock=${afterDrag.dock} openCalls=${afterDrag.openCalls}`);

  /* 窗口内正常拖动：仍然是浮卡片，且完全在视口内 */
  await page.evaluate(() => window.__ctx.detachPanelToWindow('chat'));
  await sleep(900);
  await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    const head = box ? box.querySelector('.ai-head, .sec-head, .side-head') : null;
    if (!head) return;
    const r = head.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const fire = (type, cx, cy) => head.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: cy,
    }));
    fire('pointerdown', x, y);
    fire('pointermove', 520, 380);
    fire('pointerup', 520, 380);
  }, CARD_SEL);
  await sleep(900);
  const movedTo = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], vw: innerWidth, vh: innerHeight };
  }, CARD_SEL);
  check('窗口内拖动后卡片仍是可见浮卡片，且完整落在视口内',
    !!movedTo && movedTo.rect[0] >= -2 && movedTo.rect[1] >= -2
    && movedTo.rect[0] + movedTo.rect[2] <= movedTo.vw + 2
    && movedTo.rect[1] + movedTo.rect[3] <= movedTo.vh + 2,
    `rect=${fmt(movedTo?.rect)} 视口=${movedTo?.vw}x${movedTo?.vh}`);

  check('卡片有可见的缩放手柄（右下角抓手）', !!cardProbe && cardProbe.hasGrip,
    `抓手=${cardProbe && cardProbe.hasGrip} 卡片盒=${fmt(cardProbe && cardProbe.cls)}`);

  if (cardProbe && cardProbe.hasGrip) {
    await page.evaluate((sel) => {
      const box = document.querySelector(sel);
      const grip = box ? box.querySelector('.panel-grip-se, .panel-resize') : null;
      if (!grip) return;
      const r = grip.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const fire = (type, cx, cy) => grip.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: cy,
      }));
      fire('pointerdown', x, y);
      fire('pointermove', x + 3000, y + 3000);
      fire('pointerup', x + 3000, y + 3000);
    }, CARD_SEL);
    await sleep(900);
    const resized = await page.evaluate((sel) => {
      const box = document.querySelector(sel);
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
    }, CARD_SEL);
    check('缩放手柄拖到极大也不会把卡片撑出窗口（钳到上限）',
      !!resized && resized.w >= 260 && resized.h >= 180 && resized.w <= resized.vw && resized.h <= resized.vh,
      `${resized?.w}x${resized?.h} 视口=${resized?.vw}x${resized?.vh}`);
  }

  /* ── 六、旧存档的 detachedWindows 会被清掉 ── */
  section('六、旧存档残留的 reader.detachedWindows 在启动时统一清账');
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ctx, { timeout: 25000 });
  await page.evaluate(() => {
    localStorage.setItem('reader.detachedWindows', JSON.stringify({ chat: Date.now(), translate: Date.now() }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__state && !!window.__ctx, { timeout: 25000 });
  await page.evaluate(PROBE);
  await sleep(800);
  const cleaned = await page.evaluate(() => {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem('reader.detachedWindows') || '{}'); } catch { return { bad: true }; }
    return { keys: Object.keys(raw), chat: window.__c.snap('chat') };
  });
  check('重启后 reader.detachedWindows 里没有残留',
    !cleaned.bad && cleaned.keys.length === 0,
    `keys=${fmt(cleaned.keys)} chat.dock=${cleaned.chat?.dock} chat.visible=${cleaned.chat?.visible}`);

  /* ── 七、面板管理器里不再出现「独立窗口」入口 ── */
  section('七、面板管理器不再提供「独立窗口」这一项');
  const manager = await page.evaluate(() => {
    window.__ctx.togglePanelMenu();
    const box = document.getElementById('panelMenu');
    const text = box ? box.textContent.replace(/\s+/g, ' ') : '';
    const rows = box ? [...box.querySelectorAll('.pm-row')].map((r) => ({
      id: r.dataset.panel,
      text: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 70),
    })) : [];
    window.__ctx.togglePanelMenu();
    return { open: !!box, text, rows };
  });
  check('管理器里没有「独立窗口」字样，但仍可把面板开成应用内卡片',
    manager.open && !/独立窗口/.test(manager.text) && /卡片/.test(manager.text),
    `行数=${manager.rows.length} 含卡片=${/卡片/.test(manager.text)} 行文本=${fmt(manager.rows.slice(0, 2).map((r) => r.text))}`);

  /* ── 八、零 JS 报错 ── */
  section('八、全程零 JS 报错');
  check('没有 pageerror / console.error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '(无)');
} catch (e) {
  check('套件自身未抛异常', false, `抛出：${e && (e.message || e)}`);
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { if (browserProc && browserProc.exitCode === null) browserProc.kill(); } catch { /* 忽略 */ }
  try { if (server && server.exitCode === null) server.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const after = sha(REAL_CONFIG);
const total = results.length;
const pass = results.filter((r) => r.ok).length;
console.log(`\n${'═'.repeat(58)}`);
console.log(`真实 data/config.json 改动  : ${after === REAL_CONFIG_BEFORE ? '无（只读，符合预期）' : '⚠️ 被改动了！'}`);
console.log(`结果                        : ${pass}/${total} 通过`);
console.log('═'.repeat(58));
if (after !== REAL_CONFIG_BEFORE) process.exitCode = 2;
else if (pass !== total) {
  console.log('\n失败明细：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  [XX] ${r.section} · ${r.name} — ${r.detail}`);
  process.exitCode = 1;
}
