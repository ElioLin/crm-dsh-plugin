import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApi } from '../lib/core/api.js';
import { createAssetStore } from '../lib/core/assets.js';
import {
  createRegistry,
  fromRemoteScenario,
  sha256Hex,
  toRemoteWritePayload,
} from '../lib/core/registry.js';
import { createStateStore } from '../lib/core/state.js';
import { DEFAULT_MCP_API_BASE_URL } from '../lib/core/constants.js';

const baseDraft = {
  title: 'CRM 单据新建与修改',
  description: '按单据类型新建或修改记录，自动处理必填项与字段权限。',
  icon: 'briefcase',
  category: '核心单据管控',
  slashCommand: '/record',
  enabled: true,
  pinnedSkills: ['crm-core', 'crm-record-change'],
  prePinnedContext: {
    defaultObjectApiName: 'Case',
    defaultAction: 'CREATE',
    formContextEntry: 'STANDARD',
    allowAttachments: true,
  },
  welcomeMessage: '请描述你要新建的单据。',
};

const skillRows = [
  { name: 'crm-core', description: 'CRM 通用运行指导', source: 'builtin', invocation: { modelInvocable: true } },
  { name: 'crm-record-change', description: '记录变更安全执行', source: 'builtin', invocation: { modelInvocable: true } },
];

function fakeSkills() {
  return {
    async list() {
      return skillRows;
    },
    async get(name) {
      const row = skillRows.find((item) => item.name === name);
      if (row === undefined) return undefined;
      return { ...row, content: `BODY-OF-${name}` };
    },
  };
}

const authNormal = {
  authenticated: true,
  platformUserId: 'user-1',
  crmUsername: '张三',
  canManageStandardScenario: false,
};

const authManager = {
  authenticated: true,
  platformUserId: 'user-admin',
  crmUsername: '管理员',
  canManageStandardScenario: true,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function remoteScenario(overrides = {}) {
  const bytes = Buffer.from('DOCX-BYTES');
  return {
    scenarioId: 'crm_std_visit',
    title: '客户拜访纪要（公司标准）',
    description: '公司统一的拜访流程：先确认对象与目的，再按模板产出纪要。',
    category: '客户管理',
    status: 'PUBLISHED',
    version: '1.1.0',
    revision: 3,
    createdByPlatformUid: 'platform-1',
    createdByCrmUser: '销售运营部',
    updatedAt: '2026-11-13T08:00:00.000Z',
    scenarioPayload: {
      pinnedSkills: ['crm-core'],
      welcomeMessage: '请描述本次拜访的对象与目的。',
      inputDraft: '拜访对象：\n拜访目的：\n关键结论：',
      prePinnedContext: {
        defaultAction: 'CREATE',
        formContextEntry: 'STANDARD',
        allowAttachments: true,
      },
    },
    presetAttachments: [
      {
        attachmentId: 'att_std_template',
        fileName: '拜访纪要标准模板.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSize: bytes.byteLength,
        sha256: sha256Hex(bytes),
        downloadUrl: '/api/dsh/scenarios/crm_std_visit/attachments/att_std_template',
      },
    ],
    ...overrides,
  };
}

function createFakeMcp({ auth = authNormal, scenarios = [], deletedScenarioIds = [], downloads = {} } = {}) {
  const state = {
    auth: { ...auth },
    scenarios: new Map(),
    deleted: [...deletedScenarioIds],
    calls: { permission: 0, list: 0, create: [], update: [], delete: [], upload: [], deleteAttachment: [], download: [] },
    downloads: new Map(Object.entries(downloads)),
  };
  for (const item of scenarios) state.scenarios.set(item.scenarioId, clone(item));

  function bump(scenarioId, patch = {}) {
    const current = state.scenarios.get(scenarioId);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    if (patch.scenarioPayload !== undefined) {
      next.scenarioPayload = { ...(current.scenarioPayload ?? {}), ...patch.scenarioPayload };
    }
    const parts = String(next.version ?? '1.0.0').split('.').map((part) => Number(part) || 0);
    parts[2] += 1;
    next.version = parts.join('.');
    next.revision = (Number(current.revision) || 0) + 1;
    next.updatedAt = new Date().toISOString();
    state.scenarios.set(scenarioId, next);
    return next;
  }

  const registry = {
    apiBaseUrl: DEFAULT_MCP_API_BASE_URL,
    endpoint: DEFAULT_MCP_API_BASE_URL,
    configured: () => true,
    getAuth: () => ({ ...state.auth }),
    async getPermission() {
      state.calls.permission += 1;
      return { ok: true, auth: { ...state.auth } };
    },
    async listScenarios() {
      state.calls.list += 1;
      return {
        ok: true,
        auth: { ...state.auth },
        scenarios: [...state.scenarios.values()].map(clone),
        deletedScenarioIds: [...state.deleted],
      };
    },
    async createScenario(payload) {
      state.calls.create.push(clone(payload));
      const scenario = {
        ...clone(payload),
        version: '1.0.0',
        revision: 1,
        status: payload.status ?? 'PUBLISHED',
        createdByCrmUser: '张三',
        updatedAt: new Date().toISOString(),
        presetAttachments: [],
      };
      state.scenarios.set(scenario.scenarioId, scenario);
      return { ok: true, auth: { ...state.auth }, scenario: clone(scenario) };
    },
    async updateScenario(scenarioId, payload) {
      state.calls.update.push({ scenarioId, payload: clone(payload) });
      const next = bump(scenarioId, clone(payload));
      if (next === undefined) {
        return { ok: false, status: 404, message: 'not found' };
      }
      return { ok: true, auth: { ...state.auth }, scenario: clone(next) };
    },
    async deleteScenario(scenarioId) {
      state.calls.delete.push(scenarioId);
      if (!state.deleted.includes(scenarioId)) state.deleted.push(scenarioId);
      state.scenarios.delete(scenarioId);
      return {
        ok: true,
        auth: { ...state.auth },
        deleted: true,
        scenarioId,
        revision: 1,
        deletedScenarioIds: [...state.deleted],
      };
    },
    async uploadAttachment(scenarioId, input) {
      state.calls.upload.push({ scenarioId, input: clone(input) });
      const bytes = Buffer.from(input.contentBase64, 'base64');
      const attachmentId = `att_remote_${state.calls.upload.length}`;
      const attachment = {
        attachmentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: bytes.byteLength,
        sha256: input.sha256,
        downloadUrl: `/api/dsh/scenarios/${scenarioId}/attachments/${attachmentId}`,
      };
      state.downloads.set(attachmentId, bytes);
      const current = state.scenarios.get(scenarioId);
      const next = bump(scenarioId, {
        presetAttachments: [...(current?.presetAttachments ?? []), attachment],
      });
      return { ok: true, auth: { ...state.auth }, scenario: clone(next), attachment };
    },
    async deleteAttachment(scenarioId, attachmentId) {
      state.calls.deleteAttachment.push({ scenarioId, attachmentId });
      const current = state.scenarios.get(scenarioId);
      const next = bump(scenarioId, {
        presetAttachments: (current?.presetAttachments ?? []).filter(
          (item) => item.attachmentId !== attachmentId,
        ),
      });
      return { ok: true, auth: { ...state.auth }, scenario: clone(next) };
    },
    async downloadAttachment(url) {
      state.calls.download.push(url);
      const attachmentId = String(url).split('/').pop();
      const bytes = state.downloads.get(attachmentId) ?? Buffer.from('REMOTE-BYTES');
      return {
        ok: true,
        buffer: bytes,
        mimeType: 'application/octet-stream',
        sha256: sha256Hex(bytes),
        headerSha256: sha256Hex(bytes),
      };
    },
    state,
    bump,
  };
  return registry;
}

async function makeApi(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'crm-workspace-api-'));
  const store = createStateStore({ dataDir });
  await store.ready();
  const config = {
    apiBaseUrl: DEFAULT_MCP_API_BASE_URL,
    authMode: 'buntu',
    injectSkillsOnStep: true,
    registerSlashCommands: true,
    showSidebarEntry: true,
    maxScenarioCards: 200,
    ...overrides.config,
  };
  const changes = [];
  const assets = createAssetStore({ dir: join(dataDir, 'attachments') });
  const registry = overrides.registry ?? createFakeMcp();
  const api = createApi({
    store,
    config,
    assets,
    registry,
    getSkills: overrides.getSkills ?? fakeSkills,
    getCurrentUser: overrides.getCurrentUser ?? (async () => '张三'),
    onChange: (type) => changes.push(type),
  });
  return { api, store, config, changes, dataDir, assets, registry };
}

