/**
 * CRM 智能工作台 —— 常量与硬约束。
 *
 * 这里定义的所有上限都会被 Host 端校验读取一次（lib/core/schema.js），
 * 也会通过 `bootstrap` 下发给客户端，前端据此渲染计数与提示，
 * 避免「界面允许输入、后端静默截断」这种生产事故。
 */

export const PLUGIN_ID = 'crm-workspace';
export const PLUGIN_NAME = 'dsh-crm-workspace';

/** 场景配置文件的 schema 版本；升级结构时必须同步 bump 并写迁移。 */
export const STATE_VERSION = 1;

export const DEFAULT_DATA_DIRNAME = 'crm-workspace';
export const STATE_FILE = 'state.json';
export const BACKUP_FILE = 'state.backup.json';

/** 卡片默认动作类型。 */
export const ACTIONS = Object.freeze(['CREATE', 'UPDATE', 'AUTO']);

/** 表单上下文入口。 */
export const FORM_CONTEXT_ENTRIES = Object.freeze(['STANDARD', 'QUICK_ACTION']);

/** 所有长度/数量上限（字符数按 Unicode 码点计）。 */
export const LIMITS = Object.freeze({
  maxScenarioCards: 200,
  title: 120,
  description: 2000,
  category: 60,
  welcomeMessage: 1000,
  pinnedSkills: 40,
  skillName: 128,
  objectApiName: 80,
  icon: 64,
  slashCommand: 32,
  maxActivations: 200,
});

/** scenarioId：稳定、可读、可写进日志与注入标记。 */
export const SCENARIO_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** slashCommand：`/` + 小写字母开头，允许小写字母/数字/连字符。 */
export const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9-]{0,31}$/;

/** Salesforce 对象 API 名（自定义对象带 `__c`）。 */
export const OBJECT_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** 管理员新增卡片时的分类建议值（可自由输入，不是枚举）。 */
export const SCENARIO_CATEGORIES = Object.freeze([
  '核心单据管控',
  '客户管理',
  '销售跟进',
  '数据分析',
  '服务支持',
]);

/**
 * 图标目录：键是持久化在卡片里的标识，值是中英文标签。
 * 客户端 `lib/client.js` 持有同一份键的 SVG 图形；未知键会回退到 `sparkles`，
 * 因此升级目录不会让历史卡片变成空白图标。
 */
export const ICON_CATALOG = Object.freeze([
  { id: 'briefcase', zh: '核心单据', en: 'Core record' },
  { id: 'file-plus', zh: '新建单据', en: 'New record' },
  { id: 'edit', zh: '编辑修改', en: 'Edit' },
  { id: 'search', zh: '查询检索', en: 'Search' },
  { id: 'users', zh: '客户', en: 'Customer' },
  { id: 'chart', zh: '分析', en: 'Analytics' },
  { id: 'target', zh: '商机', en: 'Opportunity' },
  { id: 'shield', zh: '权限合规', en: 'Governance' },
  { id: 'clipboard', zh: '流程清单', en: 'Checklist' },
  { id: 'building', zh: '组织', en: 'Organization' },
  { id: 'workflow', zh: '协同流程', en: 'Workflow' },
  { id: 'sparkles', zh: '智能助手', en: 'Assistant' },
]);

export const DEFAULT_ICON = 'sparkles';

export const ICON_IDS = Object.freeze(ICON_CATALOG.map((icon) => icon.id));

/** 场景上下文块在模型请求里的首行标记：用于人工排查与幂等判定。 */
export const CONTEXT_MARKER = '[[crm-workspace:context]]';

/** 注入预算：单个 Skill 正文与整块上下文的上限（字符）。 */
export const INJECTION_BUDGET = Object.freeze({
  perSkill: 16000,
  total: 48000,
});

export const EVENTS = Object.freeze({
  preStep: 'agent/pre-step',
});
