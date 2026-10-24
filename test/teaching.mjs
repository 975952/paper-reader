/**
 * 「读懂论文」验收：顶栏菜单 4 项教学能力 + 学习档案 + prt 隐藏块 + 页码跳转 +
 * 教学进度续讲 + 图表对象选择 + 深入阅读按钮。
 *
 *   BASE=http://127.0.0.1:8787 node test/teaching.mjs
 *
 * 服务用桩（`/api/chat` 由本套件拦截返回），不读真实 Key、不花钱。
 * 学习档案走真实的 `/api/profile` 接口（隔离数据目录），断言它的时间戳与状态流转。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const postJson = (url, obj, method = 'POST') => fetch(`${BASE}${url}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: obj === undefined ? undefined : JSON.stringify(obj),
});

/* 先清空档案 */
await postJson('/api/profile', { version: 1, revision: 0, updatedAt: '', selfReport: '', selfReportAt: '', items: [] });
/* 假模型配置：避免 ensureReady() 弹设置（请求会被下面的拦截替换成桩） */
await postJson('/api/config', { apiKey: 'sk-dev-smoke', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
await postJson('/api/state', { lastDoc: null, lastName: null, lastUrl: null, docs: {} });
{
  const papers = await (await fetch(`${BASE}/api/papers`)).json();
  check('服务端有可用的 PDF', !!(papers.papers || []).length, `${(papers.papers || []).length} 篇`);
  assertIsolatedDataDir(resolveDataDir(papers.dir));
  // 删掉这篇论文的所有会话（含多会话 sid），避免恢复出上一次跑留下的结果
  for (const p of papers.papers || []) {
    const list = await (await fetch(`${BASE}/api/sessions?doc=${encodeURIComponent(p.docId)}`)).json().catch(() => ({}));
    for (const s of list.sessions || []) {
      const sid = s.sid || '';
      await fetch(`${BASE}/api/session?doc=${encodeURIComponent(p.docId)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`, { method: 'DELETE' }).catch(() => {});
    }
    await fetch(`${BASE}/api/session?doc=${encodeURIComponent(p.docId)}`, { method: 'DELETE' }).catch(() => {});
  }
}
const empty = await (await fetch(`${BASE}/api/profile`)).json();
check('默认档案为空', Array.isArray(empty.items) && empty.items.length === 0);

const bodies = [];
const ANSWER_INTRO = [
  '**它要解决什么问题**',
  '',
  '这篇论文提出 Transformer 〔p.3〕。',
  '',
  '**一个具体例子**',
  '',
  '（教学例子）序列转换。',
  '',
  '```prt',
  '{"chips":[{"label":"看实验够不够","op":"evidence"}],"profile":[{"topic":"注意力机制","level":"能说清原理","boundary":"知道 Q/K/V 三者的作用","basis":"inferred"}]}',
  '```',
].join('\n');
const ANSWER_PREREQ = [
  '按「不补就读不下去」挑。',
  '',
  '**注意力机制（Attention）**',
  '- 是什么：让模型看其他位置。',
  '',
  '**Softmax**',
  '- 是什么：把分数变成权重。',
].join('\n');
const ANSWER_ONE = ['**它是什么**', '', 'softmax 把分数变成权重。', '', '**回到论文**', '', '现在能看懂公式 (1) 〔p.4〕。'].join('\n');
const ANSWER_WALK = ['**阅读路线**', '1. 注意力与 Q/K/V — 3.2 — 〔p.3〕', '', '**第一步**', '', '先弄懂注意力在算什么。'].join('\n');
const ANSWER_STEP2 = ['**第 2 步：多头注意力**', '', '一个头不够用。〔p.4〕'].join('\n');
const ANSWER_VISUAL = ['**公式 (1) 在算什么**', '', '它是 value 的加权和。〔p.4〕'].join('\n');
const ANSWER_CONDENSED = ['**它要解决什么问题**', '', '论文提出 Transformer，不用循环和卷积。〔p.1〕'].join('\n');

let mode = 'intro';
const sseFor = (text) => text.match(/[\s\S]{1,18}/g).map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.endsWith('/api/chat')) {
    const body = JSON.parse(req.postData() || '{}');
    bodies.push(body);
    const answer = mode === 'intro' ? ANSWER_INTRO
      : mode === 'prereq' ? ANSWER_PREREQ
        : mode === 'one' ? ANSWER_ONE
          : mode === 'walk' ? ANSWER_WALK
            : mode === 'step2' ? ANSWER_STEP2
              : mode === 'visual' ? ANSWER_VISUAL
                : mode === 'condense' ? ANSWER_CONDENSED : ANSWER_INTRO;
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sseFor(answer) });
  }
  return req.continue();
});

