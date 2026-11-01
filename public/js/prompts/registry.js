/**
 * 提示词注册表（A 线 P1）。
 *
 * 一个 PromptDef = 一条会真正发给模型的提示词：
 *  - id / version（semver）/ kind；
 *  - system 块列表（固定顺序，渲染时跳过空块，用 systemJoin 连接）；
 *  - user 渲染函数；
 *  - history 渲染函数（各能力历史条数不同：问答 6 / 操作 4 / 教学 10）；
 *  - 材料、记忆、多模态、预算等声明字段（P1 只登记，P2/P3 才据此裁剪）。
 *
 * P1 的目标是「搬家 + 字节级一致」：定义的块顺序与旧实现完全一致，
 * 所以 `test/prompts.mjs` 的黄金快照必须 24/24 逐字节通过。
 */

/** 系统级版本：进入教学/索引等缓存键（P3 起统一使用） */
export const PROMPT_SYSTEM_VERSION = '2026.11.3';

const REQUIRED = ['id', 'version', 'kind', 'system', 'user'];

/** @type {Map<string, object>} */
const REGISTRY = new Map();

const SEMVER = /^\d+\.\d+\.\d+$/;

/** 注册一个 PromptDef（重复 id 直接报错，避免静默覆盖） */
export function definePrompt(def) {
  if (!def || typeof def !== 'object') throw new Error('PromptDef 必须是对象');
  for (const key of REQUIRED) {
    if (!(key in def)) throw new Error(`PromptDef 缺少字段 ${key}：${def.id || '(无 id)'}`);
  }
  if (!SEMVER.test(def.version)) throw new Error(`PromptDef ${def.id} 的 version 不是 semver：${def.version}`);
  if (REGISTRY.has(def.id)) throw new Error(`PromptDef 重复注册：${def.id}`);
  const normalized = {
    kind: 'qa',
    identity: '',
    systemJoin: '\n',
    history: null,
    materials: [],
    memory: [],
    historyMax: 0,
    multimodal: 'none',
    budget: {},
    tests: [],
    notes: '',
    compat: true,
    ...def,
  };
  REGISTRY.set(normalized.id, Object.freeze(normalized));
  PROMPT_MANIFEST[normalized.id] = normalized.version;
  return normalized;
}

export function getPromptDef(id) {
  const def = REGISTRY.get(id);
  if (!def) throw new Error(`未注册的 PromptDef：${id}`);
  return def;
}

export function hasPromptDef(id) {
  return REGISTRY.has(id);
}

export function listPrompts() {
  return [...REGISTRY.keys()];
}

/** { id: version }；测试断言它与设计文档一致，防止漏 bump。
 *  注意：它必须随 definePrompt 增量填充——各能力模块在 index.js 里后加载，
 *  如果只在这里一次性 getManifest() 会得到空表。 */
export const PROMPT_MANIFEST = {};

/** 重新生成并返回一份静态 manifest（调试/测试用） */
export function getManifest() {
  const out = {};
  for (const id of [...REGISTRY.keys()].sort()) out[id] = REGISTRY.get(id).version;
  return out;
}

/** FNV-1a 32 位：给日志/复现用的稳定短哈希（不进模型上下文） */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function promptHash(id, version, blocks) {
  return fnv1a(`${id}@${version}\n${blocks.join('\u0000')}`);
}
