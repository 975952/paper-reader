import { windowStorage as localStorage } from './window-storage.js';
/**
 * 多标签工作区（B 线 P0/P1 骨架）：工作区存储 + 标签条 + Welcome 语义。
 *
 * 范围（对应 docs/多标签工作区-设计.md §11）：
 *  - P0：`reader.tabs` 功能开关、`reader.workspace.v1` 工作区存储（打开顺序 / 活动标签 / 恢复）；
 *  - P1：标签条 DOM/CSS、打开/激活/关闭/去重/顺序、Welcome（无标签=书架页）、
 *        拖拽排序、溢出菜单、快捷键、10 个上限、刷新恢复。
 *  - P2/P3（热切换 / 文件夹会话 / 译文存档 / 后台任务）不在本文件范围。
 *
 * 本模块不直接依赖 app.js（避免循环 import）：标签条通过回调把「用户点了什么」交回 app.js，
 * 由 app.js 决定是否真的切换文档（冷切换仍走原有 openDoc 逻辑）。
 */

export const TABS_MAX = 10;
export const WORKSPACE_KEY = 'reader.workspace.v1';
export const TABS_FLAG_KEY = 'reader.tabs';

const docKey = (doc) => String(doc?.docId || '');

/** 功能开关：默认开启；`reader.tabs=0` 可退回旧单文档行为（回归/应急） */
export function tabsFeatureEnabled() {
  try {
    const raw = localStorage.getItem(TABS_FLAG_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch { /* localStorage 不可用时按默认 */ }
  return true;
}

export function setTabsFeatureEnabled(on) {
  try { localStorage.setItem(TABS_FLAG_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/** 清洗一个标签记录（只留已知字段，docId 必填） */
function normaliseTab(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const docId = String(raw.docId || '').trim();
  if (!docId) return null;
  return {
    docId: docId.slice(0, 240),
    name: String(raw.name || docId).slice(0, 300),
    url: String(raw.url || '').slice(0, 2000),
    path: String(raw.path || raw.name || '').slice(0, 1000),
  };
}

/** 读工作区：{tabs:[...], active:docId, updatedAt}；坏数据一律当空工作区 */
export function loadWorkspace() {
  const empty = { tabs: [], active: '', updatedAt: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.tabs)) return empty;
    const seen = new Set();
    const tabs = [];
    for (const item of raw.tabs) {
      const tab = normaliseTab(item);
      if (!tab || seen.has(tab.docId)) continue;
      seen.add(tab.docId);
      tabs.push(tab);
      if (tabs.length >= TABS_MAX) break;
    }
    const active = tabs.some((t) => t.docId === raw.active) ? String(raw.active) : (tabs[0]?.docId || '');
    return { tabs, active, updatedAt: Number(raw.updatedAt) || 0 };
  } catch {
    return empty;
  }
}

export function saveWorkspace(ws) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({
      tabs: (ws?.tabs || []).map(normaliseTab).filter(Boolean).slice(0, TABS_MAX),
      active: String(ws?.active || ''),
      updatedAt: Date.now(),
    }));
  } catch { /* 存不进就别挡用户 */ }
}

