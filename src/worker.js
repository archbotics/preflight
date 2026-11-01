import {classifyAudience, usageExcluded, homeNavigation} from './audience.js';
import {analyze, exampleReport, AnalyzeError} from './analyze.js';
import {fetchPage, normalizeTarget, PublicError, readLimited} from './network.js';
import {Control, constantTimeEqual} from './control.js';
export {Control};

export const VERSION = '1.0.0';
const MAX_BODY = 96 * 1024;
const encoder = new TextEncoder();
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const json = (body, status = 200, extra = {}) => Response.json(body, {status, headers: {...SECURITY_HEADERS, ...extra}});
const failure = (code, message, status) => json({ok: false, error: {code, message}}, status);
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const randomHex = size => hex(crypto.getRandomValues(new Uint8Array(size)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function signReport(report, secret) {
  return hex(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(JSON.stringify(report))));
}
export async function verifyReport(report, token, secret, now = Date.now()) {
  if (!secret || !report || report.schemaVersion !== 1 || report.example || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const checked = Date.parse(report.checkedAt);
  if (!Number.isFinite(checked) || checked > now + 5000 || now - checked > 30 * 60000) return false;
  const signature = Uint8Array.from(token.match(/../g), x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', await signingKey(secret), signature, encoder.encode(JSON.stringify(report)));
}

export async function readJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    throw new PublicError('json_required', 'Send an application/json request body.', 415);
  let bytes;
  try { bytes = await readLimited(new Response(request.body, {headers: request.headers}), MAX_BODY); }
  catch { throw new PublicError('body_too_large', 'The request is too large. Start a new check.', 413); }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new PublicError('invalid_json', 'The request body must be a JSON object.', 400); }
}

function object(env) {
  if (!env.CONTROL) throw new PublicError('service_unavailable', 'Preflight is temporarily unavailable. Try again shortly.', 503);
  return env.CONTROL.get(env.CONTROL.idFromName('preflight-v1'));
}
async function control(env, path, data, options = {}) {
  return object(env).fetch(`https://control${path}`, {
    method: options.method || (data ? 'POST' : 'GET'),
    headers: {'content-type': 'application/json', ...options.headers},
    ...(data ? {body: JSON.stringify(data)} : {}),
  });
}
async function recordEvent(env, event) {
  try { await control(env, '/event', {event}); } catch { /* Operational counters are best effort, never business outcomes. */ }
}

async function recordUsage(env, request, event) {
  if (usageExcluded(request)) return;
  try { await control(env, '/audience', {event, audience: classifyAudience(request)}); } catch { /* Usage never changes product outcomes. */ }
}

export async function handleRequest(request, env, ctx, dependencies = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path.startsWith('/r/')) {
      if (!/^\/r\/[a-f0-9]{32}$/.test(path) || !['GET', 'HEAD'].includes(request.method)) return failure('not_found', 'Report not found.', 404);
      const asset = await env.ASSETS.fetch(new Request(new URL('/', url), {method: request.method}));
      const headers = new Headers(asset.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('Cache-Control', 'no-store');
      return new Response(asset.body, {status: asset.status, headers});
    }
    if (!path.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      if (!usageExcluded(request) && homeNavigation(request, response) && env.READ_LIMITER && typeof ctx?.waitUntil === 'function') {
        ctx.waitUntil((async () => {
          try {
            const {success} = await env.READ_LIMITER.limit({key: `audience:${request.headers.get('CF-Connecting-IP') || 'local-client'}`});
            if (success) await recordUsage(env, request, 'page');
          } catch { /* Usage is best effort. */ }
        })());
      }
      return response;
    }
    if (request.method === 'OPTIONS') return failure('cors_not_enabled', 'Cross-origin browser requests are not supported. Use the same-origin app or a server-side client.', 405);
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
        return failure('origin_denied', 'This request must come from Preflight or a server-side client.', 403);
      if (!env.WRITE_LIMITER) return failure('service_unavailable', 'Preflight is temporarily unavailable.', 503);
      const {success} = await env.WRITE_LIMITER.limit({key: request.headers.get('CF-Connecting-IP') || 'local-client'});
      if (!success) return json({ok: false, error: {code: 'rate_limited', message: 'Please wait a minute before trying again.'}}, 429, {'Retry-After': '60'});
    }
    if (path === '/api/health' && request.method === 'GET') return json({ok: true, version: VERSION, enabled: env.SERVICE_ENABLED === 'true'});
    if (path === '/api/example' && request.method === 'GET') return json({ok: true, report: exampleReport()});
    if (path === '/api/check' && request.method === 'POST') {
      if (env.SERVICE_ENABLED !== 'true') return failure('service_paused', 'New checks are paused. Existing reports are still available.', 503);
      const input = await readJSON(request);
      if (!['preview', 'live'].includes(input.mode)) return failure('invalid_mode', 'Choose preview or live mode.', 400);
      const target = normalizeTarget(input.url);
      const reserved = await control(env, '/reserve', {});
      if (reserved.status === 429) return failure('daily_limit', 'The free beta has reached its daily check limit. Please try again tomorrow (UTC).', 429);
      if (!reserved.ok) throw new Error('control unavailable');
      await recordUsage(env, request, 'scan_started');
      try {
        const fetched = await (dependencies.fetchPage || fetchPage)(target.href);
        const report = analyze({...fetched, mode: input.mode, checkedAt: new Date().toISOString()});
        const shareToken = env.REPORT_SECRET ? await signReport(report, env.REPORT_SECRET) : '';
        await recordEvent(env, 'completed');
        await recordUsage(env, request, 'scan_completed');
        return json({ok: true, report, shareToken});
      } catch (error) { await recordEvent(env, 'failed'); await recordUsage(env, request, 'scan_failed'); throw error; }
    }
    if (path === '/api/share' && request.method === 'POST') {
      if (env.SERVICE_ENABLED !== 'true') return failure('service_paused', 'New report sharing is paused.', 503);
      const {report, token} = await readJSON(request);
      if (!await verifyReport(report, token, env.REPORT_SECRET))
        return failure('invalid_report', 'This report cannot be shared. Run a fresh check and share it within 30 minutes.', 400);
      const id = randomHex(16); const deleteKey = randomHex(32);
      const stored = await control(env, '/reports', {id, report, deleteHash: await digest(deleteKey)});
      if (stored.status === 429) return failure('daily_limit', 'The free beta has reached its daily sharing limit. Download the report instead.', 429);
      if (!stored.ok) throw new Error('storage unavailable');
      const {expiresAt} = await stored.json();
      await recordUsage(env, request, 'shared');
      return json({ok: true, id, url: `${url.origin}/r/${id}`, expiresAt, deleteKey}, 201);
    }
    const match = /^\/api\/reports\/([a-f0-9]{32})$/.exec(path);
    if (match && ['GET', 'DELETE'].includes(request.method)) {
      if (request.method === 'GET') {
        if (!env.READ_LIMITER) return failure('service_unavailable', 'Reports are temporarily unavailable.', 503);
        const {success} = await env.READ_LIMITER.limit({key: request.headers.get('CF-Connecting-IP') || 'local-client'});
        if (!success) return json({ok: false, error: {code: 'rate_limited', message: 'Please wait a minute before opening more reports.'}}, 429, {'Retry-After': '60'});
      }
      let headers = {};
      if (request.method === 'DELETE') {
        const key = request.headers.get('x-delete-key') || '';
        if (!/^[a-f0-9]{64}$/.test(key)) return failure('delete_denied', 'Only the browser that created this shared report can delete it, or a client holding its deletion key.', 403);
        headers = {'x-delete-hash': await digest(key)};
      }
      const response = await control(env, `/reports/${match[1]}`, null, {method: request.method, headers});
      if ([404, 410].includes(response.status)) return failure('report_unavailable', 'This report has expired, was deleted, or does not exist.', response.status);
      if (response.status === 403) return failure('delete_denied', 'The deletion key does not match this report.', 403);
      if (!response.ok) throw new Error('storage unavailable');
      if (request.method === 'DELETE') await recordEvent(env, 'deleted');
      return json(await response.json());
    }
    if (path === '/api/stats' && request.method === 'GET') {
      if (!env.ADMIN_TOKEN || !constantTimeEqual(request.headers.get('authorization') || '', `Bearer ${env.ADMIN_TOKEN}`))
        return failure('not_found', 'Not found.', 404);
      const days = url.searchParams.get('days') || '7';
      if (!['7', '30'].includes(days)) return failure('invalid_window', 'Choose 7 or 30 days.', 400);
      const response = await control(env, `/stats?days=${days}`);
      if (!response.ok) throw new Error('stats unavailable');
      return json(await response.json());
    }
    return failure('not_found', 'This endpoint does not exist, or the HTTP method is not supported.', 404);
  } catch (error) {
    if (error instanceof PublicError || error instanceof AnalyzeError) return failure(error.code, error.message, error.status);
    // No raw target, response body, stack, request header or credential is logged.
    return failure('service_error', 'Preflight could not finish this request. Please try again shortly.', 503);
  }
}

export default {fetch: handleRequest};
