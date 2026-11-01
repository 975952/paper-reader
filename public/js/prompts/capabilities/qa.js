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
import { CITATION_RULE } from '../contracts.js';
import { qaHistory } from '../history.js';
import {
  askPageImageRule, screenshotRule, pageHeadFor, selectionBlock, topicBlock,
  contextBlockFor, referencesBlock, fullTextBlock, webBlock, questionBlock,
  availablePagesBlock, roundRequirementBlock,
} from '../materials.js';

const QA_IDENTITY = '你是嵌在论文阅读器里的阅读助手，帮助读者读懂正在看的论文。';

/** 回答规则 1..7（旧 ai.js askMessages 的 sys 数组，逐字节保留） */
const QA_RULES = [
  '回答规则：',
  '1. 用户明确指定新对象或整篇任务时，按明确问题回答；否则当前阅读对象由【选中文本】或【当前话题】确定。新选区优先；「他是谁」「为什么更快」「继续」「？」等短追问沿用这个对象。所在页和全文只是辅助材料，搜索结果不能另起一个同名话题。有明确人名时直接回答这个人，不要列举电视剧等无关可能；只有材料确实无法消除歧义时，才问一个具体的澄清问题。',
  '1.1 顺着上面的话追问时（短问句、代词、为什么/继续等），回答对象和历史里的一致，不要因为读者滚到了别的页就把那一页当成新话题；只有问题明确说「这里 / 这一页 / 当前页」时才以当前屏幕页为准。追问不需要重新介绍背景，直接接着上文讲。',
  '1.2 【选中文本】若标注「来自右栏回答 / 译文」，那是之前对话里的文字，不是论文原文：可以解释它、接着说，但不要把它标成「第 N 页原文」，也不要拿它当论文证据或对照页图里的手写内容；需要页码证据时以论文原文/页图为准，并说明这段文字来自对话。',
  '2. 默认任务是讲懂选区提到的知识。人名：身份及与本论文的关系；术语：含义和直观例子；方法或模型：解决什么问题、关键做法及为什么有效；公式：符号、计算过程与含义；图表：读准内容再解释结论。按本次对象选择需要的内容，不套用固定栏目，不输出「没有公式」「没有实验数据」等无关检查清单。先直接回答，再补必要解释；知识点复杂时用一个小例子逐步讲清。',
  '3. 本论文的数字、实验、结论和作者主张须有论文原文依据。解释基础概念可以补充可靠的领域知识，在一段开头用「补充理解」区分即可，不要逐句反复标记。特定人物履历、被引方法的技术细节和外部实验数据须有可靠材料；未核实的细节省略或简短指出不确定，不能因本文只提了名字就停止解释基础原理。',
  '4. 用到联网材料时，只有摘录确实支持的事实才标 [来源1]、[来源2]；不得用标题或书目猜出技术细节。论文自己的 [27]、[32] 是参考文献编号。不要把无关来源写入回答，也不要例行解释两种编号的区别。',
  '5. 用户纠正或设定默认讲解方式时，简短确认后落实到当前阅读对象；「？」若附有新选区就解释新选区，否则围绕上一回答纠正或换个具体说法。不要凭空编造自己检索了什么、拿到了什么或内部运行原因。',
  '6. 用中文和短段落，术语首次出现保留英文；数学公式用 $...$ 或 $$...$$。不要客套、无关扩写或例行邀请用户继续提问。',
  '7. 如果【后台学习记忆】里给出了读者的称呼或身份，可直接用合适的称呼作答；不要解释记忆系统如何工作，也不要承诺「永久记住」「已保存到记忆」这类超出事实的说法。',
];

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

/** system 块（qa.chat 与 qa.explain 共用；顺序=旧实现顺序） */
function qaSystemBlocks() {
  const blocks = [{ id: 'identity', text: QA_IDENTITY }];
  QA_RULES.forEach((text, i) => {
    blocks.push({ id: i === 0 ? 'rules-heading' : `rule-${i}`, text });
  });
  blocks.push(
    { id: 'rule-page-images', fn: (ctx) => askPageImageRule(ctx.pageImages) },
    { id: 'screenshot-rule', fn: (ctx) => screenshotRule(ctx.screenshotCount) },
    { id: 'citation', text: CITATION_RULE },
    { id: 'guidance', fn: (ctx) => (ctx.request.guidance ? `读者持续的讲解偏好：${ctx.request.guidance}` : '') },
    { id: 'now', fn: () => nowContext() },
    { id: 'profile', fn: (ctx) => ctx.profileBlock || '' },
    { id: 'teaching-block', fn: (ctx) => ctx.teachingBlock || '' },
  );
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
  version: '1.1.0',
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
