/**
 * A 线 P2.5：让 AI 自己决定读哪些页（只读工具 + 有界循环）。
 *
 * 设计（docs/提示词工程-设计.md §2.6 + docs/上下文策略-调研.md）：
 *  - 工具只读：get_reading_state / read_page(n) / search_paper(q) / read_scan_page(n) /
 *    read_page_image(n) / read_memory(topic) / list_papers / read_other_paper / read_other_paper_image；
 *  - 循环最多 AGENT_MAX_ROUNDS 轮、每轮最多 AGENT_MAX_CALLS_PER_ROUND 个工具（见常量：用户口径
 *    2026-11-02 放宽到 5 轮/4 个 —— 模型发现读错页时要能继续调用，而不是卡在最后一轮）；
 *  - 不支持 tools / 超时 / 任何异常 → **静默回退 P1.5 预装路径**（本模块只负责返回 null，不碰 UI）；
 *  - 引用白名单天然成立：最终回答只能引用「它自己读过的页」+ 初始材料里的页（由调用方合并）。
 *  - 正文里出现 DSML 形式的工具调用时，parseModelResponse 会把它还原成 toolCalls（继续执行），
 *    显示前由 stripAgentMarkup 剥离，绝不把调用标记露给用户。
 *  - 默认开启（`reader.agentRead`），失败自动回退。
 *
 * 本模块零依赖、纯逻辑，Node 可直接 import 做单测。
 */

export const AGENT_MAX_ROUNDS = 5;
export const AGENT_MAX_CALLS_PER_ROUND = 4;
export const AGENT_TOTAL_TIMEOUT_MS = 45000;
export const AGENT_CALL_TIMEOUT_MS = 15000;
export const AGENT_MAX_TOOL_RESULT_CHARS = 12000;
export const AGENT_MAX_TOOLS = 32;

/** 工具 schema（OpenAI / DeepSeek function calling 形状，也按 MCP 的「只读」语义命名） */
export const AGENT_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'get_reading_state',
      description: '获取读者当前阅读状态：文档标题、总页数、当前页、是否有文本层、当前选区/话题。不需要参数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: '读取论文某一页的正文（文本型 PDF）。用于按需查看方法、实验、结论等具体页。',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer', description: '页码，从 1 开始，不能超过总页数' } },
        required: ['page'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_paper',
      description: '在整篇论文里检索关键词，返回命中的页号与每页一小段原文。适合先定位相关页再 read_page。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索词，越具体越好，2–200 字' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_scan_page',
      description: '把扫描件某一页的原图加入本次回答材料（直接读图，不做 OCR 转写）。没有文本层的 PDF 用这个或 read_page_image。',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer', description: '页码，从 1 开始' } },
        required: ['page'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page_image',
      description: '把某一页的原图加入本次回答材料（只有视觉模型能看；调用后最终回答会附上这张页图）。',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer', description: '页码，从 1 开始' } },
        required: ['page'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: '读取与某个主题相关的后台学习记忆（读者已懂/仍困难/持续偏好），只用于调整讲解方式，不是论文证据。',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: '主题或知识点名称，≤100 字' } },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_papers',
      description: '列出 papers 文件夹里所有已导入的论文（顺序与左侧文件树一致）：序号、文件名、所在文件夹。不需要参数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_other_paper',
      description: '读取 papers 文件夹里**其它论文**（不是当前打开的这篇）的正文：给文件名和页码读那一页，或给 query 在整篇里检索关键词。用于回答关于其它论文的问题（例如「第一篇论文的第二句话是什么」）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '论文文件名（可只给唯一片段，如 1512.03385v1 或 ResNet）' },
          page: { type: 'integer', description: '页码，从 1 开始；不给则按 query 检索' },
          query: { type: 'string', description: '在论文整篇里检索的关键词（2–200 字）' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_other_paper_image',
      description: '把 papers 文件夹里某一篇论文的某一页原图加入本次回答材料（该页没有文本层/扫描件时用）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '论文文件名（可只给唯一片段）' },
          page: { type: 'integer', description: '页码，从 1 开始' },
        },
        required: ['name', 'page'],
        additionalProperties: false,
      },
    },
  },
];

