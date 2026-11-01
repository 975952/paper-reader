/**
 * A 线 P1.5：引用核验器单测（纯 Node，不需要浏览器）。
 *
 *   node test/citation-validator.mjs
 *
 * 覆盖设计文档 §19.4 要求：编页码 / 越界 / 不在白名单 / 片段找不到 / 跨页 / 扫描件，
 * 并保证「无效引用 100% 被降级或拦截」。
 */
import assert from 'node:assert/strict';
import {
  parseCitations, normalizeMatchText, formatPageList, pagesFromText, pagesFromContexts,
  collectAvailablePages, validateCitations,
} from '../public/js/citation-validator.js';

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};

/* ── 1. 解析 ── */
console.log('▶ 引用解析');
{
  const text = '先说结论〔p.5‖这是原句〕，另见〔p.3〕与〔p.7–9｜另一句〕，最后〔p.12||半角竖线〕。';
  const list = parseCitations(text);
  check('解析出 4 条引用', list.length === 4, String(list.length));
  check('第一条：页码 + 片段', list[0].page === 5 && list[0].fragment === '这是原句');
  check('第二条：纯页码', list[1].page === 3 && list[1].fragment === '' && list[1].pageEnd === null);
  check('第三条：范围 + 全角竖线', list[2].page === 7 && list[2].pageEnd === 9 && list[2].fragment === '另一句');
  check('第四条：半角 || 也认', list[3].fragment === '半角竖线');
  check('普通文字不含引用时返回空', parseCitations('没有引用的一段话。').length === 0);
  check('raw 能精确回指原文', text.includes(list[0].raw));
}

/* ── 2. 归一化与页码集合 ── */
console.log('\n▶ 归一化与可用页码');
{
  check('空白/换行差异不影响匹配', normalizeMatchText('Multi-head\n  attention  allows') === normalizeMatchText('Multi-head attention allows'));
  check('中文全角空格被忽略', normalizeMatchText('注意　力') === normalizeMatchText('注意力'));
  check('页码标签被剥离', normalizeMatchText('[第5页] 原文') === normalizeMatchText('原文'));
  check('大小写不敏感', normalizeMatchText('Attention') === normalizeMatchText('attention'));
  check('页码切成区间', formatPageList([1, 2, 3, 5, 7, 8]) === 'p.1–p.3、p.5、p.7–p.8', formatPageList([1, 2, 3, 5, 7, 8]));
  check('单页', formatPageList([4]) === 'p.4');
  check('空集合', formatPageList([]) === '');
  check('从整篇文本取页号', [...pagesFromText('===== p.1 =====\na\n===== p.3 =====\nb')].join(',') === '1,3');
  check('从上下文段落取页号', [...pagesFromContexts(['[第2页]\n内容', '第 6 页'])].join(',') === '2,6');
  const avail = collectAvailablePages({
    fullText: '===== p.1 =====\na\n===== p.2 =====\nb',
    pageImages: [{ page: 7 }], contexts: ['[第3页]\nctx'], selectionPage: 4,
    focusPage: 4, currentPage: 5, references: [{ num: 1, page: 9 }],
  });
  check('白名单合并全部材料来源', avail.join(',') === '1,2,3,4,5,7,9', avail.join(','));
}

/* ── 3. 三档结果 ── */
console.log('\n▶ 三档结果');
const PAGE_TEXT = {
  1: 'Transformer 用自注意力替代循环。We propose the Transformer, based solely on attention mechanisms.',
  2: '第二页的内容：编码器把输入序列映射为连续表示。',
  3: '第三页：解码器逐位生成输出。',
  5: 'Multi-head attention allows the model to jointly attend to information from different representation subspaces.',
  6: '跨页第一段：attention 的计算方式如下。',
  7: '跨页第二段：继续到这里的句子。',
};
const pageTextFor = (p) => PAGE_TEXT[p] || '';
const run = (answer, opts = {}) => validateCitations(answer, {
  totalPages: 9, availablePages: [1, 2, 3, 5, 6, 7], pageTextFor, ...opts,
});

