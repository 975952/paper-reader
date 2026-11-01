/**
 * 输出契约（引用 / prt / 多模态 / 保留标记）。
 *
 * P1 与原实现逐字节一致；P2 才收紧措辞与去重，且必须同步渲染器与测试。
 */

/** 引用原文的统一格式：带 ‖ 片段的引用可以跳句/段并高亮（旧 ai.js CITATION_RULE） */
export const CITATION_RULE = '引用论文原文时，写成〔p.N‖连续一句或短段原文〕：片段必须逐字来自材料、不超过 120 字，不能改写或拼接；只给页码就用〔p.N〕。';

/** 扫描件：附带页面图时给所有教学/问答提示词共用的底线（旧 ai.js PAGE_IMAGE_RULE） */
export const PAGE_IMAGE_RULE = '【页面图片规则】这篇 PDF 没有可抽取的文本层（扫描件），材料里附带的是页面图片。'
  + '只依据图片里实际可见的内容作答；看不清、被裁掉或未提供的页面，明确说不确定，不要补造原文、页码或图表编号。'
  + '如果当前模型实际上无法读图，必须直接说明看不到图片并建议配置视觉模型，不要根据标题、提示或常识推测内容。';

/** 结构化输出协议（旧 teaching.js PRT_SPEC，逐字节保留） */
export const PRT_SPEC = [
  '【程序用尾块（可选）】',
  '如果这次回答适合给用户「下一步可以点」的操作，',
  '可以在回答最后追加一个代码块（语言标记必须写 prt），内容是一个 JSON 对象：',
  '```prt',
  '{"chips":[{"label":"继续下一步","prompt":"继续。"}]}',
  '```',
  '规则：',
  '- 只能放在回答最后，正文里不要再重复这段 JSON；没有建议就完全省略这个块。',
  '- chips 最多 4 个，label 不超过 10 个字，prompt 是用户点击后原样发送的话（≤ 120 字）。',
  '- 不要输出学习档案、掌握判断或要求用户确认记忆；后台会独立处理。',
  '- 除了 prt 块，回答正文不要再出现任何代码块。',
].join('\n');

/**
 * 保留标记（reserved markers）：现有假上游/旧套件靠这些子串识别请求类型。
 * 提示词搬家/改写时**必须**保证它们仍出现在对应 PromptDef 里；`test/prompts.mjs` 逐条断言。
 * 详见 docs/提示词工程-设计.md §17.2。
 */
export const SYSTEM_MARKERS = [
  { marker: '后台学习记忆提取器', prompt: 'bg.memory.extract', 用途: 'qa/profile/memory-session/context-page 等假上游识别记忆抽取' },
  { marker: '滚动摘要', prompt: 'bg.sessionSummary', 用途: 'memory-session/profile 等识别会话摘要' },
  { marker: '读懂论文', prompt: 'teach.intro', 用途: 'teaching/scan-pdf/ops/desktop 识别教学类' },
  { marker: '学术论文翻译专家', prompt: 'translate.selection', 用途: 'right-select 识别翻译请求' },
  { marker: '审实验', prompt: 'op.evidence', 用途: 'ops.mjs 识别 evidence 操作' },
  { marker: '【本次任务】', prompt: 'teach.intro', 用途: 'profile.mjs 等区分教学/操作与普通问答' },
];
