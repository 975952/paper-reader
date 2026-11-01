import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, validateProfile, buildProfileBlock, selectProfileItems, profileStore, MAX_ITEMS } from '../public/js/profile.js';
import { parseMemorySuggestions, withMemoryObservations, shouldExtractMemory, createLearningMemory, memoryExtractMessages, explicitIdentityFacts } from '../public/js/learning-memory.js';
import security from '../security.js';

const source = { docId: 'paper-a', paper: 'Attention paper', capability: 'chat' };
const at = '2026-10-25T10:20:30+08:00';
const input = (evidence, extras = {}) => ({ topic: '矩阵乘法', aliases: ['matrix multiplication'], kind: 'knowledge',
  scope: 'global', signal: 'self_report', level: '会矩阵乘法', boundary: '会计算，未验证实现', evidence, ...extras });
const parse = (question, extras = {}) => parseMemorySuggestions(JSON.stringify([input(question, extras)]), question);
const apply = (profile, question, extras = {}) => withMemoryObservations(profile, parse(question, extras), { source, at });

test('只接受当前用户原话作为证据，助手输出和凭空生成的证据不能保存', () => {
  assert.equal(parseMemorySuggestions(JSON.stringify([input('我已经完全掌握了')]), '请给我解释矩阵乘法').length, 0);
  assert.equal(parse('矩阵乘法我会计算').length, 1);
  assert.equal(parseMemorySuggestions('[{"topic":{"x":1},"evidence":"我会","signal":"self_report"}]', '我会').length, 0);
  assert.deepEqual(parseMemorySuggestions('not json', '我会矩阵乘法'), []);
  assert.equal(parseMemorySuggestions(JSON.stringify([input('矩阵乘法')]), '请解释矩阵乘法').length, 0);
  assert.equal(parseMemorySuggestions(JSON.stringify([input('我不会矩阵乘法')]), '我不会矩阵乘法').length, 0);
});

test('继续、问号和空输入不会产生掌握推断或后台请求', () => {
  for (const text of ['', '继续。', '继续下一步', '好的', '谢谢', '？', 'ok']) assert.equal(shouldExtractMemory(text), false, text);
  assert.equal(shouldExtractMemory('矩阵乘法我还没弄懂'), true);
  assert.equal(shouldExtractMemory('apiKey=sk-this-is-a-fake-secret-value'), false);
});

test('自述会计算只记录自述，双端校验保留原话、边界、别名和时间', () => {
  const profile = apply(emptyProfile(), '矩阵乘法我会计算');
  const checked = security.checkProfile(profile);
  assert.equal(checked.error, undefined);
  const restored = validateProfile(checked.value).data.items[0];
  assert.equal(restored.memory.signal, 'self_report');
  assert.equal(restored.memory.evidence, '矩阵乘法我会计算');
  assert.equal(restored.updatedAt, at);
  assert.equal(restored.boundary, '会计算，未验证实现');
  assert.equal(restored.basis, 'user_self_report');
});

test('新的不会反馈更新已有主题，而不是重复添加或保留错误掌握判断', () => {
  const before = apply(emptyProfile(), '矩阵乘法我会计算');
  const next = apply(before, '你记错了，矩阵乘法我还不会', { signal: 'needs_help', level: '不会矩阵乘法', boundary: '' });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].id, before.items[0].id);
  assert.equal(next.items[0].memory.signal, 'needs_help');
  assert.match(next.items[0].boundary, /不能按已经掌握跳过/);
  assert.equal(before.items[0].memory.signal, 'self_report');
});

test('原理和具体子技能分别保存，不宽泛合并或覆盖整个领域', () => {
  const before = apply(emptyProfile(), '矩阵乘法我会计算');
  const next = apply(before, '矩阵乘法的梯度我还不会', { topic: '矩阵乘法的梯度', aliases: [], signal: 'needs_help' });
  assert.equal(next.items.length, 2);
  assert.equal(next.items[0].memory.signal, 'self_report');
});

