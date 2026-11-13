/**
 * Host 端业务门面：把「存档 + Skill 仓库 + MCP 标准场景控制平面」收成一个
 * 可被 HTTP 路由与指令共用的对象。
 *
 * 这一层不碰 HTTP、不碰 Cordis，只依赖注入进来的 `store` / `skills` / `config` /
 * `registry`，因此可以在 node:test 里用假 store 与假 MCP 客户端覆盖全部业务分支。
 *
 * 两条最重要的业务红线：
 *   1. 远端新发布的标准场景只进入「公司推出的场景」缓存，绝不自动塞进用户
 *      的「已安装场景」；只有用户点击安装后才进入 `store.scenarios()`。
 *   2. 所有发往服务端的写请求都经过 `toRemoteWritePayload`，请求体中永不出现
 *      version / revision / createdAt / updatedAt / presetAttachments。
 */

import {
  ACTIONS,
  ASSET_ROUTE,
  DEFAULT_ICON,
  FORM_CONTEXT_ENTRIES,
  ICON_CATALOG,
  LIMITS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  PRESET_ATTACHMENT_EXTENSIONS,
  PRESET_ATTACHMENT_ROLE,
  SCENARIO_CATEGORIES,
  SCENARIO_SOURCE_TYPES,
  STATE_VERSION,
  isValidScenarioId,
} from './constants.js';
import { buildContextBlock } from './block.js';
import {
  createRegistry,
  deriveSlashCommandFromScenarioId,
  fromRemoteScenario,
  normalizeAuth,
  normalizeSha256,
  packageFileName,
  sha256Hex,
  toRemoteWritePayload,
} from './registry.js';
import { scanSkillDir } from './skilldir.js';
import {
  duplicateScenario,
  moveScenario,
  normalizeScenario,
  normalizeSlashCommand,
} from './schema.js';

const MAX_SKILL_ROWS = 500;

/** 场景包格式标识：导出/导入两侧都按这个校验，避免误吃别的 JSON。 */
const PACKAGE_FORMAT = 'crm-scenario-package';
const PACKAGE_FORMAT_VERSION = 1;
/** 导出时单个附件允许内联进 JSON 的上限；与服务端单附件上限保持一致。 */
const MAX_INLINE_ATTACHMENT_BYTES = LIMITS.fileSize;

/** 权限缓存时长：抽屉每次打开会强制刷新，普通操作复用短期缓存。 */
const PERMISSION_TTL_MS = 30_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(text(value));
}

function isLocalRelativePath(value) {
  const raw = text(value);
  return raw !== '' && !isHttpUrl(raw);
}

function emptyAuth() {
  return {
    authenticated: false,
    platformUserId: null,
    crmUsername: null,
    canManageStandardScenario: false,
  };
}

function attachmentUrl(attachment) {
  const raw = text(attachment?.localPathOrUrl);
  if (raw === '') return '';
  // 远端标准场景尚未缓存到本地时，直接给完整下载地址。
  if (isHttpUrl(raw)) return raw;
  const name = raw.split('/').pop();
  return name === '' ? '' : `${ASSET_ROUTE}/${encodeURIComponent(name)}`;
}

function publicAttachment(attachment) {
  return {
    attachmentId: attachment.attachmentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    sha256: attachment.sha256,
    role: attachment.role,
    url: attachmentUrl(attachment),
  };
}

/** 卡片对外视图：附件补上可 GET 的 url，其余字段原样下发给客户端。 */
function cardView(card) {
  const attachments = Array.isArray(card?.presetAttachments) ? card.presetAttachments : [];
  if (attachments.length === 0) return card;
  return { ...card, presetAttachments: attachments.map(publicAttachment) };
}

function toSkillMap(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item?.name === 'string' && !map.has(item.name)) map.set(item.name, item);
  }
  return map;
}

/** 两个附件是否指向同一份场景资产（远端 ID 优先，其次文件名+大小）。 */
function sameAttachment(left, right) {
  const leftId = text(left?.attachmentId);
  const rightId = text(right?.attachmentId);
  if (leftId !== '' && rightId !== '' && leftId === rightId) return true;
  const leftName = text(left?.fileName);
  const rightName = text(right?.fileName);
  if (leftName === '' || leftName !== rightName) return false;
  const leftSize = Number(left?.fileSize) || 0;
  const rightSize = Number(right?.fileSize) || 0;
  if (leftSize > 0 && rightSize > 0) return leftSize === rightSize;
  return true;
}

