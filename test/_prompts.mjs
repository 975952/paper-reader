/**
 * 提示词黄金快照的共享场景定义（P0 抓基线 / P1 起逐字节比对）。
 *
 * 这里只做三件事：
 *  1) 固定 Date，让 `nowContext()` / `nowISO()` 可复现；
 *  2) 放一份固定的学习档案，让 `buildProfileBlock()` 的输出可复现；
 *  3) 把 12+ 个真实调用场景的参数集中成一页，capture 与 assert 用同一份定义。
 *
 * 不碰浏览器、不碰网络、不碰 data/。任何一条场景输出都应逐字节稳定；
 * 输出里的「当前时间」会被归一化成 <NOW>，避免跨时区/跨分钟漂移。
 */
import { profileStore } from '../public/js/profile.js';
import { TEACHING_OPS, WALK_CONTINUE_SYS, walkReteachSys, PREREQ_ONE_SYS } from '../public/js/teaching.js';
import { OPS } from '../public/js/ops.js';
import * as ai from '../public/js/ai.js';
import { memoryExtractMessages } from '../public/js/learning-memory.js';

/** 固定“现在”：2026-11-02 14:30 本地时间（周一） */
export const FIXED_NOW = new Date(2026, 10, 2, 14, 30, 0);
{
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW.getTime());
      else super(...args);
    }
    static now() { return FIXED_NOW.getTime(); }
  }
  globalThis.Date = FrozenDate;
}

export const FIXTURE_PROFILE = {
  version: 1,
  revision: 7,
  updatedAt: '2026-10-28T21:05:00+08:00',
  selfReport: '我在读多模态方向，希望解释时保留英文术语',
  selfReportAt: '2026-10-01T09:00:00+08:00',
  items: [
    {
      id: 'mem-identity', topic: '称呼', aliases: ['怎么称呼'], level: '称呼：Cyan', boundary: '',
      basis: 'user_self_report', status: 'confirmed',
      createdAt: '2026-10-01T09:10:00+08:00', updatedAt: '2026-10-28T21:05:00+08:00',
      lastConfirmedAt: '2026-10-28T21:05:00+08:00', source: null, note: '',
      memory: { kind: 'identity', scope: 'global', signal: 'self_report', evidence: '我叫 Cyan，请记住' },
    },
    {
      id: 'mem-attn', topic: '注意力机制（Attention）', aliases: ['Attention'],
      level: '能写出 softmax(QK^T/√d)V 的基本形式', boundary: '多头注意力为什么有效还没弄懂',
      basis: 'user_self_report', status: 'confirmed',
      createdAt: '2026-10-20T20:00:00+08:00', updatedAt: '2026-10-28T21:05:00+08:00',
      lastConfirmedAt: '2026-10-28T21:05:00+08:00',
      source: { docId: 'fixture-multipage.pdf', paper: 'Attention Is All You Need', capability: 'intro' },
      note: '',
      memory: { kind: 'knowledge', scope: 'global', signal: 'needs_help', evidence: '多头注意力我还没弄懂' },
    },
    {
      id: 'mem-pref', topic: '讲解偏好', aliases: [], level: '先给例子，再解释公式', boundary: '',
      basis: 'user_self_report', status: 'confirmed',
      createdAt: '2026-10-22T10:00:00+08:00', updatedAt: '2026-10-28T21:05:00+08:00',
      lastConfirmedAt: '2026-10-28T21:05:00+08:00', source: null, note: '',
      memory: { kind: 'preference', scope: 'global', signal: 'preference', evidence: '以后先给例子再讲公式' },
    },
  ],
};

/** 场景执行前：把固定档案放进 profileStore（调用方都在用它的 data） */
export function installFixtureProfile() {
  profileStore.data = JSON.parse(JSON.stringify(FIXTURE_PROFILE));
  profileStore.loaded = true;
  profileStore.error = '';
  profileStore.enabled = true;
}

const teachOp = (id) => TEACHING_OPS.find((o) => o.id === id);
const op = (id) => OPS.find((o) => o.id === id);