async function seedScenario(api) {
  const saved = await api.saveScenario({ draft: baseDraft });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return saved.card;
}

test('新建场景后 bootstrap 能读到，并带上分类/图标等词表', async () => {
  const { api } = await makeApi();
  const card = await seedScenario(api);
  assert.equal(card.scenarioId, 'crm_crm');
  assert.equal(card.prePinnedContext.defaultAction, 'CREATE');
  assert.equal(card.sourceType, 'LOCAL_CUSTOM');

  const boot = await api.bootstrap({});
  assert.equal(boot.plugin.id, 'crm-workspace');
  assert.equal(boot.scenarios.length, 1);
  assert.equal(boot.installedScenarios.length, 1);
  assert.deepEqual(boot.companyStandardScenarios, []);
  assert.equal(boot.taxonomy.actions.length, 3);
  assert.equal(boot.taxonomy.icons.length, 12);
  assert.equal(boot.limits.description, 4000);
  assert.equal(boot.config.apiBaseUrl, DEFAULT_MCP_API_BASE_URL);
  assert.equal(boot.auth.canManageStandardScenario, false);
});

test('校验失败时返回字段级错误，且不写入存档', async () => {
  const { api, store, changes } = await makeApi();
  const result = await api.saveScenario({ draft: { ...baseDraft, description: '' } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'description'));
  assert.deepEqual(store.scenarios(), []);
  assert.deepEqual(changes, []);
});

test('Skill 仓库里不存在的标识会作为警告返回，但仍可保存', async () => {
  const { api } = await makeApi();
  const result = await api.saveScenario({ draft: { ...baseDraft, pinnedSkills: ['crm-core', 'nope'] } });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /nope/.test(warning.message)));
});

test('激活场景后默认只注入技能名称，不带技能介绍与正文', async () => {
  const { api } = await makeApi();
  await seedScenario(api);

  const activated = await api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm' });
  assert.equal(activated.ok, true);
  assert.deepEqual(activated.skills.map((skill) => skill.name), ['crm-core', 'crm-record-change']);

  const first = await api.prepareInjection('s1');
  assert.equal(first.mode, 'names');
  assert.ok(first.text.includes('1. crm-core'));
  assert.ok(!first.text.includes('BODY-OF-crm-core'));
  assert.ok(!first.text.includes('CRM 通用运行指导'));
  assert.ok([...first.text].length < 1500);

  const second = await api.prepareInjection('s1');
  assert.equal(second.mode, 'names');
  assert.ok(!second.text.includes('BODY-OF-crm-core'));

  const state = await api.activationState({ sessionId: 's1' });
  assert.equal(state.scenario.scenarioId, 'crm_crm');
});

test('显式打开 injectSkillBodies 后首次注入全文、之后只提醒', async () => {
  const { api } = await makeApi({ config: { injectSkillBodies: true } });
  await seedScenario(api);
  await api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm' });

  const first = await api.prepareInjection('s1');
  assert.equal(first.mode, 'full');
  assert.ok(first.text.includes('BODY-OF-crm-core'));

  const second = await api.prepareInjection('s1');
  assert.equal(second.mode, 'reminder');
  assert.ok(!second.text.includes('BODY-OF-crm-core'));
});

