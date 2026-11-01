import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest, signReport, verifyReport, readJSON} from '../src/worker.js';
import {analyze, exampleReport} from '../src/analyze.js';

const secret = 'test-only-report-secret';
const report = () => analyze({html: '<html lang="en"><head><title>Test</title></head><body><h1>Test</h1></body></html>', url: 'https://example.com/', checkedAt: new Date().toISOString()});
const request = (path, body, extras = {}) => new Request(`https://launchcheck.example${path}`, {
  method: 'POST', headers: {'content-type': 'application/json', ...(extras.headers || {})},
  ...(body ? {body: JSON.stringify(body)} : {}), ...extras,
});

test('signatures reject mutated, stale, future, and example reports', async () => {
  const value = report(); const token = await signReport(value, secret);
  assert.equal(await verifyReport(value, token, secret), true);
  assert.equal(await verifyReport({...value, title: 'tampered'}, token, secret), false);
  assert.equal(await verifyReport(value, token, 'other-key'), false);
  for (const offset of [-31 * 60000, 10000]) {
    const changed = {...value, checkedAt: new Date(Date.now() + offset).toISOString()};
    assert.equal(await verifyReport(changed, await signReport(changed, secret), secret), false);
  }
  const example = {...exampleReport(), checkedAt: new Date().toISOString()};
  assert.equal(await verifyReport(example, await signReport(example, secret), secret), false);
});

test('requests require bounded JSON objects and reject unsupported modes/targets before reservation', async () => {
  await assert.rejects(readJSON(new Request('https://test/', {method: 'POST', body: '{}'})), {status: 415});
  for (const body of ['null', '[]', '{broken']) await assert.rejects(readJSON(new Request('https://test/', {method: 'POST', headers: {'content-type': 'application/json'}, body})), {code: 'invalid_json'});
  await assert.rejects(readJSON(request('/api/check', {x: 'a'.repeat(100000)})), {status: 413});
  let calls = 0;
  const env = {SERVICE_ENABLED: 'true', WRITE_LIMITER: {limit: async () => ({success: true})},
    CONTROL: {idFromName: x => x, get: () => ({fetch: () => {calls++; throw new Error('unexpected');}})}};
  for (const body of [{url: 'https://example.com', mode: 'bad'}, {url: 'https://127.1/', mode: 'live'}]) {
    const res = await handleRequest(request('/api/check', body), env);
    assert.equal(res.status, 400);
  }
  assert.equal(calls, 0);
});

test('origin and rate checks run before any fetch or storage reservation', async () => {
  let limits = 0;
  const env = {WRITE_LIMITER: {limit: async () => {limits++; return {success: false};}}};
  const cross = await handleRequest(request('/api/check', {}, {headers: {origin: 'https://attacker.example'}}), env);
  assert.equal(cross.status, 403); assert.equal(limits, 0);
  const limited = await handleRequest(request('/api/check', {url: 'https://example.com', mode: 'live'}), env);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limits, 1);
});

test('paused service permits existing report reads but refuses new checks', async () => {
  const env = {SERVICE_ENABLED: 'false', WRITE_LIMITER: {limit: async () => ({success: true})},
    READ_LIMITER: {limit: async () => ({success: true})},
    CONTROL: {idFromName: x => x, get: () => ({fetch: async () => Response.json({ok: true, report: report()})})}};
  assert.equal((await handleRequest(request('/api/check', {}), env)).status, 503);
  assert.equal((await handleRequest(new Request(`https://launchcheck.example/api/reports/${'a'.repeat(32)}`), env)).status, 200);
});

