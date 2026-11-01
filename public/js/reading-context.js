/** 阅读对象随会话保存；界面引用、模型历史和检索共用同一个对象。 */
const MAX_FOCUS = 6000;
const pageNumber = (p) => Number.isInteger(Number(p)) && Number(p) > 0 ? Number(p) : null;

export function stripPageLabels(text) {
  return String(text || '').replace(/\[(?:第\s*\d+\s*页|p\.\s*\d+)\]\s*/gi, '').trim();
}

function cleanFocus(focus) {
  if (!focus || typeof focus !== 'object' || !String(focus.text || '').trim()) return null;
  return { text: String(focus.text).slice(0, MAX_FOCUS), page: pageNumber(focus.page),
    kind: focus.kind === 'question' ? 'question' : 'selection',
    // 右栏回答/译文里划的词不是 PDF 原文，不能冒充某一页的原文
    source: focus.source === 'right' ? 'right' : '' };
}

export function snapshotHistory(history = []) {
  return (Array.isArray(history) ? history : []).filter((m) => m && ['user', 'assistant'].includes(m.role))
    .slice(-80).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 12000),
      ...(m.role === 'user' ? { focus: cleanFocus(m.focus), guidance: String(m.guidance || '').slice(0, 400) } : {}) }));
}

export function readingIntent(question, selection = '') {
  const q = String(question || '').trim();
  if (/默认|以后|今后|接下来都/.test(q) && /解释|讲解|回答|知识|简洁|详细|例子/.test(q)) return 'guidance';
  if (/^(?:你|您)?(?:到底)?(?:怎么|如何).{0,12}(?:理解|看待|处理).{0,8}(?:问题|提问)|答非所问|跑题|理解错了|我不是(?:问|要)|你答错了/.test(q)) return 'feedback';
  if (/^(?:这篇论文|本文|整篇论文|论文整体)|^(?:总结|概括|评价).{0,8}(?:这篇|论文)/.test(q)) return 'question';
  if (!q || /^[?？!！。.]+$/.test(q) || /^(?:请)?(?:解释|讲解)(?:一下)?(?:我加进来的)?(?:这段|这些|这个|选中|框选|划选)/.test(q)) {
    return selection ? 'explain' : 'followup';
  }
  if (/^(?:他|她|它|这|那|这里|那里|二者|两者|前者|后者|上述|上面|上一|刚才|这些|那些)/.test(q)
    || /^(?:继续|接着|展开|再讲|没懂|不懂|说简单点|举个例子|举一个例子|解释一下|详细点|具体点)/.test(q)
    || /^(?:为什么|为何|怎么|如何)(?:会|要|能|就|是|做|理解|实现|更快|省|用|有效|这样|这么|做到|工作|的)*[?？。!！]*$/.test(q)
    || /^(?:who is (?:he|she)|what (?:is|does) (?:it|this|that)|why|how so|continue|explain more)[?!.\s]*$/i.test(q)) return 'followup';
  return 'question';
}

/** 问题是否明确指向「读者眼前的这一页」（而不是上一轮话题） */
export function screenPageRequested(question) {
  const q = String(question || '');
  // 「第 N 页」是明确页码，交给 explicitPageIn()，不算「当前页」指代
  if (/(?:第\s*\d{1,4}\s*页|\bp\.?\s*\d{1,4}\b)/i.test(q)) return false;
  return /(?:当前(?:的)?页|这一?页|本页|这屏|这一屏|屏幕(?:上|里)|这里|这儿|这个位置|这一?块(?:区域)?)/.test(q);
}

/** 问题里明说的页码（第 5 页 / p.5），超出总页数则忽略 */
export function explicitPageIn(question, numPages = null) {
  const text = String(question || '');
  const m = text.match(/第\s*(\d{1,4})\s*页/) || text.match(/\bp\.?\s*(\d{1,4})\b/i);
  const n = m ? Number(m[1]) : null;
  if (!n || n < 1) return null;
  if (numPages && n > numPages) return null;
  return n;
}

/**
 * 这次提问的「所在页」到底指哪页（决定上下文与回答条目标注）：
 * 附件选区页 > 问题里明说的页码 > 追问沿用话题页 > 当前屏幕页。
 * 追问时不再拿屏幕页覆盖话题页——否则模型会把读者刚滚到的那页当成新话题。
 */
export function resolvePageRole({ question, reading = null, screenPage = null, attachmentPage = null, numPages = null } = {}) {
  const attach = pageNumber(attachmentPage);
  if (attach) return { page: attach, role: 'selection' };
  const explicit = explicitPageIn(question, numPages);
  if (explicit) return { page: explicit, role: 'explicit' };
  if (reading?.inherited && !screenPageRequested(question)) {
    const topic = pageNumber(reading?.focus?.page);
    if (topic) return { page: topic, role: 'topic' };
  }
  return { page: pageNumber(screenPage) || pageNumber(reading?.page) || null, role: 'screen' };
}

