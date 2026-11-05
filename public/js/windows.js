/** Multi-window coordination. No user credentials or PDF bytes cross windows. */
import { windowId, windowStorage, storageKey } from './window-storage.js';
export { windowId, windowStorage, storageKey } from './window-storage.js';
const rawStorage = window.localStorage;
export const desktopWindows = !!window.__PRT_WINDOW_ID;
const nativePost = (type, extra = {}) => window.ipc?.postMessage(JSON.stringify({ ...extra, type }));
const newKey = () => `w-${crypto.randomUUID()}`;
const stateKey = (id = windowId) => `reader.window.${id}.progress`;
const readJSON = (key, fallback = {}) => { try { return JSON.parse(rawStorage.getItem(key) || 'null') || fallback; } catch { return fallback; } };
const claims = new Map();
const releases = new Map();
const pendingClaims = new Map();
const requests = new Map();
let hooks = {};
let windowRows = [];
let menu = null;
let closeInFlight = false;
let closed = false;
let ready = false;
let layoutPage = null;
const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('prt.reader.windows') : null;

function resource(url) {
  if (url.pathname !== '/api/session' && url.pathname !== '/api/notes') return '';
  return `${url.pathname}:${url.searchParams.get('doc') || 'default'}:${url.searchParams.get('sid') || ''}`;
}
const ownerKey = (key) => `reader.window.owner.${key}`;
export function releaseDocument(docId) {
  for (const key of [`/api/notes:${docId}:`, `/api/session:${docId}:__translate`]) {
    releases.get(key)?.(); releases.delete(key);
    // A stale parked view must never reacquire and save without reading the latest file first.
    claims.set(key, false);
    if (rawStorage.getItem(ownerKey(key)) === windowId) rawStorage.removeItem(ownerKey(key));
  }
}
async function claim(key, refresh = false) {
  if (!key) return true;
  if (claims.get(key) === true) return true;
  if (!refresh && claims.has(key)) return false;
  if (pendingClaims.has(key)) return pendingClaims.get(key);
  // Fail closed if Web Locks are unavailable; all supported WebView2/Chrome builds have them.
  if (!navigator.locks) { claims.set(key, false); return false; }
  const promise = new Promise((resolve) => {
    navigator.locks.request(`prt.edit.${key}`, { ifAvailable: true }, async (lock) => {
      claims.set(key, !!lock);
      if (lock) rawStorage.setItem(ownerKey(key), windowId);
      resolve(!!lock);
      if (lock) await new Promise((release) => {
        releases.set(key, release);
        window.addEventListener('pagehide', release, { once: true });
      });
    }).catch(() => { claims.set(key, false); resolve(false); });
  });
  pendingClaims.set(key, promise);
  const result = await promise;
  pendingClaims.delete(key);
  updateNotice();
  return result;
}
const toURL = (value) => new URL(typeof value === 'string' || value instanceof URL ? value : value.url, location.href);
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Keep the existing authentication fetch underneath this wrapper.
const serviceFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = toURL(input);
  if (url.origin !== location.origin) return serviceFetch(input, init);
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  const key = resource(url);
  if (key) {
    const editable = await claim(key, method === 'GET');
    if (method !== 'GET' && !editable) {
      return jsonResponse({ error: { message: '另一个窗口正在编辑，请前往编辑窗口，或关闭它后重新载入。' } }, 409);
    }
  }
  if (url.pathname === '/api/state') {
    if (method === 'GET') {
      const r = await serviceFetch(input, init);
      if (!r.ok) return r;
      const base = await r.json();
      const own = readJSON(stateKey());
      return jsonResponse({ ...base, ...own, docs: { ...base.docs, ...own.docs } });
    }
    if (method === 'POST' && typeof init.body === 'string') {
      const own = JSON.parse(init.body);
      rawStorage.setItem(stateKey(), JSON.stringify(own));
      // Merge under a cross-window lock, so an old snapshot cannot erase another paper's progress.
      const save = async () => {
        const r = await serviceFetch('/api/state');
        if (!r.ok) return r;
        const latest = await r.json();
        const docs = { ...latest.docs };
        for (const [id, item] of Object.entries(own.docs || {})) {
          if (!docs[id] || Number(item.ts || 0) >= Number(docs[id].ts || 0)) docs[id] = item;
        }
        return serviceFetch(input, { ...init, body: JSON.stringify({ ...latest, ...own, docs }) });
      };
      return navigator.locks ? navigator.locks.request('prt.save.progress', save) : save();
    }
  }
  return serviceFetch(input, init);
};

