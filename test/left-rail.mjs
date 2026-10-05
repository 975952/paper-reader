/**
 * 左栏「一次只开一个 / 活动栏选中态 / 点选中的收成活动栏」回归套件。
 *
 *   cd test && node left-rail.mjs
 *
 * 用户口径（2026-10-03，原话）：
 *   「左侧的栏收起和打开的逻辑不对，需要优化，左侧应该也做成一次只能打开一个。
 *     而且再次点击选中的就直接收起收成小的侧边栏。
 *     然后点击侧边栏应该出来的就是点击的哪一个。」
 *
 * 拆成可判定的规则：
 *   R1 左栏**同时只能显示一块**（开目录 → 文件自动收起；四块两两组合都要成立）
 *   R2 活动栏（40px，body.no-left 时出现）里的图标，点哪个就展开**哪一个**
 *   R3 点「当前正显示的那一块」的图标 → 整条左栏收成活动栏，且**块本身不隐藏**
 *     （收起来是为了腾地方，不是把内容关掉；再点同一个图标要原样回来）
 *   R4 活动栏里被选中的图标有可见的选中态，且只有**一个**（aria-current / .active）
 *   R5 选中项跟着「此刻真正显示的是哪一块」走 —— 显示谁就高亮谁，界面不许骗人
 *   R6 收起 → 展开 回来的是同一块（不会被换成默认的文件块）
 *   R7 刷新之后仍然记得上次选的是哪一块（reader.ui.leftActive）
 *   R8 一次只开一个这条规则不能把 p.collapsed（块内部折叠）一起改掉
 *   R9 全程零 JS 报错
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:\\Users\\Wang Wenbo\\Desktop\\prt';
const PORT = 8923;
const CDP_PORT = 9453;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
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
const fmt = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };

fs.mkdirSync(path.join(ROOT, 'test', 'artifacts', 'ug-left'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-left-'));
const DATA = path.join(tmp, 'data');
const PAPERS = path.join(tmp, 'papers');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
fs.copyFileSync(FIXTURE_PDF, path.join(PAPERS, 'left-sample.pdf'));

const REAL_CONFIG = path.join(ROOT, 'data', 'config.json');
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(读不到)'; } };
const REAL_CONFIG_BEFORE = sha(REAL_CONFIG);
const browserPath = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

console.log('══════════════════════════════════════════════════════════');
console.log('左栏：一次只开一个 / 活动栏选中态 / 点选中的收成活动栏');
console.log(`时间      : ${new Date().toLocaleString('zh-CN')}`);
console.log(`浏览器    : ${browserPath || '(没找到)'}`);
console.log('══════════════════════════════════════════════════════════');

let server = null;
let browser = null;
let browserProc = null;
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
      executablePath: exe, headless: true, userDataDir: path.join(tmp, 'profile-launch'),
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1400,900'],
      defaultViewport: { width: 1400, height: 900 },
    });
    return { browser: b, mode: 'puppeteer.launch' };
  } catch (e) { errors.push(`puppeteer.launch: ${e && e.message}`); }
  try {
    browserProc = spawnLogged(exe, [
      '--headless=new', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'profile-cdp')}`,
      '--window-size=1400,900', 'about:blank',
    ], {});
    let ws = null;
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } } catch { /* 还没起来 */ }
      if (browserProc.exitCode !== null) break;
      await sleep(250);
    }
    if (!ws) throw new Error(`CDP 没起来（exit=${browserProc.exitCode}）${procLog(browserProc).slice(0, 200)}`);
    const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: { width: 1400, height: 900 } });
    return { browser: b, mode: `spawn + CDP(${CDP_PORT})` };
  } catch (e) { errors.push(`spawn+CDP: ${e && e.message}`); }
  return { error: errors.join('\n  ') };
}

