/**
 * 浅色色板取色 + 截图（调色交付物）
 *   node design/theme-shot.mjs
 *
 * 在**真实界面**上取实际渲染出来的像素色（canvas 读回），并出三张截图：
 *   screens-theme/home.png     首页 / 书架
 *   screens-theme/reading.png  阅读页（PDF + 左栏 + 右栏）
 *   screens-theme/settings.png 设置弹窗
 * 只是为了让人一眼看到颜色，不做断言（断言在 theme-check.mjs）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from '../test/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { assertIsolatedDataDir, ROOT, SANDBOX } from '../test/_env.mjs';

const OUT = path.join(ROOT, 'design', 'screens-theme');
const scratch = fs.mkdtempSync(path.join(SANDBOX, 'theme-shot-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-multipage.pdf'));
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'cn-sample.pdf'));
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  if (!ready) throw new Error('服务没起来');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'shot', apiKey: 'shot-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();

  /* 像素取色：把页面截图喂进 canvas，读回指定坐标的颜色 */
  const sample = async (file, points) => {
    const buf = fs.readFileSync(file).toString('base64');
    return page.evaluate(async (b64, pts) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const hex = (x, y) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      };
      const out = {};
      for (const [name, x, y] of pts) out[name] = hex(x, y);
      return out;
    }, buf, points);
  };

  /* ① 首页 */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await wait(900);
  const homeFile = path.join(OUT, 'home.png');
  await page.screenshot({ path: homeFile });
  const homePx = await sample(homeFile, [
    ['左栏底', 120, 500],
    ['正文区底', 700, 820],
    ['顶栏底', 700, 16],
  ]);

  /* ② 阅读页 */
  await page.goto(`${BASE}/?open=fixture-multipage.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
  await wait(900);
  const readFile = path.join(OUT, 'reading.png');
  await page.screenshot({ path: readFile });
  const readPx = await sample(readFile, [
    ['PDF 纸面', 700, 300],
    ['左栏底', 120, 600],
    ['阅读区底（纸外）', 1430, 880],
  ]);

  /* ③ 设置弹窗 */
  await page.evaluate(() => document.querySelector('#settingsBtn').click());
  await wait(500);
  const setFile = path.join(OUT, 'settings.png');
  await page.screenshot({ path: setFile });
  const setPx = await sample(setFile, [
    ['弹窗底', 750, 200],
    ['遮罩后的页面', 60, 500],
  ]);

  const lines = [];
  lines.push('真实渲染像素取色（浅色主题）');
  for (const [k, v] of Object.entries({ ...homePx, ...readPx, ...setPx })) lines.push(`  ${k.padEnd(18, ' ')} ${v}`);
  lines.push('');
  lines.push('参考：工作台底 #F8F5EB / 卡片面板底 #FDFBF5 / 凹陷底 #F1EDE0 / PDF 纸面 #FCFAF2 / 品牌绿 #556B2F');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(OUT, '采样.txt'), text, 'utf8');
  console.log(text);
  console.log(`\n截图：${path.relative(ROOT, OUT)}/home.png · reading.png · settings.png`);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