function currentURLs() { return hooks.resources?.() || {}; }
export async function canWrite(url) { return !url || claim(resource(toURL(url))); }
function noticeText() {
  const urls = currentURLs();
  const blocked = Object.entries(urls).filter(([, u]) => u && claims.get(resource(toURL(u))) === false);
  return blocked;
}
function updateNotice() {
  const notice = document.getElementById('windowEditNotice');
  if (!notice) return;
  const blocked = noticeText();
  notice.hidden = !blocked.length;
  if (!blocked.length) return;
  notice.querySelector('span').textContent = `${blocked.map(([name]) => name).join('、')}正在另一窗口编辑，此处只读。`;
  notice.querySelector('[data-owner]').onclick = () => {
    const key = resource(toURL(blocked[0][1]));
    const owner = rawStorage.getItem(ownerKey(key));
    if (desktopWindows) nativePost('window-focus', { key: owner });
    else bus?.postMessage({ type: 'focus', key: owner });
  };
}
export async function allowEdit(kind) {
  const url = currentURLs()[kind];
  if (await canWrite(url)) return true;
  updateNotice();
  hooks.notify?.(`${kind}正在另一个窗口编辑；可前往该窗口，或关闭它后重新载入。`);
  return false;
}

function renderWindowMenu() {
  if (!menu) return;
  menu.replaceChildren();
  const add = (text, fn) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ctx-item'; b.textContent = text;
    b.onclick = () => { menu.hidden = true; fn(); }; menu.append(b);
  };
  if (hooks.current?.()) add('当前论文在新窗口打开', () => openReaderWindow(hooks.current()));
  if (desktopWindows) {
    add('平铺所有窗口', () => nativePost('windows-tile'));
    for (const row of windowRows) add(`${row.key === windowId ? '✓ ' : ''}${row.title || 'prt'}`, () => nativePost('window-focus', { key: row.key }));
    add('保存窗口布局并退出', () => nativePost('windows-quit'));
  }
}

export async function openReaderWindow(doc, { move = false } = {}) {
  if (!doc?.docId) return;
  try {
    await hooks.save?.();
    const key = newKey();
    const request = newKey();
    // New windows inherit appearance and this document's current reading position, not its conversation.
    for (const k of ['reader.ui', 'reader.panels']) {
      const value = windowStorage.getItem(k);
      if (value !== null) rawStorage.setItem(storageKey(k, key), value);
    }
    const current = readJSON(stateKey());
    rawStorage.setItem(stateKey(key), JSON.stringify({
      docs: current.docs?.[doc.docId] ? { [doc.docId]: current.docs[doc.docId] } : {},
      lastDoc: doc.docId, lastName: doc.name, lastUrl: doc.url,
    }));
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        requests.delete(request);
        if (desktopWindows) nativePost('window-open-cancel', { request });
        reject(new Error('新窗口未确认打开，原标签已保留'));
      }, 45000);
      requests.set(request, { resolve, reject, timeout });
    });
    if (desktopWindows) nativePost('window-open', { key, doc: doc.docId, request });
    else {
      const url = new URL(location.href); url.search = '';
      url.searchParams.set('readerWindow', key); url.searchParams.set('document', doc.docId);
      url.searchParams.set('windowRequest', request);
      const child = window.open(url.href, '_blank');
      if (!child) completeRequest({ request, ok: false, error: '浏览器阻止了新窗口，请允许本站弹出窗口' });
    }
    await result;
    if (move) {
      await hooks.closeTab?.(doc.docId);
      // Only hand editing ownership over after the original tab has actually closed.
      if (hooks.hasTab?.(doc.docId)) throw new Error('原标签尚未关闭，请先保存后重试');
      releaseDocument(doc.docId);
      bus?.postMessage({ type: 'refresh-document', key });
    }
  } catch (e) { hooks.notify?.(String(e.message || e)); }
}