function attachmentsEquivalent(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    if (other === undefined) return false;
    return (
      text(item.attachmentId) === text(other.attachmentId) &&
      text(item.fileName) === text(other.fileName) &&
      text(item.sha256) === text(other.sha256) &&
      text(item.localPathOrUrl) === text(other.localPathOrUrl) &&
      (Number(item.fileSize) || 0) === (Number(other.fileSize) || 0)
    );
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./state.js').createStateStore>} options.store
 * @param {object} options.config 已归一化的插件配置
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @param {() => object | undefined} [options.getSkills] 返回 Host 的 skills 服务
 * @param {() => string | Promise<string>} [options.getAuthToken] Buntu Token 解析器
 */
export function createApi({
  store,
  config,
  logger,
  getSkills,
  onChange,
  catalogDir,
  assets,
  registry,
  getCurrentUser,
  getAuthToken,
}) {
  const assetStore = assets;
  const apiBaseUrl = text(config.apiBaseUrl) || undefined;
  const companyRegistry =
    registry ??
    createRegistry({
      apiBaseUrl,
      authMode: config.authMode,
      mcpClientToken: config.mcpClientToken,
      platformUserId: config.platformUserId,
      getToken: async () => {
        if (text(config.buntuToken) !== '') return text(config.buntuToken);
        return typeof getAuthToken === 'function' ? getAuthToken() : '';
      },
      logger,
    });

  let authCache = { auth: normalizeAuth(undefined), at: 0 };
  let syncInFlight = null;

  const currentAuth = () => ({ ...authCache.auth });

  function absorbAuth(result) {
    if (result?.auth !== undefined) {
      authCache = { auth: normalizeAuth(result.auth), at: Date.now() };
    }
    return result;
  }

  /**
   * 严格以服务端 `auth.canManageStandardScenario === true` 作为标准场景管理权限。
   * 失败时返回缓存的（默认 false）权限，绝不放行。
   */
  async function getPermission({ refresh = false } = {}) {
    const fresh = authCache.at > 0 && Date.now() - authCache.at < PERMISSION_TTL_MS;
    if (refresh !== true && fresh) {
      return { ok: true, auth: currentAuth(), cached: true };
    }
    const result = await companyRegistry.getPermission();
    absorbAuth(result);
    if (result.ok === false) {
      return {
        ok: false,
        auth: currentAuth(),
        message: result.message,
        code: result.code,
        correlationId: result.correlationId,
      };
    }
    return { ok: true, auth: currentAuth() };
  }

  let currentUserName;
  /** 当前登录用户显示名：优先远端 auth.crmUsername → 配置 → 宿主账号资料 → 进程用户。 */
  async function resolveCurrentUser() {
    if (typeof currentUserName === 'string') return currentUserName;
    const remoteName = text(currentAuth().crmUsername);
    if (remoteName !== '') {
      currentUserName = remoteName;
      return currentUserName;
    }
    if (typeof config.defaultAuthor === 'string' && config.defaultAuthor !== '') {
      currentUserName = config.defaultAuthor;
      return currentUserName;
    }
    let name = '';
    try {
      const value = await getCurrentUser?.();
      if (typeof value === 'string') name = value.trim();
    } catch (error) {
      logger?.warn?.(`[${PLUGIN_ID}] 读取当前登录用户失败：${error?.message ?? error}`);
    }
    if (name === '') {
      name = process.env.USERNAME ?? process.env.USER ?? '';
    }
    if (name === '') name = '本机用户';
    currentUserName = name;
    return currentUserName;
  }

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
    let rows = [];
    if (service !== undefined && typeof service.list === 'function') {
      try {
        const list = await service.list(options);
        rows = Array.isArray(list) ? list.slice(0, MAX_SKILL_ROWS) : [];
      } catch (error) {
        logger?.warn?.(`[${PLUGIN_ID}] 读取 Skill 列表失败：${error?.message ?? error}`);
        rows = [];
      }
    }
    const merged = rows.map((row) => ({ ...row, origin: 'registry' }));
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

  function findCompanyCard(scenarioId) {
    return store.findCompanyScenario?.(scenarioId);
  }

  /* ── 场景预设附件：落盘、清理、下载、远端校验 ─────────────────── */

  /** 保存一张新卡片后，把被移除的旧附件从磁盘删掉（避免孤儿文件长期堆积）。 */
  async function pruneAssets(previous, next) {
    if (assetStore === undefined || previous === undefined) return;
    const keep = new Set(
      (next?.presetAttachments ?? []).map((item) => text(item.localPathOrUrl)).filter(isLocalRelativePath),
    );
    for (const item of previous.presetAttachments ?? []) {
      const path = text(item.localPathOrUrl);
      if (!isLocalRelativePath(path) || keep.has(path)) continue;
      await assetStore.remove(path).catch(() => undefined);
    }
  }

  async function pruneCardAssets(card) {
    if (assetStore === undefined || card === undefined) return;
    for (const item of card.presetAttachments ?? []) {
      const path = text(item.localPathOrUrl);
      if (!isLocalRelativePath(path)) continue;
      await assetStore.remove(path).catch(() => undefined);
    }
  }

  /** 从本地资产目录或远端下载附件字节。 */
  async function readAttachmentBytes(attachment) {
    const path = text(attachment?.localPathOrUrl);
    if (isHttpUrl(path)) {
      const fetched = await companyRegistry.downloadAttachment(path);
      if (fetched.ok !== true) return { ok: false, error: fetched.error ?? '下载附件失败' };
      return {
        ok: true,
        buffer: fetched.buffer,
        sha256: sha256Hex(fetched.buffer),
      };
    }
    if (assetStore === undefined) return { ok: false, error: '当前运行环境未启用附件存储' };
    try {
      const file = await assetStore.read(path);
      return { ok: true, buffer: file.buffer, sha256: sha256Hex(file.buffer) };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /** 把一份远端附件下载、校验 sha256，并按远端 attachmentId 落盘。 */
  async function storeRemoteAttachment(remoteAttachment, knownBuffer) {
    if (assetStore === undefined) return { ok: true, attachment: { ...remoteAttachment } };
    let buffer = knownBuffer;
    let actualSha = buffer === undefined ? '' : sha256Hex(buffer);
    if (buffer === undefined) {
      const fetched = await companyRegistry.downloadAttachment(
        remoteAttachment.localPathOrUrl || remoteAttachment.downloadUrl,
      );
      if (fetched.ok !== true) {
        return { ok: false, error: fetched.error ?? '下载附件失败' };
      }
      buffer = fetched.buffer;
      actualSha = sha256Hex(buffer);
    }
    const expected = normalizeSha256(remoteAttachment.sha256);
    if (expected !== '' && actualSha !== '' && expected !== actualSha) {
      return { ok: false, error: `附件 sha256 校验失败（期望 ${expected.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…）` };
    }
    try {
      const stored = await assetStore.save({
        attachmentId: remoteAttachment.attachmentId,
        fileName: remoteAttachment.fileName,
        mimeType: remoteAttachment.mimeType,
        dataBase64: buffer.toString('base64'),
      });
      return {
        ok: true,
        attachment: {
          ...remoteAttachment,
          localPathOrUrl: stored.localPathOrUrl,
          fileSize: stored.fileSize,
          sha256: stored.sha256,
          role: PRESET_ATTACHMENT_ROLE,
        },
      };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  function findAttachmentMatch(list, item) {
    const rows = Array.isArray(list) ? list : [];
    return (
      rows.find((entry) => text(entry.attachmentId) === text(item.attachmentId)) ??
      rows.find((entry) => sameAttachment(entry, item))
    );
  }

  /**
   * 远端附件 → 本地缓存。
   *
   * - sha256 未变且本地文件仍在：直接沿用本地缓存，不重复下载；
   * - 新增 / 哈希变化：下载并按 sha256 校验后落盘；
   * - 单个失败不阻塞整体：保留远端地址（客户端仍可直接 fetch）。
   */
  async function localizeRemoteAttachments(remoteAttachments, previousAttachments = [], extraLocalAttachments = []) {
    const remoteRows = Array.isArray(remoteAttachments) ? remoteAttachments : [];
    if (remoteRows.length === 0) return { attachments: [], failed: [], downloaded: 0 };
    if (assetStore === undefined) return { attachments: remoteRows.map((item) => ({ ...item })), failed: [], downloaded: 0 };

    const previous = Array.isArray(previousAttachments) ? previousAttachments : [];
    const extra = Array.isArray(extraLocalAttachments) ? extraLocalAttachments : [];
    const attachments = [];
    const failed = [];
    let downloaded = 0;

    for (const remote of remoteRows) {
      const cached = findAttachmentMatch(previous, remote) ?? findAttachmentMatch(extra, remote);
      const cachedPath = text(cached?.localPathOrUrl);
      const cachedSha = normalizeSha256(cached?.sha256);
      const remoteSha = normalizeSha256(remote.sha256);

      if (
        cached !== undefined &&
        isLocalRelativePath(cachedPath) &&
        assetStore.exists?.(cachedPath) === true &&
        (remoteSha === '' || (cachedSha !== '' && remoteSha === cachedSha))
      ) {
        attachments.push({
          ...remote,
          localPathOrUrl: cachedPath,
          fileSize: Number(cached.fileSize) || remote.fileSize,
          sha256: cachedSha || remoteSha,
          role: PRESET_ATTACHMENT_ROLE,
        });
        continue;
      }

      let knownBuffer;
      if (
        cached !== undefined &&
        isLocalRelativePath(cachedPath) &&
        assetStore.exists?.(cachedPath) === true &&
        (remoteSha === '' || (cachedSha !== '' && remoteSha === cachedSha))
      ) {
        try {
          knownBuffer = (await assetStore.read(cachedPath)).buffer;
        } catch {
          knownBuffer = undefined;
        }
      }
      const stored = await storeRemoteAttachment(remote, knownBuffer);
      if (stored.ok === true) {
        attachments.push(stored.attachment);
        downloaded += 1;
      } else {
        failed.push({ fileName: remote.fileName, error: stored.error });
        attachments.push({ ...remote });
      }
    }

    return { attachments, failed, downloaded };
  }

  /** 导出场景包：配置 + 内联附件（超过上限的附件只留元数据并提示）。 */
  async function buildPackage(card) {
    const attachments = [];
    const skipped = [];
    for (const item of card.presetAttachments ?? []) {
      let buffer;
      let sha256 = normalizeSha256(item.sha256);
      if (isHttpUrl(item.localPathOrUrl)) {
        const downloaded = await companyRegistry.downloadAttachment(item.localPathOrUrl);
        if (downloaded.ok === true) {
          buffer = downloaded.buffer;
          sha256 = sha256Hex(buffer);
        }
      } else if (assetStore !== undefined) {
        try {
          buffer = (await assetStore.read(item.localPathOrUrl)).buffer;
          sha256 = sha256Hex(buffer);
        } catch {
          buffer = undefined;
        }
      }
      if (buffer === undefined || buffer.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
        skipped.push(item.fileName);
        attachments.push({ ...item });
        continue;
      }
      attachments.push({ ...item, dataBase64: buffer.toString('base64'), sha256 });
    }
    return {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      scenario: { ...card },
      attachments,
      skippedAttachments: skipped,
    };
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
      scenario: cardView(card),
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
   */
  async function prepareInjection(sessionId, override = {}) {
    if (config.injectSkillsOnStep !== true) return undefined;
    const record = store.activation(sessionId);
    if (record === undefined) return undefined;
    const card = findCard(record.scenarioId);
    if (card === undefined) {
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
    const textBlock = buildContextBlock({
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
    return { text: textBlock, mode, card, stack };
  }

  /* ── 标准场景同步与升级 ─────────────────────────────────────── */

  /**
   * 拉取 GET /api/dsh/scenarios?includeDeleted=true 并把已安装的标准场景
   * 静默升级/卸载。远端新场景只写入 companyStandardScenarios 缓存。
   */
  async function performSync() {
    const response = absorbAuth(await companyRegistry.listScenarios({ includeDeleted: true }));
    if (response.ok === false) {
      return {
        ok: false,
        message: response.message ?? '同步公司标准场景失败',
        code: response.code,
        correlationId: response.correlationId,
        auth: currentAuth(),
        scenarios: store.companyScenarios(),
        deletedScenarioIds: store.deletedScenarioIds?.() ?? [],
      };
    }

    const remoteRows = Array.isArray(response.scenarios) ? response.scenarios : [];
    const deletedIds = [...new Set(
      (Array.isArray(response.deletedScenarioIds) ? response.deletedScenarioIds : []).filter((id) =>
        isValidScenarioId(id),
      ),
    )];
    const deletedSet = new Set(deletedIds);

    // 只把 PUBLISHED 且未被软删除的状态放进「公司推出的场景」页签。
    const published = [];
    for (const row of remoteRows) {
      const card = fromRemoteScenario(row, companyRegistry.apiBaseUrl, {});
      if (card === undefined) continue;
      if (card.status !== 'PUBLISHED') continue;
      if (deletedSet.has(card.scenarioId)) continue;
      published.push(card);
    }
    const remoteById = new Map(published.map((card) => [card.scenarioId, card]));

    const installed = store.scenarios();
    const nextInstalled = [];
    const upgraded = [];
    const uninstalled = [];

    for (const local of installed) {
      if (local.sourceType !== SCENARIO_SOURCE_TYPES.COMPANY) {
        nextInstalled.push(local);
        continue;
      }
      const remoteId = text(local.originScenarioId) || local.scenarioId;
      const remote = remoteById.get(local.scenarioId) ?? remoteById.get(remoteId);
      const deleted = deletedIds.includes(local.scenarioId) || (remoteId !== '' && deletedIds.includes(remoteId));

      if (remote === undefined || deleted === true) {
        uninstalled.push({ scenarioId: local.scenarioId, title: local.title });
        await pruneCardAssets(local);
        continue;
      }

      const versionChanged =
        remote.version !== local.version || Number(remote.revision) !== Number(local.revision);
      const localized = await localizeRemoteAttachments(
        remote.presetAttachments,
        local.presetAttachments,
      );
      const changedAttachments = !attachmentsEquivalent(local.presetAttachments, localized.attachments);

      if (!versionChanged && !changedAttachments) {
        nextInstalled.push(local);
        continue;
      }

      const next = {
        ...remote,
        scenarioId: local.scenarioId,
        originScenarioId: remote.scenarioId,
        slashCommand: local.slashCommand,
        enabled: local.enabled,
        isSystemBase: local.isSystemBase,
        presetAttachments: localized.attachments,
      };
      nextInstalled.push(next);
      upgraded.push({
        scenarioId: local.scenarioId,
        title: remote.title,
        fromVersion: local.version,
        toVersion: remote.version,
        fromRevision: Number(local.revision) || 0,
        toRevision: Number(remote.revision) || 0,
        attachments: {
          downloaded: localized.downloaded,
          failed: localized.failed,
        },
      });
      await pruneAssets(local, next);
    }

    const changedInstalled =
      upgraded.length > 0 ||
      uninstalled.length > 0 ||
      !attachmentsEquivalent(
        installed
          .filter((card) => card.sourceType === SCENARIO_SOURCE_TYPES.COMPANY)
          .flatMap((card) => card.presetAttachments ?? []),
        nextInstalled
          .filter((card) => card.sourceType === SCENARIO_SOURCE_TYPES.COMPANY)
          .flatMap((card) => card.presetAttachments ?? []),
      );

    if (changedInstalled || published.length > 0 || response.ok === true) {
      try {
        await store.mutate((draft) => {
          draft.scenarios = nextInstalled;
          draft.companyStandardScenarios = published;
          draft.deletedScenarioIds = [...new Set(deletedIds.filter((id) => isValidScenarioId(id)))];
          draft.lastSyncedAt = new Date().toISOString();
          for (const item of uninstalled) {
            for (const [sessionId, record] of Object.entries(draft.activations)) {
              if (record.scenarioId === item.scenarioId) delete draft.activations[sessionId];
            }
          }
          return { result: undefined };
        });
      } catch (error) {
        logger?.warn?.(`[${PLUGIN_ID}] 保存公司标准场景同步结果失败：${error?.message ?? error}`);
        return {
          ok: false,
          message: `同步结果无法写入存档：${error?.message ?? error}`,
          auth: currentAuth(),
          scenarios: published,
          deletedScenarioIds: deletedIds,
          upgraded,
          uninstalled,
        };
      }
    }

    if (upgraded.length > 0 || uninstalled.length > 0) notify('scenario.saved');
    if (upgraded.length > 0) {
      logger?.info?.(
        `[${PLUGIN_ID}] 自动升级 ${upgraded.length} 个标准场景：${upgraded
          .map((item) => `${item.title} ${item.fromVersion}→${item.toVersion}`)
          .join('；')}`,
      );
    }

    return {
      ok: true,
      auth: currentAuth(),
      scenarios: published,
      deletedScenarioIds: deletedIds,
      upgraded,
      uninstalled,
      fetchedAt: new Date().toISOString(),
    };
  }

  function syncCompanyScenarios() {
    if (syncInFlight !== null) return syncInFlight;
    syncInFlight = performSync().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  /* ── 标准场景写入（POST / PUT / 附件增删） ───────────────────── */

  async function uploadLocalAttachmentsToRemote(scenarioId, attachments) {
    const warnings = [];
    let finalScenario;
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const bytes = await readAttachmentBytes(attachment);
      if (bytes.ok !== true) {
        warnings.push({ attachmentId: attachment.attachmentId, fileName: attachment.fileName, message: bytes.error });
        continue;
      }
      const result = absorbAuth(
        await companyRegistry.uploadAttachment(scenarioId, {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          contentBase64: bytes.buffer.toString('base64'),
          sha256: bytes.sha256 || sha256Hex(bytes.buffer),
        }),
      );
      if (result.ok === false) {
        warnings.push({
          attachmentId: attachment.attachmentId,
          fileName: attachment.fileName,
          message: result.message,
          correlationId: result.correlationId,
        });
        continue;
      }
      if (result.scenario !== undefined) finalScenario = result.scenario;
    }
    return { scenario: finalScenario, warnings };
  }

  /** 新建公司标准场景：POST，随后逐个上传预设附件。 */
  async function createStandardScenario({ draft, existing }) {
    const result = normalizeScenario(
      {
        ...draft,
        sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
        readonlyForNormalUser: true,
        isStandardPublished: true,
      },
      {
        existing,
        skillNames: await skillNames(),
        maxCards: config.maxScenarioCards,
        previousId: undefined,
      },
    );
    if (result.ok !== true) return result;

    const card = result.card;
    if (card.author === '') card.author = await resolveCurrentUser();

    const created = absorbAuth(
      await companyRegistry.createScenario(toRemoteWritePayload(card, false)),
    );
    if (created.ok === false) {
      return {
        ok: false,
        message: `创建公司标准场景失败：${created.message}`,
        code: created.code,
        correlationId: created.correlationId,
        errors: [],
        warnings: result.warnings,
      };
    }

    let remoteScenario = created.scenario;
    if (remoteScenario === undefined) {
      return {
        ok: false,
        message: 'MCP 服务创建标准场景成功，但响应里缺少 scenario，无法同步本地版本号',
        warnings: result.warnings,
      };
    }

    const uploads = await uploadLocalAttachmentsToRemote(remoteScenario.scenarioId, card.presetAttachments);
    if (uploads.scenario !== undefined) remoteScenario = uploads.scenario;

    const baseRemote = fromRemoteScenario(remoteScenario, companyRegistry.apiBaseUrl, { local: card });
    if (baseRemote === undefined) {
      return { ok: false, message: 'MCP 服务返回的标准场景数据不合法，无法写入本地' };
    }
    const localized = await localizeRemoteAttachments(
      baseRemote.presetAttachments,
      [],
      card.presetAttachments,
    );
    const localCard = { ...baseRemote, presetAttachments: localized.attachments };

    await store.mutate((state) => {
      state.scenarios.push(localCard);
      const index = state.companyStandardScenarios.findIndex((item) => item.scenarioId === localCard.scenarioId);
      if (index >= 0) state.companyStandardScenarios[index] = { ...localCard };
      else state.companyStandardScenarios.push({ ...localCard });
      return { result: undefined };
    });
    await pruneAssets(card, localCard);
    notify('scenario.saved');
    logger?.info?.(`[${PLUGIN_ID}] 已创建公司标准场景 ${localCard.scenarioId}（v${localCard.version}）`);

    return {
      ok: true,
      card: localCard,
      warnings: [...(result.warnings ?? []), ...uploads.warnings.map((item) => ({ field: 'presetAttachments', ...item }))],
      publish: { ok: true, scenario: remoteScenario },
    };
  }

  /** 编辑公司标准场景：PUT 后对比附件，调用上传/删除接口；服务端自动升版。 */
  async function updateStandardScenario({ draft, previousId, previous, existing }) {
    const remoteId = text(previous?.scenarioId) || text(previousId) || text(draft?.scenarioId);
    if (!isValidScenarioId(remoteId)) {
      return { ok: false, message: `标准场景编码「${remoteId}」不合法` };
    }

    const draftForWrite = {
      ...draft,
      scenarioId: remoteId,
      sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
      readonlyForNormalUser: true,
      isStandardPublished: true,
    };
    // 编辑标准场景时，本地快捷指令可能与其他本地卡片冲突：自动让路，不阻断远端保存。
    const usedCommands = new Set(
      existing.filter((item) => item.scenarioId !== remoteId).map((item) => normalizeSlashCommand(item.slashCommand)),
    );
    if (usedCommands.has(normalizeSlashCommand(draftForWrite.slashCommand))) {
      const base = normalizeSlashCommand(draftForWrite.slashCommand).replace(/^\//, '');
      draftForWrite.slashCommand = `/${base}-std`.slice(0, 33);
    }
    if (usedCommands.has(normalizeSlashCommand(draftForWrite.slashCommand))) {
      const base = normalizeSlashCommand(draftForWrite.slashCommand).replace(/^\//, '').slice(0, 26);
      draftForWrite.slashCommand = `/${base}-${Date.now().toString(36).slice(-3)}`;
    }

    const result = normalizeScenario(draftForWrite, {
      existing,
      skillNames: await skillNames(),
      maxCards: config.maxScenarioCards,
      previousId: remoteId,
    });
    if (result.ok !== true) return result;

    const card = result.card;
    if (card.author === '') card.author = await resolveCurrentUser();

    const updated = absorbAuth(
      await companyRegistry.updateScenario(remoteId, toRemoteWritePayload(card, true)),
    );
    if (updated.ok === false) {
      return {
        ok: false,
        message: `更新公司标准场景失败：${updated.message}`,
        code: updated.code,
        correlationId: updated.correlationId,
        errors: [],
        warnings: result.warnings,
      };
    }

    const previousAttachments = previous?.presetAttachments ?? [];
    const nextAttachments = card.presetAttachments ?? [];
    const uploads = [];
    const removals = [];
    const replacements = [];
    const matchedPrevious = new Set();
    for (const item of nextAttachments) {
      const match = findAttachmentMatch(previousAttachments, item);
      if (match === undefined) {
        uploads.push(item);
        continue;
      }
      matchedPrevious.add(match);
      const itemSha = normalizeSha256(item.sha256);
      const matchSha = normalizeSha256(match.sha256);
      const contentChanged = itemSha !== '' && matchSha !== '' && itemSha !== matchSha;
      const identityChanged =
        text(item.fileName) !== text(match.fileName) ||
        (Number(item.fileSize) || 0) !== (Number(match.fileSize) || 0);
      if (contentChanged || identityChanged) {
        uploads.push(item);
        replacements.push({ uploaded: item, previous: match });
      }
    }
    for (const item of previousAttachments) {
      if (!matchedPrevious.has(item)) removals.push(item);
    }

    const attachmentWarnings = [];
    let remoteScenario = updated.scenario;

    if (uploads.length > 0) {
      const uploaded = await uploadLocalAttachmentsToRemote(remoteId, uploads);
      attachmentWarnings.push(...uploaded.warnings);
      if (uploaded.scenario !== undefined) remoteScenario = uploaded.scenario;
    }

    // 替换附件时，只有新文件上传成功后才删除旧附件，避免失败时两边都丢。
    const failedUploads = new Set(
      attachmentWarnings.map((item) => text(item.attachmentId)).filter((id) => id !== ''),
    );
    for (const replacement of replacements) {
      if (failedUploads.has(text(replacement.uploaded.attachmentId))) continue;
      removals.push(replacement.previous);
    }

    for (const attachment of removals) {
      const attachmentId = text(attachment.attachmentId);
      if (attachmentId === '') continue;
      const removed = absorbAuth(await companyRegistry.deleteAttachment(remoteId, attachmentId));
      if (removed.ok === false) {
        attachmentWarnings.push({
          fileName: attachment.fileName,
          message: removed.message,
          correlationId: removed.correlationId,
        });
        continue;
      }
      if (removed.scenario !== undefined) remoteScenario = removed.scenario;
    }

    if (remoteScenario === undefined) {
      return {
        ok: false,
        message: 'MCP 服务已更新标准场景，但响应里缺少 scenario，无法同步本地版本号',
        warnings: result.warnings,
      };
    }

    const baseRemote = fromRemoteScenario(remoteScenario, companyRegistry.apiBaseUrl, { local: previous ?? card });
    if (baseRemote === undefined) {
      return { ok: false, message: 'MCP 服务返回的标准场景数据不合法，无法写入本地' };
    }
    const localized = await localizeRemoteAttachments(
      baseRemote.presetAttachments,
      previousAttachments,
      nextAttachments,
    );
    const localCard = { ...baseRemote, presetAttachments: localized.attachments };

    const installed = store.findScenario(remoteId) !== undefined;
    await store.mutate((state) => {
      const index = state.scenarios.findIndex((item) => item.scenarioId === remoteId);
      if (index >= 0) state.scenarios[index] = localCard;
      else if (installed) state.scenarios.push(localCard);
      const companyIndex = state.companyStandardScenarios.findIndex((item) => item.scenarioId === remoteId);
      if (companyIndex >= 0) state.companyStandardScenarios[companyIndex] = { ...localCard };
      else state.companyStandardScenarios.push({ ...localCard });
      return { result: undefined };
    });
    await pruneAssets(previous, localCard);
    notify('scenario.saved');
    logger?.info?.(
      `[${PLUGIN_ID}] 已更新标准场景 ${remoteId} → v${localCard.version}（revision ${localCard.revision}）`,
    );

    return {
      ok: true,
      card: localCard,
      warnings: [
        ...(result.warnings ?? []),
        ...attachmentWarnings.map((item) => ({ field: 'presetAttachments', ...item })),
      ],
      publish: { ok: true, scenario: remoteScenario, version: localCard.version, revision: localCard.revision },
    };
  }

  /* ── 保存 / 删除 / 安装 / 复制 ───────────────────────────────── */

  async function saveLocalScenario({ draft, previousId, existing, forcedLocalReason }) {
    const previous = typeof previousId === 'string' && previousId !== '' ? findCard(previousId) : undefined;
    const result = normalizeScenario(
      {
        ...draft,
        sourceType: SCENARIO_SOURCE_TYPES.LOCAL,
        readonlyForNormalUser: false,
        isStandardPublished: false,
        originScenarioId: '',
      },
      {
        existing,
        skillNames: await skillNames(),
        maxCards: config.maxScenarioCards,
        previousId: typeof previousId === 'string' && previousId !== '' ? previousId : undefined,
      },
    );
    if (result.ok !== true) return result;

    const card = result.card;
    if (card.author === '') card.author = await resolveCurrentUser();
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
    await pruneAssets(previous, card).catch(() => undefined);
    logger?.info?.(`[${PLUGIN_ID}] 保存本地场景 ${card.scenarioId}（${previousId === undefined ? '新建' : '编辑'}）`);
    notify('scenario.saved');
    return {
      ok: true,
      card,
      warnings: result.warnings,
      ...(forcedLocalReason === undefined
        ? {}
        : { publish: { ok: false, message: forcedLocalReason } }),
    };
  }

  async function saveScenario({ draft, previousId } = {}) {
    const existing = store.scenarios();
    const previousLocal = typeof previousId === 'string' && previousId !== '' ? findCard(previousId) : undefined;
    const previousCompany = typeof previousId === 'string' && previousId !== '' ? findCompanyCard(previousId) : undefined;
    const previous = previousLocal ?? previousCompany;

    const draftSource = text(draft?.sourceType).toUpperCase();
    const editingStandard =
      typeof previousId === 'string' &&
      previousId !== '' &&
      (previous?.sourceType === SCENARIO_SOURCE_TYPES.COMPANY || draftSource === SCENARIO_SOURCE_TYPES.COMPANY);
    const wantsStandard =
      draftSource === SCENARIO_SOURCE_TYPES.COMPANY ||
      (draft?.isStandardPublished === true && previousLocal === undefined);

    if (editingStandard || wantsStandard) {
      const permission = await getPermission({});
      if (permission.auth.canManageStandardScenario !== true) {
        if (editingStandard) {
          return {
            ok: false,
            message: '当前账号没有管理公司标准场景的权限（auth.canManageStandardScenario=false）',
          };
        }
        return saveLocalScenario({
          draft,
          previousId,
          existing,
          forcedLocalReason: '当前账号没有管理公司标准场景的权限，已仅保存为本地场景',
        });
      }
    }

    if (editingStandard) {
      return updateStandardScenario({ draft, previousId, previous, existing });
    }
    if (wantsStandard) {
      return createStandardScenario({
        draft,
        existing: existing.filter((item) => item.scenarioId !== previousId),
      });
    }
    return saveLocalScenario({ draft, previousId, existing });
  }

  async function deleteScenario({ scenarioId } = {}) {
    const local = findCard(scenarioId);
    const company = findCompanyCard(scenarioId);
    const isStandard = local?.sourceType === SCENARIO_SOURCE_TYPES.COMPANY || company !== undefined;

    if (isStandard) {
      const permission = await getPermission({});
      if (permission.auth.canManageStandardScenario !== true) {
        return {
          ok: false,
          message: '当前账号没有管理公司标准场景的权限（auth.canManageStandardScenario=false）',
        };
      }
      const removed = absorbAuth(await companyRegistry.deleteScenario(scenarioId));
      if (removed.ok === false) {
        return {
          ok: false,
          message: `删除公司标准场景失败：${removed.message}`,
          code: removed.code,
          correlationId: removed.correlationId,
        };
      }

      await store.mutate((state) => {
        state.scenarios = state.scenarios.filter((item) => item.scenarioId !== scenarioId);
        state.companyStandardScenarios = state.companyStandardScenarios.filter(
          (item) => item.scenarioId !== scenarioId,
        );
        if (!state.deletedScenarioIds.includes(scenarioId)) state.deletedScenarioIds.push(scenarioId);
        for (const [sessionId, record] of Object.entries(state.activations)) {
          if (record.scenarioId === scenarioId) delete state.activations[sessionId];
        }
        return { result: undefined };
      });
      if (local !== undefined) await pruneCardAssets(local);
      notify('scenario.deleted');
      logger?.info?.(`[${PLUGIN_ID}] 已软删除公司标准场景 ${scenarioId}`);
      return {
        ok: true,
        remote: true,
        deleted: removed.deleted !== false,
        scenarioId,
        revision: removed.revision,
        deletedScenarioIds: removed.deletedScenarioIds ?? [],
      };
    }

    const existed = await store.mutate((state) => {
      const before = state.scenarios.length;
      state.scenarios = state.scenarios.filter((item) => item.scenarioId !== scenarioId);
      for (const [sessionId, record] of Object.entries(state.activations)) {
        if (record.scenarioId === scenarioId) delete state.activations[sessionId];
      }
      return { result: state.scenarios.length !== before };
    });
    if (existed) {
      notify('scenario.deleted');
      if (local !== undefined) await pruneCardAssets(local);
    }
    return existed ? { ok: true } : { ok: false, message: `场景 ${scenarioId} 不存在` };
  }

  async function installCompanyScenario({ scenarioId } = {}) {
    if (typeof scenarioId !== 'string' || scenarioId === '') {
      return { ok: false, message: '缺少场景标识' };
    }
    const synced = await syncCompanyScenarios();
    const existing = store.scenarios();
    const already = existing.find(
      (item) => item.scenarioId === scenarioId && item.sourceType === SCENARIO_SOURCE_TYPES.COMPANY,
    );
    if (already !== undefined) {
      return { ok: true, installed: false, card: already, message: `「${already.title}」已安装` };
    }

    const view = findCompanyCard(scenarioId) ?? (synced.scenarios ?? []).find((item) => item.scenarioId === scenarioId);
    if (view === undefined) {
      return {
        ok: false,
        message: synced.ok === false
          ? `公司标准场景同步失败：${synced.message}`
          : `公司标准库里没有场景 ${scenarioId}`,
      };
    }

    const localized = await localizeRemoteAttachments(view.presetAttachments ?? [], []);
    const draft = { ...view, presetAttachments: localized.attachments };
    const used = new Set(existing.map((item) => normalizeSlashCommand(item.slashCommand)));
    if (used.has(draft.slashCommand)) {
      const base = `${draft.slashCommand.replace(/^\//, '')}-std`.slice(0, 32);
      draft.slashCommand = `/${base}`;
    }
    if (used.has(draft.slashCommand)) {
      draft.slashCommand = `${draft.slashCommand}-${Date.now().toString(36).slice(-3)}`.slice(0, 33);
    }

    const result = normalizeScenario(draft, {
      existing,
      skillNames: await skillNames(),
      maxCards: config.maxScenarioCards,
    });
    if (result.ok !== true) {
      return { ok: false, message: '公司标准场景无法安装', errors: result.errors, warnings: result.warnings };
    }

    const card = result.card;
    await store.mutate((state) => {
      state.scenarios.push(card);
      return { result: undefined };
    });
    notify('scenario.saved');
    logger?.info?.(`[${PLUGIN_ID}] 已安装公司标准场景 ${scenarioId}（v${card.version}）`);
    return {
      ok: true,
      installed: true,
      card,
      warnings: result.warnings,
      attachments: { saved: localized.attachments.length, failed: localized.failed },
    };
  }

  /**
   * 复制标准场景为本地场景：深拷贝配置与预设附件，生成新 ID，可自由编辑。
   */
  async function forkStandardToLocalScenario({ scenarioId } = {}) {
    if (typeof scenarioId !== 'string' || scenarioId === '') {
      return { ok: false, message: '缺少场景标识' };
    }
    const source = findCard(scenarioId) ?? findCompanyCard(scenarioId);
    if (source === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };

    const existing = store.scenarios();
    const suffix = Date.now().toString(36);
    const base = `${scenarioId}-copy-${suffix}`;
    let newId = base.slice(0, 64);
    if (!isValidScenarioId(newId)) {
      newId = `crm-copy-${suffix}`.slice(0, 64);
    }
    for (let index = 2; existing.some((item) => item.scenarioId === newId); index += 1) {
      newId = `${base.slice(0, 58)}-${index}`;
    }

    const attachments = [];
    for (const item of source.presetAttachments ?? []) {
      const copyId = assetStore?.makeId?.(item.fileName) ?? `att_fork_${attachments.length + 1}`;
      const bytes = await readAttachmentBytes(item);
      if (bytes.ok === true && assetStore !== undefined) {
        try {
          const stored = await assetStore.save({
            attachmentId: copyId,
            fileName: item.fileName,
            mimeType: item.mimeType,
            dataBase64: bytes.buffer.toString('base64'),
          });
          attachments.push(stored);
          continue;
        } catch (error) {
          logger?.warn?.(`[${PLUGIN_ID}] 复制预设附件失败：${error?.message ?? error}`);
        }
      }
      attachments.push({ ...item, attachmentId: copyId });
    }

    const usedCommands = new Set(existing.map((item) => normalizeSlashCommand(item.slashCommand)));
    let slashCommand = `${source.slashCommand.replace(/^\//, '')}-local`;
    if (usedCommands.has(`/${slashCommand}`)) slashCommand = `${slashCommand}-${suffix.slice(-3)}`;
    const draft = {
      ...source,
      scenarioId: newId,
      title: `${source.title} (本地副本)`.slice(0, LIMITS.title),
      slashCommand: `/${slashCommand}`.slice(0, 33),
      sourceType: SCENARIO_SOURCE_TYPES.LOCAL,
      readonlyForNormalUser: false,
      isStandardPublished: false,
      originScenarioId: '',
      presetAttachments: attachments,
      author: source.author || (await resolveCurrentUser()),
    };

    const result = normalizeScenario(draft, {
      existing,
      skillNames: await skillNames(),
      maxCards: config.maxScenarioCards,
    });
    if (result.ok !== true) {
      for (const item of attachments) {
        if (isLocalRelativePath(item.localPathOrUrl)) await assetStore?.remove?.(item.localPathOrUrl);
      }
      return { ok: false, message: '复制标准场景失败', errors: result.errors, warnings: result.warnings };
    }

    const card = result.card;
    await store.mutate((state) => {
      state.scenarios.push(card);
      return { result: undefined };
    });
    notify('scenario.saved');
    logger?.info?.(`[${PLUGIN_ID}] 已把标准场景 ${scenarioId} 复制为本地场景 ${card.scenarioId}`);
    return { ok: true, card, sourceScenarioId: scenarioId, warnings: result.warnings };
  }

  async function publishScenario({ scenarioId } = {}) {
    const card = findCard(scenarioId);
    if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
    if (card.sourceType === SCENARIO_SOURCE_TYPES.COMPANY) {
      return { ok: true, message: '该场景已经是公司标准场景', card };
    }
    return createStandardScenario({
      draft: {
        ...card,
        sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
        isStandardPublished: true,
        readonlyForNormalUser: true,
      },
      existing: store.scenarios().filter((item) => item.scenarioId !== scenarioId),
    });
  }

  /* ── 对外接口 ───────────────────────────────────────────────── */

  /** 导出场景包（配置 + 内联附件），可来自「已安装」或「公司推出的场景」。 */
  async function exportScenario({ scenarioId, source = 'local' } = {}) {
    const card = source === 'company' ? findCompanyCard(scenarioId) : findCard(scenarioId);
    if (card === undefined) {
      return {
        ok: false,
        message: source === 'company'
          ? `公司标准库里没有场景 ${scenarioId}`
          : `场景 ${scenarioId} 不存在`,
      };
    }
    return {
      ok: true,
      fileName: packageFileName(card.scenarioId),
      package: await buildPackage(card),
    };
  }

  return {
    /* ── 启动引导数据 ─────────────────────────────────────────── */
    async bootstrap({ sessions = [] } = {}) {
      const installed = store.scenarios().map(cardView);
      const company = (store.companyScenarios?.() ?? [])
        .filter((card) => card.status === 'PUBLISHED')
        .map(cardView);
      const activations = sessions
        .map((sessionId) => store.activation(sessionId))
        .filter((record) => record !== undefined);
      const auth = currentAuth();
      return {
        ok: true,
        plugin: {
          id: PLUGIN_ID,
          version: PLUGIN_VERSION,
          dataDir: store.dir,
          stateVersion: STATE_VERSION,
          degraded: store.degraded,
          warnings: store.loadWarnings,
          currentUser: auth.crmUsername || (await resolveCurrentUser()),
        },
        auth,
        permission: auth,
        config: {
          apiBaseUrl: companyRegistry.apiBaseUrl,
          authMode: config.authMode ?? 'buntu',
          injectSkillsOnStep: config.injectSkillsOnStep === true,
          injectSkillBodies: config.injectSkillBodies === true,
          injectSkillDescriptions: config.injectSkillDescriptions === true,
          registerSlashCommands: config.registerSlashCommands === true,
          showSidebarEntry: config.showSidebarEntry !== false,
          maxScenarioCards: config.maxScenarioCards,
          skillCatalogDir: config.skillCatalogDir ?? '',
          canManageStandardScenario: auth.canManageStandardScenario === true,
        },
        limits: LIMITS,
        taxonomy: {
          actions: ACTIONS,
          formContextEntries: FORM_CONTEXT_ENTRIES,
          categories: SCENARIO_CATEGORIES,
          icons: ICON_CATALOG,
          defaultIcon: DEFAULT_ICON,
          sourceTypes: [SCENARIO_SOURCE_TYPES.LOCAL, SCENARIO_SOURCE_TYPES.COMPANY],
          presetAttachmentExtensions: [...PRESET_ATTACHMENT_EXTENSIONS],
          presetAttachmentRole: PRESET_ATTACHMENT_ROLE,
        },
        scenarios: installed,
        installedScenarios: installed,
        companyStandardScenarios: company,
        deletedScenarioIds: store.deletedScenarioIds?.() ?? [],
        lastSyncedAt: store.lastSyncedAt?.() ?? '',
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
          : rows.filter((row) => `${row.name} ${row.description ?? ''}`.toLowerCase().includes(needle));
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
    deleteScenario,
    getPermission,

    /* ── 公司标准场景 ─────────────────────────────────────────── */
    syncCompanyScenarios,

    /** 需求命名：同步后核对并静默升级/卸载本地已安装的标准场景。 */
    async reconcileInstalledStandardScenarios() {
      return syncCompanyScenarios();
    },

    async listCompanyScenarios({ refresh = false } = {}) {
      // 手动刷新必须真的再发一次 GET：若已有同步在途，先等它结束再启动新一轮。
      if (refresh === true && syncInFlight !== null) {
        await syncInFlight.catch(() => undefined);
      }
      const synced = await syncCompanyScenarios();
      return {
        ...synced,
        ok: synced.ok !== false,
        configured: companyRegistry.configured?.() !== false,
        endpoint: companyRegistry.apiBaseUrl,
        apiBaseUrl: companyRegistry.apiBaseUrl,
        auth: currentAuth(),
        scenarios: (store.companyScenarios?.() ?? []).filter((card) => card.status === 'PUBLISHED'),
        installedOrigins: store
          .scenarios()
          .filter((card) => card.sourceType === SCENARIO_SOURCE_TYPES.COMPANY)
          .map((card) => card.scenarioId),
        deletedScenarioIds: store.deletedScenarioIds?.() ?? [],
        lastSyncedAt: store.lastSyncedAt?.() ?? '',
      };
    },

    installCompanyScenario,
    forkStandardToLocalScenario,
    publishScenario,

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
      return store.mutate((state) => {
        const outcome = moveScenario(state.scenarios, scenarioId, direction);
        if (outcome.ok !== true) return { result: outcome, changed: false };
        state.scenarios = outcome.items;
        return { result: { ok: true } };
      });
    },

    async duplicateScenario({ scenarioId } = {}) {
      const source = findCard(scenarioId);
      if (source === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
      const existing = store.scenarios();
      const draft = duplicateScenario(
        source,
        existing.map((item) => item.scenarioId),
      );
      const usedCommands = new Set(existing.map((item) => normalizeSlashCommand(item.slashCommand)));
      if (usedCommands.has(draft.slashCommand)) {
        draft.slashCommand = `${draft.slashCommand}-${Date.now().toString(36).slice(-3)}`;
      }
      return saveLocalScenario({ draft, previousId: undefined, existing });
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
      if (card === undefined) return { ok: true, activation: record };
      // 客户端据此把「开场引导语 + 预设附件」一次性带进新会话输入框。
      const draft = {
        text: card.inputDraft !== '' ? card.inputDraft : card.welcomeMessage,
        source: card.inputDraft !== '' ? 'inputDraft' : 'welcomeMessage',
        attachments: (card.presetAttachments ?? []).map(publicAttachment),
      };
      return { ok: true, activation: record, scenario: cardView(card), draft };
    },

    clearActivation,

    /* ── 场景预设附件 ─────────────────────────────────────────── */

    /** 管理员在抽屉里上传预设附件：落盘到数据目录，返回可写进卡片的元数据。 */
    async saveAttachment({ fileName, mimeType, dataBase64 } = {}) {
      if (assetStore === undefined) return { ok: false, message: '当前运行环境未启用附件存储' };
      try {
        const stored = await assetStore.save({ fileName, mimeType, dataBase64 });
        return { ok: true, attachment: { ...stored, url: attachmentUrl(stored) } };
      } catch (error) {
        return { ok: false, message: error?.message ?? String(error) };
      }
    },

    /** 导出场景包：兼容旧调用名。 */
    exportScenario,

    async exportScenarioBundle(options = {}) {
      return exportScenario(options);
    },

    /** 导入离线场景包：附件一并还原到本地资产目录。 */
    async importScenario({ package: bundle } = {}) {
      if (bundle === null || typeof bundle !== 'object') {
        return { ok: false, message: '场景包不是合法的 JSON 对象' };
      }
      if (bundle.format !== PACKAGE_FORMAT) {
        return { ok: false, message: '不是本插件导出的场景包（format 不匹配）' };
      }
      const raw = bundle.scenario;
      if (raw === null || typeof raw !== 'object') return { ok: false, message: '场景包缺少 scenario 字段' };

      const incoming = Array.isArray(bundle.attachments) ? bundle.attachments : (raw.presetAttachments ?? []);
      const kept = [];
      for (const item of incoming) {
        if (typeof item?.dataBase64 === 'string' && assetStore !== undefined) {
          try {
            const stored = await assetStore.save({
              attachmentId: item.attachmentId,
              fileName: item.fileName,
              mimeType: item.mimeType,
              dataBase64: item.dataBase64,
            });
            kept.push(stored);
            continue;
          } catch (error) {
            logger?.warn?.(`[${PLUGIN_ID}] 导入附件失败：${error?.message ?? error}`);
          }
        }
        kept.push(item);
      }

      const existing = store.scenarios();
      const used = new Set(existing.map((item) => normalizeSlashCommand(item.slashCommand)));
      const draft = {
        ...raw,
        presetAttachments: kept,
        sourceType: SCENARIO_SOURCE_TYPES.LOCAL,
        readonlyForNormalUser: false,
        isStandardPublished: false,
        originScenarioId: '',
      };
      delete draft.scenarioId;
      if (used.has(normalizeSlashCommand(draft.slashCommand))) {
        draft.slashCommand = `${normalizeSlashCommand(draft.slashCommand)}-${Date.now().toString(36).slice(-3)}`;
      }
      const saved = await saveLocalScenario({ draft, previousId: undefined, existing });
      return saved.ok === true ? { ...saved, imported: true } : saved;
    },

    /** 管理员预览：确认「点下卡片后模型到底会看到什么」。 */
    async previewInjection({ scenarioId, mode = 'full', cwd = '' } = {}) {
      const card = findCard(scenarioId) ?? findCompanyCard(scenarioId);
      if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在` };
      const withBodies = config.injectSkillBodies === true;
      const stack = await resolveStack(
        card.pinnedSkills,
        undefined,
        typeof cwd === 'string' && cwd !== '' ? { cwd } : undefined,
        { withContent: withBodies },
      );
      const effectiveMode = withBodies ? (mode === 'reminder' ? 'reminder' : 'full') : 'names';
      const textBlock = buildContextBlock({
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
        text: textBlock,
        characters: [...textBlock].length,
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

export { deriveSlashCommandFromScenarioId };