test('未激活的会话不注入，关闭开关后也不注入', async () => {
  const { api } = await makeApi();
  await seedScenario(api);
  assert.equal(await api.prepareInjection('idle'), undefined);

  const off = await makeApi({ config: { injectSkillsOnStep: false } });
  await seedScenario(off.api);
  await off.api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm' });
  assert.equal(await off.api.prepareInjection('s1'), undefined);
});

test('卡片被删除后注入会清理悬空激活', async () => {
  const { api, store } = await makeApi();
  await seedScenario(api);
  await api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm' });
  await api.deleteScenario({ scenarioId: 'crm_crm' });
  assert.equal(store.activation('s1'), undefined);
  assert.equal(await api.prepareInjection('s1'), undefined);
});

test('停用的卡片不能由指令唤醒，但面板仍可进入', async () => {
  const { api } = await makeApi();
  await seedScenario(api);
  await api.setScenarioEnabled({ scenarioId: 'crm_crm', enabled: false });

  const fromCommand = await api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm', source: 'command' });
  assert.equal(fromCommand.ok, false);
  assert.match(fromCommand.message, /已停用/);

  const fromUi = await api.activateScenario({ sessionId: 's1', scenarioId: 'crm_crm', source: 'ui' });
  assert.equal(fromUi.ok, true);
});

test('不存在的场景与缺少会话标识都返回明确错误', async () => {
  const { api } = await makeApi();
  assert.equal((await api.activateScenario({ sessionId: 's1', scenarioId: 'ghost' })).ok, false);
  assert.equal((await api.activateScenario({ scenarioId: 'ghost' })).ok, false);
  assert.equal((await api.deleteScenario({ scenarioId: 'ghost' })).ok, false);
  assert.equal((await api.previewInjection({ scenarioId: 'ghost' })).ok, false);
});

test('复制、移动、启停与删除都作用在存档上', async () => {
  const { api, changes } = await makeApi();
  await seedScenario(api);
  const copy = await api.duplicateScenario({ scenarioId: 'crm_crm' });
  assert.equal(copy.ok, true);
  assert.notEqual(copy.card.scenarioId, 'crm_crm');
  assert.notEqual(copy.card.slashCommand, '/record');
  assert.equal(copy.card.sourceType, 'LOCAL_CUSTOM');

  const moved = await api.moveScenario({ scenarioId: copy.card.scenarioId, direction: 'up' });
  assert.equal(moved.ok, true);
  const boot = await api.bootstrap({});
  assert.equal(boot.scenarios[0].scenarioId, copy.card.scenarioId);

  assert.equal((await api.setScenarioEnabled({ scenarioId: copy.card.scenarioId, enabled: false })).ok, true);
  assert.equal((await api.deleteScenario({ scenarioId: copy.card.scenarioId })).ok, true);
  assert.ok(changes.includes('scenario.saved'));
  assert.ok(changes.includes('scenario.deleted'));
});

test('预览默认与真实注入一致：只有名称，不含正文', async () => {
  const { api } = await makeApi();
  await seedScenario(api);
  const preview = await api.previewInjection({ scenarioId: 'crm_crm' });
  assert.equal(preview.mode, 'names');
  assert.ok(!preview.text.includes('BODY-OF-crm-core'));
  assert.ok(preview.text.includes('1. crm-core'));
  assert.deepEqual(preview.skills.map((skill) => skill.name), ['crm-core', 'crm-record-change']);
  assert.ok(preview.characters > 0);

  const bodies = await makeApi({ config: { injectSkillBodies: true, injectSkillDescriptions: true } });
  await seedScenario(bodies.api);
  const full = await bodies.api.previewInjection({ scenarioId: 'crm_crm', mode: 'full' });
  assert.equal(full.mode, 'full');
  assert.ok(full.text.includes('BODY-OF-crm-core'));
  assert.ok(full.text.includes('CRM 通用运行指导'));
  assert.ok(full.skills[0].characters > 0);

  const reminder = await bodies.api.previewInjection({ scenarioId: 'crm_crm', mode: 'reminder' });
  assert.equal(reminder.mode, 'reminder');
  assert.ok(!reminder.text.includes('BODY-OF-crm-core'));
});

test('Skill 服务不可用时面板照常打开', async () => {
  const { api } = await makeApi({
    getSkills: () => {
      throw new Error('service missing');
    },
  });
  const boot = await api.bootstrap({});
  assert.equal(boot.ok, true);
  assert.deepEqual((await api.listSkills({})).skills, []);
  assert.equal((await api.saveScenario({ draft: baseDraft })).ok, true);
});

test('skills.list 支持按关键词过滤', async () => {
  const { api } = await makeApi();
  const all = await api.listSkills({ query: '' });
  assert.equal(all.skills.length, 2);
  const filtered = await api.listSkills({ query: 'record' });
  assert.equal(filtered.skills.length, 1);
  assert.equal(filtered.skills[0].name, 'crm-record-change');
});

/* ── MCP 契约：默认地址、身份头、双向映射、红色字段 ───────────────── */

test('默认请求地址是 crmmcptest.runner-corp.com.cn:9000，并携带 Buntu Token 双头', async () => {
  assert.equal(DEFAULT_MCP_API_BASE_URL, 'http://crmmcptest.runner-corp.com.cn:9000');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        auth: { authenticated: true, platformUserId: 'u1', crmUsername: '张三', canManageStandardScenario: true },
        scenarios: [],
        deletedScenarioIds: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const registry = createRegistry({ getToken: async () => 'buntu-token', fetchImpl });
  assert.equal(registry.apiBaseUrl, 'http://crmmcptest.runner-corp.com.cn:9000');
  const result = await registry.listScenarios();
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://crmmcptest.runner-corp.com.cn:9000/api/dsh/scenarios?includeDeleted=true');
  assert.equal(calls[0].init.headers.authorization, 'Bearer buntu-token');
  assert.equal(calls[0].init.headers['x-buntu-token'], 'buntu-token');
});

