/**
 * 提示词系统公共入口（A 线 P1）。
 *
 * 旧模块（ai.js / teaching.js / ops.js / profile.js / learning-memory.js）在这里拿兼容壳，
 * 对外导出签名/返回结构保持不变；`test/prompts.mjs` 用黄金快照守住「逐字节一致」。
 *
 * 分层（详见 docs/提示词工程-设计.md §2.2）：
 *   L0 身份 → L1 基础规则 → L2 任务 → L3 引用/多模态契约 → L4 记忆 → L5 当前时间；
 *   user = 材料包（固定块序）→ 问题。
 * P1 各 PromptDef 的块顺序仍与旧实现一致（compat），P2 才抽出统一装配线。
 */
import './capabilities/qa.js';
import './capabilities/translate.js';
import './capabilities/teach.js';
import './capabilities/ops.js';
import './capabilities/background.js';

export {
  definePrompt, getPromptDef, hasPromptDef, listPrompts, getManifest,
  PROMPT_MANIFEST, PROMPT_SYSTEM_VERSION, promptHash, fnv1a,
} from './registry.js';
export {
  composePrompt, renderPrompt, renderDef, renderBlocks, lastPromptDebug, noteDebug, fitMessages,
} from './compose.js';
export {
  estimateTokens, estimateMessagesTokens, HARD_TOKENS, IMAGE_TOKENS,
  MAX_PAGE_IMAGES, MAX_SCREENSHOTS, TRIM_ORDER, NEVER_TRIM,
} from './budget.js';
export { BASE_TEACH, BASE_OPS, OUTPUT_ONLY, withProtocol } from './base.js';
export { PAGE_IMAGE_RULE, PRT_SPEC, SYSTEM_MARKERS } from './contracts.js';
export {
  docBlock, fullTextBlock, digestBlock, pageImagesBlock, askPageImageRule, screenshotRule,
  pageHeadFor, selectionBlock, topicBlock, contextBlockFor, referencesBlock, webBlock,
  questionBlock, taskBlock,
} from './materials.js';
export { PROFILE_RULES, MEMORY_LABELS } from './memory.js';
export { qaHistory, opHistory, teachHistory } from './history.js';

/* 能力兼容壳 */
export { askMessages, explainMessages, prepareAsk } from './capabilities/qa.js';
export { translateMessages } from './capabilities/translate.js';
export {
  teachMessages, condenseMessages, TEACH_PLAN_TASK, PREREQ_TASK, WALK_TASK, VISUAL_TASK,
  WALK_CONTINUE_SYS, walkReteachSys, PREREQ_ONE_SYS, CONDENSE_SYS, TEACH_TASKS,
} from './capabilities/teach.js';
export { opMessages, OPS, ADVANCED_OPS, opById } from './capabilities/ops.js';
export {
  digestMessages, sessionSummaryMessages, scanPageMessages,
  memoryExtractMessages, MEMORY_EXTRACT_SYS,
} from './capabilities/background.js';
export { SCREENSHOT_TASK } from './capabilities/qa.js';
