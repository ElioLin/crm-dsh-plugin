import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  createUpdater,
  isNewer,
  normalizeRegistry,
  parseVersion,
  readNpmrc,
  resolveRegistry,
} from '../lib/core/updater.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'crm-workspace-updater-'));
}

/** 造一个只回答固定 JSON 的 fetch；记录调用次数，用来验证缓存生效。 */
function fakeFetch(payload, { status = 200, calls = { count: 0 }, onCall } = {}) {
  const impl = async (url, init) => {
    calls.count += 1;
    calls.lastUrl = url;
    calls.lastInit = init;
    onCall?.(url, init, calls.count);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (payload instanceof Error) throw payload;
        return payload;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function makeUpdater(overrides = {}) {
  return createUpdater({
    name: '@runner-corp/dsh-scenario-workspace',
    version: '1.11.1',
    registry: 'https://npm.corp.example/repo/',
    install: async () => ({ application: 'applied', changed: true, stage: 'install', target: 'x' }),
    env: {},
    profileDir: '',
    homeDir: '',
    ...overrides,
  });
}

/* ── 版本比较 ─────────────────────────────────────────────────── */

test('版本解析接受常见写法，拒绝非语义化版本', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('v2.0.0-beta.1').prerelease, ['beta', '1']);
  assert.deepEqual(parseVersion('1.0.0+build.5').prerelease, []);
  assert.equal(parseVersion('link:../foo'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('1.2'), null);
});

test('版本比较遵循 semver：正式版高于预发布，预发布按段比较', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.1'), 1);
  assert.equal(compareVersions('1.2.0-beta', '1.2.0-beta.1'), -1);
  assert.equal(compareVersions('1.2.0-alpha.10', '1.2.0-alpha.9'), 1);
  // 数字段低于同位置的字母段
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  // 解析不了时返回 null，由调用方判定「无法比较」
  assert.equal(compareVersions('1.11.1', 'link:..'), null);
});

test('isNewer 只认「严格更新」，相等与非版本一律 false', () => {
  assert.equal(isNewer('1.12.0', '1.11.1'), true);
  assert.equal(isNewer('1.11.1', '1.11.1'), false);
  assert.equal(isNewer('1.11.0', '1.11.1'), false);
  assert.equal(isNewer('not-a-version', '1.11.1'), false);
});

/* ── registry 与凭据 ─────────────────────────────────────────── */

test('registry 规范化：补协议、去重斜杠、保留子路径', () => {
  assert.equal(normalizeRegistry('https://npm.corp.example/repo'), 'https://npm.corp.example/repo/');
  assert.equal(normalizeRegistry('npm.corp.example/'), 'https://npm.corp.example/');
  assert.equal(normalizeRegistry('  '), '');
  assert.equal(normalizeRegistry('ftp://x'), '');
});

test('.npmrc 能读出 registry 与按 host 配的 token', async () => {
  const dir = await tempDir();
  const file = join(dir, '.npmrc');
  await writeFile(
    file,
    ['registry=https://npm.corp.example/repo/', '//npm.corp.example/repo/:_authToken=secret-token', '# 注释'].join('\n'),
    'utf8',
  );
  const parsed = readNpmrc(file);
  assert.equal(parsed.registry, 'https://npm.corp.example/repo/');
  const resolved = resolveRegistry({ profileDir: dir, env: {} });
  assert.equal(resolved.registry, 'https://npm.corp.example/repo/');
  assert.equal(resolved.token, 'secret-token');
  assert.equal(resolved.source, 'private');
});

test('registry 优先级：显式配置 > 环境变量 > .npmrc > 官方源', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, '.npmrc'), 'registry=https://from-npmrc.example/\n', 'utf8');

  assert.equal(
    resolveRegistry({ configured: 'https://explicit.example/', profileDir: dir, env: {} }).registry,
    'https://explicit.example/',
  );
  assert.equal(
    resolveRegistry({ profileDir: dir, env: { DSH_PLUGIN_REGISTRY: 'https://from-env.example/' } }).registry,
    'https://from-env.example/',
  );
  assert.equal(resolveRegistry({ profileDir: dir, env: {} }).registry, 'https://from-npmrc.example/');
  assert.equal(resolveRegistry({ env: {} }).registry, 'https://registry.npmjs.org/');
});

/* ── 检查更新 ─────────────────────────────────────────────────── */

test('有新版本时 updateAvailable 为真，并带上说明', async () => {
  const updater = makeUpdater({
    fetch: fakeFetch({ version: '1.12.0', description: '修了三个问题' }),
  });
  const result = await updater.check();
  assert.equal(result.ok, true);
  assert.equal(result.current, '1.11.1');
  assert.equal(result.latest, '1.12.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.notes, '修了三个问题');
  assert.equal(result.skipped, false);
});

test('同版本或更旧版本都不提示升级', async () => {
  const same = await makeUpdater({ fetch: fakeFetch({ version: '1.11.1' }) }).check();
  assert.equal(same.updateAvailable, false);

  const older = await makeUpdater({ fetch: fakeFetch({ version: '1.11.0' }) }).check();
  assert.equal(older.updateAvailable, false);
});

test('检查结果在 TTL 内复用，force 才重新请求', async () => {
  const fetchImpl = fakeFetch({ version: '1.12.0' });
  const updater = makeUpdater({ fetch: fetchImpl });
  const first = await updater.check();
  assert.equal(first.cached, undefined);
  assert.equal(fetchImpl.calls.count, 1);

  const second = await updater.check();
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.count, 1);

  await updater.check({ force: true });
  assert.equal(fetchImpl.calls.count, 2);
});

