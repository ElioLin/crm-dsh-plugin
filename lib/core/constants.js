/**
 * CRM 智能工作台 —— 常量与硬约束。
 *
 * 这里定义的所有上限都会被 Host 端校验读取一次（lib/core/schema.js），
 * 也会通过 `bootstrap` 下发给客户端，前端据此渲染计数与提示，
 * 避免「界面允许输入、后端静默截断」这种生产事故。
 */

export const PLUGIN_ID = 'crm-workspace';
export const PLUGIN_NAME = 'dsh-crm-workspace';
export const PLUGIN_VERSION = '1.4.0';

/**
 * MCP 控制平面服务的默认基础地址。
 *
 * 地址解析只有一条规则：优先 `config.apiBaseUrl`，未配置时直接用这个默认值，
 * 随后统一去掉末尾斜杠。上生产时只需要改 `cordis.patch.yml` 的 `apiBaseUrl`。
 */
export const DEFAULT_MCP_API_BASE_URL = 'http://crmmcptest.runner-corp.com.cn:9000';

/** 插件调用的 MCP 标准场景接口前缀。 */
export const MCP_API_PREFIX = '/api/dsh';

/** 场景配置文件的 schema 版本；升级结构时必须同步 bump 并写迁移。 */
export const STATE_VERSION = 2;

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
  title: 128,
  description: 4000,
  category: 64,
  welcomeMessage: 1000,
  inputDraft: 2000,
  presetAttachments: 20,
  fileName: 200,
  fileSize: 10 * 1024 * 1024,
  attachmentPath: 512,
  version: 32,
  author: 80,
  pinnedSkills: 40,
  skillName: 128,
  objectApiName: 80,
  icon: 64,
  slashCommand: 32,
  maxActivations: 200,
});

/** 公司标准场景的远端状态；只有 PUBLISHED 会出现在「公司推出的场景」页签。 */
export const SCENARIO_STATUSES = Object.freeze(['PUBLISHED', 'DRAFT', 'ARCHIVED']);

/**
 * 场景来源：本地自建/克隆 vs 公司标准场景。
 *
 * 兼容旧存档：历史上本地来源写的是 `LOCAL_INSTALLED`，读档时统一迁移为
 * `LOCAL_CUSTOM`（见 schema.js 的 coerceStoredScenario）。
 */
export const SCENARIO_SOURCE_TYPES = Object.freeze({
  LOCAL: 'LOCAL_CUSTOM',
  COMPANY: 'COMPANY_STANDARD',
});

/** 旧版本存档里的来源值 → 当前值。 */
export const LEGACY_SOURCE_TYPES = Object.freeze({
  LOCAL_INSTALLED: 'LOCAL_CUSTOM',
});

/** 场景预设附件的固定角色标识：与用户临时上传的业务归档附件严格区分。 */
export const PRESET_ATTACHMENT_ROLE = 'SCENARIO_PRESET';

/** 允许作为场景预设附件上传的扩展名。 */
export const PRESET_ATTACHMENT_EXTENSIONS = Object.freeze(['.docx', '.csv', '.xlsx', '.pdf', '.md', '.txt']);

/** 预设附件的落盘目录（相对插件数据目录）与只读下发路由。 */
export const ASSET_DIRNAME = 'attachments';
export const ASSET_ROUTE = '/crm-workspace/asset';

/**
 * scenarioId：与服务端 zod 校验保持一致。
 * 首字符必须是字母或数字，其余允许字母/数字/点/下划线/连字符，最长 64。
 */
export const SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 服务端保留字：不能作为 scenarioId。 */
export const RESERVED_SCENARIO_IDS = Object.freeze(['permission']);

export function isValidScenarioId(value) {
  return (
    typeof value === 'string' &&
    SCENARIO_ID_PATTERN.test(value) &&
    !RESERVED_SCENARIO_IDS.includes(value.toLowerCase())
  );
}

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
