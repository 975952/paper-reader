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

  /* ── 11. 热切换（B 线 P2）：切回旧标签不重新下载/解析 PDF，页码/滚动保留，p95 < 350ms ── */
  {
    // 清到只剩 2 个标签（热切换只需两篇来回）
    for (const t of (await tabs()).slice(2)) {
      await page.evaluate((docId) => window.__ctx.closeTab(docId), t.docId);
      await wait(250);
    }
    const remain = await tabs();
    if (remain.length < 2) {
      await page.evaluate(() => window.__ctx.goWelcome());
      await wait(300);
      await openByDom('paper-a.pdf');
      await openByDom('paper-b.pdf');
    }
    const activeFirst = await page.evaluate(() => window.__state.doc.name);
    const firstId = (await tabs()).find((t) => t.name === activeFirst)?.docId;
    // 在第一篇里造两条已渲染的回答并打标记：热切回时必须复用同一批 DOM（不重放渲染）
    await page.evaluate(() => {
      window.__ctx.setPanelVisible('chat', true);
      for (let i = 0; i < 2; i += 1) {
        const entry = window.__ctx.addEntry({ block: 'chat', kind: 'assistant', text: `热切换前的第 ${i + 1} 条回答` });
        window.__ctx.finishEntry(entry, `热切换前的第 ${i + 1} 条回答`, { page: 1 });
      }
      document.querySelectorAll('#aiArea .msg').forEach((node) => { node.__hotMark = 1; });
    });
    // 在第一篇里翻到第 5 页（记录页码/滚动，切回来要「看起来没动过」）
    await page.evaluate(async () => { await window.__viewer.goToPage(5); });
    await wait(400);
    const before = await page.evaluate(() => ({ page: window.__viewer.current, top: document.getElementById('viewer').scrollTop }));
    const pdfRequests = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/pdf')).length);
    const sessionRequests = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/session')).length);
    const attachBefore = await page.evaluate(() => window.__ctx.pdfHotAttaches);
    // 先切到另一篇（冷加载会正常下载一次 PDF / 读一次会话），冷加载完成后再取基准
    const otherId = (await tabs()).find((t) => t.docId !== firstId)?.docId;
    await page.evaluate((docId) => window.__ctx.activateTab(docId), otherId);
    await settle();
    // 切回命中句柄 → 热切换：页面内计时 + 期间是否新增 PDF/会话请求（只统计这次切换本身）
    const hot = await page.evaluate(async (docId) => {
      window.__hotTrace = true;
      const pdfCount = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/pdf')).length;
      const sessionCount = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/session')).length;
      const pdf0 = pdfCount();
      const sess0 = sessionCount();
      const t = performance.now();
      await window.__ctx.activateTab(docId);
      const ms = Math.round(performance.now() - t);
      return { ms, pdfDelta: pdfCount() - pdf0, sessionDelta: sessionCount() - sess0 };
    }, firstId);
    await settle();
    const switchMs = hot.ms;
    const after = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#aiArea .msg')];
      return {
        page: window.__viewer.current,
        top: document.getElementById('viewer').scrollTop,
        doc: window.__state.doc.name,
        attaches: window.__ctx.pdfHotAttaches,
        handles: window.__ctx.pdfHandleCount,
        hotTrace: window.__lastHotTrace || null,
        msgCount: nodes.length,
        marks: nodes.filter((node) => node.__hotMark === 1).length,
      };
    });
    check('切回旧标签走热切换（attach 命中）', after.attaches > attachBefore, `attaches=${attachBefore}→${after.attaches}`);
    check('热切换后页码保留', after.page === before.page, `${before.page} → ${after.page}`);
    check('热切换后滚动位置保留（±3px）', Math.abs(after.top - before.top) <= 3, `${before.top} → ${after.top}`);
    check('热切换后回到正确文档', after.doc === activeFirst, after.doc);
    check('热切换不再重复下载 PDF', hot.pdfDelta === 0, `本次切换新增 ${hot.pdfDelta} 次 /api/pdf`);
    check('热切换复用已渲染的消息 DOM（不重放渲染）', after.msgCount === 2 && after.marks === 2, `msg=${after.msgCount} marks=${after.marks}`);
    check('热切换不再重新读取会话', hot.sessionDelta === 0, `本次切换新增 ${hot.sessionDelta} 次 /api/session`);
    check('热切换打点显示走恢复路径（attach + restoreView，没有 session/outline 重放）',
      !!after.hotTrace && after.hotTrace.hot === true && typeof after.hotTrace.restoreView === 'number'
      && typeof after.hotTrace.session === 'undefined' && typeof after.hotTrace.outline === 'undefined',
      JSON.stringify(after.hotTrace));
    check('单次热切换 < 350ms（页面内计时）', switchMs < 350, `${switchMs}ms；${JSON.stringify(after.hotTrace)}`);

    // p95：来回切 8 次，页面内计时取 95 分位
    const times = [];
    for (let i = 0; i < 8; i += 1) {
      const target = i % 2 === 0 ? otherId : firstId;
      const ms = await page.evaluate(async (docId) => {
        const t = performance.now();
        await window.__ctx.activateTab(docId);
        return Math.round(performance.now() - t);
      }, target);
      times.push(ms);
    }
    await settle();
    times.sort((a, b) => a - b);
    const p95 = times[Math.max(0, Math.ceil(times.length * 0.95) - 1)];
    check('热切换 p95 < 350ms', p95 < 350, `p95=${p95}ms（全部：${times.join(',')}）`);

    // 用户口径：每次切换论文都不应该重绘右侧问答栏（全局会话共用，聊天 DOM 应原样保留、节点身份不变）
    const chatRedraw = await page.evaluate(async () => {
      const chatBody = () => document.querySelector('[data-block="chat"] .ai-body');
      const first = window.__ctx.activeTab;
      const other = window.__ctx.tabs.map((t) => t.docId).find((id) => id !== first);
      const beforeNodes = [...chatBody().querySelectorAll('.msg')];
      beforeNodes.forEach((n, i) => { n.__noRedraw = i + 1; });
      const sizeBefore = beforeNodes.length;
      await window.__ctx.activateTab(other);
      await new Promise((r) => setTimeout(r, 250));
      await window.__ctx.activateTab(first);
      await new Promise((r) => setTimeout(r, 250));
      const afterNodes = [...chatBody().querySelectorAll('.msg')];
      return {
        sizeBefore,
        sizeAfter: afterNodes.length,
        sameNodes: afterNodes.length === beforeNodes.length && afterNodes.every((n, i) => n === beforeNodes[i]),
        marks: afterNodes.filter((n) => n.__noRedraw).length,
      };
    });
    check('切换论文不重绘右侧问答栏（DOM 节点原样保留）',
      chatRedraw.sameNodes && chatRedraw.marks === chatRedraw.sizeBefore && chatRedraw.sizeAfter === chatRedraw.sizeBefore,
      JSON.stringify(chatRedraw));
    // 流式输出不再有闪烁光标
    check('右侧问答栏没有闪烁光标节点', await page.evaluate(() => document.querySelectorAll('.cursor').length === 0));
  }

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n多标签 P1：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
