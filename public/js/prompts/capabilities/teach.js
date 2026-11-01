/**
 * 教学类提示词：读懂论文（teach.*）。
 *
 * P1：文案逐字节保留（旧 teaching.js 的 TEACHING_COMMON / 任务段 / PRT_SPEC / 续讲 / 再压短），
 * 只把「能力标题/ask 文案」留在 teaching.js（假上游按「先给我讲明白」等字面量识别），
 * 任务段与装配顺序搬到这里。
 * P2：按设计文档把五项能力的 id 统一、walk 续讲拆成独立 PromptDef、prt schema 收紧。
 */
import { definePrompt, hasPromptDef } from '../registry.js';
import { renderPrompt, renderDef, noteDebug } from '../compose.js';
import { nowContext, buildProfileBlock } from '../../profile.js';
import { BASE_TEACH, withProtocol } from '../base.js';
import { PAGE_IMAGE_RULE, CITATION_RULE, PRT_SPEC } from '../contracts.js';
import { teachHistory } from '../history.js';
import { fullTextBlock, digestBlock, pageImagesBlock, taskBlock, availablePagesBlock } from '../materials.js';

/* ---------------------------------------------------------------- 任务段（逐字节来自旧 teaching.js） */

/** 「先给我讲明白」：怎么讲由 AI 自己判断（用户拍板，不许改回固定模板） */
export const TEACH_PLAN_TASK = [
  '本次任务：读者点了「先给我讲明白」。怎么讲由你判断，不要套固定模板，也不要问读者选哪种讲法。',
  '',
  '先在心里快速判断（不要把这套判断过程写进回答）：',
  '· 这篇论文实际是什么类型、材料是否齐全：理论推导 / 实验系统 / 综述；主线问题是什么；关键定义、公式、图表、实验各在哪几页。',
  '· 读者记忆说明了什么：学习画像里已经懂到什么程度、哪些环节明确有困难、讲解偏好（先直觉还是先公式、要不要例子）；',
  '  长期记忆与身份；这篇论文之前会话的讨论摘要；本次会话最近几轮已经讲过什么。',
  '· 读者现在在哪：当前第几页（是否已读到中途）、当前页有哪些图表公式、有没有选中文字；',
  '  如果读者已经读到中途或这条主线已经讲过，绝不要从头再讲一遍总览。',
  '',
  '按下面的优先级选一种讲法并直接开始：',
  '1. 记忆显示某类前置知识是读懂本文的硬门槛、且读者明确有困难 → 先讲最关键的 1–2 个前置点，再给一条全文路线；',
  '2. 已经读到中途，或本次会话 / 之前会话已经讲过这篇论文 → 接着当前进度或当前页讲，先用一句话接上上下文；',
  '3. 当前页有关键图表 / 公式，且这是理解本文的关键 → 讲懂它（先看它想表达什么，再讲怎么看）；',
  '4. 首次打开、没有更具体的信号 → 给一份入门讲解：它解决什么问题 → 一个具体例子（标明「教学例子」）→ 原来的办法卡在哪 → 作者的办法（直觉 + 关键定义 / 1–2 个核心公式）→ 结果和边界。',
  '',
  '无论选哪种：开头可以用一句「这次我先讲…」说明选择（≤40 字，不要解释记忆系统），之后直接进入内容；',
  '不要罗列菜单、不要反问读者想听哪种。篇幅按内容需要：入门讲解 1000–1600 字；只讲一个前置点或一个图表时 600–1000 字；细节留给追问。',
  '论文事实、数字、结论必须标页码〔p.N〕；讲过的解释和教学例子不标页码。',
].join('\n');