test('新的弱推测不能抹去用户明确指出的薄弱环节', () => {
  const before = apply(emptyProfile(), '我不会矩阵乘法', { signal: 'needs_help' });
  const next = apply(before, '矩阵乘法为什么要这样算', { signal: 'inferred', level: '可能已经会计算', boundary: '' });
  assert.equal(next, null);
  assert.equal(before.items[0].memory.signal, 'needs_help');
});

test('一次正确表现保持依据有限，不转换为已确认掌握', () => {
  const next = apply(emptyProfile(), '所以两个矩阵的内维度要相同', { signal: 'demonstrated', level: '能指出内维度约束' });
  assert.equal(next.items[0].basis, 'model_inferred');
  assert.equal(next.items[0].status, 'pending');
  assert.equal(next.items[0].lastConfirmedAt, null);
  assert.match(buildProfileBlock(next, '', '矩阵乘法'), /尚不能泛化/);
});

test('长期偏好自动保留，临时要求不扩大成跨会话偏好', () => {
  assert.equal(parse('这次讲简单点', { kind: 'preference', signal: 'preference' }).length, 0);
  const next = apply(emptyProfile(), '以后先给例子再讲公式', { topic: '讲解顺序', kind: 'preference', signal: 'preference', level: '先例子后公式' });
  assert.match(buildProfileBlock(next, '', '解释卷积'), /先例子后公式/);
});

test('身份自述（称呼/名字）会被记住，且与论文问题无关也始终注入', () => {
  const question = '我叫Cyan请记住';
  const identity = (extras = {}) => ({ topic: '称呼', aliases: [], kind: 'identity', scope: 'global',
    signal: 'self_report', level: '称呼：Cyan', boundary: '', evidence: question, ...extras });
  const parsed = parseMemorySuggestions(JSON.stringify([identity()]), question);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'identity');
  assert.equal(parsed[0].scope, 'global');
  // 身份必须来自本轮原话、必须像自我介绍、不许夹带敏感信息；拆成 paper 也强制 global
  assert.equal(parseMemorySuggestions(JSON.stringify([identity({ evidence: '我叫Alice' })]), question).length, 0);
  assert.equal(parseMemorySuggestions(JSON.stringify([identity({ evidence: '请记住' })]), question).length, 0);
  assert.equal(parseMemorySuggestions(JSON.stringify([identity({ evidence: '我叫Cyan，我的邮箱 cyan@example.com' })]),
    '我叫Cyan，我的邮箱 cyan@example.com').length, 0);
  assert.equal(parseMemorySuggestions(JSON.stringify([identity({ scope: 'paper' })]), question)[0].scope, 'global');
  // 写入 → 双端校验 → 注入：问题里没有「Cyan / 称呼」也必须带上
  const profile = withMemoryObservations(emptyProfile(), parsed, { source, at });
  assert.equal(profile.items[0].memory.kind, 'identity');
  assert.equal(profile.items[0].status, 'confirmed');
  assert.equal(profile.items[0].basis, 'user_self_report');
  assert.equal(security.checkProfile(profile).error, undefined);
  const block = buildProfileBlock(profile, '', '细胞生物学的问题');
  assert.match(block, /Cyan/);
  assert.match(block, /用户自述身份/);
});

test('身份记忆不会从普通提问里推断，也不和知识/偏好混用', () => {
  const fromElsewhere = JSON.stringify([{ topic: '称呼', evidence: '我叫Cyan', kind: 'identity', scope: 'global',
    signal: 'self_report', level: '称呼：Cyan' }]);
  assert.equal(parseMemorySuggestions(fromElsewhere, '请解释注意力机制').length, 0);
  assert.equal(parse('我叫Cyan请记住', { kind: 'preference', signal: 'preference' }).length, 0);
  assert.equal(parse('我叫Cyan请记住', { kind: 'knowledge', signal: 'self_report' }).length, 0);
  assert.match(security.checkProfile(emptyProfile()).error || '', /^$/); // 空档案本身可校验
});