/** 页面内探针：一次拿全左栏的「模型 + DOM + 活动栏」三份状态 */
const PROBE = () => {
  window.__L = {
    snapshot() {
      const LEFT = ['files', 'outline', 'notes', 'relations'];
      const model = {};
      for (const id of LEFT) {
        const p = window.__state.panels[id];
        const node = id === 'files' ? document.querySelector('#leftSide .side-head') : window.__state.blockEls?.[id] || document.querySelector(`[data-panel="${id}"]`);
        const r = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        model[id] = {
          visible: !!p.visible, collapsed: !!p.collapsed, dock: p.dock,
          domVisible: !!(node && node.isConnected && !node.classList.contains('hidden') && r && r.width > 0),
        };
      }
      const railBtns = [...document.querySelectorAll('#railLeft .rail-btn')].map((b) => ({
        rail: b.dataset.rail, active: b.classList.contains('active'),
        ariaCurrent: b.getAttribute('aria-current') || '',
        bg: getComputedStyle(b).backgroundColor,
        color: getComputedStyle(b).color,
        w: Math.round(b.getBoundingClientRect().width),
      }));
      const left = document.getElementById('leftSide');
      const lr = left ? left.getBoundingClientRect() : null;
      const rail = document.getElementById('railLeft');
      const rr = rail ? rail.getBoundingClientRect() : null;
      return {
        model,
        shown: LEFT.filter((id) => model[id].visible),
        domShown: LEFT.filter((id) => model[id].domVisible),
        noLeft: document.body.classList.contains('no-left'),
        leftW: lr ? Math.round(lr.width) : 0,
        railW: rr ? Math.round(rr.width) : 0,
        railVisible: !!rr && rr.width > 0 && getComputedStyle(rail).display !== 'none',
        railBtns,
        activeCount: railBtns.filter((b) => b.active).length,
        activeRail: (railBtns.find((b) => b.active) || {}).rail || '',
        leftActive: (() => { try { return JSON.parse(localStorage.getItem('reader.ui') || '{}').leftActive || ''; } catch { return ''; } })(),
      };
    },
    /** 点活动栏里的某个图标（走真实 click） */
    clickRail(key) { document.querySelector(`#railLeft .rail-btn[data-rail="${key}"]`).click(); },
    /** 点左栏底部的图标坞（左栏四块的另一个入口） */
    /**
     * 2026-10：左栏底部那个图标坞（`#panelDock`）已按用户要求删除 ——
     * 「A 只留最左边那条窄活动栏」+「那几个点不动……直接删掉就行」。
     * 所以这里改成点**最左边活动栏**上对应的图标（它现在是左栏唯一的面板入口）。
     * 注意：点已经开着的那一块是 **no-op**（用户口径「点击已开的图标……不做反应」），
     * 所以「切到另一块」必须点的是**没开**的那一个。
     */
    clickDock(id) {
      const name = { files: 'files', outline: 'outline', notes: 'notes', relations: 'rel' }[id] || id;
      document.querySelector(`#railLeft .rail-btn[data-rail="${name}"]`).click();
    },
    /** 直接设某块可见（模拟「划词翻译顺带打开」这类内部路径） */
    show(id) { window.__ctx.setPanelVisible(id, true); },
    hide(id) { window.__ctx.setPanelVisible(id, false); },
    collapseSide(on) { window.__ctx.setSideCollapsed ? window.__ctx.setSideCollapsed('left', on, true) : null; },
  };
};