/** 「我需要先懂什么」 */
export const PREREQ_TASK = [
  '本次任务：判断读懂这篇论文真正需要哪些前置知识。只列 3–5 项，不要泛泛的学科知识清单。',
  '开头一句说明怎么挑的。每项按下面的字段写，但**不要把字段说明原样抄进回答**：',
  '① 名称：加粗，单独占一行，写「中文名（English）」；',
  '② 是什么：两三句人话；',
  '③ 为什么这篇论文需要它：指出用在论文哪一部分，标页码；',
  '④ 理解到什么程度就够：可检查的边界（能说清 X 就够，不需要 Y）；',
  '⑤ 门槛：现在必须懂 / 可以之后再学。',
  '按「最该先补」排序。参考后台记忆里的具体边界，只有基础确实够用才简短带过；自述理解或一次正确表现不代表全面掌握，仍有困难的环节要补讲。不要提及后台记录。',
  '最后一句给出建议：先补哪一项、为什么。不要展开讲解任何一项——用户点开才讲。',
  '在 prt 块的 chips 里，为每一项给一个按钮：label 写「讲第 1 项」，prompt 写「讲第 1 项：<该名称>」。',
].join('\n');

/** 「带我一步步读」 */
export const WALK_TASK = [
  '本次任务：给一份分步阅读路线，然后只讲第一步。结构：',
  '**阅读路线**：5–7 步，每步一行，写「步骤名 + 章节 + 〔页码〕」，不展开解释；按理解依赖排序，不机械照搬章节顺序。',
  '**第一步**：',
  '- 现在要弄懂的问题；',
  '- 去读哪里（章节 + 页码）；',
  '- 核心解释（必要时给一个小例子，标「教学例子」）；',
  '- 和下一步的联系。',
  '本次只讲第一步，后面步骤一律不展开。第一步控制在 400 字内，全文 700 字内。',
  '结尾告诉读者：可以点「继续下一步」接着读，也可以随时插问。',
].join('\n');

/** 「讲懂图表与公式」 */
export const VISUAL_TASK = [
  '本次任务：讲懂【当前页】上的一个图表或公式。先看【当前页对象】；用户指定了哪个就讲哪个。',
  '解释方式：',
  '- 图：先说它想表达什么 → 坐标轴 / 图例 / 曲线 / 模块分别是什么 → 按什么顺序看；',
  '- 表：先说比较对象是什么 → 每列指标什么意思、数值往哪个方向算好 → 在什么条件下比较 → 能得出什么结论；',
  '- 公式：先说它要计算或描述什么 → 逐个符号解释 → 讲清运算关系，必要时用一个简单数值走一遍。',
  '必须区分三件事：① 图表直接展示的事实；② 作者在正文里的解释；③ 你的推断（标「我的推断」）。',
  '如果抽取文本里缺图内标签、符号、图例或单位，明确说缺什么，不要补造。',
  '长度 1200–1800 字，不要超过 2000 字；数值例子最多一组。',
  '如果这一页还有别的图/表/公式，可以在 prt 的 chips 里给「换一个对象」的按钮。',
].join('\n');

/** 「带我一步步读」：点「继续下一步」 */
export const WALK_CONTINUE_TASK = '本次任务：接着上一条的阅读路线，只讲下一步。结构：\n'
  + '**第 N 步：步骤名**\n'
  + '- 现在要弄懂的问题；\n'
  + '- 去读哪里（章节 + 页码）；\n'
  + '- 核心解释（必要时一个小例子，标「教学例子」）；\n'
  + '- 和下一步的联系。\n'
  + '只讲当前这一步，不展开后面步骤，也不重复已经讲过的内容。控制在 500 字内。';

/** 「讲简单点 / 给个例子」：只重讲当前步骤，不推进 */
export function walkReteachTask(kind) {
  const goal = kind === 'example'
    ? '用户想要一个具体例子。只重讲当前这一步，把抽象内容落到一个具体例子上（标「教学例子」），不要推进到下一步。'
    : '用户觉得这一步太难。只重讲当前这一步，换更简单、更基础的说法，必要时从一个最小例子讲起，不要推进到下一步。';
  return `${goal}\n控制在 500 字内。开头先一句「我们还在第 N 步」再讲，结尾说明懂了就可以点「继续下一步」。`;
}

/** 「我需要先懂什么」：用户点开其中一项 */
export const PREREQ_ONE_TASK = '本次任务：只讲用户点开的这一项前置知识，把它讲到「能继续读论文」为止。\n'
  + '结构：\n'
  + '**它是什么**：两三句人话 + 一个最小例子（标「教学例子」）；\n'
  + '**为什么这篇论文需要它**：结合论文具体位置（章节 + 页码）说明；\n'
  + '**读到什么程度就够**：给可检查的边界；\n'
  + '**回到论文**：用论文里的公式或句子收尾，说明现在再去读那一段应该能看懂什么。\n'
  + '长度 700–1000 字。结尾不要问问题，告诉用户可以直接说「这个我懂了」或继续问。';

