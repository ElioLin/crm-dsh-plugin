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

const attachment = {
  attachmentId: 'att_visit_template',
  fileName: '拜访纪要标准模板.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  localPathOrUrl: 'att_visit_template.docx',
  fileSize: 20480,
  role: 'SCENARIO_PRESET',
};

test('场景预设附件被规范化：角色固定、MIME 兜底、顺序保留', () => {
  const result = normalizeScenario(
    {
      ...base,
      presetAttachments: [
        { ...attachment, mimeType: undefined },
        {
          attachmentId: 'att_fields',
          fileName: '字段清单.csv',
          localPathOrUrl: 'https://crm.example.com/scenarios/fields.csv',
          fileSize: 4096,
        },
      ],
    },
    { existing: [], skillNames: ['crm-core'] },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.card.presetAttachments.length, 2);
  assert.deepEqual(
    result.card.presetAttachments.map((item) => item.attachmentId),
    ['att_visit_template', 'att_fields'],
  );
  assert.equal(result.card.presetAttachments[0].role, 'SCENARIO_PRESET');
  assert.equal(result.card.presetAttachments[0].mimeType, attachment.mimeType);
  assert.equal(result.card.presetAttachments[1].mimeType, 'text/csv');
  assert.equal(result.card.inputDraft, '');
  assert.equal(result.card.sourceType, 'LOCAL_CUSTOM');
  assert.equal(result.card.readonlyForNormalUser, false);
  assert.equal(result.card.version, '1.0.0');
});

test('场景预设附件拒绝不支持的类型、越界路径、重复标识与超量', () => {
  const unsupported = normalizeScenario(
    { ...base, presetAttachments: [{ ...attachment, fileName: 'setup.exe' }] },
    { existing: [], skillNames: [] },
  );
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.errors.map((item) => item.message).join('|'), /类型不受支持/);

  const traversal = normalizeScenario(
    { ...base, presetAttachments: [{ ...attachment, localPathOrUrl: '../../etc/passwd.docx' }] },
    { existing: [], skillNames: [] },
  );
  assert.equal(traversal.ok, false);
  assert.match(traversal.errors.map((item) => item.message).join('|'), /缺少合法的存储路径/);

  const duplicated = normalizeScenario(
    { ...base, presetAttachments: [attachment, { ...attachment, fileName: '另一个.docx' }] },
    { existing: [], skillNames: [] },
  );
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.errors.map((item) => item.message).join('|'), /重复/);

  const many = Array.from({ length: 21 }, (_item, index) => ({
    ...attachment,
    attachmentId: `att_overflow_${index}`,
    fileName: `模板${index}.docx`,
  }));
  const overflow = normalizeScenario({ ...base, presetAttachments: many }, { existing: [], skillNames: [] });
  assert.equal(overflow.ok, false);
  assert.match(overflow.errors.map((item) => item.message).join('|'), /最多 20 个预设附件/);
});

test('输入框预填与发布元数据被规范化', () => {
  const result = normalizeScenario(
    {
      ...base,
      inputDraft: '拜访对象：\n拜访目的：\n关键结论：',
      sourceType: 'company_standard',
      isStandardPublished: true,
      version: '1.2',
      author: '张三',
      originScenarioId: 'crm_std_visit',
    },
    { existing: [], skillNames: ['crm-core'] },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.card.inputDraft, '拜访对象：\n拜访目的：\n关键结论：');
  assert.equal(result.card.sourceType, 'COMPANY_STANDARD');
  assert.equal(result.card.readonlyForNormalUser, true);
  assert.equal(result.card.status, 'PUBLISHED');
  assert.equal(result.card.isStandardPublished, true);
  assert.equal(result.card.version, '1.2.0');
  assert.equal(result.card.revision, 0);
  assert.equal(result.card.author, '张三');
  assert.equal(result.card.originScenarioId, 'crm_std_visit');
});

test('非法版本号与超长创建人报错；未知来源与非法来源编码只告警', () => {
  const invalid = normalizeScenario({ ...base, version: 'v1', author: 'x'.repeat(81) }, { existing: [], skillNames: [] });
  assert.equal(invalid.ok, false);
  const messages = invalid.errors.map((item) => item.message).join('|');
  assert.match(messages, /版本号格式/);
  assert.match(messages, /创建人不能超过 80 个字符/);

  const coerced = normalizeScenario(
    { ...base, sourceType: 'CLOUD', originScenarioId: 'bad id' },
    { existing: [], skillNames: [] },
  );
  assert.equal(coerced.ok, true);
  assert.equal(coerced.card.sourceType, 'LOCAL_CUSTOM');
  assert.equal(coerced.card.originScenarioId, '');
  const warnings = coerced.warnings.map((item) => item.message).join('|');
  assert.match(warnings, /未知场景来源/);
  assert.match(warnings, /来源场景编码/);
});

test('coerceStoredScenario 宽松修复存档里的发布元数据与坏附件', () => {
  const card = coerceStoredScenario({
    ...base,
    version: 'v2',
    presetAttachments: [{ fileName: 'setup.exe', localPathOrUrl: 'setup.exe' }],
  });
  assert.ok(card);
  assert.equal(card.version, '1.0.0');
  assert.deepEqual(card.presetAttachments, []);
  assert.equal(card.sourceType, 'LOCAL_CUSTOM');
});

test('scenarioId 遵循服务端正则：允许大小写/点/连字符，拒绝保留字 permission', () => {
  const accepted = normalizeScenario(
    { ...base, scenarioId: 'CRM.Std-Visit_01' },
    { existing: [], skillNames: [] },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
  assert.equal(accepted.card.scenarioId, 'CRM.Std-Visit_01');

  const reserved = normalizeScenario(
    { ...base, scenarioId: 'permission' },
    { existing: [], skillNames: [] },
  );
  assert.equal(reserved.ok, false);
  assert.match(reserved.errors.map((item) => item.message).join('|'), /保留字 permission/);

  const bad = normalizeScenario(
    { ...base, scenarioId: '_leading' },
    { existing: [], skillNames: [] },
  );
  assert.equal(bad.ok, false);
});

test('旧存档的 LOCAL_INSTALLED 迁移为 LOCAL_CUSTOM', () => {
  const card = coerceStoredScenario({
    ...base,
    scenarioId: 'crm_legacy',
    sourceType: 'LOCAL_INSTALLED',
  });
  assert.ok(card);
  assert.equal(card.sourceType, 'LOCAL_CUSTOM');
  assert.equal(card.readonlyForNormalUser, false);
});

test('公司标准场景强制只读并保留远端 revision / 附件 sha256', () => {
  const result = normalizeScenario(
    {
      ...base,
      scenarioId: 'crm_std_visit',
      sourceType: 'COMPANY_STANDARD',
      readonlyForNormalUser: false,
      revision: 7,
      version: '1.2.3',
      presetAttachments: [
        {
          ...attachment,
          localPathOrUrl: 'https://crmmcptest.runner-corp.com.cn:9000/api/dsh/scenarios/crm_std_visit/attachments/att_visit_template',
          downloadUrl: '/api/dsh/scenarios/crm_std_visit/attachments/att_visit_template',
          sha256: 'a'.repeat(64),
        },
      ],
    },
    { existing: [], skillNames: [] },
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.card.readonlyForNormalUser, true);
  assert.equal(result.card.revision, 7);
  assert.equal(result.card.status, 'PUBLISHED');
  assert.equal(result.card.presetAttachments[0].sha256, 'a'.repeat(64));
  assert.match(result.card.presetAttachments[0].downloadUrl, /^\/api\/dsh\//);
});
