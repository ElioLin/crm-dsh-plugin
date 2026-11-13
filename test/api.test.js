import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../lib/core/api.js';
import { createStateStore } from '../lib/core/state.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function makeApi(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'crm-workspace-api-'));
  const store = createStateStore({ dataDir });
  await store.ready();
  const config = {
    injectSkillsOnStep: true,
    registerSlashCommands: true,
    showSidebarEntry: true,
    maxScenarioCards: 200,
    ...overrides.config,
  };
  const changes = [];
  const api = createApi({
    store,
    config,
    getSkills: overrides.getSkills ?? fakeSkills,
    onChange: (type) => changes.push(type),
  });
  return { api, store, config, changes, dataDir };
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

  const boot = await api.bootstrap({});
  assert.equal(boot.plugin.id, 'crm-workspace');
  assert.equal(boot.scenarios.length, 1);
  assert.equal(boot.taxonomy.actions.length, 3);
  assert.equal(boot.taxonomy.icons.length, 12);
  assert.equal(boot.limits.description, 2000);
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
