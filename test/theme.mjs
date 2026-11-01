/**
 * 主题皮肤验收（2026-11）：
 *  - 设置里能选到全部极简皮肤；
 *  - 纯黑皮肤：界面暗色表面是纯黑 rgb(0,0,0)、阴影全部为 none（不发光）；
 *  - 石墨灰/纯白/暖白能正常切换，且选择会保存、刷新后恢复。
 *
 *   node test/theme.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'theme-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'theme-paper.pdf'));

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

  const setTheme = async (value) => {
    await page.evaluate((v) => {
      const select = document.querySelector('#uiTheme');
      select.value = v;
      select.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await wait(200);
  };
  const themeState = () => page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const body = getComputedStyle(document.body);
    const topbar = getComputedStyle(document.querySelector('.topbar'));
    const modal = getComputedStyle(document.querySelector('.modal-box'));
    return {
      theme: root.dataset.theme || '',
      bg: cs.getPropertyValue('--bg').trim(),
      bgElev: cs.getPropertyValue('--bg-elev').trim(),
      shadow: cs.getPropertyValue('--shadow').trim(),
      shadowSm: cs.getPropertyValue('--shadow-sm').trim(),
      bodyBg: body.backgroundColor,
      bodyImage: body.backgroundImage,
      topbarShadow: topbar.boxShadow,
      modalShadow: modal.boxShadow,
      fg: cs.getPropertyValue('--fg').trim(),
    };
  });

  await page.goto(`${BASE}/?open=theme-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not(.hidden)');

  const options = await page.evaluate(() => [...document.querySelectorAll('#uiTheme option')].map((o) => [o.value, o.textContent.trim()]));
  const values = options.map(([v]) => v);
  check('设置里有 6 种皮肤（含纯黑）',
    ['system', 'light', 'mist', 'dark', 'graphite', 'black'].every((v) => values.includes(v)) && values.length === 6,
    JSON.stringify(options));

  /* ── 纯黑：暗色表面纯黑、无阴影（不发光） ── */
  await setTheme('black');
  const black = await themeState();
  check('纯黑皮肤：根主题生效', black.theme === 'black', black.theme);
  check('纯黑皮肤：背景变量是 #000000', black.bg.toLowerCase() === '#000000' && black.bgElev.toLowerCase() === '#000000',
    `${black.bg} / ${black.bgElev}`);
  check('纯黑皮肤：阴影全部为 none（完全不发光）',
    black.shadow === 'none' && black.shadowSm === 'none' && black.topbarShadow === 'none' && black.modalShadow === 'none',
    `${black.shadow} | topbar=${black.topbarShadow} | modal=${black.modalShadow}`);
  check('纯黑皮肤：界面纯黑底且没有渐变/背景图', black.bodyBg === 'rgb(0, 0, 0)' && black.bodyImage === 'none',
    `${black.bodyBg} / ${black.bodyImage}`);
  check('纯黑皮肤：正文色不是纯白刺眼（留一点余量）', black.fg && black.fg.toLowerCase() !== '#ffffff', black.fg);

  /* ── 石墨灰 / 纯白 / 暖白：能切换，且不是纯黑 ── */
  await setTheme('graphite');
  const graphite = await themeState();
  check('石墨灰：深色但不是纯黑', graphite.theme === 'graphite'
    && graphite.bodyBg === 'rgb(17, 18, 20)' && graphite.shadow === 'none', `${graphite.bodyBg} / ${graphite.shadow}`);

  await setTheme('mist');
  const mist = await themeState();
  check('纯白：白色极简、无阴影', mist.theme === 'mist'
    && mist.bodyBg === 'rgb(255, 255, 255)' && mist.shadow === 'none', `${mist.bodyBg} / ${mist.shadow}`);

  await setTheme('light');
  const light = await themeState();
  check('暖白：现有浅色皮肤仍正常', light.theme === 'light' && light.bodyBg !== 'rgb(0, 0, 0)', light.bodyBg);

  /* ── 选择保存后刷新恢复 ── */
  await setTheme('black');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.ui') || '{}').style?.theme);
  check('主题写入本地偏好', saved === 'black', String(saved));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme || '',
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }));
  check('刷新后恢复纯黑皮肤', restored.theme === 'black' && restored.bg.toLowerCase() === '#000000', JSON.stringify(restored));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n主题皮肤：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
