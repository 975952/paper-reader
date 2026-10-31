
/** 提示词版本号：改了提示词就 +1，让教学类回答的缓存自动失效 */
export const TEACHING_PROMPT_VERSION = 't2';

/** 所有教学能力共用的底线 */
export const TEACHING_COMMON = [
  '你是嵌在论文阅读器里的「读懂论文」助手，任务是帮读者读懂面前这篇论文，不是在评价它。',
  '',
  '硬性规矩：',
  '1. 论文事实只依据下面给出的【论文全文】/【阅读索引】；材料里没有的不要写，找不到就说「给出的内容里没有提到」。',
  '2. 论文的事实、数字、结论后面标来源页码，写成 〔p.N〕；范围写 〔p.N–M〕。N 必须是材料里真实出现的页码。'
    + '论文参考文献编号长这样 [27]，两者不要混用。解释和教学例子不标页码。',
  '3. 用中文。专业术语第一次出现时保留英文原词，并用一句人话解释；不要用更陌生的术语解释一个术语。',
  '4. 公式用行内 LaTeX $...$，独立公式用 $$...$$。',
  '5. 先建立直觉，再补正式定义；不要客套、不要复述题目、不要堆「首先/其次」式空架子。',
].join('\n');

/**
 * 结构化输出协议（追加在每个能力的 system 末尾）。
 * 只对「回答最后一块」生效：流式时会被隐藏，收尾时解析并剥掉。
 */
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

const withProtocol = (task) => `${TEACHING_COMMON}\n\n${task}\n\n${PRT_SPEC}`;

/* ---------------------------------------------------------------- 四个能力的提示词 */

export const TEACHING_OPS = [
  {
    id: 'intro',
    icon: 'bolt',
    title: '先给我讲明白',
    hint: '默认：几分钟讲清这篇论文在做什么',
    ask: '先给我讲明白：这篇论文到底在做什么？',
    sys: withProtocol([
      '本次任务：写一份「几分钟读完」的入门讲解，让一个学过基础知识、但不熟悉本文细分领域的人弄明白这篇论文在干什么。',
      '按固定顺序写五段，每段用加粗短句当小标题：',
      '**它要解决什么问题**：问题本身是什么，为什么值得做；',
      '**一个具体例子**：用一个具体小例子把这个问题讲出来（标「教学例子」，不能冒充论文实验）；',
      '**原来的办法卡在哪**：讲清旧做法为什么不够好，不要只列缺点；',
      '**作者的办法**：先讲直觉（打比方要标明是类比），再给正式名称、关键定义、最重要的公式（1–2 个即可）；',
      '**结果和边界**：结果说明了什么；仅凭这些结果还不能确定什么。',
      '硬性长度：全文 1200–1600 字。超了就删细节，细节留给追问，不准硬压成一句话。',
      '首次出现的术语就地用一句人话解释。结尾不要问用户问题。',
    ].join('\n')),
  },
  {
    id: 'prereq',
    icon: 'graduation',
    title: '我需要先懂什么',
    hint: '只挑读懂本文必需的前置知识，标「现在必须懂」',
    ask: '我需要先懂什么，才能读懂这篇论文？',
    sys: withProtocol([
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
    ].join('\n')),
  },
  {
    id: 'walk',
    icon: 'compass',
    title: '带我一步步读',
    hint: '先给路线，每次只讲一步，可继续',
    ask: '带我一步步读这篇论文：先给路线，再开始第一步。',
    sys: withProtocol([
      '本次任务：给一份分步阅读路线，然后只讲第一步。结构：',
      '**阅读路线**：5–7 步，每步一行，写「步骤名 + 章节 + 〔页码〕」，不展开解释；按理解依赖排序，不机械照搬章节顺序。',
      '**第一步**：',
      '- 现在要弄懂的问题；',
      '- 去读哪里（章节 + 页码）；',
      '- 核心解释（必要时给一个小例子，标「教学例子」）；',
      '- 和下一步的联系。',
      '本次只讲第一步，后面步骤一律不展开。第一步控制在 400 字内，全文 700 字内。',
      '结尾告诉读者：可以点「继续下一步」接着读，也可以随时插问。',
    ].join('\n')),
  },
  {
    id: 'visual',
    icon: 'chart',
    title: '讲懂图表与公式',
    hint: '默认从当前页选图 / 表 / 公式，讲清怎么看',
    ask: '讲懂当前页上的图表或公式。',
    sys: withProtocol([
      '本次任务：讲懂【当前页】上的一个图表或公式。先看【当前页对象】；用户指定了哪个就讲哪个。',
      '解释方式：',
      '- 图：先说它想表达什么 → 坐标轴 / 图例 / 曲线 / 模块分别是什么 → 按什么顺序看；',
      '- 表：先说比较对象是什么 → 每列指标什么意思、数值往哪个方向算好 → 在什么条件下比较 → 能得出什么结论；',
      '- 公式：先说它要计算或描述什么 → 逐个符号解释 → 讲清运算关系，必要时用一个简单数值走一遍。',
      '必须区分三件事：① 图表直接展示的事实；② 作者在正文里的解释；③ 你的推断（标「我的推断」）。',
      '如果抽取文本里缺图内标签、符号、图例或单位，明确说缺什么，不要补造。',
      '长度 1200–1800 字，不要超过 2000 字；数值例子最多一组。',
      '如果这一页还有别的图/表/公式，可以在 prt 的 chips 里给「换一个对象」的按钮。',
    ].join('\n')),
  },
];

