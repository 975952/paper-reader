/**
 * 扫描件 OCR（文字版）验收：
 *  1. 扫描件点「生成文字版」→ 逐页交给视觉模型转写，结果按页缓存；
 *  2. 生成后问答自动改用 OCR 文字（不再带页面图），问答应基于文字版；
 *  3. 再次生成命中缓存，不重复花钱；刷新页面后缓存仍在。
 *
 *   node test/ocr.mjs
 *
 * 全部使用隔离数据目录与假模型。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 整页就是一张图片、没有文本层的 3 页扫描件 */
function imageOnlyPdf({ pages = 3, W = 612, H = 792 } = {}) {
  const objects = [];
  const add = (s) => { objects.push(s); return objects.length; };
  const catalog = add(''); const root = add('');
  const raw = Buffer.alloc(W * H * 3, 255);
  for (let y = 60; y < H - 60; y += 18) {
    for (let x = 60; x < W - 60; x++) {
      if ((x * 7 + y * 13) % 23 < 9) { const i = (y * W + x) * 3; raw[i] = 30; raw[i + 1] = 30; raw[i + 2] = 30; }
    }
  }
  const imgData = zlib.deflateSync(raw);
  const image = add({ raw: imgData, dict: `<</Type/XObject/Subtype/Image/Width ${W}/Height ${H}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${imgData.length}>>` });
  const pageObjs = [];
  for (let p = 0; p < pages; p++) {
    const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q\n';
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    pageObjs.push(add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${root} 0 R >>`;
  objects[root - 1] = `<< /Type /Pages /Count ${pages} /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] >>`;
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let size = parts[0].length;
  const push = (buf) => { parts.push(buf); size += buf.length; };
  objects.forEach((s, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n`));
    if (typeof s === 'string') push(Buffer.from(s));
    else { push(Buffer.from(`${s.dict}\nstream\n`)); push(s.raw); push(Buffer.from('\nendstream')); }
    push(Buffer.from('\nendobj\n'));
  });
  const xref = size;
  push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const n of offsets.slice(1)) push(Buffer.from(`${String(n).padStart(10, '0')} 00000 n \n`));
  push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'ocr-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.writeFileSync(path.join(PAPERS, 'scanned-ocr.pdf'), imageOnlyPdf({ pages: 3 }));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
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

