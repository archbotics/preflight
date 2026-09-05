import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('operator stats never forward credentials through a redirect', () => {
  const code = `
import importlib.util, urllib.request, urllib.error
spec=importlib.util.spec_from_file_location('operator','scripts/cloudflare.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
request=urllib.request.Request('https://preflight.archbotics.workers.dev/api/stats',headers={'Authorization':'Bearer harmless-fixture'})
for target in ['http://other.invalid/collect','https://other.invalid/collect','https://preflight.archbotics.workers.dev/elsewhere']:
    try:
        module.NoRedirect().redirect_request(request,None,302,'redirect',{},target)
    except urllib.error.HTTPError:
        pass
    else:
        raise AssertionError('redirect must be refused')
print('redirects refused')
`;
  assert.match(execFileSync('python3', ['-c', code], {cwd: new URL('..', import.meta.url), encoding: 'utf8'}), /redirects refused/);
});