/** 最近关闭的标签（Ctrl+Shift+T 重开；只在内存里，重启后不保留） */
const closedStack = [];
export function pushClosedTab(tab) {
  const t = normaliseTab(tab);
  if (!t) return;
  const i = closedStack.findIndex((x) => x.docId === t.docId);
  if (i >= 0) closedStack.splice(i, 1);
  closedStack.unshift(t);
  if (closedStack.length > TABS_MAX) closedStack.pop();
}
export function popClosedTab() {
  return closedStack.shift() || null;
}
export function closedTabCount() {
  return closedStack.length;
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * 标签条控制器。
 * @param {object} opts
 * @param {HTMLElement} opts.mount 挂载容器（里面自己建 tabstrip + 溢出按钮）
 * @param {(docId:string)=>void} opts.onActivate 点标签（激活/冷切换）
 * @param {(docId:string)=>void} opts.onClose 点关闭
 * @param {(doc:{docId,name,url,path})=>void} opts.onOpenDoc 从溢出菜单打开未打开文档
 * @param {(docId:string, index:number)=>void} opts.onReorder 拖拽排序完成
 * @param {()=>Array<{docId,name,url,path,folder}>} [opts.listFolderDocs] 溢出菜单里的「当前文件夹文档」
 */
export function createTabBar({ mount, onActivate, onClose, onOpenDoc, onReorder, onNewWindow, listFolderDocs } = {}) {
  const root = document.createElement('div');
  root.className = 'tab-bar';
  root.id = 'tabBar';
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', '已打开的论文');
  const strip = document.createElement('div');
  strip.className = 'tab-strip';
  strip.id = 'tabStrip';
  const more = document.createElement('button');
  more.className = 'tab-more';
  more.id = 'tabMoreBtn';
  more.type = 'button';
  more.title = '全部标签 / 当前文件夹文档';
  more.setAttribute('aria-label', '全部标签');
  more.textContent = '⌄';
  more.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  root.append(strip, more);
  mount.append(root);

  const menu = document.createElement('div');
  menu.className = 'tab-menu hidden';
  menu.id = 'tabMenu';
  document.body.append(menu);

  let list = [];
  let activeId = '';
  let drag = null;
  let menuOpen = false;

  const render = (tabs = list, active = activeId) => {
    list = Array.isArray(tabs) ? tabs : [];
    activeId = String(active || '');
    strip.replaceChildren();
    for (const tab of list) {
      const el = document.createElement('div');
      el.className = `doc-tab${tab.docId === activeId ? ' active' : ''}`;
      el.dataset.doc = tab.docId;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', tab.docId === activeId ? 'true' : 'false');
      el.title = tab.name || tab.docId;
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.name || tab.docId;
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.title = '关闭标签';
      close.setAttribute('aria-label', `关闭 ${tab.name || tab.docId}`);
      close.textContent = '×';
      close.onclick = (e) => { e.stopPropagation(); onClose?.(tab.docId); };
      el.append(title, close);
      el.addEventListener('click', () => onActivate?.(tab.docId));
      const showContext = (x, y) => {
        menu.replaceChildren();
        for (const [label, action] of [
          ['在新窗口打开', () => onNewWindow?.(tab.docId, false)],
          ['移到新窗口', () => onNewWindow?.(tab.docId, true)],
          ['关闭标签', () => onClose?.(tab.docId)],
        ]) {
          const button = document.createElement('button'); button.type = 'button';
          button.className = 'tab-menu-item'; button.textContent = label;
          button.onclick = () => { closeMenu(); action(); }; menu.append(button);
        }
        menu.style.left = `${Math.max(8, Math.min(innerWidth - 280, x))}px`;
        menu.style.top = `${Math.max(8, Math.min(innerHeight - 140, y))}px`;
        menu.classList.remove('hidden'); menuOpen = true;
        menu.querySelector('button')?.focus();
      };
      el.tabIndex = tab.docId === activeId ? 0 : -1;
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); showContext(e.clientX, e.clientY); });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault(); const r = el.getBoundingClientRect(); showContext(r.left, r.bottom);
        }
      });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); onClose?.(tab.docId); } });
      el.addEventListener('pointerdown', (e) => startDrag(e, tab, el));
      strip.append(el);
    }
    // 没有标签 = Welcome：标签条整体隐藏（由 app.js 切 #home 视图）
    root.classList.toggle('hidden', list.length === 0);
    document.body.classList.toggle('tabs-open', list.length > 0);
  };

  /* ── 拖拽排序（Pointer Events；不用 HTML5 DnD，避免幽灵图与 drop 目标问题） ── */
  const line = document.createElement('div');
  line.className = 'tab-insert-line hidden';
  strip.append(line);
  const startDrag = (e, tab, el) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tab-close')) return;
    drag = { tab, el, startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    el.setPointerCapture?.(e.pointerId);
    el.addEventListener('pointermove', onDragMove);
    el.addEventListener('pointerup', (ev) => endDrag(ev));
    el.addEventListener('pointercancel', (ev) => endDrag(ev));
  };
  const hitIndex = (clientX) => {
    const tabs = [...strip.querySelectorAll('.doc-tab')];
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };
  const showLine = (index) => {
    const tabs = [...strip.querySelectorAll('.doc-tab')];
    if (!tabs.length) { line.classList.add('hidden'); return; }
    let x;
    if (index >= tabs.length) x = tabs.at(-1).offsetLeft + tabs.at(-1).offsetWidth;
    else x = tabs[index].offsetLeft;
    line.style.left = `${x}px`;
    line.classList.remove('hidden');
  };
  /** 指针是否已离开标签条：拖出标签条 = 把这篇论文移到新窗口（m00244）。 */
  const isOutsideBar = (e) => {
    if (!e) return false;
    const r = strip.getBoundingClientRect();
    const pad = 24;
    return e.clientY > r.bottom + pad || e.clientX < r.left - pad || e.clientX > r.right + pad;
  };
  function onDragMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    drag.el.classList.add('dragging');
    drag.out = isOutsideBar(e);
    document.body.classList.toggle('tab-dragging-out', drag.out);
    if (drag.out) { line.classList.add('hidden'); return; }
    const idx = hitIndex(e.clientX);
    drag.insertAt = idx;
    showLine(idx);
  }
  function endDrag(e) {
    if (!drag) return;
    const { tab, moved, insertAt, out, el } = drag;
    el.removeEventListener('pointermove', onDragMove);
    el.removeEventListener('pointerup', endDrag);
    el.removeEventListener('pointercancel', endDrag);
    el.classList.remove('dragging');
    document.body.classList.remove('tab-dragging-out');
    line.classList.add('hidden');
    drag = null;
    if (!moved) return;
    // 拖出标签条：在新窗口打开并把原标签移过去（与右键「移到新窗口」同一语义）
    if (out || isOutsideBar(e)) { onNewWindow?.(tab.docId, true); return; }
    let idx = Number.isInteger(insertAt) ? insertAt : list.length;
    const from = list.findIndex((t) => t.docId === tab.docId);
    if (from >= 0 && idx > from) idx -= 1;
    if (from < 0 || idx === from) return;
    onReorder?.(tab.docId, idx);
  }

  /* ── 溢出菜单：全部标签 + 当前文件夹文档（P1 简版） ── */
  const currentFolder = () => {
    const first = list[0];
    return first?.path?.includes('/') ? first.path.slice(0, first.path.lastIndexOf('/')) : '';
  };
  function buildMenu() {
    menu.replaceChildren();
    const allTitle = document.createElement('div');
    allTitle.className = 'tab-menu-title';
    allTitle.textContent = `全部标签（${list.length}/${TABS_MAX}）`;
    menu.append(allTitle);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'tab-menu-empty';
      empty.textContent = '还没有打开的论文';
      menu.append(empty);
    }
    for (const tab of list) {
      const item = document.createElement('button');
      item.className = `tab-menu-item${tab.docId === activeId ? ' active' : ''}`;
      item.textContent = tab.name || tab.docId;
      item.title = tab.path || tab.name || tab.docId;
      item.onclick = () => { closeMenu(); onActivate?.(tab.docId); };
      menu.append(item);
    }
    // 当前文件夹里没打开的文档（按需打开）
    let folderDocs = [];
    try { folderDocs = listFolderDocs?.() || []; } catch { folderDocs = []; }
    const folder = currentFolder();
    const unopened = folderDocs.filter((d) => !list.some((t) => t.docId === d.docId)
      && (!folder || String(d.folder || '') === folder));
    const makeDocItem = (doc) => {
      const item = document.createElement('button');
      item.className = 'tab-menu-item';
      item.textContent = doc.name || doc.docId;
      item.title = doc.path || doc.name || doc.docId;
      item.onclick = () => { closeMenu(); onOpenDoc?.(doc); };
      return item;
    };
    if (unopened.length) {
      // 默认范围：当前文件夹里未打开的文档（用户在问「外面也能看」时，下面还有全库组）
      const t2 = document.createElement('div');
      t2.className = 'tab-menu-title';
      t2.textContent = folder ? `当前文件夹（${unopened.length} 篇未打开）` : '书架（未打开的论文）';
      menu.append(t2);
      for (const doc of unopened.slice(0, 20)) menu.append(makeDocItem(doc));
    }
    // 全部已导入文件（跨文件夹，按需打开）：所有导入的论文都能看，只是一次不铺满菜单
    const others = folderDocs.filter((d) => !list.some((t) => t.docId === d.docId)
      && (!folder || String(d.folder || '') !== folder));
    if (others.length) {
      const t3 = document.createElement('div');
      t3.className = 'tab-menu-title';
      t3.textContent = `全部已导入文件（其他文件夹 ${others.length} 篇，按需打开）`;
      menu.append(t3);
      for (const doc of others.slice(0, 20)) menu.append(makeDocItem(doc));
    }
  }
  function openMenu() {
    buildMenu();
    const r = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, r.left - 240))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.classList.remove('hidden');
    menuOpen = true;
  }
  function closeMenu() {
    menu.classList.add('hidden');
    menuOpen = false;
  }
  function toggleMenu() {
    if (menuOpen) closeMenu();
    else openMenu();
  }
  const onDocClick = (e) => {
    if (!menuOpen) return;
    if (e.target.closest?.('#tabMenu') || e.target.closest?.('#tabMoreBtn')) return;
    closeMenu();
  };
  document.addEventListener('click', onDocClick);
  const onKey = (e) => { if (e.key === 'Escape' && menuOpen) closeMenu(); };
  document.addEventListener('keydown', onKey);

  return {
    root,
    render,
    toggleMenu,
    closeMenu,
    get menuOpen() { return menuOpen; },
    get activeId() { return activeId; },
    get list() { return list.slice(); },
    destroy() {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      menu.remove();
      root.remove();
    },
  };
}

/** 标签标题的展示文本（过长截断交给 CSS；这里只去扩展名） */
export function tabLabel(name) {
  const s = String(name || '');
  return s.replace(/\.pdf$/i, '') || s;
}

export { docKey, normaliseTab };
