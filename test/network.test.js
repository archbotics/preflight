import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTarget, isPublicAddress, assertPublicDNS, readLimited, fetchPage} from '../src/network.js';

test('public URLs normalize scheme, fragment, trailing dot and default port', () => {
  assert.equal(normalizeTarget(' example.com/about#team ').href, 'https://example.com/about');
  assert.equal(normalizeTarget('https://Example.COM.:443').href, 'https://example.com/');
  assert.equal(normalizeTarget('http://example.com:80').href, 'http://example.com/');
});

test('untrusted inputs cannot request local, IP, credential or query-bearing targets', () => {
  const invalid = [null, {}, '', 'a'.repeat(2049), 'file:///etc/passwd', 'javascript:alert(1)',
    'https://user:pass@example.com/', 'https://example.com/?token=private', 'https://example.com:8443',
    'http://localhost/', 'http://a.localhost/', 'http://a.internal/', 'http://a.local/', 'http://metadata.google.internal/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://a..com/', 'https://foo.test', 'https://foo.onion'];
  for (const value of invalid) assert.throws(() => normalizeTarget(value), undefined, String(value));
});

test('address classification refuses reserved and nonpublic IPv4/IPv6', () => {
  for (const value of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.1.2', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.1.1.1', '255.255.255.255', '::1', '::', 'fc00::1',
    'fe80::1', '2001:db8::1', '::ffff:8.8.8.8', 'garbage']) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress('93.184.215.14'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

const dns = (addresses = ['93.184.215.14']) => Response.json({Status: 0, Answer: addresses.map(data => ({type: data.includes(':') ? 28 : 1, data}))});
test('DNS preflight refuses mixed public/private answers and no-answer results', async () => {
  await assert.rejects(assertPublicDNS('example.com', async () => dns(['93.184.215.14', '10.0.0.1'])), {code: 'private_host'});
  await assert.rejects(assertPublicDNS('example.com', async () => dns([])), {code: 'dns_failed'});
  await assert.rejects(assertPublicDNS('example.com', async () => Response.json({Status: 3})), {code: 'dns_failed'});
  await assert.rejects(assertPublicDNS('example.com', async () => new Response('bad')), {code: 'dns_unavailable'});
  await assertPublicDNS('example.com', async () => dns());
});

test('bounded reader rejects both declared and streamed oversize bodies', async () => {
  await assert.rejects(readLimited(new Response('x', {headers: {'content-length': '600000'}})), {code: 'page_too_large'});
  let cancelled = false;
  const body = new ReadableStream({pull(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; }});
  await assert.rejects(readLimited(new Response(body), 7), {code: 'page_too_large'});
  assert.equal(cancelled, true);
  assert.equal(new TextDecoder().decode(await readLimited(new Response('ä'))), 'ä');
});

function fakeNetwork(pageResponse) {
  const calls = [];
  return {calls, fetcher: async (url, opts) => {
    calls.push({url, opts});
    if (url.startsWith('https://cloudflare-dns.com/')) return dns();
    return typeof pageResponse === 'function' ? pageResponse(url, opts) : pageResponse;
  }};
}

test('each redirect is validated before any next network request', async () => {
  for (const location of ['http://127.0.0.1/', 'https://example.com/?secret=yes', 'http://private.local/', 'file:///x']) {
    const fake = fakeNetwork(new Response('', {status: 302, headers: {location}}));
    await assert.rejects(fetchPage('example.com', fake));
    assert.equal(fake.calls.filter(x => !x.url.includes('dns-query')).length, 1);
  }
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('name=private.example.com')) return dns(['10.0.0.1']);
    if (url.includes('dns-query')) return dns();
    return new Response('', {status: 302, headers: {location: 'https://private.example.com/'}});
  };
  await assert.rejects(fetchPage('example.com', {fetcher}), {code: 'private_host'});
  assert.equal(calls.includes('https://private.example.com/'), false);
});

test('redirect loops stop, access denial and non-HTML never become passing reports', async () => {
  await assert.rejects(fetchPage('example.com', fakeNetwork(new Response('', {status: 302, headers: {location: '/'}}))), {code: 'redirect_limit'});
  for (const status of [401, 403, 429]) await assert.rejects(fetchPage('example.com', fakeNetwork(new Response('', {status}))), {code: 'access_blocked'});
  await assert.rejects(fetchPage('example.com', fakeNetwork(Response.json({ok: true}))), {code: 'not_html'});
});

test('successful fetch sends only explicit headers and preserves HTTP evidence', async () => {
  const fake = fakeNetwork(new Response('<html><title>Demo</title></html>', {status: 404, headers: {'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex'}}));
  const page = await fetchPage('example.com', fake);
  assert.equal(page.status, 404);
  assert.equal(page.headers['x-robots-tag'], 'noindex');
  assert.equal(page.requestedUrl, 'https://example.com/');
  assert.equal(page.redirects, 0);
  assert.equal(page.bytes, 32);
  const call = fake.calls.find(x => x.url === page.url);
  assert.equal(call.opts.redirect, 'manual');
  assert.deepEqual(Object.keys(call.opts.headers).sort(), ['Accept', 'User-Agent']);
});

test('deadline aborts a stalled network request', async () => {
  const fetcher = (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
  });
  await assert.rejects(fetchPage('example.com', {fetcher, timeoutMs: 10}), {code: 'page_timeout'});
});