test('real report can flow through scan, share, public read and authenticated deletion', async () => {
  const rows = new Map();
  const env = {REPORT_SECRET: secret, SERVICE_ENABLED: 'true', WRITE_LIMITER: {limit: async () => ({success: true})},
    READ_LIMITER: {limit: async () => ({success: true})},
    CONTROL: {idFromName: x => x, get: () => ({fetch: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/reserve' || path === '/event') return Response.json({accepted: true});
      if (path === '/reports') { const data = JSON.parse(options.body); rows.set(data.id, data); return Response.json({expiresAt: '2026-09-12T00:00:00.000Z'}, {status: 201}); }
      const id = path.split('/').at(-1); const row = rows.get(id);
      if (!row) return Response.json({}, {status: 404});
      if (options.method === 'DELETE') {
        if (options.headers['x-delete-hash'] !== row.deleteHash) return Response.json({}, {status: 403});
        rows.delete(id); return Response.json({ok: true});
      }
      return Response.json({ok: true, report: row.report});
    }})}};
  const scan = await handleRequest(request('/api/check', {url: 'https://example.com/', mode: 'live'}), env, {}, {
    fetchPage: async () => ({html: `<title>${'x'.repeat(100000)}</title><body><h1>Test</h1></body>`, url: 'https://example.com/', status: 200, headers: {'content-type': 'text/html'}}),
  });
  assert.equal(scan.status, 200); const checked = await scan.json();
  const shareBody = {report: checked.report, token: checked.shareToken};
  assert.ok(new TextEncoder().encode(JSON.stringify(shareBody)).length < 96 * 1024, 'every bounded generated report fits the share API');
  const share = await handleRequest(request('/api/share', shareBody), env);
  assert.equal(share.status, 201); const shared = await share.json();
  assert.match(shared.url, /^https:\/\/launchcheck\.example\/r\/[a-f0-9]{32}$/);
  assert.equal(shared.url.includes(shared.deleteKey), false);
  const getRequest = new Request(`https://launchcheck.example/api/reports/${shared.id}`);
  const read = await handleRequest(getRequest, env);
  assert.equal(read.status, 200); assert.equal(JSON.stringify(await read.json()).includes(shared.deleteKey), false);
  const wrong = await handleRequest(new Request(getRequest.url, {method: 'DELETE', headers: {'x-delete-key': 'f'.repeat(64)}}), env);
  assert.equal(wrong.status, 403);
  const deleted = await handleRequest(new Request(getRequest.url, {method: 'DELETE', headers: {'x-delete-key': shared.deleteKey}}), env);
  assert.equal(deleted.status, 200);
  assert.equal((await handleRequest(getRequest, env)).status, 404);
});