test('明确说「请记住」的名字/称呼走确定性路径，不依赖模型提取', () => {
  assert.deepEqual(explicitIdentityFacts('我叫Cyan请记住').map((o) => [o.kind, o.topic, o.level]),
    [['identity', '称呼', '称呼：Cyan']]);
  assert.deepEqual(explicitIdentityFacts('我的名字是 小明，请记住').map((o) => o.level), ['称呼：小明']);
  assert.deepEqual(explicitIdentityFacts('请记住称呼我 Bob').map((o) => o.level), ['称呼：Bob']);
  assert.deepEqual(explicitIdentityFacts('我叫Cyan'), [], '没有明确要求记住时不走确定性路径');
  assert.deepEqual(explicitIdentityFacts('请记住这个公式叫注意力机制'), [], '不是自述身份的不记');
  assert.deepEqual(explicitIdentityFacts('请记住我的邮箱 cyan@example.com'), [], '敏感信息不记');
  // 确定性提取的观察同样要过严格校验（写入后 confirmed、跨论文常驻）
  const facts = explicitIdentityFacts('我叫Cyan请记住');
  const profile = withMemoryObservations(emptyProfile(), facts, { source, at });
  assert.equal(profile.items[0].status, 'confirmed');
  assert.match(buildProfileBlock(profile, '', '完全无关的问题'), /Cyan/);
});

test('身份记忆可以自然语言删除，删除后不再注入', () => {  const question = '我叫Cyan请记住';
  const profile = withMemoryObservations(emptyProfile(), parseMemorySuggestions(JSON.stringify([{
    topic: '称呼', kind: 'identity', scope: 'global', signal: 'self_report', level: '称呼：Cyan', evidence: question,
  }]), question), { source, at });
  assert.match(buildProfileBlock(profile, '', '无关问题'), /Cyan/);
  const removed = withMemoryObservations(profile, parseMemorySuggestions(JSON.stringify([{
    topic: '称呼', kind: 'identity', scope: 'global', signal: 'self_report', level: '称呼：Cyan',
    evidence: '忘记我的称呼记录', action: 'forget', id: profile.items[0].id,
  }]), '忘记我的称呼记录'), { source, at });
  assert.equal(removed.items.length, 0);
  assert.equal(buildProfileBlock(removed, '', '无关问题'), '');
});

test('忘记只删除指定条目，表达自己忘了知识点不会触发删除', () => {
  const before = apply(emptyProfile(), '矩阵乘法我会计算');
  const removed = apply(before, '请忘记我会矩阵乘法这条记录', { action: 'forget', id: before.items[0].id });
  assert.equal(removed.items.length, 0);
  assert.equal(parse('我忘了矩阵乘法', { action: 'forget' }).length, 0);
  assert.equal(parse('请继续讲矩阵乘法', { action: 'forget' }).length, 0);
});

test('中文知识通过英文别名匹配；无关记录即使是 pending 也不注入', () => {
  const next = apply(emptyProfile(), '矩阵乘法我会计算');
  assert.equal(selectProfileItems(next, 'We use matrix multiplication', '').length, 1);
  assert.equal(selectProfileItems(next, 'The biology of cells', '').length, 0);
  next.items[0].status = 'pending';
  assert.equal(buildProfileBlock(next, '', '细胞是什么'), '');
});

test('论文专属理解困难不跨论文使用', () => {
  const next = apply(emptyProfile(), '这个投影公式我没懂', { topic: '投影公式', scope: 'paper', signal: 'needs_help' });
  assert.match(buildProfileBlock(next, '', '投影公式', { docId: 'paper-a' }), /仍需讲解/);
  assert.equal(buildProfileBlock(next, '', '投影公式', { docId: 'paper-b' }), '');
});

test('提示词包括边界与证据，超长历史自述和条目也不能突破预算', () => {
  const profile = apply(emptyProfile(), '矩阵乘法我会计算', { boundary: '边界'.repeat(1000) });
  profile.selfReport = '学过数学。'.repeat(1000);
  const text = buildProfileBlock(profile, '', '矩阵乘法');
  assert.ok(text.length <= 1200);
  assert.match(text, /当前用户的要求和纠正优先/);
  assert.match(text, /不(?:要)?强制用户确认档案/);
});

