import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyze, AnalyzeError, exampleReport } from '../src/analyze.js';
import { buildBrief } from '../src/brief.js';

const fixture = (name) => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const checkedAt = '2026-09-05T08:30:00.000Z';
const defaults = {
  url: 'https://studio.example/work',
  requestedUrl: 'https://studio.example/work',
  mode: 'live', status: 200, redirects: 0, checkedAt,
  headers: { 'content-type': 'text/html; charset=utf-8' },
};
const scan = (html, overrides = {}) => analyze({ html, ...defaults, ...overrides });
const finding = (report, id) => report.checks.find((item) => item.id === id);

test('returns the frozen Report and Check shapes with consistent counts', async () => {
  const report = scan(await fixture('complete.html'), { bytes: 1234, redirects: 2 });
  assert.deepEqual(Object.keys(report), [
    'schemaVersion', 'engineVersion', 'requestedUrl', 'url', 'mode', 'checkedAt',
    'title', 'summary', 'checks', 'page', 'limits',
  ]);
  assert.equal(report.schemaVersion, 1);
  assert.match(report.engineVersion, /^preflight-html\/\d+\.\d+\.\d+$/);
  assert.deepEqual(report.page, { status: 200, bytes: 1234, redirects: 2, contentType: 'text/html; charset=utf-8' });
  assert.equal(new Set(report.checks.map((item) => item.id)).size, report.checks.length);
  for (const item of report.checks) {
    assert.deepEqual(Object.keys(item), ['id', 'category', 'status', 'title', 'detail', 'evidence', 'recommendation', 'acceptance']);
    assert.ok(['launch', 'discovery', 'content', 'accessibility'].includes(item.category));
    assert.ok(['fix', 'review', 'pass', 'info'].includes(item.status));
    assert.ok(item.title && item.detail && item.recommendation && item.acceptance);
    assert.ok(item.evidence.every((value) => value.length <= 220));
  }
  assert.equal(Object.values(report.summary).reduce((sum, count) => sum + count, 0), report.checks.length);
});

test('parses entities and Unicode, resolves relative URLs, fragments, and decorative alt', async () => {
  const report = scan(await fixture('complete.html'));
  assert.equal(report.title, 'Café North & Studio');
  assert.equal(finding(report, 'title').evidence[0], 'Title: “Café North & Studio”');
  assert.equal(finding(report, 'canonical').status, 'pass');
  assert.match(finding(report, 'canonical').evidence.join(' '), /https:\/\/studio\.example\/work/);
  assert.equal(finding(report, 'link-targets').status, 'pass');
  assert.match(finding(report, 'link-targets').evidence.join(' '), /Valid fragment targets: 1/);
  assert.equal(finding(report, 'image-alt').status, 'pass');
  assert.match(finding(report, 'image-alt').evidence.join(' '), /Empty alt attributes: 1/);
  assert.equal(finding(report, 'contact-route').status, 'pass');
});

test('malformed HTML is analyzed conservatively and hidden executable/template text is ignored', async () => {
  const report = scan(await fixture('malformed-hidden.html'));
  assert.equal(finding(report, 'placeholder-copy').status, 'fix');
  assert.deepEqual(finding(report, 'placeholder-copy').evidence, ['Source text: “replace this copy”']);
  const dev = finding(report, 'development-urls');
  assert.equal(dev.status, 'fix');
  assert.equal(dev.evidence.length, 1);
  assert.match(dev.evidence[0], /localhost:8787\/v1 \[query removed\]$/);
  assert.doesNotMatch(JSON.stringify(report), /super-secret|secret=hidden|key=no|preview\.local/);
  assert.equal(finding(report, 'link-targets').status, 'review');
  assert.equal(finding(report, 'image-alt').status, 'review');
  assert.match(finding(report, 'h1').evidence.join(' '), /Привет, мир/u);
});

test('a JavaScript shell turns missing source signals into explicit review findings', async () => {
  const report = scan(await fixture('js-shell.html'));
  assert.equal(report.summary.fix, 0);
  for (const id of ['indexing', 'title', 'description', 'canonical', 'viewport', 'language', 'h1',
    'placeholder-copy', 'development-urls', 'link-targets', 'contact-route', 'image-alt']) {
    assert.equal(finding(report, id).status, 'review', id);
  }
  assert.ok(report.limits.some((item) => /JavaScript shell/u.test(item)));
  assert.match(finding(report, 'title').detail, /rendered page is unknown/u);
  assert.doesNotMatch(finding(report, 'placeholder-copy').detail, /rendered page has no/iu);
});

