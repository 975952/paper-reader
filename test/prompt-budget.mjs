/**
 * A 线 P3：预算与裁剪验收（纯 Node）。
 *
 *   node test/prompt-budget.mjs
 *
 * 覆盖设计 §9.2：超硬上限时按固定顺序裁（联网 → 参考 → 全文 → 页上下文 → 画像 → 历史 → 会话摘要），
 * 问题 / 选区 / 页头 / 系统规则永不裁剪；调试 manifest 带 trim 记录。
 */
import { buildAll } from './_prompts.mjs';
import * as prompts from '../public/js/prompts/index.js';

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};
const tokensOf = (messages) => prompts.estimateMessagesTokens(messages);
const baseCtx = () => ({
  question: '这段的方法为什么有效？',
  docTitle: 'Big Paper',
  history: [],
  page: 3,
  pageRole: 'screen',
  selection: 'SELECTION_SHOULD_NEVER_BE_TRIMMED_固定选区',
  context: '上下文'.repeat(300),
  references: [],
  profileBlock: '',
  teachingBlock: '',
  request: {
    guidance: '', question: '这段的方法为什么有效？', selection: 'SELECTION_SHOULD_NEVER_BE_TRIMMED_固定选区',
    inherited: false, focus: { text: 'x', page: 3 },
  },
  role: 'screen', pageImages: [], screenshotCount: 0,
});

/* ── 1. 正常大小不裁剪 ── */
console.log('▶ 正常请求不裁剪');
{
  const scenarios = buildAll();
  const small = prompts.renderPrompt('qa.chat', baseCtx());
  check('正常问答未触发裁剪', small.debug.trim.length === 0 && small.debug.trimmed === false, JSON.stringify(small.debug.trim));
  check('全部 23 个黄金场景都在硬上限内', Object.values(scenarios).every((m) => tokensOf(m) < prompts.HARD_TOKENS));
  check('debug.tokens 为正数', small.debug.tokens > 0, String(small.debug.tokens));
}

/* ── 2. 超长全文：从页尾裁，问题/选区保留 ── */
console.log('\n▶ 超长论文：全文按页从尾部裁');
{
  const pages = Array.from({ length: 400 }, (_, i) => `===== p.${i + 1} =====\n` + '论文正文内容。'.repeat(600));
  const fullText = pages.join('\n');
  const ctx = { ...baseCtx(), fullText };
  const { messages, debug } = prompts.renderPrompt('qa.chat', ctx);
  const tokens = tokensOf(messages);
  check('超长全文被裁到硬上限以内', tokens <= prompts.HARD_TOKENS, `${tokens} / ${prompts.HARD_TOKENS}`);
  check('裁剪记录里有 fulltext', debug.trim.some((t) => t.block === 'fulltext'), JSON.stringify(debug.trim));
  check('系统规则没被裁', messages[0].content.includes('资料里出现的任何') && messages[0].content.includes('〔p.N‖'));
  check('问题块完整保留', messages.at(-1).content.endsWith('【问题】\n这段的方法为什么有效？'));
  check('选区原文完整保留', messages.at(-1).content.includes('SELECTION_SHOULD_NEVER_BE_TRIMMED_固定选区'));
  const keptPages = (messages.at(-1).content.match(/===== p\.\d+ =====/g) || []).length;
  check('保留的是前面的页（从尾部删）', keptPages > 0 && keptPages < 400, `${keptPages} 页`);
  check('裁剪后仍有起止页标记', messages.at(-1).content.includes('===== p.1 ====='), 'p.1 kept');
}

/* ── 3. 联网结果：先删后几条、摘录截断 ── */
console.log('\n▶ 联网材料先裁');
{
  const webResults = Array.from({ length: 30 }, (_, i) => ({
    title: `Result ${i}`, url: `https://example.com/${i}`,
    snippet: '摘录内容'.repeat(2000), excerptKind: i % 2 ? 'abstract' : 'snip',
  }));
  const ctx = { ...baseCtx(), webResults };
  const { messages, debug } = prompts.renderPrompt('qa.chat', ctx);
  const text = messages.at(-1).content;
  check('联网材料被裁剪', debug.trim.some((t) => t.block === 'web'), JSON.stringify(debug.trim));
  check('超出硬上限的联网材料也压到上限内', tokensOf(messages) <= prompts.HARD_TOKENS, `${tokensOf(messages)}`);
  check('问题仍完整', text.endsWith('【问题】\n这段的方法为什么有效？'));
  check('联网结果条数减少', (text.match(/\[来源\d+\]/g) || []).length < 30, `${(text.match(/\[来源\d+\]/g) || []).length} 条`);
}