test('unexpected backend errors are generic and secrets/internal strings never leak', async () => {
  const env = {SERVICE_ENABLED: 'true', WRITE_LIMITER: {limit: async () => {throw new Error('sensitive internal string');}}};
  const response = await handleRequest(request('/api/check', {}), env);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive internal/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('homepage audience counts accepted document navigations and excludes QA/privacy before usage work', async () => {
  const calls = [], pending = []; let limits = 0;
  const env = {ASSETS: {fetch: async () => new Response('<h1>Home</h1>', {headers: {'content-type': 'text/html'}})},
    READ_LIMITER: {limit: async () => {limits++; return {success: true};}},
    CONTROL: {idFromName: x => x, get: () => ({fetch: async (url, options) => {calls.push({path: new URL(url).pathname, data: JSON.parse(options.body)}); return Response.json({ok: true});}})}};
  const headers = {'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36', 'accept-language': 'en', accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none'};
  const ctx = {waitUntil: task => pending.push(task)};
  for (const signal of ['X-Archbotics-QA', 'DNT', 'Sec-GPC']) assert.equal((await handleRequest(new Request('https://launchcheck.example/', {headers: {...headers, [signal]: '1'}}), env, ctx)).status, 200);
  await Promise.all(pending); assert.equal(limits, 0); assert.equal(calls.length, 0);
  for (const path of ['/.env', '/wp-admin', '/assets/app.js']) await handleRequest(new Request(`https://launchcheck.example${path}`, {headers}), env, ctx);
  await handleRequest(new Request('https://launchcheck.example/', {headers: {...headers, 'sec-fetch-mode': 'cors'}}), env, ctx);
  await handleRequest(new Request('https://launchcheck.example/', {headers: {...headers, 'sec-fetch-site': 'invalid'}}), env, ctx);
  await handleRequest(new Request('https://launchcheck.example/', {method: 'HEAD', headers}), env, ctx);
  await Promise.all(pending); assert.equal(calls.length, 0);
  await handleRequest(new Request('https://launchcheck.example/', {headers}), env, ctx); await Promise.all(pending);
  assert.deepEqual(calls, [{path: '/audience', data: {event: 'page', audience: 'browser_like'}}]);
  env.READ_LIMITER.limit = async () => ({success: false});
  await handleRequest(new Request('https://launchcheck.example/', {headers}), env, ctx); await Promise.all(pending);
  assert.equal(calls.length, 1);
  env.READ_LIMITER.limit = async () => {throw Error('unavailable');};
  assert.equal((await handleRequest(new Request('https://launchcheck.example/', {headers}), env, ctx)).status, 200); await Promise.all(pending);
  assert.equal(calls.length, 1);
});

test('scan audience distinguishes browser/bot/unknown, never persists headers, and preserves operational counts under QA', async () => {
  const calls = [];
  const env = {REPORT_SECRET: secret, SERVICE_ENABLED: 'true', WRITE_LIMITER: {limit: async () => ({success: true})},
    CONTROL: {idFromName: x => x, get: () => ({fetch: async (url, options) => {calls.push({path: new URL(url).pathname, body: JSON.parse(options.body)}); return Response.json({accepted: true});}})}};
  const dependencies = {fetchPage: async () => ({html: '<h1>Test</h1>', url: 'https://example.com/', status: 200, headers: {'content-type': 'text/html'}})};
  for (const [headers, audience] of [[{}, 'unknown'], [{'user-agent': 'curl/8'}, 'bot_like'], [{'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36', 'accept-language': 'en', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin'}, 'browser_like']]) {
    calls.length = 0;
    const response = await handleRequest(request('/api/check', {url: 'https://example.com/', mode: 'live'}, {headers: {'content-type': 'application/json', ...headers}}), env, {}, dependencies);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.filter(x => x.path === '/audience').map(x => x.body), [{event: 'scan_started', audience}, {event: 'scan_completed', audience}]);
  }
  for (const header of ['X-Archbotics-QA', 'DNT', 'Sec-GPC']) {
    calls.length = 0;
    assert.equal((await handleRequest(request('/api/check', {url: 'https://example.com/', mode: 'live'}, {headers: {'content-type': 'application/json', [header]: '1'}}), env, {}, dependencies)).status, 200);
    assert.deepEqual(calls.map(x => x.path), ['/reserve', '/event']);
  }
  calls.length = 0;
  const failed = await handleRequest(request('/api/check', {url: 'https://example.com/', mode: 'live'}), env, {}, {fetchPage: async () => {throw Error('failed');}});
  assert.equal(failed.status, 503);
  assert.deepEqual(calls.filter(x => x.path === '/audience').map(x => x.body.event), ['scan_started', 'scan_failed']);
  env.CONTROL.get = () => ({fetch: async (url) => {if (new URL(url).pathname === '/audience') throw Error('unavailable'); return Response.json({accepted: true});}});
  assert.equal((await handleRequest(request('/api/check', {url: 'https://example.com/', mode: 'live'}), env, {}, dependencies)).status, 200);
});

test('external document referrals count as browser-like, and exhausted homepage telemetry cannot block report reads', async () => {
  const buckets = new Map(), events = [], pending = [];
  const env = {
    ASSETS: {fetch: async () => new Response('<h1>Home</h1>', {headers: {'content-type': 'text/html'}})},
    READ_LIMITER: {limit: async ({key}) => {const n = (buckets.get(key) || 0) + 1; buckets.set(key, n); return {success: n <= 2};}},
    CONTROL: {idFromName: x => x, get: () => ({fetch: async (url, options) => {
      if (new URL(url).pathname === '/audience') {events.push(JSON.parse(options.body)); return Response.json({ok: true});}
      return Response.json({ok: true, report: {title: 'Stored report'}});
    }})},
  };
  const headers = {'CF-Connecting-IP': '203.0.113.4', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36', 'accept-language': 'en', accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site'};
  const ctx = {waitUntil: task => pending.push(task)};
  for (let n = 0; n < 3; n++) assert.equal((await handleRequest(new Request('https://launchcheck.example/', {headers}), env, ctx)).status, 200);
  await Promise.all(pending);
  assert.deepEqual(events, [{event: 'page', audience: 'browser_like'}, {event: 'page', audience: 'browser_like'}]);
  const shared = await handleRequest(new Request(`https://launchcheck.example/api/reports/${'a'.repeat(32)}`, {headers}), env, ctx);
  assert.equal(shared.status, 200, 'homepage telemetry exhaustion must not consume shared-report allowance');
  assert.equal((await shared.json()).report.title, 'Stored report');
  assert.deepEqual([...buckets], [['audience:203.0.113.4', 3], ['203.0.113.4', 1]]);
  const crossWrite = await handleRequest(request('/api/check', {}, {headers: {origin: 'https://external.example', 'sec-fetch-site': 'cross-site'}}), env);
  assert.equal(crossWrite.status, 403, 'accepting referral navigation must not admit cross-site API writes');
});