/** 12+ 个真实场景：覆盖问答/翻译/教学/操作/后台任务的全部现有消息构造入口 */
export const SCENARIOS = {
  'qa.chat/basic': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '多头注意力相比单头注意力解决了什么问题？',
    selection: 'Multi-head attention allows the model to jointly attend to information from different representation subspaces.',
    context: '3.2.1 Scaled Dot-Product Attention\nWe call our particular attention "Scaled Dot-Product Attention". The input consists of queries and keys of dimension dk, and values of dimension dv.',
    page: 3,
    docTitle: 'Attention Is All You Need',
    history: [
      { role: 'user', content: '这篇论文主要解决什么问题？' },
      { role: 'assistant', content: '它想用纯注意力机制替代循环和卷积，降低长距离依赖的建模成本。' },
    ],
  }),
  'qa.chat/followup': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '为什么它更快？',
    page: 2,
    docTitle: 'Attention Is All You Need',
    history: [
      { role: 'user', content: '多头注意力的计算量是多少？' },
      { role: 'assistant', content: '每层约 O(n²d) 的注意力计算。' },
    ],
    reading: {
      question: '为什么它更快？', selection: '', page: 2, intent: 'followup', inherited: true,
      focus: { text: 'Multi-head attention', page: 3, kind: 'question', source: '' }, guidance: '',
    },
  }),
  'qa.chat/fulltext-web-refs': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '摘要里说的翻译任务，BLEU 是多少？',
    context: 'Abstract: ... 28.4 BLEU on WMT 2014 English-to-German.',
    page: 1,
    pageRole: 'explicit',
    docTitle: 'Attention Is All You Need',
    fullText: '===== p.1 =====\nAbstract\n===== p.2 =====\nIntroduction',
    webResults: [
      { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', snippet: 'We propose the Transformer...', excerptKind: 'abstract' },
      { title: 'Transformer 综述', url: 'https://example.com/transformer', snippet: '综述文章', excerptKind: 'snip' },
    ],
    references: [{ num: 28, text: 'V. Sindhwani et al. Structured transforms. NIPS, 2015.', page: 9 }],
    history: [{ role: 'user', content: '先解释一下摘要' }, { role: 'assistant', content: '摘要说他们提出 Transformer。' }],
  }),
  'qa.chat/scan-page-images': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '这一页的公式是什么意思？',
    page: 4,
    docTitle: '扫描版论文',
    pageImages: [{ page: 4, dataUrl: 'data:image/png;base64,AAAA' }],
    history: [],
  }),
  'qa.chat/screenshot-only': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '读者没有写文字问题，只发来 2 张截图。',
    page: 2,
    docTitle: 'Attention Is All You Need',
    screenshotCount: 2,
    history: [],
  }),
  'qa.chat/right-selection': (p15 = {}) => ai.askMessages({
    ...p15,
    question: '这段里 attention 指什么？',
    selection: '这次先讲结论：attention 是加权求和。',
    selectionSource: 'right',
    page: 5,
    docTitle: 'Attention Is All You Need',
    history: [],
  }),
  'qa.explain': (p15 = {}) => ai.explainMessages({
    ...p15,
    selection: 'Scaled Dot-Product Attention',
    context: 'We call our particular attention "Scaled Dot-Product Attention".',
    page: 3,
    docTitle: 'Attention Is All You Need',
  }),
  'translate/basic': () => ai.translateMessages({
    text: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    targetLang: '中文',
    docTitle: 'Attention Is All You Need',
    page: 1,
  }),
  'translate/context': () => ai.translateMessages({
    text: 'The encoder maps an input sequence to a sequence of continuous representations.',
    targetLang: '中文',
    context: '3 Model Architecture',
    page: 2,
    docTitle: 'Attention Is All You Need',
  }),
  'teach/intro': (p15 = {}) => ai.teachMessages(teachOp('intro'), {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '研究问题：序列转换。方法：Transformer。结论：BLEU 提升。',
    profileBlock: '',
    history: [{ role: 'user', content: '先给我讲明白' }, { role: 'assistant', content: '这篇论文...' }],
    extraUser: '【读者当前阅读位置】第 3 页 / 共 9 页',
  }),
  'teach/prereq': (p15 = {}) => ai.teachMessages(teachOp('prereq'), {
    ...p15,
    docTitle: 'Attention Is All You Need',
    fullText: '===== p.1 =====\nAbstract\n===== p.2 =====\nIntroduction',
    pageImages: [],
  }),
  'teach/walk': (p15 = {}) => ai.teachMessages(teachOp('walk'), { ...p15, docTitle: 'Attention Is All You Need', digest: '研究问题 / 方法 / 实验 / 结论' }),
  'teach/visual': (p15 = {}) => ai.teachMessages(teachOp('visual'), {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '图 1：Transformer 架构',
    extraUser: '【当前页对象】图 1 · Transformer 架构',
    pageImages: [{ page: 2, dataUrl: 'data:image/png;base64,BBBB' }],
  }),
  'teach/walk-continue': (p15 = {}) => ai.teachMessages({ sys: WALK_CONTINUE_SYS, ask: '继续下一步。' }, {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '阅读路线：1 背景 / 2 模型 / 3 实验',
    history: [{ role: 'user', content: '带我一步步读' }, { role: 'assistant', content: '阅读路线...' }],
  }),
  'teach/walk-reteach': (p15 = {}) => ai.teachMessages({ sys: walkReteachSys('example'), ask: '举个具体例子。' }, {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '第一步：理解 Q/K/V',
    history: [{ role: 'user', content: '带我一步步读' }, { role: 'assistant', content: '第一步...' }],
  }),
  'teach/prereq-one': (p15 = {}) => ai.teachMessages({ sys: PREREQ_ONE_SYS, ask: '讲第 1 项：注意力机制' }, {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '前置：注意力机制 / softmax',
  }),
  'teach/condense': () => ai.condenseMessages({
    answer: '## 结论\nTransformer 用自注意力替代循环，并行度更高。\n〔p.1〕译义：BLEU 28.4。',
    docTitle: 'Attention Is All You Need',
  }),
  'op/evidence': (p15 = {}) => ai.opMessages(op('evidence'), {
    ...p15,
    docTitle: 'Attention Is All You Need',
    fullText: '===== p.6 =====\nWe trained on WMT 2014...',
    history: [{ role: 'user', content: '这篇论文的实验能支撑它的结论吗？' }, { role: 'assistant', content: '...' }],
  }),
  'op/limits': (p15 = {}) => ai.opMessages(op('limits'), {
    ...p15,
    docTitle: 'Attention Is All You Need',
    digest: '方法：Transformer；实验：WMT 2014；结论：BLEU 领先。',
    extra: '【当前页对象】表 2 · WMT 结果',
  }),
  'bg/digest': () => ai.digestMessages({ text: 'Abstract\nWe propose the Transformer.\nIntroduction\n...', docTitle: 'Attention Is All You Need' }),
  'bg/session-summary': () => ai.sessionSummaryMessages({
    previous: '读者希望保留英文术语。',
    turns: 'user: 多头注意力为什么有效？\nassistant: 因为不同子空间关注不同关系。',
  }),
  'bg/scan-transcribe': () => ai.scanPageMessages({ page: 4, docTitle: '扫描版论文' }),
  'bg/memory-extract': () => memoryExtractMessages({
    question: '多头注意力我还没弄懂，能不能先给个例子再讲公式？',
    answer: '多头注意力把 Q/K/V 投影到多组子空间……（助手回答）',
    history: [{ role: 'user', content: '继续' }, { role: 'assistant', content: '好的。' }],
    topic: '注意力机制',
    source: { docId: 'fixture-multipage.pdf', paper: 'Attention Is All You Need', capability: 'intro' },
    profile: FIXTURE_PROFILE,
  }),
};

