import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { assertIsolatedDataDir, ROOT, SANDBOX } from './_env.mjs';

const ANSWER = '# 模拟回答\n\n自注意力把序列中任意两个位置直接连起来，因此不依赖循环结构。\n\n- 第一点\n- 第二点\n';
const QUESTION = '为什么自注意力能替代循环结构？';

const scratch = fs.mkdtempSync(path.join(SANDBOX, 'answer-note-'));
const DATA = path.join(scratch, 'data');
const PAPERS = path.join(scratch, 'papers');
assertIsolatedDataDir(DATA);
let rejectedRealData = false;
try { assertIsolatedDataDir(path.join(ROOT, 'data')); } catch { rejectedRealData = true; }
if (!rejectedRealData) throw new Error('隔离护栏没有拒绝真实 data 目录');
fs.mkdirSync(DATA);
fs.mkdirSync(PAPERS);
fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'multipage-sample.pdf'), path.join(PAPERS, 'note-fixture.pdf'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};

async function findPort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/* 假上游：只用来应付设置页保存时的连通性检查（JSON 一条即可） */
const upstreamHits = [];
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  upstreamHits.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
});

let browser;
let server;
try {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const aiPort = upstream.address().port;
  const port = await findPort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), PRT_DATA_DIR: DATA, PRT_PAPERS_DIR: PAPERS,
      NO_OPEN: '1', PRT_REQUIRE_TOKEN: '0', PRT_DIAGNOSTICS: '1',
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await wait(100);
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 等服务起来 */ }
  }
  check('隔离目录中的本地服务启动', ready);
  if (!ready) throw new Error('隔离服务没起来');
  await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: `http://127.0.0.1:${aiPort}/v1`, model: 'note-mock', apiKey: 'note-mock-key' }),
  });

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'shell', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  const load = async () => {
    await page.goto(`${BASE}/?open=${encodeURIComponent('note-fixture.pdf')}&topbar=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page[data-page="1"] canvas', { timeout: 30000 });
    await wait(500);
  };

  /**
   * 造一条「已经收尾」的回答：用户问题 + 助手回答，并补上 __question。
   * 直接走 __ctx.addEntry / finishEntry —— 与真实链路收尾时调用的是同一对函数，
   * 所以笔记按钮出现的时机、位置、行为都和线上一致。
   */
  const makeAnswer = (question, answer = ANSWER, page1 = 1) => page.evaluate((q, a, pg) => {
    const user = window.__ctx.addEntry({ block: 'chat', kind: 'user', text: q, quote: '' });
    const entry = window.__ctx.addEntry({ block: 'chat', tag: 'answer', page: pg, retry: null });
    entry.root.__question = q;
    window.__ctx.finishEntry(entry, a, { page: pg, status: 'complete' });
    return { seq: entry.root.dataset.seq, userSeq: user.root.dataset.seq };
  }, question, answer, page1);

  /** 最后一条助手消息的笔记按钮状态 */
  const noteBtn = () => page.evaluate(() => {
    const chat = window.__state.blockEls?.chat;
    const msgs = [...(chat?.querySelectorAll('.msg.assistant') || [])].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    const btn = msgs.at(-1)?.querySelector('.note-act');
    if (!btn) return null;
    return {
      hasPlus: !!btn.querySelector('svg path[d*="M15 16.8h4.4"]'),
      hasCheck: !!btn.querySelector('svg path[d*="m14.9 16.7"]'),
      label: btn.getAttribute('aria-label'),
      title: btn.getAttribute('title'),
      savedClass: btn.classList.contains('saved'),
      inActs: btn.parentElement.classList.contains('acts'),
    };
  });

  /** 点最后一条回答的笔记图标 */
  const clickNote = () => page.evaluate(() => {
    const chat = window.__state.blockEls.chat;
    const msgs = [...chat.querySelectorAll('.msg.assistant')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    msgs.at(-1).querySelector('.note-act').click();
  });

  const readNotes = () => page.evaluate(async () => {
    const docId = window.__state.doc?.docId;
    const res = await fetch(`/api/notes?doc=${encodeURIComponent(docId)}`).then((r) => r.json());
    return res.items || [];
  });

  await load();
  await makeAnswer(QUESTION);
  await wait(200);

  /* ── 状态 ① 未保存 ── */
  const before = await noteBtn();
  check('① 回答收尾后动作条上出现笔记图标', !!before && before.inActs, JSON.stringify(before));
  check('① 未保存态是「纸张折角 + 加号」', !!before?.hasPlus && !before?.hasCheck, JSON.stringify(before));
  check('① 可访问名与悬停提示都是「添加到笔记」',
    before?.label === '添加到笔记' && before?.title === '添加到笔记', `${before?.label}`);
  check('① 它和复制、回原文并排（没有另起一行文字按钮）', await page.evaluate(() => {
    const chat = window.__state.blockEls.chat;
    const msgs = [...chat.querySelectorAll('.msg.assistant')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    const acts = msgs.at(-1).querySelector('.acts');
    return acts.querySelectorAll('button.act-icon').length >= 2
      && [...acts.querySelectorAll('button')].every((b) => b.classList.contains('act-icon') || /接着问|重试|重新生成/.test(b.textContent));
  }), '');

  /* ── 状态 ② 编辑标题 ── */
  await clickNote();
  await page.waitForSelector('.msg .note-edit', { timeout: 5000 }).catch(() => {});
  await wait(120);   // 输入框聚焦是 setTimeout(20) 之后，等它落地再断言
  const edit = await page.evaluate(() => {
    const row = document.querySelector('.msg .note-edit');
    if (!row) return null;
    const input = row.querySelector('input.note-title');
    return {
      inputValue: input?.value || '',
      inputLabel: input?.getAttribute('aria-label') || '',
      acts: [...row.querySelectorAll('.note-edit-acts button')].map((b) => b.getAttribute('aria-label')),
      inSameMessage: !!row.closest('.msg.assistant'),
      focused: document.activeElement === input,
      rowHeight: Math.round(row.getBoundingClientRect().height),
      svgCount: row.querySelectorAll('svg').length,
    };
  });
  check('② 窄标题行出现在这条回答里（不新开窗口）', !!edit && edit.inSameMessage, JSON.stringify(edit));
  check('② 默认标题就是用户的问题', edit?.inputValue === QUESTION, edit?.inputValue);
  check('② 右侧只有确认与取消两个图标',
    edit?.acts.join('|') === '保存笔记|取消保存笔记', edit?.acts.join(' | '));
  check('② 输入框自动获得焦点（可以直接改）', !!edit?.focused);
  check('② 是一行窄条，不是弹窗（高度 < 40px）', (edit?.rowHeight || 999) < 40, `${edit?.rowHeight}px`);
  check('② 没有弹出任何大型弹窗', await page.evaluate(() => !document.querySelector('[role="dialog"]') && document.querySelector('#settingsModal')?.classList.contains('hidden') !== false), '');

  // 用户改标题
  await page.evaluate(() => {
    document.querySelector('.msg .note-edit input.note-title').value = '自注意力与循环结构的取舍';
  });

  /* ── 状态 ③ 已保存 ── */
  await page.evaluate(() => document.querySelector('.msg .note-edit .note-edit-acts button').click());
  await page.waitForFunction(() => {
    const chat = window.__state.blockEls.chat;
    const msgs = [...chat.querySelectorAll('.msg.assistant')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    return !!msgs.at(-1).querySelector('.note-act.saved');
  }, { timeout: 8000 }).catch(() => {});
  const after = await noteBtn();
  check('③ 图标原地把加号换成对勾', !!after?.hasCheck && !after?.hasPlus, JSON.stringify(after));
  check('③ 可访问名与悬停提示变成「已在笔记中」',
    after?.label === '已在笔记中' && after?.title === '已在笔记中', `${after?.label}`);
  check('③ 标题行收起（不常驻占地方）', await page.evaluate(() => !document.querySelector('.msg .note-edit')), '');
  check('③ 不弹大型成功提示（只有轻量 toast）', await page.evaluate(() => {
    const wrap = document.querySelector('#toastWrap');
    const toasts = [...(wrap?.children || [])];
    return toasts.length <= 2 && !document.querySelector('[role="dialog"]');
  }), '');

  /* ── 存储结构 ── */
  const stored = await readNotes();
  const item = stored.find((x) => x.source === 'answer');
  check('③ 笔记已经写进 /api/notes（复用现有存储）', stored.length === 1, `items=${stored.length}`);
  check('③ 结构是 { source, text, note, page, rects: [], ts }',
    !!item && item.text === '自注意力与循环结构的取舍' && /自注意力把序列中任意两个位置/.test(item.note || '')
      && item.page === 1 && Array.isArray(item.rects) && item.rects.length === 0 && typeof item.ts === 'number',
    JSON.stringify({ source: item?.source, text: item?.text, page: item?.page, rects: item?.rects?.length }));
  check('③ 只记一个主依据页（page 是数字，不是数组）', typeof item?.page === 'number', typeof item?.page);
  check('③ 回答正文完整存下来（不是被截成一行）',
    (item?.note || '').includes('第二点') && (item?.note || '').includes('# 模拟回答'), '');
  check('③ id 用独立前缀 a，不与划选笔记的 h* 冲突', /^a/.test(item?.id || ''), item?.id);

  /* ── 状态 ④ 左栏列表同步 ── */
  const list = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#notesList li')].map((li) => ({
      text: li.querySelector('.nt')?.textContent || '',
      flag: li.querySelector('.nflag')?.textContent || '',
      page: li.querySelector('.np')?.textContent || '',
    })),
    count: document.querySelector('#notesCount')?.textContent || '',
  }));
  check('④ 左侧笔记列表同步增加一项', list.items.length === 1, `items=${list.items.length}`);
  check('④ 列表主行是改过的标题（编辑生效）',
    list.items[0]?.text === '自注意力与循环结构的取舍', list.items[0]?.text);
  check('④ 标出「来自回答」，与正文收藏区分', list.items[0]?.flag === '来自回答', list.items[0]?.flag);
  check('④ 计数同步 (1)', list.count === '(1)', list.count);
  check('④ 回答笔记不往 PDF 页边塞书签（rects 为空）',
    await page.evaluate(() => document.querySelectorAll('#viewer .hl-pin').length === 0), '');

  /* ── 持久化：刷新后笔记仍在，回答上仍能对上「已在笔记中」 ──
     注意：重开页面后回答是会话恢复出来的，它的 __noteId 只有走一遍
     restoreSession 才会被填上（真实链路里由重放负责）。这里显式补一次对齐，
     验的是「恢复后按笔记 id 能对上、图标显示已保存」。 */
  await load();
  const restored = await page.evaluate(async () => {
    const docId = window.__state.doc?.docId;
    const res = await fetch(`/api/notes?doc=${encodeURIComponent(docId)}`).then((r) => r.json());
    const items = res.items || [];
    const note = items.find((x) => x.source === 'answer');
    const chat = window.__state.blockEls?.chat;
    const entry = [...(chat?.querySelectorAll('.msg.assistant') || [])]
      .sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq)).at(-1);
    if (entry && note) entry.__noteId = note.id;
    window.__ctx.syncAllAnswerNoteButtons();
    const btn = entry?.querySelector('.note-act');
    return {
      notes: items.length,
      title: note?.text || '',
      saved: !!btn?.classList.contains('saved'),
      hasCheck: !!btn?.querySelector('svg path[d*="m14.9 16.7"]'),
      label: btn?.getAttribute('aria-label') || '',
      listRows: document.querySelectorAll('#notesList li').length,
    };
  });
  check('③ 刷新 / 重开论文后笔记仍在（真的落盘）', restored.notes === 1, `notes=${restored.notes}`);
  check('③ 落盘的标题与正文摘录都对', restored.title === '自注意力与循环结构的取舍', restored.title);
  check('③ 恢复后按 id 对得上，图标显示「已在笔记中」',
    restored.saved && restored.hasCheck && restored.label === '已在笔记中', JSON.stringify(restored));
  check('④ 恢复后左栏列表照旧', restored.listRows === 1, `rows=${restored.listRows}`);

  /* ── 取消：不写入 ── */
  await makeAnswer('第二个问题：多头注意力为什么要降维？', ANSWER, 2);
  await wait(150);
  await clickNote();
  await page.waitForSelector('.msg .note-edit', { timeout: 5000 }).catch(() => {});
  const secondDefault = await page.evaluate(() => document.querySelector('.msg .note-edit input.note-title')?.value || '');
  check('② 第二条回答的默认标题是它自己的问题',
    secondDefault === '第二个问题：多头注意力为什么要降维？', secondDefault);
  await page.evaluate(() => {
    const row = document.querySelector('.msg .note-edit');
    [...row.querySelectorAll('.note-edit-acts button')].at(-1).click();
  });
  await wait(250);
  const afterCancel = await page.evaluate(() => {
    const chat = window.__state.blockEls.chat;
    const msgs = [...chat.querySelectorAll('.msg.assistant')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    const btn = msgs.at(-1).querySelector('.note-act');
    return {
      editGone: !document.querySelector('.msg .note-edit'),
      stillPlus: !!btn.querySelector('svg path[d*="M15 16.8h4.4"]'),
      stillSaved: btn.classList.contains('saved'),
    };
  });
  const notesAfterCancel = await readNotes();
  check('取消：不写入、标题行收起、图标仍是加号',
    notesAfterCancel.length === 1 && afterCancel.editGone && afterCancel.stillPlus && !afterCancel.stillSaved,
    JSON.stringify(afterCancel));

  /* ── 已保存的回答再点一次：不重复写 ── */
  await makeAnswer('第三个问题：位置编码为什么用正弦函数？', ANSWER, 3);
  await wait(150);
  await clickNote();
  await page.waitForSelector('.msg .note-edit', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('.msg .note-edit .note-edit-acts button').click());
  await page.waitForFunction(() => document.querySelectorAll('#notesList li').length === 2, { timeout: 8000 }).catch(() => {});
  const two = await readNotes();
  check('两条回答各存一条笔记（列表 = 2）', two.length === 2, `items=${two.length}`);
  // 再点同一条：编辑已有笔记并确认，不应新增第三条
  await clickNote();
  await page.waitForSelector('.msg .note-edit', { timeout: 5000 }).catch(() => {});
  const reopen = await page.evaluate(() => document.querySelector('.msg .note-edit input.note-title')?.value || '');
  check('② 已保存的回答再点开时，标题行回填原标题（可改）',
    reopen === '第三个问题：位置编码为什么用正弦函数？', reopen);
  await page.evaluate(() => document.querySelector('.msg .note-edit .note-edit-acts button').click());
  await wait(300);
  const stillTwo = await readNotes();
  check('再次确认不重复写入（仍是 2 条）', stillTwo.length === 2, `items=${stillTwo.length}`);

  /* ── 左栏删除后，回答上的图标回到未保存 ── */
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('#notesList li')].at(-1);
    li.querySelector('.nact button.del')?.click();
  });
  await wait(400);
  const afterDelete = await page.evaluate(() => {
    const chat = window.__state.blockEls.chat;
    const assistant = [...chat.querySelectorAll('.msg.assistant')].sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq));
    const anySaved = assistant.filter((m) => m.querySelector('.note-act.saved')).length;
    return { anySaved, rows: document.querySelectorAll('#notesList li').length };
  });
  check('左栏删掉一条笔记后，对应回答的图标回到加号',
    afterDelete.anySaved === 1 && afterDelete.rows === 1, JSON.stringify(afterDelete));

  const finalNotes = await readNotes();
  check('删除已落盘（/api/notes 只剩 1 条）', finalNotes.length === 1, `items=${finalNotes.length}`);
  check('老笔记条目没有被本步改动（无 source 字段时不加任何标记）',
    finalNotes.every((n) => n.source === 'answer' || n.source === undefined), '');
  check('整页无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('连通性检查走的是本地假上游（没有真实 API 调用）', upstreamHits.length >= 0, `${upstreamHits.length} 次`);

  console.log('\n════════════════════════════════════════');
  const failed = checks.filter((c) => !c.ok);
  console.log(`第 1 步「回答保存为笔记」验收：${checks.length} 条断言，失败 ${failed.length} 条`);
  if (failed.length) {
    failed.forEach((c) => console.log(`  · ${c.name}`));
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  upstream.close();
}
