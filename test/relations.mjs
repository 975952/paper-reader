/**
 * 论文导入 + 文献关系整理 验收。
 *
 *   BASE=http://127.0.0.1:8787 node test/relations.mjs
 *
 * 真实部分：/api/import-pdf 的输入校验、真正的下载（arXiv 上的小 PDF，
 *   下载完写进 test 的临时 papers 目录，跑完删掉，不动用户的书架）。
 * 浏览器部分：参考文献面板的解析与渲染（/api/ref-search 用桩，免得依赖外网节奏）。
 *
 * 2026-10 新契约（本套件按它改写）：
 *   · 参考文献**按需解析** —— 打开论文本身不再后台跑全文引用抽取，只有用户真的打开
 *     「参考文献」这一块（标题栏展开 / 左栏图标）才开始整理；
 *   · 面板标题与活动栏文案都叫**参考文献**（原来叫「文献关系」）；
 *   · `#relFilter`（状态筛选）、`#relSort`（排序）、`#relFindPdf`（批量找未入库 PDF）、
 *     `#relScanLib`（扫描库内引用）四个控件整体下架 —— 查找改成**逐条**触发
 *     （行上的「查 PDF / 重查」+ 详情卡片里的「找这篇的 PDF」），库内引用结论跟着解析结果一起给；
 *   · `#relSearch` 搜索框保留。
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

const papersInfo = await fetch(`${BASE}/api/papers`).then((r) => r.json()).catch(() => ({ papers: [] }));
const first = [...(papersInfo.papers || [])].sort((a, b) => (b.size || 0) - (a.size || 0))[0] || {};
check('服务端有可用的 PDF', !!first.name, first.name || '(无)');
const PAPERS_DIR = papersInfo.dir;
assertIsolatedDataDir(resolveDataDir(PAPERS_DIR));
const before = new Set(fs.readdirSync(PAPERS_DIR));
// 测试期间新导入的文件，结束后一律删掉
const cleanupImports = () => {
  for (const f of fs.readdirSync(PAPERS_DIR)) {
    if (!before.has(f)) { try { fs.rmSync(path.join(PAPERS_DIR, f), { force: true }); } catch { /* 忽略 */ } }
  }
};
process.on('exit', cleanupImports);

