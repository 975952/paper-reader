import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const OUT = path.join(ROOT, 'test', 'artifacts', 'r6-run-20261003');
const DATA = path.join(OUT, 'data');
const PAPERS = path.join(OUT, 'papers');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PAPERS, { recursive: true });
assertIsolatedDataDir(DATA);
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'fixture-a.pdf'));
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'cn-sample.pdf'), path.join(PAPERS, 'fixture-b.pdf'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const pickPort = async () => {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
};

const chatBodies = [];
const upstream = http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep evidence */ }
    chatBodies.push(body);
    const answer = 'R6 假模型回答。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    await wait(15);
    if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

let reader;
let browser;
let page;
try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const aiPort = upstream.address().port;
  const port = await pickPort();
  reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    // 2026-10 安全加固：隔离服务自己 spawn，须显式关掉强制校验并开启诊断路径
    env: { ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS, NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1' },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i += 1) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ }
  }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('server not ready');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'r6-mock', apiKey: 'r6-key' }),
  });
  const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json());
  const first = papers.papers.find((x) => x.name === 'fixture-a.pdf') || papers.papers[0];
  const second = papers.papers.find((x) => x.docId !== first.docId) || first;
  const retryPayload = {
    kind: 'chat', docId: first.docId, docTitle: first.name, inputValue: '请解释这个问题', question: '请解释这个问题',
    quoteText: '[第2页] 原文选区', firstPage: 2, useFullText: true, useWeb: false,
    attachments: [{ kind: 'text', page: 2, text: '原文选区' }],
  };
  const saved = {
    entries: [
      { block: 'chat', kind: 'user', text: '请解释这个问题', quote: '[第2页] 原文选区', page: 2, status: 'user' },
      { block: 'chat', tag: 'answer', page: 2, text: '', status: 'failed', retry: retryPayload },
      { block: 'translate', tag: 'translation', page: 1, quote: 'cached text', text: '旧译文', status: 'stopped', retry: { kind: 'translate', docId: first.docId, text: 'cached text', page: 1 } },
      { block: 'bogus', tag: 'legacy', text: '非法块也应回到问答', status: 'complete' },
    ], history: [], ops: [],
  };
  await fetch(`${BASE}/api/session?doc=${encodeURIComponent(first.docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
    defaultViewport: { width: 1500, height: 950 },
  });
  page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fileList li', { timeout: 20000 });
  await page.evaluate((id) => [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id)?.click(), first.docId);
  await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
  await wait(900);
  const restored = await page.evaluate(() => ({
    errors: [...document.querySelectorAll('#toastWrap .toast.err')].map((x) => x.textContent),
    entries: window.__state.sessionEntries.map((x) => ({ block: x.block, status: x.status, retry: !!x.retry })),
    blocks: Object.keys(window.__state.blockMeta),
    // ⚠️ 别用 document.querySelectorAll('[data-block=…] .msg')：2026-10 删减后右栏恒为单列，
    // 没显示的那块节点被停进脱离文档的 #panelPark，DOM 查询恒为 0，会误读成「没恢复」。
    // 块节点本身活在 state.blockEls 上，用它是可靠的。
    chatCount: window.__state.blockEls?.chat?.querySelectorAll('.msg').length ?? 0,
    translateCount: window.__state.blockEls?.translate?.querySelectorAll('.msg').length ?? 0,
    retryButtons: [...document.querySelectorAll('.msg .acts button')].map((x) => x.textContent),
  }));
  check('恢复历史无页面异常或错误 toast', pageErrors.length === 0 && restored.errors.length === 0, pageErrors.join(' | ') || restored.errors.join(' | '));
  check('隐藏结果块恢复前已创建且非法 block 归入问答', restored.blocks.includes('chat') && restored.blocks.includes('translate') && restored.entries.every((x) => ['chat', 'translate'].includes(x.block)));
  const restoredByBlock = await page.evaluate(() => {
    const msgs = (id) => [...(window.__state.blockEls?.[id]?.querySelectorAll('.msg') || [])];
    return {
      chatMsgs: msgs('chat').length,
      translateMsgs: msgs('translate').length,
      acts: msgs('chat').concat(msgs('translate'))
        .flatMap((m) => [...m.querySelectorAll('.acts button')].map((b) => b.textContent)),
    };
  });
  check('恢复后两块的消息都回来了（问答 / 译文各一条以上）',
    restoredByBlock.chatMsgs >= 1 && restoredByBlock.translateMsgs >= 1,
    `chat=${restoredByBlock.chatMsgs} 条 translate=${restoredByBlock.translateMsgs} 条 · acts=${restoredByBlock.acts.join(' / ')}`);
  // 单列里把问答摆到台面上，才有「重试这次发送」这个入口可点
  await page.evaluate(() => {
    window.__ctx.setPanelVisible('chat', true);
    window.__ctx.applyPanels();
  });
  await wait(250);
  restored.panels = await page.evaluate(() => ({
    chat: !!document.querySelector('#aiArea .ai-block[data-block="chat"]'),
    blocksInPane: [...document.querySelectorAll('#aiArea .ai-block')].map((b) => b.dataset.block),
    acts: [...document.querySelectorAll('#aiArea .ai-block .msg .acts button')].map((x) => x.textContent),
    colCount: document.querySelectorAll('#rightCols > .side.right').length,
  }));
  restored.retryButtons = restored.panels.acts;
  check('单列里问答块占据 #aiArea（同时只有 1 块），问答的重试入口在',
    restored.panels.chat && restored.panels.colCount === 1 && restored.panels.blocksInPane.length === 1
      && restored.panels.acts.includes('重试这次发送'),
    `blocks=[${restored.panels.blocksInPane.join(',')}] 列数=${restored.panels.colCount}`
    + ` · acts=${restored.panels.acts.join(' / ')} · entries=${JSON.stringify(restored.entries)}`);

  const beforeRetry = chatBodies.length;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.msg .acts button')].find((x) => x.textContent.includes('重试这次发送'));
    b?.click();
  });
  await page.waitForFunction((n) => window.__state.busy === false && window.__state.sessionEntries.length === n, { timeout: 20000 }, restored.entries.length);
  const retryBody = chatBodies.slice(beforeRetry).at(-1);
  const retryText = JSON.stringify(retryBody?.messages || []);
  const afterRetry = await page.evaluate(() => ({ n: window.__state.sessionEntries.length, full: window.__state.useFullText, scope: document.querySelector('#sendScope')?.textContent || '' }));
  check('恢复重试复用原 user 行并保留问题/选区/整篇范围', afterRetry.n === restored.entries.length && retryText.includes('请解释这个问题') && retryText.includes('原文选区') && retryText.includes('全文'));

  // D：同一 translation key 的第二次缓存命中只定位原结果，不追加记录。
  await page.evaluate(() => {
    window.__state.cache.set('English::11-placeholder', '缓存结果');
    window.__state.cache.set('English::11-' + window.__ctx.hashStr?.('cached text'), '缓存结果');
  }).catch(() => {});
  // 直接造出稳定 key（hashStr 不是公开 API），第一次调用填缓存，第二次检查数量。
  const beforeTranslate = await page.evaluate(() => ({ n: window.__state.sessionEntries.length, calls: window.__state.sessionEntries.filter((x) => x.quote === '重复选区').length }));
  await page.evaluate(() => window.__ctx.doTranslate({ page: 1, text: '重复选区', cleanText: '重复选区' }));
  await page.waitForFunction(() => window.__state.busy === false, { timeout: 20000 });
  const firstTranslate = await page.evaluate(() => ({ n: window.__state.sessionEntries.length, calls: window.__state.sessionEntries.filter((x) => x.quote === '重复选区').length }));
  await page.evaluate(() => window.__ctx.doTranslate({ page: 1, text: '重复选区', cleanText: '重复选区' }));
  await wait(250);
  const secondTranslate = await page.evaluate(() => ({ n: window.__state.sessionEntries.length, calls: window.__state.sessionEntries.filter((x) => x.quote === '重复选区').length }));
  check('缓存命中不重复追加翻译 entry', firstTranslate.calls === 1 && secondTranslate.calls === 1 && secondTranslate.n === firstTranslate.n, JSON.stringify({ beforeTranslate, firstTranslate, secondTranslate }));
  const translateStage = await page.evaluate(() => ({
    block: document.querySelector('#aiArea .ai-block')?.dataset.block || '',
    regen: [...document.querySelectorAll('#aiArea .ai-block .msg .acts button')].some((b) => b.textContent === '重新生成'),
  }));
  check('译文块此刻在 #aiArea 台面上，且「重新生成」入口在',
    translateStage.block === 'translate' && translateStage.regen, JSON.stringify(translateStage));
  const beforeNoKey = chatBodies.length;
  await page.evaluate(() => {
    window.__settings.data.hasApiKey = false;
    window.__settings.data.baseURL = 'https://api.example.invalid/v1';
    [...document.querySelectorAll('.msg .acts button')].find((x) => x.textContent === '重新生成')?.click();
  });
  await wait(300);
  check('没有 API Key 时重试入口不误发请求', chatBodies.length === beforeNoKey);

  // C：getAllText 返回前切到另一篇，旧全文不能写入新文档，也不能发旧请求。
  await page.evaluate(() => {
    window.__state.docText = null; window.__state.docTextDoc = null; window.__state.docDigest = null;
    window.__state.viewerDocId = window.__state.doc.docId;
    window.__r6ResolveText = null;
    window.__viewer.getAllText = () => new Promise((resolve) => { window.__r6ResolveText = resolve; });
  });
  const oldDoc = await page.evaluate(() => window.__state.doc.docId);
  const pendingCtx = page.evaluate(() => window.__ctx.buildDocContext('旧问题', '旧选区').then(() => 'resolved', (e) => e.name));
  await page.waitForFunction(() => typeof window.__r6ResolveText === 'function');
  await page.evaluate((id) => { window.__state.doc = { ...(window.__state.doc || {}), docId: id, name: '新文档' }; window.__state.viewerDocId = id; window.__r6ResolveText('旧论文全文'); }, second.docId);
  const raceResult = await pendingCtx;
  const raceState = await page.evaluate(() => ({ doc: window.__state.doc.docId, textDoc: window.__state.docTextDoc, text: window.__state.docText }));
  check('跨论文全文读取丢弃旧结果且不覆盖新文档缓存', raceResult === 'AbortError' && raceState.doc === second.docId && raceState.textDoc !== second.docId && !raceState.text);
  check('测试确实覆盖了另一篇论文切换', oldDoc !== second.docId);
} finally {
  await browser?.close().catch(() => {});
  reader?.kill();
  await new Promise((resolve) => upstream.close(resolve));
}

const passed = checks.filter((x) => x.ok).length;
const report = `# R6 isolated results\n\n- Command: node test/r6.mjs\n- Result: ${passed}/${checks.length}\n- Scope: isolated test/artifacts/r6-run-20261003/{data,papers} and local fake AI service\n\n${checks.map((x) => `- ${x.ok ? 'PASS' : 'FAIL'} ${x.name}`).join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'RESULTS.md'), report, 'utf8');
console.log(`\n结果：${passed}/${checks.length} 通过`);
if (passed !== checks.length) process.exitCode = 1;
