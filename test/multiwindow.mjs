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
  // ---- 跨窗口同步：同一会话在两个窗口都打开时，一边的改动要出现在另一边 ----
  await a.evaluate(() => window.__ctx.newSession({ silent: true }));
  const aSid = await a.evaluate(() => window.__ctx.activeSession);
  const scopeKey = await a.evaluate(async (sid) => {
    const { windowStorage } = await import('/js/window-storage.js');
    const map = JSON.parse(windowStorage.getItem('reader.activeSession') || '{}');
    return Object.entries(map).find(([, v]) => v === sid)?.[0] || '';
  }, aSid);
  await b.evaluate(async (sid, key) => {
    const { windowStorage } = await import('/js/window-storage.js');
    const map = JSON.parse(windowStorage.getItem('reader.activeSession') || '{}');
    map[key] = sid;
    windowStorage.setItem('reader.activeSession', JSON.stringify(map));
    await window.__ctx.restoreSession(window.__state.doc.docId, { only: 'chat' });
  }, aSid, scopeKey);
  check('Both windows display the same shared session', (await read(b)).sid === aSid);
  for (const page of [a, b]) {
    await page.evaluate(async () => {
      const m = await import('/js/sessions.js');
      m.sessionsHideEntryCard();
    });
  }
  await a.evaluate(async () => {
    window.__ctx.addEntry({ block: 'chat', tag: '同步测试', kind: 'user', text: '来自窗口A的消息' });
    await window.__ctx.saveSessionNow();
  });
  check('Session edits sync to the other open window', await until(
    () => b.evaluate(() => (window.__state.sessionEntries || []).some((e) => String(e.text || '').includes('来自窗口A'))), 'sync A to B'));
  await b.evaluate(async () => {
    window.__ctx.addEntry({ block: 'chat', tag: '同步测试', kind: 'assistant', text: '来自窗口B的回复' });
    await window.__ctx.saveSessionNow();
  });
  check('Session edits sync back from the other window', await until(
    () => a.evaluate(() => (window.__state.sessionEntries || []).some((e) => String(e.text || '').includes('来自窗口B'))), 'sync B to A'));
  // Keep each real send flow streaming until the test releases it. No upstream or real key.
  for (const page of [a, b]) {
    await page.evaluate(() => {
      window.__settings.data.baseURL = 'http://127.0.0.1/v1';
      window.__ctx.setAgentRead(false);
      localStorage.setItem('reader.session.aiTitle', '0');
      const nativeFetch = window.fetch;
      window.fetch = (url, options) => {
        if (url !== '/api/chat') return nativeFetch(url, options);
        const stream = new ReadableStream({ start(controller) {
          window.completeTestReply = (content) => {
            const payload = JSON.stringify({ choices: [{ delta: { content } }] });
            controller.enqueue(new TextEncoder().encode('data: ' + payload + '\n\ndata: [DONE]\n\n'));
            controller.close();
          };
        } });
        return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
      };
    });
  }
  async function beginReply(page, question) {
    await page.evaluate((text) => {
      document.querySelector('#chatInput').value = text;
      void window.__ctx.send();
    }, question);
    await until(() => page.evaluate(() => typeof window.completeTestReply === 'function' && window.__state.busy), 'real send reaches stream');
    await page.evaluate(() => window.__ctx.saveSessionNow());
  }
  await beginReply(a, '窗口 A 的交错提问');
  check('Receiving window treats an active pending reply as waiting', await until(() => b.evaluate(() =>
    document.getElementById('aiArea').textContent.includes('正在等待另一窗口的回答')), 'receiving window shows waiting reply'));
  await beginReply(b, '窗口 B 的交错提问');
  await sleep(350); // B's save is queued in A while A is busy.
  await a.evaluate(() => window.completeTestReply('窗口 A 的完整回答'));
  await until(() => a.evaluate(() => !window.__state.busy), 'A finishes its stream');
  await sleep(350); // The old remote replay ran here, before the 800ms local save.
  await b.evaluate(() => window.completeTestReply('窗口 B 的完整回答'));
  for (const page of [a, b]) {
    check('Both finished replies replace pending records in the displayed conversation', await until(() =>
      page.evaluate(() => ['窗口 A 的完整回答', '窗口 B 的完整回答'].every((text) =>
        window.__state.sessionEntries.some((row) => row.status === 'complete' && row.text === text)
        && document.getElementById('aiArea').textContent.includes(text))), 'both completed streams render'));
  }
  const mergeDoc = `multiwindow-merge-${Date.now().toString(36)}`;
  const mergeURL = `/api/session?doc=${encodeURIComponent(mergeDoc)}&sid=${encodeURIComponent(aSid)}&merge=1`;
  const [ra, rb] = await Promise.all([
    post(a, mergeURL, { entries: [{ id: 'msg-a', kind: 'answer', text: 'A 端并发消息' }], history: [] }),
    post(b, mergeURL, { entries: [{ id: 'msg-b', kind: 'answer', text: 'B 端并发消息' }], history: [] }),
  ]);
  check('Concurrent writes to one session both succeed', ra === 200 && rb === 200);
  const merged = await (await fetch(`${base}/api/session?doc=${encodeURIComponent(mergeDoc)}&sid=${encodeURIComponent(aSid)}`)).json();
  const mergedTexts = (merged.entries || []).map((e) => e.text);
  check('Concurrent merged saves keep both messages', mergedTexts.includes('A 端并发消息') && mergedTexts.includes('B 端并发消息'));
  await Promise.all([a.evaluate(() => window.__ctx.saveSessionNow()), b.evaluate(() => window.__ctx.saveSessionNow())]);
  await sleep(900);
  const progress = await (await fetch(base + '/api/state')).json();
  check('Concurrent progress saves retain both papers', progress.docs[sa.doc]?.page === 4 && progress.docs[sb.doc]?.page === 9);
  let duplicate = await newWindow(a, 'a.pdf');
  const sd = await read(duplicate);
  check('Same paper opens at the source reading position', sd.page === 4);
  const notesURL = `/api/notes?doc=${encodeURIComponent(sa.doc)}`;
  check('Duplicate paper can save notes without an edit lock', await post(duplicate, notesURL, { items: [{ id: 'sync-note', page: 4, rects: [], text: '另一窗口的笔记', ts: Date.now() }] }) === 200);
  check('Duplicate window shows no edit-lock notice', await duplicate.evaluate(() => !document.getElementById('windowEditNotice')));
  // 笔记采用「后写覆盖 + 广播刷新」：模拟另一窗口保存后的广播，主窗口应重新拉取同一篇文档的笔记
  await a.evaluate((docId) => {
    const ch = new BroadcastChannel('prt.reader.windows');
    ch.postMessage({ type: 'session-saved', kind: 'notes', docId, sender: 'acceptance-peer' });
    setTimeout(() => ch.close(), 600);
  }, sa.doc);
  check('Notes refresh when another window saves', await until(
    () => a.evaluate(() => window.__ctx.highlights.some((h) => h.id === 'sync-note')), 'notes refresh'));
  await ipc(duplicate, 'close');
  await until(async () => (await pages()).length === 2, 'close duplicate');
  check('Closing one reader leaves the service and other windows alive', child.exitCode === null && (await fetch(base + '/api/health')).ok);
  // ---- 把上栏标签拖出标签栏＝生成新窗口（用户明确要求）----
  await open(a, 'c.pdf');
  await until(async () => (await read(a)).name === 'c.pdf', 'c opened');
  // Grab the title, not the tab's geometric centre: the close button sits at
  // the right edge and pointerdown on it must not start a drag.
  const tabBox = await a.$eval('.doc-tab.active .tab-title', (el) => {
    const r = el.getBoundingClientRect();
    const bar = el.closest('.doc-tab').getBoundingClientRect();
    return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2, bottom: bar.bottom };
  });
  const beforeDrag = await pages();
  await a.mouse.move(tabBox.x, tabBox.y);
  await a.mouse.down();
  await a.mouse.move(tabBox.x, tabBox.y + 10, { steps: 3 });
  await a.mouse.move(tabBox.x, tabBox.bottom + 140, { steps: 8 });
  await a.mouse.up();
  const cwin = await until(async () => (await pages()).find((q) => !beforeDrag.includes(q)), 'drag-out window');
  await ready(cwin);
  check('Dragging a tab out of the tab bar opens a new window', (await read(cwin)).name === 'c.pdf');
  const sourceRemoved = await until(async () => {
    const tabsNow = (await read(a)).tabs;
    return tabsNow.includes((await read(cwin)).doc) ? null : true;
  }, 'source tab removed');
  check('Drag-out removes the source tab after the destination loads', sourceRemoved);
  const back = await until(async () => { const r = await read(a); return r.name === 'a.pdf' ? r : null; }, 'source back');
  check('Dragged-out tab leaves the source window on its other paper', back.name === 'a.pdf');
  await a.evaluate(() => window.__viewer.goToPage(4));
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
