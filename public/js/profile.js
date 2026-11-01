
import { PROFILE_RULES } from './prompts/memory.js';

export const PROFILE_VERSION = 1;
export const PROFILE_CHAR_LIMIT = 1200;
export const MAX_ITEMS = 200;

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

export function nowContext(date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `【当前时间】${stamp}（周${WEEKDAYS[date.getDay()]}，UTC${tzOffset(date)}）`;
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
      memory: isObject(it.memory) && ['knowledge', 'preference', 'identity'].includes(it.memory.kind)
        && ['self_report', 'needs_help', 'demonstrated', 'inferred', 'preference'].includes(it.memory.signal) ? {
          kind: it.memory.kind,
          scope: it.memory.scope === 'paper' ? 'paper' : 'global',
          signal: it.memory.signal,
          evidence: str(it.memory.evidence).trim().slice(0, 500),
        } : null,
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

/** 后台写入串行执行；写入前重新读取并使用 revision 防止多窗口覆盖。 */
export const profileStore = {
  data: emptyProfile(),
  loaded: false,
  error: '',
  enabled: true,
  writeQueue: Promise.resolve(),

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

  async commit(next) {
    const before = this.data;
    const candidate = {
      ...next,
      version: PROFILE_VERSION,
      revision: (before.revision || 0) + 1,
      updatedAt: nowISO(),
    };
    const parsed = validateProfile(candidate);
    if (!parsed.ok) throw new Error(`学习档案校验失败：${parsed.error}`);
    try {
      const r = await fetch(PROFILE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': String(before.revision || 0) },
        body: JSON.stringify(parsed.data),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const error = new Error(j?.error?.message || `HTTP ${r.status}`);
        error.status = r.status;
        throw error;
      }
      this.data = parsed.data;
      this.error = '';
      return this.data;
    } catch (e) {
      throw e;
    }
  },

  update(mutate) {
    const write = this.writeQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.load();
        if (this.error) throw new Error(this.error);
        const next = mutate(this.data);
        if (!next) return this.data;
        try { return await this.commit(next); }
        catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
      }
    });
    this.writeQueue = write;
    return write;
  },

  isEmpty() {
    return !this.data.selfReport && !this.data.items.length;
  },
};

const LIMIT_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that',
  'model', 'models', 'learning', 'network', 'networks', 'paper', 'method', 'using', 'based']);

function tokensOf(item) {
  const out = [];
  for (const raw of [item.topic, ...(item.aliases || [])]) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) continue;
    if (s.length >= 2 && !LIMIT_STOP.has(s) && !out.includes(s)) out.push(s);
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
export function selectProfileItems(profile, docText = '', question = '', limit = 8, { docId = '' } = {}) {
  const hay = `${String(docText || '').slice(0, 200000)}\n${String(question || '')}`.toLowerCase();
  const q = String(question || '').toLowerCase();
  const scored = profile.items.map((item) => {
    if (item.memory?.scope === 'paper' && (!docId || item.source?.docId !== docId)) return { item, score: 0 };
    // 身份自述（称呼 / 方向 / 目标）和持续偏好与论文内容无关，永远优先带上
    if (item.memory?.kind === 'identity') return { item, score: 6 };
    if (item.memory?.kind === 'preference') return { item, score: 5 };
    let score = 0;
    for (const token of tokensOf(item)) {
      score += countOccurrences(hay, token) * 2;
      if (q.includes(token)) score += 5;
    }
    return { item, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** 只注入相关知识和持续讲解偏好；论文范围的观察不得跨论文使用。 */
export function buildProfileBlock(profile = profileStore.data, docText = '', question = '', { docId = '' } = {}) {
  if (!profileStore.enabled) return '';
  const chosen = selectProfileItems(profile, docText, question, 8, { docId });
  const lines = [];
  if (profile.selfReport) lines.push(JSON.stringify({ 历史自述: profile.selfReport.slice(0, 240), 时间: profile.selfReportAt }));
  let used = PROFILE_RULES.length + lines.join('\n').length + 2;
  const labels = { self_report: '用户自述，未独立验证', needs_help: '用户表示仍需讲解', demonstrated: '本次对话中正确运用，尚不能泛化', inferred: '推测，依据有限', preference: '持续讲解偏好' };
  for (const { item } of chosen) {
    const signal = item.memory?.signal || (item.status === 'confirmed' ? 'self_report' : 'inferred');
    const line = JSON.stringify({
      主题: item.topic,
      观察: item.memory?.kind === 'identity' ? '用户自述身份（可用来称呼，不代表论文事实）' : labels[signal],
      情况: item.level.slice(0, 110), 边界: item.boundary.slice(0, 160),
      原话依据: (item.memory?.evidence || '').slice(0, 100), 时间: item.updatedAt || item.createdAt,
    });
    if (used + line.length + 1 > PROFILE_CHAR_LIMIT) continue;
    lines.push(line); used += line.length + 1;
  }
  return lines.length ? PROFILE_RULES + '\n' + lines.join('\n') : '';
}

/** 给「这个我懂了」找当前教学对象对应的 level/boundary（从档案里取最近的同主题记录） */
export function findItem(profile, topic) {
  return findSimilarItem(profile, topic);
}