/** 二次压缩（「再压短」按钮） */
export const CONDENSE_SYS = `你是论文阅读器里的「读懂论文」助手。用户觉得上一条回答太长，请把它压缩成原来的 60% 左右。
规则：
- 保留：结论、关键定义与公式、来源页码〔p.N〕、仍然必要的术语解释；
- 删除：重复、铺垫、教学例子里的展开、对下一步的邀请；不要新增内容、不要改变结论；
- 保留原来的小标题结构，但每段更短。用中文，公式照旧用 $...$ / $$...$$。只输出压缩后的正文，不要解释你删了什么。`;

/** 任务段总表：teaching.js 用它组装四项能力（标题/ask 文案留在 teaching.js） */
export const TEACH_TASKS = {
  intro: TEACH_PLAN_TASK,
  prereq: PREREQ_TASK,
  walk: WALK_TASK,
  visual: VISUAL_TASK,
  walkContinue: WALK_CONTINUE_TASK,
  walkReteach: walkReteachTask,
  prereqOne: PREREQ_ONE_TASK,
  condense: CONDENSE_SYS,
};

/** 旧常量：整段 system（teaching.js 再导出，保持旧名） */
export const WALK_CONTINUE_SYS = `${BASE_TEACH}\n\n${WALK_CONTINUE_TASK}`;
export function walkReteachSys(kind) {
  return `${BASE_TEACH}\n\n${walkReteachTask(kind)}`;
}
export const PREREQ_ONE_SYS = `${BASE_TEACH}\n\n${PREREQ_ONE_TASK}`;

/* ---------------------------------------------------------------- 材料 / system 装配 */

/**
 * 教学类 system 块（顺序 = 旧 teachMessages：op.sys → 当前时间 → 页图规则 → 引用契约 → 画像）。
 * op.sys 在旧实现里已经是 BASE_TEACH + 任务段 + PRT_SPEC，所以这里拆成三个块，join('\n\n') 后字节一致。
 */
function teachSystemBlocks(task, { citation = true } = {}) {
  return [
    { id: 'base-teach', text: BASE_TEACH },
    { id: 'task', text: typeof task === 'function' ? '' : task },
    { id: 'prt', text: PRT_SPEC },
    { id: 'now', fn: () => nowContext() },
    { id: 'page-image-rule', fn: (ctx) => (ctx.pageImages?.length ? PAGE_IMAGE_RULE : '') },
    ...(citation ? [{ id: 'citation', text: CITATION_RULE }] : []),
    { id: 'profile', fn: (ctx) => ctx.profileBlock || '' },
  ];
}

/** 教学类 user 材料（顺序 = 旧 teachMessages 的 parts；P1.5 在任务前加可用页码白名单） */
export function teachUserContent(ctx) {
  const parts = [];
  if (ctx.docTitle) parts.push(`【论文】${ctx.docTitle}`);
  if (ctx.fullText) parts.push(fullTextBlock(ctx.fullText));
  else if (ctx.digest) parts.push(digestBlock(ctx.digest));
  if (ctx.pageImages?.length) parts.push(pageImagesBlock(ctx.pageImages));
  if (ctx.extraUser) parts.push(ctx.extraUser);
  const whitelist = availablePagesBlock(ctx.availablePages);
  if (whitelist) parts.push(whitelist);
  parts.push(taskBlock(ctx.ask || ctx.op?.ask || ''));
  return parts.join('\n\n');
}

const TEACH_DEF_BASE = {
  kind: 'teach',
  version: '1.1.0',
  identity: BASE_TEACH,
  systemJoin: '\n\n',
  history: (ctx) => teachHistory(ctx.history || []),
  materials: ['doc', 'fulltext', 'digest', 'pageImages', 'pageContext', 'task'],
  memory: ['profile', 'longTerm', 'paper', 'session'],
  historyMax: 10,
  multimodal: 'page',
};

