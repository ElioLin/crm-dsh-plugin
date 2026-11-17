/**
 * 激活记录（session → 场景栈）的纯逻辑。
 *
 * 这里只做数据变换，不碰磁盘、不发请求，因此可以被 state.js（读档收敛）、
 * api.js（激活/退出/注入）与单元测试共同复用。
 *
 * 记录形状（v3，兼容 v2 的单场景存档）：
 *   {
 *     sessionId,
 *     scenarioId,          // 主场景：保持与旧代码/旧存档的兼容
 *     activatedAt, source, fullInjectedAt,
 *     scenarios: [{ scenarioId, activatedAt, source, fullInjectedAt, injectedAt, injectionCount }],
 *     updatedAt,
 *   }
 *
 * 为什么要栈：一个会话可以同时叠加多个场景（例如「CRM 单据」+「文档规范」）。
 * 注入时按栈顺序拼接上下文块，退出时只摘掉其中一个，其余保持生效。
 */

import { LIMITS } from './constants.js';

/** 激活记录最长存活 7 天（与旧行为一致）。 */
export const ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 空闲过期：超过 24 小时没有再注入过的会话，激活记录被回收。
 *
 * 这是「生命周期」的重点：旧实现只在读档时按激活时间裁剪，进程活着一整天
 * 都不会清理，state.json 里的 activations 只增不减。
 */
