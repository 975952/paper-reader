import { resolveReadingRequest, historyMessages, stripPageLabels } from './reading-context.js';
import { nowContext, buildProfileBlock } from './profile.js';
import { CONDENSE_SYS } from './teaching.js';

export const PRESETS = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash', visionModel: '' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001', visionModel: 'google/gemini-2.0-flash-001' },
  siliconflow: { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', visionModel: 'Qwen/Qwen2.5-VL-7B-Instruct' },
  ollama: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', visionModel: 'llava:7b' },
};

export const MODEL_SUGGESTIONS = [
  'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'gpt-4o',
  'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-sonnet',
  'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-VL-7B-Instruct',
  'qwen2.5:7b', 'llava:7b', 'glm-4-flash',
];

/* ---------------------------------------------------------------- 设置 */

export const Settings = {
  data: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    hasApiKey: false,
    model: 'deepseek-flash',
    visionModel: '',
    targetLang: '中文',
    temperature: 0.2,
    stream: true,
    autoTranslate: true,
    theme: 'light',
    fontSize: 15,
    glossary: '',
    idleMs: 60000,   // 多久收不到数据就判定卡住并中止（没有 UI，可在 data/config.json 里调）
    longTermMemory: '',  // 用户手写的长期记忆（设置页多行输入，≤4000 字）
  },

  async load() {
    try {
      const r = await fetch('/api/config');
      if (r.ok) {
        const cfg = await r.json();
        this.data = { ...this.data, ...cfg };
      }
    } catch { /* 离线也能用 */ }
    // 界面偏好存本地就够了
    try {
      const local = JSON.parse(localStorage.getItem('reader.ui') || '{}');
      Object.assign(this.data, local);
    } catch { /* ignore */ }
    return this.data;
  },

  async save(patch) {
    const { theme, fontSize, ...serverPatch } = patch;
    if (theme !== undefined || fontSize !== undefined) {
      let local = {};
      try { local = JSON.parse(localStorage.getItem('reader.ui') || '{}'); } catch { /* ignore */ }
      localStorage.setItem('reader.ui', JSON.stringify({ ...local, ...(theme !== undefined ? { theme } : {}), ...(fontSize !== undefined ? { fontSize } : {}) }));
    }
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverPatch),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || `HTTP ${r.status}`);
      }
      if (r.ok) {
        const j = await r.json();
        this.data.hasApiKey = j.hasApiKey;
        await this.load();
      }
    } catch (e) {
      throw new Error(`保存失败：${e.message}`);
    }
  },

  get ready() {
    return !!this.data.baseURL && (this.data.hasApiKey || /127\.0\.0\.1|localhost/.test(this.data.baseURL));
  },
};

/* ---------------------------------------------------------------- 客户端 */

/** 选中文段的目标语言：中文为主的就译成英文，其余一律译成中文 */
export function targetLangFor(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk / Math.max(1, s.length) > 0.15 ? 'English' : '中文';
}

