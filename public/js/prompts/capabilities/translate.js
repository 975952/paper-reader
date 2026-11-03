/**
 * 翻译类提示词：translate.selection（划词翻译）。
 *
 * 注意：旧 translateMessages() 的 system 是 **join('\n')**（含一个空行块），
 * 这里用 raw 空块 + '\n' 前缀块复刻，保证字节级一致。
 * `glossary` 参数目前没有任何设置入口（死代码），P2 按设计删除。
 */
import { definePrompt } from '../registry.js';
import { renderPrompt, noteDebug } from '../compose.js';
import { OUTPUT_ONLY } from '../base.js';

export const translateSelection = definePrompt({
  id: 'translate.selection',
  version: '2.0.0',
  kind: 'qa',
  identity: '你是一位严谨的学术论文翻译专家',
  system: [
    { id: 'identity', fn: (ctx) => `你是一位严谨的学术论文翻译专家，把论文片段翻译成${ctx.targetLang}。` },
    { id: 'blank', text: '', raw: true },
    { id: 'requirements-heading', text: '要求：' },
    { id: 'rule-1', fn: (ctx) => `1. 术语准确、全篇一致。专业术语首次出现时写成「${ctx.targetLang === '中文' ? '中文（English）' : '译文（原文）'}」的形式。` },
    { id: 'rule-2', text: '2. 公式、变量名、数字、单位、引用编号（如 [12]）、图表编号（如 Fig. 2 / Table 3）一律原样保留，不翻译、不改写。' },
    { id: 'rule-3', text: '3. 保持原文段落结构（空行分段）。不要添加解释、不要总结、不要补标题。' },
    { id: 'rule-4', text: '4. 若片段明显被截断，按语义补全成通顺的句子，但不得编造原文没有的内容。' },
    { id: 'rule-5', fn: () => `5. ${OUTPUT_ONLY}` },
  ],
  systemJoin: '\n',
  user: (ctx) => {
    const user = [];
    user.push(`【论文】${ctx.docTitle || '未命名'}${ctx.page ? `（第 ${ctx.page} 页）` : ''}`);
    if (ctx.context) user.push(`【所在段落 · 仅供理解语境，不要翻译】\n${ctx.context}`);
    user.push(`【需要翻译的片段】\n${ctx.text}`);
    return user.join('\n\n');
  },
  materials: ['doc', 'pageContext', 'selection'],
  memory: [],
  historyMax: 0,
  multimodal: 'none',
  notes: '只输出译文；无历史、无记忆。P2 已删除无设置入口的 glossary 死参数。',
});

/** 旧导出：translateMessages —— translate.selection 的兼容壳 */
export function translateMessages(input = {}) {
  return compose('translate.selection', {
    text: '', targetLang: '中文', context: '', page: null, docTitle: '',
    ...input,
  });
}

/**
 * 截图翻译（2026-11-03）：译文面板框选 PDF 区域 → 直接把截图里的文字翻译出来。
 *
 * 图片本体由前端附在最后一条 user 消息里（`{type:'image_url'}`），这里只渲染文字部分；
 * 因此 def.multimodal 声明 image（预算/裁剪按有图请求算），而 materials 里不放 doc 全文。
 */
export const translateScreenshot = definePrompt({
  id: 'translate.screenshot',
  version: '1.0.0',
  kind: 'qa',
  identity: '你是一位严谨的学术论文翻译专家',
  system: [
    { id: 'identity', fn: (ctx) => `你是一位严谨的学术论文翻译专家，把截图里的内容翻译成${ctx.targetLang}。` },
    { id: 'blank', text: '', raw: true },
    { id: 'requirements-heading', text: '要求：' },
    { id: 'rule-1', text: '1. 翻译截图里所有看得见的文字（正文、标题、图注、表头、坐标轴/图例标签、页眉页脚等），按原文阅读顺序与段落组织。' },
    { id: 'rule-2', text: '2. 公式、变量名、数字、单位、引用编号（如 [12]）、图表编号（如 Fig. 2 / Table 3）一律原样保留，不翻译、不改写；作者名、期刊名、网址保留原文。' },
    { id: 'rule-3', text: '3. 如果截图主要是图、表或公式、文字很少：先翻译其中所有可见文字，再用单独一行「图表说明：……」简要说明这张图/表/公式表达了什么（不要展开成整段讲解）。' },
    { id: 'rule-4', text: '4. 看不清或无法辨认的内容用「…」标注，不要猜造；不要添加原文没有的解释、不要总结、不要补标题。' },
    { id: 'rule-5', fn: () => `5. ${OUTPUT_ONLY}` },
  ],
  systemJoin: '\n',
  user: (ctx) => {
    const lines = [];
    lines.push(`【论文】${ctx.docTitle || '未命名'}${ctx.page ? `（第 ${ctx.page} 页）` : ''}`);
    if (ctx.label) lines.push(`【截图】${ctx.label}`);
    lines.push('【任务】请翻译这张截图里的文字（见附图）。');
    return lines.join('\n');
  },
  materials: ['screenshot'],
  memory: [],
  historyMax: 0,
  multimodal: 'image',
  notes: '截图翻译：图片由前端附在最后一条 user 消息里；只输出译文（必要时加一行「图表说明：」）。',
});

/** 截图翻译 messages 入口（app.js doTranslateShot 使用） */
export function translateShotMessages(input = {}) {
  return compose('translate.screenshot', {
    targetLang: '中文', page: null, docTitle: '', label: '',
    ...input,
  });
}

/** 渲染 + 记录 debug */
export function compose(id, ctx) {
  const { messages, debug } = renderPrompt(id, ctx);
  noteDebug(debug);
  return messages;
}
