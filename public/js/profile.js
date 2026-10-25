/**
 * 学习档案（轻量，不是知识库）
 *
 * 设计口径（docs/读懂论文-设计.md §4）：
 *   · 只记录「知识点 + 理解程度 + 具体边界 + 判断依据 + 时间」，不给「已掌握」打勾；
 *   · AI 只能写 pending（待确认），确认只能由用户点「这个我懂了」；
 *   · 每条写入都带时间；每次 AI 调用另外注入「当前时间」；
 *   · 条目按当前论文/问题筛选后才进 prompt，整块封顶 1200 字。
 *
 * 存储：本机 `data/learning-profile.json`（GET/POST /api/profile）。
 * 本模块只做数据与提示词，不碰 DOM。
 */

export const PROFILE_VERSION = 1;
export const STALE_DAYS = 90;
export const PROFILE_CHAR_LIMIT = 1200;
export const MAX_ITEMS = 200;
export const MAX_PENDING_SUGGESTIONS = 3;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');

/* ---------------------------------------------------------------- 时间工具 */

/** 本地时区偏移，形如 +08:00 / -05:00 */
export function tzOffset(date = new Date()) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 带本地时区的 ISO 时间：2026-10-24T12:31:05+08:00 */
export function nowISO(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${tzOffset(date)}`;
}

/** 展示用日期：2026-10-24 */
export function isoDate(value) {
  const s = String(value || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/**
 * 每次 AI 调用都要带的「当前时间」行。
 * 用户口径：「现在的时间在后续过程中要交给模型」——模型需要知道今天是几号，
 * 才能判断档案里「3 个月前确认过」意味着什么。
 */
export function nowContext(date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `【当前时间】${stamp}（周${WEEKDAYS[date.getDay()]}，UTC${tzOffset(date)}）`;
}

/** 距某条时间过了多少天；无效时间返回 null */
export function daysSince(value, now = new Date()) {
  const t = Date.parse(String(value || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 86400000));
}

/** 档案展示用的「最近更新」：刚更新 / N 天前 / N 个月前 */
export function relativeLabel(value, now = new Date()) {
  const days = daysSince(value, now);
  if (days === null) return '';
  if (days <= 0) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${Math.round(days / 365)} 年前`;
}

/**
 * 时间新鲜度分层——**由代码算好再交给模型**，不让模型自己做日期减法。
 * @returns {{days:number|null, tier:'fresh'|'aging'|'stale'|'pending', label:string, note:string}}
 */
export function staleness(item, now = new Date()) {
  if (!item || item.status === 'pending' || !item.lastConfirmedAt) {
    return { days: null, tier: 'pending', label: '待确认', note: '用户尚未确认 → 不能当作已掌握' };
  }
  const days = daysSince(item.lastConfirmedAt, now);
  if (days === null) return { days: null, tier: 'pending', label: '时间未知', note: '确认时间无法解析 → 按可能生疏处理' };
  if (days <= 30) return { days, tier: 'fresh', label: '较新', note: '' };
  if (days <= STALE_DAYS) return { days, tier: 'aging', label: '有一阵没确认', note: '本文用法超出所记边界时要补讲' };
  return { days, tier: 'stale', label: '可能生疏', note: `超过 ${STALE_DAYS} 天未确认 → 按可能生疏处理，先简短确认再跳过` };
}

/* ---------------------------------------------------------------- 数据模型 */

export function emptyProfile() {
  return { version: PROFILE_VERSION, revision: 0, updatedAt: '', selfReport: '', selfReportAt: '', items: [] };
}

export function uid(prefix = 'kp') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 主题归一化：去空白、小写、去掉末尾标点，用于去重/匹配 */
export function normalTopic(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_/·、，,。.：:；;（）()【】\[\]]+/g, '');
}

/**
 * 「同一个知识点」的宽松判断：归一化后相等，或者一个是另一个的前缀/后缀。
 * 例：`注意力机制` 与 `注意力机制（Attention）` 视为同一条；
 * 但 `注意力机制` 与 `多头注意力` 不合并（两者边界不同）。
 */
export function similarTopic(a, b) {
  const x = normalTopic(a);
  const y = normalTopic(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2) return false;
  return long.startsWith(short) || long.endsWith(short);
}

