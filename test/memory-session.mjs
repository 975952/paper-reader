/**
 * 记忆系统验收：
 *  1. 同一会话的滚动摘要（compaction）——超过 3 轮后，早先内容压成摘要并继续注入；
 *  2. 这篇论文之前的会话摘要——新建会话时带上前一会话的摘要；
 *  3. 用户手写的「长期记忆」——存本机 config，并出现在每次问答的 system 里；
 *  4. 三个开关/边界：关闭本篇对话记忆后不再注入；摘要写进会话文件、重载后恢复。
 *
 *   node test/memory-session.mjs
 *
 * 全部使用隔离数据目录与假模型，不读写用户书架与真实配置。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'memory-session-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'memory-paper.pdf'));

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

const SUMMARY_TEXT = '摘要：读者在弄懂注意力机制与位置编码，要求先给直觉；仍未解决的是多头注意力的计算量。';
const upstreamLog = [];
let turn = 0;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    const last = body.messages?.at(-1);
    const lastText = Array.isArray(last?.content)
      ? (last.content.find((p) => p.type === 'text')?.text || '')
      : String(last?.content || '');
    upstreamLog.push({ kind: /滚动摘要/.test(sys) ? 'summary'
      : /后台学习记忆提取器/.test(sys) ? 'memory'
        : /读懂论文/.test(sys) ? 'teaching' : 'chat', sys, text: lastText });
    // 后台学习记忆提取：返回空数组（JSON，非流式）
    if (/后台学习记忆提取器/.test(sys)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
      return;
    }
    let answer;
    if (/滚动摘要/.test(sys)) answer = SUMMARY_TEXT;
    else { turn += 1; answer = `这是第 ${turn} 轮回答：注意力机制让模型并行处理序列。`; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,28}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await wait(6);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

/** 读 data 下唯一的会话文件（本测试只有一个 doc） */
function readSessionFile() {
  const files = fs.readdirSync(DATA).filter((n) => n.startsWith('session-') && n.endsWith('.json'));
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DATA, files[files.length - 1]), 'utf8')); } catch { return null; }
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
  const postConfig = (patch) => fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  await postConfig({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'memory-mock', apiKey: 'memory-key' });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const ask = async (question, expectHistory) => {
    await page.evaluate((q) => {
      const input = document.querySelector('#chatInput');
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, question);
    await page.click('#sendBtn');
    await page.waitForFunction((n) => !window.__state.busy && window.__state.history.length >= n, { timeout: 30000 }, expectHistory);
    await wait(120);   // 给后台摘要/记忆提取一点起步时间
  };

  await page.goto(`${BASE}/?open=memory-paper.pdf&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));

  /* ══════════ 1. 滚动摘要：5 轮问答后应生成并注入 ══════════ */
  for (let i = 1; i <= 5; i += 1) await ask(`第 ${i} 个问题：注意力机制是什么？`, i * 2);
  let summaryReady = false;
  for (let i = 0; i < 60 && !summaryReady; i += 1) {
    await wait(200);
    const saved = readSessionFile();
    if (saved && typeof saved.summary === 'string' && saved.summary.includes('位置编码')) summaryReady = true;
  }
  const session = readSessionFile() || {};
  check('会话文件里生成滚动摘要', summaryReady && (session.summaryCovered || 0) >= 4,
    `covered=${session.summaryCovered} summary=${String(session.summary || '').slice(0, 24)}`);
  check('摘要请求只发过一次', upstreamLog.filter((x) => x.kind === 'summary').length === 1,
    `${upstreamLog.filter((x) => x.kind === 'summary').length} 次`);
  upstreamLog.length = 0;
  await ask('第 6 个问题：继续讲注意力。', 12);
  const laterSystem = (upstreamLog.find((x) => x.kind === 'chat') || {}).sys || '';
  check('后续问答的 system 带上会话摘要', laterSystem.includes('本次会话早先内容摘要'), laterSystem.slice(-60));
  check('摘要内容确实进了 system', laterSystem.includes('位置编码'), laterSystem.slice(-60));

  /* ══════════ 2. 重载后摘要恢复 ══════════ */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  // 恢复会话是打开流程的后半段：等摘要真的装回来再断言（否则读到的是刚重置的空值）
  await page.waitForFunction(() => (window.__state.summaryCovered || 0) >= 4, { timeout: 20000 }).catch(() => {});
  const restored = await page.evaluate(() => ({ summary: window.__ctx.sessionSummary, covered: window.__state.summaryCovered }));
  check('重开后从会话文件恢复摘要', String(restored.summary || '').includes('位置编码') && restored.covered >= 4,
    `covered=${restored.covered} summary=${String(restored.summary || '').slice(0, 20)}`);

  /* ══════════ 3. 新建会话：带上前一会话摘要（本篇对话记忆） ══════════ */
  await page.evaluate(() => window.__ctx.setPanelVisible('chat', true));
  await page.click('#sessBtn');
  await page.waitForSelector('#sessionMenu:not(.hidden) .sess-new', { timeout: 10000 });
  await page.click('#sessionMenu .sess-new');
  await page.waitForFunction(() => window.__state.history.length === 0, { timeout: 20000 });
  let paperMemory = '';
  for (let i = 0; i < 40 && !paperMemory; i += 1) {
    await wait(150);
    paperMemory = await page.evaluate(() => window.__ctx.paperMemory);
  }
  check('新会话读到前一会话的摘要（本篇对话记忆）', String(paperMemory).includes('位置编码'), String(paperMemory).slice(0, 50));
  upstreamLog.length = 0;
  await ask('这一篇我们之前聊过什么？', 2);
  const paperSystem = (upstreamLog.find((x) => x.kind === 'chat') || {}).sys || '';
  check('新会话问答注入「这篇论文之前的讨论摘要」', paperSystem.includes('这篇论文之前的讨论摘要'), paperSystem.slice(-60));

  /* ══════════ 4. 关闭本篇对话记忆后不再注入 ══════════ */
  const off = await page.evaluate(() => {
    const docId = window.__state.doc.docId;
    window.__ctx.setPaperMemoryOff(docId, true);
    return window.__ctx.loadPaperMemory();
  });
  check('关闭开关后不再读取本篇讨论摘要', !off, String(off).slice(0, 30));
  upstreamLog.length = 0;
  await ask('再问一个无关的问题。', 4);
  const offSystem = (upstreamLog.find((x) => x.kind === 'chat') || {}).sys || '';
  check('关闭后 system 不再有本篇讨论摘要', !offSystem.includes('这篇论文之前的讨论摘要'), offSystem.slice(-40));

  /* ══════════ 5. 用户手写长期记忆：存本机 config 并注入每次问答 ══════════ */
  await postConfig({ longTermMemory: '我在读多模态方向；解释时保留英文术语。' });
  await page.evaluate(() => window.__settings.load());
  upstreamLog.length = 0;
  await ask('长期记忆生效了吗？', 6);
  const memorySystem = (upstreamLog.find((x) => x.kind === 'chat') || {}).sys || '';
  check('长期记忆进 system', memorySystem.includes('长期记忆') && memorySystem.includes('多模态方向'),
    memorySystem.slice(-80));
  const savedConfig = await (await fetch(`${BASE}/api/config`)).json();
  check('长期记忆落盘到 config（本机）', savedConfig.longTermMemory === '我在读多模态方向；解释时保留英文术语。', savedConfig.longTermMemory);

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n记忆：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
