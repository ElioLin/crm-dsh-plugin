import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createDispatchTable, isTrustedRequest, mountApiRoutes, writeJson } from '../lib/web.js';

function req({ host = '127.0.0.1:53312', method = 'POST', headers = {}, body } = {}) {
  const all = { host, 'content-type': 'application/json', ...headers };
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.headers = all;
  return stream;
}

function res() {
  const captured = { status: 0, headers: undefined, body: undefined };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body;
    },
  };
}

test('只信任回环地址与显式信任的 Host', () => {
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:53312' })), true);
  assert.equal(isTrustedRequest(req({ host: 'localhost:3000' })), true);
  assert.equal(isTrustedRequest(req({ host: 'evil.example.com' })), false);
  assert.equal(isTrustedRequest(req({ host: 'evil.example.com' }), ['evil.example.com']), true);
  assert.equal(isTrustedRequest(req({ host: '' })), false);
});

test('拒绝跨站请求与 Origin 不一致的请求', () => {
  assert.equal(isTrustedRequest(req({ headers: { 'sec-fetch-site': 'cross-site' } })), false);
  assert.equal(
    isTrustedRequest(req({ headers: { origin: 'http://evil.example.com' } })),
    false,
  );
  assert.equal(
    isTrustedRequest(req({ headers: { origin: 'http://127.0.0.1:53312' } })),
    true,
  );
  assert.equal(isTrustedRequest(req({ headers: { origin: 'not a url' } })), false);
});

test('writeJson 写入 no-store 与 nosniff', () => {
  const response = res();
  writeJson(response, 200, { ok: true });
  assert.equal(response.captured.status, 200);
  assert.equal(response.captured.headers['cache-control'], 'no-store');
  assert.equal(response.captured.headers['x-content-type-options'], 'nosniff');
  assert.equal(JSON.parse(String(response.captured.body)).ok, true);
});

test('方法白名单只包含登记过的接口', () => {
  const table = createDispatchTable({});
  assert.deepEqual([...table.keys()].sort(), [
    'activation.activate',
    'activation.clear',
    'activation.state',
    'bootstrap',
    'preview.injection',
    'scenario.delete',
    'scenario.duplicate',
    'scenario.enable',
    'scenario.move',
    'scenario.save',
    'skills.list',
  ]);
});

function mount(api, options = {}) {
  const state = { handler: undefined, disposed: false };
  const wctx = {
    webServer: {
      register(definition) {
        state.handler = definition.handler;
        state.path = definition.path;
        return () => {
          state.disposed = true;
        };
      },
    },
  };
  const dispose = mountApiRoutes(wctx, api, options);
  return { handler: state.handler, path: state.path, dispose, state };
}

test('挂载到 /crm-workspace/api，并转发到对应业务方法', async () => {
  const calls = [];
  const api = {
    async bootstrap(params) {
      calls.push(['bootstrap', params]);
      return { ok: true, scenarios: [] };
    },
  };
  const { handler, path } = mount(api);
  assert.equal(path, '/crm-workspace/api');

  const response = res();
  await handler(req({ body: { method: 'bootstrap', params: { sessions: ['s1', 's2'] } } }), response);
  assert.equal(response.captured.status, 200);
  assert.equal(JSON.parse(String(response.captured.body)).ok, true);
  assert.deepEqual(calls[0], ['bootstrap', { sessions: ['s1', 's2'] }]);
});

test('非回环来源被 403 拒绝，且不会调用业务方法', async () => {
  let called = false;
  const api = {
    async bootstrap() {
      called = true;
      return { ok: true };
    },
  };
  const { handler } = mount(api);
  const response = res();
  await handler(req({ host: 'evil.example.com', body: { method: 'bootstrap' } }), response);
  assert.equal(response.captured.status, 403);
  assert.equal(called, false);
});

test('非 POST、错误 Content-Type、坏 JSON、未知方法都被明确拒绝', async () => {
  const api = { async bootstrap() { return { ok: true }; } };
  const { handler } = mount(api);

  const get = res();
  await handler(req({ method: 'GET' }), get);
  assert.equal(get.captured.status, 405);
  assert.equal(get.captured.headers.allow, 'POST');

  const wrongType = res();
  await handler(req({ headers: { 'content-type': 'text/plain' }, body: { method: 'bootstrap' } }), wrongType);
  assert.equal(wrongType.captured.status, 415);

  const badJson = res();
  const broken = Readable.from([Buffer.from('{ 不是 JSON', 'utf8')]);
  broken.method = 'POST';
  broken.headers = { host: '127.0.0.1:53312', 'content-type': 'application/json' };
  await handler(broken, badJson);
  assert.equal(badJson.captured.status, 400);
  assert.match(JSON.parse(String(badJson.captured.body)).message, /不是合法 JSON/);

  const unknown = res();
  await handler(req({ body: { method: 'scenario.drop' } }), unknown);
  assert.equal(unknown.captured.status, 400);
  assert.match(JSON.parse(String(unknown.captured.body)).message, /未知接口方法/);
});

test('业务异常转成 500，不把堆栈返回给浏览器', async () => {
  const api = {
    async bootstrap() {
      throw new Error('boom');
    },
  };
  const errors = [];
  const { handler } = mount(api, { logger: { error: (line) => errors.push(line) } });
  const response = res();
  await handler(req({ body: { method: 'bootstrap' } }), response);
  assert.equal(response.captured.status, 500);
  const payload = JSON.parse(String(response.captured.body));
  assert.equal(payload.ok, false);
  assert.equal(payload.message, 'boom');
  assert.equal(payload.stack, undefined);
  assert.equal(errors.length, 1);
});

test('业务返回 ok:false 时仍以 200 返回结构化失败', async () => {
  const api = {
    async saveScenario() {
      return { ok: false, errors: [{ field: 'title', message: '标题不能为空' }] };
    },
  };
  const { handler } = mount(api);
  const response = res();
  await handler(req({ body: { method: 'scenario.save', params: { draft: {} } } }), response);
  const payload = JSON.parse(String(response.captured.body));
  assert.equal(response.captured.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].field, 'title');
});

test('disposer 可重复调用不会抛错', () => {
  const { dispose } = mount({ bootstrap: async () => ({}) });
  dispose();
  assert.doesNotThrow(() => dispose());
});
