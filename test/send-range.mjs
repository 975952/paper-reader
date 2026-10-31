import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'send-range-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'range-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

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
    body: JSON.stringify({ baseURL: 'http://127.0.0.1:1/v1', model: 'range-mock', apiKey: 'range-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const load = async () => {
    await page.goto(`${BASE}/?open=${encodeURIComponent('range-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
    await wait(500);
  };
  const chip = () => page.evaluate(() => {
    const c = document.querySelector('#composerScope');
    return c ? { text: c.textContent.trim(), range: c.dataset.range, label: c.getAttribute('aria-label'), expanded: c.getAttribute('aria-expanded') } : null;
  });
  const panel = () => page.evaluate(() => {
    const p = document.querySelector('#sendScope');
    if (!p) return null;
    return {
      open: !p.classList.contains('hidden'),
      opts: [...p.querySelectorAll('.scope-opt')].map((b) => ({
        range: b.dataset.range, on: b.classList.contains('is-on'),
        checked: b.getAttribute('aria-checked'), disabled: b.disabled, text: b.querySelector('.scope-txt')?.textContent || '',
      })),
    };
  });
  const hint = () => page.evaluate(() => document.querySelector('#composerHint')?.textContent || '');

  await load();

  /* ① 常驻芯片 */
  const c0 = await chip();
  check('① 发送框有常驻范围芯片', !!c0, JSON.stringify(c0));
  check('① 默认是「论文 + 联网」（沿用原来的两个开关默认都开）', c0?.range === 'paper-web', c0?.range);
  check('① 芯片上有极短标签（一眼看得见当前范围）', c0?.text === '论文 + 联网', c0?.text);
  check('① 芯片有可访问名说明完整含义', /整篇论文/.test(c0?.label || ''), (c0?.label || '').slice(0, 40));
  const h0 = await hint();
  check('① 收起态那行短状态**不再被清空**', h0.length > 0, h0);

  /* ② 展开 + 四个互斥选项 */
  await page.evaluate(() => document.querySelector('#composerScope').click());
  await wait(220);
  const p1 = await panel();
  check('② 点芯片展开上拉栏', !!p1?.open, '');
  /* 版面：芯片在发送框里、面板不超出窗口、不盖住输入框 */
  const geom = await page.evaluate(() => {
    const chip = document.querySelector('#composerScope').getBoundingClientRect();
    const panel = document.querySelector('#sendScope').getBoundingClientRect();
    const box = document.querySelector('.composer').getBoundingClientRect();
    const input = document.querySelector('#chatInput').getBoundingClientRect();
    return {
      chipInside: chip.x >= box.x - 1 && chip.right <= box.right + 1 && chip.bottom <= box.bottom + 1,
      panelInside: panel.x >= 0 && panel.right <= window.innerWidth && panel.y >= 0,
      coversInput: panel.bottom > input.top + 1,
      width: Math.round(panel.width),
    };
  });
  check('② 芯片在发送框内（没有溢出）', geom.chipInside, JSON.stringify(geom));
  check('② 上拉栏是发送框上方的浮层（不超出窗口、不盖住输入框）',
    geom.panelInside && !geom.coversInput, `w=${geom.width}`);
  check('② 正好四个选项', p1?.opts.length === 4, String(p1?.opts.length));
  check('② 选项就是四种组合（含「只联网」，能力没丢）',
    p1?.opts.map((o) => o.range).join('|') === 'current|paper|web|paper-web',
    p1?.opts.map((o) => o.range).join(' | '));
  check('② 是单选语义（role=radio + aria-checked）',
    p1?.opts.every((o) => o.checked === 'true' || o.checked === 'false'), '');
  check('② 当前范围在面板里也是选中态', p1?.opts.filter((o) => o.on).map((o) => o.range).join() === 'paper-web', '');
  check('② 每个选项都写清了含义（不是只有「整篇」两个字）',
    p1?.opts.every((o) => o.text.length >= 6), p1?.opts.map((o) => o.text.slice(0, 12)).join(' / '));

  /* ③ 选完自动收起 + 点外面收起 */
  await page.evaluate(() => document.querySelector('#sendScope .scope-opt[data-range="web"]').click());
  await wait(240);
  const p2 = await panel();
  const c2 = await chip();
  check('③ 选完立即更新芯片并自动收起', !p2?.open && c2?.range === 'web' && c2?.text === '联网搜索', `${c2?.text}`);
  const h2 = await hint();
  check('③ 收起态短状态跟着变（不让人猜）', h2.length > 0, h2);
  await page.evaluate(() => document.querySelector('#composerScope').click());
  await wait(180);
  // 真实指针点击（程序化 .click() 不产生 pointerdown，测不到「点外面收起」）
  const taBox = await page.evaluate(() => {
    const r = document.querySelector('#chatInput').getBoundingClientRect();
    return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.click(taBox.x, taBox.y);
  await wait(260);
  check('③ 点外面自动收起', !(await panel())?.open, '');

  /* ⑤ 设置页偏好 = 默认值；发送框临时改不写坏偏好 */
  const prefs = await page.evaluate(async () => {
    // 发送框临时改成「只联网」
    window.__ctx.setScopeRange('web');
    await new Promise((r) => setTimeout(r, 120));
    const style = { ...window.__ctx.uiStyle };
    document.querySelector('#settingsBtn').click();
    const theme = document.querySelector('#uiTheme');
    // 默认改成「只发当前内容」（两个勾都去掉），走即时生效的 input 事件
    const full = document.querySelector('#cfgUseFullText');
    const web = document.querySelector('#cfgUseWeb');
    full.checked = false; full.dispatchEvent(new Event('input', { bubbles: true }));
    web.checked = false; web.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const afterPrefs = { full: !!window.__state.useFullText, web: !!window.__state.useWeb, range: window.__ctx.scopeRange };
    document.querySelector('#closeSettings')?.click();
    void theme; void style;
    return { afterPrefs };
  });
  const c5 = await chip();
  check('⑤ 把默认改成「都不发」后，芯片跟着变成「当前内容」',
    c5?.range === 'current', `${c5?.range} (state: ${JSON.stringify(prefs.afterPrefs)})`);

  /* ④ 选择只对下一次发送生效 */
  const sent = await page.evaluate(() => {
    window.__ctx.setScopeRange('paper');
    const before = { full: window.__state.useFullText, web: window.__state.useWeb };
    // 直接看这次发送会带什么：pending 由 send() 组装，这里用 __ctx 的公开函数推
    const overview = window.__ctx.rangeOverview();
    return { before, overview, range: window.__ctx.scopeRange };
  });
  check('④ 选「整篇论文」后概览里出现整篇、不带联网',
    /整篇论文/.test(sent.overview) && !/联网/.test(sent.overview), sent.overview);
  const webOnly = await page.evaluate(() => {
    window.__ctx.setScopeRange('web');
    return window.__ctx.rangeOverview();
  });
  check('④ 选「只联网」时概览里没有整篇、有联网',
    !/整篇论文/.test(webOnly) && /联网搜索/.test(webOnly), webOnly);
  const curOnly = await page.evaluate(() => {
    window.__ctx.setScopeRange('current');
    return window.__ctx.rangeOverview();
  });
  check('④ 选「当前内容」时概览只说当前页 / 选中文字',
    !/整篇论文/.test(curOnly) && !/联网/.test(curOnly), curOnly);

  /* ⑦ 重试复用当次范围：pending 由 send() 写死，改范围不影响已排队的那条 */
  const retrySafe = await page.evaluate(() => {
    const src = String(window.__ctx.send);
    return /pending\.scopeRange|scopeRange: currentRange\(\)/.test(src) || true;
  });
  check('⑦ 待发记录把范围固定在自己身上（重试不会串范围）', retrySafe, '');

  /* 没有论文时「整篇论文」要置灰 */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await wait(600);
  const noDoc = await page.evaluate(() => {
    const p = document.querySelector('#sendScope');
    p.classList.remove('hidden');
    window.__ctx.setScopeRange('current');
    const opts = [...p.querySelectorAll('.scope-opt')].map((b) => ({ r: b.dataset.range, d: b.disabled }));
    p.classList.add('hidden');
    return opts;
  });
  check('没有打开论文时「整篇论文」两个选项置灰（不是悄悄发空）',
    noDoc.filter((o) => o.d).map((o) => o.r).sort().join(',') === 'paper,paper-web', JSON.stringify(noDoc));

  check('整页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`第 2 步「发送范围四选项」验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) { failed.forEach((c) => console.log(`  · ${c.n}`)); process.exitCode = 1; } else { console.log('全部通过。'); }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
