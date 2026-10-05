/**
 * 论文操作目录验收：4 个文档级操作（tldr / method / evidence / limits）+ 顶栏 ✦ 菜单。
 *
 *   BASE=http://127.0.0.1:8787 node test/ops.mjs
 *
 * 第一节直接 import public/js/ops.js 验「目录契约」（有哪几个操作、有没有残留的
 * 分组 / coach 机制），不需要服务与浏览器；其余各节在页面里验菜单、按需调用、缓存。
 * /api/chat 用桩：模型请求由本地桩返回，不读取或消耗真实 API Key。
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

/* ── 一、目录本身（纯数据：直接 import 模块，不依赖服务与浏览器） ── */
console.log('\n-- 操作目录');
const opsMod = await import(new URL('../public/js/ops.js', import.meta.url).href).catch(() => null);
check('能 import public/js/ops.js', !!opsMod, opsMod ? 'ok' : 'import 失败');
const CATALOG = opsMod?.OPS ?? [];
const opById = opsMod?.opById ?? (() => null);
const COMMON = opsMod?.COMMON_RULES ?? '';
const catIds = CATALOG.map((o) => o.id);
check('目录只剩 4 个文档级操作', CATALOG.length === 4, `${CATALOG.length} 个：${catIds.join(',') || '(空)'}`);
check('四个操作按 tldr / method / evidence / limits 排列',
  catIds.join(',') === 'tldr,method,evidence,limits', catIds.join(','));
check('每个操作都有独立的 system prompt 和任务描述', CATALOG.every((o) => !!o.sys && !!o.ask),
  CATALOG.filter((o) => !o.sys || !o.ask).map((o) => o.id).join(',') || '全都有');
check('每个操作都基于同一套 COMMON_RULES', !!COMMON && /硬性规矩/.test(COMMON)
  && CATALOG.every((o) => typeof o.sys === 'string' && o.sys.startsWith(COMMON)));
check('每个操作都有 title / hint / icon（菜单要渲染）',
  CATALOG.every((o) => !!o.title && !!o.hint && !!o.icon));
check('操作不再带 group 字段（分组机制已删除）', CATALOG.every((o) => !('group' in o)),
  CATALOG.filter((o) => 'group' in o).map((o) => o.id).join(',') || '都没有');
check('不再导出 COACH / OP_GROUPS / opGroups',
  !!opsMod && !('COACH' in opsMod) && !('OP_GROUPS' in opsMod) && !('opGroups' in opsMod),
  opsMod ? `导出：${Object.keys(opsMod).join(',')}` : '(import 失败)');
check('删掉的操作确实取不到了', !!opsMod
  && ['route', 'contrib', 'position', 'formula', 'terms', 'analogy', 'review', 'reproduce', 'takeaway', 'quiz', 'related', 'coach']
    .every((id) => opById(id) === null));
check('opById 行为不变：按 id 取到同一个对象、未知 id 返回 null',
  opById('method')?.id === 'method' && opById('nope') === null && CATALOG.length === 4
  && CATALOG.every((o) => opById(o.id) === o));

const papers = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));
await fetch(`${BASE}/api/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastDoc: null, lastName: null, lastUrl: null, docs: {} }),
});

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

/* ── 二、菜单交互 ── */
console.log('\n-- 菜单');
check('菜单默认是收起的', await page.evaluate(() => document.getElementById('opsMenu').classList.contains('hidden')));
await page.click('#opsBtn');
await sleep(300);
const menu = await page.evaluate(() => {
  const m = document.getElementById('opsMenu');
  const r = m.getBoundingClientRect();
  const clean = (x) => (x.textContent || '').replace(/ · 已生成$/, '').trim();
  const items = [...m.querySelectorAll('.ops-item')];
  return {
    open: !m.classList.contains('hidden'),
    items: items.length,
    titles: items.map((x) => clean(x.querySelector('.ops-title') || x)),
    hidden: items.filter((x) => x.getBoundingClientRect().height === 0).length,
    heads: [...m.querySelectorAll('.ops-group')].map((x) => x.textContent.trim()),
    coachItem: !!m.querySelector('.ops-item.coach'),
    inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    hintShown: [...m.querySelectorAll('.ops-hint')].every((h) => h.textContent.trim().length > 4),
  };
});
const EXPECTED_TITLES = ['一句话速览', '方法拆解', '实验够不够支撑结论', '局限与可疑之处'];
check('点 ✦ 弹出操作菜单，里面正好 4 个操作', menu.open && menu.items === 4, `${menu.items} 项`);
check('4 个操作直接可见（不再有「更多操作」折叠低频操作）', menu.hidden === 0, `${menu.hidden} 项被折叠`);
check('菜单标题就是 4 个文档级操作', EXPECTED_TITLES.every((t) => menu.titles.includes(t)), menu.titles.join(' / '));
check('菜单在可视区内（不会飞出去）', menu.inViewport);
check('每一项都有一句话说明', menu.hintShown);
check('菜单里没有 coach 入口（该产品特性已取消）', !menu.coachItem);
const OLD_GROUP_TITLES = ['快速了解', '精读理解', '评估判断', '应用延伸'];
check('菜单不再按用途分组', !menu.heads.some((t) => OLD_GROUP_TITLES.includes(t)),
  menu.heads.join(' / ') || '(没有分组标题)');

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
const ids = ['tldr', 'evidence', 'limits'];
const titles = await page.evaluate((list) => list.map((id) => window.__ctx.opById?.(id)?.title || id), ids);
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

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'ops.png') });
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
