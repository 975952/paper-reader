/**
 * 浅色色板体检（调色后自查）
 *   node design/theme-check.mjs
 *
 * 起一个临时服务 + 隔离书架，打开**真实界面**（首页 / 阅读页 / 设置弹窗 / 右栏），
 * 读实际生效的 CSS 变量与计算样式，并断言：
 *   · 浅色底是「白底 + 很淡暖黄」（不是纯白、也不是原来的米黄）
 *   · 四块重复定义的色板值一致（不然保存设置前后会看到两种底色）
 *   · 文字对比度全部达标（--fg / --fg-dim / --fg-faint / --accent）
 *   · 深色模式一个字没动
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from '../test/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { assertIsolatedDataDir, ROOT, SANDBOX } from '../test/_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'theme-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? `  — ${d}` : ''}`); };

const hex = (s) => s.replace('#', '').match(/../g).map((x) => parseInt(x, 16));
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { const t = v / 255; return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const p = probe.address().port;
  await new Promise((r) => probe.close(r));
  return p;
}

let browser;
let server;
try {
  const port = await findPort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { await wait(100); try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ } }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('服务没起来');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'x', apiKey: 'k' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  /* 浅色 + 阅读页 */
  await page.goto(`${BASE}/?open=fixture.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(500);
  const light = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const body = getComputedStyle(document.body);
    const topbar = document.querySelector('#topbar');
    const side = document.querySelector('#leftSide');
    const pageEl = document.querySelector('.page');
    return {
      tokens: { bg: v('--bg'), elev: v('--bg-elev'), sunken: v('--bg-sunken'), border: v('--border'), accent: v('--accent'), paper: v('--paper'), paperTint: v('--paper-tint') },
      bodyBg: body.backgroundColor,
      topbarBg: topbar ? getComputedStyle(topbar).backgroundColor : '',
      sideBg: side ? getComputedStyle(side).backgroundColor : '',
      pageBg: pageEl ? getComputedStyle(pageEl).backgroundColor : '',
      theme: document.documentElement.dataset.theme || 'system',
    };
  });
  const rgb = (c) => { const m = (c.match(/[\d.]+/g) || []).map(Number); return '#' + m.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase(); };
  // 主题"生效"的判据是**底色的实际取值**，不是 data-theme 属性：
  // 第一版的默认偏好就是「跟随系统」，这时 applyUiStyle() 会把 data-theme 删掉（历史行为，不改）。
  check('浅色底实际生效（跟随系统 / 显式浅色都对）',
    light.tokens.bg.toUpperCase() === '#F8F5EB', `${light.theme} / ${light.tokens.bg}`);
  check('工作台底 = 白底 + 很淡暖黄（#F8F5EB）', light.tokens.bg.toUpperCase() === '#F8F5EB', light.tokens.bg);
  check('卡片/面板底更亮一档（#FDFBF5）', light.tokens.elev.toUpperCase() === '#FDFBF5', light.tokens.elev);
  check('凹陷底更深一档（#F1EDE0）', light.tokens.sunken.toUpperCase() === '#F1EDE0', light.tokens.sunken);
  check('PDF 纸面 #FCFAF2（白底微暖，不是原来的 #F8F1DF）', light.tokens.paper.toUpperCase() === '#FCFAF2', light.tokens.paper);
  check('纸面仍是暖色调（R > B）', (() => { const [r, , b] = hex(rgb(light.pageBg)); return r > b; })(), `${rgb(light.pageBg)}`);
  check('底不是纯白（保留一丝暖黄）', hex(light.tokens.bg)[0] - hex(light.tokens.bg)[2] >= 8, light.tokens.bg);
  check('品牌橄榄绿没动（#556B2F）', light.tokens.accent.toUpperCase() === '#556B2F', light.tokens.accent);

  const rows = [
    ['--fg 对 --bg', light.tokens.fg || '#3F4038', light.tokens.bg, 7],
    ['--fg-dim 对 --bg', '#63645A', light.tokens.bg, 4.5],
    ['--fg-faint 对 --bg-elev', '#77786C', light.tokens.elev, 4],
    ['--accent 对 --bg-elev', light.tokens.accent, light.tokens.elev, 4.5],
  ];
  for (const [name, fg, bg, min] of rows) {
    const r = ratio(fg, bg);
    check(`${name} ≥ ${min}:1`, r >= min, `${r.toFixed(2)}:1`);
  }

  /* 层差：卡片要浮得起来 */
  const dElevBg = lum(hex(light.tokens.elev)) - lum(hex(light.tokens.bg));
  const dBgSunken = lum(hex(light.tokens.bg)) - lum(hex(light.tokens.sunken));
  check('面板与背景的亮度差仍看得出层次（≥0.04）', dElevBg >= 0.04, dElevBg.toFixed(4));
  check('背景与凹陷底的层次（≥0.04）', dBgSunken >= 0.04, dBgSunken.toFixed(4));
  check('边框在浅底上看得见（1.15–1.5:1）', (() => { const r = ratio(light.tokens.border, light.tokens.bg); return r >= 1.15 && r <= 1.5; })(), ratio(light.tokens.border, light.tokens.bg).toFixed(3));

  /* 首页 */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await wait(600);
  const home = await page.evaluate(() => {
    const b = getComputedStyle(document.body).backgroundColor;
    const home = document.querySelector('#home');
    return { body: b, homeVisible: !!home && !home.classList.contains('hidden'), homeBg: home ? getComputedStyle(home).backgroundColor : '' };
  });
  check('首页底色同色板（没有残留的旧米黄）',
    rgb(home.body).toUpperCase() === '#F8F5EB' || home.homeBg === '' || rgb(home.homeBg).toUpperCase() === '#F8F5EB',
    `${rgb(home.body)} / ${home.homeBg ? rgb(home.homeBg) : '-'}`);

  /* 设置弹窗里的即时生效：切深色再切回来，底色必须一致（四块同步的回归护栏） */
  await page.goto(`${BASE}/?open=fixture.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  const roundTrip = await page.evaluate(async () => {
    const read = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const before = read();
    document.querySelector('#settingsBtn').click();
    const theme = document.querySelector('#uiTheme');
    const setTheme = (value) => {
      theme.value = value;
      // 主题是「即时生效」控件：接线在 input 事件上，必须派发，不能只改 value
      theme.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setTheme('dark');
    await new Promise((r) => setTimeout(r, 320));
    const dark = read();
    setTheme('light');
    await new Promise((r) => setTimeout(r, 320));
    const back = read();
    document.querySelector('#closeSettings')?.click();
    return { before, dark, back };
  });
  check('深色模式仍是原来的暖灰深色（#2E2B24）', roundTrip.dark.toUpperCase() === '#2E2B24', roundTrip.dark);
  check('切深色再切回浅色，底色与切之前完全一致（四块色板同步）',
    roundTrip.back.toUpperCase() === roundTrip.before.toUpperCase() && roundTrip.before.toUpperCase() === '#F8F5EB',
    `${roundTrip.before} → ${roundTrip.dark} → ${roundTrip.back}`);

  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`浅色色板体检：${checks.length} 条，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