test('internal_bearer 模式发送 MCP Token 与平台用户头', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        authenticated: true,
        platformUserId: '42',
        crmUsername: '李四',
        canManageStandardScenario: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const registry = createRegistry({
    apiBaseUrl: 'http://crmmcptest.runner-corp.com.cn:9000/',
    authMode: 'internal_bearer',
    mcpClientToken: 'mcp-client-token',
    platformUserId: '42',
    getToken: async () => 'ignored-user-token',
    fetchImpl,
  });
  assert.equal(registry.apiBaseUrl, 'http://crmmcptest.runner-corp.com.cn:9000');
  const permission = await registry.getPermission();
  assert.equal(permission.ok, true);
  assert.equal(calls[0].url, 'http://crmmcptest.runner-corp.com.cn:9000/api/dsh/scenarios/permission');
  assert.equal(calls[0].init.headers.authorization, 'Bearer mcp-client-token');
  assert.equal(calls[0].init.headers['x-sfoa-platform-user'], '42');
  assert.equal(calls[0].init.headers['x-buntu-token'], undefined);
});

test('服务端 400 错误保留 code 与 correlationId', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        code: 'DSH_SCENARIO_INPUT_INVALID',
        message: 'version is not allowed',
        correlationId: 'cid-123',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  const registry = createRegistry({ getToken: async () => 't', fetchImpl });
  const result = await registry.createScenario({ scenarioId: 'crm_x' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'DSH_SCENARIO_INPUT_INVALID');
  assert.equal(result.correlationId, 'cid-123');
});

test('8 个 /api/dsh 接口的方法、路径与请求体契约', async () => {
  const bytes = Buffer.from('PDF-BYTES');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, body });
    const path = new URL(url).pathname;
    if (path.includes('/attachments/') && init.method === 'GET') {
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'x-sfoa-content-sha256': sha256Hex(bytes),
        },
      });
    }
    if (path.endsWith('/permission')) {
      return new Response(JSON.stringify(authManager), { status: 200 });
    }
    if (path.endsWith('/scenarios') && init.method === 'GET') {
      return new Response(
        JSON.stringify({ auth: authManager, scenarios: [], deletedScenarioIds: [] }),
        { status: 200 },
      );
    }
    if (path.endsWith('/scenarios') && init.method === 'POST') {
      return new Response(JSON.stringify({ auth: authManager, scenario: { scenarioId: 'crm_x' } }), { status: 201 });
    }
    if (init.method === 'PUT') {
      return new Response(JSON.stringify({ auth: authManager, scenario: { scenarioId: 'crm_x', version: '1.0.1' } }), { status: 200 });
    }
    if (init.method === 'DELETE') {
      return new Response(
        JSON.stringify({ auth: authManager, deleted: true, scenarioId: 'crm_x', revision: 2, deletedScenarioIds: ['crm_x'] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ auth: authManager, scenario: {}, attachment: { attachmentId: 'att_1' } }), { status: 200 });
  };

  const registry = createRegistry({ getToken: async () => 't', fetchImpl });
  await registry.listScenarios();
  await registry.getPermission();
  const created = await registry.createScenario({
    scenarioId: 'crm_x',
    title: '标题',
    category: '分类',
    description: '说明',
    scenarioPayload: { pinnedSkills: [] },
  });
  const updated = await registry.updateScenario('crm_x', { title: '新标题' });
  await registry.deleteScenario('crm_x');
  await registry.uploadAttachment('crm_x', {
    fileName: '模板.pdf',
    mimeType: 'application/pdf',
    contentBase64: bytes.toString('base64'),
    sha256: sha256Hex(bytes),
  });
  await registry.deleteAttachment('crm_x', 'att_1');
  const downloaded = await registry.downloadAttachment('/api/dsh/scenarios/crm_x/attachments/att_1');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`),
    [
      'GET /api/dsh/scenarios?includeDeleted=true',
      'GET /api/dsh/scenarios/permission',
      'POST /api/dsh/scenarios',
      'PUT /api/dsh/scenarios/crm_x',
      'DELETE /api/dsh/scenarios/crm_x',
      'POST /api/dsh/scenarios/crm_x/attachments',
      'DELETE /api/dsh/scenarios/crm_x/attachments/att_1',
      'GET /api/dsh/scenarios/crm_x/attachments/att_1',
    ],
  );
  assert.equal(created.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(updated.scenario.version, '1.0.1');
  assert.deepEqual(calls[2].body.scenarioPayload, { pinnedSkills: [] });
  assert.equal('version' in calls[2].body, false);
  assert.equal('revision' in calls[2].body, false);
  assert.equal('scenarioId' in calls[3].body, false);
  assert.deepEqual(calls[5].body, {
    fileName: '模板.pdf',
    mimeType: 'application/pdf',
    contentBase64: bytes.toString('base64'),
    sha256: sha256Hex(bytes),
  });
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.buffer.toString(), 'PDF-BYTES');
  assert.equal(downloaded.sha256, sha256Hex(bytes));
});

test('toRemoteWritePayload 产出嵌套 scenarioPayload，且绝不携带 version/revision', () => {
  const local = {
    scenarioId: 'crm_std_visit',
    title: '拜访',
    category: '客户管理',
    description: '说明',
    status: 'PUBLISHED',
    version: '9.9.9',
    revision: 88,
    createdAt: 'x',
    updatedAt: 'y',
    presetAttachments: [{ attachmentId: 'att_a' }],
    pinnedSkills: ['crm-core'],
    welcomeMessage: '欢迎',
    inputDraft: '草稿',
    prePinnedContext: { defaultAction: 'CREATE', formContextEntry: 'STANDARD', allowAttachments: true },
    scenarioPayload: {
      version: '1.1.1',
      revision: 5,
      createdAt: 'z',
      updatedAt: 'w',
      presetAttachments: [],
    },
  };

  const post = toRemoteWritePayload(local, false);
  assert.equal(post.scenarioId, 'crm_std_visit');
  assert.deepEqual(Object.keys(post).sort(), ['category', 'description', 'scenarioId', 'scenarioPayload', 'status', 'title']);
  assert.deepEqual(post.scenarioPayload.pinnedSkills, ['crm-core']);
  assert.equal(post.scenarioPayload.sourceType, 'COMPANY_STANDARD');
  assert.equal(post.scenarioPayload.readonlyForNormalUser, true);
  const serialized = JSON.stringify(post);
  for (const forbidden of ['"version"', '"revision"', '"createdAt"', '"updatedAt"', '"presetAttachments"']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} 不应出现在写请求里`);
  }

  const put = toRemoteWritePayload(local, true);
  assert.equal('scenarioId' in put, false);
  assert.equal('version' in put, false);
  assert.equal('revision' in put, false);
});