/* ═══════════ 一、/api/import-pdf 的校验（不发真实下载） ═══════════ */
console.log('\n-- 导入接口的输入校验');
for (const [label, q] of [
  ['缺少 url', ''],
  ['非 http 协议', '?url=' + encodeURIComponent('javascript:alert(1)')],
  ['file 协议', '?url=' + encodeURIComponent('file:///C:/Windows/win.ini')],
  ['内网地址（SSRF）', '?url=' + encodeURIComponent('http://127.0.0.1:8787/api/health')],
  ['私网段', '?url=' + encodeURIComponent('http://192.168.1.1/x.pdf')],
  ['超长 url', '?url=' + encodeURIComponent('http://a.com/' + 'x'.repeat(3000))],
]) {
  const r = await fetch(`${BASE}/api/import-pdf${q}`);
  check(`${label} 被拒绝`, r.status >= 400, `${r.status}`);
}
{
  // 指向一个 HTML 页面：必须识别出「这不是 PDF」而不是存下来
  const r = await fetch(`${BASE}/api/import-pdf?url=${encodeURIComponent('https://arxiv.org/abs/1706.03762')}`,
    { signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  check('网页链接会被识破（不是 PDF）', r.status === 400 && /PDF/i.test(j?.error?.message || j?.error || ''),
    `${r.status} ${j?.error?.message || ''}`);
}

/* ═══════════ 二、真实下载一个开放 PDF ═══════════ */
console.log('\n-- 真实下载导入');
let imported = null;
try {
  const target = 'https://arxiv.org/pdf/1706.03762v7';
  const r = await fetch(`${BASE}/api/import-pdf?url=${encodeURIComponent(target)}&name=${encodeURIComponent('attention-arxiv.pdf')}`,
    { signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  check('能真的把 PDF 抓下来并落盘', r.status === 200 && j.ok === true, `${r.status} ${j.name || j?.error?.message || ''}`);
  if (j.ok) {
    imported = j;
    check('落盘文件名带着我们给的名字', /attention-arxiv/.test(j.name), j.name);
    check('文件确实在 papers/ 里', fs.existsSync(path.join(PAPERS_DIR, j.name)), j.name);
    const st = fs.statSync(path.join(PAPERS_DIR, j.name));
    check('大小对得上且是个 PDF', st.size > 100000 && fs.readFileSync(path.join(PAPERS_DIR, j.name)).subarray(0, 5).toString() === '%PDF-',
      `${Math.round(st.size / 1024)}KB`);
    check('返回了可直接打开的 url 与 docId', /^\/api\/pdf\?name=/.test(j.url) && !!j.docId, `${j.url} · ${j.docId}`);
    const list = await fetch(`${BASE}/api/papers`).then((x) => x.json());
    check('新导入的论文出现在书架列表里', list.papers.some((p) => p.name === j.name), `${list.papers.length} 篇`);

    // 重复导入同一份：不应该再存一份
    const again = await fetch(`${BASE}/api/import-pdf?url=${encodeURIComponent(target)}&name=${encodeURIComponent('attention-arxiv.pdf')}`,
      { signal: AbortSignal.timeout(120000) }).then((x) => x.json());
    check('同一份文件重复导入不会存两遍', again.ok && again.name === j.name, `${again.name}`);
  }
} catch (e) {
  check('真实下载导入（联网）', false, String(e.message).slice(0, 90));
}

/* ═══════════ 三、浏览器：参考文献面板 ═══════════ */
console.log('\n-- 参考文献面板');
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

const REF_TEXT = 'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin. Attention is all you need. In NeurIPS, 2017.';
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/ref-search')) {
    return req.respond({
      status: 200, contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: 'q', title: 'Attention Is All You Need',
        results: [{ source: 'arXiv', title: 'Attention Is All You Need', year: '2017', venue: 'arXiv', url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762' }],
        searchUrl: 'https://www.bing.com/search?q=x', scholarUrl: 'https://scholar.google.com/scholar?q=x',
      }),
    });
  }
  return req.continue();
});

await page.goto(`${BASE}/?topbar=static`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#fileList li', { timeout: 20000 });
// 打开那篇原始的 attention 论文（不是刚导入的 arxiv 版）
await page.evaluate((id) => {
  const li = [...document.querySelectorAll('#fileList li')].find((x) => x.dataset.id === id);
  li.click();
}, first.docId);
await page.waitForFunction(() => window.__viewer?.pdf, { timeout: 40000 });
await sleep(1200);

/**
 * 2026-10 新契约：参考文献是**按需解析**的 —— 打开论文本身不再后台跑全文引用抽取。
 * 先断言「打开论文后 refs 还是空的、摘要行在提示用户打开这一块」，再展开面板触发解析。
 */
const lazy = await page.evaluate(() => ({
  collapsed: document.getElementById('relSec').classList.contains('panel-collapsed'),
  refs: (window.__state.refs || []).length,
  summary: document.getElementById('relSummary').textContent,
}));
check('打开论文后不后台解析参考文献（按需模型）', lazy.refs === 0, `refs=${lazy.refs}`);
check('未整理时摘要行告诉用户去哪儿触发（还没整理 / ↻）',
  /还没整理|打开/.test(lazy.summary), JSON.stringify(lazy.summary));

/** 展开「参考文献」这一块（= 触发按需解析的唯一入口）。面板隐藏时标题栏点不到，先走左栏活动栏。 */
async function openRelPanel() {
  const st = await page.evaluate(() => {
    const sec = document.getElementById('relSec');
    const r = sec.getBoundingClientRect();
    return { collapsed: sec.classList.contains('panel-collapsed'), onScreen: r.height > 0 && r.width > 0 };
  });
  if (!st.onScreen) {
    await page.evaluate(() => document.querySelector('#railLeft .rail-btn[data-rail="rel"]')?.click());
    await sleep(300);
  }
  const stillCollapsed = await page.evaluate(() => document.getElementById('relSec').classList.contains('panel-collapsed'));
  if (stillCollapsed) await page.click('#relSec .sec-head');
}
await openRelPanel();
await page.waitForFunction(() => !document.getElementById('relSec').classList.contains('panel-collapsed'), { timeout: 5000 });
await page.waitForFunction(() => (window.__state.refs || []).length > 0, { timeout: 60000 }).catch(() => {});
await sleep(800);
const expanded = await page.evaluate(() => ({
  collapsed: document.getElementById('relSec').classList.contains('panel-collapsed'),
  refs: (window.__state.refs || []).length,
}));
check('展开「参考文献」这一块就开始整理', !expanded.collapsed && expanded.refs > 0, `refs=${expanded.refs}`);

const rel = await page.evaluate(() => ({
  refs: (window.__state.refs || []).length,
  doc: window.__state.refsDoc,
  summary: document.getElementById('relSummary').textContent,
  items: document.querySelectorAll('#relList .rel-item').length,
  nums: [...document.querySelectorAll('#relList .rel-item .rn')].slice(0, 5).map((n) => n.textContent),
  hasLibTag: !!document.querySelector('#relList .rel-tag.lib'),
}));
check('打开论文后自动解析出参考文献', rel.refs > 0, `${rel.refs} 条 · ${rel.nums.join(' ')}`);
check('面板渲染出了对应数量的条目', rel.items === rel.refs, `${rel.items} 条`);
check('摘要行写明了「本文引用 N 篇」', /本文引用/.test(rel.summary) && /书架已有/.test(rel.summary), rel.summary);
check('文献编号是 [1] [2] … 连续编号', rel.nums[0] === '[1]', rel.nums.join(' '));

// 解析出来的条目确实像文献（含年份/作者/期刊）
const sample = await page.evaluate(() => (window.__state.refs || []).slice(0, 3).map((r) => r.text));
check('条目内容像正经文献（有年份）', sample.every((t) => /(19|20)\d{2}/.test(t)), sample[0]?.slice(0, 60));
// 合成论文的引用表可能很短；只要能读出一条完整的论文条目即可。
check('条目里能找到它真正引用过的经典工作',
  await page.evaluate(() => (window.__state.refs || []).some((r) => /Attention Is All You Need|Vaswani/i.test(r.text))),
  'Attention Is All You Need');

/**
 * 参考文献条目前的 [n] 不能伪装成正文引用；否则在文献列表点它只会回到同一页。
 *
 * ⚠️ 判据在 2026-10 被收窄过一次（原来要求「参考文献所在的这一页上不许有任何 .cite-link」）。
 * 那个写法对合成夹具是错的：夹具每页都重复同一段正文，第 16 页既有参考文献条目
 * **也有**带行内引用的正文（实测压着文字层的 span 是
 * 「A citation to the original architecture appears here [1].」和
 *  「A reference marker [3-5] tests clickable citation detection.」）——
 * 那两条本来就该可点。真正要守的是：**参考文献条目本身**不许被当成正文引用。
 */
const refPage = await page.evaluate(() => window.__state.refs?.[0]?.page || 0);
if (refPage) {
  await page.evaluate((p) => window.__viewer.goToPage(p), refPage);
  await sleep(1000);
}
const refPageLinks = await page.evaluate((p) => {
  const pageEl = document.querySelector(`.page[data-page="${p}"]`);
  if (!pageEl) return { missing: true };
  const spans = [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')];
  const links = [...pageEl.querySelectorAll('.cite-link')];
  const entries = (window.__state.refs || []).map((r) => (r.text || '').trim().toLowerCase()).filter((t) => t.length > 12);
  const under = (r) => spans.filter((s) => {
    const sr = s.getBoundingClientRect();
    return sr.left < r.right && sr.right > r.left && sr.top < r.bottom && sr.bottom > r.top;
  });
  const onEntry = links.filter((l) => under(l.getBoundingClientRect()).some((s) => {
    const t = (s.textContent || '').trim().toLowerCase();
    return t.length > 12 && entries.some((e) => e.startsWith(t.slice(0, 24)) || t.startsWith(e.slice(0, 24)));
  }));
  return { total: links.length, onEntry: onEntry.length };
}, refPage);
check('正文里的 [n] 可点，但参考文献条目本身不会被伪装成正文引用',
  !refPageLinks.missing && refPageLinks.total > 0 && refPageLinks.onEntry === 0,
  `p.${refPage} 可点编号 ${refPageLinks.total ?? 0} 处 · 压在参考文献条目上的 ${refPageLinks.onEntry ?? '(页面不在)'} 处`);

/* 3.0 阶段 3：分组列表 + 概览计数 + 三个视图控件 */
console.log('\n-- 分组列表与概览');
const grouped = await page.evaluate(() => {
  const g = (id) => document.querySelector(`#relList .rel-group[data-group="${id}"]`);
  return {
    refs: (window.__state.refs || []).length,
    groups: ['lib', 'pdf', 'todo'].map((id) => ({
      id,
      exists: !!g(id),
      count: g(id) ? g(id).querySelectorAll('.rel-item').length : -1,
      head: g(id)?.querySelector('.rel-group-head')?.textContent.trim() || '',
    })),
    items: document.querySelectorAll('#relList .rel-item').length,
    controls: ['relSearch'].filter((x) => !!document.getElementById(x)),
    removedControls: ['relFilter', 'relSort', 'relFindPdf', 'relScanLib'].filter((x) => !!document.getElementById(x)),
    summary: document.getElementById('relSummary').textContent,
  };
});
const nums3 = grouped.summary.match(/本文引用\s*(\d+)\s*篇.*书架已有\s*(\d+)\s*篇.*查到开放版本\s*(\d+)\s*条.*待查\s*(\d+)\s*条/);
check('三组（书架已有 / 已找到开放版本 / 待查未找到）都渲染出来了，标题带计数',
  grouped.groups.every((x) => x.exists && /\(\d+\)/.test(x.head)),
  grouped.groups.map((x) => `${x.id}「${x.head}」`).join(' | '));
check('分组条目数之和 = state.refs 条数（也都算进 .rel-item）',
  grouped.groups.reduce((a, x) => a + x.count, 0) === grouped.refs && grouped.items === grouped.refs,
  `${grouped.groups.map((x) => x.count).join(' + ')} = ${grouped.refs} · li=${grouped.items}`);
check('概览四段数字与分组计数逐项一致', !!nums3
  && Number(nums3[1]) === grouped.refs
  && Number(nums3[2]) === grouped.groups[0].count
  && Number(nums3[3]) === grouped.groups[1].count
  && Number(nums3[4]) === grouped.groups[2].count,
  grouped.summary);
check('搜索框还在（状态筛选 / 排序已下架）', grouped.controls.join() === 'relSearch', grouped.controls.join(',') || '(无)');
check('下架的筛选 / 排序 / 批量找 PDF / 库内扫描控件确实不在',
  grouped.removedControls.length === 0, grouped.removedControls.join(',') || '(都没有)');

/* 3.1 单条查 PDF → 只提供打开链接 */
console.log('\n-- 单条查 PDF 与链接');
const single = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#relList .rel-item')];
  const it = items.find((x) => x.querySelector('button.rbtn')?.textContent === '查 PDF') || items[0];
  if (!it) return null;
  const btn = [...it.querySelectorAll('button.rbtn')].find((b) => b.textContent === '查 PDF');
  if (!btn) return { skipped: true };
  btn.click();
  return { clicked: true };
});
check('找得到「查 PDF」按钮', !!single && (single.clicked || single.skipped), JSON.stringify(single));
await page.waitForFunction(() => (window.__state.refs || []).some((r) => r.found), { timeout: 20000 }).catch(() => {});
await sleep(400);
const afterLookup = await page.evaluate(() => {
  const it = [...document.querySelectorAll('#relList .rel-item')].find((x) => x.querySelector('button.rbtn')?.textContent === '查 PDF') || document.querySelector('#relList .rel-item');
  return it ? [...it.querySelectorAll('.rrow .rbtn')].map((b) => b.textContent) : [];
});
check('查到后只提供打开链接，不显示导入按钮', afterLookup.includes('打开链接') && !afterLookup.some((x) => /导入/.test(x)), afterLookup.join(' / '));

/* 3.1b 阶段 3：点列表里的一行 → 详情面板（复用正文 [n] 的同一个 #citeBox） */
console.log('\n-- 从列表点开详情');
const refDetail = await page.evaluate(async () => {
  const it = document.querySelector('#relList .rel-item');
  const rowText = it.querySelector('.rt').textContent.replace(/^\[\d+\]/, '');
  it.querySelector('.rt').click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    rowText,
    open: !document.getElementById('citeBox').classList.contains('hidden'),
    title: document.getElementById('citeTitle').textContent,
    text: document.getElementById('citeText').textContent,
    detail: document.getElementById('citeDetail').textContent,
  };
});
check('点列表里的一行就能打开详情卡片', refDetail.open && /参考文献 \[1\]/.test(refDetail.title), refDetail.title);
check('详情里是这条文献的完整条目文本',
  refDetail.text.length > 30 && refDetail.rowText.includes(refDetail.text.slice(0, 30)), refDetail.text.slice(0, 60));
