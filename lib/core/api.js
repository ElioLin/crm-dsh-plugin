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
  ASSET_ROUTE,
  BUSINESS_SYSTEMS,
  DEFAULT_ICON,
  ICON_CATALOG,
  LIMITS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  PRESET_ATTACHMENT_EXTENSIONS,
  PRESET_ATTACHMENT_ROLE,
  RESERVED_COMMAND_NAMES,
  SCENARIO_CATEGORIES,
  SCENARIO_SOURCE_TYPES,
  SKILL_ROUTE_NAME_PATTERN,
  STATE_VERSION,
  isValidScenarioId,
} from './constants.js';
import { buildContextBlock } from './block.js';
import {
  ACTIVATION_IDLE_TTL_MS,
  ACTIVATION_TTL_MS,
  addScenario,
  describeActivation,
  findEntry,
  markInjected,
  normalizeActivation,
  removeScenario,
  scenarioIds,
} from './activation.js';
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

/** 场景栏轮询里「这栈技能渲染成什么 token」的缓存时长（预检会主动清掉它）。 */
const SKILL_TOKEN_TTL_MS = 20_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从整张激活表里摘掉一个场景（场景被删除/下架时用）。
 * 一个会话可能叠加了多个场景：只摘掉被删的那个，其余保持生效。
 */