/** 任务的 system 块里 task 是常量文本，这里统一注册 */
function defineTeach(id, task, extra = {}) {
  return definePrompt({
    ...TEACH_DEF_BASE,
    ...extra,
    id,
    system: teachSystemBlocks(task),
    user: (ctx) => teachUserContent(ctx),
  });
}

export const teachIntro = defineTeach('teach.intro', TEACH_PLAN_TASK, {
  notes: 'AI 自定讲法（用户拍板）；不要改回固定五段模板。',
});
export const teachPrereq = defineTeach('teach.prereq', PREREQ_TASK);
export const teachWalk = defineTeach('teach.walk', WALK_TASK);
export const teachVisual = defineTeach('teach.visual', VISUAL_TASK);
export const teachWalkContinue = defineTeach('teach.walk.continue', WALK_CONTINUE_TASK);
export const teachWalkReteach = definePrompt({
  ...TEACH_DEF_BASE,
  id: 'teach.walk.reteach',
  // kind 两种（simple/example）由调用点决定，P1 用 ad-hoc 渲染；这里登记默认版本
  system: teachSystemBlocks(walkReteachTask('simple')),
  user: (ctx) => teachUserContent(ctx),
  notes: '讲简单点/给个例子：只重讲当前步骤，不推进。',
});
export const teachPrereqOne = defineTeach('teach.prereq.one', PREREQ_ONE_TASK);

/** teach.condense：system = CONDENSE_SYS + 当前时间（旧 condenseMessages 的拼法） */
export const teachCondense = definePrompt({
  id: 'teach.condense',
  version: '1.0.0',
  kind: 'teach',
  identity: '读懂论文助手（压缩上一回答）',
  system: [
    { id: 'condense', text: CONDENSE_SYS },
    { id: 'now', fn: () => nowContext() },
  ],
  systemJoin: '\n\n',
  user: (ctx) => [`【论文】${ctx.docTitle || '未命名'}`, '【需要压缩的回答】', '"""', String(ctx.answer || '').slice(0, 20000), '"""'].join('\n'),
  materials: ['doc', 'answer'],
  memory: [],
  historyMax: 0,
  multimodal: 'none',
});

/* ---------------------------------------------------------------- 兼容壳 */

/**
 * 旧导出：teachMessages(op, ctx)。
 * - op.promptId：走 registry（P2 起调用点会显式传）；
 * - 旧调用点传 `{sys, ask}` 的 ad-hoc（继续下一步 / 讲简单点 / 某个前置项）：
 *   用同一个渲染引擎渲染临时 def，保证输出与旧实现逐字节一致。
 */
export function teachMessages(op, input = {}) {
  const ctx = {
    profileBlock: '',
    pageImages: [],
    history: [],
    ask: '',
    extraUser: '',
    digest: '',
    fullText: '',
    docTitle: '',
    ...input,
    op,
    ask: input.ask || op?.ask || '',
  };
  if (op?.promptId && hasPromptDef(op.promptId)) {
    const { messages, debug } = renderPrompt(op.promptId, ctx);
    noteDebug(debug);
    return messages;
  }
  const { messages, debug } = renderDef({
    id: op?.promptId || 'teach.ad-hoc',
    version: '1.0.0',
    kind: 'teach',
    compat: true,
    systemJoin: '\n\n',
    system: [
      { id: 'op-sys', text: op?.sys || '' },
      { id: 'now', fn: () => nowContext() },
      { id: 'page-image-rule', fn: (c) => (c.pageImages?.length ? PAGE_IMAGE_RULE : '') },
      { id: 'citation', text: CITATION_RULE },
      { id: 'profile', fn: (c) => c.profileBlock || '' },
    ],
    history: (c) => teachHistory(c.history || []),
    user: (c) => teachUserContent(c),
  }, ctx);
  noteDebug(debug);
  return messages;
}

/** 旧导出：condenseMessages —— teach.condense 的兼容壳 */
export function condenseMessages({ answer, docTitle } = {}) {
  const { messages, debug } = renderPrompt('teach.condense', { answer, docTitle });
  noteDebug(debug);
  return messages;
}

export { PRT_SPEC, CITATION_RULE }; 