function completeRequest(message) {
  const request = requests.get(message.request);
  if (!request) return;
  requests.delete(message.request); clearTimeout(request.timeout);
  if (message.ok) request.resolve(); else request.reject(new Error(message.error || '新窗口打开失败'));
}
async function closeWindow() {
  if (closeInFlight) return;
  closeInFlight = true;
  try {
    await hooks.close?.();
    closed = true;
    nativePost('close-commit');
  } catch (e) {
    nativePost('close-cancel');
    hooks.notify?.(`保存失败，窗口已保留：${e.message || e}`);
  } finally { closeInFlight = false; }
}
window.addEventListener('prt-desktop', ({ detail }) => {
  if (detail.type === 'place') { layoutPage = hooks.page?.(); nativePost('window-place', detail); }
  if (detail.type === 'placed') setTimeout(() => { if (layoutPage) hooks.restorePage?.(layoutPage); layoutPage = null; }, 450);
  if (detail.type === 'open-result') completeRequest(detail);
  if (detail.type === 'windows') { windowRows = detail.windows; renderWindowMenu(); }
  if (detail.type === 'close-request') closeWindow();
});
bus?.addEventListener('message', ({ data }) => {
  if (data.type === 'open-result') completeRequest(data);
  if (data.type === 'focus' && data.key === windowId) window.focus();
  if (data.type === 'refresh-document' && data.key === windowId) location.reload();
});

export function windowReady() {
  if (!ready) return;
  const doc = hooks.current?.();
  if (desktopWindows) nativePost('window-ready', { doc: doc?.docId || '', title: doc?.name || '书架' });
  const url = new URL(location.href);
  const request = url.searchParams.get('windowRequest');
  if (request) bus?.postMessage({ type: 'open-result', request, ok: doc?.docId === url.searchParams.get('document') });
  if (url.searchParams.has('document')) {
    url.searchParams.delete('document'); url.searchParams.delete('windowRequest');
    history.replaceState(null, '', url.href);
  }
  updateNotice();
}
export function startWindows(callbacks) {
  hooks = callbacks;
  const button = document.createElement('button');
  button.id = 'windowsBtn'; button.type = 'button'; button.className = 'tbtn';
  button.textContent = '窗口'; button.title = '多文档窗口'; button.setAttribute('aria-haspopup', 'menu');
  document.getElementById('homeBtn')?.before(button);
  menu = document.createElement('div'); menu.id = 'windowsMenu'; menu.className = 'ctx-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu'); document.body.append(menu);
  button.onclick = () => {
    const show = menu.hidden; renderWindowMenu(); menu.hidden = !show;
    if (desktopWindows) nativePost('windows-list');
    const r = button.getBoundingClientRect(); menu.style.top = `${r.bottom + 5}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
  };
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !button.contains(e.target)) menu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });
  const notice = document.createElement('div'); notice.id = 'windowEditNotice'; notice.hidden = true;
  notice.innerHTML = '<span></span><button type="button" data-owner>前往编辑窗口</button><button type="button" data-reload>重新载入</button>';
  notice.querySelector('[data-reload]').onclick = async () => {
    try { await hooks.save?.(); location.reload(); } catch (e) { hooks.notify?.(e.message || String(e)); }
  };
  document.getElementById('tabBarMount')?.after(notice);
}
export function finishWindowBoot() { ready = true; windowReady(); }
export const isWindowClosed = () => closed;