/** 放进 system 末尾的「工具模式」说明（简短，不改变原有规则） */
export const AGENT_SYSTEM_NOTE = [
  `【工具模式】你可以使用只读工具自己决定读哪些材料，最多 ${AGENT_MAX_ROUNDS} 轮、每轮最多 ${AGENT_MAX_CALLS_PER_ROUND} 个工具。`,
  '读当前打开的论文：get_reading_state 看进度，search_paper 找页再 read_page 读正文；',
  '**扫描件没有文本层**：直接用 read_page_image（或 read_scan_page，效果一样：把该页原图给模型看），不要用 read_page，也不要等 OCR 转写。',
  /* 用户口径（2026-11-02）：发现读错页/页不对，要直接继续调用工具修正，不要停下来问用户，也不要把错页将就成材料。 */
  '**读到的页不对 / 不够时，立刻继续调用工具取正确页**（例如页图上的印刷页码和预期不符、或用 search_paper 发现相关页在别处）；不要把错页将就当材料回答，也不要问用户「要不要我继续读」——需要什么就直接读。',
  '用户说的页码可能是**书里印刷页码**，PDF 页码可能整体偏移：读到页图先核对页眉/页脚的印刷页码，确认偏移后再换算；换算结果要在关键结论前再读一页验证，读错就马上改读正确页。',
  '【能看的材料】除了当前打开的论文（read_page / search_paper / get_reading_state），你还可以看 papers 文件夹里**所有已导入的论文**：',
  '先用 list_papers 找到目标文件（返回顺序 = 左侧文件树顺序；用户说「第 N 篇」时按这个序号数），',
  '再用 read_other_paper({name, page}) 读指定页、用 read_other_paper({name, query}) 在整篇里检索；扫描件/无文本层时用 read_other_paper_image 取页图。',
  '用户问「某篇论文的第 N 句话 / 第几段」时：先把那一页正文读出来，再按句号/问号/感叹号/分号等完整句子边界**准确数出第 N 句**，原样引用，并说明出自哪篇论文第几页；不要凭印象改写。',
  '**不要说「我拿不到 papers 文件夹」「看不到其它论文」**——你有 list_papers / read_other_paper 工具，先查再读。',
  '引用**其它论文**的原文/页码时用专用格式：〔《文件名》p.N‖原文片段〕（没有原文片段就 〔《文件名》p.N〕）；程序会把它渲染成可点标签，点击自动打开那篇论文、跳到第 N 页并高亮原文。不要只写 p.N（那会跳到当前打开的论文）。',
  '引用原文用 `> ` 引用块，不要堆成普通段落；问「第 N 句话」时先原样引用那一句再解释。',
  '只依据实际读到的材料回答；引用页码只能来自你读过的页或材料里出现的页。',
  '材料够了就直接给最终回答（不要再调用工具）；工具调用失败时基于已有材料作答，不要编造。',
  /* 防止工具调用标记漏进正文：没有工具通道时模型可能把调用写成 DSML 文本，程序会剥离，但最好根本不写。 */
  '不要输出工具调用标记 / XML / 类似 <｜｜DSML｜｜ invoke …> 的文本；工具调用只走工具通道。没有工具可用时直接用已有材料回答，或说明还缺哪几页。',
].join('\n');

const clip = (v, n) => String(v ?? '').slice(0, n);
const toInt = (v) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) ? n : null;
};

/* ---------------------------------------------------------------- 工具调用标记（DSML）
 * 用户 2026-11-02 的真实记录里出现过两种坏情况：
 *  ① 工具轮次用完 / 没有工具通道时，模型把工具调用写成 DSML 文本（<｜｜DSML｜｜ invoke name="read_scan_page">…），
 *     结果原样显示在回答里；
 *  ② 模型发现读错页了，但轮次已经用完，没有机会再调用 —— 用户明确要求「发现不对就直接继续调用」。
 * 这里同时做：*还原*（DSML → toolCalls，让 Agent 能继续执行）和 *剥离*（显示前去掉标记，绝不露给用户）。
 * 正则容忍全角/半角竖线、大小写、换行，以及流式传输截断的半截标记。 */
function dsmlTagRe(word) {
  return new RegExp(`<[^>]*DSML[^>]*\\b${word}\\b[^>]*>`, 'gi');
}

