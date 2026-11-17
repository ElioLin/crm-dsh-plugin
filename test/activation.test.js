import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_IDLE_TTL_MS,
  ACTIVATION_TTL_MS,
  addScenario,
  describeActivation,
  findEntry,
  markInjected,
  normalizeActivation,
  pruneActivations,
  removeScenario,
  scenarioIds,
  syncPrimary,
} from '../lib/core/activation.js';

const NOW = Date.parse('2026-05-01T00:00:00.000Z');

function iso(msAgo = 0) {
  return new Date(NOW - msAgo).toISOString();
}

function legacyRecord(scenarioId = 'crm_a') {
  return { sessionId: 's1', scenarioId, activatedAt: iso(1000), source: 'ui' };
}

test('兼容旧存档：只有 scenarioId 的记录会被补成单元素场景栈', () => {
  const record = normalizeActivation('s1', legacyRecord('crm_a'), { now: NOW });
  assert.deepEqual(scenarioIds(record), ['crm_a']);
  assert.equal(record.scenarioId, 'crm_a');
  assert.equal(record.scenarios.length, 1);
  assert.equal(record.scenarios[0].injectionCount, 0);
  assert.equal(record.updatedAt, record.scenarios[0].activatedAt);
});

test('坏记录一律被丢弃，而不是抛错', () => {
  assert.equal(normalizeActivation('s1', null, { now: NOW }), undefined);
  assert.equal(normalizeActivation('s1', 'oops', { now: NOW }), undefined);
  assert.equal(normalizeActivation('s1', { activatedAt: iso(0) }, { now: NOW }), undefined);
  // 场景栈里混入坏条目时只丢那一条。
  const record = normalizeActivation(
    's1',
    { sessionId: 's1', scenarios: [{ scenarioId: 'crm_a', activatedAt: iso(0) }, { nope: true }, null] },
    { now: NOW },
  );
  assert.deepEqual(scenarioIds(record), ['crm_a']);
});

test('stack=false 替换整栈，stack=true 追加且保留已有注入进度', () => {
  let record = addScenario(undefined, { sessionId: 's1', scenarioId: 'crm_a', now: NOW });
  record = markInjected(record, 'crm_a', { mode: 'names', now: NOW });
  assert.equal(findEntry(record, 'crm_a').injectionCount, 1);

  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_b', now: NOW, replace: false });
  assert.deepEqual(scenarioIds(record), ['crm_a', 'crm_b']);
  assert.equal(record.scenarioId, 'crm_a');

  // 重复叠加同一张卡：不重复入栈，也不重置注入进度。
  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_a', now: NOW, replace: false });
  assert.deepEqual(scenarioIds(record), ['crm_a', 'crm_b']);
  assert.equal(findEntry(record, 'crm_a').injectionCount, 1);

  // replace=true（普通「进入场景」）会清空整栈，只留新卡。
  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_c', now: NOW });
  assert.deepEqual(scenarioIds(record), ['crm_c']);
});

test('移除单个场景：其余场景保留，栈空时整条记录消失', () => {
  let record = addScenario(undefined, { sessionId: 's1', scenarioId: 'crm_a', now: NOW });
  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_b', now: NOW, replace: false });
  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_c', now: NOW, replace: false });

  record = removeScenario(record, 'crm_b', { now: NOW });
  assert.deepEqual(scenarioIds(record), ['crm_a', 'crm_c']);
  // 移除的是栈首时，scenarioId 要跟着换到新的栈首（旧字段保持可用）。
  record = removeScenario(record, 'crm_a', { now: NOW });
  assert.equal(record.scenarioId, 'crm_c');
  assert.equal(removeScenario(record, 'crm_c', { now: NOW }), undefined);
});

test('清理：过期、闲置、悬空与超限分别计数', () => {
  const activations = {
    fresh: normalizeActivation('fresh', legacyRecord('crm_a'), { now: NOW }),
    expired: normalizeActivation('expired', { ...legacyRecord('crm_a'), activatedAt: iso(ACTIVATION_TTL_MS + 1000) }, { now: NOW }),
    idle: normalizeActivation('idle', { ...legacyRecord('crm_a'), activatedAt: iso(ACTIVATION_IDLE_TTL_MS + 1000) }, { now: NOW }),
    removedCard: normalizeActivation('removedCard', legacyRecord('crm_gone'), { now: NOW }),
  };
  const pruned = pruneActivations(activations, {
    now: NOW,
    ttlMs: ACTIVATION_TTL_MS,
    idleMs: ACTIVATION_IDLE_TTL_MS,
    max: 50,
    knownScenarioIds: new Set(['crm_a']),
  });
  assert.deepEqual(Object.keys(pruned.kept), ['fresh']);
  assert.equal(pruned.droppedFor.expired, 1);
  assert.equal(pruned.droppedFor.idle, 1);
  assert.equal(pruned.droppedFor.unknown, 1);
  assert.equal(pruned.removed.length, 3);
});

test('清理超限时保留最近更新的记录', () => {
  const activations = {};
  for (let index = 0; index < 6; index += 1) {
    const record = normalizeActivation(`s-${index}`, { ...legacyRecord('crm_a'), activatedAt: iso(index * 1000) }, { now: NOW });
    activations[`s-${index}`] = record;
  }
  const pruned = pruneActivations(activations, {
    now: NOW,
    ttlMs: ACTIVATION_TTL_MS,
    idleMs: ACTIVATION_IDLE_TTL_MS,
    max: 3,
    knownScenarioIds: new Set(['crm_a']),
  });
  assert.deepEqual(Object.keys(pruned.kept), ['s-0', 's-1', 's-2']);
  assert.equal(pruned.droppedFor.overflow, 3);
});

test('describeActivation 给人与诊断用的摘要', () => {
  let record = addScenario(undefined, { sessionId: 's1', scenarioId: 'crm_a', now: NOW });
  record = addScenario(record, { sessionId: 's1', scenarioId: 'crm_b', now: NOW, replace: false });
  record = markInjected(record, 'crm_a', { mode: 'names', now: NOW });
  assert.equal(describeActivation(record), 'crm_a（已注入 1 次） + crm_b（尚未注入）');
  assert.equal(describeActivation(undefined), '未激活');
  assert.equal(syncPrimary(record).scenarioId, 'crm_a');
});
