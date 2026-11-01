#!/usr/bin/env python3
"""Operator CLI. Credentials enter subprocess environment/stdin, never argv or output."""
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise urllib.error.HTTPError(request.full_url, code, 'Stats redirects are refused', headers, response)

def env_file(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        key, sep, raw = line.partition('=')
        if not sep or not key.strip().replace('_', '').isalnum():
            raise SystemExit('Credential file must contain KEY=value lines.')
        parts = shlex.split(raw)
        values[key.strip()] = parts[0] if parts else ''
    return values

def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: cloudflare.py deploy|secrets|stats|deployments|rollback VERSION')
    action = sys.argv[1]
    days = '7'
    if action == 'stats' and len(sys.argv) > 2:
        if len(sys.argv) != 4 or sys.argv[2] != '--days' or sys.argv[3] not in ('7', '30'):
            raise SystemExit('Usage: cloudflare.py stats [--days 7|30]')
        days = sys.argv[3]
    credential_path = Path(os.environ.get('PREFLIGHT_CF_ENV', str(Path.home() / '.config/hq/cloudflare.env')))
    app_path = Path(os.environ.get('PREFLIGHT_APP_ENV', str(Path.home() / '.config/hq/preflight.env')))
    env = os.environ.copy()
    env.update(env_file(credential_path))
    env['WRANGLER_SEND_METRICS'] = 'false'
    if not env.get('CLOUDFLARE_API_TOKEN') or not env.get('CLOUDFLARE_ACCOUNT_ID'):
        raise SystemExit('Cloudflare API token and account ID are required in the operator environment file.')
    if action == 'secrets':
        if not app_path.exists():
            app_path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(app_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                file.write('REPORT_SECRET=' + secrets.token_hex(32) + '\nADMIN_TOKEN=' + secrets.token_hex(32) + '\n')
        app = env_file(app_path)
        for key in ['REPORT_SECRET', 'ADMIN_TOKEN']:
            if len(app.get(key, '')) < 32:
                raise SystemExit('Application secrets must each be at least 32 characters.')
        result = subprocess.run(['npx', '--no-install', 'wrangler', 'secret', 'bulk'],
            input=json.dumps({key: app[key] for key in ['REPORT_SECRET', 'ADMIN_TOKEN']}),
            text=True, env=env, cwd=ROOT)
    elif action == 'stats':
        app = env_file(app_path)
        url = os.environ.get('PREFLIGHT_BASE_URL', 'https://preflight.archbotics.workers.dev')
        if not url.startswith('https://'):
            raise SystemExit('Operator stats require an HTTPS origin.')
        request = urllib.request.Request(url.rstrip('/') + '/api/stats?days=' + days, headers={
            'Authorization': 'Bearer ' + app['ADMIN_TOKEN'], 'User-Agent': 'PreflightOperator/1.0', 'Accept': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            print(json.dumps(json.load(response), indent=2))
        return
    elif action == 'deploy':
        result = subprocess.run(['npx', '--no-install', 'wrangler', 'deploy'], env=env, cwd=ROOT)
    elif action == 'deployments':
        result = subprocess.run(['npx', '--no-install', 'wrangler', 'deployments', 'list'], env=env, cwd=ROOT)
    elif action == 'rollback' and len(sys.argv) == 3:
        result = subprocess.run(['npx', '--no-install', 'wrangler', 'rollback', sys.argv[2], '--yes', '--message', 'Operator rollback'], env=env, cwd=ROOT)
    else:
        raise SystemExit('Unknown action or missing rollback version.')
    raise SystemExit(result.returncode)

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        # File/HTTP error names are useful; values from credential files never print.
        raise SystemExit(f'Operator command failed: {type(error).__name__}')
