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

import { EVENTS, DEFAULT_DATA_DIRNAME } from './core/constants.js';
import { createApi } from './core/api.js';
import { createStateStore } from './core/state.js';
import { mountApiRoutes } from './web.js';

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

  return {
    dataDir,
    skillCatalogDir,
    maxScenarioCards,
    injectSkillsOnStep: source.injectSkillsOnStep !== false,
    // 默认只注入 Skill 名称，正文由模型用 skill 工具按顺序加载：
    // 进入场景时不要把几万字的技能说明塞进上下文。
    injectSkillBodies: source.injectSkillBodies === true,
    injectSkillDescriptions: source.injectSkillDescriptions === true,
    registerSlashCommands: source.registerSlashCommands !== false,
    showSidebarEntry: source.showSidebarEntry !== false,
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

  const api = createApi({
    store,
    config,
    logger,
    getSkills: rootSkills,
    catalogDir: () => config.skillCatalogDir,
    onChange: () => syncCommands(),
  });

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

  const reconcile = () => {
    const next = candidates.get('webStartup') ?? candidates.get('webRuntime');
    if (next === activeWeb) return;
    disposeRoutes?.();
    disposeRoutes = undefined;
    activeWeb = next;
    if (next !== undefined) {
      disposeRoutes = mountApiRoutes(next.ctx, api, { logger, trustedHosts: next.trustedHosts });
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