export const ACTIVATION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function isoOr(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function isoNow(now) {
  return new Date(now).toISOString();
}

function normalizeEntry(raw, fallbackIso) {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (typeof raw.scenarioId !== 'string' || raw.scenarioId === '') return undefined;
  const activatedAt = isoOr(raw.activatedAt, fallbackIso);
  const injectedAt = isoOr(raw.injectedAt, '');
  const count = Number(raw.injectionCount);
  return {
    scenarioId: raw.scenarioId,
    activatedAt,
    source: raw.source === 'command' ? 'command' : 'ui',
    fullInjectedAt: isoOr(raw.fullInjectedAt, undefined),
    injectedAt: injectedAt === '' ? undefined : injectedAt,
    injectionCount: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
  };
}

/** 把主场景字段同步到栈首元素，避免两份数据打架。 */
export function syncPrimary(record) {
  if (record === undefined || record === null) return record;
  const first = Array.isArray(record.scenarios) ? record.scenarios[0] : undefined;
  if (first === undefined) {
    record.scenarioId = '';
    record.activatedAt = record.activatedAt ?? undefined;
    record.fullInjectedAt = undefined;
    return record;
  }
  record.scenarioId = first.scenarioId;
  record.activatedAt = first.activatedAt;
  record.source = first.source;
  record.fullInjectedAt = first.fullInjectedAt;
  return record;
}

/**
 * 收敛一条激活记录：兼容「有 scenarios 数组」与「只有 scenarioId」两种存档。
 * 返回 undefined 表示这条记录没有可用场景（调用方应删除它）。
 */
export function normalizeActivation(sessionId, raw, { now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  if (raw === null || typeof raw !== 'object') return undefined;
  const fallbackIso = isoNow(now);
  const entries = [];
  const seen = new Set();
  const push = (entry) => {
    if (entry === undefined) return;
    if (seen.has(entry.scenarioId)) return;
    seen.add(entry.scenarioId);
    entries.push(entry);
  };
  if (Array.isArray(raw.scenarios)) {
    for (const item of raw.scenarios) push(normalizeEntry(item, fallbackIso));
  }
  if (entries.length === 0) push(normalizeEntry(raw, fallbackIso));
  if (entries.length === 0) return undefined;
  // updatedAt 决定「超限时留哪几条」：旧存档没有这个字段，用栈里最近一次注入/激活
  // 的时间兜底 —— 用「现在」兜底会让所有旧记录看起来一样新，清理等于随机丢。
  const latestEntryIso = entries
    .map((entry) => Date.parse(entry.injectedAt ?? entry.activatedAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  const record = {
    sessionId,
    scenarios: entries.slice(0, LIMITS.maxScenariosPerSession),
    updatedAt: isoOr(raw.updatedAt, Number.isFinite(latestEntryIso) ? new Date(latestEntryIso).toISOString() : fallbackIso),
  };
  return syncPrimary(record);
}

/** 栈里所有场景 id（按顺序）。 */
export function scenarioIds(record) {
  if (record === undefined || record === null || !Array.isArray(record.scenarios)) return [];
  return record.scenarios.map((entry) => entry.scenarioId);
}

/** 某个场景在栈里的那一项；不存在返回 undefined。 */
export function findEntry(record, scenarioId) {
  if (record === undefined || record === null || !Array.isArray(record.scenarios)) return undefined;
  return record.scenarios.find((entry) => entry.scenarioId === scenarioId);
}

/**
 * 往会话里加入一个场景。
 *
 * - `replace === true`（默认）：进入场景 = 只保留这一个，替换原有栈；
 * - `replace === false`：叠加，保留已有场景，新场景追加到栈尾；重复加入时只刷新时间。
 */
export function addScenario(record, { scenarioId, source = 'ui', now = Date.now(), replace = true } = {}) {
  if (typeof scenarioId !== 'string' || scenarioId === '') return undefined;
  const at = isoNow(now);
  const entry = {
    scenarioId,
    activatedAt: at,
    source: source === 'command' ? 'command' : 'ui',
    fullInjectedAt: undefined,
    injectedAt: undefined,
    injectionCount: 0,
  };
  const base = record === undefined || record === null ? { sessionId: '', scenarios: [] } : record;
  const existing = Array.isArray(base.scenarios) ? base.scenarios : [];
  let scenarios;
  if (replace === true) {
    scenarios = [entry];
  } else {
    const previous = existing.find((item) => item.scenarioId === scenarioId);
    // 叠加时保留「已注入过全文/提醒次数」的进度：重复点同一张卡片不该让上下文重发一遍，
    // 也不能让同一张卡在栈里出现两次（否则注入块会重复、移除按钮会指向同一个 id）。
    scenarios = previous === undefined ? [...existing, entry] : existing;
  }
  const next = {
    sessionId: base.sessionId ?? '',
    scenarios: scenarios.slice(0, LIMITS.maxScenariosPerSession),
    updatedAt: at,
  };
  return syncPrimary(next);
}

/** 从会话栈里移除一个场景；栈空时返回 undefined（调用方删除整条记录）。 */
export function removeScenario(record, scenarioId, { now = Date.now() } = {}) {
  if (record === undefined || record === null || !Array.isArray(record.scenarios)) return undefined;
  const rest = record.scenarios.filter((entry) => entry.scenarioId !== scenarioId);
  if (rest.length === record.scenarios.length) return record;
  if (rest.length === 0) return undefined;
  return syncPrimary({ sessionId: record.sessionId, scenarios: rest, updatedAt: isoNow(now) });
}

/** 记录一次注入：写 fullInjectedAt / injectedAt / injectionCount。 */
export function markInjected(record, scenarioId, { mode, now = Date.now() } = {}) {
  if (record === undefined || record === null || !Array.isArray(record.scenarios)) return record;
  const at = isoNow(now);
  const scenarios = record.scenarios.map((entry) => {
    if (entry.scenarioId !== scenarioId) return entry;
    return {
      ...entry,
      fullInjectedAt: mode === 'full' ? at : entry.fullInjectedAt,
      injectedAt: at,
      injectionCount: (Number(entry.injectionCount) || 0) + 1,
    };
  });
  return syncPrimary({ ...record, scenarios, updatedAt: at });
}

/**
 * 清理整张 activations 表：
 *  - 场景已被删除的悬空记录；
 *  - 激活超过 `ttlMs`（默认 7 天）；
 *  - 最近一次注入/激活超过 `idleMs`（默认 24 小时）；
 *  - 总数超过 `max`（保留最近使用的）。
 *
 * @returns {{kept: object, removed: string[], droppedFor: Record<string, number>}}
 */
export function pruneActivations(map, { now = Date.now(), ttlMs = ACTIVATION_TTL_MS, idleMs = ACTIVATION_IDLE_TTL_MS, max = LIMITS.maxActivations, knownScenarioIds } = {}) {
  const removed = [];
  const droppedFor = { expired: 0, idle: 0, unknown: 0, overflow: 0 };
  const rows = [];
  const source = map !== null && typeof map === 'object' ? map : {};
  const known = knownScenarioIds === undefined ? undefined : new Set(knownScenarioIds);

  for (const [sessionId, raw] of Object.entries(source)) {
    const record = normalizeActivation(sessionId, raw, { now });
    if (record === undefined) {
      removed.push(sessionId);
      droppedFor.unknown += 1;
      continue;
    }
    const scenarios = record.scenarios.filter((entry) => {
      if (known !== undefined && !known.has(entry.scenarioId)) {
        droppedFor.unknown += 1;
        return false;
      }
      const activatedAt = Date.parse(entry.activatedAt);
      if (Number.isFinite(activatedAt) && now - activatedAt > ttlMs) {
        droppedFor.expired += 1;
        return false;
      }
      const lastAt = Date.parse(entry.injectedAt ?? entry.activatedAt);
      if (Number.isFinite(lastAt) && now - lastAt > idleMs) {
        droppedFor.idle += 1;
        return false;
      }
      return true;
    });
    if (scenarios.length === 0) {
      removed.push(sessionId);
      continue;
    }
    rows.push(syncPrimary({ ...record, scenarios }));
  }

  rows.sort((a, b) => Date.parse(b.updatedAt ?? b.activatedAt) - Date.parse(a.updatedAt ?? a.activatedAt));
  const keptRows = rows.slice(0, Math.max(1, max));
  droppedFor.overflow += rows.length - keptRows.length;
  for (const row of rows.slice(Math.max(1, max))) removed.push(row.sessionId);

  const kept = {};
  for (const row of keptRows) kept[row.sessionId] = row;
  return { kept, removed, droppedFor };
}

/** 一行摘要：用于 /crm-doctor 与面板诊断。 */
export function describeActivation(record) {
  if (record === undefined || record === null) return '未激活';
  const ids = scenarioIds(record);
  if (ids.length === 0) return '未激活';
  const parts = ids.map((id) => {
    const entry = findEntry(record, id);
    const injected = entry?.injectionCount > 0 ? `已注入 ${entry.injectionCount} 次` : '尚未注入';
    return `${id}（${injected}）`;
  });
  return parts.join(' + ');
}
