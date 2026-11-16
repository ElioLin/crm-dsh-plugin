/**
 * CRM 智能工作台 —— Host 端微内核。
 *
 * 职责只有四件事：
 *   1. 打开场景存档（`<profile>/crm-workspace/state.json`）；
 *   2. 注册同源 HTTP JSON 接口，供面板读写场景；
 *   3. 在 `agent/pre-step` 里按会话注入「已激活场景 + 技能栈」；
 *   4. 把每张卡片的 slashCommand 注册成真正的 Host 指令。
 *
 * 卡片内容一律来自管理员配置，本文件不含任何业务场景常量。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_MCP_API_BASE_URL,
  DEFAULT_PLATFORM_USER_HEADER,
  EVENTS,
  ASSET_DIRNAME,
  ASSET_ROUTE,
  DEFAULT_DATA_DIRNAME,
  IDENTITY_FILE,
  IDENTITY_KEYS,
  PLUGIN_VERSION,
  SESSION_TOKEN_FILE,
} from './core/constants.js';
import { createApi } from './core/api.js';
import { createAssetStore } from './core/assets.js';
import { createStateStore } from './core/state.js';
import { mountApiRoutes, mountAssetRoutes } from './web.js';

export const name = 'crm-workspace';

/** 配置不做 schema 校验（profile 里没有 schemastery），因此在 apply 里手工收敛。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const profileDir = process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? process.cwd();
  const dataDirRaw = typeof source.dataDir === 'string' ? source.dataDir.trim() : '';
  const dataDir =
    dataDirRaw === ''
      ? join(profileDir, DEFAULT_DATA_DIRNAME)
      : isAbsolute(dataDirRaw)
        ? dataDirRaw
        : join(profileDir, dataDirRaw);

  const maxRaw = Number(source.maxScenarioCards);
  const maxScenarioCards = Number.isFinite(maxRaw)
    ? Math.min(Math.max(Math.trunc(maxRaw), 1), 200)
    : 200;

  // Skill 目录兜底：显式配置优先；未配置时自动尝试 <DSH_HOME>/skills；
  // 配成 "off"/"none" 可关闭。目录只读，不注册、不改注册表。
  const catalogRaw = typeof source.skillCatalogDir === 'string' ? source.skillCatalogDir.trim() : '';
  let skillCatalogDir = '';
  if (catalogRaw === 'off' || catalogRaw === 'none' || catalogRaw === 'false') {
    skillCatalogDir = '';
  } else if (catalogRaw !== '') {
    skillCatalogDir = isAbsolute(catalogRaw) ? catalogRaw : join(profileDir, catalogRaw);
  } else {
    const candidate = join(process.env.DSH_HOME ?? profileDir, 'skills');
    skillCatalogDir = existsSync(candidate) ? candidate : '';
  }

  // MCP 控制平面：地址解析只有一条规则 —— 显式 apiBaseUrl → 内置默认值。
  const apiBaseUrlRaw =
    typeof source.apiBaseUrl === 'string' ? source.apiBaseUrl.trim() : '';
  const apiBaseUrl = (apiBaseUrlRaw === '' ? DEFAULT_MCP_API_BASE_URL : apiBaseUrlRaw).replace(/\/+$/, '');

  return {
    dataDir,
    skillCatalogDir,
    maxScenarioCards,
    apiBaseUrl,
    authMode:
      source.authMode === 'internal_bearer' ? 'internal_bearer' : source.authMode === 'buntu' ? 'buntu' : 'auto',
    buntuToken: typeof source.buntuToken === 'string' ? source.buntuToken.trim() : '',
    mcpClientToken: typeof source.mcpClientToken === 'string' ? source.mcpClientToken.trim() : '',
    platformUserId: typeof source.platformUserId === 'string' ? source.platformUserId.trim() : '',
    platformUserHeader:
      typeof source.platformUserHeader === 'string' && source.platformUserHeader.trim() !== ''
        ? source.platformUserHeader.trim().toLowerCase()
        : DEFAULT_PLATFORM_USER_HEADER,
    injectSkillsOnStep: source.injectSkillsOnStep !== false,
    // 默认只注入 Skill 名称，正文由模型用 skill 工具按顺序加载：
    // 进入场景时不要把几万字的技能说明塞进上下文。
    injectSkillBodies: source.injectSkillBodies === true,
    injectSkillDescriptions: source.injectSkillDescriptions === true,
    registerSlashCommands: source.registerSlashCommands !== false,
    showSidebarEntry: source.showSidebarEntry !== false,
    // 创建人兜底：留空时由宿主账号资料带出；显式配置则固定使用该值。
    defaultAuthor: typeof source.defaultAuthor === 'string' ? source.defaultAuthor.trim() : '',
  };
}

/**
 * 读取一个 JSON 对象文件；不存在、不可读、格式不对时一律返回空对象。
 *
 * 身份文件由登录门禁写、随时可能被改写或删除，所以每次调用都重新读，
 * 并把所有异常吞掉（读不到只表示「本机没有这个身份」，不是错误）。
 */