await page.goto(`${BASE}/?open=${encodeURIComponent('attention-arxiv.pdf')}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx, { timeout: 40000 });
await sleep(1200);

/* 1. 菜单 */
await page.click('#opsBtn');
await sleep(300);
const menu = await page.evaluate(() => {
  const m = document.getElementById('opsMenu');
  return {
    items: [...m.querySelectorAll('.ops-item')].map((x) => x.querySelector('.ops-title').textContent),
    profile: m.querySelector('.ops-profile')?.textContent || '',
    head: m.querySelector('.ops-head-title')?.textContent || '',
  };
});
check('菜单标题是「读懂论文」', menu.head.includes('读懂论文'), menu.head);
check('菜单正好 4 项教学能力', menu.items.length === 4 && menu.items.join('|').includes('先给我讲明白') && menu.items.join('|').includes('讲懂图表与公式'), menu.items.join(' / '));
check('菜单头部有学习档案入口', /学习档案/.test(menu.profile), menu.profile.slice(0, 40));

/* 2. 先给我讲明白 */
let before = bodies.length;
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /先给我讲明白/.test(b.textContent)).click(); });
await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((e) => e.tag === '先给我讲明白' && e.status === 'complete'), { timeout: 20000 });
await sleep(400);
check('点「先给我讲明白」发出一次请求', bodies.length === before + 1, `${bodies.length - before}`);
const req0 = bodies.at(-1);
check('system 里有当前时间', /【当前时间】\d{4}-\d{2}-\d{2}/.test(req0.messages[0].content));
check('system 里有学习档案规则', /学习档案/.test(req0.messages[0].content));
check('user 里带论文全文与本次任务', /【论文全文】/.test(req0.messages.at(-1).content) && /【本次任务】/.test(req0.messages.at(-1).content));
const introUi = await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')];
  const last = msgs.at(-1);
  return {
    text: last.querySelector('.text').textContent,
    pageRefs: last.querySelectorAll('.text .page-ref').length,
    acts: [...last.querySelectorAll('.acts button')].map((b) => b.textContent),
    hiddenPrt: /```prt|"profile"/.test(last.querySelector('.text').textContent),
  };
});
check('prt 块不会显示给用户', !introUi.hiddenPrt);
check('〔p.3〕渲染成可点页码', introUi.pageRefs >= 1, `${introUi.pageRefs} 个`);
check('回答后有教学按钮', introUi.acts.includes('再压短') && introUi.acts.includes('看实验够不够'), introUi.acts.join(' / '));

/* 3. 页码点击跳页 */
await page.evaluate(() => { window.__viewer.goToPage(1); });
await sleep(300);
await page.evaluate(() => document.querySelector('#aiArea .msg.assistant .text .page-ref').click());
await sleep(700);
const cur = await page.evaluate(() => window.__viewer.current);
check('点页码会跳到对应页', cur === 3, `当前第 ${cur} 页`);

/* 4. AI 观察写成待确认（带时间戳） */
await sleep(600);
const profileAfter = await (await fetch(`${BASE}/api/profile`)).json();
const pending = (profileAfter.items || []).find((i) => i.status === 'pending' && i.topic === '注意力机制');
check('AI 观察写入待确认条目', !!pending, pending ? pending.topic : '(没有)');
check('待确认条目带写入时间（ISO 带时区）', !!pending && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(pending.createdAt), pending?.createdAt || '');
check('待确认条目没有 lastConfirmedAt', !!pending && pending.lastConfirmedAt === null);

/* 5. 缓存：再点一次不再花钱 */
await page.click('#opsBtn');
await sleep(250);
before = bodies.length;
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /先给我讲明白/.test(b.textContent)).click(); });
await sleep(800);
check('再点同一能力命中缓存，不再请求', bodies.length === before, `${bodies.length - before} 次`);

/* 6. 我需要先懂什么 → 点开一项 → 这个我懂了 */
mode = 'prereq';
await page.click('#opsBtn');
await sleep(250);
before = bodies.length;
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /我需要先懂什么/.test(b.textContent)).click(); });
await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((e) => e.tag === '我需要先懂什么' && e.status === 'complete'), { timeout: 20000 });
await sleep(300);
const prereqActs = await page.evaluate(() => [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].map((b) => b.textContent));
check('清单后有「讲第 1 项」按钮', prereqActs.some((t) => /讲第 1 项/.test(t)), prereqActs.join(' / '));
mode = 'one';
before = bodies.length;
await page.evaluate(() => { [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].find((b) => /讲第 1 项/.test(b.textContent)).click(); });
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => /先懂一点/.test(e.tag || '')), { timeout: 20000 });
await sleep(400);
check('点开一项会单独发请求', bodies.length === before + 1);
check('单讲请求带「用户点开的前置知识」', /【用户点开的前置知识】/.test(bodies.at(-1).messages.at(-1).content));
const oneActs = await page.evaluate(() => [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].map((b) => b.textContent));
check('单项讲解后有「这个我懂了 / 这里没懂」', oneActs.includes('这个我懂了') && oneActs.includes('这里没懂'), oneActs.join(' / '));
await page.evaluate(() => { [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].find((b) => b.textContent === '这个我懂了').click(); });
await sleep(900);
const profileConfirmed = await (await fetch(`${BASE}/api/profile`)).json();
const confirmed = (profileConfirmed.items || []).find((i) => i.status === 'confirmed' && /注意力/.test(i.topic));
check('点「这个我懂了」写入确认（带 lastConfirmedAt）', !!confirmed && confirmed.status === 'confirmed' && !!confirmed.lastConfirmedAt, confirmed ? confirmed.status : '(没有)');