/** 在档案里找同主题条目（宽松匹配） */
export function findSimilarItem(profile, topic) {
  return profile.items.find((i) => similarTopic(i.topic, topic)) || null;
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const isIsoLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$/.test(v);

/**
 * 校验一份档案。返回 `{ ok, data }` 或 `{ ok:false, error }`。
 * 客户端与服务端共用同一套口径（Node / Rust 两端各实现一遍，字段一致）。
 */
export function validateProfile(raw) {
  if (!isObject(raw)) return { ok: false, error: '档案不是对象' };
  if (Number(raw.version) !== PROFILE_VERSION) return { ok: false, error: `版本不支持：${raw.version}` };
  const items = Array.isArray(raw.items) ? raw.items : null;
  if (!items) return { ok: false, error: 'items 必须是数组' };
  if (items.length > MAX_ITEMS) return { ok: false, error: `条目超过 ${MAX_ITEMS} 条` };
  const out = [];
  for (const it of items) {
    if (!isObject(it)) return { ok: false, error: '条目必须是对象' };
    const topic = str(it.topic).trim().slice(0, 120);
    if (!topic) return { ok: false, error: '条目缺少 topic' };
    const status = it.status === 'pending' ? 'pending' : it.status === 'confirmed' ? 'confirmed' : null;
    if (!status) return { ok: false, error: `条目状态不合法：${it.status}` };
    const basis = ['user_confirmed', 'user_self_report', 'model_inferred'].includes(it.basis) ? it.basis : 'user_confirmed';
    const aliases = (Array.isArray(it.aliases) ? it.aliases : []).filter((a) => typeof a === 'string' && a.trim())
      .slice(0, 8).map((a) => a.trim().slice(0, 120));
    const createdAt = isIsoLike(it.createdAt) ? it.createdAt : nowISO();
    const updatedAt = isIsoLike(it.updatedAt) ? it.updatedAt : createdAt;
    out.push({
      id: typeof it.id === 'string' && it.id.trim() ? it.id.trim().slice(0, 80) : uid(),
      topic,
      aliases,
      level: str(it.level).trim().slice(0, 300),
      boundary: str(it.boundary).trim().slice(0, 2000),
      basis,
      status,
      createdAt,
      updatedAt,
      lastConfirmedAt: isIsoLike(it.lastConfirmedAt) ? it.lastConfirmedAt : null,
      source: isObject(it.source) ? {
        docId: str(it.source.docId).slice(0, 120),
        paper: str(it.source.paper).slice(0, 300),
        capability: str(it.source.capability).slice(0, 40),
      } : null,
      note: str(it.note).trim().slice(0, 2000),
    });
  }
  return {
    ok: true,
    data: {
      version: PROFILE_VERSION,
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      updatedAt: isIsoLike(raw.updatedAt) ? raw.updatedAt : '',
      selfReport: str(raw.selfReport).trim().slice(0, 4000),
      selfReportAt: isIsoLike(raw.selfReportAt) ? raw.selfReportAt : '',
      items: out,
    },
  };
}

/* ---------------------------------------------------------------- 读取 / 保存 */

const PROFILE_API = '/api/profile';

/** UI 上的个性化开关（localStorage；关掉后不注入、不写 pending） */
export const PROFILE_PREF_KEY = 'reader.profilePersonal';

function readEnabled() {
  try {
    const v = localStorage.getItem(PROFILE_PREF_KEY);
    return v === null ? true : v === '1';
  } catch { return true; }
}
function writeEnabled(on) {
  try { localStorage.setItem(PROFILE_PREF_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/**
 * 档案的唯一入口。启动时 load() 一次；之后所有修改都走这里（乐观更新 + 落盘）。
 * 不是响应式框架：改完调用方自己重新渲染菜单/弹窗即可。
 */
export const profileStore = {
  data: emptyProfile(),
  loaded: false,
  error: '',
  enabled: readEnabled(),

  setEnabled(on) {
    this.enabled = !!on;
    writeEnabled(this.enabled);
  },

  async load() {
    try {
      const r = await fetch(PROFILE_API);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = validateProfile(await r.json());
      if (!parsed.ok) throw new Error(parsed.error);
      this.data = parsed.data;
      this.error = '';
    } catch (e) {
      this.data = emptyProfile();
      this.error = `学习档案读取失败：${e.message || e}`;
    }
    this.loaded = true;
    return this.data;
  },

  /** 保存整份档案；失败时回滚到快照并抛出，让调用方 toast */
  async save(next) {
    const before = this.data;
    const candidate = {
      ...next,
      version: PROFILE_VERSION,
      revision: (before.revision || 0) + 1,
      updatedAt: nowISO(),
    };
    const parsed = validateProfile(candidate);
    if (!parsed.ok) throw new Error(`学习档案校验失败：${parsed.error}`);
    this.data = parsed.data;
    try {
      const r = await fetch(PROFILE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || `HTTP ${r.status}`);
      }
      return this.data;
    } catch (e) {
      this.data = before;
      throw e;
    }
  },

  isEmpty() {
    return !this.data.selfReport && !this.data.items.length;
  },
};

/* ---------------------------------------------------------------- 变更操作 */

/** 深拷贝一份可编辑的档案（数组/对象都是浅层结构，够用） */
function clone(profile) {
  return { ...profile, items: profile.items.map((it) => ({ ...it, aliases: [...(it.aliases || [])], source: it.source ? { ...it.source } : null })) };
}

export function summary(profile = profileStore.data) {
  const confirmed = profile.items.filter((i) => i.status === 'confirmed').length;
  const pending = profile.items.filter((i) => i.status === 'pending').length;
  const latest = [...profile.items].map((i) => i.lastConfirmedAt).filter(Boolean).sort().pop() || profile.selfReportAt || '';
  return { confirmed, pending, latest, isEmpty: !profile.selfReport && !profile.items.length };
}

/** 记一条确认（用户点「这个我懂了」/自己填写/纠正边界都算一次确认） */
export function withConfirmed(profile, { topic, level = '', boundary = '', source = null }) {
  const next = clone(profile);
  const now = nowISO();
  let item = findSimilarItem(next, topic);
  if (item) {
    item.topic = String(topic).trim();
    if (level) item.level = String(level).trim();
    if (boundary) item.boundary = String(boundary).trim();
    item.status = 'confirmed';
    item.basis = 'user_confirmed';
    item.lastConfirmedAt = now;
    item.updatedAt = now;
    if (source) item.source = source;
  } else {
    item = {
      id: uid(), topic: String(topic).trim(), aliases: [], level: String(level || '').trim(),
      boundary: String(boundary || '').trim(), basis: 'user_confirmed', status: 'confirmed',
      createdAt: now, updatedAt: now, lastConfirmedAt: now, source, note: '',
    };
    next.items.push(item);
  }
  return { profile: next, item };
}

/** 确保一条「还不会」的记录（用户点「还不会」/「这里没懂」时用） */
export function withNotKnown(profile, { topic, source = null }) {
  const next = clone(profile);
  const now = nowISO();
  let item = findSimilarItem(next, topic);
  if (item) {
    item.level = '还不会（用户确认）';
    item.status = 'confirmed';
    item.basis = 'user_confirmed';
    item.lastConfirmedAt = now;
    item.updatedAt = now;
    if (!item.boundary) item.boundary = '需要从基础讲起';
  } else {
    item = {
      id: uid(), topic: String(topic).trim(), aliases: [], level: '还不会（用户确认）',
      boundary: '需要从基础讲起', basis: 'user_confirmed', status: 'confirmed',
      createdAt: now, updatedAt: now, lastConfirmedAt: now, source, note: '',
    };
    next.items.push(item);
  }
  return { profile: next, item };
}

/** 用户手动编辑（编辑后视为一次新确认——用户纠正了边界） */
export function withEdited(profile, id, patch = {}) {
  const next = clone(profile);
  const item = next.items.find((i) => i.id === id);
  if (!item) return next;
  const now = nowISO();
  for (const key of ['topic', 'level', 'boundary', 'aliases']) {
    if (patch[key] === undefined) continue;
    if (key === 'aliases') item.aliases = (Array.isArray(patch.aliases) ? patch.aliases : []).map((a) => String(a).trim()).filter(Boolean);
    else item[key] = String(patch[key]).trim();
  }
  item.updatedAt = now;
  if (patch.touchConfirmed !== false) item.lastConfirmedAt = now;
  return next;
}

export function withDeleted(profile, id) {
  const next = clone(profile);
  next.items = next.items.filter((i) => i.id !== id);
  return next;
}

/** 待确认条目 → 确认掌握 */
export function withPendingConfirmed(profile, id) {
  const next = clone(profile);
  const item = next.items.find((i) => i.id === id);
  if (!item) return next;
  const now = nowISO();
  item.status = 'confirmed';
  item.basis = 'user_confirmed';
  item.lastConfirmedAt = now;
  item.updatedAt = now;
  return next;
}

/** 待确认条目 → 还不会（保留记录，让 AI 以后从基础讲） */
export function withPendingRejected(profile, id) {
  const next = clone(profile);
  const item = next.items.find((i) => i.id === id);
  if (!item) return next;
  const now = nowISO();
  item.status = 'confirmed';
  item.basis = 'user_confirmed';
  item.level = '还不会（用户确认）';
  if (!item.boundary) item.boundary = '需要从基础讲起';
  item.lastConfirmedAt = now;
  item.updatedAt = now;
  return next;
}

/** 待确认条目 → 删除 */
export function withPendingDeleted(profile, id) {
  return withDeleted(profile, id);
}

export function withSelfReport(profile, text) {
  const next = clone(profile);
  next.selfReport = String(text || '').trim().slice(0, 4000);
  next.selfReportAt = next.selfReport ? nowISO() : '';
  return next;
}

/**
 * 把模型建议的条目并进档案——**只写 pending**，不写确认。
 * 去重：同主题已有条目（无论状态）就跳过；最多并入 3 条。
 */
export function withPendingSuggestions(profile, suggestions, source = null) {
  const next = clone(profile);
  const topics = next.items.map((i) => i.topic);
  const now = nowISO();
  const added = [];
  for (const raw of Array.isArray(suggestions) ? suggestions : []) {
    if (added.length >= MAX_PENDING_SUGGESTIONS) break;
    if (!isObject(raw)) continue;
    const topic = str(raw.topic).trim().slice(0, 120);
    if (!topic) continue;
    if (topics.some((t) => similarTopic(t, topic))) continue;
    topics.push(topic);
    const item = {
      id: uid(), topic, aliases: [], level: str(raw.level).trim().slice(0, 300),
      boundary: str(raw.boundary).trim().slice(0, 2000), basis: 'model_inferred', status: 'pending',
      createdAt: now, updatedAt: now, lastConfirmedAt: null, source,
      note: str(raw.note).trim().slice(0, 2000) || 'AI 观察，等待用户确认',
    };
    next.items.push(item);
    added.push(item);
  }
  return { profile: next, added };
}

/* ---------------------------------------------------------------- 进 prompt 的筛选 */

const LIMIT_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'residual', 'connection', 'mechanism',
  'attention', 'model', 'models', 'learning', 'network', 'networks', 'paper', 'method', 'using', 'based']);

function tokensOf(item) {
  const out = [];
  for (const raw of [item.topic, ...(item.aliases || [])]) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) continue;
    // 中文连续片段（长度 ≥2）——用于匹配中文提问 / 中文论文
    for (const run of s.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
      if (run.length >= 2 && !out.includes(run)) out.push(run);
    }
    // 英文词——用于匹配英文论文（档案常写成「注意力机制（Attention）」这种混合形式）
    for (const w of s.match(/[a-z][a-z0-9-]{2,}/g) || []) {
      if (!LIMIT_STOP.has(w) && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

const countOccurrences = (hay, needle, cap = 6) => {
  if (!needle) return 0;
  let at = 0; let n = 0;
  while (n < cap) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    n++; at = i + needle.length;
  }
  return n;
};

/**
 * 只把与当前论文/问题相关的条目放进 prompt。
 * @returns {Array<{item:object, score:number}>}
 */
export function selectProfileItems(profile, docText = '', question = '', limit = 8) {
  const hay = `${String(docText || '').slice(0, 200000)}\n${String(question || '')}`.toLowerCase();
  const q = String(question || '').toLowerCase();
  const scored = profile.items.map((item) => {
    let score = 0;
    for (const token of tokensOf(item)) {
      score += countOccurrences(hay, token) * 2;
      if (q.includes(token)) score += 5;
    }
    if (item.status === 'pending') score += 0.5;   // 待确认的只要相关就带上（提醒模型别跳过）
    return { item, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function itemLine(item, now) {
  const st = staleness(item, now);
  const date = isoDate(item.lastConfirmedAt || item.createdAt);
  const head = `- ${item.topic}：${item.level || '（理解程度未填）'}`;
  const boundary = item.boundary ? `；具体边界：${item.boundary}` : '';
  let tail;
  if (item.status === 'pending') {
    tail = `（待确认；${date} 由 AI 观察记录，用户尚未确认 → 不能当作已掌握）`;
  } else if (st.days === null) {
    tail = `（确认时间无法解析 → 按可能生疏处理）`;
  } else {
    tail = `（${date} 确认，约 ${st.days} 天前${st.tier === 'stale' ? `；超过 ${STALE_DAYS} 天未确认 → 按可能生疏处理，先简短确认再跳过` : ''}）`;
  }
  return `${head}${boundary}${tail}`;
}

const PROFILE_RULES = [
  '【学习档案 · 只影响讲解深度，不是论文证据】',
  '1. 已确认且边界够用的，可以讲快、跳过基础铺陈；但本文用法超出所记边界时必须补讲差异。',
  '2. 待确认的，不能当作已掌握；讲到它时先用一句可回答的话确认。',
  `3. 超过 ${STALE_DAYS} 天未确认的，按「可能生疏」处理，先快速确认；不要用「你之前学过」下结论。`,
  '4. 档案只决定怎么讲，不作为论文事实依据；回答里不要罗列整份档案。',
].join('\n');

/**
 * 组装要注入 system 的档案块。空档案 / 个性化关闭时返回空串。
 *
 * 选取策略（为什么不是「只放严格匹配的」）：
 *   · 档案通常是中文，论文往往是英文，关键词匹配会漏掉真正相关的前置知识
 *     （例：档案「矩阵乘法」对英文论文 matrix multiplication 匹配不上）；
 *   · 所以：匹配上的排前面，剩下的按「最近确认」补几条，靠模型的常识判断相关性；
 *     提示词明确要求「不相关的不要主动提」，所以不会变成档案播报。
 * 整块封顶 1200 字；当前时间由 `nowContext()` 单独注入（用户明确要求）。
 */
export function buildProfileBlock(profile = profileStore.data, docText = '', question = '') {
  if (!profileStore.enabled) return '';
  const hasSelf = !!profile.selfReport;
  if (!hasSelf && !profile.items.length) return '';
  const now = new Date();
  const matched = selectProfileItems(profile, docText, question);
  const seen = new Set(matched.map((x) => x.item.id));
  const rest = profile.items
    .filter((i) => !seen.has(i.id))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return String(b.lastConfirmedAt || b.createdAt).localeCompare(String(a.lastConfirmedAt || a.createdAt));
    })
    .slice(0, 8)
    .map((item) => ({ item }));
  const chosen = [...matched, ...rest];
  const lines = [];
  if (hasSelf) {
    const at = profile.selfReportAt ? `（${isoDate(profile.selfReportAt)} 填写）` : '';
    lines.push(`自述：${profile.selfReport}${at}`);
  }
  let used = lines.join('\n').length + PROFILE_RULES.length + 2;
  for (const { item } of chosen) {
    const line = itemLine(item, now);
    if (used + line.length > PROFILE_CHAR_LIMIT - 40) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (chosen.length < profile.items.length) {
    lines.push(`（档案里还有 ${profile.items.length - chosen.length} 条未列出；只有用户问到时再参考）`);
  }
  return `${PROFILE_RULES}\n${lines.join('\n')}`;
}

/** 给「这个我懂了」找当前教学对象对应的 level/boundary（从档案里取最近的同主题记录） */
export function findItem(profile, topic) {
  return findSimilarItem(profile, topic);
}

/** 从页面/全文文本里为某条档案找一句「本文用法」——暂不需要，保留接口给后续 */
export function profileItemsForMenu(profile) {
  return [...profile.items].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return String(b.lastConfirmedAt || b.createdAt).localeCompare(String(a.lastConfirmedAt || a.createdAt));
  });
}

/* ---------------------------------------------------------------- 记忆提取 */

/**
 * 「记忆提取」提示词。
 *
 * 为什么需要单独一步：真实模型（2026-10-24 实测 deepseek-v4.1-flash）会稳定输出
 * prt 的 chips，但**从不输出** profile 建议——「AI 提出你似乎已经理解了某个概念」
 * 这条设计如果只靠教学回答自觉，实际上永远不会发生。
 * 所以教学回答收尾后，再用一次很小的、独立的调用从这轮对话里提取「待确认」条目。
 * 它只写 pending，绝不写确认（确认只能用户点）。
 */
export const MEMORY_EXTRACT_SYS = [
  '你是论文阅读器「学习档案」的提取器。给你一轮教学对话（用户的问题 + 助手刚讲完的回答），',
  '以及学习档案里已有的条目名称。请判断：这轮对话里有没有值得记为「用户可能已经理解 / 还没弄懂」的线索？',
  '',
  '规则：',
  '1. 只根据**用户的表现**判断，不要因为助手讲了什么就认定用户会了——讲过了不等于掌握。',
  '2. 用户明确说「懂了 / 这个我懂了 / 会了」→ signal 写 "claimed"；',
  '   用户说「没懂 / 讲简单点 / 再换个说法」或明显追问基础 → signal 写 "needs_help"；',
  '   用户能接着追问里正确使用某个概念、或自己复述出原理 → signal 写 "inferred"（level 里引一句依据）。',
  '3. 每条给 topic（知识点，尽量和论文里的术语一致）、level（一句理解程度）、boundary（这轮对话里能看出的具体边界，看不出来就留空）、signal。',
  '4. 最多 3 条；没有值得记的就返回空数组 []。不要凭猜测编造。',
  '5. 已有条目里已经有的主题不要重复（宁可少一条）。',
  '6. 只输出一个 JSON 数组，不要解释、不要 Markdown 代码块、不要其它文字。',
  '格式：[{"topic":"多头注意力","level":"用户说懂了","boundary":"","signal":"claimed"}]',
].join('\n');

/** 组装记忆提取请求（输入只有这一轮对话，不带论文全文，成本很小） */
export function memoryExtractMessages({ question = '', answer = '', existingTopics = [], docTitle = '' } = {}) {
  const topics = (Array.isArray(existingTopics) ? existingTopics : []).slice(0, 40)
    .map((t) => `- ${String(t || '').slice(0, 120)}`).join('\n');
  const user = [
    `【论文】${docTitle || '未命名'}`,
    '【已有档案条目（不要重复）】',
    topics || '（空）',
    '【这一轮对话】',
    `用户：${String(question || '').slice(0, 2000)}`,
    '助手回答：',
    '"""',
    String(answer || '').slice(0, 12000),
    '"""',
    '【输出】只输出 JSON 数组。',
  ].join('\n');
  return [
    { role: 'system', content: MEMORY_EXTRACT_SYS },
    { role: 'user', content: user },
  ];
}

const SIGNAL_LEVEL = {
  claimed: '用户说懂了（待确认）',
  needs_help: '还没弄懂（对话观察）',
  inferred: '',
};

/**
 * 解析记忆提取结果：容忍代码块包裹、前后废话、个别字段缺失。
 * 返回可直接交给 `withPendingSuggestions()` 的数组（最多 3 条，只含白名单字段）。
 */
export function parseMemorySuggestions(text, limit = MAX_PENDING_SUGGESTIONS) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let body = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const topic = String(item.topic || '').trim().slice(0, 120);
    if (!topic) continue;
    const signal = ['claimed', 'needs_help', 'inferred'].includes(item.signal) ? item.signal : 'inferred';
    const level = String(item.level || '').trim().slice(0, 300) || SIGNAL_LEVEL[signal];
    out.push({
      topic,
      level,
      boundary: String(item.boundary || '').trim().slice(0, 2000),
      basis: 'inferred',
      note: `来自对话观察（${signal}）`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 用户点「这里没懂」：把相关条目标成「待确认」，不再当作已掌握。
 * 只动用户明确表示没弄懂的那个知识点；没有对应条目就不新建（避免噪声）。
 */
export function withNeedsReconfirm(profile, topic) {
  const next = clone(profile);
  const item = findSimilarItem(next, topic);
  if (!item) return { profile: next, changed: false };
  const now = nowISO();
  item.status = 'pending';
  item.updatedAt = now;
  item.note = `用户点了「这里没懂」（${now}），需要重新确认边界`;
  return { profile: next, changed: true };
}
