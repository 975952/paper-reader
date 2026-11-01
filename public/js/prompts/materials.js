/**
 * 材料包（MaterialPack）渲染。
 *
 * P1 只做「把旧实现里的块拼装代码集中到一处」，块顺序/标签/围栏逐字节保持；
 * P3 才给每个块加预算与裁剪优先级。改这里的标签会直接影响
 * `context-page` / `qa` / `teaching` 等断言，动之前先 grep 测试。
 */
import { formatPageList } from '../citation-validator.js';

/** 【论文】标题 + 页码角色 */
export function docBlock(docTitle, pageHead = '') {
  return docTitle ? `【论文】${docTitle}${pageHead}` : '';
}

/** 整篇正文（超长时提示「已按页给出」） */
export function fullTextBlock(fullText) {
  if (!fullText) return '';
  return `【论文全文${fullText.length > 60000 ? '（很长，已按页给出）' : ''}】\n"""\n${fullText}\n"""`;
}

/** 阅读索引（整篇太长时退化为摘要） */
export function digestBlock(digest) {
  return digest ? `【阅读索引】\n${digest}` : '';
}

/** 扫描件页图说明（教学/操作共用） */
export function pageImagesBlock(pageImages = []) {
  if (!pageImages.length) return '';
  return `【页面图片】本次附带了第 ${pageImages.map((p) => p.page).join('、')} 页的原图，见附图。`;
}

/** 问答多模态规则（页图为扫描件时的第 8 条规则） */
export function askPageImageRule(pageImages = []) {
  if (!pageImages.length) return '';
  return '8. 这篇 PDF 没有可抽取的文本层（扫描件），本次附带了页面图片。只依据图片里实际可见的内容回答；'
    + '图片里看不清、被裁掉或没有提供的页面，明确说不确定，不要补造原文、页码或图表编号。'
    + '如果你实际上无法查看图片（当前模型不支持读图），必须直接说明「当前模型无法读图，建议配置视觉模型」，不要根据标题、提示或常识推测图片内容。';
}

/** 问答的截图规则（读者发来的是截图，不是论文页图） */
export function screenshotRule(screenshotCount = 0) {
  if (!screenshotCount) return '';
  return `【截图规则】本次附带了读者发来的 ${screenshotCount} 张截图（不是论文页面图，可能是图 / 表 / 公式 / 代码 / 手写）。`
    + '先判断截图里实际是什么、读者此刻最需要什么，再决定怎么回答（识读原文 / 解释含义 / 翻译 / 说明它在上下文里的作用 / 指出与上下文对不上）。'
    + '如果这次读者没有写文字问题，以截图本身为中心回答，不要主动总结或扩写到整篇论文；只有截图确实离不开上下文时，才简要引用所在页的一两句话。'
    + '只依据截图里实际可见的内容回答；看不清、被裁掉、文字模糊的地方明确说不确定，不要补造原文、数字或图表编号。'
    + '如果你实际上无法查看图片（当前模型不支持读图），必须直接说明「当前模型无法读图，建议配置视觉模型」，不要根据文件名、页码或提示猜截图内容。';
}

/** 页码角色 → 页头措辞（四选一，契约化标签，测试可断言） */
export function pageHeadFor(role, page) {
  if (!page) return '';
  if (role === 'topic') return `｜当前话题在第 ${page} 页`;
  if (role === 'explicit') return `（问题指定的第 ${page} 页）`;
  if (role === 'selection') return `（第 ${page} 页）`;
  return `（读者当前在第 ${page} 页）`;
}

/** 选中文本（追问沿用/右栏来源时的说明） */
export function selectionBlock({ selection, inherited, focusPage, selectionFromRight }) {
  const inheritedPage = inherited && focusPage ? ` · 第 ${focusPage} 页` : '';
  const srcNote = selectionFromRight ? ' · 来自右栏回答 / 译文，不是论文原文' : '';
  return `【选中文本${inherited ? ' · 本次追问沿用' : ''}${inheritedPage}${srcNote}】\n"""\n${selection}\n"""`;
}

