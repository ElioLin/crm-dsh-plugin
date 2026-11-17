/**
 * 业务系统 → 工作区 的解析逻辑单测。
 *
 * 1.7.0 的产品约定：每个业务系统对应一个固定工作区（`<root>/<key>`），
 * 进入场景时先确保它存在，再把会话建在里面。这里用假 registry/controller/fs
 * 验证四条定位路径与两条失败路径，不需要真的启动 DSH。
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { businessSystemKey } from '../lib/core/schema.js';
import { ensureSystemWorkspace, sameDirectory, systemWorkspaceDir } from '../lib/core/workspaces.js';

const rootDir = join('D:', 'probe', 'workspaces');

/** 假 registry：list/create/resolveByPath。 */
function fakeRegistry(rows = [], options = {}) {
  const calls = { create: [], list: 0, resolveByPath: [] };
  return {
    calls,
    rows,
    async list() {
      calls.list += 1;
      return rows;
    },
    async create(path, title) {
      calls.create.push({ path, title });
      if (options.createReturnsNoId === true) return { path, title };
      const row = { workspaceId: `ws-${calls.create.length}`, path, title: title ?? '', sessionIds: [] };
      rows.push(row);
      return row;
    },
    async resolveByPath(path) {
      calls.resolveByPath.push(path);
      return rows.find((row) => sameDirectory(row.path, path));
    },
  };
}

function fakeController(rows = []) {
  const calls = { create: [], rename: [] };
  return {
    calls,
    rows,
    async list() {
      return rows;
    },
    async create({ path }) {
      calls.create.push({ path });
      const view = { workspaceId: `ctl-${calls.create.length}`, path, title: 'workspaces', sessionIds: [] };
      rows.push(view);
      return { workspace: view, created: true };
    },
    async rename({ workspaceId, title }) {
      calls.rename.push({ workspaceId, title });
    },
  };
}

const fakeFs = { mkdir: async () => undefined };

test('工作区目录按业务系统的 key 生成，不看中文原名', () => {
  assert.equal(businessSystemKey('CRM'), 'crm');
  assert.equal(businessSystemKey('tapd'), 'tapd');
  assert.equal(businessSystemKey('其他'), 'other');
  assert.equal(systemWorkspaceDir(rootDir, 'CRM'), join(rootDir, 'crm'));
  assert.equal(systemWorkspaceDir(rootDir, '其他'), join(rootDir, 'other'));
});

test('sameDirectory 忽略大小写、分隔符与末尾斜杠', () => {
  assert.equal(sameDirectory('D:\\probe\\workspaces\\crm', 'd:/probe/workspaces/crm/'), true);
  assert.equal(sameDirectory('D:\\probe\\workspaces\\crm', 'D:\\probe\\workspaces\\tapd'), false);
  assert.equal(sameDirectory('', ''), false);
});

test('已经有同名工作区：直接复用，不再建目录', async () => {
  const registry = fakeRegistry([{ workspaceId: 'ws-crm', path: 'D:\\somewhere\\else', title: 'CRM', sessionIds: [] }]);
  let mkdirCalled = 0;
  const result = await ensureSystemWorkspace({
    system: 'CRM',
    rootDir,
    services: { registry },
    fs: { mkdir: async () => { mkdirCalled += 1; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.key, 'crm');
  assert.equal(result.workspace.workspaceId, 'ws-crm');
  assert.equal(mkdirCalled, 0);
  assert.equal(registry.calls.create.length, 0);
});

test('工作区标题是 key（crm）也算命中，避免同系统建出第二个工作区', async () => {
  const registry = fakeRegistry([{ workspaceId: 'ws-crm', path: 'D:\\x', title: 'crm', sessionIds: [] }]);
  const result = await ensureSystemWorkspace({ system: 'CRM', rootDir, services: { registry }, fs: fakeFs });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.workspace.workspaceId, 'ws-crm');
});

test('目录已经是目标目录（用户自己建过）时也复用', async () => {
  const dir = join(rootDir, 'tapd');
  const registry = fakeRegistry([{ workspaceId: 'ws-tapd', path: dir, title: '随便起的名字', sessionIds: [] }]);
  const result = await ensureSystemWorkspace({ system: 'TAPD', rootDir, services: { registry }, fs: fakeFs });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.workspace.workspaceId, 'ws-tapd');
});

test('都没有时：建目录 + 用业务系统名建工作区', async () => {
  const registry = fakeRegistry();
  const dirs = [];
  const result = await ensureSystemWorkspace({
    system: 'CRM',
    rootDir,
    services: { registry },
    fs: { mkdir: async (dir) => { dirs.push(dir); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.workspace.title, 'CRM');
  assert.deepEqual(dirs, [join(rootDir, 'crm')]);
  assert.equal(registry.calls.create.length, 1);
  assert.equal(registry.calls.create[0].path, join(rootDir, 'crm'));
  assert.equal(registry.calls.create[0].title, 'CRM');
});

test('registry 建完不返回 id 时，按目录再查一次拿 id', async () => {
  const registry = fakeRegistry([], { createReturnsNoId: true });
  // 关键：create 之后目录里已经有工作区了，但 list() 还没收录它（真实宿主的时序），
  // 只能靠 resolveByPath 拿到 id。
  registry.resolveByPath = async (dir) => {
    registry.calls.resolveByPath.push(dir);
    return { workspaceId: 'ws-resolved', path: dir, title: 'CRM', sessionIds: [] };
  };
  const result = await ensureSystemWorkspace({ system: 'CRM', rootDir, services: { registry }, fs: fakeFs });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.workspace.workspaceId, 'ws-resolved');
  assert.equal(registry.calls.resolveByPath.length, 1);
});

test('只有 controller 时：create + rename 成业务系统名', async () => {
  const controller = fakeController();
  const result = await ensureSystemWorkspace({ system: '其他', rootDir, services: { controller }, fs: fakeFs });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.workspace.workspaceId, 'ctl-1');
  assert.equal(result.workspace.title, '其他');
  assert.deepEqual(controller.calls.rename, [{ workspaceId: 'ctl-1', title: '其他' }]);
});

test('宿主没有工作区服务时返回可读的失败原因', async () => {
  const result = await ensureSystemWorkspace({ system: 'CRM', rootDir, services: {}, fs: fakeFs });
  assert.equal(result.ok, false);
  assert.match(result.message, /工作区服务/);
});

test('业务系统名为空或没配根目录时拒绝', async () => {
  const registry = fakeRegistry();
  assert.equal((await ensureSystemWorkspace({ system: '   ', rootDir, services: { registry } })).ok, false);
  const noRoot = await ensureSystemWorkspace({ system: 'CRM', rootDir: '', services: { registry } });
  assert.equal(noRoot.ok, false);
  assert.match(noRoot.message, /根目录/);
});

test('自定义业务系统也能拿到稳定目录（同一个名字永远同一个 key）', async () => {
  const registry = fakeRegistry();
  const first = await ensureSystemWorkspace({ system: '供应链中台', rootDir, services: { registry }, fs: fakeFs });
  assert.equal(first.ok, true);
  assert.match(first.key, /^[a-z0-9-]+$/);
  assert.equal(first.workspace.path, join(rootDir, first.key));
  const again = await ensureSystemWorkspace({ system: '供应链中台 ', rootDir, services: { registry }, fs: fakeFs });
  // 第二次已经能按标题命中，不会重复建。
  assert.equal(again.created, false);
  assert.equal(again.workspace.workspaceId, first.workspace.workspaceId);
});
