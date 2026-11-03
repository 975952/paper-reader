/* 会话系统 P0（2026-11，用户拍板 B：进文件夹默认显示空态选择卡片）
 *
 * 这个模块只做「会话管理」这一件事：
 *   - 会话头（标题 / 运行状态点 / 新建 / 历史）
 *   - 快速切换浮层（点标题）
 *   - 全高历史面板（搜索 / 分组 / 行内重命名 / 置顶 / 归档 / 删除 / 应用内确认）
 *   - 进文件夹的「空态选择卡片」（继续上次 / 新建 / 最近会话 / 默认进入方式）
 *   - 会话 meta 接口（GET /api/sessions、PATCH /api/session、DELETE /api/session、move-folder）
 *
 * 与 app.js 的边界：本模块不 import app.js（避免循环依赖），app.js 在启动时调用
 * initSessions(ctx) 注入一组回调（打开/切换/新建/删除会话、渲染结果区、读写当前会话…）。
 * 会话列表的「当前 sid」始终以 app.js 的 activeSidFor 为准，本模块只镜像缓存。
 */

import { $, el, toast } from './util.js';

const ON_ENTER_KEY = 'reader.session.onEnter';     // choose（默认，用户拍板 B）/ resume / new
const ACTIVE_SESSION_KEY = 'reader.activeSession'; // 与 app.js 的 SESSION_KEY 同一个存档
const LIST_LIMIT = 300;
const ALL_LIST_LIMIT = 500;
const DAY = 24 * 60 * 60 * 1000;

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.2v13.6M5.2 12h13.6"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6.4h16M4 12h16M4 17.6h16"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.6 5.4 8 12l6.6 6.6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.4 3.6h5.2l-.7 5.1 3.3 3.3v2.2H6.8v-2.2l3.3-3.3z"/><path d="M12 14.2v6.2"/></svg>',
  archive: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.2h16v3.6H4z"/><path d="M5.4 8.8v9.2a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6V8.8"/><path d="M10 12.4h4"/></svg>',
  rename: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 19.4h4.2L19 9.2a2.4 2.4 0 0 0-3.4-3.4L5.4 16z"/><path d="m13.8 7.6 3.2 3.2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 6.6h14.8"/><path d="M9.2 6.6V4.8h5.6v1.8"/><path d="M6.6 6.6 7.4 20h9.2l.8-13.4"/><path d="M10.2 10.4v5.6M13.8 10.4v5.6"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7.4"/></svg>',
};

const st = {
  ctx: null,
  folderPath: '',
  folderKey: '',
  docId: '',
  /** 当前文件夹的会话 meta（含已归档，服务端 limit 内） */
  list: [],
  /** scope=all 的缓存，只在历史面板「全部文件夹」时拉取 */
  allList: [],
  listLoaded: false,
  listLoading: false,
  /** 镜像 app.js 的 activeSidFor（app 是唯一事实来源，这里只用于渲染） */
  currentSid: '',
  entryVisible: false,
  busy: false,
  historyOpen: false,
  quickOpen: false,
  scope: 'folder',
  histQuery: '',
  quickQuery: '',
  showArchived: false,
  /** null = 没有行处于改名态；'' 是旧默认会话的合法 sid，不能拿它当哨兵 */
  renameSid: null,
  confirmResolve: null,
  ui: null,
};

/* ───────────────────────────── 基础工具 ───────────────────────────── */

function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (!Number.isFinite(min) || min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const dt = new Date(t);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
}

function normalizeRows(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    sid: String(r?.sid || ''),
    title: String(r?.title || ''),
    titleSource: String(r?.titleSource || 'auto'),
    preview: String(r?.preview || ''),
    count: Number(r?.count) || 0,
    createdAt: Number(r?.createdAt) || 0,
    updatedAt: Number(r?.updatedAt) || 0,
    lastOpenedAt: Number(r?.lastOpenedAt) || 0,
    pinned: !!r?.pinned,
    pinnedAt: Number(r?.pinnedAt) || 0,
    archived: !!r?.archived,
    archivedAt: Number(r?.archivedAt) || 0,
    folderPath: String(r?.folderPath || ''),
    folderDisplay: String(r?.folderPath || ''),
    docIds: Array.isArray(r?.docIds) ? r.docIds : [],
    docTitles: Array.isArray(r?.docTitles) ? r.docTitles : [],
  }));
}

function readOnEnter() {
  try {
    const v = localStorage.getItem(ON_ENTER_KEY);
    return v === 'resume' || v === 'new' ? v : 'choose';
  } catch { return 'choose'; }
}

function setOnEnter(mode) {
  try { localStorage.setItem(ON_ENTER_KEY, mode); } catch { /* ignore */ }
  renderModeChips(st.ui?.entry?.querySelector('#sessEntryModes'));
  renderModeChips(st.ui?.history?.querySelector('#sessHistModes'));
}

function isStale(row) {
  if (!row) return true;
  if ((row.count || 0) > 60) return true;
  const ts = row.updatedAt || row.lastOpenedAt || 0;
  return !!ts && (Date.now() - ts) > 7 * DAY;
}

