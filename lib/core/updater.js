/**
 * 插件自更新：查 registry 上的最新版本，用户确认后交给宿主安装。
 *
 * 为什么插件要自己做这件事：DSH 的 `plugin-manager` 只提供 `installBundle` /
 * `inspect` / `listBundles` / `removeBundle` / `setEnabled`，**没有「检查更新」**；
 * 官方 `plugin-market` 也只负责索引源与安装。所以「有新版本了」这句话只能由
 * 插件自己说，再由插件调用宿主的安装能力完成升级（宿主会在失败时把
 * `package.json` 与 `pnpm-lock.yaml` 回滚到操作前）。
 *
 * 三条边界：
 *   1. 只读 registry 的公开元数据（`<name>/latest`），不上报任何东西；
 *   2. 检查失败一律降级为 `ok:false`，绝不影响面板正常打开；
 *   3. 安装动作不自己跑 pnpm —— 交给 `pluginManager.installBundle`。
 *
 * 本模块零 npm 依赖，可被后续其它插件原样复用：换掉 `name` / `version` 即可。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认检查间隔：面板每次打开都会问，但不能每次都打 registry。 */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次 registry 查询的上限：超过就当网络不通，不拖住面板。 */
const FETCH_TIMEOUT_MS = 8000;
/** 公开 npm 源；私有部署会在配置或 .npmrc 里覆盖。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/* ── 版本比较（semver 子集，够用且不引依赖） ───────────────────── */

/**
 * 解析 `1.2.3` / `1.2.3-beta.1` / `v1.2.3+build`。
 * 解析不了（例如 `link:` 装法带出来的非版本字符串）时返回 null，
 * 由调用方判定「无法比较」，而不是猜一个结果。
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value ?? '').trim(),
  );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** semver 第 11 条：数字段比较数值，数字段低于非数字段，段数少的更低。 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

/** 比较两个版本：返回 1 / 0 / -1；任一无法解析时返回 null。 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** candidate 是否比 current 新。无法比较时一律 false（宁可不提示，也不误报）。 */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/* ── registry 与凭据 ──────────────────────────────────────────── */

/** registry 统一成带协议、带结尾斜杠的形式；空值返回空串。 */
export function normalizeRegistry(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return '';
  // 带了协议却不是 http(s)（ftp:、file: 之类）：直接判为无效，
  // 不能硬拼 https:// 前缀 —— 那会拼出 `https://ftp//x/` 这种畸形地址。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}/`;
  } catch {
    return '';
  }
}

/** 包名进 URL：`@scope/name` 的斜杠要转义，否则 registry 会当成两级路径。 */
function encodePackageName(name) {
  return String(name).trim().replace('/', '%2f');
}

/**
 * 从 .npmrc 里找这台机器配的 registry 与该 host 的 token。
 *
 * 只做两件事：读 `registry=` 这一行；读 `//host/path/:_authToken=...`
 * （以及 `_auth` 的 base64 形式）。作用域级 registry（`@corp:registry=`）
 * 不参与 —— 插件自己的包名是固定的，取全局那一条就够。
 */
export function readNpmrc(filePath) {
  const result = { registry: '', token: '', scopes: {} };
  if (!existsSync(filePath)) return result;
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value === '') continue;
    if (key === 'registry') {
      result.registry = normalizeRegistry(value);
      continue;
    }
    // `@scope:registry=...`：npm 的 scope 映射。私有源的包几乎都靠这一行才能定位，
    // 只认全局 registry 会让「更新检查」跑到公共源去找一个私有包，永远 404。
    if (key.startsWith('@') && key.endsWith(':registry')) {
      const scope = key.slice(0, -':registry'.length);
      const normalized = normalizeRegistry(value);
      if (scope !== '' && normalized !== '') result.scopes[scope] = normalized;
      continue;
    }
    if (key.endsWith(':_authToken')) {
      // key 形如 //npm.corp.com/repo/:_authToken：保留前缀，供按 registry 匹配。
      result[`token:${key.slice(0, -':_authToken'.length)}`] = value;
    }
  }
  return result;
}

/** 在 .npmrc 里按 registry 的 host+path 找最长匹配的 token。 */
function tokenFromNpmrc(registry, npmrc) {
  if (registry === '') return '';
  let prefix;
  try {
    const url = new URL(registry);
    prefix = `//${url.host}${url.pathname.replace(/\/+$/, '')}/`;
  } catch {
    return '';
  }
  if (typeof npmrc[`token:${prefix}`] === 'string') return npmrc[`token:${prefix}`];
  // 退一级：只按 host 配的 token（npm 支持 `//host/:_authToken=...`）。
  const hostOnly = `//${new URL(registry).host}/`;
  if (typeof npmrc[`token:${hostOnly}`] === 'string') return npmrc[`token:${hostOnly}`];
  return '';
}

/**
 * 解析这次检查要用的 registry、token 与来源说明。
 * 优先级：显式配置 → 环境变量 → profile 的 .npmrc → home 的 .npmrc → 官方源。
 */
