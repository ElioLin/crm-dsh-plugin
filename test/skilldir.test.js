import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { clearSkillDirCache, parseFrontmatter, scanSkillDir } from '../lib/core/skilldir.js';

test('parseFrontmatter 只认 name/description/whenToUse，正文原样保留', () => {
  const raw = '---\nname: crm-core\ndescription: "CRM 通用运行指导"\nwhenToUse: 查询 CRM 数据时\n---\n# 标题\n\n正文第一段。\n';
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.name, 'crm-core');
  assert.equal(meta.description, 'CRM 通用运行指导');
  assert.equal(meta.whenToUse, '查询 CRM 数据时');
  assert.match(body, /正文第一段/);
  assert.equal(body.startsWith('---'), false);
});

test('没有 frontmatter 时按正文处理，不丢内容', () => {
  const { meta, body } = parseFrontmatter('# 只有正文\n\n有用的话。');
  assert.deepEqual(meta, {});
  assert.match(body, /有用的话/);
});

test('扫描目录：读取每个子目录的 SKILL.md，按名称排序并去重', async () => {
  clearSkillDirCache();
  const root = await mkdtemp(join(tmpdir(), 'crm-workspace-skills-'));
  for (const [dir, name, description] of [
    ['crm-core', 'crm-core', 'CRM 通用运行指导'],
    ['alpha', 'alpha-skill', 'A 技能'],
    ['empty', 'empty', '无正文'],
  ]) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(
      join(root, dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n正文 ${name}\n`,
      'utf8',
    );
  }
  // 没有 SKILL.md 的目录被忽略；非目录条目也被忽略
  await mkdir(join(root, 'no-entry'), { recursive: true });
  await writeFile(join(root, 'stray.md'), 'x', 'utf8');

  const rows = await scanSkillDir(root);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['alpha-skill', 'crm-core', 'empty'],
  );
  const core = rows.find((row) => row.name === 'crm-core');
  assert.equal(core.description, 'CRM 通用运行指导');
  assert.match(core.content, /正文 crm-core/);
  assert.equal(core.source, 'local-dir');
});

test('目录不存在或为空时返回空数组，不抛错', async () => {
  clearSkillDirCache();
  assert.deepEqual(await scanSkillDir(''), []);
  assert.deepEqual(await scanSkillDir(join(tmpdir(), 'crm-workspace-not-exists-xyz')), []);
});

test('缺失 description 时用正文首段兜底', async () => {
  clearSkillDirCache();
  const root = await mkdtemp(join(tmpdir(), 'crm-workspace-skills-'));
  await mkdir(join(root, 'plain'), { recursive: true });
  await writeFile(join(root, 'plain', 'SKILL.md'), '# 标题\n\n第一段说明。\n\n第二段。\n', 'utf8');
  const [row] = await scanSkillDir(root);
  assert.equal(row.name, 'plain');
  assert.equal(row.description, '第一段说明。');
});
