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

/** 从「英文=译名」文本里找出这次片段真正命中的术语 */
export function matchGlossary(text, glossaryText) {
  if (!glossaryText || !text) return [];
  const entries = String(glossaryText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
    .filter(([k, v]) => k && v);
  if (!entries.length) return [];
  const hay = text.toLowerCase();
  return entries.filter(([k]) => hay.includes(k.toLowerCase()));
}

/** 把命中术语渲染成提示词里的固定行（旧实现里是 sys.push 的多行，整体以换行开头） */
function glossaryLines(text, glossaryText) {
  const hits = matchGlossary(text, glossaryText);
  if (!hits.length) return '';
  const lines = ['', '以下术语必须严格按给定译名翻译（用户指定，优先级最高）：'];
  for (const [k, v] of hits) lines.push(`· ${k} → ${v}`);
  return lines.join('\n');
}

export const translateSelection = definePrompt({
  id: 'translate.selection',
  version: '1.0.0',
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
    { id: 'glossary', fn: (ctx) => glossaryLines(ctx.text, ctx.glossary) },
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
  notes: '只输出译文；无历史、无记忆。glossary 在 P2 删除（无设置入口的死参数）。',
});

/** 旧导出：translateMessages —— translate.selection 的兼容壳 */
export function translateMessages(input = {}) {
  return compose('translate.selection', {
    text: '', targetLang: '中文', context: '', page: null, docTitle: '', glossary: '',
    ...input,
  });
}

/** 渲染 + 记录 debug */
export function compose(id, ctx) {
  const { messages, debug } = renderPrompt(id, ctx);
  noteDebug(debug);
  return messages;
}
