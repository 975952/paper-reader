/**
 * A 线 P2.5：Agent 读取内容的端到端验收（真浏览器 + 假上游，无真实 API）。
 *
 *   node test/agent-read.mjs
 *
 * 覆盖（设计 §2.6 门槛 + 交接 §4.2 第 4 步）：
 *  1. 默认关：不发 tools，行为与 P1.5 预装路径一致；
 *  2. 打开后：模型自己选工具（get_reading_state / search_paper / read_page），
 *     最终回答只带它读过的页做白名单 —— 读过页的引用渲染成可点原文，没读过页的引用被拦截；
 *  3. 不支持 tools（上游 400）→ 静默回退预装路径，回答照常出现在界面；
 *  4. 每轮最多 3 个 / 最多 3 轮（模型一直要工具也不会无限循环）；
 *  5. 超时 → 静默回退（不回退就不能上线）；
 *  6. /api/chat 的 tools 形状校验：非法 400、合法透传给上游。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'agent-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'agent-paper.pdf'));

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

/* ── 假上游：根据请求里有没有 tools 分派 ── */
let mode = 'normal';           // normal | unsupported | alwaysTools | slow
let finalStreamAnswer = '默认回答。';
const upstreamLog = [];
const toolRound = (body) => body.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)).length;
const toolCallsSeen = (body) => body.messages.filter((m) => m.role === 'tool').length;