check('详情里给出了已查到的开放版本（打开链接 / 复制链接）',
  /打开链接/.test(refDetail.detail) && /复制链接/.test(refDetail.detail), refDetail.detail.slice(0, 60));
await page.evaluate(() => document.getElementById('citeClose').click());

/* 3.2 批量找 PDF 入口已下架（2026-10）：查找改成**逐条**触发 ——
   行上的「查 PDF / 重查」+ 详情卡片里的「找这篇的 PDF」（上面 3.1 已经验过）。
   这里只记录当前的分组分布，供下面的搜索用例对照。 */
console.log('\n-- 分组分布（批量入口已下架，查找改为逐条）');
const pdfRows = await page.evaluate(() => document.querySelectorAll('#relList .rel-group[data-group="pdf"] .rel-item').length);
check('「已找到开放版本」组的行数与状态一致（单条查找的结果落在这一组）',
  pdfRows === await page.evaluate(() => (window.__state.refs || []).filter((r) => r.found).length),
  `组内 ${pdfRows} 行`);

/* 3.2b 搜索真的作用于列表（状态筛选控件已随视图控件一起下架） */
const viewTest = await page.evaluate(async () => {
  const snap = () => ({ items: document.querySelectorAll('#relList .rel-item').length });
  const inp = document.getElementById('relSearch');
  const before = snap();
  inp.value = 'zzz-no-such-reference';
  inp.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 80));
  const searched = snap();
  inp.value = '';
  inp.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 80));
  return { before, searched, cleared: snap() };
});
check('搜索框能收窄列表、清空后还原',
  viewTest.searched.items === 0 && viewTest.cleared.items === viewTest.before.items && viewTest.cleared.items > 0,
  `全部 ${viewTest.before.items} → 搜不到 ${viewTest.searched.items} → 清空 ${viewTest.cleared.items}`);