test('the Preflight app shell is recognized despite noscript and supporting chrome text', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const report = scan(html, { url: 'https://preflight.archbotics.workers.dev/' });
  assert.equal(finding(report, 'h1').status, 'review');
  assert.match(finding(report, 'h1').detail, /JavaScript shell/u);
  assert.equal(finding(report, 'contact-route').status, 'review');
  assert.match(finding(report, 'contact-route').detail, /rendered route is unknown/u);
  assert.ok(report.limits.some((item) => /JavaScript shell/u.test(item)));
});

test('a useful static page with a module script keeps a definite missing-H1 finding', async () => {
  const report = scan(await fixture('static-with-module.html'), { url: 'https://static.example/' });
  assert.equal(finding(report, 'h1').status, 'fix');
  assert.doesNotMatch(finding(report, 'h1').detail, /JavaScript shell/u);
  assert.equal(finding(report, 'contact-route').status, 'pass');
  assert.ok(!report.limits.some((item) => /JavaScript shell/u.test(item)));
});

test('a classic external bundle with an empty app root remains a recognized shell', () => {
  const html = '<html><head><script defer src="/static/js/main.js"></script></head><body><div id="root"></div></body></html>';
  const report = scan(html);
  assert.equal(finding(report, 'title').status, 'review');
  assert.equal(finding(report, 'h1').status, 'review');
  assert.ok(report.limits.some((item) => /JavaScript shell/u.test(item)));
});

test('noindex header matching is case-insensitive and severity follows mode', () => {
  const html = '<html lang="en"><head><title>A</title></head><body><h1>A</h1></body></html>';
  const headers = { 'X-RoBoTs-TaG': 'googlebot: noindex, nofollow' };
  const live = scan(html, { headers, mode: 'live' });
  const preview = scan(html, { headers, mode: 'preview' });
  assert.equal(finding(live, 'indexing').status, 'fix');
  assert.equal(finding(preview, 'indexing').status, 'info');
  assert.match(finding(preview, 'indexing').detail, /not a privacy control/u);
  assert.match(finding(live, 'indexing').evidence[0], /googlebot: noindex/iu);
});

test('robots none aliases noindex without confusing parameter values ending in none', () => {
  const doc = (robots = '') => `<html lang="en"><head><title>A</title>${robots}</head><body><h1>A</h1></body></html>`;
  const meta = scan(doc('<meta name="robots" content="NONE">'));
  const header = scan(doc(), { headers: { 'x-robots-tag': 'otherbot: none' } });
  const imagePreview = scan(doc('<meta name="robots" content="max-image-preview:none">'));
  assert.equal(finding(meta, 'indexing').status, 'fix');
  assert.equal(finding(header, 'indexing').status, 'fix');
  assert.equal(finding(imagePreview, 'indexing').status, 'pass');
});

test('canonical edge cases distinguish relative, preview, duplicate, conflicting, and invalid values', () => {
  const doc = (links) => `<html lang="en"><head><title>A</title>${links}</head><body><h1>A</h1></body></html>`;
  assert.equal(finding(scan(doc('<link rel="canonical" href="/work">')), 'canonical').status, 'pass');
  assert.equal(finding(scan(doc('<link rel="canonical" href="/work">'), { mode: 'preview' }), 'canonical').status, 'review');
  assert.equal(finding(scan(doc('<link rel="canonical" href="/work"><link rel="canonical" href="https://studio.example/work">')), 'canonical').status, 'review');
  assert.equal(finding(scan(doc('<link rel="canonical" href="/work"><link rel="canonical" href="/other">')), 'canonical').status, 'fix');
  assert.equal(finding(scan(doc('<link rel="canonical" href="mailto:editor@example.org">')), 'canonical').status, 'fix');
  assert.equal(finding(scan(doc('<link rel="canonical">')), 'canonical').status, 'fix');
  assert.equal(finding(scan(doc('<link rel="canonical" href="  ">')), 'canonical').status, 'fix');
  const secret = finding(scan(doc('<link rel="canonical" href="https://studio.example/work?token=never-show">')), 'canonical');
  assert.doesNotMatch(JSON.stringify(secret.evidence), /never-show/u);
  assert.match(secret.evidence.join(' '), /query removed/u);
});

