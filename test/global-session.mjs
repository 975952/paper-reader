/**
 * B 线 P3（修订版：全局问答会话 + 文档级译文 + 全库按需查看）验收。
 *
 *   node test/global-session.mjs
 *
 * 用户 2026-11-01 追加拍板：不做「按文件夹」会话，问答会话改成**全局**（所有已导入论文共用一份）；
 * 译文仍按文档；默认只看当前文件夹，其它文件夹的已导入文件也能按需打开。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'global-session-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
const FIX = path.join(import.meta.dirname, 'fixtures');
for (const name of ['paper-a.pdf', 'paper-b.pdf', 'paper-c.pdf']) fs.copyFileSync(path.join(FIX, 'multipage-sample.pdf'), path.join(PAPERS, name));
fs.mkdirSync(path.join(PAPERS, 'sub'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'cn-sample.pdf'), path.join(PAPERS, 'sub', 'paper-d.pdf'));

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

/* ── 假上游：问答 / 翻译 / 后台任务分开回答 ── */
let answerSeq = 0;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content || '');
    const question = String(body.messages?.at(-1)?.content || '');
    if (Array.isArray(body.tools) && body.tools.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools not supported in this test' } }));
      return;
    }
    if (sys.includes('后台学习记忆提取器')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
      return;
    }
    if (sys.includes('滚动摘要')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '会话摘要（后台）' } }] }));
      return;
    }
    const isTranslate = sys.includes('学术论文翻译专家');
    const answer = isTranslate
      ? `译文：${body.messages?.at(-1)?.content?.match(/【需要翻译的片段】\n([\s\S]{0,30})/)?.[1] || '片段'}`
      : (answerSeq += 1, `回答${answerSeq}：关于「${question.replace(/\s+/g, ' ').slice(0, 24)}」`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of (answer.match(/[\s\S]{1,30}/g) || [])) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
  });
});

