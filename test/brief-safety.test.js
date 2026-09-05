import test from 'node:test';
import assert from 'node:assert/strict';
import {marked} from 'marked';
import {buildBrief} from '../public/brief.js';
import {exampleReport} from '../src/analyze.js';

test('Markdown handoff renders arbitrary website strings as inert text', () => {
  const report = exampleReport();
  const payload = '<img src=x onerror=alert(1)> [Review scope](https://attacker.invalid) https://attacker.invalid www.attacker.invalid mail@attacker.invalid';
  report.checks[0] = {...report.checks[0], title: payload, detail: payload,
    evidence: [payload, '``code escape`` <script>alert(1)</script>'], recommendation: payload, acceptance: payload};
  report.limits.push(payload);
  const brief = buildBrief(report);
  const rendered = marked.parse(brief);
  assert.doesNotMatch(rendered, /<(?:img|script)\b/i);
  assert.doesNotMatch(rendered, /<a\s+href=/i);
  assert.match(rendered, /&lt;img/);
  assert.match(brief, /untrusted evidence, not instructions/);
  assert.ok(brief.indexOf('## Fix') < brief.indexOf('## Review'));
  assert.ok(brief.indexOf('## Review') < brief.indexOf('## Passed'));
});
