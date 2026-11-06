/**
 * 引用核验器（A 线 P1.5）：回答里的每一条〔p.N〕/〔p.N‖片段〕都必须由程序裁定，模型无权自造。
 *
 * 三档结果（docs/提示词工程-设计.md §19.2 B）：
 *  - ok       页码在本次可用集合内、片段能在页文本里逐字找到（允许 ±1 页容错、跨页续画）→ 正常渲染；
 *  - page-only 页码对但片段找不到（或扫描件没有可核对文本）→ 降级为纯页码按钮（只跳页、不画假高亮）；
 *  - drop     页码不在白名单 / 超出总页数 / 页码非法 → 不渲染按钮，保持原文文字。
 *
 * 纯函数 + 可注入 pageTextFor（浏览器里是 viewer.getPageText / 扫描件阅读索引），
 * 所以既能 E2E，也能被 test/citation-validator.mjs 在 Node 里单测。
 */
import { stripPageLabels } from './reading-context.js';

/** 与 app.js 的 decoratePageRefs 完全一致的引用语法（片段上限 8000，按可见文字另截断） */
export const CITATION_RE = /〔\s*p\.\s*(\d{1,4})\s*(?:[–\-—]\s*(\d{1,4}))?\s*(?:\|\||‖|｜)\s*([^〕]{1,8000})〕|〔\s*p\.\s*(\d{1,4})\s*(?:[–\-—]\s*(\d{1,4}))?\s*〕/g;

/** 组合引用：一个括号里用逗号/顿号/分号分隔多个页码（可带范围），如〔p.21–26, p.23, p.37〕 */
export const CITATION_LIST_RE = /〔\s*p\s*\.\s*\d{1,4}(?:\s*[–\-—]\s*\d{1,4})?(?:\s*[,，、;；]\s*p\s*\.\s*\d{1,4}(?:\s*[–\-—]\s*\d{1,4})?)+\s*〕/g;
const CITATION_ITEM_RE = /p\s*\.\s*(\d{1,4})(?:\s*[–\-—]\s*(\d{1,4}))?/g;
/** plan 查表键：去掉空白，保证解析与渲染两侧一致 */
const citationKey = (s) => String(s || '').replace(/\s+/g, '');

/** 解析回答里的全部引用（保留原始文本，渲染器按 raw 对齐） */
export function parseCitations(text) {
  const out = [];
  const s = String(text || '');
  const re = new RegExp(CITATION_RE.source, 'g');
  let m;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 500) {
    const a = m[1] || m[4];
    const b = m[1] ? m[2] : m[5];
    const fragment = (m[3] || '').trim();
    if (!a) continue;
    out.push({
      raw: m[0],
      index: m.index,
      page: Number(a),
      pageEnd: b ? Number(b) : null,
      fragment,
    });
    if (!m[0]) break;
  }
  // 组合引用展开成逐项，渲染器按单项 raw 查 plan（与单条引用共用同一套校验结果）
  const listRe = new RegExp(CITATION_LIST_RE.source, 'g');
  guard = 0;
  while ((m = listRe.exec(s)) && guard++ < 100) {
    const itemRe = new RegExp(CITATION_ITEM_RE.source, 'g');
    let im;
    let items = 0;
    while ((im = itemRe.exec(m[0])) && items++ < 100) {
      if (!im[1]) continue;
      out.push({
        raw: citationKey(im[0]),
        index: m.index + im.index,
        page: Number(im[1]),
        pageEnd: im[2] ? Number(im[2]) : null,
        fragment: '',
      });
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** 片段的比对口径：去掉空白与页码标签，统一引号大小写；只做「是否逐字出现」的判断 */
export function normalizeMatchText(text) {
  return stripPageLabels(String(text || ''))
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .toLowerCase();
}

/** 渲染成 prompt 里的「可用页码」文本：p.1、p.3–p.5、p.12 */
export function formatPageList(pages) {
  const nums = [...new Set((Array.isArray(pages) ? pages : [...(pages || [])])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  if (!nums.length) return '';
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? `p.${start}` : `p.${start}–p.${prev}`);
    start = n; prev = n;
  }
  return parts.join('、');
}

/** 从 `===== p.N =====` 之类分页文本里取页码集合 */
export function pagesFromText(text) {
  const out = new Set();
  const re = /=====\s*p\.(\d+)\s*=====/g;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s))) out.add(Number(m[1]));
  return out;
}

/** 从若干段上下文文本里取 `[第 N 页]` / `第 N 页` 标记 */
export function pagesFromContexts(contexts = []) {
  const out = new Set();
  for (const text of Array.isArray(contexts) ? contexts : [contexts]) {
    for (const m of String(text || '').matchAll(/\[?第\s*(\d{1,4})\s*页\]?/g)) out.add(Number(m[1]));
  }
  return out;
}

/**
 * 计算「本次材料里真实提供的页码」（白名单的唯一来源，程序事实而不是模型记忆）。
 * @returns {number[]} 升序去重
 */
