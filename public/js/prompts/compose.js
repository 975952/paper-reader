/**
 * 提示词装配器（composePrompt）：把 PromptDef 按固定顺序渲染成 messages，并做预算裁剪。
 *
 * - system 块：字符串或 (ctx)=>string；空块自动跳过；用 def.systemJoin 连接；
 * - history：def.history(ctx) 返回历史消息数组（问答 6 / 操作 4 / 教学 10，收口在 history.js）；
 * - user：def.user(ctx) 返回最后一条 user 消息；
 * - **预算裁剪（A 线 P3）**：超过 HARD_TOKENS 时按设计 §9.2 的固定顺序裁剪
 *   （联网 → 参考 → 全文 → 页上下文 → 画像 → 长期记忆 → 历史 → 会话摘要），
 *   问题 / 选区 / 页头 / 系统规则永不裁剪；每次裁剪记进 debug.trim。
 * - 每次渲染产出 debug（id/version/hash/tokens/trim），**不进模型上下文**，只给日志/复现用。
 */
import { getPromptDef, promptHash } from './registry.js';
import { HARD_TOKENS, estimateMessagesTokens, estimateTokens, TRIM_ORDER } from './budget.js';

/** 渲染块列表：默认跳过空字符串（旧的 filter(Boolean) 行为）；raw 块保留空串（兼容旧 join 的连续换行） */
export function renderBlocks(blocks = [], ctx = {}) {
  const out = [];
  for (const block of blocks) {
    if (!block) continue;
    const value = typeof block.fn === 'function' ? block.fn(ctx) : block.text;
    if (typeof value !== 'string') continue;
    if (!value && !block.raw) continue;
    out.push(value);
  }
  return out;
}

const clipMid = (text, max) => {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 3;
  return `${s.slice(0, head)}…（中间省略）…${s.slice(s.length - tail)}`;
};

/** 一块材料里的某个段落做 head+tail 截断；保持围栏/标题不破 */
function clipSection(content, headMarker, max) {
  const text = String(content || '');
  const at = text.indexOf(headMarker);
  if (at < 0) return content;
  const before = text.slice(0, at);
  const section = text.slice(at);
  if (section.length <= max) return content;
  return `${before}${clipMid(section, max)}`;
}

/** 联网结果：只裁「联网块本身」（从末条开始删、摘录 ≤2000 字），联网块之后的材料与问题原样保留 */
function trimWeb(content) {
  const text = String(content || '');
  const at = text.indexOf('【联网搜索结果】');
  if (at < 0) return content;
  const before = text.slice(0, at);
  // 联网块以「（引用联网结果时只能写…）」那一行结束；之后的可用页码/本轮要求/问题都不动
  const noteAt = text.indexOf('（引用联网结果时', at);
  let webEnd = text.length;
  if (noteAt >= 0) {
    const lineEnd = text.indexOf('\n', noteAt);
    webEnd = lineEnd >= 0 ? lineEnd : text.length;
  }
  const after = text.slice(webEnd);
  let section = text.slice(at, webEnd);
  section = section.replace(/(【搜索摘录】|【原论文摘要】)([\s\S]*?)(?=\n\[来源|\n（引用联网结果时|$)/g,
    (m0, kind, body) => `${kind}${clipMid(body, 2000)}`);
  const blocks = section.split(/\n\n(?=\[来源)/);
  while (blocks.length > 2 && (before + blocks.join('\n\n')).length > 12000) blocks.pop();
  return before + blocks.join('\n\n') + after;
}

/** 参考文献：只留前 3 条；后面的材料与【问题】原样保留 */
function trimReferences(content) {
  const text = String(content || '');
  const head = '【选区涉及的参考文献 · 书目信息，不代表技术细节】';
  const at = text.indexOf(head);
  if (at < 0) return content;
  const before = text.slice(0, at);
  const lines = text.slice(at).split('\n');
  let seen = 0;
  let cut = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^\[\d+\]/.test(lines[i])) {
      seen += 1;
      if (seen === 4) { cut = i; break; }
    }
  }
  if (cut < 0) return content;
  let resume = cut;
  while (resume < lines.length && /^\[\d+\]/.test(lines[resume])) resume += 1;
  return before + [...lines.slice(0, cut), ...lines.slice(resume)].join('\n');
}

/** 全文：按页标记从尾部删页；没有页标记就砍尾部一半 */
function trimFullText(content) {
  const text = String(content || '');
  const head = text.indexOf('【论文全文');
  if (head < 0) return content;
  const fenceOpen = text.indexOf('\n"""\n', head);
  if (fenceOpen < 0) return content;
  const bodyStart = fenceOpen + 5;
  const fenceClose = text.lastIndexOf('\n"""');
  if (fenceClose < bodyStart) return content;
  const before = text.slice(0, bodyStart);
  const after = text.slice(fenceClose);
  let body = text.slice(bodyStart, fenceClose);
  const pages = body.split(/(?====== p\.)/);
  if (pages.length > 2) {
    pages.splice(Math.max(2, Math.ceil(pages.length * 0.75)));
    body = pages.join('');
  } else {
    body = body.slice(0, Math.floor(body.length / 2));
  }
  return `${before}${body}${after}`;
}

/** 所在页上下文 / 话题页上下文：8000 → 4000 → 2000 字符 */
function trimPageContext(content) {
  const text = String(content || '');
  const re = /【[^】]*上下文[^】]*】\n"""[\s\S]*?"""/g;
  let changed = false;
  const next = text.replace(re, (block) => {
    if (block.length <= 8000) return block;
    const target = block.length > 16000 ? 2000 : block.length > 8000 ? 4000 : 8000;
    changed = true;
    return clipMid(block, Math.min(block.length, target));
  });
  return changed ? next : content;
}

