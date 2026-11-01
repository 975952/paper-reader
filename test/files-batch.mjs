/**
 * 左栏文件列表：多选 / 框选 / 批量操作 + 顺序稳定性验收（2026-11）
 *  - Ctrl 点选、Shift 区间选、左侧细条拖框多选；
 *  - 多选后右键有「删除所选 / 移动到…」，Delete 批量删除；
 *  - 新导入的文件追加在末尾（不再按修改时间自动排到最前面）；
 *  - 轻轻一拖 / 拖到自己身上不再把文件甩到列表最下面。
 *
 *   node test/files-batch.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'files-batch-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf');
const OTHER = path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf');
for (const name of ['alpha.pdf', 'beta.pdf', 'gamma.pdf']) fs.copyFileSync(FIXTURE, path.join(PAPERS, name));

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
  page.on('console', (m) => { if (/PRT_MOVE/.test(m.text())) console.log('[page]', m.text()); });
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state && window.__state.papers.length >= 3, { timeout: 40000 });
  // 首页默认收起左栏：展开文件面板，让行有真实高度
  await page.evaluate(() => document.querySelector('#railLeft .rail-btn[data-rail="files"]')?.click());
  await wait(700);

  const rows = () => page.evaluate(() => [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')].map((li) => {
    const r = li.getBoundingClientRect();
    const g = li.querySelector('.file-grip')?.getBoundingClientRect();
    return { path: li.dataset.path, name: li.dataset.name, x: g ? g.left + g.width / 2 : r.left + 12, y: r.top + r.height / 2, h: r.height, bottom: r.bottom, sel: li.classList.contains('selected') };
  }));
  const order = async () => (await rows()).map((r) => r.path);
  const clearSel = async () => { await page.keyboard.press('Escape'); await wait(120); };
  const clickMod = async (index, mods) => page.evaluate((i, m) => {
    const row = [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')][i];
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: m.ctrl, metaKey: m.ctrl, shiftKey: m.shift }));
  }, index, mods);

  /* ── 1. 初始顺序稳定：刷新后不自动重排 ── */
  const order1 = await order();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length >= 3, { timeout: 40000 });
  await page.evaluate(() => document.querySelector('#railLeft .rail-btn[data-rail="files"]')?.click());
  await wait(700);
  const order2 = await order();
  check('刷新后文件顺序不变（不再自动排序）', JSON.stringify(order1) === JSON.stringify(order2), `${order1.join(',')} vs ${order2.join(',')}`);

  /* ── 2. 新导入的文件追加到末尾，而不是按时间插到最前 ── */
  const newName = 'ZZ-new-import.pdf';
  fs.copyFileSync(OTHER, path.join(scratch, newName));
  const input = await page.$('#fileInput');
  await input.uploadFile(path.join(scratch, newName));
  await page.waitForFunction((n) => [...document.querySelectorAll('#fileList li[data-name]')].some((li) => li.dataset.name === n), { timeout: 30000 }, newName);
  await wait(600);
  const order3 = await order();
  check('新导入文件追加在列表末尾', order3[order3.length - 1] === newName, order3.join(','));

  /* ── 3. Ctrl 点选 + 批量删除 ── */
  await clickMod(0, { ctrl: true });
  await clickMod(1, { ctrl: true });
  let state1 = await page.evaluate(() => ({ sel: [...window.__state.fileSel], multi: document.body.classList.contains('files-multi'), selectedRows: document.querySelectorAll('#fileList li.selected').length }));
  check('Ctrl 点击可多选', state1.sel.length === 2 && state1.selectedRows === 2 && state1.multi, JSON.stringify(state1));

  const ctxMenu = await page.evaluate((i) => {
    const row = [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')][i];
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    const menu = document.querySelector('#fileCtx');
    return { hidden: menu.hidden, items: [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent) };
  }, 0);
  check('多选后右键出现批量菜单', !ctxMenu.hidden && ctxMenu.items.some((t) => /删除所选/.test(t)) && ctxMenu.items.some((t) => /移动到/.test(t)), ctxMenu.items.join(' / '));

  const beforeDelete = (await order()).length;
  await page.evaluate(() => { [...document.querySelectorAll('#fileCtx .ctx-item')].find((b) => /删除所选/.test(b.textContent))?.click(); });
  await page.waitForFunction((n) => document.querySelectorAll('#fileList li[data-path]:not(.folder)').length === n, { timeout: 20000 }, beforeDelete - 2);
  await wait(400);
  const afterDelete = await order();
  check('批量删除所选文件', afterDelete.length === beforeDelete - 2, `${beforeDelete} → ${afterDelete.length}`);
  const paperFiles = fs.readdirSync(PAPERS).filter((f) => f.endsWith('.pdf'));
  check('批量删除同时删了磁盘文件', paperFiles.length === afterDelete.length, paperFiles.join(','));

  /* ── 4. Shift 区间选 ── */
  await clearSel();
  await clickMod(0, { ctrl: true });
  await clickMod(1, { shift: true });
  const shiftSel = await page.evaluate(() => [...window.__state.fileSel]);
  check('Shift 点击按区间多选', shiftSel.length === 2, shiftSel.join(','));

  /* ── 5. 左侧细条拖框多选 ── */
  await clearSel();
  const list = await rows();
  const from = list[0];
  const to = list[list.length - 1];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 80, to.bottom - 4, { steps: 12 });
  await page.mouse.up();
  await wait(300);
  const marqueeSel = await page.evaluate(() => ({
    sel: [...window.__state.fileSel],
    rows: document.querySelectorAll('#fileList li.selected').length,
  }));
  check('从左侧细条拖框可以批量选文件', marqueeSel.sel.length >= 2 && marqueeSel.rows === marqueeSel.sel.length,
    JSON.stringify(marqueeSel));
  await clearSel();

  /* ── 6. 拖到自己身上 / 轻轻一拖：顺序不变（不会跑到最下面） ── */
  const beforeDrag = await order();
  const dragInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')];
    const row = rows[0];
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: 1, clientY: 1 }));
    const r = row.getBoundingClientRect();
    const y = r.bottom - 2;                    // 落在自己这一行的下半部分
    row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { y };
  });
  await wait(700);
  const afterSelfDrop = await order();
  check('拖到自己身上不再把文件甩到最下面', JSON.stringify(beforeDrag) === JSON.stringify(afterSelfDrop),
    `${beforeDrag.join(',')} → ${afterSelfDrop.join(',')}`);

  /* ── 7. 批量移动：多选后移动到新建文件夹 ── */
  const dir = await fetch(`${BASE}/api/folders?name=批量移动测试`, { method: 'POST' });
  check('创建批量移动目标文件夹', dir.ok, `HTTP ${dir.status}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ctx && window.__state?.papers.length >= 2, { timeout: 40000 });
  await page.evaluate(() => document.querySelector('#railLeft .rail-btn[data-rail="files"]')?.click());
  await wait(800);
  await clickMod(0, { ctrl: true });
  await clickMod(1, { ctrl: true });
  const moveMenu = await page.evaluate((i) => {
    const row = [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')][i];
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    [...document.querySelectorAll('#fileCtx .ctx-item')].find((b) => /移动到/.test(b.textContent))?.click();
    return [...document.querySelectorAll('#fileCtx .ctx-item')].map((b) => b.textContent);
  }, 0);
  const targetItem = moveMenu.find((t) => /批量移动测试/.test(t));
  check('批量菜单里能选目标文件夹', !!targetItem, moveMenu.join(' / '));
  await page.evaluate(() => {
    [...document.querySelectorAll('#fileCtx .ctx-item')].find((b) => /批量移动测试/.test(b.textContent))?.click();
  });
  await wait(1200);
  const listed = await (await fetch(`${BASE}/api/papers`)).json();
  const movedPaths = (listed.papers || []).filter((p) => p.folder === '批量移动测试').map((p) => p.path);
  check('批量移动所选文件到目标文件夹', movedPaths.length === 2, movedPaths.join(','));
  const movedDisk = fs.readdirSync(path.join(PAPERS, '批量移动测试')).filter((f) => f.endsWith('.pdf'));
  check('磁盘上文件确实在目标文件夹里', movedDisk.length === 2, movedDisk.join(','));

  const paperList = async () => (await (await fetch(`${BASE}/api/papers`)).json()).papers || [];
  const inFolder = (list, folder) => list.filter((p) => p.folder === folder).map((p) => p.name);
  const expandFolder = async () => {
    const open = await page.evaluate(() => !!document.querySelector('#fileList ul.folder-children[data-parent="批量移动测试"]'));
    if (!open) await page.evaluate(() => document.querySelector('#fileList li.folder[data-path="批量移动测试"] .folder-arrow')?.click());
    await wait(600);
  };

  /* ── 8. 文件夹里的文件可以拖动排序（之前拖不动：落点被算成「自己所在文件夹」提前 return） ── */
  await expandFolder();
  const children = await page.evaluate(() => [...document.querySelectorAll('#fileList ul.folder-children[data-parent="批量移动测试"] li[data-path]:not(.folder)')].map((li) => li.dataset.path));
  check('文件夹已展开、能看到里面的文件', children.length === 2, children.join(','));
  if (children.length === 2) {
    const beforeChildOrder = inFolder(await paperList(), '批量移动测试');
    await page.evaluate((paths) => {
      const row = [...document.querySelectorAll(`#fileList ul.folder-children[data-parent="批量移动测试"] li[data-path]`)].find((li) => li.dataset.path === paths[0]);
      const target = [...document.querySelectorAll(`#fileList ul.folder-children[data-parent="批量移动测试"] li[data-path]`)].find((li) => li.dataset.path === paths[1]);
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: 1, clientY: 1 }));
      const r = target.getBoundingClientRect();
      const y = r.bottom - 2;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, children);
    await wait(900);
    const afterChildOrder = inFolder(await paperList(), '批量移动测试');
    check('文件夹内拖拽可以调整顺序', JSON.stringify(beforeChildOrder) !== JSON.stringify(afterChildOrder),
      `${beforeChildOrder.join(',')} → ${afterChildOrder.join(',')}`);
  }

  /* ── 9. 单文件右键「移动到…」菜单真的能用（之前点开菜单后不显示 = 没反应） ── */
  await expandFolder(); // 上一次排序可能让面板重绘，重新展开
  const ctxMove = await page.evaluate(() => {
    const row = document.querySelector('#fileList ul.folder-children[data-parent="批量移动测试"] li[data-path]');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    [...document.querySelectorAll('#fileCtx .ctx-item')].find((b) => /移动到/.test(b.textContent))?.click();
    const menu = document.querySelector('#fileCtx');
    return { hidden: menu.hidden, title: menu.querySelector('.ctx-title')?.textContent || '', items: [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent) };
  });
  check('点「移动到…」后菜单正常显示目标列表', !ctxMove.hidden && /移动/.test(ctxMove.title) && ctxMove.items.length >= 1,
    JSON.stringify(ctxMove));
  await page.evaluate(() => {
    [...document.querySelectorAll('#fileCtx .ctx-item')].find((b) => b.textContent === '根目录')?.click();
  });
  await wait(1000);
  const rootAfterMove = inFolder(await paperList(), '');
  check('「移动到…根目录」真的把文件移出来了', rootAfterMove.length >= 1, rootAfterMove.join(','));

  /* ── 10. 多选后整组拖到文件夹（之前只拖走一行 / 没反应） ── */
  await wait(500);
  const paperListNow = async () => (await (await fetch(`${BASE}/api/papers`)).json()).papers || [];
  const rootBefore = (await paperListNow()).filter((p) => p.folder === '').length;
  const folderBefore = (await paperListNow()).filter((p) => p.folder === '批量移动测试').length;
  const rootRows = await page.evaluate(() => [...document.querySelectorAll('#fileList > li[data-path]:not(.folder)')].map((li) => li.dataset.path));
  const toMove = rootRows;
  check('根目录有可多选的文件', toMove.length >= 1, toMove.join(','));
  await page.evaluate((targets) => {
    const rows = [...document.querySelectorAll('#fileList > li[data-path]:not(.folder)')];
    for (const path of targets) {
      const row = rows.find((li) => li.dataset.path === path);
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    }
  }, toMove);
  const selBefore = await page.evaluate(() => [...window.__state.fileSel]);
  check('准备多选根目录文件', selBefore.length === toMove.length, selBefore.join(','));
  await page.evaluate((first) => {
    const row = [...document.querySelectorAll('#fileList > li[data-path]:not(.folder)')].find((li) => li.dataset.path === first);
    const folder = document.querySelector('#fileList li.folder[data-path="批量移动测试"]');
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: 1, clientY: 1 }));
    const r = folder.getBoundingClientRect();
    const y = r.top + r.height / 2;
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: y }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, toMove[0]);
  await wait(1400);
  const folderAfter = (await paperListNow()).filter((p) => p.folder === '批量移动测试').length;
  const rootAfter = (await paperListNow()).filter((p) => p.folder === '').length;
  check('多选后整组拖进文件夹（所选文件全部移走）',
    folderAfter === folderBefore + toMove.length && rootAfter === rootBefore - toMove.length,
    `folder ${folderBefore}→${folderAfter}, root ${rootBefore}→${rootAfter}, moved ${toMove.length}`);

  /* ── 11. 多选后整组拖到列表空白处 = 移回根目录 ── */
  await expandFolder();
  await clearSel();
  const childCount = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#fileList ul.folder-children[data-parent="批量移动测试"] li[data-path]')];
    for (const row of rows) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    return rows.length;
  });
  const selInside = await page.evaluate(() => [...window.__state.fileSel]);
  check('准备框选文件夹里的文件', childCount >= 2 && selInside.length === childCount, `${childCount} / ${selInside.join(',')}`);
  await page.evaluate((first) => {
    const row = [...document.querySelectorAll('#fileList li[data-path]:not(.folder)')].find((li) => li.dataset.path === first);
    const list = document.querySelector('#fileList');
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 300 }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 300 }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, selInside[0]);
  await wait(1400);
  const backToRoot = inFolder(await paperList(), '');
  check('多选后整组拖到空白处移回根目录', backToRoot.length >= 2, backToRoot.join(','));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n文件多选与批量操作：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
}
