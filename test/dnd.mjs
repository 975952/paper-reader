/**
 * 左栏文件拖拽的「禁止圆环」回归测试（真实浏览器拖拽事件链）。
 *
 * 背景：只接管 dragover 时，光标刚进入新元素的那一帧 dragenter 没有被 preventDefault，
 * Chrome 会先显示禁止圆环、下一帧才变回 move —— 拖动经过一行行文件/文件夹时看起来就是一直闪。
 * 这个套件用 CDP 的真实拖拽管道（Input.setInterceptDrags + Input.dispatchDragEvent）检查：
 * 页面上每个区域收到的 dragenter / dragover 都必须被接管，且 dropEffect 不能是 none。
 *
 * 跑法：
 *   cd test && node dnd.mjs                  # 自起隔离 Node 服务
 *   BASE=http://127.0.0.1:8787 node dnd.mjs   # 测已启动的实例（比如 exe 验收入口；会在它的数据目录里建测试文件夹）
 * 需要本机 Chrome（CHROME 环境变量可覆盖）。自起服务时用隔离目录，不碰真实 papers/ data/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const EXTERNAL_BASE = process.env.BASE || '';
let scratch = null;
let DATA = '';
let PAPERS = '';
if (!EXTERNAL_BASE) {
  scratch = fs.mkdtempSync(path.join(SANDBOX, 'dnd-'));
  DATA = path.join(scratch, 'data');
  PAPERS = path.join(scratch, 'papers');
  assertIsolatedDataDir(DATA);
  fs.mkdirSync(DATA);
  fs.mkdirSync(PAPERS);
  const fixture = path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf');
  for (let i = 1; i <= 12; i += 1) fs.copyFileSync(fixture, path.join(PAPERS, `p${i}.pdf`));
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'cn.pdf'));
}

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

let server = null;
let BASE = EXTERNAL_BASE;
if (!BASE) {
  const port = await findPort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), PRT_PAPERS_DIR: PAPERS, PRT_DATA_DIR: DATA,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore',
  });
}

let browser = null;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('服务可用', ready, BASE);
  if (!ready) throw new Error('server failed to start');
  // 两个文件夹：被拖入的目标必须是真实文件夹行
  for (const name of ['待读', '深度学习']) {
    const r = await fetch(`${BASE}/api/folders?name=${encodeURIComponent(name)}`, { method: 'POST' });
    if (!r.ok) throw new Error(`创建文件夹失败: ${name} ${r.status}`);
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__state && !!window.__ctx, { timeout: 30000 });
  const papers = await (await fetch(`${BASE}/api/papers`)).json();
  await page.goto(`${BASE}/?open=${encodeURIComponent(papers.papers[0].name)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.viewerDocId, { timeout: 30000 }).catch(() => {});
  await wait(800);
  await page.evaluate(() => {
    if ((document.getElementById('leftSide')?.getBoundingClientRect().width || 0) < 50) document.getElementById('topbarLeftToggle')?.click();
  });
  await wait(500);
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await wait(500);
  check('左栏文件列表可见', await page.evaluate(() => document.querySelectorAll('#fileList li').length > 0));
  check('临时调试标记已移除（#prt-dnd-ver）', await page.evaluate(() => !document.getElementById('prt-dnd-ver')));

  await page.evaluate(() => {
    window.__dragLog = [];
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.addEventListener(type, (e) => {
        let types = [];
        let dropEffect = '';
        try { types = Array.from(e.dataTransfer?.types || []); dropEffect = e.dataTransfer?.dropEffect || ''; } catch { /* ignore */ }
        window.__dragLog.push({ type, prevented: e.defaultPrevented, x: e.clientX, y: e.clientY, types, dropEffect });
      });
    }
  });

  const client = await page.createCDPSession();
  let dragData = null;
  client.on('Input.dragIntercepted', (ev) => { dragData = ev.data; });
  await client.send('Input.setInterceptDrags', { enabled: true });

  const points = await page.evaluate(() => {
    const rect = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return null;
      return { x: Math.round(r.x + Math.min(r.width / 2, 100)), y: Math.round(r.y + Math.min(r.height / 2, 30)) };
    };
    const rows = [...document.querySelectorAll('#fileList li')];
    const rowAt = (n) => {
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x + r.width * 0.4), y: Math.round(r.y + r.height / 2), text: (n.textContent || '').trim().slice(0, 20) };
    };
    const folderRow = rows.find((n) => n.classList.contains('folder'));
    const fileRow = rows.find((n) => n.dataset.name && !n.classList.contains('folder'));
    return {
      folder: folderRow ? rowAt(folderRow) : null,
      file: fileRow ? rowAt(fileRow) : null,
      fileName: fileRow?.dataset.name || '',
      filePath: fileRow?.dataset.path || fileRow?.dataset.name || '',
      listBlank: (() => {
        const l = document.getElementById('fileList');
        if (!l) return null;
        const r = l.getBoundingClientRect();
        return { x: Math.round(r.x + r.width * 0.5), y: Math.round(r.bottom - 6) };
      })(),
      scrollbar: (() => {
        const l = document.getElementById('fileList');
        if (!l || l.scrollHeight <= l.clientHeight + 2) return null;
        const r = l.getBoundingClientRect();
        return { x: Math.round(r.right - 6), y: Math.round(r.top + 30) };
      })(),
      dropzone: rect('#dropzone'),
      leftBlank: rect('#leftSide'),
      viewer: rect('#viewer'),
      right: rect('#rightCols'),
      composer: rect('#composer'),
      topbar: rect('.topbar'),
    };
  });
  check('拿到文件夹行 / 文件行', !!points.folder && !!points.file,
    `folder=${points.folder?.text} file=${points.file?.text}`);
  if (!points.folder || !points.file) throw new Error('没有可拖拽的行');

  const mouse = (type, x, y, extra = {}) => client.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', clickCount: 1, ...extra,
  });
  await mouse('mouseMoved', points.file.x, points.file.y, { buttons: 0 });
  await mouse('mousePressed', points.file.x, points.file.y, { buttons: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMoved', points.file.x + i * 4, points.file.y + i * 2, { buttons: 1 });
    await wait(30);
  }
  for (let i = 0; i < 40 && !dragData; i += 1) await wait(50);
  check('浏览器真的开始了拖拽（dragstart 触发并带上内部 MIME）',
    !!dragData && (dragData.items || []).some((it) => it.mimeType === 'application/x-prt-paper'),
    (dragData?.items || []).map((it) => it.mimeType).join(', '));
  if (!dragData) throw new Error('拖拽没有开始');

  await page.evaluate(() => { window.__dragLog = []; });
  const pathPoints = [
    ['文件夹行', points.folder],
    ['列表空白', points.listBlank],
    ['列表滚动条', points.scrollbar],
    ['拖入区', points.dropzone],
    ['左栏空白', points.leftBlank],
    ['PDF 阅读区', points.viewer],
    ['右栏', points.right],
    ['输入区', points.composer],
    ['顶栏', points.topbar],
    ['窗口右下角', { x: 1392, y: 896 }],
  ].filter(([, p]) => p);
  for (const [, p] of pathPoints) {
    await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x: p.x, y: p.y, data: dragData });
    await client.send('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data: dragData });
    await wait(30);
  }
  const log = await page.evaluate(() => window.__dragLog);
  const enters = log.filter((e) => e.type === 'dragenter');
  const overs = log.filter((e) => e.type === 'dragover');
  const badEnters = enters.filter((e) => !e.prevented);
  const badOvers = overs.filter((e) => !e.prevented || e.dropEffect === 'none');
  check(`${pathPoints.length} 个区域都收到了 dragover`, overs.length >= pathPoints.length - 2, `${overs.length} 条`);
  check('所有 dragenter 都被接管（否则新目标第一帧闪禁止圆环）',
    badEnters.length === 0, badEnters.map((e) => `(${e.x},${e.y})`).join(' '));
  check('所有 dragover 都被接管且 dropEffect=move',
    badOvers.length === 0, badOvers.map((e) => `(${e.x},${e.y}) dropEffect=${e.dropEffect}`).join(' '));
  if (points.scrollbar) {
    check('列表滚动条位置也收到并被接管的 dragover',
      log.some((e) => e.type === 'dragover' && Math.abs(e.x - points.scrollbar.x) <= 2 && e.prevented && e.dropEffect === 'move'));
  }

  // 接管之后 drop 还要能用：把一个根目录 PDF 拖到「待读」文件夹行上松手
  await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x: points.folder.x, y: points.folder.y, data: dragData });
  await client.send('Input.dispatchDragEvent', { type: 'dragOver', x: points.folder.x, y: points.folder.y, data: dragData });
  await client.send('Input.dispatchDragEvent', { type: 'drop', x: points.folder.x, y: points.folder.y, data: dragData });
  await wait(900);
  const after = await (await fetch(`${BASE}/api/papers`)).json();
  const moved = (after.papers || []).find((p) => p.name === points.fileName);
  check('drop 仍然生效：拖到文件夹行松手后文件进入该文件夹',
    !!moved && moved.folder === '待读', `folder=${moved?.folder || '(无)'} path=${moved?.path || ''}`);
  await mouse('mouseReleased', points.file.x + 32, points.file.y + 16, { buttons: 0 });

  check('浏览器无未处理脚本错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  if (server) server.kill();
  await wait(400);
  if (scratch) {
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n拖拽接管验收：${checks.length} 条断言，失败 ${failed.length} 条`);
if (failed.length) {
  for (const f of failed) console.log(`  · ${f.label}`);
  process.exitCode = 1;
}
