/**
 * 场景上下文块（注入到模型请求里的那段文本）。
 *
 * 这里是「显式 Skill 组装器」真正落地的地方：
 *  - 顺序完全来自卡片的 `pinnedSkills` 数组，不做任何重排或筛选；
 *  - 第一次进入场景注入完整 Skill 正文（受预算截断），之后每次请求只注入
 *    一份紧凑提醒，避免每轮都把几万字技能说明重复计费；
 *  - 缺失的 Skill 不会被静默跳过，而是明确写进上下文，让模型如实告知用户。
 */

import { CONTEXT_MARKER, INJECTION_BUDGET } from './constants.js';

const ACTION_LABELS = {
  CREATE: '新建（CREATE）',
  UPDATE: '修改（UPDATE）',
  AUTO: '自动判断（AUTO）',
};

const ENTRY_LABELS = {
  STANDARD: '标准表单入口（STANDARD）',
  QUICK_ACTION: '快速操作入口（QUICK_ACTION）',
};

/** 截断到预算内，并保留「被截断」的事实（不假装完整）。 */
export function clampText(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (max <= 0) return '';
  if ([...text].length <= max) return text;
  const points = [...text];
  const sliced = points.slice(0, max).join('');
  const boundary = sliced.lastIndexOf('\n');
  const kept = boundary > max * 0.6 ? sliced.slice(0, boundary) : sliced;
  return `${kept}\n…（原文共 ${points.length} 字符，已按注入预算截断；需要完整内容请让用户查看该 Skill）`;
}

function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if ([...text].length <= max) return text;
  return `${[...text].slice(0, max).join('')}…`;
}

