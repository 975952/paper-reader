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