function dropScenarioEverywhere(activations, scenarioId) {
  if (activations === null || typeof activations !== 'object') return;
  for (const [sessionId, record] of Object.entries(activations)) {
    const base = normalizeActivation(sessionId, record);
    const next = removeScenario(base, scenarioId);
    if (next === undefined) delete activations[sessionId];
    else activations[sessionId] = next;
  }
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

/**
 * 输入框里的场景引用标记：`/场景名称`。
 *
 * 压成一行；纯 ASCII 的 `/xxx` 有可能与宿主注册的斜杠指令同名，
 * 这种情况下加「场景」前缀，保证它只是文本而不是一条可执行指令。
 */
function scenarioReference(card) {
  const title = String(card?.title ?? '').replace(/\s+/g, ' ').trim();
  if (title === '') return '';
  const raw = `/${title}`;
  return /^\/[a-z0-9-]+$/i.test(raw) ? `场景${raw}` : raw;
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
 * @param {() => ({mcpClientToken?: string, platformUserId?: string} | null | Promise<object | null>)} [options.getInternalCredential]
 *   `internal_bearer` / `auto` 模式的凭据解析器
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
  getInternalCredential,
  ensureSystemWorkspace,
  updater,
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
      platformUserHeader: config.platformUserHeader,
      getInternalCredential,
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

  /** 当前用户缓存 5 分钟：面板每 5 秒轮询一次 bootstrap，不能每次都去问账号服务。 */
  const CURRENT_USER_TTL_MS = 5 * 60 * 1000;
  let currentUserCache = { value: '', at: 0 };
  /**
   * 当前登录用户显示名（场景「创建人」的唯一来源）。
   *
   * 只认 DSH 自己的身份：显式配置 `defaultAuthor` → 宿主账号资料 → 进程用户。
   * 刻意不读 MCP 返回的 `auth.crmUsername` —— 那是 Salesforce 账号，
   * 跟 DSH 里的操作人不是一回事，混用会让「创建人」变成另一个系统的用户名。
   */
  async function resolveCurrentUser() {
    if (typeof config.defaultAuthor === 'string' && config.defaultAuthor !== '') {
      return config.defaultAuthor;
    }
    if (currentUserCache.value !== '' && Date.now() - currentUserCache.at < CURRENT_USER_TTL_MS) {
      return currentUserCache.value;
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
    currentUserCache = { value: name, at: Date.now() };
    return name;
  }

  /**
   * 场景「创建人」：新建时用当前 DSH 用户，编辑时保留原创建人。
   * 不接受客户端传来的 author —— 那是只读字段，前端不应该能改写它。
   */
  async function authorFor(previous) {
    const existing = text(previous?.author);
    if (existing !== '') return existing;
    return resolveCurrentUser();
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
   * 当前会话里「已经被插件指令占掉」的名字（不含 `/`）。
   *
   * 宿主的指令表先于技能手势解析：`/crm-exit` 永远是退出指令，不会是同名技能。
   * 预检据此把「技能名撞了指令名」单独标出来，而不是让用户以为技能没装。
   */
  function commandNames() {
    const names = new Set(RESERVED_COMMAND_NAMES);
    for (const card of store.scenarios()) {
      const command = text(card.slashCommand).replace(/^\//, '');
      if (command !== '') names.add(command);
      // 停用中的卡片不注册指令，但它随时可能被启用：预检一律按「会占名」处理，
      // 免得启用一张卡之后，原本能路由的技能静默失效。
    }
    return names;
  }

  /**
   * 一个技能能不能被输入框里的 `/name` 真正路由（纯函数）。
   *
   * 三种失败方式各不相同，用户要采取的行动也不同：
   * - `missing`：本机看不到这个技能 → 去「智能体中心」安装；
   * - `not-routable`：名字不是 kebab-case → `/name` 手势永远识别不了，只能靠模型调 skill 工具；
   * - `command-clash`：名字与插件指令同名 → 宿主的指令表先占整行，`/name` 变成指令。
   */
  function routeVerdict(entry, commands) {
    if (entry?.missing === true) return 'missing';
    if (SKILL_ROUTE_NAME_PATTERN.test(entry?.name ?? '') !== true) return 'not-routable';
    if (commands.has(entry.name) === true) return 'command-clash';
    if (entry?.userInvocable === false) return 'user-disabled';
    return 'ok';
  }

  /** 把（可路由的）技能栈渲染成输入框里的 `/a /b` token 串（纯函数）。 */
  function skillTokensOf(stack, commands) {
    const tokens = [];
    for (const entry of Array.isArray(stack) ? stack : []) {
      if (routeVerdict(entry, commands) !== 'ok') continue;
      tokens.push(`/${entry.name}`);
    }
    return tokens.join(' ');
  }

  /**
   * 场景栏每 6 秒问一次激活状态，而它需要的是「这栈技能在输入框里长什么样」。
   * 每次重新扫一遍技能目录太贵，这里按「cwd + 技能名列表」缓存一小段时间；
   * 预检（checkSkills）会清缓存，所以「刚装完技能立刻进场景」不会读到旧答案。
   */
  const skillTokenCache = new Map();

  async function stackSkillTokens(cards, cwd) {
    const names = [];
    for (const card of Array.isArray(cards) ? cards : []) {
      for (const name of Array.isArray(card?.pinnedSkills) ? card.pinnedSkills : []) {
        if (typeof name === 'string' && name !== '' && names.includes(name) !== true) names.push(name);
      }
    }
    if (names.length === 0) return { tokens: '', skills: [] };
    const dir = text(cwd);
    const key = `${dir}|${names.join(',')}`;
    const now = Date.now();
    const hit = skillTokenCache.get(key);
    if (hit !== undefined && hit.expiresAt > now) return hit.answer;
    const stack = await resolveStack(
      names,
      undefined,
      dir === '' ? undefined : { cwd: dir },
      { withContent: false },
    );
    // 带上 path：客户端拿它拼 `dsh-resource://file/...` 地址，点技能名就能在右侧栏
    // 打开 SKILL.md（和用户手动 `/技能名` 之后点 chip 的落点一样）。
    const answer = {
      tokens: skillTokensOf(stack, commandNames()),
      skills: stack.map((entry) => ({
        name: entry.name,
        description: entry.description,
        path: entry.path,
        route: entry.route,
      })),
    };
    if (skillTokenCache.size >= 64) skillTokenCache.clear();
    skillTokenCache.set(key, { answer, expiresAt: now + SKILL_TOKEN_TTL_MS });
    return answer;
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
    const commands = commandNames();
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
      // `missing` 有两种读法：注入侧关心「正文拿到了没有」，手势侧关心「本机有没有这个技能」。
      // listSkillSummaries 已经把目录兜底行并进来了，所以 summary 是否存在就是后者。
      const present = summary !== undefined;
      const entry = {
        name,
        description: summary?.description ?? definition?.description ?? fromDirectory.get(name)?.description ?? '',
        // 技能入口文件（SKILL.md）的绝对路径：客户端用它打开右侧栏预览。
        // 服务层（preset/内置 bundle）可能只给 resourceBase 不给 path，这时退回磁盘兜底行。
        path: text(summary?.path) || text(definition?.path) || text(fromDirectory.get(name)?.path),
        content,
        loaded: withContent && content !== '',
        missing: withContent ? content === '' && present !== true : present !== true,
        // 手势路由要看的三件事（与「正文拿到了没有」无关）：
        // 技能本身声明了什么、名字能不能被 `/name` 识别、有没有被插件指令占名。
        userInvocable: summary?.invocation?.userInvocable !== false,
        routable: SKILL_ROUTE_NAME_PATTERN.test(name),
        commandClash: commands.has(name),
      };
      entry.route = routeVerdict(entry, commands);
      stack.push(entry);
    }
    return stack;
  }

  function findCard(scenarioId) {
    return store.findScenario(scenarioId);
  }

  function findCompanyCard(scenarioId) {
    return store.findCompanyScenario?.(scenarioId);
  }

  /** 激活记录 → 一轮卡片视图（跳过已被删除的场景），用于栈式 UI 与诊断。 */
  function cardViewsOf(record) {
    const rows = [];
    for (const id of scenarioIds(record ?? {})) {
      const card = findCard(id);
      if (card !== undefined) rows.push(cardView(card));
    }
    return rows;
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

  /**
   * 激活一个场景。
   *
   * - 默认 `stack: false`：「进入场景」= 用它替换当前会话的场景栈；
   * - `stack: true`：叠加到当前会话，保留已有场景（第 ⑨ 项，多场景并存）。
   */
  async function activate({ sessionId, scenarioId, source = 'ui', stack = false, cwd = '' }) {
    const card = findCard(scenarioId);
    if (card === undefined) return { ok: false, message: `场景 ${scenarioId} 不存在或已被删除` };
    if (card.enabled !== true && source !== 'ui') {
      return { ok: false, message: `场景「${card.title}」已停用，无法被指令唤醒` };
    }
    const current = store.activation(sessionId);
    if (stack === true && scenarioIds(current ?? {}).length >= LIMITS.maxScenariosPerSession) {
      return { ok: false, message: `一个会话最多叠加 ${LIMITS.maxScenariosPerSession} 个场景，请先移除一个` };
    }
    const record = await store.mutate((draft) => {
      const base = normalizeActivation(sessionId, draft.activations[sessionId]);
      const next = addScenario(base, { scenarioId, source, replace: stack !== true });
      draft.activations[sessionId] = next;
      return { result: next === undefined ? undefined : JSON.parse(JSON.stringify(next)) };
    });
    // 会话所在目录决定「本机有没有这个技能」：项目级技能（.dsh/skills、.agents/skills）
    // 会盖掉用户级同名技能，所以按会话 cwd 取分层视图，不用根视图糊弄过去。
    const view = text(cwd) === '' ? undefined : { cwd: text(cwd) };
    const resolved = await resolveStack(card.pinnedSkills, undefined, view);
    const commands = commandNames();
    const skillTokens = skillTokensOf(resolved, commands);
    logger?.info?.(
      `[${PLUGIN_ID}] 激活场景 ${scenarioId} → 会话 ${sessionId}（${stack === true ? '叠加' : '替换'}，栈：${scenarioIds(record ?? {}).join(' + ') || scenarioId}，${resolved.length} 个 Skill，路由 token：${skillTokens || '无'}）`,
    );
    return {
      ok: true,
      activation: record,
      scenario: cardView(card),
      scenarios: cardViewsOf(record),
      skillTokens,
      // path 是「输入框里那颗 chip 点开哪个 SKILL.md」的唯一依据：客户端拿不到技能目录，
      // 只能靠这里一路带下去（场景栏 chip 与输入框 chip 共用同一份路径）。
      skills: resolved.map(({ name, description, missing, loaded, route, userInvocable, commandClash, path }) => ({
        name,
        description,
        missing,
        loaded,
        route,
        userInvocable,
        commandClash,
        path: text(path),
      })),
    };
  }

  /** 只摘掉会话里的一个场景；栈空了才删除整条激活记录。 */
  async function deactivateScenario({ sessionId, scenarioId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, message: '缺少会话标识' };
    }
    let removed = false;
    let remaining;
    await store.mutate((draft) => {
      const current = normalizeActivation(sessionId, draft.activations[sessionId]);
      if (current === undefined) return { result: undefined, changed: false };
      const next = removeScenario(current, scenarioId);
      removed = next !== current;
      if (next === undefined) delete draft.activations[sessionId];
      else draft.activations[sessionId] = next;
      remaining = next;
      return { result: undefined };
    });
    const activation = store.activation(sessionId);
    logger?.info?.(`[${PLUGIN_ID}] 从会话 ${sessionId} 移除场景 ${scenarioId}（剩余 ${scenarioIds(activation ?? {}).length} 个）`);
    return { ok: true, removed, activation, scenarios: cardViewsOf(activation) };
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
   * 每次模型请求前调用：返回要注入的文本，并记录「注入过什么、注入了多少次」。
   *
   * 分级策略（第 ④ 项，省 token 的关键）：
   *   - 开了 injectSkillBodies：首轮 `full`（带 Skill 正文）→ 之后 `reminder`；
   *   - 默认：首轮 `names`（完整块，只有技能名）→ 之后 `brief`（一行提醒）。
   * 会话历史里仍然留着首轮那份完整块，所以后续轮次只提醒「场景还在、顺序不变」。
   */
  async function prepareInjection(sessionId, override = {}) {
    if (config.injectSkillsOnStep !== true) return undefined;
    const record = store.activation(sessionId);
    if (record === undefined) return undefined;
    const entries = Array.isArray(record.scenarios) ? record.scenarios : [];
    const withBodies = config.injectSkillBodies === true;
    const promptText = typeof override?.promptText === 'string' ? override.promptText : '';
    const blocks = [];
    const used = [];
    let dropped = 0;

    for (const entry of entries) {
      const card = findCard(entry.scenarioId);
      if (card === undefined) {
        dropped += 1;
        continue;
      }
      const stack = await resolveStack(
        card.pinnedSkills,
        override?.getSkills?.(),
        override?.cwd ? { cwd: override.cwd } : undefined,
        { withContent: withBodies },
      );
      const mode = withBodies
        ? entry.fullInjectedAt === undefined
          ? 'full'
          : 'reminder'
        : entry.injectedAt === undefined
          ? 'names'
          : 'brief';
      const template = card.inputDraft.trim();
      // 预填里的 `/技能名` 到底有没有随这条消息进来：有的话，宿主（dsh-tool-skill）
      // 已经把对应技能的正文按同一顺序注入本次请求了，块里就不能再要求模型「用 skill
      // 工具逐个加载」——那是重复加载同一份正文，白烧一遍上下文。
      const routeTokens = config.skillRoutePrefill === false ? '' : skillTokensOf(stack, commandNames());
      blocks.push(
        buildContextBlock({
          card,
          skills: stack,
          mode,
          includeDescriptions: config.injectSkillDescriptions === true,
          includeBodies: withBodies,
          // 预填去重（第 ③ 项）：模板已经在用户消息里，块里只声明这一点，不再复述。
          prefillProvided: template !== '' && promptText.includes(template),
          skillsProvided: routeTokens !== '' && promptText.includes(routeTokens),
          injectionCount: (Number(entry.injectionCount) || 0) + 1,
          stackSize: entries.length,
        }),
      );
      used.push({ card, stack, mode });
    }

    if (dropped > 0) {
      await store
        .mutate((draft) => {
          let next = normalizeActivation(sessionId, draft.activations[sessionId]);
          if (next === undefined) return { result: undefined };
          for (const entry of [...next.scenarios]) {
            if (findCard(entry.scenarioId) === undefined) next = removeScenario(next, entry.scenarioId);
          }
          if (next === undefined) delete draft.activations[sessionId];
          else draft.activations[sessionId] = next;
          return { result: undefined };
        })
        .catch(() => undefined);
    }
    if (used.length === 0) {
      await clearActivation({ sessionId }).catch(() => undefined);
      return undefined;
    }

    await store
      .mutate((draft) => {
        let next = normalizeActivation(sessionId, draft.activations[sessionId]);
        if (next === undefined) return { result: undefined, changed: false };
        for (const item of used) next = markInjected(next, item.card.scenarioId, { mode: item.mode });
        draft.activations[sessionId] = next;
        return { result: undefined };
      })
      .catch(() => undefined);

    const combined = blocks.join('\n\n');
    return {
      text: combined,
      mode: used[0].mode,
      modes: used.map((item) => item.mode),
      card: used[0].card,
      cards: used.map((item) => item.card),
      stack: used[0].stack,
      characters: combined.length,
    };
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
        // 升级只换远端内容：本地创建人（DSH 用户）保持不变，
        // 不能被远端 createdByCrmUser 覆盖。
        author: local.author,
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
            dropScenarioEverywhere(draft.activations, item.scenarioId);
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
    card.author = await resolveCurrentUser();

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
    card.author = await authorFor(previous);

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
    card.author = await authorFor(previous);
    await store.mutate((state) => {
      const index = state.scenarios.findIndex((item) => item.scenarioId === previousId);
      if (index >= 0) state.scenarios[index] = card;
      else state.scenarios.push(card);
      if (previousId !== undefined && previousId !== card.scenarioId) {
        for (const record of Object.values(state.activations)) {
          if (!Array.isArray(record.scenarios)) continue;
          for (const entry of record.scenarios) {
            if (entry.scenarioId === previousId) entry.scenarioId = card.scenarioId;
          }
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
        dropScenarioEverywhere(state.activations, scenarioId);
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
      dropScenarioEverywhere(state.activations, scenarioId);
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
    // 安装是「把它带进我的工作台」：本机创建人记当前 DSH 用户，
    // 公司侧的原始创建人仍保留在 createdByCrmUser / createdByPlatformUid 里。
    card.author = await resolveCurrentUser();
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
      author: await resolveCurrentUser(),
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
          currentUser: await resolveCurrentUser(),
        },
        auth,
        permission: auth,
        config: {
          apiBaseUrl: companyRegistry.apiBaseUrl,
          authMode: config.authMode ?? 'auto',
          identitySource:
            typeof companyRegistry.getIdentitySource === 'function' ? companyRegistry.getIdentitySource() : '',
          platformUserHeader: config.platformUserHeader ?? '',
          injectSkillsOnStep: config.injectSkillsOnStep === true,
          injectSkillBodies: config.injectSkillBodies === true,
          injectSkillDescriptions: config.injectSkillDescriptions === true,
          registerSlashCommands: config.registerSlashCommands === true,
          showSidebarEntry: config.showSidebarEntry !== false,
          skillRoutePrefill: config.skillRoutePrefill !== false,
          autoInstallSkills: config.autoInstallSkills !== false,
          maxScenarioCards: config.maxScenarioCards,
          skillCatalogDir: config.skillCatalogDir ?? '',
          canManageStandardScenario: auth.canManageStandardScenario === true,
        },
        limits: LIMITS,
        taxonomy: {
          categories: SCENARIO_CATEGORIES,
          businessSystems: BUSINESS_SYSTEMS,
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
        // 只读缓存：bootstrap 每 5 秒轮询一次，绝不能在这里打 registry。
        // 真正的检查由面板打开时单独调 update.check 触发。
        update: updater?.cached(),
      };
    },

    /* ── 插件自更新 ───────────────────────────────────────────── */
    /**
     * 检查有没有新版本。默认 6 小时内复用上次结果，`force: true` 强制重查。
     * 检查失败不抛错：面板照常打开，只是不提示升级。
     */
    async updateCheck({ force = false } = {}) {
      if (updater === undefined) {
        return { ok: false, message: '当前宿主没有提供插件管理器，无法自动升级' };
      }
      // autoUpdateCheck 关掉后不主动查；用户手动点「检查更新」仍然放行。
      if (config.autoUpdateCheck === false && force !== true) {
        return { ok: false, disabled: true, message: '已关闭自动检查更新' };
      }
      return updater.check({ force: force === true });
    },

    /** 升级进度：面板在点过「立即升级」之后轮询它，直到 done / failed。 */
    async updateStatus() {
      if (updater === undefined) return { ok: false, phase: 'idle', message: '当前宿主不支持自动升级' };
      return { ok: true, ...updater.status() };
    },

    /** 开始升级（后台跑，立刻返回）。真正的安装由宿主 pluginManager 执行。 */
    async updateApply() {
      if (updater === undefined) {
        return { ok: false, message: '当前宿主没有提供插件管理器，请到插件页手动升级' };
      }
      return updater.apply();
    },

    /** 「这个版本不再提醒」：只影响本机提示，不动已安装内容。 */
    async updateSkip({ version = '' } = {}) {
      if (updater === undefined) return { ok: false, message: '当前宿主不支持自动升级' };
      return updater.skip(version);
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

    /**
     * 确保某个业务系统的工作区存在（目录不存在先建，工作区不存在先建）。
     * 客户端「进入场景」时先调它拿到 workspaceId，再把新会话建在那个工作区里，
     * 这样 CRM 的场景不会跑到 TAPD 的工作区去。
     */
    async ensureWorkspace({ system = '' } = {}) {
      if (typeof ensureSystemWorkspace !== 'function') {
        return { ok: false, message: '当前宿主没有提供业务系统工作区服务' };
      }
      return ensureSystemWorkspace({ system });
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
        // 同步之后才知道这次实际用的是哪条身份（内部凭据 / Buntu Token），
        // 面板据此把「自动注入的登录身份」显示出来。
        identitySource:
          typeof companyRegistry.getIdentitySource === 'function' ? companyRegistry.getIdentitySource() : '',
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
      // 副本是一张新卡片：创建人是当前 DSH 用户，不继承原卡片的作者。
      draft.author = await resolveCurrentUser();
      const usedCommands = new Set(existing.map((item) => normalizeSlashCommand(item.slashCommand)));
      if (usedCommands.has(draft.slashCommand)) {
        draft.slashCommand = `${draft.slashCommand}-${Date.now().toString(36).slice(-3)}`;
      }
      return saveLocalScenario({ draft, previousId: undefined, existing });
    },

    async activateScenario({ sessionId, scenarioId, source, stack, cwd } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: '缺少会话标识' };
      }
      return activate({ sessionId, scenarioId, source, stack: stack === true, cwd });
    },

    /**
     * 技能手势预检：进入场景前确认每个 pinnedSkill 能不能被 `/name` 真正路由。
     *
     * 客户端拿到结果来决定「直接进入」「先自动装再进入」还是「拦住并提示去安装」。
     * 只读：不创建会话、不改激活状态。
     */
    async checkSkills({ names = [], cwd = '' } = {}) {
      const wanted = [];
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string' || name.trim() === '') continue;
        const trimmed = name.trim();
        // 去重：同一个技能被重复上报时，预填里不能出现两个一样的 `/name`。
        if (!wanted.includes(trimmed)) wanted.push(trimmed);
        if (wanted.length >= MAX_SKILL_ROWS) break;
      }
      if (wanted.length === 0) return { ok: true, skills: [], missing: [], blocked: false };
      // 预检是新信息的来源：顺手让状态栏那份 token 缓存失效，
      // 「刚装完技能就进场景」才不会读到安装之前的答案。
      skillTokenCache.clear();
      const view = text(cwd) === '' ? undefined : { cwd: text(cwd) };
      const stack = await resolveStack(wanted, undefined, view, { withContent: false });
      const commands = commandNames();
      return {
        ok: true,
        skills: stack,
        missing: stack.filter((entry) => entry.missing === true).map((entry) => entry.name),
        unroutable: stack.filter((entry) => entry.route === 'not-routable').map((entry) => entry.name),
        clashing: stack.filter((entry) => entry.route === 'command-clash').map((entry) => entry.name),
        disabled: stack.filter((entry) => entry.route === 'user-disabled').map((entry) => entry.name),
        skillTokens: skillTokensOf(stack, commands),
      };
    },

    async activationState({ sessionId, cwd = '' } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: true, activation: undefined };
      const record = store.activation(sessionId);
      if (record === undefined) return { ok: true, activation: undefined };
      const card = findCard(record.scenarioId);
      if (card === undefined) return { ok: true, activation: record };
      // 新会话要带入的三样东西（客户端据此渲染，不伪造聊天消息）：
      //   welcome   —— 场景介绍，显示在输入框上方的「场景开场」卡片里。
      //                1.13.0 起它与注入块里的「场景说明」是同一段文字（原来的
      //                「开场引导语」栏位已合并进来）；留空则客户端不渲染这张卡片；
      //   reference —— 场景引用标记 `/场景名称`，**只用于展示**，不再写进输入框
      //                （第 ② 项：那是死文本，模型会当正文读）；
      //   text      —— 真正的预填内容（inputDraft，1.13.0 起必填）；
      //                旧存档没填过模板时回落到场景介绍，避免进入场景后输入框全空。
      // 附件取「整个场景栈的并集」：叠加进来的场景也有自己的预设附件，
      // 只发主场景那几张会让叠加场景的附件永远挂不上托盘。
      const seenAttachments = new Set();
      const stackedAttachments = [];
      for (const view of cardViewsOf(record)) {
        for (const item of Array.isArray(view?.presetAttachments) ? view.presetAttachments : []) {
          const key = text(item?.attachmentId) || `${text(item?.fileName)}|${Number(item?.fileSize ?? 0)}`;
          if (key === '' || seenAttachments.has(key)) continue;
          seenAttachments.add(key);
          stackedAttachments.push(item);
        }
      }
      if (stackedAttachments.length === 0) {
        // 兜底：cardViewsOf 里没有这张卡（理论上不会）时直接用原始附件。
        for (const item of Array.isArray(card.presetAttachments) ? card.presetAttachments : []) stackedAttachments.push(publicAttachment(item));
      }
      const routeInfo = await stackSkillTokens(cardViewsOf(record), cwd);
      const draft = {
        text: card.inputDraft !== '' ? card.inputDraft : card.description,
        source: card.inputDraft !== '' ? 'inputDraft' : 'description',
        reference: scenarioReference(card),
        welcome: card.description,
        // 整个栈里能在本机路由的技能 token（`/a /b`）。客户端把它拼在模板前面写进输入框，
        // 就是「用户自己打了 /技能名」的等价物：宿主的 dsh-tool-skill 在 pre-step 扫描
        // 这条用户消息，命中后把技能正文按 instructions 注入。
        skillTokens: routeInfo.tokens,
        // 技能名 + SKILL.md 路径：场景栏把它们渲染成可点的小 chip，点了在右侧栏看技能正文
        // （输入框里的 `/技能名` 是不是 chip 由宿主的能力目录决定，这里提供一条稳的入口）。
        skills: routeInfo.skills,
        // stackedAttachments 来自 cardViewsOf，已经是「带下载地址的对外视图」，
        // 这里不能再套一次 publicAttachment：那会把它当原始记录读 localPathOrUrl，
        // url 变成空串（附件在托盘里挂不上）。
        attachments: stackedAttachments,
      };
      return {
        ok: true,
        activation: record,
        scenario: cardView(card),
        // 栈视图：客户端据此渲染「当前场景」列表并逐个移除。
        scenarios: cardViewsOf(record),
        draft,
      };
    },

    clearActivation,
    deactivateScenario,

    /**
     * 诊断信息（第 ⑥ 项 /crm-doctor）：把排查问题真正需要的字段一次返回，
     * 免得再去翻 log、猜 dataDir、猜注入模式。
     */
    async diagnostics({ sessionId, host } = {}) {
      const snapshot = store.snapshot();
      const record = typeof sessionId === 'string' && sessionId !== '' ? store.activation(sessionId) : undefined;
      const rows = [];
      for (const entry of record?.scenarios ?? []) {
        const card = findCard(entry.scenarioId);
        rows.push({
          scenarioId: entry.scenarioId,
          title: card?.title ?? '',
          present: card !== undefined,
          injected: Number(entry.injectionCount) || 0,
          lastInjectedAt: entry.injectedAt ?? '',
          fullInjectedAt: entry.fullInjectedAt ?? '',
          activatedAt: entry.activatedAt ?? '',
          source: entry.source ?? 'ui',
        });
      }
      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
        host: host ?? {},
        state: {
          dataDir: store.dir ?? '',
          version: snapshot.version ?? STATE_VERSION,
          scenarios: snapshot.scenarios.length,
          activations: Object.keys(snapshot.activations ?? {}).length,
          degraded: store.degraded === true,
          warnings: Array.isArray(store.loadWarnings) ? store.loadWarnings.slice(0, 5) : [],
        },
        config: {
          injectSkillsOnStep: config.injectSkillsOnStep === true,
          injectSkillBodies: config.injectSkillBodies === true,
          injectSkillDescriptions: config.injectSkillDescriptions === true,
          registerSlashCommands: config.registerSlashCommands === true,
        },
        lifecycle: { ttlHours: ACTIVATION_TTL_MS / 3600000, idleHours: ACTIVATION_IDLE_TTL_MS / 3600000 },
        // 升级链路的现场：有没有查过、查到什么、装到哪一步。
        // 排查「为什么没提示升级」时，这一块比日志直接。
        update: updater === undefined ? { supported: false } : { supported: true, ...updater.status() },
        session: {
          id: typeof sessionId === 'string' ? sessionId : '',
          summary: describeActivation(record),
          scenarios: rows,
        },
      };
    },

    /** 手动触发激活记录清理（/crm-doctor 与面板「清理」按钮共用）。 */
    async pruneActivations({ now } = {}) {
      const result = await store.pruneActivations(now === undefined ? {} : { now });
      if (result.removed > 0) notify('activation.changed');
      return { ok: true, ...result };
    },

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
      const effectiveMode = withBodies
        ? mode === 'reminder'
          ? 'reminder'
          : 'full'
        : mode === 'brief'
          ? 'brief'
          : 'names';
      const textBlock = buildContextBlock({
        card,
        skills: stack,
        mode: effectiveMode,
        includeDescriptions: config.injectSkillDescriptions === true,
        includeBodies: withBodies,
        prefillProvided: mode === 'brief' ? false : card.inputDraft.trim() !== '',
        // 预览假设「用户就这样发出去」：token 在草稿里，宿主会把正文注入本次请求。
        skillsProvided:
          config.skillRoutePrefill !== false && skillTokensOf(stack, commandNames()) !== '',
        injectionCount: 1,
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
