import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { apply, cloneWithText, normalizeConfig } from '../lib/index.js';

const scenarioDraft = {
  title: 'CRM 单据新建与修改',
  description: '按单据类型新建或修改记录，自动处理必填项与字段权限。',
  icon: 'briefcase',
  category: '核心单据管控',
  slashCommand: '/record',
  enabled: true,
  pinnedSkills: ['crm-core'],
  prePinnedContext: { defaultAction: 'CREATE', formContextEntry: 'STANDARD', allowAttachments: true },
  welcomeMessage: '请描述你要新建的单据。',
};

/** 极简 Cordis 替身：只实现 apply() 用到的 effect / on / inject / reflect.get。 */
function fakeContext({ skills } = {}) {
  const handlers = new Map();
  const routes = [];
  const commands = [];
  const disposers = [];
  const logs = [];

  const logger = {
    info: (line) => logs.push(['info', line]),
    warn: (line) => logs.push(['warn', line]),
    error: (line) => logs.push(['error', line]),
  };

  const base = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => undefined;
    },
    inject(deps, callback) {
      const child = { ...base };
      if (deps.includes('webServer')) {
        child.webServer = {
          register(definition) {
            routes.push(definition);
            return () => undefined;
          },
        };
      }
      if (deps.includes('webStartup')) child.webStartup = { trustedHosts: [] };
      if (deps.includes('commands')) {
        child.commands = {
          register(definition) {
            commands.push(definition);
            return () => undefined;
          },
        };
      }
      callback(child);
    },
    reflect: {
      get(name) {
        if (name === 'logger') return logger;
        if (name === 'skills') return skills;
        return undefined;
      },
    },
    get() {
      return undefined;
    },
  };
  return { ctx: base, handlers, routes, commands, logs, logger };
}

function fakeReq(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = 'POST';
  stream.headers = { host: '127.0.0.1:53312', 'content-type': 'application/json' };
  return stream;
}

function fakeRes() {
  const captured = { status: 0, body: undefined };
  return {
    captured,
    writeHead(status) {
      captured.status = status;
    },
    end(body) {
      captured.body = body;
    },
  };
}

async function callRoute(route, method, params) {
  const response = fakeRes();
  await route.handler(fakeReq({ method, params }), response);
  return { status: response.captured.status, payload: JSON.parse(String(response.captured.body)) };
}

async function boot(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'crm-workspace-apply-'));
  const skills = overrides.skills ?? {
    async list() {
      return [{ name: 'crm-core', description: 'CRM 通用运行指导' }];
    },
    async get(name) {
      return name === 'crm-core' ? { name, description: '通用', content: 'BODY' } : undefined;
    },
  };
  const harness = fakeContext({ skills });
  // 关掉磁盘目录兜底：否则测试结果会随开发机上的 ~/.dsh/skills 内容漂移。
  await apply(harness.ctx, { dataDir, skillCatalogDir: 'off', ...overrides.config });
  return { ...harness, dataDir };
}

test('normalizeConfig 收敛路径与布尔开关', () => {
  const config = normalizeConfig({ dataDir: 'crm-x', maxScenarioCards: 9999, injectSkillsOnStep: false });
  assert.equal(config.maxScenarioCards, 200);
  assert.equal(config.injectSkillsOnStep, false);
  assert.equal(config.registerSlashCommands, true);
  assert.ok(config.dataDir.endsWith('crm-x'));
  assert.ok(normalizeConfig(undefined).dataDir.endsWith('crm-workspace'));
});

test('cloneWithText 保留原消息结构，只替换文本与 id', () => {
  const source = { id: 'm1', role: 'user', source: { kind: 'user' }, content: 'hello' };
  const cloned = cloneWithText(source, 'block', 'a');
  assert.deepEqual(cloned, { id: 'm1-crm-a', role: 'user', source: { kind: 'user' }, content: 'block' });
  assert.equal(source.content, 'hello');
  const rich = cloneWithText({ id: 'm2', content: [{ type: 'text', text: 'x' }, { type: 'image' }] }, 'block', 'b');
  assert.deepEqual(rich.content, [{ type: 'text', text: 'block' }]);
  assert.equal(cloneWithText(null, 'x', 'c'), undefined);
  assert.equal(cloneWithText({ id: 'm3' }, 'x', 'd'), undefined);
});

test('启动即挂载 /crm-workspace/api，并能完成建卡 → 激活 → 注入闭环', async () => {
  const app = await boot({ config: { injectSkillBodies: true } });
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  assert.ok(route !== undefined, '未挂载 HTTP 接口');
  assert.equal(route.kind, 'prefix');

  const created = await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  assert.equal(created.payload.ok, true, JSON.stringify(created.payload));

  const activated = await callRoute(route, 'activation.activate', { sessionId: 'session-a', scenarioId: created.payload.card.scenarioId });
  assert.equal(activated.payload.ok, true);

  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: '帮我新建一张工单' }] };
  const injected = await handler({ agent: { id: 'session-a' } }, async () => decision);
  assert.equal(injected.messages.length, 2);
  assert.ok(injected.messages[1].content.includes('[[crm-workspace:context]]'));
  assert.ok(injected.messages[1].content.includes('BODY'));
  assert.equal(injected.messages[1].role, 'user');
  assert.notEqual(injected.messages[1].id, 'u1');

  const second = await handler({ agent: { id: 'session-a' } }, async () => decision);
  assert.ok(second.messages[1].content.includes('mode=reminder'));
  assert.ok(!second.messages[1].content.includes('BODY'));

  const untouched = await handler({ agent: { id: 'session-b' } }, async () => decision);
  assert.equal(untouched.messages.length, 1);
});

