/**
 * A 线 P2.5：Agent 只读工具循环单测（纯 Node，不需要浏览器/网络）。
 *
 *   node test/agent-unit.mjs
 *
 * 覆盖：工具 schema/参数校验、模型响应解析、只读工具执行、有界循环
 * （最多 AGENT_MAX_ROUNDS 轮 / 每轮最多 AGENT_MAX_CALLS_PER_ROUND 个 / 总超时 / abort）、
 * 读过页的收集、失败回退信号。
 */
import {
  AGENT_MAX_ROUNDS, AGENT_MAX_CALLS_PER_ROUND, AGENT_TOOL_SPECS, AGENT_SYSTEM_NOTE,
  validateToolCall, parseModelResponse, executeToolCall, runAgentLoop, agentStats,
  toolStepLabel, summarizeToolResult,
} from '../public/js/agent.js';

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else failures.push({ name, detail });
};

/* ── 1. 工具声明 ── */
console.log('▶ 工具声明');
check('10 个只读工具', AGENT_TOOL_SPECS.length === 10, String(AGENT_TOOL_SPECS.length));
check('全部是 function 形状', AGENT_TOOL_SPECS.every((t) => t.type === 'function' && t.function.name && t.function.parameters));
check('工具名符合契约', AGENT_TOOL_SPECS.map((t) => t.function.name).join(',')
  === 'get_reading_state,read_page,search_paper,read_scan_page,read_page_image,read_memory,list_papers,search_papers,read_other_paper,read_other_paper_image');
check('system 说明里的轮次上限与常量一致',
  new RegExp(`最多 ${AGENT_MAX_ROUNDS} 轮、每轮最多 ${AGENT_MAX_CALLS_PER_ROUND} 个`).test(AGENT_SYSTEM_NOTE));

/* ── 2. 参数校验 ── */
console.log('\n▶ 工具参数校验');
const v = (name, args, opts) => validateToolCall({ name, args }, opts);
check('未知工具被拒', !!v('rm_rf', {}).error);
check('read_page 页码合法', !v('read_page', { page: 5 }, { numPages: 9 }).error);
check('read_page 页码 0 被拒', !!v('read_page', { page: 0 }, { numPages: 9 }).error);
check('read_page 超过总页数被拒', !!v('read_page', { page: 10 }, { numPages: 9 }).error);
check('read_page 字符串页码可转数字', v('read_page', { page: '3' }, { numPages: 9 }).args.page === 3);
check('search_paper 短查询被拒', !!v('search_paper', { query: 'a' }).error);
check('search_paper 正常查询通过', !v('search_paper', { query: '注意力机制' }).error);
check('search_papers 短查询被拒', !!v('search_papers', { query: 'a' }).error);
check('search_papers 默认 scope=folder', v('search_papers', { query: '注意力' }).args.scope === 'folder');
check('search_papers scope=all 通过', v('search_papers', { query: '注意力', scope: 'all' }).args.scope === 'all');
check('read_memory 空 topic 被拒', !!v('read_memory', { topic: '  ' }).error);
check('get_reading_state 无参数', !v('get_reading_state', {}).error);

/* ── 3. 响应解析 ── */
console.log('\n▶ 模型响应解析');
const parsed = parseModelResponse({
  choices: [{
    message: {
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{"page":3}' } },
        { id: 'call_2', type: 'function', function: { name: 'search_paper', arguments: { query: 'BLEU' } } },
      ],
    },
  }],
});
check('解析出 2 个 tool_calls', parsed.toolCalls.length === 2);
check('字符串 arguments 被解析成对象', parsed.toolCalls[0].args.page === 3);
check('对象 arguments 原样保留', parsed.toolCalls[1].args.query === 'BLEU');
check('无 tool_calls 时为空数组', parseModelResponse({ choices: [{ message: { content: '答' } }] }).toolCalls.length === 0);
check('坏 JSON arguments 不抛错', parseModelResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: '{bad' } }] } }] }).toolCalls[0].args != null);