/* ── 假上游：转写请求按页码回 OCR_MARKER；普通问答回固定答案；后台提取回 [] ── */
const upstreamLog = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    const last = body.messages?.at(-1);
    const parts = Array.isArray(last?.content) ? last.content : null;
    const text = parts ? (parts.find((p) => p.type === 'text')?.text || '') : String(last?.content || '');
    const imageCount = parts ? parts.filter((p) => p.type === 'image_url').length : 0;
    upstreamLog.push({ sys, text, imageCount, model: body.model });
    if (sys.includes('后台学习记忆提取器')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return;
    }
    let answer;
    if (sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '会话摘要（后台）' } }] })); return;
    }
    if (sys.includes('扫描页转写器')) {
      const page = /第\s*(\d+)\s*页/.exec(text)?.[1] || '?';
      answer = `OCR_MARKER 第 ${page} 页转写：本页手写公式为 $$y = Wx$$，正文讲注意力机制。〔第${page}页〕`;
    } else {
      answer = '基于文字版的回答：本页讲注意力机制与手写公式 y=Wx。';
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,40}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await wait(5);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

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
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'text-mock', visionModel: 'vision-mock', apiKey: 'ocr-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const openDoc = async () => {
    await page.goto(`${BASE}/?open=scanned-ocr.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
    await page.waitForFunction(() => window.__ctx.docProfile?.scanned === true, { timeout: 30000 });
    await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  };
  const transcribes = () => upstreamLog.filter((r) => r.sys.includes('扫描页转写器'));
  const chats = () => upstreamLog.filter((r) => !/扫描页转写器|后台学习记忆提取器|滚动摘要/.test(r.sys));

  await openDoc();

  /* ══════════ 1. 生成文字版：逐页转写 + 缓存 + 结果进右栏 ══════════ */
  upstreamLog.length = 0;
  const ocrResult = await page.evaluate(() => window.__ctx.runOcrDoc());
  check('生成文字版完成（3 页）', Array.isArray(ocrResult?.pages) && ocrResult.pages.length === 3,
    JSON.stringify(ocrResult?.pages));
  check('逐页请求：每页 1 张图 + 视觉模型',
    transcribes().length === 3 && transcribes().every((r) => r.imageCount === 1 && r.model === 'vision-mock'),
    JSON.stringify(transcribes().map((r) => [r.imageCount, r.model])));
  check('转写内容带页码标记', transcribes().every((r) => r.text.includes('页')));
  const ocrEntry = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')]
      .find((n) => n.querySelector('.tag')?.textContent === '文字版（OCR）');
    return { found: !!row, text: row?.querySelector('.text')?.innerText?.slice(0, 80) || '' };
  });
  check('结果进右栏「文字版（OCR）」条目', ocrEntry.found && ocrEntry.text.includes('OCR_MARKER'), ocrEntry.text);
  const cacheInfo = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('reader.ocr.v1:'));
    const raw = keys[0] ? JSON.parse(localStorage.getItem(keys[0])) : null;
    return { keys: keys.length, pages: raw ? Object.keys(raw.pages).length : 0 };
  });
  check('OCR 结果按文件指纹缓存（3 页）', cacheInfo.keys === 1 && cacheInfo.pages === 3, JSON.stringify(cacheInfo));

  /* ══════════ 2. 再点一次命中缓存，不重复请求 ══════════ */
  upstreamLog.length = 0;
  const cachedRun = await page.evaluate(() => window.__ctx.runOcrDoc());
  check('再次生成命中缓存，不发转写请求', transcribes().length === 0 && cachedRun?.pages?.length === 3,
    `transcribes=${transcribes().length}`);

  /* ══════════ 3. 问答自动改用 OCR 文字（不再带页图） ══════════ */
  await page.evaluate(() => {
    const input = document.querySelector('#chatInput');
    input.value = '这一页讲了什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('基于文字版的回答')), { timeout: 30000 });
  const ask = chats().at(-1) || {};
  check('问答改用 OCR 文字作为材料', /OCR 文字版/.test(ask.text) && ask.text.includes('OCR_MARKER'), (ask.text || '').slice(0, 80));
  check('问答不再发页面图（省 token）', ask.imageCount === 0, `images=${ask.imageCount}`);
  check('问答用文本模型（不发图时的主模型）', ask.model === 'text-mock', ask.model);
  const scope = await page.evaluate(() => window.__ctx.sendScopeText({
    docId: window.__state.doc.docId, useFullText: false, scanned: true, docMode: 'scan-ocr', contextIncluded: false,
  }));
  check('发送范围提示写「OCR 文字版」', /OCR 文字版/.test(scope), scope);

  /* ══════════ 4. 刷新页面后缓存仍在，问答仍走文字版 ══════════ */
  upstreamLog.length = 0;
  await openDoc();
  await page.waitForFunction(() => window.__state.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  const restored = await page.evaluate(() => ({ pages: window.__ctx.ocrPages(window.__state.doc.docId) }));
  check('刷新后 OCR 缓存仍在', JSON.stringify(restored.pages) === JSON.stringify([1, 2, 3]), JSON.stringify(restored.pages));
  await page.evaluate(() => {
    const input = document.querySelector('#chatInput');
    input.value = '再说说公式？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].filter((n) => n.textContent.includes('基于文字版的回答')).length >= 2, { timeout: 30000 });
  const ask2 = chats().at(-1) || {};
  check('刷新后问答仍用 OCR 文字且不发页图', /OCR 文字版/.test(ask2.text) && ask2.imageCount === 0,
    `images=${ask2.imageCount}`);

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nOCR：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
