/**
 * B 线 P1：多标签工作区与 Welcome 验收（真浏览器 + 隔离服务，无真实 API）。
 *
 *   node test/tabs.mjs
 *
 * 覆盖设计 §10.1 的 P1 范围：打开/激活/去重/顺序、关闭与 Welcome、快捷键、拖拽排序、
 * 溢出菜单、10 个上限、刷新恢复、全屏隐藏、首页按钮隐藏。
 * （热切换 / 文件夹会话 / 译文存档 / 后台任务属于 P2/P3，本套件不测。）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'tabs-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
// 2 篇「正常」文档 + 8 篇用于测上限（同一合成 PDF 复制成不同名字 → docId 不同）
const MAIN = ['paper-a.pdf', 'paper-b.pdf'];
for (const name of MAIN) fs.copyFileSync(path.join(FIXTURES, 'multipage-sample.pdf'), path.join(PAPERS, name));
for (let i = 1; i <= 8; i += 1) fs.copyFileSync(path.join(FIXTURES, 'cn-sample.pdf'), path.join(PAPERS, `extra-${i}.pdf`));
// 子文件夹里放一篇未打开文档，用来验溢出菜单的「当前文件夹」分组
fs.mkdirSync(path.join(PAPERS, 'sub'), { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'cn-sample.pdf'), path.join(PAPERS, 'sub', 'in-folder.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const watchdog = setTimeout(() => { console.error('测试超时（240s），强制退出'); process.exit(3); }, 240000);
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
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const settle = async () => {
    await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId
      || (!window.__state?.doc && !document.body.classList.contains('reading')), { timeout: 40000 });
    await wait(500);
  };
  const openFirst = async () => {
    await page.goto(`${BASE}/?open=paper-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 60000 });
    await settle();
  };
  const tabs = () => page.evaluate(() => window.__ctx.tabs);
  const tabDom = () => page.evaluate(() => [...document.querySelectorAll('#tabStrip .doc-tab')].map((n) => ({
    doc: n.dataset.doc, title: n.querySelector('.tab-title')?.textContent || '', active: n.classList.contains('active'),
  })));
  const papers = [];
  {
    const listing = await fetch(`${BASE}/api/papers`).then((r) => r.json());
    for (const row of listing.papers || []) papers.push(row);
  }
  const paperByName = (name) => papers.find((p) => p.name === name);
  const openByDom = async (name) => {
    const p = paperByName(name);
    if (!p) throw new Error(`隔离书架里没有 ${name}`);
    await page.evaluate((doc) => window.__ctx.openDoc(doc), { name: p.name, url: p.url, docId: p.docId, path: p.path || p.name });
    await settle();
  };

  /* ── 1. 打开第一篇：标签条出现、首页按钮隐藏 ── */
  await openFirst();
  let st = await tabs();
  check('打开一篇 → 1 个标签', st.length === 1 && st[0].name === 'paper-a.pdf', JSON.stringify(st));
  check('该标签是活动标签', (await page.evaluate(() => window.__ctx.activeTab)) === st[0].docId);
  check('标签条可见', await page.evaluate(() => !document.getElementById('tabBar').classList.contains('hidden')
    && !!document.querySelector('#tabStrip .doc-tab.active')));
  check('有标签时顶栏首页按钮隐藏（DOM 保留）', await page.evaluate(() => {
    const btn = document.getElementById('homeBtn');
    return !!btn && btn.classList.contains('hidden');
  }));

  /* ── 2. 打开第二篇：2 个标签、第二个活动、顺序=打开顺序 ── */
  await openByDom('paper-b.pdf');
  let dom = await tabDom();
  check('打开第二篇 → 2 个标签', dom.length === 2, JSON.stringify(dom.map((t) => t.title)));
  check('顺序 = 打开顺序', dom[0].title === 'paper-a.pdf' && dom[1].title === 'paper-b.pdf', JSON.stringify(dom.map((t) => t.title)));
  check('后打开的标签激活', dom[1].active && !dom[0].active);
  check('活动标签与 state.doc 一致', await page.evaluate(() => window.__ctx.activeTab === window.__state.doc.docId));

  /* ── 3. 再点已打开文档：不新增标签、只激活（冷切换） ── */
  await openByDom('paper-a.pdf');
  dom = await tabDom();
  check('重复打开不新增标签', dom.length === 2, String(dom.length));
  check('重复打开会激活已有标签', dom[0].active && !dom[1].active);
  check('冷切换后正文是 paper-a', await page.evaluate(() => window.__state.doc.name === 'paper-a.pdf'));

  /* ── 4. 键盘切换：Ctrl+Tab / Ctrl+PageDown / Ctrl+1 ── */
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+Tab 切到下一个标签', await page.evaluate(() => window.__state.doc.name === 'paper-b.pdf'));
  await page.keyboard.down('Control');
  await page.keyboard.press('PageDown');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+PageDown 继续切', await page.evaluate(() => window.__state.doc.name === 'paper-a.pdf'));
  await page.keyboard.down('Control');
  await page.keyboard.press('2');
  await page.keyboard.up('Control');
  await settle();
  check('Ctrl+2 直达第二个标签', await page.evaluate(() => window.__state.doc.name === 'paper-b.pdf'));

  /* ── 5. 拖拽排序：把第一个拖到第二个后面 ── */
  {
    const rects = await page.evaluate(() => [...document.querySelectorAll('#tabStrip .doc-tab')].map((n) => {
      const r = n.getBoundingClientRect();
      return { doc: n.dataset.doc, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
    await page.mouse.move(rects[0].x, rects[0].y);
    await page.mouse.down();
    await page.mouse.move(rects[1].x + 30, rects[1].y, { steps: 8 });
    await page.mouse.up();
    await wait(300);
    dom = await tabDom();
    check('拖拽后顺序变化', dom.length === 2 && dom[0].title === 'paper-b.pdf' && dom[1].title === 'paper-a.pdf',
      JSON.stringify(dom.map((t) => t.title)));
    check('拖拽顺序已写入工作区', await page.evaluate(() => {
      const ws = JSON.parse(localStorage.getItem('reader.workspace.v1') || '{}');
      return Array.isArray(ws.tabs) && ws.tabs[0]?.name === 'paper-b.pdf';
    }));
  }

  /* ── 6. 中键关闭 / Ctrl+W 关闭 / Ctrl+Shift+T 重开 ── */
  {
    const before = (await tabs()).length;
    await page.evaluate(() => {
      const el = document.querySelector('#tabStrip .doc-tab');
      el.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    await settle();
    check('中键关闭一个标签', (await tabs()).length === before - 1, `${before} → ${(await tabs()).length}`);
    const remain = await tabs();
    await page.keyboard.down('Control');
    await page.keyboard.press('w');
    await page.keyboard.up('Control');
    await settle();
    check('Ctrl+W 关闭当前标签', (await tabs()).length === remain.length - 1, `${remain.length} → ${(await tabs()).length}`);
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('T');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await settle();
    check('Ctrl+Shift+T 重开最近关闭的标签', (await tabs()).length === remain.length, String((await tabs()).length));
  }

  /* ── 7. 关掉全部 → Welcome ── */
  {
    for (const t of await tabs()) {
      await page.evaluate((docId) => window.__ctx.closeTab(docId), t.docId);
      await wait(400);
    }
    await wait(500);
    const welcome = await page.evaluate(() => ({
      tabs: window.__ctx.tabs.length,
      reading: document.body.classList.contains('reading'),
      homeVisible: !document.getElementById('home')?.classList.contains('hidden'),
      tabBarHidden: document.getElementById('tabBar')?.classList.contains('hidden'),
      docName: document.getElementById('docName')?.textContent || '',
      footDisabled: !!document.getElementById('pageInput')?.disabled,
    }));
    check('关掉全部标签 → 0 个标签', welcome.tabs === 0);
    check('Welcome：退出阅读态、书架页可见', !welcome.reading && welcome.homeVisible, JSON.stringify(welcome));
    check('Welcome：标签条隐藏、文档名复位', welcome.tabBarHidden && /未打开文档/.test(welcome.docName));
    check('Welcome：底栏禁用', welcome.footDisabled);
    await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__ctx?.tabs !== 'undefined', { timeout: 40000 });
    await wait(800);
    check('空工作区刷新后仍是 Welcome（不按 lastDoc 自动打开）', await page.evaluate(() =>
      window.__ctx.tabs.length === 0 && !document.body.classList.contains('reading')
      && !document.getElementById('home').classList.contains('hidden')));
  }

  /* ── 8. 溢出菜单：全部标签 + 当前文件夹文档 ── */
  {
    await openByDom('paper-a.pdf');
    await openByDom('sub/in-folder.pdf').catch(() => { /* 名字可能带路径，下面用 docId 兜底 */ });
    const opened = await tabs();
    if (opened.length < 2) await openByDom('paper-b.pdf');
    await page.click('#tabMoreBtn');
    await wait(300);
    const menu = await page.evaluate(() => ({
      visible: !document.getElementById('tabMenu')?.classList.contains('hidden'),
      items: [...document.querySelectorAll('#tabMenu .tab-menu-item')].map((n) => n.textContent),
      titles: [...document.querySelectorAll('#tabMenu .tab-menu-title')].map((n) => n.textContent),
    }));
    check('溢出菜单能打开', menu.visible);
    check('菜单列出全部标签', menu.items.some((t) => t.includes('paper-a.pdf')), JSON.stringify(menu.items.slice(0, 6)));
    check('菜单含「当前文件夹」或「书架」分组', menu.titles.some((t) => /当前文件夹|书架/.test(t)), JSON.stringify(menu.titles));
    await page.evaluate(() => document.body.click());
    await wait(200);
  }

  /* ── 9. 上限 10 个 ── */
  {
    const names = ['paper-a.pdf', 'paper-b.pdf', ...Array.from({ length: 8 }, (_, i) => `extra-${i + 1}.pdf`)];
    for (const name of names) {
      const already = (await tabs()).some((t) => t.name === name);
      if (!already) await openByDom(name).catch(() => {});
    }
    check('最多 10 个标签', (await tabs()).length === 10, String((await tabs()).length));
    // 找一篇还没打开的文档：第 11 个必须被拒绝
    const openIds = new Set((await tabs()).map((t) => t.docId));
    const unopened = papers.find((row) => !openIds.has(row.docId));
    check('还有未打开的文档可试第 11 个', !!unopened, JSON.stringify(papers.map((p) => p.name)));
    if (unopened) {
      await page.evaluate((doc) => window.__ctx.openDoc(doc), { name: unopened.name, url: unopened.url, docId: unopened.docId, path: unopened.path || unopened.name });
      await wait(600);
    }
    const after = await tabs();
    check('第 11 个被拒绝且仍是 10 个', after.length === 10, String(after.length));
    check('第 11 个被拒时有提示', await page.evaluate(() => [...document.querySelectorAll('.toast')].some((n) => /最多同时打开/.test(n.textContent))));
  }

  /* ── 10. 刷新恢复工作区 + 全屏隐藏 ── */
  {
    const before = await tabs();
    const activeBefore = await page.evaluate(() => window.__ctx.activeTab);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ctx?.tabs?.length > 0 && window.__viewer?.numPages > 0, { timeout: 60000 });
    await settle();
    const after = await tabs();
    check('刷新后恢复标签列表', after.length === before.length, `${before.length} → ${after.length}`);
    check('刷新后恢复活动标签', (await page.evaluate(() => window.__ctx.activeTab)) === activeBefore);
    check('刷新后标签条可见', await page.evaluate(() => !document.getElementById('tabBar').classList.contains('hidden')));
    const fsDisplay = await page.evaluate(() => {
      document.body.classList.add('window-fullscreen');
      const d = getComputedStyle(document.getElementById('tabBar')).display;
      document.body.classList.remove('window-fullscreen');
      return d;
    });
    check('全屏时标签条隐藏', fsDisplay === 'none', fsDisplay);
  }

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n多标签 P1：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