function readJsonObject(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return {};
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 取第一个非空文本（数字按字符串处理）；全部为空时返回空串。 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** DSH 家目录：身份文件与会话文件都放在这里，由宿主进程环境给出。 */
function dshHomeDir(env = process.env) {
  return firstText(env.DSH_HOME) || firstText(env.DSH_PROFILE_DIR) || process.cwd();
}

/**
 * 本机登录身份：`<DSH_HOME>/identity.json` 由公司登录门禁写入，
 * 里面的 `salary_id` 就是 MCP 控制面用来查身份路由的「平台用户标识」。
 * 因此用户不需要在插件配置里再填一遍自己的工号。
 */
function readLocalPlatformUserId(env = process.env) {
  const record = readJsonObject(join(dshHomeDir(env), IDENTITY_FILE));
  return firstText(...IDENTITY_KEYS.map((key) => record[key]));
}

/**
 * 读取本地环境文件（`<DSH_HOME>/.env`，可被 `DSH_ENV_FILE` 覆盖）。
 *
 * 宿主进程启动时会把 `.env` 读进 `process.env`，但部署脚本在运行期追加的
 * 凭据不会自动出现在已启动进程的环境里；这里再读一次文件，让「补一条
 * `CRM_MCP_CLIENT_TOKEN=` 后点同步」就能生效，不必重启整个桌面端。
 * 解析只支持 `KEY=VALUE` 与 `#` 注释，取值去引号；读不到一律当空对象。
 */
function readEnvFile(env = process.env) {
  const filePath = firstText(env.DSH_ENV_FILE) || join(dshHomeDir(env), '.env');
  let raw = '';
  try {
    if (!existsSync(filePath)) return {};
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && value !== '') values[key] = value;
  }
  return values;
}

/** 按「进程环境 → 本地 .env 文件」的顺序取第一个非空值。 */
function readEnvValue(env, envFile, ...keys) {
  for (const key of keys) {
    const value = firstText(env[key]) || firstText(envFile[key]);
    if (value !== '') return value;
  }
  return '';
}

/**
 * 创建 `internal_bearer` 凭据解析器：共享客户端 Token + 平台用户标识。
 *
 * 客户端 Token 是部署级密钥，按「显式配置 → 环境变量 → `.env`」解析；
 * 用户标识按「显式配置 → 环境变量 → 登录门禁写的 identity.json」解析。
 * 两者齐备才返回，缺任何一项都表示这台机器没有该部署的内部凭据，
 * 调用方应落回 Buntu 模式。结果缓存一分钟：换人登录后最多一分钟后生效，
 * 也避免每次请求都读文件。
 *
 * @param {{authMode?: string, mcpClientToken?: string, platformUserId?: string}} config
 * @param {{logger?: {info?: Function, warn?: Function}, env?: Record<string, string | undefined>}} [options]
 * @returns {() => Promise<{mcpClientToken: string, platformUserId: string, source: string} | null>}
 */
