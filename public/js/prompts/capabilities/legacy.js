/**
 * 旧能力（已无调用方，P2 删除）：regionMessages —— 旧框选截图一次性问答路径。
 * P1 只搬进 registry 的边缘，保持导出签名不变；`wired: false` 表示不参与请求装配。
 */
import { definePrompt } from '../registry.js';
import { renderPrompt, noteDebug } from '../compose.js';

export const regionLegacy = definePrompt({
  id: 'region.legacy',
  version: '0.9.0',
  kind: 'qa',
  identity: '论文阅读助手（区域截图）',
  system: [{
    id: 'region-sys',
    fn: (ctx) => [
      '你是论文阅读助手，读者给你截取了论文中的一块区域（可能是插图、表格、公式或扫描文字）。',
      '',
      '请按内容类型处理：',
      '· 公式：用 LaTeX 完整写出（$$...$$），并逐个符号解释含义。',
      `· 插图/表格：说明它展示的内容、坐标轴与图例含义、以及它支持的结论；表头和数据要读准。`,
      `· 文字（含扫描件）：先给出识别出的原文，再用${ctx.targetLang}翻译。`,
      '',
      '最后用一句话说明这块内容在整篇论文里的作用。',
      '看不清或不确定的地方要明确说「不确定」，不要猜。用中文回答。',
    ].join('\n'),
  }],
  systemJoin: '\n',
  user: (ctx) => [
    `【论文】${ctx.docTitle || '未命名'}${ctx.page ? `（第 ${ctx.page} 页）` : ''}`,
    ctx.question ? `【读者的问题】${ctx.question}` : '',
    '【区域截图】见下。',
  ].filter(Boolean).join('\n'),
  materials: ['doc', 'regionImage'],
  memory: [],
  historyMax: 0,
  multimodal: 'screenshot',
  notes: '@deprecated 无调用方；P2 删除 export 与本文件。',
  wired: false,
});

/** 旧导出：regionMessages */
export function regionMessages({ question, targetLang = '中文', page = null, docTitle = '' } = {}) {
  const { messages, debug } = renderPrompt('region.legacy', { question, targetLang, page, docTitle });
  noteDebug(debug);
  return messages;
}
