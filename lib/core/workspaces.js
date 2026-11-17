/**
 * 业务系统 → DSH 工作区的解析与创建。
 *
 * 产品约定（1.7.0）：一个业务系统对应一个固定的工作区。
 * 进入「CRM」的场景要落在 CRM 工作区的新会话里，进入「TAPD」的场景要落在
 * TAPD 工作区，而不是都堆在用户当前随手打开的工作区。
 *
 * 定位顺序：
 *   1. 已有工作区里标题等于业务系统名（或等于它的 key）的 → 直接复用；
 *   2. 已有工作区里目录等于 `<workspaceRoot>/<key>` 的 → 直接复用
 *      （用户自己在该目录建过工作区，尊重它，不重复建）；
 *   3. 都没有 → 建目录 + 建工作区（并把标题改成业务系统名）。
 *
 * 这里只做「纯逻辑 + 可注入服务」，不直接 import 宿主服务，
 * 好处是可以用假 registry/controller 做单元测试（见 test/workspaces.test.js）。
 */

import { mkdir as mkdirFs } from 'node:fs/promises';
import { join, normalize as normalizePath, sep } from 'node:path';

import { businessSystemKey, normalizeBusinessSystem } from './schema.js';

/** 工作区视图 → 统一的 id 字段（registry 用 id，controller 用 workspaceId）。 */
function workspaceIdOf(view) {
  const id = view?.workspaceId ?? view?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 比较目录时忽略大小写、尾部分隔符与 `.` `..` 这类写法。 */
export function sameDirectory(left, right) {
  const clean = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return '';
    let out = normalizePath(value.trim());
    while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
    return out.toLowerCase();
  };
  const a = clean(left);
  const b = clean(right);
  return a !== '' && a === b;
}

/** 业务系统工作区应该落在哪个目录：`<workspaceRoot>/<key>`。 */
export function systemWorkspaceDir(rootDir, system) {
  const key = businessSystemKey(system);
  if (key === '') return '';
  return join(rootDir, key);
}

function describeWorkspace(view, fallback) {
  const id = workspaceIdOf(view);
  const path = typeof view?.path === 'string' && view.path !== '' ? view.path : fallback.path;
  const title = typeof view?.title === 'string' && view.title !== '' ? view.title : fallback.title;
  return { workspaceId: id, path, title };
}

/** 依次尝试多个工作区服务上的 list()：registry 与 controller 的形态不同，都要兼容。 */
async function listWorkspaces(services) {
  for (const service of [services.registry, services.controller]) {
    if (typeof service?.list !== 'function') continue;
    try {
      const rows = await service.list();
      if (Array.isArray(rows)) return rows;
    } catch {
      /* 换个服务再试；都失败时按「没有工作区」处理 */
    }
  }
  return [];
}

/**
 * 确保某个业务系统的工作区存在。
 *
 * @param {object} options
 * @param {string} options.system 业务系统名（如 `CRM`、`TAPD`、自定义名）
 * @param {string} options.rootDir 业务系统工作区的父目录（通常是 `<dataDir>/workspaces`）
 * @param {{registry?: object, controller?: object}} [options.services] 宿主工作区服务
 * @param {{mkdir?: Function}} [options.fs] 便于测试注入
 * @returns {Promise<{ok: true, created: boolean, system: string, key: string, workspace: {workspaceId?: string, path: string, title: string}}
 *          | {ok: false, message: string}>}
 */
export async function ensureSystemWorkspace({ system, rootDir, services = {}, fs = {} } = {}) {
  const label = normalizeBusinessSystem(system);
  if (label === '') return { ok: false, message: '业务系统名为空：场景卡片必须声明它属于哪个业务系统' };
  const key = businessSystemKey(label);
  if (key === '') return { ok: false, message: `业务系统「${label}」无法生成稳定的工作区标识` };
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    return { ok: false, message: '没有配置业务系统工作区的根目录' };
  }

  const dir = systemWorkspaceDir(rootDir, label);
  const lowerLabel = label.toLowerCase();

  const rows = await listWorkspaces(services);
  const byTitle = rows.find((row) => {
    const title = typeof row?.title === 'string' ? row.title.trim().toLowerCase() : '';
    return title !== '' && (title === lowerLabel || title === key);
  });
  const byPath = byTitle === undefined ? rows.find((row) => sameDirectory(row?.path, dir)) : undefined;
  const hit = byTitle ?? byPath;
  if (hit !== undefined) {
    return {
      ok: true,
      created: false,
      system: label,
      key,
      workspace: describeWorkspace(hit, { path: typeof hit?.path === 'string' ? hit.path : dir, title: label }),
    };
  }

  // 目录必须先存在：工作区的 cwd 是真实目录，宿主不会替你建。
  const mkdir = typeof fs.mkdir === 'function' ? fs.mkdir : mkdirFs;
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `无法创建业务系统工作区目录 ${dir}：${error?.message ?? error}` };
  }

  const registry = services.registry;
  const controller = services.controller;
  try {
    if (typeof registry?.create === 'function') {
      const created = await registry.create(dir, label);
      const workspace = describeWorkspace(created, { path: dir, title: label });
      if (workspace.workspaceId === undefined) {
        // registry 只返回记录对象时，标题可能还没落盘：再按目录查一次拿 id。
        const resolved = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(dir) : undefined;
        if (resolved !== undefined) return finish(resolved, label, key, dir, true);
      }
      return { ok: true, created: true, system: label, key, workspace };
    }

    if (typeof controller?.create === 'function') {
      const result = await controller.create({ path: dir });
      const view = result?.workspace ?? result;
      const workspace = describeWorkspace(view, { path: dir, title: label });
      // controller.create 用目录名当标题；改成业务系统名，侧边栏才看得懂（失败无妨）。
      if (workspace.workspaceId !== undefined && typeof controller.rename === 'function') {
        try {
          await controller.rename({ workspaceId: workspace.workspaceId, title: label });
          workspace.title = label;
        } catch {
          /* 标题只是展示用；改不动就保留目录名 */
        }
      }
      return { ok: true, created: true, system: label, key, workspace };
    }
  } catch (error) {
    return { ok: false, message: `创建业务系统工作区失败：${error?.message ?? error}` };
  }

  return { ok: false, message: '当前 DSH 版本没有可用的工作区服务，无法按业务系统切换工作区' };
}

function finish(view, label, key, dir, created) {
  return {
    ok: true,
    created,
    system: label,
    key,
    workspace: describeWorkspace(view, { path: dir, title: label }),
  };
}