/** 归一化：把随「现在」和时区变化的时间戳替换成占位符，其余一个字节都不许变 */
export function stableMessages(messages) {
  return JSON.parse(JSON.stringify(messages, (k, v) => {
    if (typeof v !== 'string') return v;
    return v
      .replace(/【当前时间】[^\n]*/g, '【当前时间】<NOW>')
      .replace(/"当前时间":"[^"]*"/g, '"当前时间":"<NOW>"');
  }));
}

/**
 * P1.5 材料参数：模拟 app.js 真实发送时算好的「可用页码白名单 + 对象/范围标签 + 依据回执」。
 * 黄金基线自 P1.5 起包含这些块（这是有意的内容变更，见 PROGRESS §58）。
 */
export const P15_MATERIALS = {
  'qa.chat/basic': { availablePages: [3], scopeLabel: '选区', objectLabel: '多头注意力相关选段' },
  'qa.chat/followup': { availablePages: [2, 3], scopeLabel: '当前页', objectLabel: '上一轮话题：Multi-head attention' },
  'qa.chat/fulltext-web-refs': { availablePages: [1, 2], scopeLabel: '整篇原文', objectLabel: '整篇论文' },
  'qa.chat/scan-page-images': { availablePages: [4], scopeLabel: '当前页页图', objectLabel: '第 4 页公式' },
  'qa.chat/screenshot-only': { availablePages: [], scopeLabel: '截图', objectLabel: '读者截图 2 张' },
  'qa.chat/right-selection': { availablePages: [5], scopeLabel: '选区', objectLabel: '右栏选中的回答片段' },
  'qa.explain': { availablePages: [3], scopeLabel: '选区', objectLabel: 'Scaled Dot-Product Attention' },
  'teach/intro': { availablePages: [] },
  'teach/prereq': { availablePages: [1, 2] },
  'teach/walk': { availablePages: [] },
  'teach/visual': { availablePages: [2] },
  'teach/walk-continue': { availablePages: [] },
  'teach/walk-reteach': { availablePages: [] },
  'teach/prereq-one': { availablePages: [] },
  'op/evidence': { availablePages: [6] },
  'op/limits': { availablePages: [] },
};

/** 跑全部场景，返回 { name: messages } */
export function buildAll() {
  installFixtureProfile();
  const out = {};
  for (const [name, build] of Object.entries(SCENARIOS)) out[name] = stableMessages(build(P15_MATERIALS[name] || {}));
  return out;
}
