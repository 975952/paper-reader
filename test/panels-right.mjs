/**
 * 「翻译和问答只放在右边、一栏只能开一个、右键再开一栏、拖动出应用内卡片」——独立验证套件。
 *
 *   cd test && node panels-right.mjs
 *
 * 完全隔离：自起一个 node server.js（PORT=8917，PRT_DATA_DIR / PRT_PAPERS_DIR 指向 mkdtemp 临时目录，
 * NO_OPEN=1），用无头 Edge 跑，跑完删临时目录、杀服务进程。**不碰真实 data/ 与 papers/**（脚本开头
 * 会对真实 data/config.json 取 SHA256，结束时比对，证明只读）。
 *
 * 断言清单见 task-1 的 A–J。每条断言都打印 [OK]/[XX] + 实测值；结尾一行 `N/N 通过`。
 * 设计与反例说明写在 test/artifacts/right-cols/RESULTS.md。
 *
 * 纪律：本套件只读 public/**，任何实现缺陷都通过 send_message 报给 lead，不在这里改实现。
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staticAudit } from './artifacts/right-cols/static-audit.mjs';

/* ══════════════════════════ 配置 ══════════════════════════ */
const ROOT = 'C:\\Users\\Wang Wenbo\\Desktop\\prt';
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.join(ROOT, 'public', 'js', 'app.js');
const ART = path.join(ROOT, 'test', 'artifacts', 'right-cols');
/** 现成的合成多页 PDF fixture（只读复制进临时 papers/，用完随临时目录一起删） */
const FIXTURE_PDF = path.join(ROOT, 'test', 'artifacts', 'preview', 'papers', 'attention-is-all-you-need-demo.pdf');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const VIEW_W = 1600;
const VIEW_H = 1000;
const NARROW_W = 800;
const NARROW_H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════ 结果收集 ══════════════════════════ */
const results = [];
let currentSection = '';
let sectionKind = 'runtime';   // static | runtime | blocked
function section(title, kind = 'runtime') {
  currentSection = title;
  sectionKind = kind;
  console.log(`\n──── ${title} ────`);
}
function check(name, ok, actual = '') {
  // 任何异常都只影响这一条断言，不让整轮挂掉
  let pass = false;
  try { pass = ok === true; } catch { pass = false; }
  results.push({ section: currentSection, kind: sectionKind, name, ok: pass, actual: String(actual) });
  const tag = sectionKind === 'static' ? '[静态] ' : '';
  console.log(`${pass ? '[OK]' : '[XX]'} ${tag}${name}${actual ? `  — ${actual}` : ''}`);
}
const fmt = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** 在页面里跑一段断言，返回 {ok, actual}；页面里抛异常时返回 ok=false + 异常文本 */
async function probe(page, fn, ...args) {
  try {
    const out = await page.evaluate(fn, ...args);
    if (out && typeof out === 'object' && 'ok' in out) return { ok: out.ok === true, actual: fmt(out.actual) };
    return { ok: false, actual: `probe 返回了意外结构：${fmt(out)}` };
  } catch (e) {
    return { ok: false, actual: `probe 抛异常：${e && (e.message || e)}` };
  }
}

/* ══════════════════════════ 临时目录 / 服务 ══════════════════════════ */
fs.mkdirSync(ART, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-right-cols-'));
const DATA = path.join(tmp, 'data');
const PAPERS = path.join(tmp, 'papers');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(FIXTURE_PDF, path.join(PAPERS, 'right-cols-sample.pdf'));

const REAL_CONFIG = path.join(ROOT, 'data', 'config.json');
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(读不到)'; } };
const REAL_CONFIG_BEFORE = sha(REAL_CONFIG);
const APP_SHA = sha(APP);

const browserPath = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const startedAt = new Date();

console.log('══════════════════════════════════════════════════════════');
console.log('右栏「一栏只开一个 / 右键再开一栏 / 拖出应用内卡片」独立验证');
console.log(`时间        : ${startedAt.toLocaleString('zh-CN')}`);
console.log(`app.js SHA  : ${APP_SHA}`);
console.log(`隔离 data   : ${DATA}`);
console.log(`隔离 papers : ${PAPERS}`);
console.log(`浏览器      : ${browserPath || '(没找到 Edge / Chrome)'}`);
console.log('══════════════════════════════════════════════════════════');

let server = null;
let browser = null;
let browserProc = null;
let serverLog = '';
let serverFd = null;
const pageErrors = [];      // pageerror + console.error（J 用）
const failedRequests = [];

/** spawn 一个子进程，stdout/stderr 落文件（**不能用 pipe**：受限沙箱里 pipe 会 EPERM） */
function spawnLogged(exe, args, opts = {}) {
  const logFile = path.join(tmp, `${path.basename(exe, '.exe')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
  const fd = fs.openSync(logFile, 'w');
  const proc = spawn(exe, args, { ...opts, stdio: ['ignore', fd, fd] });
  proc.__logFile = logFile;
  proc.__fd = fd;
  return proc;
}
const procLog = (proc) => {
  try { return fs.readFileSync(proc.__logFile, 'utf8'); } catch { return ''; }
};

/**
 * 起一个无头浏览器并连上它。
 *
 * **为什么不直接用 puppeteer.launch()**：puppeteer 固定用管道接子进程的 stdio
 * （`@puppeteer/browsers` 的 configureStdio 永远返回 'pipe'），在受限沙箱里 `spawn` 直接 EPERM。
 * 改成「自己 spawn（stdio 落文件）+ puppeteer.connect(CDP WebSocket)」，这样只要浏览器自己能起来就能测。
 * 返回 { browser, mode }；浏览器起不来时返回 { error }，由调用方决定是报 BLOCKED 还是 FAIL。
 */
async function launchBrowser(exe) {
  const errors = [];
  // 路径 1：先按最省事的 puppeteer.launch 试（沙箱外/正常环境走这条）
  try {
    const b = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      userDataDir: path.join(tmp, 'profile-launch'),
      args: ['--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', `--window-size=${VIEW_W},${VIEW_H}`],
      defaultViewport: { width: VIEW_W, height: VIEW_H },
    });
    return { browser: b, mode: 'puppeteer.launch' };
  } catch (e) {
    errors.push(`puppeteer.launch: ${e && (e.message || e)}`);
  }
  // 路径 2：自己 spawn + CDP 连接
  try {
    const port = PORT + 20;
    const profile = path.join(tmp, 'profile-cdp');
    browserProc = spawnLogged(exe, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${VIEW_W},${VIEW_H}`, 'about:blank',
    ], {});
    let ws = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; }
      } catch { /* 还没起来 */ }
      if (browserProc.exitCode !== null) break;
      await sleep(250);
    }
    if (!ws) throw new Error(`CDP 端口没起来（exit=${browserProc.exitCode}）；浏览器日志：${procLog(browserProc).split('\n').filter(Boolean).slice(0, 3).join(' | ')}`);
    const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: { width: VIEW_W, height: VIEW_H } });
    return { browser: b, mode: `spawn + CDP(${port})` };
  } catch (e) {
    errors.push(`spawn+CDP: ${e && (e.message || e)}`);
  }
  return { error: errors.join('\n  ') };
}

