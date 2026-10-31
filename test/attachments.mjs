import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'attachments-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-a.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9Qz0AEYBxVSF8FAJ8cBf4S9o1xAAAAAElFTkSuQmCC', 'base64');
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

/* ── 假模型上游：按 plans 依次回；记录每条请求带的图片数 ── */
const plans = [];
const upstreamRequests = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const last = body.messages?.[body.messages.length - 1];
    const parts = Array.isArray(last?.content) ? last.content : null;
    upstreamRequests.push({
      hasImage: !!parts && parts.some((p) => p.type === 'image_url'),
      imageCount: parts ? parts.filter((p) => p.type === 'image_url').length : 0,
    });
    const plan = plans.shift() || { kind: 'ok', text: '好的，这是回答。' };
    if (plan.kind === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const chunk of (plan.text || '').match(/[\s\S]{1,20}/g) || []) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      await wait(40);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

/** data/ 下所有附件文件（递归） */
function listAttachmentFiles() {
  const out = [];
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(DATA, 'attachments'));
  return out;
}
function readSessionFile(docKey) {
  return JSON.parse(fs.readFileSync(path.join(DATA, `session-${docKey}.json`), 'utf8'));
}

let reader = null;
let browser = null;
try {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const aiPort = upstream.address().port;
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
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'attachments-mock', apiKey: 'attachments-key' }),
  });

  const docIdForApi = 'attach-api-check';
  let h = 5381;
  for (const c of docIdForApi) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  const apiKey = `${docIdForApi}-${h.toString(16)}`;
  const postRaw = (bytes, sid = '') => fetch(`${BASE}/api/attachment?doc=${encodeURIComponent(docIdForApi)}${sid ? `&sid=${sid}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const badType = await postRaw(Buffer.from('definitely not an image'));
  check('后端：非图片内容被拒（400）', badType.status === 400, `${badType.status}`);
  const badId = await fetch(`${BASE}/api/attachment?doc=${encodeURIComponent(docIdForApi)}&id=${encodeURIComponent('../../server.js')}`);
  check('后端：非法附件 id 被拒（400）', badId.status === 400, `${badId.status}`);
  const missing = await fetch(`${BASE}/api/attachment?doc=${encodeURIComponent(docIdForApi)}&id=${'0'.repeat(32)}`);
  check('后端：不存在的附件返回 404', missing.status === 404, `${missing.status}`);
  const upApi = await postRaw(PNG);
  const upApiJson = upApi.ok ? await upApi.json() : {};
  check('后端：上传返回 32 位 id', upApi.ok && /^[0-9a-f]{32}$/.test(upApiJson.id || ''), `${upApi.status} ${upApiJson.id || ''}`);
  const gotApi = await fetch(`${BASE}/api/attachment?doc=${encodeURIComponent(docIdForApi)}&id=${upApiJson.id}`);
  check('后端：读取回来的字节完全一致',
    gotApi.ok && Buffer.compare(Buffer.from(await gotApi.arrayBuffer()), PNG) === 0,
    `${gotApi.status} ${gotApi.headers.get('content-type')}`);
  const apiDir = path.join(DATA, 'attachments', apiKey);
  check('后端：文件落在 data/attachments/<会话键>/<id>.png',
    fs.existsSync(path.join(apiDir, `${upApiJson.id}.png`)));
  // 会话保存时 GC：先留一张孤儿图，再保存一个只引用 upApiJson.id 的会话
  const orphanApi = await postRaw(PNG2).then((r) => r.json());
  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(docIdForApi)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [{ block: 'chat', kind: 'user', text: '后端 GC 检查', screenshot: true, status: 'user', shots: [{ id: upApiJson.id, w: 1, h: 1, label: '截图' }] }],
      history: [], ops: [], updatedAt: Date.now(),
    }),
  });
  const afterGc = fs.existsSync(apiDir) ? fs.readdirSync(apiDir) : [];
  check('后端：会话保存后 GC 保留被引用的图', afterGc.includes(`${upApiJson.id}.png`), afterGc.join(', '));
  check('后端：会话保存后 GC 删掉孤儿图', !afterGc.includes(`${orphanApi.id}.png`), afterGc.join(', '));
  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(docIdForApi)}`, { method: 'DELETE' });
  check('后端：删除会话后附件目录一起删掉', !fs.existsSync(apiDir));

  /* ══════════ 前端：发送时上传 → 会话只存 id → 重开论文按 id 取回 ══════════ */
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.evaluateOnNewDocument(`window.__probePng = ${JSON.stringify(PNG_DATA_URL)};`);

  const openDoc = async () => {
    await page.goto(`${BASE}/?open=fixture-a.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
    await page.waitForFunction(() => document.querySelectorAll('.page[data-page="1"] canvas').length > 0, { timeout: 40000 });
    await page.evaluate(() => window.__ctx.setScopeRange('current'));
    await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
    await wait(600);
  };
  await openDoc();
  const docId = await page.evaluate(() => window.__state.doc.docId);
  plans.push({ kind: 'ok', text: '好的，这是回答。' });
  await page.evaluate(() => {
    window.__ctx.addImageToChat({ dataUrl: window.__probePng, width: 800, height: 500, pages: 1 }, 1, '测试截图');
    const input = document.querySelector('#chatInput');
    input.value = '这张图讲什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('这是回答'), { timeout: 20000 });
  await wait(1400);   // 等会话保存（debounce 800ms）
  const session = readSessionFile(docId);
  const shots = (session.entries || []).find((e) => e.kind === 'user')?.shots || [];
  check('前端：发送后会话里记了截图 id 引用', shots.length === 1 && /^[0-9a-f]{32}$/.test(shots[0].id), JSON.stringify(shots));
  check('前端：会话 JSON 里没有 base64 图片本体', !JSON.stringify(session).includes('data:image'));
  const attFiles = listAttachmentFiles();
  check('前端：图片单独存成 1 个文件', attFiles.length === 1, attFiles.map((f) => path.relative(DATA, f)).join(', '));
  check('前端：文件内容与上传的 PNG 一致',
    attFiles.length === 1 && Buffer.compare(fs.readFileSync(attFiles[0]), PNG) === 0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg.user .shot-img').length > 0, { timeout: 20000 });
  await wait(400);
  const restored = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#aiArea .msg.user')].at(-1);
    const img = last?.querySelector('.shot-img');
    return {
      hasImg: !!img,
      natural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0],
      srcIsData: !!img && img.src.startsWith('data:image/'),
      note: /截图附件未保存/.test(last?.textContent || ''),
    };
  });
  check('前端：重开论文后截图还在（按 id 取回原图）',
    restored.hasImg && restored.srcIsData && restored.natural[0] > 0, `natural=${restored.natural.join('x')}`);
  check('前端：重开后不再出现「截图附件未保存」', !restored.note);

  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [], history: [], ops: [], updatedAt: Date.now() }),
  });
  await wait(300);
  check('前端：清空会话后图片文件全删', listAttachmentFiles().length === 0, `剩 ${listAttachmentFiles().length} 个`);
  check('前端：清空会话后空的附件目录也收掉（data/attachments 下不留空文件夹）',
    !fs.existsSync(path.join(DATA, 'attachments', docId)));

  /* ══════════ 老会话（只有 screenshot 标记）→ 仍然提示重新添加 ══════════ */
  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [
        { block: 'chat', kind: 'user', text: '老会话的带图提问', screenshot: true, status: 'user' },
        { block: 'chat', kind: 'assistant', tag: 'answer', text: '老回答', status: 'complete' },
      ],
      history: [], ops: [], updatedAt: Date.now(),
    }),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await wait(1200);
  const oldRestored = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#aiArea .msg.user')].at(-1);
    return { note: /截图附件未保存/.test(last?.textContent || '') };
  });
  check('前端：老会话没有图片 id 时仍提示「截图附件未保存」', oldRestored.note);

  /* ══════════ 失败 → 重开 → 「重试这次发送」：截图按 id 取回并作为图片发出 ══════════ */
  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [], history: [], ops: [], updatedAt: Date.now() }),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.evaluate(() => window.__ctx.setScopeRange('current'));
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await wait(600);
  plans.push({ kind: 'fail' });
  await page.evaluate(() => {
    window.__ctx.addImageToChat({ dataUrl: window.__probePng, width: 800, height: 500, pages: 1 }, 1, '测试截图');
    const input = document.querySelector('#chatInput');
    input.value = '这次会失败的问题';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .acts button')]
    .some((b) => b.textContent.includes('重试这次发送')), { timeout: 15000 });
  await wait(1400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll('#aiArea .msg.user .shot-img').length > 0, { timeout: 20000 });
  await wait(500);
  const reqBefore = upstreamRequests.length;
  await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .acts button')]
    .find((b) => b.textContent.includes('重试这次发送'))?.click());
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].at(-1)?.textContent.includes('这是回答'), { timeout: 20000 });
  const retryReq = upstreamRequests.slice(reqBefore);
  check('前端：失败后重开、点重试 → 截图作为图片重新发给模型',
    retryReq.some((r) => r.hasImage && r.imageCount === 1),
    JSON.stringify(retryReq.map((r) => ({ hasImage: r.hasImage, n: r.imageCount }))));
  check('前端：重试后的会话仍引用同一张截图（没变孤儿）',
    (readSessionFile(docId).entries || []).find((e) => e.kind === 'user')?.shots?.length === 1
    && listAttachmentFiles().length === 1);

  check('浏览器无未处理脚本错误', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  if (reader) { try { reader.kill(); } catch { /* ignore */ } }
  await new Promise((r) => upstream.close(r));
  await wait(500);
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
}

const passed = checks.filter((x) => x.ok).length;
const failed = checks.filter((x) => !x.ok);
console.log(`\n截图附件「图片单独存」验收：${checks.length} 条断言，失败 ${failed.length} 条`);
if (failed.length) {
  for (const f of failed) console.log(`  · ${f.label}`);
  process.exitCode = 1;
}