/** 生成中守卫：所有会改变会话归属/显示的动作都要先过这一道（修 v3 缺陷③） */
function guardBusy(label) {
  if (st.busy || st.ctx?.isBusy?.()) {
    toast(`正在生成中，先等它跑完或点停止再${label}`, 'err', 3200);
    return false;
  }
  return true;
}

function errorOf(j, r) {
  return j?.error?.message || j?.error || `HTTP ${r.status}`;
}

function sessButton(icon, title, cls, onclick, extra = {}) {
  return el('button', {
    type: 'button',
    class: cls,
    title,
    'aria-label': title,
    html: ICONS[icon] || '',
    onclick,
    ...extra,
  });
}

/* ───────────────────────────── 接口 ───────────────────────────── */

async function fetchFolderList() {
  const q = new URLSearchParams({
    doc: st.folderKey,
    folderPath: st.folderPath,
    scope: 'folder',
    archived: 'all',
    limit: String(LIST_LIMIT),
  });
  const r = await fetch(`/api/sessions?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errorOf(j, r));
  return normalizeRows(j.sessions);
}

async function fetchAllList() {
  const q = new URLSearchParams({
    doc: st.folderKey,
    folderPath: st.folderPath,
    scope: 'all',
    archived: 'all',
    limit: String(ALL_LIST_LIMIT),
  });
  const r = await fetch(`/api/sessions?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errorOf(j, r));
  return normalizeRows(j.sessions);
}

/** 行所属文件夹的 session key：当前文件夹优先用 app 的事实（folderKeyOf），
 *  跨文件夹的行用它自己的 folderPath 现算。 */
function keyForRow(row) {
  if (!st.ctx) return st.folderKey;
  if (!st.scope || st.scope === 'folder') return st.folderKey;
  if ((row.folderPath || '') === (st.folderPath || '')) return st.folderKey;
  return st.ctx.folderKeyOf(row.folderPath || '');
}

