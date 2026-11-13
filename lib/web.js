/**
 * Host 侧 HTTP JSON 接口：`/crm-workspace/api`。
 *
 * 为什么要有这一层：DSH 的 Host 服务默认只对「会话内的模型工具」暴露，
 * 而工作台面板是浏览器里的 UI，必须有一条同源、可校验、可 curl 复现的通道。
 * 于是这里照抄 dsh-mcp-connector 的成熟做法：
 *   - 只接受 POST + application/json；
 *   - 只接受 loopback / 已信任 Host 的请求，并拒绝跨站；
 *   - 方法名走白名单 Map，参数不参与任何字符串拼接；
 *   - 响应统一 `{ok: true, ...}` / `{ok: false, message}`，带 no-store。
 *
 * 安全边界说明：本路由只读写「场景配置」，不接触会话内容、不执行模型调用，
 * 因此即便被同源页面误调用，也不会放大成数据泄露面。
 */

import { mimeForFileName } from './core/schema.js';

const BODY_LIMIT = 40 * 1024 * 1024;
const ASSET_CACHE_SECONDS = 300;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * 拒绝跨站请求。规则与 dsh-mcp-connector 一致：
 * Host 头必须是回环地址或已信任域名；`Sec-Fetch-Site: cross-site` 一律拒绝；
 * 带 Origin 时，Origin 的 host 必须与 Host 完全一致。
 */
