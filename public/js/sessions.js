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
const HIST_MODE_KEY = 'reader.session.historyMode'; // file（按文件整理，默认）/ time（按时间顺序）
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
  doc: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 4.4h7.6l4 4v11.2H6.4z"/><path d="M14 4.4v4h4"/><path d="M9 12.4h6M9 15.6h6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7.6"/><path d="M12 7.4V12l3.2 2"/></svg>',
};

const st = {
  ctx: null,
  folderPath: '',
  folderKey: '',
  docId: '',
  /** 当前文件夹的会话 meta（含已归档，服务端 limit 内） */
  list: [],
  /** scope=all 的缓存：会话历史面板统一用它（两种排列都是全部文件夹的数据） */
  allList: [],
  listLoaded: false,
  listLoading: false,
  allLoading: false,
  /** 镜像 app.js 的 activeSidFor（app 是唯一事实来源，这里只用于渲染） */
  currentSid: '',
  entryVisible: false,
  busy: false,
  historyOpen: false,
  quickOpen: false,
  /** 会话历史的排列方式：file=按文件整理；time=按时间顺序 */
  histMode: 'file',
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
    // 这一行实际所在的 doc key（/api/sessions 给出；旧服务端可能没有）
    fileKey: String(r?.fileKey || ''),
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
}

/** 历史面板排列方式：按文件整理（默认）/ 按时间顺序 */
function readHistMode() {
  try { return localStorage.getItem(HIST_MODE_KEY) === 'time' ? 'time' : 'file'; } catch { return 'file'; }
}

