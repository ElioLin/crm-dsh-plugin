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

const BODY_LIMIT = 1024 * 1024;

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
      const error = new Error('请求体超过 1 MiB');
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
