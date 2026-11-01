/**
 * 提示词装配器（composePrompt）：把 PromptDef 按固定顺序渲染成 messages。
 *
 * - system 块：字符串或 (ctx)=>string；空块自动跳过；用 def.systemJoin 连接（P1 兼容期各能力不同）；
 * - history：def.history(ctx) 返回历史消息数组（问答 6 / 操作 4 / 教学 10，收口在 history.js）；
 * - user：def.user(ctx) 返回最后一条 user 消息；
 * - 每次渲染产出 debug（id/version/hash/tokens/blocks），**不进模型上下文**，只给日志/复现用。
 *
 * L0 身份 → L1 基础规则 → L2 任务 → L3 引用/多模态契约 → L4 记忆 → L5 当前时间
 * 这个固定顺序在 P1 就体现在各 PromptDef 的 system 块顺序里；P2 才抽成公共装配线。
 */
import { getPromptDef, promptHash } from './registry.js';
import { estimateMessagesTokens } from './budget.js';

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

/** 直接渲染一个 def 对象（不要求在 registry 里；兼容「ad-hoc sys」旧调用点） */
export function renderDef(def, ctx = {}) {
  const blocks = renderBlocks(def.system, ctx);
  const system = blocks.join(def.systemJoin ?? '\n');
  const history = typeof def.history === 'function' ? def.history(ctx) : [];
  const user = typeof def.user === 'function' ? def.user(ctx) : String(def.user ?? '');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: user });
  const debug = {
    id: def.id || '(ad-hoc)',
    version: def.version || '0.0.0',
    kind: def.kind || 'qa',
    compat: def.compat !== false,
    blocks: blocks.length,
    hash: promptHash(def.id || '(ad-hoc)', def.version || '0.0.0', blocks),
    tokens: estimateMessagesTokens(messages, { images: ctx.pageImages?.length || 0 }),
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
/** 最近一次渲染的 manifest（开发者调试用，不渲染给用户） */
export function lastPromptDebug() {
  return lastDebug;
}
export function noteDebug(debug) {
  lastDebug = debug;
}