export function resolveRegistry({ configured, name = '', env = process.env, profileDir = '', homeDir = '' } = {}) {
  const npmrcPaths = [];
  if (profileDir !== '') npmrcPaths.push(join(profileDir, '.npmrc'));
  if (homeDir !== '') npmrcPaths.push(join(homeDir, '.npmrc'));

  const merged = { registry: '', token: '', scopes: {} };
  for (const filePath of npmrcPaths) {
    const parsed = readNpmrc(filePath);
    if (parsed.registry !== '') merged.registry = parsed.registry;
    Object.assign(merged.scopes, parsed.scopes);
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('token:') && typeof value === 'string' && value !== '') merged[key] = value;
    }
  }

  // scoped 包优先用它自己 scope 配的源：npm 的语义里 scope 比全局更具体。
  // 少了这一步，私有源上的包会去公共源查，永远 404、永远不提示更新。
  const scope = typeof name === 'string' && name.startsWith('@') ? name.split('/')[0] : '';
  const scopeRegistry = scope === '' ? '' : (merged.scopes[scope] ?? '');

  const registry =
    normalizeRegistry(configured) ||
    normalizeRegistry(env.DSH_PLUGIN_REGISTRY) ||
    normalizeRegistry(env.npm_config_registry) ||
    scopeRegistry ||
    normalizeRegistry(merged.registry) ||
    DEFAULT_REGISTRY;

  const token =
    String(env.NODE_AUTH_TOKEN ?? '').trim() ||
    String(env.NPM_TOKEN ?? '').trim() ||
    tokenFromNpmrc(registry, merged) ||
    '';

  return { registry, token, source: registry === DEFAULT_REGISTRY ? 'npm' : 'private' };
}

/* ── 状态文件（记住「跳过这个版本」） ──────────────────────────── */

function readState(filePath) {
  if (typeof filePath !== 'string' || filePath === '' || !existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(filePath, value) {
  if (typeof filePath !== 'string' || filePath === '') return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, filePath);
  } catch {
    /* 记不住「跳过」不影响主流程：下次还会提示而已 */
  }
}

/* ── 主体 ─────────────────────────────────────────────────────── */

/**
 * @param {object} options
 * @param {string} options.name           包名，例如 `@runner-corp/dsh-scenario-workspace`
 * @param {string} options.version        当前版本（唯一真源是 package.json）
 * @param {string} [options.registry]     显式 registry；留空按 .npmrc / 环境变量推断
 * @param {string} [options.stateFile]    「跳过版本」的落盘位置
 * @param {(spec: string) => Promise<object>} options.install  宿主安装能力
 * @param {object} [options.logger]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetch]
 */
