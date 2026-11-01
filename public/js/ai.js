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

const OUTPUT_ONLY = '只输出译文本身，不要任何前言、说明、礼貌用语或 Markdown 代码块包裹。';

export function translateMessages({ text, targetLang, context, page, docTitle, glossary }) {
  const sys = [
    `你是一位严谨的学术论文翻译专家，把论文片段翻译成${targetLang}。`,
    '',
    '要求：',
    `1. 术语准确、全篇一致。专业术语首次出现时写成「${targetLang === '中文' ? '中文（English）' : '译文（原文）'}」的形式。`,
    '2. 公式、变量名、数字、单位、引用编号（如 [12]）、图表编号（如 Fig. 2 / Table 3）一律原样保留，不翻译、不改写。',
    '3. 保持原文段落结构（空行分段）。不要添加解释、不要总结、不要补标题。',
    '4. 若片段明显被截断，按语义补全成通顺的句子，但不得编造原文没有的内容。',
    `5. ${OUTPUT_ONLY}`,
  ];
  const hits = matchGlossary(text, glossary);
  if (hits.length) {
    sys.push('', '以下术语必须严格按给定译名翻译（用户指定，优先级最高）：');
    for (const [k, v] of hits) sys.push(`· ${k} → ${v}`);
  }

  const user = [];
  user.push(`【论文】${docTitle || '未命名'}${page ? `（第 ${page} 页）` : ''}`);
  if (context) user.push(`【所在段落 · 仅供理解语境，不要翻译】\n${context}`);
  user.push(`【需要翻译的片段】\n${text}`);
  return [
    { role: 'system', content: sys.join('\n') },
    { role: 'user', content: user.join('\n\n') },
  ];
}

