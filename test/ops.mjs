/**
 * 论文操作（可按需调用的那一排）+ coach 入口 验收。
 *
 *   BASE=http://127.0.0.1:8787 node test/ops.mjs
 *
 * /api/chat 用桩：这里验的是「操作目录 / 按需调用 / 缓存 / prompt 约束」，
 * 模型请求由本地桩返回，不读取或消耗真实 API Key。
 */
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(import.meta.dirname, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

/* ── 一、目录本身（纯数据，先在页面里查） ── */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
const chatBodies = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    chatBodies.push(JSON.parse(req.postData() || '{}'));
    const sse = ['【桩】这是操作结果。多头的做法见 〔p.5〕。'].flatMap((t) => t.match(/[\s\S]{1,12}/g) || [])
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  return req.continue();
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id) || document.querySelector('#fileList li');
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1500);

console.log('\n-- 操作目录');
const catalog = await page.evaluate(() => ({
  ops: window.__ctx.OPS.map((o) => ({ id: o.id, title: o.title, group: o.group, hasSys: !!o.sys, hasAsk: !!o.ask })),
  groups: window.__ctx.opGroups().map((g) => ({ title: g.title, n: g.ops.length })),
  coach: !!window.__ctx.COACH,
}));
check('操作目录里有足够多的操作（≥12）', catalog.ops.length >= 12, `${catalog.ops.length} 个`);
check('每个操作都有独立的 system prompt 和任务描述', catalog.ops.every((o) => o.hasSys && o.hasAsk),
  catalog.ops.filter((o) => !o.hasSys || !o.hasAsk).map((o) => o.id).join(',') || '全都有');
check('按用途分了组', catalog.groups.length >= 3, catalog.groups.map((g) => `${g.title}(${g.n})`).join(' '));
check('coach 是独立入口（不在操作列表里）',
  catalog.coach && !catalog.ops.some((o) => o.id === 'coach'),
  catalog.ops.map((o) => o.id).join(','));

/* ── 二、菜单交互 ── */
console.log('\n-- 菜单');
check('菜单默认是收起的', await page.evaluate(() => document.getElementById('opsMenu').classList.contains('hidden')));
await page.click('#opsBtn');
await sleep(300);
const menu = await page.evaluate(() => {
  const m = document.getElementById('opsMenu');
  const r = m.getBoundingClientRect();
  return {
    open: !m.classList.contains('hidden'),
    items: m.querySelectorAll('.ops-item').length,
    featuredItems: m.querySelectorAll('.ops-featured .ops-item').length,
    featuredVisible: [...m.querySelectorAll('.ops-featured .ops-item')].every((x) => x.getBoundingClientRect().height > 0),
    featuredTitles: [...m.querySelectorAll('.ops-featured .ops-title')].map((x) => x.textContent),
    more: !!m.querySelector('#moreOps'),
    moreOpen: !!m.querySelector('#moreOps[open]'),
    moreSummary: m.querySelector('#moreOps > summary')?.textContent.trim() || '',
    moreItems: m.querySelectorAll('#moreOps .ops-item').length,
    groups: m.querySelectorAll('.ops-group').length,
    coachItem: !!m.querySelector('.ops-item.coach'),
    inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    hintShown: [...m.querySelectorAll('.ops-hint')].every((h) => h.textContent.trim().length > 4),
  };
});
check('点 ✦ 弹出操作菜单', menu.open && menu.items >= 12, `${menu.items} 项 / ${menu.groups} 组`);
check('首屏直接显示四个常用入口', menu.featuredItems === 4 && menu.featuredVisible
  && ['一句话速览', '阅读路线', '方法拆解', '术语表'].every((t) => menu.featuredTitles.includes(t)), menu.featuredTitles.join(' / '));
check('其余操作仍在默认收起的「更多操作」里', menu.more && !menu.moreOpen && menu.moreItems === catalog.ops.length - menu.featuredItems
  && /更多操作/.test(menu.moreSummary), `${menu.moreItems} 项 · ${menu.moreSummary}`);
check('菜单在可视区内（不会飞出去）', menu.inViewport);
check('每一项都有一句话说明', menu.hintShown);
check('菜单里有 coach 模式入口', menu.coachItem);

await page.click('#moreOps > summary');
await sleep(180);
const expanded = await page.evaluate(() => ({
  open: !!document.querySelector('#moreOps[open]'),
  visible: [...document.querySelectorAll('#moreOps .ops-item')].filter((x) => x.getBoundingClientRect().height > 0).length,
}));
check('展开「更多操作」后全部低频入口可见', expanded.open && expanded.visible === menu.moreItems, `${expanded.visible}/${menu.moreItems}`);

await page.keyboard.press('Escape');
await sleep(250);
check('Esc 能收起菜单', await page.evaluate(() => document.getElementById('opsMenu').classList.contains('hidden')));

/* ── 三、跑一个操作 ── */
console.log('\n-- 按需调用');
const before = chatBodies.length;
await page.click('#opsBtn');
await sleep(250);
await page.evaluate(() => {
  [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /方法拆解/.test(b.textContent)).click();
});
await page.waitForFunction((n) => document.querySelectorAll('#aiArea .msg.assistant .acts:not(.hidden)').length > n,
  { timeout: 40000 }, 0);