export async function streamChat(opts) {
  const {
    messages,
    model = Settings.data.model,
    onDelta,
    onReasoning,
    signal,
    temperature = Settings.data.temperature,
    stream = Settings.data.stream,
    idleMs = 60000,
    onTick,
  } = opts;

  // 自己的 controller：既能被调用方 abort，也能被看门狗 abort
  const ctl = new AbortController();
  const forward = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }

  let idleTimer = null;
  let stalled = false;
  const startedAt = Date.now();
  const bump = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { stalled = true; ctl.abort(); }, idleMs);
  };
  const tick = setInterval(() => onTick?.(Date.now() - startedAt), 1000);
  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(tick);
    signal?.removeEventListener?.('abort', forward);
  };

  const stale = () => {
    if (!stalled) return null;
    const err = new Error(
      `超过 ${Math.round(idleMs / 1000)} 秒没有收到任何数据，已判定为卡住并中断。\n`
      + '可能是模型名不对、额度用尽，或网络/代理卡住了。可以换个模型再试。',
    );
    err.name = 'TimeoutError';   // 要与「用户主动停止」区分开，不能显示成「已停止」
    return err;
  };

  try {
    bump();
    // 带图请求：告诉服务端「这次要用视觉模型」（模型名仍只来自本机 config，
    // 前端不传 model，避免把模型选型暴露成可被请求覆盖的字段）。
    const hasImage = Array.isArray(messages) && messages.some(
      (m) => Array.isArray(m?.content) && m.content.some((p) => p && p.type === 'image_url'),
    );
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model,
        temperature,
        stream,
        useVision: hasImage,
        baseURL: Settings.data.baseURL,
        apiKey: Settings.data.apiKey || undefined,
      }),
      signal: ctl.signal,
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j?.error?.message || msg;
      } catch {
        try { msg = (await res.text()).slice(0, 500) || msg; } catch { /* ignore */ }
      }
      const regionUnavailable = /not available in (?:your|this|the) region|unavailable in (?:your|this|the) region|not available in (?:your|this|the) country|not supported in (?:your|this|the) (?:region|country)|region (?:is )?not supported|(?:地区|区域).{0,12}(?:不支持|不可用|限制)|(?:不支持|不可用).{0,12}(?:地区|区域)/i.test(msg);
      if (regionUnavailable) {
        msg += ' —— 该模型在你所在地区不可用，密钥不一定有问题。请到右上角 ⚙ 更换为当地可用的模型或服务商。';
      } else if (res.status === 401 || /invalid.*(?:api[\s_-]*key|key)|(?:api[\s_-]*key|key).*invalid|authentication|unauthor/i.test(msg)) {
        msg += ' —— API Key 无效或已失效，点右上角 ⚙ 重新填一个（也可能是账户欠费/密钥被停用）';
      } else if (res.status === 403) {
        msg += ' —— 服务商拒绝了这次模型调用，可能是模型权限、账户状态或地区限制；请检查服务商账户和模型设置。';
      } else if (res.status === 402 || /insufficient|balance|quota/i.test(msg)) {
        msg += ' —— 账户额度不够了，去服务商后台充值或换个 Key';
      } else if (res.status === 404) {
        msg += ' —— 模型名或接口地址不对，点右上角 ⚙ 检查一下';
      } else if (res.status === 429) {
        msg += ' —— 触发限流了，等一会儿再试';
      }
      throw new Error(msg);
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase();

    // 兼容网关 / 某些 Ollama 版本会忽略 stream:true，直接回普通 JSON
    if (!ctype.includes('event-stream')) {
      const raw = await res.text();
      let text = '';
      try {
        const j = JSON.parse(raw);
        text = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? j?.content ?? '';
      } catch {
        text = raw;
      }
      if (!text) {
        throw new Error(
          `服务端返回的不是流式数据（Content-Type: ${ctype || '未知'}），且解析不出内容。\n`
          + '检查一下 API 地址是不是 OpenAI 兼容的 /v1 端点。',
        );
      }
      onDelta?.(text, text);
      return text;
    }

    if (!stream) {
      const raw = await res.text();
      let text = '';
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          text += j?.choices?.[0]?.delta?.content || j?.choices?.[0]?.message?.content || '';
        } catch { /* ignore */ }
      }
      if (!text) throw new Error('服务端返回了流式数据但解析不出内容。');
      onDelta?.(text, text);
      return text;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let reasoning = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.error) throw new Error(json.error.message || '上游返回错误');
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoning?.(delta.reasoning_content, reasoning);
        }
        const piece = typeof delta.content === 'string' ? delta.content : '';
        if (piece) {
          full += piece;
          onDelta?.(piece, full);
        }
      }
    }

    if (!full && !reasoning) {
      throw new Error('模型没有返回任何内容。可能是模型名不对、额度用尽，或被网关拦截了。');
    }
    return full;
  } catch (e) {
    const s = stale();
    if (s) throw s;
    throw e;
  } finally {
    cleanup();
  }
}

/** 测试连接：发一条最短的请求 */
export async function testConnection() {
  const t0 = Date.now();
  const text = await streamChat({
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    stream: false,
    temperature: 0,
  });
  return { ms: Date.now() - t0, text: (text || '').trim().slice(0, 40), model: Settings.data.model };
}

/* ---------------------------------------------------------------- 提示词 */

// A 线 P1：所有提示词构造已迁到 ./prompts/（registry + compose + capabilities），
// 这里只保留兼容 re-export，调用方（app.js / 测试）的导出名与返回结构不变。
// 黄金快照：test/prompts.mjs；设计文档：docs/提示词工程-设计.md。

export {
  translateMessages, translateShotMessages, askMessages, explainMessages,
  digestMessages, opMessages, teachMessages, sessionSummaryMessages,
  scanPageMessages, condenseMessages,
} from './prompts/index.js';