async function patchMeta(row, patch) {
  try {
    const q = new URLSearchParams({ doc: keyForRow(row), sid: row.sid });
    const r = await fetch(`/api/session?${q}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errorOf(j, r));
    if (j.session && typeof j.session === 'object') {
      Object.assign(row, normalizeRows([j.session])[0] || {}, j.session);
    }
    if (patch.pinned !== undefined) { row.pinned = !!patch.pinned; row.pinnedAt = patch.pinned ? (row.pinnedAt || Date.now()) : 0; }
    if (patch.archived !== undefined) { row.archived = !!patch.archived; row.archivedAt = patch.archived ? (row.archivedAt || Date.now()) : 0; }
    if (patch.title !== undefined) {
      row.title = String(patch.title || '');
      row.titleSource = patch.title ? 'user' : 'auto';
    }
    cacheTouched(row);
    renderHeader();
    if (st.quickOpen) renderQuickList();
    if (st.historyOpen) renderHistoryList();
    return true;
  } catch (e) {
    toast(`会话更新失败：${e.message}`, 'err', 4200);
    return false;
  }
}

/** 更新列表里的同一行（PATCH 返回的摘要可能没有 count/updatedAt 等展示字段） */
function cacheTouched(row) {
  for (const box of [st.list, st.allList]) {
    const i = box.findIndex((r) => r.sid === row.sid && (r.folderPath || '') === (row.folderPath || ''));
    if (i >= 0) box[i] = { ...box[i], ...row };
  }
}

async function deleteRowFile(row) {
  const q = new URLSearchParams({ doc: keyForRow(row), sid: row.sid });
  const r = await fetch(`/api/session?${q}`, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errorOf(j, r));
}

/* ───────────────────────────── 列表刷新 ───────────────────────────── */

async function refreshList({ force = false } = {}) {
  if (!st.ctx?.hasDoc?.()) return st.list;
  st.folderPath = st.ctx.folderPath();
  st.folderKey = st.ctx.folderKey();
  st.docId = st.ctx.doc()?.docId || '';
  st.currentSid = st.ctx.currentSid();
  if (st.listLoading && !force) return st.list;
  st.listLoading = true;
  try {
    const rows = await fetchFolderList();
    st.list = rows;
    // 同文件夹的行在 allList 里可能已旧：等下次「全部文件夹」重新拉
    if (st.scope === 'all') st.allList = st.allList.filter((r) => (r.folderPath || '') !== (st.folderPath || ''));
    st.listLoaded = true;
    st.ctx.adoptList?.(rows);
  } catch (e) {
    if (!st.listLoaded) st.list = [];
    st.listLoaded = true;
    toast(`会话列表读取失败：${e.message}`, 'err', 4200);
  } finally {
    st.listLoading = false;
  }
  renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) renderHistoryList();
  return st.list;
}

async function refreshAllList() {
  if (!st.ctx?.hasDoc?.()) return;
  try {
    st.allList = await fetchAllList();
  } catch (e) {
    st.allList = [];
    toast(`全部会话读取失败：${e.message}`, 'err', 4200);
  }
  if (st.historyOpen && st.scope === 'all') renderHistoryList();
}

/* ───────────────────────────── 会话头 ───────────────────────────── */

function currentRow() {
  // currentSid 为空 = 没有活动会话（旧默认会话的 sid 也是空串，不能靠它匹配）
  if (!st.currentSid) return null;
  return st.list.find((r) => r.sid === st.currentSid) || null;
}

function headerName() {
  if (st.entryVisible) return '选择会话';
  const row = currentRow();
  if (row?.title) return row.title;
  if (st.currentSid) return row?.count ? '（无标题会话）' : '新会话';
  return '会话';
}

function renderHeader() {
  const ui = st.ui;
  if (!ui) return;
  const label = ui.label;
  const name = headerName();
  if (label) label.textContent = name;
  if (ui.btn) {
    ui.btn.title = `${name} · 点击切换会话`;
    ui.btn.setAttribute('aria-expanded', String(st.quickOpen));
  }
  if (ui.dot) {
    ui.dot.hidden = !st.busy;
    ui.dot.classList.toggle('running', !!st.busy);
  }
  if (ui.newBtn) ui.newBtn.disabled = !!st.busy;
  if (ui.histBtn) ui.histBtn.setAttribute('aria-expanded', String(st.historyOpen));
  if (ui.rightSide) {
    if (st.historyOpen) ui.rightSide.dataset.sessView = 'history';
    else delete ui.rightSide.dataset.sessView;
  }
}

export function sessionsRefreshHeader() {
  if (!st.ui) return;
  st.currentSid = st.ctx?.currentSid?.() || '';
  renderHeader();
}

export function sessionsSetBusy(on) {
  st.busy = !!on;
  if (st.busy) closeQuick();
  renderHeader();
}

/** 会话发生变化（切换/新建/删除/清空）后：刷新头与缓存列表 */
export async function sessionsOnSessionChanged({ refresh = false } = {}) {
  st.currentSid = st.ctx?.currentSid?.() || '';
  if (refresh) await refreshList({ force: true });
  renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) renderHistoryList();
}

/** app.js 刚打开一篇文档：决定「恢复上次 / 直接新建 / 显示选择卡片」 */
export async function sessionsOnDocOpened(docId) {
  st.docId = String(docId || '');
  st.currentSid = st.ctx?.currentSid?.() || '';
  // 先把上一轮可能残留的选择卡片收起来（aiArea 里可能还挂着旧节点）
  st.entryVisible = false;
  if (st.ui?.entry) { st.ui.entry.dataset.show = '0'; st.ui.entry.classList.add('hidden'); }
  st.ctx?.renderAi?.();

  await refreshList({ force: true });
  if (!st.ctx?.hasDoc?.() || (st.ctx.doc()?.docId || '') !== st.docId) return;

  const mode = readOnEnter();
  // 「继续上次」只认有内容的会话：新建后没发过消息的空会话不该抢这个位置
  const actives = activeRows().filter((r) => (r.count || 0) > 0);
  const curRow = st.currentSid ? actives.find((r) => r.sid === st.currentSid) || null : null;
  const last = curRow || actives[0] || null;

  if (mode === 'new') {
    // 默认「总是新会话」：旧行为 —— 直接开一个新会话，并让问答面板可见
    st.ctx?.showChatAndRender?.();
    await st.ctx.startNewSession({ silent: true, fromEntry: true });
    return;
  }
  if (mode === 'resume' && last && !isStale(last)) {
    // 默认「自动恢复上次」：让问答面板可见，再恢复/切换
    st.ctx?.showChatAndRender?.();
    if (last.sid === st.currentSid) await st.ctx.restoreChatOnly?.();
    else await st.ctx.continueSession(last.sid, { force: true });
    return;
  }
  showEntryCard(last);
}

function activeRows() {
  return st.list
    .filter((r) => !r.archived)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

/* ───────────────────────────── 进文件夹选择卡片 ───────────────────────────── */

function modeLabel(mode) {
  return mode === 'resume' ? '自动恢复上次' : mode === 'new' ? '总是新会话' : '选择卡片';
}

function renderModeChips(box) {
  if (!box) return;
  const mode = readOnEnter();
  box.replaceChildren(
    el('span', { class: 'sess-mode-label', text: '进文件夹默认：' }),
    ...['choose', 'resume', 'new'].map((m) => el('button', {
      type: 'button',
      class: `sess-mode-chip${m === mode ? ' on' : ''}`,
      text: modeLabel(m),
      title: m === 'choose'
        ? '显示这张选择卡片，不自动恢复（默认，推荐）'
        : m === 'resume'
          ? '自动回到上次会话（超过 7 天或 60 条消息仍会显示选择卡片）'
          : '每次进文件夹都新建一个空会话',
      onclick: () => { setOnEnter(m); toast(`之后进文件夹：${modeLabel(m)}`, 'err', 1800); },
    })),
  );
}

function showEntryCard(lastRow) {
  st.entryVisible = true;
  renderEntryCard(lastRow);
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '1';
    st.ui.entry.classList.remove('hidden');
  }
  st.ctx?.showChatAndRender?.();
  renderHeader();
}

function hideEntryCard({ render = true } = {}) {
  st.entryVisible = false;
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '0';
    st.ui.entry.classList.add('hidden');
  }
  if (render) st.ctx?.renderAi?.();
  renderHeader();
}

function renderEntryCard(lastRow) {
  const ui = st.ui;
  if (!ui?.entry) return;
  // 空会话没有可继续的内容，不进选择卡片（否则点「继续上次」看起来就是一片空白）
  const actives = activeRows().filter((r) => (r.count || 0) > 0);
  const others = actives.filter((r) => r.sid !== (lastRow?.sid || '')).slice(0, 4);
  const recentRows = lastRow ? others : actives.slice(0, 5);

  const recent = recentRows.length
    ? el('div', { class: 'entry-recent' },
      el('div', { class: 'entry-recent-title', text: lastRow ? '最近会话' : '最近会话' }),
      ...recentRows.map((r) => el('button', {
        type: 'button',
        class: 'entry-recent-row',
        title: r.title || '（无标题会话）',
        onclick: () => chooseSession(r.sid),
      },
      el('span', { class: 'entry-recent-name', text: r.title || (r.count ? '（无标题会话）' : '新会话') }),
      el('span', { class: 'entry-recent-meta', text: [r.count ? `${r.count} 条` : '', relTime(r.updatedAt)].filter(Boolean).join(' · ') }))))
    : null;

  const primary = lastRow
    ? el('button', {
      type: 'button',
      class: 'entry-primary',
      onclick: () => chooseSession(lastRow.sid),
    },
    el('span', { class: 'entry-primary-main', text: `继续上次「${lastRow.title || (lastRow.count ? '无标题会话' : '新会话')}」` }),
    el('span', { class: 'entry-primary-meta', text: [lastRow.count ? `${lastRow.count} 条消息` : '还没有消息', relTime(lastRow.updatedAt)].filter(Boolean).join(' · ') }))
    : el('div', { class: 'entry-empty-hint', text: '这个文件夹还没有会话。' });

  ui.entry.replaceChildren(
    el('div', { class: 'entry-big-ic', html: ICONS.dot }),
    el('div', { class: 'entry-title', text: lastRow ? '继续这个文件夹的对话？' : '开始新的对话' }),
    el('div', { class: 'entry-sub', text: lastRow
      ? `这个文件夹里有 ${actives.length} 个会话。默认不自动恢复，挑一个继续，或者新建一个。`
      : '发第一条消息后会创建这个文件夹的会话，之后可以在这里切换。' }),
    primary,
    el('button', { type: 'button', class: 'entry-new', text: '＋ 新建会话', onclick: doNewSession }),
    // 注意：replaceChildren 会把 null 参数按 DOMString 转成字面「null」文本，
    // 最近会话为空时必须展开成空数组，不能直接传 null。
    ...(recent ? [recent] : []),
    el('div', { class: 'entry-modes', id: 'sessEntryModes' }),
    el('div', { class: 'entry-hint', text: '选择卡片只影响「进文件夹时」；会话内容、AI 功能记录都各自独立保存。' }),
  );
  renderModeChips(ui.entry.querySelector('#sessEntryModes'));
}

async function chooseSession(sid) {
  if (!guardBusy('切换会话')) return;
  closeQuick();
  closeHistory();
  const force = st.entryVisible;
  hideEntryCard();
  await st.ctx.continueSession(sid, { force });
}

async function doNewSession() {
  if (!guardBusy('新建会话')) return;
  const wasEntry = st.entryVisible;
  closeQuick();
  closeHistory();
  hideEntryCard();
  await st.ctx.startNewSession({ silent: false, fromEntry: wasEntry });
}

/* ───────────────────────────── 快速切换浮层 ───────────────────────────── */

function buildQuick() {
  const quick = st.ui.quick;
  if (!quick) return;
  const search = el('input', {
    type: 'search',
    class: 'sess-quick-search',
    placeholder: '搜索会话标题…',
    'aria-label': '搜索会话',
    oninput: (e) => { st.quickQuery = e.target.value; renderQuickList(); },
  });
  quick.replaceChildren(
    el('div', { class: 'sess-quick-head' },
      el('span', { class: 'sess-quick-title', text: '切换会话' }),
      el('span', { class: 'sess-quick-hint', text: '本文件夹' })),
    search,
    el('div', { class: 'sess-quick-list', id: 'sessQuickList' }),
    el('div', { class: 'sess-quick-foot' },
      el('button', {
        type: 'button', class: 'sess-quick-all', text: '查看全部会话',
        onclick: () => { closeQuick(); openHistory(); },
      }),
      el('button', { type: 'button', class: 'sess-quick-new', text: '＋ 新建会话', onclick: doNewSession })),
  );
}

function openQuick() {
  if (!st.ctx?.hasDoc?.()) return;
  st.quickOpen = true;
  st.ui.quick?.classList.remove('hidden');
  st.ui.btn?.setAttribute('aria-expanded', 'true');
  renderQuickList();
  refreshList({ force: false });
  setTimeout(() => st.ui.quick?.querySelector('.sess-quick-search')?.focus(), 0);
}

function closeQuick() {
  if (!st.quickOpen) return;
  st.quickOpen = false;
  st.ui.quick?.classList.add('hidden');
  st.ui.btn?.setAttribute('aria-expanded', 'false');
}

function toggleQuick() {
  if (st.quickOpen) closeQuick();
  else openQuick();
}

function renderQuickList() {
  const box = st.ui?.quick?.querySelector('.sess-quick-list');
  if (!box) return;
  const q = st.quickQuery.trim().toLowerCase();
  const actives = activeRows()
    .filter((r) => (r.count || 0) > 0)
    .filter((r) => !q || (r.title || '').toLowerCase().includes(q) || (r.preview || '').toLowerCase().includes(q))
    .slice(0, 6);
  if (!actives.length) {
    box.replaceChildren(el('div', { class: 'sess-empty', text: q ? '没有匹配的会话' : '还没有会话' }));
    return;
  }
  box.replaceChildren(...actives.map((r) => el('button', {
    type: 'button',
    class: `sess-quick-row${!!st.currentSid && r.sid === st.currentSid ? ' on' : ''}`,
    title: r.title || '（无标题会话）',
    onclick: () => chooseSession(r.sid),
  },
  el('span', { class: 'sess-quick-name', text: r.title || (r.count ? '（无标题会话）' : '新会话') }),
  el('span', { class: 'sess-quick-meta', text: [r.pinned ? '置顶' : '', r.count ? `${r.count} 条` : '', relTime(r.updatedAt)].filter(Boolean).join(' · ') }))));
}

/* ───────────────────────────── 历史面板 ───────────────────────────── */

function buildHistory() {
  const box = st.ui.history;
  if (!box) return;
  const search = el('input', {
    type: 'search',
    class: 'sess-hist-search',
    placeholder: '搜索会话标题…',
    'aria-label': '搜索会话',
    oninput: (e) => { st.histQuery = e.target.value; renderHistoryList(); },
  });
  box.replaceChildren(
    el('div', { class: 'sess-hist-head' },
      sessButton('back', '返回对话', 'sess-hist-back', closeHistory),
      el('div', { class: 'sess-hist-title', text: '会话历史' }),
      el('button', { type: 'button', class: 'sess-hist-new', text: '＋ 新建', onclick: doNewSession })),
    el('div', { class: 'sess-hist-searchrow' }, search),
    el('div', { class: 'sess-hist-scope', id: 'sessHistScope' },
      el('button', {
        type: 'button', class: `sess-scope-chip${st.scope === 'folder' ? ' on' : ''}`, text: '本文件夹',
        onclick: () => setScope('folder'),
      }),
      el('button', {
        type: 'button', class: `sess-scope-chip${st.scope === 'all' ? ' on' : ''}`, text: '全部文件夹',
        onclick: () => setScope('all'),
      })),
    el('div', { class: 'sess-hist-list', id: 'sessHistList' }),
    el('div', { class: 'sess-hist-foot' },
      el('button', { type: 'button', class: 'sess-foot-btn', id: 'sessHistMemory', onclick: () => st.ctx.togglePaperMemory?.() }),
      el('button', { type: 'button', class: 'sess-foot-btn', text: '清空当前会话', onclick: clearCurrent }),
      el('div', { class: 'sess-hist-modes', id: 'sessHistModes' })),
  );
  renderModeChips(box.querySelector('#sessHistModes'));
  renderHistoryList();
  renderMemoryBtn();
}

function renderMemoryBtn() {
  const btn = st.ui?.history?.querySelector('#sessHistMemory');
  if (!btn) return;
  const off = !!st.ctx?.paperMemoryOff?.();
  btn.textContent = off ? '本篇对话记忆：关闭（点开启）' : '本篇对话记忆：开启（点关闭）';
  btn.title = '新会话是否参考这篇论文之前会话的摘要；不影响各会话自己的历史';
}

function openHistory() {
  if (!st.ctx?.hasDoc?.()) return;
  st.historyOpen = true;
  st.renameSid = null;
  st.ui.history?.classList.remove('hidden');
  buildHistory();
  renderHeader();
  refreshList({ force: false });
  if (st.scope === 'all') refreshAllList();
}

function closeHistory() {
  if (!st.historyOpen) return;
  st.historyOpen = false;
  st.renameSid = null;
  st.ui.history?.classList.add('hidden');
  renderHeader();
}

function toggleHistory() {
  if (st.historyOpen) closeHistory();
  else openHistory();
}

async function setScope(scope) {
  st.scope = scope === 'all' ? 'all' : 'folder';
  st.ui?.history?.querySelectorAll('.sess-scope-chip').forEach((b) => {
    const on = (b.textContent === '全部文件夹') === (st.scope === 'all');
    b.classList.toggle('on', on);
  });
  renderHistoryList();
  if (st.scope === 'all' && !st.allList.length) await refreshAllList();
  renderHistoryList();
}

function historySourceRows() {
  return st.scope === 'all' ? st.allList : st.list;
}

function rowsForGroups() {
  const q = st.histQuery.trim().toLowerCase();
  return historySourceRows().filter((r) => !q
    || (r.title || '').toLowerCase().includes(q)
    || (r.preview || '').toLowerCase().includes(q)
    || (r.folderPath || '').toLowerCase().includes(q))
    // 空会话（没发过任何消息、也没被命名/置顶/归档）没有可恢复内容，不占历史列表
    .filter((r) => (r.count || 0) > 0 || r.pinned || r.archived || !!r.title);
}

function bucketOf(ts) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const today0 = d.getTime();
  if (!ts || ts >= today0) return 0;
  if (ts >= today0 - DAY) return 1;
  if (ts >= today0 - 7 * DAY) return 2;
  return 3;
}

function renderHistoryList() {
  const box = st.ui?.history?.querySelector('.sess-hist-list');
  if (!box) return;
  const rows = rowsForGroups();
  const active = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);
  const nodes = [];

  const pinned = active.filter((r) => r.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  if (pinned.length) {
    nodes.push(el('div', { class: 'sess-group', text: '置顶' }));
    nodes.push(...pinned.map((r) => historyRow(r)));
  }
  const rest = active.filter((r) => !r.pinned);
  const buckets = [[], [], [], []];
  for (const r of rest) buckets[bucketOf(r.updatedAt)].push(r);
  const labels = ['今天', '昨天', '最近 7 天', '更早'];
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i].length) continue;
    nodes.push(el('div', { class: 'sess-group', text: labels[i] }));
    for (const r of buckets[i]) nodes.push(historyRow(r));
  }
  if (archived.length) {
    nodes.push(el('button', {
      type: 'button',
      class: 'sess-group sess-group-btn',
      text: `${st.showArchived ? '▾' : '▸'} 已归档（${archived.length}）`,
      onclick: () => { st.showArchived = !st.showArchived; renderHistoryList(); },
    }));
    if (st.showArchived) for (const r of archived) nodes.push(historyRow(r));
  }
  if (!nodes.length) nodes.push(el('div', { class: 'sess-empty', text: st.histQuery.trim() ? '没有匹配的会话' : '还没有会话' }));
  box.replaceChildren(...nodes);
}

function historyRow(row) {
  const on = !st.entryVisible && !!st.currentSid && row.sid === st.currentSid;
  const title = row.title || (row.count ? '（无标题会话）' : '新会话');
  const meta = [
    row.count ? `${row.count} 条` : '空会话',
    relTime(row.updatedAt),
    st.scope === 'all' ? `📁 ${row.folderPath ? `papers / ${row.folderPath.replace(/\//g, ' / ')}` : 'papers/'}` : '',
  ].filter(Boolean).join(' · ');

  const wrap = el('div', { class: `sess-hrow${on ? ' on' : ''}${row.archived ? ' archived' : ''}`, dataset: { sid: row.sid } });

  if (st.renameSid === row.sid) {
    const input = el('input', { class: 'sess-rename-input', value: row.title || '' });
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      st.renameSid = null;
      if (!next || next === row.title) { renderHistoryList(); return; }
      await patchMeta(row, { title: next });
      renderHistoryList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; st.renameSid = null; renderHistoryList(); }
    });
    input.addEventListener('blur', commit);
    wrap.append(el('div', { class: 'sess-hgo' }, input));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return wrap;
  }

  wrap.append(
    el('button', {
      type: 'button', class: 'sess-hgo', title,
      onclick: () => chooseSession(row.sid),
      ondblclick: (e) => { e.preventDefault(); startRename(row.sid); },
    },
    el('span', { class: 'sess-htitle', text: title }),
    el('span', { class: 'sess-hmeta', text: meta })),
    el('span', { class: 'sess-hacts' },
      sessButton('pin', row.pinned ? '取消置顶' : '置顶', `sess-hact pin${row.pinned ? ' on' : ''}`, (e) => { e.stopPropagation(); patchMeta(row, { pinned: !row.pinned }); }),
      sessButton('archive', row.archived ? '取消归档' : '归档', `sess-hact archive${row.archived ? ' on' : ''}`, (e) => { e.stopPropagation(); patchMeta(row, { archived: !row.archived }); }),
      sessButton('rename', '重命名（F2）', 'sess-hact rename', (e) => { e.stopPropagation(); startRename(row.sid); }),
      sessButton('trash', '删除会话', 'sess-hact danger', (e) => { e.stopPropagation(); confirmDeleteRow(row); }),
    ),
  );
  return wrap;
}

function startRename(sid) {
  st.renameSid = sid;
  renderHistoryList();
}

async function confirmDeleteRow(row) {
  if (!guardBusy('删除会话')) return;
  const title = row.title || (row.count ? '（无标题会话）' : '新会话');
  const ok = await sessionsConfirm({
    title: '删除这个会话？',
    body: `「${title}」的对话和 AI 功能记录会被删除；论文、笔记、译文都不受影响，删除后不可恢复。`,
    okText: '删除会话',
    danger: true,
  });
  if (!ok) return;
  try {
    if (row.sid === st.currentSid && !!st.currentSid && st.ctx?.hasDoc?.() && keyForRow(row) === st.folderKey) {
      await st.ctx.deleteSession(row.sid);
    } else {
      await deleteRowFile(row);
      st.list = st.list.filter((r) => r !== row && !(r.sid === row.sid && (r.folderPath || '') === (row.folderPath || '')));
      st.allList = st.allList.filter((r) => r !== row);
      await refreshList({ force: true });
    }
    if (st.entryVisible) renderEntryCard(activeRows()[0] || null);
    if (st.historyOpen) renderHistoryList();
    if (st.quickOpen) renderQuickList();
    renderMemoryBtn();
    renderHeader();
  } catch (e) {
    toast(`删除失败：${e.message}`, 'err', 4200);
  }
}

async function clearCurrent() {
  if (!guardBusy('清空会话')) return;
  const ok = await sessionsConfirm({
    title: '清空当前会话？',
    body: '当前会话里的问答和 AI 功能记录会清空（会话本身保留）；译文不属于会话，不会被清空。',
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  await st.ctx.clearCurrentSession();
  await refreshList({ force: true });
  if (st.historyOpen) renderHistoryList();
  renderHeader();
}

/* ───────────────────────────── 应用内确认框 ───────────────────────────── */

function ensureConfirm() {
  if (st.ui.confirmMask) return;
  const mask = el('div', { class: 'sess-confirm-mask hidden', role: 'dialog', 'aria-modal': 'true' });
  const title = el('div', { class: 'sess-confirm-title' });
  const body = el('div', { class: 'sess-confirm-body' });
  const ok = el('button', { type: 'button', class: 'sess-confirm-btn danger', text: '确定' });
  const cancel = el('button', { type: 'button', class: 'sess-confirm-btn ghost', text: '取消' });
  ok.addEventListener('click', () => resolveConfirm(true));
  cancel.addEventListener('click', () => resolveConfirm(false));
  mask.addEventListener('click', (e) => { if (e.target === mask) resolveConfirm(false); });
  const card = el('div', { class: 'sess-confirm', role: 'document' },
    title, body, el('div', { class: 'sess-confirm-acts' }, cancel, ok));
  mask.append(card);
  document.body.append(mask);
  st.ui.confirmMask = mask;
  st.ui.confirmTitle = title;
  st.ui.confirmBody = body;
  st.ui.confirmOk = ok;
  st.ui.confirmCancel = cancel;
}

function resolveConfirm(ok) {
  const mask = st.ui?.confirmMask;
  if (!mask) return;
  mask.classList.add('hidden');
  const fn = st.confirmResolve;
  st.confirmResolve = null;
  if (fn) fn(!!ok);
}

function sessionsConfirm({ title = '确认', body = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  ensureConfirm();
  st.ui.confirmTitle.textContent = title;
  st.ui.confirmBody.textContent = body;
  st.ui.confirmOk.textContent = okText;
  st.ui.confirmOk.classList.toggle('danger', !!danger);
  st.ui.confirmCancel.textContent = cancelText;
  st.ui.confirmMask.classList.remove('hidden');
  st.ui.confirmOk.focus();
  return new Promise((resolve) => { st.confirmResolve = resolve; });
}

/* ───────────────────────────── 文件夹改名 / 移动迁移 ───────────────────────────── */

/** 把 localStorage reader.activeSession 里旧文件夹键的当前会话挪到新键 */
function migrateActiveSessionKey(fromKey, toKey) {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    const map = raw ? JSON.parse(raw) : null;
    if (!map || typeof map !== 'object') return;
    if (!map[fromKey]) return;
    map[toKey] = map[fromKey];
    delete map[fromKey];
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** app.js 在文件夹改名/拖动成功后调用：复制会话文件 + 附件到新 folderKey，并迁移当前会话指针 */
export async function sessionsMigrateFolder(fromPath, toPath) {
  if (!st.ctx) return;
  const fromKey = st.ctx.folderKeyOf(fromPath || '');
  const toKey = st.ctx.folderKeyOf(toPath || '');
  if (!fromKey || !toKey || fromKey === toKey) return;
  try {
    const r = await fetch('/api/sessions/move-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey, toKey, toPath: toPath || '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errorOf(j, r));
    migrateActiveSessionKey(fromKey, toKey);
    if (st.folderPath === (fromPath || '') || st.folderPath.startsWith(`${fromPath || ''}/`)) {
      await sessionsOnFolderRenamed();
    }
  } catch (e) {
    toast(`会话迁移失败：${e.message}（旧文件夹下的会话文件已保留）`, 'err', 5200);
  }
}

/** 文件夹改名/移动后：app.js 已更新 state.currentFolder，这里刷新缓存列表 */
export async function sessionsOnFolderRenamed() {
  if (!st.ctx?.hasDoc?.()) return;
  st.folderPath = st.ctx.folderPath();
  st.folderKey = st.ctx.folderKey();
  st.listLoaded = false;
  await refreshList({ force: true });
}

/* ───────────────────────────── 按键 / 快捷键 ───────────────────────────── */

function isTypingTarget(t) {
  const tag = (t?.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || !!t?.isContentEditable;
}

function onKeydownCapture(e) {
  // 确认框优先
  if (st.confirmResolve) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); resolveConfirm(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); resolveConfirm(true); }
    return;
  }
  if (e.key === 'Escape') {
    if (st.quickOpen) { e.preventDefault(); e.stopPropagation(); closeQuick(); return; }
    if (st.historyOpen) { e.preventDefault(); e.stopPropagation(); closeHistory(); return; }
  }
  if (st.historyOpen && e.key === 'F2' && st.renameSid == null) {
    e.preventDefault(); e.stopPropagation();
    return;
  }
}

/* 快捷键：Ctrl/⌘+Shift+N/H（浏览器里 Ctrl+Shift+N 会被无痕窗口占用，再补 Ctrl+Alt+N/H） */
function onGlobalShortcut(e) {
  if (!st.ctx?.hasDoc?.()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'n' && (e.shiftKey || e.altKey) && !(e.shiftKey && e.altKey)) {
    e.preventDefault(); e.stopPropagation();
    doNewSession();
  } else if (key === 'h' && (e.shiftKey || e.altKey) && !(e.shiftKey && e.altKey)) {
    e.preventDefault(); e.stopPropagation();
    toggleHistory();
  }
}

export function sessionsShortcutNew() { doNewSession(); }
export function sessionsShortcutHistory() { toggleHistory(); }

/* ───────────────────────────── 初始化 ───────────────────────────── */

export function initSessions(ctx) {
  st.ctx = ctx;
  const ui = st.ui = {
    rightSide: $('#rightSide'),
    bar: $('#sessBar'),
    btn: $('#sessBtn'),
    label: $('#sessLabel'),
    dot: $('#sessDot'),
    newBtn: $('#sessNew'),
    histBtn: $('#sessHist'),
    quick: $('#sessQuickPop'),
    history: $('#sessHistory'),
    menu: $('#sessionMenu'),
    entry: null,
    entryModeBox: null,
    histModeBox: null,
    confirmMask: null,
  };
  if (!ui.bar) return;

  // 进文件夹选择卡片：由本模块创建，app.js 的 renderCol 在 chat 栏优先挂它
  ui.entry = el('section', {
    class: 'entry-card hidden',
    id: 'sessEntryCard',
    dataset: { show: '0' },
    'aria-label': '选择进入哪个会话',
  });
  ui.entryModeBox = el('div', { class: 'sess-mode-chips' });
  ui.histModeBox = el('div', { class: 'sess-mode-chips' });

  buildQuick();
  buildHistory();

  ui.btn?.addEventListener('click', (e) => { e.stopPropagation(); toggleQuick(); });
  ui.newBtn?.addEventListener('click', (e) => { e.stopPropagation(); doNewSession(); });
  ui.histBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(); });
  ui.bar.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', () => { if (st.quickOpen) closeQuick(); });
  document.addEventListener('keydown', onKeydownCapture, true);
  document.addEventListener('keydown', onGlobalShortcut);

  // 选择卡片换了文档/文件夹后不再显示
  st.currentSid = st.ctx.currentSid?.() || '';
  renderHeader();
}

/* 供 app.js 判断「当前是不是选择卡片模式」 */
export function sessionsIsEntryMode() {
  return !!st.entryVisible;
}

/** 选择卡片节点（app.js 的 renderCol 用它挂进 #aiArea；不能用 getElementById，卡片在切换面板时会脱离文档） */
export function sessionsEntryCardEl() {
  return st.ui?.entry || null;
}

/** 选择卡片模式下用户直接往输入框发送：先偷偷建一个新会话，再照常发送 */
export async function sessionsLeaveEntryForNewSession() {
  if (!st.entryVisible) return true;
  if (st.busy || st.ctx?.isBusy?.()) return false;
  hideEntryCard();
  await st.ctx.startNewSession({ silent: true, fromEntry: true });
  return true;
}

/** 给 app.js 用：当前文件夹的会话列表（loadPaperMemory 等复用） */
export function sessionsGetList() {
  return st.list;
}

/** app.js 在文件夹改名/移动后调：更新缓存中的文件夹路径 */
export function sessionsOnFolderEntered(path) {
  st.folderPath = String(path || '');
  st.folderKey = st.ctx?.folderKeyOf ? st.ctx.folderKeyOf(st.folderPath) : '';
  st.docId = '';
  st.list = [];
  st.allList = [];
  st.listLoaded = false;
  st.currentSid = '';
  st.renameSid = null;
  st.histQuery = '';
  st.quickQuery = '';
  st.entryVisible = false;
  if (st.ui?.entry) {
    st.ui.entry.dataset.show = '0';
    st.ui.entry.classList.add('hidden');
  }
  closeQuick();
  closeHistory();
  renderHeader();
}
