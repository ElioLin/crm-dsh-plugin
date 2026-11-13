import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coerceStoredScenario,
  deriveScenarioId,
  duplicateScenario,
  moveScenario,
  normalizeScenario,
  normalizeSlashCommand,
} from '../lib/core/schema.js';

const base = {
  title: 'CRM 单据新建与修改',
  description: '面向一线业务人员：按单据类型新建或修改记录，自动处理必填项与字段权限。',
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
  welcomeMessage: '请描述你要新建的单据类型与关键信息，我会先核对必填字段。',
};

test('合法配置被接受，并补全默认值', () => {
  const result = normalizeScenario(base, { existing: [], skillNames: ['crm-core', 'crm-record-change'] });
  assert.equal(result.ok, true);
  assert.equal(result.card.scenarioId, 'crm_crm'); // 标题含 ASCII，slug 取首段
  assert.equal(result.card.prePinnedContext.defaultAction, 'CREATE');
  assert.equal(result.card.prePinnedContext.allowAttachments, true);
  assert.equal(result.card.enabled, true);
  assert.equal(result.warnings.length, 0);
});

test('缺少场景介绍必须报错（该字段是卡片正文）', () => {
  const result = normalizeScenario({ ...base, description: '   ' }, { existing: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'description'));
});

test('缺少标题/分类/指令/开场语都会逐项报错', () => {
  const result = normalizeScenario(
    { ...base, title: '', category: '', slashCommand: '', welcomeMessage: '' },
    { existing: [] },
  );
  assert.equal(result.ok, false);
  const fields = result.errors.map((error) => error.field);
  for (const field of ['title', 'category', 'slashCommand', 'welcomeMessage']) {
    assert.ok(fields.includes(field), `应报告 ${field}`);
  }
});

test('快捷指令规范化并拒绝重复', () => {
  assert.equal(normalizeSlashCommand('Record'), '/record');
  assert.equal(normalizeSlashCommand('/record'), '/record');
  const result = normalizeScenario(base, { existing: [{ scenarioId: 'other', slashCommand: '/record', title: '别的卡片' }] });
  assert.equal(result.ok, false);
  assert.match(result.errors.find((error) => error.field === 'slashCommand').message, /已被/);
});

test('非法指令格式被拒绝', () => {
  const result = normalizeScenario({ ...base, slashCommand: '/Record 单据' }, { existing: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'slashCommand'));
});

test('pinnedSkills 去重并保持顺序', () => {
  const result = normalizeScenario(
    { ...base, pinnedSkills: ['crm-core', 'crm-record-change', 'crm-core'] },
    { existing: [] },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.card.pinnedSkills, ['crm-core', 'crm-record-change']);
  assert.ok(result.warnings.some((warning) => warning.field === 'pinnedSkills'));
});

test('未知图标回退为默认图标而不是失败', () => {
  const result = normalizeScenario({ ...base, icon: 'rocket' }, { existing: [] });
  assert.equal(result.ok, true);
  assert.equal(result.card.icon, 'sparkles');
  assert.ok(result.warnings.some((warning) => warning.field === 'icon'));
});

test('Skill 仓库里找不到的标识只警告、不阻断保存', () => {
  const result = normalizeScenario(base, { existing: [], skillNames: ['crm-core'] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.field === 'pinnedSkills' && /crm-record-change/.test(warning.message)));
});

test('目标对象 API 名格式校验', () => {
  const bad = normalizeScenario(
    { ...base, prePinnedContext: { ...base.prePinnedContext, defaultObjectApiName: 'Case-1' } },
    { existing: [] },
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.field === 'prePinnedContext.defaultObjectApiName'));
});

test('默认动作与表单入口只接受枚举值', () => {
  const bad = normalizeScenario(
    { ...base, prePinnedContext: { ...base.prePinnedContext, defaultAction: 'DELETE', formContextEntry: 'MODAL' } },
    { existing: [] },
  );
  assert.equal(bad.ok, false);
  const fields = bad.errors.map((error) => error.field);
  assert.ok(fields.includes('prePinnedContext.defaultAction'));
  assert.ok(fields.includes('prePinnedContext.formContextEntry'));
});

test('场景编码可由标题推导，冲突时追加序号', () => {
  const taken = ['crm_crm'];
  assert.equal(deriveScenarioId('CRM 单据新建与修改', taken), 'crm_crm_2');
  const result = normalizeScenario({ ...base, scenarioId: '' }, { existing: [{ scenarioId: 'crm_crm', slashCommand: '/x' }] });
  assert.equal(result.ok, true);
  assert.equal(result.card.scenarioId, 'crm_crm_2');
});

test('数量上限只在新建时生效', () => {
  const existing = [{ scenarioId: 'a', slashCommand: '/a', title: 'A' }];
  const created = normalizeScenario(base, { existing, maxCards: 1 });
  assert.equal(created.ok, false);
  const edited = normalizeScenario(base, { existing, maxCards: 1, previousId: 'a' });
  assert.equal(edited.ok, true);
});

test('moveScenario 只移动一步且不修改入参', () => {
  const list = [{ scenarioId: 'a' }, { scenarioId: 'b' }, { scenarioId: 'c' }];
  const down = moveScenario(list, 'a', 'down');
  assert.equal(down.ok, true);
  assert.deepEqual(down.items.map((item) => item.scenarioId), ['b', 'a', 'c']);
  assert.deepEqual(list.map((item) => item.scenarioId), ['a', 'b', 'c']);
  assert.equal(moveScenario(list, 'a', 'up').ok, false);
  assert.equal(moveScenario(list, 'c', 'down').ok, false);
});

test('duplicateScenario 生成新编码与新指令', () => {
  const copy = duplicateScenario(
    { ...base, scenarioId: 'crm_crm', slashCommand: '/record' },
    ['crm_crm', 'crm_crm_copy'],
  );
  assert.equal(copy.scenarioId, 'crm_crm_copy_2');
  assert.notEqual(copy.slashCommand, '/record');
  assert.match(copy.title, /副本/);
  assert.equal(copy.isSystemBase, false);
});

test('coerceStoredScenario 丢弃不合法卡片', () => {
  assert.equal(coerceStoredScenario(null), undefined);
  assert.equal(coerceStoredScenario({ title: '只有标题' }), undefined);
  assert.equal(coerceStoredScenario(base).scenarioId, 'crm_crm');
});
