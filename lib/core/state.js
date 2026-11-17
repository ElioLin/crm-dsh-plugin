/**
 * 场景注册表与激活状态的持久化。
 *
 * 为什么是「一个 JSON 文件 + 原子替换」而不是别的：
 *  - 场景配置是管理员资产，必须能被 `cp` 备份、被 `git diff` 审阅、被人肉修；
 *  - 写入必须是原子的（tmp + rename），否则进程被杀会留下半截 JSON；
 *  - 损坏时必须自我隔离（改名为 state.corrupt-*.json）并从空表继续，
 *    绝不静默覆盖管理员手改过的文件。
 *
 * 所有写操作串行化在一条 Promise 链上，避免两个面板同时保存时互相覆盖。
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  BACKUP_FILE,
  DEFAULT_DATA_DIRNAME,
  LIMITS,
  SCENARIO_SOURCE_TYPES,
  STATE_FILE,
  STATE_VERSION,
  isValidScenarioId,
} from './constants.js';
import { ACTIVATION_IDLE_TTL_MS, ACTIVATION_TTL_MS, pruneActivations } from './activation.js';
import { coerceStoredScenario, isPlainObject, normalizeSlashCommand } from './schema.js';

const MAX_ACTIVATION_AGE_MS = ACTIVATION_TTL_MS;

function nowIso() {
  return new Date().toISOString();
}

function emptyDoc() {
  return {
    version: STATE_VERSION,
    updatedAt: nowIso(),
    scenarios: [],
    companyStandardScenarios: [],
    deletedScenarioIds: [],
    lastSyncedAt: '',
    activations: {},
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 收敛读入的文档：坏卡片丢弃、编码/指令去重、激活记录清理。 */
export function sanitizeDoc(raw, { logger, now = Date.now() } = {}) {
  const warnings = [];
  const doc = emptyDoc();

  if (!isPlainObject(raw)) {
    return { doc, warnings: ['存档内容不是 JSON 对象，已按空表处理'] };
  }

  if (typeof raw.version === 'number' && raw.version > STATE_VERSION) {
    warnings.push(
      `存档版本 ${raw.version} 高于本插件支持的 ${STATE_VERSION}：已按只读方式读取，保存会降级覆盖，请升级插件`,
    );
  }

  const sourceScenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  const seenIds = new Set();
  const seenCommands = new Set();
  for (const entry of sourceScenarios) {
    const card = coerceStoredScenario(entry);
    if (card === undefined) {
      warnings.push('丢弃了一条结构不合法的场景卡片（缺少标题/介绍/指令等必填项）');
      continue;
    }
    if (seenIds.has(card.scenarioId)) {
      warnings.push(`丢弃重复场景编码：${card.scenarioId}`);
      continue;
    }
    const command = normalizeSlashCommand(card.slashCommand);
    if (seenCommands.has(command)) {
      warnings.push(`丢弃重复快捷指令：${command}`);
      continue;
    }
    seenIds.add(card.scenarioId);
    seenCommands.add(command);
    doc.scenarios.push(card);
  }

  const activations = isPlainObject(raw.activations) ? raw.activations : {};
  const companySource = Array.isArray(raw.companyStandardScenarios) ? raw.companyStandardScenarios : [];
  const companySeen = new Set();
  for (const entry of companySource) {
    const card = coerceStoredScenario(entry);
    if (card === undefined) continue;
    if (companySeen.has(card.scenarioId)) continue;
    companySeen.add(card.scenarioId);
    doc.companyStandardScenarios.push({
      ...card,
      sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
      readonlyForNormalUser: true,
      isStandardPublished: true,
    });
  }
  const deleted = Array.isArray(raw.deletedScenarioIds) ? raw.deletedScenarioIds : [];
  doc.deletedScenarioIds = [...new Set(deleted.filter((id) => isValidScenarioId(id)))];
  doc.lastSyncedAt = typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : '';

  const ids = new Set(doc.scenarios.map((card) => card.scenarioId));
  // 激活记录的生命周期统一交给 activation.pruneActivations：
  // 悬空场景、超过 7 天、超过 24 小时没注入、超过上限，四类一次性清掉。
  // 旧实现只在读档时按 activatedAt 裁剪，进程跑一整天都不会再清理。
  const pruned = pruneActivations(activations, {
    now,
    ttlMs: MAX_ACTIVATION_AGE_MS,
    idleMs: ACTIVATION_IDLE_TTL_MS,
    max: LIMITS.maxActivations,
    knownScenarioIds: ids,
  });
  doc.activations = pruned.kept;
  if (pruned.removed.length > 0 && logger !== undefined) {
    const detail = `过期 ${pruned.droppedFor.expired}、闲置 ${pruned.droppedFor.idle}、悬空 ${pruned.droppedFor.unknown}、超限 ${pruned.droppedFor.overflow}`;
    logger.warn?.(`已清理 ${pruned.removed.length} 条激活记录（${detail}）`);
  }

  return { doc, warnings };
}

/**
 * @param {object} options
 * @param {string} options.dataDir 数据目录（默认 `<profile>/crm-workspace`）
 * @param {{info: Function, warn: Function, error: Function}} [options.logger]
 */
