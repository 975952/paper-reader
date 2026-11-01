/**
 * A 线 P1 提示词黄金快照 + 注册表契约。
 *
 *   node test/prompts.mjs
 *
 * 1) 24 个真实场景的 messages 必须与 P0 基线（test/fixtures/prompts-baseline.json）逐字节一致；
 * 2) 所有 PromptDef 已注册、版本是 semver、manifest 与注册表一致；
 * 3) 保留标记（假上游按子串识别）仍在对应提示词里；
 * 4) 预算/裁剪顺序是固定常量；估算器 CJK/拉丁行为正确；
 * 5) 兼容壳导出签名不变（ai.js / teaching.js / ops.js）。
 *
 * 纯 Node、零依赖、不碰浏览器/网络/data/。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAll, FIXED_NOW } from './_prompts.mjs';
import * as prompts from '../public/js/prompts/index.js';
import * as ai from '../public/js/ai.js';
import * as teaching from '../public/js/teaching.js';
import * as ops from '../public/js/ops.js';
import { PROFILE_RULES } from '../public/js/prompts/memory.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'prompts-baseline.json');
const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let pass = 0;
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};
const failures = [];

/* ── 1. 黄金快照：逐字节 ── */
console.log(`▶ 黄金快照（P0 基线：${baseline.scenarios} 场景，固定时间 ${baseline.fixedNow}）`);
const actual = buildAll();
const names = Object.keys(baseline.messages);
check('场景数量一致', Object.keys(actual).length === names.length, `${Object.keys(actual).length}/${names.length}`);
for (const name of names) {
  const want = JSON.stringify(baseline.messages[name]);
  const got = JSON.stringify(actual[name]);
  if (want === got) { check(`逐字节一致 · ${name}`, true); continue; }
  // 找出第一个不同的位置，方便定位文案漂移
  let i = 0;
  while (i < Math.min(want.length, got.length) && want[i] === got[i]) i++;
  check(`逐字节一致 · ${name}`, false, `第 ${i} 字符起不同：want…${want.slice(Math.max(0, i - 40), i + 60)} / got…${got.slice(Math.max(0, i - 40), i + 60)}`);
}

/* ── 2. 注册表与 manifest ── */
console.log('\n▶ 注册表');
const ids = prompts.listPrompts();
check('PromptDef 数量 ≥ 12', ids.length >= 12, `${ids.length} 个`);
check('manifest 与注册表一致', JSON.stringify(prompts.getManifest()) === JSON.stringify(
  Object.fromEntries(Object.entries(prompts.PROMPT_MANIFEST).sort(([a], [b]) => a.localeCompare(b))),
), JSON.stringify(prompts.PROMPT_MANIFEST));
for (const id of ids) {
  const def = prompts.getPromptDef(id);
  check(`${id} 版本是 semver`, /^\d+\.\d+\.\d+$/.test(def.version), def.version);
  check(`${id} 有 system/user`, Array.isArray(def.system) && typeof def.user === 'function');
}
// 设计文档 §5 的目录至少都在
for (const want of ['qa.chat', 'qa.explain', 'translate.selection', 'teach.intro', 'teach.prereq',
  'teach.walk', 'teach.visual', 'teach.walk.continue', 'teach.walk.reteach', 'teach.prereq.one',
  'teach.condense', 'op.evidence', 'op.limits', 'bg.digest', 'bg.sessionSummary',
  'bg.scan.transcribe', 'bg.memory.extract']) {
  check(`目录包含 ${want}`, ids.includes(want));
}
check('PROMPT_SYSTEM_VERSION 形如 2026.11.x', /^2026\.11\.\d+$/.test(prompts.PROMPT_SYSTEM_VERSION), prompts.PROMPT_SYSTEM_VERSION);

