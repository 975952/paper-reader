/**
 * 问答类提示词：qa.chat / qa.explain / qa.screenshot。
 *
 * P1 兼容期要求「输出与改造前逐字节一致」，所以这里的 system 块顺序与旧 askMessages()
 * 完全一致（身份 → 回答规则 1..7 → 多模态规则 → 引用契约 → 偏好 → 当前时间 → 记忆 → 教学块），
 * user 块的顺序也原样保留。P2 才按设计文档把规则合并进 BASE_RULES、重写任务段。
 */
import { definePrompt } from '../registry.js';
import { renderPrompt, noteDebug } from '../compose.js';
import { nowContext, buildProfileBlock } from '../../profile.js';
import { resolveReadingRequest } from '../../reading-context.js';
import { BASE_RULES } from '../base.js';
import { qaHistory } from '../history.js';
import {
  askPageImageRule, screenshotRule, pageHeadFor, selectionBlock, topicBlock,
  contextBlockFor, referencesBlock, fullTextBlock, webBlock, questionBlock,
  availablePagesBlock, roundRequirementBlock,
} from '../materials.js';

const QA_IDENTITY = '你是嵌在论文阅读器里的阅读助手，帮助读者读懂正在看的论文。';

/** 明显「只要翻译」的提问：直接给译文 + 最多一句说明，不展开讲解（2026-11-03 用户要求） */
const TASK_TRANSLATE_ONLY = '【本次只翻译】读者这条要求就是翻译：直接给出译文（保持原意、术语准确），'
  + '最多再用一句话点出关键术语或语气；不要展开讲解、不要做结构梳理、不要补充背景知识、不要给例子。';

/**
 * 问答任务段（v2，A 线 P2）：把旧规则 1/1.1/1.2/2/5 合并成「对象 / 追问 / 材料来源 / 讲法 / 纠正」五段；
 * 事实、引用、格式、边界等通用规则已统一在 BASE_RULES（只定义一次）。
 */
const QA_TASK = [
  '【本次任务】回答读者当前的问题。',
  '1. 对象判定：读者明确指定新对象/整篇任务时按明确问题回答；否则当前对象由【选中文本】或【当前话题】确定。'
    + '新选区优先；「他是谁」「为什么更快」「继续」「？」等短追问沿用上一轮对象。'
    + '所在页、全文、联网只是辅助材料，不能另起同名话题；有明确人名时直接回答这个人，不要列举无关可能。'
    + '只有材料确实无法消除歧义时，才问一个具体的澄清问题。',
  '2. 追问语义：顺着上文追问时回答对象和历史一致；不要因为读者滚到了别的页就把那一页当成新话题，'
    + '只有问题明确说「这里 / 这一页 / 当前页」时才以当前屏幕页为准。追问不要重新介绍背景，直接接着讲。',
  '3. 材料来源：若【选中文本】标注「来自右栏回答/译文」，那是对话内容，不是论文原文：可以解释、接着说，'
    + '但不要标成「第 N 页原文」、不要拿来对照页图或当论文证据；需要页码证据时以论文原文/页图为准。',
  '4. 讲法：按对象类型组织（人名→身份与本文关系；术语→含义+直观例子；方法/模型→解决什么问题、关键做法、'
    + '为什么有效；公式→符号、计算、含义；图表→先读懂再解释结论）。不套固定栏目，不输出「没有公式/没有实验数据」'
    + '这类检查清单；复杂知识点用一个小例子逐步讲清。',
  '5. 纠正与偏好：读者纠正你或设定默认讲法时，简短确认并立刻落实到当前对象，不要争辩，也不要编造自己检索了什么。',
  '6. 篇幅：能短则短，问题复杂时再展开；不写结尾的例行「还需要我解释什么吗」。',
].join('\n');

