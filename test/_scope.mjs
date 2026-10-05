/**
 * 发送范围（读整篇论文 / 联网查资料）的测试开关 —— 全测试套件共用一份。
 *
 * ── 2026-10-05 第 2 步之后的口径（用户拍板）──────────────────────────────────
 * 范围**回到发送框**：发送框上有一个常驻芯片 + 四选项上拉栏 ——
 *   当前内容（有选中文字就发选中，没有就发当前页）/ 整篇论文 / 联网搜索 / 整篇论文 + 联网搜索。
 * 设置页那两个勾框（`#cfgUseFullText` / `#cfgUseWeb`）降级为**默认发送范围**：
 * 只决定初始值，不再直接决定「这一次发送带什么」。
 *
 * 所以测试里要拨「这一次发送带什么」必须走**范围本身**（`window.__ctx.setScopeRange`）；
 * 只改设置页的勾框是**改不动**当次发送的 —— 这正是第 2 步最容易踩的坑：
 * 老 helper 只点勾框，套件会在「以为关掉了整篇 / 联网」的情况下照旧把全文发出去。
 *
 * 兼容保留：仍然可以传 `{ full, web }` 两个布尔，helper 折算成四选项里最近的一个
 * （都不开 → 当前内容；只 full → 整篇论文；只 web → 联网搜索；都开 → 论文 + 联网）。
 * 18 个套件的调用点因此一行都不用改。
 */
export async function setScope(page, { full, web } = {}) {
  return page.evaluate(async (wantFull, wantWeb) => {
    const want = wantFull === null
      ? (wantWeb === null ? null : (wantWeb ? 'web' : 'current'))
      : (wantWeb === null ? (wantFull ? 'paper' : 'current')
        : (wantFull ? (wantWeb ? 'paper-web' : 'paper') : (wantWeb ? 'web' : 'current')));
    const before = {
      full: !!window.__state.useFullText,
      web: !!window.__state.useWeb,
      range: window.__ctx.scopeRange,
    };
    if (want) {
      window.__ctx.setScopeRange(want);
      await new Promise((r) => setTimeout(r, 120));
    }
    return {
      before, want,
      full: !!window.__state.useFullText,
      web: !!window.__state.useWeb,
      range: window.__ctx.scopeRange,
    };
  }, typeof full === 'boolean' ? full : null, typeof web === 'boolean' ? web : null);
}

/** { full, web } → 四选项 key（给需要自己算的套件用） */
export const RANGE_OF = (full, web) => (full && web ? 'paper-web' : full ? 'paper' : web ? 'web' : 'current');