/** 从回答正文里解析 DSML 形式的工具调用；解析不到返回 []。 */
export function parseDsmlToolCalls(content) {
  const text = String(content || '');
  if (!/DSML/i.test(text)) return [];
  const calls = [];
  const invokeRe = /<[^>]*DSML[^>]*\binvoke\b[^>]*?name="([^"]+)"[^>]*>([\s\S]*?)<[^>]*DSML[^>]*\binvoke\s*>/gi;
  const paramRe = /<[^>]*DSML[^>]*\bparameter\b[^>]*?name="([^"]+)"[^>]*>([\s\S]*?)<[^>]*DSML[^>]*\bparameter\s*>/gi;
  let m;
  while ((m = invokeRe.exec(text))) {
    const name = clip(m[1].trim(), 80);
    if (!name) continue;
    const args = {};
    let pm;
    paramRe.lastIndex = 0;
    while ((pm = paramRe.exec(m[2]))) {
      const key = clip(pm[1].trim(), 80);
      if (!key) continue;
      let val = pm[2].trim();
      if (/^-?\d+$/.test(val)) val = Number(val);
      else if (val === 'true' || val === 'false') val = val === 'true';
      else if (val === 'null') val = null;
      args[key] = val;
    }
    calls.push({ id: `dsml_${calls.length}`, name, args });
  }
  return calls;
}

/** 把 DSML 工具调用标记从回答里剥离（含流式中途的半截标记）。 */
export function stripAgentMarkup(text) {
  let s = String(text ?? '');
  if (!/DSML/i.test(s)) return s;
  const countTags = (re) => (s.match(re) || []).length;
  // ① 流式中途：calls / invoke 块还没闭合 → 从块首整段隐藏（参数文本也绝不显示给用户）
  const callsOpen = s.search(/<[^>]*DSML[^>]*\bcalls\b[^>]*>/i);
  if (callsOpen >= 0 && countTags(/<[^>]*DSML[^>]*\bcalls\b[^>]*>/gi) % 2 === 1) {
    s = s.slice(0, callsOpen);
  } else {
    const invokeOpen = s.search(/<[^>]*DSML[^>]*\binvoke\b[^>]*>/i);
    if (invokeOpen >= 0 && countTags(/<[^>]*DSML[^>]*\binvoke\b[^>]*>/gi) % 2 === 1) s = s.slice(0, invokeOpen);
  }
  // ② 完整块整段删除（连同里面只给程序看的参数文本）
  s = s.replace(/<[^>]*DSML[^>]*\bcalls\b[^>]*>[\s\S]*?<[^>]*DSML[^>]*\bcalls\b[^>]*>/gi, '');
  s = s.replace(/<[^>]*DSML[^>]*\binvoke\b[^>]*>[\s\S]*?<[^>]*DSML[^>]*\binvoke\b[^>]*>/gi, '');
  // ③ 残留控制标签 / 被截断的半个标记
  s = s.replace(/<[^>]*DSML[^>]*>/gi, '');
  s = s.replace(/<[^>]*$/g, (tail) => (/DSML/i.test(tail) ? '' : tail));
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.replace(/^\s+|\s+$/g, '');
}

/** 工具参数校验（严格白名单；越界/类型错直接返回错误给模型，不抛） */
export function validateToolCall(call, { numPages = 0 } = {}) {
  const name = String(call?.name || '');
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  const spec = AGENT_TOOL_SPECS.find((s) => s.function.name === name);
  if (!spec) return { error: `未知工具：${name || '(空)'}` };
  if (name === 'get_reading_state') return { name, args: {} };
  const page = toInt(args.page);
  if (name === 'read_page' || name === 'read_scan_page' || name === 'read_page_image') {
    if (page === null || page < 1) return { error: 'page 必须是 ≥1 的整数' };
    if (numPages && page > numPages) return { error: `page 超出总页数（1–${numPages}）` };
    return { name, args: { page } };
  }
  if (name === 'search_paper') {
    const query = clip(args.query, 200).trim();
    if (query.length < 2) return { error: 'query 至少 2 个字' };
    return { name, args: { query } };
  }
  if (name === 'read_memory') {
    const topic = clip(args.topic, 100).trim();
    if (!topic) return { error: 'topic 不能为空' };
    return { name, args: { topic } };
  }
  if (name === 'list_papers') return { name, args: {} };
  if (name === 'read_other_paper') {
    const paper = clip(args.name, 200).trim();
    if (!paper) return { error: 'name 不能为空（论文文件名或片段）' };
    const page = toInt(args.page);
    const query = clip(args.query, 200).trim();
    if (page === null && !query) return { error: 'read_other_paper 需要 page 或 query 之一' };
    if (page !== null && page < 1) return { error: 'page 必须是 ≥1 的整数' };
    return { name, args: { name: paper, ...(page !== null ? { page } : {}), ...(query ? { query } : {}) } };
  }
  if (name === 'read_other_paper_image') {
    const paper = clip(args.name, 200).trim();
    const page = toInt(args.page);
    if (!paper) return { error: 'name 不能为空（论文文件名或片段）' };
    if (page === null || page < 1) return { error: 'page 必须是 ≥1 的整数' };
    return { name, args: { name: paper, page } };
  }
  return { error: `工具参数不合法：${name}` };
}

