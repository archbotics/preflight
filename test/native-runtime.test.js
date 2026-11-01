import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

async function runtime(t, source, durableObjects) {
  const {outputFiles} = await build({absWorkingDir: root, ...source,
    bundle: true, write: false, format: 'esm', platform: 'browser'});
  let outboundRequests = 0;
  const mf = new Miniflare(await convertV4MiniflareOptions({
    modules: true, script: outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    durableObjects, bindings: {...config.vars, DAILY_SCAN_LIMIT: '3'},
    // No target or DNS traffic is permitted from these local fixtures.
    outboundService() { outboundRequests++; return new Response('Unexpected outbound request', {status: 502}); },
  }));
  // Default storage is temporary; disposal also stops workerd and future alarms.
  t.after(async () => { await mf.dispose(); assert.equal(outboundRequests, 0); });
  return mf;
}

test('configured Worker entry starts in workerd without invalid runtime exports', {timeout: 5000}, async t => {
  const durableObjects = Object.fromEntries(config.durable_objects.bindings.map(binding => [binding.name, {
    className: binding.class_name,
    useSQLite: config.migrations.some(migration => migration.new_sqlite_classes?.includes(binding.class_name)),
  }]));
  const mf = await runtime(t, {entryPoints: [config.main]}, durableObjects);
  const response = await mf.dispatchFetch('https://fixture.invalid/api/health');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.version, 'string');
  assert.equal(health.enabled, config.vars.SERVICE_ENABLED === 'true');
});

// The subclass only seeds/observes storage and records alarm completion. The
// reservation, report, deletion, expiry and alarm behavior are the real Control.
const fixture = `
import {Control} from './src/control.js';
export class FixtureControl extends Control {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/seed') {
      const now = Date.now(), future = now + 60000;
      await this.state.storage.put({
        'report:expired': {fixture: 'expired'},
        ['expires:' + (now - 1000) + ':expired']: true,
        'report:future': {fixture: 'future'},
        ['expires:' + future + ':future']: true,
        'day:2000-01-01': {started: 1},
      });
      await this.state.storage.setAlarm(now + 20);
      return Response.json({future});
    }
    if (path === '/fixture/inspect') {
      return Response.json({entries: [...await this.state.storage.list()], alarm: await this.state.storage.getAlarm()});
    }
    return super.fetch(request);
  }
  async alarm() {
    await super.alarm();
    await this.state.storage.put('fixture:alarm-ran', true);
  }
}
export default {fetch(request, env) {
  return env.CONTROL.get(env.CONTROL.idFromName('native-fixture')).fetch(request);
}};
`;

test('native SQLite transactions enforce caps and deletion; actual alarm removes expired data', {timeout: 5000}, async t => {
  const mf = await runtime(t, {stdin: {contents: fixture, resolveDir: root}}, {
    CONTROL: {className: 'FixtureControl', useSQLite: true},
  });
  const request = (path, data, options = {}) => mf.dispatchFetch(`https://fixture.invalid${path}`, {
    ...(data ? {method: 'POST', body: JSON.stringify(data)} : {}), ...options,
  });
  const reservations = await Promise.all(Array.from({length: 12}, () => request('/reserve', {})));
  assert.equal(reservations.filter(response => response.status === 200).length, 3);
  assert.equal(reservations.filter(response => response.status === 429).length, 9);

  const id = 'a'.repeat(32), deleteHash = 'b'.repeat(64), report = {title: 'Harmless native fixture'};
  const created = await request('/reports', {id, report, deleteHash});
  assert.equal(created.status, 201);
  const {expiresAt} = await created.json();
  const initial = await (await request('/fixture/inspect')).json();
  assert.equal(initial.alarm, Date.parse(expiresAt));
  assert.deepEqual((await (await request(`/reports/${id}`)).json()).report, report);
  assert.equal((await request(`/reports/${id}`, null, {
    method: 'DELETE', headers: {'x-delete-hash': 'c'.repeat(64)},
  })).status, 403);
  assert.equal((await request(`/reports/${id}`, null, {
    method: 'DELETE', headers: {'x-delete-hash': deleteHash},
  })).status, 200);
  assert.equal((await request(`/reports/${id}`)).status, 404);
  const deleted = new Map((await (await request('/fixture/inspect')).json()).entries);
  assert.equal(deleted.has(`report:${id}`), false);
  assert.equal(deleted.has(`expires:${Date.parse(expiresAt)}:${id}`), false);

  const {future} = await (await request('/fixture/seed')).json();
  let snapshot;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(50);
    snapshot = await (await request('/fixture/inspect')).json();
    if (new Map(snapshot.entries).has('fixture:alarm-ran')) break;
  }
  const entries = new Map(snapshot.entries);
  assert.equal(entries.get('fixture:alarm-ran'), true, 'Native alarm must execute within two seconds');
  assert.equal(entries.has('report:expired'), false);
  assert.equal([...entries.keys()].some(key => key.endsWith(':expired')), false);
  assert.deepEqual(entries.get('report:future'), {fixture: 'future'});
  assert.equal(entries.get(`expires:${future}:future`), true);
  assert.equal(entries.has('day:2000-01-01'), false);
  assert.equal(snapshot.alarm, future);
});

test('native audience increments atomically and exposes only coarse daily buckets', {timeout: 5000}, async t => {
  const mf = await runtime(t, {stdin: {contents: fixture, resolveDir: root}}, {CONTROL: {className: 'FixtureControl', useSQLite: true}});
  const results = await Promise.all(Array.from({length: 12}, () => mf.dispatchFetch('https://fixture.invalid/audience', {method: 'POST', body: JSON.stringify({event: 'page', audience: 'unknown'})})));
  assert.ok(results.every(response => response.status === 200));
  const stats = await (await mf.dispatchFetch('https://fixture.invalid/stats?days=30')).json();
  assert.equal(stats.audience.windowDays, 30);
  assert.deepEqual(stats.days, []);
  assert.equal(stats.audience.days.length, 1);
  assert.deepEqual(stats.audience.days[0].unknown, {page: 12});
  const snapshot = await (await mf.dispatchFetch('https://fixture.invalid/fixture/inspect')).json();
  assert.ok(snapshot.alarm > Date.now());
  assert.ok(snapshot.entries.every(([key]) => key === 'audience_since' || /^audience:\d{4}-\d{2}-\d{2}$/.test(key)), 'storage has no request or visitor keys');
});