export function teachingOpById(id) {
  return TEACHING_OPS.find((o) => o.id === id) || null;
}

/* ---------------------------------------------------------------- 续讲提示词 */

/** 「带我一步步读」：点「继续下一步」 */
export const WALK_CONTINUE_SYS = `${TEACHING_COMMON}

本次任务：接着上一条的阅读路线，只讲下一步。结构：
**第 N 步：步骤名**
- 现在要弄懂的问题；
- 去读哪里（章节 + 页码）；
- 核心解释（必要时一个小例子，标「教学例子」）；
- 和下一步的联系。
只讲当前这一步，不展开后面步骤，也不重复已经讲过的内容。控制在 500 字内。`;

/** 「带我一步步读」：讲简单一点 / 给个例子（不推进） */
export function walkReteachSys(kind) {
  const goal = kind === 'example'
    ? '用户想要一个具体例子。只重讲当前这一步，把抽象内容落到一个具体例子上（标「教学例子」），不要推进到下一步。'
    : '用户觉得这一步太难。只重讲当前这一步，换更简单、更基础的说法，必要时从一个最小例子讲起，不要推进到下一步。';
  return `${TEACHING_COMMON}

${goal}
控制在 500 字内。开头先一句「我们还在第 N 步」再讲，结尾说明懂了就可以点「继续下一步」。`;
}

/** 「我需要先懂什么」：用户点开其中一项 */
export const PREREQ_ONE_SYS = `${TEACHING_COMMON}

本次任务：只讲用户点开的这一项前置知识，把它讲到「能继续读论文」为止。
结构：
**它是什么**：两三句人话 + 一个最小例子（标「教学例子」）；
**为什么这篇论文需要它**：结合论文具体位置（章节 + 页码）说明；
**读到什么程度就够**：给可检查的边界；
**回到论文**：用论文里的公式或句子收尾，说明现在再去读那一段应该能看懂什么。
长度 700–1000 字。结尾不要问问题，告诉用户可以直接说「这个我懂了」或继续问。`;

/** 二次压缩（「再压短」按钮） */
export const CONDENSE_SYS = `你是论文阅读器里的「读懂论文」助手。用户觉得上一条回答太长，请把它压缩成原来的 60% 左右。
规则：
- 保留：结论、关键定义与公式、来源页码〔p.N〕、仍然必要的术语解释；
- 删除：重复、铺垫、教学例子里的展开、对下一步的邀请；不要新增内容、不要改变结论；
- 保留原来的小标题结构，但每段更短。用中文，公式照旧用 $...$ / $$...$$。只输出压缩后的正文，不要解释你删了什么。`;

/* ---------------------------------------------------------------- prt 隐藏块 */