try {
  if (!browserPath) throw new Error('找不到 Edge / Chrome 可执行文件');
  if (!fs.existsSync(FIXTURE_PDF)) throw new Error(`缺少 fixture PDF：${FIXTURE_PDF}`);

  /* ══════════════ 第一层：静态契约审计（不需要浏览器，任何环境都能跑） ══════════════ */
  section('静态契约审计（读 public/ 源码核对接口契约；不能替代下面的运行时断言）', 'static');
  for (const row of staticAudit()) check(row.name, row.ok, row.actual);

  /* ══════════════ 第二层：隔离服务 ══════════════ */
  server = spawnLogged(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1' },
  });

  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) throw new Error(`隔离服务没起来（${BASE}）\n${serverLog.slice(-600)}`);

  section('环境与隔离核对（隔离服务、书架、真实 data/ 只读）', 'runtime');
  const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
  const first = (papers.papers || [])[0];
  check('隔离书架能看到合成论文（测试前置条件）', !!first && !!first.docId, `${first ? first.name : '(无)'} · docId=${first?.docId || '-'}`);

  /* ══════════════ 第三层：无头浏览器（沙箱里起不来就如实报 BLOCKED，不猜） ══════════════ */
  const launched = await launchBrowser(browserPath);
  if (launched.error) {
    section('BLOCKED：无头浏览器起不来，A–J 运行时断言无法执行', 'blocked');
    check('浏览器可启动（A–J 的前置条件）', false,
      `两次尝试都失败：\n  ${launched.error}\n  → 这一段必须在**不受限的环境**里跑（沙箱拒绝 Windows 命名管道/mojo IPC）；`
      + '静态审计（上面那段）与其它结论都不受影响。');
    console.log('\n提示：A–J 全部标记为「未验证」，**不是**「通过」。请在沙箱外重跑本套件。');
  } else {
    console.log(`\n浏览器连接方式：${launched.mode}`);
    browser = launched.browser;
  }

  if (browser) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e && (e.message || e)}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} → ${r.failure()?.errorText || 'failed'}`));

  // 打桩：任何 AI 请求都不许真的发出去（本套件不需要模型输出，塞消息用 DOM 直插，见 D）
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/chat')) {
      const sse = 'data: {"choices":[{"delta":{"content":"stub"}}]}\n\ndata: [DONE]\n\n';
      return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
    }
    if (url.includes('/api/ref-search') || url.includes('/api/open-url') || url.includes('/api/search')) {
      return req.respond({ status: 200, contentType: 'application/json; charset=utf-8', body: '{"ok":true,"results":[]}' });
    }
    return req.continue();
  });

  /** 打开应用（每次 goto 前清存档 → 默认布局） */
  async function boot({ clearStorage = true } = {}) {
    await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
    if (clearStorage) {
      await page.evaluate(() => { localStorage.clear(); });
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await page.waitForFunction(() => !!window.__state && !!window.__ctx && !!document.querySelector('#rightCols'), { timeout: 25000 });
    await sleep(350);
  }
  await boot();

  /* ── 打开论文（有正文才谈得上「正文不被遮」） ── */
  await page.waitForSelector('#fileList li', { timeout: 20000 });
  await page.evaluate((id) => {
    const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
    li.click();
  }, first?.docId);
  let pdfOk = true;
  try { await page.waitForFunction(() => !!window.__viewer?.pdf, { timeout: 40000 }); } catch { pdfOk = false; }
  await sleep(1200);
  check('打开合成论文后 #viewer 里有 PDF（测试前置条件）', pdfOk, `viewer.pdf=${pdfOk}`);

  /**
   * 页面内小工具 + window.open 打桩。**每次 reload 之后都必须重新注入**（页面上下文会重来），
   * 所以包成函数，boot() 之后与 H 的 reload 之后各调一次。
   */
  async function installHelpers() {
    await page.evaluate(() => {
      window.__openCalls = [];
      if (!window.__openPatched) {
        window.__openPatched = true;
        window.__realOpen = window.open;
        window.open = (...a) => { window.__openCalls.push(a.map(String)); return null; };
      }
    });
    await page.evaluate(() => {
    window.__t = {
      vis(node) { return !!node && !node.classList.contains('hidden') && node.getBoundingClientRect().width > 0; },
      block(id) {
        const el = window.__state?.blockEls?.[id];
        return el && el.isConnected ? el : null;
      },
      overlay(a, b) {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 0.5 && h > 0.5 ? { w: Math.round(w), h: Math.round(h) } : null;
      },
      cols() {
        const wrap = document.getElementById('rightCols');
        return [...(wrap?.querySelectorAll(':scope > aside.side.right') || [])];
      },
      // 一列是不是「真的在布局里」（可见、有宽度、在视口内）
      colInfo(n) {
        const el = n === 1 ? document.getElementById('rightSide') : document.getElementById('rightCol2');
        if (!el) return { present: false };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          present: true, hidden: el.classList.contains('hidden') || el.hidden === true,
          display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
          left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
          dataCol: el.dataset.col || '', cls: el.className,
        };
      },
      /** 右栏面板入口按钮。
       *  2026-10-03 起右栏**只有一套**可见入口：每一栏底部的「译文 / 问答」分段切换器
       *  （#aiBar / #aiBar2，按钮带 data-block）。旧的 #panelDockRight 图标坞已按用户
       *  「不再额外渲染另一组相同按钮」的要求删除，所以这里统一走切换器。 */
      rbtn(id, col) {
        const host = document.getElementById(col === 2 ? 'aiBar2' : 'aiBar');
        if (host) {
          const b = host.querySelector(`.aibar-btn[data-block="${id}"]`);
          if (b) return b;
        }
        // 兜底：若以后图标坞又被加回来，保证「重复入口」这件事能被下面的断言抓到
        return document.querySelector(`#panelDock .dock-btn[data-dock-for="${id}"]`) || null;
      },
      /** 右栏两栏切换器里所有按钮的 id（同一面板出现两次就是重复入口） */
      rightDockIds() {
        return [...document.querySelectorAll('#aiBar .aibar-btn, #aiBar2 .aibar-btn')]
          .map((b) => b.dataset.block);
      },
      state: () => JSON.parse(JSON.stringify({
        // JSON 化：避免把 DOM 节点带出来（panels 里没有节点，blockEls 在 __state 顶层，这里只取 panels）
        panels: window.__state.panels,
        noRight: document.body.classList.contains('no-right'),
      })),
    };
    });
  }
  await installHelpers();

  const snap = () => page.evaluate(() => window.__t.state());
  const colState = async () => {
    const s = await snap();
    return {
      count: s.panels.rightCols?.count,
      w2: s.panels.rightCols?.w2,
      tCol: s.panels.translate?.col, cCol: s.panels.chat?.col,
      tVis: s.panels.translate?.visible, cVis: s.panels.chat?.visible,
      tDock: s.panels.translate?.dock, cDock: s.panels.chat?.dock,
      noRight: s.noRight,
    };
  };
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(ART, `${name}.png`) }); return `${name}.png`; } catch { return '(截图失败)'; }
  };

  /* ══════════════════════════════ A. 默认（无存档） ══════════════════════════════ */
  section('A. 默认（无存档）：右栏只有 1 列，译文 / 问答都不显示');
  const a = await probe(page, () => {
    const wrap = document.getElementById('rightCols');
    const asides = [...(wrap?.querySelectorAll(':scope > aside.side.right') || [])];
    const empty = document.querySelector('#aiArea > .ai-empty');
    const area1 = document.getElementById('aiArea');
    const r = empty?.getBoundingClientRect();
    return {
      ok: !!wrap && asides.length === 1 && asides[0].id === 'rightSide' && asides[0].dataset.col === '1'
        && !document.getElementById('rightCol2')
        && !!empty && !!(r && r.width > 0 && r.height > 0)
        && !window.__t.block('translate') && !window.__t.block('chat')
        && !document.querySelector('#panelDock [data-dock-for="translate"]')
        && !document.querySelector('#panelDock [data-dock-for="chat"]')
        // 唯一入口在切换器上：第 1 栏恰好两个按钮，旧的图标坞必须不存在
        && document.querySelectorAll('#aiBar .aibar-btn').length === 2
        && !document.getElementById('panelDockRight'),
      actual: `#rightCols=${!!wrap} · aside.side.right=${asides.length}(${asides.map((x) => `${x.id}.col-${x.dataset.col}`).join(',')})`
        + ` · #rightCol2=${!!document.getElementById('rightCol2')}`
        + ` · #aiArea.children=[${[...(area1?.children || [])].map((x) => x.className).join(',')}]`
        + ` · .ai-empty 可见=${!!(r && r.width > 0)}`
        + ` · translateBlock=${!!window.__t.block('translate')} · chatBlock=${!!window.__t.block('chat')}`
        + ` · #panelDock 按钮=[${[...document.querySelectorAll('#panelDock .dock-btn')].map((b) => b.dataset.dockFor).join(',')}]`
        + ` · #aiBar 按钮=[${[...document.querySelectorAll('#aiBar .aibar-btn')].map((b) => b.dataset.block).join(',')}]`
        + ` · #panelDockRight=${!!document.getElementById('panelDockRight')}`,
    };
  });
  check('A1 默认 1 列、只有 #rightSide(.col-1)、没有 #rightCol2', a.ok, a.actual);
  const a2 = await probe(page, () => {
    const ids = [...document.querySelectorAll('#panelDock .dock-btn')].map((b) => b.dataset.dockFor);
    const leftSet = ['files', 'outline', 'notes', 'relations'];
    return {
      ok: !ids.includes('translate') && !ids.includes('chat') && leftSet.every((x) => ids.includes(x)),
      actual: `#panelDock=${JSON.stringify(ids)}`,
    };
  });
  check('A2 左侧图标坞只剩四个左栏面板，不再出现「译 / 问」', a2.ok, a2.actual);
  const a3 = await colState();
  check('A3 默认存档值：rightCols.count=1、两块 visible=false、col=1',
    a3.count === 1 && a3.tVis === false && a3.cVis === false && a3.tCol === 1 && a3.cCol === 1, JSON.stringify(a3));
  const a4 = await page.evaluate(() => {
    const left = document.getElementById('topbarLeftToggle');
    const right = document.getElementById('topbarRightToggle');
    if (!left || !right) return { ok: false, reason: '顶栏侧栏按钮缺失' };
    left.click();
    const afterLeft = { noLeft: document.body.classList.contains('no-left'), noRight: document.body.classList.contains('no-right'), leftPressed: left.getAttribute('aria-pressed'), rightPressed: right.getAttribute('aria-pressed') };
    right.click();
    const afterRight = { noLeft: document.body.classList.contains('no-left'), noRight: document.body.classList.contains('no-right'), leftPressed: left.getAttribute('aria-pressed'), rightPressed: right.getAttribute('aria-pressed') };
    left.click(); right.click();
    return {
      ok: afterLeft.noLeft && !afterLeft.noRight && afterLeft.leftPressed === 'false' && afterLeft.rightPressed === 'true'
        && afterRight.noLeft && afterRight.noRight && afterRight.leftPressed === 'false' && afterRight.rightPressed === 'false',
      afterLeft, afterRight,
    };
  });
  check('A4 顶栏左右按钮独立收展侧栏，并同步图标状态', a4.ok, JSON.stringify(a4));
  await shot('A-default');

  /* ══════════════════════════════ B. 互斥 ══════════════════════════════ */
  section('B. 互斥：一栏只开一个（__ctx 路径 + 点 #aiBar 按钮路径各一次）');

  // B 路径 1：__ctx / __state 直接调 setPanelVisible
  const b1 = await probe(page, () => {
    const has = typeof window.__ctx?.setPanelVisible === 'function';
    if (!has) return { ok: false, actual: `__ctx.setPanelVisible=${typeof window.__ctx?.setPanelVisible}` };
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.setPanelVisible('chat', true);
    const tb = window.__t.block('translate');
    const cb = window.__t.block('chat');
    const area = document.getElementById('aiArea');
    const asides = window.__t.cols();
    return {
      ok: window.__state.panels.rightCols.count === 1
        && asides.length === 1
        && window.__state.panels.translate.visible === false
        && window.__state.panels.chat.visible === true
        && !!cb && cb.parentElement === area && window.__t.vis(cb)
        && (!tb || !window.__t.vis(tb))
        && document.querySelectorAll('#aiArea .ai-split').length === 0,
      actual: `cols=${window.__state.panels.rightCols.count}·${asides.length}列`
        + ` · translate.visible=${window.__state.panels.translate.visible} chat.visible=${window.__state.panels.chat.visible}`
        + ` · #aiArea.children=[${[...(area?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`
        + ` · translate 可见=${window.__t.vis(tb)} · chat 可见=${window.__t.vis(cb)}`
        + ` · .ai-split=${document.querySelectorAll('#aiArea .ai-split, #rightCols .ai-split').length}`
        + ` · translate 节点在=${tb ? (tb.parentElement?.id || tb.parentElement?.className) : '不存在'}`,
    };
  });
  check('B1 [__ctx] 开 translate 再开 chat → 仍 1 列，#aiArea 里只有 chat，translate 不显示，.ai-split=0', b1.ok, b1.actual);
  await shot('B1-ctx-mutex');

  // B 路径 2：点 #aiBar 的按钮（先复位到 translate 独开）
  await page.evaluate(() => { window.__ctx.setPanelVisible('translate', true); });
  await sleep(200);
  const b2setup = await probe(page, () => ({
    ok: window.__state.panels.translate.visible === true && window.__state.panels.chat.visible === false,
    actual: `translate=${window.__state.panels.translate.visible} chat=${window.__state.panels.chat.visible}`,
  }));
  check('B2 试点前复位到「只开 translate」（测试前置条件）', b2setup.ok, b2setup.actual);
  const clickRes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#aiBar .aibar-btn')];
    const chat = btns.find((b) => (b.textContent || '').includes('问答'));
    if (!chat) return { clicked: false, texts: btns.map((b) => b.textContent) };
    chat.click();
    return { clicked: true, texts: btns.map((b) => b.textContent) };
  });
  await sleep(250);
  const b2 = await probe(page, (info) => {
    const tb = window.__t.block('translate');
    const cb = window.__t.block('chat');
    const area = document.getElementById('aiArea');
    const asides = window.__t.cols();
    return {
      ok: info.clicked === true
        && window.__state.panels.rightCols.count === 1 && asides.length === 1
        && window.__state.panels.translate.visible === false && window.__state.panels.chat.visible === true
        && !!cb && cb.parentElement === area && window.__t.vis(cb)
        && (!tb || !window.__t.vis(tb))
        && document.querySelectorAll('#rightCols .ai-split').length === 0,
      actual: `按钮点中=${info.clicked} · 点前 #aiBar=[${(info.texts || []).join('|')}]`
        + ` · cols=${window.__state.panels.rightCols.count}·${asides.length}列`
        + ` · translate.visible=${window.__state.panels.translate.visible} chat.visible=${window.__state.panels.chat.visible}`
        + ` · #aiArea.children=[${[...(area?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`
        + ` · chat 可见=${window.__t.vis(cb)} · translate 可见=${window.__t.vis(tb)}`
        + ` · .ai-split=${document.querySelectorAll('#rightCols .ai-split').length}`,
    };
  }, { clicked: clickRes.clicked, texts: clickRes.texts });
  check('B3 [#aiBar 点击] 点「问答」→ 仍 1 列，#aiArea 里只有 chat，translate 不显示，.ai-split=0',
    b2.ok, `${b2.actual} · 按钮文案=${JSON.stringify(clickRes.texts)}`);
  await shot('B3-bar-mutex');

  /* ══════════════════════════════ C. 第二栏 ══════════════════════════════ */
  section('C. 第二栏：openRightColumn() 后 2 列并排、第二栏 ≥240px、正文不被遮、--right-w2 已写');
  const cOpen = await page.evaluate(() => {
    const before = window.__state.panels.rightCols.count;
    const r1 = window.__ctx.openRightColumn();
    const r2 = window.__ctx.openRightColumn();
    return { before, r1, r2, after: window.__state.panels.rightCols.count };
  });
  await sleep(450);
  const c1 = await probe(page, () => {
    const asides = window.__t.cols();
    const c2 = window.__t.colInfo(2);
    const c1i = window.__t.colInfo(1);
    const split = document.getElementById('rightColSplit');
    const sr = split?.getBoundingClientRect();
    const inView = c2.present && !c2.hidden && c2.w > 0 && c2.left >= -1 && c2.right <= innerWidth + 1
      && c2.top >= -1 && c2.bottom <= innerHeight + 1;
    return {
      ok: asides.length === 2 && asides[0].dataset.col === '1' && asides[1].dataset.col === '2'
        && asides[1].id === 'rightCol2' && asides[1].classList.contains('col-2')
        && !!split && !split.hidden && !!sr && sr.width > 0
        && inView && c2.w >= 240 && !c2.display.includes('none'),
      actual: `aside 数=${asides.length}(${asides.map((x) => `${x.id}[${x.dataset.col}]`).join(',')})`
        + ` · col1=${JSON.stringify(c1i)} · col2=${JSON.stringify(c2)}`
        + ` · #rightColSplit=${!!split} hidden=${split?.hidden} w=${sr ? Math.round(sr.width) : '-'} left=${sr ? Math.round(sr.left) : '-'}`
        + ` · innerWidth=${window.innerWidth}`,
    };
  });
  check('C1 openRightColumn() 后 #rightCols 里有 2 个列（.col-1 + .col-2），第二次调用返回 false',
    c1.ok && cOpen.r1 === true && cOpen.r2 === false,
    `${c1.actual} · openRightColumn: 第1次=${cOpen.r1} 第2次=${cOpen.r2} count ${cOpen.before}→${cOpen.after}`);
  const c2assert = await probe(page, () => {
    const c2 = window.__t.colInfo(2);
    return {
      ok: c2.present && !c2.hidden && c2.w >= 240 && c2.left >= 0 && c2.right <= innerWidth + 1
        && c2.top >= 0 && c2.bottom <= innerHeight + 1,
      actual: `col2: w=${c2.w} left=${c2.left} right=${c2.right} top=${c2.top} bottom=${c2.bottom} innerWidth=${window.innerWidth} innerHeight=${window.innerHeight}`,
    };
  });
  check('C2 第二栏在视口内且宽 ≥240px', c2assert.ok, c2assert.actual);
  const c3 = await probe(page, () => {
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    const vr = { left: Math.round(viewer.left), right: Math.round(viewer.right), w: Math.round(viewer.width) };
    const o1 = window.__t.overlay(viewer, document.getElementById('rightSide').getBoundingClientRect());
    const c2r = document.getElementById('rightCol2').getBoundingClientRect();
    const o2 = window.__t.overlay(viewer, c2r);
    const c1l = Math.round(document.getElementById('rightSide').getBoundingClientRect().left);
    return {
      ok: !o1 && !o2 && viewer.width > 200 && vr.right <= c1l + 1,
      actual: `#viewer=${JSON.stringify(vr)} · col1.left=${c1l} · 与 col1 重叠=${JSON.stringify(o1)} · 与 col2 重叠=${JSON.stringify(o2)}`,
    };
  });
  check('C3 正文 #viewer 未与任何列重叠', c3.ok, c3.actual);
  const c4 = await probe(page, () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--right-w2').trim();
    const stored = JSON.parse(localStorage.getItem('reader.panels') || 'null') || {};
    const w2 = window.__state.panels.rightCols?.w2;
    return {
      ok: /^\d+(\.\d+)?px$/.test(v) && parseFloat(v) >= 240
        && Number(stored.rightCols?.w2) === Number(w2) && Number(w2) >= 240,
      actual: `--right-w2=${v || '(空)'} · __state.rightCols=${JSON.stringify(window.__state.panels.rightCols)}`
        + ` · localStorage.reader.panels.rightCols=${JSON.stringify(stored.rightCols)}`,
    };
  });
  check('C4 --right-w2 已写入且 localStorage.reader.panels.rightCols.w2 与之一致', c4.ok, c4.actual);
  const c5 = await probe(page, () => {
    const anchor = document.getElementById('rightColSplit');
    const wrap = document.getElementById('rightCols');
    return {
      ok: !!anchor && anchor.parentElement === wrap && anchor.previousElementSibling?.id === 'rightSide'
        && anchor.nextElementSibling?.id === 'rightCol2',
      actual: `#rightCols 子节点顺序=[${[...(wrap?.children || [])].map((x) => x.id || x.className).join(' → ')}]`,
    };
  });
  check('C5 列顺序仍是 #splitRight + .col-1 + #rightColSplit(.col-2)', c5.ok, c5.actual);
  await shot('C-two-cols');

  /* ══════════════════════════════ D. 稳定身份 ══════════════════════════════ */
  section('D. 稳定身份：translate 放进第 2 栏，塞一条 .msg，隐藏→显示后节点还是同一个、滚动位置保留');
  // 前置 ①：translate 先放进第 1 栏 —— 那里已经有 chat，**同栏互斥**应当把 chat 收起。
  // 前置 ②：再把 translate 放到第 2 栏 —— 第 1 栏空出来，chat 得以显示（第 2 栏的意义就是并排）。
  const dSetup = await page.evaluate(() => {
    window.__ctx.setPanelColumn('translate', 1);
    const sameCol = {
      tCol: window.__state.panels.translate.col, cCol: window.__state.panels.chat.col,
      tVis: window.__state.panels.translate.visible, cVis: window.__state.panels.chat.visible,
    };
    window.__ctx.setPanelVisible('chat', false);
    window.__ctx.setPanelColumn('translate', 2);
    window.__ctx.setPanelColumn('chat', 1);
    const split = {
      tCol: window.__state.panels.translate.col, cCol: window.__state.panels.chat.col,
      tVis: window.__state.panels.translate.visible, cVis: window.__state.panels.chat.visible,
    };
    return { sameCol, split };
  });
  await sleep(300);
  check('D1a 同栏互斥：translate 放进 chat 所在的第 1 栏 → chat 被收起',
    dSetup.sameCol.tCol === 1 && dSetup.sameCol.cCol === 1
      && dSetup.sameCol.tVis === true && dSetup.sameCol.cVis === false,
    `setPanelColumn('translate',1) 之后：${JSON.stringify(dSetup.sameCol)}`);
  const d1 = await probe(page, (info) => {
    const tb = window.__t.block('translate');
    const area2 = document.getElementById('aiArea2');
    const s = window.__state.panels;
    return {
      ok: !!tb && !!area2 && tb.parentElement === area2 && window.__t.vis(tb)
        && s.translate.col === 2 && s.translate.visible === true && s.translate.dock === 'right'
        && s.rightCols.count === 2
        && s.chat.col === 1 && s.chat.visible === true
        && !document.querySelector('#aiArea > .ai-block[data-block="translate"]'),
      actual: `分栏后 state=${JSON.stringify(info.split)}`
        + ` · rightCols.count=${s.rightCols.count}`
        + ` · translate 节点父容器=#${tb?.parentElement?.id || tb?.parentElement?.className}`
        + ` · #aiArea 里有没有 translate=${!!document.querySelector('#aiArea > .ai-block[data-block="translate"]')}`
        + ` · 两栏各自的块=[#aiArea:${[...(document.getElementById('aiArea')?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`
        + `[#aiArea2:${[...(area2?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`,
    };
  }, dSetup);
  check('D1b setPanelColumn(\'translate\',2)：translate 落在 #aiArea2，第 1 栏里没有第二份',
    d1.ok, d1.actual);

  const dInject = await page.evaluate(() => {
    const tb = window.__t.block('translate');
    if (!tb) return { ok: false, actual: 'translate 块不存在' };
    const body = tb.querySelector('.ai-body');
    if (!body) return { ok: false, actual: '没有 .ai-body' };
    // 塞足够多的内容，保证 .ai-body 真的能滚（滚动位置断言要有意义，前提是它能滚）
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 40; i += 1) {
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.dataset.probe = 'stable-identity';
      msg.textContent = `PROBE-右栏稳定身份-${i}：这一段用来把 .ai-body 撑到可滚动，验证隐藏再显示之后节点与滚动位置都不丢。`;
      frag.append(msg);
    }
    body.append(frag);
    // 标记这个节点对象：隐藏→显示之后必须还是它
    const first = body.querySelector('.msg[data-probe="stable-identity"]');
    first.dataset.marker = 'MARK-1';
    body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) * 0.6);
    const before = { count: body.querySelectorAll('.msg').length, scrollTop: body.scrollTop, sh: body.scrollHeight, ch: body.clientHeight };
    window.__dBefore = before;
    return { ok: true, actual: `塞入 ${before.count} 条 .msg · .ai-body scrollHeight=${before.sh} clientHeight=${before.ch} scrollTop=${before.scrollTop}` };
  });
  check('D2 第 2 栏的 .ai-body 里已有可滚动内容（D3 的前置条件）', dInject.ok, dInject.actual);

  const d3 = await page.evaluate(() => {
    const nodeBefore = window.__t.block('translate');
    window.__ctx.setPanelVisible('translate', false);
    const tb1 = window.__state.blockEls.translate;
    const hidden = {
      visible: window.__state.panels.translate.visible,
      // 实现细节（Lead 已说明）：隐藏的右栏面板节点**脱离文档**停放（#panelPark 不进 body），
      // 所以「还在不在」不看可见性，看「同一个节点对象还在 + 标记内容还在 + 关掉后脱离文档」。
      sameObject: tb1 === nodeBefore,
      connected: !!tb1?.isConnected,
      markupSurvives: !!tb1?.querySelector('.msg[data-marker="MARK-1"]'),
      vis: !!tb1 && !tb1.classList.contains('hidden') && tb1.getBoundingClientRect().width > 0,
      parentId: tb1?.parentElement?.id || '(无父节点)',
    };
    window.__ctx.setPanelVisible('translate', true);
    return hidden;
  });
  await sleep(400);
  const d3b = await probe(page, (hidden) => {
    const tb = window.__t.block('translate');
    const area2 = document.getElementById('aiArea2');
    const body = tb?.querySelector('.ai-body');
    const before = window.__dBefore || {};
    const first = body?.querySelector('.msg[data-probe="stable-identity"]');
    const same = !!first && first.dataset.marker === 'MARK-1';
    const restoredNode = !!tb && tb.isConnected && tb.parentElement === area2 && window.__t.vis(tb)
      && window.__state.panels.translate.visible === true && window.__state.panels.translate.col === 2;
    const after = body ? { count: body.querySelectorAll('.msg').length, scrollTop: body.scrollTop, sh: body.scrollHeight, ch: body.clientHeight } : {};
    const scrollSaved = before.scrollTop > 0 && Math.abs(after.scrollTop - before.scrollTop) <= 2;
    return {
      ok: hidden.visible === false && hidden.sameObject === true && hidden.connected === false
        && hidden.markupSurvives === true && hidden.vis === false
        && same && restoredNode && scrollSaved,
      actual: `隐藏时：visible=${hidden.visible} 同一节点对象=${hidden.sameObject} 脱离文档=${!hidden.connected}`
        + ` 标记还在=${hidden.markupSurvives} 可见=${hidden.vis} 父容器=${hidden.parentId}`
        + ` · 显示后：回到 #aiArea2 且可见=${restoredNode}`
        + ` · .msg 数 ${before.count}→${after.count} · MARK-1 还在同一个对象上=${same}`
        + ` · scrollTop ${before.scrollTop}→${after.scrollTop}（差 ${Math.abs((after.scrollTop || 0) - (before.scrollTop || 0))}px，容差 2）`
        + ` · scrollHeight ${before.sh}→${after.sh} clientHeight ${before.ch}→${after.ch}`,
    };
  }, d3);
  check('D3 隐藏→显示后 .msg 还在、节点是同一个对象、滚动位置保留', d3b.ok, d3b.actual);
  const d4 = await probe(page, () => {
    const tb = window.__t.block('translate');
    const cb = window.__t.block('chat');
    return {
      ok: !!tb && tb.parentElement?.id === 'aiArea2' && (!cb || cb.parentElement?.id !== 'aiArea2')
        && document.querySelectorAll('#aiArea2 .ai-block[data-block="translate"]').length === 1,
      actual: `#aiArea2.children=[${[...(document.getElementById('aiArea2')?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`
        + ` · #aiArea.children=[${[...(document.getElementById('aiArea')?.children || [])].map((x) => x.dataset.block || x.className).join(',')}]`,
    };
  });
  check('D4 恢复后第 2 栏里就是 translate 块本身（没有复制出第二份）', d4.ok, d4.actual);

  // D5：一栏只开一个 —— 状态被外力改成「同栏两块都 visible」时，第 1 栏最多渲染一块
  const d5 = await page.evaluate(() => {
    const s = window.__state.panels;
    const keep = { tCol: s.translate.col, tVis: s.translate.visible, cCol: s.chat.col, cVis: s.chat.visible };
    // 故意制造非法状态：两块都归属第 1 栏、都 visible
    s.chat.col = 1; s.chat.visible = true;
    window.__ctx.setPanelColumn('translate', 1);
    window.__ctx.setPanelVisible('chat', true);
    const area = document.getElementById('aiArea');
    const blocks = [...area.querySelectorAll(':scope > .ai-block')];
    const res = {
      keep,
      rendered: blocks.map((b) => b.dataset.block),
      visCount: blocks.filter((b) => !b.classList.contains('hidden')).length,
      tVis: s.translate.visible, cVis: s.chat.visible,
    };
    // 还原成 D 段结束时的样子，别影响后面的段落
    window.__ctx.setPanelColumn('translate', 2);
    return res;
  });
  check('D5 一栏只开一个：同栏两块都被置 visible 时，第 1 栏也只渲染一块（状态被外力改坏也能兜住）',
    d5.rendered.length <= 1 && d5.visCount <= 1,
    `制造「两块同栏 + 都 visible」后 #aiArea 渲染=[${d5.rendered.join(',')}] 可见块数=${d5.visCount}`
    + ` · state translate.visible=${d5.tVis} chat.visible=${d5.cVis}`
    + ` · setPanelColumn 会把同栏另一块收起 → 期望渲染 ≤1 块`);

  // D6：滚动记忆不能是「只对隐藏/显示那一次有效」—— 换栏（第 2 栏 → 第 1 栏 → 第 2 栏）后也要回到原位置
  //    （换栏走的是 setPanelColumn，节点会被搬到另一个结果区，比隐藏/显示更容易把滚动位置丢掉）
  const d6 = await page.evaluate(() => {
    const body = window.__state.blockEls.translate?.querySelector('.ai-body');
    if (!body) return { ok: false, actual: 'translate 的 .ai-body 不存在' };
    body.scrollTop = Math.max(60, Math.round((body.scrollHeight - body.clientHeight) * 0.5));
    const want = body.scrollTop;
    const msgsBefore = body.querySelectorAll('.msg').length;
    window.__ctx.setPanelColumn('translate', 1);
    const mid = window.__state.blockEls.translate?.querySelector('.ai-body')?.scrollTop ?? -1;
    window.__ctx.setPanelColumn('translate', 2);
    const after = window.__state.blockEls.translate?.querySelector('.ai-body')?.scrollTop ?? -1;
    const msgsAfter = window.__state.blockEls.translate?.querySelector('.ai-body')?.querySelectorAll('.msg').length ?? -1;
    const parent = window.__state.blockEls.translate?.parentElement?.id || '(脱离文档)';
    return {
      ok: want > 0 && Math.abs(after - want) <= 2 && msgsAfter === msgsBefore && msgsBefore >= 40,
      actual: `换栏前 scrollTop=${want}（.msg ${msgsBefore} 条）· 换到第 1 栏时=${mid} · 换回第 2 栏后=${after}`
        + `（期望 ${want}±2）· .msg 数=${msgsAfter} · 节点在=#${parent}`,
    };
  });
  check('D6 换栏（第 2 栏 → 第 1 栏 → 第 2 栏）后 .ai-body 滚动位置与消息条数都保留', d6.ok, d6.actual);
  await shot('D-stable-identity');

  /* ══════════════════════════════ E. 只许右侧 ══════════════════════════════ */
  section('E. 只许右侧：dockPanelTo(\'translate\',\'left\'|\'bottom\') 不许把它搬走');
  const eSetup = await page.evaluate(() => {
    window.__ctx.setPanelColumn('chat', 1);
    return true;
  });
  await sleep(250);
  const e1 = await probe(page, () => {
    const before = JSON.parse(JSON.stringify(window.__state.panels.translate));
    const rLeft = window.__ctx.dockPanelTo('translate', 'left');
    const midLeft = JSON.parse(JSON.stringify(window.__state.panels.translate));
    const rBottom = window.__ctx.dockPanelTo('translate', 'bottom');
    const after = JSON.parse(JSON.stringify(window.__state.panels.translate));
    const inLeft = !!document.querySelector('#leftSide .ai-block[data-block="translate"]');
    const inBottom = !!document.querySelector('#dockBottom .ai-block[data-block="translate"], #dockBottom [data-panel="translate"]');
    const tb = window.__t.block('translate');
    return {
      ok: rLeft === false && rBottom === false && after.dock === 'right' && after.col === 2 && after.visible === true
        && !inLeft && !inBottom && tb?.parentElement?.id === 'aiArea2',
      actual: `dockPanelTo(left)=${rLeft} dockPanelTo(bottom)=${rBottom}`
        + ` · translate: ${JSON.stringify(before)} → ${JSON.stringify(after)}（中途 ${JSON.stringify(midLeft)}）`
        + ` · 左栏里有译文块=${inLeft} · 底部停靠区里有译文块=${inBottom}`
        + ` · 节点父容器=#${tb?.parentElement?.id || '(不在 DOM)'}`
        + ` · #dockBottom children=${document.getElementById('dockBottom')?.children.length}`,
    };
  });
  check('E1 返回 false，且 dock/col/visible 与 DOM 位置全不变（仍在第 2 栏）', e1.ok, e1.actual);
  const e2 = await probe(page, () => {
    const r = window.__ctx.dockPanelTo('translate', 'right');
    const s = window.__state.panels.translate;
    return {
      ok: r === false && s.dock === 'right' && s.col === 2,
      actual: `同区停靠返回=${r} · dock=${s.dock} col=${s.col}`,
    };
  });
  check('E2 同区停靠（right→right）返回 false、状态不变', e2.ok, e2.actual);
  const e3 = await probe(page, () => {
    const btns = [...document.querySelectorAll('#panelDock .dock-btn')].map((b) => b.dataset.dockFor);
    const inLeftRail = btns.includes('translate') || btns.includes('chat');
    let menuOffers = '';
    // 面板管理器里不应该再给出「停靠到左 / 底」能成功的假入口（有也无所谓，但不能真的搬走 —— E1 已验）
    return {
      ok: !inLeftRail,
      actual: `左栏图标坞=[${btns.join(',')}] · 含译/问=${inLeftRail}${menuOffers}`,
    };
  });
  check('E3 左栏图标坞里没有「译 / 问」入口', e3.ok, e3.actual);
  await shot('E-right-only');

  /* ══════════════════════════════ F. 右键菜单「再开一栏」 ══════════════════════════════ */
  section('F. 右键右栏图标 → #dockMenu 出现「再开一栏」，点它列数变 2');
  // 本段前提：宽窗（第 2 栏只有放得下时才真的在布局里；窄窗会被 body.right-col2-off 临时隐藏）。
  // 上一轮 F1/F3 的假红就是这么来的 —— I 段把视口压成 800 之后没有还原。
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(400);
  check('F0 本段前提：宽窗 1600×1000 且右栏未被自动收起',
    await page.evaluate(() => window.innerWidth === 1600 && !document.body.classList.contains('no-right')),
    await page.evaluate(() => `innerWidth=${window.innerWidth} · body.no-right=${document.body.classList.contains('no-right')}`));
  // 先把状态收回到 1 列（把 translate 留在第 2 栏，列数 1 时它自动收起——正常路径）
  await page.evaluate(() => { window.__ctx.setPanelVisible('translate', false); });
  const fBack = await page.evaluate(() => {
    // 函数能不能调、返回什么、列数变没变，**都在页面里判定**：
    // 把函数对象本身带出来会经过 puppeteer 的序列化（typeof 会变成 'object'），上一轮 F1 就是被这个坑骗的。
    const fn = window.__ctx?.closeRightColumn;
    const type = typeof fn;
    let r = null;
    try { r = typeof window.__ctx.closeRightColumn === 'function' ? window.__ctx.closeRightColumn() : '(不可调用)'; } catch (e) { r = 'throw:' + e.message; }
    return { type, r, count: window.__state.panels.rightCols.count };
  });
  await sleep(300);
  check('F1 前置：closeRightColumn() 可调用并把列数收回 1',
    fBack.type === 'function' && fBack.r === true && fBack.count === 1,
    `页面内 typeof=${fBack.type} 返回=${fBack.r} count=${fBack.count}`);

  const fOpen = await page.evaluate(() => {
    const btn = window.__t.rbtn('chat', 1);
    if (!btn) return { ok: false, actual: '找不到 #aiBar 里 chat 的 .aibar-btn（右栏唯一入口）' };
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return { ok: true, actual: `已派发 contextmenu 到 #aiBar 的 chat 按钮（${btn.dataset.block}）` };
  });
  await sleep(200);
  // 点之前先记一份「第 2 栏此刻为什么不可见」的现场：count / body 类 / col2.hidden / computed display / 宽度
  const fPre = await page.evaluate(() => {
    const c2 = document.getElementById('rightCol2');
    const cs = c2 ? getComputedStyle(c2) : null;
    return {
      count: window.__state.panels.rightCols.count,
      bodyCls: document.body.className,
      noRight: document.body.classList.contains('no-right'),
      col2Off: document.body.classList.contains('right-col2-off'),
      c2exists: !!c2, c2hidden: c2?.hidden ?? null,
      display: cs?.display ?? '(无 #rightCol2)',
      w: c2 ? Math.round(c2.getBoundingClientRect().width) : -1,
      bodyH: document.body.className,
      innerWidth: window.innerWidth,
    };
  });
  const f1 = await probe(page, (opened) => {
    const menu = document.getElementById('dockMenu');
    const items = [...(menu?.querySelectorAll('button') || [])].map((b) => (b.textContent || '').trim());
    const rect = menu?.getBoundingClientRect();
    return {
      ok: opened.ok === true && !!menu && !menu.classList.contains('hidden')
        && !!rect && rect.width > 0 && rect.height > 0
        && items.some((t) => t.includes('再开一栏')),
      actual: `${opened.actual} · #dockMenu=${!!menu} 可见=${!!(rect && rect.width > 0)} · 菜单项=${JSON.stringify(items)}`,
    };
  }, fOpen);
  check('F2 contextmenu → #dockMenu 出现且含「再开一栏」', f1.ok, f1.actual);
  await shot('F2-dock-menu');

  const fClick = await page.evaluate(() => {
    const menu = document.getElementById('dockMenu');
    if (!menu) return { ok: false, actual: '#dockMenu 不存在' };
    const items = [...menu.querySelectorAll('button')];
    // 必须**精确**点「再开一栏」那一项：「放到第 2 栏」在菜单里排在它前面，
    // 用宽泛的 /第 2 栏/ 去 find 会点错项（上一轮就是这么误报的）。
    const want = items.find((b) => (b.textContent || '').includes('再开一栏'));
    if (!want) return { ok: false, actual: `没有「再开一栏」项：${JSON.stringify(items.map((b) => b.textContent))}` };
    const text = (want.textContent || '').trim();
    want.click();
    // 点击处理是同步的，这里立刻回读一次（不等 rAF / resize 回调）
    const c2 = document.getElementById('rightCol2');
    return {
      ok: true,
      actual: `点了「${text}」`,
      sync: {
        count: window.__state.panels.rightCols.count,
        col2Off: document.body.classList.contains('right-col2-off'),
        noRight: document.body.classList.contains('no-right'),
        c2hidden: c2?.hidden ?? null,
        display: c2 ? getComputedStyle(c2).display : '(无 #rightCol2)',
        w: c2 ? Math.round(c2.getBoundingClientRect().width) : -1,
      },
    };
  });
  check('F2b 本段前提：点之前第 2 栏确实是「列数=1、没有 #rightCol2」的干净态',
    fPre.count === 1 && !fPre.col2Off && !fPre.noRight && fPre.innerWidth === VIEW_W,
    `点之前现场：${JSON.stringify(fPre)}`);
  await sleep(500);
  const f3 = await probe(page, (clicked) => {
    const asides = window.__t.cols();
    const c2 = window.__t.colInfo(2);
    const menuGone = !document.getElementById('dockMenu');
    const c2node = document.getElementById('rightCol2');
    const bodyCls = document.body.className;
    return {
      ok: clicked.ok === true && window.__state.panels.rightCols.count === 2
        && asides.length === 2 && c2.present && !c2.hidden && c2.w >= 240 && menuGone,
      actual: `${clicked.actual} · 点击同步回读=${JSON.stringify(clicked.sync)}`
        + ` · rightCols.count=${window.__state.panels.rightCols.count}`
        + ` · 列数=${asides.length} · col2=${JSON.stringify(c2)}`
        + ` · #rightCol2.hidden=${c2node?.hidden} · body.class="${bodyCls}"`
        + ` · 菜单已收=${menuGone}`,
    };
  }, fClick);
  check('F3 点「再开一栏」后列数=2（等价 openRightColumn()），菜单自动收起', f3.ok, f3.actual);

  // F4：现场取证 —— 把「第 2 栏为什么不可见」钉死到具体来源（[hidden] 属性 / body.right-col2-off / 宽度 0）
  const f4 = await page.evaluate(() => {
    const c2 = document.getElementById('rightCol2');
    return {
      count: window.__state.panels.rightCols.count,
      innerWidth: window.innerWidth,
      bodyCls: document.body.className,
      col2Off: document.body.classList.contains('right-col2-off'),
      noRight: document.body.classList.contains('no-right'),
      hidden: c2?.hidden ?? '(无 #rightCol2)',
      inlineDisplay: c2?.style?.display || '',
      computedDisplay: c2 ? getComputedStyle(c2).display : '(无 #rightCol2)',
      width: c2 ? Math.round(c2.getBoundingClientRect().width) : -1,
      offLeft: document.getElementById('rightSide')?.getBoundingClientRect().left,
      viewerW: Math.round(document.getElementById('viewer').getBoundingClientRect().width),
    };
  });
  check('F4 现场取证：第 2 栏不可见的原因归类（只记录实测，用于定责）',
    f4.count === 2 && f4.col2Off === false && f4.hidden === false && f4.width >= 240 && !f4.noRight,
    `count=${f4.count} innerWidth=${f4.innerWidth} body.class="${f4.bodyCls}"`
    + ` · right-col2-off=${f4.col2Off} no-right=${f4.noRight}`
    + ` · #rightCol2.hidden=${f4.hidden} inline.display="${f4.inlineDisplay}" computed.display=${f4.computedDisplay}`
    + ` · col2 宽=${f4.width} col1.left=${f4.offLeft} #viewer 宽=${f4.viewerW}`);

  // F5：收 → 再开 的可恢复性（这是「窄窗临时隐藏后窗口变宽要能自己回来」的最小复现）
  const f5 = await page.evaluate(() => {
    const read = () => {
      const c2 = document.getElementById('rightCol2');
      return {
        count: window.__state.panels.rightCols.count,
        col2Off: document.body.classList.contains('right-col2-off'),
        exists: !!c2, hidden: c2?.hidden ?? null,
        display: c2 ? getComputedStyle(c2).display : '(无)',
        w: c2 ? Math.round(c2.getBoundingClientRect().width) : -1,
      };
    };
    const before = read();
    window.__ctx.closeRightColumn();
    const afterClose = read();
    window.__ctx.openRightColumn();
    const afterOpen = read();
    return { before, afterClose, afterOpen, innerWidth: window.innerWidth };
  });
  check('F5 收第 2 栏 → 再开：`#rightCol2` 必须从 display:none 恢复成可见',
    f5.afterClose.count === 1 && f5.afterOpen.count === 2
      && f5.afterOpen.exists && f5.afterOpen.hidden === false
      && f5.afterOpen.display !== 'none' && f5.afterOpen.w >= 240 && f5.afterOpen.col2Off === false,
    `innerWidth=${f5.innerWidth} · 收之前=${JSON.stringify(f5.before)}`
    + ` · closeRightColumn 后=${JSON.stringify(f5.afterClose)}`
    + ` · openRightColumn 后=${JSON.stringify(f5.afterOpen)}`);

  /* ══════════════════════════════ G. 拖动图标出应用内卡片 ══════════════════════════════ */
  section('G. 拖动右栏图标：>18px 打开应用内卡片，<18px 不触发');
  // 本段前提：宽窗（窄窗下右栏会被 no-right 收起，图标坞也就没有布局矩形）
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(300);
  // 先把两块都收起来（1 列状态），避免拖动被面板状态干扰
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('translate', false);
    window.__ctx.setPanelVisible('chat', false);
    window.__ctx.closeRightColumn();
    window.__openCalls = [];
  });
  await sleep(350);
  const gRect = await page.evaluate(() => {
    const btn = window.__t.rbtn('chat', 1);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('G1 前置：第 1 栏图标坞按钮可点（拿到中心坐标）', !!gRect, gRect ? JSON.stringify(gRect) : '找不到按钮');
  const gPatched = await page.evaluate(() => ({
    patched: typeof window.__openPatched === 'boolean' && window.__openPatched === true,
    detachedHook: typeof window.__prtDetached,
  }));
  check('G2 观测手段就位：window.open 已打桩（应保持零调用）', gPatched.patched, `__prtDetached=${gPatched.detachedHook}（新契约不创建子窗口）`);

  // G3：短拖动（6px）→ 不该打开卡片，也不该调 window.open
  await page.evaluate(() => { window.__openCalls = []; });
  if (gRect) {
    await page.mouse.move(gRect.x, gRect.y);
    await page.mouse.down();
    await page.mouse.move(gRect.x + 6, gRect.y, { steps: 3 });
    await page.mouse.up();
  }
  await sleep(350);
  const g3 = await probe(page, (gr) => {
    const calls = window.__openCalls || [];
    const s = window.__state.panels.chat;
    return {
      ok: gr === true && calls.length === 0 && !window.__t.rbtn('chat', 1)?.dataset.justDragged,
      actual: `位移 6px · window.open 调用=${JSON.stringify(calls)}`
        + ` · justDragged=${window.__t.rbtn('chat', 1)?.dataset.justDragged || '(无)'}`
        + ` · chat.visible=${s.visible}`,
    };
  }, !!gRect);
  check('G3 位移 <18px 松手不触发卡片（window.open 零调用）', g3.ok, g3.actual);

  // G4：长拖动（80px）→ 打开阅读器内部卡片；点击外部不自动消失；显式按钮收回
  await page.evaluate(() => { window.__openCalls = []; });
  if (gRect) {
    await page.mouse.move(gRect.x, gRect.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(gRect.x - 80 * (i / 8), gRect.y, { steps: 1 }); }
    await page.mouse.up();
  }
  await sleep(700);
  const g4 = await probe(page, (gr) => {
    const calls = window.__openCalls || [];
    const p = window.__state.panels.chat;
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    return {
      ok: gr === true && calls.length === 0 && p.dock === 'float' && p.visible === true && !!card
        && card.isConnected && card.parentElement?.id === 'floatLayer',
      actual: `位移 80px · window.open 调用 ${calls.length} 次=${JSON.stringify(calls)}`
        + ` · dock=${p.dock} visible=${p.visible} · 卡片=${!!card}`,
    };
  }, !!gRect);
  check('G4 位移 >18px 打开应用内卡片（无新窗口 / 无暂离标记）', g4.ok, g4.actual);
  const g4Focus = await page.evaluate(() => {
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    if (!card) return null;
    const css = getComputedStyle(card);
    return {
      focused: card.classList.contains('focused'),
      opacity: css.opacity,
      background: css.backgroundColor,
      border: css.borderTopColor,
      noRight: document.body.classList.contains('no-right'),
    };
  });
  check('G4b 选中浮窗不变浅，只改变边框层级；右栏自动收起',
    !!g4Focus && g4Focus.focused && g4Focus.opacity === '1' && g4Focus.noRight,
    JSON.stringify(g4Focus));

  // G4c：拖到普通左侧 / 底部区域都不能回栏，仍保持应用内卡片。
  const ordinaryDrag = await page.evaluate(() => {
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    const head = card?.querySelector('.ai-head, .sec-head');
    const r = head?.getBoundingClientRect();
    return r ? { x: r.left + Math.min(90, r.width / 2), y: r.top + r.height / 2 } : null;
  });
  if (ordinaryDrag) {
    await page.mouse.move(ordinaryDrag.x, ordinaryDrag.y);
    await page.mouse.down();
    await page.mouse.move(90, Math.min(VIEW_H - 120, ordinaryDrag.y + 180), { steps: 8 });
    await page.mouse.up();
  }
  await sleep(300);
  const g4c = await page.evaluate(() => ({
    dock: window.__state.panels.chat.dock,
    card: !!document.querySelector('#floatLayer > .panel-float[data-panel="chat"]'),
    noRight: document.body.classList.contains('no-right'),
  }));
  check('G4c 普通左侧 / 底部区域松手不会回右栏', g4c.dock === 'float' && g4c.card && g4c.noRight, JSON.stringify(g4c));

  // G4d：只有最后几像素的最右边界才触发回栏。
  const edgeDrag = await page.evaluate(() => {
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    const head = card?.querySelector('.ai-head, .sec-head');
    const r = head?.getBoundingClientRect();
    return r ? { x: r.left + Math.min(90, r.width / 2), y: r.top + r.height / 2 } : null;
  });
  if (edgeDrag) {
    await page.mouse.move(edgeDrag.x, edgeDrag.y);
    await page.mouse.down();
    await page.mouse.move(VIEW_W - 2, edgeDrag.y, { steps: 12 });
    await page.mouse.up();
  }
  await sleep(450);
  const g4d = await page.evaluate(() => ({
    dock: window.__state.panels.chat.dock,
    card: !!document.querySelector('#floatLayer > .panel-float[data-panel="chat"]'),
    noRight: document.body.classList.contains('no-right'),
    rightDisplay: getComputedStyle(document.getElementById('rightSide') || document.body).display,
  }));
  check('G4d 只有贴近最右边界松手才回到右栏', g4d.dock === 'right' && !g4d.card && !g4d.noRight, JSON.stringify(g4d));

  // G4e：回栏后再次打开浮窗，标题栏的明确收回按钮仍可用。
  await page.evaluate(() => window.__ctx.detachPanelToWindow('chat'));
  await sleep(350);
  const g4Outside = await page.evaluate(() => {
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    const before = card?.getBoundingClientRect();
    document.getElementById('viewer')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 300 }));
    document.getElementById('viewer')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
    const after = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    return { same: !!after && after === card, dock: window.__state.panels.chat.dock, before: before ? { w: before.width, h: before.height } : null };
  });
  check('G5 点击阅读器其他区域不会自动关闭卡片', g4Outside.same && g4Outside.dock === 'float', JSON.stringify(g4Outside));
  const g4Close = await page.evaluate(() => {
    const card = document.querySelector('#floatLayer > .panel-float[data-panel="chat"]');
    card?.querySelector('.panel-float-x')?.click();
    return true;
  });
  await sleep(450);
  const g4Redock = await page.evaluate(() => ({
    dock: window.__state.panels.chat.dock,
    visible: window.__state.panels.chat.visible,
    card: !!document.querySelector('#floatLayer > .panel-float[data-panel="chat"]'),
    right: window.__state.panels.chat.home,
  }));
  check('G6 只有点卡片自己的收回按钮才回到右栏', g4Close && g4Redock.dock === 'right' && g4Redock.visible === true && !g4Redock.card,
    JSON.stringify(g4Redock));
  await shot('G4-drag-out');
  // 收尾：保持 H 的前置状态干净
  await page.evaluate(() => {
    localStorage.setItem('reader.detachedWindows', '{}');
    window.__openCalls = [];
    window.__ctx.setPanelVisible('chat', false);
  });
  await sleep(300);

  /* ══════════════════════════════ H. 持久化 ══════════════════════════════ */
  section('H. 持久化：开第 2 栏 + translate 在第 2 栏 + 两块都可见 → reload 后不变');
  // 本段前提：宽窗（第 2 栏要真的在布局里，「两块都可见」才量得到矩形）
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(400);
  const hSetup = await page.evaluate(() => {
    // G4 把 chat 拖成了「暂离」（detachedWindows 里有标记、面板被收起），
    // 这里先彻底清账再重新摆好两栏两块，否则 H1 会踩到 G 的残留（上一轮就是这么误报的）。
    localStorage.removeItem('reader.detachedWindows');
    window.__ctx.openRightColumn();
    window.__ctx.setPanelVisible('translate', true);
    window.__ctx.setPanelColumn('translate', 2);
    window.__ctx.setPanelVisible('chat', true);
    window.__ctx.setPanelColumn('chat', 1);
    window.__ctx.applyPanels();
    return true;
  });
  await sleep(500);
  const hBefore = await probe(page, (did) => {
    const s = window.__state.panels;
    const tb = window.__state.blockEls.translate;
    const cb = window.__state.blockEls.chat;
    const col1 = window.__ctx.rightPanelInCol ? window.__ctx.rightPanelInCol(1) : '(未暴露)';
    return {
      ok: did === true && s.rightCols.count === 2 && s.translate.col === 2 && s.chat.col === 1
        && s.translate.visible === true && s.chat.visible === true
        && tb?.parentElement?.id === 'aiArea2' && cb?.parentElement?.id === 'aiArea'
        && window.__t.vis(tb) && window.__t.vis(cb),
      actual: `count=${s.rightCols.count} w2=${s.rightCols.w2}`
        + ` · translate{dock:${s.translate.dock},col:${s.translate.col},vis:${s.translate.visible}}`
        + ` · chat{dock:${s.chat.dock},col:${s.chat.col},vis:${s.chat.visible}}`
        + ` · rightPanelInCol(1)=${col1}`
        + ` · innerWidth=${window.innerWidth} body.class="${document.body.className}"`
        + ` · #rightCol2{hidden:${document.getElementById('rightCol2')?.hidden},`
        + `inline:${JSON.stringify(document.getElementById('rightCol2')?.style?.display || '')},`
        + `computed:${document.getElementById('rightCol2') ? getComputedStyle(document.getElementById('rightCol2')).display : '(不存在)'}}`
        + ` · translate 在=#${tb?.parentElement?.id}（isConnected=${!!tb?.isConnected}）`
        + ` · chat 在=#${cb?.parentElement?.id}（isConnected=${!!cb?.isConnected}）`
        + ` · 两块都可见=${window.__t.vis(tb)}/${window.__t.vis(cb)}`
        + ` · detachedWindows=${localStorage.getItem('reader.detachedWindows')}`,
    };
  }, hSetup);
  check('H1 reload 前状态正确（2 列 + 两块分属两栏 + 都可见，测试前置条件）', hBefore.ok, hBefore.actual);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__state && !!document.getElementById('rightCols'), { timeout: 25000 });
  await sleep(900);
  await installHelpers();   // reload 会清掉页面上下文，注入的工具要重新装一次
  const h2 = await probe(page, () => {
    const s = window.__state.panels;
    const tb = window.__t.block('translate');
    const cb = window.__t.block('chat');
    const asides = window.__t.cols();
    const c2 = window.__t.colInfo(2);
    return {
      ok: s.rightCols.count === 2 && asides.length === 2 && c2.present && !c2.hidden && c2.w >= 240
        && s.translate.col === 2 && s.chat.col === 1
        && s.translate.visible === true && s.chat.visible === true
        && tb?.parentElement?.id === 'aiArea2' && cb?.parentElement?.id === 'aiArea'
        && window.__t.vis(tb) && window.__t.vis(cb),
      actual: `count=${s.rightCols.count} w2=${s.rightCols.w2} · 列数=${asides.length} col2=${JSON.stringify(c2)}`
        + ` · translate.col=${s.translate.col}/vis=${s.translate.visible} 在=#${tb?.parentElement?.id}`
        + ` · chat.col=${s.chat.col}/vis=${s.chat.visible} 在=#${cb?.parentElement?.id}`
        + ` · 两块都可见=${window.__t.vis(tb)}/${window.__t.vis(cb)}`,
    };
  });
  check('H2 page.reload() 后仍是 2 列、col 归属不变、两块都还可见', h2.ok, h2.actual);
  await shot('H-after-reload');

  /* ══════════════════════════════ I. 窄窗 ══════════════════════════════ */
  section('I. 窄窗 800×900：不应出现横向滚动条，正文宽度 > 200px');
  // I1 是「窄窗 1 列」：先在**宽窗**下把第 2 栏收掉（否则窄窗那一刻量到的是「临时藏掉第 2 栏」的形态），
  // 口径（与 Lead 核对）：窄窗**只**加 body.right-col2-off / no-right，**绝不写模型**。
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(400);
  const iSetup = await page.evaluate(() => {
    const before = window.__state.panels.rightCols.count;
    const r = window.__ctx.closeRightColumn();
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('reader.panels') || '{}').rightCols; } catch { /* 忽略 */ }
    return { before, r, count: window.__state.panels.rightCols.count, stored, innerWidth: window.innerWidth };
  });
  await sleep(300);
  check('I0 本段前提：宽窗下已收成 1 列并存盘',
    iSetup.count === 1 && Number(iSetup.stored?.count) === 1 && iSetup.innerWidth === VIEW_W,
    `closeRightColumn() 前 count=${iSetup.before} 返回=${iSetup.r} · 之后 state.count=${iSetup.count}`
    + ` · localStorage.rightCols=${JSON.stringify(iSetup.stored)} · innerWidth=${iSetup.innerWidth}`);

  await page.setViewport({ width: NARROW_W, height: NARROW_H });
  await sleep(700);
  const i1 = await probe(page, (nw) => {
    const se = document.scrollingElement;
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    const stored = JSON.parse(localStorage.getItem('reader.panels') || '{}').rightCols;
    return {
      ok: se.scrollWidth <= innerWidth + 1 && viewer.width > 200,
      actual: `innerWidth=${innerWidth} · scrollWidth=${se.scrollWidth}（限 ${innerWidth + 1}）`
        + ` · #viewer 宽=${Math.round(viewer.width)}（>200）· body.no-right=${document.body.classList.contains('no-right')}`
        + ` · 存档 rightCols=${JSON.stringify(stored)} · 期望视口 ${nw}`,
    };
  }, NARROW_W);
  check('I1 窄窗 1 列：无横向滚动条，正文 >200px', i1.ok, i1.actual);
  await shot('I1-narrow-1col');

  // I2/I3/I4：在**窄窗**下明确表达「用户要 2 列」——模型必须记 2 列，而窄窗只做临时隐藏
  const i2Setup = await page.evaluate(() => {
    const before = window.__state.panels.rightCols.count;
    const r = window.__ctx.openRightColumn();
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('reader.panels') || '{}').rightCols; } catch { /* 忽略 */ }
    return { before, r, count: window.__state.panels.rightCols.count, stored, innerWidth: window.innerWidth };
  });
  await sleep(800);
  check('I2 前置：窄窗下 openRightColumn() 仍要落成模型 2 列（窄窗不是「不给你开」，只是暂时看不到）',
    i2Setup.before === 1 && i2Setup.r === true && i2Setup.count === 2 && Number(i2Setup.stored?.count) === 2,
    `窄窗 ${i2Setup.innerWidth}px · openRightColumn() 前=${i2Setup.before} 返回=${i2Setup.r}`
    + ` · state.count=${i2Setup.count} · localStorage.rightCols=${JSON.stringify(i2Setup.stored)}`);
  const i2r = await probe(page, () => {
    const se = document.scrollingElement;
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    const c2 = window.__t.colInfo(2);
    const stored = JSON.parse(localStorage.getItem('reader.panels') || '{}').rightCols;
    return {
      ok: se.scrollWidth <= innerWidth + 1 && viewer.width > 200,
      actual: `窄窗（模型 2 列）：scrollWidth=${se.scrollWidth}（限 ${innerWidth + 1}）· #viewer 宽=${Math.round(viewer.width)}`
        + ` · col2=${JSON.stringify(c2)} · right-col2-off=${document.body.classList.contains('right-col2-off')}`
        + ` · no-right=${document.body.classList.contains('no-right')} · 存档 rightCols=${JSON.stringify(stored)}`,
    };
  });
  check('I3 窄窗下（模型仍是 2 列）仍无横向滚动条且正文 >200px', i2r.ok, i2r.actual);
  await shot('I2-narrow-2col');
  const i3 = await probe(page, () => {
    const stored = JSON.parse(localStorage.getItem('reader.panels') || '{}');
    return {
      ok: Number(stored.rightCols?.count) === 2 && Number(window.__state.panels.rightCols.count) === 2,
      actual: `存档 rightCols=${JSON.stringify(stored.rightCols)} · state.rightCols.count=${window.__state.panels.rightCols.count}`
        + `（窄窗只是临时隐藏，不该改用户意图）`
        + ` · body.right-col2-off=${document.body.classList.contains('right-col2-off')}`
        + ` · body.no-right=${document.body.classList.contains('no-right')}`,
    };
  });
  check('I4 窄窗只是临时隐藏：存档与模型都仍是「用户要 2 列」', i3.ok, i3.actual);

  // I5：窗口变宽后第 2 栏要自己回来（不需要用户重新点一次）
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(900);
  const i4 = await probe(page, () => {
    const c2 = window.__t.colInfo(2);
    const off = document.body.classList.contains('right-col2-off');
    const noRight = document.body.classList.contains('no-right');
    return {
      ok: c2.present && !c2.hidden && c2.w >= 240 && !off && !noRight
        && window.__state.panels.rightCols.count === 2,
      actual: `变宽后：innerWidth=${window.innerWidth} · col2=${JSON.stringify(c2)}`
        + ` · right-col2-off=${off} · no-right=${noRight} · count=${window.__state.panels.rightCols.count}`,
    };
  });
  check('I5 窗口变宽后第 2 栏自动回来（用户不用重新点一次）', i4.ok, i4.actual);

  /* ══════════════════════════════ J. 零页面错误 ══════════════════════════════ */
  section('J. 零页面错误（pageerror / console.error / 请求失败）');
  await page.setViewport({ width: VIEW_W, height: VIEW_H });
  await sleep(500);
  check('J1 全程 pageerror 为空', pageErrors.filter((x) => x.startsWith('pageerror')).length === 0,
    pageErrors.filter((x) => x.startsWith('pageerror')).join(' || ') || '(空)');
  check('J2 全程 console.error 为空', pageErrors.filter((x) => x.startsWith('console.error')).length === 0,
    pageErrors.filter((x) => x.startsWith('console.error')).join(' || ') || '(空)');
  check('J3 无失败请求', failedRequests.length === 0, failedRequests.join(' || ') || '(空)');
  }   // ← if (browser)：无头浏览器起不来时，A–J 这一段整体跳过（已在上面记 [XX]+BLOCKED）

  /* ══════════════════════════ 只读证明 ══════════════════════════ */
  section('隔离与只读核对');
  const cfgAfter = sha(REAL_CONFIG);
  check('真实 data/config.json 全程未被改动（SHA256 一致）', cfgAfter === REAL_CONFIG_BEFORE,
    `${REAL_CONFIG_BEFORE.slice(0, 16)}… → ${cfgAfter.slice(0, 16)}…`);
  const appAfter = sha(APP);
  check('本轮 public/js/app.js 未被本套件改动（跑前跑后 SHA 一致）', appAfter === APP_SHA,
    `${APP_SHA.slice(0, 16)}… → ${appAfter.slice(0, 16)}…`);
  check('隔离 papers 里只有合成论文，没有读到真实书架', fs.readdirSync(PAPERS).join(',') === 'right-cols-sample.pdf',
    `papers=[${fs.readdirSync(PAPERS).join(',')}] · 服务返回的书架数=1`);
} catch (e) {
  console.error('\n套件异常终止：', e && (e.stack || e.message || e));
  console.error('--- server log tail ---\n' + serverLog.slice(-1200));
  results.push({ section: currentSection, name: '套件异常终止', ok: false, actual: String(e && (e.message || e)) });
} finally {
  try { await browser?.close(); } catch { /* 忽略 */ }
  try { browserProc?.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { server?.kill('SIGKILL'); } catch { /* 忽略 */ }
  serverLog = server ? procLog(server) : serverLog;
  if (serverLog.trim()) console.log('\n--- 隔离服务日志（前 20 行）---\n' + serverLog.split('\n').slice(0, 20).join('\n'));
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/* ══════════════════════════ 汇总 ══════════════════════════ */
const failed = results.filter((r) => !r.ok);
const staticRows = results.filter((r) => r.kind === 'static');
const runtimeRows = results.filter((r) => r.kind === 'runtime');
const blockedRows = results.filter((r) => r.kind === 'blocked');
const okOf = (rows) => rows.filter((r) => r.ok).length;
console.log('\n══════════════════════════════════════════════════════════');
for (const r of failed) console.log(`[XX] ${r.section} | ${r.name}\n       实测：${r.actual}`);
console.log(`\n【静态契约审计】 ${okOf(staticRows)}/${staticRows.length} 符合契约`);
console.log(`【运行时断言】   ${okOf(runtimeRows)}/${runtimeRows.length} 通过`);
console.log(`【未验证】       ${blockedRows.length ? `A–J 未执行（无头浏览器被沙箱挡住）` : '无'}`);
console.log(`\n合计 ${okOf(results)}/${results.length} 条通过`);
console.log(`app.js SHA256 = ${APP_SHA}`);
console.log('══════════════════════════════════════════════════════════');
if (failed.length) process.exitCode = 1;