/**
 * 解析上游非流式响应 → { content, toolCalls }。
 * 兼容 Chat Completions（choices[0].message.tool_calls）与部分网关的扁平写法。
 */
export function parseModelResponse(json) {
  const msg = json?.choices?.[0]?.message || json?.message || {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : (Array.isArray(json?.tool_calls) ? json.tool_calls : []);
  let toolCalls = rawCalls.map((c, i) => {
    let args = c?.function?.arguments ?? c?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return {
      id: String(c?.id || `call_${i}`),
      name: String(c?.function?.name || c?.name || ''),
      args: args && typeof args === 'object' ? args : {},
    };
  });
  let content = typeof msg.content === 'string' ? msg.content : '';
  /* 工具通道没解析出来、但正文里写着 DSML 调用时：把它当成工具调用继续执行。
     用户口径（2026-11-02）：「发现不对要能直接继续调用」——不能让模型因为格式写成文本就丢掉这次读取。 */
  if (!toolCalls.length) {
    const dsmlCalls = parseDsmlToolCalls(content);
    if (dsmlCalls.length) {
      toolCalls = dsmlCalls;
      content = stripAgentMarkup(content);
    }
  }
  return {
    content,
    toolCalls,
    finishReason: json?.choices?.[0]?.finish_reason || '',
  };
}

/**
 * 执行一个工具调用（runtime 提供实现，全部只读）。
 * runtime：{ numPages, getReadingState, readPage, searchPaper, readScanPage, readPageImage, readMemory }
 * 返回 { ok:true, value } 或 { ok:false, error }；任何异常都收敛成错误文本给模型。
 */
export async function executeToolCall(call, runtime) {
  const check = validateToolCall(call, { numPages: runtime?.numPages || 0 });
  if (check.error) return { ok: false, error: check.error };
  try {
    const { name, args } = check;
    let value;
    if (name === 'get_reading_state') value = await runtime.getReadingState();
    else if (name === 'read_page') value = await runtime.readPage(args.page);
    else if (name === 'search_paper') value = await runtime.searchPaper(args.query);
    else if (name === 'read_scan_page') value = await runtime.readScanPage(args.page);
    else if (name === 'read_page_image') value = await runtime.readPageImage(args.page);
    else if (name === 'read_memory') value = await runtime.readMemory(args.topic);
    else if (name === 'list_papers') value = await runtime.listPapers();
    else if (name === 'read_other_paper') value = await runtime.readOtherPaper(args);
    else if (name === 'read_other_paper_image') value = await runtime.readOtherPaperImage(args);
    else return { ok: false, error: `未知工具：${name}` };
    /* 工具实现用 { error } 表示「这次没办成」（例如对文本型 PDF 调 read_scan_page）。
       统一当失败处理：否则错误会被当成正常材料、页图集合也会误收。 */
    if (value && typeof value === 'object' && !Array.isArray(value) && value.error) {
      return { ok: false, error: String(value.error) };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `工具执行失败：${e?.message || e}` };
  }
}

/** 某次工具调用「正在做什么」的一句话（给右侧过程列表用；不含结果） */
export function toolStepLabel(call) {
  const name = String(call?.name || '');
  const args = call?.args || {};
  const q = clip(args.query, 40);
  if (name === 'get_reading_state') return '查看当前阅读状态';
  if (name === 'search_paper') return `检索「${q}」`;
  if (name === 'read_page') return `读取第 ${toInt(args.page) || '?'} 页`;
  if (name === 'read_scan_page') return `读取扫描页第 ${toInt(args.page) || '?'} 页`;
  if (name === 'read_page_image') return `加入第 ${toInt(args.page) || '?'} 页原图`;
  if (name === 'read_memory') return `读取学习记忆：${clip(args.topic, 30)}`;
  if (name === 'list_papers') return '查看 papers 文件夹';
  if (name === 'read_other_paper') {
    const paper = clip(args.name, 40);
    const page = toInt(args.page);
    if (page) return `读取《${paper}》第 ${page} 页`;
    return `在《${paper}》里检索「${clip(args.query, 40)}」`;
  }
  if (name === 'read_other_paper_image') return `读取《${clip(args.name, 40)}》第 ${toInt(args.page) || '?'} 页原图`;
  return name || '调用工具';
}

/** 某次工具调用「做完了什么」的一句话（给右侧过程列表用；失败时说明原因） */
export function summarizeToolResult(call, result) {
  const name = String(call?.name || '');
  const args = call?.args || {};
  if (!result?.ok) return `${toolStepLabel(call)}失败：${clip(result?.error || '未知错误', 120)}`;
  const v = result.value || {};
  if (name === 'get_reading_state') {
    const scans = v.scanned ? '（扫描件）' : '';
    const pages = Number.isFinite(Number(v.numPages)) ? `共 ${v.numPages} 页` : '页数未知';
    const cur = Number.isFinite(Number(v.currentPage)) ? `，当前第 ${v.currentPage} 页` : '';
    return `阅读状态：${pages}${cur}${scans}`;
  }
  if (name === 'search_paper') {
    const pages = (Array.isArray(v.pages) ? v.pages : []).map((p) => toInt(p?.page)).filter((p) => p !== null);
    return pages.length ? `检索「${clip(args.query, 40)}」→ 命中 ${pages.map((p) => `p.${p}`).join('、')}` : `检索「${clip(args.query, 40)}」→ 没有命中`;
  }
  if (name === 'read_scan_page') {
    const page = toInt(v.page) || toInt(args.page) || '?';
    if (v.imageAttached) return `已加入第 ${page} 页原图（直接读图）`;
    return `已读取扫描页第 ${page} 页`;
  }
  if (name === 'read_page' || name === 'read_scan_page') {
    const page = toInt(v.page) || toInt(args.page);
    const chars = String(v.text || '').length;
    return `已读取第 ${page || '?'} 页（${chars.toLocaleString()} 字）`;
  }
  if (name === 'read_page_image') return `已加入第 ${toInt(v.page) || toInt(args.page) || '?'} 页原图`;
  if (name === 'read_memory') {
    const hits = Number(v.hits ?? v.items?.length ?? v.entries?.length ?? 0);
    return `已读取学习记忆（${Number.isFinite(hits) ? hits : 0} 条）`;
  }
  if (name === 'list_papers') {
    const list = Array.isArray(v.papers) ? v.papers : [];
    return `已列出 papers 文件夹：${v.count ?? list.length} 篇`;
  }
  if (name === 'read_other_paper') {
    const paper = clip(v.name || args.name, 40);
    if (Array.isArray(v.hits)) {
      const pages = v.hits.map((h) => `p.${h.page}`).join('、');
      return v.hits.length
        ? `在《${paper}》检索「${clip(args.query, 40)}」→ ${pages}`
        : `在《${paper}》检索「${clip(args.query, 40)}」→ 没有命中`;
    }
    if (v.scanned) return `《${paper}》第 ${v.page || args.page} 页没有文本层（可改用页图）`;
    return `已读取《${paper}》第 ${v.page || args.page} 页（${String(v.text || '').length.toLocaleString()} 字，共 ${v.numPages || '?'} 页）`;
  }
  if (name === 'read_other_paper_image') return `已加入《${clip(v.name || args.name, 40)}》第 ${v.page || args.page} 页原图`;
  return `${toolStepLabel(call)}完成`;
}

/**
 * 有界 Agent 循环。
 * @param {object} opts
 * @param {Array} opts.messages 初始 messages（会克隆，不修改入参）
 * @param {object} opts.runtime 工具实现
 * @param {(req:{messages:Array, tools:Array, timeoutMs:number, signal?:AbortSignal})=>Promise<object>} opts.callModel
 *        返回 **原始上游 JSON**（内部用 parseModelResponse 解析）
 * @param {(ev:object)=>void} [opts.onStep] 过程回调（给界面逐条展示「正在干什么 / 干完了什么」；抛错不影响循环）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, messages:Array, calls:Array, rounds:number, pages:number[], imagePages:number[], reason:string}>}
 */
export async function runAgentLoop({
  messages = [], runtime = {}, callModel, signal = null, onStep = null,
  maxRounds = AGENT_MAX_ROUNDS,
  maxCallsPerRound = AGENT_MAX_CALLS_PER_ROUND,
  totalTimeoutMs = AGENT_TOTAL_TIMEOUT_MS,
  callTimeoutMs = AGENT_CALL_TIMEOUT_MS,
} = {}) {
  const emit = (ev) => { try { onStep?.(ev); } catch { /* 界面异常不影响 Agent */ } };
  const work = messages.map((m) => ({ ...m }));
  const calls = [];
  const pages = new Set();
  const imagePages = new Set();
  const deadline = Date.now() + totalTimeoutMs;
  let rounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) return { ok: false, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'aborted' };
    const left = deadline - Date.now();
    if (left <= 500) return { ok: false, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'timeout' };
    emit({ type: 'round', round: round + 1 });
    let json;
    try {
      json = await callModel({
        messages: work,
        tools: AGENT_TOOL_SPECS,
        timeoutMs: Math.max(1000, Math.min(callTimeoutMs, left)),
        signal,
      });
    } catch (e) {
      return { ok: false, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: `error:${e?.name || 'Error'}` };
    }
    rounds = round + 1;
    if (signal?.aborted) return { ok: false, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'aborted' };
    const parsed = parseModelResponse(json);
    if (!parsed.toolCalls.length) {
      // 模型认为材料够了：结束循环；调用方会用这些消息再流式生成最终回答
      emit({ type: 'ready', round: rounds });
      return { ok: true, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'done', directContent: parsed.content };
    }
    const batch = parsed.toolCalls.slice(0, maxCallsPerRound);
    emit({ type: 'tools', round: rounds, names: batch.map((c) => c.name) });
    work.push({
      role: 'assistant',
      content: parsed.content || '',
      tool_calls: batch.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    });
    for (const call of batch) {
      emit({ type: 'tool_start', round: rounds, call: { name: call.name, args: call.args } });
      const result = await executeToolCall(call, runtime);
      calls.push({ name: call.name, args: call.args, ok: result.ok, error: result.error || '' });
      emit({
        type: 'tool_done', round: rounds,
        call: { name: call.name, args: call.args },
        ok: !!result.ok, error: result.error || '', summary: summarizeToolResult(call, result),
      });
      if (result.ok) {
        const v = result.value || {};
        // 只把「当前打开论文」的页码收进依据白名单：其它论文的页码当普通文字，不做跳页按钮
        const currentDocPageTool = call.name === 'read_page' || call.name === 'read_scan_page' || call.name === 'read_page_image';
        if (currentDocPageTool && Number.isInteger(v.page)) pages.add(v.page);
        if (call.name === 'search_paper') {
          for (const row of Array.isArray(v.pages) ? v.pages : []) {
            if (Number.isInteger(row?.page)) pages.add(row.page);
          }
        }
        if (call.name === 'read_page_image' && Number.isInteger(v.page)) imagePages.add(v.page);
        /* 注意：read_scan_page 的页图由 runtime 直接收进 extraImages（最终请求会附上），
           这里不能再收进 imagePages，否则同一页会被渲染两次、重复附给模型。 */
      }
      work.push({
        role: 'tool',
        tool_call_id: call.id,
        content: clip(JSON.stringify(result.ok ? result.value : { error: result.error }), AGENT_MAX_TOOL_RESULT_CHARS),
      });
    }
    if (signal?.aborted) return { ok: false, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'aborted' };
  }
  return { ok: true, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'max-rounds' };
}

/** 统计信息：给日志/验收用，不含正文 */
export function agentStats(run) {
  return {
    rounds: run?.rounds || 0,
    calls: (run?.calls || []).length,
    ok: (run?.calls || []).filter((c) => c.ok).length,
    failed: (run?.calls || []).filter((c) => !c.ok).length,
    pages: run?.pages || [],
    imagePages: run?.imagePages || [],
    reason: run?.reason || '',
  };
}