const OPEN_FENCE = /(?:^|\n)[ \t]*`{3,}prt[ \t]*(?:\r?\n|$)/i;

/**
 * 流式时把还没写完的 prt 尾巴藏起来（避免用户看到半截 JSON）。
 * 收尾时用 `splitPrtBlock()` 正式解析并剥掉。
 */
export function hideStreamTail(raw) {
  const s = String(raw || '');
  const m = OPEN_FENCE.exec(s);
  if (m) return s.slice(0, m.index === 0 ? 0 : m.index);
  // 还没写到语言标记的围栏尾巴也先藏（结尾是 ``` / `` / ` 或 ```pr 这类）
  const tail = /(?:^|\n)[ \t]*`{1,3}(?:p)?(?:r)?(?:t)?[ \t]*$/.exec(s);
  if (tail) return s.slice(0, tail.index === 0 ? 0 : tail.index);
  return s;
}

const clip = (v, n) => String(v || '').trim().slice(0, n);

/** 把 chips 规范化成程序能安全渲染的数组（白名单字段） */
export function sanitiseChips(raw) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== 'object') continue;
    const label = clip(c.label, 12);
    const prompt = clip(c.prompt, 200);
    const op = ['evidence', 'limits'].includes(c.op) ? c.op : '';
    if (!label || (!prompt && !op)) continue;
    out.push({ label, prompt, op });
    if (out.length >= 4) break;
  }
  return out;
}

/** 把 profile 建议规范化（只留待确认所需字段） */
export function sanitiseProfileSuggestions(raw) {
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== 'object') continue;
    const topic = clip(p.topic, 120);
    if (!topic) continue;
    out.push({
      topic,
      level: clip(p.level, 300),
      boundary: clip(p.boundary, 2000),
      basis: 'inferred',
    });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 把回答拆成「正文 + prt 块」。
 * 只认**回答最末尾**的 prt 代码块；不合法/不在末尾就原样返回（正文照常显示）。
 * @returns {{text:string, chips:Array, profile:Array, ok:boolean}}
 */
export function splitPrtBlock(raw) {
  const s = String(raw || '');
  // 注意：OPEN_FENCE 没有 g，直接 exec 会原地返回同一个匹配 → 这里必须新建带 g 的副本。
  const fence = new RegExp(OPEN_FENCE.source, 'gi');
  let m;
  let last = null;
  let guard = 0;
  while ((m = fence.exec(s)) && guard++ < 50) {
    last = m;
    if (!m[0]) break;                       // 空匹配防御：不允许死循环
    fence.lastIndex = m.index + m[0].length;
  }
  if (!last) return { text: s, chips: [], profile: [], ok: false };
  const headEnd = last.index === 0 ? 0 : last.index;
  const bodyStart = last.index + last[0].length;
  // 找收尾围栏：必须是最后一行（后面只剩空白）
  const closeRe = /\n[ \t]*`{3,}[ \t]*(?=\s*$)/g;
  closeRe.lastIndex = bodyStart;
  const close = closeRe.exec(s);
  if (!close) return { text: s, chips: [], profile: [], ok: false };
  const jsonText = s.slice(bodyStart, close.index).trim();
  const text = s.slice(0, headEnd).trimEnd();
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return { text, chips: [], profile: [], ok: false }; }
  return {
    text,
    chips: sanitiseChips(parsed?.chips),
    profile: sanitiseProfileSuggestions(parsed?.profile),
    ok: true,
  };
}

/* ---------------------------------------------------------------- 清单条目 / 页面对象 */

const ITEM_HEADING_BLOCKLIST = new Set([
  '它是什么', '是什么', '为什么', '为什么这篇论文需要它', '用在哪里', '够了的标准', '读到什么程度就够',
  '门槛', '建议', '阅读路线', '第一步', '注意', '教学例子', '回到论文', '核心解释', '现在要弄懂的问题',
  '去读哪里', '和下一步的联系', '结论', '摘要',
]);

/**
 * 从「我需要先懂什么」的回答里提取清单项（prt chips 缺失时的兜底按钮来源）。
 * 支持 `名称（English）` 单独成行、以及 `- 名称` 两种写法。
 */
