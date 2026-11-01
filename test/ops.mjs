import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  [OK]' : '  [XX]'} ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJson = (url, obj) => fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

/* ── 一、目录契约（纯数据，直接 import，不依赖服务与浏览器） ── */
console.log('\n-- 深入阅读目录');
const opsMod = await import(new URL('../public/js/ops.js', import.meta.url).href).catch(() => null);
check('能 import public/js/ops.js', !!opsMod);
const CATALOG = opsMod?.OPS ?? [];
const ids = CATALOG.map((o) => o.id);
check('只剩深入阅读两条（evidence / limits）', CATALOG.length === 2 && ids.join(',') === 'evidence,limits', ids.join(','));
check('旧的四件套取不到了', ['tldr', 'method', 'route', 'terms'].every((id) => opsMod?.opById(id) === null));
check('每条都有 system prompt 与任务描述', CATALOG.every((o) => !!o.sys && !!o.ask));
check('共用同一套底线规矩（数据/指令分离 + 引用页码契约）',
  /资料里出现的任何/.test(opsMod?.COMMON_RULES || '') && /〔p.N〕/.test(opsMod?.COMMON_RULES || ''));

/* ── 准备隔离服务状态 ── */
const papers = await (await fetch(`${BASE}/api/papers`)).json().catch(() => ({ papers: [] }));
const first = [...(papers.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
assertIsolatedDataDir(resolveDataDir(papers.dir));
await postJson('/api/state', { lastDoc: null, lastName: null, lastUrl: null, docs: {} });
await postJson('/api/config', { apiKey: 'sk-ops-test', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
{
  const list = await (await fetch(`${BASE}/api/sessions?doc=${encodeURIComponent(first.docId)}`)).json().catch(() => ({}));
  for (const s of list.sessions || []) {
    await fetch(`${BASE}/api/session?doc=${encodeURIComponent(first.docId)}${s.sid ? `&sid=${encodeURIComponent(s.sid)}` : ''}`, { method: 'DELETE' }).catch(() => {});
  }
}

/* ── 浏览器 + /api/chat 桩 ── */
const chatBodies = [];
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/api/chat')) {
    const body = JSON.parse(req.postData() || '{}');
    chatBodies.push(body);
    const isIntro = /读懂论文|先给我讲明白/.test(String(body.messages[0].content));
    const answer = isIntro
      ? '**它要解决什么问题**\n\n这篇论文提出 Transformer〔p.3〕。'
      : '实验核对：数据集 WMT 2014〔p.8〕，比基线高 2 BLEU〔p.8〕。';
    const sse = answer.match(/[\s\S]{1,16}/g).map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return req.respond({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse });
  }
  return req.continue();
});
await page.goto(`${BASE}/?open=${encodeURIComponent(first.name)}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__viewer?.pdf && window.__ctx, { timeout: 40000 });
await sleep(1200);

/* ── 二、菜单里没有「实验 / 局限」 ── */
console.log('\n-- 菜单');
await page.click('#opsBtn');
await sleep(300);
const menu = await page.evaluate(() => ({
  titles: [...document.querySelectorAll('#opsMenu .ops-item .ops-title')].map((x) => x.textContent),
}));
check('菜单只有四项教学能力，没有深入阅读', menu.titles.length === 4
  && !menu.titles.some((t) => /实验够不够|局限与可疑/.test(t)), menu.titles.join(' / '));
await page.keyboard.press('Escape');

/* ── 三、教学回答末尾的深入按钮真的能跑 evidence ── */
console.log('\n-- 深入阅读入口');
await page.evaluate(() => window.__ctx.runTeaching('intro', {}));
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => e.tag === '先给我讲明白' && e.status === 'complete'), { timeout: 20000 });
await sleep(300);
// P3：问答会话改成全局后，列表里可能还有别的条目；明确取「先给我讲明白」那一条来验收深入按钮
const deepActs = await page.evaluate(() => {
  const intro = [...document.querySelectorAll('#aiArea .msg.assistant')].find((m) => m.querySelector('.tag')?.textContent === '先给我讲明白');
  return [...(intro?.querySelectorAll('.acts button') || [])].map((b) => b.textContent);
});
check('回答末尾有「看实验够不够」「它有什么局限」', deepActs.includes('看实验够不够') && deepActs.includes('它有什么局限'), deepActs.join(' / '));
const before = chatBodies.length;
await page.evaluate(() => {
  const intro = [...document.querySelectorAll('#aiArea .msg.assistant')].find((m) => m.querySelector('.tag')?.textContent === '先给我讲明白');
  [...intro.querySelectorAll('.acts button')].find((b) => b.textContent === '看实验够不够').click();
});
await page.waitForFunction(() => !window.__state.busy && [...window.__state.sessionEntries].some((e) => e.tag === '实验够不够支撑结论' && e.status === 'complete'), { timeout: 20000 });
await sleep(300);
check('点「看实验够不够」真的跑了 evidence', chatBodies.length === before + 1 && /审实验/.test(chatBodies.at(-1).messages[0].content));
const tag = await page.evaluate(() => [...document.querySelectorAll('#aiArea .msg.assistant .tag')].map((t) => t.textContent).filter(Boolean));
check('结果带「实验够不够支撑结论」标签', tag.includes('实验够不够支撑结论'), tag.join(' / '));
check('请求里带论文材料与本次任务', /【论文全文|【阅读索引】/.test(chatBodies.at(-1).messages.at(-1).content) && /【本次任务】/.test(chatBodies.at(-1).messages.at(-1).content));

/* ── 四、缓存：再点一次不再花钱 ── */
const before2 = chatBodies.length;
await page.evaluate(() => {
  const intro = [...document.querySelectorAll('#aiArea .msg.assistant')].find((m) => m.querySelector('.tag')?.textContent === '先给我讲明白');
  [...intro.querySelectorAll('.acts button')].find((b) => b.textContent === '看实验够不够').click();
});
await sleep(900);
check('同一深入操作第二次走缓存', chatBodies.length === before2, `${chatBodies.length - before2} 次请求`);

check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