/** 无新选区时沿用的当前话题 */
export function topicBlock({ focusText, focusPage }) {
  const topicPage = focusPage ? `（第 ${focusPage} 页）` : '';
  return `【当前话题${topicPage}】\n${focusText}`;
}

/** 所在页上下文（四类标签；P1.5 统一标注「背景信息，必要时可忽略」——它不是命令） */
export function contextBlockFor(role, context) {
  const label = role === 'topic' ? '【当前话题所在页上下文 · 追问时以此为准 · 背景信息，必要时可忽略】'
    : role === 'explicit' ? '【问题指定页的上下文 · 背景信息，必要时可忽略】'
      : role === 'screen' ? '【当前屏幕页上下文 · 只有问题指向「这里/这一页」时才用它，别把它当新话题 · 背景信息，必要时可忽略】'
        : '【所在页上下文 · 背景信息，必要时可忽略】';
  return `${label}\n"""\n${context}\n"""`;
}

/** 选区涉及的参考文献（只是书目信息） */
export function referencesBlock(references = []) {
  if (!references.length) return '';
  return '【选区涉及的参考文献 · 书目信息，不代表技术细节】\n'
    + references.map((r) => `[${r.num}] ${r.text}${r.page ? `（文献表第${r.page}页）` : ''}`).join('\n');
}

/** 联网搜索结果（带编号；明确与论文参考文献编号区分） */
export function webBlock(webResults = []) {
  if (!webResults.length) return '';
  const body = '【联网搜索结果】\n' + webResults.map((r, i) => {
    const snip = String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 4000);
    return `[来源${i + 1}] ${r.title}\n${r.url}${snip ? `\n【${r.excerptKind === 'abstract' ? '原论文摘要' : '搜索摘录'}】${snip}` : '\n【仅书目或标题，无正文摘录】'}`;
  }).join('\n\n');
  const note = `（引用联网结果时只能写 [来源1]～[来源${webResults.length}]；论文原文里的 [27] 那类编号是论文自己的参考文献，不要拿来当联网来源）`;
  return `${body}\n\n${note}`;
}

/**
 * P1.5：本次可用页码白名单（程序事实，不是模型记忆）。
 * 模型只能引用本次材料里真实出现过的页；白名单由调用点按「实际读了什么」算好传进来。
 */
export function availablePagesBlock(pages) {
  const list = Array.isArray(pages) ? pages : (pages ? [...pages] : []);
  if (!list.length) return '';
  return `【本次可用页码】${formatPageList(list)}（只能引用这些页；材料里没有出现过的页码一律不许写出来）`;
}

/**
 * P1.5：近因指令（放在【问题】前面，模型对最近的指令更敏感）。
 * 由程序按阅读上下文填好，不靠模型自己判断；当前页只是背景，不是命令。
 */
export function roundRequirementBlock({ object = '', page = null, pageRole = '', scope = '' } = {}) {
  const parts = [];
  if (object) parts.push(`对象=${object}`);
  if (page) {
    parts.push(pageRole === 'topic'
      ? `所在页=第${page}页（沿用的上一轮话题页，不是屏幕上刚滚到的那一页）`
      : `所在页=第${page}页`);
  }
  if (scope) parts.push(`范围=${scope}`);
  parts.push('当前页只是背景信息，与问题相关才用，不相关可以完全不讲');
  parts.push('只回答这一件事，不要另起话题');
  return `【本轮要求】${parts.join('；')}。`;
}

/** 材料尾部的问题块（最后一块，永不被裁剪） */
export function questionBlock(question) {
  return `【问题】\n${question}`;
}

/** 教学/操作材料尾部的任务块 */
export function taskBlock(ask) {
  return `【本次任务】\n${ask}`;
}