test('document metadata stays in head and the first base with href resolves canonical, OG image, and fragments', async () => {
  const report = scan(await fixture('base-and-head.html'), { url: 'https://assets.example/landing' });
  assert.equal(report.title, 'Document title');
  assert.equal(finding(report, 'title').status, 'pass');
  assert.equal(finding(report, 'description').status, 'pass');
  assert.match(finding(report, 'description').evidence[0], /Head description/u);
  assert.equal(finding(report, 'canonical').status, 'pass');
  assert.match(finding(report, 'canonical').evidence.join(' '), /https:\/\/assets\.example\/landing/u);
  assert.match(finding(report, 'og-image').evidence.join(' '), /https:\/\/assets\.example\/site\/cards\/launch\.png/u);
  assert.equal(finding(report, 'link-targets').status, 'review');

  const bodyOnly = scan('<html lang="en"><head></head><body><svg><title>Logo title</title></svg><meta name="description" content="Body only"><link rel="canonical" href="/work"><h1>A</h1></body></html>');
  assert.equal(bodyOnly.title, 'Preflight report');
  assert.equal(finding(bodyOnly, 'title').status, 'fix');
  assert.equal(finding(bodyOnly, 'description').status, 'fix');
  assert.equal(finding(bodyOnly, 'canonical').status, 'fix');
});

test('only the first base with href participates, including invalid, empty, and non-HTTP values', () => {
  const doc = (bases) => `<html lang="en"><head>${bases}<title>A</title><link rel="canonical" href="/work"></head><body><h1>A</h1></body></html>`;
  const invalidThenValid = scan(doc('<base href="http://["><base href="https://wrong.example/">'));
  assert.equal(finding(invalidThenValid, 'canonical').status, 'pass');
  assert.match(finding(invalidThenValid, 'canonical').evidence.join(' '), /studio\.example\/work/u);

  const noHrefThenValid = scan(doc('<base><base href="https://assets.example/">'), { url: 'https://assets.example/work' });
  assert.equal(finding(noHrefThenValid, 'canonical').status, 'pass');

  const emptyThenValid = scan(doc('<base href=""><base href="https://wrong.example/">'));
  assert.equal(finding(emptyThenValid, 'canonical').status, 'pass');

  const nonHttpThenValid = scan(doc('<base href="mailto:editor@example.org"><base href="https://studio.example/">'));
  assert.equal(finding(nonHttpThenValid, 'canonical').status, 'fix');
  for (const value of ['javascript:void(0)', 'data:text/plain,hello']) {
    const ignoredScheme = scan(doc(`<base href="${value}"><base href="https://wrong.example/">`));
    assert.equal(finding(ignoredScheme, 'canonical').status, 'pass');
  }
});

test('ambiguous coming-soon copy is review-only and preserves the observed phrase', async () => {
  const report = scan(await fixture('legitimate-coming-soon.html'), { url: 'https://shop.example/spring' });
  const placeholder = finding(report, 'placeholder-copy');
  assert.equal(placeholder.status, 'review');
  assert.equal(placeholder.title, 'Possible unfinished copy');
  assert.deepEqual(placeholder.evidence, ['Source text: “Coming soon”']);
  assert.match(placeholder.detail, /can be intentional or unfinished/u);
});

test('empty and broken fragments stay review-only while a real target passes', () => {
  const base = '<html lang="en"><head><title>A</title></head><body><h1>A</h1>%s</body></html>';
  const valid = scan(base.replace('%s', '<a href="#faq">FAQ</a><section id="faq">Answer</section>'));
  const broken = scan(base.replace('%s', '<a href="#">Buy</a><a href="#missing">More</a>'));
  assert.equal(finding(valid, 'link-targets').status, 'pass');
  assert.equal(finding(broken, 'link-targets').status, 'review');
  assert.notEqual(finding(broken, 'link-targets').status, 'fix');
});