try {
  if (!browserPath) throw new Error('找不到 Edge / Chrome');
  server = spawnLogged(process.execPath, ['server.js'], {
    cwd: ROOT,
    // 2026-10 安全加固：所有 /api/* 都要令牌（只有 /api/health 豁免）。
    // 本套件自己 spawn 隔离服务并轮询 /api/state 判就绪，所以必须**显式**给子进程
    // 关掉强制校验（审计允许测试显式注入，不允许生产留后门）。
    // PRT_DIAGNOSTICS=1 是为了让 /api/papers 返回绝对 dir，喂给 _env 的隔离闸门。
    env: {
      ...process.env,
      PORT: String(PORT), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1',
      PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
  });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) throw new Error(`隔离服务没起来\n${procLog(server).slice(-400)}`);
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-left-fake', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  });

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
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/chat')) return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: 'data: [DONE]\n\n' });
      if (u.includes('/api/ref-search') || u.includes('/api/search') || u.includes('/api/open-url')) return req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true,"results":[]}' });
      return req.continue();
    });

    async function boot({ clear = true } = {}) {
      await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
      if (clear) { await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'domcontentloaded' }); }
      await page.waitForFunction(() => !!window.__state && !!window.__ctx && !!document.querySelector('#railLeft'), { timeout: 25000 });
      await page.evaluate(PROBE);
      await sleep(450);
    }
    await boot();

    /* ── R1 一次只能开一个 ── */
    section('R1 左栏同时只能显示一块');
    const combos = [
      ['files', 'outline'], ['files', 'notes'], ['files', 'relations'],
      ['outline', 'notes'], ['outline', 'relations'], ['notes', 'relations'],
    ];
    let combosOk = true;
    const comboActual = [];
    for (const [a, b] of combos) {
      await page.evaluate((x) => window.__L.show(x), a);
      await sleep(160);
      const onlyA = await page.evaluate(() => window.__L.snapshot());
      await page.evaluate((x) => window.__L.show(x), b);
      await sleep(200);
      const after = await page.evaluate(() => window.__L.snapshot());
      const ok = onlyA.shown.join() === a && after.shown.join() === b && after.domShown.join() === b;
      comboActual.push(`${a}→${b}: shown=[${after.shown.join(',')}] dom=[${after.domShown.join(',')}]`);
      if (!ok) combosOk = false;
    }
    check('R1a 六种「先开 A 再开 B」的组合都只剩 B 一块（模型与 DOM 都只有一个）',
      combosOk, comboActual.join(' | '));

    await page.evaluate(() => window.__L.clickDock('outline'));
    await sleep(250);
    const viaDock = await page.evaluate(() => window.__L.snapshot());
    check('R1b 走左栏图标坞打开目录，也只剩目录一块',
      viaDock.shown.join() === 'outline' && viaDock.domShown.join() === 'outline',
      `shown=[${viaDock.shown.join(',')}] dom=[${viaDock.domShown.join(',')}]`);

    /* ── R2/R3/R6 活动栏：点哪个出哪个；点选中的收成活动栏 ── */
    section('R2–R3 活动栏：点哪个出哪个，点正显示的那个收成活动栏');
    await page.evaluate(() => window.__L.hide('outline'));
    await sleep(200);
    const hidden = await page.evaluate(() => window.__L.snapshot());
    check('R2a 四块都收起时不留空白侧栏，左侧收成活动栏且仍可点开',
      hidden.shown.length === 0 && hidden.leftW === 0 && hidden.railVisible && hidden.railW >= 30 && hidden.railW <= 60,
      `shown=${hidden.shown.length} leftW=${hidden.leftW} railVisible=${hidden.railVisible} railW=${hidden.railW} noLeft=${hidden.noLeft}`);

    await page.evaluate(() => window.__L.clickRail('rel'));
    await sleep(400);
    const relOpen = await page.evaluate(() => window.__L.snapshot());
    check('R2b 点活动栏「文献关系」→ 展开的就是文献关系',
      relOpen.shown.join() === 'relations' && relOpen.noLeft === false,
      `shown=[${relOpen.shown.join(',')}] noLeft=${relOpen.noLeft} leftW=${relOpen.leftW}`);

    // 再点同一个 → 收成活动栏
    await page.evaluate(() => window.__L.clickRail('rel'));
    await sleep(450);
    const collapsed = await page.evaluate(() => window.__L.snapshot());
    /**
     * R3a：再点同一块 = 整条左栏收起来。
     *
     * ⚠️ 2026-10-04 契约微调（用户口径「翻译的内容应该是要记录在右侧那个里面的，不管打不打开」）：
     * 收起来**不等于宽度必须为 0** —— 只要这一侧还有可见面板，JS 会保底给它 ≥60px
     * （`body.side-squeezed`，防止窄窗下整条侧栏消失）。所以判据改成
     * 「左栏被压到最小（≤80px）且要么活动栏出现、要么栏本身只剩一条」，
     * 关键是「不能还是展开态（>150px）」。
     */
    /**
     * ⚠️ **契约已反转**（2026-10 用户口径，用户原话：
     *   「点击已开的图标也不会关闭侧栏，**而是不做反应**」）。
     *
     * 旧契约（上面 R3a 原本写的）是「再点同一个 → 收成活动栏」。
     * 新契约是「再点同一块什么都不该发生」：左栏仍然展开、那一块仍然显示。
     * 收起左栏改成**另一个明确动作** —— 顶栏的「收起左栏」按钮，或拖动分隔条。
     *
     * 所以这两条改成验新语义（不是删断言）：no-op + 块没被隐藏。
     * 「收成活动栏」这条路本身仍然存在，只是不再挂在「点已开图标」上。
     */
    check('R3a 再点同一块是 no-op（新契约：不再收成活动栏）',
      collapsed.leftW > 100 && collapsed.shown.includes('relations'),
      `noLeft=${collapsed.noLeft} leftW=${collapsed.leftW} shown=[${collapsed.shown.join(',')}]`);
    check('R3b 再点同一块也不会把它隐藏（visible 仍为 true）',
      collapsed.model.relations.visible === true && collapsed.shown.join() === 'relations',
      `relations.visible=${collapsed.model.relations.visible} shown=[${collapsed.shown.join(',')}]`);

    // R6：从「收起」状态点图标能回来 —— 改用顶栏按钮收起，再点图标展开
    await page.evaluate(() => document.getElementById('topbarLeftToggle').click());
    await sleep(500);
    const viaTopbar = await page.evaluate(() => window.__L.snapshot());
    check('R6a 顶栏「收起左栏」能把左栏收成活动栏',
      viaTopbar.noLeft === true && viaTopbar.railVisible === true,
      `noLeft=${viaTopbar.noLeft} railVisible=${viaTopbar.railVisible}`);
    await page.evaluate(() => window.__L.clickRail('rel'));
    await sleep(500);
    const backAgain = await page.evaluate(() => window.__L.snapshot());
    check('R6b 收起后再点同一个图标 → 回来的还是文献关系（不是默认的文件块）',
      backAgain.noLeft === false && backAgain.shown.join() === 'relations',
      `noLeft=${backAgain.noLeft} shown=[${backAgain.shown.join(',')}]`);

    /* ── R4/R5 选中态 ── */
    section('R4–R5 活动栏选中态：唯一、且跟着「此刻显示谁」走');
    // 先收起来，看高亮是否停在 relations
    await page.evaluate(() => window.__L.clickRail('rel'));
    await sleep(450);
    const sel1 = await page.evaluate(() => window.__L.snapshot());
    check('R4a 活动栏里恰好一个选中项，且是文献关系',
      sel1.activeCount === 1 && sel1.activeRail === 'rel' && sel1.railBtns.find((b) => b.rail === 'rel').ariaCurrent === 'true',
      `activeCount=${sel1.activeCount} active=${sel1.activeRail}`);
    const relBtn = sel1.railBtns.find((b) => b.rail === 'rel');
    const filesBtn = sel1.railBtns.find((b) => b.rail === 'files');
    check('R4b 选中项有可见的选中样式（背景与未选中不同）',
      relBtn.bg !== filesBtn.bg, `rel bg=${relBtn.bg} / files bg=${filesBtn.bg}`);

    await page.evaluate(() => window.__L.clickRail('notes'));
    await sleep(450);
    const sel2 = await page.evaluate(() => window.__L.snapshot());
    check('R5a 点「笔记」之后高亮切到笔记，且打开的就是笔记',
      sel2.activeRail === 'notes' && sel2.activeCount === 1 && sel2.shown.join() === 'notes',
      `active=${sel2.activeRail} count=${sel2.activeCount} shown=[${sel2.shown.join(',')}]`);

    // 内部路径（划词/操作）直接显示 relations：高亮必须跟着模型走，不能停在用户上次点的地方
    await page.evaluate(() => window.__L.show('relations'));
    await sleep(300);
    const sel3 = await page.evaluate(() => window.__L.snapshot());
    check('R5b 由内部路径打开文献关系时，高亮跟着「此刻显示谁」走（不能骗人）',
      sel3.shown.join() === 'relations' && sel3.activeRail === 'rel',
      `shown=[${sel3.shown.join(',')}] active=${sel3.activeRail}`);

    /* ── R7 持久化 ── */
    section('R7 刷新后仍记得上次选的是哪一块');
    await page.evaluate(() => window.__L.clickRail('outline'));
    await sleep(400);
    await page.evaluate(() => window.__L.clickRail('outline'));   // 收成活动栏
    await sleep(400);
    const beforeReload = await page.evaluate(() => window.__L.snapshot());
    check('R7a 收起前已记录 leftActive=outline',
      beforeReload.leftActive === 'outline', `leftActive=${beforeReload.leftActive}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__state && !!document.querySelector('#railLeft'), { timeout: 25000 });
    await page.evaluate(PROBE);
    await sleep(600);
    const afterReload = await page.evaluate(() => window.__L.snapshot());
    check('R7b 刷新后活动栏高亮的还是目录（不是回落成文件）',
      afterReload.activeRail === 'outline' && afterReload.activeCount === 1,
      `active=${afterReload.activeRail} count=${afterReload.activeCount}`);

    /* ── R8 别把 p.collapsed 一起改掉 ── */
    section('R8 「一次只开一个」不许改掉块内部的折叠状态');
    const r8 = await page.evaluate(() => {
      window.__L.show('notes');
      const before = window.__state.panels.notes.collapsed;
      window.__L.show('files');
      const afterOthers = window.__state.panels.notes.collapsed;
      window.__L.show('notes');
      return { before, afterOthers, back: window.__state.panels.notes.collapsed };
    });
    check('R8 被自动收起的那一块，collapsed（块内折叠）保持不变',
      r8.before === r8.afterOthers && r8.afterOthers === r8.back, fmt(r8));

    /* ── R9 零报错 ── */
    section('R9 零 JS 报错');
    check('全程没有 pageerror / console.error', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || '(无)');
  }
} catch (e) {
  check('套件自身未抛异常', false, `抛出：${e && (e.stack || e.message || e)}`);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (browserProc && browserProc.exitCode === null) browserProc.kill(); } catch { /* ignore */ }
  try { if (server && server.exitCode === null) server.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
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