/* 7. 带我一步步读：继续下一步 */
mode = 'walk';
await page.click('#opsBtn');
await sleep(250);
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /带我一步步读/.test(b.textContent)).click(); });
await page.waitForFunction(() => !window.__state.busy && window.__state.sessionEntries.some((e) => e.tag === '带我一步步读' && e.status === 'complete'), { timeout: 20000 });
await sleep(300);
const walkActs = await page.evaluate(() => [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].map((b) => b.textContent));
check('首轮后有「继续下一步」', walkActs.includes('继续下一步'), walkActs.join(' / '));
mode = 'step2';
before = bodies.length;
await page.evaluate(() => { [...[...document.querySelectorAll('#aiArea .msg.assistant')].at(-1).querySelectorAll('.acts button')].find((b) => b.textContent === '继续下一步').click(); });
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => e.tag === '第 2 步'), { timeout: 20000 });
await sleep(400);
check('继续下一步发出请求并把历史带上', bodies.length === before + 1 && bodies.at(-1).messages.some((m) => m.role === 'assistant' && /阅读路线/.test(String(m.content))));
const walkState = await page.evaluate(() => window.__ctx.teaching.walk);
check('教学进度 step=2 并存档', walkState && walkState.step === 2, `step=${walkState?.step}`);

/* 8. 讲懂图表与公式：跳到第 4 页，选择器 */
mode = 'visual';
await page.evaluate(() => window.__viewer.goToPage(4));
await sleep(800);
await page.click('#opsBtn');
await sleep(250);
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /讲懂图表与公式/.test(b.textContent)).click(); });
await page.waitForFunction(() => document.querySelectorAll('#opsMenu .ops-obj').length > 0 || document.querySelector('#opsMenu .ops-empty'), { timeout: 30000 });
const objects = await page.evaluate(() => [...document.querySelectorAll('#opsMenu .ops-obj .ops-title')].map((x) => x.textContent));
check('第 4 页选择器列出图/公式', objects.some((t) => /图 2/.test(t)) && objects.some((t) => /公式 \(1\)/.test(t)), objects.join(' / '));
before = bodies.length;
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-obj')].find((b) => /公式 \(1\)/.test(b.textContent)).click(); });
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => /讲懂：公式/.test(e.tag || '')), { timeout: 20000 });
await sleep(300);
check('讲公式请求带当前页与对象', /【当前页】p\.4/.test(bodies.at(-1).messages.at(-1).content) && /公式 \(1\)/.test(bodies.at(-1).messages.at(-1).content));

/* 9. 学习档案弹窗：先补一条 pending（模拟 AI 观察），再从弹窗确认 */
const nowIso = new Date().toISOString();
const prof = await (await fetch(`${BASE}/api/profile`)).json();
prof.items.push({
  id: 'kp-smoke-pending', topic: '残差连接', aliases: [], level: '理解原理',
  boundary: '维度一致时的相加能解释；维度变化时的投影不熟', basis: 'model_inferred', status: 'pending',
  createdAt: nowIso, updatedAt: nowIso, lastConfirmedAt: null, source: null, note: 'smoke',
});
await postJson('/api/profile', prof);
await page.evaluate(async () => { await window.__ctx.profileStore.load(); window.__ctx.openProfile(); });
await sleep(300);
const modal = await page.evaluate(() => {
  const m = document.getElementById('profileModal');
  return {
    open: !m.classList.contains('hidden'),
    counts: m.querySelector('#profileCounts')?.textContent || '',
    pending: m.querySelectorAll('#profilePending .profile-card').length,
    confirmed: m.querySelectorAll('#profileConfirmed .profile-card').length,
    dates: [...m.querySelectorAll('.profile-date')].map((x) => x.textContent),
  };
});
check('学习档案弹窗能打开并显示待确认/已确认', modal.open && modal.pending >= 1 && modal.confirmed >= 1, `pending=${modal.pending} confirmed=${modal.confirmed}`);
check('弹窗里显示确认时间', modal.dates.some((d) => /\d{4}-\d{2}-\d{2}/.test(d)), modal.dates.join(' | '));
const pendingTopic = await page.evaluate(() => document.querySelector('#profilePending .profile-topic')?.textContent || '');
check('待确认区列出 AI 观察条目', /残差连接/.test(pendingTopic), pendingTopic);
await page.evaluate(() => {
  const card = document.querySelector('#profilePending .profile-card');
  [...card.querySelectorAll('.profile-btn')].find((b) => b.textContent === '确认掌握').click();
});
await sleep(900);
const afterConfirm = await (await fetch(`${BASE}/api/profile`)).json();
const residual = (afterConfirm.items || []).find((i) => /残差连接/.test(i.topic));
check('弹窗里确认后写入 lastConfirmedAt', residual?.status === 'confirmed' && !!residual.lastConfirmedAt, residual?.status || '(没有)');
await page.evaluate(() => window.__ctx.closeProfile());

