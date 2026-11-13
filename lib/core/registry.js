/**
 * MCP 控制平面（`/api/dsh/**`）客户端 + 远端/本地场景的双向映射。
 *
 * 这里只做三件事：
 *   1. 解析基础地址（`config.apiBaseUrl` → 默认值，去末尾斜杠）；
 *   2. 按契约调用 8 个标准场景接口（带身份头、超时、correlationId 提取）；
 *   3. 在远端「主字段 + scenarioPayload」与本地扁平场景结构之间转换。
 *
 * 红线：`POST/PUT` 的服务端请求体绝不能出现 version / revision / createdAt /
 * updatedAt / presetAttachments（顶层与 scenarioPayload 内都不行），否则服务端
 * zod 会直接返回 400 DSH_SCENARIO_INPUT_INVALID。所有写请求统一经过
 * `toRemoteWritePayload`，禁止在别处手拼请求体。
 */

import { createHash } from 'node:crypto';

import {
  DEFAULT_ICON,
  DEFAULT_MCP_API_BASE_URL,
  LIMITS,
  MCP_API_PREFIX,
  PLUGIN_ID,
  PRESET_ATTACHMENT_ROLE,
  SCENARIO_SOURCE_TYPES,
  isValidScenarioId,
} from './constants.js';
import {
  isAllowedPresetFile,
  mimeForFileName,
  normalizeVersion,
} from './schema.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DOWNLOAD_BYTES = LIMITS.fileSize;

/** 服务端严格禁止出现在 POST/PUT 请求体里的字段（顶层与 scenarioPayload 内）。 */
export const FORBIDDEN_WRITE_FIELDS = Object.freeze([
  'version',
  'revision',
  'createdAt',
  'updatedAt',
  'presetAttachments',
]);

const ACTIONS = Object.freeze(['CREATE', 'UPDATE', 'AUTO']);
const FORM_CONTEXT_ENTRIES = Object.freeze(['STANDARD', 'QUICK_ACTION']);
const STATUS_VALUES = Object.freeze(['PUBLISHED', 'DRAFT', 'ARCHIVED']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, max) {
  const raw = String(value ?? '');
  return [...raw].length <= max ? raw : [...raw].slice(0, max).join('');
}

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const item = text(value);
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function normalizeSha256(value) {
  const raw = text(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : '';
}

/** 单一优先级：显式 apiBaseUrl → 内置默认值，并去掉末尾斜杠。 */
export function resolveApiBaseUrl(value) {
  const raw = text(value);
  const base = raw === '' ? DEFAULT_MCP_API_BASE_URL : raw;
  return base.replace(/\/+$/, '');
}

/** 远端 `downloadUrl` 可能是相对路径，必须基于 apiBaseUrl 拼成完整地址。 */
export function resolveAttachmentUrl(downloadUrl, apiBaseUrl = DEFAULT_MCP_API_BASE_URL) {
  const raw = text(downloadUrl);
  if (raw === '') return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, resolveApiBaseUrl(apiBaseUrl)).toString();
  } catch {
    return '';
  }
}

