/**
 * 历史包（HistoryPack）：把「每个能力带几条历史」这件事从调用点收口到一处。
 *
 * P1 保持旧行为不变（问答 6 条带当轮原文、操作 4 条、教学 10 条），
 * 所以三个函数分别复刻旧调用点；P3 再统一成 { maxMessages, withTurnSource } 声明。
 */
import { historyMessages } from '../reading-context.js';

/** 问答：最近 6 条，保留当轮原文/页码（旧 ai.js 用 historyMessages） */
export function qaHistory(history = []) {
  return historyMessages(history);
}

/** 操作（深入阅读）：最近 4 条，原样 */
export function opHistory(history = []) {
  return Array.isArray(history) ? history.slice(-4) : [];
}

/** 教学：最近 10 条，只留 role/content 字符串 */
export function teachHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-10)
    .map((m) => ({ role: m.role, content: String(m.content || '') }));
}
