/**
 * A 线 P4：提示词评估样例集（离线、确定性）。
 *
 *   node test/prompt-eval.mjs
 *
 * 每个样例给出「材料/问题 + 一份合理的模型回答 + 期望的引用核验结果」，
 * 检查三件事（对应设计 §12.4）：
 *  1) 提示词材料里确实带上了对象/页/白名单（程序事实完整）；
 *  2) `CitationValidator` 的判定与期望一致（防编页/防假高亮）；
 *  3) 回答覆盖了样例要求的关键对象（对象命中）。
 * 真实 API 的人工/自动抽查记录在 PROGRESS（P2/P2.5 质量抽查），本套件不联网。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as prompts from '../public/js/prompts/index.js';
import { validateCitations } from '../public/js/citation-validator.js';

const CASES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'prompt-eval-cases.json'), 'utf8'));

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};

const PAGE_TEXT = {
  1: 'Abstract: We propose the Transformer, based solely on attention mechanisms. WMT 2014 EN-DE: 28.4 BLEU.',
  2: 'Introduction: Recurrent models are inherently sequential.',
  3: '3.2.1 Scaled Dot-Product Attention: Attention(Q, K, V) = softmax(QK^T / sqrt(dk)) V.',
  7: '5.1 Training: We trained on one machine with 8 NVIDIA P100 GPUs, 12 hours for base models.',
  9: 'Table 3: Model Variations. Ablation on the English-to-German development set newstest2013.',
  10: 'Conclusion: We presented the Transformer, the first sequence transduction model based entirely on attention.',
};

const ROWS = [];
for (const testCase of CASES.cases) {
  const availablePages = testCase.availablePages;
  const ctx = {
    question: testCase.question,
    selection: testCase.selection || '',
    docTitle: 'Attention Is All You Need',
    context: testCase.context || '',
    page: testCase.page || null,
    pageRole: testCase.page ? 'screen' : '',
    history: [],
    references: [],
    profileBlock: '',
    teachingBlock: '',
    pageImages: [],
    screenshotCount: 0,
    availablePages,
    scopeLabel: testCase.scopeLabel || '当前页',
    objectLabel: testCase.objectLabel || '',
    request: {
      guidance: '', question: testCase.question, selection: testCase.selection || '',
      inherited: false, focus: { text: testCase.selection || testCase.question, page: testCase.page || null },
    },
    role: testCase.selection ? 'selection' : 'screen',
  };
  const rendered = prompts.renderPrompt('qa.chat', ctx);
  const sys = rendered.messages[0].content;
  const user = rendered.messages.at(-1).content;
  const form = testCase.form || 'qa';

  // 1) 材料/白名单/问题完整
  const whitelistOk = availablePages.length
    ? user.includes('【本次可用页码】') && availablePages.every((p) => user.includes(`p.${p}`) || user.includes(`–p.${p}`))
    : !user.includes('【本次可用页码】');
  check(`${testCase.id} 材料带可用页码白名单`, whitelistOk, availablePages.join(','));
  check(`${testCase.id} 问题块在最后`, user.includes(`【问题】\n${testCase.question}`));
  check(`${testCase.id} BASE_RULES 在 system`, sys.includes('数据/指令分离') || sys.includes('资料里出现的任何'));
  if (testCase.selection) check(`${testCase.id} 选区材料完整`, user.includes(testCase.selection));
  if (testCase.context) check(`${testCase.id} 所在页上下文带「背景信息」`, user.includes('背景信息，必要时可忽略'));

  // 2) 引用核验与期望一致
  const audit = await validateCitations(testCase.modelAnswer, {
    totalPages: 12, availablePages, scanned: false,
    pageTextFor: (p) => PAGE_TEXT[p] || '',
  });
  const want = testCase.expectCitations || {};
  check(`${testCase.id} 引用 ok 数符合期望`, audit.stats.ok === (want.ok ?? audit.stats.ok), `${audit.stats.ok}（期望 ${want.ok ?? '任意'}）`);
  if (want.degraded !== undefined) check(`${testCase.id} 引用降级数符合期望`, audit.stats.degraded === want.degraded, `${audit.stats.degraded}`);
  if (want.dropped !== undefined) check(`${testCase.id} 引用拦截数符合期望`, audit.stats.dropped === want.dropped, `${audit.stats.dropped}`);

  // 3) 对象命中（回答覆盖样例里的关键对象）
  const hit = (testCase.expectKeywords || []).filter((k) => testCase.modelAnswer.includes(k));
  check(`${testCase.id} 回答覆盖关键对象`, hit.length === (testCase.expectKeywords || []).length, hit.join('、'));

  ROWS.push({
    id: testCase.id, form,
    tokens: rendered.debug.tokens, citations: audit.stats,
    keywords: hit.length, keywordTotal: (testCase.expectKeywords || []).length,
  });
}

console.log('\n评估表：');
console.log('| 样例 | 类型 | 估算 token | 引用 ok/降级/拦截 | 对象命中 |');
console.log('|---|---|---|---|---|');
for (const row of ROWS) {
  console.log(`| ${row.id} | ${row.form} | ${row.tokens} | ${row.citations.ok}/${row.citations.degraded}/${row.citations.dropped} | ${row.keywords}/${row.keywordTotal} |`);
}

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