export function isTrustedRequest(req, trustedHosts = []) {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;

  let hostUrl;
  try {
    hostUrl = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  const trusted = new Set(
    (Array.isArray(trustedHosts) ? trustedHosts : []).map((value) => String(value).toLowerCase()),
  );
  if (!isLoopbackHost(hostUrl.hostname) && !trusted.has(hostUrl.hostname) && !trusted.has(hostUrl.host)) {
    return false;
  }

  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('请求体超过 40 MiB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

function readSessionIds(params) {
  if (!Array.isArray(params?.sessions)) return [];
  return params.sessions.filter((id) => typeof id === 'string' && id !== '').slice(0, 20);
}

/** 方法白名单：新增接口必须在这里登记，路由层不接受任何动态方法名。 */
export function createDispatchTable(api) {
  return new Map([
    ['bootstrap', (_api, params) => api.bootstrap({ sessions: readSessionIds(params) })],
    ['skills.list', (_api, params) => api.listSkills({ query: params?.query ?? '' })],
    ['scenario.save', (_api, params) => api.saveScenario({ draft: params?.draft, previousId: params?.previousId })],
    ['scenario.delete', (_api, params) => api.deleteScenario({ scenarioId: params?.scenarioId })],
    ['scenario.enable', (_api, params) => api.setScenarioEnabled({ scenarioId: params?.scenarioId, enabled: params?.enabled === true })],
    ['scenario.move', (_api, params) => api.moveScenario({ scenarioId: params?.scenarioId, direction: params?.direction === 'up' ? 'up' : 'down' })],
    ['scenario.duplicate', (_api, params) => api.duplicateScenario({ scenarioId: params?.scenarioId })],
    ['activation.activate', (_api, params) => api.activateScenario({ sessionId: params?.sessionId, scenarioId: params?.scenarioId, source: params?.source === 'command' ? 'command' : 'ui' })],
    ['activation.state', (_api, params) => api.activationState({ sessionId: params?.sessionId })],
    ['activation.clear', (_api, params) => api.clearActivation({ sessionId: params?.sessionId })],
    ['preview.injection', (_api, params) => api.previewInjection({ scenarioId: params?.scenarioId, mode: params?.mode === 'reminder' ? 'reminder' : 'full' })],
    ['scenario.attachment.save', (_api, params) => api.saveAttachment({
      fileName: params?.fileName,
      mimeType: params?.mimeType,
      dataBase64: params?.dataBase64,
    })],
    ['registry.list', (_api, params) => api.listCompanyScenarios({ refresh: params?.refresh === true })],
    ['scenario.permission', (_api, params) => api.getPermission({ refresh: params?.refresh === true })],
    ['scenario.sync', (_api) => api.syncCompanyScenarios()],
    ['scenario.install', (_api, params) => api.installCompanyScenario({ scenarioId: params?.scenarioId })],
    ['scenario.fork', (_api, params) => api.forkStandardToLocalScenario({ scenarioId: params?.scenarioId })],
    ['scenario.export', (_api, params) => api.exportScenarioBundle({
      scenarioId: params?.scenarioId,
      source: params?.source === 'company' ? 'company' : 'local',
    })],
    ['scenario.import', (_api, params) => api.importScenario({ package: params?.package })],
    ['scenario.publish', (_api, params) => api.publishScenario({ scenarioId: params?.scenarioId })],
  ]);
}

/**
 * 挂载路由，返回 disposer。
 *
 * @param {object} wctx 已注入 webServer 的上下文
 * @param {object} api createApi() 的返回值
 * @param {{path?: string, logger?: object, trustedHosts?: string[]}} [options]
 */
export function mountApiRoutes(wctx, api, { path = '/crm-workspace/api', logger, trustedHosts = [] } = {}) {
  const dispatch = createDispatchTable(api);

  const dispose = wctx.webServer.register({
    kind: 'prefix',
    path,
    handler: async (req, res) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, message: '禁止的请求来源' });
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.includes('application/json')) {
        writeJson(res, 415, { ok: false, message: 'Content-Type 必须是 application/json' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(res, error?.statusCode ?? 400, { ok: false, message: error?.message ?? '请求体读取失败' });
        return;
      }

      const method = typeof body?.method === 'string' ? body.method : '';
      const handler = dispatch.get(method);
      if (handler === undefined) {
        writeJson(res, 400, { ok: false, message: `未知接口方法：${method === '' ? '(空)' : method}` });
        return;
      }

      try {
        const result = await handler(api, body?.params ?? {});
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        logger?.error?.(`[crm-workspace] ${method} 失败：${error?.stack ?? error}`);
        writeJson(res, 500, { ok: false, message: error?.message ?? '服务端处理失败' });
      }
    },
  });

  return typeof dispose === 'function' ? dispose : () => undefined;
}

/**
 * 挂载场景预设附件的只读下载路由：`GET /crm-workspace/asset/<文件名>`。
 *
 * 与 JSON 接口共用同一套来源校验；路径只接受单段文件名，
 * 真正的越界防护在 assets.resolvePath 里（解析后必须仍在资产目录内）。
 *
 * @param {object} wctx 已注入 webServer 的上下文
 * @param {ReturnType<import('./core/assets.js').createAssetStore>} assets
 * @param {{path?: string, logger?: object, trustedHosts?: string[]}} [options]
 */
export function mountAssetRoutes(
  wctx,
  assets,
  { path = '/crm-workspace/asset', logger, trustedHosts = [] } = {},
) {
  const dispose = wctx.webServer.register({
    kind: 'prefix',
    path,
    handler: async (req, res) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, message: '禁止的请求来源' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      let name = '';
      try {
        const url = new URL(String(req.url ?? ''), 'http://localhost');
        name = decodeURIComponent(url.pathname.slice(path.length + 1));
      } catch {
        name = '';
      }
      if (name === '' || name.includes('/') || name.includes('\\')) {
        writeJson(res, 404, { ok: false, message: '附件不存在' });
        return;
      }

      try {
        const file = await assets.read(name);
        const body = file.buffer;
        res.writeHead(200, {
          'content-type': mimeForFileName(name),
          'content-length': String(body.byteLength),
          'cache-control': `private, max-age=${ASSET_CACHE_SECONDS}`,
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(body);
      } catch (error) {
        logger?.warn?.(`[crm-workspace] 读取预设附件失败：${error?.message ?? error}`);
        writeJson(res, 404, { ok: false, message: '附件不存在' });
      }
    },
  });

  return typeof dispose === 'function' ? dispose : () => undefined;
}
