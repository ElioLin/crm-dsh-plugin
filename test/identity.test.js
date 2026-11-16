import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createInternalCredentialResolver, normalizeConfig } from '../lib/index.js';

/** 造一个只含 identity.json 的 DSH 家目录。 */
async function homeWithIdentity(record) {
  const home = await mkdtemp(join(tmpdir(), 'crmw-identity-'));
  await writeFile(join(home, 'identity.json'), JSON.stringify(record), 'utf8');
  return home;
}

test('登录身份：从 identity.json 的 salary_id 得到平台用户标识', async () => {
  const home = await homeWithIdentity({ salary_id: '61979', updated_at: 1794203432 });
  const resolve = createInternalCredentialResolver(normalizeConfig({}), {
    env: { DSH_HOME: home, CRM_MCP_CLIENT_TOKEN: 'shared-token' },
  });
  const credential = await resolve();
  assert.deepEqual(credential, {
    mcpClientToken: 'shared-token',
    platformUserId: '61979',
    source: 'env+identity',
  });
});

test('登录身份：没有客户端 Token 时返回 null（调用方回退 Buntu 模式）', async () => {
  const home = await homeWithIdentity({ salary_id: '61979' });
  const resolve = createInternalCredentialResolver(normalizeConfig({}), { env: { DSH_HOME: home } });
  assert.equal(await resolve(), null);
});

test('登录身份：有客户端 Token 但没有身份文件时也返回 null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'crmw-identity-'));
  const resolve = createInternalCredentialResolver(normalizeConfig({}), {
    env: { DSH_HOME: home, CRM_MCP_CLIENT_TOKEN: 'shared-token' },
  });
  assert.equal(await resolve(), null);
});

test('登录身份：显式配置优先于环境变量与身份文件', async () => {
  const home = await homeWithIdentity({ salary_id: '61979' });
  const config = normalizeConfig({
    authMode: 'internal_bearer',
    mcpClientToken: 'config-token',
    platformUserId: '42',
  });
  const resolve = createInternalCredentialResolver(config, {
    env: { DSH_HOME: home, CRM_MCP_CLIENT_TOKEN: 'env-token' },
  });
  assert.deepEqual(await resolve(), {
    mcpClientToken: 'config-token',
    platformUserId: '42',
    source: 'config+config',
  });
});

test('登录身份：authMode=buntu 时不解析内部凭据', async () => {
  const home = await homeWithIdentity({ salary_id: '61979' });
  const config = normalizeConfig({ authMode: 'buntu', platformUserId: '42' });
  const resolve = createInternalCredentialResolver(config, {
    env: { DSH_HOME: home, CRM_MCP_CLIENT_TOKEN: 'env-token' },
  });
  assert.equal(await resolve(), null);
});

test('登录身份：身份字段兼容多种命名，数字也接受', async () => {
  const home = await homeWithIdentity({ user_id: '', employeeId: 12345 });
  const resolve = createInternalCredentialResolver(normalizeConfig({}), {
    env: { DSH_HOME: home, MCP_CLIENT_TOKEN: 'shared-token' },
  });
  assert.equal((await resolve())?.platformUserId, '12345');
});

test('登录身份：运行期写进 .env 的客户端 Token 也会被读到', async () => {
  const home = await homeWithIdentity({ salary_id: '61979' });
  await writeFile(
    join(home, '.env'),
    ['# 本地部署配置', 'CRM_MCP_CLIENT_TOKEN="from-dotenv"', '', 'DIFY_BASE_URL=https://dify.example.com'].join('\n'),
    'utf8',
  );
  const resolve = createInternalCredentialResolver(normalizeConfig({}), { env: { DSH_HOME: home } });
  assert.deepEqual(await resolve(), {
    mcpClientToken: 'from-dotenv',
    platformUserId: '61979',
    source: 'env+identity',
  });
});

test('登录身份：进程环境变量优先于 .env 文件', async () => {
  const home = await homeWithIdentity({ salary_id: '61979' });
  await writeFile(join(home, '.env'), 'CRM_MCP_CLIENT_TOKEN=from-dotenv\n', 'utf8');
  const resolve = createInternalCredentialResolver(normalizeConfig({}), {
    env: { DSH_HOME: home, CRM_MCP_CLIENT_TOKEN: 'from-process' },
  });
  assert.equal((await resolve())?.mcpClientToken, 'from-process');
});