/** 从「英文=译名」文本里找出这次片段真正命中的术语 */
export function matchGlossary(text, glossaryText) {
  if (!glossaryText || !text) return [];
  const entries = String(glossaryText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
    .filter(([k, v]) => k && v);
  if (!entries.length) return [];
  const hay = text.toLowerCase();
  return entries.filter(([k]) => hay.includes(k.toLowerCase()));
}

export function askMessages({ question, selection, selectionSource = '', context, page, pageRole = '', docTitle, fullText, webResults, history = [], reading, references = [], profileBlock = null, teachingBlock = '', pageImages = [] }) {
  const request = reading || resolveReadingRequest({ question, selection, page, history, selectionSource });
  const role = ['selection', 'explicit', 'topic', 'screen'].includes(pageRole)
    ? pageRole : (selection ? 'selection' : 'screen');
  // 选中文本来自右栏（上一轮的问答/译文）而不是 PDF 正文：不能冒充「第 N 页原文」
  const selectionFromRight = selectionSource === 'right' || request.focus?.source === 'right';
  const sys = [
    '你是嵌在论文阅读器里的阅读助手，帮助读者读懂正在看的论文。',
    '',
    '回答规则：',
    '1. 用户明确指定新对象或整篇任务时，按明确问题回答；否则当前阅读对象由【选中文本】或【当前话题】确定。新选区优先；「他是谁」「为什么更快」「继续」「？」等短追问沿用这个对象。所在页和全文只是辅助材料，搜索结果不能另起一个同名话题。有明确人名时直接回答这个人，不要列举电视剧等无关可能；只有材料确实无法消除歧义时，才问一个具体的澄清问题。',
    '1.1 顺着上面的话追问时（短问句、代词、为什么/继续等），回答对象和历史里的一致，不要因为读者滚到了别的页就把那一页当成新话题；只有问题明确说「这里 / 这一页 / 当前页」时才以当前屏幕页为准。追问不需要重新介绍背景，直接接着上文讲。',
    '1.2 【选中文本】若标注「来自右栏回答 / 译文」，那是之前对话里的文字，不是论文原文：可以解释它、接着说，但不要把它标成「第 N 页原文」，也不要拿它当论文证据或对照页图里的手写内容；需要页码证据时以论文原文/页图为准，并说明这段文字来自对话。',
    '2. 默认任务是讲懂选区提到的知识。人名：身份及与本论文的关系；术语：含义和直观例子；方法或模型：解决什么问题、关键做法及为什么有效；公式：符号、计算过程与含义；图表：读准内容再解释结论。按本次对象选择需要的内容，不套用固定栏目，不输出「没有公式」「没有实验数据」等无关检查清单。先直接回答，再补必要解释；知识点复杂时用一个小例子逐步讲清。',
    '3. 本论文的数字、实验、结论和作者主张须有论文原文依据。解释基础概念可以补充可靠的领域知识，在一段开头用「补充理解」区分即可，不要逐句反复标记。特定人物履历、被引方法的技术细节和外部实验数据须有可靠材料；未核实的细节省略或简短指出不确定，不能因本文只提了名字就停止解释基础原理。',
    '4. 用到联网材料时，只有摘录确实支持的事实才标 [来源1]、[来源2]；不得用标题或书目猜出技术细节。论文自己的 [27]、[32] 是参考文献编号。不要把无关来源写入回答，也不要例行解释两种编号的区别。',
    '5. 用户纠正或设定默认讲解方式时，简短确认后落实到当前阅读对象；「？」若附有新选区就解释新选区，否则围绕上一回答纠正或换个具体说法。不要凭空编造自己检索了什么、拿到了什么或内部运行原因。',
    '6. 用中文和短段落，术语首次出现保留英文；数学公式用 $...$ 或 $$...$$。不要客套、无关扩写或例行邀请用户继续提问。',
    '7. 如果【后台学习记忆】里给出了读者的称呼或身份，可直接用合适的称呼作答；不要解释记忆系统如何工作，也不要承诺「永久记住」「已保存到记忆」这类超出事实的说法。',
    pageImages.length
      ? '8. 这篇 PDF 没有可抽取的文本层（扫描件），本次附带了页面图片。只依据图片里实际可见的内容回答；图片里看不清、被裁掉或没有提供的页面，明确说不确定，不要补造原文、页码或图表编号。如果你实际上无法查看图片（当前模型不支持读图），必须直接说明「当前模型无法读图，建议配置视觉模型」，不要根据标题、提示或常识推测图片内容。'
      : '',
    CITATION_RULE,
    request.guidance ? `读者持续的讲解偏好：${request.guidance}` : '',
    // 用户口径：「现在的时间在后续过程中要交给模型」——每次回答都带上，
    // 模型才能判断「最近 / 今年 / 几个月前」这类说法。
    nowContext(),
    profileBlock ?? buildProfileBlock(undefined, `${docTitle || ''}\n${selection || ''}\n${context || ''}`, question),
    teachingBlock,
  ].filter(Boolean).join('\n');

  const contextBlock = [];
  const pageHead = !page ? ''
    : role === 'topic' ? `｜当前话题在第 ${page} 页`
      : role === 'explicit' ? `（问题指定的第 ${page} 页）`
        : role === 'selection' ? `（第 ${page} 页）`
          : `（读者当前在第 ${page} 页）`;
  if (docTitle) contextBlock.push(`【论文】${docTitle}${pageHead}`);
  if (request.selection) {
    // 追问沿用的原文标上它原来的页，模型才知道这段材料属于第几页，不会被屏幕页带跑
    const inheritedPage = request.inherited && request.focus?.page ? ` · 第 ${request.focus.page} 页` : '';
    const srcNote = selectionFromRight ? ' · 来自右栏回答 / 译文，不是论文原文' : '';
    contextBlock.push(`【选中文本${request.inherited ? ' · 本次追问沿用' : ''}${inheritedPage}${srcNote}】\n"""\n${request.selection}\n"""`);
  } else if (request.inherited) {
    const topicPage = request.focus?.page ? `（第 ${request.focus.page} 页）` : '';
    contextBlock.push(`【当前话题${topicPage}】\n${request.focus.text}`);
  }
  if (references.length) contextBlock.push('【选区涉及的参考文献 · 书目信息，不代表技术细节】\n'
    + references.map((r) => `[${r.num}] ${r.text}${r.page ? `（文献表第${r.page}页）` : ''}`).join('\n'));
  if (context) {
    const label = role === 'topic' ? '【当前话题所在页上下文 · 追问时以此为准】'
      : role === 'explicit' ? '【问题指定页的上下文】'
        : role === 'screen' ? '【当前屏幕页上下文 · 只有问题指向「这里/这一页」时才用它，别把它当新话题】'
          : '【所在页上下文】';
    contextBlock.push(`${label}\n"""\n${context}\n"""`);
  }
  if (fullText) contextBlock.push(`【论文全文${fullText.length > 60000 ? '（很长，已按页给出）' : ''}】\n"""\n${fullText}\n"""`);
  if (webResults?.length) {
    contextBlock.push('【联网搜索结果】\n' + webResults.map((r, i) => {
      const snip = String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 4000);
      return `[来源${i + 1}] ${r.title}\n${r.url}${snip ? `\n【${r.excerptKind === 'abstract' ? '原论文摘要' : '搜索摘录'}】${snip}` : '\n【仅书目或标题，无正文摘录】'}`;
    }).join('\n\n'));
    contextBlock.push(`（引用联网结果时只能写 [来源1]～[来源${webResults.length}]；论文原文里的 [27] 那类编号是论文自己的参考文献，不要拿来当联网来源）`);
  }

  const messages = [{ role: 'system', content: sys }];
  messages.push(...historyMessages(history));
  messages.push({
    role: 'user',
    content: contextBlock.length ? `${contextBlock.join('\n\n')}\n\n【问题】\n${request.question}` : request.question,
  });
  return messages;
}

