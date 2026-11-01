/**
 * 深入阅读（操作）提示词：op.evidence / op.limits。
 *
 * 旧 ops.js 的 OPS 数组（标题/hint/sys）在这里定义一次，ops.js 只做 re-export；
 * opMessages() 的 system 顺序保持旧实现：op.sys → 当前时间 → 页图规则 → 引用契约 → 画像。
 */
import { definePrompt, hasPromptDef } from '../registry.js';
import { renderPrompt, renderDef, noteDebug } from '../compose.js';
import { nowContext, buildProfileBlock } from '../../profile.js';
import { BASE_OPS } from '../base.js';
import { PAGE_IMAGE_RULE, CITATION_RULE } from '../contracts.js';
import { opHistory } from '../history.js';
import { fullTextBlock, digestBlock, taskBlock, availablePagesBlock } from '../materials.js';

const TASK_EVIDENCE = '本次任务：审实验。逐项核对：① 用了哪些数据集、规模如何；② 跟谁比（基线是否够强、是否包含当时最强）；'
  + '③ 用什么指标、有没有报方差或多次运行；④ 有没有消融实验证明每个组件的必要性。每条给页码，最后一句说「结论被支撑到什么程度」。不要泛泛说「实验充分」。';

const TASK_LIMITS = '本次任务：找问题。分两块：① 作者自己承认的局限（标页码）；② 作者没提、但你认为值得怀疑的地方 —— '
  + '例如结论适用范围被夸大、实验设置有利于自己、缺少某个对照、复杂度/成本没讨论。第 ② 块每条都要说清「凭什么这么怀疑」。';

/** 旧 ops.js 的 OPS 数组（元素带 promptId，供 opMessages 路由到 registry） */
export const OPS = [
  {
    id: 'evidence',
    promptId: 'op.evidence',
    icon: 'chart',
    title: '实验够不够支撑结论',
    hint: '数据集/基线/指标/消融逐项对照（深入阅读时用）',
    sys: `${BASE_OPS}\n\n${TASK_EVIDENCE}`,
    ask: '这篇论文的实验能支撑它的结论吗？逐项说明。',
  },
  {
    id: 'limits',
    promptId: 'op.limits',
    icon: 'warn',
    title: '局限与可疑之处',
    hint: '作者承认的 + 你看出但作者没说的问题（深入阅读时用）',
    sys: `${BASE_OPS}\n\n${TASK_LIMITS}`,
    ask: '这篇论文有什么局限和可疑之处？',
  },
];

/** 兼容别名：调用方想明确写「深入操作」时用 */
export const ADVANCED_OPS = OPS;

export function opById(id) {
  return OPS.find((o) => o.id === id) || null;
}

/** 操作类 system 块（顺序 = 旧 opMessages：op.sys → now → pageRule → citation → profile） */
function opsSystemBlocks(task) {
  return [
    { id: 'base-ops', text: BASE_OPS },
    { id: 'task', text: task },
    { id: 'now', fn: () => nowContext() },
    { id: 'page-image-rule', fn: (ctx) => (ctx.pageImages?.length ? PAGE_IMAGE_RULE : '') },
    { id: 'citation', text: CITATION_RULE },
    {
      id: 'profile',
      fn: (ctx) => ctx.profileBlock ?? buildProfileBlock(undefined, ctx.fullText || ctx.digest || ctx.docTitle, ctx.op?.ask || ''),
    },
  ];
}

const OP_DEF_BASE = {
  kind: 'op',
  version: '1.1.0',
  identity: BASE_OPS,
  systemJoin: '\n\n',
  history: (ctx) => opHistory(ctx.history || []),
  materials: ['doc', 'fulltext', 'digest', 'pageImages', 'task'],
  memory: ['profile'],
  historyMax: 4,
  multimodal: 'page',
};

export const opEvidence = definePrompt({
  ...OP_DEF_BASE,
  id: 'op.evidence',
  system: opsSystemBlocks(TASK_EVIDENCE),
  user: (ctx) => opUserContent(ctx),
  notes: '审实验；任务段必须含「审实验」字面量（ops.mjs 假上游按它识别）。',
});

export const opLimits = definePrompt({
  ...OP_DEF_BASE,
  id: 'op.limits',
  system: opsSystemBlocks(TASK_LIMITS),
  user: (ctx) => opUserContent(ctx),
  notes: '局限与可疑之处。',
});

/** 操作类 user 材料（顺序 = 旧 opMessages 的 parts；P1.5 在任务前加可用页码白名单） */
export function opUserContent(ctx) {
  const parts = [];
  if (ctx.docTitle) parts.push(`【论文】${ctx.docTitle}`);
  if (ctx.fullText) parts.push(fullTextBlock(ctx.fullText));
  else if (ctx.digest) parts.push(digestBlock(ctx.digest));
  if (ctx.extra) parts.push(ctx.extra);
  const whitelist = availablePagesBlock(ctx.availablePages);
  if (whitelist) parts.push(whitelist);
  parts.push(taskBlock(ctx.op?.ask || ''));
  return parts.join('\n\n');
}

/** 旧导出：opMessages(op, ctx) —— 优先按 op.promptId 走 registry */
export function opMessages(op, input = {}) {
  const ctx = { docTitle: '', fullText: '', digest: '', extra: '', history: [], profileBlock: null, pageImages: [], ...input, op };
  const id = op?.promptId || (op?.id ? `op.${op.id}` : '');
  if (id && hasPromptDef(id)) {
    const { messages, debug } = renderPrompt(id, ctx);
    noteDebug(debug);
    return messages;
  }
  const { messages, debug } = renderDef({
    id: id || 'op.ad-hoc',
    version: '1.0.0',
    kind: 'op',
    systemJoin: '\n\n',
    system: [
      { id: 'op-sys', text: op?.sys || '' },
      { id: 'now', fn: () => nowContext() },
      { id: 'page-image-rule', fn: (c) => (c.pageImages?.length ? PAGE_IMAGE_RULE : '') },
      { id: 'citation', text: CITATION_RULE },
      { id: 'profile', fn: (c) => c.profileBlock ?? buildProfileBlock(undefined, c.fullText || c.digest || c.docTitle, c.op?.ask || '') },
    ],
    history: (c) => opHistory(c.history || []),
    user: (c) => opUserContent(c),
  }, ctx);
  noteDebug(debug);
  return messages;
}