/* 10. 再压短：把上一条回答压缩（发一次请求，新条目叫「精简版」） */
mode = 'condense';
before = bodies.length;
await page.evaluate(() => {
  const msgs = [...document.querySelectorAll('#aiArea .msg.assistant')];
  const intro = msgs.find((m) => m.querySelector('.tag')?.textContent === '先给我讲明白');
  [...intro.querySelectorAll('.acts button')].find((b) => b.textContent === '再压短').click();
});
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => e.tag === '精简版' && e.status === 'complete'), { timeout: 20000 });
await sleep(300);
check('「再压短」发出压缩请求', bodies.length === before + 1 && /压缩成原来的/.test(bodies.at(-1).messages[0].content));

/* 11. 关闭个性化后，教学请求不再带学习档案（但仍带当前时间） */
await page.evaluate(() => window.__ctx.profileStore.setEnabled(false));
mode = 'prereq';
before = bodies.length;
await page.evaluate(() => window.__ctx.runTeaching('prereq', { force: true }));
await page.waitForFunction(() => !window.__state.busy, { timeout: 20000 });
await sleep(400);
check('关闭个性化后不再注入学习档案', bodies.length === before + 1 && !/学习档案 · 只影响讲解深度/.test(bodies.at(-1).messages[0].content));
check('关闭个性化后仍注入当前时间', /【当前时间】/.test(bodies.at(-1).messages.at(-1).content) || /【当前时间】/.test(bodies.at(-1).messages[0].content));
await page.evaluate(() => window.__ctx.profileStore.setEnabled(true));

/* 12. 重新打开页面：会话里的教学进度和「已生成」都要恢复 */
const errorsBeforeReload = pageErrors.length;
await page.goto(`${BASE}/?open=${encodeURIComponent('attention-arxiv.pdf')}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx, { timeout: 40000 });
await sleep(1800);
if (pageErrors.length > errorsBeforeReload) {
  // 页面主动重载时浏览器会取消旧页面的在途请求，这类记录不算缺陷
  for (let i = pageErrors.length - 1; i >= errorsBeforeReload; i -= 1) {
    if (/net::ERR_ABORTED|Failed to load resource/.test(pageErrors[i])) pageErrors.splice(i, 1);
  }
}
const restored = await page.evaluate(() => ({
  walk: window.__ctx.teaching.walk,
  entries: window.__state.sessionEntries.map((e) => e.tag),
  profileConfirmed: window.__ctx.profile.items.filter((i) => i.status === 'confirmed').length,
}));
check('重开后教学进度恢复（第 2 步）', restored.walk?.step === 2, `step=${restored.walk?.step}`);
check('重开后会话条目恢复', restored.entries.includes('先给我讲明白') && restored.entries.includes('我需要先懂什么'), restored.entries.join(' / '));
check('学习档案跨重启保留', restored.profileConfirmed >= 1, `${restored.profileConfirmed} 条已确认`);
const reqBeforeCached = bodies.length;
await page.click('#opsBtn');
await sleep(300);
const restoredMenu = await page.evaluate(() => ({
  titles: [...document.querySelectorAll('#opsMenu .ops-item .ops-title')].map((x) => x.textContent),
  profile: document.querySelector('#opsMenu .ops-profile-title')?.textContent || '',
}));
check('恢复后菜单标出「已生成」与步行进度', /已生成/.test(restoredMenu.titles.join('|')) && /进行到第 2 步/.test(restoredMenu.titles.join('|')), restoredMenu.titles.join(' / '));
check('恢复后菜单头部显示学习档案条数', /已确认 \d+ 条/.test(restoredMenu.profile), restoredMenu.profile);
await page.keyboard.press('Escape');
await page.evaluate(() => { [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /先给我讲明白/.test(b.textContent))?.click(); });
await sleep(900);
check('重开后点已生成的能力不再请求模型', bodies.length === reqBeforeCached, `${bodies.length - reqBeforeCached} 次`);

check('没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);

