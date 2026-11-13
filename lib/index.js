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

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_MCP_API_BASE_URL,
  EVENTS,
  ASSET_DIRNAME,
  ASSET_ROUTE,
  DEFAULT_DATA_DIRNAME,
  PLUGIN_VERSION,
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
    authMode: source.authMode === 'internal_bearer' ? 'internal_bearer' : 'buntu',
    buntuToken: typeof source.buntuToken === 'string' ? source.buntuToken.trim() : '',
    mcpClientToken: typeof source.mcpClientToken === 'string' ? source.mcpClientToken.trim() : '',
    platformUserId: typeof source.platformUserId === 'string' ? source.platformUserId.trim() : '',
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
  });

  /**
   * 配置了静态凭据时，启动后做一次后台同步（不阻塞 Host 启动、不写 UI）。
   * 未配置凭据时不做任何网络请求：等用户打开面板 / 公司页签时再按需拉取。
   */
  const hasStaticAuth =
    config.buntuToken !== '' ||
    (config.authMode === 'internal_bearer' &&
      config.mcpClientToken !== '' &&
      config.platformUserId !== '');
  if (hasStaticAuth) {
    const timer = setTimeout(() => {
      void api
        .syncCompanyScenarios()
        .then((result) => {
          if (result?.ok === false) {
            logger.warn(`[crm-workspace] 启动同步公司标准场景失败：${result.message ?? '未知原因'}`);
          }
        })
        .catch((error) => {
          logger.warn(`[crm-workspace] 启动同步公司标准场景失败：${error?.message ?? error}`);
        });
    }, 1500);
    if (typeof timer.unref === 'function') timer.unref();
  }

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