let reader = null;
let browser = null;
const sessionFile = (doc, sid = '') => `/api/session?doc=${encodeURIComponent(doc)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;
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
  for (let i = 0; i < 100 && !ready; i += 1) { await wait(100); try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* wait */ } }
  check('隔离服务启动', ready);
  if (!ready) throw new Error('isolated server failed to start');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'global-mock', apiKey: 'global-key' }),
  });
  const papers = (await fetch(`${BASE}/api/papers`).then((r) => r.json())).papers || [];
  const byName = (name) => papers.find((p) => p.name === name || p.name.endsWith(name));
  const A = byName('paper-a.pdf');
  const B = byName('paper-b.pdf');
  const C = byName('paper-c.pdf');
  const D = byName('sub/paper-d.pdf') || byName('paper-d.pdf');
  check('隔离书架有 4 篇文档（含子文件夹）', [A, B, C, D].every(Boolean), papers.map((p) => p.name).join(', '));

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const settle = async () => {
    await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId
      || (!window.__state?.doc && !document.body.classList.contains('reading')), { timeout: 40000 });
    await wait(500);
  };
  const open = async (name) => {
    const doc = byName(name);
    await page.evaluate((d) => window.__ctx.openDoc({ name: d.name, url: d.url, docId: d.docId, path: d.path || d.name }), doc);
    await settle();
  };
  const ask = async (q) => {
    await showPanel('chat');
    await wait(200);
    await page.evaluate((question) => {
      const input = document.querySelector('#chatInput');
      input.value = question;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    await page.click('#sendBtn');
    await page.waitForFunction(() => !window.__state.busy, { timeout: 60000 });
    await wait(600);
  };
  // 右栏一栏只开一个：看问答就切到问答块，看译文就切到译文块
  const showPanel = (id) => page.evaluate((panel) => window.__ctx.setPanelVisible(panel, true), id);
  const chatText = async () => { await showPanel('chat'); await wait(200); return page.evaluate(() => document.querySelector('[data-block="chat"] .ai-body')?.textContent || ''); };
  const translateText = async () => { await showPanel('translate'); await wait(200); return page.evaluate(() => document.querySelector('[data-block="translate"] .ai-body')?.textContent || ''); };
  const fileJson = async (doc, sid = '') => {
    const r = await fetch(`${BASE}${sessionFile(doc, sid)}`);
    return r.ok ? r.json() : null;
  };
  /** 等会话文件落盘（保存是 800ms 防抖），最多 6 秒 */
  const waitSession = async (doc, sid = '', predicate = (j) => Array.isArray(j?.entries) && j.entries.length > 0) => {
    for (let i = 0; i < 30; i += 1) {
      const j = await fileJson(doc, sid);
      if (predicate(j)) return j;
      await wait(200);
    }
    return fileJson(doc, sid);
  };
  /** 打开会话菜单（幂等：已经开着就不要再点，否则会把它关掉） */
  const openSessionMenu = async (selector = '.sess-new') => {
    const isOpen = await page.evaluate(() => !document.getElementById('sessionMenu')?.classList.contains('hidden'));
    if (!isOpen) await page.evaluate(() => document.querySelector('#sessBtn')?.click());
    await page.waitForSelector(`#sessionMenu:not(.hidden) ${selector}`, { timeout: 10000 });
  };

  /* ── 1. 全局问答会话：A 里问的，切到 B 也看得到 ── */
  await page.goto(`${BASE}/?open=${encodeURIComponent(A.name)}&topbar=static`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId, { timeout: 60000 });
  await wait(400);
  await page.evaluate(() => { window.__ctx.setPanelVisible('chat', true); window.__ctx.setAgentRead(false); });
  await ask('这篇论文的核心贡献是什么');
  check('A 里提问有回答', /回答1/.test(await chatText()));
  const g1 = await waitSession('__global__', '', (j) => (j?.entries || []).length >= 2);
  check('问答会话写到全局文件（doc=__global__）', Array.isArray(g1?.entries) && g1.entries.length >= 2, `${g1?.entries?.length} 条`);
  check('消息带来源文档标注（docId）', g1.entries.some((e) => e.docId === A.docId), JSON.stringify(g1.entries.map((e) => e.docId)));
  check('全局文件里没有 translate 条目', !g1.entries.some((e) => e.block === 'translate'));

  await open('paper-b.pdf');
  check('切到 B：全局会话历史仍在（同一份会话）', /回答1/.test(await chatText()));
  await ask('B 里继续问一个问题');
  check('B 里继续提问有回答', /回答2/.test(await chatText()));
  const g2 = await waitSession('__global__', '', (j) => (j?.entries || []).length >= 4);
  const docIds = new Set((g2?.entries || []).map((e) => e.docId));
  check('全局会话同时包含 A/B 的消息', docIds.has(A.docId) && docIds.has(B.docId), JSON.stringify([...docIds]));

  await open('paper-a.pdf');
  const backChat = await chatText();
  check('切回 A：能看到 A+B 两轮全局对话', /回答1/.test(backChat) && /回答2/.test(backChat), backChat.replace(/\s+/g, ' ').slice(0, 80));

  /* ── 2. 译文按文档：A 的译文不会跑到 B ── */
  await open('paper-a.pdf');
  await page.evaluate(() => window.__ctx.doTranslate({ text: 'Attention connects distant positions.', page: 1 }));
  await page.waitForFunction(() => !window.__state.busy, { timeout: 60000 });
  await wait(600);
  const aTranslate = await translateText();
  check('A 的译文块出现译文', /译文：/.test(aTranslate), aTranslate.replace(/\s+/g, ' ').slice(0, 60));
  const trA = await waitSession(A.docId, '__translate');
  check('译文写到文档级伪会话（doc=<docId>&sid=__translate）', Array.isArray(trA?.entries) && trA.entries.length >= 1, `${trA?.entries?.length} 条`);
  const g3 = await fileJson('__global__');
  check('全局问答会话里没有译文条目', !(g3?.entries || []).some((e) => e.block === 'translate'));

  await open('paper-b.pdf');
  check('切到 B：译文块是空的（译文按文档）', !/译文：/.test(await translateText()), (await translateText()).slice(0, 40));
  await open('paper-a.pdf');
  check('切回 A：译文还在', /译文：/.test(await translateText()));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId, { timeout: 60000 });
  await wait(900);
  const reloadChat = (await chatText()).replace(/\s+/g, ' ').slice(0, 160);
  const reloadTrans = (await translateText()).replace(/\s+/g, ' ').slice(0, 80);
  const reloadDom = { chat: reloadChat, trans: reloadTrans, doc: await page.evaluate(() => window.__state.doc?.name) };
  check('刷新后：全局问答历史恢复', /回答1/.test(await chatText()) && /回答2/.test(await chatText()), JSON.stringify(reloadDom));
  check('刷新后：A 的译文恢复', /译文：/.test(await translateText()), JSON.stringify(reloadDom));

  /* ── 3. 旧「按文档」会话懒迁移：复制到全局 + 文档译文，旧文件不删、不重复 ── */
  const legacyChat = [
    { block: 'chat', kind: 'user', text: '旧会话问题 LEGACY', status: 'user' },
    { block: 'chat', kind: 'assistant', tag: 'answer', text: '旧会话回答 LEGACY', status: 'complete' },
    { block: 'translate', kind: 'assistant', text: '旧译文 LEGACY', status: 'complete' },
  ];
  await fetch(`${BASE}${sessionFile(C.docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: legacyChat, history: [], ops: [], updatedAt: Date.now() }),
  });
  const gBefore = (await fileJson('__global__'))?.entries?.length || 0;
  const legacyBack = await fileJson(C.docId);
  check('旧会话测试文件已写好', (legacyBack?.entries || []).some((e) => /LEGACY/.test(e.text || '')), JSON.stringify((legacyBack?.entries || []).map((e) => e.text)));
  await page.evaluate(() => window.__ctx.goWelcome());
  await wait(400);
  await open('paper-c.pdf');
  await waitSession('__global__', '', (j) => (j?.entries || []).some((e) => /旧会话回答 LEGACY/.test(e.text || '')));
  await wait(300);
  const cChat = await chatText();
  const cTrans = await translateText();
  const migDebug = {
    globalHasLegacy: ((await fileJson('__global__'))?.entries || []).some((e) => /LEGACY/.test(e.text || '')),
    migrationFlag: await page.evaluate((docId) => { try { return localStorage.getItem(`reader.migrated.global.v2.${docId}`); } catch { return 'n/a'; } }, C.docId),
    chat: cChat.replace(/\s+/g, ' ').slice(0, 200),
    trans: cTrans.replace(/\s+/g, ' ').slice(0, 120),
  };
  check('旧 chat 条目迁移进全局会话', /旧会话回答 LEGACY/.test(cChat), JSON.stringify(migDebug));
  check('旧 translate 条目迁移进文档译文', /旧译文 LEGACY/.test(cTrans), JSON.stringify(migDebug));
  const legacyAfter = await fileJson(C.docId);
  check('旧会话文件保留（复制迁移不删源）', Array.isArray(legacyAfter?.entries) && legacyAfter.entries.some((e) => /LEGACY/.test(e.text || '')));
  const gAfterMigrate = (await fileJson('__global__'))?.entries?.length || 0;
  check('迁移后全局会话条目增加', gAfterMigrate > gBefore, `${gBefore} → ${gAfterMigrate}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId, { timeout: 60000 });
  await wait(700);
  const gAfterReload = (await fileJson('__global__'))?.entries?.length || 0;
  check('刷新后不重复迁移', gAfterReload === gAfterMigrate, `${gAfterMigrate} → ${gAfterReload}`);

  /* ── 4. 文档可见性：默认当前文件夹 + 「全部已导入文件」按需打开 ── */
  await page.evaluate(() => document.querySelector('#tabMoreBtn')?.click());
  await wait(300);
  const menu = await page.evaluate(() => ({
    visible: !document.getElementById('tabMenu')?.classList.contains('hidden'),
    items: [...document.querySelectorAll('#tabMenu .tab-menu-item')].map((n) => n.textContent),
    titles: [...document.querySelectorAll('#tabMenu .tab-menu-title')].map((n) => n.textContent),
  }));
  check('溢出菜单能打开', menu.visible);
  check('默认分组是「当前文件夹 / 书架」', menu.titles.some((t) => /当前文件夹|书架/.test(t)), JSON.stringify(menu.titles));
  check('另有「全部已导入文件（其他文件夹）」分组', menu.titles.some((t) => /全部已导入文件/.test(t)), JSON.stringify(menu.titles));
  const beforeTabs = await page.evaluate(() => window.__ctx.tabs.length);
  const clicked = await page.evaluate(() => {
    const item = [...document.querySelectorAll('#tabMenu .tab-menu-item')].find((n) => /paper-d/.test(n.textContent));
    if (!item) return { ok: false, items: [...document.querySelectorAll('#tabMenu .tab-menu-item')].map((n) => n.textContent) };
    item.click();
    return { ok: true };
  });
  await settle();
  const afterTabs = await page.evaluate(() => window.__ctx.tabs.length);
  check('点其它文件夹的文档 → 按需打开新标签', clicked.ok && afterTabs === beforeTabs + 1,
    JSON.stringify({ beforeTabs, afterTabs, clicked }));

  /* ── 5. 会话菜单是全局语义 ── */
  await openSessionMenu();
  const head = await page.evaluate(() => document.querySelector('#sessionMenu .sess-head')?.textContent || '');
  check('会话菜单标题是全局语义', /全部论文/.test(head), head);

  /* ── 6. 换会话 / 清空会话都不动文档级译文（防「切会话保存把译文覆盖成空」） ── */
  await open('paper-a.pdf');
  check('6.1 回到 A：文档译文仍在', /译文：/.test(await translateText()));
  await showPanel('chat');
  await wait(300);
  await openSessionMenu('.sess-new');
  await page.click('#sessionMenu .sess-new');
  await wait(900);
  check('6.2 新建会话后译文 DOM 保留（只清问答）', /译文：/.test(await translateText()));
  await ask('新会话里的问题');
  const newCounts = await page.evaluate(() => ({
    user: document.querySelectorAll('[data-block="chat"] .msg.user').length,
    asst: document.querySelectorAll('[data-block="chat"] .msg.assistant').length,
    sid: (() => { try { return JSON.parse(localStorage.getItem('reader.activeSession') || '{}').__global__ || ''; } catch { return ''; } })(),
  }));
  check('6.3 新会话只有这一轮问答（旧全局对话已切走）', newCounts.user === 1 && newCounts.asst === 1, JSON.stringify(newCounts));
  const trAAfterSwitch = await waitSession(A.docId, '__translate', (j) => (j?.entries || []).length >= 1);
  check('6.4 换会话保存后文档译文文件没被覆盖成空', (trAAfterSwitch?.entries || []).length >= 1, `${trAAfterSwitch?.entries?.length} 条`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__state?.viewerDocId === window.__state?.doc?.docId, { timeout: 60000 });
  await wait(800);
  check('6.5 换会话 + 刷新后译文仍在', /译文：/.test(await translateText()));
  await showPanel('chat');
  await wait(300);

  await openSessionMenu('.sess-clear');
  page.once('dialog', (d) => d.accept());
  await page.click('#sessionMenu .sess-clear');
  await wait(1200);
  const clearedChat = (await chatText()).replace(/\s+/g, ' ');
  check('6.6 清空会话只清问答（译文 DOM 保留）', /译文：/.test(await translateText()) && !/新会话里的问题/.test(clearedChat), clearedChat.slice(0, 100));
  const activeSid = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('reader.activeSession') || '{}').__global__ || ''; } catch { return ''; } });
  const clearedFile = await fileJson('__global__', activeSid);
  check('6.7 清空后当前会话文件条目为空', Array.isArray(clearedFile?.entries) && clearedFile.entries.length === 0, JSON.stringify(clearedFile?.entries?.length));
  const trAfterClear = await waitSession(A.docId, '__translate', (j) => (j?.entries || []).length >= 1);
  check('6.8 清空会话后文档译文文件仍在', (trAfterClear?.entries || []).length >= 1, `${trAfterClear?.entries?.length} 条`);

  /* ── 7. 热切换不能挂回旧的全局会话（迁移/换会话后必须显示最新全局会话，且不能把旧内容写回文件） ── */
  // 第 6 节最后停在「新建并清空过」的会话上：用会话菜单切回默认全局会话（不要直接改 localStorage 再刷新，
  // 那样 beforeunload 会拿空会话按默认 sid 存盘，把默认全局会话冲掉）
  await showPanel('chat');
  await wait(300);
  await openSessionMenu('.sess-row');
  const sessionTitles = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#sessionMenu .sess-row')];
    const target = rows.find((r) => /核心贡献|回答1|B 里继续/.test(r.textContent || ''));
    target?.querySelector('.sess-go')?.click();
    return rows.map((r) => r.textContent || '');
  });
  await wait(1400);
  check('7.1 切回默认全局会话：能看到 A/B 的旧对话', /回答1/.test(await chatText()) || /回答2/.test(await chatText()), JSON.stringify(sessionTitles));
  const legacyD = [
    { block: 'chat', kind: 'user', text: 'D 旧会话问题 LEGACY7', status: 'user' },
    { block: 'chat', kind: 'assistant', tag: 'answer', text: 'D 旧会话回答 LEGACY7', status: 'complete' },
  ];
  // D 在第 4 节已经打开过一次（迁移标记已写），这里清掉标记再放旧文件，模拟「老用户升级后首次打开某篇」
  await page.evaluate((docId) => { try { localStorage.removeItem(`reader.migrated.global.v2.${docId}`); } catch { /* ignore */ } }, D.docId);
  await fetch(`${BASE}${sessionFile(D.docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: legacyD, history: [], ops: [], updatedAt: Date.now() }),
  });
  await open('paper-d.pdf');
  await waitSession('__global__', '', (j) => (j?.entries || []).some((e) => /LEGACY7/.test(e.text || '')));
  const dChat = (await chatText()).replace(/\s+/g, ' ');
  check('7.2 D 的旧会话迁移进全局会话并显示', /LEGACY7/.test(dChat), dChat.slice(0, 120));
  await open('paper-a.pdf');
  await wait(400);
  const backAChat = (await chatText()).replace(/\s+/g, ' ');
  check('7.3 切回 A（热切换）仍显示全局会话（含 D 迁移进来的消息，不挂回旧 DOM）', /LEGACY7/.test(backAChat), backAChat.slice(0, 160));
  await open('paper-d.pdf');
  await wait(900);
  const gAfterToggle = await waitSession('__global__', '', (j) => (j?.entries || []).some((e) => /LEGACY7/.test(e.text || '')));
  check('7.4 再切回 D：全局会话文件仍含迁移进来的消息（没被旧会话覆盖）', (gAfterToggle?.entries || []).some((e) => /LEGACY7/.test(e.text || '')), `${(gAfterToggle?.entries || []).length} 条`);

  // 7.5 换会话后，停放的旧视图也不能再被挂回（否则切别的标签还是旧会话）
  await open('paper-b.pdf');
  await wait(300);
  await open('paper-a.pdf');
  await wait(300);
  await showPanel('chat');
  await wait(300);
  await openSessionMenu('.sess-new');
  await page.click('#sessionMenu .sess-new');
  await wait(900);
  await open('paper-b.pdf');
  await wait(400);
  const bAfterNewSession = (await chatText()).replace(/\s+/g, ' ');
  check('7.5 换会话后热切到别的标签：显示新会话（空），不是旧会话',
    !/回答1/.test(bAfterNewSession) && !/LEGACY7/.test(bAfterNewSession), bAfterNewSession.slice(0, 120));

  check('操作期间没有页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n全局会话 P3：${checks.length - failed.length}/${checks.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { reader?.kill(); } catch { /* ignore */ }
  try { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); } catch { /* ignore */ }
}