{
  const ok = await run('结论〔p.5‖Multi-head attention allows the model〕与〔p.3〕。');
  check('合法片段 → ok', ok.items[0].level === 'ok' && ok.items[0].match === 'fragment', JSON.stringify(ok.items[0]));
  check('纯页码在集合内 → ok', ok.items[1].level === 'ok');
  check('统计正确', ok.stats.total === 2 && ok.stats.ok === 2 && ok.stats.degraded === 0 && ok.stats.dropped === 0, JSON.stringify(ok.stats));

  const fabricated = await run('瞎编〔p.9〕。');
  check('编页码（不在白名单）→ drop', fabricated.items[0].level === 'drop', JSON.stringify(fabricated.items[0]));
  check('drop 的统计进 dropped', fabricated.stats.dropped === 1);

  const outOfRange = await run('越界〔p.99〕。');
  check('超出总页数 → drop', outOfRange.items[0].level === 'drop' && outOfRange.items[0].reason === 'out-of-range');

  const wrongPage = await run('片段在这页找不到〔p.2‖Multi-head attention allows the model〕。');
  check('页码对但片段找不到 → page-only', wrongPage.items[0].level === 'page-only' && wrongPage.items[0].reason === 'fragment-not-found', JSON.stringify(wrongPage.items[0]));

  const fakeFragment = await run('伪造原句〔p.5‖这句话论文里根本没有出现过xyz〕。');
  check('编造原文片段 → page-only（不画假高亮）', fakeFragment.items[0].level === 'page-only');

  const whitespace = await run('换行差异〔p.5‖Multi-head   attention\nallows the model〕。');
  check('空白差异仍算命中', whitespace.items[0].level === 'ok');

  const neighbor = await run('页码偏了一页〔p.3‖编码器把输入序列映射为连续表示〕。', { availablePages: [1, 2, 3, 4, 5] });
  check('±1 页容错：片段在相邻页 → ok', neighbor.items[0].level === 'ok');

  const crossPage = await run('跨页〔p.6‖跨页第一段：attention 的计算方式如下。跨页第二段：继续到这里的句子。〕。');
  check('跨页续画：本页+下一页拼起来能命中 → ok', crossPage.items[0].level === 'ok');

  const scan = await validateCitations('扫描件〔p.4‖看不清的手写内容〕。', {
    totalPages: 9, availablePages: [4], pageTextFor: () => '', scanned: true,
  });
  check('扫描件没有可核对文本 → page-only（只跳页）', scan.items[0].level === 'page-only' && scan.items[0].reason === 'scanned-no-text');

  const scanHit = await validateCitations('扫描件〔p.4‖转写出来的原文〕。', {
    totalPages: 9, availablePages: [4], scanned: true,
    pageTextFor: (p) => (p === 4 ? '【扫描件图片阅读索引】转写出来的原文' : ''),
  });
  check('扫描件走图片阅读索引转写核对 → ok', scanHit.items[0].level === 'ok');

  const range = await run('范围引用〔p.1–2‖连续内容〕。');
  check('范围引用逐页检查白名单', range.items[0].level === 'page-only' || range.items[0].level === 'ok');
  const rangeOut = await run('范围越界〔p.2–9〕。');
  check('范围内有页不在白名单 → drop', rangeOut.items[0].level === 'drop');
}

/* ── 4. 无效引用 100% 被降级或拦截 ── */
console.log('\n▶ 无效引用 100% 降级/拦截');
{
  const cases = [
    '〔p.99〕', '〔p.0〕', '〔p.4〕',                       // 越界 / 非法 / 不在白名单
    '〔p.2‖这句不在第二页〕', '〔p.5‖编造的片段xyz〕',
  ];
  let intercepted = 0;
  for (const c of cases) {
    const r = await validateCitations(c, { totalPages: 9, availablePages: [1, 2, 3, 5, 6, 7], pageTextFor });
    if (r.items[0].level === 'drop' || r.items[0].level === 'page-only') intercepted++;
  }
  check('全部无效引用被降级或拦截', intercepted === cases.length, `${intercepted}/${cases.length}`);
}

/* ── 5. plan 渲染查表 ── */
console.log('\n▶ plan 查表');
{
  const r = await run('〔p.5‖Multi-head attention allows the model〕〔p.99〕〔p.2‖不存在〕');
  check('plan 按 raw 能查到 ok 项', r.plan.get('〔p.5‖Multi-head attention allows the model〕')?.level === 'ok');
  check('plan 有 drop 项', [...r.plan.values()].some((x) => x.level === 'drop'));
  check('统计与 items 一致', r.stats.total === r.items.length);
}

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