export function createInternalCredentialResolver(config, { logger, env = process.env } = {}) {
  const TTL_MS = 60_000;
  let cache = { value: null, at: 0 };
  let warned = false;
  return async () => {
    if (config?.authMode === 'buntu') return null;
    if (Date.now() - cache.at < TTL_MS) return cache.value;
    const envFile = readEnvFile(env);
    const envToken = readEnvValue(env, envFile, 'CRM_MCP_CLIENT_TOKEN', 'MCP_CLIENT_TOKEN', 'DSH_MCP_CLIENT_TOKEN');
    const envUser = readEnvValue(env, envFile, 'CRM_PLATFORM_USER_ID', 'MCP_PLATFORM_USER_ID', 'DSH_PLATFORM_USER_ID');
    const clientToken = firstText(config?.mcpClientToken, envToken);
    const localUser = readLocalPlatformUserId(env);
    const platformUserId = firstText(config?.platformUserId, envUser, localUser);
    const tokenSource = firstText(config?.mcpClientToken) !== '' ? 'config' : envToken !== '' ? 'env' : '';
    const userSource =
      firstText(config?.platformUserId) !== '' ? 'config' : envUser !== '' ? 'env' : localUser !== '' ? 'identity' : '';
    const value =
      clientToken === '' || platformUserId === ''
        ? null
        : {
            mcpClientToken: clientToken,
            platformUserId,
            source: `${tokenSource}+${userSource}`,
          };
    if (value === null && !warned) {
      warned = true;
      logger?.info?.(
        '[crm-workspace] 未找到 internal_bearer 凭据（部署客户端 Token 或登录身份缺失），将回退到 Buntu Token 模式。',
      );
    }
    cache = { value, at: Date.now() };
    return value;
  };
}

