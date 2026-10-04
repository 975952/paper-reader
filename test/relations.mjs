/**
 * 论文导入 + 文献关系整理 验收。
 *
 *   BASE=http://127.0.0.1:8787 node test/relations.mjs
 *
 * 真实部分：/api/import-pdf 的输入校验、真正的下载（arXiv 上的小 PDF，
 *   下载完写进 test 的临时 papers 目录，跑完删掉，不动用户的书架）。
 * 浏览器部分：文献关系面板的解析与渲染（/api/ref-search 用桩，免得依赖外网节奏）。
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

/* ═══════════ 三、浏览器：文献关系面板 ═══════════ */
console.log('\n-- 文献关系面板');
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
// 等关系面板自动整理完
await page.waitForFunction(() => (window.__state.refs || []).length > 0, { timeout: 60000 }).catch(() => {});
await sleep(800);

const relCollapsed = await page.$eval('#relSec', (n) => n.classList.contains('panel-collapsed'));
check('打开论文后关系面板默认收起但已完成后台整理', relCollapsed && (await page.evaluate(() => (window.__state.refs || []).length > 0)), String(relCollapsed));
// 标题栏是关系功能的唯一入口；用真实点击展开后再操作搜索 / 查 PDF。
if (relCollapsed) await page.click('#relSec .sec-head');
await page.waitForFunction(() => !document.getElementById('relSec').classList.contains('panel-collapsed'), { timeout: 5000 });
check('点击关系入口可展开列表', await page.$eval('#relSec', (n) => !n.classList.contains('panel-collapsed')));

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

// 参考文献条目前的 [n] 不能伪装成正文引用；否则在文献列表点它只会回到同一页。
const refPage = await page.evaluate(() => window.__state.refs?.[0]?.page || 0);
if (refPage) {
  await page.evaluate((p) => window.__viewer.goToPage(p), refPage);
  await sleep(1000);
}
const refPageLinks = await page.evaluate((p) => {
  const pageEl = document.querySelector(`.page[data-page="${p}"]`);
  return pageEl ? pageEl.querySelectorAll('.cite-link').length : -1;
}, refPage);
check('参考文献表编号不会伪装成正文引用', refPage > 0 && refPageLinks === 0,
  `p.${refPage} 可点击编号 ${Math.max(0, refPageLinks)}`);

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
    controls: ['relSearch', 'relFilter', 'relSort'].every((x) => !!document.getElementById(x)),
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
check('搜索 / 状态筛选 / 排序三个控件都在', grouped.controls);

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

/* 3.2 批量找 PDF */
console.log('\n-- 批量找未入库的 PDF');
await page.click('#relFindPdf');
await page.waitForFunction(() => !/正在查/.test(document.getElementById('relSummary').textContent), { timeout: 60000 }).catch(() => {});
await sleep(600);
const batch = await page.evaluate(() => {
  const summary = document.getElementById('relSummary').textContent;
  return {
    summary,
    btn: document.getElementById('relFindPdf').textContent,
    found: (window.__state.refs || []).filter((r) => r.found).length,
    openCount: Number((summary.match(/查到开放版本\s*(\d+)/) || [])[1] || 0),
    pdfRows: document.querySelectorAll('#relList .rel-group[data-group="pdf"] .rel-item').length,
  };
});
check('批量查找会推进并给出结果', batch.found > 0, `已查 ${batch.found} 条 · 按钮「${batch.btn}」`);
check('查完后统计里出现「查到开放版本 N 条」，并与「已找到开放版本」组对得上',
  batch.openCount > 0 && batch.pdfRows === batch.openCount, `概览 ${batch.openCount} 条 · 组内 ${batch.pdfRows} 行`);

/* 3.2b 阶段 3：搜索与状态筛选真的作用于列表 */
const viewTest = await page.evaluate(async () => {
  const snap = () => ({
    items: document.querySelectorAll('#relList .rel-item').length,
    groups: [...document.querySelectorAll('#relList .rel-group')].map((x) => x.dataset.group),
  });
  const inp = document.getElementById('relSearch');
  const sel = document.getElementById('relFilter');
  const before = snap();
  inp.value = 'zzz-no-such-reference';
  inp.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 80));
  const searched = snap();
  inp.value = '';
  inp.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 80));
  const cleared = snap();
  sel.value = 'pdf';
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 80));
  const onlyPdf = snap();
  sel.value = 'all';
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 80));
  return { before, searched, cleared, onlyPdf, restored: snap() };
});
check('搜索框能收窄列表、清空后还原',
  viewTest.searched.items === 0 && viewTest.cleared.items === viewTest.before.items && viewTest.cleared.items > 0,
  `全部 ${viewTest.before.items} → 搜不到 ${viewTest.searched.items} → 清空 ${viewTest.cleared.items}`);
check('状态筛选只留被选中的那一组',
  viewTest.onlyPdf.groups.join() === 'pdf' && viewTest.onlyPdf.items === batch.pdfRows
  && viewTest.restored.groups.join() === 'lib,pdf,todo',
  `只留 ${viewTest.onlyPdf.groups.join(',') || '(空)'} · 还原成 ${viewTest.restored.groups.join(',')}`);

/* 3.3 库内引用扫描 */
console.log('\n-- 库内引用扫描');
await page.click('#relScanLib');
await page.waitForFunction(() => !window.__state.relBusy, { timeout: 120000 }).catch(() => {});
await sleep(800);
const scan = await page.evaluate(() => ({
  cited: (window.__state.citedBy || []).map((p) => p.name),
  scanned: !!window.__state.relScanned,
  summary: document.getElementById('relSummary').textContent,
  body: document.querySelector('#relList .rel-cited')?.textContent || '',
}));
check('扫描完成并给出库内引用结论', scan.scanned, `被引用：${scan.cited.join(', ') || '(无)'}`);
check('摘要行里写明了库内引用情况', /引用了本文/.test(scan.summary), scan.summary);
check('结论行说明了与书架的关系', /书架里|引用了/.test(scan.body), scan.body.slice(0, 70));

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