test('默认注入只有场景与技能名称，正文交给 skill 工具加载', async () => {
  const app = await boot();
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  const created = await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  await callRoute(route, 'activation.activate', { sessionId: 'session-n', scenarioId: created.payload.card.scenarioId });

  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: 'hi' }] };
  const out = await handler({ agent: { id: 'session-n' } }, async () => decision);
  assert.equal(out.messages.length, 2);
  const text = out.messages[1].content;
  assert.match(text, /mode=names/);
  assert.match(text, /1\. crm-core/);
  assert.ok(!text.includes('BODY'));
  assert.ok(!text.includes('CRM 通用运行指导'));
  assert.ok([...text].length < 1500);

  const boot2 = await callRoute(route, 'bootstrap', {});
  assert.equal(boot2.payload.config.injectSkillBodies, false);
});

test('没有激活场景时不改动请求，reject 决策原样返回', async () => {
  const app = await boot();
  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: 'hi' }] };
  const same = await handler({ agent: { id: 'x' } }, async () => decision);
  assert.equal(same.messages.length, 1);

  const rejected = { kind: 'reject' };
  assert.equal(await handler({ agent: { id: 'x' } }, async () => rejected), rejected);
});

test('启用中的卡片注册为 Host 指令，执行时激活场景并返回技能栈', async () => {
  const app = await boot();
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  await callRoute(route, 'scenario.save', { draft: scenarioDraft });

  const names = app.commands.map((command) => command.name);
  assert.ok(names.includes('record'), `未注册 record：${names.join(',')}`);
  assert.ok(names.includes('crm'));

  const command = app.commands.find((item) => item.name === 'record');
  assert.equal(command.description, '场景：CRM 单据新建与修改');
  const result = await command.handler({ agent: { id: 'session-c' } });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已切换到「CRM 单据新建与修改」场景/);
  assert.match(result.text, /crm-core/);

  const bypass = await command.handler({});
  assert.equal(bypass.kind, 'error');

  const list = await app.commands.find((item) => item.name === 'crm').handler({});
  assert.match(list.text, /可用场景/);
  assert.match(list.text, /\/record/);
});

test('停用的卡片不注册指令；关闭注册开关后一条也不注册', async () => {
  const app = await boot();
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  const created = await callRoute(route, 'scenario.save', { draft: { ...scenarioDraft, enabled: false } });
  assert.equal(created.payload.ok, true);
  assert.equal(app.commands.filter((item) => item.name === 'record').length, 0);

  const off = await boot({ config: { registerSlashCommands: false } });
  assert.equal(off.commands.length, 0);
});

test('关闭注入开关后即使激活也不注入', async () => {
  const app = await boot({ config: { injectSkillsOnStep: false } });
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  const created = await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  await callRoute(route, 'activation.activate', { sessionId: 's', scenarioId: created.payload.card.scenarioId });
  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: 'hi' }] };
  const out = await handler({ agent: { id: 's' } }, async () => decision);
  assert.equal(out.messages.length, 1);
});

test('Skill 服务抛错时注入仍可用（只给名称，不假装已加载）', async () => {
  const app = await boot({
    config: { injectSkillBodies: true },
    skills: {
      async list() {
        throw new Error('boom');
      },
      async get() {
        throw new Error('boom');
      },
    },
  });
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  const created = await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  await callRoute(route, 'activation.activate', { sessionId: 's', scenarioId: created.payload.card.scenarioId });
  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: 'hi' }] };
  const out = await handler({ agent: { id: 's' } }, async () => decision);
  assert.equal(out.messages.length, 2);
  assert.match(out.messages[1].content, /未预载正文/);
});

test('数据目录随配置落盘，重启后场景仍在', async () => {
  const app = await boot();
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  const boot2 = fakeContext({
    skills: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
    },
  });
  await apply(boot2.ctx, { dataDir: app.dataDir });
  const route2 = boot2.routes.find((item) => item.path === '/crm-workspace/api');
  const bootstrap = await callRoute(route2, 'bootstrap', {});
  assert.equal(bootstrap.payload.scenarios.length, 1);
  assert.equal(bootstrap.payload.scenarios[0].title, scenarioDraft.title);
});

test('模型请求阶段优先使用带作用域的 Skill 视图', async () => {
  // 根视图看不到 crm-core（注册表分层：preset 层才有），派发作用域里能看到正文。
  const app = await boot({
    config: { injectSkillBodies: true },
    skills: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
    },
  });
  const route = app.routes.find((item) => item.path === '/crm-workspace/api');
  const created = await callRoute(route, 'scenario.save', { draft: scenarioDraft });
  await callRoute(route, 'activation.activate', { sessionId: 's', scenarioId: created.payload.card.scenarioId });

  const scoped = {
    async list() {
      return [{ name: 'crm-core', description: 'CRM 通用运行指导' }];
    },
    async get(name) {
      return name === 'crm-core' ? { name, description: '通用', content: 'SCOPED-BODY' } : undefined;
    },
  };
  const handler = app.handlers.get('agent/pre-step')[0];
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user', content: 'hi' }] };
  const out = await handler.call(
    { get: (key) => (key === 'skills' ? scoped : undefined) },
    { agent: { id: 's' } },
    async () => decision,
  );
  assert.equal(out.messages.length, 2);
  assert.match(out.messages[1].content, /### crm-core\nSCOPED-BODY/);
  assert.doesNotMatch(out.messages[1].content, /未预载正文/);
});