test('并发的两次检查只打一次 registry', async () => {
  const fetchImpl = fakeFetch({ version: '1.12.0' });
  const updater = makeUpdater({ fetch: fetchImpl });
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(fetchImpl.calls.count, 1);
  assert.equal(a.latest, b.latest);
});

test('包名进 URL 时斜杠要转义', async () => {
  const fetchImpl = fakeFetch({ version: '1.12.0' });
  const updater = makeUpdater({ name: '@corp/dsh-thing', fetch: fetchImpl });
  await updater.check();
  assert.equal(fetchImpl.calls.lastUrl, 'https://npm.corp.example/repo/@corp%2fdsh-thing/latest');
});

test('检查失败只降级，不抛错，也不提示升级', async () => {
  const network = await makeUpdater({
    fetch: async () => {
      throw new Error('offline');
    },
  }).check();
  assert.equal(network.ok, false);
  assert.equal(network.updateAvailable, false);
  assert.match(network.message, /查询 registry 失败/);

  const unauthorized = await makeUpdater({
    fetch: fakeFetch({}, { status: 401 }),
  }).check();
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.message, /_authToken/);

  const missing = await makeUpdater({ fetch: fakeFetch({}, { status: 404 }) }).check();
  assert.equal(missing.ok, false);
  assert.match(missing.message, /没有找到/);

  const broken = await makeUpdater({ fetch: fakeFetch(new Error('bad json')) }).check();
  assert.equal(broken.ok, false);
});

test('当前版本不是语义化版本时只报事实，不给升级按钮', async () => {
  const result = await makeUpdater({ version: 'link:../local', fetch: fakeFetch({ version: '1.12.0' }) }).check();
  assert.equal(result.ok, true);
  assert.equal(result.comparable, false);
  assert.equal(result.updateAvailable, false);
  assert.match(result.message, /不是标准语义化版本/);
});

/* ── 跳过版本 ─────────────────────────────────────────────────── */

test('跳过某个版本后仍然报告新版本，但标记 skipped', async () => {
  const dir = await tempDir();
  const stateFile = join(dir, 'updater.json');
  const updater = makeUpdater({ stateFile, fetch: fakeFetch({ version: '1.12.0' }) });

  await updater.check();
  const skipped = updater.skip('1.12.0');
  assert.equal(skipped.ok, true);

  const again = await updater.check({ force: true });
  assert.equal(again.updateAvailable, true);
  assert.equal(again.skipped, true);

  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(saved.skippedVersion, '1.12.0');

  // 新实例从磁盘读回「跳过」，重启后不该再提醒同一个版本
  const reopened = makeUpdater({ stateFile, fetch: fakeFetch({ version: '1.12.0' }) });
  assert.equal((await reopened.check()).skipped, true);
});

/* ── 升级 ─────────────────────────────────────────────────────── */

test('apply 调用宿主安装并跑到 done', async () => {
  const specs = [];
  const updater = makeUpdater({
    fetch: fakeFetch({ version: '1.12.0' }),
    install: async (spec) => {
      specs.push(spec);
      return { application: 'applied', changed: true, stage: 'install', target: spec };
    },
  });

  const started = await updater.apply();
  assert.equal(started.ok, true);
  assert.equal(started.phase, 'installing');
  assert.equal(started.target, '1.12.0');

  // 后台任务：等它落到终态
  for (let index = 0; index < 50 && updater.status().phase === 'installing'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const status = updater.status();
  assert.equal(status.phase, 'done');
  assert.deepEqual(specs, ['@runner-corp/dsh-scenario-workspace@1.12.0']);
  assert.match(status.message, /重启/);
});

test('宿主报 restart-required 时仍然算装上了，并提示重启', async () => {
  const updater = makeUpdater({
    fetch: fakeFetch({ version: '1.12.0' }),
    install: async () => ({ application: 'restart-required', changed: true, stage: 'install', target: 'x' }),
  });
  await updater.apply();
  for (let index = 0; index < 50 && updater.status().phase === 'installing'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(updater.status().phase, 'done');
  assert.equal(updater.status().restartRequired, true);
});

test('安装失败暴露失败原因，不谎报成功', async () => {
  const updater = makeUpdater({
    fetch: fakeFetch({ version: '1.12.0' }),
    install: async () => ({
      application: 'failed',
      changed: false,
      stage: 'install',
      target: 'x',
      error: { message: 'pnpm 退出码 1' },
    }),
  });
  await updater.apply();
  for (let index = 0; index < 50 && updater.status().phase === 'installing'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const status = updater.status();
  assert.equal(status.phase, 'failed');
  assert.equal(status.message, 'pnpm 退出码 1');
});

test('install 抛错时收敛成 failed，不产生未处理异常', async () => {
  const updater = makeUpdater({
    fetch: fakeFetch({ version: '1.12.0' }),
    install: async () => {
      throw new Error('没有 pluginManager');
    },
  });
  await updater.apply();
  for (let index = 0; index < 50 && updater.status().phase === 'installing'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(updater.status().phase, 'failed');
  assert.match(updater.status().message, /没有 pluginManager/);
});

test('没有新版本 / 检查失败时 apply 拒绝启动安装', async () => {
  let called = false;
  const upToDate = makeUpdater({
    fetch: fakeFetch({ version: '1.11.1' }),
    install: async () => {
      called = true;
      return { application: 'applied' };
    },
  });
  const refused = await upToDate.apply();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /已是最新版本/);
  assert.equal(called, false);

  const broken = makeUpdater({
    fetch: async () => {
      throw new Error('offline');
    },
    install: async () => {
      called = true;
      return { application: 'applied' };
    },
  });
  const failed = await broken.apply();
  assert.equal(failed.ok, false);
  assert.equal(called, false);
});