export function createUpdater({
  name,
  version,
  registry = '',
  stateFile = '',
  install,
  logger,
  ttlMs = CHECK_TTL_MS,
  now = () => Date.now(),
  fetch: fetchImpl = globalThis.fetch,
  // 三个可注入项只为测试：生产环境走真实进程环境与 profile 目录。
  env = process.env,
  profileDir = String(process.env.DSH_PROFILE_DIR ?? ''),
  homeDir = String(process.env.DSH_HOME ?? ''),
}) {
  const state = readState(stateFile);
  let lastCheck; // { at, result }
  let inflight;
  /** 安装是一次性的后台任务，状态留在内存里供面板轮询。 */
  let applyState = { phase: 'idle', target: '', message: '', startedAt: '', result: undefined };

  const resolved = resolveRegistry({
    configured: registry,
    name,
    env,
    profileDir,
    homeDir,
  });

  function describeFailure(error, status) {
    if (status === 401 || status === 403) {
      return '私有 registry 要求登录：请确认这台机器的 .npmrc 里配了该源的 _authToken';
    }
    if (status === 404) return `registry（${resolved.registry}）上没有找到 ${name}`;
    if (status !== undefined && status >= 500) return `registry 暂时不可用（HTTP ${status}）`;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '查询 registry 超时';
    return `查询 registry 失败：${error?.message ?? String(error)}`;
  }

  /** 读 registry 上该包的 latest 元数据；失败返回 { ok:false }，不抛。 */
  async function fetchLatest() {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, message: '当前运行时没有 fetch，无法检查更新' };
    }
    const url = `${resolved.registry}${encodePackageName(name)}/latest`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(resolved.token === '' ? {} : { authorization: `Bearer ${resolved.token}` }),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, message: describeFailure(error) };
    }
    if (!response.ok) {
      return { ok: false, message: describeFailure(undefined, response.status) };
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return { ok: false, message: `registry 返回的不是 JSON：${error?.message ?? String(error)}` };
    }
    const latest = String(payload?.version ?? '').trim();
    if (latest === '') return { ok: false, message: 'registry 返回的元数据里没有 version' };
    return {
      ok: true,
      latest,
      notes:
        String(payload?.dsh?.updateNotes ?? payload?.description ?? '').trim().slice(0, 600),
      deprecated: String(payload?.deprecated ?? '').trim().slice(0, 200),
    };
  }

  async function doCheck() {
    const fetched = await fetchLatest();
    const checkedAt = new Date(now()).toISOString();
    if (fetched.ok !== true) {
      const result = {
        ok: false,
        name,
        current: version,
        latest: '',
        updateAvailable: false,
        checkedAt,
        registry: resolved.registry,
        message: fetched.message,
      };
      lastCheck = { at: now(), result };
      return result;
    }

    const comparison = compareVersions(fetched.latest, version);
    // 无法比较（当前版本不是 semver，例如 link: 装法）时只报告事实，不提供升级。
    const comparable = comparison !== null;
    const skippedVersion = String(state.skippedVersion ?? '');
    const result = {
      ok: true,
      name,
      current: version,
      latest: fetched.latest,
      updateAvailable: comparable && comparison === 1,
      comparable,
      skipped: fetched.latest === skippedVersion && skippedVersion !== '',
      notes: fetched.notes ?? '',
      deprecated: fetched.deprecated ?? '',
      checkedAt,
      registry: resolved.registry,
      message: comparable ? '' : '当前版本不是标准语义化版本，无法判断新旧',
    };
    lastCheck = { at: now(), result };
    return result;
  }

  /**
   * 检查更新。默认 6 小时内复用上次结果，`force: true` 跳过缓存。
   * 同一时刻只发一个请求：面板可能被多个入口同时唤起。
   */
  async function check({ force = false } = {}) {
    if (force !== true && lastCheck !== undefined && now() - lastCheck.at < ttlMs) {
      return { ...lastCheck.result, cached: true };
    }
    if (inflight !== undefined) return inflight;
    inflight = doCheck().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    /** 包名与当前版本，供面板显示。 */
    identity: { name, version, registry: resolved.registry },

    check,

    /** 仅读缓存，不发请求（面板轮询用）。 */
    cached() {
      return lastCheck === undefined ? undefined : { ...lastCheck.result, cached: true };
    },

    /**
     * 开始升级：立刻返回，真正的安装在后台跑，面板用 `status()` 轮询。
     * 不在请求里同步等待 pnpm —— 一次安装可能要几十秒，HTTP 会先超时。
     */
    async apply() {
      if (applyState.phase === 'installing') {
        return { ok: true, phase: 'installing', target: applyState.target, message: '正在升级，请稍候' };
      }
      const checked = await check({ force: false });
      if (checked.ok !== true) {
        return { ok: false, message: checked.message ?? '检查更新失败，暂时无法升级' };
      }
      if (checked.updateAvailable !== true) {
        return { ok: false, message: `当前已是最新版本（v${version}）` };
      }
      if (typeof install !== 'function') {
        return { ok: false, message: '当前宿主没有提供插件安装能力，请在插件页手动升级' };
      }

      const target = checked.latest;
      applyState = { phase: 'installing', target, message: '', startedAt: new Date(now()).toISOString(), result: undefined };

      // 后台执行；任何异常都收敛成 failed 状态，不产生未处理的 rejection。
      void (async () => {
        try {
          const result = await install(`${name}@${target}`);
          const application = String(result?.application ?? '');
          if (application === 'failed' || application === 'cancelled') {
            applyState = {
              ...applyState,
              phase: 'failed',
              message:
                String(result?.error?.message ?? '').trim() ||
                (application === 'cancelled' ? '安装被取消' : '安装失败，已回滚到升级前的版本'),
              result,
            };
            return;
          }
          // applied / restart-required / overridden 都算装上了，只是生效方式不同。
          applyState = {
            ...applyState,
            phase: 'done',
            message:
              application === 'restart-required'
                ? '已升级，需要重启 DSH 才能生效'
                : '已升级，重启 DSH 后生效',
            restartRequired: application === 'restart-required',
            result,
          };
        } catch (error) {
          const message = String(error?.message ?? error);
          logger?.warn?.(`[crm-workspace] 自动升级失败：${message}`);
          applyState = { ...applyState, phase: 'failed', message: `升级失败：${message}` };
        }
      })();

      return { ok: true, phase: 'installing', target, message: '开始升级' };
    },

    /** 升级进度（面板轮询）。 */
    status() {
      return { ...applyState, current: version, checked: lastCheck?.result ?? null };
    },

    /** 记下「这个版本不再提醒」；只是本地偏好，不改变已安装内容。 */
    skip(versionToSkip) {
      const target = String(versionToSkip ?? '').trim();
      if (target === '') return { ok: false, message: '缺少版本号' };
      state.skippedVersion = target;
      state.skippedAt = new Date(now()).toISOString();
      writeState(stateFile, state);
      if (lastCheck !== undefined) {
        lastCheck = { ...lastCheck, result: { ...lastCheck.result, skipped: true } };
      }
      return { ok: true, skippedVersion: target };
    },
  };
}