export function parsePrereqItems(text, max = 6) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const m = /^\s*(?:[-*+]\s*)?\*\*([^*\n]{2,80})\*\*\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].trim().replace(/[：:]\s*$/, '');
    if (!name || ITEM_HEADING_BLOCKLIST.has(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

const cleanSnippet = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const FORMULA_HINT = /[=＝^_∑√]|softmax|attention|^\s*[A-Za-z]\s*[（(]/i;

/**
 * 从一页文本里识别图 / 表 / 算法 / 公式编号，供「讲懂图表与公式」选择器用。
 * 抽取文本经常把标题拆行，所以宁可多列一点候选，让人来选。
 * @returns {Array<{kind:'figure'|'table'|'algorithm'|'formula', label:string, title:string, page:number|null, snippet:string}>}
 */
export function detectPageObjects(pageText, page = null) {
  const out = [];
  const pushIfNew = (obj) => {
    if (!obj || out.some((o) => o.label === obj.label)) return;
    out.push(obj);
  };
  const lines = String(pageText || '').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^\s*(Figure|Fig\.?|FIGURE)\s*(\d+)\b[\s.:：-]*(.*)$/.exec(line);
    if (m) {
      const title = cleanSnippet(`${m[3] || ''} ${lines[i + 1] || ''}`).slice(0, 120);
      pushIfNew({ kind: 'figure', label: `图 ${m[2]}`, title, page, snippet: cleanSnippet(line).slice(0, 160) });
      continue;
    }
    m = /^\s*(Table|TABLE)\s*(\d+)\b[\s.:：-]*(.*)$/.exec(line);
    if (m) {
      const title = cleanSnippet(`${m[3] || ''} ${lines[i + 1] || ''}`).slice(0, 120);
      pushIfNew({ kind: 'table', label: `表 ${m[2]}`, title, page, snippet: cleanSnippet(line).slice(0, 160) });
      continue;
    }
    m = /^\s*(Algorithm)\s*(\d+)\b[\s.:：-]*(.*)$/i.exec(line);
    if (m) {
      pushIfNew({ kind: 'algorithm', label: `算法 ${m[2]}`, title: cleanSnippet(m[3]).slice(0, 120), page, snippet: cleanSnippet(line).slice(0, 160) });
    }
    // 公式编号：行尾 (1) / （1），且附近（前两行 + 本行）有数学线索。
    // 抽取文本常把公式与编号拆成好几行，所以编号行本身可能只有几个字符。
    m = /[（(]\s*(\d{1,2})\s*[)）]\s*$/.exec(line);
    if (m) {
      const around = `${lines[i - 2] || ''} ${lines[i - 1] || ''} ${line}`;
      const body = [lines[i - 2], lines[i - 1], line].filter(Boolean).join(' ').trim();
      if (FORMULA_HINT.test(around) && around.replace(/\s+/g, '').length >= 8) {
        pushIfNew({ kind: 'formula', label: `公式 (${m[1]})`, title: cleanSnippet(body).slice(0, 120), page, snippet: cleanSnippet(body).slice(0, 160) });
      }
    }
  }
  return out.slice(0, 12);
}

/** 把整篇带页码标记的文本拆成 [{page, text}] */
export function splitPages(docText) {
  const text = String(docText || '');
  const re = /=====\s*p\.(\d+)\s*=====/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ page: Number(m[1]), at: m.index, bodyAt: m.index + m[0].length });
  if (!marks.length) return text.trim() ? [{ page: null, text }] : [];
  return marks.map((mk, i) => ({
    page: mk.page,
    text: text.slice(mk.bodyAt, i + 1 < marks.length ? marks[i + 1].at : text.length),
  }));
}

/** 取某一页的正文（找不到返回空串） */
export function pageTextOf(docText, page) {
  const pages = splitPages(docText);
  const hit = pages.find((p) => p.page === Number(page));
  return hit ? hit.text : '';
}

/** 全文图表公式清单（当前页识别不到时用；不默认分析整篇） */
export function collectDocObjects(docText) {
  const out = [];
  for (const page of splitPages(docText)) {
    for (const obj of detectPageObjects(page.text, page.page)) {
      if (out.some((o) => o.page === obj.page && o.label === obj.label)) continue;
      out.push(obj);
    }
  }
  return out;
}