/** 把调用参数规范化成渲染上下文（旧 askMessages 开头的逻辑原样搬入） */
export function prepareAsk(input = {}) {
  const {
    question, selection, selectionSource = '', context, page, pageRole = '', docTitle,
    fullText, webResults, history = [], reading, references = [], profileBlock = null,
    teachingBlock = '', pageImages = [], screenshotCount = 0,
  } = input;
  const request = reading || resolveReadingRequest({ question, selection, page, history, selectionSource });
  const role = ['selection', 'explicit', 'topic', 'screen'].includes(pageRole)
    ? pageRole : (selection ? 'selection' : 'screen');
  // 选中文本来自右栏（上一轮的问答/译文）而不是 PDF 正文：不能冒充「第 N 页原文」
  const selectionFromRight = selectionSource === 'right' || request.focus?.source === 'right';
  return {
    ...input,
    question, selection, context, page, docTitle, fullText, webResults, history, references,
    request, role, selectionFromRight,
    pageImages: Array.isArray(pageImages) ? pageImages : [],
    screenshotCount,
    profileBlock: profileBlock ?? buildProfileBlock(
      undefined,
      `${docTitle || ''}\n${selection || ''}\n${context || ''}`,
      question,
    ),
    teachingBlock,
  };
}

/** system 块（qa.chat 与 qa.explain 共用）：身份 → BASE_RULES → 任务段 → 多模态 → 偏好 → 时间 → 记忆 */
function qaSystemBlocks() {
  const blocks = [
    { id: 'identity', text: QA_IDENTITY },
    { id: 'base-rules', text: BASE_RULES },
    { id: 'task', text: QA_TASK },
    { id: 'translate-only', fn: (ctx) => (ctx.translateIntent ? TASK_TRANSLATE_ONLY : '') },
    { id: 'multi-image-mapping', fn: (ctx) => {
      const total = (Number(ctx.screenshotCount) || 0) + (Array.isArray(ctx.pageImages) ? ctx.pageImages.length : 0);
      return total > 1
        ? '【多图逐一对应】本次有多张独立图片。按用户消息中每个编号标签与其紧邻图片一一对应，分别识别，绝不可把一张图的内容、页码、结论套给另一张图。比较时先确认各自图像，再按编号比较；无法读取某张图时指出其编号。不要输出内部核对过程。'
        : '';
    } },
    { id: 'rule-page-images', fn: (ctx) => askPageImageRule(ctx.pageImages) },
    { id: 'screenshot-rule', fn: (ctx) => screenshotRule(ctx.screenshotCount) },
    { id: 'guidance', fn: (ctx) => (ctx.request.guidance ? `读者持续的讲解偏好：${ctx.request.guidance}` : '') },
    { id: 'now', fn: () => nowContext() },
    { id: 'profile', fn: (ctx) => ctx.profileBlock || '' },
    { id: 'teaching-block', fn: (ctx) => ctx.teachingBlock || '' },
  ];
  return blocks;
}

/** user 块（材料包 + 问题；顺序=旧实现顺序） */
export function qaUserContent(ctx) {
  const { request, role, selectionFromRight, docTitle, context, references = [], fullText, webResults } = ctx;
  const contextBlock = [];
  const pageHead = pageHeadFor(role, ctx.page);
  if (docTitle) contextBlock.push(`【论文】${docTitle}${pageHead}`);
  if (request.selection) {
    contextBlock.push(selectionBlock({
      selection: request.selection,
      inherited: request.inherited,
      focusPage: request.focus?.page,
      selectionFromRight,
    }));
  } else if (request.inherited) {
    contextBlock.push(topicBlock({ focusText: request.focus.text, focusPage: request.focus?.page }));
  }
  if (references.length) contextBlock.push(referencesBlock(references));
  if (context) contextBlock.push(contextBlockFor(role, context));
  if (fullText) contextBlock.push(fullTextBlock(fullText));
  if (webResults?.length) contextBlock.push(webBlock(webResults));
  // P1.5：程序先写好「本次可用页码」与「本轮要求」，放在问题前面 = 近因指令。
  // 页码白名单只列出本次材料里真实出现过的页；模型无权自造。
  const whitelist = availablePagesBlock(ctx.availablePages);
  if (whitelist) contextBlock.push(whitelist);
  const roundRequirement = ctx.roundRequirement || roundRequirementBlock({
    object: ctx.objectLabel,
    page: ctx.page,
    pageRole: role,
    scope: ctx.scopeLabel,
  });
  contextBlock.push(roundRequirement);
  return contextBlock.length
    ? `${contextBlock.join('\n\n')}\n\n${questionBlock(request.question)}`
    : request.question;
}