export function createStateStore({ dataDir, logger }) {
  const dir = dataDir;
  const file = join(dir, STATE_FILE);
  const backup = join(dir, BACKUP_FILE);

  let doc = emptyDoc();
  let degraded;
  const loadWarnings = [];
  let readyPromise;
  let chain = Promise.resolve();
  let tmpCounter = 0;

  async function writeAtomic(payload) {
    await mkdir(dir, { recursive: true });
    tmpCounter += 1;
    const tmp = join(dir, `${STATE_FILE}.${process.pid}.${tmpCounter}.tmp`);
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    try {
      await copyFile(file, backup);
    } catch {
      /* 首次写入没有旧文件，忽略 */
    }
    await rename(tmp, file);
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load() {
    await mkdir(dir, { recursive: true });
    let parsed;
    try {
      const content = await readFile(file, 'utf8');
      parsed = JSON.parse(content);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        doc = emptyDoc();
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = join(dir, `state.corrupt-${stamp}.json`);
      try {
        await rename(file, quarantine);
        degraded = `存档文件无法解析，已隔离为 ${quarantine}，当前以空表运行。请修复后重启插件。`;
      } catch {
        degraded = `存档文件无法解析且无法隔离（${error?.message ?? error}），当前以空表运行。`;
      }
      logger?.error?.(`[${DEFAULT_DATA_DIRNAME}] ${degraded}`);
      doc = emptyDoc();
      return;
    }

    const result = sanitizeDoc(parsed, { logger });
    doc = result.doc;
    loadWarnings.push(...result.warnings);
    if (result.warnings.length > 0) {
      logger?.warn?.(`[${DEFAULT_DATA_DIRNAME}] 存档收敛：${result.warnings.join('；')}`);
    }
    if (typeof parsed?.version === 'number' && parsed.version > STATE_VERSION) {
      degraded = `存档版本 ${parsed.version} 高于本插件支持的 ${STATE_VERSION}：为避免降级覆盖，已进入只读模式。请升级插件，或备份并删除 ${file} 后重启。`;
      logger?.error?.(`[${DEFAULT_DATA_DIRNAME}] ${degraded}`);
    }
  }

  const store = {
    get dir() {
      return dir;
    },
    get file() {
      return file;
    },
    get degraded() {
      return degraded;
    },
    get loadWarnings() {
      return [...loadWarnings];
    },

    ready() {
      if (readyPromise === undefined) readyPromise = load();
      return readyPromise;
    },

    /** 只读快照：调用方拿到的是副本，不可能绕过 mutate 改到存档。 */
    snapshot() {
      return clone({
        version: doc.version,
        updatedAt: doc.updatedAt,
        scenarios: doc.scenarios,
        companyStandardScenarios: doc.companyStandardScenarios,
        deletedScenarioIds: doc.deletedScenarioIds,
        lastSyncedAt: doc.lastSyncedAt,
        activations: doc.activations,
      });
    },

    scenarios() {
      return clone(doc.scenarios);
    },

    companyScenarios() {
      return clone(doc.companyStandardScenarios);
    },

    deletedScenarioIds() {
      return [...doc.deletedScenarioIds];
    },

    lastSyncedAt() {
      return doc.lastSyncedAt;
    },

    findCompanyScenario(scenarioId) {
      const card = doc.companyStandardScenarios.find((item) => item.scenarioId === scenarioId);
      return card === undefined ? undefined : clone(card);
    },

    findScenario(scenarioId) {
      const card = doc.scenarios.find((item) => item.scenarioId === scenarioId);
      return card === undefined ? undefined : clone(card);
    },

    activation(sessionId) {
      const record = doc.activations[sessionId];
      return record === undefined ? undefined : clone(record);
    },

    /** 当前存档里有多少条会话处于激活状态（诊断用）。 */
    activationCount() {
      return Object.keys(doc.activations).length;
    },

    /**
     * 运行期清理激活记录（长跑的进程也能回收）：
     * 有记录被清掉才落盘，没有变化时保持文件原样。
     */
    async pruneActivations({ now = Date.now() } = {}) {
      let summary;
      await store.mutate((draft) => {
        const ids = new Set(draft.scenarios.map((card) => card.scenarioId));
        const pruned = pruneActivations(draft.activations, {
          now,
          ttlMs: MAX_ACTIVATION_AGE_MS,
          idleMs: ACTIVATION_IDLE_TTL_MS,
          max: LIMITS.maxActivations,
          knownScenarioIds: ids,
        });
        summary = {
          removed: pruned.removed.length,
          kept: Object.keys(pruned.kept).length,
          droppedFor: pruned.droppedFor,
        };
        if (pruned.removed.length === 0) return { result: undefined, changed: false };
        draft.activations = pruned.kept;
        return { result: undefined };
      });
      return summary ?? { removed: 0, kept: 0, droppedFor: { expired: 0, idle: 0, unknown: 0, overflow: 0 } };
    },

    /**
     * 串行化的一次「读-改-写」。`reducer` 收到草稿副本，返回 `{result, changed}`。
     * `changed !== false` 时立即原子落盘；落盘失败不会污染内存中的旧值。
     */
    async mutate(reducer) {
      await store.ready();
      return enqueue(async () => {
        const draft = clone(doc);
        const outcome = await reducer(draft);
        if (outcome?.changed === false) return outcome.result;
        draft.version = STATE_VERSION;
        draft.updatedAt = nowIso();
        if (degraded !== undefined) {
          throw new Error(degraded);
        }
        await writeAtomic(draft);
        doc = draft;
        return outcome?.result;
      });
    },
  };

  return store;
}