function setHistMode(mode) {
  const next = mode === 'time' ? 'time' : 'file';
  if (next === st.histMode) return;
  st.histMode = next;
  try { localStorage.setItem(HIST_MODE_KEY, next); } catch { /* ignore */ }
  st.ui?.history?.querySelectorAll('.sess-arrange-chip').forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderHistoryList();
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

/** 列表/元数据请求用的 doc key：全局共用模式由 app 给出（'default'），其余情况就是当前文件夹 */
function listScopeKey() {
  return st.ctx?.scopeKey?.() || st.folderKey;
}

/** 历史行里的 fileKey 是服务端规范化后的存储键：全局模式下 app 传的 'default' 会落成
 *  'default-<hash>'（见 server.js docIdOf）。这里统一判断「是不是当前归属键的副本」。 */
function isScopeFileKey(fileKey) {
  const key = String(fileKey || '');
  if (!key) return false;
  if (st.ctx?.isScopeFileKey) return !!st.ctx.isScopeFileKey(key);
  return key === listScopeKey();
}

async function fetchFolderList() {
  const q = new URLSearchParams({
    doc: listScopeKey(),
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
    doc: listScopeKey(),
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

/** 行所属文件夹的 session key：优先用服务端给的 fileKey（任意归属模式/旧文件夹的行都能
 *  正确置顶、改名、归档、删除）；没有时按 folderPath 现算。 */
function keyForRow(row) {
  if (row?.fileKey) return row.fileKey;
  if (!st.ctx) return st.folderKey;
  const scope = st.ctx.scopeKey?.();
  if (scope && scope !== st.ctx.folderKey?.()) return scope;
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

/** 删除会话在所有存储键下的副本：切换「换论文时对话怎么接」会复制同一 sid，
 *  只删当前归属键那份的话，其余副本会在历史里「复活」。 */
async function deleteRowFile(row) {
  const scope = listScopeKey();
  const copies = Array.isArray(row?._copies) && row._copies.length
    ? row._copies
    : [{ sid: row.sid, fileKey: keyForRow(row) }];
  let lastErr = null;
  for (const c of copies) {
    const doc = c.fileKey || scope;
    if (!doc) continue;
    const q = new URLSearchParams({ doc, sid: row.sid });
    const r = await fetch(`/api/session?${q}`, { method: 'DELETE' });
    if (r.ok || r.status === 404) continue;
    const j = await r.json().catch(() => ({}));
    lastErr = new Error(errorOf(j, r));
  }
  if (lastErr) throw lastErr;
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
  if (st.historyOpen) {
    // 历史面板开着时跨论文/跨归属模式切换：st.list 刷新了，但历史数据源 st.allList
    // 还是旧的 —— 上一篇论文的旧行会被标成「当前」，点击还会按旧 docIds 跳回旧论文。
    // 这里把全库列表一起刷新（都是本地文件，代价很小）。
    await refreshAllList();
  }
  return st.list;
}

async function refreshAllList() {
  if (!st.ctx?.hasDoc?.()) return;
  st.allLoading = true;
  if (st.historyOpen) renderHistoryList();
  try {
    st.allList = await fetchAllList();
  } catch (e) {
    st.allList = [];
    toast(`全部会话读取失败：${e.message}`, 'err', 4200);
  } finally {
    st.allLoading = false;
  }
  if (st.historyOpen) renderHistoryList();
  renderHeader();
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
  if (st.historyOpen) {
    // 历史面板开着时，切论文/切归属模式不会经过 openHistory：全库列表必须一起重拉，
    // 否则旧论文的旧行会被标成「当前」、点击还会按旧 docIds 跳回旧论文。
    if (!refresh) await refreshAllList();
    else renderHistoryList();
  }
}

function scopeMode() {
  return st.ctx?.scopeMode?.() || 'folder';
}

/** app.js 刚打开一篇文档：决定「接上哪段对话」或「按打开文件夹时的策略执行」 */
export async function sessionsOnDocOpened(docId) {
  st.docId = String(docId || '');
  st.currentSid = st.ctx?.currentSid?.() || '';
  // 先把上一轮可能残留的选择卡片收起来（aiArea 里可能还挂着旧节点）
  st.entryVisible = false;
  if (st.ui?.entry) { st.ui.entry.dataset.show = '0'; st.ui.entry.classList.add('hidden'); }
  st.ctx?.renderAi?.();

  await refreshList({ force: true });
  if (!st.ctx?.hasDoc?.() || (st.ctx.doc()?.docId || '') !== st.docId) return;

  st.currentSid = st.ctx?.currentSid?.() || '';
  // 历史面板/选择卡片已经指定了要打开的会话：打开文档只是顺路加载论文，
  // 不要再按「打开文件夹时」策略弹卡片或另开新会话（否则会冲掉刚指定的会话）。
  if (st.ctx?.consumeSessionOpen?.()) {
    st.ctx?.consumeFolderEntry?.();   // 这次只算「打开论文」，不算按策略进入文件夹
    st.ctx?.showChatAndRender?.();
    return;
  }

  // openDoc 每次冷开论文都会走到这里，但「打开文件夹时」的三档只应该在一个文件夹
  // 真正被打开时生效（换文件夹、启动、文件夹从关闭状态恢复）。同一文件夹里切到
  // 另一篇论文时按「会话归属」静默接上 —— 不弹卡片、不新建。
  if (!st.ctx?.consumeFolderEntry?.()) {
    st.ctx?.showChatAndRender?.();
    const cur = st.currentSid ? (st.list.find((r) => r.sid === st.currentSid) || null) : null;
    if (cur) { await (st.ctx.followCurrentSession || st.ctx.restoreChatOnly)?.(); return; }   // 当前会话就是这里的：同一段对话跟着，内容一致就不重放 DOM
    if (st.currentSid) {
      // 指针指向一个还没落盘的空会话：保持空白，但要把上一篇残留在 DOM 里的消息清掉
      await st.ctx.startNewSession?.({ silent: true, fromEntry: true });
      return;
    }
    const actives = activeRows().filter((r) => (r.count || 0) > 0 && !isStale(r));
    if (actives.length) await st.ctx.continueSession?.(actives[0].sid, { force: true });
    else await st.ctx.startNewSession?.({ silent: true, fromEntry: true });
    return;
  }

  // 真正打开一个文件夹：按「打开文件夹时」的三档执行
  const onEnter = readOnEnter();
  // 「继续上次」只认有内容的会话：新建后没发过消息的空会话不该抢这个位置
  const actives = activeRows().filter((r) => (r.count || 0) > 0);
  const curRow = st.currentSid ? actives.find((r) => r.sid === st.currentSid) || null : null;
  const last = curRow || actives[0] || null;

  if (onEnter === 'new') {
    // 默认「总是新会话」：旧行为 —— 直接开一个新会话，并让问答面板可见
    st.ctx?.showChatAndRender?.();
    await st.ctx.startNewSession({ silent: true, fromEntry: true });
    return;
  }
  if (onEnter === 'resume' && last && !isStale(last)) {
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
    el('span', { class: 'sess-mode-label', text: '打开文件夹默认：' }),
    ...['choose', 'resume', 'new'].map((m) => el('button', {
      type: 'button',
      class: `sess-mode-chip${m === mode ? ' on' : ''}`,
      text: modeLabel(m),
      title: m === 'choose'
        ? '打开文件夹时显示这张选择卡片，不自动恢复（默认，推荐）'
        : m === 'resume'
          ? '打开文件夹时自动回到上次会话（超过 7 天或 60 条消息仍会显示选择卡片）'
          : '每次打开文件夹都新建一个空会话',
      onclick: () => { setOnEnter(m); toast(`之后打开文件夹：${modeLabel(m)}`, 'err', 1800); },
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

  const mode = scopeMode();
  const docName = st.ctx?.doc?.()?.name || '这篇论文';
  const emptyHint = mode === 'paper' ? '这篇论文还没有会话。'
    : mode === 'global' ? '还没有共用会话。'
      : '这个文件夹还没有会话。';
  const emptySub = mode === 'paper'
    ? '发第一条消息后会创建这篇论文自己的会话，之后可以在这里切换。'
    : mode === 'global'
      ? '发第一条消息后会开始所有论文共用的对话，之后可以在这里切换。'
      : '发第一条消息后会创建这个文件夹的会话，之后可以在这里切换。';

  const primary = lastRow
    ? el('button', {
      type: 'button',
      class: 'entry-primary',
      onclick: () => chooseSession(lastRow.sid),
    },
    el('span', { class: 'entry-primary-main', text: `继续上次「${lastRow.title || (lastRow.count ? '无标题会话' : '新会话')}」` }),
    el('span', { class: 'entry-primary-meta', text: [lastRow.count ? `${lastRow.count} 条消息` : '还没有消息', relTime(lastRow.updatedAt)].filter(Boolean).join(' · ') }))
    : el('div', { class: 'entry-empty-hint', text: emptyHint });
  const title = lastRow
    ? (mode === 'paper' ? '继续这篇论文的对话？' : mode === 'global' ? '继续所有论文共用的对话？' : '继续这个文件夹的对话？')
    : '开始新的对话';
  const sub = lastRow
    ? (mode === 'paper'
      ? `「${docName}」有 ${actives.length} 个会话（只列这篇论文的）。默认不自动恢复，挑一个继续，或者新建一个。`
      : mode === 'global'
        ? `所有论文共用 ${actives.length} 个会话。可以接着上一段继续，也可以新建一段。`
        : `这个文件夹里有 ${actives.length} 个会话。默认不自动恢复，挑一个继续，或者新建一个。`)
    : emptySub;

  ui.entry.replaceChildren(
    el('div', { class: 'entry-big-ic', html: ICONS.dot }),
    el('div', { class: 'entry-title', text: title }),
    el('div', { class: 'entry-sub', text: sub }),
    primary,
    el('button', { type: 'button', class: 'entry-new', text: '＋ 新建会话', onclick: doNewSession }),
    // 注意：replaceChildren 会把 null 参数按 DOMString 转成字面「null」文本，
    // 最近会话为空时必须展开成空数组，不能直接传 null。
    ...(recent ? [recent] : []),
    el('div', { class: 'entry-modes', id: 'sessEntryModes' }),
    el('div', { class: 'entry-hint', text: mode === 'paper'
      ? '选择卡片只在打开文件夹时出现；同一文件夹里换论文会接上那篇论文自己的对话，不重新弹卡片。'
      : mode === 'global'
        ? '选择卡片只在打开文件夹时出现；同一文件夹里换论文会接着同一段对话，不重新弹卡片。'
        : '选择卡片只在打开文件夹时出现；同一文件夹里换论文会接着同一段对话，不重新弹卡片。' }),
  );
  renderModeChips(ui.entry.querySelector('#sessEntryModes'));
}

async function chooseSession(sidOrRow, docIdHint = '') {
  if (!guardBusy('切换会话')) return;
  // 历史面板的新排列会列出别的文件夹/别的论文的会话：拿到整行才能切文件夹、打开对应论文。
  // docIdHint：按文件排列时用户点的是哪篇论文分组 —— 优先在原论文打开会话，别乱跳。
  const row = typeof sidOrRow === 'string'
    ? (st.allList.find((r) => r.sid === sidOrRow) || st.list.find((r) => r.sid === sidOrRow) || null)
    : (sidOrRow || null);
  const sid = row?.sid ?? (typeof sidOrRow === 'string' ? sidOrRow : '');
  closeQuick();
  closeHistory();
  const force = st.entryVisible;
  hideEntryCard();
  if (row && st.ctx?.openSessionFromHistory) await st.ctx.openSessionFromHistory(row, { force, docIdHint });
  else await st.ctx.continueSession(sid, { force });
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

/* ── 历史面板：两种排列 ─────────────────────────────────────────────────
 * file（按文件整理）：同一个会话在它问过的每一篇论文下各出现一次（文件内去重），
 *   文件组按最近活动倒序；没有 docId 的旧会话归入末尾「未关联论文」。
 * time（按时间顺序）：全部会话按更新/置顶排序，每行标出「按先后问过哪些论文」。
 * 两种模式都展示全部文件夹的会话；搜索、置顶/归档/改名/删除、归档折叠共用。 */

function arrangeChip(mode, text, icon, title) {
  const on = st.histMode === mode;
  return el('button', {
    type: 'button',
    class: `sess-arrange-chip${on ? ' on' : ''}`,
    dataset: { mode },
    title,
    'aria-pressed': String(on),
    onclick: () => setHistMode(mode),
  },
  el('span', { class: 'sess-arrange-ic', html: ICONS[icon] || '' }),
  el('span', { text }));
}

function buildHistory() {
  const box = st.ui.history;
  if (!box) return;
  const search = el('input', {
    type: 'search',
    class: 'sess-hist-search',
    placeholder: '搜索会话标题、预览或论文名…',
    'aria-label': '搜索会话',
    oninput: (e) => { st.histQuery = e.target.value; renderHistoryList(); },
  });
  box.replaceChildren(
    el('div', { class: 'sess-hist-head' },
      sessButton('back', '返回对话', 'sess-hist-back', closeHistory),
      el('div', { class: 'sess-hist-title', text: '会话历史' }),
      el('button', { type: 'button', class: 'sess-hist-new', text: '＋ 新建', onclick: doNewSession })),
    el('div', { class: 'sess-hist-searchrow' }, search),
    el('div', { class: 'sess-hist-arrange', id: 'sessHistArrange' },
      el('div', { class: 'sess-arrange-chips', role: 'group', 'aria-label': '会话排列方式' },
        arrangeChip('file', '按文件', 'doc', '同一篇论文的会话归在一起：问过它的每个会话都在该论文下显示一次'),
        arrangeChip('time', '按时间', 'clock', '全部会话按时间排列，并标出按顺序问过哪些论文')),
      el('span', { class: 'sess-hist-summary', id: 'sessHistSummary' })),
    el('div', { class: 'sess-hist-modehint', id: 'sessHistModeHint' }),
    el('div', { class: 'sess-hist-list', id: 'sessHistList' }),
    el('div', { class: 'sess-hist-foot' },
      el('button', { type: 'button', class: 'sess-foot-btn', id: 'sessHistMemory', onclick: () => st.ctx.togglePaperMemory?.() }),
      el('button', { type: 'button', class: 'sess-foot-btn', text: '会话设置', title: '会话归属、进入方式与标题策略', onclick: () => st.ctx.openSessionSettings?.() }),
      el('button', { type: 'button', class: 'sess-foot-btn', text: '清空当前会话', onclick: clearCurrent })),
  );
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

async function openHistory() {
  if (!st.ctx?.hasDoc?.()) return;
  st.historyOpen = true;
  st.renameSid = null;
  st.histMode = readHistMode();
  st.ui.history?.classList.remove('hidden');
  buildHistory();
  renderHeader();
  refreshList({ force: false });
  await refreshAllList();
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

function historySourceRows() {
  // 历史面板统一展示全部文件夹的会话；两种排列都基于这一份数据
  return st.allList;
}

/** 同一个会话可能因为切换「换论文时对话怎么接」而在多个存储键下留下副本
 *  （切换时会先按旧方式存盘、再把同一段对话复制到新方式）。历史面板是全库列表，
 *  如果不去重，同一段对话会重复出现好几行、每行都标「当前」。这里按 sid 合并成一行：
 *  · 优先当前归属键下那份，其次有标题、置顶/归档的，最后取最近更新的；
 *  · 标题、置顶、归档、摘要等可能只写在某一副本上，合并时取更完整的值；
 *  · 原副本列表挂在 _copies 上，删除时连同所有副本一起删。 */
function preferRow(a, b) {
  const aCur = isScopeFileKey(a.fileKey);
  const bCur = isScopeFileKey(b.fileKey);
  if (aCur !== bCur) return aCur;
  const aTitle = !!a.title;
  const bTitle = !!b.title;
  if (aTitle !== bTitle) return aTitle;
  if (!!a.pinned !== !!b.pinned) return !!a.pinned;
  if (!!a.archived !== !!b.archived) return !!a.archived;
  return (b.updatedAt || 0) > (a.updatedAt || 0);
}

function collapseRows(rows) {
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const sid = String(row?.sid || '');
    if (!sid) { order.push(row); continue; }   // 没有 sid 的旧行原样保留
    let g = groups.get(sid);
    if (!g) { g = []; groups.set(sid, g); order.push(g); }
    g.push(row);
  }
  return order.map((item) => {
    if (!Array.isArray(item)) return item;
    let primary = item[0];
    for (const r of item) if (preferRow(r, primary)) primary = r;
    const merged = { ...primary };
    for (const r of item) {
      if (!merged.title && r.title) { merged.title = r.title; merged.titleSource = r.titleSource; }
      if (!merged.preview && r.preview) merged.preview = r.preview;
      if (!merged.summary && r.summary) { merged.summary = r.summary; merged.summaryCovered = r.summaryCovered; }
      if (r.pinned) {
        migratedPinned(merged, r);
      }
      if (r.archived) {
        migratedArchived(merged, r);
      }
      merged.count = Math.max(merged.count || 0, r.count || 0);
      merged.updatedAt = Math.max(merged.updatedAt || 0, r.updatedAt || 0);
      merged.lastOpenedAt = Math.max(merged.lastOpenedAt || 0, r.lastOpenedAt || 0);
    }
    if (item.length > 1) {
      // 不同归属键下的副本 docIds 可能各只覆盖一部分论文（切换归属时旧代码只写当前论文），
      // 合并时必须取并集，否则历史分组、trail、点击目标都会缺论文。
      const primaryFirst = [primary, ...item.filter((r) => r !== primary)];
      const seenDoc = new Set();
      const docIds = [];
      const docTitles = [];
      for (const r of primaryFirst) {
        const ids = Array.isArray(r.docIds) ? r.docIds : [];
        const titles = Array.isArray(r.docTitles) ? r.docTitles : [];
        for (let i = 0; i < ids.length; i++) {
          const id = String(ids[i] || '');
          if (!id || seenDoc.has(id)) continue;
          seenDoc.add(id);
          docIds.push(id);
          docTitles.push(String(titles[i] || ''));
        }
      }
      if (docIds.length) { merged.docIds = docIds; merged.docTitles = docTitles; }
      merged._copies = item.map((r) => ({ sid: r.sid, fileKey: r.fileKey, folderPath: r.folderPath }));
    } else {
      delete merged._copies;
    }
    return merged;
  });
}

function migratedPinned(target, row) {
  target.pinned = true;
  target.pinnedAt = Math.max(target.pinnedAt || 0, row.pinnedAt || 0);
}

function migratedArchived(target, row) {
  target.archived = true;
  target.archivedAt = Math.max(target.archivedAt || 0, row.archivedAt || 0);
}

function rowsForGroups() {
  const q = st.histQuery.trim().toLowerCase();
  const filtered = historySourceRows()
    .filter((r) => !q
      || (r.title || '').toLowerCase().includes(q)
      || (r.preview || '').toLowerCase().includes(q)
      || (r.folderPath || '').toLowerCase().includes(q)
      || (r.docTitles || []).some((t) => String(t || '').toLowerCase().includes(q)))
    // 空会话（没发过任何消息、也没被命名/置顶/归档）没有可恢复内容，不占历史列表
    .filter((r) => (r.count || 0) > 0 || r.pinned || r.archived || !!r.title);
  return collapseRows(filtered);
}

/* ── 「按文件整理」：会话 → 问过的论文 ─────────────────────────────────── */

/** docId → { name, folder }：磁盘上的论文优先，会话里存的 docTitles 兜底
 *  （论文被移出 papers/ 后，历史里仍然要认得它）。 */
function docNameIndex(rows) {
  const map = new Map();
  for (const p of (st.ctx?.papers?.() || [])) {
    const id = String(p?.docId || '');
    if (id) map.set(id, { name: String(p.name || ''), folder: String(p.folder || '') });
  }
  for (const r of rows) {
    const ids = Array.isArray(r.docIds) ? r.docIds : [];
    const titles = Array.isArray(r.docTitles) ? r.docTitles : [];
    for (let i = 0; i < ids.length; i++) {
      const id = String(ids[i] || '');
      if (!id || map.has(id)) continue;
      const title = String(titles[i] || '').replace(/\.pdf$/i, '');
      if (title) map.set(id, { name: title, folder: String(r.folderPath || '') });
    }
  }
  return map;
}

function docLabel(row, id, index) {
  const hit = index.get(id);
  if (hit?.name) return hit.name;
  const i = (row.docIds || []).map(String).indexOf(id);
  const title = i >= 0 ? String((row.docTitles || [])[i] || '') : '';
  return title || '未知论文';
}

/** 按论文分组；同一会话在它问过的每篇论文下各出现一次（文件内按 sid 去重）。
 *  组内排序：置顶优先，再按更新时间倒序；组之间按最近活动倒序，未关联论文组排最后。 */
function fileGroups(rows) {
  const index = docNameIndex(rows);
  const groups = new Map();
  const misc = { id: '', name: '未关联论文', folder: '', rows: [], latest: 0 };
  for (const r of rows) {
    const ids = Array.from(new Set((r.docIds || []).map(String).filter(Boolean)));
    if (!ids.length) {
      misc.rows.push(r);
      misc.latest = Math.max(misc.latest, r.updatedAt || 0);
      continue;
    }
    for (const id of ids) {
      let g = groups.get(id);
      if (!g) {
        const hit = index.get(id);
        g = {
          id,
          name: hit?.name || docLabel(r, id, index),
          folder: hit ? hit.folder : String(r.folderPath || ''),
          rows: [],
          latest: 0,
        };
        groups.set(id, g);
      }
      g.rows.push(r);
      g.latest = Math.max(g.latest, r.updatedAt || 0);
    }
  }
  const out = [...groups.values()].sort((a, b) => (b.latest || 0) - (a.latest || 0));
  if (misc.rows.length) out.push(misc);
  for (const g of out) {
    g.rows.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }
  return out;
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

/** 时间模式/归档的分组标题：左侧主标题 + 右侧数量，避免和会话行抢视觉重心 */
function groupHead(label, count, { button = false, onclick = null } = {}) {
  const kids = [
    el('span', { class: 'sess-group-label', text: label }),
    count ? el('span', { class: 'sess-group-count', text: String(count) }) : null,
  ];
  if (button) {
    return el('button', { type: 'button', class: 'sess-group sess-group-btn', onclick },
      ...kids.filter(Boolean));
  }
  return el('div', { class: 'sess-group' }, ...kids.filter(Boolean));
}

function renderHistoryList() {
  const box = st.ui?.history?.querySelector('.sess-hist-list');
  if (!box) return;
  const rows = rowsForGroups();
  const globalScope = scopeMode() === 'global';
  const summary = st.ui?.history?.querySelector('#sessHistSummary');
  if (summary) {
    // 标明当前「换论文时对话怎么接」，避免把「共用会话」误当成 bug
    const modeText = globalScope ? '全局共用' : (scopeMode() === 'paper' ? '按论文' : '按文件夹');
    summary.textContent = rows.length ? `${rows.length} 个会话 · ${modeText} · 全部文件夹` : '';
  }
  const hint = st.ui?.history?.querySelector('#sessHistModeHint');
  if (hint) {
    hint.textContent = st.histMode === 'file'
      ? (globalScope
        ? '所有论文共用一个会话列表，下面标出每个会话按顺序读过哪些论文'
        : '同一会话问过多篇论文时，会在每篇论文下各显示一次')
      : '全部会话按最近活动排序，下面标出按顺序读过哪些论文';
  }
  if (st.allLoading && !st.allList.length) {
    box.replaceChildren(el('div', { class: 'sess-empty', text: '正在读取全部会话…' }));
    return;
  }
  const active = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);
  const nodes = [];
  // 按文件模式下同一会话会出现在多个文件组：行内改名只在第一次出现的那行渲染输入框，
  // 「当前」徽标也只标第一次出现的那行
  const renameShown = new Set();
  const currentShown = new Set();

  if (st.histMode === 'file') {
    if (globalScope) {
      // 全局共用：所有会话都属于同一段跨论文对话，只分一组，论文顺序用 trail 标出
      const gids = Array.from(new Set(active.flatMap((r) => (r.docIds || []).map(String).filter(Boolean))));
      const gindex = docNameIndex(active);
      const gnames = gids.map((id) => gindex.get(id)?.name || '未知论文');
      const subText = gnames.length
        ? `所有论文共用一段对话 · 读过 ${gnames.length} 篇：${gnames.slice(0, 3).join('、')}${gnames.length > 3 ? ' 等' : ''}`
        : '所有论文共用一段对话';
      nodes.push(el('div', { class: 'sess-fileblock' },
        el('div', { class: 'sess-filegroup' },
          el('span', { class: 'sess-filegroup-ic', html: ICONS.doc }),
          el('span', { class: 'sess-filegroup-name', text: '共用会话' }),
          el('span', { class: 'sess-filegroup-count', text: String(active.length) })),
        el('div', { class: 'sess-filegroup-sub', text: subText, title: gnames.join(' → ') })));
      const rowsBox = el('div', { class: 'sess-fileblock-rows' });
      for (const r of active) rowsBox.append(historyRow(r, { trail: true, renameShown, currentShown }));
      nodes.push(rowsBox);
    } else {
      const groups = fileGroups(active);
      for (const g of groups) {
        const pathText = g.folder ? `papers / ${g.folder.replace(/\//g, ' / ')}` : 'papers/';
        nodes.push(el('div', { class: 'sess-fileblock' },
          el('div', { class: 'sess-filegroup' },
            el('span', { class: 'sess-filegroup-ic', html: ICONS.doc }),
            el('span', { class: 'sess-filegroup-name', text: g.name, title: g.name }),
            el('span', { class: 'sess-filegroup-count', text: String(g.rows.length) })),
          el('div', { class: 'sess-filegroup-sub', text: pathText })));
        const rowsBox = el('div', { class: 'sess-fileblock-rows' });
        for (const r of g.rows) rowsBox.append(historyRow(r, { trail: false, group: g, renameShown, currentShown }));
        nodes.push(rowsBox);
      }
    }
  } else {
    const pinned = active.filter((r) => r.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    if (pinned.length) {
      nodes.push(groupHead('置顶', pinned.length));
      nodes.push(...pinned.map((r) => historyRow(r, { trail: true, renameShown, currentShown })));
    }
    const rest = active.filter((r) => !r.pinned);
    const buckets = [[], [], [], []];
    for (const r of rest) buckets[bucketOf(r.updatedAt)].push(r);
    const labels = ['今天', '昨天', '最近 7 天', '更早'];
    for (let i = 0; i < buckets.length; i++) {
      if (!buckets[i].length) continue;
      nodes.push(groupHead(labels[i], buckets[i].length));
      for (const r of buckets[i]) nodes.push(historyRow(r, { trail: true, renameShown, currentShown }));
    }
  }
  if (archived.length) {
    nodes.push(groupHead(`${st.showArchived ? '▾' : '▸'} 已归档`, archived.length, {
      button: true,
      onclick: () => { st.showArchived = !st.showArchived; renderHistoryList(); },
    }));
    if (st.showArchived) {
      for (const r of archived) nodes.push(historyRow(r, { trail: st.histMode === 'time', renameShown, currentShown }));
    }
  }
  if (!nodes.length) {
    nodes.push(el('div', {
      class: 'sess-empty',
      text: st.histQuery.trim()
        ? '没有匹配的会话'
        : st.histMode === 'file'
          ? '还没有带论文记录的会话；发出第一条消息后会归到对应论文下。'
          : '还没有会话',
    }));
  }
  box.replaceChildren(...nodes);
}

/** 每行下面的「按顺序读过哪些论文」（最多 3 个，其余 +N）。
 *  两种排列都显示：按时间排时它是补充信息；按文件排时它负责讲清
 *  「这段对话除了当前这篇，还问过哪几篇、先后顺序是什么」。 */
function historyTrail(row) {
  const ids = Array.from(new Set((row.docIds || []).map(String).filter(Boolean)));
  if (!ids.length) return null;
  const index = docNameIndex([row]);
  const names = ids.map((id) => docLabel(row, id, index));
  const MAX = 3;
  const chips = [el('span', { class: 'sess-htrail-label', text: '读过' })];
  names.slice(0, MAX).forEach((name, i) => {
    chips.push(el('span', { class: 'sess-htrail-doc', title: `第 ${i + 1} 篇：${name}` },
      el('span', { class: 'sess-htrail-n', text: String(i + 1) }),
      el('span', { class: 'sess-htrail-name', text: name })));
  });
  if (names.length > MAX) chips.push(el('span', { class: 'sess-htrail-more', text: `+${names.length - MAX}` }));
  return el('span', { class: 'sess-htrail', title: `按提问顺序：${names.join(' → ')}` }, ...chips);
}

function historyRow(row, { trail = false, group = null, renameShown = null, currentShown = null } = {}) {
  // 按文件排列时同一会话可能出现在多个论文分组里；「当前」徽标只标第一次，
  // 否则同一个会话会同时有好几行写「当前」，看起来像有好几个当前会话。
  // 还要防历史数据过期（切换论文/归属模式后旧列表没刷新）：只有这一行确实有当前
  // 归属键下的副本、且（按文件时）就在当前论文分组里，才允许标「当前」。
  const scopeKeyNow = listScopeKey();
  const copies = Array.isArray(row._copies) ? row._copies : [];
  const hasScopeCopy = !row.fileKey && !copies.length
    ? true
    : isScopeFileKey(row.fileKey) || copies.some((c) => isScopeFileKey(c?.fileKey));
  const docNow = String(st.ctx?.doc?.()?.docId || '');
  const groupOk = st.histMode !== 'file' || !group?.id || !docNow || String(group.id) === docNow;
  const canMarkCurrent = !st.entryVisible && !!st.currentSid && row.sid === st.currentSid
    && hasScopeCopy && groupOk
    && !(currentShown && currentShown.has(row.sid));
  const on = canMarkCurrent;
  if (on && currentShown) currentShown.add(row.sid);
  const title = row.title || (row.count ? '（无标题会话）' : '新会话');
  const docCount = Array.from(new Set((row.docIds || []).map(String).filter(Boolean))).length;
  const metaParts = [
    row.count ? `${row.count} 条` : '空会话',
    relTime(row.updatedAt),
  ];
  if (st.histMode === 'time') {
    metaParts.push(row.folderPath ? `📁 papers / ${row.folderPath.replace(/\//g, ' / ')}` : '📁 papers/');
  } else if (group?.folder && row.folderPath && group.folder !== row.folderPath) {
    metaParts.push(`📁 ${row.folderPath.replace(/\//g, ' / ')}`);
  }
  const meta = metaParts.filter(Boolean).join(' · ');

  const badges = [];
  if (on) badges.push(el('span', { class: 'sess-badge on', text: '当前' }));
  if (st.histMode === 'time' && row.pinned) badges.push(el('span', { class: 'sess-badge', text: '置顶' }));

  const wrap = el('div', { class: `sess-hrow${on ? ' on' : ''}${row.archived ? ' archived' : ''}`, dataset: { sid: row.sid } });

  const canRenameHere = st.renameSid === row.sid && (st.histMode !== 'file' || !renameShown?.has(row.sid));
  if (canRenameHere) {
    renameShown?.add(row.sid);
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

  const trailEl = (trail || docCount > 1) ? historyTrail(row) : null;
  wrap.append(
    el('button', {
      type: 'button', class: 'sess-hgo', title,
      onclick: () => chooseSession(row, group?.id || ''),
      ondblclick: (e) => { e.preventDefault(); startRename(row.sid); },
    },
    el('span', { class: 'sess-htop' },
      el('span', { class: 'sess-htitle', text: title }),
      ...badges),
    el('span', { class: 'sess-hmeta', text: meta }),
    trailEl),
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
    if (row.sid === st.currentSid && !!st.currentSid && st.ctx?.hasDoc?.() && isScopeFileKey(keyForRow(row))) {
      await st.ctx.deleteSession(row.sid);
      // 当前归属键由 deleteSession 删；其它存储键下的副本要一起清，否则历史里会「复活」
      const others = (row._copies || []).filter((c) => !isScopeFileKey(c.fileKey || listScopeKey()));
      if (others.length) await deleteRowFile({ ...row, _copies: others });
    } else {
      await deleteRowFile(row);
    }
    st.list = st.list.filter((r) => r.sid !== row.sid);
    st.allList = st.allList.filter((r) => r.sid !== row.sid);
    await refreshList({ force: true });
    if (st.historyOpen) await refreshAllList();
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

/** app.js 在历史面板里跨文件夹打开会话时用：openDoc 会按「进入方式」重新亮出选择卡片，
 *  用户已经点名要哪个会话，先收起来，再切过去。 */
export function sessionsHideEntryCard() {
  if (!st.entryVisible) return;
  hideEntryCard();
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

/** 设置页「会话」分类用：进入文件夹默认方式 / 历史默认排列 */
export function sessionsGetEnterMode() { return readOnEnter(); }
export function sessionsSetEnterMode(mode) {
  setOnEnter(mode === 'resume' || mode === 'new' ? mode : 'choose');
}
export function sessionsGetHistoryMode() { return readHistMode(); }
export function sessionsSetHistoryMode(mode) {
  const next = mode === 'time' ? 'time' : 'file';
  st.histMode = next;
  try { localStorage.setItem(HIST_MODE_KEY, next); } catch { /* ignore */ }
  if (!st.historyOpen) return;
  st.ui?.history?.querySelectorAll('.sess-arrange-chip').forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderHistoryList();
}

/** AI 自动标题完成后由 app.js 调用：就地更新头部/快切/历史行，不重新拉网络 */
export function sessionsApplyMeta(sid, patch) {
  if (!sid || !patch) return;
  for (const arr of [st.list, st.allList]) {
    for (const row of arr) if (row.sid === sid) Object.assign(row, patch);
  }
  if (st.ctx?.hasDoc?.()) renderHeader();
  if (st.quickOpen) renderQuickList();
  if (st.historyOpen) renderHistoryList();
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
