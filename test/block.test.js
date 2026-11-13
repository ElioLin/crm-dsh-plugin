import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextBlock, clampText, skillLines, summarizeStack } from '../lib/core/block.js';
import { CONTEXT_MARKER, INJECTION_BUDGET } from '../lib/core/constants.js';

const card = {
  scenarioId: 'crm_case',
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
    formContextEntry: 'QUICK_ACTION',
    allowAttachments: true,
  },
  welcomeMessage: '请描述你要新建的单据。',
};

const skills = [
  { name: 'crm-core', description: 'CRM 通用运行指导', content: 'CORE-BODY' },
  { name: 'crm-record-change', description: '记录变更安全执行', content: 'CHANGE-BODY' },
];

test('默认只注入场景与 Skill 名称，不带介绍与正文', () => {
  const text = buildContextBlock({ card, skills });
  assert.ok(text.startsWith(`${CONTEXT_MARKER} scenario=crm_case mode=names`));
  assert.ok(text.includes('1. crm-core'));
  assert.ok(text.includes('2. crm-record-change'));
  assert.ok(text.indexOf('crm-core') < text.indexOf('crm-record-change'));
  // 技能介绍与正文都不出现。
  assert.ok(!text.includes('CRM 通用运行指导'));
  assert.ok(!text.includes('CORE-BODY'));
  assert.ok(!text.includes('CHANGE-BODY'));
  assert.ok(!text.includes('## Skill 正文'));
  // 场景说明仍然保留（管理员写的一句话适用范围）。
  assert.ok(text.includes('## 场景说明（管理员填写）'));
  assert.ok(text.includes(card.description));
  assert.ok(text.includes('Case（已由场景固定'));
  assert.ok(text.includes('新建（CREATE）'));
  assert.ok(text.includes('快速操作入口（QUICK_ACTION）'));
  // 要求模型自己按顺序加载正文。
  assert.match(text, /用 skill 工具逐个按名称加载正文/);
  // 名称模式下不出现「未预载」这类逐条标注。
  assert.ok(!text.includes('未预载'));
});

test('includeBodies + full 才带正文，reminder 不带正文只提醒', () => {
  const full = buildContextBlock({ card, skills, mode: 'full', includeBodies: true });
  assert.ok(full.startsWith(`${CONTEXT_MARKER} scenario=crm_case mode=full`));
  assert.ok(full.includes('## Skill 正文'));
  assert.ok(full.includes('CORE-BODY'));
  assert.ok(full.includes('CHANGE-BODY'));

  // 只给 mode=full 但没开 includeBodies：仍然只有名称。
  const names = buildContextBlock({ card, skills, mode: 'full' });
  assert.ok(names.startsWith(`${CONTEXT_MARKER} scenario=crm_case mode=names`));
  assert.ok(!names.includes('CORE-BODY'));

  const reminder = buildContextBlock({ card, skills, mode: 'reminder' });
  assert.ok(reminder.includes('mode=reminder'));
  assert.ok(!reminder.includes('CORE-BODY'));
  assert.ok(reminder.includes('仍然生效'));
});

test('includeDescriptions 才追加一行描述，且长描述被截断', () => {
  const withDesc = buildContextBlock({
    card,
    skills: [{ name: 'crm-core', description: 'x'.repeat(400), content: 'BODY' }],
    includeDescriptions: true,
  });
  assert.ok(withDesc.includes('1. crm-core — '));
  assert.ok(withDesc.includes('…'));
  assert.ok(withDesc.split('\n').find((line) => line.includes('crm-core')).length < 200);

  const plain = buildContextBlock({ card, skills });
  assert.ok(!plain.includes('1. crm-core — '));
});

test('缺失 Skill 在带正文模式下被标注「未预载」，且不出现在正文里', () => {
  const mixed = [
    { name: 'crm-core', description: '通用', content: 'CORE-BODY', loaded: true },
    { name: 'ghost-skill', description: '', missing: true },
  ];
  const text = buildContextBlock({ card, skills: mixed, mode: 'full', includeBodies: true });
  // 注册表是分层视图：看不到不等于不存在，所以只声明「未预载」并要求模型自行加载。
  assert.ok(text.includes('ghost-skill【未预载正文：请先用 skill 工具加载同名 Skill'));
  assert.ok(!text.includes('ghost-skill【当前 Skill 仓库中不存在】'));
  assert.ok(!text.includes('### ghost-skill'));
  assert.match(text, /必须先调用 skill 工具按名称加载其正文/);
  assert.match(text, /不得假装已加载/);
});

test('未绑定 Skill 时给出明确说明而不是空白', () => {
  const text = buildContextBlock({ card, skills: [] });
  assert.ok(text.includes('本场景未绑定任何 Skill'));
  assert.ok(!text.includes('## Skill 正文'));
  assert.equal(summarizeStack([]), '未绑定技能');
  assert.deepEqual(skillLines([]).length, 1);
});

test('未锚定目标对象时要求模型先发现对象', () => {
  const text = buildContextBlock({
    card: { ...card, prePinnedContext: { ...card.prePinnedContext, defaultObjectApiName: undefined } },
    skills,
    mode: 'reminder',
  });
  assert.ok(text.includes('未锚定：先根据用户描述与可用工具确定对象'));
  assert.ok(text.includes('允许，用户上传的单据/表格/图片可作为执行依据'));
});

test('正文按预算截断，并保留被截断的事实', () => {
  const long = 'A'.repeat(INJECTION_BUDGET.perSkill + 500);
  const clamped = clampText(long, 100);
  assert.ok(clamped.startsWith('A'.repeat(100)));
  assert.match(clamped, /原文共 \d+ 字符，已按注入预算截断/);

  const text = buildContextBlock({
    card,
    skills: [
      { name: 'a', description: 'a', content: long },
      { name: 'b', description: 'b', content: long },
      { name: 'c', description: 'c', content: long },
      { name: 'd', description: 'd', content: long },
    ],
    mode: 'full',
    includeBodies: true,
  });
  assert.ok(text.includes('剩余 Skill 正文因注入预算未展开'));
  assert.ok([...text].length < INJECTION_BUDGET.total + 4000);
});

test('skillLines 只在显式要求时带描述或状态后缀', () => {
  const rows = skillLines([{ name: 'a', description: 'desc-a' }]);
  assert.deepEqual(rows, ['1. a']);
  assert.deepEqual(skillLines([{ name: 'a', description: 'desc-a' }], { descriptions: true }), ['1. a — desc-a']);
  assert.deepEqual(skillLines([{ name: 'a', missing: true }], { withBodies: true }), [
    '1. a【未预载正文：请先用 skill 工具加载同名 Skill，加载失败再如实告知用户】',
  ]);
});

test('空内容与小预算不会抛错', () => {
  assert.equal(clampText('', 10), '');
  assert.equal(clampText('abc', 0), '');
  const text = buildContextBlock({
    card: { ...card, prePinnedContext: undefined, description: '只有说明' },
    skills: [{ name: 'x' }],
  });
  assert.ok(text.includes('crm_case'));
  assert.ok(text.includes('未锚定'));
  assert.deepEqual(summarizeStack([{ name: 'a' }, { name: 'b' }]), 'a → b');
});
