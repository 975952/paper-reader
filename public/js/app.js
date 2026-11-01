import { $, $$, el, appendAll, toast, toastAction, cleanText, renderMarkdown, escapeHtml, debounce, throttle, clamp, fmtSize } from './util.js';
import { iconEl, iconHTML, hasIcon } from './icons.js';
import { PdfViewer, clampZoomSpeed, ZOOM_SPEED_MIN, ZOOM_SPEED_MAX } from './pdfview.js';
import { OPS, opById } from './ops.js';
import {
  TEACHING_OPS, teachingOpById, TEACHING_PROMPT_VERSION, WALK_CONTINUE_SYS, walkReteachSys,
  PREREQ_ONE_SYS, splitPrtBlock, hideStreamTail, parsePrereqItems, detectPageObjects,
  pageTextOf, collectDocObjects, sanitiseChips,
} from './teaching.js';
import { profileStore, buildProfileBlock, nowISO, nowContext, findItem } from './profile.js';
import { createLearningMemory, parseMemorySuggestions, explicitIdentityFacts, withMemoryObservations } from './learning-memory.js';
import {
  Settings, streamChat, testConnection, targetLangFor,
  translateMessages, askMessages, explainMessages, regionMessages,
  digestMessages, webQueryFor, filterWebResults, opMessages, teachMessages, condenseMessages,
  scanPageMessages, sessionSummaryMessages,
} from './ai.js';
import { resolveReadingRequest, snapshotReadingRequest, snapshotHistory, readingTurn,
  restoreReadingHistory, citedSources, stripPageLabels } from './reading-context.js';

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
  { id: 'translate', title: '译文', hint: '划选正文后点「译」，译文按时间堆在这里' },
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
  teaching: { walk: null, current: null },
  teachingCache: new Map(),
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

  await profileStore.load();
  await loadServerState();
  state.folderOpen = loadFolderOpen();
  // 服务端记住的「上次打开哪篇」这时才拿到：如果刚才的 reader.ai 迁移还没能认出当前论文，
  // 这里补一次 byDoc 覆盖（只在「刚迁移过」时发生，之后用户怎么摆就怎么算）
  const migrated = applyPanelMigration();
  if (migrated) { applyPanels(); applyResponsiveLayout(); }
  await refreshPaperList();
  await maybeReopenLast();
  checkConfigWarning();
})();


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

/** Rust 侧窗口状态变化时用 evaluate_script 调它（当前用于「最大化 ↔ 还原」切图标） */
window.__prtWindowState = (state) => {
  document.body.classList.toggle('window-maximized', !!(state && state.maximized));
};

function initWindowChrome() {
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
  if (style.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = style.theme === 'dark' ? 'dark' : 'light';
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
    // 扫描件 OCR：逐页转写 + 缓存（自动化直接验「生成文字版后问答用文字」）
    runOcrDoc, ocrTextFor, loadOcrCache, ocrPages,
    get docProfile() { return state.docProfile; },
    set docProfile(v) { state.docProfile = v; },
    // 记忆：长期记忆 / 本篇讨论 / 会话滚动摘要（自动化验注入块与清理）
    askProfileBlock, sessionSummaryBlock, paperMemoryBlock, longTermMemoryBlock,
    scheduleSessionSummary, loadPaperMemory, isPaperMemoryOff, setPaperMemoryOff,
    get sessionSummary() { return state.sessionSummary; },
    get paperMemory() { return state.paperMemory; },
    get FULL_LIMIT() { return FULL_LIMIT; },
    jumpToPageWithHistory, jumpToDestWithHistory, returnToPreviousPosition,
    updateSendScope, runSearch, stepHit, addToChat, addImageToChat, removeAttach,
    renderAttachments, refreshReturnButton,
    // 发送范围四选项：让自动化直接验「范围 → 本次发送带什么」
    setScopeRange, toggleScopePanel, SCOPE_RANGES, rangeOverview, currentRange,
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

  $('#footPrevPage').onclick = () => viewer.goToPage(viewer.current - 1);
  $('#footNextPage').onclick = () => viewer.goToPage(viewer.current + 1);
  $('#footZoomIn').onclick = () => viewer.setScale(viewer.scale * 1.15);
  $('#footZoomOut').onclick = () => viewer.setScale(viewer.scale / 1.15);
  $('#footFitWidth').onclick = () => viewer.fitWidth();

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

  // ── 最近列表 ──
  list.replaceChildren();
  if (title) title.textContent = rows.length ? `最近打开（${rows.length}）` : '最近打开';
  if (!rows.length) {
    list.append(el('li', { class: 'home-empty' },
      el('div', { text: state.papers.length ? '还没有阅读记录' : '还没有论文' }),
      el('div', { class: 'home-empty-sub', text: state.papers.length
        ? '点上面「打开 PDF」，或从左边文件列表里挑一篇'
        : '点「打开 PDF」选一个，或直接把 PDF 拖进来' })));
    return;
  }
  for (const row of rows) {
    const item = el('li', { class: 'home-item', dataset: { id: row.docId } },
      el('button', { type: 'button', class: 'home-item-go', title: row.name },
        el('span', { class: 'hi-name', text: row.name.replace(/\.pdf$/i, '') }),
        el('span', { class: 'hi-meta', text: `第 ${row.page} 页 · ${relTime(row.ts)}` })),
      el('button', {
        type: 'button', class: 'home-item-x', text: '×',
        title: `移除「${row.name}」的最近记录（不删除文件）`,
        'aria-label': `移除「${row.name}」的最近记录`,
        onclick: (e) => { e.stopPropagation(); removeRecent(row.docId); },
      }));
    item.querySelector('.home-item-go').onclick = () => openDoc({ name: row.name, url: row.url, docId: row.docId });
    list.append(item);
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
  const li = el('li', {
    title: `${flat && p.folder ? p.folder + '/' : ''}${p.name}\n${fmtSize(p.size)}\n按住拖动：同目录调整顺序，拖到文件夹行移入`,
    dataset: { id: p.docId, name: p.name, path: p.path || p.name },
    draggable: 'true',
    onclick: (e) => {
      if (e.target.closest?.('.file-row-x, .file-grip')) return;
      openDoc({ name: p.name, url: p.url, docId: p.docId, path: p.path || p.name });
    },
  },
    el('span', { class: 'file-grip', title: '按住拖动', 'aria-hidden': 'true', html: PAPER_GRIP_SVG }),
    el('span', { class: 'file-name', text: display }),
    el('button', {
      type: 'button', class: 'file-row-x', html: PAPER_X_SVG,
      title: `删除「${p.name}」（只删 papers/ 里的这个文件）`,
      'aria-label': `删除「${p.name}」`,
      onclick: (e) => { e.stopPropagation(); deletePaper(p); },
    }));
  if (state.doc?.docId === p.docId) li.classList.add('active');
  return li;
}

/**
 * 渲染某一层的子项（文件夹按名称序在前 + PDF 按服务端顺序在后）。
 * 返回 DocumentFragment；无任何子项返回 null。
 */
function renderTreeLevel(folderPath, depth) {
  const prefix = folderPath ? `${folderPath}/` : '';
  const subs = (state.folders || [])
    .filter((f) => {
      if (folderPath === '') return !f.path.includes('/');
      return f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/');
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
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
      return;
    }
    for (const p of hits) list.append(paperRow(p, true));
    return;
  }

  const frag = renderTreeLevel('', 0);
  if (!frag) {
    list.append(el('li', { class: 'empty', text: 'papers/ 里还没有 PDF' }));
    return;
  }
  list.append(frag);
}

/* ───────────────── 文件列表：批量导入 / 拖拽排序 / 删除（2026-10） ───────────────── */

/** 从 FileList / DataTransfer 里挑出 PDF（大小写不敏感） */
function pdfFilesFrom(files) {
  return Array.from(files || []).filter((f) => f && /\.pdf$/i.test(f.name));
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
    e.preventDefault();
    // 内部拖拽 drop 到左栏外（右栏/顶部/任意位置）→ 移到根目录；外部 PDF → 导入根。
    if (isExternalFileDrag(e)) { importExternalDrop(e.dataTransfer, ''); return; }
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer?.getData(PRT_DRAG_MIME) || 'null'); } catch { /* 忽略 */ }
    if (payload) moveItem(payload.path, '');
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
    if (e.target.closest?.('#fileList')) return; // 列表内的 drop 已由 bindPaperDrag 处理
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer?.getData(PRT_DRAG_MIME) || 'null'); } catch { /* 忽略 */ }
    if (!payload) return;
    e.preventDefault();
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
    from = { path, kind };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(PRT_DRAG_MIME, JSON.stringify({ path, kind }));
      e.dataTransfer.setData('text/plain', path);
    } catch { /* 忽略 */ }
  });
  list.addEventListener('dragend', () => { from = null; clearMarks(); });

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

    // 内部拖拽
    const folderLi = e.target.closest?.('li.folder[data-path]');
    const targetFolder = folderLi ? folderLi.dataset.path : dropTargetFolder(e);
    if (payload.kind === 'file') {
      const li = e.target.closest?.('li[data-path]:not(.folder)');
      // 拖到「自己所在的文件夹」行：无操作（服务端也会 no-op，前端先拦省一次请求）
      if (targetFolder && targetFolder === folderOf(payload.path)) return;
      // 同目录 + 落在 PDF 行上 → 排序；其余一律移动
      if (!targetFolder && li && folderOf(li.dataset.path) === folderOf(payload.path)) {
        const r = li.getBoundingClientRect();
        applyPaperOrder(payload.path, li.dataset.path, e.clientY > r.top + r.height / 2);
        return;
      }
      await moveItem(payload.path, targetFolder || '');
      return;
    }
    // 文件夹拖拽：改变层级（禁区前端先拦，服务端二次校验）
    if (payload.kind === 'folder') {
      const to = targetFolder || '';
      if (to === payload.path || to.startsWith(`${payload.path}/`)) {
        toast('不能把文件夹移到自己的子目录里', 'err', 3600);
        return;
      }
      await moveItem(payload.path, to);
    }
  });
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
    await refreshPaperList();
  } catch (e) {
    toast(`移动失败：${e.message}`, 'err', 5000);
    await refreshPaperList();
  }
}

