import { $, $$, el, appendAll, toast, toastAction, cleanText, renderMarkdown, escapeHtml, debounce, throttle, clamp, fmtSize } from './util.js';
import { iconEl, iconHTML, hasIcon } from './icons.js';
import { PdfViewer, clampZoomSpeed, ZOOM_SPEED_MIN, ZOOM_SPEED_MAX, readPdfPages, renderPdfPageImage } from './pdfview.js';
import { tabsFeatureEnabled, loadWorkspace, saveWorkspace, createTabBar, pushClosedTab, popClosedTab, TABS_MAX } from './tabs.js';
import { OPS, opById } from './ops.js';
import {
  TEACHING_OPS, teachingOpById, TEACHING_PROMPT_VERSION, PROMPT_SYSTEM_VERSION, WALK_CONTINUE_SYS, walkReteachSys,
  PREREQ_ONE_SYS, splitPrtBlock, hideStreamTail, parsePrereqItems, detectPageObjects,
  pageTextOf, collectDocObjects, sanitiseChips,
} from './teaching.js';
import { profileStore, buildProfileBlock, nowISO, nowContext, findItem, selectProfileItems } from './profile.js';
import { createLearningMemory, parseMemorySuggestions, explicitIdentityFacts, withMemoryObservations } from './learning-memory.js';
import {
  Settings, streamChat, testConnection, targetLangFor, searchTerms,
  translateMessages, translateShotMessages, askMessages, explainMessages,
  digestMessages, webQueryFor, filterWebResults, opMessages, teachMessages, condenseMessages,
  scanPageMessages, sessionSummaryMessages, sessionTitleMessages,
} from './ai.js';
import { resolveReadingRequest, resolvePageRole, snapshotReadingRequest, snapshotHistory, readingTurn,
  restoreReadingHistory, citedSources, stripPageLabels } from './reading-context.js';
import { validateCitations, collectAvailablePages, planFor, pagesFromText, formatPageList } from './citation-validator.js';
import { runAgentLoop, agentStats, AGENT_TOOL_SPECS, AGENT_SYSTEM_NOTE, toolStepLabel, stripAgentMarkup } from './agent.js';
import { lastPromptDebug as __promptDebug } from './prompts/index.js';
import {
  initSessions, sessionsOnFolderEntered, sessionsOnDocOpened, sessionsOnSessionChanged,
  sessionsMigrateFolder, sessionsRefreshHeader, sessionsSetBusy,
  sessionsIsEntryMode, sessionsLeaveEntryForNewSession, sessionsEntryCardEl, sessionsHideEntryCard,
  sessionsApplyMeta, sessionsGetEnterMode, sessionsSetEnterMode,
  sessionsGetHistoryMode, sessionsSetHistoryMode, sessionsGetList,
} from './sessions.js';

/** 两个布尔开关存在 localStorage 里，重启/换论文都保留 */
function readFlag(key, dflt = false) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch { return dflt; }
}
function writeFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/** 等一帧。页面被隐藏（自动化 `--background` 窗口）时 rAF 不触发，用定时器兜底。 */
function nextFrame(ms = 120) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, ms);
  });
}

/** AI 区的分块定义。默认一个都不显示，用到哪块就自动出现，也可以手动增删。 */
const AI_BLOCKS = [
  { id: 'translate', title: '译文', hint: '划选正文后点「译」，或框选截图翻译图表/公式；译文按时间堆在这里' },
  { id: 'chat', title: '问答', hint: '点「释」在这里解释这段；「＋对话」加入选中的文字或截图，然后你自己提问' },
];


/** 只许待在右栏的面板（= PANEL_DEFS 里 dock:'right' 的那两个） */
const isRightPanel = (id) => PANEL_IDS_RIGHT.includes(id);
/** 右栏的结果区。参数 n 是历史遗留（曾经有第 2 栏），现恒为 1，保留签名以免改动 30+ 处调用点 */
const rightAreaEl = (_n) => document.getElementById('aiArea');
/** 右栏的 <aside>。参数 n 同上，恒为 1 */
const rightColEl = (_n) => document.getElementById('rightSide');
const rightColsWanted = () => 1;
/** 右栏面板的列归属：恒为第 1 栏（见上） */
const colOf = (_id) => 1;
let panelParkEl = null;
function panelPark() {
  if (!panelParkEl) panelParkEl = el('div', { id: 'panelPark', 'aria-hidden': 'true' });
  return panelParkEl;
}
/**
 * 面板节点此刻应该在哪个容器里：可见且右栏没被收起 → 结果区；否则 → 停放区。
 * 只有这一份可见的那个面板进结果区（一栏只开一个），其余一律停放。
 */
function dockedAreaFor(id) {
  const p = state.panels?.[id];
  if (!p || !isRightPanel(id)) return null;
  if (!p.visible) return panelPark();
  if (p.dock !== 'right') return panelPark();          // 模型被外部改坏时的兜底
  if (document.body.classList.contains('no-right')) return panelPark();
  return rightPanelInCol(1) === id ? rightAreaEl(1) : panelPark();
}
function rememberBodyScroll(id) {
  const box = state.blockMeta[id]?.body;
  // 只在还在文档里的时候读：节点一旦离开文档，scrollTop 会被浏览器归零，
  // 这时候读到的 0 会把真正的位置覆盖掉（R12 实测踩过：想要 794，存下来的是 0）。
  if (box && box.isConnected && box.clientHeight > 0) box.__prtScrollTop = box.scrollTop;
}
/** 重新挂回文档之后把滚动位置放回去（clientHeight 为 0 时读回也没用，所以要求它排过版） */
function applyBodyScroll(id) {
  const box = state.blockMeta[id]?.body;
  if (box && box.clientHeight > 0 && box.__prtScrollTop > 0) box.scrollTop = box.__prtScrollTop;
}
/** 右栏重新打开时从最新结果开始看；用户随后可以手动滑动查看旧结果。
 *  译文块是 column-reverse（最新在最上面），所以「最新」那一端是 scrollTop = 0 ——
 *  统一交给 scrollToNewest() 判断，别在这里写死 scrollHeight。 */
function scrollBodyToBottom(id) {
  const box = state.blockMeta[id]?.body;
  if (!box || box.clientHeight <= 0) return;
  scrollToNewest(box);
}
/** 把节点搬进目标容器（同一个节点，内容与滚动位置都不动）；已经在里面就什么都不做 */
function parkRightPanel(id, target) {
  const node = state.blockEls[id];
  if (!node || !target) return;
  const parked = target === panelPark();
  // 停放态同时挂 hidden 属性：节点虽然脱离文档，但样式上也不该有任何显示机会
  //（写 CSS 的隐藏容器也挡不住 position:fixed 之类的历史残留，属性这一层是最后一道保险）。
  if (parked) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
  if (node.parentElement === target) return;
  rememberBodyScroll(id);
  withPanelMove([node], () => target.append(node));
  // 同一帧内就把位置补回去：只靠 setPanelVisible 里那个 requestAnimationFrame 太晚 ——
  // 调用方（包括自动化套件）完全可能在下一帧之前就读 scrollTop，读到的会是 0。
  if (!parked) applyBodyScroll(id);
}



/** 六个面板的固定 id 与默认值：左栏文件/目录/笔记/参考文献，右栏译文/问答 */
const PANEL_DEFS = [
  { id: 'files', title: '文件', dock: 'left' },
  { id: 'outline', title: '目录', dock: 'left', visible: false },
  { id: 'notes', title: '笔记', dock: 'left', visible: false },
  // 参考文献同理：默认只留图标入口；列表按需解析
  //（见 ensureRelationsBuilt），打开论文时不再后台跑全文引用抽取。
  // 老用户保存过 reader.panels 的展开状态仍按存档恢复（见 readPanelDescriptor），
  // 但会被 normalizeLeftPanels() 收敛成「只有一块可见」。
  { id: 'relations', title: '参考文献', dock: 'left', visible: false, collapsed: true },
  { id: 'translate', title: '译文', dock: 'right', visible: false },
  { id: 'chat', title: '问答', dock: 'right', visible: false },
];
const PANEL_IDS = PANEL_DEFS.map((d) => d.id);
/** 右栏面板 id（顺序与旧 AI_BLOCKS 一致，兼容老 reader.ai 的 order 数组） */
const PANEL_IDS_RIGHT = PANEL_DEFS.filter((d) => d.dock === 'right').map((d) => d.id);
/**
 * 六个面板的默认描述符（每次现算一份新对象，别让调用方改到模板上）。
 * 注意是 function 而不是 const 箭头函数：state = { panels: loadPanels() } 在模块求值时就会跑到
 * 这里，那时 const 还在 TDZ 里，会直接抛 "Cannot access before initialization"。
 */
function defaultPanels() {
  return Object.fromEntries(PANEL_DEFS.map((d, i) => [d.id, {
    id: d.id, dock: d.dock, home: d.dock, order: i, visible: d.visible !== false,
    collapsed: d.collapsed === true, size: null,
  }]));
}

const panelTitle = (id) => (PANEL_DEFS.find((d) => d.id === id) || {}).title || id;
function panelEl(id) {
  if (PANEL_IDS_RIGHT.includes(id)) return state.blockEls?.[id] || null;
  return document.querySelector(`[data-panel="${id}"]`);
}
/** 收起时还剩标题栏的那个节点（左栏 .sec-head / 右栏 .ai-head / 文件块 .side-head）。
 * 文件面板本身就是 .side-head，不能只用 querySelector 查后代，否则它永远不会绑定拖拽。
 */
const panelHeadEl = (id) => {
  const root = panelEl(id);
  if (!root) return null;
  return root.matches?.('.side-head, .sec-head, .ai-head')
    ? root
    : root.querySelector('.side-head, .sec-head, .ai-head');
};

const PANEL_DOCKS = ['left', 'right', 'hidden'];

/** 读一份合法描述符：非法值全部回落到默认值，宁可用默认值也不能出 NaN / undefined */
function readPanelDescriptor(id, raw, fallback) {
  const dock = PANEL_DOCKS.includes(raw?.dock) ? raw.dock : fallback.dock;
  const size = Number(raw?.size);
  const home = PANEL_DOCKS.includes(raw?.home) ? raw.home : fallback.home;
  return {
    id,
    dock,
    home,
    order: Number.isFinite(raw?.order) ? raw.order : fallback.order,
    visible: typeof raw?.visible === 'boolean' ? raw.visible : fallback.visible,
    collapsed: typeof raw?.collapsed === 'boolean' ? raw.collapsed : fallback.collapsed,
    size: Number.isFinite(size) && size > 0 ? size : null,
  };
}

function loadPanels() {
  const panels = defaultPanels();
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('reader.panels') || 'null'); } catch { raw = null; }

  if (raw && typeof raw === 'object') {
    for (const id of PANEL_IDS) panels[id] = readPanelDescriptor(id, raw[id], panels[id]);
    return panels;
  }
  // 新 key 不存在：试着从老的 reader.ai 迁移
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem('reader.ai') || 'null'); } catch { legacy = null; }
  if (!legacy || typeof legacy !== 'object') return panels;

  const applyLegacy = (src) => {
    if (!src || typeof src !== 'object') return;
    for (const id of PANEL_IDS_RIGHT) {
      if (typeof src.visible?.[id] === 'boolean') panels[id].visible = src.visible[id];
      const size = Number(src.size?.[id]);
      if (Number.isFinite(size) && size > 0) panels[id].size = size;
    }
    const rightOrder = (Array.isArray(src.order) ? src.order : []).filter((x) => PANEL_IDS_RIGHT.includes(x));
    if (!rightOrder.length) return;
    for (const id of PANEL_IDS_RIGHT) if (!rightOrder.includes(id)) rightOrder.push(id);
    rightOrder.forEach((id, i) => { panels[id].order = 4 + i; });   // 左栏 0..3，右栏接在后面
  };
  applyLegacy(legacy);
  // byDoc 覆盖：docId 优先取 ?open=（可能是 docId，也可能是文件名）、再取左栏列表里的当前项，
  // 都认不出来就留给 applyPanelMigration() 在 boot 后续（拿到服务端 lastDoc 之后）补一次
  const byDoc = legacy.byDoc && typeof legacy.byDoc === 'object' ? legacy.byDoc : null;
  const docId = byDoc ? resolvePanelDocId(byDoc) : '';
  if (docId && byDoc[docId]) applyLegacy(byDoc[docId]);
  else if (byDoc) state._aiMigrated = legacy;
  savePanels(panels);
  return panels;
}

function applyPanelMigration() {
  const legacy = state._aiMigrated;
  state._aiMigrated = null;
  if (!legacy || !state.panels) return false;
  const byDoc = legacy.byDoc && typeof legacy.byDoc === 'object' ? legacy.byDoc : null;
  const docId = byDoc ? resolvePanelDocId(byDoc) : '';
  const src = docId ? byDoc[docId] : null;
  if (!src || typeof src !== 'object') return false;
  let changed = false;
  for (const panel of PANEL_IDS_RIGHT) {
    const p = state.panels[panel];
    if (typeof src.visible?.[panel] === 'boolean' && p.visible !== src.visible[panel]) {
      p.visible = src.visible[panel];
      changed = true;
    }
    const size = Number(src.size?.[panel]);
    if (Number.isFinite(size) && size > 0 && p.size !== size) { p.size = size; changed = true; }
  }
  const rightOrder = (Array.isArray(src.order) ? src.order : []).filter((x) => PANEL_IDS_RIGHT.includes(x));
  for (const panel of PANEL_IDS_RIGHT) if (!rightOrder.includes(panel)) rightOrder.push(panel);
  if (rightOrder.length) {
    const base = Math.min(...PANEL_IDS_RIGHT.map((panel) => state.panels[panel].order));
    rightOrder.forEach((panel, i) => {
      if (state.panels[panel].order !== base + i) { state.panels[panel].order = base + i; changed = true; }
    });
  }
  if (changed) savePanels();
  return changed;
}

/** 找出 byDoc 里属于「当前这篇论文」的那一条（拿不到就返回空串） */
function resolvePanelDocId(byDoc) {
  const keys = Object.keys(byDoc);
  if (!keys.length) return '';
  let open = '';
  try { open = new URL(location.href).searchParams.get('open') || ''; } catch { /* 忽略 */ }
  const candidates = [
    open,
    serverState.lastDoc || '',
    state.doc?.docId || '',
    $$('#fileList li').find((li) => li.classList.contains('active'))?.dataset.id || '',
  ].filter(Boolean);
  for (const c of candidates) {
    if (byDoc[c]) return c;
    // ?open= 有时给的是文件名：按「去扩展名后的 slug」去配 docId（docId 形如 slug-xxxxxxxx）
    const slug = c.replace(/\.pdf$/i, '').toLowerCase();
    const hit = keys.find((k) => k.toLowerCase().startsWith(`${slug}-`));
    if (hit) return hit;
  }
  return '';
}

/** 写回 reader.panels（整份快照，不再按论文分叉）。
 *  别的窗口改了同一份存档时由 initPanelSync() 的 storage 监听收回来。 */
function savePanels(panels = state.panels) {
  try {
    localStorage.setItem('reader.panels', JSON.stringify(panels));
  } catch { /* 忽略 */ }
}

function applyPanelPatch(id, raw) {
  if (!PANEL_IDS.includes(id) || !raw || typeof raw !== 'object' || !state.panels?.[id]) return;
  state.panels[id] = { ...state.panels[id], ...raw, id };
  applyPanels();
  if (id === 'translate' || id === 'chat') fitBlockSizes();
}

function initPanelSync() {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'reader.panels' || !e.newValue) return;
    try {
      const panels = JSON.parse(e.newValue);
      if (panels && typeof panels === 'object') for (const id of PANEL_IDS) applyPanelPatch(id, panels[id]);
    } catch { /* 忽略损坏的旧存档 */ }
  });
}

/** 同一 dock 内按 order 排好的面板 id（order 相同时按注册表顺序，稳定排序） */
const panelsOfDock = (dock) => PANEL_IDS
  .filter((id) => state.panels[id].dock === dock)
  .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
const visiblePanelsOfDock = (dock) => (state.panels ? panelsOfDock(dock).filter((id) => state.panels[id].visible) : []);

/** 右栏「在右栏里」的全部面板（输入框上面那排「译文 / 问答」开关要用它） */
const rightPanelsAll = () => PANEL_IDS
  .filter((id) => state.panels[id].dock === 'right')
  .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));

/** 右栏当前显示的面板签名（可见集合变了才重排右栏，见 applyPanels 的 ③） */
const rightPanelsSig = () => `${rightColsWanted()}|${PANEL_IDS_RIGHT.map((id) => `${id}#${colOf(id)}${state.panels[id].visible ? '1' : '0'}`).join(',')}`;

function applyPanels() {
  for (const id of PANEL_IDS) {
    const p = state.panels[id];
    const node = panelEl(id);
    if (!node) continue;
    node.dataset.panel = id;
    node.dataset.dock = p.dock;
    const panelHidden = !p.visible || p.dock === 'hidden';
    node.classList.toggle('hidden', panelHidden);
    // 文件面板的拖入区 / 文件列表是它的兄弟节点：只藏标题栏会留下半截侧栏
    if (id === 'files') for (const part of panelParts('files')) part.classList.toggle('hidden', panelHidden);
    node.classList.toggle('panel-collapsed', p.collapsed);
    if (p.collapsed) node.setAttribute('data-collapsed', '');
    else node.removeAttribute('data-collapsed');
    const head = panelHeadEl(id);
    if (head) head.setAttribute('aria-expanded', String(!p.collapsed));
  }

  // 左栏活动栏的高亮跟着「此刻真正显示的是哪一块」走（一次只开一个 → 高亮唯一）
  try { syncRailActive(); } catch { /* 活动栏还没装好（boot 早期）时忽略 */ }
  // 左栏没有任何可见面板时，不保留一整块只有背景色的空栏；活动栏仍作为入口
  document.body.classList.toggle('left-empty', visiblePanelsOfDock('left').length === 0);
  // 右栏同理：译文与问答都关掉以后，右栏收成右侧活动栏（图标仍在，点一下就能拉回来）
  document.body.classList.toggle('right-empty', visiblePanelsOfDock('right').length === 0);

  // ② 左栏按 order 重排。搬的是同一批节点，走 withPanelMove：滚动位置 / 焦点 / 输入内容一个都不丢
  //（面板头常常是当前有焦点的节点，被搬走时浏览器会 blur 它，搬完必须 focus 回去）
  const leftEl = $('#leftSide');
  if (leftEl) {
    const shownIds = panelsOfDock('left');
    const hiddenIds = PANEL_IDS.filter((id) => state.panels[id].dock === 'hidden');
    const parts = [...shownIds, ...hiddenIds].flatMap((id) => panelParts(id));
    if (parts.length) {
      withPanelMove(parts, () => {
        for (const id of shownIds) for (const part of panelParts(id)) leftEl.append(part);
        // dock='hidden' 的面板节点收进左栏待着：display:none 不占地方，重新显示时它还在文档里
        for (const id of hiddenIds) for (const part of panelParts(id)) leftEl.append(part);
      });
    }
  }

  // ③ 右栏：无条件走一遍。renderCol() 内部对「已经是对的那块」有短路，
  // 真正的 replaceChildren 只在换块 / 变空态时发生，所以不会把消息和滚动位置洗掉。
  state._aiVisibleSig = rightPanelsSig();
  renderCols();
}

/* 说明：applyPanels 走到这里就结束了。原来跟在后面的「④c 底部停靠区」「⑤ 顶栏 ▤ 小圆点」
   以及 applyBottomDock / ensureDockCell / ensureDockSplit / renderRightSlots 四个函数，
   都在批次一里随面板管理器与底部停靠区一起删除。 */

function togglePanelCollapsed(id) {
  const p = state.panels[id];
  p.collapsed = !p.collapsed;
  savePanels();
  applyPanels();
  // 折叠只是显示/隐藏，右栏块高度要重新夹一次（否则折叠那个块的高度还占着）
  if (p.dock === 'right') fitBlockSizes();
}

function setPanelVisible(id, on) {
  const p = state.panels[id];
  if (!p) return;
  const wasVisible = p.visible;
  p.visible = !!on;
  // 右栏两块只有「在右栏」这一种去向；左栏面板重新显示时从 hidden 回到左栏
  if (isRightPanel(id) && p.dock !== 'right') p.dock = 'right';
  if (!isRightPanel(id) && on && p.dock === 'hidden') p.dock = 'left';
  // 同一栏一次只放一块：右栏两块互斥（「一栏只开一个 + 底部标签切换」）
  if (on && isRightPanel(id)) {
    for (const other of PANEL_IDS_RIGHT) {
      if (other === id || !state.panels[other].visible) continue;
      if (state.panels[other].dock === 'right') state.panels[other].visible = false;
    }
  }
  // 左栏更严，而且更早：整个左栏一次只显示一块（用户口径 2026-10-03：
  //   「左侧应该也做成一次只能打开一个」）—— 打开哪一块，其余三块自动收起，
  //   但每块自己的折叠状态（p.collapsed）不动，那是另一回事。
  if (on && !isRightPanel(id) && p.dock === 'left') {
    for (const other of PANEL_IDS) {
      if (other === id || isRightPanel(other)) continue;
      if (state.panels[other].dock === 'left' && state.panels[other].visible) state.panels[other].visible = false;
    }
  }
  // 自动打开一个右栏面板 = 用户明确要这一侧，别让它被自动收起（2.1 的临时豁免）
  if (on && p.dock === 'right') sideIntent.pinned.right = true;
  // 隐藏是 display:none，滚动容器量不到高度、scrollTop 会归零：
  // 先把这一块 body 的滚动位置记下来，重新显示之后再放回去。
  if (!on && wasVisible) rememberBodyScroll(id);
  savePanels();
  applyPanels();
  applyResponsiveLayout();
  // 关闭左栏最后一个面板时同步收起整栏，保留活动栏作为明确的展开入口。
  if (!on && !isRightPanel(id) && visiblePanelsOfDock('left').length === 0
      && !document.body.classList.contains('no-left')) {
    setSideCollapsed('left', true);
  }
  if (on && !wasVisible) requestAnimationFrame(() => {
    applyBodyScroll(id);
    scrollBodyToBottom(id);
  });
}

/* ── 面板部件 ── */

function panelParts(id) {
  let node = panelEl(id);
  if (!node && PANEL_IDS_RIGHT.includes(id)) {
    ensureBlock(id);
    node = panelEl(id);
  }
  if (!node) return [];
  if (id !== 'files') return [node];
  return [node, $('#dropzone'), $('#fileList')].filter(Boolean);
}
/** 各条动效的时长（ms）——都在用户要求的 100–260ms 区间内 */
const ANIM = { flip: 200 };
const EASE = 'cubic-bezier(.2,.7,.3,1)';   // 短 ease-out，不做弹跳、不做长缓动

/** 用户要求减少动态效果吗（读不到就当 false；测试里可以用 page.emulateMediaFeatures 切） */
function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
const motionMs = (ms) => (prefersReducedMotion() ? 0 : ms);


function capturePanelMove(nodes) {
  const scrolls = [];
  const seen = new Set();
  const keep = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    // 右栏的 .ai-body 有一个「离开文档时也不能丢」的位置（__prtScrollTop，见 rememberBodyScroll）：
    // 节点一旦脱离文档，n.scrollTop 已经是 0，照抄它就会把真正的位置覆盖成 0 —— 换栏时实测就丢在这儿。
    const top = n.__prtScrollTop > 0 ? n.__prtScrollTop : n.scrollTop;
    scrolls.push([n, top]);
  };
  const walk = (n) => { keep(n); for (const child of n.children) walk(child); };
  for (const n of nodes) {
    walk(n);
    for (let up = n.parentElement; up && up !== document.body; up = up.parentElement) keep(up);
  }
  const active = document.activeElement;
  const input = $('#chatInput');
  return {
    scrolls,
    active: active && active !== document.body && nodes.some((n) => n.contains(active)) ? active : null,
    input: input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null,
    msgCount: document.querySelectorAll('#aiArea .msg').length,
  };
}

/**
 * capturePanelMove() 的快照还原：滚动位置 / 焦点元素 / #chatInput 内容与光标。
 * 搬的还是同一批节点，所以这里能直接用元素引用，不需要任何选择器。
 */
function restorePanelMove(snap) {
  if (!snap) return;
  /** 把记下来的滚动位置放回去；返回「是不是已经全部对上了」 */
  const putScrolls = () => {
    let all = true;
    for (const [node, top] of snap.scrolls) {
      if (!node.isConnected) continue;
      if (node.scrollTop !== top) node.scrollTop = top;
      if (node.scrollTop !== top) all = false;    // 放不下时浏览器会夹住，这一趟没对上
    }
    return all;
  };
  const put = () => {
    putScrolls();
    if (snap.active && snap.active.isConnected && document.activeElement !== snap.active) {
      snap.active.focus?.({ preventScroll: true });
    }
    const input = $('#chatInput');
    if (input && snap.input && input.value !== snap.input.value) {
      input.value = snap.input.value;
      try { input.setSelectionRange(snap.input.start, snap.input.end); } catch { /* 忽略 */ }
    }
  };
  put();
  let stopped = false;
  const stop = () => { stopped = true; };
  const opts = { once: true, capture: true, passive: true };
  document.addEventListener('pointerdown', stop, opts);
  document.addEventListener('wheel', stop, opts);
  document.addEventListener('keydown', stop, { once: true, capture: true });
  let frames = 0;
  const tick = () => {
    if (stopped) return;
    for (const [node, top] of snap.scrolls) {
      if (node.isConnected && node.scrollTop < top) node.scrollTop = top;
    }
    frames += 1;
    if (frames < 40) requestAnimationFrame(tick);
    else {
      document.removeEventListener('pointerdown', stop, opts);
      document.removeEventListener('wheel', stop, opts);
      document.removeEventListener('keydown', stop, opts);
    }
  };
  requestAnimationFrame(tick);
  setTimeout(putScrolls, ANIM.flip + 60);
}

/**
 * 面板搬家的统一入口：先拍快照 → 执行搬动 → 还原位置与焦点。
 */
function withPanelMove(nodes, fn) {
  const snap = capturePanelMove(nodes);
  fn();
  restorePanelMove(snap);
  return snap;
}

/* ── 键盘：焦点在哪个面板上 ── */

/** 当前聚焦（或最近点过）的面板 id（现由 Esc / 快捷键路径复用） */
function currentPanelId() {
  const active = document.activeElement;
  const inPanel = active?.closest?.('[data-panel]')?.dataset?.panel;
  if (inPanel && state.panels?.[inPanel]) return inPanel;
  if (state._activePanel && state.panels?.[state._activePanel]) return state._activePanel;
  return '';
}

/** 面板头左侧的点开区域：Enter/Space 折叠展开、Alt+H 隐藏 */
function bindPanelHead(id, head) {
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(!state.panels[id].collapsed));
  head.addEventListener('keydown', (e) => {
    // 这些组合由面板头自己处理：别让文档级快捷键再抢一次（比如 Alt+H 落到无修饰的 h）
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      e.stopPropagation();
      togglePanelCollapsed(id);
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      e.stopPropagation();
      setPanelVisible(id, false);
      toast(`已隐藏「${panelTitle(id)}」`, '', 1600);
    }
  });
}

/**
 * 标题栏右侧的直接操作（VS Code 式）：常用动作直接摆在标题栏上；
 * 参数是 icons.js 的 id —— 图标本身不承担语义，title / aria-label 照旧给全。
 */
function panelIcon(iconId, title, onclick, extra) {
  return el('button', {
    type: 'button', class: `tbtn tiny panel-icon ${extra || ''}`.trim(), title,
    'aria-label': title,
    onclick: (e) => { e.stopPropagation(); onclick(); },
  }, iconEl(iconId));
}
/** 右栏两块只有「在右栏里 / 藏着」两种去向，左栏四块同理 —— 所以标题栏只留一个「隐藏」。
 *  再打开走左栏底部的图标坞（左栏面板）或右栏底部的「译文 / 问答」切换器。 */
function panelActions(id) {
  const title = panelTitle(id);
  return el('div', { class: 'panel-actions' },
    panelIcon('close', `隐藏「${title}」`, () => setPanelVisible(id, false), 'panel-hide'),
  );
}

/* 左栏底部的小图标坞（连同 PANEL_DOCK_ICON / dockButton）已整体删除（2026-10）。
   用户口径：「A 只留最左边那条窄活动栏」+「那几个点不动……直接删掉就行」。
   左栏的面板入口现在只剩常驻的 `#railLeft`（`syncRailActive()` 负责高亮）。 */

function bindPanelToggleGestures(btn, id, { onClick = null } = {}) {
  btn.addEventListener('click', (e) => {
    if (onClick) onClick(e);
    else toggleDockPanel(id);
  });
  return btn;
}

/** 右栏「面板切换器」容器（恒为第 1 栏；参数保留以免改动调用点） */
const aiBarEl = (_n) => document.getElementById('aiBar');

/* 左栏图标坞（#panelDock / syncPanelDock / dockButton / PANEL_DOCK_ICON）
   已整体删除。
   左栏的面板入口现在只有常驻的 `#railLeft` 那一条，左右两侧不再各有一套图标。 */

/** 点图标：显示 / 收起（右栏「一栏只开一个」的互斥由 setPanelVisible 保证） */
function normalizeLeftPanels() {
  const vis = PANEL_IDS
    .filter((id) => !isRightPanel(id) && state.panels?.[id]?.dock === 'left' && state.panels[id].visible)
    .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
  if (vis.length <= 1) return false;
  for (const id of vis.slice(1)) state.panels[id].visible = false;
  return true;
}

function toggleDockPanel(id) {
  const p = state.panels[id];
  if (!p) return;
  if (p.visible) return;              // 已开 → 不做反应（不再关掉它）
  setPanelVisible(id, true);
  // 打开左栏图标坞里的「参考文献」= 按需整理的触发点
  if (id === 'relations') ensureRelationsBuilt();
}

/**
 * 六个面板统一走这一条渲染路径。
 * 左栏四块不重写内部结构：文件块用 .side-head 当标题栏，其余三块沿用 section.sec + .sec-head，
 * 只补 data-panel 与标题栏上的折叠 / 隐藏控件（内部所有 id 一个都没动）。
 */
function initPanels() {
  // 六个面板统一入模：先补上标题栏控件与折叠开关，再按注册表排一遍
  for (const d of PANEL_DEFS) ensurePanel(d.id, d);
  // 「最近碰过哪个面板」供快捷键用
  const rememberPanel = (e) => {
    const id = e.target?.closest?.('[data-panel]')?.dataset?.panel;
    if (id) state._activePanel = id;
  };
  document.addEventListener('pointerdown', rememberPanel, true);
  document.addEventListener('focusin', rememberPanel);
  applyPanels();
}

const DEFAULT_UI_STYLE = Object.freeze({
  theme: 'system', density: 'standard', fontSize: 14, lineHeight: 1.72,
  codeSize: 12, maxWidth: 760, opacity: 1,
  // PDF 纸张默认跟随阅读器的暖色纸面；设置里可切换为纯白。
  paper: 'tint',
  // 界面尺度：uiFontSize = 界面字号 px（--ui-fs），controlSize = 控件大小 %（--ctl-scale）。
  // 这两个和上面的 fontSize（阅读/结果字号 --ai-fs）是互相独立的三套刻度。
  uiFontSize: 13.5, controlSize: 100,
  showPage: true, showQuote: true, showSources: false,
  useFullText: true, useWeb: true,
  zoomSpeed: 1,
  // 双页显示：PDF 两页并排（页宽减半、按行换行）。属于用户偏好，跟着 reader.ui 存。
  twoUp: false,
});
let uiStyle = { ...DEFAULT_UI_STYLE };

const READ_FS_MIN = 12;
const READ_FS_MAX = 30;

const TEXT_COL_MIN = 320;
const TEXT_COL_MAX = 1600;

/** 界面字号：老存档（localStorage reader.ui）里没有这个字段时回落默认值，不能变 NaN */
const uiFontSizePx = (v) => clamp(Number(v) || DEFAULT_UI_STYLE.uiFontSize, 12, 17);
/** 控件大小：存档里是百分比（80–130），CSS 里是缩放系数（0.8–1.3） */
const ctlScaleOf = (v) => clamp(Number(v) || DEFAULT_UI_STYLE.controlSize, 80, 130) / 100;

const state = {
  doc: null,
  viewerDocId: null,
  // 响应式布局：窗口太窄导致的自动收起。只在内存里，绝不写进 reader.ui
  //（reader.ui.noLeft/noRight 是用户意图，两者混在一起会导致「窄窗用过一次就永久收起」）
  autoCollapse: { left: false, right: false },
  papers: [],
  folders: [],          // 文件夹树：{name,path,count}（服务端返回）
  folderOpen: new Set(), // 展开的文件夹 path 集合（localStorage 持久化）
  selection: null,
  quote: null,          // 对话引用 {page, text}
  _dragSelecting: false,   // 正在正文里拖选（用于「松手在窗口外」的兜底）
  _downAt: null,           // 这次按下的坐标，用来区分「单击」和「拖选」
  history: [],          // 已完成的问答与解释，包含各轮阅读对象
  sessionEntries: [],
  highlights: [],
  cache: new Map(),     // 翻译缓存
  abort: null,
  abortReason: '',
  busy: false,
  search: { hits: [], idx: 0, query: '' },
  jumpHistory: new Map(), // docId -> [{ scrollTop, scale }]
  activeSendScope: '',
  /* 发送框当前范围（四选项之一，2026-10 第 2 步）：只对下一次发送生效，之后沿用。
     初始值由设置页的「默认发送范围」偏好决定（syncScopePrefs → rangeFromPrefs）。 */
  scopeRange: 'paper-web',
  /* 发送框当前范围（四选项之一，2026-10 第 2 步）：只对下一次发送生效，之后沿用。
     初始值由设置页的「默认发送范围」偏好决定（syncScopePrefs → rangeFromPrefs）。 */
  scopeRange: 'paper-web',
  // 统一面板注册表（左栏四块 + 右栏两块）：见「面板注册表」一节。
  // 右栏两块的高度（px）就存在各自的 size 里，缺省=自适应平分。
  // 真正的值在 boot() 第一步由 loadPanels() 装进来（那时才拿得到当前论文，迁移要用）。
  panels: null,
  // 阶段 2.2b：浮窗动效日志（自动化探针逐条核对时长 / 缓动用的原始证据）、
  // 「最近碰过的面板」（Esc、Ctrl+Alt+←/→ 作用在它身上）、浮窗层叠序号。
  _panelAnimLog: [],
  _activePanel: '',
  _floatZ: 0,
  attachments: [],      // 待发送的附件：{id,kind:'text'|'image',page,text?,dataUrl?,w?,h?,label?}
  blockEls: {},
  blockMeta: {},
  splitEls: {},
  dragBlock: null,
  useFullText: DEFAULT_UI_STYLE.useFullText,
  useWeb: DEFAULT_UI_STYLE.useWeb,
  docText: null,
  docTextDoc: null,
  docDigest: null,
  /* 页型扫描结果（文本页 / 扫描页 / 图表页）：打开论文后后台算一次，按文件指纹缓存 */
  docProfile: null,
  docProfileDoc: null,
  docProfilePromise: null,
  /* 扫描件的「图片阅读索引」：逐页转写后拼成的文本，教学能力当全文用（按指纹缓存在 localStorage） */
  scanDigest: null,
  scanDigestDoc: null,
  scanDigestPromise: null,
  scanNoticeShown: {},
  /* 记忆：会话滚动摘要（compaction）/ 本论文之前的讨论 / 用户手写的长期记忆（在 Settings.data） */
  sessionSummary: '',
  summaryCovered: 0,
  paperMemory: '',
  lastSources: [],
  // 参考文献：本文的参考文献列表（按需解析，见 ensureRelationsBuilt）
  refs: [],
  refsDoc: null,
  refsParsing: null,
  relGen: 0,
  refsSeq: 0,
  relItemState: new Map(),
  /** 阶段 3：列表视图（搜索 / 筛选 / 排序 / 分组折叠）—— 只存内存，切论文重置，不写 localStorage */
  relView: { q: '', filter: 'all', sort: 'num', fold: { lib: false, pdf: false, todo: false, cited: false } },
  /** 关系面板顶部那一行的临时进度（解析 / 扫描 / 批量查询），单独存一份免得被重绘覆盖 */
  relHint: '',
  /** 正文引用卡片 [n] 当前在看哪一条：{ n, ref } */
  cite: null,
  // 论文操作：结果按 docId:opId 缓存（用缓存就不再花钱）；opsDone 只用于菜单里标「已生成」
  opsCache: new Map(),
  opsDone: {},
  opsDoc: null,
  // B 线 P3：会话文件里读到的条目缓存（按文档；热切换时随视图停放/恢复），以及它属于哪篇文档
  _fileEntries: [],
  _fileDocId: '',
  /** 当前文件夹（一次只处理一个文件夹；文件可跨文件夹转移） */
  currentFolder: '',
  /** 这个文件夹是否已被「完全关闭」（回到首页/所有标签关闭）→ 再进来默认新会话 */
  folderClosed: false,
  teaching: { walk: null, current: null },
  teachingCache: new Map(),
  /** 左栏文件多选（批量删除 / 批量移动）；存相对路径，仅 PDF，不含文件夹 */
  fileSel: new Set(),
  fileSelAnchor: null,
};

let viewer = null;
let serverState = {};


(async function boot() {
  await Settings.load();
  // 清理 R1 以前可能留下的持久化偏好；「整篇」不再跨论文 / 跨会话记忆。
  try { localStorage.removeItem('reader.fullText'); } catch { /* ignore */ }
  fillSettings();
  // 第一件事：装面板注册表（必要时把老的 reader.ai 迁过来）。必须在 initLayout / initPanels 之前，
  // 因为两边栏的自动收展规则（dockHasPinned）与面板渲染都要读它。
  state.panels = loadPanels();
  // 老存档可能把左栏多块都存成可见（用户实测「一打开有四个」），启动时收敛成一块。
  // 必须在 initLayout / initPanels 之前，否则会先按多块渲染一帧再跳。
  if (normalizeLeftPanels()) {
    try { savePanels(); } catch { /* 忽略 */ }
  }
  // 「系统级独立窗口」已经删除：老版本可能把这个键留在存档里，启动时直接清掉，
  // 免得它躺在 localStorage 里被误读成「某个面板暂离中」。之后主窗口一律按
  // reader.panels 里的 visible / dock 渲染，不需要任何恢复逻辑。
  try { localStorage.removeItem('reader.detachedWindows'); } catch { /* 忽略 */ }
  initLayout();
  syncScopePrefs();
  initPanels();
  initTopbar();
  initWindowChrome();     // 应用内标题栏：窗口按钮 / 拖动 / 八向缩放（无 IPC 时整块隐藏）
  initPanelSync();
  initViewer();
  initFiles();
  initFolderSwitch();
  initSelection();
  initNoteBox();
  initCiteBox();
  initAiArea();
  initTextEdgeHandle();
  initComposer();
  initRegion();
  initSearch();
  initSettings();
  // 设置页那两个「默认发送范围」偏好也是即时生效控件（第 2 步起范围回到发送框，两个入口必须同一套语义）
  ['cfgUseFullText', 'cfgUseWeb']
    .forEach((id) => document.getElementById(id)?.addEventListener('input', applyUiSettingsFromControls));
  initShortcuts();
  initExternalLinks();
  initDraggableCards();
  initRelations();
  initOps();
  initPageRefs();
  // 会话系统 P0：会话头 / 快速切换 / 历史面板 / 进文件夹选择卡片（sessions.js 需要 app.js 注入回调）
  initSessions(sessionsContext());

  await profileStore.load();
  await loadServerState();
  state.folderOpen = loadFolderOpen();
  // 服务端记住的「上次打开哪篇」这时才拿到：如果刚才的 reader.ai 迁移还没能认出当前论文，
  // 这里补一次 byDoc 覆盖（只在「刚迁移过」时发生，之后用户怎么摆就怎么算）
  const migrated = applyPanelMigration();
  if (migrated) { applyPanels(); applyResponsiveLayout(); }
  await refreshPaperList();
  await initFolderContext();
  initTabs();
  if (tabsFeatureEnabled()) await bootTabWorkspace();
  else await maybeReopenLast();
  checkConfigWarning();
})();


/* ------------------------------------------------------------ B 线：多标签工作区（P1 冷切换） */
const tabsStore = { tabs: [], active: '', bar: null, booted: false };

/* B 线 P2：已挂起文档句柄（docId → PdfViewer.detach() 的返回值）。
   切标签时先 detach 旧的、再 attach 新的，避免每次切换重新下载+解析 PDF；上限 10 个（=标签上限）。 */
const pdfHandles = new Map();
let pdfHotAttaches = 0;


/* B 线 P2：已打开文档的「视图停放区」。切走时把右栏各块的 DOM 与会话状态整体停放在这里，
   切回时直接挂回去（不重放 restoreSession、不重建目录/笔记），做到「已经打开的不重复渲染」。 */
const docViews = new Map();

/* B 线 P3：全局问答会话的版本号。**任何**会改变全局会话内容的事情都要 +1（新增问答、旧会话迁移进全局、
   换/新建/删除/清空会话…）；切回旧标签时停放视图版本落后就不能直接挂回，要按最新会话重放。
   只认「新增聊天消息」是不够的：别的论文打开时懒迁移会把旧聊天并进全局会话，停放视图没收到通知，
   一挂回就会显示旧内容、且下一次保存把旧内容写回全局文件（实测踩过：切文件会把迁移进来的聊天覆盖掉）。 */
let chatVersion = 0;

/** 全局会话「内容指纹」：冷恢复读到全局文件后用它判断内容是否变过（只加不删，长度/末条/当前 sid 足够）。 */
let globalChatSig = '';
function chatSigOf(sid, entries) {
  const last = entries.length ? entries[entries.length - 1] : null;
  return `${sid || ''}|${entries.length}|${last ? `${last.kind || ''}:${String(last.text || '').slice(-40)}` : ''}`;
}
/* B 线 P3.1：问答块是**全局共用**的，切换论文时不重绘它。
   chatDomSig = 当前聊天 DOM 里已经渲染的全局会话指纹；冷切换文档时只有指纹变了才重放整块（其余情况 DOM 原样保留）。 */
let chatDomSig = '';
const currentChatSig = () => chatSigOf(
  state.doc ? activeSidFor(state.doc.docId) : '',
  (state.sessionEntries || []).filter((e) => e && e.block === 'chat'),
);

/** 切走前：停放当前文档的右栏 DOM + 会话状态 + 目录/笔记 HTML + 滚动位置 */
function parkDocView(docId) {
  if (!docId || !state.doc || state.doc.docId !== docId) return;
  const blocks = {};
  for (const block of AI_BLOCKS) {
    // 问答块是全局会话共用的，切换论文时 DOM 原样保留（不参与停放/挂回，也就不会重绘）
    if (block.id === 'chat') continue;
    const meta = state.blockMeta?.[block.id];
    if (!meta?.body) continue;
    blocks[block.id] = {
      nodes: Array.from(meta.body.children),
      scrollTop: meta.body.scrollTop || 0,
    };
  }
  docViews.set(docId, {
    chatVersion,
    blocks,
    // 文件缓存条目也按文档停放：热切回后保存会话要能拿到这篇的译文条目，不能串到别篇
    fileEntries: (Array.isArray(state._fileEntries) ? state._fileEntries : []).slice(),
    sessionEntries: state.sessionEntries.slice(),
    history: state.history.slice(),
    sessionSummary: state.sessionSummary,
    summaryCovered: state.summaryCovered,
    teaching: state.teaching ? JSON.parse(JSON.stringify(state.teaching)) : null,
    outlineHTML: $('#outlineList')?.innerHTML || '',
    notesHTML: $('#notesList')?.innerHTML || '',
    // 会话列表（chips 菜单数据）也属于这篇文档：热切回时直接复用，不再 GET /api/sessions
    sessionList: Array.isArray(sessionStore?.list) ? sessionStore.list.map((s) => ({ ...s })) : [],
    at: Date.now(),
  });
  // 上限：标签上限 10 → 停放区最多留 20 份，超出淘汰最旧（其 PDF 句柄也一并释放）
  while (docViews.size > TABS_MAX * 2) {
    const oldest = [...docViews.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    docViews.delete(oldest[0]);
  }
}

/** 切回时：把停放的 DOM/状态挂回去；返回 true 表示走「热恢复」路径（不重放会话） */
function unparkDocView(docId) {
  const view = docViews.get(docId);
  if (!view) return false;
  // 全局会话被别的标签更新过：停放的 DOM 已经过期，丢弃并走正常重放（保证会话内容完整）
  if (view.chatVersion !== chatVersion) {
    docViews.delete(docId);
    return false;
  }
  for (const block of AI_BLOCKS) {
    // 问答块不参与停放（全局共用）；只把这篇的译文块 DOM 挂回去
    if (block.id === 'chat') continue;
    const saved = view.blocks?.[block.id];
    const meta = state.blockMeta?.[block.id];
    if (!saved || !meta?.body) continue;
    meta.body.replaceChildren(...saved.nodes);
    try { meta.body.scrollTop = saved.scrollTop || 0; } catch { /* ignore */ }
  }
  state.sessionEntries = view.sessionEntries.slice();
  state._fileEntries = Array.isArray(view.fileEntries) ? view.fileEntries.slice() : [];
  state._fileDocId = docId;
  state.history = view.history.slice();
  state.sessionSummary = view.sessionSummary || '';
  state.summaryCovered = view.summaryCovered || 0;
  state.teaching = view.teaching ? JSON.parse(JSON.stringify(view.teaching)) : state.teaching;
  if (view.outlineHTML && $('#outlineList')) $('#outlineList').innerHTML = view.outlineHTML;
  if (view.notesHTML && $('#notesList')) $('#notesList').innerHTML = view.notesHTML;
  if (Array.isArray(view.sessionList)) sessionStore.list = view.sessionList.map((s) => ({ ...s }));
  refreshCounts?.();
  return true;
}

function dropDocView(docId) {
  docViews.delete(docId);
}

function dropPdfHandle(docId) {
  const handle = pdfHandles.get(docId);
  if (!handle) return;
  pdfHandles.delete(docId);
  try { handle.pdf?.destroy?.(); } catch { /* 已经销毁 */ }
}


function tabsPersist() {
  saveWorkspace({ tabs: tabsStore.tabs, active: tabsStore.active });
}

function syncHomeBtnVisibility() {
  const home = $('#homeBtn');
  if (home) home.classList.toggle('hidden', tabsFeatureEnabled() && tabsStore.tabs.length > 0);
}

function tabsSyncBar() {
  if (tabsStore.bar) tabsStore.bar.render(tabsStore.tabs, tabsStore.active);
  syncHomeBtnVisibility();
}

function tabFor(target) {
  return {
    docId: String(target.docId || ''),
    name: String(target.name || ''),
    url: String(target.url || ''),
    path: String(target.path || target.name || ''),
  };
}

const VIEWER_MIN = 420;
const RAIL_W = 40;
const SPLIT_W = 5;

/** 拖动松手时的「收起阈值」：最终宽度比它小，就把这一侧直接收起来 */
const COLLAPSE_BELOW = { left: 140, right: 200 };

/** 右栏的历史最宽值（拖动 / 键盘微调共用的默认上限，见 rightSideMaxW 的说明） */
const RIGHT_MAX_CLASSIC = 720;

function rightSideMaxW() {
  return Math.max(RIGHT_MAX_CLASSIC, Math.round(window.innerWidth / 2));
}

/** 宽度带 .14s 过渡，量正文宽度要等它走完（键盘微调这种宽度真的在变的路径用） */
const REFIT_AFTER_MS = 200;

const sideIntent = { noLeft: false, noRight: false, pinned: { left: false, right: false } };

const sideBaseW = { left: 210, right: 360 };

/** 读一个 px 令牌的数值（读不到就用兜底值） */
function cssPx(name, dflt) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : dflt;
}

/** 正文重排：适配宽度模式重新按窗口算比例，手动缩放模式只重画可见页 */
function refitViewer(delay = 0) {
  const run = () => { if (viewer?._fitMode) viewer.fitWidth(); else viewer?._renderVisible(true); };
  if (delay > 0) setTimeout(run, delay); else run();
}

const PIN_INSET = 3;   // 与 style.css 里 .hl-pin 的 `right` 基准值必须一致

/**
 * 阅读区真正可见的右边界。
 * 不能用 `rect.right`：滚动容器的 rect 含竖向滚动条占的那一条，
 * 按 rect.right 夹取会把书签塞到滚动条底下，还是点不到。
 */
function viewerVisibleRight(el) {
  const vr = el.getBoundingClientRect();
  return vr.left + el.clientLeft + el.clientWidth;
}

let pinClampRaf = 0;

/** 把每一页的书签向左夹到阅读区可见右边界内侧（rAF 合并，一次只跑一遍） */
function clampPins() {
  pinClampRaf = 0;
  const el = document.getElementById('viewer');
  // 没有书签就立刻返回：这个函数挂在滚动 + MutationObserver 上，会被叫得很频繁
  if (!el || !el.querySelector('.hl-pin')) return;
  const visibleRight = viewerVisibleRight(el);
  // 先读后写：把每一页的右边缘读成一批，再统一写变量，避免读写交替触发多次重排
  const targets = [];
  for (const page of el.querySelectorAll('.page')) {
    if (!page.querySelector('.hl-pin')) continue;   // 只有带书签的页需要夹取
    targets.push([page, page.getBoundingClientRect().right]);
  }
  for (const [page, pageRight] of targets) {
    // 纸面右边缘（再加上书签自己的 3px 内缩）超出可见右边界多少，就把它往左推多少
    const over = pageRight + PIN_INSET - visibleRight;
    const want = over > 0 ? `${Math.ceil(over)}px` : '';
    /* 同值不回写：下面的 MutationObserver 也在看 style 变化，
       不回写这一条就会变成「写变量 → 观察者回调 → 再写变量」的自激循环。 */
    if ((page.style.getPropertyValue('--pin-clamp') || '') === want) continue;
    if (want) page.style.setProperty('--pin-clamp', want);
    else page.style.removeProperty('--pin-clamp');
  }
}

function schedulePinClamp() {
  if (pinClampRaf) return;
  pinClampRaf = requestAnimationFrame(clampPins);
}

const dockHasPinned = (dock) => PANEL_IDS.some((id) => state.panels?.[id]?.dock === dock && state.panels?.[id]?.pinned);

function applyResponsiveLayout() {
  const innerW = window.innerWidth;
  const baseLeftW = sideBaseW.left;
  const baseRightW = sideBaseW.right;
  const railW = cssPx('--rail-w', RAIL_W);
  const viewerMin = cssPx('--viewer-min', VIEWER_MIN);
  // 侧栏先「让宽」再「整条消失」（见下方 sideWanted 的注释）
  const SIDE_MIN = 220;
  const SIDE_SQUEEZE_W = 160;
  const VIEWER_HARD_MIN = viewerMin;

  // 两侧栏占掉的横向空间（右栏恒为一栏，不再有第 2 栏那份账）
  const chromeOf = (noLeft, noRight, lw = baseLeftW, rw = baseRightW) =>
    (noLeft ? railW : lw + SPLIT_W) + (noRight ? railW : rw + SPLIT_W);

  let leftApplied = baseLeftW;
  let rightApplied = baseRightW;
  const chrome = (noLeft, noRight, lw, rw) => chromeOf(noLeft, noRight, lw, rw);
  {
    // 宽度刚好卡在「正文最小宽度」附近时，两侧栏各让一半，尽量谁都别消失。
    const need = innerW - chrome(sideIntent.noLeft, false, baseLeftW, baseRightW);
    if (!sideIntent.noRight && need < viewerMin) {
      const deficit = viewerMin - need;
      leftApplied = Math.max(SIDE_MIN, baseLeftW - deficit / 2);
      rightApplied = Math.max(SIDE_MIN, baseRightW - deficit / 2);
      // 两边都压到最小还不够：把差额继续从右栏让它（正文保底 VIEWER_HARD_MIN）
      if (innerW - chrome(sideIntent.noLeft, false, leftApplied, rightApplied) < VIEWER_HARD_MIN) {
        rightApplied = Math.max(SIDE_MIN, innerW - chrome(sideIntent.noLeft, false, leftApplied, SIDE_MIN) - VIEWER_HARD_MIN + SIDE_MIN);
      }
    }
  }
  {
    const cap = Math.max(SIDE_MIN, rightSideMaxW());
    if (rightApplied > cap
      && innerW - chrome(sideIntent.noLeft, false, leftApplied, cap) >= viewerMin) {
      rightApplied = cap;
    }
  }
  const fits = (noLeft, noRight) => innerW - chrome(noLeft, noRight, leftApplied, rightApplied) >= Math.min(viewerMin, VIEWER_HARD_MIN);

  let noLeft = sideIntent.noLeft;
  let noRight = sideIntent.noRight;
  if (fits(noLeft, noRight)) {
    // 放得下：用户刚「明确展开过」的临时豁免完成使命
    sideIntent.pinned.left = false;
    sideIntent.pinned.right = false;
  } else {
    const pinLeft = dockHasPinned('left');
    const pinRight = dockHasPinned('right');
    const order = pinRight && !pinLeft ? ['left', 'right'] : ['right', 'left'];
    // ① 先收顺序里的第一侧（默认是右栏：输出区是可选项，优先牺牲它）
    if (order[0] === 'right') {
      if (!noRight && !sideIntent.pinned.right) noRight = true;
    } else if (!noLeft && !sideIntent.pinned.left) noLeft = true;
    // ② 还是放不下，才收另一侧
    if (order[1] === 'right') {
      if (!noRight && !sideIntent.pinned.right && !fits(noLeft, noRight)) noRight = true;
    } else if (!noLeft && !sideIntent.pinned.left && !fits(noLeft, noRight)) noLeft = true;
  }

  // 先把「让宽」的结果写到 CSS 变量上，再决定收不收 —— 顺序不能反：
  // fits() 是按实际宽度算的（cssPx 读的就是这两个变量），先写后判，判断才和屏幕上一致。
  const leftFinal = noLeft ? baseLeftW : leftApplied;
  const rightFinal = noRight ? baseRightW : rightApplied;
  const setVar = (name, v) => document.documentElement.style.setProperty(name, `${Math.round(v)}px`);
  // 只在真的需要让宽时动它：写的是实际生效值，窗口一放宽，上面算出的
  // leftApplied/rightApplied 自动回到用户原宽度，不需要任何额外的复位逻辑。
  if (Math.round(leftFinal) !== Math.round(cssPx('--left-w', baseLeftW))) setVar('--left-w', leftFinal);
  if (Math.round(rightFinal) !== Math.round(cssPx('--right-w', baseRightW))) setVar('--right-w', rightFinal);

  let squeezed = false;
  if (!noLeft && document.body.classList.contains('no-left') && leftFinal < 60) { setVar('--left-w', 60); squeezed = true; }
  {
    const hasRightContent = PANEL_IDS_RIGHT.some((id) => state.panels[id]?.visible);
    const autoCollapsed = noRight && !sideIntent.noRight;
    if (hasRightContent && !sideIntent.noRight && (autoCollapsed || rightFinal < SIDE_SQUEEZE_W)) {
      setVar('--right-w', SIDE_SQUEEZE_W);
      squeezed = true;
      noRight = false;                       // 只压窄，不隐藏
      state.autoCollapse = { ...(state.autoCollapse || {}), right: true };
    }
  }
  const hasLeftContent = visiblePanelsOfDock('left').length > 0;
  const autoCollapsedLeft = noLeft && !sideIntent.noLeft;
  if (hasLeftContent && !sideIntent.noLeft && (autoCollapsedLeft || leftFinal < SIDE_SQUEEZE_W)) {
    setVar('--left-w', SIDE_SQUEEZE_W);
    squeezed = true;
    noLeft = false;
  }
  // 正文允许横向滚动，而不是把侧栏藏起来
  document.body.classList.toggle('side-squeezed', squeezed);
  // right-empty 只看「有没有内容」，不看栏宽 —— 否则窄窗下活动栏会一直显示、栏永远回不来
  document.body.classList.toggle('right-empty', visiblePanelsOfDock('right').length === 0);

  state.autoCollapse = { left: noLeft && !sideIntent.noLeft, right: noRight && !sideIntent.noRight };
  const wasNoLeft = document.body.classList.contains('no-left');
  const wasNoRight = document.body.classList.contains('no-right');
  document.body.classList.toggle('no-left', noLeft);
  document.body.classList.toggle('no-right', noRight);
  syncSideToggleButtons();
  // 右栏被收起 / 放开都会改「哪些块真的有地方放」：节点的停放与结果区的重排必须跟着走，
  // 否则会出现「栏收起来了，块还赖在 DOM 里」。
  renderCols();
  // 右栏是 display:none 的时候量不到高度，窗口 resize 里的 fitBlockSizes() 会把结果块
  // 压成 60px 保底值。这里（右栏刚好重新显示、布局已经能量了）补一次，恢复成记忆高度。
  if (wasNoRight && !noRight) fitBlockSizes();
  return wasNoLeft !== noLeft || wasNoRight !== noRight;
}

/**
 * 用户手动设置某一侧的收展（会写进 reader.ui），然后按窗口宽度重算。
 * pin=true 表示「用户明确要展开这一侧」（活动栏 / 顶栏 ▤ 用的是这个）。
 */
function setSideCollapsed(side, collapsed, pin = false) {
  if (side === 'right' && !collapsed) hideTranslationCard();
  if (side === 'left') sideIntent.noLeft = !!collapsed;
  else sideIntent.noRight = !!collapsed;
  sideIntent.pinned[side] = !collapsed && !!pin;
  const changed = applyResponsiveLayout();
  saveUi();
  // 收起 / 展开是 display 切换，宽度瞬间到位：立刻重排就不会出现「正文停在旧尺寸」
  refitViewer(changed ? 0 : REFIT_AFTER_MS);
  if (side === 'right' && !collapsed) requestAnimationFrame(() => {
    const id = rightPanelInCol(1);
    if (id) {
      scrollBodyToBottom(id);
      requestAnimationFrame(() => scrollBodyToBottom(id));
      setTimeout(() => scrollBodyToBottom(id), 0);
    }
  });
}

/** 顶栏像 VS Code 一样提供左右栏的独立收展按钮。 */
function syncSideToggleButtons() {
  for (const side of ['left', 'right']) {
    const btn = document.getElementById(side === 'left' ? 'topbarLeftToggle' : 'topbarRightToggle');
    if (!btn) continue;
    const collapsed = document.body.classList.contains(`no-${side}`);
    const label = collapsed ? `展开${side === 'left' ? '左' : '右'}栏` : `收起${side === 'left' ? '左' : '右'}栏`;
    const icon = collapsed
      ? (side === 'left' ? 'panel-expand-left' : 'panel-expand-right')
      : (side === 'left' ? 'panel-collapse-left' : 'panel-collapse-right');
    btn.replaceChildren(iconEl(icon));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(!collapsed));
  }
}

function revealRightPanelFromToggle() {
  const last = readRightChoice() || 'chat';
  const id = PANEL_IDS_RIGHT.includes(last) ? last : 'chat';
  if (!state.panels?.[id]) return;
  sideIntent.noRight = false;          // 用户明确要这一边
  sideIntent.pinned.right = true;
  setPanelVisible(id, true);
  applyPanels();                        // 清掉 right-empty（它只在「没有可见面板」时为真）
  applyResponsiveLayout();
}

function bindSideToggleButton(side, btn) {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = document.body.classList.contains(`no-${side}`)
      || visiblePanelsOfDock(side).length === 0;
    if (collapsed && side === 'left' && visiblePanelsOfDock('left').length === 0) {
      setPanelVisible(readLeftChoice() || 'files', true);
    }
    setSideCollapsed(side, !collapsed, collapsed);
    if (side === 'right' && collapsed && rightPanelInCol(1) === '') {
      revealRightPanelFromToggle();
    }
  });
}

function initLayout() {
  const saved = readUi();
  uiStyle = { ...DEFAULT_UI_STYLE, ...(saved.style || {}) };
  applyUiStyle();
  if (saved.leftW) { sideBaseW.left = saved.leftW; document.documentElement.style.setProperty('--left-w', `${saved.leftW}px`); }
  if (saved.rightW) {
    /**
     * 存档里的宽度先按当前窗口的上限夹一下：右栏的上限随窗口变（大屏最多半屏，
     * 见 rightSideMaxW）。比如在 2560 宽的窗口上拖过 1280，换到 1920 的窗口打开时
     * 不该一上来就占掉 2/3 —— 夹到 960，本次打开按这个宽度算，存档里的原值不动。
     */
    const rightW = Math.min(saved.rightW, rightSideMaxW());
    sideBaseW.right = rightW;
    document.documentElement.style.setProperty('--right-w', `${rightW}px`);
  }
  // 只恢复「用户意图」；自动收起由 applyResponsiveLayout() 按当前窗口宽度当场算
  sideIntent.noLeft = !!saved.noLeft;
  sideIntent.noRight = !!saved.noRight;
  const dockedRightVisible = PANEL_IDS_RIGHT.some((id) => state.panels[id]?.visible && state.panels[id].dock === 'right');
  if (dockedRightVisible) {
    sideIntent.noRight = false;
    sideIntent.pinned.right = true;
  }
  applyResponsiveLayout();

  bindSideToggleButton('left', $('#topbarLeftToggle'));
  bindSideToggleButton('right', $('#topbarRightToggle'));
  syncSideToggleButtons();

  bindSplitter($('#splitLeft'), '--left-w', 150, 520, COLLAPSE_BELOW.left);
  // 右栏上限是函数：大屏幕上跟着窗口变宽（最多到窗口一半），见 rightSideMaxW
  bindSplitter($('#splitRight'), '--right-w', 240, rightSideMaxW, COLLAPSE_BELOW.right);
  initRails();

  // 窗口尺寸变化：先让「明确展开」的豁免作废（自动规则重新生效），再重算
  window.addEventListener('resize', debounce(() => {
    sideIntent.pinned.left = false;
    sideIntent.pinned.right = false;
    if (applyResponsiveLayout()) refitViewer(0);
  }, 120));
}

function initRails() {
  const targets = { files: 'files', outline: 'outline', notes: 'notes', rel: 'relations' };
  $$('#railLeft .rail-btn').forEach((btn) => {
    btn.onclick = () => {
      const id = targets[btn.dataset.rail];
      if (!id) return;
      const expanded = !document.body.classList.contains('no-left');
      const wasVisible = !!state.panels?.[id]?.visible;
      if (expanded && wasVisible) return;
      rememberLeftChoice(id);            // 点活动栏出来的就是点的这一个，并且记住它
      setSideCollapsed('left', false, true);
      setPanelVisible(id, true);         // 内部会把左栏其余三块收起（一次只开一个）
      if (id === 'relations') ensureRelationsBuilt();   // 打开「参考文献」= 按需整理的触发点
      syncRailActive();
      // 展开是 display 切换，同步量一次布局就能滚（roll 的是 .side.left 这个滚动容器）。
      // 面板正浮着的时候别去滚它 —— 浮窗是 fixed 的，滚它只会把外层容器带偏。
      if (state.panels?.[id]?.dock !== 'float') {
        const target = panelEl(id);
        if (target) target.scrollIntoView({ block: 'start' });
      }
    };
  });
  const rightBtn = $('#railRightBtn');
  function openRightPanelFromRail() {
    const last = readRightChoice() || 'chat';
    const id = PANEL_IDS_RIGHT.includes(last) ? last : 'chat';
    const p = state.panels?.[id];
    if (!p) return;
    sideIntent.noRight = false;          // 用户明确要这一边
    sideIntent.pinned.right = true;
    setPanelVisible(id, true);
    applyPanels();                        // 清掉 right-empty（它只在「没有可见面板」时为真）
    applyResponsiveLayout();
  }
  if (rightBtn) rightBtn.onclick = () => {
    if (document.body.classList.contains('right-empty')) {
      openRightPanelFromRail();
    } else {
      const id = rightPanelInCol(1) || rightPanelInCol(2) || '';
      if (id) rememberRightChoice(id);
      setSideCollapsed('right', false, true);
    }
  };
  syncRailActive();
}



const WINDOW_IPC = typeof window !== 'undefined'
  && !!window.ipc && typeof window.ipc.postMessage === 'function';

function windowAction(type, extra) {
  if (!WINDOW_IPC) return;
  try { window.ipc.postMessage(JSON.stringify({ type, ...(extra || {}) })); } catch { /* 壳没接住就算了 */ }
}

/* ------------------------------------------------------------ 全屏
   桌面壳里走窗口 IPC（tao 真正无边框全屏，盖住任务栏；退出恢复原窗口大小）；
   浏览器里降级用 Fullscreen API。进入后隐藏应用内顶栏与底栏（沉浸式），Esc 退出。 */
function fullscreenActive() {
  return !!(document.fullscreenElement || document.body.classList.contains('window-fullscreen'));
}

function applyFullscreenUi(on) {
  const active = !!on;
  document.body.classList.toggle('window-fullscreen', active);
  const btn = $('#fullscreenBtn');
  if (!btn) return;
  btn.classList.toggle('on', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  btn.title = active ? '退出全屏（Esc）' : '全屏　F11';
}

async function toggleFullscreen(force) {
  const want = force === undefined ? !fullscreenActive() : !!force;
  if (WINDOW_IPC) { windowAction('fullscreen', { on: want }); return; }
  try {
    if (want) {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      applyFullscreenUi(true);
      flashHint('已进入全屏 · 按 Esc 退出');
    } else {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      applyFullscreenUi(false);
    }
  } catch {
    // 浏览器拒绝（比如没有用户手势）不假装成功
    flashHint('当前窗口不允许全屏');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!WINDOW_IPC) applyFullscreenUi(!!document.fullscreenElement);
});

/** Rust 侧窗口状态变化时用 evaluate_script 调它（最大化图标 / 全屏沉浸式布局） */
window.__prtWindowState = (state) => {
  document.body.classList.toggle('window-maximized', !!(state && state.maximized));
  applyFullscreenUi(!!(state && state.fullscreen));
};

function initWindowChrome() {
  // 全屏按钮两种环境都要能点（浏览器里没有窗口控件，但有 Fullscreen API）
  $('#fullscreenBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFullscreen();
  });

  // 没有壳：不显示窗口控件，也不装拖动热区（浏览器里这些动作没有意义）
  if (!WINDOW_IPC) { document.body.classList.add('no-window-chrome'); return; }

  for (const btn of document.querySelectorAll('[data-window-control]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      windowAction(btn.dataset.windowControl);
    });
  }

  /* 标题区 = 顶栏上没有控件的那些地方（VS Code 的 drag-region 也是这个口径：
     按钮/输入框/链接自己在上面，其余整条可拖）。 */
  const bar = $('#topbar');
  const isChromeBlank = (t) => !(t instanceof Element)
    || !t.closest('button, input, select, textarea, a, label, [contenteditable], [data-no-drag]');
  if (bar) {
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !isChromeBlank(e.target)) return;
      e.preventDefault();
      windowAction('drag');
    });
    bar.addEventListener('dblclick', (e) => {
      if (!isChromeBlank(e.target)) return;
      e.preventDefault();
      windowAction('maximize');
    });
  }

  for (const dir of ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']) {
    const strip = el('div', { class: 'win-resize', dataset: { dir }, 'aria-hidden': 'true' });
    strip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      windowAction('resize', { dir });
    });
    document.body.append(strip);
  }

  // 窗口失焦 → 标题栏整体变淡（VS Code 的 `.titlebar.inactive > * { opacity:.6 }`）
  const syncFocus = () => document.body.classList.toggle('window-blurred', !document.hasFocus());
  window.addEventListener('focus', syncFocus);
  window.addEventListener('blur', syncFocus);
  syncFocus();
}

function initTopbar() {
  if (!$('#topbar')) return;
  document.body.classList.remove('topbar-auto', 'topbar-near');
  document.body.classList.add('topbar-static');
  const home = $('#homeBtn');
  if (home) home.onclick = () => setView('home');
  // 会话菜单（多会话）：点按钮开合，点外部/Esc 关掉
  const sessBtn = $('#sessBtn');
  if (sessBtn) {
    sessBtn.onclick = (e) => { e.stopPropagation(); toggleSessionMenu(); };
    document.addEventListener('click', (e) => {
      if (!sessionStore.open) return;
      if (e.target.closest?.('#sessBar')) return;
      closeSessionMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sessionStore.open) closeSessionMenu(); });
  }
}

/** 左栏当前该高亮哪个图标：优先「此刻真正显示着的那一块」，都没有就退回上次的选择 */
function leftActiveId() {
  const shown = PANEL_IDS.find((id) => !isRightPanel(id) && state.panels?.[id]?.dock === 'left' && state.panels[id].visible);
  return shown || readLeftChoice();
}

/** 把高亮落到图标上（aria-current 也一起，读屏能跟上） */
function syncRailActive() {
  const active = leftActiveId();
  for (const btn of $$('#railLeft .rail-btn')) {
    const id = { files: 'files', outline: 'outline', notes: 'notes', rel: 'relations' }[btn.dataset.rail];
    const on = id === active;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

function ensurePanel(id, def) {
  const p = state.panels[id];
  let node = panelEl(id);
  if (!node) {
    // 文件块：DOM 里就是左栏顶部那条 .side-head（筛选框 / 拖入区 / 文件列表是它的兄弟节点，
    // 所以收起时用 CSS 的 .side-head[data-collapsed] + 相邻兄弟规则把它们一起收起来）
    if (id === 'files') {
      node = $('#leftSide .side-head');
      if (!node) return null;
      node.classList.add('panel');
    } else {
      // 左栏三块的节点按结构位置认领（第 1 个 section.sec = 目录、第 2 个 = 笔记、
      // 第 3 个 = 参考文献）。这里不能只靠 [data-panel] 查：那段属性是本函数第一次跑时才写上去的，
      // 第一次进来时 DOM 里根本还没有这个标记，查不到就会把三个面板全漏掉、顺序也排不动。
      const idx = PANEL_DEFS.filter((d) => d.dock === 'left').findIndex((d) => d.id === id) - 1;
      if (idx >= 0) node = $$('#leftSide > section.sec')[idx] || null;
      // 右栏两块不在这里建：它们由 ensureBlock() 现建（本来就不是静态 DOM）
      if (!node) return null;
    }
  }
  node.dataset.panel = id;
  node.dataset.dock = p.dock;

  const head = panelHeadEl(id);
  if (head && !head.dataset.panelBound) {
    head.dataset.panelBound = '1';
    bindPanelHead(id, head);
    // VS Code 式操作行：✕ 隐藏
    if (!head.querySelector(':scope > .panel-actions')) head.append(panelActions(id));
  }
  // 参考文献默认只露出标题栏；标题本身就是明确入口，点击即可展开。
  // 展开这一下是「按需整理」的触发点之一（另一处是左栏活动栏的图标）：用户真的打开了
  // 这一块才去解析全文引用，打开论文本身不再后台跑一遍。
  // 其它面板保留原来的标题栏行为，避免误触改变文件/目录/笔记的布局。
  if (id === 'relations' && head && !head.dataset.relationClickBound) {
    head.dataset.relationClickBound = '1';
    head.title = '点击展开或收起参考文献';
    head.addEventListener('click', (e) => {
      if (e.target?.closest?.('button, input, select, a')) return;
      togglePanelCollapsed(id);
      if (!state.panels[id].collapsed) ensureRelationsBuilt();
    });
  }
  node.classList.toggle('hidden', !p.visible);
  node.classList.toggle('panel-collapsed', p.collapsed);
  if (p.collapsed) node.setAttribute('data-collapsed', '');
  else node.removeAttribute('data-collapsed');
  if (head) head.setAttribute('aria-expanded', String(!p.collapsed));
  // 折叠 = 把 .ai-body（可滚动的那一层）从布局里摘掉，滚动位置本来会跟着丢；记一下补回来。
  // 位置同样挂在节点自己的 __prtScrollTop 上（与 rememberBlockScroll 一套口径）。
  if (p.dock !== 'right') return node;
  const body = state.blockMeta[id]?.body;
  if (!body) return node;
  if (p.collapsed) body.__prtScrollTop = body.scrollTop;
  else if (body.__prtScrollTop > 0) body.scrollTop = body.__prtScrollTop;
  return node;
}

function bindSplitter(node, cssVar, min, max, collapseBelow) {
  if (!node) return;
  const isLeft = cssVar === '--left-w';
  const side = isLeft ? 'left' : 'right';
  /**
   * 上限允许传函数：右栏的上限跟着窗口宽度变（大屏最多半屏，见 rightSideMaxW），
   * 左栏还是常量。函数每次用到的那一刻才求值 —— 拖动途中窗口尺寸变了，
   * 也不会拿着旧上限把宽度夹回去。
   */
  const maxOf = () => (typeof max === 'function' ? max() : max);
  // 拖动 / 键盘微调 = 用户在改宽度意图，同步记进 sideBaseW。
  // （布局自动让宽走的是 document.documentElement.style.setProperty，不经过这里，
  //   所以「用户的宽度」和「这一刻生效的宽度」不会被搅在一起。）
  const setW = (px) => {
    const v = Math.round(px);
    document.documentElement.style.setProperty(cssVar, `${v}px`);
    sideBaseW[side] = v;
  };
  /**
   * 拖动时的下限：允许拖进「收起判定区」（比 min 再低一点）。
   * 否则 min=150/240 永远够不到 140/200 的阈值，4.4 就是死代码。
   * 注意这没改「展开后」的下限 —— 松手落在 [拖动下限, min) 之间会被夹回 min。
   */
  const dragFloor = Math.min(min, collapseBelow - 1);

  node.tabIndex = 0;
  node.setAttribute('role', 'separator');
  node.setAttribute('aria-orientation', 'vertical');
  node.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || min;
    const delta = (isLeft ? (e.key === 'ArrowRight' ? 16 : -16) : (e.key === 'ArrowLeft' ? 16 : -16));
    setW(clamp(current + delta, min, maxOf()));
    saveUi();
    refitViewer(REFIT_AFTER_MS);   // 宽度带过渡，等它走完再量正文
  });

  let startX = 0;
  let startW = 0;
  let dragFrame = 0;
  let pendingW = null;
  let lastDownAt = 0;      // 双击判定：两次 pointerdown 挨得很近、且位置几乎没动
  let lastDownX = 0;
  let lastToggleAt = 0;    // pointerdown 自检和原生 dblclick 只能有一个生效，别翻两次

  /** 双击分隔条 = 切换该侧收起 / 展开（用户手动行为，写 reader.ui） */
  const toggleSide = () => {
    const now = Date.now();
    if (now - lastToggleAt < 300) return;
    lastToggleAt = now;
    setSideCollapsed(side, !(side === 'left' ? sideIntent.noLeft : sideIntent.noRight));
  };

  const move = (e) => {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) lastDownAt = 0;   // 这是一次真拖动，别让下一次 pointerdown 被当成双击
    // 左栏往右拖变宽；右栏往左拖才是变宽
    const w = clamp(isLeft ? startW + dx : startW - dx, dragFloor, maxOf());
    pendingW = w;
    if (!dragFrame) dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (pendingW !== null) { setW(pendingW); pendingW = null; }
    });
    node.classList.toggle('will-collapse', w < collapseBelow);
  };
  const up = () => {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (pendingW !== null) { setW(pendingW); pendingW = null; }
    node.classList.remove('dragging', 'will-collapse');
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const finalW = cssPx(cssVar, startW);
    if (finalW < collapseBelow) {
      // 拖到阈值以下 = 用户主动把这一侧拖没了：等同手动收起，要写进 reader.ui；
      // 宽度恢复成这一侧的记忆宽度（这次拖动开始前的宽度），下次展开还是这么宽
      setW(startW);
      setSideCollapsed(side, true);
      return;
    }
    const settled = clamp(finalW, min, maxOf());
    setW(settled);
    applyResponsiveLayout();
    saveUi();
    // 只有「从收起判定区夹回 min」这种宽度真的在动的情况才需要等过渡结束
    refitViewer(Math.abs(settled - finalW) > .5 ? REFIT_AFTER_MS : 0);
  };
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // 双击：不要产生一次 0px 的拖动（虽然 0px 拖动本身不会误判成收起，但会白存一次 reader.ui）
    const now = Date.now();
    if (now - lastDownAt < 350 && Math.abs(e.clientX - lastDownX) <= 4) {
      lastDownAt = 0;
      toggleSide();
      return;
    }
    lastDownAt = now;
    lastDownX = e.clientX;
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || 240;
    node.classList.add('dragging');
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // 原生 dblclick 兜底（pointerdown 上 preventDefault 之后，各浏览器行为不完全一致）
  node.addEventListener('dblclick', (e) => { e.preventDefault(); toggleSide(); });
}

function readUi() {
  try { return JSON.parse(localStorage.getItem('reader.ui') || '{}'); } catch { return {}; }
}

/**
 * 左栏「上次选中的是哪一块」。用途只有一个：活动栏收起时，点已被选中的那个图标要能
 * 原样展开回同一块，而不是随便挑一个。所以它必须持久化，跟着 reader.ui 一起走。
 * （点活动栏里别的图标会立刻改写它；点左栏内部那块图标则会把它清空，语义交给「此刻显示谁」。）
 */
function readLeftChoice() {
  const v = readUi().leftActive;
  return ['files', 'outline', 'notes', 'relations'].includes(v) ? v : 'files';
}
function rememberLeftChoice(id) {
  if (!['files', 'outline', 'notes', 'relations'].includes(id)) return;
  try {
    const old = readUi();
    old.leftActive = id;
    localStorage.setItem('reader.ui', JSON.stringify(old));
  } catch { /* 忽略 */ }
}

/** 右栏的对应项：右侧活动栏按钮「打开一块」时用哪一块（与左栏 leftActive 对称）。 */
function readRightChoice() {
  const v = readUi().rightActive;
  return ['translate', 'chat'].includes(v) ? v : '';
}
function rememberRightChoice(id) {
  if (!['translate', 'chat'].includes(id)) return;
  try {
    const old = readUi();
    old.rightActive = id;
    localStorage.setItem('reader.ui', JSON.stringify(old));
  } catch { /* 忽略 */ }
}

function saveUi() {
  const old = readUi();
  localStorage.setItem('reader.ui', JSON.stringify({
    ...old,
    // 存用户意图的宽度（sideBaseW），不是这一刻实际生效的宽度 ——
    // 窄窗下侧栏会让宽，把让宽后的值存下来等于把用户拖好的宽度改掉（同 autoCollapse 的纪律）。
    leftW: Math.round(sideBaseW.left) || 210,
    rightW: Math.round(sideBaseW.right) || 360,
    // 只存「用户意图」：窗口太窄导致的自动收起（state.autoCollapse）不能写进来，
    // 否则窄窗用过一次之后，下次开宽窗也还是收起的
    noLeft: !!sideIntent.noLeft,
    noRight: !!sideIntent.noRight,
    // 左栏活动栏「上次选中的是哪一块」（见 readLeftChoice 的注释）
    leftActive: readLeftChoice(),
    style: { ...old.style, ...uiStyle },
  }));
}

/** 浅色主题下的纸面米白 —— 深色主题下也用它（常量必须在 applyUiStyle 之前定义） */
const PAPER_TINT_LIGHT = (v) => {
  const s = String(v || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return '#F8F1DF';
  const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
  // 太深的纸色（深色主题的 #2A2721）不能当纸面用：白纸黑字的文档一旦变成深纸黑字就没法读了
  return ((r * 299 + g * 587 + b * 114) / 1000) < 140 ? '#F8F1DF' : s;
};

function applyUiStyle() {
  const root = document.documentElement;
  const style = uiStyle;
  if (style.theme === 'system' || !['light', 'dark', 'black', 'graphite', 'mist'].includes(style.theme)) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = style.theme;
  }
  document.body.dataset.density = ['compact', 'standard', 'comfortable'].includes(style.density) ? style.density : 'standard';
  root.style.setProperty('--ai-fs', `${clamp(Number(style.fontSize) || 14, READ_FS_MIN, READ_FS_MAX)}px`);
  root.style.setProperty('--ai-lh', `${clamp(Number(style.lineHeight) || 1.72, 1.45, 2.05)}`);
  root.style.setProperty('--ai-code-fs', `${clamp(Number(style.codeSize) || 12, 10, 15)}px`);
  // 文字列宽：可以直接拖右栏里文字块的左右边沿改（见 initTextEdgeHandle），
  // 写的就是 uiStyle.maxWidth —— 夹取范围与拖动那边共用常量，不会出现「拖到 1200 却只生效 920」。
  root.style.setProperty('--ai-max-width', `${clamp(Number(style.maxWidth) || 760, TEXT_COL_MIN, TEXT_COL_MAX)}px`);
  root.style.setProperty('--ai-opacity', `${clamp(Number(style.opacity) || 1, .82, 1)}`);
  root.style.setProperty('--surface-opacity', `${clamp(Number(style.opacity) || 1, .82, 1)}`);
  // 界面尺度：--ui-fs 只带界面文字（不碰 --ai-fs，也不影响控件高度），
  // --ctl-scale 只带控件尺寸（不影响界面文字，也不影响阅读字号）
  root.style.setProperty('--ui-fs', `${uiFontSizePx(style.uiFontSize)}px`);
  root.style.setProperty('--ctl-scale', `${ctlScaleOf(style.controlSize)}`);
  const paperMode = style.paper === 'white' ? 'white' : 'tint';
  const paperTint = getComputedStyle(root).getPropertyValue('--paper-tint').trim();
  root.style.setProperty('--paper', paperMode === 'white' ? '#FFFFFF' : PAPER_TINT_LIGHT(paperTint));
  /* 双指缩放速度也得跟着 uiStyle 走。设置页改动那条路走 applyUiSettingsFromControls，
     但「恢复默认设置」是直接换 uiStyle 再 applyUiStyle() —— 两条路都要把值推给 viewer，
     否则点完「恢复默认」滑杆回到 1.0、实际手势还是旧速度。 */
  viewer?.setZoomSpeed?.(uiStyle.zoomSpeed);
  // 双页显示也跟着 uiStyle 走（点底栏按钮 / 恢复默认设置两条路都会经过这里）
  viewer?.setTwoUp?.(!!uiStyle.twoUp);
  syncTwoUpButton();
  applyMessageVisibility();
}

function applyMessageVisibility() {
  for (const node of $$('#aiArea .msg')) {
    node.querySelector('.ref')?.classList.toggle('hidden', !uiStyle.showQuote);
    node.querySelectorAll('.pg, .role .tbtn').forEach((n) => n.classList.toggle('hidden', !uiStyle.showPage));
    node.querySelectorAll('.source-details').forEach((n) => { n.open = !!uiStyle.showSources; });
    const role = node.querySelector('.role');
    if (role) role.classList.toggle('hidden', !node.querySelector('.ava, .pg, .role .tbtn'));
  }
}


function initViewer() {
  viewer = new PdfViewer($('#viewer'), {
    onPageChange: (cur, total) => {
      $('#pageInput').value = String(cur);
      $('#pageCount').textContent = String(total || 0);
      syncFootPage(cur, total);
      saveProgress();
      // 翻到别的页 = 离开引用所在页：自动清掉橙色高亮（同页内的滚动不触发这里）
      if (quoteState.page && cur !== quoteState.page) clearQuoteHighlight();
    },
    onStatus: (s) => { $('#docName')?.setAttribute('data-status', s || ''); },
    onProgress: (done, total) => {
      const busy = done < total;
      $('#pageInput')?.classList.toggle('busy', busy);
      const box = $('#pageInput');
      if (box) box.title = busy ? `正在解析 ${done}/${total} 页…` : '';
    },
    onScale: (scale) => syncZoom(scale),
    /* 双指缩放速度：开局就把存档里的值交给 viewer（触摸屏捏合的跟手倍率），
       之后设置页改动走 viewer.setZoomSpeed()。这样不依赖「先 applyUiStyle 再建 viewer」的顺序。 */
    zoomSpeed: clampZoomSpeed(uiStyle.zoomSpeed),
    twoUp: !!uiStyle.twoUp,
    onNoteClick: (id) => openNoteEditorById(id),
    /* 正文 [n] 的点击不再走 viewer 回调：热点是 pointer-events:none 的，
       点击由 initSelection 里的 mouseup 用 viewer.citeAt(x,y) 判命中后直接 handleCite()
       （见 2026-10-06「稳定选词」的说明）。 */
  });
  window.__viewer = viewer;
  window.__settings = Settings;   // 方便调试 / 自动化测试
  window.__state = state;

  /* 书签夹取（见 clampPins 的注释）：三类时机各算一次 ——
       · 横向滚动：纸面与阅读区的差值在变；
       · 阅读区尺寸变化：右栏开/关、拖分隔条、改窗口宽度都会让纸面从「放得下」变成「溢出」；
       · 书签被重画：虚拟化换页、缩放重渲染、保存笔记都会删掉重建 `.hl-pin` 节点，
         新节点同样要夹（变量在 .page 上，重建后 CSS 自动生效，这里只是补算新几何）。 */
  const viewerEl = $('#viewer');
  viewerEl.addEventListener('scroll', schedulePinClamp, { passive: true });
  window.addEventListener('resize', schedulePinClamp);
  if (window.ResizeObserver) new ResizeObserver(schedulePinClamp).observe(viewerEl);
  if (window.MutationObserver) {
    new MutationObserver(schedulePinClamp).observe(viewerEl, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
    });
  }
  // 供自动化测试直接验证「全文上下文」和「相关段落检索」这两块纯逻辑
  window.__ctx = {
    buildDocContext, pickRelevantPages, webSearch, renderScopeMenu, PICK_K, openExternal,
    alignProbe: selectionAlignProbe, clearSelectionState,
    OPS, opById, runOperation, doTranslate, doExplain, send, restoreSession, saveSessionNow,
    // 「读懂论文」：四项教学能力 + 学习档案（自动化直接点这些入口，不必去点菜单）
    TEACHING_OPS, teachingOpById, runTeaching, continueWalk, runPrereqItem, runVisual,
    openVisualPicker, detectPageObjects, pageTextOf, collectDocObjects, parsePrereqItems,
    splitPrtBlock, hideStreamTail, renderAnswerHTML, renderTeachingExtras, teachingEntryFor,
    get teaching() { return state.teaching; },
    get profile() { return profileStore.data; },
    get profileEnabled() { return profileStore.enabled; },
    profileStore, scheduleMemoryExtraction, parseMemorySuggestions,
    memoryIdle: () => learningMemory.idle(),
    // 扫描件：页型扫描 / 页图 / 图片阅读索引（自动化直接验这条链路）
    startDocProfileScan, ensureScanDigest, pickScanPages, attachPageImages, sendScopeText,
    get docProfile() { return state.docProfile; },
    set docProfile(v) { state.docProfile = v; },
    // 记忆：长期记忆 / 本篇讨论 / 会话滚动摘要（自动化验注入块与清理）
    askProfileBlock, sessionSummaryBlock, paperMemoryBlock, longTermMemoryBlock,
    scheduleSessionSummary, loadPaperMemory, isPaperMemoryOff, setPaperMemoryOff,
    get sessionSummary() { return state.sessionSummary; },
    get paperMemory() { return state.paperMemory; },
    get FULL_LIMIT() { return FULL_LIMIT; },
    jumpToPageWithHistory, jumpToDestWithHistory, returnToPreviousPosition,
    // 引用定位：〔p.N‖原文片段〕 → 跳页 + 橙色高亮 + 取消
    jumpToQuote, clearQuoteHighlight, decoratePageRefs,
    get quoteState() { return { ...quoteState }; },
    // B 线多标签工作区（P1）：标签列表 / 活动标签 / 开关 / 直接操作
    get tabs() { return tabsStore.tabs.slice(); },
    get activeTab() { return tabsStore.active; },
    get tabsEnabled() { return tabsFeatureEnabled(); },
    get pdfHotAttaches() { return pdfHotAttaches; },
    get pdfHandleCount() { return pdfHandles.size; },
    get docViewCount() { return docViews.size; },
    get currentFolderKey() { return currentFolderKey(); },
    get currentFolder() { return currentFolderPath(); },
    get chatVersion() { return chatVersion; },
    get translateSid() { return TRANSLATE_SID; },
    get lastHotTrace() { return window.__lastHotTrace || null; },
    openDoc, closeTab, activateTab, moveTab, reopenClosedTab, goWelcome,
    newSession, switchSession, deleteSession, clearCurrentSession, loadSessionList, switchFolder,
    // P2.5 Agent 读取：开关（写 localStorage）、默认值、最近一次运行统计
    get agentRead() { return agentReadEnabled(); },
    setAgentRead(on) { writeFlag('reader.agentRead', !!on); return agentReadEnabled(); },
    get agentReadDefault() { return AGENT_READ_DEFAULT; },
    get lastAgent() { return window.__lastAgent || null; },
    agentLoop: runAgentLoop, agentStats, AGENT_TOOL_SPECS,
    // A 线 P3：最近一次提示词渲染的 debug manifest（id/version/hash/tokens/trim；只读，不渲染给用户）
    get promptDebug() {
      try { return __promptDebug(); } catch { return null; }
    },
    // P1.5 引用核验：统计与降级结果（只读，自动化断言用）
    validateCitations, collectAvailablePages, formatPageList,
    get citationStats() { return lastCitationStats; },
    get citationPlan() { return activeCitationPlan ? [...activeCitationPlan.values()] : []; },
    updateSendScope, runSearch, stepHit, addToChat, addImageToChat, removeAttach,
    renderAttachments, refreshReturnButton,
    // 发送范围（脚本接口；输入框旁的芯片已移除，默认值在设置页「交互与发送」）
    setScopeRange, SCOPE_RANGES, rangeOverview, currentRange,
    get scopeRange() { return currentRange(); },
    // 结果区排布 / 滚动：译文块是 column-reverse（最近的在最上面）
    scrollToNewest, markReversedBodies,
    // 流式渲染目标（自动化造「一条已完成的结果」时走它，与真实链路同一个契约）
    streamTarget,
    // 回答存笔记：允许自动化直接验证存储结构与写入结果
    answerNoteButton, openAnswerNoteEditor, confirmAnswerNote, syncAllAnswerNoteButtons,
    addEntry, finishEntry,
    // 右栏划词：自动化直接验证「问答回答 / 译文里的选区有没有气泡、按钮集对不对」
    rightSelectionHost, onRightSelectionChanged, showBubble, hideBubble,
    // 布局常量：CSS 的 .splitter 宽度与这里的 SPLIT_W 必须一致（有断言盯着）
    SPLIT_W, VIEWER_MIN, RAIL_W,
    get highlights() { return state.highlights; },
    get uiStyle() { return uiStyle; },
    applyUiSettingsFromControls, resetSettings, fillUiSettings,
    // 面板：显隐与重启布局（自动化测试直接用这两条，不必去点界面）
    resetPanels, setPanelVisible,
    // 右栏恒为一栏：译文 / 问答的归属与「这一栏现在开着谁」
    rightColsWanted, colOf, rightPanelInCol,
    // 强制重排
    applyPanels,
    // 测试用：把「多长算太长」调小，才能在没有超长 PDF 的情况下验证索引分支
    setFullLimit(n) { FULL_LIMIT = n; },
  };

  // #returnPosition 已从顶栏删除：「返回原位置」不再占顶栏一格。
  // 逐步回退阅读位置这个能力仍然保留（引用跳转、目录跳转都还在用 jumpToPageWithHistory），
  // 只是不再有那个显式按钮 —— 所以这里用可选链，元素不在也不会抛。
  const retBtn = $('#returnPosition');
  if (retBtn) retBtn.onclick = () => returnToPreviousPosition();

  $('#footPrevPage').onclick = () => viewer.stepPage(-1);
  $('#footNextPage').onclick = () => viewer.stepPage(1);
  $('#footZoomIn').onclick = () => viewer.setScale(viewer.scale * 1.15);
  $('#footZoomOut').onclick = () => viewer.setScale(viewer.scale / 1.15);
  $('#footFitWidth').onclick = () => viewer.fitWidth();
  const twoUpBtn = $('#footTwoUp');
  if (twoUpBtn) {
    twoUpBtn.onclick = () => {
      uiStyle = { ...uiStyle, twoUp: !uiStyle.twoUp };
      saveUi();
      applyUiStyle();
    };
  }

  $('#pageInput')?.addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!Number.isNaN(n)) viewer.goToPage(n);
    else e.target.value = String(viewer.current);
  });
  $('#pageInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  const range = $('#zoomRange');
  if (range) {
    range.addEventListener('input', () => viewer.previewScale(Number(range.value) / 100));
    range.addEventListener('change', () => viewer.commitZoomPreview());
    range.addEventListener('pointerup', () => viewer.commitZoomPreview());
    range.addEventListener('blur', () => viewer.commitZoomPreview());
    range.addEventListener('dblclick', () => viewer.fitWidth());
  }

  let pinchPixels = 0;
  let pinchPoint = null;
  let pinchPdf = null;
  let pinchFrame = 0;
  const flushPinch = () => {
    pinchFrame = 0;
    if (!viewer?.pdf || viewer.pdf !== pinchPdf || !pinchPixels) return;
    // Apply the full gesture in the next display frame. No easing or trailing animation.
    const pixels = pinchPixels;
    pinchPixels = 0;
    const speed = clampZoomSpeed(uiStyle.zoomSpeed);
    viewer.zoomAt(viewer.scale * Math.exp(-pixels * 0.0022 * speed), pinchPoint.x, pinchPoint.y);
  };
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!viewer?.pdf || !viewer.container.contains(e.target)) return;
    // Touchpads send Ctrl+wheel for pinch. Ordinary two-finger wheel stays native scrolling.
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewer.container.clientHeight : 1);
    if (viewer.pdf !== pinchPdf) pinchPixels = 0;
    pinchPdf = viewer.pdf;
    pinchPixels += pixels;
    pinchPoint = { x: e.clientX, y: e.clientY };
    if (!pinchFrame) pinchFrame = requestAnimationFrame(flushPinch);
  }, { capture: true, passive: false });
}

function refreshReturnButton() {
  // 顶栏那个「返回原位置」按钮已删除，所以这里没有按钮可刷 —— 直接返回。
  // 保留函数本身：__ctx 仍导出它、跳转历史（state.jumpHistory）仍由 recordReaderJump 维护，
  // 测试与将来的入口都还能用。
  const button = $('#returnPosition');
  if (!button) return;
  const stack = state.doc ? state.jumpHistory.get(state.doc.docId) || [] : [];
  button.classList.toggle('hidden', !viewer?.pdf || state.viewerDocId !== state.doc?.docId || !stack.length);
  button.title = stack.length > 1
    ? `逐步返回之前的 ${stack.length} 个阅读位置`
    : '返回跳转前的阅读位置';
}

function recordReaderJump() {
  const docId = state.doc?.docId;
  if (!docId || state.viewerDocId !== docId || !viewer?.pdf) return;
  const stack = state.jumpHistory.get(docId) || [];
  stack.push({ docId, ...viewer.capturePosition() });
  if (stack.length > 50) stack.shift();
  state.jumpHistory.set(docId, stack);
  refreshReturnButton();
}

function pageJumpWouldMove(page) {
  const target = clamp(Math.round(Number(page) || 1), 1, viewer?.numPages || 1);
  const top = Number(viewer?.offsets?.[target]);
  const currentTop = Number(viewer?.container?.scrollTop || 0);
  return viewer?.current !== target || !Number.isFinite(top) || Math.abs(currentTop - top) > 4;
}

async function jumpToPageWithHistory(page, options = {}) {
  if (!viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  if (pageJumpWouldMove(page)) recordReaderJump();
  return viewer.goToPage(page, options);
}

async function jumpToDestWithHistory(dest, options = {}) {
  if (!viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  recordReaderJump();
  return viewer.goToDest(dest, options);
}

async function returnToPreviousPosition() {
  const docId = state.doc?.docId;
  const stack = docId ? state.jumpHistory.get(docId) : null;
  if (!stack?.length || !viewer?.pdf || state.viewerDocId !== docId) return;
  const previous = stack.pop();
  if (previous.docId !== state.doc?.docId) return;
  await viewer.restorePosition(previous);
  refreshReturnButton();
}

function syncFootPage(cur, total) {
  const box = $('#pageInput');
  const tot = $('#pageCount');
  if (box && cur != null) box.value = String(cur);
  if (tot && total != null) tot.textContent = String(total || 0);
}

function syncZoom(scale) {
  const pct = Math.round(scale * 100);
  const lbl = $('#zoomLabel');
  if (lbl) lbl.textContent = `${pct}%`;
  const r = $('#zoomRange');
  if (r && document.activeElement !== r) r.value = String(clamp(pct, Number(r.min), Number(r.max)));
}

/** 底栏「双页显示」按钮的状态（是否选中 + 无障碍状态 + 提示文案） */
function syncTwoUpButton() {
  const btn = $('#footTwoUp');
  if (!btn) return;
  const on = !!uiStyle.twoUp;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? '切换为单页显示' : '双页显示');
  btn.title = on ? '切换为单页显示' : '双页显示（两页并排）';
}


async function loadServerState() {
  try {
    const r = await fetch('/api/state');
    if (r.ok) serverState = await r.json();
  } catch { serverState = {}; }
}

const saveProgress = debounce(async () => {
  if (!state.doc || !viewer) return;
  const docs = { ...(serverState.docs || {}) };
  docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
  serverState = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
  try {
    const r = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverState),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    toastAction('阅读进度保存失败，当前进度仍在内存中。', '重试', () => saveProgressNow(), 'err', 10000);
  }
}, 500);

async function saveProgressNow() {
  if (!state.doc || !viewer) return;
  const docs = { ...(serverState.docs || {}) };
  docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
  const payload = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
  const r = await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  serverState = payload;
  toast('阅读进度已保存', 'ok');
}

function setView(view) {
  const home = view === 'home';
  document.body.classList.toggle('reading', !home);
  $('#home')?.classList.toggle('hidden', !home);
  syncFootEnabled(!home);
  if (!home) return;
  // 首页是书架 / 目录，不需要两侧阅读工具栏；进入时自动让正文占满窗口。
  setSideCollapsed('left', true);
  setSideCollapsed('right', true);
  state.homeReady = true;
  renderHome();
}

function syncFootEnabled(on) {
  const usable = !!on && !!viewer?.pdf && state.viewerDocId === state.doc?.docId;
  for (const id of ['footPrevPage', 'footNextPage', 'footZoomIn', 'footZoomOut', 'footFitWidth', 'pageInput', 'zoomRange']) {
    const node = document.getElementById(id);
    if (node) node.disabled = !usable;
  }
}

/** 相对时间：首页每行只给「刚看过 / N 分钟前 / N 小时前 / N 天前」 */
function relTime(ts) {
  const ms = Date.now() - (Number(ts) || 0);
  if (!Number.isFinite(ms) || ms < 0) return '刚看过';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚看过';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 阅读记录（state.json 的 docs）→ 首页要用的行。
 * 按 ts 倒序；只保留 papers/ 里还在的文件 —— 被移走 / 删掉的记录不出现在首页，
 * 也不留死链接（对应设计里的状态 5）。
 */
function recentDocs() {
  const docs = serverState.docs || {};
  const byId = new Map((state.papers || []).map((p) => [p.docId, p]));
  const rows = [];
  for (const [docId, rec] of Object.entries(docs)) {
    const paper = byId.get(docId);
    if (!paper) continue;
    rows.push({
      docId,
      rec,
      name: paper.name,
      url: paper.url,
      page: Math.max(1, Number(rec?.page) || 1),
      ts: Number(rec?.ts) || 0,
    });
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}

/** 移除一条阅读记录（只删记录，**不删 papers/ 里的文件**） */
async function removeRecent(docId) {
  const file = (serverState.docs || {})[docId]?.name || '这条记录';
  try {
    const r = await fetch(`/api/state?doc=${encodeURIComponent(docId)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const nextDocs = { ...(serverState.docs || {}) };
    delete nextDocs[docId];
    serverState = { ...serverState, docs: nextDocs };
    if (serverState.lastDoc === docId) {
      serverState = { ...serverState, lastDoc: null, lastUrl: null, lastName: null };
    }
    renderHome();
    toast(`已移除「${file}」的最近记录（文件还在 papers/）`, 'ok', 2600);
  } catch (e) {
    toast(`移除失败：${e.message}`, 'err', 4000);
  }
}

/**
 * 渲染首页。数据源是 `serverState.docs`（阅读记录），不是 `state.papers` ——
 * 左栏 `renderPaperList()` 管的是「磁盘上有什么」，首页管的是「我读到哪了」。
 * 两者共用同一个 `openDoc()` 出口。
 */
function renderHome() {
  const list = $('#homeList');
  const contWrap = $('#homeContinueWrap');
  if (!list || !contWrap) return;
  const rows = recentDocs();
  const title = $('#homeRecentTitle');

  // ── 继续阅读卡片：只在「确实有一篇可以接着读」时出现 ──
  contWrap.replaceChildren();
  const last = rows.find((r) => r.docId === serverState.lastDoc) || rows[0];
  if (last) {
    const go = el('button', { type: 'button', class: 'home-continue', 'aria-label': `继续阅读「${last.name}」，从第 ${last.page} 页开始` },
      el('span', { class: 'hc-main' },
        el('span', { class: 'hc-label', text: '继续阅读' }),
        el('span', { class: 'hc-name', text: last.name.replace(/\.pdf$/i, ''), title: last.name }),
        el('span', { class: 'hc-meta', text: `第 ${last.page} 页 · ${relTime(last.ts)}` })),
      el('span', { class: 'hc-go' }, '继续 →'));
    go.onclick = () => openDoc({ name: last.name, url: last.url, docId: last.docId });
    contWrap.append(go);
  }

  // ── 书架：**按文件夹分组**列出 papers 里全部论文（用户口径：不要全部散着铺开） ──
  list.replaceChildren();
  const allPapers = state.papers || [];
  if (title) title.textContent = allPapers.length ? `书架（按文件夹，共 ${allPapers.length} 篇）` : '书架';
  if (!allPapers.length) {
    list.append(el('li', { class: 'home-empty' },
      el('div', { text: '还没有论文' }),
      el('div', { class: 'home-empty-sub', text: '点「打开 PDF」选一个，或直接把 PDF 拖进来' })));
    return;
  }
  const recById = new Map(rows.map((r) => [r.docId, r]));
  const groups = [];
  const rootFiles = allPapers.filter((p) => !p.folder);
  if (rootFiles.length) groups.push({ path: '', name: 'papers/', files: rootFiles });
  for (const f of (state.folders || [])) {
    const files = allPapers.filter((p) => p.folder === f.path);
    if (files.length) groups.push({ path: f.path, name: f.name, files });
  }
  // 兜底：papers 的 folder 不在 folders 清单里（理论上不会）→ 归到「其它」
  const grouped = new Set(groups.flatMap((g) => g.files));
  const restFiles = allPapers.filter((p) => !grouped.has(p));
  if (restFiles.length) groups.push({ path: '?', name: '其它', files: restFiles });
  for (const group of groups) {
    const depth = group.path && group.path !== '?' ? group.path.split('/').length - 1 : 0;
    list.append(el('li', {
      class: 'home-folder',
      style: `--depth:${depth}`,
      title: group.path === '?' ? '其它' : `papers/${group.path ? `${group.path}/` : ''}（${group.files.length} 篇）`,
    },
    el('span', { class: 'hf-ico', 'aria-hidden': 'true', html: FOLDER_ICON_SVG }),
    el('span', { class: 'hf-name', text: group.name }),
    el('span', { class: 'hf-count', text: String(group.files.length) })));
    for (const paper of group.files) {
      const rec = recById.get(paper.docId);
      const page = rec ? Math.max(1, Number(rec.page) || 1) : 0;
      const meta = rec ? `第 ${page} 页 · ${relTime(rec.ts)}` : '未读';
      const item = el('li', { class: 'home-item', dataset: { id: paper.docId }, style: `--depth:${depth}` },
        el('button', { type: 'button', class: 'home-item-go', title: paper.name },
          el('span', { class: 'hi-name', text: paper.name.replace(/\.pdf$/i, '') }),
          el('span', { class: 'hi-meta', text: meta })),
        rec ? el('button', {
          type: 'button', class: 'home-item-x', text: '×',
          title: `移除「${paper.name}」的最近记录（不删除文件）`,
          'aria-label': `移除「${paper.name}」的最近记录`,
          onclick: (e) => { e.stopPropagation(); removeRecent(paper.docId); },
        }) : null);
      item.querySelector('.home-item-go').onclick = () => openDoc({ name: paper.name, url: paper.url, docId: paper.docId, path: paper.path });
      list.append(item);
    }
  }
}

const FOLDER_OPEN_KEY = 'prt.folderOpen.v1';
function loadFolderOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDER_OPEN_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveFolderOpen() {
  try { localStorage.setItem(FOLDER_OPEN_KEY, JSON.stringify([...state.folderOpen])); } catch { /* 忽略 */ }
}

async function refreshPaperList() {
  try {
    const r = await fetch('/api/papers');
    if (r.ok) {
      const j = await r.json();
      state.papers = j.papers || [];
      state.folders = j.folders || [];
    } else { state.papers = []; state.folders = []; }
  } catch { state.papers = []; state.folders = []; }
  renderPaperList();
  renderFolderSwitch();
}

const PAPER_GRIP_SVG = '<svg viewBox="0 0 24 24" width="10" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
const PAPER_X_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/></svg>';
/* 文件夹行图标：线性风格与全站 SVG 一致（stroke 1.8，currentColor） */
const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M3.4 6.6a1.7 1.7 0 0 1 1.7-1.7h4.1l2.2 2.5h7.5a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H5.1a1.7 1.7 0 0 1-1.7-1.7Z"/></svg>';
const FOLDER_ARROW_OPEN_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6.5 9.2 5.5 5.6 5.5-5.6"/></svg>';
const FOLDER_ARROW_CLOSED_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.2 6.5 14.8 12 9.2 17.5"/></svg>';

/** 一个 PDF 行；flat=true 表示筛选扁平视图（名称前缀所在文件夹） */
function paperRow(p, flat) {
  const display = (flat && p.folder ? `${p.folder}/${p.name}` : p.name).replace(/\.pdf$/i, '');
  const path = p.path || p.name;
  const li = el('li', {
    title: `${flat && p.folder ? p.folder + '/' : ''}${p.name}\n${fmtSize(p.size)}\n按住拖动：同目录调整顺序，拖到文件夹行移入；Ctrl/Shift 点击可多选`,
    dataset: { id: p.docId, name: p.name, path },
    draggable: 'true',
    onclick: (e) => {
      if (e.target.closest?.('.file-row-x, .file-grip')) return;
      // Ctrl/⌘ 点：加选/取消；Shift 点：从锚点整段选（都不会打开论文）
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleFileSelection(path); return; }
      if (e.shiftKey) { e.preventDefault(); selectFileRangeTo(path); return; }
      if (state.fileSel.size) clearFileSelection();
      openDoc({ name: p.name, url: p.url, docId: p.docId, path });
    },
  },
    // 左侧细条 = 框选起点（文件管理器式：按住拖出矩形批量选文件）
    el('span', { class: 'file-grip', title: '按住拖动框选多个文件', 'aria-hidden': 'true', html: PAPER_GRIP_SVG }),
    el('span', { class: 'file-name', text: display }),
    el('button', {
      type: 'button', class: 'file-row-x', html: PAPER_X_SVG,
      title: `删除「${p.name}」（只删 papers/ 里的这个文件）`,
      'aria-label': `删除「${p.name}」`,
      onclick: (e) => { e.stopPropagation(); deletePaper(p); },
    }));
  if (state.doc?.docId === p.docId) li.classList.add('active');
  if (state.fileSel.has(path)) li.classList.add('selected');
  return li;
}

/**
 * 渲染某一层的子项（顺序完全由服务端 papers-order 决定；文件夹与 PDF 都不在前端重排，
 * 用户口径：左侧文件夹里的文档不做自动排序）。
 * 返回 DocumentFragment；无任何子项返回 null。
 */
function renderTreeLevel(folderPath, depth) {
  const prefix = folderPath ? `${folderPath}/` : '';
  const subs = (state.folders || []).filter((f) => {
    if (folderPath === '') return !f.path.includes('/');
    return f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/');
  });
  const pdfs = (state.papers || []).filter((p) => p.folder === folderPath);
  if (!subs.length && !pdfs.length) return null;

  const frag = document.createDocumentFragment();
  for (const f of subs) {
    const open = state.folderOpen.has(f.path);
    const li = el('li', {
      class: 'folder',
      dataset: { folder: f.name, path: f.path },
      draggable: 'true',
    },
      el('span', {
        class: 'folder-arrow', 'aria-hidden': 'true',
        html: open ? FOLDER_ARROW_OPEN_SVG : FOLDER_ARROW_CLOSED_SVG,
        onclick: (e) => { e.stopPropagation(); toggleFolder(f.path); },
      }),
      el('span', { class: 'folder-ico', 'aria-hidden': 'true', html: FOLDER_ICON_SVG }),
      el('span', {
        class: 'folder-name', text: f.name,
        title: `${f.path}（${f.count} 篇 PDF）`,
        ondblclick: (e) => { e.stopPropagation(); startInlineRename(f.path, f.name); },
      }),
      el('span', { class: 'folder-count', text: f.count ? String(f.count) : '' }));
    frag.append(li);
    if (open) {
      const sub = renderTreeLevel(f.path, depth + 1);
      if (sub) {
        const ul = el('ul', { class: 'folder-children', dataset: { parent: f.path } });
        ul.append(sub);
        frag.append(ul);
      }
    }
  }
  for (const p of pdfs) frag.append(paperRow(p, false));
  return frag;
}

function toggleFolder(path) {
  if (state.folderOpen.has(path)) state.folderOpen.delete(path);
  else state.folderOpen.add(path);
  saveFolderOpen();
  renderPaperList();
}

function renderPaperList() {
  const list = $('#fileList');
  if (!list) return;
  const filter = ($('#fileFilter').value || '').trim().toLowerCase();
  list.innerHTML = '';

  if (filter) {
    // 筛选激活：扁平过滤结果（每行前缀显示所在文件夹），库内拖拽由 bindPaperDrag 禁用
    const hits = (state.papers || []).filter((p) => p.name.toLowerCase().includes(filter));
    if (!hits.length) {
      list.append(el('li', {
        class: 'empty',
        text: state.papers.length ? '没有匹配的文件' : 'papers/ 里还没有 PDF',
      }));
      syncFileSelection();
      return;
    }
    for (const p of hits) list.append(paperRow(p, true));
    syncFileSelection();
    return;
  }

  const frag = renderTreeLevel('', 0);
  if (!frag) {
    list.append(el('li', { class: 'empty', text: 'papers/ 里还没有 PDF' }));
    syncFileSelection();
    return;
  }
  list.append(frag);
  syncFileSelection();
}

/* ───────────────── 文件列表：批量导入 / 拖拽排序 / 删除（2026-10） ───────────────── */

/** 从 FileList / DataTransfer 里挑出 PDF（大小写不敏感） */
function pdfFilesFrom(files) {
  return Array.from(files || []).filter((f) => f && /\.pdf$/i.test(f.name));
}

/* ───────────────── 文件列表：多选（Ctrl/Shift 点击、左侧细条拖框）+ 批量操作 ───────────────── */

function fileRowPath(li) { return li?.dataset?.path || li?.dataset?.name || ''; }
/** 当前可见的 PDF 行（筛选/文件夹展开后的 DOM 顺序） */
function fileSelRows() { return $$('#fileList li[data-path]:not(.folder)'); }

function syncFileSelection() {
  for (const li of fileSelRows()) li.classList.toggle('selected', state.fileSel.has(fileRowPath(li)));
  document.body.classList.toggle('files-multi', state.fileSel.size > 0);
}

function clearFileSelection() {
  if (!state.fileSel.size) return;
  state.fileSel.clear();
  state.fileSelAnchor = null;
  syncFileSelection();
}

function setFileSelection(paths, { anchor = null } = {}) {
  state.fileSel = new Set(paths.filter(Boolean));
  if (anchor !== null) state.fileSelAnchor = anchor;
  syncFileSelection();
}

function toggleFileSelection(path) {
  if (!path) return;
  if (state.fileSel.has(path)) state.fileSel.delete(path);
  else state.fileSel.add(path);
  state.fileSelAnchor = path;
  syncFileSelection();
}

/** Shift+点击：从锚点到这一行的可见范围整段选中（只选 PDF，文件夹不参与批量操作） */
function selectFileRangeTo(path) {
  const rows = fileSelRows();
  const to = rows.findIndex((li) => fileRowPath(li) === path);
  if (to < 0) return;
  let from = rows.findIndex((li) => fileRowPath(li) === state.fileSelAnchor);
  if (from < 0) from = to;
  const [a, b] = from <= to ? [from, to] : [to, from];
  setFileSelection(rows.slice(a, b + 1).map(fileRowPath), { anchor: state.fileSelAnchor || path });
}

/** 批量删除所选 PDF（只删 papers/ 文件；笔记 / 会话保留） */
async function deleteSelectedFiles() {
  const paths = [...state.fileSel];
  if (!paths.length) return;
  if (!confirm(`删除所选的 ${paths.length} 个 PDF？\n只删 papers/ 里的文件，笔记和会话保留。`)) return;
  let ok = 0;
  let failed = 0;
  for (const rel of paths) {
    try {
      const r = await fetch(`/api/papers?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
      if (r.ok) ok += 1; else failed += 1;
    } catch { failed += 1; }
  }
  clearFileSelection();
  await refreshPaperList();
  toast(`已删除 ${ok} 个文件${failed ? `（${failed} 个失败）` : ''}`, failed ? 'err' : 'ok', 3200);
}

/** 批量移动所选 PDF 到某个文件夹（''=根目录） */
async function moveSelectedFiles(to) {
  const paths = [...state.fileSel];
  if (!paths.length) return;
  await moveFilesTo(paths, to);
}

/**
 * 框选多个文件（文件管理器式）：
 *  - 按住某一行**左侧的细条**（.file-grip）拖动，或从列表空白处拖动，拉出矩形；
 *  - 矩形碰到的 PDF 行即被选中（按住 Ctrl/⌘ 是追加选择）；
 *  - 选好后右键 / Delete 做批量删除、批量移动。
 */
function initFileMarquee() {
  const box = el('div', { class: 'file-marquee hidden' });
  document.body.append(box);
  let start = null;

  const hitRow = (rect, row) => {
    const r = row.getBoundingClientRect();
    return r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
  };
  const update = (x, y) => {
    const left = Math.min(start.x, x);
    const top = Math.min(start.y, y);
    const w = Math.abs(x - start.x);
    const h = Math.abs(y - start.y);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    const rect = { left, top, right: left + w, bottom: top + h };
    const picked = start.base.slice();
    for (const row of fileSelRows()) if (hitRow(rect, row)) picked.push(fileRowPath(row));
    const unique = [...new Set(picked)];
    setFileSelection(unique, { anchor: state.fileSelAnchor || unique[0] || null });
  };
  const finish = () => {
    if (!start) return;
    const moved = Math.hypot(start.lastX - start.x, start.lastY - start.y) > 3;
    start = null;
    box.classList.add('hidden');
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (!moved) {
      // 只是点了一下细条/空白：不当作「点到别处」，否则会把之前的选择清掉
      state._fileMarqueeJustEnded = true;
      setTimeout(() => { state._fileMarqueeJustEnded = false; }, 0);
    }
  };
  const onMove = (e) => {
    if (!start) return;
    e.preventDefault();
    start.lastX = e.clientX;
    start.lastY = e.clientY;
    update(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    if (!start) return;
    e.preventDefault();
    update(e.clientX, e.clientY);
    finish();
  };

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!e.target.closest?.('#fileList')) return;
    const grip = e.target.closest?.('.file-grip');
    const row = e.target.closest?.('li');
    if (row && !grip) return;            // 点在行体上：交给点击打开 / 拖拽排序
    e.preventDefault();                  // 细条或空白：开始框选，并阻止原生拖拽
    const additive = e.ctrlKey || e.metaKey;
    start = {
      x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
      base: additive ? [...state.fileSel] : [],
    };
    if (!additive) clearFileSelection();
    state._fileMarqueeJustEnded = false;
    box.classList.remove('hidden');
    box.style.left = `${e.clientX}px`;
    box.style.top = `${e.clientY}px`;
    box.style.width = '0px';
    box.style.height = '0px';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }, true);

  // 框选结束浏览器还会补一个 click：别让它把刚选中的结果清掉
  document.addEventListener('click', (e) => {
    if (!state._fileMarqueeJustEnded) return;
    if (e.target.closest?.('#fileList')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // 点列表以外 / 右键菜单以外 → 清空多选
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest?.('#fileList') || e.target.closest?.('#fileCtx')) return;
    clearFileSelection();
  }, true);
  // Esc 清空多选；Delete 批量删除
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.fileSel.size) { clearFileSelection(); return; }
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName || '') || e.target.isContentEditable;
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && state.fileSel.size) {
      e.preventDefault();
      deleteSelectedFiles();
    }
  });
}

function initFiles() {
  document.body.dataset.jsVer = '20261031-dnd';
  const dz = $('#dropzone');
  $('#fileFilter').addEventListener('input', debounce(renderPaperList, 150));
  $('#folderNew')?.addEventListener('click', () => startInlineCreate(''));
  // 多选：一次选多个 PDF 一起导入（原来只取 files[0]）
  $('#fileInput').addEventListener('change', (e) => {
    const pdfs = pdfFilesFrom(e.target.files);
    e.target.value = '';
    if (pdfs.length) importLocalFiles(pdfs);
  });
  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      dz.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    if (!isExternalFileDrag(e)) return;   // 内部拖动排序：交给文件列表自己处理
    e.preventDefault();
    importExternalDrop(e.dataTransfer, '');
  });
  /**
   * 全页面拖拽接管（document 捕获阶段）。
   *
   * 只拦 dragover 是不够的：光标**刚进入**一个新元素时浏览器先派发 dragenter，
   * 如果 dragenter 没被 preventDefault，Chrome 在那一帧会显示「禁止圆环」，
   * 紧接着下一帧 dragover 被接管又变回 move —— 拖动经过一行行文件/文件夹时看起来就是一直闪。
   * 这里在捕获阶段同时接管 dragenter 和 dragover（捕获阶段先于任何 stopPropagation），
   * 任何位置、任何拖拽类型都 preventDefault 并显式设置 dropEffect，代码层面不留 no-drop 帧。
   */
  const acceptAnyDrag = (e) => {
    e.preventDefault();
    try {
      const dt = e.dataTransfer;
      if (!dt) return;
      // 内部移动 move；外部文件 copy；其他类型（拖文字等）也给 move，避免落到 none
      dt.dropEffect = isInternalPrtDrag(e) ? 'move' : (isExternalFileDrag(e) ? 'copy' : 'move');
    } catch { /* dropEffect 在个别环境只读，忽略 */ }
  };
  for (const type of ['dragenter', 'dragover']) document.addEventListener(type, acceptAnyDrag, true);
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return; // 已被文件列表 / 拖入区 / 左栏兜底处理，避免重复
    // 内部拖拽的 drop 只由 #fileList / #leftSide 自己处理；窗口级只接「从资源管理器拖进来」。
    // 这里再兜一次内部 drop，会把文件夹里正常排序的文件误当成「拖到左栏外」移到根目录。
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    importExternalDrop(e.dataTransfer, '');
  });

  $('#homeOpen')?.addEventListener('click', () => $('#fileInput')?.click());
  const drop = $('#homeDrop');
  if (drop) {
    for (const ev of ['dragenter', 'dragover']) {
      drop.addEventListener(ev, (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        drop.classList.add('over');
      });
    }
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
    // 拖放区只处理拖入，不再绑定点击打开文件选择器。
    // 「打开 PDF」是唯一的点击选文件入口，两个入口保持明确分工。
  }

  bindPaperDrag($('#fileList'));
  initFileMarquee();
  initFileContextMenu();

  // 左栏拖拽接管（与 #fileList 处理「完全连起来」）：内部拖拽经过左栏任意位置
  // 都 preventDefault + move 光标，彻底消除 no-drop 圆环闪现。
  // #fileList 内的高亮/排序/移入由 bindPaperDrag 自己处理（子元素事件先到，已 preventDefault，
  // 冒泡到这里再防一次无害）；列表之外（拖入区/面板头/目录笔记等）落到 drop 统一视为移到根。
  $('#leftSide').addEventListener('dragover', (e) => {
    if (!isInternalPrtDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  $('#leftSide').addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;          // 列表内 drop 已处理（并 stopPropagation 兜底）
    if (e.target.closest?.('#fileList')) return; // 列表内的 drop 已由 bindPaperDrag 处理
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer?.getData(PRT_DRAG_MIME) || 'null'); } catch { /* 忽略 */ }
    if (!payload) return;
    e.preventDefault();
    if (payload.kind === 'files') { moveFilesTo(payload.paths, ''); return; }
    moveItem(payload.path, '');
  });
}

/** 内部拖拽数据 MIME：与外部文件拖入（Files）严格区分 */
const PRT_DRAG_MIME = 'application/x-prt-paper';

/** 是否为项目内部拖拽（左栏文件/文件夹之间的移动/排序） */
function isInternalPrtDrag(e) {
  try { return Array.from(e.dataTransfer?.types || []).includes(PRT_DRAG_MIME); } catch { return false; }
}

function dragPayload(e) {
  try {
    const raw = e.dataTransfer?.getData(PRT_DRAG_MIME);
    if (raw) return JSON.parse(raw);
  } catch { /* 忽略 */ }
  return null;
}

/** 是不是「从资源管理器拖文件/文件夹进来」——内部拖拽（PRT_DRAG_MIME）不算 */
function isExternalFileDrag(e) {
  try {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes('Files') && !types.includes(PRT_DRAG_MIME);
  } catch {
    return false;
  }
}

/** 相对路径里取所在文件夹（''=根） */
function folderOf(relPath) {
  const i = String(relPath || '').lastIndexOf('/');
  return i >= 0 ? relPath.slice(0, i) : '';
}

/** 拖放落点：命中展开文件夹的子区 → 移入该文件夹；否则根 */
function dropTargetFolder(e) {
  const ul = e.target.closest?.('ul.folder-children[data-parent]');
  return ul ? ul.dataset.parent : '';
}

function bindPaperDrag(list) {
  if (!list) return;
  let from = null; // { path, kind }
  let startPt = null; // 拖拽起点（判断「轻轻一拖」用）
  const clearMarks = () => {
    for (const n of list.querySelectorAll('li')) {
      n.classList.remove('dragging', 'drop-before', 'drop-after', 'folder-target', 'drag-no');
    }
    list.classList.remove('root-target');
  };

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('li[data-path], li[data-name]');
    if (!li) return;
    if (e.target.closest?.('.file-row-x')) { e.preventDefault(); return; }
    const filterActive = ($('#fileFilter').value || '').trim() !== '';
    if (filterActive) {
      e.preventDefault();
      toast('请先清空筛选，再进行拖拽排序/移动', 'err', 3600);
      return;
    }
    const path = li.dataset.path || li.dataset.name || '';
    if (!path) return;
    const kind = li.classList.contains('folder') ? 'folder' : 'file';
    // 拖的是「已框选/多选」里的文件 → 整组一起拖（否则只拖这一行）
    const group = kind === 'file' && state.fileSel.has(path) && state.fileSel.size > 1
      ? [...state.fileSel]
      : null;
    from = { path, kind, paths: group };
    startPt = { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
    li.classList.add('dragging');
    for (const other of list.querySelectorAll('li.selected')) other.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(PRT_DRAG_MIME, JSON.stringify(group ? { kind: 'files', paths: group } : { path, kind }));
      e.dataTransfer.setData('text/plain', path);
    } catch { /* 忽略 */ }
  });
  list.addEventListener('dragend', () => { from = null; startPt = null; clearMarks(); });

  list.addEventListener('dragover', (e) => {
    // 无条件 preventDefault + 显式 dropEffect：fileList 内部任何位置都不弹 no-drop。
    // （与左栏兜底、window 兜底三级连成一片，整个页面任意坐标都不会出现禁止圆环）
    e.preventDefault();
    const internal = isInternalPrtDrag(e);
    e.dataTransfer.dropEffect = (internal || from) ? 'move' : 'copy';
    if (!internal && !from && !isExternalFileDrag(e)) return; // 无关拖拽：仅 preventDefault，不渲染高亮
    clearMarks();
    // 1. 文件夹行 → 移入该文件夹
    const folderLi = e.target.closest?.('li.folder[data-path]');
    if (folderLi) {
      if (from?.kind === 'folder'
        && (from.path === folderLi.dataset.path || folderLi.dataset.path.startsWith(`${from.path}/`))) {
        folderLi.classList.add('drag-no'); // 禁区：自身/子孙
      } else {
        folderLi.classList.add('folder-target');
      }
      return;
    }
    // 2. PDF 行
    const li = e.target.closest?.('li[data-path]:not(.folder)');
    if (li) {
      if (from?.kind === 'file') {
        if (folderOf(from.path) === folderOf(li.dataset.path)) {
          // 同目录 → 排序插入线
          const r = li.getBoundingClientRect();
          li.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
        } else {
          li.classList.add('folder-target'); // 跨目录 → 移入该行所在文件夹
        }
      } else {
        li.classList.add('folder-target');
      }
      return;
    }
    // 3. 根区域空白
    list.classList.add('root-target');
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearMarks();
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 关键：drop 处理完要 stopPropagation。#fileList 里的排序会同步重绘列表，
    // 等事件冒泡到 #leftSide / window 时 e.target 已经脱离 DOM，closest('#fileList') 判不出来，
    // 会被当成「拖到左栏外」→ 把文件移到根目录（用户实测：文件夹里拖动排序，文件却跑到根目录）。
    e.stopPropagation();
    const payload = dragPayload(e);
    clearMarks();
    if (!payload && !isExternalFileDrag(e)) return;
    const filterActive = ($('#fileFilter').value || '').trim() !== '';
    if (filterActive) { toast('请先清空筛选，再进行拖拽排序/移动', 'err', 3600); return; }

    // 外部拖入（资源管理器）
    if (!payload) {
      const target = dropTargetFolder(e);
      return importExternalDrop(e.dataTransfer, target);
    }

    // 内部拖拽。先看落点是不是「文件行」——文件夹里的文件互相拖是排序，
  // 不能因为 ul.folder-children[data-parent] 把落点算成「自己所在的文件夹」而提前 return
  //（用户实测：文件夹里的文件根本拖不动）。
    const rowLi = e.target.closest?.('li[data-path]:not(.folder)');
    const folderLi = e.target.closest?.('li.folder[data-path]');
    const blankFolder = !rowLi && !folderLi ? dropTargetFolder(e) : '';

    // 多选（框选/toggle）后拖动：整组移动到目标文件夹 / 根目录
    if (payload.kind === 'files') {
      let to = '';
      if (folderLi) to = folderLi.dataset.path;
      else if (rowLi) to = folderOf(rowLi.dataset.path);
      else {
        const moved = startPt ? Math.hypot((Number(e.clientX) || 0) - startPt.x, (Number(e.clientY) || 0) - startPt.y) : 999;
        if (moved < 40) return;
        to = blankFolder || '';
      }
      const targets = payload.paths.filter((p) => folderOf(p) !== to);
      if (!targets.length) return;
      await moveFilesTo(targets, to);
      return;
    }

    if (payload.kind === 'file') {
      // 落在文件行上：同目录 → 排序；跨目录 → 移入那一行所在的文件夹
      if (rowLi) {
        if (fileRowPath(rowLi) === payload.path) return;
        if (folderOf(rowLi.dataset.path) === folderOf(payload.path)) {
          const r = rowLi.getBoundingClientRect();
          applyPaperOrder(payload.path, rowLi.dataset.path, e.clientY > r.top + r.height / 2);
          return;
        }
        await moveItem(payload.path, folderOf(rowLi.dataset.path));
        return;
      }
      // 落在文件夹行上：移入（目标就是自己所在目录 → no-op）
      if (folderLi) {
        if (folderLi.dataset.path === folderOf(payload.path)) return;
        await moveItem(payload.path, folderLi.dataset.path);
        return;
      }
      // 落在空白处：拖在「本文件夹自己的空白区」= 没动；距离不够近（轻轻一拖）或本来就在根目录
      // 也视为取消，避免文件被甩到最下面 / 甩出文件夹。
      if (blankFolder && blankFolder === folderOf(payload.path)) return;
      const moved = startPt ? Math.hypot((Number(e.clientX) || 0) - startPt.x, (Number(e.clientY) || 0) - startPt.y) : 999;
      if (moved < 60 || folderOf(payload.path) === '') return;
      await moveItem(payload.path, blankFolder || '');
      return;
    }

    // 文件夹拖拽：改变层级（禁区前端先拦，服务端二次校验）
    if (payload.kind === 'folder') {
      const to = folderLi ? folderLi.dataset.path : (blankFolder || '');
      if (to === payload.path || to.startsWith(`${payload.path}/`)) {
        toast('不能把文件夹移到自己的子目录里', 'err', 3600);
        return;
      }
      await moveItem(payload.path, to);
    }
  });
}

/** 批量移动一组 PDF 到目标文件夹（''=根）；完成一次刷新 + 一条提示 */
async function moveFilesTo(paths, to) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  let ok = 0;
  let failed = 0;
  for (const rel of list) {
    try {
      const r = await fetch('/api/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: rel, to: to || '' }),
      });
      if (r.ok) ok += 1; else failed += 1;
    } catch { failed += 1; }
  }
  clearFileSelection();
  await refreshPaperList();
  toast(`已移动 ${ok} 个文件到「${to || '根目录'}」${failed ? `（${failed} 个失败）` : ''}`, failed ? 'err' : 'ok', 3200);
}

/** POST /api/move 移动 PDF / 文件夹；成功后刷新列表并同步打开中文件的内部路径 */
async function moveItem(from, to) {
  try {
    const r = await fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: to || '' }),
    });
    let j = {};
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    const label = from.split('/').pop();
    const finalName = j.name || label;
    const renamed = finalName !== label ? `（${finalName}）` : '';
    toast(`已移动 ${label} → ${to || '根目录'}${renamed}`, 'ok', 3000);
    // 正在打开的文件被移动：不打断阅读，只更新内部 url / path（active 按 docId 判定，不受影响）
    if (from === (state.doc?.path || state.doc?.name)) {
      const newPath = to ? `${to}/${finalName}` : finalName;
      state.doc.url = `/api/pdf?path=${encodeURIComponent(newPath)}`;
      state.doc.path = newPath;
      state.doc.name = finalName;
    }
    // 文件夹被移动：会话属于文件夹（folderKey 是路径哈希），先把当前文件夹同步到新路径，
    // 再迁移会话文件 + localStorage 里的 activeSession 键（失败不阻塞文件移动）
    if (!/\.pdf$/i.test(from)) {
      const newPath = to ? `${to}/${finalName}` : finalName;
      const cur = currentFolderPath();
      if (cur === from || cur.startsWith(`${from}/`)) {
        state.currentFolder = newPath + cur.slice(from.length);
        persistCurrentFolder();
        renderFolderSwitch();
      }
      try { await sessionsMigrateFolder(from, newPath); } catch { /* 会话迁移失败不影响文件移动 */ }
    }
    await refreshPaperList();
  } catch (e) {
    toast(`移动失败：${e.message}`, 'err', 5000);
    await refreshPaperList();
  }
}

let paperOrderSave = Promise.resolve();
/** 同目录排序：order 升级为相对路径数组，未排序项保持原有位置（不再被挤到末尾） */
function applyPaperOrder(from, target, after) {
  // 拖到自己身上 = 没有移动：必须直接返回，否则「移除后找不到 target」会把它塞到最下面
  //（用户实测：轻轻拖一点、松手落在自己那一行，文件直接跑到列表最下面）。
  if (!from || from === target) return;
  const paths = (state.papers || []).map((p) => p.path || p.name);
  const i = paths.indexOf(from);
  if (i < 0) return;
  paths.splice(i, 1);
  const t = paths.indexOf(target);
  // 目标不在了（被删/被移走）：放回原来的位置，绝不 append 到末尾
  if (t < 0) paths.splice(i, 0, from);
  else paths.splice(after ? t + 1 : t, 0, from);
  const by = new Map((state.papers || []).map((p) => [p.path || p.name, p]));
  state.papers = paths.map((n) => by.get(n)).filter(Boolean);
  renderPaperList();
  paperOrderSave = paperOrderSave.catch(() => {}).then(async () => {
    try {
      const r = await fetch('/api/papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: paths }),
      });
      let j = {};
      try { j = await r.json(); } catch { /* 非 JSON */ }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    } catch (e) {
      toast(`顺序保存失败：${e.message}`, 'err', 4200);
      await refreshPaperList();
    }
  });
}

/* ───────────────── 文件面板：右键菜单 / 内联新建 / 重命名 / 删除 ───────────────── */

/** 文件名/夹名前端清洗（服务端会再洗一遍） */
function sanitizeClientFolderName(name) {
  const n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return n ? n.slice(0, 80) : null;
}

function initFileContextMenu() {
  const menu = $('#fileCtx');
  if (!menu) return;
  const close = () => { menu.hidden = true; menu.innerHTML = ''; };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('blur', close);
  // 只接管文件列表 / 拖入区 / 筛选框的右键
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest?.('#fileList, #dropzone, #fileFilter')) return;
    e.preventDefault();
    const folderLi = e.target.closest?.('li.folder[data-path]');
    const fileLi = e.target.closest?.('li[data-path]:not(.folder)');
    // 已多选：右键落在某个已选文件上（或在多选状态里右键别的文件）→ 批量菜单
    if (fileLi && state.fileSel.size > 1) {
      const path = fileLi.dataset.path;
      if (!state.fileSel.has(path)) setFileSelection([path], { anchor: path });
      else syncFileSelection();
      showBatchFileCtx(e.clientX, e.clientY);
      return;
    }
    const target = folderLi
      ? { kind: 'folder', path: folderLi.dataset.path, name: folderLi.dataset.folder }
      : fileLi
        ? { kind: 'file', path: fileLi.dataset.path, name: fileLi.dataset.name }
        : { kind: 'blank' };
    showFileCtx(e.clientX, e.clientY, target);
  });
}

/** 多选后的右键菜单：批量删除 / 批量移动 / 取消选择 */
function showBatchFileCtx(x, y) {
  const menu = $('#fileCtx');
  if (!menu) return;
  const paths = [...state.fileSel];
  menu.hidden = false;
  menu.innerHTML = '';
  const item = (label, fn, danger) => el('button', {
    type: 'button',
    class: `ctx-item${danger ? ' danger' : ''}`,
    text: label,
    onclick: (e) => { e.stopPropagation(); menu.hidden = true; fn(); },
  });
  menu.append(el('div', { class: 'ctx-title', text: `已选 ${paths.length} 个文件` }));
  menu.append(item(`删除所选（${paths.length}）`, () => deleteSelectedFiles(), true));
  menu.append(item('移动到…', () => showBatchMoveTargets(menu, paths)));
  menu.append(item('取消选择', () => clearFileSelection()));
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

/** 批量移动的目标文件夹列表（根 + 所有文件夹） */
function showBatchMoveTargets(menu, paths) {
  menu.hidden = false;   // 同 showMoveTargets：换列表时把菜单重新显示出来
  menu.innerHTML = '';
  menu.append(el('div', { class: 'ctx-title', text: `移动 ${paths.length} 个文件到` }));
  const pick = (to) => { menu.hidden = true; moveSelectedFiles(to); };
  menu.append(el('button', { type: 'button', class: 'ctx-item', text: '根目录', onclick: () => pick('') }));
  for (const f of state.folders || []) {
    menu.append(el('button', { type: 'button', class: 'ctx-item', text: f.path, onclick: () => pick(f.path) }));
  }
  const r = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(parseFloat(menu.style.top) || 0, window.innerHeight - r.height - 8)}px`;
}

function showFileCtx(x, y, target) {
  const menu = $('#fileCtx');
  if (!menu) return;
  menu.hidden = false;
  menu.innerHTML = '';
  const item = (label, fn, danger) => el('button', {
    type: 'button',
    class: `ctx-item${danger ? ' danger' : ''}`,
    text: label,
    onclick: (e) => { e.stopPropagation(); menu.hidden = true; fn(); },
  });
  if (target.kind === 'blank') {
    menu.append(item('新建文件夹', () => startInlineCreate('')));
  } else if (target.kind === 'folder') {
    menu.append(item('新建文件夹', () => startInlineCreate('')));
    menu.append(item('重命名', () => startInlineRename(target.path, target.name)));
    menu.append(item('删除文件夹', () => deleteFolder(target.path, target.name), true));
    menu.append(item('移动到…', () => showMoveTargets(menu, target)));
  } else {
    menu.append(item('移动到…', () => showMoveTargets(menu, target)));
    menu.append(item('删除', () => {
      const p = (state.papers || []).find((pp) => (pp.path || pp.name) === target.path);
      if (p) deletePaper(p);
    }, true));
  }
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

/** 「移动到…」：菜单原地换成目标列表（根 + 各文件夹；文件夹移动跳过自身/子孙） */
function showMoveTargets(menu, target) {
  menu.hidden = false;   // 菜单项点击时先 hidden=true 再回调：换目标列表必须重新显示，否则看起来「没反应」
  menu.innerHTML = '';
  menu.append(el('div', { class: 'ctx-title', text: `移动「${target.name}」到` }));
  const pick = (to) => { menu.hidden = true; moveItem(target.path, to); };
  menu.append(el('button', { type: 'button', class: 'ctx-item', text: '根目录', onclick: () => pick('') }));
  for (const f of state.folders || []) {
    if (target.kind === 'folder' && (f.path === target.path || f.path.startsWith(`${target.path}/`))) continue;
    menu.append(el('button', { type: 'button', class: 'ctx-item', text: f.path, onclick: () => pick(f.path) }));
  }
  const r = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(parseFloat(menu.style.top) || 0, window.innerHeight - r.height - 8)}px`;
}

/** 内联新建文件夹（根下或指定父夹下） */
function startInlineCreate(parentPath) {
  if (parentPath && !state.folderOpen.has(parentPath)) {
    state.folderOpen.add(parentPath);
    saveFolderOpen();
  }
  renderPaperList();
  const list = $('#fileList');
  if (!list) return;
  const input = el('input', { class: 'inline-name', placeholder: '新文件夹名，Enter 确认' });
  const li = el('li', { class: 'folder inline-create' }, input);
  if (!parentPath) {
    list.prepend(li);
  } else {
    const ul = [...$$('#fileList ul.folder-children')].find((u) => u.dataset.parent === parentPath);
    (ul || list).prepend(li);
  }
  input.focus();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!name) { renderPaperList(); return; }
    try {
      const q = new URLSearchParams({ name });
      if (parentPath) q.set('parent', parentPath);
      const r = await fetch(`/api/folders?${q}`, { method: 'POST' });
      let j = {};
      try { j = await r.json(); } catch { /* 非 JSON */ }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      if (parentPath && !state.folderOpen.has(parentPath)) { state.folderOpen.add(parentPath); saveFolderOpen(); }
      await refreshPaperList();
      toast(`已创建文件夹「${j.path || j.name}」`, 'ok', 2400);
    } catch (e) {
      toast(`创建文件夹失败：${e.message}`, 'err', 4200);
      renderPaperList();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') { done = true; renderPaperList(); }
  });
  input.addEventListener('blur', commit);
}

/** 内联重命名文件夹（改磁盘真实目录名；内部 PDF 的 docId / 笔记 / 会话不受影响） */
function startInlineRename(folderPath, name) {
  const li = [...$$('#fileList li.folder')].find((x) => x.dataset.path === folderPath);
  if (!li) return;
  const input = el('input', { class: 'inline-name', value: name });
  li.classList.add('renaming');
  li.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const to = input.value.trim();
    if (!to || to === name) { renderPaperList(); return; }
    try {
      const r = await fetch('/api/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: folderPath, to }),
      });
      let j = {};
      try { j = await r.json(); } catch { /* 非 JSON */ }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      // 打开中文件在旧夹里：url 换成 name 回退形式，不打断阅读
      if (state.doc && (state.doc.path || '').startsWith(`${folderPath}/`)) {
        const base = (state.doc.path || '').split('/').pop();
        state.doc.url = `/api/pdf?name=${encodeURIComponent(base)}`;
        state.doc.path = base;
      }
      // 文件夹改名：会话属于文件夹（folderKey 是路径哈希），同步当前文件夹并迁移会话键
      // （旧会话文件保留作回退备份；失败不阻塞改名）
      const parent = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
      const newPath = parent ? `${parent}/${j.name || to}` : (j.name || to);
      const cur = currentFolderPath();
      if (cur === folderPath || cur.startsWith(`${folderPath}/`)) {
        state.currentFolder = newPath + cur.slice(folderPath.length);
        persistCurrentFolder();
        renderFolderSwitch();
      }
      try { await sessionsMigrateFolder(folderPath, newPath); } catch { /* 会话迁移失败不影响改名 */ }
      await refreshPaperList();
      toast(`已重命名「${name}」→「${to}」`, 'ok', 2600);
    } catch (e) {
      toast(`重命名失败：${e.message}`, 'err', 4200);
      renderPaperList();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') { done = true; renderPaperList(); }
  });
  input.addEventListener('blur', commit);
}

async function deleteFolder(folderPath, name) {
  const f = (state.folders || []).find((x) => x.path === folderPath);
  const count = f?.count || 0;
  if (!count) {
    if (!confirm(`删除文件夹「${name}」？`)) return;
    return doDeleteFolder(folderPath, 'recursive');
  }
  // 非空：默认推荐「PDF 移到根再删」；取消则问是否彻底删
  if (confirm(`删除文件夹「${name}」？\n\n里面有 ${count} 篇 PDF。\n确定 = PDF 移到根目录再删（推荐，不丢文件）\n取消 = 改为彻底删除`)) {
    return doDeleteFolder(folderPath, 'to-root');
  }
  if (confirm(`彻底删除「${name}」？\n\n连同里面 ${count} 篇 PDF 一起删除，不可恢复。`)) {
    return doDeleteFolder(folderPath, 'recursive');
  }
}

async function doDeleteFolder(folderPath, mode) {
  try {
    const r = await fetch(`/api/folders?path=${encodeURIComponent(folderPath)}&mode=${mode}`, { method: 'DELETE' });
    let j = {};
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    const label = folderPath.split('/').pop();
    toast(mode === 'to-root'
      ? `已删除文件夹「${label}」，其中 ${j.moved || 0} 篇 PDF 移到根目录`
      : `已删除文件夹「${label}」`, 'ok', 3200);
    state.folderOpen.delete(folderPath);
    saveFolderOpen();
    // 正在读的文件受影响：to-root 换 name 回退 url；recursive 收掉阅读态
    if (state.doc && (state.doc.path || '').startsWith(`${folderPath}/`)) {
      if (mode === 'to-root') {
        const base = (state.doc.path || '').split('/').pop();
        state.doc.url = `/api/pdf?name=${encodeURIComponent(base)}`;
        state.doc.path = base;
      } else {
        closeDeletedDoc();
      }
    }
    await refreshPaperList();
    renderHome();
  } catch (e) {
    toast(`删除文件夹失败：${e.message}`, 'err', 5000);
  }
}

/** 删除一篇 PDF（只删文件；笔记 / 会话 / 进度留在 data/，重新导入还能看到） */
async function deletePaper(p) {
  const opened = !!state.doc && (state.doc.docId === p.docId || state.doc.url === p.url);
  const ok = confirm(`删除「${p.name}」？\n\n只删除 papers/ 里的这个 PDF 文件`
    + `${opened ? '（这篇正在阅读，删除后会回到首页）' : ''}。\n`
    + '笔记、问答会话与阅读进度会保留：重新导入同一个文件仍能看到。');
  if (!ok) return;
  try {
    const q = new URLSearchParams({ path: p.path || p.name });
    const r = await fetch(`/api/papers?${q}`, { method: 'DELETE' });
    let j = {};
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    state.papers = state.papers.filter((x) => (x.path || x.name) !== (p.path || p.name));
    if (opened) closeDeletedDoc();
    renderPaperList();
    renderHome();
    toast(`已删除「${p.name}」`, 'ok', 2800);
  } catch (e) {
    toast(`删除失败：${e.message}`, 'err', 5000);
  }
}

/** 正在读的那篇被删掉：把阅读态收干净并回首页（viewer 不卸载，下次打开会重新加载） */
function closeDeletedDoc() {
  abortStream('paper-deleted');
  state.doc = null;
  state.viewerDocId = null;
  document.title = '论文阅读器';
  const nameEl = $('#docName');
  if (nameEl) { nameEl.textContent = '未打开文档'; nameEl.title = ''; }
  const page = $('#pageInput');
  if (page) page.value = '–';
  const count = $('#pageCount');
  if (count) count.textContent = '–';
  for (const li of $$('#fileList li')) li.classList.remove('active');
  setView('home');
}

let localObjectUrl = null;

/** 上传一个 PDF 到 papers/（folder=''=根；返回服务端落盘信息） */
async function uploadPdfFile(file, folder = '') {
  const buf = await file.arrayBuffer();
  const q = new URLSearchParams({ name: file.name });
  if (folder) q.set('folder', folder);
  const r = await fetch(`/api/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: buf,
  });
  let j = {};
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

/** 外部拖入（资源管理器）：PDF 导入目标夹；文件夹建同名夹导入一层（v1 忽略子文件夹） */
async function importExternalDrop(dt, targetFolder) {
  const items = dt ? Array.from(dt.items || []).filter((it) => it.kind === 'file') : [];
  if (!items.length) {
    // 无 items（兼容老拖拽）：退回纯 PDF 处理
    const pdfs = pdfFilesFrom(dt?.files);
    if (pdfs.length) {
      if (targetFolder) await importPdfsToFolder(pdfs, targetFolder);
      else importLocalFiles(pdfs);
    }
    return;
  }
  const pdfFiles = [];
  const dirs = [];
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    if (!entry) continue;
    if (entry.isDirectory) dirs.push(entry);
    else if (entry.isFile && /\.pdf$/i.test(entry.name)) {
      const f = it.getAsFile?.();
      if (f) pdfFiles.push(f);
    }
  }
  if (pdfFiles.length) {
    if (targetFolder) await importPdfsToFolder(pdfFiles, targetFolder);
    else importLocalFiles(pdfFiles);
  }
  for (const dirEntry of dirs) {
    await importExternalFolder(dirEntry, targetFolder);
  }
  await refreshPaperList();
}

/** 外部文件夹 → papers/ 下建同名夹（重名自动 (2)），导入直接含有的 PDF（只读一层） */
async function importExternalFolder(entry, parent) {
  const name = sanitizeClientFolderName(entry.name);
  if (!name) { toast(`忽略非法文件夹名「${entry.name}」`, 'err', 3600); return; }
  let j = {};
  try {
    const q = new URLSearchParams({ name });
    if (parent) q.set('parent', parent);
    const r = await fetch(`/api/folders?${q}`, { method: 'POST' });
    try { j = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  } catch (e) {
    toast(`创建文件夹「${name}」失败：${e.message}`, 'err', 4200);
    return;
  }
  const folderPath = j.path || j.name;
  const reader = entry.createReader();
  const entries = await new Promise((res) => {
    const acc = [];
    const readAll = () => {
      reader.readEntries((batch) => {
        if (!batch.length) { res(acc); return; }
        acc.push(...batch);
        readAll();
      }, () => res(acc));
    };
    readAll();
  });
  const pdfs = [];
  let subdirs = 0;
  for (const en of entries) {
    if (en.isFile && /\.pdf$/i.test(en.name)) {
      const f = await new Promise((res) => en.file(res, () => res(null)));
      if (f) pdfs.push(f);
    } else if (en.isDirectory) {
      subdirs += 1;
    }
  }
  if (pdfs.length) await importPdfsToFolder(pdfs, folderPath);
  if (subdirs) toast(`「${name}」里有 ${subdirs} 个子文件夹，v1 只导入一层，已忽略`, 'info', 4200);
}

async function importPdfsToFolder(pdfs, folder) {
  for (const f of pdfs) {
    try {
      await uploadPdfFile(f, folder);
    } catch (e) {
      toast(`导入 ${f.name} 失败：${e.message}`, 'err', 4000);
    }
  }
}

/**
 * 单文件打开：先上传到服务端的 papers/ 存下来，再从服务端打开。
 * 这样下次启动还在列表里（以前用 blob URL，关掉就没了）。
 * 万一上传失败（比如 papers/ 不可写），退回临时打开，至少还能看。
 */
async function openLocalFile(file) {
  if (!/\.pdf$/i.test(file.name)) { toast('只支持 PDF 文件', 'err'); return; }
  setBusy(true, '正在导入…');
  try {
    const j = await uploadPdfFile(file);
    await refreshPaperList();
    await openDoc({ name: j.name, url: j.url, docId: j.docId, path: j.path || j.name });
    toast(`已存到 papers/：${j.name}`, 'ok', 2600);
  } catch (e) {
    toast(`导入失败（${e.message}），先用临时方式打开`, 'err', 5000);
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = URL.createObjectURL(file);
    await openDoc({ name: file.name, url: localObjectUrl, docId: `local-${file.name}-${file.size}` });
  } finally {
    setBusy(false);
  }
}

async function importLocalFiles(files) {
  const pdfs = pdfFilesFrom(files);
  if (!pdfs.length) { toast('只支持 PDF 文件', 'err'); return; }
  if (pdfs.length === 1) return openLocalFile(pdfs[0]);
  setBusy(true, `正在导入 1/${pdfs.length}…`);
  const imported = [];
  const failed = [];
  for (let i = 0; i < pdfs.length; i++) {
    setBusy(true, `正在导入 ${i + 1}/${pdfs.length}…`);
    try {
      imported.push(await uploadPdfFile(pdfs[i]));
    } catch (e) {
      failed.push({ name: pdfs[i].name, msg: e.message });
    }
  }
  setBusy(false);
  await refreshPaperList();
  if (imported.length) {
    const note = failed.length ? `，${failed.length} 篇失败（${failed[0].name}：${failed[0].msg}）` : '';
    toast(`已导入 ${imported.length} 篇 PDF${note}`, failed.length ? 'err' : 'ok', failed.length ? 6000 : 3400);
  } else {
    toast(`导入失败：${failed[0]?.name || ''} ${failed[0]?.msg || '未知错误'}`, 'err', 6000);
  }
  if (failed.length) console.warn('[import] 导入失败的 PDF：', failed);
}


/**
 * 打开文档（多标签包装）：B 线 P1 的冷切换 —— 真正的加载/状态清理仍由 openDocColdSwitch 完成，
 * 这里只维护「工作区标签列表 + 活动标签 + 持久化」。
 */
async function openDoc(target = {}) {
  if (!tabsFeatureEnabled() || !tabsStore.booted) return openDocColdSwitch(target);
  const docId = String(target.docId || '');
  if (!docId) return openDocColdSwitch(target);
  if (tabsStore.tabs.some((t) => t.docId === docId)) {
    if (state.doc?.docId === docId) {
      tabsStore.active = docId;
      tabsSyncBar();
      tabsPersist();
      return;
    }
    await openDocColdSwitch(target);
    if (state.doc?.docId === docId) {
      tabsStore.active = docId;
      tabsSyncBar();
      tabsPersist();
    }
    return;
  }
  if (tabsStore.tabs.length >= TABS_MAX) {
    toast('最多同时打开 ' + TABS_MAX + ' 篇论文，先关掉一个标签再打开', 'err', 4000);
    return;
  }
  await openDocColdSwitch(target);
  if (state.doc?.docId !== docId) return;   // 打开失败：不动工作区
  tabsStore.tabs.push(tabFor(target));
  tabsStore.active = docId;
  tabsSyncBar();
  tabsPersist();
}

/** 关闭标签：删列表 → 有邻居就切过去（冷切换）→ 最后一个回 Welcome */
async function closeTab(docId) {
  const id = String(docId || '');
  const idx = tabsStore.tabs.findIndex((t) => t.docId === id);
  if (idx < 0) return;
  const [tab] = tabsStore.tabs.splice(idx, 1);
  pushClosedTab(tab);
  dropPdfHandle(tab.docId);   // B 线 P2：关掉的标签不再保留 PDF 句柄
  dropDocView(tab.docId);

  const wasActive = state.doc?.docId === id;
  if (!tabsStore.tabs.length) {
    await goWelcome();
    return;
  }
  const next = tabsStore.tabs[Math.min(idx, tabsStore.tabs.length - 1)];
  if (wasActive) {
    tabsStore.active = next.docId;
    await openDocColdSwitch({ name: next.name, url: next.url, docId: next.docId, path: next.path });
    if (state.doc?.docId !== next.docId) tabsStore.tabs = tabsStore.tabs.filter((t) => t.docId !== next.docId);
  }
  if (!tabsStore.tabs.length) {
    await goWelcome();
    return;
  }
  if (!tabsStore.tabs.some((t) => t.docId === state.doc?.docId)) tabsStore.active = tabsStore.tabs[0].docId;
  tabsSyncBar();
  tabsPersist();
}

/** 激活标签（与 openDoc 同一条路：已打开就只激活，切文档走冷切换） */
async function activateTab(docId) {
  const tab = tabsStore.tabs.find((t) => t.docId === docId);
  if (tab) await openDoc({ name: tab.name, url: tab.url, docId: tab.docId, path: tab.path });
}

/** 拖拽排序 */
function moveTab(docId, index) {
  const from = tabsStore.tabs.findIndex((t) => t.docId === docId);
  if (from < 0) return;
  const [tab] = tabsStore.tabs.splice(from, 1);
  const to = Math.max(0, Math.min(Number(index) || 0, tabsStore.tabs.length));
  tabsStore.tabs.splice(to, 0, tab);
  tabsSyncBar();
  tabsPersist();
}

/** Ctrl+Shift+T：重开最近关闭的标签 */
async function reopenClosedTab() {
  const tab = popClosedTab();
  if (!tab) return;
  await openDoc({ name: tab.name, url: tab.url, docId: tab.docId, path: tab.path });
}

/** 关掉全部标签 → Welcome（现有 #home 书架页；文档对象保留，只是不在工作区里） */
async function goWelcome({ skipSave = false } = {}) {
  cancelSearch({ clearInput: true, close: true, focus: false });
  abortStream('document-switch');
  hideDocLoading();
  // B 线 P2：回 Welcome 也把当前文档挂起（PDF 句柄 + 右栏 DOM），之后切回来是热切换
  if (state.doc?.docId) parkDocView(state.doc.docId);
  if (state.doc?.docId && viewer?.pdf) {
    try {
      const handle = viewer.detach();
      if (handle) {
        pdfHandles.set(state.doc.docId, handle);
        while (pdfHandles.size > TABS_MAX) dropPdfHandle(pdfHandles.keys().next().value);
      }
    } catch { /* 挂起失败不影响回首页 */ }
  }
  if (state.doc && !skipSave) {
    try { await saveSessionNow(); } catch { /* 保存失败不挡回首页 */ }
  }
  tabsStore.active = '';
  tabsStore.tabs = [];
  tabsSyncBar();
  tabsPersist();
  state.folderClosed = true;   // 这个文件夹已完全关闭：下次打开默认新会话
  cleanStaleLastDoc();
  setView('home');
  $('#docName').textContent = '未打开文档';
  $('#docName').title = '';
  document.title = '论文阅读器';
  refreshReturnButton();
  renderScopeMenu();
  checkConfigWarning();
}

/** 标签条 + 快捷键（boot 调用；没挂载点或开关关掉就退回旧行为） */
function initTabs() {
  const mount = $('#tabBarMount');
  if (!mount || !tabsFeatureEnabled()) {
    if (mount) mount.remove();
    tabsStore.booted = true;
    syncHomeBtnVisibility();
    return;
  }
  tabsStore.bar = createTabBar({
    mount,
    onActivate: (docId) => activateTab(docId),
    onClose: (docId) => closeTab(docId),
    onReorder: (docId, index) => moveTab(docId, index),
    onOpenDoc: (doc) => openDoc({ name: doc.name, url: doc.url, docId: doc.docId, path: doc.path }),
    listFolderDocs: () => (state.papers || []).map((paper) => ({
      ...paper,
      folder: String(paper.path || '').includes('/') ? String(paper.path).slice(0, String(paper.path).lastIndexOf('/')) : '',
    })),
  });
  tabsStore.bar.render([], '');
  installTabsShortcuts();
  tabsStore.booted = true;
  syncHomeBtnVisibility();
}

/** 快捷键：Ctrl+W 关闭 / Ctrl+Shift+T 重开 / Ctrl+Tab·PageUp/Down 切换 / Ctrl+1..9 直达 */
function installTabsShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!tabsFeatureEnabled() || !tabsStore.booted) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const list = tabsStore.tabs;
    const key = String(e.key || '').toLowerCase();
    if (key === 'w' && !e.shiftKey && !e.altKey) {
      const id = state.doc?.docId || tabsStore.active;
      if (id && list.some((t) => t.docId === id)) { e.preventDefault(); e.stopPropagation(); closeTab(id); }
      return;
    }
    if (key === 't' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); reopenClosedTab(); return; }
    if (key === 'tab' || e.key === 'PageDown' || e.key === 'PageUp') {
      if (list.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = list.findIndex((t) => t.docId === (state.doc?.docId || tabsStore.active));
      const step = (e.shiftKey || e.key === 'PageUp') ? -1 : 1;
      const next = list[(cur + step + list.length) % list.length];
      if (next && next.docId !== state.doc?.docId) activateTab(next.docId);
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
      const num = Number(e.key);
      const target = num === 9 ? list[list.length - 1] : list[num - 1];
      if (target && target.docId !== state.doc?.docId) { e.preventDefault(); e.stopPropagation(); activateTab(target.docId); }
    }
  }, true);
}

/** boot：恢复工作区（有标签就打开活动标签；空工作区 = Welcome，不按 lastDoc 自动打开） */
async function bootTabWorkspace() {
  cleanStaleLastDoc();
  const ws = loadWorkspace();
  const url = new URL(location.href);
  const openName = url.searchParams.get('open');
  const papers = state.papers || [];
  const byId = new Map(papers.map((paper) => [paper.docId, paper]));
  const named = openName
    ? papers.find((paper) => paper.name === openName || paper.name.replace(/\.pdf$/i, '') === openName) || null
    : null;
  if (openName && !named) toast('papers/ 里没有找到 ' + openName, 'err', 4000);

  // ① 先恢复上次的工作区（文件还在的标签才恢复；打开顺序不变）
  const restorable = ws.tabs.filter((t) => byId.has(t.docId) && folderOfDoc(t.docId) === currentFolderPath());
  if (restorable.length) {
    tabsStore.tabs = restorable.map((t) => {
      const paper = byId.get(t.docId);
      return { docId: t.docId, name: paper.name, url: paper.url, path: paper.path || paper.name };
    }).slice(0, TABS_MAX);
    tabsStore.active = '';
    tabsSyncBar();
  }
  // ② 这次要打开哪篇：?open 指定 > 上次活动标签 > 第一个标签
  const wanted = named
    ? (tabsStore.tabs.find((t) => t.docId === named.docId) || tabFor({ ...named, path: named.path || named.name }))
    : (tabsStore.tabs.find((t) => t.docId === ws.active) || tabsStore.tabs[0] || null);
  if (!wanted) { await goWelcome(); return; }
  if (!tabsStore.tabs.some((t) => t.docId === wanted.docId)) {
    if (tabsStore.tabs.length >= TABS_MAX) { await goWelcome(); return; }
    tabsStore.tabs.push(wanted);
    tabsSyncBar();
  }
  await openDocColdSwitch({ name: wanted.name, url: wanted.url, docId: wanted.docId, path: wanted.path });
  if (state.doc?.docId !== wanted.docId) {
    tabsStore.tabs = tabsStore.tabs.filter((t) => t.docId !== wanted.docId);
    if (!tabsStore.tabs.length) await goWelcome();
    else { tabsSyncBar(); tabsPersist(); }
    return;
  }
  tabsStore.active = wanted.docId;
  tabsSyncBar();
  tabsPersist();
}

async function openDocColdSwitch({ name, url, docId, path }) {
  cancelSearch({ clearInput: true, close: true, focus: false });
  abortStream('document-switch');
  if (state.doc && state.sessionEntries.length) {
    persistSession.cancel?.();
    try {
      if (sessionSaveInFlight) await sessionSaveInFlight;
      await saveSessionNow();
    } catch (e) {
      toastAction(`当前会话保存失败，仍停留在「${state.doc.name}」。`, '重试', async () => {
        await saveSessionNow();
        toast('会话已保存，现在可以切换论文', 'ok');
      }, 'err', 12000);
      return;
    }
  }
  const prevDocId = state.doc?.docId || null;
  // B 线 P2：切走前把上一篇的右栏 DOM 与会话状态整体停放，切回来直接挂回（不重放渲染）
  if (prevDocId) parkDocView(prevDocId);
  // 用户口径：每次只处理一个文件夹；换到别的文件夹 = 关掉旧标签 + 开新会话
  ensureFolderForDoc(docId);
  const myOpen = (state.openSeq = (state.openSeq || 0) + 1);
  const superseded = () => myOpen !== state.openSeq;
  hideTranslationCard();
  clearQuoteHighlight();          // 换论文：引用高亮属于上一篇，必须清掉
  state.selection = null;
  state.doc = { name, url, docId, path: path || name };
  // 面板布局不再按论文分叉（阶段 2.2a）：换论文不重载 state.panels
  state.viewerDocId = null;
  refreshReturnButton();
  document.title = `${name} · 论文阅读器`;
  $('#docName').textContent = name;
  $('#docName').title = name;
  // 注意：这里不切视图。真正切到阅读态是在 viewer.load() 成功之后 ——
  // 加载失败要能退回首页，中间过程也不该先露出一个空白正文区。
  // 换论文：只清译文块（每篇各自一份）；问答块是全局会话共用的，保留 DOM 不重绘
  clearTranslateBlock();
  state.attachments = [];
  renderAttachments();
  viewer.paintSelection(null);
  // 换论文后上一篇的「释 / 译 / ＋对话」浮动气泡作废：否则会拿着上一篇的选区提问
  hideBubble();
  hideTranslationCard();

  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  state.sessionEntries = [];
  state.cache.clear();
  // 换论文了：整篇文本和阅读索引都作废；单次范围也随论文切换复位。
  state.docText = null;
  state.docTextDoc = null;
  state.docDigest = null;
  // 页型扫描结果 / 扫描件阅读索引：换论文即作废（缓存仍按文件指纹留在 localStorage）
  state.docProfile = null;
  state.docProfileDoc = null;
  state.docProfilePromise = null;
  state.scanDigest = null;
  state.scanDigestDoc = null;
  state.scanDigestPromise = null;
  // 让 state 的两个标记重新对齐当前范围（同一套推导，不重复实现）
  applyRangeForSend(currentRange());
  // 换论文了：参考文献列表作废，等用户再打开这一块时才重新解析（按需，不在这里跑）。
  // 阶段 3：先把代际令牌抬一格，再清状态 —— 旧论文在途的解析 / 查询回来时
  // 会发现自己是上一代，整批丢弃，一个字都不写进新论文（R1/R2/R3/R5）。
  relBumpGen();
  state.refs = [];
  state.refsDoc = null;
  state.refsParsing = null;
  state.relHint = '';
  state.relItemState.clear();   // 条目状态跟着论文走（key 只保证在同一篇论文内稳定）
  resetRelView();               // 搜索 / 分组折叠只活在内存里，换论文即重置
  // 正文引用卡片也是上一篇的：不清的话「找这篇的 PDF」会拿上一篇的文献去查
  state.cite = null;
  $('#citeBox')?.classList.add('hidden');
  // 换论文：操作结果不再适用（缓存按 docId 存，别串到新论文头上）
  state.opsDone = {};
  state.opsDoc = null;
  // 「读懂论文」的教学进度 / 教学对象 / 教学缓存也属于上一篇论文
  resetTeachingState();
  hideOpsMenu();
  renderRelations();
  // 换论文时把「这次会发什么」重新播报一遍（范围没变，但可用性变了：整篇要有一篇装好的论文）
  updateComposerHint();
  renderScopeMenu();
  for (const li of $$('#fileList li')) li.classList.toggle('active', li.dataset.id === docId);

  // B 线 P2：热切换状态（在 try 外声明，加载成功后的首屏/会话阶段也要用）
  let hotSwitch = false;
  const hotTrace = window.__hotTrace ? {} : null;
  const hotMark = (key, t0) => { if (hotTrace) hotTrace[key] = Math.round(performance.now() - t0); };
  // 第一次打开这篇（没有挂起的 PDF 句柄）→ 正文区显示加载提示；热切换不显示，避免「闪一下」
  if (!pdfHandles.get(docId)) showDocLoading(name);
  try {
    // B 线 P2：热切换 —— 先把上一篇挂起成句柄（同一篇下次切回来直接 attach）
    if (prevDocId && prevDocId !== docId && viewer?.pdf) {
      try {
        const handle = viewer.detach();
        if (handle) {
          pdfHandles.set(prevDocId, handle);
          while (pdfHandles.size > TABS_MAX) dropPdfHandle(pdfHandles.keys().next().value);
        }
      } catch { /* 挂起失败就退回冷加载 */ }
    }
    let cachedHandle = pdfHandles.get(docId) || null;
    hotSwitch = !!cachedHandle;
    const tAttach = performance.now();
    // 把文件大小传给 viewer：几十/上百 MB 的 PDF 走「只取需要的字节范围」策略
    const paperMeta = (state.papers || []).find((p) => p && p.docId === docId);
    const paperSize = Number(paperMeta?.size) || 0;
    let r;
    try {
      r = hotSwitch ? await viewer.attach(cachedHandle) : await viewer.load(url, name, { size: paperSize });
    } catch (e) {
      // 本地文件服务偶发返回非 200/206（PDF.js 会抛 `Unexpected server response (NNN)`）：
      // 实测多由「同时开了两个阅读器窗口、共用同一份 data」引起（第二个窗口抢 WebView2
      // 用户数据目录，本地服务也可能读到正在被重写的文件）。冷加载重试一次；热切换失败
      // 则退回完整冷加载，不把一次偶发失败直接甩给用户。
      if (superseded() || isAbortish(e)) throw e;
      const status = /Unexpected server response \((\d+)\)/.exec(String(e?.message || e))?.[1] || '';
      console.warn('[openDoc] PDF 首次加载失败，准备重试', { docId, status, err: e });
      if (cachedHandle) {
        pdfHandles.delete(docId);
        cachedHandle = null;
      }
      hotSwitch = false;
      await new Promise((res) => setTimeout(res, 300));
      r = await viewer.load(url, name, { size: paperSize });
    }
    hotMark('attach', tAttach);
    if (cachedHandle) {
      pdfHandles.delete(docId);
      pdfHotAttaches += 1;
    }
    if (superseded()) return;
    if (r?.stale) return;
  } catch (e) {
    // 被后一次打开顶替了、或者这次加载本来就被中断 → 一律不动界面（加载提示由新的那次打开接管）
    if (superseded() || isAbortish(e)) return;
    hideDocLoading();
    const msg = String(e?.message || e);
    const code = /Unexpected server response \((\d+)\)/.exec(msg)?.[1] || '';
    // 给一句可执行的解释：这是本地文件服务没返回 200/206，而不是论文损坏 /
    // 网络问题（如果同时开着两个阅读器窗口，它们会抢同一份 data，关掉多余的再试）。
    const hint = code
      ? `：本地文件服务返回 ${code}。如果同时开着两个阅读器窗口，请先关掉多余的那个再重试（两个窗口会抢同一份 data）`
      : '';
    toast(`打开失败：${msg}${hint}`, 'err', code ? 9000 : 6000);
    console.warn('[openDoc] 打开失败', { docId, err: e });
    state.doc = null;
    state.viewerDocId = null;
    document.title = '论文阅读器';
    $('#docName').textContent = '未打开文档';
    $('#docName').title = '';
    // 打开失败退回首页（不再是一个既不像欢迎页、又不像错误页的模糊容器）
    setView('home');
    $('#pageInput').value = '–';
    $('#pageCount').textContent = '–';
    for (const li of $$('#fileList li')) li.classList.remove('active');
    refreshReturnButton();
    renderScopeMenu();
    checkConfigWarning();
    return;
  }
  if (superseded()) return;
  // PDF 真的加载出来了才切到阅读态（见上面「不切视图」的说明）
  setView('reading');
  const saved = serverState.docs?.[docId];
  const userZoomed = !!(saved && saved.fit === false && saved.scale > 0.2);
  if (userZoomed) {
    viewer.setScale(saved.scale, { keepCenter: false });
    viewer._fitMode = false;   // setScale 可能因为数值相同而提前返回，这里补一刀
  } else {
    viewer.fitWidth();
  }
  if (superseded()) return;
  // 侧栏状态和正文宽度在打开后才最终稳定；首页先前可能按旧宽度留下低密度位图。
  // 等一帧布局完成后重画第一页，避免出现「第一页糊、第二页清楚」的首屏差异。
  // （页面被隐藏时 rAF 不触发 —— 自动化 `--background` 窗口 —— 用定时器兜底。）
  await nextFrame();
  // B 线 P2：热切换时 attach 已经渲染了可见页，不再拆掉重画首屏（这是切换耗时的大头）
  if (!hotSwitch) await viewer.refreshPage?.(1);
  if (superseded()) return;
  // 首屏已经画出来了：撤掉加载提示（后面的目录/笔记/会话恢复在阅读视图里继续，不挡正文）
  hideDocLoading();
  syncZoom(viewer.scale);
  // 底栏的页码也要在打开时立刻有值：`onPageChange` 不保证在这个时点已经触发过
  //（实测首次打开时底栏还停在占位符「–」，而顶栏已经是 1/16）。直接同步一次。
  syncFootPage(viewer.current, viewer.numPages);
  let tStage = performance.now();
  const hotView = hotSwitch ? unparkDocView(docId) : false;
  if (hotView) hotMark('restoreSessionList', tStage);
  if (hotView) {
    // 已打开过：右栏 DOM/会话/目录/笔记直接从停放区挂回，不再重放（用户口径：已经打开的就不要每次都重新渲染）
    hotMark('restoreView', tStage);
    tStage = performance.now();
  } else {
    await renderOutline();
    hotMark('outline', tStage);
    tStage = performance.now();
    await renderNotes();
    hotMark('notes', tStage);
    if (superseded()) return;
    tStage = performance.now();
    // 只恢复文档级译文；问答归属由 sessions.js 决定（恢复上次 / 新建 / 显示选择卡片，用户拍板 B）
    await restoreSession(docId, { only: 'translate' });
    if (superseded()) return;
    await sessionsOnDocOpened(docId);
    hotMark('session', tStage);
    if (superseded()) return;
  }
  // 每篇论文独立模式：问答区各论文各一份。热切回时停放的只是这篇的会话状态，
  // 屏幕上的聊天 DOM 可能还是上一篇的 —— 必须按这篇论文自己的会话重放一次。
  // 目标论文键下可能还没有这段会话（例如刚切到按论文模式）：读不到就清掉错误指针，
  // 按正常流程重新接上这篇论文自己的会话（新建或恢复）。
  if (hotView && readSessionScopeMode() === 'paper') {
    try {
      await restoreSession(docId, { only: 'chat' });
    } catch {
      setActiveSidFor(docId, '');
      await sessionsOnDocOpened(docId).catch(() => {});
    }
    sessionsOnSessionChanged({ refresh: false });
    if (superseded()) return;
  }
  // 热切回不会走 sessionsOnDocOpened，入口标记必须在打开结束时清掉，别让下一次冷开误判。
  // 极端情况（文件夹切换后第一篇正好命中热切回）仍要补一次「打开文件夹时」的策略执行。
  if (hotView) {
    const wasFolderEntry = folderEntryPending;
    folderEntryPending = false;
    pendingSessionOpen = false;
    if (wasFolderEntry) {
      folderEntryPending = true;
      await sessionsOnDocOpened(docId);
      if (superseded()) return;
    }
  }
  // 换论文了：会话条要跟着换成这一篇的当前会话名（热切回直接用停放区的列表，不再请求）
  tStage = performance.now();
  if (!hotView) await loadSessionList();
  hotMark('sessionList', tStage);
  if (hotTrace) { hotTrace.hot = hotSwitch; window.__lastHotTrace = hotTrace; }
  renderSessionBar();
  // 新会话（历史为空）时，带上这篇论文之前会话的摘要；切换论文/会话后重新算
  loadPaperMemory();
  if (saved?.page && saved.page > 1) await viewer.goToPage(saved.page);
  if (superseded()) return;
  state.viewerDocId = docId;
  // 底栏控件到这一刻才真的可用（`syncFootEnabled` 要求 viewerDocId === doc.docId）
  syncFootEnabled(true);
  refreshReturnButton();
  saveProgress();
  renderScopeMenu();
  // 后台判定页型（是否有文本层 / 是否扫描件）：不阻塞首屏，扫描件提示只在结果出来后才弹。
  // 之后「问答带不带页图」「读懂论文能不能按图理解」都依赖它。
  startDocProfileScan(docId);
  if (state.useFullText) warmDocText();
}

/** pdf.js 在加载任务被销毁时会抛这类异常，属于「这次加载作废了」，不是真失败 */
const isAbortish = (e) => /abort|destroy|cancel|stale/i.test(`${e?.name || ''} ${e?.message || ''}`);


async function renderOutline() {
  const list = $('#outlineList');
  const myDoc = state.doc?.docId;
  list.innerHTML = '';
  $('#outlineCount').textContent = '';
  if (!viewer?.pdf) return;
  let items = [];
  try { items = await viewer.getOutline(); } catch { items = []; }
  if (state.doc?.docId !== myDoc) return;
  if (!items.length) {
    list.append(el('li', { class: 'empty', text: '这篇 PDF 没有书签目录' }));
    return;
  }
  $('#outlineCount').textContent = `(${items.length})`;
  for (const it of items) {
    list.append(el('li', {
      class: `lv${Math.min(5, it.level)}`,
      title: it.top !== null && it.top !== undefined ? `${it.title}（点它标题会顶到最上面）` : it.title,
      text: it.title,
      // 有目标 Y 就精确停在标题上；没有（Fit/FitV 这类）才退回滚到页顶
      onclick: () => { if (it.page) jumpToDestWithHistory(it, { smooth: true }); },
    }));
  }
}

async function renderNotes() {
  const list = $('#notesList');
  const myDoc = state.doc?.docId;
  list.innerHTML = '';
  if (!myDoc) return;
  try {
    const r = await fetch(`/api/notes?doc=${encodeURIComponent(myDoc)}`);
    if (state.doc?.docId !== myDoc) return;
    if (r.ok) state.highlights = (await r.json()).items || [];
  } catch { /* 忽略 */ }
  if (state.doc?.docId !== myDoc) return;
  viewer?.setHighlights(state.highlights);
  $('#notesCount').textContent = state.highlights.length ? `(${state.highlights.length})` : '';
  // 笔记可能在别处被删（左栏删除 / 换论文），回答卡片上的图标要跟着回到「未保存」
  syncAllAnswerNoteButtons();
  if (!state.highlights.length) {
    list.append(el('li', { class: 'empty', text: '还没有笔记' }));
    return;
  }
  for (const h of [...state.highlights].sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    list.append(el('li', {
      dataset: { id: h.id },
      title: h.note || h.text || '',
      onclick: (e) => {
        if (e.target.closest('.nact')) return;
        if (h.page) jumpToPageWithHistory(h.page, { smooth: true });
      },
    },
      el('div', { class: 'np', text: `p.${h.page}${h.note ? ' · 有笔记' : ''}` }),
      // 回答存下来的笔记标一下来源，免得和「正文划选收藏」混在一起（只是一个提示词，不是新数据）
      h.source === 'answer' ? el('div', { class: 'nflag', text: '来自回答' }) : null,
      el('div', { class: 'nt', text: h.text }),
      h.note ? el('div', { class: 'nt nnote', text: h.note }) : null,
      el('div', { class: 'nact' },
        el('button', { title: '写 / 改笔记', onclick: () => openNoteEditor(h) }, iconEl('pencil', { size: 14 })),
        el('button', { class: 'del', title: '删除', onclick: () => deleteNoteItem(h.id) }, iconEl('close', { size: 14 })),
      ),
    ));
  }
}

async function saveNotes() {
  if (!state.doc) return;
  const r = await fetch(`/api/notes?doc=${encodeURIComponent(state.doc.docId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: state.highlights }),
    });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function addHighlight(sel, note = '') {
  if (!sel) return;
  const text = sel.cleanText || cleanText(sel.text || '');
  const groups = sel.rectsByPage && Object.keys(sel.rectsByPage).length
    ? sel.rectsByPage
    : { [sel.page || viewer?.current || 1]: sel.rects || [] };
  const added = [];
  for (const [pageStr, rects] of Object.entries(groups)) {
    added.push({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      page: Number(pageStr),
      rects: rects || [],
      text: text.slice(0, 2000),
      note: added.length === 0 ? note : '',
      ts: Date.now(),
    });
  }
  if (!added.length) return;
  state.highlights.push(...added);
  viewer?.setHighlights(state.highlights);
  await saveNotes();
  await renderNotes();
  return added[0];
}


/** 这篇论文里，byId 对应的那条笔记还在不在（可能在左栏被删掉了） */
function findAnswerNote(byId) {
  if (!byId) return null;
  return state.highlights.find((h) => h.id === byId) || null;
}

/** 回答卡片的笔记按钮：已保存态用同一张纸把加号换成对勾，并常亮强调色 */
function answerNoteButton(entry) {
  const saved = !!findAnswerNote(entry.root.__noteId);
  const label = saved ? '已在笔记中' : '添加到笔记';
  const btn = el('button', {
    class: `act-icon note-act${saved ? ' saved' : ''}`,
    title: label,
    'aria-label': label,
    onclick: () => openAnswerNoteEditor(entry),
  }, iconEl(saved ? 'note-check' : 'note-plus'));
  entry.root.__noteBtn = btn;
  return btn;
}

/** 状态 2：窄标题行（默认就是用户的问题），右侧只有确认 / 取消两个图标 */
function openAnswerNoteEditor(entry) {
  const root = entry.root;
  if (root.__noteEditor) { root.__noteEditor.querySelector('input')?.focus(); return; }
  const existing = findAnswerNote(root.__noteId);
  const input = el('input', {
    class: 'note-title',
    type: 'text',
    value: (existing?.text || root.__question || '').slice(0, 120),
    placeholder: '笔记标题（默认用你的问题）',
    'aria-label': '笔记标题',
  });
  const row = el('div', { class: 'note-edit' },
    el('span', { class: 'ic' }, iconEl('note-plus', { size: 14 })),
    input,
    el('span', { class: 'note-edit-acts' },
      el('button', {
        class: 'act-icon', title: '保存笔记', 'aria-label': '保存笔记',
        onclick: () => confirmAnswerNote(entry),
      }, iconEl('check')),
      el('button', {
        class: 'act-icon', title: '取消', 'aria-label': '取消保存笔记',
        onclick: () => { closeAnswerNoteEditor(entry); toast('已取消，没有写入笔记', '', 1400); },
      }, iconEl('close')),
    ),
  );
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmAnswerNote(entry); }
    if (e.key === 'Escape') { e.preventDefault(); closeAnswerNoteEditor(entry); }
  });
  root.__noteEditor = row;
  root.append(row);
  setTimeout(() => { input.focus(); input.select(); }, 20);
}

function closeAnswerNoteEditor(entry) {
  const row = entry.root.__noteEditor;
  if (row) { row.remove(); entry.root.__noteEditor = null; }
}

/** 状态 3/4：写进 notes 存储 → 按钮变已保存 → 左栏列表同步增加一项 */
async function confirmAnswerNote(entry) {
  const root = entry.root;
  const row = root.__noteEditor;
  if (!row) return;
  const rec = root.__sessionRecord || {};
  const question = String(root.__question || rec.quote || '').trim();
  const answer = String(rec.text || '').trim();
  if (!answer) { toast('这条回答还没有内容，先等它生成完', 'err', 2200); return; }
  const title = (row.querySelector('input')?.value || '').trim() || question || '来自回答的笔记';
  // 只记一个主依据页：优先记录里那一页（发问时那一页 / 引用所在页），退回当前页
  const page = Number(rec.page || viewer?.current || 0) || 0;

  const existing = findAnswerNote(root.__noteId);
  const item = existing || {
    id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    source: 'answer',
    rects: [],
    ts: Date.now(),
  };
  item.text = title.slice(0, 2000);
  item.note = answer.slice(0, 8000);
  item.page = page;
  item.ts = Date.now();
  if (!existing) state.highlights.unshift(item);   // 列表按 ts 倒序，直接把新的排最前
  root.__noteId = item.id;
  closeAnswerNoteEditor(entry);

  try {
    await saveNotes();
    await renderNotes();
    syncAnswerNoteButton(root);
    toast('已存进笔记', 'ok', 1300);
  } catch (e) {
    toastAction(`笔记保存失败：${e.message}，内容仍保留在这一条上。`, '重试',
      async () => { await saveNotes(); await renderNotes(); syncAnswerNoteButton(root); toast('已存进笔记', 'ok'); },
      'err', 12000);
  }
}
/** 按当前是否已保存，把按钮切到「加号 / 对勾」两态之一 */
function syncAnswerNoteButton(root) {
  const btn = root.__noteBtn;
  if (!btn) return;
  const saved = !!findAnswerNote(root.__noteId);
  const label = saved ? '已在笔记中' : '添加到笔记';
  btn.replaceChildren(iconEl(saved ? 'note-check' : 'note-plus'));
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.classList.toggle('saved', saved);
}

/** 会话恢复 / 左栏删除笔记之后，让按钮重新对上真实状态（找不到就是未保存） */
function syncAllAnswerNoteButtons() {
  for (const node of $$('#aiArea .msg.assistant')) {
    if (node.__noteBtn) syncAnswerNoteButton(node);
  }
}

/* 点正文里的 [12]：跳到文末那条参考文献，并可以一键去 arXiv/OpenAlex/Crossref 找它的 PDF */

function initCiteBox() {
  $('#citeClose').onclick = () => $('#citeBox').classList.add('hidden');
  $('#citeSearch').onclick = () => searchCite();
  $('#citeReturn').onclick = async () => {
    await returnToPreviousPosition();
    $('#citeBox').classList.add('hidden');
  };
  // 阶段 3：详情面板（从关系列表点进来时没有「返回原位置」这个语义，改用「跳回正文」）
  $('#citeJump').onclick = () => jumpToCiteInBody();
  $('#citeCopy').onclick = () => copyText(state.cite?.ref?.text || '');
  document.addEventListener('mousedown', (e) => {
    if ($('#citeBox').classList.contains('hidden')) return;
    if (e.target.closest('#citeBox') || e.target.closest('.cite-link')) return;
    // 热点自己不吃鼠标事件，`e.target` 不再是 `.cite-link`（见 style.css），按坐标再判一次，
    // 免得「点 [n] 时先把卡片关掉、再重新打开」闪一下
    if (viewer?.citeAt?.(e.clientX, e.clientY)) return;
    $('#citeBox').classList.add('hidden');
  });
}

/** 详情面板的「跳回正文」：到 PDF 里这条参考文献所在的页面去，并收起卡片 */
function jumpToCiteInBody() {
  const page = Number(state.cite?.ref?.page) || 0;
  $('#citeBox').classList.add('hidden');
  if (page > 0) jumpToPageWithHistory(page, { smooth: true });
}

async function handleCite({ nums, page, anchor }) {
  const n = nums[0];
  const citeSeq = (state.citeSeq = (state.citeSeq || 0) + 1);
  const ref = await viewer.findReference(n);
  // 连点不同引用时，旧请求不能把新卡片覆盖掉。
  if (citeSeq !== state.citeSeq) return;
  if (!ref) { toast(`正文里没找到 [${n}] 对应的文献条目`, 'err', 3000); return; }
  // 只比较「这一个编号的条目」是否就在当前页。不能因为同页存在其它参考文献条目，
  // 就把结论段/表格里的正文引用误判成已经在文献表页。
  const onReferencePage = ref.page === page;
  showCiteBox(n, ref, anchor, { canReturn: !onReferencePage });
  if (!onReferencePage) jumpToPageWithHistory(ref.page, { smooth: true });
}

function placeBox(box, anchor) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(400, vw - 24);
  const left = clamp(anchor ? anchor.left : vw - w - 30, 10, Math.max(10, vw - w - 10));
  let top = anchor ? anchor.bottom + 10 : 90;
  if (top > vh - 240 && anchor) top = Math.max(52, anchor.top - 250);
  top = clamp(top, 52, Math.max(52, vh - 240));
  box.style.width = `${w}px`;
  // 用户把这个卡片拖动过就沿用它挪到的位置，否则按锚点自动摆
  const p = applyCardPos(box, left, top);
  box.style.left = `${p.left}px`;
  box.style.top = `${p.top}px`;
}

function showCiteBox(n, ref, anchor, { canReturn = true } = {}) {
  state.cite = { n, ref };
  const box = $('#citeBox');
  box.classList.remove('hidden');
  $('#citeReturn').classList.toggle('hidden', !canReturn);
  $('#citeTitle').textContent = `参考文献 [${n}] · p.${ref.page}`;
  $('#citeText').textContent = ref.text;
  $('#citeResult').innerHTML = '';
  renderCiteDetail();
  placeBox(box, anchor);
}

function renderCiteDetail() {
  const out = $('#citeDetail');
  if (!out) return;
  out.replaceChildren();
  const ref = state.cite?.ref;
  if (!ref) return;
  const docId = state.doc?.docId || null;

  if (ref.lib) {
    out.append(el('div', { class: 'cite-item' },
      el('div', { class: 'ci-top' }, el('span', { class: 'ci-badge', text: '书架已有' })),
      el('div', { class: 'cd-name', text: ref.lib.name.replace(/\.pdf$/i, '') }),
      el('div', { class: 'ci-acts' },
        el('button', {
          text: '打开',
          onclick: () => {
            $('#citeBox').classList.add('hidden');
            openDoc({ name: ref.lib.name, url: ref.lib.url, docId: ref.lib.docId });
          },
        }))));
  }

  const slot = docId ? relSlotIfAny(docId, ref) : null;
  if (!slot || slot.status === 'idle' || slot.status === 'local') return;
  if (slot.status === 'loading') {
    out.append(el('div', { class: 'cite-msg', text: '正在查 arXiv / OpenAlex / Crossref…' }));
    return;
  }
  if (slot.status === 'none') {
    out.append(el('div', { class: 'cite-msg', text: '公开库里没查到这篇的开放版本；可以点下面的「找这篇的 PDF」再搜一遍。' }));
    return;
  }
  if (slot.status === 'error') {
    out.append(el('div', { class: 'cite-msg err', text: `上次查询失败：${slot.fail || '未知原因'}` }));
    out.append(el('button', {
      class: 'cd-btn', text: '重试',
      onclick: () => lookupRefPdf(state.cite?.ref),
    }));
    return;
  }
  // pdf / landing：已知的开放版本
  const link = searchResultUrl(slot.found);
  out.append(el('div', { class: 'cite-item' },
    el('div', { class: 'ci-top' },
      el('span', {
        class: 'ci-badge' + (slot.found?.pdfUrl ? ' pdf' : ''),
        text: slot.found?.pdfUrl ? 'PDF 直链' : (slot.found?.source || '落地页'),
      }),
      slot.found?.year ? el('span', { text: slot.found.year }) : null,
      slot.found?.venue ? el('span', { text: String(slot.found.venue).slice(0, 26) }) : null),
    el('div', { class: 'ci-title', text: slot.found?.title || slot.guessed || '(无标题)' }),
    el('div', { class: 'ci-acts' },
      link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: '打开链接' }) : null,
      link ? el('button', { text: '复制链接', onclick: () => copyText(link) }) : null)));
}

async function searchCite() {
  const ref = state.cite?.ref;
  if (!ref) return;
  const docId = state.doc?.docId || null;
  const myGen = state.relGen;
  const btn = $('#citeSearch');
  const out = $('#citeResult');
  btn.disabled = true;
  out.innerHTML = '<div class="cite-msg">正在查 arXiv / OpenAlex / Crossref…</div>';
  try {
    const r = await fetch(`/api/ref-search?q=${encodeURIComponent(ref.text)}`);
    const data = await r.json();
    if (relStale(docId, myGen)) return;          // 换论文了：这次结果属于上一篇，一个字都不写
    renderCiteResults(data);
    // 顺手把结论同步到关系列表的显式状态（列表里同一行的小徽标跟着变，不用再单独查一次）
    applyResultsToSlot(docId, ref, data);
    renderRelations();
    renderCiteDetail();
  } catch (e) {
    if (relStale(docId, myGen)) return;
    out.innerHTML = `<div class="cite-msg err">检索失败：${esc(e.message)}</div>`;
    markSlotError(docId, ref, e.message);
    renderRelations();
    renderCiteDetail();
  } finally {
    btn.disabled = false;
  }
}

function renderCiteResults(data) {
  const out = $('#citeResult');
  out.innerHTML = '';
  const list = data?.results || [];
  const got = String(data?.title || '').trim();
  if (got) {
    const hint = el('div', { class: 'cite-msg' });
    hint.append(document.createTextNode(data?.titleGuessed === false
      ? '没能从这条文献里认出标题，这次用整条文献串检索：'
      : '按标题检索：'));
    hint.append(el('b', { text: got }));
    out.append(hint);
  }
  if (!list.length) {
    const why = data?.dropped ? `（已丢掉 ${data.dropped} 条与标题无关的结果）` : '';
    out.append(el('div', { class: 'cite-msg', text: `几家公开库里都没查到这个标题的开放版本${why}，可以直接用下面的搜索引擎链接。` }));
  }
  for (const r of list) {
    const link = r.pdfUrl || r.url || '';
    if (!link) continue;
    out.append(el('div', { class: 'cite-item' },
      el('div', { class: 'ci-top' },
        el('span', { class: 'ci-badge' + (r.pdfUrl ? ' pdf' : ''), text: r.pdfUrl ? 'PDF 直链' : r.source }),
        r.year ? el('span', { text: r.year }) : null,
        r.venue ? el('span', { text: r.venue.slice(0, 26) }) : null,
      ),
      el('div', { class: 'ci-title', text: r.title || '(无标题)' }),
      el('div', { class: 'ci-acts' },
        el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: '打开链接' }),
        el('button', { text: '复制链接', onclick: () => copyText(link) }),
      ),
    ));
  }
  const extra = el('div', { class: 'cite-acts' });
  if (data?.scholarUrl) extra.append(el('a', { href: data.scholarUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Google Scholar' }));
  if (data?.searchUrl) extra.append(el('a', { href: data.searchUrl, target: '_blank', rel: 'noopener noreferrer', text: '网页搜索 PDF' }));
  if (extra.children.length) out.append(el('div', { class: 'cite-item' }, el('div', { class: 'ci-top' }, el('span', { text: '没找到？' })), extra));
}
/* 点气泡上的「✎」= 收藏这段文字，然后立刻弹出编辑框写笔记；
   正文右边缘会出现一个小书签，点它就能随时读 / 改这条笔记。 */

function initNoteBox() {
  $('#noteSave').onclick = () => saveNoteBox();
  $('#noteClose').onclick = () => saveNoteBox();          // 关闭即保存，不会白写
  $('#noteDelete').onclick = () => deleteNoteBox();
  $('#noteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNoteBox(); }
    if (e.key === 'Escape') { e.preventDefault(); saveNoteBox(); }
  });
  // 点到别处也保存关闭，避免笔记丢失
  document.addEventListener('mousedown', (e) => {
    if ($('#noteBox').classList.contains('hidden')) return;
    if (e.target.closest('#noteBox') || e.target.closest('.hl-pin')) return;
    saveNoteBox();
  });
}

function openNoteEditor(item, anchorBox) {
  if (!item) return;
  state.editingId = item.id;
  const box = $('#noteBox');
  box.classList.remove('hidden');
  $('#noteTitle').textContent = `笔记 · p.${item.page}`;
  $('#noteQuote').textContent = item.text || '';
  $('#noteText').value = item.note || '';
  $('#noteHint').textContent = 'Ctrl+Enter 保存 · 留空也会保存这段文字';

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(380, vw - 24);
  const left = clamp(anchorBox ? anchorBox.left : vw - w - 30, 10, Math.max(10, vw - w - 10));
  let top = anchorBox ? anchorBox.bottom + 10 : 90;
  if (top > vh - 230 && anchorBox) top = Math.max(52, anchorBox.top - 250);
  top = clamp(top, 52, Math.max(52, vh - 230));
  box.style.width = `${w}px`;
  // 拖动过的位置优先，没拖过才按锚点自动摆
  const pos = applyCardPos(box, left, top);
  box.style.left = `${pos.left}px`;
  box.style.top = `${pos.top}px`;
  setTimeout(() => $('#noteText').focus(), 30);
}

function openNoteEditorById(id) {
  const item = state.highlights.find((x) => x.id === id);
  if (item) openNoteEditor(item);
}

function closeNoteBox() {
  $('#noteBox').classList.add('hidden');
  state.editingId = null;
}

async function saveNoteBox() {
  const id = state.editingId;
  if (!id) { closeNoteBox(); return; }
  const item = state.highlights.find((x) => x.id === id);
  const val = $('#noteText').value.trim();
  closeNoteBox();
  if (!item) return;
  if ((item.note || '') === val) return;      // 没改就不写盘
  item.note = val;
  try {
    await saveNotes();
    viewer?.setHighlights(state.highlights);
    await renderNotes();
    toast(val ? '笔记已保存' : '已收藏这段文字', 'ok', 1300);
  } catch (e) {
    toastAction(`笔记保存失败：${e.message}，内容仍保留。`, '重试', async () => {
      await saveNotes(); viewer?.setHighlights(state.highlights); await renderNotes(); toast('笔记已保存', 'ok');
    }, 'err', 12000);
  }
}

async function deleteNoteBox() {
  const id = state.editingId;
  closeNoteBox();
  if (id) await deleteNoteItem(id);
}

async function deleteNoteItem(id) {
  const previous = state.highlights;
  state.highlights = state.highlights.filter((x) => x.id !== id);
  viewer?.setHighlights(state.highlights);
  try { await saveNotes(); await renderNotes(); syncAllAnswerNoteButtons(); }
  catch (e) {
    state.highlights = previous;
    viewer?.setHighlights(previous);
    await renderNotes();
    syncAllAnswerNoteButtons();
    toastAction(`删除未保存：${e.message}，笔记已恢复。`, '重试', () => deleteNoteItem(id), 'err', 12000);
  }
}

function initSelection() {
  const v = $('#viewer');
  // 原生 ::selection 已设成透明，这里自己画不重叠的方块（拖动过程中也在刷新）
  document.addEventListener('selectionchange', throttle(() => {
    if (state._dragSelecting && state._downAt && state._lastPt) {
      viewer?.repairSelectionEnds?.({ anchor: state._downAt, focus: state._lastPt, allowCollapsed: true });
    }
    const info = viewer?.getSelectionInfo();
    // 只在「确实有一个新选区」时更新方块。
    // 选区为空时故意不动：虚拟化把页面卸掉时浏览器也会顺手把选区清空，
    // 那时若跟着清，滚回来就再也看不到刚才选的是哪一段了（用户反馈的 bug）。
    // 真正的「取消选择」由点击别处 / Esc / 做出新选择来触发。
    if (info) viewer?.paintSelection(info.rectsByPage);
  }, 50));
  v.addEventListener('touchend', () => setTimeout(onSelectionChanged, 60));

  document.addEventListener('mouseup', (e) => {
    if (e.target?.closest?.('#bubble, #citeBox, #noteBox, #settingsModal')) return;
    const down = state._downAt;
    const moved = down
      ? Math.hypot(e.clientX - down.x, e.clientY - down.y)
      : 999;
    const isClick = moved < 5;
    const onControl = !!e.target?.closest?.('button, input, select, textarea, label, a');
    state._downAt = null;
    state._lastPt = null;
    /* 右栏回答 / 译文里的选区：走同一个气泡，但只保留「加入问答 / 直接解释 / 复制」。
       和正文选区互斥（浏览器只允许一个 DOM 选区，切过来时正文选区已经没了）。 */
    if (rightSelectionHost()) {
      state._dragSelecting = false;
      setTimeout(() => onRightSelectionChanged({ deselect: isClick && !onControl }), 10);
      return;
    }
    /* 正文 [n] 热点：`.cite-link` 是 pointer-events:none 的（不然 mousedown 落在 div 上，
       浏览器给不出真正的文字锚点，一次小拖选能选出跨页的 2700 多字），
       所以点击改成在这里按坐标判命中。 */
    if (isClick && !onControl) {
      const cite = viewer?.citeAt?.(e.clientX, e.clientY);
      if (cite) {
        // 单击热点和「点空白」一样会把浏览器选区塌掉，这里照样清一遍（否则气泡没了、
        // state.selection 还在，按 T 会翻出旧文字）
        onSelectionChanged({ deselect: true });
        scheduleCiteAction(cite, e.detail || 1);
        return;
      }
    }
    setTimeout(() => onSelectionChanged({
      deselect: isClick && !onControl,
      down,
      up: { x: e.clientX, y: e.clientY },
    }), 10);
  });

  /* 记录拖动中的实时位置：选区跑偏时要靠它算「终点该落在哪个字上」 */
  document.addEventListener('mousemove', (e) => {
    if (state._downAt) state._lastPt = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  /* 双击的那一下会先走一次单击路径 —— 卡片一开就会跳到文末，用户再也选不了这个 [5]。
     所以延迟一点点再开卡片；第二下（或 dblclick）一来就取消。 */
  document.addEventListener('dblclick', () => cancelCiteAction());

  /**
   * 拖着选到窗口外面松手，页面里根本收不到 mouseup。
   * 鼠标一离开窗口就当作松手处理（此时选区已经成型了）。
   */
  document.documentElement.addEventListener('mouseleave', () => {
    if (!state._dragSelecting) return;
    state._dragSelecting = false;
    // 把最后两个已知落点带上：选区一端若被浏览器算成容器位置，出窗口前也要纠正一次
    const down = state._downAt;
    const up = state._lastPt;
    state._downAt = null;
    state._lastPt = null;
    setTimeout(() => onSelectionChanged({ down, up }), 10);
  });

  document.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (t?.closest?.('#bubble, #citeBox, #noteBox, #settingsModal')) return;
    state._downAt = { x: e.clientX, y: e.clientY };
    // 在正文里按下 = 准备开始新的选择，标记一下防止漏掉「窗口外松手」
    if (t?.closest?.('#viewer')) state._dragSelecting = true;
  });

  // 只有正文区、整个文档或右栏结果区滚动时才收起气泡。
  // scroll 不冒泡，但 capture 阶段 window 能收到所有元素的滚动事件，
  // 不加判断的话，右侧面板流式输出时自动滚动会把气泡误关掉。
  window.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body
      || t === $('#viewer') || (t?.closest && t.closest('#aiArea'))) hideBubble();
  }, true);

  // 点气泡按钮时别把选区弄丢
  $('#bubble').addEventListener('mousedown', (e) => e.preventDefault());
  $('#bubble').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    // 用最新选区：用户可能在气泡弹出后又调整了选择范围
    const fresh = viewer.getSelectionInfo();
    const sel = fresh ? { ...fresh, cleanText: cleanText(fresh.text) } : state.selection;
    if (!sel?.cleanText) return;
    state.selection = sel;
    hideBubble();
    switch (btn.dataset.act) {
      case 'translate': doTranslate(sel); break;
      case 'explain': doExplain(sel); break;
      case 'add': addToChat(sel); break;
      case 'note': {
        const item = await addHighlight(sel);
        if (item) openNoteEditor(item, sel.box);
        break;
      }
      case 'copy': copyText(sel.cleanText); break;
      default: break;
    }
  });
}

function onSelectionChanged({ deselect = false, down = null, up = null, retry = true } = {}) {
  state._dragSelecting = false;
  if (down && up) viewer?.repairSelectionEnds?.({ anchor: down, focus: up, allowCollapsed: true });
  const info = viewer?.getSelectionInfo();
  if (!info) {
    const dragged = !!(down && up) && Math.hypot(up.x - down.x, up.y - down.y) >= 4;
    /* 文本层的 span 正在重建时（虚拟化重画、切片刷新）算不出字符位置，
       这一次纠正就会落空 —— 表现是「拖了半天一个字都没选出来」。
       这种时候给一次 90ms 后的重试（只重试一次，不会无限循环）。 */
    if (retry && dragged && !deselect) {
      setTimeout(() => onSelectionChanged({ deselect: false, down, up, retry: false }), 90);
      return;
    }
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  let text = cleanText(info.text);
  if (text.length < 2) {
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  // Ctrl/⌘ + 划选：把上一次选区拼到前面（对付被图表/换栏切开的句子）
  const pending = state._pendingMerge;
  state._pendingMerge = null;
  if (pending && !pending.includes(text)) {
    text = `${pending}\n${text}`;
    toast('已拼接上一段选区', 'ok', 1800);
  }
  info.cleanText = text;
  state.selection = info;
  showBubble(info);
}

function showBubble(sel) {
  hideTranslationCard();
  const b = $('#bubble');
  const right = sel?.source === 'right';
  b.dataset.source = right ? 'right' : 'body';
  // 同一套气泡：右栏里翻译 / 写笔记无意义（笔记需要正文锚点），只换文案
  const add = b.querySelector('button[data-act="add"]');
  if (add) {
    const label = add.querySelector('span');
    if (label) label.textContent = right ? '加入问答' : '对话';
    add.title = right
      ? '加入问答区：可以继续加多段文字（不改正文选区）'
      : '加入对话：可以连续加多段文字，也可以加图片 (Q)';
  }
  b.classList.remove('hidden');
  const w = b.offsetWidth || 158;
  const h = b.offsetHeight || 32;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 选区被滚出视口时 box 可能是负数，必须钳进视口，否则气泡会飞到屏幕外点不到
  const left = clamp(sel.box.left + sel.box.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
  let top = sel.box.top - h - 8;
  if (top < 52) top = sel.box.bottom + 8;
  top = clamp(top, 52, Math.max(52, vh - h - 8));
  b.style.left = `${Math.round(left)}px`;
  b.style.top = `${Math.round(top)}px`;
}

function hideBubble() { $('#bubble').classList.add('hidden'); }

/**
 * 当前 DOM 选区是否落在右栏的回答 / 译文正文里。
 * 返回最近的 `.msg .text` 节点（用户自己发的消息不提供入口），否则 null。
 */
function rightSelectionHost() {
  const area = $('#aiArea');
  const sel = window.getSelection();
  if (!area || !sel || !sel.rangeCount || sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const textEl = el?.closest?.('.msg .text');
  if (!textEl || !area.contains(textEl)) return null;
  if (textEl.closest('.msg.user')) return null;
  return textEl;
}

/** 右栏选区：复用同一个气泡，只显示「加入问答 / 直接解释 / 复制」 */
function onRightSelectionChanged({ deselect = false } = {}) {
  if (!rightSelectionHost()) {
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  const selection = window.getSelection();
  const text = cleanText(selection?.toString() || '');
  if (text.length < 2) {
    if (deselect) clearSelectionState();
    else hideBubble();
    return;
  }
  let rect = null;
  try { rect = selection.getRangeAt(0).getBoundingClientRect(); } catch { /* 选区中途失效 */ }
  if (!rect || (!rect.width && !rect.height)) { hideBubble(); return; }
  const sel = {
    text,
    cleanText: text,
    // 右栏文字是对话内容，不是 PDF 某页的原文：绝不能挂页码冒充「第 N 页原文」
    //（用户实测过：把上一轮回答里划的词标成第 2 页原文，模型对着第 2 页图片才发现对不上）。
    page: null,
    source: 'right',
    // 右栏选区没有正文那种跨页 rect 结构，直接用 DOM 选区矩形定位气泡
    box: {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    },
  };
  state.selection = sel;
  showBubble(sel);
}

function hideTranslationCard() { $('#translationCard')?.classList.add('hidden'); }

function showTranslationCard(sel) {
  const card = $('#translationCard');
  const body = $('#translationCardText');
  $('#translationCardQuote').textContent = sel.cleanText || sel.text || '';
  body.innerHTML = '';
  card.classList.remove('hidden');
  const box = sel.box || { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 80, bottom: 80 };
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const gap = 12;
  const left = box.right + gap + w <= window.innerWidth - 8
    ? box.right + gap
    : box.left - gap - w >= 8 ? box.left - gap - w : box.left;
  const top = box.bottom + gap + h <= window.innerHeight - 8
    ? box.bottom + gap : box.top - gap - h;
  placeCard(card, left, top, false);
  return body;
}

let citeActionTimer = 0;
function scheduleCiteAction(cite, detail = 1) {
  cancelCiteAction();
  if (detail >= 2) return;            // 已经是双击的一部分：不抢这一次
  citeActionTimer = setTimeout(() => {
    citeActionTimer = 0;
    handleCite(cite);
  }, 300);
}
function cancelCiteAction() {
  if (!citeActionTimer) return;
  clearTimeout(citeActionTimer);
  citeActionTimer = 0;
}

/**
 * 忘掉当前选区：气泡、页面上的方块、state.selection 三样必须一起清，
 * 只清一部分就会出现「屏幕上没选区，按 T 却翻出旧文字」。
 */
function clearSelectionState() {
  hideBubble();
  state.selection = null;
  state._pendingMerge = null;
  viewer?.paintSelection(null);
}

/* 这两块就是 state.panels 里的 translate / chat：
   显示与否看 visible，顺序看 order，高度看 size。
   分块区仍然是「可选」的：默认一块都不显示，用到哪块自动出现；
   每块都能 ✕ 移除、用底部按钮加回来；块与块之间可以拖动调高度、拖块头上下交换位置。
   注意：**切换显示/位置时绝不重建节点**（只改 DOM 顺序与 hidden 类），否则消息与滚动位置会丢。 */

const blockTitle = (id) => panelTitle(id);
const visibleBlocks = () => visiblePanelsOfDock('right');

/** 确保某个块是打开的（比如有截图进来时自动打开「问答」） */
function showAiBlock(id) {
  if (!state.panels[id].visible) setPanelVisible(id, true);
}

function initAiArea() {
  state._aiVisibleSig = rightPanelsSig();
  renderAiArea();
  // 窗口一变矮，原来拖好的块高度就可能装不下 —— 重新夹一次，别让底部被裁掉
  window.addEventListener('resize', debounce(() => fitBlockSizes(), 150));
}

const TEXT_EDGE_HIT = 10;        // 离边沿多近算"放到那个栏上"（px）
const TEXT_EDGE_BAR_H = 110;     // 悬停提示条的高度（只要一小段，不要整栏）

function initTextEdgeHandle() {
  const side = $('#rightSide');
  const area = $('#aiArea');
  if (!side || !area) return;
  const bar = el('div', { class: 'text-edge-hint', 'aria-hidden': 'true' });
  side.append(bar);

  let drag = null;     // 拖动中的快照：{ edge, width, startX, moved }
  let raf = 0;
  let lastX = 0;
  let lastY = 0;

  /** 这一刻文字列的几何；没有消息 / 侧栏没显示 → null */
  const geo = () => {
    const sr = side.getBoundingClientRect();
    if (sr.width < 20) return null;
    const body = area.querySelector('.ai-block:not(.hidden) > .ai-body');
    const msg = body?.querySelector('.msg');
    if (!body || !msg) return null;
    const br = body.getBoundingClientRect();
    const mr = msg.getBoundingClientRect();
    if (mr.width < 20 || br.height < 40) return null;
    const cs = getComputedStyle(body);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // 可拖到的最宽 = .ai-body 的内容宽度（拖满就两侧留白为 0）
    const contentW = Math.max(1, body.clientWidth - padL - padR);
    return {
      sr, br, contentW,
      left: mr.left, right: mr.right,
      center: (mr.left + mr.right) / 2,
    };
  };

  /** 光标贴在哪条边沿上（不在 .ai-body 的纵向范围内就不算） */
  const edgeAt = (m, x, y) => {
    if (y < m.br.top || y > m.br.bottom) return null;
    const dl = Math.abs(x - m.left);
    const dr = Math.abs(x - m.right);
    if (Math.min(dl, dr) > TEXT_EDGE_HIT) return null;
    return dl <= dr ? 'left' : 'right';
  };

  /** 把那一小段渐变提示条放到某条边沿的某个高度上（相对 #rightSide 定位） */
  const placeBar = (edgeX, clientY, { on = true, dragging = false } = {}) => {
    const sr = side.getBoundingClientRect();
    const x = edgeX - sr.left - side.clientLeft;
    const top = clamp(clientY - sr.top - side.clientTop - TEXT_EDGE_BAR_H / 2,
      4, Math.max(4, sr.height - TEXT_EDGE_BAR_H - 4));
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(top)}px`;
    bar.classList.toggle('on', !!on);
    bar.classList.toggle('dragging', !!dragging);
  };
  const hideBar = () => {
    bar.classList.remove('on', 'dragging');
    side.classList.remove('text-edge-hot');
  };

  const paint = () => {
    raf = 0;
    const m = geo();
    if (!m) { hideBar(); return; }
    if (drag) {
      // 宽度 = 2 × 光标到列中心的距离；夹在 [下限, min(内容宽, 上限)] 之间
      const half = drag.edge === 'right' ? (lastX - m.center) : (m.center - lastX);
      const lo = Math.min(TEXT_COL_MIN, m.contentW);
      const hi = Math.max(lo, Math.min(m.contentW, TEXT_COL_MAX));
      drag.width = Math.round(clamp(2 * half, lo, hi));
      if (drag.moved) {
        // 拖动途中直接写 CSS 变量（不走 applyUiStyle，避免每帧重算整套样式）；
        // 松手时再落到 uiStyle.maxWidth / localStorage。
        document.documentElement.style.setProperty('--ai-max-width', `${drag.width}px`);
      }
      const edgeX = drag.edge === 'right' ? m.center + drag.width / 2 : m.center - drag.width / 2;
      placeBar(edgeX, lastY, { on: true, dragging: true });
      return;
    }
    const edge = edgeAt(m, lastX, lastY);
    if (!edge) { hideBar(); return; }
    side.classList.add('text-edge-hot');
    placeBar(edge === 'left' ? m.left : m.right, lastY);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  const moveDuringDrag = (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 2) drag.moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    schedule();
  };

  const endDrag = () => {
    if (!drag) return;
    // 收尾时先按当前位置算最后一次：不能让"最后一帧还没跑"导致宽度停在上一帧
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    paint();
    const changed = drag.moved && Number.isFinite(drag.width);
    const width = drag.width;
    drag = null;
    window.removeEventListener('pointermove', moveDuringDrag);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    document.body.classList.remove('text-edge-dragging');
    side.classList.remove('text-edge-dragging');
    if (changed) {
      // 走同一条样式出口：uiStyle → --ai-max-width，顺手持久化（刷新 / 重开论文还在）
      uiStyle = { ...uiStyle, maxWidth: width };
      applyUiStyle();
      saveUi();
    }
    hideBar();
  };

  const startIfNear = (e) => {
    if (drag || e.button !== 0 || e.pointerType === 'touch') return;
    const m = geo();
    if (!m) return;
    const edge = edgeAt(m, e.clientX, e.clientY);
    if (!edge) return;
    // 贴边按下 = 拉边沿：别让它变成选字，也别触发消息里的按钮
    e.preventDefault();
    e.stopPropagation();
    lastX = e.clientX;
    lastY = e.clientY;
    drag = { edge, width: Math.round(m.right - m.left), startX: e.clientX, moved: false };
    document.body.classList.add('text-edge-dragging');
    side.classList.add('text-edge-dragging');
    window.addEventListener('pointermove', moveDuringDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    paint();
  };

  // ⚠️ pointerdown 用捕获阶段：要比文本选择 / 消息里的按钮更早拿到按下事件，
  // 只在真的贴边时才拦（e.preventDefault + stopPropagation），其余点击照旧。
  side.addEventListener('pointerdown', startIfNear, true);
  side.addEventListener('pointermove', (e) => {
    if (drag) return;
    lastX = e.clientX;
    lastY = e.clientY;
    schedule();
  }, { passive: true });
  side.addEventListener('pointerleave', () => { if (!drag) hideBar(); });
  // 面板滚走 / 切窗口 / 失焦：别把一条渐变条孤零零留在屏幕上
  window.addEventListener('blur', () => { if (!drag) hideBar(); });
}

function clearAllBlocks() {
  for (const meta of Object.values(state.blockMeta)) meta.body.innerHTML = '';
  chatDomSig = '';
  refreshCounts();
}

/** 换论文时只清译文块：问答块是全局会话共用的，切换论文不重绘它 */
function clearTranslateBlock() {
  const meta = state.blockMeta.translate;
  if (meta) meta.body.innerHTML = '';
  refreshCounts();
}

function clearChatBlock() {
  const meta = state.blockMeta.chat;
  if (meta) meta.body.innerHTML = '';
  chatDomSig = '';
  refreshCounts();
}

function ensureBlock(id) {
  if (state.blockEls[id]) return state.blockEls[id];
  const count = el('span', { class: 'ai-count' });
  const meta0 = AI_BLOCKS.find((b) => b.id === id) || {};
  const hint = el('div', { class: 'ai-hint', text: meta0.hint || '' });
  const body = el('div', { class: 'ai-body' }, hint);
  // 译文面板的工具条只放辅助入口（截图框选）；文字直接用右栏底部的常驻 composer 输入。
  const tools = id === 'translate' ? el('div', { class: 'ai-tools' },
    el('button', {
      type: 'button', class: 'ai-tool-btn',
      title: '框选论文区域放进输入框，再按 Enter 翻译截图里的文字（也可按 R；图片需要视觉模型）',
      onclick: () => {
        if (state.busy) { toast('正在生成中，先等它跑完或点停止再截图翻译', 'err', 3200); return; }
        state.startRegion?.('translate');
      },
    }, iconEl('region'), el('span', { text: '截图翻译' })),
  ) : null;
  const root = el('section', { class: 'ai-block', dataset: { block: id, panel: id } }, tools, body);

  // R7：滚动时刷新底部渐隐（滚到底就摘掉标记）
  body.addEventListener('scroll', updateScrollFades, { passive: true });

  state.blockEls[id] = root;
  state.blockMeta[id] = { body, count };
  // 排布方向（译文块是 column-reverse）要等节点进文档、拿到计算样式之后才知道
  requestAnimationFrame(markReversedBodies);
  return root;
}

function clearDropMarks() {
  for (const node of Object.values(state.blockEls)) node.classList.remove('drop-before', 'drop-after');
}

function visibleSplitPair(belowId) {
  const vis = visibleBlocks();
  const i = vis.indexOf(belowId);
  if (i <= 0) return null;
  const above = vis[i - 1];
  const a = state.blockEls[above];
  const b = state.blockEls[belowId];
  if (!a?.isConnected || !b?.isConnected) return null;
  if (a.classList.contains('hidden') || b.classList.contains('hidden')) return null;
  return { above, below: belowId };
}

/** 两块之间的高度分隔条：拖动时同时改上下两块的高度（只作用于当前可见的那一对） */
function ensureSplit(belowId) {
  if (state.splitEls[belowId]) return state.splitEls[belowId];
  let startAbove = null;      // 按下那一刻上面那一块是谁（拖动途中它变了就说明基准失效）
  let startY = 0;
  let aboveH = 0;
  let belowH = 0;

  const move = (e) => {
    const pair = visibleSplitPair(belowId);
    // 可见集合在拖动途中变过（两块里有一块被藏/被换）：两个基准高度都对不上了，整次拖动作废
    if (!pair || pair.above !== startAbove) return;
    const min = 60;
    const dy = e.clientY - startY;
    let a = aboveH + dy;
    let b = belowH - dy;
    if (a < min) { b -= min - a; a = min; }
    if (b < min) { a -= min - b; b = min; }
    if (a < min || b < min) return;
    state.panels[pair.above].size = Math.round(a);
    state.panels[pair.below].size = Math.round(b);
    fitBlockSizes();
  };
  const up = () => {
    node.classList.remove('dragging');
    document.body.classList.remove('row-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    startAbove = null;
    savePanels();
  };
  const node = el('div', { class: 'ai-split', title: '拖动调整上下两块的高度', tabIndex: 0, role: 'separator', 'aria-orientation': 'horizontal' });
  node.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const pair = visibleSplitPair(belowId);
    if (!pair) return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 24 : -24;
    const ah = state.panels[pair.above].size || state.blockEls[pair.above]?.getBoundingClientRect().height || 120;
    const bh = state.panels[pair.below].size || state.blockEls[pair.below]?.getBoundingClientRect().height || 120;
    if (ah + delta < 60 || bh - delta < 60) return;
    state.panels[pair.above].size = Math.round(ah + delta);
    state.panels[pair.below].size = Math.round(bh - delta);
    fitBlockSizes(); savePanels();
  });
  node.addEventListener('pointerdown', (e) => {
    const pair = visibleSplitPair(belowId);
    if (!pair) return;
    e.preventDefault();
    startAbove = pair.above;
    startY = e.clientY;
    aboveH = state.blockEls[pair.above].getBoundingClientRect().height;
    belowH = state.blockEls[pair.below].getBoundingClientRect().height;
    node.classList.add('dragging');
    document.body.classList.add('row-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  state.splitEls[belowId] = node;
  return node;
}

/** 拖块头换位：把 from 插到 to 的前 / 后，然后按右栏的新顺序重排 order（同一套注册表） */
function moveBlock(from, to, after) {
  const slots = panelsOfDock('right');                 // 右栏所有块（含隐藏的）占的 order 槽位
  const orderValues = slots.map((id) => state.panels[id].order);   // 先把槽位号抄下来再改
  const list = slots.filter((x) => state.panels[x].visible);
  const rest = list.filter((x) => x !== from);
  let idx = rest.indexOf(to);
  if (idx < 0) return;
  if (after) idx += 1;
  rest.splice(idx, 0, from);
  slots.forEach((slotId, i) => {
    const nextId = rest[i];
    if (nextId) state.panels[nextId].order = orderValues[i];
  });
  savePanels();
  applyPanels();
}

/** 显示 / 隐藏一个右栏块（等价于 setPanelVisible，名字留着给 2.1 的调用点用） */
function setBlockVisible(id, on) {
  setPanelVisible(id, on);
}

function fitBlockSizes() {
  // 每一栏各自有一个结果块；高度由 .ai / .ai-block 的 flex 链接管，
  // 不再把旧存档 size 写回 DOM。
  for (const n of [1, 2]) {
    const id = rightPanelInCol(n);
    const node = id ? state.blockEls[id] : null;
    if (!node) continue;
    node.classList.remove('sized');
    node.style.height = '';
  }
  // R7：块高变了 → 是否还能滚动也会变，下一帧刷新底部渐隐
  requestAnimationFrame(updateScrollFades);
}

function refreshCounts() {
  for (const meta of Object.values(state.blockMeta)) {
    const n = meta.body.querySelectorAll('.msg').length;
    meta.count.textContent = n ? `(${n})` : '';
    meta.body.querySelector('.ai-hint')?.classList.toggle('hidden', n > 0);
  }
  updateScrollFades();
}

function updateScrollFades() {
  for (const node of Object.values(state.blockEls)) {
    if (!node) continue;
    const body = node.querySelector('.ai-body');
    if (!body) continue;
    const more = body.scrollHeight - body.clientHeight - body.scrollTop > 2;
    node.classList.toggle('has-scroll', more);
  }
}

/** 同一栏里真有几块在显示？超过一块就按 order 只留最靠前的那块（一栏只开一个） */
function enforceOnePerColumn() {
  for (const n of [1, 2]) {
    const list = PANEL_IDS_RIGHT
      .filter((id) => colOf(id) === n && state.panels[id].visible && state.panels[id].dock === 'right')
      .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
    for (const id of list.slice(1)) {
      state.panels[id].visible = false;
      flushPanelVisibility(id, false);
      rememberBodyScroll(id);          // 它马上要被停进脱离文档的停放区
    }
  }
}

/**
 * 把「模型里说不可见」落到节点上：挂 hidden 类 + data-dock。
 * 不能整个 applyPanels 递归一遍（enforceOnePerColumn 就在 applyPanels 里面），所以这里只做这两件事。
 */
function flushPanelVisibility(id, visible) {
  const node = panelEl(id);
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.dataset.dock = state.panels[id].dock;
}

function rightPanelInCol(n) {
  const list = PANEL_IDS_RIGHT
    .filter((id) => colOf(id) === n && state.panels[id].visible && state.panels[id].dock === 'right')
    .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
  return list[0] || '';
}

function composerMode() { return rightPanelInCol(1) === 'translate' ? 'translate' : 'chat'; }
function syncComposerMode(id = rightPanelInCol(1)) {
  const translating = id === 'translate';
  const input = $('#chatInput');
  const clip = $('#clipBtn');
  const sendBtn = $('#sendBtn');
  if (input) {
    input.placeholder = translating ? '粘贴或输入要翻译的文字…（Enter 翻译，Shift+Enter 换行）' : '问点什么…（Enter 发送）';
    if (translating) input.maxLength = 20000;
    else input.removeAttribute('maxlength');
  }
  if (clip) {
    // 问答 / 译文都用同一个截图入口：截图先放进下方输入框，和问答一致（用户 m05190）。
    clip.title = translating ? '截图翻译：框选后放进输入框，再按 Enter 翻译' : '截图 / 长截图，加进对话';
    clip.classList.remove('hidden');
  }
  if (sendBtn) sendBtn.title = translating ? '翻译' : '发送';
  const target = $('#translateTargetLang');
  if (target && !target.dataset.ready) {
    try {
      const saved = localStorage.getItem('reader.translate.targetLang');
      if (saved === '中文' || saved === 'English') target.value = saved;
    } catch { /* 忽略 */ }
    target.addEventListener('change', () => { try { localStorage.setItem('reader.translate.targetLang', target.value); } catch { /* 忽略 */ } });
    target.dataset.ready = '1';
  }
}

/** 一列的结果区长什么样（只改 DOM，不改导航） */
function renderCol(n) {
  const area = rightAreaEl(n);
  if (!area) return;
  const id = rightPanelInCol(n);
  // 把当前面板写到 <aside>：问答与译文共用常驻 composer，由模式切换提示、目标语言和发送行为。
  const col = rightColEl(n);
  if (col) {
    if (id) col.dataset.activePanel = id;
    else delete col.dataset.activePanel;
  }
  if (n === 1) syncComposerMode(id);
  if (!id) {
    if (n === 1) {
      // 空态：译文 / 问答一块都没开。文案改成右键也能开第 2 栏（入口在图标坞上）
      const empty = area.querySelector(':scope > .ai-empty');
      if (empty && area.children.length === 1) return;
      area.replaceChildren(el('div', { class: 'ai-empty' },
        el('div', { text: '结果会出现在这里' }),
        el('div', { text: '从下面这一排图标打开译文 / 问答，或在正文中选择文字开始。' }),
      ));
    } else {
      area.replaceChildren(el('div', { class: 'ai-empty' },
        el('div', { text: '这一栏还空着' }),
        el('div', { text: '右键下面的图标 →「放到第 2 栏」，或把图标拖出去开一个应用内卡片。' }),
      ));
    }
    return;
  }
  // 会话选择卡片模式：chat 栏优先挂「继续上次 / 新建」卡片（sessions.js 动态创建，不写死进 index.html）
  if (id === 'chat') {
    const card = sessionsEntryCardEl();
    if (card && card.dataset.show === '1') {
      if (area.children.length === 1 && area.firstElementChild === card) return;
      rememberBodyScroll('chat');
      area.replaceChildren(card);
      applyBodyScroll('chat');
      return;
    }
  }
  const block = ensureBlock(id);
  if (area.children.length === 1 && area.firstElementChild === block) return;
  rememberBodyScroll(id);          // 换块 / 变空态之前先记位置（节点会短暂离开文档）
  area.replaceChildren(block);
  applyBodyScroll(id);             // 同一帧补回（见 parkRightPanel 的注释）
}

/**
 * 右栏结果区重排（applyPanels 的第 ③ 步走这一条）：先按「谁该在结果区」把两块面板
 * 各自停到该在的容器里，再渲染第 1 栏。右栏恒为一栏，不再有第 2 栏。
 */
function renderCols() {
  for (const id of PANEL_IDS_RIGHT) parkRightPanel(id, dockedAreaFor(id));
  renderCol(1);
  fitBlockSizes();
  refreshCounts();
  renderAiBar();
  // 会话条跟着「问答块开没开」走（译文页不该挂着会话信息）
  renderSessionBar();
}

function renderAiArea() {
  renderCols();
}

function renderAiBar() {
  const host = aiBarEl(1);
  if (!host) return;
  // 顺序 = 右栏面板的 order
  const ids = PANEL_IDS_RIGHT
    .slice()
    .sort((a, b) => (state.panels[a].order - state.panels[b].order) || (PANEL_IDS.indexOf(a) - PANEL_IDS.indexOf(b)));
  const here = rightPanelInCol(1);
  host.replaceChildren(...ids.map((id) => {
    const meta = AI_BLOCKS.find((b) => b.id === id) || {};
    const on = here === id;
    const label = blockTitle(id);
    const btn = el('button', {
      type: 'button',
      class: `aibar-btn${on ? ' on' : ''}`,
      role: 'tab',
      'aria-selected': on ? 'true' : 'false',
      'aria-pressed': on ? 'true' : 'false',
      dataset: { block: id, col: '1' },
      text: label,
      title: on ? `「${label}」（当前）` : `打开「${label}」 —— ${meta.hint || ''}`,
    });
    bindPanelToggleGestures(btn, id, {
      onClick: () => { if (!on) setPanelVisible(id, true); },
    });
    return btn;
  }));
}


/**
 * 一条消息（Copilot 风格扁平结构）：
 *   角色行（小圆标 + 类型 + 页码 + 回跳） / 引用原文（细竖线，不做盒子） / 截图 / 正文 / 底部小动作
 * 没有边框卡片，也没有任何折叠。
 */
function addEntry({ block = 'chat', tag, page, quote, imageSrc, thumbs, kind = 'assistant', text, retry, restore = false, reveal = true, docId = '', docTitle = '' }) {
  // 恢复历史时只把内容装回对应块，不强行打开右栏；用户可从下方开关按需展开。
  if (!restore && reveal && !state.panels[block].visible) setPanelVisible(block, true);
  // A translation card can record a result before its sidebar block has ever been opened.
  if (!state.blockMeta[block] && isRightPanel(block)) {
    ensureBlock(block);
    parkRightPanel(block, panelPark());
  }
  const bodyEl = state.blockMeta[block].body;
  const isUser = kind === 'user';
  /** 译文条目：本条的界面要「纯净」（无动作按钮，role 行也不留回原文图标） */
  const isTranslateEntry = block === 'translate';

  const refText = quote && uiStyle.showQuote ? quote : '';
  /** 点页码标签时优先高亮这条消息里同一页的带片段引用；没有就用这条消息自己的原文引用 */
  const quoteForPage = (btn) => {
    const msg = btn?.closest?.('.msg');
    const qref = msg?.querySelector?.(`.page-ref.quote-ref[data-page="${page}"]`);
    return qref?.dataset.fragment || refText;
  };
  const role = el('div', { class: `role${!isUser && !page ? ' hidden' : ''}` },
    tag ? el('span', { class: 'tag', text: tag, 'aria-hidden': 'true' }) : null,
    page && uiStyle.showPage ? el('button', {
      class: 'pg', type: 'button', text: `第${page}页`,
      title: `回到第${page}页原文并高亮对应内容`,
      'aria-label': `回到第${page}页原文并高亮对应内容`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); jumpAndHighlight(page, quoteForPage(e.currentTarget)); },
    }) : null,
    // 译文块不要动作按钮（「最纯净的界面」）：连 role 行里这个「回原文」图标也去掉，
    // 跳回原文统一由下面那块可点击的原文引用承担。
    !isUser && page && uiStyle.showPage && !isTranslateEntry ? el('button', {
      class: 'tbtn',
      title: `回到第${page}页原文`,
      'aria-label': `回到第${page}页原文`,
      onclick: () => jumpToPageWithHistory(page, { smooth: true }),
    }, iconEl('jump-back')) : null,
  );
  const refClickable = !!refText && !!page && !isUser;
  const ref = refText
    ? el(refClickable ? 'button' : 'div', {
      class: `ref${refClickable ? ' ref-jump' : ''}`,
      type: refClickable ? 'button' : null,
      title: refClickable ? `回到第 ${page} 页并高亮原文：${refText}` : refText,
      'aria-label': refClickable ? `回到第 ${page} 页并高亮原文` : null,
      onclick: refClickable ? (e) => { e.preventDefault(); jumpAndHighlight(page, refText); } : null,
    }, refText)
    : null;
  const shots = (imageSrc ? [imageSrc] : (thumbs || [])).filter(Boolean);
  const shot = shots.length
    ? el('div', { class: 'shots' }, ...shots.map((src, i) => el('div', { class: 'shot-item' },
      el('span', { class: 'shot-index', text: `图 ${i + 1}` }),
      el('img', { class: 'shot-img', src, alt: `附件图片 ${i + 1}` }),
    )))
    : null;
  const textEl = el('div', {
    class: 'text',
    // 还没有任何输出时先显示「思考中…」：用户口径「没输出在思考就显示思考中或者什么」
    html: text !== undefined ? renderAnswerHTML(text) : '<span class="thinking">思考中…</span>',
  });
  const acts = el('div', { class: 'acts hidden' });
  const root = el('div', { class: `msg ${isUser ? 'user' : 'assistant'}`, dataset: { operation: tag || '', page: page || '' } }, role, ref, shot, textEl, acts);
  if (block === 'translate' && tag === 'translation') {
    root.classList.add('msg-translation');
    const targetLang = retry?.targetLang || (retry?.kind === 'translate' ? targetLangFor(String(quote || '')) : '中文');
    const sourceText = retry?.kind === 'translate-text' ? String(retry.text || '') : '';
    const originLang = sourceText && targetLang === 'English' && /[\u4e00-\u9fff]/.test(sourceText) ? '中文' : '原文';
    const direction = el('div', { class: 'translation-direction', text: `${retry?.kind === 'translate-text' ? '文本翻译' : '译文'} · ${originLang} → ${targetLang}` });
    root.insertBefore(direction, ref || shot || textEl);
    if (sourceText) {
      root.querySelector('.ref')?.remove();
      root.insertBefore(el('div', { class: 'translation-source', text: sourceText }), textEl);
    }
  }
  // 全局序号：分块之后 DOM 顺序 ≠ 时间顺序，取「最新一条」要靠它
  state.msgSeq = (state.msgSeq || 0) + 1;
  root.dataset.seq = String(state.msgSeq);
  if (block === 'translate') bodyEl.prepend(root);
  else bodyEl.append(root);
  const record = { block, tag: tag || '', page: page || null, quote: quote || '', kind, text: text || '', screenshot: !!shots.length, sources: [], meta: '',
    // B 线 P3：消息带来源文档（问答会话全局共享，恢复时能看出每条是哪篇论文下问的）
    docId: String(docId || state.doc?.docId || ''), docTitle: String(docTitle || state.doc?.name || ''),
    status: isUser ? 'user' : (text !== undefined ? 'complete' : 'pending'), retry: retry || null };
  root.__sessionRecord = record;
  if (!restore) {
    // 只有真正新增的问答消息才算全局会话变化（回放历史不算，否则停放的 DOM 会被误判过期）
    if (block === 'chat') {
      chatVersion += 1;
      state.sessionEntries.push(record);
      // 聊天 DOM 刚同步追加了一条：记下新指纹，切论文时不会因为「DOM 与磁盘不一致」再重放一次
      chatDomSig = currentChatSig();
      scheduleSessionSave();
    } else {
      state.sessionEntries.push(record);
      scheduleSessionSave();
    }
  }
  // 新结果进入时把它放到结果区顶部，用户可以继续向上滚查看更早的结果。
  scrollEntryToTop(bodyEl, root);
  refreshCounts();
  return { root, body: textEl, acts, role };
}

function finishEntry(entry, fullText, { page, onAsk, onRetry, retryLabel = '', sources, meta, status = 'complete', basis = '' } = {}) {
  const rec = entry.root.__sessionRecord;
  if (rec) {
    rec.text = String(fullText || '').slice(0, 12000);
    rec.page = page || rec.page;
    rec.sources = (sources || []).slice(0, 8);
    rec.meta = meta || '';
    rec.basis = String(basis || rec.basis || '').slice(0, 240);
    rec.status = status;
  }
  // R7：内容长出来之后刷新底部渐隐（下一帧量，等布局落定）
  requestAnimationFrame(updateScrollFades);
  // 同一个条目可能被收尾多次（典型：操作「重试」复用同一条），
  // 先把上一次的元信息行与来源列表摘掉，否则会叠出两行、旧的那行还写着「N 页失败」。
  entry.root.querySelectorAll('.entry-meta, .source-details, .src-list').forEach((node) => node.remove());
  // P1.5：回答上方的「本次依据」只读小字（不可点、不参与交互）。
  entry.root.querySelectorAll('.entry-basis').forEach((node) => node.remove());
  const basisText = String(basis || rec?.basis || '').trim();
  if (basisText) {
    const textNode = entry.root.querySelector('.text');
    const basisEl = el('div', { class: 'entry-basis', text: basisText.slice(0, 240) });
    if (textNode) entry.root.insertBefore(basisEl, textNode); else entry.root.append(basisEl);
  }
  entry.acts.replaceChildren();
  entry.acts.classList.remove('hidden');
  const bare = entry.root.dataset.operation === 'translation';
  const translationCopy = bare
    ? el('button', { class: 'act-icon', title: '复制译文', 'aria-label': '复制译文', onclick: () => copyText(fullText) }, iconEl('copy'))
    : null;
  appendAll(entry.acts,
    bare ? translationCopy : el('button', {
      class: 'act-icon', title: '复制这段回答', 'aria-label': '复制这段回答',
      onclick: () => copyText(fullText),
    }, iconEl('copy')),
    // 回答存笔记：与复制、回原文并排的小图标；已保存态变对勾
    bare ? null : answerNoteButton(entry),
    !bare && page ? el('button', {
      class: 'act-icon', title: `回到第 ${page} 页原文`, 'aria-label': `回到第 ${page} 页原文`,
      onclick: () => jumpToPageWithHistory(page, { smooth: true }),
    }, iconEl('jump-back')) : null,
    bare ? null : (onAsk ? el('button', { text: '接着问', onclick: onAsk }) : null),
    onRetry ? el('button', { text: retryLabel || (status === 'stopped' ? '重新生成' : '重试'), onclick: onRetry }) : null,
  );
  const extra = [];
  if (sources?.length) extra.push(renderSources(sources));
  // 精简层级：正文写完本身就是「完成」信号，不再单独占一行播报「回答完成」。
  // 只有在「被停止」或有实质元信息（已带全文 N 字 / 联网 N 条）时才渲染这一行，两者都空就整行不渲染。
  const stateParts = [];
  if (status === 'stopped') stateParts.push('已停止 · 已保留当前回答');
  if (stateParts.length) extra.push(el('div', { class: `entry-meta${status === 'stopped' ? ' stopped' : ''}`, text: stateParts.join(' · ') }));
  if (extra.length) entry.root.append(...extra);
  scheduleSessionSave();
  scrollBody(entry.root.closest('.ai-body'));
}

function addFailureRetry(entry, message, onRetry) {
  const rec = entry.root.__sessionRecord;
  if (rec) { rec.status = 'failed'; rec.text = ''; rec.meta = ''; }
  entry.root.classList.add('err');
  entry.acts.replaceChildren(el('button', { text: '重试这次发送', onclick: onRetry }));
  entry.acts.classList.remove('hidden');
  entry.root.querySelectorAll('.entry-meta').forEach((node) => node.remove());
  entry.root.append(el('div', { class: 'entry-meta failed', text: `发送失败：${message} · 问题和附件仍保留在输入区` }));
  scheduleSessionSave();
}

/**
 * 可恢复请求的最小持久化描述。截图不存图片本体（那是单独存的，见 uploadAttachment），
 * 只记附件 id + 尺寸 + 名称 —— 跨重启恢复时按 id 把原图取回来；老会话没有 id 的，
 * 退化成「截图未保存」提示。这样会话 JSON 不会被 base64 图片撑爆。
 */
function serialiseRetryPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || 'chat');
  if (kind === 'chat') {
    return {
      kind, docId: String(raw.docId || '').slice(0, 240), docTitle: String(raw.docTitle || '').slice(0, 240),
      inputValue: String(raw.inputValue || '').slice(0, 6000), question: String(raw.question || '').slice(0, 6000),
      quoteText: String(raw.quoteText || '').slice(0, 6000), firstPage: raw.firstPage || null,
      useFullText: !!raw.useFullText, useWeb: !!raw.useWeb,
      scopeRange: String(raw.scopeRange || Object.values(SCOPE_RANGES).find((r) => r.full === !!raw.useFullText && r.web === !!raw.useWeb)?.key || ''),
      reading: snapshotReadingRequest(raw.reading),
      history: snapshotHistory(raw.history || []).slice(-6).map((m) => ({ ...m, content: m.content.slice(0, 6000) })),
      attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 12).map((a) => {
        const kind0 = a?.kind === 'image' ? 'image' : 'text';
        return kind0 === 'image'
          ? {
            kind: 'image', page: a?.page || null, label: String(a?.label || '截图').slice(0, 120),
            w: Number(a?.w) || 0, h: Number(a?.h) || 0,
            // 图片单独存：只记 id（32 位十六进制）；取不到 id 的旧附件保留 screenshot 标记走旧提示
            id: validAttachmentId(a?.ref) ? a.ref : '',
            screenshot: true,
          }
          : { kind: 'text', page: a?.page || null, text: String(a?.text || '').slice(0, 3000) };
      }),
    };
  }
  if (kind === 'translate' || kind === 'explain') {
    return { kind, docId: String(raw.docId || '').slice(0, 240), text: String(raw.text || '').slice(0, 6000), page: raw.page || null,
      source: raw.source === 'right' ? 'right' : '' };
  }
  if (kind === 'translate-shot') {
    // 截图翻译：不存图片本体（单独存附件），只记附件 id + 页码 + 标签，重试/恢复时按 id 取回原图
    return {
      kind, docId: String(raw.docId || '').slice(0, 240), sid: String(raw.sid || '').slice(0, 40),
      page: raw.page || null, label: String(raw.label || '截图').slice(0, 120),
      refId: validAttachmentId(raw.refId) ? raw.refId : '',
    };
  }
  if (kind === 'translate-text') {
    // 文本输入翻译（2026-11-03）：原文直接存在 payload 里（不依赖 PDF 选区），重试/恢复后原样再翻
    return {
      kind, docId: String(raw.docId || '').slice(0, 240),
      text: String(raw.text || '').slice(0, 20000),
      targetLang: raw.targetLang === 'English' ? 'English' : '中文',
    };
  }
  if (kind === 'operation') {
    return { kind, docId: String(raw.docId || '').slice(0, 240), opId: String(raw.opId || '').slice(0, 120), block: String(raw.block || 'chat').slice(0, 40) };
  }
  if (kind === 'teaching') {
    return {
      kind, docId: String(raw.docId || '').slice(0, 240), opId: String(raw.opId || '').slice(0, 120),
      block: String(raw.block || 'chat').slice(0, 40),
      ask: String(raw.ask || '').slice(0, 500),
      extraUser: String(raw.extraUser || '').slice(0, 4000),
      teaching: raw.teaching && typeof raw.teaching === 'object' ? {
        kind: String(raw.teaching.kind || '').slice(0, 40),
        name: String(raw.teaching.name || '').slice(0, 160),
        boundary: String(raw.teaching.boundary || '').slice(0, 2000),
        page: raw.teaching.page || null,
      } : null,
    };
  }
  return null;
}

let sessionSaveInFlight = null;
const persistSession = debounce(() => {
  sessionSaveInFlight = saveSessionNow().catch((e) => {
    toastAction('会话保存失败，当前内容仍保留。', '重试', saveSessionNow, 'err', 12000);
  });
}, 800);
function scheduleSessionSave() {
  if (!state.doc) return;
  persistSession();
  // 会话有了第一轮完整回答后，后台生成一个更清楚的标题（手动改名永远优先）
  scheduleSessionTitle();
}

const SESSION_KEY = 'reader.activeSession';
const CURRENT_FOLDER_KEY = 'reader.currentFolder.v1';

/* 会话归属（2026-11-02 用户拍板）：
   - **问答会话属于文件夹**：每次只处理一个文件夹；换文件夹 = 换一套标签/会话，只显示这个文件夹里开过的会话；
   - 重新进入一个文件夹（切回来 / 完全关掉后再打开 / 重启）默认**新开一个会话**（旧会话文件保留在列表里可选）；
   - 译文仍按文档（doc=<docId>&sid=__translate）；
   - 老的「按文档」会话文件懒迁移进所属文件夹；旧的全局会话启动时按 docId→文件夹 拆分导入（复制，不删旧文件）。 */
const LEGACY_GLOBAL_SESSION_DOC = '__global__';
const TRANSLATE_SID = '__translate';
const FOLDER_MIGRATE_FLAG_PREFIX = 'reader.migrated.folder.v3.';
const GLOBAL_SPLIT_FLAG = 'reader.migrated.globalToFolder.v1';

function fnv1a8(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
/** 文件夹稳定键（可直接当 /api/session 的 doc 参数；不含用户路径原文） */
function folderKeyOf(path) { return `folder-${fnv1a8(`/${String(path || '')}`)}`; }
function currentFolderPath() { return state.currentFolder || ''; }
function currentFolderKey() { return folderKeyOf(currentFolderPath()); }
/** 论文所属文件夹（'' = papers 根目录） */
function folderOfDoc(docId) {
  const p = (state.papers || []).find((x) => x && x.docId === docId);
  return p ? String(p.folder || '') : '';
}
function folderDisplayName(path) {
  if (!path) return 'papers/';
  return path.replace(/\//g, ' / ');
}
function persistCurrentFolder() {
  try { localStorage.setItem(CURRENT_FOLDER_KEY, currentFolderPath()); } catch { /* 忽略 */ }
}

/* 会话归属方式（设置 → 会话，2026-11-04）：让不同使用习惯的人自己选会话「属于谁」。
   - folder（默认）：会话属于文件夹，同一文件夹的多篇论文可以接着同一段会话问；
   - paper：每篇论文一份自己的会话清单，换论文自动接上那篇自己的对话，不串上下文；
   - global：所有论文共用一个会话空间，换论文、换文件夹也不丢上下文。（文档级译文不受影响。）
   存储：folder 按文件夹键；paper 按论文 docId；global 统一存到 doc=default。 */
const SESSION_SCOPE_MODE_KEY = 'reader.session.scopeMode';
const AI_TITLE_KEY = 'reader.session.aiTitle';
function readSessionScopeMode() {
  try {
    const v = localStorage.getItem(SESSION_SCOPE_MODE_KEY);
    return v === 'paper' || v === 'global' ? v : 'folder';
  } catch { return 'folder'; }
}
function writeSessionScopeMode(mode) {
  const next = mode === 'paper' || mode === 'global' ? mode : 'folder';
  try { localStorage.setItem(SESSION_SCOPE_MODE_KEY, next); } catch { /* 忽略 */ }
  return next;
}
/** 问答会话存到哪个 doc 键：folder 按文件夹；paper 真正按论文（docId）；global 统一 default。
 *  传 docId 时按那篇论文算（切换文档过程中 state.doc 可能已经换过，但旧的会话仍要写回旧 scope）。 */
function sessionScopeKey(docId = '') {
  const mode = readSessionScopeMode();
  if (mode === 'global') return 'default';
  if (mode === 'paper') return String(docId || state.doc?.docId || '') || currentFolderKey();
  return currentFolderKey();
}
/** 服务端保存会话时会把 doc 参数规范成 docId 形式的键（全局 'default' → 'default-<hash>'，
 *  见 server.js 的 docIdOf）。历史行里的 fileKey 是规范后的键，这里按同一算法判断
 *  「某个 fileKey 是不是当前归属键」。 */
function scopeDocIdOf(name) {
  const s = String(name);
  if (/^(.{1,64})-([0-9a-f]{6,10})$/.test(s)) return s;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  const slug = s.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48);
  return `${slug}-${h.toString(16)}`;
}
function isScopeFileKey(fileKey) {
  const key = String(fileKey || '');
  if (!key) return false;
  if (key === sessionScopeKey()) return true;
  return readSessionScopeMode() === 'global' && key === scopeDocIdOf('default');
}
/** 「当前会话」指针存哪一格：按文件夹 / 每篇论文 / 全局 */
function activeSessionSlot(docId) {
  const mode = readSessionScopeMode();
  if (mode === 'global') return 'global';
  if (mode === 'paper') return `doc:${String(docId || state.doc?.docId || '')}`;
  return currentFolderKey();
}
/** AI 自动标题开关（默认开；关闭后沿用服务端「首条问题」自动标题） */
function aiTitleEnabled() {
  try { return localStorage.getItem(AI_TITLE_KEY) !== '0'; } catch { return true; }
}
function setAiTitleEnabled(on) {
  try { localStorage.setItem(AI_TITLE_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/* 「打开文件夹时」策略（选择卡片 / 自动恢复 / 总是新会话）只应该在**真正进文件夹**的那一刻生效：
   - 切文件夹、从首页进入、完全关闭后再打开、重启后首次打开文档 → beginFolderEntry() 置标记；
   - 同一文件夹里切换论文是「换论文」不是「换文件夹」：不弹卡片、不新建会话，
     由「会话归属」决定接上哪个会话（文件夹会话 / 这篇论文自己的 / 全局共用的）。
   没有这个标记时，sessionsOnDocOpened 一律按「自动接上」处理。 */
let folderEntryPending = false;
/* 历史面板 / 选择卡片指定了要打开的会话：打开文档过程中别再弹选择卡片或另开新会话 */
let pendingSessionOpen = false;


function readActiveSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}') || {}; } catch { return {}; }
}
/** 活动会话 sid：跟着「会话归属方式」记一格（文件夹 / 每篇论文 / 全局） */
function activeSidFor(docId) {
  const map = readActiveSessions();
  const key = activeSessionSlot(docId);
  return typeof map[key] === 'string' ? map[key] : '';
}
function setActiveSidFor(docId, sid) {
  const map = readActiveSessions();
  const key = activeSessionSlot(docId);
  if (sid) map[key] = sid; else delete map[key];
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(map)); } catch { /* 忽略 */ }
}
/** 新会话的 sid：时间戳 + 随机后缀，够用且不会撞 */
function newSid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
/** 当前论文的会话查询串（带 sid；老会话就是不带 sid） */
function sessionQuery(docId, sid) {
  const base = `doc=${encodeURIComponent(docId)}`;
  return sid ? `${base}&sid=${encodeURIComponent(sid)}` : base;
}

const ATTACHMENT_ID_RE = /^[0-9a-f]{32}$/;
const validAttachmentId = (v) => ATTACHMENT_ID_RE.test(String(v || ''));

/** dataURL → Blob（上传用；本机服务只收原始图片字节，不收 base64） */
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,/i.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    const mime = m[1] || 'image/png';
    const body = String(dataUrl).slice(m[0].length);
    if (m[2]) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([new TextEncoder().encode(decodeURIComponent(body))], { type: mime });
  } catch { return null; }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** 把一张截图单独存到服务端；失败返回 ''（不挡提问） */
async function uploadAttachment(dataUrl, docId, sid) {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return '';
  try {
    const r = await fetch(`/api/attachment?${sessionQuery(docId, sid)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    if (!r.ok) return '';
    const out = await r.json();
    return validAttachmentId(out?.id) ? out.id : '';
  } catch { return ''; }
}

/** 按附件 id 取回原图（dataURL）；失败返回 '' */
async function fetchAttachmentDataUrl(ref, docId, sid) {
  if (!validAttachmentId(ref)) return '';
  try {
    const r = await fetch(`/api/attachment?${sessionQuery(docId, sid)}&id=${encodeURIComponent(ref)}`);
    if (!r.ok) return '';
    return await blobToDataUrl(await r.blob());
  } catch { return ''; }
}

/** 按会话条目里的 shots[] 取回图片；返回 { thumbs, missing } */
async function hydrateShotThumbs(shots, docId, sid) {
  const rows = (Array.isArray(shots) ? shots : []).slice(0, 6);
  const urls = await Promise.all(rows.map((s) => s && validAttachmentId(s.id)
    ? fetchAttachmentDataUrl(s.id, docId, sid) : Promise.resolve('')));
  // 保留原始索引；过滤缺失项会把图 2 挪成图 1，重新生成时造成错配。
  const missingThumb = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="100%" height="100%" fill="#888" opacity=".12"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#777" font-size="14">截图文件缺失</text></svg>',
  );
  const thumbs = urls.map((url) => url || missingThumb);
  return { thumbs, missing: urls.some((url) => !url) };
}

/** 一张附件图片 → 会话里存的最小描述 { id, w, h, label } */
function shotRefOf(im) {
  if (!im || !validAttachmentId(im.ref)) return null;
  return {
    id: im.ref,
    w: Number(im.w) || 0,
    h: Number(im.h) || 0,
    label: String(im.label || '截图').slice(0, 120),
  };
}

/** 教学状态存档：只存当前论文当前会话的「带我一步步读」进度与续讲历史 */
function serializeTeachingState() {
  const walk = activeWalk();
  if (!walk) return null;
  return {
    walk: {
      docId: walk.docId,
      sid: walk.sid || '',
      step: walk.step || 1,
      routeCount: walk.routeCount || null,
      updatedAt: walk.updatedAt || nowISO(),
      messages: (walk.messages || []).slice(-16).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 12000),
      })),
    },
  };
}

/** 构建会话 payload 并按归属拆分：文件夹问答（当前文件夹共用）+ 文档译文（__translate 伪会话）。 */
function buildSessionPayload() {
  if (!state.doc) return null;
  const docId = state.doc.docId;
  const entries = state.sessionEntries.slice(-90).map((x) => ({
    block: String(x.block || 'chat'), tag: String(x.tag || '').slice(0, 120), page: x.page || null,
    quote: String(x.quote || '').slice(0, 3000), kind: x.kind === 'user' ? 'user' : 'assistant',
    text: String(x.text || '').slice(0, 12000), screenshot: !!x.screenshot,
    // P3：消息带来源文档标注（全局会话里能看出这条是哪篇论文下问的）
    docId: String(x.docId || '').slice(0, 240), docTitle: String(x.docTitle || '').slice(0, 300),
    // 截图附件单独存：这里只留 id 引用（几十字节），恢复会话时按 id 取回原图
    shots: (Array.isArray(x.shots) ? x.shots : [])
      .filter((s) => s && validAttachmentId(s.id))
      .slice(0, 6)
      .map((s) => ({ id: s.id, w: Number(s.w) || 0, h: Number(s.h) || 0, label: String(s.label || '截图').slice(0, 120) })),
    status: ['pending', 'complete', 'stopped', 'failed', 'user'].includes(x.status) ? x.status : (x.kind === 'user' ? 'user' : 'complete'),
    sources: (Array.isArray(x.sources) ? x.sources : []).slice(0, 8).map((s) => ({ title: String(s.title || '').slice(0, 500), url: String(s.url || '').slice(0, 2000), number: s.number || null })),
    meta: String(x.meta || '').slice(0, 500),
    basis: String(x.basis || '').slice(0, 240),
    retry: serialiseRetryPayload(x.retry),
    // 「读懂论文」的教学按钮 / 教学对象：恢复会话后「继续下一步 / 这个我懂了」仍然可用
    chips: (Array.isArray(x.chips) ? x.chips : []).slice(0, 4).map((c) => ({ label: String(c.label || '').slice(0, 12), prompt: String(c.prompt || '').slice(0, 200), op: ['evidence', 'limits'].includes(c.op) ? c.op : '' })),
    teaching: x.teaching && typeof x.teaching === 'object' ? {
      kind: String(x.teaching.kind || '').slice(0, 40), name: String(x.teaching.name || '').slice(0, 160),
      boundary: String(x.teaching.boundary || '').slice(0, 2000), page: x.teaching.page || null,
    } : null,
  }));
  const inMemory = new Set(entries.map((e) => `${e.tag}\u0000${e.text}`));
  // 文件缓存只对「它所属的那篇文档」有效：热切换后 _fileEntries 可能还是上一篇的，不能串用
  const kept = (state._fileDocId === docId && Array.isArray(state._fileEntries) ? state._fileEntries : [])
    .filter((e) => e && e.block !== 'chat')
    .filter((e) => !inMemory.has(`${String(e.tag || '').slice(0, 120)}\u0000${String(e.text || '').slice(0, 12000)}`))
    .slice(-40)
    .map((e) => ({ ...e, block: String(e.block || 'translate') }));
  const allEntries = [...kept, ...entries];
  /* AI 功能记录（深入阅读等）属于**本次文件夹会话**：换会话/重新进文件夹时清空，
     这样新会话里 AI 功能菜单不会显示「已生成」，点它会重新算。 */
  const ops = [...state.opsCache.entries()].slice(-40)
    .map(([key, value]) => ({ id: key, text: String(value.text || '').slice(0, 12000), at: value.at || Date.now(), page: value.page || null }));
  // ① 文件夹问答会话：chat 条目 + 历史 + 摘要 + 教学进度 + AI 功能记录
  const chat = {
    entries: allEntries.filter((e) => e.block !== 'translate'),
    history: snapshotHistory(state.history),
    ops,
    teaching: serializeTeachingState(),
    updatedAt: Date.now(),
    // P0 会话系统 v4：归属文件夹 + 涉及文档（服务端派生 meta、跨文件夹列表要用）
    folderPath: currentFolderPath(),
    docIds: docId ? [docId] : [],
    docTitles: state.doc?.name ? [state.doc.name] : [],
    summary: String(state.sessionSummary || '').slice(0, 2000),
    summaryCovered: Math.max(0, Number(state.summaryCovered) || 0),
    // A 线 P3：摘要所属提示词版本（读取时版本不同视为旧摘要，可重算）
    summaryPrompt: PROMPT_SYSTEM_VERSION,
  };
  // ② 文档级译文伪会话：只放 translate 条目（AI 功能记录已归会话）
  const translate = {
    entries: allEntries.filter((e) => e.block === 'translate'),
    history: [],
    ops: [],
    teaching: null,
    updatedAt: Date.now(),
    summary: '',
    summaryCovered: 0,
    summaryPrompt: PROMPT_SYSTEM_VERSION,
  };
  const clampPayload = (payload) => {
    let encoded = JSON.stringify(payload);
    const encodedBytes = () => new TextEncoder().encode(encoded).byteLength;
    while (encodedBytes() > 350000 && payload.entries.length > 1) { payload.entries.shift(); encoded = JSON.stringify(payload); }
    while (encodedBytes() > 350000 && payload.ops.length) { payload.ops.shift(); encoded = JSON.stringify(payload); }
    while (encodedBytes() > 350000 && payload.history.length) { payload.history.shift(); encoded = JSON.stringify(payload); }
    return encoded;
  };
  return { chat: clampPayload(chat), translate: clampPayload(translate) };
}

/** 保存：文件夹问答 → doc=<folderKey>；本文档译文 → doc=<docId>&sid=__translate（复用现有接口） */
async function saveSessionNow() {
  if (!state.doc) return;
  const both = buildSessionPayload();
  if (!both) return;
  const docId = state.doc.docId;
  const sid = activeSidFor(docId);
  const headers = { 'Content-Type': 'application/json' };
  const [chatRes, translateRes] = await Promise.all([
    fetch(`/api/session?${sessionQuery(sessionScopeKey(), sid)}`, { method: 'POST', headers, body: both.chat }),
    fetch(`/api/session?${sessionQuery(docId, TRANSLATE_SID)}`, { method: 'POST', headers, body: both.translate }),
  ]);
  if (!chatRes.ok) throw new Error(`HTTP ${chatRes.status}`);
  if (!translateRes.ok) throw new Error(`译文保存失败 HTTP ${translateRes.status}`);
  // 记住「刚存进去的文件夹会话指纹」：下次冷恢复读到同样的内容时就不用作废停放视图（热切换仍可复用 DOM）
  try { globalChatSig = chatSigOf(sid, JSON.parse(both.chat).entries); } catch { globalChatSig = ''; }
}

/**
 * 懒迁移：旧「按文档」会话 → **所属文件夹**的默认会话 + 文档译文（复制，不删旧文件；失败下次打开再试）。
 * 幂等：localStorage 标记成功迁移的文档；旧 chat 按 kind|text|page 去重，旧 translate 同理。
 */
async function migrateLegacySession(docId) {
  if (!docId) return;
  const flag = `${FOLDER_MIGRATE_FLAG_PREFIX}${docId}`;
  try { if (localStorage.getItem(flag)) return; } catch { /* ignore */ }
  const dedupeKey = (e) => `${e?.kind || ''}|${e?.text || ''}|${e?.page || ''}`;
  const headers = { 'Content-Type': 'application/json' };
  try {
    const r = await fetch(`/api/session?doc=${encodeURIComponent(docId)}`);
    if (!r.ok) { try { localStorage.setItem(flag, '1'); } catch { /* ignore */ } return; }
    const old = await r.json();
    const oldEntries = Array.isArray(old.entries) ? old.entries : [];
    if (!oldEntries.length && !Array.isArray(old.ops)) { try { localStorage.setItem(flag, '1'); } catch { /* ignore */ } return; }
    // ① 译文条目 + 本文档 ops → __translate
    const oldTranslate = oldEntries.filter((e) => e && e.block === 'translate');
    if (oldTranslate.length || (Array.isArray(old.ops) && old.ops.length)) {
      const trRes = await fetch(`/api/session?${sessionQuery(docId, TRANSLATE_SID)}`);
      const trSaved = trRes.ok ? await trRes.json() : {};
      const existing = new Set((trSaved.entries || []).map(dedupeKey));
      const merged = [...(trSaved.entries || [])];
      for (const e of oldTranslate) {
        const key = dedupeKey(e);
        if (existing.has(key)) continue;
        merged.push(e); existing.add(key);
      }
      const ops = [...(Array.isArray(trSaved.ops) ? trSaved.ops : [])];
      for (const op of (Array.isArray(old.ops) ? old.ops : [])) {
        if (op && op.id && !ops.some((x) => x.id === op.id)) ops.push(op);
      }
      const saveRes = await fetch(`/api/session?${sessionQuery(docId, TRANSLATE_SID)}`, {
        method: 'POST', headers,
        body: JSON.stringify({
          entries: merged.slice(-120), history: [], ops: ops.slice(-30), teaching: null,
          updatedAt: Date.now(), summary: '', summaryCovered: 0,
        }),
      });
      if (!saveRes.ok) return;   // 失败不标记，下次重试
    }
    // ② chat 条目 → 所属文件夹里的一个会话（每个旧文档一条，用稳定 sid 保证重试幂等）
    const oldChat = oldEntries.filter((e) => e && e.block !== 'translate');
    if (oldChat.length) {
      const folderPath = folderOfDoc(docId);
      const folderKey = folderKeyOf(folderPath);
      // 旧「按文档」会话迁进文件夹后必须有真实 sid：如果写进无 sid 的默认文件，
      // 列表里 sid='' 会和「没有活动会话」的空串撞在一起（头像标题、当前行判断全乱）。
      const legacySid = `legacy-${fnv1a8(docId)}`;
      const gRes = await fetch(`/api/session?${sessionQuery(folderKey, legacySid)}`);
      const gSaved = gRes.ok ? await gRes.json() : {};
      const existing = new Set((gSaved.entries || []).map(dedupeKey));
      const merged = [...(gSaved.entries || [])];
      for (const e of oldChat) {
        const key = dedupeKey(e);
        if (existing.has(key)) continue;
        const docTitle = state.doc?.docId === docId ? String(state.doc?.name || '') : '';
        merged.push({ ...e, docId, docTitle: docTitle.slice(0, 300) });
        existing.add(key);
      }
      // 旧文件里的 ops（深入阅读缓存）按 docId:opId 搬进会话，旧会话才会显示「已生成」
      const oldOps = (Array.isArray(old.ops) ? old.ops : [])
        .filter((op) => op && op.id && typeof op.text === 'string')
        .map((op) => ({ id: `${docId}:${op.id}`, text: op.text.slice(0, 12000), at: op.at || Date.now(), page: op.page || null }));
      const mergedOps = [...(Array.isArray(gSaved.ops) ? gSaved.ops : [])];
      for (const op of oldOps) if (!mergedOps.some((x) => x.id === op.id)) mergedOps.push(op);
      const saveRes = await fetch(`/api/session?${sessionQuery(folderKey, legacySid)}`, {
        method: 'POST', headers,
        body: JSON.stringify({
          ...gSaved,
          entries: merged.slice(-180),
          ops: mergedOps.slice(-40),
          teaching: gSaved.teaching || null,
          folderPath,
          docIds: [docId],
          docTitles: state.doc?.docId === docId && state.doc?.name ? [state.doc.name] : [],
          updatedAt: Date.now(),
        }),
      });
      if (!saveRes.ok) return;
    }
    try { localStorage.setItem(flag, '1'); } catch { /* ignore */ }
  } catch { /* 迁移失败：保留旧文件，下次打开这篇再试 */ }
}

/* ── 文件夹上下文：一次只处理一个文件夹；换文件夹 = 新会话；只列这个文件夹的会话 ── */

/** 关闭不属于某个文件夹的标签（换文件夹时用），并释放它们的 PDF 句柄/停放视图 */
function closeTabsNotInFolder(path) {
  const keep = new Set((state.papers || []).filter((p) => String(p.folder || '') === path).map((p) => p.docId));
  for (const tab of [...tabsStore.tabs]) {
    if (keep.has(tab.docId)) continue;
    dropPdfHandle(tab.docId);
    dropDocView(tab.docId);
  }
  tabsStore.tabs = tabsStore.tabs.filter((t) => keep.has(t.docId));
  if (tabsStore.tabs.length) {
    if (!tabsStore.tabs.some((t) => t.docId === tabsStore.active)) tabsStore.active = tabsStore.tabs[0].docId;
  } else {
    tabsStore.active = '';
  }
  tabsSyncBar();
  tabsPersist();
}

/** 清掉 AI 功能记录（换会话/新会话/重新进文件夹时） */
function resetFolderAiRecords() {
  state.opsCache.clear();
  state.opsDone = {};
  state.opsDoc = null;
  state.teachingCache.clear();
  state.teaching = { walk: null, current: null };
}

/** 进文件夹时重置「会话视图状态」（不动 activeSid；choose / resume 档共用） */
function resetSessionViewState() {
  globalChatSig = '';
  chatDomSig = '';
  chatVersion += 1;
  clearChatBlock();
  resetFolderAiRecords();
  state.sessionEntries = [];
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  state._fileEntries = [];
  state._fileDocId = '';
}

/** 为当前文件夹开启一个**新会话**（旧会话文件保留，可在会话菜单里选回） */
function startFolderSession() {
  setActiveSidFor(null, newSid());
  resetSessionViewState();
}

/** 用户拍板 B（2026-11-03）：进文件夹默认显示「空态选择卡片」；
 *  reader.session.onEnter = choose（默认）/ resume（自动恢复上次）/ new（旧行为：总是新会话） */
function sessionOnEnterMode() {
  try {
    const v = localStorage.getItem('reader.session.onEnter');
    return v === 'resume' || v === 'new' ? v : 'choose';
  } catch { return 'choose'; }
}

/** 进入文件夹：按默认策略处理 activeSid；具体「恢复/卡片/新会话」由 sessions.js 在文档打开后决定 */
function beginFolderEntry() {
  folderEntryPending = true;         // 这一次才是真正的「打开文件夹」，onEnter 策略只在这里生效
  // 「按论文」模式下会话指针挂在每篇论文自己的槽位上，进文件夹时没法预置：
  // 具体接哪一篇/新建哪一个由 sessionsOnDocOpened 拿到 docId 后再决定。
  if (sessionOnEnterMode() === 'new' && readSessionScopeMode() !== 'paper') setActiveSidFor(null, newSid());
  resetSessionViewState();
  sessionsOnFolderEntered(currentFolderPath());
}

/**
 * 确保「当前文件夹」与 docId 所属文件夹一致。
 * - 换到另一个文件夹：关掉旧文件夹标签、开新会话；
 * - 同一个文件夹但之前被「完全关闭」过（回首页/所有标签关了/重启）：开新会话；
 * 返回 true 表示发生了文件夹切换。
 */
function ensureFolderForDoc(docId) {
  const path = docId ? folderOfDoc(docId) : '';
  const changed = path !== currentFolderPath();
  if (!changed) {
    if (state.folderClosed) {
      state.folderClosed = false;
      beginFolderEntry();
    }
    return false;
  }
  state.currentFolder = path;
  state.folderClosed = false;
  persistCurrentFolder();
  closeTabsNotInFolder(path);
  beginFolderEntry();
  renderFolderSwitch();
  flashHint(`已切换文件夹：${folderDisplayName(path)}`);
  return true;
}

/** 显式切换文件夹（左栏文件夹按钮 / 菜单） */
async function switchFolder(path) {
  const target = String(path || '');
  if (target === currentFolderPath()) return;
  if (state.busy) { toast('正在生成中，先等它跑完或点停止再换文件夹', 'err', 3200); return; }
  // 先把旧文件夹会话存盘，再关旧标签、开新会话
  try { if (state.doc && state.sessionEntries.length) await saveSessionNow(); } catch { /* 存不下也允许切 */ }
  state.currentFolder = target;
  state.folderClosed = false;
  persistCurrentFolder();
  closeTabsNotInFolder(target);
  beginFolderEntry();
  renderFolderSwitch();
  if (!tabsStore.tabs.length) {
    // 旧标签已关；这里不要再把旧文档的会话/译文写回新文件夹（skipSave）
    await goWelcome({ skipSave: true });
    state.folderClosed = false;   // 刚进入这个文件夹；首个文件会按 onEnter 策略进入
  } else if (state.doc && folderOfDoc(state.doc.docId) === target) {
    await openDoc({ docId: tabsStore.tabs[0].docId, name: tabsStore.tabs[0].name, url: tabsStore.tabs[0].url, path: tabsStore.tabs[0].path });
  }
  flashHint(`已切换文件夹：${folderDisplayName(target)}`);
}

/** 左栏「当前文件夹」按钮的文案 */
function renderFolderSwitch() {
  const btn = $('#folderSwitch');
  if (!btn) return;
  btn.textContent = `📁 ${folderDisplayName(currentFolderPath())}`;
  btn.title = `当前文件夹：papers/${currentFolderPath() ? `${currentFolderPath()}/` : ''}（点击切换文件夹）`;
}

/** 左栏文件夹切换菜单 */
function initFolderSwitch() {
  const btn = $('#folderSwitch');
  const menu = $('#folderSwitchMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    const rows = [{ path: '', name: 'papers/' }];
    for (const f of (state.folders || [])) rows.push({ path: f.path, name: `${f.path.replace(/\//g, ' / ')}/` });
    menu.replaceChildren(...rows.map((row) => {
      const count = (state.papers || []).filter((p) => String(p.folder || '') === row.path).length;
      const on = row.path === currentFolderPath();
      return el('button', {
        type: 'button',
        class: `folder-switch-item${on ? ' on' : ''}`,
        title: `papers/${row.path ? `${row.path}/` : ''}`,
        onclick: () => { menu.classList.add('hidden'); switchFolder(row.path); },
      },
      el('span', { class: 'fsi-name', text: row.name }),
      el('span', { class: 'fsi-count', text: `${count} 篇` }),
      on ? el('span', { class: 'fsi-on', text: '当前' }) : null);
    }));
    menu.classList.remove('hidden');
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('#folderSwitchMenu') || e.target.closest('#folderSwitch')) return;
    menu.classList.add('hidden');
  });
}

/** 启动时初始化当前文件夹；并把旧的「全局会话」按 docId→文件夹 拆分导入（复制，不删旧文件） */
async function initFolderContext() {
  let folder = '';
  try { folder = String(localStorage.getItem(CURRENT_FOLDER_KEY) || ''); } catch { /* ignore */ }
  if (!folder && serverState.lastDoc) folder = folderOfDoc(serverState.lastDoc);
  // 存储的文件夹可能已经被删掉了：落回根目录
  const exists = !folder || (state.folders || []).some((f) => f.path === folder);
  state.currentFolder = exists ? folder : '';
  state.folderClosed = true;   // 重启后重新进入 → 默认新会话
  persistCurrentFolder();
  renderFolderSwitch();
  await migrateGlobalSessionsToFolders();
}

/** 旧「全局会话」→ 各文件夹会话：按条目里的 docId 找所属文件夹，复制导入（只做一次） */
async function migrateGlobalSessionsToFolders() {
  try { if (localStorage.getItem(GLOBAL_SPLIT_FLAG)) return; } catch { return; }
  const headers = { 'Content-Type': 'application/json' };
  const dedupe = (e) => `${e?.kind || ''}|${e?.text || ''}|${e?.page || ''}`;
  try {
    const listRes = await fetch(`/api/sessions?doc=${encodeURIComponent(LEGACY_GLOBAL_SESSION_DOC)}`);
    if (!listRes.ok) return;
    const list = (await listRes.json()).sessions || [];
    for (const s of list) {
      const sid = String(s.sid || '');
      const r = await fetch(`/api/session?${sessionQuery(LEGACY_GLOBAL_SESSION_DOC, sid)}`);
      if (!r.ok) continue;
      const data = await r.json();
      const entries = (Array.isArray(data.entries) ? data.entries : []).filter((e) => e && e.block !== 'translate');
      if (!entries.length) continue;
      const byFolder = new Map();
      for (const e of entries) {
        const folder = folderOfDoc(e.docId);
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(e);
      }
      for (const [folder, rows] of byFolder) {
        const folderKey = folderKeyOf(folder);
        const targetSid = sid || newSid();
        const cur = await fetch(`/api/session?${sessionQuery(folderKey, targetSid)}`);
        const saved = cur.ok ? await cur.json() : {};
        const existing = new Set((saved.entries || []).map(dedupe));
        const merged = [...(saved.entries || [])];
        for (const e of rows) {
          const key = dedupe(e);
          if (existing.has(key)) continue;
          merged.push(e);
          existing.add(key);
        }
        await fetch(`/api/session?${sessionQuery(folderKey, targetSid)}`, {
          method: 'POST', headers,
          body: JSON.stringify({ ...saved, entries: merged.slice(-180), ops: [], teaching: null, updatedAt: Date.now() }),
        });
      }
    }
    try { localStorage.setItem(GLOBAL_SPLIT_FLAG, '1'); } catch { /* ignore */ }
  } catch { /* 下次启动再试 */ }
}

/** 已有结果直接定位：打开对应结果块 → 滚到那条消息 → 闪一下 */
function focusExistingResult(entry, label = '') {
  if (!entry) return false;
  // 传进来的可能是「会话记录」而不是 addEntry 返回的 entry（记录上没有 .root）：按 __sessionRecord 找回 DOM
  let root = entry.root || null;
  if (!root) {
    const blockId = entry.block === 'translate' ? 'translate' : 'chat';
    // 结果块可能还没挂载（例如一直待在译文面板）：先确保块存在，否则会把「有记录」误判成「没有」
    ensureBlock(blockId);
    const body = state.blockMeta?.[blockId]?.body;
    root = [...(body?.querySelectorAll?.('.msg') || [])].find((node) => node.__sessionRecord === entry) || null;
  }
  if (!root) return false;
  const block = root.closest('.ai-block')?.dataset?.block || 'chat';
  showAiBlock(block);
  // 立即执行一次、再用定时器补一次：无头/后台窗口里 rAF 可能不触发，面板刚切过去布局也要落定
  const apply = () => {
    if (!root.isConnected) return;
    try { root.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { root.scrollIntoView?.({ block: 'nearest' }); }
    root.classList.remove('result-flash');
    void root.offsetWidth;
    root.classList.add('result-flash');
    clearTimeout(root.__flashTimer);
    root.__flashTimer = setTimeout(() => root.classList.remove('result-flash'), 1600);
  };
  apply();
  setTimeout(apply, 80);
  if (label) toast(`「${label}」已在结果区（已定位过去），点「重新生成」才会重跑`, 'ok', 3000);
  return true;
}

function restoreComposerFallback(question, payload = null) {
  const ta = $('#chatInput');
  if (!ta) return;
  const text = String(payload?.inputValue || question || '').trim();
  ta.value = text;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(130, ta.scrollHeight)}px`;
  if (payload) {
    state.useFullText = !!payload.useFullText;
    state.useWeb = !!payload.useWeb;
    const textAttachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
      .filter((a) => a?.kind === 'text' && String(a.text || '').trim())
      .map((a) => ({ id: uid(), kind: 'text', page: a.page || null, text: String(a.text).slice(0, 3000) }));
    state.attachments = textAttachments;
    renderAttachments();
    renderScopeMenu();
  }
  updateSendScope();
  ta.focus();
}

function restoreRetryCallback(row, entry, priorUser) {
  const payload = row?.retry && typeof row.retry === 'object' ? row.retry : null;
  const fallbackQuestion = String(priorUser?.text || row?.quote || '').replace(/\n\n【截图附件未保存，请重新添加截图】$/, '').slice(0, 6000);
  if (!payload) {
    return () => {
      restoreComposerFallback(fallbackQuestion);
      toast('已恢复问题到输入框；旧会话没有保存可自动重试的范围。', 'ok', 4200);
    };
  }
  return async () => {
    if (payload.docId && payload.docId !== state.doc?.docId) {
      toast('这条请求属于另一篇论文，请切回原论文后重试', 'err', 3200);
      return;
    }
    if (payload.kind === 'translate' || payload.kind === 'explain') {
      const sel = { page: payload.page || null, text: payload.text || '', cleanText: payload.text || '',
        source: payload.source === 'right' ? 'right' : '' };
      if (!sel.cleanText) { restoreComposerFallback(fallbackQuestion); return; }
      if (payload.kind === 'translate') doTranslate(sel);
      else doExplain(sel);
      return;
    }
    if (payload.kind === 'translate-shot') {
      retryTranslateShot(payload);
      return;
    }
    if (payload.kind === 'translate-text') {
      // 文本输入翻译：原文存在 payload 里，直接原样再翻一次
      doTranslateText({ text: payload.text || '', targetLang: payload.targetLang === 'English' ? 'English' : '中文' });
      return;
    }
    if (payload.kind === 'operation') {
      runOperation(payload.opId, { force: true, block: payload.block || 'chat', retryEntry: entry });
      return;
    }
    if (payload.kind === 'teaching') {
      runTeaching(payload.opId, {
        force: true, retryEntry: entry,
        ask: payload.ask || '', extraUser: payload.extraUser || '',
        teaching: payload.teaching || null,
      });
      return;
    }
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    /** 截图附件单独存：有 id 的可以取回原图；只有 screenshot 标记的老会话才真的丢了 */
    const imageRows = rawAttachments.filter((a) => a?.kind === 'image' || a?.screenshot);
    const recoverable = imageRows.filter((a) => validAttachmentId(a?.id));
    const lostShots = imageRows.length > recoverable.length;
    const docId = state.doc?.docId || payload.docId || null;
    const sid = activeSidFor(docId);
    let imageAttachments = [];
    if (recoverable.length) {
      const urls = await Promise.all(recoverable.map((a) => fetchAttachmentDataUrl(a.id, docId, sid)));
      if (urls.some((u) => !u)) {
        // 图片文件被清掉了（比如另一个会话清空时 GC 掉了）：退回「重新添加」的老路
        restoreComposerFallback(payload.question || fallbackQuestion, payload);
        toast('截图文件已不在，问题和文字附件已恢复；请重新添加截图后再发送。', 'ok', 5200);
        return;
      }
      imageAttachments = recoverable.map((a, i) => ({
        id: uid(), kind: 'image', page: a.page || null, dataUrl: urls[i],
        w: Number(a.w) || 0, h: Number(a.h) || 0,
        label: String(a.label || '截图').slice(0, 120), ref: a.id,
      }));
    }
    if (lostShots && !imageAttachments.length) {
      restoreComposerFallback(payload.question || fallbackQuestion, payload);
      toast('问题和文字附件已恢复；截图未保存，请重新添加截图后再发送。', 'ok', 5200);
      return;
    }
    const attachments = [
      ...rawAttachments
        .filter((a) => a?.kind === 'text' && String(a.text || '').trim())
        .map((a) => ({ id: uid(), kind: 'text', page: a.page || null, text: String(a.text).slice(0, 3000) })),
      ...imageAttachments,
    ];
    const pending = {
      inputValue: String(payload.inputValue || payload.question || ''),
      question: String(payload.question || fallbackQuestion || '请解释我加进来的这段内容。'),
      attachments,
      quoteText: String(payload.quoteText || attachments.map((a) => (a.page ? `[第${a.page}页] ` : '') + (a.text || '')).join('\n\n')),
      firstPage: payload.firstPage || attachments[0]?.page || entry.root.dataset.page || null,
      pageRole: ['selection', 'explicit', 'topic', 'screen'].includes(payload.pageRole) ? payload.pageRole : null,
      selectionSource: payload.selectionSource === 'right' ? 'right' : '',
      docId,
      docTitle: state.doc?.name || payload.docTitle || '',
      history: snapshotHistory(payload.history || state.history),
      reading: snapshotReadingRequest(payload.reading),
      openSeq: state.openSeq, sid,
      useFullText: !!payload.useFullText,
      useWeb: !!payload.useWeb,
      scopeRange: payload.scopeRange || Object.values(SCOPE_RANGES).find((r) => r.full === !!payload.useFullText && r.web === !!payload.useWeb)?.key,
      entry,
      userEntry: null,
    };
    if (!ensureReady()) {
      restoreComposerFallback(pending.question, payload);
      toast('已恢复问题；先配置模型接口，再点发送。', 'ok', 4200);
      return;
    }
    send(pending);
  };
}

async function restoreSession(docId, { only = 'all', skipReplayIfSame = false } = {}) {
  try {
    // B 线 P3：首次打开旧数据 → 懒迁移（旧按文档会话 → 全局问答 + 文档译文，复制不删）
    await migrateLegacySession(docId);
    const sid = activeSidFor(docId);
    const openSeq = state.openSeq;
    // 当前文件夹的问答会话 + 本文档译文伪会话（文档级）
    const [chatRes, translateRes] = await Promise.all([
      fetch(`/api/session?${sessionQuery(sessionScopeKey(), sid)}`),
      fetch(`/api/session?${sessionQuery(docId, TRANSLATE_SID)}`),
    ]);
    if (!chatRes.ok) throw new Error(`HTTP ${chatRes.status}`);
    const savedChat = await chatRes.json();
    const savedTranslate = translateRes.ok ? await translateRes.json() : {};
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    const chatEntries = Array.isArray(savedChat.entries) ? savedChat.entries : [];
    const translateEntries = Array.isArray(savedTranslate.entries) ? savedTranslate.entries : [];
    /* 会话内容变过（换过会话 / 迁移）→ 让所有停放视图失效，否则热切回会挂回旧 DOM。 */
    const sig = chatSigOf(sid, chatEntries);
    /* 同一段会话、聊天 DOM 也已经是它（同一文件夹/全局共用换论文）：完全不用重放，
       连 chatVersion 都不动 —— 否则每切一次标签就把所有热切换停放视图作废，右栏全量重渲染。 */
    const sameLoaded = !!globalChatSig && sig === globalChatSig;
    const sameDom = !!chatDomSig && chatDomSig === sig;
    const replayChat = only === 'chat'
      ? !(skipReplayIfSame && sameLoaded && sameDom)
      : (only !== 'translate' && chatDomSig !== sig);
    const bumpChatVersion = only === 'chat'
      ? !(skipReplayIfSame && sameLoaded && sameDom)
      : !!globalChatSig && sig !== globalChatSig;
    if (bumpChatVersion) chatVersion += 1;
    globalChatSig = sig;
    /* 问答块是全局共用的：切换论文时**不重绘**它。只有两种情况才重放问答：
       ① 换会话（only='chat'）：会话内容换了；② 聊天 DOM 和磁盘上的全局会话对不上（首次打开/迁移过）。
       译文块永远是按文档的：换论文时清空后重放，换会话时原样保留。 */
    // P0 会话选择卡片：only='translate' 时只恢复文档级译文，问答留到用户选了会话/开始新会话再重放
    if (replayChat) clearChatBlock();
    if (only !== 'chat') clearTranslateBlock();
    // 换会话（only='chat'）只重放问答：译文 DOM 没被清，不能再插一遍（下面重放循环按 only 过滤）。
    // 但译文条目必须留在内存与文件缓存里，否则下一次保存会把文档级译文（__translate）覆盖成空。
    const combined = [...chatEntries, ...translateEntries];
    const saved = {
      ...savedChat,
      entries: combined,
      ops: Array.isArray(savedChat.ops) ? savedChat.ops : [],
    };
    state._fileEntries = combined;
    state._fileDocId = docId;
    state.sessionEntries = combined.slice(-90);
    state.history = restoreReadingHistory(savedChat.history, state.sessionEntries);
    // 会话滚动摘要：老会话没有这个字段，按「没有摘要」处理
    state.sessionSummary = typeof savedChat.summary === 'string' ? savedChat.summary.slice(0, 2000) : '';
    state.summaryCovered = Math.max(0, Math.min(Number(savedChat.summaryCovered) || 0, state.history.length));
    // 旧版本提示词生成的摘要不复用（版本升级 → 等下一次自动重算）
    if (savedChat.summary && savedChat.summaryPrompt && savedChat.summaryPrompt !== PROMPT_SYSTEM_VERSION) {
      state.sessionSummary = '';
      state.summaryCovered = 0;
    }
    state.opsDone = {};
    state.opsDoc = docId;
    // 「带我一步步读」的进度随全局会话存盘（状态自带 docId，切换文档时按当前文档过滤）
    state.teaching = { walk: null, current: null };
    const savedWalk = savedChat?.teaching?.walk;
    if (savedWalk && savedWalk.docId === docId && (savedWalk.sid || '') === sid) {
      state.teaching.walk = {
        docId, sid, step: Number(savedWalk.step) || 1, routeCount: savedWalk.routeCount || null,
        updatedAt: savedWalk.updatedAt || nowISO(),
        messages: (Array.isArray(savedWalk.messages) ? savedWalk.messages : []).slice(-16)
          .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 12000) })),
      };
    }
    /* AI 功能记录跟着文件夹会话走：先清空内存缓存，再装回这个会话里的记录（兼容旧 id 格式） */
    state.opsCache.clear();
    state.opsDone = {};
    for (const op of Array.isArray(savedChat.ops) ? savedChat.ops : []) {
      if (!op?.id || typeof op.text !== 'string') continue;
      const key = String(op.id).includes(':') ? String(op.id) : `${docId}:${op.id}`;
      state.opsCache.set(key, { text: op.text.slice(0, 12000), at: op.at || Date.now(), page: op.page || null });
      if (key.startsWith(`${docId}:`)) state.opsDone[key.slice(docId.length + 1)] = true;
    }
    for (let rowIndex = 0; rowIndex < state.sessionEntries.length; rowIndex += 1) {
      let row = state.sessionEntries[rowIndex];
      if (!row || typeof row !== 'object') continue;
      /**
       * 换会话时（`only: 'chat'`）只重放问答：译文那一块的 DOM 没被清，再插一遍就会重复。
       * 换论文时：译文块清空后重放；问答块只在「聊天 DOM 与全局会话对不上」时才重放（否则保留 DOM 不重绘）。
       */
      if (only === 'chat' && row.block !== 'chat') continue;
      if (row.block === 'chat' && !replayChat) continue;
      const safeBlock = AI_BLOCKS.some((b) => b.id === row.block) ? row.block : 'chat';
      // 右栏按需创建：恢复历史不能因为默认 hidden 就访问不存在的 blockMeta。
      ensureBlock(safeBlock);
      if (row.block !== safeBlock) {
        row = { ...row, block: safeBlock };
        state.sessionEntries[rowIndex] = row;
      }
      /**
       * 截图附件单独存：会话里只记了 id，这里按 id 把原图取回来（本机 HTTP）再渲染；
       * 取不到（图片被清掉 / 老会话没有 id）才退回原来的「截图附件未保存」提示。
       */
      const shotRefs = (Array.isArray(row.shots) ? row.shots : []).slice(0, 6);
      let thumbs = [];
      let shotsLost = false;
      if (row.screenshot || shotRefs.length) {
        if (shotRefs.length) {
          const hydrated = await hydrateShotThumbs(shotRefs, docId, sid);
          thumbs = hydrated.thumbs;
          shotsLost = hydrated.missing;
        } else {
          shotsLost = true;   // 老会话：只存了「有过截图」的标记，没有图片本体
        }
      }
      const text = `${String(row.text || '').slice(0, 12000)}${shotsLost ? '\n\n【截图附件未保存，请重新添加截图】' : ''}`;
      const entry = addEntry({ ...row, text, thumbs, restore: true });
      entry.root.__sessionRecord = row;
      // 截图翻译条目：恢复后也要让失败/停止时的「重试截图翻译」按钮可见
      // （译文块默认隐藏 .acts，只靠这个类打开 override，见 style.css）
      if (row.retry && row.retry.kind === 'translate-shot') entry.root.classList.add('msg-shot-translate');
      const priorUser = [...state.sessionEntries.slice(0, rowIndex)].reverse().find((x) => x?.kind === 'user');
      // 恢复出来的回答也要能存笔记：标题默认用上一条用户消息（重放时补上 __question）
      if (row.kind !== 'user' && priorUser) entry.root.__question = String(priorUser.text || '').slice(0, 600);
      const retry = restoreRetryCallback(row, entry, priorUser);
      // 用户口径：恢复出来的回答下面也要有「重新生成」按钮（只要有当时的请求记录）
      const canRegenerate = row.kind !== 'user' && row.block !== 'translate'
        && row.retry && typeof row.retry === 'object';
      if (row.kind !== 'user' && (row.text || row.status === 'stopped' || row.status === 'complete')) finishEntry(entry, row.text || '', {
        page: row.page, sources: row.sources, meta: row.meta, basis: row.basis,
        status: row.status === 'stopped' ? 'stopped' : 'complete',
        onRetry: (row.status === 'stopped' || (row.status === 'complete' && canRegenerate)) ? retry : null,
        retryLabel: '重新生成',
      });
      else if (row.kind !== 'user' && row.status === 'failed') {
        entry.body.textContent = '上次发送失败。问题、文字附件和截图都保留在这次请求里，点「重试这次发送」即可。';
        entry.root.classList.add('err');
        entry.acts.replaceChildren(el('button', { text: '重试这次发送', onclick: retry }));
        entry.acts.classList.remove('hidden');
        entry.root.append(el('div', { class: 'entry-meta failed', text: '发送失败 · 问题和附件仍保留在请求里' }));
      } else if (row.kind !== 'user' && row.status === 'pending') {
        entry.body.textContent = '上次回答尚未完成。';
        entry.acts.replaceChildren(el('button', { text: '恢复并重试', onclick: retry }));
        entry.acts.classList.remove('hidden');
        entry.root.append(el('div', { class: 'entry-meta stopped', text: '未完成 · 点「恢复并重试」继续' }));
      }
      // 教学类条目：补回「继续下一步 / 讲第 N 项 / 这个我懂了」等按钮
      if (row.kind !== 'user' && row.status !== 'pending' && row.status !== 'failed') restoreTeachingEntry(entry, row);
    }
    // 问答 DOM 已与磁盘上的全局会话对齐，记下指纹：下次切论文时不需要再重放
    if (replayChat) chatDomSig = sig;
    // AI 自动标题：只有「服务端自动标题」（首条问题）才升级；手动改名（user）绝不覆盖
    if (String(savedChat.titleSource || 'auto') === 'auto') scheduleSessionTitle();
  } catch (e) { toast(`读取当前论文会话失败：${e.message}`, 'err', 5000); }
}

/** 当前会话里有没有「问答」内容（只剩译文条目不算）：空会话不落盘，避免列表被空会话刷屏 */
function sessionHasChatContent() {
  return state.sessionEntries.some((e) => e && (e.block || 'chat') !== 'translate');
}

/* ── 会话系统 P0 适配层：把 app.js 内部的会话动作包装成 sessions.js 需要的 ctx ──
   sessions.js 只管列表/会话头/历史面板/选择卡片这些「一等公民」界面；
   真正的会话读写、AI 区渲染、忙闲守卫仍由 app.js 负责，避免循环 import。 */
function sessionsContext() {
  return {
    isBusy: () => !!state.busy,
    hasDoc: () => !!state.doc,
    doc: () => (state.doc ? { docId: state.doc.docId, name: state.doc.name } : null),
    currentSid: () => (state.doc ? activeSidFor(state.doc.docId) : ''),
    folderPath: () => currentFolderPath(),
    folderKey: () => currentFolderKey(),
    scopeKey: () => sessionScopeKey(),
    scopeMode: () => readSessionScopeMode(),
    // 历史行里的 fileKey 是服务端规范化后的键（全局 default → default-<hash>）：
    // sessions.js 用它在两种排列下判断「这一行是不是当前归属的副本」
    isScopeFileKey: (fk) => isScopeFileKey(fk),
    // sessions.js 用：这次打开文档是不是「真正进文件夹」；是不是「用户指定了要打开的会话」
    consumeFolderEntry: () => { const v = folderEntryPending; folderEntryPending = false; return v; },
    consumeSessionOpen: () => { const v = pendingSessionOpen; pendingSessionOpen = false; return v; },
    folderKeyOf: (path) => folderKeyOf(path),
    folderDisplayName: (path) => folderDisplayName(path),
    papers: () => state.papers || [],
    toast,
    adoptList: (rows) => { sessionStore.list = rows; },
    showChatAndRender: () => { showAiBlock('chat'); renderAiArea(); },
    renderAi: () => renderAiArea(),
    continueSession: (sid, opts) => switchSession(sid, opts || {}),
    openSessionFromHistory: (row, opts) => openSessionFromHistory(row, opts || {}),
    startNewSession: (opts) => newSession(opts || {}),
    deleteSession: (sid) => deleteSession(sid, { confirm: false }),
    clearCurrentSession: () => clearCurrentSession({ confirm: false }),
    saveNow: () => saveSessionNow(),
    // 会话头/历史面板里的「会话设置」按钮：直接打开设置里的「会话」分类
    openSessionSettings: () => { openSettings(); showSettingsPane('session'); },
    paperMemoryOff: () => isPaperMemoryOff(state.doc?.docId || ''),
    togglePaperMemory: () => togglePaperMemory(),
    restoreChatOnly: () => restoreChatOnly(),
    // 同一段会话跟着换论文（folder / global 模式）：聊天 DOM 已一致时不重放，
    // 避免 chatVersion 失效丢掉其它论文的停放视图（右栏每次切标签都整块重渲染）。
    followCurrentSession: () => followCurrentSession(),
  };
}

/** 选择卡片 →「继续上次」/切回同 sid 时只重放问答（译文已经在文档打开时恢复过了） */
async function restoreChatOnly() {
  if (!state.doc) return;
  await restoreSession(state.doc.docId, { only: 'chat' });
  renderSessionBar();
  updateSendScope();
  loadPaperMemory();
}

/** 换论文但归属模式决定「还是同一段会话」时调用：内容一致就只对齐内存，不动 DOM/聊天版本 */
async function followCurrentSession() {
  if (!state.doc) return;
  await restoreSession(state.doc.docId, { only: 'chat', skipReplayIfSame: true });
  renderSessionBar();
  updateSendScope();
  loadPaperMemory();
}

async function clearCurrentSession({ confirm: askConfirm = true } = {}) {
  if (!state.doc) return;
  if (askConfirm && !confirm(`清空「${state.doc.name}」的对话和 AI 结果？`)) return;
  closeSessionMenu();
  persistSession.cancel?.();
  // 只清问答；译文条目留在内存里（文档级，不属于任何会话），下次保存不会被覆盖成空
  state.sessionEntries = state.sessionEntries.filter((e) => e && e.block === 'translate');
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  // 清空会话 = 清掉问答 + 这个会话里的 AI 功能记录（译文不动）
  resetFolderAiRecords();
  resetTeachingState();
  // 只清问答；译文属于文档级（__translate），DOM 和文件都不动
  clearChatBlock();
  chatVersion += 1;                 // 全局会话被清空：作废所有停放视图
  globalChatSig = '';
  try {
    // 只清全局问答会话；本文档译文（__translate）不动
    const r = await fetch(`/api/session?${sessionQuery(sessionScopeKey(), activeSidFor(state.doc.docId))}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [], history: [], ops: [], teaching: null, summary: '', summaryCovered: 0, updatedAt: Date.now() }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('当前论文会话已清空', 'ok');
    loadPaperMemory();
    sessionsOnSessionChanged({ refresh: false });
  } catch (e) { toastAction(`清空失败：${e.message}`, '重试', clearCurrentSession, 'err', 10000); }
}


/** 正在显示的会话（只在 store 里活；关掉就没了） */
const sessionStore = { open: false, list: [], busySid: null };

function closeSessionMenu() {
  sessionStore.open = false;
  const menu = $('#sessionMenu');
  if (menu) { menu.classList.add('hidden'); menu.replaceChildren(); }
  $('#sessBtn')?.setAttribute('aria-expanded', 'false');
}

/** 拉这篇论文的会话列表（只取元信息，不取正文） */
async function loadSessionList() {
  if (!state.doc) return [];
  try {
    // 会话属于「会话归属方式」决定的空间：默认文件夹；全局共用时统一 default
    const r = await fetch(`/api/sessions?doc=${encodeURIComponent(sessionScopeKey())}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    sessionStore.list = (await r.json()).sessions || [];
  } catch { sessionStore.list = []; }
  return sessionStore.list;
}

/** 会话菜单标题：按「会话归属方式」说清楚这段会话属于谁 */
function sessionListHeadText() {
  const mode = readSessionScopeMode();
  if (mode === 'global') return '全部论文共用的会话';
  if (mode === 'paper') return `「${state.doc?.name || ''}」的会话`;
  return `「${folderDisplayName(currentFolderPath())}」的会话`;
}

/** 画会话菜单：一行一个会话（标题 + 条数 + 时间），底部是「新建会话」 */
function renderSessionMenu() {
  const menu = $('#sessionMenu');
  if (!menu) return;
  const cur = activeSidFor(state.doc?.docId || '');
  const rel = (ts) => {
    const min = Math.floor((Date.now() - (Number(ts) || 0)) / 60000);
    if (!Number.isFinite(min) || min < 1) return '刚看过';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
  };
  const rows = sessionStore.list.map((s) => {
    const on = (s.sid || '') === cur;
    const label = s.title || (s.count ? '（无标题会话）' : '新会话');
    const row = el('div', { class: `sess-row${on ? ' on' : ''}` },
      el('button', {
        type: 'button', class: 'sess-go', title: label,
        onclick: () => switchSession(s.sid || ''),
      },
      el('span', { class: 'sess-title', text: label }),
      // 条数与时间放在标题下面一行：菜单里要能一眼看出哪条是刚才在聊的
      el('span', { class: 'sess-meta', text: [s.count ? `${s.count} 条` : '', rel(s.ts)].filter(Boolean).join(' · ') })),
      el('button', {
        type: 'button', class: 'sess-del',
        title: '删除这个会话（不影响论文和笔记）',
        'aria-label': `删除会话「${label}」`,
        onclick: (e) => { e.stopPropagation(); deleteSession(s.sid || ''); },
      }, iconEl('close', { size: 14 })));
    return row;
  });
  if (!rows.length) rows.push(el('div', { class: 'sess-empty', text: '还没有会话' }));
  menu.replaceChildren(
    el('div', { class: 'sess-head', text: sessionListHeadText() }),
    ...rows,
    el('button', {
      type: 'button', class: 'sess-mem',
      text: isPaperMemoryOff(state.doc?.docId || '') ? '本篇对话记忆：已关闭（点开启）' : '本篇对话记忆：开（点关闭）',
      title: '新会话是否参考这篇论文之前会话的摘要；不影响各会话自己的历史',
      onclick: () => togglePaperMemory(),
    }),
    el('button', {
      type: 'button', class: 'sess-clear', text: '清空当前会话',
      onclick: () => clearCurrentSession(),
    }),
    el('button', {
      type: 'button', class: 'sess-new', text: '新建会话',
      onclick: () => newSession(),
    }),
  );
}

/** 切换「本篇对话记忆」开关（只影响注入，不删任何会话） */
function togglePaperMemory() {
  const docId = state.doc?.docId;
  if (!docId) return;
  const off = !isPaperMemoryOff(docId);
  setPaperMemoryOff(docId, off);
  renderSessionMenu();
  if (off) {
    state.paperMemory = '';
    toast('已关闭：新会话不再参考本篇之前的讨论', 'ok', 2200);
  } else {
    loadPaperMemory().then(() => toast('已开启：新会话会参考本篇之前的讨论', 'ok', 2200));
  }
}

async function toggleSessionMenu() {
  const menu = $('#sessionMenu');
  if (!menu) return;
  if (sessionStore.open) { closeSessionMenu(); return; }
  sessionStore.open = true;
  menu.classList.remove('hidden');
  $('#sessBtn')?.setAttribute('aria-expanded', 'true');
  menu.replaceChildren(el('div', { class: 'sess-empty', text: '读取中…' }));
  await loadSessionList();
  if (sessionStore.open) renderSessionMenu();
}

/** 把当前会话存盘后，切到另一个 sid（空串 = 老的单会话文件）
 *  force=true：选择卡片里点「继续上次」时即使 sid 相同也要重新重放问答 */
async function switchSession(sid, { force = false } = {}) {
  if (!state.doc) return;
  if (state.busy) {
    toast('正在生成中，先等它跑完或点停止再切换会话', 'err', 3200);
    return;
  }
  const docId = state.doc.docId;
  if (!force && activeSidFor(docId) === (sid || '')) { closeSessionMenu(); return; }
  // force=true 来自「进文件夹选择卡片」：此时问答根本还没从磁盘装回来，
  // 先 saveSessionNow 会把当前空条目写进目标会话（实测会清空！）——必须跳过。
  // 空会话（只有译文条目）也不存，避免新建后没说话就留下一堆空会话文件。
  if (!force && sessionHasChatContent()) {
    persistSession.cancel?.();
    try { if (sessionSaveInFlight) await sessionSaveInFlight; await saveSessionNow(); } catch { /* 存不下也允许切 */ }
  }
  setActiveSidFor(docId, sid || '');
  clearChatBlock();                 // 会话只管问答，译文留着
  chatVersion += 1;                 // 换了会话 = 全局会话内容变了：作废所有停放视图（否则切回旧标签还是旧会话）
  // 译文条目留在内存里：切会话后还会保存，不能因为换会话把文档级译文覆盖成空
  state.sessionEntries = state.sessionEntries.filter((e) => e && e.block === 'translate');
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  resetFolderAiRecords();
  await restoreSession(docId, { only: 'chat' });
  loadPaperMemory();
  closeSessionMenu();
  renderSessionBar();
  updateSendScope();
  toast('已切换会话', 'ok', 1600);
  // 从历史里打开的会话可能刚被 adopt 到当前归属键，当前列表里还没有它：刷新一次，
  // 会话头 / 快速切换才能显示正确标题（否则会短暂显示「（无标题会话）」）。
  const known = !sid || (sessionsGetList() || []).some((r) => r.sid === sid);
  await sessionsOnSessionChanged({ refresh: !known });
}

/** 把某个归属键下的会话完整复制到另一个归属键：entries / history / docIds / docTitles /
 *  标题 / 摘要全都保留。用于「换论文时对话怎么接」切模式、以及从历史打开别的归属键下的
 *  旧会话。成功返回 true；源文件不存在或网络失败返回 false（旧文件不动，不会丢数据）。 */
async function copySessionAcrossScope(fromKey, toKey, sid) {
  if (!fromKey || !toKey || !sid || fromKey === toKey) return false;
  try {
    const r = await fetch(`/api/session?${new URLSearchParams({ doc: fromKey, sid })}`);
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) return false;
    const body = {
      entries: data.entries,
      history: data.history,
      ops: data.ops,
      teaching: data.teaching,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      folderPath: currentFolderPath(),
      docIds: data.docIds,
      docTitles: data.docTitles,
      title: data.title || '',
      titleSource: data.titleSource === 'user' ? 'user' : (data.titleSource === 'ai' ? 'ai' : 'auto'),
      summary: data.summary,
      summaryCovered: data.summaryCovered,
      summaryPrompt: data.summaryPrompt,
    };
    const w = await fetch(`/api/session?${new URLSearchParams({ doc: toKey, sid })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return w.ok;
  } catch {
    return false;
  }
}

/** 跨「会话归属键」打开旧会话：历史里的会话可能属于别的文件夹键（folder/paper/global 切换后），
 *  切过去前把内容复制到当前归属键，这样对话能完整接上；旧文件保留不动（相当于自动备份，不迁移不删除）。 */
async function adoptRowIntoScope(row) {
  const sid = String(row?.sid || '');
  const fromKey = String(row?.fileKey || '');
  const toKey = sessionScopeKey();
  if (!sid || !fromKey || fromKey === toKey) return;
  if (await copySessionAcrossScope(fromKey, toKey, sid)) await loadSessionList();
}

/** 历史面板里点一条会话：它可能属于别的文件夹 / 别的论文。
 *  「全部做好防护」原则：只要当前这篇论文能接上这段对话（当前指针就是它 / 当前归属键下
 *  有副本 / 会话读过当前论文 / 点的是当前论文分组），就原地切换，绝不换论文；
 *  只有会话确实不涉及当前论文时才按点击的分组或 docIds 打开目标论文。
 *  论文已不在 papers/ 里时给提示（历史行仍保留，不会丢）。 */
async function openSessionFromHistory(row, { force = false, docIdHint = '' } = {}) {
  if (!row || !state.doc) return;
  if (state.busy) {
    toast('正在生成中，先等它跑完或点停止再切换会话', 'err', 3200);
    return;
  }
  const sid = String(row.sid || '');
  const folder = String(row.folderPath || '');
  const ids = Array.isArray(row.docIds) ? row.docIds.map(String).filter(Boolean) : [];
  const currentId = state.doc.docId;
  const hintId = String(docIdHint || '');
  const globalScope = readSessionScopeMode() === 'global';
  const scopeKey = sessionScopeKey();
  const copies = Array.isArray(row._copies) ? row._copies : [];
  const hasScopeCopy = !!sid && (row.fileKey === scopeKey
    || copies.some((c) => isScopeFileKey(c?.fileKey)));
  const onCurrentSid = !!sid && activeSidFor(currentId) === sid;

  /** 原地切到这段会话：当前归属键下没有副本时先从旧键复制 → 对齐指针 → 重放 */
  const switchHere = async () => {
    if (!sid) return;
    if (!hasScopeCopy) await adoptRowIntoScope(row);
    if (activeSidFor(currentId) !== sid) setActiveSidFor(currentId, sid);
    try {
      await switchSession(sid, { force: true });
    } catch {
      toast('这段会话读取失败（文件可能已被删除），历史列表已刷新', 'err', 3800);
      await loadSessionList().catch(() => {});
    }
  };

  // 全局共用：所有论文共用一段对话，切换会话不需要换论文。
  if (globalScope) { await switchHere(); return; }

  // ① 当前论文能接上：当前就是这段会话 / 当前归属键下有副本 / 会话读过这篇论文 /
  //    用户点的就是当前论文分组。全部原地切换，绝不跳论文。
  if (sid && (onCurrentSid || hasScopeCopy || ids.includes(currentId) || hintId === currentId)) {
    await switchHere();
    return;
  }

  // ② 会话确实属于别的论文：按点击的分组（若在 docIds 里）或 docIds 顺序选目标论文。
  let targetId = '';
  if (hintId && ids.includes(hintId)) targetId = hintId;
  if (!targetId) targetId = ids[0] || '';
  if (!targetId) {
    // 没有论文信息的旧会话：原地接上
    await switchHere();
    return;
  }
  const paper = (state.papers || []).find((p) => String(p.docId) === targetId);
  if (!paper) {
    const where = `papers/${folder ? `${folder}/` : ''}`;
    toast(`这个会话属于 ${where}，论文已不在书架上，无法直接打开；会话记录仍保留`, 'err', 4600);
    return;
  }
  // 打开论文会顺带切换文件夹（ensureFolderForDoc）。这里已明确指定了要打开的会话，
  // 过程中不要再按「打开文件夹时」策略弹选择卡片 / 新建会话，打开后直接切到目标会话。
  if (state.doc?.docId !== targetId) {
    pendingSessionOpen = true;
    try {
      await openDoc({ name: paper.name, url: paper.url, docId: paper.docId, path: paper.path });
    } finally { pendingSessionOpen = false; }
  }
  if (state.doc?.docId !== targetId) return;   // 打开失败：不要再把 sid 切到错误文档上
  // 打开论文后归属键变了：重新判断当前键下有没有副本，没有就先把旧会话复制过来
  const scopeKeyAfter = sessionScopeKey();
  const hasCopyAfter = sid && (isScopeFileKey(row.fileKey)
    || copies.some((c) => isScopeFileKey(c?.fileKey)));
  if (sid && !hasCopyAfter) await adoptRowIntoScope(row);
  // openDoc → sessionsOnDocOpened 可能重新亮出选择卡片；这次用户已经指定了会话，收起来再切
  sessionsHideEntryCard();
  try {
    await switchSession(sid, { force: true });
  } catch {
    toast('这段会话读取失败（文件可能已被删除），历史列表已刷新', 'err', 3800);
    await loadSessionList().catch(() => {});
  }
}

/** 新建一个空会话并切过去；silent=true：进文件夹自动新建（不弹提示）
 *  fromEntry=true：从「进文件夹选择卡片」进来，问答还没装回内存 —— 不能先保存（会把空条目写进旧会话） */
async function newSession({ silent = false, fromEntry = false } = {}) {
  if (!state.doc) return;
  if (state.busy) {
    toast('正在生成中，先等它跑完或点停止再新建会话', 'err', 3200);
    return;
  }
  const docId = state.doc.docId;
  // 先把当前会话存盘，再换 sid（顺序不能反，否则那几轮对话就存到新会话名下了）
  // fromEntry=true：问答还没从磁盘装回内存，保存会写空条目，必须跳过
  if (!fromEntry && sessionHasChatContent()) {
    persistSession.cancel?.();
    try { if (sessionSaveInFlight) await sessionSaveInFlight; await saveSessionNow(); } catch { /* 存不下也允许新建 */ }
  }
  setActiveSidFor(docId, newSid());
  clearChatBlock();                 // 新建会话 = 清空问答区；译文不动（它不属于任何会话）
  chatVersion += 1;                 // 新建会话 = 全局会话内容变了：作废所有停放视图
  state.sessionEntries = state.sessionEntries.filter((e) => e && e.block === 'translate');
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  // 新会话 = 清掉 AI 功能记录（深入阅读/教学缓存），菜单里不再显示「已生成」
  resetFolderAiRecords();
  // 新会话先不落盘：首次发消息时 addEntry/finishEntry 会 scheduleSessionSave，
  // 那时才在服务端创建文件（设计 §3.5.3）。空会话不进列表，也就不会出现
  //「新建了几个空会话、继续上次却是空白」的问题。
  await loadSessionList();
  loadPaperMemory();
  closeSessionMenu();
  renderSessionBar();
  updateSendScope();
  if (!silent) toast('已新建会话', 'ok', 1600);
  sessionsOnSessionChanged({ refresh: false });
}

/** 删掉一个会话文件（不碰论文 / 笔记）；删的是当前会话就退回老会话或新建
 *  confirm=false：sessions.js 已用应用内确认框问过了 */
async function deleteSession(sid, { confirm: askConfirm = true } = {}) {
  if (!state.doc) return;
  if (state.busy) {
    toast('正在生成中，先等它跑完或点停止再删除会话', 'err', 3200);
    return;
  }
  const docId = state.doc.docId;
  if (askConfirm && !confirm('删除这个会话？论文和笔记不受影响。')) return;
  try {
    const r = await fetch(`/api/session?${sessionQuery(sessionScopeKey(), sid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) { toast(`删除失败：${e.message}`, 'err', 4000); return; }
  if (activeSidFor(docId) === (sid || '')) {
    setActiveSidFor(docId, '');
    clearChatBlock();
    chatVersion += 1;               // 删了当前会话 = 全局会话内容变了：作废所有停放视图
    // 删会话只清问答；文档级译文条目留在内存里，避免下一次保存把它覆盖成空
    state.sessionEntries = state.sessionEntries.filter((e) => e && e.block === 'translate');
    state.history = [];
    state.sessionSummary = '';
    state.summaryCovered = 0;
    await restoreSession(docId, { only: 'chat' });
    await loadPaperMemory();
  }
  await loadSessionList();
  renderSessionMenu();
  renderSessionBar();
  toast('会话已删除', 'ok', 1600);
  sessionsOnSessionChanged({ refresh: false });
}

function renderSessionBar() {
  const bar = $('#sessBar');
  if (!bar) return;
  // 会话头只在问答块开着的时候出现（译文页不该挂着会话信息）
  const chatActive = !!state.doc && rightPanelInCol(1) === 'chat';
  bar.classList.toggle('hidden', !chatActive);
  if (chatActive) sessionsRefreshHeader();
}

/** 回答下面的来源列表：编号 + 标题（只提供外链） */
function renderSources(sources) {
  const list = el('ol', { class: 'src-list' }, ...sources.map((s, i) => {
    const a = el('a', {
      href: s.url,
      target: '_blank',
      rel: 'noreferrer',
      text: s.title || s.url,
      title: `${s.title || ''}\n${s.url}`,
    });
    // 标成「来源1」而不是「[1]」：论文正文里的 [27] 是它自己的参考文献编号，两者不能混
    const li = el('li', {}, el('span', { class: 'src-n', text: `[来源${s.number || i + 1}]` }), a);
    return li;
  }));
  const details = el('details', { class: 'source-details' },
    el('summary', { text: `来源 ${sources.length} 条` }), list,
  );
  if (uiStyle.showSources) details.open = true;
  return details;
}


const cardPos = new Map();

/**
 * 夹住卡片的位置：
 *   · 装得下就整张留在屏幕里（别出现「按钮被切掉一半」）；
 *   · 卡片比视口还大时才允许露到外面，但至少留 28px 抓手，免得再也拖不回来。
 */
function clampCard(el, left, top) {
  const w = el.offsetWidth || 220;
  const h = el.offsetHeight || 60;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minL = w <= vw ? 0 : vw - w;
  const maxL = w <= vw ? vw - w : Math.max(0, vw - 48);
  const minT = 0;
  const maxT = h <= vh ? vh - h : Math.max(0, vh - 28);
  return {
    left: Math.round(clamp(left, Math.min(minL, maxL), Math.max(minL, maxL))),
    top: Math.round(clamp(top, Math.min(minT, maxT), Math.max(minT, maxT))),
  };
}

/** 把卡片放到指定位置；remember=true 时记下来供下次弹出使用 */
function placeCard(el, left, top, remember = true) {
  const p = clampCard(el, left, top);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  if (remember && el.id) cardPos.set(el.id, p);
  return p;
}

function rememberedCardPos(el) {
  return el?.id ? cardPos.get(el.id) || null : null;
}

function makeDraggable(el, handleSel, { fromAnywhere = false, remember = true } = {}) {
  if (!el) return;
  const handle = handleSel ? el.querySelector(handleSel) : el;
  if (!handle) return;

  let dragging = false;
  let armed = false;      // 已按下，但还没越过阈值
  let sx = 0; let sy = 0; let ox = 0; let oy = 0;
  let suppressClick = false;

  const begin = () => {
    const r = el.getBoundingClientRect();
    dragging = true;
    armed = false;
    el.classList.add('dragging');
    // 设置弹窗平时是靠 flex 居中的，要拖它得先转成 fixed 定位；
    // 用测量到的 rect 当 left/top，视觉上原地不动。
    if (getComputedStyle(el).position !== 'fixed') {
      el.style.position = 'fixed';
      el.style.margin = '0';
    }
    el.style.left = `${Math.round(r.left)}px`;
    el.style.top = `${Math.round(r.top)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    ox = r.left;
    oy = r.top;
  };

  /** 指针捕获要等「真的开始拖」了再要 */
  const capture = (pointerId) => {
    try { handle.setPointerCapture(pointerId); } catch { /* 忽略 */ }
  };
  const release = (pointerId) => {
    try { handle.releasePointerCapture(pointerId); } catch { /* 忽略 */ }
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 输入框里按下不算拖动，否则正文没法选字
    if (e.target.closest('input, textarea')) return;
    // 手柄上的按钮（复制/停止/关闭）要能正常点，别被拖动吃掉；
    // 气泡整条都是按钮，所以它用 fromAnywhere：按钮上也「预备」，但要走够 5px 才算拖。
    const onControl = e.target.closest('button, a, select, label, .no-drag');
    if (onControl && !fromAnywhere) return;
    if (el.id === 'translationCard') e.preventDefault();
    armed = true;
    sx = e.clientX;
    sy = e.clientY;
    if (!fromAnywhere) {
      begin();
      capture(e.pointerId);
    }
    // 注意：这里绝对不能无条件 setPointerCapture ——
    // 指针一旦被捕获，后续 click 的目标会变成捕获元素本身，
    // 气泡上的「译 / 释 / ＋对话 / ✎」就全都点不动了（真实鼠标点，不是脚本 click）。
  });

  handle.addEventListener('pointermove', (e) => {
    if (!armed && !dragging) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (armed && !dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;   // 还在点击的抖动范围内
      begin();
      capture(e.pointerId);
      suppressClick = true;
    }
    placeCard(el, ox + dx, oy + dy, remember);
  });

  const end = (e) => {
    if (!dragging && !armed) return;
    armed = false;
    dragging = false;
    el.classList.remove('dragging');
    release(e.pointerId);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  // 拖完那一下会顺手触发 click，得吃掉，不然会误触卡片上的按钮
  el.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // 双击手柄 = 忘掉拖过的位置，回到自动摆放
  handle.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (!cardPos.has(el.id)) return;
    cardPos.delete(el.id);
    toast('已恢复自动位置');
  });

  if (handleSel) handle.style.cursor = 'grab';
  el.classList.add('draggable-card');
}

function initDraggableCards() {
  // 气泡整条都是按钮，所以用「按下后移动才算拖」的模式；它不记位置，每次贴新的选区
  makeDraggable($('#bubble'), null, { fromAnywhere: true, remember: false });
  makeDraggable($('#translationCard'), '.pop-head', { remember: false });
  $('#translationCardClose')?.addEventListener('click', hideTranslationCard);
  makeDraggable($('#citeBox'), '.pop-head');
  makeDraggable($('#noteBox'), '.pop-head');
  makeDraggable($('.modal-box'), '.modal-head');
  // 双击气泡上的空白处也能把它放回选区旁边
  $('#bubble')?.addEventListener('dblclick', () => hideBubble());
}

/** 浮层重新定位时用：拖动过就用拖动后的位置，没拖过才用自动算出来的 */
function applyCardPos(el, left, top) {
  const savedPos = rememberedCardPos(el);
  if (savedPos) {
    // 卡片尺寸可能变了（比如换了一段译文），重新夹一次别让它跑出屏幕
    return placeCard(el, savedPos.left, savedPos.top, false);
  }
  return { left: Math.round(left), top: Math.round(top) };
}


function initOps() {
  const btn = $('#opsBtn');
  const menu = $('#opsMenu');
  if (!btn || !menu) return;

  const build = () => {
    menu.replaceChildren();
    menu.append(
      el('div', { class: 'ops-head' },
        el('div', { class: 'ops-head-title', text: `读懂论文${state.doc ? '' : '（先打开一篇）'}` }),
        el('div', { class: 'ops-head-note', text: '结果会进右侧问答栏；每一项都能接着追问' })),
    );

    const opButton = (op) => {
      const walk = activeWalk();
      const progress = op.id === 'walk' && walk ? ` · 进行到第 ${walk.step} 步` : '';
      return el('button', {
        class: 'ops-item',
        type: 'button',
        title: op.hint,
        dataset: { op: op.id },
        onclick: () => {
          hideOpsMenu();
          if (op.id === 'visual') { openVisualPicker({}); return; }
          runTeaching(op.id, { force: false });
        },
      },
      el('span', { class: 'ops-icon' }, iconEl(hasIcon(op.icon) ? op.icon : 'ops')),
      el('span', { class: 'ops-text' },
        el('span', { class: 'ops-title', text: op.title + progress }),
        el('span', { class: 'ops-hint', text: op.hint })));
    };
    for (const op of TEACHING_OPS) menu.append(opButton(op));
  };

  btn.onclick = (e) => {
    e.stopPropagation();
    const hidden = menu.classList.contains('hidden');
    if (hidden) { build(); menu.classList.remove('hidden'); } else { hideOpsMenu(); }
  };
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('#opsMenu') || e.target.closest('#opsBtn')) return;
    hideOpsMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideOpsMenu(); });
}

function hideOpsMenu() { $('#opsMenu')?.classList.add('hidden'); }


/** 当前论文 + 当前会话下有效的 walk 进度（换论文/换会话自动失效） */
function activeWalk() {
  const walk = state.teaching?.walk;
  if (!walk || !state.doc) return null;
  if (walk.docId !== state.doc.docId) return null;
  if ((walk.sid || '') !== activeSidFor(state.doc.docId)) return null;
  return walk;
}

function walkSid() {
  return state.doc ? activeSidFor(state.doc.docId) : '';
}

/** 当前会话里找到「当前这篇论文」某能力最近一条已完成回答（跨论文/跨会话都不算命中） */
function teachingEntryFor(opId) {
  const op = teachingOpById(opId);
  if (!op) return null;
  const docId = state.doc?.docId || '';
  if (!docId) return null;
  return [...state.sessionEntries].reverse().find((x) => x?.block === 'chat' && x?.tag === op.title
    && (x.status === 'complete' || x.status === 'stopped') && x?.kind !== 'user'
    && (x.docId || '') === docId) || null;
}

/** 重置教学状态（换会话 / 新建会话 / 清空会话时调用） */
function resetTeachingState() {
  state.teaching = { walk: null, current: null };
  const prefix = state.doc ? `${state.doc.docId}:` : '';
  for (const key of state.teachingCache.keys()) if (!prefix || key.startsWith(prefix)) state.teachingCache.delete(key);
}

/** 把「当前教学对象」写进 system（自由追问时让模型知道还在讲哪一步） */
function teachingProgressBlock() {
  const walk = activeWalk();
  if (!walk) return '';
  return `【当前教学进度】正在用「带我一步步读」，已经讲到第 ${walk.step} 步（共 ${walk.route?.length || walk.routeCount || '?'} 步）。`
    + '用户是在这一步的基础上提问：先解答提问，不要擅自推进到下一步。';
}

/** 当前问题该用哪段论文文本来筛学习档案（有全文用全文，没有用页文本） */
function profileSelectionText(question = '') {
  const docText = state.docText || '';
  return { docText, question };
}

/* ------------------------------------------------------------ 记忆：长期 / 论文讨论 / 会话摘要 */

/** 用户手写「长期记忆」：只影响回答方式与背景，不冒充论文证据 */
function longTermMemoryBlock() {
  const text = String(Settings.data.longTermMemory || '').trim().slice(0, 4000);
  if (!text) return '';
  return `【长期记忆（用户手写，长期有效）】\n${text}\n（以上是用户写的背景与要求；与论文事实冲突时以论文原文为准，用户当前指令优先。）`;
}

/** 这篇论文之前的会话摘要（新会话首轮带上，避免每次从零开始） */
function paperMemoryBlock() {
  const text = String(state.paperMemory || '').trim();
  if (!text) return '';
  return `【这篇论文之前的讨论摘要（由阅读器自动生成，不等于论文原文，不要当证据引用）】\n${text}`;
}

/** 本次会话早先内容的滚动摘要（compaction） */
function sessionSummaryBlock() {
  const text = String(state.sessionSummary || '').trim();
  if (!text) return '';
  return `【本次会话早先内容摘要（由阅读器自动生成，可能不完整；原文仍以最近几轮为准）】\n${text}`;
}

/** 所有问答 / 教学请求共用的「记忆块」：学习画像 + 长期记忆 + 论文讨论 + 会话摘要 */
function askProfileBlock(docText = '', question = '', { docId = '' } = {}) {
  return [
    buildProfileBlock(profileStore.data, docText, question, { docId }),
    longTermMemoryBlock(),
    paperMemoryBlock(),
    sessionSummaryBlock(),
  ].filter(Boolean).join('\n\n');
}

/** 组一份「教学类回答」的档案块（调用前确保 state.docText 已按需加载） */
function teachingProfileBlock(question = '') {
  const { docText } = profileSelectionText(question);
  return askProfileBlock(docText, question, { docId: state.doc?.docId });
}

/** 本论文「之前的讨论记忆」开关（默认开；关掉后不再注入，也不影响会话本身） */
function paperMemoryOffKey(docId) { return `reader.paperMemory.off:${docId}`; }
function isPaperMemoryOff(docId) {
  try { return localStorage.getItem(paperMemoryOffKey(docId)) === '1'; } catch { return false; }
}
function setPaperMemoryOff(docId, off) {
  try {
    if (off) localStorage.setItem(paperMemoryOffKey(docId), '1');
    else localStorage.removeItem(paperMemoryOffKey(docId));
  } catch { /* ignore */ }
}

/** 读取这篇论文最近两个会话的摘要，作为新会话的「之前的讨论」 */
async function loadPaperMemory() {
  const docId = state.doc?.docId;
  state.paperMemory = '';
  if (!docId || state.history.length) return '';
  if (isPaperMemoryOff(docId)) return '';
  try {
    const list = sessionStore.list.length ? sessionStore.list : await loadSessionList();
    const current = activeSidFor(docId);
    // 「本篇之前的讨论」优先用真的读过这篇论文的会话；没有时再退回当前归属范围内的最近会话
    const touchesDoc = (s) => Array.isArray(s.docIds) && s.docIds.map(String).includes(String(docId));
    const scoped = list.filter(touchesDoc);
    const pool = scoped.length ? scoped : list;
    const candidates = pool
      .filter((s) => (s.sid || '') !== current && (s.count || 0) > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 2);
    const parts = [];
    for (const s of candidates) {
      const r = await fetch(`/api/session?doc=${encodeURIComponent(sessionScopeKey())}&sid=${encodeURIComponent(s.sid || '')}`);
      if (!r.ok) continue;
      const data = await r.json();
      const summary = String(data?.summary || '').trim();
      if (summary) parts.push(`· ${s.title || '之前会话'}：${summary.slice(0, 700)}`);
    }
    if (state.doc?.docId !== docId) return '';
    state.paperMemory = parts.join('\n').slice(0, 1800);
    return state.paperMemory;
  } catch { return ''; }
}

let sessionSummaryBusy = false;
/** 会话滚动摘要：历史超过 8 条、比上次摘要多出 ≥4 条时，后台把早先内容合并成摘要 */
function scheduleSessionSummary() {
  if (sessionSummaryBusy) return;
  if (!Settings.ready) return;
  const history = Array.isArray(state.history) ? state.history : [];
  if (history.length <= 8) return;
  const target = history.length - 6;              // 最近 6 条原样发送，更早的进摘要
  const covered = Math.max(0, Math.min(Number(state.summaryCovered) || 0, target));
  if (target - covered < 4) return;
  const docId = state.doc?.docId || '';
  const sid = activeSidFor(docId);
  const previous = state.sessionSummary || '';
  const turns = history.slice(covered, target).map((m) => {
    const who = m.role === 'user' ? '读者' : '助手';
    const content = String(m.content || '').replace(/\s+/g, ' ').slice(0, 900);
    return `${who}：${content}`;
  }).join('\n');
  sessionSummaryBusy = true;
  (async () => {
    try {
      const text = await chat({
        messages: sessionSummaryMessages({ previous, turns }),
        stream: false,
        temperature: 0,
        signal: state.abort?.signal,
        idleMs: 30000,
      });
      if (state.doc?.docId !== docId || activeSidFor(docId) !== sid) return;
      const clean = String(text || '').trim().slice(0, 1200);
      if (!clean) return;
      state.sessionSummary = clean;
      state.summaryCovered = target;
      scheduleSessionSave();
    } catch { /* 摘要失败静默：下一次轮次还会再试 */ }
    finally { sessionSummaryBusy = false; }
  })();
}

/* ── AI 自动标题 ────────────────────────────────────────────────
   会话标题默认由服务端取首条问题（最多 28 字）；这里在后台让模型总结一个
   干净、简短、能区分不同会话的标题。规则：
   · 手动改名（titleSource='user'）永远优先，不再覆盖；
   · 每个会话只生成一次（内存里记 done），失败最多试 2 次；
   · 结果不合格（太长/只有论文名/不像标题）就保留服务端自动标题；
   · 生成过程中用户换了会话/论文，结果直接丢弃。 */
const sessionTitleState = new Map();  // `${scopeKey}::${sid}` → { attempts, done, inflight, hash }
let sessionTitleTimer = null;

function scheduleSessionTitle() {
  if (!aiTitleEnabled() || !Settings.ready) return;
  if (sessionTitleTimer) return;
  sessionTitleTimer = setTimeout(() => {
    sessionTitleTimer = null;
    runSessionTitle();
  }, 1600);
}

function runSessionTitle() {
  if (state.busy || !state.doc) return;
  const docId = state.doc.docId;
  const sid = activeSidFor(docId);
  if (!sid) return;                       // 老的无 sid 默认文件不改名，避免和历史默认会话抢名字
  const entries = Array.isArray(state.sessionEntries) ? state.sessionEntries : [];
  const firstUser = entries.find((e) => e && (e.block || 'chat') === 'chat'
    && e.kind === 'user' && String(e.text || '').trim());
  const firstAnswer = entries.find((e) => e && (e.block || 'chat') === 'chat'
    && e.kind === 'assistant' && e.status === 'complete' && String(e.text || '').trim());
  if (!firstUser || !firstAnswer) return;
  // 归属键在发起时定下：生成期间换论文/换归属方式，不能把标题写到别的会话文件里
  const scopeKey = sessionScopeKey();
  const key = `${scopeKey}::${sid}`;
  let st = sessionTitleState.get(key);
  if (!st) { st = { attempts: 0, done: false, inflight: false, hash: '' }; sessionTitleState.set(key, st); }
  if (st.done || st.inflight) return;
  const hash = `${String(firstUser.text).slice(0, 200)}|${String(firstAnswer.text).slice(0, 200)}`;
  if (st.attempts >= 2 || st.hash === hash) return;
  st.attempts += 1;
  st.hash = hash;
  st.inflight = true;
  const question = String(firstUser.text || '').replace(/\s+/g, ' ').slice(0, 400);
  const answer = String(firstAnswer.text || '').replace(/\s+/g, ' ').slice(0, 900);
  const paper = state.doc?.name || '';
  (async () => {
    try {
      // 先看磁盘上的 meta：手动标题或已生成过的 AI 标题不再重复请求模型
      const head = await fetch(`/api/session?${sessionQuery(scopeKey, sid)}`);
      if (!head.ok) return;
      const headData = await head.json().catch(() => ({}));
      const src = String(headData?.titleSource || 'auto');
      if (src === 'user' || src === 'ai') { st.done = true; return; }
      if (sessionScopeKey() !== scopeKey || state.doc?.docId !== docId || activeSidFor(docId) !== sid) return;
      const raw = await chat({
        messages: sessionTitleMessages({ paper, question, answer }),
        stream: false,
        temperature: 0,
        signal: state.abort?.signal,
        idleMs: 25000,
      });
      // 生成期间换了会话/论文/归属方式：这个结果不属于当前会话，丢弃
      if (state.doc?.docId !== docId || activeSidFor(docId) !== sid || sessionScopeKey() !== scopeKey) return;
      const title = cleanSessionTitle(raw, paper);
      if (!title) return;
      const r = await fetch(`/api/session?${sessionQuery(scopeKey, sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, titleSource: 'ai' }),
      });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      st.done = true;
      sessionsApplyMeta(sid, { title: String(j?.session?.title || title), titleSource: 'ai' });
      renderSessionBar();
    } catch { /* 标题生成失败静默：保留首问自动标题，下次有新内容再试 */ }
    finally { st.inflight = false; }
  })();
}

/** 把模型输出收拾成像标题的一行：去引号/书名号/前缀、去标点尾巴、限长 */
function cleanSessionTitle(raw, paperName = '') {
  let s = String(raw || '').split(/\r?\n/)[0] || '';
  s = s.replace(/^(会话标题|标题|题目)\s*[:：]\s*/, '').replace(/\s+/g, ' ').trim();
  // 模型偶尔套好几层：如 「《标题》。」——括号和尾部标点交替剥，最多剥 4 轮
  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/^[\s"'“”‘’《「『【\[（(]+/, '').replace(/[\s"'“”‘’》」』】\]）)]+$/, '');
    s = s.replace(/^[。．.!！?？:：;；,，、]+/, '').replace(/[。．.!！?？:：;；,，、]+$/, '');
    s = s.trim();
    if (!s) return '';
  }
  if (s.length > 28) s = s.slice(0, 28).replace(/[。．.!！?？:：;；,，、\s]+$/, '').trim();
  const bare = (v) => String(v || '').replace(/\.pdf$/i, '').replace(/[《》\s]/g, '');
  if (paperName && bare(s) === bare(paperName)) return '';   // 只复述论文名没有信息量
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return '';
  return s;
}


function teachingCacheKey(docId, opId, suffix = '') {
  // A 线 P3：缓存键统一带系统版本（改提示词 → 自动失效；旧键自然不再命中）
  return `${docId}:${opId}:@${PROMPT_SYSTEM_VERSION}:p${profileStore.data.revision}${suffix ? `:${suffix}` : ''}`;
}

function teachingCacheGet(docId, opId) {
  return state.teachingCache.get(teachingCacheKey(docId, opId)) || null;
}

function teachingCacheSet(docId, opId, value) {
  state.teachingCache.set(teachingCacheKey(docId, opId), value);
}

/**
 * 「先给我讲明白」交给 AI 自己定讲法：把读者位置、当前页对象、选中文字交给它，
 * 讲解偏好 / 理解边界 / 长期记忆 / 论文旧讨论 / 会话摘要都在 profileBlock 里，
 * 最近几轮对话在 history 里——它据此判断这次该从哪儿讲、讲什么、怎么讲。
 */
async function buildAutoTeachExtra(page) {
  const total = Number(viewer?.numPages) || 0;
  const pct = total ? Math.round((Number(page) / total) * 100) : 0;
  const lines = [
    `【读者当前阅读位置】第 ${page} 页${total ? ` / 共 ${total} 页（约 ${pct}%）` : ''}`,
    '【讲法由你判断】结合上面的材料、记忆与阅读位置自己决定怎么讲（入门总览 / 先补前置 / 接着当前进度 / 讲当前页图表公式…），'
      + '开头可用一句说明选择，然后直接开始；不要问读者想听哪种。',
  ];
  try {
    const docText = await ensureDocTextForObjects();
    const objects = detectPageObjects(pageTextOf(docText || '', page), page);
    if (objects.length) {
      lines.push(`【当前页识别出的图表公式】${objects.map((o) => `${o.label}${o.title ? `（${o.title.slice(0, 40)}）` : ''}`).join('、')}`);
    }
  } catch { /* 对象识别失败不影响讲解 */ }
  const sel = state.selection?.cleanText || '';
  if (sel) lines.push(`【正文里当前选中的文字】${sel.slice(0, 500)}`);
  return lines.join('\n');
}


async function runTeaching(opId, {
  force = false, retryEntry = null, extraUser = '', ask = '', history = [],
  tag = '', teaching = null,
} = {}) {
  const op = teachingOpById(opId);
  if (!op) return null;
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err', 3000); return null; }
  if (state.busy) { toast('正在生成中，等它跑完或者点停止', 'err', 3000); return null; }

  const docId = state.doc.docId;
  const entryTag = tag || op.title;
  // 「先给我讲明白」= AI 自己定讲法：依赖论文内容 + 阅读位置 + 记忆，不能套模板缓存
  //（用户口径：让 AI 根据实际的内容、根据记忆这些背景信息来判断应该如何讲解）。
  const autoDirected = opId === 'intro';
  const teachPage = autoDirected ? (viewer?.currentVisiblePage?.() ?? viewer.current) : viewer.current;

  // 点击语义（用户拍板）：没打开会话 → 先建一个新会话再生成；
  // 会话已打开、且当前这篇论文在这条会话里已有结果 → 直接定位过去；
  // 没有（或结果节点已不在）→ 直接重新生成。内存缓存不再冒充「已生成」。
  if (!force && !retryEntry && !history.length) {
    if (sessionsIsEntryMode()) {
      const left = await sessionsLeaveEntryForNewSession();
      if (!left) return null;
    } else {
      const existing = opId !== 'visual' ? teachingEntryFor(opId) : null;
      if (existing && focusExistingResult(existing, autoDirected ? '先给我讲明白' : op.title)) {
        return { text: String(existing.text || '') };
      }
    }
  }

  if (!ensureReady()) return null;
  const entry = retryEntry || addEntry({
    block: 'chat', tag: entryTag, kind: 'assistant',
    retry: { kind: 'teaching', docId, opId, block: 'chat', ask: String(ask || '').slice(0, 500), extraUser: String(extraUser || '').slice(0, 4000), ...(teaching ? { teaching } : {}) },
  });
  if (retryEntry) {
    entry.body.replaceChildren();
    entry.acts.replaceChildren();
    entry.acts.classList.add('hidden');
    entry.root.classList.remove('err', 'error');
    entry.root.querySelectorAll('.entry-meta, .source-details, .src-list').forEach((node) => node.remove());
    const record = entry.root.__sessionRecord;
    if (record) { record.text = ''; record.meta = ''; record.status = 'pending'; record.chips = []; record.teaching = teaching || null; }
  }
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return null;
  setBusy(true, `0s · ${entryTag}`);
  let received = '';
  try {
    // 「先给我讲明白」：最近几轮对话算记忆，读者的当前位置、当前页对象也算材料
    const convHistory = autoDirected ? (history.length ? history : snapshotHistory(state.history)) : history;
    const autoExtra = autoDirected ? await buildAutoTeachExtra(teachPage).catch(() => '') : '';
    const mergedExtra = [extraUser, autoExtra].filter(Boolean).join('\n\n');
    // 讲法判断需要「整篇论文的主线」；拿单个问题的相关段落会把讲解带偏
    const ctxQuery = autoDirected ? '研究问题 核心方法 关键公式 图表 实验 结论 论文整体' : op.ask;
    const ctx = await buildDocContext(ctxQuery, mergedExtra, { forTeaching: true, page: teachPage });
    const scanned = !!ctx?.profile?.scanned || ctx?.mode === 'scan-digest' || ctx?.mode === 'scan';
    const citationMat = citationMaterialsFor({
      docCtx: ctx, scanned,
      pending: { firstPage: teachPage, reading: null }, pageRole: 'screen',
    });
    activeCitationPlan = null;
    const messages = teachMessages(op, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
      extraUser: mergedExtra,
      ask,
      history: convHistory,
      pageImages: ctx?.pageImages || [],
      profileBlock: teachingProfileBlock(ask || op.ask),
      availablePages: citationMat.availablePages,
    });
    attachPageImages(messages, ctx?.pageImages);
    warnIfNoVisionModel((ctx?.pageImages || []).length > 0);
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s · ${entryTag}`),
    });
    if (state.doc?.docId !== docId) return null;
    const split = splitPrtBlock(full);
    const clean = split.text || full;
    await auditAnswerCitations(clean, { availablePages: citationMat.availablePages, scanned });
    if (state.doc?.docId !== docId) return null;
    target.done(clean);
    finishEntry(entry, clean, {
      page: teachPage, retryLabel: '重新生成', basis: citationMat.basis,
      onRetry: () => runTeaching(opId, { force: true, retryEntry: entry, extraUser, ask, tag, teaching }),
    });
    renderTeachingExtras(entry, { opId, chips: split.chips, teaching });
    if (opId === 'walk' && !history.length) startWalkSession(clean, entry);
    if (autoDirected) {
      // 本轮讲解进会话记忆：之后的追问（「继续」「这里没懂」）和下一次讲解都能接上
      const request = resolveReadingRequest({ question: op.ask, page: teachPage });
      state.history = snapshotHistory([...state.history, ...readingTurn(request, clean)]);
      scheduleSessionSummary();
    } else if (opId !== 'visual' && !history.length) {
      teachingCacheSet(docId, opId, { text: clean, at: Date.now(), page: viewer.current, chips: split.chips, teaching });
    }
    state.teaching.current = teaching || null;
    scheduleSessionSave();
    return { text: clean, chips: split.chips };
  } catch (e) {
    if (state.doc?.docId !== docId) return null;
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, {
        page: teachPage, status: 'stopped',
        onRetry: () => runTeaching(opId, { force: true, retryEntry: entry, extraUser, ask, tag, teaching }),
      });
    } else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => runTeaching(opId, { force: true, retryEntry: entry, extraUser, ask, tag, teaching }));
    }
    return null;
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}


/** 把 chips 画成按钮（prt 块解析出来的自由操作） */
function renderChips(entry, chips) {
  for (const chip of chips) {
    if (chip.op) {
      entry.acts.append(el('button', {
        class: 'act-chip', type: 'button', text: chip.label,
        onclick: () => runOperation(chip.op, { force: false }),
      }));
    } else {
      entry.acts.append(el('button', {
        class: 'act-chip', type: 'button', text: chip.label,
        onclick: () => sendTeachingPrompt(chip.prompt),
      }));
    }
  }
}

/** chip 的 prompt 走普通发送（继承对话历史与当前教学进度） */
function sendTeachingPrompt(prompt) {
  const ta = $('#chatInput');
  if (!ta) return;
  ta.value = String(prompt || '').slice(0, 2000);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  $('#sendBtn')?.click();
}

function renderTeachingExtras(entry, { opId, chips = [], teaching = null } = {}) {
  const record = entry.root.__sessionRecord;
  if (record) {
    record.chips = sanitiseChips(chips);
    record.teaching = teaching ? { kind: teaching.kind || '', name: String(teaching.name || '').slice(0, 160), boundary: String(teaching.boundary || '').slice(0, 2000), page: teaching.page || null } : null;
  }
  const add = (label, onclick, cls = '') => entry.acts.append(el('button', { class: `act-chip ${cls}`.trim(), type: 'button', text: label, onclick }));
  const walk = activeWalk();

  if (opId === 'intro') {
    add('讲简单一点', () => sendTeachingPrompt('上面这一段讲得太细了，请用更简单的话把「这篇论文在做什么」再讲一遍，保留关键页码。'));
    add('给个例子', () => sendTeachingPrompt('给一个更具体的教学例子，把这篇论文要解决的问题说明白（标明是教学例子，不是论文实验）。'));
    add('再压短', () => condenseEntry(entry));
    add('看实验够不够', () => runOperation('evidence', { force: false }), 'deep');
    add('它有什么局限', () => runOperation('limits', { force: false }), 'deep');
    renderChips(entry, chips.filter((c) => c.op !== 'evidence' && c.op !== 'limits'));
  } else if (opId === 'prereq' && teaching?.kind === 'prereq-item') {
    // 单项前置知识：只留「再讲一次 / 再压短」；没有「讲第 N 项」（这一条就是从清单点进来的）
    renderChips(entry, chips);
    add('再压短', () => condenseEntry(entry));
  } else if (opId === 'prereq') {
    // 优先用模型给的 chips；没有再解析回答里的加粗名称兜底
    const chipItems = chips.filter((c) => c.prompt && !c.op);
    if (chipItems.length) renderChips(entry, chipItems);
    else {
      const names = parsePrereqItems(record?.text || '');
      names.forEach((name, i) => add(`讲第 ${i + 1} 项`, () => runPrereqItem(name, entry)));
    }
    add('大概都懂了，开始读', () => runTeaching('walk', { force: false }));
    add('再压短', () => condenseEntry(entry));
    renderChips(entry, chips.filter((c) => c.op));
  } else if (opId === 'walk') {
    add('继续下一步', () => continueWalk('continue', entry));
    add('讲简单一点', () => continueWalk('simpler', entry));
    add('给个例子', () => continueWalk('example', entry));
    add('重新规划路线', () => { state.teaching.walk = null; scheduleSessionSave(); runTeaching('walk', { force: true }); });
    add('再压短', () => condenseEntry(entry));
    renderChips(entry, chips.filter((c) => c.op));
  } else if (opId === 'visual') {
    add('换一个对象', () => openVisualPicker({ replace: true }));
    add('讲简单一点', () => sendTeachingPrompt('刚才这个图表/公式讲得有点难，请用更简单的说法再讲一遍重点。'));
    add('再压短', () => condenseEntry(entry));
    renderChips(entry, chips);
  } else {
    renderChips(entry, chips);
  }

  if (teaching?.name) add('这里没懂', () => reexplainTeaching(teaching), 'dunno');
}

/* 后台任务不占用前台 busy/stop 状态；失败静默，绝不污染回答或主动确认。 */
const learningMemory = createLearningMemory({
  store: profileStore,
  extract: async (messages) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      return await streamChat({ messages, stream: false, temperature: 0, signal: controller.signal, idleMs: 25000 });
    } finally { clearTimeout(timeout); }
  },
});

/** 用户明确说「记住」的身份自述：确定性写入，不等模型提取（失败静默） */
function rememberExplicitIdentity(question, source = null) {
  if (!Settings.ready || !profileStore.enabled) return Promise.resolve();
  const facts = explicitIdentityFacts(question);
  if (!facts.length) return Promise.resolve();
  const src = source || { docId: state.doc?.docId || '', paper: state.doc?.name || '', capability: 'chat' };
  return profileStore.update((current) => withMemoryObservations(current, facts, { source: src, at: nowISO() }) || current)
    .catch(() => {});
}

function scheduleMemoryExtraction({ question = '', answer = '', history = [], topic = '', source = null, capability = 'chat' } = {}) {
  if (!Settings.ready || !profileStore.enabled) return Promise.resolve();
  const src = source || { docId: state.doc?.docId || '', paper: state.doc?.name || '', capability };
  // 「我叫 Cyan，请记住」这类：先确定性记住称呼，再跑常规后台提取
  rememberExplicitIdentity(question, src);
  return learningMemory.observe({ question, answer, history, topic, source: src });
}

/** 反馈直接走正常追问，由后台从用户的明确原话更新理解边界。 */
function reexplainTeaching(teaching) {
  state.teaching.current = teaching;
  sendTeachingPrompt('这里没懂：「' + teaching.name + '」没听懂。请先不往下推进，换一种更基础的说法，从我可能缺的最基础的一步讲起，并给一个最小例子。');
}

/** 点列表里的某一项：单独讲这一项前置知识 */
async function runPrereqItem(name, listEntry) {
  if (!state.doc || state.busy) return;
  const item = findItem(profileStore.data, name);
  const teaching = {
    kind: 'prereq-item', name,
    level: item?.level || '',
    boundary: item?.boundary || '能用自己的话说清它是什么、本文为什么需要它',
    page: viewer?.current || null,
  };
  const extraUser = [
    `【用户点开的前置知识】${name}`,
    '【要求】只讲这一项，不要重复整份清单；结尾回到论文原文（章节 + 页码）。',
  ].join('\n');
  await runTeaching('prereq', {
    force: true, extraUser, ask: `讲第几项：${name}`, tag: `先懂一点：${name}`,
    teaching,
  });
}

/** 压缩上一条回答（「再压短」） */
async function condenseEntry(entry) {
  if (!state.doc || state.busy) return;
  const rec = entry.root.__sessionRecord;
  const answer = String(rec?.text || '').trim();
  if (!answer) return;
  if (!ensureReady()) return;
  const shortEntry = addEntry({ block: 'chat', tag: '精简版', kind: 'assistant' });
  const target = streamTarget(shortEntry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s · 精简版');
  let received = '';
  try {
    const full = await chat({
      messages: condenseMessages({ answer, docTitle: state.doc?.name }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s · 精简版`),
    });
    target.done(full);
    finishEntry(shortEntry, full, { page: rec?.page || viewer.current, onRetry: () => condenseEntry(entry) });
  } catch (e) {
    if (isAbort(e)) { target.done(received); finishEntry(shortEntry, received, { status: 'stopped' }); }
    else { target.fail(errText(e)); addFailureRetry(shortEntry, errText(e), () => condenseEntry(entry)); }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}


/**
 * 点「继续下一步 / 讲简单一点 / 给个例子」。
 * 三类操作共用一条续讲链路，只有 system 与用户指令不同；「继续」才推进 step。
 */
async function continueWalk(kind, entry) {
  if (!state.doc || state.busy) return;
  const walk = activeWalk();
  if (!walk) { toast('教学进度已失效，请重新点「带我一步步读」', 'err', 3200); return; }
  if (!ensureReady()) return;
  const nextStep = walk.step + 1;
  const instruction = kind === 'continue' ? '继续下一步。'
    : kind === 'example' ? '这一步给一个具体例子，不要推进到下一步。'
      : '这一步讲简单一点，不要推进到下一步。';
  const sys = kind === 'continue' ? WALK_CONTINUE_SYS : walkReteachSys(kind);
  const tag = kind === 'continue' ? `第 ${nextStep} 步` : (kind === 'example' ? '给个例子' : '讲简单一点');
  const newEntry = addEntry({ block: 'chat', tag, kind: 'assistant', retry: { kind: 'teaching', docId: state.doc.docId, opId: 'walk', block: 'chat' } });
  const target = streamTarget(newEntry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, `0s · ${tag}`);
  let received = '';
  try {
    const ctx = await buildDocContext('继续下一步', '', { forTeaching: true, page: viewer.current });
    const history = walk.messages.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 12000) }));
    const messages = teachMessages({ sys, ask: instruction }, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
      history,
      ask: instruction,
      pageImages: ctx?.pageImages || [],
      profileBlock: teachingProfileBlock(instruction),
    });
    attachPageImages(messages, ctx?.pageImages);
    warnIfNoVisionModel((ctx?.pageImages || []).length > 0);
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s · ${tag}`),
    });
    const split = splitPrtBlock(full);
    const clean = split.text || full;
    target.done(clean);
    finishEntry(newEntry, clean, { page: viewer.current });
    // 只有「继续」才推进；讲简单/给例子仍停在这一步
    walk.messages.push({ role: 'user', content: instruction }, { role: 'assistant', content: clean });
    if (kind === 'continue') walk.step = nextStep;
    walk.updatedAt = nowISO();
    scheduleSessionSave();
    renderTeachingExtras(newEntry, { opId: 'walk', chips: split.chips, teaching: null });
    if (kind !== 'continue') scheduleMemoryExtraction({ question: instruction, answer: clean,
      history, topic: String(walk.route?.[walk.step - 1]?.title || ''),
      source: { docId: walk.docId, paper: state.doc?.name || '', capability: 'walk:' + kind } });
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      finishEntry(newEntry, received, { status: 'stopped', onRetry: () => continueWalk(kind, newEntry) });
    } else {
      target.fail(errText(e));
      addFailureRetry(newEntry, errText(e), () => continueWalk(kind, newEntry));
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

/** 「带我一步步读」首轮结束：初始化/覆盖教学进度 */
function startWalkSession(cleanText, entry) {
  const walk = activeWalk() || { docId: state.doc.docId, sid: walkSid(), step: 0, messages: [] };
  walk.step = 1;
  walk.updatedAt = nowISO();
  walk.routeCount = (String(cleanText).match(/^\s*(?:\d+[.、)]|[-*])\s+/gm) || []).length || null;
  // 首轮消息：用户初始任务 + 助手回答（续讲时作为历史发回模型）
  walk.messages = [
    { role: 'user', content: '带我一步步读这篇论文：先给路线，再开始第一步。' },
    { role: 'assistant', content: String(cleanText || '').slice(0, 12000) },
  ];
  state.teaching.walk = walk;
  scheduleSessionSave();
}


/** 确保整篇文本已抽出（对象识别要用；不触发模型索引） */
async function ensureDocTextForObjects() {
  if (state.docText && state.docTextDoc === state.doc?.docId) return state.docText;
  if (!viewer?.pdf) return '';
  try {
    const text = await viewer.getAllText();
    if (state.doc?.docId) { state.docText = text; state.docTextDoc = state.doc.docId; }
    return text;
  } catch { return state.docText || ''; }
}

async function openVisualPicker({ replace = false } = {}) {
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err', 3000); return; }
  const menu = $('#opsMenu');
  if (!menu) return;
  menu.classList.remove('hidden');
  menu.replaceChildren(el('div', { class: 'ops-head' },
    el('div', { class: 'ops-head-title', text: '讲懂图表与公式' }),
    el('div', { class: 'ops-head-note', text: `正在读取第 ${viewer.current} 页的对象…` })));
  const docText = await ensureDocTextForObjects();
  const page = viewer.current;
  const objects = detectPageObjects(pageTextOf(docText, page), page);
  const fullList = () => {
    const all = collectDocObjects(docText);
    menu.replaceChildren(
      el('div', { class: 'ops-head' },
        el('div', { class: 'ops-head-title', text: '全文的图表与公式' }),
        el('div', { class: 'ops-head-note', text: '选一个：会先跳到那一页，再讲懂它' })),
      el('button', { type: 'button', class: 'ops-back', text: '← 回到当前页', onclick: () => openVisualPicker({ replace: true }) }),
      ...(all.length ? all.map((obj) => el('button', {
        type: 'button', class: 'ops-item ops-obj',
        onclick: () => { hideOpsMenu(); jumpToPageWithHistory(Number(obj.page) || page, { smooth: true }); setTimeout(() => runVisual(obj), 260); },
      },
      el('span', { class: 'ops-icon' }, iconEl(obj.kind === 'table' ? 'chart' : obj.kind === 'formula' ? 'formula' : 'explain')),
      el('span', { class: 'ops-text' },
        el('span', { class: 'ops-title', text: `${obj.label}${obj.page ? ` · 第 ${obj.page} 页` : ''}` }),
        el('span', { class: 'ops-hint', text: obj.title || obj.snippet || '（抽取文本里没有标题）' })))) : [
        el('div', { class: 'ops-empty', text: '整篇文本里没识别到图/表/公式编号。可以直接用「框选截图」把这一块发进对话问。' }),
      ]),
    );
  };
  const head = [
    el('div', { class: 'ops-head-title', text: '讲懂图表与公式' }),
    el('div', { class: 'ops-head-note', text: `当前是第 ${page} 页；先选一个对象（不会默认分析整篇）` }),
  ];
  const items = objects.map((obj) => el('button', {
    type: 'button', class: 'ops-item ops-obj',
    onclick: () => { hideOpsMenu(); runVisual(obj); },
  },
  el('span', { class: 'ops-icon' }, iconEl(obj.kind === 'table' ? 'chart' : obj.kind === 'formula' ? 'formula' : 'explain')),
  el('span', { class: 'ops-text' },
    el('span', { class: 'ops-title', text: obj.label }),
    el('span', { class: 'ops-hint', text: obj.title || obj.snippet || '（抽取文本里没有标题）' }))));
  const extras = [
    el('button', { type: 'button', class: 'ops-back', text: '看全文的图表清单', onclick: fullList }),
  ];
  if (!objects.length) {
    menu.replaceChildren(
      el('div', { class: 'ops-head' }, ...head),
      el('div', { class: 'ops-empty', text: `第 ${page} 页没识别到图 / 表 / 公式编号（可能是扫描页，或标题被拆行）。` }),
      el('button', { type: 'button', class: 'ops-back', text: '看全文的图表清单', onclick: fullList }),
      el('div', { class: 'ops-empty', text: '也可以回到正文框选一块图/表/公式，用「⎚ 截图」发进对话问。' }),
    );
    return;
  }
  if (objects.length === 1) {
    hideOpsMenu();
    runVisual(objects[0]);
    return;
  }
  menu.replaceChildren(el('div', { class: 'ops-head' }, ...head), ...items, ...extras);
}

/** 选中对象后真正跑「讲懂图表与公式」 */
async function runVisual(obj) {
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err', 3000); return; }
  const page = Number(obj.page) || viewer.current;
  let pageText = pageTextOf(state.docText || '', page);
  if (!pageText) {
    await ensureDocTextForObjects();
    pageText = pageTextOf(state.docText || '', page);
  }
  const kindName = obj.kind === 'table' ? '表格' : obj.kind === 'formula' ? '公式' : obj.kind === 'algorithm' ? '算法' : '图';
  const extraUser = [
    `【当前页】p.${page}`,
    `【用户选择的对象】${obj.label}（${kindName}）${obj.title ? `：${obj.title}` : ''}`,
    '【当前页识别出的对象】' + (detectPageObjects(pageText, page).map((o) => o.label).join('、') || '（只有这一个）'),
    '【当前页文本（供定位；图内标签可能缺失）】',
    '"""',
    String(pageText || '').slice(0, 8000),
    '"""',
  ].join('\n');
  const teaching = { kind: `visual-${obj.kind}`, name: obj.label, boundary: '知道这个图/表/公式在表达什么、怎么看', page };
  await runTeaching('visual', {
    force: true, extraUser, ask: `讲懂第 ${page} 页的 ${obj.label}`,
    tag: `讲懂：${obj.label}`, teaching,
  });
}

/** 深入阅读按钮的「后续建议」标签（保留给自动化测试识别） */
function teachingDeepButtons() { return ['看实验够不够', '它有什么局限']; }

/**
 * 恢复会话时给教学条目补回按钮（普通 finishEntry 只画「复制 / 填笔记 / 重新生成」）。
 * 只补静态按钮，不再重新请求模型。
 */
function restoreTeachingEntry(entry, row) {
  if (!row || row.kind === 'user') return;
  const op = TEACHING_OPS.find((o) => o.title === row.tag);
  const teach = row.teaching || null;
  const chips = Array.isArray(row.chips) ? sanitiseChips(row.chips) : [];
  if (op) {
    renderTeachingExtras(entry, { opId: op.id, chips, teaching: teach });
    if (op.id === 'walk' && activeWalk() && row.tag === TEACHING_OPS.find((o) => o.id === 'walk').title) {
      // 首轮回答：初始化 walk（老的存档没有 teaching 字段也能接上）
      if (!activeWalk()) startWalkSession(row.text || entry.root.__sessionRecord?.text || '', entry);
    }
  } else if (row.tag === '精简版') {
    // 无需额外按钮
  } else if (teach) {
    renderTeachingExtras(entry, { opId: 'prereq', chips, teaching: teach });
  }
}

/**
 * 跑一个操作。
 * 材料走 buildDocContext()：它已经处理好「全文 / 超长降级成索引+相关段落 / 按 docId 缓存」，
 * 操作不需要各自再实现一遍。
 */
async function runOperation(opId, { force = false, block = 'chat', retryEntry = null } = {}) {
  const op = opById(opId);
  if (!op) return null;
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err', 3000); return null; }
  if (state.busy) { toast('正在生成中，等它跑完或者点停止', 'err', 3000); return null; }

  const docId = state.doc.docId;
  const cacheKey = `${docId}:${opId}`;
  const hit = state.opsCache.get(cacheKey);

  // 已经跑过就直接用缓存，不再花钱（除非点「重新生成」）
  if (hit && !force) {
    const existing = [...state.sessionEntries].reverse().find((x) => x?.block === block && x?.tag === op.title
      && x?.status === 'complete' && (x.retry?.opId === opId || String(x.text || '') === String(hit.text || '').slice(0, 12000)));
    if (existing) {
      state.opsDone[opId] = true;
      focusExistingResult(existing, op.title);
      return hit;
    }
    // 旧会话可能只保留了缓存而没有 DOM 记录：复用缓存，不凭空追加第二条结果。
    state.opsDone[opId] = true;
    toast(`「${op.title}」已恢复，点「重新生成」可以重跑`, 'ok', 3000);
    return hit;
  }

  if (!ensureReady()) return null;
  const entry = retryEntry || addEntry({ block, tag: op.title,
    retry: { kind: 'operation', docId, opId, block } });
  if (retryEntry) {
    entry.body.replaceChildren();
    entry.acts.replaceChildren();
    entry.acts.classList.add('hidden');
    entry.root.classList.remove('err', 'error');
    entry.root.querySelectorAll('.entry-meta, .source-details, .src-list').forEach((node) => node.remove());
    const record = entry.root.__sessionRecord;
    if (record) { record.text = ''; record.meta = ''; record.status = 'pending'; }
  }
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return null;
  setBusy(true, `0s · ${op.title}`);
  let received = '';
  try {
    const ctx = await buildDocContext(op.ask, '', { forTeaching: true, page: viewer.current });
    const scanned = !!ctx?.profile?.scanned || ctx?.mode === 'scan-digest' || ctx?.mode === 'scan';
    const citationMat = citationMaterialsFor({
      docCtx: ctx, scanned, pending: { firstPage: viewer.current, reading: null }, pageRole: 'screen',
    });
    activeCitationPlan = null;
    const messages = opMessages(op, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
      pageImages: ctx?.pageImages || [],
      profileBlock: teachingProfileBlock(op.ask),
      availablePages: citationMat.availablePages,
    });
    attachPageImages(messages, ctx?.pageImages);
    warnIfNoVisionModel((ctx?.pageImages || []).length > 0);
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s · ${op.title}`),
    });
    if (state.doc?.docId !== docId) return null;
    await auditAnswerCitations(full, { availablePages: citationMat.availablePages, scanned });
    if (state.doc?.docId !== docId) return null;
    target.done(full);
    state.opsCache.set(cacheKey, { text: full, at: Date.now(), page: viewer.current });
    state.opsDone[opId] = true;
    if (state.opsDoc !== docId) { state.opsDoc = docId; }
    finishEntry(entry, full, {
      page: viewer.current,
      basis: citationMat.basis,
      onAsk: () => { state.quote = { page: viewer.current, text: full.slice(0, 2000) }; toast('已设为引用，直接提问即可', 'ok', 2500); },
    });
    entry.acts.append(el('button', { text: '重新生成', onclick: () => runOperation(opId, { force: true, block, retryEntry: entry }) }));
    return { text: full };
  } catch (e) {
    if (state.doc?.docId !== docId) return null;
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, {
        page: viewer.current, status: 'stopped',
        onRetry: () => runOperation(opId, { force: true, block, retryEntry: entry }),
      });
    } else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => runOperation(opId, { force: true, block, retryEntry: entry }));
    }
    return null;
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

/** 从检索结果里挑一个能打开的 http(s) 链接（优先 PDF 直链） */
function searchResultUrl(r) {
  const cand = r?.pdfUrl || r?.url || '';
  return /^https?:\/\//i.test(cand) ? cand : '';
}


/** 归一化标题：只留字母数字和汉字，用来判断「这条文献是不是书架里的某篇」 */
function titleKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

/** 书架论文的标题索引。要求 ≥8 个字符：太短的文件名（bert.pdf）误判率太高，不参与匹配 */
function libIndex() {
  const out = [];
  for (const p of state.papers) {
    const key = titleKey(p.name.replace(/\.pdf$/i, ''));
    if (key.length >= 8) out.push({ key, paper: p });
  }
  return out;
}

function findInLibrary(text, idx) {
  const t = titleKey(text);
  if (t.length < 8) return null;
  for (const { key, paper } of idx) if (t.includes(key)) return paper;
  return null;
}

/**
 * 顶部那一行的临时进度。单独存在 state.relHint 里，是为了让 renderRelations() 重绘时
 * 不把进度覆盖掉（以前 relHint 写完就被 renderRelations 的 innerHTML 冲掉，进度一闪而过）。
 */
function relHint(t) {
  state.relHint = t || '';
  const node = $('#relSummary');
  if (node && state.relHint) node.textContent = state.relHint;
}

/* ── 阶段 3：引用条目的显式状态模型 ──────────────────────────────────────
   以前靠 `r.found?.pdfUrl` 的真值猜状态，「还没查 / 查过了但没有 / 查失败」在界面上
   分不出来，失败也不能单独重试。现在状态是显式枚举： */

/** status 枚举 + 徽标文案 + 归到哪一组 */
const REL_STATUS = {
  local:   { tag: '书架已有', cls: 'lib', group: 'lib' },
  idle:    { tag: '未查',     cls: '',    group: 'todo' },
  loading: { tag: '查询中',   cls: '',    group: 'todo' },
  pdf:     { tag: '已找到',   cls: 'has', group: 'pdf' },
  landing: { tag: '落地页',   cls: 'has', group: 'todo' },
  none:    { tag: '未找到',   cls: '',    group: 'todo' },
  error:   { tag: '查询失败', cls: 'err', group: 'todo' },
};

const REL_GROUPS = [
  { id: 'lib', title: '书架已有' },
  { id: 'pdf', title: '已找到开放版本' },
  { id: 'todo', title: '待查 / 未找到' },
];

/**
 * 稳定 key：编号 + 文本前 60 字。
 * 「↻ 重新解析」会整批换掉 ref 对象，但在途请求靠这个 key 仍能落回重建后的新对象，
 * 而不是写进被丢弃的旧对象（那正是 `busy` 永久卡住的根因）。
 */
function relKey(ref) {
  return `${Number(ref?.num) || 0}:${String(ref?.text || '').slice(0, 60)}`;
}

/** 取某条引用的状态槽；key 相同但换了论文（同编号同开头，极少见）就重建一个 */
function relSlot(docId, ref) {
  const key = relKey(ref);
  let slot = state.relItemState.get(key);
  if (!slot || slot.docId !== docId) {
    slot = { key, docId, status: 'idle', found: null, fail: '', guessed: '' };
    state.relItemState.set(key, slot);
  }
  return slot;
}

/** 只查不建：正文里点的 [n] 未必在 state.refs 里（文本抽取口径略有差异），别为它凭空造槽 */
function relSlotIfAny(docId, ref) {
  const slot = state.relItemState.get(relKey(ref));
  return slot && slot.docId === docId ? slot : null;
}

/** 显式状态：书架里已经有这篇就是 local，其余看状态槽 */
function relStatusOf(docId, ref) {
  if (ref?.lib) return 'local';
  return relSlot(docId, ref).status;
}

/** 把一次检索结果写进状态槽（单条查 / 详情里查 / 搜索卡片都走这里，口径只有一个） */
function applyResultsToSlot(docId, ref, data) {
  if (!docId || ref?.lib) return null;
  const slot = relSlot(docId, ref);
  const list = (data?.results || []).filter((x) => x.pdfUrl || x.url);
  slot.found = list.find((x) => x.pdfUrl) || list[0] || null;   // 优先带 PDF 直链的
  slot.guessed = data?.title || '';
  slot.fail = '';
  slot.status = slot.found ? (slot.found.pdfUrl ? 'pdf' : 'landing') : 'none';
  // 兼容镜像：老代码 / 外部探针仍在读 ref.found
  ref.found = slot.found;
  ref.guessed = slot.guessed;
  return slot;
}

/** 把一次失败写进状态槽（只影响这一条，别的条目照常） */
function markSlotError(docId, ref, message) {
  if (!docId || ref?.lib) return null;
  const slot = relSlot(docId, ref);
  slot.status = 'error';
  slot.fail = String(message || '查询失败');
  return slot;
}


/**
 * 换论文：代际 +1。所有异步收尾都必须过 relStale 这一关。
 * 「↻ 重新解析」不走这里（它不换论文，在途查询要能落回新列表）。
 */
function relBumpGen() {
  state.relGen = (state.relGen || 0) + 1;
  state.refsSeq = (state.refsSeq || 0) + 1;   // 旧的解析也一并作废
  return state.relGen;
}

/** 这次异步是不是属于已经被换掉的那篇论文 */
function relStale(docId, gen) {
  return gen !== state.relGen || !docId || docId !== state.doc?.docId;
}

/** 视图状态（搜索词 / 分组折叠）：只活在内存里，切论文重置 */
function relView() {
  if (!state.relView) resetRelView();
  return state.relView;
}

function resetRelView() {
  state.relView = { q: '', fold: { lib: false, pdf: false, todo: false } };
}

/** 条目里的年份（搜索用）：取最后一个 4 位年份 */
function relYear(text) {
  const m = String(text || '').match(/(?:19|20)\d{2}/g);
  return m ? Number(m[m.length - 1]) : 0;
}

async function buildRelations({ force = false } = {}) {
  if (!state.doc || !viewer?.pdf) { renderRelations(); return; }
  const docId = state.doc.docId;
  if (!force && state.refsDoc === docId) { renderRelations(); return; }
  if (state.refsParsing === docId) return;      // 同一篇已经有一趟在解析，别重复起
  const myGen = state.relGen;
  // 「解析 vs 解析」的先后：连点两次 ↻ 时，只有最后发起的这次算数
  const mySeq = (state.refsSeq = (state.refsSeq || 0) + 1);
  const parseStale = () => relStale(docId, myGen) || mySeq !== state.refsSeq;
  relHint('正在解析本文的参考文献…');
  state.refsParsing = docId;
  try {
    const refs = await viewer.findAllReferences((p, total, n) => {
      if (parseStale()) return;
      relHint(`正在解析参考文献… p.${p}/${total}（已找到 ${n} 条）`);
    });
    if (parseStale()) return;                     // 代际 + docId + 本次解析序号，三重校验
    const idx = libIndex();
    for (const r of refs) {
      r.lib = findInLibrary(r.text, idx);
      // 建槽，并把已经查到过的结果镜像回新对象（↻ 之后列表上的徽标不会白白退回「未查」）
      const slot = relSlot(docId, r);
      if (slot.found) { r.found = slot.found; r.guessed = slot.guessed; }
    }
    state.refs = refs;
    state.refsDoc = docId;
    viewer.setReferencePages(refs);
  } catch {
    if (parseStale()) return;
    state.refs = [];
    state.refsDoc = docId;
    viewer.setReferencePages([]);
  } finally {
    if (state.refsParsing === docId) state.refsParsing = null;
  }
  relHint('');
  renderRelations();
}

/**
 * 「参考文献」是按需整理的唯一入口：只有用户真的打开这一块（点标题栏展开、点左栏的
 * 参考文献图标、点左栏图标坞）时才解析，打开论文本身不再在后台跑全文引用抽取。
 * 已经在解析 / 已经解析过这一篇时什么都不做。
 */
function ensureRelationsBuilt({ force = false } = {}) {
  if (!state.doc || !viewer?.pdf) return;
  if (!force && (state.refsDoc === state.doc.docId || state.refsParsing === state.doc.docId)) return;
  buildRelations({ force });
}

async function lookupRefPdf(ref, ctx = {}) {
  const myDoc = ctx.docId || state.doc?.docId || null;
  const myGen = ctx.gen ?? state.relGen;
  if (!myDoc || !ref) return null;
  const slot = relSlot(myDoc, ref);
  // 正在查 / 已经有结果（含书架已有）就不重复打请求；idle / none / error 都允许再查一次
  if (slot.status === 'loading' || slot.status === 'local'
    || slot.status === 'pdf' || slot.status === 'landing') return slot;
  slot.status = 'loading';
  slot.fail = '';
  renderRelations();
  renderCiteDetail();
  try {
    const r = await fetch(`/api/ref-search?q=${encodeURIComponent(ref.text)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (relStale(myDoc, myGen)) return slot;    // 换论文了：这条结果属于上一篇，直接丢掉
    applyResultsToSlot(myDoc, ref, data);
  } catch (e) {
    if (relStale(myDoc, myGen)) return slot;
    markSlotError(myDoc, ref, e.message);
  } finally {
    if (!relStale(myDoc, myGen)) { renderRelations(); renderCiteDetail(); }
  }
  return slot;
}

/** 把工具条控件对齐到内存里的视图状态（值相同就不写，免得把光标顶到末尾） */
function syncRelTools(view) {
  const q = $('#relSearch');
  if (q && q.value !== view.q) q.value = view.q;
}

/** 按搜索词过滤：编号 / 条目文本 / 年份 */
function relMatch(ref, q) {
  if (!q) return true;
  if (String(ref.num).includes(q) || `[${ref.num}]`.includes(q)) return true;
  if (String(ref.text || '').toLowerCase().includes(q)) return true;
  const y = relYear(ref.text);
  return y > 0 && String(y).includes(q);
}

function showRefDetail(ref) {
  if (!ref) return;
  showCiteBox(ref.num, ref, null, { canReturn: false });
}

/** 一行引用：结构与阶段 2 完全一致（.rt > .rn + 文本，.rrow > .rbtn + .rel-tag），只是多了一个「点行开详情」 */
function relItemRow(docId, row) {
  const { ref: r, status } = row;
  const meta = REL_STATUS[status] || REL_STATUS.idle;
  const slot = relSlotIfAny(docId, r);
  const rr = el('div', { class: 'rrow' });

  if (status === 'local') {
    rr.append(el('button', {
      class: 'rbtn primary', text: '打开',
      onclick: () => openDoc({ name: r.lib.name, url: r.lib.url, docId: r.lib.docId }),
    }));
  } else if (status === 'pdf' || status === 'landing') {
    const link = searchResultUrl(slot?.found);
    if (link) {
      rr.append(el('a', { class: 'rbtn primary', href: link, target: '_blank', rel: 'noreferrer', text: '打开链接' }));
      rr.append(el('button', { class: 'rbtn', text: '复制链接', onclick: () => copyText(link) }));
    }
  } else if (status === 'loading') {
    rr.append(el('button', { class: 'rbtn', text: '查询中…', disabled: true }));
  } else {
    // idle 未查 / none 没查到 / error 上次失败 —— 三种都能再查一次
    rr.append(el('button', {
      class: 'rbtn',
      text: status === 'error' ? '重试' : (status === 'none' ? '重查' : '查 PDF'),
      onclick: () => lookupRefPdf(r),
    }));
  }
  rr.append(el('span', { class: `rel-tag ${meta.cls}`.trim(), text: meta.tag }));
  rr.append(el('span', { class: 'rel-tag', text: `p.${r.page}` }));

  const li = el('li', {
    class: 'rel-item',
    dataset: { key: relKey(r), status },
    onclick: (e) => { if (!e.target.closest('button, a')) showRefDetail(r); },
  },
    el('div', { class: 'rt', title: `${r.text}\n（点这一行看详情）` },
      el('span', { class: 'rn', text: `[${r.num}]` }),
      document.createTextNode(r.text)),
    rr);
  return li;
}

/** 一个可折叠分组：标题带计数，组内是 .rel-item */
function relGroupEl(group, rows, view) {
  const folded = !!view.fold[group.id];
  const head = el('button', {
    class: 'rel-group-head', type: 'button', dataset: { group: group.id },
    'aria-expanded': folded ? 'false' : 'true',
  },
    el('span', { class: 'rg-caret' }, iconEl('caret-down', { size: 14 })),
    el('span', { class: 'rg-title', text: group.title }),
    el('span', { class: 'rg-count', text: `(${rows.length})` }));
  const ul = el('ul', { class: 'rel-group-list' });
  for (const row of rows) ul.append(relItemRow(state.doc.docId, row));
  const li = el('li', {
    class: `rel-group${folded ? ' collapsed' : ''}`,
    dataset: { group: group.id },
  }, head, ul);
  return li;
}

function renderRelations() {
  const sum = $('#relSummary');
  const list = $('#relList');
  const cnt = $('#relCount');
  if (!sum || !list) return;
  const view = relView();
  syncRelTools(view);

  if (!state.doc) {
    sum.textContent = '打开一篇论文后，打开这一块时整理';
    list.replaceChildren();
    if (cnt) cnt.textContent = '';
    return;
  }
  const docId = state.doc.docId;
  const refs = state.refsDoc === docId ? state.refs : null;
  if (!refs) {
    sum.textContent = state.relHint || '还没整理，点右上角 ↻';
    list.replaceChildren();
    if (cnt) cnt.textContent = '';
    return;
  }

  // 每条引用的显式状态 → 三个引用分组
  const rows = refs.map((ref) => ({ ref, status: relStatusOf(docId, ref) }));
  const byGroup = { lib: [], pdf: [], todo: [] };
  for (const row of rows) (byGroup[REL_STATUS[row.status]?.group || 'todo']).push(row);

  const bits = [
    `本文引用 <b>${refs.length}</b> 篇`,
    `书架已有 <b>${byGroup.lib.length}</b> 篇`,
    `查到开放版本 <b>${byGroup.pdf.length}</b> 条`,
    `待查 <b>${byGroup.todo.length}</b> 条`,
  ];
  // 进度里可能带文件名，一律走 textContent，不进 innerHTML
  if (state.relHint) sum.textContent = state.relHint;
  else sum.innerHTML = bits.join(' · ');
  if (cnt) cnt.textContent = refs.length ? `(${refs.length})` : '';

  const out = [];
  // 结论行：`.rel-cited` 这个类与文案都保持不变
  if (refs.length) {
    const h = el('li', { class: 'rel-cited' });
    h.innerHTML = byGroup.lib.length
      ? `本文引用了书架里的：${byGroup.lib.map((x) => `<b>${esc(x.ref.lib.name.replace(/\.pdf$/i, ''))}</b>`).join('、')}`
      : '本文没有引用书架里已有的论文';
    out.push(h);
  }

  for (const group of (refs.length ? REL_GROUPS : [])) {
    const rowsG = byGroup[group.id].filter((x) => relMatch(x.ref, view.q));
    // 有搜索词时空组不画（0 条没有信息量）；没有搜索词时三组都出现，
    // 哪怕是 0 —— 用户要看得到「一条都没有」这个结论
    if (!rowsG.length && view.q) continue;
    out.push(relGroupEl(group, rowsG, view));
  }

  list.replaceChildren(...out);

  if (!refs.length) {
    list.append(el('li', { class: 'empty', text: '没在文末找到编号式参考文献（[1] [2] …）。扫描版 PDF 抽不出文字，这类文献抽不出来。' }));
  }
}

function initRelations() {
  // ↻ = 用户明确要重解析（唯一会 force 的入口）
  $('#relRescan').onclick = () => {
    state.refsDoc = null;
    state.refsParsing = null;
    ensureRelationsBuilt({ force: true });
  };
  // 搜索：只改内存里的视图状态再重绘，不写 localStorage
  const q = $('#relSearch');
  if (q) q.addEventListener('input', () => { relView().q = q.value.trim().toLowerCase(); renderRelations(); });
  // 分组折叠用事件委托 —— 列表每次重绘都会 replaceChildren，逐组绑监听会全丢
  $('#relList').addEventListener('click', (e) => {
    const head = e.target.closest('.rel-group-head');
    if (!head) return;
    const g = head.dataset.group;
    const v = relView();
    v.fold[g] = !v.fold[g];
    renderRelations();
  });
  renderRelations();
}


function openExternal(target) {
  const u = String(target || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  // 本地应用自身的 URL 必须留在 WebView 内，不能被当成外链交给 /api/open-url ——
  // 否则点应用内的链接会莫名其妙跳到系统浏览器里。
  try {
    if (new URL(u, location.href).origin === location.origin) return false;
  } catch { return false; }
  fetch(`/api/open-url?url=${encodeURIComponent(u)}`)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); })
    .catch(() => {
      // 后端打不开时至少把地址给用户，不至于点了一点反馈都没有
      copyText(u);
      toast('打不开系统浏览器，链接已复制到剪贴板', 'err', 5000);
    });
  return true;
}

/**
 * 测试用：量一量画出来的「选中方块」是不是真的压在选中的文字上。
 * 做法是拿选区里的几个词去正文里找对应的 span，再看每个 span 的中心有没有被方块盖住。
 * 缩放之后浏览器自己的选区已经没了，所以只能这样独立地验。
 */
function selectionAlignProbe() {
  const marks = [...document.querySelectorAll('.sel-mark')].map((m) => m.getBoundingClientRect());
  const sel = state.selection;
  if (!sel || !marks.length) return { marks: marks.length, total: 0, hit: 0, ratio: 0 };
  const pageEl = document.querySelector(`.page[data-page="${sel.page}"]`);
  const spans = pageEl ? [...pageEl.querySelectorAll('.textLayer span:not(.markedContent)')] : [];
  const words = String(sel.cleanText || '').split(/\s+/).filter((w) => w.length >= 4).slice(0, 8);
  let hit = 0;
  for (const w of words) {
    const span = spans.find((s) => (s.textContent || '').includes(w));
    if (!span) continue;
    const r = span.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (marks.some((m) => cx >= m.left - 4 && cx <= m.right + 4 && cy >= m.top - 4 && cy <= m.bottom + 4)) hit++;
  }
  return { marks: marks.length, total: words.length, hit, ratio: words.length ? hit / words.length : 0 };
}

function initExternalLinks() {
  // 捕获阶段拦，抢在别的处理函数之前
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;    // 站内相对链接照常走
    e.preventDefault();
    openExternal(href);
  }, true);

  // window.open 也走同一条路（看大图之类用的是它）
  const nativeOpen = window.open.bind(window);
  window.open = (target, ...rest) => {
    if (typeof target === 'string' && openExternal(target)) return null;
    return nativeOpen(target, ...rest);
  };
}

/** 只在用户已经贴着「最新」时才自动跟随，往回翻旧结果时不抢滚动条。
 *  方向感知：译文块是 column-reverse（最新在 scrollTop = 0），问答流是普通列（最新在底部）。 */
function scrollBody(node) {
  if (!node) return;
  const reversed = node.dataset?.reversed === '1'
    || getComputedStyle(node).flexDirection === 'column-reverse';
  const near = reversed
    ? node.scrollTop < 100
    : node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  if (near) requestAnimationFrame(() => { scrollToNewest(node); });
}

function scrollEntryToTop(body, entry) {
  if (!body || !entry) return;
  requestAnimationFrame(() => {
    if (!body.isConnected) return;
    const reversed = body.dataset?.reversed === '1'
      || getComputedStyle(body).flexDirection === 'column-reverse';
    if (reversed) {
      // 反转排布：最新那条本来就在最上面，滚到顶就够（不用算 offsetTop）
      body.scrollTop = 0;
    } else if (entry.isConnected) {
      body.scrollTop = Math.max(0, entry.offsetTop);
    }
  });
}

function scrollToNewest(el) {
  const body = el?.closest?.('.ai-body') || el;
  if (!body) return;
  const reversed = body.dataset?.reversed === '1'
    || (typeof getComputedStyle === 'function' && getComputedStyle(body).flexDirection === 'column-reverse');
  body.scrollTop = reversed ? 0 : body.scrollHeight;
}

/** 把「最新那一端在哪个方向」写到容器上（免得每处都去算计算样式）。
 *  译文块 = 新在上（app.js 的 addEntry 用 prepend + style.css 的 margin-bottom:auto），
 *  所以它的「最新」是 scrollTop = 0，与问答流（普通列、最新在底部）相反。 */
function markReversedBodies() {
  for (const id of Object.keys(state.blockEls || {})) {
    const block = state.blockEls[id];
    const body = block?.querySelector?.('.ai-body');
    if (!body) continue;
    const newestOnTop = id === 'translate' || getComputedStyle(body).flexDirection === 'column-reverse';
    body.dataset.reversed = newestOnTop ? '1' : '0';
  }
}

/**
 * 回答正文渲染：先剥掉 prt 隐藏块，再把 〔p.N〕 / 〔p.N–M〕 / 〔p.N‖原文片段〕 变成可点击页码。
 * 带 ‖ 片段的引用点击后会跳到该页并高亮片段（橙色），再点同一个引用可取消。
 * 渲染失败/页码越界时保持普通文字，不影响回答本身。
 */
/**
 * 引用片段的两种形态：
 *  - text：纯文本（用于 data-fragment / title / 纸面高亮匹配）；
 *  - html：原来的行内 HTML（markdown 粗体、KaTeX 公式在片段里也能正常显示）。
 * 只对行内内容保留 HTML；片段被 markdown 段落/列表切断时退回纯文本，避免嵌套块级元素。
 */
function quoteFragmentParts(html) {
  const raw = String(html || '');
  const holder = document.createElement('div');
  holder.innerHTML = raw;
  // 公式片段里 KaTeX 会同时输出 MathML（给读屏）和可见 HTML；纯文本口径只取可见那份，
  // 否则 textContent 会把同一公式拼成「E=mc2E=mc^2E=mc2」。
  const visible = holder.cloneNode(true);
  visible.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
  const text = (visible.textContent || '').replace(/\s+/g, ' ').trim();
  const blocky = /<(?:p|div|ul|ol|li|pre|blockquote|h[1-6]|table|thead|tbody|tr|td|th|section)\b/i.test(raw);
  // 行内片段正常保留 HTML（公式/粗体仍能显示）；块级结构或有异常长文本时退回纯文本
  if (blocky || text.length > 600) return { text: text.slice(0, 600), html: escapeHtml(text.slice(0, 600)) };
  return { text, html: raw.trim() };
}

/* ------------------------------------------------------------ P2.5 Agent 读取内容 */

/** 默认开启（2026-11-01 P2.5 真实 API 验收通过后开启；仍可用 reader.agentRead=0 关掉，失败自动回退） */
const AGENT_READ_DEFAULT = true;
function agentReadEnabled() {
  return readFlag('reader.agentRead', AGENT_READ_DEFAULT);
}

/* ------------------------------------------------------------ 追问直答（2026-11-04 用户要求） */
/* 用户反馈：明显上下连贯的追问没必要每次都重新翻页、看页图、跑多轮工具思考，应该直接接着说。
   做法：同一段会话里已经有问答、问题很短、没加选区/截图、也没点名要看新的页/整篇时，
   跳过 Agent 工具轮次、全文与页图材料，直接把对话历史和当前页上下文交给模型流式回答。
   设置 →「交互与发送」里的「连贯追问直接回答」可关掉（reader.followUpDirect=0）。 */
const FOLLOW_UP_DIRECT_DEFAULT = true;
function followUpDirectEnabled() {
  return readFlag('reader.followUpDirect', FOLLOW_UP_DIRECT_DEFAULT);
}
/** 问题点明了要看新的材料 / 要核对 / 要搜索：别走直答，照旧完整阅读流程。
    2026-11-04 二次修复：用户实测「前几个 PDF 有没有提到 X」「去查啊」「？」都被当成闲聊追问，
    工具被关掉后模型反过来让用户自己贴页。凡是带核对/翻页/搜索/页码/文档词的问题一律走完整流程。 */
const FOLLOW_UP_READ_RE = /(第\s*\d+\s*页|p\.?\s*\d+|页码|整篇|全文|全文索引|翻到|翻页|翻一下|翻翻|重新读|从头读|再读|读一遍|找一下|找找|查|搜|核实|验证|确认|看看|看一下|前面几|前几|哪一页|哪页|其他页|别的页|另一页|原文|pdf|论文里|文档里|讲义|课件|到底|真的|是不是|没找到|找不到|重新生成)/i;
/** 明显在质疑上一轮 / 要求重查的短回应：即使很短也切完整流程（用户实测「去查啊」） */
const FOLLOW_UP_CHALLENGE_RE = /(去查|查啊|查查|核实|确认|验证|翻一下|翻翻|看看自己|自己看|到底|真的|确定吗|不对|错了|没找到|找不到|重新查|再查)/;
/** 纯标点/语气词的追问（例如「？」）：只有在上一轮是轻量直答时才切完整流程 */
const FOLLOW_UP_PURE_PUNCT_RE = /^[？?！!。，,、…\s]+$/;
/** 上一轮回答是否走了轻量直答（「？」「去查啊」这类回应据此升级为完整阅读流程） */
let lastChatAnswerDirect = false;
/** 扫描件里提到图/表/公式/位置：保留页图，别把影像材料也省掉 */
const FOLLOW_UP_VISUAL_RE = /(图|表|公式|截图|这块|这里|这页|上面|下面|左边|右边|圈|标出|显示|画出|坐标|曲线)/;
/**
 * 「明显承接上文」的追问判定：返回 { direct, keepVisual }。
 * direct=true 时调用方跳过 Agent 工具轮次、整篇全文与页图材料，只带对话历史 + 当前页上下文直答。
 * 但以下情况一律不走直答：点名查页/核对/搜索/文档、带选区截图、上一轮直答后用户只回「？」或质疑、
 * 「重新生成」（forceFull）——这些都需要真实读材料，否则模型会反过来让用户自己去翻页。
 */
function planFollowUpDirect(pending, { images = [], scannedDoc = false } = {}) {
  if (!followUpDirectEnabled()) return { direct: false, keepVisual: false };
  if (!pending || !pending.docId) return { direct: false, keepVisual: false };
  if (pending.forceFull) return { direct: false, keepVisual: false };
  const q = String(pending.inputValue || '').trim();
  if (!q || q.length > 60) return { direct: false, keepVisual: false };
  if (images?.length) return { direct: false, keepVisual: false };
  const atts = Array.isArray(pending.attachments) ? pending.attachments : [];
  if (atts.some((a) => a && (a.kind === 'text' || a.kind === 'image'))) return { direct: false, keepVisual: false };
  if (pending.quoteText) return { direct: false, keepVisual: false };
  if (!Array.isArray(pending.history) || pending.history.length === 0) return { direct: false, keepVisual: false };
  if (FOLLOW_UP_READ_RE.test(q)) return { direct: false, keepVisual: false };
  if (FOLLOW_UP_CHALLENGE_RE.test(q)) return { direct: false, keepVisual: false };
  // 上一轮是轻量直答、用户只回「？」：说明答案没对上，别再顺口糊，直接去查
  if (lastChatAnswerDirect && FOLLOW_UP_PURE_PUNCT_RE.test(q)) return { direct: false, keepVisual: false };
  const keepVisual = !!scannedDoc && FOLLOW_UP_VISUAL_RE.test(q);
  return { direct: true, keepVisual };
}

/** 单次「工具决策」调用（非流式 JSON；不支持 tools 的模型会报错 → 调用方回退） */
async function agentModelCall({ messages, tools, timeoutMs = 12000, signal = null }) {
  const ctl = new AbortController();
  const forward = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        tools,
        tool_choice: 'auto',
        stream: false,
        temperature: Settings.data.temperature,
        baseURL: Settings.data.baseURL,
        apiKey: Settings.data.apiKey || undefined,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    if (!ctype.includes('json')) throw new Error('工具决策返回的不是 JSON（模型可能不支持 tools）');
    const json = JSON.parse(text);
    if (json?.error) throw new Error(json.error.message || '上游返回错误');
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', forward);
  }
}

/** 整篇文本按页切（Agent 的 search_paper / read_page 用；按需抽取一次并缓存） */
async function ensureAgentDocText() {
  const myDoc = state.doc?.docId || null;
  if (!myDoc || !viewer?.pdf) return '';
  if (state.docText && state.docTextDoc === myDoc) return state.docText;
  if (state.docTextPromise) return state.docTextPromise;
  state.docTextPromise = (async () => {
    try {
      const text = await viewer.getAllText();
      if (state.doc?.docId === myDoc) { state.docText = text; state.docTextDoc = myDoc; }
      return text;
    } catch {
      return '';
    } finally {
      state.docTextPromise = null;
    }
  })();
  return state.docTextPromise;
}

/** 在整篇文本里按词频找相关页（Agent 的 search_paper） */
function agentSearchPages(text, query, k = 4) {
  const terms = searchTerms(query).map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  const pages = [];
  const re = /=====\s*p\.(\d+)\s*=====/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ page: Number(m[1]), at: m.index, bodyAt: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].bodyAt, i + 1 < marks.length ? marks[i + 1].at : text.length);
    const lower = body.toLowerCase();
    let score = 0;
    let firstAt = -1;
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(term, from);
        if (at < 0) break;
        score += 1;
        if (firstAt < 0 || at < firstAt) firstAt = at;
        from = at + term.length;
      }
    }
    if (score > 0) pages.push({ page: marks[i].page, score, firstAt, body });
  }
  pages.sort((a, b) => b.score - a.score || a.page - b.page);
  return pages.slice(0, k).map((row) => {
    const start = Math.max(0, row.firstAt - 120);
    return { page: row.page, snippet: row.body.slice(start, start + 480).replace(/\s+/g, ' ').trim() };
  });
}

/** Agent 工具运行时（全部只读；不写任何状态，除了「读过哪些页」的记录） */
function createAgentRuntime(pending, { scannedDoc = false } = {}) {
  const numPages = Number(viewer?.numPages) || 0;
  const reading = pending.reading || null;
  /* 跨论文读取：papers 文件夹里所有已导入论文（懒加载一次；图片材料收集起来随最终回答一起发） */
  const other = { papers: null, images: [] };
  const loadPapers = async () => {
    if (other.papers) return other.papers;
    const r = await fetch('/api/papers');
    if (!r.ok) throw new Error(`读取 papers 文件夹失败 HTTP ${r.status}`);
    const j = await r.json();
    other.papers = (Array.isArray(j.papers) ? j.papers : []).map((p, i) => ({
      index: i + 1, name: p.name, folder: p.folder || '', path: p.path || p.name,
      docId: p.docId || '', url: p.url || `/api/pdf?path=${encodeURIComponent(p.path || p.name)}`,
    }));
    return other.papers;
  };
  const findPaper = (nameArg) => {
    const raw = String(nameArg || '').replace(/\s+/g, ' ').trim();
    const q = raw.toLowerCase();
    const list = other.papers || [];
    const exact = list.find((p) => p.name.toLowerCase() === q || p.path.toLowerCase() === q);
    if (exact) return exact;
    const hit = list.find((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    return hit || null;
  };
  /** 把「当前论文的某一页」渲染成页图收进材料；同一页只收一次（重复调用直接告诉模型已经在材料里） */
  const attachCurrentPageImage = async (page) => {
    const n = Number(page) || 1;
    if (n < 1 || (numPages && n > numPages)) return { page: n, error: `页码超出范围（1–${numPages || '?'}）` };
    const already = other.images.some((im) => im.page === n && !String(im.label || '').includes('《'));
    if (already) return { page: n, imageAttached: true, duplicate: true, chars: 0, text: '', note: '这一页原图已经在材料里了' };
    if (other.images.length >= 4) return { page: n, error: '本次已加入 4 张页图，先用它们回答' };
    try {
      const shot = await viewer.capturePageImage(n, { maxDim: 1400 });
      other.images.push({ ...shot, page: n, label: `第 ${n} 页` });
      return { page: n, imageAttached: true, chars: 0, text: '', note: '已把这一页的原图加入回答材料（直接读图，不做转写）' };
    } catch (e) {
      return { page: n, error: `取第 ${n} 页页图失败：${e?.message || e}` };
    }
  };
  const paperBrief = (p) => ({ name: p.name, folder: p.folder, path: p.path, index: p.index });
  return {
    numPages,
    /** 跨论文：已加入页图材料（send() 会把它们附到最终回答） */
    extraImages: other.images,
    async listPapers() {
      const list = await loadPapers();
      return {
        count: list.length,
        papers: list.slice(0, 80).map((p) => ({ index: p.index, name: p.name, folder: p.folder, path: p.path, docId: p.docId })),
        current: state.doc?.name || '',
        note: '顺序与左侧文件树一致；用户说「第 N 篇」按 index 数。',
      };
    },
    async readOtherPaper(args = {}) {
      await loadPapers();
      const paper = findPaper(args.name);
      if (!paper) return { error: `没有找到论文「${String(args.name || '').slice(0, 60)}」，请先用 list_papers 看有哪些文件`, papers: (other.papers || []).slice(0, 20).map(paperBrief) };
      if (args.query) {
        const got = await readPdfPages(paper.url, { maxPages: 30 });
        const terms = searchTerms(args.query).map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
        const hits = [];
        for (const row of got.pages) {
          const lower = row.text.toLowerCase();
          if (!lower) continue;
          const at = terms.length ? Math.min(...terms.map((t) => { const i = lower.indexOf(t); return i < 0 ? Number.POSITIVE_INFINITY : i; })) : lower.indexOf(String(args.query).toLowerCase());
          if (!Number.isFinite(at) || at < 0) continue;
          const start = Math.max(0, at - 100);
          hits.push({ page: row.page, snippet: row.text.slice(start, start + 420).replace(/\s+/g, ' ').trim() });
          if (hits.length >= 6) break;
        }
        return { name: paper.name, folder: paper.folder, numPages: got.numPages, query: args.query, hits, note: hits.length ? '' : '没有命中，可以换个词或直接给 page 读那一页' };
      }
      const page = Number(args.page) || 1;
      const got = await readPdfPages(paper.url, { pages: [page] });
      const row = got.pages[0] || { page, text: '' };
      const text = String(row.text || '').slice(0, 8000);
      return {
        name: paper.name, folder: paper.folder, index: paper.index, page, numPages: got.numPages,
        chars: text.length, text,
        scanned: text.length < 40,
        note: text.length < 40 ? '这一页几乎没有文本层（可能是扫描件），可用 read_other_paper_image 取页图' : '',
      };
    },
    async readOtherPaperImage(args = {}) {
      await loadPapers();
      const paper = findPaper(args.name);
      if (!paper) return { error: `没有找到论文「${String(args.name || '').slice(0, 60)}」，请先用 list_papers` };
      const page = Number(args.page) || 1;
      if (other.images.length >= 4) return { error: '本次已加入 4 张页图，先用它们回答' };
      const shot = await renderPdfPageImage(paper.url, page);
      other.images.push({ ...shot, label: `《${paper.name}》第 ${page} 页` });
      return { name: paper.name, page, attached: true, count: other.images.length, note: '已加入页图材料，最终回答会附上这张图' };
    },
    async getReadingState() {
      return {
        docTitle: state.doc?.name || '',
        numPages,
        currentPage: viewer?.currentVisiblePage?.() || viewer?.current || null,
        scanned: !!scannedDoc,
        hasTextLayer: !scannedDoc,
        selection: reading?.selection ? { page: reading?.focus?.page || null, text: String(reading.selection).slice(0, 600) } : null,
        currentTopic: reading?.inherited ? { page: reading?.focus?.page || null, text: String(reading?.focus?.text || '').slice(0, 600) } : null,
      };
    },
    async readPage(page) {
      /* 扫描件没有文本层：不先报错再让模型重试 —— 直接自动改取页图（少一轮往返、过程列表也少一条失败）。 */
      if (scannedDoc) return attachCurrentPageImage(page);
      const text = await viewer.getPageText(page);
      return { page, chars: String(text || '').length, text: String(text || '').slice(0, 6000) };
    },
    async searchPaper(query) {
      const text = await ensureAgentDocText();
      if (!text) return { query, pages: [], note: '没有可用全文（可能是扫描件）' };
      const rows = agentSearchPages(text, query, 4);
      return { query, pages: rows, note: rows.length ? '' : '没有命中，可以换个词或直接 read_page' };
    },
    async readScanPage(page) {
      if (!scannedDoc) return { page, error: '这不是扫描件，请用 read_page' };
      return attachCurrentPageImage(page);
    },
    async readPageImage(page) {
      if (!Number.isInteger(page)) return { error: 'page 必须是整数' };
      return { page, note: '已加入页图材料，最终回答会附上这张页图' };
    },
    async readMemory(topic) {
      const items = selectProfileItems(profileStore.data, String(topic), '', 6, { docId: pending.docId || '' });
      return {
        items: items.map(({ item }) => ({
          topic: item.topic, kind: item.memory?.kind || 'knowledge',
          level: item.level.slice(0, 110), boundary: item.boundary.slice(0, 160),
        })),
      };
    },
  };
}

/** Agent 过程列表：在回答正文上方逐条显示「正在思考 / 正在检索 / 读取第 N 页 / 命中结果」。
 *  用户口径：像 agent 工具调用那样把模型干活的过程直接列出来；不想要闪烁的光标。 */
function createAgentProgress(entry) {
  if (!entry?.root || !entry?.body) return null;
  entry.root.querySelectorAll('.agent-steps').forEach((node) => node.remove());
  const box = el('div', { class: 'agent-steps', 'aria-live': 'polite' });
  entry.root.insertBefore(box, entry.body);
  const bodyEl = entry.body.closest('.ai-body');
  // 用户口径（2026-11-03）：过程不要逐条列细，也不要「已加入图片」这类汇报；
  // 只保留一条笼统的状态行，回答一出来就整行撤掉。
  let current = null;
  const show = (text) => {
    if (!box.isConnected) return;
    if (!current) {
      current = el('div', { class: 'as-item running' },
        el('span', { class: 'as-ico', 'aria-hidden': 'true' }),
        el('span', { class: 'as-text', text }));
      box.append(current);
      scrollEntryToTop(bodyEl, entry.root);
    } else {
      const label = current.querySelector('.as-text');
      if (label) label.textContent = text;
    }
  };
  return {
    onStep(ev) {
      if (!ev) return;
      if (ev.type === 'round' || ev.type === 'tool_start') show('正在查阅论文材料…');
      else if (ev.type === 'ready') { current?.remove(); current = null; }
      // tool_done / tools：不更新、不逐条列动作；失败也不在过程里刷细节
    },
    finish() {
      current = null;
      box.remove();
    },
    remove() { box.remove(); },
  };
}

/**
 * 跑一次「AI 自己决定读哪些页」：成功返回 { messages, pages, imagePages, basis, stats }；
 * 不支持 tools / 超时 / 任何异常 → 返回 null（调用方静默回退 P1.5 预装路径）。
 */
async function runAgentReadPath({ pending, reading, context, references, sources, images, scannedDoc, baseMaterials, signal, onStep }) {
  // 允许测试注入更短的超时，避免用例等 25 秒
  const limits = window.__agentTestLimits && typeof window.__agentTestLimits === 'object' ? window.__agentTestLimits : {};
  // 跨论文读取要临时打开别的 PDF，比只看当前文档慢，总预算放宽
  // 用户口径（2026-11-02）：工具轮次要够——模型发现读错页／页不够时应该能继续调用，而不是停在最后一轮。
  const totalTimeoutMs = Math.max(1000, Number(limits.totalTimeoutMs) || 75000);
  const callTimeoutMs = Math.max(500, Number(limits.callTimeoutMs) || 20000);
  try {
    const base = askMessages({ ...baseMaterials, availablePages: baseMaterials.availablePages || [], scopeLabel: 'AI 自行读取', objectLabel: objectLabelFor(pending, reading) });
    const system = String(base[0]?.content || '');
    const folderLine = `【当前文件夹】${currentFolderPath() || 'papers/'}。默认只读**当前论文 / 当前文件夹**的材料；` +
      '只有用户明确点名了其它论文（文件名 / 「第 N 篇」/ 别的文件夹 / 「其它论文」）时才用 list_papers / read_other_paper 跨文件夹读取，否则不要主动跨文件夹。';
    base[0] = { role: 'system', content: `${system}\n\n${AGENT_SYSTEM_NOTE}\n${folderLine}` };
    const runtime = createAgentRuntime(pending, { scannedDoc });
    const run = await runAgentLoop({
      messages: base,
      runtime,
      callModel: agentModelCall,
      signal,
      onStep,
      totalTimeoutMs,
      callTimeoutMs,
    });
    const stats = agentStats(run);
    window.__lastAgent = { ok: run.ok, stats, at: Date.now() };
    if (!run.ok || stats.calls === 0) return null;
    const messages = run.messages.slice();
    /* 用户口径（2026-11-02）：模型抱怨「本轮材料已经定下、不能再调用」是轮次用完导致的。
       这里把两种结束原因分清楚：正常读完 vs 轮次用完；后者不说「材料已经读够」，并明确禁止再写工具标记。 */
    const forcedHint = run.reason === 'max-rounds'
      ? '（本次工具轮次已经用完。请只基于上面已经读到的材料和初始材料直接给出最终回答；如果确实缺少关键页，直接说明缺哪几页、为什么需要。不要再调用工具，也不要输出工具调用标记或 XML。）'
      : '（材料已经读够，请直接给出最终回答；不要再调用工具，也不要输出工具调用标记或 XML。）';
    messages.push({ role: 'user', content: forcedHint });
    const basisPages = [...new Set(run.pages)].sort((a, b) => a - b);
    return {
      messages,
      // 模型在最后一轮已经写出了完整正文（≥120 字）时，不再多发一次「最终流式」请求：
      // 这是 P2.5 延迟的主要来源之一（每多一轮 = 多一次完整 LLM 往返）。
      directContent: String(stripAgentMarkup(run.directContent || '')).trim().length >= 120
        ? String(stripAgentMarkup(run.directContent || '')).trim() : '',
      pages: basisPages,
      imagePages: run.imagePages || [],
      /* 跨论文读取时加入的其它论文页图（已渲染好 dataURL，交给 send() 附到最终请求） */
      extraImages: runtime.extraImages || [],
      basis: `本次依据：AI 自行读取 ${basisPages.length ? `p.${basisPages.join('、')}` : '（未读页）'}（${run.rounds} 轮 / ${stats.calls} 次工具）`,
      stats,
    };
  } catch {
    return null;
  } finally {
    setHint('');
  }
}

/* ------------------------------------------------------------ P1.5 引用核验 / 依据回执 */

/** 当前这条回答的引用校验结果（收尾时算一次；渲染器按 raw 查表）。null = 还没算，按旧行为渲染 */
let activeCitationPlan = null;
let lastCitationStats = null;

/** 扫描件的「图片阅读索引」按页取转写文本（格式：===== p.N =====\n…） */
function pageTextFromScanDigest(digest, page) {
  const text = String(digest || '');
  if (!text || !page) return '';
  const re = /=====\s*p\.(\d+)\s*=====/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ page: Number(m[1]), at: m.index, bodyAt: m.index + m[0].length });
  const i = marks.findIndex((mk) => mk.page === Number(page));
  if (i < 0) return '';
  return text.slice(marks[i].bodyAt, i + 1 < marks.length ? marks[i + 1].at : text.length);
}

/** 本次材料的「对象 / 范围」一句话（给近因指令用） */
function objectLabelFor(pending, reading) {
  const text = String(reading?.selection || reading?.focus?.text || pending?.question || '')
    .replace(/\s+/g, ' ').trim();
  if (!text) return '读者当前的问题';
  if (reading?.inherited) return `上一轮话题：${text.slice(0, 24)}`;
  if (reading?.selection) return `选中文本：${text.slice(0, 24)}`;
  return text.slice(0, 40);
}

/** 本次发送范围（整篇 / 当前页 / 联网 / 截图） */
function scopeLabelFor(pending, { scanned = false, images = [] } = {}) {
  const bits = [];
  bits.push(pending?.useFullText ? (scanned ? '整篇页图' : '整篇') : (scanned ? '当前页页图' : '当前页'));
  if (pending?.useWeb) bits.push('联网');
  if (images?.length) bits.push(`${images.length} 张截图`);
  return bits.join(' + ');
}

/**
 * 程序事实：本次材料真实提供了哪些页（白名单），以及「本次依据」只读回执。
 * 白名单来源：整篇全文的分页标记 / 页图页码 / 所在页上下文里的页标记 / 选区页 / 参考文献页。
 */
function citationMaterialsFor({ docCtx = null, context = '', references = [], scanned = false, pending = null,
  sources = [], images = [], pageRole = '' } = {}) {
  const fullText = docCtx?.mode === 'digest' ? '' : (docCtx?.text || '');
  const pageImages = docCtx?.pageImages || [];
  const scanPages = scanned ? [...pagesFromText(state.scanDigest)] : [];
  const availablePages = collectAvailablePages({
    fullText, pageImages, contexts: context ? [context] : [],
    selectionPage: pending?.reading?.selection ? (pending?.reading?.focus?.page || null) : null,
    focusPage: pending?.reading?.focus?.page || null,
    currentPage: pending?.firstPage || null,
    references, scanPages,
  });
  // 兜底：一个页码都算不出来时（例如索引模式没有分页标记），至少把当前页当白名单，
  // 避免把全部引用都判成非法；真正编出来的页仍然会被拦。
  if (!availablePages.length && pending?.firstPage) availablePages.push(Number(pending.firstPage));
  const basis = [];
  const focusPage = pending?.reading?.focus?.page || null;
  if (pending?.reading?.selection) basis.push(focusPage ? `p.${focusPage} 选区` : '选区');
  if (context) {
    const p = pending?.firstPage || viewer?.current || viewer?.currentVisiblePage?.() || null;
    const who = pageRole === 'topic' ? '话题页' : pageRole === 'explicit' ? '指定页' : '当前页';
    basis.push(p ? `${who} p.${p}` : who);
  }
  if (docCtx?.mode === 'full') basis.push('整篇原文');
  else if (docCtx?.mode === 'digest') basis.push('整篇索引');
  if (pageImages.length) basis.push(`p.${pageImages.map((im) => im.page).join('、')} 页图`);
  if (sources?.length) basis.push(`联网 ${sources.length} 条`);
  if (images?.length) basis.push(`${images.length} 张截图`);
  return { availablePages, basis: `本次依据：${basis.length ? basis.join(' / ') : '仅问题本身'}` };
}

/** 引用核验：流式结束后算一次，渲染器按 raw 查表降级/拦截 */
async function auditAnswerCitations(answer, { availablePages = null, scanned = false } = {}) {
  try {
    const totalPages = Number(viewer?.numPages) || 0;
    const pageTextFor = scanned
      ? (p) => pageTextFromScanDigest(state.scanDigest, p)
      : (p) => (viewer?.getPageText ? viewer.getPageText(p) : '');
    const result = await validateCitations(answer, {
      totalPages,
      availablePages: availablePages?.length ? availablePages : null,
      pageTextFor,
      scanned,
    });
    activeCitationPlan = result.plan;
    lastCitationStats = result.stats;
    return result;
  } catch {
    activeCitationPlan = null;
    lastCitationStats = null;
    return null;
  }
}

/** 教学/操作/解释路径共用：把校验结果写进当前渲染状态，返回统计 */
async function auditForRenderedAnswer(answer, { docCtx = null, context = '', references = [], scanned = false, page = null } = {}) {
  const mat = citationMaterialsFor({
    docCtx, context, references, scanned, pageRole: 'screen',
    pending: { firstPage: page || viewer?.current || null, reading: null },
  });
  await auditAnswerCitations(answer, { availablePages: mat.availablePages, scanned });
  return mat;
}

function decoratePageRefs(html) {
  const pages = Number(viewer?.numPages) || 0;
  const plan = activeCitationPlan;
  // 兼容模型的各种写法：p. 前后带空格、半角/全角竖线、长破折号；片段长度按「可见文字」算，
  // HTML 上限放宽（行内公式的 KaTeX 标记可能上千字符），避免「带公式的引用不渲染」
  return String(html || '').replace(
    /〔\s*p\.\s*(\d{1,4})\s*(?:[–\-—]\s*(\d{1,4}))?\s*(?:\|\||‖|｜)\s*([^〕]{1,8000})〕|〔\s*p\.\s*(\d{1,4})\s*(?:[–\-—]\s*(\d{1,4}))?\s*〕/g,
    (raw, aPipe, bPipe, frag, aPlain, bPlain) => {
      // P1.5：程序核验过的不合法引用不渲染按钮（drop），片段核不上的降级成纯页码（page-only）。
      const decision = plan ? planFor(plan, raw) : null;
      if (decision && decision.level === 'drop') return raw;
      const a = aPipe || aPlain;
      const b = aPipe ? bPipe : bPlain;
      const p = Number(a);
      if (!Number.isInteger(p) || p < 1 || (pages && p > pages)) return raw;
      const label = b ? `p.${a}–${b}` : `p.${a}`;
      if (decision && decision.level === 'page-only') {
        const title = `跳到第 ${p} 页（原文片段未核对，不画高亮）`;
        return `<button type="button" class="page-ref page-ref-unverified" data-page="${p}" data-unverified="1" title="${escapeHtml(title)}">${label}</button>`;
      }
      const parts = aPipe ? quoteFragmentParts(frag) : null;
      const fragment = parts?.text || '';
      if (!fragment) {
        const title = b ? `跳到第 ${a}–${b} 页` : `跳到第 ${a} 页`;
        return `<button type="button" class="page-ref" data-page="${p}" title="${escapeHtml(title)}">${label}</button>`;
      }
      const title = `跳到第 ${p} 页并定位原文：${fragment.slice(0, 80)}`;
      // 片段必须跟着显示出来：之前只塞进 title，渲染后正文只剩 p.5，引用的原句被「吞掉」了
      //（用户实测：老师手写答案变成连续四个 p.5）。文字保持可选中复制；
      // 只有前面的页码按钮负责跳页 + 高亮。
      return `<button type="button" class="page-ref quote-ref" data-page="${p}" data-fragment="${escapeHtml(fragment.slice(0, 600))}" title="${escapeHtml(title)}">${label}</button>`
        + ` <span class="quote-inline">${parts.html}</span>`;
    });
}

/** 其它论文的引用：〔《文件名》p.N‖原文片段〕 → 可点击标签。
 *  点击会自动打开那篇论文（没打开过就先打开）、跳到第 N 页，有原文片段就画高亮。
 *  注意：必须在 decoratePageRefs 之后跑 —— 当前论文的 〔p.N〕 已经先被处理掉，两边不会互相抢。 */
const OTHER_PAPER_REF_RE = /〔\s*《([^》]{1,160})》\s*p\.\s*(\d{1,4})(?:\s*(?:\|\||‖|｜)\s*([^〕]{1,8000}))?\s*〕/g;
function decorateOtherPaperRefs(html) {
  return String(html || '').replace(OTHER_PAPER_REF_RE, (raw, name, page, frag) => {
    const p = Number(page);
    const paper = String(name || '').trim();
    if (!paper || !Number.isInteger(p) || p < 1) return raw;
    const parts = frag ? quoteFragmentParts(frag) : null;
    const fragment = parts?.text || '';
    const short = escapeHtml(paper.replace(/\.pdf$/i, '').slice(0, 28));
    const title = `打开《${paper}》并跳到第 ${p} 页${fragment ? `，定位原文：${fragment.slice(0, 80)}` : ''}`;
    return `<button type="button" class="page-ref other-paper-ref" data-paper="${escapeHtml(paper)}" data-page="${p}"`
      + `${fragment ? ` data-fragment="${escapeHtml(fragment.slice(0, 600))}"` : ''}`
      + ` title="${escapeHtml(title)}">《${short}》p.${p}</button>`
      + (fragment ? ` <span class="quote-inline">${parts.html}</span>` : '');
  });
}

function renderAnswerHTML(text) {
  const split = splitPrtBlock(String(text || ''));
  return decorateOtherPaperRefs(decoratePageRefs(renderMarkdown(split.text || '')));
}

/** 引用高亮的当前状态（点正文 / Esc / 再点同一引用 / 翻页 / 切文档时清空） */
let quoteState = { page: null, fragment: '', btn: null };

/** 取消引用高亮（橙色块 + 按钮激活态一起清掉） */
function clearQuoteHighlight() {
  if (quoteState.btn) quoteState.btn.classList.remove('active');
  const had = !!quoteState.page;
  quoteState = { page: null, fragment: '', btn: null };
  viewer?.clearQuoteHighlight?.();
  return had;
}

/** 点击带原文片段的引用：跳页 + 高亮；再点同一个 = 取消。
 *  只记返回历史，真正的定位（一次即时跳转 + 必要时才滚动）全交给 viewer.highlightQuote，
 *  避免「先平滑滚到页顶、再刷新重绘、再滚到句子」的闪动。 */
async function jumpToQuote(page, fragment, btn) {
  const same = quoteState.page === page && quoteState.fragment === fragment && quoteState.btn === btn;
  if (same) { clearQuoteHighlight(); return; }
  clearQuoteHighlight();
  if (pageJumpWouldMove(page)) recordReaderJump();
  quoteState = { page, fragment, btn: btn || null };
  btn?.classList.add('active');
  let ok = false;
  try { ok = await viewer?.highlightQuote?.(page, fragment); } catch { /* 定位失败不影响跳页 */ }
  // 期间被取消（用户又点了别处）或界面里根本找不到这段原文：别留一个假的激活态
  if (quoteState.page !== page || quoteState.fragment !== fragment) { btn?.classList.remove('active'); return; }
  if (!ok) clearQuoteHighlight();
}

/** 点击问答里的页码标签 / 原文引用块：跳到对应页，有原文就画橙色高亮（没有就只跳页）。
 *  高亮取消方式与引用一致：点正文 / 再点一次 / 翻页 / 换文档。 */
function jumpAndHighlight(page, text) {
  const p = Number(page);
  if (!p) return;
  const fragment = stripPageLabels(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (fragment) jumpToQuote(p, fragment, null);
  else jumpToPageWithHistory(p, { smooth: true });
}

/** 点其它论文的页码标签：自动打开那篇论文（没打开过就先打开）→ 跳到第 N 页 → 有原文片段就高亮 */
async function openOtherPaperRef(name, page, fragment) {
  const q = String(name || '').trim().replace(/^《|》$/g, '').toLowerCase();
  const papers = Array.isArray(state.papers) ? state.papers : [];
  const target = papers.find((p) => String(p?.name || '').toLowerCase() === q)
    || papers.find((p) => String(p?.name || '').toLowerCase().includes(q) || String(p?.path || '').toLowerCase().includes(q));
  if (!target) {
    toast(`找不到《${name}》这篇论文（可能已移出 papers 文件夹）`, 'err', 4500);
    return;
  }
  if (state.doc?.docId !== target.docId) {
    try {
      await openDoc({ name: target.name, url: target.url, docId: target.docId, path: target.path || target.name });
    } catch { /* openDoc 内部已有失败提示 */ }
    if (state.doc?.docId !== target.docId) return;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  jumpAndHighlight(page, fragment || '');
}

/** 页码按钮：按住委托，流式重绘也不用重绑 */
function initPageRefs() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-ref');
    if (!btn) {
      // 点正文/界面上任意处（右栏里点字不算）取消引用高亮；右栏里点其他引用按钮照常处理
      if (quoteState.page && !e.target?.closest?.('#aiArea')) clearQuoteHighlight();
      return;
    }
    const page = Number(btn.dataset.page);
    if (!Number.isInteger(page) || page < 1) return;
    e.preventDefault();
    const fragment = btn.dataset.fragment || '';
    // 其它论文的引用：自动打开那篇论文再跳页/高亮（当前论文的引用不会有 data-paper）
    if (btn.dataset.paper) { openOtherPaperRef(btn.dataset.paper, page, fragment); return; }
    if (fragment) { jumpToQuote(page, fragment, btn); return; }
    jumpToPageWithHistory(page, { smooth: true });
  });
}

function streamTarget(node) {
  let pending = null;
  let rawNode = null;
  let paintedText = '';
  let started = false;
  let active = true;
  let following = true;
  let followEl = null;
  const scan = { cursor: 0, safe: 0, fence: '', inMath: false };
  let raf = 0;
  let timer = 0;
  const bodyEl = node.closest('.ai-body');
  const blockEl = node.closest('.ai-block');
  const entryEl = node.closest('.msg');
  const stopTimers = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
  };
  const ensureTail = () => {
    if (rawNode?.parentNode === node) return;
    rawNode = document.createTextNode('');
    node.append(rawNode);
  };
  const reversedBody = () => {
    if (!bodyEl) return false;
    return bodyEl.dataset?.reversed === '1'
      || (typeof getComputedStyle === 'function' && getComputedStyle(bodyEl).flexDirection === 'column-reverse');
  };
  /** 「跟随输出」的目标位置：短回答停在这一条顶部；长回答跟着消息底部一起往下走 */
  const followTop = () => {
    if (!bodyEl || !entryEl) return 0;
    if (reversedBody()) return 0;
    const visible = bodyEl.clientHeight || 0;
    const offset = entryEl.offsetTop || 0;
    const height = entryEl.offsetHeight || 0;
    if (height <= visible) return Math.max(0, offset);
    return Math.max(0, offset + height - visible + 16);
  };
  const scrollFollow = () => { if (bodyEl) bodyEl.scrollTop = followTop(); };
  const ensureFollowBtn = () => {
    if (!blockEl) return null;
    if (!followEl) {
      followEl = el('button', {
        type: 'button',
        class: 'ai-follow-btn hidden',
        title: '继续跟随输出（跳到最新）',
        'aria-label': '继续跟随输出',
      }, '↓');
      followEl.addEventListener('click', () => {
        following = true;
        hideFollow();
        scrollFollow();
      });
      blockEl.append(followEl);
    }
    return followEl;
  };
  const showFollow = () => { ensureFollowBtn()?.classList.remove('hidden'); };
  const hideFollow = () => { followEl?.classList.add('hidden'); };
  /* 用户向上滚（离开跟随位置）→ 停止自动跟随并出现悬浮的「↓」按钮；点按钮回来继续跟随 */
  const onBodyScroll = () => {
    if (!active) return;
    following = Math.abs((bodyEl?.scrollTop || 0) - followTop()) < 90;
    if (following) hideFollow(); else showFollow();
  };
  bodyEl?.addEventListener('scroll', onBodyScroll, { passive: true });
  const paint = () => {
    stopTimers();
    if (pending === null) return;
    // 回答末尾的 prt 隐藏块（程序用）不能露给用户看：出现就截断
    const display = hideStreamTail(pending);
    // 第一次真正输出：把「思考中…」占位换掉（顺便重置增量渲染状态）
    if (!started) {
      started = true;
      node.replaceChildren();
      rawNode = null;
      paintedText = '';
      scan.cursor = 0; scan.safe = 0; scan.fence = ''; scan.inMath = false;
    } else if (!display.startsWith(paintedText)) {
      node.replaceChildren();
      rawNode = null;
      paintedText = '';
      scan.cursor = 0; scan.safe = 0; scan.fence = ''; scan.inMath = false;
    }
    ensureTail();
    const safeEnd = completedMarkdownEnd(display, scan);
    if (safeEnd > paintedText.length) {
      const template = document.createElement('template');
      template.innerHTML = renderMarkdown(display.slice(paintedText.length, safeEnd));
      node.insertBefore(template.content, rawNode);
      paintedText = display.slice(0, safeEnd);
    }
    rawNode.data = display.slice(paintedText.length);
    if (following) requestAnimationFrame(() => { if (active) scrollFollow(); });
  };
  return {
    push(text) {
      // 工具调用标记（DSML / XML）绝不显示给用户：流式期间也实时剥离
      pending = stripAgentMarkup(text);
      if (raf || timer) return;
      raf = requestAnimationFrame(paint);
      timer = setTimeout(paint, 120);   // rAF 被节流时的兜底
    },
    done(finalText) {
      stopTimers();
      pending = null;
      const wasFollowing = following;
      active = false;
      node.innerHTML = renderAnswerHTML(stripAgentMarkup(finalText));
      rawNode = null; paintedText = '';
      hideFollow();
      bodyEl?.removeEventListener('scroll', onBodyScroll);
      // 输出结束：悬浮按钮消失；一直跟随的话停在最新处，不再跳回顶部
      if (wasFollowing) scrollFollow();
    },
    fail(msg) {
      stopTimers();
      pending = null;
      active = false;
      node.innerHTML = `<span style="color:var(--err)">${esc(msg)}</span>`;
      rawNode = null; paintedText = '';
      hideFollow();
      bodyEl?.removeEventListener('scroll', onBodyScroll);
      scrollEntryToTop(node.closest('.ai-body'), node.closest('.msg'));
    },
  };
}

/** Find a finished Markdown block boundary without interpreting an open fence or display formula. */
function completedMarkdownEnd(text, scan) {
  while (scan.cursor < text.length) {
    const nl = text.indexOf('\n', scan.cursor);
    if (nl < 0) break; // leave the unfinished final line as plain, stable tail text
    const lineEnd = nl + 1;
    const line = text.slice(scan.cursor, nl);
    const trimmed = line.trim();
    if (scan.fence) {
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === scan.fence[0] && close[1].length >= scan.fence.length) {
        scan.fence = '';
        scan.safe = lineEnd;
      }
    } else if (scan.inMath) {
      if (trimmed.includes('$$')) { scan.inMath = false; scan.safe = lineEnd; }
    } else {
      const open = trimmed.match(/^(`{3,}|~{3,})/);
      if (open) scan.fence = open[1];
      else if (trimmed.startsWith('$$')) {
        const count = (trimmed.match(/\$\$/g) || []).length;
        if (count >= 2) scan.safe = lineEnd;
        else scan.inMath = true;
      } else if (!trimmed) scan.safe = lineEnd;
    }
    scan.cursor = lineEnd;
  }
  return scan.safe;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}


function ensureReady() {
  const d = Settings.data;
  if (!d.baseURL) { openSettings(); return false; }
  const local = /127\.0\.0\.1|localhost/.test(d.baseURL);
  if (!d.hasApiKey && !local) { openSettings('先填 API Key'); return false; }
  return true;
}

/** 统一入口：注入空闲超时，避免界面像卡死一样一直转。
 *  用户记录里出现过「接口暂时不可用，请检查连接后重试」连着弹两次（上游偶发 5xx / 网络断一下）；
 *  这里在「还没有任何内容到达」时自动等 0.9s 重试一次，用户不用手动点重试。 */
function chat(opts) {
  const run = (wrapped) => streamChat({ idleMs: Number(Settings.data.idleMs) || 60000, ...wrapped });
  return (async () => {
    let started = false;
    const wrapped = {
      ...opts,
      onDelta: (piece, all) => { started = true; opts.onDelta?.(piece, all); },
      onReasoning: (piece, all) => { started = true; opts.onReasoning?.(piece, all); },
    };
    try {
      return await run(wrapped);
    } catch (e) {
      if (started || opts.signal?.aborted) throw e;
      const msg = String(e?.message || '');
      const transient = /HTTP\s*(?:5\d\d|429)|接口暂时不可用|网络|failed to fetch|fetch failed|socket|ECONN|EAI_AGAIN|upstream|temporar|unavailable|overload|bad gateway|gateway|rate.?limit|限流|繁忙/i.test(msg);
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 900));
      if (opts.signal?.aborted) throw e;
      return run(wrapped);
    }
  })();
}

function makeController() {
  if (state.busy) return null;
  const ctl = new AbortController();
  state.abort = ctl;
  state.abortReason = '';
  return ctl;
}

function abortStream(reason = 'user') {
  const ctl = state.abort;
  if (ctl) {
    state.abortReason = reason;
    try { ctl.abort(); } catch { /* ignore */ }
  }
}

function setBusy(on, hint = '') {
  state.busy = on;
  if (!on) state.activeSendScope = '';
  $('#stopBtn')?.classList.toggle('hidden', !on || !state.abort);
  $('#sendBtn').disabled = on;
  $('#clipBtn').disabled = on;
  if (on) setHint(hint);
  else updateComposerHint();
  const regionTop = $('#regionBtn');
  if (regionTop) regionTop.disabled = on;
  $$('#attachRow .at-x').forEach((button) => { button.disabled = on; });
  const clearBtn = $('#clearSession');
  if (clearBtn) clearBtn.disabled = on;
  updateSendScope();
  sessionsSetBusy(on);
}

/** 输入框旁边那句范围提示（`#composerHint`）：只讲这次会发什么，不再讲带了几轮历史。 */
function sendScopeText({ attachments, history, useFullText, useWeb, query, docId, fullMode, contextIncluded, contextHint = '', scanned = false, scanPageCount = 0 } = {}) {
  const rows = attachments || [];
  const quotes = rows.filter((a) => a.kind === 'text');
  const images = rows.filter((a) => a.kind === 'image');
  const parts = [];
  if (quotes.length) parts.push(`选区 ${quotes.length} 段`);
  if (images.length) parts.push(`图片 ${images.length} 张`);
  const hasDoc = !!docId && !!viewer?.pdf && state.doc?.docId === docId && state.viewerDocId === docId;
  if (hasDoc && (contextIncluded === undefined ? true : contextIncluded)) {
    parts.push(scanPageCount ? `页图 ${scanPageCount} 张`
      : (quotes.length ? (contextHint || '附近上下文') : (contextHint || '当前页上下文')));
  }
  if (hasDoc && useFullText) {
    let mode = fullMode;
    if (!mode && state.docTextDoc === docId) {
      mode = !state.docText ? 'unavailable' : (state.docText.length > FULL_LIMIT ? 'digest' : 'full');
    }
    if (mode === 'full') parts.push('整篇论文');
    else if (mode === 'digest') parts.push(`整篇论文索引 + ${PICK_K} 段相关原文`);
    else if (mode === 'scan-digest') parts.push('整篇论文（图片阅读索引）');
    else if (mode === 'scan-digest') parts.push('整篇论文（图片阅读索引）');
    else if (mode === 'scan') parts.push('整篇论文（按页图理解）');
    else if (mode === 'unavailable') parts.push(scanned ? '整篇论文（按页图理解）' : '整篇论文暂不可提取');
    else parts.push('整篇论文（将增加读取 / 请求量）');
  }
  if (useWeb && String(query || '').trim()) parts.push('联网搜索');
  if (!parts.length && String(query || '').trim()) parts.push('仅当前问题');
  return parts.join(' · ');
}

function updateSendScope() {
  updateComposerHint();
}

function syncScopePrefs() {
  state.useFullText = uiStyle.useFullText !== false;
  state.useWeb = uiStyle.useWeb !== false;
  // 设置页的两个勾 = 每次问答的默认范围；输入框旁的临时切换按钮已于 2026-11-04 移除。
  state.scopeRange = rangeFromPrefs();
  updateComposerHint();
}

function revealPanel(id) {
  const p = state.panels[id];
  if (!p) return;
  hideTranslationCard();
  showAiBlock(id);                                 // visible = true；同栏互斥由 setPanelVisible 保证
  if (document.body.classList.contains('no-right')) setSideCollapsed('right', false, true);
  if (isRightPanel(id)) document.querySelector('#rightSide')?.setAttribute('data-active-panel', id);
  applyPanels();
}

/** 兼容旧名字：译文结果走的就是 revealPanel('translate') */
function revealTranslatePanel() { revealPanel('translate'); }

/**
 * 文本输入翻译（2026-11-03 用户要求）：粘贴/手输文字直接翻，不依赖 PDF 选区。
 * 与划词/截图翻译共用 translateMessages 与同一条流式管线，结果仍按时间堆在译文面板。
 */
async function doTranslateText({ text, targetLang = '中文' } = {}) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw || state.busy) return;
  if (!ensureReady()) return;
  const body = raw.slice(0, 20000);
  const lang = targetLang === 'English' ? 'English' : (targetLang === '中文' ? '中文' : targetLangFor(body));
  revealTranslatePanel();
  const retryOf = () => ({
    kind: 'translate-text', docId: state.doc?.docId || null,
    text: body, targetLang: lang,
  });
  const retry = () => doTranslateText({ text: body, targetLang: lang });
  const key = `translate.input@${PROMPT_SYSTEM_VERSION}::${lang}::${body.length}-${hashStr(body)}`;
  const cached = state.cache.get(key);
  if (cached) {
    const existing = [...state.sessionEntries].reverse().find((x) => x?.block === 'translate'
      && x?.tag === 'translation' && x?.status === 'complete' && String(x?.text || '') === String(cached)
      && String(x?.retry?.kind || '') === 'translate-text');
    if (existing) {
      existing.root?.scrollIntoView?.({ block: 'nearest' });
      toast('这段文字翻过，直接用原结果', 'ok', 1800);
      return;
    }
  }
  const quote = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  const entry = addEntry({ block: 'translate', tag: 'translation', page: null, quote,
    retry: retryOf(), reveal: true });
  entry.root.classList.add('msg-text-translate');
  if (cached) {
    entry.body.innerHTML = renderMarkdown(cached);
    finishEntry(entry, cached);
    toast('这段文字翻过，直接用缓存', 'ok', 1500);
    return;
  }
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    const full = await chat({
      messages: translateMessages({ text: body, targetLang: lang, context: '', page: null, docTitle: state.doc?.name }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    const clean = full.trim();
    target.done(clean);
    state.cache.set(key, clean);
    // 成功时保持译文块「最纯净」的界面（不摆按钮）；失败/停止时 .acts 非空才显示重试
    finishEntry(entry, clean);
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, { status: 'stopped', retryLabel: '重新翻译', onRetry: retry });
    } else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), retry);
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

async function doTranslate(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  const lang = targetLangFor(text);
  // A 线 P3：翻译缓存键带提示词版本（改翻译提示词 → 旧缓存不复用）
  const key = `translate.selection@${PROMPT_SYSTEM_VERSION}::${lang}::${text.length}-${hashStr(text)}`;
  const cached = state.cache.get(key);
  const inCard = document.body.classList.contains('no-right') || document.body.classList.contains('right-empty');
  const cardBody = inCard ? showTranslationCard(sel) : null;
  if (!inCard) revealTranslatePanel();

  if (cached) {
    const existing = [...state.sessionEntries].reverse().find((x) => x?.block === 'translate'
      && x?.tag === 'translation' && x?.status === 'complete' && x?.quote === text
      && String(x?.text || '') === String(cached));
    if (existing) {
      if (cardBody) cardBody.innerHTML = renderMarkdown(cached);
      else {
        existing.root?.scrollIntoView?.({ block: 'nearest' });
        toast('这段翻译已在结果区，直接使用原结果', 'ok', 1800);
      }
      return;
    }
  }
  const entry = addEntry({ block: 'translate', tag: 'translation', page: sel.page, quote: text,
    retry: { kind: 'translate', docId: state.doc?.docId || null, text, page: sel.page || null }, reveal: !inCard });
  if (cached) {
    entry.body.innerHTML = renderMarkdown(cached);
    if (cardBody) cardBody.innerHTML = renderMarkdown(cached);
    finishEntry(entry, cached, { page: sel.page, onAsk: () => addToChat(sel) });
    toast('这段翻过，直接用缓存', 'ok', 1500);
    return;
  }

  const target = streamTarget(entry.body);
  const cardTarget = cardBody ? streamTarget(cardBody) : null;
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    const context = sel.page ? await viewer.getContextAround(sel.page, text) : '';
    const full = await chat({
      messages: translateMessages({ text, targetLang: lang, context, page: sel.page, docTitle: state.doc?.name }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); cardTarget?.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    const clean = full.trim();
    target.done(clean);
    cardTarget?.done(clean);
    state.cache.set(key, clean);
    finishEntry(entry, clean, { page: sel.page, onAsk: () => addToChat(sel) });
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      cardTarget?.done(received);
      finishEntry(entry, received, { page: sel.page, status: 'stopped', onRetry: () => doTranslate(sel) });
    }
    else {
      target.fail(errText(e));
      cardTarget?.fail(errText(e));
      addFailureRetry(entry, errText(e), () => doTranslate(sel));
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}

/** 截图翻译的重试描述（只存附件 id + 页码/标签，不存 base64 图片本体） */
function translateShotRetryPayload({ docId, sid, page, label, refId = '' }) {
  return {
    kind: 'translate-shot',
    docId: String(docId || ''),
    sid: String(sid || '').slice(0, 40),
    page: page || null,
    label: String(label || '截图').slice(0, 120),
    refId: validAttachmentId(refId) ? refId : '',
  };
}

/**
 * 截图翻译（2026-11-03）：把框选到的 PDF 区域当图片发给模型，直接翻译图里的文字。
 * 与划词翻译的区别：选区来自像素而不是文本层，所以图表、公式、扫描页也能翻。
 */
async function doTranslateShot({ shot, page = null, label = '截图', refId = '', sid = '', docId = '' } = {}) {
  const dataUrl = String(shot?.dataUrl || '');
  if (!dataUrl || state.busy) return;
  const curDocId = state.doc?.docId || null;
  const targetDoc = String(docId || '') || curDocId;
  if (!targetDoc) { toast('先打开一篇论文，再框选截图翻译', 'err'); return; }
  if (targetDoc !== curDocId) { toast('这张截图属于另一篇论文，请切回原论文后重试', 'err', 3200); return; }
  if (!ensureReady()) return;
  revealTranslatePanel();
  const pageNo = Number(page) > 0 ? Number(page) : null;
  const label0 = String(label || '截图').slice(0, 120);
  const sessionSid = String(sid || '') || activeSidFor(targetDoc);
  let finalRef = validAttachmentId(refId) ? refId : '';
  const retryOf = (rid) => translateShotRetryPayload({ docId: targetDoc, sid: sessionSid, page: pageNo, label: label0, refId: rid || '' });

  const entry = addEntry({
    block: 'translate', tag: 'translation', page: pageNo, quote: label0,
    thumbs: [dataUrl], retry: retryOf(finalRef), reveal: true,
  });
  // 译文块默认隐藏 .acts（「最纯净的界面」）：截图翻译失败/被停止时要让重试按钮可见
  entry.root.classList.add('msg-shot-translate');

  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    // 图片单独存：会话 JSON 只记 {id,w,h,label}，恢复/重试时按 id 取回原图
    if (!finalRef) {
      finalRef = await uploadAttachment(dataUrl, targetDoc, sessionSid);
      const rec = entry.root.__sessionRecord;
      if (finalRef && rec) {
        rec.screenshot = true;
        rec.shots = [{ id: finalRef, w: Number(shot?.width) || 0, h: Number(shot?.height) || 0, label: label0 }];
        rec.retry = retryOf(finalRef);
      }
      if (rec) scheduleSessionSave();
    }
    warnIfNoVisionModel(true);
    const messages = translateShotMessages({
      page: pageNo, docTitle: state.doc?.name || '', label: label0, targetLang: '中文',
    });
    const last = messages[messages.length - 1];
    if (last && typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: dataUrl } },
      ];
    }
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    const clean = String(full || '').trim();
    target.done(clean);
    finishEntry(entry, clean, { page: pageNo });
  } catch (e) {
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, { page: pageNo, status: 'stopped', onRetry: () => retryTranslateShot(retryOf(finalRef)) });
    } else {
      const rec = entry.root.__sessionRecord;
      if (rec) { rec.status = 'failed'; rec.text = ''; rec.meta = ''; }
      target.fail(errText(e));
      entry.root.classList.add('err');
      entry.acts.replaceChildren(el('button', { text: '重试截图翻译', onclick: () => retryTranslateShot(retryOf(finalRef)) }));
      entry.acts.classList.remove('hidden');
      entry.root.querySelectorAll('.entry-meta').forEach((node) => node.remove());
      entry.root.append(el('div', { class: 'entry-meta failed', text: `截图翻译失败：${errText(e)}` }));
      scheduleSessionSave();
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
    scrollBody(entry.root.closest('.ai-body'));
  }
}

/** 重试截图翻译：按附件 id 取回原图再跑（原图已被清理时提示重新框选） */
function retryTranslateShot(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const docId = p.docId || state.doc?.docId || '';
  if (!docId || docId !== state.doc?.docId) { toast('这张截图属于另一篇论文，请切回原论文后重试', 'err', 3200); return; }
  if (state.busy) { toast('正在生成中，先等它跑完或点停止再重试', 'err', 3200); return; }
  const sid = p.sid || activeSidFor(docId);
  const refId = validAttachmentId(p.refId) ? p.refId : '';
  if (!refId) { toast('截图没有保存下来，请重新框选翻译', 'err', 4200); return; }
  (async () => {
    const dataUrl = await fetchAttachmentDataUrl(refId, docId, sid);
    if (!dataUrl) { toast('截图文件已不在，请重新框选翻译', 'ok', 5200); return; }
    await doTranslateShot({ shot: { dataUrl, width: 0, height: 0 }, page: p.page || null, label: p.label || '截图', refId, sid, docId });
  })();
}

async function doExplain(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  const docId = state.doc?.docId || null;
  const openSeq = state.openSeq;
  const sid = activeSidFor(docId);
  const history = snapshotHistory(state.history);
  const fromRight = sel.source === 'right';
  const reading = resolveReadingRequest({ question: '请解释这段内容涉及的知识。', selection: text, page: sel.page, history,
    selectionSource: fromRight ? 'right' : '' });
  // 「释」直接写在侧栏里，不弹浮层 —— 解释是要读的，不是瞄一眼的
  revealPanel('chat');
  const entry = addEntry({ block: 'chat', tag: 'explanation', page: sel.page, quote: text,
    retry: { kind: 'explain', docId: state.doc?.docId || null, text, page: sel.page || null,
      source: fromRight ? 'right' : '' } });
  const target = streamTarget(entry.body);
  const ctl = makeController();
  if (!ctl) return;
  setBusy(true, '0s');
  let received = '';
  try {
    const context = sel.page ? await viewer.getContextAround(sel.page, text) : '';
    const references = await readingReferences(text);
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    if (ctl.signal.aborted) throw new DOMException('已停止', 'AbortError');
    const citationMat = citationMaterialsFor({
      context, references, scanned: false, pageRole: 'selection',
      pending: { firstPage: sel.page || null, reading },
    });
    activeCitationPlan = null;
    const full = await chat({
      messages: explainMessages({ selection: text, context, page: sel.page, docTitle: state.doc?.name, history, reading, references,
        selectionSource: fromRight ? 'right' : '',
        profileBlock: askProfileBlock(text + "\n" + context, reading.question, { docId }),
        availablePages: citationMat.availablePages,
        scopeLabel: '选区', objectLabel: objectLabelFor({ question: reading.question }, reading) }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    await auditAnswerCitations(full, { availablePages: citationMat.availablePages, scanned: false });
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    target.done(full);
    state.history = snapshotHistory([...state.history, ...readingTurn(reading, full)]);
    scheduleSessionSummary();
    finishEntry(entry, full, { page: sel.page, basis: citationMat.basis, onAsk: () => addToChat(sel) });
  } catch (e) {
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    if (isAbort(e)) {
      target.done(received);
      finishEntry(entry, received, { page: sel.page, status: 'stopped', onAsk: () => addToChat(sel), onRetry: () => doExplain(sel) });
    }
    else {
      target.fail(errText(e));
      addFailureRetry(entry, errText(e), () => doExplain(sel));
    }
  } finally {
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
  }
}


const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 把选中的文字加进「待发送附件」，可以连续加多段，也可以再加图片 */
function addToChat(sel) {
  if (!sel || state.busy) return;
  const text = sel.cleanText || cleanText(sel.text || '');
  if (!text) return;
  const fromRight = sel.source === 'right';
  state.attachments.push({
    id: uid(), kind: 'text',
    // 右栏文字不挂页码；正文选区自带页，兜底也按屏幕实际页现算（viewer.current 有滚动节流，会慢一拍）
    page: fromRight ? null : (sel.page || viewer?.currentVisiblePage?.() || viewer?.current || null),
    text,
    // 来源只用于附件行的提示：正文划选 / 右栏回答或译文里划选
    from: fromRight ? 'right' : '',
  });
  renderAttachments();
  revealPanel('chat');            // 必须把「问答」切到当前标签，否则输入框是 display:none，focus 白调
  $('#chatInput').focus();
  flashHint(`已加入问答区（共 ${state.attachments.length} 项，可以继续加）`);
}

/** 把一张截图加进附件 */
function addImageToChat(shot, page, label, { allowBusy = false } = {}) {
  if (state.busy && !allowBusy) return;
  state.attachments.push({
    id: uid(), kind: 'image', page, dataUrl: shot.dataUrl,
    w: shot.width, h: shot.height, pages: shot.pages || 1, label,
  });
  renderAttachments();
  // 译文面板里框选的截图也留在下方输入框（截图先放框里、再按 Enter 翻译，和问答一致，用户 m05190）
  if (rightPanelInCol(1) !== 'translate') revealPanel('chat');
  $('#chatInput').focus();
  flashHint(`已加入截图${shot.pages > 1 ? `（跨 ${shot.pages} 页）` : ''}，共 ${state.attachments.length} 项`);
}

function removeAttach(id) {
  if (state.busy) return;
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function takeAttachments() {
  const list = state.attachments.slice();
  state.attachments = [];
  renderAttachments();
  return list;
}

function dropSentAttachments(pending) {
  const ids = new Set((pending?.attachments || []).map((a) => a && a.id).filter(Boolean));
  if (!ids.size || !state.attachments.some((a) => ids.has(a.id))) return;
  state.attachments = state.attachments.filter((a) => !ids.has(a.id));
  renderAttachments();
}

/** 发送失败：把这条请求的附件放回输入区（截图不丢，改完问题可以直接再发）。 */
function restoreSentAttachments(pending) {
  const ids = new Set(state.attachments.map((a) => a.id));
  const back = (pending?.attachments || []).filter((a) => a && a.id && !ids.has(a.id));
  if (!back.length) return;
  state.attachments = [...back, ...state.attachments];
  renderAttachments();
}

function renderAttachments() {
  const row = $('#attachRow');
  if (!row) return;
  if (!state.attachments.length) {
    row.classList.add('hidden');
    row.replaceChildren();
    updateSendScope();
    return;
  }
  row.classList.remove('hidden');
  row.replaceChildren(...state.attachments.map((a) => el('div', { class: `attach ${a.kind}` },
    a.kind === 'image'
      ? el('img', { src: a.dataUrl, title: '点开看大图', onclick: () => window.open(a.dataUrl, '_blank') })
      : null,
    el('span', { class: 'at-meta' },
      a.page ? el('b', { text: `第${a.page}页` }) : null,
      a.from === 'right' ? el('b', { class: 'at-from', text: '右栏' }) : null,
      el('span', { class: 'at-text', text: a.kind === 'image' ? (a.label || '截图') : a.text.replace(/\s+/g, ' ') }),
    ),
    el('button', { type: 'button', class: 'at-x', title: '移除', onclick: () => removeAttach(a.id) }, iconEl('close', { size: 13 })),
  )));
  $$('#attachRow .at-x').forEach((button) => { button.disabled = state.busy; });
  updateSendScope();
}

let hintTimer = null;
function flashHint(msg, ms = 3200) {
  const node = $('#composerHint');
  node.textContent = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { if (!state.busy) node.textContent = ''; }, ms);
}

/* ── 第一次打开/切换论文的加载提示（热切换不显示，避免「点了没反应」） ── */
let docLoadingTimer = 0;
function showDocLoading(name) {
  const box = $('#docLoading');
  if (!box) return;
  const label = String(name || '').replace(/\.pdf$/i, '');
  const text = $('#docLoadingText');
  if (text) text.textContent = label ? `正在打开《${label}》…` : '正在打开…';
  box.classList.remove('hidden');
  if (docLoadingTimer) clearTimeout(docLoadingTimer);
  // 安全兜底：任何异常路径都不能让这层一直盖着正文
  docLoadingTimer = setTimeout(hideDocLoading, 25000);
}
function hideDocLoading() {
  const box = $('#docLoading');
  if (box) box.classList.add('hidden');
  if (docLoadingTimer) { clearTimeout(docLoadingTimer); docLoadingTimer = 0; }
}


function initComposer() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  syncComposerMode();
  $('#stopBtn').onclick = () => { abortStream('user'); setHint('正在停止…'); };
  $('#clipBtn').onclick = () => state.startRegion?.();
  // 「清空会话」不再常驻在输入框下面，改挂在会话菜单里。
  // 这里的绑定用可选链，元素不在也不抛。
  const clearBtn = $('#clearSession');
  if (clearBtn) clearBtn.onclick = clearCurrentSession;
  renderAttachments();

  const ta = $('#chatInput');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(130, ta.scrollHeight)}px`;
    updateSendScope();
  });
}


/** 整篇论文此刻能不能开：要有一篇真的装好的论文 */
const fullScopeAvailable = () => !!state.doc && !!viewer?.pdf && state.viewerDocId === state.doc?.docId;


const SCOPE_RANGES = {
  current: { key: 'current', short: '当前内容', icon: 'region', full: false, web: false,
    desc: '只发送你选中的文字；没有选中就发送当前页上下文' },
  paper: { key: 'paper', short: '整篇论文', icon: 'book', full: true, web: false,
    desc: '发送整篇论文作为上下文' },
  web: { key: 'web', short: '联网搜索', icon: 'link', full: false, web: true,
    desc: '带论文片段的同时联网查一次资料' },
  'paper-web': { key: 'paper-web', short: '论文 + 联网', icon: 'book', full: true, web: true,
    desc: '发送整篇论文，并先联网查一次资料' },
};

/** 设置页两个偏好 → 初始范围（沿用老存档语义，不改变既有默认「整篇 + 联网」）
 *  ⚠️ 只读 uiStyle（偏好本身），不要读 state.useFullText：那是「当次发送」的运行时值，
 *  混用会出现「默认开着整篇、范围却是当前内容」这种自相矛盾的初始态。 */
function rangeFromPrefs() {
  const full = uiStyle.useFullText !== false;
  const web = uiStyle.useWeb !== false;
  if (full && web) return 'paper-web';
  if (full) return 'paper';
  if (web) return 'web';
  return 'current';
}

function currentRange() {
  return SCOPE_RANGES[state.scopeRange] ? state.scopeRange : 'paper-web';
}

/** 按给定范围开关 state 的两个标记（发送前 / 换论文后调用；同一套推导，不重复实现） */
function applyRangeForSend(rangeKey) {
  const r = SCOPE_RANGES[rangeKey] || SCOPE_RANGES['paper-web'];
  state.useFullText = r.full;
  state.useWeb = r.web;
  return r;
}

/** 这次到底会发什么 —— 给发送框那句短状态用（不让人猜范围） */
function rangeOverview() {
  const r = SCOPE_RANGES[currentRange()];
  const sel = String(state.selection || '').replace(/\s+/g, ' ').trim();
  const head = sel ? `选中 ${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}` : '当前页上下文';
  const tail = [];
  if (r.full) tail.push(fullScopeAvailable() ? '整篇论文' : '整篇论文（暂不可提取）');
  if (r.web) tail.push('联网搜索');
  return tail.length ? `${head} · ${tail.join(' · ')}` : head;
}

function updateComposerHint() {
  if (state.busy) return;                    // 忙的时候那行归进度文案用
  setHint(rangeOverview());
}

/** 兼容旧调用点：发送范围芯片移除后，这里只刷新输入框旁边那句提示。 */
function renderScopeMenu() {
  updateComposerHint();
}

/** 脚本/自动化可直接改这一次发送的范围（输入框旁的芯片已于 2026-11-04 移除，
 *  界面上只保留设置页「交互与发送」里的两个默认值）。 */
function setScopeRange(key) {
  if (!SCOPE_RANGES[key]) return;
  state.scopeRange = key;
  applyRangeForSend(key);
  updateComposerHint();
}

/** 输入框下面那行小字，用于显示进度；传空字符串清掉 */
function setHint(t) {
  const h = $('#composerHint');
  if (h) h.textContent = t || '';
}

/* ------------------------------------------------------------ 扫描件：页型 / 页图 / 图片阅读索引 */

// A 线 P3：页型识别与图片阅读索引的缓存键都带提示词系统版本（提示词/转写规则一改就失效）
// 页型扫描缓存版本：v1 的实现里 profile.version 跟这个常量对不上，等于缓存永远不命中、每次打开都重扫；
// 这里升到 scan2 并让 saveCachedDocProfile 写入匹配版本，同时大文件改用抽样扫描（见 pdfview.scanDocProfile）。
const DOC_PROFILE_VERSION = `${PROMPT_SYSTEM_VERSION}-scan2`;
const SCAN_DIGEST_VERSION = PROMPT_SYSTEM_VERSION;
/** 扫描件一次问答带几张页图（整篇类问题） */
const SCAN_PAGES_MAX = 5;
/** 生成图片阅读索引时最多转写几页 */
const SCAN_DIGEST_PAGES = 8;

/** 论文文件指纹：换文件（大小/mtime 变了）就让页型缓存和阅读索引失效 */
function paperFingerprint(docId) {
  const p = (state.papers || []).find((x) => x && x.docId === docId);
  if (!p) return '';
  return `${p.size || 0}:${Math.round(Number(p.mtime) || 0)}`;
}
function docProfileCacheKey(docId) {
  const fp = paperFingerprint(docId);
  return fp ? `reader.docProfile.${DOC_PROFILE_VERSION}:${docId}:${fp}` : '';
}
function scanDigestCacheKey(docId) {
  const fp = paperFingerprint(docId);
  return fp ? `reader.scanDigest.${SCAN_DIGEST_VERSION}:${docId}:${fp}` : '';
}
function loadCachedDocProfile(docId) {
  try {
    const key = docProfileCacheKey(docId);
    if (!key) return null;
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && parsed.version === DOC_PROFILE_VERSION && Array.isArray(parsed.pages) ? parsed : null;
  } catch { return null; }
}
function saveCachedDocProfile(docId, profile) {
  try {
    const key = docProfileCacheKey(docId);
    if (key) localStorage.setItem(key, JSON.stringify({ ...profile, version: DOC_PROFILE_VERSION }));
  } catch { /* localStorage 满了也不影响阅读 */ }
}
function loadCachedScanDigest(docId) {
  try {
    const key = scanDigestCacheKey(docId);
    if (!key) return '';
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && parsed.version === SCAN_DIGEST_VERSION && typeof parsed.text === 'string' ? parsed.text : '';
  } catch { return ''; }
}
function saveCachedScanDigest(docId, text) {
  try {
    const key = scanDigestCacheKey(docId);
    if (key) localStorage.setItem(key, JSON.stringify({ version: SCAN_DIGEST_VERSION, text, at: Date.now() }));
  } catch { /* 同上 */ }
}

/** 应用页型扫描结果：扫描件提示一次，并刷新发送范围提示 */
function applyDocProfile(docId, profile) {
  if (state.doc?.docId !== docId) return;
  state.docProfile = profile;
  state.docProfileDoc = docId;
  updateSendScope();
  if (profile?.scanned && !state.scanNoticeShown[docId]) {
    state.scanNoticeShown[docId] = true;
    // 主模型支持视觉时（如 deepseek-flash）直接读页面图；单独配了视觉模型更稳。
    // 用户口径（2026-11-02）：右下角只弹问题类提示，扫描件说明属于信息类 → 放到输入框下方的小字里，不弹窗。
    const hasVision = String(Settings.data.visionModel || '').trim();
    setHint(hasVision
      ? `扫描件：没有文本层，问答将按页面图片理解（读图模型：${hasVision}）`
      : '扫描件：没有文本层，问答与「读懂论文」将按页面图片理解（图片交给主模型；若主模型不能读图，请到设置里配置视觉模型）');
  }
}

/** 打开论文后后台跑一次页型扫描（命中本地缓存就直接用） */
function startDocProfileScan(docId) {
  const myDoc = docId || state.doc?.docId;
  if (!myDoc || !viewer?.pdf) return Promise.resolve(null);
  if (state.docProfile && state.docProfileDoc === myDoc) return Promise.resolve(state.docProfile);
  if (state.docProfilePromise) return state.docProfilePromise;
  const cached = loadCachedDocProfile(myDoc);
  if (cached) { applyDocProfile(myDoc, cached); return Promise.resolve(cached); }
  state.docProfilePromise = (async () => {
    try {
      const profile = await viewer.scanDocProfile();
      if (!profile || state.doc?.docId !== myDoc) return null;
      saveCachedDocProfile(myDoc, profile);
      applyDocProfile(myDoc, profile);
      return profile;
    } catch { return null; }
    finally { state.docProfilePromise = null; }
  })();
  return state.docProfilePromise;
}

/** 扫描件一次问答带哪些页的图片 */
function pickScanPages(profile, { question = '', page = null, whole = false } = {}) {
  const total = Number(profile?.numPages) || viewer?.numPages || 1;
  const current = clamp(Number(page) || viewer?.current || 1, 1, total);
  const set = new Set([current]);
  const wholeQ = whole || /这篇论文|本文|整篇|全文|整体|方法|结论|实验|总结|贡献|摘要|abstract|conclusion/i.test(String(question || ''));
  if (wholeQ) {
    for (const p of [1, 2, total - 1, total]) if (p >= 1 && p <= total) set.add(p);
    const scanned = (profile?.scanPages || []).filter((p) => p !== current);
    const step = Math.max(1, Math.ceil(scanned.length / Math.max(1, SCAN_PAGES_MAX - set.size)));
    for (let i = 0; i < scanned.length; i += step) set.add(scanned[i]);
  } else {
    if (current > 1) set.add(current - 1);
    if (current < total) set.add(current + 1);
  }
  return [...set].sort((a, b) => a - b).slice(0, SCAN_PAGES_MAX);
}

/** 逐页渲染成图片（并发 3 张，页数少所以很快；失败跳过该页） */
async function renderScanPages(pages = []) {
  const list = [...new Set((pages || []).map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 1))];
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const p = list[cursor++];
      try {
        const shot = await viewer.capturePageImage(p, { maxDim: 1400 });
        out.push({ page: p, ...shot });
      } catch { /* 单页渲染失败不挡整次请求 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  return out.sort((a, b) => a.page - b.page);
}

/** 把页面图片追加到本轮最后一条 user 消息（文本 + image_url 多段内容） */
function attachPageImages(messages, pageImages = []) {
  if (!Array.isArray(messages) || !messages.length || !pageImages.length) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;
  const parts = Array.isArray(last.content)
    ? last.content
    : [{ type: 'text', text: String(last.content || '') }];
  if (!Array.isArray(last.content)) last.content = parts;
  const label = pageImages.map((im) => `【第${im.page}页原图】见附图`).join('\n');
  const first = parts.find((p) => p && p.type === 'text');
  if (first) first.text = `${first.text || ''}\n\n${label}`;
  else parts.unshift({ type: 'text', text: label });
  for (const im of pageImages) {
    if (im?.dataUrl) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  }
  return messages;
}

let visionWarned = false;
/** 发图前提醒一次：没配视觉模型时图片仍会走主模型，不支持图片的模型会报错 */
function warnIfNoVisionModel(hasImages) {
  if (!hasImages || visionWarned) return;
  if (String(Settings.data.visionModel || '').trim()) return;
  visionWarned = true;
  flashHint('未配置「视觉模型」：图片会交给主模型；如果它不支持读图，请到设置里填一个视觉模型');
}

/** 图片阅读索引要转写的页：首 2 页 + 扫描页采样 + 末 2 页 */
function sampleScanPages(profile) {
  const total = Number(profile?.numPages) || viewer?.numPages || 1;
  const set = new Set();
  for (const p of [1, 2, total - 1, total]) if (p >= 1 && p <= total) set.add(p);
  const scanned = (profile?.scanPages || []).filter((p) => p >= 1 && p <= total);
  const step = Math.max(1, Math.ceil(scanned.length / Math.max(1, SCAN_DIGEST_PAGES - set.size)));
  for (let i = 0; i < scanned.length && set.size < SCAN_DIGEST_PAGES; i += step) set.add(scanned[i]);
  return [...set].sort((a, b) => a - b).slice(0, SCAN_DIGEST_PAGES);
}

/**
 * 扫描件的「图片阅读索引」：逐页 AI 转写 → 拼成可当作全文用的文本。
 * @deprecated 2026-11-02：用户口径「直接读图，本来就能看图」——扫描件不再做逐页 AI 转写
 *   （旧路径首次要串行 8 次视觉模型调用，十几秒到一分钟）。教学与 Agent 都已改为直接带页图，
 *   这里保留实现 + 页级缓存，仅作为以后「模型不支持看图」时的兜底；当前没有调用点。
 */
async function ensureScanDigest(docId, profile) {
  const myDoc = docId || state.doc?.docId;
  if (!myDoc) return '';
  if (state.scanDigest && state.scanDigestDoc === myDoc) return state.scanDigest;
  const cached = loadCachedScanDigest(myDoc);
  if (cached) { state.scanDigest = cached; state.scanDigestDoc = myDoc; return cached; }
  if (state.scanDigestPromise) return state.scanDigestPromise;
  const pages = sampleScanPages(profile);
  const myTitle = state.doc?.name || '';
  state.scanDigestPromise = (async () => {
    const rows = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        if (state.doc?.docId !== myDoc) return '';
        setHint(`扫描件：正在阅读第 ${pages[i]} 页（${i + 1}/${pages.length}）…`);
        const shot = await viewer.capturePageImage(pages[i], { maxDim: 1400 });
        if (state.doc?.docId !== myDoc) return '';
        let text = '';
        try {
          text = await chat({
            messages: attachPageImages(scanPageMessages({ page: pages[i], docTitle: myTitle }), [shot]),
            signal: state.abort?.signal,
            stream: false,
            temperature: 0,
          });
        } catch (e) {
          if (isAbort(e)) return '';
          text = '';
        }
        const clean = String(text || '').trim();
        if (clean) rows.push(`===== p.${pages[i]} =====\n${clean}`);
      }
      if (!rows.length) return '';
      const combined = `【扫描件图片阅读索引 · 由页面图片逐页转写，可能有错字】\n${rows.join('\n\n')}`.slice(0, 24000);
      if (state.doc?.docId !== myDoc) return '';
      saveCachedScanDigest(myDoc, combined);
      state.scanDigest = combined;
      state.scanDigestDoc = myDoc;
      return combined;
    } finally {
      state.scanDigestPromise = null;
      setHint('');
    }
  })();
  return state.scanDigestPromise;
}

/** 用户明确选择「整篇」后读取文本，默认打开论文不触发全文提取。 */
async function warmDocText() {
  if (!viewer?.pdf || !state.doc) return;
  const myDoc = state.doc.docId;
  if (state.docText && state.docTextDoc === myDoc) return;
  // 扫描件没有文本层：不白跑一遍全文抽取，直接把「按页图理解」告诉用户
  const profile = state.docProfileDoc === myDoc ? state.docProfile : await startDocProfileScan(myDoc);
  if (profile?.scanned) {
    state.docText = '';
    state.docTextDoc = myDoc;
    updateSendScope();
    setHint('扫描件：没有文本层，问答会按页面图片理解（不需要抽取全文）');
    return;
  }
  try {
    setHint('正在读取整篇论文…');
    const text = await viewer.getAllText((i, n) => setHint(`正在读取整篇论文 ${i}/${n} 页`));
    // 抽的过程中可能已经换了论文：那就丢掉，别把空串记到新文档头上
    if (state.doc?.docId !== myDoc) return;
    state.docText = text;
    state.docTextDoc = myDoc;
    updateSendScope();
    // 用户在读取过程中取消了这次范围，就不要把过时的完成提示写回输入框。
    if (!state.useFullText) return;
    setHint(text ? `整篇论文已就绪：${text.length.toLocaleString()} 字（本次发送会增加请求量）` : '这篇文章抽不出文本（可能是扫描件），改用框选截图问');
  } catch {
    if (state.doc?.docId !== myDoc) return;
    setHint('读取整篇论文失败，这次提问只带选中内容和当前页上下文');
    updateSendScope();
  }
}

/** 超过这个字数就不原样发全文了，改发「阅读索引 + 相关段落」 */
let FULL_LIMIT = 100000;
/** 索引模式下一次取几段原文 */
const PICK_K = 6;

async function buildDocContext(question, selection, { page = null, forTeaching = false, whole = false } = {}) {
  if (!state.doc) return null;
  const myDoc = state.doc.docId;
  const myTitle = state.doc.name;
  const myOpen = state.openSeq;
  const stillCurrent = () => state.doc?.docId === myDoc && (myOpen == null || state.openSeq === myOpen)
    && (!state.viewerDocId || state.viewerDocId === myDoc);
  const stale = () => {
    const e = new Error('论文已切换，丢弃旧论文上下文');
    e.name = 'AbortError';
    return e;
  };
  // ① 扫描件：没有文本层 → 带页面图片（教学类再补图片阅读索引）
  const profile = await startDocProfileScan(myDoc).catch(() => null);
  if (!stillCurrent()) throw stale();
  if (profile?.scanned) {
    const targetPage = Number(page) || viewer?.current || 1;
    /* 用户口径（2026-11-02）：扫描件**直接读图**，不再逐页调视觉模型做 OCR 转写
       （旧路径要串行 8 次 AI 调用，第一遍要十几秒到一分钟）。教学类也直接带页图。 */
    setHint('扫描件：正在准备页面图片…');
    const pages = pickScanPages(profile, {
      question: forTeaching ? '整篇' : question,
      page: targetPage,
      whole: forTeaching || whole,
    });
    const pageImages = await renderScanPages(pages);
    if (!stillCurrent()) throw stale();
    setHint('');
    return { text: '', mode: 'scan', chars: 0, profile, pageImages };
  }
  // ② 普通文本 PDF：沿用原有逻辑
  if (!state.docText || state.docTextDoc !== myDoc) {
    setHint('正在读取整篇论文…');
    const text = await viewer.getAllText((i, n) => setHint(`正在读取整篇论文 ${i}/${n} 页`));
    if (!stillCurrent()) throw stale();
    state.docText = text;
    state.docTextDoc = myDoc;
    state.docDigest = null;
  }
  if (!stillCurrent() || state.docTextDoc !== myDoc) throw stale();
  const text = state.docText || '';
  if (!text) { setHint(''); return null; }
  if (text.length <= FULL_LIMIT) {
    setHint('');
    return { text, mode: 'full', chars: text.length };
  }

  if (!state.docDigest) {
    setHint('整篇论文较长，正在生成阅读索引（只做一次）…');
    const head = text.slice(0, 240000);           // 索引阶段不必喂到最后一个字
    const digest = await chat({
      messages: digestMessages({ text: head, docTitle: myTitle }),
      signal: state.abort?.signal,
      onTick: () => setHint('正在生成阅读索引…'),
    });
    if (!stillCurrent()) throw stale();
    state.docDigest = digest;
  }
  if (!stillCurrent()) throw stale();
  const digest = state.docDigest;
  const picked = pickRelevantPages(text, `${question}\n${selection || ''}`, PICK_K);
  setHint('');
  return {
    text: `【阅读索引】\n${digest}\n\n【与本次问题最相关的原文段落】\n${picked}`,
    mode: 'digest',
    chars: text.length,
  };
}

/**
 * 极简关键词检索：正文按 "===== p.N =====" 切成页，词频打分取前 k 页。
 * 不引入向量模型——对「找相关段落」这个用途，词频足够好且零成本。
 */
function pickRelevantPages(text, query, k = PICK_K, per = 1600) {
  const re = /===== p\.(\d+) =====/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    // start = 标记起点（上一页正文到这儿为止），at = 标记之后（本页正文起点）
    marks.push({ page: Number(m[1]), start: m.index, at: m.index + m[0].length });
  }
  if (!marks.length) return text.slice(0, per * k);
  const chunks = marks.map((mk, i) => ({
    page: mk.page,
    body: text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].start : text.length),
  }));

  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'has',
    'have', 'not', 'but', 'can', 'its', 'which', 'when', 'what', 'how', 'why', 'you', 'your', 'our',
    'they', 'their', 'will', 'would', 'should', 'could', 'been', 'more', 'than', 'then', 'into', 'also',
    'such', 'only', 'some', 'other', 'these', 'those', 'using', 'used', 'based', 'paper', 'method',
    'methods', 'results', 'result', 'about', 'there', 'here', 'does', 'each', 'both', 'same', 'very']);
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fa5]{2,}/g) || [])]
    .filter((t) => !STOP.has(t))
    .slice(0, 30);

  const low = chunks.map((c) => c.body.toLowerCase());
  const scored = chunks.map((c, i) => {
    let score = 0;
    for (const t of terms) {
      let idx = low[i].indexOf(t);
      let n = 0;
      while (idx !== -1 && n < 6) { n++; idx = low[i].indexOf(t, idx + t.length); }
      if (n) score += n * (t.length >= 6 ? 2 : 1);
    }
    return { page: c.page, body: c.body, score };
  });

  const hit = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  const use = hit.length ? hit : scored.slice(0, k);
  return use.sort((a, b) => a.page - b.page)
    .map((s) => {
      const body = s.body.replace(/\s+/g, ' ').trim();
      const positions = terms.map((t) => body.toLowerCase().indexOf(t)).filter((n) => n >= 0);
      const at = positions.length ? Math.min(...positions) : 0;
      const start = Math.max(0, at - Math.floor(per / 3));
      return `[p.${s.page}] ${start ? '…' : ''}${body.slice(start, start + per)}`;
    })
    .join('\n\n');
}

/** 联网搜索（服务端带 5 分钟缓存，多引擎兜底） */
async function webSearch(query, signal) {
  if (!String(query || '').trim()) return [];
  const url = `/api/web-search?q=${encodeURIComponent(String(query).slice(0, 200))}&n=6`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`搜索失败 HTTP ${r.status}`);
  const j = await r.json();
  return filterWebResults(query, j.results || []).slice(0, 6);
}

function readingRequestCurrent({ docId, openSeq, sid }) {
  return (state.doc?.docId || null) === docId && (openSeq == null || state.openSeq === openSeq)
    && (sid == null || activeSidFor(docId) === sid);
}

/**
 * 所在页上下文的锚点文本：
 * 追问 → 用上一轮原文定位到那段附近；明说页码 / 当前屏幕页 → 给整页（不拿别的页的选区硬套）。
 */
function contextAnchorFor(pageRole, reading) {
  if (pageRole === 'topic' && reading?.focus?.kind === 'selection') return reading.focus.text;
  if (pageRole === 'selection') return stripPageLabels(reading?.selection);
  return '';
}

/** 发送范围提示里「上下文」那一段的说法，跟所在页来源一致 */
function contextHintFor(pageRole) {
  if (pageRole === 'topic') return '话题页上下文';
  if (pageRole === 'explicit') return '指定页上下文';
  return '当前页上下文';
}

/** 右栏划来的文字没有 PDF 页，语境只能按当前屏幕页算 */
function scopeContextHintFor(pending) {
  const rightQuote = (pending?.attachments || []).some((a) => a.kind === 'text' && a.from === 'right');
  return rightQuote ? '当前页上下文' : contextHintFor(pending?.pageRole);
}

async function readingReferences(selection) {
  const nums = [...new Set([...String(selection || '').matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))].slice(0, 3);
  if (!nums.length || !viewer?.pdf) return [];
  const results = await Promise.all(nums.map((n) => viewer.findReference(n).catch(() => null)));
  return results.filter(Boolean);
}

/** 被引工作先按完整书目查询原论文摘要；失败后才用普通检索。 */
async function readingSources(reading, references, signal) {
  const query = webQueryFor(reading.question, reading.selection, { reading });
  if (!query) return [];
  if (!references.length) return webSearch(query, signal);
  const sources = await Promise.all(references.map(async (ref) => {
    const lookup = new AbortController();
    const forward = () => lookup.abort();
    signal?.addEventListener('abort', forward, { once: true });
    if (signal?.aborted) lookup.abort();
    const timeout = setTimeout(() => lookup.abort(), 10000);
    try {
      const r = await fetch(`/api/ref-search?q=${encodeURIComponent(ref.text)}&scope=reading`, { signal: lookup.signal });
      if (!r.ok) return [];
      const j = await r.json();
      const matched = filterWebResults(j.title || query, j.results || []).slice(0, 2);
      if (matched.some((s) => s.snippet)) return matched;
      const fallback = await webSearch(j.title || query, lookup.signal);
      return fallback.length ? fallback : matched;
    } catch (e) {
      if (signal?.aborted) throw e;
      return [];
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forward);
    }
  }));
  const flat = sources.flat();
  const unique = flat.filter((s, i) => flat.findIndex((r) => r.url === s.url) === i).slice(0, 6);
  return unique.length ? unique : webSearch(query, signal);
}

/** 明显「只要翻译」的提问：问答里直接给译文 + 最多一句说明，不展开讲解（2026-11-03 用户要求） */
function translateOnlyAsk(text) {
  const q = String(text || '').trim();
  if (!q || q.length > 80) return false;
  if (!/(翻译|译成|译为|译一下|译下|中译英|英译中|转成中文|转成英文|translate|translation)/i.test(q)) return false;
  // 明确同时要求讲解/分析的不算「只翻译」
  if (/(解释|讲解|讲讲|分析|为什么|原理|推导|总结|概括|对比|区别|举例|例子)/.test(q)
    && !/(只|仅|只要).{0,6}(翻译|译文|译成|译为)/.test(q)) return false;
  return true;
}

async function send(retryPending = null) {
  const ta = $('#chatInput');
  if (state.busy) return;
  if (!retryPending && composerMode() === 'translate') {
    const text = String(ta.value || '').trim();
    const shots = state.attachments.filter((a) => a.kind === 'image');
    if (!text && !shots.length) return;
    if (text.length > 20000) { toast('最多翻译 20,000 字', 'err', 2400); return; }
    const lang = $('#translateTargetLang')?.value === 'English' ? 'English' : '中文';
    if (!ensureReady()) return;
    ta.value = '';
    ta.style.height = 'auto';
    // 截图先取下来：文字和截图都从这一份附件走，发送后输入框清空（和问答一致，用户 m05190）
    if (shots.length) takeAttachments();
    if (text) await doTranslateText({ text, targetLang: lang });
    for (const a of shots) {
      await doTranslateShot({
        shot: { dataUrl: a.dataUrl, width: a.w || 0, height: a.h || 0 },
        page: a.page || null,
        label: a.label || '截图',
      });
    }
    if (text && !state.sessionEntries.some((e) => e?.retry?.kind === 'translate-text' && e.retry.text === text)) {
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  let pending = retryPending;
  // 手动「重新生成」= 这次按完整阅读流程重查，不再用轻量直答（否则会把上一轮的猜测又念一遍）
  if (pending) pending.forceFull = true;
  if (!pending && state.doc && state.viewerDocId !== state.doc.docId) {
    flashHint('论文正在打开，请稍候');
    return;
  }
  if (!pending && !ta.value.trim() && !state.attachments.length) return;
  if (pending && pending.docId !== (state.doc?.docId || null)) {
    flashHint('这条请求属于另一篇论文，请切回原论文后重试');
    return;
  }
  if (!ensureReady()) return;
  // 会话选择卡片（用户拍板 B）：不选会话直接输入发送 = 自动开一个新会话，再发这条消息
  if (!pending && sessionsIsEntryMode()) {
    const ok = await sessionsLeaveEntryForNewSession();
    if (!ok) return;
  }

  if (!pending) {
    const inputValue = ta.value;
    const q = inputValue.trim();
    const attachments = state.attachments.slice();
    if (!q && !attachments.length) return;
    const quotes = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image');
    const quoteText = quotes.map((a) => (a.page ? `[第${a.page}页] ` : '') + a.text).join('\n\n');
    // 右栏回答 / 译文里划来的文字不是 PDF 原文：不挂页码，也别让模型当成某页原文去对照页图
    const selectionFromRight = quotes.some((a) => a.from === 'right');
    // 「当前页」按屏幕实际显示区域现算（不受滚动节流影响）；附件里的页码优先。
    const screenPage = state.doc && viewer ? (viewer.currentVisiblePage?.() ?? viewer.current ?? null) : null;
    const attachmentPage = quotes[0]?.page || images[0]?.page || null;
    // 没写文字问题、只发来截图时，提示词也不能写死成「请识别并解释」：
    // 交给模型在心里判断截图是什么、读者此刻最需要什么，再决定怎么回（识别/解释/翻译/指出对不上）；
    // 但不要把这些判断过程写出来（用户 m10163：回答开头「截图是什么：…」整段描述没必要出现）。
    // 并且以截图本身为中心，不许顺手扩写成整篇论文（用户实测：只截了一个单词，却回了整讲讲义）。
    const question = q || (images.length
      ? `（读者没有写文字问题，只发来 ${images.length} 张截图。）这次以截图本身为中心回答：先在心里判断截图里实际是什么（插图 / 表格 / 公式 / 算法 / 正文文字 / 手写等），`
        + '再判断读者此刻最需要什么——识读原文、解释含义、翻译，或者说明这一小块在上下文里起什么作用；然后直接给出最有用的回答。'
        + '不要用「截图是什么」「图片里是…」「这一小块位于第 N 页…」这类开场白描述截图本身、版面或位置（判断是内部步骤），除非读者问的就是「这是什么」；直接进入内容。'
        + '不要主动扩写到整篇论文，不要套固定栏目，不要补造截图里看不见的内容；只有截图确实离不开上下文时，才简要引用所在页的一两句话。'
      : '请解释我加进来的这段内容。');
    const history = snapshotHistory(state.history);
    const selectionSource = selectionFromRight ? 'right' : '';
    const reading = resolveReadingRequest({ question, selection: quoteText, selectionSource,
      page: quotes.length ? (selectionFromRight ? null : attachmentPage) : screenPage, history });
    // 这次「所在页」：附件选区页 > 问题里明说的页码 > 追问沿用话题页 > 当前屏幕页。
    // 追问不再被屏幕页顶掉，否则模型会把读者刚滚到的那页当成新话题（上下文跟着屏幕跑）。
    const place = resolvePageRole({ question, reading, screenPage, attachmentPage, numPages: viewer?.numPages });
    const firstPage = place.page || reading.page || null;
    // 只有「问题」对象的页可以补成所在页；选区对象的页必须保持原样（右栏选区甚至必须为 null，
    // 否则下一轮追问会把它当「第 N 页原文」去对照页图）。
    if (reading.focus && reading.focus.kind === 'question') {
      reading.focus = { ...reading.focus, page: firstPage };
    }
    reading.page = firstPage || reading.page;
    pending = {
      inputValue, question, attachments, quoteText, firstPage, pageRole: place.role, reading, screenPage, selectionSource,
      docId: state.doc?.docId || null,
      docTitle: state.doc?.name || '',
      history, openSeq: state.openSeq, sid: activeSidFor(state.doc?.docId),
      // 本次发送按发送框当前范围决定（四选项里选的那个），不再直接读设置页偏好
      useFullText: SCOPE_RANGES[currentRange()].full,
      useWeb: SCOPE_RANGES[currentRange()].web,
      scopeRange: currentRange(),
    };
    // 截图附件单独存：点发送才上传（只放进输入框又删掉的草稿不会产生服务端文件）。
    // 上传是并行的、本机 HTTP，几毫秒级；返回的 id 记在图片附件对象上（im.ref），
    // 之后写进会话的是 id 引用而不是 base64，恢复会话时再按 id 取回。
    const unuploaded = images.filter((im) => im.dataUrl && !validAttachmentId(im.ref));
    if (unuploaded.length) {
      pending.uploadShots = Promise.all(unuploaded.map(async (im) => {
        const ref = await uploadAttachment(im.dataUrl, pending.docId, pending.sid);
        if (!ref) return null;
        im.ref = ref;                 // 同一个对象也在 pending.attachments 里，重试/失败回填都能复用
        return shotRefOf(im);
      })).then((rows) => rows.filter(Boolean));
    }
    // 提交后立即清空输入框；问题已经写入右侧会话记录，等待模型返回时不再把旧问题留在编辑区。
    ta.value = '';
    ta.style.height = 'auto';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 这条待发记录的范围固定下来：重试 / 停止后恢复都复用它，不会被之后改的范围串掉
    pending.scope = SCOPE_RANGES[currentRange()].short;
    // 同一条待发问题在失败或停止后重试时复用这两行，不再追加用户消息。
    // 没写文字问题时不要把给模型的判断指令当成「用户说的话」显示到问答区（用户会以为那是自己发的提示词）。
    pending.userEntry = addEntry({
      block: 'chat', kind: 'user', text: pending.inputValue.trim() ? question : '', quote: reading.selection,
      thumbs: images.map((im) => im.dataUrl),
    });
    pending.entry = addEntry({
      block: 'chat', tag: 'answer', page: firstPage,
      retry: {
        kind: 'chat', docId: pending.docId, docTitle: pending.docTitle,
        inputValue: pending.inputValue, question: pending.question, quoteText: pending.quoteText,
        firstPage: pending.firstPage, pageRole: pending.pageRole, attachments: pending.attachments,
        selectionSource: pending.selectionSource || '',
        useFullText: pending.useFullText, useWeb: pending.useWeb,
        scopeRange: pending.scopeRange,
        reading, history,
      },
    });
    // 回答存笔记时标题默认用用户的问题（会话恢复时另有一处从历史里回填）
    if (pending.entry) {
      pending.entry.root.__question = pending.question || '';
    }
  } else {
    pending.entry.body.replaceChildren();
    pending.entry.acts.replaceChildren();
    pending.entry.acts.classList.add('hidden');
    pending.entry.root.classList.remove('err', 'error');
    pending.entry.root.querySelectorAll('.entry-meta, .source-details, .src-list, .agent-steps').forEach((node) => node.remove());
    const record = pending.entry.root.__sessionRecord;
    if (record) { record.text = ''; record.meta = ''; record.status = 'pending'; }
  }

  const ctl = makeController();
  if (!ctl) return;
  // 「我叫 Cyan，请记住」这类明确要求：发送当时就确定性记住，不依赖回答成功或模型提取
  rememberExplicitIdentity(pending.question, {
    docId: pending.docId || '', paper: pending.docTitle || '', capability: 'chat',
  });
  dropSentAttachments(pending);
  // 这条待发记录的范围固定下来：state 的两个标记跟着它走（重试时 pending 原样复用，不会串范围）
  applyRangeForSend(pending.scopeRange || currentRange());
  const images = pending.attachments.filter((a) => a.kind === 'image');
  // 只发了截图、没写问题：这次以截图为中心，不主动把整篇论文/采样页图塞进来（用户口径：截一个单词就答这个单词）。
  const shotOnly = !pending.inputValue.trim() && images.length > 0
    && !pending.attachments.some((a) => a.kind === 'text');
  const baseScope = sendScopeText({
    attachments: pending.attachments,
    history: pending.history,
    useFullText: pending.useFullText && !shotOnly,
    useWeb: pending.useWeb,
    query: pending.inputValue,
    docId: pending.docId,
    contextHint: scopeContextHintFor(pending),
  });
  pending.scope = baseScope;
  state.activeSendScope = baseScope;
  setBusy(true, '0s');
  const target = streamTarget(pending.entry.body);
  let received = '';
  let sources = [];
  let meta = '';
  let docCtx = null;
  try {
    /**
     * 截图附件单独存：等上传完再发请求（本机 HTTP，几毫秒），把返回的 id 写进这条用户消息
     * 的会话记录（shots[]）。会话 JSON 因此只增加几十字节的 id 引用，重开论文时按 id 取回原图。
     * 上传失败照发 —— 只是这条消息没有可恢复的图（老提示兜底），不挡提问。
     */
    if (pending.uploadShots) {
      try { await pending.uploadShots; } catch { /* 上传失败不挡提问 */ }
    }
    if (pending.userEntry) {
      const shots = pending.attachments.filter((a) => a.kind === 'image').map(shotRefOf).filter(Boolean);
      const rec = pending.userEntry.root?.__sessionRecord;
      if (rec) {
        if (shots.length) rec.shots = shots;
        else delete rec.shots;
      }
      scheduleSessionSave();     // 让 shots 引用跟着会话一起落盘
    }
    const reading = pending.reading || resolveReadingRequest({ question: pending.question,
      selection: pending.quoteText, page: pending.firstPage, history: pending.history });
    // 重试时也复用第一次发送时定下的「所在页」与话题页，不受之后滚动影响
    if (pending.firstPage) reading.page = pending.firstPage;
    pending.reading = reading;
    // 扫描件：先判定页型（命中缓存就不花时间）；扫描件无论范围如何都要带页面图片。
    const scanProfile = pending.docId ? await startDocProfileScan(pending.docId).catch(() => null) : null;
    if (!readingRequestCurrent(pending)) return;
    const scannedDoc = !!scanProfile?.scanned;
    pending.scanned = scannedDoc;
    // 追问直答：明显接着上一轮的短问题，不再重新翻页/看页图/跑多轮工具（判定见 planFollowUpDirect）
    const followPlan = planFollowUpDirect(pending, { images, scannedDoc });
    const followDirect = followPlan.direct;
    pending.followUpDirect = followDirect;
    lastChatAnswerDirect = followDirect;
    if (followDirect) setHint('接着上一段直接回答…');
    // 没有选区时也带所在页上下文：
    // · 追问 → 上一轮话题所在页（让模型顺着上下说，而不是被屏幕滚到的页带跑）；
    // · 明说「第 N 页」→ 那一页；· 其它/「这一页/这里」→ 当前屏幕页。扫描件没有文本层，改成带页图。
    const quotes = pending.attachments.filter((a) => a.kind === 'text');
    const anchor = contextAnchorFor(pending.pageRole, reading);
    const contextParts = scannedDoc ? [] : ((pending.useFullText && !shotOnly && !followDirect) ? [] : (quotes.length ? await Promise.all(quotes.slice(0, 6).map(async (a) => {
      // 右栏划来的文字不是 PDF 原文，定位不到「原文附近」；给所在页整页当语境
      const nearby = await viewer.getContextAround(a.page || pending.firstPage,
        a.from === 'right' ? '' : a.text);
      return nearby ? `[第${a.page || pending.firstPage}页]\n${nearby}` : '';
    })) : [pending.firstPage && pending.docId
      ? await viewer.getContextAround(pending.firstPage, anchor) : '']));
    const context = [...new Set(contextParts.filter(Boolean))].join('\n\n');
    const references = await readingReferences(reading.selection);
    if (!readingRequestCurrent(pending)) return;
    if (ctl.signal.aborted) throw new DOMException('已停止', 'AbortError');
    pending.scope = sendScopeText({
      attachments: pending.attachments, history: pending.history,
      useFullText: pending.useFullText && !shotOnly && !followDirect, useWeb: pending.useWeb,
      query: pending.inputValue, docId: pending.docId, contextIncluded: !!context, scanned: scannedDoc,
      contextHint: scopeContextHintFor(pending),
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    // 联网是允许查找材料；短追问先确定对象，纠正消息和纯问号不会拿去检索。
    // 追问直答这类短问题也不联网（省一次搜索往返；需要查资料的问题一般会点名要查/最新/出处）。
    if (pending.useWeb && !followDirect && (!images.length || pending.inputValue.trim() || reading.selection)
      && webQueryFor(pending.question, reading.selection, { reading })) {
      setHint('正在联网搜索…');
      try {
        sources = await readingSources(reading, references, ctl.signal);
        setHint(sources.length ? `搜到 ${sources.length} 条来源` : '没搜到相关结果，只用论文内容回答');
      } catch (e) {
        if (isAbort(e)) throw e;
        sources = [];
        setHint('联网搜索不可用，这次只用论文内容回答');
      }
    }

    // ② P2.5：让 AI 自己决定读哪些页。成功就用它读到的页做材料（白名单=读过的页），
    // 失败（模型不支持 tools / 超时 / 任何异常）静默回退到下面的 P1.5 预装路径。
    // 用户口径（2026-11-02）：带截图提问时也要能自己继续查页（截图是附加材料，不是禁止工具的理由）；
    // 只有「只发截图没写问题」（shotOnly）才不启用，避免模型把截图当成唯一依据乱翻。
    const agentAllowed = agentReadEnabled() && !shotOnly && !followDirect
      && !!pending.docId && !!state.doc && !!viewer?.pdf;
    let agentRun = null;
    let agentProgress = null;
    if (agentAllowed) {
      setHint('AI 正在自己找材料…');
      // 过程列表：把「正在思考 / 检索 / 读第 N 页 / 命中」一条条列在回答上方（用户要求像 agent 工具一样可见）
      agentProgress = createAgentProgress(pending.entry);
      agentRun = await runAgentReadPath({
        pending, reading, context, references, sources,
        images, scannedDoc,
        signal: ctl.signal,
        onStep: (ev) => agentProgress?.onStep(ev),
        baseMaterials: {
          question: pending.question, selection: reading.selection,
          selectionSource: pending.selectionSource || (reading.focus?.source === 'right' ? 'right' : ''),
          context, page: pending.firstPage, pageRole: pending.pageRole, docTitle: pending.docTitle,
          history: pending.history, reading, references, pageImages: [], screenshotCount: images.length,
          profileBlock: askProfileBlock(state.docText || context || '', pending.question, { docId: pending.docId }),
          teachingBlock: teachingProgressBlock(),
        },
      });
      setHint('');
      // 静默回退：模型不支持工具 / 超时 / 出错时，把过程列表整块撤掉，用户只看到正常回答
      if (agentRun) agentProgress?.finish();
      else agentProgress?.remove();
      if (!readingRequestCurrent(pending)) return;
    }
    // ② 上下文。扫描件：页面图片（+ 整篇类问题的采样页）；普通论文：整篇全文 / 索引 + 相关段落。
    // 只发截图（没写问题）时不吃「整篇」范围：截图本身就是材料，塞整篇只会让模型顺势扩写整个讲义。
    // Agent 成功时不再预装文本材料（它自己读过的页就是材料）；但扫描件仍带上页图：
    // 页型是扫描件时 Agent 工具可能只读到空文本，保留 P1.5 的页图材料才不至于退步（跨论文读取也照样可用）。
    // 追问直答：扫描件如果不涉及图表，也跳过页图材料；普通论文不再预装整篇全文/索引。
    const wantScanImages = !(followDirect && !followPlan.keepVisual);
    if (scannedDoc && wantScanImages) {
      try {
        docCtx = await buildDocContext(pending.question, reading.selection || reading.focus.text, {
          page: pending.firstPage || reading.page,
          whole: pending.useFullText && !shotOnly,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        docCtx = null;
        setHint('读取扫描页失败，这次只带问题本身');
      }
    } else if (!agentRun && !followDirect && pending.useFullText && !shotOnly && pending.docId) {
      try {
        docCtx = await buildDocContext(pending.question, reading.selection || reading.focus.text);
      } catch (e) {
        if (isAbort(e)) throw e;
        docCtx = null;
        setHint('读取整篇论文失败，这次只带选中内容和当前页上下文');
      }
    }
    pending.scope = sendScopeText({
      attachments: pending.attachments,
      history: pending.history,
      useFullText: pending.useFullText && !shotOnly && !followDirect,
      useWeb: pending.useWeb,
      query: pending.inputValue,
      docId: pending.docId,
      scanned: scannedDoc && wantScanImages,
      scanPageCount: docCtx?.pageImages?.length || 0,
      fullMode: (pending.useFullText && !shotOnly && !followDirect)
        ? (scannedDoc ? (docCtx?.mode || 'scan') : (docCtx?.mode || 'unavailable'))
        : null,
      contextIncluded: !!context,
      contextHint: scopeContextHintFor(pending),
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    if (!readingRequestCurrent(pending)) return;
    if (ctl.signal.aborted) throw new DOMException('已停止', 'AbortError');
    // 记忆块：学习画像 + 用户手写长期记忆 + 本篇之前的讨论 + 本次会话滚动摘要。
    // 教学进度（「带我一步步读」）也在这里带上，避免自由追问时模型擅自推进下一步。
    const profileForAsk = askProfileBlock(state.docText || context || '', pending.question,
      { docId: pending.docId });
    // P1.5：可用页码白名单 + 本轮要求（近因指令）+ 本次依据回执，全部由程序算好，不靠模型猜。
    const citationMat = citationMaterialsFor({
      docCtx, context, references, scanned: scannedDoc, pending, sources, images, pageRole: pending.pageRole,
    });
    activeCitationPlan = null;   // 新回答开始：先不套上一条的校验结果
    if (agentRun) {
      // 白名单 = 初始材料里的页 ∪ AI 自己读过的页；依据回执也换成「AI 自行读取」
      citationMat.availablePages = [...new Set([...citationMat.availablePages, ...agentRun.pages])]
        .filter(Number.isInteger).sort((a, b) => a - b);
      citationMat.basis = agentRun.basis;
    }
    const messages = agentRun ? agentRun.messages : askMessages({
      question: pending.question,
      selection: reading.selection,
      // 右栏文字：附件里的 from=right，或追问沿用的对象本身来自右栏
      selectionSource: pending.selectionSource || (reading.focus?.source === 'right' ? 'right' : ''),
      context,
      page: pending.firstPage,
      pageRole: pending.pageRole,
      docTitle: pending.docTitle,
      fullText: docCtx?.text,
      webResults: sources,
      history: pending.history,
      reading, references,
      pageImages: docCtx?.pageImages || [],
      screenshotCount: images.length,
      profileBlock: profileForAsk,
      teachingBlock: teachingProgressBlock(),
      availablePages: citationMat.availablePages,
      scopeLabel: scopeLabelFor(pending, { scanned: scannedDoc, images }),
      objectLabel: objectLabelFor(pending, reading),
      // 明显「只要翻译」→ 只给译文 + 最多一句说明（见 prompts/capabilities/qa.js）
      translateIntent: translateOnlyAsk(pending.question),
    });
    // 追问直答：给模型一条近因指令，明确「这是接着上文说」，并说明这次没有重新翻页。
    if (followDirect) {
      citationMat.basis = '本次依据：接着上一段对话（没有重新翻页读论文）';
      const sys = messages[0];
      if (sys && sys.role === 'system') {
        sys.content += '\n\n【追问直答】这是接着上一轮回答的追问：优先沿用对话里已经讲过的内容继续说，篇幅可以短一些。'
          + '注意：这一轮没有重新翻页、没有联网；但绝对不要说「我没有联网通道」「我读不了页图」「没有这个功能」——'
          + '完整阅读模式下你可以自己翻页、读其它页/其它论文、联网检索、看页图。'
          + '如果读者要求核对原文、翻到别的页、查资料，或者你发现当前上下文不足以确认，就直接说明：'
          + '「这轮我只依据上文回答；需要我翻页/联网核对的话说一句『查一下』或点『重新生成』，我会用完整阅读流程去查。」'
          + '不要编造页码或原文，也不要反过来让读者自己去贴材料。'
          + (followPlan.keepVisual
            ? '这次只附了相关页图；需要核对哪张图时用页面上的图。'
            : '较真核对、找原文一律交给完整阅读流程（读者说「查一下」即触发）。');
      }
    }
    // 图片有两种：用户自己加的截图 + 扫描件的页面上下文；同一条 user 消息里一起发。
    // P2.5：Agent 用 read_page_image 要求的页也要附上（视觉模型才看得到）。
    let pageImages = docCtx?.pageImages || [];
    // 跨论文页图 / read_scan_page 拿到的页图（dataURL 已渲染好，带 label 标明来源）
    // 当前论文的页可能已经作为「扫描件上下文」在 pageImages 里（例如问的就是这一页）：同一页不要附第二遍。
    const basePages = new Set(pageImages
      .filter((im) => Number.isInteger(im.page) && !String(im.label || '').includes('《'))
      .map((im) => im.page));
    if (agentRun?.extraImages?.length) {
      const fresh = agentRun.extraImages.filter((im) => !(Number.isInteger(im.page) && !String(im.label || '').includes('《') && basePages.has(im.page)));
      pageImages = [...pageImages, ...fresh.slice(0, 4)];
    }
    if (agentRun?.imagePages?.length) {
      try {
        // 同一页已经在 extraImages 里（read_scan_page 与 read_page_image 被同时调用）就不再渲染第二遍
        const attached = new Set(pageImages.map((im) => im.page).filter((n) => Number.isInteger(n)));
        const extraPages = agentRun.imagePages.filter((p) => !attached.has(p));
        if (extraPages.length) pageImages = [...pageImages, ...await renderScanPages(extraPages.slice(0, 5))];
      } catch { /* 取页图失败不影响回答 */ }
    }
    if (images.length || pageImages.length) {
      const last = messages[messages.length - 1];
      // 多图必须显式建立「标签 → 紧随其后的图片」一一对应。旧做法先把所有标签
      // 合并成一段、再把图片连着追加，导致多张图时来源错配（例如把 Stable 当成单摆）。
      const parts = [{
        type: 'text',
        text: `${last.content}\n\n【多图对应规则】本条消息里的每张图片都是独立材料。按下面编号逐张查看，只能把紧邻编号对应的图作为该项证据；不要把一张图中的文字、物体、页码或结论套用到另一张图。用户截图与论文页图是不同来源，回答时分开说明。\n\n【强制逐图核对】回答前在内部逐张核对图像内容与紧邻标签，先判断图 1 的内容，再判断图 2，以此类推；如果用户问两图差异，只能比较对应序号下实际看到的内容。若某张图不可读取，明确指出具体序号，不要拿另一张图代替。不要输出核对过程，只给结论。`,
      }];
      images.forEach((im, i) => {
        const pageLabel = im.page ? `；截取自第 ${im.page} 页` : '';
        const label = String(im.label || '用户添加的截图').replace(/[\r\n]/g, ' ').slice(0, 100);
        parts.push({ type: 'text', text: `【用户截图 ${i + 1}/${images.length}${pageLabel}${label ? `；${label}` : ''}】下一张图片是此截图。` });
        parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      });
      pageImages.forEach((im, i) => {
        const label = String(im.label || (im.page ? `第 ${im.page} 页` : `论文页图 ${i + 1}`)).replace(/[\r\n]/g, ' ').slice(0, 120);
        parts.push({ type: 'text', text: `【论文上下文页图 ${i + 1}/${pageImages.length}；${label}】下一张图片是论文页面上下文，不是用户截图。` });
        parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      });
      last.content = parts;
    }
    // 右栏只呈现回答正文与来源，不显示全文字数、联网条数等内部统计。
    meta = '';
    warnIfNoVisionModel(images.length > 0 || pageImages.length > 0);

    setHint('');
    // P2.5：Agent 最后一轮已经给出完整回答时直接采用，不再重复一次流式请求（省一次 LLM 往返）。
    // 但如果这次有**页图材料**（扫描件页图 / Agent 读的页图 / 跨论文页图），图片只能附在下一个请求里发出去，
    // 直接采用 directContent 会让模型根本没看到图 —— 这种情况必须再走一次最终流式请求。
    const directAnswer = String(agentRun?.directContent || '');
    const mustStreamForImages = !!directAnswer && (pageImages.length > 0 || images.length > 0);
    const rawFull = directAnswer && !mustStreamForImages
      ? directAnswer
      : await chat({
        messages,
        signal: ctl.signal,
        onDelta: (piece, all) => { received = all; target.push(all); },
        onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
      });
    const full = stripAgentMarkup(rawFull);
    if (!readingRequestCurrent(pending)) return;
    // 引用核验必须在最终渲染之前完成：不合格的片段降级成纯页码，编造的页码直接不渲染。
    await auditAnswerCitations(full, { availablePages: citationMat.availablePages, scanned: scannedDoc });
    if (!readingRequestCurrent(pending)) return;
    target.done(full);
    state.history = snapshotHistory([...state.history, ...readingTurn(reading, full)]);
    scheduleSessionSummary();
    finishEntry(pending.entry, full, {
      page: pending.firstPage, sources: citedSources(full, sources), meta, status: 'complete', basis: citationMat.basis,
      // 用户要求：正常问答的回答下面也要能「重新生成」（复用这条 pending，原地重跑，不新加一轮问答）
      retryLabel: '重新生成', onRetry: () => send(pending),
    });
    scheduleMemoryExtraction({ question: pending.inputValue, answer: full, history: pending.history,
      topic: reading.selection || reading.focus?.text || '',
      source: { docId: pending.docId || '', paper: pending.docTitle || '', capability: 'chat' } });
    // 附件在发送那一刻就已从输入区清掉（dropSentAttachments），成功时无需再处理。
    scheduleSessionSave();
  } catch (e) {
    if (!readingRequestCurrent(pending)) return;
    if (isAbort(e)) {
      // 保留已经收到的回答；状态放在回答下方，绝不覆盖回答正文。
      const kept = stripAgentMarkup(received);
      target.done(kept);
      finishEntry(pending.entry, kept, {
        page: pending.firstPage, sources: citedSources(kept, sources), meta, status: 'stopped', basis: citationMat?.basis, onRetry: () => send(pending),
      });
    } else {
      target.fail(errText(e));
      addFailureRetry(pending.entry, errText(e), () => send(pending));
      // 失败时把这次请求的附件放回输入区：截图不丢，改完问题可以直接再发。
      restoreSentAttachments(pending);
    }
  } finally {
    setHint('');
    if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
    // 「整篇」是单次发送范围：无论成功、失败还是用户停止，本次结束后复位。
    // 失败 / 停止的重试闭包仍持有 pending.useFullText，因此不会丢掉原范围。
    if (pending.useFullText) {
      state.useFullText = false;
      renderScopeMenu();
    }
  }
}

/* 拖框选区域；把鼠标拖出正文区上下边缘会自动滚动，于是可以一路框到下一页 ——
   因为图是从 PDF 重新渲染的（不是截屏），超出视口的部分也能完整拿到。 */

function initRegion() {
  const overlay = $('#regionOverlay');
  const rect = $('#regionRect');
  const hint = $('#regionHint');
  const viewerEl = $('#viewer');
  let startX = 0;
  let startDocY = 0;
  let dragging = false;
  let lastPointer = null;
  let autoTimer = null;
  /** 框选目标：chat = 加进问答附件；translate = 截图翻译（2026-11-03） */
  let regionIntent = 'chat';

  const stop = () => {
    overlay.classList.add('hidden');
    hint.classList.add('hidden');
    rect.style.display = 'none';
    // `#regionBtn` 已从顶栏删除，所以这里两处都要可选链：
    // 少了它，startRegion() 会在 classList.add 上抛错 → 框选遮罩根本不会出现。
    $('#regionBtn')?.classList.remove('on');
    $('#clipBtn')?.classList.remove('on');
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    document.body.classList.remove('row-dragging');
    dragging = false;
    lastPointer = null;
    startDocY = 0;
  };
  state.stopRegion = stop;

  /** 进入 / 退出截图模式。输入框边的 ✂ 默认加进问答；译文面板的「截图翻译」传 'translate' */
  const startRegion = (intent) => {
    if (!overlay.classList.contains('hidden')) { stop(); return; }
    if (!viewer?.pdf) { toast('先打开一篇 PDF', 'err'); return; }
    regionIntent = intent === 'translate' ? 'translate' : 'chat';
    state.regionIntent = regionIntent;
    overlay.classList.remove('hidden');
    hint.classList.remove('hidden');
    $('#regionBtn')?.classList.add('on');
    $('#clipBtn')?.classList.add('on');
    hint.innerHTML = regionIntent === 'translate'
      ? '拖动框住要翻译的区域 · 拖到上下边缘会自动滚动（长截图）· <kbd>Esc</kbd> 取消'
      : '拖动框住要加进对话的区域 · 拖到上下边缘会自动滚动（长截图）· <kbd>Esc</kbd> 取消';
  };
  state.startRegion = startRegion;

  const docYOf = (clientY) => {
    const vr = viewerEl.getBoundingClientRect();
    return viewerEl.scrollTop + clientY - vr.top;
  };

  const draw = (cx, cy) => {
    const vr = viewerEl.getBoundingClientRect();
    const startScreenY = startDocY - viewerEl.scrollTop + vr.top;
    const x1 = Math.min(startX, cx);
    const x2 = Math.max(startX, cx);
    const y1 = Math.min(startScreenY, cy);
    const y2 = Math.max(startScreenY, cy);
    Object.assign(rect.style, {
      left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`,
    });
  };

  // 拖到上下边缘就自动滚动，越框越长
  const maybeAutoScroll = (clientY) => {
    const vr = viewerEl.getBoundingClientRect();
    let dir = 0;
    if (clientY > vr.bottom - 46) dir = 1;
    else if (clientY < vr.top + 46) dir = -1;
    if (!dir) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      return;
    }
    if (autoTimer) return;
    autoTimer = setInterval(() => {
      const before = viewerEl.scrollTop;
      viewerEl.scrollTop = before + dir * 22;
      if (viewerEl.scrollTop === before) return;      // 到头了
      if (lastPointer) draw(lastPointer.x, lastPointer.y);
    }, 16);
  };

  // #regionBtn 已从顶栏删除：截图入口改到问答栏的「＋」（#clipBtn）。
  // 框选能力本身保留（快捷键 R 与 #clipBtn 都走 startRegion），所以这里用可选链。
  const regionBtn = $('#regionBtn');
  if (regionBtn) regionBtn.onclick = () => startRegion();

  overlay.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startDocY = docYOf(e.clientY);
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    rect.style.display = 'block';
    draw(e.clientX, e.clientY);
    document.body.classList.add('row-dragging');
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    draw(e.clientX, e.clientY);
    maybeAutoScroll(e.clientY);
  });

  overlay.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    const cx = e.clientX;
    const endDocY = docYOf(e.clientY);
    const topDoc = Math.min(startDocY, endDocY);
    const bottomDoc = Math.max(startDocY, endDocY);
    const leftVp = Math.min(startX, cx);
    const rightVp = Math.max(startX, cx);
    stop();
    if (rightVp - leftVp < 14 || bottomDoc - topDoc < 14) return;
    if (regionIntent === 'translate') await captureToTranslate(topDoc, bottomDoc, leftVp, rightVp);
    else await captureToChat(topDoc, bottomDoc, leftVp, rightVp);
  });
}

/** 把滚动坐标落到具体某一页上 */
function locateDoc(docY) {
  const pages = viewer.numPages;
  for (let i = 1; i <= pages; i++) {
    const o = viewer.offsets[i];
    const h = viewer.heights[i];
    if (o === undefined) continue;
    if (docY >= o && docY < o + h) return { page: i, y: docY - o };
  }
  // 落在页间空隙或末尾：贴到最近的一页
  let best = 1;
  for (let i = 1; i <= pages; i++) {
    if (viewer.offsets[i] !== undefined && viewer.offsets[i] <= docY) best = i;
  }
  const o = viewer.offsets[best] ?? 0;
  const h = viewer.heights[best] ?? 0;
  return { page: best, y: Math.max(0, Math.min(h, docY - o)) };
}

/** 框选区域 → 截图；不碰 API Key、不决定去哪个面板，返回 { shot, page, label } 或 null */
async function captureRegionShot(topDoc, bottomDoc, leftVp, rightVp) {
  const a = locateDoc(topDoc);
  const b = locateDoc(bottomDoc);
  const pageEl = viewer.pageEls[a.page];
  if (!pageEl) return null;
  const pr = pageEl.getBoundingClientRect();
  const x = clamp(leftVp - pr.left, 0, pr.width);
  const w = clamp(rightVp - pr.left, 0, pr.width) - x;
  if (w < 8) { toast('选框太窄', 'err'); return null; }

  setBusy(true, '截图中…');
  try {
    let shot;
    if (a.page === b.page) {
      shot = await viewer.captureRegion(a.page, { x, y: a.y, w, h: b.y - a.y });
    } else {
      shot = await viewer.captureRange({
        pageStart: a.page, pageEnd: b.page, x, w, yStart: a.y, yEnd: b.y,
      });
    }
    const label = a.page === b.page ? `截图 p.${a.page}` : `长截图 p.${a.page}–${b.page}`;
    return { shot, page: a.page, label };
  } catch (e) {
    toast(`截图失败：${e.message}`, 'err', 4000);
    return null;
  } finally {
    setBusy(false);
  }
}

async function captureToChat(topDoc, bottomDoc, leftVp, rightVp) {
  if (state.busy) return;
  // 注意：截图本身不需要 API Key（图只是先放进附件区），
  // 所以这里绝不能调 ensureReady()，否则没配密钥时截图会被静默拦掉
  const captured = await captureRegionShot(topDoc, bottomDoc, leftVp, rightVp);
  if (!captured) return;
  addImageToChat(captured.shot, captured.page, captured.label, { allowBusy: true });
}

/** 截图翻译：截图先进下方输入框（和问答一样），再按 Enter / 发送翻译图中文字（2026-11-03 用户 m05190） */
async function captureToTranslate(topDoc, bottomDoc, leftVp, rightVp) {
  if (state.busy) return;
  const captured = await captureRegionShot(topDoc, bottomDoc, leftVp, rightVp);
  if (!captured) return;
  addImageToChat(captured.shot, captured.page, captured.label, { allowBusy: true });
  flashHint('截图已放进输入框 · 按 Enter 翻译截图，可同时输入要翻译的文字');
}


let searchToken = 0;
let searchDebounced = null;

function cancelSearch({ clearInput = false, close = false, focus = false } = {}) {
  searchToken++;
  searchDebounced?.cancel?.();
  state.search = { hits: [], idx: 0, query: '' };
  viewer?.setActiveQuery('');
  const results = $('#searchResults');
  if (results) { results.replaceChildren(); results.classList.add('hidden'); }
  const count = $('#searchCount');
  if (count) count.textContent = '';
  if (clearInput) $('#searchInput').value = '';
  if (close) $('#searchBar').classList.add('hidden');
  if (focus) viewer?.container.focus();
}

function initSearch() {
  const bar = $('#searchBar');
  const input = $('#searchInput');
  $('#searchBtn').onclick = () => {
    if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); input.focus(); }
    else cancelSearch({ clearInput: true, close: true, focus: true });
  };
  $('#searchClose').onclick = () => cancelSearch({ clearInput: true, close: true, focus: true });
  $('#searchPrev').onclick = () => stepHit(-1);
  $('#searchNext').onclick = () => stepHit(1);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (state.search.query !== q || !state.search.hits.length) {
        searchDebounced?.cancel?.();
        runSearch(q);
      } else stepHit(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('#searchClose').click(); }
  });
  searchDebounced = debounce((q) => runSearch(q), 260);
  input.addEventListener('input', () => {
    searchToken++;
    state.search = { hits: [], idx: 0, query: '' };
    viewer?.setActiveQuery('');
    $('#searchResults').replaceChildren();
    $('#searchResults').classList.add('hidden');
    const q = input.value.trim();
    const ready = !!viewer?.pdf && state.viewerDocId === state.doc?.docId;
    $('#searchCount').textContent = q ? (ready ? '搜索中…' : (state.doc ? '论文正在打开' : '先打开一篇论文')) : '';
    if (q && ready) searchDebounced(q);
  });
}

async function runSearch(q) {
  const count = $('#searchCount');
  q = String(q || '').trim();
  const my = ++searchToken;
  viewer?.setActiveQuery(q);
  const ready = !!viewer?.pdf && state.viewerDocId === state.doc?.docId;
  if (!q || !ready) {
    count.textContent = q && !ready ? (state.doc ? '论文正在打开' : '先打开一篇论文') : '';
    state.search = { hits: [], idx: 0, query: '' };
    $('#searchResults').replaceChildren();
    $('#searchResults').classList.add('hidden');
    return;
  }
  count.textContent = '搜索中…';
  $('#searchResults').replaceChildren();
  $('#searchResults').classList.add('hidden');
  const docId = state.doc?.docId;
  let result;
  try { result = await viewer.search(q); }
  catch (e) {
    if (my === searchToken && docId === state.doc?.docId) count.textContent = `搜索失败：${e.message}`;
    return;
  }
  // 慢的旧搜索后返回不能覆盖新结果；换文档后的结果直接丢弃
  if (my !== searchToken || result.stale || docId !== state.doc?.docId) return;
  state.search = { hits: result.hits, idx: 0, query: q };
  renderSearchResults();
  if (result.hits.length) await showSearchHit(0, true);
  else count.textContent = '无结果';
}

function renderSearchResults() {
  const results = $('#searchResults');
  const hits = state.search.hits;
  results.replaceChildren();
  results.classList.toggle('hidden', !hits.length);
  hits.forEach((hit, i) => {
    const button = el('button', {
      type: 'button', class: `search-result${i === state.search.idx ? ' current' : ''}`,
      role: 'option', 'aria-selected': i === state.search.idx ? 'true' : 'false',
      onclick: () => showSearchHit(i, true),
    });
    button.append(
      el('span', { class: 'sr-page', text: `p.${hit.page}` }),
      el('span', { class: 'sr-snippet' }, document.createTextNode(hit.before || ''),
        el('mark', { text: hit.match }), document.createTextNode(hit.after || '')),
    );
    results.append(button);
  });
}

function updateSearchCount() {
  const { hits, idx } = state.search;
  const hit = hits[idx];
  if (!hit) return;
  $('#searchCount').textContent = `${idx + 1}/${hits.length} 条 · p.${hit.page}`;
}

async function showSearchHit(index, record = true) {
  const hit = state.search.hits[index];
  if (!hit || !viewer?.pdf || state.viewerDocId !== state.doc?.docId) return;
  state.search.idx = index;
  renderSearchResults();
  updateSearchCount();
  if (record) recordReaderJump();
  const docId = state.doc?.docId;
  const my = searchToken;
  await viewer.gotoHit(hit.page, hit.pageIndex,
    () => my === searchToken && docId === state.doc?.docId && state.search.hits[index] === hit);
  if (docId !== state.doc?.docId) return;
}

function stepHit(dir) {
  const { hits, idx } = state.search;
  if (!hits.length) return;
  showSearchHit((idx + dir + hits.length) % hits.length, true);
}


const ENDPOINT_SHORT = {
  'https://api.deepseek.com/v1': 'api.deepseek.com',
  'https://api.openai.com/v1': 'api.openai.com',
  'https://openrouter.ai/api/v1': 'openrouter.ai',
  'https://api.siliconflow.cn/v1': 'siliconflow.cn',
  'http://127.0.0.1:11434/v1': '本地 Ollama',
};

function fillSettings() {
  const d = Settings.data;
  const profiles = $('#cfgProfile');
  profiles.replaceChildren(...(d.modelProfiles || []).map(p => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.model} · ${p.baseURL} · 配置 ${Number(p.id) + 1}`;
    return option;
  }));
  profiles.value = d.activeProfile || '0';
  $('#cfgModel').value = d.model || '';
  $('#cfgVisionModel').value = d.visionModel || '';
  $('#cfgLongTermMemory').value = d.longTermMemory || '';
  $('#cfgBaseURL').value = d.baseURL || '';
  $('#cfgApiKey').value = '';
  $('#cfgApiKey').placeholder = d.hasApiKey ? '已保存，留空则不改' : 'sk-…';
  updateEndpointNote();
  fillUiSettings();
  fillSessionSettings();
}

function fillUiSettings() {
  const theme = $('#uiTheme');
  if (theme) theme.value = uiStyle.theme;
  const size = $('#uiFontSize');
  if (size) size.value = uiStyle.fontSize;
  const zoom = $('#uiZoomSpeed');
  if (zoom) zoom.value = String(clampZoomSpeed(uiStyle.zoomSpeed));
  // 发送范围两个开关：默认开着，存档里显式关掉才关（`!== false`，缺字段按默认 true）
  const full = $('#cfgUseFullText');
  if (full) full.checked = uiStyle.useFullText !== false;
  const web = $('#cfgUseWeb');
  if (web) web.checked = uiStyle.useWeb !== false;
  // 追问直答开关（默认开，存在 localStorage 的独立 flag 里）
  const follow = $('#cfgFollowUpDirect');
  if (follow) follow.checked = followUpDirectEnabled();
  updateUiRangeLabels();
}

/* 会话设置（设置 → 会话）：这些只影响本机的会话行为，切换/勾选就生效，
   不需要走「保存并测试」。 */
function fillSessionSettings() {
  const scope = $('#settScopeMode');
  if (scope) scope.value = readSessionScopeMode();
  const title = $('#settAiTitle');
  if (title) title.checked = aiTitleEnabled();
  const enter = $('#settOnEnter');
  if (enter) enter.value = sessionsGetEnterMode();
  const hist = $('#settHistoryMode');
  if (hist) hist.value = sessionsGetHistoryMode();
  updateSessionSettingHints();
}

/** 每个选项下面那行「选了之后实际会怎样」：跟着 select/checkbox 即时更新，
 *  把「换论文时是否重来」「打开文件夹才生效」这些容易误解的点直接写出来。 */
function updateSessionSettingHints() {
  const set = (id, text) => {
    const span = document.querySelector(`#${id} span`);
    if (span) span.textContent = text;
  };
  const mode = readSessionScopeMode();
  set('settScopeHint', mode === 'paper'
    ? '每篇论文各接自己那一段对话：换论文会自动恢复那篇论文上次的对话，不会把上一篇的问答带过去，会话头显示这篇论文的会话。想比较几篇论文、让助手带着前文跨论文追问时，临时把这里切到「全局共用」即可。会话记录始终在历史面板里。'
    : mode === 'global'
      ? '所有论文接同一段对话：换论文、换文件夹都能接着上一句问，助手始终带着同一段前文。适合把整个书库当成一段连贯的阅读笔记；想每篇论文互不干扰时切到「按论文」。会话记录始终在历史面板里。'
      : '同一文件夹里的论文接着同一段对话：在这个文件夹里换论文，问的是同一段对话（继续追问、助手能看到前文）。只有打开另一个文件夹时，才按下面「打开文件夹时」执行。适合把一个课题的多篇论文放在一个文件夹、当成一段长讨论。会话记录始终在历史面板里。');
  set('settTitleHint', aiTitleEnabled()
    ? '会话有第一轮完整回答后自动生成一次清晰标题（≤28 字）；手动改名永远优先，已生成过的会话不会再请求模型，断网也不会一直重试。'
    : '不生成 AI 标题：会话头沿用首条问题的摘要，随时可以手动改名（手动改过的标题在任何模式下都优先）。');
  const enter = sessionsGetEnterMode();
  set('settEnterHint', enter === 'resume'
    ? '打开文件夹时自动接上最近一段有内容的会话；超过 7 天或 60 条消息仍会弹选择卡片，避免误开太旧的对话。同一文件夹里换论文不受这里影响，按上面的「换论文时对话怎么接」处理。'
    : enter === 'new'
      ? '每次打开文件夹都新建一个空会话，旧会话留在历史里。同一文件夹里换论文不受这里影响，按上面的「换论文时对话怎么接」接上对应会话。'
      : '打开一个文件夹（或启动应用）时显示选择卡片，由你挑一段继续。同一文件夹里换论文不会重新弹卡片，按上面的「换论文时对话怎么接」自动接上。');
  set('settHistoryHint', sessionsGetHistoryMode() === 'time'
    ? '全部会话按最近活动排成一个列表（今天 / 昨天 / 最近 7 天 / 更早），每个会话后面标出按顺序读过哪些论文。'
    : '按文件夹分组：组头是论文名、路径和会话数，组内是这个文件夹的会话；一个会话读过几篇论文时会标注「还读过 N 篇」。');
}

/** 切换「换论文时对话怎么接」：当前这段对话先按旧归属存盘，再把同一个 sid 接到新归属方式下，
 *  内容复制一份到新位置，旧文件保留作备份，不迁移不删除，避免任何数据丢失。 */
async function applySessionScopeMode(mode) {
  const docId = state.doc?.docId || '';
  const sid = docId ? activeSidFor(docId) : '';
  const prev = readSessionScopeMode();
  const want = mode === 'paper' || mode === 'global' ? mode : 'folder';
  if (prev === want) { updateSessionSettingHints(); return; }
  persistSession.cancel?.();
  // ① 旧归属下先存一次：saveSessionNow 读 scope 键时还是旧模式
  if (docId) { try { await saveSessionNow(); } catch { /* 存不下也继续 */ } }
  // ② 记下旧归属键，再写新模式。新键下的副本要用「完整复制旧文件」而不是重新保存一次，
  //    否则 payload 里 docIds 只有当前论文，跨论文会话的「问过哪几篇」会丢。
  const oldScopeKey = sessionScopeKey();
  const next = writeSessionScopeMode(want);
  const nextScopeKey = sessionScopeKey();
  updateSessionSettingHints();
  // ③ 把同一个 sid 接到新归属的槽位，并完整复制一份到新键（旧文件保留作备份，不迁移不删除）
  if (docId && sid) {
    setActiveSidFor(docId, sid);
    let copied = false;
    if (oldScopeKey !== nextScopeKey) copied = await copySessionAcrossScope(oldScopeKey, nextScopeKey, sid);
    // 源文件不存在（例如刚启动还没落盘）时才退回按内存内容保存一次
    if (!copied) { try { await saveSessionNow(); } catch { /* 同上 */ } }
  }
  const label = next === 'global' ? '全局共用（所有论文接同一段对话）'
    : (next === 'paper' ? '按论文（每篇论文各接自己那一段）' : '按文件夹（同文件夹里的论文接同一段）');
  toast(`换论文时对话怎么接：${label}`, 'ok', 2600);
  loadSessionList().then(() => {
    renderSessionMenu();
    renderSessionBar();
    sessionsOnSessionChanged({ refresh: true });
  });
}

function updateUiRangeLabels() {
  const size = $('#uiFontSize');
  if (size && $('#uiFontSizeValue')) $('#uiFontSizeValue').textContent = `${size.value}px`;
  const zoom = $('#uiZoomSpeed');
  if (zoom && $('#uiZoomSpeedValue')) {
    /* 1.00× 时直接把「默认」写出来 —— 用户调完想知道自己有没有调过头，
       看这个字比看数字快。 */
    const v = Number(zoom.value);
    $('#uiZoomSpeedValue').textContent = Math.abs(v - 1) < 0.001 ? '1.0×（默认）' : `${v.toFixed(2)}×`;
  }
}

/**
 * Ctrl/⌘ + =（+）/ - 的落点：只改「阅读字号」（结果正文 --ai-fs），
 * 不动界面字号、不动控件大小；范围与设置里的滑杆一致（12–30），并同步面板与 toast。
 */
function setReadingFontSize(px) {
  const next = clamp(Math.round(Number(px) || DEFAULT_UI_STYLE.fontSize), READ_FS_MIN, READ_FS_MAX);
  uiStyle = { ...uiStyle, fontSize: next };
  applyUiStyle();
  saveUi();
  const range = $('#uiFontSize');
  if (range) range.value = String(next);
  updateUiRangeLabels();
  toast(`阅读字号 ${next}px`, '', 1600);
}

/** 设置页里还剩两个「即时生效」的控件：主题、阅读字号。其余字段（密度 / 纸张 / 行高…）
 *  没有界面入口了，值一律沿用 uiStyle 里原有的，绝不因为控件消失就被重置成默认值。 */
function applyUiSettingsFromControls() {
  const oldPaper = uiStyle.paper === 'white' ? 'white' : 'tint';
  const oldTheme = uiStyle.theme;
  const theme = $('#uiTheme');
  const size = $('#uiFontSize');
  const full = $('#cfgUseFullText');
  const web = $('#cfgUseWeb');
  const follow = $('#cfgFollowUpDirect');
  const zoom = $('#uiZoomSpeed');
  const wasFullText = state.useFullText;
  if (follow) writeFlag('reader.followUpDirect', !!follow.checked);
  uiStyle = {
    ...uiStyle,
    ...(theme ? { theme: theme.value } : {}),
    ...(size ? { fontSize: clamp(Number(size.value), READ_FS_MIN, READ_FS_MAX) } : {}),
    ...(full ? { useFullText: !!full.checked } : {}),
    ...(web ? { useWeb: !!web.checked } : {}),
    ...(zoom ? { zoomSpeed: clampZoomSpeed(zoom.value) } : {}),
  };
  /* 缩放速度当场推给 viewer：触摸屏捏合下一帧就用新速度，不用重开论文、不打断手势 */
  viewer?.setZoomSpeed?.(uiStyle.zoomSpeed);
  applyUiStyle();
  if (oldPaper !== uiStyle.paper || oldTheme !== uiStyle.theme) viewer?.refreshPaper?.();
  saveUi();
  // 发送范围偏好一改就当场生效（输入框上方那句「本次发送」同步刷新）
  syncScopePrefs();
  /**
   * 用户刚把「读整篇论文」打开，而论文已经开着：直接把全文读进来，
   * 免得第一次提问时才发现还在抽文本。（读失败不影响提问，只是不带全文。）
   */
  if (!wasFullText && state.useFullText && state.doc) warmDocText();
  renderAiArea();
  updateUiRangeLabels();
}

function resetPanels() {
  // 复位宽度意图与实际宽度都要回默认（sideBaseW 是「用户意图」，两边一起写才一致）
  sideBaseW.left = 210;
  sideBaseW.right = 360;
  document.documentElement.style.setProperty('--left-w', '210px');
  document.documentElement.style.setProperty('--right-w', '360px');
  // 「恢复默认布局」= 两边都展开：清掉用户意图和临时豁免，再按窗口宽度重算
  sideIntent.noLeft = false;
  sideIntent.noRight = false;
  sideIntent.pinned.left = false;
  sideIntent.pinned.right = false;
  state.panels = defaultPanels();
  savePanels();
  applyResponsiveLayout();
  applyPanels();
  saveUi();
  renderAiArea();
  refitViewer(REFIT_AFTER_MS);
}

/** 「恢复默认设置」：一次把样式与布局都复位（原来分成「恢复默认布局」+「恢复默认样式」两个按钮）。
    只动「壳」：论文、会话、消息一条都不碰，API Key / 模型名 / 接口地址也不碰。 */
function resetSettings() {
  uiStyle = { ...DEFAULT_UI_STYLE };
  writeFlag('reader.followUpDirect', FOLLOW_UP_DIRECT_DEFAULT);
  applyUiStyle();
  viewer?.refreshPaper?.();
  fillUiSettings();
  resetPanels();          // 面板显隐 / 顺序 / 两侧栏宽度 / 收起意图
  saveUi();
  toast('已恢复默认设置，论文和会话未受影响', 'ok');
}

function updateEndpointNote() {
  const url = $('#cfgBaseURL').value || Settings.data.baseURL || '';
  $('#endpointNote').textContent = `接口：${ENDPOINT_SHORT[url] || url}`;
}

const SETTINGS_PANE_KEY = 'reader.settings.pane';
const SETTINGS_PANES = ['model', 'appearance', 'behavior', 'session', 'memory'];

/**
 * 设置弹窗两栏切换：左列竖排分类，右侧只显示对应面板。
 * 分类名同时写在两端 id 里（settingsNavModel / settingsPaneModel），
 * 这里按 data-pane 匹配，新增分类不用改这段逻辑。
 */
function showSettingsPane(name) {
  const pane = SETTINGS_PANES.includes(name) ? name : 'model';
  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    const on = item.dataset.pane === pane;
    item.classList.toggle('on', on);
    item.setAttribute('aria-selected', on ? 'true' : 'false');
    item.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.settings-pane').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.pane !== pane);
  });
  const box = document.querySelector('.settings-box');
  if (box) box.dataset.settingsPane = pane;
  try { localStorage.setItem(SETTINGS_PANE_KEY, pane); } catch (e) { /* 隐私模式写不了，忽略 */ }
}

function openSettings(hint) {
  const modal = $('#settingsModal');
  modal.classList.remove('hidden');
  fillSettings();
  let pane = 'model';
  try { pane = localStorage.getItem(SETTINGS_PANE_KEY) || 'model'; } catch (e) { pane = 'model'; }
  showSettingsPane(pane);
  if (hint) { $('#testResult').className = 'test-result err'; $('#testResult').textContent = hint; }
  // 只在「模型与接口」时自动聚焦 Key 输入框；其他面板聚焦左列当前分类，别把焦点塞进看不见的面板
  setTimeout(() => {
    if (pane === 'model') $('#cfgApiKey')?.focus();
    else document.querySelector(`.settings-nav-item[data-pane="${pane}"]`)?.focus();
  }, 50);
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
  $('#testResult').textContent = '';
}

function initSettings() {
  $('#cfgProfile').onchange = async () => {
    const select = $('#cfgProfile');
    select.disabled = true;
    $('#saveSettings').disabled = true;
    try {
      await Settings.save({ selectProfile: select.value });
      fillSettings();
      checkConfigWarning();
      $('#testResult').className = 'test-result ok';
      $('#testResult').textContent = '已切换模型配置';
    } catch (e) {
      select.value = Settings.data.activeProfile || '0';
      $('#testResult').className = 'test-result err';
      $('#testResult').textContent = e.message;
    } finally { select.disabled = false; $('#saveSettings').disabled = false; }
  };
  $('#settingsBtn').onclick = () => openSettings();
  // 左列分类：点击切换；键盘 ↑/↓/Home/End 也能在分类间走动（panel 内部 Tab 正常）
  const settingsNav = document.querySelector('.settings-nav');
  settingsNav?.addEventListener('click', (e) => {
    const item = e.target.closest?.('.settings-nav-item');
    if (item) showSettingsPane(item.dataset.pane);
  });
  settingsNav?.addEventListener('keydown', (e) => {
    const items = [...settingsNav.querySelectorAll('.settings-nav-item')];
    const at = items.indexOf(document.activeElement);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    showSettingsPane(items[next].dataset.pane);
    items[next].focus();
  });
  $('#closeSettings').onclick = closeSettings;
  $('#settingsModal').addEventListener('mousedown', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#toggleEndpoint').onclick = () => {
    $('#endpointField').classList.toggle('hidden');
    updateEndpointNote();
  };
  $('#cfgBaseURL').addEventListener('input', updateEndpointNote);
  // 设置页里「即时生效」的控件：主题、阅读字号、双指缩放速度，以及两个默认发送范围偏好
  // （输入框旁的临时切换按钮已于 2026-11-04 移除；这里的两个勾就是唯一入口，
  //   勾选走 applyUiSettingsFromControls → syncScopePrefs → updateComposerHint）。
  ['uiTheme', 'uiFontSize', 'uiZoomSpeed', 'cfgUseFullText', 'cfgUseWeb', 'cfgFollowUpDirect']
    .forEach((id) => document.getElementById(id)?.addEventListener('input', applyUiSettingsFromControls));
  // 「会话」分类：四项都只影响本机行为，切换/勾选立刻生效（和「保存并测试」无关）
  $('#settScopeMode')?.addEventListener('change', () => applySessionScopeMode($('#settScopeMode').value));
  $('#settAiTitle')?.addEventListener('change', () => {
    const on = !!$('#settAiTitle').checked;
    setAiTitleEnabled(on);
    updateSessionSettingHints();
    if (on) scheduleSessionTitle();
    toast(on ? '已开启 AI 自动标题' : '已关闭 AI 自动标题，标题沿用首条问题', 'ok', 2400);
  });
  $('#settOnEnter')?.addEventListener('change', () => {
    sessionsSetEnterMode($('#settOnEnter').value);
    updateSessionSettingHints();
  });
  $('#settHistoryMode')?.addEventListener('change', () => {
    sessionsSetHistoryMode($('#settHistoryMode').value);
    updateSessionSettingHints();
  });
  $('#resetSettings').onclick = () => resetSettings();

  $('#saveSettings').onclick = async () => {
    const out = $('#testResult');
    const key = $('#cfgApiKey').value.trim();
    const model = $('#cfgModel').value.trim() || Settings.data.model;
    const visionModel = $('#cfgVisionModel').value.trim();
    const longTermMemory = $('#cfgLongTermMemory').value.slice(0, 4000);
    const baseURL = $('#cfgBaseURL').value.trim() || Settings.data.baseURL;
    out.className = 'test-result';
    out.textContent = '保存并测试中…';
    try {
      await Settings.save({ model, visionModel, longTermMemory, baseURL, ...(key ? { apiKey: key } : {}) });
      fillSettings();
      $('#cfgApiKey').value = '';
      $('#cfgApiKey').placeholder = Settings.data.hasApiKey ? '已保存，留空则不改' : 'sk-…';
      updateEndpointNote();
      const r = await testConnection();
      out.className = 'test-result ok';
      out.textContent = `✅ ${r.model} · ${r.ms}ms`;
      setTimeout(closeSettings, 900);
    } catch (e) {
      out.className = 'test-result err';
      out.textContent = `❌ ${e.message}`;
    }
  };
}

function checkConfigWarning() {
  const warn = $('#welcomeWarn');
  if (!warn) return;
  const need = !Settings.data.hasApiKey && !/127\.0\.0\.1|localhost/.test(Settings.data.baseURL || '');
  warn.classList.toggle('hidden', !need);
  if (need) {
    warn.innerHTML = '还没配置模型接口：点右上角 <b>⚙</b> 填 API Key 和模型名。<br />密钥只写在本机 <code>data/config.json</code>，PDF 不会离开这台电脑。';
  }
}


function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      // Esc 的第一优先级：退出全屏（全屏时用户只有这个明确预期；引用高亮不再用 Esc 取消）
      if (fullscreenActive()) { e.preventDefault(); toggleFullscreen(false); return; }
      if (!$('#regionOverlay').classList.contains('hidden')) { state.stopRegion?.(); return; }
      if (!$('#settingsModal').classList.contains('hidden')) { closeSettings(); return; }
      if (!$('#searchBar').classList.contains('hidden')) { $('#searchClose').click(); return; }
      if (!$('#noteBox').classList.contains('hidden')) { saveNoteBox(); return; }
      if (state.abort) { abortStream('user'); $('#composerHint').textContent = '正在停止…'; return; }
      // 引用高亮不随 Esc 取消：点正文任意处 / 再点同一个引用 / 翻页 / 换文档时清
      // Esc 是明确的「不要这个选区了」：连方块和记住的选区一起清掉
      if (state.selection) { clearSelectionState(); viewer?.clearSelection(); return; }
      hideBubble();
      return;
    }
    // 全屏切换：F11（浏览器里也照常用；桌面壳走窗口 IPC）
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setReadingFontSize(uiStyle.fontSize + 1); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setReadingFontSize(uiStyle.fontSize - 1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setReadingFontSize(DEFAULT_UI_STYLE.fontSize); return; }

    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchBtn').click(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') return;
    // 其余单键快捷键一律不能带修饰键，否则 Ctrl+A（全选）会被当成「问」真的发一次付费请求
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const hasSel = state.selection?.cleanText;
    if (e.key === 't' || e.key === 'T') { if (hasSel) { e.preventDefault(); doTranslate(state.selection); } return; }
    if (e.key === 'e' || e.key === 'E') { if (hasSel) { e.preventDefault(); doExplain(state.selection); } return; }
    if (e.key === 'q' || e.key === 'Q') { if (hasSel) { e.preventDefault(); addToChat(state.selection); } return; }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      // 在译文面板里按 R = 截图翻译；其它情况仍是「框选加进问答」
      state.startRegion?.(rightPanelInCol(1) === 'translate' ? 'translate' : 'chat');
      return;
    }
    if (e.key === '+' || e.key === '=') { viewer?.setScale(viewer.scale * 1.15); return; }
    if (e.key === '-' || e.key === '_') { viewer?.setScale(viewer.scale / 1.15); return; }
    if (e.key === '0') { viewer?.fitWidth(); return; }
    if (e.key === 'PageDown') { e.preventDefault(); viewer?.stepPage(1); return; }
    if (e.key === 'PageUp') { e.preventDefault(); viewer?.stepPage(-1); return; }
    if (e.key === 'Home') { e.preventDefault(); viewer?.goToPage(1); return; }
    if (e.key === 'End') { e.preventDefault(); viewer?.goToPage(viewer.numPages); return; }
  });

  // Ctrl/⌘ + 划选 = 拼接上一次选区。
  // 只在这里打标记，真正的合并交给 onSelectionChanged 做 ——
  // 否则 10ms 后那次回调会用新选区把合并结果覆盖掉。
  $('#viewer').addEventListener('mouseup', (e) => {
    state._pendingMerge = (e.ctrlKey || e.metaKey) ? (state.selection?.cleanText || null) : null;
  });
}


// 只有用户主动停止（fetch 被 abort）才算「已停止」；超时是 TimeoutError，必须显示成错误
const isAbort = (e) => e?.name === 'AbortError';
function errText(e) {
  const raw = String(e?.message || '').trim();
  if (!raw) return '暂时没有生成结果';
  // 空闲看门狗抛的是 TimeoutError + 中文说明（ai.js 的 stale()），
  // 必须放在最前面原样透出：否则会被下面的 /网络|fetch/ 规则抢先命中，
  // 用户看到的就成了「接口暂时不可用」，完全对不上「卡住 / 超时」这个事实。
  if (e?.name === 'TimeoutError' || /没有收到任何数据|没有返回数据|超时/.test(raw)) {
    return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
  }
  if (/timeout|timed out|idle/i.test(raw)) return '等待模型回应超时，可以重试。';
  if (/HTTP 401|unauthorized|invalid api key/i.test(raw)) return '接口没有接受密钥，请检查设置后重试。';
  if (/HTTP 429|rate limit|too many/i.test(raw)) return '接口暂时繁忙，请稍后再试。';
  if (/HTTP 5\d\d|网络|fetch|failed to fetch/i.test(raw)) return '接口暂时不可用，请检查连接后重试。';
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok', 1100);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'ok', 1100); } catch { toast('复制失败', 'err'); }
    ta.remove();
  }
}

async function maybeReopenLast() {
  const url = new URL(location.href);
  const openName = url.searchParams.get('open');
  if (openName) {
    const found = state.papers.find((p) => p.name === openName || p.name.replace(/\.pdf$/i, '') === openName);
    if (found) {
      await openDoc({ name: found.name, url: found.url, docId: found.docId });
      return;
    }
    toast(`papers/ 里没有找到 ${openName}`, 'err', 4000);
  }

  // 停在首页。顺手清掉「上次那篇已经被删掉/移走」的陈旧标记（多标签 Welcome 路径共用）。
  cleanStaleLastDoc();
  setView('home');
}

/**
 * 清掉「上次那篇已经被删掉/移走」的陈旧标记（对应设计里的状态 5）。
 * B 线 P1：多标签模式不再走 maybeReopenLast，但这条清理必须照常执行，所以抽成函数。
 */
function cleanStaleLastDoc() {
  const stale = serverState.lastDoc
    && !state.papers.some((p) => p.docId === serverState.lastDoc || p.name === serverState.lastName);
  if (!stale) return;
  const docs = { ...(serverState.docs || {}) };
  delete docs[serverState.lastDoc];
  serverState = { ...serverState, docs, lastDoc: null, lastUrl: null, lastName: null };
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serverState),
  }).catch(() => { /* 清不掉也不影响首页显示：recentDocs() 本来就会过滤掉它 */ });
}

function saveOnUnload(url, text) {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
      keepalive: true,
    }).catch(() => { /* 关页途中失败只能放弃 */ });
  } catch { /* 尽力而为 */ }
}

window.addEventListener('beforeunload', () => {
  // 不能只是 cancel：那样刚翻的那页进度就丢了。用 keepalive fetch 保证送达。
  saveProgress.cancel?.();
  persistSession.flush?.();
  if (state.doc) {
    try {
      // B 线 P3：unload 时分别保存全局问答与本文档译文（都走 keepalive）
      const both = buildSessionPayload();
      if (both) {
        saveOnUnload(`/api/session?${sessionQuery(sessionScopeKey(), activeSidFor(state.doc.docId))}`, both.chat);
        saveOnUnload(`/api/session?${sessionQuery(state.doc.docId, TRANSLATE_SID)}`, both.translate);
      }
    } catch { /* unload fallback */ }
  }
  if (!state.doc || !viewer) return;
  try {
    const docs = { ...(serverState.docs || {}) };
    docs[state.doc.docId] = { page: viewer.current, scale: Number(viewer.scale.toFixed(3)), fit: !!viewer._fitMode, ts: Date.now(), name: state.doc.name };
    const payload = { ...serverState, docs, lastDoc: state.doc.docId, lastUrl: state.doc.url, lastName: state.doc.name };
    saveOnUnload('/api/state', JSON.stringify(payload));
  } catch { /* 尽力而为 */ }
});
