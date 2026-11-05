/** Real WebView2 multi-window acceptance, with synthetic PDFs and isolated data only. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { stageExe, spawnReader, stopChild } from './_exe.mjs';
import { assertIsolatedDataDir } from './_env.mjs';

const staged = stageExe('multiwindow');
const dataDir = assertIsolatedDataDir(path.join(staged.dir, 'data'));
const papersDir = path.join(staged.dir, 'papers');
fs.mkdirSync(dataDir); fs.mkdirSync(papersDir);
for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(papersDir, name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function until(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const r = await fn(); if (r) return r; } catch {} await sleep(100); }
  throw new Error(`Timeout: ${label}`);
}
let count = 0;
function check(label, value) { assert.ok(value, label); count++; console.log(`PASS ${label}`); }
let child, browser, base;
// Local workspace state (tabs, per-window progress) lives in origin-scoped localStorage,
// so a real restart must keep the same local-service origin. The shipped EXE starts at
// 8787 and stays there; only the CDP port is fresh on each start.
let servicePort = null;
const errors = [];
const observed = new WeakSet();
async function pages() {
  const list = (await browser.pages()).filter((p) => p.url().startsWith(base));
  for (const p of list) if (!observed.has(p)) { observed.add(p); p.on('pageerror', (e) => errors.push(String(e))); }
  return list;
}
async function start() {
  const httpPort = servicePort || (servicePort = await port());
  const debugPort = await port(); base = `http://127.0.0.1:${httpPort}`;
  child = spawnReader(staged.exe, { args: ['--port', String(httpPort)], env: {
    PRT_DATA_DIR: dataDir, PRT_PAPERS_DIR: papersDir, PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  } });
  await until(async () => (await fetch(base + '/api/health')).ok, 'HTTP');
  const ws = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl, 'CDP');
  browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  await until(async () => (await pages()).length, 'initial page');
  for (const page of await pages()) await ready(page);
}
async function ready(page) {
  await page.waitForFunction(() => window.__ctx && document.querySelector('#windowsBtn'), { timeout: 30000 });
  await sleep(450);
}
const read = async (p) => p.evaluate(() => ({ id: window.__PRT_WINDOW_ID, doc: window.__state.doc?.docId, name: window.__state.doc?.name,
  page: window.__viewer.current, tabs: window.__ctx.tabs.map((t) => t.docId), sid: window.__ctx.activeSession,
  notice: document.getElementById('windowEditNotice')?.textContent, width: innerWidth, height: innerHeight }));
async function open(p, name) { await p.evaluate(async (n) => { const doc = window.__state.papers.find((d) => d.name === n); await window.__ctx.openDoc(doc); }, name); }
async function newWindow(p, name, move = false) {
  const before = await pages();
  await p.evaluate(async (n, m) => {
    const d = window.__state.papers.find((d) => d.name === n);
    await window.__ctx.openReaderWindow(d, { move: m });
  }, name, move);
  const q = await until(async () => (await pages()).find((q) => !before.includes(q)), 'new reader');
  await ready(q); return q;
}
async function ipc(p, type, extra = {}) { await p.evaluate((t, e) => window.ipc.postMessage(JSON.stringify({ type: t, ...e })), type, extra); }
async function post(p, url, body) { return p.evaluate(async (u, b) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, url, body); }
try {
  await start();
  let a = (await pages())[0];
  await open(a, 'a.pdf');
  await a.evaluate(() => window.__viewer.goToPage(4));
  const sa = await read(a);
  check('Main reader opened synthetic paper', sa.name === 'a.pdf' && sa.page === 4);
  // Context menus are real user entry points, not just diagnostics.
  await a.click('.doc-tab', { button: 'right' });
  const labels = await a.$$eval('#tabMenu button', (bs) => bs.map((b) => b.textContent));
  check('Tab context menu supports both copy and move to a new window', labels.includes('在新窗口打开') && labels.includes('移到新窗口'));
  await a.keyboard.press('Escape');
  let b = await newWindow(a, 'b.pdf');
  const sb = await read(b);
  check('Native windows have independent identities and documents', sb.id !== sa.id && sb.name === 'b.pdf' && (await read(a)).name === 'a.pdf');
  check('New window contains only its chosen document', sb.tabs.length === 1);
  await b.evaluate(() => window.__viewer.goToPage(9));
  check('Scrolling one window preserves the other position', (await read(a)).page === 4 && (await read(b)).page === 9);
  await b.evaluate(async () => { const { windowStorage } = await import('/js/window-storage.js'); windowStorage.setItem('reader.ui', JSON.stringify({ style: { theme: 'dark' } })); });
  check('Appearance writes stay in their own window', await a.evaluate(() => !JSON.parse(localStorage.getItem('reader.ui') || '{}').style?.theme?.includes('dark')));
  await Promise.all([a.evaluate(() => window.__ctx.newSession({ silent: true })), b.evaluate(() => window.__ctx.newSession({ silent: true }))]);
  const ids = await Promise.all([a, b].map((p) => p.evaluate(() => window.__ctx.activeSession)));
  // Use the real persisted session URLs to check single-writer protection independent of UI defaults.
  const sharedURL = `/api/session?doc=multiwindow-shared&sid=acceptance`;
  await a.evaluate((u) => fetch(u), sharedURL);
  await b.evaluate((u) => fetch(u), sharedURL);
  check('First window can save a shared session', await post(a, sharedURL, { entries: [{ kind: 'answer', text: 'keep me' }], history: [] }) === 200);
  check('Second window cannot overwrite the shared session', await post(b, sharedURL, { entries: [], history: [] }) === 409);
  check('Rejected save preserves stored conversation', (await (await fetch(base + sharedURL)).json()).entries[0].text === 'keep me');
  await Promise.all([a.evaluate(() => window.__ctx.saveSessionNow()), b.evaluate(() => window.__ctx.saveSessionNow())]);
  await sleep(800);
  const progress = await (await fetch(base + '/api/state')).json();
  check('Concurrent progress saves retain both papers', progress.docs[sa.doc]?.page === 4 && progress.docs[sb.doc]?.page === 9);
  let duplicate = await newWindow(a, 'a.pdf');
  const sd = await read(duplicate);
  check('Same paper opens at the source reading position', sd.page === 4);
  const notesURL = `/api/notes?doc=${encodeURIComponent(sa.doc)}`;
  check('Duplicate paper cannot overwrite notes', await post(duplicate, notesURL, { items: [{ id: 'must-not-write', text: 'bad' }] }) === 409);
  check('Duplicate paper shows editing ownership notice', await duplicate.$eval('#windowEditNotice', (n) => !n.hidden));
  await ipc(duplicate, 'close');
  await until(async () => (await pages()).length === 2, 'close duplicate');
  check('Closing one reader leaves the service and other windows alive', child.exitCode === null && (await fetch(base + '/api/health')).ok);
  await open(a, 'c.pdf');
  let c = await newWindow(a, 'c.pdf', true);
  await until(async () => (await read(c)).name === 'c.pdf', 'moved reader');
  check('Move removes original tab only after destination loads', !(await read(a)).tabs.includes((await read(c)).doc));
  check('Moved document gets editing ownership', await c.evaluate(async () => {
    const u = `/api/notes?doc=${encodeURIComponent(window.__state.doc.docId)}`;
    const r = await fetch(u); const current = await r.json();
    return (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current) })).ok;
  }));
  await ipc(a, 'windows-tile'); await sleep(1200);
  const afterTile = await Promise.all((await pages()).map(read));
  console.log('Tiled readers:', JSON.stringify(afterTile));
  check('Tiling keeps all three native readers operational', afterTile.length === 3 && (await read(b)).page === 9);
  await a.screenshot({ path: path.join(staged.dir, 'reader-main.png') });
  await b.screenshot({ path: path.join(staged.dir, 'reader-second.png') });
  // A fake missing document exercises readiness failure without removing the source tab.
  const beforeFailure = (await read(a)).tabs;
  await a.evaluate(() => window.__ctx.openReaderWindow({ docId: 'missing-file', name: 'missing.pdf' }, { move: true }));
  await until(async () => (await pages()).length === 3, 'failed open cleanup');
  check('Failed destination retains source tabs and cleans up failed window', JSON.stringify((await read(a)).tabs) === JSON.stringify(beforeFailure));
  const expected = await Promise.all((await pages()).map(read));
  await ipc(a, 'windows-quit');
  await until(() => child.exitCode !== null, 'save layout and exit');
  browser.disconnect(); browser = null;
  await start();
  await until(async () => (await pages()).length === 3, 'restore all windows');
  // Restoring a window reopens its document asynchronously; wait until every reader settled.
  const restored = await until(async () => {
    const rows = await Promise.all((await pages()).map(read));
    return rows.length === 3 && rows.every((r) => r.doc) ? rows : null;
  }, 'restore readers');
  check('Restart restores all window identities and active papers', expected.every((s) => restored.some((r) => r.id === s.id && r.doc === s.doc)));
  check('Restart restores independent reading positions', expected.every((s) => restored.some((r) => r.id === s.id && r.page === s.page)));
  // The original main window is not special: closing it must not end the process.
  a = await until(async () => { for (const p of await pages()) if ((await read(p)).id === sa.id) return p; }, 'find main');
  await ipc(a, 'close');
  await until(async () => (await pages()).length === 2, 'main closed');
  check('Closing original main window leaves secondary windows usable', child.exitCode === null);
  for (const p of await pages()) await ipc(p, 'close');
  await until(() => child.exitCode !== null, 'last close exits');
  check('Last window closes the process cleanly', child.exitCode === 0);
  check('No uncaught page exceptions', errors.length === 0);
  console.log(`${count} multi-window checks passed. Artifacts: ${staged.dir}`);
} finally {
  browser?.disconnect(); await stopChild(child);
}