/* ── 4. 工具执行（只读 runtime） ── */
console.log('\n▶ 工具执行');
const runtime = {
  numPages: 9,
  async getReadingState() { return { docTitle: 'T', numPages: 9, currentPage: 2, scanned: false }; },
  async readPage(page) { return { page, text: `第 ${page} 页正文` }; },
  async searchPaper(query) { return { query, pages: [{ page: 4, snippet: '命中片段' }] }; },
  async readScanPage(page) { return { page, text: `扫描 ${page}` }; },
  async readPageImage(page) { return { page, note: 'ok' }; },
  async readMemory(topic) { return { items: [{ topic, kind: 'knowledge' }] }; },
  async searchPapers() { return { query: '注意力', scope: 'folder', count: 1, hits: [{ name: 'a.pdf', page: 3 }] }; },
};
{
  for (const name of ['get_reading_state', 'read_page', 'search_paper', 'read_scan_page', 'read_page_image', 'read_memory', 'search_papers']) {
    const args = name === 'read_page' || name === 'read_scan_page' || name === 'read_page_image' ? { page: 3 }
      : name === 'search_paper' || name === 'search_papers' ? { query: '注意力' }
      : name === 'read_memory' ? { topic: '注意力' } : {};
    const r = await executeToolCall({ name, args }, runtime);
    check(`执行 ${name} 成功`, r.ok === true, JSON.stringify(r.value || r.error).slice(0, 60));
  }
  const bad = await executeToolCall({ name: 'read_page', args: { page: 99 } }, runtime);
  check('越界工具调用返回错误而不是抛异常', bad.ok === false && /总页数/.test(bad.error));
  const thrown = await executeToolCall({ name: 'read_page', args: { page: 2 } }, { ...runtime, readPage: async () => { throw new Error('boom'); } });
  check('工具内部异常被收敛成错误文本', thrown.ok === false && /boom/.test(thrown.error));
}

/* ── 5. 有界循环 ── */
console.log('\n▶ 有界 Agent 循环');
const baseMessages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '问题' }];
{
  // 第 1 轮：2 个工具；第 2 轮：直接回答 → done
  const script = [
    { choices: [{ message: { content: '', tool_calls: [
      { id: 'c1', function: { name: 'get_reading_state', arguments: '{}' } },
      { id: 'c2', function: { name: 'read_page', arguments: '{"page":2}' } },
    ] } }] },
    { choices: [{ message: { content: '最终回答' } }] },
  ];
  const callsSeen = [];
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async ({ messages, tools }) => {
      callsSeen.push({ count: messages.length, tools: tools.length });
      return script.shift();
    },
  });
  check('两轮后结束（done）', run.ok && run.rounds === 2 && run.reason === 'done', JSON.stringify(agentStats(run)));
  check('记录了 2 次工具调用', run.calls.length === 2);
  check('收集到读过的页', run.pages.includes(2), JSON.stringify(run.pages));
  check('每轮请求都带 tools', callsSeen.every((c) => c.tools === AGENT_TOOL_SPECS.length));
  check('工具结果以 role=tool 追加', run.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c2'));
  check('assistant 的 tool_calls 被原样回传', run.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 2));
}

{
  // 模型一直要工具：轮数和每轮调用数都受常量上限约束
  let modelCalls = 0;
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => {
      modelCalls++;
      return { choices: [{ message: { content: '', tool_calls: [1, 2, 3, 4, 5].map((i) => ({
        id: `c${modelCalls}_${i}`, function: { name: 'read_page', arguments: JSON.stringify({ page: ((i - 1) % 9) + 1 }) },
      })) } }] };
    },
  });
  check(`最多 ${AGENT_MAX_ROUNDS} 轮`, modelCalls === AGENT_MAX_ROUNDS, `${modelCalls}`);
  check(`每轮最多 ${AGENT_MAX_CALLS_PER_ROUND} 个工具`, run.calls.length === AGENT_MAX_ROUNDS * AGENT_MAX_CALLS_PER_ROUND, `${run.calls.length}`);
  check('轮次用尽标记 max-rounds', run.reason === 'max-rounds');
}

{
  // 模型决定不调用工具（直接回答）：不算失败，交给调用方流式生成最终回答
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => ({ choices: [{ message: { content: '直接答' } }] }),
  });
  check('模型不调工具时 ok 且 done', run.ok && run.reason === 'done' && run.calls.length === 0);
  check('directContent 带回来', run.directContent === '直接答');
}

{
  // 总超时：callModel 超时 → reason timeout → 调用方回退
  const started = Date.now();
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    totalTimeoutMs: 600, callTimeoutMs: 200,
    callModel: async ({ timeoutMs }) => new Promise((resolve, reject) => {
      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs + 10);
    }),
  });
  check('超时 → ok=false 且 reason 可识别', run.ok === false && /timeout|error/.test(run.reason), run.reason);
  check('超时不会等满 25 秒', Date.now() - started < 3000, `${Date.now() - started}ms`);
}

{
  // 上游报错（模型不支持 tools）→ ok=false，调用方回退
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => { throw Object.assign(new Error('HTTP 400'), { status: 400 }); },
  });
  check('调用失败 → ok=false', run.ok === false && run.reason.startsWith('error'), run.reason);
}