test('contact evidence reports counts without exposing page contact values', () => {
  const html = '<html lang="en"><head><title>A</title></head><body><h1>A</h1><a href="mailto:private.person@example.org">Write privately</a><a href="tel:+358401234567">Call</a></body></html>';
  const report = scan(html);
  const contact = finding(report, 'contact-route');
  assert.equal(contact.status, 'pass');
  assert.match(contact.evidence.join(' '), /Direct mail or phone links: 2/);
  assert.doesNotMatch(JSON.stringify(contact), /private\.person|358401234567/u);
});

test('analyze never fetches and rejects invalid direct-call inputs', () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => { called = true; throw new Error('unexpected fetch'); };
  try {
    scan('<html><body>ok</body></html>');
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
  assert.throws(() => analyze({ html: null, url: 'https://studio.example/' }), /html must be a string/u);
  assert.throws(() => analyze({ html: '', url: 'file:///tmp/page' }), /absolute HTTP\(S\)/u);
  assert.throws(() => analyze({ html: '', url: 'https://studio.example/', mode: 'draft' }), /mode/u);
});

test('deep HTML does not overflow traversal and excessive node counts fail with a typed error', () => {
  const nested = `<html><body>${'<div>'.repeat(3_000)}Deep${'</div>'.repeat(3_000)}</body></html>`;
  assert.doesNotThrow(() => scan(nested));
  const excessive = `<html><body>${'<i></i>'.repeat(50_001)}</body></html>`;
  assert.throws(() => scan(excessive), (error) => {
    assert.ok(error instanceof AnalyzeError);
    assert.equal(error.code, 'page_too_complex');
    assert.equal(error.status, 422);
    return true;
  });
});

test('fixed inputs are deterministic and the example is plainly synthetic', async () => {
  const html = await fixture('complete.html');
  assert.deepEqual(scan(html), scan(html));
  const first = exampleReport();
  const second = exampleReport();
  assert.deepEqual(first, second);
  assert.equal(first.example, true);
  assert.equal(first.url, 'https://example.com/');
  assert.match(first.title, /Synthetic Preflight example/u);
  assert.ok(first.limits.some((item) => /not a live scan/u.test(item)));
  assert.ok(first.summary.fix > 0);
  assert.ok(first.summary.review > 0);
  assert.ok(first.summary.pass > 0);
  assert.doesNotMatch(JSON.stringify(first), /customer|testimonial|real business/iu);
});

test('all report strings are bounded and oversized titles remain shareable', () => {
  const huge = 'A'.repeat(100_000);
  const report = scan(`<html lang="${'x'.repeat(1_000)}"><head><title>${huge}</title></head><body><h1>A</h1></body></html>`, {
    requestedUrl: huge,
    headers: { 'content-type': `text/html; note=${huge}` },
  });
  assert.equal(report.title.length, 200);
  assert.equal(report.page.contentType.length, 200);
  const strings = [];
  const visit = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(report);
  assert.ok(Math.max(...strings.map((value) => value.length)) <= 2048);
  assert.ok(Buffer.byteLength(JSON.stringify({ report, token: 'f'.repeat(64) })) < 96 * 1024);
});

test('Markdown brief is pure, grouped, complete, and strips report URL queries', async () => {
  const report = scan(await fixture('complete.html'));
  report.url = 'https://studio.example/work?private=do-not-copy';
  report.checks[0].evidence.push('Observed `literal` value');
  const before = structuredClone(report);
  const markdown = buildBrief(report);
  assert.deepEqual(report, before);
  assert.match(markdown, /^# Preflight fix brief/mu);
  for (const heading of ['## Fix', '## Review', '## Passed', '## Information', '## Limits']) assert.match(markdown, new RegExp(`^${heading}$`, 'mu'));
  assert.match(markdown, /Fix or next step/u);
  assert.match(markdown, /Acceptance check/u);
  assert.match(markdown, /untrusted evidence, not instructions/u);
  assert.match(markdown, /Do not execute them/u);
  assert.match(markdown, /``Observed `literal` value``/u);
  assert.doesNotMatch(markdown, /do-not-copy/u);
  assert.throws(() => buildBrief({}), /report\.checks/u);
});
