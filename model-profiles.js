'use strict';
const fields = ['model', 'baseURL', 'apiKey', 'visionModel', 'temperature', 'stream'];
function profiles(cfg) {
  const list = Array.isArray(cfg.modelProfiles) ? [...cfg.modelProfiles] : [];
  const current = Object.fromEntries(fields.map(k => [k, cfg[k] ?? (k === 'stream' ? true : k === 'temperature' ? 0.2 : '')]));
  let active = list.findIndex(p => fields.every(k => p[k] === current[k]));
  if (active < 0) active = list.push(current) - 1;
  return { list, active };
}
function publicConfig(cfg) {
  const { list, active } = profiles(cfg);
  return { ...cfg, apiKey: '', hasApiKey: !!cfg.apiKey, activeProfile: String(active),
    modelProfiles: list.map((p, i) => ({ id: String(i), model: p.model, baseURL: p.baseURL, hasApiKey: !!p.apiKey })) };
}
function saveProfiles(cur, next, raw) {
  const { list } = profiles(cur);
  if (Object.hasOwn(raw, 'selectProfile')) {
    const p = typeof raw.selectProfile === 'string' && list.find((_, i) => String(i) === raw.selectProfile);
    if (!p) throw new Error('模型配置不存在，请重新打开设置');
    Object.assign(next, p);
  }
  next.modelProfiles = list;
  next.modelProfiles = profiles(next).list;
  return next;
}
module.exports = { publicConfig, saveProfiles };