function sse(res, answer) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const piece of (answer.match(/[\s\S]{1,40}/g) || [])) {
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
}
function toolCallJson(rows) {
  return JSON.stringify({ choices: [{ message: { content: '', tool_calls: rows.map((r, i) => ({ id: `call_${i + 1}`, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.args || {}) } })) } }] });
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const sys = String(body.messages?.[0]?.content || '');
    upstreamLog.push({ hasTools, body, sys });
    if (sys.includes('后台学习记忆提取器') || sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
      return;
    }
    if (!hasTools) { sse(res, finalStreamAnswer); return; }
    if (mode === 'unsupported') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools is not supported by this model' } }));
      return;
    }
    if (mode === 'slow') await wait(2500);
    const round = toolRound(body);
    if (mode === 'alwaysTools') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(toolCallJson([{ name: 'read_page', args: { page: 2 } }, { name: 'read_page', args: { page: 3 } }]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (round === 0) {
      res.end(toolCallJson([
        { name: 'get_reading_state', args: {} },
        { name: 'search_paper', args: { query: 'Synthetic Paper' } },
      ]));
    } else if (round === 1) {
      res.end(toolCallJson([
        { name: 'read_page', args: { page: 3 } },
        { name: 'read_page', args: { page: 5 } },
      ]));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: '材料已读够。' } }] }));
    }
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
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'agent-mock', apiKey: 'agent-key' }),
  });

  /* ── 后端 tools 形状校验 ── */
  const postChat = (payload) => fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const badTools = await postChat({ messages: [{ role: 'user', content: 'x' }], tools: 'nope' });
  check('/api/chat 非法 tools 返回 400', badTools.status === 400, String(badTools.status));
  const badChoice = await postChat({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'not_declared' } },
  });
  check('/api/chat tool_choice 指向未声明工具返回 400', badChoice.status === 400, String(badChoice.status));
  const okTools = await postChat({
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_page', description: '读页', parameters: { type: 'object', properties: { page: { type: 'integer' } } } } }],
    tool_choice: 'auto',
    stream: false,
  });
  check('/api/chat 合法 tools 透传（上游收到 tools）', okTools.status === 200 && upstreamLog.at(-1)?.hasTools === true, String(okTools.status));

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?open=${encodeURIComponent('agent-paper.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.doc && window.__viewer?.numPages > 0, { timeout: 40000 });
  await wait(600);
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); window.__ctx.setScopeRange('current'); });
  await wait(400);

  const ask = async () => {
    await page.evaluate(() => {
      const input = document.querySelector('#chatInput');
      input.value = '这篇论文的核心方法是什么？';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#sendBtn');
    await page.waitForFunction(() => !window.__state.busy, { timeout: 60000 });
    await wait(400);
  };

  /* ── 1. 显式关掉（reader.agentRead=0）：不发 tools，行为回到 P1.5 ── */
  await page.evaluate(() => window.__ctx.setAgentRead(false));
  upstreamLog.length = 0;
  finalStreamAnswer = '默认路径回答：这篇论文讲的是注意力的合成测试。';
  await ask();
  const offLog = upstreamLog.filter((row) => !/后台学习记忆提取器|滚动摘要/.test(row.sys));
  check('关掉后请求里没有 tools', offLog.length > 0 && offLog.every((row) => row.hasTools === false), `${offLog.length} 次请求`);
  check('关掉后回答照常渲染', await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('默认路径回答'))));
  const defaultFlag = await page.evaluate(() => ({ on: window.__ctx.agentRead, dflt: window.__ctx.agentReadDefault }));
  check('P2.5 验收通过后 Agent 默认开启（可手动关掉）', defaultFlag.dflt === true && defaultFlag.on === false, JSON.stringify(defaultFlag));
  const enabled = await page.evaluate(() => window.__ctx.setAgentRead(true));
  check('setAgentRead(true) 能打开', enabled === true);

  /* ── 2. 正常 Agent 路径：自己选工具 + 白名单=读过的页 ── */
  const snippet3 = await page.evaluate(async () => (await window.__viewer.getPageText(3)).replace(/\s+/g, ' ').trim().slice(0, 60));
  const snippet8 = await page.evaluate(async () => (await window.__viewer.getPageText(8)).replace(/\s+/g, ' ').trim().slice(0, 60));
  mode = 'normal';
  upstreamLog.length = 0;
  finalStreamAnswer = `核心方法是自注意力。〔p.3‖${snippet3}〕\n\n另见〔p.8‖${snippet8}〕。`;
  // 让最终回答能引用 p.3（读过）与 p.8（没读）观察拦截
  await ask();
  const agentLog = upstreamLog.filter((row) => !/后台学习记忆提取器|滚动摘要/.test(row.sys));
  const toolRequests = agentLog.filter((row) => row.hasTools);
  const finalRequest = agentLog.filter((row) => !row.hasTools).at(-1);
  check('Agent 路径确实发了工具请求（≥2 轮）', toolRequests.length >= 2, `${toolRequests.length} 轮`);
  check('第一轮请求带 6 个只读工具', (toolRequests[0]?.body?.tools || []).length === 6, String((toolRequests[0]?.body?.tools || []).length));
  check('工具结果以 role=tool 回传给模型', (finalRequest?.body?.messages || []).filter((m) => m.role === 'tool').length >= 3,
    String((finalRequest?.body?.messages || []).filter((m) => m.role === 'tool').length));
  check('system 里有「工具模式」说明', /【工具模式】/.test(String(finalRequest?.body?.messages?.[0]?.content || '')));
  check('读过页的引用渲染成可点原文',
    await page.evaluate(() => [...document.querySelectorAll('#aiArea .page-ref.quote-ref')].some((b) => b.dataset.page === '3' && (b.dataset.fragment || '').length > 10)));
  check('没读过的页（p.8）引用被拦截，不渲染按钮',
    await page.evaluate(() => ![...document.querySelectorAll('#aiArea .page-ref')].some((b) => b.dataset.page === '8')));
  const agentDom = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1);
    return {
      basis: row?.querySelector('.entry-basis')?.textContent || '',
      stats: window.__ctx.citationStats,
      lastAgent: window.__ctx.lastAgent,
      texts: row?.querySelector('.text')?.textContent || '',
    };
  });
  check('依据回执写明「AI 自行读取」', /^本次依据：AI 自行读取/.test(agentDom.basis), agentDom.basis);
  check('lastAgent 记录了轮次/工具/读过的页',
    agentDom.lastAgent?.stats?.rounds >= 2 && agentDom.lastAgent.stats.calls >= 3 && agentDom.lastAgent.stats.pages.includes(3),
    JSON.stringify(agentDom.lastAgent?.stats));
  check('citationStats 记录了被拦截的页', (agentDom.stats?.dropped || 0) >= 1, JSON.stringify(agentDom.stats));
  check('最终回答正文渲染了读过的原文', /核心方法是自注意力/.test(agentDom.texts));
  const progressDom = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1);
    const items = [...(row?.querySelectorAll('.agent-steps .as-item') || [])];
    return {
      items: items.length,
      done: items.filter((n) => n.classList.contains('done')).length,
      running: items.filter((n) => n.classList.contains('running')).length,
      texts: items.map((n) => n.textContent || ''),
      cursorCount: document.querySelectorAll('#aiArea .cursor').length,
      allCursorCount: document.querySelectorAll('.cursor').length,
    };
  });
  check('回答上方逐条列出 Agent 过程（≥5 条）', progressDom.items >= 5, JSON.stringify(progressDom.texts.slice(0, 8)));
  check('过程条目收尾后全部是完成态（无残留运行态）', progressDom.done >= 4 && progressDom.running === 0, JSON.stringify(progressDom));
  check('过程里能看出检索 / 读页 / 命中',
    progressDom.texts.some((t) => /检索/.test(t)) && progressDom.texts.some((t) => /读取第 3 页/.test(t)) && progressDom.texts.some((t) => /命中 p/.test(t)),
    JSON.stringify(progressDom.texts));
  check('流式输出没有闪烁光标（.cursor 已删除）', progressDom.cursorCount === 0 && progressDom.allCursorCount === 0, JSON.stringify({ a: progressDom.cursorCount, b: progressDom.allCursorCount }));

  /* ── 3. 不支持 tools → 静默回退预装路径 ── */
  mode = 'unsupported';
  upstreamLog.length = 0;
  finalStreamAnswer = '回退后的回答：只用预装材料也能答。';
  await ask();
  const fallbackLog = upstreamLog.filter((row) => !/后台学习记忆提取器|滚动摘要/.test(row.sys));
  check('不支持 tools 时回退请求不带 tools', fallbackLog.filter((row) => row.hasTools).length === 1 && fallbackLog.at(-1)?.hasTools === false,
    JSON.stringify(fallbackLog.map((r) => r.hasTools)));
  check('回退后回答照常渲染', await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('回退后的回答'))));
  check('静默回退时过程列表被撤掉', await page.evaluate(() => {
    const row = [...document.querySelectorAll('#aiArea .msg.assistant')].at(-1);
    return !row?.querySelector('.agent-steps');
  }));
  check('回退后没有 Agent 依据回执（走的是 P1.5 路径）',
    await page.evaluate(() => !/AI 自行读取/.test([...document.querySelectorAll('#aiArea .msg.assistant .entry-basis')].at(-1)?.textContent || '')));

  /* ── 4. 模型一直要工具：最多 3 轮 × 3 个 ── */
  mode = 'alwaysTools';
  upstreamLog.length = 0;
  finalStreamAnswer = '轮次上限后的回答。';
  await ask();
  const capLog = upstreamLog.filter((row) => !/后台学习记忆提取器|滚动摘要/.test(row.sys));
  const capTools = capLog.filter((row) => row.hasTools);
  const capFinal = capLog.filter((row) => !row.hasTools).at(-1);
  const toolMsgs = ((capFinal?.body?.messages) || []).filter((m) => m.role === 'tool');
  check('模型一直要工具时最多 3 轮', capTools.length === 3, `${capTools.length} 轮`);
  check('每轮最多 3 个工具（总调用 ≤9）', toolMsgs.length <= 9, `${toolMsgs.length} 次`);
  check('轮次用尽后仍给出最终回答', await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('轮次上限后的回答'))));

  /* ── 5. 超时 → 静默回退 ── */
  mode = 'slow';
  upstreamLog.length = 0;
  finalStreamAnswer = '超时回退后的回答。';
  await page.evaluate(() => { window.__agentTestLimits = { callTimeoutMs: 900, totalTimeoutMs: 1600 }; });
  await ask();
  await page.evaluate(() => { window.__agentTestLimits = null; });
  const timeoutLog = upstreamLog.filter((row) => !/后台学习记忆提取器|滚动摘要/.test(row.sys));
  check('超时后回退到预装路径（最后一次请求不带 tools）', timeoutLog.at(-1)?.hasTools === false, JSON.stringify(timeoutLog.map((r) => r.hasTools)));
  check('超时回退后回答照常渲染', await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .text')].some((n) => n.textContent.includes('超时回退后的回答'))));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nAgent 读取：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
