/**
 * A 线 P4：提示词 manifest 与文档一致性检查（版本工具）。
 *
 *   node test/prompts-manifest.mjs            # 校验
 *   node test/prompts-manifest.mjs --update   # 改完提示词并 bump 版本后，更新快照（必须同时改设计文档）
 *
 * 规则（对应设计 §13.3 P4）：
 *  1) registry 里每个 PromptDef 的 id/version 必须出现在 `docs/提示词工程-设计.md` 的实装索引里；
 *  2) `test/fixtures/prompts-manifest.json` 是「已发布 manifest」快照：
 *     改提示词内容/版本却没更新快照 → 报错并提示 bump 流程（防漏 bump）；
 *  3) 死代码与兼容壳检查（regionMessages / matchGlossary / glossary 参数不得复活）；
 *  4) PROMPT_SYSTEM_VERSION 形如 2026.11.x，且缓存键相关测试文件引用了它。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as prompts from '../public/js/prompts/index.js';
import * as ai from '../public/js/ai.js';
import * as teaching from '../public/js/teaching.js';

const ROOT = path.join(import.meta.dirname, '..');
const SNAPSHOT = path.join(import.meta.dirname, 'fixtures', 'prompts-manifest.json');
const DESIGN = path.join(ROOT, 'docs', '提示词工程-设计.md');
const update = process.argv.includes('--update');

const result = [];
const check = (name, ok, detail = '') => {
  result.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const failures = [];
const fail = (name, detail) => { failures.push({ name, detail }); console.log(`❌ ${name}${detail ? `  — ${detail}` : ''}`); };

const manifest = prompts.getManifest();
const design = fs.readFileSync(DESIGN, 'utf8');
const ids = Object.keys(manifest);

/* 1. 文档实装索引 */
let missingInDoc = ids.filter((id) => !design.includes(`\`${id}\``));
check('设计文档实装索引覆盖全部 PromptDef', missingInDoc.length === 0, missingInDoc.join(', '));
for (const id of ids) {
  const row = new RegExp(`\\\`${id}\\\`[^\\n]*${manifest[id].replace(/\./g, '\\.')}`);
  if (!row.test(design)) { fail(`文档版本与代码一致：${id}`, `文档里找不到 ${id} @ ${manifest[id]}（先更新设计文档 §20）`); }
}
check('文档里每个 PromptDef 版本与代码一致', !failures.some((f) => f.name.startsWith('文档版本')));

/* 2. manifest 快照（防漏 bump） */
const current = { systemVersion: prompts.PROMPT_SYSTEM_VERSION, prompts: manifest };
if (update) {
  fs.writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log(`\n已更新快照：${path.relative(ROOT, SNAPSHOT)}（记得同步设计文档 §20 与 PROGRESS）`);
} else {
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const same = JSON.stringify(saved) === JSON.stringify(current);
  check('manifest 与已发布快照一致（改提示词必须 bump 版本 + 更新快照 + 文档）', same,
    same ? '' : '不一致：bump 相关 PromptDef 版本、更新设计文档 §20、再跑 --update');
  if (!same) {
    const saveIds = Object.keys(saved.prompts || {});
    const added = ids.filter((id) => !saveIds.includes(id));
    const removed = saveIds.filter((id) => !ids.includes(id));
    const changed = ids.filter((id) => saveIds.includes(id) && saved.prompts[id] !== manifest[id]);
    console.log(`  · 新增 ${added.length}、删除 ${removed.length}、版本变化 ${changed.length}`);
    if (added.length) console.log(`    + ${added.join(', ')}`);
    if (removed.length) console.log(`    - ${removed.join(', ')}`);
    if (changed.length) console.log(`    ~ ${changed.map((id) => `${id}: ${saved.prompts[id]}→${manifest[id]}`).join(', ')}`);
  }
}

/* 3. 死代码 / 兼容壳 */
check('死代码不复活：regionMessages 已删', !('regionMessages' in ai));
check('死代码不复活：matchGlossary / glossary 参数已删', !('matchGlossary' in ai) && ai.translateMessages.length === 0);
check('死代码不复活：sanitiseProfileSuggestions 已删', !('sanitiseProfileSuggestions' in teaching));
check('prt 只剩 chips（不再解析 profile 建议）',
  !('profile' in teaching.splitPrtBlock('x\n```prt\n{"chips":[],"profile":[]}\n```')));

/* 4. 版本格式与缓存键接线 */
check('PROMPT_SYSTEM_VERSION 形如 2026.11.x', /^2026\.11\.\d+$/.test(prompts.PROMPT_SYSTEM_VERSION), prompts.PROMPT_SYSTEM_VERSION);
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
for (const [label, pattern] of [
  ['教学缓存键', '@${PROMPT_SYSTEM_VERSION}:p'],
  ['翻译缓存键', 'translate.selection@${PROMPT_SYSTEM_VERSION}'],
  ['扫描页型缓存', 'DOC_PROFILE_VERSION = PROMPT_SYSTEM_VERSION'],
  ['阅读索引缓存', 'SCAN_DIGEST_VERSION = PROMPT_SYSTEM_VERSION'],
  ['会话摘要版本', 'summaryPrompt: PROMPT_SYSTEM_VERSION'],
]) {
  check(`缓存版本已接线：${label}`, appSrc.includes(pattern));
}
check('__ctx.promptDebug 只读调试清单已暴露', appSrc.includes('get promptDebug()'));

console.log(`\nPromptDef：${ids.length} 个；系统版本 ${prompts.PROMPT_SYSTEM_VERSION}`);
if (failures.length) {
  console.log(`\n失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\nmanifest 校验通过');