{
  // abort
  const ctl = new AbortController();
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    signal: ctl.signal,
    callModel: async () => { ctl.abort(); return { choices: [{ message: { content: '' } }] }; },
  });
  check('abort 后不继续循环', run.reason === 'aborted', run.reason);
}

/* ── 6. 过程展示（右侧「一条一条列出干了什么」） ── */
console.log('\n▶ 过程展示（步骤标签 / 结果摘要 / onStep 事件）');
check('读取页步骤文案', toolStepLabel({ name: 'read_page', args: { page: 3 } }) === '读取第 3 页');
check('检索步骤文案带查询词', /检索「注意力机制」/.test(toolStepLabel({ name: 'search_paper', args: { query: '注意力机制' } })));
check('阅读状态步骤文案', toolStepLabel({ name: 'get_reading_state', args: {} }) === '查看当前阅读状态');
check('论文库检索步骤文案', /检索论文库「帅哥」（当前文件夹）/.test(toolStepLabel({ name: 'search_papers', args: { query: '帅哥', scope: 'folder' } })));
const sumLib = summarizeToolResult({ name: 'search_papers', args: { query: '帅哥' } },
  { ok: true, value: { scope: 'folder', count: 2, hits: [{}, {}], papersScanned: 8, papersTotal: 8 } });
check('论文库检索摘要带命中数', /2 条命中/.test(sumLib), sumLib);
const sumSearch = summarizeToolResult({ name: 'search_paper', args: { query: 'BLEU' } }, { ok: true, value: { pages: [{ page: 2 }, { page: 5 }] } });
check('检索结果摘要列出命中页', /命中 p\.2、p\.5/.test(sumSearch), sumSearch);
const sumRead = summarizeToolResult({ name: 'read_page', args: { page: 4 } }, { ok: true, value: { page: 4, text: 'x'.repeat(1234) } });
check('读取结果摘要带页码与字数', /读取第 4 页/.test(sumRead) && /1,234/.test(sumRead), sumRead);
const sumState = summarizeToolResult({ name: 'get_reading_state', args: {} }, { ok: true, value: { numPages: 18, currentPage: 4, scanned: false } });
check('阅读状态摘要带总页数/当前页', /共 18 页/.test(sumState) && /当前第 4 页/.test(sumState), sumState);
const sumFail = summarizeToolResult({ name: 'read_page', args: { page: 9 } }, { ok: false, error: 'page 超出总页数' });
check('失败摘要说明原因', /失败：page 超出总页数/.test(sumFail), sumFail);

{
  // onStep 事件顺序：round → tools → tool_start → tool_done ×2 → round → ready
  const script = [
    { choices: [{ message: { content: '', tool_calls: [
      { id: 'c1', function: { name: 'get_reading_state', arguments: '{}' } },
      { id: 'c2', function: { name: 'read_page', arguments: '{"page":2}' } },
    ] } }] },
    { choices: [{ message: { content: '最终回答' } }] },
  ];
  const events = [];
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => script.shift(),
    onStep: (ev) => events.push(ev),
  });
  check('onStep 收到过程事件', events.length >= 7, `${events.length} 个事件`);
  check('事件顺序 round→tools→tool_start/done→round→ready',
    events[0]?.type === 'round' && events[1]?.type === 'tools'
    && events[2]?.type === 'tool_start' && events[3]?.type === 'tool_done'
    && events[4]?.type === 'tool_start' && events[5]?.type === 'tool_done'
    && events[6]?.type === 'round' && events[7]?.type === 'ready',
    events.map((e) => e.type).join(','));
  check('tool_done 带可读摘要', events[3]?.summary === '阅读状态：共 9 页，当前第 2 页' && /读取第 2 页/.test(events[5]?.summary || ''),
    `${events[3]?.summary} / ${events[5]?.summary}`);
  check('循环结果不受 onStep 影响', run.ok && run.rounds === 2);
}

{
  // onStep 抛错不能打断 Agent（界面 DOM 异常也不能让回答失败）
  const run = await runAgentLoop({
    messages: baseMessages, runtime,
    callModel: async () => ({ choices: [{ message: { content: '答案' } }] }),
    onStep: () => { throw new Error('ui boom'); },
  });
  check('onStep 抛错不影响循环', run.ok && run.reason === 'done');
}

/* ── 7. 只读保证 ── */
console.log('\n▶ 只读边界');
check('agent.js 没有任何写接口（fetch / localStorage / document）',
  !/fetch\(|localStorage|document\./.test((await import('node:fs')).readFileSync(new URL('../public/js/agent.js', import.meta.url), 'utf8')));

console.log(`\n结果：${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
