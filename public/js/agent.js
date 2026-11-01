/**
 * A 线 P2.5：让 AI 自己决定读哪些页（只读工具 + 有界循环）。
 *
 * 设计（docs/提示词工程-设计.md §2.6 + docs/上下文策略-调研.md）：
 *  - 工具只读：get_reading_state / read_page(n) / search_paper(q) / read_scan_page(n) /
 *    read_page_image(n) / read_memory(topic)；
 *  - 循环最多 3 轮、每轮最多 3 个工具、整体超时 25s；
 *  - 不支持 tools / 超时 / 任何异常 → **静默回退 P1.5 预装路径**（本模块只负责返回 null，不碰 UI）；
 *  - 引用白名单天然成立：最终回答只能引用「它自己读过的页」+ 初始材料里的页（由调用方合并）。
 *  - 默认关闭（`reader.agentRead`），验收通过后再默认开启。
 *
 * 本模块零依赖、纯逻辑，Node 可直接 import 做单测。
 */

export const AGENT_MAX_ROUNDS = 3;
export const AGENT_MAX_CALLS_PER_ROUND = 3;
export const AGENT_TOTAL_TIMEOUT_MS = 25000;
export const AGENT_CALL_TIMEOUT_MS = 12000;
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
      description: '读取扫描件某一页的图片阅读索引转写文本（没有文本层的 PDF 用这个）。',
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
];

/** 放进 system 末尾的「工具模式」说明（简短，不改变原有规则） */
export const AGENT_SYSTEM_NOTE = [
  '【工具模式】你可以使用只读工具自己决定读哪些页，最多 3 轮、每轮最多 3 个工具。',
  '先看 get_reading_state；不确定去哪页就先 search_paper 再 read_page；扫描件用 read_scan_page / read_page_image。',
  '只依据实际读到的材料回答；引用页码只能来自你读过的页或材料里出现的页。',
  '材料够了就直接给最终回答（不要再调用工具）；工具调用失败时基于已有材料作答，不要编造。',
].join('\n');

const clip = (v, n) => String(v ?? '').slice(0, n);
const toInt = (v) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) ? n : null;
};

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
  return { error: `工具参数不合法：${name}` };
}

/**
 * 解析上游非流式响应 → { content, toolCalls }。
 * 兼容 Chat Completions（choices[0].message.tool_calls）与部分网关的扁平写法。
 */
export function parseModelResponse(json) {
  const msg = json?.choices?.[0]?.message || json?.message || {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : (Array.isArray(json?.tool_calls) ? json.tool_calls : []);
  const toolCalls = rawCalls.map((c, i) => {
    let args = c?.function?.arguments ?? c?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return {
      id: String(c?.id || `call_${i}`),
      name: String(c?.function?.name || c?.name || ''),
      args: args && typeof args === 'object' ? args : {},
    };
  });
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
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
    if (name === 'get_reading_state') return { ok: true, value: await runtime.getReadingState() };
    if (name === 'read_page') return { ok: true, value: await runtime.readPage(args.page) };
    if (name === 'search_paper') return { ok: true, value: await runtime.searchPaper(args.query) };
    if (name === 'read_scan_page') return { ok: true, value: await runtime.readScanPage(args.page) };
    if (name === 'read_page_image') return { ok: true, value: await runtime.readPageImage(args.page) };
    if (name === 'read_memory') return { ok: true, value: await runtime.readMemory(args.topic) };
    return { ok: false, error: `未知工具：${name}` };
  } catch (e) {
    return { ok: false, error: `工具执行失败：${e?.message || e}` };
  }
}

/**
 * 有界 Agent 循环。
 * @param {object} opts
 * @param {Array} opts.messages 初始 messages（会克隆，不修改入参）
 * @param {object} opts.runtime 工具实现
 * @param {(req:{messages:Array, tools:Array, timeoutMs:number, signal?:AbortSignal})=>Promise<object>} opts.callModel
 *        返回 **原始上游 JSON**（内部用 parseModelResponse 解析）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, messages:Array, calls:Array, rounds:number, pages:number[], imagePages:number[], reason:string}>}
 */
export async function runAgentLoop({
  messages = [], runtime = {}, callModel, signal = null,
  maxRounds = AGENT_MAX_ROUNDS,
  maxCallsPerRound = AGENT_MAX_CALLS_PER_ROUND,
  totalTimeoutMs = AGENT_TOTAL_TIMEOUT_MS,
  callTimeoutMs = AGENT_CALL_TIMEOUT_MS,
} = {}) {
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
      return { ok: true, messages: work, calls, rounds, pages: [...pages], imagePages: [...imagePages], reason: 'done', directContent: parsed.content };
    }
    const batch = parsed.toolCalls.slice(0, maxCallsPerRound);
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
      const result = await executeToolCall(call, runtime);
      calls.push({ name: call.name, args: call.args, ok: result.ok, error: result.error || '' });
      if (result.ok) {
        const v = result.value || {};
        if (Number.isInteger(v.page)) pages.add(v.page);
        for (const row of Array.isArray(v.pages) ? v.pages : []) {
          if (Number.isInteger(row?.page)) pages.add(row.page);
        }
        if (call.name === 'read_page_image' && Number.isInteger(v.page)) imagePages.add(v.page);
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
