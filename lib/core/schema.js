/**
 * 场景配置数据模型（Scenario Configuration Schema）—— 唯一的写入校验入口。
 *
 * 设计原则：
 * 1. 校验只在这里做一次，Host 端 API 全部经过 `normalizeScenario`；
 *    返回值要么是完整的 `ScenarioCardConfig`，要么是字段级错误列表。
 * 2. 「可修复的偏差」不阻断保存（例如 Skill 仓库里暂时找不到某个名、
 *    未知图标标识），以 `warnings` 形式返回并在界面上标红，
 *    避免一次误配就把整张卡片判死。
 * 3. 输出对象的键顺序与对外接口一致，便于持久化文件的 diff 阅读。
 */

import {
  ACTIONS,
  DEFAULT_ICON,
  FORM_CONTEXT_ENTRIES,
  ICON_IDS,
  LIMITS,
  OBJECT_API_NAME_PATTERN,
  SCENARIO_ID_PATTERN,
  SLASH_COMMAND_PATTERN,
} from './constants.js';

const FIELD = Object.freeze({
  scenarioId: 'scenarioId',
  title: 'title',
  description: 'description',
  icon: 'icon',
  category: 'category',
  slashCommand: 'slashCommand',
  enabled: 'enabled',
  isSystemBase: 'isSystemBase',
  pinnedSkills: 'pinnedSkills',
  welcomeMessage: 'welcomeMessage',
});

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按 Unicode 码点计数，避免中文/emoji 被 `String.length` 低估或高估。 */
export function charLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把标题压成 ASCII slug；中文标题会得到空串，由调用方兜底。 */
export function slugify(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * 生成一个稳定且唯一的 scenarioId。
 * 优先用标题 slug，纯中文标题退化为 `crm_scene`，冲突时追加序号。
 */
export function deriveScenarioId(title, taken = []) {
  const base = slugify(title);
  const prefix = base === '' ? 'crm_scene' : `crm_${base}`;
  const used = new Set(taken);
  if (!used.has(prefix) && SCENARIO_ID_PATTERN.test(prefix)) return prefix;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${prefix}_${index}`;
    if (!used.has(candidate) && SCENARIO_ID_PATTERN.test(candidate)) return candidate;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

/** 统一 slashCommand 形态：补前导 `/`、转小写、去空白。 */
export function normalizeSlashCommand(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '');
  if (raw === '') return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * 规范化 + 校验一张场景卡片。
 *
 * @param {unknown} raw 管理员提交的原始对象
 * @param {object} [options]
 * @param {ReadonlyArray<{scenarioId: string, slashCommand?: string}>} [options.existing] 已有卡片（用于唯一性）
 * @param {ReadonlyArray<string>} [options.skillNames] 当前 Skill 仓库里的名字（用于 warning）
 * @param {number} [options.maxCards] 卡片数量上限（新建时生效）
 * @param {string} [options.previousId] 编辑前的 scenarioId（改 id 时排除自身）
 * @returns {{ok: true, card: object, warnings: Array<{field: string, message: string}>}
 *          | {ok: false, errors: Array<{field: string, message: string}>, warnings: Array<{field: string, message: string}>}}
 */
export function normalizeScenario(raw, options = {}) {
  const {
    existing = [],
    skillNames = [],
    maxCards = LIMITS.maxScenarioCards,
    previousId,
  } = options;

  const errors = [];
  const warnings = [];
  const fail = (field, message) => errors.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: '', message: '场景配置必须是一个 JSON 对象' }], warnings };
  }

  const others = existing.filter((item) => item && item.scenarioId !== previousId);

  /* ── 标题 ───────────────────────────────────────────────────── */
  const title = text(raw.title);
  if (title === '') fail(FIELD.title, '标题必填：业务人员在卡片上看到的第一行文字');
  else if (charLength(title) > LIMITS.title) fail(FIELD.title, `标题不能超过 ${LIMITS.title} 个字符`);

  /* ── 场景介绍（必填） ───────────────────────────────────────── */
  const description = text(raw.description);
  if (description === '') {
    fail(FIELD.description, '场景介绍必填：说明这个场景解决什么问题、适用于哪些业务');
  } else if (charLength(description) > LIMITS.description) {
    fail(FIELD.description, `场景介绍不能超过 ${LIMITS.description} 个字符`);
  }

  /* ── 图标 ───────────────────────────────────────────────────── */
  const iconRaw = text(raw.icon);
  let icon = iconRaw === '' ? DEFAULT_ICON : iconRaw;
  if (!ICON_IDS.includes(icon)) {
    warn(FIELD.icon, `未知图标标识「${iconRaw}」，已回退为默认图标`);
    icon = DEFAULT_ICON;
  }

  /* ── 分类 ───────────────────────────────────────────────────── */
  const category = text(raw.category);
  if (category === '') fail(FIELD.category, '业务分类必填，例如「核心单据管控」');
  else if (charLength(category) > LIMITS.category) fail(FIELD.category, `分类不能超过 ${LIMITS.category} 个字符`);

  /* ── 快捷指令 ───────────────────────────────────────────────── */
  const slashCommand = normalizeSlashCommand(raw.slashCommand);
  if (slashCommand === '') fail(FIELD.slashCommand, '快捷唤醒指令必填，例如 /record');
  else if (!SLASH_COMMAND_PATTERN.test(slashCommand)) {
    fail(FIELD.slashCommand, '指令格式：/ 开头，仅小写字母、数字、连字符，长度不超过 32，例如 /record');
  } else {
    const clash = others.find((item) => normalizeSlashCommand(item.slashCommand) === slashCommand);
    if (clash) {
      fail(FIELD.slashCommand, `指令 ${slashCommand} 已被「${clash.title || clash.scenarioId}」占用`);
    }
  }

  /* ── scenarioId ─────────────────────────────────────────────── */
  const ids = others.map((item) => item.scenarioId).filter((id) => typeof id === 'string');
  let scenarioId = text(raw.scenarioId);
  if (scenarioId === '') {
    scenarioId = deriveScenarioId(title, ids);
  } else if (!SCENARIO_ID_PATTERN.test(scenarioId)) {
    fail(FIELD.scenarioId, '场景编码格式：小写字母开头，仅小写字母、数字、下划线');
  } else if (ids.includes(scenarioId)) {
    fail(FIELD.scenarioId, `场景编码 ${scenarioId} 已存在`);
  }

  /* ── 开关 ───────────────────────────────────────────────────── */
  const enabled = asBoolean(raw.enabled, true);
  const isSystemBase = asBoolean(raw.isSystemBase, false);

  /* ── pinnedSkills（顺序即执行顺序） ─────────────────────────── */
  const pinnedSkillsRaw = Array.isArray(raw.pinnedSkills) ? raw.pinnedSkills : [];
  const pinnedSkills = [];
  for (const entry of pinnedSkillsRaw) {
    if (typeof entry !== 'string') {
      fail(FIELD.pinnedSkills, 'pinnedSkills 只能包含 Skill 标识字符串');
      continue;
    }
    const name = entry.trim();
    if (name === '') continue;
    if (charLength(name) > LIMITS.skillName) {
      fail(FIELD.pinnedSkills, `Skill 标识过长（上限 ${LIMITS.skillName} 个字符）：${name.slice(0, 40)}…`);
      continue;
    }
    pinnedSkills.push(name);
  }
  const dedupedSkills = dedupeStrings(pinnedSkills);
  if (dedupedSkills.length !== pinnedSkills.length) {
    warn(FIELD.pinnedSkills, '已自动去除重复的 Skill 标识');
  }
  if (dedupedSkills.length > LIMITS.pinnedSkills) {
    fail(FIELD.pinnedSkills, `单张卡片最多绑定 ${LIMITS.pinnedSkills} 个 Skill`);
  }
  if (dedupedSkills.length === 0) {
    warn(FIELD.pinnedSkills, '尚未绑定任何 Skill：进入场景后模型只拿到场景说明，不会显式加载技能栈');
  }
  if (Array.isArray(skillNames) && skillNames.length > 0) {
    const known = new Set(skillNames);
    const missing = dedupedSkills.filter((name) => !known.has(name));
    if (missing.length > 0) {
      warn(
        FIELD.pinnedSkills,
        `以下 Skill 未出现在面板可见的 Skill 视图（仍会按名称注入，执行时由模型自行加载）：${missing.join('、')}`,
      );
    }
  }

  /* ── prePinnedContext ──────────────────────────────────────── */
  const contextRaw = isPlainObject(raw.prePinnedContext) ? raw.prePinnedContext : {};
  const objectApiName = text(contextRaw.defaultObjectApiName);
  if (objectApiName !== '' && !OBJECT_API_NAME_PATTERN.test(objectApiName)) {
    fail(
      'prePinnedContext.defaultObjectApiName',
      '目标对象 API 名格式不合法（字母开头，仅字母/数字/下划线，例如 Case 或 Invoice__c）',
    );
  }

  const actionRaw = text(contextRaw.defaultAction).toUpperCase();
  const defaultAction = actionRaw === '' ? 'AUTO' : actionRaw;
  if (!ACTIONS.includes(defaultAction)) {
    fail('prePinnedContext.defaultAction', `默认动作只能是 ${ACTIONS.join(' / ')}`);
  }

  const entryRaw = text(contextRaw.formContextEntry).toUpperCase();
  const formContextEntry = entryRaw === '' ? 'STANDARD' : entryRaw;
  if (!FORM_CONTEXT_ENTRIES.includes(formContextEntry)) {
    fail(
      'prePinnedContext.formContextEntry',
      `表单上下文入口只能是 ${FORM_CONTEXT_ENTRIES.join(' / ')}`,
    );
  }

  const allowAttachments = asBoolean(contextRaw.allowAttachments, false);

  /* ── 开场引导语 ─────────────────────────────────────────────── */
  const welcomeMessage = text(raw.welcomeMessage);
  if (welcomeMessage === '') {
    fail(FIELD.welcomeMessage, '开场引导语必填：切换到该场景时用来引导业务人员的第一句话');
  } else if (charLength(welcomeMessage) > LIMITS.welcomeMessage) {
    fail(FIELD.welcomeMessage, `开场引导语不能超过 ${LIMITS.welcomeMessage} 个字符`);
  }

  /* ── 数量上限（仅新建） ─────────────────────────────────────── */
  if (previousId === undefined && existing.length >= maxCards) {
    fail('', `场景卡片数量已达上限（${maxCards}），请先归档或删除不再使用的卡片`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    card: {
      scenarioId,
      title,
      description,
      icon,
      category,
      slashCommand,
      enabled,
      isSystemBase,
      pinnedSkills: dedupedSkills,
      prePinnedContext: {
        ...(objectApiName === '' ? {} : { defaultObjectApiName: objectApiName }),
        defaultAction,
        formContextEntry,
        allowAttachments,
      },
      welcomeMessage,
    },
  };
}

/**
 * 读取持久化文件时使用：只做形状收敛，不产生错误（错误文件由 store 处理）。
 * 与 `normalizeScenario` 的区别是不要求必填项全齐，坏卡片会被过滤掉。
 */
export function coerceStoredScenario(raw) {
  if (!isPlainObject(raw)) return undefined;
  const result = normalizeScenario(raw, { existing: [], skillNames: [] });
  if (result.ok) return result.card;
  return undefined;
}

/** 在数组里移动一张卡片，返回新数组（不修改入参）。 */
export function moveScenario(list, scenarioId, direction) {
  const items = [...list];
  const index = items.findIndex((item) => item.scenarioId === scenarioId);
  if (index < 0) return { ok: false, message: `未找到场景 ${scenarioId}` };
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) {
    return { ok: false, message: direction === 'up' ? '已经是第一张卡片' : '已经是最后一张卡片' };
  }
  const [moved] = items.splice(index, 1);
  items.splice(target, 0, moved);
  return { ok: true, items };
}

/** 复制一张卡片（新编码、新指令、标题加「副本」），返回未校验的草稿。 */
export function duplicateScenario(card, taken = []) {
  const base = SCENARIO_ID_PATTERN.test(`${card.scenarioId}_copy`)
    ? `${card.scenarioId}_copy`.slice(0, 64)
    : 'crm_copy';
  let scenarioId = base;
  for (let index = 2; taken.includes(scenarioId); index += 1) {
    scenarioId = `${base.slice(0, 60)}_${index}`;
  }
  const usedCommands = new Set(taken);
  let slashCommand = `${card.slashCommand}-copy`;
  if (usedCommands.has(slashCommand)) slashCommand = `${card.slashCommand}-${Date.now().toString(36).slice(-3)}`;
  return {
    ...card,
    scenarioId,
    title: `${card.title}（副本）`.slice(0, LIMITS.title),
    slashCommand: slashCommand.slice(0, LIMITS.slashCommand),
    isSystemBase: false,
  };
}