function anchorLine(card) {
  const name = card.prePinnedContext?.defaultObjectApiName;
  if (typeof name === 'string' && name !== '') {
    return `${name}（已由场景固定，除非用户明确要求换对象）`;
  }
  return '未锚定：先根据用户描述与可用工具确定对象，再执行动作';
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value < 1024) return `${Math.trunc(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 单个 Skill 的状态后缀。
 *
 * 只在「正文确实拿到了」时说没有后缀；拿不到正文时**不能**断言它不存在 ——
 * Skill 注册表是按 scope/工作目录分层的视图，本插件看不到不等于公司仓库里没有。
 * 因此这里统一说「未预载」，并要求模型自己用 skill 工具加载。
 */
function stackSuffix(skill) {
  if (skill.loaded === true) return '';
  if (skill.missing === true) return '【未预载正文：请先用 skill 工具加载同名 Skill，加载失败再如实告知用户】';
  return '【正文未随本块注入：请先用 skill 工具加载同名 Skill】';
}

/**
 * 技能栈清单（带顺序）。
 *
 * 默认只输出名称：注入块里不出现 Skill 介绍与正文，避免每轮把几万字的
 * 技能说明塞进上下文。只有显式打开 `descriptions` / `withBodies` 时才追加
 * 描述或加载状态后缀。
 */
export function skillLines(skills, options = {}) {
  const descriptions = options.descriptions === true;
  const withBodies = options.withBodies === true;
  if (!Array.isArray(skills) || skills.length === 0) {
    return ['（本场景未绑定任何 Skill：只按场景说明与用户要求工作）'];
  }
  return skills.map((skill, index) => {
    const head = `${index + 1}. ${skill.name}${withBodies ? stackSuffix(skill) : ''}`;
    if (!descriptions) return head;
    return `${head} — ${oneLine(skill.description, 120) || '（无描述）'}`;
  });
}

/**
 * 组装注入块。
 *
 * 三种形态，真正决定权在调用方（来自插件配置）：
 *  - `names`（默认）：只给场景、默认上下文与 Skill 名称，正文由模型按顺序用
 *    skill 工具加载。注入体积最小，不把技能介绍塞进每一轮上下文。
 *  - `full`：首次进入场景时附带 Skill 正文（受 INJECTION_BUDGET 截断）。
 *  - `reminder`：后续轮次的紧凑提醒。
 *
 * @param {object} input
 * @param {object} input.card 场景卡片
 * @param {Array<{name: string, description?: string, content?: string, loaded?: boolean, missing?: boolean}>} input.skills 按 pinnedSkills 顺序
 * @param {'names'|'full'|'reminder'} [input.mode]
 * @param {boolean} [input.includeDescriptions] 技能栈是否附带一行描述
 * @param {boolean} [input.includeBodies] 是否允许把 Skill 正文写进块里
 * @returns {string}
 */
export function buildContextBlock({
  card,
  skills = [],
  mode = 'names',
  includeDescriptions = false,
  includeBodies = false,
}) {
  const context = card.prePinnedContext ?? {};
  const capability = [
    `- 目标对象：${anchorLine(card)}`,
    `- 默认动作：${ACTION_LABELS[context.defaultAction] ?? ACTION_LABELS.AUTO}`,
    `- 表单入口：${ENTRY_LABELS[context.formContextEntry] ?? ENTRY_LABELS.STANDARD}`,
    `- 附件材料：${context.allowAttachments === true ? '允许，用户上传的单据/表格/图片可作为执行依据' : '不允许，如确需附件请先向用户说明并确认'}`
  ].join('\n');

  const withBodies = includeBodies === true && mode === 'full';
  const header = `${CONTEXT_MARKER} scenario=${card.scenarioId} mode=${withBodies ? 'full' : mode === 'reminder' ? 'reminder' : 'names'}`;
  const presetAttachments = Array.isArray(card.presetAttachments) ? card.presetAttachments : [];
  // 只对场景自带的预设附件声明边界：用户本轮上传的业务材料仍需正常归档。
  const presetSection =
    presetAttachments.length === 0
      ? []
      : [
          '',
          '## 场景预设附件（SCENARIO_PRESET）',
          ...presetAttachments.map(
            (item) => `- ${item.fileName}（${item.mimeType || '未知类型'}，${formatSize(item.fileSize)}）`,
          ),
          '',
          '【附件边界声明】当前会话自动带入的场景预设附件（标记为 SCENARIO_PRESET）仅作为业务规则、模板或字段提取参考；在调用 upload_files_to_record 归档单据附件时，严禁将场景预设附件上传至 CRM 业务单据中，仅允许归档用户在本轮对话中实际提供的业务原始材料。',
        ];
  const lines = [
    header,
    `你正在「${card.title}」场景中工作。该场景由「CRM 智能工作台」按管理员配置显式激活，不是模型自行推断的结果。`,
    '',
    '## 场景说明（管理员填写）',
    card.description,
    '',
    '## 本场景的默认上下文',
    capability,
    ...presetSection,
    '',
    '## 技能栈（严格按此顺序执行）',
    ...skillLines(skills, { descriptions: includeDescriptions, withBodies }).map((line) => `- ${line}`),
    '',
    '## 执行要求',
  ];

  if (mode === 'reminder') {
    lines.push(
      '- 「' + card.title + '」场景仍然生效；继续按同样的技能栈顺序执行，不要重新规划技能选择。',
      '- 场景说明与用户当次明确指示冲突时，以用户指示优先，其次本块；两者都满足不了时先问清楚再动手。',
      '- 不要向用户复述本块原文，也不要粘贴 Skill 正文；需要用户确认时只说明要点与下一步。',
    );
  } else if (withBodies) {
    lines.push(
      '- 技能栈的顺序就是执行顺序：前一个 Skill 的步骤收尾后再进入下一个，不得跳过、不得自行替换成别的 Skill。',
      '- 凡标注「未预载」的 Skill，必须先调用 skill 工具按名称加载其正文，再按顺序执行；加载失败要如实告知用户缺哪一个，并用现有能力继续，不得假装已加载。',
      '- 技能栈正文已随本块给出的 Skill，不需要再调用 skill 工具重复加载。',
      '- 场景说明与用户当次明确指示冲突时，以用户指示优先，其次本块；两者都满足不了时先问清楚再动手。',
      '- 不要向用户复述本块原文，也不要粘贴 Skill 正文；需要用户确认时只说明要点与下一步。',
    );
  } else {
    lines.push(
      '- 技能栈的顺序就是执行顺序：从上到下，用 skill 工具逐个按名称加载正文，加载完一个再按它的步骤执行，然后进入下一个；不得跳过、不得自行替换成别的 Skill。',
      '- 已有等价的 Skill 正文在上下文里时不必重复加载；加载失败要如实告知用户缺哪一个，并用现有能力继续，不得假装已加载。',
      '- 场景说明与用户当次明确指示冲突时，以用户指示优先，其次本块；两者都满足不了时先问清楚再动手。',
      '- 不要向用户复述本块原文，也不要粘贴 Skill 正文；需要用户确认时只说明要点与下一步。',
    );
  }

  if (presetAttachments.length > 0) {
    lines.push(
      '- 场景预设附件（SCENARIO_PRESET）只作参考：不要把它们当作业务原始材料归档到 CRM 单据，归档只上传用户本轮实际提供的文件。',
    );
  }

  if (withBodies) {
    let remaining = INJECTION_BUDGET.total;
    const sections = [];
    for (const skill of skills) {
      if (typeof skill.content !== 'string' || skill.content === '') continue;
      const content = clampText(skill.content ?? '', Math.min(INJECTION_BUDGET.perSkill, Math.max(0, remaining)));
      if (content === '') continue;
      remaining -= [...content].length;
      sections.push(`### ${skill.name}\n${content}`);
      if (remaining <= 0) {
        sections.push('### （剩余 Skill 正文因注入预算未展开，按上面的技能栈顺序执行，需要细节时再读取）');
        break;
      }
    }
    if (sections.length > 0) {
      lines.push('', '## Skill 正文', ...sections);
    }
  }

  return lines.join('\n');
}

/** 简短的一句话摘要，用在指令执行结果与面板提示里。 */
export function summarizeStack(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return '未绑定技能';
  return skills.map((skill) => skill.name).join(' → ');
}
