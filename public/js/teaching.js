
/**
 * 「读懂论文」能力：提示词已迁到 ./prompts/（A 线 P1），本模块保留
 *  1) 能力清单（标题/hint/ask —— 假上游与 desktop.mjs 按「先给我讲明白」等字面量识别，不要搬走）；
 *  2) 解析器：prt 尾块、chips、清单项、页对象、分页（纯算法，与提示词无关）；
 *  3) 提示词版本号 TEACHING_PROMPT_VERSION（教学缓存键用，P3 换 PROMPT_SYSTEM_VERSION）。
 */
import {
  BASE_TEACH, PRT_SPEC, withProtocol, TEACH_TASKS,
  WALK_CONTINUE_SYS, walkReteachSys, PREREQ_ONE_SYS, CONDENSE_SYS,
} from './prompts/index.js';

export { TEACH_TASKS, WALK_CONTINUE_SYS, walkReteachSys, PREREQ_ONE_SYS, CONDENSE_SYS };

/** 提示词版本号：改了提示词就 +1，让教学类回答的缓存自动失效 */
export const TEACHING_PROMPT_VERSION = 't4';

/** 所有教学能力共用的底线（旧名保留，实现已迁 prompts/base.js） */
export const TEACHING_COMMON = BASE_TEACH;

export { PRT_SPEC };

/** 「先给我讲明白」的任务段（旧名保留；组装四项能力时用） */
export const TEACH_PLAN_TASK = TEACH_TASKS.intro;

/* ---------------------------------------------------------------- 四个能力的提示词 */

export const TEACHING_OPS = [
  {
    id: 'intro',
    promptId: 'teach.intro',
    icon: 'bolt',
    title: '先给我讲明白',
    hint: 'AI 结合论文内容、你的阅读位置和记忆，自己判断该怎么讲',
    ask: '先给我讲明白：这篇论文到底在做什么？',
    sys: withProtocol(TEACH_TASKS.intro),
  },
  {
    id: 'prereq',
    promptId: 'teach.prereq',
    icon: 'graduation',
    title: '我需要先懂什么',
    hint: '只挑读懂本文必需的前置知识，标「现在必须懂」',
    ask: '我需要先懂什么，才能读懂这篇论文？',
    sys: withProtocol(TEACH_TASKS.prereq),
  },
  {
    id: 'walk',
    promptId: 'teach.walk',
    icon: 'compass',
    title: '带我一步步读',
    hint: '先给路线，每次只讲一步，可继续',
    ask: '带我一步步读这篇论文：先给路线，再开始第一步。',
    sys: withProtocol(TEACH_TASKS.walk),
  },
  {
    id: 'visual',
    promptId: 'teach.visual',
    icon: 'chart',
    title: '讲懂图表与公式',
    hint: '默认从当前页选图 / 表 / 公式，讲清怎么看',
    ask: '讲懂当前页上的图表或公式。',
    sys: withProtocol(TEACH_TASKS.visual),
  },
];

export function teachingOpById(id) {
  return TEACHING_OPS.find((o) => o.id === id) || null;
}

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
