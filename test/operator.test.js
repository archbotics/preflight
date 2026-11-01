import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';

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

test('operator report window is validated before credential loading and routed without redirects', () => {
  const source = `
import importlib.util,sys,json,io,contextlib
spec=importlib.util.spec_from_file_location('operator_cli','scripts/cloudflare.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.env_file=lambda _: (_ for _ in ()).throw(AssertionError('must validate first'))
sys.argv=['cloudflare.py','stats','--days','31']
try:
    module.main()
    raise AssertionError('invalid window accepted')
except SystemExit as error:
    assert 'Usage' in str(error)
module.env_file=lambda _: {'CLOUDFLARE_API_TOKEN':'harmless-test','CLOUDFLARE_ACCOUNT_ID':'fixture','ADMIN_TOKEN':'fixture'}
seen=[]
class Opener:
    def open(self,request,timeout):
        seen.append(request.full_url)
        class Response(io.StringIO):
            def __enter__(self): return self
            def __exit__(self,*args): pass
        return Response('{"audience":{"days":[]}}')
module.urllib.request.build_opener=lambda *_: Opener()
for days in ['7','30']:
    sys.argv=['cloudflare.py','stats','--days',days]
    with contextlib.redirect_stdout(io.StringIO()) as output: module.main()
    assert json.loads(output.getvalue()) == {'audience':{'days':[]}}
    assert seen[-1].endswith('/api/stats?days='+days)
`;
  const result = spawnSync('python3', ['-c', source], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