// 中文口水词 / 提问套话。必须按长度从长到短替换，否则「查一下」会先被「查」吃掉
const ZH_FILLER = [
  '是什么意思', '什么意思', '是什么', '什么是', '有什么', '什么',
  '介绍一下', '解释一下', '说明一下',
  '查一下', '搜一下', '找一下', '看一下', '讲一下', '说一下', '了解一下',
  '为什么', '怎么样', '怎样', '怎么', '如何', '哪些', '哪个', '哪一种', '多少',
  '是否', '能不能', '可不可以', '能否',
  '帮我', '帮忙', '请问', '请', '另外', '还有', '以及', '顺便', '然后', '那么',
  '这篇论文', '这篇', '本文', '该论文', '该文', '论文里', '论文中', '论文的', '论文', '文章', '文献',
  '这句话', '这段', '这句', '上面', '下面', '选中', '讲的', '说的是', '提到了', '提到',
  '主要', '核心', '贡献', '内容', '意思', '解释', '翻译', '总结', '概括', '介绍', '说明',
  '告诉', '相关', '关于', '方面', '问题', '情况', '东西', '最近', '最新', '现在', '目前', '今天',
  '重要', '进展', '一下', '什么样', '有没有', '没有',
  '的', '了', '是', '在', '和', '与', '及', '我', '你', '他', '她', '它', '这', '那', '们',
  '就', '也', '都', '很', '把', '被', '给', '对', '从', '到', '而', '或', '但', '让', '使',
  '之', '其', '该', '此', '些', '个', '有', '吗', '呢', '吧', '啊', '呀', '哦', '嘛',
];

// 英文里没有检索价值的词
const EN_FILLER = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'about',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'not', 'but', 'or', 'if', 'then',
  'than', 'as', 'at', 'by', 'in', 'on', 'of', 'to', 'it', 'its', 'we', 'you', 'your', 'our',
  'they', 'their', 'he', 'she', 'his', 'her', 'me', 'my', 'i', 'please', 'tell', 'explain',
  'paper', 'this paper', 'doi', 'pdf', 'any', 'some', 'more', 'most', 'much', 'also', 'there',
  'here', 'so', 'such', 'only', 'just', 'very', 'get', 'got', 'make', 'made', 'use', 'used',
  'using', 'like', 'want', 'need', 'know', 'recent', 'latest', 'new', 'main', 'key',
]);

/** 从一句话里挑出有检索价值的词：英文原词 + 中文去掉口水词后的连续片段 */
export function searchTerms(text) {
  const s = String(text || '');
  const out = [];

  for (const w of s.match(/[A-Za-z][A-Za-z0-9+#._-]*/g) || []) {
    const key = w.toLowerCase().replace(/[._-]+$/, '');
    if (key.length < 2 || EN_FILLER.has(key)) continue;
    if (!out.some((x) => x.toLowerCase() === key)) out.push(w.replace(/[._-]+$/, ''));
  }

  let zh = s;
  for (const w of ZH_FILLER) zh = zh.split(w).join(' ');
  for (const run of zh.split(/\s+/)) {
    // 只留中文，标点和英文都丢掉（英文上面已经单独收过了）
    for (const piece of run.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
      if (piece.length >= 2 && !out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

/** 真正发给搜索引擎的查询串 */
export function webQueryFor(question, selection, { history = [], reading } = {}) {
  const request = reading || resolveReadingRequest({ question, selection, history });
  const q = request.question;
  if (['guidance', 'feedback'].includes(request.intent) || /^[?？!！。.\s]+$/.test(q)) return '';
  const sel = stripPageLabels(request.selection || (request.inherited ? request.focus.text : ''));
  const anchor = searchTerms(sel.slice(0, 1600));
  const terms = searchTerms(q);
  // 追问先补对象，不能拿「谁 / 更快 / 默认」去决定检索主题。
  if (request.intent !== 'question' && anchor.length) return anchor.slice(0, 12).join(' ').slice(0, 180);
  if (!terms.length) return anchor.slice(0, 12).join(' ').slice(0, 180);
  const extra = terms.length < 2 ? anchor.filter((t) => !terms.includes(t)).slice(0, 3) : [];
  return [...terms, ...extra].join(' ').slice(0, 180);
}

/** 每条结果必须与对象相关；后端的整批词语筛选不足以排除混入的无关条目。 */
export function filterWebResults(query, results = []) {
  const terms = searchTerms(query).map((t) => t.toLowerCase());
  const generic = new Set(['deep', 'learning', 'neural', 'network', 'networks', 'model', 'models']);
  const anchors = terms.filter((t) => !generic.has(t));
  const keys = anchors.length ? anchors : terms;
  if (!keys.length) return [];
  const contains = (hay, key) => {
    if (hay.includes(key)) return true;
    if (!/^[\u4e00-\u9fa5]{4,}$/.test(key)) return false;
    const parts = Array.from({ length: key.length - 1 }, (_, i) => key.slice(i, i + 2));
    return parts.filter((p) => hay.includes(p)).length >= Math.ceil(parts.length * 0.7);
  };
  const needed = Math.min(3, keys.length === 1 ? 1 : Math.max(2, Math.ceil(keys.length / 2)));
  const seen = new Set();
  return results.filter((r) => {
    if (!r || !/^https?:\/\//i.test(r.url || '') || seen.has(r.url)) return false;
    const hay = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    if (keys.filter((t) => contains(hay, t)).length < needed) return false;
    seen.add(r.url);
    return true;
  });
}


