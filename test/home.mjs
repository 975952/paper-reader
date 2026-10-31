import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, resolveDataDir } from './_env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8971';
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const TOKEN = process.env.PRT_API_TOKEN || '';

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = TOKEN ? { 'Content-Type': 'application/json', 'X-PRT-Token': TOKEN } : { 'Content-Type': 'application/json' };
const api = (path, opts = {}) => fetch(`${BASE}${path}`, { headers: H, ...opts });

const papersInfo = await api('/api/papers').then((r) => r.json()).catch(() => ({ papers: [] }));
assertIsolatedDataDir(resolveDataDir(papersInfo.dir));
const papers = papersInfo.papers || [];
if (!papers.length) { console.error('隔离书架是空的 —— 先把 test/fixtures/*.pdf 拷进去'); process.exit(2); }
console.log(`服务    : ${BASE}`);
console.log(`隔离目录: ${papersInfo.dir}`);
console.log(`书架    : ${papers.map((p) => p.name).join(', ')}\n`);

const setState = (patch) => api('/api/state', { method: 'POST', body: JSON.stringify(patch) });
const getState = () => api('/api/state').then((r) => r.json());
const clearAll = async () => { await setState({ docs: {}, lastDoc: null, lastUrl: null, lastName: null }); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1400, height: 900 },
});

const open = async (query = '') => {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
  await sleep(2600);
  return { page, errs };
};

/**
 * ⚠️ 不能读 `window.__ctx.state` —— 那个对象没有导出 state（只导出了函数与常量）。
 * 判断「打开了哪一篇」要用 DOM 上的可观测信号：#docName（顶栏标题）
 * 与 #fileList li.active（左栏当前项）。
 */
