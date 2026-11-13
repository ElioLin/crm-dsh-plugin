/**
 * Host 端业务门面：把「存档 + Skill 仓库」收成一个可被 HTTP 路由与指令共用的对象。
 *
 * 这一层不碰 HTTP、不碰 Cordis，只依赖注入进来的 `store` / `skills` / `config`，
 * 因此可以在 node:test 里用假 store 直接覆盖全部业务分支。
 */

import {
  ACTIONS,
  DEFAULT_ICON,
  FORM_CONTEXT_ENTRIES,
  ICON_CATALOG,
  LIMITS,
  SCENARIO_CATEGORIES,
  STATE_VERSION,
  PLUGIN_ID,
} from './constants.js';
import { buildContextBlock } from './block.js';
import { scanSkillDir } from './skilldir.js';
import {
  duplicateScenario,
  moveScenario,
  normalizeScenario,
  normalizeSlashCommand,
} from './schema.js';

const MAX_SKILL_ROWS = 500;

function toSkillMap(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item?.name === 'string' && !map.has(item.name)) map.set(item.name, item);
  }
  return map;
}

/**
 * @param {object} options
 * @param {ReturnType<import('./state.js').createStateStore>} options.store
 * @param {object} options.config 已归一化的插件配置
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @param {() => object | undefined} [options.getSkills] 返回 Host 的 skills 服务（可能尚未就绪）
 */