/* ── 3. 保留标记（假上游识别用，见设计 §17.2） ── */
console.log('\n▶ 保留标记');
const markerCtx = {
  targetLang: '中文', text: 'x', page: 1, docTitle: 't', digest: 'd', fullText: 'f',
  question: 'q', answer: 'a', profile: null, payload: {}, previous: '', turns: '',
  op: { ask: 'a' }, history: [], pageImages: [], profileBlock: '', extraUser: '', extra: '',
  role: 'screen', screenshotCount: 0, teachingBlock: '', references: [],
  request: {
    guidance: '', question: 'q', selection: '', inherited: false,
    focus: { text: 'q', page: 1, kind: 'question', source: '' }, intent: 'question',
  },
};
const allText = (r) => r.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
for (const row of prompts.SYSTEM_MARKERS) {
  const rendered = allText(prompts.renderPrompt(row.prompt, markerCtx));
  check(`「${row.marker}」仍在 ${row.prompt}`, rendered.includes(row.marker), row.用途);
}
// 教学类必须含「读懂论文」；问答/翻译不能含（否则教学假上游会误判）
for (const id of ['teach.intro', 'teach.prereq', 'teach.walk', 'teach.visual', 'teach.walk.continue', 'teach.prereq.one', 'teach.condense']) {
  const sys = prompts.renderPrompt(id, markerCtx).messages[0]?.content || '';
  check(`${id} 含「读懂论文」`, sys.includes('读懂论文'));
}
for (const id of ['qa.chat', 'qa.explain', 'translate.selection']) {
  const sys = prompts.renderPrompt(id, markerCtx).messages[0]?.content || '';
  check(`${id} 不含「读懂论文」`, !sys.includes('读懂论文'));
}
check('解答/翻译/操作都含【本次任务】或问题块', prompts.renderPrompt('op.evidence', markerCtx).messages.at(-1).content.includes('【本次任务】'));
for (const id of ['teach.intro', 'teach.prereq', 'teach.walk', 'teach.visual']) {
  check(`${id} user 含【本次任务】`, prompts.renderPrompt(id, markerCtx).messages.at(-1).content.includes('【本次任务】'));
}
check('「先给我讲明白」字面量仍在 teaching.js 文件内', fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', 'teaching.js'), 'utf8').includes('先给我讲明白'));

/* ── 4. 预算与裁剪顺序 ── */
console.log('\n▶ 预算与裁剪');
check('空串估算 0', prompts.estimateTokens('') === 0);
check('中文 10 字 ≈ 10 token', prompts.estimateTokens('一二三四五六七八九十') === 10);
check('拉丁 32 字符 ≈ 10 token', prompts.estimateTokens('a'.repeat(32)) === 10, String(prompts.estimateTokens('a'.repeat(32))));
check('TRIM_ORDER 固定顺序', JSON.stringify(prompts.TRIM_ORDER) === JSON.stringify([
  'web', 'references', 'fulltext', 'pageContext', 'paperMemory', 'profileItems',
  'longTerm', 'history', 'sessionSummary']));
for (const k of ['question', 'selection', 'pageHead']) check(`永不裁剪含 ${k}`, prompts.NEVER_TRIM.includes(k));
check('硬上限 120k token', prompts.HARD_TOKENS === 120000);

/* ── 5. 兼容壳导出签名 ── */
console.log('\n▶ 兼容壳导出');
for (const name of ['translateMessages', 'matchGlossary', 'askMessages', 'explainMessages', 'digestMessages',
  'opMessages', 'teachMessages', 'sessionSummaryMessages', 'scanPageMessages', 'condenseMessages', 'regionMessages']) {
  check(`ai.js 仍导出 ${name}`, typeof ai[name] === 'function');
}
for (const name of ['TEACHING_OPS', 'teachingOpById', 'TEACHING_PROMPT_VERSION', 'WALK_CONTINUE_SYS',
  'walkReteachSys', 'PREREQ_ONE_SYS', 'splitPrtBlock', 'hideStreamTail', 'parsePrereqItems',
  'detectPageObjects', 'splitPages', 'pageTextOf', 'collectDocObjects', 'sanitiseChips', 'sanitiseProfileSuggestions']) {
  check(`teaching.js 仍导出 ${name}`, name in teaching);
}
check('TEACHING_PROMPT_VERSION 仍为 t4（P1 兼容缓存键）', teaching.TEACHING_PROMPT_VERSION === 't4');
check('ops.js 仍导出 OPS/opById/ADVANCED_OPS/COMMON_RULES',
  Array.isArray(ops.OPS) && typeof ops.opById === 'function' && Array.isArray(ops.ADVANCED_OPS) && typeof ops.COMMON_RULES === 'string');
check('OPS 每项带 promptId 且已注册', ops.OPS.every((o) => prompts.hasPromptDef(o.promptId)));
check('教学四项都带 promptId 且已注册', teaching.TEACHING_OPS.every((o) => prompts.hasPromptDef(o.promptId)));

/* ── 6. 渲染 debug（开发者用，不进模型上下文） ── */
console.log('\n▶ debug manifest');
const { messages, debug } = prompts.renderPrompt('qa.chat', {
  question: 'q', docTitle: 't', history: [], page: 1,
  request: {
    guidance: '', question: 'q', selection: '', inherited: false,
    focus: { text: 'q', page: 1, kind: 'question', source: '' },
  },
  role: 'screen', pageImages: [], screenshotCount: 0, references: [], teachingBlock: '',
});
check('messages 结构：system 开头、user 结尾', messages[0].role === 'system' && messages.at(-1).role === 'user');
check('debug.id/version/hash/tokens 齐全',
  debug.id === 'qa.chat' && /^\d+\.\d+\.\d+$/.test(debug.version) && /^[0-9a-f]{8}$/.test(debug.hash) && debug.tokens > 0,
  JSON.stringify(debug));
check('debug.hash 与内容稳定相关', prompts.renderPrompt('qa.chat', {
  question: 'q', docTitle: 't', history: [], page: 1,
  request: { guidance: '', question: 'q', selection: '', inherited: false, focus: { text: 'q', page: 1 } },
  role: 'screen', pageImages: [], screenshotCount: 0, references: [], teachingBlock: '',
}).debug.hash === debug.hash);
check('PROFILE_RULES 仍是唯一一份（profile.js 引用同一常量）', typeof PROFILE_RULES === 'string' && PROFILE_RULES.includes('不是论文证据'));
check('固定时间已生效（nowContext 可复现）', FIXED_NOW.getFullYear() === 2026);

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