/** 公司标准场景的本地快捷指令：由 scenarioId 推导，保证能被本地 schema 接受。 */
export function deriveSlashCommandFromScenarioId(scenarioId) {
  const slug = text(scenarioId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const safe = slug === '' ? 'scene' : /^[a-z]/.test(slug) ? slug : `s-${slug}`.slice(0, 32);
  return `/${safe}`;
}

function sanitizeAttachmentId(raw, index) {
  const candidate = text(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 64);
  if (/^[a-z][a-z0-9_-]{5,63}$/.test(candidate)) return candidate;
  const fragment = candidate.replace(/^[^a-z]+/, '').slice(0, 40) || 'remote';
  return `att_${fragment}_${index + 1}`.slice(0, 64);
}

function normalizeAuth(raw) {
  const source = asObject(raw);
  return {
    authenticated: source.authenticated === true,
    platformUserId: text(source.platformUserId) || null,
    crmUsername: text(source.crmUsername) || null,
    canManageStandardScenario: source.canManageStandardScenario === true,
  };
}

export { normalizeAuth };

function normalizePrePinnedContext(raw) {
  const source = asObject(raw);
  const action = text(source.defaultAction).toUpperCase();
  const entry = text(source.formContextEntry).toUpperCase();
  const result = {
    defaultAction: ACTIONS.includes(action) ? action : 'AUTO',
    formContextEntry: FORM_CONTEXT_ENTRIES.includes(entry) ? entry : 'STANDARD',
    allowAttachments: source.allowAttachments === true,
  };
  const objectApiName = text(source.defaultObjectApiName);
  if (objectApiName !== '') result.defaultObjectApiName = objectApiName;
  return result;
}

/**
 * 远端附件 → 本地附件的公共视图。
 * `localPathOrUrl` 一律使用 `new URL(downloadUrl, apiBaseUrl)` 的完整地址，
 * 后续由 Host 在安装/升级时下载并缓存到资产目录。
 */
export function fromRemoteAttachment(raw, index, apiBaseUrl, scenarioId) {
  const source = asObject(raw);
  const fileName = text(source.fileName ?? source.name);
  if (fileName === '' || fileName.includes('/') || fileName.includes('\\')) return undefined;
  if (!isAllowedPresetFile(fileName)) return undefined;

  const downloadUrl = text(source.downloadUrl ?? source.url);
  const resolved = resolveAttachmentUrl(downloadUrl, apiBaseUrl);
  if (resolved === '') return undefined;

  const attachmentId = sanitizeAttachmentId(source.attachmentId ?? source.id, index);
  const sizeRaw = Number(source.fileSize ?? source.size);
  const fileSize = Number.isFinite(sizeRaw) && sizeRaw >= 0 ? Math.trunc(sizeRaw) : 0;

  return {
    attachmentId,
    fileName,
    mimeType: text(source.mimeType) || mimeForFileName(fileName),
    localPathOrUrl: resolved,
    fileSize,
    sha256: normalizeSha256(source.sha256 ?? source.contentSha256 ?? source.checksum),
    downloadUrl: downloadUrl === '' ? resolved : downloadUrl,
    // 场景预设附件的固定角色：注入块据此声明「不得归档到 CRM 单据」。
    role: PRESET_ATTACHMENT_ROLE,
    scenarioId: text(source.scenarioId) || scenarioId,
  };
}

/**
 * 远端场景 → 本地扁平场景。
 *
 * @param {object} remote 服务端返回的场景对象
 * @param {string} apiBaseUrl MCP 服务基础地址
 * @param {{local?: object}} [options.local] 本地已安装卡片（保留 slashCommand/enabled/排序）
 */
export function fromRemoteScenario(remote, apiBaseUrl = DEFAULT_MCP_API_BASE_URL, options = {}) {
  const source = asObject(remote);
  const scenarioId = text(source.scenarioId);
  if (!isValidScenarioId(scenarioId)) return undefined;

  const payload = asObject(source.scenarioPayload);
  const local = asObject(options.local);
  /** 规范结构是 `scenarioPayload.*`；同时容忍旧服务端把字段平铺在顶层。 */
  const pick = (key) => (payload[key] !== undefined ? payload[key] : source[key]);
  const title = truncateText(text(source.title) || scenarioId, LIMITS.title);
  const description = truncateText(
    text(source.description) || `${title}（公司标准场景）`,
    LIMITS.description,
  );
  const category = truncateText(text(source.category) || '核心单据管控', LIMITS.category);
  const version = normalizeVersion(source.version) || '1.0.0';
  const revisionRaw = Number(source.revision);
  const revision = Number.isFinite(revisionRaw) && revisionRaw >= 0 ? Math.trunc(revisionRaw) : 0;
  const statusRaw = text(source.status).toUpperCase();
  const status = STATUS_VALUES.includes(statusRaw) ? statusRaw : 'PUBLISHED';

  const pinnedSkillsRaw = pick('pinnedSkills');
  const pinnedSkills = Array.isArray(pinnedSkillsRaw)
    ? uniqueStrings(
        pinnedSkillsRaw
          .filter((item) => typeof item === 'string')
          .filter((item) => [...item.trim()].length <= LIMITS.skillName),
      ).slice(0, LIMITS.pinnedSkills)
    : [];

  const remoteAttachments = Array.isArray(source.presetAttachments) ? source.presetAttachments : [];
  const presetAttachments = [];
  for (const [index, item] of remoteAttachments.entries()) {
    if (presetAttachments.length >= LIMITS.presetAttachments) break;
    const attachment = fromRemoteAttachment(item, index, apiBaseUrl, scenarioId);
    if (attachment !== undefined) presetAttachments.push(attachment);
  }

  const localSlash = text(local.slashCommand);
  const slashCommand =
    /^\/[a-z][a-z0-9-]{0,31}$/.test(localSlash)
      ? localSlash
      : deriveSlashCommandFromScenarioId(scenarioId);

  return {
    scenarioId,
    title,
    description,
    icon: text(pick('icon')) || text(local.icon) || DEFAULT_ICON,
    category,
    slashCommand,
    enabled: local.enabled !== false,
    isSystemBase: local.isSystemBase === true,
    pinnedSkills,
    prePinnedContext: normalizePrePinnedContext(pick('prePinnedContext')),
    welcomeMessage: truncateText(
      text(pick('welcomeMessage')) ||
        text(local.welcomeMessage) ||
        `已进入「${title}」公司标准场景。`,
      LIMITS.welcomeMessage,
    ),
    inputDraft: truncateText(text(pick('inputDraft')) || text(local.inputDraft), LIMITS.inputDraft),
    presetAttachments,
    sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
    readonlyForNormalUser: true,
    isStandardPublished: true,
    status,
    version,
    revision,
    author: truncateText(
      text(source.createdByCrmUser) ||
        text(source.createdByPlatformUid) ||
        text(local.author),
      LIMITS.author,
    ),
    originScenarioId: scenarioId,
    createdByPlatformUid: text(source.createdByPlatformUid),
    createdByCrmUser: text(source.createdByCrmUser),
    updatedAt: text(source.updatedAt),
  };
}

/**
 * 本地场景 → POST/PUT 请求体。
 *
 * @param {object} localScenario 本地场景
 * @param {boolean} [isPartialUpdate] true 表示 PUT（顶层不带 scenarioId）
 */
export function toRemoteWritePayload(localScenario, isPartialUpdate = false) {
  const source = asObject(localScenario);
  const nested = asObject(source.scenarioPayload);

  /** 优先取来源：扁平卡片的字段优先，其次兼容已经是远端结构的输入。 */
  const pick = (key) => (source[key] !== undefined ? source[key] : nested[key]);

  const scenarioPayload = {
    pinnedSkills: Array.isArray(pick('pinnedSkills')) ? [...pick('pinnedSkills')] : [],
    welcomeMessage: typeof pick('welcomeMessage') === 'string' ? pick('welcomeMessage') : '',
    inputDraft: typeof pick('inputDraft') === 'string' ? pick('inputDraft') : '',
    prePinnedContext: normalizePrePinnedContext(pick('prePinnedContext')),
    sourceType: SCENARIO_SOURCE_TYPES.COMPANY,
    readonlyForNormalUser: true,
  };

  const payload = {};
  if (isPartialUpdate !== true) {
    payload.scenarioId = text(source.scenarioId ?? nested.scenarioId);
  }
  payload.title = typeof pick('title') === 'string' ? pick('title') : '';
  payload.category = typeof pick('category') === 'string' ? pick('category') : '';
  payload.description = typeof pick('description') === 'string' ? pick('description') : '';
  const status = text(pick('status')).toUpperCase();
  payload.status = STATUS_VALUES.includes(status) ? status : 'PUBLISHED';
  payload.scenarioPayload = scenarioPayload;

  // 红线兜底：不论调用方传了什么，一律剔除服务端禁止字段。
  for (const key of FORBIDDEN_WRITE_FIELDS) {
    delete payload[key];
    delete scenarioPayload[key];
  }
  delete payload.scenarioPayload.version;
  delete payload.scenarioPayload.revision;

  return payload;
}

/* ── HTTP 客户端 ───────────────────────────────────────────────── */

function failResult({ status, message, code, correlationId, body } = {}) {
  return {
    ok: false,
    status: status ?? 0,
    message: String(message ?? '请求失败'),
    code: code ?? undefined,
    correlationId: correlationId ?? undefined,
    body,
  };
}

function extractFailure(payload, status, headers) {
  const body = asObject(payload);
  const error = asObject(body.error);
  const message =
    text(body.message) ||
    text(error.message) ||
    (typeof body.error === 'string' ? text(body.error) : '') ||
    `MCP 服务返回 HTTP ${status}`;
  const code = text(body.code) || text(error.code);
  const correlationId =
    text(body.correlationId) ||
    text(body.requestId) ||
    text(error.correlationId) ||
    text(headers?.get?.('x-correlation-id')) ||
    text(headers?.get?.('x-request-id'));
  return failResult({ status, message, code, correlationId, body });
}

/**
 * @param {object} [options]
 * @param {string} [options.apiBaseUrl]
 * @param {'buntu'|'internal_bearer'} [options.authMode]
 * @param {string} [options.mcpClientToken]
 * @param {string} [options.platformUserId]
 * @param {() => string | Promise<string>} [options.getToken] 用户 Buntu Token 解析器
 */
export function createRegistry({
  apiBaseUrl = DEFAULT_MCP_API_BASE_URL,
  fetchImpl,
  timeoutMs,
  logger,
  getToken,
  authMode = 'buntu',
  mcpClientToken = '',
  platformUserId = '',
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const baseUrl = resolveApiBaseUrl(apiBaseUrl);
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;

  let lastAuth = normalizeAuth(undefined);

  const configured = () => /^https?:\/\//i.test(baseUrl);

  async function resolveUserToken() {
    try {
      const value = typeof getToken === 'function' ? await getToken() : '';
      return text(value);
    } catch (error) {
      logger?.warn?.(`[${PLUGIN_ID}] 读取 Buntu Token 失败：${error?.message ?? error}`);
      return '';
    }
  }

  async function buildHeaders(extra = {}) {
    const headers = { accept: 'application/json', ...extra };
    const internalToken = text(mcpClientToken);
    const platformUser = text(platformUserId);
    if (authMode === 'internal_bearer' && internalToken !== '' && platformUser !== '') {
      headers.authorization = `Bearer ${internalToken}`;
      headers['x-sfoa-platform-user'] = platformUser;
      return headers;
    }
    const token = await resolveUserToken();
    if (token !== '') {
      headers.authorization = `Bearer ${token}`;
      headers['x-buntu-token'] = token;
    }
    return headers;
  }

  async function request(pathOrUrl, { method = 'GET', body, json = true, extraHeaders = {} } = {}) {
    if (typeof doFetch !== 'function') {
      return failResult({ message: '当前运行时没有可用的 fetch' });
    }
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const headers = await buildHeaders(
      json && body !== undefined ? { ...extraHeaders, 'content-type': 'application/json' } : extraHeaders,
    );
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined;

    let response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const message =
        error?.name === 'TimeoutError'
          ? `请求 MCP 服务超时（>${timeout}ms）`
          : `请求 MCP 服务失败：${error?.message ?? String(error)}`;
      logger?.warn?.(`[${PLUGIN_ID}] ${message}`);
      return failResult({ message });
    }

    let payload;
    if (json) {
      const raw = await response.text().catch(() => '');
      if (raw !== '') {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { message: raw.slice(0, 300) };
        }
      } else {
        payload = {};
      }
    }

    if (response.ok !== true) {
      const failure = extractFailure(payload, response.status, response.headers);
      logger?.warn?.(
        `[${PLUGIN_ID}] ${method} ${url} → HTTP ${response.status}${failure.code ? ` ${failure.code}` : ''}${failure.correlationId ? `（correlationId: ${failure.correlationId}）` : ''}：${failure.message}`,
      );
      return failure;
    }

    const bodyObject = asObject(payload);
    if (bodyObject.auth !== undefined) lastAuth = normalizeAuth(bodyObject.auth);

    return {
      ok: true,
      status: response.status,
      body: json ? bodyObject : undefined,
      response: json ? undefined : response,
      headers: response.headers,
      correlationId:
        text(bodyObject.correlationId) || text(bodyObject.requestId) || text(response.headers?.get?.('x-correlation-id')),
    };
  }

  async function requestJson(path, init) {
    return request(path, { ...init, json: true });
  }

  return {
    apiBaseUrl: baseUrl,
    /** 兼容旧代码的字段名。 */
    endpoint: baseUrl,
    configured,
    getAuth: () => ({ ...lastAuth }),
    resolveAttachmentUrl: (url) => resolveAttachmentUrl(url, baseUrl),

    /** GET /api/dsh/scenarios?includeDeleted=true */
    async listScenarios({ includeDeleted = true } = {}) {
      const query = includeDeleted === true ? '?includeDeleted=true' : '';
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios${query}`, { method: 'GET' });
      if (result.ok !== true) {
        return { ...result, scenarios: [], deletedScenarioIds: [], auth: { ...lastAuth } };
      }
      const body = result.body ?? {};
      lastAuth = normalizeAuth(body.auth);
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        scenarios: Array.isArray(body.scenarios) ? body.scenarios : [],
        deletedScenarioIds: Array.isArray(body.deletedScenarioIds)
          ? uniqueStrings(body.deletedScenarioIds)
          : [],
        correlationId: result.correlationId,
      };
    },

    /** GET /api/dsh/scenarios/permission */
    async getPermission() {
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios/permission`, { method: 'GET' });
      if (result.ok !== true) {
        return { ...result, auth: { ...lastAuth } };
      }
      lastAuth = normalizeAuth(result.body?.auth ?? result.body);
      return { ok: true, status: result.status, auth: { ...lastAuth }, correlationId: result.correlationId };
    },

    /** POST /api/dsh/scenarios */
    async createScenario(payload) {
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios`, { method: 'POST', body: payload });
      if (result.ok !== true) return { ...result, auth: { ...lastAuth } };
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        scenario: result.body?.scenario,
        correlationId: result.correlationId,
      };
    },

    /** PUT /api/dsh/scenarios/{scenarioId} */
    async updateScenario(scenarioId, payload) {
      const id = encodeURIComponent(text(scenarioId));
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios/${id}`, { method: 'PUT', body: payload });
      if (result.ok !== true) return { ...result, auth: { ...lastAuth } };
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        scenario: result.body?.scenario,
        revision: result.body?.revision,
        correlationId: result.correlationId,
      };
    },

    /** DELETE /api/dsh/scenarios/{scenarioId}（服务端软删除） */
    async deleteScenario(scenarioId) {
      const id = encodeURIComponent(text(scenarioId));
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios/${id}`, { method: 'DELETE' });
      if (result.ok !== true) return { ...result, auth: { ...lastAuth } };
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        deleted: result.body?.deleted === true,
        scenarioId: text(result.body?.scenarioId) || text(scenarioId),
        revision: result.body?.revision,
        deletedScenarioIds: Array.isArray(result.body?.deletedScenarioIds)
          ? result.body.deletedScenarioIds
          : [],
        correlationId: result.correlationId,
      };
    },

    /** POST /api/dsh/scenarios/{scenarioId}/attachments（JSON Base64） */
    async uploadAttachment(scenarioId, { fileName, mimeType, contentBase64, sha256 } = {}) {
      const id = encodeURIComponent(text(scenarioId));
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios/${id}/attachments`, {
        method: 'POST',
        body: { fileName, mimeType, contentBase64, sha256 },
      });
      if (result.ok !== true) return { ...result, auth: { ...lastAuth } };
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        scenario: result.body?.scenario,
        attachment: result.body?.attachment,
        correlationId: result.correlationId,
      };
    },

    /** DELETE /api/dsh/scenarios/{scenarioId}/attachments/{attachmentId} */
    async deleteAttachment(scenarioId, attachmentId) {
      const id = encodeURIComponent(text(scenarioId));
      const attId = encodeURIComponent(text(attachmentId));
      const result = await requestJson(`${MCP_API_PREFIX}/scenarios/${id}/attachments/${attId}`, {
        method: 'DELETE',
      });
      if (result.ok !== true) return { ...result, auth: { ...lastAuth } };
      return {
        ok: true,
        status: result.status,
        auth: { ...lastAuth },
        scenario: result.body?.scenario,
        correlationId: result.correlationId,
      };
    },

    /** GET /api/dsh/scenarios/{scenarioId}/attachments/{attachmentId}（二进制流） */
    async downloadAttachment(downloadUrl) {
      const url = resolveAttachmentUrl(downloadUrl, baseUrl);
      if (url === '') return { ok: false, error: '附件地址不合法' };

      const result = await request(url, { method: 'GET', json: false, extraHeaders: { accept: '*/*' } });
      if (result.ok !== true) {
        return { ok: false, error: result.message, status: result.status, correlationId: result.correlationId };
      }

      const response = result.response;
      const declared = Number(response.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        return { ok: false, error: '附件超过单附件上限（10 MiB）' };
      }
      let buffer;
      try {
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        return { ok: false, error: `读取附件内容失败：${error?.message ?? error}` };
      }
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        return { ok: false, error: '附件超过单附件上限（10 MiB）' };
      }

      const headerSha = normalizeSha256(response.headers?.get?.('x-sfoa-content-sha256'));
      const computedSha = sha256Hex(buffer);
      if (headerSha !== '' && headerSha !== computedSha) {
        logger?.warn?.(
          `[${PLUGIN_ID}] 附件下载 sha256 与响应头不一致：header=${headerSha.slice(0, 12)}… actual=${computedSha.slice(0, 12)}…`,
        );
        return { ok: false, error: '附件 sha256 校验失败：响应头与下载内容不一致' };
      }
      let fileName = '';
      try {
        fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      } catch {
        fileName = '';
      }
      return {
        ok: true,
        buffer,
        mimeType: text(response.headers?.get?.('content-type')) || mimeForFileName(fileName),
        fileName,
        sha256: computedSha,
        headerSha256: headerSha,
      };
    },
  };
}

/** 场景包文件名：`<scenarioId>.crm-scenario.json`。 */
export function packageFileName(scenarioId) {
  return `${scenarioId}.crm-scenario.json`;
}

export function isPresetAttachmentName(fileName) {
  return isAllowedPresetFile(String(fileName ?? ''));
}