let paperOrderSave = Promise.resolve();
/** 同目录排序：order 升级为相对路径数组，未排序项按 mtime 倒序排最前（服务端行为） */
function applyPaperOrder(from, target, after) {
  const paths = (state.papers || []).map((p) => p.path || p.name);
  const i = paths.indexOf(from);
  if (i < 0) return;
  paths.splice(i, 1);
  const t = paths.indexOf(target);
  if (t < 0) paths.push(from);
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
    const target = folderLi
      ? { kind: 'folder', path: folderLi.dataset.path, name: folderLi.dataset.folder }
      : fileLi
        ? { kind: 'file', path: fileLi.dataset.path, name: fileLi.dataset.name }
        : { kind: 'blank' };
    showFileCtx(e.clientX, e.clientY, target);
  });
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

async function openDoc({ name, url, docId, path }) {
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
  const myOpen = (state.openSeq = (state.openSeq || 0) + 1);
  const superseded = () => myOpen !== state.openSeq;
  hideTranslationCard();
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
  clearAllBlocks();
  state.attachments = [];
  renderAttachments();
  viewer.paintSelection(null);

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

  try {
    const r = await viewer.load(url, name);
    if (superseded()) return;
    if (r?.stale) return;
  } catch (e) {
    // 被后一次打开顶替了、或者这次加载本来就被中断 → 一律不动界面
    if (superseded() || isAbortish(e)) return;
    toast(`打开失败：${e.message}`, 'err', 6000);
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
  await viewer.refreshPage?.(1);
  if (superseded()) return;
  syncZoom(viewer.scale);
  // 底栏的页码也要在打开时立刻有值：`onPageChange` 不保证在这个时点已经触发过
  //（实测首次打开时底栏还停在占位符「–」，而顶栏已经是 1/16）。直接同步一次。
  syncFootPage(viewer.current, viewer.numPages);
  await renderOutline();
  await renderNotes();
  if (superseded()) return;
  await restoreSession(docId);
  if (superseded()) return;
  // 换论文了：会话条要跟着换成这一篇的当前会话名
  await loadSessionList();
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
    page: viewer?.current || null,
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
  body.innerHTML = '<span class="cursor"></span>';
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
  refreshCounts();
}

function clearChatBlock() {
  const meta = state.blockMeta.chat;
  if (meta) meta.body.innerHTML = '';
  refreshCounts();
}

function ensureBlock(id) {
  if (state.blockEls[id]) return state.blockEls[id];
  const count = el('span', { class: 'ai-count' });
  const meta0 = AI_BLOCKS.find((b) => b.id === id) || {};
  const hint = el('div', { class: 'ai-hint', text: meta0.hint || '' });
  const body = el('div', { class: 'ai-body' }, hint);
  const root = el('section', { class: 'ai-block', dataset: { block: id, panel: id } }, body);

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

/** 一列的结果区长什么样（只改 DOM，不改导航） */
function renderCol(n) {
  const area = rightAreaEl(n);
  if (!area) return;
  const id = rightPanelInCol(n);
  // 把「这一栏此刻显示的是谁」写到 <aside> 上：CSS 需要它来决定要不要显示输入区。
  // 用户口径：「译文不需要输入啊」—— 译文栏只显示译文，不给输入框；
  // 问答栏才需要输入框。见 style.css 的 [data-active-panel="translate"] 那一条。
  const col = rightColEl(n);
  if (col) {
    if (id) col.dataset.activePanel = id;
    else delete col.dataset.activePanel;
  }
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
function addEntry({ block = 'chat', tag, page, quote, imageSrc, thumbs, kind = 'assistant', text, retry, restore = false, reveal = true }) {
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

  const role = el('div', { class: `role${!isUser && !page ? ' hidden' : ''}` },
    tag ? el('span', { class: 'tag', text: tag, 'aria-hidden': 'true' }) : null,
    page && uiStyle.showPage ? el('span', { class: 'pg', text: `第${page}页` }) : null,
    // 译文块不要动作按钮（「最纯净的界面」）：连 role 行里这个「回原文」图标也去掉，
    // 跳回原文统一由下面那块可点击的原文引用承担。
    !isUser && page && uiStyle.showPage && !isTranslateEntry ? el('button', {
      class: 'tbtn',
      title: `回到第${page}页原文`,
      'aria-label': `回到第${page}页原文`,
      onclick: () => jumpToPageWithHistory(page, { smooth: true }),
    }, iconEl('jump-back')) : null,
  );
  const refText = quote && uiStyle.showQuote ? quote : '';
  const refClickable = !!refText && !!page && !isUser;
  const ref = refText
    ? el(refClickable ? 'button' : 'div', {
      class: `ref${refClickable ? ' ref-jump' : ''}`,
      type: refClickable ? 'button' : null,
      title: refClickable ? `跳回第 ${page} 页原文：${refText}` : refText,
      'aria-label': refClickable ? `跳回第 ${page} 页原文` : null,
      onclick: refClickable ? () => jumpToPageWithHistory(page, { smooth: true }) : null,
    }, refText)
    : null;
  const shots = (imageSrc ? [imageSrc] : (thumbs || [])).filter(Boolean);
  const shot = shots.length
    ? el('div', { class: 'shots' }, ...shots.map((src) => el('img', { class: 'shot-img', src })))
    : null;
  const textEl = el('div', {
    class: 'text',
    html: text !== undefined ? renderAnswerHTML(text) : '<span class="cursor"></span>',
  });
  const acts = el('div', { class: 'acts hidden' });
  const root = el('div', { class: `msg ${isUser ? 'user' : 'assistant'}`, dataset: { operation: tag || '', page: page || '' } }, role, ref, shot, textEl, acts);
  // 全局序号：分块之后 DOM 顺序 ≠ 时间顺序，取「最新一条」要靠它
  state.msgSeq = (state.msgSeq || 0) + 1;
  root.dataset.seq = String(state.msgSeq);
  if (block === 'translate') bodyEl.prepend(root);
  else bodyEl.append(root);
  const record = { block, tag: tag || '', page: page || null, quote: quote || '', kind, text: text || '', screenshot: !!shots.length, sources: [], meta: '', status: isUser ? 'user' : (text !== undefined ? 'complete' : 'pending'), retry: retry || null };
  root.__sessionRecord = record;
  if (!restore) {
    state.sessionEntries.push(record);
    scheduleSessionSave();
  }
  // 新结果进入时把它放到结果区顶部，用户可以继续向上滚查看更早的结果。
  scrollEntryToTop(bodyEl, root);
  refreshCounts();
  return { root, body: textEl, acts, role };
}

function finishEntry(entry, fullText, { page, onAsk, onRetry, retryLabel = '', sources, meta, status = 'complete' } = {}) {
  const rec = entry.root.__sessionRecord;
  if (rec) {
    rec.text = String(fullText || '').slice(0, 12000);
    rec.page = page || rec.page;
    rec.sources = (sources || []).slice(0, 8);
    rec.meta = meta || '';
    rec.status = status;
  }
  // R7：内容长出来之后刷新底部渐隐（下一帧量，等布局落定）
  requestAnimationFrame(updateScrollFades);
  // 同一个条目可能被收尾多次（典型：操作「重试」复用同一条），
  // 先把上一次的元信息行与来源列表摘掉，否则会叠出两行、旧的那行还写着「N 页失败」。
  entry.root.querySelectorAll('.entry-meta, .source-details, .src-list').forEach((node) => node.remove());
  entry.acts.replaceChildren();
  entry.acts.classList.remove('hidden');
  const bare = entry.root.dataset.operation === 'translation';  appendAll(entry.acts,
    bare ? null : el('button', {
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
    return { kind, docId: String(raw.docId || '').slice(0, 240), text: String(raw.text || '').slice(0, 6000), page: raw.page || null };
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
function scheduleSessionSave() { if (state.doc) persistSession(); }

const SESSION_KEY = 'reader.activeSession';

function readActiveSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}') || {}; } catch { return {}; }
}
function activeSidFor(docId) {
  const map = readActiveSessions();
  return typeof map[docId] === 'string' ? map[docId] : '';
}
function setActiveSidFor(docId, sid) {
  const map = readActiveSessions();
  if (sid) map[docId] = sid; else delete map[docId];
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
  const rows = (Array.isArray(shots) ? shots : []).filter((s) => s && validAttachmentId(s.id));
  const urls = await Promise.all(rows.map((s) => fetchAttachmentDataUrl(s.id, docId, sid)));
  const thumbs = urls.filter(Boolean);
  return { thumbs, missing: urls.length > thumbs.length };
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

function sessionPayload() {
  if (!state.doc) return null;  const entries = state.sessionEntries.slice(-90).map((x) => ({
    block: String(x.block || 'chat'), tag: String(x.tag || '').slice(0, 120), page: x.page || null,
    quote: String(x.quote || '').slice(0, 3000), kind: x.kind === 'user' ? 'user' : 'assistant',
    text: String(x.text || '').slice(0, 12000), screenshot: !!x.screenshot,
    // 截图附件单独存：这里只留 id 引用（几十字节），恢复会话时按 id 取回原图
    shots: (Array.isArray(x.shots) ? x.shots : [])
      .filter((s) => s && validAttachmentId(s.id))
      .slice(0, 6)
      .map((s) => ({ id: s.id, w: Number(s.w) || 0, h: Number(s.h) || 0, label: String(s.label || '截图').slice(0, 120) })),
    status: ['pending', 'complete', 'stopped', 'failed', 'user'].includes(x.status) ? x.status : (x.kind === 'user' ? 'user' : 'complete'),
    sources: (Array.isArray(x.sources) ? x.sources : []).slice(0, 8).map((s) => ({ title: String(s.title || '').slice(0, 500), url: String(s.url || '').slice(0, 2000), number: s.number || null })),
    meta: String(x.meta || '').slice(0, 500),
    retry: serialiseRetryPayload(x.retry),
    // 「读懂论文」的教学按钮 / 教学对象：恢复会话后「继续下一步 / 这个我懂了」仍然可用
    chips: (Array.isArray(x.chips) ? x.chips : []).slice(0, 4).map((c) => ({ label: String(c.label || '').slice(0, 12), prompt: String(c.prompt || '').slice(0, 200), op: ['evidence', 'limits'].includes(c.op) ? c.op : '' })),
    teaching: x.teaching && typeof x.teaching === 'object' ? {
      kind: String(x.teaching.kind || '').slice(0, 40), name: String(x.teaching.name || '').slice(0, 160),
      boundary: String(x.teaching.boundary || '').slice(0, 2000), page: x.teaching.page || null,
    } : null,
  }));
  const inMemory = new Set(entries.map((e) => `${e.tag}\u0000${e.text}`));
  const kept = (Array.isArray(state._fileEntries) ? state._fileEntries : [])
    .filter((e) => e && e.block !== 'chat')
    .filter((e) => !inMemory.has(`${String(e.tag || '').slice(0, 120)}\u0000${String(e.text || '').slice(0, 12000)}`))
    .slice(-40)
    .map((e) => ({ ...e, block: String(e.block || 'translate') }));
  const allEntries = [...kept, ...entries];
  const prefix = `${state.doc.docId}:`;
  const ops = [...state.opsCache.entries()].filter(([key]) => key.startsWith(prefix)).slice(-20)
    .map(([key, value]) => ({ id: key.slice(prefix.length), text: String(value.text || '').slice(0, 12000), at: value.at || Date.now(), page: value.page || null }));
  const payload = {
    entries: allEntries, history: snapshotHistory(state.history), ops,
    teaching: serializeTeachingState(), updatedAt: Date.now(),
    // 滚动摘要（compaction）：早先对话压成一段话，和原文历史一起存
    summary: String(state.sessionSummary || '').slice(0, 2000),
    summaryCovered: Math.max(0, Number(state.summaryCovered) || 0),
  };
  let encoded = JSON.stringify(payload);
  const encodedBytes = () => new TextEncoder().encode(encoded).byteLength;
  while (encodedBytes() > 350000 && payload.entries.length > 1) { payload.entries.shift(); encoded = JSON.stringify(payload); }
  while (encodedBytes() > 350000 && payload.ops.length) { payload.ops.shift(); encoded = JSON.stringify(payload); }
  while (encodedBytes() > 350000 && payload.history.length) { payload.history.shift(); encoded = JSON.stringify(payload); }
  return encoded;
}

async function saveSessionNow() {
  if (!state.doc) return;
  const encoded = sessionPayload();
  const sid = activeSidFor(state.doc.docId);
  const r = await fetch(`/api/session?${sessionQuery(state.doc.docId, sid)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encoded,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
      const sel = { page: payload.page || null, text: payload.text || '', cleanText: payload.text || '' };
      if (!sel.cleanText) { restoreComposerFallback(fallbackQuestion); return; }
      if (payload.kind === 'translate') doTranslate(sel);
      else doExplain(sel);
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

async function restoreSession(docId, { only = 'all' } = {}) {
  try {
    const sid = activeSidFor(docId);
    const openSeq = state.openSeq;
    const r = await fetch(`/api/session?${sessionQuery(docId, sid)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const saved = await r.json();
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    state._fileEntries = Array.isArray(saved.entries) ? saved.entries : [];
    state.sessionEntries = Array.isArray(saved.entries) ? saved.entries.slice(-90) : [];
    state.history = restoreReadingHistory(saved.history, state.sessionEntries);
    // 会话滚动摘要：老会话没有这个字段，按「没有摘要」处理
    state.sessionSummary = typeof saved.summary === 'string' ? saved.summary.slice(0, 2000) : '';
    state.summaryCovered = Math.max(0, Math.min(Number(saved.summaryCovered) || 0, state.history.length));
    state.opsDone = {};
    state.opsDoc = docId;
    // 「带我一步步读」的进度随会话存盘；老会话没有这个字段就按没有进度处理
    state.teaching = { walk: null, current: null };
    const savedWalk = saved?.teaching?.walk;
    if (savedWalk && savedWalk.docId === docId && (savedWalk.sid || '') === sid) {
      state.teaching.walk = {
        docId, sid, step: Number(savedWalk.step) || 1, routeCount: savedWalk.routeCount || null,
        updatedAt: savedWalk.updatedAt || nowISO(),
        messages: (Array.isArray(savedWalk.messages) ? savedWalk.messages : []).slice(-16)
          .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 12000) })),
      };
    }
    for (const op of Array.isArray(saved.ops) ? saved.ops : []) {
      if (!op?.id || typeof op.text !== 'string') continue;
      state.opsCache.set(`${docId}:${op.id}`, { text: op.text.slice(0, 12000), at: op.at || Date.now(), page: op.page || null });
      state.opsDone[op.id] = true;
    }
    for (let rowIndex = 0; rowIndex < state.sessionEntries.length; rowIndex += 1) {
      let row = state.sessionEntries[rowIndex];
      if (!row || typeof row !== 'object') continue;
      /**
       * 换会话时（`only: 'chat'`）只重放问答：译文那一块的 DOM 没被清，
       * 再插一遍就会重复。换论文时（默认）两块都清过，所以全部重放。
       */
      if (only === 'chat' && row.block !== 'chat') continue;
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
      const shotRefs = (Array.isArray(row.shots) ? row.shots : []).filter((s) => s && validAttachmentId(s.id));
      let thumbs = [];
      let shotsLost = false;
      if (row.screenshot || shotRefs.length) {
        if (shotRefs.length) {
          const hydrated = await hydrateShotThumbs(shotRefs, docId, sid);
          thumbs = hydrated.thumbs;
          shotsLost = !thumbs.length;
        } else {
          shotsLost = true;   // 老会话：只存了「有过截图」的标记，没有图片本体
        }
      }
      const text = `${String(row.text || '').slice(0, 12000)}${shotsLost ? '\n\n【截图附件未保存，请重新添加截图】' : ''}`;
      const entry = addEntry({ ...row, text, thumbs, restore: true });
      entry.root.__sessionRecord = row;
      const priorUser = [...state.sessionEntries.slice(0, rowIndex)].reverse().find((x) => x?.kind === 'user');
      // 恢复出来的回答也要能存笔记：标题默认用上一条用户消息（重放时补上 __question）
      if (row.kind !== 'user' && priorUser) entry.root.__question = String(priorUser.text || '').slice(0, 600);
      const retry = restoreRetryCallback(row, entry, priorUser);
      if (row.kind !== 'user' && (row.text || row.status === 'stopped' || row.status === 'complete')) finishEntry(entry, row.text || '', {
        page: row.page, sources: row.sources, meta: row.meta,
        status: row.status === 'stopped' ? 'stopped' : 'complete',
        onRetry: row.status === 'stopped' ? retry : null,
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
  } catch (e) { toast(`读取当前论文会话失败：${e.message}`, 'err', 5000); }
}

async function clearCurrentSession() {
  if (!state.doc || !confirm(`清空「${state.doc.name}」的对话和 AI 结果？`)) return;
  closeSessionMenu();
  persistSession.cancel?.();
  state.sessionEntries = [];
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  const prefix = `${state.doc.docId}:`;
  for (const key of state.opsCache.keys()) if (key.startsWith(prefix)) state.opsCache.delete(key);
  state.opsDone = {};
  resetTeachingState();
  clearAllBlocks();
  try {
    const r = await fetch(`/api/session?${sessionQuery(state.doc.docId, activeSidFor(state.doc.docId))}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [], history: [], ops: [], updatedAt: Date.now() }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('当前论文会话已清空', 'ok');
    loadPaperMemory();
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
    const r = await fetch(`/api/sessions?doc=${encodeURIComponent(state.doc.docId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    sessionStore.list = (await r.json()).sessions || [];
  } catch { sessionStore.list = []; }
  return sessionStore.list;
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
    el('div', { class: 'sess-head', text: `「${(state.doc?.name || '').replace(/\.pdf$/i, '')}」的会话` }),
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

/** 把当前会话存盘后，切到另一个 sid（空串 = 老的单会话文件） */
async function switchSession(sid) {
  if (!state.doc) return;
  const docId = state.doc.docId;
  if (activeSidFor(docId) === (sid || '')) { closeSessionMenu(); return; }
  persistSession.cancel?.();
  try { if (sessionSaveInFlight) await sessionSaveInFlight; await saveSessionNow(); } catch { /* 存不下也允许切 */ }
  setActiveSidFor(docId, sid || '');
  clearChatBlock();                 // 会话只管问答，译文留着
  state.sessionEntries = [];
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  state.opsDone = {};
  state.opsDoc = null;
  resetTeachingState();
  await restoreSession(docId, { only: 'chat' });
  loadPaperMemory();
  closeSessionMenu();
  renderSessionBar();
  updateSendScope();
  toast('已切换会话', 'ok', 1600);
}

/** 新建一个空会话并切过去 */
async function newSession() {
  if (!state.doc) return;
  const docId = state.doc.docId;
  // 先把当前会话存盘，再换 sid（顺序不能反，否则那几轮对话就存到新会话名下了）
  persistSession.cancel?.();
  try { if (sessionSaveInFlight) await sessionSaveInFlight; await saveSessionNow(); } catch { /* 存不下也允许新建 */ }
  setActiveSidFor(docId, newSid());
  clearChatBlock();                 // 新建会话 = 清空问答区；译文不动（它不属于任何会话）
  state.sessionEntries = [];
  state.history = [];
  state.sessionSummary = '';
  state.summaryCovered = 0;
  state.opsDone = {};
  state.opsDoc = null;
  resetTeachingState();
  // 立刻落盘一次：不存的话新会话在服务端没有文件，会话列表里就看不到它，
  // 用户会以为「新建了但列表里没有」（实测踩过）。空会话也是一次有效的保存。
  try { await saveSessionNow(); } catch { /* 存不下也不阻塞新建 */ }
  await loadSessionList();
  loadPaperMemory();
  closeSessionMenu();
  renderSessionBar();
  updateSendScope();
  toast('已新建会话', 'ok', 1600);
}

/** 删掉一个会话文件（不碰论文 / 笔记）；删的是当前会话就退回老会话或新建 */
async function deleteSession(sid) {
  if (!state.doc) return;
  const docId = state.doc.docId;
  if (!confirm('删除这个会话？论文和笔记不受影响。')) return;
  try {
    const r = await fetch(`/api/session?${sessionQuery(docId, sid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) { toast(`删除失败：${e.message}`, 'err', 4000); return; }
  if (activeSidFor(docId) === (sid || '')) {
    setActiveSidFor(docId, '');
    clearChatBlock();
    state.sessionEntries = [];
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
}

function renderSessionBar() {
  const btn = $('#sessBtn');
  const bar = $('#sessBar');
  if (!btn || !bar) return;
  // 会话条只在问答块开着的时候出现
  const chatActive = !!state.doc && rightPanelInCol(1) === 'chat';
  if (!chatActive) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const cur = activeSidFor(state.doc.docId);
  const row = sessionStore.list.find((s) => (s.sid || '') === cur);
  // 默认会话（老的单会话文件，sid 为空）不撒谎：有标题就用标题，没标题就叫「会话」
  const name = row?.title || (cur ? '新会话' : '会话');
  btn.title = `${name} · 点击切换或新建会话`;
  btn.setAttribute('aria-label', `当前会话：${name}。点击切换或新建会话`);
  const label = $('#sessLabel');
  if (label) label.textContent = name;
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
      const cached = op.id !== 'visual' && !!teachingEntryFor(op.id);
      return el('button', {
        class: 'ops-item' + (cached ? ' cached' : ''),
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
        el('span', { class: 'ops-title', text: op.title + (cached ? ' · 已生成' : '') + progress }),
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

/** 会话里找到某能力最近一条已完成回答（用于菜单「已生成」与缓存命中） */
function teachingEntryFor(opId) {
  const op = teachingOpById(opId);
  if (!op) return null;
  return [...state.sessionEntries].reverse().find((x) => x?.block === 'chat' && x?.tag === op.title
    && (x.status === 'complete' || x.status === 'stopped') && x?.kind !== 'user') || null;
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
    const candidates = list
      .filter((s) => (s.sid || '') !== current && (s.count || 0) > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 2);
    const parts = [];
    for (const s of candidates) {
      const r = await fetch(`/api/session?doc=${encodeURIComponent(docId)}&sid=${encodeURIComponent(s.sid || '')}`);
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


function teachingCacheKey(docId, opId, suffix = '') {
  return `${docId}:${opId}:${TEACHING_PROMPT_VERSION}:p${profileStore.data.revision}${suffix ? `:${suffix}` : ''}`;
}

function teachingCacheGet(docId, opId) {
  return state.teachingCache.get(teachingCacheKey(docId, opId)) || null;
}

function teachingCacheSet(docId, opId, value) {
  state.teachingCache.set(teachingCacheKey(docId, opId), value);
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

  // 缓存只给「一次生成、内容稳定」的三项；图表公式依赖页/对象，不缓存
  if (!force && opId !== 'visual' && !retryEntry && !history.length) {
    const hit = teachingCacheGet(docId, opId);
    // 恢复出来的会话里已经有这条结果（跨重启的「已生成」）：直接定位过去，不重新花钱
    const existing = teachingEntryFor(opId);
    if (existing) {
      showAiBlock('chat');
      existing.root?.scrollIntoView?.({ block: 'nearest' });
      toast(`「${op.title}」已在结果区，点「重新生成」可以重跑`, 'ok', 3000);
      return hit || { text: String(existing.text || '') };
    }
    if (hit) {
      // 缓存有、DOM 没有（清过问答区）：直接把缓存内容补回一条结果，不重新花钱
      const restored = addEntry({ block: 'chat', tag: entryTag, text: hit.text, kind: 'assistant', retry: { kind: 'teaching', docId, opId, block: 'chat', ask, extraUser: extraUser.slice(0, 4000), ...(teaching ? { teaching } : {}) } });
      finishEntry(restored, hit.text, { page: hit.page || null, retryLabel: '重新生成', onRetry: () => runTeaching(opId, { force: true, retryEntry: restored, extraUser, ask, tag, teaching }) });
      renderTeachingExtras(restored, { opId, chips: hit.chips || [], teaching: hit.teaching || teaching });
      return hit;
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
    const ctx = await buildDocContext(op.ask, extraUser || '', { forTeaching: true, page: viewer.current });
    const messages = teachMessages(op, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
      extraUser,
      ask,
      history,
      pageImages: ctx?.pageImages || [],
      profileBlock: teachingProfileBlock(ask || op.ask),
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
    target.done(clean);
    finishEntry(entry, clean, {
      page: viewer.current, retryLabel: '重新生成',
      onRetry: () => runTeaching(opId, { force: true, retryEntry: entry, extraUser, ask, tag, teaching }),
    });
    renderTeachingExtras(entry, { opId, chips: split.chips, teaching });
    if (opId === 'walk' && !history.length) startWalkSession(clean, entry);
    if (opId !== 'visual' && !history.length) {
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
        page: viewer.current, status: 'stopped',
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
      showAiBlock(block);
      existing.root?.scrollIntoView?.({ block: 'nearest' });
      toast(`「${op.title}」已在结果区，点「重新生成」可以重跑`, 'ok', 3000);
      state.opsDone[opId] = true;
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
    const messages = opMessages(op, {
      docTitle: state.doc?.name,
      fullText: ctx?.text,
      digest: state.docDigest,
      pageImages: ctx?.pageImages || [],
      profileBlock: teachingProfileBlock(op.ask),
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
    target.done(full);
    state.opsCache.set(cacheKey, { text: full, at: Date.now(), page: viewer.current });
    state.opsDone[opId] = true;
    if (state.opsDoc !== docId) { state.opsDoc = docId; }
    finishEntry(entry, full, {
      page: viewer.current,
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
 * 回答正文渲染：先剥掉 prt 隐藏块，再把 〔p.N〕 / 〔p.N–M〕 变成可点击页码。
 * 渲染失败/页码越界时保持普通文字，不影响回答本身。
 */
function decoratePageRefs(html) {
  const pages = Number(viewer?.numPages) || 0;
  return String(html || '').replace(/〔p\.(\d{1,4})(?:[–\-](\d{1,4}))?〕/g, (raw, a, b) => {
    const p = Number(a);
    if (!Number.isInteger(p) || p < 1 || (pages && p > pages)) return raw;
    const label = b ? `p.${a}–${b}` : `p.${a}`;
    const title = b ? `跳到第 ${a}–${b} 页` : `跳到第 ${a} 页`;
    return `<button type="button" class="page-ref" data-page="${p}" title="${title}">${label}</button>`;
  });
}

function renderAnswerHTML(text) {
  const split = splitPrtBlock(String(text || ''));
  return decoratePageRefs(renderMarkdown(split.text || ''));
}

/** 页码按钮：按住委托，流式重绘也不用重绑 */
function initPageRefs() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-ref');
    if (!btn) return;
    const page = Number(btn.dataset.page);
    if (!Number.isInteger(page) || page < 1) return;
    e.preventDefault();
    jumpToPageWithHistory(page, { smooth: true });
  });
}

function streamTarget(node) {
  let pending = null;
  let rawNode = null;
  let paintedText = '';
  let cursorNode = null;
  const scan = { cursor: 0, safe: 0, fence: '', inMath: false };
  let raf = 0;
  let timer = 0;
  const stopTimers = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
  };
  const ensureTail = () => {
    if (rawNode?.parentNode === node) return;
    rawNode = document.createTextNode('');
    cursorNode = el('span', { class: 'cursor' });
    node.append(rawNode, cursorNode);
  };
  const paint = () => {
    stopTimers();
    if (pending === null) return;
    const parent = node.closest('.ai-body');
    const entry = node.closest('.msg');
    // 新结果保持在视口顶部；一旦用户手动上滑，后续分块不再抢回滚动位置。
    const follow = parent && entry && Math.abs(parent.scrollTop - entry.offsetTop) < 100;
    // 回答末尾的 prt 隐藏块（程序用）不能露给用户看：出现就截断
    const display = hideStreamTail(pending);
    if (!display.startsWith(paintedText)) {
      node.replaceChildren();
      rawNode = null;
      cursorNode = null;
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
    if (follow) requestAnimationFrame(() => { parent.scrollTop = entry.offsetTop; });
  };
  return {
    push(text) {
      pending = text;
      if (raf || timer) return;
      raf = requestAnimationFrame(paint);
      timer = setTimeout(paint, 120);   // rAF 被节流时的兜底
    },
    done(finalText) {
      stopTimers();
      pending = null;
      node.innerHTML = renderAnswerHTML(finalText);
      rawNode = null; cursorNode = null; paintedText = '';
      scrollEntryToTop(node.closest('.ai-body'), node.closest('.msg'));
    },
    fail(msg) {
      stopTimers();
      pending = null;
      node.innerHTML = `<span style="color:var(--err)">${esc(msg)}</span>`;
      rawNode = null; cursorNode = null; paintedText = '';
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

/** 统一入口：注入空闲超时，避免界面像卡死一样一直转 */
function chat(opts) {
  return streamChat({ idleMs: Number(Settings.data.idleMs) || 60000, ...opts });
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
  const scopeBtn = $('#optScope');
  if (scopeBtn) scopeBtn.disabled = on;
  if (on) closeScopePanel();
  else renderScopeMenu();
  const clearBtn = $('#clearSession');
  if (clearBtn) clearBtn.disabled = on;
  updateSendScope();
}

/** 输入框旁边那句范围提示（`#sendScope`）：只讲这次会发什么，不再讲带了几轮历史。 */
function sendScopeText({ attachments, history, useFullText, useWeb, query, docId, fullMode, contextIncluded, scanned = false, scanPageCount = 0, docMode = '' } = {}) {
  const rows = attachments || [];
  const quotes = rows.filter((a) => a.kind === 'text');
  const images = rows.filter((a) => a.kind === 'image');
  const parts = [];
  if (quotes.length) parts.push(`选区 ${quotes.length} 段`);
  if (images.length) parts.push(`图片 ${images.length} 张`);
  const hasDoc = !!docId && !!viewer?.pdf && state.doc?.docId === docId && state.viewerDocId === docId;
  if (hasDoc && scanned && docMode === 'scan-ocr') parts.push('OCR 文字版');
  else if (hasDoc && (contextIncluded === undefined ? true : contextIncluded)) {
    parts.push(scanPageCount ? `页图 ${scanPageCount} 张` : (quotes.length ? '附近上下文' : '当前页上下文'));
  }
  if (hasDoc && useFullText) {
    let mode = fullMode;
    if (!mode && state.docTextDoc === docId) {
      mode = !state.docText ? 'unavailable' : (state.docText.length > FULL_LIMIT ? 'digest' : 'full');
    }
    if (mode === 'full') parts.push('整篇论文');
    else if (mode === 'digest') parts.push(`整篇论文索引 + ${PICK_K} 段相关原文`);
    else if (mode === 'scan-ocr') parts.push('整篇论文（OCR 文字版）');
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
  const node = $('#sendScope');
  if (!node) return;
  // 范围上拉栏现在真的有用了：内容由 renderScopeRange() 填，
  // 收起态由 .hidden 控制。这里只保证「不忙的时候两处状态一致」。
  renderScopeRange();
}

function syncScopePrefs() {
  state.useFullText = uiStyle.useFullText !== false;
  state.useWeb = uiStyle.useWeb !== false;
  // 设置页的「默认发送范围」= 初始值：偏好一变，发送框的范围跟着变（之后用户可临时改）
  state.scopeRange = rangeFromPrefs();
  renderScopeRange();
  updateSendScope();
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

async function doTranslate(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  const lang = targetLangFor(text);
  const key = `${lang}::${text.length}-${hashStr(text)}`;
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

async function doExplain(sel) {
  if (state.busy) return;
  const text = sel.cleanText || cleanText(sel.text);
  if (!text || !ensureReady()) return;
  const docId = state.doc?.docId || null;
  const openSeq = state.openSeq;
  const sid = activeSidFor(docId);
  const history = snapshotHistory(state.history);
  const reading = resolveReadingRequest({ question: '请解释这段内容涉及的知识。', selection: text, page: sel.page, history });
  // 「释」直接写在侧栏里，不弹浮层 —— 解释是要读的，不是瞄一眼的
  revealPanel('chat');
  const entry = addEntry({ block: 'chat', tag: 'explanation', page: sel.page, quote: text,
    retry: { kind: 'explain', docId: state.doc?.docId || null, text, page: sel.page || null } });
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
    const full = await chat({
      messages: explainMessages({ selection: text, context, page: sel.page, docTitle: state.doc?.name, history, reading, references,
        profileBlock: askProfileBlock(text + "\n" + context, reading.question, { docId }) }),
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    if (!readingRequestCurrent({ docId, openSeq, sid })) return;
    target.done(full);
    state.history = snapshotHistory([...state.history, ...readingTurn(reading, full)]);
    scheduleSessionSummary();
    finishEntry(entry, full, { page: sel.page, onAsk: () => addToChat(sel) });
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
  state.attachments.push({
    id: uid(), kind: 'text', page: sel.page || viewer?.current, text,
    // 来源只用于附件行的提示：正文划选 / 右栏回答或译文里划选
    from: sel.source === 'right' ? 'right' : '',
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
  revealPanel('chat');            // 同上：截图进来时也要让用户看得见它加到了哪里
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


function initComposer() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#stopBtn').onclick = () => { abortStream('user'); setHint('正在停止…'); };
  $('#clipBtn').onclick = () => state.startRegion?.();
  // 「清空会话」不再常驻在输入框下面，改挂在会话菜单里。
  // 这里的绑定用可选链，元素不在也不抛。
  const clearBtn = $('#clearSession');
  if (clearBtn) clearBtn.onclick = clearCurrentSession;
  renderAttachments();

  $('#composer')?.addEventListener('click', (e) => {
    if (e.target.closest('#composerScope')) { e.preventDefault(); toggleScopePanel(); return; }
    const opt = e.target.closest('#sendScope .scope-opt');
    if (opt && !opt.disabled) {
      e.preventDefault();
      setScopeRange(opt.dataset.range);
      toast(`发送范围：${SCOPE_RANGES[opt.dataset.range].short}`, '', 1200);
    }
  });
  // 面板里点到空白不要冒泡成提交
  $('#sendScope')?.addEventListener('click', (e) => { if (!e.target.closest('.scope-opt')) e.preventDefault(); });
  renderScopeMenu();
  renderScopeRange();

  const ta = $('#chatInput');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') closeScopePanel();
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(130, ta.scrollHeight)}px`;
    updateSendScope();
  });
}


/** 整篇论文此刻能不能开：要有一篇真的装好的论文 */
const fullScopeAvailable = () => !!state.doc && !!viewer?.pdf && state.viewerDocId === state.doc?.docId;

function renderScopeMenu() { renderScopeRange(); }


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
const SCOPE_RANGE_ORDER = ['current', 'paper', 'web', 'paper-web'];

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

/** 「整篇论文」此刻能不能用：要有一篇真的装好的论文 */
function rangeAvailable(key) {
  if (key === 'paper' || key === 'paper-web') return fullScopeAvailable();
  return true;
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

/** 发送框上的范围芯片 + 上拉栏里的选中态（两处必须同步） */
function renderScopeRange() {
  const key = currentRange();
  const r = SCOPE_RANGES[key];
  const chip = $('#composerScope');
  if (chip) {
    chip.dataset.range = key;
    // ⚠️ 必须是 iconHTML（返回字符串）：iconEl 返回节点，拼进模板字符串会变成
    //    "[object SVGSVGElement]" —— 界面上表现为芯片里出现一行鬼话。
    chip.innerHTML = `${iconHTML(r.icon, { size: 14 })}<span>${r.short}</span>`;
    chip.title = `发送范围：${r.short} —— ${r.desc}`;
    chip.setAttribute('aria-label', `发送范围：${r.desc}。点击可改。`);
  }
  const panel = $('#sendScope');
  if (panel) {
    panel.innerHTML = SCOPE_RANGE_ORDER.map((k) => {
      const item = SCOPE_RANGES[k];
      const on = k === key;
      const ok = rangeAvailable(k);
      return `<button type="button" class="scope-opt${on ? ' is-on' : ''}" role="radio"
        aria-checked="${on ? 'true' : 'false'}" data-range="${k}" ${ok ? '' : 'disabled'}
        title="${item.desc}${ok ? '' : '（先打开一篇论文）'}">
        <span class="scope-dot" aria-hidden="true"></span>
        <span class="scope-ico">${iconHTML(item.icon, { size: 14 })}</span>
        <span class="scope-txt">${item.desc}</span>
      </button>`;
    }).join('');
  }
  updateComposerHint();
}

/** 点范围面板 / 芯片之外的地方 → 收起（一次性自摘） */
function scopeAway(e) {
  if (e.target.closest && (e.target.closest('#sendScope') || e.target.closest('#composerScope'))) return;
  closeScopePanel();
}

function closeScopePanel() {
  const panel = $('#sendScope');
  document.removeEventListener('pointerdown', scopeAway, true);
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.add('hidden');
  $('#composerScope')?.setAttribute('aria-expanded', 'false');
}

function toggleScopePanel() {
  const panel = $('#sendScope');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    renderScopeRange();
    panel.classList.remove('hidden');
    $('#composerScope')?.setAttribute('aria-expanded', 'true');
    // 点面板外面就收起。监听挂在 document 捕获阶段，且每次打开重新挂
    // （不用 setTimeout 延迟挂 —— 那会和「点完立刻点别处」的竞态撞车）。
    document.addEventListener('pointerdown', scopeAway, true);
  } else {
    closeScopePanel();
  }
}

function setScopeRange(key) {
  if (!SCOPE_RANGES[key]) return;
  state.scopeRange = key;
  renderScopeRange();
  closeScopePanel();
  // ⚠️ 这里不写 uiStyle 的两个偏好：范围是「本次发送」的，
  // 设置页的默认范围才是长期意图。state 的两个标记跟着当前范围走（发送时同源）。
  applyRangeForSend(key);
}

/** 输入框下面那行小字，用于显示进度；传空字符串清掉 */
function setHint(t) {
  const h = $('#composerHint');
  if (h) h.textContent = t || '';
}

/* ------------------------------------------------------------ 扫描件：页型 / 页图 / 图片阅读索引 */

const DOC_PROFILE_VERSION = 1;
const SCAN_DIGEST_VERSION = 1;
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
  return fp ? `reader.docProfile.v${DOC_PROFILE_VERSION}:${docId}:${fp}` : '';
}
function scanDigestCacheKey(docId) {
  const fp = paperFingerprint(docId);
  return fp ? `reader.scanDigest.v${SCAN_DIGEST_VERSION}:${docId}:${fp}` : '';
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
    if (key) localStorage.setItem(key, JSON.stringify(profile));
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

/* ------------------------------------------------------------ 扫描件 OCR（视觉模型逐页转写，结果缓存） */

const OCR_VERSION = 1;
/** OCR 逐页转写时的页图清晰度：比问答页图高一点，小字/手写才认得出 */
const OCR_PAGE_MAX_DIM = 1800;
/** 一次 OCR 最多跑多少页（防止误点把 500 页扫描件全转一遍） */
const OCR_PAGE_LIMIT = 80;

function ocrCacheKey(docId) {
  const fp = paperFingerprint(docId);
  return fp ? `reader.ocr.v${OCR_VERSION}:${docId}:${fp}` : '';
}
function loadOcrCache(docId) {
  const empty = { version: OCR_VERSION, pages: {}, at: 0 };
  try {
    const key = ocrCacheKey(docId);
    if (!key) return empty;
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (!parsed || parsed.version !== OCR_VERSION || !parsed.pages || typeof parsed.pages !== 'object') return empty;
    return parsed;
  } catch { return empty; }
}
function saveOcrCache(docId, cache) {
  try {
    const key = ocrCacheKey(docId);
    if (!key) return;
    const pages = {};
    // 只留非空页；按页码排好，方便读和比对
    for (const page of Object.keys(cache.pages || {}).sort((a, b) => Number(a) - Number(b))) {
      const text = String(cache.pages[page] || '').trim();
      if (text) pages[page] = text.slice(0, 12000);
    }
    localStorage.setItem(key, JSON.stringify({ version: OCR_VERSION, pages, at: Date.now() }));
  } catch { /* localStorage 满了不影响主流程 */ }
}
/** 已缓存 OCR 的页码（升序） */
function ocrPages(docId) {
  return Object.keys(loadOcrCache(docId).pages || {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
}
/** 把已缓存的 OCR 文本拼成带页码标记的整篇文本（与 getPageText 的全文格式一致） */
function ocrTextFor(docId) {
  const cache = loadOcrCache(docId);
  const pages = Object.keys(cache.pages || {}).map(Number).sort((a, b) => a - b);
  if (!pages.length) return '';
  return pages.map((p) => `===== p.${p} =====\n${String(cache.pages[p] || '').trim()}`).join('\n\n');
}

let ocrRunPromise = null;
/**
 * 扫描件「生成文字版」：逐页把页面图交给视觉模型转写，结果按页缓存（可中断、可续跑）。
 * 用前台 busy 状态 + 停止按钮；单页失败跳过并继续；已缓存的页默认不再花钱。
 * @returns {Promise<{pages:number[], cachedPages:number[], text:string}|null>}
 */
async function runOcrDoc({ force = false, onProgress = null } = {}) {
  if (!state.doc || !viewer?.pdf) { toast('先打开一篇论文', 'err'); return null; }
  if (state.busy) { toast('正在生成中，等它跑完或者点停止', 'err', 2600); return null; }
  if (!ensureReady()) return null;
  if (ocrRunPromise) return ocrRunPromise;
  warnIfNoVisionModel(true);
  const docId = state.doc.docId;
  const myTitle = state.doc?.name || '';
  const profile = await startDocProfileScan(docId).catch(() => null);
  if (state.doc?.docId !== docId) return null;
  if (!profile?.scanned) { toast('这篇 PDF 有文本层，不需要 OCR', 'ok', 2600); return null; }
  const allPages = (profile.scanPages || []).slice(0, OCR_PAGE_LIMIT);
  const targets = allPages.length ? allPages : Array.from({ length: Math.min(viewer.numPages, OCR_PAGE_LIMIT) }, (_, i) => i + 1);
  const cache = loadOcrCache(docId);
  const todo = force ? targets : targets.filter((p) => !String(cache.pages?.[p] || '').trim());
  if (!todo.length) {
    const pages = ocrPages(docId);
    toast(`文字版已存在（${pages.length} 页），直接使用缓存`, 'ok', 2600);
    return { pages, cachedPages: pages, text: ocrTextFor(docId) };
  }
  const ctl = makeController();
  if (!ctl) return null;
  ocrRunPromise = (async () => {
    setBusy(true, `OCR 0/${todo.length}`);
    let done = 0;
    let failed = 0;
    try {
      for (const page of todo) {
        if (ctl.signal.aborted || state.doc?.docId !== docId) break;
        setHint(`OCR：正在识别第 ${page} 页（${done + 1}/${todo.length}）…`);
        setBusy(true, `OCR ${done}/${todo.length}`);
        try {
          const shot = await viewer.capturePageImage(page, { maxDim: OCR_PAGE_MAX_DIM });
          if (ctl.signal.aborted || state.doc?.docId !== docId) break;
          const text = await chat({
            messages: attachPageImages(scanPageMessages({ page, docTitle: myTitle }), [shot]),
            signal: ctl.signal,
            stream: false,
            temperature: 0,
            idleMs: 45000,
          });
          const clean = String(text || '').trim();
          if (!clean) { failed += 1; continue; }
          cache.pages[page] = clean.slice(0, 12000);
          saveOcrCache(docId, cache);          // 逐页落盘：中途停止也保留已识别的页
          done += 1;
          onProgress?.(done, todo.length, page);
        } catch (e) {
          if (isAbort(e)) break;
          failed += 1;                          // 单页失败不挡后面的页
        }
      }
    } finally {
      setHint('');
      if (state.abort === ctl) { state.abort = null; state.abortReason = ''; setBusy(false); }
      ocrRunPromise = null;
    }
    if (state.doc?.docId !== docId) return null;
    const pages = ocrPages(docId);
    const text = ocrTextFor(docId);
    const stopped = ctl.signal.aborted;
    // 结果进右栏：正文显示前部（太长就读不动），复制/后续问答用完整缓存
    const head = failed || stopped
      ? `已识别 ${pages.length} 页${failed ? `，${failed} 页失败` : ''}${stopped ? '（已停止）' : ''}。`
      : `已识别 ${pages.length} 页。`;
    const shown = text.length > 18000
      ? `${text.slice(0, 18000)}\n\n…（共 ${text.length.toLocaleString()} 字，全文已缓存；提问时会自动使用，可点下方「复制」拿到全文）`
      : text;
    const entry = addEntry({ block: 'chat', tag: '文字版（OCR）', kind: 'assistant', page: 1,
      text: `${head}\n\n${shown}` });
    finishEntry(entry, text, { page: 1, status: stopped ? 'stopped' : 'complete' });
    toast(stopped ? `OCR 已停止，已识别 ${pages.length} 页（缓存保留）` : `文字版已生成（${pages.length} 页），之后的问答会自动使用`,
      failed ? 'err' : 'ok', failed ? 5200 : 3600);
    return { pages, cachedPages: pages, text };
  })();
  return ocrRunPromise;
}


/** 应用页型扫描结果：扫描件提示一次，并刷新发送范围提示 */
function applyDocProfile(docId, profile) {
  if (state.doc?.docId !== docId) return;
  state.docProfile = profile;
  state.docProfileDoc = docId;
  updateSendScope();
  if (profile?.scanned && !state.scanNoticeShown[docId]) {
    state.scanNoticeShown[docId] = true;
    const cachedPages = ocrPages(docId);
    const hasVision = String(Settings.data.visionModel || '').trim();
    if (cachedPages.length) {
      toastAction('扫描件：已有文字版（OCR）缓存，问答与读懂论文会直接用文字；需要时可重新识别',
        '重新识别', () => runOcrDoc({ force: true }), 'ok', 12000);
    } else if (!hasVision) {
      // 没有视觉模型时页面图会交给主模型，文本模型可能「假装看到了」——先把风险说清楚
      toastAction('扫描件：没有文本层，且未配置「视觉模型」。模型可能无法真正读图（回答可能靠猜）；请先到设置里填一个支持图片的模型',
        '去设置', () => openSettings('扫描件问答 / OCR 需要「视觉模型」：填一个能读图的模型名（如 gpt-4o、gemini-flash、Qwen-VL）'),
        'err', 16000);
    } else {
      toastAction('扫描件：没有文本层，问答与「读懂论文」将按页面图片理解。可生成文字版（OCR，逐页转写）',
        '生成文字版', () => runOcrDoc(), 'ok', 15000);
    }
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

/** 逐页渲染成图片（串行，失败跳过该页） */
async function renderScanPages(pages = []) {
  const shots = [];
  for (const p of pages) {
    try {
      const shot = await viewer.capturePageImage(p, { maxDim: 1400 });
      shots.push({ page: p, ...shot });
    } catch { /* 单页渲染失败不挡整次请求 */ }
  }
  return shots;
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
 * 扫描件的「图片阅读索引」：逐页转写 → 拼成可当作全文用的文本。
 * 首次在扫描件上触发教学能力时跑一次，按文件指纹缓存；失败返回空串（降级为只带页图）。
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
  // ① 扫描件：没有文本层 → 有 OCR 文字版就用文字；否则带页面图片（教学类再补图片阅读索引）
  const profile = await startDocProfileScan(myDoc).catch(() => null);
  if (!stillCurrent()) throw stale();
  if (profile?.scanned) {
    const targetPage = Number(page) || viewer?.current || 1;
    const ocrText = ocrTextFor(myDoc);
    if (ocrText) {
      const head = '【扫描件 OCR 文字版（可能有错字；以页面图片为准，引用原文时说明不确定）】';
      if (forTeaching) {
        // 教学类：OCR 文字比图片阅读索引更全，直接用；再带当前页图帮助看图表/公式
        const pageImages = await renderScanPages([targetPage]);
        if (!stillCurrent()) throw stale();
        const body = ocrText.length > 24000
          ? pickRelevantPages(ocrText, `${question}\n${selection || ''}`, PICK_K, 2400)
          : ocrText;
        setHint('');
        return {
          text: `${head}\n${body}`, mode: 'scan-ocr', chars: ocrText.length, profile, pageImages,
        };
      }
      let body = '';
      if (whole) {
        body = ocrText.length > 60000
          ? pickRelevantPages(ocrText, `${question}\n${selection || ''}`, PICK_K, 2400)
          : ocrText;
      } else {
        const current = pageTextOf(ocrText, targetPage).trim();
        body = current || pickRelevantPages(ocrText, `${question}\n${selection || ''}`, 2, 2400);
      }
      setHint('');
      return { text: `${head}\n${body}`, mode: 'scan-ocr', chars: ocrText.length, profile, pageImages: [] };
    }
    if (forTeaching) {
      setHint('扫描件：正在准备页面图片与阅读索引…');
      const digest = await ensureScanDigest(myDoc, profile);
      if (!stillCurrent()) throw stale();
      const pageImages = await renderScanPages([targetPage]);
      if (!stillCurrent()) throw stale();
      setHint('');
      return {
        text: digest ? `【图片阅读索引】\n${digest}` : '',
        mode: 'scan-digest', chars: digest.length, profile, pageImages,
      };
    }
    setHint('扫描件：正在准备页面图片…');
    const pages = pickScanPages(profile, { question, page: targetPage, whole });
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

async function send(retryPending = null) {
  const ta = $('#chatInput');
  if (state.busy) return;
  let pending = retryPending;
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

  if (!pending) {
    const inputValue = ta.value;
    const q = inputValue.trim();
    const attachments = state.attachments.slice();
    if (!q && !attachments.length) return;
    const quotes = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image');
    const quoteText = quotes.map((a) => (a.page ? `[第${a.page}页] ` : '') + a.text).join('\n\n');
    const attachmentPage = quotes[0]?.page || images[0]?.page || (state.doc ? viewer?.current : null);
    const question = q || (images.length
      ? '请识别并解释我加进来的这些内容（图/表/公式/文字），说明它们在论文里的作用。'
      : '请解释我加进来的这段内容。');
    const history = snapshotHistory(state.history);
    const reading = resolveReadingRequest({ question, selection: quoteText, page: attachmentPage, history });
    const firstPage = reading.page;
    pending = {
      inputValue, question, attachments, quoteText, firstPage, reading,
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
    pending.userEntry = addEntry({
      block: 'chat', kind: 'user', text: question, quote: reading.selection,
      thumbs: images.map((im) => im.dataUrl),
    });
    pending.entry = addEntry({
      block: 'chat', tag: 'answer', page: firstPage,
      retry: {
        kind: 'chat', docId: pending.docId, docTitle: pending.docTitle,
        inputValue: pending.inputValue, question: pending.question, quoteText: pending.quoteText,
        firstPage: pending.firstPage, attachments: pending.attachments,
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
    pending.entry.root.querySelectorAll('.entry-meta, .source-details, .src-list').forEach((node) => node.remove());
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
  const baseScope = sendScopeText({
    attachments: pending.attachments,
    history: pending.history,
    useFullText: pending.useFullText,
    useWeb: pending.useWeb,
    query: pending.inputValue,
    docId: pending.docId,
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
    pending.reading = reading;
    // 扫描件：先判定页型（命中缓存就不花时间）；扫描件无论范围如何都要带页面图片。
    const scanProfile = pending.docId ? await startDocProfileScan(pending.docId).catch(() => null) : null;
    if (!readingRequestCurrent(pending)) return;
    const scannedDoc = !!scanProfile?.scanned;
    pending.scanned = scannedDoc;
    // 没有选区时也带当前页上下文；扫描件没有文本层，改成带页图。
    const quotes = pending.attachments.filter((a) => a.kind === 'text');
    const contextParts = scannedDoc ? [] : (quotes.length ? await Promise.all(quotes.slice(0, 6).map(async (a) => {
      const nearby = await viewer.getContextAround(a.page || pending.firstPage, a.text);
      return nearby ? `[第${a.page || pending.firstPage}页]\n${nearby}` : '';
    })) : [pending.firstPage && pending.docId
      ? await viewer.getContextAround(reading.page || pending.firstPage, stripPageLabels(reading.selection)) : '']);
    const context = [...new Set(contextParts.filter(Boolean))].join('\n\n');
    const references = await readingReferences(reading.selection);
    if (!readingRequestCurrent(pending)) return;
    if (ctl.signal.aborted) throw new DOMException('已停止', 'AbortError');
    pending.scope = sendScopeText({
      attachments: pending.attachments, history: pending.history,
      useFullText: pending.useFullText, useWeb: pending.useWeb,
      query: pending.inputValue, docId: pending.docId, contextIncluded: !!context, scanned: scannedDoc,
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    // 联网是允许查找材料；短追问先确定对象，纠正消息和纯问号不会拿去检索。
    if (pending.useWeb && (!images.length || pending.inputValue.trim() || reading.selection)
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

    // ② 上下文。扫描件：页面图片（+ 整篇类问题的采样页）；普通论文：整篇全文 / 索引 + 相关段落。
    if (scannedDoc) {
      try {
        docCtx = await buildDocContext(pending.question, reading.selection || reading.focus.text, {
          page: reading.page || pending.firstPage,
          whole: pending.useFullText,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        docCtx = null;
        setHint('读取扫描页失败，这次只带问题本身');
      }
    } else if (pending.useFullText && pending.docId) {
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
      useFullText: pending.useFullText,
      useWeb: pending.useWeb,
      query: pending.inputValue,
      docId: pending.docId,
      scanned: scannedDoc,
      scanPageCount: docCtx?.pageImages?.length || 0,
      docMode: docCtx?.mode || '',
      fullMode: scannedDoc ? (pending.useFullText ? (docCtx?.mode || 'scan') : null)
        : (pending.useFullText ? (docCtx?.mode || 'unavailable') : null),
      contextIncluded: !!context,
    });
    state.activeSendScope = pending.scope;
    updateSendScope();

    if (!readingRequestCurrent(pending)) return;
    if (ctl.signal.aborted) throw new DOMException('已停止', 'AbortError');
    // 记忆块：学习画像 + 用户手写长期记忆 + 本篇之前的讨论 + 本次会话滚动摘要。
    // 教学进度（「带我一步步读」）也在这里带上，避免自由追问时模型擅自推进下一步。
    const profileForAsk = askProfileBlock(state.docText || context || '', pending.question,
      { docId: pending.docId });
    const messages = askMessages({
      question: pending.question,
      selection: reading.selection,
      context,
      page: pending.firstPage,
      docTitle: pending.docTitle,
      fullText: docCtx?.text,
      webResults: sources,
      history: pending.history,
      reading, references,
      pageImages: docCtx?.pageImages || [],
      profileBlock: profileForAsk,
      teachingBlock: teachingProgressBlock(),
    });
    // 图片有两种：用户自己加的截图 + 扫描件的页面上下文；同一条 user 消息里一起发。
    const pageImages = docCtx?.pageImages || [];
    if (images.length || pageImages.length) {
      const last = messages[messages.length - 1];
      const parts = [{ type: 'text', text: last.content }];
      for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      if (pageImages.length) {
        parts[0].text = `${parts[0].text}\n\n${pageImages.map((im) => `【第${im.page}页原图】见附图`).join('\n')}`;
        for (const im of pageImages) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      }
      last.content = parts;
    }
    // 右栏只呈现回答正文与来源，不显示全文字数、联网条数等内部统计。
    meta = '';
    warnIfNoVisionModel(images.length > 0 || pageImages.length > 0);

    setHint('');
    const full = await chat({
      messages,
      signal: ctl.signal,
      onDelta: (piece, all) => { received = all; target.push(all); },
      onTick: (ms) => setBusy(true, `${(ms / 1000).toFixed(0)}s`),
    });
    if (!readingRequestCurrent(pending)) return;
    target.done(full);
    state.history = snapshotHistory([...state.history, ...readingTurn(reading, full)]);
    scheduleSessionSummary();
    finishEntry(pending.entry, full, { page: pending.firstPage, sources: citedSources(full, sources), meta, status: 'complete' });
    scheduleMemoryExtraction({ question: pending.inputValue, answer: full, history: pending.history,
      topic: reading.selection || reading.focus?.text || '',
      source: { docId: pending.docId || '', paper: pending.docTitle || '', capability: 'chat' } });
    // 附件在发送那一刻就已从输入区清掉（dropSentAttachments），成功时无需再处理。
    scheduleSessionSave();
  } catch (e) {
    if (!readingRequestCurrent(pending)) return;
    if (isAbort(e)) {
      // 保留已经收到的回答；状态放在回答下方，绝不覆盖回答正文。
      target.done(received);
      finishEntry(pending.entry, received, {
        page: pending.firstPage, sources: citedSources(received, sources), meta, status: 'stopped', onRetry: () => send(pending),
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

  /** 进入 / 退出截图模式。顶部 ⎚ 和输入框边上的 ✂ 走的是同一个入口 */
  const startRegion = () => {
    if (!overlay.classList.contains('hidden')) { stop(); return; }
    if (!viewer?.pdf) { toast('先打开一篇 PDF', 'err'); return; }
    overlay.classList.remove('hidden');
    hint.classList.remove('hidden');
    $('#regionBtn')?.classList.add('on');
    $('#clipBtn')?.classList.add('on');
    hint.innerHTML = '拖动框住要加进对话的区域 · 拖到上下边缘会自动滚动（长截图）· <kbd>Esc</kbd> 取消';
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
    await captureToChat(topDoc, bottomDoc, leftVp, rightVp);
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

async function captureToChat(topDoc, bottomDoc, leftVp, rightVp) {
  if (state.busy) return;
  // 注意：截图本身不需要 API Key（图只是先放进附件区），
  // 所以这里绝不能调 ensureReady()，否则没配密钥时截图会被静默拦掉
  const a = locateDoc(topDoc);
  const b = locateDoc(bottomDoc);
  const pageEl = viewer.pageEls[a.page];
  if (!pageEl) return;
  const pr = pageEl.getBoundingClientRect();
  const x = clamp(leftVp - pr.left, 0, pr.width);
  const w = clamp(rightVp - pr.left, 0, pr.width) - x;
  if (w < 8) { toast('选框太窄', 'err'); return; }

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
    addImageToChat(shot, a.page, label, { allowBusy: true });
    showAiBlock('chat');
  } catch (e) {
    toast(`截图失败：${e.message}`, 'err', 4000);
  } finally {
    setBusy(false);
  }
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
  updateUiRangeLabels();
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
  const zoom = $('#uiZoomSpeed');
  const wasFullText = state.useFullText;
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

function openSettings(hint) {
  const modal = $('#settingsModal');
  modal.classList.remove('hidden');
  fillSettings();
  if (hint) { $('#testResult').className = 'test-result err'; $('#testResult').textContent = hint; }
  setTimeout(() => $('#cfgApiKey').focus(), 50);
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
  $('#closeSettings').onclick = closeSettings;
  $('#settingsModal').addEventListener('mousedown', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#toggleEndpoint').onclick = () => {
    $('#endpointField').classList.toggle('hidden');
    updateEndpointNote();
  };
  $('#cfgBaseURL').addEventListener('input', updateEndpointNote);
  // 设置页里「即时生效」的控件：主题、阅读字号、双指缩放速度，以及两个默认发送范围偏好
  // （第 2 步起范围回到发送框，设置页这两个勾 = 默认值；两个入口必须同一套语义，
  //   所以勾选也走 applyUiSettingsFromControls → syncScopePrefs → renderScopeRange）。
  ['uiTheme', 'uiFontSize', 'uiZoomSpeed', 'cfgUseFullText', 'cfgUseWeb']
    .forEach((id) => document.getElementById(id)?.addEventListener('input', applyUiSettingsFromControls));
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
      if (!$('#regionOverlay').classList.contains('hidden')) { state.stopRegion?.(); return; }
      if (!$('#settingsModal').classList.contains('hidden')) { closeSettings(); return; }
      if (!$('#searchBar').classList.contains('hidden')) { $('#searchClose').click(); return; }
      if (!$('#noteBox').classList.contains('hidden')) { saveNoteBox(); return; }
      if (state.abort) { abortStream('user'); $('#composerHint').textContent = '正在停止…'; return; }
      // Esc 是明确的「不要这个选区了」：连方块和记住的选区一起清掉
      if (state.selection) { clearSelectionState(); viewer?.clearSelection(); return; }
      hideBubble();
      return;
    }
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
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); state.startRegion?.(); return; }
    if (e.key === '+' || e.key === '=') { viewer?.setScale(viewer.scale * 1.15); return; }
    if (e.key === '-' || e.key === '_') { viewer?.setScale(viewer.scale / 1.15); return; }
    if (e.key === '0') { viewer?.fitWidth(); return; }
    if (e.key === 'PageDown') { e.preventDefault(); viewer?.goToPage(viewer.current + 1); return; }
    if (e.key === 'PageUp') { e.preventDefault(); viewer?.goToPage(viewer.current - 1); return; }
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

  // 停在首页。顺手清掉「上次那篇已经被删掉/移走」的陈旧标记，
  // 免得它一直挂在 state.json 里、下次又被当成有效记录（对应设计里的状态 5）。
  const stale = serverState.lastDoc
    && !state.papers.some((p) => p.docId === serverState.lastDoc || p.name === serverState.lastName);
  if (stale) {
    // 被删掉的那篇在 docs 里的阅读记录也要一起清：留着一个指向不存在文件的记录没有意义
    const docs = { ...(serverState.docs || {}) };
    delete docs[serverState.lastDoc];
    serverState = { ...serverState, docs, lastDoc: null, lastUrl: null, lastName: null };
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverState),
    }).catch(() => { /* 清不掉也不影响首页显示：recentDocs() 本来就会过滤掉它 */ });
  }
  setView('home');
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
      saveOnUnload(`/api/session?doc=${encodeURIComponent(state.doc.docId)}`, sessionPayload());
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
