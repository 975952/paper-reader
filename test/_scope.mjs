/**
 * 发送范围（读整篇论文 / 联网查资料）的测试开关 —— 全测试套件共用一份。
 *
 * 背景（2026-10 用户口径）：「范围 / 选中文本 + 当前页 / 清空会话这些……第一个应该是
 * 默认全文加联网，在设置里面调节」。于是输入框旁边那一排整体撤掉：
 *   · `#optScope` / `#scopeMenu` / `.scope-menu-btn[data-scope-action]` 全部不存在了；
 *   · 开关搬进设置页，id 是 `#cfgUseFullText` / `#cfgUseWeb`，**默认都勾着**；
 *   · 语义也变了：不再是「本次发送」的一次性范围，而是和主题 / 字号一样的全局偏好，
 *     写进 `localStorage['reader.ui'].style`，刷新 / 换论文 / 换会话都算数。
 *
 * 所以测试里要拨开关必须走设置页，直接用 `document.getElementById('cfgUseWeb').click()`
 * 反而不行 —— 那个页面上的控件是**保存时才生效**的。
 */
export async function setScope(page, { full, web } = {}) {
  return page.evaluate(async (wantFull, wantWeb) => {
    const settingsOpen = () => !document.getElementById('settingsModal').classList.contains('hidden');
    if (!settingsOpen()) document.getElementById('settingsBtn').click();
    const before = { full: !!window.__state.useFullText, web: !!window.__state.useWeb };
    const set = (id, want) => {
      if (typeof want !== 'boolean') return;
      const box = document.getElementById(id);
      if (box.checked !== want) box.checked = want;
    };
    set('cfgUseFullText', wantFull);
    set('cfgUseWeb', wantWeb);
    // 保存：设置页里 API Key 那一段可能顺带发一次连通性测试，但 UI 偏好是**同步先落地**的，
    // 所以这里点完就等一小会儿拿状态，不依赖那次网络往返。
    document.getElementById('saveSettings').click();
    await new Promise((r) => setTimeout(r, 260));
    document.getElementById('closeSettings')?.click();
    return { before, full: !!window.__state.useFullText, web: !!window.__state.useWeb };
  }, typeof full === 'boolean' ? full : null, typeof web === 'boolean' ? web : null);
}