test('fromRemoteScenario 展平 scenarioPayload、标记只读并拼接附件下载地址', () => {
  const card = fromRemoteScenario(remoteScenario(), DEFAULT_MCP_API_BASE_URL);
  assert.equal(card.scenarioId, 'crm_std_visit');
  assert.equal(card.title, '客户拜访纪要（公司标准）');
  assert.equal(card.sourceType, 'COMPANY_STANDARD');
  assert.equal(card.readonlyForNormalUser, true);
  assert.equal(card.isStandardPublished, true);
  assert.equal(card.version, '1.1.0');
  assert.equal(card.revision, 3);
  assert.deepEqual(card.pinnedSkills, ['crm-core']);
  assert.equal(card.inputDraft, '拜访对象：\n拜访目的：\n关键结论：');
  assert.equal(card.presetAttachments[0].role, 'SCENARIO_PRESET');
  assert.equal(
    card.presetAttachments[0].localPathOrUrl,
    'http://crmmcptest.runner-corp.com.cn:9000/api/dsh/scenarios/crm_std_visit/attachments/att_std_template',
  );
});

/* ── 权限与标准场景写路径 ─────────────────────────────────────── */

test('canManageStandardScenario=false：标准场景只读、可复制为本地场景并可自由编辑', async () => {
  const registry = createFakeMcp({
    auth: authNormal,
    scenarios: [remoteScenario()],
    downloads: { att_std_template: Buffer.from('DOCX-BYTES') },
  });
  const { api, store } = await makeApi({ registry });
  const installed = await api.installCompanyScenario({ scenarioId: 'crm_std_visit' });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.card.sourceType, 'COMPANY_STANDARD');
  assert.equal(installed.card.readonlyForNormalUser, true);

  const deniedEdit = await api.saveScenario({
    draft: { ...installed.card, title: '偷偷改标题' },
    previousId: 'crm_std_visit',
  });
  assert.equal(deniedEdit.ok, false);
  assert.match(deniedEdit.message, /没有管理公司标准场景的权限/);
  assert.equal(store.findScenario('crm_std_visit').title, '客户拜访纪要（公司标准）');
  assert.equal(registry.state.calls.update.length, 0);

  const deniedDelete = await api.deleteScenario({ scenarioId: 'crm_std_visit' });
  assert.equal(deniedDelete.ok, false);
  assert.match(deniedDelete.message, /没有管理公司标准场景的权限/);
  assert.equal(registry.state.calls.delete.length, 0);

  const forked = await api.forkStandardToLocalScenario({ scenarioId: 'crm_std_visit' });
  assert.equal(forked.ok, true, JSON.stringify(forked));
  assert.equal(forked.card.sourceType, 'LOCAL_CUSTOM');
  assert.equal(forked.card.readonlyForNormalUser, false);
  assert.equal(forked.card.isStandardPublished, false);
  assert.match(forked.card.scenarioId, /^crm_std_visit-copy-/);
  assert.match(forked.card.title, /\(本地副本\)$/);
  assert.equal(forked.card.presetAttachments.length, 1);
  assert.match(forked.card.presetAttachments[0].localPathOrUrl, /\.docx$/);

  const edited = await api.saveScenario({
    draft: { ...forked.card, title: '我的拜访流程' },
    previousId: forked.card.scenarioId,
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.card.title, '我的拜访流程');
  assert.equal(edited.card.sourceType, 'LOCAL_CUSTOM');
});