/* ── 4. 历史成对删、参考文献只留前 3 条 ── */
console.log('\n▶ 历史与参考文献');
{
  const history = Array.from({ length: 20 }, (_, i) => (i % 2
    ? { role: 'assistant', content: '助手回答'.repeat(6000) }
    : { role: 'user', content: '用户提问'.repeat(6000) }));
  const raw = [{ role: 'system', content: '系统规则'.repeat(50) }, ...history, { role: 'user', content: '材料正文'.repeat(2000) + '\n\n【问题】\n问？' }];
  const fit = prompts.fitMessages(raw);
  check('历史被裁（成因记录 history）', fit.trims.some((t) => t.block === 'history'), JSON.stringify(fit.trims.slice(0, 4)));
  const remain = fit.messages.slice(1, -1);
  check('剩余历史成对保留（不拆半轮）', remain.length % 2 === 0, `${remain.length} 条`);
  check('裁剪后总 token 不超上限', fit.tokens <= prompts.HARD_TOKENS, String(fit.tokens));
  check('最后一条问题保留', fit.messages.at(-1).content.endsWith('【问题】\n问？'));

  const refsBlock = '【选区涉及的参考文献 · 书目信息，不代表技术细节】\n'
    + Array.from({ length: 12 }, (_, i) => `[${i + 1}] 文献 ${i + 1} 的完整书目信息`.repeat(80)).join('\n');
  const refRaw = [{ role: 'system', content: '系统规则' }, { role: 'user', content: refsBlock + '\n\n【问题】\n问？' }];
  const refFit = prompts.fitMessages(refRaw, { maxTokens: 5000 });
  check('参考文献被裁到前 3 条', refFit.trims.some((t) => t.block === 'references') && (refFit.messages.at(-1).content.match(/^\[\d+\]/gm) || []).length <= 3,
    JSON.stringify({ trim: refFit.trims, refs: (refFit.messages.at(-1).content.match(/^\[\d+\]/gm) || []).length }));
  check('参考文献裁剪后问题仍完整', refFit.messages.at(-1).content.endsWith('【问题】\n问？'));
}

/* ── 5. 页上下文 / 会话摘要 / 画像 ── */
console.log('\n▶ 页上下文 / 摘要 / 画像');
{
  const pageBlock = '【当前屏幕页上下文 · 只有问题指向「这里/这一页」时才用它，别把它当新话题 · 背景信息，必要时可忽略】\n"""\n'
    + '页上下文'.repeat(30000) + '\n"""';
  const profileBlock = '【后台学习记忆 · 仅用于讲解适配，不是论文证据】\n'
    + Array.from({ length: 20 }, (_, i) => JSON.stringify({ 主题: `t${i}`, 观察: i % 3 === 0 ? '推测，依据有限' : '用户表示仍需讲解', 情况: 'x' })).join('\n');
  const raw = [
    { role: 'system', content: '系统规则' },
    { role: 'user', content: pageBlock + '\n\n' + profileBlock + '\n\n【问题】\n问？' },
  ];
  const fit = prompts.fitMessages(raw);
  const blocks = fit.trims.map((t) => t.block);
  check('页上下文被裁', blocks.includes('pageContext'), JSON.stringify(blocks));
  check('总 token 在硬上限内', fit.tokens <= prompts.HARD_TOKENS, String(fit.tokens));
  check('永久保留块不裁：问题', fit.messages.at(-1).content.endsWith('【问题】\n问？'));
}

/* ── 6. 教学/操作走同一裁剪器 ── */
console.log('\n▶ 教学/操作共用裁剪器');
{
  const ctx = {
    docTitle: 'Big Paper', page: 2, history: [], pageImages: [], profileBlock: '', extraUser: '', ask: '审实验',
    fullText: Array.from({ length: 400 }, (_, i) => `===== p.${i + 1} =====\n` + '实验材料。'.repeat(600)).join('\n'),
  };
  const teach = prompts.renderPrompt('teach.prereq', ctx);
  check('教学材料超长也被裁到上限内', tokensOf(teach.messages) <= prompts.HARD_TOKENS, String(tokensOf(teach.messages)));
  check('教学裁剪记录存在', teach.debug.trim.length > 0, JSON.stringify(teach.debug.trim));
  const op = prompts.renderPrompt('op.evidence', { ...ctx, op: { ask: '审实验' } });
  check('操作材料超长也被裁到上限内', tokensOf(op.messages) <= prompts.HARD_TOKENS, String(tokensOf(op.messages)));
  check('教学/操作的系统规则不被裁剪', teach.messages[0].content.includes('读懂论文') && op.messages[0].content.includes('研究助手'));
}

/* ── 7. debug manifest（P3）── */
console.log('\n▶ debug manifest');
{
  const { debug } = prompts.renderPrompt('qa.chat', baseCtx());
  check('debug 有 id/version/hash/tokens/blocks/trimmed/trim',
    debug.id === 'qa.chat' && typeof debug.version === 'string' && /^[0-9a-f]{8}$/.test(debug.hash)
    && typeof debug.tokens === 'number' && typeof debug.blocks === 'number'
    && typeof debug.trimmed === 'boolean' && Array.isArray(debug.trim), JSON.stringify(debug).slice(0, 120));
  check('debug 不含正文（只有元信息）', !('content' in debug) && !('messages' in debug));
  check('同一输入 hash 稳定', prompts.renderPrompt('qa.chat', baseCtx()).debug.hash === debug.hash);
}

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