export function resolveReadingRequest({ question, selection = '', page, history = [], screenRef = false, selectionSource = '' } = {}) {
  const q = String(question || '请解释我加进来的这段内容。').trim();
  const intent = readingIntent(q, selection);
  const previous = [...history].reverse().find((m) => m?.role === 'user');
  let priorFocus = cleanFocus(previous?.focus);
  // 老会话没有对象字段时，明确的问题本身仍可作为追问线索。
  if (!priorFocus && previous?.content && readingIntent(previous.content) === 'question') {
    priorFocus = { text: String(previous.content).slice(0, MAX_FOCUS), page: null, kind: 'question', source: '' };
  }
  // 「这一页讲了什么 / 这里怎么理解」是在问眼前的页面，不继承上一轮的选区对象。
  const screenQuestion = !selection && (screenRef || screenPageRequested(q));
  const dependent = intent !== 'question' && !screenQuestion;
  // 右栏选区不挂 PDF 页码：它是对话里的文字，挂上页码就会被模型当成「第 N 页原文」
  const fromRight = selectionSource === 'right';
  const focus = selection ? { text: String(selection).slice(0, MAX_FOCUS),
    page: fromRight ? null : pageNumber(page), kind: 'selection', source: fromRight ? 'right' : '' }
    : dependent && priorFocus ? priorFocus
      : { text: q.slice(0, MAX_FOCUS), page: pageNumber(page), kind: 'question', source: '' };
  const oldGuidance = [...history].reverse().find((m) => m?.role === 'user' && m.guidance)?.guidance || '';
  const guidance = intent === 'guidance' ? q.slice(0, 400) : String(oldGuidance).slice(0, 400);
  return { question: q, selection: selection ? String(selection) : focus.kind === 'selection' ? focus.text : '',
    page: focus.page || (fromRight ? null : pageNumber(page)), focus, guidance, intent,
    inherited: !selection && dependent && !!priorFocus };
}

export function readingTurn(request, answer) {
  return [{ role: 'user', content: String(request.question || '').slice(0, 12000),
    focus: cleanFocus(request.focus), guidance: String(request.guidance || '').slice(0, 400) },
  { role: 'assistant', content: String(answer || '').slice(0, 12000) }];
}

export function snapshotReadingRequest(request) {
  if (!request || typeof request !== 'object') return null;
  return { question: String(request.question || '').slice(0, 6000),
    selection: String(request.selection || '').slice(0, MAX_FOCUS), page: pageNumber(request.page),
    focus: cleanFocus(request.focus), guidance: String(request.guidance || '').slice(0, 400),
    intent: ['explain', 'followup', 'feedback', 'guidance', 'question'].includes(request.intent) ? request.intent : 'question',
    inherited: !!request.inherited };
}

/** 老存档的界面条目比 history 更完整：补回「释」及丢掉的原文引用。 */
export function restoreReadingHistory(history, entries = []) {
  const saved = snapshotHistory(history);
  if (saved.some((m) => m.role === 'user' && m.focus)) return saved;
  const rebuilt = [];
  let user = null;
  for (const row of entries) {
    if (!row || row.block !== 'chat') continue;
    if (row.kind === 'user') { user = row; continue; }
    if (!row.text || (row.status && row.status !== 'complete')) { user = null; continue; }
    if (row.tag === 'explanation' && row.quote) {
      const request = resolveReadingRequest({ question: '请解释这段内容。', selection: row.quote, page: row.page, history: rebuilt });
      rebuilt.push(...readingTurn(request, row.text));
      user = null;
    } else if (row.tag === 'answer' && user) {
      const request = resolveReadingRequest({ question: user.text, selection: user.quote || row.retry?.quoteText,
        page: row.page || user.page, history: rebuilt });
      rebuilt.push(...readingTurn(request, row.text));
      user = null;
    }
  }
  return rebuilt.length ? snapshotHistory(rebuilt) : saved;
}

/** 保留模型引用的原编号，过滤后也不能把 [来源3] 变成 [来源1]。 */
export function citedSources(answer, sources = []) {
  const used = new Set([...String(answer || '').matchAll(/\[来源\s*(\d+)\]/g)].map((m) => Number(m[1])));
  return sources.map((s, i) => ({ ...s, number: i + 1 })).filter((s) => used.has(s.number));
}

/** 历史只传模型支持的 role/content，原文和页码按各自回合附带。 */
export function historyMessages(history) {
  return snapshotHistory(history).slice(-6).map((m) => {
    const focus = m.role === 'user' && m.focus?.kind === 'selection' ? m.focus : null;
    return { role: m.role, content: focus
      ? `【当轮原文${focus.page ? ` · 第${focus.page}页` : ''}】\n${focus.text}\n\n【当轮问题】\n${m.content}` : m.content };
  });
}