export function collectAvailablePages({
  fullText = '', pageImages = [], contexts = [], selectionPage = null, focusPage = null,
  currentPage = null, references = [], scanPages = [], extra = [],
} = {}) {
  const set = new Set();
  for (const p of pagesFromText(fullText)) set.add(p);
  for (const im of Array.isArray(pageImages) ? pageImages : []) if (im?.page) set.add(Number(im.page));
  for (const p of pagesFromContexts(contexts)) set.add(p);
  for (const p of Array.isArray(scanPages) ? scanPages : []) if (p) set.add(Number(p));
  for (const p of Array.isArray(extra) ? extra : []) if (p) set.add(Number(p));
  for (const p of [selectionPage, focusPage, currentPage]) if (p) set.add(Number(p));
  for (const r of Array.isArray(references) ? references : []) if (r?.page) set.add(Number(r.page));
  return [...set].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
}

/** 片段是否能在（可能跨页的）正文里逐字找到 */
function fragmentFoundIn(text, fragment) {
  const hay = normalizeMatchText(text);
  const needle = normalizeMatchText(fragment);
  if (!needle || !hay) return false;
  if (hay.includes(needle)) return true;
  // 片段可能被模型截断在中间：至少命中前 80% 才算（避免「找到一半就画假高亮」）
  const cut = Math.floor(needle.length * 0.8);
  if (cut >= 8 && hay.includes(needle.slice(0, cut))) return true;
  return false;
}

/**
 * 校验回答里的全部引用。
 * @param {string} answer 模型输出正文
 * @param {object} opts
 * @param {number} [opts.totalPages] 文档总页数（0/缺省则不检查越界）
 * @param {Set<number>|number[]} [opts.availablePages] 本次可用页码（null = 不检查白名单）
 * @param {(page:number)=>string|Promise<string>} [opts.pageTextFor] 取某页可核对文本
 * @param {boolean} [opts.scanned] 扫描件：无文本时只能降级为纯页码
 * @returns {Promise<{items:Array, stats:{total:number, ok:number, degraded:number, dropped:number}, plan:Map}>}
 */
export async function validateCitations(answer, {
  totalPages = 0, availablePages = null, pageTextFor = null, scanned = false,
} = {}) {
  const citations = parseCitations(answer);
  const allowed = availablePages == null ? null
    : new Set(Array.isArray(availablePages) ? availablePages : [...availablePages]);
  const cache = new Map();
  const getText = async (page) => {
    if (!pageTextFor) return '';
    if (!cache.has(page)) {
      let text = '';
      try { text = String((await pageTextFor(page)) || ''); } catch { text = ''; }
      cache.set(page, text);
    }
    return cache.get(page);
  };
  const items = [];
  for (const citation of citations) {
    const pages = [citation.page];
    if (citation.pageEnd) {
      for (let p = citation.page + 1; p <= Math.min(citation.pageEnd, citation.page + 50); p++) pages.push(p);
    }
    const outOfRange = pages.some((p) => !Number.isInteger(p) || p < 1 || (totalPages && p > totalPages));
    const notAllowed = allowed ? pages.some((p) => !allowed.has(p)) : false;
    if (outOfRange || notAllowed) {
      items.push({ ...citation, level: 'drop', reason: outOfRange ? 'out-of-range' : 'not-available' });
      continue;
    }
    if (!citation.fragment) {
      items.push({ ...citation, level: 'ok', match: 'page-only' });
      continue;
    }
    // 文本型 PDF：整串匹配 + ±1 页容错 + 跨页续画
    const first = citation.page;
    const own = await getText(first);
    if (!own) {
      items.push({ ...citation, level: 'page-only', reason: scanned ? 'scanned-no-text' : 'no-page-text' });
      continue;
    }
    let found = fragmentFoundIn(own, citation.fragment);
    if (!found) {
      for (const neighbor of [first - 1, first + 1]) {
        if (neighbor < 1 || (totalPages && neighbor > totalPages)) continue;
        if (fragmentFoundIn(await getText(neighbor), citation.fragment)) { found = true; break; }
      }
    }
    if (!found) {
      // 跨页续画：本页 + 下一页拼起来再找一次
      const next = first + 1;
      if (!(totalPages && next > totalPages)) {
        const joined = `${own}\n${await getText(next)}`;
        found = fragmentFoundIn(joined, citation.fragment);
      }
    }
    items.push(found
      ? { ...citation, level: 'ok', match: 'fragment' }
      : { ...citation, level: 'page-only', reason: 'fragment-not-found' });
  }
  const stats = {
    total: items.length,
    ok: items.filter((x) => x.level === 'ok').length,
    degraded: items.filter((x) => x.level === 'page-only').length,
    dropped: items.filter((x) => x.level === 'drop').length,
  };
  const plan = new Map();
  for (const item of items) plan.set(item.raw, item);
  return { items, stats, plan };
}

/** 给渲染器用的查表键：同一条引用在流式/收尾两次渲染里文本一致，直接按 raw 对齐即可 */
export function planFor(plan, raw) {
  return plan instanceof Map ? plan.get(raw) || null : null;
}
