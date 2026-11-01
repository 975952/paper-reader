/** 后台记忆验收。自建隔离数据与假模型；MEMORY_BACKEND=exe 验收**沙箱副本** exe
 *  （--background 启动：不显示窗口、不抢焦点；用户正在用的实例不受影响）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, SANDBOX, assertIsolatedDataDir } from './_env.mjs';
import { spawnReader, stageExe, stopChild } from './_exe.mjs';

const backend = process.env.MEMORY_BACKEND || 'node';
let stagedExe = null;
fs.mkdirSync(SANDBOX, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SANDBOX, `memory-${backend}-`));
const data = assertIsolatedDataDir(path.join(scratch, 'data')), papers = path.join(scratch, 'papers');
fs.mkdirSync(data); fs.mkdirSync(papers);
for (const name of ['memory-fixture.pdf', 'memory-other.pdf']) fs.copyFileSync(path.join(ROOT, 'test/fixtures/cn-sample.pdf'), path.join(papers, name));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));
const freePort = async () => { const s = http.createServer(); await listen(s); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const until = async (predicate, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(50); }
  throw new Error('timed out waiting for memory test condition');
};
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log(`  [OK] ${name}`); };
const mainBodies = [], memoryBodies = [], errors = [], failures = [];
let failExtraction = false, heldExtraction = null, holdNext = false;
const record = (topic, evidence, signal, extra = {}) => ({ topic, evidence, signal,
  aliases: topic === '矩阵乘法' ? ['matrix multiplication'] : [], kind: 'knowledge', scope: 'global',
  level: signal === 'needs_help' ? '还需要从基础解释' : '用户自述会计算', boundary: '仅记录本次表达，未验证独立实现', ...extra });
const mock = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const sys = String(body.messages[0]?.content || '');
    // 会话滚动摘要：后台请求，不算主回答、不进 mainBodies（否则会打乱 system() 取样）
    if (sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '会话摘要（后台）' } }] })); return;
    }
    if (sys.includes('后台学习记忆提取器')) {
      memoryBodies.push(body);
      if (failExtraction) { failExtraction = false; res.writeHead(503); res.end('controlled memory failure'); return; }
      if (holdNext) { holdNext = false; await new Promise((r) => { heldExtraction = r; }); }
      const input = JSON.parse(body.messages.at(-1).content), q = input.本轮用户原话;
      let output = [];
      if (q === '我会矩阵乘法，但反向传播还不会') output = [record('矩阵乘法', '我会矩阵乘法', 'self_report'), record('反向传播', '反向传播还不会', 'needs_help')];
      if (q === '你记错了，矩阵乘法我还没懂') output = [record('矩阵乘法', '矩阵乘法我还没懂', 'needs_help')];
      if (q === '以后请先给例子再解释公式') output = [record('讲解顺序', q, 'preference', { kind: 'preference', level: '先给例子，再解释公式' })];
      if (q === '这篇论文的投影公式我没懂') output = [record('投影公式', q, 'needs_help', { scope: 'paper' })];
      if (q === '请忘记我会矩阵乘法这条记录') output = [record('矩阵乘法', q, 'self_report', { action: 'forget', id: input.已有相关记忆.find((i) => i.topic === '矩阵乘法')?.id })];
      if (q === '矩阵乘法的梯度该怎么算') output = [record('梯度计算', '我已经掌握所有梯度计算', 'demonstrated')];
      if (q === '我会卷积') output = [record('卷积', q, 'self_report')];
      // 身份自述故意让 mock 返回 []：验证「我叫 Cyan，请记住」走确定性路径也能记住
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] })); return;
    }
    mainBodies.push(body);
    const answer = String(body.messages.at(-1)?.content).includes('【本次任务】')
      ? '矩阵乘法用于组合输入，反向传播用于计算梯度。〔p.1〕\n```prt\n{"profile":[{"topic":"伪造的掌握记录","level":"已经完全掌握"}]}\n```'
      : '先用一个具体例子解释，再说明计算过程。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
let reader, browser, page, base, failProfileWrites = false;
async function stop() {
  if (browser) { if (backend === 'exe') browser.disconnect(); else await browser.close(); browser = null; }
  if (reader) { await stopChild(reader); reader = null; }
}
async function start() {
  base = null;
  const port = await freePort(), debugPort = await freePort();
  const env = { ...process.env, PORT: String(port), PRT_DATA_DIR: data, PRT_PAPERS_DIR: papers,
    PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1', NO_OPEN: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` };
  let ports;
  if (backend === 'exe') {
    stagedExe = stagedExe || stageExe('memory').exe;
    reader = spawnReader(stagedExe, { env });
    ports = Array.from({ length: 100 }, (_, i) => i + 8760);
  } else {
    reader = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore', windowsHide: true });
    ports = [port];
  }
  await until(async () => {
    for (const p of ports) {
      try { const origin = `http://127.0.0.1:${p}`; const r = await fetch(origin + '/api/papers', { signal: AbortSignal.timeout(120) });
        if (r.ok && path.resolve((await r.json()).dir) === path.resolve(papers)) { base = origin; return true; }
      } catch { /* only accept this test's isolated service */ }
    } return false;
  }, 30000);
  if (backend === 'exe') {
    check('验收启动的是沙箱副本（不碰用户正在用的应用）', stagedExe.includes(SANDBOX));
    let ws;
    await until(async () => { try { ws = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; return !!ws; } catch { return false; } });
    browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: { width: 1400, height: 900 } });
    // 后台（隐藏）窗口的首屏导航可能比 CDP 端口就绪晚，等页面 URL 指向本实例
    page = null;
    for (let i = 0; i < 150 && !page; i++) {
      const pages = await browser.pages();
      page = pages.find((p) => p.url().startsWith(base)) || null;
      if (!page) await wait(100);
    }
    if (!page) throw new Error('exe 页面没有加载出来');
  } else {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', headless: true,
      args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } }); page = await browser.newPage();
  }
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`${r.url()} ${r.failure()?.errorText}`); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/profile' && r.method() === 'POST' && failProfileWrites) {
      return r.respond({ status: 500, contentType: 'application/json', body: '{"error":{"message":"controlled profile write failure"}}' });
    } return r.continue();
  });
  check(`${backend} 启动新进程并连接自身页面`, !!reader.pid && !!page);
}
const json = async (route) => (await fetch(base + route)).json();
const post = (route, payload, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
const open = async (name = 'memory-fixture.pdf') => {
  await page.goto(`${base}/?open=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((name) => window.__viewer?.pdf && window.__ctx && window.__state.doc?.name === name
    && window.__state.viewerDocId === window.__state.doc.docId, { timeout: 40000 }, name);
};
const system = () => mainBodies.at(-1).messages[0].content;
const send = async (question, waitForMemory = true) => {
  const before = mainBodies.length;
  await page.evaluate((q) => { window.__ctx.setScopeRange('current'); const input = document.getElementById('chatInput');
    input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); }, question);
  await until(async () => mainBodies.length > before && await page.evaluate(() => !window.__state.busy));
  if (waitForMemory) await page.evaluate(() => window.__ctx.memoryIdle());
};

try {
  await listen(mock); await start();
  const empty = await json('/api/profile');
  check('新用户返回空的兼容存储结构', empty.version === 1 && empty.items.length === 0);
  check('只向隔离实例写入假模型配置', (await post('/api/config', { apiKey: 'memory-fake-key', model: 'memory-mock', baseURL: `http://127.0.0.1:${mock.address().port}/v1` })).ok);
  await open(); await page.click('#opsBtn');
  check('顶栏保留四项教学功能，没有档案编辑入口', await page.evaluate(() => document.querySelectorAll('#opsMenu .ops-item').length === 4
    && !document.querySelector('.ops-profile') && !document.getElementById('profileModal') && !document.getElementById('cfgProfilePersonal')));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__ctx.runTeaching('intro', { force: true }));
  await until(() => page.evaluate(() => !window.__state.busy));
  check('讲过不等于掌握，旧 prt 建议也不能写记忆', (await json('/api/profile')).items.length === 0 && memoryBodies.length === 0);
  holdNext = true; await send('我会矩阵乘法，但反向传播还不会', false); await until(() => !!heldExtraction);
  check('后台未完成时前台已结束且可以继续操作', await page.evaluate(() => !window.__state.busy && !document.getElementById('sendBtn').disabled));
  heldExtraction(); heldExtraction = null; await page.evaluate(() => window.__ctx.memoryIdle());
  let saved = await json('/api/profile');
  check('普通问答自动记下会与不会，保留原话与时间', saved.items.length === 2 && saved.items.every((i) => i.memory?.evidence && /T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(i.updatedAt)));
  const matrixId = saved.items.find((i) => i.topic === '矩阵乘法').id;
  await send('矩阵乘法的梯度该怎么算');
  check('下一次普通问答收到相关理解边界', system().includes('后台学习记忆') && system().includes('矩阵乘法') && system().includes('未独立验证'));
  check('伪造的用户掌握证据不能落盘', !(await json('/api/profile')).items.some((i) => i.topic === '梯度计算'));
  await send('你记错了，矩阵乘法我还没懂'); saved = await json('/api/profile');
  check('自然纠正更新同一条记忆，不重复添加', saved.items.length === 2 && saved.items.find((i) => i.id === matrixId)?.memory.signal === 'needs_help');
  await send('请解释矩阵乘法');
  check('纠正后下一次请求按仍需讲解处理', system().includes('用户表示仍需讲解') && system().includes('矩阵乘法我还没懂'));
  await send('以后请先给例子再解释公式');
  check('持续讲解偏好自动保存', (await json('/api/profile')).items.some((i) => i.memory?.kind === 'preference'));
  const n = memoryBodies.length; await send('继续');
  check('继续不触发提取或掌握升级', memoryBodies.length === n);
  await send('这篇论文的投影公式我没懂'); await page.evaluate(() => window.__ctx.saveSessionNow());
  const firstDoc = await page.evaluate(() => window.__state.doc.docId);
  await open('memory-other.pdf'); await send('投影公式是什么意思');
  check('通用偏好跨论文使用，本文专属困难不串到另一篇', system().includes('先给例子，再解释公式') && !system().includes('这篇论文的投影公式我没懂'));
  const oldPid = reader.pid; await stop(); await start(); await open(); saved = await json('/api/profile');
  check('重启整个程序后仍保留后台记忆', reader.pid !== oldPid && saved.items.length === 4);
  await send('请再解释矩阵乘法');
  check('重启后的请求使用持久化记忆', system().includes('矩阵乘法我还没懂') && system().includes('先给例子，再解释公式'));
  await page.evaluate(() => window.__ctx.doExplain({ text: '投影公式', cleanText: '投影公式', page: 1 })); await until(() => page.evaluate(() => !window.__state.busy));
  check('划词解释也按当前论文使用记忆', system().includes('这篇论文的投影公式我没懂'));
  await send('请忘记我会矩阵乘法这条记录');
  check('忘记指定条目并保留其他记忆', (await json('/api/profile')).items.length === 3 && !(await json('/api/profile')).items.some((i) => i.id === matrixId));
  await send('矩阵乘法是什么意思'); check('删除后新请求不再注入该记录', !system().includes('矩阵乘法我还没懂'));
  failExtraction = true; await send('我会卷积');
  check('提取失败不影响回答，也不保存虚构记忆', !(await json('/api/profile')).items.some((i) => i.topic === '卷积') && await page.evaluate(() => !window.__state.busy));
  failProfileWrites = true; await send('我会卷积');
  check('写盘失败时内存和磁盘都不假装记住', !(await json('/api/profile')).items.some((i) => i.topic === '卷积') && await page.evaluate(() => !window.__ctx.profile.items.some((i) => i.topic === '卷积')));
  failProfileWrites = false; await send('我会卷积'); check('失败后后续提取与保存能够恢复', (await json('/api/profile')).items.some((i) => i.topic === '卷积'));
  const current = await json('/api/profile');
  const concurrent = await Promise.all([1, 2].map(() => post('/api/profile', { ...current, revision: current.revision + 1 }, { 'If-Match': String(current.revision) })));
  check('并发写同一版本时只允许一个成功', concurrent.map((r) => r.status).sort().join(',') === '200,409');
  const beforeInvalid = await json('/api/profile');
  for (const payload of [{ ...beforeInvalid, version: 2 }, { version: 1 }, { ...beforeInvalid, items: [{ ...beforeInvalid.items[0], status: 'mastered' }] }]) {
    check('非法结构被服务端拒绝', (await post('/api/profile', payload)).status === 400);
  }
  check('非法保存没有破坏已有数据', (await json('/api/profile')).revision === beforeInvalid.revision);
  check('没有页面脚本错误或意外请求失败', errors.length === 0 && failures.length === 0);
  check('后台记忆没有切换当前论文', await page.evaluate((id) => window.__state.doc.docId === id, firstDoc));
  /* 身份自述（名字/称呼）也属于后台长期记忆：跨论文、与论文关键词无关也注入，但不冒充掌握证据 */
  await send('我叫Cyan请记住');
  await until(async () => (await json('/api/profile')).items.some((i) => i.memory?.kind === 'identity' && /Cyan/.test(i.level)));
  const identitySaved = (await json('/api/profile')).items.find((i) => i.memory?.kind === 'identity');
  check('身份自述写入后台记忆（kind=identity / confirmed）',
    !!identitySaved && identitySaved.memory.signal === 'self_report' && identitySaved.status === 'confirmed');
  await send('继续');
  check('身份记忆注入下一次请求（与论文关键词无关）', system().includes('Cyan') && system().includes('用户自述身份'));
  await open('memory-other.pdf'); await send('换个话题：卷积是什么');
  check('身份记忆跨论文仍生效', system().includes('Cyan'));
  await page.screenshot({ path: path.join(scratch, 'reader.png') });
  fs.writeFileSync(path.join(scratch, 'evidence.json'), JSON.stringify({ backend, count, pid: reader.pid, mainRequests: mainBodies,
    memoryRequests: memoryBodies, profile: await json('/api/profile'), errors, failures }, null, 2), 'utf8');
  console.log(`MEMORY ${backend}: ${count}/${count} passed; evidence: ${scratch}`);
} finally { heldExtraction?.(); await stop(); mock.closeAllConnections(); await new Promise((r) => mock.close(r)); }