const QA_BASE = {
  kind: 'qa',
  version: '2.0.0',
  identity: QA_IDENTITY,
  system: qaSystemBlocks(),
  systemJoin: '\n',
  history: (ctx) => qaHistory(ctx.history || []),
  materials: ['doc', 'selection', 'pageContext', 'references', 'fulltext', 'web', 'question'],
  memory: ['profile', 'longTerm', 'paper', 'session'],
  historyMax: 6,
  multimodal: 'both',
  budget: { hardChars: 380000 },
  tests: ['prompts/qa-chat'],
};

export const qaChat = definePrompt({
  ...QA_BASE,
  id: 'qa.chat',
  user: (ctx) => qaUserContent(ctx),
  notes: '右栏问答/追问。P1 与旧 askMessages() 逐字节一致；P2 合并规则 1/1.1/1.2/2/5 为任务段。',
});

export const qaExplain = definePrompt({
  ...QA_BASE,
  id: 'qa.explain',
  user: (ctx) => qaUserContent(ctx),
  notes: '划词解释。P1 复用 qa.chat 的管线，只是问题固定、pageRole 固定。',
});

/** 只发截图（无文字问题）的判断指令：P1 仍写在 app.js send() 里，P2 才收进这里 */
export const SCREENSHOT_TASK = '（读者没有写文字问题，只发来 ${N} 张截图。）这次以截图本身为中心回答：'
  + '先判断截图里实际是什么（插图 / 表格 / 公式 / 算法 / 正文文字 / 手写等），'
  + '再判断读者此刻最需要什么——识读原文、解释含义、翻译，或者说明这一小块在上下文里起什么作用；然后直接给出最有用的回答。'
  + '不要主动扩写到整篇论文，不要套固定栏目，不要补造截图里看不见的内容；只有截图确实离不开上下文时，才简要引用所在页的一两句话。';

export const qaScreenshot = definePrompt({
  id: 'qa.screenshot',
  version: '1.0.0',
  kind: 'qa',
  identity: QA_IDENTITY,
  system: [{ id: 'identity', text: QA_IDENTITY }],
  systemJoin: '\n',
  user: (ctx) => SCREENSHOT_TASK.replace('${N}', String(ctx.screenshotCount || 0)),
  materials: ['doc', 'screenshot', 'question'],
  memory: ['profile', 'longTerm', 'paper', 'session'],
  historyMax: 6,
  multimodal: 'screenshot',
  notes: 'P1 尚未接线（文案仍在 app.js send()）；P2 用 composePrompt 替换调用点里的内联文本。',
  wired: false,
});

/** 旧导出：askMessages —— qa.chat 的兼容壳 */
export function askMessages(input = {}) {
  return compose('qa.chat', prepareAsk(input));
}

/** 旧导出：explainMessages —— qa.explain 的兼容壳 */
export function explainMessages(input = {}) {
  const prepared = prepareAsk({
    ...input,
    question: '请解释这段内容涉及的知识。',
    pageRole: input.selection ? 'selection' : 'screen',
  });
  return compose('qa.explain', prepared);
}

/** 渲染 + 记录 debug（兼容壳统一走这里） */
export function compose(id, ctx) {
  const { messages, debug } = renderPrompt(id, ctx);
  noteDebug(debug);
  return messages;
}
