/**
 * 扫描版 PDF：打开时判定页型 → 问答自动带页面图片；「读懂论文」先生成图片阅读索引。
 *
 *   node test/scan-pdf.mjs
 *
 * 全部使用隔离数据目录与假模型（不需要真实 Key）：
 *  - 扫描件 fixture 是测试里现造的「整页就是一张图片、没有文本层」的 PDF；
 *  - 假上游记录每次请求的模型名 / 图片数 / 关键提示词，用来断言前后端链路。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一页「扫描件」：整页一张 DeviceRGB 图片，没有文本层 */
function imageOnlyPdf({ pages = 2, W = 612, H = 792 } = {}) {
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

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'scan-pdf-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.writeFileSync(path.join(PAPERS, 'scanned-paper.pdf'), imageOnlyPdf({ pages: 3 }));
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'text-paper.pdf'));

const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
// 兜底：任何一步卡死都别让进程「假死」在后台（unref：正常结束不受影响）
const watchdog = setTimeout(() => { console.error('测试超时（240s），强制退出'); process.exit(3); }, 240000);
watchdog.unref?.();

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/* ── 假上游：记录模型名 / 图片数 / 系统提示词，按请求类型回不同内容 ── */
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
    upstreamLog.push({ model: body.model, sys, text, imageCount });
    let answer;
    if (/扫描页转写器/.test(sys)) answer = `这是第 ${/\d+/.exec(text)?.[0] || '?'} 页的转写：正文若干、公式 $y=Wx$、图 1 说明。`;
    else if (/读懂论文/.test(sys)) answer = '先给我讲明白的回答（扫描件）：这篇论文讲的是某个方法。〔p.1〕';
    else answer = '扫描件回答：第 1 页讲的是问题定义。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,32}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await wait(10);
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
    body: JSON.stringify({
      baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'text-mock', visionModel: 'vision-mock', apiKey: 'scan-key',
    }),
  });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  /* ══════════ 一、扫描件：页型判定 ══════════ */
  await page.goto(`${BASE}/?open=scanned-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.waitForFunction(() => window.__ctx.docProfile?.scanned === true, { timeout: 30000 });
  const profile = await page.evaluate(() => ({
    scanned: window.__ctx.docProfile.scanned,
    numPages: window.__ctx.docProfile.numPages,
    kinds: window.__ctx.docProfile.pages.map((p) => p.kind),
    scanPages: window.__ctx.docProfile.scanPages,
    avgChars: window.__ctx.docProfile.avgChars,
  }));
  check('打开后判定为扫描件', profile.scanned === true && profile.numPages === 3, JSON.stringify(profile));
  check('逐页页型是 scan（无文本层 + 整页图）', profile.kinds.every((k) => k === 'scan'), profile.kinds.join(','));
  check('扫描页列表完整', JSON.stringify(profile.scanPages) === JSON.stringify([1, 2, 3]), JSON.stringify(profile.scanPages));

  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await page.waitForFunction(() => document.querySelectorAll('#aiArea .ai-block').length > 0, { timeout: 20000 });

  /* ══════════ 二、扫描件问答：自动带当前页图 + 选视觉模型 ══════════ */
  upstreamLog.length = 0;
  await page.evaluate(() => {
    const input = document.querySelector('#chatInput');
    input.value = '这一页讲什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('扫描件回答')), { timeout: 30000 });
  const askLog = upstreamLog.find((row) => row.text.includes('这一页讲什么')) || {};
  check('扫描件问答带页面图片', (askLog.imageCount || 0) >= 1, `images=${askLog.imageCount}`);
  check('带图请求走 visionModel', askLog.model === 'vision-mock', askLog.model);
  check('提示词说明页面图片而不是文本层', /页面图片|扫描件/.test(askLog.sys || ''), (askLog.sys || '').slice(-40));
  check('消息里标注了页图出处', /【第\d+页原图】/.test(askLog.text || ''), (askLog.text || '').slice(-30));
  const scopeHint = await page.evaluate(() => window.__ctx.sendScopeText({
    docId: window.__state.doc.docId, useFullText: true, scanned: true, scanPageCount: 3, contextIncluded: false,
  }));
  check('发送范围提示出现「页图」', /页图/.test(scopeHint), scopeHint);

  /* ══════════ 三、扫描件「读懂论文」：先生成图片阅读索引，再按索引回答 ══════════ */
  upstreamLog.length = 0;
  await page.evaluate(() => window.__ctx.runTeaching('intro', { force: true }));
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('扫描件')), { timeout: 60000 });
  const transcribe = upstreamLog.filter((row) => /扫描页转写器/.test(row.sys));
  const teaching = upstreamLog.find((row) => /读懂论文/.test(row.sys)) || {};
  check('先生成图片阅读索引（逐页转写）', transcribe.length >= 2, `转写 ${transcribe.length} 页`);
  check('转写请求也带页图 + 视觉模型',
    transcribe.every((row) => row.imageCount === 1 && row.model === 'vision-mock'), JSON.stringify(transcribe.map((r) => r.imageCount)));
  check('教学请求拿到图片阅读索引', /图片阅读索引/.test(teaching.text || ''), (teaching.text || '').slice(0, 60));
  check('教学请求仍带当前页图', (teaching.imageCount || 0) >= 1, `images=${teaching.imageCount}`);
  const cached = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('reader.scanDigest.v1:'));
    return { keys: keys.length, sample: keys[0] ? String(localStorage.getItem(keys[0])).slice(0, 40) : '' };
  });
  check('图片阅读索引按文件指纹缓存', cached.keys === 1 && cached.sample.includes('扫描件图片阅读索引'), JSON.stringify(cached));

  /* ══════════ 四、普通文本 PDF 不受影响：不扫描、不带图（除非用户自己加） ══════════ */
  upstreamLog.length = 0;
  await page.goto(`${BASE}/?open=text-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc?.name === 'text-paper.pdf' && window.__ctx.docProfile !== null, { timeout: 40000 });
  const textProfile = await page.evaluate(() => ({
    scanned: window.__ctx.docProfile.scanned,
    avgChars: window.__ctx.docProfile.avgChars,
    kinds: [...new Set(window.__ctx.docProfile.pages.map((p) => p.kind))],
  }));
  check('文本 PDF 判定为非扫描件', textProfile.scanned === false && textProfile.avgChars > 100, JSON.stringify(textProfile));
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    const input = document.querySelector('#chatInput');
    input.value = '这篇论文讲什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => !window.__state.busy
    && [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('扫描件回答') || n.textContent.length > 5), { timeout: 30000 });
  const textAsk = upstreamLog.find((row) => row.text.includes('这篇论文讲什么')) || {};
  check('文本 PDF 问答不带页图', (textAsk.imageCount || 0) === 0, `images=${textAsk.imageCount}`);
  check('文本 PDF 问答用主模型', textAsk.model === 'text-mock', textAsk.model);

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n扫描件：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  // 假上游不关掉会一直占着事件循环：测试失败时进程会「假死」，看不到报错
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