/** 太长时先生成一份「阅读索引」，之后每次提问都带它 */
export function digestMessages({ text, docTitle }) {
  return [
    {
      role: 'system',
      content: '你负责把论文正文压缩成「阅读索引」。输出中文，分节列出：研究问题 / 方法 / 关键公式与符号 / 实验设置 / 主要结论 / 局限。只依据给定文本，不编造。控制在 800 字以内。',
    },
    { role: 'user', content: `【论文】${docTitle || '未命名'}\n\n【正文】\n${text}` },
  ];
}

export function opMessages(op, { docTitle, fullText, digest, extra, history = [], profileBlock = null, pageImages = [] } = {}) {
  const parts = [];
  if (docTitle) parts.push(`【论文】${docTitle}`);
  if (fullText) {
    parts.push(`【论文全文${fullText.length > 60000 ? '（很长，已按页给出）' : ''}】\n"""\n${fullText}\n"""`);
  } else if (digest) {
    parts.push(`【阅读索引】\n${digest}`);
  }
  if (extra) parts.push(extra);
  parts.push(`【本次任务】\n${op.ask}`);
  const sys = [op.sys, nowContext(), pageImages.length ? PAGE_IMAGE_RULE : '', CITATION_RULE,
    profileBlock ?? buildProfileBlock(undefined, fullText || digest || docTitle, op.ask)].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: sys },
    ...history.slice(-4),
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function teachMessages(op, {
  docTitle, fullText, digest, extraUser = '', profileBlock = '', history = [], ask = '', pageImages = [],
} = {}) {
  const parts = [];
  if (docTitle) parts.push(`【论文】${docTitle}`);
  if (fullText) {
    parts.push(`【论文全文${fullText.length > 60000 ? '（很长，已按页给出）' : ''}】\n"""\n${fullText}\n"""`);
  } else if (digest) {
    parts.push(`【阅读索引】\n${digest}`);
  }
  if (pageImages.length) parts.push(`【页面图片】本次附带了第 ${pageImages.map((p) => p.page).join('、')} 页的原图，见附图。`);
  if (extraUser) parts.push(extraUser);
  parts.push(`【本次任务】\n${ask || op.ask}`);
  const system = [op.sys, nowContext(), pageImages.length ? PAGE_IMAGE_RULE : '', CITATION_RULE, profileBlock].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    ...history.slice(-10).map((m) => ({ role: m.role, content: String(m.content || '') })),
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** 引用原文的统一格式：带 ‖ 片段的引用可以跳句/段并高亮 */
const CITATION_RULE = '引用论文原文时，写成〔p.N‖连续一句或短段原文〕：片段必须逐字来自材料、不超过 120 字，不能改写或拼接；只给页码就用〔p.N〕。';

/** 扫描件：附带页面图时给所有教学/问答提示词共用的底线 */
const PAGE_IMAGE_RULE = '【页面图片规则】这篇 PDF 没有可抽取的文本层（扫描件），材料里附带的是页面图片。'
  + '只依据图片里实际可见的内容作答；看不清、被裁掉或未提供的页面，明确说不确定，不要补造原文、页码或图表编号。'
  + '如果当前模型实际上无法读图，必须直接说明看不到图片并建议配置视觉模型，不要根据标题、提示或常识推测内容。';

/** 会话滚动摘要：把早先的对话压成一段可继续用于上下文的摘要（compaction） */
export function sessionSummaryMessages({ previous = '', turns = '' }) {
  return [
    {
      role: 'system',
      content: [
        '你在为一个论文阅读器的问答会话做「滚动摘要」，只输出摘要正文，不回答问题、不客套。',
        '要求：',
        '1. 把【已有摘要】和【需要合并的新对话】合成一段新的摘要，用中文，≤400 字；',
        '2. 保留：读者明确提出的长期要求 / 讲解偏好、已经讨论清楚的论文对象与结论、仍没解决的问题；',
        '3. 不要编造对话里没有的内容；不要写「用户问了好几次」这类统计；不要加评价或建议；',
        '4. 只保留对后续回答有用的信息，寒暄、寒暄式追问可以丢掉。',
      ].join('\n'),
    },
    { role: 'user', content: `【已有摘要】\n${previous || '（无）'}\n\n【需要合并的新对话】\n${turns}` },
  ];
}

/** 扫描件阅读索引：逐页转写（只输出 Markdown 转写，供后续教学当作「全文」用） */
export function scanPageMessages({ page, docTitle }) {
  return [
    {
      role: 'system',
      content: [
        '你是论文阅读器里的扫描页转写器，只做转写，不回答问题、不总结、不评价。',
        '把这一页图片里的内容转写成 Markdown：',
        '1. 正文照原文转写（中文/英文），保留数字、单位、引用编号；',
        '2. 公式用 $$...$$ 的 LaTeX 写出；',
        '3. 图表写成「[图 N] 图题 / 坐标轴与图例 / 关键数值」「[表 N] 表题 / 表头 / 关键数据」；',
        '4. 手写批注单独写成「[手写] …」；',
        '5. 看不清的地方写「[看不清]」，不要猜、不要补造。',
        '不要输出任何解释或客套，只输出这一页的转写。',
      ].join('\n'),
    },
    { role: 'user', content: `【论文】${docTitle || '未命名'}\n【第 ${page} 页原图】见附图。` },
  ];
}


/** 「再压短」：把上一条回答压到 60% 左右，不新增内容 */
export function condenseMessages({ answer, docTitle }) {
  return [
    { role: 'system', content: `${CONDENSE_SYS}\n\n${nowContext()}` },
    {
      role: 'user',
      content: [`【论文】${docTitle || '未命名'}`, '【需要压缩的回答】', '"""', String(answer || '').slice(0, 20000), '"""'].join('\n'),
    },
  ];
}


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

/** 「释」：不提问，直接把这段讲明白 */
export function explainMessages({ selection, context, page, docTitle, history = [], reading, references = [], profileBlock = null, selectionSource = '' }) {
  return askMessages({ question: '请解释这段内容涉及的知识。', selection, context, page, docTitle,
    history, reading, references, profileBlock, selectionSource, pageRole: selection ? 'selection' : 'screen' });
}

export function regionMessages({ question, targetLang, page, docTitle }) {
  const sys = [
    '你是论文阅读助手，读者给你截取了论文中的一块区域（可能是插图、表格、公式或扫描文字）。',
    '',
    '请按内容类型处理：',
    '· 公式：用 LaTeX 完整写出（$$...$$），并逐个符号解释含义。',
    `· 插图/表格：说明它展示的内容、坐标轴与图例含义、以及它支持的结论；表头和数据要读准。`,
    `· 文字（含扫描件）：先给出识别出的原文，再用${targetLang}翻译。`,
    '',
    '最后用一句话说明这块内容在整篇论文里的作用。',
    '看不清或不确定的地方要明确说「不确定」，不要猜。用中文回答。',
  ].join('\n');
  const user = [
    `【论文】${docTitle || '未命名'}${page ? `（第 ${page} 页）` : ''}`,
    question ? `【读者的问题】${question}` : '',
    '【区域截图】见下。',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}