/* 3.3 库内引用结论：扫描按钮已下架，结论行跟着解析结果一起给 */
console.log('\n-- 库内引用结论');
const cited = await page.evaluate(() => ({
  body: document.querySelector('#relList .rel-cited')?.textContent || '',
  summary: document.getElementById('relSummary').textContent,
}));
check('列表开头给出「本文有没有引用书架里的论文」的结论', /书架/.test(cited.body), cited.body.slice(0, 70));
check('摘要行里写明了书架情况', /书架已有/.test(cited.summary), cited.summary);

/* 3.4 文献检索卡片里的链接 */
console.log('\n-- 文献检索卡片');
await page.evaluate(() => window.__viewer.goToPage(2));
await sleep(1500);
const citePt = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vr = v.getBoundingClientRect();
  const find = () => [...document.querySelectorAll('.cite-link')].find((x) => {
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.top > vr.top + 10 && r.bottom < vr.bottom - 10;
  });
  let a = find();
  if (!a) {
    v.scrollTop = 0;
    return null;
  }
  const r = a.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (citePt) {
  await page.mouse.click(citePt.x, citePt.y);
  await page.waitForSelector('#citeBox:not(.hidden)', { timeout: 8000 });
  await page.click('#citeSearch');
  await page.waitForFunction(() => document.querySelectorAll('#citeResult .cite-item').length > 0, { timeout: 15000 }).catch(() => {});
  await sleep(400);
  const card = await page.evaluate(() => ({
    title: document.querySelector('#citeResult .ci-title')?.textContent || '',
    links: [...document.querySelectorAll('#citeResult .ci-acts a')].map((a) => a.textContent.trim()),
    imports: document.querySelectorAll('#citeResult button.import').length,
  }));
  check('参考文献卡片显示论文标题和打开链接', /Attention Is All You Need/i.test(card.title) && card.links.includes('打开链接'), JSON.stringify(card));
  check('搜索结果不再提供直接导入', card.imports === 0, `导入按钮 ${card.imports} 个`);
} else {
  check('找得到可点的 [n] 引用', false, '页面上没有可见的 [n]');
}

/* ═══════════ 汇总 ═══════════ */
check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('没有控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, 'relations.png') });
await browser.close();
cleanupImports();
const leftover = fs.readdirSync(PAPERS_DIR).filter((f) => !before.has(f));
check('测试导入的文件已清理（没弄脏用户书架）', leftover.length === 0, leftover.join(', ') || '干净');
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await sleep(250);
process.exit(passed === results.length ? 0 : 1);
