// Pure storage adapter: safe to import from Node-based prompt tests.
export const windowId = globalThis.__PRT_WINDOW_ID
  || (typeof location !== 'undefined' ? new URL(location.href).searchParams.get('readerWindow') : '') || 'main';
const localKeys = new Set(['reader.workspace.v1', 'reader.ui', 'reader.panels', 'reader.activeSession',
  'reader.currentFolder.v1', 'reader.session.scope', 'reader.session.scopeMode']);
export const storageKey = (key, id = windowId) => id === 'main' || !localKeys.has(key) ? key : `reader.window.${id}.${key}`;
export const windowStorage = {
  getItem: (key) => globalThis.localStorage?.getItem(storageKey(key)) ?? null,
  setItem: (key, value) => globalThis.localStorage?.setItem(storageKey(key), value),
  removeItem: (key) => globalThis.localStorage?.removeItem(storageKey(key)),
};