test('canManageStandardScenario=true：可创建、编辑（服务端升版）与软删除标准场景', async () => {
  const registry = createFakeMcp({ auth: authManager, scenarios: [] });
  const { api, store } = await makeApi({ registry });

  const created = await api.saveScenario({
    draft: {
      ...baseDraft,
      scenarioId: 'crm_std_new',
      slashCommand: '/std-new',
      sourceType: 'COMPANY_STANDARD',
      isStandardPublished: true,
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(registry.state.calls.create.length, 1);
  const createPayload = registry.state.calls.create[0];
  assert.equal(createPayload.scenarioId, 'crm_std_new');
  assert.equal(JSON.stringify(createPayload).includes('"version"'), false);
  assert.equal(created.card.sourceType, 'COMPANY_STANDARD');
  assert.equal(created.card.readonlyForNormalUser, true);
  assert.equal(created.card.version, '1.0.0');
  assert.equal(created.card.revision, 1);
  assert.equal(store.findScenario('crm_std_new').sourceType, 'COMPANY_STANDARD');

  const updated = await api.saveScenario({
    draft: { ...created.card, title: '标准场景新标题' },
    previousId: 'crm_std_new',
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(registry.state.calls.update.length, 1);
  assert.equal(registry.state.calls.update[0].scenarioId, 'crm_std_new');
  assert.equal('scenarioId' in registry.state.calls.update[0].payload, false);
  assert.equal(JSON.stringify(registry.state.calls.update[0].payload).includes('"revision"'), false);
  assert.equal(updated.card.title, '标准场景新标题');
  assert.equal(updated.card.version, '1.0.1');
  assert.equal(updated.card.revision, 2);
  assert.equal(store.findScenario('crm_std_new').version, '1.0.1');

  const removed = await api.deleteScenario({ scenarioId: 'crm_std_new' });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.remote, true);
  assert.deepEqual(registry.state.calls.delete, ['crm_std_new']);
  assert.equal(store.findScenario('crm_std_new'), undefined);
  assert.ok(store.deletedScenarioIds().includes('crm_std_new'));
});

test('标准场景编辑会调用附件上传/删除接口，并在服务端升版后同步本地', async () => {
  const registry = createFakeMcp({ auth: authManager, scenarios: [] });
  const { api, assets } = await makeApi({ registry });

  const uploaded = await api.saveAttachment({
    fileName: '标准模板.docx',
    dataBase64: Buffer.from('STD-BYTES').toString('base64'),
  });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));

  const created = await api.saveScenario({
    draft: {
      ...baseDraft,
      scenarioId: 'crm_std_attach',
      slashCommand: '/std-attach',
      sourceType: 'COMPANY_STANDARD',
      presetAttachments: [uploaded.attachment],
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(registry.state.calls.upload.length, 1);
  assert.equal(registry.state.calls.upload[0].input.fileName, '标准模板.docx');
  assert.equal(registry.state.calls.upload[0].input.sha256, sha256Hex(Buffer.from('STD-BYTES')));
  assert.equal(created.card.presetAttachments.length, 1);
  assert.equal(assets.exists(created.card.presetAttachments[0].localPathOrUrl), true);

  const removed = await api.saveScenario({
    draft: { ...created.card, presetAttachments: [] },
    previousId: 'crm_std_attach',
  });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(registry.state.calls.deleteAttachment.length, 1);
  assert.equal(registry.state.calls.deleteAttachment[0].attachmentId, 'att_remote_1');
  assert.equal(removed.card.presetAttachments.length, 0);
  assert.equal(removed.card.version, '1.0.3');
  assert.equal(removed.card.revision, 4);
});

test('没有管理权限时勾选标准场景只保存为本地副本', async () => {
  const registry = createFakeMcp({ auth: authNormal, scenarios: [] });
  const { api } = await makeApi({ registry });
  const saved = await api.saveScenario({
    draft: { ...baseDraft, sourceType: 'COMPANY_STANDARD', isStandardPublished: true },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.card.sourceType, 'LOCAL_CUSTOM');
  assert.equal(saved.card.isStandardPublished, false);
  assert.equal(registry.state.calls.create.length, 0);
  assert.match(saved.publish.message, /没有管理公司标准场景的权限/);
});

/* ── 自动升级 / 下架卸载 / 双页签隔离 ─────────────────────────── */

test('远端 revision/version 升高时静默升级本地已安装标准场景与变更附件', async () => {
  const initialBytes = Buffer.from('DOCX-BYTES');
  const nextBytes = Buffer.from('DOCX-BYTES-V2');
  const registry = createFakeMcp({
    auth: authNormal,
    scenarios: [remoteScenario()],
    downloads: { att_std_template: initialBytes },
  });
  const { api, store, assets } = await makeApi({ registry });

  const installed = await api.installCompanyScenario({ scenarioId: 'crm_std_visit' });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const localBefore = store.findScenario('crm_std_visit');
  assert.equal(localBefore.version, '1.1.0');
  assert.equal(localBefore.revision, 3);
  assert.equal((await assets.read(localBefore.presetAttachments[0].localPathOrUrl)).buffer.toString(), 'DOCX-BYTES');

  // 远端升级 + 新增一个「未安装」的标准场景：只应出现在公司页签缓存，不自动安装。
  const remote = registry.state.scenarios.get('crm_std_visit');
  remote.title = '客户拜访纪要（公司标准 v2）';
  remote.version = '1.2.0';
  remote.revision = 4;
  remote.presetAttachments[0].sha256 = sha256Hex(nextBytes);
  registry.state.downloads.set('att_std_template', nextBytes);
  registry.state.scenarios.set(
    'crm_std_new_remote',
    remoteScenario({
      scenarioId: 'crm_std_new_remote',
      title: '远端新场景',
      presetAttachments: [],
    }),
  );

  const synced = await api.syncCompanyScenarios();
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.equal(synced.upgraded.length, 1);
  assert.equal(synced.upgraded[0].fromVersion, '1.1.0');
  assert.equal(synced.upgraded[0].toVersion, '1.2.0');

  const localAfter = store.findScenario('crm_std_visit');
  assert.equal(localAfter.title, '客户拜访纪要（公司标准 v2）');
  assert.equal(localAfter.version, '1.2.0');
  assert.equal(localAfter.revision, 4);
  assert.equal((await assets.read(localAfter.presetAttachments[0].localPathOrUrl)).buffer.toString(), 'DOCX-BYTES-V2');

  // 新发布场景只在公司页签，不能自动进入「已安装」。
  assert.equal(store.findScenario('crm_std_new_remote'), undefined);
  assert.ok(store.findCompanyScenario('crm_std_new_remote') !== undefined);

  const boot = await api.bootstrap({});
  assert.equal(boot.installedScenarios.filter((card) => card.sourceType === 'COMPANY_STANDARD').length, 1);
  assert.equal(boot.companyStandardScenarios.length, 2);
});

test('远端版本升级但附件 sha256 未变时复用本地缓存、不重复下载', async () => {
  const registry = createFakeMcp({
    auth: authNormal,
    scenarios: [remoteScenario()],
    downloads: { att_std_template: Buffer.from('DOCX-BYTES') },
  });
  const { api, store } = await makeApi({ registry });
  await api.installCompanyScenario({ scenarioId: 'crm_std_visit' });
  const downloadsAfterInstall = registry.state.calls.download.length;
  assert.equal(downloadsAfterInstall, 1);

  const remote = registry.state.scenarios.get('crm_std_visit');
  remote.version = '1.1.1';
  remote.revision = 9;
  const synced = await api.syncCompanyScenarios();
  assert.equal(synced.upgraded.length, 1);
  assert.equal(registry.state.calls.download.length, downloadsAfterInstall);
  assert.equal(store.findScenario('crm_std_visit').version, '1.1.1');
});

test('reconcileInstalledStandardScenarios 是同步与自动升级的公开入口', async () => {
  const registry = createFakeMcp({ auth: authNormal, scenarios: [remoteScenario()] });
  const { api } = await makeApi({ registry });
  const result = await api.reconcileInstalledStandardScenarios();
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.scenarios), true);
});

test('删除附件与软删除场景会在同步时清理本地缓存并自动卸载', async () => {
  const registry = createFakeMcp({
    auth: authNormal,
    scenarios: [remoteScenario()],
    downloads: { att_std_template: Buffer.from('DOCX-BYTES') },
  });
  const { api, store, assets } = await makeApi({ registry });
  await api.installCompanyScenario({ scenarioId: 'crm_std_visit' });
  const local = store.findScenario('crm_std_visit');
  const cachedPath = local.presetAttachments[0].localPathOrUrl;
  assert.equal(assets.exists(cachedPath), true);

  // 1) 远端移除附件：同步后本地缓存也要删除。
  const remote = registry.state.scenarios.get('crm_std_visit');
  remote.version = '1.1.1';
  remote.revision = 5;
  remote.presetAttachments = [];
  await api.syncCompanyScenarios();
  const afterAttachmentRemoval = store.findScenario('crm_std_visit');
  assert.deepEqual(afterAttachmentRemoval.presetAttachments, []);
  assert.equal(assets.exists(cachedPath), false);

  // 2) 软删除：deletedScenarioIds 包含该场景 → 自动卸载。
  registry.state.deleted.push('crm_std_visit');
  const synced = await api.syncCompanyScenarios();
  assert.equal(synced.uninstalled.length, 1);
  assert.equal(store.findScenario('crm_std_visit'), undefined);
  assert.equal(store.findCompanyScenario('crm_std_visit'), undefined);
  assert.ok(store.deletedScenarioIds().includes('crm_std_visit'));
});

test('公司页签同步失败时不把远端场景塞进已安装列表', async () => {
  const registry = createFakeMcp({ auth: authNormal, scenarios: [] });
  registry.listScenarios = async () => ({
    ok: false,
    status: 502,
    message: 'upstream unavailable',
    correlationId: 'cid-9',
    scenarios: [],
    deletedScenarioIds: [],
    auth: { ...authNormal },
  });
  const { api, store } = await makeApi({ registry });
  const result = await api.listCompanyScenarios({});
  assert.equal(result.ok, false);
  assert.match(result.message, /upstream unavailable/);
  assert.deepEqual(store.scenarios(), []);
});

/* ── 预设附件 / 新会话契约 / 导出导入 ─────────────────────────── */

test('场景预设附件可上传，并可被写进卡片保存', async () => {
  const { api } = await makeApi();
  const uploaded = await api.saveAttachment({
    fileName: '拜访纪要标准模板.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from('DOCX-BYTES').toString('base64'),
  });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal(uploaded.attachment.role, 'SCENARIO_PRESET');
  assert.match(uploaded.attachment.localPathOrUrl, /^att_.*\.docx$/);
  assert.equal(uploaded.attachment.sha256, sha256Hex(Buffer.from('DOCX-BYTES')));
  assert.match(uploaded.attachment.url, /^\/crm-workspace\/asset\//);

  const saved = await api.saveScenario({
    draft: { ...baseDraft, presetAttachments: [uploaded.attachment] },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.card.presetAttachments.length, 1);
  assert.equal(saved.card.presetAttachments[0].role, 'SCENARIO_PRESET');
  assert.equal(saved.card.presetAttachments[0].sha256, uploaded.attachment.sha256);
});

test('saveAttachment 拒绝不支持的类型与空内容', async () => {
  const { api } = await makeApi();
  const wrongType = await api.saveAttachment({ fileName: 'setup.exe', dataBase64: 'AAAA' });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /不支持的附件类型/);

  const empty = await api.saveAttachment({ fileName: '模板.docx', dataBase64: '' });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /附件内容为空/);
});

test('activationState 返回输入框预填契约：inputDraft 优先，回退 welcomeMessage', async () => {
  const { api } = await makeApi();
  const withDraft = await api.saveScenario({
    draft: { ...baseDraft, inputDraft: '拜访对象：\n拜访目的：' },
  });
  assert.equal(withDraft.ok, true, JSON.stringify(withDraft));
  await api.activateScenario({ sessionId: 's-1', scenarioId: withDraft.card.scenarioId });

  const state = await api.activationState({ sessionId: 's-1' });
  assert.equal(state.draft.text, '拜访对象：\n拜访目的：');
  assert.equal(state.draft.source, 'inputDraft');
  assert.deepEqual(state.draft.attachments, []);
  assert.equal(state.scenario.version, '1.0.0');

  const fallback = await api.saveScenario({
    draft: { ...baseDraft, title: '无预填场景', slashCommand: '/fallback', inputDraft: '' },
  });
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  await api.activateScenario({ sessionId: 's-2', scenarioId: fallback.card.scenarioId });
  const fallbackState = await api.activationState({ sessionId: 's-2' });
  assert.equal(fallbackState.draft.text, baseDraft.welcomeMessage);
  assert.equal(fallbackState.draft.source, 'welcomeMessage');
});

test('activationState 把预设附件转成可拉取的下载地址', async () => {
  const { api } = await makeApi();
  const uploaded = await api.saveAttachment({
    fileName: '字段清单.csv',
    dataBase64: Buffer.from('a,b\n1,2').toString('base64'),
  });
  const saved = await api.saveScenario({
    draft: { ...baseDraft, presetAttachments: [uploaded.attachment] },
  });
  await api.activateScenario({ sessionId: 's-3', scenarioId: saved.card.scenarioId });
  const state = await api.activationState({ sessionId: 's-3' });
  assert.equal(state.draft.attachments.length, 1);
  assert.equal(state.draft.attachments[0].fileName, '字段清单.csv');
  assert.equal(state.draft.attachments[0].role, 'SCENARIO_PRESET');
  assert.match(state.draft.attachments[0].url, /^\/crm-workspace\/asset\//);
  assert.equal(state.draft.attachments[0].localPathOrUrl, undefined);
});

test('新会话 3 项带入的客户端契约：标识、引导语、预设附件', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('🟢 正在使用场景：【'));
  assert.ok(source.includes('(v${card.version ?? \'1.0.0\'})'));
  assert.ok(source.includes("callHost('activation.state'"));
  assert.ok(source.includes('inputActions.setDraft(text)'));
  assert.ok(source.includes('inputActions.addAttachments(ids)'));
  assert.ok(source.includes('复制为本地场景'));
  assert.ok(source.includes('设为插件标准场景'));
});

test('导出场景包内联附件与 sha256，导入后还原为新卡片且附件落盘', async () => {
  const { api } = await makeApi();
  const uploaded = await api.saveAttachment({
    fileName: '拜访纪要标准模板.docx',
    dataBase64: Buffer.from('DOCX-BYTES').toString('base64'),
  });
  const saved = await api.saveScenario({
    draft: { ...baseDraft, presetAttachments: [uploaded.attachment] },
  });

  const exported = await api.exportScenarioBundle({ scenarioId: saved.card.scenarioId });
  assert.equal(exported.ok, true);
  assert.equal(exported.fileName, `${saved.card.scenarioId}.crm-scenario.json`);
  assert.equal(exported.package.format, 'crm-scenario-package');
  assert.equal(exported.package.attachments.length, 1);
  assert.equal(exported.package.attachments[0].sha256, sha256Hex(Buffer.from('DOCX-BYTES')));
  assert.equal(
    Buffer.from(exported.package.attachments[0].dataBase64, 'base64').toString('utf8'),
    'DOCX-BYTES',
  );

  const { api: other, dataDir: otherDir } = await makeApi();
  const imported = await other.importScenario({ package: exported.package });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.imported, true);
  assert.equal(imported.card.sourceType, 'LOCAL_CUSTOM');
  const restored = imported.card.presetAttachments[0];
  assert.match(restored.localPathOrUrl, /^att_.*\.docx$/);
  const bytes = await readFile(join(otherDir, 'attachments', restored.localPathOrUrl));
  assert.equal(bytes.toString('utf8'), 'DOCX-BYTES');
});

test('公司页签的标准场景可下载到本地，附件通过 MCP 下载并内联', async () => {
  const registry = createFakeMcp({
    auth: authNormal,
    scenarios: [remoteScenario()],
    downloads: { att_std_template: Buffer.from('DOCX-BYTES') },
  });
  const { api } = await makeApi({ registry });
  await api.syncCompanyScenarios();
  const exported = await api.exportScenarioBundle({ scenarioId: 'crm_std_visit', source: 'company' });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.fileName, 'crm_std_visit.crm-scenario.json');
  assert.equal(exported.package.attachments[0].sha256, sha256Hex(Buffer.from('DOCX-BYTES')));
  assert.equal(
    Buffer.from(exported.package.attachments[0].dataBase64, 'base64').toString('utf8'),
    'DOCX-BYTES',
  );
});

test('导入拒绝格式不符的场景包', async () => {
  const { api } = await makeApi();
  const wrongFormat = await api.importScenario({ package: { format: 'other', scenario: {} } });
  assert.equal(wrongFormat.ok, false);
  assert.match(wrongFormat.message, /format 不匹配/);
  const missing = await api.importScenario({ package: { format: 'crm-scenario-package' } });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /缺少 scenario/);
});

