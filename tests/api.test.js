const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Prisma } = require('@prisma/client');

function createApiHarness(fetchImpl) {
  const values = new Map();
  const events = [];
  const window = { dispatchEvent: (event) => events.push(event) };
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const context = {
    window,
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) },
    fetch: fetchImpl,
    Headers,
    URLSearchParams,
    CustomEvent,
    Date,
    console,
    Set,
    Error,
    JSON,
    encodeURIComponent
  };
  const source = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'js/api.js' });
  return { api: window.pulseAPI, values, events };
}

test('request attaches the bearer token and parses JSON', async () => {
  let observed;
  const { api, values } = createApiHarness(async (_url, options) => {
    observed = options;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  values.set('pulsecord_access_token', 'test-token');
  const result = await api.request('/auth/me');
  assert.equal(result.ok, true);
  assert.equal(observed.headers.get('Authorization'), 'Bearer test-token');
});

test('401 clears the saved access token, dispatches expiration, and rejects', async () => {
  const { api, values, events } = createApiHarness(async () => new Response(JSON.stringify({ error: 'Invalid or expired access token' }), { status: 401 }));
  values.set('pulsecord_access_token', 'expired');
  await assert.rejects(api.request('/tables/messages'), /Invalid or expired access token/);
  assert.equal(values.has('pulsecord_access_token'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pulsecord:auth-expired');
});

test('list encodes resource path and includes paging parameters', async () => {
  let url;
  const { api } = createApiHarness(async (requestUrl) => {
    url = requestUrl;
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const rows = await api.list('voice sessions', { page: 2, limit: 25, search: 'hello world' });
  assert.equal(rows.length, 1);
  assert.match(url, /^\/tables\/voice%20sessions\?/);
  assert.match(url, /page=2/);
  assert.match(url, /limit=25/);
  assert.match(url, /search=hello\+world/);
});

test('create, patch, and delete persist through the HTTP method and emit mutation events', async () => {
  const requests = [];
  const { api } = createApiHarness(async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const result = options.method === 'PATCH' ? { id: 'm1', content: 'updated' } : { id: 'm1', content: 'hello' };
    return new Response(JSON.stringify(result), { status: options.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  });
  const events = [];
  api.onEvent((event) => events.push(event));
  await api.create('messages', { id: 'm1', content: 'hello' });
  await api.patch('messages', 'm1', { content: 'updated' });
  await api.remove('messages', 'm1');
  assert.deepEqual(requests.map((r) => r.method), ['POST', 'PATCH', 'DELETE']);
  assert.equal(JSON.parse(requests[0].body).content, 'hello');
  assert.deepEqual(events.map((event) => event.payload.action), ['create', 'patch', 'delete']);
});

test('inline UI app handlers resolve to implemented class methods', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const methods = new Set([...appSource.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]));
  const handlers = new Set([...appSource.matchAll(/app\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
  const missing = [...handlers].filter((name) => !methods.has(name));
  assert.deepEqual(missing, []);
});

test('backend orderBy fields exist on every Prisma model, including joinedAt exceptions', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const mappingBlock = backend.match(/const tableOrderFields:[^{]+\{([\s\S]*?)\n\};/);
  assert.ok(mappingBlock, 'tableOrderFields mapping must exist');
  const tableToModel = {
    users: 'User', servers: 'Server', roles: 'Role', server_members: 'ServerMember', channels: 'Channel',
    messages: 'Message', direct_messages: 'DirectMessage', friends: 'Friend', voice_sessions: 'VoiceSession',
    audit_logs: 'AuditLog', notifications: 'Notification'
  };
  const mapping = Object.fromEntries([...mappingBlock[1].matchAll(/([a-z_]+): '(createdAt|joinedAt)'/g)].map((m) => [m[1], m[2]]));
  const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, new Set(model.fields.map((field) => field.name))]));
  assert.deepEqual(Object.keys(mapping).sort(), Object.keys(tableToModel).sort());
  for (const [table, modelName] of Object.entries(tableToModel)) assert.ok(models.get(modelName)?.has(mapping[table]), `${table} must order by a field on ${modelName}`);
  assert.equal(mapping.server_members, 'joinedAt');
  assert.equal(mapping.voice_sessions, 'joinedAt');
  assert.equal(mapping.messages, 'createdAt');
});
