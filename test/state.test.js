import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateStore } from '../lib/core/state.js';
import { sanitizeDoc } from '../lib/core/state.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'crm-workspace-state-'));
}

const card = {
  scenarioId: 'crm_case',
  title: 'CRM 单据新建与修改',
  description: '按单据类型新建或修改记录。',
  icon: 'briefcase',
  category: '核心单据管控',
  slashCommand: '/record',
  enabled: true,
  isSystemBase: false,
  pinnedSkills: ['crm-core'],
  prePinnedContext: { defaultAction: 'CREATE', formContextEntry: 'STANDARD', allowAttachments: true },
  welcomeMessage: '请描述你要新建的单据。',
};

test('首次启动生成空存档，写入后可以被新实例读回', async () => {
  const dataDir = await tempDir();
  const store = createStateStore({ dataDir });
  await store.ready();
  assert.deepEqual(store.scenarios(), []);
  assert.equal(store.degraded, undefined);

  await store.mutate((draft) => {
    draft.scenarios.push(card);
    draft.activations['session-1'] = {
      sessionId: 'session-1',
      scenarioId: 'crm_case',
      activatedAt: new Date().toISOString(),
      source: 'ui',
    };
    return { result: undefined };
  });

  const raw = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
  assert.equal(raw.scenarios.length, 1);
  assert.equal(raw.version, 1);

  const reopened = createStateStore({ dataDir });
  await reopened.ready();
  assert.equal(reopened.scenarios().length, 1);
  assert.equal(reopened.findScenario('crm_case').title, card.title);
  assert.equal(reopened.activation('session-1').scenarioId, 'crm_case');
});

test('reducer 返回 changed:false 时不落盘', async () => {
  const dataDir = await tempDir();
  const store = createStateStore({ dataDir });
  await store.ready();
  const before = await readFile(join(dataDir, 'state.json'), 'utf8').catch(() => undefined);
  const result = await store.mutate(() => ({ result: 'nothing', changed: false }));
  assert.equal(result, 'nothing');
  const after = await readFile(join(dataDir, 'state.json'), 'utf8').catch(() => undefined);
  assert.equal(after, before);
});

test('存档损坏时隔离原文件并进入只读模式', async () => {
  const dataDir = await tempDir();
  await writeFile(join(dataDir, 'state.json'), '{ 这不是 JSON', 'utf8');
  const store = createStateStore({ dataDir });
  await store.ready();

  assert.equal(typeof store.degraded, 'string');
  assert.deepEqual(store.scenarios(), []);
  const files = await readdir(dataDir);
  assert.ok(files.some((name) => name.startsWith('state.corrupt-')), `未隔离损坏文件：${files.join(',')}`);
  await assert.rejects(() => store.mutate(() => ({ result: undefined })), /只读|损坏|存档/);
});

test('存档版本高于插件版本时拒绝写入，避免降级覆盖', async () => {
  const dataDir = await tempDir();
  await writeFile(
    join(dataDir, 'state.json'),
    JSON.stringify({ version: 99, scenarios: [], activations: {} }),
    'utf8',
  );
  const store = createStateStore({ dataDir });
  await store.ready();
  assert.match(store.degraded, /99/);
  await assert.rejects(() => store.mutate(() => ({ result: undefined })));
});

test('sanitizeDoc 丢弃重复指令与不合法卡片，并清理过期激活', () => {
  const now = Date.now();
  const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(now).toISOString();
  const { doc, warnings } = sanitizeDoc({
    version: 1,
    scenarios: [card, { ...card, scenarioId: 'crm_two', title: '第二张', slashCommand: '/record' }, { title: '缺字段' }],
    activations: {
      old: { sessionId: 'old', scenarioId: 'crm_case', activatedAt: stale },
      keep: { sessionId: 'keep', scenarioId: 'crm_case', activatedAt: fresh },
      dangling: { sessionId: 'dangling', scenarioId: 'missing-card', activatedAt: fresh },
    },
  });
  assert.equal(doc.scenarios.length, 1);
  assert.equal(doc.scenarios[0].scenarioId, 'crm_case');
  assert.deepEqual(Object.keys(doc.activations), ['keep']);
  assert.ok(warnings.length >= 2);
});

test('激活记录数量超过上限时保留最新的', () => {
  const now = Date.now();
  const activations = {};
  for (let index = 0; index < 205; index += 1) {
    activations[`s-${index}`] = {
      sessionId: `s-${index}`,
      scenarioId: 'crm_case',
      activatedAt: new Date(now - index * 1000).toISOString(),
    };
  }
  const { doc } = sanitizeDoc({ version: 1, scenarios: [card], activations });
  assert.equal(Object.keys(doc.activations).length, 200);
  assert.ok(doc.activations['s-0'] !== undefined);
  assert.equal(doc.activations['s-204'], undefined);
});
