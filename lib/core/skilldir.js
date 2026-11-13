/**
 * Skill 目录兜底目录表（可选能力）。
 *
 * 为什么需要它：Host 的 `skills` 服务是**分层**注册表 —— 根作用域只看得见全局层，
 * 挂在 agent preset 层里的公司 Skill（例如 crm-core）在根视图里是看不到的。
 * 本插件运行在 Host 根上下文，因此面板的 Skill 选择器默认只能列出全局层。
 *
 * 这个模块提供一个**只读的目录兜底**：直接扫描磁盘上的 `<skill>/SKILL.md`，
 * 把名称/描述/正文读出来，用于「管理员挑 Skill」与「注入时兜底取正文」。
 * 它不注册、不缓存到注册表、不参与路由，失败一律静默降级为空列表。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_TTL_MS = 10_000;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const DESCRIPTION_LIMIT = 400;

const cache = new Map();

function stripQuotes(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

/** 解析极简 YAML frontmatter（只认 name / description / whenToUse 三个键）。 */
export function parseFrontmatter(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    const value = stripQuotes(match[2]);
    if (key === 'name') meta.name = value;
    else if (key === 'description') meta.description = value;
    else if (key === 'whenToUse' || key === 'when_to_use' || key === 'when-to-use') meta.whenToUse = value;
  }
  return { meta, body };
}

function firstParagraph(body) {
  const text = String(body ?? '').replace(/^#.*$/gm, '').trim();
  const paragraph = text.split(/\n\s*\n/)[0] ?? '';
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT)}…` : flat;
}

async function readSkillDir(root, entryName) {
  for (const fileName of ['SKILL.md', 'skill.md']) {
    const candidate = join(root, entryName, fileName);
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) return undefined;
      const raw = await readFile(candidate, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : entryName;
      return {
        name,
        description: meta.description ?? firstParagraph(body),
        whenToUse: meta.whenToUse ?? '',
        source: 'local-dir',
        path: candidate,
        content: body.trim(),
      };
    } catch {
      /* 该文件不存在：尝试下一个文件名 */
    }
  }
  return undefined;
}

/**
 * 扫描一个 Skill 根目录（每个子目录一个 Skill，入口为 SKILL.md）。
 *
 * @param {string} dir
 * @param {{maxSkills?: number, now?: number}} [options]
 * @returns {Promise<Array<{name: string, description: string, whenToUse: string, source: string, path: string, content: string}>>}
 */
export async function scanSkillDir(dir, { maxSkills = 200, now = Date.now() } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const hit = cache.get(dir);
  if (hit !== undefined && now - hit.time < CACHE_TTL_MS) return hit.rows;

  let rows = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).slice(0, Math.max(1, maxSkills));
    const loaded = await Promise.all(directories.map((entry) => readSkillDir(dir, entry.name)));
    const seen = new Set();
    rows = [];
    for (const skill of loaded) {
      if (skill === undefined || seen.has(skill.name)) continue;
      seen.add(skill.name);
      rows.push(skill);
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    rows = [];
  }

  cache.set(dir, { time: now, rows });
  return rows;
}

/** 只清本模块的缓存（测试与配置变更时使用）。 */
export function clearSkillDirCache() {
  cache.clear();
}