test('自动记忆达到上限后有限保留，不使后续所有保存失败', () => {
  const profile = apply(emptyProfile(), '矩阵乘法我会计算');
  profile.items = Array.from({ length: MAX_ITEMS }, (_, n) => ({ ...profile.items[0], id: `old-${n}`, topic: `旧主题${n}`, aliases: [] }));
  const next = apply(profile, '我不会卷积', { topic: '卷积', aliases: [], signal: 'needs_help' });
  assert.equal(next.items.length, MAX_ITEMS);
  assert.ok(next.items.some((i) => i.topic === '卷积'));
});

test('提取输入有固定预算，英文单词别名也能关联中文概念', () => {
  const profile = apply(emptyProfile(), '注意力机制我懂了', { topic: '注意力机制', aliases: ['Attention'] });
  assert.equal(selectProfileItems(profile, 'Attention maps queries and keys', '').length, 1);
  profile.items = Array.from({ length: 20 }, (_, i) => ({ ...profile.items[0], id: `big-${i}`, boundary: '边界'.repeat(1000) }));
  const messages = memoryExtractMessages({ question: '注意力机制'.repeat(2000), answer: '解释'.repeat(8000), profile, source,
    history: Array.from({ length: 8 }, () => ({ role: 'assistant', content: '历史'.repeat(8000) })) });
  assert.ok(messages[1].content.length <= 16000);
  const escaped = memoryExtractMessages({ question: '\u0001'.repeat(4000), answer: '\u0002'.repeat(4000), profile, source,
    history: Array.from({ length: 4 }, () => ({ role: 'user', content: '\u0003'.repeat(2000) })) });
  assert.ok(escaped[1].content.length <= 16000);
});

test('后台串行处理、短回答也提取、论文切换后仍保留原来源；失败后可以恢复', async () => {
  let calls = 0;
  const store = { data: emptyProfile(), enabled: true, update: async (fn) => { store.data = fn(store.data) || store.data; } };
  const memory = createLearningMemory({ store, extract: async (messages) => {
    calls++;
    if (calls === 1) throw new Error('controlled extraction failure');
    const payload = JSON.parse(messages.at(-1).content);
    return JSON.stringify([input(payload.本轮用户原话)]);
  } });
  const turn = { question: '矩阵乘法我会计算', answer: '好的。', source: { ...source } };
  memory.observe({ ...turn, question: '继续' });
  memory.observe(turn);
  const saved = memory.observe({ ...turn, question: '矩阵乘法的形状我懂了' });
  turn.source.docId = 'paper-b';
  await saved;
  assert.equal(calls, 2);
  assert.equal(store.data.items.length, 1);
  assert.equal(store.data.items[0].source.docId, 'paper-a');
});

test('连续保存合并最新数据；冲突重读重试；写盘失败不制造虚假成功', async () => {
  const original = globalThis.fetch;
  let disk = emptyProfile();
  let conflict = true;
  let fail = false;
  const snapshot = { data: profileStore.data, loaded: profileStore.loaded, error: profileStore.error, writeQueue: profileStore.writeQueue };
  globalThis.fetch = async (url, options) => {
    if (!options?.method) return { ok: true, json: async () => structuredClone(disk) };
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    if (conflict) {
      conflict = false;
      disk = { ...disk, revision: 1, selfReport: '另一窗口原有资料' };
      return { ok: false, status: 409, json: async () => ({}) };
    }
    assert.equal(Number(options.headers['If-Match']), disk.revision);
    disk = JSON.parse(options.body);
    return { ok: true };
  };
  try {
    await Promise.all([
      profileStore.update((p) => apply(p, '矩阵乘法我会计算')),
      profileStore.update((p) => apply(p, '卷积我不会', { topic: '卷积', aliases: [], signal: 'needs_help' })),
    ]);
    assert.equal(disk.items.length, 2);
    assert.equal(disk.selfReport, '另一窗口原有资料');
    fail = true;
    await assert.rejects(profileStore.update((p) => apply(p, '我不会反向传播', { topic: '反向传播', aliases: [], signal: 'needs_help' })));
    assert.equal(profileStore.data.items.length, 2);
    fail = false;
    await profileStore.update((p) => apply(p, '我不会反向传播', { topic: '反向传播', aliases: [], signal: 'needs_help' }));
    assert.equal(disk.items.length, 3);
  } finally {
    globalThis.fetch = original;
    Object.assign(profileStore, snapshot);
  }
});
