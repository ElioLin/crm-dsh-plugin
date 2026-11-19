import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextBlock, clampText, skillLines, summarizeStack } from '../lib/core/block.js';
import { CONTEXT_MARKER, INJECTION_BUDGET } from '../lib/core/constants.js';

const card = {
  scenarioId: 'crm_case',
  title: 'CRM 单据新建与修改',
  description: '按单据类型新建或修改记录，自动处理必填项与字段权限。',
  icon: 'briefcase',
  businessSystem: 'CRM',
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
  // 目标对象 / 动作 / 表单入口不再配置，改为要求模型现场判断。
  assert.ok(text.includes('目标对象与动作：不预设'));
  assert.ok(text.includes('表单入口：不预设'));
  assert.ok(text.includes('允许，用户上传的单据/表格/图片可作为执行依据'));
  assert.ok(!text.includes('Case'));
  // 要求模型自己按顺序加载正文。
  assert.match(text, /用 skill 工具逐个按名称加载正文/);
  // 名称模式下不出现「未预载」这类逐条标注。
  assert.ok(!text.includes('未预载'));
});

test('技能随用户消息以 /技能名 提交时，不再让模型重复加载正文', () => {
  const text = buildContextBlock({ card, skills, skillsProvided: true });
  // 宿主已经把正文按同一顺序注入本次请求：这里必须改成「直接按正文执行」。
  assert.match(text, /已经以 `\/技能名` 随用户消息提交/);
  assert.match(text, /不要再调用 skill 工具重复加载/);
  assert.equal(/用 skill 工具逐个按名称加载正文/.test(text), false);
  // 顺序与场景说明照旧。
  assert.ok(text.indexOf('crm-core') < text.indexOf('crm-record-change'));
  assert.ok(text.includes(card.description));
  // brief 模式不受影响：它本来就不提加载动作。
  const brief = buildContextBlock({ card, skills, mode: 'brief', skillsProvided: true });
  assert.ok(!brief.includes('skill_content'));
});

test('brief 模式只留一行唤醒：不带场景说明与技能列表', () => {
  const text = buildContextBlock({ card, skills, mode: 'brief', injectionCount: 3 });
  assert.ok(text.startsWith(`${CONTEXT_MARKER} scenario=crm_case mode=brief`));
  assert.ok(text.includes('仍然生效'));
  assert.ok(text.includes('3'));
  assert.ok(text.includes('crm-core → crm-record-change'));
  // 长内容一律不再重发。
  assert.ok(!text.includes('## 场景说明'));
  assert.ok(!text.includes('## 本场景的默认上下文'));
  assert.ok(!text.includes(card.description));
  assert.ok(!text.includes('CORE-BODY'));
  assert.ok([...text].length < 260);
  assert.ok([...text].length < [...buildContextBlock({ card, skills })].length);
});

test('预设填写模板：随消息提交时说明「不要复述」，未提交时提示用户补发', () => {
  const withDraft = { ...card, inputDraft: '拜访对象：\n拜访目的：' };
  const provided = buildContextBlock({ card: withDraft, skills, prefillProvided: true });
  assert.ok(provided.includes('## 输入框预填模板'));
  assert.ok(provided.includes('已经随用户消息一起提交'));
  const absent = buildContextBlock({ card: withDraft, skills, prefillProvided: false });
  assert.ok(absent.includes('## 输入框预填模板'));
  assert.ok(absent.includes('没有把它一起发出来'));
  // 没有 inputDraft 的卡片不该出现这一节。
  assert.ok(!buildContextBlock({ card, skills }).includes('## 输入框预填模板'));
});

test('场景介绍选填：留空时不留空的「场景说明」标题，也不影响其他段落', () => {
  const text = buildContextBlock({ card: { ...card, description: '' }, skills });
  assert.ok(!text.includes('## 场景说明（管理员填写）'));
  assert.ok(text.includes('crm-core'));
});

test('多场景叠加时说明本块只描述其中一个', () => {
  const stacked = buildContextBlock({ card, skills, stackSize: 2 });
  assert.ok(stacked.includes('同时叠加了 2 个场景'));
  assert.ok(!buildContextBlock({ card, skills }).includes('同时叠加了'));
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

test('不再锚定对象/动作/表单入口，统一交给模型按上下文判断', () => {
  const text = buildContextBlock({
    card: { ...card, prePinnedContext: { ...card.prePinnedContext, defaultObjectApiName: undefined } },
    skills,
    mode: 'reminder',
  });
  assert.ok(text.includes('先根据用户描述与可用工具确认对象'));
  assert.ok(text.includes('按当前可用的标准表单入口或快速操作入口自动选择'));
  assert.ok(text.includes('允许，用户上传的单据/表格/图片可作为执行依据'));
  // 旧卡片即使存档里还带着 defaultObjectApiName，也不会再写进注入块。
  assert.ok(!text.includes('Case'));
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
  assert.ok(text.includes('不预设'));
  assert.deepEqual(summarizeStack([{ name: 'a' }, { name: 'b' }]), 'a → b');
});

test('场景预设附件会带出边界声明，禁止归档到业务单据', () => {
  const text = buildContextBlock({
    card: {
      ...card,
      presetAttachments: [
        {
          attachmentId: 'att_tpl',
          fileName: '拜访纪要标准模板.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          localPathOrUrl: 'att_tpl.docx',
          fileSize: 2048,
          role: 'SCENARIO_PRESET',
        },
        {
          attachmentId: 'att_csv',
          fileName: '字段清单.csv',
          mimeType: 'text/csv',
          localPathOrUrl: 'att_csv.csv',
          fileSize: 12,
          role: 'SCENARIO_PRESET',
        },
      ],
    },
    skills: [{ name: 'crm-core', description: 'desc' }],
  });
  assert.ok(text.includes('## 场景预设附件（SCENARIO_PRESET）'));
  assert.match(text, /拜访纪要标准模板\.docx（application\/vnd.*，2\.0 KB）/);
  assert.match(text, /字段清单\.csv（text\/csv，12 B）/);
  assert.ok(text.includes('【附件边界声明】'));
  assert.match(text, /严禁将场景预设附件上传至 CRM 业务单据中/);
  assert.match(text, /仅允许归档用户在本轮对话中实际提供的业务原始材料/);
  // 边界声明必须出现在技能栈之前，避免模型先看到技能再看到约束
  assert.ok(text.indexOf('【附件边界声明】') < text.indexOf('## 技能栈'));
});

test('没有预设附件时不会出现边界声明', () => {
  const text = buildContextBlock({ card, skills: [{ name: 'crm-core' }] });
  assert.ok(!text.includes('SCENARIO_PRESET'));
  assert.ok(!text.includes('【附件边界声明】'));
});

test('reminder 模式同样保留附件边界', () => {
  const text = buildContextBlock({
    card: {
      ...card,
      presetAttachments: [
        { attachmentId: 'a', fileName: '模板.md', mimeType: 'text/markdown', localPathOrUrl: 'a.md', fileSize: 3, role: 'SCENARIO_PRESET' },
      ],
    },
    skills: [{ name: 'crm-core' }],
    mode: 'reminder',
  });
  assert.ok(text.includes('mode=reminder'));
  assert.ok(text.includes('【附件边界声明】'));
});
