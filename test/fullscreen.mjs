/**
 * 应用全屏验收（2026-11）：
 *  - 顶栏有全屏按钮，点击进入全屏；
 *  - 全屏只改窗口（铺满屏幕），应用内顶栏/底栏保持原样（用户口径：不要隐藏顶栏）；
 *  - 底部不留白条（底栏贴住窗口底边）；
 *  - F11 也能切换全屏；按 Esc 退出全屏。
 *
 * 浏览器里用 Fullscreen API；测试环境里把 requestFullscreen/exitFullscreen 换成桩，
 * 验证页面自己的全屏状态与布局（真实窗口全屏由桌面壳 tao 负责，cargo test 覆盖 IPC 解析）。
 *
 *   node test/fullscreen.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'fullscreen-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fullscreen-paper.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（180s），强制退出'); process.exit(3); }, 180000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

let reader = null;
let browser = null;
try {
  const readerPort = await findPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(readerPort), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${readerPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // 桩：headless shell 里的真实 Fullscreen API 不可靠，只验证页面自己的状态与布局切换
  await page.evaluateOnNewDocument(() => {
    window.__fsStub = { requested: 0, exited: 0 };
    Element.prototype.requestFullscreen = function () { window.__fsStub.requested += 1; return Promise.resolve(); };
    document.exitFullscreen = function () { window.__fsStub.exited += 1; return Promise.resolve(); };
  });

  await page.goto(`${BASE}/?open=fullscreen-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await wait(600);

  const ui = () => page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    const foot = document.querySelector('#viewerFoot');
    const main = document.querySelector('#main');
    const btn = document.querySelector('#fullscreenBtn');
    return {
      fullscreen: document.body.classList.contains('window-fullscreen'),
      topbar: topbar ? getComputedStyle(topbar).display : 'missing',
      foot: foot ? getComputedStyle(foot).display : 'missing',
      footBottom: foot ? foot.getBoundingClientRect().bottom : 0,
      mainH: main ? main.getBoundingClientRect().height : 0,
  // B 线 P1：多标签标签条的高度（普通状态占 32px，全屏时隐藏）
  tabBar: (() => { const n = document.getElementById('tabBar'); if (!n) return 0; const s = getComputedStyle(n); return s.display === 'none' ? 0 : n.getBoundingClientRect().height; })(),
      innerH: window.innerHeight,
      btnVisible: !!btn && getComputedStyle(btn).display !== 'none',
      pressed: btn?.getAttribute('aria-pressed') || '',
      title: btn?.title || '',
      requested: window.__fsStub?.requested || 0,
    };
  });

  const before = await ui();
  check('顶栏有全屏按钮', before.btnVisible && before.fullscreen === false, JSON.stringify(before));
  check('普通状态：顶栏与底栏都在', before.topbar !== 'none' && before.foot !== 'none', `${before.topbar}/${before.foot}`);

  /* ── 1. 点按钮进入全屏：只改窗口，应用内 chrome 不动 ── */
  await page.click('#fullscreenBtn');
  await wait(450);
  const full = await ui();
  check('点按钮进入全屏（页面状态 + 请求了 Fullscreen API）', full.fullscreen && full.requested >= 1, JSON.stringify(full));
  check('全屏时顶栏与底栏保持显示（不再隐藏上方那一栏）', full.topbar !== 'none' && full.foot !== 'none', `${full.topbar}/${full.foot}`);
  check('底栏贴住窗口底边、最下面没有白条', Math.abs(full.footBottom - full.innerH) < 2, `${full.footBottom} vs ${full.innerH}`);
  // B 线 P1：普通状态有 32px 标签条；全屏隐藏标签条后主区应恰好收回这段高度（不再要求绝对相等）
  check('全屏时标签条隐藏', full.tabBar === 0, `tabBar=${full.tabBar}`);
  check('全屏时光标区域未被压缩（主区高度 = 普通 + 标签条高度）',
    Math.abs(full.mainH - (before.mainH + before.tabBar)) < 3, `${before.mainH}+${before.tabBar} → ${full.mainH}`);
  check('全屏按钮切换到「退出全屏」态', full.pressed === 'true' && /退出全屏/.test(full.title), `${full.pressed} ${full.title}`);

  /* ── 2. Esc 退出全屏 ── */
  await page.keyboard.press('Escape');
  await wait(450);
  const exited = await ui();
  check('按 Esc 退出全屏', exited.fullscreen === false && exited.pressed === 'false', JSON.stringify(exited));
  check('退出后顶栏与底栏恢复', exited.topbar !== 'none' && exited.foot !== 'none', `${exited.topbar}/${exited.foot}`);

  /* ── 3. F11 也能切换全屏，再按 Esc 退出 ── */
  await page.keyboard.press('F11');
  await wait(450);
  const f11 = await ui();
  check('F11 进入全屏', f11.fullscreen === true && f11.requested >= full.requested + 1, JSON.stringify(f11));
  await page.keyboard.press('Escape');
  await wait(450);
  const f11out = await ui();
  check('Esc 再次退出（F11 进入的）', f11out.fullscreen === false, JSON.stringify(f11out));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n全屏：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