function safeLogger(ctx) {
  const emit = (level, args) => {
    try {
      const logger = ctx.reflect?.get?.('logger');
      const fn = logger?.[level];
      if (typeof fn === 'function') {
        fn.apply(logger, args);
        return;
      }
    } catch {
      /* logger 服务不可用：继续走下面的兜底 */
    }
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(...args);
  };
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

/** 取出消息里的纯文本（只为判断结构，不做业务解析）。 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * 用「会话里已有的用户消息」当模板克隆一条注入消息。
 *
 * 不自己拼 MessageBase：它的字段（id/source/时间戳等）由会话层定义，
 * 手写出来的对象可能缺字段而被下游判为非法消息。结构无法识别时返回 undefined，
 * 由调用方放弃注入（宁可少一段上下文，也不能破坏请求）。
 */
export function cloneWithText(message, text, suffix) {
  if (message === null || typeof message !== 'object') return undefined;
  const id = `${String(message.id ?? 'msg')}-crm-${suffix}`;
  if (typeof message.content === 'string') return { ...message, id, content: text };
  if (Array.isArray(message.content)) {
    return { ...message, id, content: [{ type: 'text', text }] };
  }
  return undefined;
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = safeLogger(ctx);

  const store = createStateStore({ dataDir: config.dataDir, logger });
  await store.ready();
  if (store.degraded !== undefined) logger.error(`[crm-workspace] ${store.degraded}`);

  /** 由 commands 注入块在服务就绪时写入；api 变更后调用它重算指令表。 */
  let syncCommands = () => undefined;

  /** Host 根作用域下的 skills 服务（注册表是分层的：根视图只含全局层）。 */
  const rootSkills = () => {
    try {
      return ctx.reflect?.get?.('skills') ?? ctx.get?.('skills');
    } catch {
      return undefined;
    }
  };

  /**
   * 优先取「派发作用域」里的 skills 服务（含该会话所属 preset 层），
   * 拿不到就退回根视图 —— 任何情况下都不能让注入流程抛错。
   */
  const scopedSkills = (scopeCtx) => {
    try {
      if (scopeCtx !== null && typeof scopeCtx === 'object' && typeof scopeCtx.get === 'function') {
        const service = scopeCtx.get('skills');
        if (service !== undefined) return service;
      }
    } catch {
      /* 非作用域派发时 get 会抛错：忽略并退回根视图 */
    }
    return rootSkills();
  };

  const assets = createAssetStore({ dir: join(config.dataDir, ASSET_DIRNAME), logger });

  /* ── 当前登录用户（创建人只读字段的数据来源） ─────────────────── */
  const CURRENT_USER_TTL_MS = 5 * 60 * 1000;
  let currentUserCache = { value: '', at: 0 };
  let currentUserPending = null;

  /** 宿主账号资料里的显示名；账号服务缺失或未登录时返回空串。 */
  const readAccountName = async () => {
    let account;
    try {
      account = ctx.reflect?.get?.('deepseekAccount') ?? ctx.get?.('deepseekAccount');
    } catch {
      account = undefined;
    }
    if (account === undefined || account === null || typeof account.getProfile !== 'function') return '';

    const client = {
      version: PLUGIN_VERSION,
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
    // 账号查询会走一次网络：加超时，失败也不能拖住 bootstrap（客户端每 5s 轮询一次）。
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), 1500);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const profile = await Promise.race([account.getProfile(client), timeout]);
      if (profile?.status !== 'ready') return '';
      const name = profile.value?.name ?? profile.value?.contact ?? '';
      return typeof name === 'string' ? name.trim() : '';
    } finally {
      clearTimeout(timer);
    }
  };

  const resolveCurrentUser = async () => {
    if (config.defaultAuthor !== '') return config.defaultAuthor;
    if (currentUserCache.value !== '' && Date.now() - currentUserCache.at < CURRENT_USER_TTL_MS) {
      return currentUserCache.value;
    }
    if (currentUserPending !== null) return currentUserPending;
    const pending = (async () => {
      let name = '';
      try {
        name = await readAccountName();
      } catch (error) {
        logger.warn(`[crm-workspace] 读取账号资料失败：${error?.message ?? error}`);
      }
      if (name === '') name = (process.env.USERNAME ?? process.env.USER ?? '').trim();
      if (name === '') name = '本机用户';
      currentUserCache = { value: name, at: Date.now() };
      return name;
    })();
    currentUserPending = pending.finally(() => {
      currentUserPending = null;
    });
    return currentUserPending;
  };

  // internal_bearer 凭据：部署级客户端 Token（配置/环境）+ 登录身份（identity.json）。
  const resolveInternalCredential = createInternalCredentialResolver(config, { logger });

  /**
   * 从 DSH 宿主上下文读取用户 Buntu Token。
   *
   * 宿主不同版本的账号服务方法名可能不同，因此按能力探测而不是写死：
   * `getToken / getAccessToken / getBuntuToken`，以及账号资料里的 token 字段。
   * 最后回退到进程环境变量（便于本地联调）。
   */
  const readHostToken = async () => {
    const services = [];
    for (const serviceName of ['deepseekAccount', 'account']) {
      try {
        const service = ctx.reflect?.get?.(serviceName) ?? ctx.get?.(serviceName);
        if (service !== undefined && service !== null) services.push(service);
      } catch {
        /* 服务不可用时继续尝试下一个 */
      }
    }

    for (const service of services) {
      for (const method of ['getToken', 'getAccessToken', 'getBuntuToken']) {
        if (typeof service?.[method] !== 'function') continue;
        try {
          const value = await service[method]();
          if (typeof value === 'string' && value.trim() !== '') return value.trim();
          if (typeof value?.token === 'string' && value.token.trim() !== '') return value.token.trim();
        } catch {
          /* 单个方法失败不阻塞其他探测 */
        }
      }
      if (typeof service?.getProfile === 'function') {
        try {
          const profile = await service.getProfile({
            version: PLUGIN_VERSION,
            locale: 'zh-CN',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          });
          const value = profile?.value ?? {};
          const token = value.token ?? value.accessToken ?? value.buntuToken;
          if (typeof token === 'string' && token.trim() !== '') return token.trim();
        } catch {
          /* 账号资料不可用时忽略 */
        }
      }
    }

    return (
      (typeof process.env.DSH_BUNTU_TOKEN === 'string' ? process.env.DSH_BUNTU_TOKEN.trim() : '') ||
      (typeof process.env.BUNTU_TOKEN === 'string' ? process.env.BUNTU_TOKEN.trim() : '')
    );
  };

  const api = createApi({
    store,
    config,
    logger,
    getSkills: rootSkills,
    catalogDir: () => config.skillCatalogDir,
    onChange: () => syncCommands(),
    assets,
    getCurrentUser: resolveCurrentUser,
    getAuthToken: readHostToken,
    getInternalCredential: resolveInternalCredential,
  });

  /**
   * 启动后台同步的门禁：只有「确实能带上身份」时才发第一个请求。
   *
   * 三种情况会同步：显式配置了 Buntu Token、配置/环境里给了 Buntu Token、
   * 或者能自动解析出 internal_bearer 凭据（共享 Token + 登录身份）。
   * 全都拿不到时保持安静 —— 等用户打开面板时再按需拉取，避免无意义的 401。
   */
  const startupTimer = setTimeout(() => {
    void (async () => {
      const credential = await resolveInternalCredential();
      const hasAuth =
        config.buntuToken !== '' ||
        firstText(process.env.DSH_BUNTU_TOKEN, process.env.BUNTU_TOKEN) !== '' ||
        credential !== null;
      if (!hasAuth) return;
      const result = await api.syncCompanyScenarios();
      if (result?.ok === false) {
        logger.warn(`[crm-workspace] 启动同步公司标准场景失败：${result.message ?? '未知原因'}`);
      }
    })().catch((error) => {
      logger.warn(`[crm-workspace] 启动同步公司标准场景失败：${error?.message ?? error}`);
    });
  }, 1500);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  /* ── 1. 注入技能栈 ──────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.on(
        EVENTS.preStep,
        // 故意用 function 而不是箭头函数：Cordis 以「派发作用域」作为 this，
        // 这样能拿到本次请求的**分层视图** skills 服务（比 Host 根的视图更完整）。
        async function crmWorkspacePreStep(payload, next) {
          const decision = await next();
          if (decision?.kind !== 'enter' || !Array.isArray(decision.messages) || decision.messages.length === 0) {
            return decision;
          }
          const agentId = payload?.agent?.id;
          if (typeof agentId !== 'string' || agentId === '') return decision;

          let injection;
          try {
            injection = await api.prepareInjection(agentId, {
              getSkills: () => scopedSkills(this),
            });
          } catch (error) {
            logger.error(`[crm-workspace] 注入场景上下文失败：${error?.message ?? error}`);
            return decision;
          }
          if (injection === undefined) return decision;

          const template =
            [...decision.messages].reverse().find((message) => message?.role === 'user') ??
            decision.messages[decision.messages.length - 1];
          const injected = cloneWithText(template, injection.text, `${Date.now().toString(36)}`);
          if (injected === undefined) {
            logger.warn('[crm-workspace] 无法识别的消息结构，跳过本次场景注入');
            return decision;
          }
          logger.info(
            `[crm-workspace] 会话 ${agentId} 注入场景 ${injection.card.scenarioId}（${injection.mode}，${[...injection.text].length} 字符）`,
          );
          return { ...decision, messages: [...decision.messages, injected] };
        },
        { prepend: true },
      ),
    'crm-workspace: inject scenario context',
  );

  /* ── 2. HTTP 接口（随 webServer 生命周期重挂） ─────────────── */
  const candidates = new Map();
  let activeWeb;
  let disposeRoutes;
  let disposeAssets;

  const reconcile = () => {
    const next = candidates.get('webStartup') ?? candidates.get('webRuntime');
    if (next === activeWeb) return;
    disposeRoutes?.();
    disposeAssets?.();
    disposeRoutes = undefined;
    disposeAssets = undefined;
    activeWeb = next;
    if (next !== undefined) {
      disposeRoutes = mountApiRoutes(next.ctx, api, { logger, trustedHosts: next.trustedHosts });
      disposeAssets = mountAssetRoutes(next.ctx, assets, {
        path: ASSET_ROUTE,
        logger,
        trustedHosts: next.trustedHosts,
      });
      logger.info('[crm-workspace] HTTP 接口已挂载于 /crm-workspace/api');
    }
  };

  for (const serviceName of ['webStartup', 'webRuntime']) {
    ctx.inject(['webServer', serviceName], (wctx) => {
      wctx.effect(() => {
        const candidate = { ctx: wctx, trustedHosts: wctx[serviceName]?.trustedHosts ?? [] };
        candidates.set(serviceName, candidate);
        reconcile();
        return () => {
          if (candidates.get(serviceName) === candidate) candidates.delete(serviceName);
          reconcile();
        };
      });
    });
  }

  /* ── 3. slashCommand → Host 指令 ───────────────────────────── */
  ctx.inject(['commands'], (cctx) => {
    let disposers = [];

    const clear = () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch (error) {
          logger.warn(`[crm-workspace] 注销指令失败：${error?.message ?? error}`);
        }
      }
      disposers = [];
    };

    const sync = () => {
      clear();
      if (config.registerSlashCommands !== true) return;
      const cards = store.scenarios();
      const reserved = new Set(cards.map((card) => card.slashCommand.replace(/^\//, '')));
      const taken = new Set();

      for (const card of cards) {
        if (card.enabled !== true) continue;
        const command = card.slashCommand.replace(/^\//, '');
        if (taken.has(command)) continue;
        taken.add(command);
        try {
          const dispose = cctx.commands.register({
            name: command,
            description: `场景：${card.title}`,
            handler: async (invocation) => {
              const sessionId = invocation?.agent?.id;
              if (typeof sessionId !== 'string' || sessionId === '') {
                return { kind: 'error', text: '当前没有可用会话，无法激活场景。' };
              }
              const result = await api.activateScenario({ sessionId, scenarioId: card.scenarioId, source: 'command' });
              if (result?.ok !== true) return { kind: 'error', text: result?.message ?? '激活失败' };
              const stack = (result.skills ?? [])
                .map((skill) => (skill.missing === true ? `${skill.name}（缺失）` : skill.name))
                .join(' → ');
              return {
                kind: 'success',
                text: `已切换到「${card.title}」场景。\n技能栈：${stack === '' ? '未绑定' : stack}\n${card.welcomeMessage}`,
              };
            },
          });
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          logger.warn(`[crm-workspace] 注册指令 ${command} 失败：${error?.message ?? error}`);
        }
      }

      if (!reserved.has('crm')) {
        try {
          const dispose = cctx.commands.register({
            name: 'crm',
            description: '列出 CRM 智能工作台里配置的场景',
            handler: async () => {
              const enabled = store.scenarios().filter((card) => card.enabled === true);
              if (enabled.length === 0) {
                return { kind: 'success', text: '尚未配置任何启用中的场景：请打开「CRM 智能工作台」面板新增。' };
              }
              const lines = enabled.map(
                (card) => `${card.slashCommand}  ${card.title} — ${card.description.replace(/\s+/g, ' ').slice(0, 40)}`,
              );
              return { kind: 'success', text: `可用场景：\n${lines.join('\n')}` };
            },
          });
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          logger.warn(`[crm-workspace] 注册指令 crm 失败：${error?.message ?? error}`);
        }
      }
    };

    syncCommands = sync;
    cctx.effect(() => {
      sync();
      return () => {
        syncCommands = () => undefined;
        clear();
      };
    }, 'crm-workspace: slash commands');
  });
}