export function createApi({ store, config, logger, getSkills, onChange, catalogDir }) {
  const notify = (type) => {
    try {
      onChange?.(type);
    } catch (error) {
      logger?.warn?.(`[${PLUGIN_ID}] onChange 回调失败：${error?.message ?? error}`);
    }
  };

  const skills = () => {
    try {
      return getSkills?.();
    } catch {
      return undefined;
    }
  };

  /**
   * 磁盘兜底目录表：Host 根视图看不到 preset 层的公司 Skill，
   * 因此额外扫描一个可配置的 Skill 根目录（每子目录一个 SKILL.md）。
   */
  async function directoryRows() {
    let dir;
    try {
      dir = typeof catalogDir === 'function' ? catalogDir() : catalogDir;
    } catch {
      return [];
    }
    if (typeof dir !== 'string' || dir === '') return [];
    try {
      const rows = await scanSkillDir(dir, { maxSkills: MAX_SKILL_ROWS });
      return rows.map((row) => ({ ...row, origin: 'directory' }));
    } catch (error) {
      logger?.warn?.(`[${PLUGIN_ID}] 扫描 Skill 目录失败：${error?.message ?? error}`);
      return [];
    }
  }

  /** 读取 Skill 摘要列表；服务不可用时退回空数组（不能因此让面板打不开）。 */
  async function listSkillSummaries(options = {}, serviceOverride) {
    const service = serviceOverride ?? skills();
    let registry = [];
    if (service !== undefined && typeof service.list === 'function') {
      try {
        const rows = await service.list(options);
        registry = Array.isArray(rows) ? rows.slice(0, MAX_SKILL_ROWS) : [];
      } catch (error) {
        logger?.warn?.(`[${PLUGIN_ID}] 读取 Skill 列表失败：${error?.message ?? error}`);
        registry = [];
      }
    }
    const merged = registry.map((row) => ({ ...row, origin: 'registry' }));
    const known = new Set(merged.map((row) => row.name));
    for (const row of await directoryRows()) {
      if (known.has(row.name)) continue;
      known.add(row.name);
      merged.push(row);
    }
    return merged.slice(0, MAX_SKILL_ROWS);
  }

  async function skillNames() {
    const rows = await listSkillSummaries();
    return rows.map((row) => row.name).filter((name) => typeof name === 'string');
  }

  /**
   * 按 pinnedSkills 的**顺序**解析出技能栈。
   *
   * 顺序永远保持管理员填写的顺序；拿不到正文的条目不丢弃、也不谎称「不存在」，
   * 而是标记 `loaded: false`，由注入块要求模型用 skill 工具自行加载。
   * `serviceOverride` 允许调用方传入一个**带作用域**的 skills 服务（模型请求阶段
   * 的注册表视图可能比 Host 根的视图更完整）。
   */
  async function resolveStack(names, serviceOverride, viewOptions, options = {}) {
    const wanted = Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
    if (wanted.length === 0) return [];
    const view = viewOptions ?? {};
    const service = serviceOverride ?? skills();
    const withContent = options.withContent !== false;
    const summaries = toSkillMap(await listSkillSummaries(view, service));
    const fromDirectory = withContent ? toSkillMap(await directoryRows()) : new Map();

    const stack = [];
    for (const name of wanted) {
      const summary = summaries.get(name);
      let definition;
      if (withContent && service !== undefined && typeof service.get === 'function') {
        try {
          definition = await service.get(name, view);
        } catch {
          definition = undefined;
        }
      }
      const content =
        typeof definition?.content === 'string' && definition.content !== ''
          ? definition.content
          : (fromDirectory.get(name)?.content ?? '');
      stack.push({
        name,
        description: summary?.description ?? definition?.description ?? fromDirectory.get(name)?.description ?? '',
        content,
        loaded: withContent && content !== '',
        missing: withContent && content === '' && summary === undefined,
      });
    }
    return stack;
  }

  function findCard(scenarioId) {
    return store.findScenario(scenarioId);
  }

  async function activate({ sessionId, scenarioId, source = 'ui' }) {
    const card = findCard(scenarioId);
    if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在或已被删除` };
    if (card.enabled !== true && source !== 'ui') {
      return { ok: false, message: `场景「${card.title}」已停用，无法被指令唤醒` };
    }
    const record = await store.mutate((draft) => {
      draft.activations[sessionId] = {
        sessionId,
        scenarioId,
        activatedAt: new Date().toISOString(),
        source,
        fullInjectedAt: undefined,
      };
      return { result: draft.activations[sessionId] };
    });
    const stack = await resolveStack(card.pinnedSkills);
    logger?.info?.(`[${PLUGIN_ID}] 激活场景 ${scenarioId} → 会话 ${sessionId}（${stack.length} 个 Skill）`);
    return {
      ok: true,
      activation: record,
      scenario: card,
      skills: stack.map(({ name, description, missing, loaded }) => ({ name, description, missing, loaded })),
    };
  }

  async function clearActivation({ sessionId }) {
    const removed = await store.mutate((draft) => {
      const existed = draft.activations[sessionId] !== undefined;
      delete draft.activations[sessionId];
      return { result: existed };
    });
    return { ok: true, cleared: removed };
  }

  /**
   * 每次模型请求前调用：返回要注入的文本，并在首次注入后把激活记录标成「已发过全文」。
   * 返回 undefined 表示这个会话没有激活任何场景。
   */
  async function prepareInjection(sessionId, override = {}) {
    if (config.injectSkillsOnStep !== true) return undefined;
    const record = store.activation(sessionId);
    if (record === undefined) return undefined;
    const card = findCard(record.scenarioId);
    if (card === undefined) {
      // 卡片被删除：清理悬空激活，避免每轮都白跑一次
      await clearActivation({ sessionId }).catch(() => undefined);
      return undefined;
    }
    const withBodies = config.injectSkillBodies === true;
    const stack = await resolveStack(
      card.pinnedSkills,
      override?.getSkills?.(),
      override?.cwd ? { cwd: override.cwd } : undefined,
      { withContent: withBodies },
    );
    const mode = withBodies ? (record.fullInjectedAt === undefined ? 'full' : 'reminder') : 'names';
    const text = buildContextBlock({
      card,
      skills: stack,
      mode,
      includeDescriptions: config.injectSkillDescriptions === true,
      includeBodies: withBodies,
    });
    if (mode === 'full') {
      await store
        .mutate((draft) => {
          const current = draft.activations[sessionId];
          if (current !== undefined) current.fullInjectedAt = new Date().toISOString();
          return { result: undefined };
        })
        .catch(() => undefined);
    }
    return { text, mode, card, stack };
  }

  async function saveScenario({ draft, previousId } = {}) {
    const existing = store.scenarios();
    const names = await skillNames();
    const result = normalizeScenario(draft, {
      existing,
      skillNames: names,
      maxCards: config.maxScenarioCards,
      previousId: typeof previousId === 'string' && previousId !== '' ? previousId : undefined,
    });
    if (result.ok !== true) return result;

    const card = result.card;
    await store.mutate((state) => {
      const index = state.scenarios.findIndex((item) => item.scenarioId === previousId);
      if (index >= 0) state.scenarios[index] = card;
      else state.scenarios.push(card);
      if (previousId !== undefined && previousId !== card.scenarioId) {
        for (const record of Object.values(state.activations)) {
          if (record.scenarioId === previousId) record.scenarioId = card.scenarioId;
        }
      }
      return { result: undefined };
    });
    logger?.info?.(`[${PLUGIN_ID}] 保存场景 ${card.scenarioId}（${previousId === undefined ? '新建' : '编辑'}）`);
    notify('scenario.saved');
    return { ok: true, card, warnings: result.warnings };
  }

  return {
    /* ── 启动引导数据 ─────────────────────────────────────────── */
    async bootstrap({ sessions = [] } = {}) {
      const scenarios = store.scenarios();
      const activations = sessions
        .map((sessionId) => store.activation(sessionId))
        .filter((record) => record !== undefined);
      return {
        ok: true,
        plugin: {
          id: PLUGIN_ID,
          version: '1.2.0',
          dataDir: store.dir,
          stateVersion: STATE_VERSION,
          degraded: store.degraded,
          warnings: store.loadWarnings,
        },
        config: {
          injectSkillsOnStep: config.injectSkillsOnStep === true,
          injectSkillBodies: config.injectSkillBodies === true,
          injectSkillDescriptions: config.injectSkillDescriptions === true,
          registerSlashCommands: config.registerSlashCommands === true,
          showSidebarEntry: config.showSidebarEntry !== false,
          maxScenarioCards: config.maxScenarioCards,
          skillCatalogDir: config.skillCatalogDir ?? '',
        },
        limits: LIMITS,
        taxonomy: {
          actions: ACTIONS,
          formContextEntries: FORM_CONTEXT_ENTRIES,
          categories: SCENARIO_CATEGORIES,
          icons: ICON_CATALOG,
          defaultIcon: DEFAULT_ICON,
        },
        scenarios,
        activations,
      };
    },

    async listSkills({ query = '', cwd = '' } = {}) {
      const view = typeof cwd === 'string' && cwd !== '' ? { cwd } : {};
      const rows = await listSkillSummaries(view);
      const needle = String(query ?? '').trim().toLowerCase();
      const filtered =
        needle === ''
          ? rows
          : rows.filter((row) =>
              `${row.name} ${row.description ?? ''}`.toLowerCase().includes(needle),
            );
      return {
        ok: true,
        skills: filtered.map((row) => ({
          name: row.name,
          description: row.description ?? '',
          whenToUse: row.whenToUse ?? '',
          source: row.source ?? '',
          origin: row.origin ?? 'registry',
          modelInvocable: row.invocation?.modelInvocable !== false,
        })),
        total: rows.length,
        directory: typeof catalogDir === 'function' ? catalogDir() : (catalogDir ?? ''),
      };
    },

    saveScenario,

    async deleteScenario({ scenarioId } = {}) {
      const existed = await store.mutate((state) => {
        const before = state.scenarios.length;
        state.scenarios = state.scenarios.filter((item) => item.scenarioId !== scenarioId);
        for (const [sessionId, record] of Object.entries(state.activations)) {
          if (record.scenarioId === scenarioId) delete state.activations[sessionId];
        }
        return { result: state.scenarios.length !== before };
      });
      if (existed) notify('scenario.deleted');
      return existed
        ? { ok: true }
        : { ok: false, message: `场景 ${scenarioId} 不存在` };
    },

    async setScenarioEnabled({ scenarioId, enabled } = {}) {
      const card = await store.mutate((state) => {
        const target = state.scenarios.find((item) => item.scenarioId === scenarioId);
        if (target === undefined) return { result: undefined, changed: false };
        target.enabled = enabled === true;
        return { result: target };
      });
      if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
      notify('scenario.enabled');
      return { ok: true, card };
    },

    async moveScenario({ scenarioId, direction } = {}) {
      const moved = await store.mutate((state) => {
        const outcome = moveScenario(state.scenarios, scenarioId, direction);
        if (outcome.ok !== true) return { result: outcome, changed: false };
        state.scenarios = outcome.items;
        return { result: { ok: true } };
      });
      return moved;
    },

    async duplicateScenario({ scenarioId } = {}) {
      const source = findCard(scenarioId);
      if (source === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
      const existing = store.scenarios();
      const draft = duplicateScenario(
        source,
        existing.map((item) => item.scenarioId),
      );
      const usedCommands = new Set(
        existing.map((item) => normalizeSlashCommand(item.slashCommand)),
      );
      if (usedCommands.has(draft.slashCommand)) {
        draft.slashCommand = `${draft.slashCommand}-${Date.now().toString(36).slice(-3)}`;
      }
      return saveScenario({ draft });
    },

    async activateScenario({ sessionId, scenarioId, source } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: '缺少会话标识' };
      }
      return activate({ sessionId, scenarioId, source });
    },

    async activationState({ sessionId } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: true, activation: undefined };
      const record = store.activation(sessionId);
      if (record === undefined) return { ok: true, activation: undefined };
      const card = findCard(record.scenarioId);
      return { ok: true, activation: record, scenario: card };
    },

    clearActivation,

    /** 管理员预览：确认「点下卡片后模型到底会看到什么」。 */
    async previewInjection({ scenarioId, mode = 'full', cwd = '' } = {}) {
      const card = findCard(scenarioId);
      if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
      const withBodies = config.injectSkillBodies === true;
      const stack = await resolveStack(
        card.pinnedSkills,
        undefined,
        typeof cwd === 'string' && cwd !== '' ? { cwd } : undefined,
        { withContent: withBodies },
      );
      const effectiveMode = withBodies ? (mode === 'reminder' ? 'reminder' : 'full') : 'names';
      const text = buildContextBlock({
        card,
        skills: stack,
        mode: effectiveMode,
        includeDescriptions: config.injectSkillDescriptions === true,
        includeBodies: withBodies,
      });
      return {
        ok: true,
        mode: effectiveMode,
        includeDescriptions: config.injectSkillDescriptions === true,
        includeBodies: withBodies,
        text,
        characters: [...text].length,
        skills: stack.map(({ name, missing, loaded, content }) => ({
          name,
          missing,
          loaded,
          characters: [...(content ?? '')].length,
        })),
      };
    },

    prepareInjection,
  };
}