const view = (page) => page.evaluate(() => {
  const vis = (s) => { const n = document.querySelector(s); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const activeLi = document.querySelector('#fileList li.active');
  return {
    reading: document.body.classList.contains('reading'),
    homeVisible: vis('#home'),
    viewerVisible: vis('#viewer'),
    docName: (document.getElementById('docName')?.textContent || '').trim(),
    activeDocId: activeLi?.dataset.id || null,
    pageCount: (document.getElementById('pageCount')?.textContent || '').trim(),
    aiBarVisible: vis('#aiBar'),
    continueCards: document.querySelectorAll('#homeContinueWrap .home-continue').length,
    continueText: document.querySelector('#homeContinueWrap .home-continue')?.innerText?.replace(/\s+/g, ' ').trim() || '',
    items: [...document.querySelectorAll('#homeList .home-item')].map((li) => ({
      id: li.dataset.id,
      text: li.querySelector('.hi-name')?.textContent || '',
      meta: li.querySelector('.hi-meta')?.textContent || '',
      hasX: !!li.querySelector('.home-item-x'),
    })),
    emptyText: document.querySelector('#homeList .home-empty')?.innerText?.replace(/\s+/g, ' ').trim() || '',
    openBtn: !!document.querySelector('#homeOpen'),
    dropZone: !!document.querySelector('#homeDrop'),
    statusbar: document.querySelectorAll('.statusbar').length,
    pageLabel: document.querySelector('#pageInput')?.value,
  };
});

/* ═══ A1 首次启动、没有阅读记录 ═══ */
console.log('A1 首次启动、没有阅读记录');
{
  await clearAll();
  const { page, errs } = await open();
  const v = await view(page);
  check('停在首页（不是阅读态）', !v.reading && v.homeVisible, `reading=${v.reading} home=${v.homeVisible}`);
  check('两个入口都在', v.openBtn && v.dropZone);
  check('没有继续阅读卡片', v.continueCards === 0, `cards=${v.continueCards}`);
  check('状态栏已删除', v.statusbar === 0, `statusbar=${v.statusbar}`);
  check('没有阅读记录时给出空态文案', /还没有阅读记录|还没有论文/.test(v.emptyText), JSON.stringify(v.emptyText));
  check('零页面报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.close();
}

/* ═══ A2 有论文但没有阅读记录 ═══ */
console.log('\nA2 有论文、state.json 空');
{
  await clearAll();
  const { page, errs } = await open();
  const v = await view(page);
  check('停在首页', !v.reading && v.homeVisible);
  check('没有继续阅读卡片', v.continueCards === 0);
  check('阅读记录为空 → 列表是空态（不是列出全部论文）', v.items.length === 0 && !!v.emptyText,
    `items=${v.items.length} empty=${JSON.stringify(v.emptyText)}`);
  check('零页面报错', errs.length === 0);
  await page.close();
}

/* ═══ A3 + A4 ═══ */
console.log('\nA3 有最近论文 + A4 普通启动不自动打开');
{
  const p0 = papers.find((p) => /multipage/i.test(p.name)) || papers[0];
  const wantPage = 5;
  await setState({
    docs: { [p0.docId]: { page: wantPage, scale: 1, fit: true, ts: Date.now() - 3600_000, name: p0.name } },
    lastDoc: p0.docId, lastUrl: p0.url, lastName: p0.name,
  });
  const { page, errs } = await open();
  const v = await view(page);
  check('A4 普通启动**没有**自动进入上次论文', !v.reading && !v.activeDocId,
    `reading=${v.reading} activeDoc=${v.activeDocId}`);
  check('A4 停在首页且首页可见', v.homeVisible);
  check('A3 出现继续阅读卡片', v.continueCards === 1, `cards=${v.continueCards}`);
  check('A3 卡片显示文件名与页码', v.continueText.includes(p0.name.replace(/\.pdf$/i, '')) && v.continueText.includes(`第 ${wantPage} 页`),
    JSON.stringify(v.continueText));
  check('A3 最近列表有这一条且带页码', v.items.length === 1 && new RegExp(`第 ${wantPage} 页`).test(v.items[0].meta),
    JSON.stringify(v.items));
  check('每条记录带「移除」按钮', v.items[0]?.hasX === true);
  check('零页面报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  /* ═══ A5 点「继续阅读」才进入，且恢复页码 ═══ */
  console.log('\nA5 点「继续阅读」才进入阅读页');
  await page.click('#homeContinueWrap .home-continue');
  await sleep(4500);
  const v5 = await view(page);
  check('进入阅读态', v5.reading && !v5.homeVisible, `reading=${v5.reading} home=${v5.homeVisible}`);
  check('打开了正确的那篇论文', v5.docName === p0.name && v5.activeDocId === p0.docId,
    `docName=${v5.docName} activeDocId=${v5.activeDocId}`);
  check('恢复到记录里的页码', String(v5.pageLabel) === String(wantPage),
    `pageInput=${v5.pageLabel} 期望=${wantPage} 总页=${v5.pageCount}`);
  check('零页面报错', errs.length === 0);
  await page.close();
}

/* ═══ A6 带 ?open= 直接进阅读页 ═══ */
console.log('\nA6 带 ?open= 启动直接进阅读页');
{
  await clearAll();
  const { page, errs } = await open(`?open=${encodeURIComponent(papers[0].name)}`);
  const v = await view(page);
  check('直接进入阅读态（不在首页停留）', v.reading && !v.homeVisible, `reading=${v.reading} home=${v.homeVisible}`);
  check('打开了指定的那篇', v.docName === papers[0].name, v.docName);
  check('零页面报错', errs.length === 0);
  await page.close();
}

/* ═══ A7 从首页列表进入阅读页 ═══ */
console.log('\nA7 从首页列表进入阅读页（等价于双击 PDF）');
{
  const p1 = papers[papers.length - 1];
  await setState({
    docs: { [p1.docId]: { page: 2, scale: 1, fit: true, ts: Date.now() - 7200_000, name: p1.name } },
    lastDoc: p1.docId, lastUrl: p1.url, lastName: p1.name,
  });
  const { page, errs } = await open();
  const before = await view(page);
  check('首页列出了这篇', before.items.some((i) => i.id === p1.docId), JSON.stringify(before.items));
  await page.click('#homeList .home-item-go');
  await sleep(4500);
  const v = await view(page);
  check('进入阅读态并打开正确论文', v.reading && v.docName === p1.name, `reading=${v.reading} docName=${v.docName}`);
  check('零页面报错', errs.length === 0);
  await page.close();
}

/* ═══ A8 文件已删除 + 移除最近记录 ═══ */
console.log('\nA8 最近文件已被移动/删除 + 移除最近记录');
{
  const real = papers[0];
  await setState({
    docs: {
      [real.docId]: { page: 3, scale: 1, fit: true, ts: Date.now(), name: real.name },
      'ghost-docid-0000': { page: 9, scale: 1, fit: true, ts: Date.now() - 1000, name: 'deleted-paper.pdf' },
    },
    lastDoc: 'ghost-docid-0000', lastUrl: '/api/pdf?name=deleted-paper.pdf', lastName: 'deleted-paper.pdf',
  });
  const { page, errs } = await open();
  const v = await view(page);
  check('已失效的记录不出现在首页', !v.items.some((i) => i.id === 'ghost-docid-0000'),
    JSON.stringify(v.items.map((i) => i.id)));
  check('继续阅读不指向失效记录', !v.continueText.includes('deleted-paper'), JSON.stringify(v.continueText));
  check('其余有效记录照常显示', v.items.some((i) => i.id === real.docId));
  const st = await getState();
  check('失效记录已被清出 state.json', !st.docs?.['ghost-docid-0000'], JSON.stringify(Object.keys(st.docs || {})));

  const target = real.docId;
  await page.click('#homeList .home-item-x');
  await sleep(1400);
  const st2 = await getState();
  check('点「×」后该记录从 state.json 消失', !st2.docs?.[target], JSON.stringify(Object.keys(st2.docs || {})));
  const stillThere = papers.some((p) => p.docId === target);
  check('**papers/ 里的文件没有被删除**（只移除记录）', stillThere);
  const v2 = await view(page);
  check('列表随之更新', !v2.items.some((i) => i.id === target), JSON.stringify(v2.items.map((i) => i.id)));
  check('零页面报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.close();
}

console.log('\n右栏布局：切换器在顶部、结果块无标题栏');
{
  await clearAll();
  const { page, errs } = await open(`?open=${encodeURIComponent(papers[0].name)}`);
  const r = await page.evaluate(() => {
    const bar = document.querySelector('#aiBar');
    const area = document.querySelector('#aiArea');
    const right = document.querySelector('#rightSide');
    if (!bar || !right) return { bar: 'MISSING' };
    return {
      barIsFirstChild: right.firstElementChild === bar,
      rightChildren: [...right.children].map((n) => n.id || n.className),
      buttons: [...bar.querySelectorAll('.aibar-btn')].map((b) => b.textContent.trim()),
      aiHeadCount: document.querySelectorAll('#aiArea .ai-head').length,
      blockCount: document.querySelectorAll('#aiArea .ai-block').length,
      barTop: Math.round(bar.getBoundingClientRect().top),
      areaTop: Math.round(area.getBoundingClientRect().top),
    };
  });
  check('切换器是右栏第一个元素（在最上面）', r.barIsFirstChild === true, JSON.stringify(r.rightChildren));
  check('切换器在结果区上方', r.barTop <= r.areaTop, `barTop=${r.barTop} areaTop=${r.areaTop}`);
  check('切换器有「译文 / 问答」两个按钮', Array.isArray(r.buttons) && r.buttons.length === 2, JSON.stringify(r.buttons));
  check('结果块里不再有标题栏 .ai-head', r.aiHeadCount === 0, `count=${r.aiHeadCount}`);
  check('零页面报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log('  - ' + r.n);
}
process.exit(passed === results.length ? 0 : 1);
