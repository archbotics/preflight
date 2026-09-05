import test from 'node:test';
import assert from 'node:assert/strict';
import {Control, REPORT_TTL_MS, configuredLimit} from '../src/control.js';

// Serial transactions model the storage contract; deployed tests exercise workerd.
export function memoryStorage() {
  const map = new Map(); let alarm = null, tail = Promise.resolve();
  const storage = {
    async get(k) { return structuredClone(map.get(k)); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k); },
    async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; },
    async list({prefix = '', reverse, limit} = {}) {
      let rows = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit);
      return new Map(structuredClone(rows));
    },
    transaction(fn) { const next = tail.then(() => fn(storage)); tail = next.catch(() => {}); return next; },
  };
  return storage;
}

const req = (path, data, options = {}) => new Request(`https://control${path}`, {method: data ? 'POST' : 'GET', ...(data ? {body: JSON.stringify(data)} : {}), ...options});
test('global daily scan limit is atomic under concurrent requests', async () => {
  const control = new Control({storage: memoryStorage()}, {DAILY_SCAN_LIMIT: '3'});
  const results = await Promise.all(Array.from({length: 12}, () => control.fetch(req('/reserve', {}))));
  assert.equal(results.filter(r => r.status === 200).length, 3);
  assert.equal(results.filter(r => r.status === 429).length, 9);
  assert.equal((await (await control.fetch(req('/stats'))).json()).days[0].started, 3);
  for (const value of ['0', '-1', 'NaN', '999999', '2.1']) assert.equal(configuredLimit(value), 250);
});

test('report share, authorization, immediate read-after-delete and expiry', async () => {
  const storage = memoryStorage(); const control = new Control({storage}, {});
  const id = 'a'.repeat(32), deleteHash = 'b'.repeat(64);
  const created = await control.fetch(req('/reports', {id, report: {title: 'fixture'}, deleteHash}));
  assert.equal(created.status, 201);
  const {expiresAt} = await created.json();
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - REPORT_TTL_MS) < 1000);
  assert.equal((await (await control.fetch(req(`/reports/${id}`))).json()).report.title, 'fixture');
  assert.equal((await control.fetch(req(`/reports/${id}`, null, {method: 'DELETE', headers: {'x-delete-hash': 'c'.repeat(64)}}))).status, 403);
  assert.equal((await control.fetch(req(`/reports/${id}`, null, {method: 'DELETE', headers: {'x-delete-hash': deleteHash}}))).status, 200);
  assert.equal((await control.fetch(req(`/reports/${id}`))).status, 404);
  await storage.put(`report:${id}`, {report: {}, deleteHash, expiresAt: new Date(Date.now() - 1).toISOString()});
  assert.equal((await control.fetch(req(`/reports/${id}`))).status, 410);
  assert.equal(await storage.get(`report:${id}`), undefined);
});

test('alarm deletes expired data, retains unexpired data and schedules next expiry', async () => {
  const storage = memoryStorage(); const control = new Control({storage}, {});
  const now = Date.now(), past = now - 1000, future = now + 100000;
  await storage.put(`expires:${past}:old`, true); await storage.put('report:old', {some: 'data'});
  await storage.put(`expires:${future}:new`, true); await storage.put('report:new', {some: 'data'});
  await storage.put('day:2000-01-01', {started: 1});
  await control.alarm();
  assert.equal(await storage.get('report:old'), undefined);
  assert.deepEqual(await storage.get('report:new'), {some: 'data'});
  assert.equal(await storage.getAlarm(), future);
  assert.equal(await storage.get('day:2000-01-01'), undefined);
});