await sleep(600);

check('跑操作会发出且只发出一次请求', chatBodies.length === before + 1, `${chatBodies.length - before} 次`);
const req0 = chatBodies[before];
check('请求里带的是该操作自己的 system prompt', /方法/.test(req0.messages[0].content) && /硬性规矩/.test(req0.messages[0].content),
  req0.messages[0].content.slice(0, 40));
check('请求里带了论文材料', /【论文全文|【阅读索引】/.test(req0.messages[req0.messages.length - 1].content));
check('请求里带了本次任务', /【本次任务】/.test(req0.messages[req0.messages.length - 1].content));
const entryTag = await page.evaluate(() => {
  const m = [...document.querySelectorAll('#aiArea .msg.assistant')].pop();
  return m?.querySelector('.tag')?.textContent || '';
});
check('结果打上了操作名（分得清是谁生成的）', entryTag === '方法拆解', entryTag);
const entryActs = await page.evaluate(() => {
  const m = [...document.querySelectorAll('#aiArea .msg.assistant')].pop();
  return [...m.querySelectorAll('.acts button')].map((b) => b.textContent);
});
check('结果条目带「重新生成」', entryActs.includes('重新生成'), entryActs.join(' / '));

/* ── 四、缓存：同样的操作再点一次不该再花钱 ── */
console.log('\n-- 缓存');
const before2 = chatBodies.length;
await page.click('#opsBtn');
await sleep(250);
await page.evaluate(() => {
  [...document.querySelectorAll('#opsMenu .ops-item')].find((b) => /方法拆解/.test(b.textContent)).click();
});
await sleep(900);
check('再点同一个操作直接用缓存，不再请求', chatBodies.length === before2, `${chatBodies.length - before2} 次请求`);
const cachedCount = await page.evaluate(() => document.querySelectorAll('#aiArea .msg.assistant').length);
check('缓存命中不重复追加结果（原条目仍在结果区）', cachedCount === 1, `${cachedCount} 条助手消息`);
await page.click('#opsBtn');
await sleep(250);
const marked = await page.evaluate(() => {
  const m = document.getElementById('opsMenu');
  const it = [...m.querySelectorAll('.ops-item')].find((b) => /方法拆解/.test(b.textContent));
  return it ? { cached: it.classList.contains('cached'), text: it.querySelector('.ops-title').textContent } : null;
});
check('菜单里把跑过的操作标成「已生成」', !!marked && marked.cached, marked?.text || '');
await page.keyboard.press('Escape');
await sleep(200);

/* ── 五、重新生成 ── */
console.log('\n-- 重新生成');
const before3 = chatBodies.length;
await page.evaluate(() => {
  const m = [...document.querySelectorAll('#aiArea .msg.assistant')].pop();
  [...m.querySelectorAll('.acts button')].find((b) => b.textContent === '重新生成').click();
});
await page.waitForFunction(() => [...document.querySelectorAll('#aiArea .msg.assistant .acts button')]
  .some((b) => b.textContent === '重新生成'), { timeout: 40000 });
await sleep(600);
check('点「重新生成」会真的重新请求', chatBodies.length === before3 + 1, `${chatBodies.length - before3} 次`);

/* ── 六、别的操作也能跑 ── */
console.log('\n-- 多操作并存');
const ids = ['tldr', 'terms', 'limits'];
const titles = await page.evaluate((list) => list.map((id) => window.__ctx.opById(id).title), ids);
const reqBefore = chatBodies.length;
for (const id of ids) {
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate((x) => window.__ctx.runOperation(x, { force: true }), id);
  // eslint-disable-next-line no-await-in-loop
  await sleep(700);
}
const tags = await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .tag')].map((t) => t.textContent));
check('不同操作的结果都能出，且各自带名字', titles.every((t) => tags.includes(t)), tags.join(' / '));
const sentSys = chatBodies.slice(reqBefore).map((b) => b.messages[0].content);
check('每个操作发出去的是各自的 system prompt',
  sentSys.length === ids.length && new Set(sentSys).size === ids.length,
  `${sentSys.length} 次请求 / ${new Set(sentSys).size} 种 system prompt`);
check('「速览」的 prompt 要求只输出三句', /三句|三行/.test(sentSys[0] || ''), (sentSys[0] || '').slice(-40));

/* ── 七、coach 入口 ── */
console.log('\n-- coach 模式');
await page.click('#opsBtn');
await sleep(250);
await page.evaluate(() => document.querySelector('#opsMenu .ops-item.coach').click());
await sleep(700);
const coachText = await page.evaluate(() => {
  const m = [...document.querySelectorAll('#aiArea .msg.assistant')].pop();
  return { tag: m?.querySelector('.tag')?.textContent || '', text: m?.querySelector('.text')?.textContent || '' };
});
check('点 coach 会说明它是什么模式', coachText.tag === 'Coach' && /等你回答|按需开启/.test(coachText.text),
  coachText.text.slice(0, 50));
check('coach 不会立刻发请求（不是默认入口）', !chatBodies.some((b) => /Coach/.test(b.messages?.[0]?.content || '')),
  `${chatBodies.length} 次请求都不是 coach 发的`);

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'ops.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
