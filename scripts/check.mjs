#!/usr/bin/env node
/**
 * 零依赖的交付前自检。
 *
 * 这里只检查「装错就会静默失效」的东西：清单字段、被清单引用的文件、
 * 客户端脚本的加载方式、locale 文案、bundle patch 的 id。
 * 更细的行为验证交给 `node --test`。
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checked = [];

function fail(message) {
  problems.push(message);
}

function ok(label) {
  checked.push(label);
}

async function readJson(relative) {
  const text = await readFile(join(root, relative), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${relative} 不是合法 JSON：${error.message}`);
    return undefined;
  }
}

async function exists(relative) {
  try {
    await stat(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = await readJson('package.json');
  if (pkg === undefined) {
    report();
    return;
  }

  const expect = (condition, message) => {
    if (!condition) fail(message);
  };

  expect(pkg.name === 'dsh-crm-workspace', 'package.json name 必须是 dsh-crm-workspace');
  expect(pkg.type === 'module', 'package.json 必须声明 "type": "module"');
  expect(typeof pkg.version === 'string' && pkg.version !== '', 'package.json 缺少 version');
  expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 必须指向 ./cordis.patch.yml');
  expect(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform 必须是 web');
  expect(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject 不能为空');
  expect(pkg.exports?.['.'] === './lib/index.js', 'exports["."] 必须指向 ./lib/index.js');
  expect(pkg.exports?.['./client'] === './lib/client.js', 'exports["./client"] 必须指向 ./lib/client.js');
  expect(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, '运行期不允许有 npm 依赖（DSH 进程只保证宿主模块）');
  ok('package.json 清单字段');

  for (const relative of ['lib/index.js', 'lib/client.js', 'lib/web.js', 'icon.svg', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']) {
    expect(await exists(relative), `清单引用的文件不存在：${relative}`);
  }
  const listed = Array.isArray(pkg.files) ? pkg.files : [];
  for (const required of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml']) {
    expect(listed.includes(required), `package.json files 缺少 ${required}`);
  }
  ok('清单引用的文件与发布白名单');

  const index = await readFile(join(root, 'lib/index.js'), 'utf8');
  expect(/export\s+const\s+name\s*=/.test(index), 'lib/index.js 必须导出插件名 name');
  expect(/export\s+(async\s+)?function\s+apply\s*\(/.test(index), 'lib/index.js 必须导出 apply(ctx, config)');
  expect(index.includes('agent/pre-step'), 'lib/index.js 必须在 agent/pre-step 上注入场景上下文');
  expect(index.includes('/crm-workspace/api'), 'lib/index.js 必须挂载 /crm-workspace/api');
  ok('Host 入口导出与挂载点');

  const constants = await readFile(join(root, 'lib/core/constants.js'), 'utf8');
  const registry = await readFile(join(root, 'lib/core/registry.js'), 'utf8');
  expect(
    constants.includes('http://crmmcptest.runner-corp.com.cn:9000'),
    'constants.js 的默认 MCP 地址必须是 http://crmmcptest.runner-corp.com.cn:9000',
  );
  expect(registry.includes('/api/dsh/scenarios'), 'registry.js 必须按 /api/dsh 契约调用标准场景接口');
  expect(registry.includes('includeDeleted=true'), 'registry.js 同步必须请求 includeDeleted=true');
  expect(!registry.includes('createdAt: '), 'registry.js 不得主动构造 createdAt 字段');
  ok('MCP 控制平面契约');

  const client = await readFile(join(root, 'lib/client.js'), 'utf8');
  expect(client.includes('__ModuleLoader__.load'), 'lib/client.js 必须通过 window.__ModuleLoader__.load 注册');
  expect(!/^\s*(import|export)\s/m.test(client), 'lib/client.js 是经典脚本，不能出现 import/export 语句');
  expect(/require\(['"]react['"]\)/.test(client), 'lib/client.js 必须用 require("react") 取得 React');
  expect(client.includes("name: 'main'") || client.includes('name:"main"'), 'lib/client.js 必须注册 main 面板');
  expect(client.includes('sidebar.panellist'), 'lib/client.js 必须注册 sidebar.panellist 入口');
  expect(client.includes('🟢 正在使用场景：【'), 'lib/client.js 必须在输入框上方展示「正在使用场景」标识');
  expect(client.includes('设为插件标准场景'), 'lib/client.js 必须提供「设为插件标准场景」勾选框');
  expect(client.includes('复制为本地场景'), 'lib/client.js 必须提供「复制为本地场景」动作');
  const hex = client.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(hex.length === 0, `lib/client.js 不允许硬编码颜色（发现 ${hex.slice(0, 3).join(', ')}），请使用 --dsw-alias-* 变量`);
  ok('客户端脚本加载方式与主题变量');

  for (const lang of ['zh', 'en']) {
    const dict = await readJson(`locale/${lang}.json`);
    if (dict === undefined) continue;
    expect(typeof dict.meta?.title === 'string' && dict.meta.title !== '', `locale/${lang}.json 缺少 meta.title`);
    expect(typeof dict.meta?.description === 'string' && dict.meta.description !== '', `locale/${lang}.json 缺少 meta.description`);
  }
  ok('locale 文案');

  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  expect(/id:\s*crm-workspace/.test(patch), 'cordis.patch.yml 缺少 id: crm-workspace');
  expect(/name:\s*['"]?dsh-crm-workspace/.test(patch), 'cordis.patch.yml 的 name 必须是 dsh-crm-workspace');
  expect(/apiBaseUrl:\s*['"]?http:\/\/crmmcptest\.runner-corp\.com\.cn:9000/.test(patch), 'cordis.patch.yml 必须配置默认 apiBaseUrl');
  ok('bundle patch');

  report();
}

function report() {
  if (problems.length === 0) {
    for (const label of checked) console.log(`  ✓ ${label}`);
    console.log(`\n自检通过（${checked.length} 组）。`);
    return;
  }
  for (const label of checked) console.log(`  ✓ ${label}`);
  console.error('');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n自检失败：${problems.length} 个问题。`);
  process.exitCode = 1;
}

await main();