/** 画像条目：先删「推测，依据有限」，再「用户自述」，再「仍需讲解」 */
function trimProfileItems(content) {
  const text = String(content || '');
  const at = text.indexOf('【后台学习记忆');
  if (at < 0) return content;
  const before = text.slice(0, at);
  const lines = text.slice(at).split('\n');
  const dropOrder = ['推测，依据有限', '用户自述，未独立验证', '用户表示仍需讲解', '本次对话中正确运用'];
  for (const tag of dropOrder) {
    if (lines.length <= 8) break;
    const idx = lines.findIndex((line, i) => i > 6 && line.includes(tag));
    if (idx >= 0) lines.splice(idx, 1);
  }
  return before + lines.join('\n');
}

/** 会话摘要块：1200 → 600 */
function trimSessionSummary(content) {
  const text = String(content || '');
  const at = text.indexOf('【本次会话摘要');
  if (at < 0) return content;
  const before = text.slice(0, at);
  const section = text.slice(at);
  if (section.length <= 1200) return content;
  return before + clipMid(section, 600);
}

const TRIM_STEPS = {
  web: trimWeb,
  references: trimReferences,
  fulltext: trimFullText,
  pageContext: trimPageContext,
  profileItems: trimProfileItems,
  sessionSummary: trimSessionSummary,
};

/**
 * 预算裁剪：超硬上限时按 TRIM_ORDER 的顺序逐块裁剪，裁到上限以内就停。
 * 永不裁剪：system、最后一条 user 的问题/选区/页头（只裁材料块）。
 * @returns {{messages:Array, trimmed:boolean, trims:Array, tokens:number}}
 */
export function fitMessages(messages = [], { maxTokens = HARD_TOKENS } = {}) {
  const out = messages.map((m) => ({ ...m }));
  const trims = [];
  let tokens = estimateMessagesTokens(out);
  if (tokens <= maxTokens) return { messages: out, trimmed: false, trims, tokens };

  // 1) 历史：从最旧一轮开始成对删（保留 system 与最后一条 user）
  while (tokens > maxTokens && out.length > 2) {
    const idx = out.findIndex((m, i) => i > 0 && m.role !== 'system');
    if (idx < 0) break;
    const pair = out.splice(idx, out[idx + 1]?.role === 'assistant' ? 2 : 1);
    trims.push({ block: 'history', removed: pair.length });
    tokens = estimateMessagesTokens(out);
  }

  // 2) 最后一条 user 的材料：按固定顺序逐块裁
  const lastIndex = out.length - 1;
  const last = out[lastIndex];
  if (typeof last?.content === 'string') {
    let content = last.content;
    for (const name of TRIM_ORDER) {
      if (tokens <= maxTokens) break;
      const fn = TRIM_STEPS[name];
      if (!fn) continue;
      const next = fn(content);
      if (next === content) continue;
      content = next;
      out[lastIndex] = { ...last, content };
      trims.push({ block: name, chars: content.length });
      tokens = estimateMessagesTokens(out);
    }
    // 3) 最后兜底：只保留问题 + 材料头尾（问题块本身在尾部，必须保留）
    while (tokens > maxTokens && content.length > 4000) {
      content = clipMid(content, Math.floor(content.length * 0.7));
      out[lastIndex] = { ...last, content };
      trims.push({ block: 'user-fallback', chars: content.length });
      tokens = estimateMessagesTokens(out);
    }
  }
  return { messages: out, trimmed: trims.length > 0, trims, tokens };
}

/** 直接渲染一个 def 对象（不要求在 registry 里；兼容「ad-hoc sys」旧调用点） */
export function renderDef(def, ctx = {}) {
  const blocks = renderBlocks(def.system, ctx);
  const system = blocks.join(def.systemJoin ?? '\n');
  const history = typeof def.history === 'function' ? def.history(ctx) : [];
  const user = typeof def.user === 'function' ? def.user(ctx) : String(def.user ?? '');
  const raw = [];
  if (system) raw.push({ role: 'system', content: system });
  for (const m of history) raw.push({ role: m.role, content: m.content });
  raw.push({ role: 'user', content: user });
  const budget = ctx.budget === false ? { messages: raw, trimmed: false, trims: [], tokens: estimateMessagesTokens(raw) } : fitMessages(raw);
  const messages = budget.messages;
  const debug = {
    id: def.id || '(ad-hoc)',
    version: def.version || '0.0.0',
    kind: def.kind || 'qa',
    compat: def.compat !== false,
    blocks: blocks.length,
    hash: promptHash(def.id || '(ad-hoc)', def.version || '0.0.0', blocks),
    tokens: budget.tokens,
    trim: budget.trims,
    trimmed: budget.trimmed,
    chars: blocks.reduce((n, b) => n + b.length, 0) + user.length,
    systemChars: system.length,
    userChars: user.length,
  };
  return { messages, debug };
}

/** 渲染一个已注册的 PromptDef（推荐入口） */
export function renderPrompt(id, ctx = {}) {
  return renderDef(getPromptDef(id), ctx);
}

/** 只要 messages（旧导出函数的兼容壳都走这里） */
export function composePrompt(id, ctx = {}) {
  return renderPrompt(id, ctx).messages;
}

let lastDebug = null;
/** 最近一次渲染的 manifest（开发者调试用，不渲染给用户；配 window.__ctx.promptDebug 只读查看） */
export function lastPromptDebug() {
  return lastDebug;
}
export function noteDebug(debug) {
  lastDebug = debug;
}

export { estimateTokens, TRIM_ORDER };
