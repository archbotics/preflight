import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const base = (process.env.PREFLIGHT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const target = process.env.PREFLIGHT_SMOKE_TARGET || 'https://archbotics.com/';
const receipt = {at: new Date().toISOString(), base, target, checks: []};
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, {method, redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: {...(body ? {'content-type': 'application/json'} : {}), ...headers},
    ...(body ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  return {response, data};
}
const pass = label => { receipt.checks.push(label); console.log('PASS ' + label); };
let shared;
try {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200); assert.equal(health.data.enabled, true); pass('enabled health');
  assert.equal((await request('/api/stats')).response.status, 404); pass('private stats require authentication');
  const denied = await request('/api/check', 'POST', {url: 'http://127.0.0.1', mode: 'live'});
  assert.equal(denied.response.status, 400); pass('local address rejected');
  const scan = await request('/api/check', 'POST', {url: target, mode: 'live'});
  assert.equal(scan.response.status, 200, JSON.stringify(scan.data));
  assert.equal(scan.data.report.checks.length, 16); assert.match(scan.data.shareToken, /^[a-f0-9]{64}$/);
  receipt.summary = scan.data.report.summary; pass('live public HTML scan with signed report');
  const tampered = structuredClone(scan.data.report); tampered.mode = 'preview';
  assert.equal((await request('/api/share', 'POST', {report: tampered, token: scan.data.shareToken})).response.status, 400);
  pass('modified report cannot be published');
  const saved = await request('/api/share', 'POST', {report: scan.data.report, token: scan.data.shareToken});
  assert.equal(saved.response.status, 201, JSON.stringify(saved.data)); shared = saved.data;
  assert.equal(new URL(shared.url).origin, new URL(base).origin);
  assert.ok(Date.parse(shared.expiresAt) - Date.now() > 6.99 * 86400000); pass('seven-day report sharing');
  const read = await request('/api/reports/' + shared.id);
  assert.deepEqual(read.data.report, scan.data.report); assert.equal(read.response.headers.get('cache-control'), 'no-store');
  assert.equal(read.data.deleteKey, undefined); pass('read preserves report and withholds deletion key');
  const shell = await fetch(shared.url, {redirect: 'error'});
  assert.equal(shell.status, 200); assert.match(shell.headers.get('x-robots-tag'), /noindex/); pass('shared page serves with noindex');
  assert.equal((await request('/api/reports/' + shared.id, 'DELETE', undefined, {'x-delete-key': '0'.repeat(64)})).response.status, 403);
  pass('incorrect deletion key rejected');
} finally {
  if (shared) {
    const deleted = await request('/api/reports/' + shared.id, 'DELETE', undefined, {'x-delete-key': shared.deleteKey});
    assert.equal(deleted.response.status, 200, 'Test report cleanup failed; use retained key in this process.');
    assert.equal((await request('/api/reports/' + shared.id)).response.status, 404); pass('creator deletes report; subsequent read is absent');
  }
}
await mkdir('artifacts', {recursive: true});
await writeFile('artifacts/smoke.json', JSON.stringify(receipt, null, 2) + '\n');
