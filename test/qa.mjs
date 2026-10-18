/** 连续阅读问答：实际请求、原文定位、检索、恢复和重试。全部使用隔离文件和假模型。
 * node test/qa.mjs；QA_BACKEND=exe 时直接操作根目录 exe 的 WebView2 页面。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { resolveReadingRequest, readingTurn, snapshotHistory, restoreReadingHistory, citedSources } from '../public/js/reading-context.js';
import { webQueryFor, filterWebResults } from '../public/js/ai.js';

const backend = process.env.QA_BACKEND || 'node';
const scratch = fs.mkdtempSync(path.join(SANDBOX, `qa-${backend}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data'));
const papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
const name = 'qa-fixture.pdf';
const AUTHOR = 'Andrew G. Howard';
const SELECTED = 'structured transform networks [28] and deep fried convnets [37].';
const REF28 = 'V. Sindhwani, T. Sainath, and S. Kumar. Structured transforms for small-footprint deep learning. NIPS, 2015.';
const REF37 = 'Z. Yang, M. Moczulski, M. Denil, and N. de Freitas. Deep fried convnets. ICCV, 2015.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));
const freePort = async () => { const s = http.createServer(); await listen(s); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
let count = 0;
const check = (title, condition) => { assert.ok(condition, title); count++; console.log(`[OK] ${title}`); };

function fixturePdf() {
  const objects = [];
  const add = (s) => { objects.push(s); return objects.length; };
  const catalog = add(''); const root = add(''); const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const lines = [
    ['QA Fixture Title', AUTHOR, 'Abstract: This is synthetic text for request routing.',
      ...Array.from({ length: 28 }, (_, i) => `Fixture context line ${i}: ordinary filler text occupies the first part of this page.`), SELECTED,
      'These works reduce computation. This sentence is adjacent to the selected text.'],
    ['SqueezeNet', 'SqueezeNet uses a Fire module with squeeze and expand operations.'],
    ['References', `[28] ${REF28}`, `[37] ${REF37}`],
  ];
  const pages = lines.map((ls) => {
    let content = 'BT\n/F1 9 Tf\n16 TL\n50 745 Td\n';
    for (const line of ls) content += `(${line.replace(/[()\\]/g, '\\$&')}) Tj\nT*\n`;
    content += 'ET\n';
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    return add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${root} 0 R >>`;
  objects[root - 1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((n) => `${n} 0 R`).join(' ')}] >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((s, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${s}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((n) => { pdf += `${String(n).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
fs.writeFileSync(path.join(papers, name), fixturePdf());
fs.copyFileSync(path.join(ROOT, 'test/fixtures/cn-sample.pdf'), path.join(papers, 'other-paper.pdf'));

let history = readingTurn(resolveReadingRequest({ question: '请解释这段内容。', selection: AUTHOR, page: 1 }), '作者解释');
let request = resolveReadingRequest({ question: '他是谁', history });
check('短追问确定人名，查询不含原始代词', request.selection === AUTHOR && webQueryFor('他是谁', '', { history }) === 'Andrew Howard');
for (const q of ['？', '你怎么在理解我的问题', '默认是要解释框选内容提到的知识']) {
  check(`${q} 不形成搜索查询`, webQueryFor(q, '', { history }) === '');
}
const guidance = '默认是要解释框选内容提到的知识';
request = resolveReadingRequest({ question: guidance, history });
history.push(...readingTurn(request, '确认'));
for (let i = 0; i < 45; i++) history = snapshotHistory([...history, ...readingTurn(resolveReadingRequest({ question: '继续', history }), '说明')]);
check('历史截断后仍保留原文和讲解偏好', history.length === 80 && resolveReadingRequest({ question: '为什么', history }).guidance === guidance);
const legacy = restoreReadingHistory([], [{ block: 'chat', tag: 'explanation', quote: AUTHOR, page: 1, text: '作者解释', status: 'complete' }]);
check('老会话的解释能恢复为追问对象', resolveReadingRequest({ question: '他是谁', history: legacy }).selection === AUTHOR);
const unused = { title: '他是谁 电视剧', snippet: '悬疑剧', url: 'https://example.com/tv' };
const useful = { title: 'Andrew Howard research', snippet: AUTHOR, url: 'https://example.com/author' };
check('逐条过滤无关来源', filterWebResults('Andrew Howard', [unused, useful]).length === 1);
check('只保留已引用来源且不改变编号', citedSources('事实[来源2]', [unused, useful])[0]?.number === 2);
const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const start = code.indexOf('function openAlexAbstract('); const end = code.indexOf('\nasync function searchReference', start);
const abstract = vm.runInNewContext(code.slice(start, end) + '; openAlexAbstract');
check('Node 摘要恢复词序及重复词', abstract({ abstract_inverted_index: { fast: [2], a: [0, 3], transform: [1], invalid: [-1, 10000] } }) === 'a transform fast a');

const bodies = [];
let failNext = false;
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
  if (failNext) { failNext = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"controlled failure"}}'); return; }
  const last = String(body.messages.at(-1).content);
  const hasSources = last.includes('[来源2]');
  const answer = `${last.includes(SELECTED) ? '两个方法的解释' : last.includes('SqueezeNet') ? 'SqueezeNet 的解释' : 'Andrew G. Howard 的解释'}${hasSources ? ' [来源2]' : ''}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
});

let reader, browser, page, base;
const searches = [], refLookups = [], pageErrors = [], requestFailures = [], navigationCancellations = [];
let navigating = false;
try {
  await listen(mock);
  const port = await freePort(); const debugPort = await freePort();
  const env = { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` };
  reader = backend === 'exe' ? spawn(path.join(ROOT, '论文阅读器.exe'), [], { env, stdio: 'ignore' })
    : spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const ports = backend === 'exe' ? Array.from({ length: 20 }, (_, i) => i + 8787) : [port];
  for (let i = 0; i < 100 && !base; i++) {
    for (const p of ports) {
      try {
        const origin = `http://127.0.0.1:${p}`;
        const r = await fetch(origin + '/api/papers', { signal: AbortSignal.timeout(200) });
        if (r.ok && path.resolve((await r.json()).dir) === path.resolve(papers)) { base = origin; break; }
      } catch { /* wait for our own isolated service */ }
    }
    if (!base) await wait(100);
  }
  check('新进程使用独立数据目录', !!base && !!reader.pid);
  const config = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${mock.address().port}/v1`, model: 'qa-mock', apiKey: 'qa-fake-key' }) });
  check('隔离模型配置保存成功', config.ok);
  if (backend === 'exe') {
    let ws;
    for (let i = 0; i < 100 && !ws; i++) {
      try { ws = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await wait(100); }
    }
    check('连接根目录 exe 的原生 WebView2', !!ws);
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    page = (await browser.pages()).find((p) => p.url().startsWith(base)) || (await browser.pages())[0];
    check('实际程序页面由本次 exe 提供', !!page && page.url().startsWith(base));
  } else {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } });
    page = await browser.newPage();
  }
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => {
    const detail = `${r.url()} ${r.failure()?.errorText}`;
    // 本套件主动重载页面，WebView2 会取消旧页面的模块加载和后台保存；仍记录这些证据。
    const expected = navigating && r.failure()?.errorText === 'net::ERR_ABORTED'
      && r.url().startsWith(base) && /\/(?:js\/app\.js|api\/(?:session|state))(?:\?|$)/.test(r.url());
    (expected ? navigationCancellations : requestFailures).push(detail);
  });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.origin !== base) return r.continue();
    if (url.pathname === '/api/web-search') {
      const q = url.searchParams.get('q'); searches.push(q);
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [unused, useful,
        { title: 'Andrew Howard publications', snippet: AUTHOR, url: 'https://example.com/author-publications' }] }) });
    }
    if (url.pathname === '/api/ref-search') {
      const q = url.searchParams.get('q'); refLookups.push(q);
      const structured = /Structured transforms/i.test(q);
      const title = structured ? 'Structured transforms for small-footprint deep learning' : 'Deep fried convnets';
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ title, results: [{ title,
        url: structured ? 'https://arxiv.org/abs/1510.01722' : 'https://arxiv.org/abs/1412.7149',
        snippet: structured ? 'STRUCTURED_ABSTRACT_MARKER: learn structured parameter matrices.' : 'FASTFOOD_ABSTRACT_MARKER: replace fully connected layers.', excerptKind: 'abstract' }] }) });
    }
    return r.continue();
  });
  const open = async (filename = name) => {
    navigating = true;
    await page.goto(`${base}/?open=${encodeURIComponent(filename)}`);
    await page.waitForFunction((filename) => window.__viewer?.pdf && window.__state?.doc?.name === filename
      && window.__state.viewerDocId === window.__state.doc.docId && window.__ctx, { timeout: 20000 }, filename);
    navigating = false;
  };
  const settled = async (before) => {
    await page.waitForFunction((n) => !window.__state.busy && window.__state.sessionEntries.length > n
      && ['complete', 'failed'].includes(window.__state.sessionEntries.at(-1)?.status), { timeout: 20000 }, before);
  };
  const explain = async (text, p) => {
    const before = await page.evaluate(() => window.__state.sessionEntries.length);
    await page.evaluate((text, p) => { window.__ctx.doExplain({ text, page: p }); }, text, p);
    await settled(before);
  };
  const send = async (question = '', text = '', p = 1, range = 'web') => {
    const before = await page.evaluate(() => window.__state.sessionEntries.length);
    await page.evaluate((question, text, p, range) => {
      window.__ctx.setScopeRange(range);
      if (text) window.__ctx.addToChat({ text, page: p });
      const input = document.querySelector('#chatInput'); input.value = question;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
    }, question, text, p, range);
    await settled(before);
    return bodies.at(-1);
  };
  const lastText = () => String(bodies.at(-1).messages.at(-1).content);
  await open();
  const context = await page.evaluate((text) => window.__viewer.getContextAround(1, `[第1页] ${text}`), SELECTED);
  check('带页码的选区定位到正文且不退回作者区域', context.includes(SELECTED) && !context.includes(AUTHOR));
  const missing = await page.evaluate(() => window.__viewer.getContextAround(1, 'missing text with no matching anchor'));
  check('匹配不到原文时不伪造周边上下文', missing === '');
  const picked = await page.evaluate(() => window.__ctx.pickRelevantPages('===== p.1 =====' + 'Intro '.repeat(400) + 'TARGET_EVIDENCE depthwise mechanism', 'depthwise', 1));
  check('长页检索返回命中位置而不是截掉页尾证据', picked.includes('TARGET_EVIDENCE'));
  await explain(AUTHOR, 1);
  check('释的对象和答案进入模型历史', await page.evaluate(() => window.__state.history.length === 2 && window.__state.history[0].focus.text === 'Andrew G. Howard'));
  await send('他是谁');
  check('追问请求沿用明确人名并带上一解释', lastText().includes(AUTHOR) && bodies.at(-1).messages.some((m) => m.role === 'assistant' && m.content.includes(AUTHOR)));
  check('联网查人名而不是他是谁', searches.at(-1) === 'Andrew Howard');
  check('无关电视剧没有进入模型材料', !lastText().includes('电视剧') && !lastText().includes('/tv'));
  check('发给模型的历史只使用 role 和 content', bodies.every((b) => b.messages.every((m) => Object.keys(m).every((k) => ['role', 'content'].includes(k)))));
  const links = await page.evaluate(() => { const row = [...document.querySelectorAll('.msg.assistant[data-seq]')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq)).at(-1); return [...row.querySelectorAll('.src-n')].map((n) => n.textContent); });
  check('只展示实际引用的来源并保留原始编号', links.length === 1 && links[0] === '[来源2]');
  await send('', SELECTED);
  check('新选区覆盖人名对象', lastText().includes(SELECTED));
  check('参考文献按完整书目查询', refLookups.some((q) => q.includes('Structured transforms for small-footprint deep learning')) && refLookups.some((q) => q.includes('Deep fried convnets')));
  check('被引方法的原论文摘要送入本轮材料', lastText().includes('STRUCTURED_ABSTRACT_MARKER') && lastText().includes('FASTFOOD_ABSTRACT_MARKER'));
  await send('为什么更快');
  check('普通问答发送后仍可追问原文', lastText().includes(SELECTED) && lastText().includes('本次追问沿用'));
  await explain('SqueezeNet', 2);
  await send('它怎么工作');
  check('重新选词后对象及页码同时切换', lastText().includes('SqueezeNet') && lastText().includes('第 2 页'));
  for (const q of [guidance, '你怎么在理解我的问题', '？']) {
    const n = searches.length + refLookups.length; await send(q);
    check(`${q} 沿原话题处理且不联网`, searches.length + refLookups.length === n && lastText().includes('SqueezeNet'));
  }
  for (let i = 0; i < 4; i++) await send('继续', '', 1, 'current');
  check('超过最近三轮后讲解偏好仍传入模型', bodies.at(-1).messages[0].content.includes(guidance));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await open();
  await send('它怎么工作', '', 1, 'current');
  check('重启页面后恢复原文、页码及讲解偏好', lastText().includes('SqueezeNet') && lastText().includes('第 2 页') && bodies.at(-1).messages[0].content.includes(guidance));
  failNext = true;
  await send('他是谁', AUTHOR, 1, 'current');
  check('失败请求保留原始阅读对象', await page.evaluate(() => window.__state.sessionEntries.at(-1).retry.reading.selection.includes('Andrew G. Howard')));
  await explain('SqueezeNet', 2);
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await open();
  const beforeRetry = bodies.length;
  await page.evaluate(() => { const row = [...document.querySelectorAll('.msg.assistant')].find((r) => r.__sessionRecord?.status === 'failed'); row.querySelector('.acts button').click(); });
  await page.waitForFunction(() => !window.__state.busy && !window.__state.sessionEntries.some((r) => r.status === 'failed'), { timeout: 20000 });
  check('跨重启重试使用原对象及原历史', bodies.length === beforeRetry + 1 && lastText().includes(AUTHOR) && !lastText().includes('SqueezeNet'));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await page.click('#sessBtn');
  await page.waitForSelector('#sessionMenu:not(.hidden) .sess-new');
  await page.click('#sessionMenu .sess-new');
  await page.waitForFunction(() => window.__state.history.length === 0 && !document.querySelector('#sessionMenu:not(.hidden)'));
  await send('他是谁', '', 1, 'current');
  check('新会话不会继承上一会话选区和偏好', !lastText().includes('选中文本') && !bodies.at(-1).messages[0].content.includes(guidance));
  await page.evaluate(() => window.__ctx.saveSessionNow());
  await open('other-paper.pdf');
  await send('他是谁', '', 1, 'current');
  check('换论文不会继承旧论文对象', !lastText().includes(AUTHOR) && !lastText().includes('SqueezeNet'));
  check('操作期间没有页面错误', pageErrors.length === 0);
  if (requestFailures.length) console.log('REQUEST_FAILURES', requestFailures);
  check('操作期间没有意外请求失败', requestFailures.length === 0);
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ backend, pid: reader.pid, base, count,
    requests: bodies, searches, refLookups, pageErrors, requestFailures, navigationCancellations }, null, 2), 'utf8');
  console.log(`QA ${backend}: ${count}/${count} passed; evidence: ${scratch}`);
} finally {
  if (browser) { if (backend === 'exe') browser.disconnect(); else await browser.close(); }
  if (reader) reader.kill();
  mock.closeAllConnections(); await new Promise((r) => mock.close(r));
}