test('创建人由宿主当前用户带出，且 bootstrap 下发当前用户与附件地址', async () => {
  const { api } = await makeApi({ getCurrentUser: async () => '李四' });
  const saved = await api.saveScenario({ draft: { ...baseDraft, author: '' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.card.author, '李四');

  const boot = await api.bootstrap({});
  assert.equal(boot.plugin.currentUser, '李四');
});

test('bootstrap 给预设附件补上可 GET 的 url，但存档里不写入该字段', async () => {
  const { api, store } = await makeApi();
  const uploaded = await api.saveAttachment({
    fileName: '巡查模板.docx',
    mimeType: '',
    dataBase64: Buffer.from('DOCX-BYTES').toString('base64'),
  });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  const saved = await api.saveScenario({
    draft: { ...baseDraft, presetAttachments: [uploaded.attachment] },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const boot = await api.bootstrap({});
  const card = boot.scenarios.find((item) => item.scenarioId === saved.card.scenarioId);
  assert.equal(card.presetAttachments.length, 1);
  assert.match(card.presetAttachments[0].url, /^\/crm-workspace\/asset\//);

  const stored = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(stored.scenarios[0].presetAttachments[0].url, undefined);
});

test('权限接口失败时默认拒绝标准场景管理', async () => {
  const registry = createFakeMcp({ auth: authManager, scenarios: [] });
  registry.getPermission = async () => ({
    ok: false,
    status: 503,
    message: 'permission service unavailable',
    auth: { authenticated: false, canManageStandardScenario: false },
  });
  const { api } = await makeApi({ registry });
  const result = await api.saveScenario({
    draft: { ...baseDraft, scenarioId: 'crm_std_x', sourceType: 'COMPANY_STANDARD' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.card.sourceType, 'LOCAL_CUSTOM');
  assert.ok(result.warnings === undefined || Array.isArray(result.warnings));
  assert.match(result.publish.message, /没有管理公司标准场景的权限/);
});
